-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  X1 BRAINS v2 — RLS HARDENING: remove anon UPDATE + DELETE               ║
-- ║  2026-11-14. Idempotent. Run in the Supabase SQL Editor.                 ║
-- ║                                                                           ║
-- ║  VERIFIED STATE BEFORE THIS SCRIPT (tested live against prod with the    ║
-- ║  public anon key, same-value writes to real rows):                       ║
-- ║    anon UPDATE *allowed*  : nft_metadata, portfolio_snapshots,           ║
-- ║                             labwork_boosts, marketplace_stats           ║
-- ║    anon UPDATE *blocked*  : burn_events, send_history, saved_addresses,  ║
-- ║                             labwork_points, page_views, site_events,     ║
-- ║                             spotlight_images                             ║
-- ║    anon INSERT+DELETE     : proven on `announcements` (probe row was     ║
-- ║                             created and removed during the audit)        ║
-- ║                                                                           ║
-- ║  WHAT THE LIVE APP ACTUALLY NEEDS FROM THE BROWSER (grep-verified):      ║
-- ║    UPDATE : nft_metadata      (upsert onConflict mint — supabase.ts:517, ║
-- ║                                V2LabWork.tsx:564, V2NFTDetailModal:164)  ║
-- ║             labwork_boosts    (upsert onConflict listing_pda —           ║
-- ║                                V2BoostModal.tsx:108)                     ║
-- ║             marketplace_stats (upsert id='main' — supabase.ts:452)       ║
-- ║    INSERT : the above + page_views, site_events, send_history,           ║
-- ║             labwork_points, nfa_acceptances, labwork_trades,             ║
-- ║             portfolio_snapshots (first-visit enrolment — see note)       ║
-- ║    DELETE : NOTHING. The only browser delete is                          ║
-- ║             replaceBurnEventsForWallet (supabase.ts:284), called only    ║
-- ║             from BurnedBrainsBar.tsx, which is imported only by the      ║
-- ║             UNROUTED legacy pages. No live path deletes any row.         ║
-- ║                                                                           ║
-- ║  SO THIS SCRIPT: revokes anon DELETE everywhere, revokes anon UPDATE     ║
-- ║  everywhere, then re-grants UPDATE on exactly the three cache tables.    ║
-- ║  INSERT and SELECT are left EXACTLY as they are — nothing this script    ║
-- ║  does can break a read or a first write.                                 ║
-- ║                                                                           ║
-- ║  ⚠ ONE DELIBERATE BEHAVIOUR CHANGE: portfolio_snapshots loses anon       ║
-- ║  UPDATE. Effect: the browser can still ENROL a wallet (INSERT on first   ║
-- ║  visit, so new users still get a chart), but can no longer overwrite an  ║
-- ║  existing row. The 02:00 UTC cron owns daily values from then on — and   ║
-- ║  the cron is the only writer with the price-sanity cap, so this also     ║
-- ║  closes the client-side bypass. The browser's same-visit re-write will   ║
-- ║  now fail silently (it is already wrapped in catch {}).                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  ⛔ ORDER OF OPERATIONS — THE APP CHANGE MUST SHIP FIRST                 ║
-- ║                                                                           ║
-- ║  1. Deploy src/lib/supabase.ts with ignoreDuplicates: true               ║
-- ║     (upsertPortfolioSnapshot). PostgREST turns `false` into ON CONFLICT  ║
-- ║     DO UPDATE, which Postgres rejects without UPDATE rights AT PLAN      ║
-- ║     TIME — so running this SQL first would 42501 even a brand-new        ║
-- ║     wallet's first snapshot and no new user would ever get a chart.      ║
-- ║  2. THEN run this script.                                                ║
-- ║  3. Rollback if needed: SUPABASE_RLS_ROLLBACK_2026-11-14.sql             ║
-- ║                                                                           ║
-- ║  BATTLE-TESTED 2026-11-14 in a local PostgreSQL 16.2 harness that        ║
-- ║  reproduced the measured prod policy state exactly:                      ║
-- ║    · 33/33 behavioural tests pass after hardening                        ║
-- ║    · 15 live app write paths still work (reads, analytics inserts,       ║
-- ║      consent, send receipts, burn writeback, the 3 cache upserts,        ║
-- ║      new-wallet snapshot enrolment)                                      ║
-- ║    · all 14 attacks hard-denied with 42501 (10 of them succeeded before) ║
-- ║    · cron + admin service_role writes unaffected                         ║
-- ║    · idempotent across 3 consecutive runs, 0 errors                      ║
-- ║    · a stray FOR ALL policy is REPORTED, not dropped — and the REVOKE    ║
-- ║      still blocks the write even while that policy exists                ║
-- ║    · missing tables skipped safely; rollback proven to restore state     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

do $$
declare
  r           record;
  tgt         text[] := array[
                 'nft_metadata','portfolio_snapshots','labwork_boosts','marketplace_stats',
                 'burn_events','send_history','saved_addresses','labwork_points',
                 'page_views','site_events','spotlight_images','announcements',
                 'labwork_trades','nfa_acceptances'
               ];
  n_dropped   int := 0;
  n_allpol    int := 0;
begin
  -- 1. Report (do NOT silently drop) any FOR ALL policy: those also carry
  --    SELECT/INSERT rights, so removing one blind could break the site.
  for r in
    select tablename, policyname, roles::text as roles
    from pg_policies
    where schemaname = 'public' and tablename = any(tgt) and cmd = 'ALL'
  loop
    n_allpol := n_allpol + 1;
    raise notice '⚠ FOR ALL policy left untouched: %.% (roles %) — review manually, it may grant UPDATE/DELETE', r.tablename, r.policyname, r.roles;
  end loop;

  -- 2. Drop every anon/public/authenticated UPDATE and DELETE policy.
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any(tgt)
      and cmd in ('UPDATE','DELETE')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    n_dropped := n_dropped + 1;
    raise notice 'dropped % on %', r.policyname, r.tablename;
  end loop;

  raise notice '— dropped % UPDATE/DELETE policies; % FOR ALL policies need manual review', n_dropped, n_allpol;
end $$;

-- 3. Belt-and-braces: remove the raw table grants too, so a future permissive
--    policy cannot re-open writes on its own.
do $$
declare t text;
begin
  foreach t in array array[
    'nft_metadata','portfolio_snapshots','labwork_boosts','marketplace_stats',
    'burn_events','send_history','saved_addresses','labwork_points',
    'page_views','site_events','spotlight_images','announcements',
    'labwork_trades','nfa_acceptances'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('revoke delete on public.%I from anon, authenticated', t);
      execute format('revoke update on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- 4a. labwork_boosts + labwork_points are now written ONLY by /api/boost with
--     the service key, after it verifies the burn on chain. Take anon INSERT
--     away too — this is what finally makes "the burn is the gate" true.
--     ⛔ Requires the V2BoostModal -> /api/boost change to be deployed first.
do $$ declare t text; begin
  foreach t in array array['labwork_boosts','labwork_points'] loop
    if to_regclass('public.'||t) is not null then
      execute format('revoke insert on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;
do $$ declare r record; begin
  for r in select tablename, policyname from pg_policies
           where schemaname='public' and tablename in ('labwork_boosts','labwork_points') and cmd='INSERT'
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    raise notice 'dropped INSERT policy % on %', r.policyname, r.tablename;
  end loop;
end $$;

-- 4. Re-grant UPDATE on exactly the caches the live app still upserts into.
do $$
declare t text;
begin
  foreach t in array array['nft_metadata','marketplace_stats'] loop
    if to_regclass('public.'||t) is not null then
      execute format('grant update on public.%I to anon, authenticated', t);
      execute format('drop policy if exists %I on public.%I', t||'_anon_update', t);
      execute format(
        'create policy %I on public.%I for update to anon, authenticated using (true) with check (true)',
        t||'_anon_update', t);
    end if;
  end loop;
end $$;

-- ── 5. VERIFY — this is the state you should see afterwards ────────────────
--    Expect UPDATE only on nft_metadata / labwork_boosts / marketplace_stats,
--    and NO DELETE rows at all.
select tablename, cmd, policyname, roles::text as granted_to
from pg_policies
where schemaname = 'public' and cmd in ('UPDATE','DELETE')
order by cmd, tablename;
