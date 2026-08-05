// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {
    UniV3Executor,
    ISwapRouter02,
    INonfungiblePositionManager
} from "../src/executors/UniV3Executor.sol";

/// @title The second deposit
/// @notice Positions are POOLED — one per venue, shared pro-rata through
///         ERC-4626 shares. `LPVault.recordDeploy` reflects that: it
///         accumulates into `venue.deployedAssets` and is happy to be called
///         repeatedly for the same venue.
///
///         `UniV3Executor.enter` did not. It reverted `PositionAlreadyOpen`
///         the moment a venue already held a position, so the vault could
///         deploy to a venue exactly once, ever. The second depositor's
///         capital would sit idle with no way to reach the pool it was
///         ranked into.
///
///         Fixed by topping up the existing position via `increaseLiquidity`
///         rather than minting a second one — which is also what "pooled"
///         should mean on-chain.
contract SecondDepositTest is Test {
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
        if (!forked) return;
        _;
    }

    function _enterParams(uint256 assets) private view returns (bytes memory) {
        (, int24 tick,,,,,) = _slot0(POOL_3000);
        return abi.encode(
            UniV3Executor.EnterParams({
                tickLower: ((tick - 200) / 60) * 60,
                tickUpper: ((tick + 200) / 60) * 60,
                swapAmountIn: assets / 2,
                swapAmountOutMin: 1,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + 300
            })
        );
    }

    /// @dev The case that was broken: a second depositor arrives and the vault
    ///      deploys into the same venue again.
    function test_secondDepositTopsUpTheSamePosition() public onlyForked {
        // First depositor's capital reaches the venue.
        deal(USDC, address(executor), 100e6);
        // Build params BEFORE pranking: `_enterParams` staticcalls the pool,
        // which would consume the prank and make `enter` revert NotRouter.
        bytes memory first = _enterParams(100e6);
        vm.prank(router);
        executor.enter(1, 100e6, first);

        uint256 tokenId = executor.positionOf(1);
        assertGt(tokenId, 0, "first deploy opened a position");
        (,,,,,,, uint128 liquidityAfterFirst,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);

        // Second depositor. Same venue, same pooled position.
        deal(USDC, address(executor), 100e6);
        bytes memory second = _enterParams(100e6);
        vm.prank(router);
        executor.enter(1, 100e6, second);

        assertEq(executor.positionOf(1), tokenId, "must not mint a second position");

        (,,,,,,, uint128 liquidityAfterSecond,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        assertGt(
            liquidityAfterSecond,
            liquidityAfterFirst,
            "the pooled position must actually grow"
        );
    }

    /// @dev And the pooled position still unwinds in one call, paying back
    ///      both depositors' capital together.
    function test_pooledPositionExitsInOnePiece() public onlyForked {
        bytes memory p1 = _enterParams(100e6);
        deal(USDC, address(executor), 100e6);
        vm.prank(router);
        executor.enter(1, 100e6, p1);

        bytes memory p2 = _enterParams(100e6);
        deal(USDC, address(executor), 100e6);
        vm.prank(router);
        executor.enter(1, 100e6, p2);

        uint256 vaultBefore = IERC20(USDC).balanceOf(vault);

        vm.prank(router);
        uint256 returned = executor.exit(
            1,
            200e6,
            abi.encode(
                UniV3Executor.ExitParams({
                    unwindBps: 10_000,
                    amount0Min: 0,
                    amount1Min: 0,
                    swapAmountOutMin: 1,
                    deadline: block.timestamp + 300
                })
            )
        );

        assertEq(executor.positionOf(1), 0, "position cleared");
        assertEq(IERC20(USDC).balanceOf(vault) - vaultBefore, returned, "vault received it");
        // Two round trips through a 0.3% pool: ~60bp of fees, plus slippage.
        assertGt(returned, (200e6 * 95) / 100, "round trip lost more than 5%");
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
