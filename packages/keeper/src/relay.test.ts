import { describe, expect, it } from 'vitest';
import {
  CCTP_DOMAINS,
  IRIS_SANDBOX,
  bookableAmount,
  fetchAttestation,
} from './relay.js';

/**
 * The burns from the first working Arc ↔ Base round trip. Real transactions
 * on real chains, so these assert against Circle's live attestation service
 * rather than a fixture — the point is that the domains and the API shape are
 * right, and a fixture would only prove I can copy my own output.
 */
const ARC_TO_BASE_BURN = '0xc673762aa623c9e0ca09d8680e9ce40cf7b95236b3182af05a92e8725467e6c5';
const BASE_TO_ARC_BURN = '0x998b30bac0bba119900c78e7be58714653e2199bea517fecc1e080930bd89355';

describe('CCTP domains', () => {
  it('knows Arc is 26', () => {
    // Not a low number, as a hub chain might suggest. Confirmed against
    // Circle's published Arc addresses and by a live burn landing on Base.
    expect(CCTP_DOMAINS['arc-testnet']).toBe(26);
    expect(CCTP_DOMAINS['base-sepolia']).toBe(6);
  });
});

describe('booking is bounded by what arrived', () => {
  it('books the claim when it is covered', () => {
    expect(bookableAmount(2_000_000n, 2_000_000n)).toBe(2_000_000n);
    expect(bookableAmount(5_000_000n, 2_000_000n)).toBe(2_000_000n);
  });

  it('clamps a claim larger than the balance', () => {
    // The vault reverts in this case; clamping here means a keeper bug is
    // caught before it costs a reverted transaction.
    expect(bookableAmount(1_000_000n, 2_000_000n)).toBe(1_000_000n);
    expect(bookableAmount(0n, 2_000_000n)).toBe(0n);
  });

  it('refuses a non-positive claim', () => {
    expect(() => bookableAmount(1_000_000n, 0n)).toThrow(/nothing to book/);
    expect(() => bookableAmount(1_000_000n, -1n)).toThrow(/nothing to book/);
  });
});

describe('attestation service (live)', () => {
  it('returns a complete attestation for the Arc → Base burn', async () => {
    const result = await fetchAttestation(CCTP_DOMAINS['arc-testnet'], ARC_TO_BASE_BURN);
    expect(result.status).toBe('complete');
    expect(result.message).toMatch(/^0x[0-9a-f]+$/i);
    expect(result.attestation).toMatch(/^0x[0-9a-f]+$/i);
    // 377-byte message, 65-byte signature plus prefix — the shapes
    // `receiveMessage` expects.
    expect((result.message!.length - 2) / 2).toBeGreaterThan(300);
  }, 60_000);

  it('returns a complete attestation for the Base → Arc burn', async () => {
    const result = await fetchAttestation(CCTP_DOMAINS['base-sepolia'], BASE_TO_ARC_BURN);
    expect(result.status).toBe('complete');
    expect(result.message).toBeDefined();
  }, 60_000);

  it('reports not_found for a transaction that was never a burn', async () => {
    const result = await fetchAttestation(
      CCTP_DOMAINS['arc-testnet'],
      '0x' + '11'.repeat(32),
    );
    expect(result.status).toBe('not_found');
  }, 60_000);

  /**
   * A trap worth a test: production Iris 404s testnet burns, which reads as
   * "this burn does not exist" rather than "you are pointed at the wrong
   * host". Getting this backwards costs an afternoon.
   */
  it('the production host does not know testnet burns', async () => {
    const sandbox = await fetchAttestation(CCTP_DOMAINS['arc-testnet'], ARC_TO_BASE_BURN, {
      irisUrl: IRIS_SANDBOX,
    });
    const production = await fetchAttestation(CCTP_DOMAINS['arc-testnet'], ARC_TO_BASE_BURN, {
      irisUrl: 'https://iris-api.circle.com',
    });
    expect(sandbox.status).toBe('complete');
    expect(production.status).toBe('not_found');
  }, 60_000);
});
