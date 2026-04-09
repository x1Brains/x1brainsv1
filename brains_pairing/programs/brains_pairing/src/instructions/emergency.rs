// programs/brains_pairing/src/instructions/emergency.rs
// Emergency withdraw — ALWAYS available, even when program is paused.
// Original lister can always recover their escrowed tokens.
// No fee. No conditions. User funds are always safe.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    TransferChecked, transfer_checked,
    CloseAccount, close_account,
};
use crate::{errors::PairingError, state::*};

#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    // Must be the original listing creator
    #[account(
        mut,
        constraint = creator.key() == listing_state.creator @ PairingError::Unauthorized,
    )]
    pub creator: Signer<'info>,

    // NOTE: no paused check — emergency withdraw works regardless
    #[account(
        mut,
        seeds  = [b"listing", creator.key().as_ref(), listing_state.token_a_mint.as_ref()],
        bump   = listing_state.bump,
        constraint = listing_state.status == ListingStatus::Open @ PairingError::ListingNotOpen,
        close  = creator, // rent refund to creator
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

    // ── Global state — update open_listings counter ───────────────────────────
    #[account(
        mut,
        seeds = [b"global_state"],
        bump  = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    pub token_program:  Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<EmergencyWithdraw>) -> Result<()> {
    let amount           = ctx.accounts.listing_state.token_a_amount;
    let escrow_auth_bump = ctx.accounts.listing_state.escrow_auth_bump;
    let listing_key      = ctx.accounts.listing_state.key();

    let seeds = &[
        b"escrow_auth",
        listing_key.as_ref(),
        &[escrow_auth_bump],
    ];

    // ── RETURN ALL ESCROWED TOKENS TO CREATOR ─────────────────────────────────
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

    // ── UPDATE GLOBAL COUNTER ─────────────────────────────────────────────────
    ctx.accounts.global_state.open_listings = ctx.accounts.global_state.open_listings
        .checked_sub(1).ok_or(PairingError::Overflow)?;

    // ── NO FEE. NO CONDITIONS. USER IS ALWAYS SAFE. ───────────────────────────
    msg!(
        "Emergency withdrawal: {} tokens returned to {}",
        amount,
        ctx.accounts.creator.key()
    );

    Ok(())
}
