// programs/brains_farm/src/instructions/unstake.rs
// Close a position. Three paths:
//   1. Grace exit (within 3 days of stake start): full LP + pending rewards
//   2. Mature exit (past unlock_ts): full LP + pending rewards
//   3. Early exit (past grace, before maturity): LP minus penalty%, rewards forfeited
//
// Penalty taken from LP principal goes to treasury. Forfeited rewards stay in
// vault and decrement total_pending_rewards so they become emittable again,
// effectively boosting APR for remaining stakers.

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
#[instruction(params: UnstakeParams)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"farm_global"],
        bump   = global_state.bump,
        constraint = !global_state.is_locked @ FarmError::Reentrancy,
        // NOTE: unstake works even when paused — users always get funds back
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
        close = owner,
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

    #[account(address = farm.lp_mint     @ FarmError::LpMintMismatch)]
    pub lp_mint:     Box<InterfaceAccount<'info, Mint>>,
    #[account(address = farm.reward_mint @ FarmError::RewardMintMismatch)]
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint          = lp_mint,
        associated_token::authority     = owner,
        associated_token::token_program = lp_token_program,
    )]
    pub owner_lp_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint          = reward_mint,
        associated_token::authority     = owner,
        associated_token::token_program = reward_token_program,
    )]
    pub owner_reward_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = farm.lp_vault     @ FarmError::InvalidAccountData)]
    pub lp_vault:     Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = farm.reward_vault @ FarmError::InvalidAccountData)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    // Treasury LP ATA — receives penalty LP.
    // SECURITY: validated via associated_token constraints so an attacker can't
    // substitute their own ATA as the "treasury" and nullify the early-exit
    // penalty. Derivation-locked to (lp_mint, TREASURY_WALLET).
    #[account(
        mut,
        associated_token::mint          = lp_mint,
        associated_token::authority     = treasury,
        associated_token::token_program = lp_token_program,
    )]
    pub treasury_lp_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: hardcoded treasury (owner of treasury_lp_ata)
    #[account(constraint = treasury.key() == TREASURY_WALLET @ FarmError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,

    // Optional LB balance check for penalty discount.
    // Pass the user's LB ATA, or program_id as sentinel for "no LB".
    /// CHECK: read-only, balance checked at offset 64
    pub owner_lb_account: UncheckedAccount<'info>,

    pub lp_token_program:     Interface<'info, TokenInterface>,
    pub reward_token_program: Interface<'info, TokenInterface>,
    pub system_program:       Program<'info, System>,
}

pub fn handler(ctx: Context<Unstake>, _params: UnstakeParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.global_state.is_locked = true;

    // ── Settle + credit position ──────────────────────────────────────────────
    accumulator::settle_farm(
        &mut ctx.accounts.farm,
        ctx.accounts.reward_vault.amount,
        now,
    )?;
    accumulator::credit_position(&mut ctx.accounts.position, &ctx.accounts.farm)?;

    // ── Read LB balance for penalty discount ──────────────────────────────────
    let lb_balance: u64 = {
        let acc = &ctx.accounts.owner_lb_account;
        // Sentinel: if they pass the program id, treat as zero balance
        if acc.key() == *ctx.program_id {
            0
        } else {
            // Verify the account is for LB mint. Read mint at offset 0..32.
            let data = acc.try_borrow_data()?;
            if data.len() >= 72 {
                let mint_bytes: [u8; 32] = data[0..32]
                    .try_into()
                    .map_err(|_| FarmError::InvalidAccountData)?;
                let acc_mint = Pubkey::new_from_array(mint_bytes);
                if acc_mint == LB_MINT {
                    accumulator::read_token_account_balance(acc)?
                } else {
                    0
                }
            } else {
                0
            }
        }
    };

    // ── Compute penalty & reward payout ───────────────────────────────────────
    let position_amount   = ctx.accounts.position.amount;
    let pending_rewards   = ctx.accounts.position.pending_rewards;

    let (penalty_bps, penalty_raw) = accumulator::calc_early_exit_penalty(
        &ctx.accounts.position,
        lb_balance,
        now,
    )?;

    let is_early_exit = penalty_bps > 0;
    let lp_to_owner = position_amount.checked_sub(penalty_raw).ok_or(FarmError::Overflow)?;
    let reward_to_owner = if is_early_exit {
        0 // forfeit rewards on early exit
    } else {
        pending_rewards
    };

    // ── Transfer LP: vault → owner (minus penalty) ────────────────────────────
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

    let is_lp_t22 = ctx.accounts.lp_token_program.key()
        == anchor_spl::token_2022::spl_token_2022::id();

    // LP to owner
    if lp_to_owner > 0 {
        transfer_vault_tokens(
            &ctx.accounts.lp_token_program,
            &ctx.accounts.lp_vault.to_account_info(),
            &ctx.accounts.lp_mint.to_account_info(),
            &ctx.accounts.owner_lp_ata.to_account_info(),
            &ctx.accounts.farm.to_account_info(),
            lp_to_owner,
            ctx.accounts.lp_mint.decimals,
            is_lp_t22,
            signer,
        )?;
    }

    // LP penalty → treasury_lp_ata
    if penalty_raw > 0 {
        transfer_vault_tokens(
            &ctx.accounts.lp_token_program,
            &ctx.accounts.lp_vault.to_account_info(),
            &ctx.accounts.lp_mint.to_account_info(),
            &ctx.accounts.treasury_lp_ata.to_account_info(),
            &ctx.accounts.farm.to_account_info(),
            penalty_raw,
            ctx.accounts.lp_mint.decimals,
            is_lp_t22,
            signer,
        )?;
    }

    // Reward payout (only on non-early exit)
    if reward_to_owner > 0 {
        let is_reward_t22 = ctx.accounts.reward_token_program.key()
            == anchor_spl::token_2022::spl_token_2022::id();
        transfer_vault_tokens(
            &ctx.accounts.reward_token_program,
            &ctx.accounts.reward_vault.to_account_info(),
            &ctx.accounts.reward_mint.to_account_info(),
            &ctx.accounts.owner_reward_ata.to_account_info(),
            &ctx.accounts.farm.to_account_info(),
            reward_to_owner,
            ctx.accounts.reward_mint.decimals,
            is_reward_t22,
            signer,
        )?;
    }

    // ── Update farm state ─────────────────────────────────────────────────────
    let position_effective = ctx.accounts.position.effective_amount;
    let farm = &mut ctx.accounts.farm;

    farm.total_staked    = farm.total_staked   .checked_sub(position_amount)  .ok_or(FarmError::Overflow)?;
    farm.total_effective = farm.total_effective.checked_sub(position_effective).ok_or(FarmError::Overflow)?;

    // Decrement total_pending_rewards by position's pending_rewards.
    // If paid out: the tokens left the vault, earmark is gone.
    // If forfeited: the tokens stay in the vault, but are no longer earmarked —
    //   they become emittable again for remaining stakers (boosting APR).
    farm.total_pending_rewards = farm.total_pending_rewards
        .checked_sub(pending_rewards)
        .ok_or(FarmError::Overflow)?;

    msg!(
        "Unstake: {} LP returned, {} LP penalty ({}bps), {} rewards paid ({} forfeited)",
        lp_to_owner, penalty_raw, penalty_bps, reward_to_owner,
        if is_early_exit { pending_rewards } else { 0 }
    );

    ctx.accounts.global_state.is_locked = false;
    Ok(())
}

/// Helper: transfer tokens out of a PDA-owned vault, with Token-2022 awareness.
#[allow(clippy::too_many_arguments)]
fn transfer_vault_tokens<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault:         &AccountInfo<'info>,
    mint:          &AccountInfo<'info>,
    destination:   &AccountInfo<'info>,
    authority:     &AccountInfo<'info>,
    amount:        u64,
    decimals:      u8,
    is_token_2022: bool,
    signer:        &[&[&[u8]]],
) -> Result<()> {
    if is_token_2022 {
        let transfer_fee = {
            use anchor_spl::token_2022::spl_token_2022::{
                extension::{BaseStateWithExtensions, StateWithExtensions, transfer_fee::TransferFeeConfig},
                state::Mint as SplMint,
            };
            let mint_data = mint.try_borrow_data()?;
            let mint_state = StateWithExtensions::<SplMint>::unpack(&mint_data)
                .map_err(|_| FarmError::InvalidAccountData)?;
            if let Ok(fee_config) = mint_state.get_extension::<TransferFeeConfig>() {
                let epoch = Clock::get()?.epoch;
                fee_config.get_epoch_fee(epoch).calculate_fee(amount).unwrap_or(0)
            } else { 0u64 }
        };
        transfer_checked_with_fee(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                TransferCheckedWithFee {
                    token_program_id: token_program.to_account_info(),
                    source:           vault.clone(),
                    mint:             mint.clone(),
                    destination:      destination.clone(),
                    authority:        authority.clone(),
                },
                signer,
            ),
            amount,
            decimals,
            transfer_fee,
        )?;
    } else {
        transfer_checked(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                TransferChecked {
                    from:      vault.clone(),
                    mint:      mint.clone(),
                    to:        destination.clone(),
                    authority: authority.clone(),
                },
                signer,
            ),
            amount,
            decimals,
        )?;
    }
    Ok(())
}
