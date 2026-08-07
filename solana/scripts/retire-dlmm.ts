/**
 * Retire the DLMM positions a credit owns, reclaiming their rent.
 *
 * Finds every position owned by the credit PDA — including ones the credit
 * never adopted, which the books cannot see — and closes each. Closing the
 * *recorded* position also clears `credit.position`, which is what frees the
 * credit to open a fresh range later.
 *
 *   ANCHOR_WALLET=<payer.json> ../node_modules/.bin/tsx scripts/retire-dlmm.ts
 *
 * A position that still holds liquidity is refused by DLMM (NonEmptyPosition),
 * as is one this PDA does not own (InvalidPositionOwner). Withdraw first.
 */

import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

const DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const POOL = new PublicKey('XZgB99jbwsZyCZF7h5tLGPgXYGdZ9bX8UqLQV3upwZw');
const CREDIT_SEED = Buffer.from('credit');

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const payer = (provider.wallet as anchor.Wallet).payer as Keypair;
const conn = provider.connection;

const idl = JSON.parse(readFileSync('target/idl/meteora_receiver.json', 'utf8'));
const program = new anchor.Program(idl, provider);
const vaultAuthority = payer.publicKey;

const [credit] = PublicKey.findProgramAddressSync(
  [CREDIT_SEED, vaultAuthority.toBuffer(), POOL.toBuffer()], program.programId);
const [eventAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')], DLMM);

function i64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}
function binArrayIndex(binId: number): number {
  return Math.floor(binId / 70);
}
function deriveBinArray(index: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bin_array'), POOL.toBuffer(), i64le(index)], DLMM)[0];
}

/** PositionV2: disc 8, lb_pair 32, owner 32; lower/upper bin id at 7912/7916. */
function u128(d: Buffer, o: number): bigint {
  return d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << BigInt(64));
}

async function main() {
  const acct: any = await (program.account as any).credit.fetch(credit);
  console.log('credit  ', credit.toBase58());
  console.log('recorded', acct.position.toBase58(),
    acct.position.equals(PublicKey.default) ? '(none)' : `[${acct.positionLowerBinId}, width ${acct.positionWidth}]`);
  console.log('deployed', acct.deployed.toString());

  const owned = await conn.getProgramAccounts(DLMM, {
    filters: [{ memcmp: { offset: 40, bytes: credit.toBase58() } }],
  });
  console.log(`\n${owned.length} position(s) owned by this credit\n`);

  const before = await conn.getBalance(vaultAuthority);
  let closed = 0;

  for (const { pubkey, account } of owned) {
    const d = account.data;
    const lo = d.readInt32LE(7912);
    const hi = d.readInt32LE(7916);
    let liquidity = BigInt(0);
    for (let i = 0; i < 70; i++) liquidity += u128(d, 72 + i * 16);

    const loIdx = binArrayIndex(lo);
    const hiIdx = binArrayIndex(hi);
    const isRecorded = pubkey.equals(acct.position);

    console.log(`${pubkey.toBase58()}${isRecorded ? '  (recorded)' : '  (never adopted)'}`);
    console.log(`  bins [${lo}, ${hi}]  arrays ${loIdx}/${hiIdx}${loIdx === hiIdx ? '  SAME ARRAY' : ''}`);
    console.log(`  liquidity ${liquidity}`);

    if (liquidity > BigInt(0)) {
      console.log('  SKIP — still holds liquidity; withdraw_position first\n');
      continue;
    }

    try {
      const sig = await program.methods
        .retirePosition()
        .accounts({
          vaultAuthority,
          credit,
          position: pubkey,
          lbPair: POOL,
          binArrayLower: deriveBinArray(loIdx),
          binArrayUpper: deriveBinArray(hiIdx),
          rentReceiver: vaultAuthority,
          eventAuthority,
          dlmmProgram: DLMM,
        })
        .rpc();
      console.log(`  closed  ${sig}\n`);
      closed++;
    } catch (err: any) {
      // Reported, not swallowed: a position that cannot be closed is rent
      // stranded forever, and that is worth saying out loud.
      const logs = (err.logs || []).filter((l: string) => l.includes('Error') || l.includes('failed'));
      console.log(`  FAILED  ${String(err).split('\n')[0]}`);
      for (const l of logs.slice(0, 4)) console.log(`          ${l}`);
      console.log();
    }
  }

  const after = await conn.getBalance(vaultAuthority);
  const final: any = await (program.account as any).credit.fetch(credit);
  console.log('--- result ---');
  console.log(`closed ${closed} of ${owned.length}`);
  console.log(`rent recovered ${(after - before) / 1e9} SOL (net of fees)`);
  console.log('credit.position now', final.position.toBase58(),
    final.position.equals(PublicKey.default) ? '(cleared — a fresh range can be opened)' : '');
}

main().catch((e) => { console.error(e); process.exit(1); });
