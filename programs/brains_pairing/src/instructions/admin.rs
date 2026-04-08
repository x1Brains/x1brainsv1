// programs/brains_pairing/src/instructions/admin.rs

use anchor_lang::prelude::*;
use crate::{constants::*, errors::PairingError, state::*};

// ── Admin-only context ────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        constraint = admin.key() == ADMIN_WALLET @ PairingError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global_state"],
        bump  = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,
}

pub fn pause_handler(ctx: Context<AdminOnly>) -> Result<()> {
    ctx.accounts.global_state.paused = true;
    msg!("Protocol paused by admin");
    Ok(())
}

pub fn unpause_handler(ctx: Context<AdminOnly>) -> Result<()> {
    ctx.accounts.global_state.paused = false;
    msg!("Protocol unpaused by admin");
    Ok(())
}

// ── Flag wallet ───────────────────────────────────────────────────────────────
#[derive(Accounts)]
#[instruction(target_wallet: Pubkey)]
pub struct FlagWallet<'info> {
    #[account(
        constraint = admin.key() == ADMIN_WALLET @ PairingError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"wallet_state", target_wallet.as_ref()],
        bump  = wallet_state.bump,
    )]
    pub wallet_state: Account<'info, WalletState>,

    pub system_program: Program<'info, System>,
}

pub fn flag_wallet_handler(
    ctx: Context<FlagWallet>,
    target_wallet: Pubkey,
) -> Result<()> {
    ctx.accounts.wallet_state.is_flagged = true;
    msg!("Wallet flagged: {}", target_wallet);
    Ok(())
}

pub fn unflag_wallet_handler(
    ctx: Context<FlagWallet>,
    target_wallet: Pubkey,
) -> Result<()> {
    ctx.accounts.wallet_state.is_flagged = false;
    msg!("Wallet unflagged: {}", target_wallet);
    Ok(())
}
