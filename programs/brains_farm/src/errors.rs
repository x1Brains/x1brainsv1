// programs/brains_farm/src/errors.rs

use anchor_lang::prelude::*;

#[error_code]
pub enum FarmError {
    // ── Program state ─────────────────────────────────────────────────────────
    #[msg("Program is paused")]
    Paused,
    #[msg("Farm is paused — no new stakes allowed")]
    FarmPaused,
    #[msg("Reentrancy detected — operation already in progress")]
    Reentrancy,
    #[msg("Math overflow")]
    Overflow,
    #[msg("Farm is closed")]
    FarmClosed,
    #[msg("Clock drift detected — unix_timestamp invalid")]
    ClockDrift,

    // ── Authorization ─────────────────────────────────────────────────────────
    #[msg("Not authorized to perform this action")]
    Unauthorized,
    #[msg("Not the position owner")]
    NotPositionOwner,
    #[msg("Invalid treasury account")]
    InvalidTreasury,

    // ── Farm validation ───────────────────────────────────────────────────────
    #[msg("Reward rate must be greater than zero")]
    RateZero,
    #[msg("Reward rate exceeds safety limit")]
    RateTooHigh,
    #[msg("Target duration too short — minimum 7 days")]
    DurationTooShort,
    #[msg("Target duration too long — maximum 2 years")]
    DurationTooLong,
    #[msg("Seed amount must be greater than zero")]
    SeedZero,

    // ── LP mint provenance ────────────────────────────────────────────────────
    #[msg("LP mint not verified — must come from brains_pairing or XDEX")]
    InvalidLpMint,
    #[msg("PoolRecord account does not match the LP mint")]
    PoolRecordMismatch,
    #[msg("LP mint authority is not XDEX LP authority")]
    NotXdexLpMint,
    #[msg("Invalid brains_pairing program")]
    InvalidPairingProgram,

    // ── Reward vault / funding ────────────────────────────────────────────────
    #[msg("Insufficient reward vault balance for requested operation")]
    InsufficientRewardVault,
    #[msg("Cannot withdraw rewards that are earmarked for stakers")]
    RewardsEarmarked,
    #[msg("Reward mint mismatch — does not match farm config")]
    RewardMintMismatch,
    #[msg("LP mint mismatch — does not match farm config")]
    LpMintMismatch,

    // ── Staking ───────────────────────────────────────────────────────────────
    #[msg("Stake amount below minimum (1 LP token)")]
    StakeTooSmall,
    #[msg("Stake amount must be greater than zero")]
    ZeroAmount,
    #[msg("Maximum positions per user in this farm reached")]
    TooManyPositions,
    #[msg("Position nonce already used")]
    NonceTaken,
    #[msg("Invalid lock type")]
    InvalidLockType,

    // ── Claim ─────────────────────────────────────────────────────────────────
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Must wait 24 hours between claims")]
    ClaimTooSoon,

    // ── Unstake ───────────────────────────────────────────────────────────────
    #[msg("Position belongs to a different farm")]
    WrongFarm,

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    #[msg("Cannot close farm while stakers remain")]
    FarmHasStakers,
    #[msg("Cannot close farm while reward vault has balance — withdraw first")]
    VaultNotEmpty,

    // ── General ───────────────────────────────────────────────────────────────
    #[msg("Invalid bump seed")]
    InvalidBump,
    #[msg("Invalid account data")]
    InvalidAccountData,
}
