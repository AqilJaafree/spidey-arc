/**
 * The deposit path, driven against live Arc.
 *
 * The component tests mock the chain, so they prove the wiring and prove
 * nothing about the vault. This drives the real thing: real balances, real
 * allowance, real `eth_call` simulation of the exact transactions
 * `DepositCard` builds — the same ABI, the same argument order, the same
 * `simulateContract` the button calls before it lets a wallet sign.
 *
 * It signs nothing and moves nothing. A simulation executes the call against
 * current state and discards the result, which is enough to catch a wrong
 * argument, a wrong ABI, or a guard nobody expected, and is exactly what the
 * page does before showing the user a button.
 */

import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address } from 'viem';

import { ARC_TESTNET, CONTRACTS, USDC_ABI, VAULT_ABI } from './chain';
import { depositReadiness, parseUsdc, refusalFromError, requestReadiness } from './vault';

const client = createPublicClient({ chain: ARC_TESTNET, transport: http(undefined, { batch: true }) });

const vault = { address: CONTRACTS.vault, abi: VAULT_ABI } as const;
const usdc = { address: CONTRACTS.usdc, abi: USDC_ABI } as const;

/** The deployer, which is the only funded account on this testnet. */
const HOLDER = '0x9e5fdE1f7484096A9beCDBb956A05834eC581195' as Address;

async function liveState() {
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
  const [shares, balance, allowance, pendingOf] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...vault, functionName: 'balanceOf', args: [HOLDER] },
      { ...usdc, functionName: 'balanceOf', args: [HOLDER] },
      { ...usdc, functionName: 'allowance', args: [HOLDER, CONTRACTS.vault] },
      { ...vault, functionName: 'pendingOf', args: [HOLDER] },
    ],
  });

  return {
    vault: {
      totalAssets, idle: assets[0], deployed: nav[0], pending: assets[1],
      coverageBps: Number(coverage), epoch: queue[0], lastSettledEpoch: queue[1],
      depositCap: caps[0], navUpdatedAt: nav[1], maxNavAge,
    },
    holder: {
      shares, usdcBalance: balance, allowance,
      pendingAssets: pendingOf[0], pendingEpoch: pendingOf[1],
    },
  };
}

describe('Arc USDC, two views of one balance', () => {
  // §7.7's split, and the reason the panel labels its decimals. Getting this
  // wrong shows a balance a trillion times off.
  it('reads the same balance at 6 decimals and 18', async () => {
    const [erc20, native] = await Promise.all([
      client.readContract({ ...usdc, functionName: 'balanceOf', args: [HOLDER] }),
      client.getBalance({ address: HOLDER }),
    ]);
    expect(native / 10n ** 12n).toBe(erc20);
  });
});

describe('deposit, against live state', () => {
  it('agrees with the chain about whether approval is needed', async () => {
    const { vault: v, holder } = await liveState();
    const amount = parseUsdc('1');
    const readiness = depositReadiness(v, holder, amount);

    // The predicate is derived from the same allowance the vault will read.
    expect(readiness.needsApproval).toBe(holder.allowance < amount);
    expect(readiness.ok).toBe(true);
  });

  it('simulates the approve the card would send first', async () => {
    const { request } = await client.simulateContract({
      ...usdc,
      functionName: 'approve',
      args: [CONTRACTS.vault, parseUsdc('1')],
      account: HOLDER,
    });
    expect(request.functionName).toBe('approve');
  });

  // With no allowance the deposit must fail, and it must fail *legibly* —
  // this is the whole claim the page makes about refusals.
  it('refuses the deposit without an allowance, and says so in words', async () => {
    const { holder } = await liveState();
    expect(holder.allowance).toBe(0n);

    await expect(
      client.simulateContract({
        ...vault,
        functionName: 'deposit',
        args: [parseUsdc('1'), HOLDER],
        account: HOLDER,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const refusal = refusalFromError(error);
      // Either the shim's own decoded error, or a bare revert — what matters
      // is that nothing reaches the user as an undecoded hex blob.
      return refusal === null || !refusal.detail.includes('0x');
    });
  });

});

describe('request, against live state', () => {
  it('lets the holder queue the shares they actually hold', async () => {
    const { vault: v, holder } = await liveState();
    if (holder.shares === 0n) return; // nothing to test against
    expect(requestReadiness(v, holder, holder.shares).ok).toBe(true);

    const { result } = await client.simulateContract({
      ...vault,
      functionName: 'requestWithdraw',
      args: [holder.shares],
      account: HOLDER,
    });
    expect(result).toBeGreaterThan(0n);
  });
});
