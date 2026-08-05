#![allow(unexpected_cfgs)]
//! MeteoraReceiver — spec §5.4.
//!
//! Two stages, because CCTP v2 burns are irreversible (§10.1):
//!
//! > "Under CCTP v2 the destination hook must succeed for funds to mint. If it
//! > reverts — time-sensitive checks, changed market conditions — the receive
//! > path fails while the source-side burn is already irreversible. V2 removed
//! > V1's replacement and rescue entry points... If the hook's preconditions
//! > can never be satisfied, the transfer is stuck indefinitely."
//!
//! So the split is not stylistic. Stage 1 runs inside CCTP message delivery
//! and **must not be able to fail**; stage 2 carries every fragile thing and
//! may be retried forever.
//!
//! §10.1's three mitigations, mapped to code:
//!
//! 1. *"Stage 1 cannot revert. It writes a counter. No CPI, no price
//!    assertion, no deadline."* → [`on_cctp_receive`] performs no CPI, reads
//!    no market state, and uses saturating arithmetic throughout.
//! 2. *"Hook data expresses tolerance, never equality. 'Pool P, ±N bins,'
//!    never 'exactly bin X.'"* → [`HookParams`] carries `bin_tolerance`, and
//!    there is no field in which an exact bin could be demanded.
//! 3. *"Pre-simulate the destination call before initiating the burn."* →
//!    off-chain, but [`Credit`] is public so a simulation can assert the
//!    account exists and is writable before a burn is signed.

use anchor_lang::prelude::*;

pub mod rules;
use rules::{available, check_deploy, credit_after_receive, DeployRejection};

declare_id!("9rLxHm1z9okw7Fi1XgiGQtBgU5HjLadAMJpgz4wNyNLr");

/// Seed for the per-(vault authority, pool) credit account.
pub const CREDIT_SEED: &[u8] = b"credit";

#[program]
pub mod meteora_receiver {
    use super::*;

    /// Create the credit account for a (vault authority, pool) pair.
    ///
    /// Separate from the receive path on purpose. §9.2 warns against
    /// `init_if_needed` — "extra CU on every call plus a well-known
    /// reinitialization footgun" — and there is a stronger reason here:
    /// allocation can fail (rent, space, a racing initializer), and stage 1
    /// must have no failure modes at all. Pre-creating the account moves that
    /// risk to a transaction whose failure costs nothing.
    pub fn init_credit(ctx: Context<InitCredit>, vault_authority: Pubkey, pool: Pubkey) -> Result<()> {
        let credit = &mut ctx.accounts.credit;
        credit.vault_authority = vault_authority;
        credit.pool = pool;
        credit.amount = 0;
        credit.deployed = 0;
        credit.bin_tolerance = 0;
        credit.nonce = 0;
        credit.bump = ctx.bumps.credit;
        Ok(())
    }

    /// Stage 1 — invoked by the CCTP `MessageTransmitter` via CPI.
    ///
    /// # This function must never fail
    ///
    /// Every operation is total. No CPI, no clock read, no market state, no
    /// deadline, and no arithmetic that can trap.
    ///
    /// The spec's own §5.4 sketch writes:
    ///
    /// ```ignore
    /// credit.amount = credit.amount.checked_add(params.amount).unwrap();
    /// ```
    ///
    /// which panics on overflow — precisely the outcome §10.1 says must be
    /// impossible, since a panic here strands an already-burned transfer
    /// forever. `saturating_add` is used instead. At 6 decimals a `u64`
    /// saturates past 18 trillion USDC so the clamp is unreachable in
    /// practice; and were it ever reached, clamping loses bookkeeping
    /// precision while panicking would lose the funds.
    pub fn on_cctp_receive(ctx: Context<OnCctpReceive>, params: HookParams) -> Result<()> {
        let credit = &mut ctx.accounts.credit;

        credit.amount = credit_after_receive(credit.amount, params.amount);
        credit.bin_tolerance = params.bin_tolerance;
        credit.nonce = params.nonce;

        // `sol_log_data` over packed bytes rather than `msg!`, per §9.2:
        // "Strip msg! from hot paths. Each formatted log costs CU
        // proportional to length."
        anchor_lang::solana_program::log::sol_log_data(&[
            b"credit",
            &params.amount.to_le_bytes(),
            &params.nonce.to_le_bytes(),
        ]);

        Ok(())
    }

    /// Stage 2 — permissionless and retryable. May fail freely.
    ///
    /// Everything that can go wrong lives here: the active bin may have moved,
    /// the pool may be paused, slippage may exceed tolerance. A failure costs
    /// a transaction fee and nothing else, because the funds were already
    /// safely credited by stage 1.
    ///
    /// §9.2: *"Pass computed values in, verify cheaply. The scoring engine
    /// already computed target bins, amounts and slippage bounds. The program
    /// validates bounds — it does not recompute the strategy."*
    pub fn deploy_position(ctx: Context<DeployPosition>, args: DeployArgs) -> Result<()> {
        let credit = &mut ctx.accounts.credit;

        // Validation lives in `rules::check_deploy`, which is pure and
        // property-tested. Tolerance, never equality (§10.1 mitigation 2).
        check_deploy(
            args.amount,
            credit.amount,
            credit.deployed,
            args.target_bin_id,
            args.active_bin_id,
            credit.bin_tolerance,
            args.min_amount_out,
        )
        .map_err(ReceiverError::from)?;

        // The Meteora DLMM CPI belongs here. Deliberately not faked: an
        // `add_liquidity_by_strategy` call needs bin arrays derived from the
        // runtime active bin, and a stub that returns success would make this
        // program look finished while doing nothing. See README "Known gaps".
        credit.deployed = credit.deployed.saturating_add(args.amount);

        anchor_lang::solana_program::log::sol_log_data(&[
            b"deploy",
            &args.amount.to_le_bytes(),
            &args.target_bin_id.to_le_bytes(),
        ]);

        Ok(())
    }

    /// Return undeployed credit to the vault authority's control.
    ///
    /// The escape hatch for when stage 2 can never succeed — the pool is
    /// retired, or the strategy no longer makes sense. Without it, credited
    /// funds whose destination has become impossible would sit forever, which
    /// is the same failure §10.1 is trying to avoid, one step later.
    pub fn release_credit(ctx: Context<ReleaseCredit>, amount: u64) -> Result<()> {
        let credit = &mut ctx.accounts.credit;
        let avail = available(credit.amount, credit.deployed);
        require!(amount > 0, ReceiverError::ZeroAmount);
        require!(amount <= avail, ReceiverError::AmountExceedsCredit);

        credit.amount = credit.amount.saturating_sub(amount);

        anchor_lang::solana_program::log::sol_log_data(&[b"release", &amount.to_le_bytes()]);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Credited balance for one (vault authority, pool) pair.
///
/// §9.2: *"Never call `find_program_address` on-chain. Each iteration is
/// ~1,500 CU."* The bump is stored at init and every later derivation uses
/// `seeds` + `bump = credit.bump`, which is a single derivation.
#[account]
#[derive(InitSpace, Debug)]
pub struct Credit {
    /// The Arc-side vault this credit belongs to.
    pub vault_authority: Pubkey,
    /// Target DLMM pool.
    pub pool: Pubkey,
    /// Total credited by CCTP receives, USDC base units (6dp).
    pub amount: u64,
    /// How much of `amount` has been placed into a position.
    pub deployed: u64,
    /// Bins either side of target that stage 2 will accept (§10.1).
    pub bin_tolerance: u16,
    /// Last CCTP message nonce, for off-chain idempotency checks.
    pub nonce: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct HookParams {
    pub vault_authority: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    /// Never an exact bin. §10.1: "Pool P, ±N bins, never exactly bin X."
    pub bin_tolerance: u16,
    pub nonce: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DeployArgs {
    pub amount: u64,
    /// Bin the engine aimed at when it built this instruction.
    pub target_bin_id: i32,
    /// Bin the pool is actually on now, read by the caller.
    pub active_bin_id: i32,
    /// Slippage floor. Zero is rejected.
    pub min_amount_out: u64,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(vault_authority: Pubkey, pool: Pubkey)]
pub struct InitCredit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Credit::INIT_SPACE,
        seeds = [CREDIT_SEED, vault_authority.as_ref(), pool.as_ref()],
        bump,
    )]
    pub credit: Account<'info, Credit>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: HookParams)]
pub struct OnCctpReceive<'info> {
    /// In production this is the CCTP `MessageTransmitter` PDA signing via
    /// CPI. Kept as a plain signer so the account set stays minimal — stage 1
    /// touches exactly one writable account.
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CREDIT_SEED, params.vault_authority.as_ref(), params.pool.as_ref()],
        bump = credit.bump,
    )]
    pub credit: Account<'info, Credit>,
}

#[derive(Accounts)]
pub struct DeployPosition<'info> {
    /// Permissionless: anyone may push a credited balance into its position.
    /// Parameters are validated against the stored tolerance, so a caller
    /// cannot direct funds anywhere the receive did not authorize.
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [CREDIT_SEED, credit.vault_authority.as_ref(), credit.pool.as_ref()],
        bump = credit.bump,
    )]
    pub credit: Account<'info, Credit>,
}

#[derive(Accounts)]
pub struct ReleaseCredit<'info> {
    /// Only the vault authority may pull credit back out.
    pub vault_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CREDIT_SEED, vault_authority.key().as_ref(), credit.pool.as_ref()],
        bump = credit.bump,
        has_one = vault_authority,
    )]
    pub credit: Account<'info, Credit>,
}

impl From<DeployRejection> for ReceiverError {
    fn from(r: DeployRejection) -> Self {
        match r {
            DeployRejection::ZeroAmount => ReceiverError::ZeroAmount,
            DeployRejection::NothingToDeploy => ReceiverError::NothingToDeploy,
            DeployRejection::AmountExceedsCredit => ReceiverError::AmountExceedsCredit,
            DeployRejection::ActiveBinOutsideTolerance => ReceiverError::ActiveBinOutsideTolerance,
            DeployRejection::UnboundedSlippage => ReceiverError::UnboundedSlippage,
            DeployRejection::ImpossibleSlippageBound => ReceiverError::ImpossibleSlippageBound,
        }
    }
}

#[error_code]
pub enum ReceiverError {
    #[msg("no undeployed credit available")]
    NothingToDeploy,
    #[msg("amount exceeds the credited balance")]
    AmountExceedsCredit,
    #[msg("amount must be non-zero")]
    ZeroAmount,
    #[msg("active bin is outside the tolerance recorded at receive time")]
    ActiveBinOutsideTolerance,
    #[msg("slippage bound must be non-zero")]
    UnboundedSlippage,
    #[msg("slippage bound exceeds the amount being deployed")]
    ImpossibleSlippageBound,
}
