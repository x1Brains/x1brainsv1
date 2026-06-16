// src/pages/LpFarms.tsx
// X1 Brains LP Farms — data + helper module (program constants, PDA derivations,
// on-chain fetchers, APR math). The rendered page lives in V2LpPools.tsx
// (route /lpfarms); this module only provides the named exports it consumes.

import { useState, useEffect } from 'react';
import { PublicKey, Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BRAINS_LOGO, XNT_LOGO } from '../constants';
import { getCachedTokenLogo } from '../lib/tokenLogos';

// ═════════════════════════════════════════════════════════════════════════════
// PROGRAM CONSTANTS — MIRROR brains_farm/src/constants.rs EXACTLY
// ═════════════════════════════════════════════════════════════════════════════

// TODO: Replace with actual deployed program id after first deploy
export const FARM_PROGRAM_ID = 'Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg';

const BRAINS_MINT  = 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN';
const LB_MINT      = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
const WXNT_MINT    = 'So11111111111111111111111111111111111111112';

// XDEX pool addresses keyed by LP mint — used to derive pool reserves for LP pricing.
// Pool holds its token vaults as ATAs where authority = pool pubkey itself.
const POOL_BY_LP: Record<string, { pool: string; other: string }> = {
  // BRAINS/XNT LP
  'FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3': {
    pool:  '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg',
    other: BRAINS_MINT,
  },
  // LB/XNT LP
  '85g2x1AcRyogMTDuWNWKJDPFQ3pTQdBpNWm2tK4YiXci': {
    pool:  'CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK',
    other: LB_MINT,
  },
};
export const TREASURY     = 'CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF';

// Pool addresses (from BRAINSFARMS.md) — used by seeding script to derive LP mint
const BRAINS_XNT_POOL = '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg';
const LB_XNT_POOL     = 'CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK';

const RPC       = 'https://rpc.mainnet.x1.xyz';
const XDEX_BASE = '/api/xdex-price/api';

// Lock config — three tiers, multipliers in bps
export const LOCK_TIERS = [
  { id: 'locked30',  label: '30 DAYS',   days: 30,  multBps: 20_000, multDisplay: '2×', color: '#00d4ff' },
  { id: 'locked90',  label: '90 DAYS',   days: 90,  multBps: 40_000, multDisplay: '4×', color: '#00c98d' },
  { id: 'locked365', label: '365 DAYS',  days: 365, multBps: 80_000, multDisplay: '8×', color: '#f29030' },
] as const;
export type LockId = typeof LOCK_TIERS[number]['id'];

const GRACE_SECS         = 3 * 86_400;
const CLAIM_COOLDOWN_SEC = 86_400;
export const STAKE_FEE_LAMPORTS = 5_000_000; // 0.005 XNT

// Penalty bps
// ─── LB tier ladder (matches on-chain accumulator.rs exactly) ─────────────────
// Four tiers + baseline. Penalty shrinks as LB holdings grow. Checked highest-
// first so users always get their best-qualifying tier.
const PENALTY_P1_STANDARD = 400;   // 4.000% — no LB
const PENALTY_P1_TIER1    = 188;   // 1.888% — ≥ 33 LB
const PENALTY_P1_TIER2    = 100;   // 1.000% — ≥ 330 LB
const PENALTY_P1_TIER3    =  50;   // 0.500% — ≥ 3,300 LB

const PENALTY_P2_STANDARD = 188;   // 1.888% — no LB
const PENALTY_P2_TIER1    =  88;   // 0.888% — ≥ 33 LB
const PENALTY_P2_TIER2    =  44;   // 0.444% — ≥ 330 LB
const PENALTY_P2_TIER3    =  22;   // 0.222% — ≥ 3,300 LB

// Raw units (2 decimals) — multiply displayed LB by 100 for raw
const LB_TIER1_THRESHOLD_RAW =   3_300;  // 33 LB
const LB_TIER2_THRESHOLD_RAW =  33_000;  // 330 LB
const LB_TIER3_THRESHOLD_RAW = 330_000;  // 3,300 LB

// UI-friendly thresholds
const LB_TIER1_THRESHOLD_UI =    33;
const LB_TIER2_THRESHOLD_UI =   330;
const LB_TIER3_THRESHOLD_UI = 3_300;

// Returns 0 (no tier / standard), 1, 2, or 3
function getLbTier(lbBalanceRaw: number | bigint): number {
  const bal = Number(lbBalanceRaw);
  if (bal >= LB_TIER3_THRESHOLD_RAW) return 3;
  if (bal >= LB_TIER2_THRESHOLD_RAW) return 2;
  if (bal >= LB_TIER1_THRESHOLD_RAW) return 1;
  return 0;
}

// Returns the penalty in bps for a given (period, tier) combo
function getPenaltyBps(period: 1 | 2, tier: number): number {
  if (period === 1) {
    if (tier === 3) return PENALTY_P1_TIER3;
    if (tier === 2) return PENALTY_P1_TIER2;
    if (tier === 1) return PENALTY_P1_TIER1;
    return PENALTY_P1_STANDARD;
  } else {
    if (tier === 3) return PENALTY_P2_TIER3;
    if (tier === 2) return PENALTY_P2_TIER2;
    if (tier === 1) return PENALTY_P2_TIER1;
    return PENALTY_P2_STANDARD;
  }
}

// Back-compat alias — keep for any external references, but prefer getLbTier
const LB_DISCOUNT_THRESHOLD = LB_TIER1_THRESHOLD_RAW;
export const ACC_PRECISION = BigInt('1000000000000000000'); // 1e18

// Helper: 10^n as a number, for converting raw token amounts to UI amounts
// based on a mint's decimals. Safe up to 15 decimals (JS Number precision).
export function pow10(n: number): number {
  return Math.pow(10, n);
}

// ═════════════════════════════════════════════════════════════════════════════
// TYPES
// ═════════════════════════════════════════════════════════════════════════════

export interface FarmOnChain {
  pubkey:                string;
  lpMint:                string;
  rewardMint:            string;
  rewardSymbol:          string;
  lpSymbol:              string;
  lpVault:               string;
  rewardVault:           string;
  rewardRatePerSec:      bigint;       // scaled by ACC_PRECISION
  accRewardPerShare:     bigint;
  lastUpdateTs:          number;
  totalStaked:           bigint;
  totalEffective:        bigint;
  totalPendingRewards:   bigint;
  totalEmitted:          bigint;
  startTs:               number;
  paused:                boolean;
  closed:                boolean;
  // Derived
  vaultBalance:          bigint;
  runwayDays:            number;
  rewardPriceUsd:        number;
  lpPriceUsd:            number;
  lpDecimals:            number;       // read from lp_mint at fetch time
  rewardDecimals:        number;       // read from reward_mint at fetch time
  otherTokenLogo?:       string;       // logo for the non-XNT side (BRAINS or LB)
  xntLogo?:              string;       // XNT logo
  otherTokenSymbol?:     string;       // "BRAINS" or "LB"
}

export interface PositionOnChain {
  pubkey:           string;
  owner:            string;
  farm:             string;
  nonce:            number;
  amount:           bigint;
  effectiveAmount:  bigint;
  lockType:         LockId;
  rewardDebt:       bigint;
  pendingRewards:   bigint;
  startTs:          number;
  graceEndTs:       number;
  unlockTs:         number;
  lockDuration:     number;
  lastClaimTs:      number;
  // Derived
  earnedNow:        bigint;
  daysRemaining:    number;
  penaltyBps:       number;
  penaltyAmount:    bigint;
  canClaim:         boolean;
  nextClaimInSec:   number;
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function useIsMobile() {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

function fmtUSD(v: number): string {
  if (!v) return '$0.00';
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v/1_000).toFixed(2)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function fmtNum(v: number, dec = 2): string {
  if (!v) return '0';
  if (v >= 1_000_000) return `${(v/1_000_000).toFixed(dec)}M`;
  if (v >= 1_000) return `${(v/1_000).toFixed(dec)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: dec });
}

function fmtDuration(secs: number): string {
  if (secs <= 0) return 'matured';
  const days  = Math.floor(secs / 86_400);
  const hours = Math.floor((secs % 86_400) / 3_600);
  if (days > 0)  return `${days}d ${hours}h`;
  const mins = Math.floor(secs / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m`;
}

function truncAddr(a: string): string { return `${a.slice(0,4)}…${a.slice(-4)}`; }

// Anchor discriminator: first 8 bytes of sha256("global:<ix_name>")
export async function disc(name: string): Promise<Buffer> {
  const msg = new TextEncoder().encode(`global:${name}`);
  const h = await window.crypto.subtle.digest('SHA-256', msg);
  return Buffer.from(new Uint8Array(h).slice(0, 8));
}

// ─── PDA derivations — match program seeds exactly ────────────────────────────
export function deriveFarmGlobal(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('farm_global')],
    new PublicKey(FARM_PROGRAM_ID),
  );
}

function deriveFarm(lpMint: PublicKey, rewardMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('farm'), lpMint.toBuffer(), rewardMint.toBuffer()],
    new PublicKey(FARM_PROGRAM_ID),
  );
}

function deriveLpVault(farm: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('lp_vault'), farm.toBuffer()],
    new PublicKey(FARM_PROGRAM_ID),
  );
}

function deriveRewardVault(farm: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reward_vault'), farm.toBuffer()],
    new PublicKey(FARM_PROGRAM_ID),
  );
}

export function derivePosition(owner: PublicKey, farm: PublicKey, nonce: number): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(4);
  nonceBuf.writeUInt32LE(nonce, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), owner.toBuffer(), farm.toBuffer(), nonceBuf],
    new PublicKey(FARM_PROGRAM_ID),
  );
}

// ─── Token program detection ──────────────────────────────────────────────────
export async function getTokenProgram(mint: PublicKey, connection: Connection): Promise<PublicKey> {
  try {
    const info = await connection.getAccountInfo(mint);
    if (info?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  } catch {}
  return TOKEN_PROGRAM_ID;
}

// ─── XDEX price ───────────────────────────────────────────────────────────────
async function fetchPrice(mint: string): Promise<number> {
  try {
    const r = await fetch(
      `${XDEX_BASE}/token-price/price?network=X1%20Mainnet&token_address=${mint}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    const j = await r.json();
    return Number(j?.data?.price) || 0;
  } catch { return 0; }
}

// ─── LP price via pool reserves ───────────────────────────────────────────────
// Mirrors the production pattern from PoolsTab.tsx.
// XDEX pool account layout:
//   D=8 (discriminator skip)
//   D+64:  token0Vault
//   D+96:  token1Vault
//   D+128: lpMint
//   D+160: token0Mint
//   D+192: token1Mint
//   D+330: lpDecimals
//   D+331: dec0
//   D+332: dec1
//   D+333: lpSupply (u64 LE)
//
// For pools containing BRAINS, XDEX's BRAINS price feed can be stale, so we
// derive BRAINS price from the vault ratio using the XNT side as the anchor.

// Read a u64 LE from a byte array — works on Buffer and Uint8Array alike.
function readU64(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true);
}

async function fetchLpPrice(
  lpMint: string,
  connection: Connection,
): Promise<number> {
  const meta = POOL_BY_LP[lpMint];
  if (!meta) return 0;
  try {
    const poolInfo = await connection.getAccountInfo(new PublicKey(meta.pool));
    if (!poolInfo || poolInfo.data.length < 350) {
      return 0;
    }

    const d = new Uint8Array(poolInfo.data);
    const D = 8;
    const token0Vault = new PublicKey(d.slice(D + 64,  D + 96)).toBase58();
    const token1Vault = new PublicKey(d.slice(D + 96,  D + 128)).toBase58();
    const token0Mint  = new PublicKey(d.slice(D + 160, D + 192)).toBase58();
    const token1Mint  = new PublicKey(d.slice(D + 192, D + 224)).toBase58();
    let   dec0        = d[D + 331];
    let   dec1        = d[D + 332];

    // LP decimals AND supply: pool state lpSupply drifts from the mint's real
    // supply (XDEX only tracks pool-created LP). Always read from the mint.
    // SPL Mint layout: supply at bytes 36-44 (u64 LE), decimals at byte 44.
    let lpDecimals = 9;
    let lpSupplyRaw = 0n;
    try {
      const lpMintInfo = await connection.getAccountInfo(new PublicKey(lpMint));
      if (lpMintInfo && lpMintInfo.data.length >= 45) {
        const mintBytes = new Uint8Array(lpMintInfo.data);
        lpSupplyRaw = readU64(mintBytes, 36);
        const fromMint = mintBytes[44];
        if (fromMint > 0 && fromMint <= 18) lpDecimals = fromMint;
      }
    } catch {}
    if (lpSupplyRaw === 0n) return 0;

    // Pool state byte for decimals is sometimes 0 — fall back to mint account
    if (dec0 === 0 || dec1 === 0) {
      const [m0, m1] = await Promise.all([
        connection.getAccountInfo(new PublicKey(token0Mint)),
        connection.getAccountInfo(new PublicKey(token1Mint)),
      ]);
      if (m0 && m0.data.length >= 45 && dec0 === 0) dec0 = new Uint8Array(m0.data)[44];
      if (m1 && m1.data.length >= 45 && dec1 === 0) dec1 = new Uint8Array(m1.data)[44];
    }
    if (dec0 === 0) dec0 = 9;
    if (dec1 === 0) dec1 = 9;

    // Fetch vault balances (SPL TokenAccount: amount at offset 64 as u64 LE)
    const [v0Info, v1Info] = await Promise.all([
      connection.getAccountInfo(new PublicKey(token0Vault)),
      connection.getAccountInfo(new PublicKey(token1Vault)),
    ]);
    if (!v0Info || !v1Info || v0Info.data.length < 72 || v1Info.data.length < 72) return 0;
    const v0Raw = readU64(new Uint8Array(v0Info.data), 64);
    const v1Raw = readU64(new Uint8Array(v1Info.data), 64);
    const v0Ui = Number(v0Raw) / pow10(dec0);
    const v1Ui = Number(v1Raw) / pow10(dec1);
    if (v0Ui === 0 || v1Ui === 0) return 0;

    // Derive TVL using whichever side has a reliable price feed.
    // BRAINS price on Prism is known to be stale — derive from ratio if BRAINS is a side.
    const brainsIsToken0 = token0Mint === BRAINS_MINT;
    const brainsIsToken1 = token1Mint === BRAINS_MINT;
    const brainsIsSide   = brainsIsToken0 || brainsIsToken1;

    let tvlUsd = 0;
    if (brainsIsSide) {
      const nonBrainsMint = brainsIsToken0 ? token1Mint : token0Mint;
      const refPrice = await fetchPrice(nonBrainsMint);
      if (refPrice > 0) {
        const refSideUsd = brainsIsToken0 ? refPrice * v1Ui : refPrice * v0Ui;
        tvlUsd = refSideUsd * 2;
      }
    } else {
      const [p0, p1] = await Promise.all([
        fetchPrice(token0Mint),
        fetchPrice(token1Mint),
      ]);
      if (p0 > 0 && p1 > 0) tvlUsd = p0 * v0Ui + p1 * v1Ui;
      else if (p0 > 0)      tvlUsd = p0 * v0Ui * 2;
      else if (p1 > 0)      tvlUsd = p1 * v1Ui * 2;
    }
    if (tvlUsd === 0) return 0;

    const lpSupplyUi = Number(lpSupplyRaw) / pow10(lpDecimals);
    if (lpSupplyUi === 0) return 0;

    const lpPrice = tvlUsd / lpSupplyUi;
    return lpPrice;
  } catch (e) {
    return 0;
  }
}

// ─── Farms cache ──────────────────────────────────────────────────────────
// Stale-while-revalidate: any visit returns the last known farms instantly
// (from in-memory or localStorage) and triggers a background refresh.
// FarmOnChain has bigints which JSON.stringify can't roundtrip, so we
// serialize them as strings and rehydrate on load.
const FARMS_MEM_TTL_MS = 60_000;
const FARMS_STALE_MS   = 15 * 60_000;
const FARMS_HARD_MS    = 24 * 60 * 60_000;
const FARMS_LS_KEY     = 'v2_farms_cache_v1';

let _farmsCache: { ts: number; data: FarmOnChain[] } | null = null;
let _farmsInflight: Promise<FarmOnChain[]> | null = null;

function _serializeFarms(farms: FarmOnChain[]): string {
  return JSON.stringify(farms, (_k, v) => typeof v === 'bigint' ? `__bi:${v.toString()}` : v);
}
function _deserializeFarms(json: string): FarmOnChain[] {
  return JSON.parse(json, (_k, v) =>
    typeof v === 'string' && v.startsWith('__bi:') ? BigInt(v.slice(5)) : v,
  );
}

// Seed memory from LS at module init.
(function _seedFarms() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FARMS_LS_KEY) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw) as { ts: number; data: string };
    if (parsed?.ts && Date.now() - parsed.ts < FARMS_HARD_MS && parsed.data) {
      _farmsCache = { ts: parsed.ts, data: _deserializeFarms(parsed.data) };
    }
  } catch {}
})();

async function _doFetchFarms(connection: Connection): Promise<FarmOnChain[]> {
  const programPk = new PublicKey(FARM_PROGRAM_ID);
  const accounts = await connection.getProgramAccounts(programPk, {
    filters: [{ dataSize: 229 }],
  });
  const data = await _parseFarms(accounts, connection);
  _farmsCache = { ts: Date.now(), data };
  try {
    localStorage.setItem(FARMS_LS_KEY, JSON.stringify({
      ts: _farmsCache.ts, data: _serializeFarms(data),
    }));
  } catch {}
  return data;
}

// ─── Fetch all farms from on-chain ────────────────────────────────────────────
export async function fetchFarms(connection: Connection): Promise<FarmOnChain[]> {
  // Fresh hit
  if (_farmsCache && Date.now() - _farmsCache.ts < FARMS_MEM_TTL_MS) {
    return _farmsCache.data;
  }
  // Stale hit — return immediately, refresh in background
  if (_farmsCache && Date.now() - _farmsCache.ts < FARMS_STALE_MS) {
    if (!_farmsInflight) {
      _farmsInflight = _doFetchFarms(connection)
        .catch(() => _farmsCache?.data ?? [])
        .finally(() => { _farmsInflight = null; });
    }
    return _farmsCache.data;
  }
  // Cold
  if (_farmsInflight) return _farmsInflight;
  _farmsInflight = _doFetchFarms(connection)
    .catch(() => _farmsCache?.data ?? [])
    .finally(() => { _farmsInflight = null; });
  return _farmsInflight;
}

// Original fetchFarms body — split out so the cache wrapper above can call it.
async function _parseFarms(
  accounts: { pubkey: any; account: any }[],
  connection: Connection,
): Promise<FarmOnChain[]> {
  try {

    const results: FarmOnChain[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        const d = account.data;
        let o = 8;
        const lpMint        = new PublicKey(d.slice(o, o + 32)).toBase58(); o += 32;
        const rewardMint    = new PublicKey(d.slice(o, o + 32)).toBase58(); o += 32;
        const lpVault       = new PublicKey(d.slice(o, o + 32)).toBase58(); o += 32;
        const rewardVault   = new PublicKey(d.slice(o, o + 32)).toBase58(); o += 32;
        const rewardRate    = d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n); o += 16;
        const accRewPerShr  = d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n); o += 16;
        const lastUpdateTs  = Number(d.readBigInt64LE(o)); o += 8;
        const totalStaked   = d.readBigUInt64LE(o); o += 8;
        const totalEffect   = d.readBigUInt64LE(o); o += 8;
        const totalPending  = d.readBigUInt64LE(o); o += 8;
        const totalEmitted  = d.readBigUInt64LE(o); o += 8;
        const startTs       = Number(d.readBigInt64LE(o)); o += 8;
        o += 8; // created_at
        const paused        = d[o] === 1; o += 1;
        const closed        = d[o] === 1;

        if (closed) continue;

        // Read reward vault balance
        const vaultInfo = await connection.getAccountInfo(new PublicKey(rewardVault));
        const vaultBalance = vaultInfo ? (vaultInfo.data as Buffer).readBigUInt64LE(64) : 0n;

        // Symbol lookup
        const symbolMap: Record<string, string> = {
          [BRAINS_MINT]: 'BRAINS',
          [LB_MINT]:     'LB',
          [WXNT_MINT]:   'XNT',
        };
        const rewardSymbol = symbolMap[rewardMint] ?? rewardMint.slice(0,6);
        const lpSymbol = rewardMint === BRAINS_MINT ? 'BRAINS/XNT LP'
                       : rewardMint === LB_MINT     ? 'LB/XNT LP'
                       : 'LP';

        // Runway: vaultBalance (raw) / (rate/ACC_PRECISION) = seconds
        // rate is scaled, so: raw_rate_per_sec = rate / ACC_PRECISION
        // runway_secs = vaultBalance * ACC_PRECISION / rate
        const runwaySecs = rewardRate > 0n
          ? Number((vaultBalance * ACC_PRECISION) / rewardRate)
          : 0;
        const runwayDays = Math.floor(runwaySecs / 86_400);

        // Prices — reward from Prism feed, LP computed from pool reserves
        const rewardPriceUsd = await fetchPrice(rewardMint);
        const lpPriceUsd     = await fetchLpPrice(lpMint, connection);

        // Decimals — read from the mint accounts directly.
        // SPL Mint layout: decimals is byte 44 for both Token and Token-2022.
        // Defaults kept for defensive fallback.
        let lpDecimals = 9;
        let rewardDecimals = 9;
        try {
          const [lpMintInfo, rewardMintInfo] = await Promise.all([
            connection.getAccountInfo(new PublicKey(lpMint)),
            connection.getAccountInfo(new PublicKey(rewardMint)),
          ]);
          if (lpMintInfo && lpMintInfo.data.length >= 45) {
            lpDecimals = lpMintInfo.data[44];
          }
          if (rewardMintInfo && rewardMintInfo.data.length >= 45) {
            rewardDecimals = rewardMintInfo.data[44];
          }
        } catch (e) {
          console.warn('Failed to read mint decimals, using defaults:', e);
        }

        // Logos — XNT + BRAINS are hardcoded from constants so they always
        // appear instantly. Anything else (LB, other ecosystem tokens) falls
        // through to the shared cache (BrainsIndexer-warmed) then a live
        // Token-2022 metadata fetch as a last resort.
        let otherTokenLogo: string | undefined;
        if (rewardMint === BRAINS_MINT) {
          otherTokenLogo = BRAINS_LOGO;
        } else {
          otherTokenLogo = getCachedTokenLogo(rewardMint) ?? undefined;
          if (!otherTokenLogo) {
            try {
              const lg = await fetchTokenLogo(rewardMint, connection);
              if (lg) otherTokenLogo = lg;
            } catch {}
          }
        }
        const otherTokenSymbol = rewardSymbol;
        const xntLogo: string = XNT_LOGO;

        results.push({
          pubkey: pubkey.toBase58(),
          lpMint, rewardMint, rewardSymbol, lpSymbol, lpVault, rewardVault,
          rewardRatePerSec: rewardRate,
          accRewardPerShare: accRewPerShr,
          lastUpdateTs,
          totalStaked, totalEffective: totalEffect,
          totalPendingRewards: totalPending,
          totalEmitted,
          startTs,
          paused, closed,
          vaultBalance, runwayDays,
          rewardPriceUsd, lpPriceUsd,
          lpDecimals, rewardDecimals,
          otherTokenLogo, xntLogo, otherTokenSymbol,
        });
      } catch { continue; }
    }
    return results;
  } catch (e) {
    console.error('fetchFarms error:', e);
    return [];
  }
}

// ─── Fetch user positions for a farm ──────────────────────────────────────────
export async function fetchPositions(
  connection: Connection, owner: PublicKey, farm: FarmOnChain,
): Promise<PositionOnChain[]> {
  try {
    const programPk = new PublicKey(FARM_PROGRAM_ID);
    // Position account size = 158
    const accounts = await connection.getProgramAccounts(programPk, {
      filters: [
        { dataSize: 158 },
        { memcmp: { offset: 8, bytes: owner.toBase58() } },
        { memcmp: { offset: 8 + 32, bytes: farm.pubkey } },
      ],
    });

    const now = Math.floor(Date.now() / 1000);
    const results: PositionOnChain[] = [];

    for (const { pubkey, account } of accounts) {
      try {
        const d = account.data;
        let o = 8;
        const ownerPk        = new PublicKey(d.slice(o, o + 32)).toBase58(); o += 32;
        const farmPk         = new PublicKey(d.slice(o, o + 32)).toBase58(); o += 32;
        const nonce          = d.readUInt32LE(o); o += 4;
        const amount         = d.readBigUInt64LE(o); o += 8;
        const effectiveAmt   = d.readBigUInt64LE(o); o += 8;
        const lockTypeByte   = d[o]; o += 1;
        const rewardDebt     = d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n); o += 16;
        const pendingRew     = d.readBigUInt64LE(o); o += 8;
        const startTs        = Number(d.readBigInt64LE(o)); o += 8;
        const graceEndTs     = Number(d.readBigInt64LE(o)); o += 8;
        const unlockTs       = Number(d.readBigInt64LE(o)); o += 8;
        const lockDuration   = Number(d.readBigInt64LE(o)); o += 8;
        const lastClaimTs    = Number(d.readBigInt64LE(o));

        const lockType: LockId = lockTypeByte === 0 ? 'locked30'
                               : lockTypeByte === 1 ? 'locked90'
                               : 'locked365';

        // Compute earned now using accumulator math client-side for live display
        // earned_now = pending_rewards + effective × (acc_now - reward_debt) / ACC_PRECISION
        // where acc_now is farm.accRewardPerShare advanced from lastUpdateTs to now
        let accNow = farm.accRewardPerShare;
        if (farm.totalEffective > 0n && farm.rewardRatePerSec > 0n) {
          const timeElapsed = BigInt(Math.max(0, now - farm.lastUpdateTs));
          const potential = timeElapsed * farm.rewardRatePerSec; // scaled
          const potentialRaw = potential / ACC_PRECISION;
          const available = farm.vaultBalance > farm.totalPendingRewards
            ? farm.vaultBalance - farm.totalPendingRewards
            : 0n;
          const actualRaw = potentialRaw > available ? available : potentialRaw;
          const actualScaled = actualRaw * ACC_PRECISION;
          accNow = accNow + (actualScaled / farm.totalEffective);
        }
        const delta = accNow > rewardDebt ? accNow - rewardDebt : 0n;
        const accrued = (effectiveAmt * delta) / ACC_PRECISION;
        const earnedNow = pendingRew + accrued;

        const daysRemaining = Math.max(0, Math.floor((unlockTs - now) / 86_400));

        // Penalty calc
        let penaltyBps = 0;
        if (now > graceEndTs && now < unlockTs) {
          const midpoint = startTs + lockDuration / 2;
          // (LB balance check happens at unstake time; UI shows worst-case)
          penaltyBps = now < midpoint ? PENALTY_P1_STANDARD : PENALTY_P2_STANDARD;
        }
        const penaltyAmount = (amount * BigInt(penaltyBps)) / 10_000n;

        const nextClaimAt = lastClaimTs + CLAIM_COOLDOWN_SEC;
        // Match on-chain claim.rs gates exactly:
        //   require!(now > grace_end_ts)            ← grace block
        //   require!(now >= last_claim_ts + 86400)  ← cooldown
        const pastGrace = now > graceEndTs;
        const pastCooldown = now >= nextClaimAt;
        const canClaim = pastGrace && pastCooldown && earnedNow > 0n;
        const nextClaimInSec = Math.max(0, nextClaimAt - now);

        results.push({
          pubkey: pubkey.toBase58(),
          owner: ownerPk, farm: farmPk, nonce,
          amount, effectiveAmount: effectiveAmt, lockType,
          rewardDebt, pendingRewards: pendingRew,
          startTs, graceEndTs, unlockTs, lockDuration, lastClaimTs,
          earnedNow, daysRemaining, penaltyBps, penaltyAmount,
          canClaim, nextClaimInSec,
        });
      } catch { continue; }
    }
    return results.sort((a, b) => a.startTs - b.startTs);
  } catch (e) {
    console.error('fetchPositions error:', e);
    return [];
  }
}

// ─── Network-wide stats (all stakers, not just `owner`) ──────────────────────
// Counts unique staker wallets across every farm by scanning Position accounts.
// Uses dataSlice to only fetch the 32-byte owner field per account — keeps RPC
// bandwidth flat regardless of how many positions exist.
export async function fetchTotalStakers(
  connection: Connection,
): Promise<{ uniqueStakers: number; totalPositions: number }> {
  try {
    const programPk = new PublicKey(FARM_PROGRAM_ID);
    const accounts = await connection.getProgramAccounts(programPk, {
      filters: [{ dataSize: 158 }],
      dataSlice: { offset: 8, length: 32 },
    });
    const owners = new Set<string>();
    for (const { account } of accounts) {
      owners.add(new PublicKey(account.data).toBase58());
    }
    return { uniqueStakers: owners.size, totalPositions: accounts.length };
  } catch (e) {
    console.error('fetchTotalStakers error:', e);
    return { uniqueStakers: 0, totalPositions: 0 };
  }
}

// ─── APR calculation (live) ───────────────────────────────────────────────────
// Real APR = (rewards_per_year_usd / tvl_usd) × (tier_mult / avg_mult) × 100
//
// At zero TVL there's no "real" APR — we show a hypothetical at $1,000 TVL so
// the display is honest: "if you were the only staker with $1k, you'd earn X%."
// This number is ALWAYS SHOWN WITH A "PROJ" LABEL so users know it's indicative.
export function computeApr(
  farm: FarmOnChain,
  lockMultBps: number,
): number {
  if (farm.rewardRatePerSec === 0n || farm.rewardPriceUsd === 0) return 0;

  // Rewards/year in USD (same for both branches).
  const rateRawPerSec = Number(farm.rewardRatePerSec) / 1e18;
  const rewardPerYearRaw = rateRawPerSec * 365 * 86_400;
  // rewardPerYearRaw is in RAW reward units — divide by 10^rewardDecimals for UI units.
  const rewardPerYearUi = rewardPerYearRaw / pow10(farm.rewardDecimals);
  const rewardPerYearUsd = rewardPerYearUi * farm.rewardPriceUsd;

  // Zero-TVL fallback: show hypothetical APR at $1,000 TVL and apply the tier
  // multiplier so users can compare tiers before anyone has staked. This is a
  // pre-launch marketing number — real APR kicks in once total_effective > 0.
  if (farm.totalEffective === 0n || farm.lpPriceUsd === 0) {
    const HYPO_TVL_USD = 1000;
    const BASELINE_MULT_BPS = 20_000;  // L30 (2×) = reference tier
    const tierBoost = lockMultBps / BASELINE_MULT_BPS;
    return (rewardPerYearUsd / HYPO_TVL_USD) * 100 * tierBoost;
  }

  // Real APR once TVL exists.
  const totalStakedUi = Number(farm.totalStaked) / pow10(farm.lpDecimals);
  const tvlUsd = totalStakedUi * farm.lpPriceUsd;
  if (tvlUsd === 0) return 0;

  const blendedApr = (rewardPerYearUsd / tvlUsd) * 100;
  const avgMultBps = Number(farm.totalEffective) * 10_000 / Number(farm.totalStaked);
  const tierShare = lockMultBps / avgMultBps;

  return blendedApr * tierShare;
}

// ─── Token logos ──────────────────────────────────────────────────────────────
// Simple fetch from Token-2022 on-chain metadata (URI → JSON → image).
// Cached in-memory so we don't re-fetch on every render.
const _logoCache = new Map<string, string | null>();

async function fetchTokenLogo(mint: string, connection: Connection): Promise<string | null> {
  if (_logoCache.has(mint)) return _logoCache.get(mint) || null;
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed = (info?.value?.data as any)?.parsed?.info;
    const exts = parsed?.extensions as any[] | undefined;
    const metaExt = exts?.find((e: any) => e.extension === 'tokenMetadata');
    const uri = metaExt?.state?.uri as string | undefined;
    if (!uri) { _logoCache.set(mint, null); return null; }
    const r = await fetch(uri, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const logo: string | undefined = j?.image || j?.logo || j?.icon;
    _logoCache.set(mint, logo || null);
    return logo || null;
  } catch {
    _logoCache.set(mint, null);
    return null;
  }
}
