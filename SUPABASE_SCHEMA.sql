-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  X1 BRAINS BUY BOT — SUPABASE SCHEMA                                     ║
-- ║                                                                           ║
-- ║  Paste this entire file into the Supabase SQL Editor and click Run.      ║
-- ║  Idempotent — safe to run multiple times.                                ║
-- ║                                                                           ║
-- ║  Creates:                                                                 ║
-- ║   - bot_connection (telegram token + chat + pool vaults — singleton row) ║
-- ║   - bot_settings   (event toggles + thresholds — singleton row)          ║
-- ║   - bot_state      (per-account last-seen tx signatures)                 ║
-- ║   - bot-banners    (storage bucket for banner images)                    ║
-- ║                                                                           ║
-- ║  Security model:                                                          ║
-- ║   - All tables have RLS enabled                                          ║
-- ║   - Anon key (browser): NO access at all                                 ║
-- ║   - Service role key (your /api/admin proxy + the bot host): full access║
-- ║                                                                           ║
-- ║  This means the Telegram token is NEVER exposed to the browser, even if  ║
-- ║  someone reverse-engineers your Vercel bundle.                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. CONNECTION (singleton — there's always exactly one row, id='main')
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists bot_connection (
  id                  text primary key default 'main',
  telegram_token      text,            -- never returned to browser by /api/admin
  chat_id             text,
  chat_title          text,
  vault_brains_token  text,
  vault_brains_quote  text,
  vault_lb_token      text,
  vault_lb_quote      text,
  updated_at          timestamptz not null default now()
);

-- Seed the singleton row if missing
insert into bot_connection (id) values ('main')
  on conflict (id) do nothing;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. SETTINGS (singleton — id='main', config is JSONB so we can add fields freely)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists bot_settings (
  id          text primary key default 'main',
  config      jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Seed defaults if missing
insert into bot_settings (id, config) values ('main', jsonb_build_object(
  -- BRAINS event toggles
  'brains_buys',    true,
  'brains_burns',   true,
  'brains_lp',      true,
  'brains_stake',   true,
  'brains_unstake', true,
  'brains_claim',   true,
  -- LB event toggles
  'lb_buys',    true,
  'lb_burns',   true,
  'lb_lp',      true,
  'lb_stake',   true,
  'lb_unstake', true,
  'lb_claim',   true,
  -- Thresholds
  'min_buy_usd',     5.0,
  'min_burn_tokens', 1.0,
  'min_lp_usd',      1.0,
  'min_stake_lp',    0.0,
  'min_claim_usd',   1.0,
  'tier_big_usd',   100.0,
  'tier_whale_usd', 1000.0
)) on conflict (id) do nothing;

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. STATE (per-account last-seen signatures — bot writes this, no UI access)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists bot_state (
  account     text primary key,
  last_sig    text,
  updated_at  timestamptz not null default now()
);

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY — deny everything to anon, service role bypasses RLS
-- ──────────────────────────────────────────────────────────────────────────────
alter table bot_connection enable row level security;
alter table bot_settings   enable row level security;
alter table bot_state      enable row level security;

-- No policies = no access for anon/authenticated roles. Only service role
-- (which bypasses RLS by design) can read/write.

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. STORAGE BUCKET FOR BANNER IMAGES
-- ──────────────────────────────────────────────────────────────────────────────
-- Run this manually in the Supabase Dashboard if the function isn't available
-- in your project: Storage → New bucket → name "bot-banners" → public ON

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bot-banners',
  'bot-banners',
  true,                                                       -- public read so the bot can fetch banners directly
  5242880,                                                    -- 5 MB max
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
) on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Storage RLS: only service role can upload/delete. Public read is fine
-- because banners are meant to be sent to a public TG group anyway.
-- NOTE: Postgres doesn't support `CREATE POLICY IF NOT EXISTS` on Supabase's
-- PG version, so we drop-then-create to keep this script idempotent.
drop policy if exists "service role full access on bot-banners" on storage.objects;
create policy "service role full access on bot-banners"
  on storage.objects for all
  to service_role
  using (bucket_id = 'bot-banners')
  with check (bucket_id = 'bot-banners');

drop policy if exists "public read on bot-banners" on storage.objects;
create policy "public read on bot-banners"
  on storage.objects for select
  to public
  using (bucket_id = 'bot-banners');

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. updated_at TRIGGERS (cosmetic — keeps updated_at fresh on writes)
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function bot_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_bot_connection_updated on bot_connection;
create trigger trg_bot_connection_updated
  before update on bot_connection
  for each row execute function bot_set_updated_at();

drop trigger if exists trg_bot_settings_updated on bot_settings;
create trigger trg_bot_settings_updated
  before update on bot_settings
  for each row execute function bot_set_updated_at();

drop trigger if exists trg_bot_state_updated on bot_state;
create trigger trg_bot_state_updated
  before update on bot_state
  for each row execute function bot_set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────────
-- 7. NFA ACCEPTANCE LOG — durable record of users who accepted the NFA modal
-- ──────────────────────────────────────────────────────────────────────────────
-- Each row is one click of the "I ACCEPT" button on the NFA consent modal.
-- The modal is shown on Home / LP Farms / LabWork / LabWork DeFi pages and
-- INSERTs here via the anon-key Supabase client.
--
-- RLS: anon can ONLY insert; cannot read, update, or delete. Service role
-- (admin proxy) can read for legal/audit purposes. This means:
--   - Public clients can append acceptances but never see anyone else's
--   - Admin can pull the full ledger for evidence in a dispute
--
-- Bumping the modal's NFA_VERSION constant on the frontend invalidates prior
-- acceptances client-side; the on-chain (here in pg) record stays forever.

create table if not exists nfa_acceptances (
  id           uuid primary key default gen_random_uuid(),
  version      text not null,                        -- e.g. '1.0' — matches frontend NFA_VERSION
  page         text not null,                        -- 'home' | 'lpfarms' | 'labwork' | 'labworkdefi' (window.location.pathname based)
  wallet       text,                                 -- base58 pubkey if a wallet is connected at accept time, else null
  user_agent   text,                                 -- raw navigator.userAgent — useful for fingerprinting in disputes
  accepted_at  timestamptz not null default now(),   -- server-truth timestamp; the modal also sends a client ts but server wins
  created_at   timestamptz not null default now()
);

create index if not exists idx_nfa_wallet  on nfa_acceptances(wallet) where wallet is not null;
create index if not exists idx_nfa_created on nfa_acceptances(created_at desc);
create index if not exists idx_nfa_version on nfa_acceptances(version);

alter table nfa_acceptances enable row level security;

-- Anon: insert only. Cannot read other users' acceptances.
drop policy if exists "anon insert nfa acceptance" on nfa_acceptances;
create policy "anon insert nfa acceptance"
  on nfa_acceptances for insert
  to anon
  with check (
    -- Defensive guard: enforce sane payload shape to prevent abuse via the
    -- public anon key. Version + page + user_agent are required and must
    -- be reasonably-sized strings; wallet is optional.
    char_length(version)    between 1 and 16
    and char_length(page)   between 1 and 64
    and char_length(coalesce(user_agent, '')) between 0 and 1024
    and char_length(coalesce(wallet, ''))     between 0 and 64
  );

-- Service role (admin / cron) can read the full audit log. Already implicit
-- via service-role RLS bypass, but a policy is documented here for clarity.
drop policy if exists "service role read nfa acceptances" on nfa_acceptances;
create policy "service role read nfa acceptances"
  on nfa_acceptances for select
  to service_role
  using (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- DONE. Verify with:
--   select * from bot_connection;     -- should show 1 row, all NULLs except id
--   select * from bot_settings;       -- should show 1 row with default config
--   select id from storage.buckets where id='bot-banners';
--   select count(*) from nfa_acceptances;          -- ledger row count
--   select wallet, count(*) from nfa_acceptances group by wallet order by 2 desc limit 20;
-- ──────────────────────────────────────────────────────────────────────────────
