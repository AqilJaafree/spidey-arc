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
    error NothingToClaim(address holder);
    error NotRequestOwner(uint256 requestId);
    error ClaimPendingFirst(uint16 pendingEpoch, uint16 currentEpoch);
    error AmountTooLarge();
    error ZeroShares();
    error VaultNotEmpty(uint256 outstanding);
    error CapitalStillDeployed(uint256 deployed);
    error NoSuchArrival(uint256 claimed, uint256 actuallyArrived);

    // -----------------------------------------------------------------------
    // Events — §8.1: history lives in logs, not storage.
    // -----------------------------------------------------------------------

    event WithdrawRequested(
        uint256 indexed requestId, address indexed owner, uint256 shares, uint256 assets, uint16 epoch
    );
    event WithdrawClaimed(
        uint256 indexed requestId, address indexed owner, uint256 assets, uint256 coverageBps
    );
    event EpochSettled(uint16 indexed epoch, uint256 pendingAssets, uint256 idleAssets);
    event NavReported(uint256 previousDeployed, uint256 newDeployed, int256 deltaBps);
    event VenueRegistered(uint16 indexed venueId, uint8 chainDomain);
    event VenueFlagsChanged(uint16 indexed venueId, uint8 flags);
    event Deployed(uint16 indexed venueId, uint256 assets);
    event Returned(uint16 indexed venueId, uint256 assets);
    event CapsChanged(uint256 depositCap, uint256 perVenueCap);
    event RoleChanged(bytes32 indexed role, address indexed previous, address indexed next);
    event IdleSynced(uint256 recovered, uint256 newIdle);
    event UnaccountedRescued(address indexed to, uint256 amount);
    event OrphanedIdleSwept(address indexed to, uint256 amount);
    event VenueClosed(uint16 indexed venueId, uint256 writtenOff);
    event BridgeArrived(uint16 indexed venueId, uint256 amount);

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

    /// @dev Set on a holder's first request, never cleared (§8.1).
    uint8 private constant REQUEST_FLAG_INITIALIZED = 1 << 0;

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

    /// @notice One outstanding withdrawal per holder, in one slot.
    ///
    ///         Keying by holder rather than by an incrementing request id is
    ///         what brings `requestWithdraw` inside its §8.4 budget. A fresh
    ///         slot per request costs 22,100 gas every single time (zero →
    ///         non-zero); a slot per holder costs that once and 5,000
    ///         thereafter.
    ///
    ///         `flags` carries an INITIALIZED bit that is set on the first
    ///         request and never cleared, so the word stays non-zero even
    ///         when nothing is owed. That is §8.1's own instruction — "Never
    ///         write zero. Initialize counters to 1, not 0, and treat 1 as
    ///         empty" — applied to the withdrawal record.
    ///
    ///         The trade-off: a holder has at most one outstanding request.
    ///         A second request in the same epoch adds to it; a request while
    ///         an older settled one is unclaimed is rejected, so a claim can
    ///         never be silently overwritten.
    struct PendingWithdrawal {
        uint128 assets; // 0 = nothing outstanding
        uint16 epoch; // the epoch this belongs to
        uint8 flags; // bit 0 = initialized (keeps the slot non-zero)
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
    mapping(address holder => PendingWithdrawal) public pendingOf;

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
        queue = WithdrawQueue({epoch: 1, lastSettledEpoch: 0});
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

    /// @dev Unaccounted tokens are only unambiguous when nothing is out at a
    ///      venue. While capital is deployed, a balance the vault does not
    ///      recognise might be a donation — or it might be an executor that
    ///      transferred back before the Router recorded the return, which is
    ///      ordinary depositor capital mid-flight.
    ///
    ///      Both {syncIdle} and {rescueUnaccounted} previously guessed
    ///      "donation" and were wrong in the second case: sync double-counted
    ///      it (equity claimed 2,000 against 1,000 real tokens) and rescue
    ///      handed it to the owner. Guarding on "nothing deployed" removes the
    ///      ambiguity instead of resolving it by assumption.
    modifier onlyWhenNothingDeployed() {
        if (nav.deployedAssets != 0) revert CapitalStillDeployed(nav.deployedAssets);
        _;
    }

    /// @notice Send unaccounted balance somewhere, without crediting equity.
    /// @dev Bounded to {unaccountedBalance}, so it can never reach depositor
    ///      assets. Without it, tokens sent to a vault with no shares
    ///      outstanding are unreachable: {syncIdle} would credit equity that
    ///      nobody holds a claim on. Found the hard way on testnet — a 1 USDC
    ///      donation into a superseded deployment had no exit.
    function rescueUnaccounted(address to)
        external
        onlyOwner
        onlyWhenNothingDeployed
        returns (uint256 amount)
    {
        if (to == address(0)) revert ZeroAddress();
        amount = unaccountedBalance();
        if (amount == 0) return 0;
        IERC20(asset()).safeTransfer(to, amount);
        emit UnaccountedRescued(to, amount);
    }

    /// @notice Recover accounted idle when the vault has no shareholders.
    ///
    /// @dev A venue can return more than it was given — a profitable exit, or
    ///      on a thin pool, favourable round-trip slippage. That surplus lands
    ///      in `idle` as accounted equity. If every holder has since exited,
    ///      `totalSupply` is zero and the surplus becomes unclaimable:
    ///
    ///        - no shares exist to redeem against it;
    ///        - {rescueUnaccounted} cannot reach it, since it is accounted;
    ///        - a new depositor does not inherit it either, because the
    ///          virtual-share offset that blocks the donation attack also
    ///          correctly refuses to hand them somebody else's residual.
    ///
    ///      Observed on Base Sepolia: a 10 USDC deposit round-tripped and
    ///      returned 14.6, leaving 4.6 stranded once the depositor exited.
    ///
    ///      Guarded on `totalSupply() == 0` and no pending claims, so it can
    ///      never touch depositor funds — if anybody holds a share or is owed
    ///      a withdrawal, this reverts.
    function sweepOrphanedIdle(address to) external onlyOwner returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply() != 0) revert VaultNotEmpty(totalSupply());

        Assets memory a = assets;
        if (a.pending != 0) revert VaultNotEmpty(a.pending);

        amount = a.idle;
        if (amount == 0) return 0;

        assets = Assets({idle: 0, pending: 0});
        IERC20(asset()).safeTransfer(to, amount);
        emit OrphanedIdleSwept(to, amount);
    }

    /// @notice Fold unaccounted balance into vault equity. Owner-only, because
    ///         it moves the share price.
    function syncIdle() external onlyOwner onlyWhenNothingDeployed returns (uint256 recovered) {
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

    /// @notice What fraction of outstanding claims the vault can actually
    ///         cover, in basis points. 10,000 = fully covered.
    ///
    /// @dev `requestWithdraw` fixes a payout at the share price current when
    ///      the holder asks. If the vault then loses value, those fixed claims
    ///      can exceed everything it holds — found by the invariant suite as
    ///      `pending > idle + deployed`.
    ///
    ///      Without a haircut the shortfall lands entirely on whoever claims
    ///      last: early claimers are paid in full and late ones revert with
    ///      `InsufficientIdle`, so transaction ordering decides who eats a
    ///      loss that belongs to everyone. Scaling every claim by this factor
    ///      shares it pro-rata instead.
    ///
    ///      Deliberately computed live rather than stored: a haircut is a
    ///      statement about the vault's condition right now, and a stored one
    ///      would keep punishing requesters after the loss had recovered.
    function coverageBps() public view returns (uint256) {
        return _coverageBps(assets);
    }

    /// @dev Takes already-loaded state so `claimWithdraw` does not read the
    ///      `assets` slot twice.
    function _coverageBps(Assets memory a) private view returns (uint256) {
        if (a.pending == 0) return BPS;
        // Fast path: if idle alone covers the queue then adding deployed
        // cannot change the answer, so skip the NAV read entirely. That is
        // the normal case for a settled epoch, and the read is a cold SLOAD
        // on a path that has only ~1.3k of gas headroom against its budget.
        if (a.idle >= a.pending) return BPS;
        uint256 available = uint256(a.idle) + nav.deployedAssets;
        if (available >= a.pending) return BPS;
        return (available * BPS) / a.pending;
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

        WithdrawQueue memory q = queue;
        PendingWithdrawal memory p = pendingOf[msg.sender];

        // A settled-but-unclaimed request from an earlier epoch must be
        // collected first — merging it into a new epoch would move money
        // between settlement batches, and overwriting it would lose a claim.
        if (p.assets != 0 && p.epoch != q.epoch) {
            revert ClaimPendingFirst(p.epoch, q.epoch);
        }

        // One SLOAD serves both the conversion and the pending update.
        Assets memory a = assets;
        uint256 owed = _convertToAssetsCached(
            shares, _equity(a, nav.deployedAssets), Math.Rounding.Floor
        );
        if (owed > MAX_REQUEST_ASSETS) revert AmountTooLarge();

        _burn(msg.sender, shares);

        // Rewrite, never clear: the INITIALIZED bit keeps this word non-zero
        // for the life of the vault, so only a holder's first request pays
        // the 22,100-gas cold write.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 newPending = p.assets + uint128(owed);
        pendingOf[msg.sender] = PendingWithdrawal({
            assets: newPending,
            epoch: q.epoch,
            flags: p.flags | REQUEST_FLAG_INITIALIZED
        });

        // Deliberately CHECKED. `pending` aggregates every outstanding
        // request, so unlike the per-holder cast above it has no bound that
        // makes the addition provably safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        assets.pending = a.pending + uint128(owed);

        requestId = encodeRequestId(msg.sender, q.epoch);
        emit WithdrawRequested(requestId, msg.sender, shares, owed, q.epoch);
    }

    /// @notice The request id for a holder in an epoch.
    /// @dev Derived, never stored — storing it would cost a slot to convey
    ///      information both sides already have.
    function encodeRequestId(address holder, uint16 epoch) public pure returns (uint256) {
        return (uint256(uint160(holder)) << 16) | uint256(epoch);
    }

    function decodeRequestId(uint256 requestId) public pure returns (address holder, uint16 epoch) {
        holder = address(uint160(requestId >> 16));
        epoch = uint16(requestId);
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
            queue = WithdrawQueue({epoch: q.epoch + 1, lastSettledEpoch: settled});
        }
        emit EpochSettled(settled, assets.pending, assets.idle);
    }

    /// @notice Collect a settled withdrawal.
    /// @param requestId As returned by {requestWithdraw}. It encodes the
    ///        holder and epoch, so no per-request storage is needed to
    ///        validate it.
    function claimWithdraw(uint256 requestId) external nonReentrant returns (uint256 owed) {
        (address holder, uint16 epoch) = decodeRequestId(requestId);
        if (holder != msg.sender) revert NotRequestOwner(requestId);

        PendingWithdrawal memory p = pendingOf[msg.sender];
        if (p.assets == 0 || p.epoch != epoch) revert NothingToClaim(msg.sender);

        uint16 lastSettled = queue.lastSettledEpoch;
        if (p.epoch > lastSettled) revert EpochNotSettled(p.epoch, lastSettled);

        Assets memory a = assets;

        // Pay a pro-rata share of what the vault can cover. Fully covered is
        // the normal case and leaves this exact.
        uint256 coverage = _coverageBps(a);
        owed = coverage == BPS ? p.assets : (uint256(p.assets) * coverage) / BPS;
        if (a.idle < owed) revert InsufficientIdle(owed, a.idle);

        // Zero the amount but KEEP the initialized bit, so the slot stays
        // non-zero and this holder's next request is a 5,000-gas rewrite
        // rather than a 22,100-gas cold write.
        pendingOf[msg.sender] =
            PendingWithdrawal({assets: 0, epoch: p.epoch, flags: p.flags});

        unchecked {
            // `pending` drops by the FULL recorded claim while only `owed` is
            // paid: the haircut is realized here, not carried forward. Both
            // fields share a slot, so this is a single warm rewrite.
            // forge-lint: disable-next-line(unsafe-typecast)
            assets = Assets({idle: a.idle - uint128(owed), pending: a.pending - p.assets});
        }

        IERC20(asset()).safeTransfer(msg.sender, owed);
        emit WithdrawClaimed(requestId, msg.sender, owed, coverage);
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

    /// @notice Book capital that arrived by CCTP mint rather than by an
    ///         executor transfer. Router-only.
    ///
    /// @dev The return leg of a cross-chain venue lands as a *mint* straight
    ///      into this contract, so no executor ever calls back and
    ///      `recordReturn` has nothing to be triggered by. Without this the
    ///      capital sits as unaccounted balance while the venue's book still
    ///      claims it, and the vault permanently believes it is deployed.
    ///
    ///      Guarded on `unaccountedBalance()`: the amount booked can never
    ///      exceed tokens that genuinely arrived and are not already counted.
    ///      A keeper cannot conjure idle by asserting an arrival that did not
    ///      happen, which would otherwise break solvency outright.
    function recordBridgeArrival(uint16 venueId, uint256 amount)
        external
        onlyRouter
        returns (uint256 booked)
    {
        uint256 arrived = unaccountedBalance();
        if (amount > arrived) revert NoSuchArrival(amount, arrived);

        VenueState memory venue = venues[venueId];
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 bookReduction =
            amount > venue.deployedAssets ? venue.deployedAssets : uint128(amount);

        unchecked {
            venues[venueId] = VenueState({
                deployedAssets: venue.deployedAssets - bookReduction,
                lastRebalanceAt: uint64(block.timestamp),
                scoreBps: venue.scoreBps,
                venueId: venue.venueId,
                chainDomain: venue.chainDomain,
                flags: venue.flags
            });
            nav.deployedAssets -= bookReduction;
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        assets.idle = assets.idle + uint128(amount);
        booked = amount;
        emit BridgeArrived(venueId, amount);
    }

    /// @notice Mark a venue as having capital in flight. Router-only.
    ///
    /// @dev Uses `FLAG_PENDING_HOOK`, which §5.1's storage layout reserved and
    ///      nothing set until an asynchronous executor existed. It matters
    ///      because during a CCTP bridge the capital is genuinely nowhere
    ///      claimable — burned on Arc, not yet minted at the destination —
    ///      and `deployedAssets` alone cannot express that. Without the flag,
    ///      in-flight capital is indistinguishable from capital sitting safely
    ///      in a position.
    function setVenuePending(uint16 venueId, bool pending) external onlyRouter {
        VenueState memory venue = venues[venueId];
        if (venue.flags & FLAG_ACTIVE == 0) revert VenueInactive(venueId);
        uint8 flags = pending
            ? venue.flags | FLAG_PENDING_HOOK
            : venue.flags & ~FLAG_PENDING_HOOK;
        venues[venueId].flags = flags;
        emit VenueFlagsChanged(venueId, flags);
    }

    /// @notice Whether a venue has capital in flight to another chain.
    function isVenuePending(uint16 venueId) external view returns (bool) {
        return venues[venueId].flags & FLAG_PENDING_HOOK != 0;
    }

    /// @notice Record capital coming back from a venue. Router-only.

    /// @notice Record capital coming back from a venue. Router-only.
    ///
    /// @dev A venue that earned fees returns MORE than its book value, and the
    ///      whole point of the vault is to earn fees. So the book is reduced by
    ///      at most what the venue held and the excess is recognized as profit,
    ///      landing in `idle` and therefore in `totalAssets()`.
    ///
    ///      This previously required `amount <= venue.deployedAssets`, which
    ///      meant a profitable position could not be exited at all: the vault
    ///      tolerated losses and reverted on gains. Found by asking what
    ///      happens when the strategy works.
    function recordReturn(uint16 venueId, uint256 amount) external onlyRouter {
        VenueState memory venue = venues[venueId];

        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 bookReduction =
            amount > venue.deployedAssets ? venue.deployedAssets : uint128(amount);

        unchecked {
            venues[venueId] = VenueState({
                // safe: bounded by `venue.deployedAssets` above
                deployedAssets: venue.deployedAssets - bookReduction,
                lastRebalanceAt: uint64(block.timestamp),
                scoreBps: venue.scoreBps,
                venueId: venue.venueId,
                chainDomain: venue.chainDomain,
                flags: venue.flags
            });
            // safe: the aggregate is the sum of per-venue balances, so it is
            // always at least this venue's book value
            nav.deployedAssets -= bookReduction;
        }
        // The executor transfers tokens back directly, so credit tracked idle
        // here. Without this the returned capital would sit as an unaccounted
        // balance and drop out of `totalAssets()`.
        // forge-lint: disable-next-line(unsafe-typecast)
        assets.idle = assets.idle + uint128(amount);
        emit Returned(venueId, amount);
    }

    /// @notice Recognize a closed venue's residual book value as a realized
    ///         loss. Router-only.
    ///
    /// @dev When a position is fully unwound, whatever the venue's book still
    ///      claims is money that did not come back — slippage, impermanent
    ///      loss, or fees paid. Leaving it on the book makes the vault look
    ///      solvent when it is not, which is the stale-NAV limitation in its
    ///      realized form.
    ///
    ///      It bites immediately and concretely. Observed on Base Sepolia: a
    ///      5 USDC position returned 4.985 after slippage, the remaining
    ///      0.015 stayed on the book, `coverageBps` therefore read 10000, no
    ///      haircut applied, and `claimWithdraw` reverted `InsufficientIdle`.
    ///      The depositor could not be paid at all — worse than being paid
    ///      slightly less.
    ///
    ///      Writing the residual down lets the haircut do its job: coverage
    ///      falls to 9970 and the claim settles at 4.985, with the loss taken
    ///      by the holder who incurred it. Deliberately not bounded by
    ///      `MAX_NAV_DELTA_BPS` — that cap exists to limit what a compromised
    ///      *reporter* can do to a live position, whereas this is the Router
    ///      recording an outcome that has already happened.
    function recordVenueClosed(uint16 venueId) external onlyRouter returns (uint256 writtenOff) {
        VenueState memory venue = venues[venueId];
        writtenOff = venue.deployedAssets;
        if (writtenOff == 0) return 0;

        venues[venueId] = VenueState({
            deployedAssets: 0,
            lastRebalanceAt: uint64(block.timestamp),
            scoreBps: venue.scoreBps,
            venueId: venue.venueId,
            chainDomain: venue.chainDomain,
            flags: venue.flags
        });

        unchecked {
            // safe: the aggregate is the sum of per-venue books
            nav.deployedAssets -= venue.deployedAssets;
        }
        emit VenueClosed(venueId, writtenOff);
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
