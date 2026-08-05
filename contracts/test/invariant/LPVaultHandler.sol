// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LPVault} from "../../src/LPVault.sol";
import {MockUSDC} from "../Fixtures.sol";

/// @title LPVaultHandler
/// @notice The action space the invariant fuzzer explores.
///
///         A raw fuzzer pointed at the vault would spend its whole budget on
///         reverts — unauthorized callers, zero amounts, claims for requests
///         that were never made. The handler constrains calls to the shapes a
///         real user or keeper could produce, so the fuzzer spends its time on
///         *sequences* instead of on argument validity. Sequencing is where
///         accounting bugs live.
///
///         Ghost variables track what the aggregates SHOULD be, computed
///         independently of the vault's own arithmetic. An invariant that read
///         the vault's numbers to check the vault's numbers would prove
///         nothing.
contract LPVaultHandler is CommonBase, StdCheats, StdUtils {
    LPVault public immutable vault;
    MockUSDC public immutable usdc;

    address public immutable owner;
    address public immutable reporter;
    address public immutable router;
    address public immutable operator;

    address[] public actors;
    uint16[] public venueIds;

    // --- ghosts: what the totals should be, tracked independently ----------

    /// @dev Every USDC unit ever deposited, less every unit ever claimed out.
    uint256 public ghost_depositedTotal;
    uint256 public ghost_claimedTotal;
    /// @dev Tokens sent to the vault without going through `deposit`.
    uint256 public ghost_donatedTotal;
    uint256 public ghost_rescuedTotal;
    /// @dev Set once a NAV report has marked the book, after which per-venue
    ///      book values and the reported aggregate legitimately diverge.
    bool public ghost_navWasReported;
    /// @dev Sum of `amount` passed to recordDeploy, less recordReturn.
    uint256 public ghost_venueBookTotal;

    // --- call counters, printed by the invariant summary -------------------

    mapping(bytes32 => uint256) public calls;

    modifier countCall(bytes32 name) {
        calls[name] += 1;
        _;
    }

    constructor(
        LPVault vault_,
        MockUSDC usdc_,
        address owner_,
        address reporter_,
        address router_,
        address operator_,
        address[] memory actors_,
        uint16[] memory venueIds_
    ) {
        vault = vault_;
        usdc = usdc_;
        owner = owner_;
        reporter = reporter_;
        router = router_;
        operator = operator_;
        actors = actors_;
        venueIds = venueIds_;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function venueCount() external view returns (uint256) {
        return venueIds.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _venue(uint256 seed) internal view returns (uint16) {
        return venueIds[seed % venueIds.length];
    }

    // -----------------------------------------------------------------------
    // Depositor actions
    // -----------------------------------------------------------------------

    function deposit(uint256 actorSeed, uint256 amount) external countCall("deposit") {
        address actor = _actor(actorSeed);
        amount = bound(amount, 1e6, 100_000e6);

        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(vault), amount);
        try vault.deposit(amount, actor) {
            ghost_depositedTotal += amount;
        } catch {}
        vm.stopPrank();
    }

    function requestWithdraw(uint256 actorSeed, uint256 sharesSeed)
        external
        countCall("requestWithdraw")
    {
        address actor = _actor(actorSeed);
        uint256 held = vault.balanceOf(actor);
        if (held == 0) return;
        uint256 shares = bound(sharesSeed, 1, held);

        vm.prank(actor);
        // May revert with ClaimPendingFirst, which is the designed behaviour
        // when a settled request is still unclaimed.
        try vault.requestWithdraw(shares) {} catch {}
    }

    function claimWithdraw(uint256 actorSeed) external countCall("claimWithdraw") {
        address actor = _actor(actorSeed);
        (uint128 owed, uint16 epoch,) = vault.pendingOf(actor);
        if (owed == 0) return;

        uint256 requestId = vault.encodeRequestId(actor, epoch);
        vm.prank(actor);
        try vault.claimWithdraw(requestId) returns (uint256 paid) {
            ghost_claimedTotal += paid;
        } catch {}
    }

    // -----------------------------------------------------------------------
    // Operator / reporter actions
    // -----------------------------------------------------------------------

    function settleEpoch() external countCall("settleEpoch") {
        vm.prank(operator);
        try vault.settleEpoch() {} catch {}
    }

    /// @dev Bounded to what the contract will accept, so the fuzzer explores
    ///      accepted reports rather than bouncing off the guard.
    function reportNav(uint256 deltaSeed, bool up) external countCall("reportNav") {
        uint256 current = vault.deployedAssets();
        if (current == 0) return;

        uint256 maxDelta = (current * vault.MAX_NAV_DELTA_BPS()) / 10_000;
        if (maxDelta == 0) return;
        uint256 delta = bound(deltaSeed, 0, maxDelta);
        uint256 next = up ? current + delta : current - delta;

        vm.warp(block.timestamp + vault.NAV_COOLDOWN() + 1);
        vm.prank(reporter);
        try vault.reportNav(uint128(next)) {
            ghost_navWasReported = true;
        } catch {}
    }

    // -----------------------------------------------------------------------
    // Router actions — capital in and out of venues
    // -----------------------------------------------------------------------

    function deployToVenue(uint256 venueSeed, uint256 amountSeed)
        external
        countCall("deployToVenue")
    {
        uint16 venueId = _venue(venueSeed);
        uint256 idle = vault.idleAssets();
        (, uint128 pending) = vault.assets();
        uint256 spendable = idle > pending ? idle - pending : 0;
        if (spendable == 0) return;

        uint256 amount = bound(amountSeed, 1, spendable);

        // The Router does these two together; the executor is a plain address
        // here so the tokens simply land there.
        vm.startPrank(router);
        try vault.transferToExecutor(address(this), amount) {
            try vault.recordDeploy(venueId, amount, 5_000) {
                ghost_venueBookTotal += amount;
            } catch {
                // Deploy accounting failed after the transfer: hand it back so
                // the token ledger stays consistent with the vault's books.
                usdc.transfer(address(vault), amount);
            }
        } catch {}
        vm.stopPrank();
    }

    function returnFromVenue(uint256 venueSeed, uint256 amountSeed)
        external
        countCall("returnFromVenue")
    {
        uint16 venueId = _venue(venueSeed);
        (uint128 deployed,,,,,) = vault.venues(venueId);
        if (deployed == 0) return;

        uint256 amount = bound(amountSeed, 1, deployed);
        uint256 held = usdc.balanceOf(address(this));
        if (held < amount) return;

        // A real executor transfers first, then the Router records it.
        usdc.transfer(address(vault), amount);
        vm.prank(router);
        try vault.recordReturn(venueId, amount) {
            ghost_venueBookTotal -= amount;
        } catch {
            usdc.mint(address(this), amount); // keep the handler solvent
        }
    }

    // -----------------------------------------------------------------------
    // Adversarial actions
    // -----------------------------------------------------------------------

    /// @dev The ERC-4626 donation vector: send tokens straight to the vault.
    function donate(uint256 amountSeed) external countCall("donate") {
        uint256 amount = bound(amountSeed, 1, 50_000e6);
        usdc.mint(address(this), amount);
        usdc.transfer(address(vault), amount);
        ghost_donatedTotal += amount;
    }

    function syncIdle() external countCall("syncIdle") {
        vm.prank(owner);
        try vault.syncIdle() returns (uint256 recovered) {
            ghost_depositedTotal += recovered; // now part of accounted equity
            ghost_donatedTotal -= recovered;
        } catch {}
    }

    function rescueUnaccounted() external countCall("rescueUnaccounted") {
        vm.prank(owner);
        try vault.rescueUnaccounted(owner) returns (uint256 amount) {
            ghost_rescuedTotal += amount;
            ghost_donatedTotal -= amount;
        } catch {}
    }

    /// @dev Lets the fuzzer explore epoch boundaries and cooldowns.
    function warp(uint256 secondsSeed) external countCall("warp") {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 7 days));
    }

    receive() external payable {}
}
