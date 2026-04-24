// programs/brains_farm/src/instructions/close_farm.rs
// Admin permanently closes a farm. Requires:
//   - No active stakers (total_staked == 0, total_effective == 0)
//   - Reward vault is empty (or admin has withdrawn all un-earmarked surplus)
//
// After close, farm cannot be used for any operation. Reward vault and LP vault
// PDAs can be closed separately by admin to reclaim rent if desired.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use crate::{constants::*, errors::FarmError, state::*};

#[derive(Accounts)]
pub struct CloseFarm<'info> {
    #[account(
        mut,
        constraint = admin.key() == ADMIN_WALLET @ FarmError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"farm_global"],
        bump   = global_state.bump,
    )]
    pub global_state: Account<'info, FarmGlobal>,

    #[account(
        mut,
        seeds  = [b"farm", farm.lp_mint.as_ref(), farm.reward_mint.as_ref()],
        bump   = farm.bump,
    )]
    pub farm: Account<'info, Farm>,

    #[account(
        address = farm.lp_vault @ FarmError::InvalidAccountData,
        token::mint = farm.lp_mint,
        token::authority = farm,
    )]
    pub lp_vault:     InterfaceAccount<'info, TokenAccount>,
    #[account(
        address = farm.reward_vault @ FarmError::InvalidAccountData,
        token::mint = farm.reward_mint,
        token::authority = farm,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
}

pub fn handler(ctx: Context<CloseFarm>) -> Result<()> {
    require!(
        ctx.accounts.farm.total_staked == 0 && ctx.accounts.farm.total_effective == 0,
        FarmError::FarmHasStakers
    );
    require!(
        ctx.accounts.lp_vault.amount == 0,
        FarmError::FarmHasStakers
    );
    require!(
        ctx.accounts.reward_vault.amount == 0,
        FarmError::VaultNotEmpty
    );

    ctx.accounts.farm.closed = true;

    let gs = &mut ctx.accounts.global_state;
    gs.active_farms = gs.active_farms.saturating_sub(1);

    msg!("Farm closed permanently: {}", ctx.accounts.farm.key());

    Ok(())
}
