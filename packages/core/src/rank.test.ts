import { describe, expect, it } from 'vitest';
import { rank, venueGranularityBps, othersLiquidityInRange } from './rank.js';
import type { NormalizedPool } from './types.js';

const NOW = 1_770_000_000_000;

function pool(overrides: Partial<NormalizedPool> & Pick<NormalizedPool, 'poolId'>): NormalizedPool {
  return {
    chain: 'base',
    cctpDomain: 6,
    dex: 'uniswap-v3',
    pair: ['USDC', 'USDT'],
    feeBps: 5,
    feeIsDynamic: false,
    feeBpsObserved24h: null,
    tvlUsd: 10_000_000,
    activeTvlUsd: 1_000_000,
    activeTvlDeltaBps: 10,
    // Fixtures default to the highest-fidelity inputs so ranking tests are
    // about ranking; provenance flags get their own block below.
    activeTvlFidelity: 'tick-level',
    tickSpacing: 1,
    volume24h: 5_000_000,
    volume7d: null,
    fees24h: 2_500,
    fees7d: null,
    apyBase: 0.09,
    apyReward: 0,
    priceHistogram: [
      { bpsFromPeg: -5, volumeUsd: 2_000_000 },
      { bpsFromPeg: 0, volumeUsd: 1_000_000 },
      { bpsFromPeg: 5, volumeUsd: 1_800_000 },
      { bpsFromPeg: 50, volumeUsd: 200_000 },
    ],
    priceHistogramSource: 'observed',
    hourlyFeeSeries: Array.from({ length: 168 }, () => 0.09),
    hourlyVolumeSeries: Array.from({ length: 168 }, (_, i) => 30_000 + i * 10),
    volumeAutocorr: null,
    daily24hRangesBps: [4, 6, 5, 8, 3, 7, 5],
    source: 'test',
    asOf: NOW,
    ...overrides,
  };
}

describe('rank(A) — ranking is a function of deposit size (§7.3)', () => {
  const thin = pool({
    poolId: 'thin',
    dex: 'meteora-dlmm',
    chain: 'solana',
    cctpDomain: 5,
    binStep: 10,
    tickSpacing: undefined,
    tvlUsd: 400_000,
    activeTvlUsd: 20_000,
    activeTvlDeltaBps: 10,
    feeBps: 30,
    volume24h: 2_000_000,
    fees24h: 6_000,
    priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 2_000_000 }],
    hourlyFeeSeries: Array.from({ length: 168 }, () => 10.95),
  });

  const deep = pool({
    poolId: 'deep',
    activeTvlUsd: 8_000_000,
    activeTvlDeltaBps: 10,
    tvlUsd: 60_000_000,
    volume24h: 40_000_000,
    fees24h: 20_000,
    priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 40_000_000 }],
    hourlyFeeSeries: Array.from({ length: 168 }, () => 0.9125),
  });

  it('puts the thin pool first for a small deposit', () => {
    const result = rank([thin, deep], { depositUsd: 1_000, now: NOW });
    expect(result.ranked[0]?.poolId).toBe('thin');
  });

  it('reorders to the deep pool for a large deposit — nothing else changed', () => {
    const result = rank([thin, deep], { depositUsd: 10_000_000, now: NOW });
    expect(result.ranked[0]?.poolId).toBe('deep');
  });

  it('reports the dilution that caused the reorder', () => {
    const result = rank([thin, deep], { depositUsd: 10_000_000, now: NOW });
    const thinRow = result.ranked.find((r) => r.poolId === 'thin');
    expect(thinRow?.flags).toContain('dilution');
    expect(thinRow?.dilution).toBeLessThan(0.01);
    expect(thinRow?.reason).toMatch(/in-range liquidity/);
  });

  it('disagrees with the headline ranking — the §12 step 2 screenshot', () => {
    // The thin pool's headline APR is enormous; our number at size is not.
    const result = rank([thin, deep], { depositUsd: 10_000_000, now: NOW });
    expect(result.headlineDisagreement.headlineWinnerPoolId).toBe('thin');
    expect(result.headlineDisagreement.ourWinnerPoolId).toBe('deep');
    expect(result.headlineDisagreement.disagrees).toBe(true);
  });

  it('agrees with the headline when size is small enough not to matter', () => {
    const result = rank([thin, deep], { depositUsd: 100, now: NOW });
    expect(result.headlineDisagreement.disagrees).toBe(false);
  });

  it('rejects a non-positive deposit', () => {
    expect(() => rank([thin], { depositUsd: 0, now: NOW })).toThrow(/positive/);
  });
});

describe('rank — exclusions are a feature, not an error path (§6, §10.2)', () => {
  it('excludes a pool with no in-range denominator and says so', () => {
    const llama = pool({
      poolId: 'llama',
      dex: 'defillama',
      source: 'defillama',
      activeTvlUsd: null,
      activeTvlDeltaBps: null,
    });
    const result = rank([llama, pool({ poolId: 'ok' })], { depositUsd: 10_000, now: NOW });
    expect(result.ranked.map((r) => r.poolId)).toEqual(['ok']);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.flags).toContain('no-active-tvl');
    expect(result.excluded[0]?.reason).toMatch(/excluded rather than approximated/);
  });

  it('still reports the headline APR of an excluded pool, for the comparison column', () => {
    const llama = pool({ poolId: 'llama', activeTvlUsd: null, activeTvlDeltaBps: null });
    const result = rank([llama], { depositUsd: 10_000, now: NOW });
    expect(result.excluded[0]?.headlineAprBps).toBeGreaterThan(0);
    expect(result.excluded[0]?.yourAprBps).toBeNull();
  });

  it('excludes stale data rather than extrapolating it', () => {
    const stale = pool({ poolId: 'stale', asOf: NOW - 60 * 60 * 1000 });
    const result = rank([stale], { depositUsd: 10_000, now: NOW });
    expect(result.excluded[0]?.flags).toContain('stale');
    expect(result.excluded[0]?.reason).toMatch(/60 min old/);
  });

  it('excludes rather than rescaling an incompatible range width', () => {
    // activeTvl measured over ±200bp cannot answer a ±10bp question.
    const wide = pool({ poolId: 'wide', activeTvlDeltaBps: 200, tickSpacing: 1 });
    const result = rank([wide], { depositUsd: 10_000, rangeDeltaBps: 10, now: NOW });
    expect(result.excluded[0]?.flags).toContain('range-width-mismatch');
    expect(result.excluded[0]?.reason).toMatch(/excluded rather than rescaled/);
  });

  it('accepts a width within the tolerance factor', () => {
    const near = pool({ poolId: 'near', activeTvlDeltaBps: 15, tickSpacing: 1 });
    const result = rank([near], { depositUsd: 10_000, rangeDeltaBps: 10, now: NOW });
    expect(result.ranked).toHaveLength(1);
  });
});

describe('rank — range width is clamped to what the venue can express', () => {
  it('cannot place a ±1bp position in a 25bp-bin pool', () => {
    const coarse = pool({
      poolId: 'coarse',
      binStep: 25,
      tickSpacing: undefined,
      activeTvlDeltaBps: 25,
    });
    const result = rank([coarse], { depositUsd: 10_000, rangeDeltaBps: 1, now: NOW });
    expect(result.ranked[0]?.deltaBps).toBe(25);
  });

  it('honours a requested width wider than the granularity', () => {
    const fine = pool({ poolId: 'fine', tickSpacing: 1, activeTvlDeltaBps: 40 });
    const result = rank([fine], { depositUsd: 10_000, rangeDeltaBps: 40, now: NOW });
    expect(result.ranked[0]?.deltaBps).toBe(40);
  });

  it('excludes when clamping pushes δ past what the measured width supports', () => {
    // A 25bp-bin venue forces δ = 25bp, but its in-range liquidity was only
    // measured over ±10bp. Rather than rescale across a non-uniform liquidity
    // distribution, the pool drops out (§6).
    const mismatched = pool({
      poolId: 'mismatched',
      binStep: 25,
      tickSpacing: undefined,
      activeTvlDeltaBps: 10,
    });
    const result = rank([mismatched], { depositUsd: 10_000, rangeDeltaBps: 1, now: NOW });
    expect(result.ranked).toHaveLength(0);
    expect(result.excluded[0]?.flags).toContain('range-width-mismatch');
  });

  it('reads granularity from binStep or tickSpacing', () => {
    expect(venueGranularityBps(pool({ poolId: 'a', binStep: 25 }))).toBe(25);
    expect(venueGranularityBps(pool({ poolId: 'b', tickSpacing: 60, binStep: undefined }))).toBe(60);
    expect(
      venueGranularityBps(pool({ poolId: 'c', tickSpacing: undefined, binStep: undefined })),
    ).toBe(1);
  });
});

describe('rank — T_δ sourcing', () => {
  it('prefers the liquidity histogram, at any δ the histogram covers', () => {
    // `activeTvlDeltaBps` states the width the histogram was measured over, so
    // it has to reach the outermost bucket — declaring ±10bp here while
    // carrying a ±100bp bucket describes no measurement any venue took.
    const p = pool({
      poolId: 'hist',
      activeTvlUsd: 999_999_999,
      activeTvlDeltaBps: 100,
      liquidityHistogram: [
        { bpsFromPeg: -5, liquidityUsd: 300_000 },
        { bpsFromPeg: 0, liquidityUsd: 400_000 },
        { bpsFromPeg: 5, liquidityUsd: 300_000 },
        { bpsFromPeg: 100, liquidityUsd: 5_000_000 },
      ],
    });
    // Both widths beat the absurd `activeTvlUsd`, which is the point.
    expect(othersLiquidityInRange(p, 10).value).toBe(1_000_000);
    expect(othersLiquidityInRange(p, 100).value).toBe(6_000_000);
  });
});

describe('a histogram is only trusted as wide as it was measured', () => {
  /** Covers ±100bps: three buckets, $1,000 each. */
  const narrowHistogram = {
    activeTvlUsd: 3_000,
    activeTvlDeltaBps: 100,
    activeTvlFidelity: 'tick-level' as const,
    liquidityHistogram: [
      { bpsFromPeg: -100, liquidityUsd: 1_000 },
      { bpsFromPeg: 0, liquidityUsd: 1_000 },
      { bpsFromPeg: 100, liquidityUsd: 1_000 },
    ],
  };

  it('sums the histogram inside the width it covers', () => {
    const p = { ...pool({ poolId: 'narrow' }), ...narrowHistogram };
    expect(othersLiquidityInRange(p, 100)).toEqual({ value: 3_000, flag: null });
    expect(othersLiquidityInRange(p, 50)).toEqual({ value: 1_000, flag: null });
  });

  it('refuses to answer wider than it measured, rather than under-reporting', () => {
    // The dangerous direction: returning 3,000 here would understate T_δ, which
    // overstates your share of the pool and therefore your APR.
    const p = { ...pool({ poolId: 'narrow' }), ...narrowHistogram };
    expect(othersLiquidityInRange(p, 500)).toEqual({
      value: null,
      flag: 'range-width-mismatch',
    });
  });

  it('still refuses when a histogram arrives with no declared width', () => {
    const p = { ...pool({ poolId: 'narrow' }), ...narrowHistogram, activeTvlDeltaBps: null };
    expect(othersLiquidityInRange(p, 10)).toEqual({
      value: null,
      flag: 'range-width-mismatch',
    });
  });
});

describe('rank — switch verdicts against a held position (§7.5)', () => {
  const here = pool({
    poolId: 'here',
    activeTvlUsd: 1_000_000,
    priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 3_000_000 }],
  });
  const away = pool({
    poolId: 'away',
    chain: 'solana',
    cctpDomain: 5,
    dex: 'meteora-dlmm',
    binStep: 10,
    tickSpacing: undefined,
    activeTvlUsd: 1_000_000,
    priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 4_000_000 }],
  });

  it('declines a better venue when the move cannot pay back at this size', () => {
    const result = rank([here, away], {
      depositUsd: 1_000,
      currentPoolId: 'here',
      moveCost: { bridgeFeeUsd: 1.2, gasExitUsd: 0.3, gasEnterUsd: 0.3, slippageUsd: 0.2 },
      expectedHoldDays: 7,
      now: NOW,
    });
    const awayRow = result.ranked.find((r) => r.poolId === 'away');
    expect(awayRow?.switchFrom?.deltaApr).toBeGreaterThan(0);
    expect(awayRow?.switchFrom?.switch).toBe(false);
    expect(awayRow?.flags).toContain('cost-exceeds-edge');
    expect(awayRow?.reason).toMatch(/days of holding to pay back/);
  });

  it('accepts the same move at a size that clears the hurdle', () => {
    const result = rank([here, away], {
      depositUsd: 500_000,
      currentPoolId: 'here',
      moveCost: { bridgeFeeUsd: 1.2, gasExitUsd: 0.3, gasEnterUsd: 0.3, slippageUsd: 0.2 },
      expectedHoldDays: 7,
      now: NOW,
    });
    const awayRow = result.ranked.find((r) => r.poolId === 'away');
    expect(awayRow?.switchFrom?.switch).toBe(true);
    expect(awayRow?.flags).not.toContain('cost-exceeds-edge');
  });

  it('produces no switch verdicts without a held position', () => {
    const result = rank([here, away], { depositUsd: 100_000, now: NOW });
    expect(result.ranked.every((r) => r.switchFrom === null)).toBe(true);
  });
});

describe('rank — data provenance travels with the number (§6)', () => {
  it('flags a modelled volume distribution, a missing hourly series, and a single-tick L', () => {
    const modelled = pool({
      poolId: 'modelled',
      priceHistogramSource: 'modelled-uniform-over-range',
      hourlyFeeSeries: [],
      activeTvlFidelity: 'current-tick-liquidity',
    });
    const row = rank([modelled], { depositUsd: 10_000, now: NOW }).ranked[0];
    expect(row?.flags).toContain('modelled-volume-distribution');
    expect(row?.flags).toContain('no-hygiene-series');
    expect(row?.flags).toContain('current-tick-liquidity-only');
  });

  it('adds none of those flags when everything was measured', () => {
    const row = rank([pool({ poolId: 'measured' })], { depositUsd: 10_000, now: NOW }).ranked[0];
    expect(row?.flags).not.toContain('modelled-volume-distribution');
    expect(row?.flags).not.toContain('no-hygiene-series');
    expect(row?.flags).not.toContain('current-tick-liquidity-only');
  });
});

describe('rank — per-venue range width (§7.2)', () => {
  it('evaluates each pool at its own measured width when none is pinned', () => {
    const tight = pool({ poolId: 'tight', activeTvlDeltaBps: 1, tickSpacing: 1 });
    const wide = pool({ poolId: 'wide', activeTvlDeltaBps: 60, tickSpacing: 60 });
    const result = rank([tight, wide], { depositUsd: 10_000, now: NOW });

    // Both rank; neither is discarded for disagreeing about range width.
    expect(result.ranked).toHaveLength(2);
    expect(result.excluded).toHaveLength(0);
    expect(result.rangeDeltaBps).toBe('venue-native');
    expect(result.ranked.find((r) => r.poolId === 'tight')?.deltaBps).toBe(1);
    expect(result.ranked.find((r) => r.poolId === 'wide')?.deltaBps).toBe(60);
  });

  it('restates both at the reference width so quality is comparable', () => {
    // Identical pools apart from range width. The tight one earns far more
    // raw yield, but once normalized to ±10bp they are the same venue.
    const shared = {
      activeTvlUsd: 1_000_000,
      priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 5_000_000 }],
    };
    const tight = pool({ ...shared, poolId: 'tight', activeTvlDeltaBps: 1, tickSpacing: 1 });
    const wide = pool({ ...shared, poolId: 'wide', activeTvlDeltaBps: 100, tickSpacing: 100 });
    const result = rank([tight, wide], { depositUsd: 10_000, now: NOW });

    const t = result.ranked.find((r) => r.poolId === 'tight');
    const w = result.ranked.find((r) => r.poolId === 'wide');
    // Raw yields are equal here (same V_δ, same T_δ) but concentration is not...
    expect(t?.concentration).toBeGreaterThan((w?.concentration ?? 0) * 50);
    // ...so normalization moves them apart in the direction §7.2 predicts.
    expect(t?.normalizedAprBps).toBeLessThan(t?.yourAprBps as number);
    expect(w?.normalizedAprBps).toBeGreaterThan(w?.yourAprBps as number);
  });

  it('still enforces the width check when a width IS pinned', () => {
    const wide = pool({ poolId: 'wide', activeTvlDeltaBps: 200, tickSpacing: 1 });
    const result = rank([wide], { depositUsd: 10_000, rangeDeltaBps: 10, now: NOW });
    expect(result.excluded[0]?.flags).toContain('range-width-mismatch');
    expect(result.rangeDeltaBps).toBe(10);
  });
});

describe('rank — hygiene flags surface in the ranking (§7.6)', () => {
  it('flags a one-whale pool', () => {
    const whale = pool({
      poolId: 'whale',
      hourlyFeeSeries: [...Array.from({ length: 160 }, () => 0.001), ...Array.from({ length: 8 }, () => 20)],
    });
    const result = rank([whale], { depositUsd: 10_000, now: NOW });
    expect(result.ranked[0]?.flags).toContain('one-whale-volume');
  });

  it('flags a pool whose yield is mostly emissions', () => {
    const farm = pool({
      poolId: 'farm',
      apyReward: 5,
      hourlyFeeSeries: Array.from({ length: 168 }, () => 0.01),
    });
    const result = rank([farm], { depositUsd: 10_000, now: NOW });
    expect(result.ranked[0]?.flags).toContain('emissions-dependent');
  });

  it('scores a steady pool above a spiky one with the same average', () => {
    const steady = pool({
      poolId: 'steady',
      hourlyFeeSeries: Array.from({ length: 168 }, () => 0.5),
    });
    const spiky = pool({
      poolId: 'spiky',
      hourlyFeeSeries: Array.from({ length: 168 }, (_, i) => (i % 24 === 0 ? 12 : 0)),
      hourlyVolumeSeries: Array.from({ length: 168 }, (_, i) => (i % 2 === 0 ? 5_000 : 10)),
    });
    const result = rank([spiky, steady], { depositUsd: 10_000, now: NOW });
    expect(result.ranked[0]?.poolId).toBe('steady');
  });
});
