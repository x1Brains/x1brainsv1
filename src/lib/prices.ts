// ─────────────────────────────────────────────
// Price feed via xDEX. Proxied in dev through vite.config (/api/xdex-price);
// in prod the same path must exist on the host (Vercel/CF worker).
//
// Stale-while-revalidate pattern: every visit returns the last known price
// from localStorage IMMEDIATELY, then refreshes in the background. Memory
// cache is 60s; localStorage cache is 24h (prices don't change so dramatically
// in a day that we'd rather paint $— than a slightly stale number).
// ─────────────────────────────────────────────

import { BRAINS_MINT } from '../constants';

const XDEX_BASE = '/api/xdex-price/api';
const LB_MINT  = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
const XNT_MINT = 'So11111111111111111111111111111111111111112';

export const TOKENS = {
  BRAINS: BRAINS_MINT,
  LB:     LB_MINT,
  XNT:    XNT_MINT,
} as const;

export type TokenSymbol = keyof typeof TOKENS;

type CacheEntry = { price: number; ts: number };
const MEM_TTL_MS  = 60_000;             // fresh window — no network during
const LS_TTL_MS   = 24 * 60 * 60_000;   // stale window — show but refresh
const LS_KEY      = 'v2_prices_v1';
const cache       = new Map<string, CacheEntry>();
const _inflight   = new Map<string, Promise<number>>();

// Seed memory from localStorage at module load so first paint is instant.
(function seedFromLS() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    if (!parsed) return;
    const now = Date.now();
    for (const [k, v] of Object.entries(parsed)) {
      if (v?.ts && now - v.ts < LS_TTL_MS && v.price > 0) {
        cache.set(k, v);
      }
    }
  } catch {}
})();

let _persistT: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (_persistT) clearTimeout(_persistT);
  _persistT = setTimeout(() => {
    try {
      const obj: Record<string, CacheEntry> = {};
      cache.forEach((v, k) => { if (v.price > 0) obj[k] = v; });
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {}
  }, 600);
}

async function _fetchPriceUncached(mint: string): Promise<number> {
  try {
    const r = await fetch(
      // network MUST be %20-encoded, not '+'. A proxied '+' arrives as a literal
      // %2B → API rejects it ("Invalid network") → we silently fall back to the
      // stale cached price, which made all three ticker prices lag. %20 matches
      // the prism/chart endpoints that were always fresh.
      `${XDEX_BASE}/token-price/price?network=X1%20Mainnet&token_address=${mint}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    const j = await r.json();
    const p = Number(j?.data?.price) || 0;
    if (p > 0) {
      cache.set(mint, { price: p, ts: Date.now() });
      persist();
    }
    return p;
  } catch {
    return cache.get(mint)?.price ?? 0;
  }
}

/**
 * Returns the cached price immediately if fresh (< 60s) or stale-but-known
 * (< 24h). Otherwise fires a fetch. Concurrent callers share a single fetch.
 */
export async function fetchPrice(mint: string): Promise<number> {
  const c = cache.get(mint);
  // Fresh hit — skip network entirely.
  if (c && Date.now() - c.ts < MEM_TTL_MS) return c.price;

  // Stale hit — kick off background refresh, return cached value now.
  if (c && Date.now() - c.ts < LS_TTL_MS && c.price > 0) {
    if (!_inflight.has(mint)) {
      const job = _fetchPriceUncached(mint).finally(() => _inflight.delete(mint));
      _inflight.set(mint, job);
    }
    return c.price;
  }

  // Cold — actually wait. Coalesce concurrent callers.
  if (_inflight.has(mint)) return _inflight.get(mint)!;
  const job = _fetchPriceUncached(mint).finally(() => _inflight.delete(mint));
  _inflight.set(mint, job);
  return job;
}

export async function fetchAllPrices(): Promise<Record<TokenSymbol, number>> {
  const entries = await Promise.all(
    (Object.entries(TOKENS) as [TokenSymbol, string][])
      .map(async ([sym, mint]) => [sym, await fetchPrice(mint)] as const),
  );
  return Object.fromEntries(entries) as Record<TokenSymbol, number>;
}

/**
 * Force a LIVE network fetch for all 3 core tokens, bypassing the stale-return
 * path. Use for the live ticker so it never shows hours-old prices. Falls back
 * to the cached value per-token only if a network call fails.
 */
export async function fetchAllPricesFresh(): Promise<Record<TokenSymbol, number>> {
  const entries = await Promise.all(
    (Object.entries(TOKENS) as [TokenSymbol, string][])
      .map(async ([sym, mint]) => {
        const p = await _fetchPriceUncached(mint);
        return [sym, p > 0 ? p : getCachedPrice(mint)] as const;
      }),
  );
  return Object.fromEntries(entries) as Record<TokenSymbol, number>;
}

/** Synchronous cache read — returns 0 if no entry. Cheap, never blocks. */
export function getCachedPrice(mint: string): number {
  return cache.get(mint)?.price ?? 0;
}

/** Sync read of all 3 core tokens — handy for initial paint. */
export function getCachedAllPrices(): Record<TokenSymbol, number> {
  return {
    BRAINS: getCachedPrice(BRAINS_MINT),
    LB:     getCachedPrice(LB_MINT),
    XNT:    getCachedPrice(XNT_MINT),
  };
}
