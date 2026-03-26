use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, CloseAccount};

declare_id!("EQKNXSBE6vUbtPBY1ibXPyWmLzrtXBZqUs9Fjqo19TkX");

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

pub const PLATFORM_WALLET: &str = "CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF";

pub const SALE_FEE_NUMERATOR:   u64 = 1888;
pub const SALE_FEE_DENOMINATOR: u64 = 100_000;

pub const CANCEL_FEE_NUMERATOR:   u64 = 888;
pub const CANCEL_FEE_DENOMINATOR: u64 = 100_000;

pub const MIN_PRICE: u64 = 1_000_000; // 0.001 XNT

// ─────────────────────────────────────────────────────────────────────────────
//  PROGRAM
// ─────────────────────────────────────────────────────────────────────────────

#[program]
pub mod labwork_marketplace {
    use super::*;

    // ─────────────────────────────────────────────────────────────────
    //  LIST NFT
    //  Seller creates a VaultAccount (their own ATA delegated to program
    //  PDA) and a SaleAccount storing the listing details.
    //  The NFT stays in the seller's ATA — we only DELEGATE authority
    //  to the sale PDA, not transfer. This is simpler and avoids the
    //  token account init issues.
    //
    //  Actually the simplest working pattern: transfer NFT to a 
    //  dedicated vault ATA owned by the program PDA.
    //  Use the SaleAccount PDA as the vault token account authority.
    // ─────────────────────────────────────────────────────────────────
    pub fn list_nft(ctx: Context<ListNft>, price: u64) -> Result<()> {
        require!(price >= MIN_PRICE, MarketplaceError::PriceTooLow);

        // Transfer NFT: seller ATA → vault ATA (owned by sale PDA)
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.seller_nft_account.to_account_info(),
                to:        ctx.accounts.vault_nft_account.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, 1)?;

        // Record listing
        let sale = &mut ctx.accounts.sale;
        sale.seller        = ctx.accounts.seller.key();
        sale.nft_mint      = ctx.accounts.nft_mint.key();
        sale.price         = price;
        sale.bump          = ctx.bumps.sale;
        sale.vault_bump    = ctx.bumps.vault_nft_account;
        sale.created_at    = Clock::get()?.unix_timestamp;

        msg!("Listed {} for {} lamports", sale.nft_mint, price);
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────
    //  CANCEL LISTING
    //  Transfer NFT back from vault → seller. Charge 0.888% cancel fee.
    // ─────────────────────────────────────────────────────────────────
    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        let sale  = &ctx.accounts.sale;
        let price = sale.price;
        let mint  = sale.nft_mint;
        let bump  = sale.vault_bump;

        // Cancel fee
        let cancel_fee = price
            .checked_mul(CANCEL_FEE_NUMERATOR).ok_or(MarketplaceError::MathOverflow)?
            .checked_div(CANCEL_FEE_DENOMINATOR).ok_or(MarketplaceError::MathOverflow)?;

        if cancel_fee > 0 {
            require!(
                ctx.accounts.seller.lamports() >= cancel_fee,
                MarketplaceError::InsufficientFundsForCancelFee
            );
            **ctx.accounts.seller.try_borrow_mut_lamports()? -= cancel_fee;
            **ctx.accounts.platform_wallet.try_borrow_mut_lamports()? += cancel_fee;
        }

        // Transfer NFT back: vault → seller
        let mint_key = mint.key();
        let seeds = &[
            b"vault",
            mint_key.as_ref(),
            ctx.accounts.seller.key.as_ref(),
            &[bump],
        ];
        let signer = &[seeds.as_slice()];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.vault_nft_account.to_account_info(),
                to:        ctx.accounts.seller_nft_account.to_account_info(),
                authority: ctx.accounts.vault_nft_account.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, 1)?;

        // Close vault account — return rent to seller
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account:     ctx.accounts.vault_nft_account.to_account_info(),
                destination: ctx.accounts.seller.to_account_info(),
                authority:   ctx.accounts.vault_nft_account.to_account_info(),
            },
            signer,
        );
        token::close_account(close_ctx)?;

        msg!("Listing cancelled for {}", mint);
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────
    //  BUY NFT
    //  Buyer pays price. Platform gets 1.888%. Seller gets remainder.
    //  NFT transfers from vault → buyer.
    // ─────────────────────────────────────────────────────────────────
    pub fn buy_nft(ctx: Context<BuyNft>) -> Result<()> {
        let sale  = &ctx.accounts.sale;
        let price = sale.price;
        let mint  = sale.nft_mint;
        let bump  = sale.vault_bump;

        require!(
            ctx.accounts.buyer.lamports() >= price,
            MarketplaceError::InsufficientFunds
        );

        let platform_fee = price
            .checked_mul(SALE_FEE_NUMERATOR).ok_or(MarketplaceError::MathOverflow)?
            .checked_div(SALE_FEE_DENOMINATOR).ok_or(MarketplaceError::MathOverflow)?;
        let seller_proceeds = price.checked_sub(platform_fee).ok_or(MarketplaceError::MathOverflow)?;

        // Pay platform
        if platform_fee > 0 {
            **ctx.accounts.buyer.try_borrow_mut_lamports()? -= platform_fee;
            **ctx.accounts.platform_wallet.try_borrow_mut_lamports()? += platform_fee;
        }

        // Pay seller
        if seller_proceeds > 0 {
            **ctx.accounts.buyer.try_borrow_mut_lamports()? -= seller_proceeds;
            **ctx.accounts.seller_wallet.try_borrow_mut_lamports()? += seller_proceeds;
        }

        // Transfer NFT: vault → buyer
        let mint_key = mint.key();
        let seller_key = ctx.accounts.seller_wallet.key();
        let seeds = &[
            b"vault",
            mint_key.as_ref(),
            seller_key.as_ref(),
            &[bump],
        ];
        let signer = &[seeds.as_slice()];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.vault_nft_account.to_account_info(),
                to:        ctx.accounts.buyer_nft_account.to_account_info(),
                authority: ctx.accounts.vault_nft_account.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, 1)?;

        // Close vault — return rent to seller
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account:     ctx.accounts.vault_nft_account.to_account_info(),
                destination: ctx.accounts.seller_wallet.to_account_info(),
                authority:   ctx.accounts.vault_nft_account.to_account_info(),
            },
            signer,
        );
        token::close_account(close_ctx)?;

        msg!("Sold {} for {} lamports. Fee: {}", mint, price, platform_fee);
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────
    //  UPDATE PRICE — free
    // ─────────────────────────────────────────────────────────────────
    pub fn update_price(ctx: Context<UpdatePrice>, new_price: u64) -> Result<()> {
        require!(new_price >= MIN_PRICE, MarketplaceError::PriceTooLow);
        ctx.accounts.sale.price = new_price;
        msg!("Price updated to {}", new_price);
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACCOUNT STRUCTS
// ─────────────────────────────────────────────────────────────────────────────

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
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 1 + 8;
}

// ─────────────────────────────────────────────────────────────────────────────
//  INSTRUCTION CONTEXTS
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ListNft<'info> {
    // 0
    #[account(mut)]
    pub seller: Signer<'info>,

    // 1 — NFT mint
    /// CHECK: read-only, used for seeds only
    pub nft_mint: AccountInfo<'info>,

    // 2 — Seller's current NFT token account
    #[account(
        mut,
        constraint = seller_nft_account.owner == seller.key() @ MarketplaceError::NotNFTOwner,
        constraint = seller_nft_account.mint  == nft_mint.key() @ MarketplaceError::InvalidMint,
        constraint = seller_nft_account.amount == 1 @ MarketplaceError::NotNFTOwner,
    )]
    pub seller_nft_account: Account<'info, TokenAccount>,

    // 3 — Vault token account (PDA-owned, holds NFT in escrow)
    //     Seeds: ["vault", nft_mint, seller]
    //     Authority = itself (self-custodied PDA token account)
    #[account(
        init,
        payer = seller,
        token::mint      = nft_mint,
        token::authority = vault_nft_account,
        seeds = [b"vault", nft_mint.key().as_ref(), seller.key().as_ref()],
        bump,
    )]
    pub vault_nft_account: Account<'info, TokenAccount>,

    // 4 — Sale state PDA
    #[account(
        init,
        payer = seller,
        space = SaleAccount::LEN,
        seeds = [b"sale", nft_mint.key().as_ref(), seller.key().as_ref()],
        bump,
    )]
    pub sale: Account<'info, SaleAccount>,

    // 5
    pub token_program:  Program<'info, Token>,
    // 6
    pub system_program: Program<'info, System>,
    // 7
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelListing<'info> {
    // 0
    #[account(
        mut,
        constraint = seller.key() == sale.seller @ MarketplaceError::Unauthorized,
    )]
    pub seller: Signer<'info>,

    // 1
    /// CHECK: validated via sale.nft_mint
    #[account(constraint = nft_mint.key() == sale.nft_mint)]
    pub nft_mint: AccountInfo<'info>,

    // 2 — Seller's NFT ATA to receive NFT back
    #[account(
        mut,
        constraint = seller_nft_account.owner == seller.key(),
        constraint = seller_nft_account.mint  == sale.nft_mint,
    )]
    pub seller_nft_account: Account<'info, TokenAccount>,

    // 3 — Vault holding the NFT
    #[account(
        mut,
        seeds = [b"vault", sale.nft_mint.as_ref(), seller.key().as_ref()],
        bump  = sale.vault_bump,
    )]
    pub vault_nft_account: Account<'info, TokenAccount>,

    // 4 — Sale account — closed on cancel, rent → seller
    #[account(
        mut,
        close = seller,
        seeds = [b"sale", sale.nft_mint.as_ref(), seller.key().as_ref()],
        bump  = sale.bump,
    )]
    pub sale: Account<'info, SaleAccount>,

    // 5 — Platform fee wallet
    /// CHECK: validated against hardcoded constant
    #[account(
        mut,
        constraint = platform_wallet.key().to_string() == PLATFORM_WALLET
            @ MarketplaceError::InvalidPlatformWallet,
    )]
    pub platform_wallet: AccountInfo<'info>,

    // 6
    pub token_program:  Program<'info, Token>,
    // 7
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyNft<'info> {
    // 0
    #[account(mut)]
    pub buyer: Signer<'info>,

    // 1
    /// CHECK: validated via sale.nft_mint
    #[account(constraint = nft_mint.key() == sale.nft_mint)]
    pub nft_mint: AccountInfo<'info>,

    // 2 — Buyer's NFT ATA to receive NFT
    #[account(
        mut,
        constraint = buyer_nft_account.owner == buyer.key(),
        constraint = buyer_nft_account.mint  == sale.nft_mint,
    )]
    pub buyer_nft_account: Account<'info, TokenAccount>,

    // 3 — Vault holding the NFT
    #[account(
        mut,
        seeds = [b"vault", sale.nft_mint.as_ref(), sale.seller.as_ref()],
        bump  = sale.vault_bump,
    )]
    pub vault_nft_account: Account<'info, TokenAccount>,

    // 4 — Sale account — closed on purchase, rent → seller
    #[account(
        mut,
        close = seller_wallet,
        seeds = [b"sale", sale.nft_mint.as_ref(), sale.seller.as_ref()],
        bump  = sale.bump,
    )]
    pub sale: Account<'info, SaleAccount>,

    // 5 — Seller wallet (receives proceeds + rent)
    /// CHECK: validated against sale.seller
    #[account(
        mut,
        constraint = seller_wallet.key() == sale.seller @ MarketplaceError::InvalidSeller,
    )]
    pub seller_wallet: AccountInfo<'info>,

    // 6 — Platform fee wallet
    /// CHECK: validated against hardcoded constant
    #[account(
        mut,
        constraint = platform_wallet.key().to_string() == PLATFORM_WALLET
            @ MarketplaceError::InvalidPlatformWallet,
    )]
    pub platform_wallet: AccountInfo<'info>,

    // 7
    pub token_program:  Program<'info, Token>,
    // 8
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(
        mut,
        constraint = seller.key() == sale.seller @ MarketplaceError::Unauthorized,
    )]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"sale", sale.nft_mint.as_ref(), seller.key().as_ref()],
        bump  = sale.bump,
    )]
    pub sale: Account<'info, SaleAccount>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  ERRORS
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum MarketplaceError {
    #[msg("Price is below minimum (0.001 XNT)")]
    PriceTooLow,
    #[msg("Caller is not the NFT owner")]
    NotNFTOwner,
    #[msg("Invalid NFT mint")]
    InvalidMint,
    #[msg("Caller is not the listing seller")]
    Unauthorized,
    #[msg("Invalid platform wallet address")]
    InvalidPlatformWallet,
    #[msg("Invalid seller account")]
    InvalidSeller,
    #[msg("Insufficient funds to purchase NFT")]
    InsufficientFunds,
    #[msg("Insufficient funds to pay cancel fee")]
    InsufficientFundsForCancelFee,
    #[msg("Math overflow")]
    MathOverflow,
}