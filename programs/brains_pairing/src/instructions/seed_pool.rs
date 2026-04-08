// programs/brains_pairing/src/instructions/seed_pool.rs

use anchor_lang::prelude::*;
use crate::{constants::*, errors::PairingError, state::*};

#[derive(Accounts)]
#[instruction(params: SeedPoolParams)]
pub struct SeedPoolRecord<'info> {
    #[account(
        mut,
        constraint = admin.key() == ADMIN_WALLET @ PairingError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"global_state"],
        bump  = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        seeds  = [b"pool_record", params.pool_address.as_ref()],
        bump,
        payer  = admin,
        space  = 8 + 274,
    )]
    pub pool_record: Account<'info, PoolRecord>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SeedPoolRecord>, params: SeedPoolParams) -> Result<()> {
    let pool_record          = &mut ctx.accounts.pool_record;
    pool_record.pool_address = params.pool_address;
    pool_record.lp_mint      = params.lp_mint;
    pool_record.token_a_mint = params.token_a_mint;
    pool_record.token_b_mint = params.token_b_mint;
    pool_record.sym_a        = params.sym_a;
    pool_record.sym_b        = params.sym_b;
    pool_record.burn_bps     = 0;
    pool_record.lp_burned    = 0;
    pool_record.lp_treasury  = 0;
    pool_record.lp_to_user_a = 0;
    pool_record.lp_to_user_b = 0;
    pool_record.creator_a    = ADMIN_WALLET;
    pool_record.creator_b    = ADMIN_WALLET;
    pool_record.usd_val      = 0;
    pool_record.created_at   = Clock::get()?.unix_timestamp;
    pool_record.seeded       = true;
    pool_record.bump         = ctx.bumps.pool_record;

    msg!("Pool record seeded: {}", params.pool_address);
    Ok(())
}
