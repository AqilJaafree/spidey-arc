/**
 * Rebalance planner — spec §11 Day 2.5, "driven by the switch rule".
 *
 * Turns a ranking into a concrete transaction the Router will accept, or into
 * an explicit decision to hold. §10.2: "Score oracle offline → Vault holds; no
 * rebalance is always a valid state." Holding is a first-class outcome here,
 * not an error path.
 *
 * The planner deliberately re-implements the Router's payback inequality in
 * the same integer form the contract uses. That duplication is the point: the
 * contract is the authority, and a keeper that submits a move the contract
 * will reject burns gas and produces a confusing revert. Mirroring the check
 * lets the keeper decline locally, for free, with a readable reason.
 */

import {
  DEFAULT_KAPPA,
  evaluateSwitch,
  totalMoveCost,
  type MoveCost,
  type RankedPool,
  type RankResult,
} from '@spidey/core';
import { buildScoreTree, type ScoreLeaf, type ScoreTree } from './merkle.js';
import type { Hex } from 'viem';

/** Mirrors `Router.HYSTERESIS_NUM / HYSTERESIS_DEN` = 1.75. */
export const HYSTERESIS_NUM = 7n;
export const HYSTERESIS_DEN = 4n;
const BPS = 10_000n;
const DAYS_PER_YEAR = 365n;

/**
 * The on-chain rule, in integers, exactly as `Router.checkPayback` computes it:
 *
 *   365 · cost · BPS · NUM  ≤  hold · DEN · amount · ΔBps
 *
 * No division, so no truncation — see the Router's note on why the spec's
 * printed form cannot be used.
 */
export function routerWouldAccept(params: {
  amountUsdc6: bigint;
  estCostUsdc6: bigint;
  deltaApyBps: bigint;
  expectedHoldDays: bigint;
}): { ok: boolean; lhs: bigint; rhs: bigint } {
  const { amountUsdc6, estCostUsdc6, deltaApyBps, expectedHoldDays } = params;
  const lhs = DAYS_PER_YEAR * estCostUsdc6 * BPS * HYSTERESIS_NUM;
  const rhs = expectedHoldDays * HYSTERESIS_DEN * amountUsdc6 * deltaApyBps;
  return { ok: lhs <= rhs, lhs, rhs };
}

export type PlannerConfig = {
  /** Position size in USDC base units (6dp). */
  amountUsdc6: bigint;
  expectedHoldDays: number;
  /** Venue currently holding the capital, if any. */
  currentVenueId?: number;
  /** Cost of moving, USD. Itemized or pre-summed. */
  moveCost: MoveCost | number;
  /** Router's `maxNetApyBps` sanity bound. Proposals above it are dropped. */
  maxNetApyBps?: number;
  /** Router's `maxCostBps` bound on cost as a share of the amount. */
  maxCostBps?: number;
  kappa?: number;
  /** Maps a ranked pool's `poolId` to the on-chain venue id. */
  venueIdOf: (pool: RankedPool) => number | undefined;
  asOf: number;
};

export type RebalancePlan =
  | { action: 'hold'; reason: string }
  | {
      action: 'deploy';
      venueId: number;
      amountUsdc6: bigint;
      netApyBps: number;
      scoreBps: number;
      proof: Hex[];
      root: Hex;
      asOf: number;
      reason: string;
    }
  | {
      action: 'rebalance';
      fromVenueId: number;
      toVenueId: number;
      amountUsdc6: bigint;
      fromNetApyBps: number;
      toNetApyBps: number;
      estCostUsdc6: bigint;
      scoreBps: number;
      proof: Hex[];
      root: Hex;
      asOf: number;
      /** `H_breakeven` in days, for the log line and the UI. */
      breakevenDays: number;
      reason: string;
    };

/** Build the epoch's score tree from a ranking. */
export function buildEpochTree(
  ranking: RankResult,
  venueIdOf: PlannerConfig['venueIdOf'],
  asOf: number,
): { tree: ScoreTree; leaves: ScoreLeaf[] } {
  const leaves: ScoreLeaf[] = [];
  for (const pool of ranking.ranked) {
    const venueId = venueIdOf(pool);
    if (venueId === undefined) continue;
    leaves.push({
      venueId,
      scoreBps: Math.max(1, Math.round(pool.scoreBps ?? 0)),
      netApyBps: Math.max(0, Math.round(pool.yourAprBps ?? 0)),
      asOf,
    });
  }
  if (leaves.length === 0) {
    throw new RangeError('no ranked pool maps to a registered venue');
  }
  return { tree: buildScoreTree(leaves), leaves };
}

/**
 * Decide what, if anything, to do this epoch.
 *
 * Returns `hold` rather than throwing whenever the answer is "do nothing" —
 * an empty ranking, a destination that is already the current venue, or an
 * edge that does not repay its cost are all normal states.
 */
export function planRebalance(ranking: RankResult, config: PlannerConfig): RebalancePlan {
  const {
    amountUsdc6,
    expectedHoldDays,
    currentVenueId,
    moveCost,
    maxNetApyBps = 100_000,
    maxCostBps = 500,
    kappa = DEFAULT_KAPPA,
    venueIdOf,
    asOf,
  } = config;

  if (ranking.ranked.length === 0) {
    return { action: 'hold', reason: 'No venue is rankable — every candidate was excluded.' };
  }

  let tree: ScoreTree;
  try {
    ({ tree } = buildEpochTree(ranking, venueIdOf, asOf));
  } catch (error) {
    return { action: 'hold', reason: (error as Error).message };
  }

  // Pick the best destination that both maps to a venue and clears the
  // Router's own APY sanity bound.
  const best = ranking.ranked.find((pool) => {
    const venueId = venueIdOf(pool);
    if (venueId === undefined) return false;
    return (pool.yourAprBps ?? 0) <= maxNetApyBps;
  });

  if (!best) {
    return {
      action: 'hold',
      reason: `No ranked venue is both registered and inside the ${maxNetApyBps}bps APY bound.`,
    };
  }

  const toVenueId = venueIdOf(best) as number;
  const toNetApyBps = Math.max(0, Math.round(best.yourAprBps ?? 0));
  const scoreBps = Math.max(1, Math.round(best.scoreBps ?? 0));
  const proof = tree.proofForVenue(toVenueId) ?? [];

  // Nothing deployed yet: deploy, with no payback test to satisfy.
  if (currentVenueId === undefined) {
    return {
      action: 'deploy',
      venueId: toVenueId,
      amountUsdc6,
      netApyBps: toNetApyBps,
      scoreBps,
      proof,
      root: tree.root,
      asOf,
      reason: `Deploying idle capital to ${best.dex} ${best.pair.join('/')} at ${(toNetApyBps / 100).toFixed(2)}%.`,
    };
  }

  if (toVenueId === currentVenueId) {
    return {
      action: 'hold',
      reason: `Already in the best venue (${best.dex} ${best.pair.join('/')}).`,
    };
  }

  const current = ranking.ranked.find((p) => venueIdOf(p) === currentVenueId);
  const fromNetApyBps = Math.max(0, Math.round(current?.yourAprBps ?? 0));

  const costUsd = typeof moveCost === 'number' ? moveCost : totalMoveCost(moveCost);
  const estCostUsdc6 = BigInt(Math.round(costUsd * 1e6));

  // The Router's cost sanity bound, checked before we spend gas finding out.
  if (estCostUsdc6 * BPS > amountUsdc6 * BigInt(maxCostBps)) {
    return {
      action: 'hold',
      reason: `Move cost of $${costUsd.toFixed(2)} exceeds ${maxCostBps}bps of the position.`,
    };
  }

  const verdict = evaluateSwitch({
    depositUsd: Number(amountUsdc6) / 1e6,
    toNetApr: toNetApyBps / 10_000,
    fromNetApr: fromNetApyBps / 10_000,
    cost: costUsd,
    expectedHoldDays,
    kappa,
  });

  if (!verdict.switch) {
    return {
      action: 'hold',
      reason:
        verdict.reason === 'no-edge'
          ? `Best venue is not better than the current one (Δ ${(verdict.deltaApr * 100).toFixed(2)}pp).`
          : `Edge does not repay the move: needs ${verdict.requiredHoldDays.toFixed(1)} days of holding, expected ${expectedHoldDays}.`,
    };
  }

  // Final gate: mirror the contract exactly, so we never submit a revert.
  const onChain = routerWouldAccept({
    amountUsdc6,
    estCostUsdc6,
    deltaApyBps: BigInt(toNetApyBps - fromNetApyBps),
    expectedHoldDays: BigInt(expectedHoldDays),
  });

  if (!onChain.ok) {
    return {
      action: 'hold',
      reason: 'Off-chain rule accepted the move but the on-chain integer check would reject it.',
    };
  }

  return {
    action: 'rebalance',
    fromVenueId: currentVenueId,
    toVenueId,
    amountUsdc6,
    fromNetApyBps,
    toNetApyBps,
    estCostUsdc6,
    scoreBps,
    proof,
    root: tree.root,
    asOf,
    breakevenDays: verdict.breakevenDays,
    reason: `Moving to ${best.dex} ${best.pair.join('/')}: +${((toNetApyBps - fromNetApyBps) / 100).toFixed(2)}pp, pays back in ${verdict.breakevenDays.toFixed(2)} days.`,
  };
}
