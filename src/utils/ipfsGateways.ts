// ─────────────────────────────────────────────────────────────────────────────
// IPFS gateway fallbacks for <img> tags.
//
// No single gateway serves everything, and the failures are invisible to curl:
//
//  • Path gateways (ipfs.io, dweb.link, nftstorage.link) redirect ACTIVE content
//    — SVG in particular — to a `<cid>.ipfs.dweb.link` subdomain for origin
//    sandboxing. That response carries a restrictive Cross-Origin-Resource-Policy,
//    so Chrome kills the image with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin while
//    `curl` happily reports 200. This is exactly what hid the X1 Cats portrait
//    (a 7 KB SVG): every path gateway returned it, no browser would paint it.
//  • Raster images are NOT redirected, so those same gateways work for JPEG/PNG.
//  • gateway.pinata.cloud serves both, but is slow (3-9s), so it is a fallback
//    rather than the default.
//
// Hence: try in order, advance on error. Measured in headless Chromium against
// the live collections, 2026-08-18.
// ─────────────────────────────────────────────────────────────────────────────

/** Ordered by (speed x reliability) for browser <img> loads.
 *  10-05 re-measure: ipfs.io, dweb.link, nftstorage.link and w3s.link all answer 429
 *  ("switching to a service worker gateway only"); Solaris serves in ~0.5 s, Pinata in 6-9 s. */
export const IPFS_GATEWAYS = [
  'https://solarisprime.xyz/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://nftstorage.link/ipfs/',
] as const;

/** `https://<any-gateway>/ipfs/<path>` → `<path>`, else null. */
export function ipfsPathOf(url: string): string | null {
  if (!url) return null;
  const m = /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(url);
  if (m) return m[1];
  const ip = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(url);
  return ip ? ip[1] : null;
}

/**
 * Collection-specific rescues: content that NO public IPFS gateway serves any
 * more, but whose collection publishes the same art on its own host.
 *
 * X1 Pups: two of eight listings point at CIDs that 404 on ipfs.io, dweb.link,
 * nftstorage.link AND pinata — the content is simply no longer pinned. The
 * collection's own site serves every edition at /thumbs/pup_<4-digit>.jpg,
 * verified against pup_0001 / pup_0039 / pup_0775.
 */
export function collectionRescues(url: string): string[] {
  const out: string[] = [];
  const pup = /pup[_-]?(\d{1,4})\.(?:png|jpe?g|webp|gif)$/i.exec(url);
  if (pup) out.push(`https://x1pups.vercel.app/thumbs/pup_${pup[1].padStart(4, '0')}.jpg`);
  return out;
}

/**
 * Route a URL through the app's own `/api/nft-meta/` proxy (a Vercel rewrite in
 * production, a vite middleware in dev). The request becomes SAME-ORIGIN, which
 * sidesteps every browser-side block at once — CORS, ORB, CORP, and Cloudflare's
 * refusal to serve some objects to browser-originated requests.
 *
 * This is what actually rescues the X1 Cats portrait. Chrome refuses that SVG
 * from ipfs.io/dweb.link/nftstorage.link with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin
 * — `fetch()` fails too, and it fails identically on about:blank and example.com,
 * so it is Chrome+Cloudflare, not this app. Through the proxy it loads in ~470ms.
 */
function viaSameOriginProxy(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  return `/api/nft-meta/${url.replace(/^https?:\/\//i, '')}`;
}

/**
 * Every URL worth trying for one image, best-first and de-duplicated.
 *
 * Order: the original, then each public gateway direct (fast when it works, and
 * it fails in ~100-300ms when it doesn't), then any collection rescue host, then
 * the same-origin proxy for each gateway as the always-works last resort.
 * Always includes the original so a non-IPFS URL still gets its turn.
 */
/** Gateways that stopped serving (10-05: 429 "service worker gateway only" / gone).
 *  Saved links on these hosts (the DB holds many `https://ipfs.io/ipfs/…`) are moved
 *  to a live gateway BEFORE the first try instead of failing first. */
const DEAD_GATEWAY_HOSTS = ['ipfs.io', 'dweb.link', 'nftstorage.link', 'w3s.link', 'cloudflare-ipfs.com'];
export function liveGatewayUrl(url: string): string {
  const path = ipfsPathOf(url);
  if (!path) return url;
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { /* ipfs:// etc. */ }
  return (!host || DEAD_GATEWAY_HOSTS.some(h => host === h || host.endsWith('.' + h)))
    ? IPFS_GATEWAYS[0] + path : url;
}

export function imageCandidates(url: string): string[] {
  if (!url) return [];
  // A collection's own host first: it is the known-good copy (X1 Pups thumbs) and a
  // hanging IPFS gateway in front of it left the card blank (Alpha Leak, 10-05).
  const out: string[] = [...collectionRescues(url), liveGatewayUrl(url), url];
  const path = ipfsPathOf(url);
  if (path) for (const gw of IPFS_GATEWAYS) out.push(gw + path);
  // Proxied last — an extra hop, only worth paying once the direct ones lose.
  const proxied = [url, ...(path ? IPFS_GATEWAYS.map(gw => gw + path) : [])]
    .map(viaSameOriginProxy)
    .filter((u): u is string => !!u);
  out.push(...proxied);
  return [...new Set(out)].filter(Boolean);
}
