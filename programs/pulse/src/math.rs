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

#[cfg(test)]
mod tests {
    use super::*;

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
