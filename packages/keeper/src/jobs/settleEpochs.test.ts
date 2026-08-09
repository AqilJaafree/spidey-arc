/**
 * The discovery half of the settlement job.
 *
 * `shouldSettle` is tested purely in `settle.test.ts`; what is left here is the
 * part that decides *what to pass it* — the anchor on the last `EpochSettled`,
 * the client-side epoch filter (`epoch` is not an indexed event parameter), and
 * the budget that separates "this epoch is empty" from "I could not see it".
 *
 * Against the live vault this path never runs: `pending` is 0, so the job
 * short-circuits on two storage reads. That is the right behaviour and it leaves
 * the scan unexercised, which is what these stubs are for.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { settleEpochsJob } from './settleEpochs.js';

const VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as Address;

type Requested = { blockNumber: bigint; epoch: number };

/**
 * A client that answers only what this job asks. `head` and `maxLogRange` are
 * chosen so one query spans the whole chain unless a test says otherwise.
 */
function stubArc(opts: {
  epoch: number;
  lastSettledEpoch: number;
  idle: bigint;
  pending: bigint;
  requested?: Requested[];
  settledAt?: bigint | null;
  head?: bigint;
}): { client: PublicClient; calls: () => number } {
  let getLogsCalls = 0;
  const head = opts.head ?? 1_000n;

  const client = {
    getBlockNumber: async () => head,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'queue'
        ? [opts.epoch, opts.lastSettledEpoch]
        : [opts.idle, opts.pending],
    getContractEvents: async ({
      eventName,
      fromBlock,
      toBlock,
    }: {
      eventName: string;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      if (eventName === 'EpochSettled') {
        getLogsCalls += 1;
        const at = opts.settledAt;
        return at !== null && at !== undefined && at >= fromBlock && at <= toBlock
          ? [{ args: { epoch: opts.epoch - 1 } }]
          : [];
      }
      return (opts.requested ?? [])
        .filter((r) => r.blockNumber >= fromBlock && r.blockNumber <= toBlock)
        .map((r) => ({ args: { epoch: r.epoch } }));
    },
  } as unknown as PublicClient;

  return { client, calls: () => getLogsCalls };
}

describe('settle-epochs: what it decides to ask about', () => {
  it('spends no log query when nothing is pending anywhere', async () => {
    // Two storage reads are enough to know this, and a log scan on Arc is the
    // expensive thing the tick budgets for.
    const { client, calls } = stubArc({ epoch: 1, lastSettledEpoch: 0, idle: 1_499_935n, pending: 0n });
    const summary = await settleEpochsJob({ arc: client, vault: VAULT });
    expect(summary).toMatch(/nothing pending/);
    expect(calls()).toBe(0);
  });

  it('settles when a request sits in the current epoch', async () => {
    const { client } = stubArc({
      epoch: 4,
      lastSettledEpoch: 3,
      idle: 1_000_000n,
      pending: 500_000n,
      requested: [{ blockNumber: 900n, epoch: 4 }],
      settledAt: 800n,
    });
    const summary = await settleEpochsJob({ arc: client, vault: VAULT });
    expect(summary).toMatch(/would settle epoch 4/);
    expect(summary).toMatch(/read-only/);
  });

  it('ignores requests belonging to other epochs', async () => {
    // `epoch` is not indexed, so it cannot be filtered on-chain and the decode
    // has to be read. A miscount here settles an epoch that has nothing in it.
    const { client } = stubArc({
      epoch: 4,
      lastSettledEpoch: 3,
      idle: 1_000_000n,
      pending: 500_000n,
      requested: [
        { blockNumber: 880n, epoch: 3 },
        { blockNumber: 890n, epoch: 5 },
      ],
      settledAt: 800n,
    });
    const summary = await settleEpochsJob({ arc: client, vault: VAULT });
    expect(summary).toMatch(/no settle/);
    expect(summary).toMatch(/empty/);
  });

  it('stops scanning once it reaches the last settlement', async () => {
    // The anchor is an optimisation, not the correctness guarantee — that is the
    // epoch filter's job, since a request made before the last settle
    // necessarily carries an older epoch than the one now open. What the anchor
    // buys is not scanning history that cannot contain a relevant request, and
    // on Arc a log query is the budgeted resource. So the property worth pinning
    // is that it *stops*: found in the first window, it spends one round even
    // though the budget allows ten.
    const { client, calls } = stubArc({
      epoch: 4,
      lastSettledEpoch: 3,
      idle: 1_000_000n,
      pending: 500_000n,
      // Both inside the first 901..1000 window, and the request *after* the
      // settle — which is the only order in which it can belong to epoch 4.
      requested: [{ blockNumber: 980n, epoch: 4 }],
      settledAt: 950n,
      head: 1_000n,
    });
    const summary = await settleEpochsJob({
      arc: client, vault: VAULT, maxLogRange: 100, maxScanRequests: 10,
    });
    expect(summary).toMatch(/would settle epoch 4/);
    expect(calls()).toBe(1);
  });

  it('refuses when the budget ran out before it reached an anchor', async () => {
    // Capped and empty is indistinguishable from genuinely empty at the count,
    // and only one of them is safe to act on.
    const { client } = stubArc({
      epoch: 4,
      lastSettledEpoch: 3,
      idle: 1_000_000n,
      pending: 500_000n,
      requested: [],
      settledAt: null,
      head: 10_000n,
    });
    const summary = await settleEpochsJob({
      arc: client, vault: VAULT, maxLogRange: 100, maxScanRequests: 2,
    });
    expect(summary).toMatch(/no settle/);
    expect(summary).toMatch(/capped/);
  });

  it('treats reaching genesis as a real answer, not a capped one', async () => {
    // A vault that has never settled has no anchor, and block 0 is the honest
    // end of the search rather than a budget failure.
    const { client } = stubArc({
      epoch: 1,
      lastSettledEpoch: 0,
      idle: 1_000_000n,
      pending: 500_000n,
      requested: [{ blockNumber: 50n, epoch: 1 }],
      settledAt: null,
      head: 500n,
    });
    const summary = await settleEpochsJob({ arc: client, vault: VAULT, maxLogRange: 20_000 });
    expect(summary).toMatch(/would settle epoch 1/);
  });

  it('writes through the wallet when one is given', async () => {
    const { client } = stubArc({
      epoch: 4,
      lastSettledEpoch: 3,
      idle: 1_000_000n,
      pending: 500_000n,
      requested: [{ blockNumber: 900n, epoch: 4 }],
      settledAt: 800n,
    });
    const writeContract = vi.fn(async (_args: { functionName: string }) => '0xdeadbeef');
    const wallet = { writeContract, chain: null, account: { address: '0x1' } } as never;
    const summary = await settleEpochsJob({ arc: client, vault: VAULT, wallet });
    expect(writeContract).toHaveBeenCalledOnce();
    expect(writeContract.mock.calls[0]![0]).toMatchObject({ functionName: 'settleEpoch' });
    expect(summary).toMatch(/settled epoch 4/);
    expect(summary).toMatch(/0xdeadbeef/);
  });
});
