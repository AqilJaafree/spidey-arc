'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';

import { CONTRACTS, USDC_ABI, VAULT_ABI } from './chain';
import { publicClient } from './wallet';
import type { HolderState, VaultState } from './vault';
import { SPOKES, routeStates, type Route } from './venues';

const vault = { address: CONTRACTS.vault as Address, abi: VAULT_ABI } as const;
const usdc = { address: CONTRACTS.usdc as Address, abi: USDC_ABI } as const;

export type VaultData = {
  vault: VaultState;
  routes: Route[];
  holder: HolderState | null;
  /** Chain time, so age checks are judged against the chain rather than the browser. */
  now: bigint;
  blockNumber: bigint;
};

/**
 * Everything the panel shows, in one multicall.
 *
 * `now` comes from the latest block rather than `Date.now()`. Every staleness
 * rule in `LPVault` is evaluated against `block.timestamp`, so judging them
 * against a browser clock — which can be wrong by minutes, or by hours in a
 * misconfigured timezone — would report a stale mark on a healthy vault or,
 * worse, the reverse.
 */
export async function readVault(holder: Address | null): Promise<VaultData> {
  // Two batches rather than one. Spreading the homogeneous venue reads into
  // the heterogeneous batch collapses viem's per-element return typing to a
  // single union, and these are still one round trip each through Multicall3.
  const [block, results, venueRows] = await Promise.all([
    publicClient.getBlock(),
    publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...vault, functionName: 'totalAssets' },
        { ...vault, functionName: 'assets' },
        { ...vault, functionName: 'nav' },
        { ...vault, functionName: 'queue' },
        { ...vault, functionName: 'caps' },
        { ...vault, functionName: 'coverageBps' },
        { ...vault, functionName: 'MAX_NAV_AGE' },
      ],
    }),
    // Read by id rather than by walking `activeVenueBitmap`: an unregistered
    // spoke is a state the diagram shows, not one it should hide.
    publicClient.multicall({
      allowFailure: false,
      contracts: SPOKES.map((s) => ({
        ...vault,
        functionName: 'venues' as const,
        args: [s.venueId] as const,
      })),
    }),
  ]);

  const [totalAssets, assets, nav, queue, caps, coverageBps, maxNavAge] = results;
  const routes = routeStates(
    venueRows.map((row, i) => ({
      venueId: SPOKES[i].venueId,
      deployed: row[0],
      chainDomain: row[4],
      flags: row[5],
    })),
  );
  const [idle, pending] = assets;
  const [deployed, navUpdatedAt] = nav;
  const [epoch, lastSettledEpoch] = queue;
  const [depositCap] = caps;

  const state: VaultState = {
    totalAssets,
    idle,
    deployed,
    pending,
    coverageBps: Number(coverageBps),
    epoch,
    lastSettledEpoch,
    depositCap,
    navUpdatedAt,
    maxNavAge,
  };

  if (!holder) {
    return { vault: state, routes, holder: null, now: block.timestamp, blockNumber: block.number };
  }

  const [shares, usdcBalance, allowance, pendingOf] = await publicClient.multicall({
    allowFailure: false,
    contracts: [
      { ...vault, functionName: 'balanceOf', args: [holder] },
      { ...usdc, functionName: 'balanceOf', args: [holder] },
      { ...usdc, functionName: 'allowance', args: [holder, CONTRACTS.vault as Address] },
      { ...vault, functionName: 'pendingOf', args: [holder] },
    ],
  });

  const [pendingAssets, pendingEpoch] = pendingOf;

  return {
    vault: state,
    routes,
    holder: { shares, usdcBalance, allowance, pendingAssets, pendingEpoch },
    now: block.timestamp,
    blockNumber: block.number,
  };
}

export function useVaultData(holder: Address | null, refreshKey = 0) {
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await readVault(holder));
    } catch (cause) {
      setError((cause as Error).message.split('\n')[0]);
    } finally {
      setLoading(false);
    }
  }, [holder]);

  useEffect(() => {
    void load();
    // Slow on purpose. Nothing here changes between blocks unless somebody
    // acts, and a public RPC is a shared resource.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  return { data, error, loading, reload: load };
}
