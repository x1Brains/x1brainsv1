import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import {
  fetchWalletNFTs,
  fetchAllListings,
  batchEnrichListings,
  enrichListing,
  enrichNFT,
  invalidateListingsCache,
  type NFTData,
  type Listing,
} from '../components/LBComponents';
import V2NFTDetailModal from '../components/V2NFTDetailModal';
import V2NFTImage from '../components/V2NFTImage';
import V2MarketModal, { type MarketTarget } from '../components/V2MarketModal';
import V2BoostModal, { type BoostTarget } from '../components/V2BoostModal';
import { fetchMarketStats, getCachedMarketStats } from '../lib/marketStats';
import {
  fetchSolarisNft, fetchSolarisCollections, preloadSolarisListings,
} from '../lib/solarisIndexer';
import type { SolarisCollection } from '../lib/solarisIndexer';
import { shortAddr } from '../utils/v2format';
import { identifyCollection } from '../lib/verifiedCollections';
import { supabase, getNftMetadataBatch, upsertNftMetadata } from '../lib/supabase';
import type { NftMetaRow } from '../lib/supabase';
import bs58 from 'bs58';
import { MARKETPLACE_PROGRAM_ID_STRING } from '../constants';

// Marketplace ix discriminators — same constants LBComponents + marketIx use.
// Hardcoded inline so we don't need to widen the LBComponents exports just
// for the activity feed.
const DISC_LIST_NFT = '58dd5da63fdc6ae8';
const DISC_BUY_NFT  = '60001cbe316b53de';
const DISC_CANCEL   = '29b732e8e6e99d46';

// Token-2022 NFTs (x1cats, x1pups, Brains Elites etc.) keep metadata inline
// in the mint account via the TokenMetadata extension. The extension can
// contain MULTIPLE URLs (a JSON metadata pointer + a direct image URL in
// additional_metadata fields, etc.). Return all of them so we can try each.
async function fetchToken2022MetaUris(connection: any, mint: string): Promise<string[]> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(mint));
    if (!info?.data) return [];
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const ascii = decoder.decode(info.data);
    const matches = ascii.matchAll(/(https?:\/\/[^\s\x00-\x1f"'<>]+|ipfs:\/\/[A-Za-z0-9]+|ar:\/\/[A-Za-z0-9_-]+)/g);
    const out: string[] = [];
    for (const m of matches) {
      const clean = m[0].split('\x00')[0].replace(/[\s\x00-\x1f]+$/, '');
      if (clean && !out.includes(clean)) out.push(clean);
    }
    return out;
  } catch { return []; }
}

// Universal metadata fetcher with proxy + corsproxy fallback chain.
// The vite local proxy (`/api/nft-meta/HOST/path`) only routes one host
// reliably; corsproxy.io handles any host so it's the failsafe.
function resolveUri(u: string): string {
  return u
    .replace('ipfs://', 'https://nftstorage.link/ipfs/')
    .replace('ar://', 'https://arweave.net/');
}

// Multi-strategy fetch with detailed diagnostic logging. Tries:
//   1) local /api/nft-meta proxy (vite dev)
//   2) corsproxy.io
//   3) api.allorigins.win
//   4) direct (in case host serves CORS)
async function fetchMetaUniversal(metaUri: string): Promise<any | null> {
  const url = resolveUri(metaUri);
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) {
    return { image: url };
  }

  const strategies: Array<{ name: string; fn: () => Promise<Response> }> = [
    {
      name: 'local',
      fn: () => fetch(`/api/nft-meta/${url.replace(/^https?:\/\//, '')}`, { signal: AbortSignal.timeout(6000) }),
    },
    {
      name: 'corsproxy',
      fn: () => fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(6000) }),
    },
    {
      name: 'allorigins',
      fn: () => fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(6000) }),
    },
    {
      name: 'direct',
      fn: () => fetch(url, { signal: AbortSignal.timeout(6000) }),
    },
  ];

  for (const s of strategies) {
    try {
      const r = await s.fn();
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') ?? '';
      if (ct.startsWith('image/')) return { image: url, _via: s.name };
      const text = await r.text();
      // Some proxies wrap the JSON; try parsing as JSON first
      try { return { ...JSON.parse(text), _via: s.name }; } catch {}
    } catch {}
  }
  // All strategies failed — log so user can diagnose
  console.warn('[V2LabWork] metadata fetch failed for', metaUri);
  return null;
}

// Collection-specific direct image URL. Returns ONLY when a known X1 collection
// pattern matches — these URLs are highly reliable (sourced from Solaris's
// pre-resolved data) and skip metadata JSON entirely.
function collectionSpecificImage(metaUri: string): string | null {
  const url = resolveUri(metaUri);

  // X1Cats: many possible metadata paths; image is always at /v0/cats/getsvg/<hex>.
  // Match any hex id appearing after /v0/cats/.../<hex> regardless of intermediate segment.
  if (/api\.x1app\.fyi\/v0\/cats/i.test(url)) {
    // Already a getsvg URL — return as-is.
    if (/\/getsvg\/[a-f0-9]+/i.test(url)) return url;
    // Find the longest hex token — that's the cat id.
    const hexMatch = url.match(/\/v0\/cats\/[^/]+\/([a-f0-9]{6,})/i)
                  || url.match(/\b([a-f0-9]{8,})\b/i);
    if (hexMatch) return `https://api.x1app.fyi/v0/cats/getsvg/${hexMatch[1]}`;
  }

  // X1Pups: meta/pup_NNNN.json → thumbs/pup_NNNN.jpg
  const x1pupsMatch = url.match(/x1pups\.vercel\.app\/meta\/(pup_\d+)/i);
  if (x1pupsMatch) return `https://x1pups.vercel.app/thumbs/${x1pupsMatch[1]}.jpg`;

  // X1Punks: github raw images. Use the LAST number in the URL (the punk id at
  // the path tail) — grabbing the first number could pick a version/segment and
  // resolve to the wrong punk.
  if (/x1punks/i.test(url)) {
    const nums = url.match(/\d+/g);
    if (nums && nums.length) return `https://raw.githubusercontent.com/Execute007/x1punks-images/master/generated/punk_${nums[nums.length - 1]}.png`;
  }
  return null;
}

// Generic pattern-based guesses used ONLY as last resort after the metadata
// JSON fetch fails and no collection-specific rule matched.
function guessImageFromMetaUri(metaUri: string): string[] {
  const url  = resolveUri(metaUri);
  const base = url.replace(/\.json$/i, '').replace(/\/$/, '');
  const exts = ['png', 'jpg', 'webp', 'gif'];
  const out: string[] = [];

  for (const ext of exts) out.push(`${base}.${ext}`);

  const subs: [string, string][] = [
    ['/metadata/',     '/images/'],
    ['/metadata/',     '/image/'],
    ['/metadata/',     '/img/'],
    ['/metadata/',     '/thumbs/'],
    ['/meta/',         '/images/'],
    ['/meta/',         '/image/'],
    ['/meta/',         '/img/'],
    ['/meta/',         '/thumbs/'],
    ['/json/',         '/images/'],
    ['/json/',         '/img/'],
    ['/api/metadata/', '/api/images/'],
    ['/api/metadata/', '/images/'],
  ];
  for (const [from, to] of subs) {
    if (base.includes(from)) {
      const sw = base.replace(from, to);
      for (const ext of exts) out.push(`${sw}.${ext}`);
    }
  }
  return out;
}

function isLikelyImage(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(url) || url.startsWith('data:image');
}

// Resolve an image URL from a candidate list of metaUris.
// Priority: direct ext → collection-specific (only if matched) → metadata
// JSON fetch (good for Brains Elite + other collections with valid JSON) →
// generic pattern guesses.
async function resolveImage(uris: string[]): Promise<{ image: string | null; meta: any }> {
  // 1) Direct image extension match — instant
  for (const u of uris) {
    const r = resolveUri(u);
    if (isLikelyImage(r)) return { image: r, meta: null };
  }
  // 2) Collection-specific (only when matched, otherwise skip). We still fetch
  //    the metadata JSON in the background so traits/attributes populate — the
  //    fast image is used for display, the JSON only for attributes (cats/pups).
  for (const u of uris) {
    const specific = collectionSpecificImage(u);
    if (specific) {
      const meta = await fetchMetaUniversal(u).catch(() => null);
      return { image: specific, meta };
    }
  }
  // 3) Metadata JSON fetch + extract image (works for Brains Elite + many others)
  for (const u of uris) {
    const meta = await fetchMetaUniversal(u);
    const img  = extractImageFromMeta(meta);
    if (img) return { image: img, meta };
  }
  // 4) Generic pattern guesses as last resort
  for (const u of uris) {
    const guesses = guessImageFromMetaUri(u);
    if (guesses.length > 0) return { image: guesses[0], meta: null };
  }
  return { image: null, meta: null };
}

function extractImageFromMeta(json: any): string | null {
  if (!json) return null;
  const candidates: any[] = [
    json?.image, json?.image_url, json?.imageUrl, json?.imgUrl,
    json?.media?.uri, json?.media?.url, json?.media,
    json?.animation_url,
    json?.properties?.image,
    json?.properties?.files?.[0]?.uri,
    json?.properties?.files?.[0]?.url,
    json?.properties?.files?.[0],
    json?.properties?.files?.[1]?.uri,
    json?.properties?.files?.[1]?.url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return resolveUri(c);
  }
  return null;
}

// Infer a collection name from the NFT's own name when JSON has none.
// "X1Cat #00112"           → "X1Cat"
// "Absolutely Feral #0327" → "Absolutely Feral"
// "Brains Elite Pass"      → "Brains Elite Pass" (no # → kept as-is)
function inferCollection(name?: string): string | undefined {
  if (!name) return undefined;
  const m = name.match(/^(.+?)\s*#\d+\s*$/);
  return m ? m[1].trim() : undefined;
}

function pickCollection(meta: any, nftName: string | undefined, existing?: string): string | undefined {
  if (meta?.collection) {
    if (typeof meta.collection === 'string') return meta.collection;
    if (meta.collection.name) return meta.collection.name;
    if (meta.collection.family) return meta.collection.family;
  }
  if (meta?.symbol && typeof meta.symbol === 'string' && meta.symbol.length > 0 && meta.symbol.length < 24) {
    return meta.symbol;
  }
  return inferCollection(nftName) ?? existing;
}

// Browse-tab sub-filter only. MY LISTINGS / SELL / ACTIVITY / OVERVIEW are
// top-level tabs now, not filter chips — they each get their own render block.
type Filter = 'verified' | 'all' | 'listed' | 'uncategorized';

// Top-level marketplace tabs — browse is the landing tab. The dashboard ring
// tiles in V2MarketplaceStats above the tab bar double as quick navigation
// shortcuts to mylistings / sell / activity, so we don't need a separate
// overview tab duplicating the same data.
//   browse     · The marketplace grid (everyone's listings) — DEFAULT / LANDING
//   mylistings · Only my listings, with BOOST · EDIT · DELIST per row
//   sell       · My wallet NFTs grouped by collection, click to list
//   activity   · Recent trades pulled from labwork_trades supabase table
type MarketTab = 'browse' | 'mylistings' | 'sell' | 'activity';
type SortMode = 'newest' | 'priceAsc' | 'priceDesc' | 'name';

export default function V2LabWork() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();

  const [walletNfts, setWalletNfts] = useState<NFTData[]>([]);
  const [listings, setListings]     = useState<Listing[]>([]);
  const [loading, setLoading]       = useState(true);
  const [err, setErr]               = useState('');
  const [tab, setTab]               = useState<MarketTab>('browse');
  const [filter, setFilter]         = useState<Filter>('verified');
  // Pulled from supabase labwork_trades for the ACTIVITY tab.
  const [trades, setTrades]         = useState<Array<{
    sig: string; type: 'list'|'buy'|'delist'|'boost';
    nft_mint: string; price?: number;
    seller?: string; buyer?: string;
    brains?: number | null;
    timestamp: number;
    nftData?: NFTData;
  }>>([]);
  const [tradesLoading, setTradesLoading] = useState(false);
  // Incrementing run-id so stale closures of loadTrades can detect they've been
  // superseded and bail out before clobbering state with empty/late data.
  const tradesRunRef = useRef(0);
  const [sortMode, setSortMode]     = useState<SortMode>('newest');
  const [query, setQuery]           = useState('');
  const [collectionKey, setCollectionKey] = useState<string | null>(null);
  const [marketTarget, setMarketTarget] = useState<MarketTarget | null>(null);
  const [boostTarget,  setBoostTarget]  = useState<BoostTarget | null>(null);
  const [detailNft, setDetailNft]   = useState<NFTData | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [solarisCollections, setSolarisCollections] = useState<SolarisCollection[]>([]);

  // Load Solaris collections once for thumbnail fallbacks in the rail.
  useEffect(() => {
    let alive = true;
    fetchSolarisCollections().then(cols => {
      if (alive) setSolarisCollections(cols);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const [marketVolXnt, setMarketVolXnt] = useState<number>(() => getCachedMarketStats()?.volumeXnt ?? 0);
  const [marketSales, setMarketSales]   = useState<number>(() => getCachedMarketStats()?.salesCount ?? 0);
  const [biggestBuy, setBiggestBuy]     = useState(() => getCachedMarketStats()?.biggestSale ?? null);
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  // Load on-chain listings (independent of wallet)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Warm Solaris's pre-resolved metadata cache for every X1 NFT it knows about.
        // This means a single API call can resolve images for hundreds of NFTs.
        preloadSolarisListings().catch(() => {});
        const raw = await fetchAllListings(connection);
        if (!alive) return;
        setListings(raw);

        // ── Cache pass (our Supabase indexer) — INSTANT metadata for every NFT a
        // prior visitor already resolved. This paints images + traits immediately
        // and lets the slow per-NFT passes below skip anything already cached.
        const cachedMints = new Set<string>();
        try {
          const cache = await getNftMetadataBatch(raw.map(l => l.nftMint));
          if (!alive) return;
          if (cache.size > 0) {
            setListings(prev => prev.map(l => {
              const c = cache.get(l.nftMint);
              if (!c || !(c.image || (c.attributes && c.attributes.length))) return l;
              cachedMints.add(l.nftMint);
              const base = l.nftData ?? {
                mint: l.nftMint, name: c.name ?? l.nftMint.slice(0, 6) + '…',
                symbol: c.symbol ?? '', balance: 1, decimals: 0, isToken2022: false,
              };
              return { ...l, nftData: {
                ...base,
                name: c.name ?? base.name, symbol: c.symbol ?? base.symbol,
                image: c.image ?? base.image, description: c.description ?? base.description,
                attributes: (c.attributes && c.attributes.length) ? c.attributes : base.attributes,
                externalUrl: c.externalUrl ?? base.externalUrl,
                collection: c.collection ?? base.collection,
              } };
            }));
          }
        } catch {}

        // First pass — Solaris has pre-resolved image URLs for every X1 NFT.
        // Hit it per-mint in chunks; very fast since it's a single CDN lookup.
        const solChunk = 10;
        for (let i = 0; i < raw.length; i += solChunk) {
          if (!alive) return;
          const slice = raw.slice(i, i + solChunk);
          // Skip mints already painted from the Supabase cache.
          const sol = await Promise.all(slice.map(l =>
            cachedMints.has(l.nftMint) ? Promise.resolve(null) : fetchSolarisNft(l.nftMint)));
          if (!alive) return;
          setListings(prev => {
            const next = [...prev];
            slice.forEach((l, idx) => {
              const s = sol[idx];
              if (!s?.image) return;
              const j = next.findIndex(p => p.listingPda === l.listingPda);
              if (j >= 0) {
                const base = next[j].nftData || {
                  mint: l.nftMint, name: l.nftMint.slice(0, 6) + '…',
                  symbol: s.symbol ?? '', balance: 1, decimals: 0, isToken2022: false,
                };
                next[j] = {
                  ...next[j],
                  nftData: {
                    ...base,
                    name: s.name ?? base.name,
                    symbol: s.symbol ?? base.symbol,
                    image: s.image,
                    collection: s.collectionName ?? base.collection,
                  },
                };
              }
            });
            return next;
          });
        }
        // Step 1 — batch enrich via Metaplex PDA: populates nftData.metaUri/name/symbol.
        const enriched = await batchEnrichListings(connection, raw).catch(() => raw);
        if (!alive) return;
        // Merge into existing state — DON'T clobber image fields already set
        // by the Solaris pass above. (Bug: wholesale setListings(enriched) was
        // wiping Solaris-resolved images, then when state got back into a
        // consistent shape via step 2, items could look swapped.)
        setListings(prev => {
          const map = new Map(prev.map(p => [p.listingPda, p]));
          return enriched.map(e => {
            const cur = map.get(e.listingPda);
            const existingImg  = cur?.nftData?.image;
            const existingColl = cur?.nftData?.collection;
            if (!cur) return e;
            return {
              ...cur,
              ...e,
              nftData: {
                ...(e.nftData ?? cur.nftData!),
                ...(existingImg  ? { image: existingImg }   : {}),
                ...(existingColl ? { collection: existingColl } : {}),
              },
            };
          });
        });

        // Step 2 — gather ALL candidate URIs per listing (Metaplex + Token-2022 inline).
        // Step 3 — try each URI: direct image first, then as metadata JSON.
        const CHUNK = 6;
        const toCache: NftMetaRow[] = [];
        for (let i = 0; i < enriched.length; i += CHUNK) {
          if (!alive) return;
          const slice = enriched.slice(i, i + CHUNK);
          const imaged = await Promise.all(slice.map(async (l) => {
            // Already resolved from the Supabase cache — skip the slow fetch.
            if (cachedMints.has(l.nftMint)) return l;
            // MoltLab branch — uses AgentID lookup by seller wallet
            if (l.nftData?.metaUri?.includes('moltlab.vercel.app')) {
              return enrichListing(connection, l).catch(() => l);
            }
            // Collect all candidate URIs
            const candidates: string[] = [];
            if (l.nftData?.metaUri) candidates.push(l.nftData.metaUri);
            const t22 = await fetchToken2022MetaUris(connection, l.nftMint);
            for (const u of t22) if (!candidates.includes(u)) candidates.push(u);
            if (candidates.length === 0) return l;

            const { image, meta } = await resolveImage(candidates);
            const nameFromMeta = typeof meta?.name === 'string' ? meta.name : l.nftData?.name;
            const coll = pickCollection(meta, nameFromMeta, l.nftData?.collection);
            const base = l.nftData ?? {
              mint: l.nftMint, name: l.nftMint.slice(0, 6) + '…', symbol: '',
              balance: 1, decimals: 0, isToken2022: t22.length > 0,
            };
            return {
              ...l,
              nftData: {
                ...base,
                metaUri: candidates[0],
                name: nameFromMeta || base.name,
                image: image ?? base.image,
                description: meta?.description ?? base.description,
                attributes: Array.isArray(meta?.attributes) && meta.attributes.length ? meta.attributes : base.attributes,
                externalUrl: meta?.external_url ?? meta?.external_link ?? base.externalUrl,
                collection: coll ?? base.collection,
              },
            };
          }));
          if (!alive) return;
          setListings(prev => {
            const next = [...prev];
            for (const e of imaged) {
              const idx = next.findIndex(p => p.listingPda === e.listingPda);
              if (idx >= 0) next[idx] = e;
            }
            return next;
          });
          // Collect freshly-resolved metadata to write back to the indexer.
          for (const e of imaged) {
            if (cachedMints.has(e.nftMint)) continue;
            const nd = e.nftData;
            if (nd && (nd.image || (nd.attributes && nd.attributes.length))) {
              toCache.push({
                mint: e.nftMint, name: nd.name, symbol: nd.symbol, image: nd.image,
                description: nd.description, externalUrl: nd.externalUrl,
                collection: nd.collection, attributes: nd.attributes,
              });
            }
          }
        }
        // Write-through: persist everything we resolved this load so the next
        // visitor gets it instantly. Fire-and-forget, chunked inside the helper.
        if (toCache.length) upsertNftMetadata(toCache).catch(() => {});
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'Failed to load listings');
      }
    })();
    return () => { alive = false; };
  }, [connection, reloadTick]);

  const [enrichProgress, setEnrichProgress] = useState({ done: 0, total: 0 });

  // Load wallet NFTs (when wallet connected) + enrich ALL metadata in chunks
  useEffect(() => {
    if (!publicKey) { setWalletNfts([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setEnrichProgress({ done: 0, total: 0 });
    (async () => {
      try {
        const raw = await fetchWalletNFTs(connection, publicKey);
        if (!alive) return;
        setWalletNfts(raw);
        setLoading(false);
        // Enrich ALL — no cap. Chunked. For each NFT:
        //   1) If no metaUri, scan mint for Token-2022 inline metadata
        //   2) Fetch metadata via corsproxy chain
        //   3) Extract image URL
        setEnrichProgress({ done: 0, total: raw.length });
        const CHUNK = 8;
        for (let i = 0; i < raw.length; i += CHUNK) {
          if (!alive) return;
          const slice = raw.slice(i, i + CHUNK);
          const enriched = await Promise.all(slice.map(async (n) => {
            // Try Solaris first — pre-resolved image + name + collection.
            const sol = await fetchSolarisNft(n.mint);
            if (sol?.image) {
              return {
                ...n,
                name:       sol.name ?? n.name,
                image:      sol.image,
                collection: sol.collectionName ?? n.collection,
              };
            }
            // Fallback to on-chain resolution
            const candidates: string[] = [];
            if (n.metaUri) candidates.push(n.metaUri);
            const t22 = await fetchToken2022MetaUris(connection, n.mint);
            for (const u of t22) if (!candidates.includes(u)) candidates.push(u);
            if (candidates.length === 0) return n;

            const { image, meta } = await resolveImage(candidates);
            const nameFromMeta = typeof meta?.name === 'string' ? meta.name : n.name;
            const coll = pickCollection(meta, nameFromMeta, n.collection);
            return {
              ...n,
              metaUri: candidates[0],
              isToken2022: n.isToken2022 || t22.length > 0,
              name: nameFromMeta || n.name,
              image: image ?? n.image,
              description: meta?.description ?? n.description,
              attributes: Array.isArray(meta?.attributes) && meta.attributes.length ? meta.attributes : n.attributes,
              collection: coll ?? n.collection,
            };
          }));
          if (!alive) return;
          setWalletNfts(prev => {
            const next = [...prev];
            for (const e of enriched) {
              const idx = next.findIndex(p => p.mint === e.mint);
              if (idx >= 0) next[idx] = e;
            }
            return next;
          });
          setEnrichProgress(p => ({ done: Math.min(p.total, i + slice.length), total: p.total }));
        }
      } catch (e: any) {
        if (alive) { setErr(e?.message ?? 'Failed to load NFTs'); setLoading(false); }
      }
    })();
    return () => { alive = false; };
  }, [publicKey, connection, reloadTick]);

  // ── Activity tab: trades from Supabase + on-chain scan fallback ──
  // Supabase is the source of truth for historical trades (one row per list /
  // buy / cancel signature). On a brand-new wallet or freshly-deployed program
  // the table is empty, so we ALSO walk the marketplace program's recent
  // signatures and parse each tx by ix discriminator. Anything found on chain
  // that's not in Supabase is upserted so the next page load is instant.
  const loadTrades = async () => {
    const runId = ++tradesRunRef.current;
    const alive = () => tradesRunRef.current === runId;
    setTradesLoading(true);
    try {
      // Mint → nftData lookup so rows can render with a thumbnail immediately.
      // Pull from BOTH live listings AND wallet NFTs (merged) since trade
      // history references mints that are no longer actively listed.
      const byMint = new Map<string, NFTData | undefined>();
      for (const l of listings)  byMint.set(l.nftMint, l.nftData);
      for (const m of merged)   if (m.nftData) byMint.set(m.mint, m.nftData);

      type Row = {
        sig: string; type: 'list'|'buy'|'delist'|'boost';
        nft_mint: string; price?: number;
        seller?: string; buyer?: string;
        brains?: number | null;
        timestamp: number;
        nftData?: NFTData;
      };
      const map = new Map<string, Row>();

      // 1) Pull from Supabase — anything we've already recorded.
      if (supabase) {
        try {
          const { data } = await supabase
            .from('labwork_trades')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(200);
          if (data) {
            for (const d of data as any[]) {
              map.set(d.sig, {
                sig: d.sig, type: d.type,
                nft_mint: d.nft_mint,
                price: d.price ?? undefined,
                seller: d.seller ?? undefined,
                buyer: d.buyer ?? undefined,
                brains: d.brains,
                timestamp: d.timestamp,
                nftData: byMint.get(d.nft_mint),
              });
            }
            if (map.size > 0 && alive()) {
              setTrades(Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp));
            }
          }
        } catch {}
      }

      // 2) Walk recent marketplace program signatures. ONE batched
      //    getParsedTransactions call — not N individual getTransaction RPCs —
      //    so the worst case is one round-trip instead of dozens. Limit kept
      //    small (25) so the page paints fast; a fuller backfill can run later.
      try {
        const progId    = new PublicKey(MARKETPLACE_PROGRAM_ID_STRING);
        const progIdStr = progId.toBase58();
        const sigs      = await connection.getSignaturesForAddress(progId, { limit: 25 });
        if (!alive()) return;
        const validSigs = (sigs ?? []).filter((s: any) => !s.err);
        const newSigs   = validSigs.filter((s: any) => !map.has(s.signature));
        if (newSigs.length > 0) {
          const sigStrs = newSigs.map((s: any) => s.signature);
          const parsed = await connection.getParsedTransactions(sigStrs, {
            maxSupportedTransactionVersion: 0, commitment: 'confirmed',
          }).catch(() => [] as any[]);
          if (!alive()) return;

          for (let i = 0; i < parsed.length; i++) {
            const tx  = parsed[i];
            if (!tx || tx.meta?.err) continue;
            const sig = sigStrs[i];
            const ts  = tx.blockTime ?? newSigs[i].blockTime ?? 0;
            const ixs = (tx.transaction?.message?.instructions ?? []) as any[];

            for (const ix of ixs) {
              // getParsedTransactions gives us programId directly as PublicKey.
              const progKey = ix.programId?.toBase58?.() ?? ix.programId ?? '';
              if (progKey !== progIdStr) continue;

              // For unparsed Anchor programs, ix.data is base58 (parsed format).
              let dataHex = '';
              if (ix.data) {
                try { dataHex = Buffer.from(bs58.decode(ix.data as string)).toString('hex'); }
                catch { try { dataHex = Buffer.from(ix.data as string, 'base64').toString('hex'); } catch {} }
              }
              const disc8 = dataHex.slice(0, 16);
              let type: Row['type'] | null = null;
              if (disc8 === DISC_LIST_NFT) type = 'list';
              if (disc8 === DISC_BUY_NFT)  type = 'buy';
              if (disc8 === DISC_CANCEL)   type = 'delist';
              if (!type) continue;

              // Parsed-format ix.accounts is already an array of PublicKey objects.
              const ixAccs: string[] = (ix.accounts ?? []).map(
                (a: any) => a?.toBase58?.() ?? a?.toString?.() ?? String(a),
              );
              const mint   = ixAccs[1] ?? '';
              const seller = type === 'buy' ? (ixAccs[5] ?? '') : (ixAccs[0] ?? '');
              const buyer  = type === 'buy' ? (ixAccs[0] ?? '') : undefined;

              let price: number | undefined;
              if (type !== 'delist' && dataHex.length >= 32) {
                try { price = Number(Buffer.from(dataHex.slice(16, 32), 'hex').readBigUInt64LE(0)); } catch {}
              }
              if (type === 'buy' && !price) {
                const logMessages: string[] = tx.meta?.logMessages ?? [];
                for (const line of logMessages) {
                  const m = line.match(/Sold\s+\S+\s+for\s+(\d+)\s+lamports/i);
                  if (m) { price = Number(m[1]); break; }
                }
              }

              map.set(sig, {
                sig, type, nft_mint: mint, price,
                seller, buyer, timestamp: ts,
                nftData: byMint.get(mint),
              });
            }
          }

          // Paint as soon as parsing is done — don't wait on the supabase upsert.
          if (alive() && map.size > 0) {
            setTrades(Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp));
          }

          // Backfill supabase in the background so the next load starts hot.
          // Don't block the UI on this — fire-and-forget.
          if (supabase) {
            (async () => {
              for (const row of map.values()) {
                try {
                  await supabase.from('labwork_trades').upsert({
                    sig: row.sig, type: row.type, nft_mint: row.nft_mint,
                    price: row.price, seller: row.seller, buyer: row.buyer,
                    timestamp: row.timestamp,
                  }, { onConflict: 'sig' });
                } catch {}
              }
            })();
          }
        }
      } catch (e) { console.warn('[V2LabWork] chain scan failed', e); }

      // Final paint — but only if this run is still the latest. Otherwise we'd
      // overwrite whatever a fresher invocation has already shown the user.
      if (alive()) {
        const final = Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp);
        // Don't blank the table just because the chain scan came back empty —
        // keep whatever we already painted from supabase / a prior run.
        if (final.length > 0) setTrades(final);
      }

      // ── 3) Lazy enrichment — fetch NFT image+name for any mint we don't
      //    have yet. Walks Solaris (X1's pre-resolved metadata indexer)
      //    in chunks of 5 with a 100ms gap so we don't spam the endpoint.
      //    Each resolve repaints the trade row with thumbnail + name.
      if (alive()) {
        const needEnrich = Array.from(new Set(
          Array.from(map.values())
            .filter(r => !r.nftData?.image && r.nft_mint)
            .map(r => r.nft_mint),
        ));
        if (needEnrich.length > 0) {
          (async () => {
            const CHUNK = 5;
            for (let i = 0; i < needEnrich.length; i += CHUNK) {
              if (!alive()) return;
              const slice = needEnrich.slice(i, i + CHUNK);
              const results = await Promise.all(slice.map(m =>
                fetchSolarisNft(m).catch(() => null),
              ));
              if (!alive()) return;
              let touched = false;
              for (let j = 0; j < slice.length; j++) {
                const sol = results[j];
                if (!sol?.image) continue;
                const mint = slice[j];
                for (const row of map.values()) {
                  if (row.nft_mint !== mint) continue;
                  row.nftData = {
                    mint: row.nftData?.mint ?? mint,
                    name: sol.name ?? row.nftData?.name ?? `${mint.slice(0, 6)}…`,
                    symbol: sol.symbol ?? row.nftData?.symbol ?? '',
                    balance: 1, decimals: 0, isToken2022: false,
                    image: sol.image,
                    collection: sol.collectionName ?? row.nftData?.collection,
                  };
                  touched = true;
                }
              }
              if (touched && alive()) {
                setTrades(Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp));
              }
            }
          })();
        }
      }
    } finally {
      if (alive()) setTradesLoading(false);
    }
  };
  // Fire once when entering the activity tab (or on explicit refresh). Do
  // NOT depend on `listings` — it mutates during metadata enrichment and
  // each mutation would re-fire loadTrades, racing the in-flight scan and
  // wiping the visible rows when a stale closure resolved last.
  useEffect(() => {
    if (tab !== 'activity') return;
    loadTrades();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reloadTick]);

  // ── Marketplace cumulative volume — walks program sigs, sums buy_nft sale prices.
  // Mirrors v1 loadPlatformStats so volume matches x1brains.io.
  useEffect(() => {
    const ctrl = new AbortController();
    // Seed from cache immediately
    const cached = getCachedMarketStats();
    if (cached) {
      setMarketVolXnt(cached.volumeXnt);
      setMarketSales(cached.salesCount);
      setBiggestBuy(cached.biggestSale);
    }
    fetchMarketStats(connection, ctrl.signal, (partial) => {
      if (ctrl.signal.aborted) return;
      setMarketVolXnt(partial.volumeXnt);
      setMarketSales(partial.salesCount);
      setBiggestBuy(partial.biggestSale);
    }).then(res => {
      if (ctrl.signal.aborted) return;
      setMarketVolXnt(res.volumeXnt);
      setMarketSales(res.salesCount);
      setBiggestBuy(res.biggestSale);
    }).catch(() => {});
    return () => { ctrl.abort(); };
  }, [connection]);

  // Merge listings + wallet NFTs into a unified marketplace stream.
  const merged = useMemo(() => {
    const listingByMint = new Map(listings.map(l => [l.nftMint, l]));
    const items: Array<{
      key: string;
      mint: string;
      name: string;
      collection?: string;
      collectionKey: string; // stable id for filtering
      verified?: ReturnType<typeof identifyCollection>;
      image?: string;
      listing?: Listing;
      priceXnt?: number;
      isMine?: boolean;
      metaUri?: string;
      nftData?: NFTData;
    }> = [];

    const keyFor = (vc: ReturnType<typeof identifyCollection>, collection: string | undefined) =>
      vc?.id ?? (collection ? `c:${collection.toLowerCase()}` : 'uncategorized');

    for (const l of listings) {
      if (!l.nftMint) continue;
      const name = l.nftData?.name ?? `#${l.nftMint.slice(0, 6)}`;
      const vc = identifyCollection({ metaUri: l.nftData?.metaUri, name, mint: l.nftMint });
      const coll = vc?.name ?? l.nftData?.collection ?? inferCollection(name) ?? 'Uncategorized';
      items.push({
        key: l.listingPda,
        mint: l.nftMint,
        name,
        collection: coll,
        collectionKey: keyFor(vc, coll),
        verified: vc,
        image: l.nftData?.image ?? l.nftData?.logoUri,
        metaUri: l.nftData?.metaUri,
        listing: l,
        priceXnt: l.price ? l.price / 1e9 : undefined,
        isMine: publicKey ? l.seller === publicKey.toBase58() : false,
        nftData: l.nftData,
      });
    }

    for (const n of walletNfts) {
      if (!n.mint) continue;
      if (listingByMint.has(n.mint)) continue;
      const name = n.name || `#${n.mint.slice(0, 6)}`;
      const vc = identifyCollection({ metaUri: n.metaUri, name, mint: n.mint });
      const coll = vc?.name ?? n.collection ?? inferCollection(name) ?? 'Uncategorized';
      items.push({
        key: 'w-' + n.mint,
        mint: n.mint,
        name,
        collection: coll,
        collectionKey: keyFor(vc, coll),
        verified: vc,
        image: n.image ?? n.logoUri,
        metaUri: n.metaUri,
        isMine: true,
        nftData: n,
      });
    }
    return items;
  }, [listings, walletNfts, publicKey]);

  // Newest-listing timestamp per mint — pulled from the labwork_trades feed
  // (`type === 'list'`). Most recent list-tx wins. Empty until trades load;
  // falls back to 0 so listings without a recorded list-trade sink to the end.
  const latestListTsByMint = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of trades) {
      if (t.type !== 'list') continue;
      const prev = m.get(t.nft_mint) ?? 0;
      if (t.timestamp > prev) m.set(t.nft_mint, t.timestamp);
    }
    return m;
  }, [trades]);

  const filtered = useMemo(() => {
    const list = merged.filter(it => {
      // Browse-tab sub-filter only. Wallet NFTs are never in the browse view —
      // they live in the SELL tab. Listings the citizen owns appear in
      // MY LISTINGS, not here.
      if (!it.listing) return false;
      if (filter === 'verified'      && !it.verified) return false;
      if (filter === 'uncategorized' && it.verified)  return false;
      if (collectionKey && it.collectionKey !== collectionKey) return false;
      if (query) {
        const q = query.toLowerCase();
        if (!it.name.toLowerCase().includes(q) && !it.mint.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      if (sortMode === 'priceAsc') {
        return (a.priceXnt ?? Infinity) - (b.priceXnt ?? Infinity);
      }
      if (sortMode === 'priceDesc') {
        return (b.priceXnt ?? -1) - (a.priceXnt ?? -1);
      }
      if (sortMode === 'name') {
        return a.name.localeCompare(b.name);
      }
      // newest — most recent list-trade wins. Listings with no trade record
      // (legacy / pre-trade-log) get timestamp 0 and sink under fresh ones.
      const ta = latestListTsByMint.get(a.mint) ?? 0;
      const tb = latestListTsByMint.get(b.mint) ?? 0;
      return tb - ta;
    });
  }, [merged, filter, query, sortMode, collectionKey, latestListTsByMint]);

  const liveVerifiedCount      = merged.filter(m => m.verified).length;
  const liveListedCount        = merged.filter(m => m.listing).length;
  const liveMineCount          = merged.filter(m => m.isMine).length;
  const liveMyListingsCount    = merged.filter(m => m.isMine && m.listing).length;
  const liveUncategorizedCount = merged.filter(m => m.listing && !m.verified).length;
  // Resolved alias for the chip badge — falls back to the live count if the
  // frozen snapshot below hasn't tracked it yet.
  const myListingsCount = liveMyListingsCount;

  // ─── Aggregated collection breakdown — used by browse rail ───────
  // Build the rail from `merged` items that actually have a listing — wallet-
  // only NFTs are excluded so the rail reflects what's buyable RIGHT NOW.
  // Only verified collections with at least 3 active listings.
  const liveCollectionStats = useMemo(() => {
    // Solaris collection-image fallback for tiles whose first listing's
    // per-NFT image hasn't resolved yet (e.g. X1 Punks).
    const solByName = new Map<string, string>();
    for (const c of solarisCollections) {
      if (c.name && c.image) solByName.set(c.name.toLowerCase(), c.image);
    }
    const map = new Map<string, {
      key: string;
      name: string;
      total: number; listed: number;
      floorXnt: number;
      image?: string;
      verified: boolean;
    }>();
    for (const it of merged) {
      if (!it.listing) continue; // ← marketplace-only
      if (!it.verified) continue; // ← verified-only
      const ex = map.get(it.collectionKey) ?? {
        key: it.collectionKey,
        name: it.verified?.name ?? it.collection ?? 'Uncategorized',
        total: 0, listed: 0,
        floorXnt: Infinity,
        image: it.image,
        verified: !!it.verified,
      };
      ex.total += 1;
      ex.listed += 1;
      if (it.priceXnt != null) ex.floorXnt = Math.min(ex.floorXnt, it.priceXnt);
      if (!ex.image && it.image) ex.image = it.image;
      map.set(it.collectionKey, ex);
    }
    return [...map.values()]
      // Brains Elites always qualifies; other collections need ≥3 listings.
      .filter(c => c.key === 'brains_elites' || c.listed >= 3)
      .map(c => ({
        ...c,
        image: c.image ?? solByName.get(c.name.toLowerCase()),
      }))
      // Brains Elites is always pinned first; everything else by listing count.
      .sort((a, b) => {
        if (a.key === 'brains_elites') return -1;
        if (b.key === 'brains_elites') return 1;
        return b.listed - a.listed;
      });
  }, [merged, solarisCollections]);

  // Live (continuously-updated) values — these change as listings stream in.
  const liveTotalVolXnt          = listings.reduce((s, l) => s + (l.price ? l.price / 1e9 : 0), 0);
  const liveVerifiedListingsCount = merged.filter(m => m.listing && m.verified).length;

  // ─── Frozen-display snapshot ─────────────────────────────────────
  // The hero stats card + browse-by-collection rail flicker when listings
  // stream in & out during enrichment. Commit the visible values to a
  // snapshot that only refreshes on a 3s "quiet period" — so within a
  // single page session the numbers stop bouncing.
  type Snapshot = {
    verifiedCount: number;
    listedCount: number;
    mineCount: number;
    uncategorizedCount: number;
    totalVolXnt: number;
    verifiedListingsCount: number;
    collectionStats: typeof liveCollectionStats;
  };
  const liveSnapshot: Snapshot = {
    verifiedCount:          liveVerifiedCount,
    listedCount:            liveListedCount,
    mineCount:              liveMineCount,
    uncategorizedCount:     liveUncategorizedCount,
    totalVolXnt:            liveTotalVolXnt,
    verifiedListingsCount:  liveVerifiedListingsCount,
    collectionStats:        liveCollectionStats,
  };
  // One-shot commit: lock the snapshot as soon as listings arrive (not loading
  // AND we have at least one listing). The old version debounced 2.5s of "no
  // changes" — but image enrichment fires setListings every chunk for many
  // seconds, so the timer kept resetting and the dashboard sat on the initial
  // empty values (all zeros) until enrichment fully completed. Image enrichment
  // only adds URLs to existing rows — it doesn't change counts — so we can lock
  // the moment we have stable counts.
  const [snapshot, setSnapshot] = useState<Snapshot>(liveSnapshot);
  const [snapshotLocked, setSnapshotLocked] = useState(false);
  useEffect(() => {
    if (snapshotLocked) return;
    if (loading) return;
    // Fire on the first frame after loading completes — counts come from
    // listings.length / mineCount / etc, which are stable as soon as the
    // listings array is populated.
    if (listings.length === 0 && walletNfts.length === 0) return;
    setSnapshot(liveSnapshot);
    setSnapshotLocked(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotLocked, loading, listings.length, walletNfts.length]);

  const verifiedCount         = snapshot.verifiedCount;
  const listedCount           = snapshot.listedCount;
  const mineCount             = snapshot.mineCount;
  const uncategorizedCount    = snapshot.uncategorizedCount;
  const totalVolXnt           = snapshot.totalVolXnt;
  const verifiedListingsCount = snapshot.verifiedListingsCount;
  // Rail uses LIVE collection stats so it appears as soon as listings load,
  // not 10s later when the snapshot debounce settles. The snapshot still
  // freezes the other stat tiles to stop their numeric flicker.
  const collectionStats       = liveCollectionStats;
  const collectionsCount      = collectionStats.length;

  // Listed but not in a verified collection — surfaced as its own section
  // when the user is on the VERIFIED filter so they can still see them.
  const unverifiedListings = useMemo(() => merged.filter(m => m.listing && !m.verified), [merged]);
  const floorXnt    = listings.length > 0
    ? listings.reduce((min, l) => {
        const xnt = l.price ? l.price / 1e9 : Infinity;
        return Math.min(min, xnt);
      }, Infinity)
    : 0;

  // Per-tab derived collections.
  const myListings = useMemo(() => merged.filter(m => m.isMine && m.listing), [merged]);
  const walletOnly = useMemo(() => merged.filter(m => m.isMine && !m.listing), [merged]);

  // Featured collection (Brains Elites) for the hero banner — real floor +
  // listing count from the live collection stats; supply is the locked 444.
  const featuredBE = collectionStats.find(c => c.key === 'brains_elites');
  // Banner image = the live Brains Elites listing image ONLY (no bundled promo
  // placeholder). Starts empty (shows the dark frame) and, once a real image
  // resolves, holds it and NEVER reverts to empty during enrichment.
  const [stableHeroImg, setStableHeroImg] = useState('');
  useEffect(() => { if (featuredBE?.image) setStableHeroImg(featuredBE.image); }, [featuredBE?.image]);
  // Other collections (excluding Brains Elites — it's the banner subject) shown
  // as compact story-circles in the banner's top-right corner. Cap at 3.
  const otherCollections = collectionStats.filter(c => c.key !== 'brains_elites').slice(0, 3);
  // Unique seller wallets across active listings — a real "holders in market"
  // count (the marketplace program has no holder index, so this is what's true).
  const uniqueSellers = useMemo(
    () => new Set(listings.filter(l => l.active && l.seller).map(l => l.seller)).size,
    [listings],
  );
  // Biggest sale's NFT — resolve a name from the live stream, else short mint.
  const bigBuyLabel = useMemo(() => {
    const mint = biggestBuy?.nftMint;
    if (!mint) return null;
    const m = merged.find(x => (x as any).nftMint === mint || (x as any).mint === mint);
    return (m?.nftData?.name || (m as any)?.name || shortAddr(mint, 4, 4));
  }, [biggestBuy, merged]);
  // …and its image (the NFT was likely sold, so resolve from chain via Solaris).
  const [bigBuyNft, setBigBuyNft] = useState<{ image?: string; name?: string } | null>(null);
  useEffect(() => {
    const mint = biggestBuy?.nftMint;
    if (!mint) { setBigBuyNft(null); return; }
    const m: any = merged.find(x => (x as any).nftMint === mint || (x as any).mint === mint);
    const streamImg = m?.nftData?.image || m?.image || m?.metaUri;
    if (streamImg) { setBigBuyNft({ image: streamImg, name: m?.nftData?.name || m?.name }); return; }
    let alive = true;
    fetchSolarisNft(mint).then(n => { if (alive && n) setBigBuyNft({ image: n.image, name: n.name }); }).catch(() => {});
    return () => { alive = false; };
  }, [biggestBuy?.nftMint, merged]);
  const fmtK = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(2)}K`
    : n.toFixed(0);

  // Wallet NFTs grouped by collection for the SELL tab.
  const sellGroups = useMemo(() => {
    const map = new Map<string, typeof merged>();
    for (const it of walletOnly) {
      const k = it.collection ?? it.verified?.name ?? 'Uncategorized';
      const arr = map.get(k);
      if (arr) arr.push(it);
      else map.set(k, [it]);
    }
    return Array.from(map.entries());
  }, [walletOnly]);


  return (
    <div className="content content-wide v2lw-v3">
      <div className="lw-stack">
        {/* ── Featured banner (Brains Elites) — minimal-mono (preview 11) style ── */}
        <div className="lw-hero">
          <div className="lw-hero-art">
            {stableHeroImg
              ? <img src={stableHeroImg} alt="Brains Elites"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              : <div className="art-fallback">X1</div>}
          </div>
          <div className="lw-hero-info">
            <div className="lw-hero-top">
              <div className="lw-hero-textcol">
                <div className="lw-hero-eyebrow">
                  <span className="label">Featured Collection</span>
                  <span className="council-tag">Council-Issued</span>
                </div>
                <div className="lw-hero-title">BRAINS ELITES</div>
                <div className="lw-hero-sub">
                  444 council-issued NFTs. Locked supply. Each piece is a unique generative brain portrait —
                  the highest-tier credential in the X1City ecosystem.
                </div>
              </div>
              {otherCollections.length > 0 && (
                <div className="lw-hero-browse">
                  <div className="lw-hero-browse-label">Browse by Collection</div>
                  <div className="lw-hero-browse-circles">
                    {otherCollections.map((c, idx) => {
                      const active = collectionKey === c.key;
                      const initials = c.name.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '◇';
                      return (
                        <button
                          key={c.key}
                          type="button"
                          className={`lw-bc-item${active ? ' active' : ''}`}
                          title={`${c.name} · ${c.listed} listed`}
                          onClick={() => {
                            if (active) setCollectionKey(null);
                            else { setCollectionKey(c.key); setFilter('all'); }
                          }}
                        >
                          <div className="lw-bc-ring">
                            <div className="lw-bc-circle" style={c.image ? undefined : { background: bcGrad(c.key, idx + 1) }}>
                              {c.image ? <img src={c.image} alt="" /> : initials}
                              {c.verified && <div className="lw-bc-vbadge">✓</div>}
                            </div>
                          </div>
                          <div className="lw-bc-name">{c.name}</div>
                          <div className="lw-bc-count">{c.listed} listed</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="lw-hero-bottom">
              <div className="lw-hero-stats">
                <div className="lw-hero-fstat">
                  <span className="l">Floor</span>
                  <span className="v accent">{featuredBE && featuredBE.floorXnt > 0 && isFinite(featuredBE.floorXnt) ? `${featuredBE.floorXnt.toFixed(2)} XNT` : '—'}</span>
                </div>
                <div className="lw-hero-fstat">
                  <span className="l">Supply</span>
                  <span className="v">444</span>
                </div>
                <div className="lw-hero-fstat">
                  <span className="l">Listed</span>
                  <span className="v">{featuredBE?.listed ?? 0}</span>
                </div>
              </div>
              <div className="lw-hero-actions">
                <button
                  type="button"
                  className="lw-hero-btn ghost"
                  onClick={() => { setTab('browse'); setFilter('all'); setCollectionKey(null); }}
                >View All</button>
                <button
                  type="button"
                  className="lw-hero-btn primary"
                  onClick={() => { setTab('browse'); setFilter('all'); setSortMode('priceAsc'); setCollectionKey('brains_elites'); }}
                >Browse Listings</button>
              </div>
            </div>
          </div>
        </div>

        {/* ── NFT Marketplace (platform-wide) stats — labeled so they're not
              mistaken for the featured collection's numbers ── */}
        <div style={{ display:'flex', alignItems:'center', gap:8, margin:'6px 2px 10px', fontFamily:'Orbitron, monospace', fontSize:9, fontWeight:700, letterSpacing:2, color:'#7c8aa0', textTransform:'uppercase' }}>
          <span style={{ color:'#f29030', fontSize:8, filter:'drop-shadow(0 0 5px rgba(242,144,48,.45))' }}>◆</span>
          NFT Marketplace Stats
          <span style={{ flex:1, height:1, background:'linear-gradient(90deg,#1a2433,transparent)' }} />
        </div>

        {/* ── Minimal stat row — preview 11 style ── */}
        <div className="lw-mkstatrow">
          <div className="lw-mkstat"><span className="l">Listings</span><span className="v">{listings.length}</span></div>
          <div className="lw-mkstat"><span className="l">Floor</span><span className="v accent">{isFinite(floorXnt) && floorXnt > 0 ? `${floorXnt.toFixed(2)} XNT` : '—'}</span></div>
          <div className="lw-mkstat"><span className="l">Volume</span><span className="v">{fmtK(marketVolXnt)} XNT</span></div>
          <div className="lw-mkstat"><span className="l">Sales</span><span className="v">{marketSales}</span></div>
          <div className="lw-mkstat"><span className="l">Verified</span><span className="v">{verifiedListingsCount}</span></div>
          <div className="lw-mkstat"><span className="l">Collections</span><span className="v">{collectionsCount}</span></div>
          <div className="lw-mkstat"><span className="l">Sellers</span><span className="v">{uniqueSellers}</span></div>
          {biggestBuy && biggestBuy.priceXnt > 0 && (
            <div className="lw-mkstat" title={`${bigBuyLabel ?? 'NFT'} · ${biggestBuy.nftMint ?? ''}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <div style={{ position: 'relative', width: 32, height: 32, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: '#0a0f16', border: '1px solid #1a2433' }}>
                {bigBuyNft?.image && <V2NFTImage src={bigBuyNft.image} name={bigBuyNft.name || 'NFT'} width={64} priority />}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span className="l">Biggest Buy</span>
                <span className="v accent">{biggestBuy.priceXnt.toFixed(2)} XNT</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Tab nav bar — Glassmorphism (V3): frosted pill bar with a
              gradient-fill on the active tab. The wrapper has the dark blur,
              each tab keeps its own rounded edge so the active glow doesn't
              clip against the container. ── */}
        <div style={{
          display: 'flex', gap: 6, padding: 5,
          background: 'rgba(0,0,0,.30)',
          backdropFilter: 'blur(8px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(8px) saturate(1.2)',
          border: '1px solid rgba(255,255,255,.06)',
          borderRadius: 14,
        }}>
          {([
            { id: 'browse',     glyph: '◆', label: isMobile ? 'BROWSE'  : 'MARKETPLACE',badge: listings.length },
            { id: 'mylistings', glyph: '⌬', label: isMobile ? 'MINE'    : 'MY LISTINGS',badge: connected ? myListings.length : null },
            { id: 'sell',       glyph: '⊞', label: 'SELL',                              badge: connected ? walletOnly.length : null },
            { id: 'activity',   glyph: '⚡', label: isMobile ? 'LOG'     : 'ACTIVITY',  badge: null },
          ] as Array<{ id: MarketTab; glyph: string; label: string; badge: number | null }>).map(t => {
            const active = tab === t.id;
            const isBrowse = t.id === 'browse';
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTab(t.id);
                  if (t.id === 'mylistings' || t.id === 'browse') {
                    invalidateListingsCache();
                    setReloadTick(x => x + 1);
                  }
                }}
                style={{
                  flex: isBrowse ? 1.4 : 1,
                  minWidth: 0,
                  padding: isMobile ? '9px 4px' : '12px 16px',
                  background: active
                    ? 'linear-gradient(135deg, #f29030, #ffb340)'
                    : 'transparent',
                  border: 'none',
                  borderRadius: 10,
                  cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: isMobile ? 4 : 7,
                  fontFamily: 'Orbitron, monospace',
                  fontSize: isMobile ? 9 : 10, fontWeight: 800,
                  letterSpacing: isMobile ? 0.5 : 1.8,
                  color: active ? '#0a0e14' : 'var(--text-muted)',
                  boxShadow: active ? '0 6px 22px rgba(242,144,48,.35)' : 'none',
                  transition: 'background .18s, color .18s, box-shadow .18s',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(e) => {
                  if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
                }}
              >
                <span style={{ fontSize: isMobile ? 10 : 12 }}>{t.glyph}</span>
                <span>{t.label}</span>
                {t.badge != null && t.badge > 0 && (
                  <span style={{
                    background: active ? 'rgba(10,14,20,.22)' : 'rgba(242,144,48,.14)',
                    color: active ? '#0a0e14' : '#f29030',
                    borderRadius: 999, padding: '1px 7px',
                    fontFamily: 'Orbitron, monospace', fontSize: 8, fontWeight: 800,
                  }}>{t.badge}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* ══════════ TAB CONTENT ══════════ */}

        {/* MY LISTINGS TAB ─────────────────────────────────── */}
        {tab === 'mylistings' && (
          <div className="info-card">
            {!connected ? (
              <div className="lw-placeholder" style={{ padding: '40px 12px' }}>
                <div className="lw-placeholder-glyph">🔒</div>
                <div className="lw-placeholder-title">Wallet not connected</div>
                <div className="lw-placeholder-sub">Connect a wallet to see your active listings.</div>
              </div>
            ) : myListings.length === 0 ? (
              <div className="lw-placeholder" style={{ padding: '40px 12px' }}>
                <div className="lw-placeholder-glyph">📋</div>
                <div className="lw-placeholder-title">No active listings</div>
                <div className="lw-placeholder-sub">Pick an NFT from your wallet to list it on the marketplace.</div>
                <button
                  type="button"
                  onClick={() => setTab('sell')}
                  style={{
                    marginTop: 16,
                    fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700,
                    background: 'rgba(0,201,141,.10)',
                    border: '1px solid rgba(0,201,141,.4)',
                    color: '#00c98d',
                    padding: '10px 22px', borderRadius: 7,
                    letterSpacing: 2, cursor: 'pointer',
                  }}
                >⊞ GO TO SELL TAB</button>
              </div>
            ) : (
              <>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: 12, flexWrap: 'wrap', gap: 10,
                }}>
                  <div className="title" style={{ margin: 0 }}>
                    My Active Listings <span style={{ color: '#f29030', marginLeft: 6 }}>· {myListings.length}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => { invalidateListingsCache(); setReloadTick(t => t + 1); }}
                    style={{
                      fontFamily: 'Orbitron, monospace', fontSize: 8, fontWeight: 700,
                      background: 'transparent',
                      border: '1px solid rgba(242,144,48,.3)',
                      color: '#f29030',
                      padding: '4px 10px', borderRadius: 5,
                      letterSpacing: 1.5, cursor: 'pointer',
                    }}
                  >↻ REFRESH</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {myListings.map(it => {
                    const priceLabel = it.priceXnt != null
                      ? (it.priceXnt < 0.01 ? it.priceXnt.toFixed(4) : it.priceXnt.toFixed(2))
                      : '—';
                    return (
                      <div key={it.key} style={{
                        display: 'flex', alignItems: 'center',
                        gap: isMobile ? 10 : 14,
                        padding: isMobile ? '10px 12px' : '14px 18px',
                        borderRadius: 16,
                        background: 'rgba(255,255,255,.04)',
                        backdropFilter: 'blur(10px) saturate(1.15)',
                        WebkitBackdropFilter: 'blur(10px) saturate(1.15)',
                        border: '1px solid rgba(255,255,255,.07)',
                        boxShadow: '0 8px 24px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04)',
                      }}>
                        {/* Thumbnail — V2NFTImage uses position:absolute internally
                            so its container MUST be position:relative or the image
                            escapes to fill the whole viewport. */}
                        <div style={{
                          position: 'relative',
                          width: isMobile ? 52 : 64, height: isMobile ? 52 : 64,
                          borderRadius: 9, overflow: 'hidden',
                          flexShrink: 0,
                          background: '#06090d',
                          border: '1px solid rgba(242,144,48,.4)',
                        }}>
                          {(it.image || it.metaUri)
                            ? <V2NFTImage src={it.image || it.metaUri!} name={it.name} />
                            : <div style={{
                                position: 'absolute', inset: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                color: '#f29030', fontFamily: 'Orbitron, monospace',
                                fontSize: 11, fontWeight: 800,
                              }}>{it.mint.slice(0, 4)}</div>}
                        </div>

                        {/* Info — name + collection + price */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontFamily: 'Orbitron, monospace',
                            fontSize: isMobile ? 11 : 12, fontWeight: 700,
                            color: 'var(--text-primary)',
                            letterSpacing: 0.4,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            marginBottom: 3,
                          }} title={it.name}>{it.name}</div>
                          <div style={{
                            fontFamily: 'Sora, sans-serif',
                            fontSize: isMobile ? 9 : 10,
                            color: 'var(--text-muted)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            marginBottom: 4,
                          }}>{it.collection ?? 'Uncategorized'} · {shortAddr(it.mint, 4, 4)}</div>
                          <div style={{
                            fontFamily: 'Orbitron, monospace',
                            fontSize: isMobile ? 13 : 15, fontWeight: 900,
                            color: '#f29030', letterSpacing: 0.5,
                          }}>
                            {priceLabel}
                            <span style={{ fontSize: 8, color: '#9a6a3a', marginLeft: 4, letterSpacing: 1.5 }}>XNT</span>
                          </div>
                        </div>

                        {/* Action buttons — inline horizontal, but allow wrap
                            so a narrow row doesn't squash labels together. */}
                        <div style={{
                          display: 'flex',
                          gap: isMobile ? 6 : 8,
                          flexShrink: 0, flexWrap: 'wrap',
                          justifyContent: 'flex-end',
                        }}>
                          <button
                            type="button"
                            onClick={() => openBoost(it)}
                            style={listingActionBtn('#f29030', isMobile)}
                            title="Boost — promote on the carousel"
                          >{isMobile ? '⚡' : '⚡ BOOST'}</button>
                          <button
                            type="button"
                            onClick={() => openEditPrice(it)}
                            style={listingActionBtn('#f29030', isMobile)}
                            title="Edit price (delist + relist)"
                          >{isMobile ? '✏' : '✏ EDIT'}</button>
                          <button
                            type="button"
                            onClick={() => openCancel(it)}
                            style={listingActionBtn('#ff4466', isMobile)}
                            title="Delist — return NFT to your wallet"
                          >{isMobile ? '✕' : '✕ DELIST'}</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* SELL TAB ─────────────────────────────────────────── */}
        {tab === 'sell' && (
          <div className="info-card">
            {!connected ? (
              <div className="lw-placeholder" style={{ padding: '40px 12px' }}>
                <div className="lw-placeholder-glyph">🔒</div>
                <div className="lw-placeholder-title">Wallet not connected</div>
                <div className="lw-placeholder-sub">Connect a wallet to list NFTs.</div>
              </div>
            ) : loading && walletOnly.length === 0 ? (
              <div className="lw-placeholder" style={{ padding: '40px 12px' }}>
                <div className="lw-placeholder-glyph">⟳</div>
                <div className="lw-placeholder-sub">Scanning wallet for NFTs…</div>
              </div>
            ) : walletOnly.length === 0 ? (
              <div className="lw-placeholder" style={{ padding: '40px 12px' }}>
                <div className="lw-placeholder-glyph">🪹</div>
                <div className="lw-placeholder-title">No NFTs in this wallet</div>
                <div className="lw-placeholder-sub">
                  NFTs are tokens with 0 decimals and a balance of 1. If you just got one, give it ~30s to index.
                </div>
              </div>
            ) : (
              <>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: 14, flexWrap: 'wrap', gap: 8,
                }}>
                  <div className="title" style={{ margin: 0 }}>
                    List an NFT for Sale <span style={{ color: '#00c98d', marginLeft: 6 }}>· {walletOnly.length}</span>
                  </div>
                  <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: 'var(--text-muted)' }}>
                    {sellGroups.length} collection{sellGroups.length !== 1 ? 's' : ''} · click any NFT to set a price
                  </div>
                </div>
                {sellGroups.map(([colName, items]) => (
                  <div key={colName} style={{ marginBottom: 22 }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
                    }}>
                      <div style={{ width: 3, height: 22, background: '#f29030', borderRadius: 2 }} />
                      <div style={{
                        fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 800,
                        color: 'var(--text-primary)', letterSpacing: 1,
                      }}>{colName}</div>
                      <span style={{
                        fontFamily: 'Orbitron, monospace', fontSize: 8, fontWeight: 700,
                        background: 'rgba(242,144,48,.10)', border: '1px solid rgba(242,144,48,.3)',
                        borderRadius: 10, padding: '2px 8px', color: '#f29030',
                      }}>{items.length}</span>
                    </div>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(5, 1fr)',
                      gap: 10,
                    }}>
                      {items.map(n => (
                        <button
                          key={n.mint}
                          type="button"
                          onClick={() => openList(n)}
                          style={{
                            padding: 0, cursor: 'pointer', textAlign: 'left',
                            background: 'rgba(255,255,255,.04)',
                            backdropFilter: 'blur(10px) saturate(1.15)',
                            WebkitBackdropFilter: 'blur(10px) saturate(1.15)',
                            border: '1px solid rgba(255,255,255,.07)',
                            borderRadius: 14, overflow: 'hidden',
                            boxShadow: '0 6px 18px rgba(0,0,0,.3)',
                            transition: 'transform .14s, border-color .14s, box-shadow .14s, background .14s',
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-3px)';
                            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,.06)';
                            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(242,144,48,.45)';
                            (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 14px 36px rgba(0,0,0,.45), 0 0 0 1px rgba(242,144,48,.2), 0 6px 18px rgba(242,144,48,.18)';
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLButtonElement).style.transform = '';
                            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,.04)';
                            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,.07)';
                            (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 18px rgba(0,0,0,.3)';
                          }}
                        >
                          <div style={{
                            position: 'relative', paddingBottom: '100%',
                            background: '#06090d',
                          }}>
                            {(n.image || n.metaUri)
                              ? <div style={{ position: 'absolute', inset: 0 }}>
                                  <V2NFTImage src={n.image || n.metaUri!} name={n.name} />
                                </div>
                              : <div style={{
                                  position: 'absolute', inset: 0,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontFamily: 'Orbitron, monospace', fontSize: 11,
                                  color: 'var(--text-muted)',
                                }}>{n.mint.slice(0, 5)}</div>}
                            <div style={{
                              position: 'absolute', top: 6, right: 6,
                              fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 800,
                              background: '#f29030', color: '#0a0e14',
                              padding: '2px 7px', borderRadius: 4,
                              letterSpacing: 1,
                            }}>LIST</div>
                          </div>
                          <div style={{ padding: '7px 8px 9px' }}>
                            <div style={{
                              fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 700,
                              color: 'var(--text-primary)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }} title={n.name}>{n.name}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* ACTIVITY TAB ─────────────────────────────────────── */}
        {tab === 'activity' && (
          <div className="info-card">
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 14, flexWrap: 'wrap', gap: 10,
            }}>
              <div className="title" style={{ margin: 0 }}>
                Recent Trades {trades.length > 0 && <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>· {trades.length}</span>}
              </div>
              <button
                type="button"
                onClick={loadTrades}
                disabled={tradesLoading}
                style={{
                  fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 700,
                  background: 'rgba(242,144,48,.06)',
                  border: '1px solid rgba(242,144,48,.3)',
                  color: '#f29030',
                  padding: '5px 12px', borderRadius: 5,
                  letterSpacing: 1.5, cursor: tradesLoading ? 'wait' : 'pointer',
                }}
              >{tradesLoading ? '↻ LOADING…' : '↻ REFRESH'}</button>
            </div>

            {tradesLoading && trades.length === 0 ? (
              <div className="lw-placeholder" style={{ padding: '30px 12px' }}>
                <div className="lw-placeholder-glyph">⟳</div>
                <div className="lw-placeholder-sub">Loading activity…</div>
              </div>
            ) : trades.length === 0 ? (
              <div className="lw-placeholder" style={{ padding: '30px 12px' }}>
                <div className="lw-placeholder-glyph">◌</div>
                <div className="lw-placeholder-sub">No marketplace activity recorded yet.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {trades.slice(0, 30).map(log => {
                  const meta = log.type === 'buy'
                    ? { glyph: '⚡', label: 'SOLD',     color: '#00c98d' }
                    : log.type === 'list'
                    ? { glyph: '🏷', label: 'LISTED',   color: '#00d4ff' }
                    : log.type === 'boost'
                    ? { glyph: '🔥', label: 'BOOSTED',  color: '#bf5af2' }
                    : { glyph: '↩',  label: 'DELISTED', color: '#ff9944' };
                  return (
                    <div key={log.sig} style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '12px 14px', borderRadius: 14,
                      background: 'rgba(255,255,255,.04)',
                      backdropFilter: 'blur(10px) saturate(1.15)',
                      WebkitBackdropFilter: 'blur(10px) saturate(1.15)',
                      border: '1px solid rgba(255,255,255,.07)',
                      boxShadow: '0 6px 18px rgba(0,0,0,.28)',
                    }}>
                      <div style={{
                        position: 'relative',
                        width: 40, height: 40, borderRadius: 7, overflow: 'hidden',
                        flexShrink: 0, background: '#06090d',
                        border: `1px solid ${meta.color}33`,
                      }}>
                        <V2NFTImage
                          src={log.nftData?.image || log.nftData?.metaUri}
                          name={log.nftData?.name || log.nft_mint.slice(0, 4)}
                          width={80}
                        />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <span style={{
                            fontFamily: 'Orbitron, monospace', fontSize: 8, fontWeight: 700,
                            color: meta.color, background: `${meta.color}14`,
                            border: `1px solid ${meta.color}44`,
                            padding: '2px 7px', borderRadius: 4,
                            letterSpacing: 1.2,
                          }}>{meta.glyph} {meta.label}</span>
                          <span style={{
                            fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700,
                            color: 'var(--text-primary)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>{log.nftData?.name ?? `${log.nft_mint.slice(0, 8)}…`}</span>
                        </div>
                        <div style={{
                          fontFamily: 'Sora, sans-serif', fontSize: 10, color: 'var(--text-muted)',
                        }}>
                          {log.type === 'boost' && log.brains
                            ? <span style={{ color: '#bf5af2', marginRight: 8 }}>🔥 {log.brains.toLocaleString()} BRAINS</span>
                            : log.price
                            ? <span style={{ color: '#f29030', marginRight: 8 }}>{(log.price / 1e9).toFixed(2)} XNT</span>
                            : null}
                          <span>{new Date(log.timestamp * 1000).toLocaleString()}</span>
                        </div>
                      </div>
                      <a
                        href={`https://explorer.mainnet.x1.xyz/tx/${log.sig}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{
                          color: 'var(--text-muted)', fontFamily: 'Orbitron, monospace', fontSize: 9,
                          padding: '4px 8px', borderRadius: 5,
                          border: '1px solid rgba(255,255,255,.08)',
                          textDecoration: 'none', flexShrink: 0,
                        }}
                      >TX ↗</a>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* BROWSE TAB ──────────────────────────────────────── */}
        {tab === 'browse' && (
          <>

        {/* Browse by Collection now lives in the featured banner's top-right. */}

        {/* Enrich progress (only while metadata batch is in flight) */}
        {enrichProgress.total > 0 && enrichProgress.done < enrichProgress.total && (
          <div className="market-enrich-bar">
            <div className="market-enrich-label">
              Loading metadata · {enrichProgress.done} / {enrichProgress.total}
            </div>
            <div className="market-enrich-track">
              <div
                className="market-enrich-fill"
                style={{ width: `${(enrichProgress.done / enrichProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Filter bar */}
        <div className="market-toolbar">
          <div className="market-filters">
            {(['verified', 'all', 'uncategorized'] as Filter[]).map((f) => {
              const active = filter === f;
              const label = f === 'verified'      ? '✓ VERIFIED'
                          : f === 'uncategorized' ? '⚠ UNCATEGORIZED'
                          : f.toUpperCase();
              const count = f === 'verified'      ? verifiedListingsCount
                          : f === 'uncategorized' ? uncategorizedCount
                          : listedCount;
              return (
                <button
                  key={f}
                  onClick={() => { setFilter(f); setCollectionKey(null); }}
                  style={{
                    padding: '8px 14px',
                    background: active
                      ? 'linear-gradient(135deg, rgba(242,144,48,.28), rgba(242,144,48,.10))'
                      : 'rgba(255,255,255,.04)',
                    border: `1px solid ${active ? 'rgba(242,144,48,.55)' : 'rgba(255,255,255,.08)'}`,
                    borderRadius: 999,
                    color: active ? '#f29030' : 'var(--text-muted)',
                    fontFamily: 'Orbitron, monospace',
                    fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
                    cursor: 'pointer',
                    transition: 'background .15s, border-color .15s, color .15s',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}
                >
                  {label}
                  <span style={{
                    fontFamily: 'Orbitron, monospace', fontSize: 8,
                    opacity: 0.8,
                  }}>· {count}</span>
                </button>
              );
            })}
          </div>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'rgba(255,255,255,.04)',
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 999,
            padding: '7px 14px',
            minWidth: 220,
          }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>⌕</span>
            <input
              type="text"
              placeholder="Search name or mint…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                flex: 1,
                background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text-primary)',
                fontFamily: 'Sora, sans-serif', fontSize: 11,
              }}
            />
          </div>
          {/* V2-aesthetic pill group — replaces the native <select> whose
              <option> dropdown background got forced white by the browser
              and ignored our color/font CSS. */}
          <div role="radiogroup" aria-label="Sort listings" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {([
              ['newest',    'NEWEST'],
              ['priceAsc',  'PRICE ↑'],
              ['priceDesc', 'PRICE ↓'],
              ['name',      'NAME'],
            ] as const).map(([mode, label]) => {
              const active = sortMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSortMode(mode)}
                  style={{
                    padding: '7px 12px',
                    background: active ? 'rgba(242,144,48,.14)' : 'rgba(255,255,255,.04)',
                    border: `1px solid ${active ? 'rgba(242,144,48,.55)' : 'rgba(255,255,255,.08)'}`,
                    borderRadius: 999,
                    color: active ? '#f29030' : 'var(--text-muted)',
                    fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 800,
                    letterSpacing: 1.5, cursor: 'pointer', outline: 'none',
                    transition: 'background .15s, border-color .15s, color .15s',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Loading / Empty states */}
        {loading && listings.length === 0 && (
          <div className="card">
            <div className="lw-placeholder">
              <div className="lw-placeholder-glyph">⟳</div>
              <div className="lw-placeholder-sub">Scanning marketplace + your wallet…</div>
            </div>
          </div>
        )}
        {err && (
          <div className="card">
            <div className="lw-placeholder">
              <div className="lw-placeholder-glyph">⚠</div>
              <div className="lw-placeholder-sub">{err}</div>
            </div>
          </div>
        )}
        {!loading && !err && filtered.length === 0 && (
          <div className="card">
            <div className="lw-placeholder">
              <div className="lw-placeholder-glyph">◌</div>
              <div className="lw-placeholder-title">No items</div>
              <div className="lw-placeholder-sub">Nothing matches that filter.</div>
            </div>
          </div>
        )}

        {/* NFT grid */}
        {filtered.length > 0 && (
          <div className="market-grid">
            {filtered.map((it) => renderTile(it))}
          </div>
        )}

        {/* Unverified listings — only shown when on VERIFIED filter so the
            user knows there are listings the registry doesn't recognize yet. */}
        {filter === 'verified' && unverifiedListings.length > 0 && (
          <>
            <div className="market-section-title">
              <span className="market-section-glyph">⚠</span>
              <span>Uncategorized Listings</span>
              <span className="market-section-count">{unverifiedListings.length}</span>
              <span className="market-section-note">
                Not in the verified registry — may be new or unverified collections
              </span>
            </div>
            <div className="market-grid">
              {unverifiedListings.map((it) => renderTile(it))}
            </div>
          </>
        )}

          </>
        )}
        {/* end BROWSE tab */}
      </div>

      <V2MarketModal
        target={marketTarget}
        onClose={() => setMarketTarget(null)}
        onDone={() => {
          // Bust the shared 60s listings cache so the next fetch goes to chain
          // — otherwise the just-listed / bought / cancelled NFT stays stuck in
          // the stale snapshot for up to a minute.
          invalidateListingsCache();
          setReloadTick(t => t + 1);
        }}
      />

      <V2BoostModal
        target={boostTarget}
        onClose={() => setBoostTarget(null)}
        onDone={() => setReloadTick(t => t + 1)}
      />

      {detailNft && (() => {
        // Pick the right action props based on this NFT's state in `merged`.
        // - it has a listing AND it's mine → boost / edit / delist
        // - it has a listing AND not mine  → buy
        // - it's mine and unlisted         → list for sale
        // - otherwise                       → info-only
        const ownItem = merged.find(m => m.mint === detailNft.mint) ?? null;
        const isListing = !!ownItem?.listing;
        const isOwned   = !!ownItem?.isMine;
        const ctxBuy   = isListing && !isOwned ? (n: NFTData) => { setDetailNft(null); openBuy({ ...(ownItem as any) }); } : undefined;
        const ctxList  = !isListing && isOwned ? (n: NFTData) => {
          setDetailNft(null);
          setMarketTarget({
            action: 'list',
            mint: n.mint,
            name: n.name,
            image: n.image,
            metaUri: n.metaUri,
          });
        } : undefined;
        const ctxEdit  = isListing && isOwned ? () => { setDetailNft(null); openEditPrice(ownItem!); } : undefined;
        const ctxBoost = isListing && isOwned ? () => { setDetailNft(null); openBoost(ownItem!); }     : undefined;
        const ctxDel   = isListing && isOwned ? () => { setDetailNft(null); openCancel(ownItem!); }    : undefined;
        return (
          <V2NFTDetailModal
            nft={detailNft}
            isMobile={isMobile}
            onClose={() => setDetailNft(null)}
            onBuyThis={ctxBuy}
            onListThis={ctxList}
            onEditPrice={ctxEdit}
            onBoost={ctxBoost}
            onDelist={ctxDel}
          />
        );
      })()}
    </div>
  );

  function openBuy(it: typeof merged[0]) {
    if (!it.listing) return;
    setMarketTarget({
      action: 'buy',
      mint:   it.mint,
      name:   it.name,
      image:  it.image,
      metaUri: it.metaUri,
      seller: it.listing.seller,
      priceLamports: it.listing.price,
    });
  }
  function openList(it: typeof merged[0]) {
    setMarketTarget({
      action: 'list',
      mint:   it.mint,
      name:   it.name,
      image:  it.image,
      metaUri: it.metaUri,
    });
  }
  function openCancel(it: typeof merged[0]) {
    if (!it.listing) return;
    setMarketTarget({
      action: 'cancel',
      mint:   it.mint,
      name:   it.name,
      image:  it.image,
      metaUri: it.metaUri,
      priceLamports: it.listing.price,
    });
  }

  function openEditPrice(it: typeof merged[0]) {
    if (!it.listing) return;
    setMarketTarget({
      action: 'updatePrice',
      mint:   it.mint,
      name:   it.name,
      image:  it.image,
      metaUri: it.metaUri,
      seller: it.listing.seller,
      priceLamports: it.listing.price,
    });
  }

  function openBoost(it: typeof merged[0]) {
    if (!it.listing) return;
    setBoostTarget({
      listingPda:    it.listing.listingPda,
      nftMint:       it.mint,
      priceLamports: it.listing.price,
      name:          it.name,
      image:         it.image,
      metaUri:       it.metaUri,
    });
  }

  function openDetail(it: typeof merged[0]) {
    // Build NFTData from listing.nftData or wallet NFTData. CRITICAL: pin the
    // image to EXACTLY what the grid card rendered (it.image). Otherwise the
    // modal can show a different artwork than the card you clicked — e.g.
    // it.nftData.image diverging from it.image, or enrichNFT re-resolving the
    // metaUri to a different/guessed image (the "wrong punk" bug).
    const cardImage = it.image || it.nftData?.image;
    const base: NFTData = {
      ...(it.nftData ?? {
        mint: it.mint, name: it.name, symbol: '',
        balance: 1, decimals: 0, isToken2022: false,
        collection: it.collection,
      }),
      image: cardImage,
      metaUri: it.metaUri || it.nftData?.metaUri,
    };
    setDetailNft(base);
    // Lazy enrich so attributes/description show up — but KEEP the card's image
    // (never let the re-fetch swap the artwork the user clicked).
    enrichNFT(base).then(enriched => {
      setDetailNft(prev => (prev?.mint === enriched.mint
        ? { ...enriched, image: cardImage || enriched.image }
        : prev));
    }).catch(() => {});
  }

  function renderTile(it: typeof merged[0]) {
    return (
      <div className="market-tile" key={it.key} style={{ cursor: 'pointer' }}>
        <div
          className="market-tile-img"
          onClick={() => openDetail(it)}
          title="View details"
        >
          {(it.image || it.metaUri) ? (
            <V2NFTImage src={it.image || it.metaUri} name={it.name} />
          ) : (
            <span className="market-tile-num">#{it.mint.slice(0, 4)}</span>
          )}
          {it.verified && (
            <div
              className="market-tile-rarity"
              style={{
                color: '#f29030',
                borderColor: 'rgba(242,144,48,0.45)',
                background: 'rgba(6,9,13,0.85)',
                backdropFilter: 'blur(2px)',
              }}
              title={`Verified: ${it.verified.name}`}
            >
              ✓ {it.verified.name.toUpperCase()}
            </div>
          )}
          {it.isMine && (
            <div
              className="market-tile-rarity"
              style={{
                color: '#cdd8e2',
                borderColor: 'rgba(205,216,226,0.3)',
                background: 'rgba(8,12,15,0.82)',
                top: it.verified ? 34 : 9,
              }}
            >
              OWNED
            </div>
          )}
        </div>
        <div className="market-tile-meta">
          <div
            className="market-tile-col"
            onClick={() => openDetail(it)}
            title={it.collection || 'Lab Work'}
          >
            {it.collection || 'Lab Work'}{it.verified ? ' ★' : ''}
          </div>
          <div
            className="market-tile-name"
            onClick={() => openDetail(it)}
            title="View details"
          >{it.name}</div>
          <div className="market-tile-foot">
            {it.listing && it.isMine ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', minWidth: 0 }}>
                <div className="market-tile-price-wrap">
                  <span className="market-tile-price-lbl">Price</span>
                  <span className="market-tile-price">
                    {it.priceXnt != null ? it.priceXnt.toFixed(2) : '—'}<span className="unit">XNT</span>
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 5 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); openBoost(it); }}
                    disabled={!connected}
                    title="Boost — promote this listing on the carousel"
                    style={marketTileActionBtn('#bf5af2', connected)}
                  >BOOST</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); openEditPrice(it); }}
                    disabled={!connected}
                    title="Edit price (delist + relist)"
                    style={marketTileActionBtn('#8a9ab8', connected)}
                  >EDIT</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); openCancel(it); }}
                    disabled={!connected}
                    title="Delist (cancels listing, returns NFT to wallet)"
                    style={marketTileActionBtn('#ff4466', connected)}
                  >DELIST</button>
                </div>
              </div>
            ) : it.listing ? (
              <>
                <div className="market-tile-price-wrap">
                  <span className="market-tile-price-lbl">Price</span>
                  <span className="market-tile-price">
                    {it.priceXnt != null ? it.priceXnt.toFixed(2) : '—'}<span className="unit">XNT</span>
                  </span>
                </div>
                <button
                  className="market-tile-buy"
                  onClick={(e) => { e.stopPropagation(); openBuy(it); }}
                  disabled={!connected}
                  title={connected ? 'Buy this NFT' : 'Connect wallet to buy'}
                >
                  BUY
                </button>
              </>
            ) : it.isMine ? (
              <>
                <span className="market-tile-unlisted">UNLISTED</span>
                <button
                  className="market-tile-buy"
                  onClick={(e) => { e.stopPropagation(); openList(it); }}
                >
                  LIST
                </button>
              </>
            ) : (
              <span className="market-tile-unlisted">UNLISTED</span>
            )}
          </div>
        </div>
      </div>
    );
  }
}

// Fallback gradient for a collection's story-circle avatar when it has no
// image. Brains Elites is always orange; others cycle a v2-palette set.
function bcGrad(key: string, idx: number): string {
  if (key === 'brains_elites') return 'linear-gradient(135deg,#f29030,#ffb700)';
  const palette = [
    'linear-gradient(135deg,#00d4ff,#0088aa)',
    'linear-gradient(135deg,#bf5af2,#7b2dbf)',
    'linear-gradient(135deg,#00c98d,#007a55)',
    'linear-gradient(135deg,#ffb700,#a07000)',
    'linear-gradient(135deg,#ff4444,#aa1111)',
    'linear-gradient(135deg,#6a8aaa,#3a4a5a)',
  ];
  return palette[idx % palette.length];
}

// ── shared style helpers (kept local so the file is self-contained) ──

// Button style for the inline My Listings actions. Compact pill — no colored
// box-shadow halo (that was bleeding 14px past each button's edge and visually
// overlapping the neighbours with only an 8px row gap).
// Equal-width action button for the marketplace grid card foot — three of these
// fill the card width in a row below the price so nothing bleeds off a narrow tile.
function marketTileActionBtn(color: string, connected: boolean): React.CSSProperties {
  return {
    flex: 1, minWidth: 0, textAlign: 'center',
    fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 700,
    padding: '6px 0', borderRadius: 6, letterSpacing: 1,
    background: `${color}1a`, border: `1px solid ${color}59`, color,
    cursor: connected ? 'pointer' : 'not-allowed',
    opacity: connected ? 1 : 0.5,
  };
}

function listingActionBtn(color: string, isMobile = false): React.CSSProperties {
  return {
    fontFamily: 'Orbitron, monospace',
    fontSize: isMobile ? 10 : 9,
    fontWeight: 800,
    padding: isMobile ? '7px 9px' : '8px 12px',
    borderRadius: 999,
    background: `${color}14`,
    border: `1px solid ${color}66`,
    color,
    letterSpacing: 1.2,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    lineHeight: 1,
    flexShrink: 0,
    transition: 'background .15s, border-color .15s',
  };
}
