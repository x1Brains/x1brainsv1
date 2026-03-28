import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
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
const LW_IMG_CACHE_KEY = 'x1b_lw_img_v2';
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

async function fetchNFTMeta(metaUri: string): Promise<any | null> {
  if (lwMetaCache.has(metaUri)) return lwMetaCache.get(metaUri);
  const url = resolveGateway(metaUri);
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) return null;
  try {
    const res = await fetch(toProxyUrl(url), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
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
        const res = await fetch(toProxyUrl(url), { signal: AbortSignal.timeout(6000) });
        // Fast-fail on 404 or other errors — cache null immediately so we don't retry
        if (!res.ok) {
          lwImageCache.set(metaUri, null); persistLwCache();
          if (!cancelled) setImgSrc(null); return;
        }
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
            lwImageCache.set(metaUri, resolvedRaw); persistLwCache();
            if (!cancelled) setImgSrc(resolvedRaw); return;
          }
        } catch {}
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
interface NFTData {
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
interface Listing {
  listingPda: string;
  escrowPda:  string;
  seller:     string;
  nftMint:    string;
  price:      number;   // lamports
  active:     boolean;
  nftData?:   NFTData;
}
type PageMode  = 'gallery' | 'market';
type MarketTab = 'overview' | 'browse' | 'mylistings' | 'sell' | 'activity';

interface TradeLog {
  sig:       string;
  type:      'list' | 'buy' | 'delist';
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
async function saveTrade(trade: { sig: string; type: 'list'|'buy'|'delist'; nftMint: string; price?: number; seller?: string; buyer?: string; timestamp: number }) {
  try {
    if (!supabase) return;
    await supabase.from('labwork_trades').upsert({
      sig: trade.sig, type: trade.type, nft_mint: trade.nftMint,
      price: trade.price, seller: trade.seller, buyer: trade.buyer,
      timestamp: trade.timestamp,
    }, { onConflict: 'sig' });
  } catch { /* non-critical */ }
}

// Send transaction - tries signTransaction first to bypass wallet simulation,
// falls back to sendTransaction if sign fails.
// skipPreflight: true for list/buy (speed), false for cancel (protect fees on failure).
async function sendTx(
  tx: Transaction,
  connection: any,
  sendTransaction: any,
  signTransaction?: ((tx: Transaction) => Promise<Transaction>) | null,
  skipPreflight = true,
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

  return {
    ...nft,
    description: json.description  ?? nft.description,
    attributes:  Array.isArray(json.attributes) ? json.attributes : nft.attributes,
    externalUrl: json.external_url ?? json.external_link ?? json.external_url ?? nft.externalUrl,
    collection:  typeof json.collection === 'string'
      ? json.collection
      : (json.collection?.name ?? nft.collection),
    image: rawImg ? resolveGateway(rawImg) : nft.image,
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
  const uncached = listings.filter(l => !lwPdaCache.has(l.nftMint));
  const BATCH = 100; // RPC max

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
        if (parsed) lwPdaCache.set(chunk[idx].nftMint, parsed);
      });
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
  // If we got metadata URI, also fetch the image/attributes
  if (enriched.nftData?.metaUri && !enriched.nftData.image) {
    const withAttrs = await enrichNFT(enriched.nftData);
    return { ...enriched, nftData: withAttrs };
  }
  return enriched;
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
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed'; document.body.style.top = `-${scrollY}px`;
    document.body.style.left = '0'; document.body.style.right = '0'; document.body.style.overflow = 'hidden';
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => {
      document.body.style.position = ''; document.body.style.top = '';
      document.body.style.left = ''; document.body.style.right = ''; document.body.style.overflow = '';
      window.scrollTo(0, scrollY); window.removeEventListener('keydown', fn);
    };
  }, []);
  const copyMint = () => { navigator.clipboard.writeText(nft.mint); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  return createPortal(
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,.88)',
      backdropFilter:'blur(14px)', display:'flex', alignItems:'center', justifyContent:'center',
      padding: isMobile ? 12 : 20, animation:'labFadeIn 0.18s ease both' }}>
      <style>{`
        @keyframes labFadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes labSlideUp { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes labScan    { 0%{transform:translateY(-100%)} 100%{transform:translateY(400%)} }
        @keyframes labGlow    { 0%,100%{opacity:.4} 50%{opacity:1} }
      `}</style>
      <div onClick={e => e.stopPropagation()} style={{ width:'100%', maxWidth: isMobile ? '96%' : 580,
        background:'linear-gradient(155deg,#0c1520,#080c0f)', border:'1px solid rgba(191,90,242,.4)',
        borderRadius:20, boxShadow:'0 0 60px rgba(191,90,242,.12), 0 32px 80px rgba(0,0,0,.9)',
        animation:'labSlideUp 0.22s cubic-bezier(.22,1,.36,1) both', position:'relative', overflow:'hidden' }}>
        <div style={{ position:'absolute', left:0, right:0, height:2, zIndex:2, pointerEvents:'none',
          background:'linear-gradient(90deg,transparent,rgba(191,90,242,.6),transparent)',
          animation:'labScan 3s linear infinite', opacity:0.5 }} />
        <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1,
          background:'linear-gradient(90deg,transparent,rgba(0,212,255,.8),rgba(191,90,242,.8),transparent)' }} />
        <button onClick={onClose} style={{ position:'absolute', top:12, right:12, zIndex:10, width:32, height:32,
          borderRadius:'50%', border:'1px solid rgba(191,90,242,.35)', background:'rgba(8,12,15,.9)',
          cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, color:'#bf5af2' }}>×</button>

        {isMobile ? (
          <div style={{ display:'flex', flexDirection:'column' }}>
            <div style={{ position:'relative', width:'100%', height:200, background:'linear-gradient(135deg,#050a0f,#0a0f18)',
              borderRadius:'19px 19px 0 0', overflow:'hidden' }}>
              <NFTImage metaUri={imgUri} name={nft.name} contain />
              <div style={{ position:'absolute', top:10, left:10, background:'rgba(0,0,0,.75)',
                border:'1px solid rgba(0,212,255,.4)', borderRadius:5, padding:'2px 8px',
                fontFamily:'Orbitron,monospace', fontSize:8, color:'#00d4ff', fontWeight:700 }}>🧪 NFT</div>
              {rarity && <div style={{ position:'absolute', bottom:10, left:10, background:'rgba(0,0,0,.8)',
                backdropFilter:'blur(6px)', border:`1px solid ${rarityColor(rarity)}55`, borderRadius:6,
                padding:'3px 10px', fontFamily:'Orbitron,monospace', fontSize:8,
                color:rarityColor(rarity), fontWeight:700, letterSpacing:1.2 }}>✦ {rarity.toUpperCase()}</div>}
            </div>
            <div style={{ padding:'12px 14px 18px', display:'flex', flexDirection:'column', gap:9 }}>
              <div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:15, fontWeight:900, color:'#fff', marginBottom:4 }}>{nft.name}</div>
                <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                  {nft.collection && <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abace' }}>{nft.collection}</span>}
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00d4ff',
                    background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)', padding:'1px 6px', borderRadius:3 }}>{nft.symbol}</span>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                    background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.25)', padding:'1px 6px', borderRadius:3 }}>{nft.isToken2022 ? 'T-2022' : 'SPL'}</span>
                </div>
              </div>
              {nft.description && <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abace', lineHeight:1.6 }}>{nft.description.length > 120 ? nft.description.slice(0,120)+'…' : nft.description}</div>}
              {nft.attributes && nft.attributes.length > 0 && (
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', letterSpacing:1.5, marginBottom:5 }}>TRAITS — {nft.attributes.length}</div>
                  <div style={{ display:'flex', gap:5, overflowX:'auto', paddingBottom:3, scrollbarWidth:'none' }}>
                    {nft.attributes.map((a, i) => { const isR = a.trait_type?.toLowerCase() === 'rarity'; const col = isR ? rarityColor(a.value) : '#bf5af2';
                      return <div key={i} style={{ flexShrink:0, minWidth:64, textAlign:'center', background:'rgba(191,90,242,.05)',
                        border:`1px solid ${isR ? col+'44' : 'rgba(191,90,242,.15)'}`, borderRadius:6, padding:'4px 8px' }}>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginBottom:2, whiteSpace:'nowrap' }}>{a.trait_type}</div>
                        <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, fontWeight:600, color: isR ? col : '#b8cce0', whiteSpace:'nowrap' }}>{a.value}</div>
                      </div>; })}
                  </div>
                </div>
              )}
              <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(0,0,0,.3)', borderRadius:7,
                border:'1px solid rgba(255,255,255,.06)', padding:'6px 10px' }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', flexShrink:0 }}>MINT</span>
                <code style={{ flex:1, fontFamily:'monospace', fontSize:9, color:'#8aaac4', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.mint.slice(0,10)}…{nft.mint.slice(-8)}</code>
                <button onClick={copyMint} style={{ flexShrink:0, padding:'3px 8px', borderRadius:4, cursor:'pointer', border:'none',
                  background: copied ? 'rgba(0,201,141,.2)' : 'rgba(191,90,242,.15)', color: copied ? '#00c98d' : '#bf5af2',
                  fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700 }}>{copied ? '✓' : 'COPY'}</button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:5 }}>
                {[{l:'CHAIN',v:'X1'},{l:'STD',v:nft.isToken2022?'T-2022':'SPL'},{l:'DEC',v:String(nft.decimals)},{l:'QTY',v:String(nft.balance)}].map(({l,v}) =>
                  <div key={l} style={{ background:'rgba(255,255,255,.02)', borderRadius:6, border:'1px solid rgba(255,255,255,.05)', padding:'4px 0', textAlign:'center' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginBottom:2 }}>{l}</div>
                    <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, fontWeight:600, color:'#b0c4d8' }}>{v}</div>
                  </div>)}
              </div>
              <div style={{ display:'flex', gap:6 }}>
                <a href={`https://explorer.mainnet.x1.xyz/address/${nft.mint}`} target="_blank" rel="noopener noreferrer"
                  style={{ flex:1, padding:'9px 0', textAlign:'center', background:'rgba(0,212,255,.08)',
                    border:'1px solid rgba(0,212,255,.3)', borderRadius:8, fontFamily:'Orbitron,monospace',
                    fontSize:8, fontWeight:700, color:'#00d4ff', textDecoration:'none',
                    display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>🔍 EXPLORER ↗</a>
                {nft.externalUrl && <a href={nft.externalUrl} target="_blank" rel="noopener noreferrer"
                  style={{ flex:1, padding:'9px 0', textAlign:'center', background:'rgba(191,90,242,.08)',
                    border:'1px solid rgba(191,90,242,.3)', borderRadius:8, fontFamily:'Orbitron,monospace',
                    fontSize:8, fontWeight:700, color:'#bf5af2', textDecoration:'none',
                    display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>🌐 WEBSITE ↗</a>}
                {onListThis && <button onClick={() => { onClose(); onListThis(nft); }}
                  style={{ flex:1, padding:'9px 0', background:'rgba(0,201,141,.08)', border:'1px solid rgba(0,201,141,.35)',
                    borderRadius:8, fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#00c98d',
                    cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>🏷️ LIST</button>}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display:'flex' }}>
            <div style={{ position:'relative', width:240, flexShrink:0, background:'linear-gradient(135deg,#050a0f,#0a0f18)',
              borderRadius:'19px 0 0 19px', overflow:'hidden' }}>
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
            <div style={{ flex:1, padding:'18px 20px', display:'flex', flexDirection:'column', gap:10,
              minWidth:0, overflowY:'auto', maxHeight:'85vh', scrollbarWidth:'none' }}>
              <div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:16, fontWeight:900, color:'#fff',
                  marginBottom:5, lineHeight:1.2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
                <div style={{ display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
                  {nft.collection && <span style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abace' }}>{nft.collection}</span>}
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00d4ff',
                    background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)', padding:'2px 7px', borderRadius:3 }}>{nft.symbol}</span>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                    background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.25)', padding:'2px 7px', borderRadius:3 }}>{nft.isToken2022 ? 'TOKEN-2022' : 'SPL'}</span>
                </div>
              </div>
              {nft.description && <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abace', lineHeight:1.65 }}>{nft.description.length > 160 ? nft.description.slice(0,160)+'…' : nft.description}</div>}
              {nft.attributes && nft.attributes.length > 0 && (
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf', letterSpacing:1.5, marginBottom:7 }}>TRAITS — {nft.attributes.length}</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                    {nft.attributes.map((a, i) => { const isR = a.trait_type?.toLowerCase() === 'rarity'; const col = isR ? rarityColor(a.value) : '#bf5af2';
                      return <div key={i} style={{ background:'rgba(191,90,242,.05)', border:`1px solid ${isR ? col+'44' : 'rgba(191,90,242,.15)'}`,
                        borderRadius:5, padding:'3px 8px', boxShadow: isR ? `0 0 10px ${col}18` : 'none' }}>
                        <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginRight:4 }}>{a.trait_type}:</span>
                        <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, fontWeight:600, color: isR ? col : '#b8cce0' }}>{a.value}</span>
                      </div>; })}
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
              <div style={{ display:'flex', gap:8, marginTop:'auto' }}>
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
          </div>
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

// ═════════════════════════════════════════════════════════════════
//  MAIN PAGE COMPONENT
// ═════════════════════════════════════════════════════════════════
const LabWork: FC = () => {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { connection }                 = useConnection();
  const isMobile                       = useIsMobile();

  // Page state
  const [pageMode, setPageMode]     = useState<PageMode>('market');
  const [marketTab, setMarketTab]   = useState<MarketTab>('overview');
  const [showListModal, setShowListModal] = useState(false);

  // Gallery state
  const [nfts, setNfts]             = useState<NFTData[]>([]);
  const [loading, setLoading]       = useState(false);
  const [enriching, setEnriching]   = useState(false);
  const [error, setError]           = useState('');
  const [selected, setSelected]     = useState<NFTData | null>(null);
  const [searchQ, setSearchQ]       = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [loadLabel, setLoadLabel]   = useState('');

  // Debounce search — only filter after 150ms of no typing
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchQ), 150);
    return () => clearTimeout(t);
  }, [searchQ]);
  const [prelistNft, setPrelistNft] = useState<NFTData | null>(null);

  // Marketplace state
  const [listings, setListings]               = useState<Listing[]>([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [listingsPage, setListingsPage]       = useState(48);
  const [browseCollection, setBrowseCollection] = useState<string | null>(null); // null = all
  const [confirmTarget, setConfirmTarget]     = useState<{ listing: Listing; mode: 'buy' | 'delist' } | null>(null);
  const [txStatus, setTxStatus]               = useState('');
  const [txPending, setTxPending]             = useState(false);
  const [tradeLogs, setTradeLogs]             = useState<TradeLog[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);

  // ── Load wallet NFTs ──────────────────────────────────────────
  useEffect(() => {
    if (!publicKey) { setNfts([]); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(''); setLoadLabel('Scanning wallet…');
      try {
        const raw = await fetchWalletNFTs(connection, publicKey);
        if (cancelled) return;
        setNfts(raw); setLoading(false);
        if (raw.length === 0) return;
        setEnriching(true); setLoadLabel('Loading metadata…');
        const enriched = await Promise.all(raw.map(n => enrichNFT(n)));
        if (!cancelled) { setNfts(enriched); setEnriching(false); setLoadLabel(''); }
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? 'Failed to load NFTs'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey?.toBase58()]);

  // ── Load marketplace listings ─────────────────────────────────
  const loadListings = useCallback(async () => {
    setLoadingListings(true);
    const raw = await fetchAllListings(connection);
    // Render bare listings immediately — grid appears with price/seller data
    setListings(raw);
    setListingsPage(48);
    setLoadingListings(false);
    if (raw.length === 0) return;
    // Batch-fetch all Metaplex PDAs in one RPC call per 100 listings
    // then progressively enrich image/attributes in background
    const withMeta = await batchEnrichListings(connection, raw);
    setListings([...withMeta]);
    // Now fetch off-chain metadata (images/attributes) in batches of 6
    const BATCH = 6;
    let current = [...withMeta];
    for (let i = 0; i < withMeta.length; i += BATCH) {
      const chunk = withMeta.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        chunk.map(async l => {
          if (!l.nftData?.metaUri || l.nftData?.image) return l;
          const enriched = await enrichNFT(l.nftData);
          return { ...l, nftData: enriched };
        })
      );
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') current[i + idx] = r.value;
      });
      setListings([...current]);
    }
  }, [connection]);

  const loadActivity = useCallback(async () => {
    setLoadingActivity(true);
    try {
      // ── Step 1: Supabase first — render immediately if we have data ──
      let supaLogs: TradeLog[] = [];
      try {
        if (supabase) {
          const { data } = await supabase
            .from('labwork_trades')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(50);
          if (data && data.length > 0) {
            supaLogs = data.map((r: any) => ({
              sig: r.sig, type: r.type, nftMint: r.nft_mint,
              price: r.price, seller: r.seller, buyer: r.buyer,
              timestamp: r.timestamp,
            }));
            // Render Supabase logs immediately — don't wait for chain or enrichment
            setTradeLogs(supaLogs);
            setLoadingActivity(false);
          }
        }
      } catch { /* supabase not available */ }

      // ── Step 2: Chain fetch — only if Supabase had no data ──
      // If Supabase returned results we already have good data; skip the slow chain walk.
      let chainLogs: TradeLog[] = [];
      if (supaLogs.length === 0) {
        try {
          const progId     = getMarketplaceProgramId();
          const sigs       = await connection.getSignaturesForAddress(progId, { limit: 25 });
          const validSigs  = sigs.filter((s: any) => !s.err).slice(0, 12);
          const listDisc = DISC_LIST_NFT;
          const buyDisc  = DISC_BUY_NFT;
          const delistDisc = DISC_CANCEL;

          // Fetch all transactions in parallel (not sequential)
          const txResults = await Promise.allSettled(
            validSigs.map((s: any) => connection.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }))
          );

          txResults.forEach((result, idx) => {
            if (result.status !== 'fulfilled' || !result.value) return;
            const tx  = result.value;
            const sig = validSigs[idx].signature;
            const ts  = tx.blockTime ?? 0;
            const msg = tx.transaction?.message;
            const accountKeys: string[] = (msg?.accountKeys ?? msg?.staticAccountKeys ?? [])
              .map((k: any) => k?.toBase58?.() ?? k?.toString?.() ?? k);
            const ixs = msg?.instructions ?? [];

            for (const ix of ixs as any[]) {
              const progKey = accountKeys[ix.programIdIndex ?? -1] ?? '';
              if (progKey !== progId.toBase58()) continue;

              let dataHex = '';
              if (ix.data) {
                try { dataHex = Buffer.from(ix.data, 'base58' as any).toString('hex'); }
                catch { try { dataHex = Buffer.from(ix.data, 'base64').toString('hex'); } catch {} }
              }

              const disc8 = dataHex.slice(0, 16);
              let type: TradeLog['type'] | null = null;
              if (disc8 === listDisc)   type = 'list';
              if (disc8 === buyDisc)    type = 'buy';
              if (disc8 === delistDisc) type = 'delist';
              if (!type) continue;

              const ixAccs = (ix.accounts ?? []).map((i: number) => accountKeys[i] ?? '');
              const mint   = ixAccs[1] ?? '';
              const seller = type === 'buy' ? (ixAccs[5] ?? '') : (ixAccs[0] ?? '');
              const buyer  = type === 'buy' ? (ixAccs[0] ?? '') : undefined;
              let price: number | undefined;
              if (type !== 'delist' && dataHex.length >= 32) {
                try { price = Number(Buffer.from(dataHex.slice(16, 32), 'hex').readBigUInt64LE(0)); } catch {}
              }
              chainLogs.push({ sig, type, nftMint: mint, price, seller, buyer, timestamp: ts });
            }
          });
        } catch { /* chain fetch failed — supabase is fallback */ }
      }

      // ── Step 3: Merge + deduplicate ──
      const supaSet = new Set(supaLogs.map(l => l.sig));
      const merged  = [...supaLogs, ...chainLogs.filter(l => !supaSet.has(l.sig))]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);

      if (merged.length === 0) { setLoadingActivity(false); return; }

      // ── Step 4: Enrich metadata — only top 10, concurrency-capped ──
      // Use cached data first, only fetch what's missing
      const toEnrich = merged.slice(0, 10).filter(l => !l.nftData && l.nftMint);
      const CONCURRENCY = 3;
      const enrichedMap = new Map<string, NFTData>();
      for (let i = 0; i < toEnrich.length; i += CONCURRENCY) {
        const chunk = toEnrich.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map(log => enrichNFTFromMint(connection, log.nftMint))
        );
        results.forEach((r, idx) => {
          if (r.status === 'fulfilled') enrichedMap.set(chunk[idx].sig, r.value);
        });
      }

      const final = merged.map(log =>
        enrichedMap.has(log.sig) ? { ...log, nftData: enrichedMap.get(log.sig) } : log
      );
      setTradeLogs(final);
    } catch (e) { console.error('loadActivity error:', e); }
    setLoadingActivity(false);
  }, [connection]);

  useEffect(() => { loadListings(); }, []);
  useEffect(() => { loadActivity(); }, []);
  useEffect(() => { if (pageMode === 'gallery' && nfts.length === 0 && publicKey) { /* NFTs load via wallet useEffect */ } }, [pageMode]);
  useEffect(() => { if (marketTab === 'activity') loadActivity(); }, [marketTab]);

  // ── Gallery select ────────────────────────────────────────────
  const handleSelect = useCallback(async (nft: NFTData) => {
    setSelected(nft);
    const fresh = await enrichNFT(nft);
    setSelected(fresh);
  }, []);

  // ── "List this" shortcut from gallery modal ───────────────────
  const handleListFromGallery = (nft: NFTData) => {
    setPrelistNft(nft); setShowListModal(true);
  };

  // Stable callbacks for ListingCard — using listing PDA as identifier
  // so React.memo on ListingCard actually prevents re-renders
  const handleBuy    = useCallback((listing: Listing) => { setConfirmTarget({ listing, mode:'buy' });    setTxStatus(''); }, []);
  const handleDelist = useCallback((listing: Listing) => { setConfirmTarget({ listing, mode:'delist' }); setTxStatus(''); }, []);
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null);
  const handleInspectListing = useCallback((listing: Listing) => { setSelectedListing(listing); }, []);
  const [updatePriceListing, setUpdatePriceListing] = useState<Listing | null>(null);
  const handleUpdatePrice = useCallback((listing: Listing) => { setUpdatePriceListing(listing); }, []);

  // ── BUY transaction ───────────────────────────────────────────
  const executeBuy = async () => {
    if (!publicKey || !confirmTarget) return;
    const { listing } = confirmTarget;
    setTxPending(true); setTxStatus('Preparing…');
    try {
      const nftMint    = new PublicKey(listing.nftMint);
      const sellerPk   = new PublicKey(listing.seller);
      const [salePda]  = getSalePda(nftMint, sellerPk);
      const [vaultPda] = getVaultPda(nftMint, sellerPk);
      const buyerAta   = getAssociatedTokenAddressSync(nftMint, publicKey);

      const disc = Buffer.from(DISC_BUY_NFT, 'hex');
      const preIxs: any[] = [];
      if (!(await connection.getAccountInfo(buyerAta)))
        preIxs.push(createAssociatedTokenAccountInstruction(publicKey, buyerAta, publicKey, nftMint));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,               isSigner:true,  isWritable:true  }, // 0 buyer
          { pubkey: nftMint,                 isSigner:false, isWritable:false }, // 1 nft_mint
          { pubkey: buyerAta,                isSigner:false, isWritable:true  }, // 2 buyer_nft_account
          { pubkey: vaultPda,                isSigner:false, isWritable:true  }, // 3 vault_nft_account
          { pubkey: salePda,                 isSigner:false, isWritable:true  }, // 4 sale
          { pubkey: sellerPk,                isSigner:false, isWritable:true  }, // 5 seller_wallet
          { pubkey: PLATFORM_WALLET!,        isSigner:false, isWritable:true  }, // 6 platform_wallet
          { pubkey: TOKEN_PROGRAM_ID,        isSigner:false, isWritable:false }, // 7 token_program
          { pubkey: SystemProgram.programId, isSigner:false, isWritable:false }, // 8 system_program
        ],
        data: disc,
      };
      const tx = new Transaction().add(...preIxs, ix as any);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      setTxStatus('Awaiting wallet approval…');
      const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
      setTxStatus(`Confirming… tx: ${sig.slice(0,20)}…`);
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
      setTxStatus(`✅ NFT purchased! <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#00d4ff;text-decoration:underline">View Tx ↗</a>`);
      saveTrade({ sig, type:'buy', nftMint: listing.nftMint, price: listing.price, seller: listing.seller, buyer: publicKey.toBase58(), timestamp: Math.floor(Date.now()/1000) });
      setTimeout(() => { setConfirmTarget(null); setTxStatus(''); loadListings(); }, 2500);
    } catch (e: any) {
      setTxStatus(`❌ ${e?.message?.slice(0,120) ?? 'Transaction failed'}`);
    } finally { setTxPending(false); }
  };

  // ── DELIST transaction ────────────────────────────────────────
  const executeDelist = async () => {
    if (!publicKey || !confirmTarget) return;
    const { listing } = confirmTarget;
    setTxPending(true); setTxStatus('Preparing…');
    try {
      const nftMint    = new PublicKey(listing.nftMint);
      const [salePda]  = getSalePda(nftMint, publicKey);
      const [vaultPda] = getVaultPda(nftMint, publicKey);
      const sellerAta  = getAssociatedTokenAddressSync(nftMint, publicKey);

      const disc = Buffer.from(DISC_CANCEL, 'hex');
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,               isSigner:true,  isWritable:true  }, // 0 seller
          { pubkey: nftMint,                 isSigner:false, isWritable:false }, // 1 nft_mint
          { pubkey: sellerAta,               isSigner:false, isWritable:true  }, // 2 seller_nft_account
          { pubkey: vaultPda,                isSigner:false, isWritable:true  }, // 3 vault_nft_account
          { pubkey: salePda,                 isSigner:false, isWritable:true  }, // 4 sale
          { pubkey: PLATFORM_WALLET!,        isSigner:false, isWritable:true  }, // 5 platform_wallet
          { pubkey: TOKEN_PROGRAM_ID,        isSigner:false, isWritable:false }, // 6 token_program
          { pubkey: SystemProgram.programId, isSigner:false, isWritable:false }, // 7 system_program
        ],
        data: disc,
      };
      const tx = new Transaction().add(ix as any);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      setTxStatus('Awaiting wallet approval…');
      const sig = await sendTx(tx, connection, sendTransaction, signTransaction, false);
      setTxStatus(`Confirming… tx: ${sig.slice(0,20)}…`);
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
      setTxStatus(`✅ Delisted! <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#00d4ff;text-decoration:underline">View Tx ↗</a>`);
      saveTrade({ sig, type:'delist', nftMint: listing.nftMint, price: listing.price, seller: publicKey.toBase58(), timestamp: Math.floor(Date.now()/1000) });
      setTimeout(() => { setConfirmTarget(null); setTxStatus(''); loadListings(); }, 2000);
    } catch (e: any) {
      setTxStatus(`❌ ${e?.message?.slice(0,120) ?? 'Transaction failed'}`);
    } finally { setTxPending(false); }
  };

  // ── Derived ───────────────────────────────────────────────────
  const filtered    = useMemo(() => searchDebounced
    ? nfts.filter(n => n.name.toLowerCase().includes(searchDebounced.toLowerCase()) || n.symbol.toLowerCase().includes(searchDebounced.toLowerCase()) || (n.collection ?? '').toLowerCase().includes(searchDebounced.toLowerCase()))
    : nfts, [nfts, searchDebounced]);
  const groups      = useMemo(() => groupByCollection(filtered), [filtered]);
  const myListings  = useMemo(() => listings.filter(l => l.seller === publicKey?.toBase58()), [listings, publicKey]);

  // ─────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:'100vh', background:'#080c0f',
      padding: isMobile ? '70px 10px 40px' : '90px 24px 60px', position:'relative', overflow:'hidden' }}>
      <TopBar />
      <PageBackground />
      <div style={{ position:'fixed', top:'20%', left:'10%', width:600, height:600, borderRadius:'50%',
        background:'radial-gradient(circle,rgba(0,212,255,0.04) 0%,transparent 60%)', pointerEvents:'none', zIndex:0 }} />
      <div style={{ position:'fixed', top:'60%', right:'5%', width:500, height:500, borderRadius:'50%',
        background:'radial-gradient(circle,rgba(191,90,242,0.05) 0%,transparent 60%)', pointerEvents:'none', zIndex:0 }} />

      <style>{`
        @keyframes fadeUp     { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin       { to{transform:rotate(360deg)} }
        @keyframes labGlow    { 0%,100%{opacity:.4} 50%{opacity:1} }
        @keyframes pulse-cyan { 0%,100%{box-shadow:0 0 6px #00d4ff} 50%{box-shadow:0 0 18px #00d4ff} }
        @keyframes marketplace-pulse {
          0%,100% { box-shadow:0 0 6px rgba(0,255,128,.12); border-color:rgba(0,255,128,.2); }
          50%      { box-shadow:0 0 16px rgba(0,255,128,.35), 0 0 32px rgba(0,255,128,.1); border-color:rgba(0,255,128,.5); }
        }
        @keyframes hdr-shimmer {
          0%   { background-position: -200% center; }
          100% { background-position:  200% center; }
        }
        @keyframes hdr-scan {
          0%   { transform:translateY(-100%) scaleX(.6); opacity:0; }
          10%  { opacity:1; }
          90%  { opacity:1; }
          100% { transform:translateY(600%) scaleX(1); opacity:0; }
        }
        @keyframes hdr-orb {
          0%,100% { transform:scale(1)   opacity:.5; }
          50%     { transform:scale(1.15) opacity:.8; }
        }
        @keyframes hdr-float {
          0%,100% { transform:translateY(0px); }
          50%     { transform:translateY(-6px); }
        }
        @keyframes hdr-counter {
          from { opacity:0; transform:translateY(8px) scale(.85); }
          to   { opacity:1; transform:translateY(0)   scale(1); }
        }
        @keyframes hdr-badge-pulse {
          0%,100% { opacity:.7; }
          50%     { opacity:1; box-shadow:0 0 14px currentColor; }
        }
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
        input[type=number]  { -moz-appearance:textfield; }
        input::placeholder  { color:#4a6a8a; }
      `}</style>

      <div style={{ position:'relative', zIndex:1, maxWidth:1100, margin:'0 auto' }}>

        {/* ── PAGE HEADER ───────────────────────────────────────── */}
        <div style={{ textAlign:'center', marginBottom: isMobile ? 28 : 48, position:'relative' }}>

          {/* Background glow orbs */}
          <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
            width: isMobile ? 320 : 600, height: isMobile ? 180 : 280, borderRadius:'50%',
            background:'radial-gradient(ellipse,rgba(0,212,255,.07) 0%,rgba(191,90,242,.04) 40%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 4s ease-in-out infinite' }} />
          <div style={{ position:'absolute', top:'30%', left:'20%',
            width: isMobile ? 80 : 160, height: isMobile ? 80 : 160, borderRadius:'50%',
            background:'radial-gradient(circle,rgba(0,212,255,.06) 0%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 3.2s ease-in-out infinite 0.5s' }} />
          <div style={{ position:'absolute', top:'30%', right:'20%',
            width: isMobile ? 80 : 160, height: isMobile ? 80 : 160, borderRadius:'50%',
            background:'radial-gradient(circle,rgba(191,90,242,.06) 0%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 3.8s ease-in-out infinite 1s' }} />

          {/* Main title */}
          <div style={{ position:'relative', display:'inline-block', animation:'fadeUp 0.5s ease 0.05s both' }}>
            {/* Subtle glow line below title */}
            <div style={{ position:'absolute', bottom:-6, left:'15%', right:'15%', height:1,
              background:'linear-gradient(90deg,transparent,rgba(0,212,255,.2),rgba(191,90,242,.15),transparent)',
              pointerEvents:'none', animation:'hdr-shimmer 5s ease-in-out infinite' }} />
            <h1 style={{ fontFamily:'Orbitron,monospace',
              fontSize: isMobile ? 26 : 48, fontWeight:900,
              letterSpacing: isMobile ? 2 : 4, margin:'0 0 4px', lineHeight:1.05,
              textTransform:'uppercase', position:'relative' }}>
              <span style={{
                background:'linear-gradient(90deg,#00d4ff,#bf5af2,#00c98d,#00d4ff)',
                backgroundSize:'200% auto',
                WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text',
                animation:'hdr-shimmer 3s linear infinite', display:'inline',
              }}>X1 LAB WORK</span>
              <span style={{ WebkitTextFillColor:'initial', backgroundClip:'initial', background:'none',
                marginLeft: isMobile ? 8 : 12, fontSize: isMobile ? 22 : 40,
                display:'inline-block', animation:'hdr-float 2.5s ease-in-out infinite',
                verticalAlign:'middle' }}>🧪</span>
              <span style={{
                background:'linear-gradient(90deg,#00c98d,#00d4ff,#bf5af2,#00c98d)',
                backgroundSize:'200% auto',
                WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text',
                animation:'hdr-shimmer 3s linear infinite 0.5s',
                display:'inline', marginLeft: isMobile ? 8 : 12,
              }}>NFTs</span>
            </h1>
          </div>

          {/* Eyebrow — sits below title, muted */}
          <div style={{ marginTop: isMobile ? 8 : 10, marginBottom: isMobile ? 4 : 6,
            animation:'fadeUp 0.5s ease 0.12s both' }}>
            <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 8,
              color:'#9abace', letterSpacing: isMobile ? 2 : 3 }}>
              X1 BLOCKCHAIN · NFT SCANNER & MARKETPLACE
            </span>
          </div>

          {/* Subtitle */}
          <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 13, color:'#8aaac0',
            marginBottom: isMobile ? 20 : 28, marginTop: isMobile ? 6 : 8,
            letterSpacing:.5, animation:'fadeUp 0.5s ease 0.15s both' }}>
            Scan &nbsp;·&nbsp; Inspect &nbsp;·&nbsp;
            <span style={{ color:'#00c98d' }}>List</span> &nbsp;·&nbsp;
            <span style={{ color:'#00d4ff' }}>Buy</span> &nbsp;·&nbsp;
            <span style={{ color:'#bf5af2' }}>Sell</span>
            {!isMobile && <span style={{ color:'#9abacf' }}> — powered by X1 blockchain & native XNT</span>}
          </div>

          {/* Stats — clean pill row with dividers, no cards */}
          {!loading && (
            <div style={{ display:'inline-flex', justifyContent:'center', alignItems:'center',
              animation:'fadeUp 0.5s ease 0.22s both',
              background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.07)',
              borderRadius:50, padding: isMobile ? '8px 16px' : '10px 24px',
              backdropFilter:'blur(8px)', flexWrap:'wrap', gap:0 }}>
              {[
                { label:'LISTED',      color:'#00c98d', value: listings.length },
                { label:'MY NFTs',     color:'#00d4ff', value: nfts.length     },
                { label:'COLLECTIONS', color:'#bf5af2', value: groups.size     },
                { label:'CHAIN',       color:'#ff8c00', value: 'X1'            },
              ].map(({ label, color, value }, i, arr) => (
                <React.Fragment key={label}>
                  <div style={{ textAlign:'center', padding: isMobile ? '2px 12px' : '2px 20px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 18 : 24,
                      fontWeight:900, color, lineHeight:1, marginBottom:2 }}>{value}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7,
                      color:'#9abacf', letterSpacing:1.5 }}>{label}</div>
                  </div>
                  {i < arr.length - 1 && (
                    <div style={{ width:1, height: isMobile ? 26 : 34,
                      background:'rgba(255,255,255,.08)', flexShrink:0 }} />
                  )}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        {/* ── MODE SWITCHER ─────────────────────────────────────── */}
        <div style={{ display:'flex', gap:6, marginBottom: isMobile ? 20 : 30, background:'rgba(255,255,255,.03)',
          borderRadius:14, padding:4, border:'1px solid rgba(255,255,255,.06)', animation:'fadeUp 0.4s ease 0.12s both' }}>
          {([
            { id:'market',  label:'🛒 MARKETPLACE', sub: listings.length > 0 ? `${listings.length} listed` : 'list & buy NFTs' },
            { id:'gallery', label:'🧪 MY NFTs',     sub: nfts.length > 0 ? `${nfts.length} found` : 'view your collection' },
          ] as { id:PageMode; label:string; sub:string }[]).map(m => (
            <button key={m.id} onClick={() => setPageMode(m.id)} style={{ flex:1, padding: isMobile ? '10px 6px' : '13px 10px',
              background: pageMode===m.id ? 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.08))' : 'transparent',
              border: pageMode===m.id ? '1px solid rgba(0,212,255,.35)' : '1px solid transparent',
              borderRadius:11, cursor:'pointer', transition:'all 0.18s', textAlign:'center' }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900,
                color: pageMode===m.id ? '#00d4ff' : '#4a6a8a', marginBottom:2 }}>{m.label}</div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:7,
                color: pageMode===m.id ? 'rgba(0,212,255,.55)' : '#3a5a7a', letterSpacing:1 }}>{m.sub}</div>
            </button>
          ))}
        </div>

        {/* ════════════════════════════════════════════════════════
            GALLERY MODE
        ════════════════════════════════════════════════════════ */}
        {pageMode === 'gallery' && (
          <>
            {!publicKey && (
              <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '100px 40px', animation:'fadeUp 0.5s ease 0.1s both' }}>
                <div style={{ fontSize:64, marginBottom:24 }}>🧪</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 20, fontWeight:900, color:'#9abacf', marginBottom:12, letterSpacing:2 }}>WALLET NOT CONNECTED</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#9abace', maxWidth:340, margin:'0 auto' }}>Connect your wallet to scan for NFTs on X1</div>
              </div>
            )}
            {loading && (
              <div style={{ textAlign:'center', padding:'80px 20px', animation:'fadeUp 0.4s ease both' }}>
                <div style={{ fontSize:48, marginBottom:20, animation:'spin 2s linear infinite', display:'inline-block' }}>🧪</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, color:'#00d4ff', letterSpacing:2, marginBottom:8 }}>SCANNING NFTs…</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abacf' }}>{loadLabel}</div>
              </div>
            )}
            {error && (
              <div style={{ textAlign:'center', padding:'40px 20px', background:'rgba(255,50,50,.06)', border:'1px solid rgba(255,50,50,.2)', borderRadius:14, marginBottom:24 }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#ff4444', marginBottom:6 }}>SCAN ERROR</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#aa5555' }}>{error}</div>
              </div>
            )}
            {!loading && publicKey && nfts.length === 0 && !error && (
              <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '100px 40px', animation:'fadeUp 0.5s ease both' }}>
                <div style={{ fontSize:56, marginBottom:20 }}>🔬</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 18, fontWeight:900, color:'#9abacf', marginBottom:10, letterSpacing:2 }}>NO NFTs DETECTED</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#9abace', maxWidth:360, margin:'0 auto' }}>No NFTs found. NFTs are tokens with 0 decimals and balance of 1.</div>
              </div>
            )}
            {!loading && nfts.length > 0 && (
              <>
                {/* ── Search bar ── */}
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20, animation:'fadeUp 0.4s ease 0.15s both' }}>
                  <div style={{ flex:1, position:'relative' }}>
                    <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', pointerEvents:'none' }}>🔍</span>
                    <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search by name, symbol or collection…"
                      style={{ width:'100%', boxSizing:'border-box', padding: isMobile ? '9px 12px 9px 34px' : '10px 14px 10px 36px', background:'rgba(255,255,255,.04)',
                        border:'1px solid rgba(0,212,255,.2)', borderRadius:10, outline:'none',
                        fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 12, color:'#c0d0e0', caretColor:'#00d4ff' }} />
                  </div>
                  {enriching && (
                    <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(0,212,255,.06)', border:'1px solid rgba(0,212,255,.2)', borderRadius:8, padding:'6px 12px', flexShrink:0 }}>
                      <div style={{ width:7, height:7, borderRadius:'50%', background:'#00d4ff', animation:'pulse-cyan 1.5s ease infinite' }} />
                      <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#00d4ff', letterSpacing:1 }}>{isMobile ? 'LOADING…' : 'LOADING METADATA…'}</span>
                    </div>
                  )}
                </div>

                {filtered.length === 0
                  ? <div style={{ textAlign:'center', padding:'40px 0', fontFamily:'Orbitron,monospace', fontSize:11, color:'#9abacf' }}>NO RESULTS FOR "{searchQ}"</div>
                  : Array.from(groups.entries()).map(([colName, colNfts], idx) => (
                    <CollectionSection key={colName} collectionName={colName} nfts={colNfts}
                      isMobile={isMobile} colIndex={idx} onSelect={handleSelect} />
                  ))
                }
              </>
            )}
          </>
        )}

        {/* ════════════════════════════════════════════════════════
            MARKETPLACE MODE
        ════════════════════════════════════════════════════════ */}
        {pageMode === 'market' && (
          <>
            {/* Not deployed banner */}
            {!MARKETPLACE_DEPLOYED && (
              <div style={{ padding:'16px 20px', marginBottom:20, background:'rgba(255,153,0,.08)', border:'1px solid rgba(255,153,0,.3)', borderRadius:12, fontFamily:'Sora,sans-serif', fontSize:12, color:'#ffaa44', display:'flex', alignItems:'center', gap:10 }}>
                <span style={{ fontSize:20 }}>🚧</span>
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, marginBottom:2 }}>MARKETPLACE NOT DEPLOYED</div>
                  <div style={{ fontSize:10, color:'#aa7733' }}>Set MARKETPLACE_PROGRAM_ID_STRING in constants/index.ts to enable trading.</div>
                </div>
              </div>
            )}

            {/* ── Market tabs ── */}
            <div style={{ display:'flex', gap:4, marginBottom: isMobile ? 18 : 24, background:'rgba(255,255,255,.03)',
              borderRadius:12, padding:4, border:'1px solid rgba(255,255,255,.06)', animation:'fadeUp 0.3s ease 0.05s both' }}>
              {([
                { id:'overview',   label: isMobile ? '📊' : '📊 OVERVIEW',              badge: null             },
                { id:'browse',     label: isMobile ? '🟢' : '🟢 MARKETPLACE LISTINGS',  badge: listings.length  },
                { id:'mylistings', label: isMobile ? '📋' : '📋 MINE',                  badge: myListings.length },
                { id:'sell',       label: isMobile ? '🏷️' : '🏷️ SELL',                 badge: null             },
                { id:'activity',   label: isMobile ? '⚡' : '⚡ ACTIVITY',              badge: null             },
              ] as { id:MarketTab; label:string; badge:number|null }[]).map(t => {
                const isBrowse = t.id === 'browse';
                const isActive = marketTab === t.id;
                return (
                <button key={t.id} type="button" onClick={() => {
                  setMarketTab(t.id);
                  if (t.id === 'sell' && prelistNft) setShowListModal(true);
                }} style={{ flex: isBrowse ? 1.6 : 1,
                  padding: isMobile ? '9px 4px' : '10px 8px',
                  background: isActive && isBrowse
                    ? 'linear-gradient(135deg,rgba(0,255,128,.18),rgba(0,200,100,.08))'
                    : isActive
                    ? 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.08))'
                    : isBrowse
                    ? 'linear-gradient(135deg,rgba(0,255,128,.06),rgba(0,200,100,.02))'
                    : 'transparent',
                  border: isActive && isBrowse
                    ? '1px solid rgba(0,255,128,.7)'
                    : isActive
                    ? '1px solid rgba(0,212,255,.35)'
                    : isBrowse
                    ? '1px solid rgba(0,255,128,.25)'
                    : '1px solid transparent',
                  borderRadius:9, cursor:'pointer', transition:'all 0.15s',
                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? (isBrowse ? 8 : 9) : (isBrowse ? 9 : 9), fontWeight:700,
                  color: isActive && isBrowse ? '#00ff80' : isActive ? '#00d4ff' : isBrowse ? '#00cc66' : '#4a6a8a',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:4,
                  boxShadow: isBrowse ? (isActive ? '0 0 18px rgba(0,255,128,.25), inset 0 0 12px rgba(0,255,128,.06)' : '0 0 8px rgba(0,255,128,.1)') : 'none',
                  animation: isBrowse && !isActive ? 'marketplace-pulse 2s ease-in-out infinite' : 'none',
                }}>
                  {t.label}
                  {t.badge !== null && t.badge > 0 && (
                    <span style={{
                      background: isBrowse ? 'rgba(0,255,128,.25)' : 'rgba(0,212,255,.2)',
                      border: isBrowse ? '1px solid rgba(0,255,128,.4)' : '1px solid rgba(0,212,255,.3)',
                      borderRadius:10, padding:'0 5px', fontSize:7,
                      color: isBrowse ? '#00ff80' : '#00d4ff'
                    }}>{t.badge}</span>
                  )}
                </button>
                );
              })}
            </div>

            {/* ══════════════════════════════════════
                OVERVIEW TAB
            ══════════════════════════════════════ */}
            {marketTab === 'overview' && (() => {
              const sales        = tradeLogs.filter(l => l.type === 'buy' && l.price);
              const totalVolXnt  = sales.reduce((s, l) => s + (l.price ?? 0), 0) / 1e9;
              const biggestSale  = sales.reduce((best, l) => (!best || (l.price ?? 0) > (best.price ?? 0)) ? l : best, null as TradeLog | null);
              const floorListing = listings.length > 0 ? listings.reduce((a, b) => a.price < b.price ? a : b) : null;

              // Build collection map — used for Top Collections AND Browse preview
              const colMap = new Map<string, { count: number; floor: number; items: Listing[]; volume: number }>();
              listings.forEach(l => {
                const col = l.nftData?.collection || l.nftData?.symbol || 'Unknown';
                if (!colMap.has(col)) colMap.set(col, { count:0, floor:Infinity, items:[], volume:0 });
                const e = colMap.get(col)!;
                e.count++; e.floor = Math.min(e.floor, l.price); e.items.push(l);
              });
              // Add volume from sales
              sales.forEach(s => {
                const nftCol = s.nftData?.collection || s.nftData?.symbol;
                if (nftCol && colMap.has(nftCol)) colMap.get(nftCol)!.volume += s.price ?? 0;
              });
              const topCollections = Array.from(colMap.entries())
                .sort((a,b) => b[1].count - a[1].count).slice(0, 6);

              return (
                <div style={{ animation:'fadeUp 0.3s ease both' }}>

                  {/* ── Hero stats ── */}
                  <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: isMobile ? 8 : 12, marginBottom: isMobile ? 20 : 28 }}>
                    {[
                      { label:'TOTAL LISTINGS', value: listings.length.toString(),      icon:'🏷️', color:'#00d4ff', sub:'active on-chain' },
                      { label:'TOTAL VOLUME',   value: `${totalVolXnt.toFixed(2)} XNT`, icon:'💎', color:'#00c98d', sub:'all time' },
                      { label:'FLOOR PRICE',    value: floorListing ? `${lamportsToXnt(floorListing.price)} XNT` : '—', icon:'📉', color:'#bf5af2', sub:'lowest listing' },
                      { label:'TOTAL SALES',    value: sales.length.toString(),         icon:'⚡', color:'#ffaa00', sub:'completed buys' },
                    ].map(({ label, value, icon, color, sub }) => (
                      <div key={label} style={{ background:'linear-gradient(135deg,rgba(255,255,255,.04),rgba(255,255,255,.02))',
                        border:`1px solid ${color}22`, borderRadius:14, padding: isMobile ? '14px 12px' : '18px 20px',
                        position:'relative', overflow:'hidden' }}>
                        <div style={{ position:'absolute', top:0, left:0, right:0, height:2, background:`linear-gradient(90deg,transparent,${color}88,transparent)` }} />
                        <div style={{ fontSize: isMobile ? 20 : 24, marginBottom:8 }}>{icon}</div>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 20, fontWeight:900, color, marginBottom:4 }}>{value}</div>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7, color:'#9abacf', letterSpacing:1.5, marginBottom:2 }}>{label}</div>
                        <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 8 : 9, color:'#9abacf' }}>{sub}</div>
                      </div>
                    ))}
                  </div>

                  {/* ── Main content: top collections (left) + biggest sale / CTAs (right) ── */}
                  <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 320px', gap: isMobile ? 16 : 20, marginBottom: isMobile ? 20 : 28 }}>

                    {/* TOP COLLECTIONS — bigger, more info per row */}
                    <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(0,212,255,.12)', borderRadius:16,
                      padding: isMobile ? '16px 14px' : '22px 24px', position:'relative', overflow:'hidden' }}>
                      <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
                        background:'linear-gradient(90deg,#00d4ff,#bf5af2,#00c98d)' }} />
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: isMobile ? 14 : 18 }}>
                        <div>
                          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:'#fff', letterSpacing:1.5 }}>TOP COLLECTIONS</div>
                          <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:3 }}>by active listings</div>
                        </div>
                        <button type="button" onClick={() => setMarketTab('browse')}
                          style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#00d4ff', background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.2)', borderRadius:7, padding:'6px 14px', cursor:'pointer', fontWeight:700 }}>
                          VIEW ALL ↗
                        </button>
                      </div>

                      {listings.length === 0 ? (
                        <div style={{ textAlign:'center', padding:'40px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abace' }}>
                          {loadingListings ? 'LOADING…' : 'NO LISTINGS YET'}
                        </div>
                      ) : (
                        <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 10 : 12 }}>
                          {/* Top 3 — full detail rows */}
                          {topCollections.slice(0, 3).map(([colName, data], idx) => {
                            const colors = ['#00d4ff','#bf5af2','#00c98d','#ffaa00','#ff6644','#4488ff'];
                            const col    = colors[idx % colors.length];
                            const sample = data.items[0];
                            const img    = sample?.nftData?.image || sample?.nftData?.metaUri;
                            return (
                              <div key={colName}
                                onClick={() => { setBrowseCollection(colName); setMarketTab('browse'); }}
                                style={{ display:'flex', alignItems:'center', gap: isMobile ? 10 : 14, padding: isMobile ? '10px 12px' : '13px 16px',
                                  background:'rgba(255,255,255,.025)', borderRadius:12, cursor:'pointer',
                                  border:`1px solid rgba(255,255,255,.05)`, transition:'all 0.15s' }}
                                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background=`rgba(255,255,255,.05)`; (e.currentTarget as HTMLDivElement).style.borderColor=`${col}33`; (e.currentTarget as HTMLDivElement).style.transform='translateX(3px)'; }}
                                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background='rgba(255,255,255,.025)'; (e.currentTarget as HTMLDivElement).style.borderColor='rgba(255,255,255,.05)'; (e.currentTarget as HTMLDivElement).style.transform=''; }}>
                                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 12 : 14, fontWeight:900, color:col, width:24, textAlign:'center', flexShrink:0 }}>#{idx+1}</div>
                                <div style={{ width: isMobile ? 44 : 52, height: isMobile ? 44 : 52, borderRadius:10, overflow:'hidden', flexShrink:0,
                                  background:'rgba(0,0,0,.3)', position:'relative', border:`1px solid ${col}22` }}>
                                  {img
                                    ? <img src={img} alt={colName} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                                    : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>🖼️</div>
                                  }
                                </div>
                                <div style={{ flex:1, minWidth:0 }}>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 11, fontWeight:700, color:'#e0f0ff',
                                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:4 }}>{colName}</div>
                                  <div style={{ display:'flex', gap: isMobile ? 8 : 12, flexWrap:'wrap' }}>
                                    <span style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf' }}>{data.count} listing{data.count!==1?'s':''}</span>
                                    {data.volume > 0 && <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#00c98d' }}>VOL {(data.volume/1e9).toFixed(2)} XNT</span>}
                                  </div>
                                </div>
                                <div style={{ textAlign:'right', flexShrink:0 }}>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:col }}>{lamportsToXnt(data.floor)}</div>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginTop:2 }}>XNT FLOOR</div>
                                </div>
                              </div>
                            );
                          })}

                          {/* Bottom 3 — compact 3-column mini cards */}
                          {topCollections.length > 3 && (
                            <>
                              <div style={{ height:1, background:'linear-gradient(90deg,rgba(255,255,255,.08),transparent)', margin:'2px 0' }} />
                              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap: isMobile ? 7 : 10 }}>
                                {topCollections.slice(3, 6).map(([colName, data], i) => {
                                  const idx = i + 3;
                                  const colors = ['#00d4ff','#bf5af2','#00c98d','#ffaa00','#ff6644','#4488ff'];
                                  const col    = colors[idx % colors.length];
                                  const img    = data.items[0]?.nftData?.image || data.items[0]?.nftData?.metaUri;
                                  return (
                                    <div key={colName}
                                      onClick={() => { setBrowseCollection(colName); setMarketTab('browse'); }}
                                      style={{ background:'rgba(255,255,255,.02)', border:`1px solid rgba(255,255,255,.05)`,
                                        borderRadius:10, padding: isMobile ? '8px 9px' : '10px 12px', cursor:'pointer', transition:'all 0.15s' }}
                                      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background=`rgba(255,255,255,.05)`; (e.currentTarget as HTMLDivElement).style.borderColor=`${col}44`; }}
                                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background='rgba(255,255,255,.02)'; (e.currentTarget as HTMLDivElement).style.borderColor='rgba(255,255,255,.05)'; }}>
                                      <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:6 }}>
                                        <div style={{ width:28, height:28, borderRadius:6, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative', border:`1px solid ${col}22` }}>
                                          {img
                                            ? <img src={img} alt={colName} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                                            : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12 }}>🖼️</div>
                                          }
                                        </div>
                                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:900, color:col }}>#{idx+1}</div>
                                      </div>
                                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700, color:'#c0d0e0',
                                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:4 }}>{colName}</div>
                                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900, color:col, marginBottom:2 }}>{lamportsToXnt(data.floor)}</div>
                                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf' }}>{data.count} listed · FLOOR XNT</div>
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Right column: Biggest Sale + Quick CTAs */}
                    <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 12 : 14 }}>

                      {/* Biggest Sale */}
                      <div style={{ background:'linear-gradient(135deg,rgba(255,170,0,.08),rgba(191,90,242,.05))', border:'1px solid rgba(255,170,0,.2)', borderRadius:16, padding: isMobile ? '16px 14px' : '20px 20px', flex:1 }}>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900, color:'#ffaa00', letterSpacing:1.5, marginBottom:12 }}>🏆 BIGGEST SALE</div>
                        {biggestSale ? (
                          <>
                            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
                              <div style={{ width:56, height:56, borderRadius:12, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative', border:'2px solid rgba(255,170,0,.25)' }}>
                                {biggestSale.nftData?.image
                                  ? <img src={biggestSale.nftData.image} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                                  : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22 }}>🖼️</div>
                                }
                              </div>
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#fff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{biggestSale.nftData?.name ?? biggestSale.nftMint.slice(0,10)+'…'}</div>
                                <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:3 }}>{new Date(biggestSale.timestamp*1000).toLocaleDateString()}</div>
                                {biggestSale.buyer && <div style={{ fontFamily:'monospace', fontSize:8, color:'#9abacf', marginTop:2 }}>BUYER: {biggestSale.buyer.slice(0,8)}…</div>}
                              </div>
                            </div>
                            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 22 : 28, fontWeight:900, color:'#ffaa00' }}>
                              {lamportsToXnt(biggestSale.price!)}
                              <span style={{ fontSize:11, color:'#7a6a3a', fontWeight:400, marginLeft:6 }}>XNT</span>
                            </div>
                          </>
                        ) : (
                          <div style={{ textAlign:'center', padding:'24px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf' }}>
                            {loadingActivity ? 'LOADING…' : 'NO SALES YET'}
                          </div>
                        )}
                      </div>

                      {/* Quick CTAs */}
                      <div style={{ display:'flex', flexDirection: isMobile ? 'row' : 'column', gap:8 }}>
                        <button type="button" onClick={() => setMarketTab('browse')}
                          style={{ flex:1, padding: isMobile ? '12px 8px' : '14px 16px',
                            background:'linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.06))',
                            border:'1px solid rgba(0,212,255,.4)', borderRadius:12, cursor:'pointer',
                            fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#00d4ff',
                            display:'flex', alignItems:'center', justifyContent:'center', gap:6, transition:'all 0.18s' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background='linear-gradient(135deg,rgba(0,212,255,.28),rgba(0,212,255,.12))'; (e.currentTarget as HTMLButtonElement).style.transform='translateY(-2px)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background='linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.06))'; (e.currentTarget as HTMLButtonElement).style.transform=''; }}>
                          🛒 BROWSE LISTINGS
                        </button>
                        <button type="button" onClick={() => setMarketTab('sell')}
                          style={{ flex:1, padding: isMobile ? '12px 8px' : '14px 16px',
                            background:'linear-gradient(135deg,rgba(0,201,141,.15),rgba(0,201,141,.05))',
                            border:'1px solid rgba(0,201,141,.35)', borderRadius:12, cursor:'pointer',
                            fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#00c98d',
                            display:'flex', alignItems:'center', justifyContent:'center', gap:6, transition:'all 0.18s' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background='linear-gradient(135deg,rgba(0,201,141,.25),rgba(0,201,141,.1))'; (e.currentTarget as HTMLButtonElement).style.transform='translateY(-2px)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background='linear-gradient(135deg,rgba(0,201,141,.15),rgba(0,201,141,.05))'; (e.currentTarget as HTMLButtonElement).style.transform=''; }}>
                          🏷️ LIST AN NFT
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* ── Recent Activity ── */}
                  <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.06)', borderRadius:16, padding: isMobile ? '16px 14px' : '22px 24px' }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                      <div>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900, color:'#fff', letterSpacing:1 }}>⚡ RECENT ACTIVITY</div>
                        <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:2 }}>latest trades on-chain</div>
                      </div>
                      <button type="button" onClick={() => setMarketTab('activity')} style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#bf5af2', background:'rgba(191,90,242,.08)', border:'1px solid rgba(191,90,242,.2)', borderRadius:7, padding:'5px 12px', cursor:'pointer' }}>VIEW ALL ↗</button>
                    </div>
                    {loadingActivity ? (
                      <div style={{ textAlign:'center', padding:'20px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf' }}>LOADING…</div>
                    ) : tradeLogs.length === 0 ? (
                      <div style={{ textAlign:'center', padding:'20px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abace' }}>NO ACTIVITY YET</div>
                    ) : (
                      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                        {tradeLogs.slice(0, 5).map((log, i) => {
                          const tc = log.type==='buy'?'#00c98d':log.type==='list'?'#00d4ff':'#ff9944';
                          const tl = log.type==='buy'?'⚡ SOLD':log.type==='list'?'🏷️ LISTED':'↩ DELISTED';
                          return (
                            <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px',
                              background:'rgba(255,255,255,.02)', borderRadius:8, border:'1px solid rgba(255,255,255,.04)' }}>
                              <div style={{ width:34, height:34, borderRadius:7, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative' }}>
                                {log.nftData?.image
                                  ? <img src={log.nftData.image} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                                  : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14 }}>🖼️</div>
                                }
                              </div>
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:tc,
                                background:`${tc}18`, border:`1px solid ${tc}44`, padding:'2px 7px', borderRadius:4, flexShrink:0 }}>{tl}</span>
                              <span style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 9 : 10, color:'#c0d0e0', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                {log.nftData?.name ?? log.nftMint.slice(0,12)+'…'}
                              </span>
                              {log.price && <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#00d4ff', flexShrink:0 }}>{lamportsToXnt(log.price)} XNT</span>}
                              <a href={`https://explorer.mainnet.x1.xyz/tx/${log.sig}`} target="_blank" rel="noopener"
                                style={{ color:'#9abacf', fontSize:9, textDecoration:'none', flexShrink:0, padding:'3px 7px',
                                  border:'1px solid rgba(255,255,255,.06)', borderRadius:5, fontFamily:'monospace' }}>TX↗</a>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                </div>
              );

            })()}

            {/* ══════════════════════════════════════
                BROWSE TAB — collection picker + filtered grid
            ══════════════════════════════════════ */}
            {marketTab === 'browse' && (() => {
              // Build collection list for picker
              const colMap2 = new Map<string, { count: number; floor: number; items: Listing[] }>();
              listings.forEach(l => {
                const col = l.nftData?.collection || l.nftData?.symbol || 'Unknown';
                if (!colMap2.has(col)) colMap2.set(col, { count:0, floor:Infinity, items:[] });
                const e = colMap2.get(col)!;
                e.count++; e.floor = Math.min(e.floor, l.price); e.items.push(l);
              });
              const collections2 = Array.from(colMap2.entries()).sort((a,b) => b[1].count - a[1].count);
              const filteredListings = browseCollection
                ? listings.filter(l => (l.nftData?.collection || l.nftData?.symbol || 'Unknown') === browseCollection)
                : listings;
              const visible  = filteredListings.slice(0, listingsPage);
              const hasMore  = filteredListings.length > listingsPage;

              return (
                <div style={{ animation:'fadeUp 0.3s ease both' }}>

                  {loadingListings && (
                    <div style={{ textAlign:'center', padding:'60px 0' }}>
                      <div style={{ width:30, height:30, borderRadius:'50%', border:'3px solid rgba(0,212,255,.2)', borderTop:'3px solid #00d4ff', animation:'spin 0.8s linear infinite', margin:'0 auto 14px' }} />
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', letterSpacing:2 }}>LOADING LISTINGS…</div>
                    </div>
                  )}

                  {!loadingListings && listings.length === 0 && (
                    <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '90px 40px' }}>
                      <div style={{ fontSize:52, marginBottom:18 }}>🏪</div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 12 : 16, fontWeight:900, color:'#9abacf', marginBottom:10, letterSpacing:2 }}>NO LISTINGS YET</div>
                      <button type="button" onClick={() => setMarketTab('sell')} style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, letterSpacing:2, color:'#00d4ff', background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.3)', borderRadius:10, padding:'12px 28px', cursor:'pointer' }}>🏷️ LIST YOUR FIRST NFT</button>
                    </div>
                  )}

                  {!loadingListings && listings.length > 0 && (
                    <>
                      {/* ── Collection picker ── */}
                      <div style={{ marginBottom: isMobile ? 16 : 20 }}>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf', letterSpacing:2, marginBottom:10 }}>FILTER BY COLLECTION</div>
                        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                          {/* ALL button */}
                          <button type="button" onClick={() => { setBrowseCollection(null); setListingsPage(48); }}
                            style={{ padding: isMobile ? '7px 14px' : '8px 18px', borderRadius:20, cursor:'pointer', transition:'all .15s',
                              fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700, letterSpacing:0.5,
                              background: !browseCollection ? 'linear-gradient(135deg,rgba(0,212,255,.2),rgba(0,212,255,.08))' : 'rgba(255,255,255,.04)',
                              border: !browseCollection ? '1px solid rgba(0,212,255,.5)' : '1px solid rgba(255,255,255,.1)',
                              color: !browseCollection ? '#00d4ff' : '#4a6a8a',
                              boxShadow: !browseCollection ? '0 0 12px rgba(0,212,255,.15)' : 'none' }}>
                            ALL <span style={{ fontSize:8, opacity:.7 }}>({listings.length})</span>
                          </button>
                          {collections2.map(([colName, data], idx) => {
                            const colColors = ['#00d4ff','#bf5af2','#00c98d','#ffaa00','#ff6644','#4488ff'];
                            const col = colColors[idx % colColors.length];
                            const active = browseCollection === colName;
                            return (
                              <button key={colName} type="button"
                                onClick={() => { setBrowseCollection(colName); setListingsPage(48); }}
                                style={{ padding: isMobile ? '7px 14px' : '8px 18px', borderRadius:20, cursor:'pointer', transition:'all .15s',
                                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700, letterSpacing:0.5,
                                  background: active ? `rgba(${col==='#00d4ff'?'0,212,255':col==='#bf5af2'?'191,90,242':col==='#00c98d'?'0,201,141':col==='#ffaa00'?'255,170,0':col==='#ff6644'?'255,102,68':'68,136,255'},.18)` : 'rgba(255,255,255,.04)',
                                  border: active ? `1px solid ${col}88` : '1px solid rgba(255,255,255,.1)',
                                  color: active ? col : '#4a6a8a',
                                  boxShadow: active ? `0 0 12px ${col}22` : 'none' }}>
                                {colName} <span style={{ fontSize:8, opacity:.7 }}>({data.count})</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* ── Active filter header ── */}
                      {browseCollection && (
                        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16, padding:'10px 14px',
                          background:'rgba(0,212,255,.05)', border:'1px solid rgba(0,212,255,.15)', borderRadius:10 }}>
                          <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#00d4ff' }}>{browseCollection}</span>
                          <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf' }}>{filteredListings.length} listing{filteredListings.length!==1?'s':''}</span>
                          {colMap2.has(browseCollection) && <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#bf5af2' }}>Floor: {lamportsToXnt(colMap2.get(browseCollection)!.floor)} XNT</span>}
                          <button type="button" onClick={() => { setBrowseCollection(null); setListingsPage(48); }}
                            style={{ marginLeft:'auto', fontFamily:'Orbitron,monospace', fontSize:8, color:'#ff6666', background:'rgba(255,50,50,.08)', border:'1px solid rgba(255,50,50,.2)', borderRadius:6, padding:'3px 10px', cursor:'pointer' }}>
                            ✕ CLEAR
                          </button>
                        </div>
                      )}

                      {/* ── Listings grid ── */}
                      {filteredListings.length === 0 ? (
                        <div style={{ textAlign:'center', padding:'40px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf' }}>NO LISTINGS IN THIS COLLECTION</div>
                      ) : (
                        <>
                          <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: isMobile ? 10 : 14 }}>
                            {visible.map(l => <ListingCard key={l.listingPda} listing={l} isMobile={isMobile}
                              isOwner={l.seller === publicKey?.toBase58()}
                              onBuy={() => handleBuy(l)}
                              onDelist={() => handleDelist(l)}
                              onInspect={() => handleInspectListing(l)}
                              onUpdatePrice={() => handleUpdatePrice(l)} />)}
                          </div>
                          {hasMore && (
                            <div style={{ textAlign:'center', marginTop:20 }}>
                              <button type="button" onClick={() => setListingsPage(p => p + 48)}
                                style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#00d4ff',
                                  background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.25)',
                                  borderRadius:10, padding:'10px 28px', cursor:'pointer', letterSpacing:1 }}>
                                LOAD MORE ({filteredListings.length - listingsPage} remaining)
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* MY LISTINGS */}
            {marketTab === 'mylistings' && (
              <div style={{ animation:'fadeUp 0.3s ease both' }}>
                {!publicKey && <div style={{ textAlign:'center', padding:'60px 20px' }}><div style={{ fontSize:48, marginBottom:16 }}>🔒</div><div style={{ fontFamily:'Orbitron,monospace', fontSize:13, color:'#9abacf', letterSpacing:2 }}>CONNECT WALLET</div></div>}
                {publicKey && myListings.length === 0 && (
                  <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '80px 40px' }}>
                    <div style={{ fontSize:44, marginBottom:16 }}>📋</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 14, fontWeight:900, color:'#9abacf', marginBottom:10, letterSpacing:2 }}>NO ACTIVE LISTINGS</div>
                    <button type="button" onClick={() => setMarketTab('sell')} style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, letterSpacing:1.5, color:'#00d4ff', background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.3)', borderRadius:10, padding:'11px 24px', cursor:'pointer', marginTop:8 }}>🏷️ LIST AN NFT</button>
                  </div>
                )}
                {publicKey && myListings.length > 0 && (
                  <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: isMobile ? 10 : 14 }}>
                    {myListings.map(l => <ListingCard key={l.listingPda} listing={l} isMobile={isMobile} isOwner={true}
                      onBuy={() => {}}
                      onDelist={() => handleDelist(l)}
                      onInspect={() => handleInspectListing(l)}
                      onUpdatePrice={() => handleUpdatePrice(l)} />)}
                  </div>
                )}
              </div>
            )}

            {/* ══════════════════════════════════════
                SELL TAB — collection-grouped, clean layout
            ══════════════════════════════════════ */}
            {marketTab === 'sell' && (() => {
              if (!publicKey) return (
                <div style={{ textAlign:'center', padding:'64px 24px', animation:'fadeUp 0.3s ease both' }}>
                  <div style={{ fontSize:48, marginBottom:16 }}>🔌</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:13, color:'#8aaac8', letterSpacing:1.5, marginBottom:8 }}>CONNECT WALLET</div>
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abacf' }}>Connect your wallet to see your NFTs and list them for sale</div>
                </div>
              );
              if (loading) return (
                <div style={{ textAlign:'center', padding:'64px 24px', animation:'fadeUp 0.3s ease both' }}>
                  <div style={{ width:28, height:28, borderRadius:'50%', border:'3px solid rgba(0,212,255,.2)', borderTop:'3px solid #00d4ff', animation:'spin 0.8s linear infinite', margin:'0 auto 14px' }} />
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', letterSpacing:2 }}>SCANNING WALLET…</div>
                </div>
              );
              if (nfts.length === 0) return (
                <div style={{ textAlign:'center', padding:'64px 24px', animation:'fadeUp 0.3s ease both' }}>
                  <div style={{ fontSize:48, marginBottom:16 }}>🪹</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:12, color:'#8aaac8', letterSpacing:1 }}>NO NFTs FOUND IN WALLET</div>
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf', marginTop:8 }}>NFTs are tokens with 0 decimals and a balance of 1</div>
                </div>
              );

              // Group wallet NFTs by collection for organised sell layout
              const sellColMap = new Map<string, NFTData[]>();
              nfts.forEach(n => {
                const col = n.collection || n.symbol || n.mint.slice(0,4).toUpperCase();
                if (!sellColMap.has(col)) sellColMap.set(col, []);
                sellColMap.get(col)!.push(n);
              });
              const sellCols = Array.from(sellColMap.entries());

              return (
                <div style={{ animation:'fadeUp 0.3s ease both' }}>
                  {/* Header */}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: isMobile ? 16 : 22,
                    padding: isMobile ? '12px 14px' : '16px 20px',
                    background:'linear-gradient(135deg,rgba(0,201,141,.06),rgba(0,201,141,.02))',
                    border:'1px solid rgba(0,201,141,.2)', borderRadius:14 }}>
                    <div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:'#00c98d', letterSpacing:1 }}>🏷️ LIST AN NFT FOR SALE</div>
                      <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf', marginTop:3 }}>
                        {nfts.length} NFT{nfts.length!==1?'s':''} in wallet across {sellCols.length} collection{sellCols.length!==1?'s':''}
                      </div>
                    </div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 16 : 22, fontWeight:900, color:'#00c98d' }}>{nfts.length}</div>
                  </div>

                  {/* Collections with NFT grids */}
                  {sellCols.map(([colName, colNfts], colIdx) => {
                    const colColors = ['#00c98d','#00d4ff','#bf5af2','#ffaa00','#ff6644','#4488ff'];
                    const col = colColors[colIdx % colColors.length];
                    return (
                      <div key={colName} style={{ marginBottom: isMobile ? 24 : 32 }}>
                        {/* Collection header */}
                        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
                          <div style={{ width:3, height:28, borderRadius:2, background:col, flexShrink:0 }} />
                          <div style={{ flex:1 }}>
                            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900, color:'#fff', letterSpacing:1 }}>{colName}</div>
                            <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:2 }}>{colNfts.length} NFT{colNfts.length!==1?'s':''} · click to list</div>
                          </div>
                          <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:col, background:`${col}18`, border:`1px solid ${col}33`, borderRadius:20, padding:'3px 10px' }}>{colNfts.length}</div>
                        </div>
                        <div style={{ height:1, background:`linear-gradient(90deg,${col}66,${col}22,transparent)`, marginBottom:14 }} />

                        {/* NFT grid */}
                        <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(5,1fr)', gap: isMobile ? 8 : 12 }}>
                          {colNfts.map(nft => {
                            const alreadyListed = myListings.some(l => l.nftMint === nft.mint);
                            return (
                              <button key={nft.mint} type="button"
                                onClick={() => { if (!alreadyListed) { setPrelistNft(nft); setShowListModal(true); } }}
                                disabled={alreadyListed}
                                style={{ background: alreadyListed ? 'rgba(255,255,255,.02)' : 'rgba(255,255,255,.03)',
                                  border: alreadyListed ? '1px solid rgba(255,255,255,.06)' : `1px solid ${col}22`,
                                  borderRadius:12, padding:0, cursor: alreadyListed ? 'default' : 'pointer',
                                  overflow:'hidden', transition:'all 0.18s', textAlign:'left', opacity: alreadyListed ? 0.6 : 1 }}
                                onMouseEnter={e => { if (!alreadyListed) { (e.currentTarget as HTMLButtonElement).style.border=`1px solid ${col}66`; (e.currentTarget as HTMLButtonElement).style.transform='translateY(-3px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow=`0 8px 24px ${col}18`; } }}
                                onMouseLeave={e => { if (!alreadyListed) { (e.currentTarget as HTMLButtonElement).style.border=`1px solid ${col}22`; (e.currentTarget as HTMLButtonElement).style.transform=''; (e.currentTarget as HTMLButtonElement).style.boxShadow=''; } }}>
                                <div style={{ position:'relative', paddingBottom:'100%', background:'rgba(0,0,0,.3)' }}>
                                  {nft.image
                                    ? <img src={nft.image} alt={nft.name} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', imageRendering:'pixelated' }} />
                                    : <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>🖼️</div>}
                                  {alreadyListed
                                    ? <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,.6)' }}>
                                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#ffaa00', background:'rgba(255,170,0,.15)', border:'1px solid rgba(255,170,0,.4)', borderRadius:6, padding:'4px 8px' }}>LISTED</div>
                                      </div>
                                    : <div style={{ position:'absolute', top:5, right:5, background:`${col}dd`, borderRadius:5, padding:'2px 7px', fontFamily:'Orbitron,monospace', fontSize:6, color:'#000', fontWeight:900 }}>LIST</div>
                                  }
                                </div>
                                <div style={{ padding: isMobile ? '5px 6px 7px' : '7px 8px 9px' }}>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700, color: alreadyListed ? '#4a6a8a' : '#c0d0e0',
                                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}


                        {/* ACTIVITY */}
            {marketTab === 'activity' && (
              <div style={{ animation:'fadeUp 0.3s ease both' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#8aaac8', letterSpacing:1 }}>RECENT TRADES</span>
                  <button type="button" onClick={loadActivity} disabled={loadingActivity} style={{ background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.2)', borderRadius:8, padding:'5px 12px', fontSize:9, color:'#00d4ff', cursor:'pointer', fontFamily:'Orbitron,monospace' }}>
                    {loadingActivity ? '⟳ LOADING…' : '↺ REFRESH'}
                  </button>
                </div>
                {loadingActivity ? (
                  <div style={{ textAlign:'center', padding:40, color:'#8aaac8', fontSize:11 }}>Loading activity…</div>
                ) : tradeLogs.length === 0 ? (
                  <div style={{ textAlign:'center', padding:40, color:'#8aaac8', fontSize:11 }}>No activity found</div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {tradeLogs.map((log, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.06)', borderRadius:10, overflow:'hidden' }}>
                        <div style={{ width:44, height:44, borderRadius:8, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative' }}>
                          {log.nftData?.image
                            ? <img src={log.nftData.image} alt={log.nftData?.name ?? ''} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', imageRendering:'pixelated', display:'block' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                            : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>🖼️</div>
                          }
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                            <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700,
                              color: log.type==='buy' ? '#00c98d' : log.type==='list' ? '#00d4ff' : '#ff9944',
                              background: log.type==='buy' ? 'rgba(0,201,141,.1)' : log.type==='list' ? 'rgba(0,212,255,.1)' : 'rgba(255,153,68,.1)',
                              border: `1px solid ${log.type==='buy' ? 'rgba(0,201,141,.3)' : log.type==='list' ? 'rgba(0,212,255,.3)' : 'rgba(255,153,68,.3)'}`,
                              padding:'2px 7px', borderRadius:4 }}>
                              {log.type === 'buy' ? '⚡ SOLD' : log.type === 'list' ? '🏷️ LISTED' : '↩ DELISTED'}
                            </span>
                            <span style={{ fontSize:10, color:'#e0f0ff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {log.nftData?.name ?? log.nftMint.slice(0,12)+'…'}
                            </span>
                          </div>
                          <div style={{ fontSize:9, color:'#8aaac8' }}>
                            {log.price ? <span style={{ color:'#00d4ff', marginRight:8 }}>{lamportsToXnt(log.price)} XNT</span> : null}
                            <span>{new Date(log.timestamp * 1000).toLocaleString()}</span>
                          </div>
                        </div>
                        <a href={`https://explorer.mainnet.x1.xyz/tx/${log.sig}`} target="_blank" rel="noopener"
                          style={{ color:'#9abacf', fontSize:10, textDecoration:'none', flexShrink:0, padding:'4px 8px', border:'1px solid rgba(255,255,255,.06)', borderRadius:6, fontFamily:'monospace' }}
                          title={log.sig}>TX ↗</a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}


                {/* ── Platform fee notice — bottom of page ── */}
        <div style={{ display:'flex', alignItems:'center', gap:10, margin: isMobile ? '28px 0 8px' : '40px 0 8px', padding:'10px 14px',
          background:'rgba(191,90,242,.04)', border:'1px solid rgba(191,90,242,.12)', borderRadius:10, opacity:0.7 }}>
          <span style={{ fontSize:14 }}>💎</span>
          <div>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, color:'#8a5aaa', letterSpacing:0.5 }}>
              1.888% PLATFORM FEE ON ALL SALES · CANCEL FEE 0.888%
            </div>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#5a3a7a', marginTop:2 }}>
              HARDCODED ON-CHAIN → {PLATFORM_WALLET_STRING.slice(0,12)}…{PLATFORM_WALLET_STRING.slice(-6)} · IMMUTABLE PROGRAM
            </div>
          </div>
        </div>

        <Footer />
      </div>

      {/* Gallery detail modal */}
      {selected && <NFTDetailModal nft={selected} isMobile={isMobile} onClose={() => setSelected(null)} onListThis={handleListFromGallery} />}

      {/* Listing inspect modal — shows NFT metadata + buy/delist from marketplace */}
      {selectedListing && (() => {
        const l   = selectedListing;
        const nft = l.nftData ?? { mint: l.nftMint, name: l.nftMint.slice(0,8)+'…', symbol:'', balance:1, decimals:0, isToken2022:false };
        const isOwner = l.seller === publicKey?.toBase58();
        return createPortal(
          <div onClick={() => setSelectedListing(null)}
            style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,.88)',
              backdropFilter:'blur(14px)', display:'flex', alignItems:'center', justifyContent:'center',
              padding: isMobile ? 12 : 20, animation:'labFadeIn 0.18s ease both' }}>
            <div onClick={e => e.stopPropagation()} style={{ width:'100%', maxWidth: isMobile ? '96%' : 580,
              background:'linear-gradient(155deg,#0c1520,#080c0f)', border:'1px solid rgba(0,212,255,.4)',
              borderRadius:20, boxShadow:'0 0 60px rgba(0,212,255,.12), 0 32px 80px rgba(0,0,0,.9)',
              animation:'labSlideUp 0.22s cubic-bezier(.22,1,.36,1) both', position:'relative', overflow:'hidden' }}>
              {/* Top accent line */}
              <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1,
                background:'linear-gradient(90deg,transparent,rgba(0,212,255,.8),rgba(191,90,242,.6),transparent)' }} />
              {/* Close */}
              <button onClick={() => setSelectedListing(null)}
                style={{ position:'absolute', top:12, right:12, zIndex:10, width:32, height:32,
                  borderRadius:'50%', border:'1px solid rgba(0,212,255,.35)', background:'rgba(8,12,15,.9)',
                  cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, color:'#00d4ff' }}>×</button>

              <div style={{ display: isMobile ? 'flex' : 'flex', flexDirection: isMobile ? 'column' : 'row' }}>
                {/* Image */}
                <div style={{ position:'relative', width: isMobile ? '100%' : 240, flexShrink:0,
                  paddingBottom: isMobile ? '60%' : undefined, height: isMobile ? undefined : 340,
                  background:'linear-gradient(135deg,#050a0f,#0a0f18)',
                  borderRadius: isMobile ? '19px 19px 0 0' : '19px 0 0 19px', overflow:'hidden' }}>
                  <NFTImage metaUri={nft.image || nft.metaUri} name={nft.name} contain />
                  {/* Price badge */}
                  <div style={{ position:'absolute', bottom:12, left:12, background:'rgba(0,0,0,.85)',
                    backdropFilter:'blur(8px)', border:'1px solid rgba(0,212,255,.4)', borderRadius:8,
                    padding:'6px 12px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 18, fontWeight:900, color:'#00d4ff' }}>
                      {lamportsToXnt(l.price)} <span style={{ fontSize:9, color:'#9abacf' }}>XNT</span>
                    </div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginTop:2 }}>
                      SELLER GETS {lamportsToXnt(calcSellerCut(l.price))} XNT
                    </div>
                  </div>
                  {isOwner && <div style={{ position:'absolute', top:12, left:12, background:'rgba(255,140,0,.9)',
                    borderRadius:5, padding:'2px 8px', fontFamily:'Orbitron,monospace', fontSize:7, color:'#000', fontWeight:700 }}>YOURS</div>}
                </div>

                {/* Info panel */}
                <div style={{ flex:1, padding: isMobile ? '14px 16px 18px' : '20px 22px',
                  display:'flex', flexDirection:'column', gap:10, minWidth:0, overflowY:'auto', maxHeight: isMobile ? undefined : '85vh' }}>
                  {/* Name + symbol */}
                  <div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 16, fontWeight:900, color:'#fff',
                      marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                      {nft.collection && <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abace' }}>{nft.collection}</span>}
                      {nft.symbol && <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00d4ff',
                        background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)', padding:'2px 7px', borderRadius:3 }}>{nft.symbol}</span>}
                      <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                        background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.25)', padding:'2px 7px', borderRadius:3 }}>
                        {nft.isToken2022 ? 'TOKEN-2022' : 'SPL'}
                      </span>
                    </div>
                  </div>

                  {/* Description */}
                  {nft.description && (
                    <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 11, color:'#9abace', lineHeight:1.6 }}>
                      {nft.description.length > 140 ? nft.description.slice(0,140)+'…' : nft.description}
                    </div>
                  )}

                  {/* Attributes */}
                  {nft.attributes && nft.attributes.length > 0 && (
                    <div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf', letterSpacing:1.5, marginBottom:6 }}>
                        TRAITS — {nft.attributes.length}
                      </div>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                        {nft.attributes.map((a, i) => {
                          const isR = a.trait_type?.toLowerCase() === 'rarity';
                          const col = isR ? rarityColor(a.value) : '#bf5af2';
                          return (
                            <div key={i} style={{ background:'rgba(191,90,242,.05)', border:`1px solid ${isR ? col+'44' : 'rgba(191,90,242,.15)'}`,
                              borderRadius:5, padding:'3px 8px' }}>
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginRight:4 }}>{a.trait_type}:</span>
                              <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, fontWeight:600, color: isR ? col : '#b8cce0' }}>{a.value}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Seller */}
                  <div style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(0,0,0,.3)',
                    borderRadius:8, border:'1px solid rgba(255,255,255,.06)', padding:'7px 10px' }}>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', flexShrink:0 }}>SELLER</span>
                    <code style={{ flex:1, fontFamily:'monospace', fontSize:9, color:'#8aaac4',
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {l.seller.slice(0,14)}…{l.seller.slice(-10)}
                    </code>
                  </div>

                  {/* Mint */}
                  <div style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(0,0,0,.3)',
                    borderRadius:8, border:'1px solid rgba(255,255,255,.06)', padding:'7px 10px' }}>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', flexShrink:0 }}>MINT</span>
                    <code style={{ flex:1, fontFamily:'monospace', fontSize:9, color:'#8aaac4',
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {l.nftMint.slice(0,14)}…{l.nftMint.slice(-10)}
                    </code>
                  </div>

                  {/* Fee breakdown */}
                  <div style={{ background:'rgba(0,212,255,.04)', borderRadius:8, border:'1px solid rgba(0,212,255,.12)', overflow:'hidden' }}>
                    {[
                      { l:'YOU PAY',              v:`${lamportsToXnt(l.price)} XNT`,           c:'#00d4ff' },
                      { l:'SELLER RECEIVES (98.112%)', v:`${lamportsToXnt(calcSellerCut(l.price))} XNT`, c:'#00c98d' },
                      { l:'PLATFORM FEE (1.888%)',     v:`${lamportsToXnt(calcFee(l.price))} XNT`,       c:'#bf5af2' },
                    ].map(({l:label, v, c}, i, arr) => (
                      <div key={label} style={{ display:'flex', justifyContent:'space-between', padding:'7px 12px',
                        borderBottom: i < arr.length-1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                        <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf' }}>{label}</span>
                        <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:c }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  {/* Action buttons */}
                  <div style={{ display:'flex', gap:8, marginTop:'auto' }}>
                    <a href={`https://explorer.mainnet.x1.xyz/address/${l.nftMint}`} target="_blank" rel="noopener noreferrer"
                      style={{ flex:1, padding:'10px 0', textAlign:'center',
                        background:'linear-gradient(135deg,rgba(0,212,255,.12),rgba(0,212,255,.05))',
                        border:'1px solid rgba(0,212,255,.3)', borderRadius:9, fontFamily:'Orbitron,monospace',
                        fontSize:8, fontWeight:700, color:'#00d4ff', textDecoration:'none',
                        display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>🔍 EXPLORER ↗</a>
                    {isOwner
                      ? <>
                          <button type="button" onClick={() => { setSelectedListing(null); handleUpdatePrice(l); }}
                            style={{ flex:1, padding:'10px 0', background:'linear-gradient(135deg,rgba(0,212,255,.15),rgba(0,212,255,.06))',
                              border:'1px solid rgba(0,212,255,.35)', borderRadius:9, cursor:'pointer',
                              fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#00d4ff',
                              display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>✏️ EDIT PRICE</button>
                          <button type="button" onClick={() => { setSelectedListing(null); handleDelist(l); }}
                            style={{ flex:1, padding:'10px 0', background:'linear-gradient(135deg,rgba(255,50,50,.18),rgba(255,50,50,.08))',
                              border:'1px solid rgba(255,50,50,.4)', borderRadius:9, cursor:'pointer',
                              fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#ff6666',
                              display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>✕ DELIST</button>
                        </>
                      : <button type="button" onClick={() => { setSelectedListing(null); handleBuy(l); }}
                          style={{ flex:2, padding:'10px 0',
                            background:'linear-gradient(135deg,rgba(0,212,255,.22),rgba(0,212,255,.1))',
                            border:'1px solid rgba(0,212,255,.5)', borderRadius:9, cursor:'pointer',
                            fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#00d4ff',
                            display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>⚡ BUY NOW</button>
                    }
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* List NFT modal popup */}
      {showListModal && prelistNft && publicKey && (
        <ListModal
          nft={prelistNft}
          connection={connection}
          publicKey={publicKey}
          sendTransaction={sendTransaction}
          signTransaction={signTransaction}
          onClose={() => { setShowListModal(false); setPrelistNft(null); }}
          onListed={() => { setShowListModal(false); setPrelistNft(null); loadListings(); }}
        />
      )}

      {/* Marketplace confirm modal */}
      {confirmTarget && <ConfirmModal listing={confirmTarget.listing} mode={confirmTarget.mode} isMobile={isMobile}
        onConfirm={confirmTarget.mode === 'buy' ? executeBuy : executeDelist}
        onCancel={() => { setConfirmTarget(null); setTxStatus(''); setTxPending(false); }}
        status={txStatus} pending={txPending} />}

      {updatePriceListing && publicKey && (
        <UpdatePriceModal
          listing={updatePriceListing}
          isMobile={isMobile}
          connection={connection}
          publicKey={publicKey}
          sendTransaction={sendTransaction}
          signTransaction={signTransaction}
          onClose={() => setUpdatePriceListing(null)}
          onUpdated={() => { setUpdatePriceListing(null); loadListings(); }}
        />
      )}
    </div>
  );
};

export default LabWork;