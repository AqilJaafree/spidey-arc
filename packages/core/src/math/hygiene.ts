/**
 * Estimator hygiene — spec §7.6.
 *
 * "Raw 24h APR is dominated by single large swaps in thin pools."
 *
 * | Technique                                | Purpose                        |
 * |------------------------------------------|--------------------------------|
 * | EWMA over hourly buckets, half-life 12h  | Recency without whipsaw        |
 * | Winsorize hourly observations at p95     | Kill single-swap spikes        |
 * | Persistence weight `score = APR_ewma × ρ`| ρ = lag-1 autocorr of volume   |
 * | Report median alongside mean             | Large gap ⇒ one-whale pool     |
 * | Discount `apyReward` by 50%+             | Emissions are not fee income   |
 */

export const EWMA_HALF_LIFE_HOURS = 12 as const;
export const WINSORIZE_PERCENTILE = 0.95 as const;
export const REWARD_APY_DISCOUNT = 0.5 as const;

function assertNonEmpty(xs: readonly number[], what: string): void {
  if (xs.length === 0) throw new RangeError(`${what} requires a non-empty series`);
}

export function mean(xs: readonly number[]): number {
  assertNonEmpty(xs, 'mean');
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/**
 * Linear-interpolated percentile (the "type 7" definition, matching numpy's
 * and R's defaults) so results are reproducible against reference tooling.
 *
 * @param p in [0, 1]
 */
export function percentile(xs: readonly number[], p: number): number {
  assertNonEmpty(xs, 'percentile');
  if (p < 0 || p > 1) throw new RangeError(`percentile must be in [0, 1], got ${p}`);
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] as number;
  if (lo === hi) return loVal;
  const hiVal = sorted[hi] as number;
  return loVal + (hiVal - loVal) * (idx - lo);
}

export const median = (xs: readonly number[]): number => percentile(xs, 0.5);

/**
 * Clamp the upper tail to the `p`th percentile.
 *
 * Upper tail only, by design: the failure mode being corrected is a single
 * whale swap inflating an hour, not a quiet hour deflating one. A quiet hour
 * is real information about the pool.
 */
export function winsorizeUpper(xs: readonly number[], p: number = WINSORIZE_PERCENTILE): number[] {
  assertNonEmpty(xs, 'winsorize');
  const cap = percentile(xs, p);
  return xs.map((x) => (x > cap ? cap : x));
}

/**
 * Exponentially weighted moving average over evenly spaced buckets.
 *
 * With hourly buckets and the default 12-hour half-life, an observation's
 * weight halves every 12 steps: `α = 1 − 2^(−1/halfLife)`.
 *
 * @param halfLifeSteps half-life measured in buckets, not hours — pass 12 for
 *   hourly data, 2 for 6-hourly, and so on
 */
export function ewma(xs: readonly number[], halfLifeSteps: number = EWMA_HALF_LIFE_HOURS): number {
  assertNonEmpty(xs, 'ewma');
  if (halfLifeSteps <= 0) throw new RangeError(`half-life must be positive, got ${halfLifeSteps}`);
  const alpha = 1 - 2 ** (-1 / halfLifeSteps);
  let acc = xs[0] as number;
  for (let i = 1; i < xs.length; i += 1) {
    acc = alpha * (xs[i] as number) + (1 - alpha) * acc;
  }
  return acc;
}

/**
 * Lag-1 autocorrelation `ρ`. Returns 0 for a constant series, where the
 * quantity is undefined (zero variance) and any nonzero answer would be an
 * artifact.
 */
export function lag1Autocorr(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mu = mean(xs);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dev = (xs[i] as number) - mu;
    denominator += dev * dev;
    if (i > 0) numerator += dev * ((xs[i - 1] as number) - mu);
  }
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * `ρ` clamped to [0, 1] for use as a multiplicative persistence weight.
 *
 * A negative autocorrelation means volume alternates rather than persists —
 * that is evidence against expecting the yield to continue, so it floors at
 * zero. It must never flip the sign of a score.
 */
export function persistenceWeight(hourlyVolume: readonly number[]): number {
  return Math.min(1, Math.max(0, lag1Autocorr(hourlyVolume)));
}

/**
 * Flag a pool whose activity is one whale rather than a market.
 *
 * "Report median alongside mean — large gap ⇒ one-whale pool, flag it." (§7.6)
 */
export function whaleFlag(
  xs: readonly number[],
  ratioThreshold = 2,
): { flagged: boolean; mean: number; median: number; ratio: number } {
  const m = mean(xs);
  const med = median(xs);
  // A zero median with positive mean is the degenerate one-whale case: most
  // buckets are empty and all the volume sits in a handful of them.
  const ratio = med === 0 ? (m > 0 ? Number.POSITIVE_INFINITY : 1) : m / med;
  return { flagged: ratio > ratioThreshold, mean: m, median: med, ratio };
}

/**
 * Discount emissions-derived APY. "Emissions decay and are not fee
 * performance." (§7.6) Default 50%.
 */
export function discountRewardApy(apyReward: number, discount: number = REWARD_APY_DISCOUNT): number {
  if (discount < 0 || discount > 1) throw new RangeError(`discount must be in [0, 1], got ${discount}`);
  return apyReward * (1 - discount);
}

export type RobustAprInput = {
  /** Hourly fee-yield observations, annualized, oldest first. 168 buckets = 7d. */
  hourlyApr: readonly number[];
  /** Hourly volume, same buckets, used for the persistence weight. */
  hourlyVolume: readonly number[];
  /** Emissions APY to fold in, already annualized. */
  apyReward?: number;
  winsorizePercentile?: number;
  halfLifeHours?: number;
  rewardDiscount?: number;
};

export type RobustAprResult = {
  /** The ranking input: persistence-weighted, winsorized, EWMA'd, plus discounted rewards. */
  score: number;
  /** EWMA of the winsorized series, before the persistence weight. */
  aprEwma: number;
  /** `ρ` clamped to [0, 1]. */
  persistence: number;
  /** Emissions contribution after discounting. */
  discountedRewardApy: number;
  /** Whale diagnostics on the raw series. */
  whale: ReturnType<typeof whaleFlag>;
};

/**
 * The §7.6 pipeline end to end: winsorize → EWMA → persistence-weight, with
 * discounted emissions added on and whale diagnostics carried alongside.
 *
 * The whale flag is reported, never applied silently — a one-whale pool is
 * still investable, it just needs to be labelled as such in the UI.
 */
export function robustApr(input: RobustAprInput): RobustAprResult {
  const {
    hourlyApr,
    hourlyVolume,
    apyReward = 0,
    winsorizePercentile = WINSORIZE_PERCENTILE,
    halfLifeHours = EWMA_HALF_LIFE_HOURS,
    rewardDiscount = REWARD_APY_DISCOUNT,
  } = input;

  assertNonEmpty(hourlyApr, 'robustApr');
  const aprEwma = ewma(winsorizeUpper(hourlyApr, winsorizePercentile), halfLifeHours);
  const persistence = hourlyVolume.length > 0 ? persistenceWeight(hourlyVolume) : 0;
  const discountedRewardApy = discountRewardApy(apyReward, rewardDiscount);

  return {
    score: aprEwma * persistence + discountedRewardApy,
    aprEwma,
    persistence,
    discountedRewardApy,
    whale: whaleFlag(hourlyApr),
  };
}
