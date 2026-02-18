# X1 Brains App — Project Structure Guide

## Install & Run
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build → /dist
```

---

## Folder Structure

```
x1-brains-app/
├── package.json                  ← dependencies & scripts
├── src/
│   ├── App.tsx                   ← ROOT: router + wallet providers
│   │
│   ├── constants/
│   │   └── index.ts              ← ALL shared values (RPC, mints, logos, nav links, rarity tiers)
│   │
│   ├── utils/
│   │   ├── index.ts              ← IPFS helpers, URI resolver, rarity scorer, formatters
│   │   └── globalStyles.ts       ← Global CSS injector (fonts, animations, wallet overrides)
│   │
│   ├── components/
│   │   ├── UI.tsx                ← Shared UI: TopBar, PageBackground, Spinner, StatsBar,
│   │   │                            SectionHeader, PipelineBar, Footer, AddressBar
│   │   ├── TokenComponents.tsx   ← Portfolio-specific: TokenLogo, MetaBadge, TokenCard
│   │   └── NFTComponents.tsx     ← NFT-specific: RarityBadge, StatBar, AttributeChip,
│   │                                RarityDistribution, NFTCard, NFTListRow, NFTModal
│   │
│   └── pages/
│       ├── Home.tsx              ← Landing page with feature cards → Portfolio & Lab Work
│       ├── Portfolio.tsx         ← Token portfolio tracker (your original App.tsx logic)
│       └── LabWork.tsx           ← NFT Lab Work gallery + modal
```

---

## Routes

| URL          | Page           | Description                              |
|-------------|----------------|------------------------------------------|
| `/`          | Home           | Landing page, ecosystem links, nav cards |
| `/portfolio` | Portfolio      | XNT + SPL + Token-2022 tracker           |
| `/lab-work`  | Lab Work       | 88 NFT collection gallery + detail modal |
| `*`          | → Home         | Unknown routes redirect to home          |

---

## File-by-File Breakdown

### `src/App.tsx`
The root of the app. Sets up:
- `ConnectionProvider` — X1 RPC endpoint
- `WalletProvider` — Phantom/Backpack (self-register, no explicit adapters needed)
- `WalletModalProvider` — wallet connect modal
- `BrowserRouter` + `Routes` — page routing

**You never need to touch this file unless adding a new page.**

---

### `src/constants/index.ts`
Single source of truth for every hardcoded value:
- `BRAINS_MINT`, `XNT_WRAPPED`, `RPC_ENDPOINT`, `XDEX_API`
- `BRAINS_LOGO`, `XNT_LOGO`
- `NFT_TOTAL_SUPPLY` (88), `NFT_COLLECTION_NAME`
- `IPFS_GATEWAYS` — fallback chain for IPFS fetching
- `NAV_LINKS` — ecosystem links used in TopBar + Home
- `RARITY_TIERS` — LEGENDARY/EPIC/RARE/UNCOMMON/COMMON with colors, glows, score thresholds

**When you update a value (e.g. collection name, mint address), change it here once.**

---

### `src/utils/index.ts`
Pure utility functions with no React dependencies:
- `extractIpfsCid(uri)` — pulls CID from any IPFS URI format
- `resolveUri(raw)` — converts ipfs://, ar://, relative paths → https
- `fetchOffChainLogo(uri)` — fetches off-chain JSON metadata and extracts logo URL
- `fetchWithTimeout(url, ms)` — fetch with abort controller timeout
- `getRarityTier(score)` — returns the right RARITY_TIERS entry for a score
- `formatBalance(balance, decimals)` — locale-formatted balance string
- `shortAddress(address)` — truncates a wallet/mint address

---

### `src/utils/globalStyles.ts`
Injects the shared `<style>` tag once into `<head>`. Contains:
- Google Fonts import (Orbitron + Sora)
- Global reset
- Custom scrollbar
- Wallet adapter button overrides (orange gradient theme)
- All `@keyframes`: fadeUp, fadeIn, spin, scanline, shimmer, float, rank-glow, modal-in, pulse-orange
- NFT card shimmer class
- Modal scrollbar class

---

### `src/components/UI.tsx`
Shared React components used on every page:
- **`<TopBar />`** — fixed top-right bar with wallet button, ecosystem links dropdown, and context-aware back buttons (auto-detects current route)
- **`<PageBackground />`** — fixed grid overlay + ambient glow blobs
- **`<Spinner label />`** — orange loading spinner
- **`<StatsBar items />`** — horizontal stats strip
- **`<SectionHeader />`** — labeled divider with optional count badge
- **`<PipelineBar text />`** — cyan info strip at page bottom
- **`<Footer />`** — ecosystem links footer
- **`<AddressBar address />`** — connected wallet address display

---

### `src/components/TokenComponents.tsx`
Portfolio-only components:
- **`<TokenLogo />`** — image or colored initial fallback
- **`<MetaBadge source />`** — T-2022 EXT / METAPLEX / XDEX / UNKNOWN badge
- **`<TokenCard />`** — full token row with logo, symbol, name, address copy, balance

Also exports the `TokenData` interface.

---

### `src/components/NFTComponents.tsx`
NFT-only components:
- **`<RarityBadge tier size />`** — colored rarity label (xs/sm/md/lg)
- **`<StatBar />`** — animated power stat bar
- **`<AttributeChip />`** — trait card with rarity % bar
- **`<RarityDistribution nfts />`** — horizontal colored distribution bar
- **`<NFTCard />`** — grid card with hover effects, rank/rarity badges, image
- **`<NFTListRow />`** — compact list view row
- **`<NFTModal />`** — fullscreen detail modal with image, stats, attributes, rarity summary

Also exports `NFTData` and `NFTAttribute` interfaces.

---

### `src/pages/Home.tsx`
Landing page. Shows:
- Spinning BRAINS logo hero
- App title + tagline
- Stat pills (X1, 88 NFTs, SPL+T22)
- **Feature cards** → `/portfolio` and `/lab-work` (locked behind wallet connect)
- Ecosystem links grid
- Wallet connect CTA if not connected

---

### `src/pages/Portfolio.tsx`
Your original portfolio tracker, now as a routed page. Contains:
- Full token metadata resolution pipeline (Token-2022 ext → Metaplex PDA batch → xDex registry → fallback)
- XNT native balance
- BRAINS token section
- SPL tokens with zero-balance toggle
- Token-2022 extensions section
- Refresh button

---

### `src/pages/LabWork.tsx`
NFT Lab Work gallery page. Contains:
- NFT grid + list view toggle
- Filter by rarity tier
- Sort by rank/score/ID
- Rarity distribution bar
- `generateMockNFTs()` — **replace this with your live RPC NFT scan**
- Connects to `<NFTModal />` on card click

---

## Adding a New Page

1. Create `src/pages/NewPage.tsx`
2. Add a route in `src/App.tsx`:
   ```tsx
   <Route path="/new-page" element={<NewPage />} />
   ```
3. Add a nav link in `src/constants/index.ts` if needed
4. The `<TopBar />` will automatically show the correct back buttons

---

## Wiring Live NFT Data

In `src/pages/LabWork.tsx`, replace `generateMockNFTs()` with a real scan:
```ts
// Same pattern as Portfolio.tsx — use connection from useConnection()
const accounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
  programId: TOKEN_PROGRAM_ID, // or TOKEN_2022_PROGRAM_ID
});
// Then fetch Metaplex PDA metadata for each NFT mint
// using batchFetchMetaplexPDAs() from Portfolio.tsx
```
The rarity scoring, tiers, and all display components are already wired up —
just feed them real `NFTData` objects.
