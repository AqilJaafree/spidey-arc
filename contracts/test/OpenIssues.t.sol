// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {LPVault} from "../src/LPVault.sol";
import {Router} from "../src/Router.sol";

/// @title The sequences that were listed as unprobed
/// @notice The status report named seven orderings as "plausible bug sources,
///         none tested". Guessing which are real is how you fix things that
///         were never broken and miss the ones that were, so each is tested
///         here first and only then fixed.
contract OpenIssuesTest is Fixtures {
    function setUp() public {
        setUpStack();
    }

    function _deploy(uint16 venue, uint256 amount) private {
        bytes32[] memory proof = postScoresFor(venue, 5_000, 900);
        vm.prank(keeper);
        router.deployIdle(venue, amount, 900, 5_000, proof, "");
    }

    // -----------------------------------------------------------------------
    // A — syncIdle while capital is deployed
    // -----------------------------------------------------------------------

    /// @dev The worry: `syncIdle` folds `balance - idle` into equity. While
    ///      capital is out at a venue that difference should be zero, but if
    ///      an executor returned tokens without `recordReturn`, calling both
    ///      could count the same money twice.
    function test_A_syncIdleDoesNotDoubleCountAReturn() public {
        depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);
        assertEq(vault.idleAssets(), 0, "all deployed");

        // Executor sends tokens back WITHOUT the router recording it.
        vm.prank(address(executorA));
        usdc.transfer(address(vault), 1_000 * USDC_ONE);

        // They show up as unaccounted, not as equity.
        assertEq(vault.unaccountedBalance(), 1_000 * USDC_ONE, "seen but not counted");
        assertEq(vault.totalAssets(), 1_000 * USDC_ONE, "equity still says deployed");

        // The owner cannot fold them in while capital is deployed, because
        // they might BE that capital coming home unrecorded.
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LPVault.CapitalStillDeployed.selector, 1_000 * USDC_ONE)
        );
        vault.syncIdle();

        assertEq(vault.totalAssets(), 1_000 * USDC_ONE, "equity never double counts");

        // Recording the return is the correct path, and it is exact.
        vm.prank(address(router));
        vault.recordReturn(VENUE_A, 1_000 * USDC_ONE);
        assertEq(vault.totalAssets(), 1_000 * USDC_ONE, "still 1,000, now as idle");
        assertEq(vault.idleAssets(), 1_000 * USDC_ONE, "credited once");
        assertEq(vault.unaccountedBalance(), 0, "nothing left ambiguous");
    }

    // -----------------------------------------------------------------------
    // B — a venue that is deployed into and then paused forever
    // -----------------------------------------------------------------------

    /// @dev There is no unregister path. Check a paused venue at least cannot
    ///      trap capital, which is the property that matters.
    function test_B_noUnregisterButCapitalStillEscapes() public {
        depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);

        vm.prank(owner);
        vault.setVenuePaused(VENUE_A, true);

        vm.prank(keeper);
        uint256 recovered = router.returnToVault(VENUE_A, 1_000 * USDC_ONE, "", true);
        assertEq(recovered, 1_000 * USDC_ONE, "a paused venue still releases capital");
    }

    // -----------------------------------------------------------------------
    // C — rescueUnaccounted racing a legitimate return
    // -----------------------------------------------------------------------

    /// @dev If an executor has transferred but the router has not yet recorded
    ///      it, those tokens look unaccounted. A rescue would then take real
    ///      depositor capital.
    function test_C_rescueCanTakeAnUnrecordedReturn() public {
        depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);

        // Executor transfers back; recordReturn has not run yet.
        vm.prank(address(executorA));
        usdc.transfer(address(vault), 1_000 * USDC_ONE);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(LPVault.CapitalStillDeployed.selector, 1_000 * USDC_ONE)
        );
        vault.rescueUnaccounted(owner);

        assertEq(usdc.balanceOf(address(vault)), 1_000 * USDC_ONE, "depositor capital untouched");

        // Once the return is recorded there is nothing unaccounted to take.
        vm.prank(address(router));
        vault.recordReturn(VENUE_A, 1_000 * USDC_ONE);
        vm.prank(owner);
        assertEq(vault.rescueUnaccounted(owner), 0, "nothing to rescue - it is all accounted");
    }

    // -----------------------------------------------------------------------
    // D — two rebalances in the same block
    // -----------------------------------------------------------------------

    function test_D_dwellIsNotBypassedWithinOneBlock() public {
        depositAs(alice, 500_000 * USDC_ONE);
        _deploy(VENUE_A, 500_000 * USDC_ONE);

        (, uint64 minDwell,,) = router.config();
        vm.warp(vm.getBlockTimestamp() + minDwell + 1);
        bytes32[] memory p1 = postScoresFor(VENUE_B, 5_000, 900);

        vm.prank(keeper);
        router.rebalance(
            VENUE_A, VENUE_B, 500_000 * USDC_ONE, 900, 600, 2 * USDC_ONE, 5_000, p1, "", ""
        );

        // Same timestamp, straight back. Dwell is in seconds, so this is the
        // sharpest test of whether it actually binds.
        bytes32[] memory p2 = postScoresFor(VENUE_A, 5_000, 900);
        vm.prank(keeper);
        vm.expectRevert();
        router.rebalance(
            VENUE_B, VENUE_A, 500_000 * USDC_ONE, 900, 600, 2 * USDC_ONE, 5_000, p2, "", ""
        );
    }

    // -----------------------------------------------------------------------
    // E — a venue returning far less than book (position out of range)
    // -----------------------------------------------------------------------

    function test_E_venueReturningLessLeavesTheRemainderOnTheBook() public {
        depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);

        // Only 60% comes back — the rest is sitting in the other token.
        executorA.setEntered(600 * USDC_ONE);

        // A PARTIAL exit leaves the remainder on the book — it is still there.
        vm.prank(keeper);
        uint256 recovered = router.returnToVault(VENUE_A, 1_000 * USDC_ONE, "", false);
        assertEq(recovered, 600 * USDC_ONE, "took what was there");
        (uint128 book,,,,,) = vault.venues(VENUE_A);
        assertEq(book, 400 * USDC_ONE, "remainder still on the book, not lost");
        assertEq(vault.totalAssets(), 1_000 * USDC_ONE, "equity unchanged until NAV marks it");
    }

    // -----------------------------------------------------------------------
    // F — the realized-loss case that broke a live withdrawal
    // -----------------------------------------------------------------------

    /// @dev Observed on Base Sepolia: a 5 USDC position returned 4.985 after
    ///      slippage. The missing 0.015 stayed on the venue's book, so
    ///      `coverageBps` read 10000, no haircut applied, and `claimWithdraw`
    ///      reverted `InsufficientIdle` — the depositor could not be paid at
    ///      all, which is worse than being paid slightly less.
    function test_F_closingAVenueAtALossLetsTheWithdrawalSettle() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);

        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares);

        // The position closes 3% short.
        executorA.setEntered(970 * USDC_ONE);
        vm.prank(keeper);
        router.returnToVault(VENUE_A, 1_000 * USDC_ONE, "", true);

        // The residual is recognized, not left flattering the books.
        (uint128 book,,,,,) = vault.venues(VENUE_A);
        assertEq(book, 0, "venue written off");
        assertEq(vault.deployedAssets(), 0, "no phantom assets");
        assertEq(vault.coverageBps(), 9_700, "haircut reflects the real loss");

        vm.prank(operator);
        vault.settleEpoch();
        vm.prank(alice);
        assertEq(vault.claimWithdraw(id), 970 * USDC_ONE, "paid what actually exists");
    }

    /// @dev Without the write-off the same sequence cannot pay at all.
    function test_F2_withoutWriteOffTheClaimWouldRevert() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);
        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares);

        executorA.setEntered(970 * USDC_ONE);
        vm.prank(keeper);
        router.returnToVault(VENUE_A, 1_000 * USDC_ONE, "", false); // no finalize

        assertEq(vault.coverageBps(), 10_000, "phantom book hides the loss");
        vm.prank(operator);
        vault.settleEpoch();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPVault.InsufficientIdle.selector, 1_000 * USDC_ONE, 970 * USDC_ONE
            )
        );
        vault.claimWithdraw(id);
    }
}
