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

// ── Image cache (lw = labwork, separate from Portfolio's nftImageCache) ──
const LW_IMG_CACHE_KEY = 'x1b_lw_img_v1';
const lwImageCache = new Map<string, string | null>();
try {
  const stored = localStorage.getItem(LW_IMG_CACHE_KEY);
  if (stored) {
    const parsed = JSON.parse(stored) as Record<string, string | null>;
    Object.entries(parsed).forEach(([k, v]) => lwImageCache.set(k, v));
  }
} catch {}
let _lwPersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistLwCache() {
  if (_lwPersistTimer) clearTimeout(_lwPersistTimer);
  _lwPersistTimer = setTimeout(() => {
    try {
      const obj: Record<string, string | null> = {};
      lwImageCache.forEach((v, k) => { if (v !== null) obj[k] = v; });
      localStorage.setItem(LW_IMG_CACHE_KEY, JSON.stringify(obj));
    } catch {}
  }, 1000);
}

// ── Metadata cache ──
const lwMetaCache = new Map<string, any>();
async function fetchNFTMeta(metaUri: string): Promise<any | null> {
  if (lwMetaCache.has(metaUri)) return lwMetaCache.get(metaUri);
  const url = resolveGateway(metaUri);
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) return null;
  try {
    const res = await fetch(toProxyUrl(url), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.startsWith('image/')) return null;
    const json = await res.json();
    lwMetaCache.set(metaUri, json);
    return json;
  } catch { return null; }
}

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
              // If the image URL has no extension, still try it directly —
              // the browser/img tag will handle it (SVGs served from APIs, etc.)
              lwImageCache.set(metaUri, resolvedRaw); persistLwCache();
              if (!cancelled) setImgSrc(resolvedRaw); return;
            }
          } catch {}
        }
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
      <span style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a4a60',
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
type MarketTab = 'browse' | 'mylistings' | 'sell' | 'activity';

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
// Fetch Metaplex metadata for a single mint from chain, then enrich with image.
// Used for activity log entries which only have a mint address.
async function enrichNFTFromMint(connection: any, mintAddr: string): Promise<NFTData> {
  const base: NFTData = { mint: mintAddr, name: mintAddr.slice(0,8)+'…', symbol:'', balance:1, decimals:0, isToken2022:false };
  try {
    const mintPk = new PublicKey(mintAddr);
    const [pdaKey] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), mintPk.toBytes()],
      METADATA_PROGRAM_ID
    );
    const info = await connection.getAccountInfo(pdaKey, { encoding: 'base64' });
    if (!info?.data) return base;
    let raw: Uint8Array;
    const d = info.data;
    if (d instanceof Uint8Array) raw = d;
    else if (Array.isArray(d) && typeof d[0] === 'string') raw = Uint8Array.from(atob(d[0]), c => c.charCodeAt(0));
    else if (typeof d === 'string') raw = Uint8Array.from(atob(d), c => c.charCodeAt(0));
    else return base;
    if (raw.length < 69) return base;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let o = 65;
    const nL = view.getUint32(o, true); o += 4; if (!nL || nL > 200 || o + nL > raw.length) return base;
    const name = new TextDecoder().decode(raw.slice(o, o + nL)).replace(/\x00/g,'').trim(); o += nL;
    const sL = view.getUint32(o, true); o += 4; if (sL > 50 || o + sL > raw.length) return base;
    const symbol = new TextDecoder().decode(raw.slice(o, o + sL)).replace(/\x00/g,'').trim(); o += sL;
    const uL = view.getUint32(o, true); o += 4; if (uL > 2048 || o + uL > raw.length) return base;
    const uri = new TextDecoder().decode(raw.slice(o, o + uL)).replace(/\x00/g,'').trim();
    const withMeta: NFTData = { ...base, name: name || base.name, symbol, metaUri: uri };
    return await enrichNFT(withMeta);
  } catch { return base; }
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
  const BATCH  = 10;
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
    // SaleAccount::LEN = 8 (disc) + 32 + 32 + 8 + 1 + 1 + 8 = 90 bytes
    // Account discriminator = sha256("account:SaleAccount")[0..8]
    const disc     = await discriminatorAsync('SaleAccount', true);
    // memcmp bytes must be base58 encoded
    const discBytes = Array.from(disc);
    const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function toBase58(bytes: number[]): string {
      let num = BigInt('0x' + bytes.map(b => b.toString(16).padStart(2,'0')).join(''));
      let result = '';
      while (num > 0n) { const mod = num % 58n; result = BASE58_ALPHABET[Number(mod)] + result; num = num / 58n; }
      for (const b of bytes) { if (b === 0) result = '1' + result; else break; }
      return result;
    }
    const discB58 = toBase58(discBytes);
    const accounts = await connection.getProgramAccounts(getMarketplaceProgramId(), {
      filters: [
        { dataSize: 90 },
        { memcmp: { offset: 0, bytes: discB58 } },
      ],
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

async function enrichListing(connection: any, l: Listing): Promise<Listing> {
  try {
    const mintPk = new PublicKey(l.nftMint);
    const [pda]  = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), mintPk.toBytes()],
      METADATA_PROGRAM_ID
    );
    const info = await connection.getAccountInfo(pda, { encoding: 'base64' });
    if (!info?.data) return l;
    let raw: Uint8Array;
    const d = info.data;
    if (d instanceof Uint8Array) raw = d;
    else if (Array.isArray(d) && typeof d[0] === 'string') raw = Uint8Array.from(atob(d[0]), c => c.charCodeAt(0));
    else if (typeof d === 'string') raw = Uint8Array.from(atob(d), c => c.charCodeAt(0));
    else return l;
    if (raw.length < 69) return l;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let o = 65;
    const nL = view.getUint32(o, true); o += 4; if (!nL || nL > 200 || o + nL > raw.length) return l;
    const name = new TextDecoder().decode(raw.slice(o, o + nL)).replace(/\x00/g,'').trim(); o += nL;
    const sL = view.getUint32(o, true); o += 4; if (sL > 50 || o + sL > raw.length) return l;
    const symbol = new TextDecoder().decode(raw.slice(o, o + sL)).replace(/\x00/g,'').trim(); o += sL;
    const uL = view.getUint32(o, true); o += 4; if (uL > 2048 || o + uL > raw.length) return l;
    const uri = new TextDecoder().decode(raw.slice(o, o + uL)).replace(/\x00/g,'').trim();
    const base: NFTData = { mint: l.nftMint, name, symbol, balance: 1, decimals: 0, isToken2022: false, metaUri: uri };
    const enriched = await enrichNFT(base);
    return { ...l, nftData: enriched };
  } catch { return l; }
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
                  {nft.collection && <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#6a8aaa' }}>{nft.collection}</span>}
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00d4ff',
                    background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)', padding:'1px 6px', borderRadius:3 }}>{nft.symbol}</span>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                    background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.25)', padding:'1px 6px', borderRadius:3 }}>{nft.isToken2022 ? 'T-2022' : 'SPL'}</span>
                </div>
              </div>
              {nft.description && <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#6a8aaa', lineHeight:1.6 }}>{nft.description.length > 120 ? nft.description.slice(0,120)+'…' : nft.description}</div>}
              {nft.attributes && nft.attributes.length > 0 && (
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a', letterSpacing:1.5, marginBottom:5 }}>TRAITS — {nft.attributes.length}</div>
                  <div style={{ display:'flex', gap:5, overflowX:'auto', paddingBottom:3, scrollbarWidth:'none' }}>
                    {nft.attributes.map((a, i) => { const isR = a.trait_type?.toLowerCase() === 'rarity'; const col = isR ? rarityColor(a.value) : '#bf5af2';
                      return <div key={i} style={{ flexShrink:0, minWidth:64, textAlign:'center', background:'rgba(191,90,242,.05)',
                        border:`1px solid ${isR ? col+'44' : 'rgba(191,90,242,.15)'}`, borderRadius:6, padding:'4px 8px' }}>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a', marginBottom:2, whiteSpace:'nowrap' }}>{a.trait_type}</div>
                        <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, fontWeight:600, color: isR ? col : '#b8cce0', whiteSpace:'nowrap' }}>{a.value}</div>
                      </div>; })}
                  </div>
                </div>
              )}
              <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(0,0,0,.3)', borderRadius:7,
                border:'1px solid rgba(255,255,255,.06)', padding:'6px 10px' }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a', flexShrink:0 }}>MINT</span>
                <code style={{ flex:1, fontFamily:'monospace', fontSize:9, color:'#5a8aaa', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.mint.slice(0,10)}…{nft.mint.slice(-8)}</code>
                <button onClick={copyMint} style={{ flexShrink:0, padding:'3px 8px', borderRadius:4, cursor:'pointer', border:'none',
                  background: copied ? 'rgba(0,201,141,.2)' : 'rgba(191,90,242,.15)', color: copied ? '#00c98d' : '#bf5af2',
                  fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700 }}>{copied ? '✓' : 'COPY'}</button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:5 }}>
                {[{l:'CHAIN',v:'X1'},{l:'STD',v:nft.isToken2022?'T-2022':'SPL'},{l:'DEC',v:String(nft.decimals)},{l:'QTY',v:String(nft.balance)}].map(({l,v}) =>
                  <div key={l} style={{ background:'rgba(255,255,255,.02)', borderRadius:6, border:'1px solid rgba(255,255,255,.05)', padding:'4px 0', textAlign:'center' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a', marginBottom:2 }}>{l}</div>
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
                  {nft.collection && <span style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#6a8aaa' }}>{nft.collection}</span>}
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00d4ff',
                    background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)', padding:'2px 7px', borderRadius:3 }}>{nft.symbol}</span>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                    background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.25)', padding:'2px 7px', borderRadius:3 }}>{nft.isToken2022 ? 'TOKEN-2022' : 'SPL'}</span>
                </div>
              </div>
              {nft.description && <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#6a8aaa', lineHeight:1.65 }}>{nft.description.length > 160 ? nft.description.slice(0,160)+'…' : nft.description}</div>}
              {nft.attributes && nft.attributes.length > 0 && (
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#3a5a7a', letterSpacing:1.5, marginBottom:7 }}>TRAITS — {nft.attributes.length}</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                    {nft.attributes.map((a, i) => { const isR = a.trait_type?.toLowerCase() === 'rarity'; const col = isR ? rarityColor(a.value) : '#bf5af2';
                      return <div key={i} style={{ background:'rgba(191,90,242,.05)', border:`1px solid ${isR ? col+'44' : 'rgba(191,90,242,.15)'}`,
                        borderRadius:5, padding:'3px 8px', boxShadow: isR ? `0 0 10px ${col}18` : 'none' }}>
                        <span style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a', marginRight:4 }}>{a.trait_type}:</span>
                        <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, fontWeight:600, color: isR ? col : '#b8cce0' }}>{a.value}</span>
                      </div>; })}
                  </div>
                </div>
              )}
              <div style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(0,0,0,.3)', borderRadius:8,
                border:'1px solid rgba(255,255,255,.06)', padding:'7px 10px' }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a', flexShrink:0 }}>MINT</span>
                <code style={{ flex:1, fontFamily:'monospace', fontSize:10, color:'#5a8aaa', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.mint.slice(0,14)}…{nft.mint.slice(-10)}</code>
                <button onClick={copyMint} style={{ flexShrink:0, padding:'4px 10px', borderRadius:5, cursor:'pointer', border:'none',
                  background: copied ? 'rgba(0,201,141,.18)' : 'rgba(191,90,242,.12)', color: copied ? '#00c98d' : '#bf5af2',
                  fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700 }}>{copied ? '✓ COPIED' : 'COPY'}</button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:6 }}>
                {[{l:'BLOCKCHAIN',v:'X1 Mainnet'},{l:'STANDARD',v:nft.isToken2022?'Token-2022':'SPL Token'},{l:'DECIMALS',v:String(nft.decimals)},{l:'BALANCE',v:String(nft.balance)}].map(({l,v}) =>
                  <div key={l} style={{ background:'rgba(255,255,255,.02)', borderRadius:6, border:'1px solid rgba(255,255,255,.05)', padding:'5px 6px', textAlign:'center' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a', marginBottom:2 }}>{l}</div>
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
const NFTCard: FC<{ nft: NFTData; index: number; isMobile: boolean; onClick: () => void }> = ({ nft, index, isMobile, onClick }) => {
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
};

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
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#4a6a8a', letterSpacing:1 }}>
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
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a', transition:'transform 0.2s',
          transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▾</div>
      </div>

      {/* ── Per-collection trait filter panel ── */}
      {expanded && showFilterPanel && hasTraits && (
        <div style={{ marginBottom:14, padding:'12px 14px', background:'rgba(255,255,255,.025)',
          border:`1px solid ${col}22`, borderRadius:10, animation:'fadeUp 0.2s ease both' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
            <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#4a6a8a', letterSpacing:1.5 }}>FILTER BY TRAIT</span>
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
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#4a6a8a',
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
          fontSize:9, color:'#3a5a7a', letterSpacing:1 }}>NO MATCHES IN THIS COLLECTION</div>
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
                    fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#4a6a8a' }}
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
//  MARKETPLACE — LISTING CARD
// ─────────────────────────────────────────────────────────────────
const ListingCard: FC<{
  listing:  Listing;
  isMobile: boolean;
  isOwner:  boolean;
  onBuy:    () => void;
  onDelist: () => void;
}> = ({ listing, isMobile, isOwner, onBuy, onDelist }) => {
  const nft    = listing.nftData;
  const imgUri = nft?.image || nft?.metaUri || nft?.logoUri;
  const rarity = nft?.attributes?.find(a => a.trait_type?.toLowerCase() === 'rarity')?.value ?? '';
  const rcol   = rarity ? rarityColor(rarity) : '#bf5af2';
  return (
    <div style={{ background:'linear-gradient(145deg,rgba(0,212,255,.06),rgba(191,90,242,.04))',
      border:'1px solid rgba(0,212,255,.2)', borderRadius:14, overflow:'hidden',
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
            {lamportsToXnt(listing.price)}<span style={{ fontSize:7, color:'#3a5a7a', marginLeft:4 }}>XNT</span>
          </div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a' }}>SELLER GETS {lamportsToXnt(calcSellerCut(listing.price))} · 1.888% FEE</div>
        </div>
        {isOwner
          ? <button onClick={onDelist} style={{ width:'100%', padding:'8px 0', background:'rgba(255,50,50,.1)',
              border:'1px solid rgba(255,50,50,.3)', borderRadius:7, cursor:'pointer',
              fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#ff6666' }}>✕ DELIST</button>
          : <button onClick={onBuy} style={{ width:'100%', padding:'8px 0',
              background:'linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.08))',
              border:'1px solid rgba(0,212,255,.4)', borderRadius:7, cursor:'pointer',
              fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#00d4ff' }}>⚡ BUY NOW</button>
        }
      </div>
    </div>
  );
};

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
        <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#4a6a8a', marginBottom:18 }}>
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
            <div style={{ fontFamily:'monospace', fontSize:9, color:'#4a6a8a' }}>{listing.nftMint.slice(0,12)}…{listing.nftMint.slice(-8)}</div>
          </div>
        </div>
        {mode === 'buy' && (
          <div style={{ marginBottom:18, background:'rgba(0,212,255,.04)', borderRadius:10, border:'1px solid rgba(0,212,255,.18)', overflow:'hidden' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 14px', borderBottom:'1px solid rgba(0,212,255,.1)' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a8aaa' }}>YOU PAY</span>
              <div><span style={{ fontFamily:'Orbitron,monospace', fontSize:22, fontWeight:900, color:'#00d4ff' }}>{lamportsToXnt(listing.price)}</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#3a5a7a', marginLeft:5 }}>XNT</span></div>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 14px', borderBottom:'1px solid rgba(255,255,255,.04)' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#3a5a7a' }}>→ SELLER RECEIVES (98.112%)</span>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#00c98d' }}>{lamportsToXnt(calcSellerCut(listing.price))} XNT</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 14px' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#3a5a7a' }}>→ PLATFORM FEE (1.888%)</span>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#bf5af2' }}>{lamportsToXnt(calcFee(listing.price))} XNT</span>
            </div>
          </div>
        )}
        {mode === 'delist' && (
          <div style={{ marginBottom:18, background:'rgba(255,100,50,.04)', borderRadius:10, border:'1px solid rgba(255,100,50,.2)', overflow:'hidden' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'11px 14px', borderBottom:'1px solid rgba(255,100,50,.1)' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#aa6a4a' }}>CANCEL FEE (0.888%)</span>
              <div><span style={{ fontFamily:'Orbitron,monospace', fontSize:18, fontWeight:900, color:'#ff8c50' }}>{lamportsToXnt(calcCancelFee(listing.price))}</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#3a5a7a', marginLeft:5 }}>XNT</span></div>
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
            fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#7a9ab8', opacity: pending?0.5:1 }}>CANCEL</button>
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

      const disc      = await discriminatorAsync('list_nft');
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
      <div style={{ fontFamily:'Orbitron,monospace', fontSize:13, color:'#3a5a7a', letterSpacing:2 }}>CONNECT WALLET TO LIST</div>
    </div>
  );
  return (
    <div>
      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 11, color:'#4a6a8a', letterSpacing:2, marginBottom:18 }}>
        SELECT AN NFT FROM YOUR WALLET TO LIST
      </div>
      {loadingNfts && (
        <div style={{ textAlign:'center', padding:'40px 0' }}>
          <div style={{ width:26, height:26, borderRadius:'50%', border:'3px solid rgba(0,212,255,.2)', borderTop:'3px solid #00d4ff', animation:'spin 0.8s linear infinite', margin:'0 auto 12px' }} />
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#3a5a7a', letterSpacing:1 }}>SCANNING WALLET…</div>
        </div>
      )}
      {!loadingNfts && walletNfts.length === 0 && (
        <div style={{ textAlign:'center', padding:'40px 20px', background:'rgba(255,255,255,.02)', borderRadius:12, border:'1px solid rgba(255,255,255,.06)' }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🔬</div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#3a5a7a', letterSpacing:1 }}>NO NFTs FOUND IN WALLET</div>
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
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#3a5a7a', letterSpacing:1.5, marginBottom:12 }}>SET LISTING PRICE</div>
          <div style={{ position:'relative', marginBottom:14 }}>
            <input type="number" min="0" step="0.0001" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.0000"
              style={{ width:'100%', boxSizing:'border-box', padding:'12px 52px 12px 16px', background:'rgba(0,0,0,.4)',
                border:'1px solid rgba(0,212,255,.3)', borderRadius:10, outline:'none',
                color:'#00d4ff', fontFamily:'Orbitron,monospace', fontSize:16, fontWeight:700, caretColor:'#00d4ff' }} />
            <span style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)', fontFamily:'Orbitron,monospace', fontSize:9, color:'#3a5a7a', pointerEvents:'none' }}>XNT</span>
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
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#3a5a7a' }}>{l}</span>
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
      const disc       = await discriminatorAsync('list_nft');
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
          <button onClick={onClose} disabled={pending} style={{ background:'none', border:'none', color:'#4a6a8a', fontSize:18, cursor:'pointer', lineHeight:1 }}>✕</button>
        </div>

        {/* NFT Preview */}
        <div style={{ display:'flex', gap:14, marginBottom:20, padding:14, background:'rgba(0,212,255,.04)', border:'1px solid rgba(0,212,255,.1)', borderRadius:12 }}>
          {nft.image && <img src={nft.image} alt={nft.name} style={{ width:72, height:72, borderRadius:8, objectFit:'cover', flexShrink:0, imageRendering:'pixelated' }} />}
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color:'#e0f0ff', marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
            <div style={{ fontSize:10, color:'#4a6a8a', marginBottom:6 }}>{nft.symbol}</div>
            <div style={{ fontSize:9, color:'#3a5a7a', fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.mint.slice(0,16)}…</div>
            {nft.attributes?.slice(0,3).map((a,i) => (
              <span key={i} style={{ display:'inline-block', fontSize:8, background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.15)', borderRadius:4, padding:'1px 5px', marginRight:4, marginTop:4, color:'#4a9ab8' }}>
                {a.trait_type}: {a.value}
              </span>
            ))}
          </div>
        </div>

        {/* Price Input */}
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:10, color:'#4a6a8a', marginBottom:6, letterSpacing:1, fontFamily:'Orbitron,monospace' }}>SET LISTING PRICE</div>
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
            <div style={{ display:'flex', justifyContent:'space-between', color:'#4a6a8a', marginBottom:4 }}>
              <span>LISTING PRICE</span><span style={{ color:'#e0f0ff' }}>{price} XNT</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', color:'#4a6a8a', marginBottom:4 }}>
              <span>PLATFORM FEE (1.888%)</span><span style={{ color:'#ff9944' }}>{lamportsToXnt(fee)} XNT</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', color:'#4a6a8a', borderTop:'1px solid rgba(255,255,255,.06)', paddingTop:4, marginTop:4 }}>
              <span>YOU RECEIVE</span><span style={{ color:'#00c98d', fontWeight:700 }}>{lamportsToXnt(receive)} XNT</span>
            </div>
          </div>
        )}

        <StatusBox msg={status} />

        {/* Actions */}
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={onClose} disabled={pending} style={{ flex:1, padding:'12px 0', background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.1)', borderRadius:10, cursor:pending?'not-allowed':'pointer', fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#7a9ab8', opacity:pending?.5:1 }}>CANCEL</button>
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
  const [marketTab, setMarketTab]   = useState<MarketTab>('browse');
  const [showListModal, setShowListModal] = useState(false);

  // Gallery state
  const [nfts, setNfts]             = useState<NFTData[]>([]);
  const [loading, setLoading]       = useState(false);
  const [enriching, setEnriching]   = useState(false);
  const [error, setError]           = useState('');
  const [selected, setSelected]     = useState<NFTData | null>(null);
  const [searchQ, setSearchQ]       = useState('');
  const [loadLabel, setLoadLabel]   = useState('');
  const [prelistNft, setPrelistNft] = useState<NFTData | null>(null);

  // Marketplace state
  const [listings, setListings]               = useState<Listing[]>([]);
  const [loadingListings, setLoadingListings] = useState(false);
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
    const enriched = await Promise.all(raw.map(l => enrichListing(connection, l)));
    setListings(enriched); setLoadingListings(false);
  }, [connection]);

  const loadActivity = useCallback(async () => {
    setLoadingActivity(true);
    try {
      // First try loading from Supabase (our own saved trades)
      let supaLogs: TradeLog[] = [];
      try {
        if (supabase) {
          const { data } = await supabase
            .from('labwork_trades')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(100);
          if (data && data.length > 0) {
            supaLogs = data.map((r: any) => ({
              sig: r.sig, type: r.type, nftMint: r.nft_mint,
              price: r.price, seller: r.seller, buyer: r.buyer,
              timestamp: r.timestamp,
            }));
          }
        }
      } catch { /* supabase not available */ }

      // Also fetch from chain directly
      const progId = getMarketplaceProgramId();
      const sigs = await connection.getSignaturesForAddress(progId, { limit: 50 });
      const listDisc   = Buffer.from(await discriminatorAsync('list_nft')).toString('hex');
      const buyDisc    = Buffer.from(await discriminatorAsync('buy_nft')).toString('hex');
      const delistDisc = Buffer.from(await discriminatorAsync('cancel_listing')).toString('hex');

      const chainLogs: TradeLog[] = [];
      for (const s of sigs.slice(0, 20)) {
        if (s.err) continue;
        try {
          // Use getTransaction with json encoding — X1 returns base58 data
          const tx = await connection.getTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (!tx) continue;
          const ts = tx.blockTime ?? 0;
          const msg = tx.transaction?.message;
          const accountKeys: string[] = (msg?.accountKeys ?? msg?.staticAccountKeys ?? [])
            .map((k: any) => k?.toBase58?.() ?? k?.toString?.() ?? k);
          const ixs = msg?.instructions ?? [];

          for (const ix of ixs as any[]) {
            const progIdx = ix.programIdIndex ?? -1;
            const progKey = accountKeys[progIdx] ?? '';
            if (progKey !== progId.toBase58()) continue;

            // Decode instruction data — may be base58 or base64
            let dataHex = '';
            if (ix.data) {
              try {
                // Try base58 first (X1 default)
                const { PublicKey: PK } = await import('@solana/web3.js');
                const decoded = Buffer.from(ix.data, 'base58' as any);
                dataHex = decoded.toString('hex');
              } catch {
                try { dataHex = Buffer.from(ix.data, 'base64').toString('hex'); } catch { }
              }
            }

            const disc8 = dataHex.slice(0, 16);
            let type: TradeLog['type'] | null = null;
            if (disc8 === listDisc)   type = 'list';
            if (disc8 === buyDisc)    type = 'buy';
            if (disc8 === delistDisc) type = 'delist';
            if (!type) continue;

            const ixAccs: string[] = (ix.accounts ?? []).map((idx: number) => accountKeys[idx] ?? '');
            const mint   = ixAccs[1] ?? '';
            const seller = type === 'buy' ? (ixAccs[5] ?? '') : (ixAccs[0] ?? '');
            const buyer  = type === 'buy' ? (ixAccs[0] ?? '') : undefined;
            let price: number | undefined;
            if (type === 'list' && dataHex.length >= 32) {
              try {
                const priceBuf = Buffer.from(dataHex.slice(16, 32), 'hex');
                price = Number(priceBuf.readBigUInt64LE(0));
              } catch { }
            }
            // Skip if already in supaLogs
            if (!supaLogs.find(l => l.sig === s.signature)) {
              chainLogs.push({ sig: s.signature, type, nftMint: mint, price, seller, buyer, timestamp: ts });
            }
          }
        } catch { continue; }
      }

      // Merge: supabase logs first (most reliable), then chain logs
      const allLogs = [...supaLogs, ...chainLogs]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);

      // Enrich top 30 with NFT metadata (fetch from chain)
      const enriched = await Promise.all(allLogs.slice(0, 30).map(async log => {
        if (!log.nftMint || log.nftData) return log;
        try {
          const nftData = await enrichNFTFromMint(connection, log.nftMint);
          return { ...log, nftData };
        } catch { return log; }
      }));
      setTradeLogs([...enriched, ...allLogs.slice(30)]);
    } catch (e) { console.error('loadActivity error:', e); }
    setLoadingActivity(false);
  }, [connection]);

  useEffect(() => { loadListings(); }, []);
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

      const disc = await discriminatorAsync('buy_nft');
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

      const disc = await discriminatorAsync('cancel_listing');
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
  const filtered    = searchQ
    ? nfts.filter(n => n.name.toLowerCase().includes(searchQ.toLowerCase()) || n.symbol.toLowerCase().includes(searchQ.toLowerCase()) || (n.collection ?? '').toLowerCase().includes(searchQ.toLowerCase()))
    : nfts;
  const groups      = groupByCollection(filtered);
  const myListings  = listings.filter(l => l.seller === publicKey?.toBase58());

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
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
        input[type=number]  { -moz-appearance:textfield; }
        input::placeholder  { color:#2a4a6a; }
      `}</style>

      <div style={{ position:'relative', zIndex:1, maxWidth:1100, margin:'0 auto' }}>

        {/* ── PAGE HEADER ───────────────────────────────────────── */}
        <div style={{ textAlign:'center', marginBottom: isMobile ? 24 : 40, animation:'fadeUp 0.5s ease both' }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 9, color:'#3a5a7a',
            letterSpacing: isMobile ? 3 : 6, marginBottom:14, textTransform:'uppercase' }}>
            X1 BLOCKCHAIN · NFT SCANNER & MARKETPLACE
          </div>
          <h1 style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 22 : 38, fontWeight:900,
            letterSpacing: isMobile ? 3 : 6, margin:'0 0 10px', lineHeight:1.1, textTransform:'uppercase' }}>
            <span style={{ background:'linear-gradient(135deg,#00d4ff 0%,#bf5af2 50%,#00c98d 100%)',
              WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text' }}>
              X1 LAB WORK
            </span>
            <span style={{ WebkitTextFillColor:'initial', backgroundClip:'initial', background:'none', marginLeft: isMobile ? 6 : 10 }}>🧪</span>
            <span style={{ background:'linear-gradient(135deg,#00d4ff 0%,#bf5af2 50%,#00c98d 100%)',
              WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text' }}>
              {' '}NFTs
            </span>
          </h1>
          <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 12, color:'#4a6a8a', marginBottom:20 }}>
            Scan · Inspect · List · Buy · Sell — powered by X1 blockchain & native XNT
          </div>
          {!loading && (
            <div style={{ display:'flex', justifyContent:'center', gap: isMobile ? 8 : 14, flexWrap:'wrap', animation:'fadeUp 0.4s ease 0.1s both' }}>
              {[{label:'LISTED',color:'#00c98d',value:listings.length},{label:'MY NFTs',color:'#00d4ff',value:nfts.length},{label:'COLLECTIONS',color:'#bf5af2',value:groups.size},{label:'BLOCKCHAIN',color:'#ff8c00',value:'X1'}]
                .map(({label,color,value}) => (
                  <div key={label} style={{ background:'rgba(255,255,255,.03)', border:`1px solid ${color}22`, borderRadius:10, padding: isMobile ? '8px 14px' : '10px 20px', textAlign:'center' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 16 : 22, fontWeight:900, color, marginBottom:3 }}>{value}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#3a5a7a', letterSpacing:1.5 }}>{label}</div>
                  </div>
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
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 20, fontWeight:900, color:'#3a5a7a', marginBottom:12, letterSpacing:2 }}>WALLET NOT CONNECTED</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#2a4a6a', maxWidth:340, margin:'0 auto' }}>Connect your wallet to scan for NFTs on X1</div>
              </div>
            )}
            {loading && (
              <div style={{ textAlign:'center', padding:'80px 20px', animation:'fadeUp 0.4s ease both' }}>
                <div style={{ fontSize:48, marginBottom:20, animation:'spin 2s linear infinite', display:'inline-block' }}>🧪</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, color:'#00d4ff', letterSpacing:2, marginBottom:8 }}>SCANNING NFTs…</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#3a5a7a' }}>{loadLabel}</div>
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
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 18, fontWeight:900, color:'#3a5a7a', marginBottom:10, letterSpacing:2 }}>NO NFTs DETECTED</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#2a4a6a', maxWidth:360, margin:'0 auto' }}>No NFTs found. NFTs are tokens with 0 decimals and balance of 1.</div>
              </div>
            )}
            {!loading && nfts.length > 0 && (
              <>
                {/* ── Search bar ── */}
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20, animation:'fadeUp 0.4s ease 0.15s both' }}>
                  <div style={{ flex:1, position:'relative' }}>
                    <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', fontFamily:'Orbitron,monospace', fontSize:10, color:'#3a5a7a', pointerEvents:'none' }}>🔍</span>
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
                  ? <div style={{ textAlign:'center', padding:'40px 0', fontFamily:'Orbitron,monospace', fontSize:11, color:'#3a5a7a' }}>NO RESULTS FOR "{searchQ}"</div>
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
            {/* Market tabs */}
            <div style={{ display:'flex', gap:5, marginBottom: isMobile ? 18 : 24, background:'rgba(255,255,255,.03)',
              borderRadius:12, padding:4, border:'1px solid rgba(255,255,255,.06)', animation:'fadeUp 0.3s ease 0.05s both' }}>
              {([
                { id:'browse',     label:'🛒 BROWSE',     badge: listings.length  },
                { id:'mylistings', label:'📋 MY LISTINGS', badge: myListings.length },
                { id:'sell',       label:'🏷️ SELL NFT',   badge: null             },
                { id:'activity',   label:'📊 ACTIVITY',   badge: null             },
              ] as { id:MarketTab; label:string; badge:number|null }[]).map(t => (
                <button key={t.id} onClick={() => {
                  setMarketTab(t.id);
                  if (t.id === 'sell' && prelistNft) { setShowListModal(true); }
                }} style={{ flex:1,
                  padding: isMobile ? '8px 4px' : '10px 8px',
                  background: marketTab===t.id ? 'rgba(0,212,255,.12)' : 'transparent',
                  border: marketTab===t.id ? '1px solid rgba(0,212,255,.3)' : '1px solid transparent',
                  borderRadius:9, cursor:'pointer', transition:'all 0.15s',
                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 9, fontWeight:700,
                  color: marketTab===t.id ? '#00d4ff' : '#4a6a8a',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>
                  {t.label}
                  {t.badge !== null && t.badge > 0 && (
                    <span style={{ background:'rgba(0,212,255,.2)', border:'1px solid rgba(0,212,255,.3)',
                      borderRadius:10, padding:'0 6px', fontSize:8, color:'#00d4ff' }}>{t.badge}</span>
                  )}
                </button>
              ))}
            </div>

            {/* BROWSE */}
            {marketTab === 'browse' && (
              <div style={{ animation:'fadeUp 0.3s ease both' }}>
                {loadingListings && (
                  <div style={{ textAlign:'center', padding:'60px 0' }}>
                    <div style={{ width:30, height:30, borderRadius:'50%', border:'3px solid rgba(0,212,255,.2)', borderTop:'3px solid #00d4ff', animation:'spin 0.8s linear infinite', margin:'0 auto 14px' }} />
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#3a5a7a', letterSpacing:2 }}>LOADING LISTINGS…</div>
                  </div>
                )}
                {!loadingListings && listings.length === 0 && (
                  <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '90px 40px' }}>
                    <div style={{ fontSize:52, marginBottom:18 }}>🏪</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 12 : 16, fontWeight:900, color:'#3a5a7a', marginBottom:10, letterSpacing:2 }}>NO LISTINGS YET</div>
                    <button onClick={() => setMarketTab('sell')} style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, letterSpacing:2, color:'#00d4ff', background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.3)', borderRadius:10, padding:'12px 28px', cursor:'pointer' }}>🏷️ LIST YOUR FIRST NFT</button>
                  </div>
                )}
                {!loadingListings && listings.length > 0 && (
                  <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: isMobile ? 10 : 14 }}>
                    {listings.map(l => <ListingCard key={l.listingPda} listing={l} isMobile={isMobile}
                      isOwner={l.seller === publicKey?.toBase58()}
                      onBuy={() => { setConfirmTarget({ listing:l, mode:'buy' }); setTxStatus(''); }}
                      onDelist={() => { setConfirmTarget({ listing:l, mode:'delist' }); setTxStatus(''); }} />)}
                  </div>
                )}
              </div>
            )}

            {/* MY LISTINGS */}
            {marketTab === 'mylistings' && (
              <div style={{ animation:'fadeUp 0.3s ease both' }}>
                {!publicKey && <div style={{ textAlign:'center', padding:'60px 20px' }}><div style={{ fontSize:48, marginBottom:16 }}>🔒</div><div style={{ fontFamily:'Orbitron,monospace', fontSize:13, color:'#3a5a7a', letterSpacing:2 }}>CONNECT WALLET</div></div>}
                {publicKey && myListings.length === 0 && (
                  <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '80px 40px' }}>
                    <div style={{ fontSize:44, marginBottom:16 }}>📋</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 14, fontWeight:900, color:'#3a5a7a', marginBottom:10, letterSpacing:2 }}>NO ACTIVE LISTINGS</div>
                    <button onClick={() => setMarketTab('sell')} style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, letterSpacing:1.5, color:'#00d4ff', background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.3)', borderRadius:10, padding:'11px 24px', cursor:'pointer', marginTop:8 }}>🏷️ LIST AN NFT</button>
                  </div>
                )}
                {publicKey && myListings.length > 0 && (
                  <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: isMobile ? 10 : 14 }}>
                    {myListings.map(l => <ListingCard key={l.listingPda} listing={l} isMobile={isMobile} isOwner={true}
                      onBuy={() => {}}
                      onDelist={() => { setConfirmTarget({ listing:l, mode:'delist' }); setTxStatus(''); }} />)}
                  </div>
                )}
              </div>
            )}

            {/* SELL */}
            {marketTab === 'sell' && (
              <div style={{ animation:'fadeUp 0.3s ease both' }}>
                {!publicKey ? (
                  <div style={{ textAlign:'center', padding:'48px 24px' }}>
                    <div style={{ fontSize:42, marginBottom:16 }}>🔌</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:12, color:'#4a6a8a', letterSpacing:1 }}>CONNECT WALLET TO LIST NFTS</div>
                  </div>
                ) : loading ? (
                  <div style={{ textAlign:'center', padding:'48px 24px', color:'#4a6a8a', fontSize:11 }}>Loading your NFTs…</div>
                ) : nfts.length === 0 ? (
                  <div style={{ textAlign:'center', padding:'48px 24px' }}>
                    <div style={{ fontSize:42, marginBottom:16 }}>🪹</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#4a6a8a' }}>NO NFTS FOUND IN WALLET</div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#4a6a8a', letterSpacing:1.5, marginBottom:16 }}>
                      SELECT NFT TO LIST FOR SALE
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:`repeat(${isMobile ? 2 : 4}, 1fr)`, gap:12 }}>
                      {nfts.map(nft => (
                        <button key={nft.mint} onClick={() => { setPrelistNft(nft); setShowListModal(true); }}
                          style={{ background:'rgba(255,255,255,.03)', border:'1px solid rgba(0,212,255,.12)', borderRadius:14,
                            padding:0, cursor:'pointer', overflow:'hidden', transition:'all 0.18s', textAlign:'left' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.border='1px solid rgba(0,212,255,.4)'; (e.currentTarget as HTMLButtonElement).style.transform='translateY(-2px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow='0 8px 24px rgba(0,212,255,.12)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.border='1px solid rgba(0,212,255,.12)'; (e.currentTarget as HTMLButtonElement).style.transform=''; (e.currentTarget as HTMLButtonElement).style.boxShadow=''; }}>
                          {/* NFT Image */}
                          <div style={{ position:'relative', paddingBottom:'100%', background:'rgba(0,0,0,.3)' }}>
                            {nft.image
                              ? <img src={nft.image} alt={nft.name} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', imageRendering:'pixelated' }} />
                              : <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:28 }}>🖼️</div>}
                            <div style={{ position:'absolute', top:6, right:6, background:'rgba(0,212,255,.9)', borderRadius:6, padding:'2px 7px', fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700, color:'#000', letterSpacing:1 }}>LIST</div>
                          </div>
                          {/* NFT Info */}
                          <div style={{ padding:'10px 10px 12px' }}>
                            <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#e0f0ff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:2 }}>{nft.name}</div>
                            <div style={{ fontSize:8, color:'#4a6a8a' }}>{nft.symbol || nft.mint.slice(0,8)+'…'}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {marketTab === 'activity' && (
              <div style={{ animation:'fadeUp 0.3s ease both' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#4a6a8a', letterSpacing:1 }}>RECENT TRADES</span>
                  <button onClick={loadActivity} disabled={loadingActivity} style={{ background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.2)', borderRadius:8, padding:'5px 12px', fontSize:9, color:'#00d4ff', cursor:'pointer', fontFamily:'Orbitron,monospace' }}>
                    {loadingActivity ? '⟳ LOADING…' : '↺ REFRESH'}
                  </button>
                </div>
                {loadingActivity ? (
                  <div style={{ textAlign:'center', padding:40, color:'#4a6a8a', fontSize:11 }}>Loading activity…</div>
                ) : tradeLogs.length === 0 ? (
                  <div style={{ textAlign:'center', padding:40, color:'#4a6a8a', fontSize:11 }}>No activity found</div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {tradeLogs.map((log, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.06)', borderRadius:10, overflow:'hidden' }}>
                        {/* NFT thumbnail — fixed 44x44, no bleed */}
                        <div style={{ width:44, height:44, borderRadius:8, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative' }}>
                          {log.nftData?.image
                            ? <img
                                src={log.nftData.image}
                                alt={log.nftData?.name ?? ''}
                                style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', imageRendering:'pixelated', display:'block' }}
                                onError={e => { (e.target as HTMLImageElement).style.display='none'; }}
                              />
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
                          <div style={{ fontSize:9, color:'#4a6a8a' }}>
                            {log.price ? <span style={{ color:'#00d4ff', marginRight:8 }}>{lamportsToXnt(log.price)} XNT</span> : null}
                            <span>{new Date(log.timestamp * 1000).toLocaleString()}</span>
                          </div>
                        </div>
                        {/* Explorer link */}
                        <a href={`https://explorer.mainnet.x1.xyz/tx/${log.sig}`} target="_blank" rel="noopener"
                          style={{ color:'#3a5a7a', fontSize:10, textDecoration:'none', flexShrink:0, padding:'4px 8px', border:'1px solid rgba(255,255,255,.06)', borderRadius:6, fontFamily:'monospace' }}
                          title={log.sig}>
                          TX ↗
                        </a>
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
    </div>
  );
};

export default LabWork;