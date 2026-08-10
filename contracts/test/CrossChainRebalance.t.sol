// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures, MerkleLib} from "./Fixtures.sol";
import {Router} from "../src/Router.sol";
import {CctpBridgeExecutor, ITokenMessengerV2} from "../src/executors/CctpBridgeExecutor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Records a burn and does nothing else, so the test observes routing
///      rather than CCTP itself.
contract MockTokenMessenger is ITokenMessengerV2 {
    uint256 public burnCount;
    uint32 public lastDomain;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32,
        address,
        bytes32,
        uint256,
        uint32
    ) external {
        burnCount += 1;
        lastDomain = destinationDomain;
        IERC20(msg.sender); // silence unused-parameter noise
        amount;
    }
}

/// @title One position, two remote venues
/// @notice The shipped topology: Arc is the hub, and *both* venues it can
///         reach live on other chains — Base Sepolia over CCTP domain 6, and
///         Solana devnet over domain 5. Neither is Arc-local.
///
///         Every rebalance in that world is remote→remote, and this is the
///         case no existing test covers: `CctpBridge.t.sol` proves `exit`
///         reverts under `returnToVault`, but `Router.rebalance` reaches the
///         same `exit` and nothing pins what happens there.
contract CrossChainRebalanceTest is Fixtures {
    MockTokenMessenger internal messenger;
    CctpBridgeExecutor internal bridge;

    uint16 internal constant VENUE_SOL = 3;
    uint32 internal constant DOMAIN_BASE_CCTP = 6;
    uint32 internal constant DOMAIN_SOLANA_CCTP = 5;

    address internal constant BASE_VAULT = 0x44dBDe83F339D23368abce56Cc1ABA2B257f1B0b;
    /// The `MeteoraReceiver` program's USDC ATA, as a CCTP mint recipient.
    bytes32 internal constant SOLANA_RECEIVER = bytes32(uint256(0xFEED));

    function setUp() public {
        setUpStack();

        messenger = new MockTokenMessenger();
        bridge = new CctpBridgeExecutor(messenger, IERC20(address(usdc)), owner);

        vm.startPrank(owner);
        bridge.setRouter(address(router));
        // One executor serves both remote venues; the route carries the domain.
        bridge.setRoute(VENUE_B, DOMAIN_BASE_CCTP, bytes32(uint256(uint160(BASE_VAULT))));
        bridge.setRoute(VENUE_SOL, DOMAIN_SOLANA_CCTP, SOLANA_RECEIVER);

        vault.registerVenue(VENUE_SOL, uint8(DOMAIN_SOLANA_CCTP));
        router.setExecutor(VENUE_B, bridge);
        router.setExecutor(VENUE_SOL, bridge);
        vm.stopPrank();
    }

    function _bridgeParams() private pure returns (bytes memory) {
        return abi.encode(CctpBridgeExecutor.BridgeParams(1 * USDC_ONE, 2000));
    }

    /// @dev Three venues, so `Fixtures.postScoresFor` (which builds a two-leaf
    ///      tree) cannot serve this. Built here for whichever venue is next.
    function _postThreeVenueScores(uint16 venueId, uint32 scoreBps, uint32 netApyBps)
        private
        returns (bytes32[] memory proof)
    {
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 asOf = uint64(vm.getBlockTimestamp());

        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = oracle.leafHash(VENUE_A, scoreBps, netApyBps, asOf);
        leaves[1] = oracle.leafHash(VENUE_B, scoreBps, netApyBps, asOf);
        leaves[2] = oracle.leafHash(VENUE_SOL, scoreBps, netApyBps, asOf);

        vm.prank(reporter);
        oracle.postScores(MerkleLib.root(leaves), asOf, "ipfs://leaves");

        uint256 index = venueId == VENUE_A ? 0 : (venueId == VENUE_B ? 1 : 2);
        return MerkleLib.proof(leaves, index);
    }

    /// The single position: 10,000 USDC deployed to the Base Sepolia venue.
    function _openTheOnePosition() private {
        depositAs(alice, 10_000 * USDC_ONE);
        bytes32[] memory proof = _postThreeVenueScores(VENUE_B, 5_000, 900);
        vm.prank(keeper);
        router.deployIdle(VENUE_B, 10_000 * USDC_ONE, 900, 5_000, proof, _bridgeParams());
    }

    /// @dev The scenario in one test: the one position sits on Base Sepolia,
    ///      Solana devnet now scores better, and the keeper tries to move it.
    ///
    ///      The move is not merely expensive or ill-advised: it cannot be
    ///      expressed at all. Nothing on Arc can reach into a position on Base
    ///      and pull it back.
    ///
    ///      The Router declines it *itself*, on the executor's own
    ///      `isSynchronous()` answer, rather than letting the call reach
    ///      `CctpBridgeExecutor.exit` and surface that contract's
    ///      `ExitMustBeInitiatedOnDestination`. Same outcome, but the error now
    ///      names the policy — this venue's capital has to come home first —
    ///      instead of a mechanism the keeper did not choose to invoke.
    function test_rebalanceBetweenTwoRemoteVenuesCannotExecute() public {
        _openTheOnePosition();

        // Clear MIN_DWELL, then repost so the scores are inside MAX_SCORE_AGE.
        vm.warp(vm.getBlockTimestamp() + 12 hours + 1);
        bytes32[] memory proof = _postThreeVenueScores(VENUE_SOL, 6_000, 1_400);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(Router.RemoteVenueMustReturnFirst.selector, VENUE_B)
        );
        router.rebalance(
            VENUE_B,
            VENUE_SOL,
            10_000 * USDC_ONE,
            1_400, // to: Solana devnet
            900, // from: Base Sepolia
            2 * USDC_ONE,
            6_000,
            proof,
            "",
            _bridgeParams()
        );
    }

    /// @dev And the books are untouched by the attempt, so the failure is at
    ///      least clean: the position is still on Base, still counted.
    function test_theFailedMoveLeavesThePositionWhereItWas() public {
        _openTheOnePosition();
        vm.warp(vm.getBlockTimestamp() + 12 hours + 1);
        bytes32[] memory proof = _postThreeVenueScores(VENUE_SOL, 6_000, 1_400);

        (uint128 baseBookBefore,,,,,) = vault.venues(VENUE_B);

        vm.prank(keeper);
        try router.rebalance(
            VENUE_B, VENUE_SOL, 10_000 * USDC_ONE, 1_400, 900, 2 * USDC_ONE, 6_000, proof, "", _bridgeParams()
        ) {
            fail();
        } catch {}

        (uint128 baseBookAfter,,,,,) = vault.venues(VENUE_B);
        (uint128 solBook,,,,,) = vault.venues(VENUE_SOL);
        assertEq(baseBookAfter, baseBookBefore, "Base still holds the position");
        assertEq(solBook, 0, "nothing was booked to Solana");
        assertEq(messenger.burnCount(), 1, "only the original deploy burned");
    }

    /// @dev The route that does work, for contrast: capital comes home as a
    ///      CCTP mint and is booked, and only then can it be deployed onward.
    ///      This is the two-step the planner must emit instead of `rebalance`.
    function test_theReturnLegThenRedeployIsTheOnlyPathBetweenRemoteVenues() public {
        _openTheOnePosition();

        // The far side burned back to the Arc vault; the mint lands as
        // unaccounted balance the vault has not yet booked.
        usdc.mint(address(vault), 10_000 * USDC_ONE);

        vm.prank(keeper);
        uint256 booked = router.recordBridgeArrival(VENUE_B, 10_000 * USDC_ONE, false);
        assertEq(booked, 10_000 * USDC_ONE, "the arrival is booked as idle");
        assertFalse(vault.isVenuePending(VENUE_B), "and the in-flight flag clears");

        bytes32[] memory proof = _postThreeVenueScores(VENUE_SOL, 6_000, 1_400);
        vm.prank(keeper);
        router.deployIdle(VENUE_SOL, 10_000 * USDC_ONE, 1_400, 6_000, proof, _bridgeParams());

        assertEq(messenger.lastDomain(), DOMAIN_SOLANA_CCTP, "second burn aimed at Solana");
        assertEq(messenger.burnCount(), 2, "one burn out to Base, one out to Solana");
    }
}
