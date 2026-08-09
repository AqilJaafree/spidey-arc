import { describe, expect, it } from 'vitest';
import {
  BIN_ARRAY_SIZE,
  BINS_PER_ARRAY,
  BIN_SIZE,
  LB_PAIR_SIZE,
  LB_PAIR_SLICE,
  activeTvlWithin,
  arrayIndexOf,
  binIdOf,
  binsNeededFor,
  bpsFromPeg,
  decodeBinArrayAmounts,
  decodeBinArrayIndex,
  decodeLbPair,
  decodeLbPairSlice,
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

/**
 * The slice decoder is what production actually calls — the RPC read asks for
 * six bytes, so `decodeLbPair` cannot be used on it. These tests exist to keep
 * the two from drifting: both take their offsets from the same constants, and
 * the agreement assertion is what an IDL move would break loudly instead of
 * leaving the production path reading offset 76 by hand.
 */
describe('decodeLbPairSlice', () => {
  it('slices exactly the two fields, derived from their offsets', () => {
    expect(LB_PAIR_SLICE).toEqual({ offset: 76, length: 6 });
  });

  it('agrees with decodeLbPair on the same account', () => {
    for (const [activeId, binStep] of [
      [-6440, 4],
      [12_345, 25],
      [0, 1],
    ] as const) {
      const whole = lbPairBytes(activeId, binStep);
      const slice = whole.subarray(LB_PAIR_SLICE.offset, LB_PAIR_SLICE.offset + LB_PAIR_SLICE.length);
      // `subarray` shares the parent buffer, which is the trap `viewOf` names:
      // a bare `new DataView(bytes.buffer)` here would read offset 0 of the
      // whole 904-byte account and get zeros.
      expect(decodeLbPairSlice(slice)).toEqual(decodeLbPair(whole));
      expect(decodeLbPairSlice(slice)).toEqual({ activeId, binStep });
    }
  });

  it('refuses a slice of the wrong length rather than reading past the end', () => {
    expect(() => decodeLbPairSlice(new Uint8Array(5))).toThrow(/6 bytes/);
    expect(() => decodeLbPairSlice(new Uint8Array(904))).toThrow(/6 bytes/);
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

  /**
   * The property, not a number.
   *
   * This test used to pin `binsNeededFor(500, 4) === 122` — the exact value that
   * embedded the bug, so it locked the asymmetry in rather than catching it. 122
   * bins at a 4bp step span −476.19..500.00, and the row that carried them
   * declared ±500bp. What the docblock claims is a property, so assert the
   * property: the count must cover δ on *both* sides, and the binding side is
   * the downside, since `1 − (1+s)^−k` is always smaller than `(1+s)^k − 1`.
   */
  it('covers the width on both sides, downside included', () => {
    for (const binStep of [1, 2, 4, 10, 20, 25, 50, 80, 100, 400]) {
      for (const deltaBps of [4, 20, 50, 100, 250, 500, 1_000, 2_500, 9_000]) {
        const k = binsNeededFor(deltaBps, binStep);
        // The side the old formula satisfied.
        expect(bpsFromPeg(k, 0, binStep)).toBeGreaterThanOrEqual(deltaBps);
        // The side it did not. This is the assertion that fails on the old code.
        expect(Math.abs(bpsFromPeg(-k, 0, binStep))).toBeGreaterThanOrEqual(deltaBps);
      }
    }
  });

  it('asks for no more bins than the downside needs', () => {
    // Minimality matters as much as sufficiency: this is an RPC budget, and
    // `arrayIndexOf` turns every extra bin into a possible extra 10KB account.
    for (const binStep of [1, 4, 10, 20, 50, 100]) {
      for (const deltaBps of [20, 100, 500, 2_500]) {
        const k = binsNeededFor(deltaBps, binStep);
        if (k <= 1) continue;
        expect(Math.abs(bpsFromPeg(-(k - 1), 0, binStep))).toBeLessThan(deltaBps);
      }
    }
  });

  /** Regression anchors, derived from the corrected formula rather than measured off it. */
  it('pins the counts the default coverage actually costs', () => {
    // Was 122 under the upside solution, which is 7 bins short below the peg.
    expect(binsNeededFor(500, 4)).toBe(129);
    expect(binsNeededFor(500, 1)).toBe(513);
    expect(binsNeededFor(100, 4)).toBe(26);
    expect(binsNeededFor(50, 4)).toBe(13);
    expect(binsNeededFor(20, 4)).toBe(6);
  });

  it('never asks for fewer than one bin', () => {
    expect(binsNeededFor(1, 100)).toBe(1);
    expect(binsNeededFor(0, 4)).toBe(1);
  });

  it('refuses a width no bin count can reach rather than looping or returning NaN', () => {
    // A price cannot fall by 100%, so the downside of a bin ladder never gets
    // there. `-log1p(-1)` is Infinity and `-log1p(-1.5)` is NaN; both would
    // propagate silently into an empty fetch three RPC calls later.
    expect(() => binsNeededFor(10_000, 4)).toThrow(/-10000bp/);
    expect(() => binsNeededFor(15_000, 4)).toThrow(/15000bp/);
    // Just inside the bound still answers.
    expect(binsNeededFor(9_999, 4)).toBeGreaterThan(0);
    expect(Number.isFinite(binsNeededFor(9_999, 4))).toBe(true);
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
