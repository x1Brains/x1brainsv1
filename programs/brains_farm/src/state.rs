// programs/brains_farm/src/state.rs

use anchor_lang::prelude::*;

// ── FarmGlobal ────────────────────────────────────────────────────────────────
// Singleton — one per program
// PDA seeds: [b"farm_global"]
#[account]
pub struct FarmGlobal {
    pub admin:            Pubkey, // 32
    pub treasury:         Pubkey, // 32
    pub total_farms:      u64,    // 8  — lifetime farm creation count
    pub active_farms:     u64,    // 8  — currently-active farms (not closed)
    pub total_positions:  u64,    // 8  — lifetime stake position count
    pub total_fee_xnt:    u64,    // 8  — lifetime stake-fee XNT collected
    pub paused:           bool,   // 1  — global emergency pause
    pub is_locked:        bool,   // 1  — reentrancy guard
    pub bump:             u8,     // 1
}
impl FarmGlobal {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1; // 107
}

// ── Farm ──────────────────────────────────────────────────────────────────────
// One per (lp_mint, reward_mint) combination
// PDA seeds: [b"farm", lp_mint, reward_mint]
//
// Perpetual-farm design: no end_ts, farm runs until reward_vault is empty.
// Emissions are capped at every settle to `min(potential, remaining_unearmarked)`.
#[account]
pub struct Farm {
    pub lp_mint:               Pubkey,     // 32
    pub reward_mint:           Pubkey,     // 32
    pub lp_vault:              Pubkey,     // 32
    pub reward_vault:          Pubkey,     // 32

    // Emission rate — scaled by ACC_PRECISION (1e18) so low-decimal tokens
    // can have sub-raw-unit-per-second rates without precision loss.
    pub reward_rate_per_sec:   u128,       // 16 — u128 scaled

    // Reward accounting (MasterChef accumulator, scaled by ACC_PRECISION)
    pub acc_reward_per_share:  u128,       // 16
    pub last_update_ts:        i64,        // 8

    // TVL tracking
    pub total_staked:          u64,        // 8  — raw LP in lp_vault
    pub total_effective:       u64,        // 8  — weighted TVL (bps-multiplied)

    // Earmarking — admin cannot withdraw below this
    pub total_pending_rewards: u64,        // 8  — cumulatively-accrued unclaimed rewards
    pub total_emitted:         u64,        // 8  — cumulative emitted (for stats UI)

    // Lifecycle
    pub start_ts:              i64,        // 8  — farm launch (informational)
    pub created_at:            i64,        // 8
    pub paused:                bool,       // 1
    pub closed:                bool,       // 1

    // Bumps
    pub lp_vault_bump:         u8,         // 1
    pub reward_vault_bump:     u8,         // 1
    pub bump:                  u8,         // 1
}
impl Farm {
    pub const LEN: usize =
        8 +     // discriminator
        32*4 +  // lp_mint + reward_mint + lp_vault + reward_vault = 128
        16 +    // reward_rate_per_sec (u128)
        16 +    // acc_reward_per_share (u128)
        8 +     // last_update_ts (i64)
        8 +     // total_staked (u64)
        8 +     // total_effective (u64)
        8 +     // total_pending_rewards (u64)
        8 +     // total_emitted (u64)
        8 +     // start_ts (i64)
        8 +     // created_at (i64)
        1 +     // paused (bool)
        1 +     // closed (bool)
        1 +     // lp_vault_bump (u8)
        1 +     // reward_vault_bump (u8)
        1;      // bump (u8)
    // = 229 bytes total
}

// ── StakePosition ─────────────────────────────────────────────────────────────
// One per user deposit
// PDA seeds: [b"position", owner, farm, nonce_le_bytes]
#[account]
pub struct StakePosition {
    pub owner:            Pubkey,    // 32
    pub farm:             Pubkey,    // 32
    pub nonce:            u32,       // 4
    pub amount:            u64,      // 8  — raw LP staked
    pub effective_amount: u64,       // 8  — amount × multiplier_bps / 10_000
    pub lock_type:        LockType,  // 1
    pub reward_debt:      u128,      // 16 — acc snapshot at last interaction
    pub pending_rewards:  u64,       // 8  — earned, not yet claimed
    pub start_ts:         i64,       // 8  — stake creation
    pub grace_end_ts:     i64,       // 8  — start_ts + 3 days
    pub unlock_ts:        i64,       // 8  — start_ts + lock_duration
    pub lock_duration:    i64,       // 8  — stored for penalty midpoint calc
    pub last_claim_ts:    i64,       // 8  — for 24h cooldown check
    pub bump:             u8,        // 1
}
impl StakePosition {
    pub const LEN: usize =
        8 +    // discriminator
        32 +   // owner
        32 +   // farm
        4 +    // nonce
        8 +    // amount
        8 +    // effective_amount
        1 +    // lock_type
        16 +   // reward_debt
        8 +    // pending_rewards
        8 +    // start_ts
        8 +    // grace_end_ts
        8 +    // unlock_ts
        8 +    // lock_duration
        8 +    // last_claim_ts
        1;     // bump
    // = 158
}

// ── LockType ──────────────────────────────────────────────────────────────────
// Three tiers, no Flex. Each maps to a fixed duration + multiplier (see constants).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LockType {
    Locked30,
    Locked90,
    Locked365,
}

impl LockType {
    pub fn duration_secs(&self) -> i64 {
        match self {
            LockType::Locked30  => crate::constants::LOCK_30_SECS,
            LockType::Locked90  => crate::constants::LOCK_90_SECS,
            LockType::Locked365 => crate::constants::LOCK_365_SECS,
        }
    }
    pub fn multiplier_bps(&self) -> u64 {
        match self {
            LockType::Locked30  => crate::constants::MULTIPLIER_30_BPS,
            LockType::Locked90  => crate::constants::MULTIPLIER_90_BPS,
            LockType::Locked365 => crate::constants::MULTIPLIER_365_BPS,
        }
    }
}

// ── LpSource ──────────────────────────────────────────────────────────────────
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LpSource {
    BrainsPairing,
    Xdex,
}

// ── Param structs ─────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateFarmParams {
    /// Total reward tokens (raw units) intended to seed the farm.
    /// reward_rate_per_sec = seed_amount * ACC_PRECISION / target_duration_secs
    /// Admin funds vault separately via fund_farm after this ix succeeds.
    pub seed_amount:           u64,
    pub target_duration_secs:  i64,
    pub source:                LpSource,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StakeParams {
    pub amount:    u64,
    pub lock_type: LockType,
    pub nonce:     u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimParams {
    pub nonce: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UnstakeParams {
    pub nonce: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct FundFarmParams {
    pub amount: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateRateParams {
    /// New reward_rate_per_sec, scaled by ACC_PRECISION.
    pub new_rate: u128,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawRewardsParams {
    pub amount: u64,
}
