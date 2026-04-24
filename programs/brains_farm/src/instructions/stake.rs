// programs/brains_farm/src/instructions/stake.rs
// Open a new stake position. Transfers LP → lp_vault, creates StakePosition PDA.
// Charges 0.005 XNT flat fee to treasury. Respects farm pause + global pause.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    TransferChecked, transfer_checked,
};
use anchor_spl::token_2022_extensions::transfer_fee::{
    transfer_checked_with_fee, TransferCheckedWithFee,
};
use crate::{accumulator, constants::*, errors::FarmError, state::*};

#[derive(Accounts)]
#[instruction(params: StakeParams)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"farm_global"],
        bump   = global_state.bump,
        constraint = !global_state.paused    @ FarmError::Paused,
        constraint = !global_state.is_locked @ FarmError::Reentrancy,
    )]
    pub global_state: Box<Account<'info, FarmGlobal>>,

    #[account(
        mut,
        seeds  = [b"farm", farm.lp_mint.as_ref(), farm.reward_mint.as_ref()],
        bump   = farm.bump,
        constraint = !farm.paused  @ FarmError::FarmPaused,
        constraint = !farm.closed  @ FarmError::FarmClosed,
    )]
    pub farm: Box<Account<'info, Farm>>,

    #[account(
        address = farm.lp_mint @ FarmError::LpMintMismatch,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint          = lp_mint,
        associated_token::authority     = owner,
        associated_token::token_program = lp_token_program,
    )]
    pub owner_lp_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        address = farm.lp_vault @ FarmError::InvalidAccountData,
        token::mint          = lp_mint,
        token::authority     = farm,
        token::token_program = lp_token_program,
    )]
    pub lp_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    // Reward vault — needed to read balance for accumulator cap
    #[account(
        address = farm.reward_vault @ FarmError::InvalidAccountData,
        token::mint = farm.reward_mint,
        token::authority = farm,
    )]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        seeds = [
            b"position",
            owner.key().as_ref(),
            farm.key().as_ref(),
            &params.nonce.to_le_bytes(),
        ],
        bump,
        payer  = owner,
        space  = StakePosition::LEN,
    )]
    pub position: Box<Account<'info, StakePosition>>,

    /// CHECK: hardcoded treasury — collects XNT fee
    #[account(
        mut,
        constraint = treasury.key() == TREASURY_WALLET @ FarmError::InvalidTreasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub lp_token_program: Interface<'info, TokenInterface>,
    pub system_program:   Program<'info, System>,
    pub rent:             Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<Stake>, params: StakeParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.global_state.is_locked = true;

    // ── Input validation (pre-transfer, cheap reject) ─────────────────────────
    require!(params.amount >= MIN_STAKE_RAW, FarmError::StakeTooSmall);
    // Bound the nonce to MAX_POSITIONS_PER_USER_PER_FARM. This caps the PDA
    // nonce space a single (user, farm) pair can use, preventing any user from
    // opening unbounded positions. Closing a position frees its nonce for reuse
    // (the PDA becomes reusable once rent is swept). In practice this is a
    // DoS soft-limit — spam is already deterred by STAKE_FEE_XNT_LAMPORTS.
    require!(
        params.nonce < MAX_POSITIONS_PER_USER_PER_FARM,
        FarmError::TooManyPositions
    );

    // ── Settle farm accumulator BEFORE mutating TVL ───────────────────────────
    accumulator::settle_farm(
        &mut ctx.accounts.farm,
        ctx.accounts.reward_vault.amount,
        now,
    )?;

    // ── Collect stake fee → treasury (XNT lamports) ───────────────────────────
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to:   ctx.accounts.treasury.to_account_info(),
            },
        ),
        STAKE_FEE_XNT_LAMPORTS,
    )?;

    // ── Transfer LP tokens → lp_vault (with Token-2022 awareness) ─────────────
    // SECURITY: we snapshot the vault balance before and after the transfer,
    // then use the delta as the "actually received" amount. This guards against
    // fee-on-transfer LP mints — where `params.amount` leaves the user's wallet
    // but `params.amount - fee` arrives in the vault. Crediting the user with
    // `params.amount` in that case would let them withdraw more than the vault
    // holds, draining future stakers' positions.
    let vault_before = ctx.accounts.lp_vault.amount;

    let is_token_2022 = ctx.accounts.lp_token_program.key()
        == anchor_spl::token_2022::spl_token_2022::id();

    if is_token_2022 {
        let transfer_fee = {
            use anchor_spl::token_2022::spl_token_2022::{
                extension::{BaseStateWithExtensions, StateWithExtensions, transfer_fee::TransferFeeConfig},
                state::Mint as SplMint,
            };
            let mint_info = ctx.accounts.lp_mint.to_account_info();
            let mint_data = mint_info.try_borrow_data()?;
            let mint_state = StateWithExtensions::<SplMint>::unpack(&mint_data)
                .map_err(|_| FarmError::InvalidAccountData)?;
            if let Ok(fee_config) = mint_state.get_extension::<TransferFeeConfig>() {
                let epoch = Clock::get()?.epoch;
                fee_config.get_epoch_fee(epoch).calculate_fee(params.amount).unwrap_or(0)
            } else {
                0u64
            }
        };

        transfer_checked_with_fee(
            CpiContext::new(
                ctx.accounts.lp_token_program.to_account_info(),
                TransferCheckedWithFee {
                    token_program_id: ctx.accounts.lp_token_program.to_account_info(),
                    source:           ctx.accounts.owner_lp_ata.to_account_info(),
                    mint:             ctx.accounts.lp_mint.to_account_info(),
                    destination:      ctx.accounts.lp_vault.to_account_info(),
                    authority:        ctx.accounts.owner.to_account_info(),
                },
            ),
            params.amount,
            ctx.accounts.lp_mint.decimals,
            transfer_fee,
        )?;
    } else {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.lp_token_program.to_account_info(),
                TransferChecked {
                    from:      ctx.accounts.owner_lp_ata.to_account_info(),
                    mint:      ctx.accounts.lp_mint.to_account_info(),
                    to:        ctx.accounts.lp_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            params.amount,
            ctx.accounts.lp_mint.decimals,
        )?;
    }

    // Reload to get post-transfer vault balance, then compute actual received.
    // For ordinary LP mints without transfer fees, staked_raw == params.amount.
    // For fee-on-transfer mints, staked_raw == params.amount - fee, matching
    // what the vault actually holds.
    ctx.accounts.lp_vault.reload()?;
    let vault_after = ctx.accounts.lp_vault.amount;
    let staked_raw = vault_after
        .checked_sub(vault_before)
        .ok_or(FarmError::Overflow)?;

    // Enforce minimum against the actual received amount (not params.amount).
    require!(staked_raw >= MIN_STAKE_RAW, FarmError::StakeTooSmall);

    // Compute effective_amount = staked × multiplier_bps / BPS_DENOMINATOR
    let multiplier_bps = params.lock_type.multiplier_bps();
    let effective = (staked_raw as u128)
        .checked_mul(multiplier_bps as u128)
        .ok_or(FarmError::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(FarmError::Overflow)? as u64;

    // ── Initialize position ──────────────────────────────────────────────────
    let lock_duration = params.lock_type.duration_secs();
    let pos = &mut ctx.accounts.position;
    pos.owner             = ctx.accounts.owner.key();
    pos.farm              = ctx.accounts.farm.key();
    pos.nonce             = params.nonce;
    pos.amount            = staked_raw;
    pos.effective_amount  = effective;
    pos.lock_type         = params.lock_type;
    pos.reward_debt       = ctx.accounts.farm.acc_reward_per_share;
    pos.pending_rewards   = 0;
    pos.start_ts          = now;
    pos.grace_end_ts      = now.checked_add(GRACE_PERIOD_SECS).ok_or(FarmError::Overflow)?;
    pos.unlock_ts         = now.checked_add(lock_duration).ok_or(FarmError::Overflow)?;
    pos.lock_duration     = lock_duration;
    pos.last_claim_ts     = now;
    pos.bump              = ctx.bumps.position;

    // ── Update farm TVL ───────────────────────────────────────────────────────
    let farm = &mut ctx.accounts.farm;
    farm.total_staked    = farm.total_staked   .checked_add(staked_raw).ok_or(FarmError::Overflow)?;
    farm.total_effective = farm.total_effective.checked_add(effective) .ok_or(FarmError::Overflow)?;

    // ── Update global stats ──────────────────────────────────────────────────
    let gs = &mut ctx.accounts.global_state;
    gs.total_positions = gs.total_positions.checked_add(1).ok_or(FarmError::Overflow)?;
    gs.total_fee_xnt   = gs.total_fee_xnt  .checked_add(STAKE_FEE_XNT_LAMPORTS).ok_or(FarmError::Overflow)?;

    msg!("Staked {} LP ({} effective) lock={:?} nonce={} unlock={}",
        staked_raw, effective, params.lock_type, params.nonce, pos.unlock_ts);

    ctx.accounts.global_state.is_locked = false;
    Ok(())
}
