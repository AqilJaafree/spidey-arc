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
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${tone}`}
    >
      {FLAG_LABELS[flag] ?? flag}
    </span>
  );
}
