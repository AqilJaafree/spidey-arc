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
import { modelledPriceHistogram } from './series.js';
import {
  discoverBinArrays,
  getMultipleAccounts,
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
 * Half-width for the modelled volume distribution, bps.
 *
 * Deliberately wide relative to a 4bp bin: `modelledPriceHistogram` spreads
 * volume uniformly, so a wider band puts *less* volume inside a tight δ. That
 * understates `V_δ`, which is the conservative direction. Using `binStep` here
 * would concentrate every trade at the peg and flatter the venue.
 */
const MODELLED_RANGE_BPS = 100;

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
    // that can answer `T_δ` at an arbitrary δ rather than one tick interval.
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

      const { topK = DEFAULT_TOP_K, coverageBps, rpcUrl, binSource, minTvlUsd, minVolume24hUsd } =
        options;
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
        // from the network, because this line still reaches a live RPC. A test
        // that wants no network must pass `topK: 0` or its own `binSource`.
        source: binSource ?? createRpcBinSource({ rpcUrl, signal: ctx.signal }),
        rows: chosen,
        coverageBps,
      });

      return { pools: enriched, skipped };
    },
  };
}

export const meteoraAdapter: VenueAdapter = createMeteoraAdapter();

/**
 * Half-width the bin reader aims to cover, bps.
 *
 * Wider than `DEFAULT_RANGE_DELTA_BPS` (10) and wider than anything the
 * planner pins, so the coverage guard in `othersLiquidityInRange` stays quiet
 * in normal operation while the fetch stays bounded: 122 bins either side at
 * `binStep = 4`, which spans at most five `BinArray` accounts.
 */
export const DEFAULT_BIN_COVERAGE_BPS = 500;

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
 * the vault's deposit. `$1M` TVL with `$100k` daily volume leaves 12 pools on a
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

export type EnrichOptions = {
  source: BinSource;
  /** The raw API rows whose pools should be enriched. */
  rows: readonly MeteoraPool[];
  coverageBps?: number;
};

/**
 * Attach a real in-range denominator to the pools named in `options.rows`.
 *
 * Every failure lands in the same place — `activeTvlUsd: null`,
 * `activeTvlFidelity: 'unavailable'`, REST fields intact. The RPC dependency
 * can cost a venue its rankability; it must never cost it its row, and it must
 * never produce a zero denominator, which would divide into the scoring maths
 * as a measurement of an empty pool.
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

      try {
        const reading = await options.source(pool.poolId, coverageBps);

        // The cross-check: `bin_step` is published by the API and stored in the
        // account. If the decode is misaligned, offset 80 cannot agree by luck.
        if (pool.binStep !== undefined && reading.binStep !== pool.binStep) {
          return pool;
        }

        const histogram = histogramFromBins(reading.bins, {
          activeId: reading.activeId,
          binStep: reading.binStep,
          decimalsX: row.token_x.decimals,
          decimalsY: row.token_y.decimals,
          priceX: row.token_x.price,
          priceY: row.token_y.price,
        });
        if (histogram.length === 0) return pool;

        // Never narrower than one bin — see `coverageFor`.
        const declaredBps = coverageFor(reading.coveredBps, reading.binStep);
        const activeTvlUsd = activeTvlWithin(histogram, declaredBps);
        if (!(activeTvlUsd > 0)) return pool;

        return {
          ...pool,
          activeTvlUsd,
          activeTvlDeltaBps: declaredBps,
          activeTvlFidelity: 'tick-level' as const,
          liquidityHistogram: histogram,
        };
      } catch {
        // Deliberately swallowed: a dead RPC degrades one venue's fidelity, it
        // does not fail the scan. `collectPools` catches anything worse.
        return pool;
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
