// Marketplace volume scanner — walks every signature on the marketplace program,
// finds buy_nft txs by discriminator, sums sale prices.
//
// Source of truth: program log line "Sold <mint> for <N> lamports" when present,
// fallback: platform_wallet receive delta divided by 1.888% fee rate. Mirrors v1
// LabWork.loadPlatformStats so the number stays consistent with x1brains.io.

import { Connection, PublicKey } from '@solana/web3.js';
import {
  PLATFORM_WALLET,
  getMarketplaceProgramId,
} from '../components/LBComponents';
import { getMarketplaceStats, upsertMarketplaceStats } from './supabase';

const FEE_RATE = 1888 / 100_000; // 1.888% platform sale fee → price = fee / FEE_RATE
const SCAN_PAGE_LIMIT = 100;
// Pause between pages so the RPC doesn't 429. First 3 pages skip the pause
// since the citizen is staring at a loading dashboard during those.
const SCAN_DELAY_MS   = 150;
const FAST_PAGE_BUDGET = 3;

export type MarketStats = {
  volumeXnt:   number;
  salesCount:  number;
  biggestSale: { priceXnt: number; sig: string; timestamp: number; nftMint?: string } | null;
};

type Cached = MarketStats & { ts: number; lastSig?: string };

const MEM_TTL_MS    = 60_000;             // fresh — no rescan
const LS_TTL_STALE  = 60 * 60_000;        // stale — show + rescan in background
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

export async function fetchMarketStats(
  connection: Connection,
  signal: AbortSignal,
  onProgress?: (partial: MarketStats, pages: number) => void,
): Promise<MarketStats> {
  // Fresh in-memory hit — skip everything. But only if it's a COMPLETE stat
  // (biggest sale has its NFT mint); otherwise fall through and rescan.
  if (_mem && Date.now() - _mem.ts < MEM_TTL_MS && isComplete(_mem)) {
    return { volumeXnt: _mem.volumeXnt, salesCount: _mem.salesCount, biggestSale: _mem.biggestSale };
  }

  // SOURCE OF TRUTH = Supabase `marketplace_stats` (shared across all visitors,
  // instant). Adopt it as the cache so the number shows immediately on reload.
  const db = await getMarketplaceStats().catch(() => null);
  if (db) {
    _mem = { volumeXnt: db.volumeXnt, salesCount: db.salesCount, biggestSale: db.biggestSale, ts: Date.now(), lastSig: db.lastSig ?? undefined };
    setCached(_mem);
  }

  // Only re-scan the chain when a NEW platform-wallet signature has appeared
  // since the stored one (a new sale/listing/cancel). Otherwise the DB value
  // is already current — return it with no scan.
  let newest: string | undefined;
  try {
    const s = await connection.getSignaturesForAddress(PLATFORM_WALLET!, { limit: 1 });
    newest = s?.[0]?.signature;
  } catch {}

  // Skip the rescan only when the DB is both current AND complete. A row whose
  // biggest sale predates the nftMint field forces one rescan to backfill it.
  if (db && newest && db.lastSig === newest && isComplete(db)) {
    return { volumeXnt: db.volumeXnt, salesCount: db.salesCount, biggestSale: db.biggestSale };
  }

  // New activity (or no DB row yet) → full re-scan, then persist to Supabase.
  if (_inflight) return _inflight;
  _inflight = _doScan(connection, signal, onProgress).finally(() => { _inflight = null; });
  return _inflight;
}

async function _doScan(
  connection: Connection,
  signal: AbortSignal,
  onProgress?: (partial: MarketStats, pages: number) => void,
): Promise<MarketStats> {
  if (!PLATFORM_WALLET) return { volumeXnt: 0, salesCount: 0, biggestSale: null };
  const progIdStr    = getMarketplaceProgramId().toBase58();
  const platformStr  = PLATFORM_WALLET.toBase58();

  // ALWAYS full-scan the PLATFORM FEE WALLET's own history (every marketplace fee
  // lands here — far fewer sigs than the whole program, so it's still fast). We do
  // NOT use an incremental high-water mark: it previously poisoned this number —
  // one errored page-1 scan cached 0 + a high-water mark, and every later scan saw
  // "no new sigs" and returned 0 forever. A clean full recount is cheap + self-heals.
  const stopAtSig: string | undefined = undefined;
  let totalLamports = 0;
  let salesCount    = 0;
  let biggest: { priceLamports: number; sig: string; timestamp: number; nftMint?: string } | null = null;

  let newestSigSeen: string | undefined;
  let before: string | undefined = undefined;
  let pages = 0;
  let hitStop = false;

  const finish = (): MarketStats => ({
    volumeXnt:   totalLamports / 1e9,
    salesCount,
    biggestSale: biggest ? { priceXnt: biggest.priceLamports / 1e9, sig: biggest.sig, timestamp: biggest.timestamp, nftMint: biggest.nftMint } : null,
  });

  try {
    while (!signal.aborted && !hitStop) {
      const opts: any = { limit: SCAN_PAGE_LIMIT };
      if (before) opts.before = before;
      const sigs = await connection.getSignaturesForAddress(PLATFORM_WALLET, opts);
      if (!sigs || sigs.length === 0) break;
      pages++;
      // Record the very first sig of the very first page as the new "newest" —
      // we'll persist it as the high-water mark for the NEXT incremental scan.
      if (pages === 1 && sigs.length > 0) newestSigSeen = sigs[0].signature;

      // If we've reached the prior high-water mark, truncate this page at it
      // and stop further pagination — everything before it is already counted.
      if (stopAtSig) {
        const stopIdx = sigs.findIndex((s: any) => s.signature === stopAtSig);
        if (stopIdx >= 0) {
          sigs.length = stopIdx;
          hitStop = true;
        }
      }
      if (sigs.length === 0) break;

      const validSigs: any[] = sigs.filter((s: any) => !s.err);
      // ── ONE batched call instead of N individual getTransaction RPCs. ──
      // Cuts a page from ~100 round-trips down to one.
      const sigStrs = validSigs.map((s: any) => s.signature);
      // X1 RPC returns "413 Payload Too Large" for a 100-sig getParsedTransactions
      // request (≤50 works). Chunk into 25s; null-pad failed chunks so parsed[i]
      // stays aligned with validSigs[i] below.
      const PARSE_CHUNK = 25;
      const chunks: string[][] = [];
      for (let ci = 0; ci < sigStrs.length; ci += PARSE_CHUNK) chunks.push(sigStrs.slice(ci, ci + PARSE_CHUNK));
      // Fetch the page's chunks in parallel (≤4 concurrent per 100-sig page —
      // safe vs 429, and fast enough that the scan finishes before any unmount
      // abort can truncate it). Null-pad failed chunks to keep index alignment.
      const partResults = await Promise.all(chunks.map(slice =>
        connection.getParsedTransactions(slice, {
          maxSupportedTransactionVersion: 0, commitment: 'confirmed',
        }).catch(() => null),
      ));
      const parsed: any[] = [];
      partResults.forEach((part, ci) => {
        if (part) parsed.push(...part);
        else parsed.push(...chunks[ci].map(() => null));
      });

      for (let i = 0; i < parsed.length; i++) {
        if (signal.aborted) break;
        const tx  = parsed[i];
        if (!tx || tx.meta?.err) continue;
        const sig = sigStrs[i];
        const ts  = tx.blockTime ?? 0;
        const msg = (tx as any).transaction?.message;
        // getParsedTransactions wraps each key as { pubkey: PublicKey }. The old
        // code called .toBase58() on the WRAPPER (undefined) → fell back to
        // "[object Object]" for every key → platform wallet never found → always 0.
        const accountKeys: string[] = ((msg as any)?.accountKeys ?? (msg as any)?.staticAccountKeys ?? [])
          .map((k: any) => {
            const pk = k?.pubkey ?? k;
            return typeof pk === 'string' ? pk : (pk?.toBase58?.() ?? String(pk));
          });
        const platformIdx = accountKeys.indexOf(platformStr);
        if (platformIdx < 0) continue;
        // Only count txs that actually touch the marketplace program — so a stray
        // transfer into the fee wallet doesn't inflate the number.
        if (!accountKeys.includes(progIdStr)) continue;

        const pre   = (tx.meta?.preBalances  ?? [])[platformIdx] ?? 0;
        const post  = (tx.meta?.postBalances ?? [])[platformIdx] ?? 0;
        const delta = post - pre;
        if (delta <= 0) continue;

        // GROSS sale volume (like x1brainsv1x): count only actual SALES, and add
        // the full sale PRICE — not the 1.888% fee. A 1000-XNT sale adds 1000.
        // The program logs the instruction name; a sale runs `BuyNft`. Cancels /
        // listings also pay the platform a fee but are NOT trades — skip them.
        const logs: string[] = tx.meta?.logMessages ?? [];
        let isSale = false;
        let salePrice = 0;
        for (const line of logs) {
          if (/Instruction:\s*BuyNft/i.test(line)) isSale = true;
          const m = line.match(/Sold\s+\S+\s+for\s+(\d+)\s+lamports/i);
          if (m) { salePrice = Number(m[1]); isSale = true; }
        }
        if (!isSale) continue;
        // Price from the log if present, else gross-up the platform fee
        // (fee = 1.888% of price → price = fee / 0.01888).
        if (!salePrice) salePrice = Math.round(delta / FEE_RATE);

        totalLamports += salePrice;
        salesCount++;
        if (!biggest || salePrice > biggest.priceLamports) {
          // NFT mint = the token the buyer now holds (decimals 0, amount 1).
          let nftMint: string | undefined;
          for (const b of (tx.meta?.postTokenBalances ?? [])) {
            if (b?.uiTokenAmount?.decimals === 0 && b?.uiTokenAmount?.amount === '1') { nftMint = b.mint; break; }
          }
          biggest = { priceLamports: salePrice, sig, timestamp: ts, nftMint };
        }
      }

      if (onProgress) onProgress(finish(), pages);

      before = sigs[sigs.length - 1].signature;
      if (sigs.length < SCAN_PAGE_LIMIT) break;
      // Don't delay during the first few pages — citizen is waiting.
      if (pages >= FAST_PAGE_BUDGET) await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
    }
  } catch (e) {
    console.warn('[marketStats] scan error:', e);
  }

  const final = finish();
  // Only cache a COMPLETE scan. An aborted scan (component unmounted mid-walk)
  // returns a partial total — caching it would show e.g. only the most-recent
  // sale (0.111) instead of the full all-time volume (84). Next fetch re-scans.
  if (!signal.aborted) {
    setCached({ ...final, ts: Date.now(), lastSig: newestSigSeen });
    // Persist to Supabase so every other visitor loads it instantly without
    // re-scanning until the next new platform-wallet signature.
    upsertMarketplaceStats({
      volumeXnt: final.volumeXnt, salesCount: final.salesCount,
      biggestSale: final.biggestSale, lastSig: newestSigSeen ?? null,
    }).catch(() => {});
  }
  return final;
}
