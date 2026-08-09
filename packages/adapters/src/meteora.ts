/**
 * Meteora DLMM adapter (Solana).
 *
 * The venue that matters most and was missing: `MeteoraReceiver` — the Anchor
 * program the Router bridges to — deposits into a Meteora DLMM position, so
 * this is the only Solana venue capital can actually reach. Until now the
 * ranker saw Orca and Raydium and never saw Meteora at all, which meant the
 * venue holding the money was the one venue that could not be scored.
 *
 * Two things about this API are worth stating before reading any field.
 *
 * The endpoint published in the older docs (`dlmm-api.meteora.ag/pair/all`) is
 * gone — a Cloudflare-cached 404. This is the current host.
 *
 * And `apr` is not an APR. It equals `fee_tvl_ratio.24h` and is percent *per
 * day*; `apy` is the annual, daily-compounded figure. Mapping the wrong one
 * understates fee yield by ~365x, which is why `apyBase` reads `apy`.
 */

import type { NormalizedPool } from '@spidey/core';
import { getJson } from './http.js';
import {
  activeTvlWithin,
  arrayIndexOf,
  binIdOf,
  binsNeededFor,
  decodeBinArrayAmounts,
  decodeBinArrayIndex,
  decodeLbPairSlice,
  histogramFromBins,
  LB_PAIR_SLICE,
  type IdentifiedBin,
} from './meteoraBins.js';
import { modelledPriceHistogram, peakToTroughBps, traversedBandBps } from './series.js';
import {
  discoverBinArrays,
  getMultipleAccounts,
  MAX_ACCOUNTS_PER_CALL,
  type SolanaRpcOptions,
} from './solanaRpc.js';
import {
  isUsdLikeSymbol,
  type AdapterContext,
  type AdapterResult,
  type VenueAdapter,
} from './types.js';

export const METEORA_BASE = 'https://dlmm.datapi.meteora.ag';
const SOLANA_CCTP_DOMAIN = 5;

/**
 * Half-width the bin reader aims to cover, bps.
 *
 * Wider than `DEFAULT_RANGE_DELTA_BPS` (10) and wider than anything the
 * planner pins, so the coverage guard in `othersLiquidityInRange` stays quiet
 * in normal operation while the fetch stays bounded: 129 bins either side at
 * `binStep = 4`, spanning at most five `BinArray` accounts. The cost is
 * per-bin, so it is set by the *finest* bin step, not the typical one — the same
 * ±500bp is 513 bins and up to 16 accounts on a 1bp pool like JupUSD-USDC, and
 * two bins in one account at 400bp. See {@link MAX_BIN_ARRAYS_PER_POOL}.
 */
export const DEFAULT_BIN_COVERAGE_BPS = 500;

/**
 * Most `BinArray` accounts one pool's read may span.
 *
 * `coverageBps` is a public option, and the reach it buys is geometric in the
 * width and inverse in the bin step, so the fetch it implies is not obvious from
 * the number a caller passes. Measured, at `binStep = 4`:
 *
 *     ±500bp   ->    129 bins/side ->    5 accounts (   49KB)
 *     ±1000bp  ->    264 bins/side ->    9 accounts (   89KB)
 *     ±2000bp  ->    558 bins/side ->   17 accounts (  168KB)
 *     ±5000bp  ->  1,734 bins/side ->   51 accounts (  505KB)
 *     ±9000bp  ->  5,758 bins/side ->  166 accounts (1,643KB)
 *     ±9999bp  -> 23,031 bins/side ->  660 accounts (6,533KB)
 *
 * The bound is on accounts rather than on `coverageBps`, because a bps cap
 * cannot express the cost: ±500bp is 16 accounts at a 1bp step and one at 400bp,
 * so any single width is either too loose for fine bins or too tight for coarse
 * ones. And it is set to `MAX_ACCOUNTS_PER_CALL` because that is where the cost
 * stops being linear — past 100 keys a single pool's bin read becomes several
 * batched round trips, times `topK` pools, against an endpoint whose
 * `getProgramAccounts` this adapter is already careful with. At the limit one
 * read is one round trip of at most ~1MB, which admits ±2927bp at a 1bp step and
 * ±7497bp at 4bp — far past anything the planner asks for, and short of the
 * fan-out.
 *
 * Exceeding it throws rather than truncating. A truncated histogram under a full
 * declared width is precisely the `binsNeededFor` bug, and the whole point of
 * that fix is that the declared width never exceeds what was read.
 */
export const MAX_BIN_ARRAYS_PER_POOL = MAX_ACCOUNTS_PER_CALL;

/**
 * How much wider the *unobserved* volume band is than the width a row declares.
 *
 * `modelledPriceHistogram` spreads 24h volume uniformly over ±R, so the share
 * inside ±δ is `min(1, δ/R)` and the choice of R is the entire model. R used to
 * be a flat 100bp while enriched rows declare `activeTvlDeltaBps: 500` — five
 * times narrower than the δ `resolveDeltaBps` then evaluates them at, so
 * `volumeInRange` summed every bucket and `V_δ` came out as 100% of 24h volume
 * for every enriched pool, unconditionally. That is the least conservative value
 * available, and `explain()` handed it to the user as "Captures 100% of 24h
 * volume in range at ±500bp" — a modelled figure phrased as a measurement.
 *
 * Deriving R from the declared width instead fixed the saturation and nothing
 * else: `min(1, δ/2δ)` is a constant, so every enriched pool reported the same
 * 51% capture whatever it traded like. The band now comes from the pool's own
 * OHLCV candles — see {@link observedRangesFrom} — and this factor survives only
 * as the fallback for a row with no usable candles, where an unobserved band is
 * all there is.
 *
 * The factor is 2 for a reason already in the codebase: `RANGE_WIDTH_TOLERANCE`
 * is 2, the factor beyond which `rank.ts` judges two range widths incomparable.
 * A band of 2δ is therefore the widest — and so most conservative — price range
 * still related to δ by the ranker's own standard.
 */
export const MODELLED_RANGE_FACTOR = 2;

/** The modelled band for a row that declares `declaredBps` of coverage. */
export const modelledRangeFor = (declaredBps: number): number =>
  declaredBps * MODELLED_RANGE_FACTOR;

/**
 * The band for a row with no bin read behind it.
 *
 * Such a row carries no denominator and is excluded by `rank.ts` before `V_δ` is
 * ever consulted, so this only has to be consistent with the coverage the reader
 * would have asked for.
 */
const MODELLED_RANGE_BPS = modelledRangeFor(DEFAULT_BIN_COVERAGE_BPS);

export type MeteoraToken = {
  address: string;
  symbol: string;
  decimals: number;
  price: number;
};

/** The API reports each metric over several windows; only 24h is used. */
export type MeteoraWindow = Partial<Record<'30m' | '1h' | '2h' | '4h' | '12h' | '24h', number>>;

export type MeteoraPool = {
  address: string;
  name?: string;
  token_x: MeteoraToken;
  token_y: MeteoraToken;
  token_x_amount?: number;
  token_y_amount?: number;
  /** `bin_step` is already bps; `base_fee_pct` and `max_fee_pct` are percents. */
  pool_config?: { bin_step?: number; base_fee_pct?: number; max_fee_pct?: number };
  dynamic_fee_pct?: number;
  tvl: number;
  current_price?: number;
  /** Percent per DAY, equal to `fee_tvl_ratio.24h`. Not used — see the header. */
  apr?: number;
  /** Percent per year, compounded daily. This is what `apyBase` comes from. */
  apy?: number;
  has_farm?: boolean;
  farm_apy?: number;
  is_blacklisted?: boolean;
  volume?: MeteoraWindow;
  fees?: MeteoraWindow;
  fee_tvl_ratio?: MeteoraWindow;
};

export type MeteoraPoolsResponse = { data?: MeteoraPool[]; total?: number; pages?: number };

export function normalizeMeteoraPool(
  pool: MeteoraPool,
  now: number,
): NormalizedPool | { skip: string } {
  if (pool.is_blacklisted) return { skip: 'blacklisted by the venue' };
  if (!(pool.tvl > 0)) return { skip: 'no TVL' };

  const binStep = pool.pool_config?.bin_step;
  if (binStep === undefined || !(binStep > 0)) {
    // `binStep` is this venue's range granularity — `venueGranularityBps`
    // reads it to refuse ranges the venue cannot express. Without it there is
    // nothing to fall back to, so exclude rather than assume 1bp.
    return { skip: 'no bin_step in pool_config' };
  }

  const volume24h = pool.volume?.['24h'] ?? 0;
  const fees24h = pool.fees?.['24h'] ?? 0;
  const baseFeePct = pool.pool_config?.base_fee_pct ?? 0;
  const maxFeePct = pool.pool_config?.max_fee_pct ?? 0;

  return {
    chain: 'solana',
    cctpDomain: SOLANA_CCTP_DOMAIN,
    dex: 'meteora-dlmm',
    poolId: pool.address,
    pair: [pool.token_x?.symbol ?? '?', pool.token_y?.symbol ?? '?'],

    feeBps: baseFeePct * 100,
    feeIsDynamic: maxFeePct > baseFeePct,
    feeBpsObserved24h: volume24h > 0 ? (fees24h / volume24h) * 10_000 : null,

    tvlUsd: pool.tvl,
    // The REST row carries no bin data, and `token_*_amount` are whole-pool
    // reserves — nothing here narrows to the active range. `enrichWithBins`
    // fills these in for the pools that get an RPC read; the rest stay honestly
    // unavailable rather than approximated from reserves.
    activeTvlUsd: null,
    activeTvlDeltaBps: null,
    activeTvlFidelity: 'unavailable',
    binStep,

    volume24h,
    volume7d: null,
    fees24h,
    fees7d: null,

    apyBase: (pool.apy ?? 0) / 100,
    apyReward: (pool.farm_apy ?? 0) / 100,

    priceHistogram: modelledPriceHistogram(volume24h, MODELLED_RANGE_BPS),
    priceHistogramSource: 'modelled-uniform-over-range',
    // Left empty on purpose. The API does publish an hourly series, but
    // `rank.ts` lets it *replace* `yourApr`, and the only denominator
    // available here is headline TVL. Supplying it would score this venue
    // ~5.5x low for being the one venue that could.
    hourlyFeeSeries: [],
    volumeAutocorr: null,

    source: 'meteora-datapi',
    asOf: now,
  };
}

export const poolsUrl = (page: number, pageSize: number): string =>
  `${METEORA_BASE}/pools?page=${page}&page_size=${pageSize}`;

export type MeteoraOptions = {
  /** Rows to request from the API before filtering. */
  pageSize?: number;
  /**
   * Seam for tests. Production passes nothing and the adapter fetches through
   * the fixture-aware `getJson`.
   */
  fetchPools?: (ctx: AdapterContext) => Promise<MeteoraPool[]>;
  /** Pools to enrich with bin data. 0 disables the RPC path entirely. */
  topK?: number;
  coverageBps?: number;
  /**
   * Overrides `SOLANA_RPC_URL`, which overrides the public endpoint.
   *
   * One of the two has to be set by anything scanning on a short timer — see
   * `resolveRpcUrl` for the arithmetic, but the short version is that a 60s
   * `PoolCache` TTL turns `topK` into 3K program scans a minute against a free
   * node.
   */
  rpcUrl?: string;
  /** Seam for tests; production builds an RPC-backed source. */
  binSource?: BinSource;
  /**
   * Seam for tests; production builds an OHLCV-backed source.
   *
   * Same hazard as `binSource`, and it has to be stubbed for the same reason: a
   * test that stubs only `fetchPools` and `binSource` still reaches the live
   * candle endpoint for every enriched pool.
   */
  rangeSource?: RangeSource;
} & EnrichmentFloors;

async function fetchPoolsLive(ctx: AdapterContext, pageSize: number): Promise<MeteoraPool[]> {
  const body = await getJson<MeteoraPoolsResponse>(poolsUrl(1, pageSize), {
    namespace: 'meteora',
    signal: ctx.signal,
  });
  return body.data ?? [];
}

export function createMeteoraAdapter(options: MeteoraOptions = {}): VenueAdapter {
  const { pageSize = 200, fetchPools } = options;

  return {
    id: 'meteora',
    label: 'Meteora (DLMM)',
    // What the bin reader reaches. Constant-sum bins make this the only venue
    // that can answer `T_δ` at any δ within the width it measured, rather than
    // at one tick interval — that width is `DEFAULT_BIN_COVERAGE_BPS`, and the
    // row declares it so a wider question is refused rather than guessed.
    bestFidelity: 'tick-level',

    async listPools(ctx: AdapterContext = {}): Promise<AdapterResult> {
      const { symbols, limit = 50, now = Date.now() } = ctx;
      const raw = await (fetchPools ? fetchPools(ctx) : fetchPoolsLive(ctx, pageSize));

      const wanted = symbols?.map((s) => s.toUpperCase());
      const pools: NormalizedPool[] = [];
      const skipped: AdapterResult['skipped'] = [];

      for (const row of raw) {
        if (!row?.address || !row.token_x?.symbol || !row.token_y?.symbol) continue;
        const pair = [row.token_x.symbol.toUpperCase(), row.token_y.symbol.toUpperCase()];
        if (wanted && wanted.length > 0) {
          if (!pair.some((s) => wanted.includes(s))) continue;
        } else if (!pair.some((s) => isUsdLikeSymbol(s))) {
          // A USDC vault cannot take directional risk on a memecoin pair
          // regardless of its headline APR (§7.4).
          continue;
        }

        const result = normalizeMeteoraPool(row, now);
        if ('skip' in result) skipped.push({ poolId: row.address, reason: result.skip });
        else pools.push(result);
        if (pools.length >= limit) break;
      }

      const {
        topK = DEFAULT_TOP_K,
        coverageBps,
        rpcUrl,
        binSource,
        rangeSource,
        minTvlUsd,
        minVolume24hUsd,
      } = options;
      if (topK <= 0 || pools.length === 0) return { pools, skipped };

      // Rank among the rows that actually survived normalization — enriching a
      // pool that was skipped would spend the budget on a row nobody sees.
      // `topKByFeeRatio` also applies the TVL and volume floors, which ration
      // the RPC to pools that could take a deposit. Note what is *not* happening
      // here: the floors touch `chosen`, never `pools`. A sub-floor pool keeps
      // its full REST row and is still listed and still compared, just at
      // `unavailable` — breadth is the product, and the denominator is the
      // expensive part worth rationing.
      const kept = new Set(pools.map((p) => p.poolId));
      const chosen = topKByFeeRatio(
        raw.filter((row) => kept.has(row.address)),
        topK,
        { minTvlUsd, minVolume24hUsd },
      );

      const enriched = await enrichWithBins(pools, {
        // Hazard, paid for once: stubbing `fetchPools` does not isolate a test
        // from the network, because these two lines still reach a live RPC and a
        // live REST host. A test that wants no network must pass `topK: 0`, or
        // its own `binSource` *and* `rangeSource`.
        source: binSource ?? createRpcBinSource({ rpcUrl, signal: ctx.signal }),
        // Rationed exactly as the bin reads are, and for the same reason: a
        // volume band and a volatility series only change a score for a pool that
        // has a denominator to be scored on, and `chosen` is that set. Asking for
        // all 56 rows would be 48 wasted requests per scan.
        ranges: rangeSource ?? createOhlcvRangeSource({ signal: ctx.signal }),
        rows: chosen,
        coverageBps,
      });

      return { pools: enriched, skipped };
    },
  };
}

export const meteoraAdapter: VenueAdapter = createMeteoraAdapter();

/** Pools enriched with bin data per scan. */
export const DEFAULT_TOP_K = 8;

/**
 * Coverage can never be narrower than one bin.
 *
 * `resolveDeltaBps` clamps an unpinned δ up to `venueGranularityBps`, which for
 * a DLMM pool is `binStep`. So a pool whose declared coverage is below its own
 * bin step gets asked a question wider than it answered, and the coverage guard
 * excludes it on `range-width-mismatch` — the venue would silently drop out of
 * the ranking for having a coarse bin. The widest `bin_step` observed live is
 * 400 against a 500bp default, so nothing hits this today; it is one
 * coarser-binned pool away from mattering, and it fails invisibly.
 */
export const coverageFor = (coverageBps: number, binStep: number): number =>
  Math.max(coverageBps, binStep);

export type BinReading = {
  activeId: number;
  binStep: number;
  bins: IdentifiedBin[];
  /** The width the fetched arrays actually cover, bps. */
  coveredBps: number;
};

export type BinSource = (poolId: string, coverageBps: number) => Promise<BinReading>;

/**
 * Floors matching `uniswapV3`'s, and for the same reason.
 *
 * A denominator is only worth an RPC read for a pool that could actually take
 * the vault's deposit. `$1M` TVL with `$100k` daily volume leaves 14 pools on a
 * 200-row page — comfortably more than {@link DEFAULT_TOP_K}.
 */
export const DEFAULT_MIN_TVL_USD = 1_000_000;
export const DEFAULT_MIN_VOLUME_24H_USD = 100_000;

export type EnrichmentFloors = {
  minTvlUsd?: number;
  minVolume24hUsd?: number;
};

/**
 * Could this pool absorb a real deposit?
 *
 * Separate from the ranking because it answers a different question — the
 * ratio says which pool is *most attractive*, this says which are *eligible* —
 * and because `listPools` is not the only place that will ever want to ask.
 */
export function canAbsorbDeposit(row: MeteoraPool, floors: EnrichmentFloors = {}): boolean {
  const { minTvlUsd = DEFAULT_MIN_TVL_USD, minVolume24hUsd = DEFAULT_MIN_VOLUME_24H_USD } = floors;
  return row.tvl >= minTvlUsd && (row.volume?.['24h'] ?? 0) >= minVolume24hUsd;
}

/**
 * Highest 24h fee/TVL ratio first, among pools that could take a deposit.
 *
 * The floors are applied *inside* this function rather than by its callers, and
 * default to on, because `fee_tvl_ratio` unfiltered is not a yield signal — it
 * is a dust detector. It divides fees by TVL, so as TVL approaches zero the
 * ratio explodes: the same 200-row page carries pools at `tvl` well under a
 * dollar scoring 2.7e9, against SOL-USDC's 0.068 on $5.06M and $9.4M of daily
 * volume. Ranked without a floor, the entire budget goes to pools with a few
 * hundred dollars of in-range liquidity, and the venue's real pools — the only
 * ones that can hold the vault's capital — never carry a denominator, so they
 * can never be ranked. That is precisely the failure this adapter exists to
 * fix, so the guard belongs where it cannot be forgotten rather than in a
 * caller that has to remember it.
 *
 * A missing ratio sorts last rather than first: an unmeasured pool must not
 * win the enrichment budget over a measured one.
 */
export function topKByFeeRatio(
  rows: readonly MeteoraPool[],
  k: number,
  floors: EnrichmentFloors = {},
): MeteoraPool[] {
  return rows
    .filter((row) => canAbsorbDeposit(row, floors))
    .sort((a, b) => (b.fee_tvl_ratio?.['24h'] ?? 0) - (a.fee_tvl_ratio?.['24h'] ?? 0))
    .slice(0, Math.max(0, k));
}

/** One daily candle. `high` and `low` are the fields that make this worth reading. */
export type MeteoraCandle = {
  timestamp: number;
  timestamp_str?: string;
  open?: number;
  high: number;
  low: number;
  close?: number;
  volume?: number;
};

export type MeteoraOhlcvResponse = {
  start_time?: number;
  end_time?: number;
  timeframe?: string;
  data?: MeteoraCandle[];
};

/**
 * Daily candles for one pool.
 *
 * No `start_time`/`end_time`, deliberately, and this is the one design decision
 * in the URL. The endpoint accepts an explicit window — but a window is a pair of
 * timestamps, timestamps are hashed into the fixture name, and a fixture keyed on
 * the minute it was recorded can never be replayed. (Passing them *empty*, as the
 * docs suggest, is a 400: "cannot parse integer from empty string".) With no
 * window the response is the last 10 daily candles, which covers the 7 days §7.4
 * asks for with room to spare.
 *
 * Two facts about the window, bisected live, for whoever does pass one:
 * `timeframe=24h` over 99 days returns 100 candles, and over 100 days returns
 * HTTP 200 with `data: []`. Not an error, not a partial response — the same silent
 * cap `/volume/history` has. Which is why an empty `data` is read here as
 * *unknown* and never as "no volatility": zero ranges would make `p_exit` zero,
 * the most flattering value in §7.4's inequality, from the least informative
 * response. Same shape as `current?.yourAprBps ?? 0` in
 * `docs/cross-chain-review.md` §2.3.
 */
export const ohlcvUrl = (poolId: string): string =>
  `${METEORA_BASE}/pools/${poolId}/ohlcv?timeframe=24h`;

/** Days of history the range model reads, per §7.4 and `rank`'s 7-day default hold. */
export const OHLCV_WINDOW_DAYS = 7;

export type RangeSource = (poolId: string) => Promise<MeteoraCandle[]>;

/**
 * The candles the range model will use: the last {@link OHLCV_WINDOW_DAYS}
 * *complete* days, oldest first.
 *
 * The newest candle is dropped because it is the day in progress — its high and
 * low span only the hours elapsed, so its range is short by construction, and a
 * short range is the flattering direction in both places these candles are used.
 * Dropped unconditionally rather than by comparing its timestamp to the clock:
 * a fixture recorded last week must slice to the same candles today, or replay
 * stops being replay.
 */
export const usableCandles = (candles: readonly MeteoraCandle[]): MeteoraCandle[] =>
  candles.slice(0, -1).slice(-OHLCV_WINDOW_DAYS);

/** What one OHLCV read contributes to a row. */
export type ObservedRanges = {
  /** Peak-to-trough range per day, bps — `p_exit`'s empirical input (§7.4). */
  daily24hRangesBps: number[];
  /** `R`, the half-width the 24h volume model spreads over. */
  bandBps: number;
};

/**
 * Turn candles into the two numbers the ranker needs, or into `null`.
 *
 * `null` — no ranges, no band — is the answer for an empty `data`, a response of
 * one candle, or candles too broken to measure. It leaves `daily24hRangesBps`
 * absent and the band on its {@link MODELLED_RANGE_FACTOR} fallback, which is
 * exactly today's behaviour. An empty *series* would be far worse than an absent
 * one: `estimateExitProbability` never sees it, `rank.ts` substitutes zero, and
 * the pool is scored as though drifting out of range were impossible.
 *
 * The band is the week's traversed band, not the median daily range, and that is
 * the substantive choice here. `resolveDeltaBps` evaluates these rows at δ = 500,
 * so a median daily range — 243–994bps across the eight live enriched pools —
 * lands at or under δ for six of them and `min(1, δ/R)` saturates at 1.0 again,
 * which is the defect this replaces, only now dressed in an observation. The
 * traversed band is the honest quantity at the horizon the position is actually
 * held for: `rank`'s `expectedHoldDays` defaults to 7, a range is not re-centred
 * at midnight, and the flow a fixed range misses over a week is set by how far
 * the price wandered, not by one day's swing. Diffusion agrees to within ~20% on
 * live data — `median × √7` reproduces the measured 7-day band on SOL-USDC
 * (707 vs 678bps) and on PUMP-USDC (2260 vs 2583bps) — so this is the same
 * number reached from observation instead of from a model.
 *
 * It can still reach 1.0, and only one way: a pair whose entire week fits inside
 * ±δ. At δ = 500 that means a hard-pegged pair, for which full capture is simply
 * true (§7.4 puts 80–95% of stable-pair volume within ±5bps). None of the eight
 * live pools reach it; the spread is 0.17–0.85.
 */
export function observedRangesFrom(candles: readonly MeteoraCandle[]): ObservedRanges | null {
  const usable = usableCandles(candles);
  const daily24hRangesBps = peakToTroughBps(usable);
  const bandBps = traversedBandBps(usable);
  if (daily24hRangesBps.length === 0 || bandBps === null) return null;
  return { daily24hRangesBps, bandBps };
}

/** The production {@link RangeSource}: one recorded, replayable GET per pool. */
export function createOhlcvRangeSource(options: { signal?: AbortSignal } = {}): RangeSource {
  return async (poolId) => {
    const body = await getJson<MeteoraOhlcvResponse>(ohlcvUrl(poolId), {
      namespace: 'meteora',
      signal: options.signal,
    });
    return body.data ?? [];
  };
}

export type EnrichOptions = {
  source: BinSource;
  /**
   * Candles for the volume band and the volatility series. Absent means no
   * observation — never a live fetch — so a caller that stubs `source` to stay
   * off the network stays off it.
   */
  ranges?: RangeSource;
  /** The raw API rows whose pools should be enriched. */
  rows: readonly MeteoraPool[];
  coverageBps?: number;
};

/**
 * Attach a real in-range denominator — and an observed volume band — to the pools
 * named in `options.rows`.
 *
 * Every failure lands in the same place — `activeTvlUsd: null`,
 * `activeTvlFidelity: 'unavailable'`, REST fields intact. The RPC dependency
 * can cost a venue its rankability; it must never cost it its row, and it must
 * never produce a zero denominator, which would divide into the scoring maths
 * as a measurement of an empty pool.
 *
 * The two reads are settled separately because they are independent and unequal.
 * The bins are the denominator — the expensive part, and the only reason a
 * Meteora row can be ranked at all — while the candles only sharpen `V_δ` and
 * `p_exit`, each of which has a defined fallback. So a dead OHLCV endpoint must
 * not cost a row its bins, and a dead RPC must not cost it its volatility series.
 */
export async function enrichWithBins(
  pools: readonly NormalizedPool[],
  options: EnrichOptions,
): Promise<NormalizedPool[]> {
  const coverageBps = options.coverageBps ?? DEFAULT_BIN_COVERAGE_BPS;
  const wanted = new Map(options.rows.map((r) => [r.address, r]));

  return Promise.all(
    pools.map(async (pool) => {
      const row = wanted.get(pool.poolId);
      if (!row) return pool;

      // Issued together, resolved independently: neither read waits on the other
      // and neither rejection reaches the other's result.
      const [reading, candles] = await Promise.all([
        options.source(pool.poolId, coverageBps).then(
          (r) => r,
          () => null,
        ),
        options.ranges
          ? options.ranges(pool.poolId).then(
              (c) => c,
              () => [] as MeteoraCandle[],
            )
          : Promise.resolve([] as MeteoraCandle[]),
      ]);
      const observed = observedRangesFrom(candles);

      /**
       * The observed half, applied to whatever the bin read leaves behind.
       *
       * With no observation this is the identity, so every path below degrades to
       * exactly what it did before the candles existed.
       */
      const withRanges = (p: NormalizedPool): NormalizedPool =>
        observed === null
          ? p
          : {
              ...p,
              // Observed band, modelled distribution — the label is still
              // `modelled-uniform-over-range` because only the width of the band
              // was measured, never where inside it the flow sat.
              priceHistogram: modelledPriceHistogram(p.volume24h, observed.bandBps),
              daily24hRangesBps: observed.daily24hRangesBps,
            };

      try {
        // A failed bin read costs the row its denominator and nothing else.
        if (reading === null) return withRanges(pool);

        // The cross-check: `bin_step` is published by the API and stored in the
        // account. If the decode is misaligned, offset 80 cannot agree by luck.
        if (pool.binStep !== undefined && reading.binStep !== pool.binStep) {
          return withRanges(pool);
        }

        const histogram = histogramFromBins(reading.bins, {
          activeId: reading.activeId,
          binStep: reading.binStep,
          decimalsX: row.token_x.decimals,
          decimalsY: row.token_y.decimals,
          priceX: row.token_x.price,
          priceY: row.token_y.price,
        });
        if (histogram.length === 0) return withRanges(pool);

        // Never narrower than one bin — see `coverageFor`.
        const declaredBps = coverageFor(reading.coveredBps, reading.binStep);
        const activeTvlUsd = activeTvlWithin(histogram, declaredBps);
        if (!(activeTvlUsd > 0)) return withRanges(pool);

        return withRanges({
          ...pool,
          activeTvlUsd,
          activeTvlDeltaBps: declaredBps,
          activeTvlFidelity: 'tick-level' as const,
          liquidityHistogram: histogram,
          // The fallback band only, for a pool whose candles did not arrive:
          // re-modelled against the width this row actually declares rather than
          // the default the REST pass assumed. `declaredBps` differs whenever
          // `coverageFor` widened it to a coarse `binStep` or the caller pinned
          // its own `coverageBps`, and a band at or below δ makes `V_δ` the whole
          // of 24h volume — see {@link MODELLED_RANGE_FACTOR}.
          priceHistogram: modelledPriceHistogram(pool.volume24h, modelledRangeFor(declaredBps)),
        });
      } catch {
        // Deliberately swallowed: a decode that throws on the way out of a
        // successful read degrades one venue's fidelity, it does not fail the
        // scan. `collectPools` catches anything worse.
        return withRanges(pool);
      }
    }),
  );
}

/** The production {@link BinSource}: two account reads and one filtered scan. */
export function createRpcBinSource(options: SolanaRpcOptions = {}): BinSource {
  return async (poolId, coverageBps) => {
    const [pairBytes] = await getMultipleAccounts([poolId], {
      ...options,
      // Six bytes out of 904 — a deliberate optimisation, so the decode comes
      // from `decodeLbPairSlice` rather than `decodeLbPair`, and both take their
      // offsets from the same two constants.
      dataSlice: LB_PAIR_SLICE,
    });
    if (!pairBytes) throw new Error(`no LbPair account for ${poolId}`);
    const { activeId, binStep } = decodeLbPairSlice(pairBytes);

    const covered = coverageFor(coverageBps, binStep);
    const reach = binsNeededFor(covered, binStep);
    const lo = arrayIndexOf(activeId - reach);
    const hi = arrayIndexOf(activeId + reach);

    // Checked before the gPA scan, which is the expensive call: a read this
    // adapter will not perform should cost nothing to refuse. Loud rather than
    // silent, and rather than quietly truncated — see MAX_BIN_ARRAYS_PER_POOL.
    const span = hi - lo + 1;
    if (span > MAX_BIN_ARRAYS_PER_POOL) {
      throw new RangeError(
        `±${covered}bp at binStep ${binStep} needs ${reach} bins either side of ${activeId}, spanning ${span} BinArray accounts for ${poolId} — over the ${MAX_BIN_ARRAYS_PER_POOL} this reader will fetch in one call`,
      );
    }

    const discovered = await discoverBinArrays(poolId, options);
    const needed = discovered.filter((a) => a.index >= lo && a.index <= hi);
    if (needed.length === 0) throw new Error(`no bin arrays in [${lo}, ${hi}] for ${poolId}`);

    const datas = await getMultipleAccounts(
      needed.map((a) => a.address),
      options,
    );

    // Both failures below used to `return`, skipping 70 bins each while
    // `coveredBps` went on declaring the full width — a partial denominator
    // published at `tick-level`, which is the flattering direction and the one
    // failure mode this adapter exists to avoid. Throwing hands the row to
    // `enrichWithBins`' catch, which degrades it to `unavailable`: a venue with
    // no denominator beats a venue with a fraction of one presented as whole.
    const bins: IdentifiedBin[] = [];
    datas.forEach((bytes, i) => {
      const want = needed[i]!;
      if (!bytes) {
        // `discoverBinArrays` has already proven via gPA that this account
        // exists, so a null on the follow-up read is a failed or raced read —
        // never zero liquidity.
        throw new Error(
          `bin array ${want.index} (${want.address}) of ${poolId} read back null after discovery listed it`,
        );
      }
      const arrayIndex = decodeBinArrayIndex(bytes);
      if (arrayIndex !== want.index) {
        // Discovery and the account body disagree about which array this is:
        // a decode inconsistency, the class `viewOf` argues must surface.
        throw new Error(
          `bin array ${want.address} of ${poolId} decodes index ${arrayIndex}, discovery said ${want.index}`,
        );
      }
      decodeBinArrayAmounts(bytes).forEach((amounts, slot) => {
        const binId = binIdOf(arrayIndex, slot);
        if (Math.abs(binId - activeId) <= reach) bins.push({ binId, ...amounts });
      });
    });

    return { activeId, binStep, bins, coveredBps: covered };
  };
}
