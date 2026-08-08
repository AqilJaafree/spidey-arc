/**
 * CCTP messages that were burned but never minted — finding them, and
 * finishing them.
 *
 * A transfer is two transactions on two chains with an attestation between:
 * `depositForBurn` on the source, then `receiveMessage` on the destination.
 * Every one of those second halves has been driven by hand. When nobody runs
 * it, the capital sits burned-and-unminted — Circle has signed off on it and it
 * is going nowhere. This module is the half of the keeper that sweeps those up.
 *
 * # Why discovery is a log scan and not an API query
 *
 * The obvious design is to ask Iris "what of mine is outstanding?". It cannot
 * answer. Probing the sandbox:
 *
 *   GET /v2/messages/26                 → 400 "At least one of transactionHash
 *                                              or nonce must be provided"
 *   GET /v2/messages/26?sender=0x9e5f…  → 400 (sender is not a supported filter)
 *   GET /v2/messages/26?nonce=1         → 404 "Message not found for provided
 *                                              parameters"
 *
 * Every route into Iris requires you to already know the thing you are looking
 * for. There is no enumeration and no filter that stands in for one. So the
 * source of truth for "what did we burn" has to be the chain: `DepositForBurn`
 * logs on the `TokenMessengerV2`, filtered on the indexed `depositor`. Iris is
 * then queried one transaction hash at a time, which is exactly the shape
 * `fetchAttestation` already has.
 *
 * The event was identified from 146 live Base Sepolia logs rather than from
 * documentation, and its full layout re-confirmed against a real burn
 * (block 45115916): 8 data words, `depositor` in topic 2. `depositor` being
 * indexed is what makes this a cheap filtered query instead of a scan of every
 * burn on the chain.
 *
 * # Why this is idempotent with no local state
 *
 * The keeper keeps no database of what it has submitted. It does not need one:
 * `MessageTransmitterV2.usedNonces` on the *destination* already records it.
 * A message that has been minted is filtered out of the very next tick, so a
 * re-run — or two keepers racing, or a crash mid-submit — cannot double-mint.
 * The chain is the ledger; the daemon is stateless and therefore restartable.
 *
 * The join between Iris and that mapping was verified empirically rather than
 * assumed, because getting it wrong means either re-minting messages that
 * already landed or skipping ones that never did:
 *
 *   burn  0x28dc5510…3d on Base Sepolia (domain 6 → 26)
 *   Iris  eventNonce = "0xa85ea120c0131083a71dff665a2d17fe049352e66410cf746ac79f11d2bc4461"
 *         — a 0x-prefixed 32-byte hex string, i.e. already a bytes32
 *   Arc   usedNonces(0xa85ea120…61) → 1
 *   Arc   usedNonces(<never-used>)  → 0
 *   Base  usedNonces(0xa85ea120…61) → 0   (source side, as it should be)
 *
 * Iris's `eventNonce` is passed straight to `usedNonces` with no conversion.
 * The last line is the one worth keeping in mind: the mapping is per-chain, so
 * the read must go to the destination client or it will report every message as
 * outstanding forever.
 *
 * # Where the nonce comes from
 *
 * Not from the log. CCTP v2's `DepositForBurn` does not carry a nonce — the
 * eight data words are amount, mintRecipient, destinationDomain,
 * destinationTokenMessenger, destinationCaller, maxFee and the hookData
 * offset/length, and none of them is it. The nonce is assigned off-chain and
 * only Iris knows it. So `BurnLog.nonce` is optional, `scanBurns` leaves it
 * unset, and the attestation supplies it.
 */

import type { Address, Hash, Hex, PublicClient, WalletClient } from 'viem';
import type { Attestation } from './relay.js';

/**
 * `TokenMessengerV2.DepositForBurn`, as emitted on-chain.
 *
 * selector 0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5
 * (confirmed with `cast keccak` against the signature below, and against live
 * logs). Only `burnToken`, `depositor` and `minFinalityThreshold` are indexed —
 * four topics. Note what is *not* here: a nonce.
 */
export const DEPOSIT_FOR_BURN_EVENT = {
  type: 'event',
  name: 'DepositForBurn',
  inputs: [
    { name: 'burnToken', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'depositor', type: 'address', indexed: true },
    { name: 'mintRecipient', type: 'bytes32', indexed: false },
    { name: 'destinationDomain', type: 'uint32', indexed: false },
    { name: 'destinationTokenMessenger', type: 'bytes32', indexed: false },
    { name: 'destinationCaller', type: 'bytes32', indexed: false },
    { name: 'maxFee', type: 'uint256', indexed: false },
    { name: 'minFinalityThreshold', type: 'uint32', indexed: true },
    { name: 'hookData', type: 'bytes', indexed: false },
  ],
} as const;

/**
 * The transmitter is read off the messenger rather than configured.
 *
 * One less address to get wrong, and — more to the point — it cannot drift
 * from the messenger it belongs to. A hardcoded transmitter that no longer
 * matches would fail closed in the worst way: `usedNonces` on the wrong
 * contract answers 0 for everything, which reads as "nothing has been minted".
 */
export const TOKEN_MESSENGER_ABI = [
  {
    type: 'function', name: 'localMessageTransmitter', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'address' }],
  },
] as const;

/**
 * `usedNonces` is `mapping(bytes32 => uint256)`, not a bool — verified by
 * calling it, since a `bool` decode would throw on any value above 1. It reads
 * 1 for a message that has been minted and 0 otherwise, so the predicate is
 * `!= 0` rather than `== 1`: any non-zero marking means used.
 */
export const MESSAGE_TRANSMITTER_ABI = [
  {
    type: 'function', name: 'usedNonces', stateMutability: 'view',
    inputs: [{ name: 'nonce', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** A burn seen on the source chain, before anything is known about its fate. */
export type BurnLog = {
  txHash: string;
  /** USDC base units (6dp) burned. */
  amount: bigint;
  destinationDomain: number;
  /**
   * The CCTP nonce, if already known. `scanBurns` cannot fill this in — v2's
   * `DepositForBurn` does not emit it — so it is normally supplied by the
   * attestation instead. Present here so a caller that already has it (from a
   * prior tick, or a hand-run bridge) need not re-derive it.
   */
  nonce?: string;
  blockNumber?: bigint;
};

/**
 * A burn that is attested, unminted, and carries everything needed to finish
 * it. `message` and `attestation` are the two arguments `receiveMessage` takes,
 * so the caller submits directly instead of asking Iris a second time — the
 * lookup already happened here, and re-fetching would widen the window in which
 * the answer can change under it.
 */
export type OutstandingBurn = BurnLog & {
  nonce: string;
  message: Hex;
  attestation: Hex;
};

/**
 * The two facts each burn has to be checked against.
 *
 * Injected rather than reached for, so the selection rule below is testable
 * without Iris and without a chain. That matters more than usual here: the
 * rule's interesting cases are all failure cases, and a keeper that only works
 * when both remote services are healthy is a keeper nobody can prove works.
 */
export type BurnReaders = {
  attestationOf: (txHash: string) => Promise<Attestation>;
  isNonceUsed: (nonce: string) => Promise<boolean>;
};

/**
 * Select the burns that still need a `receiveMessage`.
 *
 * A burn is outstanding when it is attested `complete`, carries *both* the
 * message and the signature, and the destination has not used its nonce.
 *
 * Sequential rather than concurrent: Iris is rate-limited, and a sweep is a
 * background job with no deadline. Trading latency for not being throttled is
 * the right side of that trade.
 *
 * Errors propagate. Never skip a burn because a lookup failed — a skipped burn
 * is silently stranded capital that CCTP has already signed off on, and it
 * looks exactly like a burn that was legitimately finished. A thrown error
 * stops the tick loudly and the next tick tries again; a swallowed one is
 * indistinguishable from success and stays wrong forever.
 */
export async function outstandingBurns(
  burns: readonly BurnLog[],
  readers: BurnReaders,
): Promise<OutstandingBurn[]> {
  const outstanding: OutstandingBurn[] = [];

  for (const burn of burns) {
    const att = await readers.attestationOf(burn.txHash);

    // `pending_confirmations` is not yet submittable and `not_found` may never
    // be; either way submitting now buys a guaranteed revert.
    if (att.status !== 'complete') continue;

    // `complete` without both fields cannot be submitted. Treating it as
    // outstanding would retry it every tick forever, so it is dropped — the
    // next tick re-reads Iris anyway, and picks it up if the fields appear.
    if (!att.message || !att.attestation) continue;

    // Iris is authoritative for the nonce; the log cannot supply one. The
    // fallback is only for a caller that already knew it.
    const nonce = att.eventNonce ?? burn.nonce;
    if (!nonce) {
      throw new Error(
        `attestation for ${burn.txHash} is complete but carries no eventNonce — ` +
          'cannot prove it has not already been minted',
      );
    }

    if (await readers.isNonceUsed(nonce)) continue;

    outstanding.push({ ...burn, nonce, message: att.message, attestation: att.attestation });
  }

  return outstanding;
}

/**
 * Find this depositor's burns in a block range.
 *
 * Filtered on the indexed `depositor` so the node does the narrowing. The two
 * depositors that matter are the `CctpBridgeExecutor` on Arc and the
 * `CctpReturnRelay` on Base — each chain's burns are attributable to exactly
 * one contract, which is what makes the filter sufficient rather than merely
 * helpful.
 *
 * The caller owns the range. Public RPCs cap `getLogs` spans (Base Sepolia's
 * refuses more than 50 000 blocks), so a sweep that wants history has to
 * window it; baking a range in here would just hide that from whoever hits it.
 */
export async function scanBurns(
  client: PublicClient,
  tokenMessenger: Address,
  depositor: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<BurnLog[]> {
  const logs = await client.getLogs({
    address: tokenMessenger,
    event: DEPOSIT_FOR_BURN_EVENT,
    args: { depositor },
    fromBlock,
    toBlock,
  });

  return logs.map((log) => ({
    txHash: log.transactionHash as string,
    amount: log.args.amount ?? 0n,
    destinationDomain: Number(log.args.destinationDomain ?? 0),
    blockNumber: log.blockNumber ?? undefined,
  }));
}

/** The `MessageTransmitterV2` a messenger belongs to. Never hardcode it. */
export async function messageTransmitterOf(
  client: PublicClient,
  tokenMessenger: Address,
): Promise<Address> {
  return (await client.readContract({
    address: tokenMessenger,
    abi: TOKEN_MESSENGER_ABI,
    functionName: 'localMessageTransmitter',
  })) as Address;
}

/**
 * Has the destination already minted this message?
 *
 * `client` must be the *destination* chain's. The mapping is per-chain: asking
 * the source reports 0 for everything, and the sweep would resubmit messages
 * that landed long ago.
 */
export async function isNonceUsedOn(
  client: PublicClient,
  transmitter: Address,
  nonce: string,
): Promise<boolean> {
  const used = (await client.readContract({
    address: transmitter,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: 'usedNonces',
    args: [nonce as Hex],
  })) as bigint;
  return used !== 0n;
}

/**
 * Finish a message: mint it on the destination.
 *
 * This is the only function here that spends anything. It deliberately does no
 * checking of its own — `outstandingBurns` decided, and duplicating the
 * `usedNonces` read here would only buy a narrower race, not close one. The
 * real backstop is the transmitter itself, which reverts on a used nonce.
 */
export async function submitReceive(
  wallet: WalletClient,
  transmitter: Address,
  message: Hex,
  attestation: Hex,
): Promise<Hash> {
  return wallet.writeContract({
    address: transmitter,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: 'receiveMessage',
    args: [message, attestation],
    account: wallet.account ?? null,
    chain: wallet.chain,
  });
}
