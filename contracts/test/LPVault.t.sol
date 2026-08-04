// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {LPVault} from "../src/LPVault.sol";

contract LPVaultTest is Fixtures {
    function setUp() public {
        setUpStack();
    }

    // -----------------------------------------------------------------------
    // §5.1 — async withdrawals are mandatory
    // -----------------------------------------------------------------------

    function test_synchronousRedemptionIsDisabled() public {
        depositAs(alice, 1_000 * USDC_ONE);

        vm.startPrank(alice);
        vm.expectRevert(LPVault.SynchronousRedemptionDisabled.selector);
        vault.withdraw(1, alice, alice);

        vm.expectRevert(LPVault.SynchronousRedemptionDisabled.selector);
        vault.redeem(1, alice, alice);
        vm.stopPrank();

        // ERC-4626 consumers must see zero, not a number they cannot act on.
        assertEq(vault.maxWithdraw(alice), 0, "maxWithdraw must advertise 0");
        assertEq(vault.maxRedeem(alice), 0, "maxRedeem must advertise 0");
    }

    function test_requestThenClaimRoundTrip() public {
        uint256 assets = 1_000 * USDC_ONE;
        uint256 shares = depositAs(alice, assets);
        uint256 balanceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        uint256 requestId = vault.requestWithdraw(shares);

        assertEq(vault.balanceOf(alice), 0, "shares burn at request time");
        (, uint128 pending,,) = _queue();
        assertEq(pending, assets, "assets owed are reserved");

        // Cannot claim before the epoch settles.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPVault.EpochNotSettled.selector, 1, 0));
        vault.claimWithdraw(requestId);

        vm.prank(operator);
        vault.settleEpoch();

        vm.prank(alice);
        uint256 paid = vault.claimWithdraw(requestId);

        assertEq(paid, assets, "paid out the requested amount");
        assertEq(usdc.balanceOf(alice), balanceBefore + assets, "USDC returned");
        (, pending,,) = _queue();
        assertEq(pending, 0, "reservation released");
    }

    function test_claimIsSingleUse() public {
        uint256 shares = depositAs(alice, 500 * USDC_ONE);
        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares);
        vm.prank(operator);
        vault.settleEpoch();

        vm.prank(alice);
        vault.claimWithdraw(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPVault.NothingToClaim.selector, alice));
        vault.claimWithdraw(id);
    }

    function test_onlyRequesterCanClaim() public {
        uint256 shares = depositAs(alice, 500 * USDC_ONE);
        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares);
        vm.prank(operator);
        vault.settleEpoch();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LPVault.NotRequestOwner.selector, id));
        vault.claimWithdraw(id);
        // ...and bob cannot forge an id for himself either: he has nothing.
        uint256 bobId = vault.encodeRequestId(bob, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LPVault.NothingToClaim.selector, bob));
        vault.claimWithdraw(bobId);
    }

    /// @dev The reason the queue exists at all (§10.2: "Withdrawal exceeds
    ///      idle → async queue; epoch settlement after position close").
    function test_claimBlocksWhenCapitalIsStillDeployed() public {
        uint256 assets = 1_000 * USDC_ONE;
        uint256 shares = depositAs(alice, assets);

        // Push everything into a venue, then request an exit.
        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, assets, 900, 5_000, proof, "");

        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares);
        vm.prank(operator);
        vault.settleEpoch();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPVault.InsufficientIdle.selector, assets, 0));
        vault.claimWithdraw(id);
    }

    // -----------------------------------------------------------------------
    // One outstanding request per holder (the §8.4 gas structure)
    // -----------------------------------------------------------------------

    /// @dev Two requests in the same epoch merge into one record, which is
    ///      what keeps the second one a 5,000-gas rewrite instead of a
    ///      22,100-gas cold write.
    function test_secondRequestInSameEpochMergesIntoTheFirst() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);

        vm.prank(alice);
        uint256 first = vault.requestWithdraw(shares / 2);
        vm.prank(alice);
        uint256 second = vault.requestWithdraw(shares / 2);

        assertEq(first, second, "same epoch yields the same request id");

        (uint128 owed, uint16 epoch,) = vault.pendingOf(alice);
        assertEq(owed, 1_000 * USDC_ONE, "both requests are owed together");
        assertEq(epoch, 1, "still epoch 1");

        vm.prank(operator);
        vault.settleEpoch();
        vm.prank(alice);
        assertEq(vault.claimWithdraw(first), 1_000 * USDC_ONE, "one claim pays both");
    }

    /// @dev A settled-but-unclaimed request must be collected before opening
    ///      a new one, so a claim can never be silently overwritten.
    function test_cannotOpenANewRequestWhileAnOlderOneIsUnclaimed() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);

        vm.prank(alice);
        vault.requestWithdraw(shares / 2);
        vm.prank(operator);
        vault.settleEpoch(); // epoch 1 settled, alice has not claimed

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LPVault.ClaimPendingFirst.selector, 1, 2));
        vault.requestWithdraw(shares / 4);
    }

    function test_newRequestAllowedOnceTheOldOneIsClaimed() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);

        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares / 2);
        vm.prank(operator);
        vault.settleEpoch();
        vm.prank(alice);
        vault.claimWithdraw(id);

        // The slot keeps its INITIALIZED bit, so this is a cheap rewrite.
        (uint128 owed,, uint8 flags) = vault.pendingOf(alice);
        assertEq(owed, 0, "nothing outstanding");
        assertTrue(flags != 0, "slot must stay non-zero for the gas structure");

        vm.prank(alice);
        uint256 next = vault.requestWithdraw(shares / 4);
        assertTrue(next != id, "a new epoch yields a new id");
    }

    function test_requestIdRoundTrips() public view {
        uint256 id = vault.encodeRequestId(alice, 7);
        (address holder, uint16 epoch) = vault.decodeRequestId(id);
        assertEq(holder, alice, "holder survives the round trip");
        assertEq(epoch, 7, "epoch survives the round trip");
    }

    function testFuzz_requestIdRoundTrips(address holder, uint16 epoch) public view {
        (address gotHolder, uint16 gotEpoch) = vault.decodeRequestId(
            vault.encodeRequestId(holder, epoch)
        );
        assertEq(gotHolder, holder);
        assertEq(gotEpoch, epoch);
    }

    // -----------------------------------------------------------------------
    // §5.1 / §10.2 — NAV is reported and bounded
    // -----------------------------------------------------------------------

    function test_navRespectsCooldown() public {
        _deployForNav(1_000 * USDC_ONE);

        // The cooldown runs from the last NAV write, not from "now". Read both
        // before pranking: an external view call would consume the prank and
        // the revert would come back as NotReporter instead.
        (, uint64 updatedAt,) = vault.nav();
        uint64 readyAt = updatedAt + vault.NAV_COOLDOWN();

        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(LPVault.NavCooldown.selector, readyAt));
        vault.reportNav(1_010 * uint128(USDC_ONE));
    }

    function test_navRejectsMoveBeyondMaxDelta() public {
        uint256 assets = 1_000 * USDC_ONE;
        _deployForNav(assets);
        vm.warp(vm.getBlockTimestamp() + vault.NAV_COOLDOWN() + 1);

        // +6% exceeds the 500bp bound.
        uint128 tooHigh = uint128(assets * 106 / 100);
        uint16 maxDelta = vault.MAX_NAV_DELTA_BPS();

        vm.prank(reporter);
        vm.expectRevert(
            abi.encodeWithSelector(LPVault.NavDeltaTooLarge.selector, assets, tooHigh, maxDelta)
        );
        vault.reportNav(tooHigh);

        // ...and the state is unchanged. §10.2: "reject, don't clamp silently."
        assertEq(vault.deployedAssets(), assets, "NAV must not move on rejection");
    }

    function test_navAcceptsMoveInsideBound() public {
        uint256 assets = 1_000 * USDC_ONE;
        _deployForNav(assets);
        vm.warp(vm.getBlockTimestamp() + vault.NAV_COOLDOWN() + 1);

        uint128 gain = uint128(assets * 104 / 100); // +4%, inside 500bp
        vm.prank(reporter);
        vault.reportNav(gain);

        assertEq(vault.deployedAssets(), gain, "NAV updated");
        assertEq(vault.totalAssets(), gain, "equity tracks reported NAV");
    }

    function test_reporterCannotMoveFunds() public {
        depositAs(alice, 1_000 * USDC_ONE);
        // §3's design goal: "no off-chain party holds a key that can move user
        // funds. The scoring engine proposes; the contracts dispose."
        vm.prank(reporter);
        vm.expectRevert(LPVault.NotRouter.selector);
        vault.transferToExecutor(address(executorB), 1);
    }

    // -----------------------------------------------------------------------
    // §5.1 — caps
    // -----------------------------------------------------------------------

    function test_depositCapIsEnforced() public {
        vm.prank(owner);
        vault.setCaps(uint128(1_000 * USDC_ONE), type(uint128).max);

        depositAs(alice, 1_000 * USDC_ONE);
        assertEq(vault.maxDeposit(alice), 0, "cap reached");

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPVault.DepositCapExceeded.selector, 1_001 * USDC_ONE, 1_000 * USDC_ONE
            )
        );
        vault.deposit(1 * USDC_ONE, bob);
    }

    function test_perVenueCapStopsTheVaultBecomingTheDilutionProblem() public {
        uint256 assets = 1_000 * USDC_ONE;
        depositAs(alice, assets);

        vm.prank(owner);
        vault.setCaps(type(uint128).max, uint128(400 * USDC_ONE));

        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                LPVault.VenueCapExceeded.selector, VENUE_B, assets, 400 * USDC_ONE
            )
        );
        router.deployIdle(VENUE_B, assets, 900, 5_000, proof, "");
    }

    // -----------------------------------------------------------------------
    // Withdrawal reservations are not spendable
    // -----------------------------------------------------------------------

    function test_routerCannotSpendAssetsOwedToRequesters() public {
        uint256 assets = 1_000 * USDC_ONE;
        uint256 shares = depositAs(alice, assets);

        vm.prank(alice);
        vault.requestWithdraw(shares);

        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(LPVault.InsufficientIdle.selector, assets, 0));
        router.deployIdle(VENUE_B, assets, 900, 5_000, proof, "");
    }

    // -----------------------------------------------------------------------
    // Share accounting
    // -----------------------------------------------------------------------

    function testFuzz_depositRedeemPreservesValue(uint96 rawAssets) public {
        uint256 assets = bound(uint256(rawAssets), USDC_ONE, 1_000_000 * USDC_ONE);

        uint256 shares = depositAs(alice, assets);
        uint256 owed = vault.previewRedeemShares(shares);

        // Rounding must never favour the depositor over the vault.
        assertLe(owed, assets, "redeem cannot exceed deposit without yield");
        assertGe(owed + 1, assets, "rounding loss is at most 1 unit");
    }

    function test_secondDepositorIsNotDilutedByFirst() public {
        uint256 a = depositAs(alice, 1_000 * USDC_ONE);
        uint256 b = depositAs(bob, 1_000 * USDC_ONE);
        assertApproxEqRel(a, b, 1e12, "equal deposits earn equal shares");
    }

    /// @dev The classic ERC-4626 first-depositor inflation attack, blocked by
    ///      the virtual-share offset.
    function test_donationCannotStealSecondDepositor() public {
        depositAs(alice, 1); // 1 unit, the attacker's toehold

        // Attacker donates directly to inflate the share price.
        vm.prank(alice);
        usdc.transfer(address(vault), 10_000 * USDC_ONE);

        uint256 bobShares = depositAs(bob, 1_000 * USDC_ONE);
        assertGt(bobShares, 0, "victim must still receive shares");
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _queue() private view returns (uint256, uint128, uint64, uint16) {
        (uint16 epoch, uint16 settled) = vault.queue();
        (, uint128 pending) = vault.assets();
        return (settled, pending, 0, epoch);
    }

    function _deployForNav(uint256 assets) private {
        depositAs(alice, assets);
        bytes32[] memory proof = postScores(5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, assets, 900, 5_000, proof, "");
    }
}
