# x1brainsv2

v2 of x1brains.io — the user-facing dashboard for X1B (brains farming, NFT marketplace, burn portal, portfolio, leaderboards). Built with React + Vite + TypeScript on top of `@solana/web3.js`.

## What's here

| Path | Purpose |
|---|---|
| `src/components/` | Dashboard components (Portfolio, NFTComponents, V2BurnPanel, V2FarmModal, Burn portal, MintLabWork, etc.) |
| `src/pages/` | Top-level routes |
| `src/lib/` | Shared chain reads + helpers |
| `MOCKUP.html` | Design reference mock |
| `INTEGRATION-FROM-X1CITY.md` | Handoff doc from the x1city-react agent — auth contracts, XT0 widget integration, `x1tx()` modal pattern. **Read first if working on XT0 widget integration or chat features.** |

## Companion repos

- `~/bt/x1city-react/` — x1.city frontend + cf-worker (chat backend) + openclaw-plugin (X1B tools). Owns the chat brain. v2 is a consumer.
- `~/bt/x1brainsv1/` — the v1 site. Reference for what's being replaced.

## XT0 widget integration

Status: **not started** (as of 2026-06-06). Backend is ready — `api.x1.city/chat` enforces wallet+sig and 50 msg/wallet/24h cap. v2 just needs the widget component + wallet auth wiring. See `INTEGRATION-FROM-X1CITY.md` for the full contract + sample code.

## Local dev

```
npm install
npm run dev
```

## Deploy

TBD — separate from x1city-react. Will likely follow the same Vercel pattern.
