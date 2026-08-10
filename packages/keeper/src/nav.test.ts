import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deployedValue, shouldReport, type NavBounds } from './nav.js';

/**
 * The live values, read from the chain in production.
 *
 * `reportAtAgeSeconds` is spelled out rather than derived so the boundary
 * arbitrary below reads as three numbers instead of an arithmetic expression;
 * the derivation itself is pinned separately.
 */
const BOUNDS: NavBounds & { reportAtAgeSeconds: number } = {
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
      current: 0n, computed: 0n, updatedAtSeconds: NOW - 100_000, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'nothing-deployed' });
  });

  it('marks a position the vault does not know it holds', () => {
    // The bug this closes: both the job and this rule short-circuited on
    // `current === 0`, which is the very number they exist to audit. Capital in
    // the relay against a zero mark is an *unmarked position* — the mirror of the
    // unmarked loss the whole design is built to avoid — and it was reported as
    // "nothing deployed".
    const d = shouldReport({
      current: 0n, computed: USDC(500), updatedAtSeconds: NOW - 100_000, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(500), capped: false, reason: 'changed' });
  });

  it('does not cap the first step off zero, because the contract does not', () => {
    // `maxStep` is a fraction of `current`, so at zero it floors to 0 and a
    // capped rise would post 0 — the mark could never climb off the floor.
    // `LPVault.reportNav` skips its delta bound entirely when `previous == 0`,
    // and this mirrors that rather than inventing a stricter rule.
    const d = shouldReport({
      current: 0n, computed: USDC(1_000_000), updatedAtSeconds: NOW - 100_000, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.amount).toBe(USDC(1_000_000));
      expect(d.capped).toBe(false);
    }
  });

  it('still says nothing-deployed when the measurement agrees the vault is empty', () => {
    const d = shouldReport({
      current: 0n, computed: 0n, updatedAtSeconds: NOW - 100_000, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'nothing-deployed' });
  });

  it('honours the cooldown even for an unmarked position', () => {
    // The contract checks NavCooldown before it looks at `previous`, so a zero
    // mark buys no exemption from it.
    const d = shouldReport({
      current: 0n, computed: USDC(500), updatedAtSeconds: NOW - 60, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'cooldown' });
  });

  it('refuses inside the cooldown, even when the value changed', () => {
    const d = shouldReport({
      current: USDC(1000), computed: USDC(1010), updatedAtSeconds: NOW - 60, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'cooldown' });
  });

  it('names a clock that trails the chain instead of blaming the cooldown', () => {
    // A mark stamped in our future makes every derived age wrong. Refusing is
    // right either way, but `cooldown` would send whoever reads the log after
    // the mark goes stale to look at NAV_COOLDOWN rather than at the clock.
    const d = shouldReport({
      current: USDC(1000), computed: USDC(1000), updatedAtSeconds: NOW + 90, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'clock-behind-chain' });
  });

  it('stays quiet when the value is unchanged and the mark is fresh', () => {
    const d = shouldReport({
      current: USDC(1000), computed: USDC(1000), updatedAtSeconds: NOW - 7200, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: false, reason: 'fresh-and-unchanged' });
  });

  it('re-posts an unchanged value once the mark is ageing', () => {
    // Not a rubber stamp: the caller verified this number against the relay
    // balance this run. Unchanged is a finding, not an assumption.
    const d = shouldReport({
      current: USDC(1000), computed: USDC(1000), updatedAtSeconds: NOW - 15_000, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(1000), capped: false, reason: 'ageing' });
  });

  it('posts a changed value within the delta cap', () => {
    const d = shouldReport({
      current: USDC(1000), computed: USDC(980), updatedAtSeconds: NOW - 7200, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(980), capped: false, reason: 'changed' });
  });

  it('caps a fall larger than the delta bound, landing exactly on the boundary', () => {
    // 5% of 1000 is 50. The contract rejects on strict `>`, so a step of
    // exactly 50 is accepted — one unit further is not.
    const d = shouldReport({
      current: USDC(1000), computed: USDC(500), updatedAtSeconds: NOW - 7200, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(950), capped: true, reason: 'changed' });
  });

  it('caps a rise larger than the delta bound', () => {
    const d = shouldReport({
      current: USDC(1000), computed: USDC(5000), updatedAtSeconds: NOW - 7200, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: USDC(1050), capped: true, reason: 'changed' });
  });

  it('parks dust at a fixed point rather than walking it to zero', () => {
    // Below 20 base units the 5% cap floors to 0, so a capped step moves
    // nothing and the mark never reaches zero. Do not "fix" this by forcing a
    // step: posting the unchanged number is what keeps `claimWithdraw` payable,
    // since its NavStale gate still applies while deployedAssets is non-zero.
    // A real writeoff goes through `LPVault.recordVenueClosed`, which zeroes
    // the mark outright — a 5%-per-step walk-down asymptotes and never arrives.
    const d = shouldReport({
      current: 10n, computed: 0n, updatedAtSeconds: NOW - 7200, nowSeconds: NOW, bounds: BOUNDS,
    });
    expect(d).toEqual({ post: true, amount: 10n, capped: true, reason: 'changed' });
  });

  // --- the reporting margin ---------------------------------------------

  describe('reportAtAgeSeconds', () => {
    /** The live bounds with a 10h deadline, so the derived margin is not 14,400. */
    const chainOnly: NavBounds = {
      navCooldownSeconds: 3600,
      maxNavAgeSeconds: 36_000,
      maxNavDeltaBps: 500,
    };

    it('derives the margin from the contract bounds when it is not given', () => {
      // Two cooldowns of headroom — one to try, one to retry — before the mark
      // goes stale. Proportional to what the chain says, so raising
      // MAX_NAV_AGE cannot silently leave the keeper reporting too late.
      const derived = 36_000 - 2 * 3600;

      const justBefore = shouldReport({
        current: USDC(1000), computed: USDC(1000),
        updatedAtSeconds: NOW - (derived - 1), nowSeconds: NOW, bounds: chainOnly,
      });
      expect(justBefore).toEqual({ post: false, reason: 'fresh-and-unchanged' });

      const atTheMargin = shouldReport({
        current: USDC(1000), computed: USDC(1000),
        updatedAtSeconds: NOW - derived, nowSeconds: NOW, bounds: chainOnly,
      });
      expect(atTheMargin).toEqual({ post: true, amount: USDC(1000), capped: false, reason: 'ageing' });
    });

    it('rejects bounds whose derived margin is zero', () => {
      // MAX_NAV_AGE of exactly two cooldowns derives 0, and `age >= 0` always
      // holds — so the keeper would post every cooldown forever rather than
      // when the mark needs it. Throwing beats clamping: a clamp hides the
      // misconfiguration exactly when someone should be looking at it.
      expect(() => shouldReport({
        current: USDC(1000), computed: USDC(1000),
        updatedAtSeconds: NOW - 7200, nowSeconds: NOW,
        bounds: { navCooldownSeconds: 3600, maxNavAgeSeconds: 7200, maxNavDeltaBps: 500 },
      })).toThrow(RangeError);
    });

    it('rejects an explicit margin that leaves no room to retry', () => {
      // 19,000 + one 3,600s cooldown overruns the 21,600s deadline: a failed
      // first attempt could not be retried before claimWithdraw starts
      // reverting. This is the module's own bug restored by a config typo.
      expect(() => shouldReport({
        current: USDC(1000), computed: USDC(1000),
        updatedAtSeconds: NOW - 7200, nowSeconds: NOW,
        bounds: { ...BOUNDS, reportAtAgeSeconds: 19_000 },
      })).toThrow(RangeError);
    });

    it('rejects a margin past the deadline outright', () => {
      // The failure that motivated validating this at all: a margin above
      // MAX_NAV_AGE reports the mark fresh while the chain reverts NavStale.
      expect(() => shouldReport({
        current: USDC(1000), computed: USDC(1000),
        updatedAtSeconds: NOW - 100_000, nowSeconds: NOW,
        bounds: { ...BOUNDS, reportAtAgeSeconds: 30_000 },
      })).toThrow(RangeError);
    });
  });

  // --- properties -------------------------------------------------------

  /**
   * Ages biased to the boundaries. A uniform draw over 200,000s samples the
   * 3,600s and 14,400s edges essentially never, which let a mutant that posted
   * one second inside the cooldown survive the property named for stopping it.
   */
  const arbAge = fc.oneof(
    fc.integer({ min: 0, max: 200_000 }),
    ...[BOUNDS.navCooldownSeconds, BOUNDS.reportAtAgeSeconds, BOUNDS.maxNavAgeSeconds]
      .flatMap((b) => [b - 1, b, b + 1])
      .map((v) => fc.constant(v)),
  );

  /**
   * `computed` drawn in relation to `current`, not independently. Independent
   * draws made `computed === current` a 0.045% event, so the unchanged path —
   * the one this module exists to get right — went essentially untested, and a
   * mutant restoring the original bug passed every property.
   */
  const arbState = fc
    .bigInt({ min: 0n, max: 2n ** 90n })
    .chain((current) => {
      const maxStep = (current * BigInt(BOUNDS.maxNavDeltaBps)) / 10_000n;
      return fc.record({
        current: fc.constant(current),
        computed: fc.oneof(
          fc.bigInt({ min: 0n, max: 2n ** 90n }),
          fc.constant(current),
          fc.constant(current + maxStep),
          fc.constant(current + maxStep + 1n),
          fc.constant(current >= maxStep ? current - maxStep : 0n),
          fc.constant(current > maxStep ? current - maxStep - 1n : 0n),
        ),
        age: arbAge,
      });
    });

  /**
   * Above fast-check's default 100.
   *
   * The interesting cases are *joint* boundary draws — an age sitting exactly
   * on the reporting margin while `computed === current` — and each factor is
   * roughly a 1-in-10 and a 1-in-6 event, so 100 runs hits the pair about 80%
   * of the time. Measured: at the default, a mutant making the margin test
   * strict was caught by this property in only two runs out of three. A test
   * that finds a real bug two times in three is one that reports it flaky.
   */
  const RUNS = { numRuns: 2000 };

  it('never posts inside the cooldown', () => {
    fc.assert(fc.property(arbState, ({ current, computed, age }) => {
      const d = shouldReport({
        current, computed, updatedAtSeconds: NOW - age, nowSeconds: NOW, bounds: BOUNDS,
      });
      if (age < BOUNDS.navCooldownSeconds) expect(d.post).toBe(false);
    }), RUNS);
  });

  it('never posts a step the contract would reject', () => {
    // The mirror property. Asserted with the contract's own strict `>`: using
    // `>=` here would accept an off-by-one step the chain rejects, and pass
    // while proving nothing.
    fc.assert(fc.property(arbState, ({ current, computed, age }) => {
      const d = shouldReport({
        current, computed, updatedAtSeconds: NOW - age, nowSeconds: NOW, bounds: BOUNDS,
      });
      if (!d.post || current === 0n) return;
      const diff = d.amount > current ? d.amount - current : current - d.amount;
      expect(diff * 10_000n > current * BigInt(BOUNDS.maxNavDeltaBps)).toBe(false);
    }), RUNS);
  });

  it('a capped step lands exactly on the boundary, not short of it', () => {
    // Asserting only "within the cap" would pass against an implementation
    // that posted `current` unchanged forever — never converging, never
    // marking a loss.
    fc.assert(fc.property(arbState, ({ current, computed, age }) => {
      const d = shouldReport({
        current, computed, updatedAtSeconds: NOW - age, nowSeconds: NOW, bounds: BOUNDS,
      });
      if (!d.post || !d.capped) return;
      const maxStep = (current * BigInt(BOUNDS.maxNavDeltaBps)) / 10_000n;
      const diff = d.amount > current ? d.amount - current : current - d.amount;
      expect(diff).toBe(maxStep);
    }), RUNS);
  });

  it('always posts before the mark can go stale, changed or not', () => {
    // The property that makes the bug unable to recur — and it only says that
    // because `computed === current` is now generated on purpose. Drawn
    // independently it fired ~9 times in 20,000, and passed against the
    // original bug (`if (computed === current) return fresh-and-unchanged`)
    // left in verbatim.
    fc.assert(fc.property(arbState, ({ current, computed, age }) => {
      if (current === 0n) return;
      if (age < BOUNDS.navCooldownSeconds) return;
      if (age < BOUNDS.reportAtAgeSeconds) return;
      const d = shouldReport({
        current, computed, updatedAtSeconds: NOW - age, nowSeconds: NOW, bounds: BOUNDS,
      });
      expect(d.post).toBe(true);
    }), RUNS);
  });

  /**
   * This replaces a property that asserted `current === 0n` never posts, for any
   * `computed`. That was the bug stated as an invariant: it let the mark under
   * audit decide whether to audit it, so capital sitting in the relay against a
   * zero mark was reported as "nothing deployed" and left unmarked forever.
   *
   * The genuine invariant is narrower — nothing deployed *and nothing measured*.
   */
  it('never posts when the mark and the measurement agree the vault is empty', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 200_000 }), (age) => {
      const d = shouldReport({
        current: 0n, computed: 0n, updatedAtSeconds: NOW - age, nowSeconds: NOW, bounds: BOUNDS,
      });
      expect(d.post).toBe(false);
    }), RUNS);
  });

  it('always marks an unmarked position once the cooldown has passed', () => {
    // The mark has to be able to leave zero. `maxStep` is a fraction of
    // `current`, so any cap applied here would floor to 0 and post `0 + 0`.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 2n ** 90n }),
        fc.integer({ min: BOUNDS.navCooldownSeconds, max: 200_000 }),
        (computed, age) => {
          const d = shouldReport({
            current: 0n, computed, updatedAtSeconds: NOW - age, nowSeconds: NOW, bounds: BOUNDS,
          });
          expect(d.post).toBe(true);
          if (d.post) {
            expect(d.amount).toBe(computed);
            expect(d.capped).toBe(false);
          }
        },
      ),
      RUNS,
    );
  });
});
