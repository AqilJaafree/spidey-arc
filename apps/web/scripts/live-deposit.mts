/**
 * A real deposit on Arc, driven through the vault page's own logic.
 *
 * `DepositCard` does three things in order: decide with `depositReadiness`,
 * simulate with `simulateContract`, then send. This runs the first two from
 * the page's actual modules — same predicate, same ABIs, same argument order —
 * and delegates only the signature to `cast`, so the keystore is never
 * decrypted into this process.
 *
 * What it therefore proves: that the calls the button builds are accepted by
 * the deployed contracts, and that the accounting moves the way the panel
 * says. What it cannot prove: the injected-wallet handshake, which needs a
 * browser and an extension.
 *
 *   cd apps/web
 *   AMOUNT=0.1 ../../node_modules/.bin/tsx scripts/live-deposit.mts
 *
 * Reads the keystore password from the repo `.env` and passes it to `cast`
 * through the environment, never on a command line.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, type Address } from 'viem';

import { ARC_TESTNET, CONTRACTS, USDC_ABI, VAULT_ABI } from '../lib/chain.js';
import { depositReadiness, formatShares, parseUsdc, refusalFromError, usdc } from '../lib/vault.js';

const RPC = 'https://rpc.testnet.arc.network';
const ACCOUNT = 'spidey-deployer';

const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
const password = env.match(/^PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!password) throw new Error('no PASSWORD in .env — cannot unlock the keystore');

/**
 * Foundry's `ETH_PASSWORD` names a *file*, not a value, and passing the
 * password on argv would expose it to `ps`. So it goes into a 0600 file that
 * is removed on exit — including on a crash, which is how it leaked the first
 * time this ran.
 */
const secretDir = mkdtempSync(join(tmpdir(), 'spidey-'));
const passwordFile = join(secretDir, 'pw');
writeFileSync(passwordFile, password, { mode: 0o600 });
chmodSync(passwordFile, 0o600);
const castEnv = { ...process.env, ETH_PASSWORD: passwordFile };
process.on('exit', () => rmSync(secretDir, { recursive: true, force: true }));

const client = createPublicClient({ chain: ARC_TESTNET, transport: http(RPC, { batch: true }) });
const vault = { address: CONTRACTS.vault, abi: VAULT_ABI } as const;
const token = { address: CONTRACTS.usdc, abi: USDC_ABI } as const;

const HOLDER = execFileSync(
  'cast',
  ['wallet', 'address', '--account', ACCOUNT],
  { env: castEnv, encoding: 'utf8' },
).trim() as Address;

const amount = parseUsdc(process.env.AMOUNT ?? '0.1');

async function state() {
  const [totalAssets, assets, shares, balance, allowance] = await client.multicall({
    allowFailure: false,
    contracts: [
      { ...vault, functionName: 'totalAssets' },
      { ...vault, functionName: 'assets' },
      { ...vault, functionName: 'balanceOf', args: [HOLDER] },
      { ...token, functionName: 'balanceOf', args: [HOLDER] },
      { ...token, functionName: 'allowance', args: [HOLDER, CONTRACTS.vault] },
    ],
  });
  return { totalAssets, idle: assets[0], pending: assets[1], shares, balance, allowance };
}

/** Sign and broadcast with cast; the key never leaves the keystore. */
function send(to: string, signature: string, args: string[]): string {
  const out = execFileSync(
    'cast',
    ['send', to, signature, ...args, '--rpc-url', RPC, '--account', ACCOUNT, '--json'],
    { env: castEnv, encoding: 'utf8' },
  );
  const receipt = JSON.parse(out);
  if (receipt.status !== '0x1') throw new Error(`reverted: ${receipt.transactionHash}`);
  return receipt.transactionHash;
}

const before = await state();
console.log('holder  ', HOLDER);
console.log('depositing', usdc(amount), '\n');
console.log('before  usdc', usdc(before.balance), '| shares', formatShares(before.shares));
console.log('        vault total', usdc(before.totalAssets), '| idle', usdc(before.idle));

// --- 1. the card's own predicate ------------------------------------------
const readiness = depositReadiness(
  {
    totalAssets: before.totalAssets, idle: before.idle, deployed: 0n, pending: before.pending,
    coverageBps: 10_000, epoch: 1, lastSettledEpoch: 0,
    depositCap: await client.readContract({ ...vault, functionName: 'caps' }).then((c) => c[0]),
    navUpdatedAt: 0n, maxNavAge: 0n,
  },
  {
    shares: before.shares, usdcBalance: before.balance, allowance: before.allowance,
    pendingAssets: 0n, pendingEpoch: 0,
  },
  amount,
);
if (!readiness.ok) throw new Error(`depositReadiness refused: ${readiness.reason?.detail}`);
console.log(`\ndepositReadiness: ok, needsApproval=${readiness.needsApproval}`);

// --- 2. approve, if the card would ----------------------------------------
if (readiness.needsApproval) {
  await client.simulateContract({
    ...token, functionName: 'approve', args: [CONTRACTS.vault, amount], account: HOLDER,
  });
  console.log('  approve simulated ->', send(CONTRACTS.usdc, 'approve(address,uint256)', [
    CONTRACTS.vault, amount.toString(),
  ]));
}

// --- 3. deposit ------------------------------------------------------------
let expectedShares: bigint;
try {
  const sim = await client.simulateContract({
    ...vault, functionName: 'deposit', args: [amount, HOLDER], account: HOLDER,
  });
  expectedShares = sim.result;
} catch (cause) {
  const refusal = refusalFromError(cause);
  throw new Error(`deposit simulation refused: ${refusal?.title ?? (cause as Error).message}`);
}
console.log('  deposit simulated -> expects', formatShares(expectedShares), 'shares');
console.log('  deposit sent      ->', send(CONTRACTS.vault, 'deposit(uint256,address)', [
  amount.toString(), HOLDER,
]));

// --- 4. did the panel's arithmetic hold? ----------------------------------
const after = await state();
console.log('\nafter   usdc', usdc(after.balance), '| shares', formatShares(after.shares));
console.log('        vault total', usdc(after.totalAssets), '| idle', usdc(after.idle));

const mintedShares = after.shares - before.shares;
const spent = before.balance - after.balance;

const checks: [string, boolean, string][] = [
  ['shares minted match the simulation', mintedShares === expectedShares,
    `${formatShares(mintedShares)} vs ${formatShares(expectedShares)}`],
  ['vault idle rose by the deposit', after.idle - before.idle === amount,
    usdc(after.idle - before.idle)],
  ['equity rose by the deposit', after.totalAssets - before.totalAssets === amount,
    usdc(after.totalAssets - before.totalAssets)],
  // Gas is USDC on Arc, so the wallet loses slightly more than it deposited.
  ['wallet paid the deposit plus gas', spent >= amount, usdc(spent)],
];

console.log('');
let failed = 0;
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) failed++;
}
console.log(`\ngas paid in USDC: ${usdc(spent - amount)}`);
process.exit(failed === 0 ? 0 : 1);
