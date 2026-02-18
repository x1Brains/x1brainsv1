import React, { FC, useEffect, useRef, useState, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey }      from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { BRAINS_MINT }   from '../constants';

const INITIAL_SUPPLY = 8_880_000;
const POLL_INTERVAL  = 5_000;
// How often to re-scan the wallet's burn history (more expensive — RPC calls)
const BURN_SCAN_INTERVAL = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// AnimatedCounter
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Ember
// ─────────────────────────────────────────────────────────────────────────────
const Ember: FC<{ delay: number; x: number; size: number; duration: number }> = ({ delay, x, size, duration }) => (
  <div style={{ position:'absolute', bottom:8, left:`${x}%`, width:size, height:size, borderRadius:'50%', background:'radial-gradient(circle,#ffcc00 0%,#ff4400 55%,transparent 100%)', animation:`ember-float ${duration}s ease-out ${delay}s infinite`, pointerEvents:'none', zIndex:2 }} />
);

// ─────────────────────────────────────────────────────────────────────────────
// fetchWalletBurnTotal
//
// Walks the connected wallet's transaction history, looks for parsed
// "burn" and "burnChecked" instructions on the BRAINS mint, and returns
// the total amount burned (in human-readable token units).
//
// Strategy:
//   1. Get the wallet's Associated Token Account for BRAINS_MINT (Token-2022).
//   2. Call getSignaturesForAddress on that ATA (not the wallet — the ATA is
//      the account that actually appears in burn instructions).
//   3. Fetch each transaction as parsed, scan instructions + inner instructions
//      for burn/burnChecked on the BRAINS mint, sum the amounts.
//   4. Paginate with `before` until no more signatures are returned.
//
// Burn instruction parsed shape (spl-token / token-2022):
//   { program: "spl-token", parsed: { type: "burn" | "burnChecked",
//     info: { mint, tokenAmount: { uiAmount } } } }
// ─────────────────────────────────────────────────────────────────────────────
// Streams burn totals page-by-page so UI updates immediately.
// onProgress(runningTotal, done) is called after every page.
async function streamWalletBurnTotal(
  connection: ReturnType<typeof useConnection>['connection'],
  walletPubkey: PublicKey,
  decimals: number,
  signal: AbortSignal,
  onProgress: (runningTotal: number, done: boolean) => void,
): Promise<void> {
  const mintPubkey    = new PublicKey(BRAINS_MINT);
  const mintStr       = mintPubkey.toBase58();
  const TOKEN_2022_PROG = TOKEN_2022_PROGRAM_ID;
  const divisor       = Math.pow(10, decimals);

  // Derive ATA for targeted scan
  let ataAddress: PublicKey | null = null;
  try {
    ataAddress = getAssociatedTokenAddressSync(
      mintPubkey, walletPubkey, false, TOKEN_2022_PROG,
    );
  } catch {
    // fall through — will scan wallet directly
  }

  // If ATA not found on-chain yet, fall back to wallet pubkey
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

      // ── Confirm this tx has a burn ix for the BRAINS mint ──────────────
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

        // Use uiTokenAmount.uiAmount from preTokenBalances diff (most accurate)
        // Fall back to instruction-level tokenAmount.uiAmount, then raw amount / divisor
        const walletStr = walletPubkey.toBase58();
        const ataStr    = ataAddress?.toBase58();
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
          // Pre/post diff is the gold standard — immune to raw-int errors
          const diff = preUi - postUi;
          if (diff > 0) { pageTotal += diff; break; } // one burn per tx
        } else {
          // Fallback: instruction-level uiAmount or raw amount
          const ta  = info.tokenAmount as Record<string, unknown> | undefined;
          const ui  = ta ? Number((ta as any).uiAmount ?? 0) : 0;
          const raw = ta ? Number((ta as any).amount  ?? 0) : Number(info.amount ?? 0);
          pageTotal += ui > 0 ? ui : raw / divisor;
          break; // one burn per tx
        }
      }
    }

    runningTotal += pageTotal;

    // ── Report progress immediately after every page ──
    const done = sigs.length < PAGE_SIZE;
    onProgress(runningTotal, done);
    if (done) return;

    before = sigs[sigs.length - 1].signature;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE INTERFACES
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export const BurnedBrainsBar: FC = () => {
  const { connection }        = useConnection();
  const { publicKey }         = useWallet();

  const [state, setState]     = useState<SupplyState>({ currentSupply:null, burned:null, loading:true, error:false, lastUpdated:null });
  const [flash, setFlash]     = useState(false);
  const [walletBurn, setWalletBurn] = useState<WalletBurnState>({
    amount: null, loading: false, error: false, decimals: 6, scannedAt: null,
  });

  const prevBurnedRef  = useRef<number | null>(null);
  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const burnScanRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const burnAbortRef   = useRef<AbortController | null>(null);
  const mountedRef     = useRef(true);
  const decimalsRef    = useRef(6); // updated once mint is fetched

  // ── Supply fetch (every 5s) ──────────────────────────────────────────────
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
    } catch (err) {
      console.error('[BurnedBrainsBar] Supply fetch failed:', err);
      if (mountedRef.current) setState(prev => ({ ...prev, loading:false, error:true }));
    }
  }, [connection]);

  // ── Wallet burn scan — streams results page-by-page ────────────────────
  const scanWalletBurns = useCallback(async () => {
    if (!connection || !publicKey) return;

    burnAbortRef.current?.abort();
    const ctrl = new AbortController();
    burnAbortRef.current = ctrl;

    // Show 0.00 immediately with a scanning spinner — no more blank wait
    setWalletBurn(prev => ({ ...prev, amount: prev.amount ?? 0, loading: true, error: false }));

    try {
      await streamWalletBurnTotal(
        connection, publicKey, decimalsRef.current, ctrl.signal,
        (runningTotal, done) => {
          if (!mountedRef.current || ctrl.signal.aborted) return;
          setWalletBurn({
            amount:    runningTotal,
            loading:   !done,
            error:     false,
            decimals:  decimalsRef.current,
            scannedAt: done ? new Date() : null,
          });
        },
      );
    } catch (err: unknown) {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      console.error('[BurnedBrainsBar] Wallet burn scan failed:', err);
      setWalletBurn(prev => ({ ...prev, loading: false, error: true }));
    }
  }, [connection, publicKey]);

  // ── Supply polling ───────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    fetchSupply();
    pollRef.current = setInterval(fetchSupply, POLL_INTERVAL);
    return () => { mountedRef.current = false; if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchSupply]);

  // ── Wallet burn polling ──────────────────────────────────────────────────
  useEffect(() => {
    if (!publicKey) {
      // Wallet disconnected — clear state
      burnAbortRef.current?.abort();
      setWalletBurn({ amount: null, loading: false, error: false, decimals: 6, scannedAt: null });
      if (burnScanRef.current) clearInterval(burnScanRef.current);
      return;
    }
    scanWalletBurns();
    burnScanRef.current = setInterval(scanWalletBurns, BURN_SCAN_INTERVAL);
    return () => {
      burnAbortRef.current?.abort();
      if (burnScanRef.current) clearInterval(burnScanRef.current);
    };
  }, [scanWalletBurns, publicKey]);

  // ── Derived values ───────────────────────────────────────────────────────
  const burned       = Math.round(state.burned        ?? 0);
  const supply       = Math.round(state.currentSupply ?? INITIAL_SUPPLY);
  const burnPct      = Math.min((burned / INITIAL_SUPPLY) * 100, 100);
  const supplyLeft   = 100 - burnPct;
  const walletAmount = walletBurn.amount ?? 0;
  const walletPct    = INITIAL_SUPPLY > 0 ? (walletAmount / INITIAL_SUPPLY) * 100 : 0;
  const embers       = Array.from({ length:12 }, (_, i) => ({ delay:i*0.22, x:3+i*8.2, size:2+(i%3), duration:1.6+(i%4)*0.4 }));
  const lastUpdatedStr = state.lastUpdated
    ? state.lastUpdated.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })
    : null;

  const Divider = ({ col = 'rgba(255,90,40,.35)' }: { col?: string }) => (
    <div style={{ width:1, alignSelf:'stretch', background:`linear-gradient(to bottom,transparent,${col} 25%,${col} 75%,transparent)`, margin:'0 22px' }} />
  );
  const VDiv = ({ col = 'rgba(200,65,25,.3)', mx = 16 }: { col?: string; mx?: number }) => (
    <div style={{ width:1, height:36, background:`linear-gradient(to bottom,transparent,${col},transparent)`, margin:`0 ${mx}px` }} />
  );

  return (
    <div style={{ position:'relative', background:'linear-gradient(135deg,rgba(180,0,0,.12) 0%,rgba(220,40,10,.08) 50%,rgba(130,0,0,.14) 100%)', border:'1px solid #1e3050', borderTop:'1px solid rgba(220,40,10,.45)', overflow:'hidden' }}>

      {/* Flash */}
      {flash && <div style={{ position:'absolute', inset:0, background:'rgba(255,60,0,.10)', zIndex:4, pointerEvents:'none', animation:'burn-flash 0.8s ease forwards' }} />}

      {/* Scan line */}
      <div style={{ position:'absolute', inset:0, overflow:'hidden', pointerEvents:'none', zIndex:0 }}>
        <div style={{ position:'absolute', top:0, width:'38%', height:'100%', background:'linear-gradient(90deg,transparent,rgba(255,50,0,.06),transparent)', animation:'scan-red 3.5s linear infinite' }} />
      </div>

      {/* Heat-wave top strip */}
      <div style={{ position:'absolute', top:0, left:0, right:0, height:2, background:'linear-gradient(90deg,transparent 0%,#dc1e1e 20%,#ff4400 50%,#dc1e1e 80%,transparent 100%)', backgroundSize:'200% 100%', animation:'heat-wave 3s ease infinite' }} />

      {/* Embers */}
      {embers.map((e, i) => <Ember key={i} {...e} />)}

      {/* Hex-grid texture */}
      <div style={{ position:'absolute', inset:0, backgroundImage:`repeating-linear-gradient(60deg,transparent,transparent 8px,rgba(220,30,0,.04) 8px,rgba(220,30,0,.04) 9px)`, pointerEvents:'none', zIndex:0 }} />


      {/* ═══════════════════════════════════════════
          ROW 1 — Title · Supply info
      ═══════════════════════════════════════════ */}
      <div style={{ position:'relative', zIndex:1, padding:'11px 20px 10px', display:'flex', alignItems:'center', justifyContent:'space-between', boxSizing:'border-box' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ position:'relative', width:30, height:30, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,80,0,.18) 0%,transparent 70%)', animation:'pulse-crimson 2s ease infinite' }} />
            <span style={{ fontSize:16, animation:'burn-flicker 1.6s ease-in-out infinite', filter:'drop-shadow(0 0 4px rgba(255,80,0,.7))' }}>🔥</span>
          </div>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:700, letterSpacing:2.5, color:'#ff8060', textTransform:'uppercase', whiteSpace:'nowrap' }}>
            BRAINS Burned from Supply
          </div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontFamily:'Sora, sans-serif', fontSize:10.5, color:'#99bdd4', letterSpacing:0.2, whiteSpace:'nowrap', marginBottom:3 }}>
            Initial supply{' '}<span style={{ color:'#b8d8f0', fontWeight:600 }}>{INITIAL_SUPPLY.toLocaleString()}</span>
            {' '}→ Now{' '}<span style={{ color: state.loading ? '#3a4e60' : '#aed4f0', fontWeight:700 }}>{state.loading ? '···' : supply.toLocaleString()}</span>
          </div>
          {lastUpdatedStr && (
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#7a9db8', letterSpacing:1, whiteSpace:'nowrap' }}>↻ Updated {lastUpdatedStr}</div>
          )}
        </div>
      </div>

      <div style={{ position:'relative', zIndex:1, margin:'0 20px', height:1, background:'linear-gradient(90deg,transparent,rgba(200,55,20,.3) 25%,rgba(200,55,20,.3) 75%,transparent)' }} />


      {/* ═══════════════════════════════════════════
          ROW 2 — Global counters
      ═══════════════════════════════════════════ */}
      <div style={{ position:'relative', zIndex:1, padding:'14px 20px 13px', display:'grid', gridTemplateColumns:'1fr auto 1fr', alignItems:'center', boxSizing:'border-box', background:'rgba(0,0,0,.07)' }}>

        {/* Tokens Burned */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:5 }}>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:600, color:'#e06833', letterSpacing:2.5, textTransform:'uppercase' }}>
            🔥 Tokens Burned
          </div>
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

        <Divider col="rgba(200,90,40,.25)" />

        {/* In Circulation */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:5 }}>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:600, color:'#66aadd', letterSpacing:2.5, textTransform:'uppercase' }}>
            ◈ In Circulation
          </div>
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

      <div style={{ position:'relative', zIndex:1, margin:'0 20px', height:1, background:'linear-gradient(90deg,transparent,rgba(100,120,160,.18) 25%,rgba(100,120,160,.18) 75%,transparent)' }} />


      {/* ═══════════════════════════════════════════
          ROW 3 — % burned · bar · gone · left · LIVE
      ═══════════════════════════════════════════ */}
      <div style={{ position:'relative', zIndex:1, padding:'10px 20px 13px', display:'grid', gridTemplateColumns:'auto auto 1fr auto auto auto auto', alignItems:'center', boxSizing:'border-box', background:'rgba(0,0,0,.14)' }}>

        {/* % Burned */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingRight:16 }}>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#cc7744', letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>Burned</div>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:800, color:'#ff6633', letterSpacing:1.5, lineHeight:1, textShadow:'0 0 12px rgba(220,55,10,.45)', whiteSpace:'nowrap' }}>
            {state.loading ? '···' : `${burnPct.toFixed(3)}%`}
          </div>
        </div>

        <VDiv />

        {/* Progress bar */}
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#cc6644', letterSpacing:1, textTransform:'uppercase' }}>gone</span>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#5599cc', letterSpacing:1, textTransform:'uppercase' }}>left</span>
          </div>
          <div style={{ position:'relative', height:7, borderRadius:4, overflow:'hidden', background:'rgba(50,75,110,.2)', border:'1px solid rgba(200,60,20,.1)' }}>
            <div style={{ position:'absolute', inset:0, background:'rgba(40,85,140,.1)', borderRadius:4 }} />
            <div style={{ position:'absolute', top:0, left:0, bottom:0, width:`${burnPct}%`, background:'linear-gradient(90deg,#4a0a00,#aa1800,#e83208)', borderRadius:4, boxShadow:'0 0 8px rgba(220,40,5,.5)', transition:'width 1.5s cubic-bezier(.16,1,.3,1)', minWidth: burnPct > 0 ? 3 : 0 }} />
          </div>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:700, color:'#ff8855', letterSpacing:0.5, whiteSpace:'nowrap' }}>
              {state.loading ? '···' : `${burnPct.toFixed(1)}%`}
            </span>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, fontWeight:700, color:'#55aadd', letterSpacing:0.5, whiteSpace:'nowrap' }}>
              {state.loading ? '···' : `${supplyLeft.toFixed(1)}%`}
            </span>
          </div>
        </div>

        <VDiv col="rgba(200,160,0,.18)" mx={16} />

        {/* Gone % */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'0 14px' }}>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#cc7744', letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>Gone</div>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:800, color:'#ff7755', letterSpacing:1.5, lineHeight:1, textShadow:'0 0 10px rgba(220,75,30,.4)', whiteSpace:'nowrap' }}>
            {state.loading ? '···' : `${burnPct.toFixed(1)}%`}
          </div>
        </div>

        <VDiv col="rgba(60,140,200,.2)" mx={14} />

        {/* Left % + LIVE badge */}
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7.5, color:'#5599cc', letterSpacing:1.5, textTransform:'uppercase', marginBottom:4 }}>Left</div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:800, color:'#77ccee', letterSpacing:1.5, lineHeight:1, textShadow:'0 0 10px rgba(50,170,220,.4)', whiteSpace:'nowrap' }}>
              {state.loading ? '···' : `${supplyLeft.toFixed(1)}%`}
            </div>
          </div>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
            <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(14,14,14,.97)', border:'1px solid rgba(40,40,40,.95)', borderRadius:6, padding:'4px 11px', boxShadow:'0 1px 8px rgba(0,0,0,.6)' }}>
              <span style={{ fontSize:12, lineHeight:1, filter: state.error ? 'grayscale(1) opacity(.4)' : 'drop-shadow(0 0 5px rgba(255,215,0,.9)) drop-shadow(0 0 10px rgba(255,175,0,.7))', animation: state.loading ? 'none' : 'bulb-flicker 3s ease-in-out infinite' }}>💡</span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:800, letterSpacing:2, color:'#e8e8e8', textTransform:'uppercase' }}>
                {state.loading ? 'LOADING' : state.error ? 'ERROR' : 'LIVE'}
              </span>
            </div>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#6a8ea8', letterSpacing:1.2, textTransform:'uppercase', whiteSpace:'nowrap' }}>every 5s</span>
          </div>
        </div>
      </div>


      {/* separator — slightly warmer tint leading into personal row */}
      <div style={{ position:'relative', zIndex:1, margin:'0 20px', height:1, background:'linear-gradient(90deg,transparent,rgba(180,40,160,.22) 25%,rgba(180,40,160,.22) 75%,transparent)' }} />


      {/* ═══════════════════════════════════════════
          ROW 4 — Your personal BRAINS burned
      ═══════════════════════════════════════════ */}
      <div style={{ position:'relative', zIndex:1, padding:'12px 20px 14px', display:'grid', gridTemplateColumns:'auto auto 1fr auto', alignItems:'center', gap:0, boxSizing:'border-box', background:'linear-gradient(135deg,rgba(120,0,100,.10) 0%,rgba(80,0,80,.07) 100%)' }}>

        {/* 🔥 fire badge + label */}
        <div style={{ display:'flex', alignItems:'center', gap:12, paddingRight:18 }}>
          {/* Fire badge icon */}
          <div style={{ position:'relative', width:44, height:44, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <div style={{ position:'absolute', inset:0, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,80,0,.35) 0%,rgba(200,0,60,.18) 55%,transparent 75%)', animation:'pulse-crimson 2s ease infinite' }} />
            <div style={{ position:'absolute', inset:3, borderRadius:'50%', border:'2px solid rgba(255,100,20,.5)', background:'linear-gradient(135deg,rgba(255,60,0,.25),rgba(180,0,40,.3))' }} />
            <span style={{ fontSize:22, lineHeight:1, position:'relative', zIndex:1, filter:'drop-shadow(0 0 8px rgba(255,80,0,.9)) drop-shadow(0 0 16px rgba(255,40,0,.6))', animation:'burn-flicker 1.8s ease-in-out infinite' }}>🔥</span>
          </div>
          <div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:13, fontWeight:800, color:'#ff9944', letterSpacing:2.5, textTransform:'uppercase', marginBottom:4, whiteSpace:'nowrap', textShadow:'0 0 12px rgba(255,120,40,.6)' }}>
              Your Burns
            </div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:600, color:'#ddbbff', letterSpacing:1.5, whiteSpace:'nowrap', textTransform:'uppercase' }}>
              {publicKey ? '🔗 Connected Wallet · All-Time' : '🔒 Connect Wallet to View'}
            </div>
          </div>
        </div>

        {/* vdiv */}
        <div style={{ width:1, height:40, background:'linear-gradient(to bottom,transparent,rgba(180,80,200,.3),transparent)', margin:'0 18px 0 0' }} />

        {/* Amount */}
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
            {!publicKey ? (
              /* no wallet connected */
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:22, fontWeight:800, color:'#3a2a42', letterSpacing:1.5, lineHeight:1 }}>
                ——
              </span>
            ) : walletBurn.error ? (
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:14, fontWeight:700, color:'#883333', letterSpacing:1 }}>scan failed</span>
            ) : (
              <>
                {/* Pulsing dot shows while scan is still in progress */}
                {walletBurn.loading && (
                  <div style={{ width:8, height:8, borderRadius:'50%', background:'#cc88dd', flexShrink:0, marginRight:4, alignSelf:'center', animation:'burn-loading-pulse 0.9s ease infinite', boxShadow:'0 0 6px rgba(200,80,220,.6)' }} />
                )}
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:28, fontWeight:900, letterSpacing:2, color: walletAmount > 0 ? '#e080f0' : (walletBurn.loading ? '#7a5a8a' : '#4a3455'), lineHeight:1, textShadow: walletAmount > 0 ? '0 0 18px rgba(200,60,220,.55)' : 'none', transition:'color .4s' }}>
                  <AnimatedCounter value={walletAmount} decimals={2} />
                </span>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:12, fontWeight:600, color:'#cc88ee', letterSpacing:1.5, textTransform:'uppercase', paddingBottom:3 }}>
                  BRAINS
                </span>
              </>
            )}
          </div>

          {/* mini progress bar showing wallet's share of total burned */}
          {publicKey && walletAmount > 0 && !walletBurn.error && (
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ flex:1, height:4, borderRadius:2, overflow:'hidden', background:'rgba(80,0,80,.25)', border:'1px solid rgba(160,40,180,.15)' }}>
                <div style={{ height:'100%', width:`${Math.min(walletPct * 20, 100)}%`, background:'linear-gradient(90deg,#4a006a,#aa00cc,#e040f0)', borderRadius:2, boxShadow:'0 0 6px rgba(180,40,220,.5)', transition:'width 1.2s cubic-bezier(.16,1,.3,1)', minWidth: walletPct > 0 ? 3 : 0 }} />
              </div>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:700, color:'#cc88ee', letterSpacing:0.5, whiteSpace:'nowrap' }}>
                {walletPct < 0.001 ? '<0.001' : walletPct.toFixed(3)}% of supply
              </span>
            </div>
          )}
        </div>

        {/* Scan status badge */}
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, paddingLeft:18 }}>
          {publicKey ? (
            <>
              <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(14,14,14,.97)', border:`1px solid ${walletBurn.error ? 'rgba(120,30,30,.8)' : 'rgba(100,0,120,.6)'}`, borderRadius:6, padding:'4px 11px', boxShadow:'0 1px 8px rgba(0,0,0,.6)' }}>
                <span style={{ fontSize:12, lineHeight:1, filter: walletBurn.loading ? 'grayscale(.5) opacity(.7)' : walletBurn.error ? 'grayscale(1) opacity(.4)' : 'drop-shadow(0 0 5px rgba(200,80,230,.9))' }}>
                  {walletBurn.loading ? '🔄' : walletBurn.error ? '⚠️' : '🔍'}
                </span>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:800, letterSpacing:2, color: walletBurn.error ? '#cc5555' : '#ddbfee', textTransform:'uppercase', whiteSpace:'nowrap' }}>
                  {walletBurn.loading ? 'SCANNING' : walletBurn.error ? 'ERROR' : 'SCANNED'}
                </span>
              </div>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#9a7aaa', letterSpacing:1.2, textTransform:'uppercase', whiteSpace:'nowrap' }}>
                {walletBurn.loading
                  ? 'scanning history…'
                  : walletBurn.scannedAt
                  ? `at ${walletBurn.scannedAt.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`
                  : 'every 60s'}
              </span>
            </>
          ) : (
            <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(14,14,14,.6)', border:'1px solid rgba(50,50,50,.6)', borderRadius:6, padding:'4px 11px' }}>
              <span style={{ fontSize:12, lineHeight:1, opacity:.4 }}>🔒</span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:800, letterSpacing:2, color:'#3a3a4a', textTransform:'uppercase' }}>NO WALLET</span>
            </div>
          )}
        </div>

      </div>

    </div>
  );
};

// ─────────────────────────────────────────────
// CSS KEYFRAMES — inject once
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
    @keyframes pulse-crimson-dot {
      0%,100%{ opacity:1;   }
      50%    { opacity:.35; }
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