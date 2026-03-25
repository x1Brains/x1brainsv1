# 🧠 X1 BRAINS

### The On-Chain Intelligence Hub for the X1 Blockchain

**Track · Burn · Earn · Ascend**

🌐 [x1brains.io](https://x1brains.io) · 📊 [Portfolio](https://x1brains.io/portfolio) · 🔥 [Burn BRAINS](https://x1brains.io/incinerator-engine) · 🏆 [Leaderboard](https://x1brains.io/burn-history) · 🧪 [Lab Work](https://x1brains.io/rewards)

**Stack:** React 18 · TypeScript 5 · Vite · Supabase · Solana/X1 Wallet Adapter · SPL Token + Token-2022

---

## 📖 What is X1 Brains?

X1 Brains is the first full-stack on-chain intelligence platform built exclusively for the **X1 Blockchain** — a high-performance EVM + SVM compatible chain powered by the XenBlocks ecosystem.

It gives every X1 participant a single home base to:

- **Track** their entire on-chain portfolio in real time
- **Burn** BRAINS tokens to earn LB Points and climb tier rankings
- **Compete** for weekly prizes through the Rewards Season vault
- **Research** any wallet on the network without needing to connect
- **Share** branded portfolio cards to X (Twitter) and Telegram

No spreadsheets. No guessing. Everything straight from the chain.

---

## 🗺️ Pages & Routes

| Route | Page | Description |
|---|---|---|
| `/` | **Home** | App hub — navigate to all features |
| `/portfolio` | **Portfolio Tracker** | Full on-chain wallet dashboard |
| `/burn-history` | **Burn History** | Personal burn timeline + global leaderboard |
| `/incinerator-engine` | **Incinerator Engine** | BRAINS token burn interface |
| `/cyberdyne` | **Cyberdyne Unlimited** | X1 citizen registry + leaderboard lookup |
| `/rewards` | **Rewards Season** | Weekly Lab Work challenges + prize vault |
| `/mint` | **Mint Lab Work NFTs** | Lab Work NFT minting interface |

---

## 📊 Portfolio Tracker — Core Feature

> **x1brains.io/portfolio**

The Portfolio Tracker is the flagship feature of X1 Brains. It reads directly from the X1 RPC and displays a complete picture of any wallet's on-chain holdings.

### Two Ways to Access

| Mode | How | What You Get |
|---|---|---|
| 🔌 **Connected** | Click Connect Wallet | Full access — burn, send, live data, snapshots |
| 👁 **Watch Mode** | Paste any wallet address | Read-only view — all data, no login required |

### What It Shows

#### 💰 Native XNT Balance
Your X1 native token balance in real time, priced in USD. XNT is the gas token of the X1 chain — knowing your balance keeps you operational.

#### 🪙 SPL Tokens
Every standard SPL token in your wallet — sorted by USD value, with metadata resolved via a 3-layer pipeline:
1. Token-2022 extensions
2. Metaplex PDA on-chain metadata
3. XDEX Registry fallback

#### ⚡ Token-2022 Assets
The X1 chain supports the newer Token-2022 standard. Most trackers miss these. X1 Brains reads both token programs simultaneously — nothing is invisible.

#### 🎨 NFT Gallery
Your on-chain NFT collection in a browseable grid. Images fetched from IPFS / Arweave via Metaplex metadata. Toggle between **5 · 10 · 20 · ALL** to control how many load at once.

#### 💧 LP Tokens
Liquidity positions tracked separately from regular tokens, detected against the XDEX pool registry.

#### 📊 Portfolio History Chart
Total portfolio value tracked daily as an on-chain snapshot. See your bag performance over days and weeks with 24h change shown in USD. Snapshots are saved for every wallet viewed — connected or watched — so history builds automatically.

#### 🔥 BRAINS Token + Burn Rank
If you hold BRAINS, your full burn history is scanned live from chain. Every token burned earns **LB Points** which determine your **Burn Tier**:

```
○ UNRANKED → ✦ SPARK → 🕯️ FLAME → 🔥 INFERNO → ⚙️ OVERWRITE
→ 💥 ANNIHILATE → ⚡ TERMINATE → ☢️ DISINTEGRATE
→ ⚔️ GODSLAYER → 💀 APOCALYPSE → ☠️ INCINERATOR
```

#### ⛏️ XenBlocks Miner Status
Link your EVM address to check if you're an active XenBlocks miner — block count, rank, and activity status pulled live.

#### 📤 Send Panel
Send any SPL or Token-2022 token directly from the portfolio UI. Includes a saved address book and full send history logged to Supabase. Disabled in watch mode.

#### 🖼️ Portfolio Share Card
Generate a branded image card of your portfolio and share it anywhere:
- **PNG, JPEG, or SVG** export — works in all browsers including Backpack wallet
- **Privacy controls** — blur amounts or enable full anon mode
- **POST TO X** — saves image first, opens X with pre-written tweet text
- **TELEGRAM** — same flow with Telegram share link
- **TEXT ONLY** option — skips the image step, posts text directly
- Works in restricted WebView browsers (Backpack, Phantom, etc.) via clipboard fallback

---

## 🔥 Burn & Earn System

The burn system is the core economy of X1 Brains. Every BRAINS token burned earns **LB Points** at a rate of **1.888 pts per token**.

### Burn Tier Thresholds

| Tier | Icon | Minimum LB Points |
|---|---|---|
| UNRANKED | ○ | 0 |
| SPARK | ✦ | 1 |
| FLAME | 🕯️ | 25,000 |
| INFERNO | 🔥 | 50,000 |
| OVERWRITE | ⚙️ | 100,000 |
| ANNIHILATE | 💥 | 200,000 |
| TERMINATE | ⚡ | 350,000 |
| DISINTEGRATE | ☢️ | 500,000 |
| GODSLAYER | ⚔️ | 700,000 |
| APOCALYPSE | 💀 | 850,000 |
| INCINERATOR | ☠️ | 1,000,000 |

LB Points = Burn Points + Lab Work Points. All components use these exact canonical thresholds — the leaderboard, the burn bar, the portfolio card, and the share card are always in sync.

---

## 🧪 Lab Work & Rewards Season

Weekly challenges that reward community activity with LB Points:

- Post on social media about X1 Brains → earn points
- Submit your work for admin review
- Points stack on top of burn points for your tier ranking
- Weekly prize vault distributed to top performers

Submissions are saved both to localStorage (instant) and Supabase (durable across devices and cache clears).

---

## 🏗️ Tech Stack

```
Frontend       React 18 + TypeScript 5 + Vite
Blockchain     X1 Blockchain (SVM / Solana-compatible)
Wallet         @solana/wallet-adapter (Backpack, Phantom, etc.)
Token Programs SPL Token + Token-2022
Metadata       Metaplex PDA + Token-2022 extensions + XDEX Registry
Backend        Supabase (Postgres + Auth + Realtime)
Styling        Inline React styles + Orbitron + Sora fonts
Charts         Custom SVG portfolio history chart
Image Export   SVG → Canvas rasterization (PNG/JPEG, no html2canvas)
Deployment     Vercel / static hosting
```

### Key Libraries

```json
{
  "@solana/web3.js": "latest",
  "@solana/spl-token": "latest",
  "@solana/wallet-adapter-react": "latest",
  "@solana/wallet-adapter-react-ui": "latest",
  "@supabase/supabase-js": "latest",
  "react-router-dom": "^6",
  "react": "^18"
}
```

---

## 🗄️ Supabase Schema

Key tables used by the app:

| Table | Purpose |
|---|---|
| `portfolio_snapshots` | Daily wallet value snapshots for history chart |
| `labwork_submissions` | Lab Work challenge submissions |
| `labwork_rewards` | Admin-awarded LB points per wallet |
| `weekly_config` | Active rewards season config + prizes |
| `challenge_logs` | Per-challenge completion records |
| `announcements` | Admin announcements shown in rewards page |
| `burn_events` | On-chain burn event log |
| `page_views` | Analytics — route change tracking |
| `site_events` | Custom event tracking |
| `send_history` | Token send records per wallet |
| `saved_addresses` | User address book entries |

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project
- An X1 RPC endpoint

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/x1brains.git
cd x1brains
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_RPC_ENDPOINT=https://your-x1-rpc-endpoint
VITE_XDEX_API=https://xdex.xyz
```

### Run Locally

```bash
npm run dev
# App runs on http://localhost:5173
```

### Build for Production

```bash
npm run build
npm run preview
```

---

## 📁 Project Structure

```
src/
├── assets/
│   └── images1st.jpg          # BRAINS token logo
├── components/
│   ├── BurnedBrainsBar.tsx    # Top bar with burn rank + global stats
│   ├── NFTComponents.tsx      # NFT grid + detail modal
│   ├── PortfolioChart.tsx     # History chart + daily snapshot hook
│   ├── PortfolioShareCard.tsx # Branded share card (PNG/JPEG/SVG export)
│   ├── SendPanel.tsx          # Token send UI + address book
│   ├── TokenComponents.tsx    # Token cards + price feeds
│   ├── UI.tsx                 # Shared layout components
│   └── XenBlocksPanel.tsx     # XenBlocks miner status
├── lib/
│   └── supabase.ts            # Supabase client + all DB helpers
├── pages/
│   ├── AdminRewards.tsx       # Admin panel (protected route)
│   ├── AnalyticsDashboard.tsx # Site analytics
│   ├── BurnHistory.tsx        # Burn timeline + global leaderboard
│   ├── BurnLeaderboard.tsx    # Leaderboard rankings
│   ├── BurnPortal.tsx         # Burn portal entry
│   ├── CyberdyneUnlimited.tsx # X1 citizen registry
│   ├── Home.tsx               # Landing page / app hub
│   ├── IncineratorEngine.tsx  # BRAINS burn engine
│   ├── MintLabWork.tsx        # Lab Work NFT minting
│   ├── Portfolio.tsx          # Portfolio tracker (main feature)
│   └── RewardsSeason.tsx      # Rewards season + Lab Work
├── App.tsx                    # Router + wallet provider setup
├── constants.ts               # Mint addresses + app constants
├── main.tsx                   # App entry point
└── utils.ts                   # Shared utilities
```

---

## 🔄 Recent Updates — March 2026

### 🆕 New Features
- **Watch Any Wallet** — view any X1/SVM wallet in read-only mode, no login required
- **Portfolio Share Card** — PNG, JPEG, SVG export with privacy controls
- **Post to X & Telegram** — with image or text-only options
- **NFT pagination** — toggle between 5 / 10 / 20 / ALL NFTs
- **Backpack wallet fix** — clipboard fallback for restricted WebView browsers
- **Home page** — Portfolio card now accessible without connecting wallet

### 🐛 Bug Fixes
- Burn tier thresholds synced across all 5 components (were massively out of sync)
- `RewardsSeason` 15s poll: replaced `JSON.stringify` deep comparison with lightweight field checks
- Lab Work submissions now persisted to Supabase (previously localStorage only)
- `BurnHistory` `mountedRef` declared before effects that read it
- Portfolio share card: fixed burn rank overlapping footer in exported images
- `PortfolioStatsBar`: fixed `isReadOnly` scope error on wallet connect
- Post to X: was opening in constrained popup blocking SSO — now opens full tab
- PNG/JPEG export: replaced html2canvas (CORS failures) with SVG→Canvas rasterization

### 🎨 Polish
- Share card text larger and lighter (7-9px → 11-12px)
- BRAINS logo embedded as base64 in exported images (no CORS)
- Watch wallet input — pulsing green orb, prominent card design
- Share button — animated chromatic gradient border

---

## 🌐 Links

| | |
|---|---|
| 🌐 **Live App** | [x1brains.io](https://x1brains.io) |
| 📊 **Portfolio Tracker** | [x1brains.io/portfolio](https://x1brains.io/portfolio) |
| 🔥 **Burn BRAINS** | [x1brains.io/incinerator-engine](https://x1brains.io/incinerator-engine) |
| 🏆 **Leaderboard** | [x1brains.io/burn-history](https://x1brains.io/burn-history) |
| 🧪 **Lab Work** | [x1brains.io/rewards](https://x1brains.io/rewards) |
| 🔍 **Cyberdyne** | [x1brains.io/cyberdyne](https://x1brains.io/cyberdyne) |
| ⛓️ **X1 Blockchain** | [x1blockchain.net](https://x1blockchain.net) |
| 🐦 **X (Twitter)** | [@x1brains](https://x.com/x1brains) |
| ✈️ **Telegram** | [t.me/x1brains](https://t.me/x1brains) |

---

## 🤝 Contributing

Pull requests are welcome. For major changes please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📜 License

MIT — see [LICENSE](LICENSE) for details.

---

Built on the **X1 Blockchain** · Powered by **XenBlocks**

**🧠 x1brains.io** — *Track · Burn · Earn · Ascend*