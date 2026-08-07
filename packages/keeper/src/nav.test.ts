import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deployedValue, shouldReport, type NavBounds } from './nav.js';

/** The live values, read from the chain in production. */
const BOUNDS: NavBounds = {
  navCooldownSeconds: 3600,
  maxNavAgeSeconds: 21_600,
  maxNavDeltaBps: 500,
  reportAtAgeSeconds: 14_400,
};

const NOW = 1_770_000_000;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe('deployedValue', () => {
  it('counts in-flight capital at full value', () => {
    // Burned on Arc, not yet minted on Base. CCTP attestation guarantees
    // delivery, so haircutting depositors for a bridge delay would be wrong.
    expect(deployedValue({ relayBalance: USDC(700), inFlight: USDC(300) })).toBe(USDC(1000));
  });

  it('is just the relay balance when nothing is in flight', () => {
    expect(deployedValue({ relayBalance: USDC(1000), inFlight: 0n })).toBe(USDC(1000));
  });
});

describe('shouldReport', () => {
  it('does nothing when no capital is deployed', () => {
    // The NavStale gate does not apply when deployedAssets is zero, so there
    // is nothing to attest and posting would burn gas for no one.
    const d = shouldReport({
      current: 0n, computed: 0n, updatedAt: NOW - 100_000, now: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'nothing-deployed' });
  });

  it('refuses inside the cooldown, even when the value changed', () => {
    const d = shouldReport({
      current: USDC(1000), computed: USDC(1010), updatedAt: NOW - 60, now: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'cooldown' });
  });

  it('stays quiet when the value is unchanged and the mark is fresh', () => {
    const d = shouldReport({
      current: USDC(1000), computed: USDC(1000), updatedAt: NOW - 7200, now: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'fresh-and-unchanged' });
  });

  it('re-posts an unchanged value once the mark is ageing', () => {
    // Not a rubber stamp: the caller verified this number against the relay
    // balance this run. Unchanged is a finding, not an assumption.
    const d = shouldReport({
      current: USDC(1000), computed: USDC(1000), updatedAt: NOW - 15_000, now: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(1000), capped: false, reason: 'ageing' });
  });

  it('posts a changed value within the delta cap', () => {
    const d = shouldReport({
      current: USDC(1000), computed: USDC(980), updatedAt: NOW - 7200, now: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(980), capped: false, reason: 'changed' });
  });

  it('caps a fall larger than the delta bound, landing exactly on the boundary', () => {
    // 5% of 1000 is 50. The contract rejects on strict `>`, so a step of
    // exactly 50 is accepted — one unit further is not.
    const d = shouldReport({
      current: USDC(1000), computed: USDC(500), updatedAt: NOW - 7200, now: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(950), capped: true, reason: 'changed' });
  });

  it('caps a rise larger than the delta bound', () => {
    const d = shouldReport({
      current: USDC(1000), computed: USDC(5000), updatedAt: NOW - 7200, now: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(1050), capped: true, reason: 'changed' });
  });

  it('never proposes a negative mark', () => {
    // A total loss is a 100% fall; the cap walks it down 5% per step and must
    // never underflow past zero on the way.
    const d = shouldReport({
      current: 10n, computed: 0n, updatedAt: NOW - 7200, now: NOW, bounds: BOUNDS,
    });
    expect(d.post).toBe(true);
    if (d.post) expect(d.amount >= 0n).toBe(true);
  });

  // --- properties -------------------------------------------------------

  const arbState = fc.record({
    current: fc.bigInt({ min: 0n, max: 2n ** 90n }),
    computed: fc.bigInt({ min: 0n, max: 2n ** 90n }),
    age: fc.integer({ min: 0, max: 200_000 }),
  });

  it('never posts inside the cooldown', () => {
    fc.assert(fc.property(arbState, ({ current, computed, age }) => {
      const d = shouldReport({
        current, computed, updatedAt: NOW - age, now: NOW, bounds: BOUNDS,
      });
      if (age < BOUNDS.navCooldownSeconds) expect(d.post).toBe(false);
    }));
  });

  it('never posts a step the contract would reject', () => {
    // The mirror property. Asserted with the contract's own strict `>`: using
    // `>=` here would accept an off-by-one step the chain rejects, and pass
    // while proving nothing.
    fc.assert(fc.property(arbState, ({ current, computed, age }) => {
      const d = shouldReport({
        current, computed, updatedAt: NOW - age, now: NOW, bounds: BOUNDS,
      });
      if (!d.post || current === 0n) return;
      const diff = d.amount > current ? d.amount - current : current - d.amount;
      expect(diff * 10_000n > current * BigInt(BOUNDS.maxNavDeltaBps)).toBe(false);
    }));
  });

  it('a capped step lands exactly on the boundary, not short of it', () => {
    // Asserting only "within the cap" would pass against an implementation
    // that posted `current` unchanged forever — never converging, never
    // marking a loss.
    fc.assert(fc.property(arbState, ({ current, computed, age }) => {
      const d = shouldReport({
        current, computed, updatedAt: NOW - age, now: NOW, bounds: BOUNDS,
      });
      if (!d.post || !d.capped) return;
      const maxStep = (current * BigInt(BOUNDS.maxNavDeltaBps)) / 10_000n;
      const diff = d.amount > current ? d.amount - current : current - d.amount;
      expect(diff).toBe(maxStep);
    }));
  });

  it('always posts before the mark can go stale', () => {
    // The property that makes the bug unable to recur: with capital deployed
    // and the cooldown clear, an ageing mark is always refreshed.
    fc.assert(fc.property(arbState, ({ current, computed, age }) => {
      if (current === 0n) return;
      if (age < BOUNDS.navCooldownSeconds) return;
      if (age < BOUNDS.reportAtAgeSeconds) return;
      const d = shouldReport({
        current, computed, updatedAt: NOW - age, now: NOW, bounds: BOUNDS,
      });
      expect(d.post).toBe(true);
    }));
  });

  it('never posts when nothing is deployed', () => {
    fc.assert(fc.property(arbState, ({ computed, age }) => {
      const d = shouldReport({
        current: 0n, computed, updatedAt: NOW - age, now: NOW, bounds: BOUNDS,
      });
      expect(d.post).toBe(false);
    }));
  });
});
