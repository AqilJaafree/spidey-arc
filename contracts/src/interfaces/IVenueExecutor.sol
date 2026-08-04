// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IVenueExecutor
/// @notice The seam between routing policy and venue mechanics.
///
///         Spec §4: "App Kit covers movement, not positions. There is no
///         `openPosition()`. Venue adapters are ours." So the Router decides
///         *whether* to move and an executor decides *how*: an EVM executor
///         wraps App Kit's `bridge()` plus a Uniswap v3 position, and a Solana
///         leg wraps `deposit_for_burn_with_hook`.
///
///         Keeping this an interface is what lets §11's Day-2 items 5 and 6
///         land without touching the payback rule.
interface IVenueExecutor {
    /// @notice Deploy `assets` into `venueId`.
    /// @param data Venue-specific calldata built off-chain — tick range,
    ///        slippage bounds, bridge parameters. §9.2: "Pass computed values
    ///        in, verify cheaply." The executor validates bounds; it does not
    ///        recompute the strategy.
    function enter(uint16 venueId, uint256 assets, bytes calldata data) external;

    /// @notice Withdraw up to `assets` from `venueId` back toward the vault.
    /// @return returned Assets actually recovered, which may be less than
    ///         requested for a cross-chain leg still in flight.
    function exit(uint16 venueId, uint256 assets, bytes calldata data)
        external
        returns (uint256 returned);

    /// @notice Whether this executor settles synchronously. Cross-chain legs
    ///         return false, and the Router then treats the exit as pending
    ///         rather than assuming the capital is back.
    function isSynchronous() external view returns (bool);
}
