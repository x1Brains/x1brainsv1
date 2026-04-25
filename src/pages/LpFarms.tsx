// src/pages/LpFarms.tsx
// Route: /lpfarms
// X1 Brains LP Farms — stake LP tokens, earn rewards by lock tier.
// Matches the visual language of PairingMarketplace / LabWorkDefi.

import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey, Transaction, TransactionInstruction, SystemProgram,
  LAMPORTS_PER_SOL, Connection,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { TopBar, PageBackground, Footer } from '../components/UI';
import { parseFarmError, UNKNOWN_ERROR_FALLBACK } from '../utils/parseError';
import { resolveClaimTooSoon, formatDuration as fmtFriendlyDuration, type FarmErrorInfo } from '../utils/brainsFarmErrors';

// ═════════════════════════════════════════════════════════════════════════════
// PROGRAM CONSTANTS — MIRROR brains_farm/src/constants.rs EXACTLY
// ═════════════════════════════════════════════════════════════════════════════

// TODO: Replace with actual deployed program id after first deploy
const FARM_PROGRAM_ID = 'Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg';

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
const TREASURY     = 'CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF';

// Pool addresses (from BRAINSFARMS.md) — used by seeding script to derive LP mint
const BRAINS_XNT_POOL = '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg';
const LB_XNT_POOL     = 'CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK';

const RPC       = 'https://rpc.mainnet.x1.xyz';
const XDEX_BASE = '/api/xdex-price/api';

// Lock config — three tiers, multipliers in bps
const LOCK_TIERS = [
  { id: 'locked30',  label: '30 DAYS',   days: 30,  multBps: 20_000, multDisplay: '2×', color: '#00d4ff' },
  { id: 'locked90',  label: '90 DAYS',   days: 90,  multBps: 40_000, multDisplay: '4×', color: '#00c98d' },
  { id: 'locked365', label: '365 DAYS',  days: 365, multBps: 80_000, multDisplay: '8×', color: '#ff8c00' },
] as const;
type LockId = typeof LOCK_TIERS[number]['id'];

const GRACE_SECS         = 3 * 86_400;
const CLAIM_COOLDOWN_SEC = 86_400;
const STAKE_FEE_LAMPORTS = 5_000_000; // 0.005 XNT

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
const ACC_PRECISION = BigInt('1000000000000000000'); // 1e18

// Helper: 10^n as a number, for converting raw token amounts to UI amounts
// based on a mint's decimals. Safe up to 15 decimals (JS Number precision).
function pow10(n: number): number {
  return Math.pow(10, n);
}

// ═════════════════════════════════════════════════════════════════════════════
// TYPES
// ═════════════════════════════════════════════════════════════════════════════

interface FarmOnChain {
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

interface PositionOnChain {
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
async function disc(name: string): Promise<Buffer> {
  const msg = new TextEncoder().encode(`global:${name}`);
  const h = await window.crypto.subtle.digest('SHA-256', msg);
  return Buffer.from(new Uint8Array(h).slice(0, 8));
}

// ─── PDA derivations — match program seeds exactly ────────────────────────────
function deriveFarmGlobal(): [PublicKey, number] {
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

function derivePosition(owner: PublicKey, farm: PublicKey, nonce: number): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(4);
  nonceBuf.writeUInt32LE(nonce, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), owner.toBuffer(), farm.toBuffer(), nonceBuf],
    new PublicKey(FARM_PROGRAM_ID),
  );
}

// ─── Token program detection ──────────────────────────────────────────────────
async function getTokenProgram(mint: PublicKey, connection: Connection): Promise<PublicKey> {
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
      `${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${mint}`,
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

// ─── Fetch all farms from on-chain ────────────────────────────────────────────
async function fetchFarms(connection: Connection): Promise<FarmOnChain[]> {
  try {
    const programPk = new PublicKey(FARM_PROGRAM_ID);
    // Farm account size = 229 bytes
    const accounts = await connection.getProgramAccounts(programPk, {
      filters: [{ dataSize: 229 }],
    });

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

        // Logos — fetch reward token's logo from Token-2022 metadata.
        // XNT is the paired side in both current farms but has no logo yet,
        // so we pass undefined and let TokenLogo render the 'X' placeholder.
        let otherTokenLogo: string | undefined;
        try {
          const lg = await fetchTokenLogo(rewardMint, connection);
          if (lg) otherTokenLogo = lg;
        } catch {}
        const otherTokenSymbol = rewardSymbol;
        const xntLogo = undefined;

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
async function fetchPositions(
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

// ─── APR calculation (live) ───────────────────────────────────────────────────
// Real APR = (rewards_per_year_usd / tvl_usd) × (tier_mult / avg_mult) × 100
//
// At zero TVL there's no "real" APR — we show a hypothetical at $1,000 TVL so
// the display is honest: "if you were the only staker with $1k, you'd earn X%."
// This number is ALWAYS SHOWN WITH A "PROJ" LABEL so users know it's indicative.
function computeApr(
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

// ═════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═════════════════════════════════════════════════════════════════════════════

const CopyButton: FC<{ text: string; size?: number }> = ({ text, size = 11 }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={e => {
      e.stopPropagation();
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 1_500);
      });
    }} style={{
      background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px',
      color: copied ? '#00c98d' : '#3a5a6a', fontSize: size, lineHeight: 1,
      borderRadius: 4, flexShrink: 0, transition: 'color .15s',
    }}>{copied ? '✓' : '⎘'}</button>
  );
};

const StatusBox: FC<{ msg: string }> = ({ msg }) => {
  if (!msg) return null;
  const isErr = msg.startsWith('❌');
  const isOk  = msg.startsWith('✅');
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 10, marginBottom: 16,
      background: isErr ? 'rgba(255,68,68,.08)' : isOk ? 'rgba(0,201,141,.08)' : 'rgba(0,212,255,.06)',
      border: `1px solid ${isErr ? 'rgba(255,68,68,.25)' : isOk ? 'rgba(0,201,141,.25)' : 'rgba(0,212,255,.15)'}`,
      fontFamily: 'Sora,sans-serif', fontSize: 12,
      color: isErr ? '#ff6666' : isOk ? '#00c98d' : '#9abacf', lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
    }}>{msg}</div>
  );
};

const TxLink: FC<{ sig: string; color?: string }> = ({ sig, color = '#00d4ff' }) => {
  if (!sig) return null;
  return (
    <a href={`https://explorer.mainnet.x1.xyz/tx/${sig}`}
       target="_blank" rel="noopener noreferrer" style={{
      display: 'block', textAlign: 'center', padding: '10px 14px', marginBottom: 16,
      borderRadius: 10, background: 'rgba(0,212,255,.04)',
      border: `1px solid ${color}40`, textDecoration: 'none',
      fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700,
      color, letterSpacing: 1,
    }}>VIEW ON EXPLORER ↗</a>
  );
};

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

// XNT has no standard logo yet — let TokenLogo fall through to text-letter placeholder.

// TokenLogo component — img with graceful fallback to symbol-letter placeholder
const TokenLogo: FC<{
  src?: string; symbol: string; size?: number; offset?: number;
}> = ({ src, symbol, size = 20, offset = 0 }) => {
  const [failed, setFailed] = useState(false);
  const COLORS = ['#ff8c00', '#ffb700', '#00d4ff', '#00c98d', '#bf5af2'];
  const ci = (symbol?.charCodeAt(0) ?? 65) % COLORS.length;
  const ci2 = (ci + 2) % COLORS.length;
  const radius = size * 0.22;

  const style: React.CSSProperties = {
    width: size, height: size, borderRadius: radius,
    background: src && !failed ? '#111820'
      : `linear-gradient(135deg,${COLORS[ci]},${COLORS[ci2]})`,
    border: '1px solid rgba(255,255,255,.08)',
    objectFit: 'cover', flexShrink: 0,
    marginLeft: offset,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'Orbitron,monospace',
    fontSize: size * 0.42, fontWeight: 900,
    color: '#0a0e14',
  };

  if (src && !failed) {
    return (
      <img src={src} alt={symbol} crossOrigin="anonymous" style={style}
        onError={() => setFailed(true)} />
    );
  }
  return <div style={style}>{symbol?.slice(0, 1) || '?'}</div>;
};

// Paired logo — two overlapping token logos (BRAINS + XNT, etc.)
const PairLogo: FC<{
  logoA?: string; symbolA: string;   // native/primary token (BRAINS/LB) — shown on top
  logoB?: string; symbolB: string;   // paired token (XNT) — shown behind
  size?: number;
}> = ({ logoA, symbolA, logoB, symbolB, size = 22 }) => {
  const overlap = Math.floor(size * 0.35);
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0,
      position: 'relative' }}>
      <div style={{ position: 'relative', zIndex: 2 }}>
        <TokenLogo src={logoA} symbol={symbolA} size={size} />
      </div>
      <div style={{ position: 'relative', zIndex: 1, marginLeft: -overlap }}>
        <TokenLogo src={logoB} symbol={symbolB} size={size} />
      </div>
    </div>
  );
};


// Restrained educational section matching the LabWorkDefi aesthetic: small type,
// muted palette, data-dense tables. No heavy color emphasis, no large emoji.
const TokenomicsPanel: FC<{ isMobile: boolean }> = ({ isMobile }) => {
  const [open, setOpen] = useState(false);

  const SectionHeader: FC<{ label: string }> = ({ label }) => (
    <div style={{
      fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
      color: '#4a6a8a', letterSpacing: 1.5, marginTop: 18, marginBottom: 8,
      textTransform: 'uppercase',
    }}>{label}</div>
  );

  const tableTh: React.CSSProperties = {
    textAlign: 'left', padding: '6px 8px 6px 0', fontWeight: 600,
    fontSize: 8, color: '#4a6a8a', letterSpacing: .5,
    borderBottom: '1px solid rgba(255,255,255,.06)',
  };
  const tableTd: React.CSSProperties = {
    padding: '5px 8px 5px 0', fontSize: 9, color: '#9abacf',
    borderBottom: '1px solid rgba(255,255,255,.03)',
  };
  const tableTdRight: React.CSSProperties = { ...tableTd, textAlign: 'right', paddingRight: 0 };

  return (
    <div style={{
      marginBottom: isMobile ? 14 : 20,
      background: 'rgba(255,255,255,.015)',
      border: '1px solid rgba(255,255,255,.06)',
      borderRadius: 10, overflow: 'hidden',
    }}>
      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: isMobile ? '11px 14px' : '13px 18px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          textAlign: 'left',
        }}
      >
        <div>
          <div style={{
            fontFamily: 'Orbitron,monospace', fontSize: 10,
            fontWeight: 700, color: '#9abacf', letterSpacing: 1.5,
            textTransform: 'uppercase',
          }}>How it works</div>
          <div style={{
            fontFamily: 'Sora,sans-serif', fontSize: 9,
            color: '#3a5a6a', marginTop: 3,
          }}>APR amps · lock tiers · exit policy · LB discount ladder</div>
        </div>
        <div style={{
          fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700,
          color: '#4a6a8a', letterSpacing: 1,
        }}>{open ? '−' : '+'}</div>
      </button>

      {open && (
        <div style={{
          padding: isMobile ? '4px 14px 18px' : '4px 18px 20px',
          fontFamily: 'Sora,sans-serif', fontSize: 10,
          color: '#9abacf', lineHeight: 1.6,
          borderTop: '1px solid rgba(255,255,255,.04)',
        }}>
          {/* Overview */}
          <SectionHeader label="Overview" />
          <div>
            Perpetual LP farms. Stake BRAINS/XNT or LB/XNT LP tokens to earn BRAINS or LB
            rewards. Rewards emit at a fixed rate until the vault depletes. Longer locks
            receive a larger share of emissions.
          </div>

          {/* Lock tiers */}
          <SectionHeader label="Lock tiers · APR multipliers" />
          <table style={{ width: '100%', borderCollapse: 'collapse',
            fontFamily: 'Orbitron,monospace' }}>
            <thead>
              <tr>
                <th style={tableTh}>Lock duration</th>
                <th style={{...tableTh, textAlign: 'right'}}>Multiplier</th>
                <th style={{...tableTh, textAlign: 'right'}}>vs baseline</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={tableTd}>30 days</td>
                <td style={tableTdRight}>2×</td>
                <td style={tableTdRight}>baseline</td>
              </tr>
              <tr>
                <td style={tableTd}>90 days</td>
                <td style={tableTdRight}>4×</td>
                <td style={tableTdRight}>2× APR</td>
              </tr>
              <tr>
                <td style={{...tableTd, borderBottom: 'none'}}>365 days</td>
                <td style={{...tableTdRight, borderBottom: 'none'}}>8×</td>
                <td style={{...tableTdRight, borderBottom: 'none'}}>4× APR</td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 8, fontSize: 9, color: '#4a6a8a' }}>
            Effective stake = LP amount × multiplier. Your share of emissions equals your
            effective stake divided by total effective across all positions.
          </div>

          {/* Exit policy */}
          <SectionHeader label="Exit policy" />
          <div style={{ marginBottom: 6 }}>
            <span style={{ color: '#9abacf', fontWeight: 600 }}>Grace (days 1–3).</span>{' '}
            Full LP returned, accrued rewards forfeited to vault. Intended as an "undo"
            window for mistakes.
          </div>
          <div style={{ marginBottom: 6 }}>
            <span style={{ color: '#9abacf', fontWeight: 600 }}>Early (past grace, before unlock).</span>{' '}
            LP penalty applied (see ladder below), rewards forfeited.
          </div>
          <div>
            <span style={{ color: '#9abacf', fontWeight: 600 }}>Mature (at or past unlock).</span>{' '}
            Full LP returned, full accrued rewards paid out.
          </div>
          <div style={{ marginTop: 8, fontSize: 9, color: '#4a6a8a' }}>
            Forfeited rewards remain in the vault and become re-emittable, marginally
            increasing APR for remaining stakers.
          </div>

          {/* LB discount ladder */}
          <SectionHeader label="LB-holder penalty discount ladder" />
          <div style={{ marginBottom: 8, fontSize: 10, color: '#9abacf' }}>
            Holding LB tokens reduces early-exit penalty across two periods:
            P1 (first half of lock past grace) and P2 (second half).
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse',
            fontFamily: 'Orbitron,monospace' }}>
            <thead>
              <tr>
                <th style={tableTh}>Tier</th>
                <th style={tableTh}>LB held</th>
                <th style={{...tableTh, textAlign: 'right'}}>P1 penalty</th>
                <th style={{...tableTh, textAlign: 'right'}}>P2 penalty</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={tableTd}>—</td>
                <td style={tableTd}>&lt; 33</td>
                <td style={tableTdRight}>4.000%</td>
                <td style={tableTdRight}>1.888%</td>
              </tr>
              <tr>
                <td style={tableTd}>T1</td>
                <td style={tableTd}>≥ 33</td>
                <td style={tableTdRight}>1.888%</td>
                <td style={tableTdRight}>0.888%</td>
              </tr>
              <tr>
                <td style={tableTd}>T2</td>
                <td style={tableTd}>≥ 330</td>
                <td style={tableTdRight}>1.000%</td>
                <td style={tableTdRight}>0.444%</td>
              </tr>
              <tr>
                <td style={{...tableTd, borderBottom: 'none'}}>T3</td>
                <td style={{...tableTd, borderBottom: 'none'}}>≥ 3,300</td>
                <td style={{...tableTdRight, borderBottom: 'none'}}>0.500%</td>
                <td style={{...tableTdRight, borderBottom: 'none'}}>0.222%</td>
              </tr>
            </tbody>
          </table>
          <div style={{ marginTop: 8, fontSize: 9, color: '#4a6a8a' }}>
            Balance checked from the user's LB token account at exit. No action required.
          </div>

          {/* Claim */}
          <SectionHeader label="Claim cooldown" />
          <div>
            Positions past grace can claim accrued rewards while still staked.
            Claims have a 24-hour cooldown per position. Rewards continue accruing
            between claims.
          </div>

          {/* Runway */}
          <SectionHeader label="Reward runway" />
          <div>
            Each farm emits from a finite reward vault at a fixed rate until depletion.
            The runway metric shown on each farm card reflects days of emissions
            remaining at the current rate. Anyone may donate to a farm vault.
          </div>

          {/* Transparency */}
          <SectionHeader label="On-chain transparency" />
          <div>
            All state and math are on-chain. Admin controls are limited to pause
            (stake/claim blocked, unstake always works), rate updates, and withdrawal
            of un-earmarked surplus (never touches rewards owed to active stakers).
            Admin cannot seize staked LP or alter positions.
          </div>
          <div style={{ marginTop: 6, fontFamily: 'Orbitron,monospace',
            fontSize: 9, color: '#4a6a8a', wordBreak: 'break-all' }}>
            Program: Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg
          </div>

          <div style={{ marginTop: 16, paddingTop: 12,
            borderTop: '1px solid rgba(255,255,255,.04)',
            fontSize: 9, color: '#3a5a6a', fontStyle: 'italic' }}>
            Not financial advice. APRs are variable, locks are final, and smart contract
            risk applies. Do your own research.
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Farm Card ────────────────────────────────────────────────────────────────
const FarmCard: FC<{
  farm: FarmOnChain;
  isMobile: boolean;
  userPositions: PositionOnChain[];
  onStake: () => void;
  onFund: () => void;
}> = ({ farm, isMobile, userPositions, onStake, onFund }) => {
  const apr30  = computeApr(farm, 20_000);
  const apr90  = computeApr(farm, 40_000);
  const apr365 = computeApr(farm, 80_000);

  const tvlUsd = (Number(farm.totalStaked) / pow10(farm.lpDecimals)) * farm.lpPriceUsd;
  const vaultUsd = (Number(farm.vaultBalance) / pow10(farm.rewardDecimals)) * farm.rewardPriceUsd;
  const myStakeCount = userPositions.length;

  const isHot = farm.rewardMint === BRAINS_MINT ? '#ff8c00' : '#00c98d';

  return (
    <div style={{
      background: 'rgba(255,255,255,.015)',
      border: `1px solid ${isHot}22`,
      borderRadius: 12,
      padding: isMobile ? '14px 14px' : '16px 20px',
      marginBottom: 12,
      position: 'relative', overflow: 'hidden',
      animation: 'fadeUp 0.4s ease both',
      transition: 'border-color 0.2s',
    }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = `${isHot}55`; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = `${isHot}22`; }}>

      {/* Thin top accent */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1,
        background: `linear-gradient(90deg, transparent, ${isHot}66, transparent)` }} />

      {/* Status badges */}
      {(farm.paused || (farm.runwayDays <= 30 && farm.runwayDays > 0) ||
        (farm.runwayDays === 0 && farm.vaultBalance === 0n) || myStakeCount > 0) && (
        <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
          {farm.paused && (
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
              padding: '2px 7px', borderRadius: 4, color: '#ff8c00', letterSpacing: .5,
              background: 'rgba(255,140,0,.08)', border: '1px solid rgba(255,140,0,.25)' }}>
              PAUSED
            </span>
          )}
          {farm.runwayDays <= 30 && farm.runwayDays > 0 && (
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
              padding: '2px 7px', borderRadius: 4, color: '#ff6666', letterSpacing: .5,
              background: 'rgba(255,68,68,.08)', border: '1px solid rgba(255,68,68,.25)' }}>
              LOW RUNWAY
            </span>
          )}
          {farm.runwayDays === 0 && farm.vaultBalance === 0n && (
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
              padding: '2px 7px', borderRadius: 4, color: '#ff4444', letterSpacing: .5,
              background: 'rgba(255,68,68,.12)', border: '1px solid rgba(255,68,68,.35)' }}>
              DRAINED
            </span>
          )}
          {myStakeCount > 0 && (
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
              padding: '2px 7px', borderRadius: 4, color: '#00c98d', letterSpacing: .5,
              background: 'rgba(0,201,141,.08)', border: '1px solid rgba(0,201,141,.25)' }}>
              {myStakeCount} MY STAKE{myStakeCount > 1 ? 'S' : ''}
            </span>
          )}
        </div>
      )}

      {/* Header: pair logos + title + reward vault */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14, gap: 12, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <PairLogo
            logoA={farm.otherTokenLogo} symbolA={farm.otherTokenSymbol || farm.rewardSymbol}
            logoB={farm.xntLogo} symbolB="XNT"
            size={isMobile ? 32 : 36}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 16,
              fontWeight: 900, color: '#e0f0ff', letterSpacing: .5, lineHeight: 1.2,
              whiteSpace: 'nowrap' }}>
              {farm.lpSymbol} <span style={{ color: isHot, opacity: .8 }}>→</span> {farm.rewardSymbol}
            </div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#6a90a8',
              display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
              Stake {farm.lpSymbol}, earn {farm.rewardSymbol}
              <CopyButton text={farm.pubkey} />
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#4a6a8a',
            letterSpacing: 1, textTransform: 'uppercase' }}>
            Reward vault
          </div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700,
            color: isHot, marginTop: 2 }}>
            {fmtNum(Number(farm.vaultBalance) / pow10(farm.rewardDecimals))} {farm.rewardSymbol}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#9abacf' }}>
            {fmtUSD(vaultUsd)}
          </div>
        </div>
      </div>

      {/* APR grid — 3 tiers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 12 }}>
        {LOCK_TIERS.map((tier, i) => {
          const apr = [apr30, apr90, apr365][i];
          return (
            <div key={tier.id}
              title={
                'Current realized APR — calculated from the live emission rate, current TVL, ' +
                "and the average lock multiplier across all stakers. Your personal APR depends " +
                'on the TVL and tier mix at the moment you stake. On a small farm, a large new ' +
                'stake will lower the displayed number for everyone (including you). ' +
                'The ratio updates live as positions are opened and closed.'
              }
              style={{
              background: `${tier.color}06`,
              border: `1px solid ${tier.color}22`,
              borderRadius: 7, padding: '9px 8px', textAlign: 'center',
              cursor: 'help',
            }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7,
                letterSpacing: 1, color: tier.color, marginBottom: 3, fontWeight: 700 }}>
                {tier.label}
              </div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 13 : 15,
                fontWeight: 900, color: tier.color, lineHeight: 1 }}>
                {apr > 0 ? `${apr < 10_000 ? apr.toFixed(1) : fmtNum(apr, 0)}%` : '—'}
              </div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#4a6a8a', marginTop: 3,
                letterSpacing: .5 }}>
                APR · {tier.multDisplay} ⓘ
              </div>
            </div>
          );
        })}
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)',
        gap: 6, marginBottom: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.04)' }}>
        {[
          { label: 'TVL',     value: fmtUSD(tvlUsd),                                                             color: '#e0f0ff' },
          { label: 'STAKED',  value: fmtNum(Number(farm.totalStaked)/pow10(farm.lpDecimals)),                    color: '#9abacf' },
          { label: 'RUNWAY',  value: farm.runwayDays > 0 ? `${fmtNum(farm.runwayDays, 0)}d` : '—',              color: farm.runwayDays <= 30 ? '#ff8c00' : '#9abacf' },
          { label: 'EMITTED', value: fmtNum(Number(farm.totalEmitted)/pow10(farm.rewardDecimals)),               color: '#9abacf' },
        ].map(stat => (
          <div key={stat.label}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1,
              color: '#4a6a8a', marginBottom: 2, textTransform: 'uppercase' }}>{stat.label}</div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700,
              color: stat.color }}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onStake} disabled={farm.paused || farm.closed}
          style={{ flex: 2, padding: '10px 14px', borderRadius: 8,
            cursor: farm.paused || farm.closed ? 'not-allowed' : 'pointer',
            background: farm.paused || farm.closed
              ? 'rgba(255,255,255,.02)'
              : `${isHot}15`,
            border: `1px solid ${farm.paused || farm.closed ? 'rgba(255,255,255,.06)' : `${isHot}44`}`,
            fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700,
            color: farm.paused || farm.closed ? '#4a6a8a' : isHot, letterSpacing: 1.2,
            transition: 'all .15s' }}>
          Stake LP
        </button>
        <button onClick={onFund}
          style={{ flex: 1, padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
            background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.08)',
            fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700,
            color: '#9abacf', letterSpacing: 1.2, transition: 'all .15s' }}>
          Donate
        </button>
      </div>
    </div>
  );
};

// ─── Position Card ────────────────────────────────────────────────────────────
const PositionCard: FC<{
  position: PositionOnChain;
  farm: FarmOnChain;
  isMobile: boolean;
  onClaim: () => void;
  onUnstake: () => void;
}> = ({ position, farm, isMobile, onClaim, onUnstake }) => {
  const tier = LOCK_TIERS.find(t => t.id === position.lockType)!;
  const now = Math.floor(Date.now() / 1000);
  const isMatured    = now >= position.unlockTs;
  const isInGrace    = now <= position.graceEndTs;
  const daysToUnlock = Math.max(0, Math.floor((position.unlockTs - now) / 86_400));
  const hoursToClaim = Math.floor(position.nextClaimInSec / 3_600);
  const minsToClaim  = Math.floor((position.nextClaimInSec % 3_600) / 60);

  const amountUi  = Number(position.amount) / pow10(farm.lpDecimals);
  const amountUsd = amountUi * farm.lpPriceUsd;
  const earnedUi  = Number(position.earnedNow) / pow10(farm.rewardDecimals);
  const earnedUsd = earnedUi * farm.rewardPriceUsd;

  const statusBadge = isMatured
    ? { label: '✓ MATURED',       color: '#00c98d' }
    : isInGrace
    ? { label: '🛡️ GRACE',        color: '#00d4ff' }
    : { label: `🔒 ${daysToUnlock}d LEFT`, color: tier.color };

  return (
    <div style={{
      background: '#0d1520',
      border: `1px solid ${tier.color}22`,
      borderRadius: 12, padding: isMobile ? '14px' : '18px 22px',
      marginBottom: 10, position: 'relative', overflow: 'hidden',
      animation: 'fadeUp 0.35s ease both',
    }}>
      {/* Left accent bar */}
      <div style={{ position: 'absolute', left: 0, top: '15%', bottom: '15%', width: 3,
        borderRadius: 2, background: tier.color, boxShadow: `0 0 8px ${tier.color}55` }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 900, color: '#e0f0ff' }}>
            {tier.label} · {tier.multDisplay}
          </span>
          <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
            padding: '3px 8px', borderRadius: 5,
            color: statusBadge.color,
            background: `${statusBadge.color}15`,
            border: `1px solid ${statusBadge.color}33` }}>
            {statusBadge.label}
          </span>
        </div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#708090' }}>
          #{position.nonce}
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)',
        gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#8899aa',
            letterSpacing: 1, marginBottom: 2 }}>STAKED</div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 700, color: '#e0f0ff' }}>
            {fmtNum(amountUi, 3)} LP
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#c0d0e0' }}>
            {fmtUSD(amountUsd)}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#8899aa',
            letterSpacing: 1, marginBottom: 2 }}>EARNED</div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 700, color: '#00c98d' }}>
            {fmtNum(earnedUi, 4)} {farm.rewardSymbol}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#c0d0e0' }}>
            {fmtUSD(earnedUsd)}
          </div>
        </div>
        {!isMobile && (
          <div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#8899aa',
              letterSpacing: 1, marginBottom: 2 }}>MATURES</div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 700,
              color: isMatured ? '#00c98d' : '#9abacf' }}>
              {isMatured ? 'READY' : fmtDuration(position.unlockTs - now)}
            </div>
          </div>
        )}
      </div>

      {/* Penalty warning if early */}
      {!isMatured && !isInGrace && (
        <div style={{ padding: '8px 12px', borderRadius: 7, marginBottom: 12,
          background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
          fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#9abacf', lineHeight: 1.5 }}>
          Early exit: {(position.penaltyBps / 100).toFixed(3)}% LP penalty · rewards forfeited.
          <br/>
          <span style={{ color: '#4a6a8a' }}>
            LB discount: T1 ≥33 → {(position.penaltyBps === PENALTY_P1_STANDARD ? PENALTY_P1_TIER1 : PENALTY_P2_TIER1)/100}%{' · '}
            T2 ≥330 → {(position.penaltyBps === PENALTY_P1_STANDARD ? PENALTY_P1_TIER2 : PENALTY_P2_TIER2)/100}%{' · '}
            T3 ≥3,300 → {(position.penaltyBps === PENALTY_P1_STANDARD ? PENALTY_P1_TIER3 : PENALTY_P2_TIER3)/100}%
          </span>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onClaim} disabled={!position.canClaim}
          style={{ flex: 1, padding: '10px 16px', borderRadius: 9,
            cursor: position.canClaim ? 'pointer' : 'not-allowed',
            background: position.canClaim ? 'rgba(0,201,141,.12)' : 'rgba(255,255,255,.03)',
            border: `1px solid ${position.canClaim ? 'rgba(0,201,141,.4)' : 'rgba(255,255,255,.08)'}`,
            fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 900,
            color: position.canClaim ? '#00c98d' : '#4a6a8a', letterSpacing: 1 }}
          title={
            isInGrace
              ? `3-day grace period — claim opens in ${fmtFriendlyDuration(position.graceEndTs - now + 1)}. Free exit window with no penalty.`
              : !position.canClaim
              ? `Claim every 24 hours. Next claim in ${fmtFriendlyDuration(position.nextClaimInSec)}.`
              : ''
          }>
          {position.canClaim
            ? '💰 CLAIM'
            : isInGrace
            ? `🛡️ GRACE · ${fmtFriendlyDuration(position.graceEndTs - now + 1)}`
            : `⏱ CLAIM IN ${hoursToClaim}h ${minsToClaim}m`}
        </button>
        <button onClick={onUnstake}
          style={{ flex: 1, padding: '10px 16px', borderRadius: 9, cursor: 'pointer',
            background: isMatured
              ? 'linear-gradient(135deg,rgba(0,201,141,.18),rgba(0,201,141,.06))'
              : 'rgba(255,68,68,.06)',
            border: `1px solid ${isMatured ? 'rgba(0,201,141,.45)' : 'rgba(255,68,68,.25)'}`,
            fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 900,
            color: isMatured ? '#00c98d' : '#ff6666', letterSpacing: 1 }}>
          {isMatured ? '✓ UNSTAKE' : '⚠ EARLY EXIT'}
        </button>
      </div>
    </div>
  );
};

// ─── Stake Modal ──────────────────────────────────────────────────────────────
const StakeModal: FC<{
  farm: FarmOnChain;
  isMobile: boolean;
  publicKey: PublicKey;
  connection: Connection;
  signTransaction: any;
  onClose: () => void;
  onStaked: () => void;
}> = ({ farm, isMobile, publicKey, connection, signTransaction, onClose, onStaked }) => {
  const [amount, setAmount]   = useState('');
  const [lockId, setLockId]   = useState<LockId>('locked90');
  const [lpBal, setLpBal]     = useState(0);
  const [xntBal, setXntBal]   = useState(0);
  const [status, setStatus]   = useState('');
  const [pending, setPending] = useState(false);
  const [sig, setSig]         = useState('');

  useEffect(() => {
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`; } catch {}
    return () => { try { document.body.style.position = ''; document.body.style.top = ''; window.scrollTo(0, sy); } catch {} };
  }, []);

  // Fetch balances
  useEffect(() => {
    (async () => {
      try {
        const lpTokenProg = await getTokenProgram(new PublicKey(farm.lpMint), connection);
        const lpAta = getAssociatedTokenAddressSync(
          new PublicKey(farm.lpMint), publicKey, false, lpTokenProg,
        );
        const [lpInfo, xntLamp] = await Promise.all([
          connection.getParsedAccountInfo(lpAta).catch(() => null),
          connection.getBalance(publicKey).catch(() => 0),
        ]);
        const lp = Number((lpInfo?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
        setLpBal(lp);
        setXntBal(xntLamp / LAMPORTS_PER_SOL);
      } catch {}
    })();
  }, [farm.lpMint, publicKey, connection]);

  const amt = parseFloat(amount) || 0;
  const tier = LOCK_TIERS.find(t => t.id === lockId)!;
  const amountUsd = amt * farm.lpPriceUsd;
  const apr = computeApr(farm, tier.multBps);
  const projYearReward = apr > 0 && farm.rewardPriceUsd > 0
    ? (amountUsd * apr / 100) / farm.rewardPriceUsd
    : 0;
  const feeXnt = STAKE_FEE_LAMPORTS / LAMPORTS_PER_SOL;
  const canSubmit = amt > 0 && amt <= lpBal && xntBal >= feeXnt && !pending;

  const handleStake = async () => {
    if (!canSubmit) return;
    setPending(true); setSig(''); setStatus('Building transaction…');
    try {
      const programPk  = new PublicKey(FARM_PROGRAM_ID);
      const lpMintPk   = new PublicKey(farm.lpMint);
      const rewardPk   = new PublicKey(farm.rewardMint);
      const farmPk     = new PublicKey(farm.pubkey);
      const [globalPk] = deriveFarmGlobal();

      const lpTokenProg = await getTokenProgram(lpMintPk, connection);
      const lpAta = getAssociatedTokenAddressSync(lpMintPk, publicKey, false, lpTokenProg);

      // Find unused nonce
      let nonce = 0;
      for (let i = 0; i < 100; i++) {
        const [p] = derivePosition(publicKey, farmPk, i);
        const info = await connection.getAccountInfo(p);
        if (!info) { nonce = i; break; }
      }
      const [positionPk] = derivePosition(publicKey, farmPk, nonce);

      const lockTypeByte = lockId === 'locked30' ? 0 : lockId === 'locked90' ? 1 : 2;
      const rawAmt = BigInt(Math.floor(amt * pow10(farm.lpDecimals))); // LP decimals = 9

      const d = await disc('stake');
      const params = Buffer.alloc(8 + 1 + 4);
      params.writeBigUInt64LE(rawAmt, 0);
      params.writeUInt8(lockTypeByte, 8);
      params.writeUInt32LE(nonce, 9);
      const data = Buffer.concat([d, params]);

      const keys = [
        { pubkey: publicKey,                 isSigner: true,  isWritable: true  }, // owner
        { pubkey: globalPk,                  isSigner: false, isWritable: true  }, // global_state
        { pubkey: farmPk,                    isSigner: false, isWritable: true  }, // farm
        { pubkey: lpMintPk,                  isSigner: false, isWritable: false }, // lp_mint
        { pubkey: lpAta,                     isSigner: false, isWritable: true  }, // owner_lp_ata
        { pubkey: new PublicKey(farm.lpVault),     isSigner: false, isWritable: true  }, // lp_vault
        { pubkey: new PublicKey(farm.rewardVault), isSigner: false, isWritable: false }, // reward_vault
        { pubkey: positionPk,                isSigner: false, isWritable: true  }, // position
        { pubkey: new PublicKey(TREASURY),   isSigner: false, isWritable: true  }, // treasury
        { pubkey: lpTokenProg,               isSigner: false, isWritable: false }, // lp_token_program
        { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false }, // system_program
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false }, // rent
      ];

      const ix = new TransactionInstruction({ programId: programPk, keys, data });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      tx.add(ix);

      setStatus('Waiting for wallet approval…');
      const signed = await signTransaction(tx);
      const txSig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setSig(txSig); setStatus('Confirming…');

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1_500));
        const st = await connection.getSignatureStatus(txSig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error('Tx failed: ' + JSON.stringify(st.value.err));
        if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') {
          setStatus(`✅ Staked ${fmtNum(amt, 4)} ${farm.lpSymbol} for ${tier.label}!`);
          setTimeout(() => { onStaked(); onClose(); }, 2_500);
          return;
        }
      }
      throw new Error('Confirmation timeout');
    } catch (e: any) {
      const friendly = friendlyError(e);
      setStatus(`❌ ${friendly.title} — ${friendly.message}`);
    } finally { setPending(false); }
  };

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center',
      justifyContent: 'center', padding: isMobile ? 0 : 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: isMobile ? '100%' : 520,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(255,140,0,0.25)',
        borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '20px 16px 28px' : '24px 26px',
        maxHeight: isMobile ? '88vh' : 'calc(100vh - 32px)',
        overflowY: 'auto', position: 'relative',
        animation: 'modal-in .22s cubic-bezier(.22,1,.36,1) both',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16,
          width: 30, height: 30, borderRadius: '50%', cursor: 'pointer',
          border: '1px solid rgba(255,140,0,.2)', background: 'rgba(8,12,15,.9)',
          color: '#ff8c00', fontSize: 16 }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18,
          fontWeight: 900, color: '#fff', letterSpacing: 1, marginBottom: 4 }}>
          ⚡ STAKE {farm.lpSymbol}
        </div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11,
          color: '#c0d0e0', marginBottom: 18 }}>
          Earn {farm.rewardSymbol} rewards. Lock duration determines multiplier.
        </div>

        {/* Amount */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2,
          color: '#8899aa', marginBottom: 8 }}>AMOUNT TO STAKE</div>
        <div style={{ background: 'rgba(255,255,255,.04)',
          border: '1px solid rgba(255,140,0,.2)',
          borderRadius: 12, padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input value={amount} onChange={e => setAmount(e.target.value)}
              type="number" min="0" placeholder="0"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontFamily: 'Orbitron,monospace', fontSize: 24, fontWeight: 900, color: '#fff' }} />
            <button onClick={() => setAmount(lpBal.toFixed(6))}
              style={{ background: 'rgba(255,140,0,.1)', border: '1px solid rgba(255,140,0,.3)',
                borderRadius: 7, padding: '5px 12px', cursor: 'pointer',
                fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: '#ff8c00' }}>
              MAX
            </button>
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#c0d0e0', marginTop: 6 }}>
            Balance: {fmtNum(lpBal, 4)} LP
            {amt > 0 && <> · ≈ {fmtUSD(amountUsd)}</>}
          </div>
        </div>

        {/* Lock tier picker */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2,
          color: '#8899aa', marginBottom: 8 }}>LOCK DURATION</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
          {LOCK_TIERS.map(t => (
            <button key={t.id} onClick={() => setLockId(t.id)}
              style={{ padding: '14px 8px', borderRadius: 11, cursor: 'pointer', textAlign: 'center',
                background: lockId === t.id ? `${t.color}18` : 'rgba(255,255,255,.03)',
                border: `1px solid ${lockId === t.id ? `${t.color}66` : 'rgba(255,255,255,.08)'}`,
                transition: 'all 0.15s' }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
                color: lockId === t.id ? t.color : '#8aa0b8' }}>{t.label}</div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900,
                color: lockId === t.id ? t.color : '#4a6a8a', marginTop: 4 }}>{t.multDisplay}</div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8,
                color: '#8899aa', marginTop: 3 }}>weight</div>
            </button>
          ))}
        </div>

        {/* Projections */}
        <div style={{ background: 'rgba(255,255,255,.025)',
          border: '1px solid rgba(255,255,255,.06)',
          borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9,
            color: '#8899aa', letterSpacing: 1, marginBottom: 10 }}>PROJECTION</div>
          {[
            { label: 'EFFECTIVE APR',       val: apr > 0 ? `${apr < 10_000 ? apr.toFixed(2) : fmtNum(apr, 0)}%` : '—', color: tier.color, tip: 'Current realized APR for this tier — based on the live rate and existing stakers. Your actual APR will shift slightly as your stake joins the pool: if you commit a large amount relative to current TVL, the displayed number drops for everyone (you included). Updates live.' },
            { label: 'YEARLY REWARD (est)', val: projYearReward > 0 ? `${fmtNum(projYearReward, 2)} ${farm.rewardSymbol}` : '—', color: '#00c98d', tip: 'Estimated rewards over a full year at the current rate. Actual amount depends on TVL changes and your stake size relative to the pool.' },
            { label: 'UNLOCK DATE',         val: `${tier.days} days from now`, color: '#d0dde8', tip: '' },
            { label: 'STAKE FEE',            val: `${feeXnt} XNT`, color: '#ff8c00', tip: 'Flat fee paid to the protocol treasury on stake. One-time, charged in XNT.' },
          ].map(r => (
            <div key={r.label}
              title={r.tip || undefined}
              style={{ display: 'flex', justifyContent: 'space-between',
              padding: '4px 0', fontFamily: 'Orbitron,monospace', fontSize: 10,
              cursor: r.tip ? 'help' : 'default' }}>
              <span style={{ color: '#8899aa', letterSpacing: .5 }}>{r.label}{r.tip ? ' ⓘ' : ''}</span>
              <span style={{ color: r.color, fontWeight: 700 }}>{r.val}</span>
            </div>
          ))}
        </div>

        {/* Penalty disclosure */}
        <div style={{ padding: '12px 14px', borderRadius: 8, marginBottom: 14,
          background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
          fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#9abacf', lineHeight: 1.5 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
            color: '#4a6a8a', marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' }}>
            Exit policy
          </div>
          <div style={{ marginBottom: 10, fontSize: 10 }}>
            Grace (days 1–3): full LP returned, rewards forfeited. Past grace: LP penalty +
            rewards forfeited. Mature: full LP + full rewards.
          </div>

          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
            color: '#4a6a8a', marginTop: 12, marginBottom: 6, letterSpacing: 1, textTransform: 'uppercase' }}>
            LB-holder discount ladder
          </div>
          <table style={{ width: '100%', fontSize: 9, borderCollapse: 'collapse',
            fontFamily: 'Orbitron,monospace' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', fontWeight: 600,
                  fontSize: 8, color: '#4a6a8a', letterSpacing: .5,
                  borderBottom: '1px solid rgba(255,255,255,.06)' }}>Tier</th>
                <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', fontWeight: 600,
                  fontSize: 8, color: '#4a6a8a', letterSpacing: .5,
                  borderBottom: '1px solid rgba(255,255,255,.06)' }}>LB held</th>
                <th style={{ textAlign: 'right', padding: '4px 8px 4px 0', fontWeight: 600,
                  fontSize: 8, color: '#4a6a8a', letterSpacing: .5,
                  borderBottom: '1px solid rgba(255,255,255,.06)' }}>P1</th>
                <th style={{ textAlign: 'right', padding: '4px 0', fontWeight: 600,
                  fontSize: 8, color: '#4a6a8a', letterSpacing: .5,
                  borderBottom: '1px solid rgba(255,255,255,.06)' }}>P2</th>
              </tr>
            </thead>
            <tbody style={{ color: '#9abacf' }}>
              <tr>
                <td style={{ padding: '4px 8px 4px 0', borderBottom: '1px solid rgba(255,255,255,.03)' }}>—</td>
                <td style={{ padding: '4px 8px 4px 0', borderBottom: '1px solid rgba(255,255,255,.03)' }}>&lt; 33</td>
                <td style={{ padding: '4px 8px 4px 0', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,.03)' }}>4.000%</td>
                <td style={{ padding: '4px 0', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,.03)' }}>1.888%</td>
              </tr>
              <tr>
                <td style={{ padding: '4px 8px 4px 0', borderBottom: '1px solid rgba(255,255,255,.03)' }}>T1</td>
                <td style={{ padding: '4px 8px 4px 0', borderBottom: '1px solid rgba(255,255,255,.03)' }}>≥ 33</td>
                <td style={{ padding: '4px 8px 4px 0', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,.03)' }}>1.888%</td>
                <td style={{ padding: '4px 0', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,.03)' }}>0.888%</td>
              </tr>
              <tr>
                <td style={{ padding: '4px 8px 4px 0', borderBottom: '1px solid rgba(255,255,255,.03)' }}>T2</td>
                <td style={{ padding: '4px 8px 4px 0', borderBottom: '1px solid rgba(255,255,255,.03)' }}>≥ 330</td>
                <td style={{ padding: '4px 8px 4px 0', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,.03)' }}>1.000%</td>
                <td style={{ padding: '4px 0', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,.03)' }}>0.444%</td>
              </tr>
              <tr>
                <td style={{ padding: '4px 8px 4px 0' }}>T3</td>
                <td style={{ padding: '4px 8px 4px 0' }}>≥ 3,300</td>
                <td style={{ padding: '4px 8px 4px 0', textAlign: 'right' }}>0.500%</td>
                <td style={{ padding: '4px 0', textAlign: 'right' }}>0.222%</td>
              </tr>
            </tbody>
          </table>
        </div>

        <StatusBox msg={status} />
        <TxLink sig={sig} color="#ff8c00" />

        <button onClick={handleStake} disabled={!canSubmit}
          style={{ width: '100%', padding: '15px 0', borderRadius: 12,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            background: canSubmit
              ? 'linear-gradient(135deg,rgba(255,140,0,.25),rgba(255,140,0,.08))'
              : 'rgba(255,255,255,.04)',
            border: `1px solid ${canSubmit ? 'rgba(255,140,0,.5)' : 'rgba(255,255,255,.08)'}`,
            fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
            color: canSubmit ? '#ff8c00' : '#4a6a8a', letterSpacing: 1.5 }}>
          {pending ? 'STAKING…' : `⚡ STAKE ${amt > 0 ? fmtNum(amt, 4) : '—'} LP · ${tier.label}`}
        </button>
      </div>
    </div>,
    document.body,
  );
};

// ─── Claim Modal ──────────────────────────────────────────────────────────────
const ClaimModal: FC<{
  position: PositionOnChain; farm: FarmOnChain;
  isMobile: boolean; publicKey: PublicKey; connection: Connection; signTransaction: any;
  onClose: () => void; onClaimed: () => void;
}> = ({ position, farm, isMobile, publicKey, connection, signTransaction, onClose, onClaimed }) => {
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [sig, setSig] = useState('');

  const handleClaim = async () => {
    setPending(true); setStatus('Building transaction…');
    try {
      const programPk  = new PublicKey(FARM_PROGRAM_ID);
      const farmPk     = new PublicKey(farm.pubkey);
      const rewardPk   = new PublicKey(farm.rewardMint);
      const [globalPk] = deriveFarmGlobal();
      const [positionPk] = derivePosition(publicKey, farmPk, position.nonce);

      const rewardProg = await getTokenProgram(rewardPk, connection);
      const rewardAta  = getAssociatedTokenAddressSync(rewardPk, publicKey, false, rewardProg);

      const d = await disc('claim');
      const params = Buffer.alloc(4);
      params.writeUInt32LE(position.nonce, 0);
      const data = Buffer.concat([d, params]);

      const keys = [
        { pubkey: publicKey, isSigner: true,  isWritable: true  },
        { pubkey: globalPk,  isSigner: false, isWritable: true  },
        { pubkey: farmPk,    isSigner: false, isWritable: true  },
        { pubkey: positionPk, isSigner: false, isWritable: true  },
        { pubkey: rewardPk,  isSigner: false, isWritable: false },
        { pubkey: rewardAta, isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(farm.rewardVault), isSigner: false, isWritable: true  },
        { pubkey: rewardProg, isSigner: false, isWritable: false },
      ];

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      // Ensure reward ATA exists
      const ataInfo = await connection.getAccountInfo(rewardAta);
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountIdempotentInstruction(
          publicKey, rewardAta, publicKey, rewardPk, rewardProg,
        ));
      }
      tx.add(new TransactionInstruction({ programId: programPk, keys, data }));

      setStatus('Waiting for wallet…');
      const signed = await signTransaction(tx);
      const txSig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setSig(txSig); setStatus('Confirming…');

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1_500));
        const st = await connection.getSignatureStatus(txSig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error('Tx failed: ' + JSON.stringify(st.value.err));
        if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') {
          setStatus(`✅ Claimed rewards!`);
          setTimeout(() => { onClaimed(); onClose(); }, 2_000);
          return;
        }
      }
      throw new Error('Confirmation timeout');
    } catch (e: any) {
      const friendly = friendlyClaimError(e, position);
      setStatus(`❌ ${friendly.title} — ${friendly.message}`);
    } finally { setPending(false); }
  };

  const earnedUi = Number(position.earnedNow) / pow10(farm.rewardDecimals);
  const earnedUsd = earnedUi * farm.rewardPriceUsd;

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 420,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(0,201,141,.25)', borderRadius: 16,
        padding: '24px 26px', position: 'relative',
        animation: 'modal-in .22s cubic-bezier(.22,1,.36,1) both',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16,
          width: 30, height: 30, borderRadius: '50%', cursor: 'pointer',
          border: '1px solid rgba(0,201,141,.2)', background: 'rgba(8,12,15,.9)',
          color: '#00c98d', fontSize: 16 }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18, fontWeight: 900,
          color: '#fff', letterSpacing: 1, marginBottom: 18 }}>
          💰 CLAIM REWARDS
        </div>

        <div style={{ background: 'rgba(0,201,141,.06)',
          border: '1px solid rgba(0,201,141,.2)', borderRadius: 12,
          padding: '20px', marginBottom: 18, textAlign: 'center' }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9,
            color: '#8899aa', letterSpacing: 1, marginBottom: 8 }}>YOU'LL CLAIM</div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 28, fontWeight: 900,
            color: '#00c98d', marginBottom: 4 }}>
            {fmtNum(earnedUi, 6)} {farm.rewardSymbol}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#d0dde8' }}>
            ≈ {fmtUSD(earnedUsd)}
          </div>
        </div>

        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11,
          color: '#c0d0e0', marginBottom: 18, lineHeight: 1.6 }}>
          Position stays open after claim. Next claim available in 24 hours.
        </div>

        <StatusBox msg={status} />
        <TxLink sig={sig} color="#00c98d" />

        <button onClick={handleClaim} disabled={pending}
          style={{ width: '100%', padding: '14px 0', borderRadius: 11,
            cursor: pending ? 'not-allowed' : 'pointer',
            background: pending ? 'rgba(255,255,255,.04)'
                                : 'linear-gradient(135deg,rgba(0,201,141,.22),rgba(0,201,141,.08))',
            border: '1px solid rgba(0,201,141,.45)',
            fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
            color: pending ? '#4a6a8a' : '#00c98d', letterSpacing: 1.5 }}>
          {pending ? 'CLAIMING…' : '💰 CLAIM NOW'}
        </button>
      </div>
    </div>,
    document.body,
  );
};

// ─── Unstake Modal ────────────────────────────────────────────────────────────
const UnstakeModal: FC<{
  position: PositionOnChain; farm: FarmOnChain;
  isMobile: boolean; publicKey: PublicKey; connection: Connection; signTransaction: any;
  onClose: () => void; onUnstaked: () => void;
}> = ({ position, farm, isMobile, publicKey, connection, signTransaction, onClose, onUnstaked }) => {
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [sig, setSig] = useState('');
  const [lbBal, setLbBal] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const lbAta = getAssociatedTokenAddressSync(
          new PublicKey(LB_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID,
        );
        const info = await connection.getParsedAccountInfo(lbAta).catch(() => null);
        const raw = Number((info?.value?.data as any)?.parsed?.info?.tokenAmount?.amount ?? 0);
        setLbBal(raw);
      } catch {}
    })();
  }, [publicKey, connection]);

  const now = Math.floor(Date.now() / 1000);
  const isMatured = now >= position.unlockTs;
  const isInGrace = now <= position.graceEndTs;
  const lbTier = getLbTier(lbBal);
  const hasDiscount = lbTier > 0; // kept for button-hint copy below

  // Compute penalty with actual LB tier (matches on-chain logic exactly)
  let penaltyBps = 0;
  let period: 1 | 2 = 1;
  if (!isMatured && !isInGrace) {
    const midpoint = position.startTs + position.lockDuration / 2;
    period = now < midpoint ? 1 : 2;
    penaltyBps = getPenaltyBps(period, lbTier);
  }
  const penaltyRaw = (position.amount * BigInt(penaltyBps)) / 10_000n;
  const lpReturnedRaw = position.amount - penaltyRaw;

  const amountUi  = Number(position.amount) / pow10(farm.lpDecimals);
  const returnedUi = Number(lpReturnedRaw) / pow10(farm.lpDecimals);
  const penaltyUi  = Number(penaltyRaw) / pow10(farm.lpDecimals);
  const earnedUi   = Number(position.earnedNow) / pow10(farm.rewardDecimals);
  const isEarly = !isMatured && !isInGrace;

  const handleUnstake = async () => {
    setPending(true); setStatus('Building transaction…');
    try {
      const programPk  = new PublicKey(FARM_PROGRAM_ID);
      const farmPk     = new PublicKey(farm.pubkey);
      const lpMintPk   = new PublicKey(farm.lpMint);
      const rewardPk   = new PublicKey(farm.rewardMint);
      const [globalPk] = deriveFarmGlobal();
      const [positionPk] = derivePosition(publicKey, farmPk, position.nonce);
      const treasuryPk = new PublicKey(TREASURY);

      const lpProg     = await getTokenProgram(lpMintPk, connection);
      const rewardProg = await getTokenProgram(rewardPk, connection);

      const lpAta      = getAssociatedTokenAddressSync(lpMintPk, publicKey, false, lpProg);
      const rewardAta  = getAssociatedTokenAddressSync(rewardPk, publicKey, false, rewardProg);
      const treasLpAta = getAssociatedTokenAddressSync(lpMintPk, treasuryPk, true, lpProg);
      const lbAta      = getAssociatedTokenAddressSync(new PublicKey(LB_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID);
      const lbAtaInfo  = await connection.getAccountInfo(lbAta);
      const lbAccount  = lbAtaInfo ? lbAta : programPk; // program_id sentinel for "no LB"

      const d = await disc('unstake');
      const params = Buffer.alloc(4);
      params.writeUInt32LE(position.nonce, 0);
      const data = Buffer.concat([d, params]);

      const keys = [
        { pubkey: publicKey,       isSigner: true,  isWritable: true  },
        { pubkey: globalPk,        isSigner: false, isWritable: true  },
        { pubkey: farmPk,          isSigner: false, isWritable: true  },
        { pubkey: positionPk,      isSigner: false, isWritable: true  },
        { pubkey: lpMintPk,        isSigner: false, isWritable: false },
        { pubkey: rewardPk,        isSigner: false, isWritable: false },
        { pubkey: lpAta,           isSigner: false, isWritable: true  },
        { pubkey: rewardAta,       isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(farm.lpVault),     isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(farm.rewardVault), isSigner: false, isWritable: true  },
        { pubkey: treasLpAta,      isSigner: false, isWritable: true  },
        { pubkey: treasuryPk,      isSigner: false, isWritable: false },
        { pubkey: lbAccount,       isSigner: false, isWritable: false },
        { pubkey: lpProg,          isSigner: false, isWritable: false },
        { pubkey: rewardProg,      isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });

      // Ensure all destination ATAs exist
      for (const ata of [lpAta, rewardAta, treasLpAta]) {
        const info = await connection.getAccountInfo(ata);
        if (!info) {
          const mint = ata.equals(treasLpAta) ? lpMintPk : (ata.equals(rewardAta) ? rewardPk : lpMintPk);
          const owner = ata.equals(treasLpAta) ? treasuryPk : publicKey;
          const prog = mint.equals(rewardPk) ? rewardProg : lpProg;
          tx.add(createAssociatedTokenAccountIdempotentInstruction(
            publicKey, ata, owner, mint, prog,
          ));
        }
      }
      tx.add(new TransactionInstruction({ programId: programPk, keys, data }));

      setStatus('Waiting for wallet…');
      const signed = await signTransaction(tx);
      const txSig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setSig(txSig); setStatus('Confirming…');

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1_500));
        const st = await connection.getSignatureStatus(txSig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error('Tx failed: ' + JSON.stringify(st.value.err));
        if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') {
          setStatus(isMatured ? '✅ Unstaked! LP + rewards returned.' : '✅ Early exit completed.');
          setTimeout(() => { onUnstaked(); onClose(); }, 2_500);
          return;
        }
      }
      throw new Error('Confirmation timeout');
    } catch (e: any) {
      const friendly = friendlyError(e);
      setStatus(`❌ ${friendly.title} — ${friendly.message}`);
    } finally { setPending(false); }
  };

  const accentColor = isMatured ? '#00c98d' : isInGrace ? '#ffb347' : '#ff6666';

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 460,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: `1px solid ${accentColor}40`, borderRadius: 16,
        padding: '24px 26px', position: 'relative', maxHeight: '88vh', overflowY: 'auto',
        animation: 'modal-in .22s cubic-bezier(.22,1,.36,1) both',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16,
          width: 30, height: 30, borderRadius: '50%', cursor: 'pointer',
          border: `1px solid ${accentColor}40`, background: 'rgba(8,12,15,.9)',
          color: accentColor, fontSize: 16 }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18, fontWeight: 900,
          color: '#fff', letterSpacing: 1, marginBottom: 4 }}>
          {isMatured ? '✓ UNSTAKE' : isInGrace ? '🛡️ GRACE EXIT' : '⚠ EARLY EXIT'}
        </div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#c0d0e0',
          marginBottom: 18, lineHeight: 1.5 }}>
          {isMatured
            ? 'Lock period complete. Full LP + rewards returned.'
            : isInGrace
            ? 'Within 3-day grace period. Full LP returned, all pending rewards forfeited to vault.'
            : 'Early exit: LP penalty + all pending rewards forfeited.'}
        </div>

        <div style={{ background: `${accentColor}08`, border: `1px solid ${accentColor}33`,
          borderRadius: 12, padding: '16px', marginBottom: 16 }}>
          {[
            { label: 'LP RETURNED',  val: `${fmtNum(returnedUi, 4)} LP`, color: '#00c98d' },
            ...(penaltyUi > 0 ? [{
              label: `PENALTY (${(penaltyBps/100).toFixed(3)}%${lbTier > 0 ? ` · T${lbTier} LB discount` : ''})`,
              val: `-${fmtNum(penaltyUi, 4)} LP → treasury`,
              color: '#ff8c00',
            }] : []),
            { label: isMatured ? 'REWARDS PAID' : 'REWARDS FORFEITED',
              val: isMatured
                ? `${fmtNum(earnedUi, 4)} ${farm.rewardSymbol}`
                : `${fmtNum(earnedUi, 4)} ${farm.rewardSymbol} stays in vault`,
              color: isMatured ? '#00c98d' : '#ff6666' },
          ].map(r => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between',
              padding: '6px 0', borderTop: '1px solid rgba(255,255,255,.04)' }}>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8,
                color: '#8899aa', letterSpacing: .5 }}>{r.label}</span>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 11,
                fontWeight: 700, color: r.color, textAlign: 'right', maxWidth: '60%' }}>{r.val}</span>
            </div>
          ))}
        </div>

        {!isMatured && !isInGrace && lbTier < 3 && (
          <div style={{ padding: '10px 12px', borderRadius: 7, marginBottom: 14,
            background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
            fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#9abacf', lineHeight: 1.5 }}>
            {lbTier === 0 && (
              <>You hold {(lbBal/100).toFixed(2)} LB. Hold {(LB_TIER1_THRESHOLD_UI - lbBal/100).toFixed(2)} more to reach T1 ({period === 1 ? '1.888' : '0.888'}% penalty).</>
            )}
            {lbTier === 1 && (
              <>T1 active · {(lbBal/100).toFixed(2)} LB. Hold {(LB_TIER2_THRESHOLD_UI - lbBal/100).toFixed(2)} more to reach T2 ({period === 1 ? '1.000' : '0.444'}% penalty).</>
            )}
            {lbTier === 2 && (
              <>T2 active · {(lbBal/100).toFixed(2)} LB. Hold {(LB_TIER3_THRESHOLD_UI - lbBal/100).toFixed(2)} more to reach T3 ({period === 1 ? '0.500' : '0.222'}% penalty).</>
            )}
          </div>
        )}
        {!isMatured && !isInGrace && lbTier === 3 && (
          <div style={{ padding: '10px 12px', borderRadius: 7, marginBottom: 14,
            background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
            fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#9abacf', lineHeight: 1.5 }}>
            T3 active · {(lbBal/100).toFixed(2)} LB. Lowest penalty tier reached.
          </div>
        )}

        <StatusBox msg={status} />
        <TxLink sig={sig} color={accentColor} />

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose}
            style={{ flex: 1, padding: '13px 0', borderRadius: 11, cursor: 'pointer',
              background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.1)',
              fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: '#c0d0e0' }}>
            CANCEL
          </button>
          <button onClick={handleUnstake} disabled={pending}
            style={{ flex: 2, padding: '13px 0', borderRadius: 11,
              cursor: pending ? 'not-allowed' : 'pointer',
              background: pending ? 'rgba(255,255,255,.04)'
                : `linear-gradient(135deg,${accentColor}22,${accentColor}08)`,
              border: `1px solid ${accentColor}66`,
              fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
              color: pending ? '#4a6a8a' : accentColor, letterSpacing: 1.5 }}>
            {pending ? 'UNSTAKING…' : isMatured ? '✓ CONFIRM UNSTAKE' : '⚠ CONFIRM EARLY EXIT'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

// ─── Donation Modal ───────────────────────────────────────────────────────────
const DonateModal: FC<{
  farm: FarmOnChain; isMobile: boolean; publicKey: PublicKey;
  connection: Connection; signTransaction: any;
  onClose: () => void; onDonated: () => void;
}> = ({ farm, isMobile, publicKey, connection, signTransaction, onClose, onDonated }) => {
  const [amount, setAmount] = useState('');
  const [bal, setBal] = useState(0);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [sig, setSig] = useState('');

  useEffect(() => {
    (async () => {
      const prog = await getTokenProgram(new PublicKey(farm.rewardMint), connection);
      const ata = getAssociatedTokenAddressSync(new PublicKey(farm.rewardMint), publicKey, false, prog);
      const info = await connection.getParsedAccountInfo(ata).catch(() => null);
      setBal(Number((info?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0));
    })();
  }, [farm.rewardMint, publicKey, connection]);

  const amt = parseFloat(amount) || 0;
  const amtUsd = amt * farm.rewardPriceUsd;
  const additionalRunwayDays = farm.rewardRatePerSec > 0n
    ? Math.floor(Number(BigInt(Math.floor(amt * 1e9)) * ACC_PRECISION / farm.rewardRatePerSec) / 86_400)
    : 0;
  const canSubmit = amt > 0 && amt <= bal && !pending;

  const handleDonate = async () => {
    setPending(true); setStatus('Building transaction…');
    try {
      const programPk  = new PublicKey(FARM_PROGRAM_ID);
      const farmPk     = new PublicKey(farm.pubkey);
      const rewardPk   = new PublicKey(farm.rewardMint);
      const prog       = await getTokenProgram(rewardPk, connection);
      const funderAta  = getAssociatedTokenAddressSync(rewardPk, publicKey, false, prog);

      const rawAmt = BigInt(Math.floor(amt * pow10(farm.rewardDecimals)));
      const d = await disc('fund_farm');
      const params = Buffer.alloc(8);
      params.writeBigUInt64LE(rawAmt, 0);
      const data = Buffer.concat([d, params]);

      const keys = [
        { pubkey: publicKey,        isSigner: true,  isWritable: true  },
        { pubkey: farmPk,           isSigner: false, isWritable: true  },
        { pubkey: rewardPk,         isSigner: false, isWritable: false },
        { pubkey: funderAta,        isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(farm.rewardVault), isSigner: false, isWritable: true  },
        { pubkey: prog,             isSigner: false, isWritable: false },
      ];

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      tx.add(new TransactionInstruction({ programId: programPk, keys, data }));

      setStatus('Waiting for wallet…');
      const signed = await signTransaction(tx);
      const txSig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setSig(txSig); setStatus('Confirming…');

      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1_500));
        const st = await connection.getSignatureStatus(txSig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error('Tx failed: ' + JSON.stringify(st.value.err));
        if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') {
          setStatus(`✅ Donated ${fmtNum(amt, 4)} ${farm.rewardSymbol}! Runway extended.`);
          setTimeout(() => { onDonated(); onClose(); }, 2_500);
          return;
        }
      }
      throw new Error('Confirmation timeout');
    } catch (e: any) {
      setStatus('❌ ' + (e?.message ?? String(e)).slice(0, 200));
    } finally { setPending(false); }
  };

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 440,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(0,201,141,.25)', borderRadius: 16,
        padding: '24px 26px', position: 'relative',
        animation: 'modal-in .22s cubic-bezier(.22,1,.36,1) both',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16,
          width: 30, height: 30, borderRadius: '50%', cursor: 'pointer',
          border: '1px solid rgba(0,201,141,.2)', background: 'rgba(8,12,15,.9)',
          color: '#00c98d', fontSize: 16 }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18, fontWeight: 900,
          color: '#fff', letterSpacing: 1, marginBottom: 4 }}>
          💧 DONATE TO {farm.rewardSymbol} FARM
        </div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#c0d0e0',
          marginBottom: 18, lineHeight: 1.5 }}>
          Extend farm runway for existing stakers. Donations cannot be withdrawn.
        </div>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9,
          letterSpacing: 2, color: '#8899aa', marginBottom: 8 }}>
          AMOUNT
        </div>
        <div style={{ background: 'rgba(255,255,255,.04)',
          border: '1px solid rgba(0,201,141,.2)', borderRadius: 12,
          padding: '14px 16px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input value={amount} onChange={e => setAmount(e.target.value)}
              type="number" min="0" placeholder="0"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontFamily: 'Orbitron,monospace', fontSize: 22, fontWeight: 900, color: '#fff' }} />
            <button onClick={() => setAmount(bal.toFixed(6))}
              style={{ background: 'rgba(0,201,141,.1)', border: '1px solid rgba(0,201,141,.3)',
                borderRadius: 7, padding: '5px 12px', cursor: 'pointer',
                fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: '#00c98d' }}>
              MAX
            </button>
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#c0d0e0', marginTop: 6 }}>
            Balance: {fmtNum(bal, 4)} {farm.rewardSymbol}
            {amt > 0 && farm.rewardPriceUsd > 0 && <> · ≈ {fmtUSD(amtUsd)}</>}
          </div>
        </div>

        {amt > 0 && (
          <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 14,
            background: 'rgba(0,201,141,.06)', border: '1px solid rgba(0,201,141,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
              fontFamily: 'Orbitron,monospace', fontSize: 10 }}>
              <span style={{ color: '#8899aa' }}>RUNWAY EXTENSION</span>
              <span style={{ color: '#00c98d', fontWeight: 700 }}>
                +{fmtNum(additionalRunwayDays, 0)} days
              </span>
            </div>
          </div>
        )}

        <StatusBox msg={status} />
        <TxLink sig={sig} color="#00c98d" />

        <button onClick={handleDonate} disabled={!canSubmit}
          style={{ width: '100%', padding: '14px 0', borderRadius: 11,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            background: canSubmit
              ? 'linear-gradient(135deg,rgba(0,201,141,.22),rgba(0,201,141,.08))'
              : 'rgba(255,255,255,.04)',
            border: `1px solid ${canSubmit ? 'rgba(0,201,141,.45)' : 'rgba(255,255,255,.08)'}`,
            fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
            color: canSubmit ? '#00c98d' : '#4a6a8a', letterSpacing: 1.5 }}>
          {pending ? 'DONATING…' : `💧 DONATE ${amt > 0 ? fmtNum(amt, 4) : '—'} ${farm.rewardSymbol}`}
        </button>
      </div>
    </div>,
    document.body,
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═════════════════════════════════════════════════════════════════════════════

const LpFarms: FC = () => {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const isMobile = useIsMobile();

  const [tab, setTab]              = useState<'farms' | 'mystakes'>('farms');
  const [farms, setFarms]          = useState<FarmOnChain[]>([]);
  const [positions, setPositions]  = useState<PositionOnChain[]>([]);
  const [loading, setLoading]      = useState(true);    // only on first-ever load
  const [refreshing, setRefreshing] = useState(false);  // background poll; does not hide UI
  const [stakeTarget, setStakeTarget]     = useState<FarmOnChain | null>(null);
  const [donateTarget, setDonateTarget]   = useState<FarmOnChain | null>(null);
  const [claimTarget, setClaimTarget]     = useState<PositionOnChain | null>(null);
  const [unstakeTarget, setUnstakeTarget] = useState<PositionOnChain | null>(null);

  // loadData(silent=true)  → keeps cards on screen while fresh data fetches
  // loadData(silent=false) → shows skeleton (only used on initial page load)
  const loadData = useCallback(async (silent = true) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const fs = await fetchFarms(connection);
      setFarms(fs);
      if (publicKey) {
        const allPos: PositionOnChain[] = [];
        for (const f of fs) {
          const ps = await fetchPositions(connection, publicKey, f);
          allPos.push(...ps);
        }
        setPositions(allPos);
      } else {
        setPositions([]);
      }
    } catch (e) {
      console.error('loadData error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [connection, publicKey]);

  // Initial load — shows skeleton
  useEffect(() => { loadData(false); }, [loadData]);
  // Background refresh every 30s — cards stay visible
  useEffect(() => {
    const i = setInterval(() => loadData(true), 30_000);
    return () => clearInterval(i);
  }, [loadData]);

  const positionsByFarm = useMemo(() => {
    const m = new Map<string, PositionOnChain[]>();
    for (const p of positions) {
      if (!m.has(p.farm)) m.set(p.farm, []);
      m.get(p.farm)!.push(p);
    }
    return m;
  }, [positions]);

  // Aggregate stats
  const totalVaultUsd = farms.reduce((s, f) =>
    s + (Number(f.vaultBalance) / pow10(f.rewardDecimals)) * f.rewardPriceUsd, 0);
  const totalTvlUsd = farms.reduce((s, f) =>
    s + (Number(f.totalStaked) / pow10(f.lpDecimals)) * f.lpPriceUsd, 0);
  const myTotalStakedUsd = positions.reduce((s, p) => {
    const farm = farms.find(f => f.pubkey === p.farm);
    if (!farm) return s;
    return s + (Number(p.amount) / pow10(farm.lpDecimals)) * farm.lpPriceUsd;
  }, 0);
  const myPendingUsd = positions.reduce((s, p) => {
    const farm = farms.find(f => f.pubkey === p.farm);
    if (!farm) return s;
    return s + (Number(p.earnedNow) / pow10(farm.rewardDecimals)) * farm.rewardPriceUsd;
  }, 0);

  return (
    <div style={{ minHeight: '100vh', background: '#080c0f',
      padding: isMobile ? '70px 10px 40px' : '90px 24px 60px',
      position: 'relative', overflow: 'hidden' }}>

      <TopBar />
      <PageBackground />

      {/* Background orbs */}
      <div style={{ position: 'fixed', top: '20%', left: '10%', width: 600, height: 600,
        borderRadius: '50%', background: 'radial-gradient(circle,rgba(255,140,0,0.04) 0%,transparent 60%)',
        pointerEvents: 'none', zIndex: 0 }} />
      <div style={{ position: 'fixed', top: '60%', right: '5%', width: 500, height: 500,
        borderRadius: '50%', background: 'radial-gradient(circle,rgba(0,201,141,0.05) 0%,transparent 60%)',
        pointerEvents: 'none', zIndex: 0 }} />

      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes modal-in { from{opacity:0;transform:scale(.93) translateY(20px)} to{opacity:1;transform:scale(1) translateY(0)} }
        input[type=number]::-webkit-outer-spin-button, input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0 }
        input[type=number] { -moz-appearance:textfield }
      `}</style>

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1_100, margin: '0 auto' }}>

        {/* ── HEADER ─────────────────────────────────────────────────── */}
        <div style={{ textAlign: 'center', marginBottom: isMobile ? 28 : 44 }}>
          <h1 style={{ fontFamily: 'Orbitron,monospace',
            fontSize: isMobile ? 22 : 40, fontWeight: 900,
            letterSpacing: isMobile ? 1 : 3, margin: '0 0 6px',
            textTransform: 'uppercase', animation: 'fadeUp 0.5s ease 0.05s both' }}>
            <span style={{ color: '#ff8c00' }}>LP FARMS</span>
            <span style={{ color: 'rgba(255,255,255,.15)', margin: isMobile ? '0 8px' : '0 14px', fontWeight: 300 }}>·</span>
            <span style={{ color: '#e0f0ff' }}>STAKE & EARN</span>
          </h1>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 7 : 9,
            color: '#d0dde8', letterSpacing: isMobile ? 2 : 3, marginBottom: isMobile ? 8 : 12,
            animation: 'fadeUp 0.5s ease 0.12s both' }}>
            X1 BLOCKCHAIN · LOCK LP · EARN REWARDS · PERPETUAL FARMS
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 11 : 13,
            color: '#c0d0e0', marginBottom: isMobile ? 22 : 30,
            letterSpacing: .5, animation: 'fadeUp 0.5s ease 0.15s both', lineHeight: 1.6 }}>
            Stake your BRAINS/XNT or LB/XNT LP tokens &nbsp;·&nbsp; Lock 30 / 90 / 365 days &nbsp;·&nbsp; Up to 8× boosted rewards
          </div>

          {/* Orange accent line */}
          <div style={{ width: '100%', maxWidth: 900, margin: '0 auto 14px', height: 2,
            background: 'linear-gradient(90deg, transparent, #ff8c00, #ffb700, #ff8c00, transparent)',
            borderRadius: 2,
            boxShadow: '0 0 12px rgba(255,140,0,.4), 0 0 24px rgba(255,140,0,.15)' }} />

          {/* Stat cards */}
          <div style={{ width: '100%', maxWidth: 900, margin: '0 auto',
            animation: 'fadeUp 0.5s ease 0.22s both',
            display: 'grid',
            gridTemplateColumns: isMobile ? 'repeat(2, minmax(0,1fr))' : 'repeat(4, minmax(0,1fr))',
            gap: 8 }}>
            {[
              { label: 'Active Farms',   value: String(farms.filter(f => !f.closed).length), sub: 'running',            color: '#ff8c00' },
              { label: 'Total Vault',    value: totalVaultUsd > 0 ? fmtUSD(totalVaultUsd) : '—', sub: 'rewards locked', color: '#00c98d' },
              { label: 'Total TVL',      value: totalTvlUsd > 0 ? fmtUSD(totalTvlUsd) : '—',     sub: 'lp staked',       color: '#00d4ff' },
              { label: 'My Rewards',     value: myPendingUsd > 0 ? fmtUSD(myPendingUsd) : '—',   sub: 'claimable',        color: '#bf5af2' },
            ].map(({ label, value, sub, color }) => (
              <div key={label} style={{
                background: '#0d1520', border: '1px solid rgba(255,255,255,.07)',
                borderRadius: 14, padding: isMobile ? '14px' : '18px 20px',
                position: 'relative', overflow: 'hidden',
              }}>
                <div style={{ position: 'absolute', top: -24, right: -24,
                  width: 90, height: 90, borderRadius: '50%', background: color,
                  opacity: 0.12, filter: 'blur(28px)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1,
                  background: `linear-gradient(90deg,${color}55,transparent)` }} />
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 8 : 10,
                  letterSpacing: 1, color: 'rgba(255,255,255,.3)', marginBottom: isMobile ? 6 : 10,
                  textTransform: 'uppercase' }}>{label}</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 20,
                  fontWeight: 700, color, letterSpacing: 0.5, lineHeight: 1 }}>{value}</div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10,
                  color: 'rgba(255,255,255,.18)', marginTop: 6 }}>{sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── TAB SWITCHER ─────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 6, marginBottom: isMobile ? 20 : 28,
          background: 'rgba(255,255,255,.03)', borderRadius: 14, padding: 4,
          border: '1px solid rgba(255,255,255,.06)',
          animation: 'fadeUp 0.4s ease 0.28s both' }}>
          {[
            { id: 'farms' as const,    label: '🌾 AVAILABLE FARMS', sub: `${farms.length} live` },
            { id: 'mystakes' as const, label: '📋 MY STAKES',       sub: positions.length > 0 ? `${positions.length} active` : 'your positions' },
          ].map(m => {
            const isActive = tab === m.id;
            return (
              <button key={m.id} onClick={() => setTab(m.id)}
                style={{ flex: 1, padding: isMobile ? '12px 8px' : '14px 12px',
                  background: isActive
                    ? 'linear-gradient(135deg,rgba(255,140,0,.15),rgba(255,183,0,.06))'
                    : 'transparent',
                  border: isActive ? '1px solid rgba(255,140,0,.4)' : '1px solid transparent',
                  borderRadius: 11, cursor: 'pointer', textAlign: 'center', transition: 'all .18s' }}>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 10 : 12,
                  fontWeight: 900, color: isActive ? '#ff8c00' : '#4a6a8a', marginBottom: 2 }}>
                  {m.label}
                </div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1,
                  color: isActive ? 'rgba(255,140,0,.6)' : '#3a5a7a' }}>
                  {m.sub}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── CONTENT ───────────────────────────────────────────────── */}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[0, 1].map(i => (
              <div key={i} style={{ height: 220, borderRadius: 16,
                background: 'linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.07) 50%,rgba(255,255,255,.04) 75%)',
                backgroundSize: '400px 100%',
                animation: `fadeUp 0.3s ease ${i * 0.1}s both` }} />
            ))}
          </div>
        ) : tab === 'farms' ? (
          farms.length === 0 ? (
            <div style={{ textAlign: 'center', padding: isMobile ? '60px 20px' : '100px 40px' }}>
              <div style={{ fontSize: 64, marginBottom: 24 }}>🌾</div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 20,
                fontWeight: 900, color: '#d0dde8', marginBottom: 12, letterSpacing: 2 }}>
                NO FARMS LIVE YET
              </div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 12 : 13,
                color: '#c0d0e0', maxWidth: 380, margin: '0 auto', lineHeight: 1.7 }}>
                Farms will appear here once the admin creates them. Check back soon.
              </div>
            </div>
          ) : (
            farms.map(farm => (
              <FarmCard key={farm.pubkey} farm={farm} isMobile={isMobile}
                userPositions={positionsByFarm.get(farm.pubkey) ?? []}
                onStake={() => setStakeTarget(farm)}
                onFund={() => setDonateTarget(farm)} />
            ))
          )
        ) : (
          // MY STAKES
          !publicKey ? (
            <div style={{ textAlign: 'center', padding: isMobile ? '60px 20px' : '100px 40px' }}>
              <div style={{ fontSize: 64, marginBottom: 24 }}>🔌</div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 20,
                fontWeight: 900, color: '#d0dde8', marginBottom: 12, letterSpacing: 2 }}>
                CONNECT WALLET
              </div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 13,
                color: '#c0d0e0', maxWidth: 340, margin: '0 auto', lineHeight: 1.7 }}>
                Connect your wallet to see your stakes.
              </div>
            </div>
          ) : positions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: isMobile ? '60px 20px' : '100px 40px' }}>
              <div style={{ fontSize: 64, marginBottom: 24 }}>📋</div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 20,
                fontWeight: 900, color: '#d0dde8', marginBottom: 12, letterSpacing: 2 }}>
                NO ACTIVE STAKES
              </div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 13,
                color: '#c0d0e0', maxWidth: 340, margin: '0 auto 24px', lineHeight: 1.7 }}>
                Head to the farms tab and stake your LP tokens to start earning.
              </div>
              <button onClick={() => setTab('farms')}
                style={{ padding: '12px 28px', borderRadius: 11, cursor: 'pointer',
                  background: 'linear-gradient(135deg,rgba(255,140,0,.22),rgba(255,140,0,.08))',
                  border: '1px solid rgba(255,140,0,.45)',
                  fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 900,
                  color: '#ff8c00', letterSpacing: 1.5 }}>
                BROWSE FARMS →
              </button>
            </div>
          ) : (
            <>
              {/* Summary card */}
              <div style={{ background: 'linear-gradient(155deg,#0d1622,#080c0f)',
                border: '1px solid rgba(255,140,0,.15)', borderRadius: 14,
                padding: isMobile ? '16px' : '20px 24px', marginBottom: 16,
                display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)', gap: 14 }}>
                {[
                  { label: 'POSITIONS',      val: String(positions.length),       color: '#e0f0ff' },
                  { label: 'TOTAL STAKED',   val: fmtUSD(myTotalStakedUsd),        color: '#00d4ff' },
                  { label: 'CLAIMABLE NOW',  val: fmtUSD(myPendingUsd),            color: '#00c98d' },
                ].map(s => (
                  <div key={s.label}>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8,
                      letterSpacing: 1, color: '#8899aa', marginBottom: 4 }}>{s.label}</div>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18,
                      fontWeight: 800, color: s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {positions.map(p => {
                const farm = farms.find(f => f.pubkey === p.farm);
                if (!farm) return null;
                return (
                  <PositionCard key={p.pubkey} position={p} farm={farm} isMobile={isMobile}
                    onClaim={() => setClaimTarget(p)}
                    onUnstake={() => setUnstakeTarget(p)} />
                );
              })}
            </>
          )
        )}

        {/* ── HOW IT WORKS / TOKENOMICS (only on farms tab) ────────────── */}
        {tab === 'farms' && !loading && farms.length > 0 && (
          <div style={{ marginTop: isMobile ? 24 : 36 }}>
            <TokenomicsPanel isMobile={isMobile} />
          </div>
        )}
      </div>

      {/* ── MODALS ────────────────────────────────────────────────── */}
      {stakeTarget && publicKey && (
        <StakeModal farm={stakeTarget} isMobile={isMobile}
          publicKey={publicKey} connection={connection} signTransaction={signTransaction}
          onClose={() => setStakeTarget(null)}
          onStaked={loadData} />
      )}
      {donateTarget && publicKey && (
        <DonateModal farm={donateTarget} isMobile={isMobile}
          publicKey={publicKey} connection={connection} signTransaction={signTransaction}
          onClose={() => setDonateTarget(null)}
          onDonated={loadData} />
      )}
      {claimTarget && publicKey && (
        <ClaimModal position={claimTarget} farm={farms.find(f => f.pubkey === claimTarget.farm)!}
          isMobile={isMobile}
          publicKey={publicKey} connection={connection} signTransaction={signTransaction}
          onClose={() => setClaimTarget(null)}
          onClaimed={loadData} />
      )}
      {unstakeTarget && publicKey && (
        <UnstakeModal position={unstakeTarget} farm={farms.find(f => f.pubkey === unstakeTarget.farm)!}
          isMobile={isMobile}
          publicKey={publicKey} connection={connection} signTransaction={signTransaction}
          onClose={() => setUnstakeTarget(null)}
          onUnstaked={loadData} />
      )}
    </div>
  );
};

export default LpFarms;
