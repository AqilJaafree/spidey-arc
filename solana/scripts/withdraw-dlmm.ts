/**
 * The exit — pull the live devnet position back into custody.
 *
 *   1. adopt_position     (once, migrating the credit that predates the fields)
 *   2. withdraw_position   -> claim_fee + remove_liquidity_by_range @ 10,000 bps
 *
 *   ANCHOR_WALLET=<payer.json> ../node_modules/.bin/tsx scripts/withdraw-dlmm.ts
 *
 * Set POSITION, LOWER_BIN and WIDTH from the deposit-dlmm.ts run that opened
 * the position. They are only needed on the first run: after adoption the
 * credit knows its own position, and withdraw_position takes no arguments.
 */

import * as anchor from '@coral-xyz/anchor';
import {
  PublicKey, Keypair, SystemProgram, ComputeBudgetProgram,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAccount, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { readFileSync } from 'node:fs';

const DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const POOL = new PublicKey('XZgB99jbwsZyCZF7h5tLGPgXYGdZ9bX8UqLQV3upwZw');
const RESERVE_Y = new PublicKey('AeMGVbaQzWx4JcxCB8DkLZMsKznuAAdeWsAqduUqtKKH'); // USDC reserve

const CREDIT_SEED = Buffer.from('credit');
const VAULT_SEED = Buffer.from('vault');

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

/**
 * LbPair header offsets. `active_id` at 76 is already proven by
 * deposit-dlmm.ts, which pins the rest of the header: bin_step u16 at 80,
 * status/seed/activation/padding through 87, then four pubkeys back to back.
 * reserve_y is asserted against the known constant so a layout drift is caught
 * loudly rather than silently reading garbage.
 */
function readPool(data: Buffer) {
  return {
    activeId: data.readInt32LE(76),
    tokenXMint: new PublicKey(data.subarray(88, 120)),
    tokenYMint: new PublicKey(data.subarray(120, 152)),
    reserveX: new PublicKey(data.subarray(152, 184)),
    reserveY: new PublicKey(data.subarray(184, 216)),
  };
}

async function main() {
  const poolInfo = await conn.getAccountInfo(POOL);
  const p = readPool(poolInfo!.data);
  console.log('pool active_id  ', p.activeId);
  console.log('token_x_mint    ', p.tokenXMint.toBase58());
  console.log('token_y_mint    ', p.tokenYMint.toBase58());
  console.log('reserve_x       ', p.reserveX.toBase58());
  console.log('reserve_y       ', p.reserveY.toBase58());
  if (!p.reserveY.equals(RESERVE_Y)) {
    throw new Error(`LbPair layout drift: reserve_y read as ${p.reserveY.toBase58()}, expected ${RESERVE_Y.toBase58()}`);
  }

  // The whole point of adopt_position is an account that predates the three
  // position fields — and such an account cannot be decoded by the typed
  // fetch, which expects the wider layout and reads off the end. So the
  // pre-migration read is raw. Anything at the old size has not been adopted;
  // that is the only fact needed to decide.
  const raw = await conn.getAccountInfo(credit);
  if (!raw) throw new Error(`credit ${credit.toBase58()} does not exist`);
  const OLD_LEN = 163;
  console.log(`\ncredit ${credit.toBase58()} — ${raw.data.length} bytes` +
    (raw.data.length === OLD_LEN ? ' (pre-migration)' : ''));

  let acct: any = raw.data.length === OLD_LEN
    ? { position: PublicKey.default }
    : await (program.account as any).credit.fetch(credit);

  if (acct.position.equals(PublicKey.default)) {
    const position = new PublicKey(process.env.POSITION!);
    const lower = Number(process.env.LOWER_BIN!);
    const width = Number(process.env.WIDTH!);
    console.log(`\n1) adopt_position ${position.toBase58()} [${lower}, ${lower + width - 1}]`);
    const sig = await program.methods
      .adoptPosition(position, lower, width)
      .accounts({
        vaultAuthority,
        payer: payer.publicKey,
        credit,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`   ${sig}`);
    acct = await (program.account as any).credit.fetch(credit);

    // adopt_position writes these three fields at hand-computed offsets,
    // because the account it migrates cannot be deserialized by the typed
    // form. Read them back and check: a wrong offset is unrecoverable, since
    // PositionAlreadyAdopted refuses a second attempt.
    if (!acct.position.equals(position)) {
      throw new Error(`adopt wrote position ${acct.position.toBase58()}, expected ${position.toBase58()}`);
    }
    if (acct.positionLowerBinId !== lower || acct.positionWidth !== width) {
      throw new Error(
        `adopt wrote [${acct.positionLowerBinId}, width ${acct.positionWidth}], expected [${lower}, width ${width}]`,
      );
    }
    console.log('   read-back OK — position, lower bin and width all match');
  } else {
    console.log(`\n1) already adopted: ${acct.position.toBase58()}`);
  }

  const lower = acct.positionLowerBinId;
  const upper = lower + acct.positionWidth - 1;
  const binArrayLower = deriveBinArray(binArrayIndex(lower));
  const binArrayUpper = deriveBinArray(binArrayIndex(upper));
  console.log(`   range [${lower}, ${upper}]  arrays ${binArrayIndex(lower)}/${binArrayIndex(upper)}`);

  // Where the non-USDC side lands. Owned by the vault authority, per the
  // instruction's constraint; never enters program custody.
  const custodyMint = (await getAccount(conn, vault)).mint;
  const custodyIsY = p.tokenYMint.equals(custodyMint);
  const otherMint = custodyIsY ? p.tokenXMint : p.tokenYMint;
  const other = await getOrCreateAssociatedTokenAccount(conn, payer, otherMint, vaultAuthority);
  console.log(`   custody is token_${custodyIsY ? 'y' : 'x'}; other side -> ${other.address.toBase58()}`);

  const vaultBefore = await getAccount(conn, vault);
  const otherBefore = await getAccount(conn, other.address);

  console.log('\n2) withdraw_position (claim_fee + remove 10,000 bps)');
  const sig = await program.methods
    .withdrawPosition()
    .accounts({
      vaultAuthority,
      credit,
      vaultTokenAccount: vault,
      otherRecipient: other.address,
      position: acct.position,
      lbPair: POOL,
      binArrayBitmapExtension: null,
      reserveX: p.reserveX,
      reserveY: p.reserveY,
      tokenXMint: p.tokenXMint,
      tokenYMint: p.tokenYMint,
      binArrayLower,
      binArrayUpper,
      eventAuthority,
      dlmmProgram: DLMM,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })])
    .rpc();
  console.log(`   ${sig}`);

  const vaultAfter = await getAccount(conn, vault);
  const otherAfter = await getAccount(conn, other.address);
  const final: any = await (program.account as any).credit.fetch(credit);

  console.log('\n--- result ---');
  console.log('vault USDC   ', vaultBefore.amount.toString(), '->', vaultAfter.amount.toString());
  console.log('other side   ', otherBefore.amount.toString(), '->', otherAfter.amount.toString());
  console.log('credit.amount', final.amount.toString(), '(re-marked from the measured balance)');
  console.log('credit.deployed', final.deployed.toString(), '(must be 0)');

  if (final.deployed.toNumber() !== 0) throw new Error('deployed did not reach zero');
  if (final.amount.toString() !== vaultAfter.amount.toString()) {
    throw new Error('credit.amount does not match the measured vault balance');
  }
  if (vaultAfter.amount <= vaultBefore.amount) {
    throw new Error('no USDC came back from the position');
  }
  console.log('\nOK — the position is unwound and the books match custody.');
}

main().catch((e) => { console.error(e); process.exit(1); });
