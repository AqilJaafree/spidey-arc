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

/** `LPVault.activeVenueBitmap` — bit n set means venue n is registered. */
export const VAULT_BITMAP_ABI = [
  {
    type: 'function', name: 'activeVenueBitmap', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * Which venues sit on a CCTP domain.
 *
 * The inverse of [`readVenueChain`], and the join a bridge arrival needs:
 * `recordBridgeArrival` takes a venue id, but a `DepositForBurn` log carries
 * only the domain it came from.
 *
 * Returns every match rather than the first. Two venues on one chain is legal,
 * and in that case the arrival genuinely is ambiguous — the caller must refuse
 * to book rather than pick one, and it can only do that if it is told.
 *
 * Driven by the bitmap rather than by probing ids: a vault with one venue
 * would otherwise cost 256 reads a tick.
 */
export async function venuesOnDomain(
  client: PublicClient,
  vault: Address,
  domain: number,
): Promise<number[]> {
  const bitmap = (await client.readContract({
    address: vault, abi: VAULT_BITMAP_ABI, functionName: 'activeVenueBitmap',
  })) as bigint;

  const found: number[] = [];
  for (let id = 0; id < 256; id++) {
    if (((bitmap >> BigInt(id)) & 1n) === 0n) continue;
    const venue = await client.readContract({
      address: vault, abi: VENUE_ABI, functionName: 'venues', args: [id],
    });
    if (Number((venue as readonly unknown[])[4]) === domain) found.push(id);
  }
  return found;
}
