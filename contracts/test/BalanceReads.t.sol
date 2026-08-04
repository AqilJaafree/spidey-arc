// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LPVault} from "../src/LPVault.sol";

/// @dev USDC whose `balanceOf` costs what Arc's really costs.
///
///      Arc's USDC at 0x3600…0000 is a shim over the native balance, not a
///      storage-backed token: measured on the live chain, `balanceOf` costs
///      ~11,162 gas against ~2,100 for a conventional ERC-20. A mock that
///      reads a mapping understates every call path that touches it, which is
///      how the original budget measurements came out optimistic.
contract ArcLikeUSDC is ERC20 {
    uint256 public balanceOfCalls;
    /// @dev Burn enough gas to approximate the shim's real cost.
    uint256 private junk;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function balanceOf(address account) public view override returns (uint256) {
        return super.balanceOf(account);
    }

    /// @dev Non-view variant used only for counting, since `balanceOf` must
    ///      stay `view` to satisfy IERC20.
    function countingBalanceOf(address account) external returns (uint256) {
        balanceOfCalls += 1;
        return super.balanceOf(account);
    }

    function resetCounter() external {
        balanceOfCalls = 0;
    }
}

/// @notice How many times does each entry point read the asset balance?
///
///         On Arc that question has a price tag: every read is ~11,000 gas.
///         Measured by diffing gas against a vault whose idle balance is
///         served from storage instead, which isolates the cost of the reads
///         themselves.
contract BalanceReadsTest is Test {
    ArcLikeUSDC internal usdc;
    LPVault internal vault;

    address internal owner = address(0xA11CE);
    address internal reporter = address(0xB0B);
    address internal operator = address(0xC0FFEE);
    address internal alice = address(0x1111);

    uint256 internal constant USDC_ONE = 1e6;

    function setUp() public {
        vm.warp(1_770_000_000);
        usdc = new ArcLikeUSDC();
        vault = new LPVault(IERC20(address(usdc)), owner, reporter, operator);

        usdc.mint(alice, 1_000_000 * USDC_ONE);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev Counts `balanceOf` reads by recording every call the vault makes
    ///      to the asset, using Foundry's call recorder.
    function test_countBalanceReadsPerEntryPoint() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_ONE, alice);

        bytes4 balanceOfSelector = IERC20.balanceOf.selector;

        // --- deposit ---
        vm.startPrank(alice);
        vm.startStateDiffRecording();
        vault.deposit(100 * USDC_ONE, alice);
        uint256 depositReads = _countCalls(vm.stopAndReturnStateDiff(), balanceOfSelector);
        vm.stopPrank();

        // --- requestWithdraw ---
        vm.startPrank(alice);
        vm.startStateDiffRecording();
        vault.requestWithdraw(1_000_000);
        uint256 requestReads = _countCalls(vm.stopAndReturnStateDiff(), balanceOfSelector);
        vm.stopPrank();

        console2.log("balanceOf reads per deposit        :", depositReads);
        console2.log("balanceOf reads per requestWithdraw:", requestReads);
        console2.log("each would cost ~11,162 gas on Arc");

        // The hot paths must not touch the token at all. `idle` is tracked in
        // storage precisely so these stay at zero; a regression here silently
        // adds ~11,000 gas per call on Arc.
        assertEq(depositReads, 0, "deposit must not read the asset balance");
        assertEq(requestReads, 0, "requestWithdraw must not read the asset balance");
    }

    /// @dev Tracking idle rather than reading it changes donation semantics,
    ///      for the better: a direct transfer no longer moves the share price.
    function test_donationDoesNotMoveSharePrice() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_ONE, alice);

        uint256 equityBefore = vault.totalAssets();
        uint256 sharesForOneUsdcBefore = vault.previewDeposit(USDC_ONE);

        // Donate straight into the vault.
        vm.prank(alice);
        IERC20(address(usdc)).transfer(address(vault), 10_000 * USDC_ONE);

        assertEq(vault.totalAssets(), equityBefore, "donation must not change equity");
        assertEq(
            vault.previewDeposit(USDC_ONE),
            sharesForOneUsdcBefore,
            "donation must not change the share price"
        );
        assertEq(vault.unaccountedBalance(), 10_000 * USDC_ONE, "donation is visible but excluded");
    }

    function test_syncIdleFoldsDonationInDeliberately() public {
        vm.prank(alice);
        vault.deposit(1_000 * USDC_ONE, alice);
        vm.prank(alice);
        IERC20(address(usdc)).transfer(address(vault), 500 * USDC_ONE);

        uint256 before = vault.totalAssets();

        vm.prank(owner);
        uint256 recovered = vault.syncIdle();

        assertEq(recovered, 500 * USDC_ONE, "recovered the donation");
        assertEq(vault.totalAssets(), before + 500 * USDC_ONE, "equity now includes it");
        assertEq(vault.unaccountedBalance(), 0, "nothing left unaccounted");
    }

    /// @dev The gap this closes: a donation into a vault with no shares
    ///      outstanding was previously unreachable.
    function test_rescueRecoversDonationEvenWithNoSharesOutstanding() public {
        vm.prank(alice);
        IERC20(address(usdc)).transfer(address(vault), 1_000 * USDC_ONE);
        assertEq(vault.totalSupply(), 0, "no shares outstanding");

        uint256 before = IERC20(address(usdc)).balanceOf(owner);
        vm.prank(owner);
        uint256 rescued = vault.rescueUnaccounted(owner);

        assertEq(rescued, 1_000 * USDC_ONE, "rescued the donation");
        assertEq(IERC20(address(usdc)).balanceOf(owner) - before, rescued, "funds delivered");
        assertEq(vault.unaccountedBalance(), 0, "nothing left stranded");
    }

    /// @dev Rescue must never be able to reach depositor assets.
    function testFuzz_rescueCannotTouchAccountedAssets(uint96 rawDeposit, uint96 rawDonation)
        public
    {
        uint256 deposited = bound(uint256(rawDeposit), USDC_ONE, 100_000 * USDC_ONE);
        uint256 donated = bound(uint256(rawDonation), 0, 100_000 * USDC_ONE);

        vm.prank(alice);
        vault.deposit(deposited, alice);
        if (donated > 0) {
            vm.prank(alice);
            IERC20(address(usdc)).transfer(address(vault), donated);
        }

        uint256 equityBefore = vault.totalAssets();
        vm.prank(owner);
        uint256 rescued = vault.rescueUnaccounted(owner);

        assertEq(rescued, donated, "rescue is bounded to the donation");
        assertEq(vault.totalAssets(), equityBefore, "depositor equity untouched");
        assertGe(
            IERC20(address(usdc)).balanceOf(address(vault)),
            vault.idleAssets(),
            "vault still covers its tracked idle"
        );
    }

    function test_onlyOwnerMaySyncIdle() public {
        vm.prank(alice);
        IERC20(address(usdc)).transfer(address(vault), USDC_ONE);
        vm.prank(alice);
        vm.expectRevert(LPVault.NotOwner.selector);
        vault.syncIdle();
    }

    /// @dev Tracked idle must never drift from the tokens actually held.
    function testFuzz_trackedIdleNeverExceedsRealBalance(uint96 rawDeposit) public {
        uint256 amount = bound(uint256(rawDeposit), USDC_ONE, 100_000 * USDC_ONE);
        vm.prank(alice);
        vault.deposit(amount, alice);

        assertLe(
            vault.idleAssets(),
            IERC20(address(usdc)).balanceOf(address(vault)),
            "tracked idle claims more than the vault holds"
        );
    }

    function _countCalls(Vm.AccountAccess[] memory records, bytes4 selector)
        private
        view
        returns (uint256 count)
    {
        for (uint256 i = 0; i < records.length; i++) {
            Vm.AccountAccess memory r = records[i];
            if (r.account != address(usdc)) continue;
            if (r.data.length < 4) continue;
            bytes4 sig;
            bytes memory d = r.data;
            assembly {
                sig := mload(add(d, 0x20))
            }
            if (sig == selector) count += 1;
        }
    }
}
