// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  _verify.ts — on-chain verification for writes that used to be taken     ║
// ║  on trust from the browser.                                              ║
// ║                                                                           ║
// ║  WHY THIS EXISTS (2026-11-14): labwork_boosts / labwork_points /         ║
// ║  nft_metadata were anon INSERT+UPDATE with `with check (true)`. The       ║
// ║  schema comment claimed "writes are gated by an on-chain BRAINS burn      ║
// ║  that's verifiable" — but nothing ever read the burn back. Verifiable     ║
// ║  is not verified: you could skip the burn entirely and POST the row       ║
// ║  with any string as tx_sig, and because listing_pda is UNIQUE you could   ║
// ║  also overwrite somebody else's paid slot. Measured live against prod     ║
// ║  with the public anon key before this shipped.                           ║
// ║                                                                           ║
// ║  Underscore-prefixed so Vercel does not expose it as a route.            ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export const RPC = process.env.X1_RPC || 'https://rpc.mainnet.x1.xyz';

export const BRAINS_MINT = 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN';
export const LB_MINT     = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
export const MARKETPLACE = 'CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4';
export const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

// Mirrors BOOST_TIERS in src/components/V2BoostModal.tsx. Duplicated on
// purpose: the price a boost costs must be decided by the server, never sent
// by the caller. Keep the two in step — if they drift, this one wins.
export const BOOST_TIERS: Record<string, { brains: number; lb: number; days: number }> = {
  spark:       { brains:  8, lb: 0.1,  days: 1 },
  godslayer:   { brains: 16, lb: 0.25, days: 3 },
  incinerator: { brains: 24, lb: 0.5,  days: 7 },
};

// A burn older than this cannot be used to claim a boost. Without it, any
// historical burn — including one already spent on a previous boost, or one
// made for the incinerator with no boost in mind — could be replayed.
export const MAX_BURN_AGE_SECS = 30 * 60;

export async function rpc(method: string, params: any[]): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const j = (await res.json()) as any;
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  let pad = 0;
  for (const b of bytes) { if (b === 0) pad++; else break; }
  return '1'.repeat(pad) + s;
}

export type BurnProof = {
  ok: true; wallet: string; mint: string; currency: 'BRAINS' | 'LB';
  amountUi: number; blockTime: number;
} | { ok: false; reason: string };

/**
 * Confirm `txSig` really burned at least the required amount of BRAINS or LB.
 *
 * Walks top-level AND inner instructions: the burn is a top-level
 * burnChecked today, but a future wrapper that CPIs it would otherwise slip
 * past. jsonParsed reports Token-2022 with program name "spl-token", so we
 * match on programId, not on the name.
 */
export async function verifyBoostBurn(txSig: string, tier: string, nowSecs: number): Promise<BurnProof> {
  const spec = BOOST_TIERS[tier];
  if (!spec) return { ok: false, reason: `unknown tier ${tier}` };
  if (!/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(txSig)) return { ok: false, reason: 'malformed signature' };

  // A signature that passes the character check can still be the wrong byte
  // length once decoded, and the node answers that with "Invalid param:
  // WrongSize". Don't leak an RPC string to the caller as a 500 — it is just
  // a malformed signature.
  let tx: any;
  try {
    tx = await rpc('getTransaction', [txSig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  } catch (e: any) {
    const m = String(e?.message ?? '');
    if (/WrongSize|Invalid param|invalid signature/i.test(m)) return { ok: false, reason: 'malformed signature' };
    throw e;
  }
  if (!tx) return { ok: false, reason: 'transaction not found on chain' };
  if (tx.meta?.err) return { ok: false, reason: 'transaction failed on chain' };

  const blockTime: number = tx.blockTime ?? 0;
  if (!blockTime) return { ok: false, reason: 'transaction has no block time' };
  const age = nowSecs - blockTime;
  if (age > MAX_BURN_AGE_SECS) return { ok: false, reason: `burn is ${Math.floor(age / 60)} min old (max ${MAX_BURN_AGE_SECS / 60})` };
  if (age < -120) return { ok: false, reason: 'block time is in the future' };

  const all: any[] = [...(tx.transaction?.message?.instructions ?? [])];
  for (const g of tx.meta?.innerInstructions ?? []) all.push(...(g.instructions ?? []));

  for (const ix of all) {
    const p = ix?.parsed;
    if (!p || (p.type !== 'burn' && p.type !== 'burnChecked')) continue;
    if (!TOKEN_PROGRAMS.has(ix.programId)) continue;
    const mint: string = p.info?.mint;
    if (mint !== BRAINS_MINT && mint !== LB_MINT) continue;

    const currency: 'BRAINS' | 'LB' = mint === BRAINS_MINT ? 'BRAINS' : 'LB';
    const required = currency === 'BRAINS' ? spec.brains : spec.lb;
    // burnChecked exposes tokenAmount; burn exposes a raw `amount` string and
    // no decimals, so fall back to the mint's own decimals.
    let amountUi: number;
    if (p.info?.tokenAmount?.uiAmount != null) amountUi = Number(p.info.tokenAmount.uiAmount);
    else {
      const dec = currency === 'BRAINS' ? 9 : 2;
      amountUi = Number(p.info?.amount ?? 0) / Math.pow(10, dec);
    }
    // Tolerate float dust in the client's own amount maths, nothing more.
    if (amountUi + 1e-9 < required) continue;

    const wallet: string = p.info?.authority ?? p.info?.multisigAuthority;
    if (!wallet) return { ok: false, reason: 'burn has no authority' };
    return { ok: true, wallet, mint, currency, amountUi, blockTime };
  }
  return { ok: false, reason: `no burn of >= ${spec.brains} BRAINS or ${spec.lb} LB found in this transaction` };
}

/** Read a marketplace listing straight off the chain. */
export async function readListing(listingPda: string): Promise<{ seller: string; nftMint: string; price: bigint } | null> {
  const v = await rpc('getAccountInfo', [listingPda, { encoding: 'base64' }]);
  if (!v?.value) return null;
  if (v.value.owner !== MARKETPLACE) return null;
  const d = Buffer.from(v.value.data[0], 'base64');
  if (d.length !== 90) return null;                      // SaleAccount::LEN
  return {
    seller:  b58encode(d.subarray(8, 40)),
    nftMint: b58encode(d.subarray(40, 72)),
    price:   d.readBigUInt64LE(72),
  };
}
