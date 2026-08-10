/** Client for the scoring engine (`@spidey/api`). */

import { ENGINE_URL as API_URL } from './apiTarget';

/**
 * Mirrors `PoolFlag` in `@spidey/core`. Deliberately a copy rather than an
 * import: this is an HTTP contract, and the web app should not compile against
 * the engine's internals to read its JSON.
 *
 * The cost of that choice is that adding a flag in `core` does **not** fail this
 * file's typecheck — `FLAG_LABELS` below is `Record<PoolFlag, string>` over
 * *this* union, so a new flag arrives as an unlabelled chip instead of a build
 * error. When `core` gains a flag, it has to be added here by hand.
 */
export type PoolFlag =
  | 'no-active-tvl'
  | 'stale'
  | 'range-width-mismatch'
  | 'dilution'
  | 'dilution-dominates'
  | 'one-whale-volume'
  | 'cost-exceeds-edge'
  | 'fails-entry-condition'
  | 'emissions-dependent'
  | 'modelled-volume-distribution'
  | 'no-hygiene-series'
  | 'no-volatility-series'
  | 'current-tick-liquidity-only';

export type CompareRow = {
  poolId: string;
  chain: string;
  dex: string;
  pair: [string, string];
  headlineAprBps: number;
  yourAprBps: number | null;
  normalizedAprBps: number | null;
  deltaBps: number;
  tvlUsd: number | null;
  activeTvlUsd: number | null;
  activeTvlShare: number | null;
  dilution: number | null;
  excluded: boolean;
  flags: PoolFlag[];
  reason: string;
  overstatement: number | null;
};

export type CompareResponse = {
  depositUsd: number;
  fetchedAt: string;
  headlineDisagreement: {
    headlineWinnerPoolId: string | null;
    ourWinnerPoolId: string | null;
    disagrees: boolean;
  };
  rows: CompareRow[];
};

export async function fetchCompare(
  sizeUsd: number,
  holdDays: number,
  stableOnly: boolean,
  signal?: AbortSignal,
): Promise<CompareResponse> {
  const url = `${API_URL}/compare?size=${encodeURIComponent(sizeUsd)}&hold=${encodeURIComponent(holdDays)}&stable=${stableOnly}`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Scoring engine returned ${response.status}. ${detail.slice(0, 140)}`);
  }
  return (await response.json()) as CompareResponse;
}

/**
 * Flags that describe how the data was obtained rather than how the pool
 * behaves. Shown in a separate, quieter place — they are caveats about our
 * confidence, not findings about the venue.
 */
export const PROVENANCE_FLAGS: ReadonlySet<PoolFlag> = new Set([
  'modelled-volume-distribution',
  'no-hygiene-series',
  'no-volatility-series',
  'current-tick-liquidity-only',
]);

export const FLAG_LABELS: Record<PoolFlag, string> = {
  'no-active-tvl': 'no in-range data',
  stale: 'stale data',
  'range-width-mismatch': 'range width mismatch',
  dilution: 'diluted by your size',
  'dilution-dominates': 'too small for your size',
  'one-whale-volume': 'one-whale volume',
  'cost-exceeds-edge': 'cost exceeds edge',
  'fails-entry-condition': 'fails entry test',
  'emissions-dependent': 'emissions-dependent',
  'modelled-volume-distribution': 'modelled volume',
  'no-hygiene-series': 'point estimate',
  'no-volatility-series': 'exit risk unmeasured',
  'current-tick-liquidity-only': 'current-tick liquidity',
};
