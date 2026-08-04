// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {Fixtures} from "./Fixtures.sol";

/// @title Gas budget conformance
/// @notice Spec §8.4's target table, asserted rather than admired.
///
///         | Operation             | Target gas |
///         |-----------------------|------------|
///         | deposit               | < 90k      |
///         | postScores            | < 30k      |
///         | rebalance (EVM→EVM)   | < 180k     |
///         | requestWithdraw       | < 60k      |
///         | claimWithdraw         | < 70k      |
///
///         §8 opens with why this is not optional: "Arc charges gas in USDC on
///         an EIP-1559 base ... That makes optimization economically legible —
///         every saved unit is a countable cent of user yield — but it does not
///         make it optional. Rebalancing is the vault's recurring cost and it
///         compounds against the yield edge."
///
///         Measured against live Arc testnet pricing (base fee 20 gwei,
///         effective ~27.95 gwei observed, native 18dp), 1 gas ≈ $2.8e-8, so
///         the whole table costs well under a cent per operation.
contract GasBudgetTest is Fixtures {
    uint256 private constant BUDGET_DEPOSIT = 90_000;
    uint256 private constant BUDGET_POST_SCORES = 30_000;
    uint256 private constant BUDGET_REBALANCE = 180_000;
    uint256 private constant BUDGET_REQUEST_WITHDRAW = 60_000;
    uint256 private constant BUDGET_CLAIM_WITHDRAW = 70_000;

    function setUp() public {
        setUpStack();
    }

    /// @dev Printed so a regression shows its margin, not just pass/fail.
    ///      Arc prices gas in USDC, so the last column is real money: at the
    ///      27.95 gwei effective price observed on Arc testnet and 18-decimal
    ///      native units, 1 gas = $2.795e-8.
    function _report(string memory label, uint256 used, uint256 budget) private pure {
        // 1 gas = 2.795e-8 USDC, so micro-dollars = gas * 2795 / 100_000.
        uint256 microDollars = (used * 2795) / 100_000;
        console2.log(
            string.concat(
                _pad(label, 18),
                _pad(_str(used), 9),
                "/ ",
                _pad(_str(budget), 9),
                _pad(string.concat(_str((used * 100) / budget), "%"), 7),
                _pad(string.concat(_str(microDollars), " micro-USD"), 18)
            )
        );
    }

    function _str(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        for (uint256 i = len; i > 0; i--) {
            b[i - 1] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }

    function _pad(string memory s, uint256 width) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= width) return string.concat(s, " ");
        bytes memory out = new bytes(width);
        for (uint256 i = 0; i < width; i++) {
            out[i] = i < b.length ? b[i] : bytes1(" ");
        }
        return string(out);
    }

    function test_gas_deposit() public {
        // Warm the vault so this measures the steady state, not the first-ever
        // write into empty storage.
        depositAs(alice, 1_000 * USDC_ONE);

        vm.prank(bob);
        uint256 before = gasleft();
        vault.deposit(1_000 * USDC_ONE, bob);
        uint256 used = before - gasleft();

        _report("deposit", used, BUDGET_DEPOSIT);
        assertLt(used, BUDGET_DEPOSIT, "deposit over the 90k budget");
    }

    function test_gas_postScores() public {
        // First post pays the seed rewrite; measure the second, steady-state one.
        postScores(5_000, 900);

        vm.warp(vm.getBlockTimestamp() + 60);
        uint64 asOf = uint64(vm.getBlockTimestamp());
        bytes32 root = keccak256(abi.encode("root", asOf));

        vm.prank(reporter);
        uint256 before = gasleft();
        oracle.postScores(root, asOf, "ipfs://x");
        uint256 used = before - gasleft();

        _report("postScores", used, BUDGET_POST_SCORES);
        assertLt(used, BUDGET_POST_SCORES, "postScores over the 30k budget");
    }

    function test_gas_requestWithdraw() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);
        // A prior request warms the queue slot and the counter.
        depositAs(bob, 1_000 * USDC_ONE);
        vm.prank(bob);
        vault.requestWithdraw(1);

        vm.prank(alice);
        uint256 before = gasleft();
        vault.requestWithdraw(shares);
        uint256 used = before - gasleft();

        _report("requestWithdraw", used, BUDGET_REQUEST_WITHDRAW);
        assertLt(used, BUDGET_REQUEST_WITHDRAW, "requestWithdraw over the 60k budget");
    }

    function test_gas_claimWithdraw() public {
        uint256 shares = depositAs(alice, 1_000 * USDC_ONE);
        vm.prank(alice);
        uint256 id = vault.requestWithdraw(shares);
        vm.prank(operator);
        vault.settleEpoch();

        vm.prank(alice);
        uint256 before = gasleft();
        vault.claimWithdraw(id);
        uint256 used = before - gasleft();

        _report("claimWithdraw", used, BUDGET_CLAIM_WITHDRAW);
        assertLt(used, BUDGET_CLAIM_WITHDRAW, "claimWithdraw over the 70k budget");
    }

    function test_gas_rebalance() public {
        uint256 amount = 50_000 * USDC_ONE;
        depositAs(alice, amount);

        // Seed venue A.
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 asOf = uint64(vm.getBlockTimestamp());
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = oracle.leafHash(VENUE_A, 5_000, 600, asOf);
        leaves[1] = oracle.leafHash(VENUE_B, 5_000, 900, asOf);
        vm.prank(reporter);
        oracle.postScores(_root(leaves), asOf, "ipfs://seed");

        bytes32[] memory proofA = new bytes32[](1);
        proofA[0] = leaves[1];
        vm.prank(keeper);
        router.deployIdle(VENUE_A, amount, 600, 5_000, proofA, "");

        // Dwell, then fresh scores.
        (, uint64 minDwell,,) = router.config();
        vm.warp(vm.getBlockTimestamp() + minDwell + 1);
        bytes32[] memory proofB = postScores(5_000, 900);

        vm.prank(keeper);
        uint256 before = gasleft();
        router.rebalance(VENUE_A, VENUE_B, amount, 900, 600, 2 * USDC_ONE, 5_000, proofB, "", "");
        uint256 used = before - gasleft();

        _report("rebalance", used, BUDGET_REBALANCE);
        assertLt(used, BUDGET_REBALANCE, "rebalance over the 180k budget");
    }

    /// @dev §8.1's claim, measured: "Merkle root instead of rows. Posting N
    ///      venue scores as N storage writes costs N x ~20,000. ... At 40
    ///      venues this is ~800k gas saved per epoch."
    function test_gas_merkleRootBeatsPerVenueRows() public {
        postScores(5_000, 900);
        vm.warp(vm.getBlockTimestamp() + 60);
        uint64 asOf = uint64(vm.getBlockTimestamp());

        vm.prank(reporter);
        uint256 before = gasleft();
        oracle.postScores(keccak256("root"), asOf, "ipfs://x");
        uint256 rootCost = before - gasleft();

        // 40 venues written as individual non-zero storage slots would be at
        // least 40 x 20,000 the first time and 40 x 5,000 thereafter.
        uint256 naiveWarmCost = 40 * 5_000;
        assertLt(rootCost, naiveWarmCost / 4, "root posting must dominate per-venue rows");
    }

    function _root(bytes32[] memory leaves) private pure returns (bytes32) {
        bytes32 a = leaves[0];
        bytes32 b = leaves[1];
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
