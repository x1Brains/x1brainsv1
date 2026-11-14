-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  STEP 4 — the last anon-writable table                                   ║
-- ║                                                                           ║
-- ║  Safe to run NOW. The browser no longer writes marketplace_stats: the     ║
-- ║  chain scan moved to GET /api/market-stats (commit d777785), which is     ║
-- ║  deployed and verified live returning volumeXnt 103.999 / salesCount 14   ║
-- ║  with scanned=false, i.e. it correctly skipped the rescan.                ║
-- ║                                                                           ║
-- ║  Until this runs, anyone with the public anon key can set the site-wide   ║
-- ║  VOLUME and SALES headline to anything they like.                         ║
-- ║                                                                           ║
-- ║  Reads stay open — the landing page and /labwork both read this row.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
do $$
declare r record;
begin
  for r in
    select policyname, cmd from pg_policies
    where schemaname = 'public' and tablename = 'marketplace_stats'
      and cmd in ('INSERT','UPDATE','DELETE','ALL') and permissive = 'PERMISSIVE'
  loop
    execute format('drop policy if exists %I on public.marketplace_stats', r.policyname);
    raise notice 'dropped % policy % on marketplace_stats', r.cmd, r.policyname;
  end loop;

  revoke insert, update, delete on public.marketplace_stats from anon, authenticated, public;
  raise notice 'anon/authenticated/public can no longer write marketplace_stats';
end $$;

-- Verify: expect ONLY a SELECT policy to remain.
select cmd, permissive, policyname, roles::text as granted_to
from pg_policies
where schemaname = 'public' and tablename = 'marketplace_stats'
order by cmd;
