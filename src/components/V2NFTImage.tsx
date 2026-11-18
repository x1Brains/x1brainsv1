import { useEffect, useRef, useState } from 'react';

// Persistent localStorage cache for resolved image URLs.
// v2 -> v3: v2 rows were written by a fetchJsonMulti that reported the
// UNPROXIED url whenever a proxy won the race, so an unknown number of them
// pin a gateway URL this browser cannot load (nftstorage.link and friends
// currently answer 429). A v2 row that is wrong is indistinguishable from one
// that is right, so the key is bumped rather than audited, and v2 is dropped.
// v3 -> v4 (2026-11-15): v3 rows were written OPTIMISTICALLY — the URL was
// pinned as soon as it was resolved, before anything confirmed a browser could
// actually paint it. Every dead host this app has passed through (permagate.io,
// ipfs.io, the removed /api/nft-meta proxy) is therefore still pinned in the
// browsers that visited during those windows, and a cached entry is returned
// without ever being re-checked. That is why fixing the server-side URLs did
// nothing for existing visitors while a fresh browser looked perfect:
// REPRODUCED by seeding one stale permagate row — that card alone went black
// with display:none while every other Elite painted.
// A v3 row that is wrong is indistinguishable from one that is right, so the
// key is bumped and v3 is dropped wholesale.
const CACHE_KEY = 'v2_nft_img_cache_v4';
const OLD_CACHE_KEYS = ['v2_nft_img_cache_v2', 'v2_nft_img_cache_v3'];
const cache: Map<string, string | null> = (() => {
  const m = new Map<string, string | null>();
  for (const k of OLD_CACHE_KEYS) { try { localStorage.removeItem(k); } catch {} }
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        // ⛔ Scrub dead hosts on the way IN. A url pinned before permagate died
        // must never be handed back out, whatever version wrote it.
        const val = typeof v === 'string'
          ? v.replace(/^https?:\/\/(?:www\.)?permagate\.io\//i, 'https://arweave.net/')
          : (v as string | null);
        m.set(k, val);
      }
    }
  } catch {}
  return m;
})();

let persistTimer: number | null = null;
function persist() {
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    try {
      const obj: Record<string, string> = {};
      cache.forEach((v, k) => { if (v) obj[k] = v; });
      // Written in full, so a cache.delete() really does remove the entry.
      localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch {}
  }, 800);
}

import { imageCandidates, collectionRescues, liveGatewayUrl } from '../utils/ipfsGateways';

/** ⛔⛔⛔ permagate.io IS DEAD — its TLS cert does not cover the hostname, so
 *  every request fails `ERR_CERT_COMMON_NAME_INVALID` and NOTHING can rescue
 *  it. The server rewrote these to arweave.net back on 11-14, but the CLIENT
 *  never did, so any permagate url still sitting in a visitor's localStorage
 *  (or arriving from an indexer) was requested forever — and after the 11-18
 *  retry change it was requested three times per card.
 *  Observed live in the owner's console 2026-11-18:
 *     GET https://permagate.io/iE3Yv…/082.png  net::ERR_CERT_COMMON_NAME_INVALID
 *     GET https://permagate.io/o-Gwb…/0035.png net::ERR_CERT_COMMON_NAME_INVALID
 *  Same path, same bytes, served fine by arweave.net. Rewriting at the single
 *  choke point every url passes through makes the dead host unreachable no
 *  matter which layer it came from — cache, indexer or metadata. */
function killDeadHosts(u: string): string {
  if (!u) return u;
  return u.replace(/^https?:\/\/(?:www\.)?permagate\.io\//i, 'https://arweave.net/');
}

function resolveGateway(u: string): string {
  u = killDeadHosts(u);
  // liveGatewayUrl also moves saved https://ipfs.io/... (dead gateway) links to a live one —
  // on-chain metadata URIs use it too (Genesis Stone / Aurora Borealis, 10-05).
  return liveGatewayUrl(u
    .replace('ipfs://', 'https://solarisprime.xyz/ipfs/')
    .replace('ar://',   'https://arweave.net/'));
}

function isImageUrl(u: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(u) || u.startsWith('data:image');
}

// Race all proxies in parallel via Promise.any. First 2xx wins; the others
// are cancelled via shared AbortController. Cuts the worst-case wait from
// ~24s (serial 4×6s) down to ~6s (slowest of the parallel four), and the
// best case to whatever the fastest proxy can return.
async function fetchJsonMulti(url: string): Promise<any | null> {
  // ⛔ Was a 4-way race. Measured 2026-11-14, three of the four are dead:
  //   corsproxy.io         403  (free use blocked)
  //   api.allorigins.win   522 after 19.6s  — and it held the AbortController
  //                        for the full 12s budget, so a card that could have
  //                        painted from `url` sat empty waiting for a corpse
  //   /api/nft-meta/<path> 400  (the rewrite broke on any path; now removed)
  // Metadata resolution has moved server-side to POST /api/nft-meta, which has
  // no CORS problem and caches the result for everyone. This path is now only
  // the last resort for a URL that arrives without a mint attached.
  const candidates = [url];
  const ctrl = new AbortController();
  // 12s, not 4s. gateway.pinata.cloud — which hosts a lot of this metadata —
  // measured 3-9s. A 4s abort turned that into a coin flip: the same wallet
  // showed some cats/pups and not others, differently on each reload, because
  // whichever fetch lost the race fell through to a guessed URL below.
  const timer = setTimeout(() => ctrl.abort(), 12000);

  const tries = candidates.map(async (candidate) => {
    const r = await fetch(candidate, { signal: ctrl.signal });
    if (!r.ok) throw new Error('not ok');
    const ct = r.headers.get('content-type') ?? '';

    // ⛔ THIS RETURNED `url`, THE UNPROXIED ORIGINAL, NOT THE CANDIDATE THAT
    // ACTUALLY SERVED THE BYTES. When the winner was `/api/nft-meta/...` — the
    // same-origin proxy that exists precisely because the direct URL is blocked
    // or rate-limited — we threw the working URL away, reported the broken one,
    // and then CACHED it (step 2 of the effect writes this straight into
    // localStorage). One rescued fetch became a permanently pinned dead URL.
    // Whichever candidate won is by definition one this browser can load.
    // ⛔ A METADATA URI THAT ANSWERS WITH AN IMAGE IS NOT NECESSARILY THIS
    // NFT'S IMAGE. Measured 2026-11-15: the X1 Ninjas Arweave manifest serves a
    // PNG for EVERY `<n>.json` path, and it is the SAME PNG for all of them
    // (md5 9ed3973295be for both 0035.json and 0412.json) — a generic blue
    // ninja, not that token's art.
    // ⛔⛔ Flag it WEAK, never reject it. Throwing here would take out any
    // collection whose metadata endpoint legitimately answers with the image.
    // The caller tries the extension-swapped siblings first and keeps this as
    // the last resort, so a wrong-but-real image still beats a blank card.
    if (ct.startsWith('image/')) {
      return /\.json(\?|$)/i.test(candidate)
        ? { image: candidate, _weakImage: true }
        : { image: candidate };
    }
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
// Hosts weserv can't fetch reliably. Irys serves extensionless object ids and
// 302s to a per-object CDN subdomain; weserv returns an error image for those,
// which showed up as FEDS listings rendering a broken tile while the same URL
// loaded fine when requested directly. Serve these raw.
//
// ⛔⛔ arweave.net and solarisprime.xyz measured 2026-11-15 — between them they
// host nearly every image on the marketplace, and BOTH were failing at weserv,
// so almost every card was burning a guaranteed-dead request before it could
// even start loading the real image:
//     arweave.net       weserv 404 (90-byte JSON error)   direct 200 in 0.5-2.5s
//     solarisprime.xyz  weserv 400                        direct 200 in 1.6s
// The 404 is because weserv defaults to plain HTTP unless the url is prefixed
// `ssl:`, which we never sent. Adding `ssl:` does fix arweave — but it then
// cold-fetches in **23 s**, far worse than going direct, and solarisprime stays
// 400 either way. So both go direct.
//
// weserv is KEPT for the hosts where it measurably wins and resizes:
//     api.x1app.fyi       0.61s -> 0.15s     (107 of 171 cached rows)
//     lighthouse.storage  0.98s -> 0.15s, 148KB -> 54KB
//     x1pups.vercel.app   0.24s -> 0.16s
const CDN_BYPASS_HOSTS = ['irys.xyz', 'permagate.io', 'arweave.net', 'solarisprime.xyz',
                          'ipfs.x1forge.xyz'];   // weserv 400 / ORB-blocked; direct 200 in 1.1s

function viaImageCDN(url: string, width: number): string {
  if (!url) return url;
  if (url.startsWith('data:')) return url;        // inline images — skip
  if (!url.startsWith('http')) return url;        // not http(s)
  if (url.includes('images.weserv.nl')) return url; // already wrapped
  if (CDN_BYPASS_HOSTS.some(h => url.includes(h))) return url;
  // weserv expects url without protocol
  return weservUrl(url, width);
}

/** weserv, built correctly. ⛔ Without the `ssl:` prefix weserv fetches over
 *  plain HTTP and returns 404 for https-only hosts like arweave.net. */
function weservUrl(url: string, width: number): string {
  const stripped = url.replace(/^https?:\/\//, '');
  const target = /^https:/i.test(url) ? `ssl:${stripped}` : stripped;
  return `https://images.weserv.nl/?url=${encodeURIComponent(target)}&w=${width}&q=82&output=webp`;
}

export default function V2NFTImage({ src, name, priority = false, width = 600, fit = 'cover' }: Props) {
  /** Extension/path guesses for metadata that would not resolve. Tried in the
   *  <img> error chain; never cached, because a guess is not an answer. */
  const [guessed, setGuesses] = useState<string[]>([]);
  // A gateway that HANGS never fires onError, so the card stayed blank on it.
  // A still-unloaded <img> that has been ON SCREEN for two 4 s ticks in a row moves on
  // to the next candidate. Off-screen lazy images haven't started loading, so they are
  // never advanced (the first version skipped them through the whole chain).
  const imgRef = useRef<HTMLImageElement | null>(null);
  const chainRef = useRef<string[]>([]);
  const advance = (el: HTMLImageElement): boolean => {
    const next = Number(el.dataset.try ?? '0') + 1;
    if (next >= chainRef.current.length) return false;
    el.dataset.try = String(next);
    el.src = chainRef.current[next];
    return true;
  };
  const [imgUrl, setImgUrl] = useState<string | null | undefined>(() => {
    if (!src) return null;
    if (cache.has(src)) return cache.get(src) ?? null;
    return undefined; // pending
  });

  useEffect(() => {
    setGuesses([]);
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
      if (img && !json?._weakImage) {
        cache.set(src, img);
        persist();
        if (!cancelled) setImgUrl(img);
        return;
      }
      // Weak: try `<n>.png` / `<n>.jpg` first but keep the weak image at the
      // END of the chain, so the card still paints if no sibling exists.
      // Deliberately not cached — a guess is not an answer.
      if (img && json?._weakImage) {
        const b = resolved.replace(/\.json$/i, '');
        const alts = ['png', 'jpg', 'jpeg', 'webp', 'gif'].map(e => `${b}.${e}`);
        if (!cancelled) { setGuesses([...alts, img]); setImgUrl(alts[0]); }
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
        // A GUESS, not a resolution — deliberately NOT written to the cache.
        // Persisting it meant one slow metadata fetch could pin a wrong URL in
        // localStorage forever, so the NFT stayed broken on every later visit
        // even once its host recovered. Held in state instead, and every guess
        // is offered to the <img> error chain rather than only the first.
        if (!cancelled) { setGuesses(guesses); setImgUrl(guesses[0]); }
        return;
      }

      cache.set(src, null);
      persist();
      if (!cancelled) setImgUrl(null);
    })();

    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    if (!imgUrl) return;
    const id = setInterval(() => {
      const el = imgRef.current;
      if (!el) return;
      if (el.complete && el.naturalWidth > 0) { clearInterval(id); return; }
      const r = el.getBoundingClientRect();
      const onScreen = r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
      if (!onScreen) { delete el.dataset.seen; return; }
      if (el.dataset.seen !== el.src) { el.dataset.seen = el.src; return; }   // first visible tick for this candidate
      if (!advance(el)) clearInterval(id);
    }, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgUrl]);

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

  // Try in order: CDN-proxied → the raw URL → the same content on every other
  // IPFS gateway → any collection-specific rescue host. Two gateways failing is
  // routine (see utils/ipfsGateways), so giving up after one was why listings
  // sat on the broken-image placeholder.
  // Dead-gateway links are moved to a live gateway before the CDN wrap; a collection's
  // own host (X1 Pups thumbs) goes first when one is known.
  const proxied = viaImageCDN(liveGatewayUrl(imgUrl), width);
  // ⛔⛔⛔ arweave.net CANNOT TAKE A COLD BURST. Measured 2026-11-15 in a real
  // browser: a FIRST visit fires ~45 arweave images at once and 26 of them come
  // back empty (17 Ninjas, 8 Elites, 1 Pepe); the SECOND visit paints 171/171
  // purely because the browser cache is warm. One at a time, and even a 29-way
  // burst from node, arweave answers 200 every time — so this only appears on a
  // real cold page load, which is precisely the case users see.
  //
  // Hosts in CDN_BYPASS_HOSTS go direct FIRST because that is fastest when it
  // works, but they must not be left with a chain of ONE. weserv is appended as
  // a last resort: its edge absorbs the burst, fetching the origin once instead
  // of 45 times. Slow on a cold miss, but a slow image beats a blank card.
  const lastResort = CDN_BYPASS_HOSTS.some(h => imgUrl.includes(h))
    ? [weservUrl(imgUrl, width)] : [];
  const chain = [...new Set([...collectionRescues(imgUrl), proxied,
                             ...imageCandidates(imgUrl),
                             ...guessed.flatMap(g => imageCandidates(g)),
                             ...lastResort])];
  chainRef.current = chain;
  return (
    <img
      ref={imgRef}
      src={chain[0]}
      alt={name || 'NFT'}
      loading={priority ? 'eager' : 'lazy'}
      // @ts-expect-error — fetchpriority not yet in React's IntrinsicElements types
      fetchpriority={priority ? 'high' : 'auto'}
      decoding="async"
      onLoad={(e) => {
        // ⛔ Pin ONLY what actually rendered. The previous code cached the URL
        // the moment it was resolved, so a URL that never painted was still
        // remembered forever. Whatever the error chain finally landed on is by
        // definition one this browser can load — that is the thing worth keeping.
        const el = e.currentTarget as HTMLImageElement;
        // ⛔ Pin the LOGICAL image url, never `el.src`. el.src may be a
        // CDN-wrapped or fallback candidate, and caching that collapses the
        // whole chain to a single entry on every later visit — one hiccup then
        // has nowhere to fall back to.
        if (src && imgUrl && el.naturalWidth > 0 && cache.get(src) !== imgUrl) {
          cache.set(src, imgUrl);
          persist();
        }
        // it painted — clear the retry counter so a later failure gets its
        // full allowance again rather than inheriting an exhausted one.
        delete el.dataset.round;
      }}
      onError={(e) => {
        const el = e.currentTarget as HTMLImageElement;
        if (advance(el)) return;
        // ⛔⛔⛔ EVERY CANDIDATE FAILED — THAT IS USUALLY TRANSIENT, NOT FATAL.
        // arweave.net drops requests under a cold burst, and weserv can hiccup
        // in the same moment. Hiding the image here turned a two-second blip
        // into a card that stayed blank for the whole session, which is what
        // the owner kept seeing on 11-15 and again on 11-18 while every URL,
        // the database and a cold headless run all measured perfect.
        // Start the chain again, twice, backing off — a slow image beats a
        // blank one, and a transient failure must never be permanent.
        const rounds = Number(el.dataset.round ?? '0');
        if (rounds < 2) {
          el.dataset.round = String(rounds + 1);
          const wait = 1200 * (rounds + 1);
          window.setTimeout(() => {
            if (!el.isConnected) return;
            el.dataset.try = '0';
            el.style.display = '';
            el.src = chainRef.current[0];
          }, wait);
          return;
        }
        // ⛔ Every candidate failed. FORGET this src rather than pinning a
        // failure — otherwise one bad night gets baked into the browser and
        // survives every later fix. Next load re-resolves from scratch.
        if (src) { cache.delete(src); persist(); }
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
