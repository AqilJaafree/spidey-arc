/**
 * What a pool pays at deposit sizes other than the one you asked about.
 *
 * The engine answers one question — "at $A, what does this pool pay?" — and the
 * product's whole claim is that the answer *moves* with A. Stating that as a
 * formula asks the reader to do the arithmetic in their head. Drawing it does
 * the arithmetic for them, and the shape carries the argument: a thin pool
 * collapses under its own deposit, a deep one barely notices.
 *
 * # Why this is exact, not a fit
 *
 *   your APR = 365 · f · V_δ / (T_δ + A)
 *
 * Only the denominator contains A. So one sampled point (`yourAprBps` at
 * `atSizeUsd`, against a known `activeTvlUsd`) pins the numerator, and every
 * other point on the curve follows exactly. Nothing here is extrapolated or
 * regressed — it is the same equation the engine evaluated, solved for its one
 * free variable.
 *
 * What it does NOT model: that your deposit changes the fee flow itself, or
 * that the pool's own liquidity reacts to yours. Both are real and both are
 * out of scope for a curve drawn from one observation, which is why this is a
 * projection of the published model rather than a forecast of the world.
 */

/** The fields a curve needs. A row missing any of them cannot be drawn. */
export type Curvable = {
  poolId: string;
  label: string;
  /** In-range liquidity, `T_δ`. Null when the venue cannot measure it. */
  activeTvlUsd: number | null;
  /** The engine's answer at `atSizeUsd`. */
  yourAprBps: number | null;
  atSizeUsd: number;
};

/**
 * `A → APR in bps`, or null when the pool cannot honestly be drawn.
 *
 * Returns null rather than guessing a denominator. That is the same rule the
 * ranking table applies — an approximated `T_δ` reintroduces the error this
 * product exists to remove, and it would be worse on a chart, where a
 * confident line reads as a measurement.
 */
export function curveFor(pool: Curvable): ((sizeUsd: number) => number) | null {
  const activeTvl = pool.activeTvlUsd;
  const apr = pool.yourAprBps;
  if (activeTvl === null || apr === null) return null;
  if (!Number.isFinite(activeTvl) || !Number.isFinite(apr)) return null;

  const denominator = activeTvl + pool.atSizeUsd;
  if (denominator <= 0) return null;

  // K = 365 · f · V_δ, recovered from the one point the engine published.
  const k = apr * denominator;
  return (sizeUsd: number) => k / (activeTvl + Math.max(0, sizeUsd));
}

/** `count` sizes from `min` to `max`, evenly spaced in log space. */
export function logSizes(min: number, max: number, count: number): number[] {
  const lo = Math.log10(min);
  const hi = Math.log10(max);
  const step = (hi - lo) / (count - 1);
  return Array.from({ length: count }, (_, i) => 10 ** (lo + i * step));
}

export type Crossover = {
  sizeUsd: number;
  /** Leader below the crossing. */
  from: string;
  /** Leader above it. */
  to: string;
  fromPoolId: string;
  toPoolId: string;
};

/**
 * Sizes at which the leading pool changes.
 *
 * This is the headline the chart exists to deliver, so it is computed rather
 * than left for the reader to spot. Detected by sampling the same grid the
 * chart plots — the curves are smooth and monotone, so a sign change between
 * adjacent samples is a real crossing, and the sample resolution bounds how
 * precisely it is located.
 */
export function crossovers(pools: Curvable[], sizes: number[]): Crossover[] {
  type Curve = { poolId: string; label: string; f: (n: number) => number };
  const curves = pools
    .map((p) => ({ poolId: p.poolId, label: p.label, f: curveFor(p) }))
    .filter((c): c is Curve => c.f !== null);

  if (curves.length < 2) return [];

  // Identity is the pool id, never the label. This chain runs three distinct
  // SOL/USDC pools at once — same pair, same chain, different bin steps and
  // wildly different in-range depth — so comparing labels would silently miss
  // every crossing between them.
  const leaderAt = (size: number) =>
    curves.reduce((best, c) => (c.f(size) > best.f(size) ? c : best));

  const found: Crossover[] = [];
  let previous = leaderAt(sizes[0]);

  for (let i = 1; i < sizes.length; i++) {
    const current = leaderAt(sizes[i]);
    if (current.poolId !== previous.poolId) {
      // Report the midpoint of the bracketing samples, in log space, since the
      // grid is logarithmic.
      const mid = 10 ** ((Math.log10(sizes[i - 1]) + Math.log10(sizes[i])) / 2);
      found.push({
        sizeUsd: mid,
        from: previous.label,
        to: current.label,
        fromPoolId: previous.poolId,
        toPoolId: current.poolId,
      });
      previous = current;
    }
  }
  return found;
}
