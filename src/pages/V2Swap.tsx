// V2 Swap — full v1 SwapTab in a v2-aesthetic scope, side panel restored
// (portfolio / activity / network). The .v2-palette wrapper neutralizes
// any non-v2 colors the v1 module renders via CSS overrides.

import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { SwapTab } from './PairingMarketplace';
import PortfolioPanel from '../components/Portfolio';
import ActivityLog from '../components/ActivityLog';
import NetworkStats from '../components/NetworkStats';
import { primeFromIndexer } from '../lib/tokenLogos';
import V2PageHeader from '../components/V2PageHeader';

/** Shape callers pass via navigate('/swap', { state }) to deep-link a pair. */
export type V2SwapInitState = {
  fromMint?: string;
  fromSymbol?: string;
  fromDecimals?: number;
  toMint?: string;
  toSymbol?: string;
  toDecimals?: number;
};

function useIsMobile() {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

function injectV2PaletteOverrides() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2-palette-overrides')) return;
  const s = document.createElement('style');
  s.id = 'v2-palette-overrides';
  s.textContent = `
    /* ════════ V2 palette overrides for v1-derived modules ════════
       Only orange (#ff8c00), dark, neon green (#00c98d), and minimal purple.
       Cyan, red, yellow, pink are all remapped to orange or gray. */
    .v2-palette {
      --accent-orange: #ff8c00;
      --neon-cyan:     #ff8c00;
      --neon-pink:     #ff8c00;
      --neon-yellow:   #ff8c00;
      --neon-purple:   #bf5af2;
      --neon-green:    #00c98d;
      --neon-red:      #ff8c00;
      --text-primary:  #e6ebf2;
      --text-secondary:#cdd8e2;
      --text-muted:    #8a9ab8;
      --text-faint:    #5a6a82;
      --bg-primary:    #080c0f;
      --bg-card:       rgba(255,255,255,.015);
    }
    /* Force any inline cyan / blue / yellow / red token color → orange */
    .v2-palette [style*="#00d4ff"]      { color: #ff8c00 !important; }
    .v2-palette [style*="#5be5ff"]      { color: #ff8c00 !important; }
    .v2-palette [style*="#00B8E6"]      { color: #ff8c00 !important; }
    .v2-palette [style*="#ffdd44"]      { color: #ff8c00 !important; }
    .v2-palette [style*="#ff4466"]      { color: #ff8c00 !important; }
    .v2-palette [style*="#ff4444"]      { color: #ff8c00 !important; }
    .v2-palette [style*="#ff0066"]      { color: #ff8c00 !important; }
    /* Borders + backgrounds with the same colors get gray fallback */
    .v2-palette [style*="border-color: #00d4ff"]   { border-color: rgba(138,154,184,.18) !important; }
    .v2-palette [style*="border-color:#00d4ff"]    { border-color: rgba(138,154,184,.18) !important; }
    .v2-palette [style*="background: #00d4ff"]     { background: rgba(255,140,0,.08) !important; }

    /* Side panel wrap */
    .v2-swap-grid {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 14px;
      align-items: start;
    }
    @media (max-width: 920px) { .v2-swap-grid { grid-template-columns: 1fr; } }
    .v2-swap-side {
      display: flex; flex-direction: column; gap: 12px;
    }
  `;
  document.head.appendChild(s);
}

export default function V2Swap() {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const isMobile = useIsMobile();
  const location = useLocation();
  // Optional deep-link payload from V2XdexPoolsList: pre-select a specific pair.
  const init = (location.state as V2SwapInitState | null) ?? null;
  useEffect(() => { injectV2PaletteOverrides(); primeFromIndexer(); }, []);

  return (
    // `.content` already lays out as `1fr 360px` two-column grid — SwapTab
    // lands in column 1, side panel falls into column 2 automatically.
    <div className="content v2-palette">
      <div>
        <V2PageHeader title="SWAP" subtitle="XDEX · X1 MAINNET" />
        <SwapTab
          isMobile={isMobile}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          initialFromMint={init?.fromMint}
          initialFromSymbol={init?.fromSymbol}
          initialFromDecimals={init?.fromDecimals}
          initialToMint={init?.toMint}
          initialToSymbol={init?.toSymbol}
          initialToDecimals={init?.toDecimals}
        />
      </div>
      <div className="side-panel">
        <PortfolioPanel />
        <ActivityLog />
        <NetworkStats />
      </div>
    </div>
  );
}
