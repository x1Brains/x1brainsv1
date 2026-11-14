-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  STEP 1b — the one column the first query missed: PERMISSIVE vs          ║
-- ║  RESTRICTIVE. A permissive `using false` policy does nothing (they OR    ║
-- ║  together); a RESTRICTIVE one is what actually blocks (they AND).        ║
-- ║  Read-only. Run it and send the output.                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
select
  tablename,
  cmd,
  permissive,                                   -- PERMISSIVE | RESTRICTIVE
  policyname,
  roles::text as granted_to,
  coalesce(qual,'-') as using_clause
from pg_policies
where schemaname = 'public'
  and (cmd in ('ALL','UPDATE','DELETE') or permissive = 'RESTRICTIVE')
order by permissive, cmd, tablename, policyname;
