/**
 * One-off runner: post a score root, then deploy idle capital to a venue.
 *
 * This is the path that has never run on-chain. `venues[2].scoreBps` is 5000, so
 * `recordDeploy` executed once for Base — but `nav.deployedAssets` is still the
 * constructor's 0, `reportNav` has never posted, and no venue has ever held
 * capital while the vault was marked as holding it. Solana's venue 3 was
 * registered minutes ago and has never been deployed to at all.
 *
 *   cd packages/keeper && EVM_PRIVATE_KEY=0x… VENUE=3 AMOUNT=0.5 \
 *     ../../node_modules/.bin/tsx scripts/run-deploy-idle.ts
 *
 * ## Why a root has to be posted first
 *
 * `Router.deployIdle` refuses on two independent score checks: `scoreAge()` above
 * `MAX_SCORE_AGE` (7200s), and `verifyScore` against the current root. The live
 * oracle root is ~3.9 days old, so a deploy today reverts `ScoresStale` before it
 * reverts anything else. Posting is `onlyReporter` on the oracle and is a
 * separate transaction from the deploy.
 *
 * ## The order matters
 *
 * The proof is verified **on-chain** before `deployIdle` is called, not merely
 * built locally. `BadProof` inside `deployIdle` would revert the whole thing
 * harmlessly, but the check costs one `eth_call` and turns a mid-deploy revert
 * into a legible refusal — the same reason `plan.ts` verifies locally before
 * emitting a rebalance.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildScoreTree, leafHash, verifyProof, type ScoreLeaf } from '../src/merkle.js';

const key = process.env.EVM_PRIVATE_KEY;
if (!key) throw new Error('set EVM_PRIVATE_KEY — reporter on the oracle and keeper on the Router');

const VENUE = Number(process.env.VENUE ?? 3);
const AMOUNT = BigInt(Math.round(Number(process.env.AMOUNT ?? '0.5') * 1e6));
const SCORE_BPS = Number(process.env.SCORE_BPS ?? 5000);
const NET_APY_BPS = Number(process.env.NET_APY_BPS ?? 1200);
/** Fast transfer. Standard (2000) is cheaper and slower; the payback rule prices the wait. */
const FINALITY = Number(process.env.FINALITY ?? 1000);

const ARC_RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as Address;
const ROUTER = '0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8' as Address;
const ORACLE = '0xb7DB9Ee5Ee46EB608d9a3A4DCc843230dD63b621' as Address;

const ORACLE_ABI = parseAbi([
  'function postScores(bytes32 newRoot, uint64 asOf, string leavesUri) returns (uint64)',
  'function verifyScore(uint16 venueId, uint32 scoreBps, uint32 netApyBps, bytes32[] proof) view returns (bool)',
  'function scoreAge() view returns (uint256)',
  'function root() view returns (bytes32)',
]);
const ROUTER_ABI = parseAbi([
  'function deployIdle(uint16 venueId, uint256 amount, uint32 netApyBps, uint32 scoreBps, bytes32[] proof, bytes enterData)',
  'function MAX_SCORE_AGE() view returns (uint256)',
]);
const VAULT_ABI = parseAbi([
  'function idleAssets() view returns (uint256)',
  'function nav() view returns (uint128 deployedAssets, uint64 updatedAt, uint16 epoch)',
  'function venues(uint16) view returns (uint128 deployedAssets, uint64 lastRebalanceAt, uint32 scoreBps, uint16 venueId, uint8 chainDomain, uint8 flags)',
  'function isVenuePending(uint16) view returns (bool)',
]);

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
});

const account = privateKeyToAccount(key as Hex);
const arc = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) });
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(ARC_RPC) });

const usd = (n: bigint) => `${(Number(n) / 1e6).toFixed(6)} USDC`;

const before = {
  idle: await arc.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'idleAssets' }),
  nav: await arc.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'nav' }),
  venue: await arc.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'venues', args: [VENUE] }),
};

console.log(`deploy ${usd(AMOUNT)} to venue ${VENUE}, as ${account.address}\n`);
console.log(`  vault idle        ${usd(before.idle)}`);
console.log(`  nav.deployed      ${usd(before.nav[0])}  (updatedAt ${before.nav[1]})`);
console.log(`  venue deployed    ${usd(before.venue[0])}  scoreBps ${before.venue[2]}  domain ${before.venue[4]}`);
if (before.idle < AMOUNT) throw new Error(`vault holds ${usd(before.idle)}, cannot deploy ${usd(AMOUNT)}`);

// ---- 1. post a root the deploy can prove against ----

const head = await arc.getBlock();
const asOf = Number(head.timestamp);

// Both live venues, so the tree is what the ranker would actually publish rather
// than a single-leaf special case. §2.2 of the review: one list feeds the tree
// and the choice, or they diverge.
const leaves: ScoreLeaf[] = [
  { venueId: 2, scoreBps: 5000, netApyBps: 900, asOf },
  { venueId: VENUE, scoreBps: SCORE_BPS, netApyBps: NET_APY_BPS, asOf },
];
const tree = buildScoreTree(leaves);
const leaf = leaves.find((l) => l.venueId === VENUE)!;
const proof = tree.proofForVenue(VENUE);
if (proof === null) throw new Error(`venue ${VENUE} missing from the tree`);

if (!verifyProof(proof, tree.root, leafHash(leaf))) {
  throw new Error('proof does not verify against its own root — refusing to post');
}
console.log(`\n  root ${tree.root}  asOf ${asOf}  (${leaves.length} leaves, local proof ok)`);

const postHash = await wallet.writeContract({
  address: ORACLE, abi: ORACLE_ABI, functionName: 'postScores',
  args: [tree.root, BigInt(asOf), 'inline: run-deploy-idle.ts'], chain: null,
});
const postRcpt = await arc.waitForTransactionReceipt({ hash: postHash });
console.log(`  postScores        ${postRcpt.status}  ${postHash}`);
if (postRcpt.status !== 'success') throw new Error('postScores reverted');

// ---- 2. make the chain confirm the proof before spending anything ----

const ok = await arc.readContract({
  address: ORACLE, abi: ORACLE_ABI, functionName: 'verifyScore',
  args: [VENUE, SCORE_BPS, NET_APY_BPS, proof],
});
const age = await arc.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: 'scoreAge' });
const maxAge = await arc.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'MAX_SCORE_AGE' });
console.log(`  verifyScore       ${ok}   scoreAge ${age}s of ${maxAge}s`);
if (!ok) throw new Error('the chain rejected the proof — not deploying');

// ---- 3. deploy ----

// maxFee must be strictly below the amount, or the whole transfer could be eaten
// by fees and still count as a deployment. Four legs measured ~0.95% on the
// source, so this is generous headroom rather than a real expectation.
const maxFee = AMOUNT / 25n;
const enterData = encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'uint32' }],
  [maxFee, FINALITY],
);
console.log(`  enterData         maxFee ${usd(maxFee)}, finality ${FINALITY}`);

const hash = await wallet.writeContract({
  address: ROUTER, abi: ROUTER_ABI, functionName: 'deployIdle',
  args: [VENUE, AMOUNT, NET_APY_BPS, SCORE_BPS, proof, enterData], chain: null,
});
const rcpt = await arc.waitForTransactionReceipt({ hash });
console.log(`\n  deployIdle        ${rcpt.status}  ${hash}`);
if (rcpt.status !== 'success') throw new Error('deployIdle reverted');

// ---- 4. what moved ----

const after = {
  idle: await arc.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'idleAssets' }),
  nav: await arc.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'nav' }),
  venue: await arc.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'venues', args: [VENUE] }),
  pending: await arc.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'isVenuePending', args: [VENUE] }),
};
console.log(`\n  vault idle        ${usd(before.idle)} -> ${usd(after.idle)}`);
console.log(`  nav.deployed      ${usd(before.nav[0])} -> ${usd(after.nav[0])}`);
console.log(`  venue deployed    ${usd(before.venue[0])} -> ${usd(after.venue[0])}  scoreBps ${after.venue[2]}`);
console.log(`  venue pending     ${after.pending}  (a bridge in flight is not a position)`);
