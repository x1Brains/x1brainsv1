// programs/brains_pairing/src/lib.rs
// X1 Brains Liquidity Pairing Protocol — Program 1
// Built with Anchor 0.31.1 on X1 Mainnet (SVM-compatible)

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod state;
pub mod instructions;

use instructions::*;
use state::*;

// Replace with actual program ID after first deploy
declare_id!("DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM");

#[program]
pub mod brains_pairing {
    use super::*;

    // ── Admin ─────────────────────────────────────────────────────────────────

    /// One-time initialization — deploys GlobalState
    pub fn initialize_protocol(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }

    /// Emergency pause — halts create_listing and match_listing
    /// Delist and emergency_withdraw still work when paused
    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        admin::pause_handler(ctx)
    }

    /// Resume normal operation after pause
    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        admin::unpause_handler(ctx)
    }

    /// Flag a wallet — prevents it from creating listings or matching
    pub fn flag_wallet(
        ctx: Context<FlagWallet>,
        target_wallet: Pubkey,
    ) -> Result<()> {
        admin::flag_wallet_handler(ctx, target_wallet)
    }

    /// Remove flag from a wallet
    pub fn unflag_wallet(
        ctx: Context<FlagWallet>,
        target_wallet: Pubkey,
    ) -> Result<()> {
        admin::unflag_wallet_handler(ctx, target_wallet)
    }

    /// Register an existing XDEX pool as an X1 Brains protocol pool
    /// Used once at launch for the 5 pre-existing BRAINS pools
    pub fn seed_pool_record(
        ctx: Context<SeedPoolRecord>,
        params: SeedPoolParams,
    ) -> Result<()> {
        seed_pool::handler(ctx, params)
    }

    // ── Listings ──────────────────────────────────────────────────────────────

    /// Create a listing — lock tokens in escrow, pay listing fee
    /// Any token with an XNT pool on XDEX can be listed
    pub fn create_listing(
        ctx: Context<CreateListing>,
        params: CreateListingParams,
    ) -> Result<()> {
        create_listing::handler(ctx, params)
    }

    /// Edit a listing — change amount or burn %
    /// Costs 0.001 XNT flat fee
    pub fn edit_listing(
        ctx: Context<EditListing>,
        params: EditListingParams,
    ) -> Result<()> {
        edit_listing::handler(ctx, params)
    }

    /// Delist — cancel listing, return tokens, pay 0.444% delist fee
    pub fn delist(ctx: Context<Delist>, params: DelistParams) -> Result<()> {
        delist::handler(ctx, params)
    }

    // ── Matching ──────────────────────────────────────────────────────────────

    /// Step 1 of commit-reveal for large listings (>$10,000)
    /// Submit a commitment hash before revealing the match
    pub fn commit_match(
        ctx: Context<CommitMatch>,
        params: CommitMatchParams,
    ) -> Result<()> {
        match_listing::commit_handler(ctx, params)
    }

    /// Match a listing — deposit token_b, create XDEX pool via CPI
    /// Distribute LP tokens, collect matching fee
    pub fn match_listing(
        ctx: Context<MatchListing>,
        params: MatchListingParams,
    ) -> Result<()> {
        match_listing::handler(ctx, params)
    }

    // ── Emergency ─────────────────────────────────────────────────────────────

    /// Emergency withdraw — ALWAYS available, even when paused
    /// Original lister can always recover their escrowed tokens
    /// No fee charged. User funds are always safe.
    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>) -> Result<()> {
        emergency::handler(ctx)
    }
}
