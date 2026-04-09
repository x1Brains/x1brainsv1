// programs/brains_pairing/src/constants.rs
// ── ALL ADDRESSES VERIFIED ON-CHAIN · April 2026 ─────────────────────────────

use anchor_lang::prelude::*;
use solana_program::pubkey;

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
pub const INCINERATOR:     Pubkey = pubkey!("1nc1nerator11111111111111111111111111111111");

// ── XDEX program constants ────────────────────────────────────────────────────
pub const XDEX_PROGRAM:      Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
pub const XDEX_LP_AUTH:      Pubkey = pubkey!("9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU");
pub const XDEX_FEE_VAULT:    Pubkey = pubkey!("SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1");
pub const XDEX_AMM_CONFIG_A: Pubkey = pubkey!("2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c");
pub const XDEX_AMM_CONFIG_B: Pubkey = pubkey!("ECVmujod2RNv98T4JrkNwTTVEiMGDMyGztTaTXsYFL4x");
pub const XDEX_MIN_LP_LOCK:  u64   = 100;

// ── XDEX instruction discriminators (verified from mainnet txs) ───────────────
pub const DISC_INITIALIZE: [u8; 8] = [0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed];

// ── Known BRAINS/XNT pool vaults for on-chain price reading ──────────────────
pub const BRAINS_XNT_POOL:       Pubkey = pubkey!("7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg");
pub const BRAINS_XNT_VAULT_XNT:  Pubkey = pubkey!("HJ5WsScycRCtp8yqGsLbcDAayMsbcYajELcALg6kaUaq");
pub const BRAINS_XNT_VAULT_BASE: Pubkey = pubkey!("HnUfCrgrhHzgML92ipbkLGhi2ggm1kdHDvvcqRtuUeb3");

// ── Fee constants ─────────────────────────────────────────────────────────────
pub const FEE_BPS_ECOSYSTEM: u64 = 88;          // 0.888% — BRAINS or LB always
pub const FEE_BPS_DISCOUNT:  u64 = 88;          // 0.888% — any token + 33 LB held
pub const FEE_BPS_STANDARD:  u64 = 188;         // 1.888% — everyone else
pub const FEE_BPS_DELIST:    u64 = 44;          // 0.444%
pub const FEE_EDIT_XNT:      u64 = 1_000_000;   // 0.001 XNT flat
pub const FEE_MINIMUM_XNT:   u64 = 100_000_000; // 0.1 XNT floor — always

// ── LB discount threshold ─────────────────────────────────────────────────────
// 33 LB at 2 decimals = 3300 raw units
pub const LB_DISCOUNT_THRESHOLD: u64 = 3_300;

// ── LP distribution ───────────────────────────────────────────────────────────
pub const TREASURY_LP_BPS: u64 = 500; // 5% of remaining LP after burn → treasury

// ── Price validation ──────────────────────────────────────────────────────────
pub const SLIPPAGE_BPS:         u64 = 5;              // 0.5% tolerance
pub const MAX_PRICE_AGE_SECS:   i64 = 60;             // 60s staleness limit
pub const MAX_PRICE_IMPACT_BPS: u64 = 1_000;          // 10% max price impact

// ── Pool validation ───────────────────────────────────────────────────────────
// $300 TVL minimum — at $0.42 XNT = ~714 XNT = 714_285_714_285 lamports (9 dec)
pub const MIN_POOL_TVL_LAMPORTS: u64 = 714_285_714_285;
pub const MIN_POOL_AGE_SECS:     i64 = 86_400; // 24 hours

// ── Listing validation ────────────────────────────────────────────────────────
pub const MIN_LISTING_USD:    u64 = 1_000_000;      // $1.00 minimum (6 dec)
pub const LARGE_LISTING_USD:  u64 = 10_000_000_000; // $10,000 → commit-reveal required

// ── Commit-reveal ─────────────────────────────────────────────────────────────
pub const COMMIT_REVEAL_SLOTS:   u64 = 3;   // min slots between commit and reveal
pub const COMMIT_EXPIRY_SLOTS:   u64 = 150; // max slots before commitment expires

// ── Rate limiting ─────────────────────────────────────────────────────────────
pub const MAX_LISTINGS_PER_HOUR:  u32 = 2;
pub const RATE_LIMIT_WINDOW_SECS: i64 = 3_600;

// ── Valid burn BPS — whitelist only ───────────────────────────────────────────
pub const VALID_BURN_BPS: [u16; 4] = [0, 2500, 5000, 10000];

// ── Account data offsets ──────────────────────────────────────────────────────
pub const TOKEN_ACCOUNT_AMOUNT_OFFSET:    usize = 64; // u64 balance in SPL token account
pub const XDEX_POOL_CREATED_AT_OFFSET:   usize = 8;  // i64 timestamp in XDEX pool state
