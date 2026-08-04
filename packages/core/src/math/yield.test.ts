import { describe, expect, it } from 'vitest';
import { headlineFeeApr, observedFeeRate, poolFeeApr } from './feeApr.js';
import {
  depositForDilution,
  dilutionFactor,
  volumeCaptureRatio,
  volumeInRange,
  yourFeeApr,
  type PriceHistogramBucket,
} from './dilution.js';

describe('§7.1 pool fee APR', () => {
  it('annualizes 24h fees over ACTIVE liquidity', () => {
    // $10M daily volume, 5bp fee, $2M in range.
    // 365 × (10e6 × 0.0005) / 2e6 = 0.9125 = 91.25% APR
    expect(poolFeeApr({ volume24hUsd: 10e6, feeRate: 0.0005, activeTvlUsd: 2e6 })).toBeCloseTo(
      0.9125,
      10,
    );
  });

  it('is the headline number divided by the in-range share — the §1 bug', () => {
    // §1: "Only in-range liquidity earns fees, and it is often 2–10% of
    // displayed TVL." A pool with $50M TVL of which $2.5M (5%) is in range
    // has a true fee APR 20x its headline.
    const shared = { volume24hUsd: 10e6, feeRate: 0.0005 };
    const headline = headlineFeeApr({ ...shared, tvlUsd: 50e6 });
    const real = poolFeeApr({ ...shared, activeTvlUsd: 2.5e6 });
    expect(real / headline).toBeCloseTo(20, 10);
  });

  it('refuses to score a pool with no in-range liquidity (§6)', () => {
    // "If a venue cannot supply activeTvlUsd, it is EXCLUDED from ranking,
    // not approximated."
    expect(() => poolFeeApr({ volume24hUsd: 1e6, feeRate: 0.0005, activeTvlUsd: 0 })).toThrow(
      /exclude it, do not approximate/,
    );
  });
});

describe('§6 realized fee rate', () => {
  it('derives the rate actually charged, not the advertised tier', () => {
    // Meteora's dynamic fee: advertised base 1bp, realized 3.2bp under load.
    expect(observedFeeRate(3_200, 10e6)).toBeCloseTo(0.00032, 12);
  });

  it('returns null on zero volume rather than pretending the rate is 0', () => {
    expect(observedFeeRate(0, 0)).toBeNull();
  });
});

describe('§7.3 dilution-aware yield — the formula no dashboard implements', () => {
  it('puts YOUR deposit in the denominator', () => {
    // 365 × 0.0005 × 5e6 / (1e6 + 1e5) = 0.8295...
    expect(
      yourFeeApr({
        feeRate: 0.0005,
        volumeInRangeUsd: 5e6,
        othersLiquidityInRangeUsd: 1e6,
        depositUsd: 1e5,
      }),
    ).toBeCloseTo((365 * 0.0005 * 5e6) / 1.1e6, 10);
  });

  it('collapses the thin-pool headline APR — the §1 example', () => {
    // "A pool showing 900% APR on $8k of active liquidity pays roughly 350%
    // once you add $5k."
    //
    // NOTE: §7.3's formula gives T/(T+A) = 8/13 = 61.5% of 900% = 554%, not
    // 350%. The §1 prose figure is not reproducible from the spec's own
    // formula; §7.3 is normative, so that is what is implemented and tested.
    // Reaching 350% would need a deposit of ~$12.6k, not $5k.
    const undiluted = 9.0; // 900% APR on $8k active
    const impliedFeeVolume = (undiluted * 8_000) / (365 * 0.0005);
    const diluted = yourFeeApr({
      feeRate: 0.0005,
      volumeInRangeUsd: impliedFeeVolume,
      othersLiquidityInRangeUsd: 8_000,
      depositUsd: 5_000,
    });
    expect(diluted).toBeCloseTo(undiluted * (8 / 13), 8);
    expect(diluted).toBeGreaterThan(5.5);
    expect(diluted).toBeLessThan(5.6);

    // The size that WOULD produce the spec's 350%:
    expect(depositForDilution(8_000, 3.5 / 9)).toBeCloseTo(12_571.4, 0);
  });

  it('is strictly decreasing in deposit size — so rank is a function of A', () => {
    const base = {
      feeRate: 0.0005,
      volumeInRangeUsd: 5e6,
      othersLiquidityInRangeUsd: 1e6,
    };
    const sizes = [1e3, 1e4, 1e5, 1e6, 1e7];
    const aprs = sizes.map((depositUsd) => yourFeeApr({ ...base, depositUsd }));
    for (let i = 1; i < aprs.length; i += 1) {
      expect(aprs[i] as number).toBeLessThan(aprs[i - 1] as number);
    }
  });

  it('reorders two pools purely on deposit size — the §12 step 3 moment', () => {
    // Pool A: thin but hot. Pool B: deep and boring.
    const thin = { feeRate: 0.003, volumeInRangeUsd: 2e6, othersLiquidityInRangeUsd: 20_000 };
    const deep = { feeRate: 0.0005, volumeInRangeUsd: 40e6, othersLiquidityInRangeUsd: 8e6 };

    const small = 1_000;
    expect(yourFeeApr({ ...thin, depositUsd: small })).toBeGreaterThan(
      yourFeeApr({ ...deep, depositUsd: small }),
    );

    // Crossover for this pair sits near $3.4M, where thin's tiny denominator
    // finally stops being an advantage.
    const large = 10_000_000;
    expect(yourFeeApr({ ...thin, depositUsd: large })).toBeLessThan(
      yourFeeApr({ ...deep, depositUsd: large }),
    );

    const crossover = 3_400_000;
    expect(yourFeeApr({ ...thin, depositUsd: crossover })).toBeCloseTo(
      yourFeeApr({ ...deep, depositUsd: crossover }),
      2,
    );
  });

  it('rejects a zero deposit — there is no "your APR" without a you', () => {
    expect(() =>
      yourFeeApr({
        feeRate: 0.0005,
        volumeInRangeUsd: 1e6,
        othersLiquidityInRangeUsd: 1e6,
        depositUsd: 0,
      }),
    ).toThrow(/positive/);
  });
});

describe('§7.3 dilution diagnostics', () => {
  it('reports the surviving fraction of pool yield', () => {
    expect(dilutionFactor(8_000, 5_000)).toBeCloseTo(8 / 13, 12);
    expect(dilutionFactor(1e9, 1_000)).toBeCloseTo(1, 5); // your size is irrelevant
  });

  it('inverts to the deposit that halves your own return', () => {
    expect(depositForDilution(8_000, 0.5)).toBeCloseTo(8_000, 8);
    expect(dilutionFactor(8_000, depositForDilution(8_000, 0.25))).toBeCloseTo(0.25, 8);
  });
});

describe('§7.3 volume in range', () => {
  // "For stable pairs, 80–95% of volume typically sits within ±0.05% of peg."
  const stablePairHistogram: PriceHistogramBucket[] = [
    { bpsFromPeg: -20, volumeUsd: 400_000 },
    { bpsFromPeg: -5, volumeUsd: 2_800_000 },
    { bpsFromPeg: -1, volumeUsd: 2_400_000 },
    { bpsFromPeg: 0, volumeUsd: 1_000_000 },
    { bpsFromPeg: 1, volumeUsd: 2_300_000 },
    { bpsFromPeg: 5, volumeUsd: 500_000 },
    { bpsFromPeg: 30, volumeUsd: 600_000 },
  ]; // $10M total

  it('sums only the buckets inside ±δ, boundary inclusive', () => {
    expect(volumeInRange(stablePairHistogram, 1)).toBe(5_700_000);
    expect(volumeInRange(stablePairHistogram, 5)).toBe(9_000_000);
    expect(volumeInRange(stablePairHistogram, 0)).toBe(1_000_000);
  });

  it('confirms the ±0.05% concentration the thesis rests on', () => {
    // ±0.05% = ±5 bps
    const captured = volumeCaptureRatio(stablePairHistogram, 5);
    expect(captured).toBeGreaterThan(0.8);
    expect(captured).toBeLessThan(0.95);
  });

  it('shows a wide range capturing barely more than a tight one', () => {
    // Widening from ±5bp to ±20bp buys 4 points of volume capture while
    // diluting concentration 4x. This is why wide positions "show large
    // notional TVL" and earn almost nothing (§7.4).
    const tight = volumeCaptureRatio(stablePairHistogram, 5);
    const wide = volumeCaptureRatio(stablePairHistogram, 20);
    expect(tight).toBeCloseTo(0.9, 10);
    expect(wide).toBeCloseTo(0.94, 10);
    expect(wide - tight).toBeLessThan(0.06);
  });

  it('returns 0 capture for an empty histogram rather than NaN', () => {
    expect(volumeCaptureRatio([], 5)).toBe(0);
    expect(volumeInRange([], 5)).toBe(0);
  });
});
