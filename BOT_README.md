# 🧠 X1 Brains Multi-Event Bot

Telegram bot for the **@x1brains** group that broadcasts **6 different event types per token** (BRAINS + LB), each with its own visual identity and live market data.

| Event | Trigger |
|---|---|
| 🟢 Buy | XDEX swap into the token |
| 🔥 Burn | Token-2022 `burnChecked` OR transfer to incinerator |
| 💧 LP Pair | New LP created via your `brains_pairing` program |
| 🌾 Stake | LP locked into farm (30/90/365 d) |
| 📤 Unstake | LP withdrawn from farm |
| 💰 Claim | Farm rewards harvested |

## Architecture

```
┌─────────────────────┐         ┌────────────────────┐         ┌─────────────────┐
│  YOUR WEBSITE       │         │  VERCEL            │         │  SUPABASE       │
│  (Vercel)           │         │  /api/admin        │         │                 │
│                     │  POST   │                    │  WRITE  │  bot_connection │
│  /x9b7r41ns/bot     │ ──────► │  isBotAction()     │ ──────► │  bot_settings   │
│  (BotAdmin.tsx)     │         │  → handleBotAction │         │  bot_state      │
│                     │         │                    │         │  bot-banners    │
│  uses adminFetch()  │         │  uses SERVICE key  │  (RLS denies anon access) │
└─────────────────────┘         └────────────────────┘         └────────┬────────┘
                                                                         │
                                                                         │ READ
                                                                         ▼
                                                              ┌─────────────────┐
                                                              │  FLY.IO         │
                                                              │  (Bot loop)     │
                                                              │                 │
                                                              │  Polls X1       │
                                                              │  Posts to TG    │
                                                              └─────────────────┘
```

The Telegram token only ever lives in Supabase + the bot's runtime memory on Fly.io. **Never** in your GitHub repo, Vercel env vars, or the browser bundle.

---

## 🚀 Setup (4 steps)

### Step 1: Create the Supabase tables

Open your Supabase project → **SQL Editor** → paste the entire contents of **`SUPABASE_SCHEMA.sql`** → click **Run**.

Verify it worked:

```sql
select * from bot_connection;     -- 1 row, all NULLs except id='main'
select * from bot_settings;       -- 1 row with default config jsonb
select id from storage.buckets where id='bot-banners';
```

### Step 2: Add bot actions to your Vercel `/api/admin` proxy

You already have `/api/admin/index.ts` (or similar) handling actions like `award_lbp`. We're adding new bot actions to that same proxy.

1. Copy **`api_bot-actions.ts`** into your repo as **`api/_bot-actions.ts`** (the underscore prefix tells Vercel not to expose it as its own endpoint).
2. In your existing `api/admin.ts`, add at the top:
   ```ts
   import { handleBotAction, isBotAction } from './_bot-actions';
   ```
3. Inside your handler, after the wallet check:
   ```ts
   if (isBotAction(action)) {
     const result = await handleBotAction(action, payload);
     return res.status(result.success ? 200 : 400).json(result);
   }
   // ...your existing actions
   ```
4. Add Vercel env vars (Project Settings → Environment Variables):
   - `SUPABASE_URL` = your Supabase project URL (no `VITE_` prefix — server only)
   - `SUPABASE_SERVICE_KEY` = your Supabase service_role key
5. Make sure `@supabase/supabase-js` is in your `package.json` dependencies.

### Step 3: Add the BotAdmin page to your frontend

1. Append the contents of **`supabase_bot_additions.ts`** to the bottom of your existing **`src/lib/supabase.ts`**. This adds the `bot*()` helper functions that wrap `adminFetch()`.
2. Drop **`BotAdmin.tsx`** into **`src/pages/BotAdmin.tsx`**.
3. Register the route in your router:
   ```tsx
   import BotAdmin from './pages/BotAdmin';
   // ...
   <Route path="/x9b7r41ns/bot" element={<BotAdmin />} />
   ```
4. Push to GitHub → Vercel auto-deploys.

### Step 4: Deploy the bot loop to Fly.io

Bot loop is the persistent process that polls X1 every 5 seconds. Free forever on Fly.io's `shared-cpu-1x` (256MB).

```bash
# 1. Install flyctl (one-time)
brew install flyctl     # mac
# or: curl -L https://fly.io/install.sh | sh

# 2. Sign up + log in (one-time)
flyctl auth signup      # or: flyctl auth login

# 3. From the bot/ directory, launch the app
cd /path/to/x1_buybot
flyctl launch --copy-config --no-deploy
# When prompted:
#   - App name: x1brains-bot (or anything unique)
#   - Region: pick the one closest to your users
#   - Postgres: NO
#   - Redis: NO

# 4. Set the Supabase secrets (NEVER paste into chat or commit!)
flyctl secrets set \
  SUPABASE_URL="https://YOUR_PROJECT.supabase.co" \
  SUPABASE_SERVICE_KEY="eyJh...your_service_role_key..."

# 5. Deploy
flyctl deploy

# 6. Watch the logs
flyctl logs
```

You should see:
```
🧠 X1 Brains Bot starting (Fly.io edition)…
   RPC:      https://rpc.mainnet.x1.xyz
   Supabase: https://abcdefghij.supabase…
⏸  Waiting for admin to finish setup at /x9b7r41ns/bot…
```

That's the bot waiting for you to fill in the Telegram token + chat + vaults via the admin UI.

### Step 5: Configure via the admin UI

Visit `https://your-site.vercel.app/x9b7r41ns/bot` → connect your admin wallet (`2nVaSv…WnuC`).

**Setup wizard:**

1. **Telegram bot token**
   - Open https://t.me/BotFather → `/newbot` → follow prompts
   - Copy token, paste into UI, click "Save & Verify"

2. **Telegram group**
   - Add the bot to `@x1brains` as **admin**
   - Send any message in the group
   - Click "Detect Available Groups" → pick yours from the list

3. **Pool vaults**
   - Click "Auto-detect Vaults" for BRAINS/XNT
   - Click "Auto-detect Vaults" for LB/XNT

Both will turn green. The Fly.io bot picks up the new config within 5 seconds and starts broadcasting events.

---

## 📁 What's in this folder

### Frontend / Vercel files
| File | Where it goes |
|---|---|
| `BotAdmin.tsx` | `src/pages/BotAdmin.tsx` |
| `supabase_bot_additions.ts` | append to `src/lib/supabase.ts` |
| `api_bot-actions.ts` | rename to `api/_bot-actions.ts` |
| `SUPABASE_SCHEMA.sql` | paste into Supabase SQL Editor |
| `admin_preview.html` | standalone preview — open in browser to see UI |

### Bot host / Fly.io files
| File | Purpose |
|---|---|
| `bot.py` | Main loop — polls X1, dispatches events |
| `events.py` | Tx classifier (6 event types per token) |
| `messages.py` | Per-event message templates |
| `prices.py` | XDEX price API + LB tier lookups |
| `storage.py` | Supabase REST adapter (no SDK = tiny image) |
| `x1_rpc.py` | Solana JSON-RPC wrapper |
| `config.py` | Static config (mints, programs, RPC, LB tiers) |
| `Dockerfile` | Container build for Fly.io |
| `fly.toml` | Fly.io app config |
| `requirements.txt` | Python deps (just 2: telegram + requests) |
| `test_events.py` | Unit tests (15/15 passing) |
| `.gitignore` | Excludes secrets and pycache |

---

## 🔐 Security model

| Secret | Where it lives | Where it does NOT live |
|---|---|---|
| Telegram bot token | Supabase `bot_connection.telegram_token` (RLS-protected) + Fly.io runtime memory | GitHub repo, Vercel env, frontend bundle, browser memory |
| Supabase service key | Fly.io secrets + Vercel env (`SUPABASE_SERVICE_KEY`, server-side only) | GitHub repo, frontend bundle |
| Admin wallet | Hardcoded in `BotAdmin.tsx` (it's a public address) | — |

**The browser never sees the Telegram token.** The `bot_get_connection` action returns only a masked preview like `8295xx…kAL4`.

---

## 🐛 Troubleshooting

| Problem | Fix |
|---|---|
| Bot logs `Waiting for admin to finish setup` | Connection isn't fully saved yet. Open `/x9b7r41ns/bot`, complete all 3 steps. |
| `❌ wallet not authorized` in UI | Connect with the exact admin wallet (`2nVaSv…nuC`). |
| `Detect groups` returns empty | Add bot to group as admin → send any message in group → click Detect again. Telegram only shows recent activity. |
| `Auto-detect vaults` fails | Confirm pool address in `config.py` matches the deployed XDEX pool. |
| Buys not detected | Check the connection panel — vaults must be detected for the bot to know which accounts to watch. |
| `flyctl deploy` fails on first run | Ensure you ran `flyctl secrets set` first, otherwise the bot crashes on import for missing env vars. |
| Bot keeps restarting | `flyctl logs` to see why. Most common: Supabase service key is wrong or RPC is unreachable. |

---

## 🧪 Run tests

```bash
cd x1_buybot
SUPABASE_URL=test SUPABASE_SERVICE_KEY=test python3 test_events.py
```

Should output `🎉 All tests passed!` (15 tests).
