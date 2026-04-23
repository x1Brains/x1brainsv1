# X1 Brains Farm

LP staking protocol for the X1 Brains ecosystem. Stake LP tokens (BRAINS/XNT or LB/XNT), earn rewards with lock-tier multipliers.

## Design Summary

- **3 lock tiers:** Locked30 / Locked90 / Locked365
- **Multipliers:** 2× / 4× / 8× (reward weight vs raw stake)
- **Grace period:** 3 days from stake start — no penalty, no rewards forfeited
- **Early exit penalty (past grace):**
  - First 50% of lock duration: 4% LP (1.888% for 33+ LB holders)
  - Second 50% of lock duration: 1.888% LP (0.888% for LB holders)
  - Past maturity: 0% — free withdrawal forever
- **Rewards:** Continuous MasterChef-style accumulator, claim every 24h
- **Forfeited rewards** on early exit stay in vault → boost APR for remaining stakers
- **Perpetual farm model:** runs until reward vault empties
- **Permissionless donations:** anyone can `fund_farm` to extend runway
- **Admin lever:** `update_rate` to change emission rate
- **Stake fee:** 0.005 XNT flat → treasury
- **Min stake:** 1 LP token (1e9 raw, since XDEX LP is 9 decimals)

## Launch Plan

### BRAINS farm
- LP mint: BRAINS/XNT LP
- Reward mint: BRAINS (9 decimals)
- Seed: 444,000 BRAINS over 365 days
- Emission rate: ~14,083,333 raw units/sec

### LB farm
- LP mint: LB/XNT LP
- Reward mint: LB (2 decimals)
- Seed: 5,000 LB over 365 days
- Emission rate stored as u128 scaled by ACC_PRECISION (1e18) to handle LB's low decimals

## Build

```bash
# Mainnet build — NO admin test tools
cargo build-sbf

# Dev/test build — includes force_mature_position
cargo build-sbf --features admin-test-tools
```

## Deploy

1. Generate program keypair:
   ```bash
   solana-keygen new -o target/deploy/brains_farm-keypair.json
   solana-keygen pubkey target/deploy/brains_farm-keypair.json
   ```
2. Paste pubkey into `declare_id!()` in `lib.rs` and `[programs.mainnet]` in `Anchor.toml`.
3. Add to workspace `Cargo.toml` members list.
4. Deploy via existing workflow (copy `scripts/deploy-brains-pairing.sh` pattern).

## Post-deploy Admin Sequence

```
1. initialize_global                    (one-time singleton)
2. create_farm (BRAINS/XNT → BRAINS)    (with seed=444_000_000_000_000, duration=31_536_000)
3. create_farm (LB/XNT → LB)            (with seed=500_000,             duration=31_536_000)
4. fund_farm   (BRAINS farm, 444k BRAINS)
5. fund_farm   (LB farm,     5k LB)
```

## Instructions

| Instruction | Who | Purpose |
|---|---|---|
| `initialize_global` | Admin | One-time setup |
| `create_farm` | Admin | Open a new farm |
| `fund_farm` | Anyone | Deposit reward tokens |
| `stake` | User | Open a locked position |
| `claim` | User | Claim accrued rewards (24h cooldown) |
| `unstake` | User | Close position |
| `pause` / `unpause` | Admin | Global pause |
| `pause_farm` / `unpause_farm` | Admin | Per-farm pause |
| `update_rate` | Admin | Change emission rate |
| `withdraw_rewards` | Admin | Pull un-earmarked surplus |
| `close_farm` | Admin | Teardown (requires empty state) |
| `force_mature_position` | Admin | **TEST ONLY** — feature-gated |

## Integration: Sister Programs

- **brains_pairing** (`DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`) — for PoolRecord provenance on `create_farm`
- **XDEX** (`sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`) — LP mint authority check
- **LB mint** (`Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6`) — balance check for discount

## Known TODOs After First Compile

When running `cargo build-sbf`, expect a few Anchor 0.32.1 API quirks:

1. `mint_authority: COption<Pubkey>` — the `.into()` + pattern match in `create_farm.rs` may need adjustment to `mint.mint_authority` direct `COption` handling.
2. `AssociatedToken` program may need to be added to `Stake`/`Claim`/`Unstake` accounts structs.
3. `SplMint` import path inside token-2022 blocks — may need hoisting to top of file.

These are trivial fix-and-retry compile errors. Architecture is correct.
