// programs/brains_pairing/src/instructions/match_listing.rs

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::keccak;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        Mint, TokenAccount, TokenInterface,
        TransferChecked, transfer_checked,
        CloseAccount, close_account,
    },
};
use crate::{constants::*, errors::PairingError, state::*};
use crate::instructions::create_listing::{
    calculate_fee, distribute_lp, read_lb_balance,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CommitMatchParams {
    pub commit_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MatchListingParams {
    pub token_b_amount:   u64,
    pub token_b_usd_val:  u64,
    pub token_b_xnt_val:  u64,
    pub xnt_price_usd:    u64,
    pub price_timestamp:  i64,
    pub price_impact_bps: u64,
    pub open_time:        u64,
    pub amm_config:       Pubkey,
    pub commit_nonce:     Option<[u8; 32]>,
}

// ── Commit accounts ───────────────────────────────────────────────────────────
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
    pub listing_state: Account<'info, ListingState>,

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

// ── Match accounts ────────────────────────────────────────────────────────────
#[derive(Accounts)]
#[instruction(p: MatchListingParams)]
pub struct MatchListing<'info> {
    #[account(mut)]
    pub matcher: Signer<'info>,

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
        seeds  = [b"wallet_state", matcher.key().as_ref()],
        bump,
        payer  = matcher,
        space  = 8 + 46,
    )]
    pub matcher_wallet_state: Account<'info, WalletState>,

    #[account(
        mut,
        seeds  = [b"listing",
                  listing_state.creator.as_ref(),
                  listing_state.token_a_mint.as_ref()],
        bump   = listing_state.bump,
        constraint = listing_state.status == ListingStatus::Open @ PairingError::ListingNotOpen,
        constraint = listing_state.creator != matcher.key()      @ PairingError::SelfMatch,
        close  = listing_creator,
    )]
    pub listing_state: Account<'info, ListingState>,

    /// CHECK: verified against listing_state.creator
    #[account(
        mut,
        constraint = listing_creator.key() == listing_state.creator @ PairingError::Unauthorized,
    )]
    pub listing_creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds  = [b"escrow", listing_state.key().as_ref()],
        bump   = listing_state.escrow_bump,
        token::mint          = token_a_mint,
        token::authority     = escrow_authority,
        token::token_program = token_program_a,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: PDA authority
    #[account(
        seeds = [b"escrow_auth", listing_state.key().as_ref()],
        bump  = listing_state.escrow_auth_bump,
    )]
    pub escrow_authority: UncheckedAccount<'info>,

    pub token_a_mint: InterfaceAccount<'info, Mint>,
    pub token_b_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint          = token_b_mint,
        associated_token::authority     = matcher,
        associated_token::token_program = token_program_b,
    )]
    pub matcher_token_b: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        seeds  = [b"escrow_b", listing_state.key().as_ref()],
        bump,
        payer  = matcher,
        token::mint          = token_b_mint,
        token::authority     = escrow_authority,
        token::token_program = token_program_b,
    )]
    pub escrow_token_b: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: new LP mint created by XDEX
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,

    /// CHECK: escrow LP ATA receives LP from XDEX
    #[account(mut)]
    pub escrow_lp: UncheckedAccount<'info>,

    /// CHECK: new XDEX pool state — must be empty
    #[account(mut, constraint = new_pool_state.data_is_empty() @ PairingError::PoolExists)]
    pub new_pool_state: UncheckedAccount<'info>,

    /// CHECK: XDEX pool vault A
    #[account(mut)]
    pub pool_vault_a: UncheckedAccount<'info>,

    /// CHECK: XDEX pool vault B
    #[account(mut)]
    pub pool_vault_b: UncheckedAccount<'info>,

    /// CHECK: XDEX observation state
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    /// CHECK: token_b/XNT pool — must exist
    #[account(constraint = token_b_xnt_pool.data_len() > 0 @ PairingError::NoXntPool)]
    pub token_b_xnt_pool: UncheckedAccount<'info>,

    /// CHECK: XNT vault in token_b/XNT pool
    pub pool_vault_xnt: UncheckedAccount<'info>,

    /// CHECK: creator LP destination
    #[account(mut)]
    pub creator_lp_ata: UncheckedAccount<'info>,

    /// CHECK: matcher LP destination
    #[account(mut)]
    pub matcher_lp_ata: UncheckedAccount<'info>,

    /// CHECK: treasury LP destination
    #[account(mut)]
    pub treasury_lp_ata: UncheckedAccount<'info>,

    /// CHECK: incinerator
    #[account(constraint = incinerator.key() == INCINERATOR @ PairingError::Unauthorized)]
    pub incinerator: UncheckedAccount<'info>,

    /// CHECK: hardcoded treasury
    #[account(
        mut,
        constraint = treasury.key() == TREASURY_WALLET @ PairingError::InvalidTreasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: optional LB for fee discount
    pub matcher_lb_account: Option<UncheckedAccount<'info>>,

    #[account(
        init,
        seeds  = [b"pool_record", new_pool_state.key().as_ref()],
        bump,
        payer  = matcher,
        space  = 8 + 274,
    )]
    pub pool_record: Account<'info, PoolRecord>,

    #[account(
        mut,
        seeds  = [b"commitment", matcher.key().as_ref(), listing_state.key().as_ref()],
        bump,
    )]
    pub match_commitment: Option<Account<'info, MatchCommitment>>,

    /// CHECK: slot hashes sysvar
    pub slot_hashes: UncheckedAccount<'info>,

    /// CHECK: XDEX program hardcoded
    #[account(constraint = xdex_program.key() == XDEX_PROGRAM @ PairingError::InvalidXdexProgram)]
    pub xdex_program: UncheckedAccount<'info>,

    pub token_program_a:          Interface<'info, TokenInterface>,
    pub token_program_b:          Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program:           Program<'info, System>,
    pub rent:                     Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<MatchListing>, p: MatchListingParams) -> Result<()> {
    let now          = Clock::get()?.unix_timestamp;
    let current_slot = Clock::get()?.slot;

    ctx.accounts.global_state.is_locked = true;

    require!(!ctx.accounts.matcher_wallet_state.is_flagged, PairingError::WalletFlagged);

    // Price validation
    require!(p.token_b_usd_val > 0,   PairingError::InvalidPrice);
    require!(p.xnt_price_usd > 0,     PairingError::InvalidPrice);
    require!(p.price_timestamp <= now, PairingError::InvalidTimestamp);
    require!(
        now.checked_sub(p.price_timestamp)
           .ok_or(PairingError::Overflow)? <= MAX_PRICE_AGE_SECS,
        PairingError::PriceStale
    );

    // Price impact check
    require!(p.price_impact_bps <= MAX_PRICE_IMPACT_BPS, PairingError::PriceImpactTooHigh);

    // AMM config validation
    require!(
        p.amm_config == XDEX_AMM_CONFIG_A || p.amm_config == XDEX_AMM_CONFIG_B,
        PairingError::InvalidAmmConfig
    );

    // USD parity check — 0.5% tolerance
    let usd_a     = ctx.accounts.listing_state.token_a_usd_val;
    let usd_b     = p.token_b_usd_val;
    let diff      = if usd_a > usd_b { usd_a - usd_b } else { usd_b - usd_a };
    let tolerance = usd_a
        .checked_mul(SLIPPAGE_BPS).ok_or(PairingError::Overflow)?
        .checked_div(10_000).ok_or(PairingError::Overflow)?;
    require!(diff <= tolerance, PairingError::PriceMismatch);

    // Pool TVL check
    {
        let vault_data = ctx.accounts.pool_vault_xnt.try_borrow_data()?;
        require!(vault_data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8, PairingError::InvalidPoolData);
        let vault_xnt = u64::from_le_bytes(
            vault_data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                .try_into().map_err(|_| PairingError::InvalidPoolData)?
        );
        require!(vault_xnt >= MIN_POOL_TVL_LAMPORTS, PairingError::PoolTvlTooLow);
    }

    // Pool age check
    {
        let pool_data = ctx.accounts.token_b_xnt_pool.try_borrow_data()?;
        require!(pool_data.len() >= XDEX_POOL_CREATED_AT_OFFSET + 8, PairingError::InvalidPoolData);
        let pool_created_at = i64::from_le_bytes(
            pool_data[XDEX_POOL_CREATED_AT_OFFSET..XDEX_POOL_CREATED_AT_OFFSET + 8]
                .try_into().map_err(|_| PairingError::InvalidPoolData)?
        );
        let pool_age = now.checked_sub(pool_created_at).ok_or(PairingError::Overflow)?;
        require!(pool_age >= MIN_POOL_AGE_SECS, PairingError::PoolTooNew);
    }

    // Slot hash binding
    {
        let slot_data = ctx.accounts.slot_hashes.try_borrow_data()?;
        require!(slot_data.len() >= 16, PairingError::InvalidSysvar);
        let recent_slot = u64::from_le_bytes(
            slot_data[8..16].try_into().map_err(|_| PairingError::InvalidSysvar)?
        );
        require!(
            current_slot.saturating_sub(recent_slot) <= COMMIT_EXPIRY_SLOTS,
            PairingError::TransactionTooOld
        );
    }

    // Commit-reveal for large listings
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

    // Transfer token B to temp escrow
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program_b.to_account_info(),
            TransferChecked {
                from:      ctx.accounts.matcher_token_b.to_account_info(),
                mint:      ctx.accounts.token_b_mint.to_account_info(),
                to:        ctx.accounts.escrow_token_b.to_account_info(),
                authority: ctx.accounts.matcher.to_account_info(),
            },
        ),
        p.token_b_amount,
        ctx.accounts.token_b_mint.decimals,
    )?;

    // Build XDEX Initialize CPI data
    let mut ix_data = Vec::with_capacity(32);
    ix_data.extend_from_slice(&DISC_INITIALIZE);
    ix_data.extend_from_slice(&ctx.accounts.listing_state.token_a_amount.to_le_bytes());
    ix_data.extend_from_slice(&p.token_b_amount.to_le_bytes());
    ix_data.extend_from_slice(&p.open_time.to_le_bytes());

    let xdex_accounts = vec![
        AccountMeta::new(ctx.accounts.escrow_authority.key(), true),
        AccountMeta::new_readonly(p.amm_config, false),
        AccountMeta::new_readonly(XDEX_LP_AUTH, false),
        AccountMeta::new(ctx.accounts.new_pool_state.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_a_mint.key(), false),
        AccountMeta::new_readonly(ctx.accounts.token_b_mint.key(), false),
        AccountMeta::new(ctx.accounts.lp_mint.key(), false),
        AccountMeta::new(ctx.accounts.escrow.key(), false),
        AccountMeta::new(ctx.accounts.escrow_token_b.key(), false),
        AccountMeta::new(ctx.accounts.escrow_lp.key(), false),
        AccountMeta::new(ctx.accounts.pool_vault_a.key(), false),
        AccountMeta::new(ctx.accounts.pool_vault_b.key(), false),
        AccountMeta::new(XDEX_FEE_VAULT, false),
        AccountMeta::new(ctx.accounts.observation_state.key(), false),
        AccountMeta::new_readonly(anchor_spl::token::spl_token::ID, false),
        AccountMeta::new_readonly(anchor_spl::token_2022::spl_token_2022::ID, false),
        AccountMeta::new_readonly(anchor_spl::token_2022::spl_token_2022::ID, false),
        AccountMeta::new_readonly(anchor_spl::associated_token::spl_associated_token_account::ID, false),
        AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        AccountMeta::new_readonly(anchor_lang::solana_program::sysvar::rent::ID, false),
    ];

    let listing_key      = ctx.accounts.listing_state.key();
    let escrow_auth_bump = ctx.accounts.listing_state.escrow_auth_bump;
    let signer_seeds     = &[b"escrow_auth", listing_key.as_ref(), &[escrow_auth_bump]];

    let all_infos = vec![
        ctx.accounts.escrow_authority.to_account_info(),
        ctx.accounts.new_pool_state.to_account_info(),
        ctx.accounts.token_a_mint.to_account_info(),
        ctx.accounts.token_b_mint.to_account_info(),
        ctx.accounts.lp_mint.to_account_info(),
        ctx.accounts.escrow.to_account_info(),
        ctx.accounts.escrow_token_b.to_account_info(),
        ctx.accounts.escrow_lp.to_account_info(),
        ctx.accounts.pool_vault_a.to_account_info(),
        ctx.accounts.pool_vault_b.to_account_info(),
        ctx.accounts.observation_state.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.rent.to_account_info(),
    ];

    invoke_signed(
        &Instruction {
            program_id: XDEX_PROGRAM,
            accounts:   xdex_accounts,
            data:       ix_data,
        },
        &all_infos,
        &[signer_seeds],
    )?;

    // Verify LP received post-CPI
    let lp_received = {
        let lp_data = ctx.accounts.escrow_lp.try_borrow_data()?;
        if lp_data.len() >= TOKEN_ACCOUNT_AMOUNT_OFFSET + 8 {
            u64::from_le_bytes(
                lp_data[TOKEN_ACCOUNT_AMOUNT_OFFSET..TOKEN_ACCOUNT_AMOUNT_OFFSET + 8]
                    .try_into().map_err(|_| PairingError::InvalidPoolData)?
            )
        } else { 0u64 }
    };
    require!(lp_received > XDEX_MIN_LP_LOCK, PairingError::InsufficientLpReceived);

    // Distribute LP
    let (lp_burned, lp_treasury, lp_user_a, lp_user_b) =
        distribute_lp(lp_received, ctx.accounts.listing_state.burn_bps)?;

    msg!("LP distribution: minted={} burned={} treasury={} user_a={} user_b={}",
        lp_received, lp_burned, lp_treasury, lp_user_a, lp_user_b);

    // TODO: Execute LP transfers to incinerator, treasury, user_a, user_b
    // These require the LP ATA accounts to be set up with correct token program
    // LP token transfers will be added once LP mint is known post-CPI

    // Collect matching fee
    let lb_balance  = read_lb_balance(&ctx.accounts.matcher_lb_account)?;
    let is_ecosystem = ctx.accounts.token_b_mint.key() == BRAINS_MINT
                    || ctx.accounts.token_b_mint.key() == LB_MINT;
    let match_fee   = calculate_fee(is_ecosystem, lb_balance, usd_b, p.xnt_price_usd)?;

    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.matcher.to_account_info(),
                to:   ctx.accounts.treasury.to_account_info(),
            },
        ),
        match_fee,
    )?;

    // Create pool record
    let pool_record          = &mut ctx.accounts.pool_record;
    pool_record.pool_address = ctx.accounts.new_pool_state.key();
    pool_record.lp_mint      = ctx.accounts.lp_mint.key();
    pool_record.token_a_mint = ctx.accounts.listing_state.token_a_mint;
    pool_record.token_b_mint = ctx.accounts.token_b_mint.key();
    pool_record.burn_bps     = ctx.accounts.listing_state.burn_bps;
    pool_record.lp_burned    = lp_burned;
    pool_record.lp_treasury  = lp_treasury;
    pool_record.lp_to_user_a = lp_user_a;
    pool_record.lp_to_user_b = lp_user_b;
    pool_record.creator_a    = ctx.accounts.listing_state.creator;
    pool_record.creator_b    = ctx.accounts.matcher.key();
    pool_record.usd_val      = usd_a;
    pool_record.created_at   = now;
    pool_record.seeded       = false;
    pool_record.bump         = ctx.bumps.pool_record;

    // Update listing status
    ctx.accounts.listing_state.status = ListingStatus::Matched;

    // Update global state
    let gs = &mut ctx.accounts.global_state;
    gs.total_pools_created = gs.total_pools_created.checked_add(1).ok_or(PairingError::Overflow)?;
    gs.open_listings       = gs.open_listings.checked_sub(1).ok_or(PairingError::Overflow)?;
    gs.total_fee_xnt       = gs.total_fee_xnt.checked_add(match_fee).ok_or(PairingError::Overflow)?;

    // Update matcher wallet state
    ctx.accounts.matcher_wallet_state.last_match_at = now;
    ctx.accounts.matcher_wallet_state.total_matches =
        ctx.accounts.matcher_wallet_state.total_matches
            .checked_add(1).ok_or(PairingError::Overflow)?;

    ctx.accounts.global_state.is_locked = false;
    Ok(())
}
