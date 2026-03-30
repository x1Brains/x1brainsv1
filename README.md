# X1 BRAINS — LAB WORK MINT PROGRAM
### Built on X1 Blockchain · Token-2022 · Anchor 0.31.1

---

## Overview

X1 Brains is a deflationary DeFi platform built on the X1 blockchain. The Lab Work (LB) mint program is the core protocol — users burn BRAINS tokens and pay XNT fees to mint LB, a scarce Token-2022 asset with a hard cap of 100,000 tokens. The Xenblocks Amplifier allows holders of XNM, XUNI, and XBLK to earn bonus LB alongside their BRAINS burn.

**Live at:** https://x1brains.io/labwork

---

## Program Addresses

| Contract | Address |
|---|---|
| LB Mint Program | `3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN` |
| LabWork Marketplace | `CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4` |
| LB Mint (Token-2022) | `Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6` |
| GlobalState PDA | `7kPUrK7PtStHa8fgx5tfCHc6HiJboQaPC1NWYS9rwWmj` |
| Mint Authority PDA | `7eZ9HpkxVbjmUcD6yiNSG5FUZiUmscG256PrJiHFYkHK` |
| Treasury Wallet | `CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF` |

---

## Token Addresses (all Token-2022)

| Token | Address |
|---|---|
| BRAINS | `EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN` |
| XNM | `XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m` |
| XUNI | `XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm` |
| XBLK | `XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T` |

---

## Tokenomics

### LB Token
- **Hard cap:** 100,000 LB (enforced on-chain)
- **Decimals:** 2
- **Transfer fee:** 0.04% (4 bps) on every transfer → treasury
- **Extensions:** TransferFeeConfig + MetadataPointer (Token-2022)

### Tier Pricing (hardcoded in program binary)

| Tier | LB Range | BRAINS / LB | XNT Fee / LB |
|---|---|---|---|
| Tier I | 1 – 25,000 | 8 | 0.50 XNT |
| Tier II | 25,001 – 50,000 | 18 | 0.75 XNT |
| Tier III | 50,001 – 75,000 | 26 | 1.00 XNT |
| Tier IV | 75,001 – 100,000 | 33 | 1.50 XNT |

XNT fee applies to **total LB minted** (base + Xenblocks bonus).

### BRAINS Burn
- 100% of BRAINS burned permanently on every mint
- Deflationary by design — no BRAINS ever returned

### Xenblocks Amplifier

| Asset | Amount | Bonus LB | Burned | → Treasury |
|---|---|---|---|---|
| XNM | 1,000 | +1 LB | 500 XNM | 500 XNM |
| XUNI | 500 | +4 LB | 250 XUNI | 250 XUNI |
| XBLK | 1 | +8 LB | 0.5 XBLK | 0.5 XBLK |

- All three assets optional — use any combination or single asset
- 50% burned forever, 50% sent to treasury ATAs
- Xenblocks bonus LB still pays full XNT fee

---

## Program Instructions

| Instruction | Description |
|---|---|
| `initialize` | One-time setup — creates GlobalState, LB mint with Token-2022 extensions |
| `mint_lb` | Standard mint — burn BRAINS + pay XNT → receive LB |
| `combo_mint_lb` | Xenblocks Amplifier mint — burn BRAINS + XNM/XUNI/XBLK + pay XNT → receive LB + bonus |
| `update_admin` | Transfer admin authority to new wallet |
| `update_metadata_uri` | Update LB token metadata URI (Arweave/IPFS) |
| `initialize_metadata` | Initialize on-mint Token-2022 metadata |
| `pause` | Emergency pause — halt all minting immediately |
| `unpause` | Resume minting after pause |
| `collect_fees` | Sweep withheld LB transfer fees → treasury ATA |

---

## Security

- **Upgrade authority:** `E2JtCatV4dE2pLWvvtgQusNMf3HCKHieKhsyUz4r88DR` (rotated March 30, 2026)
- **Admin wallet:** `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2` (WSL keypair, not browser-exposed)
- All math uses `checked_mul` / `checked_add` — overflow safe
- All account constraints validated on-chain (wrong mint, wrong treasury → tx fails)
- No reentrancy possible (Solana single-threaded per tx)
- Supply cap enforced atomically — cannot exceed 100,000 LB
- Treasury address hardcoded as `pubkey!()` compile-time constant — cannot be changed without redeploy
- `target/deploy/*-keypair.json` files excluded from git via `.gitignore`

---

## Tech Stack

- **Blockchain:** X1 Mainnet (SVM-compatible)
- **Program framework:** Anchor 0.31.1
- **Token standard:** Token-2022 (all assets)
- **Frontend:** React 18 + TypeScript + Vite + Supabase
- **Wallet:** Backpack (primary), Solana wallet adapter
- **Deployment:** Vercel (frontend), X1 mainnet (program)
- **RPC:** `https://rpc.mainnet.x1.xyz`

---

## Deployment History

| Date | Event |
|---|---|
| March 2026 | LB Mint Program deployed to X1 mainnet |
| March 2026 | First successful mint — 8 BRAINS burned, 0.5 XNT fee, 1 LB minted |
| March 2026 | Xenblocks Amplifier live — XNM/XUNI/XBLK Token-2022 CPIs verified |
| March 2026 | XNT fee updated to charge on total LB (base + bonus) |
| March 2026 | Upgrade authority rotated to secure keypair |
| March 2026 | LB/XNT liquidity pool created on XDEX |
| March 2026 | 7 holders, organic trading activity on XDEX |

---

## Marketplace

- **Program ID:** `CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4`
- **Sale fee:** 1.888%
- **Cancel fee:** 0.888%
- **Platform fee wallet:** `CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF`
- Features: list, buy, cancel, boost (SPARK / GODSLAYER / INCINERATOR tiers)

---

## Frontend Pages

| Route | Description |
|---|---|
| `/` | Home — portfolio tracker, stats |
| `/labwork` | LB mint + NFT marketplace |
| `/x9b7r41ns/ctrl` | Admin panel (restricted) |

---

## Local Development

```bash
# Install dependencies
npm install --legacy-peer-deps

# Run dev server
npm run dev

# Build program
cd programs/lb_mint
cargo build-sbf --tools-version v1.52

# Deploy (see PROGRAM_KEYS.txt for full workflow)
cd ~/bt/x1brainsv1x/x1brainsv1x
solana program write-buffer target/deploy/lb_mint.so \
  --url https://rpc.mainnet.x1.xyz --use-rpc
```

---

## Links

- **Platform:** https://x1brains.io
- **Explorer:** https://explorer.mainnet.x1.xyz
- **XDEX:** https://app.xdex.xyz
- **Twitter:** @x1brains
- **Telegram:** https://t.me/x1brains

---

*Built with 🔥 on X1 blockchain. BRAINS burned. LB earned.*
