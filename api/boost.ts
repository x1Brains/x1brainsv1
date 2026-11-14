// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  POST /api/boost — the only way a boost row gets written.                ║
// ║                                                                           ║
// ║  The browser used to burn, then write labwork_boosts + labwork_points    ║
// ║  itself with the anon key. Nothing read the burn back, so the burn was   ║
// ║  advisory: you could skip it and POST the row, and because listing_pda   ║
// ║  is UNIQUE you could overwrite somebody else's paid slot. This endpoint  ║
// ║  verifies the burn on chain and writes with the service key, so anon     ║
// ║  INSERT/UPDATE on both tables can be revoked.                            ║
// ║                                                                           ║
// ║  The caller supplies only a signature and what they want. Price, tier    ║
// ║  duration, expiry, points and the burning wallet are all derived here —  ║
// ║  never taken from the body.                                              ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { BOOST_TIERS, verifyBoostBurn, readListing } from './_verify.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ ok: false, error: 'server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
    const listingPda = String(body.listing_pda ?? '');
    const tier       = String(body.tier ?? '');
    const txSig      = String(body.tx_sig ?? '');
    if (!listingPda || !tier || !txSig) return res.status(400).json({ ok: false, error: 'listing_pda, tier and tx_sig are required' });
    if (!BOOST_TIERS[tier]) return res.status(400).json({ ok: false, error: `unknown tier ${tier}` });

    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    // 1. The signature may only ever buy one boost. labwork_points.tx_sig is
    //    UNIQUE but labwork_boosts.tx_sig is not, so check both — one burn,
    //    one slot, however many times this is called.
    const [{ data: dupBoost }, { data: dupPoints }] = await Promise.all([
      sb.from('labwork_boosts').select('listing_pda').eq('tx_sig', txSig).limit(1),
      sb.from('labwork_points').select('tx_sig').eq('tx_sig', txSig).limit(1),
    ]);
    if (dupBoost?.length || dupPoints?.length) {
      return res.status(409).json({ ok: false, error: 'this burn has already been used for a boost' });
    }

    // 2. The burn itself: right mint, enough of it, recent, and not failed.
    const proof = await verifyBoostBurn(txSig, tier, Math.floor(Date.now() / 1000));
    if (!proof.ok) return res.status(400).json({ ok: false, error: proof.reason });

    // 3. The listing has to be a real, open marketplace listing — otherwise a
    //    burn could park a boost on an arbitrary address and squat the slot.
    const listing = await readListing(listingPda);
    if (!listing) return res.status(400).json({ ok: false, error: 'listing_pda is not an open listing on the marketplace program' });

    // 4. Expiry and points are computed here, from the tier, not from the body.
    const spec      = BOOST_TIERS[tier];
    const expiresAt = new Date(Date.now() + spec.days * 86_400_000).toISOString();
    const points    = Math.floor(proof.amountUi * 1.888);

    const { error: boostErr } = await sb.from('labwork_boosts').upsert({
      listing_pda:    listingPda,
      nft_mint:       listing.nftMint,     // from chain, not from the caller
      seller:         listing.seller,      // from chain, not from the caller
      tier,
      brains:         proof.currency === 'BRAINS' ? proof.amountUi : 0,
      labwork_points: points,
      tx_sig:         txSig,
      expires_at:     expiresAt,
    }, { onConflict: 'listing_pda' });
    if (boostErr) return res.status(500).json({ ok: false, error: boostErr.message });

    // Points ledger is retired from the UI but still written, so the history
    // stays continuous. A failure here must not fail the boost.
    await sb.from('labwork_points').upsert({
      wallet:        proof.wallet,
      brains_burned: proof.currency === 'BRAINS' ? proof.amountUi : 0,
      points,
      source:        'boost',
      tier,
      tx_sig:        txSig,
      earned_at:     new Date().toISOString(),
    }, { onConflict: 'tx_sig' }).then(r => { if (r.error) console.warn('[boost] points write failed:', r.error.message); });

    return res.status(200).json({
      ok: true,
      boost: { listing_pda: listingPda, tier, expires_at: expiresAt, wallet: proof.wallet,
               burned: proof.amountUi, currency: proof.currency, points },
    });
  } catch (e: any) {
    console.error('[boost] unhandled:', e);
    return res.status(500).json({ ok: false, error: e?.message ?? 'server error' });
  }
}
