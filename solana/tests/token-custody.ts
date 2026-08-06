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

  it('stage 1 credits a real CCTP mint into the program-owned account', async () => {
    // CCTP mints $1,000 into the program-owned account...
    await mintTo(provider.connection, payer, mint, vaultTokenAccount, payer, 1_000e6);

    // ...and stage 1 credits it. This path is unchanged by the DLMM CPI.
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

    const acct = await (program.account as any).credit.fetch(credit);
    assert.equal(acct.amount.toNumber(), 1_000e6, 'credited');
    assert.equal(acct.deployed.toNumber(), 0, 'nothing deployed yet');

    const vault = await getAccount(provider.connection, vaultTokenAccount);
    assert.equal(vault.amount.toString(), (1_000e6).toString(), 'held by the program');
  });

  /**
   * Stage 2 now performs a live Meteora DLMM CPI
   * (`add_liquidity_by_strategy_one_side`), so it cannot be exercised against a
   * bare SPL mint — it needs a real pool, an initialized position, and the two
   * bin arrays for the range. These are the devnet-integration tests, skipped
   * until wired against a live pool (~10,800 exist on devnet).
   *
   * What still has coverage WITHOUT a pool:
   *   - `check_deploy` — every rejection (zero amount, over-credit, active bin
   *     outside tolerance, unbounded/impossible slippage) is property-tested in
   *     `rules.rs`, pure and offline. The validation did not move; only the
   *     token movement became a CPI.
   *   - the custody/authority setup above (init_credit, init_vault, stage 1).
   *
   * The safety property that WAS "destination is pinned" is now "lb_pair is
   * pinned to credit.pool" — a permissionless caller cannot divert the credited
   * USDC into a pool of their choosing. That is the first thing to assert once
   * this runs live.
   */
  describe.skip('stage 2 — live DLMM one-sided CPI (needs a real pool)', () => {
    it('adds one-sided USDC liquidity to the pinned pool', async () => {
      // Keeper-derived, off-chain (§9.2). For a real pool:
      //   activeId   = pool active bin, read on-chain
      //   [min,max]  = one-sided range from activeId (USDC side only)
      //   binArrayLower/Upper = deriveBinArray(lbPair, floor(bin/70), DLMM_ID)
      //   position  = initialize_position(lower_bin_id, width) beforehand
      const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
      // (lbPair, reserve, tokenMint, position, binArrayLower, binArrayUpper,
      //  eventAuthority, binArrayBitmapExtension) all come from the live pool.

      await program.methods
        .deployPosition({
          amount: USDC(400),
          targetBinId: 100,
          activeBinId: 102,
          minAmountOut: USDC(399),
          minBinId: 102,
          maxBinId: 140,
          maxActiveBinSlippage: 5,
          strategyType: 0, // SpotOneSide
        })
        .accounts({
          caller: payer.publicKey,
          credit,
          vaultTokenAccount,
          // position, lbPair (== credit.pool), reserve, tokenMint,
          // binArrayLower, binArrayUpper, eventAuthority,
          // dlmmProgram: DLMM_PROGRAM, tokenProgram, and the optional
          // binArrayBitmapExtension — all from the live pool.
          dlmmProgram: DLMM_PROGRAM,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const acct = await (program.account as any).credit.fetch(credit);
      assert.equal(acct.deployed.toNumber(), 400e6, 'books track the deployed amount');
    });
  });
});
