//! Pure pool math for PULSE. No Solana types here so it can be unit-tested anywhere.
//!
//! Model: every market has a LONG pool and a SHORT pool. When the oracle index moves,
//! value flows from the losing pool to the winning pool. Traders only ever win what the
//! other side put in, so the protocol can never owe more than it holds (no LPs, no house money).

/// Fixed-point scale for share prices and ratios.
pub const SCALE: u128 = 1_000_000_000;

/// Fraction (scaled by SCALE) of the losing pool that moves to the winning pool
/// for a price move from `p0` to `p1` at `leverage`.
///
/// Uses x / (1 + x) where x = leverage * |move|, so small moves are ~linear
/// (3x leverage, +1% move => ~3% of the losing pool) and huge moves saturate below 100%:
/// a pool is never fully wiped, so share prices always stay defined.
pub fn transfer_fraction(p0: u64, p1: u64, leverage: u8) -> u128 {
    if p0 == 0 || p0 == p1 {
        return 0;
    }
    let diff = (p1 as i128 - p0 as i128).unsigned_abs();
    let x = (leverage as u128) * diff * SCALE / (p0 as u128);
    x * SCALE / (SCALE + x)
}

/// Apply a price move to the two pools. Returns new (long_balance, short_balance).
/// If the winning side has nobody in it, nothing moves.
pub fn rebalance(
    long_balance: u64,
    short_balance: u64,
    long_has_holders: bool,
    short_has_holders: bool,
    p0: u64,
    p1: u64,
    leverage: u8,
) -> (u64, u64) {
    let frac = transfer_fraction(p0, p1, leverage);
    if frac == 0 {
        return (long_balance, short_balance);
    }
    if p1 > p0 {
        if !long_has_holders {
            return (long_balance, short_balance);
        }
        let t = (short_balance as u128 * frac / SCALE) as u64;
        (long_balance + t, short_balance - t)
    } else {
        if !short_has_holders {
            return (long_balance, short_balance);
        }
        let t = (long_balance as u128 * frac / SCALE) as u64;
        (long_balance - t, short_balance + t)
    }
}

/// Value of one share (scaled by SCALE) in token base units.
pub fn share_price(balance: u64, shares: u128) -> u64 {
    if shares == 0 {
        return SCALE as u64;
    }
    let sp = balance as u128 * SCALE / shares;
    sp.clamp(1, u64::MAX as u128) as u64
}

/// Execute one side's queued withdrawals then deposits at share price `sp`.
/// Returns (new_balance, new_shares, usd_paid_out).
pub fn execute(balance: u64, shares: u128, wd_shares: u128, deposit: u64, sp: u64) -> (u64, u128, u64) {
    let owed = wd_shares * sp as u128 / SCALE;
    let usd_out = (owed.min(balance as u128)) as u64;
    let mut bal = balance - usd_out;
    let mut sh = shares.saturating_sub(wd_shares);
    let minted = deposit as u128 * SCALE / sp as u128;
    bal += deposit;
    sh += minted;
    (bal, sh, usd_out)
}

/// What one user gets when their queued order is settled at the recorded share price.
pub fn user_shares_for(deposit: u64, sp: u64) -> u128 {
    deposit as u128 * SCALE / sp as u128
}

pub fn user_usd_for(shares: u128, sp: u64) -> u64 {
    (shares * sp as u128 / SCALE) as u64
}

/// 24h rolling average: mean of the finalized hourly averages from the last 23 hours
/// plus the current (partial) hour. Covering a full day cancels out the daily cycle.
pub fn rolling_average(hours: &[i64], avgs: &[u64], now_hour: i64, current_avg: u64) -> u64 {
    let mut sum = current_avg as u128;
    let mut n = 1u128;
    for (h, a) in hours.iter().zip(avgs) {
        if *a > 0 && *h < now_hour && now_hour - *h < 24 {
            sum += *a as u128;
            n += 1;
        }
    }
    (sum / n) as u64
}

/// Limit how far one reading can move from the last one (manipulation brake).
pub fn clamp_step(last: u64, raw: u64, max_bps: u64) -> u64 {
    if last == 0 {
        return raw;
    }
    let hi = (last as u128 * (10_000 + max_bps) as u128 / 10_000) as u64;
    let lo = (last as u128 * (10_000 - max_bps) as u128 / 10_000) as u64;
    raw.clamp(lo.max(1), hi)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuelResult { Creator, Opponent, Tie }

/// Creator called ABOVE (`above = true`) or BELOW `target`; `value` is the settling reading.
pub fn duel_outcome(above: bool, target: u64, value: u64) -> DuelResult {
    if value == target { return DuelResult::Tie; }
    if (value > target) == above { DuelResult::Creator } else { DuelResult::Opponent }
}

/// PREDICT: does YES win? "ABOVE target" needs value > target; "BELOW target" needs value < target.
pub fn pred_yes_wins(above: bool, target: u64, value: u64) -> bool {
    if above { value > target } else { value < target }
}

/// PREDICT: a winning slip's share of the pot after fee: stake / winning_pool × payout_pool.
pub fn pred_payout(stake: u64, win_pool: u64, payout_pool: u64) -> Result<u64, anchor_lang::error::Error> {
    if win_pool == 0 { return Ok(0); }
    u64::try_from((stake as u128) * (payout_pool as u128) / (win_pool as u128))
        .map_err(|_| anchor_lang::error!(crate::PulseError::Math))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prediction_math() {
        assert!(pred_yes_wins(true, 700_000, 700_001));
        assert!(!pred_yes_wins(true, 700_000, 700_000));
        assert!(pred_yes_wins(false, 50, 49));
        assert!(!pred_yes_wins(false, 50, 50));
        // 3 SOL on YES (you have 1), 1 SOL on NO, YES wins: pot 4, 1% fee → 3.96; your third = 1.32
        let payout = 3_960_000_000u64;
        assert_eq!(pred_payout(1_000_000_000, 3_000_000_000, payout).unwrap(), 1_320_000_000);
        // all winning slips together never take more than the payout pool
        let a = pred_payout(1_000_000_001, 3_000_000_000, payout).unwrap();
        let b = pred_payout(1_999_999_999, 3_000_000_000, payout).unwrap();
        assert!(a + b <= payout);
    }

    #[test]
    fn duel_outcomes() {
        assert_eq!(duel_outcome(true, 600_000, 612_000), DuelResult::Creator);
        assert_eq!(duel_outcome(true, 600_000, 590_000), DuelResult::Opponent);
        assert_eq!(duel_outcome(false, 600_000, 590_000), DuelResult::Creator);
        assert_eq!(duel_outcome(false, 600_000, 612_000), DuelResult::Opponent);
        assert_eq!(duel_outcome(true, 600_000, 600_000), DuelResult::Tie);
    }

    #[test]
    fn clamp_step_limits_jumps() {
        assert_eq!(clamp_step(0, 5_000, 1_500), 5_000);
        assert_eq!(clamp_step(100_000, 1_000_000, 1_500), 115_000);
        assert_eq!(clamp_step(100_000, 1, 1_500), 85_000);
        assert_eq!(clamp_step(100_000, 104_000, 1_500), 104_000);
    }

    #[test]
    fn one_fake_reading_barely_moves_the_index() {
        // steady 100k for 23 full hours, then a dishonest +15% reading in a 60-sample hour
        let now_hour = 1_000i64;
        let mut hours = [0i64; 24];
        let mut avgs = [0u64; 24];
        for k in 1..24 { let h = now_hour - k; hours[(h.rem_euclid(24)) as usize] = h; avgs[(h.rem_euclid(24)) as usize] = 100_000; }
        let cur = (59 * 100_000 + 115_000) / 60;
        let idx = rolling_average(&hours, &avgs, now_hour, cur);
        assert!(idx <= 100_011, "index moved to {idx}"); // ~0.01%
    }

    #[test]
    fn rolling_average_cancels_daily_cycle() {
        // a game that swings 100k..300k every day (pure cycle, no trend)
        let mut hours = [0i64; 24];
        let mut avgs = [0u64; 24];
        let day = |h: i64| (200_000.0 + 100_000.0 * ((h as f64) * std::f64::consts::PI / 12.0).sin()) as u64;
        let start = 500_000i64;
        let mut seen = vec![];
        for h in start..start + 72 {
            let i = (h.rem_euclid(24)) as usize;
            let idx = rolling_average(&hours, &avgs, h, day(h));
            if h >= start + 24 { seen.push(idx); }
            hours[i] = h;
            avgs[i] = day(h);
        }
        let (mn, mx) = (*seen.iter().min().unwrap(), *seen.iter().max().unwrap());
        // raw swings +-50%; the index stays within ~1% of 200k
        assert!(mn > 197_000 && mx < 203_000, "{mn}..{mx}");
    }

    #[test]
    fn rolling_average_follows_real_trend() {
        let hours = [0i64; 24];
        let avgs = [0u64; 24];
        // no history yet: index = current reading
        assert_eq!(rolling_average(&hours, &avgs, 10, 5_000), 5_000);
    }

    const USD: u64 = 1_000_000;

    #[test]
    fn small_move_is_about_leverage_times_move() {
        // 3x leverage, +1% => ~2.9% of losing pool moves
        let f = transfer_fraction(100_000, 101_000, 3);
        assert!(f > 28_000_000 && f < 30_000_000, "{f}");
    }

    #[test]
    fn pools_are_never_wiped_and_value_is_conserved() {
        let (mut l, mut s) = (500 * USD, 500 * USD);
        let total = l + s;
        let mut p = 1_000_000u64;
        // brutal sequence: 10x up, 99% down, etc.
        for next in [10_000_000u64, 100_000, 5_000_000, 1, 900_000, 900_001] {
            let (nl, ns) = rebalance(l, s, true, true, p, next, 10);
            l = nl;
            s = ns;
            p = next;
            assert_eq!(l + s, total, "value must be conserved");
            assert!(l > 0 && s > 0, "no pool may hit zero");
        }
    }

    #[test]
    fn no_transfer_when_winners_empty() {
        assert_eq!(rebalance(0, 100, false, true, 100, 200, 3), (0, 100));
        assert_eq!(rebalance(100, 0, true, false, 200, 100, 3), (100, 0));
    }

    #[test]
    fn long_wins_on_up_move() {
        let (l, s) = rebalance(100 * USD, 100 * USD, true, true, 1000, 1100, 3);
        // x = 0.3 => frac = 0.3/1.3 = 23.07%
        assert_eq!(l, 100 * USD + 23_076_923);
        assert_eq!(s, 100 * USD - 23_076_923);
    }

    #[test]
    fn execute_and_user_settle_are_consistent() {
        // pool with 100 USD / 100 shares-units, sp = 1.0
        let (bal, sh) = (100 * USD, 100 * USD as u128);
        let sp = share_price(bal, sh);
        assert_eq!(sp, SCALE as u64);
        // three users deposit odd amounts, one withdraws 33.333333 shares
        let deps = [1_234_567u64, 7_654_321, 3];
        let wd = [33_333_333u128];
        let (nb, nsh, out) = execute(bal, sh, wd.iter().sum(), deps.iter().sum(), sp);
        let user_out: u64 = wd.iter().map(|w| user_usd_for(*w, sp)).sum();
        let user_minted: u128 = deps.iter().map(|d| user_shares_for(*d, sp)).sum();
        assert!(user_out <= out, "users can never claim more than reserved");
        assert!(user_minted <= nsh - (sh - wd[0]));
        assert_eq!(nb, bal - out + deps.iter().sum::<u64>());
    }

    #[test]
    fn share_price_tracks_pnl() {
        // 100 USD long pool, long wins 23.07 USD
        let sh = 100 * USD as u128;
        let sp = share_price(123_076_923, sh);
        assert_eq!(user_usd_for(sh, sp), 123_076_923);
    }

    #[test]
    fn full_round_trip_is_solvent() {
        // Alice longs 100, Bob shorts 100, price +10% then -5%, both exit.
        let mut lb = 0u64;
        let mut ls = 0u128;
        let mut sb = 0u64;
        let mut ss = 0u128;
        let sp = share_price(lb, ls);
        let (a, b, _) = execute(lb, ls, 0, 100 * USD, sp);
        lb = a;
        ls = b;
        let (a, b, _) = execute(sb, ss, 0, 100 * USD, share_price(sb, ss));
        sb = a;
        ss = b;
        let alice = ls;
        let bob = ss;
        let (a, b) = rebalance(lb, sb, true, true, 1000, 1100, 3);
        lb = a;
        sb = b;
        let (a, b) = rebalance(lb, sb, true, true, 1100, 1045, 3);
        lb = a;
        sb = b;
        let (_, _, alice_out) = execute(lb, ls, alice, 0, share_price(lb, ls));
        let (_, _, bob_out) = execute(sb, ss, bob, 0, share_price(sb, ss));
        assert!(alice_out + bob_out <= 200 * USD);
        assert!(alice_out > 100 * USD, "alice net long winner: {alice_out}");
    }
}
