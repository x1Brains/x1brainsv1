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
// All three prices from ONE getMultipleAccounts call (the six vault balances); the pools' vault
// addresses are read once per session. Shared + memoised for 15 s so the three tokens and the
// ticker's refresh don't each hit the RPC.
type PoolVaults = { v0: string; v1: string; m0: string };
let _vaults: Record<string, PoolVaults> | null = null;
let _chainMemo: { ts: number; job: Promise<Record<string, number>> } | null = null;
async function poolVaults(): Promise<Record<string, PoolVaults>> {
  if (_vaults) return _vaults;
  const pools = [XNT_USDC_POOL, ...Object.values(XNT_PAIR_POOL)];
  const res = await x1rpc('getMultipleAccounts', [pools, { encoding: 'base64' }]);
  const out: Record<string, PoolVaults> = {};
  res.value.forEach((acc: any, i: number) => {
    if (!acc) return;
    const d = Uint8Array.from(atob(acc.data[0]), c => c.charCodeAt(0));
    out[pools[i]] = { v0: b58(d.slice(72, 104)), v1: b58(d.slice(104, 136)), m0: b58(d.slice(168, 200)) };
  });
  return (_vaults = out);
}
async function chainPrices(): Promise<Record<string, number>> {
  if (_chainMemo && Date.now() - _chainMemo.ts < 15_000) return _chainMemo.job;
  const job = (async () => {
    const pv = await poolVaults();
    const order = Object.keys(pv);
    const vaults = order.flatMap(k => [pv[k].v0, pv[k].v1]);
    const res = await x1rpc('getMultipleAccounts', [vaults, { encoding: 'jsonParsed' }]);
    const amt = (i: number) => Number(res.value[i]?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
    // price of `base` in the pool's other token
    const ratio = (pool: string, base: string) => {
      const i = order.indexOf(pool); if (i < 0) return 0;
      const a0 = amt(2 * i), a1 = amt(2 * i + 1); if (!a0 || !a1) return 0;
      return pv[pool].m0 === base ? a1 / a0 : a0 / a1;
    };
    const xntUsd = ratio(XNT_USDC_POOL, XNT_MINT);
    const out: Record<string, number> = { [XNT_MINT]: xntUsd };
    for (const [mint, pool] of Object.entries(XNT_PAIR_POOL)) out[mint] = xntUsd ? ratio(pool, mint) * xntUsd : 0;
    return out;
  })();
  _chainMemo = { ts: Date.now(), job };
  job.catch(() => { _chainMemo = null; });
  return job;
}
async function chainPrice(mint: string): Promise<number> {
  try { return (await chainPrices())[mint] || 0; } catch { return 0; }
}

async function _fetchPriceUncached(mint: string): Promise<number> {
  // xDEX and the chain race. xDEX wins if it answers within 1.2 s (its price is the one the
  // site always showed); otherwise the chain's pool-reserve price is used straight away and a
  // late xDEX answer still refreshes the cache. 10-06: api.xdex.xyz took 10-15 s, the ticker
  // waited 6 s per token before ever asking the chain.
  const save = (p: number) => { if (p > 0) { cache.set(mint, { price: p, ts: Date.now() }); persist(); } return p; };
  const xdex = (async () => {
    // network MUST be %20-encoded, not '+' (a proxied '+' arrives as %2B → "Invalid network")
    const r = await fetch(`${XDEX_BASE}/token-price/price?network=X1%20Mainnet&token_address=${mint}`,
      { signal: AbortSignal.timeout(8_000) });
    const j = await r.json();
    return Number(j?.data?.price) || 0;
  })().catch(() => 0);
  const quick = await Promise.race([xdex, new Promise<number>(r => setTimeout(() => r(-1), 1_200))]);
  if (quick > 0) return save(quick);
  const chain = await chainPrice(mint);
  if (chain > 0) { xdex.then(p => { if (p > 0) save(p); }); return save(chain); }
  const late = await xdex;                    // chain failed too — give xDEX its full timeout
  if (late > 0) return save(late);
  return cache.get(mint)?.price ?? 0;
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
