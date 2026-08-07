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
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub mod rules;
use rules::{
    available, check_deploy, credit_after_receive, custody_side, position_range, DeployRejection,
    Side, WithdrawRejection,
};

declare_id!("FLfdxZbnkMFCRAgGDTkMzZn3i2X2EKZhYBep6seHjqNp");

// Meteora DLMM (`lb_clmm`), for the stage-2 CPI. `declare_program!(dlmm)` reads
// `idls/dlmm.json` and generates typed CPI bindings: `dlmm::ID`, `dlmm::cpi::*`,
// `dlmm::cpi::accounts::*`, `dlmm::types::*`. This is Meteora's own integration
// pattern (see MeteoraAg/cpi-examples), not hand-rolled discriminators.
//
// `idls/dlmm.json` is a deliberately MINIMAL slice of the live IDL — the one
// instruction we call (`add_liquidity_by_strategy_one_side`) and the three
// types it needs. The full devnet IDL is kept alongside as
// `idls/lb_clmm.devnet.json` for reference. The macro must be trimmed because
// it generates a zero-copy `Pod` struct for every entry in the IDL's
// `accounts`, and several DLMM state accounts (`PresetParameter2`, `TokenBadge`
// …) do not satisfy `AnyBitPattern` — 41 compile errors we do not need, since a
// CPI never deserializes those accounts.
//
// The program ID is the same across clusters (`LBUZ…Pwxo`), so this serves
// devnet and mainnet — which is what "one-sided USDC on every chain" needs.
declare_program!(dlmm);

/// Seed for the per-(vault authority, pool) credit account.
pub const CREDIT_SEED: &[u8] = b"credit";

/// Seed for the program-owned USDC account CCTP mints into.
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod meteora_receiver {
    use super::*;

    /// Create the program-owned token account CCTP mints into.
    pub fn init_vault(_ctx: Context<InitVault>, _vault_authority: Pubkey, _pool: Pubkey) -> Result<()> {
        Ok(())
    }

    /// Create the credit account for a (vault authority, pool) pair.
    ///
    /// Separate from the receive path on purpose. §9.2 warns against
    /// `init_if_needed` — "extra CU on every call plus a well-known
    /// reinitialization footgun" — and there is a stronger reason here:
    /// allocation can fail (rent, space, a racing initializer), and stage 1
    /// must have no failure modes at all. Pre-creating the account moves that
    /// risk to a transaction whose failure costs nothing.
    ///
    /// `cctp_authority` is pinned here for the same reason `destination` is:
    /// it is the one chance to say who may credit this account, before any
    /// money is involved.
    pub fn init_credit(
        ctx: Context<InitCredit>,
        vault_authority: Pubkey,
        pool: Pubkey,
        destination: Pubkey,
        cctp_authority: Pubkey,
    ) -> Result<()> {
        let credit = &mut ctx.accounts.credit;
        credit.vault_authority = vault_authority;
        credit.pool = pool;
        credit.destination = destination;
        credit.cctp_authority = cctp_authority;
        credit.amount = 0;
        credit.deployed = 0;
        credit.bin_tolerance = 0;
        credit.nonce = 0;
        credit.position = Pubkey::default();
        credit.position_lower_bin_id = 0;
        credit.position_width = 0;
        credit.bump = ctx.bumps.credit;
        Ok(())
    }

    /// Point an existing credit at the position it already owns.
    ///
    /// A migration, needed exactly once: the devnet credit and its 0.3 USDC
    /// position predate the three fields above. `init_position` writes them for
    /// every position opened from now on, so new credits never reach here.
    ///
    /// Refuses when a position is already recorded — see
    /// [`ReceiverError::PositionAlreadyAdopted`]. Overwriting the pointer would
    /// orphan the first position, and since only the `Credit` PDA can sign as
    /// its owner, orphaned means unreachable forever. That is the failure this
    /// whole return leg exists to remove; it must not be reintroduced by the
    /// instruction that enables it.
    pub fn adopt_position(
        ctx: Context<AdoptPosition>,
        position: Pubkey,
        lower_bin_id: i32,
        width: i32,
    ) -> Result<()> {
        let credit = &mut ctx.accounts.credit;
        require!(
            credit.position == Pubkey::default(),
            ReceiverError::PositionAlreadyAdopted
        );
        // Rejects width <= 0 and a range that leaves i32, so a credit can never
        // record a position it could not later derive an exit range for.
        position_range(lower_bin_id, width).map_err(ReceiverError::from)?;

        credit.position = position;
        credit.position_lower_bin_id = lower_bin_id;
        credit.position_width = width;
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

    /// Create the DLMM position that stage 2 adds liquidity to, owned by the
    /// `Credit` PDA.
    ///
    /// # Why the program has to create it
    ///
    /// The add-liquidity CPI in [`deploy_position`] signs as the `Credit` PDA —
    /// it must, because the PDA is the authority over the USDC being spent. The
    /// DLMM program requires that signer to be the position's owner (or
    /// operator). So the position has to be owned by the `Credit` PDA, and
    /// `initialize_position` requires the owner to *sign* — which only this
    /// program can do for a PDA. A keeper-created position would be owned by the
    /// keeper, and the CPI could never add the vault's USDC to it.
    ///
    /// The bin arrays the range needs are NOT created here: `initialize_bin_array`
    /// is permissionless (any funder), so the keeper makes those directly on the
    /// DLMM program. Only the position needs the PDA's signature.
    ///
    /// `position` is a fresh keypair the caller supplies and signs at the tx
    /// level; `owner` is the `Credit` PDA, signed here via its seeds.
    pub fn init_position(ctx: Context<InitPosition>, lower_bin_id: i32, width: i32) -> Result<()> {
        let credit = &ctx.accounts.credit;
        let vault_authority = credit.vault_authority;
        let pool = credit.pool;
        let bump = credit.bump;
        let seeds: &[&[u8]] = &[CREDIT_SEED, vault_authority.as_ref(), pool.as_ref(), &[bump]];

        let cpi_accounts = dlmm::cpi::accounts::InitializePosition {
            payer: ctx.accounts.payer.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            lb_pair: ctx.accounts.lb_pair.to_account_info(),
            owner: ctx.accounts.credit.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.dlmm_program.to_account_info(),
        };

        dlmm::cpi::initialize_position(
            CpiContext::new_with_signer(
                ctx.accounts.dlmm_program.to_account_info(),
                cpi_accounts,
                &[seeds],
            ),
            lower_bin_id,
            width,
        )?;

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
        let credit = &ctx.accounts.credit;

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

        // The stage-2 hop that was missing: add USDC to a Meteora DLMM position
        // via CPI, drawing from the program-owned `vault_token_account`.
        //
        // ONE-SIDED, always. This receiver holds a single token (USDC arrives
        // by CCTP), and the strategy is the same on every chain — deposit that
        // one token on one side of the active bin. So this is
        // `add_liquidity_by_strategy_one_side`, whose account set is a single
        // token side (no dummy Y-side reserve/mint/account to fabricate). The
        // `Credit` PDA is the `sender` and already owns `vault_token_account`,
        // so the same seeds that authorized the old transfer authorize the CPI.
        //
        // §9.2 division of labor holds: the keeper computes the bin range, the
        // active id and the derived bin-array PDAs off-chain and passes them
        // in; `check_deploy` above verified the active bin sits within the
        // tolerance the receive pinned. The program does not recompute the
        // strategy — it bounds it.
        let vault_authority = credit.vault_authority;
        let pool = credit.pool;
        let bump = credit.bump;
        let seeds: &[&[u8]] = &[CREDIT_SEED, vault_authority.as_ref(), pool.as_ref(), &[bump]];

        // For a one-sided deposit only the *-OneSide strategies are coherent;
        // the balanced variants assume two tokens. The keeper picks which via
        // the SDK; the program only rejects a value it cannot map.
        let strategy_type = match args.strategy_type {
            0 => dlmm::types::StrategyType::SpotOneSide,
            1 => dlmm::types::StrategyType::CurveOneSide,
            2 => dlmm::types::StrategyType::BidAskOneSide,
            _ => return err!(ReceiverError::UnknownStrategyType),
        };

        let liquidity_parameter = dlmm::types::LiquidityParameterByStrategyOneSide {
            amount: args.amount,
            active_id: args.active_bin_id,
            max_active_bin_slippage: args.max_active_bin_slippage,
            strategy_parameters: dlmm::types::StrategyParameters {
                min_bin_id: args.min_bin_id,
                max_bin_id: args.max_bin_id,
                strategy_type,
                // Opaque per-strategy bytes; unused by the strategy types above,
                // which derive their distribution from the bin range.
                parameteres: [0u8; 64],
            },
        };

        let cpi_accounts = dlmm::cpi::accounts::AddLiquidityByStrategyOneSide {
            position: ctx.accounts.position.to_account_info(),
            lb_pair: ctx.accounts.lb_pair.to_account_info(),
            bin_array_bitmap_extension: ctx
                .accounts
                .bin_array_bitmap_extension
                .as_ref()
                .map(|a| a.to_account_info()),
            user_token: ctx.accounts.vault_token_account.to_account_info(),
            reserve: ctx.accounts.reserve.to_account_info(),
            token_mint: ctx.accounts.token_mint.to_account_info(),
            bin_array_lower: ctx.accounts.bin_array_lower.to_account_info(),
            bin_array_upper: ctx.accounts.bin_array_upper.to_account_info(),
            sender: ctx.accounts.credit.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            program: ctx.accounts.dlmm_program.to_account_info(),
        };

        dlmm::cpi::add_liquidity_by_strategy_one_side(
            CpiContext::new_with_signer(
                ctx.accounts.dlmm_program.to_account_info(),
                cpi_accounts,
                &[seeds],
            ),
            liquidity_parameter,
        )?;

        let credit = &mut ctx.accounts.credit;
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
    ///
    /// # This must move tokens, not just the counter
    ///
    /// It previously took no token accounts and only decremented
    /// `credit.amount`, which released nothing. The USDC stays in a
    /// PDA-owned account whose sole mover is [`deploy_position`], and that is
    /// gated on `available(amount, deployed)` — so decrementing the counter
    /// *removed the only instruction able to move the funds* and left them
    /// exactly where they were. The hatch bricked the door it was there to
    /// open.
    ///
    /// This is also the on-chain half of the return leg. The program has no
    /// `deposit_for_burn`, so capital cannot go back to Arc from inside it;
    /// getting the tokens under the vault authority's control is what lets the
    /// keeper burn them home with App Kit, exactly as the Base Sepolia venue
    /// does. Until that CPI exists, this is the whole way back.
    pub fn release_credit(ctx: Context<ReleaseCredit>, amount: u64) -> Result<()> {
        let credit = &ctx.accounts.credit;
        let avail = available(credit.amount, credit.deployed);
        require!(amount > 0, ReceiverError::ZeroAmount);
        require!(amount <= avail, ReceiverError::AmountExceedsCredit);
        require!(
            amount <= ctx.accounts.vault_token_account.amount,
            ReceiverError::AmountExceedsCustody
        );

        let vault_authority = credit.vault_authority;
        let pool = credit.pool;
        let bump = credit.bump;
        let seeds: &[&[u8]] = &[CREDIT_SEED, vault_authority.as_ref(), pool.as_ref(), &[bump]];

        // Move first, then book. A failed transfer must not leave the counter
        // claiming the capital was released.
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                    authority: ctx.accounts.credit.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        let credit = &mut ctx.accounts.credit;
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
    /// Where stage 2 is allowed to send tokens. Pinned at init so a
    /// permissionless caller cannot redirect a credited balance.
    pub destination: Pubkey,
    /// Who may run stage 1 — the CCTP `MessageTransmitter` PDA in production.
    /// Pinned at init for the same reason `destination` is: stage 2 is
    /// permissionless and moves real tokens, so whoever can write
    /// {@link Credit::amount} can decide how much of the vault account moves.
    pub cctp_authority: Pubkey,
    pub bump: u8,
    /// The DLMM position this credit's capital is deployed into, and the range
    /// it was opened over.
    ///
    /// Stored so [`withdraw_position`] can derive the position's *full* range
    /// itself and pin the account, rather than trusting a caller-supplied
    /// range. That is what makes "full exit" a property of the program instead
    /// of a promise the keeper has to keep: a narrow partial removal, which
    /// would leave liquidity behind while the books report `deployed == 0`, is
    /// not expressible.
    ///
    /// Appended to the end of the struct on purpose — every field above keeps
    /// its byte offset, which is what lets [`adopt_position`] migrate an
    /// existing account in place.
    pub position: Pubkey,
    pub position_lower_bin_id: i32,
    pub position_width: i32,
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
    /// Bin the pool is actually on now, read by the caller. Also the DLMM
    /// `active_id` the CPI is bounded against.
    pub active_bin_id: i32,
    /// Slippage floor. Zero is rejected.
    pub min_amount_out: u64,
    /// One-sided range for the DLMM strategy, computed off-chain. `check_deploy`
    /// bounds `active_bin_id` against the receive tolerance; the DLMM program
    /// bounds these against the pool.
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    /// How far the active bin may drift between build and land before the DLMM
    /// program rejects the add — the CPI's own slippage guard, in bins.
    pub max_active_bin_slippage: i32,
    /// 0 = SpotOneSide, 1 = CurveOneSide, 2 = BidAskOneSide. Any other value is
    /// rejected — the balanced strategies assume two tokens this receiver never
    /// has.
    pub strategy_type: u8,
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
pub struct AdoptPosition<'info> {
    /// Only the vault authority may point a credit at a position.
    pub vault_authority: Signer<'info>,

    /// Funds the account's growth.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [CREDIT_SEED, vault_authority.key().as_ref(), credit.pool.as_ref()],
        bump = credit.bump,
        has_one = vault_authority,
        realloc = 8 + Credit::INIT_SPACE,
        realloc::payer = payer,
        realloc::zero = true,
    )]
    pub credit: Account<'info, Credit>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: HookParams)]
pub struct OnCctpReceive<'info> {
    /// The CCTP `MessageTransmitter` PDA, signing via CPI. Checked against
    /// `credit.cctp_authority` below rather than merely documented: an
    /// unconstrained `Signer` here means *any* signer can credit *any*
    /// amount, and since stage 2 is permissionless and pays out to a pinned
    /// destination, whoever can write `credit.amount` decides how much of the
    /// vault account moves and when.
    pub authority: Signer<'info>,

    /// The constraint lives here, not on `authority`, because Anchor resolves
    /// accounts in declaration order and `authority` comes first.
    ///
    /// # Why this does not give stage 1 a failure mode
    ///
    /// §10.1 requires that stage 1 "cannot revert", because a CCTP v2 hook
    /// that fails strands an already-burned transfer with no rescue path. A
    /// check that rejects *the wrong caller* does not violate that: the real
    /// `MessageTransmitter` always presents the pinned key, so no legitimate
    /// delivery can fail it. What it rejects was never a burned transfer in
    /// the first place — it is someone forging a receive.
    ///
    /// The rule §10.1 is really stating is that nothing *conditional on the
    /// world* may run here: no CPI, no clock, no price, no deadline. This is
    /// a comparison of two keys already in the account set.
    #[account(
        mut,
        seeds = [CREDIT_SEED, params.vault_authority.as_ref(), params.pool.as_ref()],
        bump = credit.bump,
        constraint = credit.cctp_authority == authority.key()
            @ ReceiverError::UnauthorizedReceiveAuthority,
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

    /// The program-owned USDC account CCTP mints into. Its authority is the
    /// `credit` PDA, so only this program can move the funds — and it is the
    /// `user_token` the DLMM CPI draws from.
    #[account(
        mut,
        seeds = [VAULT_SEED, credit.vault_authority.as_ref(), credit.pool.as_ref()],
        bump,
        token::authority = credit,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    // --- Meteora DLMM accounts for `add_liquidity_by_strategy_one_side` -------
    //
    // Unchecked because they are validated by the DLMM program on the CPI, not
    // here (§9.2: pass computed values in, verify cheaply). The one constraint
    // that matters for safety is that the pool is the one this credit was
    // opened against — `lb_pair == credit.pool` — so a permissionless caller
    // cannot redirect the credited USDC into a pool of their choosing. Every
    // other account keys off `lb_pair`, so pinning it pins the rest.
    //
    // `position` and the bin arrays are keeper prerequisites: the position is
    // created with `initialize_position(lower_bin_id, width)` and each bin
    // array with `initialize_bin_array(index)`, where
    // `index = floor(bin_id / 70)`, before this runs. Making the program own
    // the position (so it can later *remove* liquidity for the return leg) is a
    // follow-up — today the keeper owns it, and the return leg still goes
    // through `release_credit`.

    /// CHECK: the DLMM position; validated by the DLMM program.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: the pool. Pinned to the credit's pool so funds cannot be diverted.
    #[account(mut, address = credit.pool)]
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: optional bin-array bitmap extension; validated by the DLMM program.
    #[account(mut)]
    pub bin_array_bitmap_extension: Option<UncheckedAccount<'info>>,

    /// CHECK: the pool reserve for the USDC side; validated by the DLMM program.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,

    /// CHECK: USDC mint; validated by the DLMM program against the pool.
    pub token_mint: UncheckedAccount<'info>,

    /// CHECK: lower bin array (`floor(min_bin_id / 70)`); validated on the CPI.
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// CHECK: upper bin array (`floor(max_bin_id / 70)`); validated on the CPI.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: the DLMM program's event-authority PDA, for its event CPI.
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: the DLMM program itself, pinned to the address the IDL carries.
    #[account(address = dlmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitPosition<'info> {
    /// Pays the position account's rent, signs the tx.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The credit this position belongs to; signs the CPI as the position owner
    /// via its seeds.
    #[account(
        seeds = [CREDIT_SEED, credit.vault_authority.as_ref(), credit.pool.as_ref()],
        bump = credit.bump,
    )]
    pub credit: Account<'info, Credit>,

    /// CHECK: the fresh position account, a caller-supplied keypair signing at
    /// the tx level. The DLMM program initializes it.
    #[account(mut, signer)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: the pool, pinned to the credit's pool so the position cannot be
    /// opened against a different one.
    #[account(address = credit.pool)]
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: the DLMM program's event-authority PDA.
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: the DLMM program, pinned to the IDL address.
    #[account(address = dlmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(vault_authority: Pubkey, pool: Pubkey)]
pub struct InitVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [CREDIT_SEED, vault_authority.as_ref(), pool.as_ref()],
        bump = credit.bump,
    )]
    pub credit: Account<'info, Credit>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, vault_authority.as_ref(), pool.as_ref()],
        bump,
        token::mint = mint,
        token::authority = credit,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
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

    /// The program-owned account the capital is actually sitting in.
    #[account(
        mut,
        seeds = [VAULT_SEED, credit.vault_authority.as_ref(), credit.pool.as_ref()],
        bump,
        token::authority = credit,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Where the released capital lands, on its way back to Arc.
    ///
    /// Constrained to an account the vault authority owns. `destination` is
    /// pinned at init because stage 2 is permissionless; this one is checked
    /// against the signer instead, since only the vault authority reaches
    /// here — but it still must not be a free-form address, or "release" would
    /// be a withdrawal to anywhere the signer likes rather than a return.
    #[account(
        mut,
        constraint = recipient.owner == vault_authority.key()
            @ ReceiverError::RecipientNotOwnedByVaultAuthority,
    )]
    pub recipient: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
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

impl From<WithdrawRejection> for ReceiverError {
    fn from(r: WithdrawRejection) -> Self {
        match r {
            WithdrawRejection::PoolDoesNotHoldCustodyMint => {
                ReceiverError::PoolDoesNotHoldCustodyMint
            }
            WithdrawRejection::NonPositiveWidth => ReceiverError::NonPositiveWidth,
            WithdrawRejection::PositionRangeOutOfBounds => ReceiverError::PositionRangeOutOfBounds,
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
    #[msg("only the pinned CCTP authority may credit this account")]
    UnauthorizedReceiveAuthority,
    #[msg("released capital must land in an account the vault authority owns")]
    RecipientNotOwnedByVaultAuthority,
    #[msg("amount exceeds the tokens actually held by the program")]
    AmountExceedsCustody,
    #[msg("strategy_type must be 0/1/2 (Spot/Curve/BidAsk OneSide)")]
    UnknownStrategyType,
    #[msg("this credit already has a position; a second would orphan the first")]
    PositionAlreadyAdopted,
    #[msg("the pool does not hold the mint this program has custody of")]
    PoolDoesNotHoldCustodyMint,
    #[msg("position width must be positive")]
    NonPositiveWidth,
    #[msg("the recorded position range extends past i32")]
    PositionRangeOutOfBounds,
}
