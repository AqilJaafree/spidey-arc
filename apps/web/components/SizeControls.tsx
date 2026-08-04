'use client';

import { useId } from 'react';

const PRESETS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000];

export function SizeControls({
  sizeUsd,
  holdDays,
  onSizeChange,
  onHoldChange,
}: {
  sizeUsd: number;
  holdDays: number;
  onSizeChange: (value: number) => void;
  onHoldChange: (value: number) => void;
}) {
  const sizeId = useId();
  const holdId = useId();

  return (
    <div className="flex flex-col gap-6 md:flex-row md:items-end md:gap-8">
      <div className="flex-1 space-y-2">
        <label htmlFor={sizeId} className="block text-sm font-medium">
          Your deposit
        </label>
        <div className="relative">
          <span
            className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-2xl text-muted-foreground"
            aria-hidden
          >
            $
          </span>
          <input
            id={sizeId}
            type="number"
            inputMode="numeric"
            min={1}
            step={1000}
            autoComplete="off"
            value={sizeUsd}
            onChange={(e) => {
              const next = Number.parseFloat(e.target.value);
              if (Number.isFinite(next) && next > 0) onSizeChange(next);
            }}
            className="tabular w-full rounded-lg border border-input bg-card py-3 pr-4 pl-9 text-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => onSizeChange(preset)}
              aria-pressed={sizeUsd === preset}
              className={`tabular min-h-10 rounded-md border px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none ${
                sizeUsd === preset
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border hover:bg-muted'
              }`}
            >
              {preset >= 1_000_000 ? `$${preset / 1_000_000}M` : `$${preset / 1_000}k`}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 md:w-48">
        <label htmlFor={holdId} className="block text-sm font-medium">
          Expected hold
        </label>
        <div className="relative">
          <input
            id={holdId}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            autoComplete="off"
            value={holdDays}
            onChange={(e) => {
              const next = Number.parseFloat(e.target.value);
              if (Number.isFinite(next) && next > 0) onHoldChange(next);
            }}
            className="tabular w-full rounded-lg border border-input bg-card py-3 pr-14 pl-4 text-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
          />
          <span
            className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-sm text-muted-foreground"
            aria-hidden
          >
            days
          </span>
        </div>
        <p className="text-xs text-muted-foreground">Sets the cost-payback hurdle.</p>
      </div>
    </div>
  );
}
