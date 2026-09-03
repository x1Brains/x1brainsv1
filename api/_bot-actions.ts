// api/_bot-actions.ts
//
// Bot actions invoked from /api/admin when action ∈ BOT_ACTIONS.
// Two-wallet allowlist: COUNCIL + V1_ADMIN (override via ADMIN_WALLETS env).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[bot-actions] SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

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
  // ── THE EMOJI news notifier ──────────────────────────────────────────────
  // A second bot in the same Fly machine and the same database, but the
  // opposite shape: the buy bot broadcasts chain events to ONE configured
  // group; this one fans desk posts out to MANY chats that subscribed
  // themselves. Its tables are the `news_*` set (SUPABASE_NEWSBOT.sql) and it
  // has its own Telegram identity — see the note in bot/newsbot.py.
  'news_get_connection',
  'news_save_token',
  'news_set_enabled',
  'news_get_settings',
  'news_save_settings',
  'news_stats',
  'news_broadcast_test',
]);

// Defense-in-depth: re-verify the signing wallet inside bot-actions, even
// though /api/admin already gated on signature + allowlist. Same allowlist
// rules (env override → fallback to the two known admins).
const COUNCIL_WALLET  = 'CnyGhzMuv5snBGxvShxsJMDnvHcXKwRtVVUpzGX3QAuG';
const V1_ADMIN_WALLET = '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC';
const ADMIN_WALLETS = new Set(
  (process.env.ADMIN_WALLETS || `${COUNCIL_WALLET},${V1_ADMIN_WALLET}`)
    .split(',').map(w => w.trim()).filter(Boolean),
);

export function isBotAction(action: string): boolean {
  return BOT_ACTIONS.has(action);
}

type ActionResult = { success: boolean; error?: string; data?: any };

export async function handleBotAction(
  action: string,
  payload: any,
  wallet?: string,
): Promise<ActionResult> {
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
      case 'news_get_connection':    return await newsGetConnection();
      case 'news_save_token':        return await newsSaveToken(payload?.token);
      case 'news_set_enabled':       return await newsSetEnabled(payload?.enabled);
      case 'news_get_settings':      return await newsGetSettings();
      case 'news_save_settings':     return await newsSaveSettings(payload);
      case 'news_stats':             return await newsStats();
      case 'news_broadcast_test':    return await newsBroadcastTest(payload?.chat_id);
      default:                       return { success: false, error: `unknown bot action: ${action}` };
    }
  } catch (e: any) {
    console.error(`[bot-action ${action}]`, e);
    return { success: false, error: e?.message ?? 'unexpected error' };
  }
}

async function getSettings(): Promise<ActionResult> {
  const { data, error } = await sb.from('bot_settings').select('config').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };
  return { success: true, data: data?.config ?? {} };
}

async function saveSettings(updates: Record<string, any>): Promise<ActionResult> {
  if (!updates || typeof updates !== 'object') {
    return { success: false, error: 'updates must be an object' };
  }

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

async function getConnection(): Promise<ActionResult> {
  const { data, error } = await sb.from('bot_connection').select('*').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };

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

async function detectVaults(token?: string): Promise<ActionResult> {
  const sym = String(token || '').toUpperCase();
  const pool = POOLS[sym as keyof typeof POOLS];
  if (!pool) return { success: false, error: `unknown token: ${sym}` };

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

  const updates: any = {};
  updates[`vault_${sym.toLowerCase()}_token`] = vault_token;
  updates[`vault_${sym.toLowerCase()}_quote`] = vault_quote;
  const { error } = await sb.from('bot_connection').update(updates).eq('id', 'main');
  if (error) return { success: false, error: error.message };

  return { success: true, data: { vault_token, vault_quote } };
}

async function uploadBanner(token?: string, dataUrl?: string, filename?: string): Promise<ActionResult> {
  const sym = String(token || '').toUpperCase();
  if (!POOLS[sym as keyof typeof POOLS]) return { success: false, error: `unknown token: ${sym}` };
  if (!dataUrl || !filename) return { success: false, error: 'dataUrl + filename required' };

  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return { success: false, error: 'invalid dataUrl' };
  const mime = match[1];
  const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
  if (bytes.length > 5 * 1024 * 1024) return { success: false, error: 'image too large (max 5MB)' };

  const ext = (filename.split('.').pop() || 'jpg').toLowerCase();
  const path = `banner_${sym.toLowerCase()}.${ext}`;

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
  const { data: files } = await sb.storage.from('bot-banners').list('', {
    search: `banner_${sym.toLowerCase()}.`,
  });
  if (!files || files.length === 0) return null;
  const path = files[0].name;
  const { data } = sb.storage.from('bot-banners').getPublicUrl(path);
  return data.publicUrl;
}

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
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

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


// ══════════════════════════════════════════════════════════════════════════
//  THE EMOJI NEWS NOTIFIER
// ══════════════════════════════════════════════════════════════════════════

/** ⛔ THE TOKEN IS MASKED ON THE WAY OUT, exactly as the buy bot's is. Once it
 *  has been saved there is no reason any browser ever sees it again — an admin
 *  needs to know a token is set and which bot it belongs to, not what it is.
 *  Same reason the buy bot returns `8295xx…kAL4`. */
async function newsGetConnection(): Promise<ActionResult> {
  const { data, error } = await sb.from('news_bot_connection').select('*').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };
  const t = data?.telegram_token || '';
  return {
    success: true,
    data: {
      has_token: !!t,
      token_masked: t ? (t.length > 14 ? `${t.slice(0, 6)}…${t.slice(-4)}` : '••••••••') : '',
      bot_username: data?.bot_username || '',
      enabled: !!data?.enabled,
      updated_at: data?.updated_at || null,
    },
  };
}

/*  ⛔⛔ VERIFIED WITH getMe BEFORE IT IS STORED, and the username is captured in
 *  the same call. A token that Telegram rejects must never reach the database:
 *  the Fly worker reads this row, builds a Bot with whatever is in it, and a
 *  bad token there makes the loop throw once every cycle forever with nothing
 *  in the admin UI to suggest why. Fail here, where somebody is looking. */
async function newsSaveToken(token?: string): Promise<ActionResult> {
  const t = (token || '').trim();
  if (!t || !t.includes(':')) return { success: false, error: 'invalid token format' };

  const verify = await tgCall(t, 'getMe');
  if (!verify.ok) return { success: false, error: verify.error || 'Telegram rejected token' };

  /* ⛔ AND IT MUST NOT BE THE BUY BOT'S TOKEN. Telegram hands each update to
     whoever calls getUpdates first, so two processes long-polling one token
     would steal each other's commands at random — subscribers would see /start
     work about half the time. Cheap to check, impossible to diagnose later. */
  const { data: buybot } = await sb.from('bot_connection').select('telegram_token').eq('id', 'main').single();
  if (buybot?.telegram_token && buybot.telegram_token === t) {
    return { success: false, error: 'that is the buy bot\'s token — the news bot needs its own @handle from BotFather' };
  }

  const username = verify.result?.username || '';
  const { error } = await sb.from('news_bot_connection')
    .update({ telegram_token: t, bot_username: username, updated_at: new Date().toISOString() })
    .eq('id', 'main');
  if (error) return { success: false, error: error.message };
  return { success: true, data: { bot: verify.result } };
}

async function newsSetEnabled(enabled?: boolean): Promise<ActionResult> {
  const { data: row } = await sb.from('news_bot_connection').select('telegram_token').eq('id', 'main').single();
  if (enabled && !row?.telegram_token) {
    return { success: false, error: 'save a Telegram token first' };
  }
  const { error } = await sb.from('news_bot_connection')
    .update({ enabled: !!enabled, updated_at: new Date().toISOString() })
    .eq('id', 'main');
  if (error) return { success: false, error: error.message };
  return { success: true, data: { enabled: !!enabled } };
}

async function newsGetSettings(): Promise<ActionResult> {
  const { data, error } = await sb.from('news_state').select('config').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };
  return { success: true, data: data?.config ?? {} };
}

/** ⛔ AN ALLOW-LIST, NOT A MERGE OF WHATEVER ARRIVED. `config` is a jsonb blob,
 *  so an unfiltered spread lets a typo'd key accumulate silently and a hostile
 *  one write anything at all into the row the Fly worker trusts. Same rule the
 *  buy bot's saveSettings follows. */
const NEWS_KEYS = new Set([
  'announce_articles', 'announce_projects', 'announce_builders',
  'site_url', 'poll_seconds',
]);

async function newsSaveSettings(payload: any): Promise<ActionResult> {
  const incoming = payload?.config ?? payload ?? {};
  const { data: cur, error: readErr } = await sb.from('news_state').select('config').eq('id', 'main').single();
  if (readErr) return { success: false, error: readErr.message };

  const next: Record<string, any> = { ...(cur?.config ?? {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (!NEWS_KEYS.has(k)) continue;
    if (k === 'site_url') {
      const u = String(v || '').trim().replace(/\/+$/, '');
      /* ⛔ The links in every announcement are built from this. A value that is
         not an https origin would send every subscriber a dead link, and the
         first anyone would know is a reader saying the bot is broken. */
      if (!/^https:\/\/[a-z0-9.-]+$/i.test(u)) return { success: false, error: 'site_url must be an https origin' };
      next[k] = u;
    } else if (k === 'poll_seconds') {
      /* ⛔ Floored at 30s. This project has already had its Supabase egress
         quota burned once by a loop that re-read config every 5 seconds; the
         desk publishes a few times a day and nothing here needs to be fast. */
      const n = Math.max(30, Math.min(3600, Number(v) || 90));
      next[k] = n;
    } else {
      next[k] = !!v;
    }
  }

  const { error } = await sb.from('news_state')
    .update({ config: next, updated_at: new Date().toISOString() })
    .eq('id', 'main');
  if (error) return { success: false, error: error.message };
  return { success: true, data: next };
}

/** Subscriber counts and the topic split — the only view an admin gets of the
 *  list. ⛔ Counts, never rows: a subscriber list is the chat ids of everyone
 *  reading the paper, and the admin panel has no reason to hold them. */
async function newsStats(): Promise<ActionResult> {
  const { data, error } = await sb.from('news_subs').select('active, topics, chat_type');
  if (error) return { success: false, error: error.message };
  const rows = data ?? [];
  const active = rows.filter(r => r.active);
  const topic = (k: string) => active.filter(r => (r.topics ?? {})[k] !== false).length;
  const { count: seen } = await sb.from('news_seen').select('*', { count: 'exact', head: true });
  return {
    success: true,
    data: {
      active: active.length,
      total: rows.length,
      groups: active.filter(r => r.chat_type && r.chat_type !== 'private').length,
      news: topic('news'),
      projects: topic('projects'),
      builders: topic('builders'),
      announced: seen ?? 0,
    },
  };
}

/** Sends one message to a single chat, to prove the wiring end to end.
 *  ⛔ Takes an explicit chat_id and does NOT touch the subscriber list — an
 *  admin testing the bot must not be able to spray a test message at everyone
 *  who signed up. */
async function newsBroadcastTest(chatId?: string): Promise<ActionResult> {
  const cid = String(chatId || '').trim();
  if (!cid) return { success: false, error: 'chat_id required — message the bot, then paste your chat id' };

  const { data, error } = await sb.from('news_bot_connection').select('telegram_token').eq('id', 'main').single();
  if (error) return { success: false, error: error.message };
  if (!data?.telegram_token) return { success: false, error: 'no token saved' };

  const { data: st } = await sb.from('news_state').select('config').eq('id', 'main').single();
  const site = (st?.config?.site_url || 'https://www.theemoji.lol').replace(/\/+$/, '');

  const send = await tgCall(data.telegram_token, 'sendMessage', {
    chat_id: cid,
    text: `📰 <b>THE EMOJI</b> · TEST\n\n<b>Wiring verified from the admin panel.</b>\nThis is what a story looks like when the desk files one.\n\n${site}`,
    parse_mode: 'HTML',
  });
  if (!send.ok) return { success: false, error: send.error || 'send failed' };
  return { success: true, data: { sent: true } };
}
