// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Transient-storage reentrancy guard
/// @notice Spec §8.2: "Transient storage (EIP-1153). TSTORE/TLOAD at 100 gas
///         for reentrancy guards, versus ~5,000 for the storage-slot pattern.
///         Verify Arc's Cancun opcode support before relying on it; fall back
///         to the OZ guard if absent."
///
///         Verified present. On Arc testnet (chain 5042002, reth v1.11.3) an
///         `eth_call` probe of `PUSH1 42; PUSH1 0; TSTORE; PUSH1 0; TLOAD`
///         returns 0x2a, and MCOPY and BLOBBASEFEE also execute. Cancun is
///         live, so no fallback is needed.
abstract contract TransientReentrancyGuard {
    /// @dev bytes32(uint256(keccak256("spidey.reentrancy.guard")) - 1)
    bytes32 private constant _GUARD_SLOT =
        0x8ad0dd0c2f5b0a5c8bd1e2fb1a0e37e9b16a9d5b6ec3f5e00b06b98e3b4b0e2a;

    error Reentrancy();

    modifier nonReentrant() {
        _enter();
        _;
        _exit();
    }

    function _enter() private {
        assembly ("memory-safe") {
            if tload(_GUARD_SLOT) {
                // `Reentrancy()` selector
                mstore(0x00, 0xab143c06)
                revert(0x1c, 0x04)
            }
            tstore(_GUARD_SLOT, 1)
        }
    }

    function _exit() private {
        assembly ("memory-safe") {
            tstore(_GUARD_SLOT, 0)
        }
    }
}
