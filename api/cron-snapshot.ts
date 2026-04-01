// api/cron-snapshot.ts
// ─────────────────────────────────────────────────────────────────────────────
// Vercel Cron Job — runs daily at midnight UTC
// Takes portfolio snapshots for every wallet that has ever used the tracker
// even if they haven't visited that day.
//
// Schedule: set in vercel.json → "crons": [{"path":"/api/cron-snapshot","schedule":"0 0 * * *"}]
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey } from '@solana/web3.js';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const RPC_URL        = 'https://rpc.mainnet.x1.xyz';
const XDEX_PRICE_URL = 'https://api.xdex.xyz/api/token-price/prices';
const XDEX_NETWORK   = 'X1%20Mainnet';
const XNT_WRAPPED    = 'So11111111111111111111111111111111111111112';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SPL_PROGRAM        = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BATCH_SIZE     = 5;   // wallets processed in parallel
const PRICE_TIMEOUT  = 10_000;
const RPC_TIMEOUT    = 15_000;

// ─── SUPABASE (server-side — uses service key for full access) ───────────────
const supabase = createClient(
  process.env.VITE_SUPABASE_URL        || process.env.SUPABASE_URL        || '',
  process.env.VITE_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
);

// ─── TYPES ───────────────────────────────────────────────────────────────────
interface SnapshotToken {
  mint:    string;
  symbol:  string;
  balance: number;
  usd:     number;
  price:   number;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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

// ─── FETCH TOKEN BALANCES FOR A WALLET ───────────────────────────────────────
async function fetchWalletTokens(
  connection: Connection,
  walletAddress: string,
): Promise<{ mint: string; balance: number; decimals: number }[]> {
  const pubkey = new PublicKey(walletAddress);
  const results: { mint: string; balance: number; decimals: number }[] = [];

  // Fetch native XNT balance
  try {
    const lamports = await connection.getBalance(pubkey);
    if (lamports > 0) {
      results.push({ mint: XNT_WRAPPED, balance: lamports / 1e9, decimals: 9 });
    }
  } catch {}

  // Fetch SPL + Token-2022 balances
  for (const programId of [SPL_PROGRAM, TOKEN_2022_PROGRAM]) {
    try {
      const accts = await connection.getParsedTokenAccountsByOwner(
        pubkey,
        { programId: new PublicKey(programId) },
        { commitment: 'confirmed' as const },
      );
      for (const { account } of accts.value) {
        const info = account.data.parsed?.info;
        if (!info) continue;
        const balance = info.tokenAmount?.uiAmount ?? 0;
        if (balance <= 0) continue; // skip empty accounts
        results.push({
          mint:     info.mint,
          balance,
          decimals: info.tokenAmount?.decimals ?? 9,
        });
      }
    } catch {}
  }

  return results;
}

// ─── FETCH PRICES FOR A BATCH OF MINTS ───────────────────────────────────────
async function fetchPrices(mints: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (mints.length === 0) return prices;

  // Batch into groups of 10
  for (let i = 0; i < mints.length; i += 10) {
    const chunk = mints.slice(i, i + 10);
    try {
      const url = `${XDEX_PRICE_URL}?network=${XDEX_NETWORK}&token_addresses=${chunk.join(',')}`;
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();

      // Parse price response — xDex returns array or object
      const items: any[] = Array.isArray(data) ? data :
        Array.isArray(data?.data) ? data.data : [];

      for (const item of items) {
        const mint  = item?.token_address ?? item?.mint ?? item?.address;
        const price = Number(item?.price ?? item?.usd ?? 0);
        if (mint && price > 0) prices.set(mint, price);
      }
    } catch {}
  }

  return prices;
}

// ─── SNAPSHOT ONE WALLET ─────────────────────────────────────────────────────
async function snapshotWallet(
  connection: Connection,
  wallet: string,
  todayStr: string,
): Promise<{ wallet: string; total_usd: number; tokens: number } | null> {
  try {
    const tokens = await fetchWalletTokens(connection, wallet);
    if (tokens.length === 0) return null;

    const mints  = [...new Set(tokens.map(t => t.mint))];
    const prices = await fetchPrices(mints);

    let total_usd = 0;
    const breakdown: SnapshotToken[] = [];

    for (const t of tokens) {
      const price = prices.get(t.mint) ?? 0;
      const usd   = price * t.balance;
      if (usd > 0) {
        total_usd += usd;
        breakdown.push({ mint: t.mint, symbol: t.mint.slice(0, 6), balance: t.balance, usd, price });
      }
    }

    if (total_usd <= 0) return null;

    // Upsert — overwrites if already exists today (so manual visits earlier that day are fine)
    await supabase.from('portfolio_snapshots').upsert(
      { wallet, snapshot_date: todayStr, total_usd, token_breakdown: breakdown },
      { onConflict: 'wallet,snapshot_date', ignoreDuplicates: false },
    );

    return { wallet, total_usd, tokens: breakdown.length };
  } catch (e) {
    console.error(`[cron] snapshot failed for ${wallet.slice(0, 8)}:`, e);
    return null;
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Security — Vercel cron jobs send this header
  const cronSecret = req.headers['authorization'];
  if (process.env.CRON_SECRET && cronSecret !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const todayStr = today();
  console.log(`[cron-snapshot] Starting daily snapshot for ${todayStr}`);

  // 1. Get all distinct wallets that have ever used the tracker
  const { data: walletRows, error } = await supabase
    .from('portfolio_snapshots')
    .select('wallet')
    .order('wallet');

  if (error) {
    console.error('[cron] Failed to fetch wallets:', error);
    return res.status(500).json({ error: error.message });
  }

  // Deduplicate wallets
  const wallets = [...new Set((walletRows ?? []).map((r: any) => r.wallet as string))];
  console.log(`[cron-snapshot] Found ${wallets.length} wallets to snapshot`);

  if (wallets.length === 0) {
    return res.status(200).json({ message: 'No wallets found', snapshots: 0 });
  }

  const connection = new Connection(RPC_URL, { commitment: 'confirmed' as const });
  const results: { wallet: string; total_usd: number; tokens: number }[] = [];
  const failed: string[] = [];

  // 2. Process wallets in batches to avoid overwhelming the RPC
  for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
    const batch = wallets.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(w => snapshotWallet(connection, w, todayStr))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === 'fulfilled' && r.value) {
        results.push(r.value);
      } else {
        failed.push(batch[j].slice(0, 8) + '…');
      }
    }

    // Small delay between batches to be kind to the RPC
    if (i + BATCH_SIZE < wallets.length) {
      await new Promise(r => setTimeout(r, 500));
    }
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
