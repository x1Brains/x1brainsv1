# Deploying brains_farm

## TL;DR

```bash
./scripts/deploy-brains-farm.sh
```

The script auto-detects first-deploy vs upgrade and handles both safely.

For a checks-only run that doesn't actually deploy:

```bash
./scripts/deploy-brains-farm.sh --dry-run
```

For a non-interactive deploy:

```bash
./scripts/deploy-brains-farm.sh --yes
```

## First deploy vs upgrade

Unlike `brains_pairing`, the `brains_farm` program keypair at
`target/deploy/brains_farm-keypair.json` **does match** `declare_id!()`
in `lib.rs`. Both were generated together (April 2026) — see
`DEPLOY_LOG_FARM.md` for the first-deploy record.

The script detects which mode you're in by calling
`solana program show <PROGRAM_ID>`:

- **Program does not exist on-chain:** first-deploy mode. Uses
  `solana program deploy --program-id <keypair_file>` which creates
  the program account at the address matching the keypair's pubkey
  (= declare_id!() in lib.rs).
- **Program already exists:** upgrade mode. Uses
  `solana program deploy --program-id <pubkey>` with the upgrade
  authority. Keypair file is irrelevant for upgrades.

## What the script checks before deploying

1. Required tools are installed (`solana`, `solana-keygen`, `anchor`, `git`, `md5sum`)
2. Binary exists at `target/deploy/brains_farm.so` and is non-trivial in size
3. Program keypair file's pubkey matches declare_id!() in the source
4. Git commit hash and branch (warns on dirty working tree)
5. Local solana CLI keypair matches the expected upgrade authority
   `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`
6. Wallet has at least 6 XNT (first deploy needs more rent headroom)
7. On first deploy: confirms program does NOT exist on-chain yet
8. On upgrade: confirms on-chain upgrade authority still matches expected value
9. After deploy: re-verifies authority, slot advanced, data length matches

If any check fails the script exits non-zero and **does not deploy**.

## Key addresses (reference)

- **Program:**            `Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg`
- **Upgrade authority:**  `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`
- **Treasury:**           `CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF`
- **BRAINS mint:**        `EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN`
- **LB mint:**            `Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6`
- **BRAINS/XNT pool:**    `7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg`
- **LB/XNT pool:**        `CKtXmX82rLBqNkfpCBPUoHLmtZhgBdVWpVPW93hHHCCK`
- **RPC:**                `https://rpc.mainnet.x1.xyz`

## Post-first-deploy sequence

After the first deploy succeeds, run these instructions in order (scripts TBD):

1. `initialize_global` — one-time singleton setup
2. `create_farm` x2 — one for BRAINS/XNT LP → BRAINS, one for LB/XNT LP → LB
3. `fund_farm` x2 — deposit 444k BRAINS and 5k LB seeds

The frontend constant `FARM_PROGRAM_ID` in `src/pages/LpFarms.tsx` is already
set to the deployed program ID.

## Admin test tools

The `force_mature_position` instruction is feature-gated behind
`admin-test-tools`. **The mainnet binary is built WITHOUT this feature**
and therefore cannot call it. For local test builds:

```bash
cargo build-sbf --manifest-path programs/brains_farm/Cargo.toml --features admin-test-tools
```

Never deploy an `admin-test-tools` binary to mainnet.
