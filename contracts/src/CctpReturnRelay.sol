// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ITokenMessengerV2} from "./executors/CctpBridgeExecutor.sol";

/// @title CctpReturnRelay
/// @notice The far-side half of a round trip that Arc can only start.
///
///         `CctpBridgeExecutor` sends capital out of the hub in one
///         transaction and its `exit` reverts by design: nothing on Arc can
///         reach into a position on another chain and pull it back. Every
///         return has to be initiated where the capital actually is. This is
///         that initiator, deployed on the destination chain.
///
/// # What it replaces
///
/// The return leg used to be a procedure rather than a contract. USDC minted
/// by CCTP landed in the destination `LPVault` as *unaccounted* balance — real
/// tokens the vault deliberately excludes from equity, since crediting them
/// would hand the hub's capital to that chain's own depositors. Getting them
/// home meant `rescueUnaccounted(to)` under the owner's key, then a manual
/// bridge with App Kit.
///
/// Two things were wrong with that, and both are structural rather than
/// operational:
///
///   1. `to` is an arbitrary address. The owner had discretion over where the
///      hub's capital went, every single time it came home.
///   2. `rescueUnaccounted` is gated `onlyWhenNothingDeployed` — a guard that
///      is right for its own purpose (an unaccounted balance is ambiguous
///      while an executor might be mid-return) and wrong for this one. It
///      means the hub's capital cannot come home at all while the local stack
///      happens to hold a position of its own.
///
/// # The property
///
/// **USDC that reaches this contract has exactly one exit, and it is the
/// pinned route.** The owner sets that route and can move it; the owner cannot
/// spend along it. The keeper spends along it and cannot move it. `sweep`
/// refuses the bridge asset outright, so there is no owner path to the tokens
/// at all — not an unlikely one, none.
///
/// That split is the whole design. Separating "where" from "when" is what
/// takes the owner out of the money path without inventing a governance
/// process for a testnet.
///
/// # Deployment
///
/// Point the Arc-side `CctpBridgeExecutor.setRoute` mintRecipient at this
/// contract rather than at the destination vault, and the arriving capital
/// never touches a vault that does not own it. See
/// `script/DeployReturnRelay.s.sol`.
contract CctpReturnRelay {
    using SafeERC20 for IERC20;

    error NotOwner();
    error NotKeeper();
    error ZeroAddress();
    error ZeroAmount();
    error DestinationNotSet();
    error InsufficientBalance(uint256 requested, uint256 available);
    error FeeExceedsAmount(uint256 maxFee, uint256 amount);
    error CannotSweepBridgeAsset();

    event HomeRouteSet(uint32 indexed destinationDomain, bytes32 mintRecipient);
    event ReturnedHome(
        uint32 indexed destinationDomain, bytes32 mintRecipient, uint256 amount, uint256 maxFee
    );
    event KeeperChanged(address indexed previous, address indexed next);
    event OwnerChanged(address indexed previous, address indexed next);

    ITokenMessengerV2 public immutable tokenMessenger;

    /// @notice The bridge asset. Immutable, because `sweep` refusing to move it
    ///         is only a guarantee if the identity cannot be changed later.
    IERC20 public immutable usdc;

    address public owner;
    address public keeper;

    /// @notice Where capital goes home to. `mintRecipient == 0` means unset,
    ///         and burning against it would send USDC to address zero on
    ///         domain 0 — irrecoverably.
    uint32 public destinationDomain;
    bytes32 public mintRecipient;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(ITokenMessengerV2 tokenMessenger_, IERC20 usdc_, address owner_, address keeper_) {
        if (owner_ == address(0) || keeper_ == address(0)) revert ZeroAddress();
        tokenMessenger = tokenMessenger_;
        usdc = usdc_;
        owner = owner_;
        keeper = keeper_;
    }

    /// @notice USDC waiting to go home.
    /// @dev Read from the token rather than tracked in storage. Capital arrives
    ///      here as a CCTP *mint* — no transaction this contract can observe,
    ///      so there is no hook where a counter could be incremented. The
    ///      balance is the only honest source.
    function pendingReturn() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Burn USDC held here so it mints at the pinned destination.
    ///
    /// @param amount How much to send. Partial returns are legitimate: CCTP
    ///        applies per-transfer limits, and a keeper testing a freshly wired
    ///        route should be able to send a dollar before sending a million.
    /// @param maxFee Cap on the CCTP fee, in USDC base units.
    /// @param minFinalityThreshold 1000 for fast transfer, 2000 for standard.
    ///
    /// @dev The keeper chooses the amount and the cost/latency trade-off. It
    ///      does not choose the destination — that is the point of the
    ///      contract, and it is why this takes no address argument.
    function returnHome(uint256 amount, uint256 maxFee, uint32 minFinalityThreshold)
        external
        onlyKeeper
        returns (uint256 burned)
    {
        if (amount == 0) revert ZeroAmount();

        bytes32 recipient = mintRecipient;
        if (recipient == bytes32(0)) revert DestinationNotSet();

        uint256 balance = usdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientBalance(amount, balance);

        // A fee cap at or above the amount would let the entire transfer be
        // consumed by fees and still read as a successful return — the same
        // bound `CctpBridgeExecutor.enter` applies on the way out.
        if (maxFee >= amount) revert FeeExceedsAmount(maxFee, amount);

        uint32 domain = destinationDomain;

        usdc.forceApprove(address(tokenMessenger), amount);
        tokenMessenger.depositForBurn(
            amount,
            domain,
            recipient,
            address(usdc),
            // Empty destinationCaller: anyone may relay the attestation. §3
            // lists the CCTP relayer as permissionless — "cannot alter
            // message; can only decline to submit" — so pinning a caller adds
            // a liveness dependency without adding safety.
            bytes32(0),
            maxFee,
            minFinalityThreshold
        );

        emit ReturnedHome(domain, recipient, amount, maxFee);
        return amount;
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// @notice Pin where capital goes home to.
    /// @param mintRecipient_ The destination address, left-padded to 32 bytes.
    ///        `bytes32(uint256(uint160(addr)))` for an EVM address; a raw
    ///        pubkey for Solana.
    /// @dev Mutable on purpose. The hub's vault can be redeployed, and a relay
    ///      pointing at a dead address would strand every future arrival. What
    ///      the owner cannot do is move tokens — only aim the pipe.
    function setHomeRoute(uint32 destinationDomain_, bytes32 mintRecipient_) external onlyOwner {
        if (mintRecipient_ == bytes32(0)) revert ZeroAddress();
        destinationDomain = destinationDomain_;
        mintRecipient = mintRecipient_;
        emit HomeRouteSet(destinationDomain_, mintRecipient_);
    }

    function setKeeper(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit KeeperChanged(keeper, next);
        keeper = next;
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }

    /// @notice Recover a token sent here by mistake.
    /// @dev Refuses the bridge asset. Allowing it would reintroduce exactly the
    ///      owner discretion this contract exists to remove — `sweep(usdc, ...)`
    ///      is `rescueUnaccounted(to)` wearing a different name.
    function sweep(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (address(token) == address(usdc)) revert CannotSweepBridgeAsset();
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    /// @notice Helper for building a `mintRecipient` from an EVM address.
    function toBytes32(address a) external pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
