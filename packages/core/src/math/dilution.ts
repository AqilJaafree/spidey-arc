/**
 * Dilution-aware expected fee yield — spec §7.3.
 *
 *   APR_you = 365 × f × V_δ / (T_δ + A)
 *
 * - `V_δ` — 24h volume that executed INSIDE your range, from the price
 *   histogram, not total pool volume
 * - `T_δ` — others' liquidity overlapping your range
 * - `A`   — your deposit
 *
 * "This is the formula no dashboard implements." (§7.3)
 *
 * Two consequences, both of which the ranker depends on:
 *   1. Yield is F/(T_δ + A), not F/T_δ. Small pools with huge headline APRs
 *      collapse under any meaningful deposit.
 *   2. Ranking is a function `rank(A)`, not a static list.
 */

import { DAYS_PER_YEAR } from './feeApr.js';

/** One bucket of the 24h volume-by-distance-from-peg histogram (§6). */
export type PriceHistogramBucket = {
  /** Signed distance from the peg/current price, in basis points. */
  bpsFromPeg: number;
  /** Volume that executed at this distance, USD. */
  volumeUsd: number;
};

/**
 * `V_δ` — the share of 24h volume that executed within ±`deltaBps` of peg.
 *
 * For stable pairs 80–95% of volume typically sits within ±0.05% of peg
 * (§7.4), so a wide-range position captures almost none of the fee flow while
 * showing large notional TVL. That gap is the entire reason this function
 * exists instead of using `volume24h` directly.
 */
export function volumeInRange(histogram: readonly PriceHistogramBucket[], deltaBps: number): number {
  if (deltaBps < 0) throw new RangeError(`negative δ: ${deltaBps}`);
  let total = 0;
  for (const bucket of histogram) {
    if (Math.abs(bucket.bpsFromPeg) <= deltaBps) total += bucket.volumeUsd;
  }
  return total;
}

/** Fraction of total histogram volume falling within ±`deltaBps`. */
export function volumeCaptureRatio(
  histogram: readonly PriceHistogramBucket[],
  deltaBps: number,
): number {
  const total = histogram.reduce((sum, b) => sum + b.volumeUsd, 0);
  if (total <= 0) return 0;
  return volumeInRange(histogram, deltaBps) / total;
}

export type YourFeeAprInput = {
  /** Fee rate as a fraction. Prefer the realized rate (§6). */
  feeRate: number;
  /** `V_δ` — 24h volume inside your range, USD. */
  volumeInRangeUsd: number;
  /** `T_δ` — others' liquidity overlapping your range, USD. */
  othersLiquidityInRangeUsd: number;
  /** `A` — your deposit, USD. */
  depositUsd: number;
};

/**
 * `APR_you` — annualized fee yield on YOUR capital at YOUR size, as a
 * fraction. This is the ranking key.
 */
export function yourFeeApr({
  feeRate,
  volumeInRangeUsd,
  othersLiquidityInRangeUsd,
  depositUsd,
}: YourFeeAprInput): number {
  if (feeRate < 0) throw new RangeError(`negative fee rate: ${feeRate}`);
  if (volumeInRangeUsd < 0) throw new RangeError(`negative in-range volume: ${volumeInRangeUsd}`);
  if (othersLiquidityInRangeUsd < 0) {
    throw new RangeError(`negative in-range liquidity: ${othersLiquidityInRangeUsd}`);
  }
  if (depositUsd <= 0) throw new RangeError(`deposit must be positive, got ${depositUsd}`);

  const denominator = othersLiquidityInRangeUsd + depositUsd;
  return (DAYS_PER_YEAR * feeRate * volumeInRangeUsd) / denominator;
}

/**
 * How much of the pre-deposit yield survives your own deposit:
 * `T_δ / (T_δ + A)`, in [0, 1].
 *
 * 1.0 means your size is irrelevant against the pool. 0.35 means you took a
 * 900%-APR pool down to ~315% simply by being in it — the §1 example.
 */
export function dilutionFactor(othersLiquidityInRangeUsd: number, depositUsd: number): number {
  if (depositUsd <= 0) throw new RangeError(`deposit must be positive, got ${depositUsd}`);
  const denominator = othersLiquidityInRangeUsd + depositUsd;
  if (denominator <= 0) return 0;
  return othersLiquidityInRangeUsd / denominator;
}

/**
 * The deposit size at which your yield falls to `fraction` of the pool's
 * undiluted yield. `fraction = 0.5` gives the size at which you are half the
 * range's liquidity.
 *
 * Useful for the UI: "this pool supports about $8k before you halve your own
 * return."
 */
export function depositForDilution(othersLiquidityInRangeUsd: number, fraction: number): number {
  if (fraction <= 0 || fraction >= 1) {
    throw new RangeError(`fraction must be in (0, 1), got ${fraction}`);
  }
  return (othersLiquidityInRangeUsd * (1 - fraction)) / fraction;
}
