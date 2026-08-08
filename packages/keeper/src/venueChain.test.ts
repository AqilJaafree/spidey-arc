import { describe, expect, it } from 'vitest';
import { chainForDomain, readVenueChain } from './venueChain.js';
import { CCTP_DOMAINS, RELAY_CHAINS } from './relay.js';

const VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as const;

function stubClient(handler: (args: any) => Promise<unknown>) {
  return { readContract: (args: any) => handler(args) } as any;
}

describe('chainForDomain', () => {
  it('inverts CCTP_DOMAINS for every chain the keeper knows', () => {
    // Round-trips rather than restating the table: a test that hardcoded
    // 26 -> arc-testnet would pass against an inversion that dropped a chain.
    for (const chain of RELAY_CHAINS) {
      expect(chainForDomain(CCTP_DOMAINS[chain])).toBe(chain);
    }
  });

  it('throws on a domain no configured chain claims', () => {
    // Guessing here would book a venue's capital against the wrong chain.
    expect(() => chainForDomain(99)).toThrow(/99/);
  });
});

describe('readVenueChain', () => {
  it('resolves a venue to its chain via the domain the vault stored', async () => {
    const client = stubClient(async ({ functionName, args }) => {
      expect(functionName).toBe('venues');
      expect(args).toEqual([2]);
      // VenueState tuple: deployedAssets, lastRebalanceAt, scoreBps, venueId,
      // chainDomain, flags
      return [1_000_000n, 1_770_000_000n, 9_000, 2, 6, 5];
    });
    expect(await readVenueChain(client, VAULT, 2)).toBe('base-sepolia');
  });

  it('propagates a read failure rather than defaulting to a chain', async () => {
    const client = stubClient(async () => { throw new Error('arc rpc down'); });
    await expect(readVenueChain(client, VAULT, 2)).rejects.toThrow('arc rpc down');
  });
});
