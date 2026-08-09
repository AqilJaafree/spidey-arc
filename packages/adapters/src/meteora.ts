/**
 * Meteora DLMM adapter (Solana).
 *
 * The venue that matters most and was missing: `MeteoraReceiver` — the Anchor
 * program the Router bridges to — deposits into a Meteora DLMM position, so
 * this is the only Solana venue capital can actually reach. Until now the
 * ranker saw Orca and Raydium and never saw Meteora at all, which meant the
 * venue holding the money was the one venue that could not be scored.
 *
 * Two things about this API are worth stating before reading any field.
 *
 * The endpoint published in the older docs (`dlmm-api.meteora.ag/pair/all`) is
 * gone — a Cloudflare-cached 404. This is the current host.
 *
 * And `apr` is not an APR. It equals `fee_tvl_ratio.24h` and is percent *per
 * day*; `apy` is the annual, daily-compounded figure. Mapping the wrong one
 * understates fee yield by ~365x, which is why `apyBase` reads `apy`.
 */

import type { NormalizedPool } from '@spidey/core';
import { modelledPriceHistogram } from './series.js';

export const METEORA_BASE = 'https://dlmm.datapi.meteora.ag';
const SOLANA_CCTP_DOMAIN = 5;

/**
 * Half-width for the modelled volume distribution, bps.
 *
 * Deliberately wide relative to a 4bp bin: `modelledPriceHistogram` spreads
 * volume uniformly, so a wider band puts *less* volume inside a tight δ. That
 * understates `V_δ`, which is the conservative direction. Using `binStep` here
 * would concentrate every trade at the peg and flatter the venue.
 */
const MODELLED_RANGE_BPS = 100;

export type MeteoraToken = {
  address: string;
  symbol: string;
  decimals: number;
  price: number;
};

/** The API reports each metric over several windows; only 24h is used. */
export type MeteoraWindow = Partial<Record<'30m' | '1h' | '2h' | '4h' | '12h' | '24h', number>>;

export type MeteoraPool = {
  address: string;
  name?: string;
  token_x: MeteoraToken;
  token_y: MeteoraToken;
  token_x_amount?: number;
  token_y_amount?: number;
  /** `bin_step` is already bps; `base_fee_pct` and `max_fee_pct` are percents. */
  pool_config?: { bin_step?: number; base_fee_pct?: number; max_fee_pct?: number };
  dynamic_fee_pct?: number;
  tvl: number;
  current_price?: number;
  /** Percent per DAY, equal to `fee_tvl_ratio.24h`. Not used — see the header. */
  apr?: number;
  /** Percent per year, compounded daily. This is what `apyBase` comes from. */
  apy?: number;
  has_farm?: boolean;
  farm_apy?: number;
  is_blacklisted?: boolean;
  volume?: MeteoraWindow;
  fees?: MeteoraWindow;
  fee_tvl_ratio?: MeteoraWindow;
};

export type MeteoraPoolsResponse = { data?: MeteoraPool[]; total?: number; pages?: number };

export function normalizeMeteoraPool(
  pool: MeteoraPool,
  now: number,
): NormalizedPool | { skip: string } {
  if (pool.is_blacklisted) return { skip: 'blacklisted by the venue' };
  if (!(pool.tvl > 0)) return { skip: 'no TVL' };

  const binStep = pool.pool_config?.bin_step;
  if (binStep === undefined || !(binStep > 0)) {
    // `binStep` is this venue's range granularity — `venueGranularityBps`
    // reads it to refuse ranges the venue cannot express. Without it there is
    // nothing to fall back to, so exclude rather than assume 1bp.
    return { skip: 'no bin_step in pool_config' };
  }

  const volume24h = pool.volume?.['24h'] ?? 0;
  const fees24h = pool.fees?.['24h'] ?? 0;
  const baseFeePct = pool.pool_config?.base_fee_pct ?? 0;
  const maxFeePct = pool.pool_config?.max_fee_pct ?? 0;

  return {
    chain: 'solana',
    cctpDomain: SOLANA_CCTP_DOMAIN,
    dex: 'meteora-dlmm',
    poolId: pool.address,
    pair: [pool.token_x?.symbol ?? '?', pool.token_y?.symbol ?? '?'],

    feeBps: baseFeePct * 100,
    feeIsDynamic: maxFeePct > baseFeePct,
    feeBpsObserved24h: volume24h > 0 ? (fees24h / volume24h) * 10_000 : null,

    tvlUsd: pool.tvl,
    // Phase 1 has no bin data. Excluded, never approximated from reserves.
    activeTvlUsd: null,
    activeTvlDeltaBps: null,
    activeTvlFidelity: 'unavailable',
    binStep,

    volume24h,
    volume7d: null,
    fees24h,
    fees7d: null,

    apyBase: (pool.apy ?? 0) / 100,
    apyReward: (pool.farm_apy ?? 0) / 100,

    priceHistogram: modelledPriceHistogram(volume24h, MODELLED_RANGE_BPS),
    priceHistogramSource: 'modelled-uniform-over-range',
    // Left empty on purpose. The API does publish an hourly series, but
    // `rank.ts` lets it *replace* `yourApr`, and the only denominator
    // available here is headline TVL. Supplying it would score this venue
    // ~5.5x low for being the one venue that could.
    hourlyFeeSeries: [],
    volumeAutocorr: null,

    source: 'meteora-datapi',
    asOf: now,
  };
}
