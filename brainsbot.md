# X1 Brains Telegram Bot — Build & Deploy Log

End-to-end build of the X1 Brains buy/event bot for the `@x1brains` Telegram group, broadcasting on-chain events for `$BRAINS` and `$LB` from X1 mainnet.

---

## Architecture

| Layer | Where it runs | What it does |
|---|---|---|
| **Frontend admin UI** | `https://x1brains.io/x9b7r41ns/bot` (existing React app on Vercel) | Wallet-gated wizard for setting Telegram token, picking the broadcast group, auto-detecting pool vaults, toggling event types per token, setting thresholds, uploading banner images, and sending test messages |
| **Vercel API** | `api/admin.ts` → `api/_bot-actions.ts` | Service-key-only bridge to Supabase. Defense-in-depth wallet check inside `handleBotAction` |
| **Supabase** | `xbchrxxfnzhsbpncfiar.supabase.co` | Three RLS-locked tables: `bot_connection`, `bot_settings`, `bot_state`. Plus storage bucket `bot-banners` for alert images |
| **Bot worker** | `x1brains-bot.fly.dev` (Fly.io, single shared-cpu-1x VM, 256MB RAM) | Polls X1 RPC every ~15s, classifies new transactions into 8 event types, posts to Telegram |

---

## What works

### Frontend
- Admin UI at `/x9b7r41ns/bot` with 4-layer access gating: obscure URL, frontend wallet check, API outer wallet check, defense-in-depth check inside `handleBotAction`.
- 3-step setup wizard: Telegram token → group detection → vault auto-detection.
- 6→8 event toggles per token (BRAINS + LB), thresholds, banner image uploads.
- BOT tab inside `/x9b7r41ns/ctrl` admin panel as a launcher.

### Bot detection — confirmed working
| Event | BRAINS | LB |
|---|---|---|
| 🟢 Buy | ✅ | ✅ |
| 🔥 Burn | ✅ | ✅ (tested only BRAINS, but logic is symmetric) |
| 🌾 Stake | ✅ (after LP-mint fix) | ✅ |
| 📤 Unstake | ✅ inferred — same code path as stake | ✅ inferred |
| 💰 Claim | ✅ inferred — same code path as stake | ✅ inferred |

### Bot operations
- Polling cycle of ~15s. Polls signatures for the BRAINS pool, LB pool, brains_farm program, brains_pairing program. Deduplicates and seeds last-signature on first run.
- Posts to Telegram with the configured banner image (`sendPhoto` with caption) or text-only fallback (`sendMessage`).
- USD value, market cap, TVL pulled from XDEX price API: `https://api.xdex.xyz/api/token-price/price?network=X1+Mainnet&token_address=...`
- Whale tier detection for buyers based on $LB holdings (3 tiers).
- Threshold filtering: `min_buy_usd`, `min_burn_tokens`, `min_lp_usd`, `min_lp_add_usd`, `min_lp_remove_usd`, `min_stake_lp`, `min_claim_usd`.

---

## What's broken / unconfirmed

### 💧 LP Add (XDEX `deposit`) — NOT confirmed yet
Code is shipped (vault-balance-delta detection via `_vault_token_delta` in events.py) and unit-tested with synthetic transactions matching the explorer data, but no real on-chain deposit has been observed firing the alert in production yet.

**Current detection logic:**
1. Match XDEX `deposit` instruction discriminator (`f223c68952e1f2b6`) — first 8 bytes of base58-decoded instruction data on any XDEX program invocation, including CPIs from `brains_pairing`.
2. Sweep `postTokenBalances` for any account holding the BRAINS or LB mint.
3. Pick the account with the largest post-balance — that's the pool vault.
4. Return `(symbol, delta)`. Positive delta = deposit, negative = withdraw.

**Test action needed:** make a small XDEX deposit on the BRAINS or LB pool and watch `flyctl logs -a x1brains-bot`. If it doesn't fire, dig into why `_vault_token_delta` isn't matching.

### 📤 LP Remove (XDEX `withdraw`) — NOT confirmed yet
Same situation as LP Add. Code shipped, untested in prod.

### 💧 NEW LP Pair (XDEX `initialize`) — NOT confirmed yet
Same situation. Will only fire on brand-new pool creations, which are rare.

### 🖼 Banner image uploads from admin UI — broken
User reports: when uploading an image for the bot in the admin UI, "the image never uploads."
- Have not investigated yet — paused to fix bot detection first.
- Possible causes: file >5MB, HEIC iPhone format (only jpeg/png/webp/gif allowed), Supabase storage bucket RLS issue, or a bug in the `bot_upload_banner` action.
- Need user to capture browser F12 console errors and Network tab response when reproducing.

---

## Deployment milestones

1. **Initial code review.** Three real bugs in the original zip:
   - `SUPABASE_SCHEMA.sql` used `create policy if not exists` (invalid in Supabase Postgres). Replaced with `drop policy if exists ... ; create policy ...`
   - `BotAdmin.tsx` "Change" button broken — used `setTokenDraft(' ')` sentinel hack with locked input value. Fixed with explicit `editingToken` state.
   - `config.py` had wrong XDEX price URL `https://app.x1brains.xyz/api/xdex-price/api`. Fixed to direct `https://api.xdex.xyz/api`.

2. **Repo integration.** All files placed in user's existing structure (`api/admin.ts`, `src/lib/supabase.ts`, `src/pages/`, etc.). Bot tab added to `AdminRewards.tsx`. Route `/x9b7r41ns/bot` added to `App.tsx`. Hand-merged `BotSettings` interface into existing `supabase.ts` rather than overwriting (file has unrelated farm/rewards functions).

3. **Critical security finding.** `VITE_SUPABASE_SERVICE_KEY` was set in Vercel env, meaning the Supabase service key was being bundled into the client browser JS. User deleted the env var. Recommended rotating the key but user opted to skip — old key technically still valid.

4. **Crash fix: BotAdmin renders black.** Page rendered with only the gradient background, contents invisible. Root cause: `<PageBackground>` is `FC` (no children prop) — wrapping content inside it silently dropped everything. Fixed by switching to sibling layout (`<TopBar /><PageBackground />` siblings, content rendered separately) matching `AdminRewards` pattern.

5. **Supabase deploy.** Schema applied via SQL Editor. 1 row each in `bot_connection` and `bot_settings`, plus `bot-banners` storage bucket.

6. **Vercel env vars set:**
   - `SUPABASE_URL=https://xbchrxxfnzhsbpncfiar.supabase.co`
   - `SUPABASE_SERVICE_KEY=sb_secret_...` (Sensitive, Production+Preview only)
   - `ADMIN_WALLET=2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC`

7. **Fly.io deploy:**
   - `flyctl auth signup` as `useyourbrainsx1@gmail.com`
   - `flyctl launch --copy-config --no-deploy`
   - `flyctl secrets set SUPABASE_URL=... SUPABASE_SERVICE_KEY=...`
   - `flyctl deploy` succeeded

8. **Three Fly deploy bugs hit and fixed live:**
   - **Trial 5-min auto-stop.** Bot kept stopping. Cause: no payment method on file → Fly's free trial limits machines to 5min runtime. User added card. Resolved.
   - **`fly.toml` `[[services]]` block kills bot.** Bot has no HTTP server but block declared `internal_port = 8080`. Fly health-checked port 8080, found nothing, killed machine. Removed entire `[[services]]` block. Final clean config has no services declaration.
   - **Stale `/bot-admin` log message.** `bot.py` printed an old route in the "waiting for setup" message. Fixed via `sed`.

9. **Wizard configuration completed.** Telegram token saved. Bot added as admin to `@x1brains` group, group detected and saved (`-1003646129187` "X1 Brains 🧠"). Both BRAINS and LB pool vaults auto-detected.

10. **First buy fired.** Test buy hit TG group correctly with banner. Burns also confirmed working.

11. **CRITICAL ARCHITECTURE INSIGHT mid-session.** User clarified: *"everything goes through xdex program. even with brains lp pairing... I use cpi calls to xdex program for pool creations and stuff."* This invalidated the original `detect_lp_pair_created()` which gated on `PROGRAMS["PAIRING"]` being in the tx. Required rewriting all LP detection.

12. **XDEX IDL provided.** raydium_cp_swap fork at `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf`. Computed Anchor instruction discriminators:
    - `initialize`: `afaf6d1f0d989bed`
    - `deposit`: `f223c68952e1f2b6`
    - `withdraw`: `b712469c946da122`
    - `swap_base_input`: `8fbe5adac41e33de`
    - `swap_base_output`: `37d96256a34ab4ad`

13. **Three LP event types added:**
    - `lp_pair` (existing, rewrote detection) — XDEX `initialize`
    - `lp_add` (new) — XDEX `deposit`
    - `lp_remove` (new) — XDEX `withdraw`
    - Plus message templates, config toggles, threshold defaults, BotAdmin UI toggles, allow-list updates.

14. **First detection rewrite (signer-balance-based).** Used `_balance_delta_for_owner_and_mint()` which requires the RPC `owner` field in postTokenBalances. X1's RPC apparently doesn't fill this for Token-2022 deposits — detector silently returned None.

15. **Second detection rewrite (vault-balance-based).** New `_vault_token_delta()` uses `accountIndex` lookups instead of `owner` filtering. Finds the pool vault by largest post-balance among accounts with BRAINS/LB mint. Verified with synthetic-but-realistic transaction data matching real explorer output.

16. **BRAINS LP mint hardcode bug.** `config.py` had `lp_mint` for BRAINS as `3B6oAfmL...` but the real BRAINS LP mint is `FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3`. Caused all BRAINS stake/unstake/claim events to silently drop. LB worked because its hardcoded LP mint was correct. **Fixed via sed-patch + redeploy.** First BRAINS stake fired immediately after.

---

## Files modified / paths

### Bot (Fly.io / Python)
- `bot/events.py` — discriminator-based LP detection, vault-balance delta, inline base58 decoder
- `bot/messages.py` — added `build_lp_add` and `build_lp_remove` templates
- `bot/config.py` — corrected BRAINS lp_mint, added new event toggle defaults + thresholds
- `bot/bot.py` — `event_enabled()` and `passes_threshold()` updated for new event types
- `bot/fly.toml` — removed `[[services]]` block (bot has no HTTP server)
- `bot/Dockerfile`, `bot/requirements.txt` — Python 3.11-slim, only 2 deps (`python-telegram-bot`, `requests`)

### Frontend (Vercel / React)
- `src/pages/BotAdmin.tsx` — admin UI, 8 event toggles per token now (was 6)
- `src/pages/AdminRewards.tsx` — added 🤖 BOT tab with launcher panel
- `src/App.tsx` — added `/x9b7r41ns/bot` route
- `src/lib/supabase.ts` — extended `BotSettings` interface, added `botGetSettings`, `botSaveSettings`, etc.

### API
- `api/_bot-actions.ts` — defense-in-depth wallet check, allow-list whitelist for new keys
- `api/admin.ts` — dispatcher block for bot actions

### DB
- `SUPABASE_SCHEMA.sql` — three tables + RLS + storage bucket

---

## Pending issues to figure out

| # | Issue | What we know | Next step |
|---|---|---|---|
| 1 | LP Add not yet observed firing | Code shipped + unit-tested. Real on-chain deposit hasn't been tested since the latest deploy of vault-based detection. | Make a small XDEX deposit. Watch `flyctl logs`. If silent skip, instrument `_vault_token_delta` with debug prints to see what it's seeing for that tx. |
| 2 | LP Remove not tested | Same as #1 | Same as #1 |
| 3 | NEW LP Pair not tested | Will only fire on brand-new pool creation. | Wait until next pool creation or skip. |
| 4 | Banner image upload broken | "Image never uploads" — user reported. F12 console errors not yet captured. | Reproduce upload, capture browser console + Network tab response. Likely culprits: HEIC iPhone format, file >5MB, RLS issue on `bot-banners` bucket, or `bot_upload_banner` action bug. |
| 5 | Hardcoded LP mint is fragile | Already-shipped lp_mint fix is a hardcode. If pool gets recreated, this breaks again. | Change `detect_farm_action` to read LP mint from the pool state on-chain (similar to vault auto-detection), instead of hardcoded `config.TOKENS[sym]["lp_mint"]`. |
| 6 | XDEX price API previously 404'd | Fixed by adding `/api` to base URL: `https://api.xdex.xyz/api`. | Watch logs for `XDEX price fetch failed` warnings. If recurring, maybe their API path schema changed again. |
| 7 | Bot avatar / description in BotFather | Not yet set. Three description options drafted earlier in chat (about + description for BotFather). | User picks one, runs `/setuserpic`, `/setdescription`, `/setabouttext` in BotFather chat. |
| 8 | Supabase service key was leaked client-side | Old `VITE_SUPABASE_SERVICE_KEY` env var was in Vercel, bundling the key into client JS. Env var deleted. Old key still technically valid. | Rotate the service key in Supabase → update `SUPABASE_SERVICE_KEY` in Vercel + Fly. User opted to skip but should still do this. |
| 9 | Multi-machine HA double-posting risk | First Fly deploy created 2 machines (HA default) → would have caused duplicate alerts. Fixed via `flyctl scale count 1`. | If we ever scale up, need a Postgres-backed lock/lease to prevent dupe broadcasts. |

---

## Quick reference — operational commands

```bash
# Live tail logs
flyctl logs -a x1brains-bot

# Get last 50 lines without tailing
flyctl logs --no-tail -a x1brains-bot | tail -50

# Status
flyctl status -a x1brains-bot

# Deploy after editing bot/*.py
cd ~/bt/x1brainsv1x/x1brainsv1x/bot && flyctl deploy

# SSH into the running container (e.g. to check what code is live)
flyctl ssh console -a x1brains-bot

# Verify a file inside the container
flyctl ssh console -a x1brains-bot -C "sh -c 'grep -c _vault_token_delta /app/events.py'"

# Restart machine without redeploy
flyctl machines restart 6832717a366e98 -a x1brains-bot

# Stop / start machine (e.g. to pause the bot without uninstalling)
flyctl machines stop 6832717a366e98 -a x1brains-bot
flyctl machines start 6832717a366e98 -a x1brains-bot
```

---

## Key identifiers

- **Admin wallet:** `2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC`
- **BRAINS mint:** `EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN`
- **LB mint:** `Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6`
- **BRAINS pool:** `7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg`
- **LB pool:** `CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK`
- **BRAINS LP mint:** `FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3`
- **LB LP mint:** `85g2x1AcRyogMTDuWNWKJDPFQ3pTQdBpNWm2tK4YiXci`
- **XDEX program:** `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`
- **brains_pairing program:** `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **brains_farm program:** `Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg`
- **TG group chat_id:** `-1003646129187` ("X1 Brains 🧠")
