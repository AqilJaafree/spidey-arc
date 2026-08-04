import { describe, expect, it } from 'vitest';
import {
  ARC_NATIVE_DECIMALS,
  MAX_UINT128,
  MAX_UINT32,
  USDC_DECIMALS,
  USDC_TO_NATIVE_SCALE,
  assertUint128,
  assertUint32,
  bpsToRate,
  formatNative,
  formatUsdc,
  fromQ64_64,
  nativeToUsdc,
  nativeToUsdcExact,
  parseNative,
  parseUsdc,
  rateToBps,
  toQ64_64,
  usdcToNative,
} from './fixed.js';

// -------------------------------------------------------------------------
// Spec §7.7: "The Arc 18-vs-6 decimal split is a documented common
// integration error. Write the round-trip test before any other test."
//
// This is that test. It is deliberately the first test in the repo.
// -------------------------------------------------------------------------

describe('§7.7 Arc 18-vs-6 decimal round-trip', () => {
  it('pins the decimal constants the whole system depends on', () => {
    expect(USDC_DECIMALS).toBe(6);
    expect(ARC_NATIVE_DECIMALS).toBe(18);
    expect(USDC_TO_NATIVE_SCALE).toBe(10n ** 12n);
  });

  it('usdc -> native -> usdc is the identity, for every value', () => {
    const cases = [
      0n,
      1n, // 1 micro-USDC, the smallest ERC-20 unit
      999_999n,
      1_000_000n, // $1
      123_456_789n, // $123.456789
      1_000_000_000_000n, // $1,000,000
      MAX_UINT128 / USDC_TO_NATIVE_SCALE, // largest value that survives the widening
    ];
    for (const units of cases) {
      expect(nativeToUsdcExact(usdcToNative(units))).toBe(units);
    }
  });

  it('native -> usdc is LOSSY, and reports the dust rather than dropping it', () => {
    // 1 wei of Arc native gas is 1e-18 USDC. It cannot be represented in the
    // 6dp ERC-20 interface at all. This is the bug the spec warns about:
    // a naive `wei / 1e12` silently rounds a real fee down to zero.
    const oneWei = 1n;
    const { units, dust } = nativeToUsdc(oneWei);
    expect(units).toBe(0n);
    expect(dust).toBe(1n);

    // A gas fee of 0.0000015 USDC (1.5 micro-USDC) truncates to 1 micro-USDC
    // with 5e11 wei of dust left over.
    const fee = 1_500_000_000_000n; // 1.5e12 wei
    expect(nativeToUsdc(fee)).toEqual({ units: 1n, dust: 500_000_000_000n });
  });

  it('native -> usdc -> native is the identity ONLY on exact multiples', () => {
    const exact = 5n * USDC_TO_NATIVE_SCALE; // 5 micro-USDC, no dust
    expect(usdcToNative(nativeToUsdc(exact).units)).toBe(exact);

    const inexact = 5n * USDC_TO_NATIVE_SCALE + 1n;
    expect(usdcToNative(nativeToUsdc(inexact).units)).not.toBe(inexact);
  });

  it('nativeToUsdcExact refuses to discard dust', () => {
    expect(() => nativeToUsdcExact(1n)).toThrow(/dust/i);
    expect(() => nativeToUsdcExact(USDC_TO_NATIVE_SCALE + 1n)).toThrow(/dust/i);
    expect(nativeToUsdcExact(USDC_TO_NATIVE_SCALE)).toBe(1n);
  });

  it('rejects negative amounts on both rails', () => {
    expect(() => usdcToNative(-1n)).toThrow(/negative/i);
    expect(() => nativeToUsdc(-1n)).toThrow(/negative/i);
  });
});

describe('§7.7 USDC parse/format (6dp)', () => {
  it('parses and formats symmetrically', () => {
    expect(parseUsdc('1')).toBe(1_000_000n);
    expect(parseUsdc('1.5')).toBe(1_500_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('123456.789012')).toBe(123_456_789_012n);
    expect(formatUsdc(1n)).toBe('0.000001');
    expect(formatUsdc(1_000_000n)).toBe('1');
    expect(formatUsdc(1_500_000n)).toBe('1.5');
    expect(formatUsdc(123_456_789_012n)).toBe('123456.789012');
  });

  it('throws rather than silently truncating excess precision', () => {
    // Silent truncation here is how you lose a cent per deposit forever.
    expect(() => parseUsdc('0.0000001')).toThrow(/precision/i);
    expect(() => parseUsdc('1.1234567')).toThrow(/precision/i);
  });

  it('rejects malformed input', () => {
    expect(() => parseUsdc('')).toThrow();
    expect(() => parseUsdc('abc')).toThrow();
    expect(() => parseUsdc('1.2.3')).toThrow();
    expect(() => parseUsdc('-1')).toThrow(/negative/i);
  });

  it('parses native at 18dp without touching the 6dp path', () => {
    expect(parseNative('1')).toBe(10n ** 18n);
    expect(parseNative('0.000000000000000001')).toBe(1n);
    expect(formatNative(10n ** 18n)).toBe('1');
    expect(formatNative(1n)).toBe('0.000000000000000001');
  });
});

describe('§7.7 basis points (uint32)', () => {
  it('converts rates to bps and back', () => {
    expect(rateToBps(0.03)).toBe(300); // 3%
    expect(rateToBps(0.0001)).toBe(1); // 1 bp
    expect(rateToBps(1)).toBe(10_000); // 100%
    expect(rateToBps(9)).toBe(90_000); // 900% APR from the §1 example
    expect(bpsToRate(300)).toBeCloseTo(0.03, 12);
    expect(bpsToRate(90_000)).toBeCloseTo(9, 12);
  });

  it('rounds to the nearest bp rather than truncating', () => {
    expect(rateToBps(0.000149)).toBe(1);
    expect(rateToBps(0.000151)).toBe(2);
  });

  it('enforces the uint32 bound the contracts rely on', () => {
    expect(MAX_UINT32).toBe(4_294_967_295);
    expect(() => assertUint32(-1)).toThrow(/uint32/);
    expect(() => assertUint32(MAX_UINT32 + 1)).toThrow(/uint32/);
    expect(() => assertUint32(1.5)).toThrow(/integer/i);
    expect(assertUint32(0)).toBe(0);
    expect(assertUint32(MAX_UINT32)).toBe(MAX_UINT32);
  });

  it('rejects rates that would overflow a uint32 of bps', () => {
    // 42_949_672.96x return. Not a real yield; a unit bug.
    expect(() => rateToBps(1e9)).toThrow(/uint32/);
    expect(() => rateToBps(-0.01)).toThrow(/negative/i);
  });
});

describe('§7.7 uint128 bound (USDC amounts, VenueState.deployedAssets)', () => {
  it('matches the value the spec cites as "vastly sufficient"', () => {
    expect(MAX_UINT128).toBe(2n ** 128n - 1n);
    expect(Number(MAX_UINT128)).toBeGreaterThan(3.4e38);
    expect(() => assertUint128(-1n)).toThrow(/uint128/);
    expect(() => assertUint128(2n ** 128n)).toThrow(/uint128/);
    expect(assertUint128(MAX_UINT128)).toBe(MAX_UINT128);
  });

  it('flags when widening USDC to native would overflow uint128', () => {
    const tooBig = MAX_UINT128 / USDC_TO_NATIVE_SCALE + 1n;
    expect(() => usdcToNative(tooBig)).toThrow(/uint128/);
  });
});

describe('§7.7 Q64.64 prices', () => {
  it('round-trips prices at double precision', () => {
    for (const p of [1, 0.5, 2, 1.0001, 0.9999, 1234.5678, 1e-6]) {
      expect(fromQ64_64(toQ64_64(p))).toBeCloseTo(p, 10);
    }
  });

  it('places the binary point at bit 64', () => {
    expect(toQ64_64(1)).toBe(1n << 64n);
    expect(toQ64_64(0.5)).toBe(1n << 63n);
    expect(fromQ64_64(1n << 64n)).toBe(1);
  });

  it('rejects negative and non-finite prices', () => {
    expect(() => toQ64_64(-1)).toThrow(/negative/i);
    expect(() => toQ64_64(Number.NaN)).toThrow(/finite/i);
    expect(() => toQ64_64(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });
});
