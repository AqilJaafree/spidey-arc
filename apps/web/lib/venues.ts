/**
 * The hub's spokes, and what each is doing right now.
 *
 * Arc holds no venue of its own — every route leaves the chain. The diagram on
 * `/vault` is that topology, and its motion is driven from here rather than
 * from a timer, so a pulse on a path means capital is genuinely in flight.
 */

/** `LPVault.VenueState` flag bits. */
export const FLAG_ACTIVE = 1;
export const FLAG_PAUSED = 2;
export const FLAG_PENDING_HOOK = 4;

export type Spoke = {
  venueId: number;
  chain: string;
  /** CCTP domain, as `registerVenue` recorded it. */
  cctpDomain: number;
  /** What sits at the far end. */
  lands: string;
};

/**
 * Venue 2's route mints into `CctpReturnRelay`, not the Base vault — capital
 * Arc sends out lands somewhere whose only exit is back to Arc.
 */
export const SPOKES: Spoke[] = [
  { venueId: 2, chain: 'Base Sepolia', cctpDomain: 6, lands: 'CctpReturnRelay' },
  { venueId: 3, chain: 'Solana devnet', cctpDomain: 5, lands: 'MeteoraReceiver' },
];

/** One row of `LPVault.venues(id)`, pared to what the diagram reads. */
export type VenueRecord = {
  venueId: number;
  deployed: bigint;
  chainDomain: number;
  flags: number;
};

export type RouteStatus = 'unregistered' | 'idle' | 'deployed' | 'inFlight' | 'paused';

export type Route = Spoke & {
  status: RouteStatus;
  deployed: bigint;
};

/** Which of these is true, in the order that decides what the path shows. */
function statusOf(record: VenueRecord | undefined): RouteStatus {
  if (!record || (record.flags & FLAG_ACTIVE) === 0) return 'unregistered';
  // In flight outranks paused and deployed: it is the only state where the
  // capital is claimable nowhere, so it is the one worth showing.
  if (record.flags & FLAG_PENDING_HOOK) return 'inFlight';
  if (record.flags & FLAG_PAUSED) return 'paused';
  return record.deployed > 0n ? 'deployed' : 'idle';
}

export function routeStates(records: VenueRecord[]): Route[] {
  return SPOKES.map((spoke) => {
    const record = records.find((r) => r.venueId === spoke.venueId);
    return { ...spoke, status: statusOf(record), deployed: record?.deployed ?? 0n };
  });
}

export const ROUTE_LABEL: Record<RouteStatus, string> = {
  unregistered: 'not registered',
  idle: 'registered, empty',
  deployed: 'holding',
  inFlight: 'in flight',
  paused: 'paused',
};
