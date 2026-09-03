# 😂 THE EMOJI — News Notifier

A second Telegram bot, in the **same Fly machine** and the **same Supabase project** as the buy bot, and the opposite shape to it.

| | buy bot | news notifier |
|---|---|---|
| watches | the chain (X1 RPC) | the desk (`desk_articles`, `desk_projects`, `desk_builders`) |
| sends to | **one** group you configured | **many** chats that subscribed themselves |
| listens for commands | no | yes — `/start`, `/settings`, `/stop`, `/help` |
| Telegram identity | `@x1brains…` | its own handle from @BotFather |

Anyone can add it. Each subscriber picks which sections they want.

**In a group, only administrators can change anything.** `/start`, `/stop`, `/settings` and the toggle buttons are all admin-only there, because each of them changes what everybody in the group receives — and the symptom of a member switching it off is silence, which reads as the bot being broken rather than as somebody having turned it off. `/help` stays open to everyone. A private chat is not gated: the only person who can change your subscription is you.

---

## Why it is one machine and two handles

**One machine** because both are pure pollers with no inbound HTTP: the chain bot sits in RPC calls, the news bot sits in a held `getUpdates` connection, and neither blocks the other on the same event loop. A second Fly app would be a second deploy, a second log stream and a second thing to notice has died.

**Two handles** because Telegram gives each update to whoever calls `getUpdates` first. Sharing one token would make the two bots steal each other's commands at random — `/start` would work about half the time. `news_save_token` refuses the buy bot's token for exactly this reason.

---

## Setup

### 1. Run the schema

Supabase → **SQL Editor** → paste **`SUPABASE_NEWSBOT.sql`** → Run. Idempotent.

It creates `news_bot_connection`, `news_subs`, `news_seen`, `news_state`, and **seeds `news_seen` with everything the desk has already published**.

> ⛔ That seeding step is not optional. The desk already holds 8 articles, 13 projects and a builder. To a fresh `news_seen` table those are all unannounced, so the first subscriber would be hit with 22 messages in a row and block the bot.

Verify:

```sql
select count(*) from news_seen;              -- 22 right now
select * from news_bot_connection;           -- 1 row, token null
```

### 2. Create the bot

@BotFather → `/newbot`. Then, still in BotFather, so the commands autocomplete for subscribers:

```
/setcommands
start - Subscribe to the desk
settings - Choose news, projects, builders
stop - Unsubscribe
help - What this bot does
```

If you want it to work in **groups**, also run `/setjoingroups` → Enable, and `/setprivacy` → **Disable** (otherwise it can't see `/start` sent in a group).

### 3. Wire it in the admin console

`x1brains.io` → admin → the **😂 THE EMOJI — News Notifier** card, under the buy bot.

1. Paste the token → **SAVE & VERIFY**. It is checked with `getMe` before it is stored, and the username comes back from the same call.
2. Flip **NOTIFIER LIVE**.
3. Message your new bot, then paste your own chat id into **SEND TEST**.

> ⛔ The token goes up and never comes back down. The panel only ever sees `999abc…f012` and a boolean, the same as the buy bot.

### 4. Deploy the worker

```bash
cd ~/bt/x1brainsv2/bot
flyctl deploy
```

No new secrets — it reads the same `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` already set on `x1brains-bot`. Watch it come up:

```bash
flyctl logs -a x1brains-bot
```

You want two lines: `🧠 X1 Brains Bot starting` and `😂 THE EMOJI news notifier starting`. Until a token is saved the second one says `⏸ news notifier idle`, which is correct.

---

## How it decides what is new

**By row id, never by timestamp.** Every row in every desk table currently shares one `created_at` — `2026-09-02T03:02:00.231005` — because the tables were seeded in a single statement. A high-water-mark design would look right today and broadcast the entire back catalogue to everybody the next time the Office's *Export migration SQL* is run. `news_seen` is keyed on `(kind, row_id)`, which is the slug, which is stable across edits, re-seeds and restores.

**Rows are marked seen BEFORE the fan-out.** If the machine dies mid-broadcast, the worst case is one missed announcement — recoverable by hand — instead of the same story going out to everyone again on the next cycle.

**Links, not photos.** The site serves real Open Graph tags per story now (`api/og.ts` in the lol repo), so Telegram unfurls the link into a card with the headline, dek and lead art by itself. No image fetch, no banner to keep in step, and the card stays right when the desk edits the story.

---

## Operating it

```bash
flyctl logs -a x1brains-bot | grep newsbot     # just this bot
flyctl status -a x1brains-bot
```

| Symptom | Cause |
|---|---|
| `⏸ news notifier idle` | no token saved, or **NOTIFIER LIVE** is off |
| `/start` ignored in a group | BotFather privacy mode is on — `/setprivacy` → Disable |
| Nothing posts, subscribers > 0 | check the section switches; a master switch off goes to nobody regardless of what a subscriber picked |
| A subscriber stops receiving | they blocked it. Telegram returns 403, and the row is deactivated rather than retried forever |
| Duplicate posts | should be impossible — check `news_seen` still has its primary key |

**Egress.** The desk poll defaults to 90s and is floored at 30s in the API. This project has already had its Supabase egress quota burned once by a loop re-reading config every 5 seconds; the desk publishes a few times a day and nothing here needs to be fast.

---

## Tests

```bash
# the bot loop — commands, toggles, dedupe, fan-out, blocked subscribers
cd bot && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python test_newsbot.py

# the admin actions — allow-list, url validation, token collision, masking
npm run test:newsbot
```

Both were checked by deliberately reintroducing the bugs they exist to catch: removing the topic filter and the seen-before-send ordering fails 4 checks in the first; removing the settings allow-list and the buy-bot token collision fails 2 in the second.

---

## Not built yet

**A per-story "announce / don't" switch on THE EMOJI's story editor.** The section switches here are desk-wide; there is no way to publish one story quietly. It needs a column on `desk_articles`, a change to that repo's signed write path, and a second SQL migration — held back deliberately so this one can be run and seen working on its own.
