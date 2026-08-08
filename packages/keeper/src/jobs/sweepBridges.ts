/**
 * Finish the bridges nobody finished, and tell the vault they landed.
 *
 * `messages.ts` finds burns that were never minted and mints them. This is the
 * half that follows: capital returns to Arc as a CCTP *mint*, so no executor
 * calls back and `returnToVault` has nothing to trigger on. Until
 * `Router.recordBridgeArrival` runs, the funds sit as unaccounted balance while
 * the venue's book still claims them, and the vault believes itself deployed.
 *
 * # Scope
 *
 * EVM legs only. `messages.ts` speaks viem's `PublicClient`/`WalletClient`, and
 * a Solana return needs the other signing scheme entirely — see
 * `createKeeperWallet`. Arc and Base sweep themselves; a Solana leg still needs
 * a hand, and that is stated in the README rather than left to be discovered.
 */

import type { Address, PublicClient, WalletClient } from 'viem';
import {
  isNonceUsedOn,
  messageTransmitterOf,
  outstandingBurns,
  scanBurns,
  submitReceive,
  type BurnLog,
} from '../messages.js';
import { CCTP_DOMAINS, fetchAttestation, type RelayChain } from '../relay.js';
import { chainForDomain, venuesOnDomain } from '../venueChain.js';

/** A message this tick minted, and where it came from. */
export type MintedArrival = {
  sourceDomain: number;
  amount: bigint;
  txHash: string;
};

/** One `recordBridgeArrival` call, ready to submit. */
export type Booking = {
  venueId: number;
  amount: bigint;
  sourceDomain: number;
  /** The burns this booking covers, comma-joined, for the log. */
  txHash: string;
};

/**
 * Turn minted arrivals into bookings.
 *
 * Pure, so the refusals below are provable without a chain — and the refusals
 * are the interesting part.
 *
 * Arrivals from one domain are summed into a single call. `recordBridgeArrival`
 * is bounded on-chain by unaccounted balance, so two calls racing the same
 * balance would leave the second booking less than it should, and the shortfall
 * is capital the vault goes on counting as deployed.
 *
 * Throws rather than skipping when a domain is ambiguous or unregistered. A
 * skipped arrival is capital that is home but still booked as deployed, and it
 * looks exactly like an arrival that was handled correctly — the failure would
 * be invisible in a log full of successes.
 */
export function planBookings(
  arrivals: readonly MintedArrival[],
  venuesByDomain: Record<number, number[]>,
): Booking[] {
  const byDomain = new Map<number, MintedArrival[]>();
  for (const a of arrivals) {
    const list = byDomain.get(a.sourceDomain) ?? [];
    list.push(a);
    byDomain.set(a.sourceDomain, list);
  }

  const bookings: Booking[] = [];
  for (const [domain, group] of byDomain) {
    const venues = venuesByDomain[domain] ?? [];
    if (venues.length === 0) {
      throw new RangeError(
        `no venue registered on domain ${domain}; ${group.length} arrival(s) cannot be booked`,
      );
    }
    if (venues.length > 1) {
      throw new RangeError(
        `ambiguous: venues ${venues.join(', ')} all sit on domain ${domain}; refusing to guess`,
      );
    }
    bookings.push({
      venueId: venues[0]!,
      amount: group.reduce((sum, a) => sum + a.amount, 0n),
      sourceDomain: domain,
      txHash: group.map((a) => a.txHash).join(','),
    });
  }
  return bookings;
}

/** `Router.recordBridgeArrival`. */
export const ROUTER_ABI = [
  {
    type: 'function', name: 'recordBridgeArrival', stateMutability: 'nonpayable',
    inputs: [{ name: 'venueId', type: 'uint16' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'booked', type: 'uint256' }],
  },
] as const;

/** The two fields of a block a block time is measured from. */
export type BlockStamp = { number: bigint; timestamp: bigint };

/**
 * Seconds per block, measured from the chain rather than assumed.
 *
 * The sweep's lookback is expressed in *time* — "seven days of history" — but
 * `eth_getLogs` is addressed in blocks, so something has to convert. A constant
 * would be wrong on both chains here and wrong in different directions: Arc
 * testnet runs at ~0.51s and Base Sepolia at 2.0s, a factor of four. Assuming
 * the slower one silently turns seven days of Arc history into under two, and
 * the burns that fall off the end are exactly the old ones a sweep exists to
 * find. So it is derived from two real block timestamps every run.
 *
 * Both degenerate inputs throw rather than returning a default. A zero or
 * negative span means the caller sampled the same block twice or read a
 * reorged/clock-skewed pair, and a fabricated block time would produce a
 * plausible-looking window covering the wrong range — the worst failure this
 * job has, because it looks like a successful scan.
 */
export function blockTimeBetween(older: BlockStamp, newer: BlockStamp): number {
  const blocks = newer.number - older.number;
  if (blocks <= 0n) {
    throw new RangeError(
      `cannot measure block time: block ${newer.number} is not after ${older.number}`,
    );
  }
  const seconds = newer.timestamp - older.timestamp;
  if (seconds <= 0n) {
    throw new RangeError(
      `cannot measure block time: ${blocks} block(s) span ${seconds}s`,
    );
  }
  return Number(seconds) / Number(blocks);
}

/** One `eth_getLogs` call's worth of blocks. Both bounds inclusive. */
export type ScanRange = { fromBlock: bigint; toBlock: bigint };

export type ScanWindow = {
  /** In ascending block order, contiguous, the last ending at the head. */
  ranges: ScanRange[];
  /** Blocks covered in total, head included. */
  blocks: bigint;
  /** What that is worth in history, at the measured block time. */
  seconds: number;
  /** True when the range limit or the request budget cut the lookback short. */
  truncated: boolean;
};

/**
 * Turn "look back N seconds" into the `eth_getLogs` calls that cover it.
 *
 * Two limits shape this, and neither is optional.
 *
 * Every public RPC caps the span of a single `getLogs`. Measured against the
 * endpoints this keeper defaults to: Arc serves 20 000 blocks and answers
 * `requested range too large` at 30 000; Base Sepolia's cap is 2 000. Seven
 * days is 1.2M blocks on Arc and 300k on Base, so the window is necessarily
 * many calls rather than one, and asking for it in one gets an error, not a
 * short answer.
 *
 * The second limit is the budget, and it is not theoretical. Seven days is 59
 * calls on Arc and 152 on Base, and the Arc endpoint starts answering 429 after
 * about fifteen 20 000-block queries in a burst — measured, not feared: the
 * first version of this job asked for the full seven days and the tick failed
 * on its twentieth request. Chunking without a bound is how a keeper
 * rate-limits itself into failing every run. So each chain states how many
 * calls a sweep may cost there, and the window shrinks to fit rather than the
 * tick running away.
 *
 * When the budget binds, `truncated` is set and the caller must say so in its
 * log. A shortened window is not a harmless optimisation: **a service down for
 * longer than the window forgets those burns entirely.** The capital is not
 * lost — it is burned, attested, and mintable by anyone holding the message —
 * but nothing books it automatically, and it takes a human noticing before it
 * comes home. That is the whole reason the window is logged every run instead
 * of being an implicit constant.
 *
 * Pure, so those bounds are provable without a chain.
 */
export function planScanWindow(opts: {
  head: bigint;
  blockTimeSeconds: number;
  lookbackSeconds: number;
  maxLogRange: number;
  maxRequests: number;
}): ScanWindow {
  const { head, blockTimeSeconds, lookbackSeconds, maxLogRange, maxRequests } = opts;
  if (!(blockTimeSeconds > 0)) throw new RangeError(`block time must be positive, got ${blockTimeSeconds}`);
  if (!(lookbackSeconds > 0)) throw new RangeError(`lookback must be positive, got ${lookbackSeconds}s`);
  if (!Number.isInteger(maxLogRange) || maxLogRange < 1) throw new RangeError(`maxLogRange must be >= 1, got ${maxLogRange}`);
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new RangeError(`maxRequests must be >= 1, got ${maxRequests}`);
  if (head < 0n) throw new RangeError(`head must not be negative, got ${head}`);

  // Round up: a window one block short of the lookback is a window that can
  // drop the oldest burn, and the cost of a block too many is nothing.
  const wanted = BigInt(Math.ceil(lookbackSeconds / blockTimeSeconds));
  const affordable = BigInt(maxLogRange) * BigInt(maxRequests);
  const span = wanted < affordable ? wanted : affordable;

  // Genesis is the floor. A chain younger than the lookback is not truncation —
  // there is no history being skipped, only history that does not exist.
  const earliest = head + 1n > span ? head + 1n - span : 0n;

  const ranges: ScanRange[] = [];
  for (let from = earliest; from <= head; from += BigInt(maxLogRange)) {
    const to = from + BigInt(maxLogRange) - 1n;
    ranges.push({ fromBlock: from, toBlock: to < head ? to : head });
  }

  const blocks = head - earliest + 1n;
  return {
    ranges,
    blocks,
    seconds: Number(blocks) * blockTimeSeconds,
    truncated: span < wanted,
  };
}

/**
 * Seven days — long enough that a weekend outage still self-heals on Monday.
 *
 * This is what the sweep *asks* for. Whether it gets it is the endpoint's
 * decision: see `planScanWindow`, and the `CAPPED` note this job logs when a
 * chain's request budget cannot reach back that far.
 */
export const DEFAULT_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

/**
 * `eth_getLogs` calls one chain may cost per sweep, when the caller does not
 * say. Deliberately small: an endpoint whose limits are unknown is assumed
 * tight, because the failure of guessing high is a tick that dies partway
 * through with some chains scanned and some not.
 */
export const DEFAULT_SCAN_REQUESTS = 12;

/** Where arrivals are booked. Arc is the hub; nothing else has a Router. */
const BOOKING_CHAIN: RelayChain = 'arc-testnet';

/** One EVM chain the sweep can read, and possibly write. */
export type SweepChain = {
  client: PublicClient;
  /**
   * CCTP v2's `TokenMessengerV2` on this chain — the contract `DepositForBurn`
   * is emitted from, and the one the transmitter is read off. Never pair it
   * with a hardcoded transmitter: see `messageTransmitterOf`.
   */
  tokenMessenger: Address;
  /**
   * The one contract whose burns leave this chain — `CctpBridgeExecutor` on
   * Arc, `CctpReturnRelay` on Base. Omit for a chain we only ever mint into,
   * and it is skipped as a source.
   */
  depositor?: Address;
  /** Signs `receiveMessage` here. Omit to decide but write nothing. */
  wallet?: WalletClient;
  /** Blocks per `eth_getLogs` this endpoint will serve. */
  maxLogRange: number;
  /**
   * `eth_getLogs` calls a sweep may spend here. Per chain rather than shared,
   * because it is a property of the endpoint: a cheap 2 000-block query and an
   * expensive 20 000-block one do not cost the same limiter the same.
   */
  maxScanRequests?: number;
};

export type SweepBridgesDeps = {
  /**
   * Every EVM chain in the loop, sources and destinations both. A destination
   * absent from here is a leg this keeper cannot finish — reported, never
   * silently dropped.
   */
  chains: Partial<Record<RelayChain, SweepChain>>;
  /** Arc's `LPVault` — which venues sit on which CCTP domain. */
  vault: Address;
  /** Arc's `Router` — `recordBridgeArrival`. */
  router: Address;
  lookbackSeconds?: number;
};

const days = (seconds: number) => `${(seconds / 86_400).toFixed(2)}d`;

/**
 * Finish every burn Circle has attested that the destination never minted, and
 * book the ones that landed on Arc.
 *
 * The failure this closes is two failures joined end to end. A CCTP transfer is
 * two transactions on two chains, and every second half here has been driven by
 * hand — when nobody runs it, the capital sits burned-and-unminted while Circle
 * has already signed off on it. And once it *is* minted on Arc, nothing tells
 * the vault: capital returns as a mint, so no executor calls back, and until
 * `recordBridgeArrival` runs the vault believes itself deployed while the money
 * is already home.
 *
 * Stateless, like the tick it runs in. `usedNonces` on each destination is the
 * ledger of what has been minted, so a re-run, a crash mid-submit, or two
 * keepers racing cannot double-mint — the second one finds the nonce used and
 * skips it.
 *
 * # Scope
 *
 * EVM legs only. `messages.ts` speaks viem's `PublicClient`/`WalletClient`, and
 * a Solana return needs the other signing scheme entirely — a keeper key derives
 * a different account under each, and no viem wallet can sign for Solana at all.
 * Burns bound for a domain with no configured EVM chain are counted and named in
 * the summary rather than quietly dropped: they still need a human.
 *
 * Read-only — no `wallet` on a chain — reads everything and decides everything,
 * reporting what it would mint and book, and writes nothing. Same contract the
 * NAV job honours, for the reason `keys.ts` records.
 */
export async function sweepBridgesJob(deps: SweepBridgesDeps): Promise<string> {
  const lookbackSeconds = deps.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS;

  let scanned = 0;
  let outstandingCount = 0;
  let minted = 0;
  let wouldMint = 0;
  let unreachable = 0;
  const arrivals: MintedArrival[] = [];

  const sources = Object.entries(deps.chains) as [RelayChain, SweepChain | undefined][];

  for (const [name, source] of sources) {
    // No depositor means nothing burns here and this is a destination only.
    // `Partial` also permits an explicit `undefined` entry, which is a chain
    // the caller deliberately switched off rather than a mistake.
    if (!source?.depositor) continue;
    const sourceDomain = CCTP_DOMAINS[name];

    const head = await source.client.getBlockNumber();

    // Two real timestamps, a thousand blocks apart where the chain is that old.
    // One block apart would be dominated by whatever jitter that single block
    // had; a thousand averages it out and still costs two calls.
    const sample = head > 1000n ? 1000n : head;
    const [newest, oldest] = [
      await source.client.getBlock({ blockNumber: head }),
      await source.client.getBlock({ blockNumber: head - sample }),
    ];
    const blockTimeSeconds = blockTimeBetween(
      { number: head - sample, timestamp: oldest.timestamp },
      { number: head, timestamp: newest.timestamp },
    );

    const maxRequests = source.maxScanRequests ?? DEFAULT_SCAN_REQUESTS;
    const window = planScanWindow({
      head, blockTimeSeconds, lookbackSeconds,
      maxLogRange: source.maxLogRange, maxRequests,
    });

    // Logged every run rather than left implicit. When the window is short, the
    // burns older than it are invisible to this job forever — see
    // `planScanWindow` — and an operator can only act on that if it is on screen.
    console.log(
      `  ${name} blocks ${window.ranges[0]!.fromBlock}-${head} ` +
        `(${window.ranges.length} x ${source.maxLogRange} @ ${blockTimeSeconds.toFixed(3)}s), ` +
        `window ${days(window.seconds)}` +
        (window.truncated
          ? ` of ${days(lookbackSeconds)} asked for — CAPPED by the RPC range limit and a ${maxRequests}-call budget`
          : ''),
    );

    const burns: BurnLog[] = [];
    for (const range of window.ranges) {
      burns.push(
        ...(await scanBurns(
          source.client, source.tokenMessenger, source.depositor,
          range.fromBlock, range.toBlock,
        )),
      );
    }
    scanned += burns.length;
    // Per chain, not just in the summary: "the sweep saw nothing" and "the
    // sweep saw nothing *on this chain*" are different findings, and only the
    // second one points at a window that is too short.
    console.log(`  ${name} ${burns.length} burn(s) by ${source.depositor} in window`);

    // Grouped by destination so the transmitter is read once per destination
    // rather than once per burn, and so `isNonceUsed` is bound to the right
    // chain's client. The mapping is per-chain: asking the source answers 0 for
    // everything, and the sweep would resubmit messages that landed long ago.
    const byDestination = new Map<number, BurnLog[]>();
    for (const burn of burns) {
      const group = byDestination.get(burn.destinationDomain) ?? [];
      group.push(burn);
      byDestination.set(burn.destinationDomain, group);
    }

    for (const [destinationDomain, group] of byDestination) {
      const destinationName = chainForDomain(destinationDomain);
      const destination = deps.chains[destinationName];
      if (!destination) {
        unreachable += group.length;
        console.log(
          `  ${group.length} burn(s) ${name} → ${destinationName}: no EVM client configured, ` +
            'not checked — that leg is finished by hand',
        );
        continue;
      }

      const transmitter = await messageTransmitterOf(destination.client, destination.tokenMessenger);
      const outstanding = await outstandingBurns(group, {
        attestationOf: (txHash) => fetchAttestation(sourceDomain, txHash),
        isNonceUsed: (nonce) => isNonceUsedOn(destination.client, transmitter, nonce),
      });
      outstandingCount += outstanding.length;

      for (const burn of outstanding) {
        if (destination.wallet) {
          const hash = await submitReceive(
            destination.wallet, transmitter, burn.message, burn.attestation,
          );
          minted++;
          console.log(`  minted ${burn.amount} on ${destinationName} for ${burn.txHash} → ${hash}`);
        } else {
          wouldMint++;
          console.log(`  would mint ${burn.amount} on ${destinationName} for ${burn.txHash} — read-only`);
        }

        // Recorded whether or not it was actually minted: read-only has to be
        // able to report the booking it would have made, and a booking is the
        // half of this job most likely to refuse.
        if (destinationName === BOOKING_CHAIN) {
          arrivals.push({ sourceDomain, amount: burn.amount, txHash: burn.txHash });
        }
      }
    }
  }

  let booked = 0;
  let wouldBook = 0;

  if (arrivals.length > 0) {
    const arc = deps.chains[BOOKING_CHAIN]!; // an arrival here means it was configured

    // Once per distinct source domain, not once per burn. `venuesOnDomain`
    // costs one round trip per registered venue, and the vault's venue table
    // cannot change between two burns of a single sweep — re-reading it per
    // burn multiplies identical calls for nothing.
    const venuesByDomain: Record<number, number[]> = {};
    for (const domain of new Set(arrivals.map((a) => a.sourceDomain))) {
      venuesByDomain[domain] = await venuesOnDomain(arc.client, deps.vault, domain);
    }

    // Deliberately not caught. `planBookings` refuses all-or-nothing when a
    // domain is ambiguous or unregistered, and that refusal is only worth
    // having if it reaches the exit code: `runJobs` marks the job failed and
    // the tick exits non-zero, which is the entire signal a scheduler sees.
    // Catching it here would turn a loud refusal into one more line in a log
    // full of successes — precisely the invisible failure it exists to prevent.
    const bookings = planBookings(arrivals, venuesByDomain);

    for (const booking of bookings) {
      if (arc.wallet) {
        const hash = await arc.wallet.writeContract({
          address: deps.router, abi: ROUTER_ABI, functionName: 'recordBridgeArrival',
          args: [booking.venueId, booking.amount],
          chain: arc.wallet.chain, account: arc.wallet.account!,
        });
        booked++;
        console.log(`  booked ${booking.amount} to venue ${booking.venueId} (${booking.txHash}) → ${hash}`);
      } else {
        wouldBook++;
        console.log(`  would book ${booking.amount} to venue ${booking.venueId} (${booking.txHash}) — read-only`);
      }
    }
  }

  let summary =
    `scanned ${scanned} burn(s), ${outstandingCount} outstanding, ${minted} minted, ${booked} booked`;
  if (wouldMint > 0 || wouldBook > 0) {
    summary += ` — read-only: would mint ${wouldMint} and book ${wouldBook}`;
  }
  if (unreachable > 0) {
    summary += `; ${unreachable} burn(s) to a non-EVM leg left for a human`;
  }
  return summary;
}
