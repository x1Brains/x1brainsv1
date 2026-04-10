import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { awardLabWorkPoints } from '../lib/supabase';
import { createPortal } from 'react-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey, Transaction, SystemProgram,
  LAMPORTS_PER_SOL, Connection,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { TopBar, PageBackground, Footer } from '../components/UI';
import { BurnedBrainsBar } from '../components/BurnedBrainsBar';
import { BRAINS_MINT as BRAINS_MINT_STR } from '../constants';

// ─── Program Constants — match deployed program exactly ───────────────────────
const PROGRAM_ID      = 'DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM';
const BRAINS_MINT     = BRAINS_MINT_STR; // EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN
const LB_MINT         = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
const WXNT_MINT       = 'So11111111111111111111111111111111111111112';
const TREASURY        = 'CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF';
// ── XNT/USDC.X pool for on-chain price oracle (v1.1) ─────────────────────────
const XNT_USDC_POOL       = 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR';
const XNT_USDC_VAULT_XNT  = '8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb';
const XNT_USDC_VAULT_USDC = '7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg';
const INCINERATOR         = '1nc1nerator11111111111111111111111111111111';
const XDEX_PROGRAM        = 'sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN';
const XDEX_AMM_CONFIG_A   = '2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c';
const XDEX_LP_AUTH        = '9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU';
const SLOT_HASHES_SYSVAR  = 'SysvarS1otHashes111111111111111111111111111';
const XDEX_FEE_VAULT      = 'SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1';
const XDEX_BASE           = '/api/xdex-price/api';
const RPC                 = 'https://rpc.mainnet.x1.xyz';

// ─── Fee constants — mirror program constants.rs exactly ─────────────────────
const FEE_BPS_ECOSYSTEM  = 88;    // 0.888% — BRAINS or LB
const FEE_BPS_DISCOUNT   = 88;    // 0.888% — any token + 33 LB held
const FEE_BPS_STANDARD   = 188;   // 1.888% — everyone else
const FEE_BPS_DELIST     = 44;    // 0.444%
const FEE_EDIT_XNT_LAMPS = 1_000_000;    // 0.001 XNT in lamports
const FEE_MINIMUM_XNT    = 100_000_000;  // 0.1 XNT minimum floor
const LB_DISCOUNT_THRESHOLD = 3_300;     // 33 LB at 2 decimals

// ─── Burn BPS whitelist — matches program VALID_BURN_BPS ─────────────────────
const BURN_OPTIONS = [
  { pct: 0,    bps: 0,     label: '0%',   desc: 'No burn · LP split 50/50',     color: '#4a6a8a', eachPct: 50   },
  { pct: 25,   bps: 2500,  label: '25%',  desc: '25% burned · 75% split 50/50', color: '#ff8c00', eachPct: 37.5 },
  { pct: 50,   bps: 5000,  label: '50%',  desc: '50% burned · 50% split 50/50', color: '#bf5af2', eachPct: 25   },
  { pct: 100,  bps: 10000, label: '100%', desc: 'All burned · max LB points',   color: '#ff4444', eachPct: 0    },
] as const;



// ─── Detect token program from mint account owner ────────────────────────────
async function getTokenProgram(mintPubkey: PublicKey, connection: any): Promise<PublicKey> {
  try {
    const info = await connection.getAccountInfo(mintPubkey);
    if (info?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  } catch {}
  return TOKEN_PROGRAM_ID;
}

// ─── Program error decoder ────────────────────────────────────────────────────
function decodeProgramError(errStr: string): string {
  const customMatch = errStr.match(/"Custom"\s*:\s*(\d+)/);
  if (customMatch) {
    const code = parseInt(customMatch[1]);
    const msgs: Record<number, string> = {
      6000: '⏸️ Protocol is paused. Try again later.',
      6001: '🔄 Another operation is in progress. Wait a moment and retry.',
      6002: '⚠️ Math overflow. The amounts may be too large.',
      6003: '⚠️ LP math check failed. Please retry.',
      6004: '🚫 Not authorized.',
      6005: '🚫 You cannot match your own listing.',
      6006: '🚫 This wallet is flagged and cannot use the protocol.',
      6007: '⚠️ Invalid burn percentage.',
      6008: '⚠️ Amount must be greater than zero.',
      6009: '⚠️ Listing value is below the $1.00 minimum.',
      6010: '⚠️ Invalid treasury account.',
      6011: '⚠️ Invalid XDEX program ID.',
      6012: '⚠️ Invalid AMM config.',
      6013: '⏱️ Price data is stale — took too long to sign. Retry immediately.',
      6014: '⚠️ Invalid timestamp. Please retry.',
      6015: '⚠️ Token price is zero or invalid on XDEX.',
      6016: '⚖️ Your deposit value does not match the listing (must be within ±0.5%). Adjust your amount and retry.',
      6017: '💧 Price impact too high — pool liquidity is too thin for this amount.',
      6018: '📊 Your XNT price disagrees with the on-chain oracle. Market moved — please retry.',
      6019: '🏊 This token has no XNT pool on XDEX. Create one on XDEX first.',
      6020: '⚠️ Invalid pool address. Please report this as a bug.',
      6021: '💧 This token\'s XNT pool has less than $300 TVL. Add more liquidity on XDEX first.',
      6022: '⏳ This token\'s XNT pool is less than 24 hours old. Please wait before matching.',
      6023: '🏊 An XDEX pool already exists for this token pair.',
      6024: '⚠️ Could not read pool data on-chain. Please retry.',
      6025: '📋 This listing is no longer open — it may already be matched or delisted.',
      6026: '⏱️ Rate limited — max 2 listings per hour.',
      6027: '⚠️ Insufficient LP tokens received from XDEX. Please retry.',
      6028: '⚡ Transaction took too long — same-slot check failed. Retry immediately.',
      6029: '⚠️ Invalid bump seed. Please report this as a bug.',
      6030: '⚠️ Invalid sysvar data. Please retry.',
      6031: '🔐 Large listing requires commit-reveal. Please contact support.',
      6032: '🔐 Commitment hash mismatch. Please retry.',
      6033: '⏳ Too early to reveal commitment.',
      6034: '⏰ Commitment expired. Please recommit.',
      6035: '🔐 Commitment already revealed.',
    };
    return msgs[code] ?? `On-chain error ${code} — please retry or contact support.`;
  }
  if (errStr.includes('User rejected') || errStr.includes('rejected')) return 'Transaction cancelled.';
  if (errStr.includes('insufficient funds') || errStr.includes('0x1')) return '💸 Insufficient XNT to pay fees.';
  if (errStr.includes('confirmation timeout')) return '⏱️ Confirmation timed out — check the explorer, it may have gone through.';
  if (errStr.includes('same-slot') || errStr.includes('6028')) return '⚡ Same-slot check failed — retry immediately.';
  return errStr.slice(0, 200);
}

// ─── PDA derivation helpers — match program seeds exactly ────────────────────
function deriveGlobalState(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_state')],
    new PublicKey(PROGRAM_ID)
  );
}

function deriveListingState(creator: PublicKey, tokenAMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('listing'), creator.toBuffer(), tokenAMint.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

function deriveEscrow(listingState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), listingState.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

function deriveEscrowAuth(listingState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow_auth'), listingState.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

function deriveWalletState(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('wallet_state'), wallet.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

function derivePoolRecord(poolAddress: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_record'), poolAddress.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

function deriveMatchIntent(matcher: PublicKey, listingState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('match_intent'), matcher.toBuffer(), listingState.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

// ─── XDEX (Raydium CP-swap fork) PDA derivation — seeds from raydium-cp-swap repo ──
function deriveXdexPoolState(ammConfig: PublicKey, token0Mint: PublicKey, token1Mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), ammConfig.toBuffer(), token0Mint.toBuffer(), token1Mint.toBuffer()],
    new PublicKey(XDEX_PROGRAM)
  );
}

function deriveXdexLpMint(poolState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_lp_mint'), poolState.toBuffer()],
    new PublicKey(XDEX_PROGRAM)
  );
}

function deriveXdexPoolVault(poolState: PublicKey, tokenMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), poolState.toBuffer(), tokenMint.toBuffer()],
    new PublicKey(XDEX_PROGRAM)
  );
}

function deriveXdexObservation(poolState: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('observation'), poolState.toBuffer()],
    new PublicKey(XDEX_PROGRAM)
  );
}

// Token ordering — sort mints as 32-byte arrays lexicographically (Raydium rule)
// Returns { token0, token1, tokenAIsToken0 }
function sortTokenMints(mintA: PublicKey, mintB: PublicKey): { token0: PublicKey; token1: PublicKey; tokenAIsToken0: boolean } {
  const a = mintA.toBuffer();
  const b = mintB.toBuffer();
  for (let i = 0; i < 32; i++) {
    if (a[i] < b[i]) return { token0: mintA, token1: mintB, tokenAIsToken0: true };
    if (a[i] > b[i]) return { token0: mintB, token1: mintA, tokenAIsToken0: false };
  }
  return { token0: mintA, token1: mintB, tokenAIsToken0: true };
}

// ─── Fee calculation — mirrors program calculate_fee() exactly ────────────────
function calculateFeeXnt(
  isEcosystem: boolean,
  lbBalance: number,   // raw LB balance (2 decimals)
  usdVal: number,      // USD value 6 decimals
  xntPriceUsd: number  // XNT price in USD 6 decimals
): number {
  const feeBps = isEcosystem ? FEE_BPS_ECOSYSTEM
               : lbBalance >= LB_DISCOUNT_THRESHOLD ? FEE_BPS_DISCOUNT
               : FEE_BPS_STANDARD;

  const feeUsd = Math.floor(usdVal * feeBps / 10_000);
  const feeXnt = Math.floor(feeUsd * 1_000_000_000 / xntPriceUsd);
  return Math.max(feeXnt, FEE_MINIMUM_XNT);
}

// Display helpers
function feeXntToDisplay(lamports: number, xntPriceUsd: number): { xnt: number; usd: number } {
  const xnt = lamports / LAMPORTS_PER_SOL;
  const usd = xnt * (xntPriceUsd / 1_000_000);
  return { xnt, usd };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function useIsMobile() {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

function fmtUSD(v: number) {
  if (!v) return '$0.00';
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v/1_000).toFixed(2)}K`;
  if (v >= 1)         return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

function fmtXNT(v: number) {
  if (!v) return '0 XNT';
  if (v >= 1_000) return `${(v/1_000).toFixed(2)}K XNT`;
  return `${v.toFixed(4)} XNT`;
}

function fmtNum(v: number, dec = 2) {
  if (!v) return '0';
  if (v >= 1_000_000) return `${(v/1_000_000).toFixed(dec)}M`;
  if (v >= 1_000)     return `${(v/1_000).toFixed(dec)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: dec });
}

function truncAddr(a: string) { return `${a.slice(0,4)}…${a.slice(-4)}`; }

// ─── Types ────────────────────────────────────────────────────────────────────
interface TokenPrice {
  priceUSD: number;   // actual USD float
  priceUSD6: number;  // USD * 1_000_000 (6 dec for program)
  priceXNT6: number;  // price in XNT * 1_000_000 (6 dec)
}

interface ListingOnChain {
  id:           string; // listing state pubkey
  creator:      string;
  tokenAMint:   string;
  tokenASymbol: string;
  tokenALogo?:  string;
  amount:       number;  // raw amount
  amountUi:     number;  // human readable
  usdVal:       number;  // USD 6 dec
  usdValUi:     number;  // human readable USD
  xntVal:       number;  // XNT 9 dec
  burnBps:      number;  // 0/2500/5000/10000
  isEcosystem:  boolean;
  status:       'open' | 'matched' | 'delisted';
  createdAt:    number;
}

// ─── XDEX API ─────────────────────────────────────────────────────────────────
async function fetchXdexPrice(mint: string): Promise<TokenPrice | null> {
  try {
    const [tokenRes, xntRes] = await Promise.all([
      fetch(`${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${mint}`,
        { signal: AbortSignal.timeout(6000) }),
      fetch(`${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${WXNT_MINT}`,
        { signal: AbortSignal.timeout(6000) }),
    ]);
    const [tj, xj] = await Promise.all([tokenRes.json(), xntRes.json()]);
    if (!tj.success) return null;
    const priceUSD  = Number(tj.data?.price) || 0;
    const xntPriceUSD = Number(xj.data?.price) || 0.4187;
    const priceUSD6 = Math.floor(priceUSD * 1_000_000);
    const priceXNT6 = xntPriceUSD > 0
      ? Math.floor((priceUSD / xntPriceUSD) * 1_000_000)
      : 0;
    return { priceUSD, priceUSD6, priceXNT6 };
  } catch { return null; }
}

// ── Token metadata — 3-layer system matching TokenComponents.tsx ──────────────
// Layer 1: Token-2022 on-chain extensions (most authoritative)
// Layer 2: Metaplex metadata program
// Layer 3: XDEX API (fallback)

interface TokenMeta { symbol: string; name: string; logo?: string; decimals: number; source: 'token2022ext' | 'metaplex' | 'xdex' | 'fallback' }

const _metaCache = new Map<string, TokenMeta>();

async function fetchToken2022Meta(mint: string): Promise<TokenMeta | null> {
  try {
    const conn = new Connection(RPC, 'confirmed');
    const mintPk = new PublicKey(mint);
    const info = await conn.getParsedAccountInfo(mintPk);
    const parsed = (info?.value?.data as any)?.parsed?.info;
    if (!parsed) return null;
    const decimals = parsed.decimals ?? 9;
    const extensions = parsed.extensions as any[] | undefined;
    if (!extensions) return null;
    const metaExt = extensions.find((e: any) => e.extension === 'tokenMetadata');
    if (!metaExt?.state) return null;
    const { name, symbol, uri } = metaExt.state;
    if (!symbol && !name) return null;
    // Try to fetch logo from URI
    let logo: string | undefined;
    if (uri) {
      try {
        const r = await fetch(uri, { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        logo = j?.image || j?.logo || j?.icon;
      } catch {}
    }
    return { symbol: symbol || mint.slice(0,6), name: name || mint.slice(0,6), logo, decimals, source: 'token2022ext' };
  } catch { return null; }
}

async function fetchMetaplexMeta(mint: string): Promise<TokenMeta | null> {
  try {
    const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
      METADATA_PROGRAM
    );
    const conn = new Connection(RPC, 'confirmed');
    const info = await conn.getParsedAccountInfo(metadataPda);
    if (!info?.value) return null;
    const data = info.value.data as Buffer;
    if (!Buffer.isBuffer(data) || data.length < 1) return null;
    // Parse Metaplex metadata — name at offset 69, symbol at offset 105
    let offset = 1 + 32 + 32; // discriminator + update_authority + mint
    const nameLen = data.readUInt32LE(offset); offset += 4;
    const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim(); offset += nameLen;
    const symLen = data.readUInt32LE(offset); offset += 4;
    const symbol = data.slice(offset, offset + symLen).toString('utf8').replace(/\0/g, '').trim(); offset += symLen;
    const uriLen = data.readUInt32LE(offset); offset += 4;
    const uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();
    if (!symbol && !name) return null;
    let logo: string | undefined;
    if (uri) {
      try {
        const r = await fetch(uri, { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        logo = j?.image || j?.logo || j?.icon;
      } catch {}
    }
    const conn2 = new Connection(RPC, 'confirmed');
    const mintInfo = await conn2.getParsedAccountInfo(new PublicKey(mint));
    const decimals = (mintInfo?.value?.data as any)?.parsed?.info?.decimals ?? 9;
    return { symbol: symbol || mint.slice(0,6), name: name || mint.slice(0,6), logo, decimals, source: 'metaplex' };
  } catch { return null; }
}

async function fetchXdexMeta(mint: string): Promise<TokenMeta | null> {
  try {
    const r = await fetch(`${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${mint}`,
      { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (j.success && j.data) {
      const logo = j.data.logo || j.data.logoUri || j.data.image || j.data.icon;
      return {
        symbol:   j.data.symbol   || mint.slice(0, 6),
        name:     j.data.name     || mint.slice(0, 6),
        logo,
        decimals: j.data.decimals ?? 9,
        source:   'xdex',
      };
    }
  } catch {}
  return null;
}

async function fetchTokenMeta(mint: string): Promise<TokenMeta> {
  if (_metaCache.has(mint)) return _metaCache.get(mint)!;
  // Layer 1 — Token-2022 on-chain extensions
  const t22 = await fetchToken2022Meta(mint);
  if (t22) { _metaCache.set(mint, t22); return t22; }
  // Layer 2 — Metaplex
  const mpx = await fetchMetaplexMeta(mint);
  if (mpx) { _metaCache.set(mint, mpx); return mpx; }
  // Layer 3 — XDEX API
  const xdex = await fetchXdexMeta(mint);
  if (xdex) { _metaCache.set(mint, xdex); return xdex; }
  // Fallback
  const fallback: TokenMeta = { symbol: mint.slice(0,4).toUpperCase(), name: mint.slice(0,8), decimals: 9, source: 'fallback' };
  _metaCache.set(mint, fallback);
  return fallback;
}

// Check if a token has an XNT pool on XDEX
// Uses 3 methods — any one passing = pool exists
async function checkPoolExists(tokenMint: string, xntMint: string): Promise<boolean> {
  const checks = await Promise.allSettled([

    // Method 1 — pool/tokens endpoint both orderings
    (async () => {
      const [r1, r2] = await Promise.all([
        fetch(`${XDEX_BASE}/xendex/pool/tokens/${tokenMint}/${xntMint}?network=mainnet`,
          { signal: AbortSignal.timeout(6000) }),
        fetch(`${XDEX_BASE}/xendex/pool/tokens/${xntMint}/${tokenMint}?network=mainnet`,
          { signal: AbortSignal.timeout(6000) }),
      ]);
      const [j1, j2] = await Promise.all([r1.json(), r2.json()]);
      if ((j1.success && !!j1.data) || (j2.success && !!j2.data)) return true;
      throw new Error('not found via pool/tokens');
    })(),

    // Method 2 — if XDEX price API returns a valid price, it has a pool
    (async () => {
      const r = await fetch(
        `${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${tokenMint}`,
        { signal: AbortSignal.timeout(6000) }
      );
      const j = await r.json();
      if (j.success && j.data?.price && Number(j.data.price) > 0) return true;
      throw new Error('no price data');
    })(),

    // Method 3 — check by pool address lookup
    (async () => {
      const r = await fetch(
        `${XDEX_BASE}/xendex/pool/list?network=mainnet&token=${tokenMint}`,
        { signal: AbortSignal.timeout(6000) }
      );
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j?.data ?? j?.pools ?? j?.result ?? []);
      if (list.length > 0) return true;
      throw new Error('no pools in list');
    })(),
  ]);

  // If ANY method succeeded, pool exists
  return checks.some(r => r.status === 'fulfilled' && r.value === true);
}


// ─── Fetch platform stats from GlobalState + all historical listings ──────────
async function fetchPlatformStats(): Promise<{ totalVolume: number; totalPools: number; totalListings: number; totalFeeXnt: number }> {
  try {
    const conn = new Connection(RPC, 'confirmed');
    const programPk = new PublicKey(PROGRAM_ID);
    const [globalStatePda] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], programPk);

    // Read GlobalState
    const gsInfo = await conn.getAccountInfo(globalStatePda);
    let totalPools = 0;
    let totalListings = 0;
    let totalFeeXnt = 0;
    if (gsInfo?.data && gsInfo.data.length >= 8 + 32 + 32 + 8 + 8 + 8 + 8) {
      let off = 8 + 32 + 32; // skip discriminator + admin + treasury
      totalFeeXnt    = Number(gsInfo.data.readBigUInt64LE(off)); off += 8;
      totalListings  = Number(gsInfo.data.readBigUInt64LE(off)); off += 8;
      totalPools     = Number(gsInfo.data.readBigUInt64LE(off)); off += 8;
    }

    // Volume = sum of all PoolRecords (each pool usd_val * 2 = both sides contributed)
    // PoolRecord size = 8 + 274 = 282 bytes
    // usd_val offset: 8 + 32 + 32 + 32 + 32 + 12 + 12 + 2 + 8 + 8 + 8 + 8 + 32 + 32 = 260
    const poolRecords = await conn.getProgramAccounts(programPk, { filters: [{ dataSize: 282 }] });
    let totalVolume = 0;
    for (const { account } of poolRecords) {
      try {
        const seeded = account.data[281]; // seeded bool at offset 281
        if (seeded === 1) continue; // skip admin-seeded pools
        const usdVal = Number(account.data.readBigUInt64LE(258));
        totalVolume += (usdVal / 1_000_000) * 2;
      } catch {}
    }

    return { totalVolume, totalPools, totalListings, totalFeeXnt };
  } catch (e) {
    console.error('fetchPlatformStats error:', e);
    return { totalVolume: 0, totalPools: 0, totalListings: 0, totalFeeXnt: 0 };
  }
}

// ─── Fetch on-chain listings from program ─────────────────────────────────────
async function fetchOnChainListings(): Promise<ListingOnChain[]> {
  try {
    const conn = new Connection(RPC, 'confirmed');
    const programPk = new PublicKey(PROGRAM_ID);

    // Get all accounts owned by the program
    const accounts = await conn.getProgramAccounts(programPk, {
      filters: [
        { dataSize: 127 }, // ListingState: 8 discriminator + 120 data
      ],
    });

    const listings: ListingOnChain[] = [];

    for (const { pubkey, account } of accounts) {
      try {
        const data = account.data;
        // Skip discriminator (8 bytes)
        let offset = 8;

        const creator      = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
        const tokenAMint   = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
        const tokenAAmount = data.readBigUInt64LE(offset); offset += 8;
        const tokenAUsdVal = data.readBigUInt64LE(offset); offset += 8;
        const tokenAXntVal = data.readBigUInt64LE(offset); offset += 8;
        const tokenAMc     = data.readBigUInt64LE(offset); offset += 8;
        const burnBps      = data.readUInt16LE(offset); offset += 2;
        const isEcosystem  = data[offset] === 1; offset += 1;
        const statusByte   = data[offset]; offset += 1;

        const status = statusByte === 0 ? 'open'
                     : statusByte === 1 ? 'matched'
                     : 'delisted';

        if (status !== 'open') continue;

        const mintStr = tokenAMint.toBase58();
        const meta = await fetchTokenMeta(mintStr);

        // Read decimals directly from on-chain mint account (offset 44 in both SPL and Token-2022)
        // This is always correct regardless of token type or metadata availability
        let decimals = meta.decimals ?? 9;
        try {
          const mintInfo = await conn.getAccountInfo(tokenAMint);
          if (mintInfo?.data && mintInfo.data.length >= 45) {
            decimals = mintInfo.data[44];
          }
        } catch {}

        listings.push({
          id:           pubkey.toBase58(),
          creator:      creator.toBase58(),
          tokenAMint:   mintStr,
          tokenASymbol: meta.symbol,
          tokenALogo:   meta.logo,
          amount:       Number(tokenAAmount),
          amountUi:     Number(tokenAAmount) / Math.pow(10, decimals),
          usdVal:       Number(tokenAUsdVal),
          usdValUi:     Number(tokenAUsdVal) / 1_000_000,
          xntVal:       Number(tokenAXntVal),
          burnBps:      burnBps,
          isEcosystem:  isEcosystem,
          status:       status as any,
          createdAt:    Date.now(),
        });
      } catch { continue; }
    }

    return listings.sort((a, b) => b.usdValUi - a.usdValUi);
  } catch (e) {
    console.error('fetchOnChainListings error:', e);
    return [];
  }
}

// ─── Status Box ───────────────────────────────────────────────────────────────
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
    }} dangerouslySetInnerHTML={{ __html: msg }} />
  );
};

const TxLink: FC<{ sig: string; color?: string }> = ({ sig, color = "#00d4ff" }) => {
  if (!sig) return null;
  const url = `https://explorer.mainnet.x1.xyz/tx/${sig}`;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{
      display: "block", textAlign: "center", padding: "10px 14px", marginBottom: 16,
      borderRadius: 10, background: "rgba(0,212,255,.04)",
      border: `1px solid ${color}40`, textDecoration: "none",
      fontFamily: "Orbitron,monospace", fontSize: 11, fontWeight: 700,
      color, letterSpacing: 1, transition: "all .15s",
    }}>VIEW ON EXPLORER ↗</a>
  );
};

// ─── Token Logo — matches TokenComponents.tsx with CORS retry + gradient fallback
const TokenLogo: FC<{ mint: string; logo?: string; symbol: string; size?: number }> = ({
  mint, logo, symbol, size = 44,
}) => {
  const [failed,  setFailed]  = useState(false);
  const [retried, setRetried] = useState(false);
  const [src, setSrc]         = useState(logo || '');

  useEffect(() => { setSrc(logo || ''); setFailed(false); setRetried(false); }, [logo, mint]);

  const handleError = () => {
    if (!retried && src) {
      setRetried(true);
      const isLocal = typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
      if (isLocal) { setSrc(`https://corsproxy.io/?${encodeURIComponent(src)}`); return; }
    }
    setFailed(true);
  };

  const radius = size * 0.22;

  if (src && !failed) return (
    <img src={src} alt={symbol} crossOrigin="anonymous" onError={handleError}
      style={{ width: size, height: size, borderRadius: radius,
        objectFit: 'cover', flexShrink: 0, background: '#111820',
        border: '1px solid rgba(255,255,255,.08)' }} />
  );

  // Gradient fallback — same palette as TokenComponents
  const COLORS = ['#ff8c00','#ffb700','#00d4ff','#00c98d','#bf5af2'];
  const ci  = (symbol?.charCodeAt(0) ?? 65) % COLORS.length;
  const ci2 = (ci + 2) % COLORS.length;
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, flexShrink: 0,
      background: `linear-gradient(135deg,${COLORS[ci]},${COLORS[ci2]})`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Orbitron,monospace', fontSize: size * 0.38, fontWeight: 900,
      color: '#0a0e14', border: '1px solid rgba(255,255,255,.08)',
    }}>
      {(symbol ?? '?').charAt(0).toUpperCase()}
    </div>
  );
};

// ─── Listing Card ─────────────────────────────────────────────────────────────
const ListingCard: FC<{
  listing: ListingOnChain;
  isMobile: boolean;
  idx: number;
  isOwn: boolean;
  xntPrice: number;
  lbBalance: number;
  onMatch: (l: ListingOnChain) => void;
  onEdit: (l: ListingOnChain) => void;
  onDelist: (l: ListingOnChain) => void;
}> = React.memo(({ listing, isMobile, idx, isOwn, xntPrice, lbBalance, onMatch, onEdit, onDelist }) => {
  const burn     = BURN_OPTIONS.find(b => b.bps === listing.burnBps) || BURN_OPTIONS[0];
  const eachPct  = listing.burnBps < 10000 ? (10000 - listing.burnBps) / 2 / 100 : 0;
  const xntValUi = listing.xntVal / LAMPORTS_PER_SOL;

  // Fetch logo if not already loaded — uses 3-layer metadata system
  const [logo, setLogo] = useState<string | undefined>(listing.tokenALogo);
  useEffect(() => {
    if (logo) return; // already have it
    fetchTokenMeta(listing.tokenAMint).then(m => { if (m.logo) setLogo(m.logo); });
  }, [listing.tokenAMint]);

  // Calculate what the fee would be for this listing
  const xntPriceUSD6 = Math.floor((xntPrice || 0.4187) * 1_000_000);
  const matchFeeLamps = calculateFeeXnt(
    listing.isEcosystem, lbBalance, listing.usdVal, xntPriceUSD6
  );
  const { xnt: matchFeeXnt, usd: matchFeeUsd } = feeXntToDisplay(matchFeeLamps, xntPriceUSD6);

  return (
    <div style={{
      background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.06)',
      borderRadius: 14, padding: isMobile ? '14px 14px' : '18px 22px',
      marginBottom: 10, position: 'relative', overflow: 'hidden',
      animation: `fadeUp 0.4s ease ${idx * 0.04}s both`, transition: 'all 0.18s',
    }}
    onMouseEnter={e => { const d = e.currentTarget as HTMLDivElement; d.style.background = 'rgba(255,255,255,.04)'; d.style.borderColor = 'rgba(0,212,255,.18)'; }}
    onMouseLeave={e => { const d = e.currentTarget as HTMLDivElement; d.style.background = 'rgba(255,255,255,.025)'; d.style.borderColor = 'rgba(255,255,255,.06)'; }}>

      {/* Left accent */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: '3px 0 0 3px',
        background: listing.isEcosystem
          ? 'linear-gradient(180deg,#00d4ff,rgba(0,212,255,.1))'
          : 'linear-gradient(180deg,#bf5af2,rgba(191,90,242,.1))' }} />

      <div style={{ display: 'flex', gap: isMobile ? 12 : 16, alignItems: 'flex-start' }}>

        <TokenLogo mint={listing.tokenAMint} logo={logo}
          symbol={listing.tokenASymbol} size={isMobile ? 40 : 48} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Title row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 13 : 16,
              fontWeight: 900, color: '#e0f0ff', letterSpacing: .5 }}>
              {listing.tokenASymbol} / ANY TOKEN
            </span>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1,
              color: listing.isEcosystem ? '#00d4ff' : '#bf5af2',
              background: listing.isEcosystem ? 'rgba(0,212,255,.1)' : 'rgba(191,90,242,.1)',
              border: `1px solid ${listing.isEcosystem ? 'rgba(0,212,255,.3)' : 'rgba(191,90,242,.3)'}`,
              borderRadius: 5, padding: '2px 7px' }}>
              {listing.isEcosystem ? '🧠 ECOSYSTEM' : '⚡ OPEN'}
            </span>
            {listing.burnBps > 0 && (
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1,
                color: burn.color, background: `${burn.color}18`,
                border: `1px solid ${burn.color}44`, borderRadius: 5, padding: '2px 7px' }}>
                🔥 {burn.label} BURN
              </span>
            )}
          </div>

          {/* Creator */}
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 10 : 11,
            color: '#6a8aaa', marginBottom: 8 }}>
            by {truncAddr(listing.creator)}
          </div>

          {/* LP split + match fee chips */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 8 : 9,
              color: '#9abacf', background: 'rgba(255,255,255,.04)',
              border: '1px solid rgba(255,255,255,.08)', borderRadius: 6, padding: '3px 10px' }}>
              LP SPLIT {eachPct > 0 ? `${eachPct}% each` : 'None'}
            </span>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 8 : 9,
              color: lbBalance >= LB_DISCOUNT_THRESHOLD || listing.isEcosystem ? '#00c98d' : '#ff8c00',
              background: 'rgba(255,255,255,.04)',
              border: '1px solid rgba(255,255,255,.08)', borderRadius: 6, padding: '3px 10px' }}>
              MATCH FEE: {fmtXNT(matchFeeXnt)} ({fmtUSD(matchFeeUsd)})
            </span>
            {listing.burnBps > 0 && (
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 8 : 9,
                color: '#00c98d', background: 'rgba(0,201,141,.08)',
                border: '1px solid rgba(0,201,141,.2)', borderRadius: 6, padding: '3px 10px' }}>
                LB PTS ×1.888
              </span>
            )}
          </div>
        </div>

        {/* Right — amounts + actions */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontWeight: 900,
            fontSize: isMobile ? 15 : 20, letterSpacing: .5, marginBottom: 3,
            color: listing.tokenAMint === BRAINS_MINT ? '#00d4ff' : '#00c98d' }}>
            {fmtNum(listing.amountUi)} {listing.tokenASymbol}
          </div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 12 : 14,
            fontWeight: 700, color: '#00c98d', marginBottom: 2 }}>
            {fmtUSD(listing.usdValUi)}
          </div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 8 : 9,
            color: '#4a6a8a', marginBottom: 12 }}>
            {fmtXNT(xntValUi)} XNT
          </div>

          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {isOwn ? (
              <>
                <button onClick={(e) => { e.stopPropagation(); onEdit(listing); }}
                  style={{ padding: isMobile ? '6px 10px' : '7px 14px', borderRadius: 8, cursor: 'pointer',
                    background: 'rgba(0,212,255,.08)', border: '1px solid rgba(0,212,255,.25)',
                    fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight: 700, color: '#00d4ff' }}>
                  EDIT
                </button>
                <button onClick={(e) => { e.stopPropagation(); onDelist(listing); }}
                  style={{ padding: isMobile ? '6px 10px' : '7px 14px', borderRadius: 8, cursor: 'pointer',
                    background: 'rgba(255,68,68,.06)', border: '1px solid rgba(255,68,68,.2)',
                    fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight: 700, color: '#ff6666' }}>
                  DELIST
                </button>
              </>
            ) : (
              <button onClick={(e) => { e.stopPropagation(); onMatch(listing); }}
                style={{ padding: isMobile ? '8px 16px' : '10px 22px', borderRadius: 10, cursor: 'pointer',
                  background: 'linear-gradient(135deg,rgba(0,255,128,.18),rgba(0,200,100,.08))',
                  border: '1px solid rgba(0,255,128,.5)',
                  fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 9 : 11, fontWeight: 900,
                  color: '#00ff80', boxShadow: '0 0 12px rgba(0,255,128,.15)' }}>
                ⚡ MATCH
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

// ─── Create Listing Modal ──────────────────────────────────────────────────────
const CreateListingModal: FC<{
  isMobile: boolean;
  publicKey: PublicKey | null;
  connection: any;
  signTransaction: any;
  onClose: () => void;
  onCreated: () => void;
}> = ({ isMobile, publicKey, connection, signTransaction, onClose, onCreated }) => {
  const [tokenA, setTokenA]     = useState<'brains' | 'lb' | 'other'>('brains');
  const [otherMint, setOtherMint]   = useState('');
  const [otherMeta, setOtherMeta]   = useState<{symbol:string;logo?:string;decimals:number;balance:number;price:number;hasPool:boolean;checking:boolean} | null>(null);
  const [amount, setAmount]     = useState('');
  const [burnBps, setBurnBps]   = useState<0 | 2500 | 5000 | 10000>(0);
  const [status, setStatus]     = useState('');
  const [pending, setPending]   = useState(false);
  const [txSig, setTxSig] = useState("");
  const [balances, setBalances] = useState({ brains: 0, lb: 0, lbRaw: 0 });
  const [xntBal, setXntBal]     = useState(0);
  const [prices, setPrices]     = useState({ brains: 0, lb: 0, xnt: 0.4187, xnt6: 418700 });
  const [walletTokens, setWalletTokens] = useState<{mint:string;symbol:string;logo?:string;balance:number;price:number;decimals:number}[]>([]);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [walletScanned, setWalletScanned] = useState(false);

  // Load prices and balances
  useEffect(() => {
    fetchXdexPrice(BRAINS_MINT).then(p => { if (p) setPrices(v => ({ ...v, brains: p.priceUSD })); });
    fetchXdexPrice(LB_MINT).then(p => { if (p) setPrices(v => ({ ...v, lb: p.priceUSD })); });
    fetchXdexPrice(WXNT_MINT).then(p => {
      if (p) setPrices(v => ({ ...v, xnt: p.priceUSD, xnt6: p.priceUSD6 }));
    });
  }, []);

  useEffect(() => {
    if (!publicKey || !connection) return;
    (async () => {
      try {
        const bAta = getAssociatedTokenAddressSync(new PublicKey(BRAINS_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID);
        const lAta = getAssociatedTokenAddressSync(new PublicKey(LB_MINT),     publicKey, false, TOKEN_2022_PROGRAM_ID);
        const [bAcc, lAcc, xnt] = await Promise.all([
          connection.getParsedAccountInfo(bAta).catch(() => null),
          connection.getParsedAccountInfo(lAta).catch(() => null),
          connection.getBalance(publicKey).catch(() => 0),
        ]);
        const brainsUi = bAcc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        const lbUi     = lAcc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        const lbRaw    = Number(lAcc?.value?.data?.parsed?.info?.tokenAmount?.amount ?? 0);
        setBalances({ brains: brainsUi, lb: lbUi, lbRaw });
        setXntBal(xnt / LAMPORTS_PER_SOL);
      } catch {}
    })();
  }, [publicKey, connection]);

  // Derived values — handles brains, lb, and other token
  const selPrice   = tokenA === 'brains' ? prices.brains
                   : tokenA === 'lb'     ? prices.lb
                   : otherMeta?.price ?? 0;
  const selBal     = tokenA === 'brains' ? balances.brains
                   : tokenA === 'lb'     ? balances.lb
                   : otherMeta?.balance ?? 0;
  const selMint    = tokenA === 'brains' ? BRAINS_MINT
                   : tokenA === 'lb'     ? LB_MINT
                   : otherMint;
  const selDec     = tokenA === 'brains' ? 9
                   : tokenA === 'lb'     ? 2
                   : otherMeta?.decimals ?? 9;
  const selSymbol  = tokenA === 'brains' ? 'BRAINS'
                   : tokenA === 'lb'     ? 'LB'
                   : otherMeta?.symbol ?? '???';
  const amt        = parseFloat(amount) || 0;
  const usdValUi   = amt * selPrice;
  const usdVal6    = Math.floor(usdValUi * 1_000_000);
  const xntValLamp = Math.floor((usdValUi / prices.xnt) * LAMPORTS_PER_SOL) || 0;
  const isEcosystem = tokenA === 'brains' || tokenA === 'lb';
  const feeLamps   = usdVal6 > 0 ? calculateFeeXnt(isEcosystem, balances.lbRaw, usdVal6, prices.xnt6) : 0;
  const feeXntUi   = feeLamps / LAMPORTS_PER_SOL;
  const feeUsdUi   = feeXntUi * prices.xnt;
  const burnOpt    = BURN_OPTIONS.find(b => b.bps === burnBps)!;
  const eachPct    = burnBps < 10000 ? (10000 - burnBps) / 2 / 100 : 0;
  const hasLbDiscount = isEcosystem || balances.lbRaw >= LB_DISCOUNT_THRESHOLD;
  const otherReady = tokenA !== 'other' || (otherMeta?.hasPool === true && !otherMeta?.checking);
  const canSubmit  = amt > 0 && amt <= selBal && xntBal >= feeXntUi && !pending && usdVal6 >= 1_000_000 && otherReady;

  // Fetch other token data when mint address changes
  // Lazy-load wallet tokens when user selects OTHER tab
  useEffect(() => {
    if (tokenA !== 'other' || walletScanned || !publicKey || !connection) return;
    setWalletScanned(true);
    setLoadingWallet(true);
    (async () => {
      try {
        const [spl, t22] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
        ]);
        const all = [...(spl?.value ?? []), ...(t22?.value ?? [])];
        const raw: {mint:string;symbol:string;logo?:string;balance:number;price:number;decimals:number}[] = [];
        for (const acc of all) {
          const info = acc?.account?.data?.parsed?.info;
          const mint = info?.mint;
          const bal  = Number(info?.tokenAmount?.uiAmount ?? 0);
          const dec  = info?.tokenAmount?.decimals ?? 9;
          if (!mint || bal <= 0) continue;
          // Skip BRAINS, LB, WXNT — those have their own buttons
          if (mint === BRAINS_MINT || mint === LB_MINT || mint === WXNT_MINT) continue;
          raw.push({ mint, symbol: mint.slice(0,6).toUpperCase(), balance: bal, price: 0, decimals: dec });
        }
        setWalletTokens([...raw]);
        setLoadingWallet(false);

        // Enrich ALL tokens in parallel (XDEX first, fastest)
        const enriched = [...raw];
        const enrichResults = await Promise.allSettled(enriched.map(async t => ({
          mint:  t.mint,
          price: await fetchXdexPrice(t.mint).catch(() => null),
          meta:  await fetchXdexMeta(t.mint).catch(() => null),
        })));
        enrichResults.forEach((r, idx) => {
          if (r.status === 'fulfilled') {
            if (r.value.price) enriched[idx] = { ...enriched[idx], price: r.value.price.priceUSD };
            if (r.value.meta?.symbol) enriched[idx] = { ...enriched[idx], symbol: r.value.meta.symbol };
            if (r.value.meta?.logo)   enriched[idx] = { ...enriched[idx], logo: r.value.meta.logo };
          }
        });
        setWalletTokens([...enriched].sort((a, b) => (b.balance * b.price) - (a.balance * a.price)));
        // Deeper metadata for stragglers (background, non-blocking)
        const stragglers = enriched.filter(t => !t.logo || t.symbol.length <= 4);
        if (stragglers.length > 0) {
          Promise.allSettled(stragglers.map(async t => {
            const m = await fetchTokenMeta(t.mint).catch(() => null);
            if (m && (m.logo || m.symbol.length > 4)) {
              const idx = enriched.findIndex(e => e.mint === t.mint);
              if (idx >= 0) {
                enriched[idx] = { ...enriched[idx], symbol: m.symbol, logo: m.logo };
                setWalletTokens([...enriched].sort((a, b) => (b.balance * b.price) - (a.balance * a.price)));
              }
            }
          }));
        }
      } catch (e) { console.error('wallet tokens scan error', e); setLoadingWallet(false); }
    })();
  }, [tokenA, publicKey?.toBase58(), connection]);

  const checkOtherToken = useCallback(async (mint: string) => {
    if (!mint || mint.length < 32) { setOtherMeta(null); return; }
    try { new PublicKey(mint); } catch { setOtherMeta(null); return; }
    setOtherMeta(m => ({ ...(m ?? {symbol:'???',decimals:9,balance:0,price:0,hasPool:false,checking:false}), checking: true, hasPool: false }));
    try {
      // Use the full 3-layer metadata system (Token-2022 → Metaplex → XDEX)
      const [meta, priceData, poolExists] = await Promise.all([
        fetchTokenMeta(mint),
        fetchXdexPrice(mint),
        checkPoolExists(mint, WXNT_MINT),
      ]);
      let balance = 0;
      if (publicKey && connection) {
        try {
          const ata = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey, false, TOKEN_PROGRAM_ID);
          const ata2022 = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey, false, TOKEN_2022_PROGRAM_ID);
          const [a1, a2] = await Promise.all([
            connection.getParsedAccountInfo(ata).catch(() => null),
            connection.getParsedAccountInfo(ata2022).catch(() => null),
          ]);
          balance = Number(a1?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? a2?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
        } catch {}
      }
      setOtherMeta({ symbol: meta.symbol, logo: meta.logo ?? undefined, decimals: meta.decimals,
        balance, price: priceData?.priceUSD ?? 0, hasPool: poolExists, checking: false });
    } catch {
      setOtherMeta(m => ({ ...(m ?? {symbol:'???',decimals:9,balance:0,price:0,hasPool:false,checking:false}), checking: false }));
    }
  }, [publicKey, connection]);

  const handleCreate = async () => {
    if (!publicKey || !signTransaction || !canSubmit) return;
    setPending(true);
    setTxSig(''); setStatus('Fetching fresh price data…');
    try {
      // ── Fetch fresh prices ───────────────────────────────────────────────────
      const [tokenPriceData, xntPriceData] = await Promise.all([
        fetchXdexPrice(selMint),
        fetchXdexPrice(WXNT_MINT),
      ]);
      if (!tokenPriceData) throw new Error('Could not fetch token price — try again');
      if (!xntPriceData)   throw new Error('Could not fetch XNT price — try again');

      const now          = Math.floor(Date.now() / 1000);
      const usdVal6Final = Math.floor((tokenPriceData.priceUSD) * amt * 1_000_000);
      const xntVal9Final = Math.floor((tokenPriceData.priceUSD / xntPriceData.priceUSD) * amt * 1_000_000_000);
      const xntPrice6    = xntPriceData.priceUSD6 || prices.xnt6;
      const rawAmount    = Math.floor(amt * Math.pow(10, selDec));

      // Validate price freshness
      if (usdVal6Final < 1_000_000) throw new Error('Listing value too low — minimum $1.00');

      // ── Derive all PDAs ───────────────────────────────────────────────────────
      const mintPk         = new PublicKey(selMint);
      const programPk      = new PublicKey(PROGRAM_ID);
      const [globalState]  = deriveGlobalState();
      const [walletState]  = deriveWalletState(publicKey);
      const [listingPda]   = deriveListingState(publicKey, mintPk);
      const [escrowPda]    = deriveEscrow(listingPda);
      const [escrowAuth]   = deriveEscrowAuth(listingPda);

      // ── Determine token program dynamically ──────────────────────────────────
      const tokenProg = await getTokenProgram(new PublicKey(selMint), connection);

      // ── Creator token ATA ─────────────────────────────────────────────────────
      const creatorAta = getAssociatedTokenAddressSync(mintPk, publicKey, false, tokenProg);

      // ── LB ATA for discount check (passed as optional) ───────────────────────
      const lbAta = getAssociatedTokenAddressSync(
        new PublicKey(LB_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      // ── XNT vault for price cross-check — use BRAINS/XNT pool vault ──────────
      const xntPoolVault = new PublicKey('HJ5WsScycRCtp8yqGsLbcDAayMsbcYajELcALg6kaUaq');

      // ── XNT/USDC.X pool vaults for on-chain XNT price oracle (v1.1) ──────────
      const xntUsdcVaultXnt  = new PublicKey(XNT_USDC_VAULT_XNT);
      const xntUsdcVaultUsdc = new PublicKey(XNT_USDC_VAULT_USDC);

      // ── Build Anchor instruction data ─────────────────────────────────────────
      // Discriminator for create_listing = first 8 bytes of sha256("global:create_listing")
      const msgBytes = new TextEncoder().encode('global:create_listing');
      const hashBuf  = await window.crypto.subtle.digest('SHA-256', msgBytes);
      const disc     = Buffer.from(new Uint8Array(hashBuf).slice(0, 8));

      // Encode CreateListingParams — must match program struct layout exactly
      // token_a_amount:   u64  (8 bytes LE)
      // token_a_usd_val:  u64  (8 bytes LE)
      // token_a_xnt_val:  u64  (8 bytes LE)
      // token_a_mc:       u64  (8 bytes LE) — use 0 for now
      // burn_bps:         u16  (2 bytes LE)
      // xnt_price_usd:    u64  (8 bytes LE)
      // price_timestamp:  i64  (8 bytes LE)
      // price_impact_bps: u64  (8 bytes LE) — use 0 (no swap quote)
      const params = Buffer.alloc(8 + 8 + 8 + 8 + 2 + 8 + 8 + 8);
      let off = 0;
      params.writeBigUInt64LE(BigInt(rawAmount),    off); off += 8;
      params.writeBigUInt64LE(BigInt(usdVal6Final), off); off += 8;
      params.writeBigUInt64LE(BigInt(xntVal9Final), off); off += 8;
      params.writeBigUInt64LE(BigInt(0),            off); off += 8; // token_a_mc
      params.writeUInt16LE(burnBps,                 off); off += 2;
      params.writeBigUInt64LE(BigInt(xntPrice6),    off); off += 8;
      params.writeBigInt64LE(BigInt(now),            off); off += 8;
      params.writeBigUInt64LE(BigInt(0),             off);          // price_impact_bps

      const ixData = Buffer.concat([disc, params]);

      // ── Account metas — must match CreateListing accounts in program ──────────
      const { TransactionInstruction, Transaction, SystemProgram: SP } = await import('@solana/web3.js');
      const { ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

      const keys = [
        { pubkey: publicKey,                          isSigner: true,  isWritable: true  }, // creator
        { pubkey: globalState,                        isSigner: false, isWritable: true  }, // global_state
        { pubkey: walletState,                        isSigner: false, isWritable: true  }, // wallet_state
        { pubkey: mintPk,                             isSigner: false, isWritable: false }, // token_a_mint
        { pubkey: creatorAta,                         isSigner: false, isWritable: true  }, // creator_token_a
        { pubkey: listingPda,                         isSigner: false, isWritable: true  }, // listing_state
        { pubkey: escrowPda,                          isSigner: false, isWritable: true  }, // escrow
        { pubkey: escrowAuth,                         isSigner: false, isWritable: false }, // escrow_authority
        { pubkey: new PublicKey(TREASURY),            isSigner: false, isWritable: true  }, // treasury
        { pubkey: lbAta,                              isSigner: false, isWritable: false }, // creator_lb_account (optional)
        { pubkey: xntPoolVault,                       isSigner: false, isWritable: false }, // token_a_xnt_pool_vault
        { pubkey: xntUsdcVaultXnt,                    isSigner: false, isWritable: false }, // xnt_usdc_pool_xnt_vault (v1.1)
        { pubkey: xntUsdcVaultUsdc,                   isSigner: false, isWritable: false }, // xnt_usdc_pool_usdc_vault (v1.1)
        { pubkey: tokenProg,                          isSigner: false, isWritable: false }, // token_program
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false }, // associated_token_program
        { pubkey: SP.programId,                       isSigner: false, isWritable: false }, // system_program
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false }, // rent
      ];

      const ix = new TransactionInstruction({ programId: programPk, keys, data: ixData });

      setStatus('Waiting for wallet approval…');

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      tx.add(ix);

      const signed = await signTransaction(tx);
      setStatus('Submitting transaction…');

      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setStatus('Confirming…');

      // Wait for confirmation
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1200));
        const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const conf   = status?.value?.confirmationStatus;
        const err    = status?.value?.err;
        if (err) throw new Error(`TX failed: ${JSON.stringify(err)}`);
        if (conf === 'confirmed' || conf === 'finalized') {
          setTxSig(sig); setStatus(`✅ Listing created! ${fmtNum(amt)} ${selSymbol} listed · ${fmtUSD(usdValUi)} · Fee paid: ${feeXntUi.toFixed(4)} XNT\n\nTx: ${sig.slice(0,20)}…`);
          setTimeout(() => { onCreated(); onClose(); }, 3000);
          return;
        }
      }
      throw new Error('Confirmation timeout — check explorer for tx: ' + sig.slice(0,20));
    } catch (e: any) { console.error('MATCH ERROR:', e);
      const msg = e?.message || String(e);
      setStatus(`❌ ${msg.slice(0, 200)}`);
    } finally { setPending(false); }
  };

  useEffect(() => {
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`; } catch {}
    return () => { try { document.body.style.position = ''; document.body.style.top = ''; window.scrollTo(0, sy); } catch {} };
  }, []);

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center',
      justifyContent: 'center', padding: isMobile ? 0 : '16px' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: isMobile ? '100%' : 520,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(0,212,255,.2)',
        borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '18px 14px 24px' : '22px 24px',
        animation: 'modal-in .22s cubic-bezier(.22,1,.36,1) both',
        maxHeight: isMobile ? '88vh' : 'calc(100vh - 32px)', overflowY: 'auto', position: 'relative',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16,
          width: 30, height: 30, borderRadius: '50%', border: '1px solid rgba(0,212,255,.2)',
          background: 'rgba(8,12,15,.9)', cursor: 'pointer', color: '#00d4ff', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 15 : 18,
          fontWeight: 900, color: '#fff', letterSpacing: 1, marginBottom: 4 }}>⚡ CREATE LISTING</div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 11 : 12,
          color: '#6a8aaa', marginBottom: 8, lineHeight: 1.6 }}>
          Program: <span style={{ color: '#3a5a7a', fontSize: 10 }}>{PROGRAM_ID.slice(0,8)}…</span>
        </div>

        {/* LB discount badge */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, marginBottom: 12,
          color: hasLbDiscount ? '#00c98d' : '#ff8c00',
          background: hasLbDiscount ? 'rgba(0,201,141,.08)' : 'rgba(255,140,0,.08)',
          border: `1px solid ${hasLbDiscount ? 'rgba(0,201,141,.25)' : 'rgba(255,140,0,.25)'}`,
          borderRadius: 8, padding: '6px 12px', display: 'inline-block' }}>
          {hasLbDiscount
            ? (isEcosystem ? '✓ 0.888% FEE RATE (ecosystem token)' : '✓ 0.888% FEE RATE (33+ LB held)')
            : `1.888% FEE RATE · Hold 33 LB for 0.888% discount (you have ${(balances.lbRaw / 100).toFixed(2)} LB)`}
        </div>

        {/* Token selector */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 10 }}>
          SELECT TOKEN TO LIST
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
          {[
            { key: 'brains', label: 'BRAINS', bal: balances.brains, price: prices.brains, color: '#00d4ff' },
            { key: 'lb',     label: 'LB',     bal: balances.lb,     price: prices.lb,     color: '#00c98d' },
            { key: 'other',  label: 'OTHER',  bal: otherMeta?.balance ?? 0, price: otherMeta?.price ?? 0, color: '#bf5af2' },
          ].map(t => (
            <button key={t.key} onClick={() => { setTokenA(t.key as any); setAmount(''); }}
              style={{ padding: '10px 8px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                background: tokenA === t.key ? `${t.color}18` : 'rgba(255,255,255,.03)',
                border: `1px solid ${tokenA === t.key ? t.color + '55' : 'rgba(255,255,255,.08)'}` }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
                color: tokenA === t.key ? t.color : '#8aa0b8', marginBottom: 4 }}>{t.label}</div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#4a6a8a' }}>
                {t.key === 'other' ? (otherMeta ? otherMeta.symbol : 'any token') : `BAL: ${fmtNum(t.bal)}`}
              </div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#4a6a8a', marginTop: 2 }}>
                {t.key === 'other' ? 'needs XNT pool' : fmtUSD(t.price)}
              </div>
            </button>
          ))}
        </div>

        {/* Other token mint input */}
        {tokenA === 'other' && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 8 }}>
              SELECT FROM YOUR WALLET
            </div>
            {loadingWallet ? (
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#4a6a8a',
                marginBottom: 12, padding: '10px 0' }}>
                Loading your tokens…
              </div>
            ) : walletTokens.length === 0 ? (
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa',
                marginBottom: 12, padding: '10px 14px',
                background: 'rgba(255,255,255,.03)', borderRadius: 8,
                border: '1px solid rgba(255,255,255,.06)' }}>
                No other tokens found in your wallet. You can paste a mint address below.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12,
                maxHeight: 220, overflowY: 'auto' }}>
                {walletTokens.map(t => {
                  const usdVal = t.balance * t.price;
                  const isSelected = otherMint === t.mint;
                  return (
                    <button key={t.mint} onClick={() => {
                      setOtherMint(t.mint);
                      checkOtherToken(t.mint);
                    }}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                        borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                        background: isSelected ? 'rgba(191,90,242,.1)' : 'rgba(255,255,255,.03)',
                        border: `1px solid ${isSelected ? 'rgba(191,90,242,.4)' : 'rgba(255,255,255,.07)'}`,
                        transition: 'all 0.15s' }}>
                      <TokenLogo mint={t.mint} logo={t.logo} symbol={t.symbol} size={32} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
                          color: isSelected ? '#bf5af2' : '#e0f0ff' }}>{t.symbol}</div>
                        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#6a8aaa' }}>
                          {fmtNum(t.balance)} · {t.price > 0 ? `${fmtUSD(t.price)}/token` : 'no price'}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700,
                          color: usdVal > 0 ? '#00c98d' : '#4a6a8a' }}>
                          {usdVal > 0 ? fmtUSD(usdVal) : '—'}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 8 }}>
              OR PASTE TOKEN MINT ADDRESS
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={otherMint} onChange={e => setOtherMint(e.target.value)}
                placeholder="Token mint address…"
                style={{ flex: 1, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(191,90,242,.3)',
                  borderRadius: 10, padding: '10px 14px', outline: 'none', color: '#e0f0ff',
                  fontFamily: 'Sora,sans-serif', fontSize: 12 }} />
              <button onClick={() => checkOtherToken(otherMint)}
                style={{ padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
                  background: 'rgba(191,90,242,.12)', border: '1px solid rgba(191,90,242,.35)',
                  fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: '#bf5af2' }}>
                CHECK
              </button>
            </div>
            {otherMeta && (
              <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 10,
                background: otherMeta.hasPool ? 'rgba(0,201,141,.06)' : 'rgba(255,68,68,.06)',
                border: `1px solid ${otherMeta.hasPool ? 'rgba(0,201,141,.25)' : 'rgba(255,68,68,.25)'}` }}>
                {otherMeta.checking ? (
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a' }}>Checking pool…</div>
                ) : otherMeta.hasPool ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 900, color: '#00c98d' }}>
                        ✓ {otherMeta.symbol}
                      </div>
                      <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#6a8aaa', marginTop: 3 }}>
                        XNT pool verified · {fmtUSD(otherMeta.price)} · BAL: {fmtNum(otherMeta.balance)}
                      </div>
                    </div>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#00c98d',
                      background: 'rgba(0,201,141,.1)', border: '1px solid rgba(0,201,141,.3)',
                      borderRadius: 6, padding: '4px 10px' }}>ELIGIBLE</div>
                  </div>
                ) : (
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#ff6666' }}>
                    ✗ No XNT pool found on XDEX — create one first
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Amount input */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 10 }}>
          AMOUNT TO LIST
        </div>
        <div style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(0,212,255,.18)',
          borderRadius: 12, padding: '14px 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TokenLogo mint={selMint} symbol={selSymbol} size={32} />
            <input value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" placeholder="0"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontFamily: 'Orbitron,monospace', fontSize: 24, fontWeight: 900, color: '#fff' }} />
            <button onClick={() => setAmount(String(Math.floor(selBal)))}
              style={{ background: 'rgba(0,212,255,.1)', border: '1px solid rgba(0,212,255,.25)',
                borderRadius: 7, padding: '5px 12px', cursor: 'pointer',
                fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: '#00d4ff' }}>MAX</button>
          </div>
          {amt > 0 && (
            <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, color: '#00c98d' }}>{fmtUSD(usdValUi)}</span>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, color: '#4a6a8a' }}>
                {(xntValLamp / LAMPORTS_PER_SOL).toFixed(2)} XNT
              </span>
            </div>
          )}
        </div>

        {/* Burn % */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 10 }}>
          LP TOKEN BURN % (BPS sent to program)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
          {BURN_OPTIONS.map(b => (
            <button key={b.bps} onClick={() => setBurnBps(b.bps as any)}
              style={{ padding: '12px 0', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                background: burnBps === b.bps ? `${b.color}18` : 'rgba(255,255,255,.03)',
                border: `1px solid ${burnBps === b.bps ? b.color + '66' : 'rgba(255,255,255,.08)'}` }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900,
                color: burnBps === b.bps ? b.color : '#8aa0b8' }}>{b.label}</div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#4a6a8a', marginTop: 3 }}>
                {b.pct < 100 ? `${eachPct}% ea` : 'max pts'}
              </div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 6, color: '#3a5a7a', marginTop: 1 }}>
                bps={b.bps}
              </div>
            </button>
          ))}
        </div>
        <div style={{ background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.06)',
          borderRadius: 8, padding: '10px 14px', marginBottom: 22,
          fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', lineHeight: 1.6 }}>
          {burnOpt.desc}
        </div>

        {/* Fee breakdown — shows exact program calculation */}
        <div style={{ background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.06)',
          borderRadius: 10, padding: '14px 16px', marginBottom: 18 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a',
            letterSpacing: 1, marginBottom: 12 }}>FEE SUMMARY</div>
          {[
            { label: 'LISTING VALUE',
              val: `${fmtUSD(usdValUi)}`,
              sub: `${usdVal6.toLocaleString()} (6 dec)`, color: '#8aa0b8' },
            { label: `FEE RATE (${hasLbDiscount ? '0.888' : '1.888'}% · BPS=${hasLbDiscount ? FEE_BPS_ECOSYSTEM : FEE_BPS_STANDARD})`,
              val: feeXntUi > 0 ? `${feeXntUi.toFixed(6)} XNT` : '—',
              sub: feeUsdUi > 0 ? fmtUSD(feeUsdUi) : '', color: '#ff8c00' },
            { label: 'MINIMUM FLOOR',
              val: `${(FEE_MINIMUM_XNT / LAMPORTS_PER_SOL).toFixed(3)} XNT`,
              sub: 'min floor', color: '#4a6a8a' },
            { label: 'YOU PAY',
              val: feeLamps > 0 ? `${(feeLamps / LAMPORTS_PER_SOL).toFixed(6)} XNT` : '—',
              sub: feeLamps > 0 ? `${feeLamps.toLocaleString()} lamports` : '',
              color: xntBal >= feeXntUi ? '#00c98d' : '#ff4444' },
            { label: 'YOUR XNT BALANCE',
              val: `${xntBal.toFixed(4)} XNT`,
              sub: '', color: xntBal >= feeXntUi ? '#00c98d' : '#ff4444' },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between',
              alignItems: 'flex-start', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,.04)' }}>
              <div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#4a6a8a', letterSpacing: .5 }}>
                  {row.label}
                </div>
                {row.sub && <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#2a4a5a', marginTop: 1 }}>
                  {row.sub}
                </div>}
              </div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700,
                color: row.color, textAlign: 'right' }}>{row.val}</div>
            </div>
          ))}
        </div>

        <StatusBox msg={status} />
        <TxLink sig={txSig} color="#00d4ff" />

        <button onClick={handleCreate} disabled={!canSubmit}
          style={{ width: '100%', padding: '15px 0', borderRadius: 12,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            background: canSubmit
              ? 'linear-gradient(135deg,rgba(0,212,255,.2),rgba(0,212,255,.08))'
              : 'rgba(255,255,255,.04)',
            border: `1px solid ${canSubmit ? 'rgba(0,212,255,.5)' : 'rgba(255,255,255,.08)'}`,
            fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
            color: canSubmit ? '#00d4ff' : '#4a6a8a',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          {pending
            ? <><div style={{ width: 14, height: 14, borderRadius: '50%',
                border: '2px solid rgba(0,212,255,.2)', borderTop: '2px solid #00d4ff',
                animation: 'spin .8s linear infinite' }} />CREATING…</>
            : `⚡ LIST ${fmtNum(amt)} ${selSymbol} · PAY ${feeXntUi.toFixed(4)} XNT`}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ─── Match Modal ──────────────────────────────────────────────────────────────
const MatchModal: FC<{
  listing: ListingOnChain;
  isMobile: boolean;
  publicKey: PublicKey;
  connection: any;
  signTransaction: any;
  onClose: () => void;
  onMatched: () => void;
}> = ({ listing, isMobile, publicKey, connection, signTransaction, onClose, onMatched }) => {
  const [tokenBMint, setTokenBMint] = useState('');
  const [tokenBMeta, setTokenBMeta] = useState<{symbol:string;logo?:string;decimals:number;balance:number;price:number;hasPool:boolean;checking:boolean} | null>(null);
  const [amount, setAmount]         = useState('');
  const [status, setStatus]         = useState('');
  const [pending, setPending]       = useState(false);
  const [txSig, setTxSig] = useState("");
  const [xntPrice, setXntPrice]     = useState(0.4187);
  const [lbRaw, setLbRaw]           = useState(0);
  // Wallet token list — auto-populated from on-chain
  const [walletTokens, setWalletTokens] = useState<{mint:string;symbol:string;logo?:string;balance:number;price:number;decimals:number}[]>([]);
  const [loadingWallet, setLoadingWallet] = useState(true);

  useEffect(() => {
    fetchXdexPrice(WXNT_MINT).then(p => { if (p) setXntPrice(p.priceUSD); });
    if (!publicKey || !connection) return;
    // Fetch LB balance for fee discount
    connection.getParsedAccountInfo(
      getAssociatedTokenAddressSync(new PublicKey(LB_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID)
    ).then((a: any) => setLbRaw(Number(a?.value?.data?.parsed?.info?.tokenAmount?.amount ?? 0))).catch(() => {});

    // Fetch all wallet token accounts
    (async () => {
      setLoadingWallet(true);
      try {
        // Get all token accounts (both programs)
        const [spl, t22] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
        ]);
        const all = [...(spl?.value ?? []), ...(t22?.value ?? [])];
        // Step 1 — collect all tokens instantly, render immediately
        const raw: {mint:string;symbol:string;logo?:string;balance:number;price:number;decimals:number}[] = [];
        for (const acc of all) {
          const info = acc?.account?.data?.parsed?.info;
          const mint = info?.mint;
          const bal  = Number(info?.tokenAmount?.uiAmount ?? 0);
          const dec  = info?.tokenAmount?.decimals ?? 9;
          if (!mint || bal <= 0) continue;
          if (mint === listing.tokenAMint) continue;
          if (mint === WXNT_MINT) continue;
          raw.push({ mint, symbol: mint.slice(0,6).toUpperCase(), balance: bal, price: 0, decimals: dec });
        }
        setWalletTokens([...raw]);
        setLoadingWallet(false);

        // Step 2 — enrich ALL tokens in parallel (XDEX first, fastest)
        const enriched = [...raw];
        const results = await Promise.allSettled(enriched.map(async t => ({
          mint:  t.mint,
          price: await fetchXdexPrice(t.mint).catch(() => null),
          meta:  await fetchXdexMeta(t.mint).catch(() => null),
        })));
        results.forEach((r, idx) => {
          if (r.status === 'fulfilled') {
            if (r.value.price) enriched[idx] = { ...enriched[idx], price: r.value.price.priceUSD };
            if (r.value.meta?.symbol) enriched[idx] = { ...enriched[idx], symbol: r.value.meta.symbol };
            if (r.value.meta?.logo)   enriched[idx] = { ...enriched[idx], logo: r.value.meta.logo };
          }
        });
        setWalletTokens([...enriched].sort((a, b) => (b.balance * b.price) - (a.balance * a.price)));

        // Step 3 — deeper metadata only for tokens XDEX didn't resolve (background, non-blocking)
        const stragglers = enriched.filter(t => !t.logo || t.symbol.length <= 4);
        if (stragglers.length > 0) {
          Promise.allSettled(stragglers.map(async t => {
            const m = await fetchTokenMeta(t.mint).catch(() => null);
            if (m && (m.logo || m.symbol.length > 4)) {
              const idx = enriched.findIndex(e => e.mint === t.mint);
              if (idx >= 0) {
                enriched[idx] = { ...enriched[idx], symbol: m.symbol, logo: m.logo };
                setWalletTokens([...enriched].sort((a, b) => (b.balance * b.price) - (a.balance * a.price)));
              }
            }
          }));
        }
      } catch (e) { console.error('wallet tokens fetch error', e); setLoadingWallet(false); }
      // finally block removed — setLoadingWallet called in step 1 now
    })();
  }, [publicKey?.toBase58()]);

  useEffect(() => {
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`; } catch {}
    return () => { try { document.body.style.position = ''; document.body.style.top = ''; window.scrollTo(0, sy); } catch {} };
  }, []);

  const checkTokenB = async (mint: string) => {
    if (!mint || mint.length < 32) { setTokenBMeta(null); return; }
    try { new PublicKey(mint); } catch { setTokenBMeta(null); return; }
    setTokenBMeta(m => ({ ...(m ?? {symbol:'???',decimals:9,balance:0,price:0,hasPool:false,checking:false}), checking: true }));
    try {
      const [meta, priceData, poolExists] = await Promise.all([
        fetchTokenMeta(mint),
        fetchXdexPrice(mint),
        checkPoolExists(mint, WXNT_MINT),
      ]);
      let balance = 0;
      if (publicKey && connection) {
        try {
          const [a1, a2] = await Promise.all([
            connection.getParsedAccountInfo(getAssociatedTokenAddressSync(new PublicKey(mint), publicKey, false, TOKEN_PROGRAM_ID)).catch(() => null),
            connection.getParsedAccountInfo(getAssociatedTokenAddressSync(new PublicKey(mint), publicKey, false, TOKEN_2022_PROGRAM_ID)).catch(() => null),
          ]);
          balance = Number(a1?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? a2?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
        } catch {}
      }
      setTokenBMeta({ symbol: meta.symbol, logo: meta.logo, decimals: meta.decimals, balance, price: priceData?.priceUSD ?? 0, hasPool: poolExists, checking: false });
    } catch { setTokenBMeta(m => ({ ...(m ?? {symbol:'???',decimals:9,balance:0,price:0,hasPool:false,checking:false}), checking: false })); }
  };

  const amt        = parseFloat(amount) || 0;
  const xntPrice6  = Math.floor(xntPrice * 1_000_000);
  const usdValB    = amt * (tokenBMeta?.price ?? 0);
  const usdValA    = listing.usdValUi;
  const diff       = Math.abs(usdValA - usdValB);
  const tolerance  = usdValA * 0.0005;
  const priceMatch = usdValB > 0 && diff <= tolerance;
  const isEcoB     = tokenBMint === BRAINS_MINT || tokenBMint === LB_MINT;
  const matchFee   = xntPrice6 > 0 && usdValB > 0
    ? calculateFeeXnt(isEcoB, lbRaw, Math.floor(usdValB * 1_000_000), xntPrice6)
    : 0;
  const matchFeeXnt = matchFee / LAMPORTS_PER_SOL;
  const canMatch   = !!tokenBMeta?.hasPool && !tokenBMeta?.checking && amt > 0 && amt <= (tokenBMeta?.balance ?? 0) && priceMatch && !pending;

  const handleMatch = async () => {
    setPending(true);
    setTxSig('');
    try {
      // ── Step 1: Fetch fresh prices ────────────────────────────────────────────
      setStatus('Fetching fresh prices…');
      const [tokenBPrice, xntP] = await Promise.all([
        fetchXdexPrice(tokenBMint),
        fetchXdexPrice(WXNT_MINT),
      ]);
      if (!tokenBPrice) throw new Error('Could not fetch Token B price — try again');

      const now      = Math.floor(Date.now() / 1000);
      const usdValB6 = Math.floor(tokenBPrice.priceUSD * amt * 1_000_000);
      const xntP6    = xntP?.priceUSD6 ?? xntPrice6;
      const rawAmtB  = Math.floor(amt * Math.pow(10, tokenBMeta!.decimals));

      // ── Step 2: Derive all PDAs and keys ─────────────────────────────────────
      setStatus('Deriving accounts…');
      const { TransactionInstruction, Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
      const { ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

      const programPk     = new PublicKey(PROGRAM_ID);
      const listingPk     = new PublicKey(listing.id);
      const creatorPk     = new PublicKey(listing.creator);
      const mintAPk       = new PublicKey(listing.tokenAMint);
      const mintBPk       = new PublicKey(tokenBMint);
      const ammCfgPk      = new PublicKey(XDEX_AMM_CONFIG_A);
      const treasuryPk    = new PublicKey(TREASURY);
      const incineratorPk = new PublicKey(INCINERATOR);
      const xntUsdcVaultXntPk  = new PublicKey(XNT_USDC_VAULT_XNT);
      const xntUsdcVaultUsdcPk = new PublicKey(XNT_USDC_VAULT_USDC);
      const slotHashesPk       = new PublicKey(SLOT_HASHES_SYSVAR);
      const feeVaultPk         = new PublicKey(XDEX_FEE_VAULT);

      const [globalState]    = deriveGlobalState();
      const [matcherWS]      = deriveWalletState(publicKey);
      const [escrowPda]      = deriveEscrow(listingPk);
      const [escrowAuth]     = deriveEscrowAuth(listingPk);
      const [matchIntentPda] = deriveMatchIntent(publicKey, listingPk);

      const tokenProgA = await getTokenProgram(new PublicKey(listing.tokenAMint), connection);
      const tokenProgB = await getTokenProgram(new PublicKey(tokenBMint), connection);

      // Token sort — Raydium rule: token0 < token1 as 32-byte arrays
      const { token0, token1, tokenAIsToken0 } = sortTokenMints(mintAPk, mintBPk);

      // XDEX PDAs
      const [poolState]  = deriveXdexPoolState(ammCfgPk, token0, token1);
      const [lpMint]     = deriveXdexLpMint(poolState);
      const [poolVault0] = deriveXdexPoolVault(poolState, token0);
      const [poolVault1] = deriveXdexPoolVault(poolState, token1);
      const [observation]= deriveXdexObservation(poolState);
      const [poolRecord] = derivePoolRecord(poolState);

      // ATAs
      const matcherAtaA      = getAssociatedTokenAddressSync(mintAPk,                       publicKey,    false, tokenProgA);
      const matcherAtaB      = getAssociatedTokenAddressSync(mintBPk,                       publicKey,    false, tokenProgB);
      const matcherLpAta     = getAssociatedTokenAddressSync(lpMint,                        publicKey,    false, TOKEN_PROGRAM_ID);
      const creatorLpAta     = getAssociatedTokenAddressSync(lpMint,                        creatorPk,    true,  TOKEN_PROGRAM_ID);
      const treasuryLpAta    = getAssociatedTokenAddressSync(lpMint,                        treasuryPk,   true,  TOKEN_PROGRAM_ID);
      const incineratorLpAta = getAssociatedTokenAddressSync(lpMint,                        incineratorPk,true,  TOKEN_PROGRAM_ID);
      const lbAta            = getAssociatedTokenAddressSync(new PublicKey(LB_MINT),        publicKey,    false, TOKEN_2022_PROGRAM_ID);

      // ── Step 3: Fetch token B / XNT pool vault for TVL check (remaining[1]) ──
      // The program requires: [0] = pool account (existence check), [1] = XNT vault (TVL check).
      // We query XDEX for the token B / XNT pool to get the actual vault address.
      setStatus('Fetching token B pool info…');
      let tokenBPoolPk: PublicKey;
      let tokenBXntVaultPk: PublicKey;
      try {
        const [r1, r2] = await Promise.allSettled([
          fetch(`${XDEX_BASE}/xendex/pool/tokens/${tokenBMint}/${WXNT_MINT}?network=mainnet`, { signal: AbortSignal.timeout(6000) }).then(r => r.json()),
          fetch(`${XDEX_BASE}/xendex/pool/tokens/${WXNT_MINT}/${tokenBMint}?network=mainnet`, { signal: AbortSignal.timeout(6000) }).then(r => r.json()),
        ]);
        const poolData = (r1.status === 'fulfilled' && r1.value?.data?.pool_address)  ? r1.value.data
                       : (r2.status === 'fulfilled' && r2.value?.data?.pool_address)  ? r2.value.data
                       : null;
        if (!poolData?.pool_address) throw new Error('Could not find token B / XNT pool on XDEX');
        tokenBPoolPk     = new PublicKey(poolData.pool_address);
        // vault_b is the XNT side. Try both orderings.
        const vaultKey = poolData.pool_info?.token0Vault;
        if (!vaultKey) throw new Error('Could not determine XNT vault for token B pool');
        tokenBXntVaultPk = new PublicKey(vaultKey);
      } catch (e: any) { console.error('MATCH ERROR:', e);
        throw new Error('Failed to fetch token B pool: ' + e.message);
      }

      // ── Step 4: Discriminators — use exact bytes from IDL (not SHA-256 at runtime) ──
      // prepare_match discriminator from IDL: [155, 212, 68, 250, 187, 28, 60, 254]
      // execute_match discriminator from IDL: [76, 47, 91, 223, 20, 10, 147, 232]
      const discPrep = Buffer.from([155, 212, 68, 250, 187, 28, 60, 254]);
      const discExec = Buffer.from([76, 47, 91, 223, 20, 10, 147, 232]);

      // ── Step 5: Build prepare_match instruction ───────────────────────────────
      // PrepareMatchParams (IDL field order — verified against brains_pairing.json):
      //   token_b_amount:    u64   8 bytes LE
      //   token_b_usd_val:   u64   8 bytes LE
      //   xnt_price_usd:     u64   8 bytes LE
      //   price_timestamp:   i64   8 bytes LE
      //   price_impact_bps:  u64   8 bytes LE
      //   open_time:         u64   8 bytes LE
      //   amm_config:        Pubkey 32 bytes
      //   commit_nonce:      Option<[u8;32]> — None = 0x00
      //   token_a_is_token0: bool  1 byte
      // NOTE: NO token_b_xnt_val field — that was a phantom from the old handoff.
      const prepParams = Buffer.alloc(8+8+8+8+8+8+32+1+1);
      let off = 0;
      prepParams.writeBigUInt64LE(BigInt(rawAmtB),  off); off += 8; // token_b_amount
      prepParams.writeBigUInt64LE(BigInt(usdValB6), off); off += 8; // token_b_usd_val
      prepParams.writeBigUInt64LE(BigInt(xntP6),    off); off += 8; // xnt_price_usd
      prepParams.writeBigInt64LE(BigInt(now),        off); off += 8; // price_timestamp
      prepParams.writeBigUInt64LE(BigInt(0),         off); off += 8; // price_impact_bps
      prepParams.writeBigUInt64LE(BigInt(0),         off); off += 8; // open_time = immediate
      ammCfgPk.toBuffer().copy(prepParams, off);           off += 32; // amm_config
      prepParams[off] = 0;                                 off += 1;  // commit_nonce = None
      prepParams[off] = tokenAIsToken0 ? 1 : 0;                      // token_a_is_token0
      const prepIxData = Buffer.concat([discPrep, prepParams]);

      // prepare_match named accounts (IDL order — verified):
      //   matcher, global_state, listing_state, token_a_mint, token_b_mint,
      //   match_intent, match_commitment (optional — omit), system_program
      //
      // Remaining accounts (from Rust source PR_* constants):
      //   [0] token_b_xnt_pool           — must have data (existence check)
      //   [1] token_b_xnt_pool_vault     — XNT vault for TVL check
      //   [2] xnt_usdc_pool_xnt_vault    — hardcoded oracle XNT_USDC_VAULT_XNT
      //   [3] xnt_usdc_pool_usdc_vault   — hardcoded oracle XNT_USDC_VAULT_USDC
      //   [4] slot_hashes sysvar
      //   [5] matcher_lb_account         — LB ATA (or program_id sentinel if no LB)
      const prepKeys = [
        { pubkey: publicKey,                  isSigner: true,  isWritable: true  }, // matcher
        { pubkey: globalState,                isSigner: false, isWritable: true  }, // global_state
        { pubkey: listingPk,                  isSigner: false, isWritable: false }, // listing_state (not mut in prepare)
        { pubkey: mintAPk,                    isSigner: false, isWritable: false }, // token_a_mint
        { pubkey: mintBPk,                    isSigner: false, isWritable: false }, // token_b_mint
        { pubkey: matchIntentPda,             isSigner: false, isWritable: true  }, // match_intent (init)
        { pubkey: programPk, isSigner: false, isWritable: false }, // match_commitment (optional — pass program_id as sentinel)
        { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false }, // system_program
        // Remaining:
        { pubkey: tokenBPoolPk,               isSigner: false, isWritable: false }, // [0] token_b_xnt_pool
        { pubkey: tokenBXntVaultPk,           isSigner: false, isWritable: false }, // [1] token_b_xnt_pool_vault
        { pubkey: xntUsdcVaultXntPk,          isSigner: false, isWritable: false }, // [2] xnt_usdc_pool_xnt_vault
        { pubkey: xntUsdcVaultUsdcPk,         isSigner: false, isWritable: false }, // [3] xnt_usdc_pool_usdc_vault
        { pubkey: slotHashesPk,               isSigner: false, isWritable: false }, // [4] slot_hashes
        { pubkey: lbAta,                      isSigner: false, isWritable: false }, // [5] matcher_lb_account
      ];

      const prepIx = new TransactionInstruction({ programId: programPk, keys: prepKeys, data: prepIxData });

      // ── Step 6: Build execute_match instruction ───────────────────────────────
      // ExecuteMatchParams (IDL): just _reserved: u8 = 0x00
      const execIxData = Buffer.concat([discExec, Buffer.from([0x00])]);

      // execute_match named accounts (IDL order — verified):
      //   matcher, global_state, matcher_wallet_state, listing_state, listing_creator,
      //   escrow, escrow_authority, token_a_mint, matcher_token_a, token_b_mint,
      //   matcher_token_b, match_intent, pool_record, pool_record_pool_key,
      //   token_a_program, token_b_program, token_program, associated_token_program,
      //   system_program, rent
      //
      // Remaining accounts (from Rust source EX_* constants):
      //   [0]  new_pool_state    — writable, new
      //   [1]  lp_mint           — writable, new
      //   [2]  new_pool_vault_0  — writable, new
      //   [3]  new_pool_vault_1  — writable, new
      //   [4]  observation_state — writable, new
      //   [5]  matcher_lp_token  — writable (XDEX creates this ATA)
      //   [6]  creator_lp_ata    — writable
      //   [7]  treasury_lp_ata   — writable
      //   [8]  incinerator_lp_ata— writable
      //   [9]  treasury          — writable (receives XNT fee + LP ATA owner)
      //   [10] incinerator        — writable (LP ATA owner)
      //   [11] xdex_program
      //   [12] amm_config
      //   [13] xdex_lp_auth
      //   [14] create_pool_fee   — writable (XDEX fee vault)
      //   [15] token_a_mint      — readonly (for raw decimals read in handler)
      //   [16] token_b_mint      — readonly
      const execKeys = [
        { pubkey: publicKey,                    isSigner: true,  isWritable: true  }, // matcher
        { pubkey: globalState,                  isSigner: false, isWritable: true  }, // global_state
        { pubkey: matcherWS,                    isSigner: false, isWritable: true  }, // matcher_wallet_state
        { pubkey: listingPk,                    isSigner: false, isWritable: true  }, // listing_state
        { pubkey: creatorPk,                    isSigner: false, isWritable: true  }, // listing_creator
        { pubkey: escrowPda,                    isSigner: false, isWritable: true  }, // escrow
        { pubkey: escrowAuth,                   isSigner: false, isWritable: false }, // escrow_authority
        { pubkey: mintAPk,                      isSigner: false, isWritable: false }, // token_a_mint
        { pubkey: matcherAtaA,                  isSigner: false, isWritable: true  }, // matcher_token_a
        { pubkey: mintBPk,                      isSigner: false, isWritable: false }, // token_b_mint
        { pubkey: matcherAtaB,                  isSigner: false, isWritable: true  }, // matcher_token_b
        { pubkey: matchIntentPda,               isSigner: false, isWritable: true  }, // match_intent
        { pubkey: poolRecord,                   isSigner: false, isWritable: true  }, // pool_record
        { pubkey: poolState,                    isSigner: false, isWritable: false }, // pool_record_pool_key (passthrough for seed)
        { pubkey: tokenProgA,                   isSigner: false, isWritable: false }, // token_a_program
        { pubkey: tokenProgB,                   isSigner: false, isWritable: false }, // token_b_program
        { pubkey: TOKEN_PROGRAM_ID,             isSigner: false, isWritable: false }, // token_program (standard SPL)
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false }, // associated_token_program
        { pubkey: SystemProgram.programId,      isSigner: false, isWritable: false }, // system_program
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false }, // rent
        // Remaining:
        { pubkey: poolState,                    isSigner: false, isWritable: true  }, // [0]  new_pool_state
        { pubkey: lpMint,                       isSigner: false, isWritable: true  }, // [1]  lp_mint
        { pubkey: poolVault0,                   isSigner: false, isWritable: true  }, // [2]  pool_vault_0
        { pubkey: poolVault1,                   isSigner: false, isWritable: true  }, // [3]  pool_vault_1
        { pubkey: observation,                  isSigner: false, isWritable: true  }, // [4]  observation_state
        { pubkey: matcherLpAta,                 isSigner: false, isWritable: true  }, // [5]  matcher_lp_token
        { pubkey: creatorLpAta,                 isSigner: false, isWritable: true  }, // [6]  creator_lp_ata
        { pubkey: treasuryLpAta,                isSigner: false, isWritable: true  }, // [7]  treasury_lp_ata
        { pubkey: incineratorLpAta,             isSigner: false, isWritable: true  }, // [8]  incinerator_lp_ata
        { pubkey: treasuryPk,                   isSigner: false, isWritable: true  }, // [9]  treasury
        { pubkey: incineratorPk,                isSigner: false, isWritable: true  }, // [10] incinerator
        { pubkey: new PublicKey(XDEX_PROGRAM),  isSigner: false, isWritable: false }, // [11] xdex_program
        { pubkey: ammCfgPk,                     isSigner: false, isWritable: false }, // [12] amm_config
        { pubkey: new PublicKey(XDEX_LP_AUTH),  isSigner: false, isWritable: false }, // [13] xdex_lp_auth
        { pubkey: feeVaultPk,                   isSigner: false, isWritable: true  }, // [14] create_pool_fee
        { pubkey: mintAPk,                      isSigner: false, isWritable: false }, // [15] token_a_mint (remaining)
        { pubkey: mintBPk,                      isSigner: false, isWritable: false }, // [16] token_b_mint (remaining)
      ];

      const execIx = new TransactionInstruction({ programId: programPk, keys: execKeys, data: execIxData });

      // ── Step 7: Build atomic transaction using ALT + VersionedTransaction ────
      // The transaction has too many accounts for a legacy tx (1577 > 1232 bytes).
      // Solution: create an Address Lookup Table on-the-fly, store all accounts in
      // it, then reference them by index in a v0 VersionedTransaction.
      // Both instructions MUST be in the same transaction — same-slot enforced.
      setStatus('Creating address lookup table…');
      const { AddressLookupTableProgram, VersionedTransaction, TransactionMessage } = await import('@solana/web3.js');

      // Collect all unique non-signer accounts to stuff into the ALT
      const allAccounts = [
        ...prepKeys.map(k => k.pubkey),
        ...execKeys.map(k => k.pubkey),
        programPk,
      ];
      const uniqueAccounts = [...new Map(allAccounts.map(pk => [pk.toBase58(), pk])).values()];

      // Create the ALT
      const recentSlot = await connection.getSlot('finalized');
      const [altCreateIx, altAddress] = AddressLookupTableProgram.createLookupTable({
        authority: publicKey,
        payer:     publicKey,
        recentSlot,
      });

      // Extend the ALT with all unique accounts (max 30 per extend ix)
      const extendIxs = [];
      for (let i = 0; i < uniqueAccounts.length; i += 30) {
        extendIxs.push(AddressLookupTableProgram.extendLookupTable({
          payer:        publicKey,
          authority:    publicKey,
          lookupTable:  altAddress,
          addresses:    uniqueAccounts.slice(i, i + 30),
        }));
      }

      // Send ALT setup — create and each extend as separate signed transactions
      const sendAndConfirmTx = async (ixs: any[], label: string) => {
        const { blockhash: bh } = await connection.getLatestBlockhash("confirmed");
        const stx = new Transaction({ feePayer: publicKey, recentBlockhash: bh });
        stx.add(...ixs);
        const ssigned = await signTransaction(stx);
        const ssig = await connection.sendRawTransaction(ssigned.serialize(), { skipPreflight: true });
        for (let si = 0; si < 30; si++) {
          await new Promise(r => setTimeout(r, 800));
          const ss = await connection.getSignatureStatus(ssig, { searchTransactionHistory: true });
          if (ss?.value?.err) throw new Error(label + " failed: " + JSON.stringify(ss.value.err));
          if (ss?.value?.confirmationStatus === "confirmed" || ss?.value?.confirmationStatus === "finalized") return ssig;
        }
        throw new Error(label + " confirmation timeout");
      };
      setStatus("Waiting for wallet — step 1/3: create lookup table…");
      await sendAndConfirmTx([altCreateIx], "ALT create");
      for (let ei = 0; ei < extendIxs.length; ei++) {
        setStatus("Waiting for wallet — step " + (ei + 2) + "/" + (extendIxs.length + 2) + ": extend lookup table…");
        await sendAndConfirmTx([extendIxs[ei]], "ALT extend " + (ei + 1));
      }
      await new Promise(r => setTimeout(r, 1500));

      // Fetch the ALT account
      const altAccount = await connection.getAddressLookupTable(altAddress);
      if (!altAccount.value) throw new Error('Could not fetch ALT account after creation');

      // Build the match transaction using VersionedTransaction
      setStatus('Building atomic match transaction…');
      const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');

      const messageV0 = new TransactionMessage({
        payerKey:            publicKey,
        recentBlockhash:     blockhash,
        instructions:        [cuLimitIx, prepIx, execIx],
      }).compileToV0Message([altAccount.value]);

      const versionedTx = new VersionedTransaction(messageV0);

      setStatus('Waiting for wallet — step 2/2: sign match transaction…');
      const signed = await signTransaction(versionedTx);

      setStatus('Submitting match transaction…');
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setTxSig(sig);
      setStatus('Confirming on-chain…');

      // Poll for confirmation
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1200));
        const result = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const conf   = result?.value?.confirmationStatus;
        const err    = result?.value?.err;
        if (err) {
          const errStr = JSON.stringify(err);
          // Error 6028 = TransactionTooOld = same-slot check failed
          if (errStr.includes('6028') || errStr.includes('TransactionTooOld')) {
            throw new Error('Same-slot check failed — retry immediately. Both instructions must land in the same block.');
          }
          throw new Error(decodeProgramError(errStr));
        }
        if (conf === 'confirmed' || conf === 'finalized') {
          setStatus(`✅ Match complete! XDEX pool created.\n\nDeposited: ${fmtNum(amt)} ${tokenBMeta?.symbol}\nPool: ${poolState.toBase58().slice(0,8)}…\nTx: ${sig.slice(0,20)}…`);
          // Award LB points for LP burn (fire and forget — non-blocking)
          if (listing.burnBps > 0) {
            const burnedFraction = listing.burnBps / 10000;
            const pointsEach = Math.floor(listing.usdValUi * burnedFraction * 1.888);
            if (pointsEach > 0) {
              const weekId = new Date().toISOString().slice(0, 7);
              awardLabWorkPoints(listing.creator, pointsEach, `LP burn match — ${listing.burnBps/100}% burn · pool ${poolState.toBase58().slice(0,8)}`, 'defi_burn', weekId).catch(() => {});
              awardLabWorkPoints(publicKey.toBase58(), pointsEach, `LP burn match — ${listing.burnBps/100}% burn · pool ${poolState.toBase58().slice(0,8)}`, 'defi_burn', weekId).catch(() => {});
            }
          }
          setTimeout(() => { onMatched(); onClose(); }, 4000);
          return;
        }
      }
      throw new Error('Confirmation timeout — check explorer: ' + sig.slice(0, 20));
    } catch (e: any) { console.error('MATCH ERROR:', e);
      setStatus('❌ ' + decodeProgramError(e?.message ?? String(e)));
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
        border: '1px solid rgba(0,255,128,.2)', borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '20px 16px 28px' : '24px 26px',
        maxHeight: isMobile ? '88vh' : 'calc(100vh - 32px)', overflowY: 'auto', position: 'relative',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16,
          width: 30, height: 30, borderRadius: '50%', border: '1px solid rgba(0,255,128,.2)',
          background: 'rgba(8,12,15,.9)', cursor: 'pointer', color: '#00ff80', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 15 : 18,
          fontWeight: 900, color: '#fff', letterSpacing: 1, marginBottom: 4 }}>⚡ MATCH LISTING</div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', marginBottom: 14, lineHeight: 1.5 }}>
          You deposit tokens equal in value to the listing. The program atomically creates an XDEX pool (prepare + execute in one transaction).
        </div>

        {/* Listing summary */}
        <div style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)',
          borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TokenLogo mint={listing.tokenAMint} logo={listing.tokenALogo} symbol={listing.tokenASymbol} size={36} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900, color: '#00d4ff' }}>
                {fmtNum(listing.amountUi)} {listing.tokenASymbol}
              </div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa' }}>
                {fmtUSD(listing.usdValUi)} · {listing.burnBps / 100}% burn · by {truncAddr(listing.creator)}
              </div>
            </div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 900,
              color: '#ff8c00', background: 'rgba(255,140,0,.1)', border: '1px solid rgba(255,140,0,.25)',
              borderRadius: 8, padding: '4px 12px' }}>
              YOU NEED ≈{fmtUSD(listing.usdValUi)}
            </div>
          </div>
        </div>

        {/* Wallet tokens — pick one */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 10 }}>
          SELECT FROM YOUR WALLET
        </div>
        {loadingWallet ? (
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#4a6a8a', marginBottom: 12, padding: '10px 0' }}>
            Loading your tokens…
          </div>
        ) : walletTokens.length === 0 ? (
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#ff6666', marginBottom: 12,
            padding: '10px 14px', background: 'rgba(255,68,68,.06)', borderRadius: 8,
            border: '1px solid rgba(255,68,68,.15)' }}>
            No eligible tokens found in your wallet. You need tokens with an XNT pool on XDEX.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12,
            maxHeight: 220, overflowY: 'auto' }}>
            {walletTokens.map(t => {
              const usdVal = t.balance * t.price;
              const isSelected = tokenBMint === t.mint;
              return (
                <button key={t.mint} onClick={() => {
                  setTokenBMint(t.mint);
                  checkTokenB(t.mint);
                  // Auto-fill optimal amount
                  if (t.price > 0) {
                    const optAmt = listing.usdValUi / t.price;
                    setAmount(Math.min(optAmt, t.balance).toFixed(t.decimals > 4 ? 4 : t.decimals));
                  }
                }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                    borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                    background: isSelected ? 'rgba(0,255,128,.08)' : 'rgba(255,255,255,.03)',
                    border: `1px solid ${isSelected ? 'rgba(0,255,128,.4)' : 'rgba(255,255,255,.07)'}`,
                    transition: 'all 0.15s' }}>
                  <TokenLogo mint={t.mint} logo={t.logo} symbol={t.symbol} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
                      color: isSelected ? '#00ff80' : '#e0f0ff' }}>{t.symbol}</div>
                    <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#6a8aaa' }}>
                      {fmtNum(t.balance)} · {fmtUSD(t.price)}/token
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700,
                      color: usdVal >= listing.usdValUi * 0.995 ? '#00c98d' : usdVal > 0 ? '#ff8c00' : '#4a6a8a' }}>
                      {fmtUSD(usdVal)}
                    </div>
                    {usdVal < listing.usdValUi * 0.995 && usdVal > 0 && (
                      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#ff6666' }}>
                        INSUFFICIENT
                      </div>
                    )}
                    {usdVal >= listing.usdValUi * 0.995 && (
                      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#00c98d' }}>
                        ✓ ELIGIBLE
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Manual paste fallback */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 8 }}>
          OR PASTE MINT ADDRESS
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: tokenBMeta ? 10 : 16 }}>
          <input value={tokenBMint} onChange={e => setTokenBMint(e.target.value)}
            placeholder="Any token mint with XNT pool…"
            style={{ flex: 1, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(0,255,128,.15)',
              borderRadius: 10, padding: '10px 14px', outline: 'none', color: '#e0f0ff',
              fontFamily: 'Sora,sans-serif', fontSize: 11 }} />
          <button onClick={() => checkTokenB(tokenBMint)}
            style={{ padding: '10px 14px', borderRadius: 10, cursor: 'pointer',
              background: 'rgba(0,255,128,.08)', border: '1px solid rgba(0,255,128,.25)',
              fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: '#00ff80' }}>
            CHECK
          </button>
        </div>

        {tokenBMeta && !tokenBMeta.checking && !tokenBMeta.hasPool && (
          <div style={{ marginBottom: 12, padding: '8px 14px', borderRadius: 8,
            background: 'rgba(255,68,68,.06)', border: '1px solid rgba(255,68,68,.2)' }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#ff6666' }}>
              ✗ No XNT pool found — create one on XDEX first
            </div>
          </div>
        )}

        {/* Amount input */}
        {tokenBMeta?.hasPool && (
          <>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 8 }}>
              AMOUNT TO DEPOSIT (must equal ≈{fmtUSD(listing.usdValUi)})
            </div>
            <div style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(0,255,128,.15)',
              borderRadius: 12, padding: '14px 16px', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <TokenLogo mint={tokenBMint} logo={tokenBMeta.logo} symbol={tokenBMeta.symbol} size={32} />
                <input value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0"
                  placeholder="0" style={{ flex: 1, background: 'transparent', border: 'none',
                    outline: 'none', fontFamily: 'Orbitron,monospace', fontSize: 22, fontWeight: 900, color: '#fff' }} />
                <button onClick={() => setAmount(String(tokenBMeta.balance.toFixed(tokenBMeta.decimals)))}
                  style={{ background: 'rgba(0,255,128,.1)', border: '1px solid rgba(0,255,128,.25)',
                    borderRadius: 7, padding: '5px 12px', cursor: 'pointer',
                    fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: '#00ff80' }}>MAX</button>
              </div>
              {amt > 0 && (
                <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center' }}>
                  <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 11,
                    color: priceMatch ? '#00c98d' : '#ff6666' }}>{fmtUSD(usdValB)}</span>
                  {priceMatch
                    ? <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#00c98d' }}>✓ PRICE MATCH</span>
                    : <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#ff6666' }}>
                        ✗ needs to be ≈{fmtUSD(listing.usdValUi)} (±0.5%)
                      </span>}
                </div>
              )}
            </div>

            {/* Fee display */}
            <div style={{ background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
              borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a' }}>MATCH FEE ({isEcoB || lbRaw >= LB_DISCOUNT_THRESHOLD ? '0.888%' : '1.888%'})</span>
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: '#ff8c00' }}>{matchFeeXnt.toFixed(4)} XNT</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a' }}>LP SPLIT</span>
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#8aa0b8' }}>
                  {listing.burnBps < 10000 ? `${(10000 - listing.burnBps) / 2 / 100}% each` : 'All burned'}
                </span>
              </div>
            </div>
          </>
        )}

        <StatusBox msg={status} />
        <TxLink sig={txSig} color="#00c98d" />

        <button onClick={handleMatch} disabled={!canMatch}
          style={{ width: '100%', padding: '15px 0', borderRadius: 12,
            cursor: canMatch ? 'pointer' : 'not-allowed',
            background: canMatch ? 'linear-gradient(135deg,rgba(0,255,128,.2),rgba(0,255,128,.06))' : 'rgba(255,255,255,.04)',
            border: `1px solid ${canMatch ? 'rgba(0,255,128,.5)' : 'rgba(255,255,255,.08)'}`,
            fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
            color: canMatch ? '#00ff80' : '#4a6a8a' }}>
          {pending
            ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <div style={{ width: 14, height: 14, borderRadius: '50%',
                  border: '2px solid rgba(0,255,128,.2)', borderTop: '2px solid #00ff80',
                  animation: 'spin .8s linear infinite' }} />MATCHING…
              </div>
            : `⚡ MATCH — DEPOSIT ${fmtNum(amt)} ${tokenBMeta?.symbol ?? '???'} · CREATE XDEX POOL`}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ─── Edit Modal ────────────────────────────────────────────────────────────────
const EditModal: FC<{
  listing: ListingOnChain;
  isMobile: boolean;
  publicKey: PublicKey;
  connection: any;
  signTransaction: any;
  onClose: () => void;
  onEdited: () => void;
}> = ({ listing, isMobile, publicKey, connection, signTransaction, onClose, onEdited }) => {
  const [newBurnBps, setNewBurnBps] = useState<0|2500|5000|10000>(listing.burnBps as any);
  const [newAmount, setNewAmount]   = useState('');
  const [status, setStatus]         = useState('');
  const [pending, setPending]       = useState(false);
  const [txSig, setTxSig] = useState("");
  const [xntPrice, setXntPrice]     = useState(0.4187);
  const [tokenBal, setTokenBal]     = useState(0);
  const [tokenPrice, setTokenPrice] = useState(0);

  useEffect(() => {
    fetchXdexPrice(WXNT_MINT).then(p => { if (p) setXntPrice(p.priceUSD); });
    fetchXdexPrice(listing.tokenAMint).then(p => { if (p) setTokenPrice(p.priceUSD); });
    // Fetch current token balance
    if (publicKey && connection) {
      getTokenProgram(new PublicKey(listing.tokenAMint), connection).then(tProg => {
        const ata = getAssociatedTokenAddressSync(new PublicKey(listing.tokenAMint), publicKey, false, tProg);
        connection.getParsedAccountInfo(ata)
          .then((a: any) => setTokenBal(a?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0))
          .catch(() => {});
      });
    }
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`; } catch {}
    return () => { try { document.body.style.position = ''; document.body.style.top = ''; window.scrollTo(0, sy); } catch {} };
  }, []);

  const handleEdit = async () => {
    if (!publicKey || !signTransaction) return;
    setPending(true);
    setTxSig(''); setStatus('Building transaction…');
    try {
      const xntP   = await fetchXdexPrice(WXNT_MINT);
      const xntP6  = xntP?.priceUSD6 ?? Math.floor(xntPrice * 1_000_000);
      const now    = Math.floor(Date.now() / 1000);
      const programPk  = new PublicKey(PROGRAM_ID);
      const mintPk     = new PublicKey(listing.tokenAMint);
      // listing.id IS the listing PDA from getProgramAccounts — use directly
      const listingPda = new PublicKey(listing.id);
      const [globalState] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], programPk);
      const [escrowPda]   = PublicKey.findProgramAddressSync([Buffer.from('escrow'),      listingPda.toBuffer()], programPk);
      const [escrowAuth]  = PublicKey.findProgramAddressSync([Buffer.from('escrow_auth'), listingPda.toBuffer()], programPk);
      const tokenProg = await getTokenProgram(mintPk, connection);
      const creatorAta = getAssociatedTokenAddressSync(mintPk, publicKey, false, tokenProg);
      const msgBytes  = new TextEncoder().encode('global:edit_listing');
      const hashBuf   = await window.crypto.subtle.digest('SHA-256', msgBytes);
      const disc      = Buffer.from(new Uint8Array(hashBuf).slice(0, 8));
      // EditListingParams:
      // new_amount:      Option<u64>  — None = 0x00
      // new_usd_val:     Option<u64>  — None = 0x00
      // new_xnt_val:     Option<u64>  — None = 0x00
      // new_burn_bps:    Option<u16>  — Some(bps) = 0x01 + u16LE
      // price_timestamp: i64
      // xnt_price_usd:   u64
      const selDec    = listing.tokenAMint === BRAINS_MINT ? 9 : listing.tokenAMint === LB_MINT ? 2 : 9;
      const hasNewAmt = newAmount && parseFloat(newAmount) > 0;
      const rawNewAmt = hasNewAmt ? Math.floor(parseFloat(newAmount) * Math.pow(10, selDec)) : 0;
      const tPrice    = await fetchXdexPrice(listing.tokenAMint);
      const newUsd6   = hasNewAmt && tPrice ? Math.floor(parseFloat(newAmount) * tPrice.priceUSD * 1_000_000) : 0;
      const newXnt9   = hasNewAmt && tPrice ? Math.floor((tPrice.priceUSD / (xntP?.priceUSD ?? xntPrice)) * parseFloat(newAmount) * 1_000_000_000) : 0;
      // EditListingParams layout — all Option<T> encoded as 0x00 (None) or 0x01 + value (Some)
      const parts: number[] = [];
      // new_amount: Option<u64>
      if (hasNewAmt) { parts.push(1); const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(rawNewAmt)); parts.push(...b); }
      else { parts.push(0); }
      // new_usd_val: Option<u64>
      if (hasNewAmt && newUsd6 > 0) { parts.push(1); const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(newUsd6)); parts.push(...b); }
      else { parts.push(0); }
      // new_xnt_val: Option<u64>
      if (hasNewAmt && newXnt9 > 0) { parts.push(1); const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(newXnt9)); parts.push(...b); }
      else { parts.push(0); }
      // new_burn_bps: Option<u16>
      parts.push(1); const bpsBuf = Buffer.alloc(2); bpsBuf.writeUInt16LE(newBurnBps); parts.push(...bpsBuf);
      // price_timestamp: i64
      const tsBuf = Buffer.alloc(8); tsBuf.writeBigInt64LE(BigInt(now)); parts.push(...tsBuf);
      // xnt_price_usd: u64
      const xntBuf = Buffer.alloc(8); xntBuf.writeBigUInt64LE(BigInt(xntP6)); parts.push(...xntBuf);
      const params = Buffer.from(parts);
      const ixData = Buffer.concat([disc, params]);
      const keys = [
        { pubkey: publicKey,               isSigner: true,  isWritable: true  },
        { pubkey: globalState,             isSigner: false, isWritable: true  },
        { pubkey: listingPda,              isSigner: false, isWritable: true  }, // listing_state PDA
        { pubkey: escrowPda,               isSigner: false, isWritable: true  },
        { pubkey: escrowAuth,              isSigner: false, isWritable: false },
        { pubkey: mintPk,                  isSigner: false, isWritable: false },
        { pubkey: creatorAta,              isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(TREASURY), isSigner: false, isWritable: true  },
        { pubkey: tokenProg,               isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const { TransactionInstruction, Transaction } = await import('@solana/web3.js');
      const ix  = new TransactionInstruction({ programId: programPk, keys, data: ixData });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx  = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      tx.add(ix);
      setStatus('Waiting for wallet approval…');
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setTxSig(sig); setStatus(`✅ Edit submitted! Tx: ${sig.slice(0,20)}…`);
      setTimeout(() => { onEdited(); onClose(); }, 2000);
    } catch (e: any) { console.error('MATCH ERROR:', e);
      setStatus('❌ ' + (e?.message ?? String(e)).slice(0, 200));
    } finally { setPending(false); }
  };

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center',
      justifyContent: 'center', padding: isMobile ? 0 : 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: isMobile ? '100%' : 460,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(0,212,255,.2)', borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '20px 16px 28px' : '24px 26px',
        maxHeight: isMobile ? '88vh' : 'calc(100vh - 32px)', overflowY: 'auto', position: 'relative',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16,
          width: 30, height: 30, borderRadius: '50%', border: '1px solid rgba(0,212,255,.2)',
          background: 'rgba(8,12,15,.9)', cursor: 'pointer', color: '#00d4ff', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 15 : 18,
          fontWeight: 900, color: '#fff', letterSpacing: 1, marginBottom: 4 }}>✏️ EDIT LISTING</div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', marginBottom: 16 }}>
          Edit fee: 0.001 XNT flat per edit.
        </div>

        {/* Current listing info */}
        <div style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)',
          borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, color: '#8aa0b8' }}>
              CURRENT: {fmtNum(listing.amountUi)} {listing.tokenASymbol}
            </div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, color: '#00c98d' }}>
              {fmtUSD(listing.usdValUi)}
            </div>
          </div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a', marginTop: 4 }}>
            WALLET BAL: {fmtNum(tokenBal + listing.amountUi)} {listing.tokenASymbol}
          </div>
        </div>

        {/* New amount */}
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 8 }}>
          NEW AMOUNT (leave blank to keep current)
        </div>
        <div style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(0,212,255,.15)',
          borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TokenLogo mint={listing.tokenAMint} logo={listing.tokenALogo} symbol={listing.tokenASymbol} size={28} />
            <input value={newAmount} onChange={e => setNewAmount(e.target.value)} type="number" min="0"
              placeholder={String(listing.amountUi)}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontFamily: 'Orbitron,monospace', fontSize: 20, fontWeight: 900, color: '#fff' }} />
            <button onClick={() => setNewAmount(String(Math.floor(tokenBal + listing.amountUi)))}
              style={{ background: 'rgba(0,212,255,.08)', border: '1px solid rgba(0,212,255,.2)',
                borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
                fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700, color: '#00d4ff' }}>MAX</button>
          </div>
          {newAmount && parseFloat(newAmount) > 0 && (
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, color: '#00c98d', marginTop: 6 }}>
              ≈ {fmtUSD(parseFloat(newAmount) * tokenPrice)}
            </div>
          )}
        </div>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 2, color: '#4a6a8a', marginBottom: 10 }}>
          NEW BURN % (current: {listing.burnBps / 100}%)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 20 }}>
          {BURN_OPTIONS.map(b => (
            <button key={b.bps} onClick={() => setNewBurnBps(b.bps as any)}
              style={{ padding: '12px 0', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                background: newBurnBps === b.bps ? `${b.color}18` : 'rgba(255,255,255,.03)',
                border: `1px solid ${newBurnBps === b.bps ? b.color + '66' : 'rgba(255,255,255,.08)'}` }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900,
                color: newBurnBps === b.bps ? b.color : '#8aa0b8' }}>{b.label}</div>
            </button>
          ))}
        </div>

        <StatusBox msg={status} />
        <TxLink sig={txSig} color="#ff8c00" />

        <button onClick={handleEdit} disabled={pending || (newBurnBps === listing.burnBps && !newAmount)}
          style={{ width: '100%', padding: '15px 0', borderRadius: 12,
            cursor: (!pending && (newBurnBps !== listing.burnBps || !!newAmount)) ? 'pointer' : 'not-allowed',
            background: (!pending && newBurnBps !== listing.burnBps)
              ? 'linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.06))' : 'rgba(255,255,255,.04)',
            border: `1px solid ${(!pending && (newBurnBps !== listing.burnBps || !!newAmount)) ? 'rgba(0,212,255,.45)' : 'rgba(255,255,255,.08)'}`,
            fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
            color: (!pending && (newBurnBps !== listing.burnBps || !!newAmount)) ? '#00d4ff' : '#4a6a8a',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          {pending
            ? <><div style={{ width: 14, height: 14, borderRadius: '50%',
                border: '2px solid rgba(0,212,255,.2)', borderTop: '2px solid #00d4ff',
                animation: 'spin .8s linear infinite' }} />UPDATING…</>
            : `✏️ UPDATE BURN TO ${newBurnBps / 100}% · PAY 0.001 XNT`}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ─── Delist Modal ─────────────────────────────────────────────────────────────
const DelistModal: FC<{
  listing: ListingOnChain;
  isMobile: boolean;
  publicKey: PublicKey;
  connection: any;
  signTransaction: any;
  onClose: () => void;
  onDelisted: () => void;
}> = ({ listing, isMobile, publicKey, connection, signTransaction, onClose, onDelisted }) => {
  const [status, setStatus]   = useState('');
  const [pending, setPending] = useState(false);
  const [txSig, setTxSig] = useState("");
  const [xntPrice, setXntPrice] = useState(0.4187);
  const [logo, setLogo]       = useState<string | undefined>(listing.tokenALogo);

  useEffect(() => {
    fetchXdexPrice(WXNT_MINT).then(p => { if (p) setXntPrice(p.priceUSD); });
    if (!logo) fetchTokenMeta(listing.tokenAMint).then(m => { if (m.logo) setLogo(m.logo); });
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`; } catch {}
    return () => { try { document.body.style.position = ''; document.body.style.top = ''; window.scrollTo(0, sy); } catch {} };
  }, []);

  const delistFeeUsd = listing.usdValUi * 0.00444;
  const delistFeeXnt = xntPrice > 0 ? delistFeeUsd / xntPrice : 0;

  const handleDelist = async () => {
    if (!publicKey || !signTransaction) return;
    setPending(true);
    setTxSig(''); setStatus('Building transaction…');
    try {
      const xntP      = await fetchXdexPrice(WXNT_MINT);
      const xntPrice6 = xntP?.priceUSD6 ?? 418700;
      const msgBytes  = new TextEncoder().encode('global:delist');
      const hashBuf   = await window.crypto.subtle.digest('SHA-256', msgBytes);
      const disc      = Buffer.from(new Uint8Array(hashBuf).slice(0, 8));
      const params    = Buffer.alloc(8);
      params.writeBigUInt64LE(BigInt(xntPrice6), 0);
      const ixData    = Buffer.concat([disc, params]);
      const programPk = new PublicKey(PROGRAM_ID);
      const mintPk    = new PublicKey(listing.tokenAMint);
      // listing.id IS the PDA from getProgramAccounts — use directly
      const listingPda = new PublicKey(listing.id);
      const [escrowPda]   = PublicKey.findProgramAddressSync([Buffer.from('escrow'),      listingPda.toBuffer()], programPk);
      const [escrowAuth]  = PublicKey.findProgramAddressSync([Buffer.from('escrow_auth'), listingPda.toBuffer()], programPk);
      const [globalState] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], programPk);
      const tokenProg = await getTokenProgram(mintPk, connection);
      const creatorAta = getAssociatedTokenAddressSync(mintPk, publicKey, false, tokenProg);
      const { TransactionInstruction, Transaction } = await import('@solana/web3.js');
      const keys = [
        { pubkey: publicKey,               isSigner: true,  isWritable: true  },
        { pubkey: globalState,             isSigner: false, isWritable: true  },
        { pubkey: listingPda,              isSigner: false, isWritable: true  },
        { pubkey: escrowPda,               isSigner: false, isWritable: true  },
        { pubkey: escrowAuth,              isSigner: false, isWritable: false },
        { pubkey: mintPk,                  isSigner: false, isWritable: true  },
        { pubkey: creatorAta,              isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(TREASURY), isSigner: false, isWritable: true  },
        { pubkey: tokenProg,               isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const ix = new TransactionInstruction({ programId: programPk, keys, data: ixData });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      // Create creator ATA if it doesn't exist (needed when creator never held this token)
      const creatorAtaInfo = await connection.getAccountInfo(creatorAta);
      if (!creatorAtaInfo) {
        const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');
        tx.add(createAssociatedTokenAccountIdempotentInstruction(
          publicKey, creatorAta, publicKey, mintPk, tokenProg
        ));
      }
      tx.add(ix);
      setStatus('Waiting for wallet approval…');
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setStatus('Confirming…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error('TX failed on-chain');
        const conf = st?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') {
          setTxSig(sig); setStatus(`✅ Delisted! ${fmtNum(listing.amountUi)} ${listing.tokenASymbol} returned.\nTx: ${sig.slice(0,20)}…`);
          setTimeout(() => { onDelisted(); onClose(); }, 2500);
          return;
        }
      }
      throw new Error('Confirmation timeout');
    } catch (e: any) { console.error('MATCH ERROR:', e);
      setStatus('❌ ' + (e?.message ?? String(e)).slice(0, 200));
    } finally { setPending(false); }
  };

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center',
      justifyContent: 'center', padding: isMobile ? 0 : 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: isMobile ? '100%' : 440,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(255,68,68,.2)', borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '20px 16px 28px' : '24px 26px',
        maxHeight: isMobile ? '88vh' : 'calc(100vh - 32px)', overflowY: 'auto', position: 'relative',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16,
          width: 30, height: 30, borderRadius: '50%', border: '1px solid rgba(255,68,68,.2)',
          background: 'rgba(8,12,15,.9)', cursor: 'pointer', color: '#ff6666', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 15 : 18,
          fontWeight: 900, color: '#fff', letterSpacing: 1, marginBottom: 4 }}>🗑️ DELIST</div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', marginBottom: 18, lineHeight: 1.5 }}>
          Cancel your listing and get your tokens back. A 0.444% fee applies.
        </div>

        {/* Listing summary */}
        <div style={{ background: 'rgba(255,68,68,.04)', border: '1px solid rgba(255,68,68,.15)',
          borderRadius: 12, padding: '16px', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <TokenLogo mint={listing.tokenAMint} logo={logo} symbol={listing.tokenASymbol} size={44} />
            <div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 16, fontWeight: 900, color: '#e0f0ff' }}>
                {fmtNum(listing.amountUi)} {listing.tokenASymbol}
              </div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', marginTop: 2 }}>
                {fmtUSD(listing.usdValUi)} · {listing.burnBps / 100}% burn
              </div>
            </div>
          </div>

          {/* Fee breakdown */}
          {[
            { label: 'YOU GET BACK',  val: `${fmtNum(listing.amountUi)} ${listing.tokenASymbol}`, color: '#00c98d' },
            { label: 'DELIST FEE (0.444%)', val: `${delistFeeXnt.toFixed(4)} XNT`, color: '#ff8c00',
              sub: fmtUSD(delistFeeUsd) },
            { label: 'RENT REFUND',   val: '~0.002 XNT',  color: '#8aa0b8' },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', padding: '6px 0',
              borderTop: '1px solid rgba(255,255,255,.04)' }}>
              <div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#4a6a8a', letterSpacing: .5 }}>
                  {row.label}
                </div>
                {row.sub && <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#2a4a5a' }}>{row.sub}</div>}
              </div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700, color: row.color }}>
                {row.val}
              </div>
            </div>
          ))}
        </div>

        <StatusBox msg={status} />
        <TxLink sig={txSig} color="#ff6666" />

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose}
            style={{ flex: 1, padding: '14px 0', borderRadius: 12, cursor: 'pointer',
              background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.1)',
              fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: '#6a8aaa' }}>
            CANCEL
          </button>
          <button onClick={handleDelist} disabled={pending}
            style={{ flex: 2, padding: '14px 0', borderRadius: 12,
              cursor: pending ? 'not-allowed' : 'pointer',
              background: pending ? 'rgba(255,255,255,.04)' : 'linear-gradient(135deg,rgba(255,68,68,.2),rgba(255,68,68,.06))',
              border: `1px solid ${pending ? 'rgba(255,255,255,.08)' : 'rgba(255,68,68,.45)'}`,
              fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
              color: pending ? '#4a6a8a' : '#ff6666',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            {pending
              ? <><div style={{ width: 14, height: 14, borderRadius: '50%',
                  border: '2px solid rgba(255,68,68,.2)', borderTop: '2px solid #ff6666',
                  animation: 'spin .8s linear infinite' }} />DELISTING…</>
              : `🗑️ DELIST · PAY ${delistFeeXnt.toFixed(4)} XNT`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
const PairingMarketplace: FC = () => {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { connection } = useConnection();
  const isMobile = useIsMobile();

  const [tab, setTab]               = useState<'listings' | 'mine'>('listings');
  const [filter, setFilter]         = useState<'all' | 'brains' | 'lb'>('all');
  const [listings, setListings]     = useState<ListingOnChain[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [matchTarget, setMatchTarget]   = useState<ListingOnChain | null>(null);
  const [editTarget, setEditTarget]     = useState<ListingOnChain | null>(null);
  const [delistTarget, setDelistTarget] = useState<ListingOnChain | null>(null);
  const [xntPrice, setXntPrice]     = useState(0.4187);
  const [lbBalance, setLbBalance]   = useState(0); // raw LB balance
  const [platformVolume, setPlatformVolume] = useState(0);
  const [totalPools, setTotalPools]         = useState(0);
  const [totalListings, setTotalListings]   = useState(0);

  // Fetch XNT price
  useEffect(() => {
    fetchXdexPrice(WXNT_MINT).then(p => { if (p) setXntPrice(p.priceUSD); });
  }, []);

  // Fetch user LB balance for fee display
  useEffect(() => {
    if (!publicKey || !connection) return;
    (async () => {
      try {
        const lAta = getAssociatedTokenAddressSync(
          new PublicKey(LB_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID
        );
        const acc = await connection.getParsedAccountInfo(lAta);
        const raw = Number(acc?.value?.data?.parsed?.info?.tokenAmount?.amount ?? 0);
        setLbBalance(raw);
      } catch {}
    })();
  }, [publicKey, connection]);

  // Fetch platform stats
  useEffect(() => {
    fetchPlatformStats().then(s => {
      setPlatformVolume(s.totalVolume);
      setTotalPools(s.totalPools);
      setTotalListings(s.totalListings);
    });
  }, []);

  // Fetch on-chain listings
  const loadListings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchOnChainListings();
      setListings(data);
    } catch { setListings([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadListings(); }, [loadListings]);

  const filtered = useMemo(() => {
    let l = listings.filter(x => x.status === 'open');
    if (filter === 'brains') l = l.filter(x => x.tokenAMint === BRAINS_MINT);
    if (filter === 'lb')     l = l.filter(x => x.tokenAMint === LB_MINT);
    if (tab === 'mine' && publicKey) l = l.filter(x => x.creator === publicKey.toBase58());
    return l;
  }, [listings, filter, tab, publicKey]);

  const totalUSD = filtered.reduce((s, l) => s + l.usdValUi, 0);
  const myCount  = publicKey
    ? listings.filter(x => x.creator === publicKey.toBase58() && x.status === 'open').length
    : 0;

  return (
    <div style={{ minHeight: '100vh', background: '#080c0f',
      padding: isMobile ? '70px 10px 40px' : '90px 24px 60px',
      position: 'relative', overflow: 'hidden' }}>

      <TopBar />
      <div style={{ display: 'none' }} aria-hidden="true"><BurnedBrainsBar /></div>
      <PageBackground />

      <div style={{ position: 'fixed', top: '20%', left: '10%', width: 600, height: 600, borderRadius: '50%',
        background: 'radial-gradient(circle,rgba(0,212,255,0.04) 0%,transparent 60%)', pointerEvents: 'none', zIndex: 0 }} />
      <div style={{ position: 'fixed', top: '60%', right: '5%', width: 500, height: 500, borderRadius: '50%',
        background: 'radial-gradient(circle,rgba(191,90,242,0.05) 0%,transparent 60%)', pointerEvents: 'none', zIndex: 0 }} />

      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes hdr-shimmer { 0%{background-position:-200% center} 100%{background-position:200% center} }
        @keyframes hdr-orb { 0%,100%{transform:scale(1);opacity:.5} 50%{transform:scale(1.15);opacity:.8} }
        @keyframes hdr-float { 0%,100%{transform:translateY(0px)} 50%{transform:translateY(-6px)} }
        @keyframes modal-in { from{opacity:0;transform:scale(.93) translateY(20px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes lp-pulse { 0%,100%{box-shadow:0 0 6px rgba(0,255,128,.12);border-color:rgba(0,255,128,.2)} 50%{box-shadow:0 0 20px rgba(0,255,128,.35);border-color:rgba(0,255,128,.5)} }
        input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
        input[type=number]{-moz-appearance:textfield}
        input::placeholder{color:#4a6a8a}
      `}</style>

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1100, margin: '0 auto' }}>

        {/* ── HEADER ── */}
        <div style={{ textAlign: 'center', marginBottom: isMobile ? 28 : 48, position: 'relative',
          minHeight: isMobile ? 200 : 280, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center' }}>

          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            width: isMobile ? 320 : 600, height: isMobile ? 180 : 280, borderRadius: '50%',
            background: 'radial-gradient(ellipse,rgba(0,212,255,.07) 0%,rgba(191,90,242,.04) 40%,transparent 70%)',
            pointerEvents: 'none', animation: 'hdr-orb 4s ease-in-out infinite', zIndex: 0 }} />

          <div style={{ position: 'relative', zIndex: 1, width: '100%' }}>
            <div style={{ position: 'relative', display: 'inline-block', animation: 'fadeUp 0.5s ease 0.05s both' }}>
              <h1 style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 22 : 42,
                fontWeight: 900, letterSpacing: isMobile ? 1 : 3, margin: '0 0 4px',
                lineHeight: 1.05, textTransform: 'uppercase' }}>
                <span style={{ background: 'linear-gradient(90deg,#ff8c00,#ffb700)', backgroundSize: '200% auto',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                  X1 Brains
                </span>
                <span style={{ WebkitTextFillColor: 'initial', marginLeft: isMobile ? 6 : 10,
                  fontSize: isMobile ? 18 : 32, display: 'inline-block', verticalAlign: 'middle' }}>🧠</span>
                <span style={{ background: 'linear-gradient(90deg,#00d4ff,#bf5af2,#00c98d,#00d4ff)',
                  backgroundSize: '200% auto', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text', animation: 'hdr-shimmer 3s linear infinite', marginLeft: isMobile ? 6 : 10 }}>
                  Lab Work DeFi
                </span>
                <span style={{ WebkitTextFillColor: 'initial', marginLeft: isMobile ? 6 : 10,
                  fontSize: isMobile ? 18 : 36, display: 'inline-block',
                  animation: 'hdr-float 2.5s ease-in-out infinite', verticalAlign: 'middle' }}>⚡</span>
              </h1>
            </div>

            <div style={{ marginTop: isMobile ? 8 : 10, marginBottom: isMobile ? 4 : 6,
              animation: 'fadeUp 0.5s ease 0.12s both' }}>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 6 : 8,
                color: '#9abace', letterSpacing: isMobile ? 2 : 3 }}>
                X1 BLOCKCHAIN · LIQUIDITY PAIRING · XDEX POOL CREATION · {PROGRAM_ID.slice(0,8)}…
              </span>
            </div>

            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color: '#6a8aaa',
              marginBottom: isMobile ? 20 : 28, marginTop: isMobile ? 6 : 8,
              letterSpacing: .5, animation: 'fadeUp 0.5s ease 0.15s both', lineHeight: 1.6 }}>
              List any token with an XNT pool &nbsp;·&nbsp; 0.888% fee with 33+ LB &nbsp;·&nbsp; 1.888% standard &nbsp;·&nbsp; Burn LP → earn LB points
            </div>

            {/* Stats bar */}
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%',
              maxWidth: 800, margin: '0 auto', animation: 'fadeUp 0.5s ease 0.22s both',
              background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.07)',
              borderRadius: 16, padding: isMobile ? '8px 4px' : '10px 24px',
              backdropFilter: 'blur(8px)', gap: 0 }}>
              {[
                { label: 'PLATFORM VOLUME', value: fmtUSD(platformVolume), color: '#00c98d' },
                { label: 'POOLS CREATED',   value: totalPools,              color: '#bf5af2' },
                { label: 'OPEN LISTINGS',   value: listings.filter(l => l.status === 'open').length, color: '#8aa0b8' },
                { label: 'XNT PRICE',       value: fmtUSD(xntPrice),        color: '#ff8c00' },
              ].map(({ label, value, color }, i, arr) => (
                <React.Fragment key={label}>
                  <div style={{ flex: 1, textAlign: 'center', padding: isMobile ? '2px 2px' : '2px 8px' }}>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 22,
                      fontWeight: 900, color, lineHeight: 1, marginBottom: 2, whiteSpace: 'nowrap' }}>
                      {value}
                    </div>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 5 : 7,
                      color: '#4a6070', letterSpacing: 1.5, whiteSpace: 'nowrap' }}>{label}</div>
                  </div>
                  {i < arr.length - 1 && (
                    <div style={{ width: 1, height: isMobile ? 28 : 34, flexShrink: 0, background: 'rgba(255,255,255,.08)' }} />
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>

        {/* ── MODE SWITCHER ── */}
        <div style={{ display: 'flex', gap: 6, marginBottom: isMobile ? 20 : 30,
          background: 'rgba(255,255,255,.03)', borderRadius: 14, padding: 4,
          border: '1px solid rgba(255,255,255,.06)', animation: 'fadeUp 0.4s ease 0.12s both' }}>
          {([
            { id: 'listings', label: '🟢 MARKETPLACE',    sub: `${listings.filter(l => l.status === 'open').length} open` },
            { id: 'create',   label: '⚡ CREATE LISTING', sub: 'lock tokens · pay fee' },
            { id: 'mine',     label: '📋 MY LISTINGS',    sub: myCount > 0 ? `${myCount} active` : 'your listings' },
          ] as { id: string; label: string; sub: string }[]).map(m => {
            const isMarket = m.id === 'listings';
            const isCreate = m.id === 'create';
            const isActive = tab === m.id;
            return (
              <button key={m.id} type="button"
                onClick={() => { if (isCreate) setShowCreate(true); else setTab(m.id as any); }}
                style={{
                  flex: isCreate ? 1.3 : 1, padding: isMobile ? '10px 6px' : '13px 10px',
                  background: isActive && isMarket
                    ? 'linear-gradient(135deg,rgba(0,255,128,.18),rgba(0,200,100,.08))'
                    : isActive && !isCreate
                    ? 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.08))'
                    : isCreate
                    ? 'linear-gradient(135deg,rgba(0,212,255,.08),rgba(0,212,255,.03))'
                    : 'transparent',
                  border: isActive && isMarket ? '1px solid rgba(0,255,128,.7)'
                        : isActive && !isCreate ? '1px solid rgba(0,212,255,.35)'
                        : isCreate ? '1px solid rgba(0,212,255,.3)'
                        : '1px solid transparent',
                  borderRadius: 11, cursor: 'pointer', transition: 'all 0.18s', textAlign: 'center',
                  animation: isMarket && !isActive ? 'lp-pulse 2s ease-in-out infinite' : 'none',
                }}>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 9 : 11, fontWeight: 900,
                  color: isActive && isMarket ? '#00ff80' : isActive && !isCreate ? '#00d4ff'
                       : isCreate ? '#00d4ff' : '#4a6a8a', marginBottom: 2 }}>{m.label}</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1,
                  color: isActive && isMarket ? 'rgba(0,255,128,.55)' : isActive ? 'rgba(0,212,255,.55)' : '#3a5a7a' }}>
                  {m.sub}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── FILTER BAR ── */}
        {(tab === 'listings' || tab === 'mine') && (
          <div style={{ display: 'flex', gap: 6, marginBottom: isMobile ? 16 : 22,
            animation: 'fadeUp 0.3s ease 0.05s both', flexWrap: 'wrap', alignItems: 'center' }}>
            {([
              { key: 'all',    label: 'ALL LISTINGS' },
              { key: 'brains', label: '🧠 BRAINS'    },
              { key: 'lb',     label: '⚗️ LAB WORK'  },
            ] as { key: typeof filter; label: string }[]).map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                style={{ padding: isMobile ? '6px 12px' : '7px 16px', borderRadius: 8,
                  cursor: 'pointer', border: 'none',
                  fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 8 : 9, letterSpacing: 1, fontWeight: 700,
                  background: filter === f.key ? 'rgba(0,212,255,.12)' : 'rgba(255,255,255,.04)',
                  color: filter === f.key ? '#00d4ff' : '#4a6a8a' }}>
                {f.label}
              </button>
            ))}
            <div style={{ marginLeft: 'auto', fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 8 : 9, color: '#4a6a8a' }}>
              {filtered.length} listing{filtered.length !== 1 ? 's' : ''}
            </div>
            <button onClick={loadListings}
              style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: 'none',
                fontFamily: 'Orbitron,monospace', fontSize: 8, background: 'rgba(255,255,255,.04)',
                color: '#4a6a8a' }}>↻ REFRESH</button>
          </div>
        )}

        {/* ── LISTINGS ── */}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{ height: 110, borderRadius: 14,
                background: 'linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.07) 50%,rgba(255,255,255,.04) 75%)',
                backgroundSize: '400px 100%' }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: isMobile ? '60px 20px' : '100px 40px',
            animation: 'fadeUp 0.5s ease 0.1s both' }}>
            <div style={{ fontSize: 64, marginBottom: 24 }}>
              {tab === 'mine' ? '📋' : '⚡'}
            </div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 20,
              fontWeight: 900, color: '#9abacf', marginBottom: 12, letterSpacing: 2 }}>
              {tab === 'mine' ? 'NO ACTIVE LISTINGS' : 'NO LISTINGS YET'}
            </div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 12 : 13,
              color: '#6a8aaa', maxWidth: 380, margin: '0 auto 28px', lineHeight: 1.7 }}>
              {tab === 'mine'
                ? 'You have no open listings. Create one to attract liquidity partners.'
                : 'Be the first to list. Any token with an XNT pool on XDEX can participate.'}
            </div>
            {publicKey && (
              <button onClick={() => setShowCreate(true)}
                style={{ padding: isMobile ? '12px 24px' : '14px 32px', borderRadius: 12, cursor: 'pointer',
                  background: 'linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.06))',
                  border: '1px solid rgba(0,212,255,.4)',
                  fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 10 : 11, fontWeight: 900, color: '#00d4ff' }}>
                ⚡ CREATE LISTING
              </button>
            )}
          </div>
        ) : (
          filtered.map((listing, idx) => (
            <ListingCard key={listing.id} listing={listing} isMobile={isMobile} idx={idx}
              isOwn={publicKey?.toBase58() === listing.creator}
              xntPrice={xntPrice} lbBalance={lbBalance}
              onMatch={setMatchTarget}
              onEdit={(l) => setEditTarget(l)}
              onDelist={(l) => setDelistTarget(l)}
            />
          ))
        )}

        {/* ── HOW IT WORKS ── */}
        {tab === 'listings' && !loading && (
          <div style={{ marginTop: 40, background: 'rgba(255,255,255,.02)',
            border: '1px solid rgba(255,255,255,.06)', borderRadius: 16,
            padding: isMobile ? '20px 18px' : '28px 32px', animation: 'fadeUp 0.5s ease 0.3s both' }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 11 : 13,
              fontWeight: 900, color: '#fff', letterSpacing: 1.5, marginBottom: isMobile ? 18 : 24 }}>
              HOW IT WORKS
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: isMobile ? 14 : 18 }}>
              {[
                { n: '01', title: 'LIST YOUR TOKENS', color: '#00d4ff',
                  desc: 'Any token with an XNT pool on XDEX. Choose burn % (0/25/50/100). Fee: 0.888% with 33+ LB, 1.888% standard.' },
                { n: '02', title: 'GET MATCHED',      color: '#00c98d',
                  desc: 'Anyone brings equal USD value of any token. Price verified across 3 sources within ±0.5%. Pool must be 24h+ old with $300+ TVL.' },
                { n: '03', title: 'POOL CREATED',     color: '#bf5af2',
                  desc: 'XDEX pool created via CPI. LP: 5% to treasury, remainder split 50/50. Burn LP → earn LB points at ×1.888 rate.' },
              ].map(s => (
                <div key={s.n} style={{ background: 'rgba(255,255,255,.02)',
                  border: '1px solid rgba(255,255,255,.06)', borderRadius: 12,
                  padding: isMobile ? '16px' : '20px 22px', position: 'relative', overflow: 'hidden' }}>
                  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                    background: `linear-gradient(90deg,${s.color},transparent)` }} />
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 22 : 28,
                    fontWeight: 900, color: s.color, opacity: .35, marginBottom: 10 }}>{s.n}</div>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 10 : 12,
                    fontWeight: 900, color: '#e0f0ff', marginBottom: 8 }}>{s.title}</div>
                  <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 11 : 12,
                    color: '#6a8aaa', lineHeight: 1.7 }}>{s.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreate && publicKey && (
        <CreateListingModal isMobile={isMobile} publicKey={publicKey}
          connection={connection} signTransaction={signTransaction}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadListings(); }} />
      )}
      {showCreate && !publicKey && (
        <div onClick={() => setShowCreate(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.85)',
            backdropFilter: 'blur(16px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 14, color: '#9abacf', textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔌</div>
            CONNECT WALLET TO CREATE A LISTING
          </div>
        </div>
      )}
      {/* Match Modal */}
      {matchTarget && publicKey && (
        <MatchModal
          listing={matchTarget}
          isMobile={isMobile}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          onClose={() => setMatchTarget(null)}
          onMatched={() => { setMatchTarget(null); loadListings(); }}
        />
      )}
      {matchTarget && !publicKey && (
        <div onClick={() => setMatchTarget(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.85)',
            backdropFilter: 'blur(16px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 14, color: '#9abacf', textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔌</div>
            CONNECT WALLET TO MATCH
          </div>
        </div>
      )}

      {/* Delist Modal */}
      {delistTarget && publicKey && (
        <DelistModal
          listing={delistTarget}
          isMobile={isMobile}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          onClose={() => setDelistTarget(null)}
          onDelisted={() => { setDelistTarget(null); loadListings(); }}
        />
      )}

      {/* Edit Modal */}
      {editTarget && publicKey && (
        <EditModal
          listing={editTarget}
          isMobile={isMobile}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          onClose={() => setEditTarget(null)}
          onEdited={() => { setEditTarget(null); loadListings(); }}
        />
      )}
    </div>
  );
};

export default PairingMarketplace;