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
