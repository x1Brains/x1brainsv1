// programs/brains_pairing/src/state.rs

use anchor_lang::prelude::*;

// ── GlobalState ───────────────────────────────────────────────────────────────
// One per program — singleton
// PDA seeds: [b"global_state"]
#[account]
pub struct GlobalState {
    pub admin:               Pubkey, // 32 — admin wallet
    pub treasury:            Pubkey, // 32 — fee destination
    pub total_fee_xnt:       u64,    // 8  — lifetime XNT fees collected (lamports)
    pub total_listings:      u64,    // 8  — lifetime listing count
    pub total_pools_created: u64,    // 8  — lifetime pool creation count
    pub open_listings:       u64,    // 8  — currently open listings
    pub paused:              bool,   // 1  — emergency pause
    pub is_locked:           bool,   // 1  — reentrancy guard
    pub bump:                u8,     // 1
}
// space: 8 (discriminator) + 32+32+8+8+8+8+1+1+1 = 107

// ── ListingState ──────────────────────────────────────────────────────────────
// One per open listing
// PDA seeds: [b"listing", creator, token_a_mint]
#[account]
pub struct ListingState {
    pub creator:          Pubkey,        // 32
    pub token_a_mint:     Pubkey,        // 32 — any token with XNT pool
    pub token_a_amount:   u64,           // 8  — current escrowed amount
    pub token_a_usd_val:  u64,           // 8  — USD value at listing (6 dec)
    pub token_a_xnt_val:  u64,           // 8  — XNT value at listing (9 dec)
    pub token_a_mc:       u64,           // 8  — market cap at listing (6 dec)
    pub burn_bps:         u16,           // 2  — 0/2500/5000/10000
    pub is_ecosystem:     bool,          // 1  — BRAINS or LB = true
    pub status:           ListingStatus, // 1
    pub escrow_bump:      u8,            // 1  — stored canonical bump (Layer 11)
    pub escrow_auth_bump: u8,            // 1  — escrow authority bump
    pub created_at:       i64,           // 8
    pub bump:             u8,            // 1
}
// space: 8 + 32+32+8+8+8+8+2+1+1+1+1+8+1 = 119

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum ListingStatus {
    Open,
    Matched,
    Delisted,
}

// ── PoolRecord ────────────────────────────────────────────────────────────────
// One per XDEX pool created via this protocol
// PDA seeds: [b"pool_record", pool_address]
// Also created for the 5 seeded existing pools (seeded = true)
#[account]
pub struct PoolRecord {
    pub pool_address: Pubkey,   // 32
    pub lp_mint:      Pubkey,   // 32
    pub token_a_mint: Pubkey,   // 32
    pub token_b_mint: Pubkey,   // 32
    pub sym_a:        [u8; 12], // 12 — symbol padded with zeros
    pub sym_b:        [u8; 12], // 12
    pub burn_bps:     u16,      // 2
    pub lp_burned:    u64,      // 8
    pub lp_treasury:  u64,      // 8
    pub lp_to_user_a: u64,      // 8
    pub lp_to_user_b: u64,      // 8
    pub creator_a:    Pubkey,   // 32
    pub creator_b:    Pubkey,   // 32
    pub usd_val:      u64,      // 8
    pub created_at:   i64,      // 8
    pub seeded:       bool,     // 1 — true = admin seeded existing pool
    pub bump:         u8,       // 1
}
// space: 8 + 32*6+12+12+2+8+8+8+8+8+8+1+1 = 274

// ── WalletState ───────────────────────────────────────────────────────────────
// One per wallet — rate limiting and blacklist
// PDA seeds: [b"wallet_state", wallet_pubkey]
#[account]
pub struct WalletState {
    pub last_listing_at:    i64,  // 8
    pub listings_this_hour: u32,  // 4
    pub hour_window_start:  i64,  // 8
    pub last_match_at:      i64,  // 8
    pub total_listings:     u32,  // 4
    pub total_matches:      u32,  // 4
    pub is_flagged:         bool, // 1
    pub bump:               u8,   // 1
}
// space: 8 + 8+4+8+8+4+4+1+1 = 46

// ── MatchCommitment ───────────────────────────────────────────────────────────
// Commit-reveal for large listings (>$10,000) — Layer 12
// PDA seeds: [b"commitment", matcher, listing]
#[account]
pub struct MatchCommitment {
    pub matcher:     Pubkey,   // 32
    pub listing:     Pubkey,   // 32
    pub commit_hash: [u8; 32], // 32
    pub commit_slot: u64,      // 8
    pub revealed:    bool,     // 1
    pub bump:        u8,       // 1
}
// space: 8 + 32+32+32+8+1+1 = 114

// ── SeedPoolParams ────────────────────────────────────────────────────────────
// Parameters for admin seeding existing pools
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SeedPoolParams {
    pub pool_address: Pubkey,
    pub lp_mint:      Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub sym_a:        [u8; 12],
    pub sym_b:        [u8; 12],
}
