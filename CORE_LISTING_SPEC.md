# Listing Metaplex Core NFTs on the LabWork marketplace

> ## ✅ SHIPPED 2026-11-18 — this file is the design record, not a to-do list.
> The program upgrade is live on mainnet (sig `2yK3Q2aP…`, md5 `cb15cf88…`), the client
> is deployed, and maps/parcels draw their inscribed content. **PROJECT.md §20 is the
> current account** — read that first; everything below is how it was planned, kept for
> the reasoning. The "TO DO" list near the end is DONE and is left only for the record.

## Why this is needed
x1 Inscriptions assets — inscriptions, maps, districts, parcels, editions — are
**Metaplex Core**, not SPL. Measured on mainnet:

| | |
|---|---|
| Owner's Core assets | 25 (43599.x1map, 11900.x1map, 24420.x1map, …) |
| What `fetchWalletNFTs` scans | SPL + Token-2022 only (LBComponents.tsx:500) |
| Live labwork listings that are Core | **0 of 170** |
| How labwork escrows | `token::transfer` (lib.rs:80/141/227) — no Core path |

## Transfers are NOT blocked
From x1-bitmaps `program_v0/src/lib.rs`:
> ROYALTIES — ADVERTISED ONLY: 5% to the item's creator, **rule set None, so honest
> marketplaces pay it and nothing is ever blocked** (sends, new marketplaces).

So escrow works. An earlier worry about a royalty hook was wrong.

## ⛔ But some assets can NEVER be escrowed
- `plugins_frozen`   → PermanentFreezeDelegate{frozen:true} — release masters, never transferable
- `plugins_soulbound`→ + PermanentBurnDelegate — never moves
- Unsealed inscriptions are frozen until `thaw_inscription`

`list_nft_core` must reject these with a clear error, not fail mid-transaction.

## DONE (committed, compiles)
`CORE_ID`, `core_holder()`, `core_transfer()` — hand-built TransferV1 (disc `[14,0]`,
7 accounts, absent optional = Core program id), copied from the x1ins program which
runs it on mainnet daily. mpl-core's crate cannot be used: it pins borsh 0.10 /
solana-program 1.x and clashes with Anchor 0.32.
New errors: NotAssetHolder, AssetFrozen, NotCoreAsset, BadRoyaltyCreator.

## TO DO
1. **Royalty parser (REQUIRED, do not skip).** Read the Royalties plugin off the
   asset's PluginRegistryV1 to get `creator` + `bps` (5% inscriptions/maps/editions,
   2.5% parcels + a map-holder share). ⛔ The creator must come from the ASSET, never
   from a client-supplied account: the royalty is deducted from the sale, so a buyer
   who could name the creator would hand themselves a 5% discount.
   Note the on-chain registry layout differs from the creation-time serializer in
   `plugins_bps()` — parse PluginRegistryV1 offsets, do not assume.
2. `list_nft_core(price)` — sale PDA seeds `["sale", asset, seller]`, `core_transfer`
   asset → sale PDA. No vault token account exists for Core.
3. `buy_nft_core()` — royalty to creator, then platform fee 1.888% (Elite-waivable
   via the existing `elite_fee_waived`), remainder to seller, `core_transfer` sale
   PDA → buyer with PDA signer seeds, close sale.
4. `cancel_listing_core()` — cancel fee 0.888% (Elite-waivable), asset back to seller.
5. Client: add a Core branch to `fetchWalletNFTs` (getProgramAccounts on CORE_ID,
   memcmp owner@1) and Core builders in `marketIx.ts`.
6. Tell a Core listing from an SPL one by the asset account's owner program —
   **SaleAccount stays 90 bytes, so the 170 live listings are untouched.**

## Testing before deploy (same bar as the Elite waiver)
Unit tests for the royalty parse and the frozen-asset rejection · adversarial
(wrong creator, frozen asset, not-the-holder, non-Core account) · e2e on a local
validator with REAL maps cloned off mainnet · cold first-visit UI check · then
`solana program extend` and `./scripts/deploy-labwork-marketplace.sh`.
