use anchor_lang::prelude::*;
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
}