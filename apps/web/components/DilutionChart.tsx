'use client';

import { useId, useMemo, useState } from 'react';

import { crossovers, curveFor, logSizes, type Curvable } from '@/lib/dilution';
import { usdCompact } from '@/lib/format';

/**
 * What each venue pays across deposit sizes.
 *
 * This replaces the formula that used to sit in the footer. The equation was
 * correct and unread: `365 · f · V_δ / (T_δ + A)` asks the reader to imagine a
 * hyperbola, and the product's entire claim lives in that shape. Drawn, the
 * claim is immediate — the lines cross, so the best venue depends on how much
 * you deposit, which is the one thing no dashboard asks you.
 *
 * Every curve is exact rather than fitted: only the denominator contains A, so
 * the engine's one published point pins the rest. See `lib/dilution.ts`.
 */

/** Categorical slots 1–4, validated against both card surfaces. */
const SERIES = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
];

const MIN_SIZE = 100;
const MAX_SIZE = 1_000_000;
const SAMPLES = 72;

const W = 720;
const H = 320;
const PAD = { top: 20, right: 156, bottom: 40, left: 52 };
/** Minimum vertical gap between two right-edge labels, in viewBox units. */
const LABEL_GAP = 13;

/**
 * Round up to a clean axis maximum.
 *
 * The ladder is deliberately fine. A coarse one (1, 2, 5, 10) sends a 578%
 * peak to 1000% and throws away half the plot height — the curves then live in
 * the bottom third and the crossings compress into nothing.
 */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const n = value / magnitude;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((c) => n <= c) ?? 10;
  return step * magnitude;
}

/**
 * Push labels apart so none overlaps its neighbour.
 *
 * Every curve converges toward zero at the right edge — that is what dilution
 * *is* — so the labels arrive stacked on the same few pixels. Rendering the
 * chart and looking at it is the only way this shows up; the palette validator
 * checks colour, not collision.
 *
 * Each label keeps its curve's order, gets nudged to clear `LABEL_GAP`, and a
 * connector is drawn back to the true endpoint so the nudge cannot be mistaken
 * for the data.
 */
export function spreadLabels(ys: number[], min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);

  let cursor = min;
  for (const item of order) {
    item.y = Math.max(item.y, cursor);
    cursor = item.y + LABEL_GAP;
  }
  // If that pushed the last one past the floor, walk back up.
  let ceiling = max;
  for (let k = order.length - 1; k >= 0; k--) {
    order[k].y = Math.min(order[k].y, ceiling);
    ceiling = order[k].y - LABEL_GAP;
  }

  const out = new Array<number>(ys.length);
  for (const item of order) out[item.i] = item.y;
  return out;
}

type Props = { pools: Curvable[]; atSizeUsd: number };

export function DilutionChart({ pools, atSizeUsd }: Props) {
  const gradientId = useId();
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const model = useMemo(() => {
    const sizes = logSizes(MIN_SIZE, MAX_SIZE, SAMPLES);

    const series = pools
      .map((p) => ({ pool: p, f: curveFor(p) }))
      .filter((s): s is { pool: Curvable; f: (n: number) => number } => s.f !== null)
      // Rank by what they pay at the size actually being asked about, so the
      // colours match the table above rather than some other ordering.
      .sort((a, b) => b.f(atSizeUsd) - a.f(atSizeUsd))
      .slice(0, SERIES.length)
      .map((s, i) => ({
        ...s,
        colour: SERIES[i],
        points: sizes.map((size) => ({ size, apr: s.f(size) })),
      }));

    const maxApr = niceCeil(Math.max(...series.flatMap((s) => s.points.map((p) => p.apr)), 1));
    return {
      sizes,
      series,
      maxApr,
      crossings: crossovers(
        series.map((s) => s.pool),
        sizes,
      ),
    };
  }, [pools, atSizeUsd]);

  if (model.series.length < 2) return null;

  const x = (size: number) =>
    PAD.left +
    ((Math.log10(size) - Math.log10(MIN_SIZE)) / (Math.log10(MAX_SIZE) - Math.log10(MIN_SIZE))) *
      (W - PAD.left - PAD.right);
  const y = (aprBps: number) =>
    PAD.top + (1 - aprBps / model.maxApr) * (H - PAD.top - PAD.bottom);

  const path = (points: { size: number; apr: number }[]) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.size).toFixed(2)} ${y(p.apr).toFixed(2)}`).join(' ');

  const ticks = [100, 1_000, 10_000, 100_000, 1_000_000];
  const aprTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * model.maxApr);

  const endYs = model.series.map((s) => y(s.points[s.points.length - 1].apr));
  const labelYs = spreadLabels(endYs, PAD.top + 4, H - PAD.bottom - 2);

  // Nearest sample to the pointer, so the readout lands on real data.
  const hovered =
    hoverX === null
      ? null
      : model.sizes.reduce((best, s) => (Math.abs(x(s) - hoverX) < Math.abs(x(best) - hoverX) ? s : best));

  const readoutSize = hovered ?? atSizeUsd;

  return (
    <figure className="rounded border border-border bg-card p-5 sm:p-6">
      <figcaption className="text-sm font-semibold">Your rate as the amount grows</figcaption>
      <p className="mt-1 mb-4 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        The more you put in, the more people share the same fees — so every line slopes down.
        Small pools drop fastest. Where two lines cross, the better pool swaps.
      </p>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full min-w-[560px] text-muted-foreground"
          role="img"
          aria-label={`Estimated yearly rate against deposit size for ${model.series.length} pools, with ${
            model.crossings.length
          } points where the best pool changes, between $100 and $1M`}
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setHoverX(((e.clientX - box.left) / box.width) * W);
          }}
          onMouseLeave={() => setHoverX(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.07" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* --- grid, recessive ------------------------------------------ */}
          {aprTicks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)}
                className="stroke-current opacity-15"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8} y={y(t) + 3.5} textAnchor="end"
                className="fill-current text-[10px] tabular opacity-70"
              >
                {(t / 100).toFixed(0)}%
              </text>
            </g>
          ))}

          {ticks.map((t) => (
            <text
              key={t} x={x(t)} y={H - PAD.bottom + 16} textAnchor="middle"
              className="fill-current text-[10px] tabular opacity-70"
            >
              {usdCompact(t)}
            </text>
          ))}

          {/* --- the size the table above is showing ---------------------- */}
          {atSizeUsd >= MIN_SIZE && atSizeUsd <= MAX_SIZE && (
            <>
              <line
                x1={x(atSizeUsd)} x2={x(atSizeUsd)} y1={PAD.top} y2={H - PAD.bottom}
                className="stroke-current opacity-40" strokeWidth={1} strokeDasharray="3 3"
              />
              <text
                x={x(atSizeUsd)} y={PAD.top - 4} textAnchor="middle"
                className="fill-current text-[9px] tabular opacity-70"
              >
                your amount
              </text>
            </>
          )}

          {/* --- crossings: the headline ---------------------------------- */}
          {model.crossings.map((c) => (
            <line
              key={`${c.fromPoolId}-${c.toPoolId}-${c.sizeUsd}`}
              x1={x(c.sizeUsd)} x2={x(c.sizeUsd)} y1={PAD.top} y2={H - PAD.bottom}
              className="stroke-warning opacity-45" strokeWidth={1}
            />
          ))}

          {/* --- series --------------------------------------------------- */}
          {model.series.map((s, i) => {
            const last = s.points[s.points.length - 1];
            return (
              <g key={s.pool.poolId}>
                <path
                  d={path(s.points)}
                  fill="none"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ stroke: `var(--series-${i + 1})` }}
                />
                {/* Direct label — mandatory at four series, and the relief the
                    light-mode contrast warning requires. Nudged clear of its
                    neighbours, with a connector back to the real endpoint. */}
                <polyline
                  points={`${W - PAD.right},${y(last.apr)} ${W - PAD.right + 10},${labelYs[i]} ${W - PAD.right + 15},${labelYs[i]}`}
                  fill="none"
                  strokeWidth={1}
                  className="opacity-50"
                  style={{ stroke: `var(--series-${i + 1})` }}
                />
                <circle
                  cx={W - PAD.right} cy={y(last.apr)} r={2.5}
                  style={{ fill: `var(--series-${i + 1})` }}
                />
                <text
                  x={W - PAD.right + 19}
                  y={labelYs[i] + 3.5}
                  className="fill-foreground text-[10px]"
                >
                  {s.pool.label.length > 22 ? `${s.pool.label.slice(0, 21)}\u2026` : s.pool.label}
                </text>
              </g>
            );
          })}

          {/* --- hover crosshair ------------------------------------------ */}
          {hovered !== null && (
            <>
              <line
                x1={x(hovered)} x2={x(hovered)} y1={PAD.top} y2={H - PAD.bottom}
                className="stroke-current opacity-50" strokeWidth={1}
              />
              {model.series.map((s, i) => (
                <circle
                  key={s.pool.poolId}
                  cx={x(hovered)} cy={y(s.f(hovered))} r={4}
                  strokeWidth={2}
                  className="stroke-card"
                  style={{ fill: `var(--series-${i + 1})` }}
                />
              ))}
            </>
          )}
        </svg>
      </div>

      {/* --- readout, in text tokens rather than series colour ----------- */}
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-xs">
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">at</dt>
          <dd className="tabular font-medium">{usdCompact(readoutSize)}</dd>
        </div>
        {model.series.map((s, i) => (
          <div key={s.pool.poolId} className="flex items-baseline gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-[1px]"
              style={{ background: `var(--series-${i + 1})` }}
            />
            <dt className="text-muted-foreground">{s.pool.label}</dt>
            <dd className="tabular font-medium">{(s.f(readoutSize) / 100).toFixed(2)}%</dd>
          </div>
        ))}
      </dl>

      {model.crossings.length > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-warning">
          {model.crossings.map((c, i) => (
            <span key={`${c.fromPoolId}-${c.toPoolId}`}>
              {i > 0 && ' '}
              Above {usdCompact(c.sizeUsd)}, {c.to} pays more than {c.from}.
            </span>
          ))}
        </p>
      )}

      <button
        type="button"
        onClick={() => setShowTable((v) => !v)}
        aria-expanded={showTable}
        className="mt-3 inline-flex min-h-11 items-center text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {showTable ? 'Hide the numbers' : 'Show these as numbers'}
      </button>

      {showTable && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">Estimated yearly rate by amount</caption>
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th scope="col" className="py-1.5 pr-4 font-medium">Amount</th>
                {model.series.map((s) => (
                  <th key={s.pool.poolId} scope="col" className="py-1.5 pr-4 font-medium">
                    {s.pool.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {ticks.map((t) => (
                <tr key={t} className="border-b border-border/50">
                  <th scope="row" className="py-1.5 pr-4 text-left font-normal">{usdCompact(t)}</th>
                  {model.series.map((s) => (
                    <td key={s.pool.poolId} className="py-1.5 pr-4">
                      {(s.f(t) / 100).toFixed(2)}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
