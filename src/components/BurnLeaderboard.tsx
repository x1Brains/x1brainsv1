// src/components/BurnLeaderboard.tsx
// ─────────────────────────────────────────────────────────────────────────────
// BURN LEADERBOARD — Incinerator Protocol · Xyon aesthetic
// Drop-in: <BurnLeaderboard connection={...} walletAddress={...} />
// ─────────────────────────────────────────────────────────────────────────────

import React, { FC, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Connection, PublicKey } from '@solana/web3.js';
import { BRAINS_MINT, BRAINS_LOGO } from '../constants';
import { usePrice as _usePrice } from '../components/TokenComponents';
import { getCachedLabWorkMap, setSupabaseLabWorkMap, getSupabaseLabWorkMap } from '../lib/supabase';
import { useIncTheme, ThemeToggle, injectThemeOverrides, type IncTheme, type ThemeName } from '../components/incineratorThemes';

// Fire theme context — shares theme state with sub-components defined outside main component
const FireCtx = React.createContext<{ isF: boolean }>({ isF: false });
const useFireCtx = () => React.useContext(FireCtx);

// ─── PODIUM PROFILE IMAGES ──────────────────────────────────────────────────
import podium1st from '../assets/images1st.jpg';
import podium2nd from '../assets/images2nd.jpg';
import podium3rd from '../assets/images3rd.png';

const PODIUM_IMAGES: Record<number, { src: string; scale: number }> = {
  1: { src: podium1st, scale: 1.35 },
  2: { src: podium2nd, scale: 1.3 },
  3: { src: podium3rd, scale: 1.0 },
};

// Preload podium images immediately on module load
[podium1st, podium2nd, podium3rd].forEach(src => {
  const img = new Image();
  img.src = src;
});

// ─── BRAINS PRICE & MARKET DATA FETCHER ────────────────────────────────────
interface MarketData {
  price: number | null;
  marketCap: number | null;
  liquidity: number | null;
  change5m: number | null;
  change1h: number | null;
  change24h: number | null;
  volume24h: number | null;
  fdv: number | null;
}
let _marketDataCache: MarketData | null = null;
let _marketDataTs = 0;
const MARKET_TTL = 30_000;

// XNT wrapped native token address on X1
const XNT_WRAPPED = 'So11111111111111111111111111111111111111112';

async function fetchMarketData(): Promise<MarketData | null> {
  // Return cached if fresh
  if (_marketDataCache && (Date.now() - _marketDataTs) < MARKET_TTL) return _marketDataCache;

  const md: MarketData = { price:null,marketCap:null,liquidity:null,change5m:null,change1h:null,change24h:null,volume24h:null,fdv:null };
  const H = { Accept:'application/json' };
  const T = AbortSignal.timeout(12000);

  // ── 1. Get price from token-price endpoint ──
  try {
    const r = await fetch(`/api/xdex-price/api/token-price/price?network=mainnet&address=${BRAINS_MINT}`, { headers:H, signal:T });
    if (r.ok) {
      const d = await r.json();
      const p = d?.price ?? d?.data?.price ?? (typeof d === 'number' ? d : null);
      if (p != null && Number(p) > 0) md.price = Number(p);
    }
  } catch {}

  // Fallback price
  if (!md.price) {
    try {
      const r = await fetch(`/api/xdex-price/api/token-price/prices?network=X1%20Mainnet&token_addresses=${BRAINS_MINT}`, { headers:H, signal:T });
      if (r.ok) {
        const data = await r.json();
        if (data?.success && Array.isArray(data?.data)) {
          const item = data.data.find((i: any) => i?.token_address === BRAINS_MINT);
          if (item?.price != null && Number(item.price) > 0) md.price = Number(item.price);
        }
      }
    } catch {}
  }

  // ── 2. Get pool data (liquidity, volume, reserves) ──
  try {
    const r = await fetch(`/api/xdex-price/api/xendex/pool/list?network=mainnet`, { headers:H, signal:T });
    if (r.ok) {
      const d = await r.json();
      const pools = Array.isArray(d) ? d : (d?.data ?? d?.pools ?? []);
      const brainsPool = pools.find((p: any) => {
        const t0 = p.token_0_address ?? p.token0 ?? p.tokenA ?? '';
        const t1 = p.token_1_address ?? p.token1 ?? p.tokenB ?? '';
        return t0 === BRAINS_MINT || t1 === BRAINS_MINT;
      });
      if (brainsPool) {
        const liq = brainsPool.liquidity ?? brainsPool.total_liquidity ?? brainsPool.tvl ?? brainsPool.liquidity_usd;
        if (liq != null) md.liquidity = Number(liq);
        const vol = brainsPool.volume_24h ?? brainsPool.volume24h ?? brainsPool.volume ?? brainsPool.daily_volume;
        if (vol != null) md.volume24h = Number(vol);
        const c5 = brainsPool.price_change_5m ?? brainsPool.priceChange5m;
        const c1h = brainsPool.price_change_1h ?? brainsPool.priceChange1h ?? brainsPool.price_change_1hr;
        const c24 = brainsPool.price_change_24h ?? brainsPool.priceChange24h;
        if (c5 != null) md.change5m = Number(c5);
        if (c1h != null) md.change1h = Number(c1h);
        if (c24 != null) md.change24h = Number(c24);

        const poolAddr = brainsPool.address ?? brainsPool.pool_address ?? brainsPool.id;
        if (poolAddr && (!md.liquidity || !md.volume24h)) {
          try {
            const pr = await fetch(`/api/xdex-price/api/xendex/pool/${poolAddr}?network=mainnet`, { headers:H, signal:T });
            if (pr.ok) {
              const pd = await pr.json();
              const pdd = pd?.data ?? pd;
              if (!md.liquidity) { const l2 = pdd?.liquidity ?? pdd?.tvl ?? pdd?.total_liquidity; if (l2) md.liquidity = Number(l2); }
              if (!md.volume24h) { const v2 = pdd?.volume_24h ?? pdd?.volume24h ?? pdd?.daily_volume; if (v2) md.volume24h = Number(v2); }
              if (!md.change5m) { const x = pdd?.price_change_5m ?? pdd?.priceChange5m; if (x != null) md.change5m = Number(x); }
              if (!md.change1h) { const x = pdd?.price_change_1h ?? pdd?.priceChange1h; if (x != null) md.change1h = Number(x); }
              if (!md.change24h) { const x = pdd?.price_change_24h ?? pdd?.priceChange24h; if (x != null) md.change24h = Number(x); }
            }
          } catch {}
        }
      }
    }
  } catch {}

  // ── 3. Get pool status for additional volume/stats ──
  if (!md.volume24h || !md.liquidity) {
    try {
      const r = await fetch(`/api/xdex-price/api/xendex/pool/status?network=mainnet`, { headers:H, signal:T });
      if (r.ok) {
        const d = await r.json();
        const pools = Array.isArray(d) ? d : (d?.data ?? d?.pools ?? []);
        const bp = pools.find((p: any) => {
          const t0 = p.token_0_address ?? p.token0 ?? '';
          const t1 = p.token_1_address ?? p.token1 ?? '';
          return t0 === BRAINS_MINT || t1 === BRAINS_MINT;
        });
        if (bp) {
          if (!md.liquidity) { const l = bp.liquidity ?? bp.tvl; if (l) md.liquidity = Number(l); }
          if (!md.volume24h) { const v = bp.volume_24h ?? bp.volume24h; if (v) md.volume24h = Number(v); }
          if (!md.change24h) { const c = bp.price_change_24h ?? bp.priceChange24h; if (c != null) md.change24h = Number(c); }
        }
      }
    } catch {}
  }

  // ── 4. Try chart/price endpoint for price change data ──
  if (md.change5m == null || md.change1h == null || md.change24h == null) {
    try {
      const r = await fetch(`/api/xdex-price/api/xendex/chart/price?network=mainnet&address=${BRAINS_MINT}`, { headers:H, signal:T });
      if (r.ok) {
        const d = await r.json();
        const points = Array.isArray(d) ? d : (d?.data ?? d?.prices ?? d?.chart ?? []);
        if (points.length > 1) {
          const now = Date.now() / 1000;
          const latest = points[points.length - 1];
          const latestPrice = Number(latest?.price ?? latest?.close ?? latest?.p ?? latest?.[1] ?? 0);
          if (latestPrice > 0) {
            const findPriceAt = (secsAgo: number) => {
              const target = now - secsAgo;
              let closest = points[0];
              let minDiff = Infinity;
              for (const pt of points) {
                const ts = Number(pt?.timestamp ?? pt?.time ?? pt?.t ?? pt?.[0] ?? 0);
                const diff = Math.abs(ts - target);
                if (diff < minDiff) { minDiff = diff; closest = pt; }
              }
              return Number(closest?.price ?? closest?.close ?? closest?.p ?? closest?.[1] ?? 0);
            };
            if (md.change5m == null) { const p5 = findPriceAt(300); if (p5 > 0) md.change5m = ((latestPrice - p5) / p5) * 100; }
            if (md.change1h == null) { const p1h = findPriceAt(3600); if (p1h > 0) md.change1h = ((latestPrice - p1h) / p1h) * 100; }
            if (md.change24h == null) { const p24 = findPriceAt(86400); if (p24 > 0) md.change24h = ((latestPrice - p24) / p24) * 100; }
            if (!md.price) md.price = latestPrice;
          }
        }
      }
    } catch {}
  }

  // ── 5. Compute derived values ──
  if (md.price && !md.marketCap) md.marketCap = md.price * 8_880_000;
  if (md.price && !md.fdv) md.fdv = md.price * 8_880_000;

  _marketDataCache = md;
  _marketDataTs = Date.now();
  return md;
}

function useBrainsPrice(): number | null {
  // Use centralized live price from TokenComponents
  const p = _usePrice(BRAINS_MINT);
  return p ?? null;
}

function useMarketData(): MarketData | null {
  const [md, setMd] = useState<MarketData | null>(_marketDataCache);
  useEffect(() => {
    // Initial fetch
    fetchMarketData().then(d => { if (d) setMd(d); });
    // Refresh every 30s
    const id = setInterval(() => {
      fetchMarketData().then(d => { if (d) setMd(d); });
    }, MARKET_TTL);
    return () => clearInterval(id);
  }, []);
  return md;
}

// ─── BRAINS LOGO INLINE ─────────────────────────────────────────────────────
const BrainsLogo: FC<{ size?: number }> = ({ size = 14 }) => (
  <img src={BRAINS_LOGO} alt="BRAINS" style={{
    width: size, height: size, borderRadius: '50%', objectFit: 'cover',
    border: '1px solid rgba(255,140,0,.35)', background: '#111820', flexShrink: 0,
  }} />
);

// ─── STYLE INJECTION ─────────────────────────────────────────────────────────
export function injectLeaderboardStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('lb-styles')) return;
  // Load Exo 2 + Rajdhani fonts
  if (!document.getElementById('lb-fonts')) {
    const link = document.createElement('link');
    link.id = 'lb-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700;800&family=Sora:wght@400;600;700&display=swap';
    document.head.appendChild(link);
  }
  const el = document.createElement('style');
  el.id = 'lb-styles';
  el.textContent = `
    @keyframes lb-spin        { to { transform: rotate(360deg); } }
    @keyframes lb-fade-up     { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    @keyframes lb-row-in      { from { opacity:0; transform:translateX(-10px); } to { opacity:1; transform:translateX(0); } }
    @keyframes lb-pulse       { 0%,100%{opacity:.45} 50%{opacity:.7} }
    @keyframes lb-shimmer     { 0%{transform:translateX(-120%)} 100%{transform:translateX(500%)} }
    @keyframes lb-bar-fill    { from { width: 0%; } }
    @keyframes lb-number-pop  { 0%{transform:scale(.7);opacity:0} 60%{transform:scale(1.1)} 100%{transform:scale(1);opacity:1} }
    @keyframes lb-tier-float  { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-2px)} }
    @keyframes lb-orb-drift   { 0%{transform:translate(0,0) scale(1)} 33%{transform:translate(10px,-8px) scale(1.02)} 66%{transform:translate(-8px,5px) scale(.98)} 100%{transform:translate(0,0) scale(1)} }
    @keyframes lb-heat-wave   { 0%,100%{background-position:0% 50%} 50%{background-position:100% 50%} }
    @keyframes lb-scan-sweep  { 0%{left:-38%} 100%{left:120%} }
    @keyframes lb-green-pulse { 0%,100%{opacity:.35;box-shadow:0 0 3px rgba(57,255,136,.2)} 50%{opacity:.6;box-shadow:0 0 6px rgba(57,255,136,.3)} }
    @keyframes lb-purple-glow { 0%,100%{box-shadow:0 0 4px rgba(140,60,255,.15)} 50%{box-shadow:0 0 8px rgba(140,60,255,.25)} }
    @keyframes lb-gold-glow   { 0%,100%{box-shadow:0 0 4px rgba(255,215,0,.2)} 50%{box-shadow:0 0 8px rgba(255,215,0,.3)} }
    @keyframes lb-ember       { 0%{transform:translateY(0);opacity:.4} 100%{transform:translateY(-60px) scale(.3);opacity:0} }
    @keyframes lb-cta-pulse   { 0%,100%{box-shadow:0 0 8px rgba(140,60,255,.15)} 50%{box-shadow:0 0 14px rgba(140,60,255,.25)} }
    @keyframes lb-bar-shimmer { 0%{left:-60%} 100%{left:160%} }
    @keyframes lb-podium-in   { 0%{opacity:0;transform:translateY(30px) scale(.92)} 60%{transform:translateY(-4px) scale(1.02)} 100%{opacity:1;transform:translateY(0) scale(1)} }
    @keyframes lb-skel-shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
    @keyframes lb-metalShimmer { 0%{background-position:250% center} 50%{background-position:-50% center} 100%{background-position:250% center} }
    @keyframes lb-badge-sway { 0%,100%{transform:translateX(0)} 25%{transform:translateX(1px)} 75%{transform:translateX(-1px)} }
    @keyframes lb-skel-ring   { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
    @keyframes lb-skel-pulse  { 0%,100%{opacity:.3;transform:scale(.95)} 50%{opacity:.5;transform:scale(1.03)} }
    @keyframes lb-scanline    { 0%{top:-6%} 100%{top:106%} }
    @keyframes lb-hex-pulse   { 0%,100%{opacity:.02} 50%{opacity:.04} }
    @keyframes lb-data-rain   { 0%{transform:translateY(-100%);opacity:0} 10%{opacity:.3} 90%{opacity:.3} 100%{transform:translateY(100vh);opacity:0} }
    @keyframes lb-glitch      { 0%,100%{transform:translate(0)} }
    @keyframes lb-border-flow { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
    @keyframes lb-digit-tick  { 0%{opacity:1} 50%{opacity:.6} 100%{opacity:1} }
    @keyframes lb-radar-sweep { 0%{transform:rotate(0deg)} 100%{transform:rotate(360deg)} }
    @keyframes lb-circuit-flow { 0%{stroke-dashoffset:100} 100%{stroke-dashoffset:0} }
    @keyframes lb-stat-flash  { 0%,100%{border-color:rgba(57,255,136,.08)} }
    @keyframes lb-fire-border   { 0%{background-position:0% center;opacity:.4} 50%{background-position:100% center;opacity:.5} 100%{background-position:200% center;opacity:.4} }
    @keyframes lb-fire-flicker  { 0%,100%{box-shadow:0 4px 40px rgba(0,0,0,.55);border-color:rgba(255,34,34,.04)} }
    @keyframes lb-ember-float   { 0%{transform:translateY(0) scale(1);opacity:0} 8%{opacity:.3} 40%{transform:translateY(-100px) translateX(10px) scale(1.1);opacity:.4} 70%{opacity:.2} 100%{transform:translateY(-250px) translateX(-5px) scale(.2);opacity:0} }
    @keyframes lb-heat-shimmer  { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
    @keyframes lb-fire-node     { 0%,100%{opacity:.3;transform:scale(1)} 50%{opacity:.5;transform:scale(1.15)} }
    @keyframes lb-fire-live     { 0%,100%{opacity:.4;box-shadow:0 0 4px rgba(255,187,51,.2)} 50%{opacity:.7;box-shadow:0 0 8px rgba(255,187,51,.35)} }
    @keyframes lb-fire-scan     { 0%{left:-38%} 100%{left:120%} }
    @keyframes lb-fire-hpulse   { 0%,100%{background-position:center 0%} 50%{background-position:center 100%} }
    @keyframes lb-fire-drift    { 0%,100%{transform:translate(0,0)} 33%{transform:translate(4px,-3px)} 66%{transform:translate(-3px,2px)} }
    @keyframes lb-grad-shift    { 0%{background-position:0% center} 50%{background-position:100% center} 100%{background-position:0% center} }
    @keyframes lb-stat-breathe  { 0%,100%{opacity:.15} 50%{opacity:.35} }
    @keyframes lb-fire-header   { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
    @keyframes lb-flame-text    { 0%,100%{text-shadow:0 0 4px rgba(255,34,34,.2),0 0 8px rgba(255,102,0,.1)} 50%{text-shadow:0 0 6px rgba(255,102,0,.25),0 0 12px rgba(255,34,34,.12)} }
    @keyframes lb-flame-flick   { 0%,100%{opacity:1} }
    @keyframes lb-fire-ring     { 0%,100%{box-shadow:0 0 4px rgba(255,34,34,.2),0 0 8px rgba(255,102,0,.1)} 50%{box-shadow:0 0 6px rgba(255,102,0,.25),0 0 12px rgba(255,34,34,.1)} }
    @keyframes lb-header-ember  { 0%{transform:translateY(0) translateX(0) scale(1);opacity:0} 10%{opacity:.4} 50%{transform:translateY(-20px) translateX(3px) scale(.8);opacity:.25} 100%{transform:translateY(-40px) translateX(-2px) scale(.3);opacity:0} }
    @keyframes lb-flame-wave    { 0%,100%{transform:scaleY(1)} 50%{transform:scaleY(1.1)} }
  `;
  document.head.appendChild(el);
  injectThemeOverrides();
}

// ─── TIERS ───────────────────────────────────────────────────────────────────
const TIERS = [
  { min: 0,         label: 'UNRANKED',     color: '#6a7a8a', neon: '#a0bbcc', icon: '○',  flavor: 'Burn Your Brains Off'               },
  { min: 1,         label: 'SPARK',        color: '#aaccff', neon: '#bbddff', icon: '✦',  flavor: 'First spark extinguished'           },
  { min: 25_000,    label: 'FLAME',        color: '#ffcc55', neon: '#ffdd77', icon: '🕯️', flavor: 'The ember takes hold'               },
  { min: 50_000,    label: 'INFERNO',      color: '#ff9933', neon: '#ffaa44', icon: '🔥', flavor: 'Controlled immolation begins'       },
  { min: 100_000,   label: 'OVERWRITE',    color: '#ff7700', neon: '#ff8811', icon: '⚙️', flavor: 'Ceremonial destruction'             },
  { min: 200_000,   label: 'ANNIHILATE',   color: '#ff5500', neon: '#ff6622', icon: '💥', flavor: 'Industrial-grade incineration'      },
  { min: 350_000,   label: 'TERMINATE',    color: '#ff3300', neon: '#ff4411', icon: '⚡', flavor: 'Reaching critical mass'             },
  { min: 500_000,   label: 'DISINTEGRATE', color: '#ff1166', neon: '#ff2277', icon: '☢️', flavor: 'Stellar annihilation event'         },
  { min: 700_000,   label: 'GODSLAYER',    color: '#cc00ff', neon: '#dd22ff', icon: '⚔️', flavor: 'Event horizon crossed'              },
  { min: 850_000,   label: 'APOCALYPSE',   color: '#ff0044', neon: '#ff1155', icon: '💀', flavor: 'Approaching terminal entropy'       },
  { min: 1_000_000, label: 'INCINERATOR',  color: '#ffffff', neon: '#fffaee', icon: '☠️', flavor: 'Universal collapse — the final burn'},
];

const getTier  = (pts: number) => { for (let i = TIERS.length-1; i>=0; i--) if (pts >= TIERS[i].min) return TIERS[i]; return TIERS[0]; };
const nextTier = (pts: number) => { for (let i=0; i<TIERS.length; i++) if (pts < TIERS[i].min) return TIERS[i]; return null; };

// ─── TYPES ───────────────────────────────────────────────────────────────────
export interface BurnEvent   { amount: number; blockTime: number; sig: string; }
export interface BurnerEntry { address: string; points: number; burned: number; txCount: number; events?: BurnEvent[]; ampPct?: number; ampBonusPts?: number; ampWeekId?: string; labWorkPts?: number; }
interface LbState     { entries: BurnerEntry[]; loading: boolean; progress: string; batches: number; error: string|null; fetchedAt: Date|null; }

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const short  = (a: string) => `${a.slice(0,5)}…${a.slice(-4)}`;
const fmtN   = (n: number, d=2) => n.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtPts = (n: number) => n>=1_000_000?`${(n/1e6).toFixed(2)}M`:n>=1_000?`${(n/1000).toFixed(1)}K`:n.toLocaleString();

// ─── FAST PARALLEL FETCHER ────────────────────────────────────────────────────
// ─── AMP BONUS SYSTEM (v2) ──────────────────────────────────────────────────
// AMPs stack within a week. Bonus applies retroactively to ALL burns in that
// week once a challenge tier is completed. Resets each new week.
//
// Data sources:
//   brains_weekly_config  — current active week (has challenges[], startDate, endDate, status)
//   brains_challenge_log  — array of past completed weeks
//
// For each wallet we compute:
//   1. Find all weeks (current + past) that had challenges
//   2. For each week, sum all challenge tier AMPs → totalAmpPct for that week
//   3. Find the wallet's burns that fall within that week's date range
//   4. Bonus = weekBurns × 1.888 × (totalAmpPct / 100)
//   5. Sum across all weeks → total amp bonus pts
// ─────────────────────────────────────────────────────────────────────────────

const TIER_AMP_RATES = [0, 1.50, 3.50, 5.50, 8.88]; // index = tier

interface WeekAmpWindow {
  weekId: string;
  startTs: number;  // unix seconds
  endTs: number;    // unix seconds (Infinity if still active)
  totalAmpPct: number; // max possible stacked amp % for this week
  challenges: { tier: number; target: number; ampPct: number }[]; // per-challenge breakdown
}

interface AmpResult {
  totalBonusPts: number;  // sum of bonus pts across all weeks
  currentAmpPct: number;  // active week's EARNED amp % based on burn amount (0 if no active week)
  maxAmpPct: number;      // active week's max possible amp %
  weekBreakdown: { weekId: string; ampPct: number; weekBurned: number; bonusPts: number }[];
}

/** Parse challenge configs/logs into time windows with stacked AMP percentages */
function _parseAmpWindows(logs: any[], cfg: any | null): WeekAmpWindow[] {
  const windows: WeekAmpWindow[] = [];
  // Past completed weeks
  for (const log of logs) {
    if (!log.challenges || !Array.isArray(log.challenges)) continue;
    const chs = log.challenges.map((c: any) => ({ tier: c.tier ?? 0, target: c.target ?? 0, ampPct: TIER_AMP_RATES[c.tier ?? 0] ?? 0 }));
    const totalAmp = Math.round(chs.reduce((s: number, c: any) => s + c.ampPct, 0) * 100) / 100;
    if (totalAmp <= 0) continue;
    const startTs = log.startDate ? Math.floor(new Date(log.startDate).getTime() / 1000) : 0;
    const endTs = log.stoppedAt ? Math.floor(new Date(log.stoppedAt).getTime() / 1000)
                : log.endDate ? Math.floor(new Date(log.endDate).getTime() / 1000) : 0;
    if (startTs > 0 && endTs > 0) windows.push({ weekId: log.weekId || '', startTs, endTs, totalAmpPct: totalAmp, challenges: chs });
  }
  // Current active week
  if (cfg?.status === 'active' && cfg.challenges && Array.isArray(cfg.challenges)) {
    const chs = cfg.challenges.map((c: any) => ({ tier: c.tier ?? 0, target: c.target ?? 0, ampPct: TIER_AMP_RATES[c.tier ?? 0] ?? 0 }));
    const totalAmp = Math.round(chs.reduce((s: number, c: any) => s + c.ampPct, 0) * 100) / 100;
    if (totalAmp > 0) {
      const startTs = cfg.startDate ? Math.floor(new Date(cfg.startDate).getTime() / 1000) : 0;
      const endTs = cfg.endDate ? Math.floor(new Date(cfg.endDate).getTime() / 1000) : Infinity;
      if (startTs > 0) windows.push({ weekId: cfg.weekId || '', startTs, endTs: endTs || Infinity, totalAmpPct: totalAmp, challenges: chs });
    }
  }
  return windows;
}

function getAmpWindowsLocal(): WeekAmpWindow[] {
  try {
    const logRaw = localStorage.getItem('brains_challenge_log');
    const logs = logRaw ? JSON.parse(logRaw) : [];
    const cfgRaw = localStorage.getItem('brains_weekly_config');
    const cfg = cfgRaw ? JSON.parse(cfgRaw) : null;
    return _parseAmpWindows(Array.isArray(logs) ? logs : [], cfg);
  } catch { return []; }
}

// Supabase amp windows cache — set by the component after fetching
let _sbAmpWindows: WeekAmpWindow[] | null = null;
export function setSupabaseAmpWindows(w: WeekAmpWindow[]) { _sbAmpWindows = w; }

function getAmpWindows(): WeekAmpWindow[] {
  return _sbAmpWindows ?? getAmpWindowsLocal();
}

/** Async fetch amp windows from Supabase */
async function fetchAmpWindowsFromSupabase(): Promise<WeekAmpWindow[]> {
  try {
    const { getCachedChallengeLogs, getCachedWeeklyConfig } = await import('../lib/supabase');
    const [logs, cfg] = await Promise.all([getCachedChallengeLogs(), getCachedWeeklyConfig()]);
    const windows = _parseAmpWindows(logs, cfg);
    _sbAmpWindows = windows;
    return windows;
  } catch {
    return getAmpWindowsLocal();
  }
}

/** Calculate AMP bonus for a single wallet's burn events — only for met challenge targets */
function calcAmpBonus(events: BurnEvent[], windows: WeekAmpWindow[]): AmpResult {
  if (windows.length === 0 || events.length === 0) {
    return { totalBonusPts: 0, currentAmpPct: 0, maxAmpPct: 0, weekBreakdown: [] };
  }

  const breakdown: AmpResult['weekBreakdown'] = [];
  let totalBonusPts = 0;

  for (const w of windows) {
    // Sum burns that fall within this week's window
    let weekBurned = 0;
    for (const ev of events) {
      if (ev.blockTime >= w.startTs && ev.blockTime <= w.endTs) {
        weekBurned += ev.amount;
      }
    }
    if (weekBurned <= 0) continue;

    // Only stack AMP for challenges whose target the user has met
    // Sort challenges by target ascending so lower targets are checked first
    const sorted = [...w.challenges].sort((a, b) => a.target - b.target);
    let earnedAmpPct = 0;
    for (const ch of sorted) {
      if (ch.target <= 0 || weekBurned >= ch.target) {
        earnedAmpPct += ch.ampPct;
      }
    }
    earnedAmpPct = Math.round(earnedAmpPct * 100) / 100;
    if (earnedAmpPct <= 0) continue;

    const bonusPts = Math.floor(weekBurned * 1.888 * (earnedAmpPct / 100));
    totalBonusPts += bonusPts;
    breakdown.push({ weekId: w.weekId, ampPct: earnedAmpPct, weekBurned, bonusPts });
  }

  // Current amp % is from the active week (endTs === Infinity or future)
  const now = Math.floor(Date.now() / 1000);
  const activeWindow = windows.find(w => w.endTs >= now);
  let currentAmpPct = 0;
  let maxAmpPct = activeWindow?.totalAmpPct ?? 0;
  if (activeWindow) {
    // Find user's current burn in active window
    let activeBurned = 0;
    for (const ev of events) {
      if (ev.blockTime >= activeWindow.startTs && ev.blockTime <= activeWindow.endTs) {
        activeBurned += ev.amount;
      }
    }
    const sorted = [...activeWindow.challenges].sort((a, b) => a.target - b.target);
    for (const ch of sorted) {
      if (ch.target <= 0 || activeBurned >= ch.target) {
        currentAmpPct += ch.ampPct;
      }
    }
    currentAmpPct = Math.round(currentAmpPct * 100) / 100;
  }

  return { totalBonusPts, currentAmpPct, maxAmpPct, weekBreakdown: breakdown };
}

// ─── LEADERBOARD CACHE ──────────────────────────────────────────────────────
let _lbCache: { entries: BurnerEntry[]; ts: number } | null = null;
const LB_CACHE_TTL = 60_000; // 60 seconds

export function getCachedLeaderboard(): BurnerEntry[] | null {
  if (_lbCache && Date.now() - _lbCache.ts < LB_CACHE_TTL) return _lbCache.entries;
  // Try localStorage fallback
  try {
    const raw = localStorage.getItem('brains_lb_cache');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.ts && Date.now() - parsed.ts < LB_CACHE_TTL && Array.isArray(parsed.entries)) {
        _lbCache = { entries: parsed.entries, ts: parsed.ts };
        return parsed.entries;
      }
    }
  } catch {}
  return null;
}

function setCachedLeaderboard(entries: BurnerEntry[]) {
  const ts = Date.now();
  _lbCache = { entries, ts };
  try {
    // Only cache essential fields to keep localStorage lean
    const slim = entries.map(e => ({ address: e.address, points: e.points, burned: e.burned, txCount: e.txCount, ampPct: e.ampPct, ampBonusPts: e.ampBonusPts, labWorkPts: e.labWorkPts }));
    localStorage.setItem('brains_lb_cache', JSON.stringify({ entries: slim, ts }));
  } catch {}
}

export async function fetchLeaderboard(
  connection: Connection,
  signal: AbortSignal,
  onUpdate: (entries: BurnerEntry[], progress: string, batches: number) => void,
): Promise<BurnerEntry[]> {
  const ampWindows = getAmpWindows();
  const mintPK  = new PublicKey(BRAINS_MINT);
  const mintStr = mintPK.toBase58();
  const totals  = new Map<string, { burned: number; txCount: number; events: BurnEvent[] }>();
  const MAX_BATCHES = 8;

  // ── Pipeline: fetch sigs + parse in parallel ──
  // Instead of fetching ALL sig pages first, then parsing,
  // we start parsing each batch as soon as its sigs arrive.
  let before: string | undefined;
  let batchesDone = 0;
  let totalPages = 0;

  for (let page = 0; page < MAX_BATCHES; page++) {
    if (signal.aborted) break;

    // Fetch signatures for this page
    const sigs = await connection.getSignaturesForAddress(mintPK, {
      limit: 100, ...(before ? { before } : {}),
    }).catch(() => []);
    if (!sigs.length) break;
    totalPages++;
    before = sigs[sigs.length - 1].signature;
    const sigStrs = sigs.map(s => s.signature);

    // Parse this batch immediately — don't wait for more sig pages
    onUpdate(
      batchesDone > 0 ? buildEntries(totals, ampWindows) : [],
      `Scanning batch ${page + 1}… ${totals.size} burners found`,
      batchesDone
    );

    const txBatch = await connection.getParsedTransactions(sigStrs, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    }).catch(() => [] as (Awaited<ReturnType<typeof connection.getParsedTransactions>>[number])[]);

    if (signal.aborted) break;

    for (const tx of txBatch) {
      if (!tx || tx.meta?.err) continue;
      const allIxs: unknown[] = [...(tx.transaction.message.instructions ?? [])];
      for (const inn of tx.meta?.innerInstructions ?? []) allIxs.push(...(inn.instructions ?? []));

      for (const ix of allIxs) {
        const p = ix as Record<string, unknown>;
        if (p.program !== 'spl-token') continue;
        const parsed = p.parsed as Record<string, unknown> | undefined;
        if (!parsed) continue;
        const type = parsed.type as string;
        if (type !== 'burn' && type !== 'burnChecked') continue;
        const info = parsed.info as Record<string, unknown> | undefined;
        if (!info || (info.mint as string) !== mintStr) continue;

        const authority = (info.authority ?? info.multisigAuthority) as string | undefined;
        if (!authority) continue;

        const ta     = info.tokenAmount as Record<string,unknown> | undefined;
        const uiAmt  = ta ? Number((ta as any).uiAmount ?? 0) : 0;
        const rawAmt = ta ? Number((ta as any).amount   ?? 0) : Number(info.amount ?? 0);
        const amount = uiAmt > 0 ? uiAmt : rawAmt / 1_000_000;
        if (amount <= 0) continue;

        const blockTime = tx.blockTime ?? 0;
        const ex = totals.get(authority) ?? { burned: 0, txCount: 0, events: [] };
        ex.burned  += amount;
        ex.txCount += 1;
        ex.events.push({ amount, blockTime, sig: tx.transaction.signatures?.[0] ?? '' });
        totals.set(authority, ex);
      }
    }

    batchesDone++;
    const partialEntries = buildEntries(totals, ampWindows);
    onUpdate(partialEntries, `Parsed ${batchesDone}/${totalPages} batches · ${totals.size} burners`, batchesDone);

    if (sigs.length < 100) break;
  }

  const final = buildEntries(totals, ampWindows);
  setCachedLeaderboard(final);
  return final;
}

// ─── LAB WORK REWARDS — from Supabase (or localStorage fallback) ──
function getLabWorkMapLocal(): Map<string, number> {
  // Fallback: read from localStorage if Supabase hasn't loaded yet
  const map = new Map<string, number>();
  try {
    const raw = localStorage.getItem('brains_labwork_rewards');
    if (raw) {
      const rewards = JSON.parse(raw);
      if (Array.isArray(rewards)) {
        for (const r of rewards) {
          if (!r.address || !r.lbPoints) continue;
          map.set(r.address, (map.get(r.address) || 0) + r.lbPoints);
        }
      }
    }
  } catch {}
  return map;
}

// ─── LAB WORK POINTS (LB PTS) = (burned × 1.888) + AMP bonus + manual Lab Work rewards ──
export function buildEntries(
  totals: Map<string, { burned: number; txCount: number; events: BurnEvent[] }>,
  ampWindows?: WeekAmpWindow[],
  externalLabWorkMap?: Map<string, number>,
): BurnerEntry[] {
  const wins = ampWindows ?? [];
  const labWorkMap = externalLabWorkMap ?? getSupabaseLabWorkMap() ?? getLabWorkMapLocal();

  // Start with burn-based entries
  const entryMap = new Map<string, BurnerEntry>();
  for (const [address, { burned, txCount, events }] of totals.entries()) {
    const basePoints = Math.floor(burned * 1.888);
    const amp = calcAmpBonus(events, wins);
    const lwPts = labWorkMap.get(address) || 0;
    entryMap.set(address, {
      address, burned, txCount, events,
      points: basePoints + amp.totalBonusPts + lwPts,
      ampPct: amp.currentAmpPct,
      ampBonusPts: amp.totalBonusPts,
      ampWeekId: amp.weekBreakdown.length > 0 ? amp.weekBreakdown[amp.weekBreakdown.length - 1].weekId : '',
      labWorkPts: lwPts > 0 ? lwPts : undefined,
    });
  }

  // Add wallets that have lab work points but no burns
  for (const [address, lwPts] of labWorkMap.entries()) {
    if (!entryMap.has(address) && lwPts > 0) {
      entryMap.set(address, {
        address, burned: 0, txCount: 0, events: [],
        points: lwPts,
        ampPct: 0, ampBonusPts: 0, ampWeekId: '',
        labWorkPts: lwPts,
      });
    }
  }

  return Array.from(entryMap.values())
    .filter(e => e.points > 0)
    .sort((a, b) => b.points - a.points);
}

// ─── ANIMATED COUNT-UP ───────────────────────────────────────────────────────
const CountUp: FC<{ value: number; duration?: number }> = ({ value, duration = 1000 }) => {
  const [disp, setDisp] = useState(0);
  const raf = useRef<number>(0);
  useEffect(() => {
    let start: number | null = null;
    cancelAnimationFrame(raf.current);
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      setDisp(Math.floor(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);
  return <>{disp.toLocaleString()}</>;
};

// ─── TIER GAMING BADGES ──────────────────────────────────────────────────────
const TIER_BADGES: Record<string, { label: string; bg: string; border: string; color: string }> = {
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
const TierGameBadge: FC<{ label: string }> = ({ label }) => {
  const b = TIER_BADGES[label];
  if (!b) return null;
  return (
    <span style={{
      fontFamily:'Orbitron, monospace', fontSize:7, letterSpacing:1,
      padding:'2px 7px', whiteSpace:'nowrap',
      background:b.bg, border:`1px solid ${b.border}`,
      borderRadius:3, color:b.color,
      position:'relative', zIndex:1,
    }}>{b.label}</span>
  );
};

// ─── TIER BADGE ──────────────────────────────────────────────────────────────
const TIER_SIZES = {
  sm: { p: '3px 8px 3px 6px',    f: 8,  iconF: 11, gap: 4, br: 4 },
  md: { p: '5px 12px 5px 10px',  f: 11, iconF: 14, gap: 6, br: 5 },
  lg: { p: '8px 16px 8px 13px',  f: 14, iconF: 19, gap: 7, br: 6 },
};
const TierBadge: FC<{ points: number; size?: 'sm'|'md'|'lg' }> = ({ points, size = 'md' }) => {
  const t = getTier(points);
  const c = TIER_SIZES[size];
  const isTop = t.min >= 1_000_000;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: c.gap, padding: c.p,
      background: `linear-gradient(160deg,#0a0e14 0%,#111820 30%,${t.neon}0c 60%,#0d1218 100%)`,
      border: `1px solid ${t.neon}55`, borderTop: `1px solid ${t.neon}88`, borderBottom: `1px solid ${t.neon}22`,
      borderLeft: `2px solid ${t.neon}`,
      borderRadius: c.br,
      fontFamily: 'Orbitron, monospace', fontSize: c.f, fontWeight: 800,
      color: t.neon, letterSpacing: 2,
      whiteSpace: 'nowrap', position: 'relative', overflow: 'hidden',
      boxShadow: `0 2px 12px ${t.neon}15, inset 0 1px 0 ${t.neon}18, inset 0 -1px 0 rgba(0,0,0,.4)`,
      animation: undefined,
    }}>
      {/* Metallic shimmer sweep — white highlight visible on all tier colors */}
      <span style={{ position:'absolute', inset:0, background:`linear-gradient(105deg,transparent 15%,rgba(255,255,255,.03) 30%,rgba(255,255,255,.08) 48%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.08) 52%,rgba(255,255,255,.03) 70%,transparent 85%)`, backgroundSize:'250% 100%', pointerEvents:'none' }} />
      {/* Top highlight edge */}
      <span style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1, background:`linear-gradient(90deg,transparent,${t.neon}55,transparent)`, pointerEvents:'none' }} />
      {/* Corner accents */}
      <span style={{ position:'absolute', top:0, right:0, width:6, height:6, borderTop:`1px solid ${t.neon}99`, borderRight:`1px solid ${t.neon}99`, pointerEvents:'none' }} />
      <span style={{ position:'absolute', bottom:0, left:0, width:6, height:6, borderBottom:`1px solid ${t.neon}44`, borderLeft:`1px solid ${t.neon}44`, pointerEvents:'none' }} />
      <span style={{ fontSize: c.iconF, lineHeight:1, flexShrink:0, position:'relative', zIndex:1, filter:`drop-shadow(0 0 6px ${t.neon}66)` }}>{t.icon}</span>
      <span style={{ position:'relative', zIndex:1, textShadow:`0 1px 2px ${t.neon}33, 0 0 8px ${t.neon}22` }}>{t.label}</span>
      <TierGameBadge label={t.label} />
    </span>
  );
};

// ─── COPY BUTTON ─────────────────────────────────────────────────────────────
const CopyBtn: FC<{ text: string }> = ({ text }) => {
  const { isF } = useFireCtx();
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(()=>setCopied(false),1800); }).catch(()=>{}); }} style={{
      background: copied ? (isF?'rgba(255,187,51,.1)':'rgba(57,255,136,.1)') : (isF?'rgba(255,102,0,.08)':'rgba(100,60,255,.08)'),
      border: `1px solid ${copied ? (isF?'rgba(255,187,51,.4)':'rgba(57,255,136,.4)') : (isF?'rgba(255,102,0,.25)':'rgba(140,60,255,.25)')}`,
      color: copied ? (isF?'#ffbb33':'#39ff88') : (isF?'#ff6600':'#aa77ff'),
      fontFamily: 'Orbitron, monospace', fontSize: 7, letterSpacing: 1,
      padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
      transition: 'all 0.2s', whiteSpace: 'nowrap',
    }}>
      {copied ? '✓ COPIED' : '⎘ COPY'}
    </button>
  );
};



// ─── PODIUM IMAGE PRELOAD HOOK ───────────────────────────────────────────────
function usePodiumImagesReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const srcs = [podium1st, podium2nd, podium3rd];
    Promise.all(srcs.map(src => new Promise<void>(resolve => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve(); // don't block on error
      img.src = src;
    }))).then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  return ready;
}

// ─── HERO-STYLE BACKGROUND LAYERS (reusable) ────────────────────────────────
// Renders the same hex grid, fine grid, corner brackets, edge nodes, rainbow
// top border, and ambient orbs that the main dashboard hero uses — but at a
// reduced opacity for secondary panels.
const HeroBg: FC<{ accent?: string; intensity?: number }> = ({ accent, intensity = 0.6 }) => {
  const { isF } = useFireCtx();
  const a = intensity;
  return (<>
    {/* Hex grid */}
    <div style={{ position:'absolute', inset:0, backgroundImage:`
      linear-gradient(30deg, rgba(${isF?'255,34,34':'140,60,255'},${.014*a}) 12%, transparent 12.5%, transparent 87%, rgba(${isF?'255,34,34':'140,60,255'},${.014*a}) 87.5%),
      linear-gradient(150deg, rgba(${isF?'255,34,34':'140,60,255'},${.014*a}) 12%, transparent 12.5%, transparent 87%, rgba(${isF?'255,34,34':'140,60,255'},${.014*a}) 87.5%),
      linear-gradient(30deg, rgba(${isF?'255,34,34':'140,60,255'},${.014*a}) 12%, transparent 12.5%, transparent 87%, rgba(${isF?'255,34,34':'140,60,255'},${.014*a}) 87.5%),
      linear-gradient(150deg, rgba(${isF?'255,34,34':'140,60,255'},${.014*a}) 12%, transparent 12.5%, transparent 87%, rgba(${isF?'255,34,34':'140,60,255'},${.014*a}) 87.5%),
      linear-gradient(60deg, rgba(${isF?'255,102,0':'255,140,0'},${.01*a}) 25%, transparent 25.5%, transparent 75%, rgba(${isF?'255,102,0':'255,140,0'},${.01*a}) 75%),
      linear-gradient(60deg, rgba(${isF?'255,102,0':'255,140,0'},${.01*a}) 25%, transparent 25.5%, transparent 75%, rgba(${isF?'255,102,0':'255,140,0'},${.01*a}) 75%)
    `, backgroundSize:'80px 140px', backgroundPosition:'0 0, 0 0, 40px 70px, 40px 70px, 0 0, 40px 70px', pointerEvents:'none' }} />
    {/* Fine grid */}
    <div style={{ position:'absolute', inset:0, backgroundImage:`linear-gradient(rgba(${isF?'255,34,34':'140,60,255'},${.02*a}) 1px,transparent 1px),linear-gradient(90deg,rgba(${isF?'255,34,34':'140,60,255'},${.02*a}) 1px,transparent 1px)`, backgroundSize:'24px 24px', pointerEvents:'none' }} />
    {/* Corner brackets */}
    {(isF?[[8,null,8,null,'#ff2222'],[8,8,null,null,'#ff6600'],[null,null,8,8,'#ffbb33'],[null,8,null,8,'#ffdd44']]:[[8,null,8,null,'#00ccff'],[8,8,null,null,'#ff9933'],[null,null,8,8,'#ee55ff'],[null,8,null,8,'#39ff88']]).map(([t,r,b,l,c],i)=>(
      <div key={i} style={{ position:'absolute', top:t!=null?t:undefined, right:r!=null?r:undefined, bottom:b!=null?b:undefined, left:l!=null?l:undefined, width:16, height:16, borderTop:t!=null?`1px solid ${c}${Math.round(0x33*a).toString(16).padStart(2,'0')}`:undefined, borderRight:r!=null&&t!=null?`1px solid ${c}${Math.round(0x33*a).toString(16).padStart(2,'0')}`:undefined, borderBottom:b!=null?`1px solid ${c}${Math.round(0x33*a).toString(16).padStart(2,'0')}`:undefined, borderLeft:l!=null&&b!=null?`1px solid ${c}${Math.round(0x33*a).toString(16).padStart(2,'0')}`:undefined, pointerEvents:'none', zIndex:4 }} />
    ))}
    {/* Top border — static gradient, no animation */}
    <div style={{ position:'absolute', top:0, left:0, right:0, height:1, background:isF?'linear-gradient(90deg,transparent 3%,#cc330088 10%,#ff222288 22%,#ff440088 35%,#ff660088 48%,#ffbb3388 60%,#ffdd4488 72%,#ff660088 82%,#ff222088 90%,transparent 97%)':'linear-gradient(90deg,transparent 5%,#00ccff 15%,#aa44ff 30%,#ee55ff 42%,#ff44cc 52%,#ff9933 65%,#ffd700 80%,transparent 95%)', zIndex:6, opacity:a }} />
    {/* Bottom edge glow */}
    <div style={{ position:'absolute', bottom:0, left:0, right:0, height:1, background:`linear-gradient(90deg,transparent,rgba(${isF?'255,34,34':'140,60,255'},${.1*a}),rgba(${isF?'255,102,0':'238,85,255'},${.07*a}),transparent)`, pointerEvents:'none', zIndex:4 }} />
    {/* Static edge dots */}
    <div style={{ position:'absolute', top:'40%', left:0, width:3, height:3, borderRadius:'50%', background:isF?'#ff2222':(accent||'#00ccff'), boxShadow:`0 0 ${isF?6:4}px ${isF?'#ff2222':(accent||'#00ccff')}`, pointerEvents:'none', zIndex:4, opacity:a }} />
    <div style={{ position:'absolute', top:'60%', right:0, width:3, height:3, borderRadius:'50%', background:isF?'#ff6600':'#ee55ff', boxShadow:isF?'0 0 4px #ff6600':'0 0 4px #ee55ff', pointerEvents:'none', zIndex:4, opacity:a }} />
  </>);
};
// Standard panel wrapper style matching hero aesthetic
const heroPanelStyle = (mb = 20, fire = false): React.CSSProperties => fire ? ({
  position:'relative', overflow:'hidden', marginBottom:mb,
  background:'linear-gradient(135deg,#08080a 0%,#07070a 25%,#08080b 50%,#060609 75%,#08080a 100%)',
  border:'1px solid rgba(255,34,34,.05)', borderRadius:16,
  boxShadow:'0 4px 40px rgba(0,0,0,.55), 0 0 40px rgba(255,34,34,.015)',
}) : ({
  position:'relative', overflow:'hidden', marginBottom:mb,
  background:'linear-gradient(135deg,#020308 0%,#04070f 25%,#060412 50%,#030610 75%,#020409 100%)',
  border:'1px solid rgba(57,255,136,.08)', borderRadius:16,
  boxShadow:'0 4px 40px rgba(0,0,0,.3), 0 0 60px rgba(140,60,255,.02), 0 0 80px rgba(57,255,136,.015)',
});

// ─── PODIUM SKELETON (shown while images load) ──────────────────────────────
const PodiumSkeleton: FC<{ isMobile: boolean }> = ({ isMobile }) => {
  const { isF } = useFireCtx();
  const cards = [
    { rank:'2ND', border:isF?'#ff6600':'#cc88ff', size: isMobile?48:80,  h: isMobile?190:260, icon:'🥈' },
    { rank:'1ST', border:isF?'#ff2222':'#ffd700', size: isMobile?60:100, h: isMobile?220:300, icon:'👑' },
    { rank:'3RD', border:isF?'#ffbb33':'#39ff88', size: isMobile?48:80,  h: isMobile?190:260, icon:'🥉' },
  ];
  return (
    <div style={{ display:'flex', gap:isMobile?6:10, alignItems:'flex-end' }}>
      {cards.map((c, i) => (
        <div key={i} style={{
          flex:1, position:'relative', overflow:'hidden',
          background:'linear-gradient(160deg,#06040e,#08060f)',
          border:`1px solid ${c.border}33`, borderTop:`3px solid ${c.border}55`,
          borderRadius:12, padding:isMobile?'10px 8px 8px':'16px 14px 12px',
          minHeight:c.h, display:'flex', flexDirection:'column', alignItems:'center',
          animation:`lb-fade-up 0.3s ease ${i*0.1}s both`,
        }}>
          <div style={{ position:'absolute', inset:0, backgroundImage:isF?'linear-gradient(rgba(255,34,34,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,34,34,.015) 1px,transparent 1px)':'linear-gradient(rgba(140,60,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(57,255,136,.015) 1px,transparent 1px)', backgroundSize:'24px 24px', pointerEvents:'none' }} />
          {/* Rank label skeleton */}
          <div style={{ textAlign:'center', marginBottom:isMobile?4:8, position:'relative', zIndex:2 }}>
            <div style={{ fontSize:i===1?(isMobile?20:28):(isMobile?16:22), lineHeight:1, opacity:.4, animation:'lb-skel-pulse 2s ease infinite', animationDelay:`${i*0.2}s` }}>{c.icon}</div>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?7:10, fontWeight:700, color:`${c.border}66`, letterSpacing:2, marginTop:3 }}>{c.rank}</div>
          </div>
          {/* Circular skeleton with spinning ring */}
          <div style={{ position:'relative', marginBottom:isMobile?6:10 }}>
            <div style={{
              position:'absolute', inset:-6, borderRadius:'50%',
              border:`2px solid transparent`, borderTopColor:`${c.border}66`, borderRightColor:`${c.border}33`,
              animation:'lb-skel-ring 1.2s linear infinite',
              animationDelay:`${i*0.15}s`,
            }} />
            <div style={{
              width:c.size, height:c.size, borderRadius:'50%',
              border:`3px solid ${c.border}22`,
              background:`radial-gradient(circle, ${c.border}08 0%, ${c.border}03 50%, transparent 70%)`,
              display:'flex', alignItems:'center', justifyContent:'center',
              position:'relative', overflow:'hidden',
            }}>
              <div style={{ position:'absolute', inset:0, background:`linear-gradient(135deg, transparent 30%, ${c.border}10 50%, transparent 70%)`, backgroundSize:'200% 200%', animation:'lb-shimmer 2s ease-in-out infinite' }} />
              <div style={{ fontSize:i===1?(isMobile?18:26):(isMobile?14:22), opacity:.25, animation:'lb-skel-pulse 1.8s ease infinite', animationDelay:`${i*0.3}s` }}>☠️</div>
            </div>
          </div>
          {/* Address skeleton */}
          <div style={{ width:'60%', height:10, borderRadius:4, background:`${c.border}12`, marginBottom:8 }} />
          {/* Stat skeletons */}
          <div style={{ width:'100%', marginTop:'auto', display:'flex', flexDirection:'column', gap:5 }}>
            <div style={{ height:28, borderRadius:6, background:'rgba(255,140,0,.04)', border:'1px solid rgba(255,140,0,.06)' }} />
            <div style={{ height:28, borderRadius:6, background:`${c.border}06`, border:`1px solid ${c.border}08` }} />
            <div style={{ display:'flex', justifyContent:'center', marginTop:3 }}>
              <div style={{ width:80, height:18, borderRadius:4, background:`${c.border}08` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ─── LEADERBOARD ROW SKELETON ─────────────────────────────────────────────────
const SkeletonBar: FC<{ width: string; height?: number; delay?: number; isF?: boolean }> = ({ width, height = 12, delay = 0, isF = false }) => (
  <div style={{
    width, height, borderRadius: 4,
    background: `linear-gradient(90deg, ${isF ? 'rgba(255,102,0,.06)' : 'rgba(140,60,255,.06)'} 25%, ${isF ? 'rgba(255,102,0,.12)' : 'rgba(140,60,255,.12)'} 50%, ${isF ? 'rgba(255,102,0,.06)' : 'rgba(140,60,255,.06)'} 75%)`,
    backgroundSize: '200% 100%',
    animation: `lb-skel-shimmer 1.8s ease-in-out infinite`,
    animationDelay: `${delay}s`,
  }} />
);

const LeaderboardSkeleton: FC<{ isMobile: boolean; count?: number }> = ({ isMobile, count = 8 }) => {
  const { isF } = useFireCtx();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 14,
          padding: isMobile ? '10px 10px' : '12px 16px',
          background: isF ? 'rgba(255,102,0,.02)' : 'rgba(140,60,255,.02)',
          border: `1px solid ${isF ? 'rgba(255,102,0,.06)' : 'rgba(140,60,255,.06)'}`,
          borderRadius: 10,
          animation: `lb-fade-up 0.3s ease ${i * 0.05}s both`,
        }}>
          {/* Rank */}
          <SkeletonBar width="24px" height={20} delay={i * 0.05} isF={isF} />
          {/* Address */}
          <SkeletonBar width={isMobile ? '60px' : '90px'} height={10} delay={i * 0.05 + 0.1} isF={isF} />
          <div style={{ flex: 1 }} />
          {/* Points */}
          <SkeletonBar width={isMobile ? '50px' : '70px'} height={14} delay={i * 0.05 + 0.2} isF={isF} />
          {/* Burned */}
          {!isMobile && <SkeletonBar width="60px" height={10} delay={i * 0.05 + 0.3} isF={isF} />}
        </div>
      ))}
    </div>
  );
};

const StatSkeleton: FC<{ width?: string; isF?: boolean }> = ({ width = '80px', isF = false }) => (
  <div style={{
    width, height: 16, borderRadius: 4,
    background: `linear-gradient(90deg, ${isF ? 'rgba(255,102,0,.06)' : 'rgba(140,60,255,.06)'} 25%, ${isF ? 'rgba(255,102,0,.14)' : 'rgba(140,60,255,.14)'} 50%, ${isF ? 'rgba(255,102,0,.06)' : 'rgba(140,60,255,.06)'} 75%)`,
    backgroundSize: '200% 100%',
    animation: 'lb-skel-shimmer 1.8s ease-in-out infinite',
  }} />
);

// ─── PODIUM DETAIL POPUP ─────────────────────────────────────────────────────
const PODIUM_CFG_VEGAS = [
  { border:'#ffd700', glow:'lb-gold-glow',   label:'#ffd700', rank:'1ST', bg:'rgba(255,215,0,.06)'  },
  { border:'#cc88ff', glow:'lb-purple-glow', label:'#cc88ff', rank:'2ND', bg:'rgba(140,60,255,.05)' },
  { border:'#39ff88', glow:'lb-green-pulse', label:'#39ff88', rank:'3RD', bg:'rgba(57,255,136,.05)' },
];
const PODIUM_CFG_FIRE = [
  { border:'#ff2222', glow:'lb-fire-flicker', label:'#ff2222', rank:'1ST', bg:'rgba(255,34,34,.06)'  },
  { border:'#ff6600', glow:'lb-fire-flicker', label:'#ff6600', rank:'2ND', bg:'rgba(255,102,0,.05)' },
  { border:'#ffbb33', glow:'lb-fire-live',    label:'#ffbb33', rank:'3RD', bg:'rgba(255,187,51,.05)' },
];
const getPodiumCfg = (isF: boolean) => isF ? PODIUM_CFG_FIRE : PODIUM_CFG_VEGAS;

const PodiumPopup: FC<{
  entry: BurnerEntry; rank: number; brainsPrice: number | null; onClose: () => void;
}> = ({ entry, rank, brainsPrice, onClose }) => {
  const { isF } = useFireCtx();
  const tier = getTier(entry.points);
  const cfg  = getPodiumCfg(isF)[rank - 1];
  const usd  = brainsPrice !== null ? entry.burned * brainsPrice : null;
  const isTop = rank === 1;
  const imgSize = isTop ? 68 : 56;
  const [copied, setCopied] = useState(false);
  const copyAddr = () => { navigator.clipboard.writeText(entry.address).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div onClick={onClose} style={{ position:'fixed', top:0, left:0, right:0, bottom:0, zIndex:10000, background:'rgba(4,6,14,.88)', backdropFilter:'blur(10px)', display:'flex', alignItems:'center', justifyContent:'center', padding:12, overflowY:'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ position:'relative', width:'100%', maxWidth:340, background:'linear-gradient(160deg,#0a0818,#0c0a1e,#080e1a)', border:`1px solid ${cfg.border}44`, borderTop:`3px solid ${cfg.border}`, borderRadius:14, padding:'18px 16px 16px', overflow:'hidden', margin:'auto', boxShadow:`0 0 20px ${cfg.border}08, 0 4px 20px rgba(0,0,0,.4)` }}>
        <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(100,60,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.03) 1px,transparent 1px)', backgroundSize:'24px 24px', pointerEvents:'none' }} />
        <button onClick={onClose} style={{ position:'absolute', top:10, right:10, width:28, height:28, borderRadius:'50%', background:'rgba(255,255,255,.06)', border:'1px solid rgba(255,255,255,.12)', color:'#a0bbcc', fontSize:13, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}>✕</button>

        <div style={{ position:'relative', zIndex:1, textAlign:'center', marginBottom:12 }}>
          <div style={{ fontSize:22, filter:`drop-shadow(0 0 4px ${cfg.border}44)`, marginBottom:3 }}>{rank===1?'👑':rank===2?'🥈':'🥉'}</div>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:700, color:cfg.label, letterSpacing:3, marginBottom:8 }}>{cfg.rank} PLACE</div>
          <div style={{ display:'flex', justifyContent:'center', marginBottom:10 }}>
            <div style={{ position:'relative' }}>
              <div style={{ position:'absolute', inset:-3, borderRadius:'50%', border:`2px solid ${cfg.border}44`, boxShadow:`0 0 8px ${cfg.border}22`, animation:`${cfg.glow} 2.5s ease infinite`, pointerEvents:'none' }} />
              <div style={{ width:imgSize, height:imgSize, borderRadius:'50%', overflow:'hidden', border:`2px solid ${cfg.border}`, boxShadow:`0 0 6px ${cfg.border}18, inset 0 0 4px rgba(0,0,0,.3)`, background:'#0a0a14' }}>
                <img src={PODIUM_IMAGES[rank].src} alt={`Rank ${rank}`} style={{ width:'100%', height:'100%', objectFit:'cover', objectPosition:'center top', display:'block', transform:`scale(${PODIUM_IMAGES[rank].scale})` }}
                  onError={e => { (e.target as HTMLImageElement).style.display='none'; (e.target as HTMLImageElement).parentElement!.innerHTML=`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:24px">${tier.icon}</div>`; }} />
              </div>
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, flexWrap:'wrap' }}>
            <span style={{ fontFamily:'monospace', fontSize:9, color:isF?'#f0ecf4':'#c8dce8', wordBreak:'break-all' }}>{entry.address}</span>
            <button onClick={copyAddr} style={{ background:copied?(isF?'rgba(212,160,80,.10)':'rgba(0,201,141,.15)'):(isF?'rgba(255,102,0,.12)':'rgba(140,60,255,.12)'), border:`1px solid ${copied?(isF?'rgba(255,187,51,.4)':'rgba(0,201,141,.4)'):(isF?'rgba(255,102,0,.35)':'rgba(140,60,255,.35)')}`, color:copied?(isF?'#ffbb33':'#00c98d'):(isF?'#ff6600':'#cc88ff'), padding:'2px 8px', borderRadius:4, cursor:'pointer', fontFamily:'Orbitron, monospace', fontSize:7, fontWeight:700, letterSpacing:1 }}>{copied?'✓ COPIED':'⎘ COPY'}</button>
          </div>
        </div>

        <div style={{ position:'relative', zIndex:1, display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ padding:'8px 10px', background:'rgba(255,140,0,.06)', border:'1px solid rgba(255,140,0,.15)', borderRadius:8 }}>
            <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:4 }}><BrainsLogo size={12} /><span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#ff9933', letterSpacing:2 }}>🔥 TOTAL BURNED</span></div>
            <div key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:900, background:'linear-gradient(135deg,#ff9933,#ffcc55,#ff9933)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', filter:'drop-shadow(0 0 4px rgba(255,140,0,.15))' }}>{fmtN(entry.burned,2)} <span style={{ fontSize:8, color:isF?'#cc7722':'#cc7722' }}>BRAINS</span></div>
          </div>
          <div style={{ padding:'8px 10px', background:'linear-gradient(135deg,rgba(255,215,0,.06),rgba(255,140,0,.04))', border:'1px solid rgba(255,215,0,.2)', borderRadius:8 }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#d4a050':'#78c8a0', letterSpacing:2, marginBottom:4 }}>💰 USD VALUE (CURRENT PRICE)</div>
            {brainsPrice!==null&&usd!==null ? (<>
              <div key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:18, fontWeight:900, background:isF?'linear-gradient(135deg,#ffbb33,#ffffffcc,#ffbb33)':'linear-gradient(135deg,#5ec99a,#88ddb8,#4db88a)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', filter:isF?'drop-shadow(0 0 5px rgba(255,187,51,.2))':'drop-shadow(0 0 5px rgba(57,255,136,.15))' }}>${usd>=1000?`${(usd/1000).toFixed(2)}K`:usd>=1?usd.toFixed(2):usd.toFixed(4)}</div>
              <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#c8aa55', marginTop:3 }}>@ ${brainsPrice>=0.001?brainsPrice.toFixed(6):brainsPrice.toFixed(8)} per BRAINS</div>
            </>) : (<div style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:'#aa9955' }}>Price unavailable</div>)}
          </div>
          <div style={{ display:'flex', gap:6 }}>
            <div style={{ flex:1, padding:'8px 10px', background:`${cfg.border}08`, border:`1px solid ${cfg.border}15`, borderRadius:8 }}>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:6, color:cfg.label, letterSpacing:2, marginBottom:3 }}>◆ LB POINTS</div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:14, fontWeight:900, color:cfg.label }}>{fmtPts(entry.points)}</div>
            </div>
            <div style={{ flex:1, padding:'8px 10px', background:`${tier.neon}08`, border:`1px solid ${tier.neon}15`, borderRadius:8 }}>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:6, color:tier.neon, letterSpacing:2, marginBottom:3 }}>TIER</div>
              <div style={{ display:'flex', alignItems:'center', gap:5 }}><span style={{ fontSize:14 }}>{tier.icon}</span><span style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:900, color:tier.neon }}>{tier.label}</span></div>
            </div>
          </div>
          {(entry.ampPct??0)>0&&<div style={{ padding:'8px 10px', background:isF?'rgba(255,187,51,.04)':'rgba(57,255,136,.04)', border:isF?'1px solid rgba(255,187,51,.15)':'1px solid rgba(57,255,136,.15)', borderRadius:8 }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#d4a050':'#78c8a0', letterSpacing:2, marginBottom:4 }}>⚡ WEEKLY CHALLENGE AMPLIFIER</div>
            <div style={{ display:'flex', alignItems:'baseline', gap:6, marginBottom:3 }}>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:14, fontWeight:900, color:isF?'#d4a050':'#78c8a0' }}>+{fmtPts(entry.ampBonusPts??0)}</span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:isF?'#ff9944':'#90b8a0' }}>BONUS PTS</span>
            </div>
            <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#4a8a68', lineHeight:1.4 }}>
              Earned +{(entry.ampPct??0).toFixed(2)}% amplifier from {entry.ampWeekId?`${entry.ampWeekId.replace('week-','Week #')}`:'Weekly Challenge'}.
              Bonus points added to global score.
            </div>
          </div>}
          {(entry.labWorkPts??0)>0&&<div style={{ padding:'8px 10px', background:'rgba(0,204,255,.04)', border:'1px solid rgba(0,204,255,.15)', borderRadius:8 }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#00ccff', letterSpacing:2, marginBottom:4 }}>🧪 LAB WORK BONUS</div>
            <div style={{ display:'flex', alignItems:'baseline', gap:6, marginBottom:3 }}>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:14, fontWeight:900, color:'#00ccff' }}>+{fmtPts(entry.labWorkPts??0)}</span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#0099bb' }}>LB PTS</span>
            </div>
            <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#5588aa', lineHeight:1.4 }}>
              Bonus LB Points from social media promotion and community contributions.
            </div>
          </div>}
          <div style={{ textAlign:'center', fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2, marginTop:3 }}>{entry.txCount} BURN TRANSACTION{entry.txCount!==1?'S':''}</div>
        </div>
      </div>
    </div>
  );
};

const PodiumCard: FC<{ entry: BurnerEntry; rank: number; isYou: boolean; isMobile: boolean; delay: number; onShowDetail: () => void }> = ({
  entry, rank, isYou, isMobile, delay, onShowDetail,
}) => {
  const { isF } = useFireCtx();
  const [hov, setHov] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const cfg    = getPodiumCfg(isF)[rank - 1];
  const tier   = getTier(entry.points);
  const border = isYou ? '#ff9933' : cfg.border;
  const label  = isYou ? '#ff9933' : cfg.label;
  const isTop  = rank === 1;
  const imgSize = isMobile ? (isTop ? 70 : 56) : (isTop ? 110 : 90);

  return (
    <div
      onClick={onShowDetail}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        flex: 1, position: 'relative', overflow: 'hidden', cursor: 'pointer',
        background: hov ? 'linear-gradient(160deg,#0a0616,#0d0820)' : 'linear-gradient(160deg,#050310,#07050e,#04080f)',
        border: `1px solid ${border}${isTop?'88':'55'}`,
        borderTop: `3px solid ${border}`,
        borderRadius: 12,
        padding: isMobile ? '10px 8px 8px' : '16px 14px 12px',
        transition: 'all 0.2s',
        animation: `lb-fade-up 0.4s ease ${delay}s both`,
        boxShadow: 'none',
        minHeight: isTop ? (isMobile ? 180 : 320) : (isMobile ? 160 : 280),
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}
    >
      <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(100,60,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.03) 1px,transparent 1px)', backgroundSize:'24px 24px', pointerEvents:'none' }} />
      {isTop && <div style={{ position:'absolute', inset:0, background:'linear-gradient(90deg,transparent,rgba(255,215,0,.03),transparent)', backgroundSize:'200% 100%', animation:'lb-bar-shimmer 4s ease infinite', pointerEvents:'none' }} />}

      {/* Rank crown + label */}
      <div style={{ textAlign:'center', marginBottom: isMobile?4:8, position:'relative', zIndex:2 }}>
        <div style={{ fontFamily:'Orbitron, monospace', fontSize: isTop?(isMobile?20:28):(isMobile?16:22), lineHeight:1, filter:`drop-shadow(0 0 4px ${border}44)` }}>{rank===1?'👑':rank===2?'🥈':'🥉'}</div>
        <div style={{ fontFamily:'Orbitron, monospace', fontSize: isMobile?7:10, fontWeight:700, color:label, letterSpacing:2, marginTop:3 }}>{cfg.rank}</div>
      </div>

      {/* LARGE PROFILE IMAGE with loading skeleton */}
      <div style={{ position:'relative', zIndex:2, marginBottom: isMobile?6:10 }}>
        <div style={{ position:'absolute', inset:-4, borderRadius:'50%', border:`2px solid ${border}44`, boxShadow:`0 0 8px ${border}15`, animation:`${cfg.glow} 2.5s ease infinite`, pointerEvents:'none' }} />
        <div style={{ width:imgSize, height:imgSize, borderRadius:'50%', overflow:'hidden', border:`3px solid ${border}`, boxShadow:`0 0 8px ${border}22, inset 0 0 8px rgba(0,0,0,0.3)`, background:'#0a0a14', position:'relative' }}>
          {/* Skeleton loader — visible until image loads */}
          {!imgLoaded && (
            <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', zIndex:1 }}>
              <div style={{ position:'absolute', inset:0, background:`radial-gradient(circle, ${border}15, transparent 70%)` }} />
              <div style={{ position:'absolute', inset:0, background:`linear-gradient(135deg, transparent 30%, ${border}12 50%, transparent 70%)`, backgroundSize:'200% 200%', animation:'lb-shimmer 1.8s ease-in-out infinite' }} />
              <div style={{ width:'60%', height:'60%', borderRadius:'50%', border:`2px solid ${border}33`, display:'flex', alignItems:'center', justifyContent:'center', background:`radial-gradient(circle, ${border}10, transparent)`, animation:'lb-pulse 1.5s ease infinite' }}>
                <span style={{ fontSize: isTop?(isMobile?18:24):(isMobile?14:20), filter:`drop-shadow(0 0 8px ${border}66)`, animation:'lb-tier-float 2s ease-in-out infinite' }}>{rank===1?'👑':rank===2?'🥈':'🥉'}</span>
              </div>
            </div>
          )}
          <img src={PODIUM_IMAGES[rank].src} alt={`Rank ${rank}`} loading="eager"
            onLoad={() => setImgLoaded(true)}
            style={{
              width:'100%', height:'100%', objectFit:'cover', objectPosition:'center top', display:'block',
              transform:`scale(${PODIUM_IMAGES[rank].scale})`,
              opacity: imgLoaded ? 1 : 0,
              transition: 'opacity 0.5s ease-in-out',
              position:'relative', zIndex:2,
            }}
            onError={e => { (e.target as HTMLImageElement).style.display='none'; setImgLoaded(true); (e.target as HTMLImageElement).parentElement!.innerHTML=`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:${isTop?36:28}px;background:radial-gradient(circle,${tier.neon}20,transparent 70%)">${tier.icon}</div>`; }} />
        </div>
      </div>

      {/* Address + YOU badge */}
      <div style={{ textAlign:'center', marginBottom: isMobile?4:8, position:'relative', zIndex:2 }}>
        <div style={{ fontFamily:'monospace', fontSize: isMobile?9:11, color: isYou?'#ffbb77':label, letterSpacing:0.5 }}>{short(entry.address)}</div>
        {isYou && <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#ff9933', background:'rgba(255,140,0,.15)', border:'1px solid rgba(255,140,0,.4)', borderRadius:3, padding:'2px 6px', marginTop:4, display:'inline-block' }}>YOU</span>}
      </div>

      {/* Stats */}
      <div style={{ display:'flex', flexDirection:'column', gap:4, width:'100%', marginTop:'auto', position:'relative', zIndex:2 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:isMobile?'4px 8px':'6px 10px', background:'rgba(255,140,0,.06)', borderRadius:6, border:'1px solid rgba(255,140,0,.08)' }}>
          <span style={{ display:'flex', alignItems:'center', gap:4, fontFamily:'Orbitron, monospace', fontSize: isMobile?6:8, color:'#ff9933' }}><BrainsLogo size={isMobile?8:10} /> 🔥 BURNED</span>
          <span style={{ fontFamily:'Orbitron, monospace', fontSize: isMobile?8:11, fontWeight:700, color:'#ff9933', textShadow:'0 0 8px rgba(255,140,0,.3)' }}>{fmtN(entry.burned,1)}</span>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:isMobile?'4px 8px':'6px 10px', background:`${border}0a`, borderRadius:6, border:`1px solid ${border}12` }}>
          <span style={{ fontFamily:'Orbitron, monospace', fontSize: isMobile?6:8, color:label }}>◆ LB POINTS</span>
          <span style={{ fontFamily:'Orbitron, monospace', fontSize: isMobile?10:13, fontWeight:900, color:label, textShadow:'none' }}>{fmtPts(entry.points)}</span>
        </div>
        {(entry.ampPct??0)>0&&<div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'4px 10px', background:isF?'rgba(255,187,51,.04)':'rgba(57,255,136,.04)', borderRadius:6, border:isF?'1px solid rgba(255,187,51,.08)':'1px solid rgba(57,255,136,.08)' }}>
          <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#d4a050':'#78c8a0' }}>⚡ AMP BONUS</span>
          <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:700, color:isF?'#d4a050':'#78c8a0' }}>+{fmtPts(entry.ampBonusPts??0)} pts</span>
        </div>}
        <div style={{ display:'flex', justifyContent:'center', marginTop:3 }}><TierBadge points={entry.points} size="sm" /></div>
      </div>
      <div style={{ textAlign:'center', marginTop:6, fontFamily:'Orbitron, monospace', fontSize:6, color:'#8aacbb', letterSpacing:2, position:'relative', zIndex:2 }}>TAP FOR DETAILS</div>
    </div>
  );
};

// ─── LEADERBOARD ROW (rank 4+) ───────────────────────────────────────────────
const LbRow: FC<{ entry: BurnerEntry; rank: number; isYou: boolean; delay: number; isMobile?: boolean }> = ({
  entry, rank, isYou, delay, isMobile = false,
}) => {
  const { isF } = useFireCtx();
  const [hov, setHov] = useState(false);
  const tier = getTier(entry.points);
  const accentColor = isYou ? (isF?'#c87040':'#d08050') : hov ? (isF?'#c85030':'#b080d0') : (isF?'rgba(200,56,56,.18)':'rgba(140,60,255,.25)');

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '30px 1fr 90px 80px' : '42px 1fr 130px 120px 70px 50px',
        alignItems: 'center', gap: isMobile ? 4 : 8,
        padding: isMobile ? '9px 10px' : '11px 16px',
        background: isYou ? 'linear-gradient(135deg,rgba(255,140,0,.06),rgba(255,140,0,.03))' : hov ? 'linear-gradient(135deg,#0a0618,#0e0a20)' : rank % 2 === 0 ? 'linear-gradient(135deg,#04030a,#060410)' : 'linear-gradient(135deg,#030208,#05040e)',
        border: `1px solid ${accentColor}`,
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 8,
        transition: 'all 0.15s',
        animation: `lb-row-in 0.35s ease ${delay}s both`,
        position: 'relative', overflow: 'hidden',
        boxShadow: isYou ? '0 0 6px rgba(255,140,0,.05)' : 'none',
      }}
    >
      {/* grid texture */}
      <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(100,60,255,.015) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.015) 1px,transparent 1px)', backgroundSize:'20px 20px', pointerEvents:'none' }} />

      {/* Rank */}
      <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?9:11, fontWeight:700, color: isYou?'#ff9933':hov?'#ee88ff':'#b8d0e0', textAlign:'center', position:'relative', zIndex:1 }}>
        {rank}
      </div>

      {/* Address + tier */}
      <div style={{ minWidth:0, position:'relative', zIndex:1 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
          <span style={{ fontFamily:'monospace', fontSize:isMobile?10:12, color: isYou?'#f0d0a0':hov?'#d0b8e8':'#dde4ec', letterSpacing:0.4 }}>
            {short(entry.address)}
          </span>
          {isYou && <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#ff9933', background:'rgba(255,140,0,.1)', border:'1px solid rgba(255,140,0,.3)', borderRadius:3, padding:'1px 5px' }}>YOU</span>}
          <CopyBtn text={entry.address} />
        </div>
        <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, marginTop:2, color:tier.neon, letterSpacing:1, display:'flex', alignItems:'center', gap:4 }}>
          {tier.icon} {tier.label}
          {(entry.labWorkPts??0)>0&&<span style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#00ccff', background:'rgba(0,204,255,.1)', border:'1px solid rgba(0,204,255,.25)', borderRadius:3, padding:'1px 5px' }}>🧪 +{fmtPts(entry.labWorkPts??0)} LB</span>}
          {entry.burned===0&&(entry.labWorkPts??0)>0&&<span style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#ff9933', background:'rgba(255,153,51,.1)', border:'1px solid rgba(255,153,51,.25)', borderRadius:3, padding:'1px 5px' }}>PROMO ONLY</span>}
        </div>
      </div>

      {/* Burned */}
      <div style={{ textAlign:'right', position:'relative', zIndex:1 }}>
        <div style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?9:11, color:'#ff9933' }}>🔥 {fmtN(entry.burned, 1)}</div>
        <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?6:7, color:'#e8eef4', marginTop:1 }}>BRAINS</div>
      </div>

      {/* Points */}
      <div style={{ textAlign:'right', position:'relative', zIndex:1 }}>
        <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?11:13, fontWeight:700, color: hov?(isF?'#e0c880':'#c8f0d8'):(isF?'#d4a860':'#88dda8'), textShadow:'none' }}>
          {fmtPts(entry.points)}
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:4, marginTop:1 }}>
          <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#ff9944':'#90b8a0' }}>PTS</span>
          {(entry.ampPct??0)>0&&<span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:isF?'#d4a050':'#78c8a0', background:isF?'rgba(255,187,51,.1)':'rgba(57,255,136,.1)', border:isF?'1px solid rgba(255,34,34,.2)':'1px solid rgba(57,255,136,.2)', borderRadius:4, padding:'1px 6px', fontWeight:700 }}>⚡+{fmtPts(entry.ampBonusPts??0)}</span>}
        </div>
      </div>

      {/* Txs — hidden on mobile */}
      {!isMobile && (
      <div style={{ textAlign:'right', position:'relative', zIndex:1 }}>
        {(entry.ampPct??0)>0?<>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:11, fontWeight:700, color:isF?'#d4a050':'#78c8a0' }}>+{fmtPts(entry.ampBonusPts??0)}</div>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#ff9944':'#90b8a0', marginTop:1 }}>+{(entry.ampPct??0).toFixed(1)}%</div>
        </>:<div style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:isF?'#6a5e78':'#6b8899' }}>—</div>}
      </div>
      )}

      {/* TX count — hidden on mobile */}
      {!isMobile && (
      <div style={{ textAlign:'right', position:'relative', zIndex:1 }}>
        <div style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:isF?'#f0ecf4':'#c8dce8' }}>{entry.txCount}</div>
        <div style={{ fontFamily:'Sora, sans-serif', fontSize:7, color:'#b8c4d0', marginTop:1 }}>TXS</div>
      </div>
      )}
    </div>
  );
};

// ─── MY SCORE CARD ────────────────────────────────────────────────────────────
const MyScoreCard: FC<{
  entry: BurnerEntry | null; rank: number | null; total: number;
  isMobile: boolean; walletAddress?: string; brainsPrice?: number | null;
}> = ({ entry, rank, total, isMobile, walletAddress, brainsPrice }) => {
  const { isF } = useFireCtx();
  const tier      = entry ? getTier(entry.points) : TIERS[0];
  const next      = entry ? nextTier(entry.points) : null;
  const ptsToNext = next && entry ? next.min - entry.points : 0;
  const tierMin   = getTier(entry?.points ?? 0).min;
  const tierPct   = next && entry && next.min > tierMin
    ? Math.min(((entry.points - tierMin) / (next.min - tierMin)) * 100, 100)
    : entry ? 100 : 0;
  const percentile = rank && total > 0 ? Math.round(((total - rank) / total) * 100) : 0;
  const supplyPct  = entry ? (entry.burned / 8_880_000) * 100 : 0;
  const usdValue   = entry && brainsPrice ? entry.burned * brainsPrice : null;

  return (
    <div style={heroPanelStyle(8,isF)}>
      <HeroBg intensity={0.85} accent={isF?'#ff6600':'#cc88ff'} />
      {/* Extra ambient orbs for richness */}
      <div style={{ position:'absolute', top:'8%', right:'3%', width:140, height:140, borderRadius:'50%', background:isF?'radial-gradient(circle,rgba(255,34,34,.03) 0%,transparent 70%)':'radial-gradient(circle,rgba(140,60,255,.03) 0%,transparent 70%)', pointerEvents:'none' }} />
      <div style={{ position:'absolute', bottom:'5%', left:'3%', width:110, height:110, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,140,0,.02) 0%,transparent 70%)', pointerEvents:'none' }} />
      <div style={{ position:'absolute', top:'40%', left:'60%', width:80, height:80, borderRadius:'50%', background:isF?'radial-gradient(circle,rgba(255,187,51,.015) 0%,transparent 70%)':'radial-gradient(circle,rgba(0,200,255,.015) 0%,transparent 70%)', pointerEvents:'none' }} />

      {/* ── HEADER ROW ── */}
      <div style={{ position:'relative', zIndex:6, padding: isMobile?'14px 12px':'18px 24px', display:'flex', alignItems:isMobile?'flex-start':'center', gap:isMobile?10:14, flexDirection:isMobile?'column':'row', borderBottom:isF?'1px solid rgba(255,34,34,.08)':'1px solid rgba(140,60,255,.1)' }}>
        {/* Top row on mobile: orbital + title */}
        <div style={{ display:'flex', alignItems:'center', gap:isMobile?10:14, width:'100%' }}>
        {/* Animated orbital with BRAINS logo — hero style */}
        <div style={{ position:'relative', width:isMobile?40:60, height:isMobile?40:60, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
          {/* Outer ring — orange/gold with orbiting dot */}
          <div style={{ position:'absolute', inset:0, borderRadius:'50%', border:isF?'1.5px solid rgba(255,34,34,.12)':'1.5px solid rgba(255,140,0,.1)', animation:'lb-spin 10s linear infinite' }}>
            <div style={{ position:'absolute', top:-2, left:'50%', width:4, height:4, borderRadius:'50%', background:isF?'#ff2222':'#ff9933', boxShadow:isF?'0 0 3px rgba(255,34,34,.2)':'0 0 3px rgba(255,153,51,.2)' }} />
          </div>
          {/* Mid ring — purple/magenta with dot */}
          <div style={{ position:'absolute', inset:6, borderRadius:'50%', border:isF?'1px solid rgba(255,102,0,.1)':'1px solid rgba(180,60,255,.08)', animation:'lb-spin 7s linear infinite reverse' }}>
            <div style={{ position:'absolute', bottom:-2, right:4, width:3, height:3, borderRadius:'50%', background:isF?'#ff6600':'#ee55ff', boxShadow:isF?'0 0 2px rgba(255,102,0,.2)':'0 0 2px rgba(238,85,255,.2)' }} />
          </div>
          {/* Inner ring — cyan with dot */}
          <div style={{ position:'absolute', inset:12, borderRadius:'50%', border:isF?'1px solid rgba(255,187,51,.08)':'1px solid rgba(0,200,255,.06)', animation:'lb-spin 5s linear infinite' }}>
            <div style={{ position:'absolute', top:0, right:0, width:3, height:3, borderRadius:'50%', background:isF?'#ffbb33':'#00ccff', boxShadow:isF?'0 0 2px rgba(255,187,51,.2)':'0 0 2px rgba(0,204,255,.2)' }} />
          </div>
          {/* BRAINS token logo center */}
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}>
            <img src={BRAINS_LOGO} alt="BRAINS" style={{ width:isMobile?24:30, height:isMobile?24:30, borderRadius:'50%', objectFit:'cover', border:isF?'1.5px solid rgba(255,34,34,.3)':'1.5px solid rgba(255,140,0,.25)', boxShadow:isF?'0 0 5px rgba(255,34,34,.15)':'0 0 5px rgba(255,140,0,.1)', background:isF?'#0a090c':'#0a0a14' }} />
          </div>
        </div>

        {/* Title */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
            <span key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?12:16, fontWeight:900, letterSpacing:isMobile?2:3, background:isF?'linear-gradient(90deg,#ffdd44,#ffbb33,#ff6600,#ffffff,#ff2222)':'linear-gradient(90deg,#cc88ff,#ee55ff,#ff9933)', backgroundSize:isF?'200% 100%':undefined, WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', filter:isF?'drop-shadow(0 0 4px rgba(255,34,34,.12))':'drop-shadow(0 0 4px rgba(140,60,255,.08))', animation:isF?'lb-grad-shift 5s ease infinite':undefined }}>
              YOUR BURNS
            </span>
            <span style={{ fontFamily:'Sora, sans-serif', fontSize:7, color:isF?'#ff6600':'#cc88ff', padding:'2px 8px', background:isF?'rgba(255,102,0,.12)':'rgba(140,60,255,.08)', border:isF?'1px solid rgba(255,34,34,.18)':'1px solid rgba(140,60,255,.15)', borderRadius:12, letterSpacing:2 }}>PERSONAL</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
            <span style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?7:9, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:1.5 }}>
              🔗 CONNECTED WALLET · ALL-TIME
            </span>
            {walletAddress && (
              <span style={{ display:'flex', alignItems:'center', gap:5 }}>
                <span style={{ fontFamily:'monospace', fontSize:isMobile?9:11, color:isF?'#f0ecf4':'#c8dce8' }}>{short(walletAddress)}</span>
                <CopyBtn text={walletAddress} />
              </span>
            )}
          </div>
        </div>
        </div>{/* end top row wrapper */}

        {/* Rank pill — on mobile, full width row below */}
        {entry && rank && (
          <div style={{ display:'flex', alignItems:'center', gap:isMobile?8:5, flexDirection:isMobile?'row':'column', justifyContent:isMobile?'flex-start':'center', flexShrink:0, width:isMobile?'100%':undefined }}>
            <div style={{ display:'flex', alignItems:'center', gap:5, background:isF?'rgba(10,8,6,.95)':'rgba(10,5,20,.95)', border:isF?'1px solid rgba(255,187,51,.3)':'1px solid rgba(140,60,255,.25)', borderRadius:8, padding:isMobile?'4px 10px':'6px 14px' }}>
              <span style={{ fontSize:isMobile?10:12 }}>🏆</span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?10:13, fontWeight:800, color:isF?'#ff6600':'#cc88ff', letterSpacing:2 }}>
                RANK #{rank}
              </span>
            </div>
            <span style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?7:8, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:1 }}>
              top {percentile||'<1'}% · of {total}
            </span>
            <TierBadge points={entry.points} size="sm" />
          </div>
        )}
      </div>

      {/* ── METRIC PANELS ── */}
      {entry ? (
        <div style={{ position:'relative', zIndex:6 }}>
          {/* Main stats grid */}
          <div style={{ display:'grid', gridTemplateColumns:isMobile?'1fr 1fr':'repeat(5,1fr)', borderBottom:isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.08)' }}>
            {[
              { label:'TOTAL BURNED',  value:fmtN(entry.burned,2), sub:'BRAINS', icon:'🔥', color:isF?'#c87040':'#d08050', grad:isF?'linear-gradient(135deg,#c85030,#c87040,#d4a050,#e8dcd0dd,#d4a050,#c87040)':'linear-gradient(135deg,#d4884f,#e8b870,#d4884f)', accent:isF?'rgba(255,102,0,.08)':'rgba(255,140,0,.08)', glow:isF?'rgba(255,102,0,.05)':'rgba(255,140,0,.05)', big:true },
              { label:'USD VALUE',     value:usdValue!=null?(usdValue>=1000?`$${(usdValue/1000).toFixed(2)}K`:`$${usdValue.toFixed(2)}`):'—', sub:brainsPrice?`@ $${brainsPrice>=0.001?brainsPrice.toFixed(4):brainsPrice.toFixed(6)}`:'—', icon:'💰', color:isF?'#d4a050':'#78c8a0', grad:isF?'linear-gradient(135deg,#cc8800,#ffbb33,#ffffffcc,#ffbb33)':'linear-gradient(135deg,#5ec99a,#88ddb8,#4db88a)', accent:isF?'rgba(212,160,80,.04)':'rgba(57,255,136,.06)', glow:isF?'rgba(255,187,51,.04)':'rgba(57,255,136,.04)' },
              { label:'TOTAL LB POINTS',  value:fmtPts(entry.points), sub:'LB PTS EARNED', icon:'◆', color:isF?'#ff2222':'#ee55ff', grad:isF?'linear-gradient(135deg,#cc1111,#ff2222,#ffffffbb,#ff2222)':'linear-gradient(135deg,#c07ad4,#d8a0e0,#a860c0)', accent:isF?'rgba(200,56,56,.04)':'rgba(238,85,255,.05)', glow:isF?'rgba(200,56,56,.03)':'rgba(238,85,255,.03)' },
              { label:'SUPPLY IMPACT', value:`${supplyPct.toFixed(4)}%`, sub:'OF TOTAL', icon:'📊', color:isF?'#ffdd44':'#00ccff', grad:isF?'linear-gradient(135deg,#ccaa00,#ffdd44,#ffffffbb,#ffdd44)':'linear-gradient(135deg,#5bb8d4,#7ec8dd,#4aa0bc)', accent:isF?'rgba(255,221,68,.06)':'rgba(0,200,255,.05)', glow:isF?'rgba(255,221,68,.04)':'rgba(0,200,255,.03)' },
              { label:'TRANSACTIONS',  value:`${entry.txCount}`, sub:'BURN TXS', icon:'⚡', color:isF?'#ff6600':'#39ff88', grad:isF?'linear-gradient(135deg,#ff4400,#ff6600,#ffffffbb,#ff6600)':'linear-gradient(135deg,#5ec99a,#88ddbb,#4db88a)', accent:isF?'rgba(255,102,0,.06)':'rgba(57,255,136,.05)', glow:isF?'rgba(255,102,0,.04)':'rgba(57,255,136,.03)' },
            ].map((s,i,arr)=>(
              <div key={`ms-${i}-${isF?'f':'v'}`} style={{
                padding:isMobile?'16px 10px':'20px 14px', textAlign:'center', position:'relative', overflow:'hidden',
                borderRight:i<arr.length-1&&(!isMobile||i%2===0)?(isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.06)'):'none',
                borderBottom:isMobile&&i<(arr.length-1)?(isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.06)'):'none',
                background:`linear-gradient(160deg, ${s.accent}, transparent 60%)`,
              }}>
                <div style={{ position:'absolute', left:0, top:0, bottom:0, width:1, background:`linear-gradient(180deg,transparent,${s.color}22,${s.color}44,${s.color}22,transparent)` }} />
                <div style={{ position:'absolute', bottom:0, left:'10%', right:'10%', height:1, background:`linear-gradient(90deg,transparent,${s.color}22,transparent)` }} />
                <div style={{ position:'absolute', top:'25%', left:'50%', transform:'translate(-50%,-50%)', width:100, height:70, borderRadius:'50%', background:`radial-gradient(circle,${s.glow},transparent 70%)`, pointerEvents:'none' }} />
                <div style={{ position:'absolute', inset:0, background:`linear-gradient(90deg,transparent,${s.color}02,transparent)`, backgroundSize:'300% 100%', animation:'none', pointerEvents:'none' }} />
                <div style={{ position:'relative', zIndex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:4, marginBottom:8 }}>
                    <span style={{ fontSize:12, filter:`drop-shadow(0 0 3px ${s.color}44)` }}>{s.icon}</span>
                    <span style={{ fontFamily:'Sora, sans-serif', fontSize:7, color:s.color, letterSpacing:2, fontWeight:700 }}>{s.label}</span>
                  </div>
                  <div key={isF?'f':'v'} style={{ fontFamily:'Rajdhani, sans-serif', fontSize:s.big?(isMobile?20:26):(isMobile?18:22), fontWeight:900, lineHeight:1, letterSpacing:1, marginBottom:4, color:'#b8c4d0' }}>
                    {s.value}
                  </div>
                  <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#a0aab8', letterSpacing:1 }}>{s.sub}</div>
                </div>
              </div>
            ))}
          </div>

          {/* AMP bonus row (if earned) */}
          {(entry.ampPct??0)>0&&<div style={{ padding:isMobile?'10px 14px':'12px 22px', background:isF?'rgba(255,187,51,.03)':'rgba(57,255,136,.03)', borderBottom:isF?'1px solid rgba(255,187,51,.08)':'1px solid rgba(57,255,136,.08)', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:14 }}>⚡</span>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:isF?'#d4a050':'#78c8a0', letterSpacing:2, fontWeight:700 }}>CHALLENGE AMPLIFIER</span>
            </div>
            <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:16, fontWeight:900, color:isF?'#d4a050':'#78c8a0' }}>+{fmtPts(entry.ampBonusPts??0)} PTS</div>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:isF?'#b8b0c0':'#b0bcc8' }}>+{(entry.ampPct??0).toFixed(2)}% from {entry.ampWeekId?`${entry.ampWeekId.replace('week-','Week #')}`:'Weekly Challenge'}</span>
          </div>}

          {/* ── TIER PROGRESS ── */}
          <div style={{ padding:isMobile?'14px 14px':'16px 24px', display:'flex', alignItems:'center', gap:16, flexWrap:isMobile?'wrap':'nowrap' }}>
            <div style={{ flexShrink:0 }}>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2, marginBottom:6 }}>BURN TIER</div>
              <TierBadge points={entry.points} size="md" />
            </div>
            <div style={{ width:1, height:36, background:isF?'rgba(200,56,56,.10)':'rgba(140,60,255,.12)', flexShrink:0, display:isMobile?'none':'block' }} />
            <div style={{ flex:1, minWidth:140 }}>
              {next ? (
                <>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                    <span style={{ fontFamily:'Sora, sans-serif', fontSize:9, color:'#b8c4d0' }}>
                      <span style={{ color:tier.neon, fontWeight:700 }}>{tier.label}</span>
                      <span style={{ color:'#e8eef4', margin:'0 6px' }}>→</span>
                      <span style={{ color:next.neon, fontWeight:700 }}>{next.label}</span>
                    </span>
                    <span style={{ fontFamily:'Sora, sans-serif', fontSize:9, fontWeight:700, color:next.neon }}>{ptsToNext.toLocaleString()} PTS TO GO</span>
                  </div>
                  <div style={{ position:'relative', height:10, borderRadius:5, overflow:'hidden', background:isF?'rgba(10,10,12,.8)':'rgba(10,5,20,.8)', border:isF?'1px solid rgba(255,34,34,.15)':'1px solid rgba(140,60,255,.12)' }}>
                    <div style={{ position:'absolute', top:1, left:1, bottom:1, width:`calc(${tierPct}% - 2px)`, background:isF?`linear-gradient(90deg,#cc3300,${tier.neon},#ffbb33)`:`linear-gradient(90deg,#4420aa,${tier.neon},#39ff88)`, borderRadius:4, animation:'lb-bar-fill 1.6s cubic-bezier(.16,1,.3,1) both', minWidth:tierPct>0?3:0, boxShadow:`0 0 8px ${tier.neon}44` }}>
                      <div style={{ position:'absolute', inset:0, borderRadius:4, background:'linear-gradient(90deg,transparent 40%,rgba(255,255,255,.12) 50%,transparent 60%)', backgroundSize:'200% 100%', animation:'none' }} />
                    </div>
                    {tierPct<100&&<div style={{ position:'absolute', top:1, bottom:1, right:1, width:`calc(${100-tierPct}% - 2px)`, borderRadius:'0 4px 4px 0', backgroundImage:isF?'repeating-linear-gradient(90deg,rgba(255,34,34,.02) 0px,rgba(255,34,34,.02) 1px,transparent 1px,transparent 6px)':'repeating-linear-gradient(90deg,rgba(140,60,255,.015) 0px,rgba(140,60,255,.015) 1px,transparent 1px,transparent 6px)', pointerEvents:'none' }} />}
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', marginTop:5 }}>
                    <span style={{ fontFamily:'Sora, sans-serif', fontSize:9, fontWeight:700, color:`${tier.neon}` }}>{tierPct.toFixed(1)}%</span>
                    <span style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#b8c4d0' }}>{entry.points.toLocaleString()} / {next.min.toLocaleString()} PTS</span>
                  </div>
                </>
              ) : (
                <div style={{ fontFamily:'Orbitron, monospace', fontSize:14, color:'#b8c4d0', letterSpacing:3, textShadow:'none' }}>☠️ MAX TIER ACHIEVED</div>
              )}
            </div>
            <div style={{ flexShrink:0, textAlign:'right' }}>
              <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2, marginBottom:4 }}>TOTAL PTS</div>
              <div key={isF?'f':'v'} style={{ fontFamily:'Rajdhani, sans-serif', fontSize:isMobile?18:26, fontWeight:900, lineHeight:1, color:'#b8c4d0' }}>{fmtPts(entry.points)}</div>
            </div>
          </div>
        </div>
      ) : walletAddress ? (
        <div style={{ position:'relative', zIndex:6 }}>
          <div style={{ display:'grid', gridTemplateColumns:isMobile?'1fr 1fr':'repeat(5,1fr)', borderBottom:isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.08)' }}>
            {[
              { label:'TOTAL BURNED', value:'0', sub:'BRAINS', icon:'🔥', color:isF?'#c87040':'#d08050', accent:isF?'rgba(255,102,0,.08)':'rgba(255,140,0,.08)' },
              { label:'USD VALUE', value:'$0.00', sub:'NO BURNS YET', icon:'💰', color:isF?'#d4a050':'#78c8a0', accent:isF?'rgba(212,160,80,.04)':'rgba(57,255,136,.06)' },
              { label:'TOTAL LB POINTS', value:'0', sub:'LB PTS EARNED', icon:'◆', color:isF?'#ff2222':'#ee55ff', accent:isF?'rgba(200,56,56,.04)':'rgba(238,85,255,.05)' },
              { label:'SUPPLY IMPACT', value:'0%', sub:'OF TOTAL', icon:'📊', color:isF?'#ffdd44':'#00ccff', accent:isF?'rgba(255,221,68,.06)':'rgba(0,200,255,.05)' },
              { label:'TRANSACTIONS', value:'0', sub:'BURN TXS', icon:'⚡', color:isF?'#d4a050':'#78c8a0', accent:isF?'rgba(255,102,0,.06)':'rgba(57,255,136,.05)' },
            ].map((s,i,arr)=>(
              <div key={i} style={{
                padding:isMobile?'16px 10px':'20px 14px', textAlign:'center', position:'relative', overflow:'hidden',
                borderRight:i<arr.length-1&&(!isMobile||i%2===0)?(isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.06)'):'none',
                borderBottom:isMobile&&i<(arr.length-1)?(isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.06)'):'none',
                background:`linear-gradient(160deg, ${s.accent}, transparent 60%)`, opacity:0.5,
              }}>
                <div style={{ position:'absolute', left:0, top:0, bottom:0, width:2, background:`linear-gradient(180deg,transparent,${s.color}33,transparent)` }} />
                <div style={{ position:'relative', zIndex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:4, marginBottom:8 }}>
                    <span style={{ fontSize:12 }}>{s.icon}</span>
                    <span style={{ fontFamily:'Sora, sans-serif', fontSize:7, color:s.color, letterSpacing:2, fontWeight:700 }}>{s.label}</span>
                  </div>
                  <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:isMobile?18:22, fontWeight:900, color:'#b8c4d0', lineHeight:1, letterSpacing:1, marginBottom:4 }}>{s.value}</div>
                  <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#a0aab8', letterSpacing:1 }}>{s.sub}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding:'20px 22px', textAlign:'center' }}>
            <div style={{ fontFamily:'Orbitron, monospace', fontSize:11, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:3 }}>
              🔥 NO BURNS YET — START BURNING BRAINS TO EARN LB POINTS & CLIMB THE RANKS
            </div>
          </div>
        </div>
      ) : (
        <div style={{ position:'relative', zIndex:6, padding:'24px 22px', textAlign:'center' }}>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:11, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:3 }}>
            🔗 CONNECT WALLET TO VIEW YOUR BURN STATS
          </div>
        </div>
      )}
    </div>
  );
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
interface Props {
  connection: Connection; walletAddress?: string;
  walletBurned?: number; walletTxCount?: number;
  isMobile: boolean; globalBurned?: number; globalSupply?: number;
  onEntriesLoaded?: (entries: BurnerEntry[]) => void;
}

export const BurnLeaderboard: FC<Props> = ({
  connection, walletAddress, walletBurned, walletTxCount, isMobile, globalBurned, globalSupply, onEntriesLoaded,
}) => {
  const [lb, setLb]          = useState<LbState>({ entries:[], loading:false, progress:'', batches:0, error:null, fetchedAt:null });
  const [showAll, setShowAll] = useState(false);
  const [lbSort, setLbSort]   = useState<'points'|'burned'|'wallet'>('points');
  const [lbView, setLbView]   = useState<'all'|'burners'|'labwork'|'weekly'>('all');
  const [firstEvtLive, setFirstEvtLive] = useState<BurnEvent|null>(null);
  const [lastEvtLive,  setLastEvtLive]  = useState<BurnEvent|null>(null);
  const [podiumPopup, setPodiumPopup]   = useState<{ entry: BurnerEntry; rank: number } | null>(null);
  const [tierCollapsed, setTierCollapsed] = useState(true);
  const [weekCfg, setWeekCfg]           = useState<{weekId:string;status:string;startDate?:string;endDate?:string}|null>(null);
  const [t, themeName, toggleTheme] = useIncTheme();
  const isF = themeName === 'fire';
  const brainsPrice = useBrainsPrice();
  const marketData  = useMarketData();
  const podiumReady = usePodiumImagesReady();
  const abortRef    = useRef<AbortController | null>(null);
  const refreshRef  = useRef<ReturnType<typeof setInterval>|null>(null);
  const mountedRef  = useRef(true);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; abortRef.current?.abort(); if (refreshRef.current) clearInterval(refreshRef.current); }; }, []);

  // Load active weekly config for the weekly filter
  useEffect(() => {
    (async () => {
      try {
        const raw = localStorage.getItem('brains_weekly_config');
        if (raw) { const p = JSON.parse(raw); if (p?.weekId) setWeekCfg(p); }
        const sb = await import('../lib/supabase');
        const cfg = await sb.getCachedWeeklyConfig();
        if (cfg && mountedRef.current) setWeekCfg(cfg as any);
      } catch {}
    })();
  }, []);

  // Fetch the single most recent burn tx from the mint address
  const fetchLatestBurn = useCallback(async () => {
    if (!connection) return;
    try {
      const mintPK  = new PublicKey(BRAINS_MINT);
      const mintStr = mintPK.toBase58();
      const sigs    = await connection.getSignaturesForAddress(mintPK, { limit: 20 }).catch(() => []);
      if (!sigs.length || !mountedRef.current) return;
      const txs = await connection.getParsedTransactions(sigs.map(s => s.signature), { maxSupportedTransactionVersion:0, commitment:'confirmed' }).catch(() => []);
      for (const tx of txs) {
        if (!tx || tx.meta?.err) continue;
        const allIxs: unknown[] = [...(tx.transaction.message.instructions ?? [])];
        for (const inn of tx.meta?.innerInstructions ?? []) allIxs.push(...(inn.instructions ?? []));
        for (const ix of allIxs) {
          const p = ix as Record<string,unknown>;
          if (p.program !== 'spl-token') continue;
          const parsed = p.parsed as Record<string,unknown>|undefined;
          if (!parsed) continue;
          if (parsed.type !== 'burn' && parsed.type !== 'burnChecked') continue;
          const info = parsed.info as Record<string,unknown>|undefined;
          if (!info || (info.mint as string) !== mintStr) continue;
          const ta = info.tokenAmount as Record<string,unknown>|undefined;
          const uiAmt = ta ? Number((ta as any).uiAmount ?? 0) : 0;
          const rawAmt = ta ? Number((ta as any).amount ?? 0) : Number(info.amount ?? 0);
          const amount = uiAmt > 0 ? uiAmt : rawAmt / 1_000_000;
          if (amount <= 0) continue;
          if (mountedRef.current) setLastEvtLive({ amount, blockTime: tx.blockTime ?? 0, sig: tx.transaction.signatures?.[0] ?? '' });
          return;
        }
      }
    } catch {}
  }, [connection]);

  const load = useCallback(async (forceRefresh = false) => {
    if (!connection) return;

    // Show cached data instantly while we fetch fresh data
    if (!forceRefresh) {
      const cached = getCachedLeaderboard();
      if (cached && cached.length > 0) {
        setLb({ entries: cached, loading: true, progress: 'Refreshing…', batches: 0, error: null, fetchedAt: new Date() });
        onEntriesLoaded?.(cached);
      } else {
        setLb({ entries: [], loading: true, progress: 'Initializing…', batches: 0, error: null, fetchedAt: null });
      }
    } else {
      setLb(prev => ({ ...prev, loading: true, progress: 'Refreshing…', batches: 0, error: null }));
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const final = await fetchLeaderboard(connection, ctrl.signal, (entries, progress, batches) => {
        if (!mountedRef.current || ctrl.signal.aborted) return;
        setLb(prev => ({ ...prev, entries: entries.length > 0 ? entries : prev.entries, progress, batches }));
      });
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setLb({ entries: final, loading: false, progress: '', batches: 0, error: null, fetchedAt: new Date() });
      onEntriesLoaded?.(final);
    } catch(e: any) {
      if (!mountedRef.current || ctrl.signal.aborted) return;
      setLb(prev => ({ ...prev, loading: false, error: e.message ?? 'Failed' }));
    }
  }, [connection]);

  useEffect(() => {
    // Fetch lab work points + AMP windows from Supabase first, then load leaderboard
    Promise.all([
      getCachedLabWorkMap().then(map => { if (mountedRef.current) setSupabaseLabWorkMap(map); }).catch(() => {}),
      fetchAmpWindowsFromSupabase().catch(() => {}),
    ]).finally(() => {
      load(); fetchLatestBurn();
    });
  }, [load, fetchLatestBurn]);

  // Auto-refresh: latest burn every 10s, lab work map from Supabase every 60s
  useEffect(() => {
    if (refreshRef.current) clearInterval(refreshRef.current);
    refreshRef.current = setInterval(() => {
      fetchLatestBurn();
    }, 10_000);
    return () => { if (refreshRef.current) clearInterval(refreshRef.current); };
  }, [fetchLatestBurn]);

  // Refresh lab work map from Supabase every 60s so new awards appear
  useEffect(() => {
    const lwInterval = setInterval(() => {
      getCachedLabWorkMap().then(map => {
        if (mountedRef.current && map.size > 0) {
          setSupabaseLabWorkMap(map);
        }
      }).catch(() => {});
    }, 60_000);
    return () => clearInterval(lwInterval);
  }, []);

  // Merge personal wallet — prefer existing entry from buildEntries (which includes labWork + AMP)
  const entries = useMemo(() => {
    if (!walletAddress) return lb.entries;
    const existing = lb.entries.find(e => e.address === walletAddress);
    // If wallet already exists in the leaderboard (from buildEntries), keep it — it has labWork + AMP
    if (existing) {
      // If walletBurned is fresher (e.g. just burned), update burned count but recalc properly
      if (walletBurned && walletBurned > 0 && walletBurned !== existing.burned) {
        const freshBurnPts = Math.floor(walletBurned * 1.888);
        const ampBonus = existing.ampBonusPts ?? 0;
        const lwPts = existing.labWorkPts ?? 0;
        const updated: BurnerEntry = {
          ...existing,
          burned: walletBurned,
          txCount: walletTxCount ?? existing.txCount,
          points: freshBurnPts + ampBonus + lwPts,
        };
        return [...lb.entries.filter(e => e.address !== walletAddress), updated].sort((a, b) => b.points - a.points);
      }
      return lb.entries;
    }
    // Wallet not in leaderboard at all — add as burn-only entry
    if (!walletBurned || walletBurned <= 0) return lb.entries;
    const myEntry: BurnerEntry = {
      address: walletAddress, burned: walletBurned,
      points: Math.floor(walletBurned * 1.888),
      txCount: walletTxCount ?? 0,
    };
    return [...lb.entries, myEntry].sort((a, b) => b.points - a.points);
  }, [lb.entries, walletAddress, walletBurned, walletTxCount]);

  const top3    = entries.slice(0, 3); // kept for potential future use
  const myRank  = walletAddress ? entries.findIndex(e => e.address === walletAddress) + 1 || null : null;
  const myEntry = walletAddress ? (entries.find(e => e.address === walletAddress) ?? null) : null;

  // Network stats helpers — use live fetches where available
  const allEvents = entries.flatMap(e => e.events ?? []);
  const firstEvt  = allEvents.length ? allEvents.reduce((a,b) => a.blockTime < b.blockTime ? a : b) : firstEvtLive;
  const lastEvt   = lastEvtLive ?? (allEvents.length ? allEvents.reduce((a,b) => a.blockTime > b.blockTime ? a : b) : null);
  const burnedPct = globalBurned != null ? (globalBurned / 8_880_000) * 100 : 0;
  const circPct   = 100 - burnedPct;
  const fmtTs     = (ts: number) => new Date(ts*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const fmtTime   = (ts: number) => new Date(ts*1000).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});

  return (
    <FireCtx.Provider value={{ isF }}>
    <ThemeToggle themeName={themeName} onToggle={toggleTheme} t={t} isMobile={isMobile}/>
    <div style={{ marginBottom:32, animation:'lb-fade-up 0.5s ease 0.15s both' }}>

      {/* ══ NETWORK TOTALS PANEL — DIGITAL HQ DASHBOARD ══ */}
      <div style={{
        ...heroPanelStyle(20,isF),
        boxShadow:isF?'0 4px 40px rgba(0,0,0,.4)':'0 4px 40px rgba(0,0,0,.3)',
      }}>
        {/* ── DIGITAL BACKGROUND LAYERS ── */}
        <HeroBg intensity={1.0} />

        {/* ═══ FIRE HERO OVERLAY — minimal fire accents (fire only) ═══ */}
        {isF && <>
          {/* Radial fire bloom — subtle, static */}
          <div style={{ position:'absolute', top:'5%', left:'50%', transform:'translateX(-50%)', width:'70%', height:'60%', borderRadius:'50%', background:'radial-gradient(ellipse,rgba(255,34,34,.04) 0%,rgba(255,102,0,.02) 30%,transparent 60%)', pointerEvents:'none', zIndex:2 }} />
          {/* Bottom fire glow band — static */}
          <div style={{ position:'absolute', bottom:0, left:0, right:0, height:2, background:'linear-gradient(90deg,transparent 2%,#cc330022 15%,#ff440044 40%,#ff660055 50%,#ff440044 60%,#cc330022 85%,transparent 98%)', pointerEvents:'none', zIndex:10 }} />
        </>}

        {/* Extra: Diagonal energy traces (Vegas only; fire has these in HeroBg) */}
        {!isF && <><div style={{ position:'absolute', top:0, left:'10%', width:'40%', height:1, background:'linear-gradient(90deg,transparent,rgba(0,200,255,.05),rgba(140,60,255,.03),transparent)', transform:'rotate(25deg)', transformOrigin:'left top', pointerEvents:'none' }} />
        <div style={{ position:'absolute', top:'20%', right:'5%', width:'35%', height:1, background:'linear-gradient(90deg,transparent,rgba(255,140,0,.04),rgba(238,85,255,.03),transparent)', transform:'rotate(-15deg)', transformOrigin:'right top', pointerEvents:'none' }} /></>}
        {/* Extra: Ambient data orbs (Vegas only) */}
        {!isF && <><div style={{ position:'absolute', top:'8%', left:'2%', width:180, height:180, borderRadius:'50%', background:'radial-gradient(circle,rgba(0,200,255,.025) 0%,transparent 70%)', pointerEvents:'none' }} />
        <div style={{ position:'absolute', bottom:'5%', right:'5%', width:160, height:160, borderRadius:'50%', background:'radial-gradient(circle,rgba(238,85,255,.02) 0%,transparent 70%)', pointerEvents:'none' }} />
        <div style={{ position:'absolute', top:'45%', left:'55%', width:120, height:120, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,140,0,.018) 0%,transparent 70%)', pointerEvents:'none' }} />
        <div style={{ position:'absolute', top:'20%', right:'25%', width:90, height:90, borderRadius:'50%', background:'radial-gradient(circle,rgba(140,60,255,.018) 0%,transparent 70%)', pointerEvents:'none' }} /></>}

        {/* ── HEADER BAR ── */}
        <div style={{ position:'relative', zIndex:5, padding:isMobile?'18px 16px 14px':'22px 24px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:10, borderBottom:isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.1)', background:isF?'linear-gradient(90deg,rgba(255,34,34,.025),rgba(255,102,0,.015),rgba(255,187,51,.008),transparent)':'linear-gradient(90deg,rgba(140,60,255,.03),rgba(255,140,0,.02),rgba(57,255,136,.02),transparent)', overflow:'hidden' }}>
          {/* Fire header background layers (fire only) */}
          {isF && <>
            {/* Static fire gradient */}
            <div style={{ position:'absolute', inset:0, background:'linear-gradient(90deg,rgba(255,34,34,.02),rgba(255,102,0,.03),rgba(255,187,51,.02),rgba(255,102,0,.025),rgba(255,34,34,.015))', pointerEvents:'none' }} />
            {/* Bottom fire edge — static */}
            <div style={{ position:'absolute', bottom:0, left:0, right:0, height:2, background:'linear-gradient(90deg,transparent 5%,#ff222233 25%,#ff660055 50%,#ff222033 75%,transparent 95%)', pointerEvents:'none', zIndex:8 }} />
          </>}
          <div style={{ display:'flex', alignItems:'center', gap:16, position:'relative', zIndex:6 }}>
            {/* Orbital rings with BRAINS logo center — fire version has pulsing fire glow */}
            <div style={{ position:'relative', width:isMobile?48:58, height:isMobile?48:58, flexShrink:0 }}>
              {/* Fire ring glow behind orbital (fire only) */}
              {isF && <div style={{ position:'absolute', inset:-6, borderRadius:'50%', background:'radial-gradient(circle,rgba(255,34,34,.12) 0%,rgba(255,102,0,.06) 40%,transparent 70%)', pointerEvents:'none' }} />}
              {/* Outer ring */}
              <div style={{ position:'absolute', inset:0, borderRadius:'50%', border:isF?'1.5px solid rgba(255,34,34,.2)':'1.5px solid rgba(255,140,0,.12)', animation:'lb-spin 12s linear infinite' }}>
                <div style={{ position:'absolute', top:-2, left:'50%', width:4, height:4, borderRadius:'50%', background:isF?'#ff2222':'#ff9933', boxShadow:isF?'0 0 4px rgba(255,34,34,.3)':'0 0 3px rgba(255,153,51,.3)' }} />
              </div>
              {/* Mid ring */}
              <div style={{ position:'absolute', inset:6, borderRadius:'50%', border:isF?'1px solid rgba(255,102,0,.18)':'1px solid rgba(180,60,255,.1)', animation:'lb-spin 8s linear infinite reverse' }}>
                <div style={{ position:'absolute', bottom:-2, right:4, width:3, height:3, borderRadius:'50%', background:isF?'#ff6600':'#cc55ff', boxShadow:isF?'0 0 3px rgba(255,102,0,.3)':'0 0 2px rgba(204,85,255,.3)' }} />
              </div>
              {/* Inner ring */}
              <div style={{ position:'absolute', inset:12, borderRadius:'50%', border:isF?'1px solid rgba(255,187,51,.15)':'1px solid rgba(0,200,255,.08)', animation:'lb-spin 6s linear infinite' }}>
                <div style={{ position:'absolute', top:0, right:0, width:3, height:3, borderRadius:'50%', background:isF?'#ffbb33':'#00ccff', boxShadow:isF?'0 0 2px rgba(255,187,51,.3)':'0 0 2px rgba(0,204,255,.3)' }} />
              </div>
              {/* BRAINS token logo center */}
              <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}>
                <img src={BRAINS_LOGO} alt="BRAINS" style={{ width:isMobile?22:28, height:isMobile?22:28, borderRadius:'50%', objectFit:'cover', border:isF?'1.5px solid rgba(255,34,34,.4)':'1.5px solid rgba(255,140,0,.3)', boxShadow:isF?'0 0 6px rgba(255,34,34,.2)':'0 0 6px rgba(255,140,0,.15)', background:isF?'#0a090c':'#0a0a14' }} />
              </div>
            </div>
            <div>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?9:11, color:'#e8eef4', letterSpacing:3, marginBottom:4, textShadow:isF?'0 0 6px rgba(200,160,80,.15)':undefined }}>X1 BRAINS · 🧪 LAB WORK</div>
              {/* INCINERATOR PROTOCOL — fire mode gets flaming text effect */}
              <div key={`title-${themeName}`} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?16:22, fontWeight:900, letterSpacing:4, position:'relative', background:isF?'linear-gradient(90deg,#c83838,#c85030,#c87040,#d4a050,#e0d8d0,#d4b860,#c87040)':'linear-gradient(90deg,#5bb8d4,#9070b8,#c07ad4,#d4884f,#d4b84f)', backgroundSize:isF?'200% 100%':undefined, WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', filter:isF?'drop-shadow(0 0 6px rgba(255,34,34,.2))':'drop-shadow(0 0 5px rgba(140,60,255,.1))', animation:isF?'lb-grad-shift 6s ease infinite':undefined }}>
                INCINERATOR PROTOCOL
              </div>
              {/* Flame tips removed for cleaner look */}
              <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:isF?'#b8b0c0':'#7a99aa', letterSpacing:3, marginTop:isF?1:3 }}>
                ALL · TIME · ON · CHAIN
              </div>
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 14px', background:isF?'linear-gradient(135deg,rgba(255,187,51,.07),rgba(255,34,34,.04))':'linear-gradient(135deg,rgba(57,255,136,.06),rgba(140,60,255,.04))', border:isF?'1px solid rgba(255,187,51,.22)':'1px solid rgba(57,255,136,.15)', borderRadius:20 }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background:isF?'#ffbb33':'#39ff88', boxShadow:isF?'0 0 4px rgba(255,187,51,.3)':'0 0 4px rgba(57,255,136,.3)', animation:isF?'lb-fire-live 2s ease infinite':'lb-green-pulse 2s ease infinite' }} />
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:isF?'#ffffff':'#39ff88', letterSpacing:3, fontWeight:700, textShadow:isF?'0 0 8px #ffbb33':undefined }}>LIVE</span>
            </div>
            {lb.fetchedAt && <span style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:isF?'#b8b0c0':'#7a99aa', letterSpacing:1 }}>↻ {lb.fetchedAt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}
          </div>
        </div>

        {/* ── STAT CARDS GRID ── */}
        <div style={{ position:'relative', zIndex:5, display:'grid', gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)', borderBottom:isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(57,255,136,.06)' }}>
          {[
            { label:'TOTAL BURNED',   value: globalBurned != null ? Math.round(globalBurned).toLocaleString() : '——', sub:'BRAINS DESTROYED', usd: globalBurned != null && brainsPrice ? `$${(globalBurned * brainsPrice).toLocaleString(undefined,{maximumFractionDigits:0})} USD` : null, color:isF?'#c87040':'#d08050', grad:isF?'linear-gradient(135deg,#c85030,#c87040,#d4a050,#e8dcd0dd,#d4a050,#c87040)':'linear-gradient(135deg,#d4884f,#e8b870,#d4884f)', icon:'🔥', accent:isF?'rgba(255,102,0,.08)':'rgba(255,140,0,.08)', glow:isF?'rgba(255,102,0,.05)':'rgba(255,140,0,.04)', big:true },
            { label:'INITIAL SUPPLY', value:(8_880_000).toLocaleString(), sub:'GENESIS ALLOCATION', usd:null, color:isF?'#ff2222':'#ee55ff', grad:isF?'linear-gradient(135deg,#a82020,#c83838,#d07070,#e0d0c8cc,#d07070,#c83838)':'linear-gradient(135deg,#c07ad4,#d8a0e0,#a860c0)', icon:'◆',  accent:isF?'rgba(200,56,56,.04)':'rgba(238,85,255,.05)', glow:isF?'rgba(200,56,56,.03)':'rgba(238,85,255,.03)' },
            { label:'CIRCULATING',    value: globalSupply != null ? Math.round(globalSupply).toLocaleString() : '——', sub:'REMAINING SUPPLY', usd:null, color:isF?'#d4a050':'#78c8a0', grad:isF?'linear-gradient(135deg,#a87020,#d4a050,#d8b870,#e0d8d0cc,#d8b870,#d4a050)':'linear-gradient(135deg,#5ec99a,#88ddbb,#4db88a)', icon:'◈',  accent:isF?'rgba(212,160,80,.04)':'rgba(57,255,136,.05)', glow:isF?'rgba(255,187,51,.04)':'rgba(57,255,136,.03)' },
            { label:'BURN RATE',      value: globalBurned != null ? `${((globalBurned/8_880_000)*100).toFixed(3)}%` : '——', sub:'SUPPLY DESTROYED', usd:null, color:isF?'#ffdd44':'#00ccff', grad:isF?'linear-gradient(135deg,#a89020,#d4b860,#d8c880,#e0d8d0cc,#d8c880,#d4b860)':'linear-gradient(135deg,#5bb8d4,#7ec8dd,#4aa0bc)', icon:'📊', accent:isF?'rgba(255,221,68,.06)':'rgba(0,200,255,.05)', glow:isF?'rgba(255,221,68,.04)':'rgba(0,200,255,.03)' },
          ].map((s, i, arr) => (
            <div key={`stat-${i}-${themeName}`} style={{
              padding:isMobile?'20px 14px':'26px 18px', textAlign:'center', position:'relative', overflow:'hidden',
              borderRight: i < arr.length-1 && (!isMobile || i%2===0) ? (isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(57,255,136,.06)') : 'none',
              borderBottom: isMobile&&i<2?(isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(57,255,136,.06)'):'none',
              background: `linear-gradient(160deg, ${s.accent}, transparent 60%)`,
            }}>
              {/* Left edge glow line */}
              <div style={{ position:'absolute', left:0, top:0, bottom:0, width:1, background:`linear-gradient(180deg,transparent,${s.color}22,${s.color}44,${s.color}22,transparent)` }} />
              {/* Bottom gradient underline */}
              <div style={{ position:'absolute', bottom:0, left:'10%', right:'10%', height:1, background:`linear-gradient(90deg,transparent,${s.color}33,transparent)` }} />
              {/* Radial glow behind value */}
              <div style={{ position:'absolute', top:'30%', left:'50%', transform:'translate(-50%,-50%)', width:120, height:80, borderRadius:'50%', background:`radial-gradient(circle,${s.glow},transparent 70%)`, pointerEvents:'none' }} />
              {/* Heat shimmer (fire) / Shimmer sweep (vegas) */}
              <div style={{ position:'absolute', inset:0, background:`linear-gradient(90deg,transparent,${s.color}06,${isF?'rgba(255,255,255,.02),':''}transparent)`, backgroundSize:'300% 100%', animation:'none', pointerEvents:'none' }} />
              {/* Stat breathe pulse (fire only) */}
              {isF && <div style={{ position:'absolute', inset:0, background:`radial-gradient(ellipse at center,${s.color}04,transparent 60%)`, pointerEvents:'none' }} />}
              {/* Content */}
              <div style={{ position:'relative', zIndex:1 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:5, marginBottom:10 }}>
                  <span style={{ fontSize:13, filter:`drop-shadow(0 0 4px ${s.color}55)` }}>{s.icon}</span>
                  <span style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:s.color, letterSpacing:3, fontWeight:700 }}>{s.label}</span>
                </div>
                <div key={`val-${i}-${themeName}`} style={{ fontFamily:'Rajdhani, sans-serif', fontSize:s.big?(isMobile?24:32):(isMobile?20:26), fontWeight:900, lineHeight:1, letterSpacing:1, marginBottom:5, color:'#b8c4d0' }}>
                  {s.value === '——' ? (
                    <span style={{ display:'inline-block', width:isMobile?60:80, height:s.big?(isMobile?24:32):(isMobile?20:26), borderRadius:4, background:`linear-gradient(90deg, ${s.color}10 25%, ${s.color}20 50%, ${s.color}10 75%)`, backgroundSize:'200% 100%', animation:'lb-skel-shimmer 1.8s ease-in-out infinite', verticalAlign:'middle' }}>&nbsp;</span>
                  ) : s.value}
                </div>
                {s.usd && <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?13:16, fontWeight:900, marginBottom:5, marginTop:3, letterSpacing:1, padding:'5px 14px', background:isF?'linear-gradient(135deg,rgba(57,255,136,.08),rgba(0,200,255,.04))':'linear-gradient(135deg,rgba(57,255,136,.07),rgba(0,200,255,.03))', border:isF?'1px solid rgba(57,255,136,.18)':'1px solid rgba(57,255,136,.15)', borderRadius:8, display:'inline-block', color:'#39ff88', textShadow:'0 0 6px rgba(57,255,136,.2)' }}>{s.usd}</div>}
                <div style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#a0aab8', letterSpacing:2 }}>{s.sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── MARKET INTELLIGENCE ROW ── */}
        {(brainsPrice || marketData || lb.loading) && (
          <div style={{ position:'relative', zIndex:5, borderBottom:isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.06)' }}>
            <div style={{ padding:isMobile?'10px 14px 6px':'10px 20px 6px', display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:3 }}>📡 MARKET INTELLIGENCE</span>
              <div style={{ flex:1, height:1, background:isF?'linear-gradient(90deg,rgba(255,34,34,.15),rgba(255,102,0,.08),transparent)':'linear-gradient(90deg,rgba(140,60,255,.1),transparent)' }} />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:isMobile?'1fr 1fr':'1fr 1fr 1fr', gap:1 }}>
              {(() => {
                const p = brainsPrice ?? marketData?.price ?? null;
                const mc = marketData?.marketCap ?? (p && globalSupply ? p * globalSupply : null);
                const fdv = marketData?.fdv ?? (p ? p * 8_880_000 : null);
                const fmtUsd = (v:number) => v>=1e6?`$${(v/1e6).toFixed(2)}M`:v>=1e3?`$${(v/1e3).toFixed(1)}K`:v>=1?`$${v.toFixed(2)}`:v>=0.001?`$${v.toFixed(4)}`:`$${v.toFixed(6)}`;
                const items: {label:string;value:string|null;color:string;grad:string}[] = [
                  { label:'PRICE', value:p?fmtUsd(p):null, color:isF?'#d4a050':'#78c8a0', grad:isF?`linear-gradient(135deg,#ffbb33,#ffffffcc,#ffbb33)`:`linear-gradient(135deg,#39ff88,#66ffbb)` },
                  { label:'MKT CAP', value:mc?fmtUsd(mc):null, color:isF?'#ff6600':'#ee55ff', grad:isF?`linear-gradient(135deg,#ff6600,#ffffffbb,#ff6600)`:`linear-gradient(135deg,#ee55ff,#ff88ff)` },
                  { label:'FDV', value:fdv?fmtUsd(fdv):null, color:isF?'#cc3300':'#cc88ff', grad:isF?`linear-gradient(135deg,#cc3300,#ff8844,#ffffffaa,#ff8844,#cc3300)`:`linear-gradient(135deg,#cc88ff,#ee88ff)` },
                ];
                return items.map((it,i)=>(
                  <div key={`mkt-${i}-${themeName}`} style={{ padding:isMobile?'12px 8px':'14px 16px', textAlign:'center', borderLeft:i>0?`1px solid ${it.color}12`:'none', position:'relative', overflow:'hidden' }}>
                    <div style={{ position:'absolute', left:0, top:0, bottom:0, width:1, background:`linear-gradient(180deg,transparent,${it.color}22,transparent)` }} />
                    <div style={{ position:'absolute', top:'20%', left:'50%', transform:'translate(-50%,0)', width:80, height:50, borderRadius:'50%', background:`radial-gradient(circle,${it.color}04,transparent 70%)`, pointerEvents:'none' }} />
                    <div style={{ position:'absolute', inset:0, background:`linear-gradient(90deg,transparent,${it.color}03,transparent)`, backgroundSize:'300% 100%', animation:'none', pointerEvents:'none' }} />
                    <div style={{ position:'relative', zIndex:1 }}>
                      <div style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?7:8, color:it.color, letterSpacing:2, marginBottom:5 }}>{it.label}</div>
                      {it.value ? (
                        <div key={`mktv-${i}-${themeName}`} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?16:20, fontWeight:900, color:'#b8c4d0' }}>{it.value}</div>
                      ) : (
                        <div style={{ display:'flex', justifyContent:'center' }}><StatSkeleton width={isMobile?'60px':'80px'} isF={isF} /></div>
                      )}
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>
        )}

        {/* ── PRIZE VAULT ── */}
        {(() => {
          try {
            const cfgRaw = localStorage.getItem('brains_weekly_config');
            if (!cfgRaw) return null;
            const cfg = JSON.parse(cfgRaw);
            if (!cfg?.prizes || cfg.status === 'ended') return null;
            const allPrizes: {token:string;amount:number;isNFT?:boolean;nftName?:string;nftImage?:string;nftMint?:string}[] = [];
            for (const place of cfg.prizes) {
              if (!Array.isArray(place)) continue;
              for (const p of place) allPrizes.push(p);
            }
            if (allPrizes.length === 0) return null;
            // Aggregate tokens
            const tokenMap = new Map<string, number>();
            const nfts: {name:string;image?:string;mint?:string}[] = [];
            for (const p of allPrizes) {
              if (p.isNFT) { nfts.push({ name: p.nftName || 'NFT', image: p.nftImage, mint: p.nftMint }); }
              else { tokenMap.set(p.token, (tokenMap.get(p.token) || 0) + p.amount); }
            }
            const tokens = Array.from(tokenMap.entries());
            // USD value of BRAINS tokens
            const bp = brainsPrice ?? 0;
            const brainsTotal = tokenMap.get('BRAINS') || 0;
            const brainsUsd = brainsTotal * bp;
            const weekId = cfg.weekId || '';
            const challengeCount = cfg.challenges?.length || 0;

            return (
              <div style={heroPanelStyle(0,isF)}>
                <HeroBg intensity={0.6} accent={isF?"#ff6600":"#aa44ff"} />
                {/* Vault background glow */}
                <div style={{ position:'absolute', inset:0, background:isF?'linear-gradient(135deg, rgba(255,34,34,.025), rgba(255,102,0,.01), rgba(255,187,51,.01))':'linear-gradient(135deg, rgba(140,60,255,.025), rgba(57,255,136,.01), rgba(0,200,255,.01))', pointerEvents:'none' }} />
                <div style={{ position:'relative', zIndex:1, padding:isMobile?'16px 14px':'20px 24px' }}>
                  {/* Header */}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:22 }}>🏆</span>
                      <div>
                        <div key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?14:18, fontWeight:900, letterSpacing:3, background:isF?'linear-gradient(90deg,#ff2222,#ff6600,#ffbb33)':'linear-gradient(90deg,#cc88ff,#ee55ff,#ff9933)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>PRIZE VAULT</div>
                        <div style={{ fontFamily:'Sora, sans-serif', fontSize:7, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2, marginTop:2 }}>
                          {weekId.toUpperCase()} · {challengeCount} CHALLENGE{challengeCount!==1?'S':''} · TOP 3 WINNERS
                        </div>
                      </div>
                    </div>
                    {brainsUsd > 0 && (
                      <div style={{ textAlign:'right' }}>
                        <div style={{ fontFamily:'Sora, sans-serif', fontSize:7, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2 }}>TOTAL VAULT VALUE</div>
                        <div key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?18:24, fontWeight:900, background:isF?'linear-gradient(135deg,#ffbb33,#ffffffcc,#ffbb33)':'linear-gradient(135deg,#5ec99a,#88ddb8,#4db88a)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', filter:isF?'drop-shadow(0 0 4px rgba(255,187,51,.15))':'drop-shadow(0 0 4px rgba(57,255,136,.12))' }}>
                          ≈ ${brainsUsd >= 1000 ? `${(brainsUsd/1000).toFixed(1)}K` : brainsUsd >= 1 ? brainsUsd.toFixed(2) : brainsUsd.toFixed(4)}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Prize breakdown by place */}
                  <div style={{ display:'grid', gridTemplateColumns:isMobile?'1fr':'1fr 1fr 1fr', gap:isMobile?8:12 }}>
                    {[0,1,2].map(place => {
                      const placeItems = Array.isArray(cfg.prizes[place]) ? cfg.prizes[place] : [];
                      if (placeItems.length === 0) return (
                        <div key={place} style={{ padding:'14px 12px', background:'rgba(255,255,255,.01)', border:'1px solid rgba(255,255,255,.04)', borderRadius:10, textAlign:'center', opacity:0.4 }}>
                          <div style={{ fontFamily:'Sora, sans-serif', fontSize:9, color:isF?'#6a5e78':'#556677', letterSpacing:2 }}>{['🥇 1ST','🥈 2ND','🥉 3RD'][place]}</div>
                          <div style={{ fontFamily:'Sora, sans-serif', fontSize:10, color:'#445566', marginTop:6 }}>No prize set</div>
                        </div>
                      );
                      const cl = isF?['#ff2222','#ff6600','#ffbb33'][place]:['#ffd700','#cc88ff','#39ff88'][place];
                      const placeTokens = placeItems.filter((p:any) => !p.isNFT);
                      const placeNfts = placeItems.filter((p:any) => p.isNFT);
                      const placeBrainsUsd = placeTokens.filter((p:any)=>p.token==='BRAINS').reduce((s:number,p:any)=>s+p.amount*bp,0);
                      return (
                        <div key={place} style={{ padding:'14px 12px', background:`${cl}06`, border:`1px solid ${cl}18`, borderTop:`3px solid ${cl}`, borderRadius:10, position:'relative', overflow:'hidden' }}>
                          {/* Place label */}
                          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                            <div style={{ fontFamily:'Orbitron, monospace', fontSize:11, fontWeight:700, color:cl, letterSpacing:2 }}>{['🥇 1ST PLACE','🥈 2ND PLACE','🥉 3RD PLACE'][place]}</div>
                            {placeBrainsUsd > 0 && <span style={{ fontFamily:'Sora, sans-serif', fontSize:9, color:isF?'#d4a050':'#78c8a0', fontWeight:700, textShadow:'0 0 6px rgba(57,255,136,.3)' }}>≈ ${placeBrainsUsd >= 1 ? placeBrainsUsd.toFixed(2) : placeBrainsUsd.toFixed(4)}</span>}
                          </div>
                          {/* Tokens */}
                          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                            {placeTokens.map((p:any, j:number) => {
                              const tkC = p.token === 'BRAINS' ? '#ff9933' : p.token === 'XNM' ? (isF?'#ffbb33':'#39ff88') : p.token === 'XUNI' ? (isF?'#ffdd44':'#00e5ff') : p.token === 'XBLK' ? (isF?'#ff6600':'#b388ff') : p.token === 'XNT' ? (isF?'#ff2222':'#00ccff') : '#e0e8f0';
                              return (
                                <div key={j} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'rgba(0,0,0,.2)', borderRadius:8, border:`1px solid ${tkC}15` }}>
                                  <img src={p.token === 'BRAINS' ? BRAINS_LOGO : `https://explorer.xenblocks.io/tokens/${p.token.toLowerCase()}.png`}
                                    alt="" style={{ width:20, height:20, borderRadius:'50%', objectFit:'cover', border:`1px solid ${tkC}44`, background:'#111820' }}
                                    onError={(e:any) => { e.target.style.display = 'none'; }} />
                                  <div style={{ flex:1 }}>
                                    <div style={{ fontFamily:'Orbitron, monospace', fontSize:13, fontWeight:800, color:tkC }}>{Number(p.amount).toLocaleString()}</div>
                                  </div>
                                  <span style={{ fontFamily:'Sora, sans-serif', fontSize:9, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:1 }}>{p.token}</span>
                                </div>
                              );
                            })}
                            {/* NFTs */}
                            {placeNfts.map((p:any, j:number) => (
                              <div key={`nft-${j}`} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'rgba(255,215,0,.04)', borderRadius:8, border:'1px solid rgba(255,215,0,.12)' }}>
                                {p.nftImage ? (
                                  <img src={p.nftImage} alt="" style={{ width:28, height:28, borderRadius:6, objectFit:'cover', border:'1px solid rgba(255,215,0,.3)' }} />
                                ) : (
                                  <div style={{ width:28, height:28, borderRadius:6, background:'rgba(255,215,0,.08)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14 }}>🖼️</div>
                                )}
                                <div style={{ flex:1 }}>
                                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:10, fontWeight:700, color:'#ee99ff' }}>{p.nftName || 'NFT'}</div>
                                  {p.nftMint && <div style={{ fontFamily:'monospace', fontSize:7, color:isF?'#6a5e78':'#556677' }}>{p.nftMint.slice(0,6)}…{p.nftMint.slice(-4)}</div>}
                                </div>
                                <span style={{ fontFamily:'Sora, sans-serif', fontSize:8, color:'#ffd700', padding:'2px 6px', background:'rgba(255,215,0,.08)', borderRadius:4 }}>NFT</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Total combined assets */}
                  {(tokens.length > 0 || nfts.length > 0) && (
                    <div style={{ marginTop:12, padding:'10px 14px', background:'rgba(0,0,0,.15)', borderRadius:8, border:'1px solid rgba(255,215,0,.06)', display:'flex', alignItems:'center', justifyContent:'center', gap:isMobile?8:16, flexWrap:'wrap' }}>
                      <span style={{ fontFamily:'Sora, sans-serif', fontSize:7, color:isF?'#ff9966':'#aa88cc', letterSpacing:2, textShadow:isF?'0 0 6px rgba(255,34,34,.2)':'0 0 6px rgba(140,60,255,.2)' }}>VAULT TOTAL:</span>
                      {tokens.map(([tk, amt], i) => {
                        const tkC = tk === 'BRAINS' ? '#ff9933' : tk === 'XNM' ? (isF?'#ffbb33':'#39ff88') : tk === 'XNT' ? (isF?'#ff2222':'#00ccff') : '#e0e8f0';
                        return <span key={i} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?10:12, fontWeight:800, color:tkC }}>{Number(amt).toLocaleString()} {tk}</span>;
                      })}
                      {nfts.length > 0 && <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?10:12, fontWeight:800, color:'#ee99ff' }}>{nfts.length} NFT{nfts.length>1?'s':''}</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          } catch { return null; }
        })()}

        {/* ── RUN INCINERATOR ENGINE — CTA BANNER ── */}
        <div
          onClick={e => {
            // Click flash animation before navigating
            const el = e.currentTarget;
            el.style.transition = 'none';
            el.style.boxShadow = '0 4px 30px rgba(0,0,0,.35)';
            el.style.transform = 'scale(0.98)';
            el.style.borderColor = isF?'rgba(255,187,51,.8)':'rgba(57,255,136,.7)';
            // Flash the background lighter
            el.style.background = isF
              ?'linear-gradient(160deg,#121010 0%,#1a1210 40%,#121010 80%,#0e0c0c 100%)'
              :'linear-gradient(160deg,#14102a 0%,#1a1232 40%,#100c20 80%,#0a0816 100%)';
            setTimeout(() => {
              el.style.transition = 'all 0.3s ease';
              el.style.transform = 'scale(1.02)';
              setTimeout(() => { try { window.location.href = '/incinerator-engine'; } catch {} }, 200);
            }, 120);
          }}
          style={{
            position:'relative', overflow:'hidden', cursor:'pointer',
            margin:'16px 0', borderRadius:18,
            background:isF
              ?'linear-gradient(160deg,#0a0a0c 0%,#0c0b0e 40%,#0a0a0c 80%,#080808 100%)'
              :'linear-gradient(160deg,#0c0618 0%,#100a22 40%,#0a0516 80%,#06030e 100%)',
            border:isF?'1px solid rgba(255,102,0,.2)':'1px solid rgba(255,140,0,.15)',
            padding: isMobile ? '22px 18px' : '28px 32px',
            transition:'all 0.35s cubic-bezier(.4,0,.2,1)',
            boxShadow:'0 4px 30px rgba(0,0,0,.3)',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget;
            el.style.border = isF?'1px solid rgba(255,102,0,.35)':'1px solid rgba(57,255,136,.25)';
            el.style.boxShadow = '0 8px 40px rgba(0,0,0,.35)';
            el.style.transform = 'translateY(-2px)';
            el.style.background = isF
              ?'linear-gradient(160deg,#0e0c0e 0%,#100e10 40%,#0e0c0e 80%,#0a0a0a 100%)'
              :'linear-gradient(160deg,#100820 0%,#140e28 40%,#0c071a 80%,#080410 100%)';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget;
            el.style.border = isF?'1px solid rgba(255,102,0,.2)':'1px solid rgba(255,140,0,.15)';
            el.style.boxShadow = '0 4px 30px rgba(0,0,0,.3)';
            el.style.transform = 'translateY(0)';
            el.style.background = isF
              ?'linear-gradient(160deg,#0a0a0c 0%,#0c0b0e 40%,#0a0a0c 80%,#080808 100%)'
              :'linear-gradient(160deg,#0c0618 0%,#100a22 40%,#0a0516 80%,#06030e 100%)'
          }}
        >
          {/* Hover shimmer sweep — hidden by default, shown on hover via CSS */}
          <div className="cta-shimmer" style={{ position:'absolute', top:0, left:'-100%', width:'60%', height:'100%', background:isF?'linear-gradient(90deg,transparent,rgba(255,102,0,.04),rgba(255,187,51,.06),rgba(255,102,0,.04),transparent)':'linear-gradient(90deg,transparent,rgba(140,60,255,.03),rgba(57,255,136,.04),rgba(140,60,255,.03),transparent)', transform:'skewX(-15deg)', pointerEvents:'none', transition:'left 0.6s ease', zIndex:3 }} />
          {/* Ambient radial glow */}
          <div style={{ position:'absolute', top:'50%', left:isMobile?'15%':'10%', width:isMobile?180:260, height:isMobile?180:260, transform:'translate(-50%,-50%)', borderRadius:'50%', background:isF?'radial-gradient(circle,rgba(255,34,34,.03) 0%,transparent 70%)':'radial-gradient(circle,rgba(255,100,0,.04) 0%,transparent 70%)', pointerEvents:'none', filter:'blur(20px)' }} />
          {/* Right side glow */}
          <div style={{ position:'absolute', top:'50%', right:'-5%', width:200, height:200, transform:'translateY(-50%)', borderRadius:'50%', background:isF?'radial-gradient(circle,rgba(255,102,0,.02) 0%,transparent 70%)':'radial-gradient(circle,rgba(140,60,255,.03) 0%,transparent 70%)', pointerEvents:'none', filter:'blur(30px)' }} />
          {/* Top edge highlight */}
          <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1, background:isF?'linear-gradient(90deg,transparent,rgba(255,102,0,.12),rgba(255,34,34,.08),transparent)':'linear-gradient(90deg,transparent,rgba(255,140,0,.12),rgba(238,85,255,.08),transparent)', pointerEvents:'none' }} />
          {/* Fire: bottom fire edge */}
          {isF && <div style={{ position:'absolute', bottom:0, left:'5%', right:'5%', height:2, background:'linear-gradient(90deg,transparent,#ff222233,#ff440044,#ff660055,#ffbb3344,#ff660044,#ff222033,transparent)', backgroundSize:'200% 100%', animation:'lb-fire-border 3s ease infinite', pointerEvents:'none' }} />}

          <div style={{ position:'relative', zIndex:1, display:'flex', alignItems:'center', gap:isMobile?14:24 }}>

            {/* ── Reactor Core with orbiting nodes ── */}
            <div style={{ position:'relative', width:isMobile?70:96, height:isMobile?70:96, flexShrink:0 }}>
              {/* Outer orbit ring with nodes */}
              <div style={{ position:'absolute', inset:0, borderRadius:'50%', border:isF?'1px solid rgba(255,102,0,.1)':'1px solid rgba(255,140,0,.08)', animation:'lb-spin 12s linear infinite' }}>
                {[0,90,180,270].map(deg => (
                  <div key={deg} style={{ position:'absolute', width:5, height:5, borderRadius:'50%', background:isF?'#ff4400':'#ff9933', boxShadow:isF?'0 0 3px rgba(255,68,0,.2)':'0 0 3px rgba(255,140,0,.2)', top:`${50+45*Math.sin(deg*Math.PI/180)}%`, left:`${50+45*Math.cos(deg*Math.PI/180)}%`, transform:'translate(-50%,-50%)' }} />
                ))}
              </div>
              {/* Middle orbit ring */}
              <div style={{ position:'absolute', inset:isMobile?10:14, borderRadius:'50%', border:isF?'1px solid rgba(255,34,34,.1)':'1px solid rgba(140,60,255,.1)', animation:'lb-spin 7s linear infinite reverse' }}>
                {[60,180,300].map(deg => (
                  <div key={deg} style={{ position:'absolute', width:4, height:4, borderRadius:'50%', background:isF?'#ff2222':'#cc66ff', boxShadow:isF?'0 0 3px rgba(255,34,34,.2)':'0 0 3px rgba(140,60,255,.2)', top:`${50+45*Math.sin(deg*Math.PI/180)}%`, left:`${50+45*Math.cos(deg*Math.PI/180)}%`, transform:'translate(-50%,-50%)' }} />
                ))}
              </div>
              {/* Inner orbit ring */}
              <div style={{ position:'absolute', inset:isMobile?20:28, borderRadius:'50%', border:isF?'1px solid rgba(255,187,51,.08)':'1px solid rgba(57,255,136,.06)', animation:'lb-spin 4.5s linear infinite' }}>
                {[0,120,240].map(deg => (
                  <div key={deg} style={{ position:'absolute', width:3, height:3, borderRadius:'50%', background:isF?'#ffbb33':'#39ff88', boxShadow:isF?'0 0 2px rgba(255,187,51,.2)':'0 0 2px rgba(57,255,136,.2)', top:`${50+45*Math.sin(deg*Math.PI/180)}%`, left:`${50+45*Math.cos(deg*Math.PI/180)}%`, transform:'translate(-50%,-50%)' }} />
                ))}
              </div>
              {/* Core glow */}
              <div style={{ position:'absolute', inset:isMobile?18:24, borderRadius:'50%', background:isF?'radial-gradient(circle,rgba(255,34,34,.06) 0%,rgba(255,102,0,.02) 50%,transparent 80%)':'radial-gradient(circle,rgba(255,100,0,.08) 0%,rgba(255,60,0,.03) 50%,transparent 80%)' }} />
              {/* Center fire icon */}
              <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:isMobile?24:32, filter:isF?'drop-shadow(0 0 4px rgba(255,34,34,.2))':'drop-shadow(0 0 4px rgba(255,100,0,.25))' }}>🔥</div>
            </div>

            {/* ── Text block ── */}
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?7:8, color:isF?'#c87040':'#d08050', letterSpacing:isMobile?3:5, marginBottom:6 }}>
                ⚡ INCINERATOR PROTOCOL
              </div>
              <div key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?15:24, fontWeight:900, letterSpacing:isMobile?1:3, lineHeight:1.15, background:isF?'linear-gradient(90deg,#c83838,#c85030,#c87040,#d4a050,#e0d8d0cc,#d4a050)':'linear-gradient(90deg,#ff7700,#ff44ff,#ffaa33,#39ff88)', backgroundSize:isF?'200% 100%':undefined, WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', filter:isF?'drop-shadow(0 0 5px rgba(255,34,34,.15))':'drop-shadow(0 0 5px rgba(255,140,0,.15))', animation:isF?'lb-grad-shift 5s ease infinite':undefined }}>
                RUN INCINERATOR ENGINE
              </div>
              <div style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?8:10, color:isF?'#b8b0c0':'#9ab0be', marginTop:6, letterSpacing:.5 }}>
                Burn BRAINS · Earn LB Points · Preview AMP Bonus · Win Prizes
              </div>
            </div>

            {/* ── Launch button — animated border orbital style ── */}
            <div style={{ position:'relative', flexShrink:0, width:isMobile?60:80, height:isMobile?60:80 }}>
              {/* Outer spinning ring — conic gradient border */}
              <div style={{
                position:'absolute', inset:-3, borderRadius:'50%',
                border:'2px solid transparent',
                background:isF
                  ?'linear-gradient(#0a0a0c,#0a0a0c) padding-box, conic-gradient(from 0deg, #ff2222, #ff4400, #ff6600, #ffbb33, #ff6600, #ff2222) border-box'
                  :'linear-gradient(#0c0618,#0c0618) padding-box, conic-gradient(from 0deg, #39ff88, #00ddaa, #aa44ff, #ff9933, #39ff88) border-box',
                animation:'lb-spin 4s linear infinite',
              }} />
              {/* Middle ring — reverse spin */}
              <div style={{
                position:'absolute', inset:3, borderRadius:'50%',
                border:isF?'1px solid rgba(255,34,34,.1)':'1px solid rgba(57,255,136,.1)',
                animation:'lb-spin 6s linear infinite reverse',
              }}>
                {[0,120,240].map(deg => (
                  <div key={deg} style={{ position:'absolute', width:3, height:3, borderRadius:'50%', background:isF?'#ff4400':'#39ff88', boxShadow:isF?'0 0 2px rgba(255,68,0,.2)':'0 0 2px rgba(57,255,136,.2)', top:`${50+44*Math.sin(deg*Math.PI/180)}%`, left:`${50+44*Math.cos(deg*Math.PI/180)}%`, transform:'translate(-50%,-50%)' }} />
                ))}
              </div>
              {/* Inner glow core */}
              <div style={{
                position:'absolute', inset:8, borderRadius:'50%',
                background:isF?'radial-gradient(circle, rgba(255,34,34,.04) 0%, transparent 75%)':'radial-gradient(circle, rgba(57,255,136,.05) 0%, transparent 75%)',
              }} />
              {/* Center content */}
              <div style={{
                position:'absolute', inset:0, display:'flex', flexDirection:'column',
                alignItems:'center', justifyContent:'center', gap:1,
              }}>
                <span style={{ fontSize:isMobile?16:20, filter:isF?'drop-shadow(0 0 3px rgba(255,34,34,.2))':'drop-shadow(0 0 3px rgba(57,255,136,.2))' }}>🔥</span>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?5:6, fontWeight:900, color:isF?'#ff6600':'#39ff88', letterSpacing:2 }}>LAUNCH</span>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* ══ MY SCORE CARD ══ */}
      {walletAddress && (
        <MyScoreCard entry={myEntry} rank={myRank} total={entries.length} isMobile={isMobile} walletAddress={walletAddress} brainsPrice={brainsPrice} />
      )}

      {/* ══ GLOBAL LEADERBOARD BANNER ══ */}
      {entries.length > 0 && (
        <div style={heroPanelStyle(20,isF)}>
          <HeroBg intensity={0.7} />
          <div style={{ position:'relative', zIndex:1, padding:isMobile?'20px 14px':'26px 24px', textAlign:'center' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:10, marginBottom:10 }}>
              <span style={{ fontSize:24 }}>🌐</span>
              <div key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?16:22, fontWeight:900, letterSpacing:4, background:isF?'linear-gradient(90deg,#ff2222,#ff4400,#ff6600,#ffffffcc,#ffbb33,#ffdd44)':'linear-gradient(90deg,#00ccff,#aa44ff,#ee55ff,#ff9933)', backgroundSize:isF?'200% 100%':undefined, WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', filter:isF?'drop-shadow(0 0 4px rgba(255,34,34,.1))':'drop-shadow(0 0 4px rgba(140,60,255,.08))', animation:isF?'lb-grad-shift 5s ease infinite':undefined }}>
                GLOBAL LEADERBOARD
              </div>
            </div>
            <div style={{ fontFamily:'Sora, sans-serif', fontSize:11, color:isF?'#b8b0c0':'#b0bcc8', marginBottom:16 }}>
              All-time burn rankings across all wallets on the X1 BRAINS Incinerator Protocol.
            </div>
            <div style={{ display:'flex', justifyContent:'center', gap:16, flexWrap:'wrap' }}>
              {[
                { label:'WALLETS', value:String(entries.length), color:isF?'#d4a050':'#78c8a0', accent:isF?'rgba(212,160,80,.04)':'rgba(57,255,136,.06)' },
                { label:'BURNED', value:globalBurned != null ? (globalBurned >= 1e6 ? `${(globalBurned/1e6).toFixed(2)}M` : Math.round(globalBurned).toLocaleString()) : '—', color:'#ff9933', accent:'rgba(255,140,0,.06)' },
                ...(brainsPrice != null && globalBurned != null ? [{ label:'VALUE', value:`$${(globalBurned * brainsPrice).toLocaleString(undefined,{maximumFractionDigits:0})}`, color:isF?'#d4a050':'#78c8a0', accent:isF?'rgba(212,160,80,.04)':'rgba(57,255,136,.06)' }] : []),
              ].map((s,i) => (
                <div key={i} style={{ padding:'8px 18px', background:s.accent, border:`1px solid ${s.color}22`, borderRadius:10 }}>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2 }}>{s.label} </span>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:16, fontWeight:800, color:s.color }}>{s.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}


      {/* ══ BURN LEADERBOARD DIVIDER ══ */}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20, marginTop:24 }}>
        <div style={{ flex:1, height:1, background:isF?'linear-gradient(90deg,transparent,#ff222244,#ff440044,#ff660044,#ffbb3344)':'linear-gradient(90deg,transparent,#00ccff44,#aa44ff44,#ff993344)' }} />
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 18px', background:isF?'linear-gradient(135deg,rgba(255,34,34,.06),rgba(255,102,0,.04))':'linear-gradient(135deg,rgba(140,60,255,.06),rgba(238,85,255,.04))', border:isF?'1px solid rgba(255,34,34,.18)':'1px solid rgba(140,60,255,.15)', borderRadius:24 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:isF?'#ff2222':'#00ccff', boxShadow:isF?'0 0 10px #ff2222':'0 0 8px #00ccff', animation:isF?'lb-fire-live 2s ease infinite':'lb-green-pulse 2s ease infinite' }} />
          <span key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:10, letterSpacing:4, fontWeight:700, background:isF?'linear-gradient(90deg,#ff2222,#ff6600,#ffffffaa,#ffbb33)':'linear-gradient(90deg,#00ccff,#aa44ff,#ee55ff)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', filter:isF?'drop-shadow(0 0 8px rgba(255,34,34,.3))':undefined }}>BURN LEADERBOARD</span>
          <div style={{ width:6, height:6, borderRadius:'50%', background:isF?'#ffbb33':'#ff9933', boxShadow:isF?'0 0 8px #ffbb33':'0 0 8px #ff9933', animation:isF?'lb-fire-node 2s ease 0.6s infinite':'lb-pulse 2s ease 0.6s infinite' }} />
        </div>
        <div style={{ flex:1, height:1, background:isF?'linear-gradient(90deg,#ffbb3344,#ff660044,#ff440044,#ff222244,transparent)':'linear-gradient(90deg,#ff993344,#ee55ff44,#aa44ff44,transparent)' }} />
      </div>

      {/* ══ TOP 3 PODIUM ══ */}
      {top3.length > 0 && (
        <div style={heroPanelStyle(20,isF)}>
          <HeroBg intensity={0.5} accent={isF?"#ff6600":"#aa44ff"} />
          <div style={{ position:'relative', zIndex:1, padding:isMobile?'12px 8px':'16px 18px' }}>
          <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?8:9, color:isF?'#f0ecf4':'#c8dce8', letterSpacing:3, marginBottom:10, display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ fontSize:12 }}>🏆</span>
            <span key={isF?'f':'v'} style={{ background:'linear-gradient(90deg,#ffd700,#ff9933)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', fontWeight:700 }}>PODIUM · TOP 3 WALLETS</span>
          </div>
          {!podiumReady ? (
            <PodiumSkeleton isMobile={isMobile} />
          ) : (
            <div style={{ display:'flex', gap:isMobile?6:10, alignItems:'flex-end', overflowX:isMobile?'auto':'visible', overflowY:'visible', WebkitOverflowScrolling:'touch', paddingBottom:isMobile?4:0, scrollSnapType:isMobile?'x mandatory':'none' }}>
              {[
                top3[1] ? { e:top3[1], r:2 } : null,
                top3[0] ? { e:top3[0], r:1 } : null,
                top3[2] ? { e:top3[2], r:3 } : null,
              ].map((item, i) => item ? (
                <div key={item.e.address} style={{ flex:isMobile?'0 0 42%':'1', minWidth:isMobile?140:undefined, display:'flex', animation:`lb-podium-in 0.6s cubic-bezier(.34,1.56,.64,1) ${0.12*i}s both`, scrollSnapAlign:isMobile?'start':'none' }}>
                  <PodiumCard entry={item.e} rank={item.r}
                    isYou={item.e.address===walletAddress} isMobile={isMobile} delay={0}
                    onShowDetail={() => setPodiumPopup({ entry: item.e, rank: item.r })} />
                </div>
              ) : (
                <div key={i} style={{
                  flex:isMobile?'0 0 42%':'1', minWidth:isMobile?140:undefined, position:'relative', overflow:'hidden',
                  background:'linear-gradient(160deg,#06040e,#08060f)',
                  border:'1px dashed rgba(120,60,255,.15)', borderRadius:12,
                  minHeight: i===1 ? (isMobile?180:320) : (isMobile?160:280),
                  display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:10,
                  padding: isMobile?'10px 8px':'16px 14px',
                }}>
                  <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(100,60,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.02) 1px,transparent 1px)', backgroundSize:'24px 24px', pointerEvents:'none' }} />
                  {/* Spinning ring placeholder */}
                  <div style={{ position:'relative', width: isMobile?60:80, height: isMobile?60:80 }}>
                    <div style={{ position:'absolute', inset:0, borderRadius:'50%', border:'2px solid transparent', borderTopColor:isF?'rgba(255,34,34,.4)':'rgba(140,60,255,.4)', borderRightColor:isF?'rgba(200,56,56,.10)':'rgba(140,60,255,.15)', animation:'lb-spin 1.2s linear infinite' }} />
                    <div style={{ position:'absolute', inset:4, borderRadius:'50%', border:'2px solid transparent', borderBottomColor:isF?'rgba(255,34,34,.3)':'rgba(57,255,136,.3)', borderLeftColor:isF?'rgba(200,56,56,.08)':'rgba(57,255,136,.1)', animation:'lb-spin 2s linear infinite reverse' }} />
                    <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <span style={{ fontSize: isMobile?18:24, opacity:.3, animation:'lb-pulse 2s ease infinite' }}>☠️</span>
                    </div>
                  </div>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'rgba(255,34,34,.4)':'rgba(140,60,255,.4)', letterSpacing:3, animation:'lb-pulse 2s ease infinite' }}>AWAITING DATA</div>
                </div>
              ))}
            </div>
          )}
        </div>
        </div>
      )}

      {/* ══ ALL-TIME 🧪 LAB WORK PANEL ══ */}
      <div style={heroPanelStyle(20,isF)}>
        <HeroBg intensity={0.5} accent={isF?"#ffbb33":"#39ff88"} />
{/* Header */}
        <div style={{ position:'relative', zIndex:2, display:'flex', alignItems:'center', justifyContent:'space-between', padding:isMobile?'14px 14px':'16px 22px', background:'linear-gradient(90deg,rgba(140,60,255,.04),rgba(238,85,255,.02),rgba(255,140,0,.02),transparent)', borderBottom:isF?'1px solid rgba(255,34,34,.06)':'1px solid rgba(140,60,255,.08)', flexWrap:'wrap', gap:8 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 10px', background:isF?'linear-gradient(135deg,rgba(255,187,51,.06),rgba(255,34,34,.04))':'linear-gradient(135deg,rgba(57,255,136,.06),rgba(0,200,255,.04))', border:isF?'1px solid rgba(255,187,51,.15)':'1px solid rgba(57,255,136,.15)', borderRadius:16 }}>
              <div style={{ width:5, height:5, borderRadius:'50%', background:isF?'#ffbb33':'#39ff88', animation:isF?'lb-fire-live 1.6s ease infinite':'lb-green-pulse 1.6s ease infinite' }} />
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:isF?'#d4a050':'#78c8a0', letterSpacing:2 }}>LIVE</span>
            </div>
            <div style={{ width:1, height:14, background:isF?'rgba(200,56,56,.08)':'rgba(140,60,255,.12)' }} />
            <span key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?11:13, fontWeight:700, letterSpacing:3, background:isF?'linear-gradient(90deg,#ffffff,#ff6600)':'linear-gradient(90deg,#ffffff,#cc88ff)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>{showAll ? 'ALL-TIME 🧪 LAB WORK' : 'LB POINTS LEADERBOARD'}</span>
            {entries.length > 0 && (
              <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:isF?'#d4a050':'#78c8a0', background:'rgba(57,255,136,.06)', border:isF?'1px solid rgba(255,34,34,.12)':'1px solid rgba(57,255,136,.12)', padding:'2px 8px', borderRadius:10 }}>
                {entries.length} WALLETS
              </span>
            )}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            {lb.loading && entries.length > 0 && (
              <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                <div style={{ width:10, height:10, border:isF?'1.5px solid rgba(255,102,0,.2)':'1.5px solid rgba(140,60,255,.2)', borderTop:isF?'1.5px solid #ff6600':'1.5px solid #aa44ff', borderRadius:'50%', animation:'lb-spin .7s linear infinite' }} />
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#ff6600':'#cc88ff', letterSpacing:1 }}>UPDATING</span>
              </div>
            )}
            {lb.fetchedAt && <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:isF?'#b8b0c0':'#7a99aa', letterSpacing:1 }}>↻ {lb.fetchedAt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}
            <button onClick={() => load(true)} disabled={lb.loading} style={{ background:'rgba(57,255,136,.06)', border:'1px solid rgba(57,255,136,.15)', color:isF?'#d4a050':'#78c8a0', padding:'5px 14px', fontFamily:'Orbitron, monospace', fontSize:8, letterSpacing:2, borderRadius:8, cursor:lb.loading?'not-allowed':'pointer', opacity:lb.loading?.5:1, transition:'all 0.15s' }}>↺ REFRESH</button>
          </div>
        </div>

        {/* Sort / Filter bar */}
        {entries.length > 0 && (
          <div style={{ position:'relative', zIndex:2, padding:isMobile?'8px 14px':'10px 22px', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', borderBottom:isF?'1px solid rgba(255,34,34,.05)':'1px solid rgba(140,60,255,.05)' }}>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2 }}>VIEW:</span>
            {([['all','🌐 ALL'],['burners','🔥 BURNERS'],['labwork','🧪 LAB WORK'],['weekly','⚡ WEEKLY']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setLbView(key)} style={{
                background: lbView===key ? (key==='labwork'?'rgba(0,204,255,.12)':key==='weekly'?'rgba(255,140,0,.12)':isF?'rgba(212,160,80,.08)':'rgba(57,255,136,.12)') : (isF?'rgba(200,56,56,.03)':'rgba(140,60,255,.04)'),
                border: `1px solid ${lbView===key ? (key==='labwork'?'rgba(0,204,255,.3)':key==='weekly'?'rgba(255,140,0,.3)':isF?'rgba(212,160,80,.2)':'rgba(57,255,136,.3)') : (isF?'rgba(200,56,56,.08)':'rgba(140,60,255,.1)')}`,
                color: lbView===key ? (key==='labwork'?'#00ccff':key==='weekly'?'#ff9933':isF?'#ffbb33':'#39ff88') : (isF?'#a89cb0':'#8ebbcc'),
                padding:'4px 12px', fontFamily:'Orbitron, monospace', fontSize:8, letterSpacing:1,
                borderRadius:6, cursor:'pointer', transition:'all 0.15s',
              }}>{label}</button>
            ))}
            <div style={{ width:1, height:14, background:isF?'rgba(200,56,56,.08)':'rgba(140,60,255,.1)' }} />
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2 }}>SORT:</span>
            {([['points','⚡ LB PTS'],['burned','🔥 BURNED'],['wallet','🔗 WALLET']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setLbSort(key)} style={{
                background: lbSort===key ? (isF?'rgba(212,160,80,.08)':'rgba(57,255,136,.12)') : (isF?'rgba(200,56,56,.03)':'rgba(140,60,255,.04)'),
                border: `1px solid ${lbSort===key ? (isF?'rgba(212,160,80,.2)':'rgba(57,255,136,.3)') : (isF?'rgba(200,56,56,.08)':'rgba(140,60,255,.1)')}`,
                color: lbSort===key ? (isF?'#ffbb33':'#39ff88') : (isF?'#a89cb0':'#8ebbcc'),
                padding:'4px 12px', fontFamily:'Orbitron, monospace', fontSize:8, letterSpacing:1,
                borderRadius:6, cursor:'pointer', transition:'all 0.15s',
              }}>{label}</button>
            ))}
            <div style={{ flex:1 }} />
            <button onClick={() => setShowAll(!showAll)} style={{
              background: showAll ? (isF?'rgba(200,56,56,.08)':'rgba(238,85,255,.08)') : (isF?'rgba(200,56,56,.04)':'rgba(140,60,255,.06)'),
              border: `1px solid ${showAll ? (isF?'rgba(200,56,56,.18)':'rgba(238,85,255,.2)') : (isF?'rgba(200,56,56,.10)':'rgba(140,60,255,.15)')}`,
              color: showAll ? (isF?'#ff2222':'#ee55ff') : (isF?'#ff6600':'#cc88ff'),
              padding:'4px 14px', fontFamily:'Orbitron, monospace', fontSize:8, letterSpacing:2,
              borderRadius:6, cursor:'pointer', transition:'all 0.15s',
            }}>{showAll ? '▲ TOP 10 ONLY' : `▼ SHOW ALL (${entries.length})`}</button>
          </div>
        )}

        {/* Body */}
        <div style={{ padding:isMobile?'12px 10px':'16px 18px' }}>

          {/* Loading */}
          {lb.loading && entries.length === 0 && (
            <div>
              {/* Progress bar */}
              <div style={{ display:'flex', alignItems:'center', gap:12, background:isF?'rgba(200,56,56,.03)':'rgba(140,60,255,.04)', borderRadius:8, padding:'12px 16px', marginBottom:12, border:isF?'1px solid rgba(255,34,34,.1)':'1px solid rgba(140,60,255,.1)' }}>
                <div style={{ width:20, height:20, border:isF?'2px solid rgba(255,34,34,.2)':'2px solid rgba(140,60,255,.2)', borderTop:isF?'2px solid #ff6600':'2px solid #aa44ff', borderRadius:'50%', animation:'lb-spin .7s linear infinite', flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:isF?'#ff6600':'#cc88ff', letterSpacing:2, marginBottom:3 }}>SCANNING CHAIN…</div>
                  <div style={{ fontFamily:'Sora, sans-serif', fontSize:11, color:'#b8c4d0' }}>{lb.progress}</div>
                </div>
                {lb.batches > 0 && (
                  <div style={{ width:60, height:4, borderRadius:2, background:isF?'rgba(255,102,0,.1)':'rgba(140,60,255,.1)', overflow:'hidden' }}>
                    <div style={{ height:'100%', borderRadius:2, background:isF?'linear-gradient(90deg,#ff3300,#ff6600)':'linear-gradient(90deg,#8822cc,#cc88ff)', transition:'width 0.4s ease', width:`${Math.min((lb.batches / 8) * 100, 100)}%` }} />
                  </div>
                )}
              </div>
              {/* Skeleton rows */}
              <LeaderboardSkeleton isMobile={isMobile} count={6} />
            </div>
          )}

          {/* Error */}
          {lb.error && !lb.loading && (
            <div style={{ padding:'12px 16px', background:'rgba(255,40,40,.05)', border:'1px solid rgba(255,40,40,.25)', borderLeft:'3px solid #ff4444', borderRadius:8, marginBottom:14 }}>
              <div style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#ff6666', letterSpacing:1, marginBottom:4 }}>SCAN ERROR</div>
              <div style={{ fontFamily:'Sora, sans-serif', fontSize:11, color:'#aa8888' }}>{lb.error}</div>
            </div>
          )}

          {/* Leaderboard rows */}
          {entries.length > 0 && (() => {
            // Apply view filter
            let filtered: BurnerEntry[];
            if (lbView === 'weekly' && weekCfg?.status === 'active' && weekCfg.startDate) {
              const wStart = Math.floor(new Date(weekCfg.startDate).getTime() / 1000);
              const wEnd = weekCfg.endDate ? Math.floor(new Date(weekCfg.endDate).getTime() / 1000) : Infinity;
              filtered = entries.map(e => {
                const wkEvents = (e.events || []).filter(ev => ev.blockTime >= wStart && ev.blockTime <= wEnd);
                if (wkEvents.length === 0) return null;
                const burned = wkEvents.reduce((s, ev) => s + ev.amount, 0);
                return { ...e, burned, txCount: wkEvents.length, points: Math.floor(burned * 1.888), events: wkEvents };
              }).filter((e): e is BurnerEntry => e !== null && e.points > 0);
            } else if (lbView === 'weekly') {
              filtered = []; // No active week
            } else {
              filtered = lbView === 'burners' ? entries.filter(e => e.burned > 0) :
                               lbView === 'labwork' ? entries.filter(e => (e.labWorkPts ?? 0) > 0) :
                               entries;
            }
            const sorted = [...filtered].sort((a, b) =>
              lbSort === 'burned' ? b.burned - a.burned :
              lbSort === 'wallet' ? a.address.localeCompare(b.address) :
              b.points - a.points
            );
            const displayed = showAll ? sorted : sorted.slice(0, 10);
            return (
            <>
              {lbView === 'weekly' && weekCfg?.status === 'active' && (
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'rgba(255,140,0,.06)', border:'1px solid rgba(255,140,0,.15)', borderRadius:8, marginBottom:10 }}>
                  <span style={{ fontSize:14 }}>⚡</span>
                  <div>
                    <div style={{ fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:700, color:'#ff9933', letterSpacing:1 }}>{weekCfg.weekId?.toUpperCase() || 'ACTIVE CHALLENGE'}</div>
                    <div style={{ fontFamily:'Sora, sans-serif', fontSize:9, color:'#aabbcc' }}>
                      {weekCfg.startDate ? new Date(weekCfg.startDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—'} → {weekCfg.endDate ? new Date(weekCfg.endDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'ongoing'} · Only burns during this period
                    </div>
                  </div>
                </div>
              )}
              {lbView === 'weekly' && (!weekCfg || weekCfg.status !== 'active') && (
                <div style={{ textAlign:'center', padding:'20px', fontFamily:'Sora, sans-serif', fontSize:12, color:'#8899aa' }}>
                  No active weekly challenge. Weekly leaderboard is available during active challenge periods.
                </div>
              )}
              <div style={{ display:'grid', gridTemplateColumns:isMobile?'30px 1fr 90px 80px':'42px 1fr 130px 120px 70px 50px', gap:isMobile?4:10, padding:isMobile?'6px 10px 8px':'6px 16px 10px', borderBottom:'1px solid rgba(120,60,255,.1)', marginBottom:8 }}>
                {(isMobile?['RANK','WALLET · TIER','BRAINS BURNED','LB PTS E…']:['RANK','WALLET · TIER','BRAINS BURNED','LB PTS EARNED','⚡ AMP','TXS']).map(h => (
                  <div key={h} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?6:7, color:'#e8eef4', letterSpacing:isMobile?1:2 }}>{h}</div>
                ))}
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                {displayed.map((e, i) => (
                  <LbRow key={e.address} entry={e} rank={i+1} isYou={e.address===walletAddress} delay={0.03*Math.min(i,10)} isMobile={isMobile} />
                ))}
              </div>
              {!showAll && myRank && myRank > 10 && myEntry && (
                <>
                  <div style={{ textAlign:'center', padding:'10px 0', fontFamily:'Orbitron, monospace', fontSize:9, color:'#b8c4d0', letterSpacing:3 }}>· · · · · ·</div>
                  <LbRow entry={myEntry} rank={myRank} isYou delay={0} isMobile={isMobile} />
                </>
              )}
              {showAll && filtered.length > 10 && (
                <div style={{ textAlign:'center', padding:'14px 0 6px' }}>
                  <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:isF?'#b8b0c0':'#b0bcc8', letterSpacing:2 }}>
                    SHOWING {filtered.length} {lbView==='burners'?'BURNERS':lbView==='labwork'?'LAB WORKERS':lbView==='weekly'?'WEEKLY BURNERS':'WALLETS'} · SORTED BY {lbSort === 'burned' ? 'BRAINS BURNED' : lbSort === 'wallet' ? 'WALLET ADDRESS' : 'LB PTS EARNED'}
                  </span>
                </div>
              )}
            </>
            );
          })()}

          {/* Empty state */}
          {!lb.loading && entries.length === 0 && !lb.error && (
            <div style={{ textAlign:'center', padding:'40px 20px', fontFamily:'Orbitron, monospace', fontSize:11, color:'#b8c4d0', letterSpacing:2 }}>
              NO BURN DATA FOUND
            </div>
          )}

        </div>
      </div>

      {/* ══ INCINERATOR TIER REFERENCE ══ */}
      {entries.length > 0 && (
        <div style={{ ...heroPanelStyle(0,isF), marginTop:20 }}>
          <HeroBg intensity={0.4} accent={isF?"#ff6600":"#aa44ff"} />
          <div style={{ position:'relative', zIndex:1, padding:isMobile?'12px 10px':'16px 18px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, flexWrap:'wrap', gap:6 }}>
            <div key={isF?'f':'v'} style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?9:11, fontWeight:700, letterSpacing:2, background:isF?'linear-gradient(90deg,#ff2222,#ff6600,#ffbb33,#ffffff)':'linear-gradient(90deg,#ffd700,#ff9933,#ee55ff,#aa44ff)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
              🏆 INCINERATOR TIER REFERENCE
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
              <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                <span style={{ width:4, height:4, borderRadius:'50%', background:isF?'#ffbb33':'#39ff88', display:'inline-block', animation:isF?'lb-fire-live 2s ease infinite':'lb-green-pulse 2s ease infinite' }} />
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?7:8, color:isF?'#d4a050':'#78c8a0' }}>1 BRAIN = 1.888 LB PTS · AMP · 🧪 Lab Work</span>
              </div>
              <button onClick={() => setTierCollapsed(!tierCollapsed)} style={{
                background:tierCollapsed?(isF?'rgba(255,34,34,.08)':'rgba(140,60,255,.08)'):(isF?'rgba(255,187,51,.08)':'rgba(57,255,136,.08)'),
                border:`1px solid ${tierCollapsed?(isF?'rgba(200,56,56,.15)':'rgba(140,60,255,.2)'):(isF?'rgba(255,187,51,.2)':'rgba(57,255,136,.2)')}`,
                color:tierCollapsed?(isF?'#ff6600':'#cc88ff'):(isF?'#ffbb33':'#39ff88'),
                padding:'5px 14px', fontFamily:'Orbitron, monospace', fontSize:8, letterSpacing:2,
                borderRadius:8, cursor:'pointer', transition:'all 0.2s',
              }}>
                {tierCollapsed ? '▼ SHOW ALL TIERS' : '▲ COLLAPSE'}
              </button>
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:isMobile?'1fr':'1fr 1fr', gap:1, background:'rgba(80,40,180,.06)' }}>
            {TIERS.filter(t => t.min > 0).slice().reverse().filter((_, i, arr) => tierCollapsed ? i < 4 : true).map((t, i, arr) => {
              const isTop        = t.min >= 1_000_000;
              const rank         = i + 1;
              const progress     = (arr.length - i) / arr.length;
              const threshPts    = t.min;
              const threshBrains = Math.ceil(t.min / 1.888);
              const threshStr    = threshBrains >= 1_000_000 ? `${(threshBrains/1e6).toFixed(2)}M` : threshBrains >= 1000 ? `${(threshBrains/1000).toFixed(0)}K` : `${threshBrains}`;
              const ptsStr       = threshPts >= 1_000_000 ? `${(threshPts/1e6).toFixed(2)}M` : threshPts >= 1000 ? `${(threshPts/1000).toFixed(0)}K` : `${threshPts}`;
              const accentA      = isTop ? '#ffffff' : t.neon;
              const cardBg       = isTop
                ? 'linear-gradient(135deg,#0e0418 0%,#180830 50%,#100a00 100%)'
                : i % 3 === 0 ? 'linear-gradient(135deg,#06040e,#0a0618)'
                : i % 3 === 1 ? 'linear-gradient(135deg,#07050a,#0d0610)'
                : 'linear-gradient(135deg,#050810,#080c18)';
              return (
                <div key={i} style={{ position:'relative', overflow:'hidden', background:cardBg, padding:isMobile?'10px 10px':'12px 16px' }}>
                  <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(100,60,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.03) 1px,transparent 1px)', backgroundSize:'20px 20px', pointerEvents:'none' }} />
                  <div style={{ position:'absolute', left:0, top:0, bottom:0, width:2, background:isF?`linear-gradient(180deg,#ff6600 0%,${accentA} 40%,#ffbb33 70%,#ff2222 100%)`:`linear-gradient(180deg,#ff9933 0%,${accentA} 40%,#39ff88 70%,#aa44ff 100%)` }} />
                  <div style={{ position:'absolute', left:2, top:'20%', bottom:'20%', width:1, background:`linear-gradient(180deg,transparent,${accentA}44,transparent)` }} />
                  <div style={{ position:'absolute', inset:0, background:`linear-gradient(90deg,transparent,${accentA}04,transparent)`, backgroundSize:'200% 100%', animation:'none', pointerEvents:'none', zIndex:0 }} />
                  {isTop && <div style={{ position:'absolute', inset:0, background:'linear-gradient(90deg,transparent,rgba(200,120,255,.06),transparent)', backgroundSize:'200% 100%', animation:'lb-bar-shimmer 3s ease-in-out infinite', pointerEvents:'none' }} />}
                  <div style={{ display:'grid', gridTemplateColumns:isMobile?'50px 1fr 100px':'60px 1fr 130px', alignItems:'center', gap:isMobile?8:12, position:'relative', zIndex:1 }}>
                    {/* Col 1 — rank + icon */}
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
                      <div style={{ width:isMobile?18:22, height:isMobile?18:22, borderRadius:4, background:`linear-gradient(135deg,${accentA}22,${accentA}08)`, border:`1px solid ${accentA}55`, display:'flex', alignItems:'center', justifyContent:'center' }}>
                        <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?7:8, fontWeight:900, color:accentA }}>{rank}</span>
                      </div>
                      <div style={{ width:isMobile?32:40, height:isMobile?32:40, display:'flex', alignItems:'center', justifyContent:'center', background:`radial-gradient(circle,${accentA}20 0%,${accentA}08 60%,transparent 100%)`, border:`1px solid ${accentA}55`, borderRadius:6, fontSize:isMobile?18:22, boxShadow:`0 0 8px ${accentA}15`, filter:`drop-shadow(0 0 ${isTop?6:3}px ${accentA}55)`, animation:`lb-tier-float ${2.8+i*0.25}s ease-in-out ${i*0.12}s infinite`, position:'relative' }}>
                        {isTop && <>
                          <span style={{ position:'absolute', top:2, right:2, width:4, height:4, borderTop:'1px solid #ff9933', borderRight:'1px solid #ff9933' }} />
                          <span style={{ position:'absolute', bottom:2, left:2, width:4, height:4, borderBottom:isF?'1px solid #ff6600':'1px solid #aa44ff', borderLeft:isF?'1px solid #ff6600':'1px solid #aa44ff' }} />
                        </>}
                        {t.icon}
                      </div>
                    </div>
                    {/* Col 2 — name, badge, flavor, bar */}
                    <div style={{ minWidth:0 }}>
                      <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?11:13, fontWeight:900, color:accentA, letterSpacing:2, textShadow:'none', marginBottom:4 }}>{t.label}</div>
                      <div style={{ marginBottom:5 }}><TierGameBadge label={t.label} /></div>
                      <div style={{ fontFamily:'Sora, sans-serif', fontSize:isMobile?9:10, color:'#b0ccdd', fontStyle:'italic', marginBottom:6 }}>"{t.flavor}"</div>
                      <div style={{ height:2, borderRadius:2, background:'rgba(255,255,255,.06)', overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${progress*100}%`, background:isF?`linear-gradient(90deg,#cc3300,${accentA},#ffbb33)`:`linear-gradient(90deg,#6633cc,${accentA},#39ff88)`, borderRadius:2, transition:'width .5s ease' }} />
                      </div>
                    </div>
                    {/* Col 3 — thresholds */}
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?13:15, fontWeight:900, color:accentA, letterSpacing:1, lineHeight:1 }}>{threshStr}+</div>
                      <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?6:7, color:'#e8eef4', letterSpacing:2, marginTop:2, marginBottom:6 }}>BRAINS BURNED</div>
                      <div style={{ padding:isMobile?'4px 8px':'5px 10px', background:isF?'rgba(212,160,80,.08)':'rgba(30,160,80,.12)', border:isF?'1px solid rgba(255,187,51,.3)':'1px solid rgba(57,255,136,.3)', borderRadius:4, display:'inline-block' }}>
                        <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?11:12, fontWeight:900, lineHeight:1, color:isF?'#ffdd77':'#55ffaa', textShadow:'none' }}>≥{ptsStr}</div>
                        <div style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?6:7, color:isF?'#d4a050':'#78c8a0', marginTop:2, letterSpacing:2 }}>PTS</div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        </div>
      )}


    </div>

    {podiumPopup && createPortal(
      <PodiumPopup entry={podiumPopup.entry} rank={podiumPopup.rank} brainsPrice={brainsPrice} onClose={() => setPodiumPopup(null)} />,
      document.body,
    )}
    </FireCtx.Provider>
  );
};

export default BurnLeaderboard;