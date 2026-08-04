import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KAPPA,
  breakevenHoldDays,
  evaluateSwitch,
  minimumSizeToSwitch,
  totalMoveCost,
} from './switchRule.js';

describe('§7.5 breakeven hold — the worked example', () => {
  // "Worked example, ΔAPR = 3%, total cost $2"
  const COST = 2;
  const DELTA_APR = 0.03;

  it.each([
    { size: 1_000, expected: 24, verdict: 'Do not move' },
    { size: 10_000, expected: 2.4, verdict: 'Marginal' },
    { size: 50_000, expected: 0.5, verdict: 'Move now' },
  ])('A = $$size → ~$expected days ($verdict)', ({ size, expected }) => {
    const days = breakevenHoldDays(COST, size, DELTA_APR);
    expect(days).toBeCloseTo((365 * COST) / (size * DELTA_APR), 12);
    // The spec rounds; assert within 5% of its printed figure.
    expect(Math.abs(days / expected - 1)).toBeLessThan(0.05);
  });

  it('scales inversely with position size — "optimal venue depends on size"', () => {
    expect(breakevenHoldDays(COST, 1_000, DELTA_APR)).toBeCloseTo(
      10 * breakevenHoldDays(COST, 10_000, DELTA_APR),
      10,
    );
  });

  it('is infinite when the destination has no edge', () => {
    expect(breakevenHoldDays(COST, 10_000, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(breakevenHoldDays(COST, 10_000, -0.01)).toBe(Number.POSITIVE_INFINITY);
  });

  it('is zero when the move is free', () => {
    expect(breakevenHoldDays(0, 10_000, DELTA_APR)).toBe(0);
  });
});

describe('§7.5 switch rule with hysteresis', () => {
  const cost = { bridgeFeeUsd: 1.2, gasExitUsd: 0.3, gasEnterUsd: 0.3, slippageUsd: 0.2 };

  it('sums the four cost terms', () => {
    expect(totalMoveCost(cost)).toBeCloseTo(2, 12);
  });

  it('κ defaults inside the spec band [1.5, 2.0]', () => {
    expect(DEFAULT_KAPPA).toBeGreaterThanOrEqual(1.5);
    expect(DEFAULT_KAPPA).toBeLessThanOrEqual(2.0);
  });

  it('walks the demo: same edge, three sizes, three answers', () => {
    const shared = { toNetApr: 0.09, fromNetApr: 0.06, cost, expectedHoldDays: 7 };

    // $1k: needs 24.3 × 1.75 ≈ 42.6 days of holding. We expect 7. Decline.
    const small = evaluateSwitch({ ...shared, depositUsd: 1_000 });
    expect(small.switch).toBe(false);
    expect(small.reason).toBe('cost-exceeds-edge');
    expect(small.requiredHoldDays).toBeCloseTo(42.58, 1);

    // $10k: needs 4.26 days. Clears 7, but only just — the "marginal" row.
    const medium = evaluateSwitch({ ...shared, depositUsd: 10_000 });
    expect(medium.switch).toBe(true);
    expect(medium.requiredHoldDays).toBeCloseTo(4.258, 2);
    // ...and at a 3-day expected hold the same position stays put.
    expect(evaluateSwitch({ ...shared, depositUsd: 10_000, expectedHoldDays: 3 }).switch).toBe(
      false,
    );

    // $50k: needs 0.85 days. Move.
    const large = evaluateSwitch({ ...shared, depositUsd: 50_000 });
    expect(large.switch).toBe(true);
    expect(large.reason).toBe('clears-hurdle');
  });

  it('refuses a move to a worse venue and says why', () => {
    const v = evaluateSwitch({
      depositUsd: 1_000_000,
      toNetApr: 0.05,
      fromNetApr: 0.06,
      cost: 0,
      expectedHoldDays: 365,
    });
    expect(v.switch).toBe(false);
    expect(v.reason).toBe('no-edge');
    expect(v.deltaApr).toBeCloseTo(-0.01, 12);
  });

  it('hysteresis is what stops the flip-flop', () => {
    // A move that breaks even in exactly the time we expect to hold is not
    // worth making — κ is the margin that keeps the vault from churning.
    const shared = {
      depositUsd: 10_000,
      toNetApr: 0.09,
      fromNetApr: 0.06,
      cost,
      expectedHoldDays: 2.44, // ≈ H_breakeven
    };
    expect(evaluateSwitch({ ...shared, kappa: 1 }).switch).toBe(true);
    expect(evaluateSwitch({ ...shared, kappa: DEFAULT_KAPPA }).switch).toBe(false);
  });

  it('rejects a κ that would disable hysteresis entirely', () => {
    expect(() =>
      evaluateSwitch({
        depositUsd: 1_000,
        toNetApr: 0.09,
        fromNetApr: 0.06,
        cost,
        expectedHoldDays: 7,
        kappa: 0.5,
      }),
    ).toThrow(/hysteresis/);
  });
});

describe('§7.5 inverted: the minimum size worth moving', () => {
  it('agrees with the forward rule at the boundary', () => {
    const minSize = minimumSizeToSwitch(2, 0.03, 7);
    expect(minSize).toBeCloseTo((365 * 2 * DEFAULT_KAPPA) / (0.03 * 7), 8);

    const justUnder = evaluateSwitch({
      depositUsd: minSize * 0.99,
      toNetApr: 0.09,
      fromNetApr: 0.06,
      cost: 2,
      expectedHoldDays: 7,
    });
    const justOver = evaluateSwitch({
      depositUsd: minSize * 1.01,
      toNetApr: 0.09,
      fromNetApr: 0.06,
      cost: 2,
      expectedHoldDays: 7,
    });
    expect(justUnder.switch).toBe(false);
    expect(justOver.switch).toBe(true);
  });

  it('is infinite when there is no edge', () => {
    expect(minimumSizeToSwitch(2, 0, 7)).toBe(Number.POSITIVE_INFINITY);
  });
});
