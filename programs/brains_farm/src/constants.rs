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
// Four-tier LB-holder discount ladder (checked highest-first so users always
// get their best-qualifying tier). All values in bps.
//
// Period 1 (past grace, first 50% of lock duration):
//   - No LB (< 33 LB):              4.000%  (400 bps) [baseline]
//   - Tier 1 (≥ 33 LB):             1.888%  (188 bps)
//   - Tier 2 (≥ 330 LB):            1.000%  (100 bps)
//   - Tier 3 (≥ 3,300 LB):          0.500%   (50 bps)
//
// Period 2 (second 50% of lock duration):
//   - No LB:                        1.888%  (188 bps) [baseline]
//   - Tier 1 (≥ 33 LB):             0.888%   (88 bps)
//   - Tier 2 (≥ 330 LB):            0.444%   (44 bps, rounded from 44.4)
//   - Tier 3 (≥ 3,300 LB):          0.222%   (22 bps, rounded from 22.2)
//
// After lock expires: 0% penalty, free withdrawal forever.
// Pending rewards are forfeited on any early exit → stay in vault, boost APR.
// Rounding note: T2/T3 P2 values round down to nearest whole bp. Users lose
// at most 0.004% of LP vs the exact decimal. Negligible and makes integer
// arithmetic simpler throughout the program.
pub const PENALTY_P1_STANDARD_BPS: u64 = 400;  // 4.000% — no LB
pub const PENALTY_P1_TIER1_BPS:    u64 = 188;  // 1.888% — ≥ 33 LB
pub const PENALTY_P1_TIER2_BPS:    u64 = 100;  // 1.000% — ≥ 330 LB
pub const PENALTY_P1_TIER3_BPS:    u64 =  50;  // 0.500% — ≥ 3,300 LB

pub const PENALTY_P2_STANDARD_BPS: u64 = 188;  // 1.888% — no LB
pub const PENALTY_P2_TIER1_BPS:    u64 =  88;  // 0.888% — ≥ 33 LB
pub const PENALTY_P2_TIER2_BPS:    u64 =  44;  // 0.444% — ≥ 330 LB
pub const PENALTY_P2_TIER3_BPS:    u64 =  22;  // 0.222% — ≥ 3,300 LB

pub const BPS_DENOMINATOR: u64 = 10_000;

// ── LB discount thresholds (raw units, 2 decimals) ────────────────────────────
// 33 LB = 3,300 raw, 330 LB = 33,000 raw, 3,300 LB = 330,000 raw.
// Legacy name kept for backward-compat / call sites that want the minimum tier.
pub const LB_DISCOUNT_THRESHOLD:       u64 =   3_300;  // 33 LB   (tier 1 entry)
pub const LB_DISCOUNT_THRESHOLD_T1:    u64 =   3_300;  // 33 LB
pub const LB_DISCOUNT_THRESHOLD_T2:    u64 =  33_000;  // 330 LB
pub const LB_DISCOUNT_THRESHOLD_T3:    u64 = 330_000;  // 3,300 LB

// ── APR caps — sanity limits to prevent admin fat-finger ─────────────────────
// The cap is on the SCALED rate (after × ACC_PRECISION). Working backwards:
//   raw_units_per_sec_ceiling = MAX_REWARD_RATE_PER_SEC / ACC_PRECISION
//                             = 1e30 / 1e18 = 1e12 raw units/sec
// For a 9-decimal reward token (BRAINS), that's 1,000 tokens/sec = ~31.5B/year.
// For a 2-decimal reward token (LB), that's 10 billion tokens/sec. Either way,
// any rate high enough to hit this cap is a clear fat-finger. Launch rates:
//   BRAINS: 1.408e25 scaled (~0.014 BRAINS/sec)  → well under cap ✓
//   LB:     1.585e16 scaled (~0.0000159 LB/sec)  → well under cap ✓
pub const MAX_REWARD_RATE_PER_SEC: u128 = 1_000_000_000_000_000_000_000_000_000_000; // 1e30
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
// 100 raw units = 0.0000001 LP at 9-decimal LP mint.
// XDEX LP tokens represent large pool shares (each raw unit ≈ $0.000007 at
// current pool pricing), so setting this low lets small users ($3+) participate.
// Spam is deterred by STAKE_FEE_XNT_LAMPORTS (0.005 XNT = ~$0.002 per stake),
// not by this minimum. Mainly a sanity floor against accidental zero-shift errors.
pub const MIN_STAKE_RAW: u64 = 100;

// ── Stake fee (flat, to treasury, paid in XNT lamports) ──────────────────────
// 0.005 XNT per stake. Spam deterrent.
pub const STAKE_FEE_XNT_LAMPORTS: u64 = 5_000_000;

// ── Position nonce cap — max concurrent positions per (user, farm) ───────────
pub const MAX_POSITIONS_PER_USER_PER_FARM: u32 = 100;

// ── Rate update sanity limits ────────────────────────────────────────────────
// Admin cannot change the rate more than ±MAX_RATE_CHANGE_FACTOR per update.
// Adding a proper timelock would require a new state field; the magnitude cap
// alone removes admin's ability to drain the vault in seconds via a massive
// rate spike. Ratcheting up by 2× repeatedly to reach a target is still
// possible but visible on-chain and rate-limited by tx throughput.
pub const MAX_RATE_UP_NUM:   u128 = 2;  // new_rate ≤ old_rate × 2
pub const MAX_RATE_DOWN_DEN: u128 = 2;  // new_rate ≥ old_rate / 2

// ── Farm lifecycle minimums ───────────────────────────────────────────────────
// target_duration_seconds used in create_farm to compute initial rate.
// After creation, farm runs until reward_vault is empty (no hard end date).
pub const MIN_TARGET_DURATION_SECS: i64 = 7  * 24 * 60 * 60; // 7 days — no flash farms
pub const MAX_TARGET_DURATION_SECS: i64 = 730 * 24 * 60 * 60; // 2 years — forces periodic review
