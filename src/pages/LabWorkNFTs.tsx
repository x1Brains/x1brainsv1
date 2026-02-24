import React, { FC, useState, useEffect, useCallback } from 'react';
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
  FEE_BPS,
  BPS_DENOM,
} from '../constants';
import {
  NFTImage,
  nftImageCache,
  nftMetaCache,
  rarityColor,
  resolveGateway,
  toProxyUrl,
  fetchNFTMeta,
} from '../components/NFTComponents';

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
const PLATFORM_WALLET     = new PublicKey(PLATFORM_WALLET_STRING);
function getMarketplaceProgramId(): PublicKey {
  if (MARKETPLACE_PROGRAM_ID_STRING === 'YOUR_PROGRAM_ID_HERE') {
    throw new Error('Marketplace program ID not set in constants/index.ts');
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
type MarketTab = 'browse' | 'mylistings' | 'sell';

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
const calcFee         = (p: number)     => Math.floor(p * FEE_BPS / BPS_DENOM);
const calcSellerCut   = (p: number)     => p - calcFee(p);
const xntToLamports   = (x: string)     => Math.round(parseFloat(x) * LAMPORTS_PER_SOL);

// ─────────────────────────────────────────────────────────────────
//  MARKETPLACE PDA HELPERS
//  Seeds must exactly match the Rust program:
//    listing → [b"listing", mint, seller]
//    escrow  → [b"escrow",  mint, seller]
// ─────────────────────────────────────────────────────────────────
function getListingPda(mint: PublicKey, seller: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('listing'), mint.toBuffer(), seller.toBuffer()],
    getMarketplaceProgramId()
  );
}
function getEscrowPda(mint: PublicKey, seller: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), mint.toBuffer(), seller.toBuffer()],
    getMarketplaceProgramId()
  );
}


// ─── Anchor instruction discriminator ─────────────────────────────
// sha256("global:<n>")[0..8] — matches what anchor-lang generates.
// Uses window.crypto.subtle (Web Crypto API) — no eval, no require('crypto'),
// 100% CSP-safe. Results are cached so repeated calls are instant.
const _discCache = new Map<string, Buffer>();
async function discriminatorAsync(name: string): Promise<Buffer> {
  if (_discCache.has(name)) return _discCache.get(name)!;
  const data    = new TextEncoder().encode(`global:${name}`);
  const hashBuf = await window.crypto.subtle.digest('SHA-256', data);
  const result  = Buffer.from(new Uint8Array(hashBuf).slice(0, 8));
  _discCache.set(name, result);
  return result;
}
// Pre-warm cache at module load so values are ready before any button click.
(async () => {
  await Promise.all([
    discriminatorAsync('list_nft'),
    discriminatorAsync('buy_nft'),
    discriminatorAsync('delist_nft'),
    discriminatorAsync('listing'),
  ]);
})();
// ─────────────────────────────────────────────────────────────────
//  NFT METADATA ENRICHMENT
// ─────────────────────────────────────────────────────────────────
async function enrichNFT(nft: NFTData): Promise<NFTData> {
  const uri = nft.metaUri || nft.logoUri;
  if (!uri) return nft;
  const json = nftMetaCache.get(uri) ?? await fetchNFTMeta(uri);
  if (!json) return nft;
  return {
    ...nft,
    description: json.description  ?? nft.description,
    attributes:  json.attributes   ?? nft.attributes,
    externalUrl: json.external_url ?? json.external_link ?? nft.externalUrl,
    collection:  typeof json.collection === 'string' ? json.collection : (json.collection?.name ?? nft.collection),
    image: (() => {
      const raw = json.image ?? json.image_url ?? json.imageUrl ?? json.properties?.image ?? '';
      return raw ? resolveGateway(raw) : nft.image;
    })(),
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
      const infos = await connection.getMultipleAccountsInfo(pdaKeys);
      infos.forEach((info: any, idx: number) => {
        if (!info?.data) return;
        try {
          const raw = info.data instanceof Uint8Array ? info.data
            : Uint8Array.from(atob(Array.isArray(info.data) ? info.data[0] : info.data), c => c.charCodeAt(0));
          if (raw.length < 69) return;
          const view = new DataView(raw.buffer, raw.byteOffset);
          let o = 65;
          const nL = view.getUint32(o, true); o += 4;
          if (nL <= 0 || nL > 200 || o + nL > raw.length) return;
          const name = new TextDecoder().decode(raw.slice(o, o + nL)).replace(/\x00/g,'').trim(); o += nL;
          const sL = view.getUint32(o, true); o += 4;
          if (sL > 50 || o + sL > raw.length) return;
          const symbol = new TextDecoder().decode(raw.slice(o, o + sL)).replace(/\x00/g,'').trim(); o += sL;
          const uL = view.getUint32(o, true); o += 4;
          if (uL <= 0 || uL > 500 || o + uL > raw.length) return;
          const uri = new TextDecoder().decode(raw.slice(o, o + uL)).replace(/\x00/g,'').trim();
          if (uri.startsWith('http') || uri.startsWith('ipfs://') || uri.startsWith('ar://'))
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
    const disc     = await discriminatorAsync('listing');
    const accounts = await connection.getProgramAccounts(getMarketplaceProgramId(), {
      filters: [
        { dataSize: 83 },
        { memcmp: { offset: 0, bytes: disc.toString('base64') } },
      ],
    });
    return (accounts as any[]).map(({ pubkey, account }: any) => {
      const d       = account.data as Buffer;
      const seller  = new PublicKey(d.slice(8, 40)).toBase58();
      const nftMint = new PublicKey(d.slice(40, 72)).toBase58();
      const price   = Number(d.readBigUInt64LE(72));
      const active  = d[80] === 1;
      const [escrowPda] = getEscrowPda(new PublicKey(nftMint), new PublicKey(seller));
      return { listingPda: pubkey.toBase58(), escrowPda: escrowPda.toBase58(), seller, nftMint, price, active };
    }).filter((l: Listing) => l.active);
  } catch { return []; }
}

async function enrichListing(connection: any, l: Listing): Promise<Listing> {
  try {
    const mintPk = new PublicKey(l.nftMint);
    const [pda]  = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), mintPk.toBytes()],
      METADATA_PROGRAM_ID
    );
    const info = await connection.getAccountInfo(pda);
    if (!info?.data) return l;
    const raw = info.data instanceof Uint8Array ? info.data
      : Uint8Array.from(atob(Array.isArray(info.data) ? info.data[0] : info.data), c => c.charCodeAt(0));
    if (raw.length < 69) return l;
    const view = new DataView(raw.buffer, raw.byteOffset);
    let o = 65;
    const nL = view.getUint32(o, true); o += 4; if (nL <= 0 || nL > 200 || o + nL > raw.length) return l;
    const name = new TextDecoder().decode(raw.slice(o, o + nL)).replace(/\x00/g,'').trim(); o += nL;
    const sL = view.getUint32(o, true); o += 4; if (sL > 50 || o + sL > raw.length) return l;
    const symbol = new TextDecoder().decode(raw.slice(o, o + sL)).replace(/\x00/g,'').trim(); o += sL;
    const uL = view.getUint32(o, true); o += 4; if (uL <= 0 || uL > 500 || o + uL > raw.length) return l;
    const uri = new TextDecoder().decode(raw.slice(o, o + uL)).replace(/\x00/g,'').trim();
    const base: NFTData = { mint: l.nftMint, name, symbol, balance: 1, decimals: 0, isToken2022: false, metaUri: uri };
    const enriched = await enrichNFT(base);
    return { ...l, nftData: enriched };
  } catch { return l; }
}

// ─────────────────────────────────────────────────────────────────
//  SHARED INLINE COMPONENTS
// ─────────────────────────────────────────────────────────────────
const StatusBox: FC<{ msg: string }> = ({ msg }) => {
  if (!msg) return null;
  const ok = msg.includes('✅'), err = msg.includes('❌');
  return <div style={{ padding:'8px 12px', borderRadius:8, marginBottom:14,
    background: ok ? 'rgba(0,201,141,.08)' : err ? 'rgba(255,50,50,.08)' : 'rgba(0,212,255,.06)',
    border:`1px solid ${ok ? 'rgba(0,201,141,.3)' : err ? 'rgba(255,50,50,.3)' : 'rgba(0,212,255,.2)'}`,
    fontFamily:'Sora,sans-serif', fontSize:11,
    color: ok ? '#00c98d' : err ? '#ff6666' : '#00d4ff' }}>{msg}</div>;
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
  const imgUri = nft.metaUri || nft.logoUri;
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
  const imgUri = nft.metaUri || nft.logoUri;
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
const CollectionSection: FC<{ collectionName: string; nfts: NFTData[]; isMobile: boolean; colIndex: number; onSelect: (nft: NFTData) => void }> = ({ collectionName, nfts, isMobile, colIndex, onSelect }) => {
  const [expanded, setExpanded] = useState(true);
  const colors = ['#00d4ff','#bf5af2','#00c98d','#ffd700','#ff8c00'];
  const col    = colors[colIndex % colors.length];
  const rgba   = col==='#00d4ff'?'0,212,255':col==='#bf5af2'?'191,90,242':col==='#00c98d'?'0,201,141':col==='#ffd700'?'255,215,0':'255,140,0';
  return (
    <div style={{ marginBottom: isMobile ? 28 : 36, animation:`fadeUp 0.5s ease ${colIndex * 0.08}s both` }}>
      <div onClick={() => setExpanded(v => !v)} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14, cursor:'pointer', userSelect:'none' }}>
        <div style={{ width:3, height:28, borderRadius:2, background:col, flexShrink:0, boxShadow:`0 0 10px ${col}66` }} />
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:'#fff', letterSpacing:1.5, marginBottom:2 }}>{collectionName}</div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#4a6a8a', letterSpacing:1 }}>{nfts.length} NFT{nfts.length!==1?'s':''} · COLLECTION</div>
        </div>
        <div style={{ background:`rgba(${rgba},.12)`, border:`1px solid ${col}33`, borderRadius:20, padding:'4px 12px',
          fontFamily:'Orbitron,monospace', fontSize:9, color:col, fontWeight:700 }}>{nfts.length}</div>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a', transition:'transform 0.2s',
          transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▾</div>
      </div>
      <div style={{ height:1, marginBottom:14, background:`linear-gradient(90deg,${col}44,${col}22,transparent)` }} />
      {expanded && (
        <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(5,1fr)', gap: isMobile ? 7 : 10 }}>
          {nfts.map((nft, i) => <NFTCard key={nft.mint} nft={nft} index={i} isMobile={isMobile} onClick={() => onSelect(nft)} />)}
        </div>
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
  const imgUri = nft?.metaUri || nft?.logoUri;
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
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#3a5a7a' }}>SELLER GETS {lamportsToXnt(calcSellerCut(listing.price))} · 4% FEE</div>
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
  const imgUri = nft?.metaUri || nft?.logoUri;
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
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#3a5a7a' }}>→ SELLER RECEIVES (96%)</span>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#00c98d' }}>{lamportsToXnt(calcSellerCut(listing.price))} XNT</span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'8px 14px' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#3a5a7a' }}>→ PLATFORM FEE (4%)</span>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#bf5af2' }}>{lamportsToXnt(calcFee(listing.price))} XNT</span>
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
  walletNfts:      NFTData[];
  loadingNfts:     boolean;
  preselect?:      NFTData | null;
  onListed:        () => void;
}> = ({ isMobile, connection, publicKey, sendTransaction, walletNfts, loadingNfts, preselect, onListed }) => {
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
      const nftMint      = new PublicKey(selected.mint);
      const [listingPda] = getListingPda(nftMint, publicKey);
      const [escrowPda]  = getEscrowPda(nftMint, publicKey);
      const sellerAta    = getAssociatedTokenAddressSync(nftMint, publicKey, false, selected.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
      const disc         = await discriminatorAsync('list_nft');
      const priceData    = Buffer.alloc(8);
      priceData.writeBigUInt64LE(BigInt(lamports));
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,                   isSigner:true,  isWritable:true  },
          { pubkey: nftMint,                     isSigner:false, isWritable:false },
          { pubkey: sellerAta,                   isSigner:false, isWritable:true  },
          { pubkey: escrowPda,                   isSigner:false, isWritable:true  },
          { pubkey: listingPda,                  isSigner:false, isWritable:true  },
          { pubkey: TOKEN_PROGRAM_ID,            isSigner:false, isWritable:false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner:false, isWritable:false },
          { pubkey: SystemProgram.programId,     isSigner:false, isWritable:false },
          { pubkey: SYSVAR_RENT_PUBKEY,          isSigner:false, isWritable:false },
        ],
        data: Buffer.concat([disc, priceData]),
      };
      const tx = new Transaction().add(ix as any);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.feePayer = publicKey;
      setStatus('Awaiting wallet approval…');
      const sig = await sendTransaction(tx, connection);
      setStatus('Confirming on X1…');
      await connection.confirmTransaction(sig, 'confirmed');
      setStatus(`✅ Listed! Tx: ${sig.slice(0,14)}…`);
      setSelected(null); setPrice('');
      setTimeout(() => { setStatus(''); onListed(); }, 2500);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0,90) ?? 'Transaction failed'}`);
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
            const imgUri = nft.metaUri || nft.logoUri;
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
                { l:'YOU RECEIVE (96%)',v:`${(parseFloat(price)*0.96).toFixed(4)} XNT`, c:'#00c98d' },
                { l:'PLATFORM FEE (4%)',v:`${(parseFloat(price)*0.04).toFixed(4)} XNT`, c:'#bf5af2' },
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
//  MAIN PAGE COMPONENT
// ═════════════════════════════════════════════════════════════════
const LabWorkNFTs: FC = () => {
  const { publicKey, sendTransaction } = useWallet();
  const { connection }                 = useConnection();
  const isMobile                       = useIsMobile();

  // Page state
  const [pageMode, setPageMode]     = useState<PageMode>('gallery');
  const [marketTab, setMarketTab]   = useState<MarketTab>('browse');

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

  useEffect(() => { if (pageMode === 'market') loadListings(); }, [pageMode]);

  // ── Gallery select ────────────────────────────────────────────
  const handleSelect = useCallback(async (nft: NFTData) => {
    setSelected(nft);
    const fresh = await enrichNFT(nft);
    setSelected(fresh);
  }, []);

  // ── "List this" shortcut from gallery modal ───────────────────
  const handleListFromGallery = (nft: NFTData) => {
    setPrelistNft(nft); setPageMode('market'); setMarketTab('sell');
  };

  // ── BUY transaction ───────────────────────────────────────────
  const executeBuy = async () => {
    if (!publicKey || !confirmTarget) return;
    const { listing } = confirmTarget;
    setTxPending(true); setTxStatus('Preparing…');
    try {
      const nftMint      = new PublicKey(listing.nftMint);
      const sellerPk     = new PublicKey(listing.seller);
      const [listingPda] = getListingPda(nftMint, sellerPk);
      const [escrowPda]  = getEscrowPda(nftMint, sellerPk);
      const buyerAta     = getAssociatedTokenAddressSync(nftMint, publicKey);
      const preIxs: any[] = [];
      if (!(await connection.getAccountInfo(buyerAta)))
        preIxs.push(createAssociatedTokenAccountInstruction(publicKey, buyerAta, publicKey, nftMint));
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,                   isSigner:true,  isWritable:true  },
          { pubkey: sellerPk,                    isSigner:false, isWritable:true  },
          { pubkey: PLATFORM_WALLET,             isSigner:false, isWritable:true  }, // 4% — hardcoded & verified on-chain
          { pubkey: nftMint,                     isSigner:false, isWritable:false },
          { pubkey: escrowPda,                   isSigner:false, isWritable:true  },
          { pubkey: buyerAta,                    isSigner:false, isWritable:true  },
          { pubkey: listingPda,                  isSigner:false, isWritable:true  },
          { pubkey: TOKEN_PROGRAM_ID,            isSigner:false, isWritable:false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner:false, isWritable:false },
          { pubkey: SystemProgram.programId,     isSigner:false, isWritable:false },
          { pubkey: SYSVAR_RENT_PUBKEY,          isSigner:false, isWritable:false },
        ],
        data: await discriminatorAsync('buy_nft'),
      };
      const tx = new Transaction().add(...preIxs, ix as any);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.feePayer = publicKey;
      setTxStatus('Awaiting wallet approval…');
      const sig = await sendTransaction(tx, connection);
      setTxStatus('Confirming on X1…');
      await connection.confirmTransaction(sig, 'confirmed');
      setTxStatus(`✅ NFT purchased! Tx: ${sig.slice(0,14)}…`);
      setTimeout(() => { setConfirmTarget(null); setTxStatus(''); loadListings(); }, 2500);
    } catch (e: any) {
      setTxStatus(`❌ ${e?.message?.slice(0,90) ?? 'Transaction failed'}`);
    } finally { setTxPending(false); }
  };

  // ── DELIST transaction ────────────────────────────────────────
  const executeDelist = async () => {
    if (!publicKey || !confirmTarget) return;
    const { listing } = confirmTarget;
    setTxPending(true); setTxStatus('Preparing…');
    try {
      const nftMint      = new PublicKey(listing.nftMint);
      const [listingPda] = getListingPda(nftMint, publicKey);
      const [escrowPda]  = getEscrowPda(nftMint, publicKey);
      const sellerAta    = getAssociatedTokenAddressSync(nftMint, publicKey);
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,               isSigner:true,  isWritable:true  },
          { pubkey: nftMint,                 isSigner:false, isWritable:false },
          { pubkey: escrowPda,               isSigner:false, isWritable:true  },
          { pubkey: sellerAta,               isSigner:false, isWritable:true  },
          { pubkey: listingPda,              isSigner:false, isWritable:true  },
          { pubkey: TOKEN_PROGRAM_ID,        isSigner:false, isWritable:false },
          { pubkey: SystemProgram.programId, isSigner:false, isWritable:false },
        ],
        data: await discriminatorAsync('delist_nft'),
      };
      const tx = new Transaction().add(ix as any);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.feePayer = publicKey;
      setTxStatus('Awaiting wallet approval…');
      const sig = await sendTransaction(tx, connection);
      setTxStatus('Confirming on X1…');
      await connection.confirmTransaction(sig, 'confirmed');
      setTxStatus(`✅ Delisted! Tx: ${sig.slice(0,14)}…`);
      setTimeout(() => { setConfirmTarget(null); setTxStatus(''); loadListings(); }, 2000);
    } catch (e: any) {
      setTxStatus(`❌ ${e?.message?.slice(0,90) ?? 'Transaction failed'}`);
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
            letterSpacing: isMobile ? 3 : 6, margin:'0 0 10px', lineHeight:1.1, textTransform:'uppercase',
            background:'linear-gradient(135deg,#00d4ff 0%,#bf5af2 50%,#00c98d 100%)',
            WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text' }}>
            X1 LAB WORK 🧪 NFTs
          </h1>
          <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 12, color:'#4a6a8a', marginBottom:20 }}>
            Scan · Inspect · List · Buy · Sell — powered by X1 blockchain & native XNT
          </div>
          {!loading && nfts.length > 0 && (
            <div style={{ display:'flex', justifyContent:'center', gap: isMobile ? 8 : 14, flexWrap:'wrap', animation:'fadeUp 0.4s ease 0.1s both' }}>
              {[{label:'MY NFTs',color:'#00d4ff',value:nfts.length},{label:'COLLECTIONS',color:'#bf5af2',value:groups.size},{label:'LISTED',color:'#00c98d',value:listings.length},{label:'BLOCKCHAIN',color:'#ff8c00',value:'X1'}]
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
            { id:'gallery', label:'🧪 MY NFTs',     sub: nfts.length > 0 ? `${nfts.length} found` : 'view your collection' },
            { id:'market',  label:'🛒 MARKETPLACE', sub: listings.length > 0 ? `${listings.length} listed` : 'list & buy NFTs' },
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
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:24, animation:'fadeUp 0.4s ease 0.15s both' }}>
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
                    <CollectionSection key={colName} collectionName={colName} nfts={colNfts} isMobile={isMobile} colIndex={idx} onSelect={handleSelect} />
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
            {/* Fee banner */}
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20, padding:'10px 14px',
              background:'rgba(191,90,242,.06)', border:'1px solid rgba(191,90,242,.18)', borderRadius:10, animation:'fadeUp 0.3s ease both' }}>
              <span style={{ fontSize:16 }}>💎</span>
              <div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, color:'#8a5aaa', letterSpacing:0.5 }}>
                  4% PLATFORM ROYALTY ON ALL SALES · SELLER RECEIVES 96%
                </div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#5a3a7a', marginTop:2 }}>
                  HARDCODED ON-CHAIN → {PLATFORM_WALLET_STRING.slice(0,12)}…{PLATFORM_WALLET_STRING.slice(-6)} · IMMUTABLE PROGRAM
                </div>
              </div>
            </div>

            {/* Market tabs */}
            <div style={{ display:'flex', gap:5, marginBottom: isMobile ? 18 : 24, background:'rgba(255,255,255,.03)',
              borderRadius:12, padding:4, border:'1px solid rgba(255,255,255,.06)', animation:'fadeUp 0.3s ease 0.05s both' }}>
              {([
                { id:'browse',     label:'🛒 BROWSE',     badge: listings.length  },
                { id:'mylistings', label:'📋 MY LISTINGS', badge: myListings.length },
                { id:'sell',       label:'🏷️ SELL NFT',   badge: null             },
              ] as { id:MarketTab; label:string; badge:number|null }[]).map(t => (
                <button key={t.id} onClick={() => setMarketTab(t.id)} style={{ flex:1,
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
                <SellPanel isMobile={isMobile} connection={connection} publicKey={publicKey}
                  sendTransaction={sendTransaction} walletNfts={nfts} loadingNfts={loading}
                  preselect={prelistNft}
                  onListed={() => { setPrelistNft(null); loadListings(); setMarketTab('browse'); }} />
              </div>
            )}
          </>
        )}

        <Footer />
      </div>

      {/* Gallery detail modal */}
      {selected && <NFTDetailModal nft={selected} isMobile={isMobile} onClose={() => setSelected(null)} onListThis={handleListFromGallery} />}

      {/* Marketplace confirm modal */}
      {confirmTarget && <ConfirmModal listing={confirmTarget.listing} mode={confirmTarget.mode} isMobile={isMobile}
        onConfirm={confirmTarget.mode === 'buy' ? executeBuy : executeDelist}
        onCancel={() => { setConfirmTarget(null); setTxStatus(''); setTxPending(false); }}
        status={txStatus} pending={txPending} />}
    </div>
  );
};

export default LabWorkNFTs;