// programs/brains_farm/src/instructions/admin.rs
// Admin-only instructions: pause/unpause, update_rate, withdraw_rewards.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    TransferChecked, transfer_checked,
};
use crate::{accumulator, constants::*, errors::FarmError, state::*};

// ── Global pause / unpause ────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct GlobalAdmin<'info> {
    #[account(constraint = admin.key() == ADMIN_WALLET @ FarmError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"farm_global"],
        bump   = global_state.bump,
    )]
    pub global_state: Account<'info, FarmGlobal>,
}

pub fn pause_handler(ctx: Context<GlobalAdmin>) -> Result<()> {
    ctx.accounts.global_state.paused = true;
    msg!("Protocol paused");
    Ok(())
}

pub fn unpause_handler(ctx: Context<GlobalAdmin>) -> Result<()> {
    ctx.accounts.global_state.paused = false;
    msg!("Protocol unpaused");
    Ok(())
}

// ── Per-farm pause / unpause ──────────────────────────────────────────────────
#[derive(Accounts)]
pub struct FarmAdmin<'info> {
    #[account(constraint = admin.key() == ADMIN_WALLET @ FarmError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"farm_global"],
        bump  = global_state.bump,
    )]
    pub global_state: Account<'info, FarmGlobal>,

    #[account(
        mut,
        seeds  = [b"farm", farm.lp_mint.as_ref(), farm.reward_mint.as_ref()],
        bump   = farm.bump,
    )]
    pub farm: Account<'info, Farm>,
}

pub fn pause_farm_handler(ctx: Context<FarmAdmin>) -> Result<()> {
    ctx.accounts.farm.paused = true;
    msg!("Farm paused: {}", ctx.accounts.farm.key());
    Ok(())
}

pub fn unpause_farm_handler(ctx: Context<FarmAdmin>) -> Result<()> {
    ctx.accounts.farm.paused = false;
    msg!("Farm unpaused: {}", ctx.accounts.farm.key());
    Ok(())
}

// ── Update emission rate ──────────────────────────────────────────────────────
// Settles accumulator at OLD rate first so existing stakers are fully credited
// for time they experienced the old rate, THEN switches to new rate.
#[derive(Accounts)]
pub struct UpdateRate<'info> {
    #[account(constraint = admin.key() == ADMIN_WALLET @ FarmError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"farm_global"],
        bump  = global_state.bump,
    )]
    pub global_state: Account<'info, FarmGlobal>,

    #[account(
        mut,
        seeds  = [b"farm", farm.lp_mint.as_ref(), farm.reward_mint.as_ref()],
        bump   = farm.bump,
    )]
    pub farm: Account<'info, Farm>,

    #[account(
        address = farm.reward_vault @ FarmError::InvalidAccountData,
        token::mint = farm.reward_mint,
        token::authority = farm,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
}

pub fn update_rate_handler(ctx: Context<UpdateRate>, params: UpdateRateParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(params.new_rate > 0, FarmError::RateZero);
    require!(params.new_rate <= MAX_REWARD_RATE_PER_SEC, FarmError::RateTooHigh);

    // ── M7: rate-change magnitude cap (fat-finger + key-compromise guard) ────
    // Prevents admin from making massive rate changes in a single tx. To reach
    // a 10× target from current rate, admin must call update_rate ~4 times,
    // each visible on-chain. Community has reaction time to notice anomalies.
    // Skip this check when old_rate is 0 (first-time setup / post-depletion).
    let old_rate = ctx.accounts.farm.reward_rate_per_sec;
    if old_rate > 0 {
        let max_up = old_rate
            .checked_mul(MAX_RATE_UP_NUM)
            .ok_or(FarmError::Overflow)?;
        let min_down = old_rate
            .checked_div(MAX_RATE_DOWN_DEN)
            .ok_or(FarmError::Overflow)?;
        require!(params.new_rate <= max_up,   FarmError::RateTooHigh);
        require!(params.new_rate >= min_down, FarmError::RateTooHigh);
    }

    // Settle at OLD rate before changing
    accumulator::settle_farm(
        &mut ctx.accounts.farm,
        ctx.accounts.reward_vault.amount,
        now,
    )?;

    ctx.accounts.farm.reward_rate_per_sec = params.new_rate;

    msg!("Rate updated: {} → {} (scaled)", old_rate, params.new_rate);
    Ok(())
}

// ── Withdraw un-earmarked rewards ─────────────────────────────────────────────
// Admin pulls reward tokens from vault to treasury. Refuses if the withdrawal
// would touch tokens owed to active stakers (total_pending_rewards).
#[derive(Accounts)]
pub struct WithdrawRewards<'info> {
    #[account(
        mut,
        constraint = admin.key() == ADMIN_WALLET @ FarmError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"farm_global"],
        bump  = global_state.bump,
    )]
    pub global_state: Account<'info, FarmGlobal>,

    #[account(
        mut,
        seeds  = [b"farm", farm.lp_mint.as_ref(), farm.reward_mint.as_ref()],
        bump   = farm.bump,
    )]
    pub farm: Account<'info, Farm>,

    #[account(address = farm.reward_mint @ FarmError::RewardMintMismatch)]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        address = farm.reward_vault @ FarmError::InvalidAccountData,
        token::mint          = reward_mint,
        token::authority     = farm,
        token::token_program = token_program,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint          = reward_mint,
        associated_token::authority     = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_reward_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: hardcoded treasury
    #[account(
        constraint = treasury.key() == TREASURY_WALLET @ FarmError::InvalidTreasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn withdraw_rewards_handler(
    ctx: Context<WithdrawRewards>,
    params: WithdrawRewardsParams,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Settle first so earmark is current
    accumulator::settle_farm(
        &mut ctx.accounts.farm,
        ctx.accounts.reward_vault.amount,
        now,
    )?;

    // Withdrawable = vault.balance - total_pending_rewards
    let withdrawable = ctx.accounts.reward_vault.amount
        .saturating_sub(ctx.accounts.farm.total_pending_rewards);

    require!(params.amount <= withdrawable, FarmError::RewardsEarmarked);
    require!(params.amount > 0, FarmError::ZeroAmount);

    // Transfer vault → treasury (PDA signs)
    let lp_mint_key     = ctx.accounts.farm.lp_mint;
    let reward_mint_key = ctx.accounts.farm.reward_mint;
    let farm_bump       = ctx.accounts.farm.bump;
    let farm_seeds: &[&[u8]] = &[
        b"farm",
        lp_mint_key.as_ref(),
        reward_mint_key.as_ref(),
        std::slice::from_ref(&farm_bump),
    ];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from:      ctx.accounts.reward_vault.to_account_info(),
                mint:      ctx.accounts.reward_mint.to_account_info(),
                to:        ctx.accounts.treasury_reward_ata.to_account_info(),
                authority: ctx.accounts.farm.to_account_info(),
            },
            &[farm_seeds],
        ),
        params.amount,
        ctx.accounts.reward_mint.decimals,
    )?;

    msg!("Admin withdrew {} rewards to treasury", params.amount);
    Ok(())
}
