/**
 * Entry condition — spec §7.4.
 *
 *   ENTER iff   f × V_δ / (T_δ + A)  >  (δ/2) × p_exit(24h)  +  cost_total / A
 *
 * Every term is a fraction of position value over a 24h window, so the two
 * sides are directly comparable.
 *
 * `(δ/2) × p_exit` is the tractable proxy for adverse selection: on a full
 * range traversal you end fully in the depreciating leg, losing on the order
 * of `δ/2` versus holding. `p_exit` is estimated empirically from the 7-day
 * distribution of 24h price ranges for the pair.
 *
 * Theory note (§7.4): LVR for a constant-product LP under GBM accrues at
 * `σ²/8` annualized. That is the reference to cite; this traversal form is
 * what runs in code.
 *
 * The insight this encodes: concentration scales fees AND adverse selection
 * together. The edge is not "tighter δ" — it is selecting pairs where
 * `f × turnover` dominates `σ`, which is exactly the stable/stable and
 * correlated-pair universe. That is why the USDC thesis holds.
 */

export type EntryInput = {
  /** Fee rate as a fraction. */
  feeRate: number;
  /** `V_δ` — 24h volume inside the range, USD. */
  volumeInRangeUsd: number;
  /** `T_δ` — others' in-range liquidity, USD. */
  othersLiquidityInRangeUsd: number;
  /** `A` — deposit size, USD. */
  depositUsd: number;
  /** `δ` — range half-width as a fraction (0.01 = ±1%). */
  delta: number;
  /** `p_exit(24h)` — probability the position leaves its range within 24h, in [0, 1]. */
  exitProbability24h: number;
  /** `cost_total` — entry cost in USD (gas, slippage, bridge if applicable). */
  totalCostUsd: number;
  /**
   * Days over which to amortize the one-off entry cost. Defaults to 1, which
   * reproduces the spec's `cost_total / A` exactly: entry must pay for itself
   * within a single day. Raise it to price a known holding period.
   */
  costHorizonDays?: number;
};

export type EntryVerdict = {
  enter: boolean;
  /** LHS: `f × V_δ / (T_δ + A)` — 24h fee yield as a fraction of position. */
  dailyFeeYield: number;
  /** First RHS term: `(δ/2) × p_exit`. */
  adverseSelectionCost: number;
  /** Second RHS term: `cost_total / (A × horizon)`. */
  costDrag: number;
  /** RHS total — the hurdle the fee yield must clear. */
  hurdle: number;
  /** `dailyFeeYield − hurdle`, in basis points. Negative means do not enter. */
  marginBps: number;
};

export function evaluateEntry(input: EntryInput): EntryVerdict {
  const {
    feeRate,
    volumeInRangeUsd,
    othersLiquidityInRangeUsd,
    depositUsd,
    delta,
    exitProbability24h,
    totalCostUsd,
    costHorizonDays = 1,
  } = input;

  if (depositUsd <= 0) throw new RangeError(`deposit must be positive, got ${depositUsd}`);
  if (delta <= 0) throw new RangeError(`δ must be positive, got ${delta}`);
  if (exitProbability24h < 0 || exitProbability24h > 1) {
    throw new RangeError(`p_exit must be a probability in [0, 1], got ${exitProbability24h}`);
  }
  if (totalCostUsd < 0) throw new RangeError(`negative cost: ${totalCostUsd}`);
  if (costHorizonDays <= 0) {
    throw new RangeError(`cost horizon must be positive, got ${costHorizonDays}`);
  }

  const dailyFeeYield = (feeRate * volumeInRangeUsd) / (othersLiquidityInRangeUsd + depositUsd);
  const adverseSelectionCost = (delta / 2) * exitProbability24h;
  const costDrag = totalCostUsd / (depositUsd * costHorizonDays);
  const hurdle = adverseSelectionCost + costDrag;

  return {
    enter: dailyFeeYield > hurdle,
    dailyFeeYield,
    adverseSelectionCost,
    costDrag,
    hurdle,
    marginBps: (dailyFeeYield - hurdle) * 10_000,
  };
}

/**
 * Estimate `p_exit(24h)` from the recent distribution of realized 24h price
 * ranges, per §7.4's "estimate `p_exit` empirically from the 7-day
 * distribution of 24h price ranges for that pair."
 *
 * A day counts as an exit when its peak-to-trough range exceeded the position
 * half-width. That is deliberately conservative — a range wider than δ does
 * not guarantee the position left, since the move may straddle entry — so it
 * over-estimates adverse selection rather than under-estimating it.
 *
 * @param daily24hRangesBps peak-to-trough range per day, in basis points
 * @param deltaBps position half-width in basis points
 */
export function estimateExitProbability(
  daily24hRangesBps: readonly number[],
  deltaBps: number,
): number {
  if (daily24hRangesBps.length === 0) {
    throw new RangeError('cannot estimate p_exit from an empty series (§10.2: exclude, never extrapolate)');
  }
  if (deltaBps <= 0) throw new RangeError(`δ must be positive, got ${deltaBps}`);
  const exits = daily24hRangesBps.filter((range) => range > deltaBps).length;
  return exits / daily24hRangesBps.length;
}

/**
 * Annualized LVR rate for a constant-product LP under GBM: `σ²/8`.
 *
 * Reference only — cited in the writeup, not used for ranking (§7.4).
 *
 * @param annualizedVolatility `σ`, as a fraction (0.6 = 60%)
 */
export const lvrRate = (annualizedVolatility: number): number => annualizedVolatility ** 2 / 8;
