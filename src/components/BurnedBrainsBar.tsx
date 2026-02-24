import React, { FC, useEffect, useRef, useState, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey }      from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { BRAINS_MINT }   from '../constants';
import { getLabWorkPtsForWallet } from '../lib/supabase';

const INITIAL_SUPPLY = 8_880_000;
const POLL_INTERVAL  = 5_000;
const BURN_SCAN_INTERVAL = 60_000;

// ── Global burn stats — written by BurnedBrainsBar, readable by other components ──
export const walletBurnStats = { totalLbPts: 0, burnLbPts: 0, labWorkPts: 0, walletBurned: 0, tierName: '', tierIcon: '' };

// ─────────────────────────────────────────────
// TIERS (same as BurnLeaderboard)
// ─────────────────────────────────────────────
const TIERS = [
  { min: 0,          label: 'UNRANKED',      color: '#667788', neon: '#a0bbcc', icon: '—'  },
  { min: 1,          label: 'SPARK',         color: '#aaccff', neon: '#bbddff', icon: '✦'  },
  { min: 25_000,     label: 'FLAME',         color: '#ffcc55', neon: '#ffdd77', icon: '🕯️' },
  { min: 50_000,     label: 'INFERNO',       color: '#ff9933', neon: '#ffaa44', icon: '🔥' },
  { min: 100_000,    label: 'OVERWRITE',     color: '#ff6611', neon: '#ff8811', icon: '💥' },
  { min: 250_000,    label: 'ANNIHILATE',    color: '#ff4422', neon: '#ff6622', icon: '☄️' },
  { min: 500_000,    label: 'TERMINATE',     color: '#ff2200', neon: '#ff4411', icon: '🌋' },
  { min: 1_000_000,  label: 'DISINTEGRATE',  color: '#dd0055', neon: '#ff2277', icon: '⚡' },
  { min: 2_500_000,  label: 'GODSLAYER',     color: '#aa00ff', neon: '#dd22ff', icon: '👁' },
  { min: 5_000_000,  label: 'APOCALYPSE',    color: '#ff0044', neon: '#ff1155', icon: '💀' },
  { min: 8_000_000,  label: 'INCINERATOR',   color: '#ffeecc', neon: '#fffaee', icon: '☠️' },
];
const getTier  = (pts: number) => { for (let i = TIERS.length-1; i>=0; i--) if (pts >= TIERS[i].min) return TIERS[i]; return TIERS[0]; };
const nextTier = (pts: number) => { for (let i=0; i<TIERS.length; i++) if (pts < TIERS[i].min) return TIERS[i]; return null; };

function getLabWorkPtsLocal(walletAddress: string): number {
  // Fallback: read from localStorage
  try {
    const raw = localStorage.getItem('brains_labwork_rewards');
    if (!raw) return 0;
    const rewards = JSON.parse(raw);
    if (!Array.isArray(rewards)) return 0;
    return rewards.filter((r: any) => r.address === walletAddress).reduce((s: number, r: any) => s + (r.lbPoints || 0), 0);
  } catch { return 0; }
}

// ─────────────────────────────────────────────
// MOBILE HOOK
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// AnimatedCounter
// ─────────────────────────────────────────────
const AnimatedCounter: FC<{ value: number; duration?: number; decimals?: number }> = ({
  value, duration = 1200, decimals = 0,
}) => {
  const [display, setDisplay] = useState(value);
  const prevRef  = useRef(value);
  const startRef = useRef<number | null>(null);
  const rafRef   = useRef<number>(0);
  useEffect(() => {
    const from = prevRef.current, to = value;
    if (from === to) return;
    startRef.current = null;
    cancelAnimationFrame(rafRef.current);
    const animate = (ts: number) => {
      if (!startRef.current) startRef.current = ts;
      const p = Math.min((ts - startRef.current) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * e;
      setDisplay(decimals > 0 ? parseFloat(v.toFixed(decimals)) : Math.floor(v));
      if (p < 1) { rafRef.current = requestAnimationFrame(animate); } else { prevRef.current = to; }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration, decimals]);
  return <>{display.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
};

// ─────────────────────────────────────────────
// Ember
// ─────────────────────────────────────────────
const Ember: FC<{ delay: number; x: number; size: number; duration: number }> = ({ delay, x, size, duration }) => (
  <div style={{ position:'absolute', bottom:8, left:`${x}%`, width:size, height:size, borderRadius:'50%', background:'radial-gradient(circle,#ffcc00 0%,#ff4400 55%,transparent 100%)', animation:`ember-float ${duration}s ease-out ${delay}s infinite`, pointerEvents:'none', zIndex:2 }} />
);

// ─────────────────────────────────────────────
// streamWalletBurnTotal
// ─────────────────────────────────────────────
async function streamWalletBurnTotal(
  connection: ReturnType<typeof useConnection>['connection'],
  walletPubkey: PublicKey,
  decimals: number,
  signal: AbortSignal,
  onProgress: (runningTotal: number, done: boolean) => void,
): Promise<void> {
  const mintPubkey      = new PublicKey(BRAINS_MINT);
  const mintStr         = mintPubkey.toBase58();
  const TOKEN_2022_PROG = TOKEN_2022_PROGRAM_ID;
  const divisor         = Math.pow(10, decimals);

  let ataAddress: PublicKey | null = null;
  try {
    ataAddress = getAssociatedTokenAddressSync(mintPubkey, walletPubkey, false, TOKEN_2022_PROG);
  } catch { }

  let scanAddress = ataAddress ?? walletPubkey;
  try {
    if (ataAddress) {
      const info = await connection.getAccountInfo(ataAddress);
      if (!info) scanAddress = walletPubkey;
    }
  } catch { scanAddress = walletPubkey; }

  let runningTotal = 0;
  let before: string | undefined;
  const PAGE_SIZE = 100;

  while (true) {
    if (signal.aborted) { onProgress(runningTotal, true); return; }

    const sigs = await connection.getSignaturesForAddress(scanAddress, {
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
    });

    if (!sigs.length) { onProgress(runningTotal, true); return; }

    const txs = await connection.getParsedTransactions(
      sigs.map(s => s.signature),
      { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    );

    let pageTotal = 0;
    for (const tx of txs) {
      if (!tx || tx.meta?.err) continue;

      const allIxs: unknown[] = [...(tx.transaction.message.instructions ?? [])];
      for (const inner of tx.meta?.innerInstructions ?? []) allIxs.push(...inner.instructions);

      for (const ix of allIxs) {
        const p      = ix as Record<string, unknown>;
        if (p.program !== 'spl-token') continue;
        const parsed = p.parsed as Record<string, unknown> | undefined;
        if (!parsed) continue;
        const type   = parsed.type as string;
        if (type !== 'burn' && type !== 'burnChecked') continue;
        const info   = parsed.info as Record<string, unknown> | undefined;
        if (!info || (info.mint as string) !== mintStr) continue;

        const walletStr   = walletPubkey.toBase58();
        const ataStr      = ataAddress?.toBase58();
        const accountKeys = (tx.transaction.message.accountKeys ?? []) as Array<{ pubkey?: { toBase58?: () => string } }>;

        const isOurs = (e: { mint?: string; owner?: string; accountIndex?: number }) => {
          if (e.mint !== mintStr) return false;
          if (e.owner === walletStr) return true;
          if (ataStr && typeof e.accountIndex === 'number') {
            const keyStr = accountKeys[e.accountIndex]?.pubkey?.toBase58?.() ?? '';
            if (keyStr === ataStr) return true;
          }
          return false;
        };

        const preEntry  = (tx.meta?.preTokenBalances  ?? []).find(isOurs as any);
        const postEntry = (tx.meta?.postTokenBalances ?? []).find(isOurs as any);
        const preUi     = (preEntry  as any)?.uiTokenAmount?.uiAmount  ?? null;
        const postUi    = (postEntry as any)?.uiTokenAmount?.uiAmount ?? null;

        if (preUi !== null && postUi !== null) {
          const diff = preUi - postUi;
          if (diff > 0) { pageTotal += diff; break; }
        } else {
          const ta  = info.tokenAmount as Record<string, unknown> | undefined;
          const ui  = ta ? Number((ta as any).uiAmount ?? 0) : 0;
          const raw = ta ? Number((ta as any).amount  ?? 0) : Number(info.amount ?? 0);
          pageTotal += ui > 0 ? ui : raw / divisor;
          break;
        }
      }
    }

    runningTotal += pageTotal;
    const done = sigs.length < PAGE_SIZE;
    onProgress(runningTotal, done);
    if (done) return;
    before = sigs[sigs.length - 1].signature;
  }
}

// ─────────────────────────────────────────────
// STATE INTERFACES
// ─────────────────────────────────────────────
interface SupplyState {
  currentSupply: number | null; burned: number | null;
  loading: boolean; error: boolean; lastUpdated: Date | null;
}
interface WalletBurnState {
  amount:  number | null;
  loading: boolean;
  error:   boolean;
  decimals: number;
  scannedAt: Date | null;
}

// ─────────────────────────────────────────────
// STAT TILE — reusable for both desktop & mobile
// ─────────────────────────────────────────────
const StatTile: FC<{
  label: string;
  value: React.ReactNode;
  color: string;
  shadowColor?: string;
}> = ({ label, value, color, shadowColor }) => (
  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
    <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:600, color, letterSpacing:2, textTransform:'uppercase' }}>
      {label}
    </div>
    <div style={{ fontFamily:'Orbitron, monospace', fontWeight:900, color, lineHeight:1,
      textShadow: shadowColor ? `0 0 14px ${shadowColor}` : 'none' }}>
      {value}
    </div>
  </div>
);

// ─────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────
export const BurnedBrainsBar: FC = () => {
  const { connection }  = useConnection();
  const { publicKey }   = useWallet();
  const isMobile        = useIsMobile();

  const [state, setState]           = useState<SupplyState>({ currentSupply:null, burned:null, loading:true, error:false, lastUpdated:null });
  const [flash, setFlash]           = useState(false);
  const [walletBurn, setWalletBurn] = useState<WalletBurnState>({ amount:null, loading:false, error:false, decimals:6, scannedAt:null });

  const prevBurnedRef = useRef<number | null>(null);
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const burnScanRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const burnAbortRef  = useRef<AbortController | null>(null);
  const mountedRef    = useRef(true);
  const decimalsRef   = useRef(6);

  const fetchSupply = useCallback(async () => {
    if (!connection) return;
    try {
      const mintInfo      = await getMint(connection, new PublicKey(BRAINS_MINT), 'confirmed', TOKEN_2022_PROGRAM_ID);
      if (!mountedRef.current) return;
      const divisor       = Math.pow(10, mintInfo.decimals);
      decimalsRef.current = mintInfo.decimals;
      const currentSupply = Number(mintInfo.supply) / divisor;
      const burned        = Math.max(0, INITIAL_SUPPLY - currentSupply);
      if (prevBurnedRef.current !== null && burned > prevBurnedRef.current) {
        setFlash(true);
        setTimeout(() => { if (mountedRef.current) setFlash(false); }, 800);
      }
      prevBurnedRef.current = burned;
      setState({ currentSupply, burned, loading:false, error:false, lastUpdated:new Date() });
    } catch {
      if (mountedRef.current) setState(prev => ({ ...prev, loading:false, error:true }));
    }
  }, [connection]);

  const scanWalletBurns = useCallback(async () => {
    if (!connection || !publicKey) return;
    burnAbortRef.current?.abort();
    const ctrl = new AbortController();
    burnAbortRef.current = ctrl;
    setWalletBurn(prev => ({ ...prev, amount: prev.amount ?? 0, loading:true, error:false }));
    try {
      await streamWalletBurnTotal(
        connection, publicKey, decimalsRef.current, ctrl.signal,
        (runningTotal, done) => {
          if (!mountedRef.current || ctrl.signal.aborted) return;
          setWalletBurn({ amount:runningTotal, loading:!done, error:false, decimals:decimalsRef.current, scannedAt: done ? new Date() : null });
        },
      );
    } catch {
      if (!mountedRef.current || burnAbortRef.current?.signal.aborted) return;
      setWalletBurn(prev => ({ ...prev, loading:false, error:true }));
    }
  }, [connection, publicKey]);

  useEffect(() => {
    mountedRef.current = true;
    fetchSupply();
    pollRef.current = setInterval(fetchSupply, POLL_INTERVAL);
    return () => { mountedRef.current = false; if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchSupply]);

  useEffect(() => {
    if (!publicKey) {
      burnAbortRef.current?.abort();
      setWalletBurn({ amount:null, loading:false, error:false, decimals:6, scannedAt:null });
      if (burnScanRef.current) clearInterval(burnScanRef.current);
      return;
    }
    scanWalletBurns();
    burnScanRef.current = setInterval(scanWalletBurns, BURN_SCAN_INTERVAL);
    return () => { burnAbortRef.current?.abort(); if (burnScanRef.current) clearInterval(burnScanRef.current); };
  }, [scanWalletBurns, publicKey]);

  // ── Derived values ────────────────────────────────────────────────────────
  const burned       = Math.round(state.burned        ?? 0);
  const supply       = Math.round(state.currentSupply ?? INITIAL_SUPPLY);
  const burnPct      = Math.min((burned / INITIAL_SUPPLY) * 100, 100);
  const supplyLeft   = 100 - burnPct;
  const walletAmount = walletBurn.amount ?? 0;
  const walletPct    = INITIAL_SUPPLY > 0 ? (walletAmount / INITIAL_SUPPLY) * 100 : 0;

  // Lab Work + LB Points — fetch from Supabase, fallback to localStorage
  const walletAddr   = publicKey?.toBase58() ?? '';
  const [labWorkPts, setLabWorkPts] = useState(0);
  useEffect(() => {
    if (!walletAddr) { setLabWorkPts(0); return; }
    // Try Supabase first, fallback to localStorage
    getLabWorkPtsForWallet(walletAddr)
      .then(pts => { if (pts > 0) setLabWorkPts(pts); else setLabWorkPts(getLabWorkPtsLocal(walletAddr)); })
      .catch(() => setLabWorkPts(getLabWorkPtsLocal(walletAddr)));
  }, [walletAddr]);
  const burnLbPts    = Math.floor(walletAmount * 1.888);
  const totalLbPts   = burnLbPts + labWorkPts;
  const tier         = getTier(totalLbPts);
  const next         = nextTier(totalLbPts);
  const ptsToNext    = next ? next.min - totalLbPts : 0;

  // Update global stats so other components (Portfolio celebration) can read them
  walletBurnStats.totalLbPts = totalLbPts;
  walletBurnStats.burnLbPts = burnLbPts;
  walletBurnStats.labWorkPts = labWorkPts;
  walletBurnStats.walletBurned = walletAmount;
  walletBurnStats.tierName = tier.name;
  walletBurnStats.tierIcon = tier.icon;
  const embers       = Array.from({ length: isMobile ? 6 : 12 }, (_, i) => ({
    delay: i * 0.22, x: 3 + i * (isMobile ? 16 : 8.2), size: 2 + (i % 3), duration: 1.6 + (i % 4) * 0.4,
  }));
  const lastUpdatedStr = state.lastUpdated
    ? state.lastUpdated.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })
    : null;

  // ─────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────
  return (
    <div style={{ position:'relative', background:'linear-gradient(135deg,rgba(180,0,0,.12) 0%,rgba(220,40,10,.08) 50%,rgba(130,0,0,.14) 100%)', border:'1px solid #1e3050', borderTop:'1px solid rgba(220,40,10,.45)', overflow:'hidden' }}>

      {flash && <div style={{ position:'absolute', inset:0, background:'rgba(255,60,0,.10)', zIndex:4, pointerEvents:'none', animation:'burn-flash 0.8s ease forwards' }} />}
      <div style={{ position:'absolute', inset:0, overflow:'hidden', pointerEvents:'none', zIndex:0 }}>
        <div style={{ position:'absolute', top:0, width:'38%', height:'100%', background:'linear-gradient(90deg,transparent,rgba(255,50,0,.06),transparent)', animation:'scan-red 3.5s linear infinite' }} />
      </div>
      <div style={{ position:'absolute', top:0, left:0, right:0, height:2, background:'linear-gradient(90deg,transparent 0%,#dc1e1e 20%,#ff4400 50%,#dc1e1e 80%,transparent 100%)', backgroundSize:'200% 100%', animation:'heat-wave 3s ease infinite' }} />
      {embers.map((e, i) => <Ember key={i} {...e} />)}
      <div style={{ position:'absolute', inset:0, backgroundImage:`repeating-linear-gradient(60deg,transparent,transparent 8px,rgba(220,30,0,.04) 8px,rgba(220,30,0,.04) 9px)`, pointerEvents:'none', zIndex:0 }} />

      {/* ── ROW 1: Title + supply info ── */}
      <div style={{ position:'relative', zIndex:1, padding: isMobile ? '10px 14px 8px' : '11px 20px 10px',
        display:'flex', alignItems: isMobile ? 'flex-start' : 'center',
        flexDirection: isMobile ? 'column' : 'row',
        justifyContent:'space-between', gap: isMobile ? 6 : 0, boxSizing:'border-box' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ position:'relative', width:26, height:26, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,80,0,.18) 0%,transparent 70%)', animation:'pulse-crimson 2s ease infinite' }} />
            <span style={{ fontSize:14, animation:'burn-flicker 1.6s ease-in-out infinite', filter:'drop-shadow(0 0 4px rgba(255,80,0,.7))' }}>🔥</span>
          </div>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, letterSpacing:2, color:'#ff8060', textTransform:'uppercase' }}>
            BRAINS Burned
          </div>
        </div>
        <div style={{ textAlign: isMobile ? 'left' : 'right' }}>
          <div style={{ fontFamily:'Sora, sans-serif', fontSize:10, color:'#99bdd4', letterSpacing:0.2, marginBottom:2 }}>
            Supply{' '}<span style={{ color:'#b8d8f0', fontWeight:600 }}>{INITIAL_SUPPLY.toLocaleString()}</span>
            {' '}→{' '}<span style={{ color: state.loading ? '#3a4e60' : '#aed4f0', fontWeight:700 }}>
              {state.loading ? '···' : supply.toLocaleString()}
            </span>
          </div>
          {lastUpdatedStr && (
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#7a9db8', letterSpacing:1 }}>↻ {lastUpdatedStr}</div>
          )}
        </div>
      </div>

      <div style={{ position:'relative', zIndex:1, margin:'0 14px', height:1, background:'linear-gradient(90deg,transparent,rgba(200,55,20,.3) 25%,rgba(200,55,20,.3) 75%,transparent)' }} />

      {/* ── ROW 2: Global counters ── */}
      {isMobile ? (
        /* MOBILE: two tiles side by side, smaller font */
        <div style={{ position:'relative', zIndex:1, padding:'12px 14px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, background:'rgba(0,0,0,.07)', boxSizing:'border-box' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4,
            background:'rgba(255,50,0,.06)', border:'1px solid rgba(255,80,0,.15)', borderRadius:8, padding:'10px 8px' }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#e06833', letterSpacing:1.5, textTransform:'uppercase' }}>🔥 Burned</div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:20, fontWeight:900, color:'#ff7755', textShadow:'0 0 12px rgba(240,55,15,.5)', letterSpacing:1 }}>
              {state.loading ? '——' : <AnimatedCounter value={burned} />}
            </div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#cc6644' }}>BRAINS</div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4,
            background:'rgba(0,150,220,.06)', border:'1px solid rgba(0,180,255,.12)', borderRadius:8, padding:'10px 8px' }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#66aadd', letterSpacing:1.5, textTransform:'uppercase' }}>◈ Circulating</div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:20, fontWeight:900, color:'#88d8f4', textShadow:'0 0 12px rgba(60,180,220,.4)', letterSpacing:1 }}>
              {state.loading ? '——' : <AnimatedCounter value={supply} duration={800} />}
            </div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#55a0c0' }}>BRAINS</div>
          </div>
        </div>
      ) : (
        /* DESKTOP: original side-by-side with divider */
        <div style={{ position:'relative', zIndex:1, padding:'14px 20px 13px', display:'grid', gridTemplateColumns:'1fr auto 1fr', alignItems:'center', boxSizing:'border-box', background:'rgba(0,0,0,.07)' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:5 }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:600, color:'#e06833', letterSpacing:2.5, textTransform:'uppercase' }}>🔥 Tokens Burned</div>
            <div style={{ display:'flex', alignItems:'baseline', gap:7 }}>
              {state.loading
                ? <span style={{ fontFamily:'Orbitron, monospace', fontSize:28, fontWeight:900, color:'#2a1208', letterSpacing:2 }}>——</span>
                : <>
                    <span style={{ fontFamily:'Orbitron, monospace', fontSize:30, fontWeight:900, letterSpacing:2, color:'#ff7755', lineHeight:1, textShadow:'0 0 16px rgba(240,55,15,.5)' }}>
                      <AnimatedCounter value={burned} />
                    </span>
                    <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:600, color:'#cc6644', letterSpacing:1.5, textTransform:'uppercase', paddingBottom:3 }}>BRAINS</span>
                  </>
              }
            </div>
          </div>
          <div style={{ width:1, alignSelf:'stretch', background:'linear-gradient(to bottom,transparent,rgba(200,90,40,.25) 25%,rgba(200,90,40,.25) 75%,transparent)', margin:'0 22px' }} />
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:5 }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:600, color:'#66aadd', letterSpacing:2.5, textTransform:'uppercase' }}>◈ In Circulation</div>
            <div style={{ display:'flex', alignItems:'baseline', gap:7 }}>
              {state.loading
                ? <span style={{ fontFamily:'Orbitron, monospace', fontSize:28, fontWeight:900, color:'#0e1c28', letterSpacing:2 }}>——</span>
                : <>
                    <span style={{ fontFamily:'Orbitron, monospace', fontSize:30, fontWeight:900, letterSpacing:2, color:'#88d8f4', lineHeight:1, textShadow:'0 0 14px rgba(60,180,220,.4)' }}>
                      <AnimatedCounter value={supply} duration={800} />
                    </span>
                    <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:600, color:'#55a0c0', letterSpacing:1.5, textTransform:'uppercase', paddingBottom:3 }}>BRAINS</span>
                  </>
              }
            </div>
          </div>
        </div>
      )}

      <div style={{ position:'relative', zIndex:1, margin:'0 14px', height:1, background:'linear-gradient(90deg,transparent,rgba(100,120,160,.18) 25%,rgba(100,120,160,.18) 75%,transparent)' }} />

      {/* ── ROW 3: Progress bar + percentages ── */}
      {isMobile ? (
        /* MOBILE: stacked — % burned on top, bar, then gone/left labels */
        <div style={{ position:'relative', zIndex:1, padding:'12px 14px', background:'rgba(0,0,0,.14)', boxSizing:'border-box' }}>
          {/* Top: % burned + LIVE badge */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#cc7744', letterSpacing:1.5, marginBottom:3 }}>BURNED</div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:22, fontWeight:800, color:'#ff6633', letterSpacing:1, textShadow:'0 0 12px rgba(220,55,10,.45)' }}>
                {state.loading ? '···' : `${burnPct.toFixed(2)}%`}
              </div>
            </div>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              <div style={{ display:'flex', alignItems:'center', gap:5, background:'rgba(14,14,14,.97)', border:'1px solid rgba(40,40,40,.95)', borderRadius:6, padding:'4px 10px' }}>
                <span style={{ fontSize:11, filter: state.error ? 'grayscale(1) opacity(.4)' : 'drop-shadow(0 0 5px rgba(255,215,0,.9))', animation: state.loading ? 'none' : 'bulb-flicker 3s ease-in-out infinite' }}>💡</span>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:800, letterSpacing:2, color:'#e8e8e8' }}>
                  {state.loading ? 'LOADING' : state.error ? 'ERROR' : 'LIVE'}
                </span>
              </div>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#6a8ea8', letterSpacing:1 }}>every 5s</span>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{ marginBottom:6 }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#cc6644', letterSpacing:1 }}>GONE</span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#5599cc', letterSpacing:1 }}>LEFT</span>
            </div>
            <div style={{ position:'relative', height:8, borderRadius:4, overflow:'hidden', background:'rgba(50,75,110,.2)', border:'1px solid rgba(200,60,20,.1)' }}>
              <div style={{ position:'absolute', top:0, left:0, bottom:0, width:`${burnPct}%`, background:'linear-gradient(90deg,#4a0a00,#aa1800,#e83208)', borderRadius:4, boxShadow:'0 0 8px rgba(220,40,5,.5)', transition:'width 1.5s cubic-bezier(.16,1,.3,1)', minWidth: burnPct > 0 ? 3 : 0 }} />
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', marginTop:4 }}>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:700, color:'#ff8855' }}>
                {state.loading ? '···' : `${burnPct.toFixed(1)}%`}
              </span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:700, color:'#55aadd' }}>
                {state.loading ? '···' : `${supplyLeft.toFixed(1)}%`}
              </span>
            </div>
          </div>
        </div>
      ) : (
        /* DESKTOP: original horizontal layout */
        <div style={{ position:'relative', zIndex:1, padding:'10px 20px 13px', display:'grid', gridTemplateColumns:'auto auto 1fr auto auto auto auto', alignItems:'center', boxSizing:'border-box', background:'rgba(0,0,0,.14)' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingRight:16 }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#cc7744', letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>Burned</div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:800, color:'#ff6633', letterSpacing:1.5, lineHeight:1, textShadow:'0 0 12px rgba(220,55,10,.45)', whiteSpace:'nowrap' }}>
              {state.loading ? '···' : `${burnPct.toFixed(3)}%`}
            </div>
          </div>
          <div style={{ width:1, height:36, background:'linear-gradient(to bottom,transparent,rgba(200,65,25,.3),transparent)', margin:'0 16px' }} />
          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#cc6644', letterSpacing:1 }}>gone</span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#5599cc', letterSpacing:1 }}>left</span>
            </div>
            <div style={{ position:'relative', height:7, borderRadius:4, overflow:'hidden', background:'rgba(50,75,110,.2)', border:'1px solid rgba(200,60,20,.1)' }}>
              <div style={{ position:'absolute', top:0, left:0, bottom:0, width:`${burnPct}%`, background:'linear-gradient(90deg,#4a0a00,#aa1800,#e83208)', borderRadius:4, boxShadow:'0 0 8px rgba(220,40,5,.5)', transition:'width 1.5s cubic-bezier(.16,1,.3,1)', minWidth: burnPct > 0 ? 3 : 0 }} />
            </div>
            <div style={{ display:'flex', justifyContent:'space-between' }}>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:700, color:'#ff8855', whiteSpace:'nowrap' }}>
                {state.loading ? '···' : `${burnPct.toFixed(1)}%`}
              </span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:700, color:'#55aadd', whiteSpace:'nowrap' }}>
                {state.loading ? '···' : `${supplyLeft.toFixed(1)}%`}
              </span>
            </div>
          </div>
          <div style={{ width:1, height:36, background:'linear-gradient(to bottom,transparent,rgba(200,160,0,.18),transparent)', margin:'0 16px' }} />
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'0 14px' }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#cc7744', letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>Gone</div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:800, color:'#ff7755', letterSpacing:1.5, lineHeight:1, whiteSpace:'nowrap' }}>
              {state.loading ? '···' : `${burnPct.toFixed(1)}%`}
            </div>
          </div>
          <div style={{ width:1, height:36, background:'linear-gradient(to bottom,transparent,rgba(60,140,200,.2),transparent)', margin:'0 14px' }} />
          <div style={{ display:'flex', alignItems:'center', gap:16 }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#5599cc', letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>Left</div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:800, color:'#77ccee', letterSpacing:1.5, lineHeight:1, whiteSpace:'nowrap' }}>
                {state.loading ? '···' : `${supplyLeft.toFixed(1)}%`}
              </div>
            </div>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
              <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(14,14,14,.97)', border:'1px solid rgba(40,40,40,.95)', borderRadius:6, padding:'4px 11px' }}>
                <span style={{ fontSize:12, filter: state.error ? 'grayscale(1) opacity(.4)' : 'drop-shadow(0 0 5px rgba(255,215,0,.9))', animation: state.loading ? 'none' : 'bulb-flicker 3s ease-in-out infinite' }}>💡</span>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:800, letterSpacing:2, color:'#e8e8e8' }}>
                  {state.loading ? 'LOADING' : state.error ? 'ERROR' : 'LIVE'}
                </span>
              </div>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#6a8ea8', letterSpacing:1 }}>every 5s</span>
            </div>
          </div>
        </div>
      )}

      <div style={{ position:'relative', zIndex:1, margin:'0 14px', height:1, background:'linear-gradient(90deg,transparent,rgba(180,40,160,.22) 25%,rgba(180,40,160,.22) 75%,transparent)' }} />

      {/* ── ROW 4: Your personal burns ── */}
      {isMobile ? (
        /* MOBILE: fully stacked */
        <div style={{ position:'relative', zIndex:1, padding:'12px 14px 14px', background:'linear-gradient(135deg,rgba(120,0,100,.10) 0%,rgba(80,0,80,.07) 100%)', boxSizing:'border-box' }}>
          {/* Header */}
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
            <div style={{ position:'relative', width:34, height:34, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,80,0,.35) 0%,rgba(200,0,60,.18) 55%,transparent 75%)', animation:'pulse-crimson 2s ease infinite' }} />
              <span style={{ fontSize:18, position:'relative', zIndex:1, filter:'drop-shadow(0 0 8px rgba(255,80,0,.9))', animation:'burn-flicker 1.8s ease-in-out infinite' }}>🔥</span>
            </div>
            <div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:11, fontWeight:800, color:'#ff9944', letterSpacing:2, textTransform:'uppercase', textShadow:'0 0 10px rgba(255,120,40,.5)' }}>
                Your Burns
              </div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#ddbbff', letterSpacing:1, textTransform:'uppercase', marginTop:2 }}>
                {publicKey ? '🔗 All-Time' : '🔒 Connect Wallet'}
              </div>
            </div>
            {/* Scan badge — inline on mobile */}
            <div style={{ marginLeft:'auto', display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
              {publicKey ? (
                <>
                  <div style={{ display:'flex', alignItems:'center', gap:5, background:'rgba(14,14,14,.97)', border:`1px solid ${walletBurn.error ? 'rgba(120,30,30,.8)' : 'rgba(100,0,120,.6)'}`, borderRadius:6, padding:'3px 9px' }}>
                    <span style={{ fontSize:11 }}>{walletBurn.loading ? '🔄' : walletBurn.error ? '⚠️' : '🔍'}</span>
                    <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:800, letterSpacing:1.5, color: walletBurn.error ? '#cc5555' : '#ddbfee', textTransform:'uppercase' }}>
                      {walletBurn.loading ? 'SCAN' : walletBurn.error ? 'ERR' : 'DONE'}
                    </span>
                  </div>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#9a7aaa', letterSpacing:1 }}>
                    {walletBurn.loading ? 'scanning…' : walletBurn.scannedAt ? walletBurn.scannedAt.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : '60s'}
                  </span>
                </>
              ) : (
                <div style={{ display:'flex', alignItems:'center', gap:5, background:'rgba(14,14,14,.6)', border:'1px solid rgba(50,50,50,.6)', borderRadius:6, padding:'3px 9px' }}>
                  <span style={{ fontSize:11, opacity:.4 }}>🔒</span>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#3a3a4a' }}>—</span>
                </div>
              )}
            </div>
          </div>

          {/* Amount */}
          {!publicKey ? (
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:22, fontWeight:800, color:'#3a2a42', letterSpacing:1.5 }}>——</div>
          ) : walletBurn.error ? (
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:13, fontWeight:700, color:'#883333' }}>scan failed</div>
          ) : (
            <>
              <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:6 }}>
                {walletBurn.loading && (
                  <div style={{ width:8, height:8, borderRadius:'50%', background:'#cc88dd', flexShrink:0, alignSelf:'center', animation:'burn-loading-pulse 0.9s ease infinite' }} />
                )}
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:28, fontWeight:900, letterSpacing:2, color: walletAmount > 0 ? '#e080f0' : (walletBurn.loading ? '#7a5a8a' : '#4a3455'), lineHeight:1, textShadow: walletAmount > 0 ? '0 0 18px rgba(200,60,220,.55)' : 'none', transition:'color .4s' }}>
                  <AnimatedCounter value={walletAmount} decimals={2} />
                </span>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:11, fontWeight:600, color:'#cc88ee', letterSpacing:1.5, textTransform:'uppercase', paddingBottom:2 }}>BRAINS</span>
              </div>
              {walletAmount > 0 && !walletBurn.error && (
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ flex:1, height:4, borderRadius:2, overflow:'hidden', background:'rgba(80,0,80,.25)', border:'1px solid rgba(160,40,180,.15)' }}>
                    <div style={{ height:'100%', width:`${Math.min(walletPct * 20, 100)}%`, background:'linear-gradient(90deg,#4a006a,#aa00cc,#e040f0)', borderRadius:2, transition:'width 1.2s cubic-bezier(.16,1,.3,1)', minWidth: walletPct > 0 ? 3 : 0 }} />
                  </div>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:700, color:'#cc88ee', whiteSpace:'nowrap' }}>
                    {walletPct < 0.001 ? '<0.001' : walletPct.toFixed(3)}% of supply
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        /* DESKTOP: original layout */
        <div style={{ position:'relative', zIndex:1, padding:'12px 20px 14px', display:'grid', gridTemplateColumns:'auto auto 1fr auto', alignItems:'center', gap:0, boxSizing:'border-box', background:'linear-gradient(135deg,rgba(120,0,100,.10) 0%,rgba(80,0,80,.07) 100%)' }}>
          <div style={{ display:'flex', alignItems:'center', gap:12, paddingRight:18 }}>
            <div style={{ position:'relative', width:44, height:44, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,80,0,.35) 0%,rgba(200,0,60,.18) 55%,transparent 75%)', animation:'pulse-crimson 2s ease infinite' }} />
              <div style={{ position:'absolute', inset:3, borderRadius:'50%', border:'2px solid rgba(255,100,20,.5)', background:'linear-gradient(135deg,rgba(255,60,0,.25),rgba(180,0,40,.3))' }} />
              <span style={{ fontSize:22, lineHeight:1, position:'relative', zIndex:1, filter:'drop-shadow(0 0 8px rgba(255,80,0,.9)) drop-shadow(0 0 16px rgba(255,40,0,.6))', animation:'burn-flicker 1.8s ease-in-out infinite' }}>🔥</span>
            </div>
            <div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:13, fontWeight:800, color:'#ff9944', letterSpacing:2.5, textTransform:'uppercase', marginBottom:4, whiteSpace:'nowrap', textShadow:'0 0 12px rgba(255,120,40,.6)' }}>Your Burns</div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:600, color:'#ddbbff', letterSpacing:1.5, whiteSpace:'nowrap', textTransform:'uppercase' }}>
                {publicKey ? '🔗 Connected Wallet · All-Time' : '🔒 Connect Wallet to View'}
              </div>
            </div>
          </div>
          <div style={{ width:1, height:40, background:'linear-gradient(to bottom,transparent,rgba(180,80,200,.3),transparent)', margin:'0 18px 0 0' }} />
          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
            <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
              {!publicKey ? (
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:22, fontWeight:800, color:'#3a2a42', letterSpacing:1.5, lineHeight:1 }}>——</span>
              ) : walletBurn.error ? (
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:14, fontWeight:700, color:'#883333' }}>scan failed</span>
              ) : (
                <>
                  {walletBurn.loading && (
                    <div style={{ width:8, height:8, borderRadius:'50%', background:'#cc88dd', flexShrink:0, marginRight:4, alignSelf:'center', animation:'burn-loading-pulse 0.9s ease infinite' }} />
                  )}
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:28, fontWeight:900, letterSpacing:2, color: walletAmount > 0 ? '#e080f0' : (walletBurn.loading ? '#7a5a8a' : '#4a3455'), lineHeight:1, textShadow: walletAmount > 0 ? '0 0 18px rgba(200,60,220,.55)' : 'none', transition:'color .4s' }}>
                    <AnimatedCounter value={walletAmount} decimals={2} />
                  </span>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:12, fontWeight:600, color:'#cc88ee', letterSpacing:1.5, textTransform:'uppercase', paddingBottom:3 }}>BRAINS</span>
                </>
              )}
            </div>
            {publicKey && walletAmount > 0 && !walletBurn.error && (
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ flex:1, height:4, borderRadius:2, overflow:'hidden', background:'rgba(80,0,80,.25)', border:'1px solid rgba(160,40,180,.15)' }}>
                  <div style={{ height:'100%', width:`${Math.min(walletPct * 20, 100)}%`, background:'linear-gradient(90deg,#4a006a,#aa00cc,#e040f0)', borderRadius:2, transition:'width 1.2s cubic-bezier(.16,1,.3,1)', minWidth: walletPct > 0 ? 3 : 0 }} />
                </div>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:700, color:'#cc88ee', whiteSpace:'nowrap' }}>
                  {walletPct < 0.001 ? '<0.001' : walletPct.toFixed(3)}% of supply
                </span>
              </div>
            )}
          </div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, paddingLeft:18 }}>
            {publicKey ? (
              <>
                <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(14,14,14,.97)', border:`1px solid ${walletBurn.error ? 'rgba(120,30,30,.8)' : 'rgba(100,0,120,.6)'}`, borderRadius:6, padding:'4px 11px' }}>
                  <span style={{ fontSize:12 }}>{walletBurn.loading ? '🔄' : walletBurn.error ? '⚠️' : '🔍'}</span>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:800, letterSpacing:2, color: walletBurn.error ? '#cc5555' : '#ddbfee', textTransform:'uppercase', whiteSpace:'nowrap' }}>
                    {walletBurn.loading ? 'SCANNING' : walletBurn.error ? 'ERROR' : 'SCANNED'}
                  </span>
                </div>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#9a7aaa', letterSpacing:1.2, textTransform:'uppercase', whiteSpace:'nowrap' }}>
                  {walletBurn.loading ? 'scanning history…' : walletBurn.scannedAt ? `at ${walletBurn.scannedAt.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}` : 'every 60s'}
                </span>
              </>
            ) : (
              <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(14,14,14,.6)', border:'1px solid rgba(50,50,50,.6)', borderRadius:6, padding:'4px 11px' }}>
                <span style={{ fontSize:12, opacity:.4 }}>🔒</span>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:800, letterSpacing:2, color:'#3a3a4a', textTransform:'uppercase' }}>NO WALLET</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── ROW 5: LB Points · Lab Work · Tier Badge ── */}
      {publicKey && (
        <>
          <div style={{ position:'relative', zIndex:1, margin:'0 14px', height:1, background:'linear-gradient(90deg,transparent,rgba(0,204,255,.18) 25%,rgba(0,204,255,.18) 75%,transparent)' }} />
          {isMobile ? (
            <div style={{ position:'relative', zIndex:1, padding:'12px 14px 14px', background:'linear-gradient(135deg,rgba(0,80,120,.08) 0%,rgba(0,40,80,.06) 100%)', boxSizing:'border-box' }}>
              {/* Tier badge + title */}
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
                <div style={{
                  display:'flex', alignItems:'center', gap:6, padding:'5px 10px',
                  background:`linear-gradient(135deg, ${tier.neon}10, ${tier.neon}06)`,
                  border:`1px solid ${tier.neon}40`, borderLeft:`3px solid ${tier.neon}`,
                  borderRadius:8, flexShrink:0,
                }}>
                  <span style={{ fontSize:14 }}>{tier.icon}</span>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:900, color:tier.neon, letterSpacing:2 }}>{tier.label}</span>
                </div>
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#00ccff', letterSpacing:2, textTransform:'uppercase' }}>
                  🧪 LAB WORK STATUS
                </div>
              </div>
              {/* Stats grid */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, background:'rgba(0,204,255,.04)', border:'1px solid rgba(0,204,255,.12)', borderRadius:8, padding:'8px 6px' }}>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#00ccff', letterSpacing:1.5 }}>◆ TOTAL LB PTS</div>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:16, fontWeight:900, color:'#00ccff', textShadow:'0 0 10px rgba(0,204,255,.4)', letterSpacing:1 }}>
                    {walletBurn.loading ? '···' : <AnimatedCounter value={totalLbPts} />}
                  </div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, background:'rgba(57,255,136,.04)', border:'1px solid rgba(57,255,136,.12)', borderRadius:8, padding:'8px 6px' }}>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#39ff88', letterSpacing:1.5 }}>🔥 BURN PTS</div>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:16, fontWeight:900, color:'#39ff88', textShadow:'0 0 10px rgba(57,255,136,.4)', letterSpacing:1 }}>
                    {walletBurn.loading ? '···' : <AnimatedCounter value={burnLbPts} />}
                  </div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, background:'rgba(191,90,242,.04)', border:'1px solid rgba(191,90,242,.12)', borderRadius:8, padding:'8px 6px' }}>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#bf5af2', letterSpacing:1.5 }}>🧪 LAB WORK</div>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:16, fontWeight:900, color:'#bf5af2', textShadow:'0 0 10px rgba(191,90,242,.4)', letterSpacing:1 }}>
                    {labWorkPts > 0 ? <AnimatedCounter value={labWorkPts} /> : '0'}
                  </div>
                </div>
              </div>
              {/* Next tier progress */}
              {next && totalLbPts > 0 && (
                <div style={{ marginTop:10, display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ flex:1, height:4, borderRadius:2, overflow:'hidden', background:'rgba(0,80,120,.2)', border:'1px solid rgba(0,204,255,.1)' }}>
                    <div style={{ height:'100%', width:`${Math.min(((totalLbPts - tier.min) / (next.min - tier.min)) * 100, 100)}%`, background:`linear-gradient(90deg,${tier.neon},${next.neon})`, borderRadius:2, transition:'width 1.2s cubic-bezier(.16,1,.3,1)', minWidth:2 }} />
                  </div>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#667788', whiteSpace:'nowrap' }}>
                    {ptsToNext.toLocaleString()} to {next.icon} {next.label}
                  </span>
                </div>
              )}
            </div>
          ) : (
            /* DESKTOP */
            <div style={{ position:'relative', zIndex:1, padding:'12px 20px 14px', display:'flex', alignItems:'center', gap:0, boxSizing:'border-box', background:'linear-gradient(135deg,rgba(0,80,120,.08) 0%,rgba(0,40,80,.06) 100%)' }}>
              {/* Tier badge */}
              <div style={{
                display:'flex', alignItems:'center', gap:8, padding:'8px 14px',
                background:`linear-gradient(160deg, #0a0e14, #111820, ${tier.neon}0c, #0d1218)`,
                border:`1px solid ${tier.neon}44`, borderLeft:`3px solid ${tier.neon}`,
                borderRadius:10, marginRight:18, flexShrink:0,
                boxShadow:`0 0 12px ${tier.neon}15, inset 0 1px 0 ${tier.neon}18`,
              }}>
                <span style={{ fontSize:18, filter:`drop-shadow(0 0 6px ${tier.neon}66)` }}>{tier.icon}</span>
                <div>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:11, fontWeight:900, color:tier.neon, letterSpacing:2, textShadow:`0 0 8px ${tier.neon}44` }}>{tier.label}</div>
                  <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#667788', marginTop:1 }}>{tier.min > 0 ? `${tier.min.toLocaleString()}+ pts` : 'No burns yet'}</div>
                </div>
              </div>
              <div style={{ width:1, height:40, background:'linear-gradient(to bottom,transparent,rgba(0,204,255,.2),transparent)', marginRight:18 }} />
              {/* Total LB Points */}
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, marginRight:24 }}>
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#00ccff', letterSpacing:2 }}>◆ TOTAL LB POINTS</div>
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:26, fontWeight:900, color:'#00ccff', textShadow:'0 0 14px rgba(0,204,255,.45)', letterSpacing:1.5, lineHeight:1 }}>
                  {walletBurn.loading ? '···' : <AnimatedCounter value={totalLbPts} />}
                </div>
              </div>
              <div style={{ width:1, height:36, background:'linear-gradient(to bottom,transparent,rgba(57,255,136,.18),transparent)', marginRight:18 }} />
              {/* Burn LB pts */}
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, marginRight:20 }}>
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#39ff88', letterSpacing:1.5 }}>🔥 BURN PTS</div>
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:900, color:'#39ff88', textShadow:'0 0 10px rgba(57,255,136,.35)', letterSpacing:1, lineHeight:1 }}>
                  {walletBurn.loading ? '···' : <AnimatedCounter value={burnLbPts} />}
                </div>
              </div>
              <div style={{ width:1, height:36, background:'linear-gradient(to bottom,transparent,rgba(191,90,242,.18),transparent)', marginRight:18 }} />
              {/* Lab Work pts */}
              <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3, marginRight:20 }}>
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#bf5af2', letterSpacing:1.5 }}>🧪 LAB WORK</div>
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:900, color: labWorkPts > 0 ? '#bf5af2' : '#3a2a55', textShadow: labWorkPts > 0 ? '0 0 10px rgba(191,90,242,.35)' : 'none', letterSpacing:1, lineHeight:1 }}>
                  {labWorkPts > 0 ? <AnimatedCounter value={labWorkPts} /> : '0'}
                </div>
              </div>
              {/* Next tier progress */}
              <div style={{ flex:1, display:'flex', flexDirection:'column', gap:4, marginLeft:'auto', minWidth:140 }}>
                {next && totalLbPts > 0 ? (
                  <>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                      <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#667788', letterSpacing:1.5 }}>NEXT TIER</span>
                      <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:next.neon, letterSpacing:1 }}>{next.icon} {next.label}</span>
                    </div>
                    <div style={{ height:5, borderRadius:3, overflow:'hidden', background:'rgba(0,80,120,.2)', border:'1px solid rgba(0,204,255,.08)' }}>
                      <div style={{ height:'100%', width:`${Math.min(((totalLbPts - tier.min) / (next.min - tier.min)) * 100, 100)}%`, background:`linear-gradient(90deg,${tier.neon},${next.neon})`, borderRadius:3, transition:'width 1.2s cubic-bezier(.16,1,.3,1)', minWidth:2 }} />
                    </div>
                    <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#556677', textAlign:'right' }}>
                      {ptsToNext.toLocaleString()} pts to go
                    </div>
                  </>
                ) : totalLbPts > 0 && !next ? (
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'6px 12px', background:'rgba(255,220,100,.06)', border:'1px solid rgba(255,200,50,.2)', borderRadius:8 }}>
                    <span style={{ fontSize:14 }}>☠️</span>
                    <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#ffe066', letterSpacing:2 }}>MAX TIER ACHIEVED</span>
                  </div>
                ) : (
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#3a4e60', textAlign:'center', padding:8 }}>
                    Burn BRAINS to earn LB Points
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// CSS KEYFRAMES
// ─────────────────────────────────────────────
export function injectBurnStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.head.querySelector('style[data-burn-animations]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-burn-animations', 'true');
  style.textContent = `
    @keyframes burn-flicker {
      0%,100%{ opacity:1;   transform:scaleY(1)    scaleX(1);    }
      20%    { opacity:.85; transform:scaleY(1.04) scaleX(.98);  }
      40%    { opacity:.95; transform:scaleY(.97)  scaleX(1.02); }
      60%    { opacity:.88; transform:scaleY(1.05) scaleX(.97);  }
      80%    { opacity:.92; transform:scaleY(.98)  scaleX(1.01); }
    }
    @keyframes ember-float {
      0%  { transform:translateY(0)     translateX(0)    scale(1);   opacity:.9;  }
      25% { transform:translateY(-8px)  translateX(3px)  scale(.8);  opacity:.7;  }
      50% { transform:translateY(-14px) translateX(-2px) scale(.6);  opacity:.5;  }
      75% { transform:translateY(-20px) translateX(4px)  scale(.4);  opacity:.25; }
      100%{ transform:translateY(-28px) translateX(0)    scale(.1);  opacity:0;   }
    }
    @keyframes scan-red {
      0%  { transform:translateX(-120%); }
      100%{ transform:translateX(300%);  }
    }
    @keyframes heat-wave {
      0%,100%{ background-position:0%   50%; }
      50%    { background-position:100% 50%; }
    }
    @keyframes pulse-crimson {
      0%,100%{ box-shadow:0 0 18px rgba(220,30,30,.5), 0 0 40px rgba(220,30,30,.2);  }
      50%    { box-shadow:0 0 28px rgba(255,60,20,.8), 0 0 60px rgba(255,60,20,.35); }
    }
    @keyframes burn-flash {
      0%  { opacity:1; }
      60% { opacity:.5; }
      100%{ opacity:0; }
    }
    @keyframes bulb-flicker {
      0%,100%{ filter:drop-shadow(0 0 6px rgba(255,220,0,1)) drop-shadow(0 0 14px rgba(255,180,0,.9)); opacity:1;   }
      15%    { filter:drop-shadow(0 0 3px rgba(255,220,0,.6)) drop-shadow(0 0 6px  rgba(255,180,0,.5)); opacity:.85; }
      16%    { filter:drop-shadow(0 0 6px rgba(255,220,0,1)) drop-shadow(0 0 14px rgba(255,180,0,.9)); opacity:1;   }
      55%    { filter:drop-shadow(0 0 8px rgba(255,230,0,1)) drop-shadow(0 0 20px rgba(255,200,0,1));  opacity:1;   }
      80%    { filter:drop-shadow(0 0 4px rgba(255,210,0,.7)) drop-shadow(0 0 8px  rgba(255,170,0,.6)); opacity:.9;  }
    }
    @keyframes burn-loading-pulse {
      0%,100%{ opacity:.4; }
      50%    { opacity:.9; }
    }
  `;
  document.head.appendChild(style);
}