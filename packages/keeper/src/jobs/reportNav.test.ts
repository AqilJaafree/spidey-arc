/**
 * The NAV job's wiring, which had no test at all.
 *
 * `shouldReport` is tested purely in `nav.test.ts`. What is left here is the part
 * that decides *what to measure* — and that is exactly where the bug lived: the
 * job returned early on `deployedAssets === 0n`, so it never read the relay, and
 * a zero mark meant the mark was never checked against anything. Capital sitting
 * in the relay against a zero mark read as "nothing deployed".
 *
 * Against the live chains this posts nothing, correctly: the relay balance is 0,
 * so the measurement agrees with the mark. That leaves the posting branch
 * unexercised on-chain — `reportNav` has never once posted since deployment —
 * which is what these stubs are for.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { reportNavJob } from './reportNav.js';

const VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as Address;
const RELAY = '0x280aD956FFFd3ABba3db59397BE7c4d4d04D32D4' as Address;
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

const NOW = 1_786_000_000;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/** Arc: the vault's mark and its own bounds, plus the block clock the job uses. */
function stubArc(markedDeployed: bigint, updatedAt: number): PublicClient {
  return {
    getBlock: async () => ({ timestamp: BigInt(NOW) }),
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'nav':
          return [markedDeployed, BigInt(updatedAt), 1];
        case 'NAV_COOLDOWN':
          return 3_600n;
        case 'MAX_NAV_AGE':
          return 21_600n;
        default:
          return 500n; // MAX_NAV_DELTA_BPS
      }
    },
  } as unknown as PublicClient;
}

/** Base: nothing but the relay's USDC balance. */
function stubBase(relayBalance: bigint): { client: PublicClient; reads: () => number } {
  let reads = 0;
  const client = {
    readContract: async () => {
      reads += 1;
      return relayBalance;
    },
  } as unknown as PublicClient;
  return { client, reads: () => reads };
}

const deps = (arc: PublicClient, base: PublicClient) => ({
  arc, base, vault: VAULT, relay: RELAY, baseUsdc: BASE_USDC,
});

describe('report-nav: what it measures before it decides', () => {
  it('reads the relay even when the mark says nothing is deployed', async () => {
    // The bug: this read was skipped on a zero mark, so the number under audit
    // decided whether to audit it.
    const { client: base, reads } = stubBase(0n);
    await reportNavJob(deps(stubArc(0n, NOW - 100_000), base));
    expect(reads()).toBe(1);
  });

  it('marks a position the vault does not know it holds', async () => {
    const { client: base } = stubBase(USDC(500));
    const summary = await reportNavJob(deps(stubArc(0n, NOW - 100_000), base));
    expect(summary).toMatch(/would post 500000000/);
    expect(summary).toMatch(/changed/);
    expect(summary).not.toMatch(/nothing deployed/);
  });

  it('posts it through the wallet when one is given', async () => {
    const { client: base } = stubBase(USDC(500));
    const writeContract = vi.fn(async (_args: { functionName: string; args: readonly bigint[] }) => '0xabc123');
    const wallet = { writeContract, chain: null, account: { address: '0x1' } } as never;
    const summary = await reportNavJob({ ...deps(stubArc(0n, NOW - 100_000), base), wallet });
    expect(writeContract).toHaveBeenCalledOnce();
    expect(writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'reportNav' });
    // Uncapped off a zero mark, mirroring `LPVault.reportNav`, which skips its
    // delta bound when `previous == 0`. A capped step here would post 0.
    expect(writeContract.mock.calls[0]![0]!.args[0]).toBe(USDC(500));
    expect(summary).toMatch(/posted 500000000/);
    expect(summary).toMatch(/0xabc123/);
  });

  it('still says nothing-deployed when the relay agrees the vault is empty', async () => {
    const { client: base } = stubBase(0n);
    const summary = await reportNavJob(deps(stubArc(0n, NOW - 100_000), base));
    expect(summary).toMatch(/nothing-deployed/);
  });

  it('honours the cooldown on an unmarked position rather than posting immediately', async () => {
    // `LPVault.reportNav` checks NavCooldown before it looks at `previous`, so a
    // zero mark buys no exemption. Posting here would revert on-chain.
    const { client: base } = stubBase(USDC(500));
    const summary = await reportNavJob(deps(stubArc(0n, NOW - 60), base));
    expect(summary).toMatch(/cooldown/);
  });

  it('does not post a value the vault already holds', async () => {
    const { client: base } = stubBase(USDC(500));
    const summary = await reportNavJob(deps(stubArc(USDC(500), NOW - 100), base));
    expect(summary).toMatch(/no post/);
  });
});
