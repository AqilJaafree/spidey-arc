/**
 * Step 2 — credit CCTP-bridged USDC into the receiver, on devnet.
 *
 * The 0.5 USDC that came Arc -> Solana sits in the keeper's own ATA. This moves
 * it into the program-owned vault and books it, exercising the deployed
 * program (FLfdxZbnk…) end to end without a pool:
 *
 *   init_credit  -> the (vaultAuthority, pool) credit PDA, cctp_authority pinned
 *   init_vault   -> the program-owned USDC account (authority = credit PDA)
 *   transfer     -> move USDC from the keeper ATA into that vault account
 *   on_cctp_receive -> book credit.amount (payer stands in for MessageTransmitter)
 *
 *   ANCHOR_WALLET=<payer.json> ../../node_modules/.bin/tsx scripts/credit-usdc.ts
 */

import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, transfer, getAccount } from '@solana/spl-token';
import { readFileSync } from 'node:fs';

const CREDIT_SEED = Buffer.from('credit');
const VAULT_SEED = Buffer.from('vault');

const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const POOL = new PublicKey('XZgB99jbwsZyCZF7h5tLGPgXYGdZ9bX8UqLQV3upwZw'); // token_y = USDC, active
const AMOUNT = new anchor.BN(process.env.AMOUNT ?? '400000'); // 0.4 USDC, 6dp

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const payer = (provider.wallet as anchor.Wallet).payer as Keypair;

const idl = JSON.parse(readFileSync('target/idl/meteora_receiver.json', 'utf8'));
const program = new anchor.Program(idl, provider);

// vaultAuthority = payer, so release_credit (which needs it to sign) is possible
// later. pool is the real DLMM LbPair, so step 3 can use the same credit.
const vaultAuthority = payer.publicKey;

const [credit] = PublicKey.findProgramAddressSync(
  [CREDIT_SEED, vaultAuthority.toBuffer(), POOL.toBuffer()],
  program.programId,
);
const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
  [VAULT_SEED, vaultAuthority.toBuffer(), POOL.toBuffer()],
  program.programId,
);
const holderAta = getAssociatedTokenAddressSync(USDC_MINT, payer.publicKey);

async function step(name: string, fn: () => Promise<string>) {
  try {
    const sig = await fn();
    console.log(`  ok   ${name}  ${sig}`);
  } catch (e: any) {
    // init_* are idempotent-ish: an "already in use" on a rerun is fine.
    const msg = String(e?.message ?? e);
    if (/already in use|custom program error: 0x0/i.test(msg)) {
      console.log(`  skip ${name}  (already exists)`);
    } else {
      throw e;
    }
  }
}

async function main() {
  console.log('program        ', program.programId.toBase58());
  console.log('vaultAuthority ', vaultAuthority.toBase58());
  console.log('pool           ', POOL.toBase58());
  console.log('credit PDA     ', credit.toBase58());
  console.log('vault (PDA)    ', vaultTokenAccount.toBase58());
  console.log('amount         ', AMOUNT.toString(), 'base units\n');

  await step('init_credit', () =>
  program.methods
    // destination is a now-unused pinned field; the keeper ATA satisfies it.
    // payer stands in for the CCTP MessageTransmitter as cctp_authority.
    .initCredit(vaultAuthority, POOL, holderAta, payer.publicKey)
      .accounts({ payer: payer.publicKey, credit, systemProgram: SystemProgram.programId })
      .rpc(),
  );

  await step('init_vault', () =>
    program.methods
      .initVault(vaultAuthority, POOL)
      .accounts({
        payer: payer.publicKey,
        credit,
        vaultTokenAccount,
        mint: USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc(),
  );

  await step('transfer USDC -> vault', () =>
    transfer(provider.connection, payer, holderAta, vaultTokenAccount, payer, BigInt(AMOUNT.toString())),
  );

  await step('on_cctp_receive (credit)', () =>
    program.methods
      .onCctpReceive({
        vaultAuthority,
        pool: POOL,
        amount: AMOUNT,
        binTolerance: 50,
        nonce: new anchor.BN(1),
      })
      .accounts({ authority: payer.publicKey, credit })
      .rpc(),
  );

  const acct: any = await (program.account as any).credit.fetch(credit);
  const vault = await getAccount(provider.connection, vaultTokenAccount);
  console.log('\n--- result ---');
  console.log('credit.amount  ', acct.amount.toString(), '(booked)');
  console.log('credit.deployed', acct.deployed.toString());
  console.log('credit.pool    ', acct.pool.toBase58());
  console.log('vault holds    ', vault.amount.toString(), 'USDC base units');
  console.log(
    acct.amount.toString() === vault.amount.toString()
      ? '\nOK: booked credit == tokens actually held.'
      : '\nMISMATCH: credit != custody.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
