#!/usr/bin/env node
/**
 * One pass of the keeper's work.
 *
 * Stateless: every run rediscovers what needs doing. Intended for a ~15 minute
 * schedule — well inside NAV_COOLDOWN (1h) so a lost tick costs nothing, and
 * far inside MAX_NAV_AGE (6h) so many consecutive failures are survivable.
 *
 *   ARC_RPC_URL=... BASE_RPC_URL=... REPORTER_KEY=0x... pnpm keeper:tick
 *
 * Two jobs. `report-nav` keeps the hub's mark fresh; `sweep-bridges` finishes
 * CCTP transfers nobody finished and tells the vault the money is home. The
 * sweep is second because a NAV mark that goes stale stalls withdrawals on a
 * clock, while an unminted burn waits indefinitely and loses nothing by waiting
 * one more job.
 *
 * Exits non-zero if any job failed, having attempted them all. With
 * KEEPER_READ_ONLY=1 and no key it runs read-only: every read happens and
 * every decision is reported, nothing is written. A missing key without that
 * flag refuses to start — see `keys.ts` for why silence has to be asked for.
 */

import { createPublicClient, createWalletClient, defineChain, http, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { reportNavJob } from '../jobs/reportNav.js';
import { sweepBridgesJob } from '../jobs/sweepBridges.js';
import { runJobs, tickExitCode, type Job } from '../tick.js';
import { reporterMode } from './keys.js';

const ARC_VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as Address;
const ARC_ROUTER = '0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8' as Address;
const ARC_EXECUTOR = '0x9eE4C1FFe609a4848053fD76071abBe69A63DB1c' as Address;
const BASE_RELAY = '0x280aD956FFFd3ABba3db59397BE7c4d4d04D32D4' as Address;
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

/**
 * CCTP v2's `TokenMessengerV2`, the same address on both chains.
 *
 * Established by reading it off the two contracts that actually burn rather
 * than copied from a docs table: `CctpBridgeExecutor.tokenMessenger()` on Arc
 * and `CctpReturnRelay.tokenMessenger()` on Base both return this. It therefore
 * cannot drift from the messenger whose `DepositForBurn` logs this job scans.
 * The transmitter is not configured at all — `messageTransmitterOf` reads it
 * off the messenger, for the reason recorded in `messages.ts`.
 */
const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address;

/**
 * Blocks per `eth_getLogs` each endpoint will serve, measured against the
 * defaults rather than guessed: Arc answers a 20 000-block span and refuses
 * 30 000 with `requested range too large`; Base Sepolia's public RPC caps at
 * `max block range 2000`. Override when pointing at an endpoint that allows
 * more — a wider range is the same window in fewer calls.
 */
const ARC_LOG_RANGE = Number(process.env.ARC_MAX_LOG_RANGE ?? 20_000);
const BASE_LOG_RANGE = Number(process.env.BASE_MAX_LOG_RANGE ?? 2_000);

/**
 * How many of those calls a sweep may spend per chain, and therefore how far
 * back it actually reaches. Both numbers are measured against the public
 * endpoints, not chosen:
 *
 *   Arc   429s after ~15 back-to-back 20 000-block queries, even paced a second
 *         apart. 12 is inside that with room for the NAV job's reads.
 *   Base  served 60 back-to-back 2 000-block queries in 38s without complaint.
 *
 * That buys ~1.4 days of history on Arc and ~2.8 on Base — the sweep asks for
 * seven and logs `CAPPED` every run until an endpoint can give it. On Arc the
 * fix is a paid RPC with a wider `getLogs` range rather than a bigger budget
 * here: 20 000 blocks a call is already its ceiling, so more history can only
 * come from more calls, and more calls is exactly what the limiter refuses.
 */
const ARC_SCAN_REQUESTS = Number(process.env.ARC_SCAN_REQUESTS ?? 12);
const BASE_SCAN_REQUESTS = Number(process.env.BASE_SCAN_REQUESTS ?? 60);

/**
 * Wait out a rate limiter rather than failing the tick over one.
 *
 * Arc's limiter is a bucket, not a wall: a burst of log queries drains it, and
 * a few seconds later it serves again. viem already retries `-32005` — its
 * default is three tries about a second apart in total, which is shorter than
 * the bucket takes to refill, so a sweep that hit the limit failed the whole
 * job. Five tries backing off exponentially from 1.5s spans ~46s, which is
 * nothing to a background sweep and everything to whether it completes.
 *
 * A retry is only correct because every read here is idempotent. Nothing on
 * this transport writes; `receiveMessage` and `recordBridgeArrival` go out over
 * the wallet clients, where a retried submission would be a second transaction,
 * not a second look.
 */
const PATIENT = { retryCount: 5, retryDelay: 1_500 } as const;

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'] } },
});

async function main() {
  // First, before a single RPC call: a run that cannot write should cost
  // nothing and fail immediately, not after two chains have been read.
  const mode = reporterMode();
  if (mode.readOnly) console.warn('KEEPER_READ_ONLY — reading and deciding, writing nothing.');

  const arc = createPublicClient({
    chain: arcTestnet, transport: http(undefined, PATIENT),
  }) as PublicClient;
  const base = createPublicClient({
    chain: baseSepolia, transport: http(process.env.BASE_RPC_URL, PATIENT),
  }) as PublicClient;

  // One key, two chains. The sweep mints on whichever chain a message was
  // bound for, so a wallet that only speaks Arc would leave every Arc → Base
  // leg unfinishable while reporting success on the return legs.
  const account = mode.readOnly ? undefined : privateKeyToAccount(mode.key);
  const wallet = account && createWalletClient({ account, chain: arcTestnet, transport: http() });
  const baseWallet =
    account && createWalletClient({ account, chain: baseSepolia, transport: http(process.env.BASE_RPC_URL) });

  const jobs: Job[] = [
    {
      name: 'report-nav',
      run: () => reportNavJob({ arc, base, vault: ARC_VAULT, relay: BASE_RELAY, baseUsdc: BASE_USDC, wallet }),
    },
    {
      name: 'sweep-bridges',
      run: () =>
        sweepBridgesJob({
          chains: {
            'arc-testnet': {
              client: arc, tokenMessenger: TOKEN_MESSENGER, depositor: ARC_EXECUTOR,
              wallet, maxLogRange: ARC_LOG_RANGE, maxScanRequests: ARC_SCAN_REQUESTS,
            },
            'base-sepolia': {
              client: base, tokenMessenger: TOKEN_MESSENGER, depositor: BASE_RELAY,
              wallet: baseWallet, maxLogRange: BASE_LOG_RANGE, maxScanRequests: BASE_SCAN_REQUESTS,
            },
          },
          vault: ARC_VAULT,
          router: ARC_ROUTER,
        }),
    },
  ];

  const results = await runJobs(jobs);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.detail}`);
  process.exit(tickExitCode(results));
}

main().catch((e) => {
  // Only reached if the wiring itself failed — a job's own failure is caught
  // by runJobs and reported above.
  console.error(`tick could not start: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
