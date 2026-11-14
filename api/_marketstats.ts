// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  _marketstats.ts — marketplace volume scan, moved off the browser.       ║
// ║                                                                           ║
// ║  WHY: src/lib/marketStats.ts walked the chain in the browser and wrote    ║
// ║  the result to `marketplace_stats` with the anon key, so that table had   ║
// ║  to stay anon-writable — and it holds the site-wide VOLUME / SALES        ║
// ║  headline. Anyone with the public key could set it to anything. Revoking  ║
// ║  the write without moving the scan would have frozen the number forever.  ║
// ║                                                                           ║
// ║  Same algorithm, same source of truth, now server-side with the service   ║
// ║  key. Measured 2026-11-14: the platform fee wallet has ~520 signatures,   ║
// ║  so a full recount is 6 pages — a few seconds, well inside the limit.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import { Connection, PublicKey } from '@solana/web3.js';

export const RPC             = process.env.X1_RPC || 'https://rpc.mainnet.x1.xyz';
export const PLATFORM_WALLET = new PublicKey('CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF');
export const MARKETPLACE     = 'CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4';

const FEE_RATE        = 1888 / 100_000;  // 1.888% platform fee -> price = fee / FEE_RATE
const SCAN_PAGE_LIMIT = 100;
const PARSE_CHUNK     = 25;              // X1 RPC 413s above ~50 sigs per getParsedTransactions
const MAX_PAGES       = 40;              // hard stop so a runaway history can't hang the function

export type BiggestSale = { priceXnt: number; sig: string; timestamp: number; nftMint?: string } | null;
export type MarketStats = { volumeXnt: number; salesCount: number; biggestSale: BiggestSale; lastSig: string | null };

/** Newest signature on the fee wallet — the cheap "has anything happened?" check. */
export async function newestPlatformSig(conn: Connection): Promise<string | null> {
  const s = await conn.getSignaturesForAddress(PLATFORM_WALLET, { limit: 1 });
  return s?.[0]?.signature ?? null;
}

/**
 * Full recount of gross sale volume off the platform fee wallet's history.
 *
 * ⛔ Deliberately NOT incremental, exactly as the client version documented:
 * an incremental high-water mark poisoned this number once before — one errored
 * first page cached 0 along with the mark, and every later scan saw "no new
 * sigs" and returned 0 forever. A clean full recount is cheap and self-heals.
 */
export async function scanMarketStats(conn: Connection): Promise<MarketStats> {
  let totalLamports = 0, salesCount = 0, pages = 0;
  let biggest: { priceLamports: number; sig: string; timestamp: number; nftMint?: string } | null = null;
  let newestSigSeen: string | null = null;
  let before: string | undefined;

  while (pages < MAX_PAGES) {
    const opts: any = { limit: SCAN_PAGE_LIMIT };
    if (before) opts.before = before;
    const sigs = await conn.getSignaturesForAddress(PLATFORM_WALLET, opts);
    if (!sigs?.length) break;
    pages++;
    if (pages === 1) newestSigSeen = sigs[0].signature;

    const valid   = sigs.filter(s => !s.err);
    const sigStrs = valid.map(s => s.signature);
    const chunks: string[][] = [];
    for (let i = 0; i < sigStrs.length; i += PARSE_CHUNK) chunks.push(sigStrs.slice(i, i + PARSE_CHUNK));
    const parts = await Promise.all(chunks.map(c =>
      conn.getParsedTransactions(c, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        .catch(() => null)));
    const parsed: any[] = [];
    parts.forEach((p, i) => p ? parsed.push(...p) : parsed.push(...chunks[i].map(() => null)));

    for (let i = 0; i < parsed.length; i++) {
      const tx = parsed[i];
      if (!tx || tx.meta?.err) continue;
      const msg = tx.transaction?.message as any;
      const keys: string[] = (msg?.accountKeys ?? msg?.staticAccountKeys ?? []).map((k: any) => {
        const pk = k?.pubkey ?? k;
        return typeof pk === 'string' ? pk : (pk?.toBase58?.() ?? String(pk));
      });
      const idx = keys.indexOf(PLATFORM_WALLET.toBase58());
      if (idx < 0) continue;
      // Only count txs that touch the marketplace program, so a stray transfer
      // into the fee wallet cannot inflate the number.
      if (!keys.includes(MARKETPLACE)) continue;

      const delta = ((tx.meta?.postBalances ?? [])[idx] ?? 0) - ((tx.meta?.preBalances ?? [])[idx] ?? 0);
      if (delta <= 0) continue;

      // Gross sale volume: only actual SALES, counting the full PRICE, not the
      // fee. Cancels and listings also pay the platform but are not trades.
      let isSale = false, salePrice = 0;
      for (const line of (tx.meta?.logMessages ?? [])) {
        if (/Instruction:\s*BuyNft/i.test(line)) isSale = true;
        const m = line.match(/Sold\s+\S+\s+for\s+(\d+)\s+lamports/i);
        if (m) { salePrice = Number(m[1]); isSale = true; }
      }
      if (!isSale) continue;
      if (!salePrice) salePrice = Math.round(delta / FEE_RATE);

      totalLamports += salePrice;
      salesCount++;
      if (!biggest || salePrice > biggest.priceLamports) {
        let nftMint: string | undefined;
        for (const b of (tx.meta?.postTokenBalances ?? [])) {
          if (b?.uiTokenAmount?.decimals === 0 && b?.uiTokenAmount?.amount === '1') { nftMint = b.mint; break; }
        }
        biggest = { priceLamports: salePrice, sig: sigStrs[i], timestamp: tx.blockTime ?? 0, nftMint };
      }
    }

    before = sigs[sigs.length - 1].signature;
    if (sigs.length < SCAN_PAGE_LIMIT) break;
  }

  return {
    volumeXnt:   totalLamports / 1e9,
    salesCount,
    biggestSale: biggest
      ? { priceXnt: biggest.priceLamports / 1e9, sig: biggest.sig, timestamp: biggest.timestamp, nftMint: biggest.nftMint }
      : null,
    lastSig: newestSigSeen,
  };
}

export function makeConn(): Connection { return new Connection(RPC, 'confirmed'); }
