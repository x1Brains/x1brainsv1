import React, { FC, useState, useEffect, useRef, useCallback } from 'react';
import { XNT_WRAPPED, XDEX_API } from '../constants';

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────
export interface TokenData {
  mint: string;
  name: string;
  symbol: string;
  balance: number;
  decimals: number;
  logoUri?: string;   // resolved image URL (or metadata JSON URL as fallback)
  metaUri?: string;   // raw off-chain metadata JSON URI — used by NFTImage to fetch image
  isToken2022: boolean;
  metaSource?: 'token2022ext' | 'metaplex' | 'xdex' | 'fallback';
}

export interface WalletTokenSnapshot {
  mint:     string;
  symbol:   string;
  name:     string;
  balance:  number;
  logoUri?: string;
}

export const KNOWN_TOKENS: Record<string, { name: string; symbol: string }> = {};

// ─────────────────────────────────────────────
// GLOBAL PRICE CACHE
// Shared across all card instances so we don't
// fire duplicate requests for the same mint.
// ─────────────────────────────────────────────
export const priceCache  = new Map<string, number | null>(); // null = confirmed no price
const priceWaiters = new Map<string, Array<() => void>>(); // callbacks waiting on a fetch

async function fetchSinglePrice(mint: string): Promise<void> {
  // Already cached
  if (priceCache.has(mint)) return;

  // Already in-flight — queue up and wait
  if (priceWaiters.has(mint)) {
    return new Promise(resolve => priceWaiters.get(mint)!.push(resolve));
  }

  // Start fetch
  priceWaiters.set(mint, []);
  try {
    const url = `/api/xdex-price/api/token-price/prices?network=X1%20Mainnet&token_addresses=${mint}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) { priceCache.set(mint, null); return; }

    const data = await res.json();
    console.log('[XDex Price] raw for', mint.slice(0,8), JSON.stringify(data).slice(0, 300));

    let price: number | null = null;

    if (data?.success === true && Array.isArray(data?.data)) {
      const item = data.data.find((i: any) => i?.token_address === mint);
      if (item?.price != null && Number.isFinite(Number(item.price)) && Number(item.price) > 0) {
        price = Number(item.price);
      }
    }
    else if (Array.isArray(data)) {
      const item = data.find((i: any) => (i?.token_address ?? i?.mint ?? i?.address) === mint);
      if (item?.price != null && Number.isFinite(Number(item.price)) && Number(item.price) > 0) {
        price = Number(item.price);
      }
    }
    else if (typeof data?.[mint] === 'number') {
      price = data[mint] > 0 ? data[mint] : null;
    }
    else if (data?.[mint] && typeof data[mint] === 'object') {
      const raw = data[mint]?.price ?? data[mint]?.usd ?? data[mint]?.value ?? null;
      price = raw != null && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
    }

    console.log('[XDex Price] parsed for', mint.slice(0,8), price);
    priceCache.set(mint, price);
  } catch (err) {
    console.warn('[XDex Price] fetch failed for', mint.slice(0,8), err);
    priceCache.set(mint, null);
  } finally {
    const waiters = priceWaiters.get(mint) ?? [];
    priceWaiters.delete(mint);
    waiters.forEach(fn => fn());
  }
}

// ─────────────────────────────────────────────
// usePrice — self-contained hook per card
// ─────────────────────────────────────────────
function usePrice(mint: string): number | null | undefined {
  const [price, setPrice] = useState<number | null | undefined>(() =>
    priceCache.has(mint) ? priceCache.get(mint) : undefined
  );
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (priceCache.has(mint)) {
      setPrice(priceCache.get(mint));
      return;
    }
    fetchSinglePrice(mint).then(() => {
      if (mounted.current) setPrice(priceCache.get(mint) ?? null);
    });
    return () => { mounted.current = false; };
  }, [mint]);

  return price;
}

// ─────────────────────────────────────────────
// FORMATTERS
// ─────────────────────────────────────────────
function fmtUSD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(2)}K`;
  if (v >= 1)         return `$${v.toFixed(2)}`;
  if (v >= 0.0001)    return `$${v.toFixed(4)}`;
  return `<$0.0001`;
}
function fmtPrice(p: number): string {
  if (p >= 1)       return `$${p.toFixed(4)}`;
  if (p >= 0.001)   return `$${p.toFixed(4)}`;
  if (p >= 0.000001)return `$${p.toFixed(6)}`;
  return `$${p.toFixed(8)}`;
}

// ─────────────────────────────────────────────
// USD ROW
// ─────────────────────────────────────────────
const USDRow: FC<{ mint: string; balance: number }> = ({ mint, balance }) => {
  const priceMint = mint === 'native-xnt' ? XNT_WRAPPED : mint;
  const price     = usePrice(priceMint);
  const usd       = price != null && balance > 0 ? price * balance : null;

  if (price === undefined) {
    return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:3, marginTop:2 }}>
        <div style={{ width:60, height:11, borderRadius:4, background:'rgba(0,201,141,.08)', animation:'usd-pulse 1.4s ease infinite' }} />
        <div style={{ width:44, height:8,  borderRadius:3, background:'rgba(255,255,255,.04)', animation:'usd-pulse 1.4s ease .3s infinite' }} />
      </div>
    );
  }

  if (price === null || usd === null) return null;

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:2, marginTop:2 }}>
      <div style={{
        fontFamily:'Orbitron, monospace', fontSize:13, fontWeight:700,
        color:'#00c98d', letterSpacing:0.5,
        textShadow:'0 0 8px rgba(0,201,141,.35)',
      }}>
        {fmtUSD(usd)}
      </div>
      <div style={{ fontFamily:'Sora, sans-serif', fontSize:9, color:'#3a6050', letterSpacing:0.3 }}>
        {fmtPrice(price)} / token
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// LP POOL INFO
// ─────────────────────────────────────────────
interface LPPoolInfo {
  pairName: string; token1Symbol: string; token2Symbol: string;
  poolAddress: string; tvl?: number; apy?: number;
}
const lpInfoCache = new Map<string, Promise<LPPoolInfo | null>>();
let poolListPromise: Promise<any[]> | null = null;

function getPoolList(): Promise<any[]> {
  if (!poolListPromise) {
    poolListPromise = fetch(`${XDEX_API}/api/xendex/pool/list?network=mainnet`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!d) return []; return Array.isArray(d) ? d : (d?.data ?? d?.pools ?? d?.list ?? d?.result ?? []); })
      .catch(() => []);
  }
  return poolListPromise;
}

function parsePair(name: string, symbol: string): { t1: string; t2: string } | null {
  const clean = (s: string) => s.replace(/\b(LP|Pool|Liquidity|lp|pool|token)\b/gi, '').trim();
  for (const src of [name, symbol]) {
    const parts = clean(src).split(/[\/\-_\s]+/).filter(s => s.length > 0 && s.length <= 12);
    if (parts.length >= 2) return { t1: parts[0].toUpperCase(), t2: parts[1].toUpperCase() };
  }
  return null;
}

async function fetchLPInfoOnce(lpMint: string, name: string, symbol: string): Promise<LPPoolInfo | null> {
  try {
    const pools = await getPoolList();
    const pool  = pools.find((p: any) => {
      const lp = p.lp_mint ?? p.lpMint ?? p.lp_token ?? p.lpToken ?? p.lp_address ?? p.lpAddress ?? p.mint ?? p.token_mint;
      return lp === lpMint;
    });
    if (pool) {
      const t1 = (pool.token1_symbol ?? pool.tokenA_symbol ?? pool.symbol_a ?? pool.token1?.symbol ?? pool.base_symbol ?? pool.token_a_symbol ?? '').toUpperCase();
      const t2 = (pool.token2_symbol ?? pool.tokenB_symbol ?? pool.symbol_b ?? pool.token2?.symbol ?? pool.quote_symbol ?? pool.token_b_symbol ?? '').toUpperCase();
      if (t1 || t2) {
        const poolAddr = pool.pool_address ?? pool.poolAddress ?? pool.address ?? pool.id ?? '';
        const tvl = pool.tvl ?? pool.total_liquidity ?? pool.liquidity;
        const apy = pool.apy ?? pool.apr ?? pool.yield ?? pool.fee_apr;
        return { pairName:`${t1||'?'} / ${t2||'?'}`, token1Symbol:t1||'?', token2Symbol:t2||'?', poolAddress:poolAddr,
          tvl: tvl !== undefined ? parseFloat(String(tvl)) : undefined,
          apy: apy !== undefined ? parseFloat(String(apy)) : undefined };
      }
    }
  } catch { }
  const pair = parsePair(name, symbol);
  if (pair) return { pairName:`${pair.t1} / ${pair.t2}`, token1Symbol:pair.t1, token2Symbol:pair.t2, poolAddress:'' };
  const s = (symbol || name || 'LP').toUpperCase();
  return { pairName:s, token1Symbol:s.charAt(0), token2Symbol:s.charAt(1)||'?', poolAddress:'' };
}

export function fetchLPInfo(lpMint: string, name: string, symbol: string): Promise<LPPoolInfo | null> {
  if (!lpInfoCache.has(lpMint)) lpInfoCache.set(lpMint, fetchLPInfoOnce(lpMint, name, symbol));
  return lpInfoCache.get(lpMint)!;
}

// ─────────────────────────────────────────────
// TOKEN LOGO
// ─────────────────────────────────────────────
export const TokenLogo: FC<{ token: TokenData; size?: number }> = ({ token, size = 52 }) => {
  const [failed, setFailed] = useState(false);
  const [retried, setRetried] = useState(false);
  const [src, setSrc] = useState(token.logoUri || '');

  // Reset state when token changes
  useEffect(() => {
    setSrc(token.logoUri || '');
    setFailed(false);
    setRetried(false);
  }, [token.logoUri, token.mint]);

  const handleError = () => {
    if (!retried && src) {
      // Retry with CORS proxy for localhost
      setRetried(true);
      const isLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
      if (isLocal) {
        // Try corsproxy.io as fallback for CORS-blocked images on localhost
        const proxied = `https://corsproxy.io/?${encodeURIComponent(src)}`;
        setSrc(proxied);
        return;
      }
    }
    setFailed(true);
  };

  if (src && !failed) {
    return (
      <img src={src} alt={token.symbol} crossOrigin="anonymous"
        onError={handleError}
        style={{ width:size, height:size, borderRadius:'50%', objectFit:'cover',
          border:'2px solid rgba(255,140,0,0.35)', flexShrink:0, background:'#111820' }} />
    );
  }
  const colors = ['#ff8c00','#ffb700','#00d4ff','#00c98d','#bf5af2'];
  const ci = (token.symbol?.charCodeAt(0) ?? 65) % colors.length;
  return (
    <div style={{ width:size, height:size, borderRadius:'50%',
      background:`linear-gradient(135deg,${colors[ci]},${colors[(ci+2)%colors.length]})`,
      display:'flex', alignItems:'center', justifyContent:'center',
      color:'#0a0e14', fontWeight:800, fontSize:size*0.38,
      fontFamily:'Orbitron, monospace', flexShrink:0,
      border:'2px solid rgba(255,140,0,0.2)' }}>
      {(token.symbol ?? '?').charAt(0).toUpperCase()}
    </div>
  );
};

// ─────────────────────────────────────────────
// META BADGE
// ─────────────────────────────────────────────
export const MetaBadge: FC<{ source?: string }> = ({ source }) => {
  if (!source) return null;
  const cfg: Record<string, { label: string; color: string }> = {
    token2022ext: { label:'T-2022 EXT', color:'#ffb700' },
    metaplex:     { label:'METAPLEX',   color:'#00d4ff' },
    xdex:         { label:'XDEX',       color:'#ff8c00' },
    fallback:     { label:'UNKNOWN',    color:'#6b7f90' },
  };
  const c = cfg[source] ?? cfg.fallback;
  return (
    <span style={{ fontSize:9, fontFamily:'Orbitron, monospace', fontWeight:700,
      color:c.color, background:`${c.color}18`, border:`1px solid ${c.color}35`,
      padding:'2px 6px', borderRadius:4, letterSpacing:1 }}>
      {c.label}
    </span>
  );
};

// ─────────────────────────────────────────────
// TOKEN CARD
// ─────────────────────────────────────────────
export const TokenCard: FC<{
  token: TokenData;
  highlight?: 'native' | 'brains';
  copiedAddress: string | null;
  onCopy: (addr: string) => void;
  animDelay?: number;
  isLP?: boolean;
  usdPrice?: number | null;
}> = ({ token, highlight, copiedAddress, onCopy, animDelay = 0, isLP = false }) => {
  const [lpInfo, setLpInfo] = useState<LPPoolInfo | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const override        = KNOWN_TOKENS[token.mint];
  const displayedName   = override?.name   ?? token.name;
  const displayedSymbol = override?.symbol ?? token.symbol;

  useEffect(() => {
    if (!isLP) return;
    fetchLPInfo(token.mint, token.name, token.symbol).then(lp => { if (!mounted.current) return; if (lp) setLpInfo(lp); });
  }, [token.mint, isLP]);

  const borderColor =
    highlight === 'native' ? '#00d4ff' :
    highlight === 'brains' ? '#ff8c00' :
    isLP                   ? '#00c98d' :
    token.isToken2022      ? '#ffb700' : '#1e3050';

  const bgGradient =
    highlight === 'native' ? 'linear-gradient(135deg,rgba(0,212,255,0.07),rgba(0,212,255,0.02))' :
    highlight === 'brains' ? 'linear-gradient(135deg,rgba(255,140,0,0.10),rgba(255,183,0,0.04))' :
    isLP                   ? 'linear-gradient(135deg,rgba(0,201,141,0.08),rgba(0,201,141,0.02))' :
    token.isToken2022      ? 'linear-gradient(135deg,rgba(255,183,0,0.06),rgba(255,140,0,0.02))' :
    'linear-gradient(135deg,#111820,#0d1520)';

  const accentColor =
    highlight === 'native' ? '#00d4ff' :
    highlight === 'brains' ? '#ff8c00' :
    isLP                   ? '#00c98d' :
    token.isToken2022      ? '#ffb700' : '#dce8f4';

  const cardSymbol = isLP ? (lpInfo ? `${lpInfo.token1Symbol} / ${lpInfo.token2Symbol}` : displayedSymbol) : displayedSymbol;
  const cardName   = isLP ? (lpInfo ? `${lpInfo.pairName} Liquidity Pool` : displayedName) : displayedName;

  const priceMint = token.mint === XNT_WRAPPED && highlight === 'native' ? 'native-xnt' : token.mint;

  return (
    <div
      style={{ background:bgGradient, border:`1px solid ${borderColor}`, borderRadius:14,
        padding:'18px 20px', marginBottom:12,
        animation:`fadeUp 0.4s ease ${animDelay}s both`,
        transition:'transform 0.15s, box-shadow 0.2s',
        position:'relative', overflow:'hidden' }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.transform='translateX(4px)'; el.style.boxShadow=`0 0 24px ${borderColor}28`; }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.transform='translateX(0)'; el.style.boxShadow='none'; }}
    >
      <div style={{ position:'absolute', top:0, left:0, width:4, height:'100%',
        background:borderColor, opacity:highlight ? 1 : 0.65, borderRadius:'4px 0 0 4px' }} />

      <div style={{ display:'flex', alignItems:'center', gap:16, paddingLeft:10 }}>

        {/* LOGO */}
        {isLP ? (
          <div style={{ position:'relative', width:58, height:58, flexShrink:0 }}>
            <div style={{ position:'absolute', top:0, left:0, width:38, height:38, borderRadius:'50%',
              background:'linear-gradient(135deg,#00c98d,#00a572)', display:'flex', alignItems:'center',
              justifyContent:'center', fontFamily:'Orbitron, monospace', fontSize:14, fontWeight:800,
              color:'#0a0e14', border:'2px solid #080c0f', zIndex:2 }}>
              {(lpInfo?.token1Symbol ?? displayedSymbol).charAt(0).toUpperCase()}
            </div>
            <div style={{ position:'absolute', bottom:0, right:0, width:38, height:38, borderRadius:'50%',
              background:'linear-gradient(135deg,#00d4ff,#0090bb)', display:'flex', alignItems:'center',
              justifyContent:'center', fontFamily:'Orbitron, monospace', fontSize:14, fontWeight:800,
              color:'#0a0e14', border:'2px solid #080c0f', zIndex:1 }}>
              {lpInfo ? lpInfo.token2Symbol.charAt(0).toUpperCase() : (displayedSymbol.charAt(1)||'?').toUpperCase()}
            </div>
          </div>
        ) : (
          <TokenLogo token={{ ...token, symbol:displayedSymbol }} size={52} />
        )}

        {/* CENTER INFO */}
        <div style={{ flex:1, minWidth:0 }}>

          <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:3, flexWrap:'wrap' }}>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:17, fontWeight:700, color:accentColor }}>
              {cardSymbol}
            </span>
            {isLP && (
              <span style={{ fontSize:9, fontWeight:700, fontFamily:'Orbitron, monospace',
                color:'#00c98d', background:'rgba(0,201,141,0.12)', border:'1px solid rgba(0,201,141,0.35)',
                padding:'2px 7px', borderRadius:4, letterSpacing:1 }}>LP TOKEN</span>
            )}
            {token.isToken2022 && !isLP && !highlight && (
              <span style={{ fontSize:9, fontWeight:700, fontFamily:'Orbitron, monospace',
                color:'#ffb700', background:'rgba(255,183,0,0.1)', border:'1px solid rgba(255,183,0,0.3)',
                padding:'2px 6px', borderRadius:4, letterSpacing:1 }}>T-2022</span>
            )}
            {highlight === 'native' && (
              <span style={{ fontSize:9, fontWeight:700, fontFamily:'Orbitron, monospace',
                color:'#00c98d', background:'rgba(0,201,141,0.1)', border:'1px solid rgba(0,201,141,0.3)',
                padding:'2px 6px', borderRadius:4, letterSpacing:1 }}>X1 NATIVE</span>
            )}
            {!isLP && <MetaBadge source={token.metaSource} />}
          </div>

          <div style={{ fontSize:13, color:'#6a8ea8', marginBottom:6,
            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {cardName}
          </div>

          {isLP && (
            <div style={{ display:'flex', flexWrap:'wrap', gap:10, alignItems:'center', marginBottom:6 }}>
              {lpInfo?.tvl !== undefined && !isNaN(lpInfo.tvl) && lpInfo.tvl > 0 && (
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:'#5c7a90' }}>
                  TVL: <span style={{ color:'#00c98d' }}>${lpInfo.tvl.toLocaleString(undefined,{maximumFractionDigits:0})}</span>
                </span>
              )}
              {lpInfo?.apy !== undefined && !isNaN(lpInfo.apy) && lpInfo.apy > 0 && (
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:'#5c7a90' }}>
                  APY: <span style={{ color:'#ffb700' }}>{lpInfo.apy.toFixed(1)}%</span>
                </span>
              )}
              {lpInfo?.poolAddress ? (
                <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#3a5070' }}>POOL</span>
                  <span style={{ fontFamily:'Sora, monospace', fontSize:11, color:'#4a6070' }}>
                    {lpInfo.poolAddress.slice(0,8)}…{lpInfo.poolAddress.slice(-4)}
                  </span>
                  <button onClick={() => onCopy(lpInfo!.poolAddress)}
                    style={{ background:copiedAddress===lpInfo.poolAddress?'rgba(0,201,141,0.2)':'rgba(0,212,255,0.08)',
                      border:`1px solid ${copiedAddress===lpInfo.poolAddress?'rgba(0,201,141,0.4)':'rgba(0,212,255,0.2)'}`,
                      color:copiedAddress===lpInfo.poolAddress?'#00c98d':'#00d4ff',
                      padding:'2px 7px', borderRadius:4, cursor:'pointer', fontSize:9, fontFamily:'Orbitron, monospace' }}>
                    {copiedAddress===lpInfo.poolAddress?'✓':'COPY'}
                  </button>
                </div>
              ) : (
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#2a4060', letterSpacing:1 }}>LP PAIR</span>
              )}
            </div>
          )}

          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ fontFamily:'Sora, monospace', fontSize:11, color:'#3a5070' }}>
              {token.mint.slice(0,8)}…{token.mint.slice(-4)}
            </span>
            <button onClick={() => onCopy(token.mint)}
              style={{ background:copiedAddress===token.mint?'rgba(0,201,141,0.2)':'rgba(255,140,0,0.1)',
                border:`1px solid ${copiedAddress===token.mint?'rgba(0,201,141,0.4)':'rgba(255,140,0,0.22)'}`,
                color:copiedAddress===token.mint?'#00c98d':'#ff8c00',
                padding:'2px 7px', borderRadius:4, cursor:'pointer',
                fontSize:10, fontFamily:'Orbitron, monospace', transition:'all 0.2s' }}>
              {copiedAddress===token.mint?'✓':'COPY'}
            </button>
          </div>
        </div>

        {/* RIGHT: BALANCE + USD */}
        <div style={{ textAlign:'right', flexShrink:0,
          display:'flex', flexDirection:'column', alignItems:'flex-end',
          gap:4, minWidth:110 }}>

          <div style={{ fontFamily:'Orbitron, monospace', fontWeight:700, color:accentColor, lineHeight:1.1,
            fontSize:token.balance >= 10_000_000 ? 14 : token.balance >= 10_000 ? 18 : 22 }}>
            {token.balance.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: Math.min(token.decimals, 4),
            })}
          </div>

          <div style={{ fontSize:10, color:'#3a5070', fontFamily:'Orbitron, monospace', letterSpacing:1 }}>
            {token.decimals} DEC
          </div>

          {!isLP && <USDRow mint={priceMint} balance={token.balance} />}

        </div>
      </div>

      <style>{`
        @keyframes usd-pulse {
          0%,100%{opacity:.2} 50%{opacity:.5}
        }
      `}</style>
    </div>
  );
};

// ─────────────────────────────────────────────
// XENBLOCKS PANEL
// ─────────────────────────────────────────────
export { XenBlocksPanel } from './XenBlocksPanel';

// Keep useTokenPrices exported so Portfolio.tsx import doesn't break
export function useTokenPrices(_mints: string[]): Map<string, number> {
  return new Map();
}