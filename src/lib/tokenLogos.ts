// Shared token logo lookup. Used by Portfolio, LP Pairing, Swap, etc.
//
// Resolution order — matches the landing page's pattern so every surface
// gets identical results:
//   1) Hard-coded LOGOS map (BRAINS, XNT, LB) — instant
//   2) In-memory + localStorage cache (24 h TTL)
//   3) BrainsIndexer snapshot (pre-warmed on import, sync to cache as it lands)
//   4) Full 3-layer meta fetcher (Token-2022 ext → Metaplex PDA → xDEX API)
//
// Returns null if no logo can be found. Successful results are cached in
// memory + localStorage so the next page paints instantly.

import { Connection, PublicKey } from '@solana/web3.js';

import { BRAINS_MINT, BRAINS_LOGO, XNT_LOGO, LB_LOGO, LB_MINT } from '../constants';

const XNT_MINT = 'So11111111111111111111111111111111111111112';

const LOGOS: Record<string, string> = {
  [BRAINS_MINT]: BRAINS_LOGO,
  [XNT_MINT]:    XNT_LOGO,
  ...(LB_LOGO ? { [LB_MINT]: LB_LOGO } : {}),
};

const TTL_MS  = 24 * 60 * 60 * 1000;
const LS_KEY  = 'v2_token_logos_v1';
const _cache  = new Map<string, string | null>();
const _inflight = new Map<string, Promise<string | null>>();

(function seedFromLocalStorage() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed?.ts || Date.now() - parsed.ts > TTL_MS) return;
    const obj = parsed.entries as Record<string, string | null>;
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) _cache.set(k, v);
  } catch {}
})();

let persistT: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (persistT) clearTimeout(persistT);
  persistT = setTimeout(() => {
    try {
      const entries: Record<string, string | null> = {};
      _cache.forEach((v, k) => { if (v) entries[k] = v; });
      localStorage.setItem(LS_KEY, JSON.stringify({ ts: Date.now(), entries }));
    } catch {}
  }, 600);
}

export function getCachedTokenLogo(mint: string): string | null {
  if (LOGOS[mint]) return LOGOS[mint];
  return _cache.get(mint) ?? null;
}

export function setCachedTokenLogo(mint: string, logo: string | null) {
  // Don't downgrade an already-resolved logo back to null.
  if (logo === null && _cache.get(mint)) return;
  _cache.set(mint, logo);
  persist();
}

// ── BrainsIndexer pre-warm ──────────────────────────────────────────────────
// BrainsIndexer (`/api/xendex/pool/list`) returns a snapshot of every active
// xDEX pool with per-token logos. We fire it lazily on first import and
// stream every logo it knows about into the shared cache. After this,
// getCachedTokenLogo() is hot for the entire ecosystem without anyone asking.
let _indexerPrimed = false;
export function primeFromIndexer(): void {
  if (_indexerPrimed) return;
  _indexerPrimed = true;
  (async () => {
    try {
      const { fetchIndexerSnapshot, getCachedIndexerSnapshot } = await import('./brainsIndexer');
      const apply = (snap: any) => {
        if (!snap?.pools) return;
        for (const p of snap.pools) {
          if (p.token1?.address && p.token1?.logo) setCachedTokenLogo(p.token1.address, p.token1.logo);
          if (p.token2?.address && p.token2?.logo) setCachedTokenLogo(p.token2.address, p.token2.logo);
        }
      };
      apply(getCachedIndexerSnapshot());
      const live = await fetchIndexerSnapshot();
      apply(live);
    } catch {
      _indexerPrimed = false; // allow a future retry
    }
  })();
}

// Fire the prime once at module load so pages don't need to remember to.
primeFromIndexer();

// ── Per-mint resolver ───────────────────────────────────────────────────────
// Falls through to the same 3-layer fetcher the landing page + LP Pairing use,
// so a missing logo on Portfolio/Swap is now a server-side reality, not a UI
// bug. fetchTokenMeta lives in PairingMarketplace; dynamic import keeps this
// module free of a hard dependency on the page tree.
export async function fetchTokenLogo(mint: string, connection: Connection): Promise<string | null> {
  if (LOGOS[mint]) return LOGOS[mint];
  if (_cache.has(mint) && _cache.get(mint)) return _cache.get(mint) ?? null;

  const existing = _inflight.get(mint);
  if (existing) return existing;

  const job = (async (): Promise<string | null> => {
    // 1) Cheap path: Token-2022 metadata extension via the wallet connection
    try {
      const info = await connection.getParsedAccountInfo(new PublicKey(mint));
      const parsed = (info?.value?.data as any)?.parsed?.info;
      const exts = parsed?.extensions as any[] | undefined;
      const metaExt = exts?.find((e: any) => e.extension === 'tokenMetadata');
      const uri = metaExt?.state?.uri as string | undefined;
      if (uri) {
        const r = await fetch(uri, { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        const logo: string | undefined = j?.image || j?.logo || j?.icon;
        if (logo) {
          setCachedTokenLogo(mint, logo);
          return logo;
        }
      }
    } catch {}

    // 2) Full 3-layer fetcher (Token-2022 ext → Metaplex PDA → xDEX) — same
    //    path the landing page + LP Pairing use. Dynamic import so this file
    //    has no static link back into the page tree.
    try {
      const { fetchTokenMeta } = await import('../pages/PairingMarketplace');
      const meta = await fetchTokenMeta(mint);
      if (meta?.logo) {
        setCachedTokenLogo(mint, meta.logo);
        return meta.logo;
      }
    } catch {}

    // Negative cache so we don't spam the network for tokens with no logo.
    // Bare null lives in memory only; never persisted.
    _cache.set(mint, null);
    return null;
  })().finally(() => { _inflight.delete(mint); });

  _inflight.set(mint, job);
  return job;
}

/** Bulk variant. Useful when paginating a portfolio. */
export async function fetchTokenLogos(
  mints: string[],
  connection: Connection,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.allSettled(mints.map(async m => {
    const l = await fetchTokenLogo(m, connection);
    if (l) out.set(m, l);
  }));
  return out;
}
