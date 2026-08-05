// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LPVault} from "../src/LPVault.sol";
import {Router} from "../src/Router.sol";
import {ScoreOracle} from "../src/ScoreOracle.sol";

/// @notice Deploys the Arc hub: LPVault + ScoreOracle + Router (§11 Day 2.4).
///
///   forge script script/Deploy.s.sol \
///     --rpc-url arc_testnet --account spidey-deployer --broadcast
///
/// Signing comes from the CLI — an encrypted keystore via `--account`, or
/// `--private-key` — so no key material is read from the environment here.
///
/// Required environment:
///   ARC_RPC_URL      https://rpc.testnet.arc.network  (chain 5042002)
///   USDC_ADDRESS     the USDC ERC-20 on Arc testnet
///
/// Optional (each defaults to the deployer):
///   REPORTER_ADDRESS OPERATOR_ADDRESS KEEPER_ADDRESS
///
/// Note the §7.7 split this deployment lives on top of: USDC is 6 decimals
/// through the ERC-20 interface but Arc's native gas is 18 decimals. Verified
/// empirically against live Arc testnet — a real transfer of 1e17 base units
/// reads as 0.1 USDC, and a 48,950-gas fee as $0.00137.
contract Deploy is Script {
    function run() external {
        // `--account` / `--private-key` on the CLI decides the sender, so the
        // deployer is whoever forge is broadcasting as.
        address deployer = msg.sender;
        IERC20 usdc = IERC20(vm.envAddress("USDC_ADDRESS"));

        address reporter = vm.envOr("REPORTER_ADDRESS", deployer);
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);

        vm.startBroadcast();

        LPVault vault = new LPVault(usdc, deployer, reporter, operator);
        ScoreOracle oracle = new ScoreOracle(deployer, reporter);
        Router router = new Router(vault, oracle, deployer, keeper);

        vault.setRouter(address(router));

        // Start conservative. §5.1: the caps exist so "the vault itself does
        // not become the dilution problem it is designed to detect."
        vault.setCaps({depositCapAssets: 100_000e6, perVenueCapAssets: 25_000e6});

        vm.stopBroadcast();

        // Deliberately NO venue is registered here.
        //
        // A venue with no executor behind it makes the vault look configured
        // while `deployIdle` reverts `NoExecutor` — the worst of both, and how
        // the previous Arc deployment ended up appearing operable when it was
        // not. Arc has no local venue and the cross-chain executor does not
        // exist yet, so there is nothing honest to register.
        //
        // What DOES work on Arc today is the custody cycle: deposit, request,
        // settle, claim. That needs no venue at all.

        console2.log("chainId       ", block.chainid);
        console2.log("deployer      ", deployer);
        console2.log("USDC          ", address(usdc));
        console2.log("LPVault       ", address(vault));
        console2.log("ScoreOracle   ", address(oracle));
        console2.log("Router        ", address(router));
        console2.log("");
        console2.log("WORKS NOW  : deposit / requestWithdraw / settleEpoch / claimWithdraw");
        console2.log("NOT WIRED  : no venue, no executor -> deployIdle reverts NoExecutor");
        console2.log("             Arc has no local venue, and the cross-chain executor");
        console2.log("             does not exist yet. Register a venue only once an");
        console2.log("             executor can actually be reached.");
    }
}
