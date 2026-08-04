// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {TransientReentrancyGuard} from "./TransientReentrancyGuard.sol";

/// @title LPVault
/// @notice Spec §5.1. ERC-4626 over USDC. Shares are the accounting unit; NAV
///         is reported, not computed on-chain.
///
///         Three design notes from §5.1 are load-bearing here:
///
///         1. "Async withdrawals are mandatory. Capital sitting in a Solana LP
///            position cannot be redeemed synchronously on Arc. Attempting
///            synchronous redemption is the single most likely way to ship a
///            broken vault." So `withdraw` and `redeem` revert, and the only
///            exit is `requestWithdraw` → `claimWithdraw`.
///
///         2. "NAV is reported by Reporter, bounded on-chain." A move larger
///            than `MAX_NAV_DELTA_BPS` in one step, or inside the cooldown, is
///            rejected outright — §10.2: "reject, don't clamp silently".
///
///         3. "Deposit cap and per-venue cap. Prevents the vault itself from
///            becoming the dilution problem it is designed to detect."
contract LPVault is ERC4626, TransientReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotOwner();
    error NotReporter();
    error NotRouter();
    error NotOperator();
    error ZeroAddress();
    error SynchronousRedemptionDisabled();
    error DepositCapExceeded(uint256 attempted, uint256 cap);
    error VenueCapExceeded(uint16 venueId, uint256 attempted, uint256 cap);
    error NavCooldown(uint64 readyAt);
    error NavDeltaTooLarge(uint256 previous, uint256 proposed, uint16 maxBps);
    error InsufficientIdle(uint256 requested, uint256 available);
    error VenueInactive(uint16 venueId);
    error VenuePaused(uint16 venueId);
    error VenueAlreadyRegistered(uint16 venueId);
    error EpochNotSettled(uint16 requestEpoch, uint16 lastSettled);
    error AlreadyClaimed(uint256 requestId);
    error NotRequestOwner(uint256 requestId);
    error AmountTooLarge();
    error ZeroShares();

    // -----------------------------------------------------------------------
    // Events — §8.1: history lives in logs, not storage.
    // -----------------------------------------------------------------------

    event WithdrawRequested(
        uint256 indexed requestId, address indexed owner, uint256 shares, uint256 assets, uint16 epoch
    );
    event WithdrawClaimed(uint256 indexed requestId, address indexed owner, uint256 assets);
    event EpochSettled(uint16 indexed epoch, uint256 pendingAssets, uint256 idleAssets);
    event NavReported(uint256 previousDeployed, uint256 newDeployed, int256 deltaBps);
    event VenueRegistered(uint16 indexed venueId, uint8 chainDomain);
    event VenueFlagsChanged(uint16 indexed venueId, uint8 flags);
    event Deployed(uint16 indexed venueId, uint256 assets);
    event Returned(uint16 indexed venueId, uint256 assets);
    event CapsChanged(uint256 depositCap, uint256 perVenueCap);
    event RoleChanged(bytes32 indexed role, address indexed previous, address indexed next);
    event IdleSynced(uint256 recovered, uint256 newIdle);

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// @notice §5.1: "Reject any NAV update exceeding MAX_NAV_DELTA_BPS
    ///         (e.g. 500 bps) per epoch". This is the cap on how much damage a
    ///         compromised reporter can do in a single step.
    uint16 public constant MAX_NAV_DELTA_BPS = 500;

    /// @notice Minimum spacing between NAV reports.
    uint64 public constant NAV_COOLDOWN = 1 hours;

    uint256 private constant BPS = 10_000;

    /// @dev `uint72` bounds a single withdrawal request's assets. At 6dp that
    ///      is ~$4.7 quadrillion — far above any conceivable vault.
    uint256 private constant MAX_REQUEST_ASSETS = type(uint72).max;

    bytes32 private constant ROLE_OWNER = "owner";
    bytes32 private constant ROLE_REPORTER = "reporter";
    bytes32 private constant ROLE_ROUTER = "router";
    bytes32 private constant ROLE_OPERATOR = "operator";

    // Venue flag bits, per §5.1's `VenueState.flags` comment.
    uint8 public constant FLAG_ACTIVE = 1 << 0;
    uint8 public constant FLAG_PAUSED = 1 << 1;
    uint8 public constant FLAG_PENDING_HOOK = 1 << 2;

    uint8 private constant REQUEST_FLAG_CLAIMED = 1 << 0;

    // -----------------------------------------------------------------------
    // Roles
    // -----------------------------------------------------------------------

    address public owner;
    /// @notice Posts NAV. Cannot move funds — §3: "no off-chain party holds a
    ///         key that can move user funds."
    address public reporter;
    /// @notice The only address that may move idle capital into a venue.
    address public router;
    /// @notice Settles withdrawal epochs once positions are closed.
    address public operator;

    // -----------------------------------------------------------------------
    // Packed state — §8.1: "Pack structs to 32-byte slots."
    // -----------------------------------------------------------------------

    /// @notice §5.1's storage layout, verbatim: 128+64+32+16+8+8 = 256 bits.
    struct VenueState {
        uint128 deployedAssets; // USDC 6dp
        uint64 lastRebalanceAt; // unix seconds
        uint32 scoreBps; // last accepted score
        uint16 venueId;
        uint8 chainDomain; // CCTP domain id
        uint8 flags; // bit 0 active, bit 1 paused, bit 2 pendingHook
    }

    /// @dev One slot: 160 + 72 + 16 + 8 = 256 bits.
    struct WithdrawRequest {
        address owner;
        uint72 assets; // fixed at request time, USDC 6dp
        uint16 epoch;
        uint8 flags; // bit 0 claimed
    }

    struct Caps {
        uint128 depositCapAssets;
        uint128 perVenueCapAssets;
    }

    struct Nav {
        uint128 deployedAssets; // reported, aggregate across venues
        uint64 updatedAt;
        uint64 epoch;
    }

    /// @notice The two asset aggregates `totalAssets()` needs, in one slot.
    ///
    ///         `idle` is TRACKED rather than read from the token. On Arc the
    ///         USDC ERC-20 at 0x3600…0000 is a shim over the native balance,
    ///         and a `balanceOf` through it costs ~11,162 gas against ~2,100
    ///         for a conventional token — measured on the live chain. Since
    ///         `totalAssets()` is on the deposit, withdrawal-request and NAV
    ///         paths, that surcharge lands almost everywhere.
    ///
    ///         Tracking it also closes the donation vector properly: a direct
    ///         transfer into the vault no longer moves the share price, so
    ///         share value cannot be manipulated by sending tokens. See
    ///         {unaccountedBalance} and {syncIdle} for recovering such funds
    ///         deliberately.
    struct Assets {
        uint128 idle; // USDC the vault holds and has accounted for
        uint128 pending; // owed to requesters, excluded from equity
    }

    struct WithdrawQueue {
        uint64 nextRequestId; // starts at 1 (§8.1: never write zero)
        uint16 epoch; // current epoch accepting requests
        uint16 lastSettledEpoch;
    }

    Caps public caps;
    Nav public nav;
    Assets public assets;
    WithdrawQueue public queue;

    /// @notice §8.1: "Bitmaps for flags. Active/paused venue sets as a single
    ///         uint256 bitmap, not mapping(uint16 => bool)." Bit `i` is venue
    ///         `i`, so this covers venue ids 0–255.
    uint256 public activeVenueBitmap;
    uint256 public pausedVenueBitmap;

    mapping(uint16 venueId => VenueState) public venues;
    mapping(uint256 requestId => WithdrawRequest) public withdrawRequests;

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyReporter() {
        if (msg.sender != reporter) revert NotReporter();
        _;
    }

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 usdc, address owner_, address reporter_, address operator_)
        ERC20("Spidey USDC LP Vault", "spUSDC")
        ERC4626(usdc)
    {
        if (owner_ == address(0) || reporter_ == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
        reporter = reporter_;
        operator = operator_;

        // Seed every counter non-zero so the first real write is a warm
        // rewrite rather than a 20,000-gas zero→non-zero SSTORE (§8.1).
        queue = WithdrawQueue({nextRequestId: 1, epoch: 1, lastSettledEpoch: 0});
        assets = Assets({idle: 0, pending: 0});
        nav = Nav({deployedAssets: 0, updatedAt: uint64(block.timestamp), epoch: 1});
        caps = Caps({depositCapAssets: type(uint128).max, perVenueCapAssets: type(uint128).max});
    }

    // -----------------------------------------------------------------------
    // ERC-4626 accounting
    // -----------------------------------------------------------------------

    /// @dev OZ's virtual-share mitigation for the classic first-depositor
    ///      inflation attack. Three decimals of offset makes the donation a
    ///      griefer would need ~1000x the profit it could extract.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    /// @notice Idle USDC sitting in the vault, including assets already
    ///         earmarked for pending withdrawals.
    function idleAssets() public view returns (uint256) {
        return assets.idle;
    }

    /// @notice USDC sitting in the vault that has not been accounted for —
    ///         donations, or an executor return that skipped `recordReturn`.
    /// @dev Deliberately excluded from `totalAssets()` until {syncIdle} folds
    ///      it in, so nobody can move the share price by sending tokens.
    function unaccountedBalance() public view returns (uint256) {
        uint256 held = IERC20(asset()).balanceOf(address(this));
        uint256 tracked = assets.idle;
        unchecked {
            return held > tracked ? held - tracked : 0;
        }
    }

    /// @notice Fold unaccounted balance into vault equity. Owner-only, because
    ///         it moves the share price.
    function syncIdle() external onlyOwner returns (uint256 recovered) {
        recovered = unaccountedBalance();
        if (recovered > 0) {
            assets.idle += uint128(recovered);
            emit IdleSynced(recovered, assets.idle);
        }
    }

    /// @notice Reported assets deployed to venues, aggregate.
    function deployedAssets() public view returns (uint256) {
        return nav.deployedAssets;
    }

    /// @notice Shareholder equity: idle + deployed, less what is already owed
    ///         to withdrawal requesters.
    /// @dev Pending withdrawals are subtracted because a request fixes its
    ///      payout at the rate current when it was made. Leaving them in would
    ///      credit remaining holders with assets that are no longer theirs.
    function totalAssets() public view override returns (uint256) {
        return _equity(assets, nav.deployedAssets); // one SLOAD for both aggregates
    }

    /// @dev Shareholder equity from already-loaded state, so callers that
    ///      have the slot in memory do not pay to read it twice.
    function _equity(Assets memory a, uint256 deployed) private pure returns (uint256) {
        uint256 gross = uint256(a.idle) + deployed;
        unchecked {
            return gross > a.pending ? gross - a.pending : 0;
        }
    }

    // -----------------------------------------------------------------------
    // Deposit
    // -----------------------------------------------------------------------

    /// @dev §8.3: "Cache totalAssets(). ERC-4626 implementations commonly call
    ///      it 2–3 times per deposit. Read once into memory." OZ's `deposit`
    ///      would hit it through both `maxDeposit` and `previewDeposit`; this
    ///      override reads it once and reuses the value for the cap check and
    ///      the share conversion.
    function deposit(uint256 amount, address receiver)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        uint256 total = totalAssets();
        uint256 cap = caps.depositCapAssets;
        if (total + amount > cap) revert DepositCapExceeded(total + amount, cap);

        shares = _convertToSharesCached(amount, total, Math.Rounding.Floor);
        if (shares == 0) revert ZeroShares();
        _deposit(msg.sender, receiver, amount, shares);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        returns (uint256 amount)
    {
        uint256 total = totalAssets();
        amount = _convertToAssetsCached(shares, total, Math.Rounding.Ceil);
        uint256 cap = caps.depositCapAssets;
        if (total + amount > cap) revert DepositCapExceeded(total + amount, cap);
        _deposit(msg.sender, receiver, amount, shares);
    }

    /// @dev Every inbound transfer goes through here, so this is the single
    ///      place tracked idle needs to grow.
    function _deposit(address caller, address receiver, uint256 amount, uint256 shares)
        internal
        override
    {
        super._deposit(caller, receiver, amount, shares);
        // forge-lint: disable-next-line(unsafe-typecast)
        assets.idle = assets.idle + uint128(amount);
    }

    function _convertToSharesCached(uint256 assets_, uint256 total, Math.Rounding rounding)
        private
        view
        returns (uint256)
    {
        return assets_.mulDiv(totalSupply() + 10 ** _decimalsOffset(), total + 1, rounding);
    }

    function _convertToAssetsCached(uint256 shares, uint256 total, Math.Rounding rounding)
        private
        view
        returns (uint256)
    {
        return shares.mulDiv(total + 1, totalSupply() + 10 ** _decimalsOffset(), rounding);
    }

    function maxDeposit(address) public view override returns (uint256) {
        uint256 total = totalAssets();
        uint256 cap = caps.depositCapAssets;
        return total >= cap ? 0 : cap - total;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return _convertToShares(maxDeposit(receiver), Math.Rounding.Floor);
    }

    // -----------------------------------------------------------------------
    // Withdrawal — request / claim (§5.1)
    // -----------------------------------------------------------------------

    /// @notice Synchronous exits are disabled by design.
    /// @dev §5.1: "Attempting synchronous redemption is the single most likely
    ///      way to ship a broken vault." Capital in a Solana LP position
    ///      cannot be returned in the same transaction on Arc, so rather than
    ///      pretend otherwise these revert and route users to the queue.
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert SynchronousRedemptionDisabled();
    }

    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert SynchronousRedemptionDisabled();
    }

    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Burn shares now, fix the payout at today's rate, and join the
    ///         current epoch's queue.
    /// @dev The payout is fixed at request time rather than at settlement.
    ///      That means a requester stops earning the moment they ask to leave
    ///      and is insulated from later NAV moves — they have exited, and the
    ///      vault simply owes them a number. The trade-off is that a NAV drop
    ///      between request and settlement is borne by remaining holders; that
    ///      exposure is bounded by MAX_NAV_DELTA_BPS per epoch.
    function requestWithdraw(uint256 shares) external nonReentrant returns (uint256 requestId) {
        if (shares == 0) revert ZeroShares();

        // One SLOAD serves both the conversion below and the pending update.
        Assets memory a = assets;
        uint256 owed = _convertToAssetsCached(
            shares, _equity(a, nav.deployedAssets), Math.Rounding.Floor
        );
        if (owed > MAX_REQUEST_ASSETS) revert AmountTooLarge();

        _burn(msg.sender, shares);

        WithdrawQueue memory q = queue;
        requestId = q.nextRequestId;

        withdrawRequests[requestId] = WithdrawRequest({
            owner: msg.sender,
            // safe: bounded by the MAX_REQUEST_ASSETS check above
            // forge-lint: disable-next-line(unsafe-typecast)
            assets: uint72(owed),
            epoch: q.epoch,
            flags: 0
        });

        // Deliberately CHECKED. `pending` aggregates every outstanding
        // request, so unlike the per-request cast above it has no bound that
        // makes the addition provably safe. §8.2 licenses `unchecked` only for
        // "provably-safe arithmetic"; this is not that.
        // forge-lint: disable-next-line(unsafe-typecast)
        assets.pending = a.pending + uint128(owed);

        unchecked {
            // A uint64 request counter cannot realistically overflow.
            queue = WithdrawQueue({
                nextRequestId: q.nextRequestId + 1,
                epoch: q.epoch,
                lastSettledEpoch: q.lastSettledEpoch
            });
        }

        emit WithdrawRequested(requestId, msg.sender, shares, owed, q.epoch);
    }

    /// @notice Assets a share count would fetch right now.
    function previewRedeemShares(uint256 shares) public view returns (uint256) {
        return _convertToAssets(shares, Math.Rounding.Floor);
    }

    /// @notice Close the current epoch. Requests in it become claimable.
    /// @dev §10.2: "Withdrawal exceeds idle → async queue; epoch settlement
    ///      after position close." The operator calls this once the capital
    ///      backing that epoch's requests is actually back on Arc.
    function settleEpoch() external onlyOperator returns (uint16 settled) {
        WithdrawQueue memory q = queue;
        settled = q.epoch;
        unchecked {
            queue = WithdrawQueue({
                nextRequestId: q.nextRequestId,
                epoch: q.epoch + 1,
                lastSettledEpoch: settled
            });
        }
        emit EpochSettled(settled, assets.pending, assets.idle);
    }

    /// @notice Collect a settled withdrawal.
    function claimWithdraw(uint256 requestId) external nonReentrant returns (uint256 owed) {
        WithdrawRequest memory request = withdrawRequests[requestId];

        if (request.owner != msg.sender) revert NotRequestOwner(requestId);
        if (request.flags & REQUEST_FLAG_CLAIMED != 0) revert AlreadyClaimed(requestId);

        uint16 lastSettled = queue.lastSettledEpoch;
        if (request.epoch > lastSettled) revert EpochNotSettled(request.epoch, lastSettled);

        owed = request.assets;
        uint256 idle = assets.idle;
        if (idle < owed) revert InsufficientIdle(owed, idle);

        // Mark claimed before transferring. The transient guard already blocks
        // reentrancy; this keeps the invariant true even without it.
        withdrawRequests[requestId].flags = request.flags | REQUEST_FLAG_CLAIMED;
        unchecked {
            // safe: this exact amount was added by requestWithdraw, and the
            // claimed flag above makes a second subtraction impossible. Both
            // fields share a slot, so this is a single warm rewrite.
            // forge-lint: disable-next-line(unsafe-typecast)
            assets.pending -= uint128(owed);
            // forge-lint: disable-next-line(unsafe-typecast)
            assets.idle -= uint128(owed);
        }

        IERC20(asset()).safeTransfer(request.owner, owed);
        emit WithdrawClaimed(requestId, request.owner, owed);
    }

    // -----------------------------------------------------------------------
    // NAV reporting (§5.1, §10.2)
    // -----------------------------------------------------------------------

    /// @notice Mark deployed capital to market.
    /// @dev Bounded two ways: not more often than `NAV_COOLDOWN`, and not by
    ///      more than `MAX_NAV_DELTA_BPS` in one step. Out-of-bounds updates
    ///      are rejected, never clamped — a silently clamped bad report is
    ///      indistinguishable from a good one (§10.2).
    function reportNav(uint128 newDeployedAssets) external onlyReporter {
        Nav memory current = nav;

        uint64 readyAt;
        unchecked {
            readyAt = current.updatedAt + NAV_COOLDOWN;
        }
        if (block.timestamp < readyAt) revert NavCooldown(readyAt);

        uint256 previous = current.deployedAssets;
        if (previous != 0) {
            uint256 diff = newDeployedAssets > previous
                ? newDeployedAssets - previous
                : previous - newDeployedAssets;
            if (diff * BPS > previous * MAX_NAV_DELTA_BPS) {
                revert NavDeltaTooLarge(previous, newDeployedAssets, MAX_NAV_DELTA_BPS);
            }
        }

        unchecked {
            nav = Nav({
                deployedAssets: newDeployedAssets,
                updatedAt: uint64(block.timestamp),
                epoch: current.epoch + 1
            });
        }

        int256 deltaBps = previous == 0
            ? int256(0)
            // safe: both operands originate as uint128, far below int256 max
            // forge-lint: disable-next-line(unsafe-typecast)
            : (int256(uint256(newDeployedAssets)) - int256(previous)) * int256(BPS)
            // safe: `previous` originates as uint128, far below int256 max
            // forge-lint: disable-next-line(unsafe-typecast)
            / int256(previous);
        emit NavReported(previous, newDeployedAssets, deltaBps);
    }

    // -----------------------------------------------------------------------
    // Venue registry and capital movement (router-only)
    // -----------------------------------------------------------------------

    function registerVenue(uint16 venueId, uint8 chainDomain) external onlyOwner {
        if (venues[venueId].flags != 0) revert VenueAlreadyRegistered(venueId);
        venues[venueId] = VenueState({
            deployedAssets: 0,
            lastRebalanceAt: uint64(block.timestamp),
            scoreBps: 1, // §8.1: seed non-zero, treat 1 as "no score yet"
            venueId: venueId,
            chainDomain: chainDomain,
            flags: FLAG_ACTIVE
        });
        activeVenueBitmap |= (uint256(1) << venueId);
        emit VenueRegistered(venueId, chainDomain);
        emit VenueFlagsChanged(venueId, FLAG_ACTIVE);
    }

    function setVenuePaused(uint16 venueId, bool paused) external onlyOwner {
        VenueState memory venue = venues[venueId];
        if (venue.flags & FLAG_ACTIVE == 0) revert VenueInactive(venueId);
        uint8 flags = paused ? venue.flags | FLAG_PAUSED : venue.flags & ~FLAG_PAUSED;
        venues[venueId].flags = flags;
        if (paused) {
            pausedVenueBitmap |= (uint256(1) << venueId);
        } else {
            pausedVenueBitmap &= ~(uint256(1) << venueId);
        }
        emit VenueFlagsChanged(venueId, flags);
    }

    /// @notice Move idle capital into a venue. Router-only.
    /// @dev The per-venue cap here is what stops the vault "becoming the
    ///      dilution problem it is designed to detect" (§5.1).
    function recordDeploy(uint16 venueId, uint256 amount, uint32 scoreBps) external onlyRouter {
        VenueState memory venue = venues[venueId];
        if (venue.flags & FLAG_ACTIVE == 0) revert VenueInactive(venueId);
        if (venue.flags & FLAG_PAUSED != 0) revert VenuePaused(venueId);

        uint256 next = uint256(venue.deployedAssets) + amount;
        uint256 cap = caps.perVenueCapAssets;
        if (next > cap) revert VenueCapExceeded(venueId, next, cap);
        if (next > type(uint128).max) revert AmountTooLarge();

        venues[venueId] = VenueState({
            // safe: bounded by the type(uint128).max check above
            // forge-lint: disable-next-line(unsafe-typecast)
            deployedAssets: uint128(next),
            lastRebalanceAt: uint64(block.timestamp),
            scoreBps: scoreBps,
            venueId: venue.venueId,
            chainDomain: venue.chainDomain,
            flags: venue.flags
        });

        // Deliberately CHECKED. The per-venue cap bounds `next` above, but
        // `nav.deployedAssets` sums across up to 256 venues, so the aggregate
        // can exceed any single venue's bound.
        // forge-lint: disable-next-line(unsafe-typecast)
        nav.deployedAssets = nav.deployedAssets + uint128(amount);
        emit Deployed(venueId, amount);
    }

    /// @notice Record capital coming back from a venue. Router-only.
    function recordReturn(uint16 venueId, uint256 amount) external onlyRouter {
        VenueState memory venue = venues[venueId];
        if (amount > venue.deployedAssets) revert InsufficientIdle(amount, venue.deployedAssets);

        unchecked {
            venues[venueId] = VenueState({
                // safe: `amount <= venue.deployedAssets` checked above
                // forge-lint: disable-next-line(unsafe-typecast)
                deployedAssets: venue.deployedAssets - uint128(amount),
                lastRebalanceAt: uint64(block.timestamp),
                scoreBps: venue.scoreBps,
                venueId: venue.venueId,
                chainDomain: venue.chainDomain,
                flags: venue.flags
            });
            // safe: the aggregate is the sum of per-venue balances, so it is
            // always at least `venue.deployedAssets`, itself >= `amount`
            // forge-lint: disable-next-line(unsafe-typecast)
            nav.deployedAssets -= uint128(amount);
        }
        // The executor transfers tokens back directly, so credit tracked idle
        // here. Without this the returned capital would sit as an unaccounted
        // balance and drop out of `totalAssets()`.
        // forge-lint: disable-next-line(unsafe-typecast)
        assets.idle = assets.idle + uint128(amount);
        emit Returned(venueId, amount);
    }

    /// @notice Send idle USDC out to a venue executor. Router-only.
    /// @dev Kept separate from `recordDeploy` so accounting and token movement
    ///      can be reasoned about independently, and so a cross-chain leg can
    ///      record the deploy before the tokens have actually landed.
    function transferToExecutor(address executor, uint256 amount) external onlyRouter nonReentrant {
        if (executor == address(0)) revert ZeroAddress();
        Assets memory a = assets;
        uint256 available = a.idle;
        uint256 reserved = a.pending;
        // Never spend assets already promised to withdrawal requesters.
        uint256 spendable = available > reserved ? available - reserved : 0;
        if (amount > spendable) revert InsufficientIdle(amount, spendable);
        // forge-lint: disable-next-line(unsafe-typecast)
        assets.idle = a.idle - uint128(amount);
        IERC20(asset()).safeTransfer(executor, amount);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function setCaps(uint128 depositCapAssets, uint128 perVenueCapAssets) external onlyOwner {
        caps = Caps({depositCapAssets: depositCapAssets, perVenueCapAssets: perVenueCapAssets});
        emit CapsChanged(depositCapAssets, perVenueCapAssets);
    }

    function setRouter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit RoleChanged(ROLE_ROUTER, router, next);
        router = next;
    }

    function setReporter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit RoleChanged(ROLE_REPORTER, reporter, next);
        reporter = next;
    }

    function setOperator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit RoleChanged(ROLE_OPERATOR, operator, next);
        operator = next;
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit RoleChanged(ROLE_OWNER, owner, next);
        owner = next;
    }
}
