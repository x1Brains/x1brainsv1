// programs/brains_pairing/src/instructions/match_listing.rs
// v1.2 SPLIT DESIGN — two instructions in one transaction
//
// prepare_match: validation + MatchIntent PDA creation (no token movements)
// execute_match: token transfers + XDEX CPI + LP distribution + closures
//
// ATOMICITY: execute_match requires current_slot == match_intent.created_slot,
// which forces both instructions to run in the same block = same transaction.
// If the matcher never calls execute_match, only the MatchIntent rent is lost
// (~0.002 XNT). No tokens move, no state corruption.
//
// XDEX is a direct fork of Raydium CP-Swap. Source verified against
// raydium-io/raydium-cp-swap/programs/cp-swap/src/instructions/initialize.rs
// and seed derivations verified on-chain against existing BRAINS/WXNT pool.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
// keccak moved to solana-keccak-hasher
use solana_keccak_hasher as keccak;
use anchor_spl::{
    associated_token::{AssociatedToken, Create, create as create_ata},
    token::Token,
    token_interface::{
        Mint, TokenAccount, TokenInterface,
        TransferChecked, transfer_checked,
        CloseAccount, close_account,
    },
};
use crate::{constants::*, errors::PairingError, state::*};
use crate::instructions::create_listing::{calculate_fee, distribute_lp};

// ═════════════════════════════════════════════════════════════════════════════
// SHARED PARAMS
// ═════════════════════════════════════════════════════════════════════════════

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CommitMatchParams {
    pub commit_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PrepareMatchParams {
    pub token_b_amount:    u64,
    pub token_b_usd_val:   u64,
    pub xnt_price_usd:     u64,
    pub price_timestamp:   i64,
    pub price_impact_bps:  u64,
    pub open_time:         u64,
    pub amm_config:        Pubkey,
    pub commit_nonce:      Option<[u8; 32]>,
    pub token_a_is_token0: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExecuteMatchParams {
    // Intentionally empty — all values come from MatchIntent PDA.
    // Kept as a struct for forward compatibility.
    pub _reserved: u8,
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMIT-REVEAL (unchanged)
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct CommitMatch<'info> {
    #[account(mut)]
    pub matcher: Signer<'info>,

    #[account(
        seeds  = [b"listing", listing_state.creator.as_ref(), listing_state.token_a_mint.as_ref()],
        bump   = listing_state.bump,
        constraint = listing_state.status == ListingStatus::Open @ PairingError::ListingNotOpen,
        constraint = listing_state.creator != matcher.key()      @ PairingError::SelfMatch,
    )]
    pub listing_state: Box<Account<'info, ListingState>>,

    #[account(
        init,
        seeds  = [b"commitment", matcher.key().as_ref(), listing_state.key().as_ref()],
        bump,
        payer  = matcher,
        space  = 8 + 114,
    )]
    pub match_commitment: Account<'info, MatchCommitment>,

    pub system_program: Program<'info, System>,
}

pub fn commit_handler(ctx: Context<CommitMatch>, p: CommitMatchParams) -> Result<()> {
    let commitment         = &mut ctx.accounts.match_commitment;
    commitment.matcher     = ctx.accounts.matcher.key();
    commitment.listing     = ctx.accounts.listing_state.key();
    commitment.commit_hash = p.commit_hash;
    commitment.commit_slot = Clock::get()?.slot;
    commitment.revealed    = false;
    commitment.bump        = ctx.bumps.match_commitment;
    msg!("Match committed at slot {}", commitment.commit_slot);
    Ok(())
}

// ═════════════════════════════════════════════════════════════════════════════
// PREPARE MATCH — validation + MatchIntent creation
// ═════════════════════════════════════════════════════════════════════════════
//
// Named accounts (kept small for stack):
//   matcher, global_state, listing_state, token_b_mint, match_intent (init),
//   match_commitment (optional), system_program
//
// Remaining accounts:
//   [0] token_b_xnt_pool           (existence check)
//   [1] token_b_xnt_pool_vault     (TVL check)
//   [2] xnt_usdc_pool_xnt_vault    (oracle)
//   [3] xnt_usdc_pool_usdc_vault   (oracle)
//   [4] slot_hashes                (sysvar)
//   [5] matcher_lb_account OR program_id sentinel

#[derive(Accounts)]
#[instruction(p: PrepareMatchParams)]
pub struct PrepareMatch<'info> {
    #[account(mut)]
    pub matcher: Signer<'info>,

    #[account(mut, seeds = [b"global_state"], bump = global_state.bump)]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(
        seeds  = [b"listing",
                  listing_state.creator.as_ref(),
                  listing_state.token_a_mint.as_ref()],
        bump   = listing_state.bump,
    )]
    pub listing_state: Box<Account<'info, ListingState>>,

    pub token_a_mint: InterfaceAccount<'info, Mint>,
    pub token_b_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        seeds = [b"match_intent", matcher.key().as_ref(), listing_state.key().as_ref()],
        bump,
        payer = matcher,
        space = 8 + 178,
    )]
    pub match_intent: Box<Account<'info, MatchIntent>>,

    #[account(
        mut,
        seeds = [b"commitment", matcher.key().as_ref(), listing_state.key().as_ref()],
        bump,
    )]
    pub match_commitment: Option<Account<'info, MatchCommitment>>,

    pub system_program: Program<'info, System>,
}

// Remaining accounts indices for prepare_match
const PR_TOKEN_B_XNT_POOL:       usize = 0;
const PR_TOKEN_B_XNT_VAULT:      usize = 1;
const PR_XNT_USDC_VAULT_XNT:     usize = 2;
const PR_XNT_USDC_VAULT_USDC:    usize = 3;
const PR_SLOT_HASHES:            usize = 4;
const PR_MATCHER_LB_ACCOUNT:     usize = 5;
const PR_MIN_REQUIRED:           usize = 6;

pub fn prepare_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, PrepareMatch<'info>>,
    p: PrepareMatchParams,
) -> Result<()> {
    let now          = Clock::get()?.unix_timestamp;
    let current_slot = Clock::get()?.slot;

    // ── 0. REMAINING ACCOUNTS ───────────────────────────────────────────────
    require!(
        ctx.remaining_accounts.len() >= PR_MIN_REQUIRED,
        PairingError::InvalidPoolData
    );
    let ra = ctx.remaining_accounts;

    // ── 1. STATE GUARDS ─────────────────────────────────────────────────────
    require!(!ctx.accounts.global_state.paused,    PairingError::Paused);
    require!(!ctx.accounts.global_state.is_locked, PairingError::Reentrancy);
    require!(
        ctx.accounts.listing_state.status == ListingStatus::Open,
        PairingError::ListingNotOpen
    );
    require!(
        ctx.accounts.listing_state.creator != ctx.accounts.matcher.key(),
        PairingError::SelfMatch
    );
    require!(
        ctx.accounts.token_a_mint.key() == ctx.accounts.listing_state.token_a_mint,
        PairingError::InvalidPoolAddress
    );

    // ── 2. REMAINING ACCOUNT IDENTITY CHECKS ────────────────────────────────
    require!(
        ra[PR_XNT_USDC_VAULT_XNT].key() == XNT_USDC_VAULT_XNT,
        PairingError::InvalidPoolAddress
    );
    require!(
        ra[PR_XNT_USDC_VAULT_USDC].key() == XNT_USDC_VAULT_USDC,
        PairingError::InvalidPoolAddress
    );
    require!(
        ra[PR_TOKEN_B_XNT_POOL].data_len() > 0,
        PairingError::NoXntPool
    );

    // ── 3. PRICE VALIDATION ─────────────────────────────────────────────────
    require!(p.token_b_amount > 0,     PairingError::ZeroAmount);
    require!(p.token_b_usd_val > 0,    PairingError::InvalidPrice);
    require!(p.xnt_price_usd > 0,      PairingError::InvalidPrice);
    require!(p.price_timestamp <= now, PairingError::InvalidTimestamp);
    require!(
        now.checked_sub(p.price_timestamp)
            .ok_or(PairingError::Overflow)? <= MAX_PRICE_AGE_SECS,
        PairingError::PriceStale
    );
    require!(p.price_impact_bps <= MAX_PRICE_IMPACT_BPS, PairingError::PriceImpactTooHigh);
    require!(
        p.amm_config == XDEX_AMM_CONFIG_A || p.amm_config == XDEX_AMM_CONFIG_B,
        PairingError::InvalidAmmConfig
    );

    // ── 4. USD PARITY CHECK ─────────────────────────────────────────────────
    let usd_a     = ctx.accounts.listing_state.token_a_usd_val;
    let usd_b     = p.token_b_usd_val;
    let diff      = if usd_a > usd_b { usd_a - usd_b } else { usd_b - usd_a };
    let tolerance = usd_a
        .checked_mul(SLIPPAGE_BPS).ok_or(PairingError::Overflow)?
        .checked_div(10_000).ok_or(PairingError::Overflow)?;
    require!(diff <= tolerance, PairingError::PriceMismatch);

    // ── 5. XNT PRICE CROSS-VALIDATION ───────────────────────────────────────
    {
        let xnt_vault_data  = ra[PR_XNT_USDC_VAULT_XNT].try_borrow_data()?;
        let usdc_vault_data = ra[PR_XNT_USDC_VAULT_USDC].try_borrow_data()?;

        require!(
            xnt_vault_data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8 &&
            usdc_vault_data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8,
            PairingError::InvalidPoolData
        );

        let xnt_balance = u64::from_le_bytes(
            xnt_vault_data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                .try_into().map_err(|_| PairingError::InvalidPoolData)?
        );
        let usdc_balance = u64::from_le_bytes(
            usdc_vault_data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                .try_into().map_err(|_| PairingError::InvalidPoolData)?
        );

        require!(xnt_balance > 0 && usdc_balance > 0, PairingError::InvalidPrice);

        let onchain_price_u128 = (usdc_balance as u128)
            .checked_mul(1_000_000_000u128).ok_or(PairingError::Overflow)?
            .checked_div(xnt_balance as u128).ok_or(PairingError::Overflow)?;

        require!(onchain_price_u128 > 0, PairingError::InvalidPrice);
        require!(onchain_price_u128 <= u64::MAX as u128, PairingError::Overflow);
        let onchain_price = onchain_price_u128 as u64;

        let pdiff = if p.xnt_price_usd > onchain_price {
            p.xnt_price_usd - onchain_price
        } else {
            onchain_price - p.xnt_price_usd
        };
        let max_pdiff = (onchain_price as u128)
            .checked_mul(XNT_PRICE_TOLERANCE_BPS as u128).ok_or(PairingError::Overflow)?
            .checked_div(10_000).ok_or(PairingError::Overflow)? as u64;

        require!(pdiff <= max_pdiff, PairingError::PriceReservesMismatch);
    }

    // ── 6. TOKEN B XNT POOL TVL CHECK ───────────────────────────────────────
    {
        let vault_data = ra[PR_TOKEN_B_XNT_VAULT].try_borrow_data()?;
        require!(vault_data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8, PairingError::InvalidPoolData);
        let vault_xnt = u64::from_le_bytes(
            vault_data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                .try_into().map_err(|_| PairingError::InvalidPoolData)?
        );
        require!(vault_xnt >= MIN_POOL_TVL_LAMPORTS, PairingError::PoolTvlTooLow);
    }

    // ── 7. SLOT HASH BINDING ────────────────────────────────────────────────
    {
        let slot_data = ra[PR_SLOT_HASHES].try_borrow_data()?;
        require!(slot_data.len() >= 16, PairingError::InvalidSysvar);
        let recent_slot = u64::from_le_bytes(
            slot_data[8..16].try_into().map_err(|_| PairingError::InvalidSysvar)?
        );
        require!(
            current_slot.saturating_sub(recent_slot) <= COMMIT_EXPIRY_SLOTS,
            PairingError::TransactionTooOld
        );
    }

    // ── 8. COMMIT-REVEAL FOR LARGE LISTINGS ─────────────────────────────────
    if usd_a >= LARGE_LISTING_USD {
        let commitment = ctx.accounts.match_commitment
            .as_ref().ok_or(PairingError::CommitmentRequired)?;
        require!(!commitment.revealed, PairingError::AlreadyRevealed);
        require!(
            current_slot >= commitment.commit_slot
                .checked_add(COMMIT_REVEAL_SLOTS).ok_or(PairingError::Overflow)?,
            PairingError::RevealTooEarly
        );
        require!(
            current_slot <= commitment.commit_slot
                .checked_add(COMMIT_EXPIRY_SLOTS).ok_or(PairingError::Overflow)?,
            PairingError::CommitmentExpired
        );
        let nonce = p.commit_nonce.ok_or(PairingError::CommitmentMismatch)?;
        let mut hash_input = Vec::with_capacity(104);
        hash_input.extend_from_slice(&ctx.accounts.token_b_mint.key().to_bytes());
        hash_input.extend_from_slice(&p.token_b_amount.to_le_bytes());
        hash_input.extend_from_slice(&ctx.accounts.matcher.key().to_bytes());
        hash_input.extend_from_slice(&nonce);
        let computed = keccak::hash(&hash_input).0;
        require!(computed == commitment.commit_hash, PairingError::CommitmentMismatch);
    }

    // ── 9. VERIFY TOKEN ORDERING ────────────────────────────────────────────
    let token_a_key = ctx.accounts.token_a_mint.key();
    let token_b_key = ctx.accounts.token_b_mint.key();
    let a_lt_b = token_a_key.to_bytes() < token_b_key.to_bytes();
    require!(p.token_a_is_token0 == a_lt_b, PairingError::InvalidPoolAddress);

    // ── 10. SNAPSHOT MATCHER LB BALANCE FOR XNT FEE CALC ────────────────────
    let program_id = ctx.program_id;
    let matcher_lb_balance: u64 = {
        let lb_acc = &ra[PR_MATCHER_LB_ACCOUNT];
        if lb_acc.key() == *program_id {
            0  // sentinel = no LB account provided
        } else {
            let data = lb_acc.try_borrow_data()?;
            if data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8 {
                u64::from_le_bytes(
                    data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                        .try_into().map_err(|_| PairingError::InvalidPoolData)?
                )
            } else { 0 }
        }
    };

    // ── 11. WRITE MATCH INTENT PDA ──────────────────────────────────────────
    let intent_bump                 = ctx.bumps.match_intent;
    let intent                      = &mut ctx.accounts.match_intent;
    intent.matcher                  = ctx.accounts.matcher.key();
    intent.listing                  = ctx.accounts.listing_state.key();
    intent.token_b_mint             = ctx.accounts.token_b_mint.key();
    intent.token_b_amount           = p.token_b_amount;
    intent.token_b_usd_val          = p.token_b_usd_val;
    intent.xnt_price_usd            = p.xnt_price_usd;
    intent.amm_config               = p.amm_config;
    intent.token_a_is_token0        = p.token_a_is_token0;
    intent.open_time                = p.open_time;
    intent.created_slot             = current_slot;
    intent.matcher_lb_balance       = matcher_lb_balance;
    intent.bump                     = intent_bump;

    msg!("MatchIntent prepared at slot {}", current_slot);
    Ok(())
}

// ═════════════════════════════════════════════════════════════════════════════
// EXECUTE MATCH — token transfers + XDEX CPI + LP distribution + closures
// ═════════════════════════════════════════════════════════════════════════════
//
// Named accounts (larger struct but validation-heavy fields removed):
//   matcher, global_state, matcher_wallet_state, listing_state (close),
//   listing_creator, escrow, escrow_authority, token_a_mint, matcher_token_a,
//   token_b_mint, matcher_token_b, match_intent (close), pool_record (init),
//   pool_record_pool_key, 6x program/sysvar
//
// Remaining accounts:
//   [0] new_pool_state            (mut, new)
//   [1] lp_mint                   (mut, new)
//   [2] new_pool_vault_0          (mut, new)
//   [3] new_pool_vault_1          (mut, new)
//   [4] observation_state         (mut, new)
//   [5] matcher_lp_token          (mut, new — created by XDEX)
//   [6] creator_lp_ata            (mut, created by us post-CPI)
//   [7] treasury_lp_ata           (mut, created by us post-CPI)
//   [8] incinerator_lp_ata        (mut, created by us post-CPI)
//   [9] treasury                  (mut — receives match fee + LP ATA owner)
//   [10] incinerator              (LP ATA owner)
//   [11] xdex_program
//   [12] amm_config               (= match_intent.amm_config)
//   [13] xdex_lp_auth
//   [14] create_pool_fee          (mut)

#[derive(Accounts)]
#[instruction(_p: ExecuteMatchParams)]
pub struct ExecuteMatch<'info> {
    #[account(mut)]
    pub matcher: Signer<'info>,

    #[account(mut, seeds = [b"global_state"], bump = global_state.bump)]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(
        init_if_needed,
        seeds  = [b"wallet_state", matcher.key().as_ref()],
        bump,
        payer  = matcher,
        space  = 8 + 46,
    )]
    pub matcher_wallet_state: Box<Account<'info, WalletState>>,

    #[account(
        mut,
        seeds  = [b"listing",
                  listing_state.creator.as_ref(),
                  listing_state.token_a_mint.as_ref()],
        bump   = listing_state.bump,
        close  = listing_creator,
    )]
    pub listing_state: Box<Account<'info, ListingState>>,

    /// CHECK: verified in handler against listing_state.creator
    #[account(mut)]
    pub listing_creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds  = [b"escrow", listing_state.key().as_ref()],
        bump   = listing_state.escrow_bump,
        token::mint          = token_a_mint,
        token::authority     = escrow_authority,
        token::token_program = token_a_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA authority for escrow — verified by stored bump
    #[account(
        seeds = [b"escrow_auth", listing_state.key().as_ref()],
        bump  = listing_state.escrow_auth_bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    /// CHECK: token A mint — in remaining_accounts[15], verified in handler.
    /// Kept as UncheckedAccount here only so Anchor can reference it for
    /// `matcher_token_a` init_if_needed via ATA address derivation.
    pub token_a_mint: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = matcher,
        associated_token::mint = token_a_mint,
        associated_token::authority = matcher,
        associated_token::token_program = token_a_program,
    )]
    pub matcher_token_a: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: token B mint — in remaining_accounts[16], verified in handler.
    pub token_b_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint          = token_b_mint,
        associated_token::authority     = matcher,
        associated_token::token_program = token_b_program,
    )]
    pub matcher_token_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"match_intent", matcher.key().as_ref(), listing_state.key().as_ref()],
        bump  = match_intent.bump,
        close = matcher,
    )]
    pub match_intent: Box<Account<'info, MatchIntent>>,

    #[account(
        init,
        seeds = [b"pool_record", pool_record_pool_key.key().as_ref()],
        bump,
        payer = matcher,
        space = 8 + 274,
    )]
    pub pool_record: Box<Account<'info, PoolRecord>>,

    /// CHECK: passthrough for pool_record seed derivation.
    /// Must equal remaining_accounts[0] (new_pool_state), verified in handler.
    pub pool_record_pool_key: UncheckedAccount<'info>,

    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,
    pub token_program:   Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:  Program<'info, System>,
    pub rent:            Sysvar<'info, Rent>,
}

// Remaining accounts indices for execute_match
const EX_NEW_POOL_STATE:     usize = 0;
const EX_LP_MINT:            usize = 1;
const EX_NEW_POOL_VAULT_0:   usize = 2;
const EX_NEW_POOL_VAULT_1:   usize = 3;
const EX_OBSERVATION_STATE:  usize = 4;
const EX_MATCHER_LP_TOKEN:   usize = 5;
const EX_CREATOR_LP_ATA:     usize = 6;
const EX_TREASURY_LP_ATA:    usize = 7;
const EX_INCINERATOR_LP_ATA: usize = 8;
const EX_TREASURY:           usize = 9;
const EX_INCINERATOR:        usize = 10;
const EX_XDEX_PROGRAM:       usize = 11;
const EX_AMM_CONFIG:         usize = 12;
const EX_XDEX_LP_AUTH:       usize = 13;
const EX_CREATE_POOL_FEE:    usize = 14;
const EX_TOKEN_A_MINT:       usize = 15;
const EX_TOKEN_B_MINT:       usize = 16;
const EX_MIN_REQUIRED:       usize = 17;

pub fn execute_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ExecuteMatch<'info>>,
    _p: ExecuteMatchParams,
) -> Result<()> {
    let now          = Clock::get()?.unix_timestamp;
    let current_slot = Clock::get()?.slot;

    // ── 0. STATE GUARDS ─────────────────────────────────────────────────────
    require!(!ctx.accounts.global_state.paused,    PairingError::Paused);
    require!(!ctx.accounts.global_state.is_locked, PairingError::Reentrancy);
    require!(
        ctx.accounts.listing_state.status == ListingStatus::Open,
        PairingError::ListingNotOpen
    );

    ctx.accounts.global_state.is_locked = true;

    require!(!ctx.accounts.matcher_wallet_state.is_flagged, PairingError::WalletFlagged);

    // ── 1. REMAINING ACCOUNTS ───────────────────────────────────────────────
    require!(
        ctx.remaining_accounts.len() >= EX_MIN_REQUIRED,
        PairingError::InvalidPoolData
    );
    let ra = ctx.remaining_accounts;

    // ── 2. MATCH INTENT VERIFICATION (CRITICAL — ATOMICITY) ─────────────────
    // The intent must have been created in the SAME slot as this execution.
    // This forces prepare_match and execute_match to run in the same tx.
    let intent = &ctx.accounts.match_intent;
    require!(
        intent.matcher == ctx.accounts.matcher.key(),
        PairingError::CommitmentMismatch
    );
    require!(
        intent.listing == ctx.accounts.listing_state.key(),
        PairingError::CommitmentMismatch
    );
    require!(
        intent.created_slot == current_slot,
        PairingError::TransactionTooOld
    );
    require!(
        intent.token_b_mint == ra[EX_TOKEN_B_MINT].key(),
        PairingError::InvalidPoolAddress
    );
    // Also verify the passthrough unchecked mint fields match what we expect
    require!(
        ctx.accounts.token_a_mint.key() == ra[EX_TOKEN_A_MINT].key(),
        PairingError::InvalidPoolAddress
    );
    require!(
        ctx.accounts.token_b_mint.key() == ra[EX_TOKEN_B_MINT].key(),
        PairingError::InvalidPoolAddress
    );
    require!(
        ctx.accounts.token_a_mint.key() == ctx.accounts.listing_state.token_a_mint,
        PairingError::InvalidPoolAddress
    );
    require!(
        ctx.accounts.listing_creator.key() == ctx.accounts.listing_state.creator,
        PairingError::Unauthorized
    );

    // Extract intent values for use (copy everything before close)
    let token_b_amount     = intent.token_b_amount;
    let token_b_usd_val    = intent.token_b_usd_val;
    let xnt_price_usd      = intent.xnt_price_usd;
    let amm_config         = intent.amm_config;
    let token_a_is_token0  = intent.token_a_is_token0;
    let open_time          = intent.open_time;
    let matcher_lb_balance = intent.matcher_lb_balance;

    // ── 3. REMAINING ACCOUNT IDENTITY CHECKS ────────────────────────────────
    require!(
        ctx.accounts.pool_record_pool_key.key() == ra[EX_NEW_POOL_STATE].key(),
        PairingError::InvalidPoolAddress
    );
    require!(
        ra[EX_NEW_POOL_STATE].data_is_empty(),
        PairingError::PoolExists
    );
    require!(
        ra[EX_LP_MINT].data_is_empty(),
        PairingError::PoolExists
    );
    require!(
        ra[EX_TREASURY].key() == TREASURY_WALLET,
        PairingError::InvalidTreasury
    );
    require!(
        ra[EX_INCINERATOR].key() == INCINERATOR,
        PairingError::Unauthorized
    );
    require!(
        ra[EX_XDEX_PROGRAM].key() == XDEX_PROGRAM,
        PairingError::InvalidXdexProgram
    );
    require!(
        ra[EX_AMM_CONFIG].key() == amm_config,
        PairingError::InvalidAmmConfig
    );
    require!(
        ra[EX_XDEX_LP_AUTH].key() == XDEX_LP_AUTH,
        PairingError::InvalidPoolAddress
    );
    require!(
        ra[EX_CREATE_POOL_FEE].key() == XDEX_FEE_VAULT,
        PairingError::InvalidPoolAddress
    );

    // ── 4. TRANSFER TOKEN A FROM ESCROW → MATCHER (PDA signs) ───────────────
    let token_a_amount   = ctx.accounts.escrow.amount;
    let escrow_auth_bump = ctx.accounts.listing_state.escrow_auth_bump;
    let listing_key      = ctx.accounts.listing_state.key();
    let escrow_seeds: &[&[u8]] = &[
        b"escrow_auth",
        listing_key.as_ref(),
        std::slice::from_ref(&escrow_auth_bump),
    ];

    // Read decimals from raw mint account bytes (offset 44 in both SPL + Token-2022)
    let token_a_decimals: u8 = {
        let mint_data = ra[EX_TOKEN_A_MINT].try_borrow_data()?;
        require!(mint_data.len() >= 45, PairingError::InvalidPoolData);
        mint_data[44]
    };

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_a_program.to_account_info(),
            TransferChecked {
                from:      ctx.accounts.escrow.to_account_info(),
                mint:      ra[EX_TOKEN_A_MINT].clone(),
                to:        ctx.accounts.matcher_token_a.to_account_info(),
                authority: ctx.accounts.escrow_authority.to_account_info(),
            },
            &[escrow_seeds],
        ),
        token_a_amount,
        token_a_decimals,
    )?;

    // ── 5. CLOSE ESCROW ACCOUNT — refund to listing_creator ─────────────────
    close_account(CpiContext::new_with_signer(
        ctx.accounts.token_a_program.to_account_info(),
        CloseAccount {
            account:     ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.listing_creator.to_account_info(),
            authority:   ctx.accounts.escrow_authority.to_account_info(),
        },
        &[escrow_seeds],
    ))?;

    // ── 6. CPI TO XDEX initialize ───────────────────────────────────────────
    let (
        token0_mint_info, token1_mint_info,
        creator_token_0_info, creator_token_1_info,
        token0_program_info, token1_program_info,
    ) = if token_a_is_token0 {
        (
            ra[EX_TOKEN_A_MINT].clone(),
            ra[EX_TOKEN_B_MINT].clone(),
            ctx.accounts.matcher_token_a.to_account_info(),
            ctx.accounts.matcher_token_b.to_account_info(),
            ctx.accounts.token_a_program.to_account_info(),
            ctx.accounts.token_b_program.to_account_info(),
        )
    } else {
        (
            ra[EX_TOKEN_B_MINT].clone(),
            ra[EX_TOKEN_A_MINT].clone(),
            ctx.accounts.matcher_token_b.to_account_info(),
            ctx.accounts.matcher_token_a.to_account_info(),
            ctx.accounts.token_b_program.to_account_info(),
            ctx.accounts.token_a_program.to_account_info(),
        )
    };

    let (init_amount_0, init_amount_1) = if token_a_is_token0 {
        (token_a_amount, token_b_amount)
    } else {
        (token_b_amount, token_a_amount)
    };

    let mut ix_data = Vec::with_capacity(32);
    ix_data.extend_from_slice(&DISC_INITIALIZE);
    ix_data.extend_from_slice(&init_amount_0.to_le_bytes());
    ix_data.extend_from_slice(&init_amount_1.to_le_bytes());
    ix_data.extend_from_slice(&open_time.to_le_bytes());

    let xdex_accounts = vec![
        AccountMeta::new(ctx.accounts.matcher.key(),                 true),
        AccountMeta::new_readonly(ra[EX_AMM_CONFIG].key(),            false),
        AccountMeta::new_readonly(ra[EX_XDEX_LP_AUTH].key(),          false),
        AccountMeta::new(ra[EX_NEW_POOL_STATE].key(),                 false),
        AccountMeta::new_readonly(token0_mint_info.key(),             false),
        AccountMeta::new_readonly(token1_mint_info.key(),             false),
        AccountMeta::new(ra[EX_LP_MINT].key(),                        false),
        AccountMeta::new(creator_token_0_info.key(),                  false),
        AccountMeta::new(creator_token_1_info.key(),                  false),
        AccountMeta::new(ra[EX_MATCHER_LP_TOKEN].key(),               false),
        AccountMeta::new(ra[EX_NEW_POOL_VAULT_0].key(),               false),
        AccountMeta::new(ra[EX_NEW_POOL_VAULT_1].key(),               false),
        AccountMeta::new(ra[EX_CREATE_POOL_FEE].key(),                false),
        AccountMeta::new(ra[EX_OBSERVATION_STATE].key(),              false),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(),   false),
        AccountMeta::new_readonly(token0_program_info.key(),          false),
        AccountMeta::new_readonly(token1_program_info.key(),          false),
        AccountMeta::new_readonly(ctx.accounts.associated_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.system_program.key(),  false),
        AccountMeta::new_readonly(ctx.accounts.rent.key(),            false),
    ];

    let xdex_account_infos = vec![
        ctx.accounts.matcher.to_account_info(),
        ra[EX_AMM_CONFIG].clone(),
        ra[EX_XDEX_LP_AUTH].clone(),
        ra[EX_NEW_POOL_STATE].clone(),
        token0_mint_info.clone(),
        token1_mint_info.clone(),
        ra[EX_LP_MINT].clone(),
        creator_token_0_info.clone(),
        creator_token_1_info.clone(),
        ra[EX_MATCHER_LP_TOKEN].clone(),
        ra[EX_NEW_POOL_VAULT_0].clone(),
        ra[EX_NEW_POOL_VAULT_1].clone(),
        ra[EX_CREATE_POOL_FEE].clone(),
        ra[EX_OBSERVATION_STATE].clone(),
        ctx.accounts.token_program.to_account_info(),
        token0_program_info.clone(),
        token1_program_info.clone(),
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.rent.to_account_info(),
    ];

    invoke_signed(
        &Instruction {
            program_id: XDEX_PROGRAM,
            accounts:   xdex_accounts,
            data:       ix_data,
        },
        &xdex_account_infos,
        &[],
    )?;

    // ── 7. READ MATCHER'S LP BALANCE POST-CPI ───────────────────────────────
    let lp_received = {
        let lp_data = ra[EX_MATCHER_LP_TOKEN].try_borrow_data()?;
        require!(lp_data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8, PairingError::InsufficientLpReceived);
        u64::from_le_bytes(
            lp_data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                .try_into().map_err(|_| PairingError::InvalidPoolData)?
        )
    };
    require!(lp_received > XDEX_MIN_LP_LOCK, PairingError::InsufficientLpReceived);

    // ── 8. CALCULATE LP DISTRIBUTION ────────────────────────────────────────
    let (lp_burned, lp_treasury, lp_user_a, lp_user_b) =
        distribute_lp(lp_received, ctx.accounts.listing_state.burn_bps)?;

    msg!("LP minted={} burned={} treasury={} user_a={} user_b={}",
        lp_received, lp_burned, lp_treasury, lp_user_a, lp_user_b);

    // ── 9. CREATE 3 LP DESTINATION ATAS ─────────────────────────────────────
    if ra[EX_CREATOR_LP_ATA].data_is_empty() {
        create_ata(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer:            ctx.accounts.matcher.to_account_info(),
                associated_token: ra[EX_CREATOR_LP_ATA].clone(),
                authority:        ctx.accounts.listing_creator.to_account_info(),
                mint:             ra[EX_LP_MINT].clone(),
                system_program:   ctx.accounts.system_program.to_account_info(),
                token_program:    ctx.accounts.token_program.to_account_info(),
            },
        ))?;
    }

    if ra[EX_TREASURY_LP_ATA].data_is_empty() {
        create_ata(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer:            ctx.accounts.matcher.to_account_info(),
                associated_token: ra[EX_TREASURY_LP_ATA].clone(),
                authority:        ra[EX_TREASURY].clone(),
                mint:             ra[EX_LP_MINT].clone(),
                system_program:   ctx.accounts.system_program.to_account_info(),
                token_program:    ctx.accounts.token_program.to_account_info(),
            },
        ))?;
    }

    if ra[EX_INCINERATOR_LP_ATA].data_is_empty() {
        create_ata(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer:            ctx.accounts.matcher.to_account_info(),
                associated_token: ra[EX_INCINERATOR_LP_ATA].clone(),
                authority:        ra[EX_INCINERATOR].clone(),
                mint:             ra[EX_LP_MINT].clone(),
                system_program:   ctx.accounts.system_program.to_account_info(),
                token_program:    ctx.accounts.token_program.to_account_info(),
            },
        ))?;
    }

    // ── 10. DISTRIBUTE LP ───────────────────────────────────────────────────
    if lp_burned > 0 {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from:      ra[EX_MATCHER_LP_TOKEN].clone(),
                    mint:      ra[EX_LP_MINT].clone(),
                    to:        ra[EX_INCINERATOR_LP_ATA].clone(),
                    authority: ctx.accounts.matcher.to_account_info(),
                },
            ),
            lp_burned,
            9,
        )?;
    }

    if lp_treasury > 0 {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from:      ra[EX_MATCHER_LP_TOKEN].clone(),
                    mint:      ra[EX_LP_MINT].clone(),
                    to:        ra[EX_TREASURY_LP_ATA].clone(),
                    authority: ctx.accounts.matcher.to_account_info(),
                },
            ),
            lp_treasury,
            9,
        )?;
    }

    if lp_user_a > 0 {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from:      ra[EX_MATCHER_LP_TOKEN].clone(),
                    mint:      ra[EX_LP_MINT].clone(),
                    to:        ra[EX_CREATOR_LP_ATA].clone(),
                    authority: ctx.accounts.matcher.to_account_info(),
                },
            ),
            lp_user_a,
            9,
        )?;
    }

    // matcher keeps lp_user_b — already in matcher_lp_token, no transfer needed

    // ── 11. COLLECT XNT MATCH FEE → TREASURY ────────────────────────────────
    let is_ecosystem = ra[EX_TOKEN_B_MINT].key() == BRAINS_MINT
                    || ra[EX_TOKEN_B_MINT].key() == LB_MINT;
    let match_fee    = calculate_fee(is_ecosystem, matcher_lb_balance, token_b_usd_val, xnt_price_usd)?;

    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.matcher.to_account_info(),
                to:   ra[EX_TREASURY].clone(),
            },
        ),
        match_fee,
    )?;

    // ── 12. INITIALIZE POOL RECORD ──────────────────────────────────────────
    let pool_record_bump     = ctx.bumps.pool_record;
    let pool_record          = &mut ctx.accounts.pool_record;
    pool_record.pool_address = ra[EX_NEW_POOL_STATE].key();
    pool_record.lp_mint      = ra[EX_LP_MINT].key();
    pool_record.token_a_mint = ctx.accounts.listing_state.token_a_mint;
    pool_record.token_b_mint = ra[EX_TOKEN_B_MINT].key();
    pool_record.sym_a        = [0u8; 12];
    pool_record.sym_b        = [0u8; 12];
    pool_record.burn_bps     = ctx.accounts.listing_state.burn_bps;
    pool_record.lp_burned    = lp_burned;
    pool_record.lp_treasury  = lp_treasury;
    pool_record.lp_to_user_a = lp_user_a;
    pool_record.lp_to_user_b = lp_user_b;
    pool_record.creator_a    = ctx.accounts.listing_state.creator;
    pool_record.creator_b    = ctx.accounts.matcher.key();
    pool_record.usd_val      = ctx.accounts.listing_state.token_a_usd_val;
    pool_record.created_at   = now;
    pool_record.seeded       = false;
    pool_record.bump         = pool_record_bump;

    // ── 13. UPDATE LISTING STATE ────────────────────────────────────────────
    ctx.accounts.listing_state.status = ListingStatus::Matched;

    // ── 14. UPDATE GLOBAL STATE ─────────────────────────────────────────────
    let gs = &mut ctx.accounts.global_state;
    gs.total_pools_created = gs.total_pools_created
        .checked_add(1).ok_or(PairingError::Overflow)?;
    gs.open_listings       = gs.open_listings
        .checked_sub(1).ok_or(PairingError::Overflow)?;
    gs.total_fee_xnt       = gs.total_fee_xnt
        .checked_add(match_fee).ok_or(PairingError::Overflow)?;

    // ── 15. UPDATE MATCHER WALLET STATE ─────────────────────────────────────
    let mws = &mut ctx.accounts.matcher_wallet_state;
    mws.last_match_at = now;
    mws.total_matches = mws.total_matches
        .checked_add(1).ok_or(PairingError::Overflow)?;

    msg!("Match complete! Pool {} created. {} XNT fee.",
        ra[EX_NEW_POOL_STATE].key(), match_fee);

    ctx.accounts.global_state.is_locked = false;
    Ok(())
}
