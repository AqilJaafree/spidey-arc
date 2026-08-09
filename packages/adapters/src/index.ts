/**
 * @spidey/adapters — spec Layer 1.
 *
 * Venue coverage and what each can honestly measure:
 *
 * | Adapter     | Chain    | activeTVL fidelity      | Key needed |
 * |-------------|----------|-------------------------|------------|
 * | meteora     | Solana   | tick-level (bins)       | no (RPC)   |
 * | orca        | Solana   | current-tick-liquidity  | no         |
 * | uniswap-v3  | EVM      | current-tick-liquidity  | no (RPC)   |
 * | raydium     | Solana   | unavailable             | no         |
 * | defillama   | many     | unavailable             | no         |
 *
 * The fidelity column is what each adapter *can* reach, not what every row
 * carries. Orca and Uniswap v3 supply a real in-range denominator, which is
 * what §11 Day 1 asks for ("`activeTvlUsd` correct for at least 2"). Meteora
 * reaches `tick-level` from its constant-sum bins, but only for the handful of
 * pools per scan that get an RPC read — the ones deep and busy enough to take a
 * deposit. Every other Meteora row is listed at `unavailable`, on purpose: bins
 * are on-chain accounts, so the denominator costs three RPC calls per pool and
 * is rationed rather than skipped. Raydium and DefiLlama supply breadth and, by
 * being excluded, the comparison the product argues about.
 */

import type { NormalizedPool } from '@spidey/core';
import { defiLlamaAdapter, createDefiLlamaAdapter } from './defillama.js';
import { meteoraAdapter } from './meteora.js';
import { orcaAdapter } from './orca.js';
import { raydiumAdapter } from './raydium.js';
import { createUniswapV3Adapter, uniswapV3Adapter } from './uniswapV3.js';
import type { AdapterContext, AdapterResult, VenueAdapter } from './types.js';

export * from './types.js';
export * from './http.js';
export * from './series.js';
export { meteoraAdapter, createMeteoraAdapter, normalizeMeteoraPool, poolsUrl, METEORA_BASE } from './meteora.js';
export { orcaAdapter } from './orca.js';
export { raydiumAdapter } from './raydium.js';
export { defiLlamaAdapter, createDefiLlamaAdapter, fetchLlamaPools, filterLlamaPools, parseFeeTier } from './defillama.js';
export { uniswapV3Adapter, createUniswapV3Adapter, activeTvlUsdFromState, UNISWAP_CHAINS } from './uniswapV3.js';

export const ALL_ADAPTERS: VenueAdapter[] = [
  meteoraAdapter,
  orcaAdapter,
  uniswapV3Adapter,
  raydiumAdapter,
  defiLlamaAdapter,
];

export type CollectResult = {
  pools: NormalizedPool[];
  skipped: Array<{ adapter: string; poolId: string; reason: string }>;
  /** Rows present but at reduced fidelity, with why. See `AdapterResult.degraded`. */
  degraded: Array<{ adapter: string; poolId: string; reason: string }>;
  /** Adapters that threw. A dead venue must not take the whole ranking down. */
  failures: Array<{ adapter: string; error: string }>;
};

/**
 * Run every adapter concurrently and merge the results.
 *
 * One venue's outage degrades coverage; it does not fail the request. §10.2's
 * posture throughout is "exclude, never extrapolate" — a missing venue is a
 * missing row, not an error page.
 */
export async function collectPools(
  adapters: VenueAdapter[] = ALL_ADAPTERS,
  ctx: AdapterContext = {},
): Promise<CollectResult> {
  const settled = await Promise.allSettled(adapters.map((a) => a.listPools(ctx)));

  const pools: NormalizedPool[] = [];
  const skipped: CollectResult['skipped'] = [];
  const degraded: CollectResult['degraded'] = [];
  const failures: CollectResult['failures'] = [];

  settled.forEach((outcome, i) => {
    const adapter = adapters[i] as VenueAdapter;
    if (outcome.status === 'fulfilled') {
      const result = outcome.value as AdapterResult;
      pools.push(...result.pools);
      skipped.push(...result.skipped.map((s) => ({ adapter: adapter.id, ...s })));
      degraded.push(...(result.degraded ?? []).map((d) => ({ adapter: adapter.id, ...d })));
    } else {
      failures.push({ adapter: adapter.id, error: String(outcome.reason).slice(0, 300) });
    }
  });

  return { pools, skipped, degraded, failures };
}

export { createUniswapV3Adapter as uniswap };
