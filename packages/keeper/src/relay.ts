/**
 * Cross-chain USDC movement — spec §4.
 *
 * A round trip needs four transactions across two chains and two Circle
 * attestations. Done by hand that is: burn, poll Iris until the attestation
 * finalizes, submit `receiveMessage` on the destination, then repeat in
 * reverse. Every one of those steps was manual in the first working round
 * trip, which is not an operating model.
 *
 * `@circle-fin/app-kit` collapses it to one call. §4 names it as the tool for
 * "Arc ↔ EVM leg movement", and it turns out to know Arc natively — its
 * `ArcTestnet` definition carries chainId 5042002, `testnet.arcscan.app`, and
 * `nativeCurrency.decimals: 18`, independently corroborating the 18-vs-6
 * decimal split this repo established by probing the chain (§7.7).
 *
 * # Where this sits, and what it deliberately does not replace
 *
 * App Kit is a TypeScript SDK: it runs in a keeper, not in a transaction.
 * `Router.rebalance` decides and moves capital *within one transaction*, and
 * a Solidity contract cannot call a TypeScript SDK — so the on-chain leg uses
 * `TokenMessengerV2.depositForBurn` directly and always will.
 *
 * The two are layers, not alternatives:
 *
 *   on-chain   Router → CctpBridgeExecutor → TokenMessengerV2   (the burn)
 *   off-chain  keeper → App Kit                                 (attest + mint)
 *
 * §13 asked whether App Kit's `bridge()` exposes hook data, "or whether the
 * Solana leg must drop to the raw TokenMessengerV2 interface while EVM legs
 * stay on App Kit". The answer is broader than the question: *every* leg the
 * Router drives is raw, because the Router is a contract. App Kit's job is
 * the half that happens between transactions.
 */

import { TransferSpeed } from '@circle-fin/app-kit';

/** Chains this keeper can move USDC between. */
export type RelayChain = 'arc-testnet' | 'base-sepolia';

/** CCTP domains, verified on-chain rather than taken from docs. */
export const CCTP_DOMAINS: Record<RelayChain, number> = {
  'arc-testnet': 26,
  'base-sepolia': 6,
};

/**
 * Circle's attestation service. The sandbox host serves testnets; production
 * returns 404 for them, which is a confusing way to discover you are pointed
 * at the wrong one.
 */
export const IRIS_SANDBOX = 'https://iris-api-sandbox.circle.com';
export const IRIS_PRODUCTION = 'https://iris-api.circle.com';

export type AttestationStatus = 'pending_confirmations' | 'complete' | 'not_found';

export type Attestation = {
  status: AttestationStatus;
  /** The CCTP message, ready to pass to `receiveMessage`. */
  message?: `0x${string}`;
  /** Circle's signature over it. */
  attestation?: `0x${string}`;
  eventNonce?: string;
};

/**
 * Fetch the attestation for a burn.
 *
 * Kept alongside the App Kit path deliberately. App Kit owns the happy path;
 * this is what a keeper needs when a bridge has to be resumed — the burn
 * already happened, the process died, and the funds are sitting attested but
 * unminted. Without a way to fetch and submit an attestation independently,
 * a crashed relayer strands capital that CCTP has already signed off on.
 */
export async function fetchAttestation(
  sourceDomain: number,
  burnTxHash: string,
  options: { irisUrl?: string; signal?: AbortSignal } = {},
): Promise<Attestation> {
  const base = options.irisUrl ?? IRIS_SANDBOX;
  const url = `${base}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`;

  const response = await fetch(url, { signal: options.signal });
  if (response.status === 404) return { status: 'not_found' };
  if (!response.ok) {
    throw new Error(`Iris returned ${response.status} for ${burnTxHash}`);
  }

  const body = (await response.json()) as {
    messages?: Array<{ status?: string; message?: string; attestation?: string; eventNonce?: string }>;
  };
  const first = body.messages?.[0];
  if (!first) return { status: 'not_found' };

  return {
    status: (first.status as AttestationStatus) ?? 'pending_confirmations',
    message: first.message as `0x${string}` | undefined,
    attestation: first.attestation as `0x${string}` | undefined,
    eventNonce: first.eventNonce,
  };
}

/**
 * Poll until an attestation finalizes.
 *
 * Finality is the dominant cost of a standard transfer: on Base Sepolia a
 * `SLOW` burn waits 13–19 minutes for hard finality, while `FAST` settles in
 * seconds for a fee. §7.5's payback rule already prices that wait, so the
 * caller should choose the speed — the default here is deliberately generous
 * enough for `SLOW` rather than tuned for the happy case.
 */
export async function waitForAttestation(
  sourceDomain: number,
  burnTxHash: string,
  options: {
    irisUrl?: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onPoll?: (status: AttestationStatus, elapsedMs: number) => void;
  } = {},
): Promise<Required<Pick<Attestation, 'message' | 'attestation'>>> {
  const { pollIntervalMs = 15_000, timeoutMs = 25 * 60_000 } = options;
  const started = Date.now();

  for (;;) {
    const result = await fetchAttestation(sourceDomain, burnTxHash, options);
    const elapsed = Date.now() - started;
    options.onPoll?.(result.status, elapsed);

    if (result.status === 'complete' && result.message && result.attestation) {
      return { message: result.message, attestation: result.attestation };
    }
    if (elapsed > timeoutMs) {
      throw new Error(
        `attestation for ${burnTxHash} still ${result.status} after ${Math.round(elapsed / 1000)}s`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

export type RelayRequest = {
  from: RelayChain;
  to: RelayChain;
  /** Human units, e.g. "2" for 2 USDC. App Kit takes a decimal string. */
  amount: string;
  /** Where the USDC should land. Defaults to the sender's own address. */
  recipient?: `0x${string}`;
  /**
   * FAST settles in seconds for a fee; SLOW waits for hard finality.
   * §7.5's payback rule prices the wait, so this is a routing decision.
   */
  speed?: TransferSpeed;
};

export type RelayResult = {
  state: 'pending' | 'success' | 'error';
  amount: string;
  sourceTxHash?: string;
  destinationTxHash?: string;
};

/**
 * Move USDC between chains through App Kit, which handles the burn, the
 * attestation wait and the destination mint as one operation.
 *
 * @param appKit A configured App Kit context. Constructed by the caller so
 *        this module stays free of wallet and credential handling — a keeper
 *        that signs is a keeper that can lose funds, and that surface belongs
 *        in one place, not scattered through helpers.
 */
export async function relayViaAppKit(
  appKit: {
    bridge: (params: {
      from: unknown;
      to: unknown;
      amount: string;
      config?: { transferSpeed?: TransferSpeed };
    }) => Promise<{
      state: 'pending' | 'success' | 'error';
      amount: string;
      source?: { transactionHash?: string };
      destination?: { transactionHash?: string };
    }>;
  },
  from: unknown,
  to: unknown,
  request: RelayRequest,
): Promise<RelayResult> {
  const result = await appKit.bridge({
    from,
    to,
    amount: request.amount,
    config: request.speed ? { transferSpeed: request.speed } : undefined,
  });

  return {
    state: result.state,
    amount: result.amount,
    sourceTxHash: result.source?.transactionHash,
    destinationTxHash: result.destination?.transactionHash,
  };
}

/**
 * What the keeper must do on Arc once a bridge lands, which App Kit cannot do
 * for it: the vault has to be told.
 *
 * Capital returns as a CCTP *mint*, so no executor calls back and
 * `returnToVault` has nothing to trigger on. Until `recordBridgeArrival` runs,
 * the funds sit as unaccounted balance while the venue's book still claims
 * them, and the vault believes itself deployed.
 */
export type ArrivalToBook = {
  venueId: number;
  /** USDC base units (6dp) that landed. */
  amount: bigint;
};

/**
 * Bound a booking to what actually arrived.
 *
 * `LPVault.recordBridgeArrival` enforces this on-chain too; doing it here as
 * well means a keeper bug is caught before it costs a reverted transaction,
 * and the reason is legible off-chain.
 */
export function bookableAmount(unaccountedBalance: bigint, claimed: bigint): bigint {
  if (claimed <= 0n) throw new RangeError('nothing to book');
  return claimed <= unaccountedBalance ? claimed : unaccountedBalance;
}
