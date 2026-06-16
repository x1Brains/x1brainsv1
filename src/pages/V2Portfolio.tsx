import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { BRAINS_MINT, BRAINS_LOGO, XNT_LOGO, LB_LOGO } from '../constants';
import { fmtUSD, fmtNum, shortAddr } from '../utils/v2format';
import { fetchAllPrices, fetchPrice, getCachedPrice } from '../lib/prices';
import { getCachedTokenLogo, setCachedTokenLogo, primeFromIndexer } from '../lib/tokenLogos';
import { fetchTokenMeta } from './PairingMarketplace';
import { fetchFarms } from './LpFarms';
import { fetchAllListings } from '../components/LBComponents';
import V2NFTImage from '../components/V2NFTImage';
import {
  getPortfolioSnapshots, upsertPortfolioSnapshot,
  getSavedAddresses, insertSavedAddress, deleteSavedAddress,
  insertSendRecord,
  type PortfolioSnapshot,
  type SnapshotToken,
  type SendHistoryRow,
} from '../lib/supabase';
import { SendPanel, type SavedAddress } from '../components/SendPanel';
import { PortfolioShareCard } from '../components/PortfolioShareCard';

const LB_MINT   = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
const XNT_MINT  = 'So11111111111111111111111111111111111111112';
const XNM_MINT  = 'XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m';
const XUNI_MINT = 'XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm';
const XBLK_MINT = 'XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T';

// V2 palette
const C_ORANGE = '#f29030';
const C_GRAY   = '#8a9ab8';
const C_PURPLE = '#bf5af2';
const C_GREEN  = '#00c98d';
const C_SILVER = '#aeb9c7';

type TokenKind = 'ecosystem' | 'x1native' | 'other';
const KNOWN: Record<string, { symbol: string; logo?: string; iconClass: string; color: string; kind: TokenKind }> = {
  [BRAINS_MINT]: { symbol: 'BRAINS', logo: BRAINS_LOGO, iconClass: 'brains', color: C_ORANGE, kind: 'ecosystem' },
  [LB_MINT]:     { symbol: 'LB',     logo: LB_LOGO,     iconClass: 'lb',     color: C_PURPLE, kind: 'ecosystem' },
  [XNT_MINT]:    { symbol: 'XNT',    logo: XNT_LOGO,    iconClass: 'xnt',    color: C_ORANGE, kind: 'x1native'  },
  [XNM_MINT]:    { symbol: 'XNM',                       iconClass: 'lb',     color: C_GRAY,   kind: 'x1native'  },
  [XUNI_MINT]:   { symbol: 'XUNI',                      iconClass: 'lb',     color: C_GREEN,  kind: 'x1native'  },
  [XBLK_MINT]:   { symbol: 'XBLK',                      iconClass: 'lb',     color: C_GRAY,   kind: 'x1native'  },
};

// Token icon that fills the 34×34 cell. Real logo first; letter fallback.
function TokenIcon({ h, size = 30 }: { h: Holding; size?: number }) {
  const [failed, setFailed] = useState(false);
  const radius = Math.max(5, Math.round(size * 0.27));
  if (h.logo && !failed) {
    return (
      <div style={{
        width: size, height: size, borderRadius: radius,
        background: `#06090d url(${h.logo}) center/115% no-repeat`,
        border: `1px solid ${h.color}55`, flexShrink: 0,
      }}>
        <img src={h.logo} alt="" onError={() => setFailed(true)} style={{ display: 'none' }} />
      </div>
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: radius,
      background: `linear-gradient(135deg, ${h.color}, ${h.color}99)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#0a0e14', fontFamily: "'JetBrains Mono',monospace",
      fontSize: Math.round(size * 0.46), fontWeight: 800, flexShrink: 0,
    }}>{h.symbol[0]}</div>
  );
}

// NFT thumbnail that pops a large preview on hover — mirrors the roster-wall
// hover behavior so citizens can actually see their artwork from the portfolio.
function NftHoverThumb({ src, name, listed }: { src?: string; name?: string; listed?: string | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pop, setPop] = useState<{ left: number; top: number } | null>(null);

  const open = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = 280;
    const wantRight = r.right + 14 + W < window.innerWidth;
    const left = wantRight ? r.right + 14 : r.left - 14 - W;
    // Vertically center the ~320px card on the thumb, clamped to viewport.
    const top = Math.min(Math.max(12, r.top + r.height / 2 - 165), window.innerHeight - 342);
    setPop({ left, top });
  };

  return (
    <div
      ref={ref}
      className="pfx-nfticon"
      onMouseEnter={open}
      onMouseLeave={() => setPop(null)}
      style={{ cursor: 'zoom-in' }}
    >
      <V2NFTImage src={src} name={name} width={80} />
      {pop && createPortal(
        <div
          style={{
            position: 'fixed', left: pop.left, top: pop.top, width: 280, zIndex: 9999,
            pointerEvents: 'none',
            background: '#0a0f16', border: '1px solid rgba(191,90,242,.45)',
            borderRadius: 14, padding: 10,
            boxShadow: '0 18px 50px rgba(0,0,0,.7), 0 0 0 1px rgba(0,0,0,.4)',
            animation: 'pfxPop .14s ease-out',
          }}
        >
          <div style={{
            position: 'relative', width: '100%', aspectRatio: '1 / 1',
            borderRadius: 9, overflow: 'hidden', background: '#06090d',
            border: '1px solid rgba(191,90,242,.25)',
          }}>
            <V2NFTImage src={src} name={name} width={600} priority />
          </div>
          <div style={{
            marginTop: 9, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          }}>
            <span style={{
              fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700,
              color: '#e8edf5', letterSpacing: .4, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{name || 'NFT'}</span>
            <span style={{
              flexShrink: 0,
              fontFamily: 'Orbitron, monospace', fontSize: 8.5, fontWeight: 800, letterSpacing: .6,
              padding: '2px 7px', borderRadius: 5,
              background: listed ? 'rgba(191,90,242,.14)' : 'rgba(138,154,184,.13)',
              color: listed ? C_PURPLE : '#8a9ab8',
              border: `1px solid ${listed ? 'rgba(191,90,242,.32)' : 'rgba(138,154,184,.25)'}`,
            }}>{listed ? `LISTED · ${listed}` : 'UNLISTED'}</span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function useIsMobile() {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

type Program = 'spl' | 't22';
type Category = 'core' | 'lp' | 'nft' | 'other';

type Holding = {
  symbol: string;
  mint: string;
  balance: number;
  usd?: number;
  logo?: string;
  metaUri?: string;
  iconClass: string;
  color: string;
  program: Program;
  category: Category;
  decimals: number;
  kind?: TokenKind;
  lpInfo?: { pairSymbol: string; rewardSymbol: string };
  listedPrice?: number;
};

type RawEntry = { mint: string; balance: number; program: Program; decimals: number };

function isNftLike(r: RawEntry): boolean {
  return r.decimals === 0 && r.balance > 0 && r.balance < 1_000_000;
}

async function fetchTokenBalances(
  connection: any,
  owner: PublicKey,
): Promise<{ raw: RawEntry[] }> {
  const [spl, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const raw: RawEntry[] = [];
  for (const acc of spl.value ?? []) {
    const info = acc.account.data.parsed?.info;
    if (info?.mint && info?.tokenAmount?.uiAmount > 0) {
      raw.push({ mint: info.mint, balance: info.tokenAmount.uiAmount, program: 'spl', decimals: info.tokenAmount.decimals ?? 0 });
    }
  }
  for (const acc of t22.value ?? []) {
    const info = acc.account.data.parsed?.info;
    if (info?.mint && info?.tokenAmount?.uiAmount > 0) {
      raw.push({ mint: info.mint, balance: info.tokenAmount.uiAmount, program: 't22', decimals: info.tokenAmount.decimals ?? 0 });
    }
  }
  return { raw };
}

// Retry a flaky RPC/HTTP call with exponential backoff on 429 / rate-limit
// errors. The single X1 RPC has no fallback, so a burst can 429 transiently.
async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const rateLimited = msg.includes('429') || /too many requests/i.test(msg);
      if (!rateLimited || i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * 2 ** i)); // 0.5s · 1s · 2s
    }
  }
  throw lastErr;
}

// Run async tasks with a concurrency cap so background enrichment doesn't
// burst the single rate-limited RPC. Each task swallows its own errors.
async function runThrottled(tasks: Array<() => Promise<void>>, limit = 4): Promise<void> {
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length) {
      const t = tasks[idx++];
      try { await t(); } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

// ── chart geometry helpers (inline SVG, no libs) ───────────────
function smoothLinePath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0]},${pts[0][1]}`;
  let d = `M ${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function fmtK(v: number): string {
  if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(Math.abs(v) >= 100000 ? 0 : 1) + 'k';
  return '$' + Math.round(v);
}

type Chart = {
  line: string; area: string; W: number; H: number;
  ticks: { y: number; label: string }[];
  dots: { x: number; y: number }[];
  lastX: number; lastY: number;
};

function buildChart(series: number[]): Chart | null {
  const W = 920, H = 300, padT = 22, padB = 30, padL = 12, padR = 16;
  const n = series.length;
  if (n < 2) return null;
  const min = Math.min(...series), max = Math.max(...series);
  const range = (max - min) || 1;
  const pad = range * 0.15;
  const lo = min - pad, hi = max + pad;
  const X = (i: number) => padL + (W - padL - padR) * (i / (n - 1));
  const Y = (v: number) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const pts: [number, number][] = series.map((v, i) => [X(i), Y(v)]);
  const line = smoothLinePath(pts);
  const baseY = (H - padB).toFixed(1);
  const area = `${line} L ${pts[n - 1][0].toFixed(1)},${baseY} L ${pts[0][0].toFixed(1)},${baseY} Z`;
  const ticks: { y: number; label: string }[] = [];
  const tn = 4;
  for (let k = 0; k < tn; k++) {
    const v = hi - (hi - lo) * (k / (tn - 1));
    ticks.push({ y: Y(v), label: fmtK(v) });
  }
  const step = Math.max(1, Math.ceil(n / 6));
  const dots = pts.filter((_, i) => i === 0 || i === n - 1 || i % step === 0).map(p => ({ x: p[0], y: p[1] }));
  return { line, area, W, H, ticks, dots, lastX: pts[n - 1][0], lastY: pts[n - 1][1] };
}

function sparkPts(series?: number[]): string | null {
  if (!series || series.length < 2) return null;
  const w = 72, h = 22;
  const min = Math.min(...series), max = Math.max(...series);
  const r = (max - min) || 1;
  return series.map((v, i) =>
    `${(2 + (w - 4) * (i / (series.length - 1))).toFixed(1)},${(2 + (h - 4) * (1 - (v - min) / r)).toFixed(1)}`
  ).join(' ');
}

function stddev(a: number[]): number {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length;
  return Math.sqrt(v);
}

function injectPortfolioStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2pf-x12')) return;
  const s = document.createElement('style');
  s.id = 'v2pf-x12';
  s.textContent = `
  .pfx{--o:#f29030;--g:#00c98d;--pp:#bf5af2;--gy:#8a9ab8;--cyan:#00d4ff;
    --panel:#0c1118;--panel2:#0f1620;--line:#1a2433;--line2:#141d29;
    --txt:#e8edf5;--muted:#8a9ab8;--dim:#566173;
    color:var(--txt);font-family:'Sora',system-ui,sans-serif;}
  .pfx .num{font-family:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;font-variant-numeric:tabular-nums}

  .pfx-topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;gap:16px;flex-wrap:wrap}
  .pfx-title{font-family:'Orbitron',sans-serif;font-weight:800;font-size:20px;letter-spacing:1px;line-height:1}
  .pfx-title span{display:block;font-family:'Sora';font-weight:500;font-size:10px;letter-spacing:2.5px;color:var(--muted);margin-top:6px}
  .pfx-tb-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .pfx-clock{font-size:12.5px;color:var(--muted);background:var(--panel);border:1px solid var(--line);padding:8px 12px;border-radius:9px}
  .pfx-btn{font-family:'Sora';font-weight:600;font-size:12px;border:1px solid var(--line);background:var(--panel);color:var(--txt);padding:9px 15px;border-radius:9px;cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:8px;letter-spacing:.5px}
  .pfx-btn:hover{border-color:var(--o);color:#fff}
  .pfx-btn.primary{background:linear-gradient(135deg,var(--o),#d97400);border-color:transparent;color:#0a0e14;font-weight:700}
  .pfx-btn.primary:disabled{opacity:.7;cursor:default}

  .pfx-panel{background:var(--v2-glow),linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:16px;position:relative;display:flex;flex-direction:column}
  .pfx-panel::before{content:'';position:absolute;left:0;top:18px;bottom:18px;width:2px;border-radius:2px;
    background:linear-gradient(180deg,transparent,var(--o),transparent);box-shadow:0 0 12px rgba(242,144,48,.45)}
  .pfx-phead{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 12px}
  .pfx-phead h3{font-size:11px;letter-spacing:2px;font-weight:600;color:var(--muted);text-transform:uppercase;display:flex;align-items:center;gap:9px;margin:0}
  .pfx-phead h3 .tk{width:5px;height:14px;border-radius:2px;background:var(--o)}
  .pfx-sub{font-size:11px;color:var(--dim)}

  .pfx-grid{display:grid;grid-template-columns:1fr 348px;gap:16px;margin-bottom:16px}
  .pfx-grid2{display:grid;grid-template-columns:1.35fr 1fr;gap:16px;margin-bottom:16px}

  .pfx-hero-head{padding:20px 22px 4px}
  .pfx-nw-label{font-size:11px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:7px}
  .pfx-nw-val{font-size:42px;letter-spacing:-1px;line-height:1;font-weight:700}
  .pfx-nw-val .cents{color:var(--muted);font-size:26px}
  .pfx-delta{display:inline-flex;align-items:center;gap:8px;margin-top:11px;font-weight:600;font-size:14px}
  .pfx-delta .pct{background:rgba(0,201,141,.12);border:1px solid rgba(0,201,141,.28);padding:3px 9px;border-radius:7px;font-size:12.5px;font-family:'JetBrains Mono',monospace}
  .pfx-chart-area{padding:4px 12px 14px}
  .pfx-chart-area svg{display:block;width:100%;height:auto;overflow:visible}
  .pfx-chart-empty{padding:40px 16px;text-align:center;color:var(--dim);font-size:12.5px}
  .pfx-xaxis{display:flex;justify-content:space-between;padding:0 6px;margin-top:4px}
  .pfx-xaxis span{font-size:10px;color:var(--dim);font-family:'JetBrains Mono',monospace}

  .pfx-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:6px 16px 16px;flex:1;align-content:center}
  .pfx-kpi{background:#0a0f16;border:1px solid var(--line2);border-radius:12px;padding:13px 14px}
  .pfx-kpi .k-top{display:flex;align-items:center;justify-content:space-between}
  .pfx-kpi .k-lab{font-size:10px;letter-spacing:1.3px;color:var(--muted);text-transform:uppercase}
  .pfx-kpi .k-val{font-weight:700;font-size:21px;margin-top:7px;line-height:1}
  .pfx-trend{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;font-family:'JetBrains Mono',monospace}
  .pfx-trend.up{color:var(--g)}.pfx-trend.flat{color:var(--muted)}.pfx-trend.dn{color:var(--gy)}

  .pfx-strip{display:grid;grid-template-columns:repeat(5,1fr);padding:4px 6px 8px}
  .pfx-stat{padding:14px 16px;text-align:center;border-right:1px solid var(--line2)}
  .pfx-stat:last-child{border-right:none}
  .pfx-stat .s-val{font-weight:700;font-size:25px;line-height:1}
  .pfx-stat .s-lab{font-size:10px;letter-spacing:1.3px;color:var(--muted);text-transform:uppercase;margin-top:7px}
  .pfx-stat .s-val.o{color:var(--o)}.pfx-stat .s-val.g{color:var(--g)}.pfx-stat .s-val.p{color:var(--pp)}

  .pfx-donut-wrap{display:flex;align-items:center;gap:18px;padding:6px 20px 20px}
  .pfx-donut-box{position:relative;flex-shrink:0;width:200px;height:200px}
  .pfx-donut-center{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
  .pfx-donut-center .dc-lab{font-size:9.5px;letter-spacing:2px;color:var(--muted);text-transform:uppercase}
  .pfx-donut-center .dc-val{font-weight:700;font-size:19px;margin-top:3px}
  .pfx-donut-center .dc-sub{font-size:10.5px;color:var(--muted);margin-top:2px}
  .pfx-legend{flex:1;display:flex;flex-direction:column;gap:11px}
  .pfx-legend .leg-row{display:flex;align-items:center;gap:10px;font-size:13px}
  .pfx-legend .leg-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
  .pfx-legend .leg-name{font-weight:600;flex:1;letter-spacing:.3px}
  .pfx-legend .leg-usd{font-weight:600;font-size:12.5px}
  .pfx-legend .leg-pct{color:var(--muted);font-size:11.5px;width:46px;text-align:right}

  .pfx-rank{padding:8px 20px 18px;display:flex;flex-direction:column;gap:11px;flex:1;justify-content:center}
  .pfx-rank .rk-row{display:grid;grid-template-columns:128px 1fr 92px;align-items:center;gap:12px}
  .pfx-rank .rk-name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pfx-rank .rk-track{height:14px;background:#0a0f16;border-radius:5px;overflow:hidden;border:1px solid var(--line2)}
  .pfx-rank .rk-fill{height:100%;border-radius:5px}
  .pfx-rank .rk-usd{font-size:12px;text-align:right;font-weight:600}

  .pfx-grp{margin-bottom:14px}
  .pfx-grp-head{display:flex;align-items:center;gap:10px;padding:6px 4px 12px}
  .pfx-grp-head .gtk{width:5px;height:15px;border-radius:2px}
  .pfx-grp-head h4{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-weight:600;margin:0}
  .pfx-grp-head .gcount{font-size:11px;color:var(--muted);background:#0a0f16;border:1px solid var(--line2);padding:2px 8px;border-radius:20px}

  .pfx-row{position:relative;display:grid;grid-template-columns:40px minmax(150px,1fr) 96px 120px 124px 140px 92px;align-items:center;padding:12px 16px 12px 18px;border:1px solid var(--line2);border-radius:11px;background:#0a0f16;margin-bottom:8px;transition:.13s;overflow:hidden}
  .pfx-row:hover{border-color:var(--line);background:#0c1219}
  .pfx-row::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;
    background:linear-gradient(180deg,transparent,var(--o),transparent);box-shadow:0 0 9px rgba(242,144,48,.45)}
  .pfx-nfticon{position:relative;width:34px;height:34px;border-radius:9px;overflow:hidden;flex-shrink:0;background:#06090d;border:1px solid rgba(191,90,242,.4)}
  .pfx-cell-sym{padding-left:12px;min-width:0}
  .pfx-sym{font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .pfx-badge{font-size:8.5px;letter-spacing:.7px;font-weight:700;padding:2px 6px;border-radius:5px;text-transform:uppercase;white-space:nowrap}
  .pfx-badge.b-o{background:rgba(242,144,48,.13);color:var(--o);border:1px solid rgba(242,144,48,.25)}
  .pfx-badge.b-g{background:rgba(0,201,141,.13);color:var(--g);border:1px solid rgba(0,201,141,.25)}
  .pfx-badge.b-p{background:rgba(191,90,242,.13);color:var(--pp);border:1px solid rgba(191,90,242,.25)}
  .pfx-badge.b-n{background:rgba(138,154,184,.12);color:var(--muted);border:1px solid rgba(138,154,184,.22)}
  .pfx-meta{font-size:10.5px;color:var(--dim);margin-top:5px;display:flex;gap:7px;align-items:center}
  .pfx-meta .prog{color:var(--muted)}
  .pfx-meta .mint{font-family:'JetBrains Mono',monospace;color:var(--dim)}
  .pfx-cell-spark{display:grid;place-items:center}
  .pfx-cell-spark .pfx-dash{color:var(--dim);font-size:11px}
  .pfx-cell-price,.pfx-cell-bal,.pfx-cell-val{padding-right:14px;text-align:right}
  .pfx-row .c-lab{font-size:9px;letter-spacing:1px;color:var(--dim);text-transform:uppercase;margin-bottom:3px}
  .pfx-price{font-size:13px;font-weight:500}
  .pfx-bal{font-size:13px}
  .pfx-usd{font-size:14px;font-weight:700;color:var(--g)}
  .pfx-usd.zero{color:var(--dim)}
  .pfx-send{font-family:'Sora';font-weight:600;font-size:11.5px;border:1px solid var(--line);background:transparent;color:var(--muted);padding:7px 0;width:100%;border-radius:8px;cursor:pointer;transition:.13s}
  .pfx-send:hover{border-color:var(--o);color:var(--o);background:rgba(242,144,48,.06)}

  .pfx-place{padding:40px 16px;text-align:center}
  .pfx-place .glyph{font-size:30px;color:var(--o);margin-bottom:10px}
  .pfx-place .sub{color:var(--muted);font-size:13px}

  /* ── compact scale + softer glow ── */
  .pfx-topbar{margin-bottom:13px}
  .pfx-title{font-size:16px;letter-spacing:.8px}
  .pfx-title span{font-size:9px;margin-top:4px}
  .pfx-clock{font-size:11px;padding:7px 11px}
  .pfx-btn{font-size:11px;padding:8px 13px}
  .pfx-panel{border-radius:13px}
  .pfx-panel::before{top:15px;bottom:15px;background:linear-gradient(180deg,transparent,rgba(242,144,48,.7),transparent);box-shadow:0 0 6px rgba(242,144,48,.2)}
  .pfx-phead{padding:12px 16px 9px}
  .pfx-phead h3{font-size:10px}
  .pfx-phead h3 .tk{height:12px}
  .pfx-sub{font-size:10px}
  .pfx-grid{grid-template-columns:1fr 290px;gap:12px;margin-bottom:12px}
  .pfx-grid2{gap:12px;margin-bottom:12px}
  .pfx-hero-head{padding:14px 16px 2px}
  .pfx-nw-label{font-size:10px;margin-bottom:5px}
  .pfx-nw-val{font-size:29px}
  .pfx-nw-val .cents{font-size:18px}
  .pfx-delta{font-size:12px;margin-top:7px;gap:6px}
  .pfx-delta .pct{font-size:11px;padding:2px 7px}
  .pfx-chart-area{padding:2px 10px 12px}
  .pfx-chart-empty{padding:30px 14px;font-size:11.5px}
  .pfx-xaxis span{font-size:9px}
  .pfx-kpis{gap:8px;padding:4px 12px 12px}
  .pfx-kpi{padding:9px 10px;border-radius:10px}
  .pfx-kpi .k-lab{font-size:9px}
  .pfx-kpi .k-val{font-size:16px;margin-top:5px}
  .pfx-trend{font-size:10px}
  .pfx-strip .pfx-stat{padding:10px 10px}
  .pfx-stat .s-val{font-size:19px}
  .pfx-stat .s-lab{font-size:9px;margin-top:5px}
  .pfx-donut-wrap{padding:4px 16px 16px;gap:14px}
  .pfx-donut-box{width:148px;height:148px}
  .pfx-donut-center .dc-lab{font-size:9px}
  .pfx-donut-center .dc-val{font-size:15px}
  .pfx-donut-center .dc-sub{font-size:9.5px}
  .pfx-legend{gap:8px}
  .pfx-legend .leg-row{font-size:11.5px}
  .pfx-legend .leg-dot{width:9px;height:9px}
  .pfx-legend .leg-usd{font-size:11.5px}
  .pfx-legend .leg-pct{font-size:10.5px;width:42px}
  .pfx-rank{padding:6px 16px 15px;gap:8px}
  .pfx-rank .rk-row{grid-template-columns:108px 1fr 80px;gap:10px}
  .pfx-rank .rk-name{font-size:11.5px}
  .pfx-rank .rk-track{height:12px}
  .pfx-rank .rk-usd{font-size:11px}
  .pfx-grp{margin-bottom:11px}
  .pfx-grp-head{padding:5px 4px 9px}
  .pfx-grp-head .gtk{height:13px}
  .pfx-grp-head h4{font-size:11px}
  .pfx-grp-head .gcount{font-size:10px;padding:2px 7px}
  .pfx-row{grid-template-columns:32px minmax(120px,1fr) 74px 100px 104px 120px 74px;padding:8px 12px 8px 13px}
  .pfx-row::before{top:6px;bottom:6px;background:linear-gradient(180deg,transparent,rgba(242,144,48,.6),transparent);box-shadow:0 0 4px rgba(242,144,48,.16)}
  .pfx-nfticon{width:30px;height:30px;border-radius:8px}
  .pfx-cell-sym{padding-left:10px}
  .pfx-sym{font-size:12px;gap:6px}
  .pfx-badge{font-size:8px;padding:1.5px 5px}
  .pfx-meta{font-size:9.5px;margin-top:3px;gap:6px}
  .pfx-cell-spark .pfx-dash{font-size:10px}
  .pfx-cell-price,.pfx-cell-bal,.pfx-cell-val{padding-right:12px}
  .pfx-row .c-lab{font-size:8px;margin-bottom:2px}
  .pfx-price{font-size:12px}
  .pfx-bal{font-size:12px}
  .pfx-usd{font-size:12.5px}
  .pfx-send{font-size:10.5px;padding:6px 0}
  .pfx-place{padding:30px 14px}
  .pfx-place .glyph{font-size:26px}
  .pfx-place .sub{font-size:12px}

  /* ── scan loader ── */
  .pfx-loader{padding:38px 20px 32px;text-align:center}
  .pfx-radar{position:relative;width:88px;height:88px;margin:0 auto 20px}
  .pfx-radar-ring{position:absolute;inset:0;border-radius:50%;border:1px solid rgba(242,144,48,.28)}
  .pfx-radar-ring::before{content:'';position:absolute;inset:14px;border-radius:50%;border:1px solid rgba(242,144,48,.16)}
  .pfx-radar-ring::after{content:'';position:absolute;inset:28px;border-radius:50%;border:1px solid rgba(242,144,48,.1)}
  .pfx-radar-sweep{position:absolute;inset:0;border-radius:50%;
    background:conic-gradient(from 0deg, rgba(242,144,48,0) 0deg, rgba(242,144,48,.45) 70deg, rgba(242,144,48,0) 95deg);
    animation:pfx-sweep 1.3s linear infinite}
  .pfx-radar-core{position:absolute;top:50%;left:50%;width:8px;height:8px;border-radius:50%;
    transform:translate(-50%,-50%);background:#f29030;box-shadow:0 0 12px #f29030,0 0 26px rgba(242,144,48,.5);
    animation:pfx-corepulse 1.3s ease-in-out infinite}
  @keyframes pfx-sweep{to{transform:rotate(360deg)}}
  @keyframes pfx-corepulse{0%,100%{opacity:1;transform:translate(-50%,-50%) scale(1)}50%{opacity:.55;transform:translate(-50%,-50%) scale(1.5)}}
  .pfx-loader-msg{font-family:'Orbitron',sans-serif;font-size:13px;font-weight:600;color:#f29030;letter-spacing:.6px;min-height:18px;text-shadow:0 0 12px rgba(242,144,48,.4)}
  .pfx-loader-msg .m{display:inline-block;animation:pfx-fadein .35s ease}
  @keyframes pfx-fadein{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
  @keyframes pfxPop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}
  .pfx-cursor{display:inline-block;margin-left:2px;color:#f29030;animation:pfx-blink 1s step-end infinite}
  @keyframes pfx-blink{50%{opacity:0}}
  .pfx-loader-sub{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;color:#566173;letter-spacing:2.5px;margin-top:10px}
  .pfx-loader-bar{width:200px;max-width:72%;height:3px;border-radius:3px;background:rgba(242,144,48,.1);margin:18px auto 0;overflow:hidden}
  .pfx-loader-fill{height:100%;width:38%;border-radius:3px;background:linear-gradient(90deg,transparent,#f29030,transparent);
    animation:pfx-indet 1.15s ease-in-out infinite}
  @keyframes pfx-indet{0%{transform:translateX(-130%)}100%{transform:translateX(360%)}}

  @media(max-width:1000px){
    .pfx-grid,.pfx-grid2{grid-template-columns:1fr}
    .pfx-row{grid-template-columns:36px 1fr auto}
    .pfx-cell-spark,.pfx-cell-price,.pfx-cell-bal{display:none}
  }
  `;
  document.head.appendChild(s);
}

const LOADER_MESSAGES = [
  'Scanning wallet accounts',
  'Reading SPL + Token-2022 balances',
  'Collecting token metadata',
  'Resolving NFT artwork',
  'Detecting LP positions',
  'Fetching live prices',
  'Computing allocation',
  'Building your portfolio',
];

function PortfolioLoader() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI(n => (n + 1) % LOADER_MESSAGES.length), 1300);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="pfx-panel">
      <div className="pfx-loader">
        <div className="pfx-radar">
          <div className="pfx-radar-ring" />
          <div className="pfx-radar-sweep" />
          <div className="pfx-radar-core" />
        </div>
        <div className="pfx-loader-msg">
          <span className="m" key={i}>{LOADER_MESSAGES[i]}</span><span className="pfx-cursor">▮</span>
        </div>
        <div className="pfx-loader-bar"><div className="pfx-loader-fill" /></div>
        <div className="pfx-loader-sub">SCANNING X1 MAINNET</div>
      </div>
    </div>
  );
}

export default function V2Portfolio() {
  useEffect(() => { injectPortfolioStyles(); primeFromIndexer(); }, []);

  const { connection } = useConnection();
  const { publicKey, connected, signTransaction, signAllTransactions } = useWallet();
  // Memoized so the per-second clock re-render doesn't hand SendPanel a new
  // wallet object every tick (which would re-run its effects mid-send).
  const wallet = useMemo(
    () => (publicKey ? { publicKey, signTransaction, signAllTransactions } : null),
    [publicKey, signTransaction, signAllTransactions],
  );
  const isMobile = useIsMobile();

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const metaMap = useRef<Map<string, { symbol?: string; name?: string }>>(new Map());
  const myListingsRef = useRef<Map<string, number>>(new Map());
  const [xntBalance, setXntBalance] = useState(0);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);

  const [activeSendMint,  setActiveSendMint]  = useState<string | null>(null);
  const [savedAddresses,  setSavedAddresses]  = useState<SavedAddress[]>([]);
  const [snapStatus,      setSnapStatus]      = useState<'' | 'saving' | 'saved' | 'error'>('');
  const [shareOpen,       setShareOpen]       = useState(false);

  // Load address book when wallet connects
  useEffect(() => {
    if (!publicKey) { setSavedAddresses([]); return; }
    let alive = true;
    getSavedAddresses(publicKey.toBase58()).then(rows => {
      if (!alive) return;
      setSavedAddresses(rows.map(r => ({ id: r.id, wallet: r.saved_wallet, nickname: r.nickname, created_at: r.created_at })));
    }).catch(() => {});
    return () => { alive = false; };
  }, [publicKey]);

  const handleSaveAddress = async (savedWallet: string, nickname: string) => {
    if (!publicKey) return;
    await insertSavedAddress({ owner_wallet: publicKey.toBase58(), saved_wallet: savedWallet, nickname });
    const rows = await getSavedAddresses(publicKey.toBase58());
    setSavedAddresses(rows.map(r => ({ id: r.id, wallet: r.saved_wallet, nickname: r.nickname, created_at: r.created_at })));
  };
  const handleDeleteAddress = async (id: string) => {
    await deleteSavedAddress(id);
    setSavedAddresses(prev => prev.filter(a => a.id !== id));
  };
  const handleSendComplete = async (records: SendHistoryRow[]) => {
    for (const r of records) {
      await insertSendRecord({
        from_wallet: r.from_wallet, to_wallet: r.to_wallet,
        mint: r.mint, symbol: r.symbol, amount: r.amount,
        tx_sig: r.tx_sig, sent_at: r.sent_at,
      });
    }
    // Re-scan the wallet so sent/burned tokens drop off. A short delay lets the
    // RPC propagate the post-transfer/burn state before we re-read balances.
    setTimeout(() => setReloadNonce(n => n + 1), 1800);
  };

  // ── Fetch balances + snapshot ──────────────────────────
  useEffect(() => {
    if (!publicKey) {
      setHoldings([]); setXntBalance(0); setSnapshots([]);
      return;
    }
    let alive = true;
    setLoading(true);

    const seedPrices = (): Record<string, number> => ({
      [BRAINS_MINT]: getCachedPrice(BRAINS_MINT),
      [LB_MINT]:     getCachedPrice(LB_MINT),
      [XNT_MINT]:    getCachedPrice(XNT_MINT),
    });
    const buildHoldings = (
      raw: RawEntry[],
      priceMap: Record<string, number>,
      lpMap: Map<string, { pair: string; reward: string; lpPriceUsd: number }>,
    ): Holding[] => raw.map(r => {
      const known = KNOWN[r.mint];
      const lp    = lpMap.get(r.mint);
      if (known) {
        const resolvedLogo = known.logo ?? getCachedTokenLogo(r.mint) ?? undefined;
        return {
          symbol: known.symbol, mint: r.mint, balance: r.balance,
          usd: r.balance * (priceMap[r.mint] || 0),
          logo: resolvedLogo, iconClass: known.iconClass,
          color: known.color, kind: known.kind,
          program: r.program, category: 'core', decimals: r.decimals,
        };
      }
      if (lp) {
        return {
          symbol: lp.pair, mint: r.mint, balance: r.balance,
          usd: r.balance * lp.lpPriceUsd,
          iconClass: lp.reward === 'BRAINS' ? 'brains' : 'lb',
          color: C_SILVER,
          program: r.program, category: 'lp', decimals: r.decimals,
          lpInfo: { pairSymbol: lp.pair, rewardSymbol: lp.reward },
        };
      }
      if (isNftLike(r)) {
        const cachedLogo = getCachedTokenLogo(r.mint) ?? undefined;
        const meta = metaMap.current.get(r.mint);
        const displaySymbol = meta?.name || meta?.symbol || shortAddr(r.mint, 4, 4);
        const listedPrice = myListingsRef.current.get(r.mint);
        return {
          symbol: displaySymbol, mint: r.mint, balance: r.balance,
          usd: r.balance * (priceMap[r.mint] || 0),
          logo: cachedLogo, iconClass: 'lb', color: C_PURPLE,
          program: r.program, category: 'nft', decimals: r.decimals,
          listedPrice,
        };
      }
      const cachedLogo = getCachedTokenLogo(r.mint) ?? undefined;
      const otherMeta = metaMap.current.get(r.mint);
      return {
        symbol: otherMeta?.symbol || shortAddr(r.mint, 4, 4),
        mint: r.mint, balance: r.balance,
        usd: r.balance * (priceMap[r.mint] || 0),
        logo: cachedLogo, iconClass: 'lb', color: C_GRAY,
        program: r.program, category: 'other', decimals: r.decimals,
      };
    });

    let lastRaw: RawEntry[] = [];
    const lpMap = new Map<string, { pair: string; reward: string; lpPriceUsd: number }>();
    let priceMap: Record<string, number> = seedPrices();

    (async () => {
      try {
        const [lamports, { raw }] = await Promise.all([
          withRetry(() => connection.getBalance(publicKey)),
          withRetry(() => fetchTokenBalances(connection, publicKey)),
        ]);
        if (!alive) return;
        lastRaw = raw;

        setXntBalance(lamports / 1e9);
        setPrices(priceMap);
        setHoldings(buildHoldings(raw, priceMap, lpMap));
        setErr('');
        setLoading(false);

        const repaint = () => {
          if (!alive) return;
          setPrices({ ...priceMap });
          setHoldings(buildHoldings(lastRaw, priceMap, lpMap));
        };

        fetchAllPrices().then(base => {
          if (!alive) return;
          priceMap = { ...priceMap, [BRAINS_MINT]: base.BRAINS, [LB_MINT]: base.LB, [XNT_MINT]: base.XNT };
          repaint();
        }).catch(() => {});

        fetchFarms(connection).then(farms => {
          if (!alive) return;
          for (const f of farms) {
            lpMap.set(f.lpMint, { pair: f.lpSymbol || 'LP', reward: f.rewardSymbol || '', lpPriceUsd: f.lpPriceUsd ?? 0 });
          }
          repaint();
        }).catch(() => {});

        const owner = publicKey.toBase58();
        fetchAllListings(connection).then(listings => {
          if (!alive) return;
          const mine = new Map<string, number>();
          for (const l of listings) { if (l.seller === owner) mine.set(l.nftMint, l.price); }
          myListingsRef.current = mine;
          repaint();
        }).catch(() => {});

        const unknownMints = raw.map(r => r.mint).filter(m => !priceMap[m] && !KNOWN[m]).slice(0, 12);
        runThrottled(unknownMints.map(m => async () => {
          const p = await withRetry(() => fetchPrice(m));
          if (!alive || p <= 0) return;
          priceMap = { ...priceMap, [m]: p };
          repaint();
        }), 4);

        const needMeta = raw.filter(r => {
          if (isNftLike(r)) return true;
          if (KNOWN[r.mint]?.logo) return false;
          if (metaMap.current.has(r.mint) && getCachedTokenLogo(r.mint)) return false;
          return true;
        }).slice(0, 30);
        runThrottled(needMeta.map(r => async () => {
          const meta = await withRetry(() => fetchTokenMeta(r.mint));
          if (!alive || !meta) return;
          let touched = false;
          if (meta.logo) { setCachedTokenLogo(r.mint, meta.logo); touched = true; }
          const sym = meta.symbol;
          const name = meta.name;
          const looksReal = (s?: string) => !!s && s.length > 0 && s !== r.mint.slice(0, 6) && s !== r.mint.slice(0, 4).toUpperCase();
          if (looksReal(sym) || looksReal(name)) { metaMap.current.set(r.mint, { symbol: sym, name }); touched = true; }
          if (touched) repaint();
        }), 4);

        getPortfolioSnapshots(publicKey.toBase58()).then(snaps => {
          if (alive) setSnapshots(snaps);
        }).catch(() => {});
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message ?? 'Failed to load balances');
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [publicKey, connection, reloadNonce]);

  const xntHolding: Holding | null = publicKey
    ? {
        symbol: 'XNT', mint: XNT_MINT, balance: xntBalance,
        usd: xntBalance * (prices[XNT_MINT] || 0),
        logo: XNT_LOGO, iconClass: 'xnt', color: C_ORANGE,
        program: 'spl', category: 'core', decimals: 9,
      }
    : null;

  const allRows = useMemo(
    () => (xntHolding ? [xntHolding, ...holdings] : []).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
    [xntHolding, holdings],
  );

  const netWorth   = allRows.reduce((s, h) => s + (h.usd ?? 0), 0);
  // Holdings → SnapshotToken[] for the shareable/downloadable portfolio card.
  const shareTokens = useMemo<SnapshotToken[]>(
    () => allRows.map(h => ({
      mint: h.mint, symbol: h.symbol, balance: h.balance,
      usd: h.usd ?? 0, price: h.balance > 0 ? (h.usd ?? 0) / h.balance : 0,
      logo: h.logo,
    })),
    [allRows],
  );
  const splCount   = holdings.filter(h => h.program === 'spl').length + (xntHolding ? 1 : 0);
  const t22Count   = holdings.filter(h => h.program === 't22').length;
  const lpCount    = holdings.filter(h => h.category === 'lp').length;
  const nftCount   = holdings.filter(h => h.category === 'nft').length;
  const coreUsd    = allRows.filter(h => h.category === 'core').reduce((s, h) => s + (h.usd ?? 0), 0);
  const lpUsd      = allRows.filter(h => h.category === 'lp').reduce((s, h) => s + (h.usd ?? 0), 0);
  const nftUsd     = allRows.filter(h => h.category === 'nft').reduce((s, h) => s + (h.usd ?? 0), 0);
  const otherUsd   = allRows.filter(h => h.category === 'other').reduce((s, h) => s + (h.usd ?? 0), 0);

  // 24h delta from snapshots
  const snapshotDelta = useMemo(() => {
    if (snapshots.length < 2 || netWorth <= 0) return null;
    const sorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const prev = sorted[sorted.length - 1];
    if (!prev || !prev.total_usd) return null;
    const delta = netWorth - prev.total_usd;
    const pct = (delta / prev.total_usd) * 100;
    return { delta, pct };
  }, [snapshots, netWorth]);

  // Net-worth series (sorted snapshot totals + current point)
  const nwSeries = useMemo(() => {
    const sorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const s = sorted.map(x => x.total_usd || 0).filter(v => v > 0);
    if (netWorth > 0 && (s.length === 0 || Math.abs(s[s.length - 1] - netWorth) > 0.01)) s.push(netWorth);
    return s;
  }, [snapshots, netWorth]);

  // Per-mint USD series for row sparklines
  const mintSeries = useMemo(() => {
    const m = new Map<string, number[]>();
    const sorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    for (const snap of sorted) {
      for (const t of (snap.token_breakdown || [])) {
        if (!t?.mint) continue;
        const arr = m.get(t.mint) || [];
        arr.push(t.usd || 0);
        m.set(t.mint, arr);
      }
    }
    return m;
  }, [snapshots]);

  // Persist today's snapshot once we have full data
  useEffect(() => {
    if (!publicKey || netWorth <= 0 || allRows.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    upsertPortfolioSnapshot({
      wallet: publicKey.toBase58(),
      snapshot_date: today,
      total_usd: netWorth,
      token_breakdown: allRows.map(h => ({ mint: h.mint, symbol: h.symbol, balance: h.balance, usd: h.usd ?? 0, price: prices[h.mint] || 0 })),
    }).catch(() => {});
  }, [publicKey, netWorth, allRows, prices]);

  // Live clock
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const utc = new Date(now).toISOString().slice(11, 19);

  const groups: Array<{ key: Category; label: string; rows: Holding[]; accent: string }> = [
    { key: 'core',  label: 'Ecosystem · Core',  accent: C_ORANGE,
      rows: allRows.filter(h => h.category === 'core')
        .sort((a, b) => (a.mint === XNT_MINT ? -1 : b.mint === XNT_MINT ? 1 : (b.usd ?? 0) - (a.usd ?? 0))) },
    { key: 'other', label: 'SPL · Token-2022 Tokens', rows: allRows.filter(h => h.category === 'other'), accent: C_GRAY },
    { key: 'lp',    label: 'LP Tokens',         rows: allRows.filter(h => h.category === 'lp'),    accent: C_SILVER },
    { key: 'nft',   label: 'NFTs · Collectibles', rows: allRows.filter(h => h.category === 'nft'), accent: C_PURPLE },
  ].filter(g => g.rows.length > 0);

  // Manual snapshot
  const handleSaveSnapshot = async () => {
    if (!publicKey || netWorth <= 0 || allRows.length === 0) return;
    setSnapStatus('saving');
    const today = new Date().toISOString().slice(0, 10);
    try {
      await upsertPortfolioSnapshot({
        wallet: publicKey.toBase58(),
        snapshot_date: today,
        total_usd: netWorth,
        token_breakdown: allRows.map(h => ({ mint: h.mint, symbol: h.symbol, balance: h.balance, usd: h.usd ?? 0, price: prices[h.mint] || 0 })),
      });
      const fresh = await getPortfolioSnapshots(publicKey.toBase58());
      setSnapshots(fresh);
      setSnapStatus('saved');
      setTimeout(() => setSnapStatus(''), 2000);
    } catch {
      setSnapStatus('error');
      setTimeout(() => setSnapStatus(''), 2500);
    }
  };

  // ── derived view-model ──────────────────────────────────
  const chart = buildChart(nwSeries);
  const nwStr = fmtUSD(netWorth);
  const dotIdx = nwStr.lastIndexOf('.');
  const nwDollars = dotIdx >= 0 ? nwStr.slice(0, dotIdx) : nwStr;
  const nwCents   = dotIdx >= 0 ? nwStr.slice(dotIdx + 1) : '00';

  const win = nwSeries.slice(-14);
  const kHi = win.length ? Math.max(...win) : netWorth;
  const kLo = win.length ? Math.min(...win) : netWorth;
  const kChange = win.length > 1 ? win[win.length - 1] - win[0] : 0;
  const kChangePct = win.length > 1 && win[0] ? (kChange / win[0]) * 100 : 0;
  const rets: number[] = [];
  for (let i = 1; i < win.length; i++) { if (win[i - 1] > 0) rets.push((win[i] - win[i - 1]) / win[i - 1]); }
  const kVol = stddev(rets) * 100;
  const topAsset = allRows[0];
  const topPct = netWorth > 0 && topAsset ? ((topAsset.usd ?? 0) / netWorth) * 100 : 0;

  const DONUT_C = 2 * Math.PI * 88; // ≈ 552.92
  let cum = 0;
  const donutArcs = [
    { label: 'CORE',  usd: coreUsd,  color: C_ORANGE },
    { label: 'LP',    usd: lpUsd,    color: C_SILVER },
    { label: 'NFTS',  usd: nftUsd,   color: C_PURPLE },
    { label: 'OTHER', usd: otherUsd, color: C_GRAY   },
  ].map(s => {
    const pct = netWorth > 0 ? s.usd / netWorth : 0;
    const dash = pct * DONUT_C;
    const arc = { ...s, pct: pct * 100, dash, offset: -(cum * DONUT_C) };
    cum += pct;
    return arc;
  });

  const rankRows = [...allRows].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const rankMax = rankRows[0]?.usd || 1;
  const catColor = (c: Category) => c === 'lp' ? C_SILVER : c === 'nft' ? C_PURPLE : c === 'other' ? C_GRAY : C_ORANGE;

  const hasData = connected && !loading && !err && allRows.length > 0 && netWorth > 0;

  return (
    <div className="content content-wide pfx">
      {/* ── TOP BAR ── */}
      <div className="pfx-topbar">
        <div className="pfx-title">PORTFOLIO<span>ANALYTICS · X1 MAINNET</span></div>
        <div className="pfx-tb-right">
          <span className="pfx-clock num">{utc} UTC</span>
          {connected && netWorth > 0 && (
            <button
              type="button"
              className="pfx-btn primary"
              onClick={() => { handleSaveSnapshot(); setShareOpen(true); }}
            >
              ⊞ SNAPSHOT
            </button>
          )}
        </div>
      </div>

      {/* Share/download card — opens as a modal from the SNAPSHOT button */}
      {netWorth > 0 && (
        <PortfolioShareCard
          controlledOpen={shareOpen}
          onClose={() => setShareOpen(false)}
          totalUSD={netWorth}
          snapshotTokens={shareTokens}
          snapshots={snapshots}
          walletAddress={publicKey?.toBase58() ?? null}
          burnedTotal={0}
          labWorkPts={0}
          isMobile={isMobile}
        />
      )}

      {/* ── NOT CONNECTED ── */}
      {!connected && (
        <div className="pfx-panel"><div className="pfx-place">
          <div className="glyph">◇</div>
          <div className="sub">Connect a wallet to view your portfolio.</div>
        </div></div>
      )}

      {/* ── LOADING ── */}
      {connected && loading && allRows.length === 0 && <PortfolioLoader />}

      {/* ── ERROR ── */}
      {connected && !loading && err && (
        <div className="pfx-panel"><div className="pfx-place">
          <div className="glyph">⚠</div>
          <div className="sub">
            {/429|too many requests/i.test(err)
              ? 'The X1 RPC is rate-limiting right now (429). Give it a moment and retry.'
              : err}
          </div>
          <button type="button" className="pfx-btn primary" style={{ marginTop: 14 }} onClick={() => setReloadNonce(n => n + 1)}>↻ RETRY</button>
        </div></div>
      )}

      {/* ── EMPTY ── */}
      {connected && !loading && !err && allRows.length === 0 && (
        <div className="pfx-panel"><div className="pfx-place">
          <div className="glyph">◌</div>
          <div className="sub">No tokens detected for this wallet.</div>
        </div></div>
      )}

      {hasData && (
        <>
          {/* ── ROW 1: net worth + chart | KPIs ── */}
          <div className="pfx-grid">
            <div className="pfx-panel">
              <div className="pfx-hero-head">
                <div className="pfx-nw-label">Total Net Worth</div>
                <div className="pfx-nw-val num">{nwDollars}<span className="cents">.{nwCents}</span></div>
                {snapshotDelta && (
                  <div className="pfx-delta" style={{ color: snapshotDelta.delta >= 0 ? C_GREEN : C_GRAY }}>
                    <span>{snapshotDelta.delta >= 0 ? '▲' : '▼'}</span>
                    {snapshotDelta.delta >= 0 ? '+' : ''}{fmtUSD(snapshotDelta.delta)}
                    <span className="pct" style={{
                      color: snapshotDelta.delta >= 0 ? C_GREEN : C_GRAY,
                      background: snapshotDelta.delta >= 0 ? 'rgba(0,201,141,.12)' : 'rgba(138,154,184,.12)',
                      borderColor: snapshotDelta.delta >= 0 ? 'rgba(0,201,141,.28)' : 'rgba(138,154,184,.28)',
                    }}>{snapshotDelta.pct >= 0 ? '+' : ''}{snapshotDelta.pct.toFixed(2)}%</span>
                    <span style={{ color: C_GRAY, fontWeight: 500, fontSize: 12 }}>24h</span>
                  </div>
                )}
              </div>
              <div className="pfx-chart-area">
                {chart ? (
                  <>
                    <svg viewBox={`0 0 ${chart.W} ${chart.H}`} preserveAspectRatio="none" style={{ height: 200 }}>
                      <defs>
                        <linearGradient id="pfxFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={C_ORANGE} stopOpacity="0.30" />
                          <stop offset="55%" stopColor={C_ORANGE} stopOpacity="0.08" />
                          <stop offset="100%" stopColor={C_ORANGE} stopOpacity="0" />
                        </linearGradient>
                        <linearGradient id="pfxStroke" x1="0" y1="0" x2="1" y2="0">
                          <stop offset="0%" stopColor="#ffae4d" />
                          <stop offset="100%" stopColor={C_ORANGE} />
                        </linearGradient>
                      </defs>
                      <g stroke="#16202e" strokeWidth="1">
                        {chart.ticks.map((t, i) => <line key={i} x1="12" y1={t.y} x2={chart.W - 16} y2={t.y} />)}
                      </g>
                      <g fill="#566173" fontSize="10" fontFamily="monospace">
                        {chart.ticks.map((t, i) => <text key={i} x="14" y={t.y - 4}>{t.label}</text>)}
                      </g>
                      <path fill="url(#pfxFill)" d={chart.area} />
                      <path fill="none" stroke="url(#pfxStroke)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" d={chart.line} />
                      {chart.dots.map((d, i) => (
                        <circle key={i} cx={d.x} cy={d.y} r="3" fill="#0c1118" stroke={C_ORANGE} strokeWidth="1.6" />
                      ))}
                      <circle cx={chart.lastX} cy={chart.lastY} r="9" fill={C_ORANGE} opacity="0.18" />
                      <circle cx={chart.lastX} cy={chart.lastY} r="4.5" fill={C_ORANGE} />
                    </svg>
                    <div className="pfx-xaxis">
                      <span>{nwSeries.length - 1}d ago</span>
                      <span>today</span>
                    </div>
                  </>
                ) : (
                  <div className="pfx-chart-empty">Not enough history yet — daily snapshots build the curve.</div>
                )}
              </div>
            </div>

            {/* KPI TILES */}
            <div className="pfx-panel">
              <div className="pfx-phead"><h3><span className="tk" />Key Metrics</h3></div>
              <div className="pfx-kpis">
                <div className="pfx-kpi">
                  <div className="k-top"><span className="k-lab">14d Change</span>
                    <span className={`pfx-trend ${kChange >= 0 ? 'up' : 'dn'}`}>{kChange >= 0 ? '▲' : '▼'} {Math.abs(kChangePct).toFixed(1)}%</span></div>
                  <div className="k-val num" style={{ color: kChange >= 0 ? C_GREEN : C_GRAY }}>{kChange >= 0 ? '+' : ''}{fmtUSD(kChange)}</div>
                </div>
                <div className="pfx-kpi">
                  <div className="k-top"><span className="k-lab">14d High</span><span className="pfx-trend flat">peak</span></div>
                  <div className="k-val num">{fmtUSD(kHi)}</div>
                </div>
                <div className="pfx-kpi">
                  <div className="k-top"><span className="k-lab">14d Low</span><span className="pfx-trend dn">trough</span></div>
                  <div className="k-val num">{fmtUSD(kLo)}</div>
                </div>
                <div className="pfx-kpi">
                  <div className="k-top"><span className="k-lab">Volatility</span><span className="pfx-trend flat">σ</span></div>
                  <div className="k-val num">{kVol.toFixed(1)}%</div>
                </div>
                <div className="pfx-kpi">
                  <div className="k-top"><span className="k-lab">Top Asset</span><span className="pfx-trend up">{topPct.toFixed(1)}%</span></div>
                  <div className="k-val" style={{ color: C_ORANGE, fontSize: 16, fontFamily: 'Orbitron,monospace', display: 'flex', alignItems: 'center', gap: 7 }}>
                    {topAsset
                      ? <>{topAsset.category === 'nft'
                            ? <div style={{ width: 20, height: 20, borderRadius: 5, overflow: 'hidden', flexShrink: 0, background: '#06090d', border: `1px solid ${topAsset.color}55` }}><V2NFTImage src={topAsset.logo || topAsset.metaUri} name={topAsset.symbol} width={40} /></div>
                            : <TokenIcon h={topAsset} size={20} />}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{topAsset.symbol}</span></>
                      : '—'}
                  </div>
                </div>
                <div className="pfx-kpi">
                  <div className="k-top"><span className="k-lab">Best 24h</span><span className="pfx-trend up">▲</span></div>
                  <div className="k-val num" style={{ color: C_GREEN, fontSize: 18 }}>
                    {snapshotDelta ? `${snapshotDelta.pct >= 0 ? '+' : ''}${snapshotDelta.pct.toFixed(2)}%` : '—'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── STAT STRIP ── */}
          <div className="pfx-panel" style={{ marginBottom: 16 }}>
            <div className="pfx-strip">
              <div className="pfx-stat"><div className="s-val num">{allRows.length}</div><div className="s-lab">Positions</div></div>
              <div className="pfx-stat"><div className="s-val num o">{splCount}</div><div className="s-lab">SPL</div></div>
              <div className="pfx-stat"><div className="s-val num o">{t22Count}</div><div className="s-lab">Token-2022</div></div>
              <div className="pfx-stat"><div className="s-val num g">{lpCount}</div><div className="s-lab">LP Pairs</div></div>
              <div className="pfx-stat"><div className="s-val num p">{nftCount}</div><div className="s-lab">NFTs</div></div>
            </div>
          </div>

          {/* ── ROW 2: allocation donut | ranking ── */}
          <div className="pfx-grid2">
            <div className="pfx-panel">
              <div className="pfx-phead"><h3><span className="tk" />Allocation Breakdown</h3><span className="pfx-sub num">{fmtUSD(netWorth)} total</span></div>
              <div className="pfx-donut-wrap">
                <div className="pfx-donut-box">
                  <svg width="148" height="148" viewBox="0 0 220 220">
                    <circle cx="110" cy="110" r="88" fill="none" stroke="#0a0f16" strokeWidth="26" />
                    <g transform="rotate(-90 110 110)" fill="none" strokeWidth="26">
                      {donutArcs.map((a, i) => a.dash > 0.3 && (
                        <circle key={i} cx="110" cy="110" r="88" stroke={a.color}
                          strokeDasharray={`${a.dash.toFixed(2)} ${(DONUT_C - a.dash).toFixed(2)}`}
                          strokeDashoffset={a.offset.toFixed(2)} />
                      ))}
                    </g>
                  </svg>
                  <div className="pfx-donut-center">
                    <div className="dc-lab">Core</div>
                    <div className="dc-val num" style={{ color: C_ORANGE }}>{donutArcs[0].pct.toFixed(1)}%</div>
                    <div className="dc-sub">{fmtUSD(coreUsd)}</div>
                  </div>
                </div>
                <div className="pfx-legend">
                  {donutArcs.map((a, i) => (
                    <div className="leg-row" key={i}>
                      <span className="leg-dot" style={{ background: a.color }} />
                      <span className="leg-name">{a.label}</span>
                      <span className="leg-usd num">{fmtUSD(a.usd)}</span>
                      <span className="leg-pct num">{a.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="pfx-panel">
              <div className="pfx-phead"><h3><span className="tk" />Holdings by USD</h3><span className="pfx-sub num">ranked</span></div>
              <div className="pfx-rank">
                {rankRows.map((h, i) => {
                  const w = h.usd && h.usd > 0 ? Math.max((h.usd / rankMax) * 100, 0.5) : 0;
                  return (
                    <div className="rk-row" key={h.mint + i}>
                      <span className="rk-name" style={h.usd && h.usd > 0 ? undefined : { color: C_GRAY }}>{h.symbol}</span>
                      <div className="rk-track">{w > 0 && <div className="rk-fill" style={{ width: `${w}%`, background: catColor(h.category) }} />}</div>
                      <span className="rk-usd num" style={h.usd && h.usd > 0 ? undefined : { color: '#566173' }}>{h.usd && h.usd > 0 ? fmtUSD(h.usd) : '—'}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── HOLDINGS TABLE ── */}
          <div className="pfx-panel" style={{ padding: '18px 18px 14px' }}>
            <div className="pfx-phead" style={{ padding: '0 4px 16px' }}>
              <h3><span className="tk" />Holdings · {allRows.length} Positions</h3>
              <span className="pfx-sub num">price · balance · value</span>
            </div>

            {groups.map(g => (
              <div className="pfx-grp" key={g.key}>
                <div className="pfx-grp-head">
                  <span className="gtk" style={{ background: g.accent }} />
                  <h4 style={{ color: g.accent }}>{g.label}</h4>
                  <span className="gcount num">{g.rows.length} · {fmtUSD(g.rows.reduce((s, h) => s + (h.usd ?? 0), 0))}</span>
                </div>

                {g.rows.map(h => {
                  const price = prices[h.mint] || 0;
                  const series = mintSeries.get(h.mint);
                  const spark = sparkPts(series);
                  const sparkUp = series && series.length >= 2 ? series[series.length - 1] >= series[0] : true;
                  const isActive = activeSendMint === h.mint;
                  return (
                    <Fragment key={h.mint}>
                      <div className="pfx-row">
                        {h.category === 'nft' ? (
                          <NftHoverThumb
                            src={h.logo || h.metaUri}
                            name={h.symbol}
                            listed={h.listedPrice != null ? `${fmtNum(h.listedPrice / 1e9, 2)} XNT` : null}
                          />
                        ) : (
                          <TokenIcon h={h} />
                        )}
                        <div className="pfx-cell-sym">
                          <div className="pfx-sym">
                            {h.symbol}
                            {h.lpInfo && <span className="pfx-badge" style={{ background: 'rgba(174,185,199,.13)', color: C_SILVER, border: '1px solid rgba(174,185,199,.32)' }}>LP</span>}
                            {h.category === 'nft' && (
                              h.listedPrice != null
                                ? <span className="pfx-badge b-p">LISTED · {fmtNum(h.listedPrice / 1e9, 2)} XNT</span>
                                : <span className="pfx-badge b-n">UNLISTED</span>
                            )}
                            {h.kind === 'ecosystem' && <span className="pfx-badge b-o">ECOSYSTEM</span>}
                            {h.kind === 'x1native' && <span className="pfx-badge b-o">X1 NATIVE</span>}
                          </div>
                          <div className="pfx-meta">
                            <span className="prog">{h.program === 't22' ? 'TOKEN-2022' : 'SPL'}</span>·
                            <span className="mint">{shortAddr(h.mint, 4, 4)}</span>
                          </div>
                        </div>
                        <div className="pfx-cell-spark">
                          {spark
                            ? <svg width="72" height="22" viewBox="0 0 72 22"><polyline fill="none" stroke={sparkUp ? C_GREEN : C_GRAY} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" points={spark} /></svg>
                            : <span className="pfx-dash">—</span>}
                        </div>
                        <div className="pfx-cell-price">
                          <div className="c-lab">Price</div>
                          <div className="num pfx-price">{price > 0 ? `$${price < 0.01 ? price.toFixed(6) : price.toFixed(4)}` : '—'}</div>
                        </div>
                        <div className="pfx-cell-bal">
                          <div className="c-lab">Balance</div>
                          <div className="num pfx-bal">{fmtNum(h.balance, h.balance < 1 ? 4 : 2)}</div>
                        </div>
                        <div className="pfx-cell-val">
                          <div className="c-lab">Value</div>
                          <div className={`num pfx-usd ${h.usd && h.usd > 0 ? '' : 'zero'}`}>{h.usd && h.usd > 0 ? fmtUSD(h.usd) : '—'}</div>
                        </div>
                        {wallet && h.balance > 0
                          ? <button type="button" className="pfx-send" onClick={() => setActiveSendMint(m => m === h.mint ? null : h.mint)}>{isActive ? '✕ CLOSE' : 'SEND'}</button>
                          : <span />}
                      </div>
                      {isActive && wallet && (
                        <div style={{ marginBottom: 8 }}>
                          <SendPanel
                            token={{
                              mint: h.mint, name: h.symbol, symbol: h.symbol,
                              balance: h.balance, decimals: h.decimals,
                              logoUri: h.logo, isToken2022: h.program === 't22',
                            }}
                            wallet={wallet}
                            connection={connection}
                            isMobile={isMobile}
                            savedAddresses={savedAddresses}
                            onSaveAddress={handleSaveAddress}
                            onDeleteAddress={handleDeleteAddress}
                            onSendComplete={handleSendComplete}
                            onClose={() => setActiveSendMint(null)}
                          />
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
