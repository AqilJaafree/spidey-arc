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
 * of a loss nobody marked down) — the failure `claimWithdraw`'s `NavStale`
 * guard exists to prevent, where the shortfall lands on whoever claims last.
 *
 * The Arc hub is the exception, because its deployed capital is USDC:
 * `CctpBridgeExecutor` routes it into `CctpReturnRelay` on Base, which holds a
 * stablecoin whose value does not drift. So an unchanged number is a *finding*
 * — provided the caller verified it against the relay balance this run. That
 * proviso is the whole design, and it lives in the caller: this module is
 * handed `computed` and trusts it was measured.
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
 * against: the keeper cannot disagree with a contract it just asked.
 */
export type NavBounds = {
  /** `LPVault.NAV_COOLDOWN`. No two reports closer together than this. */
  navCooldownSeconds: number;
  /** `LPVault.MAX_NAV_AGE`. Past this, `claimWithdraw` reverts. */
  maxNavAgeSeconds: number;
  /** `LPVault.MAX_NAV_DELTA_BPS`. Largest single step, in bps of the previous mark. */
  maxNavDeltaBps: number;
  /**
   * When to refresh an unchanged mark. Ours, not the contract's — and so the
   * only bound here that can be wrong, since the other three are read from the
   * chain each run. Omit it to derive `maxNavAgeSeconds - 2 * navCooldownSeconds`:
   * one attempt and one retry inside the staleness window.
   */
  reportAtAgeSeconds?: number;
};

/**
 * Machine tokens, not the prose `plan.ts` returns.
 *
 * A `RebalancePlan.reason` is a sentence for an operator reading a log; these
 * are branch names a caller switches on — the CLI picks the exit code and the
 * message from the token, so the wording stays in one place instead of being
 * parsed back out of a string.
 */
export type NavDecision =
  | { post: false; reason: 'nothing-deployed' | 'cooldown' | 'clock-behind-chain' | 'fresh-and-unchanged' }
  | { post: true; amount: bigint; capped: boolean; reason: 'changed' | 'ageing' };

/**
 * The age at which an unchanged mark gets refreshed.
 *
 * Derived from the chain's own deadline unless overridden, so the margin
 * cannot drift from the bound it is a margin against. Rejects any value
 * leaving no room for a retry before the mark goes stale — including exactly
 * zero, which is worse than tight: `age >= 0` is always true, so the keeper
 * would post every cooldown forever.
 *
 * Throws rather than clamps. A clamp would multiply how often the "caller
 * verified it this run" proviso has to hold, while hiding the misconfiguration
 * exactly when someone should be looking at it. `RangeError` is the house
 * signal for an argument that cannot be satisfied — see `buildEpochTree` and
 * `bookableAmount`.
 */
function resolveReportAtAge(bounds: NavBounds): number {
  const derived = bounds.reportAtAgeSeconds
    ?? bounds.maxNavAgeSeconds - 2 * bounds.navCooldownSeconds;
  if (derived <= 0 || derived + bounds.navCooldownSeconds > bounds.maxNavAgeSeconds) {
    throw new RangeError(
      `reportAtAgeSeconds ${derived} leaves no room to retry before maxNavAgeSeconds `
        + `${bounds.maxNavAgeSeconds} at cooldown ${bounds.navCooldownSeconds}`,
    );
  }
  return derived;
}

/**
 * What the hub's deployed capital is worth.
 *
 * In-flight counts at full value. It is burned on Arc and not yet minted on
 * Base, which CCTP attestation guarantees will complete — haircutting
 * depositors for a normal bridge delay would be marking a loss that is not
 * happening.
 *
 * This is what `shouldReport` expects as `computed`. Nothing in the types binds
 * the two: `shouldReport` takes a bare `bigint` and trusts it was measured this
 * run, so a caller that passes a stale or guessed number gets the unsafe
 * failure the module header warns about, with no type error to stop it.
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
 *
 * @param nowSeconds Seconds, and tracking the *chain's* clock rather than the
 *        host's — `updatedAtSeconds` comes from a block timestamp, so the two
 *        must be comparable. (`Date.now()` is milliseconds; passing it makes
 *        every age astronomical and posts unconditionally.) At the live bounds
 *        the slack between `reportAtAgeSeconds + navCooldownSeconds` and
 *        `maxNavAgeSeconds` is 3,600s, so a host lagging the chain by more than
 *        an hour lets the mark go stale while this module still calls it fresh.
 */
export function shouldReport(input: {
  current: bigint;
  computed: bigint;
  updatedAtSeconds: number;
  nowSeconds: number;
  bounds: NavBounds;
}): NavDecision {
  const { current, computed, updatedAtSeconds, nowSeconds, bounds } = input;

  // Before anything else, so a bad margin is a loud failure on the first run
  // rather than a silent one on the first vault that has capital deployed.
  const reportAtAgeSeconds = resolveReportAtAge(bounds);

  // Nothing deployed means nothing unverified, so age cannot matter — the
  // contract skips its own staleness check on the same condition.
  if (current === 0n) return { post: false, reason: 'nothing-deployed' };

  const age = nowSeconds - updatedAtSeconds;
  // A mark stamped in our future means the clocks disagree, and every age
  // derived from it is wrong. Falling through to the cooldown refusal would be
  // safe but mislabelled, sending whoever reads the log after the mark goes
  // stale to look at `NAV_COOLDOWN` instead of at the clock.
  if (age < 0) return { post: false, reason: 'clock-behind-chain' };
  if (age < bounds.navCooldownSeconds) return { post: false, reason: 'cooldown' };

  const ageing = age >= reportAtAgeSeconds;
  if (computed === current && !ageing) return { post: false, reason: 'fresh-and-unchanged' };

  // The contract rejects on `diff * BPS > previous * MAX_NAV_DELTA_BPS`, a
  // strict `>`, so a step landing exactly on the boundary is accepted. Integer
  // division floors, which lands on or below it — never above.
  //
  // Below 20 base units the floor is 0, so a capped step moves nothing and the
  // mark parks at a fixed point. That is deliberate, and the re-post there is
  // load-bearing rather than wasted gas: `claimWithdraw` only skips its
  // `NavStale` gate when `deployedAssets` is zero, and 19 base units is not
  // zero — so the vault is still gated, and the hourly re-post is exactly what
  // keeps claims payable. Marking the position to zero is not this module's
  // job: `LPVault.recordVenueClosed` zeroes the mark outright, which is why it
  // exists — a 5%-per-step walk-down asymptotes and never arrives.
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

  // `amount` is an unbounded bigint; `reportNav` takes a uint128. That ceiling
  // is ~3.4e26 USDC and unreachable by a value derived from real balances, so
  // it is left unchecked — the one remaining way this module could propose
  // something the chain rejects.
  //
  // `reason` describes the measurement, not the post: a fall capped to a
  // floored `maxStep` of 0 logs `changed` while posting the number already on
  // chain. (`ageing` cannot be capped — `computed === current` makes `diff` 0.)
  return { post: true, amount, capped, reason: computed === current ? 'ageing' : 'changed' };
}
