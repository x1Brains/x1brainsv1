-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  STEP 1 — INSPECT (read-only). ONE query on purpose: the Supabase SQL    ║
-- ║  editor only renders the LAST result set, so two selects would hide this ║
-- ║  one. Run it, then send me the output.                                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
select
  tablename,
  cmd,
  policyname,
  roles::text                    as granted_to,
  coalesce(qual, '-')            as using_clause,
  coalesce(with_check, '-')      as with_check_clause
from pg_policies
where schemaname = 'public'
order by
  case cmd when 'ALL' then 0 when 'DELETE' then 1 when 'UPDATE' then 2
           when 'INSERT' then 3 else 4 end,
  tablename, policyname;
