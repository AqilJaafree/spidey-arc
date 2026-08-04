// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {IVenueExecutor} from "../interfaces/IVenueExecutor.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external payable;

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

/// @title UniV3Executor
/// @notice Spec §11 Day 2.6 — "One live EVM strategy: Uniswap v3 on Base
///         Sepolia", and the concrete half of §4's "App Kit covers movement,
///         not positions. There is no `openPosition()`. Venue adapters are
///         ours."
///
///         The division of labour follows §9.2's rule, which applies just as
///         well on EVM as on Solana: "Pass computed values in, verify cheaply.
///         The scoring engine already computed target bins, amounts and
///         slippage bounds. The program validates bounds — it does not
///         recompute the strategy." So the tick range, the swap split and
///         every slippage floor arrive as calldata; this contract checks them
///         and refuses anything unbounded.
contract UniV3Executor is IVenueExecutor, IERC721Receiver {
    using SafeERC20 for IERC20;

    error NotRouter();
    error NotOwner();
    error ZeroAddress();
    error UnboundedSlippage();
    error NoPosition(uint16 venueId);
    error PositionAlreadyOpen(uint16 venueId);
    error DeadlinePassed(uint256 deadline);
    error InsufficientBalance(uint256 requested, uint256 available);
    error TickRangeInvalid(int24 lower, int24 upper);

    event PositionOpened(
        uint16 indexed venueId, uint256 indexed tokenId, uint128 liquidity, int24 lower, int24 upper
    );
    event PositionClosed(uint16 indexed venueId, uint256 indexed tokenId, uint256 usdcReturned);
    event FeesCollected(uint16 indexed venueId, uint256 amount0, uint256 amount1);

    /// @notice Parameters the scoring engine computes and this contract checks.
    struct EnterParams {
        int24 tickLower;
        int24 tickUpper;
        /// @dev USDC to swap into the paired token before minting.
        uint256 swapAmountIn;
        /// @dev Floor on the swap output. Zero is rejected outright.
        uint256 swapAmountOutMin;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct ExitParams {
        /// @dev Basis points of the position to unwind. 10_000 = all of it.
        uint16 unwindBps;
        uint256 amount0Min;
        uint256 amount1Min;
        /// @dev Floor on swapping the paired token back to USDC.
        uint256 swapAmountOutMin;
        uint256 deadline;
    }

    ISwapRouter02 public immutable swapRouter;
    INonfungiblePositionManager public immutable positionManager;
    IERC20 public immutable usdc;
    IERC20 public immutable pairedToken;
    /// @dev Pool fee tier in Uniswap units. 3000 = 0.3%.
    uint24 public immutable poolFee;
    /// @dev Whether USDC sorts first. Fixed at deploy; both tokens are known.
    bool public immutable usdcIsToken0;

    address public router;
    address public owner;

    mapping(uint16 venueId => uint256 tokenId) public positionOf;

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        ISwapRouter02 swapRouter_,
        INonfungiblePositionManager positionManager_,
        IERC20 usdc_,
        IERC20 pairedToken_,
        uint24 poolFee_,
        address owner_
    ) {
        if (owner_ == address(0)) revert ZeroAddress();
        swapRouter = swapRouter_;
        positionManager = positionManager_;
        usdc = usdc_;
        pairedToken = pairedToken_;
        poolFee = poolFee_;
        owner = owner_;
        usdcIsToken0 = address(usdc_) < address(pairedToken_);
    }

    /// @notice EVM legs settle in the same transaction, unlike the CCTP path.
    function isSynchronous() external pure override returns (bool) {
        return true;
    }

    // -----------------------------------------------------------------------
    // Enter
    // -----------------------------------------------------------------------

    /// @notice Swap part of the USDC into the paired token, then mint a
    ///         concentrated position over the supplied tick range.
    /// @dev The vault has already transferred `assets` USDC to this contract.
    function enter(uint16 venueId, uint256 assets, bytes calldata data)
        external
        override
        onlyRouter
    {
        EnterParams memory p = abi.decode(data, (EnterParams));

        if (block.timestamp > p.deadline) revert DeadlinePassed(p.deadline);
        if (p.tickLower >= p.tickUpper) revert TickRangeInvalid(p.tickLower, p.tickUpper);
        // An unbounded swap is a free lunch for whoever is watching the
        // mempool. The engine always has a price, so it always has a floor.
        if (p.swapAmountIn > 0 && p.swapAmountOutMin == 0) revert UnboundedSlippage();
        if (positionOf[venueId] != 0) revert PositionAlreadyOpen(venueId);

        uint256 balance = usdc.balanceOf(address(this));
        if (balance < assets) revert InsufficientBalance(assets, balance);
        if (p.swapAmountIn > assets) revert InsufficientBalance(p.swapAmountIn, assets);

        uint256 pairedReceived;
        if (p.swapAmountIn > 0) {
            usdc.forceApprove(address(swapRouter), p.swapAmountIn);
            pairedReceived = swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(usdc),
                    tokenOut: address(pairedToken),
                    fee: poolFee,
                    recipient: address(this),
                    amountIn: p.swapAmountIn,
                    amountOutMinimum: p.swapAmountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        uint256 usdcRemaining = assets - p.swapAmountIn;

        usdc.forceApprove(address(positionManager), usdcRemaining);
        pairedToken.forceApprove(address(positionManager), pairedReceived);

        (address token0, address token1) = usdcIsToken0
            ? (address(usdc), address(pairedToken))
            : (address(pairedToken), address(usdc));
        (uint256 amount0Desired, uint256 amount1Desired) =
            usdcIsToken0 ? (usdcRemaining, pairedReceived) : (pairedReceived, usdcRemaining);

        (uint256 tokenId, uint128 liquidity,,) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: p.amount0Min,
                amount1Min: p.amount1Min,
                recipient: address(this),
                deadline: p.deadline
            })
        );

        positionOf[venueId] = tokenId;
        emit PositionOpened(venueId, tokenId, liquidity, p.tickLower, p.tickUpper);
    }

    // -----------------------------------------------------------------------
    // Exit
    // -----------------------------------------------------------------------

    /// @notice Unwind some or all of the position and return USDC to the vault.
    /// @return returned USDC actually sent back. The Router records this
    ///         figure rather than the amount it asked for, because a position
    ///         that moved out of range does not return what it cost.
    function exit(uint16 venueId, uint256, bytes calldata data)
        external
        override
        onlyRouter
        returns (uint256 returned)
    {
        ExitParams memory p = abi.decode(data, (ExitParams));
        if (block.timestamp > p.deadline) revert DeadlinePassed(p.deadline);

        uint256 tokenId = positionOf[venueId];
        if (tokenId == 0) revert NoPosition(venueId);

        (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(tokenId);
        uint128 toRemove = p.unwindBps >= 10_000
            ? liquidity
            : uint128((uint256(liquidity) * p.unwindBps) / 10_000);

        if (toRemove > 0) {
            positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: toRemove,
                    amount0Min: p.amount0Min,
                    amount1Min: p.amount1Min,
                    deadline: p.deadline
                })
            );
        }

        // Collect both the withdrawn principal and any accrued fees.
        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit FeesCollected(venueId, amount0, amount1);

        if (p.unwindBps >= 10_000) {
            positionOf[venueId] = 0;
        }

        // Convert the paired leg back to USDC so the vault only ever holds
        // its own asset.
        uint256 pairedBalance = pairedToken.balanceOf(address(this));
        if (pairedBalance > 0) {
            if (p.swapAmountOutMin == 0) revert UnboundedSlippage();
            pairedToken.forceApprove(address(swapRouter), pairedBalance);
            swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(pairedToken),
                    tokenOut: address(usdc),
                    fee: poolFee,
                    recipient: address(this),
                    amountIn: pairedBalance,
                    amountOutMinimum: p.swapAmountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        returned = usdc.balanceOf(address(this));
        if (returned > 0) {
            usdc.safeTransfer(_vault(), returned);
        }
        emit PositionClosed(venueId, tokenId, returned);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    function setRouter(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        router = next;
    }

    address private _vaultAddress;

    function setVault(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        _vaultAddress = next;
    }

    function _vault() private view returns (address) {
        return _vaultAddress;
    }

    /// @dev The position manager mints an NFT to this contract.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Recover a token sent here by mistake. Owner-only, and it cannot
    ///         touch an open position because those are held as NFTs.
    function sweep(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }
}
