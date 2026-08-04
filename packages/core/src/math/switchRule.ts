/**
 * Cross-chain switch rule — spec §7.5.
 *
 *   H_breakeven (days) = 365 × (bridge_fee + gas_exit + gas_enter + slippage)
 *                             / (A × ΔAPR)
 *
 *   SWITCH iff  H_expected_hold  >  H_breakeven × κ        κ ∈ [1.5, 2.0]
 *
 * "Optimal venue depends on position size. Demonstrating this live is the
 * strongest single moment in the demo." (§7.5)
 *
 * The same inequality is re-checked on-chain by `Router.rebalance` (§5.3) in
 * integer arithmetic; this module is the off-chain half that decides whether
 * to propose the move at all.
 */

import { DAYS_PER_YEAR } from './feeApr.js';

/**
 * Hysteresis multiplier `κ`. The spec gives 1.5–2.0 and warns: "Without it the
 * vault flip-flops and bleeds fees." Midpoint by default.
 *
 * §7.5 also notes that App Kit's Unified Balance lowers the cost term by
 * removing bridge latency from the hold-period assumption — rerun the payback
 * table against its real cost profile before fixing this.
 */
export const DEFAULT_KAPPA = 1.75;

/** The four cost terms of a cross-venue move, USD. */
export type MoveCost = {
  bridgeFeeUsd: number;
  gasExitUsd: number;
  gasEnterUsd: number;
  slippageUsd: number;
};

export const totalMoveCost = (cost: MoveCost): number =>
  cost.bridgeFeeUsd + cost.gasExitUsd + cost.gasEnterUsd + cost.slippageUsd;

/**
 * Days of holding required for the APR differential to repay the cost of
 * moving. Returns `Infinity` when the destination is not actually better —
 * no holding period repays a negative edge.
 *
 * @param totalCostUsd sum of the four cost terms
 * @param depositUsd `A`
 * @param deltaApr `ΔAPR` as a fraction (0.03 = 3 percentage points)
 */
export function breakevenHoldDays(
  totalCostUsd: number,
  depositUsd: number,
  deltaApr: number,
): number {
  if (totalCostUsd < 0) throw new RangeError(`negative cost: ${totalCostUsd}`);
  if (depositUsd <= 0) throw new RangeError(`deposit must be positive, got ${depositUsd}`);
  if (deltaApr <= 0) return Number.POSITIVE_INFINITY;
  if (totalCostUsd === 0) return 0;
  return (DAYS_PER_YEAR * totalCostUsd) / (depositUsd * deltaApr);
}

export type SwitchInput = {
  /** `A` — position size, USD. */
  depositUsd: number;
  /** Net APR at the destination venue, as a fraction. */
  toNetApr: number;
  /** Net APR at the current venue, as a fraction. */
  fromNetApr: number;
  /** Cost of the move, either itemized or already summed. */
  cost: MoveCost | number;
  /** `H_expected_hold` — how long we expect to stay, in days. */
  expectedHoldDays: number;
  /** Hysteresis `κ`. Defaults to {@link DEFAULT_KAPPA}. */
  kappa?: number;
};

export type SwitchVerdict = {
  switch: boolean;
  /** `ΔAPR` as a fraction. Negative means the destination is worse. */
  deltaApr: number;
  totalCostUsd: number;
  /** `H_breakeven`, days. `Infinity` when there is no edge to repay it. */
  breakevenDays: number;
  /** `H_breakeven × κ` — the hold period the move actually demands. */
  requiredHoldDays: number;
  /** Why the answer is what it is — surfaced verbatim in the UI. */
  reason: 'no-edge' | 'cost-exceeds-edge' | 'clears-hurdle';
};

export function evaluateSwitch(input: SwitchInput): SwitchVerdict {
  const {
    depositUsd,
    toNetApr,
    fromNetApr,
    cost,
    expectedHoldDays,
    kappa = DEFAULT_KAPPA,
  } = input;

  if (expectedHoldDays <= 0) {
    throw new RangeError(`expected hold must be positive, got ${expectedHoldDays}`);
  }
  if (kappa < 1) throw new RangeError(`κ below 1 removes the hysteresis entirely, got ${kappa}`);

  const totalCostUsd = typeof cost === 'number' ? cost : totalMoveCost(cost);
  const deltaApr = toNetApr - fromNetApr;
  const breakevenDays = breakevenHoldDays(totalCostUsd, depositUsd, deltaApr);
  const requiredHoldDays = breakevenDays * kappa;

  if (deltaApr <= 0) {
    return {
      switch: false,
      deltaApr,
      totalCostUsd,
      breakevenDays,
      requiredHoldDays,
      reason: 'no-edge',
    };
  }

  const shouldSwitch = expectedHoldDays > requiredHoldDays;
  return {
    switch: shouldSwitch,
    deltaApr,
    totalCostUsd,
    breakevenDays,
    requiredHoldDays,
    reason: shouldSwitch ? 'clears-hurdle' : 'cost-exceeds-edge',
  };
}

/**
 * The smallest position for which a move clears the hurdle at a given hold
 * period — the inverse of the rule, solved for `A`.
 *
 * This is what makes §12 step 3 concrete: below this size the answer is "stay
 * put" no matter how good the destination looks.
 */
export function minimumSizeToSwitch(
  totalCostUsd: number,
  deltaApr: number,
  expectedHoldDays: number,
  kappa = DEFAULT_KAPPA,
): number {
  if (deltaApr <= 0) return Number.POSITIVE_INFINITY;
  if (expectedHoldDays <= 0) {
    throw new RangeError(`expected hold must be positive, got ${expectedHoldDays}`);
  }
  // Solve  expectedHold > (365 · cost / (A · ΔAPR)) · κ  for A.
  return (DAYS_PER_YEAR * totalCostUsd * kappa) / (deltaApr * expectedHoldDays);
}
