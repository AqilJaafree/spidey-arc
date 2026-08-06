// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {LPVault} from "../src/LPVault.sol";

/// @title Withdrawal shortfall — regression tests
/// @notice Found by the invariant suite, not by inspection:
///         `pending (31,239,968,266) > idle + deployed (30,515,949,293)`.
///
///         `requestWithdraw` fixes a payout at the share price current when
///         the holder asks. A loss afterwards shrinks the vault's assets but
///         leaves that fixed claim untouched, so the vault can end up owing
///         more than it holds.
///
///         The README called this "borne by remaining holders", which
///         understated it twice over: remaining equity is not reduced but
///         clamped to zero, and the residual shortfall then lands entirely on
///         whoever claims last — transaction ordering deciding who eats a loss
///         that belongs to everyone.
///
///         Fixed by {LPVault.coverageBps}: every claim is scaled by what the
///         vault can actually cover, so the loss is shared pro-rata.
contract ShortfallReproTest is Fixtures {
    function setUp() public {
        setUpStack();
    }

    /// @dev Walk the NAV down in steps the 500bp guard accepts. The cap bounds
    ///      each STEP, not the cumulative drawdown, so a sustained loss gets
    ///      there regardless.
    function _walkNavDownTo(uint256 target) private {
        uint256 deployed = vault.deployedAssets();
        while (deployed > target) {
            uint256 next = (deployed * 9_600) / 10_000; // 4%, inside the cap
            if (next < target) next = target;
            vm.warp(vm.getBlockTimestamp() + vault.NAV_COOLDOWN() + 1);
            vm.prank(reporter);
            vault.reportNav(uint128(next));
            deployed = next;
        }
    }

    /// @dev The condition the fuzzer found: claims outrunning assets.
    function test_navLossCanLeaveClaimsExceedingAssets() public {
        uint256 aliceShares = depositAs(alice, 1_000 * USDC_ONE);
        depositAs(bob, 1_000 * USDC_ONE);

        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, 2_000 * USDC_ONE, 900, 5_000, proof, "");

        // Alice exits at the current price: owed $1,000, fixed.
        vm.prank(alice);
        vault.requestWithdraw(aliceShares);

        _walkNavDownTo(800 * USDC_ONE);

        // Bob is wiped out — clamped to zero, not merely reduced.
        assertEq(vault.totalAssets(), 0, "remaining equity clamped to zero");

        // Alice's recorded claim never moved, and now exceeds everything held.
        (uint128 idle, uint128 pending) = vault.assets();
        assertEq(pending, 1_000 * USDC_ONE, "the recorded claim is unchanged");
        assertLt(uint256(idle) + vault.deployedAssets(), pending, "claims exceed assets");

        // ...but what is PAYABLE is now scaled to what exists: 800/1000 = 80%.
        assertEq(vault.coverageBps(), 8_000, "claims are haircut to 80%");
    }

    /// @dev The fix, on the case that previously cost someone everything.
    function test_lossIsSharedProRataNotByClaimOrder() public {
        uint256 aliceShares = depositAs(alice, 1_000 * USDC_ONE);
        uint256 bobShares = depositAs(bob, 1_000 * USDC_ONE);

        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, 2_000 * USDC_ONE, 900, 5_000, proof, "");

        // Both exit while the book still reads $2,000: $1,000 each.
        vm.prank(alice);
        uint256 aliceId = vault.requestWithdraw(aliceShares);
        vm.prank(bob);
        uint256 bobId = vault.requestWithdraw(bobShares);

        // The venue loses 20%: the book is marked down, then $1,600 comes back.
        _walkNavDownTo(1_600 * USDC_ONE);
        vm.prank(address(executorB));
        usdc.transfer(address(vault), 1_600 * USDC_ONE);
        vm.prank(address(router));
        vault.recordReturn(VENUE_B, 1_600 * USDC_ONE);

        vm.prank(operator);
        vault.settleEpoch();

        assertEq(vault.coverageBps(), 8_000, "80% coverage against $2,000 of claims");

        // Both are paid the same, regardless of who goes first.
        vm.prank(alice);
        uint256 alicePaid = vault.claimWithdraw(aliceId);
        vm.prank(bob);
        uint256 bobPaid = vault.claimWithdraw(bobId);

        assertEq(alicePaid, 800 * USDC_ONE, "alice takes her share of the loss");
        assertEq(bobPaid, 800 * USDC_ONE, "and bob takes exactly the same");
        assertEq(alicePaid, bobPaid, "claim order does not decide who loses");
    }

    /// @dev Order-independence, stated as a property rather than an example.
    function testFuzz_claimOrderNeverChangesWhatEitherPartyGets(bool aliceFirst) public {
        uint256 aliceShares = depositAs(alice, 1_000 * USDC_ONE);
        uint256 bobShares = depositAs(bob, 1_000 * USDC_ONE);

        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, 2_000 * USDC_ONE, 900, 5_000, proof, "");

        vm.prank(alice);
        uint256 aliceId = vault.requestWithdraw(aliceShares);
        vm.prank(bob);
        uint256 bobId = vault.requestWithdraw(bobShares);

        _walkNavDownTo(1_500 * USDC_ONE);
        vm.prank(address(executorB));
        usdc.transfer(address(vault), 1_500 * USDC_ONE);
        vm.prank(address(router));
        vault.recordReturn(VENUE_B, 1_500 * USDC_ONE);
        vm.prank(operator);
        vault.settleEpoch();

        uint256 alicePaid;
        uint256 bobPaid;
        if (aliceFirst) {
            vm.prank(alice);
            alicePaid = vault.claimWithdraw(aliceId);
            vm.prank(bob);
            bobPaid = vault.claimWithdraw(bobId);
        } else {
            vm.prank(bob);
            bobPaid = vault.claimWithdraw(bobId);
            vm.prank(alice);
            alicePaid = vault.claimWithdraw(aliceId);
        }

        assertEq(alicePaid, bobPaid, "whoever goes first, both get the same");
        assertEq(alicePaid, 750 * USDC_ONE, "each takes half of the $500 loss");
    }

    /// @dev A limitation the haircut cannot cover, recorded rather than hidden.
    ///
    ///      The scale is computed from what the vault BELIEVES it holds, which
    ///      includes `nav.deployedAssets`. If a venue has lost capital and the
    ///      reporter has not yet marked it down, the vault still looks solvent
    ///      and no haircut applies — so the queue stays first-come-first-served
    ///      for exactly as long as the mark is stale.
    ///
    ///      §5.1's 500bp-per-epoch cap makes this sharper than it sounds: it
    ///      bounds an honest markdown as tightly as a malicious one, so a large
    ///      realized loss can only be written down across many epochs. The
    ///      protection against a compromised reporter is also a delay on
    ///      telling the truth.
    /// @dev The shortfall with the loss NOT marked down: $2,000 goes out, only
    ///      $1,600 comes back, and the missing $400 stays on the book.
    ///
    ///      `coverageBps` reads that phantom $400 as an asset, so the vault
    ///      believes it is whole and applies no haircut — the haircut defeated
    ///      by a mark nobody refreshed. Alice would be paid in full and bob,
    ///      owed the same $1,000, would find $600 left.
    function _shortfallLeftUnmarked() private returns (uint256 aliceId, uint256 bobId) {
        uint256 aliceShares = depositAs(alice, 1_000 * USDC_ONE);
        uint256 bobShares = depositAs(bob, 1_000 * USDC_ONE);

        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, 2_000 * USDC_ONE, 900, 5_000, proof, "");

        vm.prank(alice);
        aliceId = vault.requestWithdraw(aliceShares);
        vm.prank(bob);
        bobId = vault.requestWithdraw(bobShares);

        // $1,600 returns; the missing $400 is NOT marked down.
        vm.prank(address(executorB));
        usdc.transfer(address(vault), 1_600 * USDC_ONE);
        vm.prank(address(router));
        vault.recordReturn(VENUE_B, 1_600 * USDC_ONE);
        vm.prank(operator);
        vault.settleEpoch();

        assertEq(vault.deployedAssets(), 400 * USDC_ONE, "phantom assets on the book");
        assertEq(vault.coverageBps(), 10_000, "which reads as full coverage");
    }

    /// @dev The fix: once the mark is older than `MAX_NAV_AGE`, the vault stops
    ///      treating it as an asset it can pay out of.
    ///
    ///      It does not guess a haircut from a number it cannot vouch for —
    ///      that would confiscate value from depositors whenever the reporter
    ///      merely went offline. It holds, per §10.2, and says why. Nobody is
    ///      paid at par out of a balance that may not exist, so ordering stops
    ///      deciding who eats the loss.
    function test_staleMarkHoldsTheClaimInsteadOfPayingOutAgainstIt() public {
        (uint256 aliceId, uint256 bobId) = _shortfallLeftUnmarked();

        (, uint64 markedAt,) = vault.nav();
        uint64 maxAge = vault.MAX_NAV_AGE();
        vm.warp(vm.getBlockTimestamp() + maxAge + 1);

        // Read `maxAge` up front: an external call between `vm.prank` and the
        // call under test consumes the prank, and the claim then reverts
        // `NotRequestOwner` for the wrong reason entirely.
        bytes memory stale = abi.encodeWithSelector(LPVault.NavStale.selector, markedAt, maxAge);

        vm.prank(alice);
        vm.expectRevert(stale);
        vault.claimWithdraw(aliceId);

        vm.prank(bob);
        vm.expectRevert(stale);
        vault.claimWithdraw(bobId);
    }

    /// @dev And the hold is resolvable, not a trap. Writing the residual off —
    ///      ledger #10's path, `returnToVault(finalize: true)` — removes the
    ///      unverified balance entirely, and then the haircut does exactly what
    ///      it was built to do: $1,600 across $2,000 of claims, pro-rata, in
    ///      whatever order they arrive.
    function test_writingTheResidualOffLetsTheHaircutShareTheLoss() public {
        (uint256 aliceId, uint256 bobId) = _shortfallLeftUnmarked();
        vm.warp(vm.getBlockTimestamp() + vault.MAX_NAV_AGE() + 1);

        vm.prank(address(router));
        assertEq(vault.recordVenueClosed(VENUE_B), 400 * USDC_ONE, "the phantom is written off");

        // Nothing deployed is left to be unsure about, so age stops mattering.
        assertEq(vault.deployedAssets(), 0, "no unverified balance remains");
        assertEq(vault.coverageBps(), 8_000, "coverage is what the vault holds");

        vm.prank(alice);
        assertEq(vault.claimWithdraw(aliceId), 800 * USDC_ONE, "alice takes her share");
        vm.prank(bob);
        assertEq(vault.claimWithdraw(bobId), 800 * USDC_ONE, "and bob takes his");
    }

    /// @dev The other half of the gate: a mark the reporter is keeping current
    ///      still backs a payout. The freshness bound must not turn every
    ///      deployed dollar into an unusable one — that would stall the queue
    ///      whenever the vault is doing its job.
    function test_aFreshMarkStillBacksTheClaim() public {
        uint256 aliceShares = depositAs(alice, 1_000 * USDC_ONE);
        uint256 bobShares = depositAs(bob, 1_000 * USDC_ONE);

        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, 1_000 * USDC_ONE, 900, 5_000, proof, "");

        vm.prank(alice);
        uint256 aliceId = vault.requestWithdraw(aliceShares);
        vm.prank(bob);
        vault.requestWithdraw(bobShares);
        vm.prank(operator);
        vault.settleEpoch();

        // Idle ($1,000) alone does not cover the queue ($2,000), so the answer
        // depends on the deployed $1,000 — exactly the case the gate governs.
        // Let the mark go stale, then refresh it at the same value.
        vm.warp(vm.getBlockTimestamp() + vault.MAX_NAV_AGE() + 1);
        vm.prank(reporter);
        vault.reportNav(uint128(1_000 * USDC_ONE));

        assertEq(vault.coverageBps(), 10_000, "fully covered on a current mark");
        vm.prank(alice);
        assertEq(vault.claimWithdraw(aliceId), 1_000 * USDC_ONE, "and paid in full");
    }
}
