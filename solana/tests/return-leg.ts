/**
 * The way back out.
 *
 * `deploy_position` sends credited USDC *forward* into a position. Nothing
 * sends it back: the program has no `deposit_for_burn`, so once capital
 * reaches this receiver it cannot return to Arc by any instruction here.
 *
 * `release_credit` is the documented escape hatch — "return undeployed credit
 * to the vault authority's control" — but it took no token accounts at all.
 * It decremented `credit.amount` and stopped there, which does not release
 * anything: the USDC stays in a PDA-owned account whose only mover is
 * `deploy_position`, and that is gated on `available(amount, deployed)`. So
 * calling the escape hatch *removed* the one path able to move the funds and
 * left them where they were.
 *
 * These tests pin the hatch actually opening. Getting tokens back under the
 * vault authority's control is the on-chain half of the return leg; the burn
 * home is then the same off-chain App Kit hop the Base Sepolia venue uses.
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

describe('the return leg', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.MeteoraReceiver as Program;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // A real keypair this time: releasing credit requires the vault authority to
  // sign, which a bare Pubkey cannot do.
  const vaultAuthority = Keypair.generate();
  const pool = Keypair.generate().publicKey;

  let mint: PublicKey;
  let credit: PublicKey;
  let vaultTokenAccount: PublicKey;
  let destination: PublicKey;
  /** Where released capital lands: owned by the vault authority. */
  let recipient: PublicKey;
  /** Owned by someone else entirely. */
  let stranger: PublicKey;

  before(async () => {
    [credit] = PublicKey.findProgramAddressSync(
      [CREDIT_SEED, vaultAuthority.publicKey.toBuffer(), pool.toBuffer()],
      program.programId,
    );
    [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, vaultAuthority.publicKey.toBuffer(), pool.toBuffer()],
      program.programId,
    );

    const sig = await provider.connection.requestAirdrop(vaultAuthority.publicKey, 1e9);
    await provider.connection.confirmTransaction(sig);

    mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    destination = await createAccount(provider.connection, payer, mint, payer.publicKey);
    recipient = await createAccount(
      provider.connection,
      payer,
      mint,
      vaultAuthority.publicKey,
      Keypair.generate(),
    );
    stranger = await createAccount(
      provider.connection,
      payer,
      mint,
      Keypair.generate().publicKey,
      Keypair.generate(),
    );

    await program.methods
      .initCredit(vaultAuthority.publicKey, pool, destination, payer.publicKey)
      .accounts({ payer: payer.publicKey, credit, systemProgram: SystemProgram.programId })
      .rpc();

    await program.methods
      .initVault(vaultAuthority.publicKey, pool)
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

    // CCTP mints $1,000 into the program-owned account, and stage 1 credits it.
    await mintTo(provider.connection, payer, mint, vaultTokenAccount, payer, 1_000e6);
    await program.methods
      .onCctpReceive({
        vaultAuthority: vaultAuthority.publicKey,
        pool,
        amount: USDC(1_000),
        binTolerance: 5,
        nonce: new anchor.BN(1),
      })
      .accounts({ authority: payer.publicKey, credit })
      .rpc();
  });

  function releaseAccounts(to: PublicKey) {
    return {
      vaultAuthority: vaultAuthority.publicKey,
      credit,
      vaultTokenAccount,
      recipient: to,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  it('moves the tokens, not just the counter', async () => {
    const vaultBefore = await getAccount(provider.connection, vaultTokenAccount);
    assert.equal(vaultBefore.amount.toString(), '1000000000', 'the vault holds the USDC');

    await program.methods
      .releaseCredit(USDC(400))
      .accounts(releaseAccounts(recipient))
      .signers([vaultAuthority])
      .rpc();

    const vaultAfter = await getAccount(provider.connection, vaultTokenAccount);
    const landed = await getAccount(provider.connection, recipient);
    const acct = await (program.account as any).credit.fetch(credit);

    assert.equal(landed.amount.toString(), '400000000', 'the capital actually left the program');
    assert.equal(vaultAfter.amount.toString(), '600000000', 'and the vault is down by the same');
    assert.equal(acct.amount.toNumber(), 600e6, 'the counter follows the tokens');
  });

  /**
   * The property that makes the hatch safe to have: after releasing, what is
   * still credited is still backed. Custody and books move together or the
   * next `deploy_position` pays out of capital that is no longer there.
   */
  it('leaves the remaining credit fully backed', async () => {
    const vault = await getAccount(provider.connection, vaultTokenAccount);
    const acct = await (program.account as any).credit.fetch(credit);
    const outstanding = acct.amount.toNumber() - acct.deployed.toNumber();
    assert.isAtLeast(Number(vault.amount), outstanding, 'custody covers the books');
  });

  it('refuses to send capital to an account the vault authority does not own', async () => {
    try {
      await program.methods
        .releaseCredit(USDC(100))
        .accounts(releaseAccounts(stranger))
        .signers([vaultAuthority])
        .rpc();
      assert.fail('released to an account owned by someone else');
    } catch (err: any) {
      assert.match(String(err), /RecipientNotOwnedByVaultAuthority/);
    }
  });

  it('refuses to release more than is credited and undeployed', async () => {
    try {
      await program.methods
        .releaseCredit(USDC(10_000))
        .accounts(releaseAccounts(recipient))
        .signers([vaultAuthority])
        .rpc();
      assert.fail('released more than was credited');
    } catch (err: any) {
      assert.match(String(err), /AmountExceedsCredit/);
    }
  });

  it('releases the rest, emptying the program cleanly', async () => {
    await program.methods
      .releaseCredit(USDC(600))
      .accounts(releaseAccounts(recipient))
      .signers([vaultAuthority])
      .rpc();

    const vault = await getAccount(provider.connection, vaultTokenAccount);
    const acct = await (program.account as any).credit.fetch(credit);
    assert.equal(vault.amount.toString(), '0', 'nothing stranded in the program');
    assert.equal(acct.amount.toNumber(), 0, 'and nothing still claimed');
  });
});
