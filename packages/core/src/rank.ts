/**
 * The decision engine: `rank(A)`.
 *
 * Spec §7.3 — "Marginal, not average. The ranking must be recomputed per
 * deposit size. Ranking is a function `rank(A)`, not a static list."
 *
 * That is the whole reason this is a function of `depositUsd` rather than a
 * sorted table computed once. Everything here is pure: adapters do the I/O,
 * this decides.
 */

import { rateToBps } from './fixed.js';
import { concentrationFactor, deltaFromBps, normalizeYieldToDelta } from './math/concentration.js';
import {
  dilutionFactor,
  volumeCaptureRatio,
  volumeInRange,
  yourFeeApr,
} from './math/dilution.js';
import { headlineFeeApr, observedFeeRate, poolFeeApr } from './math/feeApr.js';
import { estimateExitProbability, evaluateEntry, type EntryVerdict } from './math/entry.js';
import { robustApr, whaleFlag } from './math/hygiene.js';
import {
  DEFAULT_KAPPA,
  evaluateSwitch,
  totalMoveCost,
  type MoveCost,
  type SwitchVerdict,
} from './math/switchRule.js';
import type { NormalizedPool, PoolFlag } from './types.js';

/**
 * §10.2: "Staleness threshold per source; exclude, never extrapolate."
 *
 * 30 minutes: venue APIs commonly refresh on a 5–15 minute cadence, and a
 * tighter bound excludes healthy sources for being ordinarily slow.
 */
export const DEFAULT_MAX_STALENESS_MS = 30 * 60 * 1000;

/**
 * Fallback range half-width when a pool states no measured width and the
 * caller pins none: ±0.1%.
 */
export const DEFAULT_RANGE_DELTA_BPS = 10;

/**
 * The width every venue's yield is restated at for cross-venue comparison
 * (§7.2). Comparing a ±1bp Orca number against a ±60bp Uniswap number
 * without this is "comparing range width, not venue quality".
 */
export const REFERENCE_DELTA_BPS = 10;

/**
 * How far the width `activeTvlUsd` was measured over may differ from the
 * requested range before the comparison stops being meaningful. A factor of
 * 2 either way; beyond that the pool is excluded rather than rescaled, since
 * rescaling assumes a uniform liquidity distribution that no CLMM has.
 */
export const RANGE_WIDTH_TOLERANCE = 2;

/** Your deposit taking more than this share of in-range liquidity is flagged. */
export const DILUTION_FLAG_THRESHOLD = 0.2;

/** A score more than this fraction emissions gets the emissions flag. */
export const EMISSIONS_FLAG_THRESHOLD = 0.5;

/**
 * Largest APR expressible as uint32 basis points: 429,496x, or 42,949,600%.
 * Beyond this a "yield" is a data bug, and clamping keeps it from taking the
 * whole ranking down with an overflow.
 */
export const MAX_APR_FRACTION = 429_496;

export type RankOptions = {
  /** `A` — the deposit being ranked for. The whole point. */
  depositUsd: number;
  /** `H_expected_hold`, days. Drives the switch rule (§7.5). */
  expectedHoldDays?: number;
  /**
   * Range half-width to assume, bps, clamped up to each venue's granularity.
   *
   * Omit it — the usual case — and each pool is evaluated at the width it can
   * actually answer at (`activeTvlDeltaBps`). Pinning one value across venues
   * sounds fairer but is not: an Orca stable pool measures in-range liquidity
   * at ±1bp and a Uniswap 0.3% pool at ±60bp, so a single pinned width
   * excludes almost everything on width-mismatch. Per-venue widths plus the
   * §7.2 normalization in `normalizedAprBps` compares venue quality without
   * discarding the field.
   */
  rangeDeltaBps?: number;
  /** `poolId` of the position currently held, if any — enables switch verdicts. */
  currentPoolId?: string;
  /** Cost of moving into a venue, USD. Itemized or pre-summed. */
  moveCost?: MoveCost | number;
  /** Cost of entering a venue on the same chain, USD. */
  entryCostUsd?: number;
  /** Hysteresis κ (§7.5). */
  kappa?: number;
  /** Unix ms; injected so ranking is deterministic under test. */
  now?: number;
  maxStalenessMs?: number;
};

export type RankedPool = {
  poolId: string;
  chain: string;
  dex: string;
  pair: [string, string];
  cctpDomain: number;

  /** What a dashboard prints: fees over headline TVL. */
  headlineAprBps: number;
  /** §7.1: fees over in-range TVL. Still not your number. */
  poolFeeAprBps: number | null;
  /** §7.3: your yield at your size, at this venue's own range width. */
  yourAprBps: number | null;
  /**
   * §7.2: `yourAprBps` restated at {@link REFERENCE_DELTA_BPS}, so venues
   * quoted at different widths can be compared on quality rather than on how
   * tightly they happen to range.
   */
  normalizedAprBps: number | null;
  /** §7.6 robust score, plus discounted emissions. The ranking key. */
  scoreBps: number | null;

  /** Range half-width actually used, after clamping to venue granularity. */
  deltaBps: number;
  /** `C(δ)` at that width — how the venue's range compares, not its quality. */
  concentration: number;
  /** `T_δ/(T_δ+A)` — the share of pool yield surviving your own deposit. */
  dilution: number | null;
  /** Share of 24h volume executing inside the range. */
  volumeCapture: number | null;
  /** Fee rate used, bps: realized where available, static tier otherwise. */
  effectiveFeeBps: number;

  entry: EntryVerdict | null;
  switchFrom: SwitchVerdict | null;

  flags: PoolFlag[];
  excluded: boolean;
  /** One-line, user-facing explanation of the row's position. */
  reason: string;
};

export type RankResult = {
  depositUsd: number;
  /** The pinned width, or `'venue-native'` when each pool used its own. */
  rangeDeltaBps: number | 'venue-native';
  ranked: RankedPool[];
  excluded: RankedPool[];
  /** How the ranking differs from ranking on the headline number. */
  headlineDisagreement: {
    /** Best pool by headline APR. */
    headlineWinnerPoolId: string | null;
    /** Best pool by our number at this size. */
    ourWinnerPoolId: string | null;
    /** True when the two disagree — the §12 step 2 screenshot. */
    disagrees: boolean;
  };
};

/**
 * The venue's minimum meaningful range half-width, bps. A Uniswap tick is
 * 1bp of price, so `tickSpacing` ticks is `tickSpacing` bps; Meteora's
 * `binStep` is already bps. Asking for a range tighter than one step is
 * asking for a position the venue cannot express.
 */
export function venueGranularityBps(pool: NormalizedPool): number {
  return pool.binStep ?? pool.tickSpacing ?? 1;
}

/**
 * The range half-width a pool is evaluated at.
 *
 * A pinned `requested` width is honoured (clamped up to what the venue can
 * express), and the width check in {@link othersLiquidityInRange} then
 * excludes pools that cannot answer at it. With no pin, the pool is evaluated
 * at the width its in-range liquidity was actually measured over — which is
 * always answerable, and is the width a depositor would really use at that
 * venue. Cross-venue comparability is restored by `normalizedAprBps` (§7.2)
 * rather than by forcing every venue onto one width.
 */
export function resolveDeltaBps(pool: NormalizedPool, requested?: number): number {
  const floor = venueGranularityBps(pool);
  if (requested !== undefined) return Math.max(requested, floor);
  return Math.max(pool.activeTvlDeltaBps ?? DEFAULT_RANGE_DELTA_BPS, floor);
}

/**
 * `T_δ` — others' liquidity overlapping the requested range.
 *
 * Preferred source is the liquidity histogram, which answers the question
 * directly at any δ *within the width it was measured over* — `activeTvlDeltaBps`
 * doubles as that declared coverage, and a wider question is refused rather
 * than answered from buckets that were never collected. Falling back to
 * `activeTvlUsd` is only sound when it was measured over a comparable width;
 * outside {@link RANGE_WIDTH_TOLERANCE} this returns `null` and the pool is
 * excluded, per §6.
 */
export function othersLiquidityInRange(
  pool: NormalizedPool,
  deltaBps: number,
): { value: number | null; flag: PoolFlag | null } {
  if (pool.liquidityHistogram && pool.liquidityHistogram.length > 0) {
    // A histogram answers `T_δ` directly at any δ it actually covers — and
    // only there. Summing a ±100bp histogram for a ±500bp question returns the
    // narrow total as though it were the wide one, understating `T_δ`, which
    // overstates your share and your APR. It fails in the flattering
    // direction, so it has to be refused rather than truncated. Same posture
    // as the `activeTvlUsd` branch below, and the same flag.
    //
    // The check is one-sided where the scalar branch's is two-sided: a
    // histogram can always answer a *narrower* question exactly by summing
    // fewer buckets, whereas rescaling a single scalar is unsound in either
    // direction.
    if (pool.activeTvlDeltaBps === null) return { value: null, flag: 'range-width-mismatch' };
    if (deltaBps > pool.activeTvlDeltaBps) return { value: null, flag: 'range-width-mismatch' };

    let total = 0;
    for (const bucket of pool.liquidityHistogram) {
      if (Math.abs(bucket.bpsFromPeg) <= deltaBps) total += bucket.liquidityUsd;
    }
    return { value: total, flag: null };
  }

  if (pool.activeTvlUsd === null) return { value: null, flag: 'no-active-tvl' };
  if (pool.activeTvlDeltaBps === null) return { value: null, flag: 'range-width-mismatch' };

  const ratio = deltaBps / pool.activeTvlDeltaBps;
  if (ratio > RANGE_WIDTH_TOLERANCE || ratio < 1 / RANGE_WIDTH_TOLERANCE) {
    return { value: null, flag: 'range-width-mismatch' };
  }
  return { value: pool.activeTvlUsd, flag: null };
}

function effectiveFeeBps(pool: NormalizedPool): number {
  const observed =
    pool.feeBpsObserved24h ??
    (() => {
      const rate = observedFeeRate(pool.fees24h, pool.volume24h);
      return rate === null ? null : rate * 10_000;
    })();
  return observed ?? pool.feeBps;
}

function excludedRow(
  pool: NormalizedPool,
  deltaBps: number,
  flags: PoolFlag[],
  reason: string,
): RankedPool {
  return {
    poolId: pool.poolId,
    chain: pool.chain,
    dex: pool.dex,
    pair: pool.pair,
    cctpDomain: pool.cctpDomain,
    headlineAprBps: safeHeadlineBps(pool),
    poolFeeAprBps: null,
    yourAprBps: null,
    normalizedAprBps: null,
    scoreBps: null,
    deltaBps,
    concentration: concentrationFactor(deltaFromBps(deltaBps)),
    dilution: null,
    volumeCapture: null,
    effectiveFeeBps: effectiveFeeBps(pool),
    entry: null,
    switchFrom: null,
    flags,
    excluded: true,
    reason,
  };
}

function safeHeadlineBps(pool: NormalizedPool): number {
  if (pool.tvlUsd <= 0) return 0;
  const apr = headlineFeeApr({
    volume24hUsd: pool.volume24h,
    feeRate: effectiveFeeBps(pool) / 10_000,
    tvlUsd: pool.tvlUsd,
  });
  // Guard the uint32 bps bound: a thin pool with a whale swap can print an
  // absurd headline, which is itself the point, but it must not overflow.
  return rateToBps(Math.min(apr, MAX_APR_FRACTION));
}

function scorePool(
  pool: NormalizedPool,
  options: Required<Pick<RankOptions, 'depositUsd' | 'expectedHoldDays' | 'kappa'>> & RankOptions,
  deltaBps: number,
  now: number,
  maxStalenessMs: number,
): RankedPool {
  const flags: PoolFlag[] = [];

  if (now - pool.asOf > maxStalenessMs) {
    return excludedRow(
      pool,
      deltaBps,
      ['stale'],
      `Data from ${pool.source} is ${Math.round((now - pool.asOf) / 60_000)} min old; excluded rather than extrapolated.`,
    );
  }

  const { value: tDelta, flag: liquidityFlag } = othersLiquidityInRange(pool, deltaBps);
  if (tDelta === null) {
    const flag = liquidityFlag ?? 'no-active-tvl';
    return excludedRow(
      pool,
      deltaBps,
      [flag],
      flag === 'no-active-tvl'
        ? `${pool.dex} did not supply in-range liquidity; excluded rather than approximated.`
        : `${pool.dex} reported in-range liquidity at ±${pool.activeTvlDeltaBps}bp, not ±${deltaBps}bp; excluded rather than rescaled.`,
    );
  }

  const feeBps = effectiveFeeBps(pool);
  const feeRate = feeBps / 10_000;
  const depositUsd = options.depositUsd;

  const vDelta = volumeInRange(pool.priceHistogram, deltaBps);
  const capture =
    pool.priceHistogram.length > 0 ? volumeCaptureRatio(pool.priceHistogram, deltaBps) : null;

  const yourApr = yourFeeApr({
    feeRate,
    volumeInRangeUsd: vDelta,
    othersLiquidityInRangeUsd: tDelta,
    depositUsd,
  });
  const dilution = dilutionFactor(tDelta, depositUsd);
  if (dilution < 1 - DILUTION_FLAG_THRESHOLD) flags.push('dilution');

  const poolApr = tDelta > 0 ? poolFeeApr({ volume24hUsd: vDelta, feeRate, activeTvlUsd: tDelta }) : null;

  const whale = pool.hourlyFeeSeries.length > 0 ? whaleFlag(pool.hourlyFeeSeries) : null;
  if (whale?.flagged) flags.push('one-whale-volume');

  const robust =
    pool.hourlyFeeSeries.length > 0
      ? robustApr({
          hourlyApr: pool.hourlyFeeSeries,
          hourlyVolume: pool.hourlyVolumeSeries ?? [],
          apyReward: pool.apyReward,
        })
      : null;

  // Scale the robust estimate — computed on the pool as it stands — down by
  // the dilution your own deposit causes. Without this the hygiene layer
  // would quietly reintroduce the undiluted number as the ranking key.
  const score = robust === null ? yourApr : robust.score * dilution;
  if (robust !== null && robust.score > 0 && robust.discountedRewardApy / robust.score > EMISSIONS_FLAG_THRESHOLD) {
    flags.push('emissions-dependent');
  }

  const exitProbability24h =
    pool.daily24hRangesBps && pool.daily24hRangesBps.length > 0
      ? estimateExitProbability(pool.daily24hRangesBps, deltaBps)
      : 0;

  const entry = evaluateEntry({
    feeRate,
    volumeInRangeUsd: vDelta,
    othersLiquidityInRangeUsd: tDelta,
    depositUsd,
    delta: deltaFromBps(deltaBps),
    exitProbability24h,
    totalCostUsd: options.entryCostUsd ?? 0,
    costHorizonDays: options.expectedHoldDays,
  });
  if (!entry.enter) flags.push('fails-entry-condition');

  // Data-provenance flags. These do not change the number; they say how much
  // of it was measured and how much was assumed (§6).
  if (pool.priceHistogramSource !== 'observed') flags.push('modelled-volume-distribution');
  if (pool.hourlyFeeSeries.length === 0) flags.push('no-hygiene-series');
  if (pool.activeTvlFidelity === 'current-tick-liquidity') {
    flags.push('current-tick-liquidity-only');
  }

  const normalizedApr = normalizeYieldToDelta(yourApr, deltaFromBps(deltaBps), deltaFromBps(REFERENCE_DELTA_BPS));

  return {
    poolId: pool.poolId,
    chain: pool.chain,
    dex: pool.dex,
    pair: pool.pair,
    cctpDomain: pool.cctpDomain,
    headlineAprBps: safeHeadlineBps(pool),
    poolFeeAprBps: poolApr === null ? null : rateToBps(Math.min(poolApr, MAX_APR_FRACTION)),
    yourAprBps: rateToBps(Math.min(yourApr, MAX_APR_FRACTION)),
    normalizedAprBps: rateToBps(Math.max(0, Math.min(normalizedApr, MAX_APR_FRACTION))),
    scoreBps: rateToBps(Math.max(0, Math.min(score, MAX_APR_FRACTION))),
    deltaBps,
    concentration: concentrationFactor(deltaFromBps(deltaBps)),
    dilution,
    volumeCapture: capture,
    effectiveFeeBps: feeBps,
    entry,
    switchFrom: null,
    flags,
    excluded: false,
    reason: '',
  };
}

function explain(row: RankedPool): string {
  if (row.flags.includes('cost-exceeds-edge') && row.switchFrom) {
    return `Better APR, but at $${Math.round(row.switchFrom.totalCostUsd)} of cost it needs ${row.switchFrom.requiredHoldDays.toFixed(1)} days of holding to pay back.`;
  }
  if (row.flags.includes('dilution') && row.dilution !== null) {
    return `Your deposit is ${Math.round((1 - row.dilution) * 100)}% of in-range liquidity, so you earn ${Math.round(row.dilution * 100)}% of the headline rate.`;
  }
  if (row.flags.includes('one-whale-volume')) {
    return 'Volume is a handful of large trades, not a market — the mean is far above the median.';
  }
  if (row.flags.includes('emissions-dependent')) {
    return 'Most of this yield is emissions, discounted 50% because they decay.';
  }
  if (row.flags.includes('fails-entry-condition') && row.entry) {
    return `Fee yield of ${(row.entry.dailyFeeYield * 10_000).toFixed(1)}bp/day does not clear the ${(row.entry.hurdle * 10_000).toFixed(1)}bp/day hurdle.`;
  }
  if (row.volumeCapture !== null && row.volumeCapture > 0.8) {
    return `Captures ${Math.round(row.volumeCapture * 100)}% of 24h volume in range at ±${row.deltaBps}bp.`;
  }
  return `Ranked on your yield at this size, not headline APR.`;
}

/**
 * Rank venues for a specific deposit size.
 *
 * Excluded pools are returned separately rather than dropped: "this pool is
 * not rankable and here is why" is a product feature, not an error path.
 */
export function rank(pools: readonly NormalizedPool[], options: RankOptions): RankResult {
  const {
    depositUsd,
    expectedHoldDays = 7,
    rangeDeltaBps,
    kappa = DEFAULT_KAPPA,
    now = Date.now(),
    maxStalenessMs = DEFAULT_MAX_STALENESS_MS,
    currentPoolId,
    moveCost,
  } = options;

  if (depositUsd <= 0) throw new RangeError(`deposit must be positive, got ${depositUsd}`);

  const resolved = { ...options, depositUsd, expectedHoldDays, kappa };

  const rows = pools.map((pool) => {
    const deltaBps = resolveDeltaBps(pool, rangeDeltaBps);
    return scorePool(pool, resolved, deltaBps, now, maxStalenessMs);
  });

  const ranked = rows.filter((r) => !r.excluded).sort((a, b) => (b.scoreBps ?? 0) - (a.scoreBps ?? 0));
  const excluded = rows.filter((r) => r.excluded);

  // Switch verdicts, relative to the position currently held.
  const current = currentPoolId ? ranked.find((r) => r.poolId === currentPoolId) : undefined;
  if (current) {
    const fromNetApr = (current.yourAprBps ?? 0) / 10_000;
    for (const row of ranked) {
      if (row.poolId === current.poolId) continue;
      const crossChain = row.cctpDomain !== current.cctpDomain;
      const cost = moveCost ?? 0;
      const costUsd = typeof cost === 'number' ? cost : totalMoveCost(cost);
      row.switchFrom = evaluateSwitch({
        depositUsd,
        toNetApr: (row.yourAprBps ?? 0) / 10_000,
        fromNetApr,
        cost: crossChain ? costUsd : Math.min(costUsd, 1),
        expectedHoldDays,
        kappa,
      });
      if (row.switchFrom.deltaApr > 0 && !row.switchFrom.switch) {
        row.flags.push('cost-exceeds-edge');
      }
    }
  }

  for (const row of [...ranked, ...excluded]) {
    if (!row.reason) row.reason = explain(row);
  }

  const headlineWinner = [...rows].sort((a, b) => b.headlineAprBps - a.headlineAprBps)[0];
  const ourWinner = ranked[0];

  return {
    depositUsd,
    rangeDeltaBps: rangeDeltaBps ?? 'venue-native',
    ranked,
    excluded,
    headlineDisagreement: {
      headlineWinnerPoolId: headlineWinner?.poolId ?? null,
      ourWinnerPoolId: ourWinner?.poolId ?? null,
      disagrees: Boolean(headlineWinner && ourWinner && headlineWinner.poolId !== ourWinner.poolId),
    },
  };
}
