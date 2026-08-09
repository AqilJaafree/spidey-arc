import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rank } from '@spidey/core';
import {
  coverageFor,
  createMeteoraAdapter,
  DEFAULT_BIN_COVERAGE_BPS,
  enrichWithBins,
  meteoraAdapter,
  METEORA_BASE,
  normalizeMeteoraPool,
  poolsUrl,
  topKByFeeRatio,
  type BinSource,
  type MeteoraPool,
} from './meteora.js';

/** The live SOL-USDC row, trimmed to the fields the normalizer reads. */
const SOL_USDC: MeteoraPool = {
  address: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',
  name: 'SOL-USDC',
  token_x: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, price: 76.09391292839508 },
  token_y: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6, price: 0.9996090747612812 },
  token_x_amount: 36907.758705538,
  token_y_amount: 2205111.74202,
  pool_config: { bin_step: 4, base_fee_pct: 0.04, max_fee_pct: 0.0 },
  tvl: 5012455.729685891,
  current_price: 76.11690191885998,
  apr: 0.0815308264594511,
  apy: 34.644295865390305,
  farm_apy: 0,
  is_blacklisted: false,
  volume: { '24h': 10978897.743655115 },
  fees: { '24h': 4086.696582327018 },
};

const ok = (p: MeteoraPool) => {
  const r = normalizeMeteoraPool(p, 1_786_213_579_000);
  if ('skip' in r) throw new Error(`expected a pool, got skip: ${r.skip}`);
  return r;
};

describe('Meteora field mapping', () => {
  it('identifies itself as a Solana DLMM venue on CCTP domain 5', () => {
    const p = ok(SOL_USDC);
    expect(p.chain).toBe('solana');
    expect(p.cctpDomain).toBe(5);
    expect(p.dex).toBe('meteora-dlmm');
    expect(p.poolId).toBe(SOL_USDC.address);
    expect(p.pair).toEqual(['SOL', 'USDC']);
    expect(p.source).toBe('meteora-datapi');
  });

  it('takes binStep straight from pool_config — it is already bps', () => {
    expect(ok(SOL_USDC).binStep).toBe(4);
    expect(ok(SOL_USDC).tickSpacing).toBeUndefined();
  });

  it('converts base_fee_pct from percent to bps', () => {
    // 0.04% = 4bp. Raydium's feeRate is a fraction; this one is not.
    expect(ok(SOL_USDC).feeBps).toBeCloseTo(4, 9);
  });

  it('derives apyBase from apy, not from apr', () => {
    // `apr` is percent-per-DAY (it equals fee_tvl_ratio.24h). Using it would
    // understate fee yield by ~365x, so assert the magnitude, not just equality.
    expect(ok(SOL_USDC).apyBase).toBeCloseTo(0.34644295865390305, 12);
    expect(ok(SOL_USDC).apyBase).toBeGreaterThan(0.3);
    expect(ok(SOL_USDC).apyBase / (SOL_USDC.apr! / 100)).toBeGreaterThan(100);
  });

  it('reports the observed fee rate, and null rather than zero without volume', () => {
    expect(ok(SOL_USDC).feeBpsObserved24h).toBeCloseTo(3.7223, 3);
    expect(ok({ ...SOL_USDC, volume: { '24h': 0 }, fees: { '24h': 0 } }).feeBpsObserved24h).toBeNull();
  });

  it('supplies no in-range denominator in the REST-only path', () => {
    const p = ok(SOL_USDC);
    expect(p.activeTvlUsd).toBeNull();
    expect(p.activeTvlDeltaBps).toBeNull();
    expect(p.activeTvlFidelity).toBe('unavailable');
  });

  it('leaves the hygiene series empty rather than denominating it wrongly', () => {
    // Spec §7.2: a series on headline TVL would replace `yourApr` in rank.ts
    // and score this venue ~5.5x low for being more honest.
    expect(ok(SOL_USDC).hourlyFeeSeries).toEqual([]);
    expect(ok(SOL_USDC).hourlyVolumeSeries).toBeUndefined();
    expect(ok(SOL_USDC).volume7d).toBeNull();
    expect(ok(SOL_USDC).fees7d).toBeNull();
  });

  it('marks the fee dynamic only when the ceiling is above the base', () => {
    expect(ok(SOL_USDC).feeIsDynamic).toBe(false);
    expect(ok({ ...SOL_USDC, pool_config: { bin_step: 4, base_fee_pct: 0.04, max_fee_pct: 1.0 } }).feeIsDynamic).toBe(true);
  });

  it('converts farm_apy from percent to a fraction', () => {
    // Asserted on a farming pool on purpose: SOL-USDC emits nothing, and
    // `0 / 100 === 0`, so the fixture alone would pass with the division
    // dropped entirely.
    expect(ok({ ...SOL_USDC, farm_apy: 12.5 }).apyReward).toBeCloseTo(0.125, 12);
    expect(ok(SOL_USDC).apyReward).toBe(0);
  });

  it('labels the volume distribution as modelled, never as observed', () => {
    // §6 requires a modelled `V_δ` to travel with its label — an unlabelled
    // one is indistinguishable from a measured one downstream.
    const p = ok(SOL_USDC);
    expect(p.priceHistogramSource).toBe('modelled-uniform-over-range');
    expect(p.priceHistogram.length).toBeGreaterThan(0);
    expect(p.priceHistogram.reduce((sum, b) => sum + b.volumeUsd, 0)).toBeCloseTo(
      SOL_USDC.volume!['24h']!,
      3,
    );
  });

  it('stamps asOf from the injected clock rather than the wall clock', () => {
    // The clock is a parameter so captured fixtures replay identically;
    // reaching for Date.now() here would make every replay a fresh row.
    expect(ok(SOL_USDC).asOf).toBe(1_786_213_579_000);
  });
});

describe('Meteora pool rejection', () => {
  const skipOf = (p: MeteoraPool) => {
    const r = normalizeMeteoraPool(p, 1);
    if (!('skip' in r)) throw new Error('expected a skip');
    return r.skip;
  };

  it('skips blacklisted pools, saying so', () => {
    expect(skipOf({ ...SOL_USDC, is_blacklisted: true })).toMatch(/blacklist/i);
  });

  it('skips pools with no TVL', () => {
    expect(skipOf({ ...SOL_USDC, tvl: 0 })).toMatch(/tvl/i);
  });

  it('skips a pool with no bin_step rather than inventing a granularity', () => {
    expect(skipOf({ ...SOL_USDC, pool_config: { base_fee_pct: 0.04 } })).toMatch(/bin_step/);
  });
});

describe('the adapter surface', () => {
  it('declares the fidelity it can reach with bin data', () => {
    expect(meteoraAdapter.id).toBe('meteora');
    expect(meteoraAdapter.bestFidelity).toBe('tick-level');
  });

  it('builds a paged pools URL', () => {
    expect(poolsUrl(1, 200)).toBe(`${METEORA_BASE}/pools?page=1&page_size=200`);
  });

  it('keeps only pools with a USD-like leg, and honours the row cap', async () => {
    const rows: MeteoraPool[] = [
      SOL_USDC,
      { ...SOL_USDC, address: 'B', token_y: { ...SOL_USDC.token_y, symbol: 'BONK' }, token_x: { ...SOL_USDC.token_x, symbol: 'WIF' } },
      { ...SOL_USDC, address: 'C' },
    ];
    const adapter = createMeteoraAdapter({ fetchPools: async () => rows });
    const { pools } = await adapter.listPools({ symbols: ['USDC'], limit: 2, now: 1 });
    expect(pools.map((p) => p.poolId)).toEqual([SOL_USDC.address, 'C']);
  });

  it('falls back to the USD-like shape test when no symbols are asked for', async () => {
    // The default universe is §7.4's: without an explicit filter the adapter
    // still refuses a memecoin pair, so this path is not a pass-through.
    const rows: MeteoraPool[] = [
      { ...SOL_USDC, address: 'MEME', token_x: { ...SOL_USDC.token_x, symbol: 'WIF' }, token_y: { ...SOL_USDC.token_y, symbol: 'BONK' } },
      SOL_USDC,
    ];
    const adapter = createMeteoraAdapter({ fetchPools: async () => rows });
    const { pools } = await adapter.listPools({ now: 1 });
    expect(pools.map((p) => p.poolId)).toEqual([SOL_USDC.address]);
  });

  it('surfaces rejected pools instead of dropping them silently', async () => {
    const adapter = createMeteoraAdapter({
      fetchPools: async () => [{ ...SOL_USDC, address: 'DEAD', tvl: 0 }],
    });
    const { pools, skipped } = await adapter.listPools({ now: 1 });
    expect(pools).toHaveLength(0);
    expect(skipped).toEqual([{ poolId: 'DEAD', reason: 'no TVL' }]);
  });
});

/**
 * The whole recorded page through the real `getJson` path, offline.
 *
 * Every other test above injects rows through the `fetchPools` seam, so none of
 * them would notice the live endpoint moving again or the response shape
 * changing. This one replays `fixtures/meteora/` and fails with
 * `FixtureMissingError` if the capture is missing, which is the point.
 */
describe('replaying the recorded response', () => {
  // Process-wide, so put it back: `fetchMode()` reads the variable, not a
  // module-local, and a leaked 'fixture' would silently change how any later
  // test in this file resolves a URL.
  const previousMode = process.env.SPIDEY_FETCH_MODE;

  beforeAll(() => {
    process.env.SPIDEY_FETCH_MODE = 'fixture';
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.SPIDEY_FETCH_MODE;
    else process.env.SPIDEY_FETCH_MODE = previousMode;
  });

  it('normalizes the captured page without skipping everything', async () => {
    const { pools, skipped } = await meteoraAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    expect(pools.length).toBeGreaterThan(0);
    for (const p of pools) {
      expect(p.dex).toBe('meteora-dlmm');
      expect(p.binStep).toBeGreaterThan(0);
      expect(p.tvlUsd).toBeGreaterThan(0);
      expect(p.apyBase).toBeGreaterThanOrEqual(0);
      expect(p.activeTvlFidelity).toBe('unavailable');
    }
    // Rejections are reported, not hidden.
    for (const s of skipped) expect(s.reason).toBeTruthy();
  });
});

const withRatio = (address: string, ratio: number): MeteoraPool => ({
  ...SOL_USDC,
  address,
  fee_tvl_ratio: { '24h': ratio },
});

describe('choosing which pools get bin data', () => {
  it('takes the highest 24h fee/TVL ratio first', () => {
    const chosen = topKByFeeRatio([withRatio('a', 0.01), withRatio('b', 0.9), withRatio('c', 0.5)], 2);
    expect(chosen.map((p) => p.address)).toEqual(['b', 'c']);
  });

  it('never returns more than it was asked for', () => {
    expect(topKByFeeRatio([withRatio('a', 1)], 5)).toHaveLength(1);
    expect(topKByFeeRatio([withRatio('a', 1), withRatio('b', 2)], 0)).toHaveLength(0);
  });

  it('treats a missing ratio as the worst, not as the best', () => {
    const chosen = topKByFeeRatio([{ ...SOL_USDC, address: 'none', fee_tvl_ratio: {} }, withRatio('b', 0.1)], 1);
    expect(chosen.map((p) => p.address)).toEqual(['b']);
  });
});

describe('coverageFor', () => {
  it('never reports coverage narrower than one bin', () => {
    expect(coverageFor(500, 800)).toBe(800);
    expect(coverageFor(500, 4)).toBe(500);
  });
});

describe('enrichWithBins', () => {
  const base = () => {
    const r = normalizeMeteoraPool(SOL_USDC, 1);
    if ('skip' in r) throw new Error('fixture should normalize');
    return r;
  };

  /** One funded bin at the active id: 2 SOL plus 50 USDC at the fixture's prices. */
  const goodSource: BinSource = async () => ({
    activeId: 0,
    binStep: 4,
    bins: [{ binId: 0, amountX: 2n * 10n ** 9n, amountY: 50n * 10n ** 6n }],
    coveredBps: 500,
  });

  /** What `histogramFromBins` must value that bin at — constant-sum, no `L`. */
  const goodSourceUsd = 2 * SOL_USDC.token_x.price + 50 * SOL_USDC.token_y.price;

  it('lifts the row to tick-level with a histogram', async () => {
    const [p] = await enrichWithBins([base()], { source: goodSource, rows: [SOL_USDC] });
    expect(p!.activeTvlFidelity).toBe('tick-level');
    expect(p!.activeTvlUsd).toBeCloseTo(goodSourceUsd, 6);
    expect(p!.activeTvlDeltaBps).toBe(500);
    expect(p!.liquidityHistogram).toHaveLength(1);
  });

  it('asks the source for the default coverage when none is pinned', async () => {
    const seen: number[] = [];
    const spy: BinSource = async (id, cov) => {
      seen.push(cov);
      return goodSource(id, cov);
    };
    await enrichWithBins([base()], { source: spy, rows: [SOL_USDC] });
    expect(seen).toEqual([DEFAULT_BIN_COVERAGE_BPS]);
  });

  it('declares the width it actually covered, so rank.ts can refuse wider questions', async () => {
    const narrow: BinSource = async (id, cov) => ({ ...(await goodSource(id, cov)), coveredBps: 100 });
    const [p] = await enrichWithBins([base()], { source: narrow, rows: [SOL_USDC] });
    expect(p!.activeTvlDeltaBps).toBe(100);
  });

  it('degrades to unavailable when the RPC throws, keeping the REST row', async () => {
    const dead: BinSource = async () => {
      throw new Error('RPC down');
    };
    const [p] = await enrichWithBins([base()], { source: dead, rows: [SOL_USDC] });
    expect(p!.activeTvlUsd).toBeNull();
    expect(p!.activeTvlDeltaBps).toBeNull();
    expect(p!.activeTvlFidelity).toBe('unavailable');
    expect(p!.liquidityHistogram).toBeUndefined();
    // The row survives — losing rankability must not lose the comparison.
    expect(p!.tvlUsd).toBe(SOL_USDC.tvl);
    expect(p!.binStep).toBe(4);
  });

  it('refuses bin data when the decoded bin_step disagrees with the API', async () => {
    // A mismatch means the account decode is misaligned; a plausible-looking
    // number from the wrong offset is worse than no number.
    const wrong: BinSource = async (id, cov) => ({ ...(await goodSource(id, cov)), binStep: 25 });
    const [p] = await enrichWithBins([base()], { source: wrong, rows: [SOL_USDC] });
    expect(p!.activeTvlFidelity).toBe('unavailable');
    expect(p!.activeTvlUsd).toBeNull();
  });

  it('degrades rather than reporting a zero denominator for an unfunded range', async () => {
    const empty: BinSource = async (id, cov) => ({ ...(await goodSource(id, cov)), bins: [] });
    const [p] = await enrichWithBins([base()], { source: empty, rows: [SOL_USDC] });
    expect(p!.activeTvlUsd).toBeNull();
    expect(p!.activeTvlFidelity).toBe('unavailable');
  });

  it('never declares coverage narrower than one bin', async () => {
    // Otherwise `resolveDeltaBps` clamps δ up to binStep, overshoots the
    // declared width, and rank.ts excludes the pool — invisibly.
    const coarse: BinSource = async () => ({
      activeId: 0,
      binStep: 800,
      bins: [{ binId: 0, amountX: 0n, amountY: 100n * 10n ** 6n }],
      coveredBps: 500,
    });
    const row = { ...SOL_USDC, pool_config: { bin_step: 800, base_fee_pct: 0.04, max_fee_pct: 0 } };
    const normalized = normalizeMeteoraPool(row, 1);
    if ('skip' in normalized) throw new Error('fixture should normalize');
    const [p] = await enrichWithBins([normalized], { source: coarse, rows: [row] });
    expect(p!.activeTvlDeltaBps).toBe(800);
    expect(p!.activeTvlFidelity).toBe('tick-level');
  });

  it('leaves pools it was not given bin data for untouched', async () => {
    const other = { ...base(), poolId: 'OTHER' };
    const [p] = await enrichWithBins([other], { source: goodSource, rows: [] });
    expect(p!.activeTvlFidelity).toBe('unavailable');
  });

  it('does not let one failing pool deny the others their denominator', async () => {
    // Enrichment is per-pool, not all-or-nothing: a single dead account read
    // must not cost every other venue in the batch its rankability.
    const rows = [SOL_USDC, { ...SOL_USDC, address: 'BROKEN' }];
    const flaky: BinSource = async (poolId, cov) => {
      if (poolId === 'BROKEN') throw new Error('RPC down for this one');
      return goodSource(poolId, cov);
    };
    const pools = rows.map((row) => {
      const r = normalizeMeteoraPool(row, 1);
      if ('skip' in r) throw new Error('fixture should normalize');
      return r;
    });

    const enriched = await enrichWithBins(pools, { source: flaky, rows });
    expect(enriched.map((p) => p.activeTvlFidelity)).toEqual(['tick-level', 'unavailable']);
    expect(enriched[1]!.tvlUsd).toBe(SOL_USDC.tvl);
  });
});

/**
 * The end-to-end claim: an enriched row is actually rankable.
 *
 * Everything above asserts the shape of the row. Only `rank()` asserts that the
 * shape is the one `othersLiquidityInRange` accepts — and the coverage guard
 * there fails *silently*, by moving a pool into `excluded`, so nothing short of
 * running the ranker catches a δ that overshoots the declared width.
 */
describe('an enriched pool survives rank()', () => {
  const enrich = async (row: MeteoraPool, source: BinSource) => {
    const r = normalizeMeteoraPool(row, 1);
    if ('skip' in r) throw new Error('fixture should normalize');
    return enrichWithBins([r], { source, rows: [row] });
  };

  it('ranks a 4bp pool instead of excluding it on range width', async () => {
    const [pool] = await enrich(SOL_USDC, async () => ({
      activeId: 0,
      binStep: 4,
      bins: [{ binId: 0, amountX: 2n * 10n ** 9n, amountY: 50n * 10n ** 6n }],
      coveredBps: 500,
    }));

    const result = rank([pool!], { depositUsd: 1_000, now: 1 });
    expect(result.ranked.map((r) => r.poolId)).toEqual([SOL_USDC.address]);
    expect(result.excluded).toHaveLength(0);
    // Evaluated at the width the bins actually covered, not the 10bp default.
    expect(result.ranked[0]!.deltaBps).toBe(500);
  });

  it('ranks a pool whose bin is coarser than the coverage it asked for', async () => {
    // The failure `coverageFor` exists to prevent: δ clamps up to binStep 800,
    // and a row declaring 500 would be excluded on `range-width-mismatch`.
    const row = { ...SOL_USDC, pool_config: { bin_step: 800, base_fee_pct: 0.04, max_fee_pct: 0 } };
    const [pool] = await enrich(row, async () => ({
      activeId: 0,
      binStep: 800,
      bins: [{ binId: 0, amountX: 0n, amountY: 100_000n * 10n ** 6n }],
      coveredBps: 500,
    }));

    const result = rank([pool!], { depositUsd: 1_000, now: 1 });
    expect(result.excluded.flatMap((r) => r.flags)).not.toContain('range-width-mismatch');
    expect(result.ranked.map((r) => r.poolId)).toEqual([row.address]);
  });
});
