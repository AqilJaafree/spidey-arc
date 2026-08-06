// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CctpReturnRelay} from "../src/CctpReturnRelay.sol";
import {ITokenMessengerV2} from "../src/executors/CctpBridgeExecutor.sol";

/// @title CctpReturnRelay against the real TokenMessengerV2
/// @notice The unit tests drive a recording messenger, which proves the relay's
///         own logic and nothing about Circle's. A mock cannot disagree with
///         the deployed ABI — it *is* the assumption under test.
///
///         This burns real Base Sepolia USDC through the live
///         `TokenMessengerV2` on a fork: the selector, the argument order, the
///         token pull through `forceApprove`, and whether domain 26 is a
///         destination that contract will accept at all.
///
///         | Contract          | Address                                    |
///         |-------------------|--------------------------------------------|
///         | TokenMessengerV2  | 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA |
///         | USDC              | 0x036CbD53842c5426634e7929541eC2318f3dCF7e |
///
///         Skipped — loudly, per §6.1 — when BASE_SEPOLIA_RPC_URL is unset.
contract CctpReturnRelayForkTest is Test {
    address constant TOKEN_MESSENGER_V2 = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// Arc's CCTP domain, and the Arc `LPVault` capital returns to.
    uint32 constant DOMAIN_ARC = 26;
    address constant ARC_VAULT = 0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f;

    CctpReturnRelay internal relay;
    address internal owner = address(0xA11CE);
    address internal keeper = address(0xDEAD);

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;

        relay = new CctpReturnRelay(
            ITokenMessengerV2(TOKEN_MESSENGER_V2), IERC20(USDC), owner, keeper
        );
        vm.prank(owner);
        relay.setHomeRoute(DOMAIN_ARC, bytes32(uint256(uint160(ARC_VAULT))));
    }

    modifier onlyForked() {
        if (!forked) vm.skip(true, "BASE_SEPOLIA_RPC_URL unset - fork test did not run");
        _;
    }

    function test_fork_environmentIsWhatWeThinkItIs() public onlyForked {
        assertEq(block.chainid, 84532, "not Base Sepolia");
        assertGt(TOKEN_MESSENGER_V2.code.length, 0, "TokenMessengerV2 has no code");
        assertGt(USDC.code.length, 0, "USDC has no code");
    }

    /// @dev The one that matters: a real burn, through the real contract,
    ///      aimed at Arc. If the ABI in `ITokenMessengerV2` were wrong, or
    ///      domain 26 were not a destination Circle accepts from Base Sepolia,
    ///      this is where it shows.
    function test_fork_burnsRealUsdcTowardArc() public onlyForked {
        uint256 amount = 100e6; // $100 USDC
        deal(USDC, address(relay), amount);
        assertEq(relay.pendingReturn(), amount, "funded");

        uint256 supplyBefore = IERC20(USDC).totalSupply();

        vm.prank(keeper);
        uint256 burned = relay.returnHome(amount, 1e6, 2000);

        assertEq(burned, amount, "reported the full amount");
        assertEq(relay.pendingReturn(), 0, "the relay kept nothing");
        assertEq(
            IERC20(USDC).totalSupply(), supplyBefore - amount, "USDC was burned, not transferred"
        );

        console2.log("burned toward Arc (domain 26), USDC:", amount);
        console2.log("supply delta:", supplyBefore - IERC20(USDC).totalSupply());
    }

    /// @dev A partial return against the live contract too — the keeper should
    ///      be able to send a dollar before sending a million.
    function test_fork_partialReturnLeavesTheRest() public onlyForked {
        deal(USDC, address(relay), 100e6);

        vm.prank(keeper);
        relay.returnHome(1e6, 0, 2000);

        assertEq(relay.pendingReturn(), 99e6, "the rest waits for the next call");
    }
}
