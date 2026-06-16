import { useEffect, useState } from 'react';

// Persistent localStorage cache for resolved image URLs.
const CACHE_KEY = 'v2_nft_img_cache_v2';
const cache: Map<string, string | null> = (() => {
  const m = new Map<string, string | null>();
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) m.set(k, v as string | null);
    }
  } catch {}
  return m;
})();

let persistTimer: number | null = null;
function persist() {
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    try {
      const obj: Record<string, string | null> = {};
      cache.forEach((v, k) => { if (v !== null) obj[k] = v; });
      localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch {}
  }, 800);
}

function resolveGateway(u: string): string {
  return u
    .replace('ipfs://', 'https://nftstorage.link/ipfs/')
    .replace('ar://',   'https://arweave.net/');
}

function isImageUrl(u: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(u) || u.startsWith('data:image');
}

// Race all proxies in parallel via Promise.any. First 2xx wins; the others
// are cancelled via shared AbortController. Cuts the worst-case wait from
// ~24s (serial 4×6s) down to ~6s (slowest of the parallel four), and the
// best case to whatever the fastest proxy can return.
async function fetchJsonMulti(url: string): Promise<any | null> {
  const candidates = [
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `/api/nft-meta/${url.replace(/^https?:\/\//, '')}`,
    url, // direct (in case host serves CORS)
  ];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);

  const tries = candidates.map(async (candidate) => {
    const r = await fetch(candidate, { signal: ctrl.signal });
    if (!r.ok) throw new Error('not ok');
    const ct = r.headers.get('content-type') ?? '';
    if (ct.startsWith('image/')) return { image: url };
    const text = await r.text();
    return JSON.parse(text); // throws if not JSON, which propagates as a rejection
  });

  try {
    const winner = await Promise.any(tries);
    ctrl.abort(); // cancel the rest
    return winner;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractImage(json: any): string | null {
  if (!json) return null;
  const candidates = [
    json.image, json.image_url, json.imageUrl, json.imgUrl,
    json.media?.uri, json.media?.url, typeof json.media === 'string' ? json.media : null,
    json.animation_url,
    json.properties?.image,
    json.properties?.files?.[0]?.uri,
    json.properties?.files?.[0]?.url,
    json.properties?.files?.[0],
    json.properties?.files?.[1]?.uri,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return resolveGateway(c);
  }
  return null;
}

type Props = {
  src?: string;      // Either a pre-resolved image URL or a metadata URI
  name?: string;
  /** Above-the-fold? Eager load + fetchpriority high. */
  priority?: boolean;
  /** Target render width in CSS pixels — drives the CDN proxy resize hint. */
  width?: number;
  /** object-fit. 'cover' (default) fills + crops; 'contain' shows the whole image. */
  fit?: 'cover' | 'contain';
};

// Wrap http(s) URLs through the weserv.nl image CDN. This:
//   • serves through a globally-cached CDN edge (much faster than IPFS gateways)
//   • resizes to the requested width so the browser doesn't have to download
//     a 4K original when we're rendering a 600px thumbnail
//   • re-encodes to a smaller format
// IPFS/Arweave URLs are already resolved to https://... by resolveGateway, so
// they pass through fine.
function viaImageCDN(url: string, width: number): string {
  if (!url) return url;
  if (url.startsWith('data:')) return url;        // inline images — skip
  if (!url.startsWith('http')) return url;        // not http(s)
  if (url.includes('images.weserv.nl')) return url; // already wrapped
  // weserv expects url without protocol
  const stripped = url.replace(/^https?:\/\//, '');
  return `https://images.weserv.nl/?url=${encodeURIComponent(stripped)}&w=${width}&q=82&output=webp`;
}

export default function V2NFTImage({ src, name, priority = false, width = 600, fit = 'cover' }: Props) {
  const [imgUrl, setImgUrl] = useState<string | null | undefined>(() => {
    if (!src) return null;
    if (cache.has(src)) return cache.get(src) ?? null;
    return undefined; // pending
  });

  useEffect(() => {
    if (!src) { setImgUrl(null); return; }
    if (cache.has(src)) { setImgUrl(cache.get(src) ?? null); return; }

    let cancelled = false;

    (async () => {
      const resolved = resolveGateway(src);

      // 1. If it's already a direct image URL, use it
      if (isImageUrl(resolved)) {
        cache.set(src, resolved);
        persist();
        if (!cancelled) setImgUrl(resolved);
        return;
      }

      // 2. Fetch as JSON metadata, extract image
      const json = await fetchJsonMulti(resolved);
      const img = extractImage(json);
      if (img) {
        cache.set(src, img);
        persist();
        if (!cancelled) setImgUrl(img);
        return;
      }

      // 3. Pattern guess (strip .json, swap path)
      const guesses: string[] = [];
      const base = resolved.replace(/\.json$/i, '').replace(/\/$/, '');
      const exts = ['png', 'jpg', 'webp', 'gif'];
      for (const ext of exts) guesses.push(`${base}.${ext}`);
      for (const [from, to] of [
        ['/metadata/', '/images/'],
        ['/metadata/', '/image/'],
        ['/meta/',     '/images/'],
        ['/meta/',     '/image/'],
        ['/json/',     '/images/'],
        ['/api/metadata/', '/api/images/'],
      ] as [string, string][]) {
        if (base.includes(from)) {
          const sw = base.replace(from, to);
          for (const ext of exts) guesses.push(`${sw}.${ext}`);
        }
      }
      if (guesses.length > 0) {
        // Probe by trying to load the first guess as an image; if it works,
        // great. If not, browser will show the broken-image placeholder and
        // we'll have at least tried.
        cache.set(src, guesses[0]);
        persist();
        if (!cancelled) setImgUrl(guesses[0]);
        return;
      }

      cache.set(src, null);
      persist();
      if (!cancelled) setImgUrl(null);
    })();

    return () => { cancelled = true; };
  }, [src]);

  if (imgUrl === undefined) {
    return (
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(191,90,242,.06)',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: '50%',
          border: '2px solid rgba(191,90,242,.2)',
          borderTop: '2px solid #bf5af2',
          animation: 'spin 0.8s linear infinite',
        }} />
      </div>
    );
  }

  if (!imgUrl) {
    return (
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(242,144,48,.04)',
      }}>
        <span style={{ fontSize: 28, opacity: 0.4 }}>🖼️</span>
        <span style={{
          fontFamily: 'Orbitron,monospace', fontSize: 8,
          color: '#6a7a94', marginTop: 4, letterSpacing: 1,
        }}>NO IMAGE</span>
      </div>
    );
  }

  const proxied = viaImageCDN(imgUrl, width);
  return (
    <img
      src={proxied}
      alt={name || 'NFT'}
      loading={priority ? 'eager' : 'lazy'}
      // @ts-expect-error — fetchpriority not yet in React's IntrinsicElements types
      fetchpriority={priority ? 'high' : 'auto'}
      decoding="async"
      onError={(e) => {
        const el = e.currentTarget as HTMLImageElement;
        // Fall back from the CDN-proxied URL to the raw URL once.
        if (proxied !== imgUrl && el.dataset.fallback !== '1') {
          el.dataset.fallback = '1';
          el.src = imgUrl;
          return;
        }
        // Both failed — mark and show placeholder.
        cache.set(src!, null);
        persist();
        el.style.display = 'none';
      }}
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        objectFit: fit,
      }}
    />
  );
}
