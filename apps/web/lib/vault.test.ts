import { describe, expect, it } from 'vitest';
import {
  claimReadiness,
  depositReadiness,
  encodeRequestId,
  explainRefusal,
  formatShares,
  formatUsdc,
  parseUsdc,
  requestReadiness,
  type HolderState,
  type VaultState,
} from './vault';

const USDC = (whole: number) => BigInt(Math.round(whole * 1e6));
const SHARES = (whole: number) => BigInt(Math.round(whole * 1e9));

/** The live Arc hub, 2026-08-10, as the starting point for variations. */
const LIVE: VaultState = {
  totalAssets: 1_499_935n,
  idle: 999_935n,
  deployed: 500_000n,
  pending: 0n,
  coverageBps: 10_000,
  epoch: 1,
  lastSettledEpoch: 0,
  depositCap: USDC(100_000),
  navUpdatedAt: 1_785_994_244n,
  maxNavAge: 21_600n, // 6 hours
};

const HOLDER: HolderState = {
  shares: SHARES(1),
  usdcBalance: USDC(50),
  allowance: 0n,
  pendingAssets: 0n,
  pendingEpoch: 0,
};

describe('decimals', () => {
  // Three views of the same asset, and mixing them up is the likeliest way to
  // put a wrong number on screen.
  it('formats USDC at six places', () => {
    expect(formatUsdc(999_935n)).toBe('0.999935');
    expect(formatUsdc(1_500_000n)).toBe('1.5');
    expect(formatUsdc(0n)).toBe('0');
  });

  it('formats shares at nine, because ERC-4626 adds the offset to the asset', () => {
    // The live vault holds 1e9 shares against ~1 USDC of equity: 6 underlying
    // decimals plus a 3-place virtual-share offset.
    expect(formatShares(1_000_000_000n)).toBe('1');
    expect(formatShares(1_500_000_000n)).toBe('1.5');
  });

  it('parses a typed amount into USDC base units', () => {
    expect(parseUsdc('1')).toBe(1_000_000n);
    expect(parseUsdc('0.999935')).toBe(999_935n);
    expect(parseUsdc('')).toBe(0n);
  });

  it('refuses more precision than USDC has, rather than silently truncating', () => {
    expect(() => parseUsdc('0.0000001')).toThrow(/six decimal/i);
  });
});

describe('encodeRequestId', () => {
  // Mirrors LPVault.encodeRequestId: (uint160(holder) << 16) | epoch. Getting
  // this wrong means claimWithdraw reverts NotRequestOwner and the holder has
  // no way to reach their own money from the UI.
  it('packs holder and epoch the way the contract does', () => {
    expect(encodeRequestId('0x0000000000000000000000000000000000000001', 1)).toBe(0x10001n);
  });

  it('round-trips a real address', () => {
    const holder = '0x9e5fdE1f7484096A9beCDBb956A05834eC581195';
    const id = encodeRequestId(holder, 7);
    expect(id >> 16n).toBe(BigInt(holder.toLowerCase()));
    expect(id & 0xffffn).toBe(7n);
  });
});

describe('depositReadiness', () => {
  it('allows a deposit inside the cap', () => {
    const r = depositReadiness(LIVE, HOLDER, USDC(10));
    expect(r.ok).toBe(true);
    expect(r.needsApproval).toBe(true);
  });

  it('does not ask for approval twice', () => {
    const r = depositReadiness(LIVE, { ...HOLDER, allowance: USDC(10) }, USDC(10));
    expect(r.needsApproval).toBe(false);
  });

  it('blocks a deposit the wallet cannot fund', () => {
    const r = depositReadiness(LIVE, HOLDER, USDC(500));
    expect(r.ok).toBe(false);
    expect(r.reason?.code).toBe('InsufficientBalance');
  });

  it('blocks a deposit that would breach the cap, naming the headroom', () => {
    const nearCap = { ...LIVE, totalAssets: USDC(99_995) };
    const r = depositReadiness(nearCap, { ...HOLDER, usdcBalance: USDC(1_000) }, USDC(10));
    expect(r.ok).toBe(false);
    expect(r.reason?.code).toBe('DepositCapExceeded');
    expect(r.reason?.detail).toContain('5');
  });

  it('blocks zero', () => {
    expect(depositReadiness(LIVE, HOLDER, 0n).ok).toBe(false);
  });
});

describe('requestReadiness', () => {
  it('allows a holder with shares to queue an exit', () => {
    const r = requestReadiness(LIVE, HOLDER, SHARES(1));
    expect(r.ok).toBe(true);
  });

  it('blocks more shares than the holder owns', () => {
    const r = requestReadiness(LIVE, HOLDER, SHARES(2));
    expect(r.ok).toBe(false);
    expect(r.reason?.code).toBe('InsufficientShares');
  });

  // LPVault rejects a second request while a settled one is unclaimed, because
  // merging across epochs would move money between settlement batches.
  it('blocks a new request while an older settled one is unclaimed', () => {
    const held = { ...HOLDER, pendingAssets: USDC(5), pendingEpoch: 1 };
    const r = requestReadiness({ ...LIVE, epoch: 2 }, held, SHARES(1));
    expect(r.ok).toBe(false);
    expect(r.reason?.code).toBe('ClaimPendingFirst');
  });
});

describe('claimReadiness', () => {
  const NOW = 1_786_339_887n; // 2026-08-10 05:31 UTC

  // 0.5 against the live vault's 0.999935 idle, so the queue is genuinely
  // covered. Asking for a round 1 USDC here would fall a hair short and take
  // the shortfall branch — which is exactly what the live vault does.
  const queued: HolderState = { ...HOLDER, shares: 0n, pendingAssets: USDC(0.5), pendingEpoch: 1 };
  const settled: VaultState = { ...LIVE, pending: USDC(0.5), lastSettledEpoch: 1, epoch: 2 };

  it('says nothing is owed when there is no request', () => {
    const r = claimReadiness(LIVE, HOLDER, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason?.code).toBe('NothingToClaim');
  });

  it('names the operator wait while the epoch is still open', () => {
    const r = claimReadiness({ ...LIVE, pending: USDC(1) }, queued, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason?.code).toBe('EpochNotSettled');
    expect(r.reason?.detail).toMatch(/operator/i);
  });

  it('pays in full when idle covers the queue', () => {
    const r = claimReadiness(settled, queued, NOW);
    expect(r.ok).toBe(true);
    expect(r.payout).toBe(USDC(0.5));
    expect(r.haircutBps).toBe(0);
  });

  // The whole reason coverageBps exists: a shortfall shared pro-rata rather
  // than landing entirely on whoever claims last.
  it('predicts the haircut before the wallet is asked to sign', () => {
    const short: VaultState = {
      ...settled,
      idle: USDC(99),
      deployed: 0n,
      pending: USDC(100),
      navUpdatedAt: NOW - 60n,
    };
    const bigQueue = { ...queued, pendingAssets: USDC(100) };
    const r = claimReadiness(short, bigQueue, NOW);
    expect(r.ok).toBe(true);
    expect(r.haircutBps).toBe(100);
    expect(r.payout).toBe(USDC(99));
  });

  // The live blocker, 2026-08-10: the mark is four days old against a
  // six-hour bound, so a full redemption reverts. The page should say so
  // rather than spend a transaction discovering it.
  it('predicts NavStale when idle falls short and the mark has expired', () => {
    const short: VaultState = { ...settled, pending: USDC(100), idle: USDC(99) };
    const bigQueue = { ...queued, pendingAssets: USDC(100) };
    const r = claimReadiness(short, bigQueue, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason?.code).toBe('NavStale');
    expect(r.reason?.detail).toMatch(/4 days/);
  });

  // Nothing deployed means nothing unverified, so age cannot matter — this is
  // what stops a full writeoff from stranding the queue permanently.
  it('ignores a stale mark once nothing is deployed', () => {
    const short: VaultState = {
      ...settled,
      pending: USDC(100),
      idle: USDC(99),
      deployed: 0n,
    };
    const bigQueue = { ...queued, pendingAssets: USDC(100) };
    const r = claimReadiness(short, bigQueue, NOW);
    expect(r.ok).toBe(true);
    expect(r.haircutBps).toBe(100);
  });

  it('still refuses when even the haircut payout exceeds idle', () => {
    // Deployed props coverage up to 100%, so no haircut applies — and then
    // idle alone cannot cover the full claim. This is the InsufficientIdle
    // the write-off exists to prevent.
    const stranded: VaultState = {
      ...settled,
      idle: USDC(99),
      deployed: USDC(1),
      pending: USDC(100),
      navUpdatedAt: NOW - 60n,
    };
    const bigQueue = { ...queued, pendingAssets: USDC(100) };
    const r = claimReadiness(stranded, bigQueue, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason?.code).toBe('InsufficientIdle');
  });
});

describe('explainRefusal', () => {
  it('turns a contract error into a sentence a depositor can act on', () => {
    const r = explainRefusal('NavStale', [1_785_994_244n, 21_600n]);
    expect(r.title).toBeTruthy();
    expect(r.detail).not.toMatch(/0x/);
  });

  it('keeps synchronous redemption legible rather than mysterious', () => {
    const r = explainRefusal('SynchronousRedemptionDisabled', []);
    expect(r.detail).toMatch(/request/i);
  });

  it('falls back to the raw name rather than inventing an explanation', () => {
    const r = explainRefusal('SomethingNobodyMapped', []);
    expect(r.code).toBe('SomethingNobodyMapped');
    expect(r.title).toContain('SomethingNobodyMapped');
  });
});
