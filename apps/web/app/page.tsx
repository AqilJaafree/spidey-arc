'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { fetchCompare, type CompareResponse } from '@/lib/api';
import { engineIsLocal } from '@/lib/apiTarget';
import { aprFromBps, dexName, gapInPoints, gapTone, relativeTime, usdFull } from '@/lib/format';
import { ExcludedGroups } from '@/components/ExcludedGroups';
import { DilutionChart } from '@/components/DilutionChart';
import { HowItWorks } from '@/components/HowItWorks';
import { PoolTable, PoolTableSkeleton } from '@/components/PoolTable';
import { SizeControls } from '@/components/SizeControls';
import { SiteHeader } from '@/components/SiteHeader';

function parseUrlNumber(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function PageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [sizeUsd, setSizeUsd] = useState(() => parseUrlNumber(searchParams.get('size'), 10_000));
  const [holdDays, setHoldDays] = useState(() => parseUrlNumber(searchParams.get('hold'), 7));
  const [stableOnly, setStableOnly] = useState(() => searchParams.get('pairs') !== 'all');
  const [data, setData] = useState<CompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (size: number, hold: number, stable: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    try {
      const next = await fetchCompare(size, hold, stable, controller.signal);
      if (!controller.signal.aborted) setData(next);
    } catch (cause) {
      if ((cause as Error).name === 'AbortError') return;
      setError((cause as Error).message);
    } finally {
      if (!controller.signal.aborted) setIsLoading(false);
    }
  }, []);

  // Debounced so dragging the size field does not fire a request per keystroke.
  // The URL is kept in sync on the same timer, as a scenario a user can share
  // — not pushed to history per keystroke, just replaced in place.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(sizeUsd, holdDays, stableOnly);
      const params = new URLSearchParams();
      params.set('size', String(Math.round(sizeUsd)));
      params.set('hold', String(Math.round(holdDays)));
      if (!stableOnly) params.set('pairs', 'all');
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }, 200);
    return () => clearTimeout(timer);
  }, [sizeUsd, holdDays, stableOnly, load, router, pathname]);

  const { ranked, excluded, best } = useMemo(() => {
    const rows = data?.rows ?? [];
    const included = rows.filter((r) => !r.excluded);
    return {
      ranked: [...included].sort((a, b) => (b.yourAprBps ?? 0) - (a.yourAprBps ?? 0)),
      excluded: rows.filter((r) => r.excluded),
      best: included.reduce<(typeof included)[number] | null>(
        (acc, r) => (acc === null || (r.yourAprBps ?? 0) > (acc.yourAprBps ?? 0) ? r : acc),
        null,
      ),
    };
  }, [data]);

  // Only rows carrying a real in-range denominator can be curved. Excluded
  // pools stay excluded here too — an approximated denominator would be worse
  // on a chart than in a table, because a drawn line reads as a measurement.
  const curvable = useMemo(
    () =>
      ranked
        .filter((r) => r.activeTvlUsd !== null && r.yourAprBps !== null)
        .map((r) => ({
          poolId: r.poolId,
          label: `${r.pair.join('/')} \u00b7 ${dexName(r.dex)}`,
          activeTvlUsd: r.activeTvlUsd,
          yourAprBps: r.yourAprBps,
          atSizeUsd: sizeUsd,
        })),
    [ranked, sizeUsd],
  );

  const headlineBest = useMemo(() => {
    const rows = data?.rows ?? [];
    return rows.reduce<(typeof rows)[number] | null>(
      (acc, r) => (acc === null || r.headlineAprBps > acc.headlineAprBps ? r : acc),
      null,
    );
  }, [data]);

  const heroGap = useMemo(
    () => (best ? gapInPoints(best.headlineAprBps, best.yourAprBps) : null),
    [best],
  );

  return (
    <>
      <SiteHeader />

      <main className="mx-auto max-w-7xl px-4 py-10 md:px-6 lg:px-8">
        <section className="mb-10 max-w-3xl space-y-3">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance md:text-5xl">
            What you actually earn
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            Most sites show one interest rate per pool. That rate assumes you are not in it yet.
            The moment you deposit, you share the same fees with more money, so your rate is lower
            than the one advertised — and how much lower depends on how much you put in. Enter your
            amount and see the rate you would actually get.
          </p>
        </section>

        <section aria-labelledby="controls-heading" className="mb-8">
          <h2 id="controls-heading" className="mb-3 text-sm font-semibold">
            Amount and time
          </h2>
          <SizeControls
            sizeUsd={sizeUsd}
            holdDays={holdDays}
            onSizeChange={setSizeUsd}
            onHoldChange={setHoldDays}
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Pairs</span>
            <div className="inline-flex rounded border border-border p-0.5" role="group">
              {[
                { value: true, label: 'Stable only' },
                { value: false, label: 'All pairs' },
              ].map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  onClick={() => setStableOnly(option.value)}
                  aria-pressed={stableOnly === option.value}
                  className={`min-h-11 rounded-sm px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none ${
                    stableOnly === option.value
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-muted'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Stablecoin pairs by default — they hold their price, so you are not exposed to a token
              going up or down.
            </p>
          </div>
        </section>

        {best && (
          <section
            aria-live="polite"
            className="mb-10 rounded border border-border bg-card p-6 sm:p-8"
          >
            <p className="text-sm font-medium text-muted-foreground">
              Best for {usdFull(sizeUsd)} — {best.pair.join(' / ')}{' '}
              <span className="text-xs">({best.dex})</span>
            </p>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-4xl font-semibold tracking-tight md:text-5xl">
              <span className="tabular text-primary">{aprFromBps(best.yourAprBps)}</span>
              {heroGap && heroGap.direction !== 'level' && (
                <span className={`tabular text-2xl md:text-3xl ${gapTone(heroGap.direction)}`}>
                  {heroGap.label} vs. advertised
                </span>
              )}
            </p>
            <p className="tabular mt-2 text-sm text-muted-foreground">
              Advertised rate for this pool: {aprFromBps(best.headlineAprBps)}
            </p>

            {heroGap?.direction === 'above' && (
              <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
                This pool pays you more than advertised. The headline rate is averaged over all
                the money in the pool, including money parked away from the current price that
                earns nothing. Yours sits where the trading happens, so it earns a bigger share.
              </p>
            )}
            {heroGap?.direction === 'below' && best.flags.includes('dilution') && (
              <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
                Yours is large next to what this pool is already earning on, so you take a big
                slice of the same fees. That pulls the rate below the advertised one.
              </p>
            )}

            {data?.headlineDisagreement.disagrees &&
              headlineBest &&
              headlineBest.poolId !== best.poolId && (
                <p className="mt-3 max-w-2xl text-sm text-warning">
                  Ranking by headline APR alone would point you at {headlineBest.pair.join(' / ')}{' '}
                  instead ({aprFromBps(headlineBest.headlineAprBps)} headline) — a different pool,
                  at this size.
                </p>
              )}

            <a
              href="#how-it-works"
              className="mt-4 inline-flex min-h-11 items-center text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
            >
              How we work this out ↓
            </a>
          </section>
        )}

        {error && (
          <div
            role="alert"
            className="mb-6 flex flex-col gap-3 rounded border border-destructive/40 bg-destructive/5 p-5 sm:flex-row sm:items-center"
          >
            <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden />
            <div className="flex-1">
              <p className="font-medium">Could not reach the scoring engine</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{error}</p>
              {engineIsLocal() ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Start it with <code className="tabular">pnpm api</code>, then retry.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  The engine is a separate long-lived process. The{' '}
                  <Link href="/vault" className="underline decoration-border underline-offset-4 hover:text-foreground">
                    vault
                  </Link>{' '}
                  reads Arc directly and is unaffected.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void load(sizeUsd, holdDays, stableOnly)}
              className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-border px-4 text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry
            </button>
          </div>
        )}

        <section aria-labelledby="ranked-heading" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="ranked-heading" className="text-lg font-medium">
              Best pools for {usdFull(sizeUsd)}
            </h2>
            {data && (
              <p className="tabular text-xs text-muted-foreground">
                {ranked.length} pools we can measure · updated {relativeTime(data.fetchedAt)}
              </p>
            )}
          </div>

          {isLoading && !data ? (
            <PoolTableSkeleton />
          ) : ranked.length > 0 ? (
            <PoolTable rows={ranked} />
          ) : (
            !error && (
              <div className="flex flex-col items-center justify-center gap-3 rounded border border-border py-16 text-center">
                <Inbox className="h-10 w-10 text-muted-foreground" aria-hidden />
                <div className="space-y-1">
                  <p className="text-sm font-medium">No venue can be scored right now</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    For every pool we found, the data we need is missing or out of date. We would
                    rather show nothing than show you a guess.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void load(sizeUsd, holdDays, stableOnly)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-border px-4 text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Refresh
                </button>
              </div>
            )
          )}
        </section>

        {curvable.length >= 2 && (
          <section aria-labelledby="curve-heading" className="mt-10 space-y-3">
            <h2 id="curve-heading" className="text-lg font-medium">
              What happens if you put in more
            </h2>
            <DilutionChart pools={curvable} atSizeUsd={sizeUsd} />
          </section>
        )}

        <HowItWorks />

        {excluded.length > 0 && (
          <section aria-labelledby="excluded-heading" className="mt-10 space-y-3">
            <div className="space-y-1">
              <h2 id="excluded-heading" className="text-lg font-medium">
                Excluded — {excluded.length}
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                For these pools we could not get the numbers needed to work out an honest rate.
                Rather than show you a guess, we list them with the reason.
              </p>
            </div>
            <ExcludedGroups rows={excluded} />
          </section>
        )}
      </main>

      <footer className="mt-12 border-t border-border bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 py-8 md:px-6 lg:px-8">
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Rates shown are estimates based on recent trading activity. They are not a promise of
            future return, and providing liquidity can lose money.
          </p>
        </div>
      </footer>
    </>
  );
}

function PageFallback() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-4 py-10 md:px-6 lg:px-8">
        <div className="mb-10 max-w-3xl space-y-3">
          <div className="h-4 w-56 animate-pulse rounded bg-muted" />
          <div className="h-10 w-80 animate-pulse rounded bg-muted" />
        </div>
        <PoolTableSkeleton />
      </main>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<PageFallback />}>
      <PageContent />
    </Suspense>
  );
}
