// programs/brains_pairing/src/instructions/delist.rs

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    TransferChecked, transfer_checked,
    CloseAccount, close_account,
};
use crate::{constants::*, errors::PairingError, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DelistParams {
    pub xnt_price_usd: u64, // for delist fee calculation
}

#[derive(Accounts)]
pub struct Delist<'info> {
    #[account(
        mut,
        constraint = creator.key() == listing_state.creator @ PairingError::Unauthorized,
    )]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"global_state"],
        bump   = global_state.bump,
        constraint = !global_state.is_locked @ PairingError::Reentrancy,
        // NOTE: delist works even when paused (user always gets tokens back)
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds  = [b"listing", creator.key().as_ref(), listing_state.token_a_mint.as_ref()],
        bump   = listing_state.bump,
        constraint = listing_state.status == ListingStatus::Open @ PairingError::ListingNotOpen,
        // Close listing state — rent refund goes to creator
        close = creator,
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

pub fn handler(ctx: Context<Delist>, p: DelistParams) -> Result<()> {
    ctx.accounts.global_state.is_locked = true;

    require!(p.xnt_price_usd > 0, PairingError::InvalidPrice);

    // ── CALCULATE DELIST FEE — 0.444% of remaining USD value ─────────────────
    // Flat 0.444% for all wallets — no LB discount on delist (treasury collection)
    let usd_val   = ctx.accounts.listing_state.token_a_usd_val;
    let fee_usd   = usd_val
        .checked_mul(FEE_BPS_DELIST).ok_or(PairingError::Overflow)?
        .checked_div(10_000).ok_or(PairingError::Overflow)?;
    let fee_xnt   = (fee_usd as u128)
        .checked_mul(1_000_000_000u128).ok_or(PairingError::Overflow)?
        .checked_div(p.xnt_price_usd as u128).ok_or(PairingError::Overflow)?
        as u64;
    let fee_xnt   = fee_xnt.max(FEE_MINIMUM_XNT);

    // ── COLLECT DELIST FEE → TREASURY ────────────────────────────────────────
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

    // ── RETURN ESCROWED TOKENS TO CREATOR ─────────────────────────────────────
    let amount           = ctx.accounts.listing_state.token_a_amount;
    let escrow_auth_bump = ctx.accounts.listing_state.escrow_auth_bump;
    let listing_key      = ctx.accounts.listing_state.key();
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
        amount,
        ctx.accounts.token_a_mint.decimals,
    )?;

    // ── CLOSE ESCROW ACCOUNT — rent refund to creator ─────────────────────────
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account:     ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
            authority:   ctx.accounts.escrow_authority.to_account_info(),
        },
        &[seeds],
    ))?;

    // ── UPDATE GLOBAL STATE ───────────────────────────────────────────────────
    let gs           = &mut ctx.accounts.global_state;
    gs.open_listings = gs.open_listings
        .checked_sub(1).ok_or(PairingError::Overflow)?;
    gs.total_fee_xnt = gs.total_fee_xnt
        .checked_add(fee_xnt).ok_or(PairingError::Overflow)?;

    msg!("Listing delisted. {} XNT fee. {} tokens returned.",
        fee_xnt, amount);

    ctx.accounts.global_state.is_locked = false;
    Ok(())
}
