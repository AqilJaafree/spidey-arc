import { describe, expect, it } from 'vitest';
import {
  blockTimeBetween,
  planBookings,
  planScanWindow,
  type MintedArrival,
} from './sweepBridges.js';

describe('planBookings', () => {
  it('books an arrival against the single venue on its source domain', () => {
    const arrivals: MintedArrival[] = [{ sourceDomain: 6, amount: 1_000_000n, txHash: '0xa' }];
    expect(planBookings(arrivals, { 6: [2] })).toEqual([
      { venueId: 2, amount: 1_000_000n, sourceDomain: 6, txHash: '0xa' },
    ]);
  });

  it('sums several arrivals from the same venue into one booking', () => {
    // recordBridgeArrival is bounded on-chain by unaccounted balance. Two
    // calls racing the same balance would leave the second booking less than
    // it should, and the difference is capital the vault still counts as
    // deployed.
    const arrivals: MintedArrival[] = [
      { sourceDomain: 6, amount: 1_000_000n, txHash: '0xa' },
      { sourceDomain: 6, amount: 2_500_000n, txHash: '0xb' },
    ];
    expect(planBookings(arrivals, { 6: [2] })).toEqual([
      { venueId: 2, amount: 3_500_000n, sourceDomain: 6, txHash: '0xa,0xb' },
    ]);
  });

  it('keeps arrivals from different domains as separate bookings', () => {
    const arrivals: MintedArrival[] = [
      { sourceDomain: 6, amount: 1_000_000n, txHash: '0xa' },
      { sourceDomain: 5, amount: 2_000_000n, txHash: '0xb' },
    ];
    const got = planBookings(arrivals, { 6: [2], 5: [3] });
    expect(got).toHaveLength(2);
    expect(got.find((b) => b.venueId === 2)?.amount).toBe(1_000_000n);
    expect(got.find((b) => b.venueId === 3)?.amount).toBe(2_000_000n);
  });

  it('refuses to book when two venues share the source domain', () => {
    // Genuinely ambiguous. Booking against a guess credits the wrong venue's
    // book and leaves the other still claiming capital that is already home.
    const arrivals: MintedArrival[] = [{ sourceDomain: 6, amount: 1n, txHash: '0xa' }];
    expect(() => planBookings(arrivals, { 6: [1, 2] })).toThrow(/ambiguous/i);
  });

  it('names both venues when it refuses an ambiguous domain', () => {
    const arrivals: MintedArrival[] = [{ sourceDomain: 6, amount: 1n, txHash: '0xa' }];
    expect(() => planBookings(arrivals, { 6: [1, 2] })).toThrow(/1, 2/);
  });

  it('refuses to book an arrival from a domain no venue is registered on', () => {
    const arrivals: MintedArrival[] = [{ sourceDomain: 5, amount: 1n, txHash: '0xa' }];
    expect(() => planBookings(arrivals, { 5: [] })).toThrow(/no venue/i);
  });

  it('refuses when the domain is absent from the map entirely', () => {
    // Absent and empty must behave the same: both mean "no venue known", and
    // a lookup miss must not silently become a skipped arrival.
    const arrivals: MintedArrival[] = [{ sourceDomain: 5, amount: 1n, txHash: '0xa' }];
    expect(() => planBookings(arrivals, {})).toThrow(/no venue/i);
  });

  it('is empty when nothing arrived', () => {
    expect(planBookings([], {})).toEqual([]);
  });
});

describe('blockTimeBetween', () => {
  it('averages over the sampled span rather than one block', () => {
    // Arc testnet, measured live: 1000 blocks spanning 509 seconds.
    expect(
      blockTimeBetween(
        { number: 55_938_000n, timestamp: 1_786_189_587n },
        { number: 55_939_000n, timestamp: 1_786_190_096n },
      ),
    ).toBeCloseTo(0.509, 6);
  });

  it('handles a whole-second chain', () => {
    // Base Sepolia, measured live: 2s blocks. Four times Arc's — which is why
    // a single assumed constant would be wrong on one of the two chains.
    expect(
      blockTimeBetween(
        { number: 45_208_098n, timestamp: 1_786_188_098n },
        { number: 45_210_098n, timestamp: 1_786_192_098n },
      ),
    ).toBe(2);
  });

  it('refuses two readings of the same block', () => {
    // Dividing by a zero span would give Infinity, and a window computed from
    // Infinity covers one block: a scan that reports zero burns and is wrong.
    expect(() =>
      blockTimeBetween({ number: 10n, timestamp: 100n }, { number: 10n, timestamp: 100n }),
    ).toThrow(/not after/i);
  });

  it('refuses a pair whose blocks run backwards', () => {
    expect(() =>
      blockTimeBetween({ number: 20n, timestamp: 200n }, { number: 10n, timestamp: 100n }),
    ).toThrow(/not after/i);
  });

  it('refuses a pair whose timestamps do not advance', () => {
    // A non-advancing clock across real blocks means a reorg or a skewed node.
    // A fabricated block time would produce a plausible window over the wrong
    // range, which looks exactly like a successful scan.
    expect(() =>
      blockTimeBetween({ number: 10n, timestamp: 100n }, { number: 20n, timestamp: 100n }),
    ).toThrow(/span/i);
  });
});

describe('planScanWindow', () => {
  const arc = { blockTimeSeconds: 0.509, maxLogRange: 20_000 };
  const base = { blockTimeSeconds: 2, maxLogRange: 2_000 };
  const week = 7 * 24 * 60 * 60;

  it('covers the full lookback when the budget allows it', () => {
    const w = planScanWindow({ head: 45_210_000n, lookbackSeconds: week, maxRequests: 160, ...base });
    expect(w.truncated).toBe(false);
    expect(w.blocks).toBe(302_400n);
    expect(w.seconds).toBe(week);
    expect(w.ranges).toHaveLength(152);
  });

  it('converts the same lookback into four times the blocks on a faster chain', () => {
    // The whole reason the block time is measured. Assuming Base's 2s here
    // would ask for 302 400 Arc blocks — under two days, not seven.
    const w = planScanWindow({ head: 55_939_000n, lookbackSeconds: week, maxRequests: 160, ...arc });
    expect(w.blocks).toBe(1_188_213n);
    expect(w.truncated).toBe(false);
  });

  it('ends the last range exactly at the head', () => {
    const w = planScanWindow({ head: 45_210_000n, lookbackSeconds: week, maxRequests: 160, ...base });
    expect(w.ranges.at(-1)!.toBlock).toBe(45_210_000n);
  });

  it('emits contiguous, non-overlapping ranges that cover the window once', () => {
    // A gap between two ranges is a burn nobody scans; an overlap is Iris
    // queried twice for the same transaction on a rate-limited endpoint.
    const w = planScanWindow({ head: 1_000n, lookbackSeconds: 600, maxRequests: 10, blockTimeSeconds: 2, maxLogRange: 100 });
    expect(w.ranges[0]!.fromBlock).toBe(701n);
    for (let i = 1; i < w.ranges.length; i++) {
      expect(w.ranges[i]!.fromBlock).toBe(w.ranges[i - 1]!.toBlock + 1n);
    }
    const covered = w.ranges.reduce((n, r) => n + (r.toBlock - r.fromBlock + 1n), 0n);
    expect(covered).toBe(w.blocks);
  });

  it('never issues more calls than the budget', () => {
    const w = planScanWindow({ head: 10_000_000n, lookbackSeconds: week, maxRequests: 4, ...base });
    expect(w.ranges).toHaveLength(4);
    expect(w.blocks).toBe(8_000n);
  });

  it('flags the window as capped when the budget cuts the lookback short', () => {
    // The operator must be able to see this. A shortened window silently
    // forgets older burns, and the capital sits attested and unbooked until a
    // human notices.
    const w = planScanWindow({ head: 10_000_000n, lookbackSeconds: week, maxRequests: 4, ...base });
    expect(w.truncated).toBe(true);
    expect(w.seconds).toBe(16_000);
  });

  it('does not flag a chain that is simply younger than the lookback', () => {
    // No history is being skipped — there is none to skip. Calling that
    // "capped" would train an operator to ignore the flag that matters.
    const w = planScanWindow({ head: 500n, lookbackSeconds: week, maxRequests: 160, ...base });
    expect(w.truncated).toBe(false);
    expect(w.ranges[0]!.fromBlock).toBe(0n);
    expect(w.blocks).toBe(501n);
  });

  it('still scans the head block on a one-block chain', () => {
    const w = planScanWindow({ head: 0n, lookbackSeconds: week, maxRequests: 160, ...base });
    expect(w.ranges).toEqual([{ fromBlock: 0n, toBlock: 0n }]);
    expect(w.blocks).toBe(1n);
  });

  it('rounds the window up rather than down', () => {
    // A window one block short of the lookback can drop the oldest burn; a
    // block too many costs nothing.
    const w = planScanWindow({ head: 1_000n, lookbackSeconds: 7, maxRequests: 10, blockTimeSeconds: 2, maxLogRange: 100 });
    expect(w.blocks).toBe(4n);
  });

  it('refuses a block time that is not positive', () => {
    expect(() =>
      planScanWindow({ head: 100n, lookbackSeconds: week, maxRequests: 4, blockTimeSeconds: 0, maxLogRange: 100 }),
    ).toThrow(/block time/i);
  });

  it('refuses a zero request budget, which would scan nothing and say so quietly', () => {
    expect(() =>
      planScanWindow({ head: 100n, lookbackSeconds: week, maxRequests: 0, ...base }),
    ).toThrow(/maxRequests/i);
  });

  it('refuses a zero range limit', () => {
    expect(() =>
      planScanWindow({ head: 100n, lookbackSeconds: week, maxRequests: 4, blockTimeSeconds: 2, maxLogRange: 0 }),
    ).toThrow(/maxLogRange/i);
  });

  it('refuses a non-positive lookback', () => {
    expect(() =>
      planScanWindow({ head: 100n, lookbackSeconds: 0, maxRequests: 4, ...base }),
    ).toThrow(/lookback/i);
  });
});
