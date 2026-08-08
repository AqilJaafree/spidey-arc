/**
 * Which chain a venue's capital is on.
 *
 * The mapping is not a new table: `LPVault.registerVenue` already stores a
 * CCTP `chainDomain` per venue, and `relay.ts` already knows each chain's
 * domain. All that was missing is the inversion — so this reads the vault
 * rather than keeping a second copy that can drift, the same reason the NAV
 * reporter reads the contract's bounds instead of hardcoding them.
 *
 * This is the last link between a plan and a relay: the planner emits
 * `action: 'return'` with a `fromVenueId`, and `bridgeAndBook` needs a
 * `RelayChain`.
 */

import type { Address, PublicClient } from 'viem';
import { CCTP_DOMAINS, RELAY_CHAINS, type RelayChain } from './relay.js';

export const VENUE_ABI = [
  {
    type: 'function', name: 'venues', stateMutability: 'view',
    inputs: [{ name: 'venueId', type: 'uint16' }],
    outputs: [
      { name: 'deployedAssets', type: 'uint128' },
      { name: 'lastRebalanceAt', type: 'uint64' },
      { name: 'scoreBps', type: 'uint32' },
      { name: 'venueId', type: 'uint16' },
      { name: 'chainDomain', type: 'uint8' },
      { name: 'flags', type: 'uint8' },
    ],
  },
] as const;

/**
 * The chain that claims a CCTP domain.
 *
 * Throws rather than returning a default: a venue whose domain matches no
 * configured chain is a keeper that has not been told about a chain capital is
 * already sitting on, and guessing would book it against the wrong one.
 */
export function chainForDomain(domain: number): RelayChain {
  const match = RELAY_CHAINS.find((c) => CCTP_DOMAINS[c] === domain);
  if (!match) throw new RangeError(`no configured chain claims CCTP domain ${domain}`);
  return match;
}

/** Resolve a venue id to its chain, from what the vault recorded. */
export async function readVenueChain(
  client: PublicClient,
  vault: Address,
  venueId: number,
): Promise<RelayChain> {
  const venue = (await client.readContract({
    address: vault, abi: VENUE_ABI, functionName: 'venues', args: [venueId],
  })) as readonly [bigint, bigint, number, number, number, number];
  return chainForDomain(Number(venue[4]));
}
