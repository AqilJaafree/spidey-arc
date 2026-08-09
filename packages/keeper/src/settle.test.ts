import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { MAX_EPOCH, shouldSettle, type SettleInput } from './settle.js';

const base: SettleInput = {
  epoch: 1,
  lastSettledEpoch: 0,
  requestsInEpoch: 1,
  pendingAssets: 500_000n,
  idleAssets: 1_499_935n,
  scanCapped: false,
};

describe('settling closes an epoch that has something in it', () => {
  it('settles the current epoch when a request is waiting', () => {
    const d = shouldSettle(base);
    expect(d.settle).toBe(true);
    if (d.settle) {
      expect(d.epoch).toBe(1);
      expect(d.partialCoverage).toBe(false);
      expect(d.reason).toMatch(/1 request/);
    }
  });

  it('settles even when idle cannot cover the queue, and says so', () => {
    // Coverage is computed per claim from live state, so a short vault pays
    // pro-rata. Withholding settlement would strand the queue behind capital
    // that only comes back when someone fetches it.
    const d = shouldSettle({ ...base, idleAssets: 100n, pendingAssets: 500_000n });
    expect(d.settle).toBe(true);
    if (d.settle) {
      expect(d.partialCoverage).toBe(true);
      expect(d.reason).toMatch(/haircut pro-rata/);
    }
  });
});

describe('an epoch id is a finite resource', () => {
  it('refuses an empty epoch rather than spending an id on it', () => {
    const d = shouldSettle({ ...base, requestsInEpoch: 0 });
    expect(d.settle).toBe(false);
    expect(d.reason).toMatch(/empty/);
  });

  it('refuses at the uint16 ceiling, because the increment is unchecked', () => {
    // settleEpoch does `unchecked { epoch: q.epoch + 1 }`, so one more settle
    // here wraps the counter to 0 and every p.epoch comparison after it lies.
    const d = shouldSettle({ ...base, epoch: MAX_EPOCH, lastSettledEpoch: MAX_EPOCH - 1 });
    expect(d.settle).toBe(false);
    expect(d.reason).toMatch(/wrap|ceiling/);
  });

  it('still settles one short of the ceiling', () => {
    const d = shouldSettle({ ...base, epoch: MAX_EPOCH - 1, lastSettledEpoch: MAX_EPOCH - 2 });
    expect(d.settle).toBe(true);
  });

  it('refuses a queue whose counter has already wrapped', () => {
    const d = shouldSettle({ ...base, epoch: 0, lastSettledEpoch: MAX_EPOCH });
    expect(d.settle).toBe(false);
    expect(d.reason).toMatch(/inconsistent/);
  });
});

describe('an unseen epoch is not an empty epoch', () => {
  it('refuses when the scan was capped before it could tell', () => {
    const d = shouldSettle({ ...base, requestsInEpoch: 0, scanCapped: true });
    expect(d.settle).toBe(false);
    expect(d.reason).toMatch(/capped/);

    // The distinction is the point: both refuse, both saw zero requests, and an
    // operator has to be able to tell "nobody asked" from "I could not see".
    const empty = shouldSettle({ ...base, requestsInEpoch: 0, scanCapped: false });
    expect(empty.reason).not.toMatch(/capped/);
    expect(d.reason).not.toBe(empty.reason);
  });

  it('settles on a capped scan that still found a request', () => {
    // Capped only bounds how far back it looked; a request it did see is real.
    const d = shouldSettle({ ...base, requestsInEpoch: 2, scanCapped: true });
    expect(d.settle).toBe(true);
  });
});

describe('properties', () => {
  it('never settles without having seen a request', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_EPOCH }),
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (epoch, scanCapped, idle, pending) => {
          const d = shouldSettle({
            epoch,
            lastSettledEpoch: epoch === 0 ? 0 : epoch - 1,
            requestsInEpoch: 0,
            idleAssets: idle,
            pendingAssets: pending,
            scanCapped,
          });
          expect(d.settle).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('never advances an epoch that would wrap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (requests) => {
        const d = shouldSettle({ ...base, epoch: MAX_EPOCH, lastSettledEpoch: MAX_EPOCH - 1, requestsInEpoch: requests });
        expect(d.settle).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('settles exactly the epoch it was asked about, never a neighbour', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_EPOCH - 1 }), (epoch) => {
        const d = shouldSettle({ ...base, epoch, lastSettledEpoch: epoch - 1, requestsInEpoch: 1 });
        if (d.settle) expect(d.epoch).toBe(epoch);
      }),
      { numRuns: 300 },
    );
  });
});
