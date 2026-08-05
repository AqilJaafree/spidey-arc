/**
 * The planner against the topology that actually shipped — spec §4, §10.2.
 *
 * `plan.test.ts` ranks two venues and checks the switch rule. This file asks a
 * narrower question: with **one position**, a **Solana devnet** venue and a
 * **Base Sepolia** venue, is the plan the planner emits one the Router can
 * execute? Both venues are remote — Arc is the hub and holds no position of
 * its own — so every move here is remote→remote, which is the case the
 * existing suite never constructs.
 *
 * `contracts/test/CrossChainRebalance.t.sol` is the on-chain half of the same
 * scenario, and pins what the Router does with each plan below.
 */

import { describe, expect, it } from 'vitest';
import { rank, type NormalizedPool } from '@spidey/core';
import { buildEpochTree, planRebalance } from './plan.js';
import { leafHash, verifyProof } from './merkle.js';

const NOW = 1_770_000_000_000;
const ASOF = Math.floor(NOW / 1000);

/** Arc's CCTP domain, the hub the vault lives on. */
const DOMAIN_ARC = 26;
const DOMAIN_SOLANA = 5;
const DOMAIN_BASE = 6;

function pool(overrides: Partial<NormalizedPool> & Pick<NormalizedPool, 'poolId'>): NormalizedPool {
  return {
    chain: 'base',
    cctpDomain: DOMAIN_BASE,
    dex: 'uniswap-v3',
    pair: ['USDC', 'WETH'],
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

/** Venue 2 on Arc: the Base Sepolia vault, reached over CCTP domain 6. */
const VENUE_BASE = 2;
/** Venue 3 on Arc: the Solana devnet `MeteoraReceiver`, over domain 5. */
const VENUE_SOLANA = 3;

const baseUniV3 = pool({
  poolId: 'base-univ3-weth-usdc',
  priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 3_000_000 }],
});

/** A Solana pool with a thin edge over Base — enough to move a large position. */
const orcaStable = pool({
  poolId: 'orca-usdc-usdt',
  chain: 'solana',
  cctpDomain: DOMAIN_SOLANA,
  dex: 'orca',
  pair: ['USDC', 'USDT'],
  priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 3_150_000 }],
});

const VENUE_IDS: Record<string, number> = {
  'base-univ3-weth-usdc': VENUE_BASE,
  'orca-usdc-usdt': VENUE_SOLANA,
  'orca-sol-usdc': VENUE_SOLANA,
};
const venueIdOf = (p: { poolId: string }) => VENUE_IDS[p.poolId];

const baseConfig = {
  expectedHoldDays: 7,
  moveCost: { bridgeFeeUsd: 1.2, gasExitUsd: 0.3, gasEnterUsd: 0.3, slippageUsd: 0.2 },
  venueIdOf,
  asOf: ASOF,
};

describe('one position, Solana devnet and Base Sepolia', () => {
  /**
   * §4: "a direct call cannot cross a chain". `Router.rebalance` calls
   * `fromExecutor.exit()` unconditionally, and a bridge executor's `exit`
   * reverts `ExitMustBeInitiatedOnDestination` — nothing on Arc can reach into
   * a position on Base and pull it back.
   *
   * So a `rebalance` plan whose *from* venue is on another chain is not a move
   * the Router can execute at any size, price or holding period. Emitting one
   * is the exact failure plan.ts exists to prevent: "a keeper that submits a
   * move the contract will reject burns gas and produces a confusing revert."
   */
  it('never proposes a rebalance out of a venue on another chain', () => {
    const ranking = rank([baseUniV3, orcaStable], { depositUsd: 500_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 500_000n * 1_000_000n,
      currentVenueId: VENUE_BASE, // the one position, on Base Sepolia
    });

    expect(plan.action).not.toBe('rebalance');
  });

  /**
   * The move is still economically right — it just takes two steps, and the
   * first one is the App Kit return leg (`bridgeAndBook`), not `Router.rebalance`.
   */
  it('proposes the return leg instead, naming where the capital should go next', () => {
    const ranking = rank([baseUniV3, orcaStable], { depositUsd: 500_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 500_000n * 1_000_000n,
      currentVenueId: VENUE_BASE,
    });

    expect(plan.action).toBe('return');
    if (plan.action !== 'return') return;
    expect(plan.fromVenueId).toBe(VENUE_BASE);
    expect(plan.intendedVenueId).toBe(VENUE_SOLANA);
    expect(plan.amountUsdc6).toBe(500_000n * 1_000_000n);
    expect(plan.reason).toMatch(/bridge|return/i);
  });

  /** The same rule in the other direction: Solana devnet cannot be exited from Arc either. */
  it('applies the same rule to a position on Solana devnet', () => {
    const betterBase = pool({
      poolId: 'base-univ3-weth-usdc',
      priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 3_400_000 }],
    });
    const ranking = rank([betterBase, orcaStable], { depositUsd: 500_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 500_000n * 1_000_000n,
      currentVenueId: VENUE_SOLANA,
    });

    expect(plan.action).toBe('return');
    if (plan.action !== 'return') return;
    expect(plan.fromVenueId).toBe(VENUE_SOLANA);
    expect(plan.intendedVenueId).toBe(VENUE_BASE);
  });

  /**
   * A local venue is still exitable in one transaction, so the hub keeps the
   * cheap path. This is the control: the rule must key on the chain, not on
   * "is this cross-chain anywhere in the move".
   */
  it('still rebalances normally out of an Arc-local venue', () => {
    const arcLocal = pool({
      poolId: 'arc-local',
      chain: 'arc',
      cctpDomain: DOMAIN_ARC,
      dex: 'arc-amm',
      priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 3_000_000 }],
    });
    const ranking = rank([arcLocal, orcaStable], { depositUsd: 500_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 500_000n * 1_000_000n,
      currentVenueId: 1,
      venueIdOf: (p) => (p.poolId === 'arc-local' ? 1 : VENUE_IDS[p.poolId]),
    });

    expect(plan.action).toBe('rebalance');
    if (plan.action !== 'rebalance') return;
    expect(plan.fromVenueId).toBe(1);
    expect(plan.toVenueId).toBe(VENUE_SOLANA);
  });

  /** Deploying idle capital into a remote venue is a burn, and works. */
  it('deploys idle capital straight into a remote venue', () => {
    const ranking = rank([baseUniV3, orcaStable], { depositUsd: 500_000, now: NOW });
    const plan = planRebalance(ranking, { ...baseConfig, amountUsdc6: 500_000n * 1_000_000n });
    expect(plan.action).toBe('deploy');
  });
});

describe('the epoch tree is a venue→score map, not a pool list', () => {
  /**
   * On Arc there is *one* Solana venue — the `MeteoraReceiver` program — but
   * the ranker sees several Solana pools, because a pool is a parameter of the
   * hook rather than a venue of its own. Orca SOL/USDC and Orca USDC/USDT both
   * route to venue 3.
   *
   * `ScoreOracle` stores one root per epoch and verifies `(venueId, score,
   * apy)` against it. Two leaves for one venue is two contradictory scores for
   * the same venue in the same epoch, and nothing on-chain can tell them apart.
   */
  const orcaHot = pool({
    poolId: 'orca-sol-usdc',
    chain: 'solana',
    cctpDomain: DOMAIN_SOLANA,
    dex: 'orca',
    pair: ['SOL', 'USDC'],
    fees24h: 60_000,
    volume24h: 12_000_000,
    priceHistogram: [{ bpsFromPeg: 0, volumeUsd: 12_000_000 }],
  });

  it('emits one leaf per venue when several pools share a venue', () => {
    const ranking = rank([baseUniV3, orcaHot, orcaStable], { depositUsd: 500_000, now: NOW });
    const { leaves } = buildEpochTree(ranking, venueIdOf, ASOF);

    const venueIds = leaves.map((l) => l.venueId);
    expect(new Set(venueIds).size).toBe(venueIds.length);
  });

  /**
   * The failure this produces when it is not deduped: `best` skips the
   * top-ranked Solana pool because its APY is over the Router's
   * `maxNetApyBps` bound, but the *tree* keeps that leaf — so
   * `proofForVenue(3)` returns a proof for a leaf the plan is not carrying.
   * `ScoreOracle.verifyScore` rebuilds the leaf from the values in calldata,
   * walks the proof, gets a different root, and `Router.rebalance` reverts
   * `BadProof(3)`.
   */
  it('proves the leaf it actually carries, under the Router’s APY bound', () => {
    const ranking = rank([baseUniV3, orcaHot, orcaStable], { depositUsd: 500_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 500_000n * 1_000_000n,
      maxNetApyBps: 5_000, // the hot pool ranks first and is far above this
    });

    expect(plan.action).toBe('deploy');
    if (plan.action !== 'deploy') return;

    const leaf = leafHash({
      venueId: plan.venueId,
      scoreBps: plan.scoreBps,
      netApyBps: plan.netApyBps,
      asOf: plan.asOf,
    });
    expect(verifyProof(plan.proof, plan.root, leaf)).toBe(true);
  });

  /** A leaf the Router would reject outright has no business in the tree. */
  it('leaves out venues the Router’s APY bound would reject', () => {
    const ranking = rank([baseUniV3, orcaHot, orcaStable], { depositUsd: 500_000, now: NOW });
    const { leaves } = buildEpochTree(ranking, venueIdOf, ASOF, 5_000);
    expect(leaves.every((l) => l.netApyBps <= 5_000)).toBe(true);
  });
});

describe('§10.2 — a venue that cannot be measured is not a venue yielding zero', () => {
  /**
   * Raydium reports `activeTvlFidelity: 'unavailable'`, and §6 excludes rather
   * than approximates. So the Solana venue holding the position can drop out
   * of the ranking entirely while the capital is still sitting in it.
   *
   * Reading the missing row as `0` bps turns "we cannot price this venue" into
   * "this venue earns nothing", which manufactures an edge out of missing
   * data — and the Router cannot catch it, because `fromNetApyBps` arrives in
   * calldata and its `NoEdge` check compares the keeper's own two numbers.
   */
  const solanaUnmeasurable = pool({
    poolId: 'orca-usdc-usdt',
    chain: 'solana',
    cctpDomain: DOMAIN_SOLANA,
    dex: 'orca',
    pair: ['USDC', 'USDT'],
    activeTvlUsd: null,
    activeTvlDeltaBps: null,
    activeTvlFidelity: 'unavailable',
  });

  it('holds rather than inventing a 0% APY for the venue holding the capital', () => {
    const ranking = rank([baseUniV3, solanaUnmeasurable], { depositUsd: 50_000, now: NOW });
    expect(ranking.excluded.map((r) => r.poolId)).toContain('orca-usdc-usdt');

    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 50_000n * 1_000_000n,
      currentVenueId: VENUE_SOLANA,
    });

    expect(plan.action).toBe('hold');
    if (plan.action !== 'hold') return;
    expect(plan.reason).toMatch(/not in this epoch|unknown|cannot be (priced|measured)/i);
  });

  /** And it must not report an edge measured against that invented zero. */
  it('does not report an edge measured against the invented zero', () => {
    const ranking = rank([baseUniV3, solanaUnmeasurable], { depositUsd: 50_000, now: NOW });
    const plan = planRebalance(ranking, {
      ...baseConfig,
      amountUsdc6: 50_000n * 1_000_000n,
      currentVenueId: VENUE_SOLANA,
    });
    if (plan.action !== 'hold') throw new Error('expected a hold');
    expect(plan.reason).not.toMatch(/\+\d+\.\d+pp/);
  });
});
