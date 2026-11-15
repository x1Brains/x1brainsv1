import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { resolveFromChain, repairImage, MAX_MINTS } from './_nftmeta.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ ok: false, error: 'server not configured' });

  try {
    const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
    const asked: string[] = Array.isArray(body.mints) ? body.mints : [];
    const mints = Array.from(new Set(asked.filter(m => typeof m === 'string' && m.length >= 32 && m.length <= 44))).slice(0, MAX_MINTS);
    if (mints.length === 0) return res.status(400).json({ ok: false, error: 'mints[] required' });

    const sb  = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const out: Record<string, any> = {};

    // 1. Serve whatever is already cached — one indexed query, no network.
    //
    // ⛔ A cached row is trusted only if its image is one a BROWSER can paint.
    // `if (r.image)` was not that test: a row holding `ipfs://<cid>`, a dead
    // gateway or a `/api/nft-meta/...` leftover counted as resolved, so it was
    // served to every visitor forever and never re-resolved. 32 of 171 live rows
    // were in that state (22 bare ipfs://, 5 permagate.io, 3 ipfs.io, 2 proxy),
    // which is exactly the "sometimes the art shows, sometimes it doesn't" —
    // whether a card painted came down to which host its row happened to hold.
    //
    // Most of them are repairable by rewriting the host alone, so try that first
    // and write the repair back; only a row beyond saving falls through to the
    // chain. Either way the row self-heals on the first view, no manual SQL.
    const repairs: any[] = [];
    const { data: cached } = await sb
      .from('nft_metadata')
      .select('mint,name,symbol,image,description,external_url,collection,attributes')
      .in('mint', mints);
    for (const r of (cached ?? []) as any[]) {
      const image = repairImage(r.image);
      if (!image) continue;                       // unservable -> counts as missing
      if (image !== r.image) repairs.push({ mint: r.mint, image, updated_at: new Date().toISOString() });
      out[r.mint] = { mint: r.mint, name: r.name, symbol: r.symbol, image,
        description: r.description, externalUrl: r.external_url, collection: r.collection, attributes: r.attributes };
    }
    if (repairs.length) {
      const { error } = await sb.from('nft_metadata').upsert(repairs, { onConflict: 'mint' });
      if (error) console.warn('[nft-meta] repair write failed:', error.message);
      else console.log(`[nft-meta] repaired ${repairs.length} dead image URL(s)`);
    }

    const missing = mints.filter(m => !out[m]);
    if (missing.length === 0) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
      return res.status(200).json({ ok: true, meta: out, resolved: 0, cached: mints.length, repaired: repairs.length });
    }

    // 2+3. Chain -> metadata URI -> image, server-side (no CORS, no proxies).
    const resolved = await resolveFromChain(missing);
    const rows = resolved.map(r => ({ ...r, updated_at: new Date().toISOString() }));
    for (const r of resolved) {
      out[r.mint] = { mint: r.mint, name: r.name, symbol: r.symbol, image: r.image,
        description: r.description, externalUrl: r.external_url, collection: r.collection, attributes: r.attributes };
    }

    if (rows.length) {
      const { error } = await sb.from('nft_metadata').upsert(rows, { onConflict: 'mint' });
      if (error) console.warn('[nft-meta] cache write failed:', error.message);
    }

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    return res.status(200).json({ ok: true, meta: out, resolved: rows.length, cached: mints.length - missing.length, repaired: repairs.length });
  } catch (e: any) {
    console.error('[nft-meta] unhandled:', e);
    return res.status(500).json({ ok: false, error: e?.message ?? 'server error' });
  }
}
