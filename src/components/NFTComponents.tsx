import React, { FC, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TokenData } from './TokenComponents';

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function resolveGateway(u: string): string {
  return u
    .replace('ipfs://', 'https://nftstorage.link/ipfs/')
    .replace('ar://', 'https://arweave.net/');
}
function toProxyUrl(url: string): string {
  return url.startsWith('http')
    ? `/api/nft-meta/${url.replace(/^https?:\/\//, '')}`
    : url;
}
function candidateImageUrls(url: string): string[] {
  const out: string[] = [];
  for (const ext of ['png','jpg','webp','gif']) out.push(`${url}.${ext}`);
  for (const [from, to] of [
    ['metadata','images'],['metadata','image'],
    ['meta','images'],['meta','image'],
    ['json','images'],['json','image'],
  ] as [string,string][]) {
    if (url.includes(`/${from}/`)) {
      const sw = url.replace(`/${from}/`,`/${to}/`);
      out.push(sw);
      for (const ext of ['png','jpg','webp']) out.push(`${sw}.${ext}`);
    }
  }
  return out;
}
function tryLoadImg(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(url);
    img.onerror = () => reject();
    img.src = url;
    setTimeout(() => reject(), 8000);
  });
}
function rarityColor(r: string): string {
  const l = r.toLowerCase();
  if (l.includes('legendary')) return '#ffd700';
  if (l.includes('epic'))      return '#bf5af2';
  if (l.includes('rare'))      return '#00d4ff';
  if (l.includes('uncommon'))  return '#00c98d';
  return '#8aa0b8';
}

// ─────────────────────────────────────────────
// IMAGE CACHE
// ─────────────────────────────────────────────
const NFT_IMG_CACHE_KEY = 'x1b_nft_img_v1';
export const nftImageCache = new Map<string, string | null>();
try {
  const stored = localStorage.getItem(NFT_IMG_CACHE_KEY);
  if (stored) {
    const parsed = JSON.parse(stored) as Record<string, string | null>;
    Object.entries(parsed).forEach(([k, v]) => nftImageCache.set(k, v));
  }
} catch {}
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistNftCache() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    try {
      const obj: Record<string, string | null> = {};
      nftImageCache.forEach((v, k) => { if (v !== null) obj[k] = v; });
      localStorage.setItem(NFT_IMG_CACHE_KEY, JSON.stringify(obj));
    } catch {}
  }, 1000);
}

// ─────────────────────────────────────────────
// METADATA CACHE
// ─────────────────────────────────────────────
export const nftMetaCache = new Map<string, any>();
async function fetchNFTMeta(metaUri: string): Promise<any | null> {
  if (nftMetaCache.has(metaUri)) return nftMetaCache.get(metaUri);
  const url = resolveGateway(metaUri);
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) return null;
  try {
    const res = await fetch(toProxyUrl(url), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.startsWith('image/')) return null;
    const json = await res.json();
    nftMetaCache.set(metaUri, json);
    return json;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// NFT IMAGE
// ─────────────────────────────────────────────
const NFTImage: FC<{ metaUri?: string; name: string; contain?: boolean }> = ({
  metaUri, name, contain = false,
}) => {
  const [imgSrc, setImgSrc] = useState<string | null | undefined>(
    metaUri ? (nftImageCache.has(metaUri) ? nftImageCache.get(metaUri)! : undefined) : null
  );

  useEffect(() => {
    if (!metaUri) { setImgSrc(null); return; }
    if (nftImageCache.has(metaUri)) { setImgSrc(nftImageCache.get(metaUri)!); return; }
    let cancelled = false;
    (async () => {
      const url = resolveGateway(metaUri);
      if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) {
        nftImageCache.set(metaUri, url); persistNftCache();
        if (!cancelled) setImgSrc(url); return;
      }
      try {
        const res = await fetch(toProxyUrl(url), { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const ct = res.headers.get('content-type') ?? '';
          if (ct.startsWith('image/')) {
            nftImageCache.set(metaUri, url); persistNftCache();
            if (!cancelled) setImgSrc(url); return;
          }
          const json = await res.json();
          if (!nftMetaCache.has(metaUri)) nftMetaCache.set(metaUri, json);
          const raw: string = json?.image ?? json?.image_url ?? json?.imageUrl
            ?? json?.properties?.image ?? json?.properties?.files?.[0]?.uri
            ?? json?.properties?.files?.[0] ?? '';
          if (raw) {
            const resolved = resolveGateway(raw);
            nftImageCache.set(metaUri, resolved); persistNftCache();
            if (!cancelled) setImgSrc(resolved); return;
          }
        }
      } catch { }
      for (const candidate of candidateImageUrls(url)) {
        if (cancelled) return;
        try {
          await tryLoadImg(candidate);
          nftImageCache.set(metaUri, candidate); persistNftCache();
          if (!cancelled) setImgSrc(candidate); return;
        } catch { }
      }
      nftImageCache.set(metaUri, null); persistNftCache();
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

// ─────────────────────────────────────────────
// NFT MODAL — no-scroll, two-column desktop,
// stacked mobile. Fits everything in one view.
// ─────────────────────────────────────────────
const NFTModal: FC<{
  nft: TokenData;
  isMobile: boolean;
  onClose: () => void;
  onCopy: (a: string) => void;
  copiedAddress: string | null;
}> = ({ nft, isMobile, onClose, onCopy, copiedAddress }) => {
  const metaUri = (nft as any).metaUri || nft.logoUri;
  const imgSrc  = metaUri ? (nftImageCache.get(metaUri) ?? null) : null;
  const [meta, setMeta] = useState<any>(metaUri ? nftMetaCache.get(metaUri) ?? null : null);

  useEffect(() => {
    if (!metaUri || meta) return;
    fetchNFTMeta(metaUri).then(j => { if (j) setMeta(j); });
  }, [metaUri]);

  useEffect(() => {
    // Save scroll position and lock — restore on unmount
    const scrollY = window.scrollY;
    const body = document.body;
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.overflow = 'hidden';

    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);

    return () => {
      // Always restore — even if closed unexpectedly
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      body.style.overflow = '';
      window.scrollTo(0, scrollY);
      window.removeEventListener('keydown', fn);
    };
  }, []); // empty deps — only run on mount/unmount, not on every onClose change

  const attrs: { trait_type: string; value: string }[] = meta?.attributes ?? [];
  const description = (meta?.description ?? '');
  // Truncate description to 1 line worth
  const shortDesc = description.length > 80 ? description.slice(0, 80) + '…' : description;
  const externalUrl = meta?.external_url ?? meta?.external_link ?? '';
  const collection  = typeof meta?.collection === 'string'
    ? meta.collection : (meta?.collection?.name ?? '');
  const rarity = attrs.find(a => a.trait_type?.toLowerCase() === 'rarity')?.value ?? '';

  const modalContent = (
    <div
      onClick={onClose}
      style={{
        position:'fixed', inset:0, zIndex:9999,
        background:'rgba(0,0,0,.82)', backdropFilter:'blur(10px)',
        display:'flex',
        alignItems: 'center',
        justifyContent:'center',
        padding: isMobile ? '16px' : '16px',
        pointerEvents:'all',
        WebkitTapHighlightColor:'transparent',
        touchAction:'auto',
        animation:'nftFadeIn 0.16s ease both',
      }}
    >
      <style>{`
        @keyframes nftFadeIn  { from{opacity:0} to{opacity:1} }
        @keyframes nftSlideUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
        @keyframes nftSheetUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
      `}</style>

      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: isMobile ? '94%' : 560,
          overflow: 'hidden',
          background: 'linear-gradient(155deg,#0e1828,#080c0f)',
          border: '1px solid rgba(191,90,242,.35)',
          borderRadius: 18,
          boxShadow: '0 0 60px rgba(191,90,242,.12), 0 24px 60px rgba(0,0,0,.8)',
          animation: 'nftSlideUp 0.22s cubic-bezier(.22,1,.36,1) both',
          position:'relative',
        }}
      >
        {/* Top glow line */}
        <div style={{ position:'absolute', top:0, left:'15%', right:'15%', height:1,
          background:'linear-gradient(90deg,transparent,rgba(191,90,242,.8),transparent)' }} />



        {/* Close button */}
        <button onClick={onClose} style={{
          position:'absolute', top: isMobile ? 10 : 10, right:12, zIndex:10,
          width: isMobile ? 34 : 30, height: isMobile ? 34 : 30,
          borderRadius:'50%', border:'1px solid rgba(191,90,242,.3)',
          background:'rgba(8,12,15,.85)', cursor:'pointer',
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:18, color:'#bf5af2', lineHeight:1,
        }}>×</button>

        {isMobile
          /* ═══════════════════════════════════════
             MOBILE LAYOUT — stacked, very compact
             ═══════════════════════════════════════ */
          ? (
            <div style={{ display:'flex', flexDirection:'column' }}>

              {/* Image — fixed height, not percentage */}
              <div style={{ position:'relative', width:'100%', height:180,
                background:'#050a0f', flexShrink:0, borderRadius:'17px 17px 0 0', overflow:'hidden' }}>
                <NFTImage metaUri={metaUri} name={nft.name} contain />
                {rarity && (
                  <div style={{ position:'absolute', bottom:8, left:8,
                    background:'rgba(0,0,0,.8)', backdropFilter:'blur(6px)',
                    border:`1px solid ${rarityColor(rarity)}55`,
                    borderRadius:6, padding:'2px 8px',
                    fontFamily:'Orbitron,monospace', fontSize:8,
                    color:rarityColor(rarity), fontWeight:700, letterSpacing:1 }}>
                    ✦ {rarity.toUpperCase()}
                  </div>
                )}
                <div style={{ position:'absolute', top:8, left:8,
                  background:'rgba(0,0,0,.75)', border:'1px solid rgba(191,90,242,.5)',
                  borderRadius:4, padding:'1px 7px',
                  fontFamily:'Orbitron,monospace', fontSize:8, color:'#bf5af2', fontWeight:700 }}>
                  NFT
                </div>
              </div>

              {/* Info — everything below the image */}
              <div style={{ padding:'10px 14px 16px', display:'flex', flexDirection:'column', gap:8 }}>

                {/* Name + badges */}
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:14, fontWeight:900,
                    color:'#fff', marginBottom:4, lineHeight:1.2 }}>{nft.name}</div>
                  <div style={{ display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
                    {collection && <span style={{ fontSize:10, color:'#6a8aaa', fontFamily:'Sora,sans-serif' }}>{collection}</span>}
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                      background:'rgba(191,90,242,.12)', border:'1px solid rgba(191,90,242,.25)',
                      padding:'1px 6px', borderRadius:3 }}>{nft.symbol}</span>
                  </div>
                </div>

                {/* Traits — horizontal scrolling row, no wrap */}
                {attrs.length > 0 && (
                  <div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:6,
                      color:'#3a5a7a', letterSpacing:1.5, marginBottom:5 }}>TRAITS</div>
                    <div style={{ display:'flex', gap:5, overflowX:'auto',
                      paddingBottom:4, scrollbarWidth:'none' }}>
                      {attrs.map((a, i) => {
                        const isRarity = a.trait_type?.toLowerCase() === 'rarity';
                        const col = isRarity ? rarityColor(a.value) : '#bf5af2';
                        return (
                          <div key={i} style={{ flexShrink:0,
                            background:'rgba(191,90,242,.05)',
                            border:`1px solid ${isRarity ? col+'44' : 'rgba(191,90,242,.15)'}`,
                            borderRadius:6, padding:'4px 8px', textAlign:'center', minWidth:60 }}>
                            <div style={{ fontFamily:'Orbitron,monospace', fontSize:6,
                              color:'#3a5a7a', marginBottom:2, whiteSpace:'nowrap' }}>{a.trait_type}</div>
                            <div style={{ fontFamily:'Sora,sans-serif', fontSize:9,
                              fontWeight:600, color: isRarity ? col : '#b8cce0',
                              whiteSpace:'nowrap' }}>{a.value}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Mint + chain info — single row */}
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                  background:'rgba(255,255,255,.025)', borderRadius:8,
                  border:'1px solid rgba(255,255,255,.05)', padding:'6px 10px', gap:8 }}>
                  <code style={{ fontFamily:'monospace', fontSize:9, color:'#5a8aaa',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                    {nft.mint.slice(0,8)}…{nft.mint.slice(-6)}
                  </code>
                  <button onClick={() => onCopy(nft.mint)} style={{
                    flexShrink:0, padding:'4px 9px', borderRadius:5, cursor:'pointer',
                    background: copiedAddress===nft.mint ? 'rgba(0,201,141,.18)' : 'rgba(191,90,242,.1)',
                    border:`1px solid ${copiedAddress===nft.mint ? 'rgba(0,201,141,.4)' : 'rgba(191,90,242,.3)'}`,
                    color: copiedAddress===nft.mint ? '#00c98d' : '#bf5af2',
                    fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700,
                  }}>
                    {copiedAddress===nft.mint ? '✓' : 'COPY'}
                  </button>
                </div>

                {/* Chain details — 4 columns single row */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:5 }}>
                  {[
                    { label:'CHAIN',    value:'X1' },
                    { label:'STANDARD', value: nft.isToken2022 ? 'T-2022' : 'SPL' },
                    { label:'DECIMALS', value: String(nft.decimals) },
                    { label:'BALANCE',  value: String(nft.balance) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background:'rgba(255,255,255,.02)',
                      borderRadius:6, border:'1px solid rgba(255,255,255,.05)',
                      padding:'4px 6px', textAlign:'center' }}>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:6,
                        color:'#3a5a7a', marginBottom:2 }}>{label}</div>
                      <div style={{ fontFamily:'Sora,sans-serif', fontSize:10,
                        fontWeight:600, color:'#b0c4d8' }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Action buttons */}
                <div style={{ display:'flex', gap:6 }}>
                  <a href={`https://explorer.mainnet.x1.xyz/address/${nft.mint}`}
                    target="_blank" rel="noopener noreferrer" style={{
                      flex:1, padding:'9px 0', textAlign:'center',
                      background:'rgba(191,90,242,.12)',
                      border:'1px solid rgba(191,90,242,.35)', borderRadius:8,
                      fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                      color:'#bf5af2', textDecoration:'none',
                      display:'flex', alignItems:'center', justifyContent:'center', gap:4,
                    }}>🔍 EXPLORER ↗</a>
                  {externalUrl && (
                    <a href={externalUrl} target="_blank" rel="noopener noreferrer" style={{
                      flex:1, padding:'9px 0', textAlign:'center',
                      background:'rgba(255,255,255,.03)',
                      border:'1px solid rgba(255,255,255,.08)', borderRadius:8,
                      fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                      color:'#7a9ab8', textDecoration:'none',
                      display:'flex', alignItems:'center', justifyContent:'center', gap:4,
                    }}>🌐 WEBSITE ↗</a>
                  )}
                </div>
              </div>
            </div>
          )

          /* ═══════════════════════════════════════
             DESKTOP LAYOUT — two column, no scroll
             ═══════════════════════════════════════ */
          : (
            <div style={{ display:'flex', flexDirection:'row', gap:0 }}>

              {/* Left: square image */}
              <div style={{ position:'relative', width:220, flexShrink:0,
                background:'#050a0f', borderRadius:'15px 0 0 15px', overflow:'hidden' }}>
                <NFTImage metaUri={metaUri} name={nft.name} contain />
                <div style={{ position:'absolute', top:10, left:10,
                  background:'rgba(0,0,0,.75)', border:'1px solid rgba(191,90,242,.5)',
                  borderRadius:4, padding:'2px 8px',
                  fontFamily:'Orbitron,monospace', fontSize:8, color:'#bf5af2', fontWeight:700 }}>
                  NFT
                </div>
                {rarity && (
                  <div style={{ position:'absolute', bottom:10, left:10,
                    background:'rgba(0,0,0,.8)', backdropFilter:'blur(6px)',
                    border:`1px solid ${rarityColor(rarity)}55`,
                    borderRadius:6, padding:'3px 10px',
                    fontFamily:'Orbitron,monospace', fontSize:8,
                    color:rarityColor(rarity), fontWeight:700, letterSpacing:1 }}>
                    ✦ {rarity.toUpperCase()}
                  </div>
                )}
              </div>

              {/* Right: all info, no scroll */}
              <div style={{ flex:1, padding:'14px 16px 14px', display:'flex',
                flexDirection:'column', gap:8, minWidth:0 }}>

                {/* Name + badges */}
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:15, fontWeight:900,
                    color:'#fff', marginBottom:5, lineHeight:1.2,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {nft.name}
                  </div>
                  <div style={{ display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
                    {collection && <span style={{ fontSize:10, color:'#6a8aaa', fontFamily:'Sora,sans-serif' }}>{collection}</span>}
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                      background:'rgba(191,90,242,.12)', border:'1px solid rgba(191,90,242,.25)',
                      padding:'1px 6px', borderRadius:3 }}>{nft.symbol}</span>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#5a7a9a',
                      background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.07)',
                      padding:'1px 6px', borderRadius:3 }}>{(nft.metaSource??'').toUpperCase()}</span>
                  </div>
                </div>

                {/* Description — 1 truncated line */}
                {shortDesc && (
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize:10,
                    color:'#6a8aaa', lineHeight:1.5 }}>{shortDesc}</div>
                )}

                {/* Traits — wrapping pills */}
                {attrs.length > 0 && (
                  <div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:6,
                      color:'#3a5a7a', letterSpacing:1.5, marginBottom:5 }}>
                      TRAITS — {attrs.length}
                    </div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                      {attrs.map((a, i) => {
                        const isRarity = a.trait_type?.toLowerCase() === 'rarity';
                        const col = isRarity ? rarityColor(a.value) : '#bf5af2';
                        return (
                          <div key={i} style={{
                            background:'rgba(191,90,242,.05)',
                            border:`1px solid ${isRarity ? col+'44' : 'rgba(191,90,242,.15)'}`,
                            borderRadius:5, padding:'3px 7px',
                          }}>
                            <span style={{ fontFamily:'Orbitron,monospace', fontSize:6,
                              color:'#3a5a7a', marginRight:4 }}>{a.trait_type}:</span>
                            <span style={{ fontFamily:'Sora,sans-serif', fontSize:9,
                              fontWeight:600, color: isRarity ? col : '#b8cce0' }}>{a.value}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Mint address */}
                <div style={{ display:'flex', alignItems:'center', gap:6,
                  background:'rgba(255,255,255,.025)', borderRadius:7,
                  border:'1px solid rgba(255,255,255,.05)', padding:'5px 8px' }}>
                  <code style={{ fontFamily:'monospace', fontSize:9, color:'#5a8aaa',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1 }}>
                    {nft.mint.slice(0,10)}…{nft.mint.slice(-8)}
                  </code>
                  <button onClick={() => onCopy(nft.mint)} style={{
                    flexShrink:0, padding:'3px 8px', borderRadius:4, cursor:'pointer',
                    background: copiedAddress===nft.mint ? 'rgba(0,201,141,.18)' : 'rgba(191,90,242,.1)',
                    border:`1px solid ${copiedAddress===nft.mint ? 'rgba(0,201,141,.4)' : 'rgba(191,90,242,.3)'}`,
                    color: copiedAddress===nft.mint ? '#00c98d' : '#bf5af2',
                    fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700,
                  }}>
                    {copiedAddress===nft.mint ? '✓ COPIED' : 'COPY'}
                  </button>
                </div>

                {/* Chain details — 4 col */}
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:5 }}>
                  {[
                    { label:'CHAIN',    value:'X1' },
                    { label:'STANDARD', value: nft.isToken2022 ? 'T-2022' : 'SPL' },
                    { label:'DECIMALS', value: String(nft.decimals) },
                    { label:'BALANCE',  value: String(nft.balance) },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background:'rgba(255,255,255,.02)',
                      borderRadius:5, border:'1px solid rgba(255,255,255,.05)',
                      padding:'4px 5px', textAlign:'center' }}>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:6,
                        color:'#3a5a7a', marginBottom:2 }}>{label}</div>
                      <div style={{ fontFamily:'Sora,sans-serif', fontSize:10,
                        fontWeight:600, color:'#b0c4d8' }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Buttons */}
                <div style={{ display:'flex', gap:6, marginTop:'auto' }}>
                  <a href={`https://explorer.mainnet.x1.xyz/address/${nft.mint}`}
                    target="_blank" rel="noopener noreferrer" style={{
                      flex:1, padding:'8px 0', textAlign:'center',
                      background:'rgba(191,90,242,.12)',
                      border:'1px solid rgba(191,90,242,.35)', borderRadius:7,
                      fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                      color:'#bf5af2', textDecoration:'none',
                      display:'flex', alignItems:'center', justifyContent:'center', gap:4,
                    }}>🔍 EXPLORER ↗</a>
                  {externalUrl && (
                    <a href={externalUrl} target="_blank" rel="noopener noreferrer" style={{
                      flex:1, padding:'8px 0', textAlign:'center',
                      background:'rgba(255,255,255,.03)',
                      border:'1px solid rgba(255,255,255,.08)', borderRadius:7,
                      fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                      color:'#7a9ab8', textDecoration:'none',
                      display:'flex', alignItems:'center', justifyContent:'center', gap:4,
                    }}>🌐 WEBSITE ↗</a>
                  )}
                </div>

              </div>
            </div>
          )
        }
      </div>
    </div>
  );
  return createPortal(modalContent, document.body);
};

// ─────────────────────────────────────────────
// NFT GRID — exported, used in Portfolio.tsx
// ─────────────────────────────────────────────
export const NFTGrid: FC<{
  nfts: TokenData[];
  isMobile: boolean;
  copiedAddress: string | null;
  onCopy: (a: string) => void;
}> = ({ nfts, isMobile, copiedAddress, onCopy }) => {
  const [selected, setSelected] = useState<TokenData | null>(null);

  return (
    <>
      <div style={{
        display:'grid',
        gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(5,1fr)',
        gap: isMobile ? 6 : 8,
        marginBottom:24,
      }}>
        {nfts.map((nft, i) => {
          const metaUri = (nft as any).metaUri || nft.logoUri;
          return (
            <div key={nft.mint}
              onClick={() => setSelected(nft)}
              style={{
                background:'linear-gradient(135deg,rgba(191,90,242,.07),rgba(191,90,242,.02))',
                border:'1px solid rgba(191,90,242,.18)',
                borderRadius:9, overflow:'hidden', cursor:'pointer',
                animation:`fadeUp 0.35s ease ${0.03*i}s both`,
                transition:'transform 0.14s, box-shadow 0.16s, border-color 0.14s',
              }}
              onMouseEnter={e => {
                const el = e.currentTarget as HTMLDivElement;
                el.style.transform='translateY(-3px)';
                el.style.boxShadow='0 6px 20px rgba(191,90,242,.26)';
                el.style.borderColor='rgba(191,90,242,.48)';
              }}
              onMouseLeave={e => {
                const el = e.currentTarget as HTMLDivElement;
                el.style.transform='translateY(0)';
                el.style.boxShadow='none';
                el.style.borderColor='rgba(191,90,242,.18)';
              }}
            >
              <div style={{ position:'relative', width:'100%', paddingBottom:'100%', background:'#070b12' }}>
                <NFTImage metaUri={metaUri} name={nft.name} />
                <div style={{ position:'absolute', top:3, right:3,
                  background:'rgba(0,0,0,.72)', backdropFilter:'blur(3px)',
                  border:'1px solid rgba(191,90,242,.42)',
                  borderRadius:3, padding:'1px 4px',
                  fontFamily:'Orbitron,monospace', fontSize:6,
                  color:'#bf5af2', fontWeight:700 }}>NFT</div>
              </div>
              <div style={{ padding:'5px 6px 6px' }}>
                <div style={{ fontFamily:'Orbitron,monospace',
                  fontSize: isMobile ? 7 : 8, fontWeight:700, color:'#bf5af2',
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                  marginBottom:1 }}>{nft.name}</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:6,
                  color:'rgba(191,90,242,.35)' }}>TAP TO VIEW</div>
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <NFTModal
          nft={selected} isMobile={isMobile}
          onClose={() => setSelected(null)}
          onCopy={onCopy} copiedAddress={copiedAddress}
        />
      )}
    </>
  );
};