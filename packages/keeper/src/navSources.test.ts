import { describe, expect, it } from 'vitest';
import { readVaultNav, readRelayBalance } from './navSources.js';

/** A viem-shaped stub: only `readContract` is exercised. */
function stubClient(handler: (args: any) => Promise<unknown>) {
  return { readContract: (args: any) => handler(args) } as any;
}

const VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as const;
const RELAY = '0x280aD956FFFd3ABba3db59397BE7c4d4d04D32D4' as const;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

describe('readVaultNav', () => {
  it('reads the mark and the contract bounds together', async () => {
    const client = stubClient(async ({ functionName }) => {
      switch (functionName) {
        case 'nav': return [1_000_000_000n, 1_770_000_000n, 7n];
        case 'NAV_COOLDOWN': return 3600n;
        case 'MAX_NAV_AGE': return 21_600n;
        case 'MAX_NAV_DELTA_BPS': return 500;
        default: throw new Error(`unexpected call ${functionName}`);
      }
    });

    const got = await readVaultNav(client, VAULT);
    expect(got.deployedAssets).toBe(1_000_000_000n);
    expect(got.updatedAt).toBe(1_770_000_000);
    expect(got.bounds.navCooldownSeconds).toBe(3600);
    expect(got.bounds.maxNavAgeSeconds).toBe(21_600);
    expect(got.bounds.maxNavDeltaBps).toBe(500);
  });

  it('reports only what the chain said, leaving the margin to be derived', async () => {
    // The reporting margin is `shouldReport`'s to derive: it is the one bound
    // not read from the chain, and deriving it here as well would be a second
    // source of truth for the only value that can be wrong.
    const client = stubClient(async ({ functionName }) => {
      switch (functionName) {
        case 'nav': return [1n, 1_770_000_000n, 1n];
        case 'NAV_COOLDOWN': return 3600n;
        case 'MAX_NAV_AGE': return 36_000n; // 10h, not the live 6h
        case 'MAX_NAV_DELTA_BPS': return 500;
        default: throw new Error(`unexpected call ${functionName}`);
      }
    });

    const got = await readVaultNav(client, VAULT);
    expect(got.bounds.reportAtAgeSeconds).toBeUndefined();
    expect(got.bounds.maxNavAgeSeconds).toBe(36_000);
  });

  it('propagates a read failure rather than defaulting', async () => {
    const client = stubClient(async () => { throw new Error('arc rpc down'); });
    await expect(readVaultNav(client, VAULT)).rejects.toThrow('arc rpc down');
  });
});

describe('readRelayBalance', () => {
  it('reads the relay USDC balance', async () => {
    const client = stubClient(async ({ functionName, args }) => {
      expect(functionName).toBe('balanceOf');
      expect(args).toEqual([RELAY]);
      return 400_000n;
    });
    expect(await readRelayBalance(client, USDC, RELAY)).toBe(400_000n);
  });

  it('propagates a read failure rather than returning zero', async () => {
    // Returning zero here would mark the vault's whole deployed position as
    // lost and haircut every claimant. Throwing is the only safe answer.
    const client = stubClient(async () => { throw new Error('base rpc down'); });
    await expect(readRelayBalance(client, USDC, RELAY)).rejects.toThrow('base rpc down');
  });
});
