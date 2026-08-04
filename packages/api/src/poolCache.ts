/**
 * Pool collection with a TTL cache.
 *
 * The UI re-ranks on every keystroke of the deposit-size field (§12 step 3),
 * and refetching five venues per keystroke would be both slow and rude to the
 * upstream APIs. Collection is cached; ranking is pure and runs per request
 * against the cached set.
 *
 * That separation is the point: `rank(A)` is cheap precisely because it does
 * no I/O.
 */

import { collectPools, isStablePair, type CollectResult, type VenueAdapter } from '@spidey/adapters';
import { ALL_ADAPTERS } from '@spidey/adapters';
import type { NormalizedPool } from '@spidey/core';

export type CacheOptions = {
  ttlMs?: number;
  adapters?: VenueAdapter[];
  symbols?: string[];
  limitPerAdapter?: number;
};

export type CacheEntry = CollectResult & {
  fetchedAt: number;
  durationMs: number;
};

export class PoolCache {
  private readonly ttlMs: number;
  private readonly adapters: VenueAdapter[];
  private readonly symbols: string[];
  private readonly limitPerAdapter: number;

  private entry: CacheEntry | null = null;
  /** In-flight refresh, so N concurrent requests trigger one upstream fetch. */
  private inflight: Promise<CacheEntry> | null = null;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.adapters = options.adapters ?? ALL_ADAPTERS;
    this.symbols = options.symbols ?? ['USDC'];
    this.limitPerAdapter = options.limitPerAdapter ?? 60;
  }

  isFresh(now = Date.now()): boolean {
    return this.entry !== null && now - this.entry.fetchedAt < this.ttlMs;
  }

  peek(): CacheEntry | null {
    return this.entry;
  }

  async get(force = false): Promise<CacheEntry> {
    if (!force && this.isFresh()) return this.entry as CacheEntry;
    if (this.inflight) return this.inflight;

    const started = Date.now();
    this.inflight = collectPools(this.adapters, {
      symbols: this.symbols,
      limit: this.limitPerAdapter,
    })
      .then((result) => {
        const entry: CacheEntry = {
          ...result,
          fetchedAt: Date.now(),
          durationMs: Date.now() - started,
        };
        this.entry = entry;
        return entry;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }
}

export type PoolFilter = {
  /** Restrict to stable/stable pairs — the §7.4 universe. Default true. */
  stableOnly?: boolean;
  chains?: string[];
  dexes?: string[];
  minTvlUsd?: number;
};

export function filterPools(pools: NormalizedPool[], filter: PoolFilter = {}): NormalizedPool[] {
  const { stableOnly = true, chains, dexes, minTvlUsd = 0 } = filter;
  return pools.filter((p) => {
    if (stableOnly && !isStablePair(p.pair)) return false;
    if (chains && chains.length > 0 && !chains.includes(p.chain)) return false;
    if (dexes && dexes.length > 0 && !dexes.includes(p.dex)) return false;
    if (p.tvlUsd < minTvlUsd) return false;
    return true;
  });
}
