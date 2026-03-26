// ─────────────────────────────────────────────
// CONSTANTS — shared across the entire X1 Brains app
// ─────────────────────────────────────────────

// ── Tokens & RPC ─────────────────────────────
export const BRAINS_MINT  = 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN';
export const XNT_WRAPPED  = 'So11111111111111111111111111111111111111112';
export const RPC_ENDPOINT = 'https://rpc.mainnet.x1.xyz';
export const XDEX_API     = '/xdex';

// ── Logos ────────────────────────────────────
export const BRAINS_LOGO = 'https://mint.xdex.xyz/ipfs/QmWVZ29dfptaWTcJRT6ePsCJS5juoV36afrWL8WqTKGo75?pinataGatewayToken=yMPvcPv-nyFCJ0GGUmoHxYkuVS6bZxS_ucWqpMpVMedA3_nOdJO5uUqA8dibii5a';
export const XNT_LOGO    = 'https://raw.githubusercontent.com/x1-labs/x1-assets/main/tokens/xnt/logo.png';

// ── NFT Collection ───────────────────────────
export const NFT_TOTAL_SUPPLY    = 88;
export const NFT_COLLECTION_NAME = 'LabWork';
export const NFT_SYMBOL          = 'LabWork';
export const NFT_PRICE_XNT       = 0.88;

// ── Marketplace ──────────────────────────────
// Deployed Anchor program on X1 mainnet — handles list, buy, cancel.
export const MARKETPLACE_PROGRAM_ID_STRING = 'CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4';

// Platform wallet that receives all marketplace fees.
// Must exactly match the pubkey hardcoded inside the Rust program.
export const PLATFORM_WALLET_STRING = 'CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF';

// Sale fee: 1.888% — expressed as numerator over denominator
// 1.888% = 1888 / 100_000
export const SALE_FEE_NUMERATOR   = 1888;
export const SALE_FEE_DENOMINATOR = 100_000;

// Cancel fee: 0.888% — charged when seller delists
export const CANCEL_FEE_NUMERATOR   = 888;
export const CANCEL_FEE_DENOMINATOR = 100_000;

// Legacy fee constants (kept for backwards compat with existing LabWork.tsx refs)
export const FEE_BPS   = 188;   // ~1.888% in basis points (rounded)
export const BPS_DENOM = 10_000;

// ── IPFS Gateways ────────────────────────────
export const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
];

// ── Cyberdyne Unlimited — Imperial API ───────
// Public, CORS-enabled. Direct browser fetch — no proxy required.
export const IMPERIAL_BASE = 'http://jack-nucbox-m6-ultra.tail515dc.ts.net:8773';

export const IMPERIAL_API = {
  health:      `${IMPERIAL_BASE}/api/health`,
  citizens:    `${IMPERIAL_BASE}/api/citizens`,
  tiers:       `${IMPERIAL_BASE}/api/tiers`,
  leaderboard: (limit = 10) => `${IMPERIAL_BASE}/api/leaderboard?limit=${limit}`,
  citizen:     (id: string) => `${IMPERIAL_BASE}/api/citizen/${id}`,
} as const;

// ── Navigation ───────────────────────────────
export const NAV_LINKS = [
  { label: 'X1 Brains', href: 'https://x1brains.xyz',            icon: '🧠' },
  { label: 'X1.Ninja',  href: 'https://x1.ninja',                icon: '🥷' },
  { label: 'XDex',      href: 'https://app.xdex.xyz',            icon: '⚡' },
  { label: 'Explorer',  href: 'https://explorer.mainnet.x1.xyz', icon: '🔍' },
  { label: 'X1 Docs',   href: 'https://docs.x1.xyz',             icon: '📄' },
];

export const APP_ROUTES = [
  { label: 'Portfolio',  path: '/portfolio',  icon: '💼' },
  { label: 'Lab Work',   path: '/labwork',    icon: '🔬' },
  { label: 'Cyberdyne',  path: '/cyberdyne',  icon: '⚔️'  },
];

// ── Rarity Tiers ─────────────────────────────
export const RARITY_TIERS = {
  LEGENDARY: { label: 'LEGENDARY', color: '#ff4444', bg: 'rgba(255,68,68,0.12)',   border: 'rgba(255,68,68,0.4)',   glow: '#ff4444', minScore: 95, count: 4  },
  EPIC:      { label: 'EPIC',      color: '#bf5af2', bg: 'rgba(191,90,242,0.12)',  border: 'rgba(191,90,242,0.4)',  glow: '#bf5af2', minScore: 80, count: 12 },
  RARE:      { label: 'RARE',      color: '#00d4ff', bg: 'rgba(0,212,255,0.10)',   border: 'rgba(0,212,255,0.35)', glow: '#00d4ff', minScore: 60, count: 24 },
  UNCOMMON:  { label: 'UNCOMMON',  color: '#00c98d', bg: 'rgba(0,201,141,0.10)',   border: 'rgba(0,201,141,0.35)', glow: '#00c98d', minScore: 35, count: 28 },
  COMMON:    { label: 'COMMON',    color: '#ff8c00', bg: 'rgba(255,140,0,0.08)',   border: 'rgba(255,140,0,0.3)',  glow: '#ff8c00', minScore: 0,  count: 20 },
} as const;

// ── Token Metadata ───────────────────────────
export const XNT_INFO = {
  name:    'X1 Native Token',
  symbol:  'XNT',
  logoUri: XNT_LOGO,
};

// ── Program IDs ──────────────────────────────
export const METADATA_PROGRAM_ID_STRING = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';