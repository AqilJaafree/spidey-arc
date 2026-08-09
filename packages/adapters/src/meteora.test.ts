import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rank, RANGE_WIDTH_TOLERANCE } from '@spidey/core';
import {
  canAbsorbDeposit,
  coverageFor,
  createMeteoraAdapter,
  createRpcBinSource,
  DEFAULT_BIN_COVERAGE_BPS,
  DEFAULT_MIN_TVL_USD,
  DEFAULT_MIN_VOLUME_24H_USD,
  enrichWithBins,
  meteoraAdapter,
  METEORA_BASE,
  MODELLED_RANGE_FACTOR,
  modelledRangeFor,
  normalizeMeteoraPool,
  poolsUrl,
  topKByFeeRatio,
  type BinSource,
  type MeteoraPool,
} from './meteora.js';
import { activeTvlWithin } from './meteoraBins.js';

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
    // `topK: 0` here and below: `fetchPools` only stubs the REST half, so a
    // filtering test left on the default topK would reach for a live RPC.
    const adapter = createMeteoraAdapter({ fetchPools: async () => rows, topK: 0 });
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
    const adapter = createMeteoraAdapter({ fetchPools: async () => rows, topK: 0 });
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
    // `topK: 0` keeps this about the REST mapping alone. The default adapter now
    // enriches its busiest rows to `tick-level`, and asserting `unavailable`
    // across the page would turn this into a test of the bin reader — which the
    // conformance suite below owns.
    const adapter = createMeteoraAdapter({ topK: 0 });
    const { pools, skipped } = await adapter.listPools({ symbols: ['USDC'], limit: 60 });
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

  /**
   * The dust bug, as a regression test.
   *
   * `fee_tvl_ratio` divides fees by TVL, so a pool with pennies of TVL scores
   * orders of magnitude above a real one — measured live, sub-dollar pools score
   * up to 2.7e9 against SOL-USDC's 0.068. Ranking on it alone hands the whole
   * enrichment budget to pools that cannot absorb a deposit, and leaves the
   * venue's real pools permanently without a denominator and so permanently
   * unrankable. Remove the floors from `topKByFeeRatio` and this test fails with
   * `expected [ 'DUST' ] to deeply equal [ 'REAL' ]`.
   */
  it('lets a substantial pool beat a dust pool with an absurd ratio', () => {
    const dust: MeteoraPool = {
      ...SOL_USDC,
      address: 'DUST',
      tvl: 0.42,
      volume: { '24h': 196_272 },
      fee_tvl_ratio: { '24h': 135_161_916 },
    };
    const real: MeteoraPool = {
      ...SOL_USDC,
      address: 'REAL',
      tvl: 5_057_683,
      volume: { '24h': 9_352_079 },
      fee_tvl_ratio: { '24h': 0.0684 },
    };

    expect(topKByFeeRatio([dust, real], 1).map((p) => p.address)).toEqual(['REAL']);
    // And the dust pool is not merely outranked, it is ineligible: it never
    // wins even when it is the only candidate.
    expect(topKByFeeRatio([dust], 8)).toHaveLength(0);
    expect(canAbsorbDeposit(dust)).toBe(false);
    expect(canAbsorbDeposit(real)).toBe(true);
  });

  it('rations on volume as well as TVL', () => {
    // A large but idle pool earns nothing to measure a share of. Both floors
    // have to bite, or a stale $5M pool displaces a working one.
    const idle = { ...withRatio('IDLE', 9), volume: { '24h': 500 } };
    expect(topKByFeeRatio([idle], 8)).toHaveLength(0);
    expect(canAbsorbDeposit(idle)).toBe(false);
  });

  it('honours floors a caller lowers deliberately', () => {
    const small = { ...withRatio('SMALL', 9), tvl: 50_000, volume: { '24h': 20_000 } };
    expect(topKByFeeRatio([small], 8)).toHaveLength(0);
    expect(
      topKByFeeRatio([small], 8, { minTvlUsd: 10_000, minVolume24hUsd: 1_000 }).map((p) => p.address),
    ).toEqual(['SMALL']);
  });

  it('defaults to the same floors as the EVM adapter', () => {
    expect(DEFAULT_MIN_TVL_USD).toBe(1_000_000);
    expect(DEFAULT_MIN_VOLUME_24H_USD).toBe(100_000);
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

  /**
   * The one-legged denominator, end to end.
   *
   * The recorded page carries XMR-USDT with `token_x.price: 0`; it holds $18, so
   * the floors keep it away from the RPC today. The shape is what matters, and
   * nothing in the code depends on the size: this row is the same shape scaled
   * up — a large unpriced X leg beside a priced Y leg, `tvl` reported off the
   * priced side, comfortably past every floor. Valuing the bin on Y alone gives
   * $2,000 against $102,000 of actual bin contents, a denominator 51x too small,
   * published at `tick-level` with full declared coverage.
   */
  it('degrades a pool with an unpriced leg instead of halving its denominator', async () => {
    const unpriced: MeteoraPool = {
      ...SOL_USDC,
      address: 'XMR-LIKE',
      token_x: { address: 'x', symbol: 'XMR', decimals: 6, price: 0 },
      token_y: { address: 'y', symbol: 'USDT', decimals: 6, price: 0.9989711407754004 },
      tvl: 4_000_000,
    };
    const normalized = normalizeMeteoraPool(unpriced, 1);
    if ('skip' in normalized) throw new Error('fixture should normalize');

    const oneLegged: BinSource = async () => ({
      activeId: 0,
      binStep: 4,
      // 500 XMR at ~$200 plus 2,000 USDT: $102,000 of bin, $2,000 of it priced.
      bins: [{ binId: 0, amountX: 500n * 10n ** 6n, amountY: 2_000n * 10n ** 6n }],
      coveredBps: 500,
    });

    const [p] = await enrichWithBins([normalized], { source: oneLegged, rows: [unpriced] });
    expect(p!.activeTvlFidelity).toBe('unavailable');
    expect(p!.activeTvlUsd).toBeNull();
    expect(p!.activeTvlDeltaBps).toBeNull();
    expect(p!.liquidityHistogram).toBeUndefined();
    // The row survives at REST fidelity, as every other enrichment failure does.
    expect(p!.tvlUsd).toBe(4_000_000);
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
 * `V_δ` must not come out maximally optimistic at the δ this adapter pins.
 *
 * The band was a flat 100bp while enriched rows declare 500, so
 * `resolveDeltaBps` evaluated them at 500, `volumeInRange` summed every bucket,
 * and `V_δ` was 100% of 24h volume for every enriched pool — the least
 * conservative value available, reported to the user as a measurement.
 */
describe('the modelled volume band stays wider than the declared coverage', () => {
  it('is wider by the factor rank.ts calls the limit of comparability', () => {
    expect(MODELLED_RANGE_FACTOR).toBe(RANGE_WIDTH_TOLERANCE);
    expect(modelledRangeFor(500)).toBe(1_000);
    expect(modelledRangeFor(500)).toBeGreaterThan(500);
    expect(modelledRangeFor(800)).toBeGreaterThan(800);
  });

  const capture = async (row: MeteoraPool, source: BinSource) => {
    const r = normalizeMeteoraPool(row, 1);
    if ('skip' in r) throw new Error('fixture should normalize');
    const [pool] = await enrichWithBins([r], { source, rows: [row] });
    const result = rank([pool!], { depositUsd: 1_000, now: 1 });
    expect(result.excluded).toHaveLength(0);
    return result.ranked[0]!;
  };

  it('leaves capture a real fraction rather than saturating at 1', async () => {
    const row = await capture(SOL_USDC, async () => ({
      activeId: 0,
      binStep: 4,
      bins: [{ binId: 0, amountX: 2n * 10n ** 9n, amountY: 50n * 10n ** 6n }],
      coveredBps: 500,
    }));

    expect(row.deltaBps).toBe(500);
    expect(row.volumeCapture).not.toBeNull();
    expect(row.volumeCapture!).toBeLessThan(1);
    expect(row.volumeCapture!).toBeCloseTo(0.5122, 3);
    // And the user-facing sentence stops reporting a modelled 100% as though it
    // were measured. That string is `explain()`'s `> 0.8` branch.
    expect(row.reason).not.toMatch(/Captures 100% of 24h volume/);
  });

  it('re-models against the width the read declared, not the default', async () => {
    // `coverageFor` widens the declared width to a coarse `binStep`, so a row
    // can end up declaring 800 after being modelled at the 500 default. A band
    // fixed at 2x500 would saturate again at δ = 800.
    const coarse = { ...SOL_USDC, pool_config: { bin_step: 800, base_fee_pct: 0.04, max_fee_pct: 0 } };
    const row = await capture(coarse, async () => ({
      activeId: 0,
      binStep: 800,
      bins: [{ binId: 0, amountX: 0n, amountY: 100_000n * 10n ** 6n }],
      coveredBps: 500,
    }));

    expect(row.deltaBps).toBe(800);
    expect(row.volumeCapture!).toBeLessThan(1);
    expect(row.volumeCapture!).toBeCloseTo(0.5122, 3);
  });

  it('keeps the whole of 24h volume in the histogram, only spread wider', async () => {
    // Widening the band must not lose volume — it redistributes it. Otherwise
    // this would be a silent haircut on the numerator rather than a model of
    // where the flow sat.
    const [p] = await enrichWithBins([ok(SOL_USDC)], {
      source: async () => ({
        activeId: 0,
        binStep: 4,
        bins: [{ binId: 0, amountX: 0n, amountY: 10n ** 6n }],
        coveredBps: 500,
      }),
      rows: [SOL_USDC],
    });
    expect(p!.priceHistogram.reduce((sum, b) => sum + b.volumeUsd, 0)).toBeCloseTo(
      SOL_USDC.volume!['24h']!,
      3,
    );
    expect(p!.priceHistogramSource).toBe('modelled-uniform-over-range');
    expect(Math.max(...p!.priceHistogram.map((b) => b.bpsFromPeg))).toBe(1_000);
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

describe('listPools enrichment', () => {
  it('enriches only the top K by fee ratio, leaving the rest at unavailable', async () => {
    const rows = [withRatio('low', 0.001), withRatio('high', 0.9)];
    const adapter = createMeteoraAdapter({
      fetchPools: async () => rows,
      topK: 1,
      binSource: async () => ({
        activeId: 0,
        binStep: 4,
        bins: [{ binId: 0, amountX: 0n, amountY: 100n * 10n ** 6n }],
        coveredBps: 500,
      }),
    });
    const { pools } = await adapter.listPools({ symbols: ['USDC'], now: 1 });
    const byId = new Map(pools.map((p) => [p.poolId, p]));
    expect(byId.get('high')!.activeTvlFidelity).toBe('tick-level');
    expect(byId.get('low')!.activeTvlFidelity).toBe('unavailable');
  });

  it('makes no RPC calls when topK is 0', async () => {
    let called = 0;
    const adapter = createMeteoraAdapter({
      fetchPools: async () => [SOL_USDC],
      topK: 0,
      binSource: async () => {
        called += 1;
        throw new Error('should not be called');
      },
    });
    const { pools } = await adapter.listPools({ symbols: ['USDC'], now: 1 });
    expect(called).toBe(0);
    expect(pools[0]!.activeTvlFidelity).toBe('unavailable');
  });

  it('never spends the budget on a pool normalization skipped', async () => {
    // The `kept` filter. A skipped row keeps its raw fee ratio, so ranking the
    // raw page would hand the top slot to a pool that has no output row — the
    // RPC call would be paid for and then discarded, and on a page where the
    // skipped rows are the busiest, every request would be wasted.
    const asked: string[] = [];
    const adapter = createMeteoraAdapter({
      // DEAD is skipped for a missing `bin_step` rather than for no TVL, so it
      // clears the enrichment floors comfortably. Otherwise the floors would
      // exclude it too and this would stop testing the `kept` filter at all.
      fetchPools: async () => [
        withRatio('GOOD', 0.1),
        { ...withRatio('DEAD', 0.9), pool_config: { base_fee_pct: 0.04 } },
      ],
      topK: 1,
      binSource: async (poolId) => {
        asked.push(poolId);
        return {
          activeId: 0,
          binStep: 4,
          bins: [{ binId: 0, amountX: 0n, amountY: 100n * 10n ** 6n }],
          coveredBps: 500,
        };
      },
    });

    const { pools, skipped } = await adapter.listPools({ symbols: ['USDC'], now: 1 });
    expect(asked).toEqual(['GOOD']);
    expect(skipped.map((s) => s.poolId)).toEqual(['DEAD']);
    expect(pools[0]!.activeTvlFidelity).toBe('tick-level');
  });

  it('rations the denominator without narrowing the listing', async () => {
    // The floors gate the RPC, not the rows. A small pool stays listed with its
    // REST fields intact and `unavailable` fidelity — that is the comparison
    // column the product argues about, and losing it would be a different and
    // unwanted change.
    const asked: string[] = [];
    const small: MeteoraPool = {
      ...withRatio('SMALL', 999),
      tvl: 5_218,
      volume: { '24h': 53_096 },
    };
    const adapter = createMeteoraAdapter({
      fetchPools: async () => [small, withRatio('BIG', 0.05)],
      binSource: async (poolId) => {
        asked.push(poolId);
        return {
          activeId: 0,
          binStep: 4,
          bins: [{ binId: 0, amountX: 0n, amountY: 100n * 10n ** 6n }],
          coveredBps: 500,
        };
      },
    });

    const { pools, skipped } = await adapter.listPools({ symbols: ['USDC'], now: 1 });
    // Listed, both of them, despite the ratio ordering putting SMALL first.
    expect(pools.map((p) => p.poolId)).toEqual(['SMALL', 'BIG']);
    expect(skipped).toHaveLength(0);
    expect(asked).toEqual(['BIG']);

    const byId = new Map(pools.map((p) => [p.poolId, p]));
    const sub = byId.get('SMALL')!;
    expect(sub.activeTvlFidelity).toBe('unavailable');
    expect(sub.activeTvlUsd).toBeNull();
    // Not a stub of a row: the REST fields a comparison needs are all there.
    expect(sub.tvlUsd).toBe(5_218);
    expect(sub.volume24h).toBe(53_096);
    expect(sub.binStep).toBe(4);
    expect(sub.apyBase).toBeGreaterThan(0);
    expect(byId.get('BIG')!.activeTvlFidelity).toBe('tick-level');
  });
});

/**
 * `createRpcBinSource`'s failure paths, through the RPC transport seam.
 *
 * The recorded-chain-state suite below only ever exercises the happy path — a
 * fixture cannot be recorded for a response the network will not produce on
 * demand, and "the account gPA just listed reads back null" is exactly such a
 * response. Both paths used to `return` and drop 70 bins silently while
 * `coveredBps` declared the full width.
 */
describe('createRpcBinSource refuses a partial read', () => {
  const POOL = 'POOL';

  /** The six bytes the production `dataSlice` asks for: active_id, then bin_step. */
  const lbPairSlice = (activeId: number, binStep: number): string => {
    const buf = Buffer.alloc(6);
    buf.writeInt32LE(activeId, 0);
    buf.writeUInt16LE(binStep, 4);
    return buf.toString('base64');
  };

  /** The eight bytes gPA's `dataSlice` returns: `BinArray.index`. */
  const indexSlice = (index: bigint): string => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(index);
    return buf.toString('base64');
  };

  /** A whole `BinArray` account, one funded bin in slot 0. */
  const binArrayAccount = (index: bigint, amountY: bigint): string => {
    const buf = Buffer.alloc(10_136);
    buf.writeBigInt64LE(index, 8);
    buf.writeBigUInt64LE(0n, 56);
    buf.writeBigUInt64LE(amountY, 64);
    return buf.toString('base64');
  };

  const account = (data: string) => ({ data: [data, 'base64'], owner: 'owner' });

  /**
   * activeId 0 at a 4bp step, so `reach` is 129 and the needed array range is
   * [-2, 1]; discovery offers only array 0, which holds bins 0..69.
   */
  const scripted = (arrayRead: unknown) => async (_url: string, body: unknown): Promise<unknown> => {
    const { method, params } = body as { method: string; params: unknown[] };
    if (method === 'getProgramAccounts') {
      return { result: [{ pubkey: 'ARRAY', account: { data: [indexSlice(0n), 'base64'] } }] };
    }
    const addresses = params[0] as string[];
    if (addresses[0] === POOL) {
      return { result: { value: [account(lbPairSlice(0, 4))] } };
    }
    return arrayRead;
  };

  it('reads bins when discovery and the account agree', async () => {
    // The control. Without it the two rejections below would pass against a
    // source that never reads anything at all.
    const source = createRpcBinSource({
      transport: scripted({ result: { value: [account(binArrayAccount(0n, 100n * 10n ** 6n))] } }),
    });
    const reading = await source(POOL, 500);
    expect(reading.activeId).toBe(0);
    expect(reading.binStep).toBe(4);
    expect(reading.coveredBps).toBe(500);
    // 70 bins in array 0, all inside reach 129 of activeId 0.
    expect(reading.bins).toHaveLength(70);
    expect(reading.bins[0]).toEqual({ binId: 0, amountX: 0n, amountY: 100n * 10n ** 6n });
  });

  it('throws when an account discovery listed reads back null', async () => {
    const source = createRpcBinSource({ transport: scripted({ result: { value: [null] } }) });
    await expect(source(POOL, 500)).rejects.toThrow(/bin array 0 \(ARRAY\) of POOL read back null/);
  });

  it('throws when the decoded array index disagrees with discovery', async () => {
    const source = createRpcBinSource({
      transport: scripted({ result: { value: [account(binArrayAccount(7n, 1n))] } }),
    });
    await expect(source(POOL, 500)).rejects.toThrow(/decodes index 7, discovery said 0/);
  });

  it('degrades the row rather than publishing 70 bins short of the declared width', async () => {
    // The consequence, stated where it is visible: `enrichWithBins` catches the
    // throw, so the row loses its denominator instead of declaring ±500bp over
    // a fraction of the bins.
    const normalized = normalizeMeteoraPool(SOL_USDC, 1);
    if ('skip' in normalized) throw new Error('fixture should normalize');
    const source = createRpcBinSource({ transport: scripted({ result: { value: [null] } }) });

    const [p] = await enrichWithBins([{ ...normalized, poolId: POOL }], {
      source,
      rows: [{ ...SOL_USDC, address: POOL }],
    });
    expect(p!.activeTvlFidelity).toBe('unavailable');
    expect(p!.activeTvlUsd).toBeNull();
    expect(p!.activeTvlDeltaBps).toBeNull();
  });

  it('throws when no discovered array falls inside the needed range', async () => {
    const empty = async (_url: string, body: unknown): Promise<unknown> => {
      const { method, params } = body as { method: string; params: unknown[] };
      if (method === 'getProgramAccounts') return { result: [] };
      return { result: { value: [account(lbPairSlice(0, 4))] } };
    };
    await expect(createRpcBinSource({ transport: empty })(POOL, 500)).rejects.toThrow(
      /no bin arrays in \[-2, 1\] for POOL/,
    );
  });
});

/**
 * The bin reader against real recorded chain state.
 *
 * `createRpcBinSource` has no other coverage: every test above injects a
 * `BinSource`, so the account slicing, the gPA discovery filters and the
 * index-agreement check are only ever exercised here, through `postJson` and
 * the recorded `fixtures/meteora-rpc/` payloads.
 *
 * The context must stay `{ symbols: ['USDC'], limit: 60 }` — the same one the
 * capture ran with. A different limit or symbol set changes which pools survive
 * the filter, which changes the top-K, which asks for bin data nobody recorded.
 */
describe('bin data against the recorded chain state', () => {
  const previousMode = process.env.SPIDEY_FETCH_MODE;

  beforeAll(() => {
    process.env.SPIDEY_FETCH_MODE = 'fixture';
  });

  afterAll(() => {
    if (previousMode === undefined) delete process.env.SPIDEY_FETCH_MODE;
    else process.env.SPIDEY_FETCH_MODE = previousMode;
  });

  it('produces an in-range denominator well below headline TVL', async () => {
    const { pools } = await meteoraAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    const tickLevel = pools.filter((p) => p.activeTvlFidelity === 'tick-level');
    expect(tickLevel.length).toBeGreaterThan(0);

    for (const p of tickLevel) {
      expect(p.activeTvlUsd).not.toBeNull();
      expect(p.activeTvlUsd!).toBeGreaterThan(0);
      expect(p.activeTvlUsd!).toBeLessThan(p.tvlUsd);
      expect(p.liquidityHistogram!.length).toBeGreaterThan(0);
      expect(p.activeTvlDeltaBps!).toBeGreaterThanOrEqual(p.binStep!);
    }
  });

  it('concentrates liquidity monotonically towards the peg', async () => {
    // The concentration thesis, as the only form of it that is shape-agnostic.
    // A per-pool percentage band is not assertable: the same code measured 56%
    // of headline TVL within ±500bps on the reference pool and single digits on
    // a wide-binned one, so a band would encode one pool's shape as a rule.
    // Monotonicity holds for every histogram whatever its shape.
    const { pools } = await meteoraAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    const tickLevel = pools.filter((p) => p.activeTvlFidelity === 'tick-level');
    expect(tickLevel.length).toBeGreaterThan(0);

    for (const p of tickLevel) {
      const narrow = activeTvlWithin(p.liquidityHistogram!, 100);
      const wide = activeTvlWithin(p.liquidityHistogram!, 500);
      expect(narrow).toBeGreaterThan(0);
      expect(wide).toBeGreaterThan(0);
      expect(narrow).toBeLessThanOrEqual(wide);
    }
  });

  it('ranks the enriched rows instead of excluding them', async () => {
    const { pools } = await meteoraAdapter.listPools({ symbols: ['USDC'], limit: 60 });
    const result = rank(pools, { depositUsd: 10_000 });
    expect(result.ranked.length).toBeGreaterThan(0);
    for (const row of result.excluded) expect(row.flags).not.toContain('range-width-mismatch');
  });
});
