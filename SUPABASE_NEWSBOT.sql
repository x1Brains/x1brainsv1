-- THE EMOJI NEWS NOTIFIER - SUPABASE SCHEMA
--
-- Paste into the Supabase SQL Editor and Run. Safe to run more than once.
--
-- This is the SECOND bot in this database. The buy bot (SUPABASE_SCHEMA.sql)
-- broadcasts on-chain events to ONE group. This one is the other shape: MANY
-- subscribers, each with their own topic switches. Nothing here touches the
-- buy bot's tables.
--
-- RLS is on with no policies, so the anon key the browser carries has no
-- access at all. Only the service role - the /api/admin proxy and the Fly
-- host - can read or write. The Telegram token never reaches a browser.
--
-- The full rationale for each table is in NEWSBOT.md. This file is kept
-- plain ASCII with short lines on purpose: box-drawing characters and long
-- comment lines get mangled in transit and arrive without their "--" prefix,
-- which is a syntax error at the SQL editor.

-- 1. CONNECTION - this bot's own Telegram identity (singleton, id='main')
-- A separate row from the buy bot's, and a separate @handle. Telegram gives
-- each update to whoever calls getUpdates first, so a shared token would make
-- the two bots steal each other's commands.
create table if not exists news_bot_connection (
  id              text primary key default 'main',
  telegram_token  text,
  bot_username    text,
  enabled         boolean not null default false,
  updated_at      timestamptz not null default now()
);

insert into news_bot_connection (id) values ('main')
  on conflict (id) do nothing;

-- 2. SUBSCRIBERS - one row per chat that asked for the news
-- topics is jsonb so a fourth section can be added later with no migration.
-- /stop sets active = false rather than deleting: someone who unsubscribes
-- and comes back should keep the topic choices they made.
create table if not exists news_subs (
  chat_id     text primary key,
  chat_type   text,
  chat_title  text,
  topics      jsonb   not null default '{"news":true,"projects":true,"builders":true}'::jsonb,
  active      boolean not null default true,
  blocked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists news_subs_active_idx
  on news_subs (active) where active;

-- 3. WHAT HAS ALREADY BEEN ANNOUNCED - keyed by row id, never by timestamp
-- This is the table that stops the bot spamming its own subscribers. A
-- high-water mark on created_at would be wrong here: every row in every desk
-- table currently shares ONE created_at, because the tables were seeded in a
-- single statement. Re-run the Office's "Export migration SQL" and a
-- watermark bot would broadcast the entire back catalogue to everybody.
create table if not exists news_seen (
  kind     text not null,
  row_id   text not null,
  seen_at  timestamptz not null default now(),
  primary key (kind, row_id)
);

-- 4. STATE - the Telegram update cursor and global config (singleton)
-- update_offset must persist. Telegram holds undelivered updates for 24 hours
-- and replays them from the last un-acknowledged id, so an offset kept only in
-- RAM means every restart re-sends a day of welcome messages.
create table if not exists news_state (
  id             text primary key default 'main',
  update_offset  bigint not null default 0,
  config         jsonb  not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

-- site_url is www, not the apex: both apex domains 308 to www, and a redirect
-- costs the unfurler a round trip before it sees the card.
-- poll_seconds is deliberately slow. The buy bot burned this project's
-- Supabase egress quota by re-reading config every 5 seconds; the desk
-- publishes a few times a day.
insert into news_state (id, config) values ('main', jsonb_build_object(
  'announce_articles', true,
  'announce_projects', true,
  'announce_builders', true,
  'site_url',          'https://www.theemoji.lol',
  'poll_seconds',      90
)) on conflict (id) do nothing;

-- 5. ROW LEVEL SECURITY - deny anon entirely; service role bypasses RLS
-- No policies, deliberately. A subscriber list is the chat ids of everyone
-- reading the paper, and the browser has no business holding it.
alter table news_bot_connection enable row level security;
alter table news_subs           enable row level security;
alter table news_seen           enable row level security;
alter table news_state          enable row level security;

-- 6. FIRST-RUN SEED - mark everything already published as already announced
-- Without this the first poll is an avalanche: every existing article,
-- project and builder is "unseen" to a fresh news_seen table, so the first
-- subscriber would get them all in a row and block the bot.
-- Safe to re-run: on conflict do nothing keeps the original seen_at.
insert into news_seen (kind, row_id)
  select 'article', id from desk_articles
  union all
  select 'project', id from desk_projects
  union all
  select 'builder', id from desk_builders
on conflict (kind, row_id) do nothing;

-- Verify:
--   select * from news_bot_connection;
--   select count(*) from news_seen;
--   select count(*) from news_subs where active;
