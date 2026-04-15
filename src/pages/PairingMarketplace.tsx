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
import PoolsTab from './PoolsTab';

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
  if (errStr.includes('not defined') || errStr.includes('locked')) return '🔒 Your wallet appears to be locked. Please unlock Backpack and try again.';
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

// ─── Copy-to-clipboard button ─────────────────────────────────────────────────
const CopyButton: FC<{ text: string; size?: number }> = ({ text, size = 11 }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button onClick={handleCopy} title={copied ? 'Copied!' : 'Copy address'} style={{
      background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px',
      color: copied ? '#00c98d' : '#3a5a6a', fontSize: size,
      lineHeight: 1, borderRadius: 4, flexShrink: 0,
      transition: 'color .15s',
    }}>
      {copied ? '✓' : '⎘'}
    </button>
  );
};

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
const _metaInflight = new Map<string, Promise<TokenMeta>>();

// Symbol/decimals only — NO logo here so fetchTokenMeta still runs the full fetch
const HARDCODED_META: Record<string, { symbol: string; name: string; decimals: number }> = {
  'So11111111111111111111111111111111111111112': { symbol: 'XNT',    name: 'X1 Native Token', decimals: 9  },
  'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN': { symbol: 'BRAINS', name: 'X1 Brains',       decimals: 9  },
  'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6': { symbol: 'LB',     name: 'Lab Work',        decimals: 2  },
};

// ── Exact original working 3-layer system ─────────────────────────────────────

async function fetchToken2022Meta(mint: string): Promise<TokenMeta | null> {
  try {
    const conn = new Connection(RPC, 'confirmed');
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const parsed = (info?.value?.data as any)?.parsed?.info;
    if (!parsed) return null;
    const decimals = parsed.decimals ?? 9;
    const extensions = parsed.extensions as any[] | undefined;
    if (!extensions) return null;
    const metaExt = extensions.find((e: any) => e.extension === 'tokenMetadata');
    if (!metaExt?.state) return null;
    const { name, symbol, uri } = metaExt.state;
    if (!symbol && !name) return null;
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
    let offset = 1 + 32 + 32;
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
    if (j?.success && j?.data) {
      return {
        symbol:   j.data.symbol   || mint.slice(0,6),
        name:     j.data.name     || mint.slice(0,6),
        logo:     j.data.logo || j.data.logoUri || j.data.image || j.data.icon,
        decimals: j.data.decimals ?? 9,
        source:   'xdex',
      };
    }
  } catch {}
  return null;
}

async function fetchTokenMeta(mint: string): Promise<TokenMeta> {
  // Cache hit with logo — return immediately
  if (_metaCache.has(mint) && _metaCache.get(mint)!.logo) return _metaCache.get(mint)!;
  // Cache hit without logo — still re-fetch to get logo
  // (HARDCODED_META tokens like BRAINS need their logo fetched from Token-2022 URI)

  // Deduplicate in-flight
  if (_metaInflight.has(mint)) return _metaInflight.get(mint)!;

  const promise = (async (): Promise<TokenMeta> => {
    const t22 = await fetchToken2022Meta(mint);
    if (t22) { _metaCache.set(mint, t22); return t22; }
    const mpx = await fetchMetaplexMeta(mint);
    if (mpx) { _metaCache.set(mint, mpx); return mpx; }
    const xdex = await fetchXdexMeta(mint);
    if (xdex) { _metaCache.set(mint, xdex); return xdex; }
    // Use hardcoded symbol/decimals if available, just no logo
    const hc = HARDCODED_META[mint];
    const fb: TokenMeta = { symbol: hc?.symbol ?? mint.slice(0,4).toUpperCase(), name: hc?.name ?? mint.slice(0,8), decimals: hc?.decimals ?? 9, source: 'fallback' };
    _metaCache.set(mint, fb);
    return fb;
  })().finally(() => _metaInflight.delete(mint));

  _metaInflight.set(mint, promise);
  return promise;
}

async function batchFetchLogos(mints: string[]): Promise<Map<string, string>> {
  const logos = new Map<string, string>();
  if (mints.length === 0) return logos;
  await Promise.allSettled(mints.map(async mint => {
    try {
      const cached = _metaCache.get(mint);
      if (cached?.logo) { logos.set(mint, cached.logo); return; }
      const meta = await fetchTokenMeta(mint);
      if (meta.logo) logos.set(mint, meta.logo);
    } catch {}
  }));
  return logos;
}

async function batchFetchMeta(mints: string[]): Promise<Map<string, TokenMeta>> {
  await Promise.allSettled([...new Set(mints)].map(m => fetchTokenMeta(m)));
  const result = new Map<string, TokenMeta>();
  mints.forEach(m => {
    const cached = _metaCache.get(m);
    const hc = HARDCODED_META[m];
    result.set(m, cached || {
      symbol: hc?.symbol ?? m.slice(0,4).toUpperCase(),
      name: hc?.name ?? m.slice(0,8),
      decimals: hc?.decimals ?? 9,
      source: 'fallback' as const,
    });
  });
  return result;
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


// ─── Fetch platform stats from GlobalState + pools ───────────────────────────
async function fetchPlatformStats(): Promise<{ totalVolume: number; totalPools: number; totalListings: number; totalFeeXnt: number }> {
  try {
    const conn = new Connection(RPC, 'confirmed');
    const programPk = new PublicKey(PROGRAM_ID);
    const [globalStatePda] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], programPk);

    // ── Read GlobalState ──────────────────────────────────────────────────────
    const gsInfo = await conn.getAccountInfo(globalStatePda);
    let totalPools = 0, totalListings = 0, totalFeeXnt = 0;
    if (gsInfo?.data && gsInfo.data.length >= 8 + 32 + 32 + 8 + 8 + 8) {
      let off = 8 + 32 + 32; // skip discriminator + admin + treasury
      totalFeeXnt   = Number(gsInfo.data.readBigUInt64LE(off)); off += 8;
      totalListings = Number(gsInfo.data.readBigUInt64LE(off)); off += 8;
      totalPools    = Number(gsInfo.data.readBigUInt64LE(off)); off += 8;
    }

    // ── Volume: sum usdVal from MATCHED PoolRecords only ─────────────────────
    // PoolRecord layout (after 8-byte discriminator):
    //   pool_address(32) + lp_mint(32) + tokenA(32) + tokenB(32)
    //   sym_a(12 fixed) + sym_b(12 fixed) + burn_bps(2) + lp_burned(8)
    //   lp_treasury(8) + lp_user_a(8) + lp_user_b(8) + creator_a(32) + creator_b(32)
    //   usd_val(8) at offset 8+32+32+32+32+12+12+2+8+8+8+8+32+32 = 258
    //   created_at(8) at 266, seeded(bool) at 274, bump(u8) at 275
    // usd_val here = the USD value of ONE side of the match (stored as u64 * 1e6)
    // Total volume = usd_val * 2 (both sides matched equal USD value)
    const poolRecords = await conn.getProgramAccounts(programPk, {
      filters: [{ dataSize: 282 }],
    });

    let totalVolume = 0;
    for (const { account } of poolRecords) {
      try {
        if (account.data[274] === 1) continue; // skip seeded/admin pools
        const usdVal = Number(account.data.readBigUInt64LE(258));
        if (usdVal > 0) totalVolume += (usdVal / 1_000_000) * 2;
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

    // Fetch all listing accounts in one RPC call
    const accounts = await conn.getProgramAccounts(programPk, {
      filters: [{ dataSize: 127 }],
    });

    // Step 1: Parse all accounts synchronously — no awaits, pure byte parsing
    const parsed: Array<{
      pubkey: string; mintStr: string; creator: string;
      tokenAAmount: bigint; tokenAUsdVal: bigint; tokenAXntVal: bigint;
      burnBps: number; isEcosystem: boolean;
    }> = [];

    for (const { pubkey, account } of accounts) {
      try {
        const data = account.data;
        let offset = 8;
        const creator    = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
        const tokenAMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
        const tokenAAmount = data.readBigUInt64LE(offset); offset += 8;
        const tokenAUsdVal = data.readBigUInt64LE(offset); offset += 8;
        const tokenAXntVal = data.readBigUInt64LE(offset); offset += 8;
        offset += 8; // skip mc
        const burnBps     = data.readUInt16LE(offset); offset += 2;
        const isEcosystem = data[offset] === 1; offset += 1;
        const statusByte  = data[offset];
        if (statusByte !== 0) continue; // only open listings
        parsed.push({ pubkey: pubkey.toBase58(), mintStr: tokenAMint.toBase58(),
          creator: creator.toBase58(), tokenAAmount, tokenAUsdVal, tokenAXntVal,
          burnBps, isEcosystem });
      } catch { continue; }
    }

    if (parsed.length === 0) return [];

    // Step 2: Fetch all metadata + decimals in parallel (one Promise.all)
    const uniqueMints = [...new Set(parsed.map(p => p.mintStr))];
    const [metaResults, mintInfoResults] = await Promise.all([
      // All metadata in parallel
      Promise.all(uniqueMints.map(mint => fetchTokenMeta(mint).catch(() => ({
        symbol: mint.slice(0,4).toUpperCase(), name: mint.slice(0,8),
        decimals: 9, source: 'fallback' as const
      })))),
      // All mint accounts in one multipleAccounts call (much faster than N individual calls)
      conn.getMultipleAccountsInfo(uniqueMints.map(m => new PublicKey(m))).catch(() => []),
    ]);

    // Build lookup maps
    const metaMap = new Map<string, typeof metaResults[0]>();
    const decimalsMap = new Map<string, number>();
    uniqueMints.forEach((mint, i) => {
      metaMap.set(mint, metaResults[i]);
      const mintInfo = mintInfoResults?.[i];
      if (mintInfo?.data && mintInfo.data.length >= 45) {
        decimalsMap.set(mint, (mintInfo.data as Buffer)[44]);
      } else {
        decimalsMap.set(mint, metaResults[i]?.decimals ?? 9);
      }
    });

    // Step 3: Assemble listings from maps — no more awaits
    const listings: ListingOnChain[] = parsed.map(p => {
      const meta     = metaMap.get(p.mintStr)!;
      const decimals = decimalsMap.get(p.mintStr) ?? 9;
      return {
        id:           p.pubkey,
        creator:      p.creator,
        tokenAMint:   p.mintStr,
        tokenASymbol: meta.symbol,
        tokenALogo:   meta.logo,
        amount:       Number(p.tokenAAmount),
        amountUi:     Number(p.tokenAAmount) / Math.pow(10, decimals),
        usdVal:       Number(p.tokenAUsdVal),
        usdValUi:     Number(p.tokenAUsdVal) / 1_000_000,
        xntVal:       Number(p.tokenAXntVal),
        burnBps:      p.burnBps,
        isEcosystem:  p.isEcosystem,
        status:       'open' as const,
        createdAt:    Date.now(),
      };
    });

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
  livePrice: number | null;
  onMatch: (l: ListingOnChain) => void;
  onEdit: (l: ListingOnChain) => void;
  onDelist: (l: ListingOnChain) => void;
}> = React.memo(({ listing, isMobile, idx, isOwn, xntPrice, lbBalance, livePrice, onMatch, onEdit, onDelist }) => {
  const burn     = BURN_OPTIONS.find(b => b.bps === listing.burnBps) || BURN_OPTIONS[0];
  const eachPct  = listing.burnBps < 10000 ? (10000 - listing.burnBps) / 2 / 100 : 0;

  // Fetch logo using full 3-layer system (Token-2022 URI → Metaplex → XDEX)
  const [logo, setLogo] = useState<string | undefined>(
    listing.tokenALogo || _metaCache.get(listing.tokenAMint)?.logo
  );
  useEffect(() => {
    if (logo) return;
    fetchTokenMeta(listing.tokenAMint).then(m => { if (m.logo) setLogo(m.logo); });
  }, [listing.tokenAMint]);

  // ── Live USD value derived from passed-in price (no self-fetch) ───────────
  // livePrice: null = not yet loaded, 0 = loaded but no price, >0 = has price
  const liveUsdVal  = livePrice != null && livePrice > 0 ? listing.amountUi * livePrice : listing.usdValUi;
  const liveXntVal  = xntPrice > 0 ? liveUsdVal / xntPrice : listing.xntVal / LAMPORTS_PER_SOL;
  const priceLoading = livePrice === null;
  // Price diff vs stored listing value — show badge once price is loaded
  const priceDiff   = (livePrice != null && livePrice > 0 && listing.usdValUi > 0)
    ? ((liveUsdVal - listing.usdValUi) / listing.usdValUi) * 100
    : 0;
  const priceUp     = priceDiff > 0.1;
  const priceDown   = priceDiff < -0.1;
  // Show badge whenever we have a live price — even if small change
  const showBadge   = livePrice != null && livePrice > 0 && Math.abs(priceDiff) >= 0.1;

  const liveUsdVal6   = Math.floor(liveUsdVal * 1_000_000);
  const xntPriceUSD6  = Math.floor((xntPrice || 0.4187) * 1_000_000);
  const matchFeeLamps = calculateFeeXnt(listing.isEcosystem, lbBalance, liveUsdVal6, xntPriceUSD6);
  const { xnt: matchFeeXnt, usd: matchFeeUsd } = feeXntToDisplay(matchFeeLamps, xntPriceUSD6);

  if (isMobile) {
    // ── MOBILE CARD — compact 2-row layout ──────────────────────────────────
    return (
      <div style={{
        background: '#0d1520', border: '1px solid rgba(255,255,255,.07)',
        borderRadius: 10, padding: '10px 12px', marginBottom: 6,
        position: 'relative', overflow: 'hidden',
        animation: `fadeUp 0.4s ease ${idx * 0.04}s both`,
      }}>
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 1,
          background: 'linear-gradient(90deg,transparent,rgba(255,140,0,.25),transparent)' }} />
        <div style={{ position: 'absolute', left: 0, top: '15%', bottom: '15%', width: 2, borderRadius: 2,
          background: listing.isEcosystem ? 'rgba(0,212,255,.4)' : 'rgba(255,140,0,.4)' }} />

        {/* Row 1 — logo + title + match button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <TokenLogo mint={listing.tokenAMint} logo={logo} symbol={listing.tokenASymbol} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap', overflow: 'hidden' }}>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 900,
                color: '#e0f0ff', letterSpacing: .3, whiteSpace: 'nowrap', overflow: 'hidden',
                textOverflow: 'ellipsis', maxWidth: 130 }}>
                {listing.tokenASymbol} / ANY
              </span>
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 8, flexShrink: 0,
                color: listing.isEcosystem ? 'rgba(0,212,255,.8)' : 'rgba(255,255,255,.4)',
                background: listing.isEcosystem ? 'rgba(0,212,255,.07)' : 'rgba(255,255,255,.05)',
                border: `1px solid ${listing.isEcosystem ? 'rgba(0,212,255,.2)' : 'rgba(255,255,255,.1)'}`,
                borderRadius: 3, padding: '1px 5px' }}>
                {listing.isEcosystem ? 'ECO' : 'OPEN'}
              </span>
              {listing.burnBps > 0 && (
                <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 8, flexShrink: 0,
                  color: 'rgba(255,140,0,.8)', background: 'rgba(255,140,0,.07)',
                  border: '1px solid rgba(255,140,0,.2)', borderRadius: 3, padding: '1px 5px' }}>
                  {burn.label} 🔥
                </span>
              )}
            </div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#3a5a6a', marginTop: 1 }}>
              by {truncAddr(listing.creator)}
            </div>
          </div>
          {/* Match/Edit/Delist */}
          {isOwn ? (
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button onClick={e => { e.stopPropagation(); onEdit(listing); }}
                style={{ padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                  background: 'rgba(0,212,255,.06)', border: '1px solid rgba(0,212,255,.2)',
                  fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700, color: '#00d4ff' }}>
                EDIT
              </button>
              <button onClick={e => { e.stopPropagation(); onDelist(listing); }}
                style={{ padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
                  background: 'rgba(255,68,68,.04)', border: '1px solid rgba(255,68,68,.15)',
                  fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700, color: '#ff6666' }}>
                DELIST
              </button>
            </div>
          ) : (
            <button onClick={e => { e.stopPropagation(); onMatch(listing); }}
              style={{ padding: '7px 14px', borderRadius: 8, cursor: 'pointer', flexShrink: 0,
                background: 'linear-gradient(135deg,rgba(0,255,128,.15),rgba(0,200,100,.06))',
                border: '1px solid rgba(0,255,128,.4)',
                fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 900, color: '#00ff80' }}>
              ⚡ MATCH
            </button>
          )}
        </div>

        {/* Row 2 — amount + price + chips */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap', alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 8,
              color: 'rgba(255,255,255,.2)', background: 'rgba(255,255,255,.03)',
              border: '1px solid rgba(255,255,255,.06)', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
              LP {eachPct > 0 ? `${eachPct}%` : 'None'}
            </span>
            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 8,
              color: 'rgba(255,255,255,.2)', background: 'rgba(255,255,255,.03)',
              border: '1px solid rgba(255,255,255,.06)', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
              {fmtXNT(matchFeeXnt)}
            </span>
            {listing.burnBps > 0 && (
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 8,
                color: 'rgba(255,140,0,.6)', background: 'rgba(255,140,0,.05)',
                border: '1px solid rgba(255,140,0,.12)', borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
                ×1.888 LB
              </span>
            )}
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontWeight: 900, fontSize: 12,
              color: '#e0f0ff', whiteSpace: 'nowrap' }}>
              {fmtNum(listing.amountUi)} {listing.tokenASymbol}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, color: '#9abacf' }}>
                {priceLoading ? '…' : fmtUSD(liveUsdVal)}
              </span>
              {!priceLoading && showBadge && (
                <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 8,
                  color: priceUp ? '#00c98d' : '#ff4444',
                  background: priceUp ? 'rgba(0,201,141,.08)' : 'rgba(255,68,68,.08)',
                  border: `1px solid ${priceUp ? 'rgba(0,201,141,.2)' : 'rgba(255,68,68,.2)'}`,
                  borderRadius: 3, padding: '1px 4px' }}>
                  {priceUp ? '▲' : '▼'}{Math.abs(priceDiff).toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── DESKTOP CARD ────────────────────────────────────────────────────────────
  return (
    <div style={{
      background: '#0d1520',
      border: '1px solid rgba(255,255,255,.07)',
      borderRadius: 12, padding: '14px 18px',
      marginBottom: 8, position: 'relative', overflow: 'hidden',
      animation: `fadeUp 0.4s ease ${idx * 0.04}s both`, transition: 'border-color 0.18s',
      display: 'flex', alignItems: 'center', gap: 14,
    }}
    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,140,0,.25)'; }}
    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,.07)'; }}>

      {/* Orange bottom accent line */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 1,
        background: 'linear-gradient(90deg,transparent,rgba(255,140,0,.3),transparent)' }} />

      {/* Left accent bar */}
      <div style={{ position: 'absolute', left: 0, top: '15%', bottom: '15%', width: 2, borderRadius: 2,
        background: listing.isEcosystem ? 'rgba(0,212,255,.4)' : 'rgba(255,140,0,.4)' }} />

      {/* Logo */}
      <TokenLogo mint={listing.tokenAMint} logo={logo} symbol={listing.tokenASymbol} size={42} />

      {/* Left content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 14,
            fontWeight: 900, color: '#e0f0ff', letterSpacing: .5 }}>
            {listing.tokenASymbol} / ANY TOKEN
          </span>
          <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9,
            color: listing.isEcosystem ? 'rgba(0,212,255,.8)' : 'rgba(255,255,255,.4)',
            background: listing.isEcosystem ? 'rgba(0,212,255,.07)' : 'rgba(255,255,255,.05)',
            border: `1px solid ${listing.isEcosystem ? 'rgba(0,212,255,.2)' : 'rgba(255,255,255,.1)'}`,
            borderRadius: 4, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: .5 }}>
            {listing.isEcosystem ? 'ECOSYSTEM' : 'OPEN'}
          </span>
          {listing.burnBps > 0 && (
            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9,
              color: 'rgba(255,140,0,.8)', background: 'rgba(255,140,0,.07)',
              border: '1px solid rgba(255,140,0,.2)',
              borderRadius: 4, padding: '1px 7px', textTransform: 'uppercase', letterSpacing: .5 }}>
              {burn.label} BURN
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#3a5a6a' }}>
            by {truncAddr(listing.creator)}
          </span>
          <CopyButton text={listing.creator} />
          <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9,
            color: 'rgba(255,255,255,.25)', background: 'rgba(255,255,255,.03)',
            border: '1px solid rgba(255,255,255,.06)', borderRadius: 4, padding: '1px 7px' }}>
            LP {eachPct > 0 ? `${eachPct}% each` : 'None'}
          </span>
          <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9,
            color: 'rgba(255,255,255,.25)', background: 'rgba(255,255,255,.03)',
            border: '1px solid rgba(255,255,255,.06)', borderRadius: 4, padding: '1px 7px' }}>
            FEE: {fmtXNT(matchFeeXnt)} ({fmtUSD(matchFeeUsd)})
          </span>
          {listing.burnBps > 0 && (
            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9,
              color: 'rgba(255,140,0,.6)', background: 'rgba(255,140,0,.05)',
              border: '1px solid rgba(255,140,0,.12)', borderRadius: 4, padding: '1px 7px' }}>
              LB PTS ×1.888
            </span>
          )}
        </div>
      </div>

      {/* Right — amount + price + match */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontWeight: 900,
            fontSize: 16, letterSpacing: .5, color: '#e0f0ff', marginBottom: 2 }}>
            {fmtNum(listing.amountUi)} {listing.tokenASymbol}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12,
              fontWeight: 700, color: '#9abacf' }}>
              {priceLoading ? '…' : fmtUSD(liveUsdVal)}
            </span>
            {!priceLoading && showBadge && (
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9,
                color: priceUp ? '#00c98d' : '#ff4444',
                background: priceUp ? 'rgba(0,201,141,.08)' : 'rgba(255,68,68,.08)',
                border: `1px solid ${priceUp ? 'rgba(0,201,141,.2)' : 'rgba(255,68,68,.2)'}`,
                borderRadius: 4, padding: '1px 5px' }}>
                {priceUp ? '▲' : '▼'}{Math.abs(priceDiff).toFixed(1)}%
              </span>
            )}
          </div>
          {livePrice != null && livePrice > 0 && (
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 8, color: '#2a4a5a', marginTop: 2 }}>
              @ {livePrice < 0.000001 ? livePrice.toExponential(3) : livePrice.toFixed(6)} USD/{listing.tokenASymbol}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {isOwn ? (
            <>
              <button onClick={(e) => { e.stopPropagation(); onEdit(listing); }}
                style={{ padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
                  background: 'rgba(0,212,255,.06)', border: '1px solid rgba(0,212,255,.2)',
                  fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: '#00d4ff' }}>
                EDIT
              </button>
              <button onClick={(e) => { e.stopPropagation(); onDelist(listing); }}
                style={{ padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
                  background: 'rgba(255,68,68,.04)', border: '1px solid rgba(255,68,68,.15)',
                  fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: '#ff6666' }}>
                DELIST
              </button>
            </>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); onMatch(listing); }}
              style={{ padding: '9px 20px', borderRadius: 9, cursor: 'pointer',
                background: 'linear-gradient(135deg,rgba(0,255,128,.15),rgba(0,200,100,.06))',
                border: '1px solid rgba(0,255,128,.4)',
                fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 900,
                color: '#00ff80', whiteSpace: 'nowrap' }}>
              ⚡ MATCH
            </button>
          )}
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
          // Skip NFTs: decimals 0 or 1 are NFTs/semi-fungibles — not listable
          if (dec <= 1) continue;
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
        { pubkey: mintPk,                             isSigner: false, isWritable: true  }, // token_a_mint — writable for Token-2022 transfer fee withheld tracking
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

      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
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
  livePrice: number | null;
  onClose: () => void;
  onMatched: () => void;
}> = ({ listing, isMobile, publicKey, connection, signTransaction, livePrice, onClose, onMatched }) => {
  const [tokenBMint, setTokenBMint] = useState('');
  const [tokenBMeta, setTokenBMeta] = useState<{symbol:string;logo?:string;decimals:number;balance:number;price:number;hasPool:boolean;checking:boolean} | null>(null);
  const [amount, setAmount]         = useState('');
  const [status, setStatus]         = useState('');
  const [pending, setPending]       = useState(false);
  const [txSig, setTxSig] = useState("");
  const [xntPrice, setXntPrice]     = useState(0.4187);
  const [lbRaw, setLbRaw]           = useState(0);
  // Live USD value — derived from passed-in livePrice prop (no self-fetch needed)
  const liveUsdValUi = livePrice != null && livePrice > 0
    ? listing.amountUi * livePrice
    : listing.usdValUi;
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
          // Skip NFTs: decimals 0 or 1
          if (dec <= 1) continue;
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
  const usdValA    = liveUsdValUi;
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
            const pointsEach = Math.floor(liveUsdValUi * burnedFraction * 1.888);
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
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', display: 'flex', alignItems: 'center', gap: 4 }}>
                {fmtUSD(liveUsdValUi)} · {listing.burnBps / 100}% burn · by {truncAddr(listing.creator)}
                <CopyButton text={listing.creator} />
              </div>
            </div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 900,
              color: '#ff8c00', background: 'rgba(255,140,0,.1)', border: '1px solid rgba(255,140,0,.25)',
              borderRadius: 8, padding: '4px 12px' }}>
              YOU NEED ≈{fmtUSD(liveUsdValUi)}
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
                    const optAmt = liveUsdValUi / t.price;
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
                      color: usdVal >= liveUsdValUi * 0.995 ? '#00c98d' : usdVal > 0 ? '#ff8c00' : '#4a6a8a' }}>
                      {fmtUSD(usdVal)}
                    </div>
                    {usdVal < liveUsdValUi * 0.995 && usdVal > 0 && (
                      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#ff6666' }}>
                        INSUFFICIENT
                      </div>
                    )}
                    {usdVal >= liveUsdValUi * 0.995 && (
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
              AMOUNT TO DEPOSIT (must equal ≈{fmtUSD(liveUsdValUi)})
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
                        ✗ needs to be ≈{fmtUSD(liveUsdValUi)} (±0.5%)
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
              {fmtUSD(liveUsdValUi)}
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
      // Create creator ATA if it doesn't exist — use idempotent version for Token-2022 safety
      const creatorAtaInfo = await connection.getAccountInfo(creatorAta);
      if (!creatorAtaInfo) {
        const { createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
        tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, creatorAta, publicKey, mintPk, tokenProg));
      }
      tx.add(ix);
      setStatus('Waiting for wallet approval…');
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setStatus('Confirming…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error(decodeProgramError(JSON.stringify(st.value.err)));
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
                {fmtUSD(liveUsdValUi)} · {listing.burnBps / 100}% burn
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

// ─── SWAP TAB ─────────────────────────────────────────────────────────────────
// Pinned tokens always shown at top regardless of wallet
// Known token logos and metadata — hardcoded for pinned/common tokens on X1
const XNT_TOKEN_DEFAULT: WalletToken    = { mint: 'So11111111111111111111111111111111111111112', symbol: 'XNT',    decimals: 9, logo: undefined, balance: 0, rawBalance: 0n, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', pinned: true };
const BRAINS_TOKEN_DEFAULT: WalletToken = { mint: 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN', symbol: 'BRAINS', decimals: 9, logo: undefined, balance: 0, rawBalance: 0n, program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', pinned: true };

interface WalletToken {
  mint: string; symbol: string; decimals: number;
  logo?: string; balance: number; rawBalance: bigint; program: string;
  pinned?: boolean;
}

const SwapTab: FC<{
  isMobile: boolean; publicKey: PublicKey | null;
  connection: Connection; signTransaction: any;
}> = ({ isMobile, publicKey, connection, signTransaction }) => {
  const [walletTokens, setWalletTokens] = useState<WalletToken[]>([]);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [tokenIn,  setTokenIn]  = useState<WalletToken>(XNT_TOKEN_DEFAULT);
  const [tokenOut, setTokenOut] = useState<WalletToken>(BRAINS_TOKEN_DEFAULT);

  // Fetch logos for both pinned tokens on mount from XDEX API
  useEffect(() => {
    const mints = [WXNT_MINT, BRAINS_MINT];
    batchFetchLogos(mints).then(logos => {
      const xntLogo    = logos.get(WXNT_MINT);
      const brainsLogo = logos.get(BRAINS_MINT);
      if (xntLogo)    setTokenIn(prev  => prev.mint === WXNT_MINT   ? { ...prev, logo: xntLogo    } : prev);
      if (brainsLogo) setTokenOut(prev => prev.mint === BRAINS_MINT ? { ...prev, logo: brainsLogo } : prev);
    });
  }, []);
  const [amtIn, setAmtIn]       = useState('');
  const [poolState, setPoolState] = useState<any>(null);
  const [status, setStatus]     = useState('');
  const [pending, setPending]   = useState(false);
  const [loadingPool, setLoadingPool] = useState(false);
  const [quoteOut, setQuoteOut] = useState(0);
  const [priceImpact, setPriceImpact] = useState(0);
  const [slipBps, setSlipBps]   = useState(50);
  const [showInPicker,  setShowInPicker]  = useState(false);
  const [showOutPicker, setShowOutPicker] = useState(false);
  const [xntPriceUsd, setXntPriceUsd] = useState(0.4187);
  const [tokenInPriceUsd,  setTokenInPriceUsd]  = useState(0);
  const [tokenOutPriceUsd, setTokenOutPriceUsd] = useState(0);
  const [vaultIn, setVaultIn]   = useState(0n);
  const [vaultOut, setVaultOut] = useState(0n);
  const [lastTxSig, setLastTxSig] = useState('');

  async function rpc(method: string, params: any[]) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  function readPk(d: Uint8Array, o: number) { return new PublicKey(d.slice(o, o + 32)).toBase58(); }
  function readU64b(d: Uint8Array, o: number) { return new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true); }
  async function discHash(name: string) {
    const h = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${name}`));
    return Buffer.from(new Uint8Array(h).slice(0, 8));
  }
  async function getVaultBal(addr: string): Promise<bigint> {
    try { const r = await rpc('getAccountInfo', [addr, { encoding: 'base64' }]); if (!r?.value) return 0n; return readU64b(new Uint8Array(Buffer.from(r.value.data[0], 'base64')), 64); } catch { return 0n; }
  }

  // Fetch XNT price
  useEffect(() => {
    fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${WXNT_MINT}`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then(j => { if (j.success && j.data?.price) setXntPriceUsd(Number(j.data.price)); }).catch(() => {});
  }, []);

  // Fetch USD prices for selected tokens whenever they change
  useEffect(() => {
    const fetchPrice = async (mint: string, setter: (p: number) => void) => {
      if (mint === WXNT_MINT) { setter(xntPriceUsd); return; }
      try {
        const r = await fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${mint}`, { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        if (j.success && j.data?.price) setter(Number(j.data.price));
        else setter(0);
      } catch { setter(0); }
    };
    fetchPrice(tokenIn.mint,  setTokenInPriceUsd);
    fetchPrice(tokenOut.mint, setTokenOutPriceUsd);
  }, [tokenIn.mint, tokenOut.mint, xntPriceUsd]);

  const [refreshing, setRefreshing] = useState(false);

  // ── Refresh all balances + prices ─────────────────────────────────────────────
  const refreshAll = useCallback(async () => {
    if (!publicKey || refreshing) return;
    setRefreshing(true);
    try {
      // Refresh XNT price
      fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${WXNT_MINT}`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.json()).then(j => { if (j.success && j.data?.price) setXntPriceUsd(Number(j.data.price)); }).catch(() => {});

      // Refresh vault balances if pool is loaded
      if (poolState) {
        const t0IsIn = poolState.token0Mint === tokenIn.mint;
        const [vi, vo] = await Promise.all([
          getVaultBal(t0IsIn ? poolState.token0Vault : poolState.token1Vault),
          getVaultBal(t0IsIn ? poolState.token1Vault : poolState.token0Vault),
        ]);
        setVaultIn(vi); setVaultOut(vo);
      }

      // Refresh wallet token balances + native XNT
      const [spl, t22, nativeLamps] = await Promise.all([
        rpc('getTokenAccountsByOwner', [publicKey.toBase58(), { programId: TOKEN_PROGRAM_ID.toBase58() }, { encoding: 'base64' }]),
        rpc('getTokenAccountsByOwner', [publicKey.toBase58(), { programId: TOKEN_2022_PROGRAM_ID.toBase58() }, { encoding: 'base64' }]),
        rpc('getBalance', [publicKey.toBase58()]),
      ]);
      const nativeXntBal = (nativeLamps?.value ?? 0) / 1e9;
      const nativeXntRaw = BigInt(nativeLamps?.value ?? 0);

      const all = [
        ...(spl?.value || []).map((a: any) => ({ ...a, prog: TOKEN_PROGRAM_ID.toBase58() })),
        ...(t22?.value || []).map((a: any) => ({ ...a, prog: TOKEN_2022_PROGRAM_ID.toBase58() })),
      ];
      const balMap = new Map<string, { raw: bigint; prog: string }>();
      for (const acc of all) {
        try {
          const d = new Uint8Array(Buffer.from(acc.account.data[0], 'base64'));
          const mint = readPk(d, 0);
          const raw  = readU64b(d, 64);
          if (raw > 0n) balMap.set(mint, { raw, prog: acc.prog });
        } catch {}
      }
      // Native XNT: always use getBalance, not token account
      setTokenIn(prev => {
        if (prev.mint === WXNT_MINT) return { ...prev, balance: nativeXntBal, rawBalance: nativeXntRaw };
        const b = balMap.get(prev.mint);
        return b ? { ...prev, balance: Number(b.raw) / Math.pow(10, prev.decimals), rawBalance: b.raw } : { ...prev, balance: 0, rawBalance: 0n };
      });
      setTokenOut(prev => {
        if (prev.mint === WXNT_MINT) return { ...prev, balance: nativeXntBal, rawBalance: nativeXntRaw };
        const b = balMap.get(prev.mint);
        return b ? { ...prev, balance: Number(b.raw) / Math.pow(10, prev.decimals), rawBalance: b.raw } : { ...prev, balance: 0, rawBalance: 0n };
      });
      // Update full wallet list — native XNT injected directly
      setWalletTokens(prev => prev.map(t => {
        if (t.mint === WXNT_MINT) return { ...t, balance: nativeXntBal, rawBalance: nativeXntRaw };
        const b = balMap.get(t.mint);
        return b ? { ...t, balance: Number(b.raw) / Math.pow(10, t.decimals), rawBalance: b.raw } : t;
      }));
    } catch {}
    finally { setRefreshing(false); }
  }, [publicKey, poolState, tokenIn.mint, tokenOut.mint, refreshing]);

  // ── Load all wallet token accounts — batch fetch all metadata at once ────────
  useEffect(() => {
    if (!publicKey) { setWalletTokens([]); return; }
    setLoadingWallet(true);
    (async () => {
      try {
        // Step 1: Get all token accounts AND native XNT balance in parallel
        const conn2 = new Connection(RPC, 'confirmed');
        const [spl, t22, nativeLamports] = await Promise.all([
          conn2.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
          conn2.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
          conn2.getBalance(publicKey).catch(() => 0),
        ]);

        const nativeXntBalance = nativeLamports / 1e9;
        const nativeXntRaw     = BigInt(nativeLamports);

        // Step 2: Parse and filter immediately — no metadata fetch needed for NFT detection
        const raw: { mint: string; rawBalance: bigint; balance: number; decimals: number; program: string }[] = [];
        for (const { account } of [...spl.value, ...t22.value]) {
          try {
            const info = (account.data as any).parsed?.info;
            if (!info) continue;
            const mint     = info.mint as string;
            const decimals = info.tokenAmount?.decimals as number ?? 0;
            const rawAmt   = BigInt(info.tokenAmount?.amount ?? '0');
            const uiAmt    = info.tokenAmount?.uiAmount as number ?? 0;
            // Filter: skip zero balance, skip NFTs (decimals 0 or 1)
            if (rawAmt === 0n || decimals <= 1) continue;
            const prog = account.owner.toBase58();
            raw.push({ mint, rawBalance: rawAmt, balance: uiAmt, decimals, program: prog });
          } catch {}
        }

        // Step 3: Show tokens immediately with just decimals/balance while metadata loads
        // Use cached metadata if available
        const quickTokens: WalletToken[] = raw.map(r => {
          const cached = _metaCache.get(r.mint);
          return {
            mint: r.mint, symbol: cached?.symbol ?? r.mint.slice(0,4).toUpperCase(),
            decimals: r.decimals, logo: cached?.logo,
            balance: r.balance, rawBalance: r.rawBalance, program: r.program,
          };
        }).sort((a, b) => b.balance - a.balance);
        setWalletTokens(quickTokens);

        // Step 4: Batch fetch metadata for all mints in parallel
        const allMints = raw.map(r => r.mint);
        const metaMap = await batchFetchMeta(allMints);

        // Step 5: Update with full metadata
        const tokens: WalletToken[] = raw.map(r => {
          const meta = metaMap.get(r.mint) || _metaCache.get(r.mint);
          return {
            mint: r.mint,
            symbol: meta?.symbol ?? r.mint.slice(0,4).toUpperCase(),
            decimals: r.decimals, // use decimals from chain, NOT from meta
            logo: meta?.logo,
            balance: r.balance, rawBalance: r.rawBalance, program: r.program,
          };
        }).sort((a, b) => b.balance - a.balance);

        // Step 6: Fetch missing logos in background (non-blocking)
        const missingLogoMints = tokens.filter(t => !t.logo).map(t => t.mint);
        if (missingLogoMints.length > 0) {
          batchFetchLogos(missingLogoMints).then(logos => {
            setWalletTokens(prev => prev.map(t => ({ ...t, logo: logos.get(t.mint) || t.logo })));
          });
        }

        setWalletTokens(tokens);

        // Native XNT: fetched via getBalance() — NOT from token accounts
        // Always update XNT balance from native lamports regardless of token account
        const xntNativeMeta = _metaCache.get(WXNT_MINT);
        setTokenIn(prev => prev.mint === XNT_TOKEN_DEFAULT.mint
          ? { ...prev, balance: nativeXntBalance, rawBalance: nativeXntRaw, logo: xntNativeMeta?.logo || prev.logo }
          : prev);
        // Also inject native XNT into walletTokens so picker shows correct balance
        setWalletTokens(prev => {
          const withoutXnt = prev.filter(t => t.mint !== WXNT_MINT);
          const xntEntry: WalletToken = {
            mint: WXNT_MINT, symbol: 'XNT', decimals: 9,
            logo: xntNativeMeta?.logo,
            balance: nativeXntBalance, rawBalance: nativeXntRaw,
            program: TOKEN_PROGRAM_ID.toBase58(),
            pinned: true,
          };
          return [xntEntry, ...withoutXnt];
        });

        const brainsW = tokens.find(t => t.mint === BRAINS_TOKEN_DEFAULT.mint);
        if (brainsW) setTokenOut(prev => prev.mint === BRAINS_TOKEN_DEFAULT.mint ? { ...prev, balance: brainsW.balance, rawBalance: brainsW.rawBalance, logo: brainsW.logo || prev.logo } : prev);
        setTokenOut(prev => prev.logo ? prev : { ...prev, logo: tokens.find(t => t.mint === prev.mint)?.logo });
      } catch (e) { console.error('wallet load error', e); }
      finally { setLoadingWallet(false); }
    })();
  }, [publicKey]);

  // ── Find XDEX pool ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!tokenIn?.mint || !tokenOut?.mint || tokenIn.mint === tokenOut.mint) { setPoolState(null); setStatus(''); return; }
    setLoadingPool(true); setStatus(''); setQuoteOut(0);
    (async () => {
      try {
        const [m0, m1] = [tokenIn.mint, tokenOut.mint].sort();

        let foundPool: any = null;

        // Helper: read pool state from raw account data
        const parsePoolAccount = (data: Uint8Array, address: string) => {
          const D = 8;
          return { address,
            ammConfig:   readPk(data, D),
            token0Vault: readPk(data, D+64),
            token1Vault: readPk(data, D+96),
            token0Mint:  readPk(data, D+160),
            token1Mint:  readPk(data, D+192),
            token0Prog:  readPk(data, D+224),
            token1Prog:  readPk(data, D+256),
            obsKey:      readPk(data, D+288),
            dec0: data[D+331] || 9,
            dec1: data[D+332] || 9,
          };
        };

        // ── Method 1: XDEX API — covers all pools created through their UI ────────
        // This is the most reliable for XDEX-native pools (like XNT/BRAINS)
        if (!foundPool) {
          try {
            const endpoints = [
              `/api/xdex-price/api/xendex/pool/tokens/${tokenIn.mint}/${tokenOut.mint}?network=mainnet`,
              `/api/xdex-price/api/xendex/pool/tokens/${tokenOut.mint}/${tokenIn.mint}?network=mainnet`,
              `/api/xdex-price/api/xendex/pool/tokens/${m0}/${m1}?network=mainnet`,
            ];
            for (const url of endpoints) {
              try {
                const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
                const j = await r.json();
                const poolData = j.success && j.data ? j.data : null;
                if (!poolData) continue;
                // API may return pool address under different keys
                const poolAddr = poolData.poolAddress || poolData.pool_address || poolData.id || poolData.address || poolData.poolId;
                if (!poolAddr) continue;
                const res = await rpc('getAccountInfo', [poolAddr, { encoding: 'base64' }]);
                if (res?.value) {
                  foundPool = parsePoolAccount(new Uint8Array(Buffer.from(res.value.data[0], 'base64')), poolAddr);
                  break;
                }
              } catch {}
            }
          } catch {}
        }

        // ── Method 2: XDEX pool list search ──────────────────────────────────────
        if (!foundPool) {
          try {
            const listEndpoints = [
              `/api/xdex-price/api/xendex/pool/list?network=mainnet&token=${tokenIn.mint}`,
              `/api/xdex-price/api/xendex/pool/list?network=mainnet&token=${tokenOut.mint}`,
              `/api/xdex-price/api/xendex/pools?network=mainnet&token0=${m0}&token1=${m1}`,
            ];
            for (const url of listEndpoints) {
              try {
                const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
                const j = await r.json();
                const list: any[] = Array.isArray(j) ? j : (j?.data ?? j?.pools ?? j?.result ?? []);
                // Find pool that matches both mints
                const match = list.find((p: any) => {
                  const mints = [p.token0Mint, p.token1Mint, p.mintA, p.mintB, p.token0, p.token1].filter(Boolean);
                  return mints.includes(tokenIn.mint) && mints.includes(tokenOut.mint);
                });
                if (match) {
                  const poolAddr = match.poolAddress || match.pool_address || match.id || match.address;
                  if (poolAddr) {
                    const res = await rpc('getAccountInfo', [poolAddr, { encoding: 'base64' }]);
                    if (res?.value) {
                      foundPool = parsePoolAccount(new Uint8Array(Buffer.from(res.value.data[0], 'base64')), poolAddr);
                      break;
                    }
                  }
                }
              } catch {}
              if (foundPool) break;
            }
          } catch {}
        }

        // ── Method 3: PDA derivation — try all known AMM configs ─────────────────
        if (!foundPool) {
          const AMM_CONFIGS = [
            '2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c',
            'GVSwm4smQBYcgAJU7qjFHLQBHTc4AdB3F2HbZp6KqKof',
            'FcRvM5tEfmAKdVLnRmBFdWkACCUXhVmhFwfCDsJ4XDEP',
            'CQYbhr6amxUER4p5SC44C63R4qw4NFc9Z4Db9vF4tZwG',
          ];
          for (const cfg of AMM_CONFIGS) {
            try {
              const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), new PublicKey(cfg).toBuffer(),
                 new PublicKey(m0).toBuffer(), new PublicKey(m1).toBuffer()],
                new PublicKey(XDEX_PROGRAM)
              );
              const res = await rpc('getAccountInfo', [poolPda.toBase58(), { encoding: 'base64' }]);
              if (res?.value) {
                foundPool = parsePoolAccount(new Uint8Array(Buffer.from(res.value.data[0], 'base64')), poolPda.toBase58());
                break;
              }
            } catch {}
          }
        }

        // ── Method 4: Our own PoolRecords (CPI-created pools) ────────────────────
        if (!foundPool) {
          try {
            const poolRecords = await rpc('getProgramAccounts', [PROGRAM_ID, {
              encoding: 'base64', filters: [{ dataSize: 282 }]
            }]);
            for (const { account } of (poolRecords || [])) {
              const d = new Uint8Array(Buffer.from(account.data[0], 'base64'));
              const tokenA = readPk(d, 8 + 64);
              const tokenB = readPk(d, 8 + 96);
              if (d[281] === 1) continue; // skip seeded
              const matches = (tokenA === m0 && tokenB === m1) || (tokenA === m1 && tokenB === m0);
              if (matches) {
                const poolAddr = readPk(d, 8);
                const res = await rpc('getAccountInfo', [poolAddr, { encoding: 'base64' }]);
                if (res?.value) {
                  foundPool = parsePoolAccount(new Uint8Array(Buffer.from(res.value.data[0], 'base64')), poolAddr);
                  break;
                }
              }
            }
          } catch {}
        }

        if (!foundPool) {
          setPoolState(null);
          setStatus('⚠️ No XDEX pool found for this pair. Make sure a pool exists on XDEX for these tokens.');
          return;
        }

        setPoolState(foundPool);
        // Pre-fetch vault balances
        const t0IsIn = foundPool.token0Mint === tokenIn.mint;
        const [vi, vo] = await Promise.all([
          getVaultBal(t0IsIn ? foundPool.token0Vault : foundPool.token1Vault),
          getVaultBal(t0IsIn ? foundPool.token1Vault : foundPool.token0Vault),
        ]);
        setVaultIn(vi); setVaultOut(vo);
        setStatus('');
      } catch (e) { console.error('pool find error', e); setPoolState(null); setStatus('❌ Error finding pool.'); }
      finally { setLoadingPool(false); }
    })();
  }, [tokenIn?.mint, tokenOut?.mint]);

  // ── Compute quote ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!poolState || !amtIn || isNaN(parseFloat(amtIn)) || parseFloat(amtIn) <= 0 || vaultIn === 0n) { setQuoteOut(0); setPriceImpact(0); return; }
    const rawIn  = BigInt(Math.floor(parseFloat(amtIn) * Math.pow(10, tokenIn.decimals)));
    const amtFee = rawIn * 997500n / 1_000_000n;
    const rawOut = vaultIn > 0n && vaultOut > 0n ? amtFee * vaultOut / (vaultIn + amtFee) : 0n;
    setQuoteOut(Number(rawOut) / Math.pow(10, tokenOut.decimals));
    setPriceImpact(vaultIn > 0n ? Number(rawIn * 10_000n / (vaultIn + rawIn)) / 100 : 0);
  }, [amtIn, vaultIn, vaultOut, tokenIn, tokenOut]);

  // ── Execute swap ──────────────────────────────────────────────────────────────
  const handleSwap = async () => {
    if (!publicKey || !poolState || !amtIn || parseFloat(amtIn) <= 0) return;
    setPending(true); setStatus('Building swap transaction…');
    try {
      const { Transaction: Tx, TransactionInstruction: TxIx, SystemProgram: SP } = await import('@solana/web3.js');
      const {
        createAssociatedTokenAccountIdempotentInstruction: createAta,
        createSyncNativeInstruction,
        createCloseAccountInstruction,
        NATIVE_MINT,
      } = await import('@solana/spl-token');
      const conn = new Connection(RPC, 'confirmed');
      const t0IsIn = poolState.token0Mint === tokenIn.mint;
      const rawIn  = BigInt(Math.floor(parseFloat(amtIn) * Math.pow(10, tokenIn.decimals)));
      // Refresh vault balances fresh
      const [vi, vo] = await Promise.all([getVaultBal(t0IsIn ? poolState.token0Vault : poolState.token1Vault), getVaultBal(t0IsIn ? poolState.token1Vault : poolState.token0Vault)]);
      const amtFee = rawIn * 997500n / 1_000_000n;
      const rawOut = vi > 0n && vo > 0n ? amtFee * vo / (vi + amtFee) : 0n;
      const minOut = rawOut * BigInt(10_000 - slipBps) / 10_000n;
      const inputMint  = new PublicKey(tokenIn.mint);
      const outputMint = new PublicKey(tokenOut.mint);
      const inputProg  = new PublicKey(tokenIn.program);
      const outputProg = new PublicKey(t0IsIn ? poolState.token1Prog : poolState.token0Prog);
      const inputAta   = getAssociatedTokenAddressSync(inputMint, publicKey, false, inputProg);
      const outputAta  = getAssociatedTokenAddressSync(outputMint, publicKey, false, outputProg);
      const d = await discHash('swap_base_input');
      const data = Buffer.alloc(24); d.copy(data, 0); data.writeBigUInt64LE(rawIn, 8); data.writeBigUInt64LE(minOut, 16);
      const keys = [
        { pubkey: publicKey,                              isSigner: true,  isWritable: false },
        { pubkey: new PublicKey(XDEX_LP_AUTH),            isSigner: false, isWritable: false },
        { pubkey: new PublicKey(poolState.ammConfig),     isSigner: false, isWritable: false },
        { pubkey: new PublicKey(poolState.address),       isSigner: false, isWritable: true  },
        { pubkey: inputAta,                               isSigner: false, isWritable: true  },
        { pubkey: outputAta,                              isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(t0IsIn ? poolState.token0Vault : poolState.token1Vault), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(t0IsIn ? poolState.token1Vault : poolState.token0Vault), isSigner: false, isWritable: true },
        { pubkey: inputProg,                              isSigner: false, isWritable: false },
        { pubkey: outputProg,                             isSigner: false, isWritable: false },
        { pubkey: inputMint,                              isSigner: false, isWritable: false },
        { pubkey: outputMint,                             isSigner: false, isWritable: false },
        { pubkey: new PublicKey(poolState.obsKey),        isSigner: false, isWritable: true  },
      ];
      const ix = new TxIx({ programId: new PublicKey(XDEX_PROGRAM), keys, data });
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new Tx({ feePayer: publicKey, recentBlockhash: blockhash });

      const isNativeXntIn  = tokenIn.mint  === WXNT_MINT;
      const isNativeXntOut = tokenOut.mint === WXNT_MINT;

      // ── If swapping FROM native XNT: wrap lamports → wXNT token account first ──
      // 1. Create wXNT ATA if it doesn't exist
      // 2. Transfer exact lamports into it
      // 3. SyncNative to update the token account balance
      // 4. Swap instruction
      // 5. Close wXNT ATA after swap to recover lamports (cleanup)
      if (isNativeXntIn) {
        const inputAtaInfo = await conn.getAccountInfo(inputAta);
        if (!inputAtaInfo) {
          tx.add(createAta(publicKey, inputAta, publicKey, inputMint, inputProg));
        }
        // Transfer exact lamports needed for the swap into the wXNT ATA
        tx.add(SP.transfer({ fromPubkey: publicKey, toPubkey: inputAta, lamports: rawIn }));
        tx.add(createSyncNativeInstruction(inputAta));
      }

      // ── Create output ATA if needed ───────────────────────────────────────────
      const outInfo = await conn.getAccountInfo(outputAta);
      if (!outInfo) {
        tx.add(createAta(publicKey, outputAta, publicKey, outputMint, outputProg));
      }

      tx.add(ix);

      // ── If swapping TO native XNT: close wXNT ATA after swap to unwrap ───────
      if (isNativeXntOut) {
        tx.add(createCloseAccountInstruction(outputAta, publicKey, publicKey, [], outputProg));
      }

      // ── If swapping FROM native XNT: close the input wXNT ATA to reclaim rent ─
      if (isNativeXntIn) {
        tx.add(createCloseAccountInstruction(inputAta, publicKey, publicKey, [], inputProg));
      }
      setStatus('Waiting for wallet…');
      const signed = await signTransaction(tx);
      const rawTx = signed.serialize();
      // Send with skipPreflight for faster submission, retry a few times
      let sig = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          sig = await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 3 });
          break;
        } catch (e: any) {
          if (attempt === 2) throw e;
          await new Promise(r => setTimeout(r, 500));
        }
      }
      setStatus(`Confirming… (tx: ${sig.slice(0,8)}…)`);
      // Poll for up to 30 seconds (30 × 1000ms)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
          if (st?.value?.err) {
            const errStr = JSON.stringify(st.value.err);
            // Decode XDEX program errors
            const xdexMatch = errStr.match(/"Custom"\s*:\s*(\d+)/);
            const xdexCode = xdexMatch ? parseInt(xdexMatch[1]) : null;
            const xdexMsgs: Record<number, string> = {
              3012: '💧 Insufficient pool liquidity for this swap amount. Try a smaller amount.',
              3011: '💧 Pool has insufficient liquidity.',
              3010: '⚖️ Price impact too high. Try a smaller amount or increase slippage.',
              3009: '⏱️ Transaction expired. Please retry.',
              3008: '⚠️ Slippage exceeded. Price moved — try again or increase slippage.',
            };
            const msg = xdexCode && xdexMsgs[xdexCode]
              ? xdexMsgs[xdexCode]
              : `Transaction failed: ${errStr}`;
            throw new Error(msg);
          }
          if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') {
            setLastTxSig(sig);
            setStatus(`✅ Swap complete!`);
            setAmtIn(''); setQuoteOut(0);
            // Refresh all balances + vault after 1.5s (let chain settle)
            setTimeout(() => refreshAll(), 1500);
            return;
          }
        } catch (e: any) {
          if (e.message?.startsWith('Transaction failed')) throw e;
          // getSignatureStatus can fail transiently — keep polling
        }
      }
      // If still not confirmed, check explorer link — tx may have gone through
      setLastTxSig(sig);
      setStatus(`⚠️ Confirmation timed out — tx may still succeed. Check explorer.`);
      setTimeout(() => refreshAll(), 2000);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // Detect wallet-locked / not-unlocked state
      if (msg.includes('not defined') || msg.includes('wallet is locked') || msg.includes('Wallet not connected') || msg.includes('wallet is not') || msg.includes('locked')) {
        setStatus('🔒 Your wallet appears to be locked. Please unlock Backpack and try again.');
      } else if (msg.includes('User rejected') || msg.includes('rejected')) {
        setStatus('Transaction cancelled.');
      } else {
        setStatus('❌ ' + msg.slice(0, 200));
      }
    }
    finally { setPending(false); }
  };

  const isErr = status.startsWith('❌');
  const isOk  = status.startsWith('✅');
  const isWarn = status.startsWith('⚠️');

  // Derived display values
  const inUsd  = parseFloat(amtIn || '0') * (tokenInPriceUsd  || (tokenIn.mint  === WXNT_MINT ? xntPriceUsd : 0));
  const outUsd = quoteOut                 * (tokenOutPriceUsd || (tokenOut.mint === WXNT_MINT ? xntPriceUsd : 0));
  const rate   = vaultIn > 0n && vaultOut > 0n
    ? Number(vaultOut) / Math.pow(10, tokenOut.decimals) / (Number(vaultIn) / Math.pow(10, tokenIn.decimals))
    : 0;
  const estGasXnt = 0.0002;

  // Build wallet token list: pinned first, then rest — always apply known token overrides
  function buildWalletList(exclude?: string): WalletToken[] {
    const pinned: WalletToken[] = [XNT_TOKEN_DEFAULT, BRAINS_TOKEN_DEFAULT].map(p => {
      const found = walletTokens.find(t => t.mint === p.mint);
      const cached = _metaCache.get(p.mint);
      const logo = found?.logo || cached?.logo;
      const symbol = HARDCODED_META[p.mint]?.symbol ?? found?.symbol ?? p.symbol;
      return found
        ? { ...found, pinned: true, symbol, logo }
        : { ...p, symbol, logo };
    });
    const rest = walletTokens
      .filter(t => t.mint !== XNT_TOKEN_DEFAULT.mint && t.mint !== BRAINS_TOKEN_DEFAULT.mint)
      .map(t => {
        const cached = _metaCache.get(t.mint);
        const known  = HARDCODED_META[t.mint];
        return { ...t, symbol: known?.symbol ?? t.symbol, logo: t.logo || cached?.logo };
      });
    return [...pinned, ...rest].filter(t => t.mint !== exclude);
  }

  // ── Token Picker Modal — searches wallet + XDEX API ───────────────────────────
  const TokenPickerModal: FC<{
    title: string; exclude?: string;
    onSelect: (t: WalletToken) => void; onClose: () => void;
  }> = ({ title, exclude, onSelect, onClose }) => {
    const [search, setSearch] = useState('');
    const [xdexTokens, setXdexTokens] = useState<WalletToken[]>([]); // full pre-loaded list
    const [xdexResults, setXdexResults] = useState<WalletToken[]>([]); // address-lookup results
    const [loadingXdex, setLoadingXdex] = useState(true);
    const [searching, setSearching] = useState(false);

    // Filter wallet tokens by search
    const walletList = buildWalletList(exclude);
    const walletMints = new Set(walletList.map(t => t.mint));

    // Pre-load all XDEX pool tokens on modal open — one fetch, instant client-side search
    useEffect(() => {
      setLoadingXdex(true);
      (async () => {
        try {
          // Only pool/list works — other token-list endpoints return 404
          const endpoints = [
            `/api/xdex-price/api/xendex/pool/list?network=mainnet`,
          ];
          const results = await Promise.allSettled(
            endpoints.map(url => fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null))
          );

          // DEBUG: log first pool object to see real field names
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
              const j = r.value;
              const items: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.pools) ? j.pools : Array.isArray(j?.tokens) ? j.tokens : [];
              if (items.length > 0) {
                console.log('[XDEX pool/list] first item keys:', Object.keys(items[0]));
                console.log('[XDEX pool/list] first item:', JSON.stringify(items[0]).slice(0, 600));
                break;
              }
            }
          }

          const seen = new Set<string>();
          const tokens: WalletToken[] = [];

          const addFromData = (items: any[]) => {
            for (const t of items) {
              // Handle both token objects and pool objects
              const candidates = t.token0 || t.token1 || t.tokenA || t.tokenB
                ? [ // it's a pool
                    t.token0, t.token1, t.tokenA, t.tokenB,
                    { address: t.mintA || t.token0Mint, symbol: t.symbol0 || t.symbolA || t.token0Symbol, name: t.nameA || t.token0Name, logo: t.logoA || t.token0Logo },
                    { address: t.mintB || t.token1Mint, symbol: t.symbol1 || t.symbolB || t.token1Symbol, name: t.nameB || t.token1Name, logo: t.logoB || t.token1Logo },
                  ].filter(Boolean)
                : [t]; // it's already a token

              for (const c of candidates) {
                if (!c) continue;
                const mint = c.address || c.mint || c.token_address || c.tokenAddress;
                if (!mint || seen.has(mint) || walletMints.has(mint) || mint === exclude) continue;
                const decimals = c.decimals ?? t.decimals ?? 9;
                if (decimals <= 1) continue;
                const symbol = c.symbol || c.ticker || t.symbol || t.ticker || c.name?.slice(0,8) || mint.slice(0,6).toUpperCase();
                if (!symbol || symbol.length < 1) continue;
                seen.add(mint);
                tokens.push({
                  mint, symbol, decimals,
                  logo: c.logo || c.logoUri || c.image || c.icon || t.logo,
                  balance: 0, rawBalance: 0n,
                  program: TOKEN_2022_PROGRAM_ID.toBase58(),
                });
              }
            }
          };

          for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value) continue;
            const j = r.value;
            const items: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.pools) ? j.pools : Array.isArray(j?.tokens) ? j.tokens : [];
            if (items.length > 0) addFromData(items);
          }

          setXdexTokens(tokens);
        } catch {} finally { setLoadingXdex(false); }
      })();
    }, []);

    // For 32+ char searches (mint address): do direct on-chain lookup
    useEffect(() => {
      if (search.length < 32) { setXdexResults([]); setSearching(false); return; }
      setSearching(true);
      const timer = setTimeout(async () => {
        try {
          const [metaRes, priceRes] = await Promise.all([
            fetchTokenMeta(search).catch(() => null),
            fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${search}`, { signal: AbortSignal.timeout(4000) }).then(r => r.json()).catch(() => null),
          ]);
          const results: WalletToken[] = [];
          if (!walletMints.has(search) && search !== exclude) {
            if (metaRes && metaRes.decimals > 1) {
              results.push({ mint: search, symbol: metaRes.symbol, decimals: metaRes.decimals,
                logo: metaRes.logo || priceRes?.data?.logo, balance: 0, rawBalance: 0n,
                program: TOKEN_2022_PROGRAM_ID.toBase58() });
            } else if (priceRes?.success && priceRes?.data?.symbol) {
              results.push({ mint: search, symbol: priceRes.data.symbol,
                decimals: priceRes.data.decimals ?? 9,
                logo: priceRes.data.logo || priceRes.data.logoUri, balance: 0, rawBalance: 0n,
                program: TOKEN_2022_PROGRAM_ID.toBase58() });
            }
          }
          setXdexResults(results);
        } catch {} finally { setSearching(false); }
      }, 300);
      return () => clearTimeout(timer);
    }, [search]);

    // Client-side filter of pre-loaded XDEX tokens by symbol/name
    const s = search.toLowerCase();
    const filteredWallet = search
      ? walletList.filter(t => t.symbol.toLowerCase().includes(s) || t.mint.toLowerCase().includes(s))
      : walletList;
    const filteredXdex = search && search.length < 32
      ? xdexTokens.filter(t =>
          t.symbol.toLowerCase().includes(s) ||
          (t as any).name?.toLowerCase().includes(s)
        ).slice(0, 15)
      : [];

    const allResults = [...filteredWallet, ...filteredXdex, ...xdexResults].filter(
      (t, idx, arr) => arr.findIndex(x => x.mint === t.mint) === idx
    );

    // Shared token row renderer
    const TokenRow = ({ t, i }: { t: WalletToken; i: number }) => (
      <div key={t.mint + i} onClick={() => { onSelect(t); onClose(); }}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
          borderRadius: 10, cursor: 'pointer', marginBottom: 4,
          background: t.pinned ? 'rgba(0,212,255,.04)' : 'rgba(255,255,255,.02)',
          border: `1px solid ${t.pinned ? 'rgba(0,212,255,.12)' : 'rgba(255,255,255,.05)'}`,
          transition: 'all .15s' }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(0,212,255,.35)')}
        onMouseLeave={e => (e.currentTarget.style.borderColor = t.pinned ? 'rgba(0,212,255,.12)' : 'rgba(255,255,255,.05)')}>
        <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, overflow: 'hidden',
          background: 'rgba(0,212,255,.1)', border: '1px solid rgba(0,212,255,.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {t.logo
            ? <img src={t.logo} alt={t.symbol} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            : <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 900, color: '#00d4ff' }}>{t.symbol.slice(0,2)}</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 700, color: '#e0f0ff' }}>{t.symbol}</span>
            {t.pinned && <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#00d4ff', background: 'rgba(0,212,255,.1)', padding: '1px 5px', borderRadius: 4 }}>★</span>}
            {!t.pinned && t.balance === 0 && <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 8, color: '#4a6a8a', background: 'rgba(255,255,255,.04)', padding: '1px 5px', borderRadius: 4 }}>XDEX</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#3a5a6a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.mint.slice(0,14)}…{t.mint.slice(-4)}</span>
            <CopyButton text={t.mint} size={10} />
          </div>
        </div>
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700, color: t.balance > 0 ? '#9abacf' : '#3a5a6a', flexShrink: 0 }}>
          {t.balance > 0 ? t.balance.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}
        </div>
      </div>
    );

    return createPortal(
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,.92)', backdropFilter: 'blur(16px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 420,
          background: 'linear-gradient(155deg,#0d1622,#080c0f)',
          border: '1px solid rgba(0,212,255,.2)', borderRadius: 20,
          padding: '20px 16px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 900, color: '#fff' }}>{title}</div>
            <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: '50%', cursor: 'pointer',
              border: '1px solid rgba(255,255,255,.12)', background: 'rgba(8,12,15,.9)', color: '#6a8aaa', fontSize: 16 }}>×</button>
          </div>
          {/* Search */}
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#4a6a8a', fontSize: 14 }}>🔍</span>
            <input value={search} onChange={e => setSearch(e.target.value)} autoFocus
              placeholder="Search name, symbol, address or paste mint…"
              style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 12, boxSizing: 'border-box',
                background: 'rgba(255,255,255,.04)', border: '1px solid rgba(0,212,255,.15)',
                color: '#e0f0ff', fontFamily: 'Sora,sans-serif', fontSize: 12, outline: 'none' }} />
            {searching && <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: '#4a6a8a' }}>⟳</span>}
          </div>
          {/* Token list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loadingWallet && !search
              ? <div style={{ textAlign: 'center', padding: '30px 0', fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#4a6a8a' }}>⟳ Loading wallet tokens…</div>
              : allResults.length === 0 && (searching || (search.length >= 2 && loadingXdex))
              ? <div style={{ textAlign: 'center', padding: '30px 0', fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#4a6a8a' }}>⟳ Searching…</div>
              : allResults.length === 0 && !searching
              ? <div style={{ textAlign: 'center', padding: '30px 0' }}>
                  <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#4a6a8a', marginBottom: 8 }}>
                    No tokens found
                  </div>
                  {search.length > 0 && search.length < 32 && (
                    <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#3a5a6a' }}>
                      Try pasting the full mint address
                    </div>
                  )}
                </div>
              : allResults.map((t, i) => <TokenRow key={t.mint + i} t={t} i={i} />)}
          </div>
          <div style={{ marginTop: 10, fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#2a3a4a', textAlign: 'center' }}>
            Showing wallet tokens + all XDEX indexed tokens
          </div>
        </div>
      </div>,
      document.body
    );
  };

  // ── Token Button ──────────────────────────────────────────────────────────────
  // Token logo with proper fallback to colored letter avatar
  const SwapLogo: FC<{ token: WalletToken; size?: number; color?: string }> = ({ token, size = 22, color = '#00d4ff' }) => {
    const [imgFailed, setImgFailed] = useState(false);
    return (
      <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
        background: imgFailed || !token.logo ? `${color}18` : 'transparent',
        border: `1px solid ${color}33`,
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {token.logo && !imgFailed
          ? <img src={token.logo} alt={token.symbol}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={() => setImgFailed(true)} />
          : <span style={{ fontFamily: 'Orbitron,monospace', fontSize: size * 0.38,
              fontWeight: 900, color }}>{token.symbol.slice(0,2).toUpperCase()}</span>}
      </div>
    );
  };

  const TokenBtn: FC<{ token: WalletToken; color: string; onClick: () => void }> = ({ token, color, onClick }) => (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
      borderRadius: 12, cursor: 'pointer', border: `1px solid ${color}33`, background: `${color}0f`,
      flexShrink: 0, transition: 'all .15s' }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = color + '66'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = color + '33'; }}>
      <SwapLogo token={token} size={22} color={color} />
      <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 900, color }}>{token.symbol}</span>
      <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, color: color + '88' }}>▾</span>
    </button>
  );

  const parsedAmt = parseFloat(amtIn || '0');
  const insufficientBal = publicKey && parsedAmt > tokenIn.balance;

  return (
    <div style={{ maxWidth: 500, margin: '0 auto', animation: 'fadeUp 0.4s ease both' }}>
      <div style={{ background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(0,212,255,.12)', borderRadius: 20,
        padding: isMobile ? '20px 16px' : '28px 28px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18, fontWeight: 900, color: '#fff' }}>🔄 SWAP</div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a', marginTop: 2 }}>Any SPL or Token-2022 · X1 Mainnet</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Refresh button */}
            <button onClick={() => refreshAll()} disabled={refreshing || !publicKey}
              title="Refresh balances & prices"
              style={{ width: 32, height: 32, borderRadius: '50%', cursor: refreshing || !publicKey ? 'not-allowed' : 'pointer',
                background: 'rgba(0,212,255,.08)', border: '1px solid rgba(0,212,255,.2)',
                color: '#00d4ff', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all .2s', opacity: !publicKey ? 0.4 : 1 }}>
              <span style={{ display: 'inline-block', animation: refreshing ? 'spin 1s linear infinite' : 'none' }}>↻</span>
            </button>
            {/* Slippage setting */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>Slippage:</span>
              {[10, 50, 100].map(b => (
                <button key={b} onClick={() => setSlipBps(b)} style={{ padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                  fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
                  background: slipBps === b ? 'rgba(0,212,255,.15)' : 'rgba(255,255,255,.04)',
                  border: `1px solid ${slipBps === b ? 'rgba(0,212,255,.35)' : 'rgba(255,255,255,.08)'}`,
                  color: slipBps === b ? '#00d4ff' : '#4a6a8a' }}>{b / 100}%</button>
              ))}
            </div>
          </div>
        </div>

        {/* YOU PAY */}
        <div style={{ background: 'rgba(255,255,255,.025)', border: '1px solid rgba(0,212,255,.1)', borderRadius: 16, padding: '16px', marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#4a6a8a' }}>You Pay</span>
            {publicKey && (
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>
                Balance: <span style={{ color: '#9abacf', fontWeight: 600 }}>{tokenIn.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <input value={amtIn} onChange={e => setAmtIn(e.target.value)} placeholder="0.00" type="number" min="0"
                style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none',
                  fontFamily: 'Orbitron,monospace', fontSize: 28, fontWeight: 700,
                  color: insufficientBal ? '#ff6666' : '#e0f0ff', boxSizing: 'border-box' }} />
              {inUsd > 0 && <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>≈ ${inUsd.toFixed(4)} USD</div>}
            </div>
            <TokenBtn token={tokenIn} color="#00d4ff" onClick={() => setShowInPicker(true)} />
          </div>
          {/* % preset buttons */}
          {publicKey && tokenIn.balance > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              {[25, 50, 75, 100].map(pct => (
                <button key={pct} onClick={() => setAmtIn((tokenIn.balance * pct / 100).toFixed(Math.min(tokenIn.decimals, 6)))}
                  style={{ flex: 1, padding: '5px 0', borderRadius: 8, cursor: 'pointer',
                    fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
                    background: 'rgba(0,212,255,.06)', border: '1px solid rgba(0,212,255,.15)',
                    color: '#4a8aaa', transition: 'all .15s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,212,255,.15)'; (e.currentTarget as HTMLButtonElement).style.color = '#00d4ff'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,212,255,.06)'; (e.currentTarget as HTMLButtonElement).style.color = '#4a8aaa'; }}>
                  {pct === 100 ? 'MAX' : `${pct}%`}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Flip button */}
        <div style={{ textAlign: 'center', margin: '4px 0', position: 'relative', zIndex: 1 }}>
          <button onClick={() => {
            const tmp = tokenIn; setTokenIn(tokenOut); setTokenOut(tmp);
            setAmtIn(''); setQuoteOut(0);
          }} style={{ width: 36, height: 36, borderRadius: '50%', cursor: 'pointer',
            background: 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.1))',
            border: '1px solid rgba(0,212,255,.3)', color: '#00d4ff', fontSize: 16,
            transition: 'transform .2s' }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'rotate(180deg)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'rotate(0deg)'; }}>⇅</button>
        </div>

        {/* YOU RECEIVE */}
        <div style={{ background: 'rgba(255,255,255,.025)', border: '1px solid rgba(191,90,242,.1)', borderRadius: 16, padding: '16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#4a6a8a' }}>You Receive</span>
            {publicKey && (
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>
                Balance: <span style={{ color: '#9abacf', fontWeight: 600 }}>{tokenOut.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 28, fontWeight: 700, color: quoteOut > 0 ? '#bf5af2' : '#2a3a4a' }}>
                {quoteOut > 0 ? quoteOut.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '0.00'}
              </div>
              {outUsd > 0 && <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>≈ ${outUsd.toFixed(4)} USD</div>}
            </div>
            <TokenBtn token={tokenOut} color="#bf5af2" onClick={() => setShowOutPicker(true)} />
          </div>
        </div>

        {/* Pool loading */}
        {loadingPool && (
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#4a6a8a', textAlign: 'center', marginBottom: 12 }}>
            🔍 Finding pool…
          </div>
        )}

        {/* Info row — Rate / Price Impact / Est Gas / Slippage */}
        {poolState && !loadingPool && vaultIn > 0n && (
          <div style={{ background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.05)',
            borderRadius: 12, padding: '12px 16px', marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
              {/* Rate */}
              <div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#4a6a8a', marginBottom: 3 }}>Rate</div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#9abacf', lineHeight: 1.4 }}>
                  {rate > 0 ? <>
                    <div>1 {tokenIn.symbol} ≈ {rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {tokenOut.symbol}</div>
                    {rate > 0 && <div style={{ color: '#4a6a8a' }}>1 {tokenOut.symbol} ≈ {(1/rate).toLocaleString(undefined, { maximumFractionDigits: 4 })} {tokenIn.symbol}</div>}
                  </> : '—'}
                </div>
              </div>
              {/* Price Impact */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#4a6a8a', marginBottom: 3 }}>Price Impact</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700,
                  color: priceImpact > 5 ? '#ff4444' : priceImpact > 2 ? '#ff8c00' : '#00c98d' }}>
                  {priceImpact.toFixed(2)}%{priceImpact > 5 ? ' ⚠️' : ''}
                </div>
              </div>
              {/* Est Gas */}
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#4a6a8a', marginBottom: 3 }}>Est. Gas</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, color: '#9abacf' }}>~{estGasXnt} XNT</div>
              </div>
              {/* Slippage */}
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#4a6a8a', marginBottom: 3 }}>Slippage</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, color: '#9abacf' }}>{(slipBps / 100).toFixed(1)}%</div>
              </div>
            </div>
            {/* Route */}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.04)',
              display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
              <SwapLogo token={tokenIn} size={24} color="#00d4ff" />
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>→</span>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a', background: 'rgba(255,255,255,.04)', padding: '2px 8px', borderRadius: 6 }}>XDEX Pool</span>
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>→</span>
              <SwapLogo token={tokenOut} size={24} color="#bf5af2" />
            </div>
          </div>
        )}

        {/* Status */}
        {status && (
          <div style={{ margin: '10px 0 14px', padding: '10px 14px', borderRadius: 10,
            fontFamily: 'Sora,sans-serif', fontSize: 12, lineHeight: 1.6,
            background: isErr ? 'rgba(255,68,68,.08)' : isOk ? 'rgba(0,201,141,.08)' : isWarn ? 'rgba(255,140,0,.08)' : 'rgba(255,255,255,.04)',
            border: `1px solid ${isErr ? 'rgba(255,68,68,.25)' : isOk ? 'rgba(0,201,141,.25)' : isWarn ? 'rgba(255,140,0,.25)' : 'rgba(255,255,255,.08)'}`,
            color: isErr ? '#ff8888' : isOk ? '#00c98d' : isWarn ? '#ff8c00' : '#9abacf' }}>{status}</div>
        )}

        {/* Explorer button — shown after swap attempt with a tx sig */}
        {(isOk || isWarn) && lastTxSig && (
          <a href={`https://explorer.mainnet.x1.xyz/tx/${lastTxSig}`} target="_blank" rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              width: '100%', padding: '11px 0', borderRadius: 10, marginBottom: 12, textDecoration: 'none',
              background: 'rgba(0,201,141,.08)', border: '1px solid rgba(0,201,141,.25)',
              fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700, color: '#00c98d',
              boxSizing: 'border-box' as const, letterSpacing: 1 }}>
            VIEW ON EXPLORER ↗ · {lastTxSig.slice(0,8)}…{lastTxSig.slice(-6)}
          </a>
        )}

        {/* Swap Button */}
        {!publicKey
          ? <div style={{ textAlign: 'center', padding: '14px 0', fontFamily: 'Sora,sans-serif', fontSize: 13, color: '#4a6a8a', background: 'rgba(255,255,255,.03)', borderRadius: 12, border: '1px solid rgba(255,255,255,.06)' }}>Connect wallet to swap</div>
          : <button onClick={handleSwap}
              disabled={pending || !poolState || !amtIn || parsedAmt <= 0 || !!insufficientBal}
              style={{ width: '100%', padding: '15px 0', borderRadius: 14, cursor: (pending || !poolState || !amtIn || parsedAmt <= 0) ? 'not-allowed' : 'pointer',
                fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 900, transition: 'all .15s',
                background: pending || !poolState ? 'rgba(255,255,255,.04)'
                  : insufficientBal ? 'rgba(255,68,68,.1)'
                  : 'linear-gradient(135deg,rgba(0,212,255,.22),rgba(191,90,242,.12))',
                border: `1px solid ${pending || !poolState ? 'rgba(255,255,255,.08)'
                  : insufficientBal ? 'rgba(255,68,68,.35)' : 'rgba(0,212,255,.45)'}`,
                color: pending || !poolState ? '#4a6a8a' : insufficientBal ? '#ff6666' : '#00d4ff',
                boxShadow: (!pending && poolState && !insufficientBal && parsedAmt > 0) ? '0 0 20px rgba(0,212,255,.12)' : 'none' }}>
              {pending ? 'SWAPPING…'
                : loadingPool ? 'FINDING POOL…'
                : !poolState && tokenIn.mint !== tokenOut.mint ? 'NO POOL FOUND'
                : insufficientBal ? `INSUFFICIENT ${tokenIn.symbol}`
                : !amtIn || parsedAmt <= 0 ? 'ENTER AMOUNT'
                : `SWAP ${tokenIn.symbol} → ${tokenOut.symbol}`}
            </button>
        }

        <div style={{ marginTop: 12, fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#2a3a4a', textAlign: 'center' }}>
          0.25% fee · Powered by XDEX CP-Swap · X1 Mainnet
        </div>
      </div>

      {/* Token Pickers */}
      {showInPicker  && <TokenPickerModal title="SELECT INPUT TOKEN"  exclude={tokenOut?.mint} onSelect={t => {
        const known = HARDCODED_META[t.mint];
        setTokenIn(known ? { ...t, symbol: known.symbol, logo: t.logo || known.logo } : t);
      }} onClose={() => setShowInPicker(false)}  />}
      {showOutPicker && <TokenPickerModal title="SELECT OUTPUT TOKEN" exclude={tokenIn?.mint}  onSelect={t => {
        const known = HARDCODED_META[t.mint];
        setTokenOut(known ? { ...t, symbol: known.symbol, logo: t.logo || known.logo } : t);
      }} onClose={() => setShowOutPicker(false)} />}
    </div>
  );
};

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
const PairingMarketplace: FC = () => {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { connection } = useConnection();
  const isMobile = useIsMobile();

  const [tab, setTab]               = useState<'listings' | 'mine' | 'pools' | 'swap'>('listings');
  const [filter, setFilter]         = useState<'all' | 'brains' | 'lb'>('all');
  const [listings, setListings]     = useState<ListingOnChain[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [matchTarget, setMatchTarget]   = useState<ListingOnChain | null>(null);
  const [editTarget, setEditTarget]     = useState<ListingOnChain | null>(null);
  const [delistTarget, setDelistTarget] = useState<ListingOnChain | null>(null);
  const [xntPrice, setXntPrice]     = useState(0.4187);
  const [lbBalance, setLbBalance]   = useState(0);
  const [platformVolume, setPlatformVolume] = useState(0);
  const [totalPools, setTotalPools]         = useState(0);
  const [totalListings, setTotalListings]   = useState(0);
  const [brainsMC, setBrainsMC]             = useState(0);
  const [brainsPrice, setBrainsPrice]       = useState(0);
  const [totalTVL, setTotalTVL]             = useState(0);
  // Shared live prices map: mint → USD price — fetched once for all listings
  const [livePrices, setLivePrices] = useState<Map<string, number | null>>(new Map());

  // Fetch XNT price
  useEffect(() => {
    fetchXdexPrice(WXNT_MINT).then(p => { if (p) setXntPrice(p.priceUSD); });
  }, []);

  // Fetch BRAINS price + MC and total ecosystem TVL
  useEffect(() => {
    (async () => {
      try {
        // Get XNT price
        const xntData = await fetchXdexPrice(WXNT_MINT);
        const XNT_PRICE = xntData?.priceUSD ?? 0.4;

        // BRAINS price + MC — use API price for display (ticker/MCAP)
        const bp = await fetchXdexPrice(BRAINS_MINT);
        const brainsPrice = bp?.priceUSD ?? 0;
        const BRAINS_SUPPLY = 7_850_000;
        setBrainsPrice(brainsPrice);
        setBrainsMC(brainsPrice * BRAINS_SUPPLY);

        // Known XNT-side vault addresses for each BRAINS ecosystem pool
        // Confirmed from transaction explorer — these are the wXNT vaults
        const XNT_VAULT_ADDRS = [
          'FtHfi7SxovdqJcaQXaFnymze6FqrEMziNxSHdtjyDJR4', // XNT/BRAINS
          '8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb',  // XNT/BRAINS other side (verify)
          'HJ5WsScycRCtp8yqGsLbcDAayMsbcYajELcALg6kaUaq',  // from tx explorer
        ];

        // Better: fetch XDEX lp-price for each pool LP mint
        // lp-price returns USD per LP token — multiply by LP supply = TVL
        // For now use the reliable approach: sum individual pool TVL from XDEX price API
        // using token0 price × vault0 + token1 price × vault1

        // Wire TVL from PoolsTab via window event — persistent listener, not once
        const handleTvlUpdate = (e: any) => {
          if (e.detail?.totalTvl > 0) setTotalTVL(e.detail.totalTvl);
        };
        window.addEventListener('xbrains-tvl', handleTvlUpdate);
        return () => window.removeEventListener('xbrains-tvl', handleTvlUpdate);
      } catch {}
    })();
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

  // Fetch platform stats — poll every 30s so volume stays live
  useEffect(() => {
    const run = () => {
      fetchPlatformStats().then(s => {
        if (s.totalVolume > 0) setPlatformVolume(s.totalVolume);
        if (s.totalPools   > 0) setTotalPools(s.totalPools);
        if (s.totalListings > 0) setTotalListings(s.totalListings);
      });
    };
    run();
    const interval = setInterval(run, 30_000);
    // Pre-fetch LB price so dashboard shows it immediately
    fetchXdexPrice(LB_MINT).then(p => {
      if (p) setLivePrices(prev => new Map(prev).set(LB_MINT, p.priceUSD));
    });
    return () => clearInterval(interval);
  }, []);

  // Batch fetch live prices for all listed tokens — one call for all mints
  const fetchLivePrices = useCallback(async (mints: string[]) => {
    if (mints.length === 0) return;
    const unique = [...new Set(mints)];
    // Mark all as loading (null) immediately so cards show loading state
    setLivePrices(prev => {
      const next = new Map(prev);
      unique.forEach(m => { if (!next.has(m)) next.set(m, null); });
      return next;
    });
    try {
      const res = await fetch(
        `/api/xdex-price/api/token-price/prices?network=X1%20Mainnet&token_addresses=${unique.join(',')}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const j = await res.json();
      const newPrices = new Map<string, number | null>();
      // Start with null for all (no price found)
      unique.forEach(m => newPrices.set(m, null));
      if (j?.success && Array.isArray(j?.data)) {
        for (const item of j.data) {
          if (item?.token_address && item?.price) {
            newPrices.set(item.token_address, Number(item.price));
          }
        }
      }
      // Individual fallback for missing
      const missing = unique.filter(m => !newPrices.get(m));
      await Promise.all(missing.map(async mint => {
        try {
          const r = await fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${mint}`, { signal: AbortSignal.timeout(4000) });
          const j2 = await r.json();
          if (j2?.success && j2?.data?.price) newPrices.set(mint, Number(j2.data.price));
        } catch {}
      }));
      setLivePrices(newPrices);
    } catch {}
  }, []);

  // Fetch on-chain listings
  const loadListings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchOnChainListings();
      setListings(data);
      // Pre-fetch logos for all listing tokens immediately
      const mints = [...new Set(data.map(l => l.tokenAMint))];
      batchFetchLogos(mints); // non-blocking, updates _metaCache
      // Batch fetch prices
      fetchLivePrices(mints);
    } catch { setListings([]); }
    finally { setLoading(false); }
  }, [fetchLivePrices]);

  useEffect(() => { loadListings(); }, [loadListings]);

  // Refresh prices every 30s
  useEffect(() => {
    if (listings.length === 0) return;
    const interval = setInterval(() => {
      fetchLivePrices(listings.map(l => l.tokenAMint));
    }, 30_000);
    return () => clearInterval(interval);
  }, [listings, fetchLivePrices]);

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
        .ticker-scroll::-webkit-scrollbar{display:none}
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
                <span style={{ color: '#ff8c00' }}>
                  X1 Brains
                </span>
                <span style={{ color: 'rgba(255,255,255,.15)', margin: isMobile ? '0 6px' : '0 12px', fontWeight: 300 }}>·</span>
                <span style={{ color: '#e0f0ff' }}>
                  Lab Work DeFi
                </span>
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

            {/* ── TICKER BAR ── */}
            <div className="ticker-scroll" style={{
              width: '100%', maxWidth: 900, margin: '0 auto 0',
              animation: 'fadeUp 0.5s ease 0.18s both',
              background: 'rgba(255,140,0,.06)',
              border: '1px solid rgba(255,140,0,.18)',
              borderBottom: 'none',
              borderRadius: '10px 10px 0 0',
              padding: isMobile ? '7px 10px' : '10px 28px',
              display: 'flex', alignItems: 'center',
              justifyContent: isMobile ? 'flex-start' : 'space-between',
              gap: 0,
              overflowX: isMobile ? 'auto' : 'visible',
              overflowY: 'visible',
              WebkitOverflowScrolling: 'touch',
              scrollbarWidth: 'none',
            }}>
              {[
                { sym: 'BRAINS', val: brainsPrice > 0 ? `$${brainsPrice.toFixed(4)}` : '…', chg: '+1.75%', up: true },
                { sym: 'LB',     val: livePrices.get(LB_MINT) ? `$${(livePrices.get(LB_MINT) as number).toFixed(4)}` : '…', chg: '+0.98%', up: true },
                { sym: 'XNT',    val: `$${xntPrice.toFixed(4)}`, chg: '+0.12%', up: true },
                { sym: 'MCAP',   val: brainsMC > 0 ? fmtUSD(brainsMC) : '…', chg: null, up: true },
                { sym: 'TVL',    val: totalTVL > 0 ? fmtUSD(totalTVL) : '…', chg: null, up: true },
              ].map((t, i) => (
                <React.Fragment key={t.sym}>
                  {i > 0 && <div style={{ width: 1, height: 14, background: 'rgba(255,140,0,.2)', flexShrink: 0 }} />}
                  <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 4 : 6,
                    padding: isMobile ? '0 8px' : '0 12px', flexShrink: 0 }}>
                    <span style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 7 : 8, letterSpacing: 1,
                      color: 'rgba(255,140,0,.6)', fontWeight: 700 }}>{t.sym}</span>
                    <span style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 10 : 12,
                      fontWeight: 700, color: '#e0f0ff' }}>{t.val}</span>
                    {t.chg && !isMobile && (
                      <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9,
                        color: t.up ? '#00c98d' : '#ff4444' }}>{t.chg}</span>
                    )}
                  </div>
                </React.Fragment>
              ))}
            </div>

            {/* ── ORANGE ACCENT LINE ── */}
            <div style={{
              width: '100%', maxWidth: 900, margin: '0 auto 10px',
              height: 2,
              background: 'linear-gradient(90deg, transparent, #ff8c00, #ffb700, #ff8c00, transparent)',
              borderRadius: '0 0 2px 2px',
              boxShadow: '0 0 12px rgba(255,140,0,.4), 0 0 24px rgba(255,140,0,.15)',
            }} />

            {/* ── STAT CARDS WITH ORBS ── */}
            <div style={{
              width: '100%', maxWidth: 900, margin: '0 auto',
              animation: 'fadeUp 0.5s ease 0.22s both',
              display: 'grid',
              gridTemplateColumns: isMobile ? 'repeat(2, minmax(0,1fr))' : 'repeat(4, minmax(0,1fr))',
              gap: 8,
            }}>
              {[
                { label: 'Platform Volume', value: fmtUSD(platformVolume), sub: 'all-time matched',  color: '#00d4ff' },
                { label: 'Pools Created',   value: String(totalPools),      sub: 'via lp pairing',   color: '#00c98d' },
                { label: 'Open Listings',   value: String(listings.filter(l => l.status === 'open').length), sub: 'awaiting match', color: '#ff8c00' },
                { label: 'Ecosystem TVL',   value: totalTVL > 0 ? fmtUSD(totalTVL) : '…', sub: 'xdex pools total', color: '#bf5af2' },
              ].map(({ label, value, sub, color }) => (
                <div key={label} style={{
                  background: '#0d1520',
                  border: '1px solid rgba(255,255,255,.07)',
                  borderRadius: 14,
                  padding: isMobile ? '14px 14px' : '18px 20px',
                  position: 'relative',
                  overflow: 'hidden',
                }}>
                  {/* Glowing orb */}
                  <div style={{
                    position: 'absolute', top: -24, right: -24,
                    width: 90, height: 90, borderRadius: '50%',
                    background: color, opacity: 0.12,
                    filter: 'blur(28px)', pointerEvents: 'none',
                  }} />
                  {/* Top accent line */}
                  <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, height: 1,
                    background: `linear-gradient(90deg,${color}55,transparent)`,
                  }} />
                  <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 8 : 10,
                    letterSpacing: 1, color: 'rgba(255,255,255,.3)',
                    marginBottom: isMobile ? 6 : 10, textTransform: 'uppercase' }}>{label}</div>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 20,
                    fontWeight: 700, color, letterSpacing: 0.5, lineHeight: 1 }}>{value}</div>
                  <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10,
                    color: 'rgba(255,255,255,.18)', marginTop: 6 }}>{sub}</div>
                </div>
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
            { id: 'swap',     label: '🔄 SWAP',           sub: 'any X1 token' },
            { id: 'pools',    label: '🏊 LB POOLS',       sub: 'swap · deposit · withdraw' },
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

        {/* ── POOLS TAB ── */}
        {tab === 'pools' && <PoolsTab />}

        {/* ── SWAP TAB ── */}
        {tab === 'swap' && <SwapTab isMobile={isMobile} publicKey={publicKey} connection={connection} signTransaction={signTransaction} />}

        {/* ── LISTINGS ── */}
        {tab !== 'pools' && tab !== 'swap' && (loading ? (
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
              livePrice={livePrices.get(listing.tokenAMint) ?? null}
              onMatch={setMatchTarget}
              onEdit={(l) => setEditTarget(l)}
              onDelist={(l) => setDelistTarget(l)}
            />
          ))
        ))}

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
          livePrice={livePrices.get(matchTarget.tokenAMint) ?? null}
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