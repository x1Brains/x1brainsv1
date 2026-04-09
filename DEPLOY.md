# Deploying brains_pairing

## TL;DR

```bash
./scripts/deploy-brains-pairing.sh
```

That's it. The script handles everything safely. **Do not run `anchor deploy` for this program** — see "Why" below.

For a checks-only run that doesn't actually deploy:

```bash
./scripts/deploy-brains-pairing.sh --dry-run
```

For a non-interactive deploy (CI, automation):

```bash
./scripts/deploy-brains-pairing.sh --yes
```

## Why `anchor deploy` does not work for this program

The local `target/deploy/brains_pairing-keypair.json` file does **not** match the on-chain program ID `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`. It corresponds to a different (unrelated) address: `C3vwW3Asg9is8jkBB7gbt3meC5zvsBxudHMJW3RVjS4Q`.

This happened because the original program-ID keypair was lost during the Anchor 0.31 → 0.32 upgrade. Anchor's build flow auto-regenerated a fresh keypair file when it didn't find one, and that fresh keypair has nothing to do with the program we actually want to upgrade.

Running `anchor deploy` would:

1. Look at `target/deploy/brains_pairing-keypair.json`
2. See the pubkey `C3vwW3A...` and try to deploy a brand new program at that address
3. **Silently spend ~3-4 XNT in rent** creating a ghost program that nothing references
4. Leave the real program at `DNSefSA...` completely untouched

This is why we use `solana program deploy --program-id DNSefSA...` directly. Upgrades to an existing upgradeable program only require the upgrade authority signature, not the program-ID keypair, so the missing original keypair is irrelevant for upgrade flows.

## What the script checks before deploying

1. Required tools are installed (`solana`, `solana-keygen`, `git`, `md5sum`)
2. Binary exists at `target/deploy/brains_pairing.so` and is non-trivial in size
3. Git commit hash and branch (warns on dirty working tree)
4. Local solana CLI keypair pubkey matches the expected upgrade authority `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2`
5. Wallet has at least 5 XNT
6. On-chain program upgrade authority still matches the expected value (refuses to deploy if it has changed unexpectedly)
7. After deploy: re-verifies authority is unchanged, slot has advanced, and data length matches the new binary
8. Appends a structured entry to `DEPLOY_LOG.md`

If any check fails the script exits with a non-zero status and **does not deploy**.

## What if I really need to use anchor deploy

You don't. But if you ever want to fix the underlying problem so anchor deploy works again, the only path is to **change the program ID** of brains_pairing — which means deploying a brand new program at a brand new address, migrating any state, and updating every frontend, IDL consumer, and integration that references the current ID. That is a much bigger project than living with the wrapper script.

## Rollback

If a deploy goes sideways, the v1.1 backup binary lives at `~/brains_pairing_v11_backup.so` (MD5 `a140be5030c16cc6427172334011c1c6`). To roll back:

```bash
cp ~/brains_pairing_v11_backup.so target/deploy/brains_pairing.so
md5sum target/deploy/brains_pairing.so   # should be a140be5030c16cc6427172334011c1c6
./scripts/deploy-brains-pairing.sh
```

The script will deploy the v1.1 binary in place using the same upgrade authority flow.

## Key addresses (reference)

- **Program:**            `DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM`
- **Upgrade authority:**  `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2` (= `~/.config/solana/id.json`)
- **RPC:**                `https://rpc.mainnet.x1.xyz`
