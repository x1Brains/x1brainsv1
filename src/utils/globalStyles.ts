// ─────────────────────────────────────────────
// GLOBAL CSS — injected once, shared across all pages
// ─────────────────────────────────────────────

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Sora:wght@300;400;600;700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #080c0f;
    font-family: 'Sora', sans-serif;
    color: #d4e0ec;
    min-height: 100vh;
  }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #111820; }
  ::-webkit-scrollbar-thumb { background: #ff8c00; border-radius: 3px; }

  /* Wallet adapter overrides */
  .wallet-adapter-button {
    background: linear-gradient(135deg, #ff8c00, #ffb700) !important;
    color: #0a0e14 !important;
    font-family: 'Orbitron', monospace !important;
    font-size: 10px !important;
    font-weight: 700 !important;
    letter-spacing: 1px !important;
    border-radius: 8px !important;
    border: none !important;
    padding: 9px 16px !important;
    transition: all 0.2s !important;
    text-transform: uppercase !important;
    white-space: nowrap !important;
  }
  .wallet-adapter-button:hover {
    background: linear-gradient(135deg, #ffb700, #ff8c00) !important;
    transform: translateY(-1px) !important;
    box-shadow: 0 4px 20px rgba(255, 140, 0, 0.5) !important;
  }
  .wallet-adapter-modal-wrapper {
    background: #111820 !important;
    border: 1px solid rgba(255,140,0,0.2) !important;
    z-index: 99999 !important;
  }
  .wallet-adapter-modal { z-index: 99999 !important; position: fixed !important; }
  .wallet-adapter-modal-overlay { z-index: 99998 !important; position: fixed !important; }
  .wallet-adapter-dropdown { position: relative !important; z-index: 9020 !important; }
  .wallet-adapter-dropdown-list {
    z-index: 9021 !important;
    background: rgba(10,14,20,0.98) !important;
    border: 1px solid rgba(255,140,0,0.3) !important;
    border-radius: 10px !important;
    box-shadow: 0 12px 48px rgba(0,0,0,0.85) !important;
    padding: 6px !important;
    top: calc(100% + 6px) !important;
    right: 0 !important; left: auto !important;
    min-width: 160px !important;
  }
  .wallet-adapter-dropdown-list-active { display: flex !important; flex-direction: column !important; gap: 2px !important; }
  .wallet-adapter-dropdown-list-item {
    font-family: 'Orbitron', monospace !important;
    font-size: 9px !important; font-weight: 700 !important;
    letter-spacing: 1.5px !important; color: #8aa0b8 !important;
    padding: 10px 14px !important; border-radius: 7px !important;
    border: none !important; background: transparent !important;
    transition: all 0.15s !important; cursor: pointer !important;
    text-transform: uppercase !important; text-align: left !important; width: 100% !important;
  }
  .wallet-adapter-dropdown-list-item:not([disabled]):hover {
    background: rgba(255,140,0,0.1) !important;
    color: #ff8c00 !important;
  }
  .wallet-adapter-button-trigger { height: 36px !important; min-height: 36px !important; }

  /* ── ANIMATIONS ── */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes pulse-orange {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,140,0,0.4); }
    50%       { box-shadow: 0 0 0 10px rgba(255,140,0,0); }
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes scanline {
    0%   { top: -4px; }
    100% { top: 100%; }
  }
  @keyframes shimmer {
    0%   { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
  @keyframes float {
    0%,100% { transform: translateY(0); }
    50%     { transform: translateY(-8px); }
  }
  @keyframes rank-glow {
    0%,100% { text-shadow: 0 0 10px currentColor; }
    50%     { text-shadow: 0 0 25px currentColor, 0 0 50px currentColor; }
  }
  @keyframes modal-in {
    from { opacity: 0; transform: scale(0.93) translateY(20px); }
    to   { opacity: 1; transform: scale(1)    translateY(0); }
  }
  @keyframes page-in {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* NFT card shimmer */
  .nft-card-shimmer {
    position: absolute; inset: 0;
    background: linear-gradient(105deg, transparent 40%, rgba(255,140,0,0.06) 50%, transparent 60%);
    background-size: 200% 200%;
    opacity: 0; transition: opacity 0.3s;
    pointer-events: none; border-radius: inherit;
  }
  .nft-card:hover .nft-card-shimmer { opacity: 1; animation: shimmer 1.5s ease infinite; }

  /* Modal scrollbar */
  .modal-scroll::-webkit-scrollbar { width: 4px; }
  .modal-scroll::-webkit-scrollbar-track { background: #0d1520; }
  .modal-scroll::-webkit-scrollbar-thumb { background: #ff8c00; border-radius: 2px; }

  /* Page wrapper */
  .page-enter { animation: page-in 0.5s ease both; }
`;

export function injectGlobalCSS(): void {
  if (document.getElementById('x1brains-global-css')) return;
  const style = document.createElement('style');
  style.id = 'x1brains-global-css';
  style.textContent = GLOBAL_CSS;
  document.head.appendChild(style);
}
