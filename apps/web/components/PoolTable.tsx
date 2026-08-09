import { ChevronRight } from 'lucide-react';
import { PROVENANCE_FLAGS, type CompareRow } from '@/lib/api';
import { aprFromBps, gapInPoints, gapTone, percentFromFraction, usdCompact } from '@/lib/format';
import { Flag } from './Flag';

/** Past this many rows the table/list scrolls internally instead of the whole page growing. */
const SCROLL_THRESHOLD = 6;

/**
 * The comparison table. Two APR columns sit next to each other on purpose:
 * the left is what a dashboard prints, the right is what this deposit
 * actually earns. The gap between them is the product, so it carries real
 * visual weight here rather than column parity with TVL/In range.
 *
 * Below `lg` there isn't room for all 7 columns without a horizontal-scroll
 * affordance nobody notices, so a separate list layout takes over: Pool /
 * Your APR / Why stay visible, Headline APR / TVL / In range move into a
 * per-row disclosure instead of scrolling off-screen unannounced.
 */
export function PoolTable({ rows }: { rows: CompareRow[] }) {
  const scrolls = rows.length > SCROLL_THRESHOLD;

  return (
    <>
      <div className="relative hidden rounded border border-border lg:block">
        <div className={`overflow-auto ${scrolls ? 'max-h-[32rem]' : ''}`}>
          <table className="w-full min-w-[52rem] text-sm">
            <caption className="sr-only">
              USDC LP venues, showing headline APR against the APR for your deposit size
            </caption>
              <thead>
                {/* top-[69px] clears the page header's own height (see z-index scale note
                    in globals.css) so this sticks just below it, not underneath it. */}
                <tr className="sticky top-[69px] z-10 border-b border-border bg-muted text-left">
                  <th scope="col" className="px-4 py-3 text-xs font-medium tracking-wide uppercase">
                    Pool
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    Headline APR
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-medium tracking-wide uppercase"
                  >
                    Your APR
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-medium tracking-wide uppercase"
                  >
                    Gap
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    TVL
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-right text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    In range
                  </th>
                  <th scope="col" className="px-4 py-3 text-xs font-medium tracking-wide uppercase">
                    Why
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const gap = row.excluded ? null : gapInPoints(row.headlineAprBps, row.yourAprBps);
                  return (
                    <tr
                      key={row.poolId}
                      className={`border-b border-border last:border-0 ${row.excluded ? 'opacity-60' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.pair.join(' / ')}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.dex} · {row.chain} · ±{row.deltaBps}bp
                        </div>
                      </td>

                      <td className="tabular px-4 py-3 text-right text-muted-foreground">
                        {aprFromBps(row.headlineAprBps)}
                      </td>

                      <td className="tabular px-4 py-3 text-right">
                        {row.excluded ? (
                          <span className="text-xs tracking-wide text-muted-foreground uppercase">
                            excluded
                          </span>
                        ) : (
                          <span className="text-base font-semibold text-primary">
                            {aprFromBps(row.yourAprBps)}
                          </span>
                        )}
                      </td>

                      <td className="tabular px-4 py-3 text-right">
                        {gap === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className={`font-semibold ${gapTone(gap.direction)}`}>
                            {gap.label}
                          </span>
                        )}
                      </td>

                      <td className="tabular px-4 py-3 text-right text-muted-foreground">
                        {usdCompact(row.tvlUsd)}
                      </td>

                      <td className="tabular px-4 py-3 text-right">
                        {row.activeTvlUsd === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            <div>{usdCompact(row.activeTvlUsd)}</div>
                            <div className="text-xs text-muted-foreground">
                              {percentFromFraction(row.activeTvlShare)} of TVL
                            </div>
                          </>
                        )}
                      </td>

                      <td className="max-w-md px-4 py-3">
                        <p className="text-xs leading-relaxed text-muted-foreground">{row.reason}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {row.flags
                            .filter((f) => !PROVENANCE_FLAGS.has(f))
                            .map((flag) => (
                              <Flag key={flag} flag={flag} />
                            ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {scrolls && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b bg-gradient-to-t from-background to-transparent"
            />
          )}
        </div>

        <div className="relative lg:hidden">
          <ul
            className={`divide-y divide-border rounded border border-border ${scrolls ? 'max-h-[32rem] overflow-y-auto' : ''}`}
          >
            {rows.map((row) => {
              const gap = row.excluded ? null : gapInPoints(row.headlineAprBps, row.yourAprBps);
              return (
                <li key={row.poolId} className={`p-4 ${row.excluded ? 'opacity-60' : ''}`}>
                  <div className="font-medium">{row.pair.join(' / ')}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.dex} · {row.chain} · ±{row.deltaBps}bp
                  </div>

                  <div className="tabular mt-2 flex items-baseline gap-2">
                    {row.excluded ? (
                      <span className="text-xs tracking-wide text-muted-foreground uppercase">
                        excluded
                      </span>
                    ) : (
                      <>
                        <span className="text-xl font-semibold text-primary">
                          {aprFromBps(row.yourAprBps)}
                        </span>
                        {gap && (
                          <span className={`text-sm font-medium ${gapTone(gap.direction)}`}>
                            {gap.label}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{row.reason}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {row.flags
                      .filter((f) => !PROVENANCE_FLAGS.has(f))
                      .map((flag) => (
                        <Flag key={flag} flag={flag} />
                      ))}
                  </div>

                  <details className="group mt-3 text-xs">
                    <summary className="-mx-2 flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-sm px-2 text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none group-open:bg-muted group-open:text-foreground">
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90"
                        aria-hidden
                      />
                      Headline APR, TVL, in-range detail
                    </summary>
                    <dl className="tabular mt-1 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-sm bg-muted/40 p-3">
                      <dt className="text-muted-foreground">Headline APR</dt>
                      <dd className="text-right">{aprFromBps(row.headlineAprBps)}</dd>
                      <dt className="text-muted-foreground">TVL</dt>
                      <dd className="text-right">{usdCompact(row.tvlUsd)}</dd>
                      <dt className="text-muted-foreground">In range</dt>
                      <dd className="text-right">
                        {row.activeTvlUsd === null ? '—' : usdCompact(row.activeTvlUsd)}
                        {row.activeTvlShare !== null && (
                          <span className="text-muted-foreground">
                            {' '}
                            ({percentFromFraction(row.activeTvlShare)})
                          </span>
                        )}
                      </dd>
                    </dl>
                  </details>
                </li>
              );
            })}
          </ul>
          {scrolls && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b bg-gradient-to-t from-background to-transparent"
            />
          )}
        </div>
      </>
    );
  }

export function PoolTableSkeleton() {
  return (
    <div className="space-y-px rounded border border-border p-4" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 py-3">
          <div className="h-9 w-40 animate-pulse rounded bg-muted" />
          <div className="ml-auto h-5 w-16 animate-pulse rounded bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded bg-muted" />
          <div className="h-5 w-14 animate-pulse rounded bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded bg-muted" />
          <div className="h-5 w-32 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
