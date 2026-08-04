/**
 * Orca Whirlpool adapter (Solana).
 *
 * The most complete Day-1 source: `api.orca.so/v2` publishes `liquidity`,
 * `sqrtPrice`, `tickSpacing` and both token balances, which is everything
 * needed to compute real in-range TVL via
 * {@link capitalForLiquidity} — no API key, no RPC, no subgraph.
 *
 * Fidelity is `current-tick-liquidity`, not `tick-level`: `liquidity` is the
 * active `L` at the current tick, and `L` changes at every initialized tick.
 * The adapter therefore reports `activeTvlUsd` at a half-width of one
 * `tickSpacing` — inside which `L` is genuinely constant — and lets the
 * ranker refuse any question wider than that (§6). Widening it would mean
 * assuming a flat liquidity distribution, which is the approximation the spec
 * forbids.
 */

import {
  capitalForLiquidity,
  deltaFromBps,
  observedFeeRate,
  type NormalizedPool,
} from '@spidey/core';
import { getJson } from './http.js';
import { dailyReturnsBps, medianOf, modelledPriceHistogram } from './series.js';
import { isUsdSymbol, type AdapterContext, type AdapterResult, type VenueAdapter } from './types.js';

const ORCA_POOLS_URL = 'https://api.orca.so/v2/solana/pools';
const SOLANA_CCTP_DOMAIN = 5;

type OrcaToken = { address: string; symbol: string; decimals: number };

type OrcaPool = {
  address: string;
  tickSpacing: number;
  /** Parts per million. 400 = 4bp. */
  feeRate: number;
  liquidity: string | number;
  sqrtPrice: string | number;
  tickCurrentIndex: number;
  tokenA: OrcaToken;
  tokenB: OrcaToken;
  /** Decimal-adjusted price of A in units of B. */
  price: string | number;
  tvlUsdc: string | number;
  tokenBalanceA: string | number;
  tokenBalanceB: string | number;
  stats?: Record<string, { volume?: string | number; fees?: string | number } | undefined>;
  rewards?: Array<{ mint: string }>;
  priceHistory7d?: Array<string | number>;
  updatedAt?: string;
  adaptiveFeeEnabled?: boolean;
};

const num = (v: string | number | undefined | null): number =>
  v === undefined || v === null ? Number.NaN : typeof v === 'number' ? v : Number.parseFloat(v);

/**
 * USD price of token B, derived from the pool's own reported TVL and
 * balances:
 *
 *   tvl = balA · priceA_usd + balB · priceB_usd,  priceA_usd = price · priceB_usd
 *   ⇒  priceB_usd = tvl / (balA · price + balB)
 *
 * Using the venue's own numbers keeps the conversion self-consistent and
 * avoids dragging in an external price oracle for Day 1. Verified against
 * live SOL/USDC: yields 1.000022 for USDC.
 */
function usdPriceOfTokenB(pool: OrcaPool): number | null {
  const price = num(pool.price);
  const balA = num(pool.tokenBalanceA) / 10 ** pool.tokenA.decimals;
  const balB = num(pool.tokenBalanceB) / 10 ** pool.tokenB.decimals;
  const tvl = num(pool.tvlUsdc);
  const denominator = balA * price + balB;
  if (!Number.isFinite(denominator) || denominator <= 0 || !Number.isFinite(tvl)) return null;
  const derived = tvl / denominator;
  if (!Number.isFinite(derived) || derived <= 0) return null;

  // Sanity-check against the peg when token B is a stablecoin. A derived
  // price far from $1 means the pool's own reported numbers disagree with
  // each other, and a bad denominator is worse than no denominator.
  if (isUsdSymbol(pool.tokenB.symbol) && (derived < 0.9 || derived > 1.1)) return null;
  return derived;
}

function normalize(pool: OrcaPool, now: number): NormalizedPool | { skip: string } {
  const priceUi = num(pool.price);
  const liquidity = num(pool.liquidity);
  const sqrtPriceX64 = num(pool.sqrtPrice);
  const tvlUsd = num(pool.tvlUsdc);

  if (!Number.isFinite(priceUi) || priceUi <= 0) return { skip: 'no usable price' };
  if (!Number.isFinite(liquidity) || liquidity <= 0) return { skip: 'no active liquidity' };
  if (!Number.isFinite(sqrtPriceX64) || sqrtPriceX64 <= 0) return { skip: 'no sqrtPrice' };

  const priceB = usdPriceOfTokenB(pool);
  if (priceB === null) return { skip: 'could not derive a USD price from pool state' };

  const stats24h = pool.stats?.['24h'];
  const volume24h = num(stats24h?.volume);
  const fees24h = num(stats24h?.fees);
  if (!Number.isFinite(volume24h)) return { skip: 'no 24h volume' };

  // √P in raw (base-unit) terms, straight from sqrtPrice.
  const sqrtPriceRaw = sqrtPriceX64 / 2 ** 64;

  // L is constant only within the current tick interval, so that — one
  // tickSpacing — is the widest half-width this number is honest at.
  const activeTvlDeltaBps = Math.max(1, pool.tickSpacing);
  const activeTvlRawB = capitalForLiquidity(
    liquidity,
    sqrtPriceRaw * sqrtPriceRaw,
    deltaFromBps(activeTvlDeltaBps),
  );
  const activeTvlUsd = (activeTvlRawB / 10 ** pool.tokenB.decimals) * priceB;

  if (!Number.isFinite(activeTvlUsd) || activeTvlUsd <= 0) {
    return { skip: 'in-range liquidity computed as zero' };
  }

  const closes = (pool.priceHistory7d ?? []).map(num).filter((x) => Number.isFinite(x) && x > 0);
  const daily24hRangesBps = dailyReturnsBps(closes);
  const typicalRangeBps = medianOf(daily24hRangesBps) ?? activeTvlDeltaBps;

  const feeRate = observedFeeRate(fees24h, volume24h);
  const staticFeeBps = pool.feeRate / 100; // ppm → bps

  return {
    chain: 'solana',
    cctpDomain: SOLANA_CCTP_DOMAIN,
    dex: 'orca-whirlpool',
    poolId: pool.address,
    pair: [pool.tokenA.symbol, pool.tokenB.symbol],

    feeBps: staticFeeBps,
    feeIsDynamic: Boolean(pool.adaptiveFeeEnabled),
    feeBpsObserved24h: feeRate === null ? null : feeRate * 10_000,

    tvlUsd: Number.isFinite(tvlUsd) ? tvlUsd : 0,
    activeTvlUsd,
    activeTvlDeltaBps,
    activeTvlFidelity: 'current-tick-liquidity',
    tickSpacing: pool.tickSpacing,

    volume24h,
    volume7d: null,
    fees24h: Number.isFinite(fees24h) ? fees24h : 0,
    fees7d: null,

    apyBase: tvlUsd > 0 && Number.isFinite(fees24h) ? (365 * fees24h) / tvlUsd : 0,
    apyReward: 0, // rewards are listed but not rate-quoted by this endpoint

    priceHistogram: modelledPriceHistogram(volume24h, typicalRangeBps),
    priceHistogramSource: 'modelled-uniform-over-range',
    hourlyFeeSeries: [],
    volumeAutocorr: null,
    daily24hRangesBps: daily24hRangesBps.length > 0 ? daily24hRangesBps : undefined,

    source: 'orca-api-v2',
    asOf: pool.updatedAt ? Date.parse(pool.updatedAt) || now : now,
  };
}

export const orcaAdapter: VenueAdapter = {
  id: 'orca',
  label: 'Orca (Whirlpool)',
  bestFidelity: 'current-tick-liquidity',

  async listPools(ctx: AdapterContext = {}): Promise<AdapterResult> {
    const { symbols, limit = 50, now = Date.now(), signal } = ctx;
    const body = await getJson<{ data: OrcaPool[] }>(`${ORCA_POOLS_URL}?limit=200`, {
      namespace: 'orca',
      signal,
    });

    const wanted = symbols?.map((s) => s.toUpperCase());
    const pools: NormalizedPool[] = [];
    const skipped: AdapterResult['skipped'] = [];

    for (const raw of body.data ?? []) {
      if (!raw?.tokenA?.symbol || !raw?.tokenB?.symbol) continue;
      if (wanted && wanted.length > 0) {
        const pair = [raw.tokenA.symbol.toUpperCase(), raw.tokenB.symbol.toUpperCase()];
        if (!pair.some((s) => wanted.includes(s))) continue;
      }
      const result = normalize(raw, now);
      if ('skip' in result) skipped.push({ poolId: raw.address, reason: result.skip });
      else pools.push(result);
      if (pools.length >= limit) break;
    }

    return { pools, skipped };
  },
};
