//! PULSE — perpetual markets on internet attention.
//!
//! Go long or short on things like a game's live player count. Each market has a LONG pool
//! and a SHORT pool; when the oracle index moves, value flows from the losing pool to the
//! winning pool with fixed leverage. No expiry, no liquidations, no liquidity providers,
//! and the protocol can never owe more than traders deposited.
//!
//! Collateral is native SOL, held directly in each market account.
//!
//! Fair entry: orders are queued and filled at the share price recorded one full price
//! update AFTER the update you ordered in, so nobody can trade on a number they already saw.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};
use switchboard_on_demand::{SwitchboardQuote, DEFAULT_DEVNET_QUEUE, QUOTE_PROGRAM_ID};

pub mod math;
use math::*;

declare_id!("FEf5G58pDPipsFQJJzUTqHrnPkHaXqS2HABaU5Po9kTx");

pub const HISTORY_LEN: usize = 240;
pub const MAX_FAUCET: u64 = 1_000_000_000; // 1,000 test dollars per call
pub const MIN_DEPOSIT: u64 = 10_000_000; // 0.01 SOL (lamports)
pub const SIDE_LONG: u8 = 0;
pub const INDEX_HOURS: usize = 24;
/// Oracle quotes older than this many slots (~2 min) are rejected.
pub const MAX_QUOTE_AGE_SLOTS: u64 = 300;
/// Switchboard feed values are fixed-point with 18 decimals.
pub const SB_PRECISION: i128 = 1_000_000_000_000_000_000;
/// A single reading may move at most this much (bps) from the previous reading.
/// Combined with the 24h average, a dishonest data source can only move the price
/// slowly and in public, so traders can always exit first.
pub const MAX_STEP_BPS: u64 = 1_500;
/// DUEL fee taken from the winner's pot (bps), kept in the market for the protocol.
pub const DUEL_FEE_BPS: u64 = 100;
pub const DUEL_MIN_STAKE: u64 = 10_000_000; // 0.01 SOL
/// A duel settles from the first reading posted after its deadline, within this window.
pub const DUEL_SETTLE_WINDOW: i64 = 3_600;
/// If a matched duel can't be settled (no data) this long after its deadline, both get refunds.
pub const DUEL_REFUND_AFTER: i64 = 3 * 86_400;
pub const DUEL_OPEN: u8 = 0;
pub const DUEL_MATCHED: u8 = 1;
pub const DUEL_SETTLED: u8 = 2;
pub const DUEL_REFUNDED: u8 = 3;
pub const SIDE_SHORT: u8 = 1;

#[program]
pub mod pulse {
    use super::*;

    /// One-time setup: config + the test-dollar mint (devnet faucet currency).
    pub fn init_config(ctx: Context<InitConfig>, keeper: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 100, PulseError::BadParam);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.keeper = keeper;
        c.mint = ctx.accounts.mint.key();
        c.fee_bps = fee_bps;
        c.bump = ctx.bumps.config;
        c.mint_bump = ctx.bumps.mint;
        Ok(())
    }

    pub fn set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.config.keeper = keeper;
        Ok(())
    }

    /// Free test dollars so anyone can try PULSE without spending money.
    pub fn faucet(ctx: Context<Faucet>, amount: u64) -> Result<()> {
        require!(amount > 0 && amount <= MAX_FAUCET, PulseError::BadParam);
        let bump = ctx.accounts.config.bump;
        let seeds: &[&[u8]] = &[b"config", &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        id: u32,
        name: String,
        source_id: u64,
        leverage: u8,
        initial_price: u64,
    ) -> Result<()> {
        require!((1..=10).contains(&leverage), PulseError::BadParam);
        require!(initial_price > 0, PulseError::BadParam);
        require!(name.len() <= 32, PulseError::BadParam);
        let m = &mut ctx.accounts.market;
        m.id = id;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;
        m.leverage = leverage;
        m.active = true;
        let mut n = [0u8; 32];
        n[..name.len()].copy_from_slice(name.as_bytes());
        m.name = n;
        m.source_id = source_id;
        m.price = initial_price;
        m.last_update = Clock::get()?.unix_timestamp;
        m.epoch = 0;
        m.history = ctx.accounts.history.key();
        let mut h = ctx.accounts.history.load_init()?;
        h.market = m.key();
        Ok(())
    }

    pub fn set_active(ctx: Context<AdminMarket>, active: bool) -> Result<()> {
        ctx.accounts.market.active = active;
        Ok(())
    }

    /// Attach a 24h attention index to a market. `feed_id` = Switchboard feed hash
    /// (all zeros = keeper-posted data while an oracle feed is being set up).
    pub fn init_index(ctx: Context<InitIndex>, feed_id: [u8; 32]) -> Result<()> {
        let mut ix = ctx.accounts.index.load_init()?;
        ix.market = ctx.accounts.market.key();
        ix.feed_id = feed_id;
        Ok(())
    }

    pub fn set_feed(ctx: Context<SetFeed>, feed_id: [u8; 32]) -> Result<()> {
        ctx.accounts.index.load_mut()?.feed_id = feed_id;
        Ok(())
    }

    /// Post the latest attention reading and move the pools.
    ///
    /// * Oracle mode (index has a feed): the reading comes from a Switchboard quote that
    ///   oracles signed and the Switchboard quote program verified. ANYONE can crank it,
    ///   nobody (including the admin) can choose the number.
    /// * Keeper mode (no feed yet): only the configured keeper can post `price`.
    ///
    /// The traded price is the 24-hour rolling average of readings, computed here on-chain,
    /// so predictable daily peaks and dips cancel out and only real trends move the market.
    pub fn push_price(ctx: Context<PushPrice>, price: u64) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let mut ix = ctx.accounts.index.load_mut()?;
        require_keys_eq!(ix.market, ctx.accounts.market.key(), PulseError::BadParam);

        let raw = if ix.feed_id != [0u8; 32] {
            read_oracle(&ctx.accounts.quote, &ix.feed_id, clock.slot)?
        } else {
            require_keys_eq!(ctx.accounts.cranker.key(), ctx.accounts.config.keeper, PulseError::NotKeeper);
            price
        };
        require!(raw > 0, PulseError::BadParam);
        let raw = clamp_step(ix.last_raw, raw, MAX_STEP_BPS);
        let index_price = ix.record(raw, now);
        drop(ix);
        apply_price(&mut ctx.accounts.market, &ctx.accounts.history, index_price, now)
    }

    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        let p = &mut ctx.accounts.position;
        p.owner = ctx.accounts.owner.key();
        p.market = ctx.accounts.market.key();
        p.bump = ctx.bumps.position;
        Ok(())
    }

    /// Queue a deposit into LONG (0) or SHORT (1). Filled after the next-next price update.
    pub fn deposit(ctx: Context<Deposit>, side: u8, amount: u64) -> Result<()> {
        require!(side <= 1, PulseError::BadParam);
        require!(amount >= MIN_DEPOSIT, PulseError::TooSmall);
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(m.active, PulseError::Inactive);
        require!(!p.pending, PulseError::Pending);

        // collateral is native SOL, held directly in the market account
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: m.to_account_info(),
                },
            ),
            amount,
        )?;
        let fee = amount * ctx.accounts.config.fee_bps as u64 / 10_000;
        let net = amount - fee;
        m.fees += fee;
        let b = (m.epoch % 2) as usize;
        if side == SIDE_LONG {
            m.pend_long_dep[b] += net;
            p.dep_long = net;
        } else {
            m.pend_short_dep[b] += net;
            p.dep_short = net;
        }
        p.pending = true;
        p.pending_epoch = m.epoch;
        Ok(())
    }

    /// Queue a withdrawal of `shares` from a side. Paid out after the next-next price update.
    pub fn withdraw(ctx: Context<Withdraw>, side: u8, shares: u128) -> Result<()> {
        require!(side <= 1, PulseError::BadParam);
        require!(shares > 0, PulseError::BadParam);
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(!p.pending, PulseError::Pending);
        let b = (m.epoch % 2) as usize;
        if side == SIDE_LONG {
            require!(p.long_shares >= shares, PulseError::NotEnough);
            p.long_shares -= shares;
            p.wd_long = shares;
            m.pend_long_wd[b] += shares;
        } else {
            require!(p.short_shares >= shares, PulseError::NotEnough);
            p.short_shares -= shares;
            p.wd_short = shares;
            m.pend_short_wd[b] += shares;
        }
        p.pending = true;
        p.pending_epoch = m.epoch;
        Ok(())
    }

    /// Finish a filled order: credit shares and/or send dollars to the owner.
    /// Permissionless, so the keeper can settle for users automatically.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(p.pending, PulseError::NothingToSettle);
        let fill_epoch = p.pending_epoch + 1;
        require!(m.epoch > fill_epoch, PulseError::NotFilledYet);
        let h = ctx.accounts.history.load()?;
        let i = (fill_epoch as usize) % HISTORY_LEN;
        require!(h.epochs[i] == fill_epoch + 1, PulseError::Expired);
        let (lsp, ssp) = (h.long_sp[i], h.short_sp[i]);
        drop(h);

        p.long_shares += user_shares_for(p.dep_long, lsp);
        p.short_shares += user_shares_for(p.dep_short, ssp);
        let usd = user_usd_for(p.wd_long, lsp) + user_usd_for(p.wd_short, ssp);
        p.dep_long = 0;
        p.dep_short = 0;
        p.wd_long = 0;
        p.wd_short = 0;
        p.pending = false;

        if usd > 0 {
            let pay = usd.min(m.reserved_payouts);
            m.reserved_payouts -= pay;
            m.sub_lamports(pay)?;
            ctx.accounts.owner.add_lamports(pay)?;
        }
        Ok(())
    }

    // ------------------------------------------------------------ DUEL mode
    /// Challenge anyone: "the reading will be ABOVE/BELOW `target` at `deadline`".
    /// Your stake is locked in the duel account until someone accepts or you cancel.
    pub fn create_duel(ctx: Context<CreateDuel>, nonce: u64, above: bool, target: u64, deadline: i64, stake: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(stake >= DUEL_MIN_STAKE, PulseError::TooSmall);
        require!(target > 0, PulseError::BadParam);
        require!(deadline >= now + 600 && deadline <= now + 30 * 86_400, PulseError::BadDeadline);
        require!(ctx.accounts.market.active, PulseError::Inactive);
        let d = &mut ctx.accounts.duel;
        d.market = ctx.accounts.market.key();
        d.creator = ctx.accounts.creator.key();
        d.nonce = nonce;
        d.stake = stake;
        d.target = target;
        d.deadline = deadline;
        d.created = now;
        d.above = above;
        d.state = DUEL_OPEN;
        d.bump = ctx.bumps.duel;
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.creator.to_account_info(), to: d.to_account_info() }),
            stake,
        )
    }

    /// Take the other side by matching the stake. Closes 10 minutes before the deadline.
    pub fn accept_duel(ctx: Context<AcceptDuel>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &mut ctx.accounts.duel;
        require!(d.state == DUEL_OPEN, PulseError::DuelNotOpen);
        require!(now <= d.deadline - 600, PulseError::BadDeadline);
        require_keys_neq!(ctx.accounts.opponent.key(), d.creator, PulseError::BadParam);
        d.opponent = ctx.accounts.opponent.key();
        d.state = DUEL_MATCHED;
        let stake = d.stake;
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.opponent.to_account_info(), to: d.to_account_info() }),
            stake,
        )
    }

    /// Creator takes back an unaccepted challenge.
    pub fn cancel_duel(ctx: Context<CancelDuel>) -> Result<()> {
        let d = &mut ctx.accounts.duel;
        require!(d.state == DUEL_OPEN, PulseError::DuelNotOpen);
        d.state = DUEL_REFUNDED;
        let stake = d.stake;
        d.sub_lamports(stake)?;
        ctx.accounts.creator.add_lamports(stake)?;
        Ok(())
    }

    /// Permissionless: after the deadline, pays the winner from the first audited reading
    /// posted after the deadline. Unaccepted duels refund the creator; ties and stuck duels refund both.
    pub fn settle_duel(ctx: Context<SettleDuel>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &mut ctx.accounts.duel;
        require!(now >= d.deadline, PulseError::TooEarly);
        require!(d.state == DUEL_OPEN || d.state == DUEL_MATCHED, PulseError::DuelNotOpen);
        require_keys_eq!(ctx.accounts.creator.key(), d.creator, PulseError::BadParam);
        let stake = d.stake;
        if d.state == DUEL_OPEN {
            d.state = DUEL_REFUNDED;
            d.sub_lamports(stake)?;
            ctx.accounts.creator.add_lamports(stake)?;
            return Ok(());
        }
        require_keys_eq!(ctx.accounts.opponent.key(), d.opponent, PulseError::BadParam);
        let ix = ctx.accounts.index.load()?;
        let fresh = ix.last_time >= d.deadline && ix.last_time <= d.deadline + DUEL_SETTLE_WINDOW;
        if !fresh {
            // no usable reading: wait, unless it's been stuck too long → refund both
            require!(now > d.deadline + DUEL_REFUND_AFTER, PulseError::NotFilledYet);
            drop(ix);
            d.state = DUEL_REFUNDED;
            d.sub_lamports(stake * 2)?;
            ctx.accounts.creator.add_lamports(stake)?;
            ctx.accounts.opponent.add_lamports(stake)?;
            return Ok(());
        }
        let value = ix.last_raw;
        drop(ix);
        d.settled_value = value;
        d.state = DUEL_SETTLED;
        match duel_outcome(d.above, d.target, value) {
            DuelResult::Tie => {
                d.sub_lamports(stake * 2)?;
                ctx.accounts.creator.add_lamports(stake)?;
                ctx.accounts.opponent.add_lamports(stake)?;
            }
            r => {
                let pot = stake * 2;
                let fee = pot * DUEL_FEE_BPS / 10_000;
                d.winner = if r == DuelResult::Creator { d.creator } else { d.opponent };
                d.sub_lamports(pot)?;
                ctx.accounts.market.add_lamports(fee)?;
                ctx.accounts.market.fees += fee;
                if r == DuelResult::Creator { ctx.accounts.creator.add_lamports(pot - fee)?; } else { ctx.accounts.opponent.add_lamports(pot - fee)?; }
            }
        }
        Ok(())
    }

    pub fn collect_fees(ctx: Context<CollectFees>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        let amt = m.fees;
        m.fees = 0;
        m.sub_lamports(amt)?;
        ctx.accounts.admin.add_lamports(amt)?;
        Ok(())
    }
}

// ---------------------------------------------------------------- price logic

/// Read a verified Switchboard reading for `feed_id`.
fn read_oracle(quote: &UncheckedAccount, feed_id: &[u8; 32], slot: u64) -> Result<u64> {
    // must be the canonical quote account for this feed on the official devnet queue,
    // owned (and therefore written only) by the Switchboard quote program
    require_keys_eq!(*quote.owner, QUOTE_PROGRAM_ID, PulseError::BadOracle);
    let (expected, _) = Pubkey::find_program_address(&[DEFAULT_DEVNET_QUEUE.as_ref(), feed_id.as_ref()], &QUOTE_PROGRAM_ID);
    require_keys_eq!(quote.key(), expected, PulseError::BadOracle);
    let data = quote.try_borrow_data()?;
    let q = <SwitchboardQuote as AccountDeserialize>::try_deserialize(&mut &data[..])?;
    require_keys_eq!(q.queue, DEFAULT_DEVNET_QUEUE, PulseError::BadOracle);
    require!(slot.saturating_sub(q.slot) <= MAX_QUOTE_AGE_SLOTS, PulseError::StaleOracle);
    let feed = q.feeds_slice().iter().find(|f| f.feed_id() == feed_id).ok_or(PulseError::BadOracle)?;
    let v = feed.feed_value();
    require!(v > 0, PulseError::BadOracle);
    Ok((v / SB_PRECISION) as u64)
}

/// Move value between pools at `price`, fill queued orders, record history.
fn apply_price<'info>(m: &mut Account<'info, Market>, history: &AccountLoader<'info, History>, price: u64, now: i64) -> Result<()> {
    require!(m.active, PulseError::Inactive);
    let (lb, sb) = rebalance(m.long_balance, m.short_balance, m.long_shares > 0, m.short_shares > 0, m.price, price, m.leverage);
    m.long_balance = lb;
    m.short_balance = sb;

    let e = m.epoch;
    let b = ((e + 1) % 2) as usize;
    let lsp = share_price(m.long_balance, m.long_shares);
    let ssp = share_price(m.short_balance, m.short_shares);
    let (nb, ns, lout) = execute(m.long_balance, m.long_shares, m.pend_long_wd[b], m.pend_long_dep[b], lsp);
    m.long_balance = nb;
    m.long_shares = ns;
    let (nb, ns, sout) = execute(m.short_balance, m.short_shares, m.pend_short_wd[b], m.pend_short_dep[b], ssp);
    m.short_balance = nb;
    m.short_shares = ns;
    m.reserved_payouts = m.reserved_payouts.checked_add(lout + sout).ok_or(PulseError::Math)?;
    m.pend_long_wd[b] = 0;
    m.pend_long_dep[b] = 0;
    m.pend_short_wd[b] = 0;
    m.pend_short_dep[b] = 0;

    let mut h = history.load_mut()?;
    let i = (e as usize) % HISTORY_LEN;
    h.epochs[i] = e + 1;
    h.prices[i] = price;
    h.long_sp[i] = lsp;
    h.short_sp[i] = ssp;
    h.times[i] = now;

    m.price = price;
    m.epoch = e + 1;
    m.last_update = now;
    emit!(PricePushed { market: m.key(), epoch: e, price, long_balance: m.long_balance, short_balance: m.short_balance });
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
    pub mint_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub id: u32,
    pub bump: u8,
    pub vault_bump: u8,
    pub leverage: u8,
    pub active: bool,
    pub name: [u8; 32],
    pub source_id: u64,
    pub price: u64,
    pub last_update: i64,
    pub epoch: u64,
    pub history: Pubkey,
    pub long_balance: u64,
    pub short_balance: u64,
    pub long_shares: u128,
    pub short_shares: u128,
    pub pend_long_dep: [u64; 2],
    pub pend_short_dep: [u64; 2],
    pub pend_long_wd: [u128; 2],
    pub pend_short_wd: [u128; 2],
    pub reserved_payouts: u64,
    pub fees: u64,
}

#[account(zero_copy)]
#[repr(C)]
pub struct History {
    pub market: Pubkey,
    pub epochs: [u64; HISTORY_LEN],
    pub prices: [u64; HISTORY_LEN],
    pub long_sp: [u64; HISTORY_LEN],
    pub short_sp: [u64; HISTORY_LEN],
    pub times: [i64; HISTORY_LEN],
}

/// 24-hour rolling attention index, one per market.
#[account(zero_copy)]
#[repr(C)]
pub struct Index {
    pub market: Pubkey,
    pub feed_id: [u8; 32],
    pub last_raw: u64,
    pub last_time: i64,
    pub cur_hour: i64,
    pub cur_sum: u64,
    pub cur_n: u64,
    pub hours: [i64; INDEX_HOURS],
    pub avgs: [u64; INDEX_HOURS],
}

impl Index {
    /// Add a reading; returns the 24h rolling average (the traded price).
    pub fn record(&mut self, raw: u64, now: i64) -> u64 {
        let hour = now / 3600;
        if hour != self.cur_hour {
            if self.cur_n > 0 {
                let slot = (self.cur_hour.rem_euclid(INDEX_HOURS as i64)) as usize;
                self.hours[slot] = self.cur_hour;
                self.avgs[slot] = self.cur_sum / self.cur_n;
            }
            self.cur_hour = hour;
            self.cur_sum = 0;
            self.cur_n = 0;
        }
        self.cur_sum = self.cur_sum.saturating_add(raw);
        self.cur_n += 1;
        self.last_raw = raw;
        self.last_time = now;
        rolling_average(&self.hours, &self.avgs, hour, self.cur_sum / self.cur_n)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub bump: u8,
    pub long_shares: u128,
    pub short_shares: u128,
    pub pending: bool,
    pub pending_epoch: u64,
    pub dep_long: u64,
    pub dep_short: u64,
    pub wd_long: u128,
    pub wd_short: u128,
}

// ---------------------------------------------------------------- contexts

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, seeds = [b"mint"], bump, mint::decimals = 6, mint::authority = config)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub user_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(address = config.mint)]
    pub mint: Account<'info, Mint>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [b"market", id.to_le_bytes().as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = admin, space = 8 + std::mem::size_of::<History>(), seeds = [b"history", market.key().as_ref()], bump)]
    pub history: AccountLoader<'info, History>,
    #[account(init, payer = admin, seeds = [b"vault", market.key().as_ref()], bump, token::mint = mint, token::authority = market)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct PushPrice<'info> {
    /// Anyone in oracle mode; the keeper in keeper mode.
    pub cranker: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = history)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub history: AccountLoader<'info, History>,
    #[account(mut, seeds = [b"index", market.key().as_ref()], bump)]
    pub index: AccountLoader<'info, Index>,
    /// CHECK: Switchboard quote account, fully validated in `read_oracle` (any account in keeper mode)
    pub quote: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitIndex<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub market: Account<'info, Market>,
    #[account(init, payer = admin, space = 8 + std::mem::size_of::<Index>(), seeds = [b"index", market.key().as_ref()], bump)]
    pub index: AccountLoader<'info, Index>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetFeed<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"index", market.key().as_ref()], bump)]
    pub index: AccountLoader<'info, Index>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(init, payer = owner, space = 8 + Position::INIT_SPACE, seeds = [b"position", market.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"position", market.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner, has_one = market)]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"position", market.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner, has_one = market)]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = history)]
    pub market: Account<'info, Market>,
    pub history: AccountLoader<'info, History>,
    #[account(mut, seeds = [b"position", market.key().as_ref(), position.owner.as_ref()], bump = position.bump, has_one = market)]
    pub position: Account<'info, Position>,
    /// CHECK: receives SOL payouts; must be the position owner
    #[account(mut, address = position.owner)]
    pub owner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

// ---------------------------------------------------------------- events / errors

// ---------------------------------------------------------------- DUEL accounts

#[account]
#[derive(InitSpace)]
pub struct Duel {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub opponent: Pubkey,
    pub winner: Pubkey,
    pub nonce: u64,
    pub stake: u64,
    pub target: u64,
    pub settled_value: u64,
    pub deadline: i64,
    pub created: i64,
    pub above: bool,
    pub state: u8,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateDuel<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(init, payer = creator, space = 8 + Duel::INIT_SPACE,
        seeds = [b"duel", market.key().as_ref(), creator.key().as_ref(), nonce.to_le_bytes().as_ref()], bump)]
    pub duel: Account<'info, Duel>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptDuel<'info> {
    #[account(mut)]
    pub opponent: Signer<'info>,
    #[account(mut)]
    pub duel: Account<'info, Duel>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelDuel<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator)]
    pub duel: Account<'info, Duel>,
}

#[derive(Accounts)]
pub struct SettleDuel<'info> {
    #[account(mut, has_one = market)]
    pub duel: Account<'info, Duel>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(seeds = [b"index", market.key().as_ref()], bump)]
    pub index: AccountLoader<'info, Index>,
    /// CHECK: must equal duel.creator (checked in the handler)
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,
    /// CHECK: must equal duel.opponent when matched (checked in the handler); any account otherwise
    #[account(mut)]
    pub opponent: UncheckedAccount<'info>,
}

#[event]
pub struct PricePushed {
    pub market: Pubkey,
    pub epoch: u64,
    pub price: u64,
    pub long_balance: u64,
    pub short_balance: u64,
}

#[error_code]
pub enum PulseError {
    #[msg("Bad parameter")]
    BadParam,
    #[msg("Market is paused")]
    Inactive,
    #[msg("You already have an order waiting to fill")]
    Pending,
    #[msg("Minimum deposit is 0.01 SOL")]
    TooSmall,
    #[msg("Not enough shares")]
    NotEnough,
    #[msg("Nothing to settle")]
    NothingToSettle,
    #[msg("Order not filled yet")]
    NotFilledYet,
    #[msg("Fill record expired")]
    Expired,
    #[msg("Math overflow")]
    Math,
    #[msg("Only the keeper can post data for this market")]
    NotKeeper,
    #[msg("Oracle quote is not the verified Switchboard feed for this market")]
    BadOracle,
    #[msg("Oracle quote is too old")]
    StaleOracle,
    #[msg("Deadline must be 10 minutes to 30 days away, and duels close 10 minutes before it")]
    BadDeadline,
    #[msg("This duel is not open")]
    DuelNotOpen,
    #[msg("Too early")]
    TooEarly,
}

#[cfg(test)]
mod layout_dump {
    //! Dumps real Anchor serialization so the JS SDK can be checked against it.
    use super::*;
    use anchor_lang::{AccountSerialize, InstructionData};

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn dump() {
        let k = |n: u8| Pubkey::new_from_array([n; 32]);
        let m = Market {
            id: 7, bump: 250, vault_bump: 249, leverage: 3, active: true,
            name: { let mut n = [0u8; 32]; n[..4].copy_from_slice(b"CS 2"); n },
            source_id: 730, price: 1_234_567, last_update: -5, epoch: 42, history: k(9),
            long_balance: 111, short_balance: 222, long_shares: (1u128 << 70) + 3, short_shares: 444,
            pend_long_dep: [5, 6], pend_short_dep: [7, 8], pend_long_wd: [9, 10], pend_short_wd: [11, 12],
            reserved_payouts: 13, fees: 14,
        };
        let mut mb = vec![];
        m.try_serialize(&mut mb).unwrap();
        let p = Position {
            owner: k(1), market: k(2), bump: 254, long_shares: 1u128 << 80, short_shares: 99, pending: true,
            pending_epoch: 41, dep_long: 1000, dep_short: 2000, wd_long: 3000, wd_short: (1u128 << 65) + 1,
        };
        let mut pb = vec![];
        p.try_serialize(&mut pb).unwrap();
        let cm = instruction::CreateMarket { id: 7, name: "CS 2".into(), source_id: 730, leverage: 3, initial_price: 1_234_567 }.data();
        let wd = instruction::Withdraw { side: 1, shares: (1u128 << 65) + 1 }.data();
        let ic = instruction::InitConfig { keeper: k(3), fee_bps: 30 }.data();
        let out = format!(
            "{{\"market\":\"{}\",\"position\":\"{}\",\"create_market\":\"{}\",\"withdraw\":\"{}\",\"init_config\":\"{}\",\"history_size\":{}}}",
            hex(&mb), hex(&pb), hex(&cm), hex(&wd), hex(&ic), 8 + std::mem::size_of::<History>()
        );
        std::fs::write("/tmp/pulse_layout.json", out).unwrap();
    }
}

#[cfg(test)]
mod duel_layout_dump {
    use super::*;
    use anchor_lang::{AccountSerialize, InstructionData};
    #[test]
    fn dump_duel() {
        let k = |n: u8| Pubkey::new_from_array([n; 32]);
        let d = Duel { market: k(1), creator: k(2), opponent: k(3), winner: k(4), nonce: 5, stake: 6, target: 7, settled_value: 8, deadline: -9, created: 10, above: true, state: 2, bump: 254 };
        let mut b = vec![]; d.try_serialize(&mut b).unwrap();
        let cd = instruction::CreateDuel { nonce: 77, above: true, target: 600_000, deadline: 1_800_000_000, stake: 10_000_000 }.data();
        let hex = |v: &[u8]| v.iter().map(|x| format!("{x:02x}")).collect::<String>();
        std::fs::write("/tmp/duel_layout.json", format!(r#"{{"duel":"{}","create":"{}"}}"#, hex(&b), hex(&cd))).unwrap();
    }
}
