import { FLAG_LABELS, type PoolFlag } from '@/lib/api';

/** Flags that mean "this pool is worse than it looks" get warning colour. */
const CAUTION: ReadonlySet<PoolFlag> = new Set([
  'dilution',
  'one-whale-volume',
  'cost-exceeds-edge',
  'fails-entry-condition',
  'emissions-dependent',
]);

const EXCLUSION: ReadonlySet<PoolFlag> = new Set([
  'no-active-tvl',
  'stale',
  'range-width-mismatch',
]);

export function Flag({ flag }: { flag: PoolFlag }) {
  const tone = EXCLUSION.has(flag)
    ? 'border-destructive/40 text-destructive'
    : CAUTION.has(flag)
      ? 'border-warning/40 text-warning'
      : 'border-border text-muted-foreground';

  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[0.6875rem] tracking-wide whitespace-nowrap uppercase ${tone}`}
    >
      {FLAG_LABELS[flag] ?? flag}
    </span>
  );
}
