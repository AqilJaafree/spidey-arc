'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PROVENANCE_FLAGS, type CompareRow } from '@/lib/api';
import { aprFromBps } from '@/lib/format';
import { Flag } from './Flag';

/** Past this many groups the list scrolls internally instead of the whole page growing. */
const SCROLL_THRESHOLD = 5;

/**
 * A group can be one DEX's entire universe under "All pairs" — 60+ pools is
 * real, not hypothetical. A "show all" reveal dumped every row into the same
 * bounded scroll region as the other groups — technically one scroll area,
 * but scrolling through 60 rows in a ~500px window is its own kind of
 * annoying. Paging keeps each page's height compact and predictable instead,
 * so there's nothing to fight through — hence real pagination, not a bigger
 * reveal.
 */
const CHILD_PAGE_SIZE = 10;

/**
 * Excluded pools grouped by their exact reason text, not listed flat.
 *
 * Ten-plus rows sharing byte-identical reason text (differing only by DEX
 * name) is real information at first read and pure repetition by the fifth
 * — the same "wall of duplicates" problem a card grid has, just rendered as
 * table rows. Grouping keeps the reason at full weight (nothing here is
 * hidden or softened) while removing the repetition cost; expanding a group
 * still names every excluded pool individually. The expanded pools sit on a
 * tinted, indented sub-list so the parent group and its children read as a
 * hierarchy, not two rows of the same weight.
 */
export function ExcludedGroups({ rows }: { rows: CompareRow[] }) {
  const groups = new Map<string, CompareRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.reason);
    if (bucket) bucket.push(row);
    else groups.set(row.reason, [row]);
  }
  const scrolls = groups.size > SCROLL_THRESHOLD;

  return (
    <div className="relative">
      <ul
        className={`divide-y divide-border rounded border border-border ${scrolls ? 'max-h-[32rem] overflow-y-auto' : ''}`}
      >
        {[...groups.entries()].map(([reason, group]) => (
          <li key={reason}>
            <details className="group">
              <summary className="flex min-h-11 cursor-pointer list-none items-start gap-3 p-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none group-open:bg-muted">
                <ChevronRight
                  className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90 group-open:text-foreground"
                  aria-hidden
                />
                <div className="flex-1">
                  <span className="font-medium">
                    {group.length} pool{group.length === 1 ? '' : 's'}
                  </span>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{reason}</p>
                </div>
              </summary>

              <GroupChildren group={group} />
            </details>
          </li>
        ))}
      </ul>
      {scrolls && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b bg-gradient-to-t from-background to-transparent"
        />
      )}
    </div>
  );
}

function GroupChildren({ group }: { group: CompareRow[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.ceil(group.length / CHILD_PAGE_SIZE);
  const start = page * CHILD_PAGE_SIZE;
  const visible = group.slice(start, start + CHILD_PAGE_SIZE);

  return (
    <div className="bg-muted/40 pl-11">
      <ul className="divide-y divide-border py-1">
        {visible.map((row) => (
          <li key={row.poolId} className="flex flex-wrap items-center justify-between gap-2 py-2 pr-4">
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

      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-border py-1.5 pr-4">
          <p className="tabular text-xs text-muted-foreground" aria-live="polite">
            {start + 1}–{start + visible.length} of {group.length}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page"
              className="inline-flex h-11 w-11 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <span className="tabular px-1 text-xs text-muted-foreground">
              {page + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page === pageCount - 1}
              aria-label="Next page"
              className="inline-flex h-11 w-11 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
