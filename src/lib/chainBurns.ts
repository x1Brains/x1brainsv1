// Generic on-chain burn scanner — works for BRAINS or LB (both Token-2022).
// Scans the mint's signature history and parses `burn` / `burnChecked` ixs.
//
// X1 RPC quirk: returns `uiAmount` with wrong precision for Token-2022. Always
// use the raw `amount` and divide by 10^decimals (we resolve decimals once
// at scan start from the mint account).

import { Connection, PublicKey } from '@solana/web3.js';

export type ChainBurnEvent = {
  sig: string;
  wallet: string;
  amount: number;
  block_time: number;
};

export type ChainBurnSummary = {
  events: ChainBurnEvent[];
  totals: Map<string, { burned: number; txCount: number; events: ChainBurnEvent[] }>;
  totalBurned: number;
  totalTxs: number;
};

type ProgressFn = (summary: ChainBurnSummary, progress: string, batches: number) => void;

// In-memory cache keyed by mint
const _cache = new Map<string, { summary: ChainBurnSummary; ts: number }>();
const CACHE_TTL_MS = 60_000;
const LS_KEY = (mint: string) => `v2_chain_burns_${mint}`;
const LS_TTL_MS = 5 * 60 * 1000;

export function getCachedChainBurns(mint: string): ChainBurnSummary | null {
  const c = _cache.get(mint);
  if (c && Date.now() - c.ts < CACHE_TTL_MS) return c.summary;
  try {
    const raw = localStorage.getItem(LS_KEY(mint));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.ts && Date.now() - parsed.ts < LS_TTL_MS && Array.isArray(parsed.events)) {
        const summary = aggregate(parsed.events);
        _cache.set(mint, { summary, ts: parsed.ts });
        return summary;
      }
    }
  } catch {}
  return null;
}

// Read stored burn events IGNORING the display TTL. Historical burns are
// immutable, so they're always a valid seed for the incremental scan — this
// keeps repeat scans fast (fetch only the new tail) instead of full-rescanning
// the whole mint history every time the 5-min display cache lapses.
function getStoredBurnEvents(mint: string): ChainBurnEvent[] {
  try {
    const raw = localStorage.getItem(LS_KEY(mint));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.events)) return parsed.events as ChainBurnEvent[];
    }
  } catch {}
  return [];
}

function setCachedChainBurns(mint: string, summary: ChainBurnSummary) {
  const ts = Date.now();
  _cache.set(mint, { summary, ts });
  try {
    localStorage.setItem(LS_KEY(mint), JSON.stringify({ events: summary.events, ts }));
  } catch {}
}

function aggregate(events: ChainBurnEvent[]): ChainBurnSummary {
  const totals = new Map<string, { burned: number; txCount: number; events: ChainBurnEvent[] }>();
  let totalBurned = 0;
  for (const ev of events) {
    const cur = totals.get(ev.wallet) ?? { burned: 0, txCount: 0, events: [] };
    cur.burned += ev.amount;
    cur.txCount += 1;
    cur.events.push(ev);
    totals.set(ev.wallet, cur);
    totalBurned += ev.amount;
  }
  return { events, totals, totalBurned, totalTxs: events.length };
}

// Fetch mint decimals once via getParsedAccountInfo.
async function fetchMintDecimals(connection: Connection, mintPk: PublicKey): Promise<number> {
  try {
    const info = await connection.getParsedAccountInfo(mintPk);
    const dec = (info.value?.data as any)?.parsed?.info?.decimals;
    if (typeof dec === 'number') return dec;
  } catch {}
  return 9; // safe default for BRAINS/LB
}

export async function fetchBurnsFromChain(
  connection: Connection,
  mint: string,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<ChainBurnSummary> {
  const mintPk  = new PublicKey(mint);
  const mintStr = mintPk.toBase58();
  const decimals = await fetchMintDecimals(connection, mintPk);
  const divisor = Math.pow(10, decimals);

  // Seed from stored events (ignore the display TTL — see getStoredBurnEvents).
  // The 60s in-memory cache is still preferred when hot; otherwise fall back to
  // the full stored set so the scan stays incremental across the 5-min lapse.
  const hot = getCachedChainBurns(mint);
  let events: ChainBurnEvent[] = hot ? [...hot.events] : getStoredBurnEvents(mint);
  const knownSigs = new Set(events.map(e => e.sig));

  onProgress?.(aggregate(events), 'Seeded from cache', 0);

  const MAX_BATCHES = 500;

  // ── PHASE 1: walk the signature history (cheap) and collect only the sigs we
  // haven't already parsed. Pagination is cursor-based so it must be sequential,
  // but each call is light (returns 100 sig stubs). Stop as soon as we reach a
  // page that contains an already-known sig — everything older is already cached.
  type SigStub = Awaited<ReturnType<typeof connection.getSignaturesForAddress>>[number];
  const unknownSigs: SigStub[] = [];
  let before: string | undefined;
  let reachedKnown = false;

  for (let page = 0; page < MAX_BATCHES; page++) {
    if (signal.aborted || reachedKnown) break;

    const sigs = await connection.getSignaturesForAddress(mintPk, {
      limit: 100, ...(before ? { before } : {}),
    }).catch(() => [] as SigStub[]);

    if (!sigs.length) break;
    before = sigs[sigs.length - 1].signature;

    for (const s of sigs) {
      if (knownSigs.has(s.signature)) reachedKnown = true;
      else unknownSigs.push(s);
    }
    // Once a page touches known territory we've caught up — the boundary page's
    // unknowns are already collected above, so we can stop.
    if (reachedKnown) break;
    if (sigs.length < 100) break;

    if (page % 3 === 0) {
      onProgress?.(aggregate(events), `Indexing… ${unknownSigs.length} new txs`, page);
    }
  }

  // ── PHASE 2: parse the unknown sigs in 25-sig chunks (X1 RPC 413s above ~50),
  // running several chunks concurrently. The parse is the dominant cost, so a
  // concurrency pool turns a long sequential chain into a few parallel waves.
  const PARSE_CHUNK = 25;
  const PARSE_CONCURRENCY = 6;
  const chunks: SigStub[][] = [];
  for (let i = 0; i < unknownSigs.length; i += PARSE_CHUNK) {
    chunks.push(unknownSigs.slice(i, i + PARSE_CHUNK));
  }

  let chunksDone = 0;
  const parseChunk = async (chunk: SigStub[]) => {
    if (signal.aborted) return;
    const part = await connection.getParsedTransactions(chunk.map(s => s.signature), {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    }).catch(() => null);
    if (signal.aborted) return;

    for (let i = 0; i < chunk.length; i++) {
      const tx = part?.[i];
      const sigInfo = chunk[i];
      if (!tx || tx.meta?.err) continue;

      const allIxs: unknown[] = [...(tx.transaction.message.instructions ?? [])];
      for (const inn of tx.meta?.innerInstructions ?? []) allIxs.push(...(inn.instructions ?? []));

      for (const ix of allIxs) {
        const p = ix as Record<string, unknown>;
        // Accept both classic SPL and Token-2022 parsed shapes
        if (p.program !== 'spl-token' && p.program !== 'spl-token-2022') continue;
        const parsed = p.parsed as Record<string, unknown> | undefined;
        if (!parsed) continue;
        const type = parsed.type as string;
        if (type !== 'burn' && type !== 'burnChecked') continue;
        const info = parsed.info as Record<string, unknown> | undefined;
        if (!info || (info.mint as string) !== mintStr) continue;

        const authority = (info.authority ?? info.multisigAuthority) as string | undefined;
        if (!authority) continue;

        const ta     = info.tokenAmount as Record<string, unknown> | undefined;
        const rawAmt = ta ? Number((ta as any).amount ?? 0) : Number(info.amount ?? 0);
        const amount = rawAmt > 0 ? rawAmt / divisor : 0;
        if (amount <= 0) continue;

        const sig       = tx.transaction.signatures?.[0] ?? sigInfo.signature;
        const blockTime = tx.blockTime ?? sigInfo.blockTime ?? 0;

        events.push({ sig, wallet: authority, amount, block_time: blockTime });
        knownSigs.add(sig);
      }
    }

    chunksDone++;
    if (chunksDone % 2 === 0) {
      onProgress?.(aggregate(events), `Scanning… ${events.length} burns found`, chunksDone);
    }
  };

  // Simple fixed-size worker pool over the chunk list.
  let next = 0;
  const worker = async () => {
    while (next < chunks.length && !signal.aborted) {
      const myChunk = chunks[next++];
      await parseChunk(myChunk);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARSE_CONCURRENCY, chunks.length) }, () => worker()),
  );

  const summary = aggregate(events);
  setCachedChainBurns(mint, summary);
  onProgress?.(summary, '', chunksDone);
  return summary;
}
