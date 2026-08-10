/**
 * One-off runner: the Solana -> Arc return leg through App Kit.
 *
 * This is the leg §5 of `docs/cross-chain-review.md` records as never having
 * been run. The wiring exists — `BridgeChain.Solana_Devnet`, domain 5,
 * `createSolanaAdapterFromPrivateKey`, `adapterFor()` — and is checked offline
 * against a deterministic keypair. Nothing has ever burned on Solana and minted
 * on Arc.
 *
 * Run `preflight-solana-return.ts` first. It signs nothing and tells you whether
 * there is anything to recover and anywhere for it to land.
 *
 *   cd packages/keeper && \
 *     EVM_PRIVATE_KEY=$(cast wallet dk spidey-deployer --unsafe-password "$PW") \
 *     SOLANA_PRIVATE_KEY="$(cat "$(solana config get keypair | awk '{print $NF}')")" \
 *     AMOUNT=0.4 ../../node_modules/.bin/tsx scripts/run-solana-return.ts
 *
 * Both keys are read from the environment and never logged. They are different
 * keys doing different jobs: the Solana key signs the burn (and must own the
 * USDC), the EVM key submits the mint on Arc.
 *
 * ## Do not reach for `~/.config/solana/id.json`
 *
 * An earlier version of this comment said to, and it was wrong. That path is not
 * the configured keypair and, here, not the vault authority: it holds
 * `8sHRx1C6…` while the USDC sits under `AM9tkemP…`, whose keypair the CLI is
 * pointed at from somewhere else entirely. Burning with it would sign as an
 * account with nothing to burn.
 *
 * Hence reading the path out of `solana config get` above rather than hardcoding
 * one — the configured keypair is the thing that moves, and a path copied into a
 * comment goes stale silently. Confirm before running: `solana address` must
 * print the same account `preflight-solana-return.ts` reports as holding the
 * burnable USDC. The upgrade authority, the vault authority and the CLI default
 * are three different keys, and naming the wrong one fails confusingly.
 *
 * ## Why this defaults to an EOA and not the vault
 *
 * Capital returns as a CCTP *mint*, so no executor calls back and the Router has
 * to be told with `recordBridgeArrival(venueId, amount)`. That needs a
 * registered venue whose `chainDomain` is 5 — and there isn't one
 * (`activeVenueBitmap` is 4: venue 2, domain 6, Base only). USDC minted into the
 * vault with no venue to book it against is unaccounted balance the Router
 * cannot attribute, so this sends to the keeper's own Arc address by default:
 * the CCTP path gets proven without touching vault accounting. Set
 * `RECIPIENT` explicitly once a domain-5 venue exists, and `BOOK=1` to book it.
 */

import { execFileSync } from 'node:child_process';
import { createPublicClient, http, erc20Abi, type Address } from 'viem';
import { createKeeperWallet, bridgeUsdc, bridgeAndBook } from '../src/index.js';
import { CCTP_DOMAINS } from '../src/relay.js';

const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
if (!evmPrivateKey) throw new Error('set EVM_PRIVATE_KEY (0x-prefixed) — submits the mint on Arc');

const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
if (!solanaPrivateKey) {
  throw new Error(
    'set SOLANA_PRIVATE_KEY (JSON byte array, base58 or base64) — signs the burn on Solana, ' +
      'and must be the account holding the USDC. Read the path from `solana config get keypair`; ' +
      'it is not ~/.config/solana/id.json here. ' +
      'An EVM key cannot sign on Solana, and this refuses rather than falling back to the wrong signer.',
  );
}

const AMOUNT = process.env.AMOUNT ?? '0.4';
const ARC_RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const ARC_VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as const;
const ARC_ROUTER = '0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8' as const;
const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000' as const;

const VAULT_ABI = [
  { type: 'function', name: 'activeVenueBitmap', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'unaccountedBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
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
] as const;

const arc = createPublicClient({ transport: http(ARC_RPC) });
const usd = (base: bigint): string => `${(Number(base) / 1e6).toFixed(6)} USDC`;

/** The registered venue on domain 5, or null when none exists. */
async function solanaVenueId(): Promise<number | null> {
  const bitmap = await arc.readContract({
    address: ARC_VAULT,
    abi: VAULT_ABI,
    functionName: 'activeVenueBitmap',
  });
  for (let id = 0; id < 256; id += 1) {
    if (((bitmap >> BigInt(id)) & 1n) === 0n) continue;
    const [, , , , chainDomain] = await arc.readContract({
      address: ARC_VAULT,
      abi: VAULT_ABI,
      functionName: 'venues',
      args: [id],
    });
    if (chainDomain === CCTP_DOMAINS['solana-devnet']) return id;
  }
  return null;
}

const wallet = createKeeperWallet({ evmPrivateKey, solanaPrivateKey });

const from = 'solana-devnet' as const;
const to = 'arc-testnet' as const;
const solanaAddress = await wallet.getAddress(from);
const keeperArcAddress = await wallet.getAddress(to);

const venueId = await solanaVenueId();
const recipient = process.env.RECIPIENT ?? keeperArcAddress;
const book = process.env.BOOK === '1';

// The two refusals that keep an unprovable leg from becoming an unaccountable
// balance. Both are about the same missing venue.
if (recipient.toLowerCase() === ARC_VAULT.toLowerCase() && venueId === null) {
  throw new Error(
    `refusing to mint into the vault ${ARC_VAULT}: no registered venue has chainDomain ` +
      `${CCTP_DOMAINS['solana-devnet']}, so recordBridgeArrival has nothing to book it against and the ` +
      'mint would land as unattributable unaccounted balance. Register a Solana venue first, or leave ' +
      'RECIPIENT unset to prove the CCTP path against an EOA.',
  );
}
if (book && venueId === null) {
  throw new Error(
    'BOOK=1 needs a registered venue on domain 5; none exists. Run without BOOK to prove the burn and mint.',
  );
}

console.log(`return ${AMOUNT} USDC   solana-devnet -> arc-testnet\n`);
console.log(`  burn from   ${solanaAddress} (Solana)`);
console.log(`  mint to     ${recipient}${recipient === keeperArcAddress ? ' (keeper EOA — accounting untouched)' : ''}`);
console.log(`  solana venue on Arc: ${venueId === null ? 'NONE REGISTERED' : `venue ${venueId}`}`);
console.log(`  book arrival: ${book ? `yes, venue ${venueId}` : 'no'}\n`);

const before = await arc.readContract({
  address: ARC_USDC_ERC20,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [recipient as Address],
});
console.log(`recipient balance before: ${usd(before)}\n`);

const cast = (args: string[]): string => execFileSync('cast', args, { encoding: 'utf8' }).trim();

/**
 * Books the vault's ACTUAL unaccounted balance, not the requested amount: a FAST
 * transfer takes its fee on the destination, so the mint lands slightly under
 * what was asked, and `recordBridgeArrival` is bounded by what genuinely arrived.
 */
const bookArrival = async (venue: number): Promise<void> => {
  const unaccounted = await arc.readContract({
    address: ARC_VAULT,
    abi: VAULT_ABI,
    functionName: 'unaccountedBalance',
  });
  if (unaccounted === 0n) throw new Error('nothing arrived to book');
  console.log(`\nbooking ${usd(unaccounted)} against venue ${venue} (vault unaccountedBalance)`);
  const out = cast([
    'send', ARC_ROUTER,
    // `finalize` writes off whatever the venue's book still claims after this
    // booking. Opt-in via FINALIZE=true, and only when the Solana position is
    // actually closed — on a partial return it would write off capital still
    // deployed. Left false, a residual keeps `coverageBps` at 10000 and stalls
    // the withdrawal queue, so this is a choice to make, not to default.
    'recordBridgeArrival(uint16,uint256,bool)',
    String(venue), String(unaccounted), String(process.env.FINALIZE === 'true'),
    '--rpc-url', ARC_RPC, '--private-key', evmPrivateKey, '--json',
  ]);
  console.log('  recordBridgeArrival tx:', JSON.parse(out).transactionHash);
};

const request = { from, to, amount: AMOUNT, recipient };

const outcome =
  book && venueId !== null
    ? await bridgeAndBook(wallet, { ...request, venueId }, async (venue) => bookArrival(venue))
    : await bridgeUsdc(wallet, request);

console.log('\nstate:', outcome.state);
for (const s of outcome.steps) {
  console.log(`  ${s.state.padEnd(8)} ${s.name}${s.txHash ? '  ' + s.txHash : ''}`);
}
console.log('\nsource burn tx (Solana):', outcome.sourceTxHash ?? '(none)');
console.log('dest   mint tx (Arc):   ', outcome.destinationTxHash ?? '(none)');

const after = await arc.readContract({
  address: ARC_USDC_ERC20,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [recipient as Address],
});
console.log(`\nrecipient balance after:  ${usd(after)}   (delta ${usd(after - before)})`);
if (after === before && outcome.state === 'success') {
  console.log('  WARNING: reported success but the balance did not move — check the mint tx.');
}

if (outcome.state !== 'success') process.exitCode = 1;
