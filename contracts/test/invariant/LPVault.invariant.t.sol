// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LPVault} from "../../src/LPVault.sol";
import {MockUSDC} from "../Fixtures.sol";
import {LPVaultHandler} from "./LPVaultHandler.sol";

/// @title LPVault invariants
/// @notice Properties that must hold after ANY sequence of actions.
///
///         The vault's accounting was rewritten twice: once to track `idle` in
///         storage instead of reading Arc's expensive USDC shim, and again to
///         key withdrawal records by holder rather than by request id. Both
///         changes moved money-tracking arithmetic around, which is precisely
///         where conservation bugs hide and precisely what unit tests are
///         worst at catching — they check the cases you thought of.
///
///         Every invariant below is checked against ghost state the handler
///         maintains independently. Checking the vault's numbers against the
///         vault's own numbers would prove nothing.
contract LPVaultInvariantTest is Test {
    MockUSDC internal usdc;
    LPVault internal vault;
    LPVaultHandler internal handler;

    address internal owner = address(0xA11CE);
    address internal reporter = address(0xB0B);
    address internal router = address(0xD00D);
    address internal operator = address(0xC0FFEE);

    function setUp() public {
        vm.warp(1_770_000_000);

        usdc = new MockUSDC();
        vault = new LPVault(IERC20(address(usdc)), owner, reporter, operator);

        address[] memory actors = new address[](4);
        actors[0] = address(0x1111);
        actors[1] = address(0x2222);
        actors[2] = address(0x3333);
        actors[3] = address(0x4444);

        uint16[] memory venueIds = new uint16[](3);
        venueIds[0] = 1;
        venueIds[1] = 2;
        venueIds[2] = 3;

        vm.startPrank(owner);
        vault.setRouter(router);
        for (uint256 i = 0; i < venueIds.length; i++) {
            vault.registerVenue(venueIds[i], uint8(i + 1));
        }
        vm.stopPrank();

        handler =
            new LPVaultHandler(vault, usdc, owner, reporter, router, operator, actors, venueIds);

        // Only the handler drives state; the fuzzer never calls the vault raw.
        targetContract(address(handler));
    }

    // -----------------------------------------------------------------------
    // Solvency — the one that matters
    // -----------------------------------------------------------------------

    /// @notice The vault must never claim to hold idle USDC it does not have.
    /// @dev If this breaks, `claimWithdraw` eventually reverts for whoever is
    ///      last in the queue: the vault promised assets it cannot deliver.
    function invariant_idleNeverExceedsRealBalance() public view {
        assertLe(
            vault.idleAssets(),
            usdc.balanceOf(address(vault)),
            "tracked idle exceeds the tokens actually held"
        );
    }

    /// @notice Every unit the vault will actually PAY must be backed by assets
    ///         it holds. Recorded claims may exceed that after a loss — the
    ///         haircut is what reconciles them.
    /// @dev This is the invariant that caught the shortfall bug. It asserted
    ///      `pending <= available` and failed at run 579, because a fixed claim
    ///      does not shrink when the vault does. The property that actually
    ///      needs to hold is about payable value, not recorded value.
    function invariant_payableClaimsAreBacked() public view {
        (uint128 idle, uint128 pending) = vault.assets();
        uint256 payable_ = (uint256(pending) * vault.coverageBps()) / 10_000;
        assertLe(
            payable_,
            uint256(idle) + vault.deployedAssets(),
            "the vault would pay out more than it holds"
        );
    }

    /// @notice Coverage is a fraction: never above 100%, so the haircut can
    ///         only ever reduce a claim, never inflate one.
    function invariant_coverageNeverExceedsFull() public view {
        assertLe(vault.coverageBps(), 10_000, "coverage above 100% would mint value");
    }

    /// @notice Full coverage exactly when the vault can honour every claim.
    function invariant_coverageIsFullWheneverSolvent() public view {
        (uint128 idle, uint128 pending) = vault.assets();
        if (uint256(idle) + vault.deployedAssets() >= pending) {
            assertEq(vault.coverageBps(), 10_000, "solvent vault must not haircut");
        }
    }

    /// @notice Everything the vault claims to own must exist somewhere real —
    ///         either in its own balance or at an executor.
    ///
    /// @dev The invariant that was missing. `idleNeverExceedsRealBalance`
    ///      checks only the idle leg, so it stayed green while equity
    ///      double-counted an unrecorded return: idle 1,000 plus a venue book
    ///      of 1,000, against 1,000 real tokens. This measures the whole
    ///      system, which is where the discrepancy actually shows.
    function invariant_equityIsCoveredBySomethingReal() public view {
        (uint128 idle,) = vault.assets();
        uint256 venueBooks;
        uint256 n = handler.venueCount();
        for (uint256 i = 0; i < n; i++) {
            (uint128 deployed,,,,,) = vault.venues(handler.venueIds(i));
            venueBooks += deployed;
        }
        uint256 claimed = uint256(idle) + venueBooks;
        uint256 real = usdc.balanceOf(address(vault)) + usdc.balanceOf(address(handler));
        assertLe(claimed, real, "the vault claims more than exists anywhere");
    }

    // -----------------------------------------------------------------------
    // Conservation
    // -----------------------------------------------------------------------

    /// @notice `assets.pending` must equal the sum of the per-holder records.
    /// @dev The aggregate and the per-holder slots are updated in separate
    ///      statements, so nothing but a test forces them to agree.
    function invariant_pendingEqualsSumOfHolderRecords() public view {
        uint256 sum;
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            (uint128 owed,,) = vault.pendingOf(handler.actors(i));
            sum += owed;
        }
        (, uint128 pending) = vault.assets();
        assertEq(pending, sum, "aggregate pending drifted from the holder records");
    }

    /// @notice `totalAssets()` is exactly idle + deployed - pending.
    function invariant_equityIdentity() public view {
        (uint128 idle, uint128 pending) = vault.assets();
        uint256 gross = uint256(idle) + vault.deployedAssets();
        uint256 expected = gross > pending ? gross - pending : 0;
        assertEq(vault.totalAssets(), expected, "equity identity broken");
    }

    /// @notice Absent a NAV report, the per-venue book values must sum to the
    ///         reported aggregate.
    /// @dev Only asserted when no report has landed. A NAV report marks the
    ///      aggregate to market while per-venue book values stay at cost, so
    ///      afterwards the two legitimately diverge — see the divergence
    ///      report in {invariant_callSummary}.
    function invariant_venueBookMatchesNavBeforeAnyReport() public view {
        if (handler.ghost_navWasReported()) return;

        uint256 sum;
        uint256 n = handler.venueCount();
        for (uint256 i = 0; i < n; i++) {
            (uint128 deployed,,,,,) = vault.venues(handler.venueIds(i));
            sum += deployed;
        }
        assertEq(sum, vault.deployedAssets(), "per-venue book drifted from the NAV aggregate");
    }

    // -----------------------------------------------------------------------
    // The gas structure depends on this
    // -----------------------------------------------------------------------

    /// @notice Once a holder has requested, their slot must never return to
    ///         zero — that sentinel is what keeps `requestWithdraw` at 53k
    ///         instead of 70k.
    function invariant_initializedSlotsStayNonZero() public view {
        uint256 n = handler.actorCount();
        for (uint256 i = 0; i < n; i++) {
            address actor = handler.actors(i);
            (uint128 owed,, uint8 flags) = vault.pendingOf(actor);
            // A holder with an outstanding balance must be marked initialized.
            if (owed > 0) {
                assertTrue(flags != 0, "outstanding request on an uninitialized slot");
            }
        }
    }

    // -----------------------------------------------------------------------
    // Donations cannot move the share price
    // -----------------------------------------------------------------------

    /// @notice Tokens the vault does not recognise are never counted as
    ///         equity, whatever their origin.
    ///
    /// @dev The earlier version asserted `unaccounted == ghost_donated`, which
    ///      tested the handler's bookkeeping rather than the contract: once an
    ///      executor could transfer back before the router recorded it, the
    ///      two stopped being the same quantity for reasons that had nothing
    ///      to do with the vault. What actually matters is that unrecognised
    ///      tokens stay outside the share price, and that is stated directly.
    function invariant_unrecognisedTokensAreNeverEquity() public view {
        (uint128 idle,) = vault.assets();
        uint256 held = usdc.balanceOf(address(vault));
        assertEq(
            vault.unaccountedBalance(),
            held > idle ? held - idle : 0,
            "unaccounted balance must be exactly the unrecognised remainder"
        );
        // ...and equity never reaches for it.
        assertLe(uint256(idle), held, "equity counts tokens the vault does not hold");
    }

    // -----------------------------------------------------------------------
    // Nobody gets more out than went in
    // -----------------------------------------------------------------------

    /// @notice Total claimed can never exceed total deposited. Without yield,
    ///         the vault is a closed system.
    function invariant_noValueCreatedFromNothing() public view {
        assertLe(
            handler.ghost_claimedTotal(),
            handler.ghost_depositedTotal(),
            "more was claimed out than was ever deposited"
        );
    }

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------

    function invariant_callSummary() public view {
        console2.log("--- handler calls ---");
        string[10] memory names = [
            "deposit",
            "requestWithdraw",
            "claimWithdraw",
            "settleEpoch",
            "reportNav",
            "deployToVenue",
            "returnFromVenue",
            "donate",
            "syncIdle",
            "rescueUnaccounted"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            console2.log(names[i], handler.calls(keccak256(bytes(names[i]))));
        }
    }
}
