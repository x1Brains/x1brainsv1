// Solaris Prime is a public X1 NFT indexer that pre-resolves metadata + images
// for every collection. The Solaris origin doesn't send CORS headers, so we
// route every call through one of three paths and accept whichever responds OK.

const DIRECT_BASE = 'https://solarisprime.xyz/api/indexer';
const LOCAL_BASE  = '/api/solaris';  // dev: vite proxy → solarisprime.xyz/api/indexer
const CORS_BASE   = 'https://corsproxy.io/?https%3A%2F%2Fsolarisprime.xyz%2Fapi%2Findexer';

export type SolarisNFT = {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  collectionKey?: string;
  collectionName?: string;
  attributes?: { trait_type: string; value: string }[];
};

export type SolarisCollection = {
  key: string;
  name?: string;
  symbol?: string;
  image?: string;
  verified: boolean;
  native: boolean;
  floorPrice?: number;
  listingCount?: number;
};

// ── Caches ────────────────────────────────────────────────────────────────
const nftCache = new Map<string, SolarisNFT | null>();
const inFlight = new Map<string, Promise<SolarisNFT | null>>();
let collectionsCache: SolarisCollection[] | null = null;
let collectionsLoadedAt = 0;
const COLLECTIONS_TTL = 5 * 60_000;

// Persist NFT cache to localStorage so refreshes are instant.
// v2 key: entries now also carry `attributes`; old v1 entries were cached
// without them and would mask traits in the NFT detail modal.
const STORAGE_KEY = 'v2_solaris_nft_cache_v2';
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) nftCache.set(k, v as SolarisNFT | null);
  }
} catch {}

let persistTimer: number | null = null;
function persist() {
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    try {
      const obj: Record<string, SolarisNFT | null> = {};
      nftCache.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {}
  }, 1000);
}

// ── Fetch helpers ─────────────────────────────────────────────────────────
// Tries local-proxy → corsproxy → direct. Returns the first 2xx JSON body or null.
async function fetchJson<T>(path: string, ms = 8000): Promise<T | null> {
  const urls = [
    `${LOCAL_BASE}${path}`,
    `${CORS_BASE}${path}`,
    `${DIRECT_BASE}${path}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
      if (!r.ok) continue;
      const text = await r.text();
      try { return JSON.parse(text) as T; } catch { continue; }
    } catch { continue; }
  }
  return null;
}

// ── Single NFT lookup ─────────────────────────────────────────────────────
export async function fetchSolarisNft(mint: string): Promise<SolarisNFT | null> {
  if (nftCache.has(mint)) return nftCache.get(mint)!;
  const existing = inFlight.get(mint);
  if (existing) return existing;

  const promise = (async () => {
    const j = await fetchJson<any>(`/nft/${mint}`);
    if (!j?.success || !j?.data) {
      nftCache.set(mint, null);
      persist();
      inFlight.delete(mint);
      return null;
    }
    const m = j.data.metadata ?? {};
    const c = j.data.collection ?? {};
    // Traits come back as { trait_type, trait_value }. Normalise to the
    // { trait_type, value } shape the rest of the app (NFTData.attributes) uses.
    // Fall back to metadata.attributes if the indexer didn't split traits out.
    const rawTraits: any[] = Array.isArray(j.data.traits) ? j.data.traits
                           : Array.isArray(m.attributes) ? m.attributes : [];
    const attributes = rawTraits
      .map((t: any) => ({
        trait_type: String(t?.trait_type ?? t?.traitType ?? '').trim(),
        value:      String(t?.trait_value ?? t?.value ?? '').trim(),
      }))
      .filter((a) => a.trait_type && a.value);
    const out: SolarisNFT = {
      mint,
      name:           m.name,
      symbol:         m.symbol,
      image:          m.image || (c?.image && j.data.listing == null ? undefined : c?.image),
      collectionKey:  c.collection_key,
      collectionName: c.name,
      attributes:     attributes.length ? attributes : undefined,
    };
    // If per-NFT image isn't set, try inheriting collection image (rare; mostly
    // catches one-of-one collection masters).
    if (!out.image && c.image) out.image = c.image;
    nftCache.set(mint, out);
    persist();
    inFlight.delete(mint);
    return out;
  })();

  inFlight.set(mint, promise);
  return promise;
}

// ── Collections list ──────────────────────────────────────────────────────
export async function fetchSolarisCollections(): Promise<SolarisCollection[]> {
  if (collectionsCache && Date.now() - collectionsLoadedAt < COLLECTIONS_TTL) {
    return collectionsCache;
  }
  const j = await fetchJson<any>('/collections?limit=200');
  if (!j?.success || !Array.isArray(j.data)) return collectionsCache ?? [];
  const out: SolarisCollection[] = j.data.map((c: any) => ({
    key:           c.collection_key,
    name:          c.name,
    symbol:        c.symbol,
    image:         c.image,
    verified:      Number(c.badge_verified) === 1,
    native:        Number(c.badge_native)   === 1,
    floorPrice:    c.floor_price,
    listingCount:  c.listing_count,
  }));
  collectionsCache = out;
  collectionsLoadedAt = Date.now();
  return out;
}

// ── Bulk preload (best-effort) ────────────────────────────────────────────
// Hits the listings endpoint to warm the NFT cache for every NFT Solaris knows
// about — much faster than per-mint lookups when the marketplace first opens.
export async function preloadSolarisListings(): Promise<void> {
  const j = await fetchJson<any>('/listings?limit=500');
  if (!j?.success || !Array.isArray(j.data)) return;
  for (const item of j.data) {
    if (!item?.mint || !item?.metadata) continue;
    const m = item.metadata;
    if (nftCache.has(item.mint) && nftCache.get(item.mint)?.image) continue;
    nftCache.set(item.mint, {
      mint:           item.mint,
      name:           m.name,
      symbol:         m.symbol,
      image:          m.image,
      collectionKey:  item.collection ?? undefined,
      collectionName: m.collection ?? undefined,
    });
  }
  persist();
}
