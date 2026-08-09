import { PROVENANCE_FLAGS, type CompareRow } from '@/lib/api';
import { aprFromBps } from '@/lib/format';
import { Flag } from './Flag';

/**
 * Excluded pools grouped by their exact reason text, not listed flat.
 *
 * Ten-plus rows sharing byte-identical reason text (differing only by DEX
 * name) is real information at first read and pure repetition by the fifth
 * — the same "wall of duplicates" problem a card grid has, just rendered as
 * table rows. Grouping keeps the reason at full weight (nothing here is
 * hidden or softened) while removing the repetition cost; expanding a group
 * still names every excluded pool individually.
 */
export function ExcludedGroups({ rows }: { rows: CompareRow[] }) {
  const groups = new Map<string, CompareRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.reason);
    if (bucket) bucket.push(row);
    else groups.set(row.reason, [row]);
  }

  return (
    <ul className="divide-y divide-border rounded border border-border">
      {[...groups.entries()].map(([reason, group]) => (
        <li key={reason}>
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-4 p-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none">
              <div>
                <span className="font-medium">
                  {group.length} pool{group.length === 1 ? '' : 's'}
                </span>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{reason}</p>
              </div>
              <span
                aria-hidden
                className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              >
                ▾
              </span>
            </summary>

            <ul className="divide-y divide-border border-t border-border">
              {group.map((row) => (
                <li key={row.poolId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <div>
                    <span className="text-sm">{row.pair.join(' / ')}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {row.dex} · {row.chain}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="tabular text-xs text-muted-foreground">
                      headline {aprFromBps(row.headlineAprBps)}
                    </span>
                    {row.flags
                      .filter((f) => !PROVENANCE_FLAGS.has(f))
                      .map((flag) => (
                        <Flag key={flag} flag={flag} />
                      ))}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}
