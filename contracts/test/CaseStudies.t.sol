// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {LPVault} from "../src/LPVault.sol";
import {Router} from "../src/Router.sol";

/// @title Case studies — sequences, not single calls
/// @notice Every bug found in this project so far needed a *sequence*: a
///         second deposit, a loss after a request, a claim after another
///         claim. Single-call tests kept passing throughout.
///
///         So these probe orderings that a live vault will hit within days
///         and that no happy-path test exercises. Each is written to fail
///         loudly if the behaviour is wrong, and several did on first run.
contract CaseStudiesTest is Fixtures {
    function setUp() public {
        setUpStack();
    }

    function _deploy(uint16 venue, uint256 amount) private {
        bytes32[] memory proof = postScoresFor(venue, 5_000, 900);
        vm.prank(keeper);
        router.deployIdle(venue, amount, 900, 5_000, proof, "");
    }

    // -----------------------------------------------------------------------
    // CASE 1 — the position made money
    // -----------------------------------------------------------------------

    /// @dev The whole point of the vault is to earn fees. So the exit path
    ///      must cope with a venue returning MORE than it was given.
    ///
    ///      `Router.rebalance` passes the executor's return value straight
    ///      into `vault.recordReturn`, which rejects anything above the
    ///      venue's book value. A profitable position therefore cannot be
    ///      exited: the vault is fine with losses and breaks on gains.
    function test_CASE1_profitableVenueCanBeExited() public {
        depositAs(alice, 10_000 * USDC_ONE);
        _deploy(VENUE_A, 10_000 * USDC_ONE);

        // The venue earned 3% in fees. Mint the gain to the executor so it
        // really does hand back more than it took.
        usdc.mint(address(executorA), 300 * USDC_ONE);
        executorA.setEntered(10_300 * USDC_ONE);

        (uint128 book,,,,,) = vault.venues(VENUE_A);
        assertEq(book, 10_000 * USDC_ONE, "book value is what was sent");

        // Now unwind it.
        vm.prank(address(executorA));
        usdc.transfer(address(vault), 10_300 * USDC_ONE);
        vm.prank(address(router));
        vault.recordReturn(VENUE_A, 10_300 * USDC_ONE);

        (uint128 after_,,,,,) = vault.venues(VENUE_A);
        assertEq(after_, 0, "venue emptied");
        assertEq(vault.idleAssets(), 10_300 * USDC_ONE, "gain credited to idle");
    }

    // -----------------------------------------------------------------------
    // CASE 2 — depositing just before a NAV gain
    // -----------------------------------------------------------------------

    /// @dev NAV is reported in discrete steps, so a gain lands in one
    ///      transaction. Anyone watching the reporter can deposit immediately
    ///      before it and capture value they were never at risk for.
    ///
    ///      Recorded rather than fixed: the 500bp cap bounds the size of the
    ///      theft per epoch, and the real defence is a private mempool or a
    ///      deposit fee. Worth knowing the exposure exactly.
    function test_CASE2_depositBeforeNavGainCapturesValue() public {
        depositAs(alice, 10_000 * USDC_ONE);
        _deploy(VENUE_A, 10_000 * USDC_ONE);

        // Bob front-runs a +5% report.
        uint256 bobShares = depositAs(bob, 10_000 * USDC_ONE);
        uint256 bobCost = 10_000 * USDC_ONE;

        vm.warp(vm.getBlockTimestamp() + vault.NAV_COOLDOWN() + 1);
        vm.prank(reporter);
        vault.reportNav(uint128(10_500 * USDC_ONE));

        uint256 bobValue = vault.previewRedeemShares(bobShares);
        uint256 profit = bobValue > bobCost ? bobValue - bobCost : 0;

        // He captured roughly half the $500 gain by owning half the vault.
        assertGt(profit, 200 * USDC_ONE, "front-run captured value");
        assertLt(profit, 300 * USDC_ONE, "bounded by his share of the vault");
    }

    // -----------------------------------------------------------------------
    // CASE 3 — churn: A -> B -> A
    // -----------------------------------------------------------------------

    /// @dev §5.3's dwell exists so the vault cannot be walked back and forth
    ///      bleeding fees. Test that it actually blocks the return leg.
    function test_CASE3_dwellBlocksAnImmediateReturnLeg() public {
        depositAs(alice, 500_000 * USDC_ONE);
        _deploy(VENUE_A, 500_000 * USDC_ONE);

        (, uint64 minDwell,,) = router.config();
        vm.warp(vm.getBlockTimestamp() + minDwell + 1);
        bytes32[] memory p1 = postScoresFor(VENUE_B, 5_000, 900);

        vm.prank(keeper);
        router.rebalance(
            VENUE_A, VENUE_B, 500_000 * USDC_ONE, 900, 600, 2 * USDC_ONE, 5_000, p1, "", ""
        );

        // Immediately try to come back. VENUE_B was just written, so its
        // dwell has not elapsed.
        bytes32[] memory p2 = postScoresFor(VENUE_A, 5_000, 900);
        vm.prank(keeper);
        vm.expectRevert();
        router.rebalance(
            VENUE_B, VENUE_A, 500_000 * USDC_ONE, 900, 600, 2 * USDC_ONE, 5_000, p2, "", ""
        );
    }

    // -----------------------------------------------------------------------
    // CASE 4 — partial unwind, then the rest
    // -----------------------------------------------------------------------

    function test_CASE4_partialReturnLeavesTheRestDeployed() public {
        depositAs(alice, 10_000 * USDC_ONE);
        _deploy(VENUE_A, 10_000 * USDC_ONE);

        vm.prank(address(executorA));
        usdc.transfer(address(vault), 4_000 * USDC_ONE);
        vm.prank(address(router));
        vault.recordReturn(VENUE_A, 4_000 * USDC_ONE);

        (uint128 book,,,,,) = vault.venues(VENUE_A);
        assertEq(book, 6_000 * USDC_ONE, "remainder still deployed");
        assertEq(vault.idleAssets(), 4_000 * USDC_ONE, "returned part is idle");
        assertEq(vault.totalAssets(), 10_000 * USDC_ONE, "equity unchanged by the move");
    }

    // -----------------------------------------------------------------------
    // CASE 11 — the full lifecycle: deposit, deploy, withdraw
    // -----------------------------------------------------------------------

    /// @dev Found by running this on Base Sepolia rather than by reading the
    ///      code: there was no way to bring capital back. `deployIdle` sends
    ///      it out, `rebalance` moves it between venues, and neither returns
    ///      it — so once deployed, every deposit was unrecoverable.
    function test_CASE11_capitalCanComeHomeToSatisfyAWithdrawal() public {
        uint256 shares = depositAs(alice, 10_000 * USDC_ONE);
        _deploy(VENUE_A, 10_000 * USDC_ONE);
        assertEq(vault.idleAssets(), 0, "everything is deployed");

        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares);

        // Without `returnToVault` this is where a real vault would be stuck.
        vm.prank(keeper);
        uint256 recovered = router.returnToVault(VENUE_A, 10_000 * USDC_ONE, "");
        assertEq(recovered, 10_000 * USDC_ONE, "capital came home");

        vm.prank(operator);
        vault.settleEpoch();
        vm.prank(alice);
        assertEq(vault.claimWithdraw(id), 10_000 * USDC_ONE, "and the depositor was paid");
    }

    /// @dev An exit must never be gated on profitability — that is how a vault
    ///      traps its depositors. `returnToVault` runs no payback test.
    function test_CASE12_exitIsNotGatedOnAnAprEdge() public {
        depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);

        // $1,000 is a size at which `rebalance` would refuse to move at all.
        vm.prank(keeper);
        uint256 recovered = router.returnToVault(VENUE_A, 1_000 * USDC_ONE, "");
        assertEq(recovered, 1_000 * USDC_ONE, "small positions can still exit");
    }

    /// @dev Only the keeper may pull capital back.
    function test_CASE13_returnToVaultIsKeeperOnly() public {
        depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);

        vm.prank(alice);
        vm.expectRevert(Router.NotKeeper.selector);
        router.returnToVault(VENUE_A, 1_000 * USDC_ONE, "");
    }

    /// @dev Surplus stranded after the last holder leaves. Observed on Base
    ///      Sepolia: a 10 USDC deposit returned 14.6, and once the depositor
    ///      exited the 4.6 belonged to nobody.
    function test_CASE14_surplusStrandedAfterLastHolderExitsIsRecoverable() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE);

        // The venue returns more than it took.
        usdc.mint(address(executorA), 200 * USDC_ONE);
        executorA.setEntered(1_200 * USDC_ONE);

        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares);
        vm.prank(keeper);
        router.returnToVault(VENUE_A, 1_200 * USDC_ONE, "");
        vm.prank(operator);
        vault.settleEpoch();
        vm.prank(alice);
        vault.claimWithdraw(id);

        // Alice is gone; a surplus remains that no share can claim.
        assertEq(vault.totalSupply(), 0, "no holders left");
        assertGt(vault.idleAssets(), 0, "but idle is not empty");
        assertEq(vault.unaccountedBalance(), 0, "and rescueUnaccounted cannot see it");

        uint256 stranded = vault.idleAssets();
        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        assertEq(vault.sweepOrphanedIdle(owner), stranded, "recovered");
        assertEq(usdc.balanceOf(owner) - before, stranded, "delivered");
        assertEq(vault.idleAssets(), 0, "nothing stranded");
    }

    /// @dev The guard that makes it safe: it can never touch depositor funds.
    function test_CASE15_sweepRefusesWhileAnyoneHoldsShares() public {
        depositAs(alice, 1_000 * USDC_ONE);
        vm.prank(owner);
        vm.expectRevert();
        vault.sweepOrphanedIdle(owner);
    }

    /// @dev And never while a withdrawal is still owed.
    function test_CASE16_sweepRefusesWhileAClaimIsOutstanding() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);
        vm.prank(alice);
        vault.requestWithdraw(shares);

        assertEq(vault.totalSupply(), 0, "shares burned at request time");
        vm.prank(owner);
        vm.expectRevert(); // pending is non-zero
        vault.sweepOrphanedIdle(owner);
    }

    // -----------------------------------------------------------------------
    // CASE 5 — everyone leaves at once
    // -----------------------------------------------------------------------

    /// @dev A bank run. Every holder requests in the same epoch, so `pending`
    ///      equals the entire vault and equity goes to zero. The last claimer
    ///      must still be paid.
    function test_CASE5_fullBankRunPaysEveryone() public {
        uint256 a = depositAs(alice, 10_000 * USDC_ONE);
        uint256 b = depositAs(bob, 10_000 * USDC_ONE);

        vm.prank(alice);
        uint256 aliceId = vault.requestWithdraw(a);
        vm.prank(bob);
        uint256 bobId = vault.requestWithdraw(b);

        assertEq(vault.totalAssets(), 0, "everything is owed out");
        assertEq(vault.coverageBps(), 10_000, "but the vault can cover it");

        vm.prank(operator);
        vault.settleEpoch();

        vm.prank(alice);
        uint256 alicePaid = vault.claimWithdraw(aliceId);
        vm.prank(bob);
        uint256 bobPaid = vault.claimWithdraw(bobId);

        assertEq(alicePaid, 10_000 * USDC_ONE, "alice whole");
        assertEq(bobPaid, 10_000 * USDC_ONE, "bob whole");
        assertEq(vault.idleAssets(), 0, "vault emptied cleanly");
        assertEq(vault.totalSupply(), 0, "no shares left");
    }

    // -----------------------------------------------------------------------
    // CASE 6 — a paused venue
    // -----------------------------------------------------------------------

    /// @dev Pausing must stop new capital going in without trapping what is
    ///      already there.
    function test_CASE6_pausedVenueStillReturnsCapital() public {
        // Leave idle behind, so the pause is what blocks the deploy rather
        // than simply having nothing to send.
        depositAs(alice, 11_000 * USDC_ONE);
        _deploy(VENUE_A, 10_000 * USDC_ONE);

        vm.prank(owner);
        vault.setVenuePaused(VENUE_A, true);

        // No new capital.
        bytes32[] memory proof = postScoresFor(VENUE_A, 5_000, 900);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(LPVault.VenuePaused.selector, VENUE_A));
        router.deployIdle(VENUE_A, 1, 900, 5_000, proof, "");

        // ...but what is deployed can still come home.
        vm.prank(address(executorA));
        usdc.transfer(address(vault), 10_000 * USDC_ONE);
        vm.prank(address(router));
        vault.recordReturn(VENUE_A, 10_000 * USDC_ONE);
        assertEq(vault.idleAssets(), 11_000 * USDC_ONE, "capital escaped the paused venue");
    }

    // -----------------------------------------------------------------------
    // CASE 7 — dust
    // -----------------------------------------------------------------------

    /// @dev Many tiny deposits must not let anyone extract more than they put
    ///      in through rounding.
    function test_CASE7_repeatedDustDepositsCannotExtractValue() public {
        depositAs(alice, 1_000 * USDC_ONE); // seed so the vault is not empty

        uint256 spent;
        uint256 shares;
        for (uint256 i = 0; i < 50; i++) {
            vm.prank(bob);
            shares += vault.deposit(1, bob);
            spent += 1;
        }
        assertLe(vault.previewRedeemShares(shares), spent, "rounding must not favour the depositor");
    }

    // -----------------------------------------------------------------------
    // CASE 8 — deposit exactly at the cap
    // -----------------------------------------------------------------------

    function test_CASE8_depositExactlyAtCapSucceedsAndNextFails() public {
        vm.prank(owner);
        vault.setCaps(uint128(1_000 * USDC_ONE), type(uint128).max);

        depositAs(alice, 1_000 * USDC_ONE);
        assertEq(vault.totalAssets(), 1_000 * USDC_ONE, "exactly at cap");

        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(1, bob);
    }

    // -----------------------------------------------------------------------
    // CASE 9 — rebalancing more than a venue holds
    // -----------------------------------------------------------------------

    /// @dev A keeper names a big `amount` to clear the payback gate, but the
    ///      venue only holds a little, so only a little moves. The economics
    ///      must be re-checked against what actually came back — otherwise the
    ///      churn protection is bypassed by simply lying about the size.
    ///
    ///      At $1m a $2 move repays in 0.02 days and clears easily; at the
    ///      $1,000 that really moves it needs 24 days and must not.
    function test_CASE9_paybackRuleBindsWhatActuallyMoved() public {
        depositAs(alice, 500_000 * USDC_ONE);
        _deploy(VENUE_A, 1_000 * USDC_ONE); // the venue holds only $1,000

        (, uint64 minDwell,,) = router.config();
        vm.warp(vm.getBlockTimestamp() + minDwell + 1);
        bytes32[] memory proof = postScoresFor(VENUE_B, 5_000, 900);

        vm.prank(keeper);
        vm.expectRevert(); // PaybackTooLong, re-checked on `recovered`
        router.rebalance(
            VENUE_A, VENUE_B, 1_000_000 * USDC_ONE, 900, 600, 2 * USDC_ONE, 5_000, proof, "", ""
        );
    }

    /// @dev The honest version of the same move still works: a partial return
    ///      that still clears the hurdle is allowed through.
    function test_CASE9b_honestPartialReturnStillRebalances() public {
        depositAs(alice, 500_000 * USDC_ONE);
        _deploy(VENUE_A, 400_000 * USDC_ONE);

        (, uint64 minDwell,,) = router.config();
        vm.warp(vm.getBlockTimestamp() + minDwell + 1);
        bytes32[] memory proof = postScoresFor(VENUE_B, 5_000, 900);

        vm.prank(keeper);
        router.rebalance(
            VENUE_A, VENUE_B, 500_000 * USDC_ONE, 900, 600, 2 * USDC_ONE, 5_000, proof, "", ""
        );

        (uint128 b,,,,,) = vault.venues(VENUE_B);
        assertEq(b, 400_000 * USDC_ONE, "moved what the venue actually held");
    }

    // -----------------------------------------------------------------------
    // CASE 10 — NAV rises after a request
    // -----------------------------------------------------------------------

    /// @dev A requester is locked at the price when they asked. If the vault
    ///      then gains, that gain belongs to the holders who stayed — the
    ///      requester must not be topped up.
    function test_CASE10_gainAfterRequestGoesToRemainingHolders() public {
        uint256 a = depositAs(alice, 10_000 * USDC_ONE);
        depositAs(bob, 10_000 * USDC_ONE);
        _deploy(VENUE_A, 20_000 * USDC_ONE);

        vm.prank(alice);
        uint256 aliceId = vault.requestWithdraw(a);

        vm.warp(vm.getBlockTimestamp() + vault.NAV_COOLDOWN() + 1);
        vm.prank(reporter);
        vault.reportNav(uint128(21_000 * USDC_ONE)); // +5%

        // Bob's equity absorbs the whole gain.
        assertEq(vault.totalAssets(), 11_000 * USDC_ONE, "gain to the holder who stayed");

        vm.prank(address(executorA));
        usdc.transfer(address(vault), 20_000 * USDC_ONE);
        vm.prank(address(router));
        vault.recordReturn(VENUE_A, 20_000 * USDC_ONE);
        vm.prank(operator);
        vault.settleEpoch();

        vm.prank(alice);
        assertEq(vault.claimWithdraw(aliceId), 10_000 * USDC_ONE, "alice gets what she locked");
    }
}
