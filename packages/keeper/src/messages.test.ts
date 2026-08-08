import { describe, expect, it } from 'vitest';
import { outstandingBurns, type BurnLog } from './messages.js';

const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

function burn(n: number, amount = 1_000_000n): BurnLog {
  return { txHash: TX(n), amount, destinationDomain: 26, nonce: `0xnonce${n}` };
}

describe('outstandingBurns', () => {
  it('returns a burn that is attested and not yet minted', async () => {
    const got = await outstandingBurns([burn(1)], {
      attestationOf: async () => ({ status: 'complete', message: '0xmsg', attestation: '0xsig' }),
      isNonceUsed: async () => false,
    });
    expect(got.map((b) => b.txHash)).toEqual([TX(1)]);
  });

  it('skips a burn whose attestation is still pending', async () => {
    // Submitting an unattested message wastes gas on a call that must revert.
    const got = await outstandingBurns([burn(1)], {
      attestationOf: async () => ({ status: 'pending_confirmations' }),
      isNonceUsed: async () => false,
    });
    expect(got).toEqual([]);
  });

  it('skips a burn whose nonce the destination already used', async () => {
    // This is what makes the sweep idempotent with no local state: a message
    // already minted is invisible to the next tick, so re-running cannot
    // double-mint.
    const got = await outstandingBurns([burn(1)], {
      attestationOf: async () => ({ status: 'complete', message: '0xmsg', attestation: '0xsig' }),
      isNonceUsed: async () => true,
    });
    expect(got).toEqual([]);
  });

  it('skips an attestation Iris has never seen', async () => {
    const got = await outstandingBurns([burn(1)], {
      attestationOf: async () => ({ status: 'not_found' }),
      isNonceUsed: async () => false,
    });
    expect(got).toEqual([]);
  });

  it('skips a complete attestation missing its message or signature', async () => {
    // `complete` without both fields cannot be submitted; treating it as
    // outstanding would retry it every tick forever.
    const got = await outstandingBurns([burn(1)], {
      attestationOf: async () => ({ status: 'complete', message: '0xmsg' }),
      isNonceUsed: async () => false,
    });
    expect(got).toEqual([]);
  });

  it('sorts several burns into outstanding and not', async () => {
    const used = new Set(['0xnonce2']);
    const got = await outstandingBurns([burn(1), burn(2), burn(3)], {
      attestationOf: async (tx) =>
        tx === TX(3)
          ? { status: 'pending_confirmations' }
          : { status: 'complete', message: '0xmsg', attestation: '0xsig' },
      isNonceUsed: async (nonce) => used.has(nonce),
    });
    expect(got.map((b) => b.txHash)).toEqual([TX(1)]);
  });

  it('propagates an attestation lookup failure rather than skipping the burn', async () => {
    // Skipping on error would silently strand capital CCTP has already signed
    // off on — the exact failure fetchAttestation exists to let a keeper
    // recover from.
    await expect(
      outstandingBurns([burn(1)], {
        attestationOf: async () => { throw new Error('iris unreachable'); },
        isNonceUsed: async () => false,
      }),
    ).rejects.toThrow('iris unreachable');
  });

  it('propagates a usedNonces read failure', async () => {
    await expect(
      outstandingBurns([burn(1)], {
        attestationOf: async () => ({ status: 'complete', message: '0xmsg', attestation: '0xsig' }),
        isNonceUsed: async () => { throw new Error('base rpc down'); },
      }),
    ).rejects.toThrow('base rpc down');
  });

  it('is empty when there are no burns', async () => {
    expect(await outstandingBurns([], {
      attestationOf: async () => { throw new Error('should not be called'); },
      isNonceUsed: async () => { throw new Error('should not be called'); },
    })).toEqual([]);
  });
});
