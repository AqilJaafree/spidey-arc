/**
 * Scoring engine HTTP surface — spec §11 Day 1 step 2:
 * "Estimator + decision engine as an HTTP API. §7.3 and §7.5 implemented."
 *
 * Routes:
 *   GET  /health          liveness plus cache and adapter status
 *   GET  /pools           normalized rows, with fidelity and provenance
 *   GET  /rank?size=…     ranking for a deposit size (the UI's hot path)
 *   POST /rank            same, with itemized move costs and a held position
 *   GET  /compare?size=…  the §12 step 2 payload: headline vs ours, side by side
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { rank, type MoveCost, type RankOptions } from '@spidey/core';
import { PoolCache, filterPools, type PoolFilter } from './poolCache.js';

export type AppOptions = {
  cache?: PoolCache;
};

const numberParam = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const listParam = (value: string | undefined): string[] | undefined =>
  value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

const boolParam = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : value !== 'false' && value !== '0';

export function createApp(options: AppOptions = {}) {
  const cache = options.cache ?? new PoolCache();
  const app = new Hono();

  app.use('*', cors());

  app.get('/health', async (c) => {
    const entry = cache.peek();
    return c.json({
      ok: true,
      cache: entry
        ? {
            fetchedAt: new Date(entry.fetchedAt).toISOString(),
            ageMs: Date.now() - entry.fetchedAt,
            fresh: cache.isFresh(),
            pools: entry.pools.length,
            durationMs: entry.durationMs,
          }
        : null,
      adapterFailures: entry?.failures ?? [],
    });
  });

  app.get('/pools', async (c) => {
    const entry = await cache.get(boolParam(c.req.query('refresh'), false));
    const filter: PoolFilter = {
      stableOnly: boolParam(c.req.query('stable'), true),
      chains: listParam(c.req.query('chains')),
      dexes: listParam(c.req.query('dexes')),
      minTvlUsd: numberParam(c.req.query('minTvl'), 0),
    };
    const pools = filterPools(entry.pools, filter);

    return c.json({
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      count: pools.length,
      totalBeforeFilter: entry.pools.length,
      byFidelity: pools.reduce<Record<string, number>>((acc, p) => {
        acc[p.activeTvlFidelity] = (acc[p.activeTvlFidelity] ?? 0) + 1;
        return acc;
      }, {}),
      adapterFailures: entry.failures,
      skipped: entry.skipped.length,
      pools,
    });
  });

  /** Shared by both /rank verbs. */
  async function doRank(
    rankOptions: RankOptions,
    filter: PoolFilter,
    refresh: boolean,
  ) {
    const entry = await cache.get(refresh);
    const pools = filterPools(entry.pools, filter);
    const result = rank(pools, rankOptions);
    return {
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      adapterFailures: entry.failures,
      universe: { considered: pools.length, ranked: result.ranked.length, excluded: result.excluded.length },
      ...result,
    };
  }

  app.get('/rank', async (c) => {
    const q = c.req.query.bind(c.req);
    const depositUsd = numberParam(q('size'), 10_000);
    if (depositUsd <= 0) return c.json({ error: 'size must be positive' }, 400);

    const rangeDeltaBpsRaw = q('deltaBps');
    return c.json(
      await doRank(
        {
          depositUsd,
          expectedHoldDays: numberParam(q('hold'), 7),
          ...(rangeDeltaBpsRaw ? { rangeDeltaBps: numberParam(rangeDeltaBpsRaw, 10) } : {}),
          ...(q('current') ? { currentPoolId: q('current') as string } : {}),
          moveCost: numberParam(q('moveCost'), 2),
          entryCostUsd: numberParam(q('entryCost'), 1),
          kappa: numberParam(q('kappa'), 1.75),
        },
        {
          stableOnly: boolParam(q('stable'), true),
          chains: listParam(q('chains')),
          dexes: listParam(q('dexes')),
          minTvlUsd: numberParam(q('minTvl'), 0),
        },
        boolParam(q('refresh'), false),
      ),
    );
  });

  app.post('/rank', async (c) => {
    const body = await c.req.json<{
      sizeUsd?: number;
      depositUsd?: number;
      holdDays?: number;
      currentPoolId?: string;
      moveCost?: MoveCost | number;
      entryCostUsd?: number;
      rangeDeltaBps?: number;
      kappa?: number;
      filter?: PoolFilter;
      refresh?: boolean;
    }>();

    const depositUsd = body.sizeUsd ?? body.depositUsd;
    if (typeof depositUsd !== 'number' || !(depositUsd > 0)) {
      return c.json({ error: 'sizeUsd must be a positive number' }, 400);
    }

    return c.json(
      await doRank(
        {
          depositUsd,
          expectedHoldDays: body.holdDays ?? 7,
          ...(body.rangeDeltaBps !== undefined ? { rangeDeltaBps: body.rangeDeltaBps } : {}),
          ...(body.currentPoolId ? { currentPoolId: body.currentPoolId } : {}),
          moveCost: body.moveCost ?? 2,
          entryCostUsd: body.entryCostUsd ?? 1,
          kappa: body.kappa ?? 1.75,
        },
        body.filter ?? {},
        body.refresh ?? false,
      ),
    );
  });

  /**
   * The §12 step 2 payload: for each pool, what a dashboard shows against
   * what a depositor of this size actually gets, plus the reason they differ.
   * Sorted by the size of the disagreement, because that is the screenshot.
   */
  app.get('/compare', async (c) => {
    const depositUsd = numberParam(c.req.query('size'), 10_000);
    if (depositUsd <= 0) return c.json({ error: 'size must be positive' }, 400);

    const entry = await cache.get(false);
    const pools = filterPools(entry.pools, {
      stableOnly: boolParam(c.req.query('stable'), true),
    });
    const result = rank(pools, {
      depositUsd,
      expectedHoldDays: numberParam(c.req.query('hold'), 7),
    });

    const byId = new Map(pools.map((p) => [p.poolId, p]));
    const rows = [...result.ranked, ...result.excluded].map((row) => {
      const pool = byId.get(row.poolId);
      return {
        poolId: row.poolId,
        chain: row.chain,
        dex: row.dex,
        pair: row.pair,
        headlineAprBps: row.headlineAprBps,
        yourAprBps: row.yourAprBps,
        normalizedAprBps: row.normalizedAprBps,
        deltaBps: row.deltaBps,
        tvlUsd: pool?.tvlUsd ?? null,
        activeTvlUsd: pool?.activeTvlUsd ?? null,
        activeTvlShare:
          pool && pool.activeTvlUsd !== null && pool.tvlUsd > 0
            ? pool.activeTvlUsd / pool.tvlUsd
            : null,
        dilution: row.dilution,
        excluded: row.excluded,
        flags: row.flags,
        reason: row.reason,
        /** How many multiples the headline overstates your actual yield by. */
        overstatement:
          row.yourAprBps && row.yourAprBps > 0 ? row.headlineAprBps / row.yourAprBps : null,
      };
    });

    rows.sort((a, b) => (b.overstatement ?? 0) - (a.overstatement ?? 0));

    return c.json({
      depositUsd,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      headlineDisagreement: result.headlineDisagreement,
      rows,
    });
  });

  app.notFound((c) => c.json({ error: 'not found', routes: ['/health', '/pools', '/rank', '/compare'] }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: error.message }, 500);
  });

  return app;
}
