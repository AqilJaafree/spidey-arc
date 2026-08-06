// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LPVault} from "./LPVault.sol";
import {ScoreOracle} from "./ScoreOracle.sol";
import {IVenueExecutor} from "./interfaces/IVenueExecutor.sol";
import {TransientReentrancyGuard} from "./TransientReentrancyGuard.sol";

/// @title Router
/// @notice Spec §5.3. Encodes the switch rule and refuses to move capital
///         unless the edge clears the cost.
///
///         This is the "contracts dispose" half of §3's design goal. The
///         scoring engine proposes a move and supplies a Merkle proof; the
///         Router re-checks the payback inequality in integer arithmetic and
///         declines if it does not hold. An operator who wants to churn the
///         vault cannot, because the rule is on-chain.
contract Router is TransientReentrancyGuard {
    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotOwner();
    error NotKeeper();
    error ZeroAddress();
    error ZeroAmount();
    error SameVenue();
    error BadProof(uint16 venueId);
    error DwellNotElapsed(uint64 readyAt);
    error NoEdge(uint32 fromNetApyBps, uint32 toNetApyBps);
    error PaybackTooLong(uint256 lhs, uint256 rhs);
    error ApyOutOfBounds(uint32 netApyBps, uint32 maxBps);
    error CostOutOfBounds(uint256 estCostUsdc, uint256 amount);
    error NoExecutor(uint16 venueId);
    error ScoresStale(uint256 age, uint256 maxAge);
    error RemoteVenueMustReturnFirst(uint16 venueId);

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event Rebalanced(
        uint16 indexed fromVenue,
        uint16 indexed toVenue,
        uint256 amount,
        uint32 fromNetApyBps,
        uint32 toNetApyBps,
        uint256 estCostUsdc,
        uint256 paybackDaysScaled
    );
    event RebalanceDeclined(uint16 indexed fromVenue, uint16 indexed toVenue, bytes4 reason);
    event CapitalReturned(uint16 indexed venueId, uint256 requested, uint256 recovered);
    event VenueWrittenOff(uint16 indexed venueId, uint256 writtenOff);
    event BridgeInFlight(uint16 indexed venueId, uint256 amount);
    event BridgeConfirmed(uint16 indexed venueId);
    event BridgeReturned(uint16 indexed venueId, uint256 amount);
    event ExecutorSet(uint16 indexed venueId, address indexed executor);
    event ConfigChanged(uint32 expectedHoldDays, uint64 minDwell, uint32 maxNetApyBps);
    event KeeperChanged(address indexed previous, address indexed next);

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 private constant BPS = 10_000;
    uint256 private constant DAYS_PER_YEAR = 365;

    /// @notice Hysteresis κ = NUM/DEN = 1.75, inside §7.5's [1.5, 2.0] band and
    ///         matching the off-chain `DEFAULT_KAPPA`.
    /// @dev §5.3: "Without it the vault flip-flops and bleeds fees."
    uint256 public constant HYSTERESIS_NUM = 7;
    uint256 public constant HYSTERESIS_DEN = 4;

    /// @notice Scores older than this cannot authorize a move (§10.2:
    ///         "Score oracle offline → Vault holds; no rebalance is always a
    ///         valid state").
    uint256 public constant MAX_SCORE_AGE = 2 hours;

    // -----------------------------------------------------------------------
    // Immutables — §8.2: "immutable / constant ... turns an SLOAD (2,100 cold)
    // into a PUSH."
    // -----------------------------------------------------------------------

    LPVault public immutable vault;
    ScoreOracle public immutable scoreOracle;

    // -----------------------------------------------------------------------
    // Config (one slot)
    // -----------------------------------------------------------------------

    struct Config {
        uint32 expectedHoldDays; // `H_expected_hold` from §7.5
        uint64 minDwell; // §5.3's MIN_DWELL
        uint32 maxNetApyBps; // sanity bound on reporter-supplied APY
        uint16 maxCostBps; // sanity bound on cost as a share of amount
    }

    Config public config;

    address public owner;
    address public keeper;

    mapping(uint16 venueId => IVenueExecutor) public executors;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(LPVault vault_, ScoreOracle scoreOracle_, address owner_, address keeper_) {
        if (owner_ == address(0) || keeper_ == address(0)) revert ZeroAddress();
        vault = vault_;
        scoreOracle = scoreOracle_;
        owner = owner_;
        keeper = keeper_;
        config = Config({
            expectedHoldDays: 7,
            minDwell: 12 hours,
            // 1,000% APR. Anything above this from a reporter is a data bug,
            // not a yield — §3: "On-chain sanity bounds."
            maxNetApyBps: 100_000,
            // A move costing more than 5% of the amount is never rational.
            maxCostBps: 500
        });
    }

    // -----------------------------------------------------------------------
    // The switch rule
    // -----------------------------------------------------------------------

    /// @notice Does this move clear the payback hurdle?
    ///
    /// §7.5:
    ///     H_breakeven = 365 × cost / (A × ΔAPR)
    ///     SWITCH iff  H_expected_hold > H_breakeven × κ
    ///
    /// @dev Two deliberate departures from the snippet printed in §5.3, both
    ///      required for it to work at all:
    ///
    ///      1. That snippet computes
    ///           `(365 * cost * 10_000) / (amount * deltaApyBps / 10_000)`
    ///         which carries an extra factor of 10,000 — for §7.5's own worked
    ///         example ($1,000 at ΔAPR 3%, cost $2) it yields 243,333 days
    ///         where §7.5 says ~24. Every rebalance would fail "no edge".
    ///
    ///      2. Computing `paybackDays` as an integer at all destroys the
    ///         signal exactly where the vault most wants to act: at $50,000
    ///         the true payback is 0.49 days, which truncates to 0.
    ///
    ///      Both vanish by cross-multiplying the inequality instead of
    ///      evaluating the quotient:
    ///
    ///        payback × κ ≤ hold
    ///          ⇔ (365 · cost · BPS)/(A · ΔBps) × NUM/DEN ≤ hold
    ///          ⇔ 365 · cost · BPS · NUM ≤ hold · DEN · A · ΔBps
    ///
    ///      No division, so no truncation, and it is cheaper than the original
    ///      (one DIV saved). Checked arithmetic throughout: the operands are
    ///      keeper-supplied, and reverting on overflow is the safe outcome.
    ///
    /// @return ok Whether the move clears the hurdle.
    /// @return lhs Left side of the cross-multiplied inequality.
    /// @return rhs Right side.
    function checkPayback(uint256 amount, uint256 estCostUsdc, uint256 deltaApyBps)
        public
        view
        returns (bool ok, uint256 lhs, uint256 rhs)
    {
        lhs = DAYS_PER_YEAR * estCostUsdc * BPS * HYSTERESIS_NUM;
        rhs = uint256(config.expectedHoldDays) * HYSTERESIS_DEN * amount * deltaApyBps;
        ok = lhs <= rhs;
    }

    /// @notice `H_breakeven` in days, scaled by 1e18 so the fractional part
    ///         survives. View-only, for keepers and the UI — the accept/reject
    ///         decision uses {checkPayback}, which never divides.
    function paybackDaysScaled(uint256 amount, uint256 estCostUsdc, uint256 deltaApyBps)
        public
        pure
        returns (uint256)
    {
        if (amount == 0 || deltaApyBps == 0) return type(uint256).max;
        return (DAYS_PER_YEAR * estCostUsdc * BPS * 1e18) / (amount * deltaApyBps);
    }

    // -----------------------------------------------------------------------
    // Rebalance
    // -----------------------------------------------------------------------

    /// @notice Move capital between venues, if and only if the edge repays the
    ///         cost over the expected holding period.
    ///
    /// @dev Check ordering follows §8.3 — "Cheapest checks first ... MIN_DWELL
    ///      timestamp check before Merkle verification before any external
    ///      call" — with one improvement: the payback inequality is pure
    ///      arithmetic over calldata, cheaper than the dwell check's storage
    ///      read, so it runs first and rejects most bad proposals before any
    ///      SLOAD at all.
    function rebalance(
        uint16 fromVenue,
        uint16 toVenue,
        uint256 amount,
        uint32 toNetApyBps,
        uint32 fromNetApyBps,
        uint256 estCostUsdc,
        uint32 toScoreBps,
        bytes32[] calldata proof,
        bytes calldata exitData,
        bytes calldata enterData
    ) external onlyKeeper nonReentrant {
        // --- Tier 1: pure calldata checks, no storage touched ---------------
        if (amount == 0) revert ZeroAmount();
        if (fromVenue == toVenue) revert SameVenue();
        if (toNetApyBps <= fromNetApyBps) revert NoEdge(fromNetApyBps, toNetApyBps);

        Config memory cfg = config;
        if (toNetApyBps > cfg.maxNetApyBps) revert ApyOutOfBounds(toNetApyBps, cfg.maxNetApyBps);
        if (estCostUsdc * BPS > amount * cfg.maxCostBps) {
            revert CostOutOfBounds(estCostUsdc, amount);
        }

        uint256 deltaApyBps;
        unchecked {
            // `toNetApyBps > fromNetApyBps` was established above.
            deltaApyBps = toNetApyBps - fromNetApyBps;
        }

        (bool ok, uint256 lhs, uint256 rhs) = checkPayback(amount, estCostUsdc, deltaApyBps);
        if (!ok) revert PaybackTooLong(lhs, rhs);

        // --- Tier 2: one storage read for the dwell check -------------------
        (, uint64 lastRebalanceAt,,,,) = vault.venues(fromVenue);
        uint64 readyAt;
        unchecked {
            readyAt = lastRebalanceAt + cfg.minDwell;
        }
        if (block.timestamp < readyAt) revert DwellNotElapsed(readyAt);

        // --- Tier 3: external calls, proof verification ---------------------
        uint256 age = scoreOracle.scoreAge();
        if (age > MAX_SCORE_AGE) revert ScoresStale(age, MAX_SCORE_AGE);

        if (!scoreOracle.verifyScore(toVenue, toScoreBps, toNetApyBps, proof)) {
            revert BadProof(toVenue);
        }

        // --- Execute --------------------------------------------------------
        IVenueExecutor fromExecutor = executors[fromVenue];
        IVenueExecutor toExecutor = executors[toVenue];
        if (address(toExecutor) == address(0)) revert NoExecutor(toVenue);

        uint256 recovered = amount;
        if (address(fromExecutor) != address(0)) {
            // A rebalance is exit-then-enter in one transaction, and an
            // asynchronous venue cannot do the exit half: nothing here can
            // reach into a position on another chain and pull it back. The
            // executor already answers this — `deployIdle` consults
            // `isSynchronous()` to flag capital in flight — but `rebalance` did
            // not, so every remote→remote move reached
            // `CctpBridgeExecutor.exit` and died on its refusal instead.
            //
            // Asking here changes which contract says no, and what it says.
            // `IVenueExecutor.exit` is documented to return what it recovered,
            // "which may be less than requested for a cross-chain leg still in
            // flight" — a promise a bridge cannot keep — so a keeper reading
            // that revert sees an executor breaking its own interface. The
            // policy is the plainer statement: capital comes home first
            // (`recordBridgeArrival`), then goes back out (`deployIdle`).
            if (!fromExecutor.isSynchronous()) revert RemoteVenueMustReturnFirst(fromVenue);
            recovered = fromExecutor.exit(fromVenue, amount, exitData);
        }

        // Re-check the economics against what ACTUALLY came back. The gate
        // above ran on the caller's claimed `amount`, and a venue can return
        // less — a position partly out of range, or simply less deployed than
        // the keeper asserted. Without this, a keeper passes the payback test
        // by naming a large amount and then moves a fraction of it, which is
        // precisely the churn §5.3 exists to prevent: at $1m a $2 move repays
        // in 0.02 days, at $1k it needs 24.
        if (recovered != amount) {
            (bool stillOk,, ) = checkPayback(recovered, estCostUsdc, deltaApyBps);
            if (!stillOk) revert PaybackTooLong(recovered, amount);
        }

        vault.recordReturn(fromVenue, recovered);
        vault.transferToExecutor(address(toExecutor), recovered);
        vault.recordDeploy(toVenue, recovered, toScoreBps);
        toExecutor.enter(toVenue, recovered, enterData);

        emit Rebalanced(
            fromVenue,
            toVenue,
            recovered,
            fromNetApyBps,
            toNetApyBps,
            estCostUsdc,
            paybackDaysScaled(recovered, estCostUsdc, deltaApyBps)
        );
    }

    /// @notice Deploy idle vault capital into a venue for the first time.
    /// @dev No payback test: there is no `from` venue to compare against and
    ///      no exit cost being paid. The score proof and caps still apply.
    function deployIdle(
        uint16 venueId,
        uint256 amount,
        uint32 netApyBps,
        uint32 scoreBps,
        bytes32[] calldata proof,
        bytes calldata enterData
    ) external onlyKeeper nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Config memory cfg = config;
        if (netApyBps > cfg.maxNetApyBps) revert ApyOutOfBounds(netApyBps, cfg.maxNetApyBps);

        uint256 age = scoreOracle.scoreAge();
        if (age > MAX_SCORE_AGE) revert ScoresStale(age, MAX_SCORE_AGE);
        if (!scoreOracle.verifyScore(venueId, scoreBps, netApyBps, proof)) revert BadProof(venueId);

        IVenueExecutor executor = executors[venueId];
        if (address(executor) == address(0)) revert NoExecutor(venueId);

        vault.transferToExecutor(address(executor), amount);
        vault.recordDeploy(venueId, amount, scoreBps);
        executor.enter(venueId, amount, enterData);

        // An asynchronous executor has burned the capital, not deployed it —
        // it is in flight and claimable nowhere until the destination mints.
        // Flagging it makes that state visible on-chain instead of leaving it
        // indistinguishable from capital sitting safely in a position.
        if (!executor.isSynchronous()) {
            vault.setVenuePending(venueId, true);
            emit BridgeInFlight(venueId, amount);
        }
    }

    /// @notice Book capital that has bridged back and clear the in-flight
    ///         flag, completing the round trip.
    /// @dev The counterpart to `returnToVault` for an asynchronous venue.
    ///      That path calls `executor.exit()`, which a bridge executor
    ///      refuses because nothing here can unwind a position on another
    ///      chain. Capital instead arrives as a CCTP mint, and this records
    ///      it — bounded by what actually landed.
    function recordBridgeArrival(uint16 venueId, uint256 amount)
        external
        onlyKeeper
        returns (uint256 booked)
    {
        if (amount == 0) revert ZeroAmount();
        booked = vault.recordBridgeArrival(venueId, amount);
        vault.setVenuePending(venueId, false);
        emit BridgeReturned(venueId, booked);
    }

    /// @notice Clear a venue's in-flight flag once the destination confirms.
    /// @dev Keeper-driven because only off-chain observation can see the
    ///      destination mint. Arc has no way to verify it itself.
    function confirmArrival(uint16 venueId) external onlyKeeper {
        vault.setVenuePending(venueId, false);
        emit BridgeConfirmed(venueId);
    }

    /// @notice Bring capital back from a venue to the vault.
    ///
    /// @dev The operation the Router was missing. `deployIdle` sends capital
    ///      out and `rebalance` moves it between venues, but neither returns
    ///      it — and `rebalance` cannot be bent into doing so, since it
    ///      requires a distinct destination venue and a positive APR edge.
    ///
    ///      Without this, capital was one-way. `claimWithdraw` pays from idle
    ///      and `settleEpoch` assumes the capital came home, but nothing could
    ///      bring it home: every deposit that had been deployed was
    ///      unrecoverable. Found by running the full deposit → deploy →
    ///      withdraw cycle on Base Sepolia rather than by reading the code.
    ///
    ///      Deliberately has no payback test. There is no destination venue to
    ///      compare against and no edge to evaluate — this exists to satisfy
    ///      withdrawals, and gating an exit on profitability is how a vault
    ///      traps its depositors. Dwell is not enforced either, for the same
    ///      reason: a queue that has to wait 12 hours because capital moved
    ///      recently is a queue that fails when it matters.
    /// @param finalize Whether the position is fully closed. When true, any
    ///        book value the venue still claims after the return is written
    ///        off as a realized loss. Without this the residual keeps the
    ///        vault looking solvent, coverage stays at 100%, and withdrawals
    ///        revert `InsufficientIdle` rather than settling slightly short.
    function returnToVault(
        uint16 venueId,
        uint256 amount,
        bytes calldata exitData,
        bool finalize
    ) external onlyKeeper nonReentrant returns (uint256 recovered) {
        if (amount == 0) revert ZeroAmount();

        IVenueExecutor executor = executors[venueId];
        if (address(executor) == address(0)) revert NoExecutor(venueId);

        recovered = executor.exit(venueId, amount, exitData);
        vault.recordReturn(venueId, recovered);

        if (finalize) {
            uint256 writtenOff = vault.recordVenueClosed(venueId);
            if (writtenOff > 0) emit VenueWrittenOff(venueId, writtenOff);
        }

        emit CapitalReturned(venueId, amount, recovered);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function setExecutor(uint16 venueId, IVenueExecutor executor) external onlyOwner {
        executors[venueId] = executor;
        emit ExecutorSet(venueId, address(executor));
    }

    function setConfig(
        uint32 expectedHoldDays,
        uint64 minDwell,
        uint32 maxNetApyBps,
        uint16 maxCostBps
    ) external onlyOwner {
        if (expectedHoldDays == 0) revert ZeroAmount();
        config = Config({
            expectedHoldDays: expectedHoldDays,
            minDwell: minDwell,
            maxNetApyBps: maxNetApyBps,
            maxCostBps: maxCostBps
        });
        emit ConfigChanged(expectedHoldDays, minDwell, maxNetApyBps);
    }

    function setKeeper(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit KeeperChanged(keeper, next);
        keeper = next;
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        owner = next;
    }
}
