/**
 * What the NAV reporter reads, and nothing else.
 *
 * Every function here either returns what it actually read or throws. None of
 * them substitutes a default, and that is deliberate: a zero returned in place
 * of a failed balance read would mark the vault's entire deployed position as
 * lost and haircut every claimant. Refusing to report is reversible; reporting
 * a number nobody measured is not.
 *
 * Clients are passed in rather than constructed here so the decisions above can
 * be tested against stubs, with no network and no chain.
 */

import type { Address, PublicClient } from 'viem';
import type { NavBounds } from './nav.js';

/** `LPVault`'s NAV surface, plus the bounds it enforces. */
export const NAV_ABI = [
  {
    type: 'function', name: 'nav', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'deployedAssets', type: 'uint128' },
      { name: 'updatedAt', type: 'uint64' },
      { name: 'epoch', type: 'uint64' },
    ],
  },
  { type: 'function', name: 'NAV_COOLDOWN', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'MAX_NAV_AGE', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'MAX_NAV_DELTA_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'reportNav', stateMutability: 'nonpayable', inputs: [{ name: 'newDeployedAssets', type: 'uint128' }], outputs: [] },
] as const;

export const RELAY_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export type VaultNav = {
  deployedAssets: bigint;
  updatedAt: number;
  epoch: bigint;
  bounds: NavBounds;
};

/**
 * The vault's current mark and the bounds it will enforce on the next one.
 *
 * Read together, in one run, so the keeper's arithmetic is checked against the
 * same numbers the chain will check it against.
 */
export async function readVaultNav(client: PublicClient, vault: Address): Promise<VaultNav> {
  const [nav, cooldown, maxAge, maxDeltaBps] = await Promise.all([
    client.readContract({ address: vault, abi: NAV_ABI, functionName: 'nav' }),
    client.readContract({ address: vault, abi: NAV_ABI, functionName: 'NAV_COOLDOWN' }),
    client.readContract({ address: vault, abi: NAV_ABI, functionName: 'MAX_NAV_AGE' }),
    client.readContract({ address: vault, abi: NAV_ABI, functionName: 'MAX_NAV_DELTA_BPS' }),
  ]);

  const [deployedAssets, updatedAt, epoch] = nav as readonly [bigint, bigint, bigint];

  // Only what the chain said. The keeper's reporting margin is deliberately
  // absent: `shouldReport` derives it from these three and rejects an
  // incoherent one, so deriving it here too would be a second source of truth
  // for the single bound that can be wrong.
  return {
    deployedAssets,
    updatedAt: Number(updatedAt),
    epoch,
    bounds: {
      navCooldownSeconds: Number(cooldown),
      maxNavAgeSeconds: Number(maxAge),
      maxNavDeltaBps: Number(maxDeltaBps),
    },
  };
}

/** USDC the Base-side relay is holding on the hub's behalf. */
export async function readRelayBalance(
  client: PublicClient,
  usdc: Address,
  relay: Address,
): Promise<bigint> {
  return client.readContract({
    address: usdc,
    abi: RELAY_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [relay],
  }) as Promise<bigint>;
}
