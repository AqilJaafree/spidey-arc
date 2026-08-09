/**
 * Readiness check for the Solana -> Arc return leg. Read-only, no keys.
 *
 * §5 of `docs/cross-chain-review.md` says the Solana half of the relayer is
 * "checked offline against a deterministic keypair" and that no live Arc<->Solana
 * bridge has ever been run. This script answers the question that has to come
 * before running one: is there anything to recover, and is there anywhere for it
 * to land?
 *
 * It signs nothing and asks for no key. Run it before
 * `run-solana-return.ts` and again afterwards to see what moved.
 *
 *   cd packages/keeper && ../../node_modules/.bin/tsx scripts/preflight-solana-return.ts
 *
 * Override `SOLANA_RPC_URL`, `ARC_RPC_URL` or `VAULT_AUTHORITY` if the devnet
 * state has moved on.
 */

import { createPublicClient, http, erc20Abi } from 'viem';
import { CCTP_DOMAINS } from '../src/relay.js';

const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const ARC_RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';

/**
 * The Solana account the keeper burns from.
 *
 * `release_credit` moves tokens to an account the *vault authority* owns, and
 * App Kit burns from the signer's own ATA — so this address and
 * `SOLANA_PRIVATE_KEY` must be the same key. They are easy to get wrong:
 * the upgrade authority, the vault authority and the Solana CLI default are
 * three different keys, and naming the wrong one fails confusingly.
 */
const VAULT_AUTHORITY = process.env.VAULT_AUTHORITY ?? 'AM9tkemP6YR5ReLR88E3s8wVUpQ17zpXNWpuMbDtwtGb';

/** Devnet USDC, the mint CCTP burns on domain 5. */
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const ARC_VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f' as const;
/** The ERC-20 view over Arc's native USDC — 6 decimals, unlike native's 18. */
const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000' as const;

const VAULT_ABI = [
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
    name: 'activeVenueBitmap',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'unaccountedBalance',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`${method}: no result`);
  return body.result;
}

const usd = (base: bigint): string => `${(Number(base) / 1e6).toFixed(6)} USDC`;

async function main(): Promise<void> {
  const blockers: string[] = [];
  const notes: string[] = [];

  console.log('Solana -> Arc return leg, readiness\n');
  console.log(`  solana rpc      ${SOLANA_RPC}`);
  console.log(`  arc rpc         ${ARC_RPC}`);
  console.log(`  vault authority ${VAULT_AUTHORITY}\n`);

  // ---- Solana: is there anything to recover, and can it pay for the burn? ----

  const lamports = await solanaRpc<{ value: number }>('getBalance', [VAULT_AUTHORITY]);
  const sol = lamports.value / 1e9;
  console.log('Solana devnet');
  console.log(`  SOL for fees        ${sol.toFixed(6)}`);
  // A burn is one transaction; anything above dust is plenty. Flagged rather
  // than assumed because a zero balance fails at signing, not before.
  if (sol < 0.01) blockers.push(`vault authority has ${sol} SOL — not enough to sign a burn`);

  const tokens = await solanaRpc<{
    value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }>;
  }>('getTokenAccountsByOwner', [
    VAULT_AUTHORITY,
    { mint: USDC_MINT_DEVNET },
    { encoding: 'jsonParsed' },
  ]);

  const burnable = tokens.value.reduce(
    (sum, t) => sum + BigInt(t.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
  console.log(`  USDC burnable       ${usd(burnable)}   (mint ${USDC_MINT_DEVNET.slice(0, 8)}…)`);
  if (burnable === 0n) {
    blockers.push(
      'vault authority holds no devnet USDC — run solana/scripts/withdraw-dlmm.ts then release-dlmm.ts, ' +
        'or credit-usdc.ts to hand-fund a test',
    );
  }

  // ---- Arc: is there a venue this capital can be booked against? ----

  const arc = createPublicClient({ transport: http(ARC_RPC) });

  const bitmap = await arc.readContract({
    address: ARC_VAULT,
    abi: VAULT_ABI,
    functionName: 'activeVenueBitmap',
  });

  console.log('\nArc testnet');
  console.log(`  activeVenueBitmap   ${bitmap} (0b${bitmap.toString(2)})`);

  const solanaDomain = CCTP_DOMAINS['solana-devnet'];
  let solanaVenueId: number | null = null;

  for (let id = 0; id < 256; id += 1) {
    if (((bitmap >> BigInt(id)) & 1n) === 0n) continue;
    const [deployed, , score, , chainDomain] = await arc.readContract({
      address: ARC_VAULT,
      abi: VAULT_ABI,
      functionName: 'venues',
      args: [id],
    });
    const which = chainDomain === solanaDomain ? '  <- Solana (domain 5)' : '';
    console.log(
      `  venue ${id}  domain ${chainDomain}  deployed ${usd(deployed)}  score ${score}bps${which}`,
    );
    if (chainDomain === solanaDomain) solanaVenueId = id;
  }

  if (solanaVenueId === null) {
    blockers.push(
      `no registered venue has chainDomain ${solanaDomain} — the mint can be proven, but ` +
        'Router.recordBridgeArrival has nothing to book it against. Registering one is an owner action.',
    );
  }

  const unaccounted = await arc.readContract({
    address: ARC_VAULT,
    abi: VAULT_ABI,
    functionName: 'unaccountedBalance',
  });
  const vaultUsdc = await arc.readContract({
    address: ARC_USDC_ERC20,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ARC_VAULT],
  });
  console.log(`  vault USDC          ${usd(vaultUsdc)}`);
  console.log(`  unaccountedBalance  ${usd(unaccounted)}`);
  if (unaccounted > 0n) {
    notes.push(
      `vault already holds ${usd(unaccounted)} unaccounted — a later recordBridgeArrival books ` +
        'the balance, not your transfer, so this would be folded in with whatever you send',
    );
  }

  // ---- Verdict ----

  console.log('\n---');
  const canBurn = burnable > 0n && sol >= 0.01;
  console.log(
    canBurn
      ? `PHASE A (prove the leg)  runnable — bridge up to ${usd(burnable)} to an EOA on Arc`
      : 'PHASE A (prove the leg)  BLOCKED',
  );
  console.log(
    solanaVenueId === null
      ? 'PHASE B (book it)        BLOCKED — no domain-5 venue registered'
      : `PHASE B (book it)        runnable against venue ${solanaVenueId}`,
  );

  if (notes.length > 0) {
    console.log('\nnotes');
    for (const n of notes) console.log(`  - ${n}`);
  }
  if (blockers.length > 0) {
    console.log('\nblockers');
    for (const b of blockers) console.log(`  - ${b}`);
  }
  console.log();
  if (!canBurn) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
