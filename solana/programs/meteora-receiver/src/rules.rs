//! The decision rules, extracted so they can be tested without a validator.
//!
//! Everything here is pure. The instruction handlers in `lib.rs` are thin
//! wrappers that load accounts and call into these, which means the properties
//! that matter — above all "stage 1 cannot fail" — can be proven by exhaustive
//! and property testing rather than by a handful of integration cases.

use anchor_lang::prelude::Pubkey;

/// Stage 1's entire computation.
///
/// # Total by construction
///
/// This returns a value, never an error, for every possible input. That is
/// the §10.1 requirement expressed in a type: there is no `Result`, so there
/// is no failure to handle, so an already-burned CCTP transfer cannot be
/// stranded by this path.
///
/// The spec's own sketch used `checked_add(..).unwrap()`, which panics on
/// overflow. `saturating_add` clamps instead. At 6 decimals a `u64` saturates
/// past 18 trillion USDC, so the clamp is unreachable with real money; if it
/// were reached, clamping costs bookkeeping precision while a panic would cost
/// the funds.
#[inline]
pub fn credit_after_receive(current: u64, incoming: u64) -> u64 {
    current.saturating_add(incoming)
}

/// Undeployed balance.
#[inline]
pub fn available(amount: u64, deployed: u64) -> u64 {
    amount.saturating_sub(deployed)
}

/// Why a stage-2 deploy was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeployRejection {
    ZeroAmount,
    NothingToDeploy,
    AmountExceedsCredit,
    ActiveBinOutsideTolerance,
    UnboundedSlippage,
    ImpossibleSlippageBound,
}

/// Stage 2's validation, in full.
///
/// Unlike stage 1 this is allowed — expected — to reject. A rejection costs a
/// transaction fee; the credited funds are untouched and the caller can retry
/// with fresher parameters.
pub fn check_deploy(
    amount: u64,
    credited: u64,
    deployed: u64,
    target_bin_id: i32,
    active_bin_id: i32,
    bin_tolerance: u16,
    min_amount_out: u64,
) -> Result<(), DeployRejection> {
    if amount == 0 {
        return Err(DeployRejection::ZeroAmount);
    }
    let avail = available(credited, deployed);
    if avail == 0 {
        return Err(DeployRejection::NothingToDeploy);
    }
    if amount > avail {
        return Err(DeployRejection::AmountExceedsCredit);
    }

    // Widened to i64 before subtracting: `active - target` on two i32 extremes
    // overflows i32, and an overflow here would be a panic in a release build
    // with `overflow-checks = true`.
    let drift = (active_bin_id as i64 - target_bin_id as i64).unsigned_abs();
    if drift > bin_tolerance as u64 {
        return Err(DeployRejection::ActiveBinOutsideTolerance);
    }

    if min_amount_out == 0 {
        return Err(DeployRejection::UnboundedSlippage);
    }
    if min_amount_out > amount {
        return Err(DeployRejection::ImpossibleSlippageBound);
    }
    Ok(())
}

/// Which side of the DLMM pool holds the token this program has custody of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    CustodyIsX,
    CustodyIsY,
}

/// Why an exit was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WithdrawRejection {
    PoolDoesNotHoldCustodyMint,
    NonPositiveWidth,
    PositionRangeOutOfBounds,
}

/// Which DLMM side the custody token sits on.
///
/// The caller does not get to say. `remove_liquidity_by_range` takes both
/// `user_token_x` and `user_token_y`, and the program must put its own vault
/// account on the correct one — resolving it from the mint is what lets the
/// same program serve a pool with USDC as token_x and one with USDC as
/// token_y, which "one-sided USDC on every chain" requires.
pub fn custody_side(
    vault_mint: Pubkey,
    token_x_mint: Pubkey,
    token_y_mint: Pubkey,
) -> Result<Side, WithdrawRejection> {
    if vault_mint == token_x_mint {
        Ok(Side::CustodyIsX)
    } else if vault_mint == token_y_mint {
        Ok(Side::CustodyIsY)
    } else {
        Err(WithdrawRejection::PoolDoesNotHoldCustodyMint)
    }
}

/// The position's full bin range, from what `init_position` was opened with.
///
/// `initialize_position(lower_bin_id, width)` opens `width` bins starting at
/// `lower_bin_id`, so the inclusive upper bound is `lower + width - 1`.
pub fn position_range(lower_bin_id: i32, width: i32) -> Result<(i32, i32), WithdrawRejection> {
    if width <= 0 {
        return Err(WithdrawRejection::NonPositiveWidth);
    }
    // Widened to i64 before adding: at the i32 extremes `lower + width - 1`
    // overflows i32, and an overflow here would be a panic in a release build
    // with `overflow-checks = true` — the same trap `check_deploy` sidesteps
    // when it computes bin drift. Only the upper bound is checked: `width >=
    // 1` here means the range only ever extends upward from `lower_bin_id`,
    // so `i32::MAX` is the only end that can be left.
    let upper = lower_bin_id as i64 + width as i64 - 1;
    if upper > i32::MAX as i64 {
        return Err(WithdrawRejection::PositionRangeOutOfBounds);
    }
    Ok((lower_bin_id, upper as i32))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Stage 1 — the property the whole design rests on
    // -----------------------------------------------------------------------

    proptest! {
        /// §10.1: "Stage 1 cannot revert."
        ///
        /// Exercised across the full u64 space, including the overflow the
        /// spec's `.unwrap()` would have panicked on.
        #[test]
        fn stage1_never_panics(current: u64, incoming: u64) {
            let _ = credit_after_receive(current, incoming);
        }

        /// It also never loses money silently below saturation.
        #[test]
        fn stage1_is_exact_until_it_saturates(current: u64, incoming: u64) {
            let out = credit_after_receive(current, incoming);
            match current.checked_add(incoming) {
                Some(exact) => prop_assert_eq!(out, exact),
                None => prop_assert_eq!(out, u64::MAX),
            }
        }

        /// Credit is monotonic: a receive can only ever increase it.
        #[test]
        fn stage1_never_decreases_credit(current: u64, incoming: u64) {
            prop_assert!(credit_after_receive(current, incoming) >= current);
        }
    }

    #[test]
    fn stage1_saturates_where_the_spec_would_have_panicked() {
        // `u64::MAX.checked_add(1).unwrap()` panics. This clamps.
        assert_eq!(credit_after_receive(u64::MAX, 1), u64::MAX);
        assert_eq!(credit_after_receive(u64::MAX, u64::MAX), u64::MAX);
    }

    #[test]
    fn stage1_handles_the_ordinary_case_exactly() {
        // $1,000 then $2,500, at 6 decimals.
        assert_eq!(credit_after_receive(1_000_000_000, 2_500_000_000), 3_500_000_000);
        assert_eq!(credit_after_receive(0, 0), 0);
    }

    // -----------------------------------------------------------------------
    // Stage 2 — sample inputs
    // -----------------------------------------------------------------------

    /// A representative accepted deploy: $1,000 credited, all of it going in,
    /// pool sitting two bins off target inside a ±5 tolerance.
    #[test]
    fn deploy_accepts_a_realistic_instruction() {
        assert_eq!(
            check_deploy(1_000_000_000, 1_000_000_000, 0, 8_388_600, 8_388_602, 5, 995_000_000),
            Ok(())
        );
    }

    #[test]
    fn deploy_accepts_a_partial_amount() {
        assert_eq!(
            check_deploy(400_000_000, 1_000_000_000, 0, 100, 100, 5, 399_000_000),
            Ok(())
        );
    }

    #[test]
    fn deploy_accepts_drift_exactly_at_the_tolerance_edge() {
        assert_eq!(check_deploy(100, 100, 0, 0, 5, 5, 99), Ok(()));
        assert_eq!(check_deploy(100, 100, 0, 0, -5, 5, 99), Ok(()));
    }

    #[test]
    fn deploy_rejects_drift_one_bin_past_tolerance() {
        assert_eq!(
            check_deploy(100, 100, 0, 0, 6, 5, 99),
            Err(DeployRejection::ActiveBinOutsideTolerance)
        );
    }

    /// The failure mode §10.1 exists to prevent, seen from stage 2: a pool
    /// that has moved far from where the engine aimed. Stage 2 declines and
    /// the funds stay credited, retryable.
    #[test]
    fn deploy_rejects_a_pool_that_moved_a_long_way() {
        assert_eq!(
            check_deploy(1_000_000_000, 1_000_000_000, 0, 8_388_600, 8_390_000, 10, 999_000_000),
            Err(DeployRejection::ActiveBinOutsideTolerance)
        );
    }

    #[test]
    fn deploy_rejects_unbounded_slippage() {
        assert_eq!(
            check_deploy(1_000, 1_000, 0, 0, 0, 5, 0),
            Err(DeployRejection::UnboundedSlippage)
        );
    }

    #[test]
    fn deploy_rejects_a_slippage_floor_above_the_amount() {
        assert_eq!(
            check_deploy(1_000, 1_000, 0, 0, 0, 5, 1_001),
            Err(DeployRejection::ImpossibleSlippageBound)
        );
    }

    #[test]
    fn deploy_rejects_more_than_was_credited() {
        assert_eq!(
            check_deploy(2_000, 1_000, 0, 0, 0, 5, 1),
            Err(DeployRejection::AmountExceedsCredit)
        );
    }

    #[test]
    fn deploy_rejects_when_everything_is_already_deployed() {
        assert_eq!(
            check_deploy(1, 1_000, 1_000, 0, 0, 5, 1),
            Err(DeployRejection::NothingToDeploy)
        );
    }

    #[test]
    fn deploy_rejects_zero() {
        assert_eq!(check_deploy(0, 1_000, 0, 0, 0, 5, 1), Err(DeployRejection::ZeroAmount));
    }

    proptest! {
        /// Stage 2 may reject anything, but it must never panic — a panic in a
        /// permissionless instruction is a griefing vector.
        #[test]
        fn stage2_never_panics(
            amount: u64, credited: u64, deployed: u64,
            target: i32, active: i32, tol: u16, min_out: u64,
        ) {
            let _ = check_deploy(amount, credited, deployed, target, active, tol, min_out);
        }

        /// Specifically at the i32 extremes, where a naive `active - target`
        /// overflows and would panic under `overflow-checks = true`.
        #[test]
        fn stage2_survives_extreme_bin_ids(tol: u16) {
            let _ = check_deploy(1, 1, 0, i32::MIN, i32::MAX, tol, 1);
            let _ = check_deploy(1, 1, 0, i32::MAX, i32::MIN, tol, 1);
        }

        /// An accepted deploy can never exceed what was credited — the
        /// invariant that keeps the receiver solvent.
        #[test]
        fn accepted_deploys_never_exceed_credit(
            amount: u64, credited: u64, deployed: u64, min_out: u64,
        ) {
            if check_deploy(amount, credited, deployed, 0, 0, 0, min_out).is_ok() {
                prop_assert!(amount <= available(credited, deployed));
            }
        }

        /// Tolerance is symmetric: drift left and right are treated alike.
        #[test]
        fn tolerance_is_symmetric(target in -1_000_000i32..1_000_000, drift in 0i32..1_000, tol: u16) {
            let left = check_deploy(10, 10, 0, target, target - drift, tol, 1);
            let right = check_deploy(10, 10, 0, target, target + drift, tol, 1);
            prop_assert_eq!(left, right);
        }
    }

    // -----------------------------------------------------------------------
    // Exit — side resolution and range derivation
    // -----------------------------------------------------------------------

    #[test]
    fn custody_side_finds_custody_on_x() {
        let usdc = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        assert_eq!(custody_side(usdc, usdc, other), Ok(Side::CustodyIsX));
    }

    #[test]
    fn custody_side_finds_custody_on_y() {
        // The devnet pool XZgB99… has Circle USDC as token_y. That is a
        // per-pool accident, which is exactly why the side is resolved from
        // the mint rather than assumed.
        let usdc = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        assert_eq!(custody_side(usdc, other, usdc), Ok(Side::CustodyIsY));
    }

    #[test]
    fn custody_side_rejects_a_pool_that_does_not_hold_the_custody_mint() {
        assert_eq!(
            custody_side(Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()),
            Err(WithdrawRejection::PoolDoesNotHoldCustodyMint)
        );
    }

    #[test]
    fn position_range_covers_the_whole_position() {
        // init_position(lower = 100, width = 20) opens bins 100..=119.
        assert_eq!(position_range(100, 20), Ok((100, 119)));
    }

    #[test]
    fn position_range_handles_a_single_bin() {
        assert_eq!(position_range(-5, 1), Ok((-5, -5)));
    }

    #[test]
    fn position_range_rejects_a_non_positive_width() {
        assert_eq!(position_range(100, 0), Err(WithdrawRejection::NonPositiveWidth));
        assert_eq!(position_range(100, -1), Err(WithdrawRejection::NonPositiveWidth));
    }

    #[test]
    fn position_range_rejects_a_range_that_leaves_i32() {
        // The case a naive `lower + width - 1` would panic on.
        assert_eq!(position_range(i32::MAX, 2), Err(WithdrawRejection::PositionRangeOutOfBounds));
        assert_eq!(
            position_range(i32::MAX - 1, i32::MAX),
            Err(WithdrawRejection::PositionRangeOutOfBounds)
        );
    }

    #[test]
    fn position_range_accepts_the_representable_boundaries() {
        // i32::MIN is otherwise never exercised, despite the doc comment
        // invoking it — and the widest possible position, starting at the
        // lowest possible bin, is exactly the case the i64 widening exists for.
        assert_eq!(position_range(i32::MAX, 1), Ok((i32::MAX, i32::MAX)));
        assert_eq!(position_range(i32::MIN, 1), Ok((i32::MIN, i32::MIN)));
        assert_eq!(position_range(i32::MIN, i32::MAX), Ok((i32::MIN, -2)));
    }

    proptest! {
        /// The boundary is the whole reason this is a rule rather than an
        /// inline `lower + width - 1`. Asserting acceptance, not just
        /// rejection, is what makes an off-by-one in the guard fail here.
        #[test]
        fn position_range_accepts_exactly_the_representable_ranges(lower: i32, width: i32) {
            let expected_ok = width > 0 && lower as i64 + width as i64 - 1 <= i32::MAX as i64;
            prop_assert_eq!(position_range(lower, width).is_ok(), expected_ok);
        }

        /// A derived range always starts where the position starts and spans
        /// exactly `width` bins — the identity that makes "full exit" true.
        /// `to == from` alone would also hold for a single-bin exit of a
        /// 70-bin position, which is why the span itself is asserted.
        #[test]
        fn derived_range_spans_exactly_the_position(lower: i32, width: i32) {
            if let Ok((from, to)) = position_range(lower, width) {
                prop_assert_eq!(from, lower);
                prop_assert!(to >= from);
                prop_assert_eq!(to as i64 - from as i64 + 1, width as i64);
            }
        }

        /// Custody resolves iff the pool actually holds the mint, and the side
        /// it names is the side whose mint matches.
        ///
        /// Indices into a 3-element pool, not raw `Pubkey::new_unique()` or a
        /// byte cast: with only 3 possible values per slot, `vault == x` and
        /// `vault == y` collide often enough that both `Ok` arms and the `Err`
        /// arm are all reached every run, not just in expectation.
        #[test]
        fn custody_side_resolves_iff_the_pool_holds_the_mint(a in 0usize..3, b in 0usize..3, c in 0usize..3) {
            let pool = [
                Pubkey::new_from_array([1u8; 32]),
                Pubkey::new_from_array([2u8; 32]),
                Pubkey::new_from_array([3u8; 32]),
            ];
            let vault = pool[a];
            let x = pool[b];
            let y = pool[c];
            let got = custody_side(vault, x, y);
            prop_assert_eq!(got.is_ok(), vault == x || vault == y);
            match got {
                Ok(Side::CustodyIsX) => prop_assert_eq!(vault, x),
                Ok(Side::CustodyIsY) => prop_assert_eq!(vault, y),
                Err(_) => {}
            }
        }
    }
}
