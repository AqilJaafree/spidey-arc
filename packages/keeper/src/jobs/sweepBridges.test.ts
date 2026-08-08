import { describe, expect, it } from 'vitest';
import { planBookings, type MintedArrival } from './sweepBridges.js';

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
