// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LPVault} from "../src/LPVault.sol";
import {Router} from "../src/Router.sol";
import {CctpBridgeExecutor, ITokenMessengerV2} from "../src/executors/CctpBridgeExecutor.sol";

/// @notice Wire the Base Sepolia venue on Arc.
///
///         Registering a venue alone would leave `deployIdle` reverting
///         `NoExecutor`. What makes the venue real is a local executor that
///         can actually reach the destination — here a CCTP burn, since a
///         direct contract call cannot cross a chain.
///
/// # Where the burn mints
///
/// The route's mintRecipient is the **`CctpReturnRelay`** on Base, not the
/// Base `LPVault`. That is the whole point of the relay: capital Arc sends out
/// lands somewhere whose only exit is back to Arc, under the keeper, with no
/// owner discretion over the destination. Minting into the Base vault instead
/// would leave it unaccounted there, recoverable only by the owner's
/// `rescueUnaccounted` — the custody the relay exists to remove.
contract WireBaseVenue is Script {
    address constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    /// Base's CCTP domain, and the Base Sepolia recipient capital mints into.
    uint32 constant DOMAIN_BASE = 6;
    uint8 constant CHAIN_DOMAIN_BASE = 6;
    uint16 constant VENUE_BASE_UNIV3 = 2;

    function run() external {
        address deployer = msg.sender;
        LPVault vault = LPVault(vm.envAddress("ARC_VAULT"));
        Router router = Router(vm.envAddress("ARC_ROUTER"));
        // The CctpReturnRelay on Base — the address `DeployReturnRelay` printed.
        address relay = vm.envAddress("BASE_RELAY");

        vm.startBroadcast();

        CctpBridgeExecutor bridge =
            new CctpBridgeExecutor(ITokenMessengerV2(TOKEN_MESSENGER_V2), IERC20(ARC_USDC), deployer);
        bridge.setRouter(address(router));
        bridge.setRoute(VENUE_BASE_UNIV3, DOMAIN_BASE, bytes32(uint256(uint160(relay))));

        vault.registerVenue(VENUE_BASE_UNIV3, CHAIN_DOMAIN_BASE);
        router.setExecutor(VENUE_BASE_UNIV3, bridge);

        vm.stopBroadcast();

        console2.log("CctpBridgeExecutor", address(bridge));
        console2.log("venue", VENUE_BASE_UNIV3, "-> Base relay", relay);
        console2.log("");
        console2.log("Arc bridges INTO the Base relay, which can only send home.");
        console2.log("The return leg is initiated on Base: exit() here reverts.");
    }
}
