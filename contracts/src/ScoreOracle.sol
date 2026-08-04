// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title ScoreOracle
/// @notice Spec §5.2. Stores a Merkle root of
///         `(venueId, scoreBps, netApyBps, timestamp)` leaves, not per-venue rows.
///
///         §8.1 rationale: "Posting N venue scores as N storage writes costs
///         N × ~20,000. Posting one root costs ~5,000 total and the proof
///         verification (~1,000 gas per level) is paid by the caller who
///         benefits. At 40 venues this is ~800k gas saved per epoch."
///
///         The full leaf set is published off-chain and its URI is carried in
///         the event, so anyone can rebuild the tree and check the root. That
///         is the mitigation named in §3's trust table: the operator could
///         post bad scores, so the inputs must be public and the on-chain
///         sanity bounds must hold regardless.
contract ScoreOracle {
    // -----------------------------------------------------------------------
    // Errors — §8.2: "Custom errors, not revert strings."
    // -----------------------------------------------------------------------

    error NotReporter();
    error NotOwner();
    error ZeroAddress();
    error EmptyRoot();
    error EpochNotAdvanced();
    error AsOfInFuture();
    error AsOfTooOld();

    // -----------------------------------------------------------------------
    // Events — §8.1: "Events instead of storage for history."
    // -----------------------------------------------------------------------

    event ScoresPosted(uint64 indexed epoch, bytes32 root, uint64 asOf, string leavesUri);
    event ReporterChanged(address indexed previous, address indexed next);
    event OwnerChanged(address indexed previous, address indexed next);

    // -----------------------------------------------------------------------
    // Config
    // -----------------------------------------------------------------------

    /// @notice Reject score sets observed longer ago than this (§10.2:
    ///         "Staleness threshold per source; exclude, never extrapolate").
    uint64 public constant MAX_AS_OF_AGE = 1 hours;

    address public owner;
    address public reporter;

    // -----------------------------------------------------------------------
    // State — two slots, both kept non-zero (§8.1: "Never write zero").
    // -----------------------------------------------------------------------

    /// @notice Current Merkle root. Seeded to a sentinel so the first real
    ///         post pays the 5,000-gas non-zero→non-zero cost rather than the
    ///         20,000-gas zero→non-zero cost.
    bytes32 public root;

    struct Epoch {
        uint64 number; // starts at 1; 0 is never written
        uint64 asOf; // unix seconds the scores were observed
        uint128 postedAt; // block.timestamp of the post
    }

    Epoch public currentEpoch;

    modifier onlyReporter() {
        if (msg.sender != reporter) revert NotReporter();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address reporter_) {
        if (owner_ == address(0) || reporter_ == address(0)) revert ZeroAddress();
        owner = owner_;
        reporter = reporter_;

        // Seed both slots non-zero so the first `postScores` is a warm rewrite.
        root = bytes32(uint256(1));
        currentEpoch = Epoch({number: 1, asOf: 1, postedAt: 1});
    }

    // -----------------------------------------------------------------------
    // Reporting
    // -----------------------------------------------------------------------

    /// @notice Publish a new score set. One `SSTORE` per epoch regardless of
    ///         how many venues are ranked.
    /// @param newRoot Merkle root over the leaf encoding in {leafHash}.
    /// @param asOf Unix seconds at which the underlying data was observed.
    /// @param leavesUri Where the full leaf set is published, so the root is
    ///        checkable by anyone. Emitted, never stored.
    function postScores(bytes32 newRoot, uint64 asOf, string calldata leavesUri)
        external
        onlyReporter
        returns (uint64 epochNumber)
    {
        if (newRoot == bytes32(0)) revert EmptyRoot();
        if (asOf > block.timestamp) revert AsOfInFuture();
        unchecked {
            // `asOf <= block.timestamp` is established above, so this cannot
            // underflow.
            if (block.timestamp - asOf > MAX_AS_OF_AGE) revert AsOfTooOld();
        }

        Epoch memory epoch = currentEpoch;
        if (asOf <= epoch.asOf) revert EpochNotAdvanced();

        unchecked {
            // A uint64 epoch counter cannot realistically overflow.
            epochNumber = epoch.number + 1;
        }

        root = newRoot;
        currentEpoch = Epoch({
            number: epochNumber,
            asOf: asOf,
            postedAt: uint128(block.timestamp)
        });

        emit ScoresPosted(epochNumber, newRoot, asOf, leavesUri);
    }

    // -----------------------------------------------------------------------
    // Verification
    // -----------------------------------------------------------------------

    /// @notice The leaf encoding the off-chain tree builder must match.
    /// @dev Double-hashed, the standard OpenZeppelin/merkletreejs convention:
    ///      it makes a leaf preimage impossible to confuse with an internal
    ///      node, which is what stops a crafted proof from passing off an
    ///      internal node as a leaf.
    function leafHash(uint16 venueId, uint32 scoreBps, uint32 netApyBps, uint64 asOf)
        public
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(venueId, scoreBps, netApyBps, asOf))));
    }

    /// @notice Check a venue's score against the current root.
    /// @dev `asOf` is taken from stored epoch state rather than from the
    ///      caller, so a stale-but-valid proof from an earlier epoch cannot be
    ///      replayed against the current root.
    function verifyScore(
        uint16 venueId,
        uint32 scoreBps,
        uint32 netApyBps,
        bytes32[] calldata proof
    ) external view returns (bool) {
        return MerkleProof.verifyCalldata(
            proof, root, leafHash(venueId, scoreBps, netApyBps, currentEpoch.asOf)
        );
    }

    /// @notice Seconds since the current score set was observed.
    function scoreAge() external view returns (uint256) {
        uint64 asOf = currentEpoch.asOf;
        return block.timestamp > asOf ? block.timestamp - asOf : 0;
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function setReporter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit ReporterChanged(reporter, next);
        reporter = next;
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }
}
