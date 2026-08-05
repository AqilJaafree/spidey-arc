// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {LPVault} from "../src/LPVault.sol";
import {Router} from "../src/Router.sol";
import {CctpBridgeExecutor, ITokenMessengerV2} from "../src/executors/CctpBridgeExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Stands in for CCTP's `TokenMessengerV2`. A real burn pulls the tokens
///      and destroys them; what matters for these tests is that the tokens
///      genuinely leave the executor and the call arguments are what we think.
contract MockTokenMessenger is ITokenMessengerV2 {
    uint256 public lastAmount;
    uint32 public lastDomain;
    bytes32 public lastRecipient;
    uint256 public lastMaxFee;
    uint32 public lastFinality;
    uint256 public burnCount;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external override {
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        lastAmount = amount;
        lastDomain = destinationDomain;
        lastRecipient = mintRecipient;
        lastMaxFee = maxFee;
        lastFinality = minFinalityThreshold;
        burnCount += 1;
    }
}

/// @title The Arc-side leg of a remote venue
/// @notice `Router.rebalance` reaches an executor with a direct contract call,
///         and a direct call cannot cross a chain. A venue on another chain
///         therefore needs a local executor that starts a bridge and returns,
///         with the far side completing later — which is what
///         `CctpBridgeExecutor` is, and what `isSynchronous()` was declared
///         for long before anything returned false.
contract CctpBridgeTest is Fixtures {
    MockTokenMessenger internal messenger;
    CctpBridgeExecutor internal bridge;

    /// Base's CCTP domain.
    uint32 constant DOMAIN_BASE_CCTP = 6;
    address constant REMOTE_VAULT = 0x44dBDe83F339D23368abce56Cc1ABA2B257f1B0b;

    function setUp() public {
        setUpStack();

        messenger = new MockTokenMessenger();
        bridge = new CctpBridgeExecutor(messenger, IERC20(address(usdc)), owner);

        vm.startPrank(owner);
        bridge.setRouter(address(router));
        bridge.setRoute(VENUE_B, DOMAIN_BASE_CCTP, bytes32(uint256(uint160(REMOTE_VAULT))));
        router.setExecutor(VENUE_B, bridge);
        vm.stopPrank();
    }

    function _bridgeParams(uint256 maxFee, uint32 finality) private pure returns (bytes memory) {
        return abi.encode(CctpBridgeExecutor.BridgeParams(maxFee, finality));
    }

    function _deployToBase(uint256 amount, bytes memory data) private {
        bytes32[] memory proof = postScoresFor(VENUE_B, 5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, amount, 900, 5_000, proof, data);
    }

    function test_capitalIsBurnedTowardTheRemoteVenue() public {
        depositAs(alice, 10_000 * USDC_ONE);
        _deployToBase(10_000 * USDC_ONE, _bridgeParams(1 * USDC_ONE, 2000));

        assertEq(messenger.burnCount(), 1, "a burn happened");
        assertEq(messenger.lastAmount(), 10_000 * USDC_ONE, "the whole amount");
        assertEq(messenger.lastDomain(), DOMAIN_BASE_CCTP, "aimed at Base");
        assertEq(
            messenger.lastRecipient(),
            bytes32(uint256(uint160(REMOTE_VAULT))),
            "to the remote vault"
        );
        assertEq(usdc.balanceOf(address(bridge)), 0, "nothing left behind on Arc");
    }

    /// @dev The state that only exists for an async leg: capital burned here,
    ///      not yet minted there, claimable nowhere.
    function test_inFlightCapitalIsVisibleOnChain() public {
        depositAs(alice, 10_000 * USDC_ONE);
        assertFalse(vault.isVenuePending(VENUE_B), "nothing in flight yet");

        _deployToBase(10_000 * USDC_ONE, _bridgeParams(1 * USDC_ONE, 2000));

        assertTrue(vault.isVenuePending(VENUE_B), "venue marked in flight");
        assertEq(vault.deployedAssets(), 10_000 * USDC_ONE, "still counted as deployed");

        vm.prank(keeper);
        router.confirmArrival(VENUE_B);
        assertFalse(vault.isVenuePending(VENUE_B), "cleared once it lands");
    }

    /// @dev A synchronous venue must never be flagged in flight.
    function test_synchronousVenueIsNeverFlagged() public {
        depositAs(alice, 1_000 * USDC_ONE);
        bytes32[] memory proof = postScoresFor(VENUE_A, 5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_A, 1_000 * USDC_ONE, 900, 5_000, proof, "");
        assertFalse(vault.isVenuePending(VENUE_A), "local venue is never in flight");
    }

    /// @dev The asymmetry, stated rather than hidden. Nothing on Arc can reach
    ///      into a position on Base and pull it back.
    function test_exitRevertsRatherThanSilentlyReturningNothing() public {
        depositAs(alice, 10_000 * USDC_ONE);
        _deployToBase(10_000 * USDC_ONE, _bridgeParams(1 * USDC_ONE, 2000));

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                CctpBridgeExecutor.ExitMustBeInitiatedOnDestination.selector, VENUE_B
            )
        );
        router.returnToVault(VENUE_B, 10_000 * USDC_ONE, "", true);
    }

    /// @dev Had `exit` returned 0 instead, `returnToVault` would have
    ///      succeeded while no capital moved — the more dangerous failure,
    ///      because it reads as a completed exit.
    function test_aFailedExitLeavesTheBooksUntouched() public {
        depositAs(alice, 10_000 * USDC_ONE);
        _deployToBase(10_000 * USDC_ONE, _bridgeParams(1 * USDC_ONE, 2000));

        (uint128 bookBefore,,,,,) = vault.venues(VENUE_B);
        vm.prank(keeper);
        try router.returnToVault(VENUE_B, 10_000 * USDC_ONE, "", true) {
            fail();
        } catch {}

        (uint128 bookAfter,,,,,) = vault.venues(VENUE_B);
        assertEq(bookAfter, bookBefore, "book unchanged by a failed exit");
        assertEq(vault.idleAssets(), 0, "and nothing was credited as returned");
    }

    function test_rejectsAFeeCapThatCouldEatTheWholeTransfer() public {
        depositAs(alice, 1_000 * USDC_ONE);
        bytes32[] memory proof = postScoresFor(VENUE_B, 5_000, 900);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                CctpBridgeExecutor.FeeExceedsAmount.selector, 1_000 * USDC_ONE, 1_000 * USDC_ONE
            )
        );
        router.deployIdle(
            VENUE_B, 1_000 * USDC_ONE, 900, 5_000, proof, _bridgeParams(1_000 * USDC_ONE, 2000)
        );
    }

    function test_rejectsAVenueWithNoRoute() public {
        vm.prank(owner);
        router.setExecutor(VENUE_A, bridge); // no route configured for A

        depositAs(alice, 1_000 * USDC_ONE);
        bytes32[] memory proof = postScoresFor(VENUE_A, 5_000, 900);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(CctpBridgeExecutor.UnknownVenue.selector, VENUE_A)
        );
        router.deployIdle(VENUE_A, 1_000 * USDC_ONE, 900, 5_000, proof, _bridgeParams(1e6, 2000));
    }

    function test_onlyRouterMayBridge() public {
        depositAs(alice, 1_000 * USDC_ONE);
        vm.prank(alice);
        vm.expectRevert(CctpBridgeExecutor.NotRouter.selector);
        bridge.enter(VENUE_B, 1_000 * USDC_ONE, _bridgeParams(1e6, 2000));
    }

    function test_declaresItselfAsynchronous() public view {
        assertFalse(bridge.isSynchronous(), "a bridge cannot settle in one transaction");
    }

    /// @dev The engine chooses the cost/latency trade-off; the contract only
    ///      bounds it. 1000 is fast and dearer, 2000 standard and cheaper.
    function test_finalityAndFeeArePassedThroughAsGiven() public {
        depositAs(alice, 10_000 * USDC_ONE);
        _deployToBase(10_000 * USDC_ONE, _bridgeParams(25 * USDC_ONE, 1000));
        assertEq(messenger.lastMaxFee(), 25 * USDC_ONE, "fee cap forwarded");
        assertEq(messenger.lastFinality(), 1000, "fast finality forwarded");
    }
}
