-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  ROLLBACK for SUPABASE_RLS_HARDENING_2026-11-14.sql                      ║
-- ║  Restores the EXACT pre-hardening state measured on 2026-11-13:          ║
-- ║    anon UPDATE on nft_metadata, portfolio_snapshots, labwork_boosts,     ║
-- ║                  marketplace_stats                                       ║
-- ║    anon DELETE on all listed tables                                      ║
-- ║  Only run this if the hardening broke something. Tested in a local       ║
-- ║  PostgreSQL 16.2 harness: restores all 10 previously-successful attacks. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
do $$ declare t text; begin
  foreach t in array array[
    'nft_metadata','portfolio_snapshots','labwork_boosts','marketplace_stats',
    'burn_events','send_history','saved_addresses','labwork_points',
    'page_views','site_events','spotlight_images','announcements',
    'labwork_trades','nfa_acceptances'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('grant delete on public.%I to anon, authenticated', t);
      execute format('drop policy if exists %I on public.%I', t||'_anon_delete', t);
      execute format('create policy %I on public.%I for delete to anon, authenticated using (true)', t||'_anon_delete', t);
    end if;
  end loop;
  foreach t in array array['nft_metadata','portfolio_snapshots','labwork_boosts','marketplace_stats'] loop
    if to_regclass('public.'||t) is not null then
      execute format('grant update on public.%I to anon, authenticated', t);
      execute format('drop policy if exists %I on public.%I', t||'_anon_update', t);
      execute format('create policy %I on public.%I for update to anon, authenticated using (true) with check (true)', t||'_anon_update', t);
    end if;
  end loop;
end $$;
select tablename, cmd, policyname from pg_policies where schemaname='public' and cmd in ('UPDATE','DELETE') order by cmd, tablename;
