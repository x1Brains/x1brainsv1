-- ═══════════════════════════════════════════════════════════════════
-- NFT METADATA CACHE  (shared, app-level indexer)
-- ═══════════════════════════════════════════════════════════════════
-- Why: v2 resolves every NFT's image + traits at view-time by fetching the
-- per-NFT metadata JSON through flaky public CORS proxies (corsproxy.io,
-- allorigins) plus Solaris as a fallback. That's slow and re-done per visitor.
-- This table is a write-through cache keyed by mint: the FIRST viewer who
-- resolves an NFT writes {image, attributes, …} here, and every later visitor
-- loads it instantly from Supabase — no proxy round-trips.
--
-- RLS: anon read + anon insert/update (same trust model as labwork_boosts /
-- marketplace_stats — it's public, derived, non-sensitive metadata).
--
-- Run once in the Supabase SQL editor.

create table if not exists public.nft_metadata (
  mint         text primary key,
  name         text,
  symbol       text,
  image        text,
  description  text,
  external_url text,
  collection   text,
  attributes   jsonb,
  updated_at   timestamptz not null default now()
);

alter table public.nft_metadata enable row level security;

-- Idempotent policy (re)creation.
drop policy if exists "nft_metadata anon read"   on public.nft_metadata;
drop policy if exists "nft_metadata anon insert" on public.nft_metadata;
drop policy if exists "nft_metadata anon update" on public.nft_metadata;

create policy "nft_metadata anon read"   on public.nft_metadata for select using (true);
create policy "nft_metadata anon insert" on public.nft_metadata for insert with check (true);
create policy "nft_metadata anon update" on public.nft_metadata for update using (true) with check (true);
