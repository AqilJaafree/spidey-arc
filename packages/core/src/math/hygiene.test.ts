import { describe, expect, it } from 'vitest';
import {
  EWMA_HALF_LIFE_HOURS,
  discountRewardApy,
  ewma,
  lag1Autocorr,
  mean,
  median,
  percentile,
  persistenceWeight,
  robustApr,
  whaleFlag,
  winsorizeUpper,
} from './hygiene.js';

/** 168 hourly buckets = the 7-day window the spec's schema carries. */
const flat = (value: number, n = 168): number[] => Array.from({ length: n }, () => value);

describe('§7.6 percentile / median', () => {
  it('interpolates linearly (numpy "type 7" convention)', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 0.95)).toBeCloseTo(9.55, 12);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 1)).toBe(10);
    expect(percentile(xs, 0.5)).toBeCloseTo(5.5, 12);
  });

  it('does not depend on input order', () => {
    expect(percentile([9, 1, 5, 3, 7], 0.5)).toBe(5);
    expect(median([10, 2, 8, 4])).toBeCloseTo(6, 12);
  });

  it('rejects empty series and out-of-range p', () => {
    expect(() => percentile([], 0.5)).toThrow(/non-empty/);
    expect(() => percentile([1], 1.5)).toThrow(/\[0, 1\]/);
    expect(() => mean([])).toThrow(/non-empty/);
  });
});

describe('§7.6 winsorize — killing the single-swap spike', () => {
  it('clamps the upper tail to p95 and leaves the rest alone', () => {
    // 19 quiet hours at 100, one hour with a whale at 50,000.
    const hours = [...flat(100, 19), 50_000];
    const clean = winsorizeUpper(hours);
    expect(Math.max(...clean)).toBeLessThan(50_000);
    expect(clean.filter((x) => x === 100)).toHaveLength(19);
  });

  it('leaves the lower tail intact — a quiet hour is real information', () => {
    const hours = [0, 0, ...flat(100, 18)];
    const clean = winsorizeUpper(hours);
    expect(clean.filter((x) => x === 0)).toHaveLength(2);
  });

  it('is the identity on a flat series', () => {
    expect(winsorizeUpper(flat(42, 24))).toEqual(flat(42, 24));
  });

  it('drags a whale-driven mean back toward the truth', () => {
    const hours = [...flat(100, 19), 50_000];
    expect(mean(hours)).toBeGreaterThan(2_500); // whale dominates
    expect(mean(winsorizeUpper(hours))).toBeLessThan(2_600);
    expect(mean(winsorizeUpper(hours))).toBeGreaterThan(100);
  });
});

describe('§7.6 EWMA', () => {
  it('is the identity on a constant series', () => {
    expect(ewma(flat(0.42), EWMA_HALF_LIFE_HOURS)).toBeCloseTo(0.42, 12);
  });

  it('halves an observation\'s weight every half-life', () => {
    const alpha = 1 - 2 ** (-1 / 12);
    // A single spike at the end contributes exactly alpha of its value.
    const spike = [...flat(0, 100), 1];
    expect(ewma(spike, 12)).toBeCloseTo(alpha, 12);
    // A spike 12 buckets back contributes alpha × (1−alpha)^12 = alpha/2.
    const older = [...flat(0, 100), 1, ...flat(0, 12)];
    expect(ewma(older, 12)).toBeCloseTo(alpha / 2, 12);
  });

  it('weights recent data more than a plain mean does', () => {
    // Yield collapsed halfway through the window.
    const decayed = [...flat(1.0, 84), ...flat(0.1, 84)];
    expect(mean(decayed)).toBeCloseTo(0.55, 10);
    expect(ewma(decayed, 12)).toBeLessThan(0.15); // tracks the new regime
  });

  it('rejects a non-positive half-life', () => {
    expect(() => ewma([1, 2], 0)).toThrow(/positive/);
    expect(() => ewma([], 12)).toThrow(/non-empty/);
  });
});

describe('§7.6 persistence weight ρ', () => {
  it('is positive for a trending series', () => {
    expect(lag1Autocorr([1, 2, 3, 4, 5])).toBeCloseTo(0.4, 12);
    expect(persistenceWeight([1, 2, 3, 4, 5])).toBeCloseTo(0.4, 12);
  });

  it('is negative for an alternating series, and floors at zero as a weight', () => {
    expect(lag1Autocorr([1, -1, 1, -1])).toBeLessThan(0);
    // A negative ρ must never flip the sign of a score.
    expect(persistenceWeight([1, -1, 1, -1])).toBe(0);
  });

  it('is 0 for a constant series, where ρ is undefined', () => {
    expect(lag1Autocorr(flat(5, 20))).toBe(0);
    expect(lag1Autocorr([])).toBe(0);
    expect(lag1Autocorr([1])).toBe(0);
  });

  it('never exceeds 1', () => {
    expect(persistenceWeight([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBeLessThanOrEqual(1);
  });
});

describe('§7.6 whale flag', () => {
  it('flags a pool whose volume is one trade', () => {
    const oneWhale = [...flat(1, 19), 5_000];
    const flag = whaleFlag(oneWhale);
    expect(flag.flagged).toBe(true);
    expect(flag.median).toBe(1);
    expect(flag.mean).toBeGreaterThan(200);
  });

  it('does not flag a broadly traded pool', () => {
    const healthy = [90, 100, 110, 95, 105, 100, 98, 102];
    expect(whaleFlag(healthy).flagged).toBe(false);
    expect(whaleFlag(healthy).ratio).toBeCloseTo(1, 1);
  });

  it('treats a zero median with positive mean as the degenerate whale case', () => {
    const mostlyEmpty = [...flat(0, 20), 1_000];
    const flag = whaleFlag(mostlyEmpty);
    expect(flag.median).toBe(0);
    expect(flag.ratio).toBe(Number.POSITIVE_INFINITY);
    expect(flag.flagged).toBe(true);
  });

  it('does not flag an all-zero series as a whale', () => {
    expect(whaleFlag(flat(0, 10)).flagged).toBe(false);
  });
});

describe('§7.6 reward discount', () => {
  it('halves emissions APY by default', () => {
    expect(discountRewardApy(0.2)).toBeCloseTo(0.1, 12);
    expect(discountRewardApy(0.2, 0.8)).toBeCloseTo(0.04, 12);
    expect(discountRewardApy(0.2, 1)).toBe(0);
  });

  it('rejects a discount outside [0, 1]', () => {
    expect(() => discountRewardApy(0.2, 1.5)).toThrow(/\[0, 1\]/);
  });
});

describe('§7.6 pipeline end to end', () => {
  it('penalizes a spiky, non-persistent pool against a steady one', () => {
    const steadyVolume = Array.from({ length: 168 }, (_, i) => 1_000 + i * 5);
    const steady = robustApr({ hourlyApr: flat(0.5), hourlyVolume: steadyVolume });

    // Same average APR, but delivered in whale bursts with no persistence.
    const spikyApr = Array.from({ length: 168 }, (_, i) => (i % 24 === 0 ? 12 : 0));
    const spikyVolume = Array.from({ length: 168 }, (_, i) => (i % 2 === 0 ? 5_000 : 10));
    const spiky = robustApr({ hourlyApr: spikyApr, hourlyVolume: spikyVolume });

    expect(mean(spikyApr)).toBeCloseTo(0.5, 10); // identical raw average
    expect(spiky.score).toBeLessThan(steady.score);
    expect(spiky.whale.flagged).toBe(true);
    expect(steady.whale.flagged).toBe(false);
  });

  it('adds emissions only after discounting them', () => {
    const withRewards = robustApr({
      hourlyApr: flat(0.1),
      hourlyVolume: Array.from({ length: 168 }, (_, i) => 1_000 + i),
      apyReward: 0.4,
    });
    expect(withRewards.discountedRewardApy).toBeCloseTo(0.2, 12);
    expect(withRewards.score).toBeCloseTo(
      withRewards.aprEwma * withRewards.persistence + 0.2,
      12,
    );
  });

  it('scores zero persistence when no volume series is available', () => {
    const noVolume = robustApr({ hourlyApr: flat(0.5), hourlyVolume: [] });
    expect(noVolume.persistence).toBe(0);
    expect(noVolume.score).toBe(0);
  });
});
