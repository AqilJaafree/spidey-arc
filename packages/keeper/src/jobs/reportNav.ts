/**
 * The NAV job: verify the hub's deployed capital, then attest to it.
 *
 * Extracted so the tick and `pnpm keeper:report-nav` run one implementation
 * rather than two copies of the wiring. Returns a summary instead of exiting,
 * because inside a tick a failure here must not stop the other jobs — `runJobs`
 * decides what a throw means.
 */

import type { Address, PublicClient, WalletClient } from 'viem';
import { deployedValue, shouldReport } from '../nav.js';
import { NAV_ABI, readRelayBalance, readVaultNav } from '../navSources.js';

export type ReportNavDeps = {
  arc: PublicClient;
  base: PublicClient;
  vault: Address;
  relay: Address;
  baseUsdc: Address;
  /** Omit to run read-only: it decides and reports, but never posts. */
  wallet?: WalletClient;
};

export async function reportNavJob(deps: ReportNavDeps): Promise<string> {
  const vaultNav = await readVaultNav(deps.arc, deps.vault);

  // The chain's clock, not the host's. `updatedAt` is a block timestamp, and
  // subtracting a wall clock from it makes the age wrong by however far the
  // two have drifted.
  const head = await deps.arc.getBlock();
  const nowSeconds = Number(head.timestamp);

  // Logged here so both entry points show the same detail. The return value is
  // the one-line summary; these are the inputs it came from, which is what you
  // want in a log when the summary surprises you.
  console.log(`  mark   ${vaultNav.deployedAssets} at ${vaultNav.updatedAt} (age ${nowSeconds - vaultNav.updatedAt}s)`);
  console.log(`  bounds cooldown ${vaultNav.bounds.navCooldownSeconds}s, stale at ${vaultNav.bounds.maxNavAgeSeconds}s, delta ${vaultNav.bounds.maxNavDeltaBps}bps`);

  // The relay is read unconditionally, including when the mark says zero.
  //
  // This used to return early on `deployedAssets === 0n`, which decided whether
  // to verify the mark by trusting the mark. Capital can reach the relay without
  // the vault's bookkeeping following it — a mint from a burn Arc never recorded,
  // a transfer straight to the address, a `recordVenueClosed` that zeroed the
  // mark while the money was still in flight — and every one of those reads as
  // "nothing deployed" while real assets sit unmarked. One extra balance read is
  // the price of the job doing what its name claims.
  const relayBalance = await readRelayBalance(deps.base, deps.baseUsdc, deps.relay);
  console.log(`  relay  ${relayBalance}  in-flight 0  computed ${relayBalance}`);
  // In-flight stays zero until it is wired to the sweep's scan. Bounded and
  // one-directional: a burn mid-flight makes `computed` low, so the decision
  // caps DOWNWARD — understating assets, which haircuts rather than overpays,
  // and logs `capped` when it happens.
  const computed = deployedValue({ relayBalance, inFlight: 0n });

  const decision = shouldReport({
    current: vaultNav.deployedAssets,
    computed,
    updatedAtSeconds: vaultNav.updatedAt,
    nowSeconds,
    bounds: vaultNav.bounds,
  });

  if (!decision.post) return `no post: ${decision.reason}`;
  if (!deps.wallet) {
    return `would post ${decision.amount} (${decision.reason})${decision.capped ? ', CAPPED' : ''} — read-only, no key`;
  }

  const hash = await deps.wallet.writeContract({
    address: deps.vault, abi: NAV_ABI, functionName: 'reportNav',
    args: [decision.amount], chain: deps.wallet.chain, account: deps.wallet.account!,
  });
  return `posted ${decision.amount} (${decision.reason})${decision.capped ? ', CAPPED' : ''} ${hash}`;
}
