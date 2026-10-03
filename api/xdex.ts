// XDEX proxy with a kept copy (10-02, owner: "x1brains.io running slow showing some of its data").
// /api/xdex-price/* used to be a plain rewrite to api.xdex.xyz. XDEX answers with s-maxage=10, so after 10 s every visitor
// waited on XDEX itself — 21 s for the pool list that day (40 s+ direct), past the page's 10 s timeout: the price ticker
// showed dashes and the XNT chart (which needs that list) sat on "loading chart". Here the edge keeps the last good answer
// and serves it instantly while it refreshes behind (stale-while-revalidate); XDEX gets up to 55 s instead of 10.
import type { VercelRequest, VercelResponse } from '@vercel/node';

const UPSTREAM = 'https://api.xdex.xyz/';
let lastGood = new Map<string, { at: number; status: number; type: string; body: string }>(); // per warm instance

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const path = String(req.query.path || '').replace(/^\/+/, '');
  // the two XDEX API families the site calls (pool lists / charts / wallet tokens, and token prices) — not an open proxy
  if (!/^api\/(xendex|token-price)\/[a-z0-9/_.-]+$/i.test(path)) return res.status(404).json({ error: 'unknown path' });
  // a wallet's own balances must never be served from a shared or stale copy (a trade would not show)
  const personal = /^api\/xendex\/wallet\//i.test(path);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (k !== 'path' && typeof v === 'string') qs.set(k, v);
  const url = UPSTREAM + path + (qs.toString() ? '?' + qs : '');
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(55_000), headers: { accept: 'application/json' } });
    const body = await r.text();
    if (r.status >= 500) throw new Error('xdex ' + r.status);
    const type = r.headers.get('content-type') || 'application/json';
    if (r.ok && !personal) { lastGood.set(url, { at: Date.now(), status: r.status, type, body }); if (lastGood.size > 200) lastGood = new Map([...lastGood].slice(-100)); }
    res.setHeader('content-type', type);
    // fresh for 30 s at the edge, then served stale (instantly) for up to an hour while one request refreshes it
    res.setHeader('cache-control', r.ok && !personal ? 'public, max-age=0, s-maxage=30, stale-while-revalidate=3600' : 'no-store');
    return res.status(r.status).send(body);
  } catch (e) {
    const g = lastGood.get(url);
    if (g) { res.setHeader('content-type', g.type); res.setHeader('cache-control', 'public, max-age=0, s-maxage=10, stale-while-revalidate=3600'); res.setHeader('x-xdex-stale', String(Math.round((Date.now() - g.at) / 1000))); return res.status(g.status).send(g.body); }
    res.setHeader('cache-control', 'no-store');
    return res.status(502).json({ error: 'xdex unavailable', detail: String((e as Error).message || e).slice(0, 120) });
  }
}
