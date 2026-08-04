/**
 * Pool-level fee APR — spec §7.1.
 *
 *   poolFeeAPR = 365 × (volume_24h × f) / activeTVL
 *
 * "The denominator is active liquidity, never headline TVL." (§7.1)
 *
 * This is the number a dashboard *should* print. It is still not the number a
 * depositor earns — that is §7.3, which puts the depositor's own capital in
 * the denominator.
 */

export const DAYS_PER_YEAR = 365 as const;

export type PoolFeeAprInput = {
  /** 24h swap volume through the pool, USD. */
  volume24hUsd: number;
  /** Fee rate as a fraction. 0.0005 = 5 bps. */
  feeRate: number;
  /** In-range liquidity only, USD. See §6 — never headline TVL. */
  activeTvlUsd: number;
};

/**
 * Annualized fee APR of the pool as it stands, before your deposit dilutes it.
 * Returned as a fraction (0.09 = 9% APR), not a percentage.
 */
export function poolFeeApr({ volume24hUsd, feeRate, activeTvlUsd }: PoolFeeAprInput): number {
  if (volume24hUsd < 0) throw new RangeError(`negative volume: ${volume24hUsd}`);
  if (feeRate < 0) throw new RangeError(`negative fee rate: ${feeRate}`);
  if (activeTvlUsd <= 0) {
    throw new RangeError(
      `activeTvlUsd must be positive, got ${activeTvlUsd} — a pool with no in-range liquidity has no defined APR (§6: exclude it, do not approximate)`,
    );
  }
  return (DAYS_PER_YEAR * (volume24hUsd * feeRate)) / activeTvlUsd;
}

/**
 * Realized fee rate — spec §6 `feeBpsObserved24h = fees24h / volume24h`.
 *
 * Prefer this over the advertised tier. Meteora's DLMM fee is base + variable,
 * so its static `base_fee_percentage` understates what the pool actually
 * charged; Uniswap rebates and hooks can push the realized rate the other way.
 *
 * Returns `null` when there was no volume to derive a rate from — the caller
 * must fall back to the static tier rather than treat zero as a rate.
 */
export function observedFeeRate(fees24hUsd: number, volume24hUsd: number): number | null {
  if (fees24hUsd < 0) throw new RangeError(`negative fees: ${fees24hUsd}`);
  if (volume24hUsd <= 0) return null;
  return fees24hUsd / volume24hUsd;
}

/**
 * The headline APR a dashboard prints: same numerator, but divided by total
 * TVL instead of in-range TVL.
 *
 * This exists so the UI can show "their number" beside "our number" (§12
 * step 1). It is deliberately not used for ranking.
 */
export function headlineFeeApr({
  volume24hUsd,
  feeRate,
  tvlUsd,
}: {
  volume24hUsd: number;
  feeRate: number;
  tvlUsd: number;
}): number {
  if (tvlUsd <= 0) throw new RangeError(`tvlUsd must be positive, got ${tvlUsd}`);
  return (DAYS_PER_YEAR * (volume24hUsd * feeRate)) / tvlUsd;
}
