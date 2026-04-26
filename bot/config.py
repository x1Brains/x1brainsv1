"""
X1 Brains Bot — Static Configuration
=====================================
Only stuff that doesn't change. Everything sensitive (Telegram token,
chat ID, pool vaults) lives in Supabase, fetched at runtime.

Required environment variables (set via `fly secrets set`):
  - SUPABASE_URL
  - SUPABASE_SERVICE_KEY
"""

import os

# ═══════════════════════════════════════════════════════════
# X1 NETWORK
# ═══════════════════════════════════════════════════════════
RPC_URL = "https://rpc.mainnet.x1.xyz"
EXPLORER_URL = "https://explorer.x1.xyz"
# Bot calls XDEX price API directly (api.xdex.xyz). The frontend goes
# through /api/xdex-price which Vercel rewrites to api.xdex.xyz, but the
# bot lives on Fly.io — no need to round-trip through Vercel.
XDEX_PRICE_BASE = "https://api.xdex.xyz/api"

# ═══════════════════════════════════════════════════════════
# SUPABASE
# ═══════════════════════════════════════════════════════════
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# ═══════════════════════════════════════════════════════════
# TOKENS — pre-filled from your codebase
# ═══════════════════════════════════════════════════════════
WXNT_MINT = "So11111111111111111111111111111111111111112"

TOKENS = {
    "BRAINS": {
        "mint": "EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN",
        "decimals": 9,
        "symbol": "BRAINS",
        "name": "X1 Brains",
        "emoji": "🧠",
        "is_token_2022": True,
        "pool": "7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg",
        "lp_mint": "FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3",
    },
    "LB": {
        "mint": "Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6",
        "decimals": 2,
        "symbol": "LB",
        "name": "Lab Work",
        "emoji": "🧪",
        "is_token_2022": False,
        "pool": "CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK",
        "lp_mint": "85g2x1AcRyogMTDuWNWKJDPFQ3pTQdBpNWm2tK4YiXci",
    },
}

PROGRAMS = {
    "PAIRING":     "DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM",
    "FARMS":       "Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg",
    "XDEX":        "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN",
    "TOKEN":       "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TOKEN_2022":  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
}

INCINERATOR_ADDR = "1nc1nerator11111111111111111111111111111111"
TREASURY_ADDR    = "CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF"

LB_TIERS = [
    {"name": "🥇 Tier 3", "ui_min": 3_300, "color": "#ff8c00"},
    {"name": "🥈 Tier 2", "ui_min":   330, "color": "#bf5af2"},
    {"name": "🥉 Tier 1", "ui_min":    33, "color": "#00c98d"},
]

# Default settings used when DB row is missing fields
DEFAULT_SETTINGS = {
    "brains_buys": True, "brains_burns": True, "brains_lp": True,
    "brains_stake": True, "brains_unstake": True, "brains_claim": True,
    "lb_buys": True, "lb_burns": True, "lb_lp": True,
    "lb_stake": True, "lb_unstake": True, "lb_claim": True,
    "min_buy_usd": 5.0, "min_burn_tokens": 1.0,
    "min_lp_usd": 1.0, "min_stake_lp": 0.0, "min_claim_usd": 1.0,
    "tier_big_usd": 100.0, "tier_whale_usd": 1000.0,
}

# ═══════════════════════════════════════════════════════════
# POLLING
# ═══════════════════════════════════════════════════════════
POLL_INTERVAL  = 5
SIG_BATCH_SIZE = 30
PRICE_CACHE_TTL = 60
