/**
 * Meteora DLMM bin decoding — pure, no I/O.
 *
 * Meteora publishes no per-bin endpoint; bins are on-chain accounts. So the
 * only route to a real in-range denominator is decoding `BinArray` accounts,
 * and the only way to keep that testable is to keep the bytes-in/values-out
 * part separate from anything that touches a network. Everything here takes a
 * `Uint8Array` or a plain object.
 *
 * Offsets are computed from the IDL the repo already vendors at
 * `solana/idls/lb_clmm.devnet.json`, not read off a blog post. A live mainnet
 * account matched all three sizes and both field offsets.
 *
 * Bins are **constant-sum**: each holds concrete amounts of X and Y rather
 * than a liquidity constant, so a bin's USD value is a weighted sum with no
 * `L` inversion. That is what makes `activeTvlFidelity: 'tick-level'` honest
 * at any width, unlike a single current-tick `L`.
 */

import type { LiquidityHistogramBucket } from '@spidey/core';

export const LB_PAIR_SIZE = 904;
export const BIN_ARRAY_SIZE = 10_136;
export const BIN_SIZE = 144;
export const BINS_PER_ARRAY = 70;

const LB_PAIR_ACTIVE_ID_OFFSET = 76;
const LB_PAIR_BIN_STEP_OFFSET = 80;
const BIN_ARRAY_INDEX_OFFSET = 8;
const BIN_ARRAY_BINS_OFFSET = 56;

export type LbPairState = { activeId: number; binStep: number };
export type BinAmounts = { amountX: bigint; amountY: bigint };
export type IdentifiedBin = BinAmounts & { binId: number };

/**
 * Exact-length check, not a minimum.
 *
 * A shorter buffer would read garbage or throw somewhere deep inside a field
 * read; a longer one means the account is not the type it was assumed to be —
 * a different program, or an IDL that moved. Both are configuration errors
 * worth surfacing loudly, because the failure they produce downstream is a
 * plausible-looking denominator rather than an exception.
 *
 * The `byteOffset`/`byteLength` arguments matter: a `Uint8Array` sliced with
 * `subarray` shares its parent's buffer, so a bare `new DataView(bytes.buffer)`
 * would silently read from the wrong origin.
 */
function viewOf(bytes: Uint8Array, expected: number, what: string): DataView {
  if (bytes.length !== expected) {
    throw new RangeError(`${what}: expected ${expected} bytes, got ${bytes.length}`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** `active_id` and `bin_step` — the only two `LbPair` fields this needs. */
export function decodeLbPair(bytes: Uint8Array): LbPairState {
  const view = viewOf(bytes, LB_PAIR_SIZE, 'LbPair');
  return {
    activeId: view.getInt32(LB_PAIR_ACTIVE_ID_OFFSET, true),
    binStep: view.getUint16(LB_PAIR_BIN_STEP_OFFSET, true),
  };
}

/**
 * The `dataSlice` that carries both fields and nothing else: six bytes out of
 * 904, `active_id` (i32) immediately followed by `bin_step` (u16).
 *
 * Derived from the two offsets rather than written down, because the production
 * read is the slice and not the whole account — see {@link decodeLbPairSlice}.
 */
export const LB_PAIR_SLICE = {
  offset: LB_PAIR_ACTIVE_ID_OFFSET,
  length: LB_PAIR_BIN_STEP_OFFSET + 2 - LB_PAIR_ACTIVE_ID_OFFSET,
};

/**
 * The same two fields, out of {@link LB_PAIR_SLICE} rather than the whole
 * account.
 *
 * This exists so the offsets have exactly one home. The bin reader asks the RPC
 * for six bytes, so it cannot call {@link decodeLbPair}, and it used to
 * re-hardcode `offset: 76` with sub-offsets `0` and `4` inline — which left
 * `decodeLbPair`, `LB_PAIR_SIZE` and both offset constants with no consumer
 * outside the tests. An IDL that moved would have had the constants and their
 * tests updated while the production path went on reading offset 76.
 *
 * The sub-offsets are differences against `LB_PAIR_SLICE.offset`, so moving
 * either field moves the slice, the request and the decode together.
 */
export function decodeLbPairSlice(bytes: Uint8Array): LbPairState {
  const view = viewOf(bytes, LB_PAIR_SLICE.length, 'LbPair slice');
  return {
    activeId: view.getInt32(LB_PAIR_ACTIVE_ID_OFFSET - LB_PAIR_SLICE.offset, true),
    binStep: view.getUint16(LB_PAIR_BIN_STEP_OFFSET - LB_PAIR_SLICE.offset, true),
  };
}

/** Signed — pools below their initial price have negative array indices. */
export function decodeBinArrayIndex(bytes: Uint8Array): number {
  const view = viewOf(bytes, BIN_ARRAY_SIZE, 'BinArray');
  return Number(view.getBigInt64(BIN_ARRAY_INDEX_OFFSET, true));
}

/**
 * The 70 `(amount_x, amount_y)` pairs. The other `Bin` fields —
 * `liquidity_supply`, the fee accumulators, limit-order state — are skipped:
 * constant-sum means the amounts alone value the bin.
 */
export function decodeBinArrayAmounts(bytes: Uint8Array): BinAmounts[] {
  const view = viewOf(bytes, BIN_ARRAY_SIZE, 'BinArray');
  const bins: BinAmounts[] = [];
  for (let i = 0; i < BINS_PER_ARRAY; i += 1) {
    const at = BIN_ARRAY_BINS_OFFSET + i * BIN_SIZE;
    bins.push({
      amountX: view.getBigUint64(at, true),
      amountY: view.getBigUint64(at + 8, true),
    });
  }
  return bins;
}

export const binIdOf = (arrayIndex: number, slot: number): number =>
  arrayIndex * BINS_PER_ARRAY + slot;

/**
 * Which array holds a bin id. Floors, so it is correct for negatives.
 *
 * `Math.trunc`-style division (what `/` plus `|0` gives) would map -6441 to
 * array -92, whose slots are -6440..-6371. The bin would simply be absent from
 * the fetch — no error, just a denominator missing its outermost liquidity.
 */
export const arrayIndexOf = (binId: number): number => Math.floor(binId / BINS_PER_ARRAY);

/**
 * Signed distance from the active bin, in bps.
 *
 * Bin prices are geometric — `(1 + binStep/1e4)^k` — so the linear `k·binStep`
 * shortcut drifts as `k` grows. At `binStep = 4`, `k = 125` is 512.61bps, not
 * 500. The shortcut is a tail-misplacing bug, not a rounding choice.
 */
export function bpsFromPeg(binId: number, activeId: number, binStep: number): number {
  const k = binId - activeId;
  return ((1 + binStep / 10_000) ** k - 1) * 10_000;
}

/**
 * Bins either side needed to cover `deltaBps`, on the side that binds.
 *
 * The inverse of {@link bpsFromPeg} is one-sided, which is the whole subtlety.
 * `k` bins reach `(1+s)^k − 1` above the peg but only `1 − (1+s)^−k` below it,
 * and the downside is always the smaller of the two. Solving the upside —
 * `ceil(log1p(δ/1e4) / log1p(s))`, which this function used to do — returns a
 * count that covers δ up and falls short of it down:
 *
 *     binStep   1  ->  488 bins, +500.08 / -476.26   short by 23.74bp
 *     binStep   4  ->  122 bins, +500.00 / -476.19   short by 23.81bp
 *     binStep  10  ->   49 bins, +501.95 / -477.96   short by 22.04bp
 *     binStep  20  ->   25 bins, +512.19 / -487.23   short by 12.77bp
 *     binStep  50  ->   10 bins, +511.40 / -486.52   short by 13.48bp
 *
 * The fetched bins are then declared as `activeTvlDeltaBps: 500`, so
 * `othersLiquidityInRange` sums at ±500 over bins that were never read below
 * −476. Worth 0.5–2.2% of `T_δ` on the recorded fixtures — and always in the
 * same direction, because the missing bins can only make the denominator
 * smaller, which makes the APR larger.
 *
 * So solve the downside: `1 − (1+s)^−k >= δ/1e4`, i.e.
 * `k = ceil(−log1p(−δ/1e4) / log1p(s))`. Covering the downside covers the
 * upside for free, so this is the inverse the docblock always claimed to be.
 *
 * `Math.log1p` rather than `Math.log(1 + x)`: at a 1bp `binStep` the argument
 * is 1e-4, where the naive form loses significant digits in the subtraction
 * and can round the bin count down — under-fetching the very edge of the range.
 * `ceil` then guarantees the returned count *covers* delta rather than falling
 * just inside it.
 *
 * A δ of 10,000bp or wider is refused rather than clamped or looped: a
 * geometric ladder's downside asymptotes at −10,000bp, which is a price of
 * zero, so no `k` reaches it. The arithmetic agrees but says so unhelpfully —
 * `−log1p(−1)` is `Infinity` and `−log1p(−1.5)` is `NaN`, and both propagate
 * through `arrayIndexOf` into a bin-array filter that matches nothing, so the
 * refusal arrives three RPC calls later wearing the wrong error. Throwing here
 * degrades the row to `unavailable` naming the width nobody can answer.
 */
export function binsNeededFor(deltaBps: number, binStep: number): number {
  if (!(deltaBps > 0)) return 1;
  if (deltaBps >= 10_000) {
    throw new RangeError(
      `no bin count covers ±${deltaBps}bp: a bin ladder's downside asymptotes at -10000bp`,
    );
  }
  const k = Math.ceil(-Math.log1p(-deltaBps / 10_000) / Math.log1p(binStep / 10_000));
  return Math.max(1, k);
}

export type BinPricing = {
  activeId: number;
  binStep: number;
  decimalsX: number;
  decimalsY: number;
  priceX: number;
  priceY: number;
};

/**
 * Both legs priceable, or neither is.
 *
 * The per-bin `Number.isFinite(liquidityUsd) && liquidityUsd > 0` filter in
 * {@link histogramFromBins} catches *both* prices being unusable; it cannot
 * catch *one*. With `priceY > 0` and `priceX === 0` every bin is valued on its
 * Y side alone, the histogram comes back non-empty, and the row publishes as
 * `activeTvlFidelity: 'tick-level'` with its full declared coverage over half a
 * denominator. Zero is the case already caught. A half is the one that
 * flatters, and it flatters by however much of the pool sits in the unpriced
 * leg — `enrichWithBins` promises never to produce a zero denominator, and a
 * partial one is worse than the case that promise names.
 *
 * This is reachable from live data, not hypothetical: the recorded REST page
 * carries `Cc2duQx11dv3YW5pWAjXE37RJYPkXsjaswzEHyheqgRR` (XMR-USDT) with
 * `token_x.price: 0`. It holds $18 so it never clears the enrichment floors
 * today, and nothing here depends on that — a pool with a large USDC side and
 * an unpriced counter-token reports `tvl` from the USDC side alone, clears $1M,
 * and gets read.
 *
 * Throwing rather than returning an empty histogram: both degrade the row to
 * `'unavailable'` through `enrichWithBins`' catch, but empty also means "no
 * funded bins in range", and a caller must not read "cannot value these bins"
 * as "this range is empty".
 */
function requireUsablePricing(pricing: BinPricing): void {
  for (const [what, price] of [
    ['priceX', pricing.priceX],
    ['priceY', pricing.priceY],
  ] as const) {
    if (!Number.isFinite(price) || price <= 0) {
      throw new RangeError(`unusable ${what} (${price}): a bin cannot be valued on one leg`);
    }
  }
  for (const [what, decimals] of [
    ['decimalsX', pricing.decimalsX],
    ['decimalsY', pricing.decimalsY],
  ] as const) {
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new RangeError(`unusable ${what} (${decimals}): cannot scale raw amounts`);
    }
  }
}

/**
 * Funded bins → a liquidity-by-distance-from-peg histogram.
 *
 * Empty bins are dropped rather than emitted as zero buckets: the consumer
 * sums by distance, so a zero bucket carries no information and only inflates
 * the payload. A consequence worth knowing downstream — the outermost bucket
 * is therefore *not* the measured width, so coverage has to be declared
 * separately rather than inferred from this array.
 *
 * Refuses outright on unusable pricing rather than valuing what it can — see
 * {@link requireUsablePricing} for why a half-priced bin is the dangerous case.
 */
export function histogramFromBins(
  bins: readonly IdentifiedBin[],
  pricing: BinPricing,
): LiquidityHistogramBucket[] {
  requireUsablePricing(pricing);

  const scaleX = 10 ** pricing.decimalsX;
  const scaleY = 10 ** pricing.decimalsY;

  return bins
    .filter((b) => b.amountX > 0n || b.amountY > 0n)
    .map((b) => ({
      bpsFromPeg: bpsFromPeg(b.binId, pricing.activeId, pricing.binStep),
      liquidityUsd:
        (Number(b.amountX) / scaleX) * pricing.priceX + (Number(b.amountY) / scaleY) * pricing.priceY,
    }))
    .filter((b) => Number.isFinite(b.liquidityUsd) && b.liquidityUsd > 0)
    .sort((a, b) => a.bpsFromPeg - b.bpsFromPeg);
}

/**
 * Total of a histogram within `deltaBps`, the denominator `T_δ` wants.
 *
 * Whole buckets, inclusive at the boundary: a bin is either liquidity a trade
 * at that price walks through or it is not, and there is no partial credit to
 * award inside a bin that holds a single flat amount.
 */
export function activeTvlWithin(
  histogram: readonly LiquidityHistogramBucket[],
  deltaBps: number,
): number {
  return histogram.reduce(
    (sum, b) => (Math.abs(b.bpsFromPeg) <= deltaBps ? sum + b.liquidityUsd : sum),
    0,
  );
}
