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

/** The two fields a range needs. OHLCV rows carry more; nothing here reads it. */
export type HighLow = { high: number; low: number };

/**
 * Per-candle peak-to-trough range in basis points — `(high - low) / low`.
 *
 * The honest sibling of {@link dailyReturnsBps}, and it lives here so the two
 * are read together. That one measures close-to-close because closes are all
 * Orca publishes; this one measures the actual extremes, which is what
 * `daily24hRangesBps` is documented to hold and what §7.4's `p_exit` asks for.
 *
 * The gap between them is not a rounding difference. Measured on 8 days of live
 * Meteora SOL-USDC candles (`high/low` against `close/open`):
 *
 *     329.2bps vs 230.6bps    1.43x
 *     316.9bps vs   8.0bps   39.63x   <- moved 317bps and came back
 *     189.7bps vs  32.0bps    5.92x
 *     202.0bps vs  32.0bps    6.30x
 *     267.5bps vs 190.1bps    1.41x
 *     259.3bps vs 141.0bps    1.84x
 *     433.0bps vs 312.7bps    1.38x
 *      96.4bps vs  32.0bps    3.01x
 *
 * 1.38x to 39.6x. A day that leaves and returns registers as no movement at all
 * close-to-close, while the position it would have knocked out of range is just
 * as knocked out — so wherever both are available, this is the one to use, and
 * `dailyReturnsBps` is the fallback for venues that publish only closes.
 *
 * Bad candles are dropped rather than thrown on, matching `dailyReturnsBps`:
 * one malformed row must not cost a pool its whole series.
 */
export function peakToTroughBps(candles: readonly HighLow[]): number[] {
  const out: number[] = [];
  for (const candle of candles) {
    const { high, low } = candle;
    if (!Number.isFinite(high) || !Number.isFinite(low) || low <= 0 || high < low) continue;
    out.push(((high - low) / low) * 10_000);
  }
  return out;
}

/**
 * The band the price traversed across every candle, bps — `(max high - min low) / min low`.
 *
 * Not the same question as the median of {@link peakToTroughBps}, and the
 * difference is the whole reason this exists. A daily range is what the price did
 * *within* a day; this is how far it wandered over the window. A position is not
 * re-centred every midnight, so over a hold of several days the flow it misses is
 * set by the wander, not by one day's swing.
 *
 * `null` when no candle is usable, and — deliberately — when the traversed band
 * is zero. A degenerate series (every `high === low`) would otherwise model all
 * volume at the peg and hand back full capture at any δ, which is the most
 * flattering value available from the least trustworthy input.
 */
export function traversedBandBps(candles: readonly HighLow[]): number | null {
  let high = -Infinity;
  let low = Infinity;
  for (const candle of candles) {
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) continue;
    if (candle.low <= 0 || candle.high < candle.low) continue;
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  const band = ((high - low) / low) * 10_000;
  return band > 0 ? band : null;
}

/**
 * A modelled volume-by-distance-from-peg histogram.
 *
 * ASSUMPTION, stated plainly: 24h volume is distributed uniformly across a
 * price band of half-width `R`, so the share within ±δ is `min(1, δ/R)`.
 *
 * `R` is the caller's to choose and is the entire model — see
 * {@link traversedBandBps} for why the band a position is judged against is the
 * one the price traversed over the *hold*, not over one day.
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
