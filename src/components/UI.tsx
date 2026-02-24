import React, { FC, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { NAV_LINKS } from '../constants';

// ─── XENBLOCKS TOKEN ICONS ───────────────────────────────────────────────────
// Primary: real PNGs from explorer.xenblocks.io
// Fallback: inline SVG data URIs
type XBKey = 'XNM' | 'XUNI' | 'XBLK';

const XB_TOKENS: { symbol: XBKey; color: string; glow: string; urls: string[] }[] = [
  {
    symbol: 'XNM', color: '#39ff88', glow: 'rgba(57,255,136,.5)',
    urls: [
      'https://explorer.xenblocks.io/tokens/xnm.png',
    ],
  },
  {
    symbol: 'XUNI', color: '#00e5ff', glow: 'rgba(0,229,255,.5)',
    urls: [
      'https://explorer.xenblocks.io/tokens/xuni.png',
    ],
  },
  {
    symbol: 'XBLK', color: '#b388ff', glow: 'rgba(179,136,255,.5)',
    urls: [
      'https://explorer.xenblocks.io/tokens/xblk.png',
    ],
  },
];

// Tiny inline SVG fallback per token
function xbFallbackSvg(letter: string, c1: string, c2: string, tc: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><circle cx="32" cy="32" r="30" fill="url(#g)" stroke="${c1}" stroke-width="2"/><text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-weight="900" font-size="22" fill="${tc}">${letter}</text></svg>`
  )}`;
}

const XB_FALLBACKS: Record<XBKey, string> = {
  XNM:  xbFallbackSvg('XNM', '#0a3d1a', '#145c2e', '#39ff88'),
  XUNI: xbFallbackSvg('UNI', '#0a2d3d', '#0f4060', '#00e5ff'),
  XBLK: xbFallbackSvg('BLK', '#1a0a3d', '#301060', '#b388ff'),
};

// Component that tries each URL, falls back to SVG
const XBTokenIcon: FC<{ token: typeof XB_TOKENS[0] }> = ({ token }) => {
  const [urlIndex, setUrlIndex] = useState(0);
  const [useFallback, setUseFallback] = useState(false);

  const handleError = () => {
    if (urlIndex < token.urls.length - 1) {
      setUrlIndex(i => i + 1);
    } else {
      setUseFallback(true);
    }
  };

  return (
    <img
      src={useFallback ? XB_FALLBACKS[token.symbol] : token.urls[urlIndex]}
      alt={token.symbol}
      onError={handleError}
      style={{
        width: 16, height: 16, borderRadius: '50%', objectFit: 'cover',
        border: `1.5px solid ${token.color}66`,
        boxShadow: `0 0 6px ${token.glow}`,
        background: '#111820',
      }}
    />
  );
};

// ─────────────────────────────────────────────
// TOP BAR — fixed top-right, wallet + nav links
// + POWERED BY XENBLOCKS badge fixed top-left
// ─────────────────────────────────────────────
export const TopBar: FC = () => {
  const [navOpen, setNavOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const isPortfolio    = location.pathname === '/portfolio';
  const isNFTLab       = location.pathname === '/lab-work';
  const isMint         = location.pathname === '/mint';
  const isBurnHistory  = location.pathname === '/burn-history';
  const isRewards      = location.pathname === '/rewards';
  const isAdminRewards = location.pathname === '/x9b7r41ns/ctrl';

  const isSubPage = isPortfolio || isNFTLab || isMint || isBurnHistory || isRewards || isAdminRewards;

  return (
    <>
      {/* Responsive styles for POWERED BY badge + nav */}
      <style>{`
        @media (max-width: 480px) {
          [data-xenblocks-badge] { display: none !important; }
        }
        @media (min-width: 481px) and (max-width: 768px) {
          [data-xenblocks-badge] .xb-token-badges { display: none !important; }
          [data-xenblocks-badge] .xb-divider { display: none !important; }
          [data-xenblocks-badge] .xb-powered { display: none !important; }
        }
        @media (max-width: 768px) {
          [data-topbar-nav] .tb-hide-mobile { display: none !important; }
        }
      `}</style>

      {/* ── POWERED BY XENBLOCKS — fixed top-left ── */}
      <div data-xenblocks-badge style={{
        position: 'fixed', top: 12, left: 16,
        zIndex: 9000,
        display: 'flex', alignItems: 'center', gap: 8,
        animation: 'fadeUp 0.3s ease both',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 14px',
          background: 'rgba(13,21,32,0.92)',
          border: '1px solid rgba(57,255,136,.2)',
          borderRadius: 8,
          backdropFilter: 'blur(12px)',
          transition: 'all 0.2s',
        }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(57,255,136,.5)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 0 16px rgba(57,255,136,.1)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(57,255,136,.2)'; (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
        >
          <span style={{ fontSize: 12 }}>⛏️</span>
          <span className="xb-powered" style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#39ff88', letterSpacing: 2, fontWeight: 700, textShadow: '0 0 8px rgba(57,255,136,.4)' }}>
            POWERED BY
          </span>
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#39ff88', letterSpacing: 2, fontWeight: 900, textShadow: '0 0 12px rgba(57,255,136,.6)' }}>
            XENBLOCKS
          </span>
          {/* Divider */}
          <div className="xb-divider" style={{ width: 1, height: 16, background: 'linear-gradient(180deg,transparent,rgba(57,255,136,.3),transparent)', marginLeft: 2, marginRight: 2 }} />
          {/* Token badges */}
          <div className="xb-token-badges" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {XB_TOKENS.map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <XBTokenIcon token={t} />
                <span style={{
                  fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 700,
                  color: t.color, letterSpacing: 1,
                  textShadow: `0 0 6px ${t.glow}`,
                }}>
                  {t.symbol}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── NAV + WALLET — fixed top-right ── */}
      <div data-topbar-nav style={{
        position: 'fixed', top: 12, right: 16,
        zIndex: 9000,
        display: 'flex', alignItems: 'center', gap: 8,
        animation: 'fadeUp 0.3s ease both',
      }}>

        {/* ← HOME pill — any sub-page */}
        {isSubPage && (
          <button className="tb-hide-mobile" onClick={() => navigate('/')}
            style={navPillStyle(false)}
            onMouseEnter={e => hoverOn(e)} onMouseLeave={e => hoverOff(e)}
          >
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#8aa0b8', letterSpacing: 2 }}>← HOME</span>
          </button>
        )}

        {/* Lab Work page also gets a Portfolio link */}
        {isNFTLab && (
          <button className="tb-hide-mobile" onClick={() => navigate('/portfolio')}
            style={navPillStyle(false)}
            onMouseEnter={e => hoverOn(e)} onMouseLeave={e => hoverOff(e)}
          >
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#8aa0b8', letterSpacing: 2 }}>💼 PORTFOLIO</span>
          </button>
        )}

        {/* Mint page gets quick links */}
        {isMint && (
          <>
            <button className="tb-hide-mobile" onClick={() => navigate('/lab-work')}
              style={navPillStyle(false)}
              onMouseEnter={e => hoverOn(e)} onMouseLeave={e => hoverOff(e)}
            >
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#8aa0b8', letterSpacing: 2 }}>🧠 LAB WORK</span>
            </button>
            <button className="tb-hide-mobile" onClick={() => navigate('/portfolio')}
              style={navPillStyle(false)}
              onMouseEnter={e => hoverOn(e)} onMouseLeave={e => hoverOff(e)}
            >
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#8aa0b8', letterSpacing: 2 }}>💼 PORTFOLIO</span>
            </button>
          </>
        )}

        {/* Burn History page gets Portfolio + Rewards links */}
        {isBurnHistory && (
          <>
            <button className="tb-hide-mobile" onClick={() => navigate('/portfolio')}
              style={navPillStyle(false)}
              onMouseEnter={e => hoverOn(e)} onMouseLeave={e => hoverOff(e)}
            >
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#8aa0b8', letterSpacing: 2 }}>💼 PORTFOLIO</span>
            </button>
            <button className="tb-hide-mobile" onClick={() => navigate('/rewards')}
              style={{
                ...navPillStyle(false),
                borderColor: 'rgba(255,204,85,.25)',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,204,85,.08)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,204,85,.5)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(10,14,20,0.85)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,204,85,.25)'; }}
            >
              <span style={{ fontSize: 12 }}>🏆</span>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#ffcc55', letterSpacing: 2, fontWeight: 700 }}>REWARDS</span>
            </button>
          </>
        )}

        {/* Rewards / Admin pages get Burns link back */}
        {(isRewards || isAdminRewards) && (
          <>
            <button className="tb-hide-mobile" onClick={() => navigate('/burn-history')}
              style={navPillStyleBurn()}
              onMouseEnter={e => hoverOnBurn(e)} onMouseLeave={e => hoverOffBurn(e)}
            >
              <span style={{ fontSize: 12 }}>🔥</span>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#ff8c55', letterSpacing: 2, fontWeight: 700 }}>INCINERATOR</span>
            </button>
            <button className="tb-hide-mobile" onClick={() => navigate('/portfolio')}
              style={navPillStyle(false)}
              onMouseEnter={e => hoverOn(e)} onMouseLeave={e => hoverOff(e)}
            >
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#8aa0b8', letterSpacing: 2 }}>💼 PORTFOLIO</span>
            </button>
          </>
        )}

        {/* 🔥 INCINERATOR pill — show on portfolio page */}
        {isPortfolio && (
          <button className="tb-hide-mobile" onClick={() => navigate('/burn-history')}
            style={navPillStyleBurn()}
            onMouseEnter={e => hoverOnBurn(e)} onMouseLeave={e => hoverOffBurn(e)}
          >
            <span style={{ fontSize: 12 }}>🔥</span>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#ff8c55', letterSpacing: 2, fontWeight: 700 }}>INCINERATOR</span>
          </button>
        )}

        {/* 🔬 MINT quick-access — show on non-mint pages */}
        {!isMint && (
          <button className="tb-hide-mobile" onClick={() => navigate('/mint')}
            style={navPillStyleMint()}
            onMouseEnter={e => hoverOnMint(e)} onMouseLeave={e => hoverOffMint(e)}
          >
            <span style={{ fontSize: 12 }}>🔬</span>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#bf5af2', letterSpacing: 2, fontWeight: 700 }}>MINT</span>
            <span style={{
              fontFamily: 'Orbitron, monospace', fontSize: 6, color: '#0a0e14',
              background: '#bf5af2', borderRadius: 4, padding: '1px 5px', fontWeight: 900, letterSpacing: 1,
            }}>NEW</span>
          </button>
        )}

        {/* Ecosystem links dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setNavOpen(o => !o)}
            style={navPillStyle(navOpen)}
            onMouseEnter={e => !navOpen && hoverOn(e)}
            onMouseLeave={e => !navOpen && hoverOff(e)}
          >
            <span style={{ fontSize: 14 }}>⚡</span>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: navOpen ? '#ff8c00' : '#5c7a90', letterSpacing: 2, fontWeight: 700 }}>LINKS</span>
            <span style={{ fontSize: 9, color: navOpen ? '#ff8c00' : '#3a5570', display: 'inline-block', transform: navOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
          </button>

          {navOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 8px)', right: 0,
              background: 'rgba(10,14,20,0.97)',
              border: '1px solid #1e3050', borderRadius: 12,
              padding: 8, minWidth: 180,
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
              backdropFilter: 'blur(20px)', zIndex: 9001,
            }}>
              <div style={{ padding: '6px 10px 10px', borderBottom: '1px solid #1e3050', marginBottom: 6 }}>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#5c7a90', letterSpacing: 3 }}>X1 Ecosystem</span>
              </div>
              {/* Incinerator quick link inside dropdown */}
              <button
                onClick={() => { navigate('/burn-history'); setNavOpen(false); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 7, background: 'transparent', border: 'none', cursor: 'pointer', width: '100%', transition: 'all 0.15s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,80,0,0.08)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                <span style={{ fontSize: 14 }}>🔥</span>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#ff8c55', letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase' }}>Incinerator</span>
              </button>
              {NAV_LINKS.map(link => (
                <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer"
                  onClick={() => setNavOpen(false)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 7, textDecoration: 'none', transition: 'all 0.15s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255,140,0,0.08)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'transparent'; }}
                >
                  <span style={{ fontSize: 14 }}>{link.icon}</span>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#8aa0b8', letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase' }}>{link.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: '#4a6070' }}>↗</span>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Wallet button */}
        <div style={{
          background: 'rgba(10,14,20,0.92)',
          border: '1px solid #1e3050', borderRadius: 8,
          backdropFilter: 'blur(12px)',
          position: 'relative', zIndex: 9002,
        }}>
          <WalletMultiButton />
        </div>
      </div>
    </>
  );
};

// ─── PILL STYLES ──────────────────────────────────────────────────────────────
function navPillStyle(active: boolean): React.CSSProperties {
  return {
    background: active
      ? 'linear-gradient(135deg, rgba(255,140,0,0.2), rgba(255,183,0,0.1))'
      : 'rgba(13,21,32,0.92)',
    border: `1px solid ${active ? '#ff8c00' : '#1e3050'}`,
    borderRadius: 8, padding: '7px 12px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 6,
    backdropFilter: 'blur(12px)', transition: 'all 0.2s',
  };
}
function navPillStyleMint(): React.CSSProperties {
  return {
    background: 'rgba(191,90,242,0.08)',
    border: '1px solid rgba(191,90,242,0.35)',
    borderRadius: 8, padding: '7px 12px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 6,
    backdropFilter: 'blur(12px)', transition: 'all 0.2s',
  };
}
function navPillStyleBurn(): React.CSSProperties {
  return {
    background: 'rgba(255,80,0,0.08)',
    border: '1px solid rgba(255,80,0,0.35)',
    borderRadius: 8, padding: '7px 12px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 6,
    backdropFilter: 'blur(12px)', transition: 'all 0.2s',
  };
}

// ─── HOVER HANDLERS ───────────────────────────────────────────────────────────
function hoverOn(e: React.MouseEvent)  { (e.currentTarget as HTMLElement).style.borderColor = '#ff8c00'; }
function hoverOff(e: React.MouseEvent) { (e.currentTarget as HTMLElement).style.borderColor = '#1e3050'; }
function hoverOnMint(e: React.MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  el.style.borderColor = '#bf5af2';
  el.style.background  = 'rgba(191,90,242,0.18)';
}
function hoverOffMint(e: React.MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  el.style.borderColor = 'rgba(191,90,242,0.35)';
  el.style.background  = 'rgba(191,90,242,0.08)';
}
function hoverOnBurn(e: React.MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  el.style.borderColor = 'rgba(255,100,0,.7)';
  el.style.background  = 'rgba(255,80,0,0.18)';
}
function hoverOffBurn(e: React.MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  el.style.borderColor = 'rgba(255,80,0,0.35)';
  el.style.background  = 'rgba(255,80,0,0.08)';
}

// ─────────────────────────────────────────────
// FLOATING SIDE NAVIGATION
// ─────────────────────────────────────────────
interface SideNavProps {
  activeSection: string;
  onNavigate:   (section: string) => void;
  showSPL:      boolean;
  showT22:      boolean;
  showLP:       boolean;
  splCount:     number;
  t22Count:     number;
  lpCount:      number;
  hasBrains?:   boolean;
}

export const SideNav: FC<SideNavProps> = ({
  activeSection, onNavigate,
  showSPL, showT22, showLP,
  splCount, t22Count, lpCount,
  hasBrains = false,
}) => {
  const navItems = [
    { id: 'top',        label: 'Top',           icon: '🏠',  color: '#00d4ff', show: true,                        isBurn: false },
    { id: 'burn',       label: 'Burn BRAINS',   icon: '🔥',  color: '#ff4422', show: hasBrains,                   isBurn: true  },
    { id: 'spl',        label: 'SPL Tokens',    icon: '🪙',  color: '#ff8c00', show: showSPL && splCount > 0,     isBurn: false },
    { id: 't22',        label: 'Token-2022',    icon: '⚡',  color: '#ffb700', show: showT22 && t22Count > 0,     isBurn: false },
    { id: 'lp',         label: 'LP Tokens',     icon: '💧',  color: '#00c98d', show: showLP  && lpCount  > 0,     isBurn: false },
    { id: 'xenblocks',  label: 'XenBlocks',     icon: '⛏️', color: '#bf5af2', show: true,                        isBurn: false },
  ].filter(item => item.show);

  const BTN  = 46;
  const GAP  = 8;
  const FONT = 20;

  return (
    <>
      <style>{`
        @media (max-width: 1024px) {
          [data-sidenav-container] { display: none !important; }
        }
        @keyframes burn-nav-flicker {
          0%,100% { opacity: 1;    }
          45%     { opacity: 0.72; }
          55%     { opacity: 0.82; }
        }
        @keyframes burn-nav-pulse {
          0%,100% { box-shadow: 0 0 18px rgba(255,68,34,.85), 0 0 36px rgba(255,68,34,.4); }
          50%     { box-shadow: 0 0 28px rgba(255,100,60,1),  0 0 52px rgba(255,60,20,.6); }
        }
        button:hover .nav-tooltip { opacity: 1 !important; }
      `}</style>

      <div
        data-sidenav-container
        style={{
          position: 'fixed', left: 14, top: '50%',
          transform: 'translateY(-50%)',
          zIndex: 50, display: 'flex', flexDirection: 'column', gap: GAP,
          animation: 'fadeUp 0.3s ease both',
        }}
      >
        {navItems.map((item) => {
          const isActive = activeSection === item.id;
          const tooltip = (
            <div className="nav-tooltip" style={{
              position: 'absolute', left: BTN + 12, top: '50%', transform: 'translateY(-50%)',
              padding: '6px 12px',
              background: item.isBurn
                ? 'linear-gradient(135deg, rgba(255,80,40,.95), rgba(180,20,0,.92))'
                : `linear-gradient(135deg, ${item.color}e0, ${item.color}b0)`,
              border: item.isBurn ? '1px solid rgba(255,100,60,.5)' : `1px solid ${item.color}60`,
              borderRadius: 7, whiteSpace: 'nowrap',
              fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700,
              letterSpacing: 1, color: '#fff',
              opacity: 0, pointerEvents: 'none', transition: 'opacity 0.2s ease',
              boxShadow: item.isBurn ? '0 4px 16px rgba(255,60,20,.45)' : `0 4px 14px ${item.color}55`,
              textShadow: '0 1px 3px rgba(0,0,0,.5)', zIndex: 100,
            }}>
              {item.isBurn ? '🔥 Burn BRAINS' : item.label}
            </div>
          );

          if (item.isBurn) {
            return (
              <button key={item.id} onClick={() => onNavigate(item.id)} style={{
                position: 'relative', width: BTN, height: BTN, flexShrink: 0,
                border: `2px solid ${isActive ? '#ff6644' : 'rgba(255,80,40,.5)'}`,
                borderRadius: 11,
                background: isActive ? 'linear-gradient(135deg, rgba(255,80,40,.24), rgba(180,20,0,.2))' : 'linear-gradient(135deg, rgba(255,60,20,.13), rgba(160,10,0,.1))',
                backdropFilter: 'blur(10px)', cursor: 'pointer', outline: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: FONT,
                transition: 'border-color 0.25s, background 0.25s, box-shadow 0.25s, transform 0.2s',
                animation: isActive ? 'burn-nav-pulse 1.8s ease infinite' : 'none',
                boxShadow: isActive ? '0 0 18px rgba(255,68,34,.85), 0 0 36px rgba(255,68,34,.4)' : '0 0 10px rgba(255,60,20,.25), 0 3px 8px rgba(0,0,0,.35)',
              }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#ff6644'; e.currentTarget.style.boxShadow = '0 0 24px rgba(255,80,40,.8), 0 0 48px rgba(255,50,10,.45)'; e.currentTarget.style.transform = 'scale(1.08) translateX(3px)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = isActive ? '#ff6644' : 'rgba(255,80,40,.5)'; e.currentTarget.style.boxShadow = isActive ? '0 0 18px rgba(255,68,34,.85), 0 0 36px rgba(255,68,34,.4)' : '0 0 10px rgba(255,60,20,.25), 0 3px 8px rgba(0,0,0,.35)'; e.currentTarget.style.transform = 'scale(1) translateX(0)'; }}
              >
                <span style={{ display: 'inline-block', animation: 'burn-nav-flicker 2.4s ease-in-out infinite', filter: isActive ? 'drop-shadow(0 0 7px rgba(255,100,40,.95)) drop-shadow(0 0 14px rgba(255,60,0,.6))' : 'drop-shadow(0 0 4px rgba(255,80,30,.65))' }}>🔥</span>
                <div style={{ position: 'absolute', bottom: 4, right: 4, width: 5, height: 5, borderRadius: '50%', background: '#ff6644', boxShadow: '0 0 5px rgba(255,80,40,.9)', animation: 'burn-nav-flicker 1.4s ease-in-out infinite' }} />
                {tooltip}
              </button>
            );
          }

          return (
            <button key={item.id} onClick={() => onNavigate(item.id)} style={{
              position: 'relative', width: BTN, height: BTN, flexShrink: 0,
              border: `2px solid ${isActive ? item.color : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 11,
              background: isActive ? `linear-gradient(135deg, ${item.color}18, ${item.color}06)` : 'rgba(13,21,32,0.88)',
              backdropFilter: 'blur(10px)', cursor: 'pointer', outline: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: FONT,
              transition: 'border-color 0.25s, background 0.25s, box-shadow 0.25s, transform 0.2s',
              boxShadow: isActive ? `0 0 18px ${item.color}70, 0 0 36px ${item.color}38` : '0 3px 10px rgba(0,0,0,0.3)',
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = item.color; e.currentTarget.style.background = `linear-gradient(135deg, ${item.color}28, ${item.color}0a)`; e.currentTarget.style.boxShadow = `0 0 22px ${item.color}88, 0 0 44px ${item.color}44`; e.currentTarget.style.transform = 'scale(1.08) translateX(3px)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = isActive ? item.color : 'rgba(255,255,255,0.08)'; e.currentTarget.style.background = isActive ? `linear-gradient(135deg, ${item.color}18, ${item.color}06)` : 'rgba(13,21,32,0.88)'; e.currentTarget.style.boxShadow = isActive ? `0 0 18px ${item.color}70, 0 0 36px ${item.color}38` : '0 3px 10px rgba(0,0,0,0.3)'; e.currentTarget.style.transform = 'scale(1) translateX(0)'; }}
            >
              <span style={{ filter: isActive ? `drop-shadow(0 0 7px ${item.color})` : 'none' }}>{item.icon}</span>
              {tooltip}
            </button>
          );
        })}
      </div>
    </>
  );
};

// ─────────────────────────────────────────────
// PAGE BACKGROUND
// ─────────────────────────────────────────────
export const PageBackground: FC = () => (
  <>
    <div style={{
      position: 'fixed', inset: 0, zIndex: 0,
      backgroundImage: `
        linear-gradient(rgba(255,140,0,0.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,140,0,0.025) 1px, transparent 1px)
      `,
      backgroundSize: '48px 48px', pointerEvents: 'none',
    }} />
    <div style={{ position: 'fixed', top: -200, right: -200, width: 600, height: 600, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,140,0,0.06) 0%, transparent 70%)', pointerEvents: 'none', zIndex: 0 }} />
    <div style={{ position: 'fixed', bottom: -300, left: -200, width: 700, height: 700, borderRadius: '50%', background: 'radial-gradient(circle, rgba(0,212,255,0.04) 0%, transparent 70%)', pointerEvents: 'none', zIndex: 0 }} />
  </>
);

// ─────────────────────────────────────────────
// SPINNER
// ─────────────────────────────────────────────
export const Spinner: FC<{ label?: string }> = ({ label = 'Loading...' }) => (
  <div style={{ textAlign: 'center', padding: '50px 20px' }}>
    <div style={{ width: 48, height: 48, border: '3px solid rgba(255,140,0,0.15)', borderTop: '3px solid #ff8c00', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
    <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#5c7a90', letterSpacing: 2, textTransform: 'uppercase' }}>{label}</div>
  </div>
);

// ─────────────────────────────────────────────
// STATS BAR
// ─────────────────────────────────────────────
export const StatsBar: FC<{ items: { label: string; value: string | number; color?: string }[] }> = ({ items }) => (
  <div style={{ display: 'flex', gap: 1, marginBottom: 24, background: '#0d1520', borderRadius: 10, border: '1px solid #1e3050', overflow: 'hidden' }}>
    {items.map((item, i) => (
      <div key={i} style={{ flex: 1, padding: '12px 16px', textAlign: 'center', borderRight: i < items.length - 1 ? '1px solid #1e3050' : 'none' }}>
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 700, color: item.color || '#ff8c00', marginBottom: 3 }}>{item.value}</div>
        <div style={{ fontSize: 9, color: '#6a8ea8', letterSpacing: 2, textTransform: 'uppercase', fontFamily: 'Orbitron, monospace' }}>{item.label}</div>
      </div>
    ))}
  </div>
);

// ─────────────────────────────────────────────
// SECTION HEADER
// ─────────────────────────────────────────────
export const SectionHeader: FC<{
  label: string;
  count?: number;
  color?: string;
  hiddenCount?: number;
  icon?: string;
}> = ({ label, count, color = '#ff8c00', hiddenCount = 0, icon }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, marginTop: 28 }}>
    {icon && <span style={{ fontSize: 16 }}>{icon}</span>}
    <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700, letterSpacing: 3, color, textTransform: 'uppercase' }}>
      {label}
    </span>
    {count !== undefined && (
      <span style={{ background: `${color}20`, border: `1px solid ${color}40`, color, fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>
        {count}
      </span>
    )}
    {hiddenCount > 0 && (
      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#4a6070', letterSpacing: 1.5 }}>{hiddenCount} hidden</span>
    )}
    <div style={{ flex: 1, height: 1, background: `linear-gradient(to right, ${color}40, transparent)` }} />
  </div>
);

// ─────────────────────────────────────────────
// PIPELINE BAR
// ─────────────────────────────────────────────
export const PipelineBar: FC<{ text: string }> = ({ text }) => (
  <div style={{ marginTop: 16, padding: '10px 14px', background: 'rgba(0,212,255,0.04)', border: '1px solid rgba(0,212,255,0.1)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
    <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#00d4ff', flexShrink: 0 }} />
    <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#8ab0c8', letterSpacing: 1.5 }}>{text}</span>
  </div>
);

// ─────────────────────────────────────────────
// FOOTER
// ─────────────────────────────────────────────
export const Footer: FC = () => (
  <footer style={{ marginTop: 48, paddingTop: 20, borderTop: '1px solid #1e3050', display: 'flex', justifyContent: 'center', gap: 24, flexWrap: 'wrap' }}>
    {[
      { label: 'X1.Ninja',  href: 'https://x1.ninja' },
      { label: 'X1 Brains', href: 'https://x1brains.xyz' },
      { label: 'XDex',      href: 'https://app.xdex.xyz' },
      { label: 'Explorer',  href: 'https://explorer.mainnet.x1.xyz' },
    ].map(link => (
      <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer"
        style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, letterSpacing: 2, color: '#5c7a90', textDecoration: 'none', textTransform: 'uppercase', transition: 'color 0.2s' }}
        onMouseEnter={e => (e.currentTarget as HTMLAnchorElement).style.color = '#ff8c00'}
        onMouseLeave={e => (e.currentTarget as HTMLAnchorElement).style.color = '#5c7a90'}
      >{link.label}</a>
    ))}
  </footer>
);

// ─────────────────────────────────────────────
// ADDRESS BAR
// ─────────────────────────────────────────────
export const AddressBar: FC<{ address: string }> = ({ address }) => (
  <div style={{
    background: 'linear-gradient(135deg, #0d1520, #111820)',
    border: '1px solid #1e3050', borderRadius: 10,
    padding: '12px 18px', marginBottom: 24,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    animation: 'fadeUp 0.4s ease 0.15s both',
  }}>
    <div>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#6a8ea8', letterSpacing: 3, marginBottom: 5, textTransform: 'uppercase' }}>Connected Operator</div>
      <div style={{ fontFamily: 'Sora, monospace', fontSize: 11, color: '#00d4ff', wordBreak: 'break-all' }}>{address}</div>
    </div>
    <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00c98d', flexShrink: 0, animation: 'pulse-orange 2s ease infinite' }} />
  </div>
);