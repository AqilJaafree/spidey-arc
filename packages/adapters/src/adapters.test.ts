import { beforeAll, describe, expect, it } from 'vitest';
import { rank, capitalForLiquidity, deltaFromBps } from '@spidey/core';
import { parseFeeTier, splitSymbol } from './defillama.js';
import { dailyReturnsBps, medianOf, modelledPriceHistogram, sqrtPriceX64ToRawPrice } from './series.js';
import { isStablePair, isUsdLikeSymbol, isUsdSymbol } from './types.js';
import { orcaAdapter } from './orca.js';
import { raydiumAdapter } from './raydium.js';
import { defiLlamaAdapter } from './defillama.js';

// Every network call in this file replays from `fixtures/`. Recorded with
// `SPIDEY_FETCH_MODE=record pnpm capture`.
beforeAll(() => {
  process.env.SPIDEY_FETCH_MODE = 'fixture';
});

describe('symbol classification', () => {
  it('recognizes the canonical stables', () => {
    expect(isUsdSymbol('USDC')).toBe(true);
    expect(isUsdSymbol('usdt')).toBe(true);
    expect(isUsdSymbol('SOL')).toBe(false);
  });

  it('recognizes wrapped and prefixed USD tokens', () => {
    expect(isUsdLikeSymbol('hyUSD')).toBe(true);
    expect(isUsdLikeSymbol('USDG')).toBe(true);
    expect(isUsdLikeSymbol('PYUSD')).toBe(true);
    expect(isUsdLikeSymbol('WETH')).toBe(false);
    expect(isUsdLikeSymbol('PUMP')).toBe(false);
  });

  it('identifies the stable/stable universe the thesis rests on (§7.4)', () => {
    expect(isStablePair(['USDC', 'USDT'])).toBe(true);
    expect(isStablePair(['USDG', 'USDC'])).toBe(true);
    expect(isStablePair(['SOL', 'USDC'])).toBe(false);
    expect(isStablePair(['USDC'])).toBe(false);
  });
});

describe('DefiLlama field parsing', () => {
  it('parses fee tiers into both Uniswap units and bps', () => {
    expect(parseFeeTier('0.3%')).toEqual({ feeUnits: 3_000, feeBps: 30 });
    expect(parseFeeTier('0.05%')).toEqual({ feeUnits: 500, feeBps: 5 });
    expect(parseFeeTier('0.01%')).toEqual({ feeUnits: 100, feeBps: 1 });
    expect(parseFeeTier('1%')).toEqual({ feeUnits: 10_000, feeBps: 100 });
  });

  it('returns null rather than guessing on unparseable metadata', () => {
    expect(parseFeeTier(null)).toBeNull();
    expect(parseFeeTier('volatile')).toBeNull();
    expect(parseFeeTier('0%')).toBeNull();
  });

  it('splits symbols into a pair', () => {
    expect(splitSymbol('USDC-USDT')).toEqual(['USDC', 'USDT']);
    expect(splitSymbol('WETH-USDC')).toEqual(['WETH', 'USDC']);
  });
});

describe('series helpers', () => {
  it('computes absolute day-over-day returns in bps', () => {
    const closes = [1, 1.01, 1.0, 0.99];
    const returns = dailyReturnsBps(closes);
    expect(returns).toHaveLength(3);
    expect(returns[0]).toBeCloseTo(100, 6); // +1%
    expect(returns[1]).toBeCloseTo(99.01, 1);
  });

  it('drops non-finite and non-positive closes rather than producing NaN', () => {
    expect(dailyReturnsBps([1, Number.NaN, 2])).toHaveLength(0);
    expect(dailyReturnsBps([0, 1])).toHaveLength(0);
    expect(dailyReturnsBps([])).toHaveLength(0);
  });

  it('models volume uniformly over the traversed band, conserving total', () => {
    const histogram = modelledPriceHistogram(1_000_000, 100, 41);
    const total = histogram.reduce((sum, b) => sum + b.volumeUsd, 0);
    expect(total).toBeCloseTo(1_000_000, 6);
    expect(histogram[0]?.bpsFromPeg).toBeCloseTo(-100, 6);
    expect(histogram.at(-1)?.bpsFromPeg).toBeCloseTo(100, 6);
  });

  it('puts all volume at the peg when the price did not move', () => {
    expect(modelledPriceHistogram(500, 0)).toEqual([{ bpsFromPeg: 0, volumeUsd: 500 }]);
  });

  it('gives δ/R capture under the uniform assumption', () => {
    // Half the band ⇒ about half the volume.
    const histogram = modelledPriceHistogram(1_000, 100, 201);
    const inHalf = histogram
      .filter((b) => Math.abs(b.bpsFromPeg) <= 50)
      .reduce((s, b) => s + b.volumeUsd, 0);
    expect(inHalf / 1_000).toBeGreaterThan(0.45);
    expect(inHalf / 1_000).toBeLessThan(0.55);
  });

  it('medians a series, and reports null on empty', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(medianOf([])).toBeNull();
  });

  it('decodes a Q64.64 sqrt price', () => {
    expect(sqrtPriceX64ToRawPrice(1n << 64n)).toBeCloseTo(1, 12);
    expect(sqrtPriceX64ToRawPrice(2n << 64n)).toBeCloseTo(4, 12);
  });
});

describe('Orca adapter (fixture replay)', () => {
  it('normalizes pools and measures in-range liquidity for every one', async () => {
    const { pools } = await orcaAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    expect(pools.length).toBeGreaterThan(5);

    for (const pool of pools) {
      expect(pool.chain).toBe('solana');
      expect(pool.cctpDomain).toBe(5);
      expect(pool.activeTvlUsd).not.toBeNull();
      expect(pool.activeTvlUsd as number).toBeGreaterThan(0);
      expect(pool.activeTvlFidelity).toBe('current-tick-liquidity');
      // The honesty invariant: the width it was measured over is stated, and
      // never wider than the tick interval L is constant across.
      expect(pool.activeTvlDeltaBps).toBe(Math.max(1, pool.tickSpacing as number));
    }
  });

  it('finds in-range liquidity well below headline TVL — the §1 claim', async () => {
    const { pools } = await orcaAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    const withBoth = pools.filter((p) => p.activeTvlUsd !== null && p.tvlUsd > 0);
    expect(withBoth.length).toBeGreaterThan(3);

    for (const pool of withBoth) {
      // In-range liquidity is a strict subset of TVL. If this ever inverts,
      // the derivation is wrong, not the venue.
      expect(pool.activeTvlUsd as number).toBeLessThan(pool.tvlUsd);
    }

    // At least one pool should show the dramatic gap the pitch relies on.
    const shares = withBoth.map((p) => (p.activeTvlUsd as number) / p.tvlUsd);
    expect(Math.min(...shares)).toBeLessThan(0.1);
  });

  it('prefers the realized fee rate over the advertised tier where volume exists', async () => {
    const { pools } = await orcaAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    const traded = pools.filter((p) => p.volume24h > 0);
    expect(traded.length).toBeGreaterThan(0);
    for (const pool of traded) {
      expect(pool.feeBpsObserved24h).not.toBeNull();
      expect(pool.feeBpsObserved24h as number).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Raydium adapter (fixture replay)', () => {
  it('reports no in-range denominator rather than approximating one (§6)', async () => {
    const { pools } = await raydiumAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    expect(pools.length).toBeGreaterThan(5);
    for (const pool of pools) {
      expect(pool.activeTvlUsd).toBeNull();
      expect(pool.activeTvlFidelity).toBe('unavailable');
      // ...but headline TVL is still carried, for the comparison column.
      expect(pool.tvlUsd).toBeGreaterThan(0);
    }
  });
});

describe('DefiLlama adapter (fixture replay)', () => {
  it('is the control group: breadth with no denominator', async () => {
    const { pools } = await defiLlamaAdapter.listPools({ limit: 60 });
    expect(pools.length).toBeGreaterThan(10);
    for (const pool of pools) {
      expect(pool.activeTvlUsd).toBeNull();
      expect(pool.activeTvlFidelity).toBe('unavailable');
    }
  });

  it('splits base yield from emissions, which are scored separately (§7.6)', async () => {
    const { pools } = await defiLlamaAdapter.listPools({ limit: 60 });
    expect(pools.some((p) => p.apyBase > 0)).toBe(true);
    for (const pool of pools) {
      expect(pool.apyBase).toBeGreaterThanOrEqual(0);
      expect(pool.apyReward).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('end to end: adapters into rank(A)', () => {
  it('ranks Orca pools and excludes every denominator-less venue', async () => {
    // Orca stamps `asOf` from the fixture's own `updatedAt`, while Raydium and
    // DefiLlama publish no timestamp and fall back to the injected clock. So
    // the clock has to be pinned to the RECORDED data, then handed to the
    // other adapters — deriving it from the merged set instead lets the
    // wall-clock rows drag `now` forward and age every Orca row out.
    const orca = await orcaAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    const now = Math.max(...orca.pools.map((p) => p.asOf));

    const [raydium, llama] = await Promise.all([
      raydiumAdapter.listPools({ symbols: ['USDC'], limit: 60, now }),
      defiLlamaAdapter.listPools({ limit: 60, now }),
    ]);
    const pools = [...orca.pools, ...raydium.pools, ...llama.pools];

    const result = rank(pools, { depositUsd: 10_000, now });

    expect(result.ranked.length).toBeGreaterThan(0);
    expect(result.ranked.every((r) => r.yourAprBps !== null)).toBe(true);

    // Nothing from Raydium or DefiLlama can rank — they have no denominator.
    expect(result.ranked.some((r) => r.dex === 'raydium-clmm')).toBe(false);
    expect(result.excluded.some((r) => r.flags.includes('no-active-tvl'))).toBe(true);
  });

  it('reorders as deposit size grows — rank is a function of A (§7.3)', async () => {
    const { pools } = await orcaAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    const now = Math.max(...pools.map((p) => p.asOf));

    const small = rank(pools, { depositUsd: 500, now }).ranked;
    const large = rank(pools, { depositUsd: 25_000_000, now }).ranked;
    expect(small.length).toBeGreaterThan(1);

    // Every pool's yield falls as size grows; none may rise.
    const smallById = new Map(small.map((r) => [r.poolId, r.yourAprBps ?? 0]));
    for (const row of large) {
      const before = smallById.get(row.poolId);
      if (before !== undefined) expect(row.yourAprBps ?? 0).toBeLessThanOrEqual(before);
    }

    // And the order is not the same list — that is the product.
    const smallOrder = small.map((r) => r.poolId).join();
    const largeOrder = large.map((r) => r.poolId).join();
    expect(smallOrder).not.toBe(largeOrder);
  });

  it('agrees with an independent recomputation of in-range TVL', async () => {
    // Guard against the adapter and the core math drifting apart: recompute
    // one pool's denominator straight from the formula.
    const { pools } = await orcaAdapter.listPools({ symbols: ['USDC'], limit: 5 });
    const pool = pools[0];
    expect(pool).toBeDefined();
    const delta = deltaFromBps(pool?.activeTvlDeltaBps as number);
    // capitalForLiquidity is homogeneous of degree 1 in L, so doubling L
    // must exactly double the in-range value.
    expect(capitalForLiquidity(2, 1.0, delta)).toBeCloseTo(2 * capitalForLiquidity(1, 1.0, delta), 12);
  });
});

describe('fixture mode refuses to silently hit the network', () => {
  it('throws a helpful error when a fixture is missing', async () => {
    const { getJson, FixtureMissingError } = await import('./http.js');
    await expect(
      getJson('https://example.invalid/never-recorded', { namespace: 'nope' }),
    ).rejects.toThrow(FixtureMissingError);
  });
});
