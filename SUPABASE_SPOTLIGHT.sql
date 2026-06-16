-- ═══════════════════════════════════════════════════════════════════════
-- spotlight_images — admin-curated promo images for the landing-page
-- spotlight carousel. These interleave with active boosted listings so the
-- showcase always has something to display (even with zero active boosts).
--
-- Writes happen ONLY through /api/admin (service role). Public anon read is
-- limited to active rows via RLS.
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists spotlight_images (
  id           uuid primary key default gen_random_uuid(),
  image_url    text not null,          -- public URL in the bot-banners bucket
  storage_path text,                   -- path inside the bucket (for deletes)
  link_url     text,                   -- optional: where clicking the slide goes
  caption      text,                   -- optional: short overlay text
  sort_order   int  default 0,
  active       boolean default true,
  created_at   timestamptz default now()
);

alter table spotlight_images enable row level security;

-- Public read of active images (the carousel). Idempotent re-create.
drop policy if exists "spotlight_public_read" on spotlight_images;
create policy "spotlight_public_read"
  on spotlight_images for select
  using (active = true);

-- No anon insert/update/delete policy on purpose — all writes go through the
-- service-role key in api/admin (Ed25519-gated).

create index if not exists spotlight_images_order_idx
  on spotlight_images (active, sort_order, created_at);
