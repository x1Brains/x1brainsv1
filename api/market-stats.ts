// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  GET /api/market-stats — the marketplace VOLUME / SALES headline.        ║
// ║                                                                           ║
// ║  The browser used to walk the chain itself and write the result to        ║
// ║  `marketplace_stats` with the anon key, which is why that table had to    ║
// ║  stay anon-writable. Anyone with the public key could set the site-wide   ║
// ║  volume to anything. Now the scan happens here, writes with the service   ║
// ║  key, and anon write access can be revoked.                               ║
// ║                                                                           ║
// ║  Cheap by default: it only rescans when a NEW signature has appeared on   ║
// ║  the platform fee wallet since the stored one. Otherwise it returns the   ║
// ║  stored row untouched.                                                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { scanMarketStats, newestPlatformSig, makeConn } from './_marketstats.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

/** A stored row is only "complete" if its biggest sale carries the NFT mint —
 *  rows written before that field existed force one rescan to backfill it. */
function isComplete(b: any): boolean { return !b || !!b.nftMint; }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'GET only' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ ok: false, error: 'server not configured' });

  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: row } = await sb
      .from('marketplace_stats')
      .select('volume_xnt, sales_count, biggest_sale, last_sig')
      .eq('id', 'main')
      .maybeSingle();

    const conn   = makeConn();
    const newest = await newestPlatformSig(conn).catch(() => null);

    // Nothing new on the fee wallet and the stored row is complete -> no scan.
    if (row && newest && row.last_sig === newest && isComplete(row.biggest_sale)) {
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
      return res.status(200).json({
        ok: true, scanned: false,
        stats: { volumeXnt: Number(row.volume_xnt) || 0, salesCount: Number(row.sales_count) || 0,
                 biggestSale: row.biggest_sale ?? null, lastSig: row.last_sig ?? null },
      });
    }

    const stats = await scanMarketStats(conn);

    // ⛔ Never overwrite a good row with an empty scan. If the walk returned
    // nothing but we already had a number, keep the number — that is the
    // failure that once pinned this headline to 0.
    if (stats.salesCount === 0 && row && Number(row.sales_count) > 0) {
      return res.status(200).json({
        ok: true, scanned: true, kept: 'previous',
        stats: { volumeXnt: Number(row.volume_xnt) || 0, salesCount: Number(row.sales_count) || 0,
                 biggestSale: row.biggest_sale ?? null, lastSig: row.last_sig ?? null },
      });
    }

    const { error } = await sb.from('marketplace_stats').upsert({
      id: 'main', volume_xnt: stats.volumeXnt, sales_count: stats.salesCount,
      biggest_sale: stats.biggestSale, last_sig: stats.lastSig,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) console.warn('[market-stats] write failed:', error.message);

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
    return res.status(200).json({ ok: true, scanned: true, stats });
  } catch (e: any) {
    console.error('[market-stats] unhandled:', e);
    return res.status(500).json({ ok: false, error: e?.message ?? 'server error' });
  }
}
