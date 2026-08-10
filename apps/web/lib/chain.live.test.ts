/**
 * Conformance against the deployed contracts, over the network.
 *
 * The ABIs in `chain.ts` are hand-pared rather than generated, so nothing but
 * a real call proves they match the bytecode at those addresses. A misspelled
 * output name or a wrong tuple arity type-checks perfectly and then decodes
 * garbage — or throws — the first time a user opens the page.
 *
 * Live by design, in the same spirit as `packages/keeper/src/relay.test.ts`:
 * these assert relationships that hold for any vault state, not the particular
 * numbers on chain today, so they do not rot as the vault is used.
 */

import { describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';

import { ARC_TESTNET, CONTRACTS, USDC_ABI, VAULT_ABI } from './chain';
import { FLAG_ACTIVE, SPOKES } from './venues';

const client = createPublicClient({
  chain: ARC_TESTNET,
  transport: http(undefined, { batch: true }),
});

const vault = { address: CONTRACTS.vault, abi: VAULT_ABI } as const;

describe('Arc testnet', () => {
  it('has Multicall3 where the chain definition claims', async () => {
    const code = await client.getCode({
      address: ARC_TESTNET.contracts.multicall3.address,
    });
    expect(code).toBeTruthy();
    expect(code).not.toBe('0x');
  });

  it('reports the chain id the definition pins', async () => {
    expect(await client.getChainId()).toBe(ARC_TESTNET.id);
  });
});

describe('LPVault ABI', () => {
  it('decodes the whole panel batch through Multicall3', async () => {
    const [totalAssets, assets, nav, queue, caps, coverage, maxNavAge] = await client.multicall({
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
    });

    // `assets` and `nav` are structs; a wrong arity would not destructure.
    expect(assets).toHaveLength(2);
    expect(nav).toHaveLength(3);
    expect(queue).toHaveLength(2);
    expect(caps).toHaveLength(2);

    // The accounting identity the panel displays: equity is idle plus the
    // mark, less what is already owed.
    const [idle, pending] = assets;
    const [deployed] = nav;
    expect(totalAssets).toBe(idle + deployed - (pending > idle + deployed ? idle + deployed : pending));

    expect(coverage).toBeLessThanOrEqual(10_000n);
    expect(maxNavAge).toBe(21_600n); // six hours, per the contract constant
  });

  it('agrees with the vault about its own aggregates', async () => {
    const [idleAssets, deployedAssets, assets, nav] = await client.multicall({
      allowFailure: false,
      contracts: [
        { ...vault, functionName: 'idleAssets' },
        { ...vault, functionName: 'deployedAssets' },
        { ...vault, functionName: 'assets' },
        { ...vault, functionName: 'nav' },
      ],
    });
    expect(idleAssets).toBe(assets[0]);
    expect(deployedAssets).toBe(nav[0]);
  });

  it('reads a holder record for an address that has never deposited', async () => {
    const nobody = '0x000000000000000000000000000000000000dEaD';
    const [shares, pendingOf] = await client.multicall({
      allowFailure: false,
      contracts: [
        { ...vault, functionName: 'balanceOf', args: [nobody] },
        { ...vault, functionName: 'pendingOf', args: [nobody] },
      ],
    });
    expect(shares).toBe(0n);
    expect(pendingOf[0]).toBe(0n);
  });

  it('quotes a redemption, which is what the request form previews', async () => {
    const supply = await client.readContract({ ...vault, functionName: 'totalSupply' });
    const owed = await client.readContract({
      ...vault,
      functionName: 'previewRedeemShares',
      args: [supply],
    });
    // Redeeming every share cannot fetch more than the vault's equity.
    const total = await client.readContract({ ...vault, functionName: 'totalAssets' });
    expect(owed).toBeLessThanOrEqual(total);
  });
});

describe('venue rows', () => {
  it('decodes each spoke and agrees with the domain the diagram assumes', async () => {
    const rows = await client.multicall({
      allowFailure: false,
      contracts: SPOKES.map((s) => ({
        ...vault,
        functionName: 'venues' as const,
        args: [s.venueId] as const,
      })),
    });

    rows.forEach((row, i) => {
      expect(row).toHaveLength(6);
      const [, , , venueId, chainDomain, flags] = row;
      expect(venueId).toBe(SPOKES[i].venueId);
      // A registered venue must sit on the domain the route diagram draws it
      // on; a mismatch would label capital with the wrong chain.
      if (flags & FLAG_ACTIVE) expect(chainDomain).toBe(SPOKES[i].cctpDomain);
    });
  });

  it('never reports more deployed at the spokes than the vault marks in total', async () => {
    const [rows, deployed] = await Promise.all([
      client.multicall({
        allowFailure: false,
        contracts: SPOKES.map((s) => ({
          ...vault,
          functionName: 'venues' as const,
          args: [s.venueId] as const,
        })),
      }),
      client.readContract({ ...vault, functionName: 'deployedAssets' }),
    ]);
    const sum = rows.reduce((total, row) => total + row[0], 0n);
    expect(sum).toBeLessThanOrEqual(deployed);
  });
});

describe('USDC shim ABI', () => {
  it('reads a balance and an allowance off 0x3600…0000', async () => {
    const [balance, allowance] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: CONTRACTS.usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [CONTRACTS.vault] },
        {
          address: CONTRACTS.usdc, abi: USDC_ABI, functionName: 'allowance',
          args: [CONTRACTS.vault, CONTRACTS.router],
        },
      ],
    });
    expect(typeof balance).toBe('bigint');
    expect(typeof allowance).toBe('bigint');

    // The vault's tracked idle can never exceed what it actually holds —
    // solvency, read straight off the chain.
    const idle = await client.readContract({ ...vault, functionName: 'idleAssets' });
    expect(idle).toBeLessThanOrEqual(balance);
  });
});
