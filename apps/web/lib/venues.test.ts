import { describe, expect, it } from 'vitest';
import { SPOKES, routeStates, type VenueRecord } from './venues';

const record = (over: Partial<VenueRecord> = {}): VenueRecord => ({
  venueId: 2,
  deployed: 0n,
  chainDomain: 6,
  flags: 1, // ACTIVE
  ...over,
});

describe('SPOKES', () => {
  it('carries the CCTP domains the hub actually routes to', () => {
    expect(SPOKES.map((s) => s.cctpDomain)).toEqual([6, 5]);
  });
});

describe('routeStates', () => {
  it('reports a registered but empty venue as idle', () => {
    const [base] = routeStates([record()]);
    expect(base.status).toBe('idle');
    expect(base.deployed).toBe(0n);
  });

  it('reports capital sitting at a venue as deployed', () => {
    const [base] = routeStates([record({ deployed: 500_000n })]);
    expect(base.status).toBe('deployed');
  });

  // FLAG_PENDING_HOOK is bit 2. It is the one state `deployedAssets` alone
  // cannot express: burned on Arc, not yet minted at the destination, so the
  // capital is claimable nowhere. That is what the pulse animates.
  it('reports a burned-but-unminted leg as in flight', () => {
    const [base] = routeStates([record({ deployed: 500_000n, flags: 1 | 4 })]);
    expect(base.status).toBe('inFlight');
  });

  it('treats in-flight as in-flight even before the book is credited', () => {
    const [base] = routeStates([record({ deployed: 0n, flags: 1 | 4 })]);
    expect(base.status).toBe('inFlight');
  });

  it('reports an unregistered spoke rather than inventing one', () => {
    const [, solana] = routeStates([record()]);
    expect(solana.status).toBe('unregistered');
  });

  it('reports a paused venue distinctly from an idle one', () => {
    const [base] = routeStates([record({ flags: 1 | 2 })]);
    expect(base.status).toBe('paused');
  });

  // The live hub, 2026-08-10: venue 2 registered and empty, venue 3 carrying
  // 0.5 USDC with the in-flight bit set.
  it('describes the live hub', () => {
    const routes = routeStates([
      record({ venueId: 2, chainDomain: 6, deployed: 0n, flags: 1 }),
      record({ venueId: 3, chainDomain: 5, deployed: 500_000n, flags: 1 | 4 }),
    ]);
    expect(routes.map((r) => r.status)).toEqual(['idle', 'inFlight']);
    expect(routes[1].chain).toBe('Solana devnet');
  });
});
