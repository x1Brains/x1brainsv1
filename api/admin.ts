// api/admin.ts
// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless route — proxies Supabase admin (write) operations.
// The service role key lives here as SUPABASE_SERVICE_KEY (no VITE_ prefix)
// so it is NEVER bundled into client-side JS.
//
// Auth: every request must include an `auth` blob in the JSON body with an
// Ed25519 signature over a structured message that commits to (action,
// payloadHash, ts, nonce). The signed message's action and payloadHash must
// match the request body — so a captured signature can't be replayed against
// a different action or payload. The signing pubkey must be in ADMIN_WALLETS.
// Timestamps must fall within ±60s; nonces are tracked in-memory to block
// replays within that window.
//
// v2 change: two-wallet allowlist instead of single ADMIN_WALLET.
//   COUNCIL  — CnyGhzMuv5snBGxvShxsJMDnvHcXKwRtVVUpzGX3QAuG
//   V1_ADMIN — 2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC
// Override via env ADMIN_WALLETS=pk1,pk2,...
// ─────────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { handleBotAction, isBotAction } from './_bot-actions.js';

const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_SERVICE  = process.env.SUPABASE_SERVICE_KEY || '';

// Dedicated bucket for v2 spotlight uploads — kept separate from the bot's
// `bot-banners` bucket. Auto-created (public) on first upload.
const SPOTLIGHT_BUCKET = 'v2-spotlight';
async function ensureSpotlightBucket(sb: any) {
  try {
    const { data } = await sb.storage.getBucket(SPOTLIGHT_BUCKET);
    if (data) return;
  } catch {}
  try { await sb.storage.createBucket(SPOTLIGHT_BUCKET, { public: true }); } catch {}
}

// Two-wallet allowlist. Keep in sync with src/lib/admin.ts on the frontend.
const COUNCIL_WALLET  = 'CnyGhzMuv5snBGxvShxsJMDnvHcXKwRtVVUpzGX3QAuG';
const V1_ADMIN_WALLET = '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC';
const ADMIN_WALLETS = new Set<string>(
  (process.env.ADMIN_WALLETS || `${COUNCIL_WALLET},${V1_ADMIN_WALLET}`)
    .split(',').map(w => w.trim()).filter(Boolean),
);

const SIG_MAX_SKEW_MS = 60_000;

const SEEN_NONCES = new Map<string, number>();
function rememberNonce(nonce: string, ts: number): boolean {
  if (SEEN_NONCES.has(nonce)) return false;
  SEEN_NONCES.set(nonce, ts);
  if (SEEN_NONCES.size > 1024) {
    const cutoff = Date.now() - SIG_MAX_SKEW_MS;
    for (const [k, t] of SEEN_NONCES) {
      if (t < cutoff) SEEN_NONCES.delete(k);
    }
  }
  return true;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface AdminAuth {
  pubkey: string;
  message: string;
  signature: string;
}

interface SignedMessage {
  action: string;
  payloadHash: string;
  ts: number;
  nonce: string;
}

function verifyAdminAuth(
  auth: AdminAuth | undefined,
  bodyAction: string,
  bodyPayload: unknown,
): string | null {
  if (!auth || typeof auth !== 'object') return 'Missing auth';
  if (typeof auth.pubkey !== 'string' || typeof auth.message !== 'string' || typeof auth.signature !== 'string') {
    return 'Malformed auth';
  }
  if (!ADMIN_WALLETS.has(auth.pubkey)) return 'Unauthorized signer';

  let pubBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubBytes = bs58.decode(auth.pubkey);
    sigBytes = bs58.decode(auth.signature);
  } catch {
    return 'Bad base58 in auth';
  }
  if (pubBytes.length !== 32) return 'Bad pubkey length';
  if (sigBytes.length !== 64) return 'Bad signature length';

  const msgBytes = new TextEncoder().encode(auth.message);
  if (!nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes)) {
    return 'Signature verification failed';
  }

  let parsed: SignedMessage;
  try {
    parsed = JSON.parse(auth.message) as SignedMessage;
  } catch {
    return 'Signed message not JSON';
  }
  if (typeof parsed.action !== 'string' || typeof parsed.payloadHash !== 'string'
      || typeof parsed.ts !== 'number' || typeof parsed.nonce !== 'string') {
    return 'Signed message missing fields';
  }

  const skew = Math.abs(Date.now() - parsed.ts);
  if (skew > SIG_MAX_SKEW_MS) return 'Signed message expired';

  if (parsed.action !== bodyAction) return 'Action mismatch';
  const expectedHash = sha256Hex(JSON.stringify(bodyPayload ?? null));
  if (parsed.payloadHash !== expectedHash) return 'Payload hash mismatch';

  if (!rememberNonce(parsed.nonce, parsed.ts)) return 'Nonce replay';

  return null;
}

function ok(res: VercelResponse, data?: any) {
  return res.status(200).json({ success: true, data: data ?? null });
}
function err(res: VercelResponse, msg: string, status = 400) {
  return res.status(status).json({ success: false, error: msg });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — allow x1brains.io and any preview domain set via ALLOWED_ORIGINS env.
  const origin = req.headers.origin || '';
  const allowed = new Set(
    (process.env.ALLOWED_ORIGINS || 'https://x1brains.io,https://www.x1brains.io')
      .split(',').map(o => o.trim()).filter(Boolean),
  );
  if (allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return err(res, 'Method not allowed', 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE) {
    return err(res, 'Supabase not configured on server', 500);
  }

  const { action, payload, auth } = req.body as {
    action: string;
    payload?: any;
    auth?: AdminAuth;
  };

  const authErr = verifyAdminAuth(auth, action, payload);
  if (authErr) return err(res, authErr, 403);

  const signer = auth!.pubkey; // verified above
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE);

  // ── Bot actions delegated to _bot-actions.ts ──────────────
  if (isBotAction(action)) {
    const result = await handleBotAction(action, payload, signer);
    return res.status(result.success ? 200 : 400).json(result);
  }

  try {
    switch (action) {

      // ── Announcements ────────────────────────────────────────────
      case 'add_announcement': {
        const { title, message, type } = payload;
        const { error } = await sb.from('announcements').insert({
          title, body: message, category: type, pinned: false,
        });
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'insert_announcement': {
        const { error } = await sb.from('announcements').insert(payload);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'delete_announcement': {
        const { error } = await sb.from('announcements').delete().eq('id', payload.id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      // ── Saved Addresses ──────────────────────────────────────────
      case 'save_address': {
        const { owner_wallet, saved_wallet, nickname } = payload;
        if (!owner_wallet || owner_wallet.length < 32 || owner_wallet.length > 44)
          return err(res, 'Invalid owner_wallet');
        if (!saved_wallet || saved_wallet.length < 32 || saved_wallet.length > 44)
          return err(res, 'Invalid saved_wallet');
        if (!nickname || nickname.length > 50)
          return err(res, 'Invalid nickname');
        const { error } = await sb.from('saved_addresses').insert({
          owner_wallet: owner_wallet.trim(),
          saved_wallet: saved_wallet.trim(),
          nickname:     nickname.trim(),
        });
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'delete_address': {
        const { id } = payload;
        if (!id) return err(res, 'Missing id');
        const { error } = await sb.from('saved_addresses').delete().eq('id', id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'get_addresses': {
        const { owner_wallet } = payload;
        if (!owner_wallet) return err(res, 'Missing owner_wallet');
        const { data, error } = await sb
          .from('saved_addresses')
          .select('*')
          .eq('owner_wallet', owner_wallet)
          .order('created_at', { ascending: false });
        if (error) return err(res, error.message);
        return ok(res, data);
      }

      // ── Spotlight carousel images ────────────────────────────────
      case 'spotlight_upload': {
        const { dataUrl, filename, link, caption } = payload || {};
        if (!dataUrl) return err(res, 'Missing image data');
        const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
        if (!m) return err(res, 'Invalid image data URL');
        const mime  = m[1];
        const bytes = Buffer.from(m[2], 'base64');
        if (bytes.length > 5 * 1024 * 1024) return err(res, 'Image too large (max 5MB)');
        const ext  = (String(filename || 'jpg').split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await ensureSpotlightBucket(sb);
        const up = await sb.storage.from(SPOTLIGHT_BUCKET).upload(path, bytes, {
          contentType: mime, upsert: true, cacheControl: '3600',
        });
        if (up.error) return err(res, up.error.message);
        const { data: urlData } = sb.storage.from(SPOTLIGHT_BUCKET).getPublicUrl(path);
        const { data: row, error } = await sb.from('spotlight_images').insert({
          image_url:    urlData.publicUrl,
          storage_path: path,
          link_url:     link || null,
          caption:      caption || null,
        }).select().single();
        if (error) return err(res, error.message);
        return ok(res, row);
      }

      case 'spotlight_list': {
        const { data, error } = await sb.from('spotlight_images')
          .select('*')
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true });
        if (error) return err(res, error.message);
        return ok(res, data);
      }

      case 'spotlight_delete': {
        const { id } = payload || {};
        if (!id) return err(res, 'Missing id');
        const { data: row } = await sb.from('spotlight_images').select('storage_path').eq('id', id).single();
        if (row?.storage_path) { try { await sb.storage.from(SPOTLIGHT_BUCKET).remove([row.storage_path]); } catch {} }
        const { error } = await sb.from('spotlight_images').delete().eq('id', id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      case 'spotlight_set_active': {
        const { id, active } = payload || {};
        if (!id) return err(res, 'Missing id');
        const { error } = await sb.from('spotlight_images').update({ active: !!active }).eq('id', id);
        if (error) return err(res, error.message);
        return ok(res);
      }

      default:
        return err(res, `Unknown action: ${action}`, 400);
    }
  } catch (e: any) {
    return err(res, e?.message ?? 'Internal error', 500);
  }
}
