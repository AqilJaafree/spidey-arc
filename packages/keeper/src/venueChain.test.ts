import { describe, expect, it } from 'vitest';
import { chainForDomain, readVenueChain, venuesOnDomain } from './venueChain.js';
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

describe('venuesOnDomain', () => {
  const venueTuple = (venueId: number, chainDomain: number) =>
    [0n, 0n, 1, venueId, chainDomain, 1] as const;

  function vaultStub(bitmap: bigint, domains: Record<number, number>) {
    return {
      readContract: async ({ functionName, args }: any) => {
        if (functionName === 'activeVenueBitmap') return bitmap;
        const id = Number(args[0]);
        const domain = domains[id];
        if (domain === undefined) throw new Error(`unregistered venue ${id}`);
        return venueTuple(id, domain);
      },
    } as any;
  }

  it('finds the venue registered on a domain', async () => {
    // Only venue 2 is registered (bit 2 set), on Base's domain 6.
    const client = vaultStub(1n << 2n, { 2: 6 });
    expect(await venuesOnDomain(client, VAULT, 6)).toEqual([2]);
  });

  it('returns nothing when no venue sits on that domain', async () => {
    // An arrival from a domain no venue is registered on must not be booked
    // against a guess — the caller decides, and the empty list says so.
    const client = vaultStub(1n << 2n, { 2: 6 });
    expect(await venuesOnDomain(client, VAULT, 5)).toEqual([]);
  });

  it('returns every match when more than one venue shares a domain', async () => {
    // Two venues on Base is legal. Booking is then ambiguous, and the caller
    // must refuse rather than pick — so this reports both.
    const client = vaultStub((1n << 1n) | (1n << 2n), { 1: 6, 2: 6 });
    expect(await venuesOnDomain(client, VAULT, 6)).toEqual([1, 2]);
  });

  it('ignores unset bits rather than reading every id', async () => {
    // Reading all 256 possible ids each tick would be 256 RPC calls for a
    // vault with one venue.
    let reads = 0;
    const client = {
      readContract: async ({ functionName, args }: any) => {
        if (functionName === 'activeVenueBitmap') return 1n << 2n;
        reads += 1;
        return venueTuple(Number(args[0]), 6);
      },
    } as any;
    await venuesOnDomain(client, VAULT, 6);
    expect(reads).toBe(1);
  });

  it('propagates a read failure rather than reporting no venues', async () => {
    // An empty list means "nothing to book". A failed read must not be
    // indistinguishable from that.
    const client = { readContract: async () => { throw new Error('arc rpc down'); } } as any;
    await expect(venuesOnDomain(client, VAULT, 6)).rejects.toThrow('arc rpc down');
  });
});
