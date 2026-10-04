// api/cron-snapshot.ts
// ─────────────────────────────────────────────────────────────────────────────
// Vercel Cron — daily portfolio snapshot of every wallet ever tracked.
//
// Schedule lives in vercel.json. Vercel calls us with `Authorization: Bearer
// $CRON_SECRET` — we refuse if CRON_SECRET isn't set on the deployment, so a
// missing env doesn't silently turn into a public-write endpoint.
//
// What this gives the UI:
//   • A daily history row per wallet even if the citizen wasn't browsing.
//   • Drives Portfolio's 24h delta + Net-Worth-History chart accurately.
//   • Idempotent — upsert on (wallet, snapshot_date), latest-write wins.
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL        = 'https://rpc.mainnet.x1.xyz';
const XDEX_PRICE_URL = 'https://api.xdex.xyz/api/token-price/prices';
const XDEX_NETWORK   = 'X1%20Mainnet';
const XNT_WRAPPED    = 'So11111111111111111111111111111111111111112';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_PROGRAM        = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDCX_MINT     = 'B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq';
const XDEX_PROGRAM   = 'sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN';
// Holdings worth more than this at the API price are checked against a real pool (see exitValueUsd).
const SANITY_CHECK_ABOVE_USD = 25;
// Cap only values that are WILDLY impossible: more than this many times all the XNT/USDC.X in
// the token's best pool. A real whale bag can exceed one pool's cash a few times over (that's
// still its market value); the copycat token was millions of times over.
const IMPOSSIBLE_FACTOR = 10;
const BATCH_SIZE     = 5;
const PRICE_TIMEOUT  = 10_000;

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || '',
);

interface SnapshotToken {
  mint:    string;
  symbol:  string;
  balance: number;
  usd:     number;
  price:   number;
}

const today = () => new Date().toISOString().slice(0, 10);

async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = PRICE_TIMEOUT): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/** `complete` = false if any read failed (after retries): the caller must not write a
 *  snapshot then, or a rate-limited RPC call would show up as a fake drop in the chart. */
async function fetchWalletTokens(
  connection: Connection,
  walletAddress: string,
): Promise<{ tokens: { mint: string; balance: number; decimals: number }[]; complete: boolean }> {
  const pubkey = new PublicKey(walletAddress);
  const results: { mint: string; balance: number; decimals: number }[] = [];
  let complete = true;
  const withRetry = async <T>(f: () => Promise<T>): Promise<T | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await f(); } catch { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
    }
    complete = false; return null;
  };

  const lamports = await withRetry(() => connection.getBalance(pubkey));
  if (lamports && lamports > 0) results.push({ mint: XNT_WRAPPED, balance: lamports / 1e9, decimals: 9 });

  for (const programId of [SPL_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      const accts = await withRetry(() => connection.getParsedTokenAccountsByOwner(
        pubkey,
        { programId: new PublicKey(programId) },
        'confirmed',
      ));
      if (!accts) continue;
      for (const { account } of accts.value) {
        const info = (account.data as any).parsed?.info;
        if (!info) continue;
        const balance = info.tokenAmount?.uiAmount ?? 0;
        if (balance <= 0) continue;
        results.push({
          mint:     info.mint,
          balance,
          decimals: info.tokenAmount?.decimals ?? 9,
        });
      }
    } catch {}
  }

  return { tokens: results, complete };
}

/** Prices for `mints`. `complete` is false if any chunk still failed after retries — the
 *  caller must then NOT write a snapshot (a missing price would read as $0 and draw a fake dip:
 *  measured 10-04, the same wallet came out $1.95k one run and $5.77k the next). */
// One price cache per run: BRAINS/LB/XNT etc. are asked for once, not once per wallet — the
// xDEX price API rate-limits bursts (HTTP 429 measured 10-04 on 2 of 14 chunks for one wallet).
const priceCache = new Map<string, number>();     // mint -> price (0 = API has no price)
async function fetchPricesChecked(allMints: string[]): Promise<{ prices: Map<string, number>; complete: boolean }> {
  const prices = new Map<string, number>();
  let complete = true;
  const mints = allMints.filter((m) => { if (priceCache.has(m)) { const p = priceCache.get(m)!; if (p > 0) prices.set(m, p); return false; } return true; });
  for (let i = 0; i < mints.length; i += 10) {
    const chunk = mints.slice(i, i + 10);
    let ok = false;
    if (i > 0) await new Promise(r => setTimeout(r, 250));   // pace chunks
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const url = `${XDEX_PRICE_URL}?network=${XDEX_NETWORK}&token_addresses=${chunk.join(',')}`;
        const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as any;   // xDEX answers either an array or { data: [...] }
        const items: any[] = Array.isArray(data) ? data :
          Array.isArray(data?.data) ? data.data : null as any;
        if (!items) throw new Error('unexpected price payload');
        for (const m of chunk) priceCache.set(m, 0);            // answered: no price unless listed
        for (const item of items) {
          const mint  = item?.token_address ?? item?.mint ?? item?.address;
          const price = Number(item?.price ?? item?.usd ?? 0);
          if (mint && price > 0) { prices.set(mint, price); priceCache.set(mint, price); }
        }
        ok = true;
      } catch { await new Promise(r => setTimeout(r, 2000 * 2 ** attempt)); }   // 2s, 4s, 8s
    }
    if (!ok) complete = false;
  }
  return { prices, complete };
}
async function fetchPrices(mints: string[]): Promise<Map<string, number>> {
  return (await fetchPricesChecked(mints)).prices;
}

// ── Price sanity: what could this holding actually be SOLD for? ────────────────
// xDEX's price API values tokens by their last trade, not by liquidity: on 10-03 it
// priced a copycat "Brains (BRAINS)" token (GDKQYzDDA3EbLnwkH4jr6CoD8CHsywExP1Niy6nZRTVW)
// at $1.35M each, so any wallet holding it showed billions in its Net Worth History.
// Rule: keep the market (API) price, UNLESS the holding would be worth more than
// IMPOSSIBLE_FACTOR × ALL the XNT/USDC.X in the token's deepest xDEX pool — a value nobody could
// ever realise. If a pool lookup FAILS (RPC error / rate limit) nothing is capped: unknown is
// never treated as zero.
// Only then is it capped at what that pool would actually pay for the whole amount
// (constant-product exit, minus the 0.28% fee); no pool at all = 0. Real tokens keep their
// market value on the chart; fake prices on thin pools collapse.
type QuotePool = { quote: 'XNT' | 'USD'; rToken: number; rQuote: number };
const poolCache = new Map<string, QuotePool | null>();
// All xDEX pools that pair a token with XNT or USDC.X, read ONCE per run (one scan of ~1.4k
// pools) — scanning per token made a 5-wallet run take 37 s instead of 2.6 s.
type PoolRef = { quote: 'XNT' | 'USD'; vTok: PublicKey; vQ: PublicKey; decTok: number; decQ: number; feesTok: bigint; feesQ: bigint };
let poolIndex: Map<string, PoolRef[]> | null | undefined;   // undefined = not loaded, null = load failed
async function loadPoolIndex(connection: Connection): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const all = await connection.getProgramAccounts(new PublicKey(XDEX_PROGRAM), { filters: [{ dataSize: 637 }] });
      const idx = new Map<string, PoolRef[]>();
      for (const p of all) {
        const d = p.account.data as Buffer;
        const m0 = new PublicKey(d.subarray(168, 200)).toBase58(), m1 = new PublicKey(d.subarray(200, 232)).toBase58();
        for (const [tok, q, tokIs0] of [[m0, m1, true], [m1, m0, false]] as const) {
          const quote = q === XNT_WRAPPED ? 'XNT' : q === USDCX_MINT ? 'USD' : null;
          if (!quote || tok === XNT_WRAPPED || tok === USDCX_MINT) continue;
          const ref: PoolRef = {
            quote,
            vTok: new PublicKey(d.subarray(tokIs0 ? 72 : 104, tokIs0 ? 104 : 136)),
            vQ:   new PublicKey(d.subarray(tokIs0 ? 104 : 72, tokIs0 ? 136 : 104)),
            decTok: d[tokIs0 ? 331 : 332], decQ: d[tokIs0 ? 332 : 331],
            feesTok: d.readBigUInt64LE(tokIs0 ? 341 : 349) + d.readBigUInt64LE(tokIs0 ? 357 : 365),
            feesQ:   d.readBigUInt64LE(tokIs0 ? 349 : 341) + d.readBigUInt64LE(tokIs0 ? 365 : 357),
          };
          (idx.get(tok) ?? idx.set(tok, []).get(tok)!).push(ref);
        }
      }
      poolIndex = idx;
      console.log(`[cron-snapshot] pool index: ${all.length} xDEX pools, ${idx.size} tokens with an XNT/USDC.X pool`);
      return;
    } catch (e: any) {
      console.warn(`[cron-snapshot] pool index attempt ${attempt + 1} failed: ${e?.message ?? e}`);
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  poolIndex = null;   // couldn't load: big holdings can't be verified → those wallets are skipped
}

/** null = definitely no XNT/USDC.X pool · undefined = couldn't check (don't cap). */
async function deepestQuotePool(connection: Connection, mint: string): Promise<QuotePool | null | undefined> {
  if (poolCache.has(mint)) return poolCache.get(mint)!;
  if (poolIndex === undefined) await loadPoolIndex(connection);
  if (!poolIndex) return undefined;
  const refs = poolIndex.get(mint) ?? [];
  if (!refs.length) { poolCache.set(mint, null); return null; }
  let infos: (any | null)[];
  try { infos = await connection.getMultipleAccountsInfo(refs.flatMap(r => [r.vTok, r.vQ])); }
  catch { return undefined; }
  let best: QuotePool | null = null, bestUsdDepth = 0;
  refs.forEach((r, i) => {
    const a = infos[2 * i], b = infos[2 * i + 1];
    if (!a || !b) return;
    const rawTok = a.data.readBigUInt64LE(64), rawQ = b.data.readBigUInt64LE(64);
    const rToken = Number(rawTok > r.feesTok ? rawTok - r.feesTok : 0n) / 10 ** r.decTok;
    const rQuote = Number(rawQ > r.feesQ ? rawQ - r.feesQ : 0n) / 10 ** r.decQ;
    const usdDepth = r.quote === 'XNT' ? rQuote * xntUsdForRun : rQuote;
    if (rToken > 0 && rQuote > 0 && usdDepth > bestUsdDepth) { best = { quote: r.quote, rToken, rQuote }; bestUsdDepth = usdDepth; }
  });
  poolCache.set(mint, best);
  return best;
}
function exitValueUsd(amount: number, pool: QuotePool, xntUsd: number): number {
  const out = (amount * pool.rQuote) / (pool.rToken + amount) * (1 - 0.0028);
  return pool.quote === 'XNT' ? out * xntUsd : out;
}
let xntUsdForRun = 0;

async function snapshotWallet(
  connection: Connection,
  wallet: string,
  todayStr: string,
): Promise<{ wallet: string; total_usd: number; tokens: number } | null> {
  try {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return null;   // not a wallet address (e.g. test rows)
    const { tokens, complete: tokensComplete } = await fetchWalletTokens(connection, wallet);
    if (!tokensComplete) {   // keep yesterday's point rather than writing a fake dip
      console.warn(`[cron-snapshot] ${wallet.slice(0, 8)}: token list incomplete after retries, skipped today`);
      return null;
    }
    if (tokens.length === 0) return null;

    // NFTs (0 decimals) have no token price; asking for them only burns the API's rate limit
    const mints  = [...new Set(tokens.filter(t => t.decimals > 0).map(t => t.mint))];
    const { prices, complete } = await fetchPricesChecked(mints);
    if (!complete) {   // keep yesterday's point rather than writing a fake dip
      console.warn(`[cron-snapshot] ${wallet.slice(0, 8)}: prices incomplete after retries, skipped today`);
      return null;
    }

    let total_usd = 0;
    const breakdown: SnapshotToken[] = [];

    for (const t of tokens) {
      let price = prices.get(t.mint) ?? 0;
      let usd   = price * t.balance;
      if (usd > SANITY_CHECK_ABOVE_USD && t.mint !== XNT_WRAPPED && t.mint !== USDCX_MINT) {
        // a big holding we can't verify must not be written (it may be a fake price): skip the wallet today
        if (xntUsdForRun <= 0) { console.warn(`[cron-snapshot] ${wallet.slice(0, 8)}: no XNT price to verify ${t.mint.slice(0, 6)}, skipped today`); return null; }
        const pool = await deepestQuotePool(connection, t.mint);
        if (pool === undefined) { console.warn(`[cron-snapshot] ${wallet.slice(0, 8)}: couldn't verify ${t.mint.slice(0, 6)} against a pool, skipped today`); return null; }
        const poolUsd = pool ? (pool.quote === 'XNT' ? pool.rQuote * xntUsdForRun : pool.rQuote) : 0;
        if (usd > poolUsd * IMPOSSIBLE_FACTOR) {   // impossible value → what the pool could really pay
          usd = pool ? exitValueUsd(t.balance, pool, xntUsdForRun) : 0;
          price = t.balance > 0 ? usd / t.balance : 0;
        }
      }
      if (usd > 0) {
        total_usd += usd;
        breakdown.push({ mint: t.mint, symbol: t.mint.slice(0, 6), balance: t.balance, usd, price });
      }
    }

    if (total_usd <= 0) return null;

    await supabase.from('portfolio_snapshots').upsert(
      { wallet, snapshot_date: todayStr, total_usd, token_breakdown: breakdown },
      { onConflict: 'wallet,snapshot_date', ignoreDuplicates: false },
    );

    return { wallet, total_usd, tokens: breakdown.length };
  } catch (e) {
    console.error(`[cron-snapshot] failed for ${wallet.slice(0, 8)}:`, e);
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Default-deny: refuse unless CRON_SECRET is set AND matches.
  const cronSecret = req.headers['authorization'];
  if (!process.env.CRON_SECRET || cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const todayStr = today();
  console.log(`[cron-snapshot] Starting for ${todayStr}`);

  const { data: walletRows, error } = await supabase
    .from('portfolio_snapshots')
    .select('wallet')
    .order('wallet');

  if (error) {
    console.error('[cron-snapshot] Failed to fetch wallets:', error);
    return res.status(500).json({ error: error.message });
  }

  const wallets = [...new Set((walletRows ?? []).map((r: any) => r.wallet as string))];
  console.log(`[cron-snapshot] ${wallets.length} wallets`);

  if (wallets.length === 0) {
    return res.status(200).json({ message: 'No wallets found', snapshots: 0 });
  }

  const connection = new Connection(RPC_URL, { commitment: 'confirmed' as const });
  // XNT's own USD price, once per run, for the pool sanity cap (0 = cap disabled, never guessed)
  priceCache.clear(); poolCache.clear(); poolIndex = undefined;
  xntUsdForRun = (await fetchPrices([XNT_WRAPPED])).get(XNT_WRAPPED) ?? 0;
  await loadPoolIndex(connection);   // once, up front
  const results: { wallet: string; total_usd: number; tokens: number }[] = [];
  const failed: string[] = [];

  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(w => snapshotWallet(connection, w, todayStr)),
    );
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === 'fulfilled' && r.value) results.push(r.value);
      else failed.push(batch[j].slice(0, 8) + '…');
    }
    if (i + BATCH_SIZE < wallets.length) await new Promise(r => setTimeout(r, 500));
  }

  const summary = {
    date:      todayStr,
    total:     wallets.length,
    succeeded: results.length,
    failed:    failed.length,
    total_usd: results.reduce((s, r) => s + r.total_usd, 0).toFixed(2),
    wallets_failed: failed,
  };
  console.log('[cron-snapshot] Done:', summary);
  return res.status(200).json(summary);
}
