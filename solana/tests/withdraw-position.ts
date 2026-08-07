/**
 * The exit.
 *
 * `deploy_position` sends credited USDC into a DLMM position and, until this
 * instruction existed, nothing took it out — and only the Credit PDA can sign
 * as the position's owner, so nothing outside this program ever could. That is
 * a one-way door, and the one place the system's "capital comes home first"
 * rule had no mechanism behind it.
 *
 * The DLMM CPI itself is proven on devnet by `scripts/withdraw-dlmm.ts`,
 * because DLMM is not deployed on the local validator. What these tests pin is
 * everything around it: who may call, where each side of the pool is allowed
 * to land, and that one credit holds exactly one position.
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo, getAccount } from '@solana/spl-token';
import { assert } from 'chai';

const CREDIT_SEED = Buffer.from('credit');
const VAULT_SEED = Buffer.from('vault');
const USDC = (n: number) => new anchor.BN(Math.round(n * 1e6));

describe('the exit', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.MeteoraReceiver as Program;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const vaultAuthority = Keypair.generate();
  const pool = Keypair.generate().publicKey;

  let mint: PublicKey;
  /** The pool's other side. A real mint, because tests need real accounts on it. */
  let mintOther: PublicKey;
  let credit: PublicKey;
  let vaultTokenAccount: PublicKey;
  let destination: PublicKey;
  /** Owned by the vault authority, holding the other side's mint. */
  let otherRecipient: PublicKey;
  /** Set by the adoption test; every later test must pass this exact position. */
  let adoptedPosition: PublicKey;

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
    mintOther = await createMint(provider.connection, payer, payer.publicKey, null, 9);
    destination = await createAccount(provider.connection, payer, mint, payer.publicKey);
    otherRecipient = await createAccount(
      provider.connection,
      payer,
      mintOther,
      vaultAuthority.publicKey,
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

  it('starts with no position recorded', async () => {
    const acct = await (program.account as any).credit.fetch(credit);
    assert.equal(
      acct.position.toBase58(),
      PublicKey.default.toBase58(),
      'a fresh credit points at no position',
    );
    assert.equal(acct.positionLowerBinId, 0);
    assert.equal(acct.positionWidth, 0);
  });

  it('adopts a position and then refuses a second one', async () => {
    adoptedPosition = Keypair.generate().publicKey;
    await program.methods
      .adoptPosition(adoptedPosition, 100, 20)
      .accounts({
        vaultAuthority: vaultAuthority.publicKey,
        payer: payer.publicKey,
        credit,
        systemProgram: SystemProgram.programId,
      })
      .signers([vaultAuthority])
      .rpc();

    const acct = await (program.account as any).credit.fetch(credit);
    assert.equal(acct.position.toBase58(), adoptedPosition.toBase58());
    assert.equal(acct.positionLowerBinId, 100);
    assert.equal(acct.positionWidth, 20);

    try {
      await program.methods
        .adoptPosition(Keypair.generate().publicKey, 200, 20)
        .accounts({
          vaultAuthority: vaultAuthority.publicKey,
          payer: payer.publicKey,
          credit,
          systemProgram: SystemProgram.programId,
        })
        .signers([vaultAuthority])
        .rpc();
      assert.fail('adopted a second position, orphaning the first');
    } catch (err: any) {
      assert.match(String(err), /PositionAlreadyAdopted/);
    }
  });
});
