-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE EMOJI NEWS NOTIFIER — SUPABASE SCHEMA                               ║
-- ║                                                                          ║
-- ║  Paste into the Supabase SQL Editor and Run. Idempotent.                 ║
-- ║                                                                          ║
-- ║  This is the SECOND bot in this database. The buy bot (SUPABASE_SCHEMA   ║
-- ║  .sql) broadcasts on-chain events to ONE group it is configured with.    ║
-- ║  This one is the other shape: MANY subscribers, each with their own      ║
-- ║  topic switches, who add the bot themselves. Nothing here touches the    ║
-- ║  buy bot's tables.                                                       ║
-- ║                                                                          ║
-- ║  Same security model: RLS on, no policies, so the anon key the browser   ║
-- ║  carries has NO access at all. Only the service role — the /api/admin    ║
-- ║  proxy and the Fly host — can read or write. The Telegram token never    ║
-- ║  reaches a browser.                                                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. CONNECTION — this bot's own Telegram identity (singleton, id='main')
-- ──────────────────────────────────────────────────────────────────────────────
-- ⛔ A SEPARATE ROW FROM THE BUY BOT'S, AND A SEPARATE @HANDLE. Readers of THE
--    EMOJI subscribe by messaging this bot directly; they should not be DMing
--    something called "X1 Brains bot". One Fly machine runs both — this is two
--    identities, not two servers.
create table if not exists news_bot_connection (
  id              text primary key default 'main',
  telegram_token  text,          -- never returned to the browser un-masked
  bot_username    text,          -- filled in by getMe when the token is saved
  enabled         boolean not null default false,
  updated_at      timestamptz not null default now()
);
insert into news_bot_connection (id) values ('main') on conflict (id) do nothing;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. SUBSCRIBERS — one row per chat that asked for the news
-- ──────────────────────────────────────────────────────────────────────────────
-- `topics` is jsonb so a fourth section can be added later without a migration,
-- exactly like the buy bot's settings blob.
-- ⛔ `active` rather than DELETE on /stop: someone who unsubscribes and comes
--    back should not look like a brand-new chat, and a row that vanishes takes
--    its topic choices with it.
create table if not exists news_subs (
  chat_id     text primary key,
  chat_type   text,                      -- private | group | supergroup | channel
  chat_title  text,
  topics      jsonb   not null default '{"news":true,"projects":true,"builders":true}'::jsonb,
  active      boolean not null default true,
  blocked_at  timestamptz,               -- set when Telegram says the bot was blocked/kicked
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists news_subs_active_idx on news_subs (active) where active;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. WHAT HAS ALREADY BEEN ANNOUNCED — keyed by ROW ID, never by timestamp
-- ──────────────────────────────────────────────────────────────────────────────
-- ⛔⛔ THIS IS THE TABLE THAT STOPS THE BOT SPAMMING ITS OWN SUBSCRIBERS. The
--    obvious design is a high-water mark on `created_at`: post everything newer
--    than the last thing you posted. It is wrong here, and measurably so —
--    every row in desk_articles, desk_projects, desk_builders and desk_slides
--    currently shares ONE created_at, 2026-09-02T03:02:00.231005, because the
--    tables were seeded in a single statement. Re-run the Office's "Export
--    migration SQL" and every article gets a fresh stamp at once, and a
--    watermark bot would broadcast the entire back catalogue to everybody.
--    An id has none of that behaviour: it is the slug, it IS the route, and it
--    is stable across edits, re-seeds and restores.
create table if not exists news_seen (
  kind     text not null,                -- article | project | builder
  row_id   text not null,
  seen_at  timestamptz not null default now(),
  primary key (kind, row_id)
);

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. STATE — the Telegram update cursor and global config (singleton)
-- ──────────────────────────────────────────────────────────────────────────────
-- ⛔ `update_offset` MUST persist. Telegram holds undelivered updates for 24
--    hours and replays them from the last un-acknowledged id; an offset kept
--    only in RAM means every restart re-processes a day of /start commands and
--    re-sends a day of welcome messages.
create table if not exists news_state (
  id             text primary key default 'main',
  update_offset  bigint not null default 0,
  config         jsonb  not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);
insert into news_state (id, config) values ('main', jsonb_build_object(
  -- master switches: what the desk announces AT ALL, regardless of a
  -- subscriber's own topic choices
  'announce_articles', true,
  'announce_projects', true,
  'announce_builders', true,
  -- where the links point. ⛔ www, not the apex: both apex domains 308 to www,
  -- and a redirect costs the unfurler a round trip before it sees the card.
  'site_url',          'https://www.theemoji.lol',
  -- seconds between desk polls. ⛔ Kept deliberately slow. The buy bot blew
  -- this project's Supabase egress quota by re-reading config every 5s; the
  -- desk publishes a few times a day and does not need better than a minute.
  'poll_seconds',      90
)) on conflict (id) do nothing;

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. ROW LEVEL SECURITY — deny anon entirely; service role bypasses RLS
-- ──────────────────────────────────────────────────────────────────────────────
alter table news_bot_connection enable row level security;
alter table news_subs           enable row level security;
alter table news_seen           enable row level security;
alter table news_state          enable row level security;
-- No policies, deliberately. A subscriber list is personal data — the chat ids
-- of everyone reading the paper — and the browser has no business holding it.

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. FIRST-RUN SEED — mark everything already published as ALREADY ANNOUNCED
-- ──────────────────────────────────────────────────────────────────────────────
-- ⛔⛔ WITHOUT THIS THE FIRST POLL IS AN AVALANCHE. The desk already holds 8
--    articles, 13 projects and a builder; all of them are "unseen" to a fresh
--    news_seen table, so the first subscriber would receive 22 messages in a
--    row and block the bot. The chain bot seeds its last-signature the same way
--    on first run, for the same reason.
-- ⭐ Safe to re-run: `on conflict do nothing` means anything already announced
--    keeps its original seen_at, and anything published between now and the
--    bot's first cycle is simply picked up as new.
insert into news_seen (kind, row_id)
  select 'article', id from desk_articles
  union all select 'project', id from desk_projects
  union all select 'builder', id from desk_builders
on conflict (kind, row_id) do nothing;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- select * from news_bot_connection;                    -- 1 row, token null
-- select count(*) from news_seen;                       -- 22 right now
-- select count(*) from news_subs where active;          -- 0 until someone /starts
