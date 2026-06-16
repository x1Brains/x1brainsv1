-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  X1 BRAINS — BOOST + LABWORK POINTS SCHEMA                               ║
-- ║                                                                           ║
-- ║  Run this once in the Supabase SQL Editor.                               ║
-- ║  Idempotent — safe to run multiple times.                                ║
-- ║                                                                           ║
-- ║  Creates:                                                                 ║
-- ║   - labwork_boosts  (3-slot featured carousel on the landing page)       ║
-- ║   - labwork_points  (boost-earned points per burn tx)                    ║
-- ║                                                                           ║
-- ║  RLS: anon key (browser) can SELECT + INSERT + UPDATE on both tables.    ║
-- ║  The boost flow runs entirely client-side via @solana/spl-token burnIx + ║
-- ║  supabase anon client — no service-role bridge required.                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. LABWORK_BOOSTS — one row per (currently or previously) boosted listing.
--    listing_pda is UNIQUE because there can only ever be one active boost per
--    listing at a time (the V2BoostModal upserts on this column to replace an
--    expired boost when the same listing gets boosted again).
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists labwork_boosts (
  id              uuid primary key default gen_random_uuid(),
  listing_pda     text not null unique,
  nft_mint        text not null,
  seller          text not null,
  tier            text not null check (tier in ('spark','godslayer','incinerator')),
  brains          numeric not null,
  labwork_points  numeric not null,
  tx_sig          text not null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);

-- Fast filter by expires_at (active vs expired) + tier sort.
create index if not exists labwork_boosts_active_idx
  on labwork_boosts (expires_at desc, tier desc, created_at asc);

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. LABWORK_POINTS — append-only points ledger (one row per qualifying burn).
--    tx_sig is UNIQUE so the same on-chain burn can't double-credit if the
--    save retries.
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists labwork_points (
  id             uuid primary key default gen_random_uuid(),
  wallet         text not null,
  brains_burned  numeric not null,
  points         numeric not null,
  source         text not null,                -- e.g. 'boost'
  tier           text,                          -- nullable (only set for boost source)
  tx_sig         text not null unique,
  earned_at      timestamptz not null default now()
);

create index if not exists labwork_points_wallet_idx
  on labwork_points (wallet, earned_at desc);

-- ──────────────────────────────────────────────────────────────────────────────
-- RLS — anon (browser) read + write. Boost mechanics are intentionally public
-- because all writes are gated by an on-chain BRAINS burn that's verifiable.
-- ──────────────────────────────────────────────────────────────────────────────
alter table labwork_boosts enable row level security;
alter table labwork_points enable row level security;

-- Boosts: anyone can read; anyone can insert/update (burn is the gate)
drop policy if exists labwork_boosts_select on labwork_boosts;
create policy labwork_boosts_select on labwork_boosts for select to anon, authenticated using (true);

drop policy if exists labwork_boosts_insert on labwork_boosts;
create policy labwork_boosts_insert on labwork_boosts for insert to anon, authenticated with check (true);

drop policy if exists labwork_boosts_update on labwork_boosts;
create policy labwork_boosts_update on labwork_boosts for update to anon, authenticated using (true) with check (true);

-- Points: same — public read/write, on-chain burn is the gate
drop policy if exists labwork_points_select on labwork_points;
create policy labwork_points_select on labwork_points for select to anon, authenticated using (true);

drop policy if exists labwork_points_insert on labwork_points;
create policy labwork_points_insert on labwork_points for insert to anon, authenticated with check (true);

drop policy if exists labwork_points_update on labwork_points;
create policy labwork_points_update on labwork_points for update to anon, authenticated using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- Done. After running:
--   1. Re-attempt a boost from /labwork
--   2. The modal should now show "✅ Boost active · ... · 1d featured"
--   3. Visit / (landing) — the boosted NFT should appear in the showcase
--   4. Confirm in DevTools console: [carousel] boosts loaded: 1 matched: 1
-- ──────────────────────────────────────────────────────────────────────────────
