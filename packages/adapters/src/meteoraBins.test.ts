import { describe, expect, it } from 'vitest';
import {
  BIN_ARRAY_SIZE,
  BINS_PER_ARRAY,
  BIN_SIZE,
  LB_PAIR_SIZE,
  activeTvlWithin,
  arrayIndexOf,
  binIdOf,
  binsNeededFor,
  bpsFromPeg,
  decodeBinArrayAmounts,
  decodeBinArrayIndex,
  decodeLbPair,
  histogramFromBins,
} from './meteoraBins.js';

/** Sizes computed from the vendored IDL; a live account matched all three. */
describe('layout constants match the IDL', () => {
  it('pins the account and record sizes', () => {
    expect(LB_PAIR_SIZE).toBe(904);
    expect(BIN_ARRAY_SIZE).toBe(10_136);
    expect(BIN_SIZE).toBe(144);
    expect(BINS_PER_ARRAY).toBe(70);
  });
});

function lbPairBytes(activeId: number, binStep: number): Uint8Array {
  const buf = new Uint8Array(LB_PAIR_SIZE);
  const view = new DataView(buf.buffer);
  view.setInt32(76, activeId, true);
  view.setUint16(80, binStep, true);
  return buf;
}

describe('decodeLbPair', () => {
  it('reads active_id at 76 and bin_step at 80', () => {
    // The values a live mainnet SOL-USDC read returned.
    expect(decodeLbPair(lbPairBytes(-6440, 4))).toEqual({ activeId: -6440, binStep: 4 });
  });

  it('handles a positive active_id', () => {
    expect(decodeLbPair(lbPairBytes(12_345, 25))).toEqual({ activeId: 12_345, binStep: 25 });
  });

  it('refuses a wrong-sized account rather than reading past the end', () => {
    expect(() => decodeLbPair(new Uint8Array(903))).toThrow(/904/);
    expect(() => decodeLbPair(new Uint8Array(905))).toThrow(/904/);
  });
});

function binArrayBytes(index: number, amounts: Array<[number, number]>): Uint8Array {
  const buf = new Uint8Array(BIN_ARRAY_SIZE);
  const view = new DataView(buf.buffer);
  view.setBigInt64(8, BigInt(index), true);
  amounts.forEach(([x, y], i) => {
    const at = 56 + i * BIN_SIZE;
    view.setBigUint64(at, BigInt(x), true);
    view.setBigUint64(at + 8, BigInt(y), true);
  });
  return buf;
}

describe('decodeBinArray', () => {
  it('reads the array index at offset 8, including negatives', () => {
    expect(decodeBinArrayIndex(binArrayBytes(-92, []))).toBe(-92);
    expect(decodeBinArrayIndex(binArrayBytes(7, []))).toBe(7);
  });

  it('reads 70 bin amount pairs starting at offset 56', () => {
    const bins = decodeBinArrayAmounts(binArrayBytes(0, [[100, 200], [0, 0], [7, 9]]));
    expect(bins).toHaveLength(BINS_PER_ARRAY);
    expect(bins[0]).toEqual({ amountX: 100n, amountY: 200n });
    expect(bins[1]).toEqual({ amountX: 0n, amountY: 0n });
    expect(bins[2]).toEqual({ amountX: 7n, amountY: 9n });
  });

  it('refuses a wrong-sized account', () => {
    expect(() => decodeBinArrayAmounts(new Uint8Array(10_135))).toThrow(/10136/);
  });
});

describe('bin identity and geometry', () => {
  it('maps (arrayIndex, slot) to a bin id', () => {
    expect(binIdOf(-92, 0)).toBe(-6440);
    expect(binIdOf(-92, 1)).toBe(-6439);
    expect(binIdOf(0, 5)).toBe(5);
  });

  it('maps a bin id back to its array, flooring toward negative infinity', () => {
    // The subtlety: truncating division would send -6441 to array -92, whose
    // slots are -6440..-6371. The fetch would silently miss the bin.
    expect(arrayIndexOf(-6440)).toBe(-92);
    expect(arrayIndexOf(-6441)).toBe(-93);
    expect(arrayIndexOf(-1)).toBe(-1);
    expect(arrayIndexOf(0)).toBe(0);
    expect(arrayIndexOf(69)).toBe(0);
    expect(arrayIndexOf(70)).toBe(1);
  });

  it('round-trips: a bin id lands in the array that claims it', () => {
    for (const binId of [-6441, -6440, -70, -1, 0, 1, 69, 70, 6440]) {
      const idx = arrayIndexOf(binId);
      expect(binId - binIdOf(idx, 0)).toBeGreaterThanOrEqual(0);
      expect(binId - binIdOf(idx, 0)).toBeLessThan(70);
    }
  });

  it('offsets compound geometrically, not linearly', () => {
    // The trap: 125 bins at binStep 4 reads as "500bps" under `k * binStep`,
    // but actually covers 512.61bps. Getting this wrong misplaces liquidity in
    // the tails, which is exactly where p_exit is decided.
    expect(bpsFromPeg(125, 0, 4)).toBeCloseTo(512.61, 1);
    expect(bpsFromPeg(125, 0, 4)).not.toBeCloseTo(500, 0);
    expect(bpsFromPeg(25, 0, 4)).toBeCloseTo(100.48, 1);
    expect(bpsFromPeg(1, 0, 4)).toBeCloseTo(4.0, 2);
  });

  it('is signed and symmetric in magnitude around the active bin', () => {
    expect(bpsFromPeg(-25, 0, 4)).toBeLessThan(0);
    expect(bpsFromPeg(10, 10, 4)).toBe(0);
    expect(Math.abs(bpsFromPeg(-1, 0, 4))).toBeCloseTo(4.0, 1);
  });

  it('inverts to the bin count a width needs', () => {
    expect(binsNeededFor(500, 4)).toBe(122);
    expect(binsNeededFor(100, 4)).toBe(25);
    expect(binsNeededFor(50, 4)).toBe(13);
    expect(binsNeededFor(20, 4)).toBe(5);
  });

  it('never asks for fewer than one bin', () => {
    expect(binsNeededFor(1, 100)).toBe(1);
    expect(binsNeededFor(0, 4)).toBe(1);
  });
});

describe('histogramFromBins', () => {
  const priced = {
    activeId: 0,
    binStep: 4,
    decimalsX: 9,
    decimalsY: 6,
    priceX: 100,
    priceY: 1,
  };

  it('values a bin as constant-sum: x at its price plus y at its price', () => {
    const h = histogramFromBins([{ binId: 0, amountX: 2n * 10n ** 9n, amountY: 50n * 10n ** 6n }], priced);
    // 2 SOL * $100 + 50 USDC * $1 = $250
    expect(h).toHaveLength(1);
    expect(h[0]!.liquidityUsd).toBeCloseTo(250, 6);
    expect(h[0]!.bpsFromPeg).toBeCloseTo(0, 9);
  });

  it('drops empty bins so the histogram carries only funded buckets', () => {
    const h = histogramFromBins(
      [
        { binId: 0, amountX: 0n, amountY: 0n },
        { binId: 1, amountX: 0n, amountY: 10n ** 6n },
      ],
      priced,
    );
    expect(h).toHaveLength(1);
    expect(h[0]!.bpsFromPeg).toBeCloseTo(4.0, 2);
  });

  it('is ordered by distance from the peg', () => {
    const h = histogramFromBins(
      [
        { binId: 5, amountX: 0n, amountY: 10n ** 6n },
        { binId: -5, amountX: 0n, amountY: 10n ** 6n },
        { binId: 0, amountX: 0n, amountY: 10n ** 6n },
      ],
      priced,
    );
    expect(h.map((b) => Math.sign(b.bpsFromPeg))).toEqual([-1, 0, 1]);
  });

  /**
   * The failure mode this guards is silent: `Number(bigint)` never throws, it
   * just rounds once the value passes 2^53. A whale bin holding 1e6 tokens at
   * 9 decimals is 1e15 raw units — under `Number.MAX_SAFE_INTEGER` (~9.007e15),
   * so the conversion is still exact. If a future edit divided *after* summing
   * raw units across bins, or handled an 18-decimal mint, it would cross that
   * ceiling and quietly understate the denominator instead of failing.
   */
  /**
   * The half-denominator bug, as a regression test.
   *
   * The per-bin finiteness filter catches both prices being bad and cannot
   * catch one. Valuing on the priced leg alone returns a non-empty histogram,
   * so the row publishes at `tick-level` with full declared coverage over a
   * denominator missing everything in the unpriced leg — the flattering
   * direction. Delete `requireUsablePricing` and every expectation below fails.
   */
  it('refuses to value a bin on one leg when the other has no price', () => {
    const oneLegged = { ...priced, priceX: 0 };
    const bin = { binId: 0, amountX: 10n ** 6n * 10n ** 9n, amountY: 50n * 10n ** 6n };

    expect(() => histogramFromBins([bin], oneLegged)).toThrow(/priceX/);
    // Not merely "does not throw for the good case" — the Y side alone is a
    // number that looks entirely plausible, which is what makes it dangerous.
    expect(histogramFromBins([bin], priced)[0]!.liquidityUsd).toBeCloseTo(100_000_050, 3);
  });

  it('refuses an unpriced Y leg too, not just X', () => {
    expect(() =>
      histogramFromBins([{ binId: 0, amountX: 10n ** 9n, amountY: 10n ** 6n }], { ...priced, priceY: 0 }),
    ).toThrow(/priceY/);
  });

  it('refuses a non-finite price rather than emitting NaN buckets', () => {
    const bin = { binId: 0, amountX: 10n ** 9n, amountY: 0n };
    expect(() => histogramFromBins([bin], { ...priced, priceX: Number.NaN })).toThrow(/priceX/);
    expect(() => histogramFromBins([bin], { ...priced, priceY: Number.POSITIVE_INFINITY })).toThrow(
      /priceY/,
    );
  });

  it('refuses decimals it cannot scale by', () => {
    const bin = { binId: 0, amountX: 10n ** 9n, amountY: 10n ** 6n };
    expect(() => histogramFromBins([bin], { ...priced, decimalsX: Number.NaN })).toThrow(/decimalsX/);
    expect(() => histogramFromBins([bin], { ...priced, decimalsY: -1 })).toThrow(/decimalsY/);
    // `undefined` reaches here whenever an API row omits the field, and
    // `10 ** undefined` is NaN — a silent whole-histogram wipe otherwise.
    expect(() =>
      histogramFromBins([bin], { ...priced, decimalsY: undefined as unknown as number }),
    ).toThrow(/decimalsY/);
  });

  it('converts a whale-sized amountX without losing precision', () => {
    const raw = 10n ** 6n * 10n ** 9n; // 1,000,000 tokens at 9 decimals
    expect(raw).toBeLessThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(Number(raw)).toBe(1e15);

    const h = histogramFromBins([{ binId: 0, amountX: raw, amountY: 0n }], priced);
    // Exactly $100,000,000 — not "about". A rounded conversion would drift.
    expect(h[0]!.liquidityUsd).toBe(100_000_000);
  });
});

/**
 * `activeTvlWithin` is the `T_delta` denominator: whole buckets in or out, no
 * partial credit. Inclusive at the boundary, because a bin sitting exactly at
 * delta is liquidity a trade at that price genuinely walks through.
 */
describe('activeTvlWithin', () => {
  const histogram = [
    { bpsFromPeg: -100.48, liquidityUsd: 40 },
    { bpsFromPeg: -50, liquidityUsd: 10 },
    { bpsFromPeg: 0, liquidityUsd: 100 },
    { bpsFromPeg: 50, liquidityUsd: 20 },
    { bpsFromPeg: 512.61, liquidityUsd: 1_000 },
  ];

  it('sums only the buckets inside delta, boundary included', () => {
    expect(activeTvlWithin(histogram, 0)).toBe(100);
    expect(activeTvlWithin(histogram, 50)).toBe(130);
    expect(activeTvlWithin(histogram, 100)).toBe(130);
    expect(activeTvlWithin(histogram, 100.48)).toBe(170);
    expect(activeTvlWithin(histogram, 1_000)).toBe(1_170);
  });

  it('returns 0 for an empty histogram rather than NaN or undefined', () => {
    expect(activeTvlWithin([], 500)).toBe(0);
  });
});
