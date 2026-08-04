import { describe, expect, it } from 'vitest';
import { estimateExitProbability, evaluateEntry, lvrRate } from './entry.js';

describe('§7.4 entry condition', () => {
  // A USDC/USDT pool: high turnover, tiny σ. The thesis case.
  const stablePool = {
    feeRate: 0.0005,
    volumeInRangeUsd: 5_000_000,
    othersLiquidityInRangeUsd: 1_000_000,
    depositUsd: 10_000,
    delta: 0.001, // ±0.1%
    exitProbability24h: 0.1,
    totalCostUsd: 5,
  };

  it('enters when f × turnover dominates σ', () => {
    const v = evaluateEntry(stablePool);
    // LHS: 0.0005 × 5e6 / 1.01e6 = 0.0024752
    expect(v.dailyFeeYield).toBeCloseTo(0.0005 * 5e6 / 1.01e6, 12);
    // RHS: (0.001/2) × 0.1 + 5/10000 = 0.00005 + 0.0005 = 0.00055
    expect(v.adverseSelectionCost).toBeCloseTo(0.00005, 12);
    expect(v.costDrag).toBeCloseTo(0.0005, 12);
    expect(v.hurdle).toBeCloseTo(0.00055, 12);
    expect(v.enter).toBe(true);
    expect(v.marginBps).toBeGreaterThan(0);
  });

  it('declines a volatile pair even at a much fatter fee', () => {
    // Same fee income, but a wide range on a pair that traverses it daily.
    // (δ/2) × p_exit = 0.05 × 0.9 = 0.045 — 18x the fee yield.
    const v = evaluateEntry({
      ...stablePool,
      delta: 0.1,
      exitProbability24h: 0.9,
      feeRate: 0.003,
    });
    expect(v.adverseSelectionCost).toBeCloseTo(0.045, 12);
    expect(v.enter).toBe(false);
    expect(v.marginBps).toBeLessThan(0);
  });

  it('lets cost alone veto an otherwise-good pool at small size', () => {
    // Identical pool, $200 deposit: the $5 entry cost is 2.5% of position.
    const v = evaluateEntry({ ...stablePool, depositUsd: 200 });
    expect(v.costDrag).toBeCloseTo(0.025, 12);
    expect(v.enter).toBe(false);
    // ...and the same pool at $10k is fine. Size decides, again.
    expect(evaluateEntry(stablePool).enter).toBe(true);
  });

  it('amortizes cost over the stated horizon, defaulting to one day', () => {
    const oneDay = evaluateEntry({ ...stablePool, depositUsd: 200 });
    const thirtyDays = evaluateEntry({ ...stablePool, depositUsd: 200, costHorizonDays: 30 });
    expect(thirtyDays.costDrag).toBeCloseTo(oneDay.costDrag / 30, 12);
    expect(thirtyDays.enter).toBe(true);
  });

  it('reproduces the spec formula exactly at the default horizon', () => {
    const v = evaluateEntry(stablePool);
    const lhs =
      (stablePool.feeRate * stablePool.volumeInRangeUsd) /
      (stablePool.othersLiquidityInRangeUsd + stablePool.depositUsd);
    const rhs =
      (stablePool.delta / 2) * stablePool.exitProbability24h +
      stablePool.totalCostUsd / stablePool.depositUsd;
    expect(v.dailyFeeYield).toBeCloseTo(lhs, 15);
    expect(v.hurdle).toBeCloseTo(rhs, 15);
  });

  it('rejects impossible inputs rather than guessing', () => {
    expect(() => evaluateEntry({ ...stablePool, depositUsd: 0 })).toThrow(/positive/);
    expect(() => evaluateEntry({ ...stablePool, exitProbability24h: 1.5 })).toThrow(/probability/);
    expect(() => evaluateEntry({ ...stablePool, delta: 0 })).toThrow(/positive/);
    expect(() => evaluateEntry({ ...stablePool, totalCostUsd: -1 })).toThrow(/negative/);
  });
});

describe('§7.4 p_exit from realized ranges', () => {
  it('counts days whose 24h range exceeded the position half-width', () => {
    // Seven days of peak-to-trough ranges, bps.
    const ranges = [8, 12, 30, 250, 6, 9, 15];
    expect(estimateExitProbability(ranges, 50)).toBeCloseTo(1 / 7, 12);
    expect(estimateExitProbability(ranges, 10)).toBeCloseTo(4 / 7, 12);
    expect(estimateExitProbability(ranges, 1000)).toBe(0);
  });

  it('is monotonically decreasing in range width', () => {
    const ranges = [8, 12, 30, 250, 6, 9, 15];
    let prev = 1.1;
    for (const delta of [5, 10, 20, 50, 100, 500]) {
      const p = estimateExitProbability(ranges, delta);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });

  it('refuses to extrapolate from no data (§10.2)', () => {
    expect(() => estimateExitProbability([], 50)).toThrow(/empty series/);
  });
});

describe('§7.4 LVR reference', () => {
  it('is σ²/8 annualized', () => {
    expect(lvrRate(0.6)).toBeCloseTo(0.045, 12);
    // A stable pair at σ = 2% loses 0.005% a year to LVR — negligible next to
    // fee income. That asymmetry is the USDC thesis in one number.
    expect(lvrRate(0.02)).toBeCloseTo(0.00005, 12);
  });
});
