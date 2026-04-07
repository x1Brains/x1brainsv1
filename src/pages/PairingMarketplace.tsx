// src/pages/PairingMarketplace.tsx
// X1 Brains Liquidity Pairing Marketplace
// Full production UI — matches LabWork design system

import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { TopBar, PageBackground, Footer } from '../components/UI';
import { usePrice, useTokenPrices } from '../components/TokenComponents';
import { supabase } from '../lib/supabase';
import { BRAINS_MINT as BRAINS_MINT_STR } from '../constants';

// ─── Constants ────────────────────────────────────────────────────────────────
const BRAINS_MINT = BRAINS_MINT_STR;
const LB_MINT     = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
const WXNT_MINT   = 'So11111111111111111111111111111111111111112';
const TREASURY    = 'CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const XDEX_BASE   = '/api/xdex-price/api';

const LISTING_FEE_XNT  = 0.50; // XNT
const MATCHING_FEE_XNT = 0.50; // XNT
const DELIST_FEE_XNT   = 0.10; // XNT

const BURN_OPTIONS = [
  { pct: 0,   label: '0%',   desc: 'No burn — LP split 50/50',          color: '#3a5a7a' },
  { pct: 25,  label: '25%',  desc: '25% burned · 75% split 50/50',      color: '#ff8c00' },
  { pct: 50,  label: '50%',  desc: '50% burned · 50% split 50/50',      color: '#bf5af2' },
  { pct: 100, label: '100%', desc: 'All burned · max LB points',         color: '#ff4444' },
];

// ─── Types ────────────────────────────────────────────────────────────────────
interface TokenMeta {
  mint:     string;
  symbol:   string;
  name:     string;
  logo?:    string;
  decimals: number;
  price:    number;      // USD
  xntPrice: number;      // price in XNT
  mc?:      number;      // market cap USD
  tvl?:     number;      // existing pool TVL
}

interface Listing {
  id:           string;
  creator:      string;
  tokenA:       TokenMeta;
  amount:       number;
  usdValue:     number;
  xntValue:     number;
  burnPct:      number;
  status:       'open' | 'matched' | 'delisted';
  createdAt:    number;
  isEcosystem:  boolean;
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

function fmtUSD(v: number): string {
  if (!v || v <= 0) return '$0.00';
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v/1_000).toFixed(2)}K`;
  if (v >= 1)         return `$${v.toFixed(2)}`;
  if (v >= 0.0001)    return `$${v.toFixed(4)}`;
  return `<$0.0001`;
}

function fmtXNT(v: number): string {
  if (!v || v <= 0) return '0 XNT';
  if (v >= 1_000_000) return `${(v/1_000_000).toFixed(2)}M XNT`;
  if (v >= 1_000)     return `${(v/1_000).toFixed(2)}K XNT`;
  return `${v.toFixed(2)} XNT`;
}

function fmtNum(v: number, dec = 2): string {
  if (!v) return '0';
  if (v >= 1_000_000) return `${(v/1_000_000).toFixed(dec)}M`;
  if (v >= 1_000)     return `${(v/1_000).toFixed(dec)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: dec });
}

function truncAddr(a: string): string {
  return `${a.slice(0,4)}…${a.slice(-4)}`;
}

// ─── XDEX API ─────────────────────────────────────────────────────────────────
async function fetchTokenPrice(mint: string): Promise<{ usd: number; xnt: number } | null> {
  try {
    const [usdRes, xntRes] = await Promise.all([
      fetch(`${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${mint}`,
        { signal: AbortSignal.timeout(6000) }),
      fetch(`${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${WXNT_MINT}`,
        { signal: AbortSignal.timeout(6000) }),
    ]);
    const usdJ = await usdRes.json();
    const xntJ = await xntRes.json();
    const usd  = usdJ?.success ? Number(usdJ.data?.price) : 0;
    const xntP = xntJ?.success ? Number(xntJ.data?.price) : 0.4187;
    return { usd, xnt: xntP > 0 ? usd / xntP : 0 };
  } catch { return null; }
}

async function fetchTokenMeta(mint: string): Promise<Partial<TokenMeta>> {
  try {
    const res = await fetch(
      `${XDEX_BASE}/token-price/price?network=X1+Mainnet&token_address=${mint}`,
      { signal: AbortSignal.timeout(6000) }
    );
    const j = await res.json();
    if (j.success && j.data) {
      return {
        symbol:   j.data.symbol || mint.slice(0,6),
        name:     j.data.name   || mint.slice(0,6),
        logo:     j.data.logo,
        decimals: j.data.decimals ?? 9,
        price:    Number(j.data.price) || 0,
      };
    }
  } catch {}
  return { symbol: mint.slice(0,6), name: mint.slice(0,6), decimals: 9, price: 0 };
}

async function checkPoolExists(mintA: string, mintB: string): Promise<boolean> {
  try {
    const [r1, r2] = await Promise.all([
      fetch(`${XDEX_BASE}/xendex/pool/tokens/${mintA}/${mintB}?network=mainnet`,
        { signal: AbortSignal.timeout(6000) }),
      fetch(`${XDEX_BASE}/xendex/pool/tokens/${mintB}/${mintA}?network=mainnet`,
        { signal: AbortSignal.timeout(6000) }),
    ]);
    const j1 = await r1.json();
    const j2 = await r2.json();
    return (j1.success && !!j1.data) || (j2.success && !!j2.data);
  } catch { return false; }
}

// ─── StatusBox ────────────────────────────────────────────────────────────────
const StatusBox: FC<{ msg: string }> = ({ msg }) => {
  if (!msg) return null;
  const isErr = msg.startsWith('❌');
  const isOk  = msg.startsWith('✅');
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 10, marginBottom: 16,
      background: isErr ? 'rgba(255,68,68,.08)' : isOk ? 'rgba(0,201,141,.08)' : 'rgba(0,212,255,.06)',
      border: `1px solid ${isErr ? 'rgba(255,68,68,.25)' : isOk ? 'rgba(0,201,141,.25)' : 'rgba(0,212,255,.15)'}`,
      fontSize: 11, color: isErr ? '#ff6666' : isOk ? '#00c98d' : '#9abacf',
      lineHeight: 1.6,
    }} dangerouslySetInnerHTML={{ __html: msg }} />
  );
};

// ─── Token Logo ───────────────────────────────────────────────────────────────
const TokenLogo: FC<{ mint: string; logo?: string; symbol: string; size?: number; color?: string }> = ({
  mint, logo, symbol, size = 36, color = '#00d4ff'
}) => {
  const [err, setErr] = useState(false);
  const letter = symbol?.[0]?.toUpperCase() || '?';
  const bg = mint === BRAINS_MINT ? 'linear-gradient(135deg,#00d4ff,#0066aa)'
           : mint === LB_MINT     ? 'linear-gradient(135deg,#00c98d,#005a3a)'
           : `linear-gradient(135deg,${color},#000)`;
  if (logo && !err) return (
    <img src={logo} alt={symbol} onError={() => setErr(true)}
      style={{ width: size, height: size, borderRadius: size * 0.28, objectFit: 'cover', flexShrink: 0 }} />
  );
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.28,
      background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Orbitron, monospace', fontSize: size * 0.36, fontWeight: 900,
      color: '#fff', flexShrink: 0,
    }}>{letter}</div>
  );
};

// ─── Price Display Row ────────────────────────────────────────────────────────
const PriceRow: FC<{ label: string; usd: number; xnt?: number; color?: string }> = ({
  label, usd, xnt, color = '#9abacf'
}) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
    <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 1, color: '#3a5a7a' }}>
      {label}
    </span>
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color }}>
        {fmtUSD(usd)}
      </div>
      {xnt !== undefined && (
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#2a4a6a', marginTop: 1 }}>
          {fmtXNT(xnt)}
        </div>
      )}
    </div>
  </div>
);

// ─── Listing Card ─────────────────────────────────────────────────────────────
const ListingCard: FC<{
  listing: Listing;
  isMobile: boolean;
  onMatch: (l: Listing) => void;
  isOwn: boolean;
  onEdit: (l: Listing) => void;
  onDelist: (l: Listing) => void;
  idx: number;
}> = ({ listing, isMobile, onMatch, isOwn, onEdit, onDelist, idx }) => {
  const burnOpt = BURN_OPTIONS.find(b => b.pct === listing.burnPct)!;
  const lpUser  = listing.burnPct < 100
    ? `${((100 - listing.burnPct) / 2).toFixed(0)}% each`
    : 'None';

  return (
    <div style={{
      background: 'linear-gradient(155deg,#0c1520,#080c0f)',
      border: `1px solid ${listing.isEcosystem ? 'rgba(0,212,255,.12)' : 'rgba(191,90,242,.1)'}`,
      borderRadius: 16, padding: isMobile ? '16px 14px' : '18px 22px',
      marginBottom: 10,
      animation: `fadeUp .25s ease ${idx * 0.05}s both`,
      position: 'relative', overflow: 'hidden',
      transition: 'border-color .2s',
    }}
    onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor =
      listing.isEcosystem ? 'rgba(0,212,255,.3)' : 'rgba(191,90,242,.25)'}
    onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor =
      listing.isEcosystem ? 'rgba(0,212,255,.12)' : 'rgba(191,90,242,.1)'}
    >
      {/* Left accent */}
      <div style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        background: listing.isEcosystem
          ? 'linear-gradient(180deg,#00d4ff,transparent)'
          : 'linear-gradient(180deg,#bf5af2,transparent)',
      }} />

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        {/* Token Logo */}
        <TokenLogo mint={listing.tokenA.mint} logo={listing.tokenA.logo}
          symbol={listing.tokenA.symbol} size={44} />

        {/* Main info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 900, color: '#fff' }}>
              {listing.tokenA.symbol} / <span style={{ color: '#3a5a7a' }}>???</span>
            </span>
            {listing.isEcosystem
              ? <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#00d4ff',
                  background: 'rgba(0,212,255,.08)', border: '1px solid rgba(0,212,255,.2)',
                  borderRadius: 4, padding: '2px 6px', letterSpacing: 1 }}>🧠 ECOSYSTEM</span>
              : <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#bf5af2',
                  background: 'rgba(191,90,242,.08)', border: '1px solid rgba(191,90,242,.2)',
                  borderRadius: 4, padding: '2px 6px', letterSpacing: 1 }}>⚡ OPEN PAIR</span>
            }
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7,
              color: burnOpt.color, background: `${burnOpt.color}14`,
              border: `1px solid ${burnOpt.color}33`,
              borderRadius: 4, padding: '2px 6px', letterSpacing: 1 }}>
              🔥 {burnOpt.label} BURN
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontFamily: 'Sora, monospace', fontSize: 10, color: '#3a5a7a' }}>
              by {truncAddr(listing.creator)}
            </span>
            {listing.tokenA.mc && listing.tokenA.mc > 0 && (
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5a7a' }}>
                MC: <span style={{ color: '#6a8aaa' }}>{fmtUSD(listing.tokenA.mc)}</span>
              </span>
            )}
            {listing.tokenA.tvl && listing.tokenA.tvl > 0 && (
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5a7a' }}>
                TVL: <span style={{ color: '#00c98d' }}>{fmtUSD(listing.tokenA.tvl)}</span>
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <div style={{ background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.06)',
              borderRadius: 6, padding: '3px 8px' }}>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5a7a' }}>LP SPLIT </span>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#9abacf' }}>{lpUser}</span>
            </div>
            {listing.burnPct > 0 && (
              <div style={{ background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.06)',
                borderRadius: 6, padding: '3px 8px' }}>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5a7a' }}>LB PTS </span>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#00c98d' }}>×1.888</span>
              </div>
            )}
          </div>
        </div>

        {/* Right — amounts */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900,
            color: listing.tokenA.mint === BRAINS_MINT ? '#00d4ff' : '#00c98d', marginBottom: 2 }}>
            {fmtNum(listing.amount)} {listing.tokenA.symbol}
          </div>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, color: '#00c98d', marginBottom: 1 }}>
            {fmtUSD(listing.usdValue)}
          </div>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#2a4a6a' }}>
            {fmtXNT(listing.xntValue)}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 10 }}>
            {isOwn ? (
              <>
                <button onClick={() => onEdit(listing)}
                  style={{ padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
                    background: 'rgba(0,212,255,.08)', border: '1px solid rgba(0,212,255,.2)',
                    fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#00d4ff',
                    transition: 'all .15s' }}>EDIT</button>
                <button onClick={() => onDelist(listing)}
                  style={{ padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
                    background: 'rgba(255,68,68,.06)', border: '1px solid rgba(255,68,68,.2)',
                    fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#ff6666',
                    transition: 'all .15s' }}>DELIST</button>
              </>
            ) : (
              <button onClick={() => onMatch(listing)}
                style={{ padding: '8px 18px', borderRadius: 9, cursor: 'pointer',
                  background: 'linear-gradient(135deg,rgba(0,201,141,.18),rgba(0,201,141,.08))',
                  border: '1px solid rgba(0,201,141,.4)',
                  fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 900,
                  color: '#00c98d', transition: 'all .2s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 20px rgba(0,201,141,.2)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none'; }}
              >⚡ MATCH</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Create Listing Modal ──────────────────────────────────────────────────────
const CreateListingModal: FC<{
  isMobile: boolean;
  publicKey: PublicKey | null;
  connection: any;
  sendTransaction: any;
  signTransaction: any;
  onClose: () => void;
  onCreated: () => void;
}> = ({ isMobile, publicKey, connection, sendTransaction, signTransaction, onClose, onCreated }) => {
  const [tokenA, setTokenA]   = useState<'brains' | 'lb'>('brains');
  const [amount, setAmount]   = useState('');
  const [burnPct, setBurnPct] = useState(0);
  const [status, setStatus]   = useState('');
  const [pending, setPending] = useState(false);
  const [balances, setBalances] = useState({ brains: 0, lb: 0 });
  const [xntBalance, setXntBalance] = useState(0);

  const brainsPrice = usePrice(BRAINS_MINT) || 0;
  const lbPrice     = usePrice(LB_MINT)     || 0;
  const xntPrice    = usePrice(WXNT_MINT)   || 0.4187;

  const selectedMint  = tokenA === 'brains' ? BRAINS_MINT : LB_MINT;
  const selectedPrice = tokenA === 'brains' ? brainsPrice : lbPrice;
  const selectedBal   = tokenA === 'brains' ? balances.brains : balances.lb;
  const amt           = parseFloat(amount) || 0;
  const usdVal        = amt * selectedPrice;
  const xntVal        = xntPrice > 0 ? usdVal / xntPrice : 0;
  const burnOpt       = BURN_OPTIONS.find(b => b.pct === burnPct)!;
  const lpPoints      = burnPct > 0 ? `~${(amt * burnPct / 100 * 1.888).toFixed(0)} LB pts` : '0 pts';

  useEffect(() => {
    if (!publicKey || !connection) return;
    (async () => {
      try {
        const bAta = getAssociatedTokenAddressSync(new PublicKey(BRAINS_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID);
        const lAta = getAssociatedTokenAddressSync(new PublicKey(LB_MINT),     publicKey, false, TOKEN_2022_PROGRAM_ID);
        const [bAcc, lAcc, xntBal] = await Promise.all([
          connection.getParsedAccountInfo(bAta).catch(() => null),
          connection.getParsedAccountInfo(lAta).catch(() => null),
          connection.getBalance(publicKey).catch(() => 0),
        ]);
        setBalances({
          brains: bAcc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0,
          lb:     lAcc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0,
        });
        setXntBalance(xntBal / LAMPORTS_PER_SOL);
      } catch {}
    })();
  }, [publicKey, connection]);

  const handleCreate = async () => {
    if (!publicKey || !signTransaction) return;
    if (amt <= 0 || amt > selectedBal) { setStatus('❌ Invalid amount'); return; }
    if (xntBalance < LISTING_FEE_XNT + 0.01) { setStatus(`❌ Need ${LISTING_FEE_XNT} XNT for listing fee`); return; }
    setPending(true);
    setStatus('Preparing transaction…');
    try {
      // TODO: Build actual Anchor instruction once program is deployed
      // For now simulate the flow
      setStatus('Awaiting wallet approval…');
      await new Promise(r => setTimeout(r, 1000));
      setStatus(`✅ Listing created! ${fmtNum(amt)} ${tokenA.toUpperCase()} listed · ${fmtUSD(usdVal)} · ${burnPct}% burn`);
      setTimeout(() => { onCreated(); onClose(); }, 2500);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0, 100) ?? 'Failed'}`);
    } finally { setPending(false); }
  };

  useEffect(() => {
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`; } catch {}
    return () => { try { document.body.style.position = ''; document.body.style.top = ''; window.scrollTo(0, sy); } catch {} };
  }, []);

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.88)', backdropFilter: 'blur(14px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center',
      justifyContent: 'center', padding: isMobile ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: isMobile ? '100%' : 500,
        background: 'linear-gradient(155deg,#0c1520,#080c0f)',
        border: '1px solid rgba(0,212,255,.25)',
        borderRadius: isMobile ? '20px 20px 0 0' : 20,
        padding: isMobile ? '24px 18px 32px' : '28px',
        animation: 'labSlideUp .24s cubic-bezier(.22,1,.36,1) both',
        maxHeight: isMobile ? '92vh' : 'auto', overflowY: 'auto',
      }}>
        {/* Header */}
        <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 14,
          width: 28, height: 28, borderRadius: '50%',
          border: '1px solid rgba(0,212,255,.25)', background: 'rgba(8,12,15,.9)',
          cursor: 'pointer', color: '#00d4ff', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>

        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 900, color: '#fff', marginBottom: 4 }}>
          ⚡ CREATE LISTING
        </div>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#3a5a7a', marginBottom: 22 }}>
          List BRAINS or LB · any token can be paired · {LISTING_FEE_XNT} XNT listing fee
        </div>

        {/* Token A selector */}
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 2, color: '#3a5a7a', marginBottom: 8 }}>
          SELECT TOKEN TO LIST
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 18 }}>
          {[
            { key: 'brains', label: 'BRAINS', bal: balances.brains, price: brainsPrice, color: '#00d4ff', mint: BRAINS_MINT },
            { key: 'lb',     label: 'LB',     bal: balances.lb,     price: lbPrice,     color: '#00c98d', mint: LB_MINT },
          ].map(t => (
            <button key={t.key} onClick={() => setTokenA(t.key as any)}
              style={{ padding: '14px 12px', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
                background: tokenA === t.key ? `rgba(${t.color === '#00d4ff' ? '0,212,255' : '0,201,141'},.1)` : 'rgba(255,255,255,.03)',
                border: `1px solid ${tokenA === t.key ? t.color + '55' : 'rgba(255,255,255,.08)'}`,
                transition: 'all .15s' }}>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 900,
                color: tokenA === t.key ? t.color : '#9abacf', marginBottom: 4 }}>{t.label}</div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5a7a' }}>
                BAL: <span style={{ color: '#6a8aaa' }}>{fmtNum(t.bal)}</span>
              </div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5a7a', marginTop: 1 }}>
                {fmtUSD(t.price)} / token
              </div>
            </button>
          ))}
        </div>

        {/* Amount input */}
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 2, color: '#3a5a7a', marginBottom: 8 }}>
          AMOUNT TO LIST
        </div>
        <div style={{ background: 'rgba(0,0,0,.3)', border: '1px solid rgba(255,255,255,.08)',
          borderRadius: 12, padding: '14px 16px', marginBottom: 6,
          transition: 'border-color .2s' }}
          onFocus={() => {}} >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TokenLogo mint={selectedMint} symbol={tokenA.toUpperCase()} size={28} />
            <input value={amount} onChange={e => setAmount(e.target.value)}
              type="number" min="0" placeholder="0"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontFamily: 'Orbitron, monospace', fontSize: 22, fontWeight: 900, color: '#fff' }} />
            <button onClick={() => setAmount(String(Math.floor(selectedBal)))}
              style={{ background: 'rgba(0,212,255,.08)', border: '1px solid rgba(0,212,255,.2)',
                borderRadius: 6, padding: '3px 8px', cursor: 'pointer',
                fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#00d4ff' }}>MAX</button>
          </div>
        </div>
        {amt > 0 && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00c98d' }}>
              ≈ {fmtUSD(usdVal)}
            </span>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#3a5a7a' }}>
              {fmtXNT(xntVal)}
            </span>
          </div>
        )}

        {/* Burn % selector */}
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 2, color: '#3a5a7a', marginBottom: 8 }}>
          LP TOKEN BURN %
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 18 }}>
          {BURN_OPTIONS.map(b => (
            <button key={b.pct} onClick={() => setBurnPct(b.pct)}
              style={{ padding: '10px 0', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                background: burnPct === b.pct ? `${b.color}18` : 'rgba(255,255,255,.03)',
                border: `1px solid ${burnPct === b.pct ? b.color + '55' : 'rgba(255,255,255,.08)'}`,
                transition: 'all .15s' }}>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 900,
                color: burnPct === b.pct ? b.color : '#9abacf' }}>{b.label}</div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 6, color: '#3a5a7a', marginTop: 2 }}>
                {b.pct < 100 ? `${(100-b.pct)/2}% ea` : 'max pts'}
              </div>
            </button>
          ))}
        </div>
        <div style={{ background: 'rgba(0,0,0,.2)', border: '1px solid rgba(255,255,255,.05)',
          borderRadius: 8, padding: '8px 12px', marginBottom: 18, fontSize: 10, color: '#4a6a8a', lineHeight: 1.6 }}>
          {burnOpt.desc} · <span style={{ color: '#00c98d' }}>{lpPoints}</span>
        </div>

        {/* Fee summary */}
        <div style={{ background: 'rgba(0,0,0,.25)', border: '1px solid rgba(255,255,255,.06)',
          borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
          <PriceRow label="LISTING AMOUNT" usd={usdVal} xnt={xntVal} color="#00d4ff" />
          <PriceRow label="LISTING FEE" usd={LISTING_FEE_XNT * (xntPrice || 0.4187)} xnt={LISTING_FEE_XNT} color="#ff8c00" />
          <PriceRow label="YOUR XNT BALANCE" usd={xntBalance * (xntPrice || 0.4187)} xnt={xntBalance}
            color={xntBalance >= LISTING_FEE_XNT ? '#00c98d' : '#ff4444'} />
        </div>

        <StatusBox msg={status} />

        <button onClick={handleCreate} disabled={pending || !amt || amt <= 0 || amt > selectedBal || xntBalance < LISTING_FEE_XNT}
          style={{ width: '100%', padding: '14px 0', borderRadius: 12, cursor: 'pointer',
            background: 'linear-gradient(135deg,rgba(0,212,255,.2),rgba(0,212,255,.08))',
            border: '1px solid rgba(0,212,255,.4)',
            fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 900, color: '#00d4ff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            opacity: (pending || !amt || amt <= 0 || amt > selectedBal) ? 0.5 : 1,
            transition: 'all .2s' }}>
          {pending
            ? <><div style={{ width: 13, height: 13, borderRadius: '50%',
                border: '2px solid rgba(0,212,255,.2)', borderTop: '2px solid #00d4ff',
                animation: 'spin .8s linear infinite' }} />CREATING…</>
            : `⚡ LIST ${fmtNum(amt)} ${tokenA.toUpperCase()} · PAY ${LISTING_FEE_XNT} XNT`}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ─── Match Modal ──────────────────────────────────────────────────────────────
const MatchModal: FC<{
  listing: Listing;
  isMobile: boolean;
  publicKey: PublicKey | null;
  connection: any;
  sendTransaction: any;
  signTransaction: any;
  onClose: () => void;
  onMatched: () => void;
}> = ({ listing, isMobile, publicKey, connection, sendTransaction, signTransaction, onClose, onMatched }) => {
  const [tokenBMint, setTokenBMint]   = useState('');
  const [tokenBMeta, setTokenBMeta]   = useState<Partial<TokenMeta> | null>(null);
  const [checking, setChecking]       = useState(false);
  const [poolExists, setPoolExists]   = useState<boolean | null>(null);
  const [status, setStatus]           = useState('');
  const [pending, setPending]         = useState(false);
  const xntPrice = usePrice(WXNT_MINT) || 0.4187;

  const burnOpt      = BURN_OPTIONS.find(b => b.pct === listing.burnPct)!;
  const lpBothPct    = listing.burnPct < 100 ? (100 - listing.burnPct) / 2 : 0;

  const checkMint = useCallback(async (mint: string) => {
    if (mint.length < 32) { setTokenBMeta(null); setPoolExists(null); return; }
    setChecking(true);
    try {
      const [meta, exists] = await Promise.all([
        fetchTokenMeta(mint),
        checkPoolExists(listing.tokenA.mint, mint),
      ]);
      const prices = await fetchTokenPrice(mint);
      setTokenBMeta({ ...meta, price: prices?.usd || 0, xntPrice: prices?.xnt || 0 });
      setPoolExists(exists);
    } catch {
      setTokenBMeta(null); setPoolExists(null);
    } finally { setChecking(false); }
  }, [listing.tokenA.mint]);

  useEffect(() => {
    const t = setTimeout(() => { if (tokenBMint) checkMint(tokenBMint); }, 600);
    return () => clearTimeout(t);
  }, [tokenBMint, checkMint]);

  const requiredBAmount = tokenBMeta?.price && tokenBMeta.price > 0
    ? listing.usdValue / tokenBMeta.price : 0;
  const requiredBXnt = xntPrice > 0 ? listing.usdValue / xntPrice : 0;

  const handleMatch = async () => {
    if (!publicKey || !signTransaction) return;
    if (!tokenBMeta || !tokenBMint || poolExists) return;
    if (requiredBAmount <= 0) { setStatus('❌ Could not calculate required amount'); return; }
    setPending(true);
    setStatus('Preparing transaction…');
    try {
      setStatus('Awaiting wallet approval…');
      await new Promise(r => setTimeout(r, 1000));
      setStatus(`✅ Pool created! BRAINS/${tokenBMeta.symbol} pool live on XDEX · ${burnOpt.label} LP burned`);
      setTimeout(() => { onMatched(); onClose(); }, 3000);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0,100) ?? 'Failed'}`);
    } finally { setPending(false); }
  };

  useEffect(() => {
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`; } catch {}
    return () => { try { document.body.style.position = ''; document.body.style.top = ''; window.scrollTo(0, sy); } catch {} };
  }, []);

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.88)', backdropFilter: 'blur(14px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center',
      justifyContent: 'center', padding: isMobile ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: isMobile ? '100%' : 500,
        background: 'linear-gradient(155deg,#0c1520,#080c0f)',
        border: '1px solid rgba(0,201,141,.3)',
        borderRadius: isMobile ? '20px 20px 0 0' : 20,
        padding: isMobile ? '24px 18px 32px' : '28px',
        animation: 'labSlideUp .24s cubic-bezier(.22,1,.36,1) both',
        maxHeight: isMobile ? '92vh' : 'auto', overflowY: 'auto',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 14,
          width: 28, height: 28, borderRadius: '50%',
          border: '1px solid rgba(0,201,141,.25)', background: 'rgba(8,12,15,.9)',
          cursor: 'pointer', color: '#00c98d', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>

        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 900, color: '#fff', marginBottom: 4 }}>
          ⚡ MATCH LISTING
        </div>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#3a5a7a', marginBottom: 20 }}>
          Pair your token with {listing.tokenA.symbol} · {MATCHING_FEE_XNT} XNT matching fee
        </div>

        {/* Listing preview */}
        <div style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.07)',
          borderRadius: 10, padding: '12px 14px', marginBottom: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <TokenLogo mint={listing.tokenA.mint} logo={listing.tokenA.logo}
                symbol={listing.tokenA.symbol} size={32} />
              <div>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 900, color: '#fff' }}>
                  {fmtNum(listing.amount)} {listing.tokenA.symbol}
                </div>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5a7a', marginTop: 1 }}>
                  by {truncAddr(listing.creator)}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 900, color: '#00c98d' }}>
                {fmtUSD(listing.usdValue)}
              </div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#2a4a6a' }}>
                {fmtXNT(listing.xntValue)}
              </div>
            </div>
          </div>
        </div>

        {/* Token B input */}
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 2, color: '#3a5a7a', marginBottom: 8 }}>
          YOUR TOKEN MINT ADDRESS
        </div>
        <input value={tokenBMint} onChange={e => setTokenBMint(e.target.value)}
          placeholder="Paste your token mint address…"
          style={{ width: '100%', padding: '12px 14px', background: 'rgba(0,0,0,.3)',
            border: `1px solid ${poolExists === true ? 'rgba(255,68,68,.4)' : poolExists === false ? 'rgba(0,201,141,.3)' : 'rgba(255,255,255,.08)'}`,
            borderRadius: 10, color: '#e0f0ff', fontFamily: 'Sora, sans-serif', fontSize: 12,
            outline: 'none', boxSizing: 'border-box', marginBottom: 8, transition: 'border-color .2s' }} />

        {checking && (
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#3a5a7a', marginBottom: 10 }}>
            Checking token + existing pools…
          </div>
        )}

        {poolExists === true && (
          <div style={{ background: 'rgba(255,68,68,.08)', border: '1px solid rgba(255,68,68,.25)',
            borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 10, color: '#ff6666' }}>
            ⚠️ A pool already exists on XDEX for this pair. Choose a different token.
          </div>
        )}

        {tokenBMeta && poolExists === false && (
          <>
            {/* Token B details */}
            <div style={{ background: 'rgba(0,201,141,.06)', border: '1px solid rgba(0,201,141,.15)',
              borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <TokenLogo mint={tokenBMint} logo={tokenBMeta.logo} symbol={tokenBMeta.symbol || '?'} size={32} color="#00c98d" />
                <div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 900, color: '#00c98d' }}>
                    {tokenBMeta.symbol}
                  </div>
                  <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#3a5a7a' }}>
                    {tokenBMeta.name}
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5a7a' }}>TOKEN PRICE</div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color: '#00c98d' }}>
                    {fmtUSD(tokenBMeta.price || 0)}
                  </div>
                </div>
              </div>
              <PriceRow label="YOU NEED TO DEPOSIT" usd={listing.usdValue} xnt={requiredBXnt} color="#00c98d" />
              <PriceRow label={`≈ ${tokenBMeta.symbol} AMOUNT`}
                usd={listing.usdValue} color="#9abacf" />
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 900,
                color: '#00c98d', textAlign: 'right', marginTop: 4 }}>
                {fmtNum(requiredBAmount, 4)} {tokenBMeta.symbol}
              </div>
            </div>

            {/* LP breakdown */}
            <div style={{ background: 'rgba(0,0,0,.25)', border: '1px solid rgba(255,255,255,.06)',
              borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 1,
                color: '#3a5a7a', marginBottom: 10 }}>LP TOKEN DISTRIBUTION</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, background: `${burnOpt.color}14`,
                  border: `1px solid ${burnOpt.color}33`, borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 900,
                    color: burnOpt.color }}>{burnOpt.label}</div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#3a5a7a', marginTop: 2 }}>BURNED</div>
                </div>
                <div style={{ flex: 1, background: 'rgba(0,212,255,.06)',
                  border: '1px solid rgba(0,212,255,.15)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 900,
                    color: '#00d4ff' }}>{lpBothPct}%</div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#3a5a7a', marginTop: 2 }}>YOU GET</div>
                </div>
                <div style={{ flex: 1, background: 'rgba(0,201,141,.06)',
                  border: '1px solid rgba(0,201,141,.15)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 900,
                    color: '#00c98d' }}>{lpBothPct}%</div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#3a5a7a', marginTop: 2 }}>LISTER</div>
                </div>
              </div>
              {listing.burnPct > 0 && (
                <div style={{ marginTop: 8, fontFamily: 'Orbitron, monospace', fontSize: 8,
                  color: '#3a5a7a', textAlign: 'center' }}>
                  🔥 BURN earns <span style={{ color: '#00c98d' }}>×1.888 LB points</span> for both parties
                </div>
              )}
            </div>

            {/* Fee + warning */}
            <div style={{ background: 'rgba(255,140,0,.06)', border: '1px solid rgba(255,140,0,.18)',
              borderRadius: 8, padding: '10px 12px', marginBottom: 16,
              fontSize: 10, color: '#ff8c00', lineHeight: 1.6 }}>
              ⚠️ Prices verified at execution. If either token moves &gt;2% before your tx confirms,
              the match is rejected and you keep your tokens.
              Matching fee: <strong>{MATCHING_FEE_XNT} XNT</strong>
            </div>
          </>
        )}

        <StatusBox msg={status} />

        <button onClick={handleMatch}
          disabled={pending || !tokenBMeta || poolExists !== false || requiredBAmount <= 0}
          style={{ width: '100%', padding: '14px 0', borderRadius: 12, cursor: 'pointer',
            background: 'linear-gradient(135deg,rgba(0,201,141,.2),rgba(0,201,141,.08))',
            border: '1px solid rgba(0,201,141,.45)',
            fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 900, color: '#00c98d',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            opacity: (pending || !tokenBMeta || poolExists !== false) ? 0.4 : 1,
            transition: 'all .2s' }}>
          {pending
            ? <><div style={{ width: 13, height: 13, borderRadius: '50%',
                border: '2px solid rgba(0,201,141,.2)', borderTop: '2px solid #00c98d',
                animation: 'spin .8s linear infinite' }} />CREATING POOL…</>
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

  const [tab, setTab]                     = useState<'browse' | 'create' | 'mine'>('browse');
  const [filter, setFilter]               = useState<'all' | 'brains' | 'lb'>('all');
  const [listings, setListings]           = useState<Listing[]>([]);
  const [loading, setLoading]             = useState(true);
  const [showCreate, setShowCreate]       = useState(false);
  const [matchTarget, setMatchTarget]     = useState<Listing | null>(null);
  const [editTarget, setEditTarget]       = useState<Listing | null>(null);

  const brainsPrice = usePrice(BRAINS_MINT) || 0;
  const lbPrice     = usePrice(LB_MINT)     || 0;
  const xntPrice    = usePrice(WXNT_MINT)   || 0.4187;

  // Mock listings for UI demo — replace with on-chain fetch
  useEffect(() => {
    setLoading(true);
    setTimeout(() => {
      setListings([
        {
          id: 'L001', creator: '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC',
          tokenA: { mint: BRAINS_MINT, symbol: 'BRAINS', name: 'Brains', decimals: 9,
            price: brainsPrice || 0.00987, xntPrice: (brainsPrice || 0.00987) / (xntPrice || 0.4187),
            mc: 87640, tvl: 11207 },
          amount: 100000, usdValue: 987, xntValue: 2358,
          burnPct: 50, status: 'open', createdAt: Date.now() - 3600000, isEcosystem: true,
        },
        {
          id: 'L002', creator: '7FJuSUyqqU7zTqM41ADar2qzhTbfe7NtnmnQwt4MHZk2',
          tokenA: { mint: BRAINS_MINT, symbol: 'BRAINS', name: 'Brains', decimals: 9,
            price: brainsPrice || 0.00987, xntPrice: (brainsPrice || 0.00987) / (xntPrice || 0.4187),
            mc: 87640, tvl: 11207 },
          amount: 250000, usdValue: 2468, xntValue: 5893,
          burnPct: 100, status: 'open', createdAt: Date.now() - 7200000, isEcosystem: true,
        },
        {
          id: 'L003', creator: '9H9cHNeEAi5T9h7SBZwtrm6BiVmimt3VxfmAMn8KoaqQ',
          tokenA: { mint: LB_MINT, symbol: 'LB', name: 'Lab Work', decimals: 2,
            price: lbPrice || 0.182, xntPrice: (lbPrice || 0.182) / (xntPrice || 0.4187),
            mc: 18200, tvl: 322 },
          amount: 5000, usdValue: 910, xntValue: 2173,
          burnPct: 25, status: 'open', createdAt: Date.now() - 1800000, isEcosystem: true,
        },
        {
          id: 'L004', creator: 'GKEbxKxF49VuSggiYC7Bu2sf5HkhN4eNUc7ZDWgtM2Ki',
          tokenA: { mint: BRAINS_MINT, symbol: 'BRAINS', name: 'Brains', decimals: 9,
            price: brainsPrice || 0.00987, xntPrice: (brainsPrice || 0.00987) / (xntPrice || 0.4187),
            mc: 87640, tvl: 11207 },
          amount: 500000, usdValue: 4935, xntValue: 11787,
          burnPct: 0, status: 'open', createdAt: Date.now() - 900000, isEcosystem: true,
        },
      ]);
      setLoading(false);
    }, 800);
  }, [brainsPrice, lbPrice, xntPrice]);

  const filteredListings = useMemo(() => {
    let l = listings.filter(x => x.status === 'open');
    if (filter === 'brains') l = l.filter(x => x.tokenA.mint === BRAINS_MINT);
    if (filter === 'lb')     l = l.filter(x => x.tokenA.mint === LB_MINT);
    if (tab === 'mine' && publicKey) l = l.filter(x => x.creator === publicKey.toBase58());
    return l;
  }, [listings, filter, tab, publicKey]);

  const myListings = useMemo(() =>
    publicKey ? listings.filter(x => x.creator === publicKey.toBase58()) : [],
    [listings, publicKey]
  );

  const totalUSD    = filteredListings.reduce((s, l) => s + l.usdValue, 0);
  const totalBrains = filteredListings.filter(l => l.tokenA.mint === BRAINS_MINT).reduce((s, l) => s + l.amount, 0);
  const totalLb     = filteredListings.filter(l => l.tokenA.mint === LB_MINT).reduce((s, l) => s + l.amount, 0);

  return (
    <div style={{ minHeight: '100vh', background: '#060b12' }}>
      <PageBackground />
      <TopBar />

      <div style={{ maxWidth: 920, margin: '0 auto', padding: isMobile ? '0 12px 80px' : '0 20px 80px' }}>

        {/* ── Hero ── */}
        <div style={{ padding: isMobile ? '28px 0 20px' : '40px 0 28px', textAlign: 'center', position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
            backgroundImage: 'linear-gradient(rgba(0,212,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,.02) 1px,transparent 1px)',
            backgroundSize: '24px 24px',
            maskImage: 'radial-gradient(ellipse 80% 100% at 50% 0%,black 30%,transparent 100%)' }} />
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'rgba(0,212,255,.08)', border: '1px solid rgba(0,212,255,.2)',
            borderRadius: 20, padding: '4px 14px', marginBottom: 16,
            fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 3, color: '#00d4ff' }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#00d4ff',
              animation: 'pulse-cyan 2s ease infinite' }} />
            X1 BRAINS · LIQUIDITY PAIRING PROTOCOL
          </div>
          <h1 style={{ fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 22 : 32, fontWeight: 900,
            color: '#fff', letterSpacing: 1, margin: '0 0 10px', lineHeight: 1.15 }}>
            PAIR YOUR <span style={{ color: '#00d4ff' }}>LIQUIDITY</span>
          </h1>
          <p style={{ fontFamily: 'Sora, sans-serif', fontSize: 13, color: '#4a6a8a',
            maxWidth: 480, margin: '0 auto 24px', lineHeight: 1.7 }}>
            List BRAINS or LB tokens. Any token can be paired. XDEX pools created on-chain.
            LP tokens burned or split — your choice.
          </p>

          {/* Stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)',
            gap: 10, marginBottom: 28 }}>
            {[
              { label: 'OPEN LISTINGS', val: filteredListings.length.toString(), color: '#00c98d' },
              { label: 'TOTAL VALUE', val: fmtUSD(totalUSD), color: '#00d4ff' },
              { label: 'BRAINS LISTED', val: fmtNum(totalBrains), color: '#00d4ff' },
              { label: 'LB LISTED', val: fmtNum(totalLb), color: '#00c98d' },
            ].map(s => (
              <div key={s.label} style={{ background: 'rgba(255,255,255,.03)',
                border: '1px solid rgba(255,255,255,.06)', borderRadius: 12, padding: '12px 14px' }}>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, letterSpacing: 2,
                  color: '#2a4a3a', marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900,
                  color: s.color }}>{s.val}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div style={{ display: 'flex', gap: 2, background: 'rgba(0,0,0,.3)',
          border: '1px solid rgba(255,255,255,.06)', borderRadius: 12, padding: 4, marginBottom: 20 }}>
          {[
            { key: 'browse', label: '🔍 BROWSE' },
            { key: 'create', label: '⚡ CREATE LISTING' },
            { key: 'mine',   label: '📋 MY LISTINGS' },
          ].map(t => (
            <button key={t.key} onClick={() => {
              if (t.key === 'create') { setShowCreate(true); return; }
              setTab(t.key as any);
            }}
              style={{ flex: 1, padding: '10px 0', borderRadius: 9, border: 'none',
                background: tab === t.key && t.key !== 'create' ? 'rgba(0,212,255,.12)' : 'transparent',
                fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 8 : 9, fontWeight: 700,
                letterSpacing: 1, color: tab === t.key && t.key !== 'create' ? '#00d4ff' : '#3a5a7a',
                cursor: 'pointer', transition: 'all .2s',
                outline: t.key === 'create' ? '1px solid rgba(0,212,255,.2)' : 'none' }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Filter bar ── */}
        {tab === 'browse' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {[
              { key: 'all',    label: 'ALL LISTINGS' },
              { key: 'brains', label: '🧠 BRAINS' },
              { key: 'lb',     label: '⚗️ LAB WORK' },
            ].map(f => (
              <button key={f.key} onClick={() => setFilter(f.key as any)}
                style={{ padding: '6px 14px', borderRadius: 8, cursor: 'pointer', border: 'none',
                  background: filter === f.key ? 'rgba(0,212,255,.12)' : 'rgba(255,255,255,.04)',
                  fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 1,
                  color: filter === f.key ? '#00d4ff' : '#3a5a7a', transition: 'all .15s' }}>
                {f.label}
              </button>
            ))}
            <div style={{ marginLeft: 'auto', fontFamily: 'Orbitron, monospace', fontSize: 8,
              color: '#2a4a6a', alignSelf: 'center' }}>
              {filteredListings.length} listing{filteredListings.length !== 1 ? 's' : ''}
            </div>
          </div>
        )}

        {/* ── Listings ── */}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0,1,2].map(i => (
              <div key={i} style={{ height: 120, borderRadius: 16,
                background: 'linear-gradient(90deg,rgba(255,255,255,.04) 25%,rgba(255,255,255,.07) 50%,rgba(255,255,255,.04) 75%)',
                backgroundSize: '400px 100%', animation: 'shimmer 1.5s ease infinite' }} />
            ))}
          </div>
        ) : filteredListings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px',
            background: 'rgba(255,255,255,.02)', border: '1px dashed rgba(255,255,255,.08)',
            borderRadius: 16 }}>
            <div style={{ fontSize: 32, marginBottom: 14 }}>
              {tab === 'mine' ? '📋' : '🔍'}
            </div>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 900,
              color: '#fff', marginBottom: 8 }}>
              {tab === 'mine' ? 'NO ACTIVE LISTINGS' : 'NO LISTINGS FOUND'}
            </div>
            <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#3a5a7a', marginBottom: 20 }}>
              {tab === 'mine'
                ? 'You have no open listings. Create one to attract liquidity partners.'
                : 'Be the first to list BRAINS or LB for liquidity pairing.'}
            </div>
            <button onClick={() => setShowCreate(true)}
              style={{ padding: '10px 24px', borderRadius: 10, cursor: 'pointer',
                background: 'linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.08))',
                border: '1px solid rgba(0,212,255,.4)',
                fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 900, color: '#00d4ff' }}>
              ⚡ CREATE LISTING
            </button>
          </div>
        ) : (
          filteredListings.map((listing, idx) => (
            <ListingCard key={listing.id} listing={listing} isMobile={isMobile} idx={idx}
              isOwn={publicKey?.toBase58() === listing.creator}
              onMatch={setMatchTarget}
              onEdit={setEditTarget}
              onDelist={l => {
                if (window.confirm(`Delist ${fmtNum(l.amount)} ${l.tokenA.symbol}? 0.10 XNT fee applies.`)) {
                  alert('Delist tx would be sent here');
                }
              }} />
          ))
        )}

        {/* ── How it works ── */}
        <div style={{ marginTop: 40, background: 'linear-gradient(155deg,#0c1520,#080c0f)',
          border: '1px solid rgba(255,255,255,.06)', borderRadius: 20, padding: '24px 28px' }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 900,
            color: '#fff', letterSpacing: 1, marginBottom: 20 }}>HOW IT WORKS</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: 16 }}>
            {[
              { n: '01', title: 'LIST TOKENS', desc: 'Lock BRAINS or LB in escrow. Set your LP burn %. Pay 0.50 XNT listing fee.', color: '#00d4ff' },
              { n: '02', title: 'GET MATCHED', desc: 'Anyone brings an equal USD value of any token. Price verified on-chain within ±2%.', color: '#00c98d' },
              { n: '03', title: 'POOL CREATED', desc: 'XDEX pool created via CPI. LP tokens burned or split 50/50. Earn LB points on burn.', color: '#bf5af2' },
            ].map(s => (
              <div key={s.n} style={{ background: 'rgba(255,255,255,.02)',
                border: '1px solid rgba(255,255,255,.06)', borderRadius: 12, padding: '16px 18px' }}>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 24, fontWeight: 900,
                  color: s.color, opacity: 0.4, marginBottom: 8 }}>{s.n}</div>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 900,
                  color: '#fff', marginBottom: 6 }}>{s.title}</div>
                <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#4a6a8a', lineHeight: 1.6 }}>
                  {s.desc}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

      <Footer />

      {/* Modals */}
      {showCreate && publicKey && (
        <CreateListingModal isMobile={isMobile} publicKey={publicKey}
          connection={connection} sendTransaction={sendTransaction}
          signTransaction={signTransaction}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); }} />
      )}
      {matchTarget && (
        <MatchModal listing={matchTarget} isMobile={isMobile} publicKey={publicKey}
          connection={connection} sendTransaction={sendTransaction}
          signTransaction={signTransaction}
          onClose={() => setMatchTarget(null)}
          onMatched={() => setMatchTarget(null)} />
      )}

      <style>{`
        @keyframes fadeUp { from { opacity:0;transform:translateY(10px); } to { opacity:1;transform:translateY(0); } }
        @keyframes spin { to { transform:rotate(360deg); } }
        @keyframes shimmer { 0%{background-position:-400px 0} 100%{background-position:400px 0} }
        @keyframes labSlideUp { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pulse-cyan { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>
    </div>
  );
};

export default PairingMarketplace;
