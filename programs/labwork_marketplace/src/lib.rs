use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("EQKNXSBE6vUbtPBY1ibXPyWmLzrtXBZqUs9Fjqo19TkX");

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/// Platform fee wallet — receives all fees
pub const PLATFORM_WALLET: &str = "CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF";

/// Sale fee: 1.888% expressed as basis points (1 bp = 0.01%)
/// 1.888% = 188.8 bp — we use integer math so multiply by 10 → 1888 / 100_000
pub const SALE_FEE_NUMERATOR:   u64 = 1888;
pub const SALE_FEE_DENOMINATOR: u64 = 100_000;

/// Cancel fee: 0.888%
pub const CANCEL_FEE_NUMERATOR:   u64 = 888;
pub const CANCEL_FEE_DENOMINATOR: u64 = 100_000;

/// Minimum listing price: 0.001 XNT (in lamports, 9 decimals)
pub const MIN_PRICE: u64 = 1_000_000; // 0.001 XNT

// ─────────────────────────────────────────────────────────────────────────────
//  PROGRAM
// ─────────────────────────────────────────────────────────────────────────────

#[program]
pub mod labwork_marketplace {
    use super::*;

    // ─────────────────────────────────────────────────────────────
    //  LIST NFT
    //  Seller transfers their NFT into a PDA escrow token account.
    //  A ListingAccount PDA records the terms. The NFT stays in
    //  escrow until bought or cancelled.
    // ─────────────────────────────────────────────────────────────
    pub fn list_nft(ctx: Context<ListNft>, price: u64) -> Result<()> {
        require!(price >= MIN_PRICE, MarketplaceError::PriceTooLow);

        // Populate listing account
        let listing = &mut ctx.accounts.listing;
        listing.seller        = ctx.accounts.seller.key();
        listing.nft_mint      = ctx.accounts.nft_mint.key();
        listing.price         = price;
        listing.created_at    = Clock::get()?.unix_timestamp;
        listing.bump          = ctx.bumps.listing;
        listing.escrow_bump   = ctx.bumps.escrow_token_account;

        // Copy values before mutable borrow ends
        let listing_key  = listing.key();
        let listing_seller   = listing.seller;
        let listing_mint     = listing.nft_mint;
        let listing_created  = listing.created_at;

        // Transfer NFT from seller's ATA → escrow PDA token account
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.seller_token_account.to_account_info(),
                to:        ctx.accounts.escrow_token_account.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, 1)?;

        emit!(ListingCreated {
            listing:    listing_key,
            seller:     listing_seller,
            nft_mint:   listing_mint,
            price,
            created_at: listing_created,
        });

        msg!(
            "NFT {} listed for {} lamports by {}",
            listing_mint,
            price,
            listing_seller
        );
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    //  DELIST / CANCEL
    //  Seller reclaims their NFT from escrow.
    //  A cancel fee of 0.888% of the listing price is charged in
    //  XNT (SOL-equivalent native token). The fee is deducted from
    //  the seller's wallet directly, so seller must have enough
    //  XNT balance. NFT is returned regardless.
    //
    //  Note: cancel fee is charged in native XNT (lamports).
    //  Seller must have at least cancel_fee lamports available.
    // ─────────────────────────────────────────────────────────────
    pub fn delist_nft(ctx: Context<DelistNft>) -> Result<()> {
        let listing  = &ctx.accounts.listing;
        let price    = listing.price;
        let nft_mint = listing.nft_mint;
        let seller   = listing.seller;

        // Calculate cancel fee: 0.888% of listing price
        let cancel_fee = price
            .checked_mul(CANCEL_FEE_NUMERATOR)
            .ok_or(MarketplaceError::MathOverflow)?
            .checked_div(CANCEL_FEE_DENOMINATOR)
            .ok_or(MarketplaceError::MathOverflow)?;

        // Charge cancel fee from seller → platform wallet (native XNT transfer)
        if cancel_fee > 0 {
            require!(
                ctx.accounts.seller.lamports() >= cancel_fee,
                MarketplaceError::InsufficientFundsForCancelFee
            );
            **ctx.accounts.seller.try_borrow_mut_lamports()? -= cancel_fee;
            **ctx.accounts.platform_wallet.try_borrow_mut_lamports()? += cancel_fee;
        }

        // Return NFT from escrow → seller's token account
        // Escrow PDA is the authority — use seeds to sign
        let mint_key = nft_mint.key();
        let seeds: &[&[u8]] = &[
            b"escrow",
            mint_key.as_ref(),
            &[listing.escrow_bump],
        ];
        let signer = &[seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.escrow_token_account.to_account_info(),
                to:        ctx.accounts.seller_token_account.to_account_info(),
                authority: ctx.accounts.escrow_token_account.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, 1)?;

        emit!(ListingCancelled {
            listing:    ctx.accounts.listing.key(),
            seller,
            nft_mint,
            cancel_fee,
        });

        msg!(
            "Listing cancelled for NFT {}. Cancel fee: {} lamports",
            nft_mint,
            cancel_fee
        );
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    //  BUY NFT
    //  Buyer pays listing.price in XNT (native lamports).
    //  Platform receives 1.888% fee.
    //  Seller receives the remainder.
    //  NFT is transferred from escrow → buyer.
    //  ListingAccount is closed, rent returned to seller.
    // ─────────────────────────────────────────────────────────────
    pub fn buy_nft(ctx: Context<BuyNft>) -> Result<()> {
        let listing  = &ctx.accounts.listing;
        let price    = listing.price;
        let nft_mint = listing.nft_mint;
        let seller   = listing.seller;

        // Verify buyer has enough funds
        require!(
            ctx.accounts.buyer.lamports() >= price,
            MarketplaceError::InsufficientFunds
        );

        // Calculate fees
        // Platform fee: 1.888% of price
        let platform_fee = price
            .checked_mul(SALE_FEE_NUMERATOR)
            .ok_or(MarketplaceError::MathOverflow)?
            .checked_div(SALE_FEE_DENOMINATOR)
            .ok_or(MarketplaceError::MathOverflow)?;

        // Seller receives: price - platform_fee
        let seller_proceeds = price
            .checked_sub(platform_fee)
            .ok_or(MarketplaceError::MathOverflow)?;

        // Transfer: buyer → platform wallet (fee)
        if platform_fee > 0 {
            **ctx.accounts.buyer.try_borrow_mut_lamports()?         -= platform_fee;
            **ctx.accounts.platform_wallet.try_borrow_mut_lamports()? += platform_fee;
        }

        // Transfer: buyer → seller (proceeds)
        if seller_proceeds > 0 {
            **ctx.accounts.buyer.try_borrow_mut_lamports()?     -= seller_proceeds;
            **ctx.accounts.seller_wallet.try_borrow_mut_lamports()? += seller_proceeds;
        }

        // Transfer NFT: escrow → buyer token account
        let mint_key = nft_mint.key();
        let seeds: &[&[u8]] = &[
            b"escrow",
            mint_key.as_ref(),
            &[listing.escrow_bump],
        ];
        let signer = &[seeds];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.escrow_token_account.to_account_info(),
                to:        ctx.accounts.buyer_token_account.to_account_info(),
                authority: ctx.accounts.escrow_token_account.to_account_info(),
            },
            signer,
        );
        token::transfer(cpi_ctx, 1)?;

        emit!(NFTSold {
            listing:         ctx.accounts.listing.key(),
            seller,
            buyer:           ctx.accounts.buyer.key(),
            nft_mint,
            price,
            platform_fee,
            seller_proceeds,
            sold_at:         Clock::get()?.unix_timestamp,
        });

        msg!(
            "NFT {} sold for {} lamports. Platform fee: {}. Seller proceeds: {}",
            nft_mint,
            price,
            platform_fee,
            seller_proceeds
        );
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────
    //  UPDATE PRICE
    //  Seller can update the price of their listing.
    //  No fee for updating price.
    // ─────────────────────────────────────────────────────────────
    pub fn update_price(ctx: Context<UpdatePrice>, new_price: u64) -> Result<()> {
        require!(new_price >= MIN_PRICE, MarketplaceError::PriceTooLow);
        let listing    = &mut ctx.accounts.listing;
        let old_price  = listing.price;
        let listing_key    = listing.key();
        let listing_seller = listing.seller;
        let listing_mint   = listing.nft_mint;
        listing.price  = new_price;

        emit!(PriceUpdated {
            listing:   listing_key,
            seller:    listing_seller,
            nft_mint:  listing_mint,
            old_price,
            new_price,
        });

        msg!("Price updated: {} → {}", old_price, new_price);
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACCOUNT STRUCTS
// ─────────────────────────────────────────────────────────────────────────────

/// On-chain record for a single NFT listing
#[account]
#[derive(Default)]
pub struct ListingAccount {
    pub seller:       Pubkey,   // 32
    pub nft_mint:     Pubkey,   // 32
    pub price:        u64,      //  8  — in lamports (XNT native)
    pub created_at:   i64,      //  8
    pub bump:         u8,       //  1
    pub escrow_bump:  u8,       //  1
}
// Total: 8 (discriminator) + 82 = 90 bytes

impl ListingAccount {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1 + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  INSTRUCTION CONTEXTS
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ListNft<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    /// NFT mint address
    /// CHECK: We only need the key for PDA seeds
    pub nft_mint: AccountInfo<'info>,

    /// Seller's token account holding the NFT (must have balance=1)
    #[account(
        mut,
        constraint = seller_token_account.mint == nft_mint.key(),
        constraint = seller_token_account.owner == seller.key(),
        constraint = seller_token_account.amount == 1 @ MarketplaceError::NotNFTOwner,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    /// PDA token account that holds the NFT in escrow while listed
    #[account(
        init_if_needed,
        payer = seller,
        token::mint      = nft_mint,
        token::authority = escrow_token_account, // self-custodied PDA
        seeds = [b"escrow", nft_mint.key().as_ref()],
        bump,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Listing state account
    #[account(
        init_if_needed,
        payer = seller,
        space = ListingAccount::LEN,
        seeds = [b"listing", nft_mint.key().as_ref()],
        bump,
    )]
    pub listing: Account<'info, ListingAccount>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DelistNft<'info> {
    #[account(
        mut,
        constraint = seller.key() == listing.seller @ MarketplaceError::Unauthorized,
    )]
    pub seller: Signer<'info>,

    /// NFT mint — needed for PDA seed derivation
    /// CHECK: validated via listing.nft_mint
    #[account(constraint = nft_mint.key() == listing.nft_mint)]
    pub nft_mint: AccountInfo<'info>,

    /// Seller's token account to receive the NFT back
    #[account(
        mut,
        constraint = seller_token_account.mint  == listing.nft_mint,
        constraint = seller_token_account.owner == seller.key(),
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    /// Escrow token account holding the NFT
    #[account(
        mut,
        seeds = [b"escrow", listing.nft_mint.as_ref()],
        bump  = listing.escrow_bump,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Listing account — closed on delist, rent returned to seller
    #[account(
        mut,
        close = seller,
        seeds = [b"listing", listing.nft_mint.as_ref()],
        bump  = listing.bump,
    )]
    pub listing: Account<'info, ListingAccount>,

    /// Platform fee wallet receives the cancel fee
    /// CHECK: address validated against hardcoded PLATFORM_WALLET constant
    #[account(
        mut,
        constraint = platform_wallet.key().to_string() == PLATFORM_WALLET
            @ MarketplaceError::InvalidPlatformWallet,
    )]
    pub platform_wallet: AccountInfo<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyNft<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// NFT mint — for PDA seed derivation
    /// CHECK: validated via listing.nft_mint
    #[account(constraint = nft_mint.key() == listing.nft_mint)]
    pub nft_mint: AccountInfo<'info>,

    /// Buyer's token account to receive the NFT
    #[account(
        mut,
        constraint = buyer_token_account.mint  == listing.nft_mint,
        constraint = buyer_token_account.owner == buyer.key(),
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// Escrow token account holding the NFT
    #[account(
        mut,
        seeds = [b"escrow", listing.nft_mint.as_ref()],
        bump  = listing.escrow_bump,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Listing account — closed on purchase, rent returned to seller
    #[account(
        mut,
        close = seller_wallet,
        seeds = [b"listing", listing.nft_mint.as_ref()],
        bump  = listing.bump,
    )]
    pub listing: Account<'info, ListingAccount>,

    /// Seller wallet to receive proceeds (and listing account rent)
    /// CHECK: validated against listing.seller
    #[account(
        mut,
        constraint = seller_wallet.key() == listing.seller @ MarketplaceError::InvalidSeller,
    )]
    pub seller_wallet: AccountInfo<'info>,

    /// Platform fee wallet
    /// CHECK: validated against hardcoded constant
    #[account(
        mut,
        constraint = platform_wallet.key().to_string() == PLATFORM_WALLET
            @ MarketplaceError::InvalidPlatformWallet,
    )]
    pub platform_wallet: AccountInfo<'info>,

    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(
        mut,
        constraint = seller.key() == listing.seller @ MarketplaceError::Unauthorized,
    )]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"listing", listing.nft_mint.as_ref()],
        bump  = listing.bump,
    )]
    pub listing: Account<'info, ListingAccount>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  EVENTS
// ─────────────────────────────────────────────────────────────────────────────

#[event]
pub struct ListingCreated {
    pub listing:    Pubkey,
    pub seller:     Pubkey,
    pub nft_mint:   Pubkey,
    pub price:      u64,
    pub created_at: i64,
}

#[event]
pub struct ListingCancelled {
    pub listing:    Pubkey,
    pub seller:     Pubkey,
    pub nft_mint:   Pubkey,
    pub cancel_fee: u64,
}

#[event]
pub struct NFTSold {
    pub listing:          Pubkey,
    pub seller:           Pubkey,
    pub buyer:            Pubkey,
    pub nft_mint:         Pubkey,
    pub price:            u64,
    pub platform_fee:     u64,
    pub seller_proceeds:  u64,
    pub sold_at:          i64,
}

#[event]
pub struct PriceUpdated {
    pub listing:   Pubkey,
    pub seller:    Pubkey,
    pub nft_mint:  Pubkey,
    pub old_price: u64,
    pub new_price: u64,
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
    #[msg("Math overflow in fee calculation")]
    MathOverflow,
}