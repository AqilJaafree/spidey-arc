/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DilutionChart, spreadLabels } from './DilutionChart';
import type { Curvable } from '@/lib/dilution';

const pool = (over: Partial<Curvable>): Curvable => ({
  poolId: 'p',
  label: 'SOL/USDC',
  activeTvlUsd: 1_000_000,
  yourAprBps: 1_000,
  atSizeUsd: 10_000,
  ...over,
});

const THIN = pool({ poolId: 'thin', label: 'THIN/USDC', activeTvlUsd: 20_000, yourAprBps: 4_000 });
const DEEP = pool({ poolId: 'deep', label: 'DEEP/USDC', activeTvlUsd: 5_000_000, yourAprBps: 900 });

describe('DilutionChart', () => {
  it('direct-labels every series, which the four-slot palette requires', () => {
    render(<DilutionChart pools={[THIN, DEEP]} atSizeUsd={10_000} />);
    // Each label appears twice by design: once on the line's right edge, once
    // in the readout row beneath the plot.
    expect(screen.getAllByText('THIN/USDC').length).toBeGreaterThan(0);
    expect(screen.getAllByText('DEEP/USDC').length).toBeGreaterThan(0);
  });

  // The whole reason the chart replaced the formula.
  it('names where the better venue changes', () => {
    render(<DilutionChart pools={[THIN, DEEP]} atSizeUsd={10_000} />);
    expect(screen.getByText(/pays more than/i)).toBeInTheDocument();
  });

  it('says nothing about crossings when one venue leads throughout', () => {
    const a = pool({ poolId: 'a', label: 'A', activeTvlUsd: 1_000_000, yourAprBps: 2_000 });
    const b = pool({ poolId: 'b', label: 'B', activeTvlUsd: 1_000_000, yourAprBps: 500 });
    render(<DilutionChart pools={[a, b]} atSizeUsd={10_000} />);
    expect(screen.queryByText(/pays more than/i)).not.toBeInTheDocument();
  });

  // Excluded rows stay excluded: a drawn line reads as a measurement.
  it('drops a pool with no in-range denominator rather than guessing one', () => {
    const blind = pool({ poolId: 'blind', label: 'BLIND/USDC', activeTvlUsd: null });
    render(<DilutionChart pools={[THIN, DEEP, blind]} atSizeUsd={10_000} />);
    expect(screen.queryAllByText('BLIND/USDC')).toHaveLength(0);
  });

  it('renders nothing at all when fewer than two venues can be curved', () => {
    const { container } = render(<DilutionChart pools={[THIN]} atSizeUsd={10_000} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('caps at the four validated colour slots', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      pool({ poolId: `p${i}`, label: `P${i}/USDC`, yourAprBps: 2_000 - i * 100 }),
    );
    render(<DilutionChart pools={many} atSizeUsd={10_000} />);
    expect(screen.getAllByText('P0/USDC').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('P4/USDC')).toHaveLength(0);
  });

  // Contrast on the light surface WARNs for two slots; the relief rule says
  // ship visible labels or a table. Both are here, and the table is reachable.
  it('offers the numbers as a table', async () => {
    const user = userEvent.setup();
    render(<DilutionChart pools={[THIN, DEEP]} atSizeUsd={10_000} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show these as numbers/i }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('describes itself for a screen reader', () => {
    render(<DilutionChart pools={[THIN, DEEP]} atSizeUsd={10_000} />);
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('deposit size'),
    );
  });

  it('reads out each venue at the size being asked about', () => {
    render(<DilutionChart pools={[THIN, DEEP]} atSizeUsd={10_000} />);
    // THIN at $10k: K = 4000 * (20k + 10k) = 1.2e8; 1.2e8 / 30k = 4000bps.
    expect(screen.getByText('40.00%')).toBeInTheDocument();
  });
});

describe('spreadLabels', () => {
  // Found by rendering the chart and looking at it: every curve converges
  // toward zero at the right edge, so all four labels landed on the same few
  // pixels and were unreadable. No colour or unit test could have caught it.
  it('pushes stacked labels apart', () => {
    const out = spreadLabels([300, 302, 304, 306], 20, 320);
    for (let i = 1; i < out.length; i++) {
      expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(12.9);
    }
  });

  it('leaves well-separated labels where they are', () => {
    const input = [40, 120, 200, 280];
    expect(spreadLabels(input, 20, 320)).toEqual(input);
  });

  it('keeps every label inside the plot', () => {
    const out = spreadLabels([318, 319, 319.5, 320], 20, 320);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(320);
    }
  });

  // Order is identity here: label i must stay with curve i, or every line is
  // captioned with someone else's name.
  it('returns positions in the caller\'s original order', () => {
    const out = spreadLabels([300, 100, 200], 20, 320);
    expect(out[1]).toBeLessThan(out[2]);
    expect(out[2]).toBeLessThan(out[0]);
  });
});
