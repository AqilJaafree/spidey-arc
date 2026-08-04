/**
 * Deriving the series §6 wants from the data venues actually publish.
 *
 * §6's schema asks for `priceHistogram`, `hourlyFeeSeries` and
 * `volumeAutocorr`. No public venue API publishes any of them. The options
 * are to fabricate, to give up, or to model from something observed and say
 * so. This module does the third: each function states its assumption, and
 * the result is tagged so the assumption travels with the number.
 */

import type { PriceHistogramBucket } from '@spidey/core';

/**
 * Day-over-day absolute returns in basis points, from a series of daily
 * closes (oldest first).
 *
 * This is a proxy for the peak-to-trough 24h range `p_exit` really wants
 * (§7.4). Close-to-close strictly understates intraday range, so `p_exit`
 * built on it is an underestimate of exit risk — the optimistic direction.
 * Flagged here so it is not mistaken for the real thing.
 */
export function dailyReturnsBps(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) continue;
    out.push(Math.abs(curr / prev - 1) * 10_000);
  }
  return out;
}

/**
 * A modelled volume-by-distance-from-peg histogram.
 *
 * ASSUMPTION, stated plainly: 24h volume is distributed uniformly across the
 * price band the pool actually traversed in those 24 hours. So for a band of
 * half-width `R`, the share of volume within ±δ is `min(1, δ/R)`.
 *
 * This is deliberately crude and deliberately conservative for tight ranges:
 * real order flow clusters near the peg far more tightly than uniform (§7.4
 * puts 80–95% of stable-pair volume inside ±0.05%), so a uniform model
 * UNDERSTATES what a tight range captures. Under-promising on the number the
 * product exists to defend is the right direction to be wrong in.
 *
 * Replace this the moment per-swap data is available — that upgrade is what
 * `priceHistogramSource: 'observed'` is for.
 *
 * @param volume24hUsd total 24h volume
 * @param rangeBps `R`, the traversed half-width in bps
 * @param buckets resolution of the returned histogram
 */
export function modelledPriceHistogram(
  volume24hUsd: number,
  rangeBps: number,
  buckets = 41,
): PriceHistogramBucket[] {
  if (volume24hUsd < 0) throw new RangeError(`negative volume: ${volume24hUsd}`);
  if (buckets < 1) throw new RangeError(`need at least one bucket, got ${buckets}`);

  // A pool whose price did not move still traded; put it all at the peg
  // rather than dividing by zero.
  const halfWidth = rangeBps > 0 ? rangeBps : 0;
  if (halfWidth === 0) return [{ bpsFromPeg: 0, volumeUsd: volume24hUsd }];

  const perBucket = volume24hUsd / buckets;
  const step = (2 * halfWidth) / (buckets - 1 || 1);
  return Array.from({ length: buckets }, (_, i) => ({
    bpsFromPeg: -halfWidth + i * step,
    volumeUsd: perBucket,
  }));
}

/**
 * Median of a numeric series, used to pick a representative daily range when
 * a venue gives several days of history. Median rather than mean because a
 * single volatile day should not widen the modelled band for a week.
 */
export function medianOf(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * Convert a Q64.64 sqrt price (Orca, Raydium) to the raw price ratio.
 * "Raw" means before decimal adjustment: token1 base units per token0 base unit.
 */
export const sqrtPriceX64ToRawPrice = (sqrtPriceX64: bigint): number => {
  const sqrtPrice = Number(sqrtPriceX64) / 2 ** 64;
  return sqrtPrice * sqrtPrice;
};

/** Convert a Q64.96 sqrt price (Uniswap v3) to the raw price ratio. */
export const sqrtPriceX96ToRawPrice = (sqrtPriceX96: bigint): number => {
  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  return sqrtPrice * sqrtPrice;
};
