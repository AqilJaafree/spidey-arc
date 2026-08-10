/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CrossChainFlow } from './CrossChainFlow';
import { routeStates } from '@/lib/venues';

const venue = (venueId: number, chainDomain: number, deployed: bigint, flags: number) => ({
  venueId,
  chainDomain,
  deployed,
  flags,
});

function renderFlow(records: ReturnType<typeof venue>[], hub = 1_499_935n) {
  return render(<CrossChainFlow routes={routeStates(records)} hubAssets={hub} />);
}

describe('CrossChainFlow', () => {
  it('names both spokes and their CCTP domains', () => {
    renderFlow([venue(2, 6, 0n, 1), venue(3, 5, 0n, 1)]);

    expect(screen.getByText('Base Sepolia')).toBeInTheDocument();
    expect(screen.getByText('Solana devnet')).toBeInTheDocument();
    expect(screen.getByText('domain 6')).toBeInTheDocument();
    expect(screen.getByText('domain 5')).toBeInTheDocument();
  });

  // Where Arc's capital lands is the whole custody argument: venue 2 mints
  // into the relay, not the Base vault, so it can only come home.
  it('says what sits at the far end of each route', () => {
    renderFlow([venue(2, 6, 0n, 1), venue(3, 5, 0n, 1)]);
    expect(screen.getByText('CctpReturnRelay')).toBeInTheDocument();
    expect(screen.getByText('MeteoraReceiver')).toBeInTheDocument();
  });

  it('stays quiet when nothing is moving', () => {
    const { container } = renderFlow([venue(2, 6, 0n, 1), venue(3, 5, 500_000n, 1)]);
    expect(container.querySelector('.stroke-warning')).toBeNull();
    expect(screen.queryByText(/claimable in neither/i)).not.toBeInTheDocument();
  });

  // Motion is load-bearing here rather than decorative: a travelling dash
  // means FLAG_PENDING_HOOK is set, and nothing else can make it appear.
  it('animates only the path whose venue is in flight', () => {
    const { container } = renderFlow([
      venue(2, 6, 0n, 1),
      venue(3, 5, 500_000n, 1 | 4),
    ]);
    expect(container.querySelectorAll('.stroke-warning')).toHaveLength(1);
    expect(screen.getByText(/claimable in neither/i)).toBeInTheDocument();
  });

  it('shows an unregistered spoke as absent rather than empty', () => {
    renderFlow([venue(2, 6, 0n, 1)]);
    expect(screen.getByText(/not registered/)).toBeInTheDocument();
  });

  it('distinguishes a paused venue from an idle one', () => {
    renderFlow([venue(2, 6, 0n, 1 | 2), venue(3, 5, 0n, 1)]);
    expect(screen.getByText(/paused/)).toBeInTheDocument();
  });

  it('describes the whole picture to a screen reader', () => {
    renderFlow([venue(2, 6, 0n, 1), venue(3, 5, 500_000n, 1 | 4)]);
    const figure = screen.getByRole('img');
    expect(figure).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Solana devnet in flight'),
    );
  });

  it('reports the hub balance', () => {
    renderFlow([venue(2, 6, 0n, 1)], 1_499_935n);
    expect(screen.getByText('$1.499935')).toBeInTheDocument();
  });
});
