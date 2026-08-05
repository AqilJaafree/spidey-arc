/**
 * MeteoraReceiver — on-chain tests with sample inputs.
 *
 * The unit tests in `src/rules.rs` prove the decision logic across the full
 * input space. These prove the program actually runs on a Solana runtime, and
 * measure the two things a validator can tell us that a unit test cannot:
 * compute units against §9.3's budgets, and that stage 1 really is total when
 * executed rather than merely when reasoned about.
 *
 *   §9.3  on_cctp_receive  < 20,000 CU
 *         deploy_position  < 250,000 CU
 */

import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { assert } from 'chai';

const CREDIT_SEED = Buffer.from('credit');
const USDC = (n: number) => new anchor.BN(Math.round(n * 1e6));

/** §9.3's budgets, asserted rather than admired. */
const CU_BUDGET = {
  on_cctp_receive: 20_000,
  deploy_position: 250_000,
};

describe('meteora-receiver', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.MeteoraReceiver as Program;

  const vaultAuthority = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  let credit: PublicKey;

  /** Pull `unitsConsumed` out of a simulation, per §9.1. */
  async function measureCu(ix: anchor.web3.TransactionInstruction): Promise<number> {
    const tx = new anchor.web3.Transaction().add(ix);
    tx.feePayer = provider.wallet.publicKey;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    const sim = await provider.connection.simulateTransaction(tx);
    return sim.value.unitsConsumed ?? 0;
  }

  before(async () => {
    [credit] = PublicKey.findProgramAddressSync(
      [CREDIT_SEED, vaultAuthority.toBuffer(), pool.toBuffer()],
      program.programId,
    );
  });

  it('creates the credit account before any CCTP message arrives', async () => {
    await program.methods
      .initCredit(vaultAuthority, pool)
      .accounts({
        payer: provider.wallet.publicKey,
        credit,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const acct = await (program.account as any).credit.fetch(credit);
    assert.equal(acct.amount.toNumber(), 0, 'starts empty');
    assert.equal(acct.deployed.toNumber(), 0);
    assert.ok(acct.vaultAuthority.equals(vaultAuthority));
    assert.ok(acct.pool.equals(pool));
  });

  it('stage 1 credits a $1,000 receive', async () => {
    const params = {
      vaultAuthority,
      pool,
      amount: USDC(1_000),
      binTolerance: 5,
      nonce: new anchor.BN(1),
    };

    await program.methods
      .onCctpReceive(params)
      .accounts({ authority: provider.wallet.publicKey, credit })
      .rpc();

    const acct = await (program.account as any).credit.fetch(credit);
    assert.equal(acct.amount.toNumber(), 1_000e6, 'credited in full');
    assert.equal(acct.binTolerance, 5, 'tolerance recorded, not a target bin');
  });

  it('stage 1 accumulates across messages', async () => {
    await program.methods
      .onCctpReceive({
        vaultAuthority,
        pool,
        amount: USDC(2_500),
        binTolerance: 5,
        nonce: new anchor.BN(2),
      })
      .accounts({ authority: provider.wallet.publicKey, credit })
      .rpc();

    const acct = await (program.account as any).credit.fetch(credit);
    assert.equal(acct.amount.toNumber(), 3_500e6, '$1,000 + $2,500');
  });

  it('stage 1 is within its 20k CU budget (§9.3)', async () => {
    const ix = await program.methods
      .onCctpReceive({
        vaultAuthority,
        pool,
        amount: USDC(1),
        binTolerance: 5,
        nonce: new anchor.BN(99),
      })
      .accounts({ authority: provider.wallet.publicKey, credit })
      .instruction();

    const cu = await measureCu(ix);
    console.log(`      on_cctp_receive: ${cu} CU / ${CU_BUDGET.on_cctp_receive}`);
    assert.isBelow(cu, CU_BUDGET.on_cctp_receive, 'stage 1 over budget');
  });

  it('stage 2 deploys inside tolerance', async () => {
    const before = await (program.account as any).credit.fetch(credit);

    await program.methods
      .deployPosition({
        amount: USDC(1_000),
        targetBinId: 8_388_600,
        activeBinId: 8_388_602, // 2 bins of drift, tolerance is 5
        minAmountOut: USDC(995),
      })
      .accounts({ caller: provider.wallet.publicKey, credit })
      .rpc();

    const after = await (program.account as any).credit.fetch(credit);
    assert.equal(
      after.deployed.toNumber() - before.deployed.toNumber(),
      1_000e6,
      'deployed what was asked',
    );
    assert.equal(after.amount.toNumber(), before.amount.toNumber(), 'credit itself unchanged');
  });

  it('stage 2 is within its 250k CU budget (§9.3)', async () => {
    const ix = await program.methods
      .deployPosition({
        amount: USDC(1),
        targetBinId: 100,
        activeBinId: 100,
        minAmountOut: USDC(0.9),
      })
      .accounts({ caller: provider.wallet.publicKey, credit })
      .instruction();

    const cu = await measureCu(ix);
    console.log(`      deploy_position: ${cu} CU / ${CU_BUDGET.deploy_position}`);
    assert.isBelow(cu, CU_BUDGET.deploy_position, 'stage 2 over budget');
  });

  it('stage 2 refuses a pool that moved outside tolerance', async () => {
    try {
      await program.methods
        .deployPosition({
          amount: USDC(100),
          targetBinId: 8_388_600,
          activeBinId: 8_390_000, // 1,400 bins away
          minAmountOut: USDC(99),
        })
        .accounts({ caller: provider.wallet.publicKey, credit })
        .rpc();
      assert.fail('should have been refused');
    } catch (e: any) {
      assert.include(e.toString(), 'ActiveBinOutsideTolerance');
    }
  });

  it('stage 2 refuses an unbounded slippage floor', async () => {
    try {
      await program.methods
        .deployPosition({
          amount: USDC(100),
          targetBinId: 100,
          activeBinId: 100,
          minAmountOut: new anchor.BN(0),
        })
        .accounts({ caller: provider.wallet.publicKey, credit })
        .rpc();
      assert.fail('should have been refused');
    } catch (e: any) {
      assert.include(e.toString(), 'UnboundedSlippage');
    }
  });

  it('stage 2 refuses to deploy more than was credited', async () => {
    try {
      await program.methods
        .deployPosition({
          amount: USDC(1_000_000),
          targetBinId: 100,
          activeBinId: 100,
          minAmountOut: USDC(1),
        })
        .accounts({ caller: provider.wallet.publicKey, credit })
        .rpc();
      assert.fail('should have been refused');
    } catch (e: any) {
      assert.include(e.toString(), 'AmountExceedsCredit');
    }
  });

  /**
   * The property the whole two-stage design exists for. A stage-2 failure must
   * leave the credit intact and retryable — otherwise an irreversible CCTP
   * burn would be stranded (§10.1).
   */
  it('a failed stage 2 leaves the credit intact and retryable', async () => {
    const before = await (program.account as any).credit.fetch(credit);

    try {
      await program.methods
        .deployPosition({
          amount: USDC(100),
          targetBinId: 0,
          activeBinId: 999_999, // hopeless drift
          minAmountOut: USDC(99),
        })
        .accounts({ caller: provider.wallet.publicKey, credit })
        .rpc();
      assert.fail('should have been refused');
    } catch {
      /* expected */
    }

    const after = await (program.account as any).credit.fetch(credit);
    assert.equal(after.amount.toNumber(), before.amount.toNumber(), 'credit untouched');
    assert.equal(after.deployed.toNumber(), before.deployed.toNumber(), 'nothing deployed');

    // ...and the same funds deploy successfully once the pool comes back.
    await program.methods
      .deployPosition({
        amount: USDC(100),
        targetBinId: 500,
        activeBinId: 502,
        minAmountOut: USDC(99),
      })
      .accounts({ caller: provider.wallet.publicKey, credit })
      .rpc();

    const retried = await (program.account as any).credit.fetch(credit);
    assert.equal(
      retried.deployed.toNumber() - before.deployed.toNumber(),
      100e6,
      'retry succeeded with the same funds',
    );
  });
});
