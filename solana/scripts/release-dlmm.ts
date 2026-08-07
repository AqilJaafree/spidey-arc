/**
 * The last hop on-chain: move the recovered USDC out of program custody and
 * into the vault authority's own account, where the keeper's App Kit relayer
 * burns it back to Arc — the same hop the Base Sepolia venue uses.
 *
 *   ANCHOR_WALLET=<payer.json> ../node_modules/.bin/tsx scripts/release-dlmm.ts
 */

import * as anchor from '@coral-xyz/anchor';
import { PublicKey, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAccount, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { readFileSync } from 'node:fs';

const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const POOL = new PublicKey('XZgB99jbwsZyCZF7h5tLGPgXYGdZ9bX8UqLQV3upwZw');
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

async function main() {
  const acct: any = await (program.account as any).credit.fetch(credit);
  const held = await getAccount(conn, vault);
  console.log('credit.amount  ', acct.amount.toString());
  console.log('credit.deployed', acct.deployed.toString());
  console.log('vault balance  ', held.amount.toString());

  const amount = new anchor.BN(held.amount.toString());
  if (amount.isZero()) throw new Error('nothing in custody to release');

  const recipient = await getOrCreateAssociatedTokenAccount(conn, payer, USDC_MINT, vaultAuthority);

  const sig = await program.methods
    .releaseCredit(amount)
    .accounts({
      vaultAuthority,
      credit,
      vaultTokenAccount: vault,
      recipient: recipient.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`\nreleased ${amount.toString()} to ${recipient.address.toBase58()}  ${sig}`);

  const after: any = await (program.account as any).credit.fetch(credit);
  const vaultAfter = await getAccount(conn, vault);
  console.log('vault balance  ', vaultAfter.amount.toString(), '(must be 0)');
  console.log('credit.amount  ', after.amount.toString(), '(must be 0)');
  if (vaultAfter.amount !== BigInt(0)) throw new Error('capital still stranded in the program');
  if (!after.amount.isZero()) throw new Error('books still claim capital that has left');
  console.log('\nOK — under the vault authority, ready for the App Kit burn home.');
}

main().catch((e) => { console.error(e); process.exit(1); });
