// programs/brains_farm/src/instructions/force_mature_position.rs
// ═══════════════════════════════════════════════════════════════════════════
// ADMIN TEST TOOL — FEATURE-GATED BEHIND `admin-test-tools`
// ═══════════════════════════════════════════════════════════════════════════
//
// This instruction ONLY EXISTS in the compiled binary when the program is
// built with `--features admin-test-tools`. Mainnet binaries built WITHOUT
// the feature flag literally do not contain this code — it cannot be called.
//
// Purpose: let the admin test the "mature exit" code path without waiting
// for real time. Sets a single position's unlock_ts to now, so when the
// user (or admin as the user) calls unstake, they hit the matured branch.
//
// Usage workflow for test farms:
//   1. Build with feature:  cargo build-sbf --features admin-test-tools
//   2. Deploy to test program ID
//   3. Create test farm, stake test positions
//   4. Call force_mature_position(nonce) to test matured unstake path
//   5. For prod: rebuild WITHOUT feature, redeploy.
//
// Security: gated by ADMIN_WALLET constraint. Even with feature enabled,
// non-admin callers cannot invoke it.

#[cfg(feature = "admin-test-tools")]
use anchor_lang::prelude::*;
#[cfg(feature = "admin-test-tools")]
use crate::{constants::*, errors::FarmError, state::*};

#[cfg(feature = "admin-test-tools")]
#[derive(Accounts)]
#[instruction(nonce: u32, target_owner: Pubkey)]
pub struct ForceMaturePosition<'info> {
    #[account(constraint = admin.key() == ADMIN_WALLET @ FarmError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"farm_global"],
        bump  = global_state.bump,
    )]
    pub global_state: Account<'info, FarmGlobal>,

    #[account(
        seeds = [b"farm", farm.lp_mint.as_ref(), farm.reward_mint.as_ref()],
        bump  = farm.bump,
    )]
    pub farm: Account<'info, Farm>,

    #[account(
        mut,
        seeds = [
            b"position",
            target_owner.as_ref(),
            farm.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump = position.bump,
    )]
    pub position: Account<'info, StakePosition>,
}

#[cfg(feature = "admin-test-tools")]
pub fn handler(
    ctx: Context<ForceMaturePosition>,
    _nonce: u32,
    _target_owner: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let pos = &mut ctx.accounts.position;
    pos.unlock_ts    = now;
    pos.grace_end_ts = now;

    msg!(
        "⚠️  TEST TOOL: position {} force-matured at {} (was unlocking at {})",
        pos.nonce, now, pos.unlock_ts
    );
    Ok(())
}
