// programs/brains_farm/src/instructions/create_farm.rs
// Admin creates a new farm with LP provenance validation.
// Computes initial reward_rate_per_sec = seed_amount × ACC_PRECISION / target_duration_secs.
// Admin must separately call fund_farm to deposit the actual seed tokens.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::{constants::*, errors::FarmError, state::*};

#[derive(Accounts)]
#[instruction(params: CreateFarmParams)]
pub struct CreateFarm<'info> {
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

    pub lp_mint:     InterfaceAccount<'info, Mint>,
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        seeds  = [b"farm", lp_mint.key().as_ref(), reward_mint.key().as_ref()],
        bump,
        payer  = admin,
        space  = Farm::LEN,
    )]
    pub farm: Account<'info, Farm>,

    // LP vault — holds staked LP tokens
    #[account(
        init,
        seeds  = [b"lp_vault", farm.key().as_ref()],
        bump,
        payer  = admin,
        token::mint          = lp_mint,
        token::authority     = farm,
        token::token_program = lp_token_program,
    )]
    pub lp_vault: InterfaceAccount<'info, TokenAccount>,

    // Reward vault — holds reward tokens
    #[account(
        init,
        seeds  = [b"reward_vault", farm.key().as_ref()],
        bump,
        payer  = admin,
        token::mint          = reward_mint,
        token::authority     = farm,
        token::token_program = reward_token_program,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    // ── LP provenance validation accounts ─────────────────────────────────────
    // One of these is used based on params.source:
    //   BrainsPairing: pool_record must exist in brains_pairing with matching lp_mint
    //   Xdex:          lp_mint.mint_authority must equal XDEX_LP_AUTH
    //
    // For BrainsPairing, pass the PoolRecord PDA. For Xdex, pass program_id as sentinel.
    /// CHECK: validated in handler based on source type
    pub lp_provenance_account: UncheckedAccount<'info>,

    pub lp_token_program:     Interface<'info, TokenInterface>,
    pub reward_token_program: Interface<'info, TokenInterface>,
    pub system_program:       Program<'info, System>,
    pub rent:                 Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreateFarm>, params: CreateFarmParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // ── Input validation ──────────────────────────────────────────────────────
    require!(params.seed_amount > 0, FarmError::SeedZero);
    require!(
        params.target_duration_secs >= MIN_TARGET_DURATION_SECS,
        FarmError::DurationTooShort
    );
    require!(
        params.target_duration_secs <= MAX_TARGET_DURATION_SECS,
        FarmError::DurationTooLong
    );

    // ── LP provenance check ───────────────────────────────────────────────────
    match params.source {
        LpSource::BrainsPairing => {
            // Derive expected PoolRecord PDA: [b"pool_record", <pool_address>]
            // We can't derive without knowing the pool_address — so instead,
            // we validate the passed account by:
            //   1. It's owned by brains_pairing program
            //   2. Its first 32 bytes after discriminator (pool_address) + data
            //      layout match. Since PoolRecord has lp_mint at offset 8+32=40
            //      (after discriminator + pool_address), we read that and compare.
            let pr = &ctx.accounts.lp_provenance_account;
            require!(
                pr.owner == &BRAINS_PAIRING_PROGRAM,
                FarmError::InvalidPairingProgram
            );
            let data = pr.try_borrow_data()?;
            // PoolRecord layout: 8 disc + 32 pool_address + 32 lp_mint + ...
            require!(data.len() >= 8 + 32 + 32, FarmError::InvalidAccountData);
            let lp_mint_bytes: [u8; 32] = data[40..72]
                .try_into()
                .map_err(|_| FarmError::InvalidAccountData)?;
            let pool_lp_mint = Pubkey::new_from_array(lp_mint_bytes);
            require!(
                pool_lp_mint == ctx.accounts.lp_mint.key(),
                FarmError::PoolRecordMismatch
            );
        }
        LpSource::Xdex => {
            // Check that lp_mint.mint_authority == XDEX_LP_AUTH
            let mint = &ctx.accounts.lp_mint;
            let mint_auth = mint.mint_authority;
            match mint_auth.into() {
                Some(auth) => {
                    let auth: Pubkey = auth;
                    require!(auth == XDEX_LP_AUTH, FarmError::NotXdexLpMint);
                }
                None => return Err(error!(FarmError::NotXdexLpMint)),
            }
        }
    }

    // ── Compute initial reward_rate_per_sec ───────────────────────────────────
    // rate_scaled = seed_amount × ACC_PRECISION / duration_secs
    // This is the rate stored internally. At settle time:
    //   emission_raw_per_sec = rate_scaled / ACC_PRECISION
    //   for duration_secs total seconds → emits exactly seed_amount tokens (rounded)
    let rate_scaled = (params.seed_amount as u128)
        .checked_mul(ACC_PRECISION)
        .ok_or(FarmError::Overflow)?
        .checked_div(params.target_duration_secs as u128)
        .ok_or(FarmError::Overflow)?;

    require!(rate_scaled > 0, FarmError::RateZero);
    require!(rate_scaled <= MAX_REWARD_RATE_PER_SEC, FarmError::RateTooHigh);

    // ── Initialize Farm ───────────────────────────────────────────────────────
    let farm = &mut ctx.accounts.farm;
    farm.lp_mint               = ctx.accounts.lp_mint.key();
    farm.reward_mint           = ctx.accounts.reward_mint.key();
    farm.lp_vault              = ctx.accounts.lp_vault.key();
    farm.reward_vault          = ctx.accounts.reward_vault.key();
    farm.reward_rate_per_sec   = rate_scaled;
    farm.acc_reward_per_share  = 0;
    farm.last_update_ts        = now;
    farm.total_staked          = 0;
    farm.total_effective       = 0;
    farm.total_pending_rewards = 0;
    farm.total_emitted         = 0;
    farm.start_ts              = now;
    farm.created_at            = now;
    farm.paused                = false;
    farm.closed                = false;
    farm.lp_vault_bump         = ctx.bumps.lp_vault;
    farm.reward_vault_bump     = ctx.bumps.reward_vault;
    farm.bump                  = ctx.bumps.farm;

    // ── Update global stats ───────────────────────────────────────────────────
    let gs = &mut ctx.accounts.global_state;
    gs.total_farms = gs.total_farms
        .checked_add(1)
        .ok_or(FarmError::Overflow)?;
    gs.active_farms = gs.active_farms
        .checked_add(1)
        .ok_or(FarmError::Overflow)?;

    msg!("Farm created: lp={} reward={} rate_scaled={} (source={:?})",
        farm.lp_mint, farm.reward_mint, rate_scaled, params.source);
    msg!("Seed target: {} tokens over {} seconds", params.seed_amount, params.target_duration_secs);
    msg!("Next step: admin must fund_farm with seed tokens");

    Ok(())
}
