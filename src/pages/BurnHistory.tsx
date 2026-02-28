// src/pages/BurnHistory.tsx
// ─────────────────────────────────────────────────────────────────────────────
// BURN HISTORY — Per-wallet BRAINS burn ledger
// Portal header lives in src/components/BurnPortal.tsx
// ─────────────────────────────────────────────────────────────────────────────

import React, { FC, useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { BRAINS_MINT } from '../constants';
import {
  TopBar, PageBackground, Footer,
  SectionHeader, AddressBar,
} from '../components/UI';
import { injectBurnStyles } from '../components/BurnedBrainsBar';
import { BurnPortal, injectPortalStyles, BurnTransactions } from '../components/BurnPortal';
import { BurnLeaderboard, injectLeaderboardStyles, BurnerEntry } from '../components/BurnLeaderboard';
import { getLabWorkPtsForWallet } from '../lib/supabase';

injectBurnStyles();
injectPortalStyles();
injectLeaderboardStyles();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const INITIAL_SUPPLY = 8_880_000;
const EXPLORER_BASE  = 'https://explorer.mainnet.x1.xyz/tx/';

// ─── BURN TIER LOOKUP (mirrors BurnLeaderboard TIERS) ────────────────────────
const BH_TIERS = [
  { min:1_000_000, label:'INCINERATOR',  icon:'☠️', neon:'#fffaee', flavor:'Universal collapse — the final burn' },
  { min:850_000,   label:'APOCALYPSE',   icon:'💀', neon:'#ff1155', flavor:'Approaching terminal entropy'        },
  { min:700_000,   label:'GODSLAYER',    icon:'⚔️', neon:'#dd22ff', flavor:'Event horizon crossed'              },
  { min:500_000,   label:'DISINTEGRATE', icon:'☢️', neon:'#ff2277', flavor:'Stellar annihilation event'         },
  { min:350_000,   label:'TERMINATE',    icon:'⚡', neon:'#ff4411', flavor:'Reaching critical mass'             },
  { min:200_000,   label:'ANNIHILATE',   icon:'💥', neon:'#ff6622', flavor:'Industrial-grade incineration'      },
  { min:100_000,   label:'OVERWRITE',    icon:'⚙️', neon:'#ff8811', flavor:'Ceremonial destruction'             },
  { min:50_000,    label:'INFERNO',      icon:'🔥', neon:'#ffaa44', flavor:'Controlled immolation begins'       },
  { min:25_000,    label:'FLAME',        icon:'🕯️', neon:'#ffdd77', flavor:'The ember takes hold'               },
  { min:1,         label:'SPARK',        icon:'✦',  neon:'#bbddff', flavor:'First spark extinguished'           },
  { min:0,         label:'UNRANKED',     icon:'○',  neon:'#8899aa', flavor:'Burn Your Brains Off'               },
];
const getBHTier = (pts: number) => BH_TIERS.find(t => pts >= t.min) ?? BH_TIERS[BH_TIERS.length - 1];

// ─── TYPES ────────────────────────────────────────────────────────────────────
interface BurnTx {
  signature: string;
  amount:    number;
  timestamp: number | null;
  slot:      number;
}

interface ScanState {
  txs:       BurnTx[];
  total:     number;
  loading:   boolean;
  done:      boolean;
  error:     string | null;
  scannedAt: Date | null;
}

// ─── HOOKS ────────────────────────────────────────────────────────────────────
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 640 : false
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

// ─── ANIMATED COUNTER ─────────────────────────────────────────────────────────
const AnimatedCounter: FC<{ value: number; decimals?: number; duration?: number }> = ({
  value, decimals = 0, duration = 1000,
}) => {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const raf  = useRef<number>(0);
  useEffect(() => {
    const from = prev.current, to = value;
    if (from === to) return;
    let start: number | null = null;
    cancelAnimationFrame(raf.current);
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * e;
      setDisplay(decimals > 0 ? parseFloat(v.toFixed(decimals)) : Math.floor(v));
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, decimals, duration]);
  return <>{display.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const shortSig = (sig: string) => `${sig.slice(0, 10)}…${sig.slice(-8)}`;

const fmtDate = (ts: number | null) => {
  if (!ts) return { date: '—', time: '—', relative: '—' };
  const d    = new Date(ts * 1000);
  const diff = Math.floor((Date.now() - ts * 1000) / 1000);
  let relative = '';
  if      (diff < 60)    relative = `${diff}s ago`;
  else if (diff < 3600)  relative = `${Math.floor(diff / 60)}m ago`;
  else if (diff < 86400) relative = `${Math.floor(diff / 3600)}h ago`;
  else                   relative = `${Math.floor(diff / 86400)}d ago`;
  return {
    date: d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    relative,
  };
};

// ─── BURN SCANNER ─────────────────────────────────────────────────────────────
async function scanBurnHistory(
  connection: ReturnType<typeof useConnection>['connection'],
  walletPubkey: PublicKey,
  decimals: number,
  signal: AbortSignal,
  onProgress: (txs: BurnTx[], total: number, done: boolean) => void,
): Promise<void> {
  const mintPubkey = new PublicKey(BRAINS_MINT);
  const mintStr    = mintPubkey.toBase58();
  const divisor    = Math.pow(10, decimals);

  let ataAddress: PublicKey | null = null;
  try {
    ataAddress = getAssociatedTokenAddressSync(mintPubkey, walletPubkey, false, TOKEN_2022_PROGRAM_ID);
  } catch {}

  let scanAddress = ataAddress ?? walletPubkey;
  try {
    if (ataAddress) {
      const info = await connection.getAccountInfo(ataAddress);
      if (!info) scanAddress = walletPubkey;
    }
  } catch { scanAddress = walletPubkey; }

  const allTxs: BurnTx[] = [];
  let runningTotal = 0;
  let before: string | undefined;

  while (true) {
    if (signal.aborted) { onProgress(allTxs, runningTotal, true); return; }

    const sigs = await connection.getSignaturesForAddress(scanAddress, {
      limit: 100,
      ...(before ? { before } : {}),
    });

    if (!sigs.length) { onProgress(allTxs, runningTotal, true); return; }

    const txs = await connection.getParsedTransactions(
      sigs.map(s => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    );

    for (let i = 0; i < txs.length; i++) {
      const tx  = txs[i];
      const sig = sigs[i];
      if (!tx || tx.meta?.err) continue;

      const allIxs: unknown[] = [...(tx.transaction.message.instructions ?? [])];
      for (const inner of tx.meta?.innerInstructions ?? []) allIxs.push(...inner.instructions);

      for (const ix of allIxs) {
        const p = ix as Record<string, unknown>;
        if (p.program !== 'spl-token') continue;
        const parsed = p.parsed as Record<string, unknown> | undefined;
        if (!parsed) continue;
        const type = parsed.type as string;
        if (type !== 'burn' && type !== 'burnChecked') continue;
        const info = parsed.info as Record<string, unknown> | undefined;
        if (!info || (info.mint as string) !== mintStr) continue;

        const walletStr   = walletPubkey.toBase58();
        const ataStr      = ataAddress?.toBase58();
        const accountKeys = (tx.transaction.message.accountKeys ?? []) as Array<{ pubkey?: { toBase58?: () => string } }>;

        const isOurs = (e: { mint?: string; owner?: string; accountIndex?: number }) => {
          if (e.mint !== mintStr) return false;
          if (e.owner === walletStr) return true;
          if (ataStr && typeof e.accountIndex === 'number') {
            const k = accountKeys[e.accountIndex]?.pubkey?.toBase58?.() ?? '';
            if (k === ataStr) return true;
          }
          return false;
        };

        const pre    = (tx.meta?.preTokenBalances  ?? []).find(isOurs as any);
        const post   = (tx.meta?.postTokenBalances ?? []).find(isOurs as any);
        const preUi  = (pre  as any)?.uiTokenAmount?.uiAmount ?? null;
        const postUi = (post as any)?.uiTokenAmount?.uiAmount ?? null;

        let amount = 0;
        if (preUi !== null && postUi !== null) {
          const diff = preUi - postUi;
          if (diff > 0) amount = diff;
        } else {
          const ta  = info.tokenAmount as Record<string, unknown> | undefined;
          const ui  = ta ? Number((ta as any).uiAmount ?? 0) : 0;
          const raw = ta ? Number((ta as any).amount  ?? 0) : Number(info.amount ?? 0);
          amount = ui > 0 ? ui : raw / divisor;
        }

        if (amount > 0) {
          runningTotal += amount;
          allTxs.push({ signature: sig.signature, amount, timestamp: sig.blockTime ?? null, slot: sig.slot });
          break;
        }
      }
    }

    onProgress([...allTxs], runningTotal, false);
    const done = sigs.length < 100;
    if (done) { onProgress([...allTxs], runningTotal, true); return; }
    before = sigs[sigs.length - 1].signature;
  }
}

// ─── TX ROW ───────────────────────────────────────────────────────────────────


// ─── BH TIER BADGE — xyon gaming style ──────────────────────────────────────
const BHTierBadge: FC<{ points: number }> = ({ points }) => {
  const tier   = getBHTier(points);
  const isTop  = tier.min >= 1_000_000;
  const next   = BH_TIERS.slice().reverse().find(t => t.min > tier.min) ?? null;
  const tierPct = next
    ? Math.min(((points - tier.min) / (next.min - tier.min)) * 100, 100)
    : 100;
  return (
    <div style={{
      display:'inline-flex', alignItems:'center', gap:7,
      padding:'5px 12px 5px 8px',
      background:`linear-gradient(135deg,${tier.neon}14,#06040e)`,
      border:`1px solid ${tier.neon}44`,
      borderLeft:`2px solid ${tier.neon}`,
      borderRadius:5,
      boxShadow:`0 0 12px ${tier.neon}18`,
      position:'relative', overflow:'hidden',
    }}>
      <span style={{ position:'absolute', inset:0, background:`linear-gradient(90deg,transparent,${tier.neon}05,transparent)`, animation:'bar-shimmer 3s ease-in-out infinite', pointerEvents:'none' }} />
      <span style={{ position:'absolute', top:0, right:0, width:5, height:5, borderTop:`1px solid ${tier.neon}66`, borderRight:`1px solid ${tier.neon}66` }} />
      <span style={{ fontSize:15, filter:`drop-shadow(0 0 5px ${tier.neon})`, position:'relative', zIndex:1 }}>{tier.icon}</span>
      <div style={{ position:'relative', zIndex:1 }}>
        <div style={{ fontFamily:'Orbitron, monospace', fontSize:5, color:'#aabbcc', letterSpacing:2, marginBottom:1 }}>BURN TIER</div>
        <div style={{ fontFamily:'Orbitron, monospace', fontSize:11, fontWeight:900, color:tier.neon, letterSpacing:1.5, textShadow:`0 0 8px ${tier.neon}66`, lineHeight:1 }}>{tier.label}</div>
        {next && <div style={{ fontFamily:'Orbitron, monospace', fontSize:6, color:'#aabbcc', marginTop:2 }}>{tierPct.toFixed(0)}% to {next.label}</div>}
      </div>
      {isTop && <span style={{ position:'relative', zIndex:1, fontFamily:'Orbitron, monospace', fontSize:6, color:'#ff9933', padding:'1px 5px', background:'rgba(255,140,0,.12)', border:'1px solid rgba(255,140,0,.3)', borderRadius:3 }}>MAX</span>}
    </div>
  );
};



// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
const BurnHistory: FC = () => {
  const { connection } = useConnection();
  const { publicKey }  = useWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const navigate        = useNavigate();
  const isMobile       = useIsMobile();

  // Auto-scroll to top and re-render when wallet connects
  useEffect(() => {
    if (publicKey) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [publicKey]);

  const [scan,       setScan]       = useState<ScanState>({ txs: [], total: 0, loading: false, done: false, error: null, scannedAt: null });
  const [globalBurn, setGlobalBurn] = useState<number | null>(null);
  const [lbEntries, setLbEntries]   = useState<BurnerEntry[]>([]);
  const [decimals,   setDecimals]   = useState(6);
  const [labWorkPts, setLabWorkPts] = useState(0);

  // Fetch lab work points from Supabase for connected wallet
  useEffect(() => {
    if (!publicKey) { setLabWorkPts(0); return; }
    const addr = publicKey.toBase58();
    getLabWorkPtsForWallet(addr)
      .then(pts => { if (mountedRef.current) setLabWorkPts(pts); })
      .catch(() => {
        // Fallback to localStorage
        try {
          const raw = localStorage.getItem('brains_labwork_rewards');
          if (raw) {
            const rewards = JSON.parse(raw);
            if (Array.isArray(rewards)) {
              const total = rewards.filter((r: any) => r.address === addr).reduce((s: number, r: any) => s + (r.lbPoints || 0), 0);
              if (mountedRef.current) setLabWorkPts(total);
            }
          }
        } catch {}
      });
  }, [publicKey]);

  const abortRef   = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!connection) return;
    getMint(connection, new PublicKey(BRAINS_MINT), 'confirmed', TOKEN_2022_PROGRAM_ID)
      .then(m => {
        setDecimals(m.decimals);
        setGlobalBurn(Math.max(0, INITIAL_SUPPLY - Number(m.supply) / Math.pow(10, m.decimals)));
      })
      .catch(() => {});
  }, [connection]);

  const startScan = useCallback(async () => {
    if (!connection || !publicKey) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScan({ txs: [], total: 0, loading: true, done: false, error: null, scannedAt: null });
    try {
      await scanBurnHistory(
        connection, publicKey, decimals, ctrl.signal,
        (txs, total, done) => {
          if (!mountedRef.current || ctrl.signal.aborted) return;
          setScan({ txs, total, loading: !done, done, error: null, scannedAt: done ? new Date() : null });
        },
      );
    } catch (e: any) {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setScan(prev => ({ ...prev, loading: false, error: e.message ?? 'Scan failed' }));
    }
  }, [connection, publicKey, decimals]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!publicKey) {
      abortRef.current?.abort();
      setScan({ txs: [], total: 0, loading: false, done: false, error: null, scannedAt: null });
      return;
    }
    startScan();
  }, [startScan, publicKey]);

  // ── Derived stats ──────────────────────────────────────────────────────────



  return (
    <div style={{
      minHeight: '100vh', background: '#080c10',
      padding: isMobile ? '70px 12px 40px' : '90px 24px 40px',
      position: 'relative', overflow: 'hidden',
    }}>
      <TopBar />
      <PageBackground />

      <style>{`
        @keyframes burn-pulse  { 0%,100%{opacity:.35} 50%{opacity:1} }
        @keyframes heat-wave   { 0%,100%{background-position:0% 50%} 50%{background-position:100% 50%} }
        @keyframes scanWipe    { 0%{top:-2px} 100%{top:100%} }
        @keyframes tier-float  { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
        @keyframes tier-lock   { 0%,100%{opacity:.18} 50%{opacity:.28} }
        @keyframes cta-pulse   { 0%,100%{box-shadow:0 0 22px rgba(160,60,255,.35),0 0 0 0 rgba(160,60,255,.3)} 50%{box-shadow:0 0 36px rgba(160,60,255,.55),0 0 0 8px rgba(160,60,255,0)} }
        @keyframes orb-drift   { 0%{transform:translate(0,0) scale(1)} 33%{transform:translate(30px,-20px) scale(1.05)} 66%{transform:translate(-20px,15px) scale(.97)} 100%{transform:translate(0,0) scale(1)} }
        @keyframes bar-shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
        @keyframes unlock-glow { 0%,100%{opacity:0} 50%{opacity:1} }
        @keyframes bp-fade-up  { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes bp-spin     { to{transform:rotate(360deg)} }
        select option { background:#0f1820; color:#e0e0e0; }
        input::placeholder { color:#3a5a6a; }
        input:focus { border-color:rgba(255,120,40,0.5)!important; box-shadow:0 0 10px rgba(255,80,0,0.15); }
      `}</style>

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 960, margin: '0 auto' }}>

        {/* ── FIRE PORTAL HEADER ── */}
        <BurnPortal isMobile={isMobile} />

        {/* ── ADDRESS BAR ── */}
        {publicKey && <AddressBar address={publicKey.toBase58()} />}

        {/* ── NOT CONNECTED — GAME LOBBY ── */}
        {!publicKey && (
          <div style={{ animation:'bp-fade-up 0.5s ease both' }}>

            {/* ── HERO SECTION ── */}
            <div style={{
              position:'relative', overflow:'hidden', borderRadius:16, marginBottom:20,
              background:'linear-gradient(160deg,#04060f 0%,#07050e 40%,#050a12 100%)',
              border:'1px solid rgba(180,80,255,0.15)',
              padding: isMobile?'32px 20px 28px':'48px 40px 40px',
              textAlign:'center',
            }}>
              {/* grid overlay */}
              <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(100,60,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.04) 1px,transparent 1px)', backgroundSize:'32px 32px', pointerEvents:'none' }} />
              {/* corner brackets */}
              <div style={{ position:'absolute', top:12, left:12, width:18, height:18, borderTop:'1.5px solid rgba(180,80,255,.5)', borderLeft:'1.5px solid rgba(180,80,255,.5)', borderRadius:'2px 0 0 0' }} />
              <div style={{ position:'absolute', top:12, right:12, width:18, height:18, borderTop:'1.5px solid rgba(255,140,0,.5)', borderRight:'1.5px solid rgba(255,140,0,.5)', borderRadius:'0 2px 0 0' }} />
              <div style={{ position:'absolute', bottom:12, left:12, width:18, height:18, borderBottom:'1.5px solid rgba(255,140,0,.5)', borderLeft:'1.5px solid rgba(255,140,0,.5)', borderRadius:'0 0 0 2px' }} />
              <div style={{ position:'absolute', bottom:12, right:12, width:18, height:18, borderBottom:'1.5px solid rgba(180,80,255,.5)', borderRight:'1.5px solid rgba(180,80,255,.5)', borderRadius:'0 0 2px 0' }} />

              {/* ambient orbs — purple/orange xyon palette */}
              <div style={{ position:'absolute', top:'5%', left:'2%', width:260, height:260, borderRadius:'50%', background:'radial-gradient(circle,rgba(160,60,255,.09) 0%,transparent 65%)', animation:'orb-drift 14s ease-in-out infinite', pointerEvents:'none' }} />
              <div style={{ position:'absolute', bottom:'0%', right:'5%', width:200, height:200, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,130,0,.07) 0%,transparent 65%)', animation:'orb-drift 18s ease-in-out 5s infinite', pointerEvents:'none' }} />
              <div style={{ position:'absolute', top:'35%', right:'10%', width:140, height:140, borderRadius:'50%', background:'radial-gradient(circle,rgba(0,220,255,.05) 0%,transparent 65%)', animation:'orb-drift 11s ease-in-out 2s infinite', pointerEvents:'none' }} />
              <div style={{ position:'absolute', bottom:'15%', left:'20%', width:100, height:100, borderRadius:'50%', background:'radial-gradient(circle,rgba(57,255,136,.04) 0%,transparent 65%)', animation:'orb-drift 9s ease-in-out 3s infinite', pointerEvents:'none' }} />

              {/* top badge */}
              <div style={{ display:'inline-flex', alignItems:'center', gap:8, marginBottom:20, padding:'5px 18px', background:'rgba(150,60,255,.1)', border:'1px solid rgba(150,60,255,.3)', borderRadius:20 }}>
                <span style={{ width:5, height:5, borderRadius:'50%', background:'#39ff88', boxShadow:'0 0 8px #39ff88', display:'inline-block', animation:'burn-pulse 1.8s ease infinite' }} />
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:'#ee99ff', letterSpacing:3, textShadow:'0 0 10px rgba(220,120,255,0.85), 0 0 24px rgba(160,50,255,0.5)', fontWeight:700 }}>BRAINS 🧪 LAB WORK · INCINERATOR PROTOCOL</span>
                <span style={{ width:5, height:5, borderRadius:'50%', background:'#aa44ff', boxShadow:'0 0 8px #aa44ff', display:'inline-block', animation:'burn-pulse 1.5s ease 0.9s infinite' }} />
              </div>

              {/* Main headline */}
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?24:38, fontWeight:900, letterSpacing:isMobile?2:5, lineHeight:1.1, marginBottom:14, position:'relative', zIndex:1 }}>
                <span style={{ color:'#ff9933' }}>BURN.</span>
                <span style={{ color:'#cc55ff' }}> RANK.</span>
                <span style={{ color:'#00ddff' }}> ASCEND.</span>
              </div>
              <div style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?13:15, color:'#c0d0e0', maxWidth:560, margin:'0 auto 28px', lineHeight:1.7, position:'relative', zIndex:1 }}>
                Burn BRAINS. Earn LB Points. Climb the incinerator ranks.<br/>
                <span style={{ color:'#ffaa44', fontWeight:700 }}>Every BRAIN burned = 1.888 LB Points</span><br/>
                <span style={{ color:'#39ff88', fontWeight:700 }}>⚡ AMP Bonuses</span><span style={{ color:'#8899aa' }}> — earn stacking multipliers from weekly challenges (up to +19.38%)</span><br/>
                <span style={{ color:'#00ccff', fontWeight:700 }}>🧪 Lab Work Points</span><span style={{ color:'#8899aa' }}> — promote BRAINS, create content & run raids to earn bonus LB Points</span>
              </div>

              {/* Stats row */}
              <div style={{ display:'flex', justifyContent:'center', gap:isMobile?12:28, marginBottom:32, flexWrap:'wrap', position:'relative', zIndex:1 }}>
                {[
                  { val:'10',      label:'TIER RANKS',       icon:'🏆', col:'#cc55ff' },
                  { val:'1.888×',  label:'BURN MULTIPLIER',  icon:'🔥', col:'#ff9933' },
                  { val:'+19.38%', label:'MAX AMP STACK',    icon:'⚡', col:'#39ff88' },
                  { val:'🧪',     label:'LAB WORK PTS',     icon:'',   col:'#00ccff' },
                  { val:'∞',       label:'BURN HISTORY',     icon:'📋', col:'#cc88ff' },
                ].map((s,i) => (
                  <div key={i} style={{ textAlign:'center', position:'relative' }}>
                    <div style={{ position:'absolute', inset:'-8px -12px', background:`radial-gradient(circle,${s.col}08,transparent 70%)`, pointerEvents:'none' }} />
                    <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?22:28, fontWeight:900, color:s.col, letterSpacing:1, textShadow:`0 0 20px ${s.col}88` }}>{s.icon} {s.val}</div>
                    <div style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#c0d0e8', letterSpacing:2, marginTop:4 }}>{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Connect prompt — no duplicate button, use top bar wallet connect */}
              <div style={{ position:'relative', zIndex:1, display:'inline-flex', flexDirection:'column', alignItems:'center', gap:8 }}>
                <div style={{
                  display:'inline-flex', alignItems:'center', gap:10,
                  padding:'10px 22px',
                  background:'rgba(140,50,255,.06)',
                  border:'1px solid rgba(140,50,255,.2)',
                  borderRadius:8,
                }}>
                  <span style={{ width:6, height:6, borderRadius:'50%', background:'#39ff88', boxShadow:'0 0 8px #39ff88', display:'inline-block', animation:'burn-pulse 1.8s ease infinite' }} />
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?10:11, color:'#cc88ff', letterSpacing:2 }}>
                    CONNECT WALLET VIA TOP BAR TO ENTER
                  </span>
                  <span style={{ width:6, height:6, borderRadius:'50%', background:'#aa44ff', display:'inline-block', animation:'burn-pulse 1.5s ease 0.9s infinite' }} />
                </div>
                <span style={{ fontFamily:'Sora, sans-serif', fontSize:11, color:'#aabbcc' }}>Your burn history, LB Points, AMP bonuses & Lab Work Points load automatically</span>
              </div>
            </div>

            {/* ── TIER RANKS SECTION ── */}
            <div style={{
              borderRadius:14, overflow:'hidden',
              background:'#04060e',
              border:'1px solid rgba(120,60,255,.12)',
              marginBottom:24,
            }}>
              {/* Section header */}
              <div style={{
                padding:isMobile?'16px 18px':'20px 28px',
                background:'linear-gradient(90deg,rgba(140,50,255,.1),rgba(57,255,136,.04),rgba(255,120,0,.04),transparent)',
                borderBottom:'1px solid rgba(120,60,255,.12)',
                display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8,
              }}>
                <div>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?12:15, fontWeight:800, color:'#ffffff', letterSpacing:3, marginBottom:4 }}>
                    ☠️ INCINERATOR RANKS
                  </div>
                  <div style={{ fontFamily:'Sora, sans-serif', fontSize:11, color:'#c0d0e8' }}>
                    Connect your wallet to reveal your rank · Phases of Incinerator
                  </div>
                </div>
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#cc88ff', letterSpacing:2, padding:'4px 12px', background:'rgba(140,50,255,.1)', border:'1px solid rgba(140,50,255,.25)', borderRadius:4 }}>
                  10 TIERS
                </div>
              </div>

              {/* Tier cards grid */}
              <div style={{ display:'grid', gridTemplateColumns: isMobile?'1fr':'1fr 1fr', gap:1, background:'rgba(80,40,180,.06)' }}>
                {BH_TIERS.filter(t => t.min > 0).reverse().map((t, i, arr) => {
                  const isTop    = t.min >= 1_000_000;
                  const rank     = arr.length - i; // 1=INCINERATOR (hardest) → 10=SPARK (easiest)
                  const progress = (arr.length - rank + 1) / arr.length; // INCINERATOR=full, SPARK=small
                  const threshStr = t.min >= 1_000_000 ? `${(t.min/1e6).toFixed(0)}M` : t.min >= 1000 ? `${(t.min/1000).toFixed(0)}K` : `${t.min}`;
                  const ptsStr    = t.min >= 1_000_000 ? `${(t.min*1.888/1e6).toFixed(2)}M` : `${Math.floor(t.min*1.888/1000)}K`;
                  // xyon color per tier: cycle purple→orange→cyan based on rank
                  const accentA  = isTop ? '#ffffff' : t.neon;
                  const cardBg   = isTop
                    ? 'linear-gradient(135deg,#0e0418 0%,#180830 50%,#100a00 100%)'
                    : i % 3 === 0
                      ? 'linear-gradient(135deg,#06040e,#0a0618)'
                      : i % 3 === 1
                        ? 'linear-gradient(135deg,#07050a,#0d0610)'
                        : 'linear-gradient(135deg,#050810,#080c18)';

                  return (
                    <div key={i} style={{
                      position:'relative', overflow:'hidden',
                      background: cardBg,
                      padding: isMobile?'14px 14px':'16px 20px',
                      borderBottom: i < arr.length-1 && isMobile ? '1px solid rgba(80,40,180,.08)' : 'none',
                    }}>
                      {/* decorative layers */}
                      <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(100,60,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.03) 1px,transparent 1px)', backgroundSize:'20px 20px', pointerEvents:'none' }} />
                      <div style={{ position:'absolute', left:0, top:0, bottom:0, width:3, background:`linear-gradient(180deg,#ff9933 0%,${accentA} 40%,#39ff88 70%,#aa44ff 100%)` }} />
                      <div style={{ position:'absolute', left:3, top:'20%', bottom:'20%', width:1, background:`linear-gradient(180deg,transparent,${accentA}44,transparent)` }} />
                      <div style={{ position:'absolute', inset:0, background:`linear-gradient(90deg,transparent,${accentA}04,transparent)`, backgroundSize:'200% 100%', animation:`bar-shimmer ${4+i*.3}s ease-in-out ${i*.15}s infinite`, pointerEvents:'none', zIndex:0 }} />
                      {isTop && <div style={{ position:'absolute', inset:0, background:'linear-gradient(90deg,transparent,rgba(200,120,255,.06),transparent)', backgroundSize:'200% 100%', animation:'bar-shimmer 3s ease-in-out infinite', pointerEvents:'none' }} />}

                      {/* Main layout: 3 columns — [rank+icon] [name/info] [thresholds] */}
                      <div style={{ display:'grid', gridTemplateColumns:'80px 1fr 160px', alignItems:'center', gap:16, position:'relative', zIndex:1 }}>

                        {/* Col 1 — rank + icon stacked */}
                        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6 }}>
                          <div style={{
                            width:24, height:24, borderRadius:4,
                            background:`linear-gradient(135deg,${accentA}22,${accentA}08)`,
                            border:`1px solid ${accentA}55`,
                            display:'flex', alignItems:'center', justifyContent:'center',
                          }}>
                            <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:900, color:accentA }}>{rank}</span>
                          </div>
                          <div style={{
                            width:isMobile?44:50, height:isMobile?44:50,
                            display:'flex', alignItems:'center', justifyContent:'center',
                            background:`radial-gradient(circle,${accentA}20 0%,${accentA}08 60%,transparent 100%)`,
                            border:`1px solid ${accentA}55`,
                            borderRadius:8, fontSize:isMobile?22:26,
                            boxShadow:`0 0 16px ${accentA}22`,
                            filter: `drop-shadow(0 0 ${isTop?10:6}px ${accentA}88)`,
                            animation:`tier-float ${2.8+i*0.25}s ease-in-out ${i*0.12}s infinite`,
                            position:'relative',
                          }}>
                            {isTop && <>
                              <span style={{ position:'absolute', top:2, right:2, width:4, height:4, borderTop:'1px solid #ff9933', borderRight:'1px solid #ff9933' }} />
                              <span style={{ position:'absolute', bottom:2, left:2, width:4, height:4, borderBottom:'1px solid #aa44ff', borderLeft:'1px solid #aa44ff' }} />
                            </>}
                            {t.icon}
                          </div>
                        </div>

                        {/* Col 2 — name, badge, flavor, progress */}
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?13:15, fontWeight:900, color:accentA, letterSpacing:2, textShadow:`0 0 12px ${accentA}66`, marginBottom:6 }}>
                            {t.label}
                          </div>
                          {(() => {
                            const badges: Record<string, { label: string; bg: string; border: string; color: string }> = {
                              'INCINERATOR':  { label: '☠ MAX TIER',    bg: 'rgba(255,220,100,.15)', border: 'rgba(255,200,50,.5)',  color: '#ffe066' },
                              'APOCALYPSE':   { label: '💀 DOOM RANK',   bg: 'rgba(255,0,60,.12)',    border: 'rgba(255,30,80,.4)',   color: '#ff4477' },
                              'GODSLAYER':    { label: '⚔ DIVINE',       bg: 'rgba(180,0,255,.12)',   border: 'rgba(200,50,255,.4)',  color: '#cc44ff' },
                              'DISINTEGRATE': { label: '☢ NUCLEAR',      bg: 'rgba(255,20,100,.1)',   border: 'rgba(255,50,120,.35)', color: '#ff3388' },
                              'TERMINATE':    { label: '⚡ CRITICAL',     bg: 'rgba(255,60,10,.12)',   border: 'rgba(255,80,20,.4)',   color: '#ff5522' },
                              'ANNIHILATE':   { label: '💥 INDUSTRIAL',  bg: 'rgba(255,90,0,.12)',    border: 'rgba(255,110,20,.4)',  color: '#ff7733' },
                              'OVERWRITE':    { label: '⚙ CEREMONIAL',   bg: 'rgba(255,130,0,.1)',    border: 'rgba(255,150,20,.35)', color: '#ff9933' },
                              'INFERNO':      { label: '🔥 IGNITED',      bg: 'rgba(255,160,30,.1)',   border: 'rgba(255,180,50,.35)', color: '#ffaa44' },
                              'FLAME':        { label: '🕯 EMBER',        bg: 'rgba(255,200,60,.1)',   border: 'rgba(255,210,80,.3)',  color: '#ffcc55' },
                              'SPARK':        { label: '✦ INITIATE',      bg: 'rgba(150,200,255,.1)',  border: 'rgba(170,220,255,.3)', color: '#aaddff' },
                            };
                            const b = badges[t.label];
                            return b ? (
                              <div style={{ marginBottom:8 }}>
                                <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, letterSpacing:1, padding:'2px 8px', background:b.bg, border:`1px solid ${b.border}`, borderRadius:3, color:b.color, whiteSpace:'nowrap' }}>
                                  {b.label}
                                </span>
                              </div>
                            ) : null;
                          })()}
                          <div style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?10:11, color:'#b0ccdd', fontStyle:'italic', marginBottom:8 }}>
                            "{t.flavor}"
                          </div>
                          <div style={{ height:3, borderRadius:2, background:'rgba(255,255,255,.06)', overflow:'hidden' }}>
                            <div style={{ height:'100%', width:`${progress*100}%`, background:`linear-gradient(90deg,#6633cc,${accentA},#39ff88)`, borderRadius:2, transition:'width .5s ease' }} />
                          </div>
                        </div>

                        {/* Col 3 — thresholds right-aligned */}
                        <div style={{ textAlign:'right' }}>
                          <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?15:18, fontWeight:900, color:accentA, letterSpacing:1, lineHeight:1 }}>
                            {threshStr}+
                          </div>
                          <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#aabbcc', letterSpacing:2, marginTop:3, marginBottom:10 }}>BRAINS BURNED</div>
                          <div style={{ padding:'6px 12px', background:'rgba(30,160,80,.12)', border:'1px solid rgba(57,255,136,.3)', borderRadius:5, display:'inline-block' }}>
                            <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?12:14, fontWeight:900, color:'#55ffaa', lineHeight:1 }}>≥{ptsStr}</div>
                            <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#39ff88', marginTop:3, letterSpacing:2 }}>PTS</div>
                          </div>
                        </div>

                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Bottom bar — info only, no duplicate connect button */}
              <div style={{
                padding:isMobile?'12px 18px':'14px 28px',
                background:'linear-gradient(90deg,rgba(140,50,255,.06),rgba(57,255,136,.03))',
                borderTop:'1px solid rgba(120,60,255,.1)',
                display:'flex', alignItems:'center', gap:10, flexWrap:'wrap',
              }}>
                <span style={{ width:5, height:5, borderRadius:'50%', background:'#39ff88', boxShadow:'0 0 6px #39ff88', display:'inline-block', flexShrink:0, animation:'burn-pulse 2s ease infinite' }} />
                <div style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?11:12, color:'#c8d8e8' }}>
                  <span style={{ color:'#39ff88', fontWeight:700 }}>Burn BRAINS</span> to earn LB Points · <span style={{ color:'#00ccff' }}>🧪 Lab Work</span> & <span style={{ color:'#39ff88' }}>⚡ AMP</span> bonuses stack on your score · Connect wallet above
                </div>
              </div>
            </div>

          </div>
        )}

        {/* ── CONNECTED CONTENT ── */}
        {publicKey && (
          <div style={{ animation: 'bp-fade-up .4s ease both' }}>

            {/* Scanning banner */}
            {scan.loading && (
              <div style={{
                background: 'linear-gradient(135deg,rgba(255,90,0,0.12),rgba(200,50,0,0.07))',
                border: '1px solid rgba(255,90,0,0.3)', borderTop: '2px solid rgba(255,90,0,0.6)',
                borderRadius: 12, padding: '16px 20px', marginBottom: 22,
                display: 'flex', alignItems: 'center', gap: 16,
                boxShadow: '0 4px 24px rgba(255,60,0,0.1)',
              }}>
                <div style={{ width: 24, height: 24, border: '2px solid rgba(255,80,0,0.2)', borderTop: '2px solid #ff8844', borderRadius: '50%', animation: 'bp-spin .7s linear infinite', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#ff9955', letterSpacing: 2, marginBottom: 4 }}>SCANNING CHAIN HISTORY…</div>
                  <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 12, color: '#bb9980' }}>
                    Found <span style={{ color: '#ff8855', fontWeight: 700 }}>{scan.txs.length}</span> burn event{scan.txs.length !== 1 ? 's' : ''}
                    {' · '}
                    <span style={{ color: '#ff8855', fontWeight: 700 }}>
                      {scan.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span> BRAINS so far
                  </div>
                </div>
                {scan.total > 0 && (
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 22, fontWeight: 900, color: '#ff8855', textShadow: '0 0 16px rgba(255,80,0,0.5)', animation: 'burn-pulse .9s ease infinite' }}>
                      <AnimatedCounter value={Math.round(scan.total)} />
                    </div>
                    <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#cc6633', letterSpacing: 1 }}>BRAINS</div>
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {scan.error && !scan.loading && (
              <div style={{
                background: 'rgba(220,40,40,0.08)', border: '1px solid rgba(220,40,40,0.3)',
                borderLeft: '4px solid #ee4444', borderRadius: 10,
                padding: '14px 18px', marginBottom: 20, display: 'flex', gap: 12,
              }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
                <div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#ff6666', letterSpacing: 1, marginBottom: 5 }}>SCAN ERROR</div>
                  <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 12, color: '#ddbbbb' }}>{scan.error}</div>
                </div>
              </div>
            )}

            {/* Tier badge — shown once scan has data */}
            {scan.total > 0 && (
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16, flexWrap:'wrap', gap:10 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ width:5, height:5, borderRadius:'50%', background:'#39ff88', boxShadow:'0 0 8px #39ff88', animation:'burn-pulse 1.8s ease infinite' }} />
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#39ff88', letterSpacing:2 }}>
                    {(Math.floor(scan.total * 1.888) + labWorkPts).toLocaleString()} TOTAL LB POINTS
                  </span>
                  {labWorkPts > 0 && (
                    <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#00ccff', background:'rgba(0,204,255,.1)', border:'1px solid rgba(0,204,255,.25)', borderRadius:4, padding:'2px 6px' }}>
                      🧪 +{labWorkPts.toLocaleString()} LAB WORK
                    </span>
                  )}
                </div>
                <BHTierBadge points={Math.floor(scan.total * 1.888) + labWorkPts} />
              </div>
            )}

            {/* ── BURN LEADERBOARD ── */}
            <BurnLeaderboard
              connection={connection}
              walletAddress={publicKey?.toBase58()}
              walletBurned={scan.done || scan.total > 0 ? scan.total : undefined}
              walletTxCount={scan.txs.length}
              isMobile={isMobile}
              globalBurned={globalBurn ?? undefined}
              globalSupply={globalBurn != null ? INITIAL_SUPPLY - globalBurn : undefined}
              onEntriesLoaded={setLbEntries}
            />


          </div>
        )}

        {/* ── GLOBAL BURN TRANSACTIONS — always visible ── */}
        <div style={{ marginTop:20 }}>
          <BurnTransactions entries={lbEntries} isMobile={isMobile} connection={connection} />
        </div>

        <Footer />
      </div>
    </div>
  );
};

export default BurnHistory;