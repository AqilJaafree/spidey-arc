/**
 * Data normalization schema — spec §6.
 *
 * "The product is largely this table. Everything downstream depends on it
 * being right."
 *
 * Two deliberate departures from the shape printed in §6, both required to
 * honour §6's own rule that a venue which cannot supply a real in-range
 * denominator is "EXCLUDED from ranking, not approximated":
 *
 *  1. `activeTvlUsd` is `number | null`. The spec types it `number`, but a
 *     non-nullable field forces every adapter to invent a value — exactly the
 *     approximation the section forbids. `null` is how an adapter says "I
 *     cannot measure this", and the ranker excludes on it.
 *
 *  2. `activeTvlDeltaBps` and the optional `liquidityHistogram` are new.
 *     `activeTvlUsd` is meaningless without the range half-width it was
 *     measured over — a Meteora pool's "active" TVL at ±2bp and a Uniswap
 *     pool's at ±60bp are, once again, non-comparable denominators. Carrying
 *     the width makes the comparison checkable instead of assumed.
 */

import type { PriceHistogramBucket } from './math/dilution.js';

export type { PriceHistogramBucket };

/** One bucket of the liquidity-by-distance-from-peg distribution. */
export type LiquidityHistogramBucket = {
  /** Signed distance from current price, basis points. */
  bpsFromPeg: number;
  /** Liquidity sitting at this distance, USD. */
  liquidityUsd: number;
};

/**
 * CCTP domain ids for the chains this system routes between.
 *
 * Arc is 26, confirmed against Circle's published Arc addresses — not a low
 * number as the hub chain might suggest.
 */
export const CCTP_DOMAIN = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  solana: 5,
  base: 6,
  polygon: 7,
  arc: 26,
} as const;

/**
 * Arc testnet, verified directly against the chain rather than taken from
 * docs — several public sources get the decimals wrong.
 */
export const ARC_TESTNET = {
  chainId: 5042002,
  rpcUrl: 'https://rpc.testnet.arc.network',
  /** Blockscout-based, and it accepts `forge verify-contract`. */
  explorerUrl: 'https://testnet.arcscan.app',
  cctpDomain: 26,
  /**
   * The optional ERC-20 interface over the native USDC balance. Same money,
   * two interfaces, 1e12 apart: a live account reads 48,985,422,856,585,913,771
   * natively (18dp) and 48,985,422 through this contract (6dp). That is §7.7's
   * "documented common integration error" in one line.
   */
  usdcErc20: '0x3600000000000000000000000000000000000000',
  tokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  messageTransmitterV2: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
} as const;

export type ChainName = keyof typeof CCTP_DOMAIN | (string & {});

/**
 * How an adapter arrived at `activeTvlUsd`. §6 forbids approximating the
 * denominator, so the fidelity has to travel with the number rather than
 * being assumed by the consumer.
 */
export type ActiveTvlFidelity =
  /**
   * Real per-tick or per-bin liquidity, summed across the range. Valid at any
   * δ *within the width it was measured over*, which the adapter must state in
   * `activeTvlDeltaBps` — a per-bin series is only as wide as the bins actually
   * fetched, and the ranker refuses to read it wider. Meteora (constant-sum
   * bins) and a v3 subgraph's `liquidityNet` series.
   */
  | 'tick-level'
  /**
   * A single `L` at the current price. Exact only inside the current tick
   * interval, so the adapter must set `activeTvlDeltaBps` no wider than that
   * and let the ranker enforce it.
   */
  | 'current-tick-liquidity'
  /** No in-range denominator available. `activeTvlUsd` is null; exclude. */
  | 'unavailable';

export type NormalizedPool = {
  chain: ChainName;
  cctpDomain: number;
  dex: string;
  poolId: string;
  pair: [string, string];

  /** Static fee tier, basis points. */
  feeBps: number;
  /** Meteora DLMM: base + variable, so `feeBps` understates the real rate. */
  feeIsDynamic: boolean;
  /**
   * Realized rate, `fees24h / volume24h`, in basis points. `null` when there
   * was no volume to derive it from — the caller falls back to `feeBps`
   * rather than treating the absence as zero.
   */
  feeBpsObserved24h: number | null;

  /** Headline TVL — for the comparison column only. Never a denominator. */
  tvlUsd: number;
  /**
   * In-range liquidity, USD. THE denominator.
   * `null` means the venue could not supply it: exclude, do not approximate.
   */
  activeTvlUsd: number | null;
  /**
   * The range half-width the in-range liquidity was measured over, basis
   * points — for `activeTvlUsd`, and equally for `liquidityHistogram` when one
   * is supplied. It is the width the measurement is *trusted* to, not merely a
   * label: the ranker will not answer a question wider than this, because a
   * narrow total returned as a wide one understates `T_δ` and overstates the
   * depositor's yield. `null` here means an unusable denominator, histogram or
   * not.
   */
  activeTvlDeltaBps: number | null;
  /** How that number was obtained. Drives how far it can be trusted. */
  activeTvlFidelity: ActiveTvlFidelity;

  /** EVM CLMM tick spacing — also the venue's minimum range granularity, bps. */
  tickSpacing?: number;
  /** Meteora DLMM bin step, basis points — likewise a granularity floor. */
  binStep?: number;

  volume24h: number;
  volume7d: number | null;
  fees24h: number;
  fees7d: number | null;

  /** Fee-derived APY, as a fraction. */
  apyBase: number;
  /** Emissions APY, as a fraction. Scored separately and discounted (§7.6). */
  apyReward: number;

  /** 24h volume by distance from peg. Drives `V_δ` (§7.3). */
  priceHistogram: PriceHistogramBucket[];
  /**
   * Where that histogram came from. No public venue API publishes
   * volume-by-distance-from-peg, so most rows are modelled rather than
   * observed — and a modelled `V_δ` must be labelled, not passed off as
   * measured. See `modelledPriceHistogram` in @spidey/adapters for the
   * assumption behind 'modelled-uniform-over-range'.
   */
  priceHistogramSource: 'observed' | 'modelled-uniform-over-range' | 'none';
  /**
   * Liquidity by distance from peg. Drives `T_δ` at any δ up to the coverage
   * declared in `activeTvlDeltaBps`, which a producer of this field must set to
   * the width it really collected; past that the pool is excluded rather than
   * answered from bins that were never fetched. Bins holding nothing may be
   * omitted, so the outermost bucket is not the coverage — declare it.
   */
  liquidityHistogram?: LiquidityHistogramBucket[];
  /** Hourly fee APR, oldest first. 168 buckets = 7 days (§7.6). */
  hourlyFeeSeries: number[];
  /** Hourly volume, same buckets — the persistence weight input. */
  hourlyVolumeSeries?: number[];
  /** Lag-1 autocorrelation of hourly volume, if the adapter precomputed it. */
  volumeAutocorr: number | null;

  /** Peak-to-trough 24h price ranges, bps, one per day. Drives `p_exit` (§7.4). */
  daily24hRangesBps?: number[];

  /** Where this row came from, and when. Staleness is enforced on it (§10.2). */
  source: string;
  /** Unix milliseconds at which the underlying data was observed. */
  asOf: number;
};

/** Why a pool was excluded from, or demoted within, the ranking. */
export type PoolFlag =
  /** §6: no in-range denominator. Excluded. */
  | 'no-active-tvl'
  /** §10.2: source data older than the staleness threshold. Excluded. */
  | 'stale'
  /** §6: activeTvl measured at a width too far from the requested range. Excluded. */
  | 'range-width-mismatch'
  /** §7.3: your deposit materially moved the denominator. */
  | 'dilution'
  /** §7.6: mean/median gap says this is one whale, not a market. */
  | 'one-whale-volume'
  /** §7.5: the move costs more than the edge repays at this size. */
  | 'cost-exceeds-edge'
  /** §7.4: fee yield does not clear adverse selection plus cost. */
  | 'fails-entry-condition'
  /** §7.6: score leans on emissions rather than fees. */
  | 'emissions-dependent'
  /** `V_δ` came from a modelled volume distribution, not an observed one. */
  | 'modelled-volume-distribution'
  /** No hourly series available, so the §7.6 hygiene layer could not run. */
  | 'no-hygiene-series'
  /** `activeTvlUsd` is a single current-tick `L`, exact only in a narrow band. */
  | 'current-tick-liquidity-only';

export const FLAG_EXPLANATIONS: Record<PoolFlag, string> = {
  'no-active-tvl': 'Venue could not supply in-range liquidity; excluded rather than approximated.',
  stale: 'Source data is older than the staleness threshold; excluded rather than extrapolated.',
  'range-width-mismatch':
    'In-range liquidity was measured at a different range width than the one requested.',
  dilution: 'Your deposit is a large share of in-range liquidity, so your yield is well below the headline.',
  'one-whale-volume': 'Volume is dominated by a few trades; the mean is far above the median.',
  'cost-exceeds-edge': 'The APR gain does not repay the cost of moving at this position size.',
  'fails-entry-condition': 'Fee yield does not clear adverse selection plus entry cost.',
  'emissions-dependent': 'Most of the yield is emissions, which are discounted and decay.',
  'modelled-volume-distribution':
    'In-range volume is modelled from the observed price range, not measured per trade.',
  'no-hygiene-series':
    'No hourly history available, so this score is a point estimate without EWMA or spike filtering.',
  'current-tick-liquidity-only':
    'In-range liquidity is the current-tick value, exact only within a narrow band around the price.',
};
