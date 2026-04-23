// programs/brains_farm/src/instructions/initialize_global.rs
// One-time: creates the FarmGlobal singleton. Admin-only.

use anchor_lang::prelude::*;
use crate::{constants::*, errors::FarmError, state::FarmGlobal};

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(
        mut,
        constraint = admin.key() == ADMIN_WALLET @ FarmError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        init,
        seeds  = [b"farm_global"],
        bump,
        payer  = admin,
        space  = FarmGlobal::LEN,
    )]
    pub global_state: Account<'info, FarmGlobal>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeGlobal>) -> Result<()> {
    let gs = &mut ctx.accounts.global_state;
    gs.admin           = ctx.accounts.admin.key();
    gs.treasury        = TREASURY_WALLET;
    gs.total_farms     = 0;
    gs.active_farms    = 0;
    gs.total_positions = 0;
    gs.total_fee_xnt   = 0;
    gs.paused          = false;
    gs.is_locked       = false;
    gs.bump            = ctx.bumps.global_state;

    msg!("X1 Brains Farm Protocol initialized");
    msg!("Admin:    {}", gs.admin);
    msg!("Treasury: {}", gs.treasury);

    Ok(())
}
