-- ═══════════════════════════════════════════════════════════════════════════
--  ANALYTICS HARDENING — page_views + site_events
--  Run once in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  WHY
--  ---
--  Both tables accept unauthenticated INSERTs (that's by design — x1brains.io
--  and x1city.io are static SPAs writing with the anon key). But there was no
--  validation of any kind, and the table shows it was probed in 2026-03/04:
--
--      id=34   path  = '/ OR 1=1; DROP TABLE site_events;--'   (SQL injection)
--      id=35   label = 10,000 characters of 'A'                (payload flood)
--
--  The injection never executed — PostgREST parameterises, so it was stored as
--  literal text. The 10 KB payload DID get stored. With the project on the free
--  tier and its grace period over, an open unvalidated insert endpoint is a
--  direct route to exhausting quota, which stops the whole site serving — not
--  just analytics.
--
--  DESIGN CONSTRAINT: nothing legitimate may ever be blocked.
--  --------------------------------------------------------
--  So this deliberately does NOT use CHECK constraints — a CHECK REJECTS the
--  whole row, and both clients swallow insert errors, so a rejected row would
--  vanish silently. Instead a BEFORE INSERT trigger TRUNCATES over-long values.
--  Every insert still succeeds. Abusive payloads simply get clipped.
--
--  Caps are sized off the real data, measured 2026-08-02 across all 7,714
--  page_views and 30 site_events rows:
--
--      page_views   longest legitimate value of ANY column ... 39 chars
--      site_events  longest legitimate value of ANY column ... 35 chars
--
--  The caps below are 10-30x that. No real row is anywhere near them.
--
--  Reads are untouched. SELECT policies, INSERT policies, and the `site`
--  column all keep working exactly as they do now, for both sites.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Clamp function: page_views ─────────────────────────────────────────
create or replace function public.clamp_page_view()
returns trigger
language plpgsql
as $$
begin
  new.path       := left(new.path,       512);
  new.referrer   := left(new.referrer,   512);
  new.country    := left(new.country,    128);
  new.city       := left(new.city,       128);
  new.region     := left(new.region,     128);
  new.device     := left(new.device,      64);
  new.browser    := left(new.browser,     64);
  new.os         := left(new.os,          64);
  new.session_id := left(new.session_id,  64);
  new.site       := left(new.site,        32);
  return new;
end;
$$;

drop trigger if exists trg_clamp_page_view on public.page_views;
create trigger trg_clamp_page_view
  before insert or update on public.page_views
  for each row execute function public.clamp_page_view();


-- ── 2. Clamp function: site_events ────────────────────────────────────────
create or replace function public.clamp_site_event()
returns trigger
language plpgsql
as $$
begin
  new.session_id := left(new.session_id,  64);
  new.event_type := left(new.event_type,  64);
  new.category   := left(new.category,    64);
  new.label      := left(new.label,      512);
  new.value      := left(new.value,      128);
  new.path       := left(new.path,       512);
  new.site       := left(new.site,        32);
  return new;
end;
$$;

drop trigger if exists trg_clamp_site_event on public.site_events;
create trigger trg_clamp_site_event
  before insert or update on public.site_events
  for each row execute function public.clamp_site_event();


-- ── 3. Remove the junk rows ───────────────────────────────────────────────
--  Every site_events row before 2026-05-01 is synthetic: the tracker functions
--  were never wired to anything until 2026-08-02, so no genuine event could
--  have been recorded. Session ids on those rows are 'x', 'legit_session_abc'
--  and one probe session. The first real rows are ids 43/44/45 (wallet connect
--  from the council wallet, 2026-08-02).
--
--  Scoped by date so today's real rows cannot be caught.
delete from public.site_events where fired_at < '2026-05-01';

--  page_views is NOT purged — it holds 7,714 rows of genuine traffic.


-- ── 4. VERIFY ─────────────────────────────────────────────────────────────
--  Truncation works and nothing is rejected. Should return len_label = 512,
--  i.e. the 5,000-char payload was clipped rather than refused.
--
--     insert into public.site_events (session_id, event_type, category, label, path, fired_at)
--     values ('HARDENING_TEST', 'test', 'test', repeat('A', 5000), '/', now());
--
--     select id, length(label) as len_label from public.site_events
--      where session_id = 'HARDENING_TEST';
--
--     delete from public.site_events where session_id = 'HARDENING_TEST';


-- ═══════════════════════════════════════════════════════════════════════════
--  OPTIONAL — burst cap. NOT enabled by default.
-- ═══════════════════════════════════════════════════════════════════════════
--  This is the only piece that can drop a row, so it is left commented out.
--  Measured busiest legitimate minute: 11 rows (page_views), 3 rows
--  (site_events, real session). The 120/min threshold is ~10x that, so it
--  cannot fire on real traffic — but it does cap a single session's flood.
--
--  Caveat worth knowing before enabling: session_id is client-supplied, so an
--  attacker can rotate it and walk straight past this. It raises the cost of
--  lazy abuse; it is not a real rate limiter. Proper protection would be at
--  the edge (Cloudflare / Vercel middleware) on IP.
--
-- create or replace function public.cap_site_event_burst()
-- returns trigger language plpgsql as $$
-- declare recent int;
-- begin
--   select count(*) into recent
--     from public.site_events
--    where session_id = new.session_id
--      and fired_at > now() - interval '1 minute';
--   if recent >= 120 then
--     return null;   -- silently drop; never errors the client
--   end if;
--   return new;
-- end;
-- $$;
--
-- drop trigger if exists trg_cap_site_event_burst on public.site_events;
-- create trigger trg_cap_site_event_burst
--   before insert on public.site_events
--   for each row execute function public.cap_site_event_burst();
