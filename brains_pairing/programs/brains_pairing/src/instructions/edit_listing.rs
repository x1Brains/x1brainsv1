// programs/brains_pairing/src/instructions/edit_listing.rs

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    TransferChecked, transfer_checked,
};
use crate::{constants::*, errors::PairingError, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct EditListingParams {
    pub new_amount:       Option<u64>,  // new token amount — must be > 0
    pub new_usd_val:      Option<u64>,  // updated USD value if amount changed
    pub new_xnt_val:      Option<u64>,  // updated XNT value if amount changed
    pub new_burn_bps:     Option<u16>,  // new burn % — 0/2500/5000/10000
    pub price_timestamp:  i64,          // when prices were fetched
    pub xnt_price_usd:    u64,          // for edit fee calc
}

#[derive(Accounts)]
pub struct EditListing<'info> {
    #[account(
        mut,
        constraint = creator.key() == listing_state.creator @ PairingError::Unauthorized,
    )]
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
        mut,
        seeds  = [b"listing", creator.key().as_ref(), listing_state.token_a_mint.as_ref()],
        bump   = listing_state.bump,
        constraint = listing_state.status == ListingStatus::Open @ PairingError::ListingNotOpen,
    )]
    pub listing_state: Account<'info, ListingState>,

    // ── Escrow — verified with STORED bump (Layer 11) ─────────────────────────
    #[account(
        mut,
        seeds  = [b"escrow", listing_state.key().as_ref()],
        bump   = listing_state.escrow_bump,
        token::mint      = token_a_mint,
        token::authority = escrow_authority,
        token::token_program = token_program,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA authority — verified by seeds and stored bump
    #[account(
        seeds = [b"escrow_auth", listing_state.key().as_ref()],
        bump  = listing_state.escrow_auth_bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    pub token_a_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint      = token_a_mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program,
    )]
    pub creator_token_a: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: hardcoded treasury
    #[account(
        mut,
        constraint = treasury.key() == TREASURY_WALLET @ PairingError::InvalidTreasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub token_program:  Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<EditListing>, p: EditListingParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    ctx.accounts.global_state.is_locked = true;

    // ── VALIDATE TIMESTAMP ────────────────────────────────────────────────────
    require!(p.price_timestamp <= now, PairingError::InvalidTimestamp);
    if p.new_amount.is_some() {
        require!(
            now.checked_sub(p.price_timestamp)
                .ok_or(PairingError::Overflow)? <= MAX_PRICE_AGE_SECS,
            PairingError::PriceStale
        );
    }

    require!(p.xnt_price_usd > 0, PairingError::InvalidPrice);

    // ── VALIDATE BURN BPS IF CHANGING ─────────────────────────────────────────
    if let Some(bps) = p.new_burn_bps {
        require!(VALID_BURN_BPS.contains(&bps), PairingError::InvalidBurnBps);
    }

    // ── VALIDATE NEW AMOUNT IF CHANGING ───────────────────────────────────────
    if let Some(amt) = p.new_amount {
        require!(amt > 0, PairingError::ZeroAmount);
        let usd = p.new_usd_val.unwrap_or(ctx.accounts.listing_state.token_a_usd_val);
        require!(usd >= MIN_LISTING_USD, PairingError::AmountTooSmall);
    }

    // ── COLLECT FLAT EDIT FEE (0.001 XNT) ────────────────────────────────────
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to:   ctx.accounts.treasury.to_account_info(),
            },
        ),
        FEE_EDIT_XNT,
    )?;

    // ── ADJUST ESCROW IF AMOUNT CHANGED ───────────────────────────────────────
    let listing = &mut ctx.accounts.listing_state;
    if let Some(new_amt) = p.new_amount {
        let current = listing.token_a_amount;
        if new_amt > current {
            // Transfer additional tokens into escrow
            let diff = new_amt.checked_sub(current).ok_or(PairingError::Overflow)?;
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
                diff,
                ctx.accounts.token_a_mint.decimals,
            )?;
        } else if new_amt < current {
            // Return excess tokens from escrow to creator
            let diff = current.checked_sub(new_amt).ok_or(PairingError::Overflow)?;
            let escrow_auth_bump = listing.escrow_auth_bump;
            let listing_key = listing.key();
            let seeds = &[
                b"escrow_auth",
                listing_key.as_ref(),
                &[escrow_auth_bump],
            ];
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from:      ctx.accounts.escrow.to_account_info(),
                        mint:      ctx.accounts.token_a_mint.to_account_info(),
                        to:        ctx.accounts.creator_token_a.to_account_info(),
                        authority: ctx.accounts.escrow_authority.to_account_info(),
                    },
                    &[seeds],
                ),
                diff,
                ctx.accounts.token_a_mint.decimals,
            )?;
        }
        listing.token_a_amount = new_amt;
        if let Some(uv) = p.new_usd_val { listing.token_a_usd_val = uv; }
        if let Some(xv) = p.new_xnt_val { listing.token_a_xnt_val = xv; }
    }

    // ── UPDATE BURN BPS IF CHANGED ────────────────────────────────────────────
    if let Some(bps) = p.new_burn_bps {
        listing.burn_bps = bps;
    }

    // ── UPDATE GLOBAL FEE TRACKER ─────────────────────────────────────────────
    ctx.accounts.global_state.total_fee_xnt = ctx.accounts.global_state.total_fee_xnt
        .checked_add(FEE_EDIT_XNT).ok_or(PairingError::Overflow)?;

    msg!("Listing edited: amount={:?} burn_bps={:?}",
        p.new_amount, p.new_burn_bps);

    ctx.accounts.global_state.is_locked = false;
    Ok(())
}
