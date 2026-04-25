// api/_bot-actions.ts
//
// Drop-in bot actions for your existing /api/admin proxy.
//
// Integrate with your existing api/admin.ts:
//
//    import { handleBotAction, isBotAction } from './_bot-actions';
//
//    export default async function handler(req, res) {
//      const { action, payload } = req.body;
//      const wallet = req.headers['x-admin-wallet'] as string;
//
//      // Verify admin wallet (same as your existing actions)
//      if (wallet !== '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC') {
//        return res.status(403).json({ success: false, error: 'unauthorized' });
//      }
//
//      // Route bot actions to this module — pass the wallet for defense-in-depth.
//      // handleBotAction also re-checks the wallet itself, so even if the
//      // outer gate above is misconfigured, bot actions stay locked.
//      if (isBotAction(action)) {
//        const result = await handleBotAction(action, payload, wallet);
//        return res.status(result.success ? 200 : 400).json(result);
//      }
//
//      // ...your existing actions (award_lbp, save_weekly_config, etc.)
//    }

import { createClient } from '@supabase/supabase-js';

// ─── Supabase admin client (uses SERVICE key — server-side only!) ─────────────
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[bot-actions] SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ─── X1 / project constants (these match config.py on the bot host) ──────────
const RPC_URL = 'https://rpc.mainnet.x1.xyz';
const POOLS = {
  BRAINS: {
    mint: 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN',
    pool: '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg',
  },
  LB: {
    mint: 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6',
    pool: 'CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK',
  },
};

const BOT_ACTIONS = new Set([
  'bot_get_settings',
  'bot_save_settings',
  'bot_get_connection',
  'bot_save_telegram_token',
  'bot_save_chat',
  'bot_test_telegram',
  'bot_detect_chats',
  'bot_detect_vaults',
  'bot_send_test_message',
  'bot_upload_banner',
  'bot_get_banner_url',
  'bot_health',
]);

// ─── DEFENSE-IN-DEPTH ADMIN WALLET CHECK ─────────────────────────────────────
// The outer /api/admin handler already validates x-admin-wallet, but bot
// actions can hijack the Telegram token if the outer check is bypassed or
// misconfigured, so we re-verify here. Either env var or this fallback works.
const ADMIN_WALLETS = new Set(
  (process.env.ADMIN_WALLET || '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC')
    .split(',').map(w => w.trim()).filter(Boolean)
);

export function isBotAction(action: string): boolean {
  return BOT_ACTIONS.has(action);
}

type ActionResult = { success: boolean; error?: string; data?: any };

// ═════════════════════════════════════════════════════════════════════════════
// MAIN ROUTER
// ═════════════════════════════════════════════════════════════════════════════
export async function handleBotAction(
  action: string,
  payload: any,
  wallet?: string,    // pass req.headers['x-admin-wallet'] from your /api/admin handler
): Promise<ActionResult> {
  // Belt-and-suspenders wallet check. Even if the outer handler forgets to
  // gate, the bot actions can never be invoked without an admin wallet header.
  const w = (wallet || '').trim();
  if (!w || !ADMIN_WALLETS.has(w)) {
    return { success: false, error: 'unauthorized: admin wallet required' };
  }

  try {
    switch (action) {
      case 'bot_get_settings':       return await getSettings();
      case 'bot_save_settings':      return await saveSettings(payload);
      case 'bot_get_connection':     return await getConnection();
      case 'bot_save_telegram_token': return await saveTelegramToken(payload?.token);
      case 'bot_save_chat':          return await saveChat(payload?.chat_id, payload?.chat_title);
      case 'bot_test_telegram':      return await testTelegram();
      case 'bot_detect_chats':       return await detectChats();
      case 'bot_detect_vaults':      return await detectVaults(payload?.token);
      case 'bot_send_test_message':  return await sendTestMessage(payload?.token);
      case 'bot_upload_banner':      return await uploadBanner(payload?.token, payload?.dataUrl, payload?.filename);
      case 'bot_get_banner_url':     return await getBannerUrl(payload?.token);
      case 'bot_health':             return { success: true, data: { ok: true } };
      default:                       return { success: false, error: `unknown bot action: ${action}` };
    }
  } catch (e: any) {
    console.error(`[bot-action ${action}]`, e);
    return { success: false, error: e?.message ?? 'unexpected error' };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════
async function getSettings(): Promise<ActionResult> {
  const { data, error } = await sb.from('bot_settings').select('config').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };
  return { success: true, data: data?.config ?? {} };
}

async function saveSettings(updates: Record<string, any>): Promise<ActionResult> {
  if (!updates || typeof updates !== 'object') {
    return { success: false, error: 'updates must be an object' };
  }

  // Whitelist allowed keys to prevent injection
  const allowed = new Set([
    'brains_buys', 'brains_burns', 'brains_lp', 'brains_stake', 'brains_unstake', 'brains_claim',
    'lb_buys', 'lb_burns', 'lb_lp', 'lb_stake', 'lb_unstake', 'lb_claim',
    'min_buy_usd', 'min_burn_tokens', 'min_lp_usd', 'min_stake_lp', 'min_claim_usd',
    'tier_big_usd', 'tier_whale_usd',
  ]);
  const filtered: Record<string, any> = {};
  for (const k of Object.keys(updates)) if (allowed.has(k)) filtered[k] = updates[k];
  if (Object.keys(filtered).length === 0) {
    return { success: false, error: 'no allowed fields in updates' };
  }

  const { data: cur, error: e1 } = await sb.from('bot_settings').select('config').eq('id', 'main').single();
  if (e1) return { success: false, error: e1.message };

  const merged = { ...(cur?.config ?? {}), ...filtered };
  const { error: e2 } = await sb.from('bot_settings').update({ config: merged }).eq('id', 'main');
  if (e2) return { success: false, error: e2.message };

  return { success: true, data: merged };
}

// ═════════════════════════════════════════════════════════════════════════════
// CONNECTION
// ═════════════════════════════════════════════════════════════════════════════
async function getConnection(): Promise<ActionResult> {
  const { data, error } = await sb.from('bot_connection').select('*').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };

  // CRITICAL: never return the raw token. Only a masked preview.
  const t = data?.telegram_token || '';
  const masked = t ? (t.length > 14 ? `${t.slice(0, 6)}…${t.slice(-4)}` : '••••••••') : '';

  return {
    success: true,
    data: {
      telegram_token_masked: masked,
      chat_id:    data?.chat_id ?? '',
      chat_title: data?.chat_title ?? '',
      vaults: {
        BRAINS: { vault_token: data?.vault_brains_token ?? '', vault_quote: data?.vault_brains_quote ?? '' },
        LB:     { vault_token: data?.vault_lb_token ?? '',     vault_quote: data?.vault_lb_quote ?? '' },
      },
      mints: POOLS,
      complete: !!(t && data?.chat_id
        && data?.vault_brains_token && data?.vault_brains_quote
        && data?.vault_lb_token     && data?.vault_lb_quote),
    },
  };
}

async function saveTelegramToken(token?: string): Promise<ActionResult> {
  const t = (token || '').trim();
  if (!t || !t.includes(':')) return { success: false, error: 'invalid token format' };

  // Verify before saving
  const verify = await tgCall(t, 'getMe');
  if (!verify.ok) return { success: false, error: verify.error || 'Telegram rejected token' };

  const { error } = await sb.from('bot_connection').update({ telegram_token: t }).eq('id', 'main');
  if (error) return { success: false, error: error.message };
  return { success: true, data: { bot: verify.result } };
}

async function saveChat(chat_id?: string, chat_title?: string): Promise<ActionResult> {
  const cid = String(chat_id || '').trim();
  if (!cid) return { success: false, error: 'chat_id required' };
  const title = String(chat_title || '').trim();

  const { error } = await sb.from('bot_connection')
    .update({ chat_id: cid, chat_title: title })
    .eq('id', 'main');
  if (error) return { success: false, error: error.message };
  return { success: true };
}

async function testTelegram(): Promise<ActionResult> {
  const { data, error } = await sb.from('bot_connection').select('telegram_token, chat_id').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };
  if (!data?.telegram_token) return { success: false, error: 'no token saved' };

  const verify = await tgCall(data.telegram_token, 'getMe');
  if (!verify.ok) return { success: false, error: verify.error || 'token check failed' };

  if (!data.chat_id) return { success: true, data: { bot: verify.result, sent: false } };

  const send = await tgCall(data.telegram_token, 'sendMessage', {
    chat_id: data.chat_id,
    text: '✅ *X1 Brains Bot* connection test\n\nWiring verified from admin UI. Bot ready to broadcast events.',
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
  if (!send.ok) return { success: false, error: send.error || 'send failed' };
  return { success: true, data: { bot: verify.result, sent: true } };
}

async function detectChats(): Promise<ActionResult> {
  const { data, error } = await sb.from('bot_connection').select('telegram_token').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };
  if (!data?.telegram_token) return { success: false, error: 'no Telegram token saved yet' };

  const upd = await tgCall(data.telegram_token, 'getUpdates', { limit: 100, timeout: 0 });
  if (!upd.ok) return { success: false, error: upd.error || 'getUpdates failed' };

  const chats: Record<string, any> = {};
  for (const update of upd.result || []) {
    const msg = update.message || update.channel_post || update.edited_message
              || update.edited_channel_post || update.my_chat_member || update.chat_member;
    const chat = msg?.chat;
    if (!chat || !['group', 'supergroup', 'channel'].includes(chat.type)) continue;
    chats[String(chat.id)] = {
      id: chat.id,
      title: chat.title || '(no title)',
      type: chat.type,
      username: chat.username,
    };
  }
  const list = Object.values(chats);
  return {
    success: true,
    data: {
      chats: list,
      hint: list.length === 0
        ? 'No groups found. Add the bot to your group as admin, send any message in the group, then click Detect again.'
        : undefined,
    },
  };
}

async function sendTestMessage(token?: string): Promise<ActionResult> {
  const sym = String(token || '').toUpperCase();
  if (!POOLS[sym as keyof typeof POOLS]) return { success: false, error: `unknown token: ${sym}` };

  const { data, error } = await sb.from('bot_connection').select('telegram_token, chat_id').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };
  if (!data?.telegram_token || !data?.chat_id) return { success: false, error: 'connection not configured yet' };

  const emoji = sym === 'BRAINS' ? '🧠' : '🧪';
  const caption = `${emoji}  *$${sym} TEST MESSAGE*  ${emoji}\n\nAdmin-triggered test from the X1 Brains bot. Wiring confirmed. ✅`;

  // Try to send the banner if uploaded
  const bannerUrl = await getPublicBannerUrl(sym);
  let res;
  if (bannerUrl) {
    res = await tgCall(data.telegram_token, 'sendPhoto', {
      chat_id: data.chat_id, photo: bannerUrl, caption, parse_mode: 'Markdown',
    });
  } else {
    res = await tgCall(data.telegram_token, 'sendMessage', {
      chat_id: data.chat_id, text: caption, parse_mode: 'Markdown',
    });
  }
  if (!res.ok) return { success: false, error: res.error || 'send failed' };
  return { success: true };
}

// ═════════════════════════════════════════════════════════════════════════════
// VAULT AUTO-DETECTION (parses on-chain XDEX pool state)
// ═════════════════════════════════════════════════════════════════════════════
async function detectVaults(token?: string): Promise<ActionResult> {
  const sym = String(token || '').toUpperCase();
  const pool = POOLS[sym as keyof typeof POOLS];
  if (!pool) return { success: false, error: `unknown token: ${sym}` };

  // Fetch the pool account's raw data
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [pool.pool, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  const j = await r.json();
  if (j.error) return { success: false, error: `RPC error: ${j.error.message}` };
  const dataB64 = j?.result?.value?.data?.[0];
  if (!dataB64) return { success: false, error: 'pool account not found on-chain' };

  // Decode the relevant bytes
  const raw = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0));
  if (raw.length < 232) {
    return { success: false, error: `pool account too small (${raw.length} bytes)` };
  }

  const t0Vault = b58encode(raw.slice(72, 104));
  const t1Vault = b58encode(raw.slice(104, 136));
  const t0Mint  = b58encode(raw.slice(168, 200));
  const t1Mint  = b58encode(raw.slice(200, 232));

  let vault_token: string, vault_quote: string;
  if (t0Mint === pool.mint) {
    vault_token = t0Vault; vault_quote = t1Vault;
  } else if (t1Mint === pool.mint) {
    vault_token = t1Vault; vault_quote = t0Vault;
  } else {
    return {
      success: false,
      error: `Pool's mints don't match ${sym}. Wrong pool address?`,
    };
  }

  // Save to DB
  const updates: any = {};
  updates[`vault_${sym.toLowerCase()}_token`] = vault_token;
  updates[`vault_${sym.toLowerCase()}_quote`] = vault_quote;
  const { error } = await sb.from('bot_connection').update(updates).eq('id', 'main');
  if (error) return { success: false, error: error.message };

  return { success: true, data: { vault_token, vault_quote } };
}

// ═════════════════════════════════════════════════════════════════════════════
// BANNERS (Supabase Storage)
// ═════════════════════════════════════════════════════════════════════════════
async function uploadBanner(token?: string, dataUrl?: string, filename?: string): Promise<ActionResult> {
  const sym = String(token || '').toUpperCase();
  if (!POOLS[sym as keyof typeof POOLS]) return { success: false, error: `unknown token: ${sym}` };
  if (!dataUrl || !filename) return { success: false, error: 'dataUrl + filename required' };

  // Parse data URL → bytes
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return { success: false, error: 'invalid dataUrl' };
  const mime = match[1];
  const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  if (bytes.length > 5 * 1024 * 1024) return { success: false, error: 'image too large (max 5MB)' };

  const ext = (filename.split('.').pop() || 'jpg').toLowerCase();
  const path = `banner_${sym.toLowerCase()}.${ext}`;

  // Delete existing first (in case extension changed)
  await sb.storage.from('bot-banners').remove([
    `banner_${sym.toLowerCase()}.jpg`,
    `banner_${sym.toLowerCase()}.jpeg`,
    `banner_${sym.toLowerCase()}.png`,
    `banner_${sym.toLowerCase()}.webp`,
    `banner_${sym.toLowerCase()}.gif`,
  ]);

  const { error } = await sb.storage.from('bot-banners').upload(path, bytes, {
    contentType: mime, upsert: true, cacheControl: '60',
  });
  if (error) return { success: false, error: error.message };

  const { data: urlData } = sb.storage.from('bot-banners').getPublicUrl(path);
  return { success: true, data: { url: urlData.publicUrl, path } };
}

async function getBannerUrl(token?: string): Promise<ActionResult> {
  const sym = String(token || '').toUpperCase();
  const url = await getPublicBannerUrl(sym);
  if (!url) return { success: false, error: 'no banner found' };
  return { success: true, data: { url } };
}

async function getPublicBannerUrl(sym: string): Promise<string | null> {
  // Check which extension exists by trying a list
  const { data: files } = await sb.storage.from('bot-banners').list('', {
    search: `banner_${sym.toLowerCase()}.`,
  });
  if (!files || files.length === 0) return null;
  const path = files[0].name;
  const { data } = sb.storage.from('bot-banners').getPublicUrl(path);
  return data.publicUrl;
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════
async function tgCall(token: string, method: string, params?: any): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    const j = await r.json();
    if (!j.ok) return { ok: false, error: j.description || `HTTP ${r.status}` };
    return { ok: true, result: j.result };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'network error' };
  }
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes: Uint8Array): string {
  // Count leading zero bytes
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to bigint then to base58 digits
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = (n << 8n) + BigInt(bytes[i]);

  let out = '';
  while (n > 0n) {
    const rem = Number(n % 58n);
    n = n / 58n;
    out = B58_ALPHABET[rem] + out;
  }
  return '1'.repeat(zeros) + out;
}
