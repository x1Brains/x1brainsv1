# X1 Brains v2 — Project Reference

Living doc. Anything load-bearing about the project belongs here so it isn't lost between sessions and so the same bugs don't get reintroduced.

> **Read the newest session logs first — they supersede §0/§12/§13 statuses, which were
> written pre-launch and are stale.**
>
> - **[§16 — 2026-08-18](#16-session-log--2026-08-18--portfolio-depth-watch-mode-logo-resolution-copy)**
>   portfolio depth + watch mode + logo resolution + copy buttons. Start at **§16.12** if you
>   are about to trust a typecheck, **§16.1** if something works on `localhost` but not over
>   the LAN, and **§16.8** before touching anything that loads an IPFS image.
> - **[§15 — 2026-08-17](#15-session-log--2026-08-17--swap-execution-pricing-charts-logos)**
>   the swap/pricing chapter — read before touching the swap, `/charts`, or anything that
>   prices a pool. §15.1's curve is now confirmed against a real executed swap (§16.6).

---

## 0. Outstanding work · do this in order

> **⚠️ DEPLOY: build + push from `~/bt/x1brainsv2` (it's now the git repo → `github.com/x1Brains/x1brainsv1` → Vercel → x1brains.io). `~/bt/x1brainsv1` = backup only. See §13.1.** v2 went LIVE 2026-06-15.

**New since launch (2026-06-15 PM) — run these:**
| # | Task | Status |
|---|------|--------|
| N1 | Run [`SUPABASE_NFT_METADATA.sql`](./SUPABASE_NFT_METADATA.sql) → `nft_metadata` indexer cache (§13.3) | ✅ DONE (operator ran 2026-06-16; verified live: REST 200, anon insert 201 write-through path works) |
| N2 | Run [`SUPABASE_MARKET_STATS.sql`](./SUPABASE_MARKET_STATS.sql) → `marketplace_stats` cache (§13.7) | ✅ DONE (verified live 2026-06-16: table populated, vol 83.999 XNT / 13 sales) |
| N3 | After deploy: CSP smoke-test (chat/NFT images+traits/swap/portfolio/mint, console open) — add blocked hosts to `vercel.json` connect-src if any | **TODO** |

| # | Task | Status |
|---|------|--------|
| 1 | Run [`SUPABASE_SCHEMA_BOOSTS.sql`](./SUPABASE_SCHEMA_BOOSTS.sql) in Supabase SQL editor | ✅ **done** — `labwork_boosts` + `labwork_points` both live (REST 200, data present) 2026-06-15 |
| 2 | `cd ~/bt/x1brainsv2 && npm install` (pulls `@vercel/node` types) | **TODO** |
| 3 | Copy v1's Supabase env vars to v2's Vercel project (see §3) | **TODO** (prod only — local `.env.local` done) |
| 4 | Set `CRON_SECRET` on Vercel (required for daily snapshot cron) | **TODO** |
| 5 | Optional — `INSERT` the lost boost row using the original burn tx hash (template in `SUPABASE_TODO.md` §5) | ✅ **done** — `spark`/1000-BRAINS row (tx `5w71mGh…`) present in both tables (expired) |
| 6 | Run [`SUPABASE_SPOTLIGHT.sql`](./SUPABASE_SPOTLIGHT.sql) in Supabase SQL editor — creates `spotlight_images` | **TODO** — table missing (REST 404 PGRST205) as of 2026-06-15. Only powers the admin landing-carousel promo images; non-fatal if unused. |
| 7 | Create Supabase Storage bucket `v2-spotlight` (**public**) | **TODO** — bucket missing (404) as of 2026-06-15. `api/admin.ts:33` uploads spotlight images here; carousel reads `image_url` as a public `<img src>`. |
| 8 | Push v2 branch → Vercel auto-deploys (`api/` lands as serverless) | when ready |

> **Full Supabase audit 2026-06-15:** probed all 18 tables v2 touches against the live REST API — **17 exist**, only `spotlight_images` missing (#6). The rest (`labwork_boosts/points`, `portfolio_snapshots`, `send_history`, `saved_addresses`, `announcements`, `bot_connection/settings`, `burn_events`, `challenge_logs`, `labwork_rewards/submissions/trades`, `nfa_acceptances`, `page_views`, `site_events`, `weekly_config`) are all live. Storage bucket `v2-spotlight` also missing (#7).

**Local dev env — RESOLVED 2026-06-15:** `~/bt/x1brainsv2/.env.local` now has real `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (pulled from v1's Vercel; anon key is public-safe). `supabase` is a live client locally → BRAINS leaderboard reads Supabase instead of the pure-RPC 32k-sig scan (see §5/§12). Restart `vite` to pick up. Repo has no git, so the key stays local-only.

See [`SUPABASE_TODO.md`](./SUPABASE_TODO.md) for the Supabase-specific checklist.

**Parallel initiative — Brains Elites holder rewards (see §11):**

| # | Task | Status |
|---|------|--------|
| A | Recover `x1brainsv1x` — **DONE** (on D:, farm+pairing byte-verified). lb_mint live source still missing but not needed for B/C (§11.6) | ✅ done |
| B | NFT staking pool — **DESIGN LOCKED** (§11.7): fork brains_farm → standalone `brains_nft_farm`, multi-token tracks (6), rarity×lock weights. **Next: scaffold the crate** (resume pointer in §11.7) | design done → build |
| C | Zero marketplace fees for Elites on **labwork_marketplace** — labwork source recovered but binary differs; verify (rebuild+diff) before ship (§11.3) | source in hand, verify |

---

## 1. Program IDs · on-chain addresses

### Programs

| Program | ID | Notes |
|---|---|---|
| `brains_pairing` | `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM` | Listing/match/delist for paired LP pools |
| `brains_farm` | `Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg` | Stake/claim/unstake LP for emissions |
| `labwork_marketplace` | `CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4` | NFT list/buy/cancel; constant: `MARKETPLACE_PROGRAM_ID_STRING` |
| `lb_mint` | `3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN` | LB token mint authority program |
| `xDEX` (Raydium CP-Swap fork) | `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` | All pool swaps/deposits/withdrawals |
| xDEX LP authority | `9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU` | xDEX program-derived LP authority |
| xDEX memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | xDEX-specific memo program (NOT the Solana standard memo) |
| Metaplex Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | X1's metadata program (mirrors Solana metaplex) |

### Token mints

| Token | Mint | Decimals | Token Program |
|---|---|---|---|
| **BRAINS** | `EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN` | 9 | Token-2022 |
| **LB** | `Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6` | **2** | Token-2022 |
| **wXNT** (wrapped native) | `So11111111111111111111111111111111111111112` | 9 | Classic SPL |

Constants: `src/constants/index.ts` — `BRAINS_MINT`, `LB_MINT`, `XNT_WRAPPED`, `BRAINS_LOGO`, `XNT_LOGO`. `LB_LOGO` is `undefined` — letter placeholder; xDex API fills it in at runtime.

### Critical wallets

| Role | Pubkey | Purpose |
|---|---|---|
| **Council admin** | `CnyGhzMuv5snBGxvShxsJMDnvHcXKwRtVVUpzGX3QAuG` | One of two admin-panel wallets (gates `/admin`) |
| **V1 admin** | `2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC` | Other admin-panel wallet (legacy x1brains.io admin) |
| **Marketplace platform** | `CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF` | Receives 1.888% sale fees; hardcoded in marketplace program |

Allowlist mirrored across `src/lib/admin.ts`, `api/admin.ts`, `api/_bot-actions.ts`. Override via `ADMIN_WALLETS` env (comma-separated).

### Key xDEX pools / vaults (used by on-chain price oracle)

- **XNT/USDC.X pool**: `CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR`
- XNT/USDC vaults: `8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb` (XNT, 9 dec) · `7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg` (USDC, 6 dec)
- BRAINS/XNT vaults: `HJ5WsScycRCtp8yqGsLbcDAayMsbcYajELcALg6kaUaq` (XNT) · `HnUfCrgrhHzgML92ipbkLGhi2ggm1kdHDvvcqRtuUeb3` (BRAINS)

Used by `PairingMarketplace.tsx` and `PoolsTab.tsx` to compute prices entirely on-chain without trusting xDex's price API.

### Fee constants

- Marketplace sale fee: **1.888%** (`SALE_FEE_NUMERATOR / SALE_FEE_DENOMINATOR = 1888 / 100_000`)
- Marketplace cancel fee: **0.888%**
- Pairing burn options: 0%, 25%, 50%, 100%
- Pairing fee tiers: 0.888% (ecosystem or 33+ LB held) · 1.888% (standard)

### Other constants

- BRAINS initial supply: 8,880,000 (used to compute "burned" deltas)
- LB initial supply: 100,000
- RPC: `https://rpc.mainnet.x1.xyz`
- xDex API: `https://api.xdex.xyz` (proxied via `/api/xdex-price` rewrite in `vercel.json` + `vite.config.ts`)

---

## 2. Boost program · how it works

### Burn → Supabase flow

1. Citizen opens `V2BoostModal` from a listing they own on `/labwork`
2. Picks tier + currency (2026-06-15): SPARK (200 BRAINS **or** 0.05 LB / 24h) · GODSLAYER (444 BRAINS **or** 1 LB / 3d) · INCINERATOR (888 BRAINS **or** 1.11 LB / 7d). See §13.5.
3. Tx: `createBurnCheckedInstruction` against the chosen mint (`BRAINS_MINT` or `LB_MINT`) via Token-2022 program (both are Token-2022, NOT classic SPL)
4. On confirm, two Supabase upserts run in parallel:
   - `labwork_boosts` row (UPSERT on `listing_pda` — one active boost per listing)
   - `labwork_points` row (UPSERT on `tx_sig` — prevents double-credit on retry)
5. Earn rate: **1.888 labwork points per BRAINS burned** (tier-based; same points whether paid in BRAINS or LB, LB rows tagged `source:'boost-lb'`)
6. Slot cap: **8 active boosts site-wide** (`BOOST_SLOTS`), ordered `tier DESC, created_at ASC`

### Where it surfaces

- **Landing carousel** (`/` → V2Home) — pulls `loadActiveBoosts()` + filters chain listings to matching `listing_pda`. Falls back to a "no active boosts · spotlight is open" CTA if zero — **never falls back to cheap-floor listings**. Boosts are paid placement.
- **`/labwork`** — boost button on each of the citizen's My Listings rows

### Boost tier color/glyph mapping

```
SPARK       — 24h  — 200 BRAINS or 0.05 LB — orange      — ⚡
GODSLAYER   — 3d   — 444 BRAINS or 1    LB — purple      — ⚔️
INCINERATOR — 7d   — 888 BRAINS or 1.11 LB — fire orange — 🔥
```

### Known data drift

A burn that succeeded on-chain but failed to write to `labwork_boosts` (pre-fix silent catch) leaves the BRAINS gone with no recoverable row. Recovery path: manual SQL insert using the tx hash. Template in `SUPABASE_TODO.md` §5.

---

## 3. Environment variables · Vercel deployment

### Required

| Var | Where | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | client bundle | Same as v1: `https://xbchrxxfnzhsbpncfiar.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | client bundle | Same as v1 |
| `SUPABASE_URL` | `api/*` serverless | Same as v1 |
| `SUPABASE_SERVICE_KEY` | `api/*` serverless | Same as v1 — bypasses RLS for admin writes |

### Required for specific features

| Var | Feature | Notes |
|---|---|---|
| `CRON_SECRET` | `/api/cron-snapshot` | Any random string. Vercel cron sends `Authorization: Bearer <secret>`. Default-deny if missing — daily snapshot won't run. |

### Optional

| Var | Default | Purpose |
|---|---|---|
| `ADMIN_WALLETS` | `<council>,<v1-admin>` | Comma-separated admin allowlist override |
| `ALLOWED_ORIGINS` | `https://x1brains.io,https://www.x1brains.io` | CORS allowlist for `/api/admin` |

---

## 4. Architecture · v2 patterns

### Stale-while-revalidate (every long fetch)

Pattern in `prices.ts`, `marketStats.ts`, `chainBurns.ts`, `brainsIndexer.ts`, `xdexPoolChart.ts`:
- **Fresh window** (~60s) — return cache immediately, no network
- **Stale window** (variable: 5min for chain burns, 1h for marketStats, 30min for brainsIndexer) — return cache, fire background refresh
- **Hard cutoff** (variable: 5min–24h) — wait for fresh fetch, no fallback

### Incremental scans (use the high-water mark)

- **`marketStats._doScan`** records `lastSig` (newest sig seen) and stops paginating when it hits that sig on a subsequent scan. First cold scan walks the full history; every subsequent scan walks just the new tail.
- **`chainBurns.fetchBurnsFromChain`** does the same with `knownSigs: Set<string>` seeded from cache.
- **Lesson**: any append-only on-chain or DB source can do this — don't refetch the world every load.

### V2-native vs v1-derived components

- `V2*.tsx` — orange/dark/green palette, mono Orbitron, `info-card`/`lw-stack`/`lw-stats` classes, designed mobile-first
- `PoolsTab.tsx`, `PairingMarketplace.tsx`, `LabWork.tsx`, etc. — large v1 modules carried over. We **export** their useful internals (modals, helpers) and reuse them inside v2 wrappers rather than rewriting from scratch.
  - `PoolsTab` exports: `DepositModal`, `WithdrawModal`, `SwapModal`, `PoolView`, `PoolState`, `PoolRecord`
  - `PairingMarketplace` exports: `SwapTab` (with optional `initialFromMint`/`initialToMint` props for deep-linking)

### Modal palette unified

| Action type | Color |
|---|---|
| Primary (Buy / List / Stake / Donate / Claim / Boost / Deposit) | `#ff8c00` orange |
| Destructive (Cancel listing / Unstake / Delist / Withdraw) | `#ff4466` red |
| Stats/balance display (earned, profit, etc.) | `#00c98d` green |
| Other ecosystem chips | `#bf5af2` purple |

No green or cyan on action buttons. Anything that breaks this gets fixed.

### On-chain TWAP for pool charts

`src/lib/xdexPoolChart.ts` reads each xDex pool's observation account directly (`obsKey` parsed from pool state) and decodes 100 TWAP samples + appends current vault-ratio spot price. **No API, no rate limit, fully independent per pool.** Lifted out of `PoolsTab` so any v2 surface can chart any xDex pool.

### `.lf9-*` paneled DeFi layout (2026-06-11)

Shared frosted-panel design system used across the DeFi pages so they read as one family. CSS in `src/App.css` (appended at end): `.lf9-panel` (frosted card), `.lf9-stat-row` (divided stats), `.lf9-head` (section title + rule), `.lf9-table`/`.lf9-row`, `.lf9-tiers` toggle, claim/positions classes. Applied to:

- **`V2LpPools.tsx`** — the real LP Farms page (route `/lpfarms`). **NOT `LpFarms.tsx`**, which is now a pure data/helper module (`fetchFarms`, `computeApr`, `LOCK_TIERS`, `fetchTotalStakers`, PDA derivations, `fetchTokenLogo`). The old dead page component + `FarmCard`/`PositionCard`/`HudDashboard` were deleted 2026-06-11 (2981→~790 lines). Positions table shows staked date + USD + grace-period banner; panel-level Claim button; pair token logos (XNT hardcoded to `XNT_LOGO`). Tier roadmap = "stepper" (nodes I→IV on a green→orange progress line); active tier always orange.
- **`V2LpPairing.tsx`** (`/labworkdefi`) — stats panel + open-listings table + how-it-works.
- **`V2MintLabWork.tsx`** + **`V2MintInner.tsx`** (`/mint-labwork`) — mint-only (burn toggle removed; burn lives on Incinerator). Hero in `lf9-panel`; two-row hero stat strip (LB/BRAINS + XNM/XUNI/XBLK burns, USD green, all else white, LIVE has a green orb). MINT/TIERS tabs only (AMPLIFIER/INFO removed). Buttons restyled to Portfolio scale (`.mint-submit`, smaller `.mint-tab`/`.mint-preset`).
- **`V2Charts.tsx` + `V2XdexPoolsList.tsx`** (`/charts`, labelled **Pools & Charts**) — converted to the `lf9` layout (`v2-glass` wrapper, stats `lf9-panel` w/ `lf9-pairhead` + `lf9-stat-row`, pools `lf9-panel`). Folded under the **LP Pairing** nav category (expandable sub-item). Bare Portfolio-style title.
- **`V2LabWork.tsx`** (`/labwork`) — minimal-mono featured banner (Brains Elites), Browse-by-Collection = V09 story circles in the banner's top-right (excludes Brains Elites), template-01 cards, minimal stat row.

Design preview mockups (pick-one HTMLs) live at `/mnt/d/v2/previews/` (`marketplace/`, `lpfarms/`, `mintlabwork/`, `landing/`; hub `HUB.html`). Page-window-style + tier-strip mockups at `/mnt/d/v2/new page style css/` (`index.html`, `index-mix.html`, `tiers-designs.html`).

### v2-glow background system (2026-06-12)

Two `:root` vars in `src/index.css` drive every panel's "dual-top glow" (faint orange top-left, teal `rgb(0,207,198)` top-right) so all pages share one background: `--v2-glow` (full) and `--v2-glow-soft` (fainter). Layer over any dark base: `background: var(--v2-glow), <base>`. Applied to `.lf9-panel`/`.lf9-row`, `.v2-glass .info-card`/`.card`/`.farm-card`, `.v2-palette .info-card` (full), base `.info-card` (soft), `.pfx-panel` (Portfolio inline), `.f8panel` (Home inline), and the xDEX pool cards. **Tune the whole site from those two vars.** Chosen from mock #18 (dual-top); rejected carbon-fiber + frosted-orange experiments.

### Sidebar nav (2026-06-12)

`src/components/Sidebar.tsx` supports three item kinds: internal (`to`, optional `children`), external (`href`), and **action** (`action: 'x1bChat'`). LP Pairing is an **expandable** parent (`children: [{ label: 'Pools & Charts', to: '/charts' }]`) — the sub-item only shows when the parent/child route is active (`.nav-subgroup`/`.nav-subitem`). "X1B" is an action item that opens the chat widget (no longer an external link). "V2" badge next to the brand title.

### X1B chat widget + XT0 (2026-06-12) — see [[project_xt0_v2_widget_pending_decision.md]]

`src/components/X1BChat.tsx` (`X1BChatProvider` wraps `V2Layout`; `useX1BChat()` opens it) + `src/lib/xt0Client.ts`. Floating, **draggable (header) + resizable (corner)** panel, portaled to body. Geometry + conversation persist to `localStorage` (`x1b_chat_v1`) — close keeps everything, reopen restores exact pos/size/history. Wired to live XT0: wallet `signMessage` over `x1city.chat.auth:<wallet>:<signed_at>` (cached in sessionStorage, 5h refresh) → `POST https://api.x1.city/chat` (`identity:"XT0"`, `citizen_context`), SSE deltas streamed in. **17 msg/wallet/UTC-day** client cap (server still 50/24h) → upgrade panel → `https://x1city.io/agent` (premium, LB/BRAINS-burn credits). **No CORS blocker — the "CORS" concern was never real**: the deployed cf-worker already serves `access-control-allow-origin: *` (`corsHeaders()` at `cf-worker/src/index.ts:3486`), proven end-to-end with a real Ed25519 sig. The dev `mockReply()` fallback has been **removed** — `xt0Client.ts` talks only to live `https://api.x1.city/chat`. Mostly-neutral widget palette; user bubbles muted amber.

---

## 5. Bugs encountered · don't reintroduce

### Silent catch blocks hide everything

```ts
try { await supabase.from('X').insert(row); } catch {}
```
The user's boost burned 1,000 BRAINS but the row never wrote because the table didn't exist — silent catch swallowed the error and the modal celebrated success. **Always** return `{ ok, error }` from writes and surface failures to the UI. `console.warn` at minimum.

Fixed in `V2BoostModal.tsx`. Same pattern exists in `lib/supabase.ts` for 13+ other helpers — adding visibility there incrementally.

### Hardcoded decimals when sending tokens

`V2Portfolio.tsx` was passing `decimals: 9` to `SendPanel` for every token. NFTs (decimals=0) became `1 × 10⁹ = 1B raw units` → `InsufficientFunds (0x1)` from SPL Token. **Always** pass `h.decimals` from the actual holding row.

### Wrong-chain hardcoded mints

`XntPriceCard` had `USDC_X1 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'` — that's the **Solana mainnet** USDC mint, not X1's. Chart sat at "loading" forever. Fix: derive USDC mint from the live `prism` snapshot by finding the XNT/USDC pool. **Never hardcode mints across chains.**

### useState init from a stale ref

`V2LabWork` snapshot was initialized with `liveSnapshot` (zeros at first render), then debounced 2.5s of "no changes" before locking. Image enrichment fires `setListings` per chunk for many seconds → timer never settles → snapshot stays at zero forever. **Fix**: lock on the first render where loading=false AND listings.length>0; don't debounce.

### Cache early-return on "truthy ≠ populated"

`getCachedChainBurns(LB_MINT)` returns a `ChainBurnSummary` object even when `events.length === 0`. Adding `if (cached) return;` skipped the actual scan permanently. **Fix**: check `cached.events.length > 0` if you need to gate on actual data, or just always run the incremental scan.

### Rate-limited API for per-row data

xDex `chart/history` API throttles to 20 calls/minute. With 30+ pool cards rendering at once, the bottom cards never got charts. **Fix**: read on-chain observation accounts (no rate limit) instead of hitting the API per card.

### Native `<select>` ignores color CSS

Browser-rendered `<option>` elements ignore most styling — labels came through as plain white on the marketplace sort dropdown. **Fix**: replace with a button-pill radiogroup. Native selects are a no-go for branded surfaces.

### `setTimeout` deferrals make pages feel slow

V2Home reactor + monitor cards were intentionally `setTimeout(2.5s/4s/6s)` to "let the carousel land first." That made the dashboard feel slow vs the no-defer pools/TVL section. **Fix**: remove deferrals + add localStorage caches for instant repaints from previous-session data.

### Colored boxShadow halos overlap

`boxShadow: 0 4px 14px ${color}26` (14px blur) with an 8px button gap = colored halos bleed across the gap and visually overlap neighbors. **Fix**: flat background tint, no spreading colored shadow.

### Closing the SendPanel on success hides the tx link

V2Portfolio's `handleSendComplete` called `setActiveSendMint(null)` → unmounted SendPanel → user never saw the tx hash link. **Fix**: leave the panel mounted; let the citizen close with X. Display tx hash + COPY + EXPLORER chips that persist.

### Boost carousel falling back to cheap-floor

If we filter "boosted listings" but find none, **don't** fall back to a curated "top cheap listings" list — that hides the boost mechanic and confuses citizens about what gets promoted. Show the empty CTA: "🔥 NO ACTIVE BOOSTS · Spotlight is open."

### Logo backfill hardcoded to slots

The SwapTab logo-fetch effect was hardcoded: "fetch XNT, apply to tokenIn; fetch BRAINS, apply to tokenOut." Wrong when deep-linked from a pool card with a different pair. **Fix**: generic `apply(prev)` that matches by mint regardless of slot, fetches logos for ALL known mints + any deep-linked mints.

### ActivityLog labeled everything "OTHER"

`classify()` only inspected SPL-token burn/transfer ixs. Anything else (program calls, native XNT transfers, etc.) fell through to "On-chain interaction · OTHER." **Fix**:
1. Native XNT detection via owner lamport pre/post delta
2. Program-ID map → friendly labels (Farm / Pairing / DEX / Marketplace / LB Mint / NFT)
3. Extract Anchor ix name from `Program log: Instruction: <Name>` log lines
4. Fallback: `Program XxXx…YyYy` (the program shortid) instead of generic "Other"

### X1 RPC 413s on 100-sig `getParsedTransactions` (silent → empty data)

`rpc.mainnet.x1.xyz` returns **HTTP 413 "Payload Too Large"** when
`getParsedTransactions` is handed **100 signatures** in one call (≤50 works).
Every scanner paginated `getSignaturesForAddress({limit:100})` then passed all
100 to `getParsedTransactions`, wrapped in `.catch(() => [])` — so it threw 413
and **silently found nothing**. BRAINS looked fine (supply-delta reactor +
Supabase-backed leaderboard); **LB is pure-RPC**, so its burns showed **0** on
the landing Burn Reactors and the Incinerator page loaded no data. **Fix**:
chunk into 25-sig calls, null-pad failed chunks to keep index alignment with the
sig array. **Fixed at all 5 call sites**: `chainBurns.ts`, `BurnLeaderboard.tsx`,
`marketStats.ts`, plus the v1-carryover `BurnedBrainsBar.tsx` (PAGE_SIZE=100) and
`pages/BurnHistory.tsx` (those two aren't on v2 routes — `/incinerator-engine` →
`V2Incinerator` — but had no `.catch()`, so a 413 threw uncaught; fixed anyway).
Also seed the LB incremental scan from stored events **ignoring the 5-min display
TTL** (historical burns are immutable) so repeat scans fetch only the new tail.
**Note**: LB mint is **2 decimals**, not 9 as §1 says
(scanner reads decimals dynamically, so it's unaffected — but §1 should be fixed).

### Swap token picker showed only wallet tokens (2026-06-15)

Typing a coin name/symbol in the swap search surfaced nothing but wallet
holdings. Two bugs in `TokenPickerModal` (`PairingMarketplace.tsx` ~3550):
1. It fetched `pool/list?network=mainnet` → **0 pools**. The working value
   (used by `brainsIndexer`) is `network=X1%20Mainnet` → 97 pools. `mainnet`
   silently returns empty.
2. Even with pools, `addFromData` parsed an **old shape** (`token0`/`tokenA`/
   `mintA`/`token0Mint`). The live pool/list shape is `token1_address` /
   `token1_symbol` / `token1_logo` + `token2_*` (see `brainsIndexer._parseAndStore`)
   → it extracted 0 tokens. **Fix**: corrected the network param + rewrote the
   side-extraction to read `token{1,2}_*` (tolerant of legacy shapes). pool/list
   has no decimals → default 9, re-resolved on select. **Lesson**: when two call
   sites hit the same xDEX endpoint, copy the param + parser from the one that
   works (`brainsIndexer`), don't hand-roll a second shape.

---

## 6. v1 vs v2 · what's different

### Pages

| Route | v1 | v2 |
|---|---|---|
| `/` | v1 home | V2Home (boost carousel, pools/TVL, prism stats) |
| `/labwork` | v1 LabWork | V2LabWork (boost button native, MarketplaceStats dashboard) |
| `/admin` | v1 BotAdmin (separate route) | V2Admin (dual-wallet gate, analytics + bot embedded inline) |
| `/charts` | n/a | V2Charts (xDex pools list with native deposit/withdraw) |
| `/swap` | v1 SwapTab | V2Swap (accepts deep-link from pool cards) |
| `/admin/bot`, `/admin/analytics` | separate v1 pages | redirect to `/admin` |
| `/pairing-pools` | n/a | redirect to `/charts` |

### Removed in v2

- Rewards Season (weekly_config, challenge_logs tables stay in DB but no UI)
- Lab Work Submissions panel in admin
- Recent Burns ledger in admin
- Separate `/x9b7r41ns/*` obfuscated admin URLs (back-compat redirects only)
- Standalone v1 PoolsTab on `/charts` (PoolsTab.tsx file stays — DepositModal/WithdrawModal still imported for V2XdexPoolsList — but the page itself isn't rendered)

### Admin panel

**Dual-wallet allowlist** via `useAdmin()` hook (`src/lib/admin.ts`). Same hook wires the wallet's Ed25519 `signMessage` into `setAdminAuth` for every `/api/admin` write — no manual setup per page.

```ts
const { isAdmin, role, pubkey, connected } = useAdmin();
// role === 'council' | 'v1' | null
```

---

## 7. Files of interest · jump table

| File | What it owns |
|---|---|
| `src/lib/admin.ts` | Dual-wallet admin allowlist + `useAdmin()` hook |
| `src/lib/supabase.ts` | All Supabase helpers (admin writes go through `adminFetch` → `/api/admin`; reads are direct anon) |
| `src/lib/marketStats.ts` | Marketplace volume scanner with incremental `lastSig` high-water mark |
| `src/lib/chainBurns.ts` | Generic burn-events scanner for BRAINS/LB |
| `src/lib/brainsIndexer.ts` | xDex prism (pool list + TVL + chart/history) |
| `src/lib/xdexPoolChart.ts` | On-chain TWAP reader for any xDex pool |
| `src/lib/xdexPoolView.ts` | Adapter: builds `PoolView` from xDex state + prism for PoolsTab's modals |
| `src/pages/V2Home.tsx` | Landing — boost carousel, prism stats, BURN REACTORS, X1.MAINNET MONITOR |
| `src/pages/V2LabWork.tsx` | NFT marketplace — listings, my-listings, sell, activity, boost button |
| `src/pages/V2Charts.tsx` | "Pools & Charts" page (`/charts`) — `lf9` layout; folded under LP Pairing nav category |
| `src/lib/xt0Client.ts` | XT0 client — wallet-sig auth, SSE stream from api.x1.city/chat, 17/day cap helpers |
| `src/components/X1BChat.tsx` | Floating draggable/resizable X1B chat widget + `X1BChatProvider`/`useX1BChat()` |
| `src/pages/V2Portfolio.tsx` | Wallet tokens + NFTs + LISTED badges + snapshot chart + SendPanel |
| `src/pages/V2Admin.tsx` | Dual-gated admin console (analytics + bot inline, announcements last) |
| `src/pages/V2Swap.tsx` | Wraps SwapTab; reads `useLocation().state` for deep-linked pair |
| `src/pages/PoolsTab.tsx` | v1 carryover; exports DepositModal/WithdrawModal/SwapModal/PoolView for reuse |
| `src/pages/PairingMarketplace.tsx` | v1 carryover; exports SwapTab |
| `src/components/V2BoostModal.tsx` | Boost flow + `loadActiveBoosts()` |
| `src/components/V2AnalyticsPanel.tsx` | Embedded admin analytics |
| `src/components/V2BotPanel.tsx` | Embedded admin bot config |
| `src/components/V2XdexPoolsList.tsx` | xDex pools list with rich cards + native deposit/withdraw |
| `src/components/V2NFTImage.tsx` | Multi-source image resolver (IPFS/Arweave/CDN/proxy fallback chain) |
| `src/components/ActivityLog.tsx` | Wallet activity feed with program-ID label map |
| `api/admin.ts` | Serverless admin proxy (Ed25519-signed POST) |
| `api/_bot-actions.ts` | Bot config actions (Telegram, vaults, banners) |
| `api/cron-snapshot.ts` | Daily portfolio snapshot for all wallets |
| `vercel.json` | SPA fallback + xDex/Solaris proxy rewrites + daily cron schedule |

---

## 8. CSP / proxy paths

All third-party fetches go through proxies (vite in dev, `vercel.json` rewrites in prod) so they pick up CORS:

| Path | Target |
|---|---|
| `/api/xdex-price/*` | `https://api.xdex.xyz/*` |
| `/api/xdex-mint/*` | `https://mint.xdex.xyz/*` |
| `/api/nft-meta/<host>/*` | `https://<host>/*` |
| `/api/solaris/*` | `https://solarisprime.xyz/api/indexer/*` |
| `/imperial/*` | `http://jack-nucbox-m6-ultra.tail515dc.ts.net:8773/api/*` (Cyberdyne) |

---

## 9. Conventions

- **No emojis in code/comments** unless they're rendered in UI (boost tier glyphs, sort pills, etc.)
- **Don't add features unprompted** — implement only what was asked
- **No `catch {}`** — log errors. Return `{ ok, error }` from writes.
- **Don't hardcode mints across chains** — always derive from prism / on-chain state
- **Cache reads + revalidate in background** for any fetch > 200ms
- **Show empty states explicitly** — never silently render nothing
- **Native selects need replacement with button groups** if they appear in branded surfaces

---

## 10. Glossary

- **Prism** — the `brainsIndexer.fetchIndexerSnapshot()` blob from xDex's `/pool/list` API. Has every pool's TVL, volume, fees, token info. Source of truth for pool listings.
- **High-water mark** — `lastSig` recorded by `marketStats` so incremental scans stop at the previous newest sig instead of walking the full history.
- **Observation account** — xDex pool's PDA holding 100 TWAP samples. Address derivable from pool state's `obs_key` field. Used by `xdexPoolChart.fetchXdexPoolHistory`.
- **Boost** — paid placement on landing carousel. Citizen burns BRAINS → Supabase row → 3-slot rotation.
- **Stale-while-revalidate** — return cached data immediately; refresh in background; next paint uses fresh data. Hides latency.
- **Pool view** — the rich struct `PoolsTab`'s modals expect. We build minimal ones in `xdexPoolView.ts` from prism + on-chain state.

---

## 11. Brains Elites holder rewards · v1 program upgrade initiative (planning — 2026-06-14)

**Goal:** upgrade the x1brains **v1 on-chain programs** to reward holders of the 444 Genesis **"Brains Elites"** NFTs. v2 is the frontend that will surface these perks. This section is the source of truth for that effort.

### 11.1 The two chosen reward ideas (operator-picked)

1. **Fee-fed NFT staking pool — extension to `brains_farm`.**
   - Stake your Brains Elite NFT → earn a pro-rata share of **platform fees** (real yield, not inflation).
   - Built as an **additive upgrade** to brains_farm: NEW instructions (`stake_nft` / `claim` / `unstake_nft` / `fund_nft_pool` / `create_nft_pool`) + NEW account types (NFT escrow vault, per-NFT stake position). Existing token-farm instructions + `FarmGlobal`/`Farm`/`StakePosition` layouts stay **byte-untouched** so the live LP-token farms keep working.
   - Reward distribution = **deposit-driven accumulator** (lump-sum fee top-ups split across stakers), NOT the time-based `reward_rate_per_sec` the token farms use.
   - **OPEN DECISIONS:** (a) reward token — XNT (purest real-yield, since fees arrive as XNT) vs swap-to-BRAINS/LB; (b) equal weighting vs **rarity-weighted** (Elite > Rare > Uncommon > Common, tier readable on-chain). Fees reach the pool via a treasury `fund` call (not a hardwired per-trade on-chain split).

2. **Zero marketplace fees for Elite holders — `labwork_marketplace`.**
   - Lister can list **any NFT from any collection**. At **buy time**, `buy_nft` checks whether the **seller's wallet still holds a Brains Elite** (passed-in NFT token account + its MintRecord PDA).
   - Holds one → **fee waived, seller gets the full XNT price**. No longer holds one → normal 1.888% sale / 0.888% cancel fee → treasury. The Elite is a membership card, re-verified live at sale.
   - Buyer's client must attach the seller's Elite-proof accounts; no incentive to grief (buyer pays the same `price` either way — fee comes from the seller's cut). Likely **no on-chain storage** needed (don't resize the 90-byte `SaleAccount`); list-time check is a frontend badge only.

### 11.2 How to prove "holds a Brains Elite" on-chain (the verification recipe)

The collection mint `GaxRaEV7BEWPq1Xt5HB795Pv1cTTtynXmbzE4GNda5BL` is the **parent collection NFT** — each of the 444 editions has its **own unique mint**, so you can NOT check `token_account.mint == collection_mint`. Instead (mirrors frontend `genesis_nft.ts:740` `findHeldBrainsElites`):
1. Holder passes their NFT token account → assert `amount ≥ 1`, `owner == claimant`, read the `nft_mint`.
2. Derive `[b"mint_record", nft_mint]` on the **genesis_nft program** `GQPGh1M6xwwWLdGCmWum2BhPi6gkJaoNFXyyuXpgN59v` and assert the account **exists + is owned by that program**. Existence = genuine Brains Elite.

This reuses the exact shape of the existing **LB-balance discount** read (`brains_pairing/create_listing.rs:378`, `brains_farm/unstake.rs:145`) — optional account, fixed-offset read, sentinel guard. No CPI, no Metaplex parse, fully additive.

### 11.3 On-chain verification — DONE 2026-06-14 (we hold all upgrade keys)

Verified live against `https://rpc.mainnet.x1.xyz` with `solana program show` + fresh `solana program dump` md5 compare:

| Program | Live Program ID | Upgrade authority (we hold) | Source reproduces live? | Verdict |
|---|---|---|---|---|
| **brains_farm** | `Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg` | `CCcJuC3B…vcY2` (id.json) | ✅ **byte-identical** | 🟢 safe to upgrade |
| **brains_pairing** | `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM` | `CCcJuC3B…vcY2` (id.json) | ✅ **byte-identical** | 🟢 safe to upgrade |
| **lb_mint** | `3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN` | `E2JtCat…88DR` (lb_mint_upgrade.json) | ❌ no (live has `update_tier_rates` our src lacks) | 🔴 diverged — recover source |
| **labwork_marketplace** | `CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4` | `E2JtCat…88DR` (lb_mint_upgrade.json) | ❌ no (byte-diff, maybe just Anchor 0.31→0.32 toolchain — UNPROVEN) | 🟡 recover/verify source before ship |

- **We hold the upgrade authority for ALL FOUR** programs (confirmed on-chain). No access blocker.
- Only **brains_farm** matters for idea 1 → **green-lit**. Idea 2 needs the labwork source step first.
- Full per-program internals/upgrade-surface reference: `~/bt/x1brainsv1/PROGRAMS_REFERENCE.md`. See also [[reference_x1brainsv1_authorities.md]], [[project_final_mint_deploy_migration_plan.md]].

### 11.4 Deploy bundle + keypairs (on Windows D: drive — NOT in any git repo)

`D:\v1programs&updates\` (= `/mnt/d/v1programs&updates/`), assembled 2026-06-13/14:
- `upgrade-keypairs/id.json` → pubkey `CCcJuC3B…vcY2` (signs farm + pairing)
- `upgrade-keypairs/lb_mint_upgrade.json` → pubkey `E2JtCat…88DR` (signs lb_mint + marketplace)
- `libs-onchain/` = exact live binaries (md5-confirmed == chain). `libs/` = x1brainsv1x build (matches live for farm/pairing only).
- `scripts/` = `deploy-brains-pairing.sh`, `deploy-brains-farm.sh` (the safe upgrade wrappers), plus `update_tier_rates.js` (proves live lb_mint diverged), `verify_state_compat.js`, etc. **No deploy script exists for lb_mint/labwork.**
- `idl/` are STALE (from x1brainsv1x build — don't reflect live lb_mint). `ideas/Brains_Elites_Reward_Ideas.html` = the 24-idea concept board.
- **NEVER commit keypairs.** Pubkeys above are public; secret bytes stay on D: only.

### 11.5 Deploy hazards (read before any v1 upgrade)

- **brains_pairing** deploys ONLY via `scripts/deploy-brains-pairing.sh` — its local program-ID keypair is a ghost (`C3vwW3As…`); `anchor deploy` would burn rent on a dead address.
- **brains_farm** must build **WITHOUT** the `admin-test-tools` feature (it gates `force_mature_position`); use `scripts/deploy-brains-farm.sh`.
- Before building the real farm upgrade: one-time `cargo build-sbf` of `~/bt/x1brainsv1`'s farm and confirm md5 == live (the byte-reproducing build came from `x1brainsv1x`, which is NOT on this machine — only `~/bt/x1brainsv1` is; confirm they're identical).

### 11.6 Source recovery — x1brainsv1x RECOVERED + verified 2026-06-14

Full workspace recovered to `D:\v1programs&updates\x1brainsv1x-full.tar.gz`
(= `/mnt/d/v1programs&updates/…`, 1.23 GB: `.git` + `node_modules` + `target/` +
all 4 program crates; last commit 2026-04-28; Anchor 0.32.1). Mount D: in WSL with
`sudo mount -t drvfs D: /mnt/d` (not auto-mounted; only C: is).

**md5: tarball `target/deploy/*.so` vs live `libs-onchain/*.so`:**

| Program | Tarball `.so` | Live `.so` | Match | Source |
|---|---|---|---|---|
| brains_farm | `2a4cfbee…` | `2a4cfbee…` | ✅ byte-identical | ✅ present |
| brains_pairing | `53873b7b…` | `53873b7b…` | ✅ byte-identical | ✅ present |
| labwork_marketplace | `a4c4b09e…` | `2fb537c6…` | ❌ differs | ✅ present, logic UNVERIFIED (maybe just Anchor toolchain) |
| lb_mint | `cf3c9506…` | `273f8bed…` | ❌ differs | ⚠️ STALE — source has NO `update_tier_rates` (live does) |

- **Idea 1 (NFT staking on brains_farm) = fully unblocked** — byte-reproducing source + authority key (`CCcJ…vcY2`/`id.json`) + `deploy-brains-farm.sh` all on D:.
- **Idea 2 (labwork zero-fee)** — source now in hand but binary differs; prove it (rebuild w/ live toolchain + diff) before ship.
- **lb_mint** still genuinely diverged (real source likely `x1brainsv1c`), but **neither chosen idea touches lb_mint**, so not a blocker.
- Bundle also has all 4 `program-keypairs/`, both `upgrade-keypairs/`, deploy+verify scripts.

### 11.7 NFT staking pool — LOCKED DESIGN (2026-06-15)

Elite NFT staking farm. **Decisions locked** with operator; surfaced under **LP Farms**
(`V2LpPools.tsx`) in v2. Reuses `brains_farm`'s proven MasterChef logic.

**Build approach:** FORK `brains_farm` (`~/bt/x1brainsv1/programs/brains_farm`, byte-matches
live) into a NEW standalone program `brains_nft_farm` — fresh `declare_id` + keypair. Live
`brains_farm` stays byte-untouched → **zero risk to live LP farms**. Fork into the same
workspace so the toolchain matches.

**Reward model = brains_farm verbatim, but multi-token.** brains_farm is 1 reward/`Farm`;
NFT farm needs 6+ rewards (XNT, BRAINS, LB, XNM, XUNI, XBLK…) → **one shared staking pool +
N independent reward "tracks"**, each a MasterChef accumulator (`reward_rate_per_sec` u128/1e18
time-based emission, vault-capped, `acc_reward_per_share`) over the SAME `total_effective`.

**Weighting = rarity × lock (both stack):**
`effective_weight = rarity_weight[tier] × lock_multiplier_bps / 10_000`
- rarity_weight: **Elite 8 / Rare 4 / Uncommon 2 / Common 1** (tunable at init; read from
  on-chain `MintRecord.tier`, genesis_nft `GQPGh1M6…`, seeds `[b"mint_record", nft_mint]`).
- lock_multiplier: reuse brains_farm **Locked30/90/365 → 2×/4×/8×** (20000/40000/80000 bps).
- e.g. Locked365 Elite = 8×8 = 64; Locked30 Common = 1×2 = 2.

**Accounts:**
- `NftVault` (global, `[b"nft_vault"]`): admin, treasury, genesis_program, total_staked,
  `total_effective`, rarity table, paused/lock, bump.
- `RewardTrack` ×N (`[b"track", reward_mint]`): reward_mint, reward_vault, reward_rate_per_sec,
  acc_reward_per_share, last_update_ts, total_pending, total_emitted, `is_native`, bumps. (copied from `Farm`)
- `StakePosition` (`[b"position", nft_mint]`): owner, nft_mint, tier, base_weight, lock_type,
  effective_weight, start/grace/unlock_ts, last_claim_ts, bump.
- `PositionReward` (`[b"preward", nft_mint, reward_mint]`): reward_debt (u128), pending (u64).
  Split per-track so a 7th reward can be added later WITHOUT resizing positions.

**Instructions (fork of brains_farm):** `init_vault` · `create_track` · `fund_track` ·
`update_rate` · `stake_nft` · `claim` · `unstake_nft` · pause/admin. stake_nft escrows the NFT
(SPL, decimals 0) + verifies MintRecord (genuine Elite + reads tier). Early unstake forfeits
pending only (no principal penalty possible on an NFT — pending stays in vault, boosts APR).
Reuse grace (3d) / 24h claim cooldown / stake fee / reentrancy guard. Admin = `CCcJ…vcY2`.

**Reuse verbatim:** accumulator settle, time-based emission, fund/update_rate, grace/cooldown,
stake fee→treasury, pause guards. **Drop:** LP-mint validation (pairing/xdex). **Add:** NFT
escrow, MintRecord verify+tier read, multi-track, native-XNT track.

**Reward-track roster (all verified on-chain 2026-06-15):**

| Token | Mint | Dec | Program |
|---|---|---|---|
| XNT | native / `So111…112` | 9 | native lamports (wXNT classic) |
| BRAINS | `EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN` | 9 | Token-2022 |
| LB | `Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6` | 2 | Token-2022 |
| XNM | `XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m` | 9 | Token-2022 |
| XBLK | `XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T` | 9 | Token-2022 |
| XUNI | `XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm` | 9 | Token-2022 |

- 5/6 are Token-2022 → reward vaults/payouts use `transferChecked` via token-2022 (brains_farm
  already has the feature). XNT track = native lamports.
- **XNM/XBLK/XUNI extensions = only `metadataPointer` + `tokenMetadata`** — NO transfer-fee, NO
  transfer-hook → payouts are exact, no accumulator drift. (LB 2-decimal handled by 1e18 ACC_PRECISION.)
- All three share mintAuth `2sXr5THr…Q6Z7`.

**OPEN / needed before code-complete:**
- New `brains_nft_farm` program keypair + rent (~few XNT).
- Frontend: "Elite NFT Vault" section in `V2LpPools` (reads held Elites via `findHeldBrainsElites`,
  positions, per-track pending; stake/unstake/claim). APR shown retrospectively.

**▶ RESUME HERE (next session) — design 100% locked, ready to write code:**
Fork target = `~/bt/x1brainsv1/programs/brains_farm` (git repo, on `main` → **branch first**,
e.g. `nft-farm`). Add new crate `~/bt/x1brainsv1/programs/brains_nft_farm`. Build order:
1. Scaffold crate: `Cargo.toml`, `lib.rs`, `state.rs`, `constants.rs`, `errors.rs`, `instructions/` (fork brains_farm).
2. State + accumulator: `NftVault` / `RewardTrack` / `StakePosition` / `PositionReward` + per-track settle (from brains_farm `accumulator.rs`).
3. Admin/funding ix: `init_vault`, `create_track`, `fund_track`, `update_rate`, pause.
4. Staking ix: `stake_nft` (escrow + MintRecord verify `[b"mint_record",nft_mint]`@`GQPGh1M6…` + tier→rarity 8/4/2/1 + lock 2/4/8×), `claim`, `unstake_nft` (forfeit-pending).
5. `cargo build-sbf` + localnet test (mint fake Elite → stake/fund/claim/unstake).
6. Frontend "Elite NFT Vault" in `V2LpPools`.
Reference brains_farm files: `state.rs` (Farm/StakePosition/LockType), `constants.rs` (ACC_PRECISION 1e18, lock secs/bps, grace 3d, cooldown 24h, stake fee 0.005 XNT), `instructions/{stake,claim,unstake,fund_farm,create_farm,initialize_global,admin}.rs`.
All reward mints + decimals + programs in the roster table above. Genesis_nft source = `~/bt/x1city-onchain/programs/x1city_genesis_nft` (MintRecord.tier @ state.rs:150).

---

## 12. Session log — 2026-06-15 (frontend polish, all LOCAL/not pushed)

UI/UX tweaks shipped to the working tree today (x1brainsv2 has no git repo —
changes live in the files only):

1. **Incinerator skin** → matched Portfolio (neutral `.pfx`-style panels + left
   orange accent rail), dropped the fire/red experiment + the multicolor top bar
   (`.v2-glass .info-card::before` rainbow). Scoped under `.v2-inc` in `App.css`.
   Glow dialed **−30%** (`--v2-glow`/`--v2-glow-soft` alphas ×0.7 + rail box-shadow).
2. **Burn scanners parallelized** (`chainBurns.ts` two-phase + 6-wide pool;
   `BurnLeaderboard.tsx` per-page `Promise.all`). ~~Note: BRAINS leaderboard is
   wrong locally because `.env.local` Supabase creds are blank.~~ **RESOLVED
   2026-06-15** — real Supabase creds added to `.env.local` (see §0), leaderboard
   now reads Supabase, not the pure-RPC 32k-sig scan.
3. **Swap token picker** fixed (see §5): `network=X1%20Mainnet` + `token{1,2}_*`
   parser. Now searches all 97 pools by name, not just wallet tokens.
4. **X1City sidebar link** → `https://x1city.io/` (was `https://x1.city`).
   v1 components (`UI.tsx`,`Home.tsx`) still point at `x1.city` — left as-is.
5. **Shared page title** — new `V2PageHeader` (Orbitron 800/16px + Sora 9px muted,
   = Portfolio `.pfx-title`; CSS `.v2-pagehead` in App.css) added to LP Farms,
   LP Pairing, Pools & Charts, Swap, Incinerator.
6. **Burn Dashboard (twin reactors)** scaled **~25% smaller** (`V2BurnDashboard.tsx`
   — HUD 220→165, all ring/core insets + fonts + meta tiles ×0.75).
7. **Swap CTA + output field** purple (`#bf5af2`) → orange.
8. **Swap is now bidirectional** — `SwapTab` got `amtOut` + `exactSide` state and a
   reverse quote (`rawIn = rawOut·vaultIn / (fee·(vaultOut−rawOut))`). Type in
   either "You Pay" or "You Receive"; on-chain swap stays exact-in.

**Still open / tomorrow:** scaffold `brains_nft_farm` (§11.7 resume block). Optional
follow-up: verify labwork_marketplace source (rebuild+diff, §11.3) before the
zero-fee idea. (~~local Supabase creds~~ done 2026-06-15, see §0.)

---

## 13. Session log — 2026-06-15 PM · LAUNCH + repo migration

**🚀 v2 WENT LIVE on x1brains.io (2026-06-15).** Pushed commit `3694faf` + follow-ups.

### 13.1 DEPLOY TOPOLOGY — CHANGED (read this first)
`~/bt/x1brainsv2` **IS NOW THE GIT REPO.** Its `.git` was moved out of `~/bt/x1brainsv1`
into v2, so v2's `origin` = `github.com/x1Brains/x1brainsv1` (the repo Vercel watches → x1brains.io).
**Build AND push from `~/bt/x1brainsv2`** (`git push origin main`). It's a monorepo:
v2 frontend + the 4 on-chain Anchor programs + Anchor/Cargo + tests + `bot/` + `api/`.
`~/bt/x1brainsv1` is now a **plain backup folder (no .git)** — do NOT push from it.
`.gitignore` merges v1's keypair/.env/target/ops-script protections.

### 13.2 New Supabase tables to run (operator)
- **`SUPABASE_NFT_METADATA.sql`** → `nft_metadata` (shared NFT image/traits indexer cache).
- **`SUPABASE_MARKET_STATS.sql`** → `marketplace_stats` (XNT volume / sales / biggest-buy cache).
- (`nfa_acceptances` already exists — used by the consent gate below.)

### 13.3 NFT metadata indexer cache (speed)
`lib/supabase.ts`: `getNftMetadataBatch()` / `upsertNftMetadata()`. V2LabWork reads the
cache FIRST (instant paint, skips Solaris + per-NFT JSON for cached mints) and write-throughs
newly-resolved NFTs; V2NFTDetailModal also write-throughs. First viewer resolves → everyone
else loads instantly. Graceful no-op if the table doesn't exist.

### 13.4 NFA consent gate (`components/V2NfaConsent.tsx`, mounted in V2Layout)
Blocks first visit, **per-wallet** (each connected wallet must accept once → logged to
`nfa_acceptances` {version,page,wallet,user_agent}; `anon` flag covers no-wallet browsing).
Storage key `x1brainsv2.nfa.accepted.v2`, version `2.0`. v2-styled (orange/amber, BRAINS-logo
header, teal "◆ AUDITED" box disclosing the internal/AI audits — still NFA/no-liability).

### 13.5 Boost tiers retuned + LB payment (`components/V2BoostModal.tsx`)
Tiers now **200 / 444 / 888 BRAINS** (24h/3d/7d). Added a **BRAINS | LB currency toggle** —
LB alts **0.05 / 1 / 1.11 LB**. LB is Token-2022 (`LB_MINT` from constants), same `burnChecked`
path. Points stay **tier-based** (`brains×1.888`) regardless of currency; LB rows tagged
`source:'boost-lb'`. `BoostCurrency` type exported.

### 13.6 vercel.json — CSP + cron restored
Re-added a **comprehensive CSP** (v1's policy extended for every v2 endpoint: solaris, weserv,
api.x1.city, x1city, r2.dev, x1pups/punks, corsproxy/allorigins, all IPFS gateways, etc.;
`img-src https:`). Restored the **`cron-collect-lb-fees`** daily cron (function preserved).

### 13.7 Marketplace fixes
- **Biggest Buy** stat shows the sold NFT thumbnail; `marketStats.ts` `isComplete()` forces a
  self-healing rescan when the stored biggest sale lacks `nftMint` (LS key `v5`).
- **NFT traits** now populate: V2LabWork enrichment carries `attributes`+`externalUrl`; modal
  fetches on open (metaUri JSON ‖ Solaris race). Solaris cache key bumped `v2` (was masking
  attrs). Traits render as **v1-style inline `Label: Value` pills**; rarity from `rarity/tier/grade`.
- **Card↔modal image mismatch** fixed — `openDetail` pins the modal image to the card's
  (`it.image`) and stops enrichNFT from re-resolving it. X1 Punks fallback uses the LAST URL
  number. V2NFTImage cache key bumped `v2`.
- **Card hover** = border-color only (no lift/translate).

### 13.8 Other
- Network Monitor **slot/block flicker** fixed (monotonic `Math.max` clamp — load-balanced RPC).
- **Portfolio**: snapshot share-card embeds token logos as canvas-safe data-URIs; Key-Metrics +
  Holdings panels vertically centered (`.pfx-panel` flex column + `flex:1`).
- **Mobile pass**: NFA + NFT modal stack on phones; buy/boost modals `maxHeight:92dvh`+scroll;
  chat widget clamps to viewport; new `@media(max-width:560px)` block.
- **Font tightening**: `.lf9-stat` scale (Overview + LP Farms) reduced toward Portfolio density
  (value 22→18px, head 11→9.5px, labels trimmed).
- **API build fix** (Vercel node16): `./_bot-actions` → `.js`; `getParsedTokenAccountsByOwner`
  3rd arg is a `Commitment` string not `{commitment}`.
- **cf-worker (separate repo `x1city-react/cf-worker`)**: corrected Brains Elites mint price to
  **linear 33→444 XNT** (edition #1=33 … #444=444) for XT0 + X1B; deployed (worker `75ad0492`).
  Also fixed X1B `IDENTITY.md` (had wrong 50→222).

### 13.9 Evening polish + mobile hardening (2026-06-15 PM, all pushed)
- **Boost LB option**: tiers **200/444/888 BRAINS** OR **0.05/1/1.11 LB** (24h/3d/7d), BRAINS|LB
  toggle in V2BoostModal (LB is Token-2022, same burnChecked). Points stay tier-based; LB rows
  `source:'boost-lb'`. (§13.5)
- **Brand orange softened site-wide**: `#ff8c00` → **`#f29030`** + `rgba(255,140,0,…)` →
  `rgba(242,144,48,…)` (sed across all src). Tunable — change those two values.
- **Home strips** (`.l-ticker`, `.l-spot` in V2Home injected CSS) = **softer teal**
  (`rgba(0,207,198,.035/.07/.16…)`). The other `.f8`/bstat teal elements untouched.
- **Featured banner image (LabWork `.lw-hero`)**: `stableHeroImg` state holds the last-good
  image and never reverts to empty during enrichment (was disappearing); mobile uses
  `object-fit:contain` (no crop).
- **Mobile (Backpack WebView) hardening — App.css `@media (max-width:760px)` block at the very end:**
  `.main { zoom: 0.9 }` (whole app ~10% smaller); `overflow-x:hidden` kills sideways scroll;
  price ticker hidden; header `padding-left:72px` clears the menu toggle; `lf9` tables (LP Farms/
  Pairing) + Mint tier table → stacked cards; burn/tx rows get `min-width:0`+ellipsis; 3-up stat
  grids → 2-up. **All CSS-only, NOT render-tested on Backpack — verify on device.**
- **API build fix** (Vercel node16, unblocked the deploy): `api/admin.ts` import `./_bot-actions.js`;
  `api/cron-snapshot.ts` `getParsedTokenAccountsByOwner(..., 'confirmed')` (string, not object).
- **Marketplace card hover** = border-color only (no lift/move). `.lf9-stat` value font 22→18px
  toward Portfolio density.

> **Open tweak knobs** (one-value changes if needed): mobile `zoom` (0.9), softened orange
> `#f29030`, softer-teal alphas, header `padding-left:72px`. Still TODO from §0: run
> `SUPABASE_NFT_METADATA.sql` (MARKET_STATS already run — verified live 2026-06-16); verify Vercel env vars.

### 13.10 Second mobile pass (2026-06-15 late, on-device Backpack feedback)
Fixes driven by real Backpack-WebView screenshots:
- **Featured collection banner** (`V2LabWork` `.lw-hero`): `stableHeroImg` now starts `''` (NO
  bundled `/brains-elites-banner.jpg` promo flash) — shows ONLY the live Brains Elites listing
  image, holds it, never reverts to empty. Mobile layout = **image LEFT (92px col, object-fit
  cover → no black letterbox bars) · text RIGHT** (App.css 760px block: `.lw-hero
  grid-template-columns: 92px 1fr`). NOTE: VIEW ALL / BROWSE LISTINGS buttons sit in the right
  info column bottom; "full-width buttons below everything" is a DOM tweak if wanted.
- **Boost carousel** (`V2Home` injected `.l-*`): title `.l-nm` 30→16px, `.l-pr` 20→12px, padding/
  CTA/arrows shrunk inside the existing `@media (max-width:560px)` block (it's appended to
  `document.head`, so it wins over App.css — put carousel mobile rules THERE, not App.css).
- **Marketplace tabs** (inline in V2LabWork): added `minWidth:0` + tighter mobile gap/letter-
  spacing so BROWSE/MINE/SELL/LOG all fit (LOG was clipped by the overflow-x guard).
- **Filter pills + toolbar**: `.market-filters`/`.market-toolbar` `flex-wrap:wrap` (were cut off).
- **NFT marketplace stat row** (`.lw-mkstatrow`/`.lw-mkstat`): centered + wraps on mobile.
- **Header title clearance**: mobile `.header padding-left:72px` (was flush against the menu toggle).

### 13.11 Final polish (2026-06-15 latest)
- **Featured collection banner (mobile)** — superseded the image-left layout (dead black space
  under the short image) with a **centered stacked card**: art on top (128×160 cover, no bars),
  centered eyebrow/title(18px)/stats/buttons, blurb `-webkit-line-clamp:2`. App.css 760px block.
- **"Lab Work" → "LabWork"** (and `LAB WORK`→`LABWORK`) **renamed site-wide** (display only —
  `find … sed`). The lowercase `namePrefixes:['lab work','labwork']` in `verifiedCollections.ts`
  were left untouched so collection matching still works. NFT trait values (`Sub-collection: Lab
  Work`) come from on-chain metadata, NOT code — they still read "Lab Work" until metadata changes.
- **Boosted-listing deep-link**: home carousel **VIEW DETAILS** now → `/labwork?nft=<mint>`;
  `V2LabWork` reads the `?nft=` param (new `useSearchParams`) and opens that NFT's detail modal
  (traits + context BUY) once it lands in `merged`, then clears the param (ref resets on no-param
  so re-clicks re-open). Mint field = `featuredListing.nftMint`.
- **Wallet modal rebrand**: the lib hardcodes "Connect a wallet on Solana to continue" — overrode
  in `utils/globalStyles.ts` (`.wallet-adapter-modal-title { font-size:0 }` + `::before` content
  "Connect your X1 Blockchain Wallet to continue"). Wallet names/"Detected" labels stay (from adapters).

## 14. Session log — 2026-06-16 · NFT-image resolution + FOUC + Supabase verify

Commits (all pushed + deployed to x1brains.io): `f4c6c1d`, `fe15954`, `ab3e561`, `aeab3c3`,
`3eda8d2`, `ce2a986`.

### 14.1 ⭐ Solaris returns the COLLECTION image as a per-NFT fallback (root cause of 2 bugs)
`fetchSolarisNft(mint)` (`lib/solarisIndexer.ts`) does **not** have a per-NFT image for every
collection. For **Brains Elites** specifically, Solaris has NO per-edition image, so its image
fallback returns the **collection portrait** (the brain-with-hat) for *every* BE mint:
```
image: m.image || (c?.image && j.data.listing == null ? undefined : c?.image)   // ← c = collection
...
if (!out.image && c.image) out.image = c.image;                                  // ← collection fallback
```
This silently poisons any UI that trusts Solaris for a BE image — it shows the same collection art
for all 444 editions. **The real per-edition art lives in each NFT's metaUri JSON on Arweave.**
**Rule: to show real per-NFT art, resolve from the metaUri JSON / chain (`enrichNFTFromMint`),
NOT Solaris. Use Solaris for the image only as a LAST resort, and for traits (it has those).**

### 14.2 Featured banner stuck on the collection portrait (`V2LabWork` `.lw-hero`) — FIXED `3eda8d2`
The hero art was pinned to `collectionStats[].image`, which is the first listing's image or, when
none resolved, the Solaris collection art. Because of §14.1 every BE listing resolved to the same
collection URL, so an earlier rotation attempt (`ab3e561`) deduped 4 identical URLs → 1 → stuck on
every refresh. Final fix: gather the listed BE **mints** (`it.collectionKey==='brains_elites' &&
it.listing`), resolve each REAL image via `enrichNFTFromMint(connection, mint)` (chain PDA → uri →
JSON image), dedupe the distinct images, and **rotate** the hero art on a 4s interval. Falls back to
the collection portrait only until the first real image resolves; never reverts to empty.

### 14.3 Detail modal: blank/placeholder, then wrong (collection) image — FIXED `f4c6c1d` + `ce2a986`
Home-carousel **VIEW DETAILS** deep-links to `/labwork?nft=<mint>`; the modal opens the instant the
mint lands in `merged` — while the listing is still RAW (no image, name = mint-slice placeholder,
no metaUri). `enrichNFT` bails with no metaUri, so the modal showed `NO IMAGE` / `#ERgVWq` /
`Uncategorized` even though traits resolved (those came from Solaris by mint).
- `f4c6c1d`: the modal already fetched `fetchSolarisNft(mint)` for attrs but threw away its image +
  name. Now it backfills **image, name, collection** too (treats the mint-slice name as a placeholder
  via `looksPlaceholderName`), and the write-through to `nft_metadata` caches the RESOLVED fields.
- `ce2a986`: image resolution reordered to **metaUri JSON → chain (`enrichNFTFromMint`) → Solaris
  last** (per §14.1), so BE shows real art not the collection portrait. Threaded `connection` into
  the modal (new optional prop) for the chain path.
- **Known boundary (not yet fixed):** the modal's image backfill only runs when `nft.image` is
  empty. If a BE arrives already carrying the Solaris collection-fallback as its image (some
  grid-click paths), the modal keeps it and still shows the collection portrait. To fix later:
  detect/override a collection-fallback image. Deep-link/carousel case (empty image) IS fixed.

### 14.4 Mobile FOUC — white page + raw unstyled DOM flash — FIXED `aeab3c3`
`index.html` set no background, so on slow mobile loads the browser painted white + unstyled DOM
until the bundled CSS (imported in `main.tsx`) fetched. Added **inline critical CSS** (dark
`--bg-deep #080c0f` + text color, parsed before any fetch) + a pre-mount `#boot` splash inside
`#root` that React replaces on mount + `<meta name="theme-color">`. First frame is now dark, never
white. (CSS imported via JS = no render-blocking `<link>` until the bundle parses → this is the fix.)

### 14.5 Supabase tables — both verified LIVE via REST probe (2026-06-16)
- `marketplace_stats` — was ALREADY run (REST 200, populated: vol 83.999 XNT / 13 sales). `fe15954`.
- `nft_metadata` — operator ran it this session; verified REST 200 + anon insert 201 (write-through
  path works). Checklist N1/N2 now both ✅.
- Probe recipe: `curl "$VITE_SUPABASE_URL/rest/v1/<table>?select=*&limit=1" -H "apikey: $KEY"
  -H "Authorization: Bearer $KEY"` → 200 = exists, 404 `PGRST205` = missing. Anon has NO delete
  policy on `nft_metadata` (insert/update/select only), so a stray test row needs SQL-editor delete.

### 14.6 Deploy verification gotcha — check the LAZY route chunk, not the main bundle
To confirm a deploy of route-level changes (e.g. `V2LabWork`), do NOT compare the live `index-*.js`
hash to the local build — Vercel bakes its own `VITE_*` env vars in, so the **main** bundle hash
differs even for identical source. Instead compare the lazy route chunk: fetch the live main bundle,
grep the `V2LabWork-<hash>.js` it references, and match against local `dist/assets/V2LabWork-*.js`.
That chunk has no env vars, so identical source → identical hash → proof the deploy landed.

---

## 15. Session log — 2026-08-17 · swap execution, pricing, charts, logos

Commits `9b63334`, `a3e0ed7`, `4a67410`, `8c8cd31`, `f868940`. Trigger: AGI/BRAINS
(a pairing-marketplace pair) could not be traded from the swap page.

### 15.1 ⭐⭐⭐ xDEX quoting — reserve ≠ vault, and the fee is 0.28%

**The single most important thing in this section.** CP-Swap trades against
`vault_amount_without_fee` = **vault − protocol_fees − fund_fees**. Accrued fees sit
*inside* the vault but are outside the curve. On live X1 pools they are **0.4 %–5.8 %
of the vaults and ASYMMETRIC per side** (AGI: 5.64 % token0 vs 1.17 % token1), so a
raw-vault quote misprices by ~5 % **with a sign that flips by direction** — which is
why it looked random:

| pair | app quoted | pool actually paid | error |
|---|---|---|---|
| MIND→BRAINS | 0.175364 | 0.165887 | **+5.7 %** → died 6005 |
| BRAINS→AGI | 198.577 | 189.536 | **+4.8 %** → died 6005 |
| AGI→BRAINS | 3.024 | 3.166 | −4.5 % (passed, underquoted) |

Anything over the 0.5 % slippage bound was a guaranteed on-chain failure. Also the
fee rate is per-AmmConfig **`trade_fee_rate` @ offset 12 = 2800 (0.28 %)**, not 0.25 %,
and the program rounds the fee **UP**. Correct form, byte-exact vs the program:

```
fee = ceil(in · rate / 1e6) · out = floor((in − fee) · resOut / (resIn + (in − fee)))
```

Verified: 4 marketplace pools × both directions × slippage 0.5 / 0.1 / **0 %** = 24/24
simulations pass. Passing at **0 %** is the proof the quote is exact.

> ⚠️ **Do NOT apply this to the listing oracle.** `create_listing` and `prepare_match`
> compute the XNT price from **RAW vault balances** on chain and cross-validate the
> caller's `xnt_price_usd` within `XNT_PRICE_TOLERANCE_BPS = 500` (5 %). The frontend
> must MIRROR the program, not abstract truth. Divergence on the oracle pools is only
> 0.03–0.05 % anyway (fee ratios largely cancel in a *ratio*). Note also `SLIPPAGE_BPS
> = 5` = **0.05 %** USD parity between match sides, despite the comment saying 0.5 %.

### 15.2 PoolState / PoolRecord offsets (verified against 6 live pools)

`PoolState` (absolute, incl. 8-byte disc): `232 token_0_program · 264 token_1_program ·
296 observation_key · 328 auth_bump · 329 status · 330 lp_mint_decimals ·
331 mint_0_decimals · 332 mint_1_decimals · 333 lp_supply · 341 protocol_fees_0 ·
349 protocol_fees_1 · 357 fund_fees_0 · 365 fund_fees_1`.
The swap page read decimals at 339/340 (inside `lp_supply`) → 0 on every pool, masked
by a `|| 9` fallback. `PoolRecord` is `space = 8 + 274` (282 B) but the struct fills only
268 — **`seeded` is at byte 274, not 281**; the old check read slack and never skipped
admin-seeded records.

### 15.3 Never default a token program to classic SPL

BRAINS and LB are Token-2022, so nearly every pool is mixed or all-T22. A classic-SPL
ATA for BRAINS points at an account that does not exist → Anchor **3012
AccountNotInitialized**. Two places did this:
- `SwapTab.makeShim` hardcoded classic SPL for deep-linked tokens; `handleSwap` now
  takes BOTH programs from pool state, which records one per side.
- `xdexPoolView` hardcoded both — and DepositModal/WithdrawModal derive their ATAs
  from those fields, so **deposit/withdraw was broken on every BRAINS pool**.
  `XdexPoolMeta` now carries `token0Prog`/`token1Prog`.

**Anchor 3000-3999 are FRAMEWORK account errors; a program's own errors start at 6000.**
The error map read 3008-3012 as slippage/liquidity, so a wrong-ATA failure was reported
as "insufficient pool liquidity" on a pool with 398k AGI in it. Real slippage is
**6005 ExceededSlippage**.

### 15.4 Deep-linked tokens arrived with balance 0

`V2XdexPoolsList.goSwap` → `/swap` builds a `makeShim` token (balance 0). The mount
loader only reconciled XNT-as-input and BRAINS-as-output, so any other mint stayed at 0,
`insufficientBal` was true for any amount, and the button sat dead on `INSUFFICIENT
<TOKEN>` forever — a wallet holding 49 M AGI showed `Balance: 0`. Only `refreshAll()`
patched generically, and it runs solely from the manual ⟳ button. Both sides are now
reconciled against the wallet scan by mint as soon as it lands.

### 15.5 Chart TWAP was 1/p², not price

The observation account keeps TWO cumulative prices and they are **reciprocal**, so
`d1/d0 = 1/p²`. History read 208,000× off on AGI and 2,200,000× off on BRAINS/XNT, and
because `pct = (last − first)/first` compares a garbage first point against the correct
appended spot, **every pool card showed ≈ −100 % 24h change**. Correct: **`p = sqrt(d0/d1)`**
— the ratio cancels both Δt and the Q32.32 scaling, so no descaling constant is needed.
BRAINS/XNT (observations minutes old) now sits 0.28 % from spot.

### 15.6 Token logos

- `PairingMarketplace` never imported `lib/tokenLogos.ts`, the shared resolver every
  other surface uses — so the swap missed the pool/list prime (78 of 79 tokens ship a
  working https logo) and the cross-page cache. Now wired through it.
- **Issuers ship full art**: NECK 1.37 MB PNG 828×1022 (portrait → centre-crop reframes
  it), $HOE 367 KB, DRC 1024², BRAINS 1288×1134. Browser downscaling to a 26-38px circle
  is the "blurry/distorted" look. Logos now resize server-side at 2× the painted box
  (NECK 1.37 MB → 3.7 KB). weserv **400s on `mint.xdex.xyz`** and other extensionless
  IPFS paths (same limit as irys/permagate), so it falls back to the raw URL.
- **X1X had no image although its art was fine.** Its metadata JSON is on
  `gateway.pinata.cloud`, which answers in ~6.9 s cold and **stalls past 30 s once the
  request carries an `Origin` header** (i.e. from a browser). Both readers aborted at
  5 s. They now allow 9 s then retry same-origin via `/api/nft-meta`.
- Prefer the shared cache over a caller-supplied URL so BRAINS/XNT/LB keep their curated
  assets. `onError` must set STATE — the old `style.display='none'` hid an avatar
  permanently, because React reuses an `<img>` across `src` changes and never clears an
  inline style it didn't set (same trap as §14 / SESSION_2026-08-01 §4).

### 15.7 degen.fyi launchpad — why DGN token prices show "—"

`app.degen.fyi` is X1's launchpad. Tokens trade on a **bonding curve** until they
**graduate**; only then is an xDEX LP created, and `pool/list` is the only price source
v2 reads. So pre-graduation tokens legitimately show "—".
Confirmed: NECK / $HOE / X1X in no pool → "—"; DRC / AGI in pools → priced. NECK's card
reads Market Cap $306K, **79.568 % to graduation**, LP Lock 100 %.

**Launchpad program: `degenDXVPhS7vgu3hcdzGA7T6dfCe6qTYyVM7npP3pc`** (144 program
accounts ≈ tokens launched). Per-token curve PDA (NECK: `HV9xgjoJCe5FZXWPdKfm1hBi5dXu6AZgGUhNgHwJceCB`)
is the mint authority AND holds the token reserve; account is 139 B, disc
`da70069537baa8a3`, with total supply (1e18) at offset 72.
**Not yet decoded** — showing pre-graduation prices means decoding the remaining curve
fields (check for an on-chain Anchor IDL first). Deliberately not guessed: a wrong
decode prints confident wrong prices, which is worse than "—".

### 15.8 Verification notes for future sessions

- `SwapTab` is **prop-driven** (`publicKey`/`connection`/`signTransaction`), so it can be
  mounted standalone in a throwaway `probe.html` + `src/_probe.tsx` under vite and driven
  headless. This is how the balance-0 and logo bugs were proven rather than argued.
- ⛔ **`rpc.mainnet.x1.xyz` rate-limits hard and the failure MIMICS the bug** — one probe
  page ≈ 77 RPC calls; 4 loads produced **270 × HTTP 429**, which made pool discovery fail
  on *every* pair including known-good ones and left balances at 0. Intercept at the
  browser boundary with a serialized + cached + retry-on-429 shim, and always run a
  known-good control pair.
- `tsc -p tsconfig.app.json` is **not clean at baseline** (76 errors in
  `PairingMarketplace.tsx` alone: missing `@types/node` Buffer, unused vars). Compare
  counts against `git stash`, don't chase absolutes.

---

## 16. Session log — 2026-08-18 · portfolio depth, watch mode, logo resolution, copy

Fourteen commits, `9b63334`…`db89360`. Read §15 first — this session builds directly on it.
Everything here was measured in headless Chromium against live X1 mainnet data or verified
on-chain; where something was **not** verified it says so.

### 16.1 ⛔⛔⛔ Secure-context APIs die silently on `http://<LAN-IP>`

Reported as "I can't add liquidity" — the modal showed
`Cannot read properties of undefined (reading 'digest')`. Not a liquidity bug at all:

    http://localhost:5173        isSecureContext: true    crypto.subtle: object
    http://172.26.150.107:5173   isSecureContext: false   crypto.subtle: undefined

`window.crypto.subtle` exists **only in a secure context** — https, or `localhost` /
`127.0.0.1`. Over a LAN IP it is `undefined`, so `PoolsTab.tsx`'s `disc()` throws before a
transaction is ever built. Production (https) is unaffected; this is a dev/LAN-testing trap.

**Eight** call sites share the fault, so the same error masquerades as eight different bugs:
`PoolsTab` (deposit / withdraw / swap_base_input), `PairingMarketplace` ×4 (create_listing,
edit_listing, delist, the generic `disc`), `LpFarms` (stake / unstake / claim / fund_farm),
`LBComponents`, `lib/supabase`.

**`navigator.clipboard` has the identical rule** — every copy button in the app did nothing
at all over the LAN, with no error. `components/CopyButton` now falls back to a hidden
`<textarea>` + `execCommand`.

> **Rule:** when something works on `localhost` and not over the LAN IP, suspect
> `isSecureContext` before suspecting your code. Anchor discriminators are deterministic
> constants — computing them with an async, secure-context-only API buys nothing. Hardening
> the remaining seven sites is **still open** (see §16.12).

### 16.2 Portfolio — watch any wallet (ported from v1)

`/portfolio` was hard-bound to `useWallet()` and showed an empty panel to visitors. The v1
implementation still lives in `src/pages/Portfolio.tsx`; v2 now has the same feature.

Every **read** goes through `activeKey` (watched address, else connected wallet). Every
**write** is disabled while watching:

- SEND buttons hidden (`!isReadOnly && wallet && …`)
- SNAPSHOT button hidden
- the snapshot autosave effect returns early — merely *viewing* a wallet must never write a
  Supabase row for an address a visitor typed in
- the signing `wallet` object and the saved-address book stay bound to the **connected**
  wallet, not the watched one

`.pfx` is a CSS grid and stretched the panel to 590px around ~270px of content —
`align-self: start` on `.pfx-watch`.

### 16.3 Portfolio — row caps

Long wallets ran forever, worst on mobile.

- Holdings groups show their **top 20**, rest behind a per-group toggle (`GROUP_PREVIEW`).
  Expansion state is per group, not global.
- **Groups were not sorted** before (only "Ecosystem · Core" was). A "top 20" off an
  unsorted list is meaningless — tokens now sort by USD, NFTs by listed price then name
  (NFTs mostly have no USD price, so value alone left them arbitrary).
- "Holdings by USD" hard-caps at **10** (`RANK_LIMIT`) — it is a ranked *summary*, the full
  list is the table directly below. Subtitle reads `top 10 of N` when rows are dropped; a
  truncated list still labelled "ranked" is a lie.

**⛔ The BALANCE column was hidden below 1000px.** `@media(max-width:1000px)` set
`.pfx-cell-spark,.pfx-cell-price,.pfx-cell-bal{display:none}` to fit the row, which left
"how many of this token do I hold?" answerable **only by opening the SEND panel** — on a
phone *and* on a merely narrow desktop window, since 1000px is not a mobile-only breakpoint.
The amount is now also rendered inline under the mint (`.pfx-bal-inline`), hidden by default
and shown exactly where the column is not, so full width never shows it twice. Verified at
1400 / 900 / 390px: column-only, inline-only, inline-only, no horizontal overflow.

### 16.4 ⭐⭐⭐ Metadata lookups were capped at 30 items per wallet

The biggest bug of the session. `needMeta` did `.slice(0, 30)`. A wallet holding
6 core + 18 tokens + 7 LP + **102 NFTs = 133 positions** got metadata for 30 of them;
the other 103 rendered as `2axE…vsax` with no name and no art.

Two ordering faults rode along:

- **price lookups did not exclude NFTs.** An NFT has no price-feed entry, so 102 of them
  consumed the entire 12-slot budget before one real token was priced.
- **metadata was fetched in raw RPC order**, so a large NFT collection pushed every fungible
  token past the cap.

Now `PRICE_LOOKUP_CAP = 40`, `META_LOOKUP_CAP = 250`, **fungibles first in both passes**.
Results persist 7 days in localStorage, so only the first visit to a wallet pays, and
`runThrottled` still bounds concurrency.

Measured on a real 133-position wallet in watch mode:

| group | before | after |
|---|---|---|
| Ecosystem · Core | — | **6/6 named** |
| SPL · Token-2022 | — | **17/18 named** |
| LP Tokens | — | **7/7 named** |
| NFTs | — | **102/102 named** |

NFT **art**, after scrolling every row into view (they are `loading="lazy"`, so an
un-scrolled probe under-reports): 102/102 have a resolved image source, **0 placeholders**,
39 decoded, 5 dead, 58 still in flight — IPFS being slow under 102 concurrent loads, not
missing art.

### 16.5 LP tokens — naming and pricing

A pairing-marketplace LP token showed as an unnamed mint under "SPL · Token-2022 Tokens".
LP mints carry **no metadata at all** (verified: `metaplex meta: NONE`) — so there is nothing
to fetch. The bug was *classification*, not resolution.

`lpMap` now also loads from the `brains_pairing` pool records via a new
**`fetchPairingLpMints()`** — deliberately NOT `fetchPairingPools()`, which skips
admin-seeded pools (`d[274] === 1`) for the marketplace listing. **6 of the 10 live pools
are seeded**, so reusing the filtered call would leave most LP holders unnamed. The label is
built from the two underlying mints at *render* time so it fills in as their metadata lands.

**Pricing.** An LP token has no market price; its worth is its claim on the pool:

    unit = (netReserveA × priceA + netReserveB × priceB) / lpSupply

**NET reserves, not raw vaults** — `protocol_fees + fund_fees` sit inside the vault but are
owed to the protocol, so an LP holder cannot withdraw against them. On the live AGI/BRAINS
pool those fees are **5.7% of vault0 and 1.1% of vault1**; ignoring them overstates the
position by **3.5%**. `XdexPoolMeta` gained `fees0`/`fees1` for this.

Reserves are stored on the `LpEntry` and the price recomputed on every repaint — the
underlying token prices arrive asynchronously, so computing once freezes it at zero.
The pairing record's `tokenA`/`tokenB` order is **not** guaranteed to match the pool's
`token0`/`token1`; sides are matched **by mint**, never by position.

**Pair icon.** An LP row rendered `h.symbol[0]` — a single "A" for AGI/BRAINS, identifying
neither side. `lpInfo` now carries `mintA`/`mintB` (+ their symbols) and `LpPairIcon` draws
both underlying tokens overlapping, each falling back to its own initial when no logo is
cached. AGI/BRAINS renders the real catbox + brains-logo art.

Verified live: 394,738 AGI + 6,446 BRAINS net of fees over 46,487 LP supply →
$0.001078/LP, $1.24 for a 1,152.41 balance (independent on-chain calc: $0.00108376 / $1.2489,
prices drifted between runs).

### 16.6 ⭐⭐⭐ AmmConfig fee split (verified offsets)

Read from `2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c`, 236 bytes:

| field | offset | value |
|---|---|---|
| `trade_fee_rate` | **12** | 2800 → **0.28%** (confirms §15.1) |
| `protocol_fee_rate` | **20** | 250000 → **25% of the trade fee** |
| `fund_fee_rate` | **28** | 50000 → **5% of the trade fee** |

So **70% of every fee stays with LPs**, 30% is skimmed into the fee accumulators.

**§15.1's curve is now validated against a REAL executed swap, not simulation.** Tx
`3KLnvYpN…` (45 XNT → NECK, 2026-08-18): predicted output
`9,395,698,663,830,289` = actual, **exact to the raw unit (1e-9)**. The pre-fix code would
have quoted `9,398,807,781,455,530` — 0.033% high, enough to trip `6005 ExceededSlippage`.
(Smaller than the ~5% error on AGI/BRAINS because this pool's accrued fees are a much smaller
share of its vaults — the magnitude is per-pool, the bug is the same.)

⚠️ The explorer's `TransferChecked` display and its balance-change rows **disagreed by 1 raw
unit**. Resolve such ambiguity by solving for the self-consistent value, not by picking one.

### 16.7 ⛔⛔ Metadata cache poisoning — a slow fetch hid a logo for 7 days

X1X showed its symbol but never its logo. `fetchMetaplexMeta` reads the on-chain symbol, then
fetches the JSON at the metadata URI. X1X's JSON is on `gateway.pinata.cloud`, which measures
a consistent **6–7s**. When that fetch lost, the function still returned a *valid* `TokenMeta`
— symbol present, `logo: undefined` — `fetchTokenMeta` **persisted it**, and the symbol-only
short-circuit then served that entry for the full 7-day TTL without ever retrying.

`TokenMeta` gained **`logoPending`** (set when a URI exists but did not resolve). Pending
entries are cached in memory but **never persisted**, and never satisfy the short-circuit.
Cache key bumped `v2` → **`v3`** because v2 rows cannot be told apart from genuinely
logo-less tokens; the old key is removed on load.

`V2NFTImage` had the same disease in a different form: a **4s** abort on the metadata fetch
while Pinata takes 3–9s, making it a coin flip — the same wallet showed some NFTs and not
others, differently each reload. The loser fell through to a **guessed** URL
(`base + ".png"`) which was then **persisted**. Now 12s, and guesses are held in state,
never cached, with every guess offered to the `<img>` error chain.

> **Rule:** never persist a "we could not resolve it this time" result as if it were
> "there is nothing to resolve". One slow moment must not become a week-long outage.

### 16.8 ⛔⛔⛔ IPFS in a browser — `curl` lies to you

The X1 Cats collection portrait (a 7 KB **SVG**) rendered as a broken tile while `curl`
reported a clean `200 image/svg+xml` with `ACAO: *` from every gateway.

    ipfs.io / dweb.link / nftstorage.link  ->  ERR_BLOCKED_BY_RESPONSE.NotSameOrigin
    fetch() from the page                 ->  TypeError: Failed to fetch

It fails identically on `about:blank` and `example.com`, so it is **Chrome + Cloudflare, not
this app**, and **no choice of public gateway fixes it**.

**The rescue is our own proxy.** `/api/nft-meta/<host>/<path>` (a Vercel rewrite in prod, a
vite middleware in dev) makes the request **same-origin**, which sidesteps CORS, ORB, CORP and
the browser-origin refusal in one move. That portrait loads in **~470ms** through it.

`src/utils/ipfsGateways.ts` builds an ordered candidate list per image — original → each
public gateway → collection rescue host → the same URLs proxied (last, because a direct hit
is faster and a direct miss fails in 100–300ms). `V2NFTImage` and the browse-rail tile walk
it on error instead of giving up after one fallback.

Also measured, all of it counter-intuitive:

- **weserv blocks the entire `.xyz` TLD** ("Domain or TLD blocked by policy") — the
  `CDN_BLOCKED` list in `lib/tokenLogos` was an enumeration of two `.xyz` hosts when the rule
  is TLD-wide.
- **`corsproxy.io` now answers 403** and **`api.allorigins.win` hangs ~19s** — both are dead
  weight in every fallback chain that still lists them.
- Two X1 Pups CIDs are unpinned everywhere; the collection serves the same art at
  `x1pups.vercel.app/thumbs/pup_<4-digit>.jpg` (verified 0001/0039/0775), added as a
  collection rescue.

Result: X1 Cats tile broken → **500px**; X1 Pups listings **3 broken → 1**.

### 16.9 Logo resolution had drifted into two implementations

NECK and DRC rendered as letter tiles in the create-listing picker while AGI and X1X were
fine. The difference was not the tokens — it was **which component drew them**.

`TokenLogo` (rounded square, used by all five listing modals) read **only its `logo` prop**:
no shared-cache lookup, no `fetchTokenLogo` backfill. An empty prop went straight to the
gradient letter tile even when the cache held the art. `TokenLogoImg` (round, swap surfaces)
has resolved correctly since `8c8cd31`.

Resolution is now a shared **`useResolvedTokenLogo`** hook; presentation stays split.
Two more bugs removed from `TokenLogo`:

- **`crossOrigin="anonymous"`** forced a CORS preflight on an `<img>` that needs no canvas
  access, so any host without an `ACAO` header failed outright when a plain `<img>` would
  have painted it.
- the **corsproxy.io retry** only ever turned one failure into two (see §16.8).

Neither component cleared `resolved` on a `mint` change with no cached art, so a reused row
could keep painting the **previous** token's logo.

`TokenLogo` is used by five modals with no `connection` prop; threading one through nine call
sites purely to fetch an image is not worth it, so the hook falls back to a lazily-created
module-level `Connection` on the same RPC.

### 16.10 Marketplace collection rail + copy buttons

- Rail widened 3 → **4 tiles**, **FEDS pinned first**. The tile keeps its gradient background
  so an exhausted candidate chain falls back to legible initials, not an empty circle.
- **`components/CopyButton`** — one implementation, wired into the portfolio holdings table
  (token mint), the swap side panel (token mint), the incinerator leaderboard and
  transactions (wallet). `PairingMarketplace`'s own `CopyButton` is now a thin `text`-prop
  wrapper over it, so its three call sites are unchanged but inherit the `execCommand`
  fallback (§16.1) and `stopPropagation` (copying inside a clickable row must not also
  select a token).

### 16.11 The swap side panel knew three tokens by name

`components/Portfolio.tsx` (the `PORTFOLIO` card on `/swap`) hardcoded XNT/BRAINS/LB and
fetched **logos** for every other mint but never **names** — so tokens rendered with correct
artwork beside a truncated mint. It now resolves symbols through the shared 7-day metadata
cache, fungibles first, rejecting the mint-prefix placeholders the metadata layer emits.

### 16.12 ⛔⛔⛔ The typecheck gate does not check anything

`tsconfig.json` is a **solution file** (`"files": []` + project references), so
`tsc --noEmit -p tsconfig.json` typechecks **zero files** and always prints 0 errors.
`npm run build` is bare `vite build`, which does not typecheck either.

    tsc --noEmit -p tsconfig.json      ->   0 errors   (vacuous)
    tsc --noEmit -p tsconfig.app.json  -> 386 errors   (the real number)

> **Rule:** use `tsconfig.app.json`. Compare **counts and messages** against a baseline
> worktree (`git worktree add /tmp/base <sha>` + symlink `node_modules`), never absolutes —
> and beware `cd x && cmd1; cmd2`, where cwd persists and both commands run in the worktree.

This session's diff, measured properly: **386 → 386**, no per-file count changed, and a
message-level diff over the seven edited files shows **93 → 93 with zero introduced and zero
fixed**. `CopyButton.tsx` and `ipfsGateways.ts` have none.

### 16.13 Known gaps — NOT fixed

- **Secure-context hardening** (§16.1): seven `crypto.subtle` sites still break over a LAN
  IP. `@noble/hashes@1.8.0` is already resolved under both `@coral-xyz/anchor` and
  `@solana/web3.js` and a sync SHA-256 already ships in the bundle, so this costs ~0 bytes.
- **Logo thumbnailing** in three places: the **header ticker** renders a
  **2.47 MB 3000×3000 PNG into a 13px slot** on every route (`Header.tsx:133`), and the
  portfolio renders logos at full source size (LB 3000px, AGI 1206px) into ~30px slots.
  Neither goes through `logoThumb`. Both pre-date this session and are live.
- **One X1 Pups listing** ("Genesis Stone #1001") fails at the **metadata** step; its image
  CID loads through the proxy in 524ms. Suspected dev-only — the vite proxy is
  single-threaded behind 14 concurrent requests where prod's rewrite is edge-level.
- **1 of 18 tokens** still truncated on the big wallet; not identified.
- **degen.fyi pre-graduation pricing** (§15.7) — still not decoded, deliberately not guessed.
- `SESSION_2026-08-01.md` and `SUPABASE_ANALYTICS_HARDENING.sql` remain untracked.

### 16.14 Verification notes

- `CreateListingModal` is **prop-driven** (`publicKey` / `connection` / `signTransaction`),
  like `SwapTab` — mount it standalone in `probe.html` + `src/_probe.tsx` with a real
  `PublicKey` and `Connection`, no wallet adapter, no signing. This is how the NECK/DRC logo
  fix was proven. Delete both files afterwards.
- **Components that call `useWallet()` internally cannot be probed** — `components/Portfolio`
  (swap side panel) renders "Connect a wallet" in the harness. Two changes shipped there
  unverified (§16.10, §16.11); they need a click-through with a wallet connected.
- **Rate limits mimic bugs, again.** `gateway.pinata.cloud` 429s after repeated probing and
  its error page carries `Cross-Origin-Resource-Policy: same-origin`, so a rescued image
  starts "failing" in 141ms and looks like a code bug. Re-measure with spacing before
  concluding. Same trap as §15.8's RPC 429s.
- **Lazy images under-report.** `V2NFTImage` is `loading="lazy"`; a probe that does not
  scroll sees ~⅓ of the images and reads as breakage.
