# X1 Brains v1 — On-Chain Programs Reference

Complete reference for the **4 mainnet Anchor programs** (Anchor **0.32.1**, X1 mainnet `https://rpc.mainnet.x1.xyz`). Compiled for upgrade planning. Source: `programs/*/src/`.

> ⚠️ **TWO upgrade authorities** (verified on-chain 2026-06-13 via `solana program show`):
> - `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2` (= `~/.config/solana/id.json`) → **brains_pairing, brains_farm**
> - `E2JtCatV4dE2pLWvvtgQusNMf3HCKHieKhsyUz4r88DR` → **lb_mint, labwork_marketplace** — you must sign with THIS keypair to upgrade those two.
>
> Treasury (fees) for all 4: `CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF`. The in‑code program **ADMIN** (runtime config: pause, create_farm, etc.) for brains_pairing/brains_farm = `CCcJuC3B…vcY2`; lb_mint's runtime admin is whatever `GlobalState.admin` was set to at init; labwork_marketplace has no admin (permissionless, hardcoded platform wallet).
>
> **Live deployed sizes (2026-06-13):** lb_mint 432152 B (slot 46242749) · labwork_marketplace 315152 B (slot 38891709) · brains_pairing 622832 B (slot 42408986) · brains_farm 531760 B (slot 45186247).

---

## 0. Program index

| Program | Mainnet ID | Token std | Purpose | src |
|---|---|---|---|---|
| **lb_mint** | `3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN` | Token‑2022 | Mints the LB (Lab Work) token on a 4‑tier bonding curve by burning BRAINS (+ optional Xenblocks) and paying XNT | single file (485 L) |
| **brains_pairing** | `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM` | Token‑2022 | LP Pairing marketplace: escrow a token → matcher pairs with XNT → CPIs xDEX to create a pool, splits/burns LP | modular |
| **brains_farm** | `Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg` | Token‑2022 | LP‑staking farms (30/90/365‑day locks, MasterChef accumulator, LB‑tiered early‑exit penalties) | modular |
| **labwork_marketplace** | `CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4` | **classic SPL** | NFT marketplace: list / buy / cancel / update‑price (XNT‑priced, 1.888% sale fee) | single file (357 L) |

**Shared ecosystem addresses:** BRAINS `EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN` (9 dec) · LB `Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6` (**2 dec**) · WXNT `So111…112` · xDEX `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` · xDEX LP auth `9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU` · incinerator `1nc1nerator11111111111111111111111111111111`.

---

## 1. DEPLOY / UPGRADE mechanics (read before any upgrade)

- **Upgrade authority is split** (need the right keypair per program — see top callout): `CCcJuC3B…vcY2` signs brains_pairing + brains_farm; **`E2JtCat…88DR` signs lb_mint + labwork_marketplace**. Upgrades need only the authority signature, not the program‑ID keypair.
- **`brains_pairing` is a landmine for `anchor deploy`.** Its local `target/deploy/brains_pairing-keypair.json` was regenerated during the 0.31→0.32 bump and points to a *different* address (`C3vwW3As…`). Running `anchor deploy` would burn ~3–4 XNT deploying a ghost program and leave the real one untouched.
  - **Always upgrade via `./scripts/deploy-brains-pairing.sh`** (wraps `solana program deploy --program-id DNSefSA…`, runs 8 pre/post checks, logs to `DEPLOY_LOG.md`, `--dry-run`/`--yes` supported).
  - v1.1 rollback binary: `~/brains_pairing_v11_backup.so` (md5 `a140be5030c16cc6427172334011c1c6`).
- **`brains_farm`** has its own `./scripts/deploy-brains-farm.sh`.
- **lb_mint / labwork_marketplace** — standard upgradeable deploy via the authority (no documented keypair hazard).
- **⚠️ Duplicate source:** `programs/brains_pairing/src/lib.rs` (130 L, **canonical**, referenced by `Anchor.toml [programs.mainnet]`) **differs** from the nested `brains_pairing/programs/brains_pairing/src/lib.rs` (118 L, legacy/standalone). Upgrade from `programs/brains_pairing`, not the nested copy.
- All built with **`init-if-needed`**; Token‑2022 features enabled on lb_mint/pairing/farm; `idl-build` present.
- `brains_farm` has a `force_mature_position` ix gated behind `--features admin-test-tools` — **mainnet binaries must be built WITHOUT that feature**.

---

## 2. lb_mint — LB bonding-curve mint (Token-2022)

**What it does:** Mints LB by burning BRAINS at a tier rate + charging XNT, capped at 100,000 LB. LB is a Token‑2022 mint **created by the program** (PDA `[b"lb_mint"]`) with a 4‑bps transfer fee + metadata pointer. `combo_mint_lb` lets you add Xenblocks (XNM/XUNI/XBLK) for bonus LB (half burned, half to treasury).

**Constants:** LB_DECIMALS `2`, LB_MULTIPLIER `100`, TRANSFER_FEE_BPS `4`, TOTAL_SUPPLY `100_000`, TIER_SIZE `25_000`. Tiers `(brains_per_lb, xnt_lamports_per_lb)`: `(8, 1.11 XNT)`, `(18, 2.22)`, `(26, 3.33)`, `(33, 4.44)`. Xenblocks: XNM_PER_LB `1000`, XUNI `500→4 LB`, XBLK `1→8 LB`. Treasury `CAeTTU…K9XF`; mints BRAINS `EpKR…BtPN`, XNM `XNMbEw…ET4m`, XUNI `XUNigZ…G2Bm`, XBLK `XBLKLm…2kj7T`.

**PDA seeds:** state `[b"lb_state"]` · mint `[b"lb_mint"]` · mint authority `[b"lb_mint_auth"]`.

**Instructions:**
| ix | who | params | does |
|---|---|---|---|
| `initialize` | admin | — | Creates the LB mint (transfer‑fee + metadata‑pointer ext), inits `GlobalState` |
| `update_admin` | admin | new_admin | Transfer admin |
| `initialize_metadata` / `update_metadata_uri` | admin | name/symbol/uri | Token‑2022 metadata (uri ≤200) |
| `pause` / `unpause` | admin | — | Halt/resume minting |
| `collect_fees` | (perm) | remaining=fee sources | Harvest withheld transfer fees → treasury LB ATA |
| `mint_lb` | user | brains_amount | Burn BRAINS (must be exact multiple of tier rate) + pay XNT → mint LB |
| `combo_mint_lb` | user | brains, xnm, xuni, xblk | mint_lb + Xenblocks bonus (each split burn/treasury) |

**State `GlobalState`** (LEN 146): admin, treasury, lb_mint, total_minted u64, paused bool, bump, _reserved[32].

**Errors:** Paused, ZeroAmount, NoXenblocks, BrainsNotMultiple, Xnm/XuniNotMultiple, SupplyExhausted, Insufficient{Brains,Xnt,Xnm,Xuni,Xblk}, Invalid{BrainsMint,Treasury,LbMint,Xnm/Xuni/XblkMint,Ata}, Unauthorized, Overflow, UriTooLong.

---

## 3. brains_pairing — LP Pairing marketplace (Token-2022, modular)

**What it does:** A lister escrows token A at a USD valuation; a matcher pairs it with token B + XNT; the program CPIs xDEX `initialize` to create the pool, then splits LP: **100 min‑lock + burn% (user‑chosen) + 5% treasury + 50/50 lister/matcher**. Fees in XNT (0.888% ecosystem/LB‑discount, 1.888% standard). Large listings (≥$10k) require commit‑reveal. `prepare_match`+`execute_match` must be **same slot** (atomicity).

**Admin/treasury:** ADMIN `CCcJuC3B…vcY2`, TREASURY `CAeTTU…K9XF`, INCINERATOR `1nc1ner…1111`, rate‑limit bypass dev wallet `2nVaSvCq…WnuC`.

**Key constants:** FEE_BPS ecosystem/discount `88`, standard `188`, delist `44`, edit `0.001 XNT`, fee floor `0.1 XNT`, LB discount threshold `3300` (33 LB). TREASURY_LP_BPS `500`. MIN_LISTING_USD `$1`, LARGE_LISTING `$10k`, MIN_POOL_TVL `$300`, price tolerance `5%`, USD parity `0.5%`, max price age `60s`, max impact `10%`. Rate limit `2 listings/hr`. Burn whitelist `[0, 2500, 5000, 10000]`. Commit‑reveal `3..150 slots`. xDEX AMM configs A `2eFPWo…248c` / B `ECVmuj…FL4x`, fee vault `SKc6b6…KDuF1`, `DISC_INITIALIZE = af af 6d 1f 0d 98 9b ed`. Oracle pools: BRAINS/XNT `7deZor…AxrUg`, XNT/USDC.X `CAJeVE…oxRvR`.

**Instructions:** `initialize_protocol`, `pause`/`unpause`, `flag_wallet`/`unflag_wallet`, `seed_pool_record` (admin — registers an existing xDEX pool, **`seeded=true`**); `create_listing`, `edit_listing`, `delist`, `emergency_withdraw` (always works, even paused, no fee); `commit_match` → `prepare_match` → `execute_match` (the match flow).

**State accounts (PDA seed · data LEN incl. 8‑byte disc):**
- **GlobalState** `[b"global_state"]` (115): admin, treasury, total_fee_xnt, total_listings, total_pools_created, open_listings, paused, is_locked, bump.
- **ListingState** `[b"listing", creator, token_a_mint]` (127): creator, token_a_mint, amount, usd_val, xnt_val, mc, burn_bps, is_ecosystem, status(Open/Matched/Delisted), escrow_bump, escrow_auth_bump, created_at, bump.
- **PoolRecord** `[b"pool_record", pool_address]` (**282**): `pool_address@8`, `lp_mint@40`, `token_a_mint@72`, `token_b_mint@104`, `sym_a@136[12]`, `sym_b@148[12]`, `burn_bps@152`, `lp_burned@154`, `lp_treasury@162`, `lp_user_a@170`, `lp_user_b@178`, `creator_a@186`, `creator_b@218`, `usd_val@250`, `created_at@258`, **`seeded@266`** (1=admin‑seeded xDEX pool, 0=marketplace‑matched), `bump@267`. *(This is what x1brainsv2's `/charts` reads; matched pools have `seeded=0`.)*
- **WalletState** `[b"wallet_state", wallet]` (54): rate‑limit + flag state.
- **MatchCommitment** `[b"commitment", matcher, listing]` (122): commit_hash, commit_slot, revealed.
- **MatchIntent** `[b"match_intent", matcher, listing]` (186): token_b params, amm_config, token_a_is_token0, **created_slot** (must == current slot in execute), matcher_lb_balance.

**Escrow:** `[b"escrow", listing_state]` token account, authority PDA `[b"escrow_auth", listing_state]`.

**Errors (notable):** Paused, Reentrancy, LpMath, SelfMatch, WalletFlagged, InvalidBurnBps, AmountTooSmall, PriceStale/Mismatch, PriceReservesMismatch, PoolTvlTooLow, RateLimited, TransactionTooOld (atomicity), Commitment{Required,Mismatch,Expired}, RevealTooEarly, AlreadyRevealed.

---

## 4. brains_farm — LP staking farms (Token-2022, modular)

**What it does:** Admin creates farms (per LP mint + reward mint). Users stake LP into a 30/90/365‑day lock (2×/4×/8× weight), earn reward‑mint emissions via a MasterChef `acc_reward_per_share` accumulator (`ACC_PRECISION 1e18`). 3‑day grace (free exit, rewards forfeited), early‑exit LP penalty tiered by LB holdings, full LP+rewards at maturity. Farms run until the reward vault drains; anyone can `fund_farm`.

**Admin/treasury:** ADMIN `CCcJuC3B…vcY2`, TREASURY `CAeTTU…K9XF`. Validates LP mints come from brains_pairing (PoolRecord) or xDEX (LP auth).

**Key constants:** locks `30d/90d/365d`, multipliers `2.0×/4.0×/8.0×` (bps 20000/40000/80000), grace `3d`, claim cooldown `24h`. Early‑exit penalties (period1/period2 bps) by LB tier: standard `400/188`, ≥33 LB `188/88`, ≥330 LB `100/44`, ≥3300 LB `50/22`. MIN_STAKE_RAW `100`, stake fee `0.005 XNT`, max `100 positions/user/farm`, rate change cap ±2×, farm duration `7d..2y`.

**Instructions:** admin: `initialize_global`, `create_farm`, `close_farm`, `pause`/`unpause`, `pause_farm`/`unpause_farm`, `update_rate`, `withdraw_rewards` (can't touch earmarked `total_pending_rewards`); permissionless: `fund_farm`; user: `stake`, `claim`, `unstake`; test‑only (feature‑gated): `force_mature_position`.

**State (PDA seed · LEN):**
- **FarmGlobal** `[b"farm_global"]` (107): admin, treasury, total/active_farms, total_positions, total_fee_xnt, paused, is_locked(reentrancy), bump.
- **Farm** `[b"farm", lp_mint, reward_mint]` (229): mints, vaults, `reward_rate_per_sec` u128, `acc_reward_per_share` u128, last_update_ts, total_staked, total_effective, total_pending_rewards, total_emitted, start/created_ts, paused, closed, bumps.
- **StakePosition** `[b"position", owner, farm, nonce_le]` (158): owner, farm, nonce u32, amount, effective_amount, lock_type, reward_debt u128, pending_rewards, start/grace_end/unlock_ts, lock_duration, last_claim_ts, bump.
- Vaults: `[b"lp_vault", farm]`, `[b"reward_vault", farm]`.

**Errors (notable):** Paused, FarmPaused, Reentrancy, FarmClosed, ClockDrift, InvalidLpMint, PoolRecordMismatch, NotXdexLpMint, RewardsEarmarked, RateTooHigh, ClaimTooSoon, TooManyPositions, FarmHasStakers, VaultNotEmpty.

---

## 5. labwork_marketplace — NFT marketplace (classic SPL)

**What it does:** Self‑custodied NFT escrow. `list_nft` moves the NFT to a vault PDA + creates a `SaleAccount`; `buy_nft` pays seller + 1.888% platform fee in XNT and transfers the NFT; `cancel_listing` returns it for a 0.888% fee; `update_price` is free. **Uses classic SPL Token (`anchor_spl::token`), not Token‑2022** — so it only handles classic‑SPL NFTs.

**Constants:** PLATFORM_WALLET `CAeTTU…K9XF`, sale fee `1888/100000` (1.888%), cancel fee `888/100000` (0.888%), MIN_PRICE `1_000_000` lamports.

**Instructions:** `list_nft(price)`, `cancel_listing`, `buy_nft`, `update_price(new_price)`.

**State `SaleAccount`** `[b"sale", nft_mint, seller]` (LEN 90): seller, nft_mint, price, bump, vault_bump, created_at. Vault: `[b"vault", nft_mint, seller]` (self‑authority token account).

**Errors:** PriceTooLow, NotNFTOwner, InvalidMint, Unauthorized, InvalidPlatformWallet, InvalidSeller, InsufficientFunds(ForCancelFee), MathOverflow.

> ⚠️ Note the localnet ID in `Anchor.toml` (`EQKNXSBE…`) differs from the mainnet `declare_id!` (`CKZHwo…`). Mainnet is `CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4`.

---

## 6. Upgrade-surface cheat-sheet (per program)

- **lb_mint** — tier rates are **hardcoded `TIERS` const** (can't change without redeploy, by design); supply cap 100k; transfer‑fee bps. Adding tiers / changing rates / cap = code change + redeploy.
- **brains_pairing** — fee bps, burn whitelist, LP split (TREASURY_LP_BPS), commit‑reveal slots, rate limits, oracle pool addresses, xDEX CPI disc/account order, **PoolRecord schema** (size 282 — any field add bumps size + breaks existing readers). Deploy ONLY via the wrapper script.
- **brains_farm** — lock durations/multipliers, penalty tiers, fees, rate caps, LP‑mint validation logic; `Farm`/`Position` schema changes need migration. Build WITHOUT `admin-test-tools`.
- **labwork_marketplace** — fee numerators, MIN_PRICE; **classic‑SPL‑only** (would need Token‑2022 rework to support T22 NFTs). `SaleAccount` schema.

Upgrade authority is split: **brains_pairing + brains_farm → `CCcJuC3B…vcY2`**; **lb_mint + labwork_marketplace → `E2JtCat…88DR`**. Treasury (fees) for all four: `CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF`.
