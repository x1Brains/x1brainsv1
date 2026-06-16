-- ═══════════════════════════════════════════════════════════════════════
-- marketplace_stats — server-side cache of NFT-marketplace volume so the
-- landing loads the number INSTANTLY from Supabase (shared across all
-- visitors) instead of every browser re-scanning the chain. The client only
-- re-scans + re-writes this row when a NEW platform-wallet signature appears
-- (i.e. a new sale/listing/cancel), keyed by last_sig.
--
-- Single row, id = 'main'. Public read; anon write is fine — the value is
-- derived from public on-chain data and self-corrects on the next scan.
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists marketplace_stats (
  id           text primary key default 'main',
  volume_xnt   double precision not null default 0,  -- gross all-time NFT sales volume (XNT)
  sales_count  int              not null default 0,
  biggest_sale jsonb,                                 -- { priceXnt, sig, timestamp }
  last_sig     text,                                  -- newest platform-wallet sig at last scan
  updated_at   timestamptz default now()
);

alter table marketplace_stats enable row level security;

drop policy if exists marketplace_stats_read   on marketplace_stats;
drop policy if exists marketplace_stats_insert on marketplace_stats;
drop policy if exists marketplace_stats_update on marketplace_stats;
create policy marketplace_stats_read   on marketplace_stats for select to anon, authenticated using (true);
create policy marketplace_stats_insert on marketplace_stats for insert to anon, authenticated with check (true);
create policy marketplace_stats_update on marketplace_stats for update to anon, authenticated using (true) with check (true);

-- seed the row so the first read returns something immediately
insert into marketplace_stats (id) values ('main') on conflict (id) do nothing;
