/**
 * Real token custody — the half that was missing.
 *
 * Until this existed the receiver was pure bookkeeping: it tracked `amount`
 * and `deployed` and never held or moved a single token. A CCTP mint into its
 * vault would have sat there untouched while the counters climbed. Accounting
 * that cannot be settled is worse than no accounting at all.
 *
 * These run against live devnet with a real SPL mint, a real program-owned
 * token account, and a real transfer signed by the `credit` PDA.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from '@solana/spl-token';
import { assert } from 'chai';

const CREDIT_SEED = Buffer.from('credit');
const VAULT_SEED = Buffer.from('vault');
const USDC = (n: number) => new anchor.BN(Math.round(n * 1e6));

describe('token custody', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.MeteoraReceiver as Program;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // A fresh (vaultAuthority, pool) pair per run so devnet state never collides.
  const vaultAuthority = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;

  let mint: PublicKey;
  let credit: PublicKey;
  let vaultTokenAccount: PublicKey;
  let destination: PublicKey;

  before(async () => {
    [credit] = PublicKey.findProgramAddressSync(
      [CREDIT_SEED, vaultAuthority.toBuffer(), pool.toBuffer()],
      program.programId,
    );
    [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, vaultAuthority.toBuffer(), pool.toBuffer()],
      program.programId,
    );

    // Stand-in for CCTP-minted USDC: 6 decimals, same as the real thing.
    mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    destination = await createAccount(provider.connection, payer, mint, payer.publicKey);
  });

  it('sets up credit and a program-owned vault account', async () => {
    await program.methods
      // `payer` stands in for the CCTP `MessageTransmitter` PDA here.
      .initCredit(vaultAuthority, pool, destination, payer.publicKey)
      .accounts({ payer: payer.publicKey, credit, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .initVault(vaultAuthority, pool)
      .accounts({
        payer: payer.publicKey,
        credit,
        vaultTokenAccount,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vault = await getAccount(provider.connection, vaultTokenAccount);
    assert.equal(vault.amount.toString(), '0', 'vault starts empty');
    assert.ok(vault.owner.equals(credit), 'only the credit PDA can move these funds');
  });

  it('stage 2 moves real tokens, not just counters', async () => {
    // CCTP mints $1,000 into the program-owned account...
    await mintTo(provider.connection, payer, mint, vaultTokenAccount, payer, 1_000e6);

    // ...and stage 1 credits it.
    await program.methods
      .onCctpReceive({
        vaultAuthority,
        pool,
        amount: USDC(1_000),
        binTolerance: 5,
        nonce: new anchor.BN(1),
      })
      .accounts({ authority: payer.publicKey, credit })
      .rpc();

    const vaultBefore = await getAccount(provider.connection, vaultTokenAccount);
    const destBefore = await getAccount(provider.connection, destination);

    await program.methods
      .deployPosition({
        amount: USDC(400),
        targetBinId: 100,
        activeBinId: 102,
        minAmountOut: USDC(399),
      })
      .accounts({
        caller: payer.publicKey,
        credit,
        vaultTokenAccount,
        destination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultAfter = await getAccount(provider.connection, vaultTokenAccount);
    const destAfter = await getAccount(provider.connection, destination);

    assert.equal(
      Number(vaultBefore.amount - vaultAfter.amount),
      400e6,
      'tokens actually left the vault',
    );
    assert.equal(
      Number(destAfter.amount - destBefore.amount),
      400e6,
      'and actually arrived at the destination',
    );

    const acct = await (program.account as any).credit.fetch(credit);
    assert.equal(acct.deployed.toNumber(), 400e6, 'books agree with the token movement');
    assert.equal(acct.amount.toNumber(), 1_000e6, 'credit itself unchanged');
  });

  /// A permissionless instruction that could name its own destination would
  /// be a drain, not a deploy. The destination is pinned at init.
  it('a caller cannot redirect the funds', async () => {
    const attacker = await createAccount(
      provider.connection,
      payer,
      mint,
      Keypair.generate().publicKey,
    );

    try {
      await program.methods
        .deployPosition({
          amount: USDC(100),
          targetBinId: 100,
          activeBinId: 100,
          minAmountOut: USDC(99),
        })
        .accounts({
          caller: payer.publicKey,
          credit,
          vaultTokenAccount,
          destination: attacker,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail('funds were redirected to an attacker-chosen account');
    } catch (e: any) {
      assert.match(e.toString(), /ConstraintAddress|AnchorError/, 'must fail the address pin');
    }

    const attackerAcct = await getAccount(provider.connection, attacker);
    assert.equal(attackerAcct.amount.toString(), '0', 'attacker received nothing');
  });

  it('cannot deploy more than the vault actually holds', async () => {
    // Books say $600 remains, and so does the token account. Ask for more.
    try {
      await program.methods
        .deployPosition({
          amount: USDC(5_000),
          targetBinId: 100,
          activeBinId: 100,
          minAmountOut: USDC(1),
        })
        .accounts({
          caller: payer.publicKey,
          credit,
          vaultTokenAccount,
          destination,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail('should have been refused');
    } catch (e: any) {
      assert.include(e.toString(), 'AmountExceedsCredit');
    }
  });

  /// The invariant that keeps the receiver honest: tracked `deployed` can
  /// never exceed what has actually left the vault.
  it('books never claim more was deployed than left the vault', async () => {
    const acct = await (program.account as any).credit.fetch(credit);
    const vault = await getAccount(provider.connection, vaultTokenAccount);

    const stillHeld = Number(vault.amount);
    const claimedOut = acct.deployed.toNumber();
    const credited = acct.amount.toNumber();

    assert.equal(credited - claimedOut, stillHeld, 'credit - deployed == tokens still held');
  });
});
