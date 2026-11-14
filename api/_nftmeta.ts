// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  POST /api/nft-meta — resolve NFT metadata on the SERVER and cache it.   ║
// ║                                                                           ║
// ║  WHY (measured 2026-11-14): the browser resolved every NFT itself by      ║
// ║  racing four candidates in fetchJsonMulti. All four are now dead:         ║
// ║    corsproxy.io          -> 403 (free use blocked)                        ║
// ║    api.allorigins.win    -> 522 after 19.6s (eats the whole 12s budget)   ║
// ║    /api/nft-meta/<path>  -> 400 (the old rewrite broke on any path)       ║
// ║    direct                -> CORS-blocked in a browser                     ║
// ║  plus gateway.pinata.cloud 403 and ipfs.io 429. So the race returned null,║
// ║  the component fell through to guessed URLs, and the card showed no image.║
// ║  The shared cache held 170 rows for the whole site, so nearly every NFT   ║
// ║  re-ran that doomed race for every visitor.                               ║
// ║                                                                           ║
// ║  The server has no CORS problem and talks to the real hosts directly      ║
// ║  (api.x1app.fyi 0.63s, x1pups 0.31s). It resolves once, writes the row    ║
// ║  with the service key, and every later viewer gets it from one indexed    ║
// ║  query. That also makes nft_metadata unwritable by the browser, which     ║
// ║  closes the image-poisoning hole: a row can only say what the chain and   ║
// ║  the token's own metadata URI say.                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey } from '@solana/web3.js';

const RPC          = process.env.X1_RPC || 'https://rpc.mainnet.x1.xyz';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export const MAX_MINTS      = 60;    // one screen of cards
const URI_TIMEOUT_MS = 6000;
const URI_CONCURRENCY = 8;

// Gateways measured 2026-11-14 against a real X1 Pups CID:
//   solarisprime.xyz      200 in 0.55s   <- the only fast one
//   gateway.pinata.cloud  200 in 5.2s    <- works, slow, keep as fallback
//   ipfs.io / dweb.link / nftstorage.link  429
//   cloudflare-ipfs.com   refused        4everland.io  301 after 15s
export const GATEWAYS = ['https://solarisprime.xyz/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
const DEAD_GATEWAY_HOSTS = ['ipfs.io', 'dweb.link', 'nftstorage.link', 'w3s.link',
                            'cloudflare-ipfs.com', '4everland.io'];

/** Pull the CID out of any ipfs:// or https://<host>/ipfs/<cid> URL. */
export function ipfsCid(u: string): string | null {
  if (!u) return null;
  if (u.startsWith('ipfs://')) return u.slice(7).replace(/^ipfs\//, '') || null;
  const m = u.match(/^https?:\/\/([^/]+)\/ipfs\/(.+)$/i);
  return m ? m[2] : null;
}

/**
 * ipfs:// and ar:// -> a gateway that answers, AND rewrite gateways that are
 * measurably dead. ⛔ The second part is the one that matters: X1 Pups carry
 * `https://ipfs.io/ipfs/<cid>` in their on-chain URI, and the JSON behind it
 * carries an ipfs.io `image` too. ipfs.io 429s, so without this rewrite BOTH
 * the metadata fetch and the image fail and the card renders empty — exactly
 * what was happening on the live site.
 */
export function resolveUri(u: string): string {
  if (!u) return u;
  if (u.startsWith('ar://')) return `https://arweave.net/${u.slice(5)}`;
  const cid = ipfsCid(u);
  if (!cid) return u;
  if (u.startsWith('ipfs://')) return GATEWAYS[0] + cid;
  const host = (u.match(/^https?:\/\/([^/]+)/i) ?? [])[1] ?? '';
  return DEAD_GATEWAY_HOSTS.includes(host.toLowerCase()) ? GATEWAYS[0] + cid : u;
}


/** The 12 shapes this ecosystem's metadata JSON actually uses. */
export function extractImage(j: any): string | null {
  if (!j || typeof j !== 'object') return null;
  const c = [j.image, j.image_url, j.imageUrl, j.img, j.uri, j.animation_url,
             j.properties?.image, j.properties?.files?.[0]?.uri, j.properties?.files?.[0]?.src,
             j.media?.[0]?.uri, j.content?.links?.image, j.offchain?.image];
  for (const v of c) if (typeof v === 'string' && v.trim()) return resolveUri(v.trim());
  return null;
}

export function parseMetadataAccount(data: Buffer): { name: string; symbol: string; uri: string } | null {
  try {
    let o = 1 + 32 + 32;                       // key + update_authority + mint
    const str = () => {
      const len = data.readUInt32LE(o); o += 4;
      const s = data.subarray(o, o + len).toString('utf8').replace(/\0+$/, '').trim();
      o += len; return s;
    };
    const name = str(), symbol = str(), uri = str();
    return { name, symbol, uri };
  } catch { return null; }
}

/** Try each gateway in turn for an IPFS URL; one shot for anything else. */
export async function fetchJsonWithFallback(url: string): Promise<any | null> {
  const first = await fetchJson(url);
  if (first) return first;
  const cid = ipfsCid(url);
  if (!cid) return null;
  for (const g of GATEWAYS.slice(1)) {
    const r = await fetchJson(g + cid);
    if (r) return r;
  }
  return null;
}

export async function fetchJson(url: string): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), URI_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json,*/*' } });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') ?? '';
    // Some collections serve the image straight off the metadata URI.
    if (ct.startsWith('image/')) return { image: url };
    return JSON.parse(await r.text());
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}


/** Resolve mints straight from chain + their own metadata URIs. No DB. */
export async function resolveFromChain(mints: string[]): Promise<Array<{
  mint: string; name: string | null; symbol: string | null; image: string;
  description: string | null; external_url: string | null; collection: string | null; attributes: any;
}>> {
  const conn = new Connection(RPC, 'confirmed');
  const pdas = mints.map(m => {
    try {
      return PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(m).toBuffer()],
        METADATA_PROGRAM,
      )[0];
    } catch { return null; }
  });
  const onChain: Record<string, { name: string; symbol: string; uri: string }> = {};
  for (let i = 0; i < pdas.length; i += 100) {
    const slice = pdas.slice(i, i + 100);
    const valid = slice.filter(Boolean) as PublicKey[];
    if (!valid.length) continue;
    const infos = await conn.getMultipleAccountsInfo(valid);
    let k = 0;
    for (let j = 0; j < slice.length; j++) {
      if (!slice[j]) continue;
      const info = infos[k++];
      if (!info?.data) continue;
      const parsed = parseMetadataAccount(Buffer.from(info.data));
      if (parsed?.uri) onChain[mints[i + j]] = parsed;
    }
  }
  const fetched = await mapLimit(Object.entries(onChain), URI_CONCURRENCY, async ([mint, m]) => {
    const json = await fetchJsonWithFallback(resolveUri(m.uri));
    return { mint, m, json, image: extractImage(json) };
  });
  const rows = [];
  for (const f of fetched) {
    if (!f.image) continue;
    rows.push({
      mint: f.mint,
      name: f.json?.name ?? f.m.name ?? null,
      symbol: f.json?.symbol ?? f.m.symbol ?? null,
      image: f.image,
      description: f.json?.description ?? null,
      external_url: f.json?.external_url ?? null,
      collection: typeof f.json?.collection === 'string' ? f.json.collection : (f.json?.collection?.name ?? null),
      attributes: Array.isArray(f.json?.attributes) ? f.json.attributes : null,
    });
  }
  return rows;
}
