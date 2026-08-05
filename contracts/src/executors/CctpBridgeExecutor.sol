// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IVenueExecutor} from "../interfaces/IVenueExecutor.sol";

/// @notice CCTP v2 `TokenMessengerV2`, as deployed on Arc.
/// @dev Signature confirmed against the live contract: calling it with no
///      allowance reverts `ERC20: transfer amount exceeds allowance`, which
///      means the selector is handled and execution reached the token pull.
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

/// @title CctpBridgeExecutor
/// @notice The Arc-side executor for a venue that lives on another chain.
///
///         This is what "wire the Base Sepolia venue on Arc" actually
///         requires. `Router.rebalance` reaches an executor with a direct
///         contract call, and a direct call cannot cross a chain — so a
///         remote venue needs a local executor that starts a bridge and
///         returns, with the far side completing later.
///
///         `IVenueExecutor.isSynchronous()` exists for exactly this
///         distinction and had no implementation returning false until now.
///
/// # The asymmetry is real and is not hidden
///
/// `enter` works: it burns USDC on Arc and Circle's attesters mint it at the
/// destination. `exit` cannot work the same way — nothing on Arc can reach
/// into a position on Base Sepolia and pull it back. The return leg has to be
/// initiated on the destination chain.
///
/// So `exit` reverts with a named error rather than returning zero. Returning
/// zero would let `Router.returnToVault` succeed while no capital moved,
/// which reads as "the exit worked" and is the more dangerous lie.
contract CctpBridgeExecutor is IVenueExecutor {
    using SafeERC20 for IERC20;

    error NotRouter();
    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownVenue(uint16 venueId);
    error InsufficientBalance(uint256 requested, uint256 available);
    error FeeExceedsAmount(uint256 maxFee, uint256 amount);
    error ExitMustBeInitiatedOnDestination(uint16 venueId);

    event BridgeInitiated(
        uint16 indexed venueId,
        uint32 indexed destinationDomain,
        bytes32 mintRecipient,
        uint256 amount,
        uint256 maxFee
    );
    event VenueRouteSet(uint16 indexed venueId, uint32 destinationDomain, bytes32 mintRecipient);

    /// @notice Where a venue's capital is sent, and to whom.
    struct Route {
        /// CCTP domain of the destination chain. Base is 6.
        uint32 destinationDomain;
        /// Destination address, left-padded to 32 bytes. Non-zero means set.
        bytes32 mintRecipient;
    }

    /// @notice Parameters the scoring engine supplies per bridge.
    /// @dev §9.2: "Pass computed values in, verify cheaply." Fee and finality
    ///      are a cost/latency trade-off the engine already models in §7.5's
    ///      payback rule, so it decides them and this contract bounds them.
    struct BridgeParams {
        /// Cap on the CCTP fee, in USDC base units.
        uint256 maxFee;
        /// 1000 for fast transfer, 2000 for standard. Standard is cheaper and
        /// slower; the payback rule already prices the wait.
        uint32 minFinalityThreshold;
    }

    ITokenMessengerV2 public immutable tokenMessenger;
    IERC20 public immutable usdc;

    address public router;
    address public owner;

    mapping(uint16 venueId => Route) public routes;

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(ITokenMessengerV2 tokenMessenger_, IERC20 usdc_, address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        tokenMessenger = tokenMessenger_;
        usdc = usdc_;
        owner = owner_;
    }

    /// @notice Capital does NOT arrive in the same transaction.
    /// @dev The Router must not assume `enter` completed a deployment. It
    ///      completes a *burn*; the mint happens once Circle's attesters sign,
    ///      typically seconds to minutes later.
    function isSynchronous() external pure override returns (bool) {
        return false;
    }

    /// @notice Burn USDC on Arc so it mints at the venue's destination chain.
    function enter(uint16 venueId, uint256 assets, bytes calldata data)
        external
        override
        onlyRouter
    {
        if (assets == 0) revert ZeroAmount();

        Route memory route = routes[venueId];
        if (route.mintRecipient == bytes32(0)) revert UnknownVenue(venueId);

        uint256 balance = usdc.balanceOf(address(this));
        if (balance < assets) revert InsufficientBalance(assets, balance);

        BridgeParams memory p = abi.decode(data, (BridgeParams));
        // A fee cap at or above the amount would let the whole transfer be
        // consumed by fees and still count as a successful deployment.
        if (p.maxFee >= assets) revert FeeExceedsAmount(p.maxFee, assets);

        usdc.forceApprove(address(tokenMessenger), assets);
        tokenMessenger.depositForBurn(
            assets,
            route.destinationDomain,
            route.mintRecipient,
            address(usdc),
            // Empty destinationCaller: anyone may relay the attestation. §3
            // lists the CCTP relayer as permissionless — "cannot alter
            // message; can only decline to submit" — so pinning a caller adds
            // a liveness dependency without adding safety.
            bytes32(0),
            p.maxFee,
            p.minFinalityThreshold
        );

        emit BridgeInitiated(venueId, route.destinationDomain, route.mintRecipient, assets, p.maxFee);
    }

    /// @notice Always reverts. The return leg starts on the destination chain.
    /// @dev Nothing on Arc can reach into a position on another chain. A
    ///      keeper unwinds there, bridges back, and records the arrival with
    ///      `Router.returnToVault` against a local venue once the funds land.
    function exit(uint16 venueId, uint256, bytes calldata)
        external
        view
        override
        onlyRouter
        returns (uint256)
    {
        revert ExitMustBeInitiatedOnDestination(venueId);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @notice Point a venue at a destination chain and recipient.
    /// @param mintRecipient The destination address, left-padded to 32 bytes.
    ///        `bytes32(uint256(uint160(addr)))` for an EVM address.
    function setRoute(uint16 venueId, uint32 destinationDomain, bytes32 mintRecipient)
        external
        onlyOwner
    {
        if (mintRecipient == bytes32(0)) revert ZeroAddress();
        routes[venueId] = Route(destinationDomain, mintRecipient);
        emit VenueRouteSet(venueId, destinationDomain, mintRecipient);
    }

    function setRouter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        router = next;
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
    }

    /// @notice Recover a token sent here by mistake.
    function sweep(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    /// @notice Helper for building a `mintRecipient` from an EVM address.
    function toBytes32(address a) external pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
