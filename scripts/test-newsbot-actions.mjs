/*  Tests for the news-notifier actions in api/_bot-actions.ts.
 *
 *  ⛔⛔ NOTHING TYPECHECKS api/ IN THIS REPO. The root tsconfig is a project
 *  reference pair covering `src` and `vite.config.ts`, and `npm run build` is a
 *  bare `vite build` — so the serverless functions, including the service-key
 *  admin bridge, are checked by nobody. On top of that the interesting bugs
 *  here are not type errors at all: a settings key that writes straight through
 *  to the jsonb the Fly worker trusts, a site_url that sends every subscriber a
 *  dead link, a token saved that Telegram would reject.
 *
 *  ⭐ So the REAL module is bundled with Supabase and fetch replaced by stubs,
 *  and the assertions are on what it tried to write.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TMP = join(tmpdir(), `botactions.${process.pid}.mjs`);

/*  ⛔ A DB THAT RECORDS RATHER THAN A DB THAT SAYS YES. The point of most of
 *  these checks is WHAT was written, so the stub keeps every update. */
const DB = { rows: {}, writes: [] };
const supabaseStub = `
const DB = globalThis.__DB;
function table(name) {
  const q = {
    _eq: null, _sel: null,
    select(s) { this._sel = s; return this; },
    eq(col, val) { this._eq = [col, val]; return this; },
    async single() { return { data: DB.rows[name] ?? null, error: null }; },
    update(vals) { DB.writes.push({ table: name, vals }); const p = Promise.resolve({ data: null, error: DB.rows[name] === undefined ? { message: 'no row' } : null }); p.eq = () => p; return p; },
    then(res, rej) { return Promise.resolve({ data: DB.rows[name] ?? [], error: null }).then(res, rej); },
  };
  return q;
}
export function createClient() { return { from: table }; }
`;

await build({
  entryPoints: [`${ROOT}/api/_bot-actions.ts`],
  outfile: TMP, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{
    name: 'stub-supabase',
    setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'sb-stub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: supabaseStub, loader: 'js' }));
    },
  }],
});

globalThis.__DB = DB;
process.env.SUPABASE_URL = 'https://127.0.0.1:9';
process.env.SUPABASE_SERVICE_KEY = 'test-only';

// ── fake Telegram ────────────────────────────────────────────────────────────
let TG = { ok: true, result: { username: 'TheEmojiNewsBot', id: 42 } };
const tgCalls = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) {
    tgCalls.push({ url: u, body: JSON.parse(init?.body || '{}') });
    return { ok: true, status: 200, json: async () => TG };
  }
  throw new Error(`unstubbed fetch → ${u}`);
};

const { handleBotAction, isBotAction } = await import(TMP + '?v=' + Date.now());
const ADMIN = 'CnyGhzMuv5snBGxvShxsJMDnvHcXKwRtVVUpzGX3QAuG';

let bad = 0;
const check = (name, ok, got = '') => { if (!ok) bad++; console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `\n      got: ${JSON.stringify(got).slice(0, 220)}`}`); };
const call = (a, p, w = ADMIN) => handleBotAction(a, p, w);
const lastWrite = () => DB.writes[DB.writes.length - 1];

// ── registration + the gate ──────────────────────────────────────────────────
check('the news actions are registered', ['news_get_connection','news_save_token','news_set_enabled','news_get_settings','news_save_settings','news_stats','news_broadcast_test'].every(isBotAction));
check('a non-admin wallet is refused', (await call('news_save_token', { token: 'a:b' }, 'SomeStranger11111111111111111111111111111')).success === false);

// ── the token ────────────────────────────────────────────────────────────────
DB.rows['news_bot_connection'] = { id: 'main', telegram_token: null, enabled: false };
DB.rows['bot_connection'] = { telegram_token: 'BUYBOT:TOKEN' };

check('a malformed token is refused before Telegram is called',
  (await call('news_save_token', { token: 'not-a-token' })).success === false);

TG = { ok: false, description: 'Unauthorized' };
check('a token TELEGRAM rejects is never stored',
  (await call('news_save_token', { token: '111:AAA' })).success === false && !DB.writes.some(w => w.table === 'news_bot_connection'),
  DB.writes);

TG = { ok: true, result: { username: 'TheEmojiNewsBot' } };
// ⛔⛔ the collision that would make both bots steal each other's commands
check('the BUY BOT\'s token is refused',
  (await call('news_save_token', { token: 'BUYBOT:TOKEN' })).success === false,
  await call('news_save_token', { token: 'BUYBOT:TOKEN' }));

DB.writes.length = 0;
const saved = await call('news_save_token', { token: '999:GOODTOKEN' });
check('a good token is saved WITH the username from getMe',
  saved.success && lastWrite().vals.telegram_token === '999:GOODTOKEN' && lastWrite().vals.bot_username === 'TheEmojiNewsBot',
  lastWrite());

// ── the token must not come back ─────────────────────────────────────────────
DB.rows['news_bot_connection'] = { id: 'main', telegram_token: '999:GOODTOKENabcdef', bot_username: 'TheEmojiNewsBot', enabled: true };
const conn = await call('news_get_connection');
check('get_connection MASKS the token', conn.data.has_token === true && !JSON.stringify(conn.data).includes('GOODTOKENabcdef'), conn.data);

// ── enabling ─────────────────────────────────────────────────────────────────
DB.rows['news_bot_connection'] = { id: 'main', telegram_token: null };
check('cannot go live with no token', (await call('news_set_enabled', { enabled: true })).success === false);
DB.rows['news_bot_connection'] = { id: 'main', telegram_token: '999:X' };
check('CAN go live once a token is saved', (await call('news_set_enabled', { enabled: true })).success === true);

// ── settings: the allow-list and the validators ──────────────────────────────
DB.rows['news_state'] = { config: { announce_articles: true, site_url: 'https://www.theemoji.lol', poll_seconds: 90 } };
DB.writes.length = 0;
await call('news_save_settings', { config: { announce_articles: false, evil_key: 'x', telegram_token: 'leak' } });
const cfg = lastWrite().vals.config;
check('a key outside the allow-list is dropped', !('evil_key' in cfg) && !('telegram_token' in cfg), cfg);
check('an allowed key is written', cfg.announce_articles === false, cfg);

check('a non-https site_url is refused',
  (await call('news_save_settings', { config: { site_url: 'javascript:alert(1)' } })).success === false);
check('a bare word site_url is refused',
  (await call('news_save_settings', { config: { site_url: 'theemoji.lol' } })).success === false);
DB.writes.length = 0;
await call('news_save_settings', { config: { site_url: 'https://www.theemoji.lol/' } });
check('a good site_url is kept, trailing slash trimmed', lastWrite().vals.config.site_url === 'https://www.theemoji.lol', lastWrite().vals.config);

DB.writes.length = 0;
await call('news_save_settings', { config: { poll_seconds: 1 } });
check('poll_seconds is floored at 30s (the egress guard)', lastWrite().vals.config.poll_seconds === 30, lastWrite().vals.config);
DB.writes.length = 0;
await call('news_save_settings', { config: { poll_seconds: 99999 } });
check('…and capped at an hour', lastWrite().vals.config.poll_seconds === 3600, lastWrite().vals.config);

// ── the test send ────────────────────────────────────────────────────────────
DB.rows['news_bot_connection'] = { telegram_token: '999:X' };
check('a test send with no chat id is refused', (await call('news_broadcast_test', {})).success === false);
tgCalls.length = 0;
TG = { ok: true, result: {} };
const t = await call('news_broadcast_test', { chat_id: '12345' });
check('a test send goes to exactly ONE chat', t.success && tgCalls.length === 1 && tgCalls[0].body.chat_id === '12345', tgCalls);

// ── ⭐ CONTROL ───────────────────────────────────────────────────────────────
// Most checks above assert a REFUSAL. Without this, an implementation that
// refused everything would score a clean sweep.
check('CONTROL: a legitimate settings save actually writes',
  (await call('news_save_settings', { config: { announce_builders: false } })).success === true);

rmSync(TMP, { force: true });
console.log(bad ? `\n❌ ${bad} failed` : '\n✅ all news-action checks passed');
process.exit(bad ? 1 : 0);
