import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// ── App-wide imports ──────────────────────────────────────────────
import { TopBar, PageBackground, Footer } from '../components/UI';
import {
  BRAINS_MINT,
  METADATA_PROGRAM_ID_STRING,
  MARKETPLACE_PROGRAM_ID_STRING,
  PLATFORM_WALLET_STRING,
  SALE_FEE_NUMERATOR,
  SALE_FEE_DENOMINATOR,
  CANCEL_FEE_NUMERATOR,
  CANCEL_FEE_DENOMINATOR,
} from '../constants';
import {
  resolveGateway,
  toProxyUrl,
  candidateImageUrls,
  tryLoadImg,
  rarityColor,
} from '../utils/nft';
import { supabase } from '../lib/supabase';

// ─────────────────────────────────────────────────────────────────
//  SCALE-SAFE LRU CACHES
//  Plain Map() grows forever. At thousands of NFTs this causes
//  memory bloat, localStorage quota errors, and slow serialisation.
//  These caches evict the oldest entry when over capacity.
// ─────────────────────────────────────────────────────────────────
function makeLRU<V>(max: number) {
  const m = new Map<string, V>();
  return {
    has:  (k: string) => m.has(k),
    get:  (k: string) => m.get(k),
    set:  (k: string, v: V) => {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      if (m.size > max) m.delete(m.keys().next().value!);
    },
    forEach: (fn: (v: V, k: string) => void) => m.forEach(fn),
    get size() { return m.size; },
  };
}

// Image URL cache — localStorage backed, capped at 500 entries
const LW_IMG_CACHE_KEY = 'x1b_lw_img_v3';
const lwImageCache = makeLRU<string | null>(500);
try {
  const stored = localStorage.getItem(LW_IMG_CACHE_KEY);
  if (stored) {
    const parsed = JSON.parse(stored) as Record<string, string | null>;
    Object.entries(parsed).slice(-300).forEach(([k, v]) => lwImageCache.set(k, v));
  }
} catch {}
let _lwPersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistLwCache() {
  if (_lwPersistTimer) clearTimeout(_lwPersistTimer);
  _lwPersistTimer = setTimeout(() => {
    try {
      const obj: Record<string, string | null> = {};
      lwImageCache.forEach((v, k) => { if (v !== null) obj[k] = v; });
      const s = JSON.stringify(obj);
      if (s.length < 2_000_000) localStorage.setItem(LW_IMG_CACHE_KEY, s);
    } catch {}
  }, 1500);
}

// Metadata JSON cache — memory only, capped at 300 entries
const lwMetaCache = makeLRU<any>(300);

// Metaplex PDA data cache — avoids re-fetching same mint across sessions
const lwPdaCache = makeLRU<{ name: string; symbol: string; uri: string }>(1000);

// Session cache for enriched listing metadata (name/symbol/uri) keyed by nftMint
// Lives for the browser session only — cleared on refresh, so fresh data on each visit
const LW_META_SESSION_KEY = 'x1b_lw_meta_v1';
const lwSessionMetaCache = new Map<string, { name: string; symbol: string; uri: string }>();
try {
  const raw = sessionStorage.getItem(LW_META_SESSION_KEY);
  if (raw) Object.entries(JSON.parse(raw)).forEach(([k, v]) => lwSessionMetaCache.set(k, v as any));
} catch {}
function persistSessionMeta() {
  try {
    const obj: Record<string, any> = {};
    lwSessionMetaCache.forEach((v, k) => { obj[k] = v; });
    sessionStorage.setItem(LW_META_SESSION_KEY, JSON.stringify(obj));
  } catch {}
}

async function fetchNFTMeta(metaUri: string): Promise<any | null> {
  if (lwMetaCache.has(metaUri)) return lwMetaCache.get(metaUri);
  const url = resolveGateway(metaUri);
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) return null;
  try {
    const res = await fetch(toProxyUrl(url), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) { lwMetaCache.set(metaUri, null); return null; }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.startsWith('image/')) return null;
    const json = await res.json();
    lwMetaCache.set(metaUri, json);
    return json;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────
//  PRE-COMPUTED DISCRIMINATORS
//  These are constants — computing them via SHA-256 async on every
//  call wastes ~1-2ms each time and adds unnecessary async overhead.
// ─────────────────────────────────────────────────────────────────
const DISC_LIST_NFT     = '58dd5da63fdc6ae8';
const DISC_BUY_NFT      = '60001cbe316b53de';
const DISC_CANCEL       = '29b732e8e6e99d46';
const DISC_UPDATE_PRICE = '3d22759b4b227bd0';
const DISC_SALE_ACCOUNT = 'd51257e4dae6cfb6';
// Base58 of d5 12 57 e4 da e6 cf b6 — for getProgramAccounts memcmp
// Pre-computed so fetchAllListings is sync (no await discriminatorAsync)
const DISC_SALE_B58 = 'ce4bPBiPtDK';

// ── NFT Image component ──
const NFTImage: FC<{ metaUri?: string; name: string; contain?: boolean }> = ({
  metaUri, name, contain = false,
}) => {
  const [imgSrc, setImgSrc] = useState<string | null | undefined>(
    metaUri ? (lwImageCache.has(metaUri) ? lwImageCache.get(metaUri)! : undefined) : null
  );
  useEffect(() => {
    if (!metaUri) { setImgSrc(null); return; }
    if (lwImageCache.has(metaUri)) { setImgSrc(lwImageCache.get(metaUri)!); return; }
    let cancelled = false;
    (async () => {
      const url = resolveGateway(metaUri);

      // Step 1: if metaUri already looks like a direct image URL, use it straight away
      if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url) || url.startsWith('data:image')) {
        lwImageCache.set(metaUri, url); persistLwCache();
        if (!cancelled) setImgSrc(url); return;
      }

      // Step 2: fetch via proxy — check content-type first
      try {
        const res = await fetch(toProxyUrl(url), { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const ct = res.headers.get('content-type') ?? '';
          // It's already an image (covers image/svg+xml, image/png, etc.)
          if (ct.startsWith('image/')) {
            lwImageCache.set(metaUri, url); persistLwCache();
            if (!cancelled) setImgSrc(url); return;
          }
          // It's JSON metadata — extract image field
          try {
            const json = await res.json();
            if (!lwMetaCache.has(metaUri)) lwMetaCache.set(metaUri, json);
            const raw: string =
              json?.image ??
              json?.image_url ?? json?.imageUrl ??
              json?.properties?.files?.[0]?.uri ??
              json?.properties?.files?.[0] ??
              json?.properties?.image ?? '';
            if (raw && !cancelled) {
              const resolvedRaw = resolveGateway(raw);
              // If the extracted image URL has no recognised extension it's
              // likely an API endpoint (e.g. AgentID /api/card-image?wallet=…).
              // Route it through the Vercel proxy so CORS doesn't block it.
              const hasImgExt = /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(resolvedRaw);
              const finalUrl  = (!hasImgExt && resolvedRaw.startsWith('http'))
                ? toProxyUrl(resolvedRaw)
                : resolvedRaw;
              lwImageCache.set(metaUri, finalUrl); persistLwCache();
              if (!cancelled) setImgSrc(finalUrl); return;
            }
          } catch {}
        } // end if (res.ok)
      } catch {}

      // Step 3: candidate URL guessing (last resort)
      for (const candidate of candidateImageUrls(url)) {
        if (cancelled) return;
        try {
          await tryLoadImg(candidate);
          lwImageCache.set(metaUri, candidate); persistLwCache();
          if (!cancelled) setImgSrc(candidate); return;
        } catch {}
      }

      lwImageCache.set(metaUri, null); persistLwCache();
      if (!cancelled) setImgSrc(null);
    })();
    return () => { cancelled = true; };
  }, [metaUri]);

  if (imgSrc === undefined) return (
    <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center',
      justifyContent:'center', background:'rgba(191,90,242,.06)' }}>
      <div style={{ width:22, height:22, borderRadius:'50%',
        border:'2px solid rgba(191,90,242,.2)', borderTop:'2px solid #bf5af2',
        animation:'spin 0.8s linear infinite' }} />
    </div>
  );
  if (!imgSrc) return (
    <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', background:'rgba(191,90,242,.04)' }}>
      <span style={{ fontSize:24 }}>🖼️</span>
      <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#6a7a94',
        marginTop:4, letterSpacing:1 }}>NO IMAGE</span>
    </div>
  );
  return (
    <img src={imgSrc} alt={name} style={{
      position:'absolute', inset:0, width:'100%', height:'100%',
      objectFit: contain ? 'contain' : 'cover',
      padding: contain ? 6 : 0,
    }} onError={e => { (e.currentTarget as HTMLImageElement).style.display='none'; }} />
  );
};

// ─────────────────────────────────────────────────────────────────
//  MARKETPLACE CONSTANTS
//  All values come from constants/index.ts — one place to edit.
//  PLATFORM_WALLET is also hardcoded inside the Rust program and
//  validated on-chain with require_keys_eq!, so it cannot be
//  swapped at runtime even if someone builds a custom frontend.
// ─────────────────────────────────────────────────────────────────
// PublicKey objects — created lazily so an unset MARKETPLACE_PROGRAM_ID_STRING
// (still 'YOUR_PROGRAM_ID_HERE') does not crash the page before React mounts.
// METADATA and PLATFORM keys are always valid so they're safe to construct now.
const METADATA_PROGRAM_ID = new PublicKey(METADATA_PROGRAM_ID_STRING);
const PLATFORM_WALLET = PLATFORM_WALLET_STRING !== 'YOUR_PLATFORM_WALLET_HERE'
  ? new PublicKey(PLATFORM_WALLET_STRING)
  : null;

const MARKETPLACE_DEPLOYED = MARKETPLACE_PROGRAM_ID_STRING !== 'YOUR_PROGRAM_ID_HERE';

function getMarketplaceProgramId(): PublicKey {
  if (!MARKETPLACE_DEPLOYED) {
    // Return a dummy key — callers should check MARKETPLACE_DEPLOYED before calling
    return PublicKey.default;
  }
  return new PublicKey(MARKETPLACE_PROGRAM_ID_STRING);
}

// ─────────────────────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────────────────────
export interface NFTData {
  mint:         string;
  name:         string;
  symbol:       string;
  balance:      number;
  decimals:     number;
  isToken2022:  boolean;
  metaUri?:     string;
  logoUri?:     string;
  metaSource?:  string;
  description?: string;
  attributes?:  { trait_type: string; value: string }[];
  externalUrl?: string;
  collection?:  string;
  image?:       string;
}
export interface Listing {
  listingPda: string;
  escrowPda:  string;
  seller:     string;
  nftMint:    string;
  price:      number;   // lamports
  active:     boolean;
  nftData?:   NFTData;
}
export type PageMode  = 'gallery' | 'market';
export type MarketTab = 'overview' | 'browse' | 'mylistings' | 'sell' | 'activity';

export interface TradeLog {
  sig:       string;
  type:      'list' | 'buy' | 'delist' | 'boost';
  nftMint:   string;
  price?:    number;
  seller?:   string;
  buyer?:    string;
  timestamp: number;
  nftData?:  NFTData;
}

// ─────────────────────────────────────────────────────────────────
//  UTILITY HELPERS
// ─────────────────────────────────────────────────────────────────
function useIsMobile() {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}
const lamportsToXnt   = (l: number)     => (l / LAMPORTS_PER_SOL).toFixed(4);
const calcFee         = (p: number)     => Math.floor(p * SALE_FEE_NUMERATOR / SALE_FEE_DENOMINATOR);
const calcCancelFee   = (p: number)     => Math.floor(p * CANCEL_FEE_NUMERATOR / CANCEL_FEE_DENOMINATOR);
const calcSellerCut   = (p: number)     => p - calcFee(p);
const xntToLamports   = (x: string)     => Math.round(parseFloat(x) * LAMPORTS_PER_SOL);

// Save trade to Supabase for persistent activity log
async function saveTrade(trade: { sig: string; type: 'list'|'buy'|'delist'|'boost'; nftMint: string; price?: number; seller?: string; buyer?: string; timestamp: number; brains?: number }) {
  try {
    if (!supabase) return;
    await supabase.from('labwork_trades').upsert({
      sig: trade.sig, type: trade.type, nft_mint: trade.nftMint,
      price: trade.price, seller: trade.seller, buyer: trade.buyer,
      timestamp: trade.timestamp, brains: trade.brains ?? null,
    }, { onConflict: 'sig' });
  } catch { /* non-critical */ }
}

// Send transaction - tries signTransaction first to bypass wallet simulation,
// falls back to sendTransaction if sign fails.
// skipPreflight: false on all marketplace txs — simulate before submit to protect user funds.
async function sendTx(
  tx: Transaction,
  connection: any,
  sendTransaction: any,
  signTransaction?: ((tx: Transaction) => Promise<Transaction>) | null,
  skipPreflight = false,
): Promise<string> {
  if (signTransaction) {
    try {
      const signed = await signTransaction(tx);
      return connection.sendRawTransaction(signed.serialize(), {
        skipPreflight,
        preflightCommitment: 'confirmed',
        maxRetries:          5,
      });
    } catch (signErr: any) {
      console.warn('signTransaction failed, falling back to sendTransaction:', signErr?.message ?? signErr);
      const msg = signErr?.message ?? '';
      if (msg.includes('User rejected') || msg.includes('rejected') || msg.includes('denied')) throw signErr;
    }
  }
  return sendTransaction(tx, connection, {
    skipPreflight,
    preflightCommitment: 'confirmed',
    maxRetries:          5,
  });
}

// ─────────────────────────────────────────────────────────────────
//  MARKETPLACE PDA HELPERS
//  Seeds must exactly match the Rust program:
//    listing → [b"listing", mint, seller]
//    escrow  → [b"escrow",  mint, seller]
// ─────────────────────────────────────────────────────────────────
// New v2 seeds — vault and sale both include seller for uniqueness
function getSalePda(mint: PublicKey, seller: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('sale'), mint.toBuffer(), seller.toBuffer()],
    getMarketplaceProgramId()
  );
}
function getVaultPda(mint: PublicKey, seller: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), mint.toBuffer(), seller.toBuffer()],
    getMarketplaceProgramId()
  );
}
// Keep old names as aliases for fetchAllListings compat
function getListingPda(mint: PublicKey, seller?: PublicKey): [PublicKey, number] {
  return getSalePda(mint, seller ?? PublicKey.default);
}
function getEscrowPda(mint: PublicKey, seller?: PublicKey): [PublicKey, number] {
  return getVaultPda(mint, seller ?? PublicKey.default);
}


// ─── Anchor instruction discriminator ─────────────────────────────
// sha256("global:<name>")[0..8] for instructions
// sha256("account:<name>")[0..8] for account types
const _discCache = new Map<string, Buffer>();
async function discriminatorAsync(name: string, isAccount = false): Promise<Buffer> {
  const key = (isAccount ? 'account:' : 'global:') + name;
  if (_discCache.has(key)) return _discCache.get(key)!;
  const data    = new TextEncoder().encode(key);
  const hashBuf = await window.crypto.subtle.digest('SHA-256', data);
  const result  = Buffer.from(new Uint8Array(hashBuf).slice(0, 8));
  _discCache.set(key, result);
  return result;
}
// Pre-warm cache at module load so values are ready before any button click.
(async () => {
  await Promise.all([
    discriminatorAsync('list_nft'),
    discriminatorAsync('buy_nft'),
    discriminatorAsync('cancel_listing'),
    discriminatorAsync('SaleAccount', true),  // account discriminator
  ]);
})();
// ─────────────────────────────────────────────────────────────────
//  NFT METADATA ENRICHMENT
// ─────────────────────────────────────────────────────────────────

// Result cache — same mint in activity log only ever fetched once
const lwNFTDataCache = makeLRU<NFTData>(500);
// In-flight dedup — parallel calls for same mint share one Promise
const lwNFTInFlight = new Map<string, Promise<NFTData>>();

async function enrichNFTFromMint(connection: any, mintAddr: string): Promise<NFTData> {
  if (lwNFTDataCache.has(mintAddr)) return lwNFTDataCache.get(mintAddr)!;
  if (lwNFTInFlight.has(mintAddr))  return lwNFTInFlight.get(mintAddr)!;

  const base: NFTData = { mint: mintAddr, name: mintAddr.slice(0,8)+'\u2026', symbol:'', balance:1, decimals:0, isToken2022:false };

  const promise = (async (): Promise<NFTData> => {
    try {
      // PDA cache hit — skip RPC entirely
      let parsed = lwPdaCache.get(mintAddr);
      if (!parsed) {
        const mintPk  = new PublicKey(mintAddr);
        const [pdaKey] = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), mintPk.toBytes()],
          METADATA_PROGRAM_ID
        );
        const info = await connection.getAccountInfo(pdaKey, { encoding: 'base64' });
        if (info?.data) {
          const raw = decodeAccountData(info.data);
          if (raw) {
            const p = parseMetaplexPDA(raw);
            if (p) { lwPdaCache.set(mintAddr, p); parsed = p; }
          }
        }
      }
      if (!parsed) return base;
      const withMeta: NFTData = { ...base, name: parsed.name || base.name, symbol: parsed.symbol, metaUri: parsed.uri };
      const enriched = await enrichNFT(withMeta);
      lwNFTDataCache.set(mintAddr, enriched);
      return enriched;
    } catch {
      return base;
    } finally {
      lwNFTInFlight.delete(mintAddr);
    }
  })();

  lwNFTInFlight.set(mintAddr, promise);
  return promise;
}

async function enrichNFT(nft: NFTData): Promise<NFTData> {
  const uri = nft.metaUri || nft.logoUri;
  if (!uri) return nft;
  const json = lwMetaCache.get(uri) ?? await fetchNFTMeta(uri);
  if (!json) return nft;

  const rawImg: string =
    json?.image ??
    json?.image_url ?? json?.imageUrl ??
    json?.properties?.files?.[0]?.uri ??
    json?.properties?.files?.[0] ??
    json?.properties?.image ?? '';

  const resolvedImg = rawImg ? resolveGateway(rawImg) : '';
  // Proxy API-served images (no extension) to avoid CORS — e.g. AgentID card-image endpoint
  const hasImgExt = /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(resolvedImg);
  const finalImg  = resolvedImg && !hasImgExt && resolvedImg.startsWith('http')
    ? toProxyUrl(resolvedImg)
    : resolvedImg;

  return {
    ...nft,
    description: json.description  ?? nft.description,
    attributes:  Array.isArray(json.attributes) ? json.attributes : nft.attributes,
    externalUrl: json.external_url ?? json.external_link ?? json.external_url ?? nft.externalUrl,
    collection:  typeof json.collection === 'string'
      ? json.collection
      : (json.collection?.name ?? nft.collection),
    image: finalImg || nft.image,
  };
}

// ─────────────────────────────────────────────────────────────────
//  FETCH WALLET NFTs
//  Batch-fetches Metaplex PDA accounts to resolve name / symbol / URI
//  for every NFT (decimals=0, balance=1) in the connected wallet.
// ─────────────────────────────────────────────────────────────────
async function fetchWalletNFTs(connection: any, publicKey: PublicKey): Promise<NFTData[]> {
  const [splR, t22R] = await Promise.allSettled([
    connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const all = [
    ...(splR.status === 'fulfilled' ? splR.value.value : []).map((a: any) => ({ ...a, is2022: false })),
    ...(t22R.status === 'fulfilled' ? t22R.value.value : []).map((a: any) => ({ ...a, is2022: true  })),
  ];
  const candidates = all.filter((a: any) => {
    const info = a.account.data.parsed.info;
    const dec  = info.tokenAmount.decimals;
    const bal  = info.tokenAmount.uiAmount ?? parseFloat(info.tokenAmount.uiAmountString ?? '0');
    return dec === 0 && bal === 1 && info.mint !== BRAINS_MINT;
  });
  const mints  = candidates.map((a: any) => a.account.data.parsed.info.mint as string);
  const pdaMap = new Map<string, { name: string; symbol: string; uri: string }>();
  const BATCH  = 100; // RPC supports up to 100 accounts per getMultipleAccountsInfo call
  for (let i = 0; i < mints.length; i += BATCH) {
    const batch   = mints.slice(i, i + BATCH);
    const pdaKeys = batch.map(mint => PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), new PublicKey(mint).toBytes()],
      METADATA_PROGRAM_ID
    )[0]);
    try {
      // Specify base64 encoding explicitly — matches Portfolio's batchFetchMetaplexPDAs
      const infos = await connection.getMultipleAccountsInfo(pdaKeys, { encoding: 'base64' });
      infos.forEach((info: any, idx: number) => {
        if (!info?.data) return;
        try {
          // Handle all three data formats the X1 RPC may return (same as Portfolio)
          let raw: Uint8Array;
          const d = info.data;
          if (d instanceof Uint8Array) raw = d;
          else if (Array.isArray(d) && typeof d[0] === 'string') raw = Uint8Array.from(atob(d[0]), c => c.charCodeAt(0));
          else if (typeof d === 'string') raw = Uint8Array.from(atob(d), c => c.charCodeAt(0));
          else return;
          if (raw.length < 69) return;
          const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          let o = 65;
          const nL = view.getUint32(o, true); o += 4;
          if (!nL || nL > 200 || o + nL > raw.length) return;
          const name = new TextDecoder().decode(raw.slice(o, o + nL)).replace(/\x00/g,'').trim(); o += nL;
          const sL = view.getUint32(o, true); o += 4;
          if (sL > 50 || o + sL > raw.length) return;
          const symbol = new TextDecoder().decode(raw.slice(o, o + sL)).replace(/\x00/g,'').trim(); o += sL;
          const uL = view.getUint32(o, true); o += 4;
          if (uL > 2048 || o + uL > raw.length) return;
          const uri = new TextDecoder().decode(raw.slice(o, o + uL)).replace(/\x00/g,'').trim();
          if (!name && !symbol) return;
          pdaMap.set(batch[idx], { name, symbol, uri });
          lwPdaCache.set(batch[idx], { name, symbol, uri }); // share with marketplace cache
        } catch {}
      });
    } catch {}
  }
  const nfts: NFTData[] = candidates.map((a: any) => {
    const info = a.account.data.parsed.info;
    const mint = info.mint as string;
    const pda  = pdaMap.get(mint);
    return {
      mint, name: pda?.name || `NFT ${mint.slice(0,6)}…`, symbol: pda?.symbol || '???',
      balance: 1, decimals: 0, isToken2022: a.is2022,
      metaUri: pda?.uri, metaSource: pda ? 'metaplex' : 'unknown',
    };
  });
  nfts.sort((a, b) => a.name.localeCompare(b.name));
  return nfts;
}

// ─────────────────────────────────────────────────────────────────
//  COLLECTION GROUPING
// ─────────────────────────────────────────────────────────────────
function groupByCollection(nfts: NFTData[]): Map<string, NFTData[]> {
  const map = new Map<string, NFTData[]>();
  for (const nft of nfts) {
    const key = nft.collection || nft.symbol || nft.mint.slice(0,4).toUpperCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(nft);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────
//  FETCH ACTIVE MARKETPLACE LISTINGS
//  Reads all program accounts matching the Listing discriminator.
//  Listing::LEN = 8 + 32 + 32 + 8 + 1 + 1 + 1 = 83 bytes
// ─────────────────────────────────────────────────────────────────
async function fetchAllListings(connection: any): Promise<Listing[]> {
  try {
    // SaleAccount = 90 bytes. Pre-computed discriminator avoids async SHA-256 on every load.
    // withContext:true returns slot alongside data for cache freshness checks.
    const accounts = await connection.getProgramAccounts(getMarketplaceProgramId(), {
      filters: [
        { dataSize: 90 },
        { memcmp: { offset: 0, bytes: DISC_SALE_B58 } },
      ],
      // dataSlice not used — account is only 90 bytes so full fetch is fine
    });
    return (accounts as any[]).map(({ pubkey, account }: any) => {
      const d       = account.data as Buffer;
      const seller  = new PublicKey(d.slice(8,  40)).toBase58();
      const nftMint = new PublicKey(d.slice(40, 72)).toBase58();
      const price   = Number(d.readBigUInt64LE(72));
      // bump=80, vault_bump=81, created_at=82-89 — no active flag, all accounts are active
      const sellerPk  = new PublicKey(seller);
      const mintPk    = new PublicKey(nftMint);
      const [vaultPda] = getVaultPda(mintPk, sellerPk);
      return { listingPda: pubkey.toBase58(), escrowPda: vaultPda.toBase58(), seller, nftMint, price, active: true };
    });
  } catch { return []; }
}

// Parse raw Metaplex PDA bytes into name/symbol/uri
function parseMetaplexPDA(raw: Uint8Array): { name: string; symbol: string; uri: string } | null {
  if (raw.length < 69) return null;
  try {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let o = 65;
    const nL = view.getUint32(o, true); o += 4;
    if (!nL || nL > 200 || o + nL > raw.length) return null;
    const name = new TextDecoder().decode(raw.slice(o, o + nL)).replace(/\x00/g, '').trim(); o += nL;
    const sL = view.getUint32(o, true); o += 4;
    if (sL > 50 || o + sL > raw.length) return null;
    const symbol = new TextDecoder().decode(raw.slice(o, o + sL)).replace(/\x00/g, '').trim(); o += sL;
    const uL = view.getUint32(o, true); o += 4;
    if (uL > 2048 || o + uL > raw.length) return null;
    const uri = new TextDecoder().decode(raw.slice(o, o + uL)).replace(/\x00/g, '').trim();
    return { name, symbol, uri };
  } catch { return null; }
}

function decodeAccountData(d: any): Uint8Array | null {
  if (d instanceof Uint8Array) return d;
  if (Array.isArray(d) && typeof d[0] === 'string') return Uint8Array.from(atob(d[0]), c => c.charCodeAt(0));
  if (typeof d === 'string') return Uint8Array.from(atob(d), c => c.charCodeAt(0));
  return null;
}

// Batch-enrich listings: one getMultipleAccountsInfo call per 100 listings
// instead of N individual getAccountInfo calls. Critical for scale.
async function batchEnrichListings(connection: any, listings: Listing[]): Promise<Listing[]> {
  if (listings.length === 0) return listings;

  // Split uncached from cached
  // Populate lwPdaCache from session cache first (zero RPC calls for known mints)
  lwSessionMetaCache.forEach((v, k) => { if (!lwPdaCache.has(k)) lwPdaCache.set(k, v); });

  const uncached = listings.filter(l => !lwPdaCache.has(l.nftMint));
  const BATCH = 100; // RPC max — fetch all unknown mints in one shot

  for (let i = 0; i < uncached.length; i += BATCH) {
    const chunk = uncached.slice(i, i + BATCH);
    const pdaKeys = chunk.map(l => PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), new PublicKey(l.nftMint).toBytes()],
      METADATA_PROGRAM_ID
    )[0]);
    try {
      const infos = await connection.getMultipleAccountsInfo(pdaKeys, { encoding: 'base64' });
      infos.forEach((info: any, idx: number) => {
        if (!info?.data) return;
        const raw = decodeAccountData(info.data);
        if (!raw) return;
        const parsed = parseMetaplexPDA(raw);
        if (parsed) {
          lwPdaCache.set(chunk[idx].nftMint, parsed);
          lwSessionMetaCache.set(chunk[idx].nftMint, parsed); // persist for next render
        }
      });
      persistSessionMeta();
    } catch { /* batch failed — listings render without metadata */ }
  }

  // Now enrich all listings from cache (no more RPC calls)
  return listings.map(l => {
    const cached = lwPdaCache.get(l.nftMint);
    if (!cached || l.nftData?.name) return l;
    const base: NFTData = {
      mint: l.nftMint, name: cached.name || l.nftMint.slice(0,8)+'…',
      symbol: cached.symbol, balance: 1, decimals: 0, isToken2022: false, metaUri: cached.uri,
    };
    return { ...l, nftData: base };
  });
}

// Single-listing enrich kept for backward compat (buy/delist modal)
async function enrichListing(connection: any, l: Listing): Promise<Listing> {
  const results = await batchEnrichListings(connection, [l]);
  const enriched = results[0];
  if (!enriched.nftData?.metaUri && !enriched.nftData?.image) return enriched;

  // If metaUri is a MoltLab URI (returns 404 by mint), try AgentID verify by seller wallet instead
  const isMoltMeta = enriched.nftData?.metaUri?.includes('moltlab.vercel.app');
  if (isMoltMeta && l.seller) {
    const agentData = await fetchAgentIDByWallet(l.seller);
    if (agentData) {
      return {
        ...enriched,
        nftData: {
          ...enriched.nftData!,
          image:       agentData.photoUrl  ?? enriched.nftData?.image,
          description: agentData.description ?? enriched.nftData?.description,
          collection:  'MOLT',
          externalUrl: agentData.moltbook
            ? `https://moltbook.com/u/${agentData.moltbook}`
            : enriched.nftData?.externalUrl,
        },
      };
    }
    // AgentID lookup failed — return as-is (will show 🦞 placeholder)
    return enriched;
  }

  // Normal path: fetch image/attributes from metaUri
  if (enriched.nftData?.metaUri && !enriched.nftData.image) {
    const withAttrs = await enrichNFT(enriched.nftData);
    return { ...enriched, nftData: withAttrs };
  }
  return enriched;
}

// AgentID protocol — look up a registered agent by their wallet address.
// Returns the agent record (name, description, photoUrl, moltbook) or null.
const agentIDCache = new Map<string, any | null>();
async function fetchAgentIDByWallet(wallet: string): Promise<any | null> {
  if (agentIDCache.has(wallet)) return agentIDCache.get(wallet);
  try {
    const url = `https://agentid-app.vercel.app/api/verify?wallet=${wallet}`;
    const res = await fetch(toProxyUrl(url), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) { agentIDCache.set(wallet, null); return null; }
    const json = await res.json();
    const agent = json?.verified ? json.agent : null;
    agentIDCache.set(wallet, agent);
    return agent;
  } catch { agentIDCache.set(wallet, null); return null; }
}

// ─────────────────────────────────────────────────────────────────
//  SHARED INLINE COMPONENTS
// ─────────────────────────────────────────────────────────────────
// Safely render a status message — extracts explorer link if present,
// renders as plain text + anchor element (no dangerouslySetInnerHTML).
const StatusBox: FC<{ msg: string }> = ({ msg }) => {
  if (!msg) return null;
  const ok = msg.includes('✅'), err = msg.includes('❌');
  const style: React.CSSProperties = {
    padding:'8px 12px', borderRadius:8, marginBottom:14,
    background: ok ? 'rgba(0,201,141,.08)' : err ? 'rgba(255,50,50,.08)' : 'rgba(0,212,255,.06)',
    border:`1px solid ${ok ? 'rgba(0,201,141,.3)' : err ? 'rgba(255,50,50,.3)' : 'rgba(0,212,255,.2)'}`,
    fontFamily:'Sora,sans-serif', fontSize:11,
    color: ok ? '#00c98d' : err ? '#ff6666' : '#00d4ff',
    display:'flex', alignItems:'center', gap:8, flexWrap:'wrap',
  };
  // Extract explorer URL from message safely — only allow our known explorer domain
  const urlMatch = msg.match(/https:\/\/explorer\.mainnet\.x1\.xyz\/tx\/([A-Za-z0-9]+)/);
  const cleanText = msg.replace(/<[^>]*>/g, '').replace(/View Tx ↗/, '').trim();
  return (
    <div style={style}>
      <span>{cleanText}</span>
      {urlMatch && (
        <a href={urlMatch[0]} target="_blank" rel="noopener noreferrer"
           style={{ color:'#00d4ff', textDecoration:'underline', fontSize:10, flexShrink:0 }}>
          View Tx ↗
        </a>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
//  NFT DETAIL MODAL  (gallery-mode, with "List for Sale" button)
// ─────────────────────────────────────────────────────────────────
const NFTDetailModal: FC<{
  nft:         NFTData;
  isMobile:    boolean;
  onClose:     () => void;
  onListThis?: (nft: NFTData) => void;
}> = ({ nft, isMobile, onClose, onListThis }) => {
  const [copied, setCopied] = useState(false);
  const imgUri = nft.image || nft.metaUri || nft.logoUri;
  const rarity = nft.attributes?.find(a => a.trait_type?.toLowerCase() === 'rarity')?.value ?? '';

  useEffect(() => {
    let scrollY = 0;
    try {
      scrollY = window.scrollY;
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.overflow = 'hidden';
    } catch {}
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => {
      try {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.overflow = '';
        window.scrollTo(0, scrollY);
      } catch {}
      window.removeEventListener('keydown', fn);
    };
  }, []);
  const copyMint = () => { navigator.clipboard.writeText(nft.mint); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return createPortal(
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,.88)',
      backdropFilter:'blur(14px)', display:'flex',
      alignItems: isMobile ? 'flex-end' : 'center',
      justifyContent:'center',
      padding: isMobile ? 0 : 20, animation:'labFadeIn 0.18s ease both' }}>
      <style>{`
        @keyframes labFadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes labSlideUp { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes labSheetUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
        @keyframes labScan    { 0%{transform:translateY(-100%)} 100%{transform:translateY(400%)} }
        @keyframes labGlow    { 0%,100%{opacity:.4} 50%{opacity:1} }
      `}</style>
      <div onClick={e => e.stopPropagation()} style={{
        width:'100%', maxWidth: isMobile ? '100%' : 600,
        background:'linear-gradient(155deg,#0c1520,#080c0f)',
        border:'1px solid rgba(191,90,242,.4)',
        borderRadius: isMobile ? '20px 20px 0 0' : 20,
        boxShadow:'0 0 60px rgba(191,90,242,.12), 0 32px 80px rgba(0,0,0,.9)',
        animation: isMobile ? 'labSheetUp 0.28s cubic-bezier(.22,1,.36,1) both' : 'labSlideUp 0.22s cubic-bezier(.22,1,.36,1) both',
        position:'relative',
        // ⚠️  NO overflow:hidden here — that was clipping scroll on desktop
        display:'flex', flexDirection: isMobile ? 'column' : 'row',
        maxHeight: isMobile ? '92vh' : '88vh',
        overflow:'hidden',  // needed for border-radius, but children use their own scroll
      }}>
        {/* Top accent line */}
        <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1, zIndex:3, pointerEvents:'none',
          background:'linear-gradient(90deg,transparent,rgba(0,212,255,.8),rgba(191,90,242,.8),transparent)' }} />

        {/* Close button */}
        <button onClick={onClose} style={{ position:'absolute', top:12, right:12, zIndex:20, width:32, height:32,
          borderRadius:'50%', border:'1px solid rgba(191,90,242,.35)', background:'rgba(8,12,15,.9)',
          cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, color:'#bf5af2' }}>×</button>

        {isMobile ? (
          // ── MOBILE: bottom-sheet, image strip + scrollable content + sticky buttons ──
          <>
            {/* Image strip — fixed height, never scrolls */}
            <div style={{ position:'relative', width:'100%', height:160, flexShrink:0,
              background:'linear-gradient(135deg,#050a0f,#0a0f18)',
              borderRadius:'19px 19px 0 0', overflow:'hidden' }}>
              <NFTImage metaUri={imgUri} name={nft.name} contain />
              <div style={{ position:'absolute', top:10, left:10, background:'rgba(0,0,0,.75)',
                border:'1px solid rgba(0,212,255,.4)', borderRadius:5, padding:'2px 8px',
                fontFamily:'Orbitron,monospace', fontSize:8, color:'#00d4ff', fontWeight:700 }}>🧪 NFT</div>
              {rarity && <div style={{ position:'absolute', bottom:8, left:10, background:'rgba(0,0,0,.8)',
                backdropFilter:'blur(6px)', border:`1px solid ${rarityColor(rarity)}55`, borderRadius:6,
                padding:'2px 8px', fontFamily:'Orbitron,monospace', fontSize:7,
                color:rarityColor(rarity), fontWeight:700 }}>✦ {rarity.toUpperCase()}</div>}
            </div>

            {/* Scrollable content — flex:1 + minHeight:0 is required for scroll to work */}
            <div style={{ flex:1, minHeight:0, overflowY:'scroll',
              WebkitOverflowScrolling:'touch' as any,
              padding:'12px 14px 8px', display:'flex', flexDirection:'column', gap:8 }}>
              <div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:14, fontWeight:900, color:'#fff', marginBottom:3 }}>{nft.name}</div>
                <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                  {nft.collection && <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abace' }}>{nft.collection}</span>}
                  {nft.symbol && <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00d4ff',
                    background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)', padding:'1px 6px', borderRadius:3 }}>{nft.symbol}</span>}
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                    background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.25)', padding:'1px 6px', borderRadius:3 }}>{nft.isToken2022 ? 'T-2022' : 'SPL'}</span>
                </div>
              </div>
              {nft.description && <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abace', lineHeight:1.5 }}>{nft.description.length > 160 ? nft.description.slice(0,160)+'…' : nft.description}</div>}
              {nft.attributes && nft.attributes.length > 0 && (
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', letterSpacing:1.5, marginBottom:6 }}>TRAITS — {nft.attributes.length}</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                    {nft.attributes.map((a, i) => {
                      const isR = a.trait_type?.toLowerCase() === 'rarity';
                      const col = isR ? rarityColor(a.value) : '#bf5af2';
                      return (
                        <div key={i} style={{ background:'rgba(191,90,242,.05)',
                          border:`1px solid ${isR ? col+'44' : 'rgba(191,90,242,.15)'}`, borderRadius:6, padding:'4px 8px' }}>
                          <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#9abacf', marginBottom:2 }}>{a.trait_type}</div>
                          <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, fontWeight:600, color: isR ? col : '#b8cce0' }}>{a.value}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(0,0,0,.3)', borderRadius:7,
                border:'1px solid rgba(255,255,255,.06)', padding:'6px 10px' }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', flexShrink:0 }}>MINT</span>
                <code style={{ flex:1, fontFamily:'monospace', fontSize:9, color:'#8aaac4', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.mint.slice(0,10)}…{nft.mint.slice(-6)}</code>
                <button onClick={copyMint} style={{ flexShrink:0, padding:'3px 8px', borderRadius:4, cursor:'pointer', border:'none',
                  background: copied ? 'rgba(0,201,141,.2)' : 'rgba(191,90,242,.15)', color: copied ? '#00c98d' : '#bf5af2',
                  fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700 }}>{copied ? '✓' : 'COPY'}</button>
              </div>
            </div>

            {/* Sticky action buttons — never scroll away */}
            <div style={{ flexShrink:0, padding:'10px 14px 16px',
              borderTop:'1px solid rgba(255,255,255,.07)',
              background:'linear-gradient(0deg,#080c0f,rgba(8,12,15,.97))',
              display:'flex', gap:8 }}>
              <a href={`https://explorer.mainnet.x1.xyz/address/${nft.mint}`} target="_blank" rel="noopener noreferrer"
                style={{ flex:1, padding:'10px 0', textAlign:'center', background:'rgba(0,212,255,.08)',
                  border:'1px solid rgba(0,212,255,.3)', borderRadius:9, fontFamily:'Orbitron,monospace',
                  fontSize:8, fontWeight:700, color:'#00d4ff', textDecoration:'none',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:3 }}>🔍 EXPLORER</a>
              {nft.externalUrl && <a href={nft.externalUrl} target="_blank" rel="noopener noreferrer"
                style={{ flex:1, padding:'10px 0', textAlign:'center', background:'rgba(191,90,242,.08)',
                  border:'1px solid rgba(191,90,242,.3)', borderRadius:9, fontFamily:'Orbitron,monospace',
                  fontSize:8, fontWeight:700, color:'#bf5af2', textDecoration:'none',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:3 }}>🌐 SITE</a>}
              {onListThis && <button onClick={() => { onClose(); onListThis(nft); }}
                style={{ flex:1, padding:'10px 0', background:'rgba(0,201,141,.08)', border:'1px solid rgba(0,201,141,.35)',
                  borderRadius:9, fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#00c98d',
                  cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:3 }}>🏷️ LIST</button>}
            </div>
          </>
        ) : (
          // ── DESKTOP: side-by-side image + scrollable info ──
          <>
            {/* Image panel — fixed width, full height */}
            <div style={{ position:'relative', width:240, flexShrink:0,
              background:'linear-gradient(135deg,#050a0f,#0a0f18)',
              borderRadius:'19px 0 0 19px', overflow:'hidden',
              minHeight:400 }}>
              <NFTImage metaUri={imgUri} name={nft.name} contain />
              <div style={{ position:'absolute', top:12, left:12, background:'rgba(0,0,0,.78)',
                border:'1px solid rgba(0,212,255,.4)', borderRadius:5, padding:'2px 9px',
                fontFamily:'Orbitron,monospace', fontSize:8, color:'#00d4ff', fontWeight:700 }}>🧪 NFT</div>
              {rarity && <div style={{ position:'absolute', bottom:12, left:12, background:'rgba(0,0,0,.82)',
                backdropFilter:'blur(8px)', border:`1px solid ${rarityColor(rarity)}55`, borderRadius:7,
                padding:'4px 12px', fontFamily:'Orbitron,monospace', fontSize:9,
                color:rarityColor(rarity), fontWeight:700, letterSpacing:1.2,
                boxShadow:`0 0 16px ${rarityColor(rarity)}22` }}>✦ {rarity.toUpperCase()}</div>}
            </div>

            {/* Info panel — scrollable, flex:1, minHeight:0 required */}
            <div style={{ flex:1, minHeight:0, overflowY:'auto',
              padding:'22px 22px 18px', display:'flex', flexDirection:'column', gap:10,
              minWidth:0, scrollbarWidth:'none' as any }}>
              <div style={{ paddingRight:36 }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:16, fontWeight:900, color:'#fff',
                  marginBottom:5, lineHeight:1.2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
                <div style={{ display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
                  {nft.collection && <span style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abace' }}>{nft.collection}</span>}
                  {nft.symbol && <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00d4ff',
                    background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)', padding:'2px 7px', borderRadius:3 }}>{nft.symbol}</span>}
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                    background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.25)', padding:'2px 7px', borderRadius:3 }}>{nft.isToken2022 ? 'TOKEN-2022' : 'SPL'}</span>
                </div>
              </div>
              {nft.description && <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abace', lineHeight:1.65 }}>{nft.description.length > 200 ? nft.description.slice(0,200)+'…' : nft.description}</div>}
              {nft.attributes && nft.attributes.length > 0 && (
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf', letterSpacing:1.5, marginBottom:7 }}>TRAITS — {nft.attributes.length}</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                    {nft.attributes.map((a, i) => {
                      const isR = a.trait_type?.toLowerCase() === 'rarity';
                      const col = isR ? rarityColor(a.value) : '#bf5af2';
                      return (
                        <div key={i} style={{ background:'rgba(191,90,242,.05)',
                          border:`1px solid ${isR ? col+'44' : 'rgba(191,90,242,.15)'}`,
                          borderRadius:5, padding:'3px 8px', boxShadow: isR ? `0 0 10px ${col}18` : 'none' }}>
                          <span style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#9abacf', marginRight:4 }}>{a.trait_type}:</span>
                          <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, fontWeight:600, color: isR ? col : '#b8cce0' }}>{a.value}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(0,0,0,.3)', borderRadius:8,
                border:'1px solid rgba(255,255,255,.06)', padding:'7px 10px' }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', flexShrink:0 }}>MINT</span>
                <code style={{ flex:1, fontFamily:'monospace', fontSize:10, color:'#8aaac4', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.mint.slice(0,14)}…{nft.mint.slice(-10)}</code>
                <button onClick={copyMint} style={{ flexShrink:0, padding:'4px 10px', borderRadius:5, cursor:'pointer', border:'none',
                  background: copied ? 'rgba(0,201,141,.18)' : 'rgba(191,90,242,.12)', color: copied ? '#00c98d' : '#bf5af2',
                  fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700 }}>{copied ? '✓ COPIED' : 'COPY'}</button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:6 }}>
                {[{l:'BLOCKCHAIN',v:'X1 Mainnet'},{l:'STANDARD',v:nft.isToken2022?'Token-2022':'SPL Token'},{l:'DECIMALS',v:String(nft.decimals)},{l:'BALANCE',v:String(nft.balance)}].map(({l,v}) =>
                  <div key={l} style={{ background:'rgba(255,255,255,.02)', borderRadius:6, border:'1px solid rgba(255,255,255,.05)', padding:'5px 6px', textAlign:'center' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginBottom:2 }}>{l}</div>
                    <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, fontWeight:600, color:'#b0c4d8' }}>{v}</div>
                  </div>)}
              </div>
              <div style={{ display:'flex', gap:8, marginTop:'auto', paddingTop:4 }}>
                <a href={`https://explorer.mainnet.x1.xyz/address/${nft.mint}`} target="_blank" rel="noopener noreferrer"
                  style={{ flex:1, padding:'10px 0', textAlign:'center', background:'linear-gradient(135deg,rgba(0,212,255,.15),rgba(0,212,255,.06))',
                    border:'1px solid rgba(0,212,255,.35)', borderRadius:9, fontFamily:'Orbitron,monospace',
                    fontSize:8, fontWeight:700, color:'#00d4ff', textDecoration:'none',
                    display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>🔍 X1 EXPLORER ↗</a>
                {nft.externalUrl && <a href={nft.externalUrl} target="_blank" rel="noopener noreferrer"
                  style={{ flex:1, padding:'10px 0', textAlign:'center', background:'linear-gradient(135deg,rgba(191,90,242,.15),rgba(191,90,242,.06))',
                    border:'1px solid rgba(191,90,242,.35)', borderRadius:9, fontFamily:'Orbitron,monospace',
                    fontSize:8, fontWeight:700, color:'#bf5af2', textDecoration:'none',
                    display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>🌐 WEBSITE ↗</a>}
                {onListThis && <button onClick={() => { onClose(); onListThis(nft); }}
                  style={{ flex:1, padding:'10px 0', background:'linear-gradient(135deg,rgba(0,201,141,.15),rgba(0,201,141,.06))',
                    border:'1px solid rgba(0,201,141,.4)', borderRadius:9, fontFamily:'Orbitron,monospace',
                    fontSize:8, fontWeight:700, color:'#00c98d', cursor:'pointer',
                    display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>🏷️ LIST FOR SALE</button>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>,

    document.body
  );
};

// ─────────────────────────────────────────────────────────────────
//  NFT CARD  (gallery grid)
// ─────────────────────────────────────────────────────────────────
const NFTCard: FC<{ nft: NFTData; index: number; isMobile: boolean; onClick: () => void }> = React.memo(({ nft, index, isMobile, onClick }) => {
  const imgUri = nft.image || nft.metaUri || nft.logoUri;
  const rarity = nft.attributes?.find(a => a.trait_type?.toLowerCase() === 'rarity')?.value ?? '';
  const rcol   = rarity ? rarityColor(rarity) : null;
  return (
    <div onClick={onClick} style={{ position:'relative',
      background:'linear-gradient(145deg,rgba(191,90,242,.07) 0%,rgba(0,212,255,.04) 50%,rgba(191,90,242,.02) 100%)',
      border:'1px solid rgba(191,90,242,.2)', borderRadius:12, overflow:'hidden', cursor:'pointer',
      animation:`fadeUp 0.4s ease ${Math.min(index * 0.04, 0.5)}s both`,
      transition:'transform 0.16s, box-shadow 0.18s, border-color 0.16s' }}
      onMouseEnter={e => { const el=e.currentTarget as HTMLDivElement; el.style.transform='translateY(-4px) scale(1.01)'; el.style.boxShadow='0 8px 32px rgba(191,90,242,.28), 0 0 0 1px rgba(0,212,255,.15)'; el.style.borderColor='rgba(0,212,255,.5)'; }}
      onMouseLeave={e => { const el=e.currentTarget as HTMLDivElement; el.style.transform='translateY(0) scale(1)'; el.style.boxShadow='none'; el.style.borderColor='rgba(191,90,242,.2)'; }}>
      <div style={{ position:'relative', width:'100%', paddingBottom:'100%', background:'#060b12' }}>
        <NFTImage metaUri={imgUri} name={nft.name} />
        {rcol && (rarity.toLowerCase().includes('legendary') || rarity.toLowerCase().includes('epic')) && (
          <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
            background:`linear-gradient(90deg,transparent,${rcol},transparent)`, animation:'labGlow 2s ease infinite' }} />
        )}
        <div style={{ position:'absolute', top:4, right:4, background:'rgba(0,0,0,.78)', backdropFilter:'blur(4px)',
          border:'1px solid rgba(0,212,255,.35)', borderRadius:4, padding:'1px 5px',
          fontFamily:'Orbitron,monospace', fontSize:6, color:'#00d4ff', fontWeight:700 }}>🧪</div>
        {rarity && <div style={{ position:'absolute', bottom:4, left:4, background:'rgba(0,0,0,.82)',
          border:`1px solid ${rcol}44`, borderRadius:4, padding:'1px 5px',
          fontFamily:'Orbitron,monospace', fontSize:6, color:rcol!, fontWeight:700 }}>{rarity.toUpperCase()}</div>}
      </div>
      <div style={{ padding: isMobile ? '5px 6px 7px' : '6px 8px 8px',
        background:'linear-gradient(180deg,rgba(8,12,15,0) 0%,rgba(8,12,15,.9) 100%)' }}>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700, color:'#c0d0e0',
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:2 }}>{nft.name}</div>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'rgba(0,212,255,.45)' }}>TAP TO INSPECT</div>
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────
//  COLLECTION SECTION
// ─────────────────────────────────────────────────────────────────
const CollectionSection: FC<{
  collectionName: string;
  nfts:           NFTData[];
  isMobile:       boolean;
  colIndex:       number;
  onSelect:       (nft: NFTData) => void;
}> = ({ collectionName, nfts, isMobile, colIndex, onSelect }) => {
  const [expanded, setExpanded]               = useState(true);
  const [limit, setLimit]                     = useState<5 | 10 | 20 | 'all'>(10);
  const [traitFilter, setTraitFilter]         = useState<{ type: string; value: string } | null>(null);
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  const colors = ['#00d4ff','#bf5af2','#00c98d','#ffd700','#ff8c00'];
  const col    = colors[colIndex % colors.length];
  const rgba   = col==='#00d4ff'?'0,212,255':col==='#bf5af2'?'191,90,242':col==='#00c98d'?'0,201,141':col==='#ffd700'?'255,215,0':'255,140,0';

  // When traits load in (nfts prop updates with attributes), clear stale filter
  const prevNftsLen = React.useRef(0);
  useEffect(() => {
    const hasAttrsNow = nfts.some(n => (n.attributes?.length ?? 0) > 0);
    const hadAttrsBefore = prevNftsLen.current > 0;
    if (hasAttrsNow && !hadAttrsBefore) {
      // Traits just arrived — clear any filter that was set before traits loaded
      setTraitFilter(null);
    }
    prevNftsLen.current = nfts.filter(n => (n.attributes?.length ?? 0) > 0).length;
  }, [nfts]);

  // Build unique traits from THIS collection only
  const colTraits = useMemo(() => {
    const map = new Map<string, Set<string>>();
    nfts.forEach(n => {
      n.attributes?.forEach(a => {
        if (!a.trait_type || !a.value) return;
        if (!map.has(a.trait_type)) map.set(a.trait_type, new Set());
        map.get(a.trait_type)!.add(a.value);
      });
    });
    return map;
  }, [nfts]);

  // Apply per-collection trait filter
  const filtered = traitFilter
    ? nfts.filter(n => n.attributes?.some(
        a => a.trait_type?.toLowerCase() === traitFilter.type.toLowerCase()
          && a.value?.toLowerCase()      === traitFilter.value.toLowerCase()
      ))
    : nfts;

  const visible = limit === 'all' ? filtered : filtered.slice(0, limit);
  const hasMore = filtered.length > (limit === 'all' ? 0 : limit);
  const hasTraits = colTraits.size > 0;

  return (
    <div style={{ marginBottom: isMobile ? 28 : 36, animation:`fadeUp 0.5s ease ${colIndex * 0.08}s both` }}>

      {/* ── Collection header ── */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10, cursor:'pointer', userSelect:'none' }}
        onClick={() => setExpanded(v => !v)}>
        <div style={{ width:3, height:28, borderRadius:2, background:col, flexShrink:0, boxShadow:`0 0 10px ${col}66` }} />
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:'#fff', letterSpacing:1.5, marginBottom:2 }}>{collectionName}</div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#8aaac8', letterSpacing:1 }}>
            {traitFilter ? `${filtered.length} of ${nfts.length}` : nfts.length} NFT{nfts.length!==1?'s':''} · COLLECTION
          </div>
        </div>

        {/* Limit pills */}
        {expanded && (
          <div onClick={e => e.stopPropagation()} style={{ display:'flex', gap:4 }}>
            {([5, 10, 20, 'all'] as const).map(opt => {
              const active = limit === opt;
              return (
                <button key={String(opt)} onClick={() => setLimit(opt)} style={{
                  padding: isMobile ? '3px 7px' : '4px 9px', borderRadius:6, cursor:'pointer',
                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700, transition:'all .15s',
                  background: active ? `rgba(${rgba},.2)` : 'rgba(255,255,255,.04)',
                  border:     active ? `1px solid ${col}55` : '1px solid rgba(255,255,255,.08)',
                  color:      active ? col : '#4a6a8a',
                }}>{opt === 'all' ? 'ALL' : String(opt)}</button>
              );
            })}
          </div>
        )}

        {/* Filter toggle button — always visible, disabled until traits load */}
        {expanded && (
          <button onClick={e => { e.stopPropagation(); if (hasTraits) setShowFilterPanel(v => !v); }} style={{
            padding: isMobile ? '4px 8px' : '4px 10px', borderRadius:6, cursor: hasTraits ? 'pointer' : 'default',
            fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700, transition:'all .15s',
            background: showFilterPanel || traitFilter ? `rgba(${rgba},.18)` : 'rgba(255,255,255,.04)',
            border:     showFilterPanel || traitFilter ? `1px solid ${col}66` : '1px solid rgba(255,255,255,.08)',
            color:      traitFilter ? col : hasTraits ? (showFilterPanel ? col : '#6a8aaa') : '#2a3a4a',
            opacity:    hasTraits ? 1 : 0.4,
          }}>
            {traitFilter ? '⚡ FILTERED' : '⚡ FILTER'}
          </button>
        )}

        <div style={{ background:`rgba(${rgba},.12)`, border:`1px solid ${col}33`, borderRadius:20, padding:'4px 10px',
          fontFamily:'Orbitron,monospace', fontSize:9, color:col, fontWeight:700 }}>{filtered.length}</div>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#8aaac8', transition:'transform 0.2s',
          transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▾</div>
      </div>

      {/* ── Per-collection trait filter panel ── */}
      {expanded && showFilterPanel && hasTraits && (
        <div style={{ marginBottom:14, padding:'12px 14px', background:'rgba(255,255,255,.025)',
          border:`1px solid ${col}22`, borderRadius:10, animation:'fadeUp 0.2s ease both' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
            <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#8aaac8', letterSpacing:1.5 }}>FILTER BY TRAIT</span>
            {traitFilter && (
              <button onClick={() => setTraitFilter(null)} style={{
                padding:'2px 10px', borderRadius:20, cursor:'pointer',
                fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700, letterSpacing:1,
                background:'rgba(255,80,80,.1)', border:'1px solid rgba(255,80,80,.3)', color:'#ff6666',
              }}>✕ CLEAR</button>
            )}
          </div>
          {/* Group by trait_type */}
          {Array.from(colTraits.entries()).map(([traitType, values]) => (
            <div key={traitType} style={{ marginBottom:10 }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#8aaac8',
                letterSpacing:1.5, marginBottom:6, textTransform:'uppercase' }}>{traitType}</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                {Array.from(values).sort().map(val => {
                  const active = traitFilter?.type === traitType && traitFilter?.value === val;
                  const count  = nfts.filter(n => n.attributes?.some(
                    a => a.trait_type?.toLowerCase() === traitType.toLowerCase()
                      && a.value?.toLowerCase()      === val.toLowerCase()
                  )).length;
                  return (
                    <button key={val}
                      onClick={() => setTraitFilter(active ? null : { type: traitType, value: val })}
                      style={{
                        padding: isMobile ? '3px 8px' : '4px 10px', borderRadius:20, cursor:'pointer', transition:'all .15s',
                        fontFamily:'Sora,sans-serif', fontSize: isMobile ? 9 : 10,
                        background: active ? `rgba(${rgba},.2)`      : 'rgba(255,255,255,.04)',
                        border:     active ? `1px solid ${col}`       : 'rgba(255,255,255,.1)' ? '1px solid rgba(255,255,255,.1)' : '',
                        color:      active ? col                       : '#7a9ab8',
                      }}>
                      {val}
                      <span style={{ marginLeft:5, fontFamily:'Orbitron,monospace', fontSize:7,
                        color: active ? col : '#3a5a7a', opacity:.8 }}>({count})</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ height:1, marginBottom:14, background:`linear-gradient(90deg,${col}44,${col}22,transparent)` }} />

      {expanded && filtered.length === 0 && (
        <div style={{ padding:'20px 0', textAlign:'center', fontFamily:'Orbitron,monospace',
          fontSize:9, color:'#9abacf', letterSpacing:1 }}>NO MATCHES IN THIS COLLECTION</div>
      )}

      {expanded && filtered.length > 0 && (
        <>
          <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(5,1fr)', gap: isMobile ? 7 : 10 }}>
            {visible.map((nft, i) => <NFTCard key={nft.mint} nft={nft} index={i} isMobile={isMobile} onClick={() => onSelect(nft)} />)}
          </div>
          {(hasMore || limit !== 10) && (
            <div style={{ display:'flex', justifyContent:'center', gap:8, marginTop:12 }}>
              {hasMore && limit !== 'all' && (
                <button onClick={() => setLimit(limit === 5 ? 10 : limit === 10 ? 20 : 'all')}
                  style={{ padding:'6px 18px', borderRadius:8, cursor:'pointer',
                    background:`rgba(${rgba},.08)`, border:`1px solid ${col}33`,
                    fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:col }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background=`rgba(${rgba},.18)`; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background=`rgba(${rgba},.08)`; }}>
                  ▼ SHOW {limit === 5 ? '10' : limit === 10 ? '20' : 'ALL'} ({filtered.length - (limit as number)} more)
                </button>
              )}
              {limit !== 10 && (
                <button onClick={() => setLimit(10)}
                  style={{ padding:'6px 18px', borderRadius:8, cursor:'pointer',
                    background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.08)',
                    fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#8aaac8' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background='rgba(255,255,255,.07)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background='rgba(255,255,255,.03)'; }}>
                  ▲ RESET
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};




// ─────────────────────────────────────────────────────────────────
//  UPDATE PRICE MODAL
// ─────────────────────────────────────────────────────────────────
const UpdatePriceModal: FC<{
  listing:         Listing;
  isMobile:        boolean;
  connection:      any;
  publicKey:       PublicKey | null;
  sendTransaction: any;
  signTransaction: ((tx: Transaction) => Promise<Transaction>) | null | undefined;
  onClose:         () => void;
  onUpdated:       () => void;
}> = ({ listing, isMobile, connection, publicKey, sendTransaction, signTransaction, onClose, onUpdated }) => {
  const [newPrice, setNewPrice] = useState('');
  const [step, setStep]         = useState<'input' | 'confirm'>('input');
  const [status, setStatus]     = useState('');
  const [pending, setPending]   = useState(false);

  const nft         = listing.nftData;
  const currentXnt  = parseFloat(lamportsToXnt(listing.price));
  const newLamports = newPrice ? xntToLamports(newPrice) : 0;
  const newXnt      = parseFloat(newPrice || '0');
  const priceDiff   = newXnt - currentXnt;
  const diffColor   = priceDiff > 0 ? '#00c98d' : priceDiff < 0 ? '#ff6666' : '#4a6a8a';
  const diffLabel   = priceDiff > 0 ? `▲ +${priceDiff.toFixed(4)} XNT` : priceDiff < 0 ? `▼ ${priceDiff.toFixed(4)} XNT` : '— no change';

  const handleUpdate = async () => {
    if (!publicKey || !newPrice || newLamports <= 0) return;
    setPending(true); setStatus('Preparing transaction…');
    try {
      const nftMint   = new PublicKey(listing.nftMint);
      const [salePda] = getSalePda(nftMint, publicKey);
      const disc      = Buffer.from(DISC_UPDATE_PRICE, 'hex');
      const priceData = Buffer.alloc(8);
      priceData.writeBigUInt64LE(BigInt(newLamports));
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey, isSigner: true,  isWritable: true  }, // 0 seller
          { pubkey: salePda,   isSigner: false, isWritable: true  }, // 1 sale
        ],
        data: Buffer.concat([disc, priceData]),
      };
      const tx = new Transaction().add(ix as any);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      setStatus('Awaiting wallet approval…');
      const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
      setStatus('Confirming…');
      for (let i = 0; i < 40; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const st   = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const conf = st?.value?.confirmationStatus;
        const err  = st?.value?.err;
        if (err) throw new Error('On-chain error: ' + JSON.stringify(err));
        if (conf === 'confirmed' || conf === 'finalized') break;
      }
      setStatus(`✅ Price updated to ${newPrice} XNT`);
      setTimeout(() => { onUpdated(); onClose(); }, 1800);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0, 120) ?? 'Failed'}`);
    } finally { setPending(false); }
  };

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [pending]);

  return createPortal(
    <div onClick={() => { if (!pending) onClose(); }}
      style={{ position:'fixed', inset:0, zIndex:10000, background:'rgba(0,0,0,.88)',
        backdropFilter:'blur(14px)', display:'flex', alignItems:'center', justifyContent:'center',
        padding: isMobile ? 16 : 20, animation:'fadeUp 0.18s ease both' }}>
      <div onClick={e => e.stopPropagation()} style={{ width:'100%', maxWidth: isMobile ? '96%' : 440,
        background:'linear-gradient(155deg,#0c1520,#080c0f)', border:'1px solid rgba(0,212,255,.35)',
        borderRadius:20, padding: isMobile ? '22px 18px' : '28px 28px',
        boxShadow:'0 0 60px rgba(0,212,255,.12), 0 32px 80px rgba(0,0,0,.9)',
        animation:'labSlideUp 0.22s cubic-bezier(.22,1,.36,1) both', position:'relative' }}>

        {/* Top accent */}
        <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1,
          background:'linear-gradient(90deg,transparent,rgba(0,212,255,.8),rgba(191,90,242,.5),transparent)' }} />

        {/* Close */}
        <button onClick={onClose} disabled={pending}
          style={{ position:'absolute', top:12, right:12, width:30, height:30, borderRadius:'50%',
            border:'1px solid rgba(0,212,255,.3)', background:'rgba(8,12,15,.9)',
            cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, color:'#00d4ff' }}>×</button>

        {/* Header */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 15, fontWeight:900, color:'#fff', marginBottom:4 }}>
            ✏️ UPDATE LISTING PRICE
          </div>
          <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#8aaac8' }}>
            Free to update · no fee charged
          </div>
        </div>

        {/* NFT preview */}
        <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:20, padding:'12px 14px',
          background:'rgba(255,255,255,.03)', borderRadius:12, border:'1px solid rgba(255,255,255,.06)' }}>
          <div style={{ width:52, height:52, borderRadius:9, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative' }}>
            {(nft?.image || nft?.metaUri)
              ? <img src={nft?.image || nft?.metaUri} alt={nft?.name ?? ''} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
              : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>🖼️</div>
            }
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color:'#e0f0ff',
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:4 }}>
              {nft?.name ?? listing.nftMint.slice(0,12)+'…'}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf' }}>CURRENT PRICE</span>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:12, fontWeight:900, color:'#00d4ff' }}>
                {lamportsToXnt(listing.price)} XNT
              </span>
            </div>
          </div>
        </div>

        {step === 'input' && (
          <>
            {/* New price input */}
            <div style={{ marginBottom:16 }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf', letterSpacing:1.5, marginBottom:8 }}>
                NEW LISTING PRICE
              </div>
              <div style={{ position:'relative' }}>
                <input
                  type="number" min="0" step="0.0001" value={newPrice}
                  onChange={e => setNewPrice(e.target.value)}
                  placeholder={lamportsToXnt(listing.price)}
                  autoFocus
                  style={{ width:'100%', boxSizing:'border-box', padding:'13px 52px 13px 16px',
                    background:'rgba(0,0,0,.4)', border:'1px solid rgba(0,212,255,.3)', borderRadius:10,
                    outline:'none', color:'#00d4ff', fontFamily:'Orbitron,monospace', fontSize:18,
                    fontWeight:700, caretColor:'#00d4ff' }}
                />
                <span style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)',
                  fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', pointerEvents:'none' }}>XNT</span>
              </div>
            </div>

            {/* Price diff indicator */}
            {newPrice && newXnt > 0 && (
              <div style={{ marginBottom:16, padding:'10px 14px', background:'rgba(255,255,255,.03)',
                borderRadius:9, border:'1px solid rgba(255,255,255,.06)',
                display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf' }}>PRICE CHANGE</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:diffColor }}>{diffLabel}</span>
              </div>
            )}

            <StatusBox msg={status} />

            <div style={{ display:'flex', gap:10 }}>
              <button type="button" onClick={onClose}
                style={{ flex:1, padding:'11px 0', background:'rgba(255,255,255,.04)',
                  border:'1px solid rgba(255,255,255,.1)', borderRadius:9, cursor:'pointer',
                  fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#9abacf' }}>
                CANCEL
              </button>
              <button type="button"
                onClick={() => { if (newPrice && newXnt > 0 && newLamports !== listing.price) setStep('confirm'); }}
                disabled={!newPrice || newXnt <= 0 || newLamports === listing.price}
                style={{ flex:2, padding:'11px 0',
                  background: (!newPrice || newXnt <= 0 || newLamports === listing.price)
                    ? 'rgba(0,212,255,.06)' : 'linear-gradient(135deg,rgba(0,212,255,.22),rgba(0,212,255,.1))',
                  border:`1px solid ${(!newPrice || newXnt <= 0 || newLamports === listing.price) ? 'rgba(0,212,255,.15)' : 'rgba(0,212,255,.5)'}`,
                  borderRadius:9, cursor: (!newPrice || newXnt <= 0 || newLamports === listing.price) ? 'not-allowed' : 'pointer',
                  fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#00d4ff',
                  opacity: (!newPrice || newXnt <= 0 || newLamports === listing.price) ? 0.4 : 1 }}>
                REVIEW CHANGE →
              </button>
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            {/* Confirmation prompt */}
            <div style={{ marginBottom:20, padding:'16px', background:'rgba(255,170,0,.06)',
              border:'1px solid rgba(255,170,0,.2)', borderRadius:12, textAlign:'center' }}>
              <div style={{ fontSize:32, marginBottom:10 }}>✏️</div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900, color:'#fff', marginBottom:6 }}>
                CONFIRM PRICE UPDATE
              </div>
              <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abace', marginBottom:14 }}>
                Are you sure you want to change your listing price?
              </div>
              <div style={{ display:'flex', justifyContent:'center', alignItems:'center', gap:12 }}>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 16, fontWeight:900,
                    color:'#ff6666', textDecoration:'line-through', opacity:.7 }}>
                    {lamportsToXnt(listing.price)}
                  </div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginTop:2 }}>CURRENT</div>
                </div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:20, color:'#9abacf' }}>→</div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 18 : 22, fontWeight:900, color:'#00c98d' }}>
                    {newPrice}
                  </div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginTop:2 }}>NEW</div>
                </div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:diffColor }}>XNT</div>
              </div>
              <div style={{ marginTop:10, fontFamily:'Orbitron,monospace', fontSize:8, color:'#00c98d' }}>
                🎉 FREE — no fees charged for price updates
              </div>
            </div>

            <StatusBox msg={status} />

            <div style={{ display:'flex', gap:10 }}>
              <button type="button" onClick={() => setStep('input')} disabled={pending}
                style={{ flex:1, padding:'11px 0', background:'rgba(255,255,255,.04)',
                  border:'1px solid rgba(255,255,255,.1)', borderRadius:9, cursor: pending ? 'not-allowed' : 'pointer',
                  fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#9abacf', opacity: pending ? 0.5 : 1 }}>
                ← BACK
              </button>
              <button type="button" onClick={handleUpdate} disabled={pending}
                style={{ flex:2, padding:'11px 0',
                  background: pending ? 'rgba(0,201,141,.1)' : 'linear-gradient(135deg,rgba(0,201,141,.22),rgba(0,201,141,.1))',
                  border:'1px solid rgba(0,201,141,.45)', borderRadius:9, cursor: pending ? 'not-allowed' : 'pointer',
                  fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#00c98d',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:6, opacity: pending ? 0.7 : 1 }}>
                {pending
                  ? <><div style={{ width:12, height:12, borderRadius:'50%', border:'2px solid rgba(0,201,141,.2)', borderTop:'2px solid #00c98d', animation:'spin 0.8s linear infinite' }} />UPDATING…</>
                  : '✅ CONFIRM UPDATE'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};

// ─────────────────────────────────────────────────────────────────
//  MARKETPLACE — LISTING CARD
// ─────────────────────────────────────────────────────────────────
const ListingCard: FC<{
  listing:  Listing;
  isMobile: boolean;
  isOwner:  boolean;
  onBuy:    () => void;
  onDelist: () => void;
  onInspect: () => void;
  onUpdatePrice?: () => void;
}> = React.memo(({ listing, isMobile, isOwner, onBuy, onDelist, onInspect, onUpdatePrice }) => {
  const nft    = listing.nftData;
  const imgUri = nft?.image || nft?.metaUri || nft?.logoUri;
  const rarity = nft?.attributes?.find(a => a.trait_type?.toLowerCase() === 'rarity')?.value ?? '';
  const rcol   = rarity ? rarityColor(rarity) : '#bf5af2';
  return (
    <div onClick={onInspect} style={{ background:'linear-gradient(145deg,rgba(0,212,255,.06),rgba(191,90,242,.04))',
      border:'1px solid rgba(0,212,255,.2)', borderRadius:14, overflow:'hidden', cursor:'pointer',
      transition:'transform 0.15s, box-shadow 0.18s, border-color 0.15s', animation:'fadeUp 0.4s ease both' }}
      onMouseEnter={e => { const el=e.currentTarget as HTMLDivElement; el.style.transform='translateY(-4px)'; el.style.boxShadow='0 8px 32px rgba(0,212,255,.2)'; el.style.borderColor='rgba(0,212,255,.5)'; }}
      onMouseLeave={e => { const el=e.currentTarget as HTMLDivElement; el.style.transform='translateY(0)'; el.style.boxShadow='none'; el.style.borderColor='rgba(0,212,255,.2)'; }}>
      <div style={{ position:'relative', width:'100%', paddingBottom:'100%', background:'#060b12' }}>
        <NFTImage metaUri={imgUri} name={nft?.name ?? ''} />
        {rarity && <div style={{ position:'absolute', bottom:4, left:4, background:'rgba(0,0,0,.82)',
          border:`1px solid ${rcol}44`, borderRadius:4, padding:'1px 5px',
          fontFamily:'Orbitron,monospace', fontSize:6, color:rcol, fontWeight:700 }}>{rarity.toUpperCase()}</div>}
        {isOwner && <div style={{ position:'absolute', top:4, right:4, background:'rgba(255,140,0,.85)',
          borderRadius:4, padding:'1px 6px', fontFamily:'Orbitron,monospace', fontSize:6, color:'#000', fontWeight:700 }}>YOURS</div>}
      </div>
      <div style={{ padding: isMobile ? '8px 8px 10px' : '10px 12px 12px' }}>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700, color:'#c0d8f0',
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:3 }}>{nft?.name ?? listing.nftMint.slice(0,8)+'…'}</div>
        <div style={{ marginBottom:8 }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 12 : 14, fontWeight:900, color:'#00d4ff', marginBottom:1 }}>
            {lamportsToXnt(listing.price)}<span style={{ fontSize:7, color:'#9abacf', marginLeft:4 }}>XNT</span>
          </div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf' }}>SELLER GETS {lamportsToXnt(calcSellerCut(listing.price))} · 1.888% FEE</div>
        </div>
        {isOwner
          ? <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
              <button onClick={e => { e.stopPropagation(); onUpdatePrice?.(); }}
                style={{ width:'100%', padding:'6px 0', background:'rgba(0,212,255,.08)',
                  border:'1px solid rgba(0,212,255,.25)', borderRadius:6, cursor:'pointer',
                  fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700, color:'#00d4ff',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>✏️ EDIT PRICE</button>
              <button onClick={e => { e.stopPropagation(); onDelist(); }}
                style={{ width:'100%', padding:'6px 0', background:'rgba(255,50,50,.08)',
                  border:'1px solid rgba(255,50,50,.25)', borderRadius:6, cursor:'pointer',
                  fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700, color:'#ff6666' }}>✕ DELIST</button>
            </div>
          : <button onClick={e => { e.stopPropagation(); onBuy(); }} style={{ width:'100%', padding:'8px 0',
              background:'linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.08))',
              border:'1px solid rgba(0,212,255,.4)', borderRadius:7, cursor:'pointer',
              fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#00d4ff' }}>⚡ BUY NOW</button>
        }
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────
//  MARKETPLACE — CONFIRM MODAL
// ─────────────────────────────────────────────────────────────────
const ConfirmModal: FC<{
  listing:   Listing;
  mode:      'buy' | 'delist';
  isMobile:  boolean;
  onConfirm: () => void;
  onCancel:  () => void;
  status:    string;
  pending:   boolean;
}> = ({ listing, mode, isMobile, onConfirm, onCancel, status, pending }) => {
  const nft    = listing.nftData;
  const imgUri = nft?.image || nft?.metaUri || nft?.logoUri;
  useEffect(() => {
    const sy = window.scrollY;
    document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`;
    document.body.style.left = '0'; document.body.style.right = '0'; document.body.style.overflow = 'hidden';
    return () => { document.body.style.position=''; document.body.style.top=''; document.body.style.left=''; document.body.style.right=''; document.body.style.overflow=''; window.scrollTo(0,sy); };
  }, []);
  return createPortal(
    <div onClick={onCancel} style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,.88)',
      backdropFilter:'blur(12px)', display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width:'100%', maxWidth: isMobile ? '94%' : 430,
        background:'linear-gradient(155deg,#0c1520,#080c0f)',
        border:`1px solid ${mode==='buy'?'rgba(0,212,255,.4)':'rgba(255,50,50,.4)'}`,
        borderRadius:18, padding: isMobile ? '20px 18px' : '28px 28px',
        boxShadow:'0 0 60px rgba(0,0,0,.8)', animation:'fadeUp 0.2s cubic-bezier(.22,1,.36,1) both' }}>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 15, fontWeight:900, color:'#fff', marginBottom:4 }}>
          {mode==='buy' ? '⚡ CONFIRM PURCHASE' : '✕ CONFIRM DELIST'}
        </div>
        <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#8aaac8', marginBottom:18 }}>
          {mode==='buy' ? 'You are about to purchase this NFT with XNT' : 'NFT will be returned to your wallet. No fee.'}
        </div>
        <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:18, background:'rgba(255,255,255,.03)',
          borderRadius:10, padding:10, border:'1px solid rgba(255,255,255,.06)' }}>
          <div style={{ position:'relative', width:60, height:60, borderRadius:8, overflow:'hidden', flexShrink:0, background:'#060b12' }}>
            <NFTImage metaUri={imgUri} name={nft?.name ?? ''} />
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:12, fontWeight:700, color:'#fff', marginBottom:3,
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft?.name ?? listing.nftMint.slice(0,12)+'…'}</div>
            <div style={{ fontFamily:'monospace', fontSize:9, color:'#8aaac8' }}>{listing.nftMint.slice(0,12)}…{listing.nftMint.slice(-8)}</div>
          </div>
        </div>
        {mode === 'buy' && (
          <div style={{ marginBottom:18, background:'rgba(0,212,255,.04)', borderRadius:10, border:'1px solid rgba(0,212,255,.18)', overflow:'hidden' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 14px', borderBottom:'1px solid rgba(0,212,255,.1)' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#7aaac4' }}>YOU PAY</span>
              <div><span style={{ fontFamily:'Orbitron,monospace', fontSize:22, fontWeight:900, color:'#00d4ff' }}>{lamportsToXnt(listing.price)}</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf', marginLeft:5 }}>XNT</span></div>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 14px', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf' }}>→ SELLER RECEIVES (98.112%)</span>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#00c98d' }}>{lamportsToXnt(calcSellerCut(listing.price))} XNT</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 14px' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf' }}>→ PLATFORM FEE (1.888%)</span>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#bf5af2' }}>{lamportsToXnt(calcFee(listing.price))} XNT</span>
            </div>
          </div>
        )}
        {mode === 'delist' && (
          <div style={{ marginBottom:18, background:'rgba(255,100,50,.04)', borderRadius:10, border:'1px solid rgba(255,100,50,.2)', overflow:'hidden' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 14px', borderBottom:'1px solid rgba(255,100,50,.1)' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#aa6a4a' }}>CANCEL FEE (0.888%)</span>
              <div><span style={{ fontFamily:'Orbitron,monospace', fontSize:18, fontWeight:900, color:'#ff8c50' }}>{lamportsToXnt(calcCancelFee(listing.price))}</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf', marginLeft:5 }}>XNT</span></div>
            </div>
            <div style={{ padding:'8px 14px' }}>
              <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#6a4a3a' }}>
                Charged on cancellation. Your NFT will be returned to your wallet.
              </span>
            </div>
          </div>
        )}
        <StatusBox msg={status} />
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={onCancel} disabled={pending} style={{ flex:1, padding:'11px 0', background:'rgba(255,255,255,.04)',
            border:'1px solid rgba(255,255,255,.1)', borderRadius:9, cursor: pending?'not-allowed':'pointer',
            fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#9abacf', opacity: pending?0.5:1 }}>CANCEL</button>
          <button onClick={onConfirm} disabled={pending} style={{ flex:2, padding:'11px 0',
            background: mode==='buy'?'linear-gradient(135deg,rgba(0,212,255,.22),rgba(0,212,255,.1))':'linear-gradient(135deg,rgba(255,50,50,.22),rgba(255,50,50,.1))',
            border:`1px solid ${mode==='buy'?'rgba(0,212,255,.5)':'rgba(255,50,50,.5)'}`,
            borderRadius:9, cursor: pending?'not-allowed':'pointer', fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700,
            color: mode==='buy'?'#00d4ff':'#ff6666', opacity: pending?0.7:1,
            display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            {pending ? <><div style={{ width:12, height:12, borderRadius:'50%', border:'2px solid rgba(255,255,255,.2)',
              borderTop:`2px solid ${mode==='buy'?'#00d4ff':'#ff6666'}`, animation:'spin 0.8s linear infinite' }} />PROCESSING…</>
              : mode==='buy' ? '⚡ CONFIRM BUY' : '✕ CONFIRM DELIST'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// ─────────────────────────────────────────────────────────────────
//  MARKETPLACE — SELL PANEL
//  Reuses wallet NFTs already loaded by the gallery.
//  Pre-selects an NFT when coming from gallery modal "LIST" button.
// ─────────────────────────────────────────────────────────────────
const SellPanel: FC<{
  isMobile:        boolean;
  connection:      any;
  publicKey:       PublicKey | null;
  sendTransaction: any;
  signTransaction: ((tx: Transaction) => Promise<Transaction>) | null | undefined;
  walletNfts:      NFTData[];
  loadingNfts:     boolean;
  preselect?:      NFTData | null;
  onListed:        () => void;
}> = ({ isMobile, connection, publicKey, sendTransaction, signTransaction, walletNfts, loadingNfts, preselect, onListed }) => {
  const [selected, setSelected] = useState<NFTData | null>(preselect ?? null);
  const [price, setPrice]       = useState('');
  const [status, setStatus]     = useState('');
  const [pending, setPending]   = useState(false);

  useEffect(() => { if (preselect) setSelected(preselect); }, [preselect?.mint]);

  const handleList = async () => {
    if (!publicKey || !selected || !price) return;
    const lamports = xntToLamports(price);
    if (isNaN(lamports) || lamports <= 0) { setStatus('❌ Enter a valid price'); return; }
    setPending(true); setStatus('Preparing transaction…');
    try {
      const nftMint    = new PublicKey(selected.mint);
      const [salePda]  = getSalePda(nftMint, publicKey);
      const [vaultPda] = getVaultPda(nftMint, publicKey);
      const sellerAta  = getAssociatedTokenAddressSync(nftMint, publicKey);

      const disc      = Buffer.from(DISC_LIST_NFT, 'hex');
      const priceData = Buffer.alloc(8);
      priceData.writeBigUInt64LE(BigInt(lamports));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      console.log('list_nft v2:', {
        mint: nftMint.toBase58(),
        sellerAta: sellerAta.toBase58(),
        vaultPda: vaultPda.toBase58(),
        salePda: salePda.toBase58(),
      });

      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,               isSigner:true,  isWritable:true  }, // 0 seller
          { pubkey: nftMint,                 isSigner:false, isWritable:false }, // 1 nft_mint
          { pubkey: sellerAta,               isSigner:false, isWritable:true  }, // 2 seller_nft_account
          { pubkey: vaultPda,                isSigner:false, isWritable:true  }, // 3 vault_nft_account
          { pubkey: salePda,                 isSigner:false, isWritable:true  }, // 4 sale
          { pubkey: TOKEN_PROGRAM_ID,        isSigner:false, isWritable:false }, // 5 token_program
          { pubkey: SystemProgram.programId, isSigner:false, isWritable:false }, // 6 system_program
          { pubkey: SYSVAR_RENT_PUBKEY,      isSigner:false, isWritable:false }, // 7 rent
        ],
        data: Buffer.concat([disc, priceData]),
      };
      const tx = new Transaction().add(ix as any);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      // Now open wallet — everything is ready
      setStatus('Awaiting wallet approval…');
      const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
      setStatus(`Confirming… tx: ${sig.slice(0,20)}…`);
      // Poll for confirmation — more reliable on X1 than blockhash expiry method
      let confirmed = false;
      for (let i = 0; i < 40; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const conf = status?.value?.confirmationStatus;
        const err  = status?.value?.err;
        if (err) throw new Error('On-chain error: ' + JSON.stringify(err));
        if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
      }
      if (!confirmed) throw new Error(`Timed out. Check tx: ${sig}`);
      setStatus(`✅ Listed! <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#00d4ff;text-decoration:underline">View Tx ↗</a>`);
      saveTrade({ sig, type:'list', nftMint: selected.mint, price: lamports, seller: publicKey.toBase58(), timestamp: Math.floor(Date.now()/1000) });
      setSelected(null); setPrice('');
      setTimeout(() => { setStatus(''); onListed(); }, 2500);
    } catch (e: any) {
      console.error('list_nft error:', e);
      const msg = e?.message ?? e?.logs?.join(' ') ?? JSON.stringify(e) ?? 'Transaction failed';
      setStatus(`❌ ${msg.slice(0, 120)}`);
    } finally { setPending(false); }
  };

  if (!publicKey) return (
    <div style={{ textAlign:'center', padding:'60px 20px' }}>
      <div style={{ fontSize:48, marginBottom:16 }}>🔒</div>
      <div style={{ fontFamily:'Orbitron,monospace', fontSize:13, color:'#9abacf', letterSpacing:2 }}>CONNECT WALLET TO LIST</div>
    </div>
  );
  return (
    <div>
      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 11, color:'#8aaac8', letterSpacing:2, marginBottom:18 }}>
        SELECT AN NFT FROM YOUR WALLET TO LIST
      </div>
      {loadingNfts && (
        <div style={{ textAlign:'center', padding:'40px 0' }}>
          <div style={{ width:26, height:26, borderRadius:'50%', border:'3px solid rgba(0,212,255,.2)', borderTop:'3px solid #00d4ff', animation:'spin 0.8s linear infinite', margin:'0 auto 12px' }} />
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', letterSpacing:1 }}>SCANNING WALLET…</div>
        </div>
      )}
      {!loadingNfts && walletNfts.length === 0 && (
        <div style={{ textAlign:'center', padding:'40px 20px', background:'rgba(255,255,255,.02)', borderRadius:12, border:'1px solid rgba(255,255,255,.06)' }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🔬</div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#9abacf', letterSpacing:1 }}>NO NFTs FOUND IN WALLET</div>
        </div>
      )}
      {!loadingNfts && walletNfts.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(5,1fr)', gap: isMobile ? 7 : 10, marginBottom:24 }}>
          {walletNfts.map(nft => {
            const sel    = selected?.mint === nft.mint;
            const imgUri = nft.image || nft.metaUri || nft.logoUri;
            return (
              <div key={nft.mint} onClick={() => setSelected(sel ? null : nft)}
                style={{ background: sel ? 'rgba(0,212,255,.1)' : 'rgba(255,255,255,.03)',
                  border: sel ? '2px solid rgba(0,212,255,.7)' : '1px solid rgba(255,255,255,.08)',
                  borderRadius:10, overflow:'hidden', cursor:'pointer', transition:'all 0.14s',
                  boxShadow: sel ? '0 0 20px rgba(0,212,255,.2)' : 'none' }}>
                <div style={{ position:'relative', width:'100%', paddingBottom:'100%', background:'#060b12' }}>
                  <NFTImage metaUri={imgUri} name={nft.name} />
                  {sel && <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,212,255,.15)' }}>
                    <div style={{ width:24, height:24, borderRadius:'50%', background:'#00d4ff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, color:'#000', fontWeight:900 }}>✓</div>
                  </div>}
                </div>
                <div style={{ padding:'4px 6px 6px' }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700,
                    color: sel ? '#00d4ff' : '#8aa0b8', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {selected && (
        <div style={{ background:'rgba(0,212,255,.04)', border:'1px solid rgba(0,212,255,.2)', borderRadius:14, padding: isMobile ? '16px 14px' : '20px 20px', animation:'fadeUp 0.2s ease both' }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', letterSpacing:1.5, marginBottom:12 }}>SET LISTING PRICE</div>
          <div style={{ position:'relative', marginBottom:14 }}>
            <input type="number" min="0" step="0.0001" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.0000"
              style={{ width:'100%', boxSizing:'border-box', padding:'12px 52px 12px 16px', background:'rgba(0,0,0,.4)',
                border:'1px solid rgba(0,212,255,.3)', borderRadius:10, outline:'none',
                color:'#00d4ff', fontFamily:'Orbitron,monospace', fontSize:16, fontWeight:700, caretColor:'#00d4ff' }} />
            <span style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)', fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf', pointerEvents:'none' }}>XNT</span>
          </div>
          {price && parseFloat(price) > 0 && (
            <div style={{ marginBottom:14, background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.06)', borderRadius:10, overflow:'hidden' }}>
              {[
                { l:'LISTING PRICE',    v:`${price} XNT`,                            c:'#00d4ff' },
                { l:'YOU RECEIVE (98.112%)',v:`${(parseFloat(price) * (1 - SALE_FEE_NUMERATOR/SALE_FEE_DENOMINATOR)).toFixed(4)} XNT`, c:'#00c98d' },
                { l:'PLATFORM FEE (1.888%)',v:`${(parseFloat(price) * SALE_FEE_NUMERATOR/SALE_FEE_DENOMINATOR).toFixed(4)} XNT`, c:'#bf5af2' },
              ].map(({l,v,c},i,arr) =>
                <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'7px 12px',
                  borderBottom: i < arr.length-1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf' }}>{l}</span>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:c }}>{v}</span>
                </div>
              )}
            </div>
          )}
          <StatusBox msg={status} />
          <button onClick={handleList} disabled={pending || !price || parseFloat(price) <= 0}
            style={{ width:'100%', padding:'13px 0', background:'linear-gradient(135deg,rgba(0,212,255,.22),rgba(0,212,255,.1))',
              border:'1px solid rgba(0,212,255,.5)', borderRadius:10, cursor: pending?'not-allowed':'pointer',
              fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color:'#00d4ff',
              letterSpacing:1, opacity: pending?0.7:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            {pending ? <><div style={{ width:14, height:14, borderRadius:'50%', border:'2px solid rgba(0,212,255,.2)', borderTop:'2px solid #00d4ff', animation:'spin 0.8s linear infinite' }} />LISTING…</> : '🏷️ LIST NFT FOR SALE'}
          </button>
        </div>
      )}
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════
//  LIST NFT MODAL — popup when clicking "List for Sale"
// ═════════════════════════════════════════════════════════════════
const ListModal: FC<{
  nft:            NFTData;
  connection:     any;
  publicKey:      PublicKey | null;
  sendTransaction: any;
  signTransaction: ((tx: Transaction) => Promise<Transaction>) | null | undefined;
  onClose:        () => void;
  onListed:       () => void;
}> = ({ nft, connection, publicKey, sendTransaction, signTransaction, onClose, onListed }) => {
  const [price, setPrice]   = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  const fee     = price ? calcFee(xntToLamports(price))         : 0;
  const receive = price ? calcSellerCut(xntToLamports(price))   : 0;

  const handleList = async () => {
    if (!publicKey || !price) return;
    const lamports = xntToLamports(price);
    if (isNaN(lamports) || lamports <= 0) { setStatus('❌ Enter a valid price'); return; }
    setPending(true); setStatus('Preparing…');
    try {
      const nftMint    = new PublicKey(nft.mint);
      const [salePda]  = getSalePda(nftMint, publicKey);
      const [vaultPda] = getVaultPda(nftMint, publicKey);
      const sellerAta  = getAssociatedTokenAddressSync(nftMint, publicKey);
      const disc       = Buffer.from(DISC_LIST_NFT, 'hex');
      const priceData  = Buffer.alloc(8);
      priceData.writeBigUInt64LE(BigInt(lamports));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,               isSigner:true,  isWritable:true  },
          { pubkey: nftMint,                 isSigner:false, isWritable:false },
          { pubkey: sellerAta,               isSigner:false, isWritable:true  },
          { pubkey: vaultPda,                isSigner:false, isWritable:true  },
          { pubkey: salePda,                 isSigner:false, isWritable:true  },
          { pubkey: TOKEN_PROGRAM_ID,        isSigner:false, isWritable:false },
          { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
          { pubkey: SYSVAR_RENT_PUBKEY,      isSigner:false, isWritable:false },
        ],
        data: Buffer.concat([disc, priceData]),
      };
      const tx = new Transaction().add(ix as any);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      setStatus('Awaiting wallet approval…');
      const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
      setStatus('Confirming…');
      let confirmed = false;
      for (let i = 0; i < 40; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const conf = st?.value?.confirmationStatus;
        const err  = st?.value?.err;
        if (err) throw new Error('On-chain error: ' + JSON.stringify(err));
        if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
      }
      if (!confirmed) throw new Error(`Timed out. Check tx: ${sig}`);
      setStatus(`✅ Listed! <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#00d4ff">View Tx ↗</a>`);
      saveTrade({ sig, type:'list', nftMint: nft.mint, price: lamports, seller: publicKey.toBase58(), timestamp: Math.floor(Date.now()/1000) });
      setTimeout(() => { onListed(); onClose(); }, 2500);
    } catch (e: any) {
      console.error('list error:', e);
      setStatus(`❌ ${e?.message?.slice(0,120) ?? 'Failed'}`);
    } finally { setPending(false); }
  };

  return createPortal(
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.75)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:'#0a1628', border:'1px solid rgba(0,212,255,.2)', borderRadius:16, padding:28, width:'100%', maxWidth:420, fontFamily:'Sora,sans-serif' }}>

        {/* Header */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <span style={{ fontFamily:'Orbitron,monospace', fontSize:13, fontWeight:700, color:'#00d4ff', letterSpacing:2 }}>🏷️ LIST FOR SALE</span>
          <button onClick={onClose} disabled={pending} style={{ background:'none', border:'none', color:'#8aaac8', fontSize:18, cursor:'pointer', lineHeight:1 }}>✕</button>
        </div>

        {/* NFT Preview */}
        <div style={{ display:'flex', gap:14, marginBottom:20, padding:14, background:'rgba(0,212,255,.04)', border:'1px solid rgba(0,212,255,.1)', borderRadius:12 }}>
          {nft.image && <img src={nft.image} alt={nft.name} style={{ width:72, height:72, borderRadius:8, objectFit:'cover', flexShrink:0, imageRendering:'pixelated' }} />}
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color:'#e0f0ff', marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
            <div style={{ fontSize:10, color:'#8aaac8', marginBottom:6 }}>{nft.symbol}</div>
            <div style={{ fontSize:9, color:'#9abacf', fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.mint.slice(0,16)}…</div>
            {nft.attributes?.slice(0,3).map((a,i) => (
              <span key={i} style={{ display:'inline-block', fontSize:8, background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.15)', borderRadius:4, padding:'1px 5px', marginRight:4, marginTop:4, color:'#7abcd0' }}>
                {a.trait_type}: {a.value}
              </span>
            ))}
          </div>
        </div>

        {/* Price Input */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:10, color:'#8aaac8', marginBottom:6, letterSpacing:1, fontFamily:'Orbitron,monospace' }}>SET LISTING PRICE</div>
          <div style={{ position:'relative' }}>
            <input value={price} onChange={e => setPrice(e.target.value)} type="number" min="0" step="0.1" placeholder="0.00"
              disabled={pending}
              style={{ width:'100%', padding:'12px 48px 12px 14px', background:'rgba(255,255,255,.04)', border:'1px solid rgba(0,212,255,.2)', borderRadius:10, color:'#e0f0ff', fontSize:16, fontFamily:'Orbitron,monospace', outline:'none', boxSizing:'border-box' }} />
            <span style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)', fontSize:11, color:'#00d4ff', fontFamily:'Orbitron,monospace', fontWeight:700 }}>XNT</span>
          </div>
        </div>

        {/* Fee breakdown */}
        {price && Number(price) > 0 && (
          <div style={{ marginBottom:16, padding:'10px 14px', background:'rgba(0,0,0,.2)', borderRadius:8, fontSize:10 }}>
            <div style={{ display:'flex', justifyContent:'space-between', color:'#8aaac8', marginBottom:4 }}>
              <span>LISTING PRICE</span><span style={{ color:'#e0f0ff' }}>{price} XNT</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', color:'#8aaac8', marginBottom:4 }}>
              <span>PLATFORM FEE (1.888%)</span><span style={{ color:'#ff9944' }}>{lamportsToXnt(fee)} XNT</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', color:'#8aaac8', borderTop:'1px solid rgba(255,255,255,.06)', paddingTop:4, marginTop:4 }}>
              <span>YOU RECEIVE</span><span style={{ color:'#00c98d', fontWeight:700 }}>{lamportsToXnt(receive)} XNT</span>
            </div>
          </div>
        )}

        <StatusBox msg={status} />

        {/* Actions */}
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={onClose} disabled={pending} style={{ flex:1, padding:'12px 0', background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.1)', borderRadius:10, cursor:pending?'not-allowed':'pointer', fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#9abacf', opacity:pending?.5:1 }}>CANCEL</button>
          <button onClick={handleList} disabled={pending || !price || Number(price)<=0}
            style={{ flex:2, padding:'12px 0', background:'linear-gradient(135deg,rgba(0,212,255,.2),rgba(0,212,255,.08))', border:'1px solid rgba(0,212,255,.4)', borderRadius:10, cursor:(pending||!price||Number(price)<=0)?'not-allowed':'pointer', fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#00d4ff', opacity:(pending||!price||Number(price)<=0)?.5:1, display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
            {pending ? <><div style={{ width:12, height:12, borderRadius:'50%', border:'2px solid rgba(0,212,255,.2)', borderTop:'2px solid #00d4ff', animation:'spin 0.8s linear infinite' }} />LISTING…</> : '🏷️ LIST NFT FOR SALE'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// ─────────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────────

// ── Type exports ──
export type { NFTData, Listing, TradeLog, PageMode, MarketTab };

// ── Value exports ──
export {
  // Caches & utils
  lwImageCache, lwMetaCache, lwPdaCache, lwNFTDataCache, lwNFTInFlight,
  persistLwCache, fetchNFTMeta,
  // Discriminators
  DISC_LIST_NFT, DISC_BUY_NFT, DISC_CANCEL, DISC_UPDATE_PRICE,
  DISC_SALE_ACCOUNT, DISC_SALE_B58,
  // Constants
  METADATA_PROGRAM_ID, PLATFORM_WALLET, MARKETPLACE_DEPLOYED,
  // Helpers
  useIsMobile, getMarketplaceProgramId,
  getSalePda, getVaultPda, getListingPda, getEscrowPda,
  lamportsToXnt, calcFee, calcCancelFee, calcSellerCut, xntToLamports,
  saveTrade, sendTx, discriminatorAsync,
  parseMetaplexPDA, decodeAccountData,
  enrichNFTFromMint, enrichNFT,
  fetchWalletNFTs, groupByCollection,
  fetchAllListings, batchEnrichListings, enrichListing,
  fetchAgentIDByWallet,
  // Components
  NFTImage, StatusBox,
  NFTDetailModal, NFTCard, CollectionSection,
  UpdatePriceModal, ListingCard, ConfirmModal,
  SellPanel, ListModal,
};