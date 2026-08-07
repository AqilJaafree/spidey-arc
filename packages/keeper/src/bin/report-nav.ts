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
import { deployedValue, shouldReport } from '../nav.js';
import { NAV_ABI, readRelayBalance, readVaultNav } from '../navSources.js';

const ARC_VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as Address;
const BASE_RELAY = '0x280aD956FFFd3ABba3db59397BE7c4d4d04D32D4' as Address;
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network'] } },
});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main() {
  const arc = createPublicClient({ chain: arcTestnet, transport: http() });
  // `as PublicClient` is a type-level widening only. `baseSepolia` carries its
  // own block formatter, so the client viem infers is a *narrower* type than
  // the generic `PublicClient` that `navSources` takes, and TypeScript will not
  // unify the two. The cast discards nothing at runtime — the only call made on
  // this client is `readContract`, which every public client has.
  const base = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.BASE_RPC_URL),
  }) as PublicClient;

  const vault = await readVaultNav(arc, ARC_VAULT);

  // The chain's clock, not the host's. `updatedAt` is a block timestamp, and
  // subtracting a wall clock from it makes the age wrong by however far the
  // two have drifted. At the live bounds the slack between the report-at
  // margin and MAX_NAV_AGE is one hour, so a host lagging by more than that
  // would let the mark go stale while this command called it fresh.
  const head = await arc.getBlock();
  const nowSeconds = Number(head.timestamp);

  console.log(`mark      ${vault.deployedAssets} at ${vault.updatedAt} (age ${nowSeconds - vault.updatedAt}s)`);
  console.log(`bounds    cooldown ${vault.bounds.navCooldownSeconds}s, stale at ${vault.bounds.maxNavAgeSeconds}s, delta ${vault.bounds.maxNavDeltaBps}bps`);

  // Nothing deployed means nothing to verify and nothing the gate can block.
  // Decided before the Base read so a Base outage cannot fail a run that had
  // no work to do.
  if (vault.deployedAssets === 0n) {
    console.log('\nnothing deployed — the staleness gate does not apply. Done.');
    return;
  }

  const relayBalance = await readRelayBalance(base, BASE_USDC, BASE_RELAY);
  // Burn-log scanning is not built yet, so in-flight reads as zero. The
  // consequence is bounded and one-directional: a burn mid-flight makes
  // `computed` low, so the decision caps DOWNWARD and logs `capped` —
  // understating assets, which haircuts rather than overpays, and visibly.
  const inFlight = 0n;
  const computed = deployedValue({ relayBalance, inFlight });
  console.log(`relay     ${relayBalance}  in-flight ${inFlight}  computed ${computed}`);

  const decision = shouldReport({
    current: vault.deployedAssets,
    computed,
    updatedAtSeconds: vault.updatedAt,
    nowSeconds,
    bounds: vault.bounds,
  });

  if (!decision.post) {
    console.log(`\nno post: ${decision.reason}`);
    return;
  }

  if (decision.capped) {
    console.warn(
      `\nWARNING: true value ${computed} is more than ${vault.bounds.maxNavDeltaBps}bps from ${vault.deployedAssets}.`,
    );
    console.warn('Posting the largest step the contract accepts; the mark is knowingly wrong until it converges.');
  }

  const account = privateKeyToAccount(required('REPORTER_KEY') as `0x${string}`);
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const hash = await wallet.writeContract({
    address: ARC_VAULT,
    abi: NAV_ABI,
    functionName: 'reportNav',
    args: [decision.amount],
  });
  console.log(`\nposted ${decision.amount} (${decision.reason})  ${hash}`);
}

main().catch((e) => {
  console.error(`\nFAILED — posting nothing. ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
