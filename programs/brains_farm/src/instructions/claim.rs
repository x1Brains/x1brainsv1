// programs/brains_farm/src/instructions/claim.rs
// Claim accrued rewards. Position stays open. 24h cooldown between claims.

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
#[instruction(params: ClaimParams)]
pub struct Claim<'info> {
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
    )]
    pub farm: Box<Account<'info, Farm>>,

    #[account(
        mut,
        seeds = [
            b"position",
            owner.key().as_ref(),
            farm.key().as_ref(),
            &params.nonce.to_le_bytes(),
        ],
        bump = position.bump,
        constraint = position.owner == owner.key() @ FarmError::NotPositionOwner,
        constraint = position.farm  == farm.key()  @ FarmError::WrongFarm,
    )]
    pub position: Box<Account<'info, StakePosition>>,

    #[account(
        address = farm.reward_mint @ FarmError::RewardMintMismatch,
    )]
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint          = reward_mint,
        associated_token::authority     = owner,
        associated_token::token_program = reward_token_program,
    )]
    pub owner_reward_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        address = farm.reward_vault @ FarmError::InvalidAccountData,
        token::mint          = reward_mint,
        token::authority     = farm,
        token::token_program = reward_token_program,
    )]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub reward_token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Claim>, _params: ClaimParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.global_state.is_locked = true;

    // ── Grace-period guard ────────────────────────────────────────────────────
    // Claim is not permitted during the 3-day grace window. This closes the
    // grace-farming loophole: without this check, a user could stake → wait 24h
    // → claim → wait 24h → claim → grace-exit at day 2.9, capturing ~48h of
    // rewards despite the "grace forfeits rewards" policy advertised on unstake.
    // Post-grace, claim works normally as a way to pull accrued rewards without
    // closing the position.
    require!(now > ctx.accounts.position.grace_end_ts, FarmError::ClaimTooSoon);

    // ── 24h cooldown check ────────────────────────────────────────────────────
    let next_claim_allowed = ctx.accounts.position.last_claim_ts
        .checked_add(CLAIM_COOLDOWN_SECS)
        .ok_or(FarmError::Overflow)?;
    require!(now >= next_claim_allowed, FarmError::ClaimTooSoon);

    // ── Settle farm + credit position ─────────────────────────────────────────
    accumulator::settle_farm(
        &mut ctx.accounts.farm,
        ctx.accounts.reward_vault.amount,
        now,
    )?;
    accumulator::credit_position(&mut ctx.accounts.position, &ctx.accounts.farm)?;

    let to_claim = ctx.accounts.position.pending_rewards;
    require!(to_claim > 0, FarmError::NothingToClaim);

    // ── Transfer rewards from vault → owner ───────────────────────────────────
    // Farm PDA signs as vault authority.
    let lp_mint_key     = ctx.accounts.farm.lp_mint;
    let reward_mint_key = ctx.accounts.farm.reward_mint;
    let farm_bump       = ctx.accounts.farm.bump;
    let farm_seeds: &[&[u8]] = &[
        b"farm",
        lp_mint_key.as_ref(),
        reward_mint_key.as_ref(),
        std::slice::from_ref(&farm_bump),
    ];
    let signer = &[farm_seeds];

    let is_token_2022 = ctx.accounts.reward_token_program.key()
        == anchor_spl::token_2022::spl_token_2022::id();

    if is_token_2022 {
        let transfer_fee = {
            use anchor_spl::token_2022::spl_token_2022::{
                extension::{BaseStateWithExtensions, StateWithExtensions, transfer_fee::TransferFeeConfig},
                state::Mint as SplMint,
            };
            let mint_info = ctx.accounts.reward_mint.to_account_info();
            let mint_data = mint_info.try_borrow_data()?;
            let mint_state = StateWithExtensions::<SplMint>::unpack(&mint_data)
                .map_err(|_| FarmError::InvalidAccountData)?;
            if let Ok(fee_config) = mint_state.get_extension::<TransferFeeConfig>() {
                let epoch = Clock::get()?.epoch;
                fee_config.get_epoch_fee(epoch).calculate_fee(to_claim).unwrap_or(0)
            } else { 0u64 }
        };

        transfer_checked_with_fee(
            CpiContext::new_with_signer(
                ctx.accounts.reward_token_program.to_account_info(),
                TransferCheckedWithFee {
                    token_program_id: ctx.accounts.reward_token_program.to_account_info(),
                    source:           ctx.accounts.reward_vault.to_account_info(),
                    mint:             ctx.accounts.reward_mint.to_account_info(),
                    destination:      ctx.accounts.owner_reward_ata.to_account_info(),
                    authority:        ctx.accounts.farm.to_account_info(),
                },
                signer,
            ),
            to_claim,
            ctx.accounts.reward_mint.decimals,
            transfer_fee,
        )?;
    } else {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.reward_token_program.to_account_info(),
                TransferChecked {
                    from:      ctx.accounts.reward_vault.to_account_info(),
                    mint:      ctx.accounts.reward_mint.to_account_info(),
                    to:        ctx.accounts.owner_reward_ata.to_account_info(),
                    authority: ctx.accounts.farm.to_account_info(),
                },
                signer,
            ),
            to_claim,
            ctx.accounts.reward_mint.decimals,
        )?;
    }

    // ── Update state ──────────────────────────────────────────────────────────
    let pos = &mut ctx.accounts.position;
    pos.pending_rewards = 0;
    pos.last_claim_ts = now;

    let farm = &mut ctx.accounts.farm;
    farm.total_pending_rewards = farm.total_pending_rewards
        .checked_sub(to_claim)
        .ok_or(FarmError::Overflow)?;

    msg!("Claimed {} rewards (nonce={})", to_claim, ctx.accounts.position.nonce);

    ctx.accounts.global_state.is_locked = false;
    Ok(())
}
