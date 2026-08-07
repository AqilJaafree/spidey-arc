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

  it('refuses to deploy into a position the credit does not own', async () => {
    // The credit adopted `adoptedPosition` in the previous test. A different
    // position account — even a plausible one — must not be accepted.
    try {
      await program.methods
        .deployPosition({
          amount: USDC(1),
          targetBinId: 100,
          activeBinId: 100,
          minAmountOut: new anchor.BN(1),
          minBinId: 100,
          maxBinId: 119,
          maxActiveBinSlippage: 5,
          strategyType: 0,
        })
        .accounts({
          caller: payer.publicKey,
          credit,
          vaultTokenAccount,
          position: Keypair.generate().publicKey,
          lbPair: pool,
          binArrayBitmapExtension: null,
          reserve: Keypair.generate().publicKey,
          tokenMint: mint,
          binArrayLower: Keypair.generate().publicKey,
          binArrayUpper: Keypair.generate().publicKey,
          eventAuthority: Keypair.generate().publicKey,
          dlmmProgram: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail('deployed into a position the credit does not own');
    } catch (err: any) {
      // Anchor's `address` constraint reports ConstraintAddress.
      assert.match(String(err), /ConstraintAddress|AnchorError/);
    }
  });

  const DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

  /**
   * The bin arrays, reserves and event authority are junk keypairs: every test
   * in this file rejects before the CPI, which is the point — the CPI is proven
   * on devnet.
   *
   * `position`, `lbPair` and the two mints are NOT junk. Anchor validates
   * accounts in declaration order, so a wrong `position` fails
   * `ConstraintAddress` before any handler code runs, and a `tokenYMint` with
   * no real accounts on it makes the mint check unsatisfiable — either way the
   * test would pass for the wrong reason.
   */
  function withdrawAccounts(other: PublicKey) {
    return {
      vaultAuthority: vaultAuthority.publicKey,
      credit,
      vaultTokenAccount,
      otherRecipient: other,
      position: adoptedPosition,
      lbPair: pool,
      binArrayBitmapExtension: null,
      reserveX: Keypair.generate().publicKey,
      reserveY: Keypair.generate().publicKey,
      tokenXMint: mint,
      tokenYMint: mintOther,
      binArrayLower: Keypair.generate().publicKey,
      binArrayUpper: Keypair.generate().publicKey,
      eventAuthority: Keypair.generate().publicKey,
      dlmmProgram: DLMM,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  it('refuses to exit when nothing is deployed', async () => {
    // credit.deployed is 0 — the $1,000 was credited but never deployed. Every
    // account here is well-formed, so validation and the mint check pass and
    // the bookkeeping guard is what rejects.
    try {
      await program.methods
        .withdrawPosition()
        .accounts(withdrawAccounts(otherRecipient))
        .signers([vaultAuthority])
        .rpc();
      assert.fail('exited a position that does not exist');
    } catch (err: any) {
      assert.match(String(err), /NothingDeployed/);
    }
  });

  /**
   * A second credit, with its own authority, so the wrong-signer case is a real
   * mismatch rather than a missing signature. Each test here pins a guard that
   * must fire BEFORE the exit touches DLMM — the CPI itself is proven on devnet
   * by scripts/withdraw-dlmm.ts, because DLMM is not on the local validator.
   */
  describe('the guards on the way out', () => {
    const authority2 = Keypair.generate();
    const pool2 = Keypair.generate().publicKey;
    let credit2: PublicKey;
    let vault2: PublicKey;
    let position2: PublicKey;
    let goodRecipient: PublicKey;
    let strangerRecipient: PublicKey;
    let wrongMintRecipient: PublicKey;

    before(async () => {
      [credit2] = PublicKey.findProgramAddressSync(
        [CREDIT_SEED, authority2.publicKey.toBuffer(), pool2.toBuffer()],
        program.programId,
      );
      [vault2] = PublicKey.findProgramAddressSync(
        [VAULT_SEED, authority2.publicKey.toBuffer(), pool2.toBuffer()],
        program.programId,
      );

      const sig = await provider.connection.requestAirdrop(authority2.publicKey, 1e9);
      await provider.connection.confirmTransaction(sig);

      goodRecipient = await createAccount(
        provider.connection, payer, mintOther, authority2.publicKey, Keypair.generate(),
      );
      strangerRecipient = await createAccount(
        provider.connection, payer, mintOther, Keypair.generate().publicKey, Keypair.generate(),
      );
      // Owned by the right party, but holding the CUSTODY mint, not the other side.
      wrongMintRecipient = await createAccount(
        provider.connection, payer, mint, authority2.publicKey, Keypair.generate(),
      );

      await program.methods
        .initCredit(authority2.publicKey, pool2, destination, payer.publicKey)
        .accounts({ payer: payer.publicKey, credit: credit2, systemProgram: SystemProgram.programId })
        .rpc();

      await program.methods
        .initVault(authority2.publicKey, pool2)
        .accounts({
          payer: payer.publicKey,
          credit: credit2,
          vaultTokenAccount: vault2,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      position2 = Keypair.generate().publicKey;
      await program.methods
        .adoptPosition(position2, 100, 20)
        .accounts({
          vaultAuthority: authority2.publicKey,
          payer: payer.publicKey,
          credit: credit2,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority2])
        .rpc();
    });

    function accountsFor(other: PublicKey, authority: PublicKey = authority2.publicKey) {
      return {
        vaultAuthority: authority,
        credit: credit2,
        vaultTokenAccount: vault2,
        otherRecipient: other,
        // The real adopted position: a wrong one fails ConstraintAddress during
        // account validation, which would mask the check each test is for.
        position: position2,
        lbPair: pool2,
        binArrayBitmapExtension: null,
        reserveX: Keypair.generate().publicKey,
        reserveY: Keypair.generate().publicKey,
        tokenXMint: mint,
        tokenYMint: mintOther,
        binArrayLower: Keypair.generate().publicKey,
        binArrayUpper: Keypair.generate().publicKey,
        eventAuthority: Keypair.generate().publicKey,
        dlmmProgram: DLMM,
        tokenProgram: TOKEN_PROGRAM_ID,
      };
    }

    it('refuses a caller who is not the vault authority', async () => {
      // The outer authority, passed as the account AND signing, so the
      // transaction actually builds and reaches the program. Passing
      // authority2 as the account while signing with someone else would be
      // rejected client-side as an unknown signer, proving nothing about the
      // on-chain guard — this test would then pass with the seeds constraint
      // deleted.
      try {
        await program.methods
          .withdrawPosition()
          .accounts(accountsFor(goodRecipient, vaultAuthority.publicKey))
          .signers([vaultAuthority])
          .rpc();
        assert.fail('a stranger unwound the position');
      } catch (err: any) {
        assert.match(String(err), /ConstraintSeeds/);
      }
    });

    it('refuses an other-side recipient the vault authority does not own', async () => {
      try {
        await program.methods
          .withdrawPosition()
          .accounts(accountsFor(strangerRecipient))
          .signers([authority2])
          .rpc();
        assert.fail('sent the other side to an account owned by someone else');
      } catch (err: any) {
        assert.match(String(err), /RecipientNotOwnedByVaultAuthority/);
      }
    });

    it('refuses an other-side recipient holding the custody mint', async () => {
      // Owned by the right party, wrong mint: this is the account the CUSTODY
      // side lands in, so accepting it would send both sides to one place and
      // silently inflate the measured balance the books are re-marked from.
      try {
        await program.methods
          .withdrawPosition()
          .accounts(accountsFor(wrongMintRecipient))
          .signers([authority2])
          .rpc();
        assert.fail('accepted a recipient holding the custody mint');
      } catch (err: any) {
        // Specifically NOT NothingDeployed: credit2.deployed is 0 too, so an
        // either/or assertion here would pass without the mint check existing.
        assert.match(String(err), /RecipientMintMismatch/);
      }
    });
  });

  /**
   * Retiring a position — the instruction that unbinds a credit from the one
   * range it first opened at, and reclaims the rent of positions it owns but
   * never adopted.
   *
   * The CPI itself is proven on devnet; DLMM is not on the local validator. So
   * these pin the guards that fire during account validation, before the CPI:
   * who may call, where the rent may land, and which pool.
   */
  describe('retiring a position', () => {
    function retireAccounts(overrides: Record<string, PublicKey> = {}) {
      return {
        vaultAuthority: vaultAuthority.publicKey,
        credit,
        position: adoptedPosition,
        lbPair: pool,
        binArrayLower: Keypair.generate().publicKey,
        binArrayUpper: Keypair.generate().publicKey,
        rentReceiver: vaultAuthority.publicKey,
        eventAuthority: Keypair.generate().publicKey,
        dlmmProgram: DLMM,
        ...overrides,
      };
    }

    it('refuses a caller who is not the vault authority', async () => {
      // `payer` is passed as the account AND signs, so the transaction builds
      // and reaches the program. Passing the real authority while signing with
      // someone else fails client-side as an unknown signer, which would prove
      // nothing — that test passes with the seeds constraint deleted.
      try {
        await program.methods
          .retirePosition()
          .accounts(
            retireAccounts({
              vaultAuthority: payer.publicKey,
              rentReceiver: payer.publicKey,
            }),
          )
          .rpc();
        assert.fail('a stranger retired the position');
      } catch (err: any) {
        assert.match(String(err), /ConstraintSeeds/);
      }
    });

    it('refuses a rent receiver that is not the vault authority', async () => {
      try {
        await program.methods
          .retirePosition()
          .accounts(retireAccounts({ rentReceiver: payer.publicKey }))
          .signers([vaultAuthority])
          .rpc();
        assert.fail('sent the reclaimed rent somewhere else');
      } catch (err: any) {
        assert.match(String(err), /ConstraintAddress/);
      }
    });

    it("refuses an lb_pair that is not the credit's pool", async () => {
      try {
        await program.methods
          .retirePosition()
          .accounts(retireAccounts({ lbPair: Keypair.generate().publicKey }))
          .signers([vaultAuthority])
          .rpc();
        assert.fail('retired against a pool this credit was not opened on');
      } catch (err: any) {
        assert.match(String(err), /ConstraintAddress/);
      }
    });
  });
});
