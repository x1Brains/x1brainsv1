// programs/brains_farm/src/constants.rs
// X1 Brains Farming Protocol — constants
// ── ALL ADDRESSES VERIFIED ON-CHAIN · April 2026 ─────────────────────────────

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

// ── Ecosystem token mints ─────────────────────────────────────────────────────
pub const BRAINS_MINT: Pubkey = pubkey!("EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN");
pub const LB_MINT:     Pubkey = pubkey!("Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6");
pub const WXNT_MINT:   Pubkey = pubkey!("So11111111111111111111111111111111111111112");

// ── Ecosystem token decimals ──────────────────────────────────────────────────
pub const BRAINS_DECIMALS: u8 = 9;
pub const LB_DECIMALS:     u8 = 2;

// ── Protocol wallets ──────────────────────────────────────────────────────────
pub const ADMIN_WALLET:    Pubkey = pubkey!("CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2");
pub const TREASURY_WALLET: Pubkey = pubkey!("CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF");

// ── Sister program (LP mint validation) ───────────────────────────────────────
pub const BRAINS_PAIRING_PROGRAM: Pubkey = pubkey!("DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM");

// ── XDEX constants (LP mint validation) ───────────────────────────────────────
pub const XDEX_PROGRAM:  Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
pub const XDEX_LP_AUTH:  Pubkey = pubkey!("9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU");

// ── Lock durations (seconds) ──────────────────────────────────────────────────
pub const LOCK_30_SECS:  i64 =  30 * 24 * 60 * 60;  //  30 days
pub const LOCK_90_SECS:  i64 =  90 * 24 * 60 * 60;  //  90 days
pub const LOCK_365_SECS: i64 = 365 * 24 * 60 * 60;  // 365 days

// ── Grace period — no penalty if exited within this window from stake start ──
pub const GRACE_PERIOD_SECS: i64 = 3 * 24 * 60 * 60;  // 3 days

// ── Claim cooldown — min time between claims for a single position ───────────
pub const CLAIM_COOLDOWN_SECS: i64 = 24 * 60 * 60;  // 24 hours

// ── Early-exit penalty (two-tier, LP principal → treasury) ───────────────────
//
// Period 1 (past grace, first 50% of lock duration):
//   - Standard:                     4.000%  (400 bps)
//   - LB holder (≥33 LB):           1.888%  (188 bps)
//
// Period 2 (second 50% of lock duration):
//   - Standard:                     1.888%  (188 bps)
//   - LB holder (≥33 LB):           0.888%   (88 bps)
//
// After lock expires: 0% penalty, free withdrawal forever.
// Pending rewards are forfeited on any early exit → stay in vault, boost APR.
pub const PENALTY_P1_STANDARD_BPS: u64 = 400;  // 4.000%
pub const PENALTY_P1_DISCOUNT_BPS: u64 = 188;  // 1.888%
pub const PENALTY_P2_STANDARD_BPS: u64 = 188;  // 1.888%
pub const PENALTY_P2_DISCOUNT_BPS: u64 =  88;  // 0.888%

pub const BPS_DENOMINATOR: u64 = 10_000;

// ── LB discount threshold ─────────────────────────────────────────────────────
// 33 LB at 2 decimals = 3300 raw units. Matches brains_pairing discount.
pub const LB_DISCOUNT_THRESHOLD: u64 = 3_300;

// ── APR caps — sanity limits to prevent admin fat-finger ─────────────────────
pub const MAX_REWARD_RATE_PER_SEC: u128 = 1_000_000_000_000_000_000_000; // very generous upper bound
// 500% APR target ceiling displayed by UI, not enforced on-chain (honest:
// actual APR is reward_rate × multiplier / total_effective, which we can't
// bound without knowing TVL).

// ── Reward accumulator precision ──────────────────────────────────────────────
// Scaled by 1e18 so that low-decimal tokens (like LB at 2 decimals) can have
// sub-raw-unit emission rates. u128 can hold values up to ~3.4e38, so with 1e18
// precision we have ~3.4e20 headroom for (emission_over_time × reward_rate) math
// before any overflow concern — plenty for realistic TVL.
pub const ACC_PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18

// ── Lock multipliers (stored in bps out of 10_000) ───────────────────────────
// Locked30:   2.0×  (weight =  20_000 / 10_000)
// Locked90:   4.0×  (weight =  40_000 / 10_000)
// Locked365:  8.0×  (weight =  80_000 / 10_000)
pub const MULTIPLIER_30_BPS:  u64 = 20_000;
pub const MULTIPLIER_90_BPS:  u64 = 40_000;
pub const MULTIPLIER_365_BPS: u64 = 80_000;

// ── Minimum stake amount (raw LP units) ───────────────────────────────────────
// 1 LP token (XDEX LP is 9 decimals). Prevents dust positions.
pub const MIN_STAKE_RAW: u64 = 1_000_000_000;

// ── Stake fee (flat, to treasury, paid in XNT lamports) ──────────────────────
// 0.005 XNT per stake. Spam deterrent.
pub const STAKE_FEE_XNT_LAMPORTS: u64 = 5_000_000;

// ── Position nonce cap — max concurrent positions per (user, farm) ───────────
pub const MAX_POSITIONS_PER_USER_PER_FARM: u32 = 100;

// ── Farm lifecycle minimums ───────────────────────────────────────────────────
// target_duration_seconds used in create_farm to compute initial rate.
// After creation, farm runs until reward_vault is empty (no hard end date).
pub const MIN_TARGET_DURATION_SECS: i64 = 7  * 24 * 60 * 60; // 7 days — no flash farms
pub const MAX_TARGET_DURATION_SECS: i64 = 730 * 24 * 60 * 60; // 2 years — forces periodic review
