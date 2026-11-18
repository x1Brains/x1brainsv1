use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, CloseAccount};

declare_id!("CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4");

pub const PLATFORM_WALLET: &str = "CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF";
pub const SALE_FEE_NUMERATOR:   u64 = 1888;
pub const SALE_FEE_DENOMINATOR: u64 = 100_000;
pub const CANCEL_FEE_NUMERATOR:   u64 = 888;
pub const CANCEL_FEE_DENOMINATOR: u64 = 100_000;
pub const MIN_PRICE: u64 = 1_000_000;

/// Brains Elites genesis program. Membership cannot be checked with
/// `mint == collection_mint`, because each of the 444 Elites has its OWN mint.
/// The proof is the per-NFT PDA ["mint_record", nft_mint] under this program:
/// it exists only for genuine Elites and, being a PDA of that program, cannot
/// be forged. Verified on chain 2026-11-14 — present for Elites #301 and #332,
/// absent for a non-Elite control.
pub const GENESIS_PROGRAM: &str = "GQPGh1M6xwwWLdGCmWum2BhPi6gkJaoNFXyyuXpgN59v";

/// Does `holder` hold a Brains Elite RIGHT NOW?
///
/// Proof arrives in `remaining_accounts` as exactly two accounts:
///   [0] a token account for some Elite mint — owner == holder, amount >= 1
///   [1] that mint's ["mint_record", mint] PDA under GENESIS_PROGRAM
///
/// Using remaining_accounts rather than new named accounts keeps every existing
/// instruction's account list byte-identical, so current clients and the live
/// IDL keep working untouched.
///
/// ⛔ Re-checked at the moment of every fee-bearing action and never cached, so
/// a holder who sells their Elite loses the perk immediately — that is the
/// whole point (owner 2026-11-14). ANY Elite qualifies; it need not be the same
/// one each time.
///
/// ⛔ Returns false on anything unexpected, so the fee is charged exactly as it
/// is today. A missing or malformed proof must never fail a sale or a cancel.
fn elite_fee_waived(remaining: &[AccountInfo], holder: &Pubkey) -> bool {
    if remaining.len() < 2 { return false; }
    let token_acc = &remaining[0];
    let record    = &remaining[1];

    // Must be a real SPL token account, not a lookalike the caller controls.
    // Brains Elites are classic SPL (verified on chain: Tokenkeg, decimals 0,
    // supply 1), so Token-2022 is deliberately not accepted here.
    if *token_acc.owner != token::ID { return false; }

    let data = match token_acc.try_borrow_data() { Ok(d) => d, Err(_) => return false };
    if data.len() < 72 { return false; }
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&data[0..32]);
    let elite_mint = Pubkey::from(buf);
    buf.copy_from_slice(&data[32..64]);
    let token_owner = Pubkey::from(buf);
    let mut amt = [0u8; 8];
    amt.copy_from_slice(&data[64..72]);

    if u64::from_le_bytes(amt) == 0 { return false; }
    if token_owner != *holder { return false; }

    let genesis: Pubkey = match GENESIS_PROGRAM.parse() { Ok(p) => p, Err(_) => return false };
    let (expected, _) = Pubkey::find_program_address(&[b"mint_record", elite_mint.as_ref()], &genesis);
    if *record.key != expected { return false; }
    // An unused PDA is system-owned and empty; a real mint_record is owned by
    // the genesis program and has data.
    if *record.owner != genesis { return false; }
    record.try_borrow_data().map(|d| !d.is_empty()).unwrap_or(false)
}

/// ── Metaplex Core support ────────────────────────────────────────────────
/// x1 Inscriptions assets (inscriptions, maps, districts, parcels, editions) are
/// Metaplex Core, not SPL. Core has no token account, so a Core listing escrows
/// the ASSET ITSELF to the sale PDA, exactly the way the x1ins program does it
/// (x1-bitmaps program_v0 `list_inscription` -> `core_transfer`).
///
/// ⛔ mpl-core's Rust crate pins borsh 0.10 / solana-program 1.x and clashes with
/// Anchor 0.32, so TransferV1 is hand-built from its generated code — the same
/// reason and the same shape the x1ins program uses. Discriminator 14, then
/// Option<CompressionProof> = None, and an ABSENT optional account is passed as
/// the Core program id.
pub const CORE_ID: &str = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";

/// Current holder of a Core asset (AssetV1: key byte 1, owner at 1..33).
/// Pubkey::default() if it is not a live Core asset — callers compare it with a
/// signer, so a missing or foreign account can never pass.
fn core_holder(asset: &AccountInfo) -> Pubkey {
    let core: Pubkey = match CORE_ID.parse() { Ok(p) => p, Err(_) => return Pubkey::default() };
    if *asset.owner != core { return Pubkey::default(); }
    let d = match asset.try_borrow_data() { Ok(d) => d, Err(_) => return Pubkey::default() };
    if d.len() < 33 || d[0] != 1 { return Pubkey::default(); }
    let mut b = [0u8; 32];
    b.copy_from_slice(&d[1..33]);
    Pubkey::from(b)
}

/// Move a Core asset. `signers` carries the sale PDA seeds when the escrow pays out.
fn core_transfer<'info>(
    core: &AccountInfo<'info>, asset: &AccountInfo<'info>, collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>, authority: &AccountInfo<'info>, new_owner: &AccountInfo<'info>,
    signers: &[&[&[u8]]],
) -> Result<()> {
    let core_id: Pubkey = CORE_ID.parse().map_err(|_| error!(MarketplaceError::InvalidMint))?;
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: core_id,
        data: vec![14u8, 0u8],
        accounts: vec![
            AccountMeta::new(asset.key(), false),
            AccountMeta::new_readonly(collection.key(), false),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(authority.key(), true),
            AccountMeta::new_readonly(new_owner.key(), false),
            AccountMeta::new_readonly(core_id, false),
            AccountMeta::new_readonly(core_id, false),
        ],
    };
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[asset.clone(), collection.clone(), payer.clone(), authority.clone(), new_owner.clone(), core.clone()],
        signers,
    )?;
    Ok(())
}

#[program]
pub mod labwork_marketplace {
    use super::*;

    /// List an NFT for sale.
    /// Transfers NFT from seller ATA → vault PDA token account.
    pub fn list_nft(ctx: Context<ListNft>, price: u64) -> Result<()> {
        require!(price >= MIN_PRICE, MarketplaceError::PriceTooLow);

        // Transfer NFT: seller → vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.seller_nft_account.to_account_info(),
                    to:        ctx.accounts.vault_nft_account.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            1,
        )?;

        let sale        = &mut ctx.accounts.sale;
        sale.seller     = ctx.accounts.seller.key();
        sale.nft_mint   = ctx.accounts.nft_mint.key();
        sale.price      = price;
        sale.bump       = ctx.bumps.sale;
        sale.vault_bump = ctx.bumps.vault_nft_account;
        sale.created_at = Clock::get()?.unix_timestamp;

        msg!("Listed {} for {} lamports", sale.nft_mint, price);
        Ok(())
    }

    /// Cancel a listing — return NFT to seller, charge 0.888% cancel fee.
    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        let price      = ctx.accounts.sale.price;
        let vault_bump = ctx.accounts.sale.vault_bump;
        let mint_key   = ctx.accounts.sale.nft_mint;
        let seller_key = ctx.accounts.sale.seller;

        // Cancel fee via system program CPI (seller is owned by System Program)
        let mut cancel_fee = price
            .checked_mul(CANCEL_FEE_NUMERATOR).ok_or(MarketplaceError::MathOverflow)?
            .checked_div(CANCEL_FEE_DENOMINATOR).ok_or(MarketplaceError::MathOverflow)?;

        // Brains Elite holders unlist for free. The seller signs this
        // instruction, so their own client attaches the proof.
        if cancel_fee > 0 && elite_fee_waived(ctx.remaining_accounts, &ctx.accounts.seller.key()) {
            msg!("Brains Elite holder - cancel fee waived");
            cancel_fee = 0;
        }

        if cancel_fee > 0 {
            require!(ctx.accounts.seller.lamports() >= cancel_fee, MarketplaceError::InsufficientFundsForCancelFee);
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.seller.to_account_info(),
                        to:   ctx.accounts.platform_wallet.to_account_info(),
                    },
                ),
                cancel_fee,
            )?;
        }

        // Transfer NFT: vault → seller  (vault is self-custodied PDA, signs with seeds)
        let seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), seller_key.as_ref(), &[vault_bump]];
        let signer = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault_nft_account.to_account_info(),
                    to:        ctx.accounts.seller_nft_account.to_account_info(),
                    authority: ctx.accounts.vault_nft_account.to_account_info(),
                },
                signer,
            ),
            1,
        )?;

        // Close vault token account — rent back to seller
        token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account:     ctx.accounts.vault_nft_account.to_account_info(),
                    destination: ctx.accounts.seller.to_account_info(),
                    authority:   ctx.accounts.vault_nft_account.to_account_info(),
                },
                signer,
            ),
        )?;

        msg!("Cancelled listing for {}", mint_key);
        Ok(())
    }

    /// Buy an NFT — buyer pays price, seller gets proceeds, platform gets fee.
    pub fn buy_nft(ctx: Context<BuyNft>) -> Result<()> {
        let price      = ctx.accounts.sale.price;
        let vault_bump = ctx.accounts.sale.vault_bump;
        let mint_key   = ctx.accounts.sale.nft_mint;
        let seller_key = ctx.accounts.sale.seller;

        require!(ctx.accounts.buyer.lamports() >= price, MarketplaceError::InsufficientFunds);

        let mut platform_fee = price
            .checked_mul(SALE_FEE_NUMERATOR).ok_or(MarketplaceError::MathOverflow)?
            .checked_div(SALE_FEE_DENOMINATOR).ok_or(MarketplaceError::MathOverflow)?;

        // Brains Elite SELLERS keep the whole sale price. ⛔ The BUYER signs
        // this instruction, so the proof is about `sale.seller`, and it is the
        // buyer's client that must attach it. If it is absent the fee is simply
        // charged as before — the sale never fails over a missing proof.
        if platform_fee > 0 && elite_fee_waived(ctx.remaining_accounts, &seller_key) {
            msg!("Brains Elite seller - sale fee waived");
            platform_fee = 0;
        }

        let seller_proceeds = price.checked_sub(platform_fee).ok_or(MarketplaceError::MathOverflow)?;

        // Pay platform fee
        if platform_fee > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to:   ctx.accounts.platform_wallet.to_account_info(),
                    },
                ),
                platform_fee,
            )?;
        }

        // Pay seller
        if seller_proceeds > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.buyer.to_account_info(),
                        to:   ctx.accounts.seller_wallet.to_account_info(),
                    },
                ),
                seller_proceeds,
            )?;
        }

        // Transfer NFT: vault → buyer
        let seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), seller_key.as_ref(), &[vault_bump]];
        let signer = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.vault_nft_account.to_account_info(),
                    to:        ctx.accounts.buyer_nft_account.to_account_info(),
                    authority: ctx.accounts.vault_nft_account.to_account_info(),
                },
                signer,
            ),
            1,
        )?;

        // Close vault — rent to seller
        token::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account:     ctx.accounts.vault_nft_account.to_account_info(),
                    destination: ctx.accounts.seller_wallet.to_account_info(),
                    authority:   ctx.accounts.vault_nft_account.to_account_info(),
                },
                signer,
            ),
        )?;

        msg!("Sold {} for {} lamports", mint_key, price);
        Ok(())
    }

    /// Update listing price — free.
    pub fn update_price(ctx: Context<UpdatePrice>, new_price: u64) -> Result<()> {
        require!(new_price >= MIN_PRICE, MarketplaceError::PriceTooLow);
        ctx.accounts.sale.price = new_price;
        Ok(())
    }
}

// ─── Account Structs ──────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct SaleAccount {
    pub seller:     Pubkey,  // 32
    pub nft_mint:   Pubkey,  // 32
    pub price:      u64,     //  8
    pub bump:       u8,      //  1
    pub vault_bump: u8,      //  1
    pub created_at: i64,     //  8
}
impl SaleAccount {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 1 + 8; // = 90
}

// ─── Instruction Contexts ─────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ListNft<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    /// CHECK: read-only, used for PDA seeds
    pub nft_mint: AccountInfo<'info>,

    #[account(
        mut,
        constraint = seller_nft_account.owner  == seller.key()   @ MarketplaceError::NotNFTOwner,
        constraint = seller_nft_account.mint   == nft_mint.key() @ MarketplaceError::InvalidMint,
        constraint = seller_nft_account.amount == 1              @ MarketplaceError::NotNFTOwner,
    )]
    pub seller_nft_account: Account<'info, TokenAccount>,

    /// Vault: self-custodied PDA token account (authority = itself)
    #[account(
        init,
        payer = seller,
        token::mint      = nft_mint,
        token::authority = vault_nft_account,
        seeds = [b"vault", nft_mint.key().as_ref(), seller.key().as_ref()],
        bump,
    )]
    pub vault_nft_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = seller,
        space = SaleAccount::LEN,
        seeds = [b"sale", nft_mint.key().as_ref(), seller.key().as_ref()],
        bump,
    )]
    pub sale: Account<'info, SaleAccount>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut, constraint = seller.key() == sale.seller @ MarketplaceError::Unauthorized)]
    pub seller: Signer<'info>,

    /// CHECK: validated via sale.nft_mint
    #[account(constraint = nft_mint.key() == sale.nft_mint)]
    pub nft_mint: AccountInfo<'info>,

    #[account(
        mut,
        constraint = seller_nft_account.owner == seller.key(),
        constraint = seller_nft_account.mint  == sale.nft_mint,
    )]
    pub seller_nft_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", sale.nft_mint.as_ref(), seller.key().as_ref()],
        bump  = sale.vault_bump,
    )]
    pub vault_nft_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        close = seller,
        seeds = [b"sale", sale.nft_mint.as_ref(), seller.key().as_ref()],
        bump  = sale.bump,
    )]
    pub sale: Account<'info, SaleAccount>,

    /// CHECK: validated against hardcoded constant
    #[account(mut, constraint = platform_wallet.key().to_string() == PLATFORM_WALLET @ MarketplaceError::InvalidPlatformWallet)]
    pub platform_wallet: AccountInfo<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyNft<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: validated via sale.nft_mint
    #[account(constraint = nft_mint.key() == sale.nft_mint)]
    pub nft_mint: AccountInfo<'info>,

    #[account(
        mut,
        constraint = buyer_nft_account.owner == buyer.key(),
        constraint = buyer_nft_account.mint  == sale.nft_mint,
    )]
    pub buyer_nft_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", sale.nft_mint.as_ref(), sale.seller.as_ref()],
        bump  = sale.vault_bump,
    )]
    pub vault_nft_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        close = seller_wallet,
        seeds = [b"sale", sale.nft_mint.as_ref(), sale.seller.as_ref()],
        bump  = sale.bump,
    )]
    pub sale: Account<'info, SaleAccount>,

    /// CHECK: validated against sale.seller
    #[account(mut, constraint = seller_wallet.key() == sale.seller @ MarketplaceError::InvalidSeller)]
    pub seller_wallet: AccountInfo<'info>,

    /// CHECK: validated against hardcoded constant
    #[account(mut, constraint = platform_wallet.key().to_string() == PLATFORM_WALLET @ MarketplaceError::InvalidPlatformWallet)]
    pub platform_wallet: AccountInfo<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(mut, constraint = seller.key() == sale.seller @ MarketplaceError::Unauthorized)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"sale", sale.nft_mint.as_ref(), seller.key().as_ref()],
        bump  = sale.bump,
    )]
    pub sale: Account<'info, SaleAccount>,
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum MarketplaceError {
    #[msg("Price below minimum")]           PriceTooLow,
    #[msg("Not the NFT owner")]             NotNFTOwner,
    #[msg("Invalid NFT mint")]              InvalidMint,
    #[msg("Not the listing seller")]        Unauthorized,
    #[msg("Invalid platform wallet")]       InvalidPlatformWallet,
    #[msg("Invalid seller account")]        InvalidSeller,
    #[msg("Insufficient funds")]            InsufficientFunds,
    #[msg("Insufficient funds for fee")]    InsufficientFundsForCancelFee,
    #[msg("Math overflow")]                 MathOverflow,
    #[msg("Not the Core asset holder")]     NotAssetHolder,
    #[msg("Asset is frozen and cannot be listed")] AssetFrozen,
    #[msg("Not a Metaplex Core asset")]     NotCoreAsset,
    #[msg("Royalty creator account does not match the asset")] BadRoyaltyCreator,
}
// ════════════════════════════════════════════════════════════════════════════
//  Stress tests for elite_fee_waived — the forgery matrix.
//
//  This function decides whether real money changes hands, so every way an
//  attacker could hand it a lookalike is tested here, not reasoned about.
//  Run with: cargo test -p labwork_marketplace --lib
// ════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod elite_tests {
    use super::*;
    use anchor_lang::solana_program::account_info::AccountInfo;

    const REAL_ELITE_MINT: &str = "HDemMuVgvRU3geGka2tZ4bJAPVPj3YgWKpcGw7iKwdXY"; // #082, live
    const HOLDER:          &str = "x1HpEECT2VHiy6BmPZeXnoHZgHfpPomhk1sho7x5pjR";

    fn genesis() -> Pubkey { GENESIS_PROGRAM.parse().unwrap() }

    /// A 165-byte SPL token account: mint @0, owner @32, amount @64.
    fn token_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
        let mut d = vec![0u8; 165];
        d[0..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        d[64..72].copy_from_slice(&amount.to_le_bytes());
        d[108] = 1; // state = Initialized
        d
    }

    #[allow(clippy::too_many_arguments)]
    fn info<'a>(key: &'a Pubkey, owner: &'a Pubkey, lamports: &'a mut u64, data: &'a mut [u8]) -> AccountInfo<'a> {
        AccountInfo::new(key, false, false, lamports, data, owner, false, 0)
    }

    /// Build the honest, should-succeed proof pair.
    fn good_case() -> (Pubkey, Pubkey, Pubkey, Pubkey, Vec<u8>, Vec<u8>) {
        let elite_mint: Pubkey = REAL_ELITE_MINT.parse().unwrap();
        let holder:     Pubkey = HOLDER.parse().unwrap();
        let ta_key = Pubkey::new_unique();
        let (record_key, _) =
            Pubkey::find_program_address(&[b"mint_record", elite_mint.as_ref()], &genesis());
        (elite_mint, holder, ta_key, record_key, token_data(&elite_mint, &holder, 1), vec![7u8; 293])
    }

    macro_rules! run {
        ($ta_key:expr, $ta_owner:expr, $ta_data:expr,
         $rec_key:expr, $rec_owner:expr, $rec_data:expr, $holder:expr) => {{
            let (mut l1, mut l2) = (1_000_000u64, 1_000_000u64);
            let (mut d1, mut d2) = ($ta_data.clone(), $rec_data.clone());
            let (k1, o1, k2, o2) = ($ta_key, $ta_owner, $rec_key, $rec_owner);
            let a = info(&k1, &o1, &mut l1, &mut d1);
            let b = info(&k2, &o2, &mut l2, &mut d2);
            elite_fee_waived(&[a, b], &$holder)
        }};
    }

    #[test]
    fn honest_elite_holder_is_waived() {
        let (_m, h, tak, rk, td, rd) = good_case();
        assert!(run!(tak, token::ID, td, rk, genesis(), rd, h),
                "a real Elite holder must get the waiver");
    }

    #[test]
    fn no_proof_attached_charges_the_fee() {
        let h: Pubkey = HOLDER.parse().unwrap();
        assert!(!elite_fee_waived(&[], &h), "no remaining accounts -> fee charged");
    }

    #[test]
    fn one_account_only_charges_the_fee() {
        let (_m, h, tak, _rk, td, _rd) = good_case();
        let (mut l, mut d) = (1u64, td);
        let o = token::ID;
        let a = info(&tak, &o, &mut l, &mut d);
        assert!(!elite_fee_waived(std::slice::from_ref(&a), &h), "a truncated proof -> fee charged");
    }

    #[test]
    fn fake_token_program_owner_is_rejected() {
        // The attacker's own program writes a perfect-looking token account.
        let (_m, h, tak, rk, td, rd) = good_case();
        let attacker = Pubkey::new_unique();
        assert!(!run!(tak, attacker, td, rk, genesis(), rd, h),
                "a token account not owned by the SPL Token program must be rejected");
    }

    #[test]
    fn zero_balance_is_rejected() {
        let (m, h, tak, rk, _td, rd) = good_case();
        assert!(!run!(tak, token::ID, token_data(&m, &h, 0), rk, genesis(), rd, h),
                "holding zero of the Elite must not waive the fee");
    }

    #[test]
    fn someone_elses_elite_is_rejected() {
        // The classic attack: point at a real Elite that belongs to another wallet.
        let (m, h, tak, rk, _td, rd) = good_case();
        let other = Pubkey::new_unique();
        assert!(!run!(tak, token::ID, token_data(&m, &other, 1), rk, genesis(), rd, h),
                "an Elite held by someone else must not waive MY fee");
    }

    #[test]
    fn non_elite_token_with_bogus_record_is_rejected() {
        // Attacker holds a worthless NFT and passes a PDA they created themselves.
        let h: Pubkey = HOLDER.parse().unwrap();
        let junk = Pubkey::new_unique();
        let (rec, _) = Pubkey::find_program_address(&[b"mint_record", junk.as_ref()], &genesis());
        // Derivation is right, but no such account exists on chain -> system-owned, empty.
        assert!(!run!(Pubkey::new_unique(), token::ID, token_data(&junk, &h, 1),
                      rec, anchor_lang::solana_program::system_program::ID, vec![], h),
                "an unused mint_record PDA is system-owned and empty -> reject");
    }

    #[test]
    fn record_for_a_different_mint_is_rejected() {
        // Hold junk, but pass the REAL Elite's mint_record.
        let (m, h, _tak, rk, _td, rd) = good_case();
        let junk = Pubkey::new_unique();
        assert_ne!(junk, m);
        assert!(!run!(Pubkey::new_unique(), token::ID, token_data(&junk, &h, 1),
                      rk, genesis(), rd, h),
                "the record must belong to the mint in the token account");
    }

    #[test]
    fn record_owned_by_attacker_is_rejected() {
        // Right address is impossible to fake, but test the owner check anyway.
        let (_m, h, tak, rk, td, rd) = good_case();
        let attacker = Pubkey::new_unique();
        assert!(!run!(tak, token::ID, td, rk, attacker, rd, h),
                "a record not owned by the genesis program must be rejected");
    }

    #[test]
    fn empty_record_account_is_rejected() {
        let (_m, h, tak, rk, td, _rd) = good_case();
        assert!(!run!(tak, token::ID, td, rk, genesis(), Vec::<u8>::new(), h),
                "a zero-length record must be rejected");
    }

    #[test]
    fn truncated_token_account_is_rejected() {
        let (_m, h, tak, rk, _td, rd) = good_case();
        assert!(!run!(tak, token::ID, vec![0u8; 71], rk, genesis(), rd, h),
                "a token account too short to hold mint/owner/amount must be rejected");
    }

    #[test]
    fn spl_mint_account_masquerading_as_token_account_is_rejected() {
        // An 82-byte Mint is ALSO owned by token::ID and is >= 72 bytes, so it
        // reaches the field reads. It must not accidentally satisfy them.
        let (_m, h, tak, rk, _td, rd) = good_case();
        assert!(!run!(tak, token::ID, vec![0u8; 82], rk, genesis(), rd, h),
                "an SPL Mint account must not pass as a token account");
    }

    #[test]
    fn listed_elite_in_the_vault_does_not_waive() {
        // Owner's rule: the Elite must be IN THEIR WALLET. An Elite escrowed in
        // a marketplace vault is owned by the vault PDA, not the seller.
        let (m, h, tak, rk, _td, rd) = good_case();
        let vault = Pubkey::new_unique();
        assert!(!run!(tak, token::ID, token_data(&m, &vault, 1), rk, genesis(), rd, h),
                "an Elite sitting in a vault is not 'in their wallet'");
    }

    #[test]
    fn any_elite_qualifies_not_a_specific_one() {
        // Owner's rule: it need not be the same Elite each time.
        let h: Pubkey = HOLDER.parse().unwrap();
        for other in ["726BsucBQ1ndnU798KM18eu7P7TiCToFwuGoVDSzX1gY",   // #301, live
                      "8ME7oPPrUdaZSQyxkrHgyuuTm7fsnrv2L5aAhik4kRGn"] { // #332, live
            let m: Pubkey = other.parse().unwrap();
            let (rk, _) = Pubkey::find_program_address(&[b"mint_record", m.as_ref()], &genesis());
            assert!(run!(Pubkey::new_unique(), token::ID, token_data(&m, &h, 1),
                         rk, genesis(), vec![7u8; 293], h),
                    "any genuine Elite must grant the waiver");
        }
    }

    #[test]
    fn large_balance_still_waives() {
        let (m, h, tak, rk, _td, rd) = good_case();
        assert!(run!(tak, token::ID, token_data(&m, &h, u64::MAX), rk, genesis(), rd, h));
    }

    #[test]
    fn extra_accounts_beyond_the_two_are_ignored() {
        // A caller may append more accounts; only the first two are the proof.
        let (_m, h, tak, rk, td, rd) = good_case();
        let (mut l1, mut l2, mut l3) = (1u64, 1u64, 1u64);
        let (mut d1, mut d2, mut d3) = (td, rd, vec![0u8; 10]);
        let (o1, o2, o3) = (token::ID, genesis(), Pubkey::new_unique());
        let k3 = Pubkey::new_unique();
        let a = info(&tak, &o1, &mut l1, &mut d1);
        let b = info(&rk,  &o2, &mut l2, &mut d2);
        let c = info(&k3,  &o3, &mut l3, &mut d3);
        assert!(elite_fee_waived(&[a, b, c], &h));
    }
}
