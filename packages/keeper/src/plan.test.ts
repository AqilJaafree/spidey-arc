import { describe, expect, it } from 'vitest';
import { rank, type NormalizedPool } from '@spidey/core';
import { planRebalance, routerWouldAccept } from './plan.js';
import { verifyProof } from './merkle.js';
import { leafHash } from './merkle.js';

const NOW = 1_770_000_000_000;
const ASOF = Math.floor(NOW / 1000);

function pool(overrides: Partial<NormalizedPool> & Pick<NormalizedPool, 'poolId'>): NormalizedPool {
  return {
    chain: 'base',
    cctpDomain: 6,
    dex: 'uniswap-v3',
    pair: ['USDC', 'USDT'],
    feeBps: 5,
    feeIsDynamic: false,
    feeBpsObserved24h: null,
    tvlUsd: 10_000_000,
    activeTvlUsd: 1_000_000,
    activeTvlDeltaBps: 10,
    activeTvlFidelity: 'tick-level',
    tickSpacing: 1,
    volume24h: 5_000_000,
    volume7d: null,
    fees24h: 2_500,
    fees7d: null,
    apyBase: 0.09,
    apyReward: 0,
    priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 5_000_000 }],
    priceHistogramSource: 'observed',
    hourlyFeeSeries: [],
    volumeAutocorr: null,
    source: 'test',
    asOf: NOW,
    ...overrides,
  };
}

const VENUE_IDS: Record<string, number> = { here: 1, away: 2 };
const venueIdOf = (p: { poolId: string }) => VENUE_IDS[p.poolId];

const here = pool({ poolId: 'here', priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 3_000_000 }] });
// Only 5% more flow than `here`. A large edge would pay back in about a day
// even at $1,000, which would make the size-dependence tests vacuous — the
// interesting regime is a thin edge where position size decides the answer.
const away = pool({
  poolId: 'away',
  chain: 'solana',
  cctpDomain: 5,
  dex: 'meteora-dlmm',
  priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 3_150_000 }],
});

const baseConfig = {
  expectedHoldDays: 7,
  moveCost: { bridgeFeeUsd: 1.2, gasExitUsd: 0.3, gasEnterUsd: 0.3, slippageUsd: 0.2 },
  venueIdOf,
  asOf: ASOF,
};

describe('§7.5 the on-chain payback check, mirrored', () => {
  /// The spec's worked example, in the integer form the Router uses.
  it.each([
    { label: '$1,000', amount: 1_000n, expected: false },
    { label: '$10,000', amount: 10_000n, expected: true },
    { label: '$50,000', amount: 50_000n, expected: true },
  ])('$label at ΔAPR 3%, cost $2 -> accept=$expected', ({ amount, expected }) => {
    const { ok } = routerWouldAccept({
      amountUsdc6: amount * 1_000_000n,
      estCostUsdc6: 2_000_000n,
      deltaApyBps: 300n,
      expectedHoldDays: 7n,
    });
    expect(ok).toBe(expected);
  });

  it('never divides, so a sub-day payback survives', () => {
    // At $50k the true payback is 0.49 days. Integer division would floor it
    // to 0 and lose the comparison entirely.
    const { lhs, rhs } = routerWouldAccept({
      amountUsdc6: 50_000n * 1_000_000n,
      estCostUsdc6: 2_000_000n,
      deltaApyBps: 300n,
      expectedHoldDays: 7n,
    });
    expect(lhs).toBeGreaterThan(0n);
    expect(rhs).toBeGreaterThan(lhs);
  });
});

describe('planner', () => {
  it('deploys idle capital when nothing is held', () => {
    const ranking = rank([here, away], { depositUsd: 100_000, now: NOW });
    const plan = planRebalance(ranking, { ...baseConfig, amountUsdc6: 100_000n * 1_000_000n });

    expect(plan.action).toBe('deploy');
    if (plan.action !== 'deploy') return;
    expect(plan.venueId).toBe(VENUE_IDS.away);
    expect(plan.reason).toMatch(/Deploying idle capital/);
  });

  it('produces a proof that verifies against its own root', () => {
    const ranking = rank([here, away], { depositUsd: 100_000, now: NOW });
    const plan = planRebalance(ranking, { ...baseConfig, amountUsdc6: 100_000n * 1_000_000n });
    if (plan.action !== 'deploy') throw new Error('expected a deploy');

    const leaf = leafHash({
      venueId: plan.venueId,
      scoreBps: plan.scoreBps,
      netApyBps: plan.netApyBps,
      asOf: plan.asOf,
    });
    expect(verifyProof(plan.proof, plan.root, leaf)).toBe(true);
  });

  it('holds at a size where the move cannot repay its cost', () => {
    const ranking = rank([here, away], { depositUsd: 1_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 1_000n * 1_000_000n,
      currentVenueId: VENUE_IDS.here,
    });

    expect(plan.action).toBe('hold');
    if (plan.action !== 'hold') return;
    expect(plan.reason).toMatch(/days of holding|exceeds/);
  });

  it('moves at a size where it can — same venues, same edge', () => {
    const ranking = rank([here, away], { depositUsd: 500_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 500_000n * 1_000_000n,
      currentVenueId: VENUE_IDS.here,
    });

    expect(plan.action).toBe('rebalance');
    if (plan.action !== 'rebalance') return;
    expect(plan.fromVenueId).toBe(VENUE_IDS.here);
    expect(plan.toVenueId).toBe(VENUE_IDS.away);
    expect(plan.breakevenDays).toBeLessThan(7);
    expect(plan.reason).toMatch(/pays back in/);
  });

  it('holds when already in the best venue', () => {
    const ranking = rank([here, away], { depositUsd: 500_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 500_000n * 1_000_000n,
      currentVenueId: VENUE_IDS.away,
    });
    expect(plan.action).toBe('hold');
    if (plan.action !== 'hold') return;
    expect(plan.reason).toMatch(/Already in the best venue/);
  });

  /// §10.2: "Score oracle offline → Vault holds; no rebalance is always a
  /// valid state."
  it('holds rather than throwing when nothing is rankable', () => {
    const unrankable = pool({
      poolId: 'here',
      activeTvlUsd: null,
      activeTvlDeltaBps: null,
      activeTvlFidelity: 'unavailable',
    });
    const ranking = rank([unrankable], { depositUsd: 100_000, now: NOW });
    const plan = planRebalance(ranking, { ...baseConfig, amountUsdc6: 100_000n * 1_000_000n });

    expect(plan.action).toBe('hold');
    if (plan.action !== 'hold') return;
    expect(plan.reason).toMatch(/No venue is rankable/);
  });

  it('holds when no ranked pool maps to a registered venue', () => {
    const ranking = rank([here, away], { depositUsd: 100_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 100_000n * 1_000_000n,
      venueIdOf: () => undefined,
    });
    expect(plan.action).toBe('hold');
  });

  it('declines a cost above the Router’s own bound before spending gas', () => {
    const ranking = rank([here, away], { depositUsd: 1_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 1_000n * 1_000_000n,
      currentVenueId: VENUE_IDS.here,
      moveCost: 100, // 10% of the position
    });
    expect(plan.action).toBe('hold');
    if (plan.action !== 'hold') return;
    expect(plan.reason).toMatch(/exceeds 500bps/);
  });
});
