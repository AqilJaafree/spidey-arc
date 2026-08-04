import { describe, expect, it } from 'vitest';
import {
  capitalForLiquidity,
  concentrationFactor,
  deltaFromBps,
  deltaToBps,
  liquidityForCapital,
  normalizeYieldToDelta,
} from './concentration.js';

describe('§7.2 concentration factor', () => {
  // The table printed in the spec. These are the acceptance values.
  it.each([
    { label: '±1%', delta: 0.01, expected: 200 },
    { label: '±0.5%', delta: 0.005, expected: 400 },
    { label: '±0.1%', delta: 0.001, expected: 2_000 },
    { label: '±0.02%', delta: 0.0002, expected: 10_000 },
  ])('C($label) ≈ $expected×', ({ delta, expected }) => {
    // The spec quotes these as "~", and 2/δ is the limit as δ→0; the exact
    // value sits just above it. Assert sign and a 1% relative band.
    const c = concentrationFactor(delta);
    expect(c).toBeGreaterThan(expected);
    expect(Math.abs(c / expected - 1)).toBeLessThan(0.01);
  });

  it('matches the closed form 2/(2 − √(1−δ) − 1/√(1+δ)) exactly at moderate δ', () => {
    // Cross-check the cancellation-free rearrangement against the literal
    // expression, at a δ wide enough that the literal form is still accurate.
    for (const delta of [0.05, 0.1, 0.2, 0.5]) {
      const literal = 2 / (2 - Math.sqrt(1 - delta) - 1 / Math.sqrt(1 + delta));
      expect(concentrationFactor(delta)).toBeCloseTo(literal, 8);
    }
  });

  it('stays accurate at tight δ where the literal form loses precision', () => {
    // δ = 1e-6 is past where `2 − √(1−δ) − 1/√(1+δ)` survives in a double.
    // The stable form should still track 2/δ to a part in a million.
    expect(concentrationFactor(1e-6) / 2e6).toBeCloseTo(1, 5);
    expect(concentrationFactor(1e-8) / 2e8).toBeCloseTo(1, 5);
  });

  it('approaches 2/δ from above and is strictly decreasing in δ', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const delta of [1e-5, 1e-4, 1e-3, 1e-2, 1e-1]) {
      const c = concentrationFactor(delta);
      expect(c).toBeGreaterThan(2 / delta - 1);
      expect(c).toBeLessThan(prev);
      prev = c;
    }
  });

  it('rejects ranges that are not ranges', () => {
    expect(() => concentrationFactor(0)).toThrow(/positive/);
    expect(() => concentrationFactor(-0.01)).toThrow(/positive/);
    expect(() => concentrationFactor(1)).toThrow(/below 1/);
    expect(() => concentrationFactor(Number.NaN)).toThrow(/finite/);
  });
});

describe('§7.2 bps helpers', () => {
  it('round-trips δ through basis points', () => {
    expect(deltaFromBps(100)).toBeCloseTo(0.01, 12);
    expect(deltaToBps(0.01)).toBeCloseTo(100, 12);
    expect(deltaToBps(deltaFromBps(37))).toBeCloseTo(37, 12);
  });
});

describe('§7.2 liquidity for capital', () => {
  it('L relates to L_fullrange by exactly C(δ)', () => {
    const capital = 10_000;
    const price = 1;
    const delta = 0.01;
    const lFullRange = capital / (2 * Math.sqrt(price));
    expect(liquidityForCapital(capital, price, delta) / lFullRange).toBeCloseTo(
      concentrationFactor(delta),
      8,
    );
  });

  it('scales linearly in capital and as 1/√P in price', () => {
    expect(liquidityForCapital(2_000, 1, 0.01)).toBeCloseTo(
      2 * liquidityForCapital(1_000, 1, 0.01),
      8,
    );
    expect(liquidityForCapital(1_000, 4, 0.01)).toBeCloseTo(
      liquidityForCapital(1_000, 1, 0.01) / 2,
      8,
    );
  });

  it('rejects impossible inputs', () => {
    expect(() => liquidityForCapital(-1, 1, 0.01)).toThrow(/negative/);
    expect(() => liquidityForCapital(1, 0, 0.01)).toThrow(/positive/);
  });
});

describe('§6 activeTVL from pool state — the inverse map', () => {
  it('round-trips against liquidityForCapital', () => {
    for (const price of [1, 0.9998, 150.25]) {
      for (const delta of [0.0001, 0.001, 0.01, 0.1]) {
        const L = liquidityForCapital(50_000, price, delta);
        expect(capitalForLiquidity(L, price, delta)).toBeCloseTo(50_000, 6);
      }
    }
  });

  it('matches the direct v3 amounts formula L(2√P − P/√pb − √pa)', () => {
    const L = 1_000_000;
    const price = 1.0002;
    const delta = 0.005;
    const pa = price * (1 - delta);
    const pb = price * (1 + delta);
    const direct = L * (2 * Math.sqrt(price) - price / Math.sqrt(pb) - Math.sqrt(pa));
    expect(capitalForLiquidity(L, price, delta)).toBeCloseTo(direct, 6);
  });

  it('scales linearly in L and grows with range width', () => {
    expect(capitalForLiquidity(2e6, 1, 0.01)).toBeCloseTo(2 * capitalForLiquidity(1e6, 1, 0.01), 8);
    expect(capitalForLiquidity(1e6, 1, 0.02)).toBeGreaterThan(capitalForLiquidity(1e6, 1, 0.01));
  });

  it('rejects impossible pool state', () => {
    expect(() => capitalForLiquidity(-1, 1, 0.01)).toThrow(/negative/);
    expect(() => capitalForLiquidity(1, 0, 0.01)).toThrow(/positive/);
  });
});

describe('§7.2 δ normalization — the venue-quality comparison', () => {
  it('restates a tight-range yield at the reference width', () => {
    // A Meteora pool at ±0.02% showing 50% and a Uniswap pool at ±1% showing
    // 1.2% are NOT 40x apart on venue quality. Once both are stated at ±1%,
    // Meteora's 50% is worth ~1% — the Uniswap pool is the better venue.
    const meteoraAt1Pct = normalizeYieldToDelta(0.5, 0.0002, 0.01);
    expect(meteoraAt1Pct).toBeGreaterThan(0.009);
    expect(meteoraAt1Pct).toBeLessThan(0.011);
  });

  it('is the identity when the yield is already at the reference width', () => {
    expect(normalizeYieldToDelta(0.42, 0.01, 0.01)).toBeCloseTo(0.42, 12);
  });
});
