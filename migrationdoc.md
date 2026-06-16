# BRAINS Ecosystem — Architecture & Migration Reference

> Single source-of-truth for the whole **BRAINS / X1** ecosystem: the live DeFi hub (x1brainsv1),
> the citizenship + Genesis-NFT layer (x1city), the AI agent (X1B), the dating app (xdates), and the
> in-progress DeFi rebuild (x1brainsv2). Captured 2026-06-09 from a full read of the repos under
> `/home/kidannybm/bt`. Where docs and code disagreed, the **LIVE / on-chain** value is canonical and
> the stale one is flagged.
>
> **Golden rules**
> 1. The on-chain programs (4 for x1brains, 3 for x1city) are LIVE on **X1 mainnet**. Reuse them; do
>    not redeploy casually. Keep every address byte-identical unless a program is intentionally rotated.
> 2. **Token mints, treasury, and XDEX pools are SHARED** across projects (see §1). Never fork an
>    address in one project without updating the others (§7).
> 3. `*_mint` programs ≠ token mints. A program named `lb_mint` is *code that mints LB*; the LB **mint
>    account** is *data* the program controls. Don't conflate them.

---

## 0. Ecosystem map

Five projects, one shared on-chain economy. Everything orbits the deflationary **BRAINS** token and
the scarce Token-2022 **LB (Lab Work)** token.

| # | Project | Path | What it is | Stack | Deploy state |
|---|---|---|---|---|---|
| 1 | **x1brainsv1** | `~/bt/x1brainsv1` | BRAINS DeFi hub (x1brains.io) — 4 Anchor programs | React 18 + Vite, Python bot, Vercel api/cron, Supabase | **LIVE** (programs + site) |
| 2 | **x1city** | `~/bt/x1city-react` + `~/bt/x1city-onchain` | Citizenship + 444 Genesis NFTs — 3 Anchor programs | React 19 + Vite, cf-worker, OpenClaw plugin | **LIVE** (Path B launch 2026-06-08) |
| 3 | **X1B** | inside `x1city-react/cf-worker` + `openclaw-plugin` | The AI agent surfaced in X1.City | Cloudflare Worker + OpenClaw on Hetzner, DeepSeek | **LIVE** (`api.x1.city/chat`) |
| 4 | **xdates** | `~/bt/xdates` | Citizenship-gated dating app (xdates.app) | React 18 + Vite + Tailwind, Supabase | **Coming-soon only**; full app local-only |
| 5 | **x1brainsv2** | `~/bt/x1brainsv2` | Frontend/backend rebuild of x1brainsv1 (same programs) | React 19 + Vite, Vercel api/cron, Supabase | **Feature-complete, pre-deploy** |

```
                         ┌──────────────────────────────────────────┐
                         │   SHARED ON-CHAIN ECONOMY (X1 mainnet)     │
                         │   BRAINS mint · LB mint · XNT · treasury    │
                         │   XDEX pools (BRAINS/XNT, LB/XNT)           │
                         └──────────────────────────────────────────┘
                            ▲          ▲            ▲          ▲
        burns/mints/farms ──┘          │            │          └── plan-upgrade burns
                                       │            │
   ┌───────────────┐   reuses    ┌─────┴──────┐  ┌──┴─────────┐   citizenship-gates
   │ x1brainsv2    │────────────►│ x1brainsv1 │  │  x1city    │◄──────────────┐
   │ (DeFi rebuild)│  same progs │ (DeFi hub) │  │ citizenship│               │
   └───────────────┘             └────────────┘  │ + Genesis  │          ┌────┴─────┐
                                                  └─────┬──────┘          │  xdates  │
                                                        │ AI gate         │ (dating) │
                                                        ▼                 └──────────┘
                                                  ┌───────────┐
                                                  │    X1B    │  DeepSeek agent
                                                  │ cf-worker │  + OpenClaw (Hetzner)
                                                  └───────────┘
```

**The dependency that bites:** x1brains{v1,v2}, x1city, and xdates all read the **same** BRAINS/LB
mints, treasury, and XDEX pools. X1B is the agent layer x1city's Lab Work / DeFi features surface
through. A change to a shared address ripples across ≥3 codebases — see §7.

---

## 1. Shared canonical assets (single source of truth)

**Keep these identical everywhere.** Verified against each project's constants/Anchor.toml on 2026-06-09.

### Token mints (X1 mainnet)
| Token | Mint | Notes |
|---|---|---|
| BRAINS | `EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN` | Token-2022, 9 decimals. Burn fuel everywhere. |
| LB (Lab Work) | `Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6` | Token-2022, 2 decimals, 4 bps transfer fee, hard cap 100,000 |
| Wrapped XNT | `So11111111111111111111111111111111111111112` | native pair / fee unit |

### XDEX pools & LP mints
| Item | Address |
|---|---|
| XDEX program (Raydium CP-swap fork) | `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` |
| BRAINS/XNT pool | `7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg` |
| LB/XNT pool | `CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK` |
| BRAINS/XNT LP mint | `FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3` |
| LB/XNT LP mint | `85g2x1AcRyogMTDuWNWKJDPFQ3pTQdBpNWm2tK4YiXci` |

### Authorities & sinks
| Role | Address | Used by |
|---|---|---|
| Upgrade authority (deploy signer) | `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2` | x1brains programs (+ x1city deploy chain) |
| x1brains platform treasury / fee sink | `CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF` | x1brainsv1/v2 fees, LB transfer-fee sweep |
| x1city council (citizenship admin + XNT sink) | `CnyGhzMuv5snBGxvShxsJMDnvHcXKwRtVVUpzGX3QAuG` | x1city citizenship admin UI; Genesis mint XNT |
| x1city genesis_nft admin (deploy/CLI) | `8Js4i7dd7V9dxBws89K7ZzphEAJvdwmbowhW9ysUP7wk` | genesis_nft program admin |
| x1brains bot/web admin (UI gate) | `2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC` | x1brains admin pages + rate-limit bypass |
| Incinerator (burn black-hole) | `1nc1nerator11111111111111111111111111111111` | all burns |

> ⚠️ The treasury (`CAeTTU2z…`) and upgrade authority (`CCcJuC3B…`) recur across projects. The x1city
> **council** (`CnyGhz…`) and the x1brains **platform treasury** (`CAeTTU2z…`) are *different* sinks —
> don't unify them. See §7 for the full shared-address map.

### Endpoints
- RPC: `https://rpc.mainnet.x1.xyz` (single RPC — no fallback yet; see §8)
- Explorer: `https://explorer.mainnet.x1.xyz`
- XDEX price API: `https://api.xdex.xyz/api` (frontends proxy via `/api/xdex-price/*`)
- X1B chat: `https://api.x1.city/chat` (Cloudflare Worker)
- Cyberdyne registry (gist): `https://gist.githubusercontent.com/jacklevin74/f79f78f03a27aefbe0046bffcffb0432/raw/cyberdyne.json`
- Imperial API (tailscale, proxied `/imperial/*`): `http://jack-nucbox-m6-ultra.tail515dc.ts.net:8773/api`

---

## 2. x1brainsv1 — BRAINS DeFi hub (4 LIVE programs)

> The 4 programs below are LIVE on X1 mainnet and are **NOT redeployed** for v2. v2 (§6) is a
> frontend/backend rebuild against these same programs.

### 2.0 The core economic loop
Deflationary BRAINS DeFi hub. Burn **BRAINS** to mint scarce **LB** (cap 100k); LB grants fee
discounts and farm early-exit penalty discounts.

```
BRAINS ──burn──► lb_mint (4-tier bonding curve, cap 100k LB)
   │                  │
   │             LB held ──► fee discounts + farm penalty discounts
   ▼                  ▼
Incinerator       LP Farms / LP Pairing / NFT marketplace ──► fees ──► treasury
```
Platform revenue: marketplace fees (1.888% sale / 0.888% cancel), pairing/listing fees, farm stake
fees + early-exit penalties, daily LB Token-2022 transfer-fee sweeps.

### Programs (LIVE — verified `Anchor.toml [programs.mainnet]` + each `declare_id!`)
| Program | ID | Role |
|---|---|---|
| **lb_mint** | `3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN` | BRAINS→LB bonding-curve factory (4 tiers) |
| **brains_farm** | `Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg` | MasterChef-style LP staking with lock tiers |
| **brains_pairing** | `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM` | P2P LP marketplace, CPIs XDEX to mint pools |
| **labwork_marketplace** | `CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4` | NFT marketplace, self-custody vault PDA per listing |

> `lb_mint` is **program #1**, not the LB token. The LB **mint account** is `Dj7AY5CX…3PA6` (§1).

### 2.1 lb_mint — `3B6oAf…V6tN`
Bonding-curve mint: burn BRAINS + pay XNT (native lamports) → receive LB. Token-2022 with
`TransferFeeConfig` (4 bps) + `MetadataPointer`.
- **GlobalState** PDA seed `b"lb_state"`: admin, treasury, lb_mint, total_minted, paused, bump (146 B).
- **Curve (4 tiers, hard cap 100,000 LB):**

  | Tier | LB range | BRAINS / LB | XNT / LB (LIVE) |
  |---|---|---|---|
  | 0 | 0–25k | 8 | 1.11 |
  | 1 | 25k–50k | 18 | 2.22 |
  | 2 | 50k–75k | 26 | 3.33 |
  | 3 | 75k–100k | 33 | 4.44 |

  > XNT fees were **tripled in April 2026** after a mint-and-dump arb. BRAINS burn rates unchanged.
  > `scripts/update_tier_rates.js` still hardcodes OLD rates (0.50/0.75/1.00/1.50) — **stale, do not
  > run as-is** (§8).
- **Instructions:** `initialize`, `mint_lb`, `combo_mint_lb` (BRAINS + xenblocks XNM/XUNI/XBLK bonus,
  50/50 burn/treasury split), `update_admin`, `initialize_metadata`, `update_metadata_uri`,
  `pause`/`unpause`, `collect_fees` (sweep withheld transfer fees → treasury).
- **Money flow:** BRAINS → incinerator (deflation), XNT → treasury, transfer fees → treasury.

### 2.2 brains_farm — `Ci1qDt…FJpg`
MasterChef-style LP staking with lock tiers.
- **Accounts:** `FarmGlobal` (`b"farm_global"`, 107 B), `Farm` (`b"farm", lp_mint, reward_mint`, **229 B**),
  `StakePosition` (`b"position", owner, farm, nonce`, **158 B**).
- **Accumulator:** `acc_reward_per_share` scaled by **ACC_PRECISION = 1e18**; emissions capped at vault balance on settle.
- **Lock tiers:** Locked30 → 2× (20000 bps), Locked90 → 4× (40000 bps), Locked365 → 8× (80000 bps).
- **Early-exit penalty ladder (by LB held):** Grace (0–3 d) no penalty but **rewards forfeited**;
  Period 1 (3d–50% lock) 4.0/1.888/1.0/0.5% for `<33/≥33/≥330/≥3300` LB; Period 2 (50%–unlock)
  1.888/0.888/0.444/0.222%; Mature 0%. Forfeited LP → treasury; forfeited rewards stay in vault.
- **Instructions:** `initialize_global`, `create_farm` (validates LP origin = brains_pairing PoolRecord
  or XDEX), `fund_farm`, `stake`, `claim` (24h cooldown, blocked in grace), `unstake`, `pause`/`unpause`,
  `update_rate` (±2× cap), `withdraw_rewards`, `force_mature_position`, `close_farm` (0 staked + empty vault).
- **Constants:** stake fee 0.005 XNT; min stake 100 raw; max 100 positions/(user,farm); claim cooldown
  86400 s; grace 259200 s; rate-limit window 3600 s.

### 2.3 brains_pairing — `DNSefS…bgJM`
P2P LP marketplace: list token A, match with token B, CPI to XDEX to mint the pool.
- **Accounts:** `GlobalState` (`b"global_state"`, 107 B), `ListingState` (119 B), `PoolRecord`
  (`b"pool_record", pool_address`, 274 B — also read by brains_farm to validate LP origin), `WalletState`
  (46 B), `MatchCommitment` (114 B), `MatchIntent` (186 B, **must be consumed same slot it is created**).
- **Fees (→ treasury, lamports):** Listing 0.888% (ecosystem/≥33 LB) else 1.888%, floor 0.1 XNT;
  Delist 0.444%, floor 0.1 XNT (works even paused); Match same tiers; Edit flat 0.001 XNT.
- **Match flow (2-step, single tx):** `prepare_match` (TVL ≥ ~$300, USD parity ±0.5%, XNT cross-validated
  ±5% vs XNT/USDC.X pool; commit-reveal for ≥$10k: wait ≥3 slots, reveal ≤150 slots, hash =
  keccak(token_b_mint|amount|matcher|nonce)) → `execute_match` (same-slot guard, CPI XDEX init pool;
  LP split: burn_bps% → incinerator, 5% → treasury, rest by USD contribution).
- **Constants:** min listing $1; burn_bps whitelist {0, 2500, 5000, 10000}; rate limit 2 listings/hr
  (admin bypass); large-listing threshold $10k; min pool TVL ~$300; NFT detector rejects decimals ≤1.
- ⚠️ **Ghost-deploy hazard** — program-ID keypair lost in the Anchor 0.31→0.32 upgrade. See §8.

### 2.4 labwork_marketplace — `CKZHwo…rLaD4`
NFT marketplace, self-custody vault PDA per listing.
- **Accounts:** `SaleAccount` (`b"sale", nft_mint, seller`, 90 B), Vault token account (`b"vault",…`, holds 1 NFT).
- **Instructions:** `list_nft(price)` (min 1,000,000 lamports, no fee), `update_price` (free),
  `cancel_listing` (0.888% → platform, works when paused), `buy_nft` (1.888% → platform, 98.112% → seller).
- **Fee denominator 100_000:** sale `1888/100000`, cancel `888/100000`.

### Cross-program safety patterns (preserve in any v2 program work)
Reentrancy `is_locked` in global state; Token-2022 transfer-fee-aware transfers
(`transfer_checked_with_fee`, balance snapshot before/after); XNT price oracle cross-validation;
grace-period reward forfeiture closes the stake→claim→grace-exit exploit; delist/unstake always work
even when paused (user funds never locked).

### Frontend (React 18 + Vite, ~16 pages)
Routes (`src/App.tsx`): `/` Home · `/portfolio` · `/labwork` (NFT mktplace) · `/labworkdefi`
(PairingMarketplace) · `/lpfarms` · `/incinerator-engine` · `/burn-history` · `/cyberdyne` · `/rewards`
· `/x9b7r41ns/ctrl` (AdminRewards) · `/x9b7r41ns/analytics` · `/x9b7r41ns/bot` (BotAdmin).
Admin gating: `publicKey === ADMIN_WALLET` (`2nVaSv…WnuC`); all writes via `/api/admin` with
**Ed25519-signed** envelopes over `{action, payloadHash, ts, nonce}`.

### Backend (3 surfaces)
- **Python bot (Fly.io, `bot/`):** Telegram event broadcaster. Pure poller (scale=1 to avoid double-post),
  polls X1 RPC ~5–15 s, classifies 6 event types per token via vault-balance deltas + instruction-disc
  decoding. Writes last-seen sigs to Supabase via service key.
- **Vercel api (`api/`):** `/api/admin` (~27 actions, Ed25519 auth, ±60 s window); `_bot-actions.ts`
  (bot mgmt + on-chain vault auto-detect); `cron-collect-lb-fees.ts` (**daily 00:00 UTC** harvest LB
  withheld fees → `collect_fees` → treasury); `cron-snapshot.ts` (**daily 02:00 UTC** portfolio USD snapshots).
- **Supabase:** RLS everywhere; 16 tables + `bot-banners` bucket. Tables: `bot_connection`, `bot_settings`,
  `bot_state`, `nfa_acceptances`, `labwork_rewards`, `labwork_submissions`, `labwork_points`,
  `weekly_config`, `challenge_logs`, `announcements`, `burn_events`, `portfolio_snapshots`,
  `send_history`, `saved_addresses`, `page_views`, `site_events`.

---

## 3. x1city — Citizenship & Genesis NFT (3 LIVE programs)

> **Separate ecosystem from x1brains** — different programs, shared token mints. Public **Path B
> launch on 2026-06-08** rotated all 3 program IDs fresh. Values below verified against
> `x1city-onchain/Anchor.toml`, each `declare_id!`, and `x1city-react/src/constants.ts` on 2026-06-09.

### Programs (LIVE)
| Program | ID | Role |
|---|---|---|
| **x1city_citizenship** | `5xke3nmnBXtw6gqjWuK766AQQDaPYWZPvHqtTArKgFQg` | Root identity: citizen data, stamps, AI-agent slots, burn-for-AI-access (CPI), NFT transfer hook |
| **x1city_ai_access** | `12Hy42BxNpgJkhC7XTdJ9sVxh8EacaR7upXhG4vgkcYK` | Per-citizen `ai_messages_remaining` ledger; written by citizenship + metering authority |
| **x1city_genesis_nft** | `GQPGh1M6xwwWLdGCmWum2BhPi6gkJaoNFXyyuXpgN59v` | Standalone 444-edition mint (bonding curve, Geiger entropy); eventually frozen |

Split-by-design (memory `feedback_program_admin_split`): citizenship admin = council `CnyGhz…QAuG`
(browser); genesis_nft admin = `8Js4i7dd…7wk` (deploy/CLI). Do **not** unify.

### Genesis NFT mint
- **Collection** "Brains Elites" / symbol `X1CITY`, 444 editions (SPL + Metaplex master edition).
- **Bonding curve (LIVE):** linear **33 → 444 XNT** (edition #1 = 33 XNT, #444 = 444 XNT); lifetime
  ~105,894 XNT → council. Mint XNT goes to council `CnyGhz…QAuG`.
- **Mint flow:** `claim_edition(max_price)` (pays XNT, requests Geiger entropy, inits PendingMint) →
  wait ~6 s (Geiger) or ~15 s (SlotHashes fallback) → `complete_edition(art_type, tier, uri)` (picks
  edition from unset bitmap, verifies manifest hash vs Arweave, mints) → frontend chains
  `register_genesis_from_external_mint(mint)` on citizenship to create CitizenNftData.
- **Commitment scheme:** edition→tier mapping lives in local codebase only; on-chain stores hashes —
  defuses oracle-bias attacks (memory `project_genesis_commitment_defends_bias`).
- **Arweave (Phase D, post El Guey/La Guey glow restore):** Image manifest `iE3YvEUz…tZaQ`, Metadata
  manifest `1nF0PPw_…U8juZk`, Collection JSON `nO-E2BKX…S4DI`. Roster thumbnails on R2
  (`pub-001d9ad5c23d4cd18a5ee009975a5002.r2.dev`).
- **Registration burns:** Genesis = 444 BRAINS; Regular Citizen = 111 LB (both → incinerator).
- **VIP Pass** = council-issued stamp (category 1, gold ★), **sub_category_id = 37** on the current
  deploy (drifts with initial sub-cat count — re-probe after any redeploy via `scripts/probe-vip-subcat.mjs`).
- Genesis ↔ Regular Citizen are **mutually exclusive** per wallet (memory `project_genesis_regular_exclusion`).

### Frontend (React 19 + Vite, deployed Vercel → x1.city)
Routes: `/` · `/whitepaper` · `/citizenship` · `/citizenship/mint` · `/citizenship/id` (ID card) ·
`/citizenship/credentials` (passport) · `/citizenship/registry` (444-tile roster wall) · `/agent` (X1B
terminal, AI-gated) · `/council/*` (admin chamber, allowlist `CnyGhz…QAuG`: citizens, stamps, programs,
genesis dashboard, X1B metrics).
Credential ownership uses `validateCredentialOwnership` (six-state tagged union — `WalletCitizenLink`
alone is not proof; wallet must still hold the linked mint; memory `feedback_credential_ui_must_match_onchain`).
Latest architecture: `x1city-react/ARCHITECTURE.md` **§102** (Path B launch + post-launch debug marathon).

### cf-worker / OpenClaw plugin
`x1city-react/cf-worker` and `x1city-react/openclaw-plugin` host **X1B** — see §4. The plugin mirrors
x1city program IDs/mints in its own `constants.ts`; keep in sync with `src/constants.ts` on every PID
rotation (the PID-rotation sweep map is the §7/§8 hazard).

---

## 4. X1B — the AI agent

> The production chat agent surfaced inside X1.City (`/agent`). Backed by **DeepSeek only** — no
> Anthropic/OpenAI keys provisioned (memory `project_x1b_provider_lockin`). Vendor identity is scrubbed
> from the response stream.

### Topology
```
React Terminal ──► api.x1.city/chat (Cloudflare Worker "x1b-chat")
                        │  Ed25519 wallet-sig auth · intent classify · SSE translate · identity scrub
                        ├─ chitchat fast path ──► DeepSeek direct (deepseek-chat)
                        └─ tool turns ──► OpenClaw gateway 127.0.0.1:18789 (Hetzner) ──► DeepSeek (pro/flash)
```
- **cf-worker** (`api.x1.city/chat`): owns 100% of production chat (the old Vercel
  `api/protocol/chat.ts` was deleted 2026-05-30). Classifies intent, routes, proxies OpenClaw, scrubs
  vendor names, plan-token binding (write-preview ↔ confirm via HMAC). XT0 traffic bypasses OpenClaw
  and hits DeepSeek directly.
- **Model routing:** tool turns → `x1b-pro` (`deepseek-v4-pro`); chitchat → `deepseek-chat` direct;
  flash as fallback. `tool_choice: {type:"any"}` (Anthropic-block form survives OpenClaw's
  required→auto downgrade; memory `project_x1b_tool_choice_saga`).
- **OpenClaw plugin:** tool families branded `x1b_*` / `x1city_*` / `agent_*` (built-ins shadow same-named
  plugin tools — always brand new tools; memory `feedback_openclaw_tool_name_collision`). Server-bypass
  execute route verifies an HMAC `op_nonce` so the model is off the confirm turn (anti-fabricated-signature
  defense; memory `project_x1b_fabricated_signature`).

### Agent hot wallet
Per-citizen keypair, deterministic v2 derivation, AES-256-GCM (KEK from wallet signature), multi-tenant
since 2026-05-25 (`~/.x1city/agent-keys/by-citizen/<wallet>/active.json`). Caps: per-tx + per-24h XNT
(citizen-set in `policy.json`; default 1.0/tx, 10/24h). Hash-chained audit log `tx-log.jsonl`. Write
tools: `agent_send_xnt`, `agent_send_token`, `agent_swap`, `agent_burn_token`. Vault cache keyed by
SHA-256(active.json), never mtime (memory `project_vault_cache_content_hash`).

### XT0 vs X1B
**XT0** = free info/guide tier (DeepSeek direct, no tools, wallet-write refusal, **50 msg/wallet/24h**
via Durable Object). **X1B** = full agent (tools + on-chain writes + image gen). Both require Ed25519
wallet-sig auth (`x1city.chat.auth:<wallet>:<iso8601>`).

### Hosting
- Worker: Cloudflare Workers (`x1b-chat`), route `api.x1.city/chat`.
- Gateway: **Hetzner CPX21** `5.78.216.223` (Hillsboro), `x1b` service user, systemd
  `x1b-gateway.service` running OpenClaw on `127.0.0.1:18789`. Deploy = rsync + `systemctl restart`.
- Named CF tunnel `api.x1.city` (tunnel id `0bd81fd8…`).
- Wrangler auth: `source ~/.x1city-secrets.env` then deploy (no browser login; memory `reference_wrangler_auth`).
- Self-reporting: `report_observation` tool writes to `/home/x1b/.x1city/observations/YYYY-MM-DD.md`.

---

## 5. xdates — citizenship-gated dating app

> Source `~/bt/xdates`; canonical docs `xdates/xdates.md` (symlinked `CLAUDE.md`, both gitignored).
> Public site ships **coming-soon only**; the full app is **local-only**.

### What it is
A citizenship-gated dating app for X1 citizens. Identity is anchored to the X1 **citizenship** PDA;
chat/media stay off-chain (Supabase / IPFS) for privacy + cost. BRAINS integration monetizes plans:
Free (limited daily swipes) → Plus (burn BRAINS) → Premium (burn more BRAINS / month). Non-citizens get
a CTA to register at x1.city (drives Regular Citizen burns).

### Stack
React 18 + Vite + Tailwind v4; `@solana/wallet-adapter-react`; `@solana/web3.js` for citizenship reads;
Supabase (Postgres + Realtime) for MVP profiles/swipes/matches/messages; IPFS (Pinata) for photos
(Arweave later). RPC `https://rpc.mainnet.x1.xyz`. Hosting Vercel.

### Deployment state
- **LIVE: coming-soon page only** at `https://www.xdates.app` (Vercel, auto-deploy on `main`).
- **Full app local-only:** `src/App.tsx` + `src/main.tsx` tracked but `git --skip-worktree`; all real
  pages/components under `.gitignore`. `LAUNCH_LOCKED = true`; dev bypass `?preview=xdates-dev`.
  `Offlinesite/` holds a static snapshot of the coming-soon HTML (not deployed).
- **Launch flip:** undo `--skip-worktree`, unignore real-app paths, set `LAUNCH_LOCKED = false`, push.

### On-chain / token integration
- BRAINS mint (shared, §1) for plan upgrades.
- Will read the X1 **citizenship** PDA to gate access — but as of 2026-06-10 this is **not yet wired**:
  xdates `src/` has no citizenship-read code or PID at all. When the gate ships, it **must use the
  CURRENT citizenship PID `5xke3nmn…KgFQg` (§3)** — a pre-Path-B PID would silently resolve zero
  citizens. See §7.
- A dedicated `xdates_dating` Anchor program (profiles/swipes/matches PDAs) is **deferred to Phase 8** —
  not yet deployed.

### Build status
Coming-soon landing done + deployed. App shell + 8 stub pages (Landing, ProfileWizard, SwipeDeck,
Explore, Matches, Chat, MyProfile, Plans) exist locally; Supabase writes, real swipe/match logic, chat
Realtime, and token-burn mechanics are **not yet functional**. On-chain migration + Arweave photos are
Phase 8.

---

## 6. x1brainsv2 — the DeFi rebuild (in progress)

> This folder. A frontend/backend rebuild of x1brainsv1 that talks to the **same** live programs,
> mints, pools, treasury, and Supabase project (§1/§2). **Reuses all v1 addresses — no fork.**

### Stack
React 19 + Vite 7, TypeScript, Vercel (SPA + serverless `/api/`), Supabase (anon reads, service-role
admin writes), `tweetnacl` Ed25519 for admin auth. Same RPC `rpc.mainnet.x1.xyz`.

### Routes (all `V2*`, feature-complete)
`/` V2Home (boost carousel + dual price/burn reactors + mainnet monitor + TWAP charts) · `/labwork`
V2LabWork (NFT mktplace + native boost) · `/admin` V2Admin (dual-wallet gate, analytics + bot panels)
· `/charts` V2Charts (`V2XdexPoolsList`, on-chain TWAP, native deposit/withdraw) · `/portfolio` ·
`/swap` · `/labworkdefi` V2LpPairing · `/lpfarms` V2LpPools · `/mint-labwork` · `/burn-history` ·
`/incinerator-engine` · `/cyberdyne` (stub, Imperial API). v1 page components still in the tree but
unmounted; `RewardsSeason` retired.

### What's new vs v1
- **Boost carousel** (3 site-wide slots): SPARK (1k BRAINS / 24h) · GODSLAYER (2.5k / 3d) · INCINERATOR
  (5k / 7d); **1.888 points / BRAINS** (Token-2022 `burnChecked`).
- **On-chain TWAP pool charts** (reads observation account; no XDEX-API rate limit, unlike v1).
- **Native deposit/withdraw** modals embedded in `/charts`.
- **Dual-wallet admin** (council + v1-admin equally privileged) with per-action Ed25519 `signMessage`.
- Daily **portfolio-snapshot cron**, activity-log program-ID labels, IPFS/Arweave/CDN image fallback
  chain, systematic stale-while-revalidate caching + incremental sig scans.

### Supabase additions (`SUPABASE_SCHEMA_BOOSTS.sql`)
Adds `labwork_boosts` (one active boost per listing_pda; tier; brains; tx_sig UNIQUE; expires_at) and
`labwork_points` (wallet; brains_burned; points; tx_sig UNIQUE) on top of v1's 16 tables (shared
project). Anon RLS (the burn tx is the gate). **These tables are NOT in v1's schema — must run the SQL.**

### api/ backend
`/api/admin` (Ed25519 dispatcher, same contract as v1 + `_bot-actions.ts`); `/api/cron-snapshot`
(daily 02:00 UTC). Vercel rewrites for xdex-price/xdex-mint/nft-meta/imperial + SPA fallback.

### Status & pre-deploy checklist (per `PROJECT.md`)
Feature-complete code; **not yet deployed.** Remaining: ① run `SUPABASE_SCHEMA_BOOSTS.sql`; ② `npm
install`; ③ copy v1 Supabase env vars to v2 Vercel project; ④ set `CRON_SECRET`; ⑤ (optional) restore
the one lost boost row; ⑥ push when ready. **XT0 guide widget is deferred / not started** —
`INTEGRATION-FROM-X1CITY.md` still references the old anon-XT0 contract; update when v2 chat work begins.

---

## 7. Cross-ecosystem dependencies & drift hazards

The ecosystem's biggest risk is **shared on-chain state read from many codebases**. When one address
changes, every consumer must be updated in lockstep.

### Shared-address map — change once, update everywhere
| Asset | Canonical (§1) | Consumed by |
|---|---|---|
| BRAINS mint | `EpKRiK…BtPN` | x1brainsv1, x1brainsv2, x1city (burn-to-register), xdates (plans) |
| LB mint | `Dj7AY5CX…3PA6` | x1brainsv1, x1brainsv2, x1city (Regular-Citizen burn) |
| XDEX pools / LP mints | §1 | x1brainsv1, x1brainsv2, X1B (agent_swap) |
| Platform treasury | `CAeTTU2z…K9XF` | x1brainsv1/v2 fees |
| x1city council | `CnyGhz…QAuG` | x1city citizenship admin + Genesis XNT sink |

### Active drift / things to verify
1. **xdates citizenship gate is still a stub** — verified 2026-06-10: xdates `src/` has **no
   citizenship-read code and no citizenship PID at all** (only the shared BRAINS mint, wrapped XNT,
   and an IPFS hash appear). So there is no stale-PID drift risk today. When the Phase-8 on-chain gate
   is wired, point it at the current live citizenship PID `5xke3nmn…KgFQg` (not a pre-Path-B value —
   a stale PID would silently resolve zero citizens).
2. **x1city PID-rotation sweep** — Anchor 0.32 reads program id from `idl.address`. A rotation must
   sweep **all** of: `Anchor.toml`, each `declare_id!`, `src/constants.ts`, `.env.local`, the
   **openclaw-plugin** `constants.ts`, **and every `idl/*.json` address field** (the ai_access + genesis
   IDL addresses were missed once — memory `feedback_pid_rotation_sweep_idl_address`). The 13-surface
   rotation map is in memory `project_deploy_b_redux_bugs_caught`.
3. **VIP Pass sub_category_id drift** — currently 37; recomputes from initial sub-cat count on any
   citizenship redeploy. Re-probe with `scripts/probe-vip-subcat.mjs`.
4. **X1B ↔ x1city coupling** — X1B's OpenClaw plugin embeds x1city program IDs + mints. A citizenship/
   ai_access rotation requires redeploying the plugin to Hetzner (rsync + `systemctl restart
   x1b-gateway`), or the agent reads stale program state.
5. **x1brainsv2 ↔ v1 shared Supabase** — v2 layers `labwork_boosts`/`labwork_points` onto v1's existing
   project. Don't migrate/rename v1 tables without checking v2 consumers.
6. **GENESIS_NFT_PROGRAM_ID cross-program constant** — citizenship references genesis_nft for
   `findProgramAddress`; both must rotate together.

---

## 8. Per-project deploy models & known risks

### Deploy models
- **x1brains lb_mint** — standard `anchor deploy`; init once via `scripts/initialize-lb-mint.ts`.
- **x1brains brains_farm** — keypair matches `declare_id!`; `./scripts/deploy-brains-farm.sh`
  (auto-detects first-deploy vs upgrade; checks balance ≥6 XNT).
- **x1brains brains_pairing** — ⚠️ **HAZARD: never `anchor deploy`.** Program-ID keypair lost in the
  Anchor 0.31→0.32 upgrade; local `target/deploy/brains_pairing-keypair.json` is now a mismatched pubkey
  (`C3vwW3As…jS4Q`). `anchor deploy` would silently deploy a ghost program and burn ~3–4 XNT. **Use
  `./scripts/deploy-brains-pairing.sh`** (`solana program deploy --program-id DNSefSA…` with
  upgrade-auth sig). Rollback binary `~/brains_pairing_v11_backup.so` (md5 `a140be50…c1c6`).
- **x1city programs** — per-program `cargo build-sbf --manifest-path` to dodge feature-unification
  (896-byte stub gotcha; memory `project_x1city_onchain_build`). Path B runbook:
  `x1city-react/MONDAY_DEPLOY_RUNBOOK.md` (21 steps). `x1city-onchain/` is **filesystem-only, no git** —
  back up before risky edits.
- **X1B** — cf-worker via `wrangler deploy`; OpenClaw plugin via rsync to Hetzner + `systemctl restart`.
- **xdates** — Vercel auto-deploy on `main` push (ships coming-soon); full launch = unlock flags +
  unignore + push.
- **x1brainsv2** — Vercel; gated on the §6 pre-deploy checklist.

> Push split (memory `feedback_user_pushes_not_claude`): `git push origin main` (triggers Vercel) is
> **user-only**. Claude handles cf-worker `wrangler deploy`, Hetzner systemd, OpenClaw reloads, Tailscale.

### Known stale / risky items
1. **brains_pairing ghost-deploy** (above) — loudly documented; carry into all ops.
2. **`update_tier_rates.js` stale** — hardcodes OLD lb_mint XNT fees (0.50/0.75/1.00/1.50); live =
   1.11/2.22/3.33/4.44. Running it reverts the April-2026 hike. Fix constants before any tier-rate tx.
3. **Old `VITE_SUPABASE_SERVICE_KEY` leak** — was bundled client-side once; env var removed but **rotate
   the service key** as part of v2 secrets.
4. **Bot LP detection unconfirmed in prod** — shipped + unit-tested, never observed firing; re-validate.
5. **Banner upload broken** — admin UI; likely storage RLS / file validation.
6. **Hardcoded BRAINS LP mint in `bot/config.py`** (`FSFjPXo9…`) — breaks if pool recreated; read from
   pool state on-chain in v2.
7. **Single RPC, no fallback** — bot + crons + every frontend depend on `rpc.mainnet.x1.xyz`; add a fallback.
8. **Cron nonce replay window** — in-memory nonce cache lost on Vercel cold start; ±60 s replay (limited
   by idempotent upserts). Consider a durable nonce store.
9. **Pinned deps** — Vite stays on **v7** (Vite 8/rolldown white-screens prod; memory
   `feedback_vite_pin_v7`). Byte-stability required for agent v2/vault challenge strings across
   `agentWallet.ts` / `recovery.html` / plugin `agentVault.ts` (drift → unrecoverable funds).

---

*Source: full read of `~/bt/{x1brainsv1, x1brainsv2, x1city-react, x1city-onchain, xdates}` on
2026-06-09. Program IDs verified against `Anchor.toml`, `declare_id!`, and frontend constants. Where v1
docs and code disagreed (tier rates, citizenship PID), the LIVE / on-chain value is canonical and the
stale one is flagged in §7–§8.*
