import { PROVENANCE_FLAGS, type CompareRow } from '@/lib/api';
import { aprFromBps, gapInPoints, percentFromFraction, usdCompact } from '@/lib/format';
import { Flag } from './Flag';

/**
 * The comparison table. Two APR columns sit next to each other on purpose:
 * the left is what a dashboard prints, the right is what this deposit
 * actually earns. The gap between them is the product.
 */
export function PoolTable({ rows }: { rows: CompareRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[52rem] text-sm">
        <caption className="sr-only">
          USDC LP venues, showing headline APR against the APR for your deposit size
        </caption>
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left">
            <th scope="col" className="px-4 py-3 font-medium">
              Pool
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">
              Headline APR
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium">
              Your APR
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">
              Gap
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">
              TVL
            </th>
            <th scope="col" className="px-4 py-3 text-right font-medium text-muted-foreground">
              In range
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Why
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
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
                  <span className="text-base font-semibold">{aprFromBps(row.yourAprBps)}</span>
                )}
              </td>

              <td className="tabular px-4 py-3 text-right">
                {(() => {
                  const gap = row.excluded ? null : gapInPoints(row.headlineAprBps, row.yourAprBps);
                  if (gap === null) return <span className="text-muted-foreground">—</span>;
                  const tone =
                    gap.direction === 'below'
                      ? 'text-warning'
                      : gap.direction === 'above'
                        ? 'text-success'
                        : 'text-muted-foreground';
                  return <span className={tone}>{gap.label}</span>;
                })()}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PoolTableSkeleton() {
  return (
    <div className="space-y-px rounded-xl border border-border p-4" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 py-3">
          <div className="h-9 w-48 animate-pulse rounded bg-muted" />
          <div className="ml-auto h-5 w-20 animate-pulse rounded bg-muted" />
          <div className="h-5 w-20 animate-pulse rounded bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded bg-muted" />
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
