// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {LPVault} from "../src/LPVault.sol";
import {Router} from "../src/Router.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";
import {IVenueExecutor} from "../src/interfaces/IVenueExecutor.sol";

/// @dev USDC on Arc: 6 decimals through the ERC-20 interface (§7.7).
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Stands in for the App Kit / Uniswap v3 executor on the EVM leg.
///      Holds the USDC it is sent and hands it back on exit.
contract MockExecutor is IVenueExecutor {
    MockUSDC public immutable usdc;
    address public immutable vault;
    bool public sync;
    uint256 public entered;

    constructor(MockUSDC usdc_, address vault_, bool sync_) {
        usdc = usdc_;
        vault = vault_;
        sync = sync_;
    }

    function enter(uint16, uint256 assets, bytes calldata) external override {
        entered += assets;
    }

    function exit(uint16, uint256 assets, bytes calldata) external override returns (uint256) {
        if (assets > entered) assets = entered;
        entered -= assets;
        usdc.transfer(vault, assets);
        return assets;
    }

    function isSynchronous() external view override returns (bool) {
        return sync;
    }

    /// @dev Simulate a venue whose position gained or lost value, so the
    ///      exit path can be tested against a return that differs from what
    ///      was deposited.
    function setEntered(uint256 value) external {
        entered = value;
    }
}

/// @dev A minimal, dependency-free Merkle tree matching {ScoreOracle.leafHash}
///      and OpenZeppelin's sorted-pair proof verification.
library MerkleLib {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @dev OZ hashes concatenated bytes, not abi.encode. Match it exactly.
    function commutativeKeccak(bytes32 a, bytes32 b) internal pure returns (bytes32 value) {
        assembly ("memory-safe") {
            mstore(0x00, a)
            mstore(0x20, b)
            value := keccak256(0x00, 0x40)
        }
    }

    function pairHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? commutativeKeccak(a, b) : commutativeKeccak(b, a);
    }

    /// @notice Build a root from an arbitrary leaf list (duplicating the last
    ///         node on odd levels).
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "no leaves");
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 next = (level.length + 1) / 2;
            bytes32[] memory parents = new bytes32[](next);
            for (uint256 i = 0; i < next; i++) {
                uint256 l = 2 * i;
                uint256 r = l + 1;
                parents[i] = r < level.length ? pairHash(level[l], level[r]) : level[l];
            }
            level = parents;
        }
        return level[0];
    }

    /// @notice Proof for `index` in `leaves`.
    function proof(bytes32[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32[] memory)
    {
        bytes32[] memory acc = new bytes32[](32);
        uint256 count = 0;
        bytes32[] memory level = leaves;
        uint256 idx = index;

        while (level.length > 1) {
            uint256 sibling = idx ^ 1;
            if (sibling < level.length) {
                acc[count++] = level[sibling];
            }
            uint256 next = (level.length + 1) / 2;
            bytes32[] memory parents = new bytes32[](next);
            for (uint256 i = 0; i < next; i++) {
                uint256 l = 2 * i;
                uint256 r = l + 1;
                parents[i] = r < level.length ? pairHash(level[l], level[r]) : level[l];
            }
            level = parents;
            idx /= 2;
        }

        bytes32[] memory out = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = acc[i];
        }
        return out;
    }
}

abstract contract Fixtures is Test {
    MockUSDC internal usdc;
    LPVault internal vault;
    ScoreOracle internal oracle;
    Router internal router;
    MockExecutor internal executorA;
    MockExecutor internal executorB;

    address internal owner = address(0xA11CE);
    address internal reporter = address(0xB0B);
    address internal operator = address(0xC0FFEE);
    address internal keeper = address(0xDEAD);
    address internal alice = address(0x1111);
    address internal bob = address(0x2222);

    uint16 internal constant VENUE_A = 1; // Arc-local
    uint16 internal constant VENUE_B = 2; // Base
    uint8 internal constant DOMAIN_ARC = 26; // verified: Arc's CCTP domain
    uint8 internal constant DOMAIN_BASE = 6;

    uint256 internal constant USDC_ONE = 1e6;

    function setUpStack() internal {
        // Foundry starts block.timestamp at 1, which collides with the
        // deliberately non-zero seeds these contracts use to avoid the
        // 20,000-gas zero→non-zero SSTORE (§8.1). Start from a realistic
        // wall clock so cooldowns and staleness checks behave as on-chain.
        vm.warp(1_770_000_000);

        usdc = new MockUSDC();
        vault = new LPVault(usdc, owner, reporter, operator);
        oracle = new ScoreOracle(owner, reporter);
        router = new Router(vault, oracle, owner, keeper);

        executorA = new MockExecutor(usdc, address(vault), true);
        executorB = new MockExecutor(usdc, address(vault), true);

        vm.startPrank(owner);
        vault.setRouter(address(router));
        vault.registerVenue(VENUE_A, DOMAIN_ARC);
        vault.registerVenue(VENUE_B, DOMAIN_BASE);
        router.setExecutor(VENUE_A, executorA);
        router.setExecutor(VENUE_B, executorB);
        vm.stopPrank();

        usdc.mint(alice, 10_000_000 * USDC_ONE);
        usdc.mint(bob, 10_000_000 * USDC_ONE);

        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev Post a score set covering both venues and return venue B's proof.
    function postScores(uint32 scoreBps, uint32 netApyBps)
        internal
        returns (bytes32[] memory proofB)
    {
        // The oracle requires each epoch to strictly advance `asOf`, so a test
        // that posts twice must move the clock between posts.
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 asOf = uint64(vm.getBlockTimestamp());
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = oracle.leafHash(VENUE_A, 1, 1, asOf);
        leaves[1] = oracle.leafHash(VENUE_B, scoreBps, netApyBps, asOf);

        bytes32 root = MerkleLib.root(leaves);
        vm.prank(reporter);
        oracle.postScores(root, asOf, "ipfs://leaves");

        proofB = MerkleLib.proof(leaves, 1);
    }

    /// @dev Post a score set and return the proof for whichever venue the
    ///      caller is about to act on. `postScores` returns VENUE_B's proof,
    ///      which silently produces BadProof when used against VENUE_A.
    function postScoresFor(uint16 venueId, uint32 scoreBps, uint32 netApyBps)
        internal
        returns (bytes32[] memory proof)
    {
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 asOf = uint64(vm.getBlockTimestamp());

        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = oracle.leafHash(VENUE_A, scoreBps, netApyBps, asOf);
        leaves[1] = oracle.leafHash(VENUE_B, scoreBps, netApyBps, asOf);

        vm.prank(reporter);
        oracle.postScores(MerkleLib.root(leaves), asOf, "ipfs://leaves");

        return MerkleLib.proof(leaves, venueId == VENUE_A ? 0 : 1);
    }

    function depositAs(address who, uint256 assets) internal returns (uint256 shares) {
        vm.prank(who);
        shares = vault.deposit(assets, who);
    }
}
