/**
 * Wire the Solana devnet venue on Arc. Dry-run by default.
 *
 * Phase A proved the CCTP path Solana -> Arc (burn `5KQP427m…`, mint
 * `0xe7ab7e7d…`, 2026-08-09). It minted into an EOA on purpose, because
 * `activeVenueBitmap` is 4 — venue 2 on domain 6 is the only registered venue,
 * nothing has `chainDomain` 5, and so `recordBridgeArrival` has no venue to
 * attribute a Solana arrival to. This is the registration that closes that,
 * and it is the same gap that blocks Arc -> Solana, since `deployIdle` reverts
 * `NoExecutor` without an executor and a route.
 *
 * Three owner transactions, following `contracts/script/WireBaseVenue.s.sol`:
 *
 *   1. executor.setRoute(venue, 5, mintRecipient)   where the burn mints
 *   2. vault.registerVenue(venue, 5)                the venue exists, domain 5
 *   3. router.setExecutor(venue, executor)          how Arc reaches it
 *
 * Unlike the Base wiring this does **not** deploy a new `CctpBridgeExecutor`.
 * `setRoute` is keyed by `venueId`, so the executor already at
 * `0x9eE4C1FF…` can carry both routes. Reusing it keeps one contract owning
 * the outbound path for every venue rather than one per chain.
 *
 *   # dry run — simulates as the on-chain owner, needs no key
 *   cd packages/keeper && MINT_RECIPIENT=<base58-or-0x> \
 *     ../../node_modules/.bin/tsx scripts/wire-solana-venue.ts
 *
 *   # send
 *   BROADCAST=1 EVM_PRIVATE_KEY=0x… MINT_RECIPIENT=<…> ...
 *
 * ## MINT_RECIPIENT is required and deliberately has no default
 *
 * It decides where Arc's capital lands on Solana, which is the one choice here
 * that is not mechanical. The `MeteoraReceiver` vault token account
 * `4Rz7yD2bsaABvHkHyy1MnzDxxPJz1gqhUzESXVg5w4Wj` is the candidate: it is a live
 * SPL account for devnet USDC whose token owner is the *credit* PDA
 * `FBzc86DA…`, so tokens minted there are program-controlled and `deploy_position`
 * / `release_credit` are their only movers.
 *
 * Note the asymmetry with Base before choosing it. Base's route mints into
 * `CctpReturnRelay`, whose only exit is back to Arc with no owner discretion.
 * Solana has no equivalent: `release_credit` sends to an account the *vault
 * authority* owns, so the authority chooses where released capital goes. The
 * Solana venue is therefore a weaker custody story than the Base one, and that
 * is a property of the program, not of this script.
 *
 * `setRoute`'s docstring describes left-padding an EVM address into bytes32.
 * A Solana pubkey is already 32 bytes, so it is used whole — this is the first
 * non-EVM route, and the padding convention does not apply.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CCTP_DOMAINS } from '../src/relay.js';

const ARC_RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const ARC_VAULT = (process.env.ARC_VAULT ?? '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f') as Address;
const ARC_ROUTER = (process.env.ARC_ROUTER ?? '0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8') as Address;
const EXECUTOR = (process.env.EXECUTOR ?? '0x9eE4C1FFe609a4848053fD76071abBe69A63DB1c') as Address;

/** Venue 3: the next free id, and the one the planner's tests already assume. */
const VENUE = Number(process.env.VENUE ?? 3);
const DOMAIN = CCTP_DOMAINS['solana-devnet'];
const BROADCAST = process.env.BROADCAST === '1';

const VAULT_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'activeVenueBitmap', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'venues',
    stateMutability: 'view',
    inputs: [{ type: 'uint16' }],
    outputs: [
      { name: 'deployedAssets', type: 'uint128' },
      { name: 'lastRebalanceAt', type: 'uint64' },
      { name: 'scoreBps', type: 'uint32' },
      { name: 'venueId', type: 'uint16' },
      { name: 'chainDomain', type: 'uint8' },
      { name: 'flags', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'registerVenue',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'venueId', type: 'uint16' }, { name: 'chainDomain', type: 'uint8' }],
    outputs: [],
  },
] as const;

const ROUTER_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'executors', stateMutability: 'view', inputs: [{ type: 'uint16' }], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'setExecutor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'venueId', type: 'uint16' }, { name: 'executor', type: 'address' }],
    outputs: [],
  },
] as const;

const EXECUTOR_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'router', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'routes',
    stateMutability: 'view',
    inputs: [{ type: 'uint16' }],
    outputs: [{ name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'setRoute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'venueId', type: 'uint16' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

/** base58 -> 32 bytes, so a Solana pubkey can be given in its native form. */
function base58ToBytes32(s: string): Hex {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`not base58: ${JSON.stringify(ch)} in ${s}`);
    num = num * 58n + BigInt(i);
  }
  // Leading '1's are leading zero bytes and are lost by the numeric decode.
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch !== '1') break;
    leadingZeros += 1;
  }
  const body = num === 0n ? '' : num.toString(16);
  const hex = '00'.repeat(leadingZeros) + (body.length % 2 ? '0' + body : body);
  if (hex.length !== 64) {
    throw new Error(`${s} decodes to ${hex.length / 2} bytes, not 32 — is it a Solana pubkey?`);
  }
  return `0x${hex}`;
}

function parseMintRecipient(raw: string): Hex {
  if (raw.startsWith('0x')) {
    if (raw.length !== 66) throw new Error(`MINT_RECIPIENT hex must be 32 bytes, got ${(raw.length - 2) / 2}`);
    return raw as Hex;
  }
  return base58ToBytes32(raw);
}

const rawRecipient = process.env.MINT_RECIPIENT;
if (!rawRecipient) {
  throw new Error(
    'set MINT_RECIPIENT — the Solana account Arc mints into, base58 or 0x-prefixed bytes32.\n' +
      "It has no default on purpose: it decides where the hub's capital lands. The MeteoraReceiver\n" +
      'vault token account is 4Rz7yD2bsaABvHkHyy1MnzDxxPJz1gqhUzESXVg5w4Wj (token owner: the credit\n' +
      'PDA). Read this script\'s header on how that differs from the Base relay before choosing it.',
  );
}
const mintRecipient = parseMintRecipient(rawRecipient);

const arc = createPublicClient({ transport: http(ARC_RPC) });

console.log(`wire venue ${VENUE} -> CCTP domain ${DOMAIN} (solana-devnet)\n`);
console.log(`  vault     ${ARC_VAULT}`);
console.log(`  router    ${ARC_ROUTER}`);
console.log(`  executor  ${EXECUTOR}  (reused, not redeployed)`);
console.log(`  mints to  ${rawRecipient}`);
console.log(`            ${mintRecipient}\n`);

// ---- current state, and the preconditions each call depends on ----

const [vaultOwner, routerOwner, execOwner, execRouter, bitmap] = await Promise.all([
  arc.readContract({ address: ARC_VAULT, abi: VAULT_ABI, functionName: 'owner' }),
  arc.readContract({ address: ARC_ROUTER, abi: ROUTER_ABI, functionName: 'owner' }),
  arc.readContract({ address: EXECUTOR, abi: EXECUTOR_ABI, functionName: 'owner' }),
  arc.readContract({ address: EXECUTOR, abi: EXECUTOR_ABI, functionName: 'router' }),
  arc.readContract({ address: ARC_VAULT, abi: VAULT_ABI, functionName: 'activeVenueBitmap' }),
]);

const [, , , , chainDomain, flags] = await arc.readContract({
  address: ARC_VAULT,
  abi: VAULT_ABI,
  functionName: 'venues',
  args: [VENUE],
});
const [routeDomain, routeRecipient] = await arc.readContract({
  address: EXECUTOR,
  abi: EXECUTOR_ABI,
  functionName: 'routes',
  args: [VENUE],
});
const currentExecutor = await arc.readContract({
  address: ARC_ROUTER,
  abi: ROUTER_ABI,
  functionName: 'executors',
  args: [VENUE],
});

console.log('current state');
console.log(`  activeVenueBitmap        ${bitmap} (0b${bitmap.toString(2)})`);
console.log(`  venues[${VENUE}].flags         ${flags}  domain ${chainDomain}`);
console.log(`  executor.routes[${VENUE}]      domain ${routeDomain}  recipient ${routeRecipient}`);
console.log(`  router.executors[${VENUE}]     ${currentExecutor}`);
console.log(`  owners  vault ${vaultOwner}  router ${routerOwner}  executor ${execOwner}`);

const problems: string[] = [];
if (flags !== 0) problems.push(`venues[${VENUE}].flags is ${flags}, not 0 — registerVenue reverts VenueAlreadyRegistered`);
if (execRouter.toLowerCase() !== ARC_ROUTER.toLowerCase()) {
  problems.push(`executor.router is ${execRouter}, not ${ARC_ROUTER} — deployIdle would reach the wrong router`);
}
if (vaultOwner.toLowerCase() !== routerOwner.toLowerCase() || vaultOwner.toLowerCase() !== execOwner.toLowerCase()) {
  problems.push('vault, router and executor do not share one owner — the three calls need different signers');
}
if (problems.length > 0) {
  console.log('\nproblems');
  for (const p of problems) console.log(`  - ${p}`);
  console.log();
  process.exit(1);
}

// ---- the three calls ----

const calls = [
  {
    what: `executor.setRoute(${VENUE}, ${DOMAIN}, ${rawRecipient})`,
    address: EXECUTOR,
    abi: EXECUTOR_ABI,
    functionName: 'setRoute' as const,
    args: [VENUE, DOMAIN, mintRecipient] as const,
  },
  {
    what: `vault.registerVenue(${VENUE}, ${DOMAIN})`,
    address: ARC_VAULT,
    abi: VAULT_ABI,
    functionName: 'registerVenue' as const,
    args: [VENUE, DOMAIN] as const,
  },
  {
    what: `router.setExecutor(${VENUE}, ${EXECUTOR})`,
    address: ARC_ROUTER,
    abi: ROUTER_ABI,
    functionName: 'setExecutor' as const,
    args: [VENUE, EXECUTOR] as const,
  },
];

// Simulated as the on-chain owner, so a dry run needs no key at all. The route
// is set before the venue exists deliberately: `registerVenue` flips the venue
// active, and a venue that is active with no route is briefly reachable by
// `deployIdle`.
const owner = vaultOwner as Address;
console.log(`\ndry run — simulating as owner ${owner}\n`);
for (const c of calls) {
  try {
    await arc.simulateContract({
      address: c.address,
      abi: c.abi as never,
      functionName: c.functionName as never,
      args: c.args as never,
      account: owner,
    });
    console.log(`  ok      ${c.what}`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`  REVERT  ${c.what}\n          ${message}`);
    process.exit(1);
  }
}

if (!BROADCAST) {
  console.log('\nAll three simulate cleanly. Nothing was sent.');
  console.log('Re-run with BROADCAST=1 and EVM_PRIVATE_KEY to apply.\n');
  process.exit(0);
}

// ---- broadcast ----

const key = process.env.EVM_PRIVATE_KEY;
if (!key) throw new Error('BROADCAST=1 needs EVM_PRIVATE_KEY');
const account = privateKeyToAccount(key as Hex);
if (!isAddress(account.address) || account.address.toLowerCase() !== owner.toLowerCase()) {
  throw new Error(
    `EVM_PRIVATE_KEY is ${account.address} but the owner is ${owner} — these calls are onlyOwner and would revert`,
  );
}

const wallet = createWalletClient({ account, transport: http(ARC_RPC) });
const chainId = await arc.getChainId();

console.log(`\nbroadcasting as ${account.address} on chain ${chainId}\n`);
for (const c of calls) {
  const hash = await wallet.writeContract({
    address: c.address,
    abi: c.abi as never,
    functionName: c.functionName as never,
    args: c.args as never,
    chain: null,
  });
  const receipt = await arc.waitForTransactionReceipt({ hash });
  console.log(`  ${receipt.status.padEnd(8)} ${c.what}\n           ${hash}`);
  if (receipt.status !== 'success') {
    throw new Error(`${c.what} reverted — stopping before the remaining calls`);
  }
}

const after = await arc.readContract({ address: ARC_VAULT, abi: VAULT_ABI, functionName: 'activeVenueBitmap' });
console.log(`\nactiveVenueBitmap now ${after} (0b${after.toString(2)})`);
console.log('Re-run preflight-solana-return.ts — PHASE B should now report runnable.\n');
