// programs/brains_pairing/src/instructions/initialize.rs

use anchor_lang::prelude::*;
use crate::{constants::*, errors::PairingError, state::GlobalState};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        mut,
        constraint = admin.key() == ADMIN_WALLET @ PairingError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        init,
        seeds  = [b"global_state"],
        bump,
        payer  = admin,
        space  = 8 + 107,
    )]
    pub global_state: Account<'info, GlobalState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let gs               = &mut ctx.accounts.global_state;
    gs.admin             = ctx.accounts.admin.key();
    gs.treasury          = TREASURY_WALLET;
    gs.total_fee_xnt     = 0;
    gs.total_listings    = 0;
    gs.total_pools_created = 0;
    gs.open_listings     = 0;
    gs.paused            = false;
    gs.is_locked         = false;
    gs.bump              = ctx.bumps.global_state;

    msg!("X1 Brains Pairing Protocol initialized");
    msg!("Admin:    {}", gs.admin);
    msg!("Treasury: {}", gs.treasury);

    Ok(())
}
