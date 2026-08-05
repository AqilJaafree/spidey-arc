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
  CCTP_DOMAIN,
  DEFAULT_KAPPA,
  evaluateSwitch,
  totalMoveCost,
  type MoveCost,
  type RankedPool,
  type RankResult,
} from '@spidey/core';
import { buildScoreTree, leafHash, verifyProof, type ScoreLeaf, type ScoreTree } from './merkle.js';
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

/** The Router's own default, mirrored so the tree and the plan share a bound. */
export const DEFAULT_MAX_NET_APY_BPS = 100_000;

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
  /**
   * CCTP domain of the chain the vault itself lives on. Any venue on a
   * different domain is reached through a bridge, and cannot be exited from
   * the hub in one transaction — see {@link isRemote}.
   */
  hubCctpDomain?: number;
  asOf: number;
};

/**
 * Whether this venue's capital can be pulled back by a call from the hub.
 *
 * §4: "a direct call cannot cross a chain." `Router.rebalance` reaches an
 * executor with a direct call, so a venue on another chain must be exited from
 * *that* chain — `CctpBridgeExecutor.exit` reverts
 * `ExitMustBeInitiatedOnDestination` rather than pretending otherwise. The
 * chain is therefore the whole test: nothing about size, price or holding
 * period can make a remote exit expressible.
 */
export function isRemote(pool: RankedPool, hubCctpDomain: number): boolean {
  return pool.cctpDomain !== hubCctpDomain;
}

/**
 * One candidate per venue, in ranking order.
 *
 * Two rules, and both exist because the tree and the plan must be built from
 * the same set or they can disagree about which leaf a venue's proof belongs to:
 *
 *  1. **One leaf per venue.** `ScoreOracle` stores one root per epoch and
 *     verifies `(venueId, scoreBps, netApyBps)` against it, so the tree is a
 *     venue→score map. Several pools routinely share a venue — on Arc there is
 *     one Solana venue, the `MeteoraReceiver` program, while the ranker sees
 *     every Orca and Raydium pool — and two leaves for one venue is two
 *     contradictory scores the chain cannot tell apart.
 *
 *  2. **The Router's APY bound applies here too.** A leaf above `maxNetApyBps`
 *     is one `rebalance` would reject on sight; including it only lets it
 *     shadow the leaf the plan actually carries.
 */
function candidatesFor(
  ranking: RankResult,
  venueIdOf: PlannerConfig['venueIdOf'],
  asOf: number,
  maxNetApyBps: number,
): Array<{ pool: RankedPool; venueId: number; leaf: ScoreLeaf }> {
  const seen = new Set<number>();
  const candidates: Array<{ pool: RankedPool; venueId: number; leaf: ScoreLeaf }> = [];

  for (const pool of ranking.ranked) {
    const venueId = venueIdOf(pool);
    if (venueId === undefined) continue;

    const netApyBps = Math.max(0, Math.round(pool.yourAprBps ?? 0));
    if (netApyBps > maxNetApyBps) continue;
    if (seen.has(venueId)) continue;

    seen.add(venueId);
    candidates.push({
      pool,
      venueId,
      leaf: { venueId, scoreBps: Math.max(1, Math.round(pool.scoreBps ?? 0)), netApyBps, asOf },
    });
  }

  return candidates;
}

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
    }
  | {
      /**
       * Bring the capital home first. The switch rule was satisfied, but the
       * capital sits on another chain and `Router.rebalance` cannot move it:
       * the call reaches `fromExecutor.exit()`, and a bridge executor reverts
       * there by design.
       *
       * The keeper runs `bridgeAndBook` — App Kit's return leg, then
       * `Router.recordBridgeArrival` — and the next epoch plans a `deploy`
       * against fresh scores. Deliberately carries no proof: the deploy
       * happens after a bridge, by which time this epoch's root is likely
       * older than the Router's `MAX_SCORE_AGE` anyway.
       */
      action: 'return';
      fromVenueId: number;
      /** Where the capital should go once it is home and booked as idle. */
      intendedVenueId: number;
      amountUsdc6: bigint;
      fromNetApyBps: number;
      toNetApyBps: number;
      estCostUsdc6: bigint;
      breakevenDays: number;
      reason: string;
    };

/**
 * Build the epoch's score tree from a ranking — one leaf per venue.
 *
 * @param maxNetApyBps The Router's sanity bound. Leaves above it are dropped
 *        rather than published, since `rebalance` and `deployIdle` both reject
 *        them before touching a proof.
 */
export function buildEpochTree(
  ranking: RankResult,
  venueIdOf: PlannerConfig['venueIdOf'],
  asOf: number,
  maxNetApyBps: number = DEFAULT_MAX_NET_APY_BPS,
): { tree: ScoreTree; leaves: ScoreLeaf[] } {
  const leaves = candidatesFor(ranking, venueIdOf, asOf, maxNetApyBps).map((c) => c.leaf);
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
    maxNetApyBps = DEFAULT_MAX_NET_APY_BPS,
    maxCostBps = 500,
    kappa = DEFAULT_KAPPA,
    venueIdOf,
    hubCctpDomain = CCTP_DOMAIN.arc,
    asOf,
  } = config;

  if (ranking.ranked.length === 0) {
    return { action: 'hold', reason: 'No venue is rankable — every candidate was excluded.' };
  }

  // One list, used for both the tree and the choice. Deriving them separately
  // is how a plan ends up carrying a proof for a leaf it is not asserting.
  const candidates = candidatesFor(ranking, venueIdOf, asOf, maxNetApyBps);

  // Ranked best-first, so the best destination is the head of the same list
  // the tree is built from — not a second, independently filtered search.
  const chosen = candidates[0];
  if (!chosen) {
    return {
      action: 'hold',
      reason: `No ranked venue is both registered and inside the ${maxNetApyBps}bps APY bound.`,
    };
  }

  const tree = buildScoreTree(candidates.map((c) => c.leaf));
  const { pool: best, venueId: toVenueId, leaf: bestLeaf } = chosen;
  const toNetApyBps = bestLeaf.netApyBps;
  const scoreBps = bestLeaf.scoreBps;
  const proof = tree.proofForVenue(toVenueId) ?? [];

  // Defense in depth: the same check `ScoreOracle.verifyScore` will run. If
  // these ever disagree the failure is a `BadProof` revert mid-rebalance, so
  // it is worth catching here where it costs nothing and can say why.
  if (!verifyProof(proof, tree.root, leafHash(bestLeaf))) {
    return {
      action: 'hold',
      reason: `Proof for venue ${toVenueId} does not verify against the epoch root; refusing to submit a move the oracle will reject.`,
    };
  }

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

  // §10.2, and the reason this is a hold rather than a default: a venue that
  // dropped out of the ranking has an APY that is *unknown*, not zero. Reading
  // the missing row as 0bps manufactures an edge out of missing data, and the
  // Router cannot catch it — `fromNetApyBps` arrives in calldata, so its
  // `NoEdge` check only compares the keeper's own two numbers with each other.
  // §6 excludes rather than approximates precisely so this stays visible.
  if (!current || current.yourAprBps === null) {
    const excluded = ranking.excluded.find((p) => venueIdOf(p) === currentVenueId);
    return {
      action: 'hold',
      reason: excluded
        ? `Venue ${currentVenueId} holds the capital but is not in this epoch's ranking (${excluded.reason}), so its yield is unknown rather than zero.`
        : `Venue ${currentVenueId} holds the capital but is not in this epoch's ranking, so its yield is unknown rather than zero.`,
    };
  }

  const fromNetApyBps = Math.max(0, Math.round(current.yourAprBps));

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

  // The move is worth making — but if the capital is on another chain, it
  // cannot be made with `rebalance`. That call reaches `fromExecutor.exit()`,
  // and `CctpBridgeExecutor.exit` reverts `ExitMustBeInitiatedOnDestination`:
  // nothing on Arc can reach into a position on Base or Solana and pull it
  // back. The capital comes home as a CCTP *mint* on the return leg instead,
  // and is deployed onward from idle next epoch.
  if (isRemote(current, hubCctpDomain)) {
    return {
      action: 'return',
      fromVenueId: currentVenueId,
      intendedVenueId: toVenueId,
      amountUsdc6,
      fromNetApyBps,
      toNetApyBps,
      estCostUsdc6,
      breakevenDays: verdict.breakevenDays,
      reason: `Bridge the position home from venue ${currentVenueId} on ${current.chain}, then deploy to ${best.dex} ${best.pair.join('/')}: +${((toNetApyBps - fromNetApyBps) / 100).toFixed(2)}pp. A remote venue cannot be exited from the hub, so this return leg replaces the rebalance.`,
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
