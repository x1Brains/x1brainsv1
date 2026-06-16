# Supabase TODO · v2

Things v2 needs from Supabase that aren't covered by v1's `SUPABASE_SCHEMA.sql`, plus a checklist of what to verify against your existing v1 project.

---

## 1. Run NOW · Boost tables (NEW, missing entirely)

File: [`SUPABASE_SCHEMA_BOOSTS.sql`](./SUPABASE_SCHEMA_BOOSTS.sql)

**What:** `labwork_boosts` + `labwork_points` tables with the right `UNIQUE` constraints, indexes, and anon RLS policies.

**Why:** the boost flow on `/labwork` writes to these tables. V1 created them ad-hoc (they aren't in v1's documented `SUPABASE_SCHEMA.sql`), so the v1 project may or may not have them already.

**How:** Supabase Dashboard → SQL Editor → paste the file → Run. Idempotent (safe to re-run).

**Then:** re-attempt a boost; the modal should show `✅ Boost active …`, and the landing carousel should show `[carousel] boosts loaded: 1 matched: 1` in DevTools.

---

## 2. Verify · Tables v1 created ad-hoc

v1's `SUPABASE_SCHEMA.sql` only documents **4 tables** (`bot_connection`, `bot_settings`, `bot_state`, `nfa_acceptances`). But v1's code also references these — they were created manually in the Supabase dashboard at some point and never written down in version control. If you connected v2 to the same Supabase project (`xbchrxxfnzhsbpncfiar.supabase.co`), most of them already exist. The boost tables are the only confirmed gap so far.

| Table | Used by v2 | In v1? | Action |
|---|---|---|---|
| `bot_connection` | V2BotPanel | ✓ schema doc | none |
| `bot_settings` | V2BotPanel | ✓ schema doc | none |
| `announcements` | V2Admin | ✓ ad-hoc | confirm exists |
| `burn_events` | V2BurnHistory, ActivityLog | ✓ ad-hoc | confirm exists |
| `portfolio_snapshots` | V2Portfolio + cron-snapshot | ✓ ad-hoc | confirm exists |
| `saved_addresses` | V2Portfolio SendPanel | ✓ ad-hoc | confirm exists |
| `send_history` | V2Portfolio SendPanel | ✓ ad-hoc | confirm exists |
| `page_views` | V2AnalyticsPanel (admin) | ✓ ad-hoc | confirm exists |
| `site_events` | V2AnalyticsPanel (admin) | ✓ ad-hoc | confirm exists |
| `labwork_submissions` | (referenced, no v2 UI uses it) | ✓ ad-hoc | OK to leave |
| `labwork_rewards` | (referenced, no v2 UI uses it) | ✓ ad-hoc | OK to leave |
| `challenge_logs` | (rewards-season, retired in v2) | ✓ ad-hoc | OK to leave |
| `weekly_config` | (rewards-season, retired in v2) | ✓ ad-hoc | OK to leave |
| **`labwork_boosts`** | **V2BoostModal + V2Home carousel** | **ad-hoc** | **RUN BOOST SQL** |
| **`labwork_points`** | **V2BoostModal** | **ad-hoc** | **RUN BOOST SQL** |

**Quick way to verify a table exists** (Supabase SQL Editor):
```sql
select table_name from information_schema.tables
where table_schema = 'public'
order by table_name;
```

If anything in the "confirm exists" rows above is missing, ping me and I'll generate a `CREATE TABLE` for it.

---

## 3. Vercel env vars — copy from v1's project to v2's

Same Supabase project, but the v2 Vercel deployment needs its own copy of the env vars:

| Var | Where used | Source |
|---|---|---|
| `VITE_SUPABASE_URL` | client (anon reads) | same as v1 |
| `VITE_SUPABASE_ANON_KEY` | client (anon reads) | same as v1 |
| `SUPABASE_URL` | `api/*` serverless | same as v1 |
| `SUPABASE_SERVICE_KEY` | `api/*` serverless | same as v1 |
| `ADMIN_WALLETS` *(optional)* | `api/admin.ts` allowlist | comma-separated; defaults to `<council>,<v1-admin>` |
| `ALLOWED_ORIGINS` *(optional)* | `api/admin.ts` CORS | comma-separated; defaults to `https://x1brains.io,https://www.x1brains.io` |
| `CRON_SECRET` *(required for cron)* | `api/cron-snapshot.ts` auth | any random string; Vercel sends `Authorization: Bearer <secret>` |

**Note:** `CRON_SECRET` must be set for `/api/cron-snapshot` to run — default-deny if missing. Without it the daily portfolio snapshot won't fire and per-wallet history charts will only fill from manual saves.

---

## 4. RLS sanity check on ad-hoc tables

The boost SQL grants anon `SELECT/INSERT/UPDATE` because the on-chain burn is the actual access gate. If any of the other ad-hoc tables (announcements, burn_events, page_views, etc.) have stricter RLS that blocks anon writes, the matching v2 UI will silently fail (since most `lib/supabase.ts` helpers swallow errors with `catch {}`).

If something looks broken in v2 with no visible error:
1. Open DevTools console
2. Try the action again
3. Look for `[boosts]`-style warnings I've started adding in the helpers
4. If silent, check the relevant table's policies in Supabase Dashboard → Authentication → Policies

---

## 5. Restoring the lost boost (optional)

The user's first boost attempt burned BRAINS but never wrote to `labwork_boosts` (silent catch on missing table). If you want to surface it in the carousel anyway, after running the boost SQL:

```sql
insert into labwork_boosts
  (listing_pda, nft_mint, seller, tier, brains, labwork_points, tx_sig, expires_at)
values
  ('<listing_pda>', '<nft_mint>', '<your_wallet>', 'spark', 1000, 1888,
   '<tx_sig_from_explorer>',
   now() + interval '1 day');
```

Replace the angle-bracket values with the burn tx details and the listing PDA from `/labwork`. Adjust `tier` / `brains` / `labwork_points` / `interval` if you boosted a tier other than SPARK.

---

## TL;DR

1. Run `SUPABASE_SCHEMA_BOOSTS.sql` in Supabase.
2. Re-attempt a boost; should work end-to-end now.
3. (When deploying) copy env vars from v1's Vercel project; add `CRON_SECRET` for the daily snapshot.
4. If anything else looks broken in v2, open DevTools — error visibility was added to all the silent catches recently.
