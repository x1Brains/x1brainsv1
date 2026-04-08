// programs/brains_pairing/src/instructions/create_listing.rs

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        Mint, TokenAccount, TokenInterface,
        TransferChecked, transfer_checked,
    },
};
use crate::{constants::*, errors::PairingError, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateListingParams {
    pub token_a_amount:   u64,
    pub token_a_usd_val:  u64,
    pub token_a_xnt_val:  u64,
    pub token_a_mc:       u64,
    pub burn_bps:         u16,
    pub xnt_price_usd:    u64,
    pub price_timestamp:  i64,
    pub price_impact_bps: u64,
}

#[derive(Accounts)]
pub struct CreateListing<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"global_state"],
        bump   = global_state.bump,
        constraint = !global_state.paused    @ PairingError::Paused,
        constraint = !global_state.is_locked @ PairingError::Reentrancy,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init_if_needed,
        seeds  = [b"wallet_state", creator.key().as_ref()],
        bump,
        payer  = creator,
        space  = 8 + 46,
    )]
    pub wallet_state: Account<'info, WalletState>,

    pub token_a_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint          = token_a_mint,
        associated_token::authority     = creator,
        associated_token::token_program = token_program,
    )]
    pub creator_token_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        seeds  = [b"listing", creator.key().as_ref(), token_a_mint.key().as_ref()],
        bump,
        payer  = creator,
        space  = 8 + 119,
    )]
    pub listing_state: Account<'info, ListingState>,

    #[account(
        init,
        seeds  = [b"escrow", listing_state.key().as_ref()],
        bump,
        payer  = creator,
        token::mint          = token_a_mint,
        token::authority     = escrow_authority,
        token::token_program = token_program,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA authority for escrow
    #[account(
        seeds = [b"escrow_auth", listing_state.key().as_ref()],
        bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    /// CHECK: hardcoded treasury
    #[account(
        mut,
        constraint = treasury.key() == TREASURY_WALLET @ PairingError::InvalidTreasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: optional LB account for discount check
    pub creator_lb_account: Option<UncheckedAccount<'info>>,

    /// CHECK: XNT vault for price cross-check
    pub token_a_xnt_pool_vault: UncheckedAccount<'info>,

    pub token_program:            Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreateListing>, p: CreateListingParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.global_state.is_locked = true;

    // Validate burn BPS whitelist
    require!(VALID_BURN_BPS.contains(&p.burn_bps), PairingError::InvalidBurnBps);

    // Validate amounts
    require!(p.token_a_amount > 0,                 PairingError::ZeroAmount);
    require!(p.token_a_usd_val > 0,                PairingError::InvalidPrice);
    require!(p.token_a_usd_val >= MIN_LISTING_USD, PairingError::AmountTooSmall);
    require!(p.xnt_price_usd > 0,                  PairingError::InvalidPrice);

    // Validate price timestamp
    require!(p.price_timestamp <= now,             PairingError::InvalidTimestamp);
    require!(
        now.checked_sub(p.price_timestamp)
            .ok_or(PairingError::Overflow)? <= MAX_PRICE_AGE_SECS,
        PairingError::PriceStale
    );

    // Validate price impact
    require!(
        p.price_impact_bps <= MAX_PRICE_IMPACT_BPS,
        PairingError::PriceImpactTooHigh
    );

    // Pool TVL check — read XNT vault balance directly
    {
        let vault_data = ctx.accounts.token_a_xnt_pool_vault.try_borrow_data()?;
        if vault_data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8 {
            let vault_xnt = u64::from_le_bytes(
                vault_data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                    .try_into().map_err(|_| PairingError::InvalidPoolData)?
            );
            require!(vault_xnt > 0,                        PairingError::PoolTvlTooLow);
            require!(vault_xnt >= MIN_POOL_TVL_LAMPORTS,   PairingError::PoolTvlTooLow);
        }
    }

    // Rate limiting
    let wallet = &mut ctx.accounts.wallet_state;
    require!(!wallet.is_flagged, PairingError::WalletFlagged);

    if now.checked_sub(wallet.hour_window_start)
          .ok_or(PairingError::Overflow)? >= RATE_LIMIT_WINDOW_SECS {
        wallet.listings_this_hour = 0;
        wallet.hour_window_start  = now;
    }

    require!(
        wallet.listings_this_hour < MAX_LISTINGS_PER_HOUR,
        PairingError::RateLimited
    );

    wallet.listings_this_hour = wallet.listings_this_hour
        .checked_add(1).ok_or(PairingError::Overflow)?;
    wallet.last_listing_at = now;
    wallet.total_listings  = wallet.total_listings
        .checked_add(1).ok_or(PairingError::Overflow)?;

    // Read LB balance for discount
    let lb_balance = read_lb_balance(&ctx.accounts.creator_lb_account)?;

    // Determine if ecosystem token
    let is_ecosystem = ctx.accounts.token_a_mint.key() == BRAINS_MINT
                    || ctx.accounts.token_a_mint.key() == LB_MINT;

    // Calculate fee
    let fee_xnt = calculate_fee(is_ecosystem, lb_balance, p.token_a_usd_val, p.xnt_price_usd)?;

    // Transfer tokens to escrow
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from:      ctx.accounts.creator_token_a.to_account_info(),
                mint:      ctx.accounts.token_a_mint.to_account_info(),
                to:        ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
            },
        ),
        p.token_a_amount,
        ctx.accounts.token_a_mint.decimals,
    )?;

    // Transfer fee to treasury
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to:   ctx.accounts.treasury.to_account_info(),
            },
        ),
        fee_xnt,
    )?;

    // Store bumps — Anchor 0.31.1 syntax
    let escrow_bump      = ctx.bumps.escrow;
    let escrow_auth_bump = ctx.bumps.escrow_authority;
    let listing_bump     = ctx.bumps.listing_state;

    // Initialize listing state
    let listing              = &mut ctx.accounts.listing_state;
    listing.creator          = ctx.accounts.creator.key();
    listing.token_a_mint     = ctx.accounts.token_a_mint.key();
    listing.token_a_amount   = p.token_a_amount;
    listing.token_a_usd_val  = p.token_a_usd_val;
    listing.token_a_xnt_val  = p.token_a_xnt_val;
    listing.token_a_mc       = p.token_a_mc;
    listing.burn_bps         = p.burn_bps;
    listing.is_ecosystem     = is_ecosystem;
    listing.status           = ListingStatus::Open;
    listing.escrow_bump      = escrow_bump;
    listing.escrow_auth_bump = escrow_auth_bump;
    listing.created_at       = now;
    listing.bump             = listing_bump;

    // Update global state
    let gs            = &mut ctx.accounts.global_state;
    gs.total_fee_xnt  = gs.total_fee_xnt
        .checked_add(fee_xnt).ok_or(PairingError::Overflow)?;
    gs.total_listings = gs.total_listings
        .checked_add(1).ok_or(PairingError::Overflow)?;
    gs.open_listings  = gs.open_listings
        .checked_add(1).ok_or(PairingError::Overflow)?;

    msg!("Listing created: {} tokens, {} USD, {}bps burn, {} XNT fee",
        p.token_a_amount, p.token_a_usd_val, p.burn_bps, fee_xnt);

    ctx.accounts.global_state.is_locked = false;
    Ok(())
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

pub fn read_lb_balance(account: &Option<UncheckedAccount>) -> Result<u64> {
    if let Some(acc) = account {
        let data = acc.try_borrow_data()?;
        if data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8 {
            return Ok(u64::from_le_bytes(
                data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                    .try_into().map_err(|_| PairingError::InvalidPoolData)?
            ));
        }
    }
    Ok(0)
}

pub fn calculate_fee(
    is_ecosystem:  bool,
    lb_balance:    u64,
    usd_val:       u64,
    xnt_price_usd: u64,
) -> Result<u64> {
    require!(xnt_price_usd > 0, PairingError::InvalidPrice);

    let fee_bps = if is_ecosystem {
        FEE_BPS_ECOSYSTEM
    } else if lb_balance >= LB_DISCOUNT_THRESHOLD {
        FEE_BPS_DISCOUNT
    } else {
        FEE_BPS_STANDARD
    };

    let fee_usd = usd_val
        .checked_mul(fee_bps).ok_or(PairingError::Overflow)?
        .checked_div(10_000).ok_or(PairingError::Overflow)?;

    let fee_xnt = (fee_usd as u128)
        .checked_mul(1_000_000_000u128).ok_or(PairingError::Overflow)?
        .checked_div(xnt_price_usd as u128).ok_or(PairingError::Overflow)?
        as u64;

    Ok(fee_xnt.max(FEE_MINIMUM_XNT))
}

pub fn distribute_lp(total_minted: u64, burn_bps: u16) -> Result<(u64, u64, u64, u64)> {
    let available = total_minted
        .checked_sub(XDEX_MIN_LP_LOCK).ok_or(PairingError::Overflow)?;

    let burned = (available as u128)
        .checked_mul(burn_bps as u128).ok_or(PairingError::Overflow)?
        .checked_div(10_000).ok_or(PairingError::Overflow)? as u64;

    let remaining = available
        .checked_sub(burned).ok_or(PairingError::Overflow)?;

    let treasury_lp = remaining
        .checked_mul(TREASURY_LP_BPS).ok_or(PairingError::Overflow)?
        .checked_div(10_000).ok_or(PairingError::Overflow)?;

    let distributable = remaining
        .checked_sub(treasury_lp).ok_or(PairingError::Overflow)?;

    let user_a = distributable / 2;
    let user_b = distributable.checked_sub(user_a).ok_or(PairingError::Overflow)?;

    // Integrity check — every LP token accounted for
    let total_check = XDEX_MIN_LP_LOCK
        .checked_add(burned).ok_or(PairingError::Overflow)?
        .checked_add(treasury_lp).ok_or(PairingError::Overflow)?
        .checked_add(user_a).ok_or(PairingError::Overflow)?
        .checked_add(user_b).ok_or(PairingError::Overflow)?;

    require!(total_check == total_minted, PairingError::LpMath);

    Ok((burned, treasury_lp, user_a, user_b))
}
