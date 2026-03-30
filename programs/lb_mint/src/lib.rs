// programs/lb_mint/src/lib.rs
// ─────────────────────────────────────────────────────────────────────────────
// LAB WORK (LB) MINT PROGRAM — Token-2022
// Extensions initialized manually via CPI (Anchor 0.31.1 compatible)
// ─────────────────────────────────────────────────────────────────────────────
//
// LB Token — Token-2022:
//   TransferFeeConfig  — 0.04% (4 bps) fee on every transfer, no cap
//   MetadataPointer    — metadata stored on the mint account itself
//
// MINT MATH
// ─────────────────────────────────────────────────────────────────────────────
// Base LB (tier-based, BRAINS required, exact multiple enforced):
//   lb_from_brains = brains_amount / tier.brains_per_lb
//
// Bonus LB (Xenblocks, optional, exact multiples enforced):
//   lb_from_xnm  = xnm_amount  / 1_000        (must be multiple of 1,000)
//   lb_from_xuni = (xuni_amount / 500) * 4     (must be multiple of 500)
//   lb_from_xblk = xblk_amount * 8             (whole numbers)
//
//   total_lb = lb_from_brains + lb_from_xnm + lb_from_xuni + lb_from_xblk
//
// XNT fee  = lb_from_brains * tier.xnt_lamports_per_lb (Xenblocks bonus LB is fee-free)
// BRAINS   = 100% burned via Token-2022 CPI
// Xenblocks = 50% burned on-chain + 50% → treasury ATA
//
// Supply hard cap: 100,000 LB · Admin pause · Decimals: 2
// ─────────────────────────────────────────────────────────────────────────────

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Token, Burn, Transfer};
use anchor_spl::token_interface::{
    self as token_interface,
    Mint,
    TokenAccount,
    MintTo,
    Burn as BurnInterface,
};
use anchor_spl::token_2022::Token2022;

use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_fee::instruction as transfer_fee_ix,
        metadata_pointer::instruction as metadata_pointer_ix,
        ExtensionType,
    },
    instruction as token2022_ix,
    state::Mint as SplMint,
};
use anchor_spl::token_2022::spl_token_2022::extension::transfer_fee::instruction::{
    harvest_withheld_tokens_to_mint,
    withdraw_withheld_tokens_from_mint,
};

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

declare_id!("3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN");

// ─── Security contact ────────────────────────────────────────────────────────

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name:        "Lab Work (LB) Mint",
    project_url: "https://x1brains.io",
    contacts:    "twitter:@x1brains,telegram:https://t.me/x1brains",
    policy:      "https://x1brains.io",
    source_code: "https://github.com/x1Brains/x1brainsv1"
}

// ─── Compile-time Pubkey constants ───────────────────────────────────────────

pub const TREASURY_KEY: Pubkey = pubkey!("CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF");
pub const BRAINS_KEY:   Pubkey = pubkey!("EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN");
pub const XNM_KEY:      Pubkey = pubkey!("XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m");
pub const XUNI_KEY:     Pubkey = pubkey!("XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm");
pub const XBLK_KEY:     Pubkey = pubkey!("XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T");

// ─── Token constants ──────────────────────────────────────────────────────────

pub const LB_DECIMALS:      u8   = 2;
pub const LB_MULTIPLIER:    u64  = 100;
pub const LB_NAME:          &str = "Lab Work";
pub const LB_SYMBOL:        &str = "LB";
pub const TRANSFER_FEE_BPS: u16  = 4;
pub const TRANSFER_FEE_MAX: u64  = u64::MAX;

// ─── Tokenomics constants ─────────────────────────────────────────────────────

pub const TOTAL_SUPPLY:      u64 = 100_000;
pub const TIER_SIZE:         u64 = 25_000;
pub const XNM_PER_LB:        u64 = 1_000;
pub const XUNI_STEP:         u64 = 500;
pub const XUNI_LB_PER_STEP:  u64 = 4;
pub const XBLK_LB_PER_TOKEN: u64 = 8;

// (brains_per_lb, xnt_lamports_per_lb)
const TIERS: [(u64, u64); 4] = [
    (8,  500_000_000),
    (18, 750_000_000),
    (26, 1_000_000_000),
    (33, 1_500_000_000),
];

// ─── PDA seeds ────────────────────────────────────────────────────────────────

pub const STATE_SEED:     &[u8] = b"lb_state";
pub const MINT_AUTH_SEED: &[u8] = b"lb_mint_auth";
pub const LB_MINT_SEED:   &[u8] = b"lb_mint";

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn get_tier(total_minted: u64) -> (u64, u64) {
    let idx = ((total_minted / TIER_SIZE) as usize).min(3);
    TIERS[idx]
}

fn calc_lb_from_brains(brains_amount: u64, brains_per_lb: u64) -> Result<u64> {
    require!(brains_amount % brains_per_lb == 0, LbError::BrainsNotMultiple);
    Ok(brains_amount / brains_per_lb)
}

fn calc_lb_from_xnm(xnm: u64)   -> u64 { xnm / XNM_PER_LB }
fn calc_lb_from_xuni(xuni: u64)  -> u64 { (xuni / XUNI_STEP) * XUNI_LB_PER_STEP }
fn calc_lb_from_xblk(xblk: u64) -> u64 { xblk * XBLK_LB_PER_TOKEN }

/// 50% burn, 50% treasury — treasury gets the odd unit on odd amounts
fn split_xenblocks(raw: u64) -> (u64, u64) {
    let burn_half = raw / 2;
    (burn_half, raw - burn_half)
}

// ─── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod lb_mint {
    use super::*;

    // ── initialize ───────────────────────────────────────────────────────────
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state          = &mut ctx.accounts.state;
        state.admin        = ctx.accounts.admin.key();
        state.treasury     = TREASURY_KEY;
        state.lb_mint      = ctx.accounts.lb_mint.key();
        state.total_minted = 0;
        state.paused       = false;
        state.bump         = ctx.bumps.state;
        state._reserved    = [0u8; 32];

        let mint_key      = ctx.accounts.lb_mint.key();
        let mint_auth_key = ctx.accounts.lb_mint_authority.key();
        let state_key     = ctx.accounts.state.key();

        let lb_mint_bump = ctx.bumps.lb_mint;
        let lb_mint_seeds: &[&[u8]] = &[LB_MINT_SEED, &[lb_mint_bump]];
        let lb_mint_signer = &[lb_mint_seeds];

        let extension_types = vec![
            ExtensionType::TransferFeeConfig,
            ExtensionType::MetadataPointer,
        ];
        let mint_size = ExtensionType::try_calculate_account_len::<SplMint>(&extension_types)
            .map_err(|_| LbError::Overflow)?;

        let rent     = Rent::get()?;
        let lamports = rent.minimum_balance(mint_size);

        // 1. Create mint account
        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.admin.key,
                &mint_key,
                lamports,
                mint_size as u64,
                &anchor_spl::token_2022::spl_token_2022::id(),
            ),
            &[
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.lb_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            lb_mint_signer,
        )?;

        // 2. InitializeTransferFeeConfig
        let init_fee_ix = transfer_fee_ix::initialize_transfer_fee_config(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &mint_key,
            Some(&mint_auth_key),
            Some(&mint_auth_key),
            TRANSFER_FEE_BPS,
            TRANSFER_FEE_MAX,
        )?;
        invoke_signed(&init_fee_ix, &[ctx.accounts.lb_mint.to_account_info()], &[])?;

        // 3. InitializeMetadataPointer (points to self)
        let init_meta_ptr_ix = metadata_pointer_ix::initialize(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &mint_key,
            Some(state_key),
            Some(mint_key),
        )?;
        invoke_signed(&init_meta_ptr_ix, &[ctx.accounts.lb_mint.to_account_info()], &[])?;

        // 4. InitializeMint2
        let init_mint_ix = token2022_ix::initialize_mint2(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &mint_key,
            &mint_auth_key,
            Some(&mint_auth_key),
            LB_DECIMALS,
        )?;
        invoke_signed(&init_mint_ix, &[ctx.accounts.lb_mint.to_account_info()], &[])?;

        // 5. InitializeTokenMetadata
        let init_meta_ix = anchor_spl::token_interface::spl_token_metadata_interface::instruction::initialize(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &mint_key,
            &state_key,
            &mint_key,
            &state_key,
            LB_NAME.to_string(),
            LB_SYMBOL.to_string(),
            String::new(),
        );
        let state_bump = ctx.bumps.state;
        let state_seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];
        let state_signer = &[state_seeds];
        invoke_signed(
            &init_meta_ix,
            &[
                ctx.accounts.lb_mint.to_account_info(),
                ctx.accounts.state.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            state_signer,
        )?;

        msg!("LB Mint initialized. Mint: {} | Fee: {} bps | Cap: {}", mint_key, TRANSFER_FEE_BPS, TOTAL_SUPPLY);
        Ok(())
    }

    // ── update_admin ─────────────────────────────────────────────────────────
    pub fn update_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.state.admin = new_admin;
        msg!("Admin transferred to: {}", new_admin);
        Ok(())
    }

    // ── initialize_metadata ──────────────────────────────────────────────────
    pub fn initialize_metadata(
        ctx: Context<AdminOnly>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        require!(uri.len() <= 200, LbError::UriTooLong);
        let ix = anchor_spl::token_interface::spl_token_metadata_interface::instruction::initialize(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &ctx.accounts.lb_mint.key(),
            &ctx.accounts.state.key(),
            &ctx.accounts.lb_mint.key(),
            &ctx.accounts.lb_mint_authority.key(),
            name.clone(),
            symbol.clone(),
            uri.clone(),
        );
        let auth_bump = ctx.bumps.lb_mint_authority;
        let auth_seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[auth_bump]];
        let auth_signer = &[auth_seeds];
        invoke_signed(
            &ix,
            &[
                ctx.accounts.lb_mint.to_account_info(),
                ctx.accounts.state.to_account_info(),
                ctx.accounts.lb_mint_authority.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            auth_signer,
        )?;
        msg!("LB metadata initialized: name={} symbol={} uri={}", name, symbol, uri);
        Ok(())
    }

    // ── update_metadata_uri ──────────────────────────────────────────────────
    pub fn update_metadata_uri(ctx: Context<AdminOnly>, new_uri: String) -> Result<()> {
        require!(new_uri.len() <= 200, LbError::UriTooLong);
        let state_bump = ctx.accounts.state.bump;
        let seeds: &[&[u8]] = &[STATE_SEED, &[state_bump]];
        let signer = &[seeds];
        let ix = anchor_spl::token_interface::spl_token_metadata_interface::instruction::update_field(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &ctx.accounts.lb_mint.key(),
            &ctx.accounts.state.key(),
            anchor_spl::token_interface::spl_token_metadata_interface::state::Field::Uri,
            new_uri.clone(),
        );
        invoke_signed(
            &ix,
            &[
                ctx.accounts.lb_mint.to_account_info(),
                ctx.accounts.state.to_account_info(),
            ],
            signer,
        )?;
        msg!("LB metadata URI updated: {}", new_uri);
        Ok(())
    }

    // ── pause / unpause ──────────────────────────────────────────────────────
    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.state.paused = true;
        msg!("LB Mint PAUSED");
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.state.paused = false;
        msg!("LB Mint UNPAUSED");
        Ok(())
    }

    // ── collect_fees ─────────────────────────────────────────────────────────
    pub fn collect_fees<'info>(ctx: Context<'_, '_, '_, 'info, CollectFees<'info>>) -> Result<()> {
        let lb_mint_key = ctx.accounts.lb_mint.key();
        let auth_bump   = ctx.bumps.lb_mint_authority;
        let auth_seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[auth_bump]];
        let signer = &[auth_seeds];

        if !ctx.remaining_accounts.is_empty() {
            let source_pubkeys: Vec<&Pubkey> = ctx.remaining_accounts.iter()
                .map(|a| a.key)
                .collect();
            let harvest_ix = harvest_withheld_tokens_to_mint(
                &anchor_spl::token_2022::spl_token_2022::id(),
                &lb_mint_key,
                source_pubkeys.as_slice(),
            )?;
            let mut infos: Vec<AccountInfo<'info>> = vec![ctx.accounts.lb_mint.to_account_info()];
            infos.extend(ctx.remaining_accounts.iter().cloned());
            invoke_signed(&harvest_ix, &infos, &[])?;
        }

        let withdraw_ix = withdraw_withheld_tokens_from_mint(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &lb_mint_key,
            &ctx.accounts.treasury_lb_ata.key(),
            &ctx.accounts.lb_mint_authority.key(),
            &[],
        )?;
        invoke_signed(
            &withdraw_ix,
            &[
                ctx.accounts.lb_mint.to_account_info(),
                ctx.accounts.treasury_lb_ata.to_account_info(),
                ctx.accounts.lb_mint_authority.to_account_info(),
            ],
            signer,
        )?;

        msg!("Fees swept → {}", ctx.accounts.treasury_lb_ata.key());
        Ok(())
    }

    // ── mint_lb ──────────────────────────────────────────────────────────────
    // NOTE: XNT fee is paid HERE inside the program via system_program::transfer.
    // The frontend must NOT send a separate SystemProgram.transfer for XNT —
    // that would double-charge the buyer.
    pub fn mint_lb(ctx: Context<MintLb>, brains_amount: u64) -> Result<()> {
        let state = &ctx.accounts.state;

        require!(!state.paused,     LbError::Paused);
        require!(brains_amount > 0, LbError::ZeroAmount);

        let (brains_per_lb, xnt_lamports_per_lb) = get_tier(state.total_minted);
        let lb_amount = calc_lb_from_brains(brains_amount, brains_per_lb)?;
        require!(lb_amount > 0, LbError::ZeroAmount);
        require!(
            state.total_minted.checked_add(lb_amount).ok_or(LbError::Overflow)? <= TOTAL_SUPPLY,
            LbError::SupplyExhausted
        );

        // 1. Burn BRAINS (Token-2022) — 100% deflationary
        let b_dec      = ctx.accounts.brains_mint.decimals;
        let brains_raw = brains_amount
            .checked_mul(10u64.pow(b_dec as u32))
            .ok_or(LbError::Overflow)?;
        require!(ctx.accounts.buyer_brains_ata.amount >= brains_raw, LbError::InsufficientBrains);

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
                BurnInterface {
                    mint:      ctx.accounts.brains_mint.to_account_info(),
                    from:      ctx.accounts.buyer_brains_ata.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            brains_raw,
        )?;

        // 2. Pay XNT fee → treasury (program handles this atomically)
        let xnt_total = xnt_lamports_per_lb
            .checked_mul(lb_amount)
            .ok_or(LbError::Overflow)?;
        require!(ctx.accounts.buyer.lamports() >= xnt_total, LbError::InsufficientXnt);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to:   ctx.accounts.treasury.to_account_info(),
                },
            ),
            xnt_total,
        )?;

        // 3. Mint LB → buyer ATA
        let bump   = ctx.bumps.lb_mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[bump]];
        let signer = &[seeds];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.lb_mint.to_account_info(),
                    to:        ctx.accounts.buyer_lb_ata.to_account_info(),
                    authority: ctx.accounts.lb_mint_authority.to_account_info(),
                },
                signer,
            ),
            lb_amount.checked_mul(LB_MULTIPLIER).ok_or(LbError::Overflow)?,
        )?;

        // 4. Update supply counter
        let state = &mut ctx.accounts.state;
        state.total_minted = state.total_minted
            .checked_add(lb_amount).ok_or(LbError::Overflow)?;

        msg!(
            "mint_lb: {} BRAINS burned | {} lamports XNT | {} LB minted | total {}/{}",
            brains_raw, xnt_total, lb_amount, state.total_minted, TOTAL_SUPPLY
        );

        // 5. Sweep withheld transfer fees → treasury (best-effort, non-fatal)
        let bump_binding = [bump];
        let fee_seeds: &[&[u8]] = &[MINT_AUTH_SEED, &bump_binding];
        let fee_signer = &[fee_seeds];
        if let Ok(w_ix) = withdraw_withheld_tokens_from_mint(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &ctx.accounts.lb_mint.key(),
            &ctx.accounts.treasury_lb_ata.key(),
            &ctx.accounts.lb_mint_authority.key(),
            &[],
        ) {
            let _ = invoke_signed(
                &w_ix,
                &[
                    ctx.accounts.lb_mint.to_account_info(),
                    ctx.accounts.treasury_lb_ata.to_account_info(),
                    ctx.accounts.lb_mint_authority.to_account_info(),
                ],
                fee_signer,
            );
        }
        Ok(())
    }

    // ── combo_mint_lb ────────────────────────────────────────────────────────
    // FIXED: All heavy typed accounts wrapped in Box<> — solves 9024-byte stack overflow.
    // FIXED: XNT fee paid here atomically — frontend must NOT send extra SystemProgram.transfer.
    // Xenblocks split: 50% burned on-chain forever, 50% → treasury ATA (NOT LP pools).
    // XNT fee applies to base_lb only — Xenblocks bonus LB is fee-free.
    pub fn combo_mint_lb(
        ctx: Context<ComboMintLb>,
        brains_amount: u64,
        xnm_amount:    u64,
        xuni_amount:   u64,
        xblk_amount:   u64,
    ) -> Result<()> {
        let state = &ctx.accounts.state;

        require!(!state.paused,     LbError::Paused);
        require!(brains_amount > 0, LbError::ZeroAmount);
        require!(xnm_amount > 0 || xuni_amount > 0 || xblk_amount > 0, LbError::NoXenblocks);
        if xnm_amount  > 0 { require!(xnm_amount  % XNM_PER_LB == 0, LbError::XnmNotMultiple);  }
        if xuni_amount > 0 { require!(xuni_amount  % XUNI_STEP  == 0, LbError::XuniNotMultiple); }

        let (brains_per_lb, xnt_lamports_per_lb) = get_tier(state.total_minted);
        let base_lb  = calc_lb_from_brains(brains_amount, brains_per_lb)?;
        require!(base_lb > 0, LbError::ZeroAmount);

        let xnm_lb   = calc_lb_from_xnm(xnm_amount);
        let xuni_lb  = calc_lb_from_xuni(xuni_amount);
        let xblk_lb  = calc_lb_from_xblk(xblk_amount);
        let total_lb = base_lb
            .checked_add(xnm_lb) .ok_or(LbError::Overflow)?
            .checked_add(xuni_lb).ok_or(LbError::Overflow)?
            .checked_add(xblk_lb).ok_or(LbError::Overflow)?;

        require!(
            state.total_minted.checked_add(total_lb).ok_or(LbError::Overflow)? <= TOTAL_SUPPLY,
            LbError::SupplyExhausted
        );

        // 1. Burn BRAINS (Token-2022) — 100% deflationary
        let b_dec      = ctx.accounts.brains_mint.decimals;
        let brains_raw = brains_amount
            .checked_mul(10u64.pow(b_dec as u32))
            .ok_or(LbError::Overflow)?;
        require!(ctx.accounts.buyer_brains_ata.amount >= brains_raw, LbError::InsufficientBrains);
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
                BurnInterface {
                    mint:      ctx.accounts.brains_mint.to_account_info(),
                    from:      ctx.accounts.buyer_brains_ata.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            brains_raw,
        )?;

        // 2. Pay XNT fee on base_lb only (Xenblocks bonus LB is fee-free)
        let xnt_total = xnt_lamports_per_lb.checked_mul(base_lb).ok_or(LbError::Overflow)?;
        require!(ctx.accounts.buyer.lamports() >= xnt_total, LbError::InsufficientXnt);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to:   ctx.accounts.treasury.to_account_info(),
                },
            ),
            xnt_total,
        )?;

        // 3. XNM: 50% burned forever, 50% → treasury ATA
        if xnm_amount > 0 {
            let dec = ctx.accounts.xnm_mint.decimals;
            let raw = xnm_amount.checked_mul(10u64.pow(dec as u32)).ok_or(LbError::Overflow)?;
            require!(ctx.accounts.buyer_xnm_ata.amount >= raw, LbError::InsufficientXnm);
            let (to_burn, to_treasury) = split_xenblocks(raw);
            if to_burn > 0 {
                token::burn(CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint:      ctx.accounts.xnm_mint.to_account_info(),
                        from:      ctx.accounts.buyer_xnm_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ), to_burn)?;
            }
            if to_treasury > 0 {
                token::transfer(CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.buyer_xnm_ata.to_account_info(),
                        to:        ctx.accounts.treasury_xnm_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ), to_treasury)?;
            }
        }

        // 4. XUNI: 50% burned forever, 50% → treasury ATA
        if xuni_amount > 0 {
            let dec = ctx.accounts.xuni_mint.decimals;
            let raw = xuni_amount.checked_mul(10u64.pow(dec as u32)).ok_or(LbError::Overflow)?;
            require!(ctx.accounts.buyer_xuni_ata.amount >= raw, LbError::InsufficientXuni);
            let (to_burn, to_treasury) = split_xenblocks(raw);
            if to_burn > 0 {
                token::burn(CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint:      ctx.accounts.xuni_mint.to_account_info(),
                        from:      ctx.accounts.buyer_xuni_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ), to_burn)?;
            }
            if to_treasury > 0 {
                token::transfer(CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.buyer_xuni_ata.to_account_info(),
                        to:        ctx.accounts.treasury_xuni_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ), to_treasury)?;
            }
        }

        // 5. XBLK: 50% burned forever, 50% → treasury ATA
        if xblk_amount > 0 {
            let dec = ctx.accounts.xblk_mint.decimals;
            let raw = xblk_amount.checked_mul(10u64.pow(dec as u32)).ok_or(LbError::Overflow)?;
            require!(ctx.accounts.buyer_xblk_ata.amount >= raw, LbError::InsufficientXblk);
            let (to_burn, to_treasury) = split_xenblocks(raw);
            if to_burn > 0 {
                token::burn(CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint:      ctx.accounts.xblk_mint.to_account_info(),
                        from:      ctx.accounts.buyer_xblk_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ), to_burn)?;
            }
            if to_treasury > 0 {
                token::transfer(CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from:      ctx.accounts.buyer_xblk_ata.to_account_info(),
                        to:        ctx.accounts.treasury_xblk_ata.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ), to_treasury)?;
            }
        }

        // 6. Mint total LB → buyer ATA
        let bump   = ctx.bumps.lb_mint_authority;
        let seeds: &[&[u8]] = &[MINT_AUTH_SEED, &[bump]];
        let signer = &[seeds];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                MintTo {
                    mint:      ctx.accounts.lb_mint.to_account_info(),
                    to:        ctx.accounts.buyer_lb_ata.to_account_info(),
                    authority: ctx.accounts.lb_mint_authority.to_account_info(),
                },
                signer,
            ),
            total_lb.checked_mul(LB_MULTIPLIER).ok_or(LbError::Overflow)?,
        )?;

        // 7. Update supply counter
        let state = &mut ctx.accounts.state;
        state.total_minted = state.total_minted
            .checked_add(total_lb).ok_or(LbError::Overflow)?;

        msg!(
            "combo_mint_lb: {} BRAINS | {} lam XNT | +{}xnm +{}xuni +{}xblk | {} LB | {}/{}",
            brains_raw, xnt_total, xnm_lb, xuni_lb, xblk_lb,
            total_lb, state.total_minted, TOTAL_SUPPLY
        );

        // 8. Sweep withheld transfer fees → treasury (best-effort, non-fatal)
        let bump_binding = [bump];
        let fee_seeds: &[&[u8]] = &[MINT_AUTH_SEED, &bump_binding];
        let fee_signer = &[fee_seeds];
        if let Ok(w_ix) = withdraw_withheld_tokens_from_mint(
            &anchor_spl::token_2022::spl_token_2022::id(),
            &ctx.accounts.lb_mint.key(),
            &ctx.accounts.treasury_lb_ata.key(),
            &ctx.accounts.lb_mint_authority.key(),
            &[],
        ) {
            let _ = invoke_signed(
                &w_ix,
                &[
                    ctx.accounts.lb_mint.to_account_info(),
                    ctx.accounts.treasury_lb_ata.to_account_info(),
                    ctx.accounts.lb_mint_authority.to_account_info(),
                ],
                fee_signer,
            );
        }
        Ok(())
    }
}

// ─── Account Structs ──────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct GlobalState {
    pub admin:         Pubkey,   // 32
    pub treasury:      Pubkey,   // 32
    pub lb_mint:       Pubkey,   // 32
    pub total_minted:  u64,      //  8
    pub paused:        bool,     //  1
    pub bump:          u8,       //  1
    pub _reserved:     [u8; 32], // 32
}
impl GlobalState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 1 + 1 + 32; // = 146
}

// ─── Instruction Contexts ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init, payer = admin,
        space = GlobalState::LEN,
        seeds = [STATE_SEED], bump,
    )]
    pub state: Account<'info, GlobalState>,

    /// CHECK: Created manually via system_instruction::create_account
    #[account(mut, seeds = [LB_MINT_SEED], bump)]
    pub lb_mint: AccountInfo<'info>,

    /// CHECK: PDA — mint authority + fee withdraw authority
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub lb_mint_authority: AccountInfo<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program:     Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, constraint = admin.key() == state.admin @ LbError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Account<'info, GlobalState>,

    /// CHECK: LB mint — used for metadata updates
    #[account(mut, seeds = [LB_MINT_SEED], bump)]
    pub lb_mint: AccountInfo<'info>,

    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub lb_mint_authority: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(seeds = [STATE_SEED], bump = state.bump)]
    pub state: Account<'info, GlobalState>,

    /// CHECK: LB Token-2022 mint
    #[account(mut, seeds = [LB_MINT_SEED], bump)]
    pub lb_mint: AccountInfo<'info>,

    /// CHECK: PDA — withdraw_withheld_authority
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub lb_mint_authority: AccountInfo<'info>,

    #[account(mut, constraint = treasury_lb_ata.owner == TREASURY_KEY @ LbError::InvalidTreasury)]
    pub treasury_lb_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
    // remaining_accounts: LB ATAs with withheld fees
}

#[derive(Accounts)]
pub struct MintLb<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Account<'info, GlobalState>,

    /// CHECK: LB Token-2022 mint
    #[account(mut, seeds = [LB_MINT_SEED], bump)]
    pub lb_mint: AccountInfo<'info>,

    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub lb_mint_authority: AccountInfo<'info>,

    #[account(
        mut,
        constraint = buyer_lb_ata.owner == buyer.key()   @ LbError::InvalidAta,
        constraint = buyer_lb_ata.mint  == state.lb_mint @ LbError::InvalidAta,
    )]
    pub buyer_lb_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = brains_mint.key() == BRAINS_KEY @ LbError::InvalidBrainsMint)]
    pub brains_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = buyer_brains_ata.owner == buyer.key()       @ LbError::InvalidAta,
        constraint = buyer_brains_ata.mint  == brains_mint.key() @ LbError::InvalidAta,
    )]
    pub buyer_brains_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: validated against TREASURY_KEY
    #[account(mut, constraint = treasury.key() == TREASURY_KEY @ LbError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,

    #[account(
        mut,
        constraint = treasury_lb_ata.owner == TREASURY_KEY @ LbError::InvalidTreasury,
        constraint = treasury_lb_ata.mint  == state.lb_mint @ LbError::InvalidAta,
    )]
    pub treasury_lb_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program:     Program<'info, System>,
}

// FIXED: All heavy typed accounts wrapped in Box<> — solves 9024-byte stack overflow.
// Anchor auto-derefs Box<> so .decimals / .amount / .key() work identically.
#[derive(Accounts)]
pub struct ComboMintLb<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [STATE_SEED], bump = state.bump)]
    pub state: Account<'info, GlobalState>,

    /// CHECK: LB Token-2022 mint
    #[account(mut, seeds = [LB_MINT_SEED], bump)]
    pub lb_mint: AccountInfo<'info>,

    /// CHECK: PDA mint authority
    #[account(seeds = [MINT_AUTH_SEED], bump)]
    pub lb_mint_authority: AccountInfo<'info>,

    #[account(
        mut,
        constraint = buyer_lb_ata.owner == buyer.key()   @ LbError::InvalidAta,
        constraint = buyer_lb_ata.mint  == state.lb_mint @ LbError::InvalidAta,
    )]
    pub buyer_lb_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, constraint = brains_mint.key() == BRAINS_KEY @ LbError::InvalidBrainsMint)]
    pub brains_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = buyer_brains_ata.owner == buyer.key()       @ LbError::InvalidAta,
        constraint = buyer_brains_ata.mint  == brains_mint.key() @ LbError::InvalidAta,
    )]
    pub buyer_brains_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, constraint = xnm_mint.key() == XNM_KEY @ LbError::InvalidXnmMint)]
    pub xnm_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    #[account(
        mut,
        constraint = buyer_xnm_ata.owner == buyer.key()    @ LbError::InvalidAta,
        constraint = buyer_xnm_ata.mint  == xnm_mint.key() @ LbError::InvalidAta,
    )]
    pub buyer_xnm_ata: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_xnm_ata.mint  == xnm_mint.key() @ LbError::InvalidAta,
        constraint = treasury_xnm_ata.owner == TREASURY_KEY   @ LbError::InvalidTreasury,
    )]
    pub treasury_xnm_ata: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    #[account(mut, constraint = xuni_mint.key() == XUNI_KEY @ LbError::InvalidXuniMint)]
    pub xuni_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    #[account(
        mut,
        constraint = buyer_xuni_ata.owner == buyer.key()     @ LbError::InvalidAta,
        constraint = buyer_xuni_ata.mint  == xuni_mint.key() @ LbError::InvalidAta,
    )]
    pub buyer_xuni_ata: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_xuni_ata.mint  == xuni_mint.key() @ LbError::InvalidAta,
        constraint = treasury_xuni_ata.owner == TREASURY_KEY    @ LbError::InvalidTreasury,
    )]
    pub treasury_xuni_ata: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    #[account(mut, constraint = xblk_mint.key() == XBLK_KEY @ LbError::InvalidXblkMint)]
    pub xblk_mint: Box<Account<'info, anchor_spl::token::Mint>>,

    #[account(
        mut,
        constraint = buyer_xblk_ata.owner == buyer.key()     @ LbError::InvalidAta,
        constraint = buyer_xblk_ata.mint  == xblk_mint.key() @ LbError::InvalidAta,
    )]
    pub buyer_xblk_ata: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_xblk_ata.mint  == xblk_mint.key() @ LbError::InvalidAta,
        constraint = treasury_xblk_ata.owner == TREASURY_KEY     @ LbError::InvalidTreasury,
    )]
    pub treasury_xblk_ata: Box<Account<'info, anchor_spl::token::TokenAccount>>,

    /// CHECK: validated against TREASURY_KEY
    #[account(mut, constraint = treasury.key() == TREASURY_KEY @ LbError::InvalidTreasury)]
    pub treasury: AccountInfo<'info>,

    #[account(
        mut,
        constraint = treasury_lb_ata.owner == TREASURY_KEY @ LbError::InvalidTreasury,
        constraint = treasury_lb_ata.mint  == state.lb_mint @ LbError::InvalidAta,
    )]
    pub treasury_lb_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program:      Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program:     Program<'info, System>,
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum LbError {
    #[msg("Minting is paused")]                                       Paused,
    #[msg("Amount must be greater than zero")]                        ZeroAmount,
    #[msg("At least one Xenblocks asset must be provided")]           NoXenblocks,
    #[msg("BRAINS must be an exact multiple of the tier rate")]       BrainsNotMultiple,
    #[msg("XNM must be a multiple of 1,000")]                         XnmNotMultiple,
    #[msg("XUNI must be a multiple of 500")]                          XuniNotMultiple,
    #[msg("Total supply of 100,000 LB exhausted")]                    SupplyExhausted,
    #[msg("Insufficient BRAINS balance")]                             InsufficientBrains,
    #[msg("Insufficient XNT (native) balance")]                       InsufficientXnt,
    #[msg("Insufficient XNM balance")]                                InsufficientXnm,
    #[msg("Insufficient XUNI balance")]                               InsufficientXuni,
    #[msg("Insufficient XBLK balance")]                               InsufficientXblk,
    #[msg("Invalid BRAINS mint")]                                     InvalidBrainsMint,
    #[msg("Invalid treasury wallet")]                                 InvalidTreasury,
    #[msg("Invalid LB mint")]                                         InvalidLbMint,
    #[msg("Invalid XNM mint")]                                        InvalidXnmMint,
    #[msg("Invalid XUNI mint")]                                       InvalidXuniMint,
    #[msg("Invalid XBLK mint")]                                       InvalidXblkMint,
    #[msg("Invalid token account")]                                   InvalidAta,
    #[msg("Unauthorized")]                                            Unauthorized,
    #[msg("Math overflow")]                                           Overflow,
    #[msg("URI too long (max 200 chars)")]                            UriTooLong,
}
