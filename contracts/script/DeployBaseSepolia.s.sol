// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LPVault} from "../src/LPVault.sol";
import {Router} from "../src/Router.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";
import {
    UniV3Executor,
    ISwapRouter02,
    INonfungiblePositionManager
} from "../src/executors/UniV3Executor.sol";

/// @notice A complete, self-contained stack on Base Sepolia.
///
///         Arc is the hub, but `Router.rebalance` reaches an executor with a
///         direct contract call — which cannot cross a chain. So the Arc
///         Router can never drive `UniV3Executor` on Base Sepolia, and the
///         cross-chain leg needs an async executor that does not exist yet.
///
///         This deploys the whole stack *locally* instead, so the routing
///         logic can be exercised end to end against a real Uniswap v3 pool:
///         deposit → score → deploy → live position → exit. That makes §12
///         step 4 — "show the router declining a move that fails the payback
///         test, then accepting one that clears it" — performable today,
///         without CCTP, App Kit credentials, or the async executor.
///
///           forge script script/DeployBaseSepolia.s.sol \
///             --rpc-url base_sepolia --account spidey-deployer --broadcast
contract DeployBaseSepolia is Script {
    // Verified on-chain before being written down.
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant SWAP_ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address constant POSITION_MANAGER = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    uint24 constant POOL_FEE = 3000; // the 0.3% pool, deepest on this testnet

    /// @dev Base's CCTP domain, for when the async leg exists.
    uint8 constant DOMAIN_BASE = 6;
    uint16 constant VENUE_UNIV3 = 1;

    function run() external {
        address deployer = msg.sender;

        vm.startBroadcast();

        LPVault vault = new LPVault(IERC20(USDC), deployer, deployer, deployer);
        ScoreOracle oracle = new ScoreOracle(deployer, deployer);
        Router router = new Router(vault, oracle, deployer, deployer);

        UniV3Executor executor = new UniV3Executor(
            ISwapRouter02(SWAP_ROUTER),
            INonfungiblePositionManager(POSITION_MANAGER),
            IERC20(USDC),
            IERC20(WETH),
            POOL_FEE,
            deployer
        );

        // Wire it up completely — the Arc deployment was left with zero
        // venues and zero executors, which made it inoperable in a way that
        // only showed when someone tried to use it.
        vault.setRouter(address(router));
        vault.registerVenue(VENUE_UNIV3, DOMAIN_BASE);
        vault.setCaps({depositCapAssets: 10_000e6, perVenueCapAssets: 5_000e6});

        router.setExecutor(VENUE_UNIV3, executor);
        executor.setRouter(address(router));
        executor.setVault(address(vault));

        vm.stopBroadcast();

        console2.log("chainId       ", block.chainid);
        console2.log("deployer      ", deployer);
        console2.log("USDC          ", USDC);
        console2.log("LPVault       ", address(vault));
        console2.log("ScoreOracle   ", address(oracle));
        console2.log("Router        ", address(router));
        console2.log("UniV3Executor ", address(executor));
        console2.log("");
        console2.log("venue 1 registered, executor wired, caps 10k/5k USDC.");
    }
}
