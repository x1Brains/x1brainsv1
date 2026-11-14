-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  STEP 3 — close the NFT image-poisoning hole                             ║
-- ║                                                                           ║
-- ║  Safe to run NOW: commit 67527db is deployed and verified live. The       ║
-- ║  browser no longer writes nft_metadata at all — POST /api/nft-meta owns   ║
-- ║  it, writing with the service key after resolving from the chain and the  ║
-- ║  token's own metadata URI. Verified on prod: a 40-NFT batch answers in    ║
-- ║  0.34-0.49s.                                                              ║
-- ║                                                                           ║
-- ║  Until this runs, anyone with the public anon key can still rewrite any   ║
-- ║  mint's `image` to any URL, and it renders on every visitor's NFT card.   ║
-- ║                                                                           ║
-- ║  Reads stay open (the site and the endpoint both read this table).        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
do $$
declare r record;
begin
  -- drop only PERMISSIVE write policies; never touch a RESTRICTIVE one
  for r in
    select policyname, cmd from pg_policies
    where schemaname = 'public' and tablename = 'nft_metadata'
      and cmd in ('INSERT','UPDATE','DELETE','ALL') and permissive = 'PERMISSIVE'
  loop
    execute format('drop policy if exists %I on public.nft_metadata', r.policyname);
    raise notice 'dropped % policy % on nft_metadata', r.cmd, r.policyname;
  end loop;

  revoke insert, update, delete on public.nft_metadata from anon, authenticated, public;
  raise notice 'anon/authenticated/public can no longer write nft_metadata';
end $$;

-- Verify: expect ONLY a SELECT policy to remain.
select cmd, permissive, policyname, roles::text as granted_to
from pg_policies
where schemaname = 'public' and tablename = 'nft_metadata'
order by cmd;
