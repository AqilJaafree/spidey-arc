/**
 * Daily price ranges for a Uniswap v3 pool, from GeckoTerminal.
 *
 * `uniswapV3` is RPC-only: the chain knows the denominator but has no price
 * history to offer. Its `observations` ring buffer holds ~3.4 days at ~26s
 * granularity, but it stores `tickCumulative`, so anything derived from it is a
 * TWAP — smoothed, and smoothing understates intraday range. That is the same
 * defect as Orca's close-to-close, measured at 1.4x to 39.6x understatement on
 * Meteora's candles, always in the flattering direction. So the range comes from
 * an OHLCV source instead, which publishes real high/low.
 *
 * What this closes: `estimateExitProbability` only runs on `daily24hRangesBps`,
 * and `uniswapV3` supplied none — so `p_exit` was 0 for every one of its rows,
 * the most flattering value available. It was the only venue with a real
 * denominator and no price history, which is precisely what `no-volatility-series`
 * was added to make visible.
 *
 * It also retires a proxy. `modelledFromSigma` bands the volume histogram on
 * DefiLlama's `sigma`, whose own comment concedes it is "a 30-day volatility of
 * the pool's APY series, not of its price". An observed band replaces a
 * quantity that was never the right one.
 *
 * # Orientation is not a label, it is a measurement
 *
 * GeckoTerminal's `base`/`quote` are **not** the pool's `token0`/`token1`, and
 * they are not consistent across pools of the same pair. Measured on Base:
 *
 *     WETH/USDC 0.05%   base USDC        quote WETH   -> quote is volatile
 *     WETH/USDC 0.3%    base WETH        quote USDC   -> quote is the STABLE
 *     cbBTC/USDC 0.05%  base cbBTC       quote USDC   -> quote is the STABLE
 *
 * So a fixed `token=quote` is wrong for two of those three, and asking for the
 * stable side yields its peg wobble — ~130bps of USDC drift standing in for
 * ETH's ~110-220bps of real movement, or for cbBTC's. Worse, the stable series
 * is sometimes the *larger* of the two (188bps against 68bps on one day), so
 * "take the bigger range" does not rescue it either. The side is therefore
 * chosen from the USD prices the pool endpoint reports, per pool, every time.
 */

import { getJson } from './http.js';
import { medianOf, peakToTroughBps, traversedBandBps } from './series.js';
import { isUsdLikeSymbol } from './types.js';

export const GECKOTERMINAL_BASE = 'https://api.geckoterminal.com/api/v2';

/**
 * How far a USD price may sit from 1 and still count as pegged.
 *
 * Generous on purpose: a depegged or thinly-quoted stable still behaves like the
 * pool's numéraire, and the cost of misreading it as the volatile side is taking
 * its peg drift as the pool's price range.
 */
const PEG_TOLERANCE = 0.05;

/** Which of GeckoTerminal's two series describes the pool's price movement. */
export type SeriesSide = 'base' | 'quote';

export type PoolSides = {
  baseUsd: number;
  quoteUsd: number;
  baseSymbol?: string;
  quoteSymbol?: string;
};

const looksPegged = (usd: number, symbol?: string): boolean =>
  (Number.isFinite(usd) && usd > 0 && Math.abs(usd - 1) <= PEG_TOLERANCE) ||
  (symbol !== undefined && isUsdLikeSymbol(symbol) && Number.isFinite(usd) && usd > 0 && usd < 2);

/**
 * The side whose USD series stands in for the pool's price, or `null` when
 * neither does.
 *
 * For a stable-paired pool the volatile token's USD price *is* the pool ratio to
 * within the peg, which is what makes this substitution sound. For a pool of two
 * volatile tokens it is not: the position's range is the ratio between them, and
 * either USD series would be a different quantity wearing the same units. That
 * case returns `null` so the row keeps `no-volatility-series` and is scored as
 * unmeasured, rather than being handed a number that looks like an answer.
 */
export function chooseSeriesSide(sides: PoolSides): SeriesSide | null {
  const basePegged = looksPegged(sides.baseUsd, sides.baseSymbol);
  const quotePegged = looksPegged(sides.quoteUsd, sides.quoteSymbol);

  if (basePegged && quotePegged) {
    // Stable/stable: both series are the same small real number, and peg drift
    // is the genuine risk of leaving a tight range. Either side answers.
    return 'base';
  }
  if (basePegged) return 'quote';
  if (quotePegged) return 'base';
  return null;
}

type GtPoolResponse = {
  data?: {
    attributes?: {
      name?: string;
      base_token_price_usd?: string | number | null;
      quote_token_price_usd?: string | number | null;
    };
  };
};

/** `[timestamp, open, high, low, close, volume]`, newest first. */
type GtOhlcvResponse = {
  data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
};

export const poolUrl = (network: string, pool: string): string =>
  `${GECKOTERMINAL_BASE}/networks/${network}/pools/${pool}`;

export const ohlcvUrl = (network: string, pool: string, side: SeriesSide, days: number): string =>
  `${GECKOTERMINAL_BASE}/networks/${network}/pools/${pool}/ohlcv/day?limit=${days}&token=${side}`;

const num = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? Number.NaN : typeof v === 'number' ? v : Number.parseFloat(v);

export type ObservedRanges = {
  /** Peak-to-trough per day, bps, newest first. Drives `p_exit` (§7.4). */
  daily24hRangesBps: number[];
  /** The whole window's traversed band, bps — the volume-histogram width. */
  bandBps: number;
  /** Which side the series came from, for the log. */
  side: SeriesSide;
};

/**
 * Daily ranges for one pool, or `null` when they cannot be had honestly.
 *
 * Two requests: the pool endpoint decides the orientation, the OHLCV endpoint
 * supplies the candles. The orientation read is not optional — see the header.
 */
export async function fetchObservedRanges(
  network: string,
  pool: string,
  options: { days?: number; signal?: AbortSignal } = {},
): Promise<ObservedRanges | null> {
  const days = options.days ?? 7;

  const info = await getJson<GtPoolResponse>(poolUrl(network, pool), {
    namespace: 'geckoterminal',
    signal: options.signal,
  });
  const attrs = info.data?.attributes;
  if (!attrs) return null;

  // "USDC / WETH 0.05%" — base first. Only used to let a known-stable symbol
  // confirm a price that is near 1 for the ordinary reason.
  const [baseSymbol, quoteSymbol] = (attrs.name ?? '').split('/').map((s) => s.trim().split(' ')[0]);

  const side = chooseSeriesSide({
    baseUsd: num(attrs.base_token_price_usd),
    quoteUsd: num(attrs.quote_token_price_usd),
    ...(baseSymbol ? { baseSymbol } : {}),
    ...(quoteSymbol ? { quoteSymbol } : {}),
  });
  if (side === null) return null;

  const ohlcv = await getJson<GtOhlcvResponse>(ohlcvUrl(network, pool, side, days), {
    namespace: 'geckoterminal',
    signal: options.signal,
  });
  const list = ohlcv.data?.attributes?.ohlcv_list ?? [];
  if (list.length === 0) return null;

  // The newest candle is the day in progress and is short by construction, which
  // is the flattering direction in both consumers. Dropped unconditionally
  // rather than by comparing to a clock, which would make a fixture replay drift.
  const closed = list.slice(1);
  const candles = closed.map(([, , high, low]) => ({ high, low }));
  const daily24hRangesBps = peakToTroughBps(candles);
  if (daily24hRangesBps.length === 0) return null;

  const band = traversedBandBps(candles);
  return {
    daily24hRangesBps,
    // Falls back to the median day when the window's own band is unusable, so a
    // degenerate series cannot put all the volume at the peg and claim full
    // capture.
    bandBps: band ?? (medianOf(daily24hRangesBps) ?? 0),
    side,
  };
}
