'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { fetchCompare, type CompareResponse } from '@/lib/api';
import { aprFromBps, relativeTime, usdFull } from '@/lib/format';
import { PoolTable, PoolTableSkeleton } from '@/components/PoolTable';
import { SizeControls } from '@/components/SizeControls';

export default function Page() {
  const [sizeUsd, setSizeUsd] = useState(10_000);
  const [holdDays, setHoldDays] = useState(7);
  const [stableOnly, setStableOnly] = useState(true);
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
  useEffect(() => {
    const timer = setTimeout(() => void load(sizeUsd, holdDays, stableOnly), 200);
    return () => clearTimeout(timer);
  }, [sizeUsd, holdDays, stableOnly, load]);

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

  const headlineBest = useMemo(() => {
    const rows = data?.rows ?? [];
    return rows.reduce<(typeof rows)[number] | null>(
      (acc, r) => (acc === null || r.headlineAprBps > acc.headlineAprBps ? r : acc),
      null,
    );
  }, [data]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-10 md:px-6 lg:px-8">
      <header className="mb-10 max-w-3xl space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          What you actually earn
        </h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          Aggregators rank USDC LP venues on fees over <em>displayed</em> TVL. Only in-range
          liquidity earns fees, and your own deposit changes the denominator. So the best pool is a
          function of how much you deposit — and nothing else asks you for that.
        </p>
      </header>

      <section aria-labelledby="controls-heading" className="mb-8">
        <h2 id="controls-heading" className="sr-only">
          Position parameters
        </h2>
        <SizeControls
          sizeUsd={sizeUsd}
          holdDays={holdDays}
          onSizeChange={setSizeUsd}
          onHoldChange={setHoldDays}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Pairs</span>
          <div className="inline-flex rounded-md border border-border p-0.5" role="group">
            {[
              { value: true, label: 'Stable only' },
              { value: false, label: 'All pairs' },
            ].map((option) => (
              <button
                key={String(option.value)}
                type="button"
                onClick={() => setStableOnly(option.value)}
                aria-pressed={stableOnly === option.value}
                className={`min-h-10 rounded px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none ${
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
            A USDC vault takes no directional risk, so stable pairs are the default universe.
          </p>
        </div>
      </section>

      {best && headlineBest && (
        <section
          aria-live="polite"
          className="mb-8 grid gap-4 rounded-xl border border-border bg-card p-5 sm:grid-cols-2"
        >
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              Top pool by headline APR
            </p>
            <p className="mt-1 font-medium">{headlineBest.pair.join(' / ')}</p>
            <p className="tabular mt-1 text-2xl text-muted-foreground">
              {aprFromBps(headlineBest.headlineAprBps)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{headlineBest.dex}</p>
          </div>
          <div className="sm:border-l sm:border-border sm:pl-5">
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              Best for {usdFull(sizeUsd)}
            </p>
            <p className="mt-1 font-medium">{best.pair.join(' / ')}</p>
            <p className="tabular mt-1 text-2xl font-semibold">{aprFromBps(best.yourAprBps)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{best.dex}</p>
          </div>
          {data?.headlineDisagreement.disagrees && (
            <p className="text-sm text-warning sm:col-span-2">
              These are different pools. Ranking by headline APR would put you in the wrong one at
              this size.
            </p>
          )}
        </section>
      )}

      {error && (
        <div
          role="alert"
          className="mb-6 flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-5 sm:flex-row sm:items-center"
        >
          <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden />
          <div className="flex-1">
            <p className="font-medium">Could not reach the scoring engine</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{error}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Start it with <code className="tabular">pnpm api</code>, then retry.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(sizeUsd, holdDays, stableOnly)}
            className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-4 text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry
          </button>
        </div>
      )}

      <section aria-labelledby="ranked-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="ranked-heading" className="text-lg font-medium">
            Ranked for {usdFull(sizeUsd)}
          </h2>
          {data && (
            <p className="text-xs text-muted-foreground">
              {ranked.length} rankable · data {relativeTime(data.fetchedAt)}
            </p>
          )}
        </div>

        {isLoading && !data ? (
          <PoolTableSkeleton />
        ) : ranked.length > 0 ? (
          <PoolTable rows={ranked} />
        ) : (
          !error && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border py-16 text-center">
              <Inbox className="h-10 w-10 text-muted-foreground" aria-hidden />
              <div className="space-y-1">
                <p className="text-sm font-medium">No venue can be scored right now</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Every pool we found is missing an in-range denominator or has stale data. We
                  exclude rather than approximate, so nothing is shown.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void load(sizeUsd, holdDays, stableOnly)}
                className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-4 text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Refresh
              </button>
            </div>
          )
        )}
      </section>

      {excluded.length > 0 && (
        <section aria-labelledby="excluded-heading" className="mt-10 space-y-3">
          <div className="space-y-1">
            <h2 id="excluded-heading" className="text-lg font-medium">
              Excluded — {excluded.length}
            </h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              These pools appear on dashboards but cannot be scored honestly. An approximated
              denominator would reintroduce the exact error this tool exists to remove, so they are
              listed with a reason instead of a number.
            </p>
          </div>
          <PoolTable rows={excluded} />
        </section>
      )}

      <footer className="mt-12 border-t border-border pt-6 text-xs leading-relaxed text-muted-foreground">
        <p>
          Your APR is <span className="tabular">365 · f · V_δ / (T_δ + A)</span> — fee rate times
          in-range volume, over in-range liquidity plus your deposit. Venue widths differ, so yields
          are also restated at a common ±0.1% for quality comparison.
        </p>
      </footer>
    </main>
  );
}
