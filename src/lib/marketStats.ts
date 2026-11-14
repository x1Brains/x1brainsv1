// Marketplace volume scanner — walks every signature on the marketplace program,
// finds buy_nft txs by discriminator, sums sale prices.
//
// Source of truth: program log line "Sold <mint> for <N> lamports" when present,
// fallback: platform_wallet receive delta divided by 1.888% fee rate. Mirrors v1
// LabWork.loadPlatformStats so the number stays consistent with x1brains.io.

import type { Connection } from '@solana/web3.js';
import { getMarketplaceStats } from './supabase';


export type MarketStats = {
  volumeXnt:   number;
  salesCount:  number;
  biggestSale: { priceXnt: number; sig: string; timestamp: number; nftMint?: string } | null;
};

type Cached = MarketStats & { ts: number; lastSig?: string };

const MEM_TTL_MS    = 60_000;             // fresh — no rescan
const LS_TTL_HARD   = 24 * 60 * 60_000;   // hard cutoff
// v2 key bump: scan source changed (marketplace program → platform fee wallet,
// summing all fees). Old v1 caches hold the broken/zero value — discard them.
const LS_KEY = 'v2_market_stats_v5';

// A stored stat is "complete" only if its biggest sale carries the NFT mint
// (added later than the first scans). A row missing it forces a self-healing
// rescan so the Biggest-Buy thumbnail can resolve.
function isComplete(s: { biggestSale: MarketStats['biggestSale'] } | null | undefined): boolean {
  if (!s) return false;
  return !s.biggestSale || !!s.biggestSale.nftMint;
}

let _mem: Cached | null = null;

// Seed memory from localStorage at module init — anything within the hard
// cutoff is acceptable for an instant first paint. The stale window decides
// whether a background rescan is also needed; that's checked at fetch time.
(function seed() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return;
    const parsed = JSON.parse(raw) as Cached;
    if (parsed?.ts && Date.now() - parsed.ts < LS_TTL_HARD) _mem = parsed;
  } catch {}
})();

export function getCachedMarketStats(): MarketStats | null {
  if (!_mem) return null;
  return { volumeXnt: _mem.volumeXnt, salesCount: _mem.salesCount, biggestSale: _mem.biggestSale };
}

function setCached(stats: Cached) {
  _mem = stats;
  try { localStorage.setItem(LS_KEY, JSON.stringify(stats)); } catch {}
}

let _inflight: Promise<MarketStats> | null = null;

/**
 * Marketplace headline numbers.
 *
 * ⛔ This used to walk the chain in the browser and write the result to
 * `marketplace_stats` with the anon key — which is exactly why that table had
 * to stay anon-writable, so anyone with the public key could set the site-wide
 * VOLUME / SALES to anything. The scan moved to GET /api/market-stats on
 * 2026-11-14; it writes with the service key and only rescans when a new
 * signature appears on the platform fee wallet. Verified to reproduce the
 * known-good numbers exactly (103.999 XNT / 14 sales / biggest 25 XNT) in 5.5s.
 *
 * `onProgress` is kept for call-site compatibility but no longer fires
 * mid-scan: the server returns a complete answer in one response.
 */
export async function fetchMarketStats(
  _connection: Connection,
  signal: AbortSignal,
  onProgress?: (partial: MarketStats, pages: number) => void,
): Promise<MarketStats> {
  if (_mem && Date.now() - _mem.ts < MEM_TTL_MS && isComplete(_mem)) {
    return { volumeXnt: _mem.volumeXnt, salesCount: _mem.salesCount, biggestSale: _mem.biggestSale };
  }
  if (_inflight) return _inflight;

  _inflight = (async (): Promise<MarketStats> => {
    try {
      const res  = await fetch('/api/market-stats', { signal });
      const json = await res.json() as any;
      if (res.ok && json?.ok && json.stats) {
        const s: MarketStats = {
          volumeXnt:   Number(json.stats.volumeXnt) || 0,
          salesCount:  Number(json.stats.salesCount) || 0,
          biggestSale: json.stats.biggestSale ?? null,
        };
        setCached({ ...s, ts: Date.now(), lastSig: json.stats.lastSig ?? undefined });
        onProgress?.(s, 1);
        return s;
      }
      throw new Error(json?.error ?? `HTTP ${res.status}`);
    } catch (e) {
      // Endpoint down: fall back to whatever is stored, so the headline shows
      // the last known number instead of zero.
      if ((e as any)?.name !== 'AbortError') console.warn('[marketStats] falling back to stored row:', e);
      const db = await getMarketplaceStats().catch(() => null);
      if (db) {
        const s: MarketStats = { volumeXnt: db.volumeXnt, salesCount: db.salesCount, biggestSale: db.biggestSale };
        setCached({ ...s, ts: Date.now(), lastSig: db.lastSig ?? undefined });
        return s;
      }
      return getCachedMarketStats() ?? { volumeXnt: 0, salesCount: 0, biggestSale: null };
    } finally { _inflight = null; }
  })();
  return _inflight;
}
