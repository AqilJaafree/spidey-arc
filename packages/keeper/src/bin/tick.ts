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
 * Exits non-zero if any job failed, having attempted them all. With
 * KEEPER_READ_ONLY=1 and no key it runs read-only: every read happens and
 * every decision is reported, nothing is written. A missing key without that
 * flag refuses to start — see `keys.ts` for why silence has to be asked for.
 *
 * The bridge sweep is not registered here yet. Proving the tick itself against
 * the live chain first means a failure in that run has one possible cause.
 */

import { createPublicClient, createWalletClient, defineChain, http, type Address, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { reportNavJob } from '../jobs/reportNav.js';
import { runJobs, tickExitCode, type Job } from '../tick.js';
import { reporterMode } from './keys.js';

const ARC_VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as Address;
const BASE_RELAY = '0x280aD956FFFd3ABba3db59397BE7c4d4d04D32D4' as Address;
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

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

  const arc = createPublicClient({ chain: arcTestnet, transport: http() }) as PublicClient;
  const base = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_RPC_URL) }) as PublicClient;

  const wallet = mode.readOnly
    ? undefined
    : createWalletClient({ account: privateKeyToAccount(mode.key), chain: arcTestnet, transport: http() });

  const jobs: Job[] = [
    {
      name: 'report-nav',
      run: () => reportNavJob({ arc, base, vault: ARC_VAULT, relay: BASE_RELAY, baseUsdc: BASE_USDC, wallet }),
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
