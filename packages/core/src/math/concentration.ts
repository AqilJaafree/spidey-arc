/**
 * Concentration factor — spec §7.2.
 *
 * For capital `A` in the symmetric range [P(1−δ), P(1+δ)]:
 *
 *   L    = A / (√P · (2 − √(1−δ) − 1/√(1+δ)))
 *   C(δ) = L / L_fullrange = 2 / (2 − √(1−δ) − 1/√(1+δ))  ≈  2/δ
 *
 * Why this matters (§7.2): "Meteora DLMM does not have a structural yield
 * advantage. It has a smaller δ. Any ranking that does not normalize for δ is
 * comparing range width, not venue quality."
 */

/**
 * The denominator `2 − √(1−δ) − 1/√(1+δ)`, computed without cancellation.
 *
 * Evaluated literally, that expression subtracts two numbers very close to 1
 * from 2, and for the tight ranges this system cares about (a Meteora binStep
 * of 1 is δ = 1e-4) the result is ~1e-4 built from operands of ~1 — four
 * decimal digits of the sixteen a double carries, gone to cancellation.
 *
 * The algebraically identical form below sums two positive terms instead:
 *
 *   1 − √(1−δ)   = δ / (1 + √(1−δ))
 *   1 − 1/√(1+δ) = δ / ((1 + √(1+δ)) · √(1+δ))
 *
 * Both are exact rearrangements; neither ever subtracts near-equal quantities.
 */
function rangeWidthFactor(delta: number): number {
  const rootDown = Math.sqrt(1 - delta);
  const rootUp = Math.sqrt(1 + delta);
  const lower = delta / (1 + rootDown);
  const upper = delta / ((1 + rootUp) * rootUp);
  return lower + upper;
}

function assertDelta(delta: number): number {
  if (!Number.isFinite(delta)) throw new RangeError(`expected a finite δ, got ${delta}`);
  if (delta <= 0) throw new RangeError(`δ must be positive, got ${delta}`);
  if (delta >= 1) throw new RangeError(`δ must be below 1 (a range cannot reach price 0), got ${delta}`);
  return delta;
}

/**
 * `C(δ)` — how much more liquidity a unit of capital provides in a range of
 * half-width `δ` than the same capital spread over the full curve.
 *
 * @param delta range half-width as a fraction (0.01 = ±1%)
 */
export function concentrationFactor(delta: number): number {
  return 2 / rangeWidthFactor(assertDelta(delta));
}

/** Convert a half-width in basis points to the fraction `δ`. 100 bps = ±1%. */
export const deltaFromBps = (bps: number): number => bps / 10_000;

/** Convert `δ` to basis points. */
export const deltaToBps = (delta: number): number => delta * 10_000;

/**
 * Liquidity `L` obtained by placing `capitalUsd` into [P(1−δ), P(1+δ)].
 *
 * @param capitalUsd deposit size `A`
 * @param price current price `P`
 * @param delta range half-width as a fraction
 */
export function liquidityForCapital(capitalUsd: number, price: number, delta: number): number {
  if (capitalUsd < 0) throw new RangeError(`negative capital: ${capitalUsd}`);
  if (price <= 0) throw new RangeError(`price must be positive, got ${price}`);
  return capitalUsd / (Math.sqrt(price) * rangeWidthFactor(assertDelta(delta)));
}

/**
 * USD value of CLMM liquidity `L` sitting in [P(1−δ), P(1+δ)] — the exact
 * inverse of {@link liquidityForCapital}, and the bridge from raw pool state
 * to `activeTvlUsd` (§6).
 *
 * The derivation lands on the same expression as `C(δ)`'s denominator, which
 * is not a coincidence. For a v3-style position spanning [pa, pb] with the
 * price inside it:
 *
 *   x = L(1/√P − 1/√pb)          y = L(√P − √pa)
 *   value in token1 = x·P + y = L(2√P − P/√pb − √pa)
 *
 * Substituting pa = P(1−δ), pb = P(1+δ) gives
 *
 *   value = L · √P · (2 − √(1−δ) − 1/√(1+δ))
 *
 * CAVEAT, and it is the whole reason adapters carry a fidelity tier: this is
 * exact only where `L` is constant across the band. In a CLMM `L` changes at
 * every initialized tick, so a single current-tick `L` is trustworthy only
 * within the current tick interval. Past that, real tick-level data is
 * required — approximating it is the §6 sin.
 *
 * @param liquidity `L` in price-normalized units matching `price`
 * @param price current price `P`
 * @param delta range half-width as a fraction
 */
export function capitalForLiquidity(liquidity: number, price: number, delta: number): number {
  if (liquidity < 0) throw new RangeError(`negative liquidity: ${liquidity}`);
  if (price <= 0) throw new RangeError(`price must be positive, got ${price}`);
  return liquidity * Math.sqrt(price) * rangeWidthFactor(assertDelta(delta));
}

/**
 * Normalize a venue's observed yield to a reference range width, so two
 * venues quoted at different δ can be compared on venue quality rather than
 * on how tightly they happen to be ranged.
 *
 * @param yieldAtDelta yield observed at `delta`
 * @param delta the range half-width that yield was earned at
 * @param referenceDelta the width to restate it at (default ±1%)
 */
export function normalizeYieldToDelta(
  yieldAtDelta: number,
  delta: number,
  referenceDelta = 0.01,
): number {
  return (yieldAtDelta * concentrationFactor(referenceDelta)) / concentrationFactor(delta);
}
