/**
 * Uniswap v3 adapter (EVM) — the join that makes the argument.
 *
 * Neither source alone can answer the question:
 *
 *   - DefiLlama knows the FLOW (24h volume, fee tier, token pair) but reports
 *     headline TVL, which is the broken denominator (§1).
 *   - The chain knows the DENOMINATOR (`slot0.sqrtPriceX96`, `liquidity`) but
 *     not how much traded through it yesterday.
 *
 * So this adapter takes volume from DefiLlama, resolves the pool address via
 * the v3 factory, reads live state over RPC, and computes real in-range TVL
 * with {@link capitalForLiquidity}. The output is the same pool DefiLlama
 * ranks, with a denominator DefiLlama does not have — which is exactly the
 * side-by-side comparison §12 step 1 asks for.
 *
 * Fidelity is `current-tick-liquidity`: `slot0.liquidity` is the active `L`,
 * constant only within the current tick interval. Real tick-level data needs
 * the subgraph (`liquidityNet` per tick), which needs a Graph gateway API
 * key; when `GRAPH_API_KEY` is absent this adapter reports the narrower,
 * honest band rather than extrapolating across ticks.
 */

import {
  capitalForLiquidity,
  deltaFromBps,
  observedFeeRate,
  type NormalizedPool,
} from '@spidey/core';
import {
  createPublicClient,
  fallback,
  http as viemHttp,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { arbitrum, base, mainnet, optimism } from 'viem/chains';
import { fetchLlamaPools, filterLlamaPools, parseFeeTier, splitSymbol, type LlamaPool } from './defillama.js';
import { medianOf, modelledPriceHistogram } from './series.js';
import { cachedObservedRanges, hasFreshRange } from './geckoterminal.js';
import { isUsdSymbol, type AdapterContext, type AdapterResult, type VenueAdapter } from './types.js';

const V3_FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** Uniswap v3 factory is deployed at the same address on most chains. */
const CANONICAL_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984' as Address;

type ChainConfig = {
  /**
   * GeckoTerminal's network slug, for the daily price ranges. Omitted where it
   * has not been verified against their API — an absent slug means the chain's
   * rows keep `no-volatility-series` rather than being handed a guess.
   */
  gtNetwork?: string;
  llamaName: string;
  chain: string;
  cctpDomain: number;
  viemChain: typeof base;
  factory: Address;
  /**
   * Public endpoints, tried in order. Several are listed because public RPCs
   * rate-limit aggressively and go down without notice; a single hard-coded
   * URL turns an adapter into a coin flip.
   */
  defaultRpcs: string[];
  rpcEnv: string;
};

export const UNISWAP_CHAINS: Record<string, ChainConfig> = {
  base: {
    llamaName: 'Base',
    // Verified live: pools resolve and OHLCV returns real high/low.
    gtNetwork: 'base',
    chain: 'base',
    cctpDomain: 6,
    viemChain: base,
    // Base uses a different factory deployment than the canonical one.
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address,
    defaultRpcs: [
      'https://base-rpc.publicnode.com',
      'https://mainnet.base.org',
      'https://base.drpc.org',
      'https://1rpc.io/base',
    ],
    rpcEnv: 'BASE_RPC_URL',
  },
  ethereum: {
    llamaName: 'Ethereum',
    chain: 'ethereum',
    cctpDomain: 0,
    viemChain: mainnet as unknown as typeof base,
    factory: CANONICAL_V3_FACTORY,
    defaultRpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://1rpc.io/eth',
    ],
    rpcEnv: 'ETHEREUM_RPC_URL',
  },
  arbitrum: {
    llamaName: 'Arbitrum',
    chain: 'arbitrum',
    cctpDomain: 3,
    viemChain: arbitrum as unknown as typeof base,
    factory: CANONICAL_V3_FACTORY,
    defaultRpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    rpcEnv: 'ARBITRUM_RPC_URL',
  },
  optimism: {
    llamaName: 'Optimism',
    chain: 'optimism',
    cctpDomain: 2,
    viemChain: optimism as unknown as typeof base,
    factory: CANONICAL_V3_FACTORY,
    defaultRpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    rpcEnv: 'OPTIMISM_RPC_URL',
  },
};

function clientFor(config: ChainConfig): PublicClient {
  const override = process.env[config.rpcEnv];
  const urls = override ? [override, ...config.defaultRpcs] : config.defaultRpcs;
  return createPublicClient({
    chain: config.viemChain,
    // Batching is off deliberately: several public Base endpoints reject
    // JSON-RPC batch payloads outright, which surfaces as every read failing
    // at once rather than as a rate limit.
    transport: fallback(
      urls.map((url) => viemHttp(url, { batch: false, retryCount: 1, timeout: 15_000 })),
      { rank: false },
    ),
  }) as PublicClient;
}

type PoolState = {
  address: Address;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tickSpacing: number;
  token0: Address;
  token1: Address;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
};

async function readPoolState(
  client: PublicClient,
  address: Address,
): Promise<PoolState | { skip: string }> {
  const [slot0, liquidity, tickSpacing, token0, token1] = await Promise.all([
    client.readContract({ address, abi: V3_POOL_ABI, functionName: 'slot0' }),
    client.readContract({ address, abi: V3_POOL_ABI, functionName: 'liquidity' }),
    client.readContract({ address, abi: V3_POOL_ABI, functionName: 'tickSpacing' }),
    client.readContract({ address, abi: V3_POOL_ABI, functionName: 'token0' }),
    client.readContract({ address, abi: V3_POOL_ABI, functionName: 'token1' }),
  ]);

  if (liquidity === 0n) return { skip: 'no active liquidity at the current tick' };

  const [decimals0, decimals1, symbol0, symbol1] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'symbol' }),
  ]);

  return {
    address,
    sqrtPriceX96: slot0[0],
    liquidity,
    tickSpacing: Number(tickSpacing),
    token0,
    token1,
    decimals0: Number(decimals0),
    decimals1: Number(decimals1),
    symbol0,
    symbol1,
  };
}

/**
 * In-range TVL in USD, from raw pool state.
 *
 * One leg must be a USD stablecoin: the pool price then supplies the USD
 * value of the other leg directly, with no external oracle. Pools without a
 * stable leg are skipped rather than priced off a guess — Day 1 is the USDC
 * universe anyway (§11).
 */
export function activeTvlUsdFromState(state: PoolState, deltaBps: number): number | null {
  const sqrtPriceRaw = Number(state.sqrtPriceX96) / 2 ** 96;
  const rawPrice = sqrtPriceRaw * sqrtPriceRaw; // token1 per token0, base units
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return null;

  // Value of the in-range liquidity, denominated in raw token1 units.
  const valueRaw1 = capitalForLiquidity(Number(state.liquidity), rawPrice, deltaFromBps(deltaBps));
  const value1 = valueRaw1 / 10 ** state.decimals1;

  if (isUsdSymbol(state.symbol1)) return value1;

  if (isUsdSymbol(state.symbol0)) {
    // uiPrice = token1 per token0 = token1 per USD, so token1 is worth 1/uiPrice.
    const uiPrice = rawPrice * 10 ** (state.decimals0 - state.decimals1);
    if (!Number.isFinite(uiPrice) || uiPrice <= 0) return null;
    return value1 / uiPrice;
  }

  return null;
}

export type UniswapOptions = AdapterContext & {
  /** Which chains to cover. Defaults to Base — the spec's Day-2 EVM leg. */
  chains?: string[];
  minTvlUsd?: number;
  minVolume24hUsd?: number;
  /** Cap on RPC round-trips; public endpoints are rate-limited. */
  maxPools?: number;
  /**
   * Upstream range fetches per scan. Cache hits are free and unlimited; this
   * bounds only cold pools. 0 disables the range fetch entirely.
   */
  maxRangeFetches?: number;
};

export function createUniswapV3Adapter(options: UniswapOptions = {}): VenueAdapter {
  return {
    id: 'uniswap-v3',
    label: 'Uniswap v3 (on-chain)',
    bestFidelity: 'current-tick-liquidity',

    async listPools(ctx: AdapterContext = {}): Promise<AdapterResult> {
      const merged = { ...options, ...ctx };
      const {
        chains = ['base'],
        minTvlUsd = 1_000_000,
        minVolume24hUsd = 100_000,
        maxPools = 12,
        limit = 50,
        now = Date.now(),
        signal,
      } = merged;

      const pools: NormalizedPool[] = [];
      const skipped: AdapterResult['skipped'] = [];
      const llamaRows = await fetchLlamaPools(signal);

      for (const chainKey of chains) {
        const config = UNISWAP_CHAINS[chainKey];
        if (!config) {
          skipped.push({ poolId: chainKey, reason: `unsupported chain ${chainKey}` });
          continue;
        }

        const candidates = filterLlamaPools(llamaRows, {
          ...merged,
          projects: ['uniswap-v3'],
          chains: [config.llamaName],
          minTvlUsd,
        })
          .filter((row: LlamaPool) => (row.volumeUsd1d ?? 0) >= minVolume24hUsd)
          .filter((row: LlamaPool) => (row.underlyingTokens?.length ?? 0) === 2)
          .filter((row: LlamaPool) => row.symbol.toUpperCase().split('-').some(isUsdSymbol))
          .sort((a, b) => (b.volumeUsd1d ?? 0) - (a.volumeUsd1d ?? 0))
          .slice(0, maxPools);

        const client = clientFor(config);

        for (const row of candidates) {
          const tier = parseFeeTier(row.poolMeta);
          const tokens = row.underlyingTokens as [string, string];
          if (!tier) {
            skipped.push({ poolId: row.pool, reason: `unparseable fee tier ${row.poolMeta}` });
            continue;
          }

          try {
            const address = (await client.readContract({
              address: config.factory,
              abi: V3_FACTORY_ABI,
              functionName: 'getPool',
              args: [tokens[0] as Address, tokens[1] as Address, tier.feeUnits],
            })) as Address;

            if (!address || /^0x0+$/.test(address)) {
              skipped.push({ poolId: row.pool, reason: 'factory returned no pool for that tier' });
              continue;
            }

            const state = await readPoolState(client, address);
            if ('skip' in state) {
              skipped.push({ poolId: address, reason: state.skip });
              continue;
            }

            const deltaBps = Math.max(1, state.tickSpacing);
            const activeTvlUsd = activeTvlUsdFromState(state, deltaBps);
            if (activeTvlUsd === null || activeTvlUsd <= 0) {
              skipped.push({ poolId: address, reason: 'no stable leg to price against' });
              continue;
            }

            const volume24h = row.volumeUsd1d ?? 0;
            const fees24h = (volume24h * tier.feeBps) / 10_000;
            const realized = observedFeeRate(fees24h, volume24h);

            pools.push({
              chain: config.chain,
              cctpDomain: config.cctpDomain,
              dex: 'uniswap-v3',
              poolId: address,
              pair: splitSymbol(row.symbol),

              feeBps: tier.feeBps,
              feeIsDynamic: false,
              feeBpsObserved24h: realized === null ? null : realized * 10_000,

              tvlUsd: row.tvlUsd ?? 0,
              activeTvlUsd,
              activeTvlDeltaBps: deltaBps,
              activeTvlFidelity: 'current-tick-liquidity',
              tickSpacing: state.tickSpacing,

              volume24h,
              volume7d: row.volumeUsd7d,
              fees24h,
              fees7d: null,

              apyBase: (row.apyBase ?? 0) / 100,
              apyReward: (row.apyReward ?? 0) / 100,

              // Volume comes from DefiLlama as a daily total with no price
              // attribution, so the in-range share has to be modelled. σ is
              // DefiLlama's own 30d volatility estimate, in fractional units.
              priceHistogram: modelledFromSigma(volume24h, row.sigma),
              priceHistogramSource: 'modelled-uniform-over-range',
              hourlyFeeSeries: [],
              volumeAutocorr: null,

              source: `uniswap-v3-onchain:${config.chain}`,
              asOf: now,
            });

            if (pools.length >= limit) break;
          } catch (error) {
            skipped.push({
              poolId: row.pool,
              reason: `RPC read failed: ${(error as Error).message.slice(0, 120)}`,
            });
          }
        }
      }

      const degraded: Array<{ poolId: string; reason: string }> = [];
      const withRanges = await attachObservedRanges(pools, {
        networkFor: (chain) =>
          Object.values(UNISWAP_CHAINS).find((c) => c.chain === chain)?.gtNetwork,
        budget: merged.maxRangeFetches ?? DEFAULT_RANGE_FETCHES_PER_SCAN,
        onDegraded: (d) => degraded.push(d),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      return { pools: withRanges, skipped, degraded };
    },
  };
}

/**
 * Model the in-range volume share from DefiLlama's `sigma`.
 *
 * `sigma` is a 30-day volatility of the pool's APY series, not of its price,
 * so it is a weak proxy — but it is the only dispersion signal this join
 * carries. A 1% daily band is the fallback when it is missing. The result is
 * always tagged `modelled-uniform-over-range`, never `observed`.
 */
function modelledFromSigma(volume24hUsd: number, sigma: number | null) {
  const rangeBps = sigma && Number.isFinite(sigma) && sigma > 0 ? Math.min(sigma * 10_000, 500) : 100;
  return modelledPriceHistogram(volume24hUsd, rangeBps);
}


/**
 * How many *upstream* range fetches one scan may spend.
 *
 * Cache hits are unlimited and free, so this bounds only cold pools. Three per
 * scan against a 6h TTL means a cold start fills in over a few refreshes rather
 * than arriving as one 24-call burst — which is the shape that made
 * GeckoTerminal answer 429 on the third request. Coverage converges; the budget
 * only decides how fast.
 */
export const DEFAULT_RANGE_FETCHES_PER_SCAN = 3;

/**
 * Attach observed daily ranges, and re-band the volume histogram on them.
 *
 * Two gaps close at once. `estimateExitProbability` only runs on
 * `daily24hRangesBps`, which this adapter never supplied, so `p_exit` was 0 for
 * every row — the most flattering value available, and exactly what
 * `no-volatility-series` was added to expose. And `modelledFromSigma` banded the
 * volume histogram on DefiLlama's σ, whose own comment concedes it is "a 30-day
 * volatility of the pool's APY series, not of its price". An observed band
 * replaces a quantity that was never the right one.
 *
 * A pool without ranges is left exactly as it was: the flag reports it, and
 * nothing here substitutes a number to fill the hole.
 */
async function attachObservedRanges(
  pools: NormalizedPool[],
  options: {
    networkFor: (chain: string) => string | undefined;
    budget: number;
    onDegraded?: (d: { poolId: string; reason: string }) => void;
    signal?: AbortSignal;
  },
): Promise<NormalizedPool[]> {
  let budget = options.budget;
  const out: NormalizedPool[] = [];

  // Sequential on purpose. The point is to avoid bursts, and `Promise.all` over
  // cold pools would reissue exactly the burst the budget exists to prevent.
  for (const pool of pools) {
    const network = options.networkFor(pool.chain);
    if (network === undefined) {
      out.push(pool);
      continue;
    }
    const warm = hasFreshRange(network, pool.poolId);
    if (!warm && budget <= 0) {
      out.push(pool);
      continue;
    }
    if (!warm) budget -= 1;

    const ranges = await cachedObservedRanges(network, pool.poolId, {
      ...(options.signal ? { signal: options.signal } : {}),
      onError: (reason) =>
        options.onDegraded?.({ poolId: pool.poolId, reason: `daily ranges unavailable: ${reason}` }),
    });
    if (ranges === null) {
      out.push(pool);
      continue;
    }

    out.push({
      ...pool,
      daily24hRangesBps: ranges.daily24hRangesBps,
      // Observed band, still a uniform distribution within it — so the label
      // stays `modelled-uniform-over-range`. Only the width was measured.
      priceHistogram: modelledPriceHistogram(
        pool.volume24h,
        ranges.bandBps > 0 ? ranges.bandBps : (medianOf(ranges.daily24hRangesBps) ?? 100),
      ),
    });
  }
  return out;
}

export const uniswapV3Adapter = createUniswapV3Adapter();
