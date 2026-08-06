// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CctpReturnRelay} from "../src/CctpReturnRelay.sol";
import {ITokenMessengerV2} from "../src/executors/CctpBridgeExecutor.sol";

/// @notice The Base Sepolia end of the round trip.
///
///         `WireBaseVenue.s.sol` builds the outbound half on Arc: a
///         `CctpBridgeExecutor` that burns toward domain 6. This is the half
///         that brings capital back, and it has to live here because `exit` on
///         Arc reverts by design — nothing there can reach a position on
///         another chain.
///
///           forge script script/DeployReturnRelay.s.sol \
///             --rpc-url base_sepolia --account spidey-deployer --broadcast
///
///         Then point the Arc-side route at the address this prints:
///
///           cast send $ARC_BRIDGE_EXECUTOR \
///             "setRoute(uint16,uint32,bytes32)" 2 6 $RELAY_AS_BYTES32 \
///             --rpc-url arc --account spidey-deployer
///
///         That last step is what makes the round trip non-custodial. Until
///         the route moves, CCTP keeps minting into the Base `LPVault`, where
///         the capital is unaccounted and only the owner's `rescueUnaccounted`
///         can reach it.
contract DeployReturnRelay is Script {
    /// Verified on-chain before being written down: 4,353 bytes of code at
    /// this address on Base Sepolia, the same `TokenMessengerV2` Arc uses.
    address constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// Arc's CCTP domain, confirmed against the live attestation API — a burn
    /// from Arc reports source domain 26.
    uint32 constant DOMAIN_ARC = 26;

    function run() external {
        address deployer = msg.sender;
        // Where capital goes home to. The Arc `LPVault` books arrivals with
        // `Router.recordBridgeArrival`, which is bounded by
        // `unaccountedBalance()` — so a mint that never happened cannot be
        // claimed, and this address is the one the hub already understands.
        address arcVault = vm.envAddress("ARC_VAULT");
        address keeper = vm.envOr("KEEPER", deployer);

        vm.startBroadcast();

        CctpReturnRelay relay = new CctpReturnRelay(
            ITokenMessengerV2(TOKEN_MESSENGER_V2), IERC20(BASE_SEPOLIA_USDC), deployer, keeper
        );
        relay.setHomeRoute(DOMAIN_ARC, bytes32(uint256(uint160(arcVault))));

        vm.stopBroadcast();

        console2.log("CctpReturnRelay   ", address(relay));
        console2.log("  home            -> Arc domain", DOMAIN_ARC);
        console2.log("  mintRecipient   ", arcVault);
        console2.log("  keeper          ", keeper);
        console2.log("");
        console2.log("As a CCTP mintRecipient, for the Arc-side setRoute:");
        console2.logBytes32(bytes32(uint256(uint160(address(relay)))));
        console2.log("");
        console2.log("USDC here has one exit and it is Arc. The owner can move");
        console2.log("the route; only the keeper can move the money along it.");
    }
}
