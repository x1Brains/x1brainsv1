import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { BRAINS_MINT, BRAINS_LOGO, XNT_LOGO, LB_LOGO } from '../constants';
import { fmtUSD, fmtNum, shortAddr } from '../utils/v2format';
import { fetchAllPrices, fetchPrice, getCachedPrice } from '../lib/prices';
import { getCachedTokenLogo, setCachedTokenLogo, primeFromIndexer } from '../lib/tokenLogos';
import { fetchTokenMeta, fetchPairingLpMints } from './PairingMarketplace';
import { fetchXdexPoolState } from '../lib/xdexPoolChart';
import { fetchFarms } from './LpFarms';
import { fetchAllListings } from '../components/LBComponents';
import V2NFTImage from '../components/V2NFTImage';
import CopyButton from '../components/CopyButton';
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
/** An LP mint the portfolio can name. Farm pools supply `pair` + a USD price;
 *  pairing-marketplace pools supply the two underlying mints instead, and the
 *  label is derived from them once their metadata resolves. */
interface LpEntry {
  pair: string; reward: string; lpPriceUsd: number;
  mintA?: string; mintB?: string;
  /** Pool reserves NET of protocol/fund fees, in UI units, plus LP supply.
   *  Held as reserves rather than a precomputed price because the underlying
   *  token prices arrive asynchronously — the price is recomputed each repaint. */
  resA?: number; resB?: number; lpSupplyUi?: number;
}

/** Shortcuts for the confidential tokens live on X1 today. Deliberately just
 *  shortcuts — the paste field is the real entry point, because a hardcoded
 *  list goes stale the moment anyone launches a token we have not heard of. */
/**
 * Base units -> a full, exact, grouped figure.
 *
 * Deliberately not fmtNum: that abbreviates to "25.00K", which is fine for a
 * portfolio total and wrong for a balance you are about to spend. Trailing
 * zeros are trimmed but nothing is rounded away.
 */
function fmtUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString('en-US');
  const frac = decimals ? (v % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

const KNOWN_CONFIDENTIAL = [
  { label: 'X1B',   mint: '3nkouZp3DvRsD3w8cPVWwGH1CMD9PUyc9CfjonYerBn8' },
  { label: 'BM',    mint: 'AVEXYesqK3k4JyWaHhjCqaqZvkuMfmYi2JkPT6aCow9e' },
  { label: 'cUSDC', mint: '9E4UKVfn9HvqnGKsazKc7TQqfYYe5dusPc4Q3u3MMMph' },
];

const KNOWN: Record<string, { symbol: string; logo?: string; iconClass: string; color: string; kind: TokenKind }> = {
  [BRAINS_MINT]: { symbol: 'BRAINS', logo: BRAINS_LOGO, iconClass: 'brains', color: C_ORANGE, kind: 'ecosystem' },
  [LB_MINT]:     { symbol: 'LB',     logo: LB_LOGO,     iconClass: 'lb',     color: C_PURPLE, kind: 'ecosystem' },
  [XNT_MINT]:    { symbol: 'XNT',    logo: XNT_LOGO,    iconClass: 'xnt',    color: C_ORANGE, kind: 'x1native'  },
  [XNM_MINT]:    { symbol: 'XNM',                       iconClass: 'lb',     color: C_GRAY,   kind: 'x1native'  },
  [XUNI_MINT]:   { symbol: 'XUNI',                      iconClass: 'lb',     color: C_GREEN,  kind: 'x1native'  },
  [XBLK_MINT]:   { symbol: 'XBLK',                      iconClass: 'lb',     color: C_GRAY,   kind: 'x1native'  },
};

// Token icon that fills the 34×34 cell. Real logo first; letter fallback.
/** One half of an LP pair icon: the token's cached logo, else its initial. */
function PairHalf({ mint, sym, d, color }: { mint?: string; sym?: string; d: number; color: string }) {
  const logo = mint ? getCachedTokenLogo(mint) : null;
  return (
    <div style={{
      width: d, height: d, borderRadius: '50%', flexShrink: 0,
      border: '1.5px solid #06090d', boxSizing: 'border-box',
      background: logo
        ? `#06090d url(${logo}) center/cover no-repeat`
        : `linear-gradient(135deg, ${color}, ${color}99)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#0a0e14', fontFamily: "'JetBrains Mono',monospace",
      fontSize: Math.round(d * 0.5), fontWeight: 800, lineHeight: 1,
    }}>{logo ? '' : (sym?.[0] ?? '?').toUpperCase()}</div>
  );
}

/**
 * LP rows showed a single initial — "A" for AGI/BRAINS — which identified
 * neither side of the pair. Draw both underlying tokens instead, overlapping,
 * each falling back to its own initial when no logo is cached.
 */
function LpPairIcon({ h, size = 30 }: { h: Holding; size?: number }) {
  const d = Math.round(size * 0.68);
  return (
    <div style={{ width: size, height: size, flexShrink: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center' }}
      title={h.lpInfo?.pairSymbol}>
      <PairHalf mint={h.lpInfo?.mintA} sym={h.lpInfo?.symA} d={d} color={C_ORANGE} />
      <div style={{ marginLeft: -Math.round(d * 0.34) }}>
        <PairHalf mint={h.lpInfo?.mintB} sym={h.lpInfo?.symB} d={d} color={C_SILVER} />
      </div>
    </div>
  );
}

function TokenIcon({ h, size = 30 }: { h: Holding; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (h.category === 'lp' && (h.lpInfo?.mintA || h.lpInfo?.mintB)) {
    return <LpPairIcon h={h} size={size} />;
  }
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
  /** `mintA`/`mintB` are the pool's two underlying tokens, carried so the row can
   *  draw a PAIR icon — a single initial ('A' for AGI/BRAINS) said nothing. */
  lpInfo?: { pairSymbol: string; rewardSymbol: string; mintA?: string; mintB?: string; symA?: string; symB?: string };
  /** Token-2022 confidential transfers are configured on this account. */
  confidential?: boolean;
  hasHiddenBalance?: boolean;
  mintConfidential?: boolean;
  mintFullyPrivate?: boolean;
  listedPrice?: number;
  /** Unit price computed by us rather than read from the price feed — LP tokens
   *  have no market price, their value is derived from the pool they represent. */
  unitUsd?: number;
};

type RawEntry = { mint: string; balance: number; program: Program; decimals: number;
  /** The account has a Token-2022 confidentialTransferAccount extension. */
  confidential?: boolean;
  /** That extension holds a non-zero ciphertext — there IS a hidden balance. */
  hasHiddenBalance?: boolean;
  /** The MINT supports confidential transfers, whether or not this holder
   *  has opted in. Two different facts, two different badges. */
  mintConfidential?: boolean;
  /** The mint ALSO has ConfidentialMintBurn: supply itself is encrypted and
   *  the public<->confidential bridge is disabled outright (the program
   *  rejects MintTo/deposit/withdraw with error 0x41). A stronger guarantee
   *  than confidentialTransfer alone, and worth its own badge. */
  mintFullyPrivate?: boolean };

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

  // A confidential holder's PUBLIC balance is legitimately 0 while their real
  // holding sits encrypted in the confidentialTransferAccount extension. The
  // old `uiAmount > 0` test dropped those rows entirely, so the token did not
  // render as "0" or "—" — it VANISHED, and the holder would reasonably think
  // their tokens were gone. Keep any account that carries the extension.
  const readExt = (info: any) => {
    const ct = (info?.extensions ?? []).find((e: any) => e.extension === 'confidentialTransferAccount');
    if (!ct) return { confidential: false, hasHiddenBalance: false };
    // An all-zero ciphertext is what a freshly configured account holds, and
    // base64 of 64 zero bytes is 86 'A's plus '=='. Each field must be tested
    // SEPARATELY: concatenating two padded strings puts '==' in the middle, so
    // /^A*=*$/ never matches and every empty account reads as "has a balance".
    const isZero = (b64: unknown) => typeof b64 === 'string' && /^A*=*$/.test(b64);
    const fields = [ct.state?.availableBalance, ct.state?.pendingBalanceLo, ct.state?.pendingBalanceHi];
    return { confidential: true, hasHiddenBalance: fields.some(f => typeof f === 'string' && !isZero(f)) };
  };

  const push = (acc: any, program: Program) => {
    const info = acc.account.data.parsed?.info;
    if (!info?.mint) return;
    const ext = readExt(info);
    const bal = info?.tokenAmount?.uiAmount ?? 0;
    // Keep zero-balance Token-2022 accounts for now. A confidential-capable
    // token you cannot hold yet reads as balance 0, and dropping it created a
    // deadlock: no row -> no ENABLE button -> never configured -> can never
    // receive it -> balance stays 0. Non-confidential zero rows are filtered
    // out below, once the mint check has told us which is which.
    if (bal <= 0 && !ext.confidential && program !== 't22') return;
    raw.push({
      mint: info.mint, balance: bal, program,
      decimals: info.tokenAmount?.decimals ?? 0,
      confidential: ext.confidential, hasHiddenBalance: ext.hasHiddenBalance,
    });
  };

  for (const acc of spl.value ?? []) push(acc, 'spl');
  for (const acc of t22.value ?? []) push(acc, 't22');

  // Only Token-2022 mints can carry the extension, and the capability is a
  // property of the MINT — a holder sees "this token can be private" even
  // before they opt in. One batched call, classic SPL skipped entirely.
  const t22Mints = [...new Set(raw.filter(r => r.program === 't22').map(r => r.mint))];
  if (t22Mints.length) {
    try {
      const infos = await connection.getMultipleParsedAccounts(
        t22Mints.map((m: string) => new PublicKey(m)),
      );
      const supports = new Set<string>();
      const fully = new Set<string>();
      (infos?.value ?? []).forEach((acc: any, i: number) => {
        const exts = acc?.data?.parsed?.info?.extensions ?? [];
        if (exts.some((e: any) => e.extension === 'confidentialTransferMint')) supports.add(t22Mints[i]);
        if (exts.some((e: any) => e.extension === 'confidentialMintBurn'))     fully.add(t22Mints[i]);
      });
      for (const r of raw) {
        if (supports.has(r.mint)) r.mintConfidential = true;
        if (fully.has(r.mint))    r.mintFullyPrivate = true;
      }
      // Now drop the empty rows we kept provisionally: an empty account for an
      // ordinary token is just dust, but an empty account for a CONFIDENTIAL
      // mint is the one you need to see in order to enable it.
      for (let i = raw.length - 1; i >= 0; i--) {
        const r = raw[i];
        if (r.balance <= 0 && !r.confidential && !r.mintConfidential) raw.splice(i, 1);
      }
    } catch { /* capability badge is cosmetic — never fail the portfolio for it */ }
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
/**
 * Per-wallet lookup budgets.
 *
 * These were 12 and 30. A wallet holding 18 tokens + 102 NFTs therefore got
 * metadata for 30 of 120 items and every other row rendered as a truncated
 * mint with no symbol, no name and no art. Raised to cover a realistic wallet
 * in one pass; results are cached in localStorage for 7 days, so only the
 * first visit to a given wallet pays for them, and runThrottled still bounds
 * concurrency so the X1 RPC is not stampeded.
 */
const PRICE_LOOKUP_CAP = 40;
const META_LOOKUP_CAP  = 250;

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
  if (document.getElementById('v2pf-x13')) return;
  const s = document.createElement('style');
  s.id = 'v2pf-x13';
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

  .pfx-acts{display:flex;gap:7px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
  .pfx-priv-send{margin:6px 0 10px;padding:13px 14px;border-radius:11px;
    background:#0a0f16;border:1px solid rgba(0,201,141,.28)}
  .pfx-priv-head{font-family:'Orbitron',sans-serif;font-size:11px;font-weight:700;
    letter-spacing:.8px;color:var(--g);display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
  .pfx-priv-head span{font-family:'Sora',sans-serif;font-size:10.5px;font-weight:400;
    letter-spacing:0;color:var(--muted)}
  .pfx-priv-send input{width:100%;box-sizing:border-box;margin-top:9px;padding:10px 12px;
    border-radius:9px;background:#070b11;border:1px solid var(--line);color:var(--txt);
    font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;outline:none;transition:.15s}
  .pfx-priv-send input:focus{border-color:var(--g);box-shadow:0 0 0 3px rgba(0,201,141,.1)}
  .pfx-priv-row{display:flex;gap:8px;align-items:stretch}
  .pfx-priv-row input{flex:1;min-width:0}
  .pfx-priv-row .pfx-chip,.pfx-priv-row .pfx-btn{margin-top:9px;white-space:nowrap}
  .pfx-priv-foot{margin-top:9px;font-size:10.5px;color:var(--muted);line-height:1.5}

  .pfx-reveal{cursor:pointer;font-family:inherit;transition:.15s}
  .pfx-reveal:hover:not(:disabled){background:rgba(0,201,141,.2);border-color:var(--g)}
  .pfx-reveal:disabled{opacity:.6;cursor:default}
  .pfx-bal-strip{margin:7px 0 10px;padding:11px 14px;border-radius:10px;
    background:linear-gradient(180deg,rgba(0,201,141,.09),rgba(0,201,141,.04));
    border:1px solid rgba(0,201,141,.3)}
  .pfx-bal-main{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  .pfx-bal-main .lab{font-family:'Orbitron',sans-serif;font-size:9px;font-weight:700;
    letter-spacing:1.1px;color:var(--g);opacity:.85;flex:none}
  .pfx-bal-main .amt{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:19px;
    font-weight:600;color:var(--txt);line-height:1.2;word-break:break-all}
  .pfx-bal-main .amt em{font-style:normal;font-size:12px;color:var(--muted);margin-left:7px}
  .pfx-bal-pending{display:flex;align-items:center;justify-content:space-between;gap:11px;
    flex-wrap:wrap;margin-top:9px;padding-top:9px;border-top:1px solid rgba(0,201,141,.18);
    font-size:11.5px;color:var(--muted)}
  .pfx-btn.sm{padding:5px 13px;font-size:10px;flex:none}
  @media(max-width:640px){
    .pfx-bal-main .amt{font-size:16px}
    .pfx-bal-pending{font-size:10.5px}
  }

  .pfx-find{margin-top:14px;align-self:start}
  .pfx-find-body{padding:0 18px 18px}
  .pfx-find-form{display:flex;gap:9px}
  .pfx-find-form input{flex:1;min-width:0;padding:11px 13px;border-radius:10px;box-sizing:border-box;
    background:#070b11;border:1px solid var(--line);color:var(--txt);
    font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;outline:none;transition:.15s}
  .pfx-find-form input:focus{border-color:var(--g);box-shadow:0 0 0 3px rgba(0,201,141,.1)}
  .pfx-find-form input::placeholder{color:var(--dim)}
  .pfx-find-form .pfx-btn{white-space:nowrap}
  .pfx-find-known{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
  .pfx-chip{font-family:'Sora';font-size:10.5px;font-weight:600;letter-spacing:.6px;
    padding:5px 11px;border-radius:20px;cursor:pointer;transition:.15s;
    background:#0a0f16;border:1px solid var(--line2);color:var(--muted)}
  .pfx-chip:hover{border-color:var(--g);color:var(--g)}
  .pfx-find-err{margin-top:12px;padding:9px 12px;border-radius:8px;font-size:11.5px;
    color:#ff4466;background:rgba(255,68,102,.07);border:1px solid rgba(255,68,102,.2)}
  .pfx-find-card{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
    margin-top:12px;padding:12px 14px;border-radius:11px;background:#0a0f16;border:1px solid var(--line2)}
  .pfx-find-card .pfx-find-id{flex:1;min-width:0}
  .pfx-find-logo{width:34px;height:34px;border-radius:50%;flex:none;object-fit:cover;
    background:#070b11;border:1px solid var(--line2)}
  .pfx-find-logo.ph{display:flex;align-items:center;justify-content:center;
    font-family:'Orbitron',sans-serif;font-size:11px;font-weight:700;color:var(--muted)}
  .pfx-find-id .sym{display:flex;align-items:center;gap:8px;font-family:'Orbitron',sans-serif;
    font-weight:700;font-size:13px;letter-spacing:.6px}
  .pfx-find-id .sub{font-size:11px;color:var(--muted);margin-top:4px}
  @media(max-width:640px){
    .pfx-find-form{flex-direction:column}
    .pfx-find-form .pfx-btn{justify-content:center}
  }

  .pfx-send.enable-private{border-color:rgba(0,201,141,.32);color:var(--g)}
  .pfx-send.enable-private:hover{border-color:var(--g);background:rgba(0,201,141,.08)}
  .pfx-send.enable-private:disabled{opacity:.5;cursor:default}
  .pfx-enable-msg{font-size:11px;color:var(--g);padding:6px 18px 10px;margin-top:-4px}
  .pfx-enable-msg.bad{color:#ff4466}

  .pfx-bal-inline{display:none;font-size:11.5px;color:var(--txt);margin-top:3px;letter-spacing:.2px}
  .pfx-bal-inline .u{color:var(--muted);font-size:10.5px}

  .pfx-place{padding:40px 16px;text-align:center}
  .pfx-place .glyph{font-size:30px;color:var(--o);margin-bottom:10px}
  .pfx-place .sub{color:var(--muted);font-size:13px}

  /* ── group expand/collapse ── */
  .pfx-more{display:block;width:100%;margin:6px 0 2px;padding:10px 0;border:1px dashed var(--line);
    background:transparent;border-radius:9px;cursor:pointer;transition:.15s;
    font-family:'Sora';font-weight:600;font-size:11px;letter-spacing:1.2px}
  .pfx-more:hover{background:rgba(255,255,255,.03);border-style:solid}

  /* ── watch mode ── */
  .pfx-watchbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
    padding:11px 16px;margin-bottom:14px;border-radius:12px;
    background:linear-gradient(135deg,rgba(0,201,141,.09),rgba(0,201,141,.03));
    border:1px solid rgba(0,201,141,.26)}
  .pfx-watchbar-l{display:flex;align-items:center;gap:11px;min-width:0}
  .pfx-watchbar .eye{font-size:15px;color:var(--g)}
  .pfx-watchbar .t{font-family:'Orbitron',sans-serif;font-weight:700;font-size:10px;letter-spacing:2px;color:var(--g)}
  .pfx-watchbar .s{font-size:11px;color:var(--muted);margin-top:3px}
  .pfx-watchbar .pfx-btn:hover{border-color:#ff4466;color:#ff4466}

  /* .pfx grid stretches its rows — hug the content instead of ballooning. */
  .pfx-watch{padding:34px 22px;text-align:center;align-self:start}
  .pfx-watch .glyph{font-size:28px;color:var(--g);margin-bottom:10px}
  .pfx-watch h3{font-family:'Orbitron',sans-serif;font-weight:800;font-size:14px;letter-spacing:2px;margin:0 0 10px}
  .pfx-watch p{font-size:12.5px;color:var(--muted);line-height:1.65;margin:0 auto 18px;max-width:520px}
  .pfx-watch p b{color:var(--g);font-weight:600}
  .pfx-watch-form{display:flex;gap:9px;max-width:560px;margin:0 auto}
  .pfx-watch-form input{flex:1;min-width:0;padding:12px 14px;border-radius:10px;box-sizing:border-box;
    background:#070b11;border:1px solid var(--line);color:var(--txt);
    font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12px;outline:none;transition:.15s}
  .pfx-watch-form input:focus{border-color:var(--g);box-shadow:0 0 0 3px rgba(0,201,141,.12)}
  .pfx-watch-form input.bad{border-color:#ff4466}
  .pfx-watch-form input::placeholder{color:var(--dim)}
  .pfx-watch-form .pfx-btn{white-space:nowrap}
  .pfx-watch-err{margin:11px auto 0;max-width:560px;padding:8px 12px;border-radius:8px;font-size:11.5px;
    color:#ff4466;background:rgba(255,68,102,.07);border:1px solid rgba(255,68,102,.22)}
  .pfx-watch-foot{margin-top:16px;font-size:11px;color:var(--dim)}

  @media(max-width:640px){
    .pfx-watch-form{flex-direction:column}
    .pfx-watch-form .pfx-btn{justify-content:center}
    .pfx-watchbar{align-items:flex-start}
    .pfx-watchbar .pfx-btn{width:100%;justify-content:center}
  }

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
    .pfx-bal-inline{display:block}
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
  const { publicKey, connected, signTransaction, signAllTransactions, signMessage } = useWallet();
  // Memoized so the per-second clock re-render doesn't hand SendPanel a new
  // wallet object every tick (which would re-run its effects mid-send).
  const wallet = useMemo(
    () => (publicKey ? { publicKey, signTransaction, signAllTransactions } : null),
    [publicKey, signTransaction, signAllTransactions],
  );
  const isMobile = useIsMobile();

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const metaMap = useRef<Map<string, { symbol?: string; name?: string; uri?: string }>>(new Map());
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
  /** "add a private token" panel: paste a mint, confirm it, enable it. */
  const [findInput, setFindInput] = useState('');
  const [finding,   setFinding]   = useState(false);
  const [found, setFound] = useState<
    | null
    | { mint: string; symbol: string; name: string; logo?: string; fully: boolean;
        hasAccount: boolean; configured: boolean }
    | { error: string }
  >(null);

  const [enabling,  setEnabling]  = useState<string | null>(null);
  const [enableMsg, setEnableMsg] = useState<{ mint: string; text: string; bad?: boolean } | null>(null);

  /**
   * Opt this wallet's token account into Token-2022 confidential transfers.
   *
   * Only ever for the CONNECTED wallet: ConfigureAccount must be signed by the
   * account owner, so there is deliberately no path to do this on someone
   * else's behalf — which is also why the button is hidden in watch mode.
   *
   * The ~2.6 MB proof WASM is imported inside the handler, so it is fetched on
   * the first click and never for anyone who does not use this.
   */
  const handleEnablePrivate = async (mint: string) => {
    if (!publicKey || !signMessage || !signTransaction) {
      setEnableMsg({ mint, text: 'Wallet cannot sign messages — try Backpack or Phantom.', bad: true });
      return;
    }
    setEnabling(mint);
    try {
      const [{ buildConfigureAccountTx }, { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID }] =
        await Promise.all([import('../lib/confidential'), import('@solana/spl-token')]);
      const mintPk = new PublicKey(mint);
      const ata = getAssociatedTokenAddressSync(mintPk, publicKey, false, TOKEN_2022_PROGRAM_ID);

      setEnableMsg({ mint, text: 'Sign to derive your private key…' });
      const tx = await buildConfigureAccountTx(connection, mintPk, ata, publicKey, signMessage);

      setEnableMsg({ mint, text: 'Approve the transaction…' });
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(),
        { skipPreflight: false, preflightCommitment: 'confirmed' });

      setEnableMsg({ mint, text: 'Confirming…' });
      for (let i = 0; i < 30; i++) {
        const st = (await connection.getSignatureStatuses([sig]))?.value?.[0];
        if (st?.err) throw new Error('Transaction failed on chain');
        if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break;
        await new Promise(r => setTimeout(r, 1000));
      }
      setEnableMsg({ mint, text: 'Private balance enabled ✓' });
      setReloadNonce(n => n + 1);
      // `found` is its own snapshot taken at CHECK time — the table reload does
      // not touch it, so flip it by hand or the card keeps offering ENABLE.
      setFound(f => (f && !('error' in f) && f.mint === mint)
        ? { ...f, hasAccount: true, configured: true } : f);
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setEnableMsg({ mint, bad: true,
        text: /User rejected|rejected the request/i.test(m) ? 'Cancelled.' : m.slice(0, 120) });
    } finally {
      setEnabling(null);
    }
  };

  /** Decrypted private balances, per mint, for this page load only. */
  const [revealed, setRevealed] = useState<Record<string,
    { available: bigint; pending: bigint; pendingCredits: number; pendingKnown: boolean }>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealErr, setRevealErr] = useState<Record<string, string>>({});

  /**
   * Decrypt and show a private balance.
   *
   * The amount is never on chain in the clear and no wallet can render it, so
   * this is the only way to see your own number. It costs one wallet signature
   * per token account, cached for the page load — the keys live in memory and
   * are never written anywhere.
   */
  const handleReveal = async (mint: string) => {
    if (!publicKey || !signMessage) return;
    setRevealing(mint);
    setRevealErr(e => { const { [mint]: _drop, ...rest } = e; return rest; });
    try {
      const { getSessionKeys, readConfidentialBalances, ataFor } = await import('../lib/confidential');
      const ata = ataFor(new PublicKey(mint), publicKey);
      const keys = await getSessionKeys(connection, ata, publicKey, signMessage);
      const bal = keys && await readConfidentialBalances(connection, ata, keys);
      if (!bal) {
        // Not a bug and worth saying plainly: our key derivation is our own, so
        // an account the spl-token CLI configured carries a key we cannot
        // rebuild from a wallet signature. See lib/confidential.ts `keyMessage`.
        setRevealErr(e => ({ ...e, [mint]:
          'Could not decrypt — this account was configured by software whose key derivation is neither ours nor the spl-token CLI\u2019s.' }));
        return;
      }
      setRevealed(r => ({ ...r, [mint]: bal }));
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setRevealErr(er => ({ ...er, [mint]:
        /User rejected|rejected the request/i.test(m) ? 'Cancelled.' : m.slice(0, 120) }));
    } finally {
      setRevealing(null);
    }
  };

  /** Private-send panel: which mint is open, and its form state. */
  const [privSendMint, setPrivSendMint] = useState<string | null>(null);
  const [privTo,   setPrivTo]   = useState('');
  const [privAmt,  setPrivAmt]  = useState('');
  const [privBusy, setPrivBusy] = useState(false);
  const [privMsg,  setPrivMsg]  = useState<{ text: string; bad?: boolean } | null>(null);

  /**
   * Send a confidential balance.
   *
   * Four transactions, not one: the equality, ciphertext-validity and range
   * proofs come to 1864 bytes against a 1232-byte transaction limit, so each
   * has to be verified into a context-state account before the transfer can
   * point at it. `signAllTransactions` keeps that to a single approval, and the
   * last transaction closes all three context accounts to refund their rent.
   */
  const handlePrivateSend = async (mint: string, decimals: number) => {
    if (!publicKey || !signMessage || !signAllTransactions) {
      setPrivMsg({ text: 'This wallet cannot sign a batch — try Backpack.', bad: true });
      return;
    }
    setPrivBusy(true);
    setPrivMsg(null);
    try {
      const { getSessionKeys, planConfidentialTransfer, ataFor } = await import('../lib/confidential');
      const mintPk = new PublicKey(mint);

      let toPk: PublicKey;
      try { toPk = new PublicKey(privTo.trim()); }
      catch { throw new Error('That recipient address is not valid.'); }

      const amount = (() => {
        const n = privAmt.trim();
        if (!/^\d*\.?\d*$/.test(n) || !n || n === '.') throw new Error('Enter an amount.');
        const [whole, frac = ''] = n.split('.');
        if (frac.length > decimals) throw new Error(`This token has ${decimals} decimals.`);
        return BigInt(whole || '0') * 10n ** BigInt(decimals)
             + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
      })();

      setPrivMsg({ text: 'Sign to unlock your balance…' });
      const source = ataFor(mintPk, publicKey);
      const keys = await getSessionKeys(connection, source, publicKey, signMessage);
      if (!keys) throw new Error('Could not derive a key that opens this account.');

      setPrivMsg({ text: 'Building proofs…' });
      const plan = await planConfidentialTransfer(connection, {
        mint: mintPk, sourceAccount: source, destAccount: ataFor(mintPk, toPk),
        amount, keys, authority: publicKey,
      });

      setPrivMsg({ text: `Approve ${plan.transactions.length} transactions…` });
      const signed = await signAllTransactions(plan.transactions);

      for (let i = 0; i < signed.length; i++) {
        setPrivMsg({ text: `Sending ${i + 1} of ${signed.length}…` });
        const sig = await connection.sendRawTransaction(signed[i].serialize(), { skipPreflight: false });
        const bh = await connection.getLatestBlockhash();
        const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
        if (res.value.err) throw new Error(`Step ${i + 1} failed on chain.`);
      }

      setPrivMsg({ text: 'Sent privately ✓' });
      setPrivAmt(''); setPrivTo('');
      // The row's revealed figure is now stale — replace it rather than leave a
      // number on screen that no longer matches the chain.
      setRevealed(r => r[mint]
        ? { ...r, [mint]: { ...r[mint], available: plan.newSourceBalance } } : r);
      setReloadNonce(n => n + 1);
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setPrivMsg({ bad: true,
        text: /User rejected|rejected the request/i.test(m) ? 'Cancelled.' : m.slice(0, 160) });
    } finally {
      setPrivBusy(false);
    }
  };

  const [applying, setApplying] = useState<string | null>(null);

  /**
   * Fold a received balance into the spendable one.
   *
   * Incoming transfers land in a pending compartment so a sender cannot
   * invalidate a spend the receiver is halfway through building. Until this
   * runs, the tokens are genuinely held but genuinely unspendable — so the row
   * shows the button rather than quietly adding pending into the total.
   */
  const handleApplyPending = async (mint: string) => {
    if (!publicKey || !signMessage || !signTransaction) return;
    setApplying(mint);
    setRevealErr(e => { const { [mint]: _drop, ...rest } = e; return rest; });
    try {
      const { getSessionKeys, buildApplyPendingBalanceTx, readConfidentialBalances, ataFor } =
        await import('../lib/confidential');
      const ata = ataFor(new PublicKey(mint), publicKey);
      const keys = await getSessionKeys(connection, ata, publicKey, signMessage);
      if (!keys) throw new Error('Could not derive a key that opens this account.');
      const tx = await buildApplyPendingBalanceTx(connection, ata, publicKey, keys);
      if (!tx) return;                                   // nothing pending after all
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      const bh = await connection.getLatestBlockhash();
      const res = await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
      if (res.value.err) throw new Error('Apply failed on chain.');
      const fresh = await readConfidentialBalances(connection, ata, keys);
      if (fresh) setRevealed(r => ({ ...r, [mint]: fresh }));
      setReloadNonce(n => n + 1);
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setRevealErr(er => ({ ...er, [mint]:
        /User rejected|rejected the request/i.test(m) ? 'Cancelled.' : m.slice(0, 140) }));
    } finally {
      setApplying(null);
    }
  };

  /** A decrypted balance must never outlive the wallet that unlocked it. */
  useEffect(() => {
    if (publicKey) return;
    setRevealed({}); setRevealErr({}); setPrivSendMint(null); setPrivMsg(null);
    import('../lib/confidential').then(m => m.clearSessionKeys()).catch(() => {});
  }, [publicKey]);

  /**
   * Look up a mint by address and report whether it can hold a private balance.
   *
   * This exists because the holdings table can only enumerate token accounts
   * that ALREADY EXIST. A wallet that has never been sent a given token has no
   * account for it, so it has no row, so there is nothing to click — and for a
   * ConfidentialMintBurn token nobody can send you one to break the tie,
   * because the transfer needs a key you have not registered yet. Pasting the
   * mint is the only way in from a cold start.
   */
  const handleFindToken = async (raw: string) => {
    const addr = raw.trim();
    if (!addr) return;
    setFinding(true);
    setFound(null);
    try {
      let mintPk: PublicKey;
      try { mintPk = new PublicKey(addr); }
      catch { setFound({ error: 'That is not a valid address.' }); return; }

      const ai = await connection.getParsedAccountInfo(mintPk);
      const owner = ai.value?.owner?.toBase58();
      if (!ai.value) { setFound({ error: 'No such account on X1.' }); return; }
      if (owner !== TOKEN_2022_PROGRAM_ID.toBase58()) {
        setFound({ error: 'Not a Token-2022 mint — only Token-2022 supports confidential transfers.' });
        return;
      }
      const info: any = (ai.value.data as any)?.parsed?.info;
      const exts: any[] = info?.extensions ?? [];
      if (!exts.some(e => e.extension === 'confidentialTransferMint')) {
        setFound({ error: 'This token does not support confidential transfers.' });
        return;
      }
      const meta = exts.find(e => e.extension === 'tokenMetadata')?.state;

      let hasAccount = false, configured = false;
      if (publicKey) {
        const { ataFor } = await import('../lib/confidential');
        const acc = await connection.getParsedAccountInfo(ataFor(mintPk, publicKey));
        hasAccount = !!acc.value;
        configured = (((acc.value as any)?.data?.parsed?.info?.extensions) ?? [])
          .some((e: any) => e.extension === 'confidentialTransferAccount');
      }
      const m58 = mintPk.toBase58();
      setFound({
        mint: m58,
        symbol: meta?.symbol || shortAddr(m58, 4, 4),
        name: meta?.name || '',
        logo: getCachedTokenLogo(m58) ?? undefined,
        fully: exts.some(e => e.extension === 'confidentialMintBurn'),
        hasAccount, configured,
      });
      // The logo lives in the metadata URI's JSON, not on the mint — fetch it
      // after showing the card so a slow gateway never delays the answer.
      fetchTokenMeta(m58).then(tm => {
        if (!tm?.logo) return;
        setFound(f => (f && !('error' in f) && f.mint === m58) ? { ...f, logo: tm.logo } : f);
      }).catch(() => {});
    } catch (e: any) {
      setFound({ error: String(e?.message ?? e).slice(0, 120) });
    } finally {
      setFinding(false);
    }
  };

  // ── WATCH MODE — view any wallet without connecting ──────────────────────────
  // Ported from the v1 Portfolio (src/pages/Portfolio.tsx). While `isWatching`
  // is on, every READ path uses `activeKey` instead of the connected wallet and
  // every WRITE path (SEND, snapshot saving) is disabled — you are looking at
  // somebody else's wallet, so nothing may be signed or persisted for it.
  const [watchAddress,    setWatchAddress]    = useState('');
  const [watchInput,      setWatchInput]      = useState('');
  const [watchInputError, setWatchInputError] = useState('');
  const [isWatching,      setIsWatching]      = useState(false);

  /** The wallet the page is currently showing: watched address, else connected. */
  const activeKey: PublicKey | null = useMemo(() => {
    if (isWatching && watchAddress) {
      try { return new PublicKey(watchAddress); } catch { return null; }
    }
    return publicKey ?? null;
  }, [publicKey, isWatching, watchAddress]);

  const isReadOnly = isWatching;

  const handleWatchSubmit = () => {
    const addr = watchInput.trim();
    if (!addr) return;
    try { new PublicKey(addr); }
    catch {
      setWatchInputError('Invalid wallet address — must be a base58 X1 / SVM address.');
      return;
    }
    setActiveSendMint(null);
    setWatchAddress(addr);
    setIsWatching(true);
    setWatchInputError('');
  };

  const handleStopWatching = () => {
    setIsWatching(false);
    setWatchAddress('');
    setWatchInput('');
    setWatchInputError('');
  };

  // Per-group row caps — long wallets made the page unreadable, especially on
  // mobile. Each group shows the top GROUP_PREVIEW rows by value until expanded.
  const GROUP_PREVIEW = 20;
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

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
    if (!activeKey) {
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
    /** Best-known ticker for a mint: hardcoded > fetched metadata > short address. */
    const symbolOf = (m: string): string =>
      KNOWN[m]?.symbol
      || metaMap.current.get(m)?.symbol
      || metaMap.current.get(m)?.name
      || shortAddr(m, 4, 4);

    const buildHoldings = (
      raw: RawEntry[],
      priceMap: Record<string, number>,
      lpMap: Map<string, LpEntry>,
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
          confidential: r.confidential, hasHiddenBalance: r.hasHiddenBalance,
          mintConfidential: r.mintConfidential, mintFullyPrivate: r.mintFullyPrivate,
        };
      }
      if (lp) {
        // Farm LPs already carry a pair label. Pairing-marketplace LPs have no
        // token metadata at all (nobody mints Metaplex data for an LP mint), so
        // build the label from the two underlying mints at RENDER time — meta
        // for those arrives asynchronously and each repaint re-resolves it.
        const label = lp.pair || (lp.mintA && lp.mintB ? `${symbolOf(lp.mintA)}/${symbolOf(lp.mintB)}` : 'LP');
        // An LP token has no market price. Its worth is its share of the pool:
        // (netReserveA x priceA + netReserveB x priceB) / lpSupply.
        const derived =
          lp.resA != null && lp.resB != null && lp.lpSupplyUi
            ? (lp.resA * (priceMap[lp.mintA!] || 0) + lp.resB * (priceMap[lp.mintB!] || 0)) / lp.lpSupplyUi
            : 0;
        const unit = derived > 0 ? derived : lp.lpPriceUsd;
        return {
          symbol: label, mint: r.mint, balance: r.balance,
          usd: r.balance * unit, unitUsd: unit > 0 ? unit : undefined,
          iconClass: lp.reward === 'BRAINS' ? 'brains' : 'lb',
          color: C_SILVER,
          program: r.program, category: 'lp', decimals: r.decimals,
          confidential: r.confidential, hasHiddenBalance: r.hasHiddenBalance,
          mintConfidential: r.mintConfidential, mintFullyPrivate: r.mintFullyPrivate,
          lpInfo: {
            pairSymbol: label, rewardSymbol: lp.reward,
            mintA: lp.mintA, mintB: lp.mintB,
            symA: lp.mintA ? symbolOf(lp.mintA) : undefined,
            symB: lp.mintB ? symbolOf(lp.mintB) : undefined,
          },
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
          // NftHoverThumb renders `logo || metaUri`. Without metaUri, an NFT
          // whose logo fetch came back empty had no src at all and fell to the
          // placeholder — 63 of 102 on a real wallet. V2NFTImage can resolve a
          // metadata URI itself, through gateways and the same-origin proxy.
          metaUri: meta?.uri,
          program: r.program, category: 'nft', decimals: r.decimals,
          confidential: r.confidential, hasHiddenBalance: r.hasHiddenBalance,
          mintConfidential: r.mintConfidential, mintFullyPrivate: r.mintFullyPrivate,
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
          confidential: r.confidential, hasHiddenBalance: r.hasHiddenBalance,
          mintConfidential: r.mintConfidential, mintFullyPrivate: r.mintFullyPrivate,
      };
    });

    let lastRaw: RawEntry[] = [];
    const lpMap = new Map<string, LpEntry>();
    let priceMap: Record<string, number> = seedPrices();

    (async () => {
      try {
        const [lamports, { raw }] = await Promise.all([
          withRetry(() => connection.getBalance(activeKey)),
          withRetry(() => fetchTokenBalances(connection, activeKey)),
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

        // LP tokens from the Brains LP Pairing marketplace. Without this they
        // land in "SPL · Token-2022 Tokens" as an unnamed mint, because an LP
        // mint has no metadata to resolve. Farm entries win — they carry a price.
        fetchPairingLpMints().then(async pairs => {
          if (!alive) return;
          let added = false;
          for (const p of pairs) {
            if (lpMap.has(p.lpMint)) continue;
            lpMap.set(p.lpMint, { pair: '', reward: '', lpPriceUsd: 0, mintA: p.tokenA, mintB: p.tokenB });
            added = true;
          }
          if (added) repaint();

          // Value only the pools this wallet actually holds LP for — there are
          // 10 pools and reading every one's vaults would be wasted RPC.
          const held = new Set(raw.map(x => x.mint));
          for (const p of pairs.filter(x => held.has(x.lpMint))) {
            const meta = await fetchXdexPoolState(connection, p.poolAddress).catch(() => null);
            if (!alive || !meta) continue;
            const e = lpMap.get(p.lpMint);
            const supply = Number(meta.lpSupply) / 10 ** meta.lpDecimals;
            if (!e || supply <= 0) continue;
            const sub = (v: bigint, f: bigint) => (v > f ? v - f : 0n);
            const net0 = Number(sub(meta.vault0, meta.fees0)) / 10 ** meta.dec0;
            const net1 = Number(sub(meta.vault1, meta.fees1)) / 10 ** meta.dec1;
            // The pairing record's A/B order is not guaranteed to match the
            // pool's token0/token1 order — match by mint, never by position.
            const aIsToken0 = meta.token0Mint === e.mintA;
            lpMap.set(p.lpMint, {
              ...e,
              resA: aIsToken0 ? net0 : net1,
              resB: aIsToken0 ? net1 : net0,
              lpSupplyUi: supply,
            });
            repaint();
          }
        }).catch(() => {});

        const owner = activeKey.toBase58();
        fetchAllListings(connection).then(listings => {
          if (!alive) return;
          const mine = new Map<string, number>();
          for (const l of listings) { if (l.seller === owner) mine.set(l.nftMint, l.price); }
          myListingsRef.current = mine;
          repaint();
        }).catch(() => {});

        // Fungible tokens only — an NFT has no price feed entry, and in a wallet
        // with 100+ NFTs they consumed the whole budget before a single real
        // token was priced.
        const unknownMints = raw
          .filter(r => !isNftLike(r) && !priceMap[r.mint] && !KNOWN[r.mint])
          .map(r => r.mint)
          .slice(0, PRICE_LOOKUP_CAP);
        runThrottled(unknownMints.map(m => async () => {
          const p = await withRetry(() => fetchPrice(m));
          if (!alive || p <= 0) return;
          priceMap = { ...priceMap, [m]: p };
          repaint();
        }), 4);

        const needMetaAll = raw.filter(r => {
          if (isNftLike(r)) return true;
          if (KNOWN[r.mint]?.logo) return false;
          if (metaMap.current.has(r.mint) && getCachedTokenLogo(r.mint)) return false;
          return true;
        });
        // Fungible tokens first. They drive the symbol, price and value columns,
        // and ordering by the raw RPC listing meant a big NFT collection could
        // push every token past the cap.
        const needMeta = [
          ...needMetaAll.filter(r => !isNftLike(r)),
          ...needMetaAll.filter(r => isNftLike(r)),
        ].slice(0, META_LOOKUP_CAP);
        runThrottled(needMeta.map(r => async () => {
          const meta = await withRetry(() => fetchTokenMeta(r.mint));
          if (!alive || !meta) return;
          let touched = false;
          if (meta.logo) { setCachedTokenLogo(r.mint, meta.logo); touched = true; }
          const sym = meta.symbol;
          const name = meta.name;
          const looksReal = (s?: string) =>
            !!s && s.length > 0
            && s !== r.mint.slice(0, 6)
            && s !== r.mint.slice(0, 8)
            && s !== r.mint.slice(0, 4).toUpperCase();
          if (looksReal(sym) || looksReal(name) || meta.uri) {
            metaMap.current.set(r.mint, { symbol: sym, name, uri: meta.uri });
            touched = true;
          }
          if (touched) repaint();
        }), 4);

        getPortfolioSnapshots(activeKey.toBase58()).then(snaps => {
          if (alive) setSnapshots(snaps);
        }).catch(() => {});
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message ?? 'Failed to load balances');
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activeKey, connection, reloadNonce]);

  const xntHolding: Holding | null = activeKey
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
    if (isReadOnly || !publicKey || netWorth <= 0 || allRows.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    upsertPortfolioSnapshot({
      wallet: publicKey.toBase58(),
      snapshot_date: today,
      total_usd: netWorth,
      token_breakdown: allRows.map(h => ({ mint: h.mint, symbol: h.symbol, balance: h.balance, usd: h.usd ?? 0, price: prices[h.mint] || 0 })),
    }).catch(() => {});
  }, [isReadOnly, publicKey, netWorth, allRows, prices]);

  // Live clock
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const utc = new Date(now).toISOString().slice(11, 19);

  // Every group is sorted best-first so the collapsed preview really is the top
  // N. Tokens rank by USD value; NFTs mostly have no USD price, so they rank by
  // listed price and then alphabetically, which keeps the order stable.
  const byUsd = (a: Holding, b: Holding) => (b.usd ?? 0) - (a.usd ?? 0);
  const byNft = (a: Holding, b: Holding) =>
    (b.listedPrice ?? -1) - (a.listedPrice ?? -1) || a.symbol.localeCompare(b.symbol);

  const groups: Array<{ key: Category; label: string; rows: Holding[]; accent: string }> = [
    { key: 'core',  label: 'Ecosystem · Core',  accent: C_ORANGE,
      rows: allRows.filter(h => h.category === 'core')
        .sort((a, b) => (a.mint === XNT_MINT ? -1 : b.mint === XNT_MINT ? 1 : byUsd(a, b))) },
    { key: 'other', label: 'SPL · Token-2022 Tokens', rows: allRows.filter(h => h.category === 'other').sort(byUsd), accent: C_GRAY },
    { key: 'lp',    label: 'LP Tokens',         rows: allRows.filter(h => h.category === 'lp').sort(byUsd),    accent: C_SILVER },
    { key: 'nft',   label: 'NFTs · Collectibles', rows: allRows.filter(h => h.category === 'nft').sort(byNft), accent: C_PURPLE },
  ].filter(g => g.rows.length > 0);

  // Manual snapshot
  const handleSaveSnapshot = async () => {
    if (isReadOnly || !publicKey || netWorth <= 0 || allRows.length === 0) return;
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

  // "Holdings by USD" is a ranked SUMMARY — the complete list is the holdings
  // table below it, so this one hard-caps rather than offering an expander.
  const RANK_LIMIT = 10;
  const rankRows = [...allRows].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const rankMax  = rankRows[0]?.usd || 1;
  const rankTop  = rankRows.slice(0, RANK_LIMIT);
  const catColor = (c: Category) => c === 'lp' ? C_SILVER : c === 'nft' ? C_PURPLE : c === 'other' ? C_GRAY : C_ORANGE;

  const hasData = !!activeKey && !loading && !err && allRows.length > 0 && netWorth > 0;

  return (
    <div className="content content-wide pfx">
      {/* ── TOP BAR ── */}
      <div className="pfx-topbar">
        <div className="pfx-title">PORTFOLIO<span>ANALYTICS · X1 MAINNET</span></div>
        <div className="pfx-tb-right">
          <span className="pfx-clock num">{utc} UTC</span>
          {connected && !isReadOnly && netWorth > 0 && (
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
          walletAddress={activeKey?.toBase58() ?? null}
          burnedTotal={0}
          labWorkPts={0}
          isMobile={isMobile}
        />
      )}

      {/* ── WATCH MODE BANNER ── */}
      {isReadOnly && (
        <div className="pfx-watchbar">
          <div className="pfx-watchbar-l">
            <span className="eye">◉</span>
            <div>
              <div className="t">WATCH MODE · READ ONLY</div>
              <div className="s num">
                Viewing {shortAddr(watchAddress, 6, 6)} · send &amp; snapshot are disabled
              </div>
            </div>
          </div>
          <button type="button" className="pfx-btn" onClick={handleStopWatching}>✕ STOP WATCHING</button>
        </div>
      )}

      {/* ── NO WALLET ON SCREEN — offer the watch lookup instead of an empty page ── */}
      {!activeKey && (
        <div className="pfx-panel pfx-watch">
          <div className="glyph">◉</div>
          <h3>TRACK ANY WALLET</h3>
          <p>
            Paste any <b>X1 wallet address</b> to view its full portfolio — tokens, NFTs,
            LP positions and net worth. No wallet connection required.
          </p>
          <div className="pfx-watch-form">
            <input
              type="text"
              value={watchInput}
              spellCheck={false}
              autoComplete="off"
              onChange={e => { setWatchInput(e.target.value); setWatchInputError(''); }}
              onKeyDown={e => { if (e.key === 'Enter') handleWatchSubmit(); }}
              placeholder="Paste wallet address…"
              className={watchInputError ? 'bad' : ''}
            />
            <button
              type="button"
              className="pfx-btn primary"
              disabled={!watchInput.trim()}
              onClick={handleWatchSubmit}
            >
              ◉ WATCH
            </button>
          </div>
          {watchInputError && <div className="pfx-watch-err">{watchInputError}</div>}
          <div className="pfx-watch-foot">…or connect your own wallet to see your holdings and send tokens.</div>
        </div>
      )}

      {/* ── LOADING ── */}
      {activeKey && loading && allRows.length === 0 && <PortfolioLoader />}

      {/* ── ERROR ── */}
      {activeKey && !loading && err && (
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
      {activeKey && !loading && !err && allRows.length === 0 && (
        <div className="pfx-panel"><div className="pfx-place">
          <div className="glyph">◌</div>
          <div className="sub">No tokens detected for this wallet.</div>
        </div></div>
      )}

      {/* ── ADD A PRIVATE TOKEN ──────────────────────────────────────────
          The holdings table can only list accounts that exist. A wallet
          that has never received a given token has no row for it, and for a
          ConfidentialMintBurn token nobody can send you one to create that
          row, because the transfer needs a key you have not registered yet.
          Pasting the mint is the only way in from a cold start. */}
      {!isReadOnly && wallet && !loading && (
        <div className="pfx-panel pfx-find">
          <div className="pfx-phead" style={{ padding: '14px 18px 10px' }}>
            <h3><span className="tk" />Add a private token</h3>
            <span className="pfx-sub">hold a token privately, even one you've never received</span>
          </div>
          <div className="pfx-find-body">
            <div className="pfx-find-form">
              <input
                type="text" value={findInput} spellCheck={false} autoComplete="off"
                placeholder="Paste a token mint address…"
                onChange={e => { setFindInput(e.target.value); setFound(null); }}
                onKeyDown={e => { if (e.key === 'Enter') handleFindToken(findInput); }}
              />
              <button type="button" className="pfx-btn primary"
                disabled={!findInput.trim() || finding}
                onClick={() => handleFindToken(findInput)}
              >{finding ? '· · ·' : 'CHECK'}</button>
            </div>

            <div className="pfx-find-known">
              {KNOWN_CONFIDENTIAL.map(k => (
                <button key={k.mint} type="button" className="pfx-chip"
                  onClick={() => { setFindInput(k.mint); handleFindToken(k.mint); }}
                >{k.label}</button>
              ))}
            </div>

            {found && 'error' in found && <div className="pfx-find-err">{found.error}</div>}

            {found && !('error' in found) && (
              <div className="pfx-find-card">
                {found.logo
                  ? <img className="pfx-find-logo" src={found.logo} alt=""
                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                  : <div className="pfx-find-logo ph">{found.symbol.slice(0, 2).toUpperCase()}</div>}
                <div className="pfx-find-id">
                  <div className="sym">
                    {found.symbol}
                    <span className={`pfx-badge ${found.fully ? 'b-p' : 'b-n'}`}>
                      {found.fully ? '◉◉ FULLY PRIVATE' : '◉ PRIVATE'}
                    </span>
                  </div>
                  <div className="sub num">
                    {found.name && found.name !== found.symbol ? `${found.name} · ` : ''}
                    {shortAddr(found.mint, 6, 6)}
                  </div>
                </div>
                {found.configured ? (
                  <span className="pfx-badge b-g">ALREADY ENABLED</span>
                ) : (
                  <button type="button" className="pfx-btn primary"
                    disabled={enabling === found.mint}
                    onClick={() => handleEnablePrivate(found.mint)}
                  >{enabling === found.mint ? '· · ·'
                    : found.hasAccount ? '🔓 ENABLE' : '🔓 CREATE + ENABLE'}</button>
                )}
              </div>
            )}

            {found && !('error' in found) && enableMsg?.mint === found.mint && (
              <div className={`pfx-enable-msg${enableMsg.bad ? ' bad' : ''}`} style={{ padding: '8px 0 0' }}>
                {enableMsg.text}
              </div>
            )}
          </div>
        </div>
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
              <div className="pfx-phead"><h3><span className="tk" />Holdings by USD</h3><span className="pfx-sub num">{allRows.length > RANK_LIMIT ? `top ${RANK_LIMIT} of ${allRows.length}` : 'ranked'}</span></div>
              <div className="pfx-rank">
                {rankTop.map((h, i) => {
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

                {(expandedGroups[g.key] ? g.rows : g.rows.slice(0, GROUP_PREVIEW)).map(h => {
                  const price = h.unitUsd ?? prices[h.mint] ?? 0;
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
                            {/* Two facts, two badges: what the TOKEN is, then
                                where THIS holder stands with it. */}
                            {h.mintFullyPrivate ? (
                              <span className="pfx-badge b-p"
                                title="Fully private: ConfidentialTransfer + ConfidentialMintBurn. Transfer amounts, balances AND total supply are encrypted, and there is no public balance at all — the program rejects mint, deposit and withdraw to a public balance.">
                                ◉◉ FULLY PRIVATE
                              </span>
                            ) : h.mintConfidential ? (
                              <span className="pfx-badge b-n"
                                title="Supports Token-2022 confidential transfers: amounts can be hidden, but supply and the public/confidential bridge stay visible.">
                                ◉ PRIVATE
                              </span>
                            ) : null}
                            {/* Once revealed the figure moves to its own strip
                                below the row — a balance does not belong in an
                                8.5px uppercase badge. */}
                            {h.hasHiddenBalance && revealed[h.mint] ? null
                             : h.hasHiddenBalance ? (
                              !isReadOnly && wallet ? (
                                <button type="button" className="pfx-badge b-g pfx-reveal"
                                  disabled={revealing === h.mint}
                                  title="Decrypt your balance in this browser. One signature; the key never leaves memory."
                                  onClick={() => handleReveal(h.mint)}
                                >{revealing === h.mint ? '· · · DECRYPTING' : '◉ BALANCE HIDDEN · REVEAL'}</button>
                              ) : (
                                <span className="pfx-badge b-g"
                                  title="An encrypted balance is held here. Only the holder can read the amount.">
                                  BALANCE HIDDEN
                                </span>
                              )
                            ) : h.confidential ? (
                              <span className="pfx-badge b-g"
                                title="Confidential transfers are configured on this account, but nothing is hidden in it yet.">
                                READY
                              </span>
                            ) : null}
                            {h.kind === 'ecosystem' && <span className="pfx-badge b-o">ECOSYSTEM</span>}
                            {h.kind === 'x1native' && <span className="pfx-badge b-o">X1 NATIVE</span>}
                          </div>
                          <div className="pfx-meta">
                            <span className="prog">{h.program === 't22' ? 'TOKEN-2022' : 'SPL'}</span>·
                            <span className="mint" title={h.mint}>{shortAddr(h.mint, 4, 4)}</span>
                            <CopyButton value={h.mint} title={`Copy ${h.symbol} address`} />
                          </div>
                          {/* Below 1000px the BALANCE column is hidden to fit the row, which
                              left "how many do I hold?" answerable only by opening SEND.
                              Same number, surfaced inline instead of as a column. */}
                          <div className="pfx-bal-inline num">
                            {fmtNum(h.balance, h.balance < 1 ? 4 : 2)} <span className="u">{h.symbol}</span>
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
                        {/* Enabling is only possible for the CONNECTED wallet —
                            ConfigureAccount must be signed by the account owner,
                            so this is deliberately absent in watch mode. */}
                        {/* A token can carry a public AND a private balance at
                            the same time, so these are independent buttons
                            rather than one slot — collapsing them would take
                            public SEND away the moment a balance was revealed. */}
                        {!isReadOnly && wallet
                          ? <div className="pfx-acts">
                              {(h.mintConfidential || h.mintFullyPrivate) && !h.confidential && (
                                <button
                                  type="button"
                                  className="pfx-send enable-private"
                                  disabled={enabling === h.mint}
                                  title="Register an encryption key on this account so it can hold a private balance. One signature, one transaction."
                                  onClick={() => handleEnablePrivate(h.mint)}
                                >{enabling === h.mint ? '· · ·' : '🔓 ENABLE'}</button>
                              )}
                              {revealed[h.mint] && revealed[h.mint].available > 0n && (
                                <button
                                  type="button"
                                  className="pfx-send enable-private"
                                  title="Send this balance to another wallet. The amount stays encrypted on chain."
                                  onClick={() => {
                                    setPrivSendMint(m => m === h.mint ? null : h.mint);
                                    setPrivMsg(null); setActiveSendMint(null);
                                  }}
                                >{privSendMint === h.mint ? '✕ CLOSE' : '◈ SEND PRIVATELY'}</button>
                              )}
                              {h.balance > 0 && (
                                <button type="button" className="pfx-send"
                                  onClick={() => { setActiveSendMint(m => m === h.mint ? null : h.mint); setPrivSendMint(null); }}
                                >{isActive ? '✕ CLOSE' : 'SEND'}</button>
                              )}
                            </div>
                          : <span />}
                      </div>
                      {enableMsg?.mint === h.mint && (
                        <div className={`pfx-enable-msg${enableMsg.bad ? ' bad' : ''}`}>{enableMsg.text}</div>
                      )}
                      {revealErr[h.mint] && (
                        <div className="pfx-enable-msg bad">{revealErr[h.mint]}</div>
                      )}
                      {revealed[h.mint] && (
                        <div className="pfx-bal-strip">
                          <div className="pfx-bal-main">
                            <span className="lab">◈ PRIVATE BALANCE</span>
                            <span className="amt">
                              {fmtUnits(revealed[h.mint].available, h.decimals)}
                              <em>{h.symbol}</em>
                            </span>
                          </div>
                          {revealed[h.mint].pendingCredits > 0 && (
                            <div className="pfx-bal-pending">
                              <span>
                                ↓ {revealed[h.mint].pendingKnown
                                     ? `${fmtUnits(revealed[h.mint].pending, h.decimals)} ${h.symbol}`
                                     : `${revealed[h.mint].pendingCredits} transfer${revealed[h.mint].pendingCredits > 1 ? 's' : ''}`}
                                {' '}received — not spendable until applied
                              </span>
                              <button type="button" className="pfx-btn primary sm"
                                disabled={applying === h.mint}
                                onClick={() => handleApplyPending(h.mint)}
                              >{applying === h.mint ? '· · ·' : 'APPLY'}</button>
                            </div>
                          )}
                        </div>
                      )}
                      {privSendMint === h.mint && !isReadOnly && wallet && (
                        <div className="pfx-priv-send">
                          <div className="pfx-priv-head">
                            ◈ PRIVATE SEND
                            <span>amount encrypted · recipient must have enabled {h.symbol}</span>
                          </div>
                          <input
                            type="text" spellCheck={false} autoComplete="off"
                            placeholder="Recipient wallet address…"
                            value={privTo} onChange={e => { setPrivTo(e.target.value); setPrivMsg(null); }}
                          />
                          <div className="pfx-priv-row">
                            <input
                              type="text" inputMode="decimal" spellCheck={false}
                              placeholder="0.0"
                              value={privAmt} onChange={e => { setPrivAmt(e.target.value); setPrivMsg(null); }}
                            />
                            <button type="button" className="pfx-chip"
                              onClick={() => setPrivAmt(
                                (Number(revealed[h.mint].available) / 10 ** h.decimals).toFixed(h.decimals)
                                  .replace(/\.?0+$/, ''))}
                            >MAX</button>
                            <button type="button" className="pfx-btn primary"
                              disabled={privBusy || !privTo.trim() || !privAmt.trim()}
                              onClick={() => handlePrivateSend(h.mint, h.decimals)}
                            >{privBusy ? '· · ·' : 'SEND'}</button>
                          </div>
                          <div className="pfx-priv-foot">
                            Spendable: {fmtNum(Number(revealed[h.mint].available) / 10 ** h.decimals, h.decimals)} {h.symbol}
                            {' · '}four transactions, one approval — the proofs are too large for one
                          </div>
                          {privMsg && (
                            <div className={`pfx-enable-msg${privMsg.bad ? ' bad' : ''}`}>{privMsg.text}</div>
                          )}
                        </div>
                      )}
                      {isActive && !isReadOnly && wallet && (
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

                {g.rows.length > GROUP_PREVIEW && (
                  <button
                    type="button"
                    className="pfx-more"
                    style={{ color: g.accent, borderColor: `${g.accent}44` }}
                    onClick={() => setExpandedGroups(m => ({ ...m, [g.key]: !m[g.key] }))}
                  >
                    {expandedGroups[g.key]
                      ? `▴  COLLAPSE · SHOW TOP ${GROUP_PREVIEW}`
                      : `▾  SHOW ALL ${g.rows.length} · ${g.rows.length - GROUP_PREVIEW} HIDDEN`}
                  </button>
                )}
              </div>
            ))}
          </div>

        </>
      )}
    </div>
  );
}
