/**
 * Raydium CLMM adapter (Solana).
 *
 * `api-v3.raydium.io/pools/info/list` publishes price, TVL, fee tier and 24h
 * flow — but not `liquidity` or `sqrtPrice`, so there is no way to compute
 * in-range liquidity from it. Per §6 that means `activeTvlUsd: null` and
 * exclusion from ranking, not an approximation from `tvl`.
 *
 * The upgrade path is reading `PoolState` on-chain (the CLMM program stores
 * `liquidity` and `sqrtPriceX64`), which would lift this to the same
 * `current-tick-liquidity` tier as Orca. Out of scope for Day 1.
 */

import type { NormalizedPool } from '@spidey/core';
import { getJson } from './http.js';
import { modelledPriceHistogram } from './series.js';
import type { AdapterContext, AdapterResult, VenueAdapter } from './types.js';

const RAYDIUM_URL =
  'https://api-v3.raydium.io/pools/info/list?poolType=concentrated&poolSortField=volume24h&sortType=desc&pageSize=100&page=1';
const SOLANA_CCTP_DOMAIN = 5;

type RaydiumMint = { address: string; symbol: string; decimals: number };

type RaydiumPool = {
  type: string;
  id: string;
  mintA: RaydiumMint;
  mintB: RaydiumMint;
  price: number;
  tvl: number;
  /** Fractional. 0.0001 = 1bp. */
  feeRate: number;
  hasDynamicFee?: boolean;
  day?: { volume?: number; volumeFee?: number; apr?: number; feeApr?: number };
  week?: { volume?: number; volumeFee?: number };
  config?: { tickSpacing?: number };
};

function normalize(pool: RaydiumPool, now: number): NormalizedPool | { skip: string } {
  if (!(pool.tvl > 0)) return { skip: 'no TVL' };
  const volume24h = pool.day?.volume ?? 0;
  const fees24h = pool.day?.volumeFee ?? 0;

  return {
    chain: 'solana',
    cctpDomain: SOLANA_CCTP_DOMAIN,
    dex: 'raydium-clmm',
    poolId: pool.id,
    pair: [pool.mintA?.symbol ?? '?', pool.mintB?.symbol ?? '?'],

    feeBps: pool.feeRate * 10_000,
    feeIsDynamic: Boolean(pool.hasDynamicFee),
    feeBpsObserved24h: volume24h > 0 ? (fees24h / volume24h) * 10_000 : null,

    tvlUsd: pool.tvl,
    // No liquidity/sqrtPrice in this endpoint: excluded, not approximated.
    activeTvlUsd: null,
    activeTvlDeltaBps: null,
    activeTvlFidelity: 'unavailable',
    tickSpacing: pool.config?.tickSpacing,

    volume24h,
    volume7d: pool.week?.volume ?? null,
    fees24h,
    fees7d: pool.week?.volumeFee ?? null,

    apyBase: (pool.day?.feeApr ?? 0) / 100,
    apyReward: Math.max(0, (pool.day?.apr ?? 0) - (pool.day?.feeApr ?? 0)) / 100,

    priceHistogram: modelledPriceHistogram(volume24h, 100),
    priceHistogramSource: 'modelled-uniform-over-range',
    hourlyFeeSeries: [],
    volumeAutocorr: null,

    source: 'raydium-api-v3',
    asOf: now,
  };
}

export const raydiumAdapter: VenueAdapter = {
  id: 'raydium',
  label: 'Raydium (CLMM)',
  bestFidelity: 'unavailable',

  async listPools(ctx: AdapterContext = {}): Promise<AdapterResult> {
    const { symbols, limit = 50, now = Date.now(), signal } = ctx;
    const body = await getJson<{ data?: { data?: RaydiumPool[] } }>(RAYDIUM_URL, {
      namespace: 'raydium',
      signal,
    });

    const wanted = symbols?.map((s) => s.toUpperCase());
    const pools: NormalizedPool[] = [];
    const skipped: AdapterResult['skipped'] = [];

    for (const raw of body.data?.data ?? []) {
      if (!raw?.id) continue;
      if (wanted && wanted.length > 0) {
        const pair = [raw.mintA?.symbol ?? '', raw.mintB?.symbol ?? ''].map((s) => s.toUpperCase());
        if (!pair.some((s) => wanted.includes(s))) continue;
      }
      const result = normalize(raw, now);
      if ('skip' in result) skipped.push({ poolId: raw.id, reason: result.skip });
      else pools.push(result);
      if (pools.length >= limit) break;
    }

    return { pools, skipped };
  },
};
