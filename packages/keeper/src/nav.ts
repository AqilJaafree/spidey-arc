/**
 * The vault's NAV mark, and when to refresh it.
 *
 * `LPVault.claimWithdraw` reverts `NavStale` rather than paying out of a mark
 * older than `MAX_NAV_AGE`. Nothing called `reportNav` on any schedule, so the
 * mark only ever aged — and an under-covered vault stopped paying claims six
 * hours after the reporter last spoke.
 *
 * # Why re-posting an unchanged number is honest here
 *
 * In general it is not. Refreshing `updatedAt` on a number nobody checked
 * converts the safe failure (refuse to pay) into the unsafe one (pay at par out
 * of a loss nobody marked down) — the failure `LPVault.sol:649-662` names,
 * where the shortfall lands on whoever claims last.
 *
 * The Arc hub is the exception, because its deployed capital is USDC: venue 2
 * routes through `CctpBridgeExecutor` into `CctpReturnRelay` on Base, which
 * holds a stablecoin whose value does not drift. So an unchanged number is a
 * *finding* — provided the caller verified it against the relay balance this
 * run. That proviso is the whole design, and it lives in the caller: this
 * module is handed `computed` and trusts it was measured.
 *
 * Everything here is pure, so the rules can be proven without a chain — the
 * same split `rules.rs` uses on Solana and `plan.ts` uses for the Router.
 */

/** Basis points. `LPVault.BPS` is `private`, and 10,000 is the definition. */
const BPS = 10_000n;

/**
 * The contract's own bounds, read from the chain rather than hardcoded.
 *
 * Reading them removes the drift this module would otherwise have to guard
 * against: the keeper cannot disagree with a contract it just asked. Only
 * `reportAtAgeSeconds` is ours — a keeper margin, not a contract constant.
 */
export type NavBounds = {
  /** `LPVault.NAV_COOLDOWN`. No two reports closer together than this. */
  navCooldownSeconds: number;
  /** `LPVault.MAX_NAV_AGE`. Past this, `claimWithdraw` reverts. */
  maxNavAgeSeconds: number;
  /** `LPVault.MAX_NAV_DELTA_BPS`. Largest single step, in bps of the previous mark. */
  maxNavDeltaBps: number;
  /**
   * When to refresh an unchanged mark. Ours, not the contract's: it must leave
   * room for at least one retry inside a cooldown before `maxNavAgeSeconds`.
   */
  reportAtAgeSeconds: number;
};

export type NavDecision =
  | { post: false; reason: 'nothing-deployed' | 'cooldown' | 'fresh-and-unchanged' }
  | { post: true; amount: bigint; capped: boolean; reason: 'changed' | 'ageing' };

/**
 * What the hub's deployed capital is worth.
 *
 * In-flight counts at full value. It is burned on Arc and not yet minted on
 * Base, which CCTP attestation guarantees will complete — haircutting
 * depositors for a normal bridge delay would be marking a loss that is not
 * happening.
 */
export function deployedValue(input: { relayBalance: bigint; inFlight: bigint }): bigint {
  return input.relayBalance + input.inFlight;
}

/**
 * Whether to post, and what.
 *
 * Mirrors `reportNav`'s own guards so the keeper never submits a transaction
 * the chain will reject — the same discipline `routerWouldAccept` applies to
 * the Router's integer check.
 */
export function shouldReport(input: {
  current: bigint;
  computed: bigint;
  updatedAt: number;
  now: number;
  bounds: NavBounds;
}): NavDecision {
  const { current, computed, updatedAt, now, bounds } = input;

  // Nothing deployed means nothing unverified, so age cannot matter — the
  // contract skips its own staleness check on the same condition.
  if (current === 0n) return { post: false, reason: 'nothing-deployed' };

  const age = now - updatedAt;
  if (age < bounds.navCooldownSeconds) return { post: false, reason: 'cooldown' };

  const ageing = age >= bounds.reportAtAgeSeconds;
  if (computed === current && !ageing) return { post: false, reason: 'fresh-and-unchanged' };

  // The contract rejects on `diff * BPS > previous * MAX_NAV_DELTA_BPS`, a
  // strict `>`, so a step landing exactly on the boundary is accepted. Integer
  // division floors, which lands on or below it — never above.
  const maxStep = (current * BigInt(bounds.maxNavDeltaBps)) / BPS;
  const rising = computed > current;
  const diff = rising ? computed - current : current - computed;
  const capped = diff > maxStep;

  let amount: bigint;
  if (!capped) {
    amount = computed;
  } else if (rising) {
    amount = current + maxStep;
  } else {
    // Cannot underflow: maxStep is a fraction of current, so current - maxStep
    // is non-negative for any current >= 0.
    amount = current - maxStep;
  }

  return { post: true, amount, capped, reason: computed === current ? 'ageing' : 'changed' };
}
