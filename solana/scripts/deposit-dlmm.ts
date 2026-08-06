/**
 * Step 3 — one-sided USDC into a live Meteora DLMM position, through the
 * receiver's CPIs.
 *
 *   1. ensure the bin array(s) for the range exist (permissionless, keeper)
 *   2. init_position  -> program CPIs initialize_position, owner = credit PDA
 *   3. deploy_position -> program CPIs add_liquidity_by_strategy_one_side
 *
 *   ANCHOR_WALLET=<payer.json> ../node_modules/.bin/tsx scripts/deposit-dlmm.ts
 */

import * as anchor from '@coral-xyz/anchor';
import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY,
  TransactionInstruction, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token';
import { readFileSync } from 'node:fs';

const DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const POOL = new PublicKey('XZgB99jbwsZyCZF7h5tLGPgXYGdZ9bX8UqLQV3upwZw');
const RESERVE_Y = new PublicKey('AeMGVbaQzWx4JcxCB8DkLZMsKznuAAdeWsAqduUqtKKH'); // USDC reserve
const INIT_BIN_ARRAY_DISC = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]);

const CREDIT_SEED = Buffer.from('credit');
const VAULT_SEED = Buffer.from('vault');
const AMOUNT = new anchor.BN(process.env.AMOUNT ?? '300000'); // 0.3 USDC

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const payer = (provider.wallet as anchor.Wallet).payer as Keypair;
const conn = provider.connection;

const idl = JSON.parse(readFileSync('target/idl/meteora_receiver.json', 'utf8'));
const program = new anchor.Program(idl, provider);
const vaultAuthority = payer.publicKey;

const [credit] = PublicKey.findProgramAddressSync(
  [CREDIT_SEED, vaultAuthority.toBuffer(), POOL.toBuffer()], program.programId);
const [vault] = PublicKey.findProgramAddressSync(
  [VAULT_SEED, vaultAuthority.toBuffer(), POOL.toBuffer()], program.programId);
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

async function ensureBinArray(index: number) {
  const addr = deriveBinArray(index);
  const info = await conn.getAccountInfo(addr);
  if (info) { console.log(`  bin array ${index} exists  ${addr.toBase58()}`); return addr; }
  const data = Buffer.concat([INIT_BIN_ARRAY_DISC, i64le(index)]);
  const ix = new TransactionInstruction({
    programId: DLMM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: false },
      { pubkey: addr, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
  console.log(`  bin array ${index} created  ${addr.toBase58()}  ${sig}`);
  return addr;
}

async function main() {
  // Read the pool's live active bin so the range and the tolerance check hold.
  const poolInfo = await conn.getAccountInfo(POOL);
  const activeId = poolInfo!.data.readInt32LE(76);

  // One-sided USDC (token_y) = bids strictly below active. The range must span
  // TWO distinct bin arrays: DLMM borrows bin_array_lower and bin_array_upper
  // mutably, so passing one account for both double-borrows. Anchor range so
  // idx(minBin) < idx(maxBin).
  const maxBin = activeId - 1;
  let minBin = activeId - 20;
  let lowerIdx = binArrayIndex(minBin);
  const upperIdx = binArrayIndex(maxBin);
  if (lowerIdx === upperIdx) {
    // active sits far from a 70-bin boundary; push minBin into the array below.
    lowerIdx = upperIdx - 1;
    minBin = lowerIdx * 70 + 69; // top bin of the lower array
  }
  const width = maxBin - minBin + 1;
  console.log(`pool active_id ${activeId}  range [${minBin}, ${maxBin}]  width ${width}`);
  console.log(`arrays lower=${lowerIdx} upper=${upperIdx}`);
  console.log(`credit ${credit.toBase58()}  vault ${vault.toBase58()}\n`);

  console.log('1) bin arrays');
  const binArrayLower = await ensureBinArray(lowerIdx);
  const binArrayUpper = await ensureBinArray(upperIdx);

  console.log('2) init_position (owner = credit PDA)');
  const position = Keypair.generate();
  const sig1 = await program.methods
    .initPosition(minBin, width)
    .accounts({
      payer: payer.publicKey,
      credit,
      position: position.publicKey,
      lbPair: POOL,
      eventAuthority,
      dlmmProgram: DLMM,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([position])
    .rpc();
  console.log(`   position ${position.publicKey.toBase58()}  ${sig1}`);

  console.log('3) deploy_position (one-sided USDC add)');
  const sig2 = await program.methods
    .deployPosition({
      amount: AMOUNT,
      targetBinId: activeId,
      activeBinId: activeId,
      minAmountOut: new anchor.BN(1),
      minBinId: minBin,
      maxBinId: maxBin,
      maxActiveBinSlippage: 5,
      strategyType: 0, // SpotOneSide
    })
    .accounts({
      caller: payer.publicKey,
      credit,
      vaultTokenAccount: vault,
      position: position.publicKey,
      lbPair: POOL,
      binArrayBitmapExtension: null,
      reserve: RESERVE_Y,
      tokenMint: USDC_MINT,
      binArrayLower,
      binArrayUpper,
      eventAuthority,
      dlmmProgram: DLMM,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .rpc();
  console.log(`   ${sig2}`);

  const acct: any = await (program.account as any).credit.fetch(credit);
  const v = await getAccount(conn, vault);
  console.log('\n--- result ---');
  console.log('credit.deployed', acct.deployed.toString(), '(was 0)');
  console.log('vault remaining', v.amount.toString(), 'USDC base units');
  console.log('position       ', position.publicKey.toBase58());
}

main().catch((e) => { console.error(e); process.exit(1); });
