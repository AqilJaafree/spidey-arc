/**
 * When to close a withdrawal epoch. Pure, so the refusals are provable.
 *
 * `requestWithdraw` puts a holder in the current epoch; `claimWithdraw` reverts
 * `EpochNotSettled` until that epoch has been closed. Nothing closes it —
 * `settleEpoch` is `onlyOperator` and the tick never called it — so a withdrawal
 * request sits in `pendingOf` indefinitely and the UI can only ever say
 * "awaiting settlement". This is the policy half of fixing that.
 *
 * # Why this is not "settle every tick"
 *
 * `queue.epoch` is a `uint16` and `settleEpoch` increments it inside an
 * `unchecked` block:
 *
 *     unchecked { queue = WithdrawQueue({epoch: q.epoch + 1, ...}); }
 *
 * At a 15-minute tick that is 35,040 settles a year and wraps to 0 in **1.9
 * years**, after which `p.epoch > lastSettledEpoch` compares a wrapped counter
 * against a stale one — old requests read as claimable, new ones as unsettled.
 * So an epoch id is a finite resource and settling an empty epoch spends one for
 * nothing. The trigger is therefore "this epoch has a request in it", not "time
 * passed", and that is a correctness constraint rather than gas thrift.
 *
 * The counting is the job's problem, and it can be incomplete — an RPC only
 * reaches so far back. `scanCapped` is how it says so, and an unseen epoch is
 * refused rather than guessed at, for the reason §10.2 gives everywhere else.
 */

/** Largest `uint16`, and so the last epoch id `settleEpoch` can safely produce. */
export const MAX_EPOCH = 65_535;

export type SettleInput = {
  /** `queue.epoch` — the epoch currently accepting requests. */
  epoch: number;
  /** `queue.lastSettledEpoch`. */
  lastSettledEpoch: number;
  /**
   * `WithdrawRequested` events seen in `epoch`. Zero means either an empty
   * epoch or a scan that could not see it — `scanCapped` separates those.
   */
  requestsInEpoch: number;
  /** `assets.pending` — owed across every unclaimed request, all epochs. */
  pendingAssets: bigint;
  /** `assets.idle` — what the vault can actually pay from. */
  idleAssets: bigint;
  /** True when the log scan hit its budget before reaching the epoch's start. */
  scanCapped: boolean;
};

export type SettleDecision =
  | { settle: false; reason: string }
  | { settle: true; epoch: number; reason: string; partialCoverage: boolean };

export function shouldSettle(input: SettleInput): SettleDecision {
  if (input.epoch <= input.lastSettledEpoch) {
    // Cannot happen against a healthy vault — `settleEpoch` always leaves
    // `epoch` one above `lastSettledEpoch`. If it does, the counter has wrapped
    // and settling again would make it worse.
    return {
      settle: false,
      reason: `queue is inconsistent: epoch ${input.epoch} is not above lastSettledEpoch ${input.lastSettledEpoch} — refusing to advance it`,
    };
  }

  if (input.epoch >= MAX_EPOCH) {
    return {
      settle: false,
      reason: `epoch ${input.epoch} is at the uint16 ceiling and settleEpoch increments unchecked — settling would wrap it to 0`,
    };
  }

  if (input.requestsInEpoch === 0) {
    return input.scanCapped
      ? {
          settle: false,
          reason: `saw no requests in epoch ${input.epoch}, but the scan was capped before reaching its start — refusing rather than assuming it is empty`,
        }
      : {
          settle: false,
          reason: `epoch ${input.epoch} is empty — an epoch id is finite and settling an empty one spends it for nothing`,
        };
  }

  // Settle even when idle falls short. Coverage is computed per claim from live
  // state, so a short vault pays pro-rata rather than reverting, and holding
  // settlement back until idle covers pending would strand the queue behind
  // capital that only returns when someone goes and fetches it.
  const partialCoverage = input.idleAssets < input.pendingAssets;
  return {
    settle: true,
    epoch: input.epoch,
    partialCoverage,
    reason: partialCoverage
      ? `${input.requestsInEpoch} request(s) in epoch ${input.epoch}; idle ${input.idleAssets} is under pending ${input.pendingAssets}, so claims will be haircut pro-rata`
      : `${input.requestsInEpoch} request(s) in epoch ${input.epoch}, fully covered by idle ${input.idleAssets}`,
  };
}
