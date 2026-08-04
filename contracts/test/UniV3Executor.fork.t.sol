// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {
    UniV3Executor,
    ISwapRouter02,
    INonfungiblePositionManager
} from "../src/executors/UniV3Executor.sol";

/// @title UniV3Executor fork test
/// @notice §11 Day 2.6 — "One live EVM strategy: Uniswap v3 on Base Sepolia."
///
///         This runs against a real fork of Base Sepolia (chain 84532) using
///         the live factory, position manager and swap router, and the real
///         USDC/WETH 0.3% pool. Every address below was verified on-chain
///         before being written down:
///
///         | Contract              | Address                                    |
///         |-----------------------|--------------------------------------------|
///         | UniswapV3Factory      | 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 |
///         | NonfungiblePosManager | 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2 |
///         | SwapRouter02          | 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4 |
///         | USDC                  | 0x036CbD53842c5426634e7929541eC2318f3dCF7e |
///         | WETH                  | 0x4200000000000000000000000000000000000006 |
///
///         Skipped automatically when BASE_SEPOLIA_RPC_URL is unset, so the
///         default `forge test` stays offline and deterministic.
contract UniV3ExecutorForkTest is Test {
    address constant SWAP_ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
    address constant POSITION_MANAGER = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant POOL_3000 = 0x46880b404CD35c165EDdefF7421019F8dD25F4Ad;
    uint24 constant FEE = 3000;

    UniV3Executor internal executor;
    address internal owner = address(0xA11CE);
    address internal router = address(0xDEAD);
    address internal vault = address(0xBEEF);

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        forked = true;

        executor = new UniV3Executor(
            ISwapRouter02(SWAP_ROUTER),
            INonfungiblePositionManager(POSITION_MANAGER),
            IERC20(USDC),
            IERC20(WETH),
            FEE,
            owner
        );

        vm.startPrank(owner);
        executor.setRouter(router);
        executor.setVault(vault);
        vm.stopPrank();
    }

    modifier onlyForked() {
        if (!forked) {
            console2.log("SKIP: set BASE_SEPOLIA_RPC_URL to run the fork test");
            return;
        }
        _;
    }

    function test_fork_environmentIsWhatWeThinkItIs() public view onlyForked {
        assertEq(block.chainid, 84532, "not Base Sepolia");
        assertGt(USDC.code.length, 0, "USDC has no code");
        assertGt(POOL_3000.code.length, 0, "pool has no code");
        assertEq(IERC20Metadata(USDC).decimals(), 6, "USDC must be 6dp");
        assertTrue(executor.usdcIsToken0(), "USDC sorts before WETH, so it is token0");
    }

    /// @dev USDC (0x036c...) < WETH (0x4200...), so USDC really is token0.
    function test_fork_tokenOrdering() public view onlyForked {
        assertTrue(USDC < WETH, "address ordering assumption");
        assertTrue(executor.usdcIsToken0(), "executor must agree with sort order");
    }

    function test_fork_openAndClosePosition() public onlyForked {
        uint256 assets = 100e6; // $100 USDC
        deal(USDC, address(executor), assets);

        // A ±1% range around the current tick, snapped to the 0.3% pool's
        // 60-tick spacing. The engine computes this off-chain; the contract
        // only checks it (§9.2).
        (, int24 currentTick,,,,,) = _slot0(POOL_3000);
        int24 spacing = 60;
        int24 lower = ((currentTick - 200) / spacing) * spacing;
        int24 upper = ((currentTick + 200) / spacing) * spacing;

        UniV3Executor.EnterParams memory p = UniV3Executor.EnterParams({
            tickLower: lower,
            tickUpper: upper,
            swapAmountIn: assets / 2,
            swapAmountOutMin: 1, // a real keeper computes this from the quote
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 300
        });

        vm.prank(router);
        executor.enter(1, assets, abi.encode(p));

        uint256 tokenId = executor.positionOf(1);
        assertGt(tokenId, 0, "no position minted");

        (,,,,,,, uint128 liquidity,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        assertGt(liquidity, 0, "position has no liquidity");
        console2.log("opened tokenId", tokenId);
        console2.log("liquidity", uint256(liquidity));

        // Unwind fully and return USDC to the vault.
        UniV3Executor.ExitParams memory e = UniV3Executor.ExitParams({
            unwindBps: 10_000,
            amount0Min: 0,
            amount1Min: 0,
            swapAmountOutMin: 1,
            deadline: block.timestamp + 300
        });

        // Measure the DELTA, not the absolute balance: on a fork, a
        // hand-picked address can already hold the token. 0xBEEF really does
        // hold USDC on Base Sepolia.
        uint256 vaultBefore = IERC20(USDC).balanceOf(vault);

        vm.prank(router);
        uint256 returned = executor.exit(1, assets, abi.encode(e));

        assertGt(returned, 0, "nothing came back");
        assertEq(
            IERC20(USDC).balanceOf(vault) - vaultBefore, returned, "vault did not receive it"
        );
        assertEq(executor.positionOf(1), 0, "position not cleared");

        // Round-tripping through two 0.3% swaps costs ~0.6% plus slippage;
        // anything worse than 5% means the range or the split is wrong.
        assertGt(returned, (assets * 95) / 100, "round-trip lost more than 5%");
        console2.log("returned USDC", returned);
        console2.log("round-trip bps kept", (returned * 10_000) / assets);
    }

    function test_fork_rejectsUnboundedSlippage() public onlyForked {
        deal(USDC, address(executor), 100e6);
        (, int24 tick,,,,,) = _slot0(POOL_3000);

        UniV3Executor.EnterParams memory p = UniV3Executor.EnterParams({
            tickLower: ((tick - 200) / 60) * 60,
            tickUpper: ((tick + 200) / 60) * 60,
            swapAmountIn: 50e6,
            swapAmountOutMin: 0, // the bug this check exists for
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + 300
        });

        vm.prank(router);
        vm.expectRevert(UniV3Executor.UnboundedSlippage.selector);
        executor.enter(1, 100e6, abi.encode(p));
    }

    function test_fork_onlyRouterMayEnter() public onlyForked {
        deal(USDC, address(executor), 100e6);
        UniV3Executor.EnterParams memory p;
        p.deadline = block.timestamp + 300;

        vm.prank(address(0xBAD));
        vm.expectRevert(UniV3Executor.NotRouter.selector);
        executor.enter(1, 100e6, abi.encode(p));
    }

    function test_fork_rejectsExpiredDeadline() public onlyForked {
        deal(USDC, address(executor), 100e6);
        UniV3Executor.EnterParams memory p;
        p.deadline = block.timestamp - 1;

        vm.prank(router);
        vm.expectRevert(
            abi.encodeWithSelector(UniV3Executor.DeadlinePassed.selector, p.deadline)
        );
        executor.enter(1, 100e6, abi.encode(p));
    }

    function _slot0(address pool)
        private
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        (bool ok, bytes memory out) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        require(ok, "slot0 failed");
        return abi.decode(out, (uint160, int24, uint16, uint16, uint16, uint8, bool));
    }
}
