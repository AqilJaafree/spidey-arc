/**
 * DefiLlama `/yields` adapter — spec §6, "Breadth, `apyBase` vs `apyReward` split".
 *
 * This adapter is the control group. It supplies the numbers a dashboard
 * shows — headline TVL, `apyBase`, `apyReward` — and, crucially, it CANNOT
 * supply in-range liquidity. So every row it produces carries
 * `activeTvlUsd: null` and is excluded from ranking by §6.
 *
 * That is not a gap to be papered over; it is the product's argument made
 * concrete. "Here is what the aggregator ranks on, here is why we refuse to
 * rank on it."
 *
 * Its `volumeUsd1d` / `underlyingTokens` / fee-tier fields are also the join
 * key the Uniswap v3 adapter uses to pair off-chain flow with on-chain state.
 */

import type { NormalizedPool } from '@spidey/core';
import { getJson } from './http.js';
import type { AdapterContext, AdapterResult, VenueAdapter } from './types.js';

const YIELDS_URL = 'https://yields.llama.fi/pools';

export type LlamaPool = {
  chain: string;
  project: string;
  symbol: string;
  pool: string;
  tvlUsd: number | null;
  apyBase: number | null;
  apyReward: number | null;
  apy: number | null;
  apyBase7d: number | null;
  stablecoin: boolean;
  ilRisk: string;
  exposure: string;
  poolMeta: string | null;
  underlyingTokens: string[] | null;
  volumeUsd1d: number | null;
  volumeUsd7d: number | null;
  count: number | null;
  outlier: boolean;
  sigma: number | null;
};

/** DefiLlama chain names → our lowercase ids and CCTP domains. */
const CHAIN_MAP: Record<string, { chain: string; cctpDomain: number }> = {
  Ethereum: { chain: 'ethereum', cctpDomain: 0 },
  Base: { chain: 'base', cctpDomain: 6 },
  Arbitrum: { chain: 'arbitrum', cctpDomain: 3 },
  Optimism: { chain: 'optimism', cctpDomain: 2 },
  Polygon: { chain: 'polygon', cctpDomain: 7 },
  Avalanche: { chain: 'avalanche', cctpDomain: 1 },
  Solana: { chain: 'solana', cctpDomain: 5 },
};

/** `"0.3%"` → 3000 (Uniswap fee units) and 30 (bps). */
export function parseFeeTier(poolMeta: string | null): { feeUnits: number; feeBps: number } | null {
  if (!poolMeta) return null;
  const match = /([\d.]+)\s*%/.exec(poolMeta);
  if (!match?.[1]) return null;
  const percent = Number.parseFloat(match[1]);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return { feeUnits: Math.round(percent * 10_000), feeBps: percent * 100 };
}

export function splitSymbol(symbol: string): [string, string] {
  const parts = symbol.split('-');
  return [parts[0] ?? symbol, parts[1] ?? ''];
}

function normalize(row: LlamaPool, now: number): NormalizedPool | { skip: string } {
  const mapped = CHAIN_MAP[row.chain];
  if (!mapped) return { skip: `unmapped chain ${row.chain}` };
  const tvlUsd = row.tvlUsd ?? 0;
  if (tvlUsd <= 0) return { skip: 'no TVL' };

  const tier = parseFeeTier(row.poolMeta);
  const volume24h = row.volumeUsd1d ?? 0;
  const feeBps = tier?.feeBps ?? 0;
  // Fees are not published directly; derive them from volume × tier where both
  // are known, and leave them at zero otherwise rather than inventing a rate.
  const fees24h = tier ? (volume24h * tier.feeBps) / 10_000 : 0;

  return {
    chain: mapped.chain,
    cctpDomain: mapped.cctpDomain,
    dex: row.project,
    poolId: row.pool,
    pair: splitSymbol(row.symbol),

    feeBps,
    feeIsDynamic: false,
    feeBpsObserved24h: null,

    tvlUsd,
    // The entire point of this adapter: it does not know, and says so.
    activeTvlUsd: null,
    activeTvlDeltaBps: null,
    activeTvlFidelity: 'unavailable',

    volume24h,
    volume7d: row.volumeUsd7d,
    fees24h,
    fees7d: null,

    apyBase: (row.apyBase ?? 0) / 100,
    apyReward: (row.apyReward ?? 0) / 100,

    priceHistogram: [],
    priceHistogramSource: 'none',
    hourlyFeeSeries: [],
    volumeAutocorr: null,

    source: 'defillama-yields',
    asOf: now,
  };
}

export type LlamaOptions = AdapterContext & {
  /** Restrict to these DefiLlama `project` values. */
  projects?: string[];
  /** Restrict to these DefiLlama `chain` values. */
  chains?: string[];
  /** Only pools DefiLlama marks as stablecoin pools. */
  stablecoinOnly?: boolean;
  minTvlUsd?: number;
};

/** Raw rows, cached per process — the Uniswap adapter joins against these. */
export async function fetchLlamaPools(signal?: AbortSignal): Promise<LlamaPool[]> {
  const body = await getJson<{ status: string; data: LlamaPool[] }>(YIELDS_URL, {
    namespace: 'defillama',
    timeoutMs: 60_000,
    signal,
  });
  return body.data ?? [];
}

export function filterLlamaPools(rows: LlamaPool[], options: LlamaOptions): LlamaPool[] {
  const { projects, chains, stablecoinOnly, minTvlUsd = 0, symbols } = options;
  const wanted = symbols?.map((s) => s.toUpperCase());
  return rows.filter((row) => {
    if (projects && !projects.includes(row.project)) return false;
    if (chains && !chains.includes(row.chain)) return false;
    if (stablecoinOnly && !row.stablecoin) return false;
    if ((row.tvlUsd ?? 0) < minTvlUsd) return false;
    if (wanted && wanted.length > 0) {
      const parts = row.symbol.toUpperCase().split('-');
      if (!parts.some((p) => wanted.includes(p))) return false;
    }
    return true;
  });
}

export function createDefiLlamaAdapter(options: LlamaOptions = {}): VenueAdapter {
  return {
    id: 'defillama',
    label: 'DefiLlama (headline)',
    bestFidelity: 'unavailable',

    async listPools(ctx: AdapterContext = {}): Promise<AdapterResult> {
      const merged = { ...options, ...ctx };
      const { limit = 50, now = Date.now(), signal } = merged;
      const rows = filterLlamaPools(await fetchLlamaPools(signal), merged);

      const pools: NormalizedPool[] = [];
      const skipped: AdapterResult['skipped'] = [];
      for (const row of rows.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))) {
        const result = normalize(row, now);
        if ('skip' in result) skipped.push({ poolId: row.pool, reason: result.skip });
        else pools.push(result);
        if (pools.length >= limit) break;
      }
      return { pools, skipped };
    },
  };
}

export const defiLlamaAdapter = createDefiLlamaAdapter({ stablecoinOnly: true, minTvlUsd: 250_000 });
