// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {Router} from "../src/Router.sol";

contract RouterTest is Fixtures {
    function setUp() public {
        setUpStack();
    }

    // -----------------------------------------------------------------------
    // §7.5 — the payback rule, checked against the spec's own worked example
    // -----------------------------------------------------------------------

    /// @dev "Worked example, ΔAPR = 3%, total cost $2":
    ///        A = $1,000  → ~24 days   → Do not move
    ///        A = $10,000 → ~2.4 days  → Marginal
    ///        A = $50,000 → ~0.5 days  → Move now
    ///      With the default 7-day expected hold and κ = 1.75, the required
    ///      hold is 42.6 / 4.26 / 0.85 days respectively.
    function test_paybackMatchesSpecWorkedExample() public view {
        uint256 cost = 2 * USDC_ONE;
        uint256 deltaApyBps = 300; // 3%

        (bool okSmall,,) = router.checkPayback(1_000 * USDC_ONE, cost, deltaApyBps);
        (bool okMedium,,) = router.checkPayback(10_000 * USDC_ONE, cost, deltaApyBps);
        (bool okLarge,,) = router.checkPayback(50_000 * USDC_ONE, cost, deltaApyBps);

        assertFalse(okSmall, "$1k: 42.6 days required vs 7 expected -> decline");
        assertTrue(okMedium, "$10k: 4.26 days required vs 7 expected -> accept");
        assertTrue(okLarge, "$50k: 0.85 days required vs 7 expected -> accept");
    }

    /// @dev The view helper must reproduce §7.5's day figures. This is the
    ///      number the §5.3 snippet got wrong by a factor of ~10,139.
    function test_breakevenDaysMatchSpecTable() public view {
        uint256 cost = 2 * USDC_ONE;
        uint256 d = 300;

        assertApproxEqRel(
            router.paybackDaysScaled(1_000 * USDC_ONE, cost, d), 24.33e18, 0.01e18, "~24 days"
        );
        assertApproxEqRel(
            router.paybackDaysScaled(10_000 * USDC_ONE, cost, d), 2.433e18, 0.01e18, "~2.4 days"
        );
        assertApproxEqRel(
            router.paybackDaysScaled(50_000 * USDC_ONE, cost, d), 0.4867e18, 0.01e18, "~0.5 days"
        );
    }

    /// @dev The precision the §5.3 snippet threw away: at $50k the true
    ///      payback is 0.49 days, which integer division truncates to 0.
    function test_subDayPaybackSurvives() public view {
        uint256 scaled = router.paybackDaysScaled(50_000 * USDC_ONE, 2 * USDC_ONE, 300);
        assertGt(scaled, 0, "sub-day payback must not truncate to zero");
        assertLt(scaled, 1e18, "and it really is under a day");
    }

    function test_hysteresisBlocksAMarginalMove() public {
        // A move that breaks even in exactly the expected hold is not worth
        // making — κ is what stops the vault churning (§5.3).
        vm.prank(owner);
        router.setConfig(2, 12 hours, 100_000, 500); // expect a 2-day hold

        // $10k at ΔAPR 3%, cost $2 breaks even in 2.43 days.
        (bool ok,,) = router.checkPayback(10_000 * USDC_ONE, 2 * USDC_ONE, 300);
        assertFalse(ok, "2.43 x 1.75 = 4.26 days required, 2 expected -> decline");
    }

    function test_rebalanceRejectsMoveWithNoEdge() public {
        _seedVenueA(10_000 * USDC_ONE);
        _warpPastDwell();
        bytes32[] memory proof = postScores(5_000, 900);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Router.NoEdge.selector, uint32(900), uint32(900)));
        router.rebalance(
            VENUE_A, VENUE_B, 10_000 * USDC_ONE, 900, 900, 2 * USDC_ONE, 5_000, proof, "", ""
        );
    }

    function test_rebalanceRejectsWhenCostExceedsEdge() public {
        uint256 amount = 1_000 * USDC_ONE;
        _seedVenueA(amount);
        _warpPastDwell();
        bytes32[] memory proof = postScores(5_000, 900);

        // $1,000 at ΔAPR 3% needs 42.6 days of holding; we expect 7.
        vm.prank(keeper);
        vm.expectRevert();
        router.rebalance(VENUE_A, VENUE_B, amount, 900, 600, 2 * USDC_ONE, 5_000, proof, "", "");
    }

    function test_rebalanceAcceptsWhenEdgeClearsCost() public {
        uint256 amount = 50_000 * USDC_ONE;
        _seedVenueA(amount);
        _warpPastDwell();
        bytes32[] memory proof = postScores(5_000, 900);

        vm.prank(keeper);
        router.rebalance(VENUE_A, VENUE_B, amount, 900, 600, 2 * USDC_ONE, 5_000, proof, "", "");

        (uint128 deployedB,,,,,) = vault.venues(VENUE_B);
        (uint128 deployedA,,,,,) = vault.venues(VENUE_A);
        assertEq(deployedB, amount, "capital landed at the destination");
        assertEq(deployedA, 0, "and left the source");
    }

    // -----------------------------------------------------------------------
    // §5.3 — dwell, proofs, staleness
    // -----------------------------------------------------------------------

    function test_dwellIsEnforced() public {
        uint256 amount = 50_000 * USDC_ONE;
        _seedVenueA(amount);
        bytes32[] memory proof = postScores(5_000, 900);

        // No warp: the venue was just deployed into.
        vm.prank(keeper);
        vm.expectRevert();
        router.rebalance(VENUE_A, VENUE_B, amount, 900, 600, 2 * USDC_ONE, 5_000, proof, "", "");
    }

    function test_badProofIsRejected() public {
        uint256 amount = 50_000 * USDC_ONE;
        _seedVenueA(amount);
        _warpPastDwell();
        postScores(5_000, 900);

        bytes32[] memory bogus = new bytes32[](1);
        bogus[0] = keccak256("not a real sibling");

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Router.BadProof.selector, VENUE_B));
        router.rebalance(VENUE_A, VENUE_B, amount, 900, 600, 2 * USDC_ONE, 5_000, bogus, "", "");
    }

    /// @dev A proof valid for an earlier epoch must not authorize a move under
    ///      the current root — `asOf` comes from storage, not the caller.
    function test_staleProofCannotBeReplayed() public {
        uint256 amount = 50_000 * USDC_ONE;
        _seedVenueA(amount);
        _warpPastDwell();
        bytes32[] memory oldProof = postScores(5_000, 900);
        postScores(6_000, 950); // new epoch, new root — old proof now dead

        vm.prank(keeper);
        vm.expectRevert();
        router.rebalance(VENUE_A, VENUE_B, amount, 900, 600, 2 * USDC_ONE, 5_000, oldProof, "", "");
    }

    /// @dev §10.2: "Score oracle offline → Vault holds; no rebalance is always
    ///      a valid state."
    function test_staleScoresBlockRebalance() public {
        uint256 amount = 50_000 * USDC_ONE;
        _seedVenueA(amount);
        _warpPastDwell();
        bytes32[] memory proof = postScores(5_000, 900);

        vm.warp(vm.getBlockTimestamp() + 3 hours); // past MAX_SCORE_AGE
        vm.prank(keeper);
        vm.expectRevert();
        router.rebalance(VENUE_A, VENUE_B, amount, 900, 600, 2 * USDC_ONE, 5_000, proof, "", "");
    }

    function test_onlyKeeperMayRebalance() public {
        uint256 amount = 50_000 * USDC_ONE;
        _seedVenueA(amount);
        _warpPastDwell();
        bytes32[] memory proof = postScores(5_000, 900);

        vm.prank(alice);
        vm.expectRevert(Router.NotKeeper.selector);
        router.rebalance(VENUE_A, VENUE_B, amount, 900, 600, 2 * USDC_ONE, 5_000, proof, "", "");
    }

    /// @dev §3's trust table: "Operator could post bad scores → on-chain
    ///      sanity bounds." A 5,000% APY is a data bug, not a yield.
    function test_absurdApyIsRejected() public {
        uint256 amount = 50_000 * USDC_ONE;
        _seedVenueA(amount);
        _warpPastDwell();
        bytes32[] memory proof = postScores(5_000, 500_000);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(Router.ApyOutOfBounds.selector, uint32(500_000), uint32(100_000))
        );
        router.rebalance(VENUE_A, VENUE_B, amount, 500_000, 600, 2 * USDC_ONE, 5_000, proof, "", "");
    }

    function test_absurdCostIsRejected() public {
        uint256 amount = 50_000 * USDC_ONE;
        _seedVenueA(amount);
        _warpPastDwell();
        bytes32[] memory proof = postScores(5_000, 900);

        // A cost of 10% of the amount is never rational.
        vm.prank(keeper);
        vm.expectRevert();
        router.rebalance(
            VENUE_A, VENUE_B, amount, 900, 600, amount / 10, 5_000, proof, "", ""
        );
    }

    // -----------------------------------------------------------------------
    // Fuzz: the rule must be monotone in size
    // -----------------------------------------------------------------------

    /// @dev "Optimal venue depends on position size" (§7.5). Concretely: if a
    ///      move clears the hurdle at size A, it must also clear it at any
    ///      larger size, all else equal.
    function testFuzz_biggerPositionsNeverBecomeLessWorthMoving(
        uint96 rawAmount,
        uint96 rawCost,
        uint16 rawDelta
    ) public view {
        uint256 amount = bound(uint256(rawAmount), USDC_ONE, 1e12 * USDC_ONE);
        uint256 cost = bound(uint256(rawCost), 1, 1_000 * USDC_ONE);
        uint256 delta = bound(uint256(rawDelta), 1, 100_000);

        (bool okSmall,,) = router.checkPayback(amount, cost, delta);
        (bool okLarge,,) = router.checkPayback(amount * 2, cost, delta);

        if (okSmall) assertTrue(okLarge, "doubling size must not lose the edge");
    }

    /// @dev And monotone in cost, the other direction.
    function testFuzz_higherCostNeverBecomesMoreWorthMoving(uint96 rawCost) public view {
        uint256 cost = bound(uint256(rawCost), 1, 1_000 * USDC_ONE);
        uint256 amount = 100_000 * USDC_ONE;

        (bool okCheap,,) = router.checkPayback(amount, cost, 300);
        (bool okDear,,) = router.checkPayback(amount, cost * 2, 300);

        if (okDear) assertTrue(okCheap, "halving cost must not lose the edge");
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// @dev MIN_DWELL (12h) is far longer than MAX_SCORE_AGE (2h), so a keeper
    ///      cannot warp past the dwell and reuse the scores that authorized the
    ///      original deployment — it must post a fresh set at the moment of the
    ///      move. Tests follow that same order: seed → dwell → fresh scores.
    function _warpPastDwell() private {
        (, uint64 minDwell,,) = router.config();
        vm.warp(vm.getBlockTimestamp() + minDwell + 1);
    }

    function _seedVenueA(uint256 amount) private {
        depositAs(alice, amount);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 asOf = uint64(vm.getBlockTimestamp());
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = oracle.leafHash(VENUE_A, 5_000, 600, asOf);
        leaves[1] = oracle.leafHash(VENUE_B, 5_000, 900, asOf);

        vm.prank(reporter);
        oracle.postScores(_root(leaves), asOf, "ipfs://seed");

        vm.prank(keeper);
        router.deployIdle(VENUE_A, amount, 600, 5_000, _proof(leaves, 0), "");
    }

    function _root(bytes32[] memory leaves) private pure returns (bytes32) {
        bytes32 a = leaves[0];
        bytes32 b = leaves[1];
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _proof(bytes32[] memory leaves, uint256 index)
        private
        pure
        returns (bytes32[] memory p)
    {
        p = new bytes32[](1);
        p[0] = leaves[index ^ 1];
    }
}
