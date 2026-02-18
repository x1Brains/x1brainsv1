import type { NextApiRequest, NextApiResponse } from 'next';

let _cache: { data: unknown; ts: number } | null = null;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (_cache && Date.now() - _cache.ts < 60_000) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(_cache.data);
    }

    const upstream = await fetch('http://xenblocks.io:5000/show_data', {
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream HTTP ${upstream.status}` });
    }

    const data = await upstream.json();
    _cache = { data, ts: Date.now() };

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[xenblocks proxy]', message);
    return res.status(502).json({ error: message });
  }
}