// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CctpReturnRelay} from "../src/CctpReturnRelay.sol";
import {ITokenMessengerV2} from "../src/executors/CctpBridgeExecutor.sol";
import {MockUSDC} from "./Fixtures.sol";

/// @dev Records every field of the burn, so the tests can assert *where* the
///      capital went and not merely that something was burned.
contract RecordingMessenger is ITokenMessengerV2 {
    uint256 public burnCount;
    uint256 public lastAmount;
    uint32 public lastDomain;
    bytes32 public lastRecipient;
    address public lastBurnToken;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    uint32 public lastFinality;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        burnCount += 1;
        lastAmount = amount;
        lastDomain = destinationDomain;
        lastRecipient = mintRecipient;
        lastBurnToken = burnToken;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastFinality = minFinalityThreshold;
        // Pull the tokens as the real `TokenMessengerV2` does, so the relay's
        // approval is exercised rather than assumed. Without this the tests
        // would pass against a relay that never approved anything.
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
    }
}

contract StrayToken is ERC20 {
    constructor() ERC20("Stray", "STRAY") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title CctpReturnRelay — the Base-side return leg
/// @notice §7.1 of `docs/cross-chain-review.md`: "No bridge executor on Base.
///         Biggest structural gap. Until Base has its own `CctpBridgeExecutor`
///         pointed at Arc, the return leg keeps the owner in the money path."
///
///         Arc pushes capital out in one transaction and cannot pull it back —
///         every return has to be initiated on the far side. On Base that
///         return was a *procedure*: the owner ran `rescueUnaccounted(to)` with
///         a destination of their choosing and the keeper bridged home with App
///         Kit. Two things were wrong with it.
///
///         First, `to` is arbitrary, so the owner had discretion over where the
///         hub's capital went. Second, `rescueUnaccounted` is gated
///         `onlyWhenNothingDeployed` — so while the Base stack held a position
///         of its own, Arc's capital could not come home at all.
///
///         This contract removes both. The destination is pinned by the owner
///         once and the keeper only chooses *when* and *how much*. USDC that
///         lands here has exactly one exit, and it is Arc.
contract CctpReturnRelayTest is Test {
    MockUSDC internal usdc;
    RecordingMessenger internal messenger;
    CctpReturnRelay internal relay;

    address internal owner = address(0xA11CE);
    address internal keeper = address(0xDEAD);
    address internal stranger = address(0xBAD);

    /// Arc's CCTP domain, verified against the live attestation API.
    uint32 internal constant DOMAIN_ARC = 26;
    /// The Arc `LPVault`, as a CCTP mint recipient.
    address internal constant ARC_VAULT = 0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f;

    uint256 internal constant USDC_ONE = 1e6;

    function _arcVault() private pure returns (bytes32) {
        return bytes32(uint256(uint160(ARC_VAULT)));
    }

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new RecordingMessenger();
        relay = new CctpReturnRelay(messenger, IERC20(address(usdc)), owner, keeper);

        vm.prank(owner);
        relay.setHomeRoute(DOMAIN_ARC, _arcVault());
    }

    /// @dev The whole point: capital that arrived on Base goes home, and the
    ///      keeper never names the destination.
    function test_theKeeperSendsCapitalHomeWithoutChoosingWhereHomeIs() public {
        usdc.mint(address(relay), 10_000 * USDC_ONE);
        assertEq(relay.pendingReturn(), 10_000 * USDC_ONE, "everything here is Arc's");

        vm.prank(keeper);
        uint256 burned = relay.returnHome(10_000 * USDC_ONE, 1 * USDC_ONE, 2000);

        assertEq(burned, 10_000 * USDC_ONE, "the full amount burned");
        assertEq(messenger.burnCount(), 1, "exactly one burn");
        assertEq(messenger.lastDomain(), DOMAIN_ARC, "aimed at Arc");
        assertEq(messenger.lastRecipient(), _arcVault(), "and at the Arc vault");
        assertEq(messenger.lastBurnToken(), address(usdc), "burning USDC");
        assertEq(messenger.lastMaxFee(), 1 * USDC_ONE, "the keeper's fee cap");
        assertEq(messenger.lastFinality(), 2000, "and its finality choice");
        assertEq(relay.pendingReturn(), 0, "nothing left behind");
    }

    /// @dev Anyone may relay the attestation — §3 lists the CCTP relayer as
    ///      permissionless, "cannot alter message; can only decline to submit",
    ///      so pinning a caller buys a liveness dependency and no safety.
    function test_theBurnDoesNotPinWhoMayRelayIt() public {
        usdc.mint(address(relay), 100 * USDC_ONE);
        vm.prank(keeper);
        relay.returnHome(100 * USDC_ONE, 0, 2000);
        assertEq(messenger.burnCount(), 1, "a burn actually happened");
        assertEq(messenger.lastDestinationCaller(), bytes32(0), "open to any relayer");
    }

    /// @dev A partial return is legitimate — CCTP has per-transfer limits and a
    ///      keeper may want to test the path with a small amount first.
    function test_aPartialReturnLeavesTheRestForNextTime() public {
        usdc.mint(address(relay), 1_000 * USDC_ONE);

        vm.prank(keeper);
        relay.returnHome(250 * USDC_ONE, 0, 2000);

        assertEq(messenger.lastAmount(), 250 * USDC_ONE, "only what was asked");
        assertEq(relay.pendingReturn(), 750 * USDC_ONE, "the rest waits here");
    }

    function test_onlyTheKeeperMayInitiateTheReturn() public {
        usdc.mint(address(relay), 100 * USDC_ONE);

        vm.prank(stranger);
        vm.expectRevert(CctpReturnRelay.NotKeeper.selector);
        relay.returnHome(100 * USDC_ONE, 0, 2000);

        // Not even the owner. The owner's authority is over the route, not the
        // money — that separation is the reason this contract exists.
        vm.prank(owner);
        vm.expectRevert(CctpReturnRelay.NotKeeper.selector);
        relay.returnHome(100 * USDC_ONE, 0, 2000);
    }

    /// @dev The property that removes the owner from the money path: there is
    ///      no code path that sends USDC anywhere except Arc.
    function test_theOwnerCannotRedirectUsdcOutOfTheRelay() public {
        usdc.mint(address(relay), 100 * USDC_ONE);

        vm.prank(owner);
        vm.expectRevert(CctpReturnRelay.CannotSweepBridgeAsset.selector);
        relay.sweep(IERC20(address(usdc)), owner, 100 * USDC_ONE);

        assertEq(relay.pendingReturn(), 100 * USDC_ONE, "still headed home");
    }

    /// @dev But a token sent here by mistake is not trapped. `sweep` exists for
    ///      exactly the case `rescueUnaccounted` was built for on the vault.
    function test_aStrayTokenIsStillRecoverable() public {
        StrayToken stray = new StrayToken();
        stray.mint(address(relay), 5 ether);

        vm.prank(owner);
        relay.sweep(IERC20(address(stray)), owner, 5 ether);
        assertEq(stray.balanceOf(owner), 5 ether, "recovered");
    }

    /// @dev Burning before the route is pinned would send USDC to `bytes32(0)`
    ///      on domain 0 — Ethereum — and it would be unrecoverable.
    function test_noBurnBeforeTheRouteIsPinned() public {
        CctpReturnRelay fresh =
            new CctpReturnRelay(messenger, IERC20(address(usdc)), owner, keeper);
        usdc.mint(address(fresh), 100 * USDC_ONE);

        vm.prank(keeper);
        vm.expectRevert(CctpReturnRelay.DestinationNotSet.selector);
        fresh.returnHome(100 * USDC_ONE, 0, 2000);
    }

    function test_cannotReturnMoreThanArrived() public {
        usdc.mint(address(relay), 100 * USDC_ONE);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                CctpReturnRelay.InsufficientBalance.selector, 101 * USDC_ONE, 100 * USDC_ONE
            )
        );
        relay.returnHome(101 * USDC_ONE, 0, 2000);
    }

    /// @dev A fee cap at or above the amount lets the entire transfer be eaten
    ///      by fees and still look like a successful return — the same bound
    ///      `CctpBridgeExecutor.enter` applies on the way out.
    function test_theFeeCapMustLeaveSomethingToArrive() public {
        usdc.mint(address(relay), 100 * USDC_ONE);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                CctpReturnRelay.FeeExceedsAmount.selector, 100 * USDC_ONE, 100 * USDC_ONE
            )
        );
        relay.returnHome(100 * USDC_ONE, 100 * USDC_ONE, 2000);
    }

    function test_onlyTheOwnerMayMoveTheDestination() public {
        vm.prank(stranger);
        vm.expectRevert(CctpReturnRelay.NotOwner.selector);
        relay.setHomeRoute(6, bytes32(uint256(0xBEEF)));

        vm.prank(keeper);
        vm.expectRevert(CctpReturnRelay.NotOwner.selector);
        relay.setHomeRoute(6, bytes32(uint256(0xBEEF)));
    }

    function test_theRouteCannotBePinnedToNowhere() public {
        vm.prank(owner);
        vm.expectRevert(CctpReturnRelay.ZeroAddress.selector);
        relay.setHomeRoute(DOMAIN_ARC, bytes32(0));
    }

    function test_zeroIsNotAReturn() public {
        vm.prank(keeper);
        vm.expectRevert(CctpReturnRelay.ZeroAmount.selector);
        relay.returnHome(0, 0, 2000);
    }
}
