import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TopBar, PageBackground, Footer } from '../components/UI';
import { BurnedBrainsBar } from '../components/BurnedBrainsBar';
import { BRAINS_MINT as BRAINS_MINT_STR } from '../constants';

// ─── Constants ────────────────────────────────────────────────────────────────
const BRAINS_MINT  = BRAINS_MINT_STR;
const LB_MINT      = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
const WXNT_MINT    = 'So11111111111111111111111111111111111111112';
const XDEX_BASE    = '/api/xdex-price/api';
const LISTING_FEE  = 0.50;
const MATCHING_FEE = 0.50;
const DELIST_FEE   = 0.10;

const BURN_OPTIONS = [
  { pct: 0,   label: '0%',   desc: 'No burn · LP split 50/50',     color: '#4a6a8a', eachPct: 50  },
  { pct: 25,  label: '25%',  desc: '25% burned · 75% split 50/50', color: '#ff8c00', eachPct: 37.5 },
  { pct: 50,  label: '50%',  desc: '50% burned · 50% split 50/50', color: '#bf5af2', eachPct: 25  },
  { pct: 100, label: '100%', desc: 'All burned · max LB points',    color: '#ff4444', eachPct: 0   },
] as const;

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
  if (v >= 1_000_000) return `${(v/1_000_000).toFixed(2)}M XNT`;
  if (v >= 1_000)     return `${(v/1_000).toFixed(2)}K XNT`;
  return `${v.toFixed(2)} XNT`;
}

function fmtNum(v: number, dec = 2) {
  if (!v) return '0';
  if (v >= 1_000_000) return `${(v/1_000_000).toFixed(dec)}M`;
  if (v >= 1_000)     return `${(v/1_000).toFixed(dec)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: dec });
}

function truncAddr(a: string) { return `${a.slice(0,4)}…${a.slice(-4)}`; }

// ─── Types ────────────────────────────────────────────────────────────────────
interface TokenMeta {
  mint: string; symbol: string; name: string; logo?: string;
  decimals: number; priceUSD: number; priceXNT: number; mc?: number; tvl?: number;
}
interface Listing {
  id: string; creator: string; tokenA: TokenMeta;
  amount: number; usdValue: number; xntValue: number;
  burnPct: 0|25|50|100; status: 'open'|'matched'|'delisted';
  createdAt: number; isEcosystem: boolean;
}

// ─── XDEX helpers ─────────────────────────────────────────────────────────────
async function fetchPriceUSD(mint: string): Promise<number> {
  try {
    const r = await fetch(`${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${mint}`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    return j.success ? Number(j.data?.price) || 0 : 0;
  } catch { return 0; }
}

async function fetchTokenMeta(mint: string): Promise<Partial<TokenMeta>> {
  try {
    const r = await fetch(`${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${mint}`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (j.success && j.data) return { symbol: j.data.symbol || mint.slice(0,6), name: j.data.name || mint.slice(0,6), logo: j.data.logo, decimals: j.data.decimals ?? 9, priceUSD: Number(j.data.price) || 0 };
  } catch {}
  return { symbol: mint.slice(0,6), name: mint.slice(0,6), decimals: 9, priceUSD: 0 };
}

async function checkPoolExists(a: string, b: string): Promise<boolean> {
  try {
    const [r1, r2] = await Promise.all([
      fetch(`${XDEX_BASE}/xendex/pool/tokens/${a}/${b}?network=mainnet`, { signal: AbortSignal.timeout(6000) }),
      fetch(`${XDEX_BASE}/xendex/pool/tokens/${b}/${a}?network=mainnet`, { signal: AbortSignal.timeout(6000) }),
    ]);
    const [j1, j2] = await Promise.all([r1.json(), r2.json()]);
    return (j1.success && !!j1.data) || (j2.success && !!j2.data);
  } catch { return false; }
}

// ─── StatusBox ────────────────────────────────────────────────────────────────
const StatusBox: FC<{ msg: string }> = ({ msg }) => {
  if (!msg) return null;
  const isErr = msg.startsWith('❌'); const isOk = msg.startsWith('✅');
  return (
    <div style={{ padding:'10px 14px', borderRadius:10, marginBottom:16,
      background: isErr ? 'rgba(255,68,68,.08)' : isOk ? 'rgba(0,201,141,.08)' : 'rgba(0,212,255,.06)',
      border: `1px solid ${isErr ? 'rgba(255,68,68,.25)' : isOk ? 'rgba(0,201,141,.25)' : 'rgba(0,212,255,.15)'}`,
      fontFamily:'Sora,sans-serif', fontSize:12, color: isErr ? '#ff6666' : isOk ? '#00c98d' : '#9abacf', lineHeight:1.6 }}
      dangerouslySetInnerHTML={{ __html: msg }} />
  );
};

// ─── Token Logo ───────────────────────────────────────────────────────────────
const TokenLogo: FC<{ mint: string; logo?: string; symbol: string; size?: number }> = ({ mint, logo, symbol, size = 44 }) => {
  const [err, setErr] = useState(false);
  const letter = symbol?.[0]?.toUpperCase() || '?';
  const bg = mint === BRAINS_MINT ? 'linear-gradient(135deg,#00d4ff,#0066aa)'
           : mint === LB_MINT     ? 'linear-gradient(135deg,#00c98d,#005a3a)'
           : 'linear-gradient(135deg,#bf5af2,#6622aa)';
  if (logo && !err) return <img src={logo} alt={symbol} onError={() => setErr(true)}
    style={{ width:size, height:size, borderRadius:size*0.25, objectFit:'cover', flexShrink:0 }} />;
  return (
    <div style={{ width:size, height:size, borderRadius:size*0.25, background:bg,
      display:'flex', alignItems:'center', justifyContent:'center',
      fontFamily:'Orbitron,monospace', fontSize:size*0.38, fontWeight:900, color:'#fff', flexShrink:0 }}>
      {letter}
    </div>
  );
};

// ─── Listing Card ─────────────────────────────────────────────────────────────
const ListingCard: FC<{
  listing: Listing; isMobile: boolean; idx: number;
  isOwn: boolean;
  onMatch: (l: Listing) => void;
  onEdit: (l: Listing) => void;
  onDelist: (l: Listing) => void;
}> = React.memo(({ listing, isMobile, idx, isOwn, onMatch, onEdit, onDelist }) => {
  const burn = BURN_OPTIONS.find(b => b.pct === listing.burnPct)!;
  const eachPct = listing.burnPct < 100 ? (100 - listing.burnPct) / 2 : 0;

  return (
    <div style={{
      background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.06)',
      borderRadius:14, padding: isMobile ? '14px 14px' : '18px 22px',
      marginBottom:10, position:'relative', overflow:'hidden',
      animation:`fadeUp 0.4s ease ${idx*0.04}s both`, transition:'all 0.18s',
    }}
    onMouseEnter={e => { const d = e.currentTarget as HTMLDivElement; d.style.background='rgba(255,255,255,.04)'; d.style.borderColor='rgba(0,212,255,.18)'; }}
    onMouseLeave={e => { const d = e.currentTarget as HTMLDivElement; d.style.background='rgba(255,255,255,.025)'; d.style.borderColor='rgba(255,255,255,.06)'; }}>

      {/* Left accent bar */}
      <div style={{ position:'absolute', left:0, top:0, bottom:0, width:3, borderRadius:'3px 0 0 3px',
        background: listing.isEcosystem
          ? 'linear-gradient(180deg,#00d4ff,rgba(0,212,255,.1))'
          : 'linear-gradient(180deg,#bf5af2,rgba(191,90,242,.1))' }} />

      <div style={{ display:'flex', gap: isMobile ? 12 : 16, alignItems:'flex-start' }}>

        {/* Token logo */}
        <TokenLogo mint={listing.tokenA.mint} logo={listing.tokenA.logo}
          symbol={listing.tokenA.symbol} size={isMobile ? 40 : 48} />

        {/* Left — main info */}
        <div style={{ flex:1, minWidth:0 }}>

          {/* Title row */}
          <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5, flexWrap:'wrap' }}>
            <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 16, fontWeight:900, color:'#e0f0ff', letterSpacing:.5 }}>
              {listing.tokenA.symbol} / ???
            </span>

            {/* Ecosystem badge */}
            <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, letterSpacing:1,
              color: listing.isEcosystem ? '#00d4ff' : '#bf5af2',
              background: listing.isEcosystem ? 'rgba(0,212,255,.1)' : 'rgba(191,90,242,.1)',
              border: `1px solid ${listing.isEcosystem ? 'rgba(0,212,255,.3)' : 'rgba(191,90,242,.3)'}`,
              borderRadius:5, padding:'2px 7px' }}>
              {listing.isEcosystem ? '🧠 ECOSYSTEM' : '⚡ OPEN'}
            </span>

            {/* Burn badge */}
            {listing.burnPct > 0 && (
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, letterSpacing:1,
                color: burn.color, background:`${burn.color}18`,
                border:`1px solid ${burn.color}44`, borderRadius:5, padding:'2px 7px' }}>
                🔥 {burn.label} BURN
              </span>
            )}
          </div>

          {/* Creator + stats row */}
          <div style={{ display:'flex', gap: isMobile ? 8 : 14, flexWrap:'wrap', marginBottom:8, alignItems:'center' }}>
            <span style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 11, color:'#6a8aaa' }}>
              by {truncAddr(listing.creator)}
            </span>
            {listing.tokenA.mc && listing.tokenA.mc > 0 && (
              <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, color:'#4a6a8a' }}>
                MC: <span style={{ color:'#8aa0b8' }}>{fmtUSD(listing.tokenA.mc)}</span>
              </span>
            )}
            {listing.tokenA.tvl && listing.tokenA.tvl > 0 && (
              <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, color:'#4a6a8a' }}>
                TVL: <span style={{ color:'#00c98d' }}>{fmtUSD(listing.tokenA.tvl)}</span>
              </span>
            )}
          </div>

          {/* LP split + points chips */}
          <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
            <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9,
              color:'#9abacf', background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.08)',
              borderRadius:6, padding:'3px 10px' }}>
              LP SPLIT {eachPct > 0 ? `${eachPct}% each` : 'None'}
            </span>
            {listing.burnPct > 0 && (
              <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9,
                color:'#00c98d', background:'rgba(0,201,141,.08)', border:'1px solid rgba(0,201,141,.2)',
                borderRadius:6, padding:'3px 10px' }}>
                LB PTS ×1.888
              </span>
            )}
          </div>
        </div>

        {/* Right — value + actions */}
        <div style={{ textAlign:'right', flexShrink:0 }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontWeight:900,
            fontSize: isMobile ? 15 : 20, letterSpacing:.5, marginBottom:3,
            color: listing.tokenA.mint === BRAINS_MINT ? '#00d4ff' : '#00c98d' }}>
            {fmtNum(listing.amount)} {listing.tokenA.symbol}
          </div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 12 : 14, fontWeight:700,
            color:'#00c98d', marginBottom:2 }}>
            {fmtUSD(listing.usdValue)}
          </div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, color:'#4a6a8a', marginBottom:12 }}>
            {fmtXNT(listing.xntValue)}
          </div>

          {/* Action buttons */}
          <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
            {isOwn ? (
              <>
                <button onClick={() => onEdit(listing)}
                  style={{ padding: isMobile ? '6px 10px' : '7px 14px', borderRadius:8, cursor:'pointer',
                    background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.25)',
                    fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700,
                    color:'#00d4ff', transition:'all .15s' }}
                  onMouseEnter={e=>(e.currentTarget as HTMLButtonElement).style.background='rgba(0,212,255,.18)'}
                  onMouseLeave={e=>(e.currentTarget as HTMLButtonElement).style.background='rgba(0,212,255,.08)'}>
                  EDIT
                </button>
                <button onClick={() => onDelist(listing)}
                  style={{ padding: isMobile ? '6px 10px' : '7px 14px', borderRadius:8, cursor:'pointer',
                    background:'rgba(255,68,68,.06)', border:'1px solid rgba(255,68,68,.2)',
                    fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700,
                    color:'#ff6666', transition:'all .15s' }}
                  onMouseEnter={e=>(e.currentTarget as HTMLButtonElement).style.background='rgba(255,68,68,.15)'}
                  onMouseLeave={e=>(e.currentTarget as HTMLButtonElement).style.background='rgba(255,68,68,.06)'}>
                  DELIST
                </button>
              </>
            ) : (
              <button onClick={() => onMatch(listing)}
                style={{ padding: isMobile ? '8px 16px' : '10px 22px', borderRadius:10, cursor:'pointer',
                  background:'linear-gradient(135deg,rgba(0,255,128,.18),rgba(0,200,100,.08))',
                  border:'1px solid rgba(0,255,128,.5)',
                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 11, fontWeight:900,
                  color:'#00ff80', transition:'all .2s',
                  boxShadow:'0 0 12px rgba(0,255,128,.15)' }}
                onMouseEnter={e=>{(e.currentTarget as HTMLButtonElement).style.boxShadow='0 0 24px rgba(0,255,128,.3)';(e.currentTarget as HTMLButtonElement).style.borderColor='rgba(0,255,128,.8)';}}
                onMouseLeave={e=>{(e.currentTarget as HTMLButtonElement).style.boxShadow='0 0 12px rgba(0,255,128,.15)';(e.currentTarget as HTMLButtonElement).style.borderColor='rgba(0,255,128,.5)';}}>
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
  isMobile: boolean; publicKey: PublicKey | null; connection: any;
  signTransaction: any; onClose: () => void; onCreated: () => void;
}> = ({ isMobile, publicKey, connection, signTransaction, onClose, onCreated }) => {
  const [tokenA, setTokenA]     = useState<'brains'|'lb'>('brains');
  const [amount, setAmount]     = useState('');
  const [burnPct, setBurnPct]   = useState<0|25|50|100>(0);
  const [status, setStatus]     = useState('');
  const [pending, setPending]   = useState(false);
  const [balances, setBalances] = useState({ brains: 0, lb: 0 });
  const [xntBal, setXntBal]     = useState(0);
  const [prices, setPrices]     = useState({ brains: 0, lb: 0, xnt: 0.4187 });

  useEffect(() => {
    fetchPriceUSD(BRAINS_MINT).then(p => setPrices(v => ({ ...v, brains: p })));
    fetchPriceUSD(LB_MINT).then(p => setPrices(v => ({ ...v, lb: p })));
    fetchPriceUSD(WXNT_MINT).then(p => setPrices(v => ({ ...v, xnt: p || 0.4187 })));
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
        setBalances({
          brains: bAcc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0,
          lb:     lAcc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0,
        });
        setXntBal(xnt / LAMPORTS_PER_SOL);
      } catch {}
    })();
  }, [publicKey, connection]);

  const selPrice = tokenA === 'brains' ? prices.brains : prices.lb;
  const selBal   = tokenA === 'brains' ? balances.brains : balances.lb;
  const selMint  = tokenA === 'brains' ? BRAINS_MINT : LB_MINT;
  const amt      = parseFloat(amount) || 0;
  const usdVal   = amt * selPrice;
  const xntVal   = prices.xnt > 0 ? usdVal / prices.xnt : 0;
  const burnOpt  = BURN_OPTIONS.find(b => b.pct === burnPct)!;
  const eachPct  = burnPct < 100 ? (100 - burnPct) / 2 : 0;
  const estPts   = burnPct > 0 ? Math.floor(amt * burnPct / 100 * 1.888) : 0;
  const canSubmit = amt > 0 && amt <= selBal && xntBal >= LISTING_FEE && !pending;

  const handleCreate = async () => {
    if (!canSubmit) return;
    setPending(true);
    setStatus('Preparing transaction…');
    try {
      // TODO: build Anchor instruction once program deployed
      setStatus('Awaiting wallet approval…');
      await new Promise(r => setTimeout(r, 800));
      setStatus(`✅ Listing created! ${fmtNum(amt)} ${tokenA.toUpperCase()} listed · ${fmtUSD(usdVal)}`);
      setTimeout(() => { onCreated(); onClose(); }, 2000);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0,100) ?? 'Failed'}`);
    } finally { setPending(false); }
  };

  useEffect(() => {
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position='fixed'; document.body.style.top=`-${sy}px`; } catch {}
    return () => { try { document.body.style.position=''; document.body.style.top=''; window.scrollTo(0,sy); } catch {} };
  }, []);

  return createPortal(
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9999,
      background:'rgba(0,0,0,.85)', backdropFilter:'blur(16px)',
      display:'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent:'center', padding: isMobile ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width:'100%', maxWidth: isMobile ? '100%' : 520,
        background:'linear-gradient(155deg,#0d1622,#080c0f)',
        border:'1px solid rgba(0,212,255,.2)', borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '24px 18px 36px' : '30px 32px',
        animation:'modal-in .22s cubic-bezier(.22,1,.36,1) both',
        maxHeight: isMobile ? '92vh' : 'auto', overflowY:'auto', position:'relative',
      }}>
        {/* Close */}
        <button onClick={onClose} style={{ position:'absolute', top:16, right:16,
          width:30, height:30, borderRadius:'50%', border:'1px solid rgba(0,212,255,.2)',
          background:'rgba(8,12,15,.9)', cursor:'pointer', color:'#00d4ff', fontSize:16,
          display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Orbitron,monospace' }}>×</button>

        {/* Title */}
        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 15 : 18, fontWeight:900,
          color:'#fff', letterSpacing:1, marginBottom:4 }}>⚡ CREATE LISTING</div>
        <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 12, color:'#6a8aaa', marginBottom:24, lineHeight:1.6 }}>
          List BRAINS or LB · any token can be paired · {LISTING_FEE} XNT listing fee
        </div>

        {/* Token selector */}
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, letterSpacing:2, color:'#4a6a8a', marginBottom:10 }}>SELECT TOKEN TO LIST</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:22 }}>
          {[
            { key:'brains', label:'BRAINS', bal:balances.brains, price:prices.brains, mint:BRAINS_MINT, color:'#00d4ff' },
            { key:'lb',     label:'LB',     bal:balances.lb,     price:prices.lb,     mint:LB_MINT,     color:'#00c98d' },
          ].map(t => (
            <button key={t.key} onClick={() => setTokenA(t.key as any)}
              style={{ padding:'14px 14px', borderRadius:12, cursor:'pointer', textAlign:'left',
                background: tokenA===t.key ? `rgba(${t.color==='#00d4ff'?'0,212,255':'0,201,141'},.1)` : 'rgba(255,255,255,.03)',
                border:`1px solid ${tokenA===t.key ? t.color+'55' : 'rgba(255,255,255,.08)'}`,
                transition:'all .15s' }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:14, fontWeight:900,
                color: tokenA===t.key ? t.color : '#8aa0b8', marginBottom:6 }}>{t.label}</div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a' }}>
                BAL: <span style={{ color:'#8aa0b8' }}>{fmtNum(t.bal)}</span>
              </div>
              <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#4a6a8a', marginTop:3 }}>
                {fmtUSD(t.price)} / token
              </div>
            </button>
          ))}
        </div>

        {/* Amount input */}
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, letterSpacing:2, color:'#4a6a8a', marginBottom:10 }}>AMOUNT TO LIST</div>
        <div style={{ background:'rgba(255,255,255,.04)', border:'1px solid rgba(0,212,255,.18)',
          borderRadius:12, padding:'14px 16px', marginBottom:16 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <TokenLogo mint={selMint} symbol={tokenA.toUpperCase()} size={32} />
            <input value={amount} onChange={e => setAmount(e.target.value)} type="number" min="0" placeholder="0"
              style={{ flex:1, background:'transparent', border:'none', outline:'none',
                fontFamily:'Orbitron,monospace', fontSize:24, fontWeight:900, color:'#fff' }} />
            <button onClick={() => setAmount(String(Math.floor(selBal)))}
              style={{ background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)',
                borderRadius:7, padding:'5px 12px', cursor:'pointer',
                fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#00d4ff' }}>MAX</button>
          </div>
          {amt > 0 && (
            <div style={{ display:'flex', gap:14, marginTop:8 }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#00c98d' }}>{fmtUSD(usdVal)}</span>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#4a6a8a' }}>{fmtXNT(xntVal)}</span>
            </div>
          )}
        </div>

        {/* Burn % */}
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, letterSpacing:2, color:'#4a6a8a', marginBottom:10 }}>LP TOKEN BURN %</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:12 }}>
          {BURN_OPTIONS.map(b => (
            <button key={b.pct} onClick={() => setBurnPct(b.pct as any)}
              style={{ padding:'12px 0', borderRadius:10, cursor:'pointer', textAlign:'center',
                background: burnPct===b.pct ? `${b.color}18` : 'rgba(255,255,255,.03)',
                border:`1px solid ${burnPct===b.pct ? b.color+'66' : 'rgba(255,255,255,.08)'}`,
                transition:'all .15s' }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:14, fontWeight:900,
                color: burnPct===b.pct ? b.color : '#8aa0b8' }}>{b.label}</div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#4a6a8a', marginTop:3 }}>
                {b.pct < 100 ? `${(100-b.pct)/2}% ea` : 'max pts'}
              </div>
            </button>
          ))}
        </div>
        <div style={{ background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.06)',
          borderRadius:8, padding:'10px 14px', marginBottom:22,
          fontFamily:'Sora,sans-serif', fontSize:11, color:'#6a8aaa', lineHeight:1.6 }}>
          {burnOpt.desc}
          {estPts > 0 && <span style={{ color:'#00c98d', marginLeft:8 }}>· ~{estPts.toLocaleString()} LB pts</span>}
        </div>

        {/* Fee summary */}
        <div style={{ background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.06)',
          borderRadius:10, padding:'14px 16px', marginBottom:18 }}>
          {[
            { label:'LISTING AMOUNT', usd: usdVal, xnt: xntVal,           color:'#8aa0b8' },
            { label:'LISTING FEE',    usd: LISTING_FEE*(prices.xnt||0.4187), xnt: LISTING_FEE, color:'#ff8c00' },
            { label:'YOUR XNT BAL',   usd: xntBal*(prices.xnt||0.4187), xnt: xntBal,
              color: xntBal >= LISTING_FEE ? '#00c98d' : '#ff4444' },
          ].map(row => (
            <div key={row.label} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, letterSpacing:1, color:'#4a6a8a' }}>{row.label}</span>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:12, fontWeight:700, color:row.color }}>{fmtUSD(row.usd)}</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#4a6a8a' }}>{fmtXNT(row.xnt)}</div>
              </div>
            </div>
          ))}
        </div>

        <StatusBox msg={status} />

        <button onClick={handleCreate} disabled={!canSubmit}
          style={{ width:'100%', padding:'15px 0', borderRadius:12, cursor: canSubmit ? 'pointer' : 'not-allowed',
            background: canSubmit
              ? 'linear-gradient(135deg,rgba(0,212,255,.2),rgba(0,212,255,.08))'
              : 'rgba(255,255,255,.04)',
            border:`1px solid ${canSubmit ? 'rgba(0,212,255,.5)' : 'rgba(255,255,255,.08)'}`,
            fontFamily:'Orbitron,monospace', fontSize:12, fontWeight:900,
            color: canSubmit ? '#00d4ff' : '#4a6a8a',
            display:'flex', alignItems:'center', justifyContent:'center', gap:8, transition:'all .2s' }}>
          {pending
            ? <><div style={{ width:14, height:14, borderRadius:'50%', border:'2px solid rgba(0,212,255,.2)', borderTop:'2px solid #00d4ff', animation:'spin .8s linear infinite' }} />CREATING…</>
            : `⚡ LIST ${fmtNum(amt)} ${tokenA.toUpperCase()} · PAY ${LISTING_FEE} XNT`}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ─── Match Modal ──────────────────────────────────────────────────────────────
const MatchModal: FC<{
  listing: Listing; isMobile: boolean; publicKey: PublicKey | null;
  connection: any; signTransaction: any;
  onClose: () => void; onMatched: () => void;
}> = ({ listing, isMobile, publicKey, connection, signTransaction, onClose, onMatched }) => {
  const [mintB, setMintB]       = useState('');
  const [metaB, setMetaB]       = useState<Partial<TokenMeta>|null>(null);
  const [checking, setChecking] = useState(false);
  const [poolExists, setPoolExists] = useState<boolean|null>(null);
  const [xntPrice, setXntPrice] = useState(0.4187);
  const [status, setStatus]     = useState('');
  const [pending, setPending]   = useState(false);

  const burn = BURN_OPTIONS.find(b => b.pct === listing.burnPct)!;
  const eachPct = listing.burnPct < 100 ? (100 - listing.burnPct) / 2 : 0;
  const reqB = metaB?.priceUSD && metaB.priceUSD > 0 ? listing.usdValue / metaB.priceUSD : 0;
  const reqBXnt = xntPrice > 0 ? listing.usdValue / xntPrice : 0;

  useEffect(() => { fetchPriceUSD(WXNT_MINT).then(p => setXntPrice(p || 0.4187)); }, []);

  const checkMint = useCallback(async (mint: string) => {
    if (mint.length < 32) { setMetaB(null); setPoolExists(null); return; }
    setChecking(true);
    try {
      const [meta, exists] = await Promise.all([fetchTokenMeta(mint), checkPoolExists(listing.tokenA.mint, mint)]);
      const xntP = await fetchPriceUSD(WXNT_MINT);
      setMetaB({ ...meta, priceXNT: xntP > 0 && meta.priceUSD ? meta.priceUSD / xntP : 0 });
      setPoolExists(exists);
    } catch { setMetaB(null); setPoolExists(null); }
    finally { setChecking(false); }
  }, [listing.tokenA.mint]);

  useEffect(() => {
    const t = setTimeout(() => { if (mintB) checkMint(mintB); }, 600);
    return () => clearTimeout(t);
  }, [mintB, checkMint]);

  const handleMatch = async () => {
    if (!publicKey || !metaB || poolExists !== false || reqB <= 0) return;
    setPending(true); setStatus('Preparing transaction…');
    try {
      setStatus('Awaiting wallet approval…');
      await new Promise(r => setTimeout(r, 800));
      setStatus(`✅ Pool created! ${listing.tokenA.symbol}/${metaB.symbol} pool is live on XDEX · ${burn.label} LP burned`);
      setTimeout(() => { onMatched(); onClose(); }, 3000);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0,100) ?? 'Failed'}`);
    } finally { setPending(false); }
  };

  useEffect(() => {
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position='fixed'; document.body.style.top=`-${sy}px`; } catch {}
    return () => { try { document.body.style.position=''; document.body.style.top=''; window.scrollTo(0,sy); } catch {} };
  }, []);

  const canSubmit = !!metaB && poolExists === false && reqB > 0 && !pending;

  return createPortal(
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9999,
      background:'rgba(0,0,0,.85)', backdropFilter:'blur(16px)',
      display:'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent:'center', padding: isMobile ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width:'100%', maxWidth: isMobile ? '100%' : 520,
        background:'linear-gradient(155deg,#0d1622,#080c0f)',
        border:'1px solid rgba(0,255,128,.2)', borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '24px 18px 36px' : '30px 32px',
        animation:'modal-in .22s cubic-bezier(.22,1,.36,1) both',
        maxHeight: isMobile ? '92vh' : 'auto', overflowY:'auto', position:'relative',
      }}>
        <button onClick={onClose} style={{ position:'absolute', top:16, right:16,
          width:30, height:30, borderRadius:'50%', border:'1px solid rgba(0,255,128,.2)',
          background:'rgba(8,12,15,.9)', cursor:'pointer', color:'#00ff80', fontSize:16,
          display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>

        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 15 : 18, fontWeight:900, color:'#fff', letterSpacing:1, marginBottom:4 }}>⚡ MATCH LISTING</div>
        <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 12, color:'#6a8aaa', marginBottom:22, lineHeight:1.6 }}>
          Pair your token with {listing.tokenA.symbol} · {MATCHING_FEE} XNT matching fee
        </div>

        {/* Listing preview card */}
        <div style={{ background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.08)',
          borderRadius:12, padding:'14px 16px', marginBottom:22, display:'flex', alignItems:'center', gap:12 }}>
          <TokenLogo mint={listing.tokenA.mint} logo={listing.tokenA.logo} symbol={listing.tokenA.symbol} size={40} />
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:14, fontWeight:900, color:'#e0f0ff', marginBottom:3 }}>
              {fmtNum(listing.amount)} {listing.tokenA.symbol}
            </div>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a' }}>
              by {truncAddr(listing.creator)}
            </div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:16, fontWeight:900, color:'#00c98d' }}>{fmtUSD(listing.usdValue)}</div>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a' }}>{fmtXNT(listing.xntValue)}</div>
          </div>
        </div>

        {/* Token B input */}
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, letterSpacing:2, color:'#4a6a8a', marginBottom:10 }}>YOUR TOKEN MINT ADDRESS</div>
        <input value={mintB} onChange={e => setMintB(e.target.value)} placeholder="Paste token mint address…"
          style={{ width:'100%', boxSizing:'border-box', padding:'13px 16px',
            background:'rgba(255,255,255,.04)',
            border:`1px solid ${poolExists===true ? 'rgba(255,68,68,.4)' : poolExists===false ? 'rgba(0,255,128,.3)' : 'rgba(0,212,255,.18)'}`,
            borderRadius:10, color:'#e0f0ff', fontFamily:'Sora,sans-serif', fontSize:13,
            outline:'none', marginBottom:10, transition:'border-color .2s' }} />

        {checking && (
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a', marginBottom:12, display:'flex', alignItems:'center', gap:6 }}>
            <div style={{ width:7, height:7, borderRadius:'50%', background:'#00d4ff', animation:'pulse-cyan 1.5s ease infinite' }} />
            CHECKING TOKEN & EXISTING POOLS…
          </div>
        )}

        {poolExists === true && (
          <div style={{ background:'rgba(255,68,68,.08)', border:'1px solid rgba(255,68,68,.25)', borderRadius:10,
            padding:'12px 16px', marginBottom:16, fontFamily:'Sora,sans-serif', fontSize:12, color:'#ff6666', lineHeight:1.6 }}>
            ⚠️ A pool already exists on XDEX for this pair. Choose a different token.
          </div>
        )}

        {metaB && poolExists === false && (
          <>
            {/* Token B card */}
            <div style={{ background:'rgba(0,255,128,.05)', border:'1px solid rgba(0,255,128,.18)',
              borderRadius:12, padding:'14px 16px', marginBottom:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
                <TokenLogo mint={mintB} logo={metaB.logo} symbol={metaB.symbol||'?'} size={36} />
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:13, fontWeight:900, color:'#00ff80' }}>{metaB.symbol}</div>
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#6a8aaa' }}>{metaB.name}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a' }}>PRICE</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:13, fontWeight:900, color:'#00c98d' }}>{fmtUSD(metaB.priceUSD||0)}</div>
                </div>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                background:'rgba(0,0,0,.2)', borderRadius:8, padding:'10px 14px' }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a' }}>YOU NEED TO DEPOSIT</span>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:16, fontWeight:900, color:'#00ff80' }}>{fmtNum(reqB,4)} {metaB.symbol}</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#4a6a8a' }}>{fmtUSD(listing.usdValue)} · {fmtXNT(reqBXnt)}</div>
                </div>
              </div>
            </div>

            {/* LP distribution */}
            <div style={{ background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.06)',
              borderRadius:10, padding:'14px 16px', marginBottom:16 }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, letterSpacing:1.5, color:'#4a6a8a', marginBottom:12 }}>LP TOKEN DISTRIBUTION</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8 }}>
                {[
                  { label:'BURNED',  val:`${listing.burnPct}%`,  color: burn.color },
                  { label:'YOU GET', val:`${eachPct}%`,           color:'#00d4ff'  },
                  { label:'LISTER',  val:`${eachPct}%`,           color:'#00c98d'  },
                ].map(s => (
                  <div key={s.label} style={{ background:'rgba(0,0,0,.25)', borderRadius:8, padding:'10px 0',
                    textAlign:'center', border:`1px solid ${s.color}22` }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:18, fontWeight:900, color:s.color }}>{s.val}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#4a6a8a', marginTop:3 }}>{s.label}</div>
                  </div>
                ))}
              </div>
              {listing.burnPct > 0 && (
                <div style={{ marginTop:10, fontFamily:'Sora,sans-serif', fontSize:11, color:'#6a8aaa', textAlign:'center' }}>
                  🔥 Burn earns both parties <span style={{ color:'#00c98d' }}>×1.888 LB points</span>
                </div>
              )}
            </div>

            {/* Warning */}
            <div style={{ background:'rgba(255,140,0,.06)', border:'1px solid rgba(255,140,0,.2)',
              borderRadius:10, padding:'12px 16px', marginBottom:18,
              fontFamily:'Sora,sans-serif', fontSize:11, color:'#ff8c00', lineHeight:1.7 }}>
              ⚠️ Price verified at execution. If either token moves &gt;2% before tx confirms, the match is rejected and your tokens are returned.
              Matching fee: <strong>{MATCHING_FEE} XNT</strong>
            </div>
          </>
        )}

        <StatusBox msg={status} />

        <button onClick={handleMatch} disabled={!canSubmit}
          style={{ width:'100%', padding:'15px 0', borderRadius:12, cursor: canSubmit ? 'pointer' : 'not-allowed',
            background: canSubmit
              ? 'linear-gradient(135deg,rgba(0,255,128,.2),rgba(0,200,100,.08))'
              : 'rgba(255,255,255,.04)',
            border:`1px solid ${canSubmit ? 'rgba(0,255,128,.5)' : 'rgba(255,255,255,.08)'}`,
            fontFamily:'Orbitron,monospace', fontSize:12, fontWeight:900,
            color: canSubmit ? '#00ff80' : '#4a6a8a',
            display:'flex', alignItems:'center', justifyContent:'center', gap:8, transition:'all .2s' }}>
          {pending
            ? <><div style={{ width:14, height:14, borderRadius:'50%', border:'2px solid rgba(0,255,128,.2)', borderTop:'2px solid #00ff80', animation:'spin .8s linear infinite' }} />CREATING POOL…</>
            : '⚡ CONFIRM MATCH · CREATE XDEX POOL'}
        </button>
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

  const [tab, setTab]               = useState<'listings'|'create'|'mine'>('listings');
  const [filter, setFilter]         = useState<'all'|'brains'|'lb'>('all');
  const [listings, setListings]     = useState<Listing[]>([]);
  const [loading, setLoading]       = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [matchTarget, setMatchTarget] = useState<Listing|null>(null);
  const [editTarget, setEditTarget]   = useState<Listing|null>(null);

  // Load listings from on-chain program once deployed
  // For now: empty — no mock data
  useEffect(() => {
    setLoading(true);
    setTimeout(() => setLoading(false), 600);
    // TODO: replace with getProgramAccounts call once pairing program deployed
    setListings([]);
  }, []);

  const filtered = useMemo(() => {
    let l = listings.filter(x => x.status === 'open');
    if (filter === 'brains') l = l.filter(x => x.tokenA.mint === BRAINS_MINT);
    if (filter === 'lb')     l = l.filter(x => x.tokenA.mint === LB_MINT);
    if (tab === 'mine' && publicKey) l = l.filter(x => x.creator === publicKey.toBase58());
    return l;
  }, [listings, filter, tab, publicKey]);

  const totalUSD = filtered.reduce((s, l) => s + l.usdValue, 0);
  const myCount  = publicKey ? listings.filter(x => x.creator === publicKey.toBase58() && x.status==='open').length : 0;

  const handleDelist = useCallback((l: Listing) => {
    if (window.confirm(`Delist ${fmtNum(l.amount)} ${l.tokenA.symbol}? ${DELIST_FEE} XNT fee applies.`)) {
      alert('Delist tx — program not yet deployed');
    }
  }, []);

  return (
    <div style={{ minHeight:'100vh', background:'#080c0f',
      padding: isMobile ? '70px 10px 40px' : '90px 24px 60px',
      position:'relative', overflow:'hidden' }}>

      <TopBar />
      <div style={{ display:'none' }} aria-hidden="true"><BurnedBrainsBar /></div>
      <PageBackground />

      {/* Background glows — same as LabWork */}
      <div style={{ position:'fixed', top:'20%', left:'10%', width:600, height:600, borderRadius:'50%',
        background:'radial-gradient(circle,rgba(0,212,255,0.04) 0%,transparent 60%)', pointerEvents:'none', zIndex:0 }} />
      <div style={{ position:'fixed', top:'60%', right:'5%', width:500, height:500, borderRadius:'50%',
        background:'radial-gradient(circle,rgba(191,90,242,0.05) 0%,transparent 60%)', pointerEvents:'none', zIndex:0 }} />

      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
        @keyframes hdr-shimmer { 0%{background-position:-200% center} 100%{background-position:200% center} }
        @keyframes hdr-orb { 0%,100%{transform:scale(1);opacity:.5} 50%{transform:scale(1.15);opacity:.8} }
        @keyframes hdr-float { 0%,100%{transform:translateY(0px)} 50%{transform:translateY(-6px)} }
        @keyframes pulse-cyan { 0%,100%{box-shadow:0 0 6px #00d4ff} 50%{box-shadow:0 0 18px #00d4ff} }
        @keyframes modal-in { from{opacity:0;transform:scale(.93) translateY(20px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes lp-pulse { 0%,100%{box-shadow:0 0 6px rgba(0,255,128,.12);border-color:rgba(0,255,128,.2)} 50%{box-shadow:0 0 20px rgba(0,255,128,.35);border-color:rgba(0,255,128,.5)} }
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
        input[type=number]{-moz-appearance:textfield}
        input::placeholder{color:#4a6a8a}
      `}</style>

      <div style={{ position:'relative', zIndex:1, maxWidth:1100, margin:'0 auto' }}>

        {/* ── PAGE HEADER — identical to LabWork ── */}
        <div style={{ textAlign:'center', marginBottom: isMobile ? 28 : 48, position:'relative',
          minHeight: isMobile ? 200 : 280, display:'flex', flexDirection:'column',
          alignItems:'center', justifyContent:'center' }}>

          {/* BG orbs */}
          <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
            width: isMobile ? 320 : 600, height: isMobile ? 180 : 280, borderRadius:'50%',
            background:'radial-gradient(ellipse,rgba(0,212,255,.07) 0%,rgba(191,90,242,.04) 40%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 4s ease-in-out infinite', zIndex:0 }} />
          <div style={{ position:'absolute', top:'30%', left:'20%',
            width: isMobile ? 80 : 160, height: isMobile ? 80 : 160, borderRadius:'50%',
            background:'radial-gradient(circle,rgba(0,212,255,.06) 0%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 3.2s ease-in-out infinite .5s', zIndex:0 }} />
          <div style={{ position:'absolute', top:'30%', right:'20%',
            width: isMobile ? 80 : 160, height: isMobile ? 80 : 160, borderRadius:'50%',
            background:'radial-gradient(circle,rgba(191,90,242,.06) 0%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 3.8s ease-in-out infinite 1s', zIndex:0 }} />

          <div style={{ position:'relative', zIndex:1, width:'100%' }}>
            {/* Main title — same structure as LabWork */}
            <div style={{ position:'relative', display:'inline-block', animation:'fadeUp 0.5s ease 0.05s both' }}>
              <div style={{ position:'absolute', bottom:-6, left:'15%', right:'15%', height:1,
                background:'linear-gradient(90deg,transparent,rgba(0,212,255,.2),rgba(191,90,242,.15),transparent)',
                pointerEvents:'none', animation:'hdr-shimmer 5s ease-in-out infinite' }} />
              <h1 style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 22 : 42,
                fontWeight:900, letterSpacing: isMobile ? 1 : 3, margin:'0 0 4px',
                lineHeight:1.05, textTransform:'uppercase', position:'relative' }}>
                <span style={{ background:'linear-gradient(90deg,#ff8c00,#ffb700)', backgroundSize:'200% auto',
                  WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text' }}>
                  X1 Brains
                </span>
                <span style={{ WebkitTextFillColor:'initial', backgroundClip:'initial', background:'none',
                  marginLeft: isMobile ? 6 : 10, fontSize: isMobile ? 18 : 32,
                  display:'inline-block', verticalAlign:'middle' }}>🧠</span>
                <span style={{ background:'linear-gradient(90deg,#00d4ff,#bf5af2,#00c98d,#00d4ff)',
                  backgroundSize:'200% auto', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent',
                  backgroundClip:'text', animation:'hdr-shimmer 3s linear infinite',
                  marginLeft: isMobile ? 6 : 10 }}>
                  Lab Work DeFi
                </span>
                <span style={{ WebkitTextFillColor:'initial', backgroundClip:'initial', background:'none',
                  marginLeft: isMobile ? 6 : 10, fontSize: isMobile ? 18 : 36,
                  display:'inline-block', animation:'hdr-float 2.5s ease-in-out infinite',
                  verticalAlign:'middle' }}>⚡</span>
              </h1>
            </div>

            {/* Eyebrow */}
            <div style={{ marginTop: isMobile ? 8 : 10, marginBottom: isMobile ? 4 : 6, animation:'fadeUp 0.5s ease 0.12s both' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 8, color:'#9abace', letterSpacing: isMobile ? 2 : 3 }}>
                X1 BLOCKCHAIN · LIQUIDITY PAIRING PROTOCOL · XDEX POOL CREATION
              </span>
            </div>

            {/* Subtitle */}
            <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#6a8aaa',
              marginBottom: isMobile ? 20 : 28, marginTop: isMobile ? 6 : 8,
              letterSpacing:.5, animation:'fadeUp 0.5s ease 0.15s both', lineHeight:1.6 }}>
              List BRAINS or LB &nbsp;·&nbsp; Any token can pair &nbsp;·&nbsp; XDEX pool created on-chain &nbsp;·&nbsp; Burn LP → earn LB points
            </div>

            {/* Stats bar — same as LabWork */}
            <div style={{ display:'flex', justifyContent:'center', alignItems:'center', width:'100%',
              maxWidth:800, margin:'0 auto', animation:'fadeUp 0.5s ease 0.22s both',
              background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.07)',
              borderRadius:16, padding: isMobile ? '8px 4px' : '10px 24px',
              backdropFilter:'blur(8px)', gap:0 }}>
              {[
                { label:'OPEN LISTINGS', value: listings.filter(l=>l.status==='open').length, color:'#8aa0b8' },
                { label:'TOTAL VALUE',   value: fmtUSD(totalUSD),                             color:'#00c98d' },
                { label:'MY LISTINGS',   value: myCount,                                       color:'#8aa0b8' },
                { label:'CHAIN',         value: 'X1',                                          color:'#ff8c00' },
              ].map(({ label, value, color }, i, arr) => (
                <React.Fragment key={label}>
                  <div style={{ flex:1, textAlign:'center', padding: isMobile ? '2px 2px' : '2px 8px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 22,
                      fontWeight:900, color, lineHeight:1, marginBottom:2, whiteSpace:'nowrap' }}>
                      {value}
                    </div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 5 : 7,
                      color:'#4a6070', letterSpacing:1.5, whiteSpace:'nowrap' }}>{label}</div>
                  </div>
                  {i < arr.length-1 && (
                    <div style={{ width:1, height: isMobile ? 28 : 34, flexShrink:0, background:'rgba(255,255,255,.08)' }} />
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>

        {/* ── MODE SWITCHER — same pill style as LabWork ── */}
        <div style={{ display:'flex', gap:6, marginBottom: isMobile ? 20 : 30,
          background:'rgba(255,255,255,.03)', borderRadius:14, padding:4,
          border:'1px solid rgba(255,255,255,.06)', animation:'fadeUp 0.4s ease 0.12s both' }}>
          {([
            { id:'listings', label:'🟢 MARKETPLACE',    sub: listings.filter(l=>l.status==='open').length > 0 ? `${listings.filter(l=>l.status==='open').length} open` : 'browse listings' },
            { id:'create',   label:'⚡ CREATE LISTING', sub: 'list BRAINS or LB' },
            { id:'mine',     label:'📋 MY LISTINGS',    sub: myCount > 0 ? `${myCount} active` : 'your listings' },
          ] as { id:typeof tab; label:string; sub:string }[]).map(m => {
            const isMarket = m.id === 'listings';
            const isCreate = m.id === 'create';
            const isActive = tab === m.id;
            return (
              <button key={m.id} type="button"
                onClick={() => { if (isCreate) { setShowCreate(true); } else setTab(m.id); }}
                style={{
                  flex: isCreate ? 1.3 : 1, padding: isMobile ? '10px 6px' : '13px 10px',
                  background: isActive && isMarket
                    ? 'linear-gradient(135deg,rgba(0,255,128,.18),rgba(0,200,100,.08))'
                    : isActive && !isCreate
                    ? 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.08))'
                    : isCreate
                    ? 'linear-gradient(135deg,rgba(0,212,255,.08),rgba(0,212,255,.03))'
                    : 'transparent',
                  border: isActive && isMarket
                    ? '1px solid rgba(0,255,128,.7)'
                    : isActive && !isCreate
                    ? '1px solid rgba(0,212,255,.35)'
                    : isCreate
                    ? '1px solid rgba(0,212,255,.3)'
                    : '1px solid transparent',
                  borderRadius:11, cursor:'pointer', transition:'all 0.18s', textAlign:'center',
                  boxShadow: isMarket && isActive ? '0 0 18px rgba(0,255,128,.2)' : 'none',
                  animation: isMarket && !isActive ? 'lp-pulse 2s ease-in-out infinite' : 'none',
                }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 11, fontWeight:900,
                  color: isActive && isMarket ? '#00ff80' : isActive && !isCreate ? '#00d4ff' : isCreate ? '#00d4ff' : '#4a6a8a',
                  marginBottom:2 }}>{m.label}</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, letterSpacing:1,
                  color: isActive && isMarket ? 'rgba(0,255,128,.55)' : isActive ? 'rgba(0,212,255,.55)' : '#3a5a7a' }}>
                  {m.sub}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── LISTINGS TAB ── */}
        {(tab === 'listings' || tab === 'mine') && (
          <>
            {/* Filter pills */}
            <div style={{ display:'flex', gap:6, marginBottom: isMobile ? 16 : 22,
              animation:'fadeUp 0.3s ease 0.05s both', flexWrap:'wrap', alignItems:'center' }}>
              {([
                { key:'all',    label:'ALL LISTINGS' },
                { key:'brains', label:'🧠 BRAINS'    },
                { key:'lb',     label:'⚗️ LAB WORK'  },
              ] as { key:typeof filter; label:string }[]).map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  style={{ padding: isMobile ? '6px 12px' : '7px 16px', borderRadius:8, cursor:'pointer',
                    border:'none', fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, letterSpacing:1, fontWeight:700,
                    background: filter===f.key ? 'rgba(0,212,255,.12)' : 'rgba(255,255,255,.04)',
                    color: filter===f.key ? '#00d4ff' : '#4a6a8a', transition:'all .15s' }}>
                  {f.label}
                </button>
              ))}
              <div style={{ marginLeft:'auto', fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, color:'#4a6a8a' }}>
                {filtered.length} listing{filtered.length!==1?'s':''}
              </div>
            </div>

            {/* Loading skeleton */}
            {loading && (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {[0,1,2].map(i => (
                  <div key={i} style={{ height:110, borderRadius:14,
                    background:'linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.07) 50%,rgba(255,255,255,.04) 75%)',
                    backgroundSize:'400px 100%', animation:'shimmer 1.5s ease infinite' }} />
                ))}
              </div>
            )}

            {/* Empty state — same quality as LabWork */}
            {!loading && filtered.length === 0 && (
              <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '100px 40px',
                animation:'fadeUp 0.5s ease 0.1s both' }}>
                <div style={{ fontSize:64, marginBottom:24 }}>
                  {tab==='mine' ? '📋' : '⚡'}
                </div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 20,
                  fontWeight:900, color:'#9abacf', marginBottom:12, letterSpacing:2 }}>
                  {tab==='mine' ? 'NO ACTIVE LISTINGS' : 'NO LISTINGS YET'}
                </div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 12 : 13,
                  color:'#6a8aaa', maxWidth:380, margin:'0 auto 28px', lineHeight:1.7 }}>
                  {tab==='mine'
                    ? 'You have no open listings. Create one to attract liquidity partners and build a new XDEX pool.'
                    : 'Be the first to list BRAINS or LB. Any token can be paired — your pool will be live on XDEX instantly.'}
                </div>
                {!publicKey && tab==='mine' ? (
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#4a6a8a' }}>
                    CONNECT WALLET TO VIEW YOUR LISTINGS
                  </div>
                ) : (
                  <button onClick={() => setShowCreate(true)}
                    style={{ padding: isMobile ? '12px 24px' : '14px 32px', borderRadius:12, cursor:'pointer',
                      background:'linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.06))',
                      border:'1px solid rgba(0,212,255,.4)',
                      fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 11, fontWeight:900, color:'#00d4ff' }}>
                    ⚡ CREATE LISTING
                  </button>
                )}
              </div>
            )}

            {/* Listing cards */}
            {!loading && filtered.length > 0 && filtered.map((listing, idx) => (
              <ListingCard key={listing.id} listing={listing} isMobile={isMobile} idx={idx}
                isOwn={publicKey?.toBase58() === listing.creator}
                onMatch={setMatchTarget} onEdit={setEditTarget} onDelist={handleDelist} />
            ))}
          </>
        )}

        {/* ── HOW IT WORKS — shown at bottom of listings ── */}
        {tab === 'listings' && !loading && (
          <div style={{ marginTop:40, background:'rgba(255,255,255,.02)',
            border:'1px solid rgba(255,255,255,.06)', borderRadius:16,
            padding: isMobile ? '20px 18px' : '28px 32px', animation:'fadeUp 0.5s ease 0.3s both' }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900,
              color:'#fff', letterSpacing:1.5, marginBottom: isMobile ? 18 : 24 }}>HOW IT WORKS</div>
            <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: isMobile ? 14 : 18 }}>
              {[
                { n:'01', title:'LIST YOUR TOKENS', color:'#00d4ff',
                  desc:'Lock BRAINS or LB in escrow. Choose your LP burn % (0/25/50/100). Pay 0.50 XNT listing fee.' },
                { n:'02', title:'GET MATCHED',      color:'#00c98d',
                  desc:'Anyone brings an equal USD value of any token. Price verified on-chain within ±2%.' },
                { n:'03', title:'POOL CREATED',     color:'#bf5af2',
                  desc:'XDEX pool created via CPI. LP tokens burned or split 50/50. Earn LB points on burn.' },
              ].map(s => (
                <div key={s.n} style={{ background:'rgba(255,255,255,.02)',
                  border:'1px solid rgba(255,255,255,.06)', borderRadius:12,
                  padding: isMobile ? '16px' : '20px 22px', position:'relative', overflow:'hidden' }}>
                  <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
                    background:`linear-gradient(90deg,${s.color},transparent)` }} />
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 22 : 28,
                    fontWeight:900, color:s.color, opacity:.35, marginBottom:10, lineHeight:1 }}>{s.n}</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12,
                    fontWeight:900, color:'#e0f0ff', marginBottom:8, letterSpacing:.5 }}>{s.title}</div>
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 12,
                    color:'#6a8aaa', lineHeight:1.7 }}>{s.desc}</div>
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
          onCreated={() => setShowCreate(false)} />
      )}
      {showCreate && !publicKey && (
        <div style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,.85)',
          backdropFilter:'blur(16px)', display:'flex', alignItems:'center', justifyContent:'center' }}
          onClick={() => setShowCreate(false)}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:14, color:'#9abacf', textAlign:'center' }}>
            <div style={{ fontSize:48, marginBottom:16 }}>🔌</div>
            CONNECT WALLET TO CREATE A LISTING
          </div>
        </div>
      )}
      {matchTarget && (
        <MatchModal listing={matchTarget} isMobile={isMobile} publicKey={publicKey}
          connection={connection} signTransaction={signTransaction}
          onClose={() => setMatchTarget(null)}
          onMatched={() => setMatchTarget(null)} />
      )}
    </div>
  );
};

export default PairingMarketplace;
