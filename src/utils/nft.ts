// src/utils/nft.ts
// ─────────────────────────────────────────────────────────────────
// Shared NFT utility functions — single source of truth.
// Previously duplicated in LabWork.tsx and NFTComponents.tsx.
// Import from here in both files instead of defining locally.
// ─────────────────────────────────────────────────────────────────

/**
 * Resolve IPFS / Arweave protocol URIs to HTTP gateway URLs.
 * Uses nftstorage.link as the default IPFS gateway (fast, no rate limit).
 */
export function resolveGateway(u: string): string {
  return u
    .replace('ipfs://', 'https://nftstorage.link/ipfs/')
    .replace('ar://', 'https://arweave.net/');
}

/**
 * Route an HTTP URL through the /api/nft-meta/ Vercel proxy to avoid CORS.
 * Non-HTTP URLs are returned unchanged.
 */
export function toProxyUrl(url: string): string {
  return url.startsWith('http')
    ? `/api/nft-meta/${url.replace(/^https?:\/\//, '')}`
    : url;
}

/**
 * Generate candidate direct image URLs for a metadata URL that has no
 * extension — tries common image extensions and common path substitutions
 * (metadata→images, meta→image, json→image, etc.).
 */
export function candidateImageUrls(url: string): string[] {
  const out: string[] = [];
  for (const ext of ['png', 'jpg', 'webp', 'gif']) out.push(`${url}.${ext}`);
  for (const [from, to] of [
    ['metadata', 'images'], ['metadata', 'image'],
    ['meta',     'images'], ['meta',     'image'],
    ['json',     'images'], ['json',     'image'],
  ] as [string, string][]) {
    if (url.includes(`/${from}/`)) {
      const sw = url.replace(`/${from}/`, `/${to}/`);
      out.push(sw);
      for (const ext of ['png', 'jpg', 'webp']) out.push(`${sw}.${ext}`);
    }
  }
  return out;
}

/**
 * Attempt to load an image URL — resolves with the URL on success,
 * rejects after 8 seconds or on error.
 */
export function tryLoadImg(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(url);
    img.onerror = () => reject();
    img.src = url;
    setTimeout(() => reject(), 3000);
  });
}

/**
 * Map a rarity string to a display colour.
 */
export function rarityColor(r: string): string {
  const l = r.toLowerCase();
  if (l.includes('legendary')) return '#ffd700';
  if (l.includes('epic'))      return '#bf5af2';
  if (l.includes('rare'))      return '#00d4ff';
  if (l.includes('uncommon'))  return '#00c98d';
  return '#8aa0b8';
}