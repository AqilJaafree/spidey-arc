#!/usr/bin/env node
/**
 * Refresh the Arc hub's NAV mark, or explain why it did not.
 *
 * One shot, idempotent, no state between runs. Intended for a ~1h schedule;
 * the mark goes stale at MAX_NAV_AGE and `claimWithdraw` reverts once it does.
 *
 *   ARC_RPC_URL=... BASE_RPC_URL=... REPORTER_KEY=0x... \
 *     pnpm keeper:report-nav
 *
 * Exits 0 when it posted or deliberately did nothing, and non-zero when a read
 * failed. A failed read must never become a posted number: a stale mark stalls
 * withdrawals and `reportNav` clears it, but paying out of a wrong mark is
 * realised at claim and gone permanently.
 *
 * The decision itself lives in `jobs/reportNav.ts`, shared with the tick. This
 * file is the clients and the key, nothing more. Without REPORTER_KEY it runs
 * read-only: it still reads and still decides, but writes nothing.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { reportNavJob } from '../jobs/reportNav.js';

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
  // `as PublicClient` is a type-level widening only. A chain carries its own
  // block formatter, so the client viem infers is a *narrower* type than the
  // generic `PublicClient` the job takes, and TypeScript will not unify the
  // two. The cast discards nothing at runtime — the only calls made on these
  // clients are `readContract` and `getBlock`, which every public client has.
  const arc = createPublicClient({ chain: arcTestnet, transport: http() }) as PublicClient;
  const base = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.BASE_RPC_URL),
  }) as PublicClient;

  const key = process.env.REPORTER_KEY as `0x${string}` | undefined;
  const wallet = key
    ? createWalletClient({ account: privateKeyToAccount(key), chain: arcTestnet, transport: http() })
    : undefined;
  if (!wallet) console.warn('REPORTER_KEY unset — read-only, nothing will be written.');

  console.log(
    await reportNavJob({
      arc,
      base,
      vault: ARC_VAULT,
      relay: BASE_RELAY,
      baseUsdc: BASE_USDC,
      wallet,
    }),
  );
}

main().catch((e) => {
  console.error(`\nFAILED — posting nothing. ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
