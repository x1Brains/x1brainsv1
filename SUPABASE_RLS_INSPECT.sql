-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  STEP 1 — INSPECT (read-only). Run this FIRST, paste the output back.    ║
-- ║  Changes nothing. Shows exactly which policies exist today.              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
select
  tablename,
  policyname,
  cmd,
  roles::text                           as granted_to,
  coalesce(qual, '(none)')              as using_clause,
  coalesce(with_check, '(none)')        as with_check_clause
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

-- Any table with RLS OFF entirely (nothing below should be 'f' except views):
select relname as table_name, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by relname;
