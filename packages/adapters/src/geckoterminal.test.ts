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
