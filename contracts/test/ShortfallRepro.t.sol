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
    function test_KNOWN_LIMITATION_staleNavDefeatsTheHaircut() public {
        uint256 aliceShares = depositAs(alice, 1_000 * USDC_ONE);
        uint256 bobShares = depositAs(bob, 1_000 * USDC_ONE);

        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, 2_000 * USDC_ONE, 900, 5_000, proof, "");

        vm.prank(alice);
        uint256 aliceId = vault.requestWithdraw(aliceShares);
        vm.prank(bob);
        uint256 bobId = vault.requestWithdraw(bobShares);

        // $1,600 returns; the missing $400 is NOT marked down.
        vm.prank(address(executorB));
        usdc.transfer(address(vault), 1_600 * USDC_ONE);
        vm.prank(address(router));
        vault.recordReturn(VENUE_B, 1_600 * USDC_ONE);
        vm.prank(operator);
        vault.settleEpoch();

        // The vault still counts the lost $400 as deployed, so it believes it
        // is whole and applies no haircut.
        assertEq(vault.deployedAssets(), 400 * USDC_ONE, "phantom assets on the book");
        assertEq(vault.coverageBps(), 10_000, "so no haircut is applied");

        vm.prank(alice);
        assertEq(vault.claimWithdraw(aliceId), 1_000 * USDC_ONE, "alice is paid in full");

        // And bob cannot be paid at all until the mark catches up.
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPVault.InsufficientIdle.selector, 1_000 * USDC_ONE, 600 * USDC_ONE
            )
        );
        vault.claimWithdraw(bobId);
    }
}
