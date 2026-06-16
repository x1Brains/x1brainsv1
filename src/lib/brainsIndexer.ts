// BrainsIndexer — thin wrapper around xDEX's pool/list + chart/history endpoints.
//
// Single source of truth for everything DEX-side: pool addresses, LP mints,
// token logos, USD prices, TVL, 24h volume, APR, fees, holder counts, OHLCV
// bars per pair. One 60s in-memory cache + 5min localStorage fallback so the
// dashboard paints instantly on reload and we never spam api.xdex.xyz.
//
// What it does NOT cover:
//   • Off-DEX token logos (use lib/tokenLogos.ts → Token-2022 ext + Metaplex PDA)
//   • NFT metadata (Solaris indexer + V2NFTImage)
//   • Wallet balances + on-chain accounts (RPC)
//   • Burn events (chainBurns.ts on-chain scan)
//   • LP positions (LpFarms fetchPositions)

export interface IndexerTokenSide {
  address:           string;
  symbol:            string;
  logo?:             string;
  price:             number;
  volume_24h?:       number;
  volume_usd_24h?:   number;
  fee_24h?:          number;
}

export interface IndexerPool {
  pool_address:           string;
  lp_mint:                string;
  lp_price:               number;
  lp_fee_24h:             number;
  lp_token_holder_count:  number;
  token1:                 IndexerTokenSide;
  token2:                 IndexerTokenSide;
  tvl:                    number;
  apr_24h:                number;
  txns_24h:               number;
  createdAt:              string;
}

export interface IndexerTotals {
  volume_24h_usd: number;
  tvl:            number;
  pools_count:    number;   // lifetime created
  total_holders:  number;
  total_tx:       number;
}

export interface IndexerSnapshot {
  totals:  IndexerTotals;
  pools:   IndexerPool[];
  /** Pools currently active (TVL > 0). totals.pools_count includes empty/closed ones. */
  active:  number;
  /** ISO timestamp when this snapshot landed. */
  ts:      number;
}

// xDEX doesn't send CORS headers — go through the Vite dev proxy at
// /api/xdex-price (configured in vite.config.ts → strips prefix, forwards
// to api.xdex.xyz). Same path works for prod once the same rewrite is
// added at the edge (vercel.json or a CF worker).
const URL = '/api/xdex-price/api/xendex/pool/list?network=X1%20Mainnet';
const MEM_TTL_MS    = 60_000;          // fresh window — no network
const LS_TTL_STALE  = 30 * 60_000;     // stale window — show + refresh in background
const LS_TTL_HARD   = 24 * 60 * 60_000; // hard cutoff — older than this, ignore LS
const LS_KEY     = 'v2_brains_indexer_v1';

let _mem: IndexerSnapshot | null = null;
let _inflight: Promise<IndexerSnapshot | null> | null = null;

// Seed memory from localStorage at module init so first paint is instant
(function seed() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw) as IndexerSnapshot;
    // Accept anything under the hard 24h cutoff — older than that is more
    // likely to be wrong than useful. Anything stale (>30min) will still get
    // a background refresh kicked off by fetchIndexerSnapshot below.
    if (parsed?.ts && Date.now() - parsed.ts < LS_TTL_HARD) _mem = parsed;
  } catch {}
})();

function persist(s: IndexerSnapshot) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

export function getCachedIndexerSnapshot(): IndexerSnapshot | null {
  return _mem;
}

export async function fetchIndexerSnapshot(): Promise<IndexerSnapshot | null> {
  // Fresh memory wins — no network at all
  if (_mem && Date.now() - _mem.ts < MEM_TTL_MS) return _mem;

  // Stale-while-revalidate: if we have ANY cached snapshot under the stale
  // window, kick off a background refresh and return it immediately. The
  // caller paints from cache; UI updates when fresh data arrives via the
  // next consumer-side poll.
  if (_mem && Date.now() - _mem.ts < LS_TTL_STALE && !_inflight) {
    const stale = _mem;
    _inflight = (async () => {
      try {
        const r = await fetch(URL, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return stale;
        const j = await r.json();
        if (!j?.success || !j?.data) return stale;
        // … same parsing as the cold path below. Inline minimally:
        return await _parseAndStore(j);
      } catch { return stale; }
      finally { _inflight = null; }
    })();
    return stale;
  }

  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const r = await fetch(URL, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`pool/list ${r.status}`);
      const j = await r.json();
      return await _parseAndStore(j);
    } catch {
      // On error: fall back to stale memory if we have one (better than nothing)
      return _mem ?? null;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// Parse a raw xDEX pool/list response into our IndexerSnapshot shape, then
// commit it to mem + LS. Shared between the cold path and the background
// stale-while-revalidate refresh.
async function _parseAndStore(j: any): Promise<IndexerSnapshot | null> {
  if (!j?.success || !j?.data) return _mem;
  const totals: IndexerTotals = {
    volume_24h_usd: Number(j.total_info?.volume_24h_usd) || 0,
    tvl:            Number(j.total_info?.tvl)            || 0,
    pools_count:    Number(j.total_info?.pools_count)    || 0,
    total_holders:  Number(j.total_info?.total_holders)  || 0,
    total_tx:       Number(j.total_info?.total_tx)       || 0,
  };
  const pools: IndexerPool[] = (j.data as any[]).map(p => ({
    pool_address:           String(p.pool_address ?? ''),
    lp_mint:                String(p.lp_mint ?? ''),
    lp_price:               Number(p.lp_price) || 0,
    lp_fee_24h:             Number(p.lp_fee_24h) || 0,
    lp_token_holder_count:  Number(p.lp_token_holder_count) || 0,
    token1: {
      address:         String(p.token1_address ?? ''),
      symbol:          String(p.token1_symbol ?? ''),
      logo:            p.token1_logo,
      price:           Number(p.token1_price) || 0,
      volume_24h:      Number(p.token1_volume_24h) || 0,
      volume_usd_24h:  Number(p.token1_volume_usd_24h) || 0,
      fee_24h:         Number(p.token1_fee_24h) || 0,
    },
    token2: {
      address:         String(p.token2_address ?? ''),
      symbol:          String(p.token2_symbol ?? ''),
      logo:            p.token2_logo,
      price:           Number(p.token2_price) || 0,
      volume_24h:      Number(p.token2_volume_24h) || 0,
      volume_usd_24h:  Number(p.token2_volume_usd_24h) || 0,
      fee_24h:         Number(p.token2_fee_24h) || 0,
    },
    tvl:        Number(p.tvl) || 0,
    apr_24h:    Number(p.apr_24h) || 0,
    txns_24h:   Number(p.txns_24h) || 0,
    createdAt:  String(p.createdAt ?? ''),
  }));
  const active = pools.filter(p => p.tvl > 0).length;
  const snap: IndexerSnapshot = { totals, pools, active, ts: Date.now() };
  _mem = snap;
  persist(snap);
  return snap;
}

/** Pools sorted by TVL desc — useful for "top pairs" tiles. */
export function topPoolsByTvl(snap: IndexerSnapshot, n = 5): IndexerPool[] {
  return [...snap.pools].filter(p => p.tvl > 0).sort((a, b) => b.tvl - a.tvl).slice(0, n);
}

/** Pools where one side is BRAINS — ecosystem-only view. */
export function brainsPools(snap: IndexerSnapshot): IndexerPool[] {
  return snap.pools.filter(p =>
    p.token1.symbol === 'BRAINS' || p.token2.symbol === 'BRAINS'
  );
}

// ═════════════════════════════════════════════════════════════════
// OHLCV chart-history endpoint with 429-aware throttle.
// Same state machine x1prism uses — without this you get rate-limited.
// ═════════════════════════════════════════════════════════════════

export interface OhlcvBar { o: number; h: number; l: number; c: number; v: number; t: number; }

const CHART_URL = '/api/xdex-price/api/xendex/chart/history';
const _chartCache = new Map<string, { bars: OhlcvBar[]; ts: number }>();
const _chartInflight = new Map<string, Promise<OhlcvBar[]>>();
const CHART_TTL_MS = 60_000;

// 429-aware throttle: after a 429, pause ALL chart fetches until the window expires.
let _chartBlockedUntil = 0;
const CHART_BLOCK_MS = 60_000;
// Per-minute cap of in-flight chart requests
const CHART_CAP_PER_MIN = 20;
let _chartWindowStart = 0;
let _chartWindowCount = 0;

function chartKey(from: string, to: string, hoursBack: number): string {
  return `${from}|${to}|${hoursBack}`;
}

export async function fetchChartHistory(
  fromToken: string,
  toToken: string,
  hoursBack: number = 24,
): Promise<OhlcvBar[]> {
  const key = chartKey(fromToken, toToken, hoursBack);
  const cached = _chartCache.get(key);
  if (cached && Date.now() - cached.ts < CHART_TTL_MS) return cached.bars;
  const inflight = _chartInflight.get(key);
  if (inflight) return inflight;
  if (Date.now() < _chartBlockedUntil) return cached?.bars ?? [];

  // Per-minute throttle window
  const now = Date.now();
  if (now - _chartWindowStart > 60_000) {
    _chartWindowStart = now;
    _chartWindowCount = 0;
  }
  if (_chartWindowCount >= CHART_CAP_PER_MIN) return cached?.bars ?? [];
  _chartWindowCount++;

  const time_to   = Math.floor(now / 1000);
  const time_from = time_to - hoursBack * 3600;
  const url = `${CHART_URL}?network=X1%20Mainnet&from_token=${fromToken}&to_token=${toToken}&time_from=${time_from}&time_to=${time_to}`;

  const job = (async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (r.status === 429) {
        _chartBlockedUntil = Date.now() + CHART_BLOCK_MS;
        return cached?.bars ?? [];
      }
      if (!r.ok) return cached?.bars ?? [];
      const j = await r.json();
      // xDex chart/history has gone through a couple of response shapes —
      // accept any of {bars, data.bars, data, results, history}. Bail to the
      // cached set rather than persisting an empty array (so the next call
      // re-fetches instead of trusting `[]`).
      const candidates: any[] = [
        j?.bars, j?.data?.bars, j?.data, j?.results, j?.history, j,
      ];
      let bars: OhlcvBar[] = [];
      for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0 && typeof c[0]?.c === 'number') {
          bars = c as OhlcvBar[];
          break;
        }
      }
      if (bars.length === 0) {
        // Visible in DevTools when the upstream shape changes. Without this,
        // a silent "[]" return looked like "chart is loading" forever.
        console.warn('[chart] empty bars from', url, 'keys:', Object.keys(j ?? {}));
        return cached?.bars ?? [];
      }
      _chartCache.set(key, { bars, ts: Date.now() });
      return bars;
    } catch {
      return cached?.bars ?? [];
    } finally {
      _chartInflight.delete(key);
    }
  })();
  _chartInflight.set(key, job);
  return job;
}

/** 24h % change derived from chart bars. Last close vs first close. */
export function pctChange24h(bars: OhlcvBar[]): number | null {
  if (bars.length < 2) return null;
  const first = bars[0].c;
  const last  = bars[bars.length - 1].c;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}

// ═════════════════════════════════════════════════════════════════
// Top movers — derive from per-pool token prices (no extra calls).
// We can't compute 24h % without OHLCV, but we can rank pools by
// 24h volume / fee growth as a proxy "heat" metric.
// ═════════════════════════════════════════════════════════════════

export interface MoverEntry {
  pool:     IndexerPool;
  symbol:   string;   // token2 symbol (the non-XNT side, usually)
  logo?:    string;
  vol24:    number;
  tvl:      number;
  apr:      number;
  heat:     number;   // composite score
}

export function topMoversByVolume(snap: IndexerSnapshot, n = 5): MoverEntry[] {
  return snap.pools
    .filter(p => p.tvl > 0)
    .map(p => {
      // Use the side whose symbol isn't WXNT/XNT — that's the "interesting" token
      const interesting = p.token1.symbol === 'XNT' || p.token1.symbol === 'WXNT'
        ? p.token2 : p.token1;
      const vol24 = (interesting.volume_usd_24h ?? 0);
      return {
        pool: p, symbol: interesting.symbol, logo: interesting.logo,
        vol24, tvl: p.tvl, apr: p.apr_24h,
        heat: vol24 / Math.max(1, p.tvl) * 100,  // turnover ratio %
      };
    })
    .sort((a, b) => b.vol24 - a.vol24)
    .slice(0, n);
}

// ═════════════════════════════════════════════════════════════════
// Featured pools — gist-driven editorial slots. x1prism uses
// 3 hand-curated tiles. We fall back to top-3-by-TVL if gist fails.
// ═════════════════════════════════════════════════════════════════

export interface FeaturedSlot {
  sym1:        string;
  sym2:        string;
  accent?:     string;       // accent color, defaults to v2 orange
  badge?:      string;       // optional emoji badge
  badgeLabel?: string;       // optional ribbon text
}

const FEATURED_GIST =
  'https://gist.githubusercontent.com/ShakaVibe/x1prism-featured-pools/raw/x1prism-featured-pools.json';

let _featuredCache: { slots: FeaturedSlot[]; ts: number } | null = null;
const FEATURED_TTL_MS = 10 * 60_000;

export async function fetchFeaturedPools(): Promise<FeaturedSlot[]> {
  if (_featuredCache && Date.now() - _featuredCache.ts < FEATURED_TTL_MS) {
    return _featuredCache.slots;
  }
  try {
    const r = await fetch(FEATURED_GIST, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('gist not ok');
    const j = await r.json();
    const slots: FeaturedSlot[] = [];
    for (const key of ['slot0', 'slot1', 'slot2']) {
      if (j?.[key]?.sym1 && j[key]?.sym2) {
        slots.push({
          sym1:       String(j[key].sym1),
          sym2:       String(j[key].sym2),
          accent:     j[key].accent,
          badge:      j[key].badge,
          badgeLabel: j[key].badgeLabel,
        });
      }
    }
    _featuredCache = { slots, ts: Date.now() };
    return slots;
  } catch {
    return _featuredCache?.slots ?? [];
  }
}
