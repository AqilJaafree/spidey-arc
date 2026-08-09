import { describe, expect, it } from 'vitest';
import { normalizeMeteoraPool, type MeteoraPool } from './meteora.js';

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
