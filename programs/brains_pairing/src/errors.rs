// programs/brains_pairing/src/errors.rs

use anchor_lang::prelude::*;

#[error_code]
pub enum PairingError {
    // ── Program state ─────────────────────────────────────────────────────────
    #[msg("Program is paused")]
    Paused,
    #[msg("Reentrancy detected — operation already in progress")]
    Reentrancy,
    #[msg("Math overflow")]
    Overflow,
    #[msg("LP math integrity check failed — tokens do not add up")]
    LpMath,

    // ── Authorization ─────────────────────────────────────────────────────────
    #[msg("Not authorized to perform this action")]
    Unauthorized,
    #[msg("Cannot match your own listing")]
    SelfMatch,
    #[msg("Wallet is flagged and cannot use this protocol")]
    WalletFlagged,

    // ── Token & amount validation ─────────────────────────────────────────────
    #[msg("Invalid burn BPS — must be 0, 2500, 5000, or 10000")]
    InvalidBurnBps,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Listing USD value below $1.00 minimum")]
    AmountTooSmall,
    #[msg("Invalid treasury account")]
    InvalidTreasury,
    #[msg("Invalid XDEX program ID")]
    InvalidXdexProgram,
    #[msg("Invalid AMM config — must be Config A or Config B")]
    InvalidAmmConfig,

    // ── Price validation ──────────────────────────────────────────────────────
    #[msg("Price data is stale — must be less than 60 seconds old")]
    PriceStale,
    #[msg("Invalid timestamp — cannot be in the future")]
    InvalidTimestamp,
    #[msg("Price is zero or invalid")]
    InvalidPrice,
    #[msg("USD values differ by more than 0.5%")]
    PriceMismatch,
    #[msg("Price impact too high — pool liquidity too thin for this amount")]
    PriceImpactTooHigh,
    #[msg("Submitted price disagrees with on-chain pool reserves")]
    PriceReservesMismatch,

    // ── Pool validation ───────────────────────────────────────────────────────
    #[msg("Token has no XNT liquidity pool on XDEX — create one first")]
    NoXntPool,
    #[msg("Invalid pool address — does not match expected PDA derivation")]
    InvalidPoolAddress,
    #[msg("Pool TVL too low — minimum $300 required")]
    PoolTvlTooLow,
    #[msg("Pool too new — must be at least 24 hours old")]
    PoolTooNew,
    #[msg("Pool already exists for this token pair on XDEX")]
    PoolExists,
    #[msg("Invalid pool data — could not read pool state")]
    InvalidPoolData,

    // ── Listing state ─────────────────────────────────────────────────────────
    #[msg("Listing is not open")]
    ListingNotOpen,
    #[msg("Rate limited — maximum 2 listings per hour")]
    RateLimited,

    // ── CPI & execution ───────────────────────────────────────────────────────
    #[msg("Insufficient LP tokens received from XDEX pool creation")]
    InsufficientLpReceived,
    #[msg("Transaction slot too old — please retry")]
    TransactionTooOld,
    #[msg("Invalid bump seed")]
    InvalidBump,
    #[msg("Invalid sysvar data")]
    InvalidSysvar,

    // ── Commit-reveal ─────────────────────────────────────────────────────────
    #[msg("Large listing requires commit-reveal — submit commitment first")]
    CommitmentRequired,
    #[msg("Commitment hash does not match revealed data")]
    CommitmentMismatch,
    #[msg("Too early to reveal — wait for commit slots to pass")]
    RevealTooEarly,
    #[msg("Commitment expired — please recommit")]
    CommitmentExpired,
    #[msg("Commitment already revealed")]
    AlreadyRevealed,
}
