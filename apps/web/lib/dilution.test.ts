import { describe, expect, it } from 'vitest';
import { curveFor, logSizes, crossovers, type Curvable } from './dilution';

const pool = (over: Partial<Curvable> = {}): Curvable => ({
  poolId: 'a',
  label: 'SOL/USDC',
  activeTvlUsd: 100_000,
  yourAprBps: 1_000,
  atSizeUsd: 10_000,
  ...over,
});

describe('curveFor', () => {
  // your APR = 365·f·V_δ / (T_δ + A). Everything above the denominator is
  // constant in A, so one sampled point pins the whole curve exactly — this is
  // not a fit or an approximation.
  it('reproduces the sampled point it was built from', () => {
    const f = curveFor(pool());
    expect(f!(10_000)).toBeCloseTo(1_000, 6);
  });

  it('earns more when you deposit less', () => {
    const f = curveFor(pool())!;
    // T=100k, A=10k, apr=1000bps -> K = 1000 * 110k. At A=0: K/100k = 1100.
    expect(f(0)).toBeCloseTo(1_100, 6);
    expect(f(100_000)).toBeCloseTo(550, 6);
  });

  it('falls monotonically as the deposit grows', () => {
    const f = curveFor(pool())!;
    const sizes = [100, 1_000, 10_000, 100_000, 1_000_000];
    const aprs = sizes.map(f);
    for (let i = 1; i < aprs.length; i++) expect(aprs[i]).toBeLessThan(aprs[i - 1]);
  });

  // A pool that cannot report in-range liquidity is excluded, never
  // approximated — the same rule the ranking table applies.
  it('refuses to draw a curve without an in-range denominator', () => {
    expect(curveFor(pool({ activeTvlUsd: null }))).toBeNull();
    expect(curveFor(pool({ yourAprBps: null }))).toBeNull();
  });

  it('refuses a denominator of zero rather than dividing by it', () => {
    expect(curveFor(pool({ activeTvlUsd: 0, atSizeUsd: 0 }))).toBeNull();
  });

  // A thin pool dilutes fast; a deep one barely moves. This is the entire
  // thesis, and it is what the two curves' shapes have to show.
  it('separates a thin pool from a deep one', () => {
    const thin = curveFor(pool({ activeTvlUsd: 10_000 }))!;
    const deep = curveFor(pool({ activeTvlUsd: 10_000_000 }))!;
    const thinDrop = thin(1_000) / thin(1_000_000);
    const deepDrop = deep(1_000) / deep(1_000_000);
    expect(thinDrop).toBeGreaterThan(deepDrop * 10);
  });
});

describe('logSizes', () => {
  it('spans the range on a log scale', () => {
    const s = logSizes(100, 1_000_000, 5);
    expect(s[0]).toBeCloseTo(100);
    expect(s[4]).toBeCloseTo(1_000_000);
    expect(s[2]).toBeCloseTo(10_000);
  });

  it('is strictly increasing', () => {
    const s = logSizes(100, 1_000_000, 40);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
  });
});

describe('crossovers', () => {
  // The claim the page makes: the best venue is a function of deposit size.
  // If two curves swap order inside the plotted range, that is the proof, and
  // it should be findable rather than asserted.
  it('finds where a thin pool loses its lead to a deep one', () => {
    const thin = pool({ poolId: 'thin', label: 'Thin', activeTvlUsd: 20_000, yourAprBps: 4_000, atSizeUsd: 1_000 });
    const deep = pool({ poolId: 'deep', label: 'Deep', activeTvlUsd: 5_000_000, yourAprBps: 900, atSizeUsd: 1_000 });

    const found = crossovers([thin, deep], logSizes(100, 1_000_000, 80));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].sizeUsd).toBeGreaterThan(1_000);
    expect(found[0].sizeUsd).toBeLessThan(1_000_000);
  });

  // Two pools genuinely can share a name: the chain runs three SOL/USDC
  // pools at different bin steps. Identity has to be the pool id.
  it('detects a crossing between two pools with the same label', () => {
    const thin = pool({ poolId: 'thin', label: 'SOL/USDC', activeTvlUsd: 20_000, yourAprBps: 4_000, atSizeUsd: 1_000 });
    const deep = pool({ poolId: 'deep', label: 'SOL/USDC', activeTvlUsd: 5_000_000, yourAprBps: 900, atSizeUsd: 1_000 });

    const found = crossovers([thin, deep], logSizes(100, 1_000_000, 80));
    expect(found).toHaveLength(1);
    expect(found[0].fromPoolId).toBe('thin');
    expect(found[0].toPoolId).toBe('deep');
  });

  it('finds nothing when one pool leads throughout', () => {
    const a = pool({ poolId: 'a', label: 'A', activeTvlUsd: 1_000_000, yourAprBps: 2_000 });
    const b = pool({ poolId: 'b', label: 'B', activeTvlUsd: 1_000_000, yourAprBps: 500 });
    expect(crossovers([a, b], logSizes(100, 1_000_000, 40))).toHaveLength(0);
  });

  it('ignores pools it cannot curve', () => {
    const a = pool({ poolId: 'a' });
    const bad = pool({ poolId: 'bad', label: 'Bad', activeTvlUsd: null });
    expect(() => crossovers([a, bad], logSizes(100, 1_000_000, 20))).not.toThrow();
  });
});
