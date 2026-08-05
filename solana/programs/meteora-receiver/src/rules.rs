//! The decision rules, extracted so they can be tested without a validator.
//!
//! Everything here is pure. The instruction handlers in `lib.rs` are thin
//! wrappers that load accounts and call into these, which means the properties
//! that matter — above all "stage 1 cannot fail" — can be proven by exhaustive
//! and property testing rather than by a handful of integration cases.

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
}
