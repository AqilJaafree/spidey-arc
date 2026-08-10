import { describe, expect, it } from 'vitest';
import { chooseSeriesSide, ohlcvUrl, poolUrl } from './geckoterminal.js';

describe('choosing which side is the price', () => {
  /**
   * The measured orientations that make this necessary. GeckoTerminal's
   * base/quote are not token0/token1 and are not consistent across pools of the
   * same pair, so a fixed `token=quote` is wrong more often than it is right.
   */
  it('reads WETH/USDC 0.05% as quote — base is the stable there', () => {
    expect(chooseSeriesSide({ baseUsd: 0.9986, quoteUsd: 1_915.54 })).toBe('quote');
  });

  it('reads WETH/USDC 0.3% as base — the same pair, oriented the other way', () => {
    expect(chooseSeriesSide({ baseUsd: 1_915.67, quoteUsd: 1.0 })).toBe('base');
  });

  it('reads cbBTC/USDC as base', () => {
    expect(chooseSeriesSide({ baseUsd: 64_771.55, quoteUsd: 1.0 })).toBe('base');
  });

  it('takes either side of a stable pair, where peg drift is the real risk', () => {
    expect(chooseSeriesSide({ baseUsd: 1.0, quoteUsd: 0.9997 })).toBe('base');
  });

  it('refuses a pool of two volatile tokens', () => {
    // The position's range is the ratio between them; neither USD series is that
    // quantity, and substituting one would be a different number in the same
    // units. `null` leaves the row flagged `no-volatility-series` instead.
    expect(chooseSeriesSide({ baseUsd: 1_915.54, quoteUsd: 64_771.55 })).toBeNull();
  });

  it('trusts a near-1 price even when the symbol is unknown', () => {
    expect(chooseSeriesSide({ baseUsd: 0.998, quoteUsd: 42.5 })).toBe('quote');
  });

  it('treats a mildly depegged stable as still the numéraire', () => {
    // A stable at 0.96 is still what the pool is priced in, and reading its drift
    // as the pool's range is the failure this avoids.
    expect(chooseSeriesSide({ baseUsd: 0.96, quoteUsd: 1_915.0, baseSymbol: 'USDC' })).toBe('quote');
  });

  it('uses a USD-like symbol to classify a badly quoted stable', () => {
    expect(chooseSeriesSide({ baseUsd: 1.4, quoteUsd: 1_915.0, baseSymbol: 'USDC' })).toBe('quote');
  });

  it('refuses rather than guessing when prices are missing', () => {
    expect(chooseSeriesSide({ baseUsd: Number.NaN, quoteUsd: Number.NaN })).toBeNull();
    expect(chooseSeriesSide({ baseUsd: 0, quoteUsd: 0 })).toBeNull();
  });
});

describe('urls', () => {
  const POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224';

  it('addresses a pool on a named network', () => {
    expect(poolUrl('base', POOL)).toBe(
      `https://api.geckoterminal.com/api/v2/networks/base/pools/${POOL}`,
    );
  });

  it('carries the chosen side, since the default one is wrong as often as not', () => {
    expect(ohlcvUrl('base', POOL, 'quote', 7)).toMatch(/ohlcv\/day\?limit=7&token=quote$/);
    expect(ohlcvUrl('base', POOL, 'base', 7)).toMatch(/token=base$/);
  });
});

import {
  cachedObservedRanges,
  createRangeCache,
  DEFAULT_RANGE_TTL_MS,
  ERROR_BACKOFF_MS,
  type ObservedRanges,
} from './geckoterminal.js';

const RANGES: ObservedRanges = { daily24hRangesBps: [168, 200], bandBps: 470, side: 'quote' };
const T0 = 1_786_000_000_000;

describe('daily candles get a daily-cadence cache', () => {
  /**
   * `PoolCache` holds pool state for 60s, which is right for a price and wrong by
   * four orders of magnitude for a series of *daily* candles. Refetching those
   * every minute is what made GeckoTerminal 429 on the third call of a burst; the
   * fix is the cadence, not a smaller pool cap.
   */
  it('fetches once and serves the rest of the TTL from memory', async () => {
    let calls = 0;
    const cache = createRangeCache();
    const fetcher = async () => {
      calls += 1;
      return RANGES;
    };
    const opts = { cache, fetcher, now: T0 };
    expect(await cachedObservedRanges('base', 'P', opts)).toEqual(RANGES);
    expect(await cachedObservedRanges('base', 'P', { ...opts, now: T0 + 60_000 })).toEqual(RANGES);
    expect(await cachedObservedRanges('base', 'P', { ...opts, now: T0 + DEFAULT_RANGE_TTL_MS - 1 })).toEqual(RANGES);
    expect(calls).toBe(1);
  });

  it('refetches once the TTL has passed', async () => {
    let calls = 0;
    const cache = createRangeCache();
    const fetcher = async () => {
      calls += 1;
      return RANGES;
    };
    await cachedObservedRanges('base', 'P', { cache, fetcher, now: T0 });
    await cachedObservedRanges('base', 'P', { cache, fetcher, now: T0 + DEFAULT_RANGE_TTL_MS });
    expect(calls).toBe(2);
  });

  it('keys by pool, not globally', async () => {
    let calls = 0;
    const cache = createRangeCache();
    const fetcher = async () => {
      calls += 1;
      return RANGES;
    };
    await cachedObservedRanges('base', 'A', { cache, fetcher, now: T0 });
    await cachedObservedRanges('base', 'B', { cache, fetcher, now: T0 });
    expect(calls).toBe(2);
  });

  it('caches a structural refusal for the full TTL', async () => {
    // A pool of two volatile tokens will still be two volatile tokens in an hour.
    // Retrying it every refresh spends the budget that the pools which *can* be
    // answered need.
    let calls = 0;
    const cache = createRangeCache();
    const fetcher = async () => {
      calls += 1;
      return null;
    };
    expect(await cachedObservedRanges('base', 'P', { cache, fetcher, now: T0 })).toBeNull();
    expect(await cachedObservedRanges('base', 'P', { cache, fetcher, now: T0 + 3_600_000 })).toBeNull();
    expect(calls).toBe(1);
  });

  it('retries a thrown error after a short backoff, not the full TTL', async () => {
    // A 429 is transient and a refusal is not, so they must not share a TTL:
    // one should recover in minutes, the other should not be asked again today.
    let calls = 0;
    const cache = createRangeCache();
    const fetcher = async () => {
      calls += 1;
      throw new Error('429 Too Many Requests');
    };
    expect(await cachedObservedRanges('base', 'P', { cache, fetcher, now: T0 })).toBeNull();
    await cachedObservedRanges('base', 'P', { cache, fetcher, now: T0 + ERROR_BACKOFF_MS - 1 });
    expect(calls).toBe(1);
    await cachedObservedRanges('base', 'P', { cache, fetcher, now: T0 + ERROR_BACKOFF_MS });
    expect(calls).toBe(2);
  });

  it('reports the error rather than throwing it at the caller', async () => {
    const seen: string[] = [];
    const cache = createRangeCache();
    await cachedObservedRanges('base', 'P', {
      cache,
      now: T0,
      fetcher: async () => {
        throw new Error('429 Too Many Requests');
      },
      onError: (reason) => seen.push(reason),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/429/);
  });

  it('collapses concurrent callers into one fetch', async () => {
    // The whole point is fewer upstream calls; two rows asking at once must not
    // double them.
    let calls = 0;
    const cache = createRangeCache();
    const fetcher = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return RANGES;
    };
    const opts = { cache, fetcher, now: T0 };
    const [a, b] = await Promise.all([
      cachedObservedRanges('base', 'P', opts),
      cachedObservedRanges('base', 'P', opts),
    ]);
    expect(a).toEqual(RANGES);
    expect(b).toEqual(RANGES);
    expect(calls).toBe(1);
  });
});
