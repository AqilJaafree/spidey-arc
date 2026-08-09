/**
 * The settlement job: close a withdrawal epoch that has requests waiting in it.
 *
 * The gap this fills is a dead end rather than a drift. `requestWithdraw` works,
 * `claimWithdraw` works, and between them sits `settleEpoch` — `onlyOperator`,
 * and called by nothing. A holder's request lands in `pendingOf`, the vault
 * reverts `EpochNotSettled(p.epoch, lastSettled)` on every claim, and the best a
 * UI can do is render "awaiting settlement" forever.
 *
 * The policy lives in `settle.ts` and is pure. This half is discovery: how many
 * requests are in the current epoch, and whether it could see far enough back to
 * be sure. It reports rather than exits, because inside a tick one job's failure
 * must not stop the others.
 */

import { parseAbi, type Address, type PublicClient, type WalletClient } from 'viem';
import { shouldSettle } from '../settle.js';

export const SETTLE_ABI = parseAbi([
  'function settleEpoch() returns (uint16)',
  'function queue() view returns (uint16 epoch, uint16 lastSettledEpoch)',
  'function assets() view returns (uint128 idle, uint128 pending)',
  'event WithdrawRequested(uint256 indexed requestId, address indexed owner, uint256 shares, uint256 assets, uint16 epoch)',
  'event EpochSettled(uint16 indexed epoch, uint256 pendingAssets, uint256 idleAssets)',
]);

export type SettleEpochsDeps = {
  arc: PublicClient;
  vault: Address;
  /** Omit to run read-only: it decides and reports, but never settles. */
  wallet?: WalletClient;
  /** Blocks per `eth_getLogs` this endpoint will serve. */
  maxLogRange?: number;
  /** `eth_getLogs` calls this job may spend. */
  maxScanRequests?: number;
};

/** Arc serves a 20,000-block span and refuses 30,000 — see `bin/tick.ts`. */
const DEFAULT_LOG_RANGE = 20_000;
/** Small on purpose: the steady-state scan is one tick's worth of blocks. */
const DEFAULT_SCAN_REQUESTS = 4;

/**
 * Requests in the current epoch, counted backwards from head.
 *
 * Anchored on the last `EpochSettled`, because a request in the current epoch
 * can only have been made after the previous one closed. In steady state that is
 * a few blocks and the scan is trivial; it is only long on a vault that has never
 * settled, which is exactly the state this job exists to leave behind.
 *
 * `epoch` is not an indexed event parameter, so it cannot be filtered on and the
 * decode has to be read. Returns `capped` when the budget ran out before the
 * anchor was reached — `shouldSettle` refuses on that rather than reading an
 * unseen epoch as an empty one.
 */
async function countRequestsInEpoch(
  deps: SettleEpochsDeps,
  epoch: number,
): Promise<{ requests: number; capped: boolean; blocksScanned: bigint }> {
  const maxLogRange = BigInt(deps.maxLogRange ?? DEFAULT_LOG_RANGE);
  const budget = deps.maxScanRequests ?? DEFAULT_SCAN_REQUESTS;

  const head = await deps.arc.getBlockNumber();
  let to = head;
  let requests = 0;
  let blocksScanned = 0n;

  for (let spent = 0; spent < budget; spent += 1) {
    const from = to > maxLogRange ? to - maxLogRange + 1n : 0n;

    const [settled, requested] = await Promise.all([
      deps.arc.getContractEvents({
        address: deps.vault, abi: SETTLE_ABI, eventName: 'EpochSettled',
        fromBlock: from, toBlock: to,
      }),
      deps.arc.getContractEvents({
        address: deps.vault, abi: SETTLE_ABI, eventName: 'WithdrawRequested',
        fromBlock: from, toBlock: to,
      }),
    ]);

    for (const log of requested) {
      if (Number(log.args.epoch) === epoch) requests += 1;
    }
    blocksScanned += to - from + 1n;

    // The anchor: everything before the most recent settle belongs to an epoch
    // that is already closed, so there is nothing further back worth counting.
    if (settled.length > 0) return { requests, capped: false, blocksScanned };
    if (from === 0n) return { requests, capped: false, blocksScanned };

    to = from - 1n;
  }

  return { requests, capped: true, blocksScanned };
}

export async function settleEpochsJob(deps: SettleEpochsDeps): Promise<string> {
  const [queue, assets] = await Promise.all([
    deps.arc.readContract({ address: deps.vault, abi: SETTLE_ABI, functionName: 'queue' }),
    deps.arc.readContract({ address: deps.vault, abi: SETTLE_ABI, functionName: 'assets' }),
  ]);
  const [epoch, lastSettledEpoch] = queue;
  const [idleAssets, pendingAssets] = assets;

  // Logged so both a tick and a human see the inputs the summary came from.
  console.log(`  queue  epoch ${epoch}, lastSettled ${lastSettledEpoch}`);
  console.log(`  assets idle ${idleAssets}, pending ${pendingAssets}`);

  // Nothing outstanding anywhere means nothing can be waiting in this epoch, and
  // that is knowable from two storage reads without spending a log query on it.
  if (pendingAssets === 0n) {
    return `nothing pending — epoch ${epoch} has nothing to settle`;
  }

  const { requests, capped, blocksScanned } = await countRequestsInEpoch(deps, epoch);
  console.log(`  scan   ${requests} request(s) in epoch ${epoch} over ${blocksScanned} blocks${capped ? ' (CAPPED)' : ''}`);

  const decision = shouldSettle({
    epoch, lastSettledEpoch, requestsInEpoch: requests,
    pendingAssets, idleAssets, scanCapped: capped,
  });

  if (!decision.settle) return `no settle: ${decision.reason}`;
  if (!deps.wallet) {
    return `would settle epoch ${decision.epoch} (${decision.reason}) — read-only, no key`;
  }

  const hash = await deps.wallet.writeContract({
    address: deps.vault, abi: SETTLE_ABI, functionName: 'settleEpoch',
    args: [], chain: deps.wallet.chain, account: deps.wallet.account!,
  });
  return `settled epoch ${decision.epoch} (${decision.reason}) ${hash}`;
}
