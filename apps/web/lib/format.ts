/**
 * Number formatting for a comparison table.
 *
 * Two rules do most of the work here: every numeric cell is tabular so digits
 * line up column-wise, and magnitudes are abbreviated so a $112,198,063 does
 * not shove a $15 off the screen. Percentages keep a fixed decimal count for
 * the same reason.
 */

/** `$1.2M`, `$45.6k`, `$980`. */
export function usdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

/** `$10,000` — full precision, for the input echo. */
export function usdFull(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/**
 * Basis points as a percentage.
 *
 * APRs in thin pools genuinely reach five figures, so anything at or above
 * 1,000% drops its decimals — `16,842%` reads; `16,842.61%` is noise.
 */
export function aprFromBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  const pct = bps / 100;
  if (Math.abs(pct) >= 1000) return `${Math.round(pct).toLocaleString('en-US')}%`;
  if (Math.abs(pct) >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

/** `53.9%` from a 0–1 fraction. */
export function percentFromFraction(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** `12.4×` — a bare ratio. */
export function multiple(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 100) return `${Math.round(value).toLocaleString('en-US')}×`;
  return `${value.toFixed(1)}×`;
}

/**
 * The gap between the headline number and yours, in percentage points.
 *
 * Signed on purpose. The headline is not always too high: a tight stable
 * range divides fees by in-range liquidity rather than by full TVL, so the
 * real yield can land well ABOVE what a dashboard prints. Showing only an
 * "overstated by N×" multiple would misreport exactly those cases, which are
 * the ones a USDC vault most wants to find.
 */
export function gapInPoints(
  headlineBps: number | null | undefined,
  yourBps: number | null | undefined,
): { label: string; direction: 'above' | 'below' | 'level' } | null {
  if (
    headlineBps === null ||
    headlineBps === undefined ||
    yourBps === null ||
    yourBps === undefined
  ) {
    return null;
  }
  const points = (yourBps - headlineBps) / 100;
  if (Math.abs(points) < 0.05) return { label: 'matches', direction: 'level' };
  const magnitude =
    Math.abs(points) >= 1000
      ? Math.round(Math.abs(points)).toLocaleString('en-US')
      : Math.abs(points).toFixed(Math.abs(points) >= 10 ? 1 : 2);
  return {
    label: `${points > 0 ? '+' : '−'}${magnitude}pp`,
    direction: points > 0 ? 'above' : 'below',
  };
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
