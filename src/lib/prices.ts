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

// ── On-chain fallback (10-06: api.xdex.xyz stopped answering, every price went to $—) ──
// Prices straight from xDEX pool reserves over the X1 RPC: XNT from the XNT/USDC.X pool,
// BRAINS and LB from their XNT pools. CP-swap pool layout: token0_vault @72, token1_vault
// @104, token0_mint @168, token1_mint @200 (vault balances include a few un-swept protocol
// fees — close enough for a display price).
const X1_RPC = 'https://rpc.mainnet.x1.xyz';
const XNT_USDC_POOL = 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR';
const XNT_PAIR_POOL: Record<string, string> = {
  [BRAINS_MINT]: '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg',
  [LB_MINT]:     'CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK',
};
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: Uint8Array): string {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
async function x1rpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(X1_RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8_000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
/** XNT-per-token (or USDC-per-XNT for the USDC pool) from a pool's two vaults. */
async function poolRatio(pool: string, baseMint: string): Promise<number> {
  const info = await x1rpc('getAccountInfo', [pool, { encoding: 'base64' }]);
  const d = Uint8Array.from(atob(info.value.data[0]), c => c.charCodeAt(0));
  const v0 = b58(d.slice(72, 104)), v1 = b58(d.slice(104, 136)), m0 = b58(d.slice(168, 200));
  const [a, b] = await Promise.all([x1rpc('getTokenAccountBalance', [v0]), x1rpc('getTokenAccountBalance', [v1])]);
  const amt0 = Number(a.value.uiAmount), amt1 = Number(b.value.uiAmount);
  // price of baseMint in the other token
  return m0 === baseMint ? amt1 / amt0 : amt0 / amt1;
}
async function chainPrice(mint: string): Promise<number> {
  try {
    const xntUsd = await poolRatio(XNT_USDC_POOL, XNT_MINT);
    if (mint === XNT_MINT) return xntUsd;
    const pool = XNT_PAIR_POOL[mint];
    if (!pool) return 0;
    return (await poolRatio(pool, mint)) * xntUsd;
  } catch { return 0; }
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
      return p;
    }
    throw new Error('no price from xDEX');
  } catch {
    // xDEX down / slow / empty → read the pool reserves on chain
    const p = await chainPrice(mint);
    if (p > 0) { cache.set(mint, { price: p, ts: Date.now() }); persist(); return p; }
    return cache.get(mint)?.price ?? 0;
  }
}

/** Always asks the network (xDEX, then pool reserves on chain) — never returns a stale
 *  cached price unless both fail. For places that show a $ estimate next to a trade. */
export async function fetchPriceFresh(mint: string): Promise<number> {
  if (_inflight.has(mint)) return _inflight.get(mint)!;
  const job = _fetchPriceUncached(mint).finally(() => _inflight.delete(mint));
  _inflight.set(mint, job);
  return job;
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
