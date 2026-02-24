// src/components/BurnPortal.tsx
// ─────────────────────────────────────────────────────────────────────────────
// BURN PORTAL — Animated fire portal header for the Burn History page
// Drop-in component: <BurnPortal isMobile={isMobile} />
// ─────────────────────────────────────────────────────────────────────────────

import React, { FC, useEffect, useRef, useState, useMemo } from 'react';
import { BRAINS_LOGO } from '../constants';

// ─── KEYFRAME INJECTION ───────────────────────────────────────────────────────
// Call once at app load (idempotent — checks for existing style tag)
export function injectPortalStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('burn-portal-styles')) return;
  const el = document.createElement('style');
  el.id = 'burn-portal-styles';
  el.textContent = `
    @keyframes bp-spin         { to { transform: rotate(360deg); } }
    @keyframes bp-spin-rev     { to { transform: rotate(-360deg); } }
    @keyframes bp-portal-pulse {
      0%,100% { opacity: .45; transform: translate(-50%,-50%) scale(1);   }
      50%     { opacity: 1;   transform: translate(-50%,-50%) scale(1.10); }
    }
    @keyframes bp-ring-drift {
      0%,100% { opacity: .35; transform: translate(-50%,-50%) scale(.97); }
      50%     { opacity: .7;  transform: translate(-50%,-50%) scale(1.03); }
    }
    @keyframes bp-ember {
      0%   { opacity: .15; transform: translateY(0px) scale(.5); }
      100% { opacity: .95; transform: translateY(-9px) scale(1.1); }
    }
    @keyframes bp-node-glow {
      0%,100% { opacity: .7; box-shadow: 0 0 8px #ff6600, 0 0 16px rgba(255,140,0,.6); }
      50%     { opacity: 1;  box-shadow: 0 0 18px #ff9900, 0 0 36px rgba(255,160,0,.8); }
    }
    @keyframes bp-node-glow-green {
      0%,100% { opacity: .7; box-shadow: 0 0 10px #39ff88, 0 0 20px rgba(57,255,136,.6); }
      50%     { opacity: 1;  box-shadow: 0 0 22px #39ff88, 0 0 44px rgba(57,255,136,.9); }
    }
    @keyframes bp-heat-wave {
      0%,100% { background-position: 0% 50%;   }
      50%     { background-position: 100% 50%; }
    }
    @keyframes bp-title-flicker {
      0%,92%,96%,100% { opacity: 1; }
      94%             { opacity: .88; }
    }
    @keyframes bp-spark {
      0%   { opacity: 0; transform: translate(0,0) scale(0); }
      20%  { opacity: 1; }
      100% { opacity: 0; transform: translate(var(--sx),var(--sy)) scale(.3); }
    }
    @keyframes bp-green-pulse { 0%,100%{opacity:.5;box-shadow:0 0 8px #39ff88,0 0 20px rgba(57,255,136,.3)} 50%{opacity:1;box-shadow:0 0 16px #39ff88,0 0 40px rgba(57,255,136,.5)} }
    @keyframes bp-green-ring  { 0%,100%{opacity:.3;box-shadow:0 0 12px rgba(57,255,136,.2),inset 0 0 12px rgba(57,255,136,.1)} 50%{opacity:.7;box-shadow:0 0 24px rgba(57,255,136,.4),inset 0 0 24px rgba(57,255,136,.15)} }
    @keyframes bp-fade-up {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(el);
}

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────

/** A single spark particle that floats outward from center */
const Spark: FC<{ angle: number; dist: number; delay: number; color: string }> = ({
  angle, dist, delay, color,
}) => {
  const rad = (angle * Math.PI) / 180;
  const sx  = `${Math.cos(rad) * dist}px`;
  const sy  = `${Math.sin(rad) * dist}px`;
  return (
    <div style={{
      position: 'absolute',
      top: '50%', left: '50%',
      width: 3, height: 3,
      marginTop: -1.5, marginLeft: -1.5,
      borderRadius: '50%',
      background: color,
      boxShadow: `0 0 10px ${color}, 0 0 20px ${color}88`,
      // @ts-ignore CSS custom properties
      '--sx': sx, '--sy': sy,
      animation: `bp-spark ${1.4 + delay * 0.3}s ease-out ${delay}s infinite`,
      pointerEvents: 'none',
    } as React.CSSProperties} />
  );
};

/** Orbital ring with evenly-spaced ember nodes */
const OrbitRing: FC<{
  size: number;
  borderColor: string;
  glowColor: string;
  spinDuration: number;
  reverse?: boolean;
  nodeCount?: number;
  nodeColor?: string;
}> = ({ size, borderColor, glowColor, spinDuration, reverse = false, nodeCount = 0, nodeColor = '#ff7744' }) => (
  <div style={{
    position: 'absolute',
    top: '50%', left: '50%',
    width: size, height: size,
    marginTop: -size / 2, marginLeft: -size / 2,
    borderRadius: '50%',
    border: `1px solid ${borderColor}`,
    boxShadow: `0 0 24px ${glowColor}, 0 0 48px ${glowColor}, inset 0 0 20px ${glowColor}`,
    animation: `${reverse ? 'bp-spin-rev' : 'bp-spin'} ${spinDuration}s linear infinite`,
    pointerEvents: 'none',
  }}>
    {Array.from({ length: nodeCount }).map((_, i) => {
      const deg = (360 / nodeCount) * i;
      const rad = (deg * Math.PI) / 180;
      const r   = size / 2;
      return (
        <div key={i} style={{
          position: 'absolute',
          width: 5, height: 5,
          borderRadius: '50%',
          background: nodeColor,
          top:  r + Math.sin(rad) * r - 2.5,
          left: r + Math.cos(rad) * r - 2.5,
          animation: `bp-node-glow ${1.2 + i * 0.18}s ease-in-out ${i * 0.12}s infinite`,
        }} />
      );
    })}
  </div>
);

/** The spinning logo at the center of the portal */
const PortalLogo: FC<{
  size: number;
  isF?: boolean;
  rings: { size: number; borderColor: string; glowColor: string; spinDuration: number; reverse?: boolean; nodeCount?: number; nodeColor?: string }[];
  sparks: { angle: number; dist: number; delay: number; color: string }[];
}> = ({ size, isF = false, rings, sparks }) => (
  <div style={{ position: 'relative', width: size, height: size, display: 'inline-block' }}>

    {/* ── ORBIT RINGS — all centered exactly on logo ── */}
    {rings.map((r, i) => (
      <div key={i} style={{
        position: 'absolute',
        top: '50%', left: '50%',
        width: r.size, height: r.size,
        marginTop: -r.size / 2, marginLeft: -r.size / 2,
        borderRadius: '50%',
        border: `1px solid ${r.borderColor}`,
        boxShadow: `0 0 16px ${r.glowColor}, inset 0 0 16px ${r.glowColor}`,
        animation: `${r.reverse ? 'bp-spin-rev' : 'bp-spin'} ${r.spinDuration}s linear infinite`,
        pointerEvents: 'none', zIndex: 0,
      }}>
        {Array.from({ length: r.nodeCount ?? 0 }).map((_, ni) => {
          const deg = (360 / (r.nodeCount ?? 1)) * ni;
          const rad = (deg * Math.PI) / 180;
          const rv  = r.size / 2;
          return (
            <div key={ni} style={{
              position: 'absolute', width: 5, height: 5, borderRadius: '50%',
              background: r.nodeColor ?? '#ff7744',
              boxShadow: `0 0 8px ${r.nodeColor ?? '#ff7744'}`,
              top: rv + Math.sin(rad) * rv - 2.5,
              left: rv + Math.cos(rad) * rv - 2.5,
              animation: `bp-node-glow ${1.2 + ni * 0.18}s ease-in-out ${ni * 0.12}s infinite`,
            }} />
          );
        })}
      </div>
    ))}

    {/* ── SPARK PARTICLES — also centered on logo ── */}
    <div style={{ position: 'absolute', top: '50%', left: '50%', width: 0, height: 0, pointerEvents: 'none', zIndex: 0 }}>
      {sparks.map((s, i) => <Spark key={i} {...s} />)}
    </div>

    {/* ── OUTER HEAT SHIMMER RING ── */}
    <div style={{
      position: 'absolute',
      top: '50%', left: '50%',
      width: size * 2.4, height: size * 2.4,
      marginTop: -(size * 2.4) / 2, marginLeft: -(size * 2.4) / 2,
      borderRadius: '50%',
      border: isF?'1px dashed rgba(255,102,0,0.12)':'1px dashed rgba(160,60,255,0.18)',
      animation: 'bp-ring-drift 6s ease-in-out infinite',
      pointerEvents: 'none', zIndex: 0,
    }} />

    {/* ── RING LAYER 1 — outer glow halo, seamless, no conic ── */}
    <div style={{
      position: 'absolute',
      inset: -10,
      borderRadius: '50%',
      border: '2px solid transparent',
      background: isF?'linear-gradient(#0a090c,#0a090c) padding-box, conic-gradient(from 0deg, #ff2222, #ff4400, #ff6600, #ffbb33, #ff6600, #ff2222) border-box':'linear-gradient(#0b0f16,#0b0f16) padding-box, conic-gradient(from 0deg, #39ff88, #aa44ff, #ff7700, #ff2200, #aa00ff, #39ff88) border-box',
      animation: 'bp-spin 3.5s linear infinite',
      opacity: 0.95,
    }} />

    {/* ── RING LAYER 2 — tighter ring, reverse spin ── */}
    <div style={{
      position: 'absolute',
      inset: -5,
      borderRadius: '50%',
      border: '2px solid transparent',
      background: isF?'linear-gradient(#0a090c,#0a090c) padding-box, conic-gradient(from 180deg, #cc1111, #ff4400, #ffbb33, #ff6600, #cc3300, #cc1111) border-box':'linear-gradient(#0b0f16,#0b0f16) padding-box, conic-gradient(from 180deg, #ff5500, #cc00ff, #39ff88, #ff8800, #7700cc, #ff5500) border-box',
      animation: 'bp-spin-rev 5s linear infinite',
      opacity: 0.75,
    }} />

    {/* ── RING LAYER 3 — inner tight ring, green pulse ── */}
    <div style={{
      position: 'absolute',
      inset: -2,
      borderRadius: '50%',
      border: '1.5px solid transparent',
      background: isF?'linear-gradient(#0a090c,#0a090c) padding-box, conic-gradient(from 90deg, #ffbb33, #ff6600, #ffbb33, #ff6600, #ffbb33) border-box':'linear-gradient(#0b0f16,#0b0f16) padding-box, conic-gradient(from 90deg, #39ff88, #00cc55, #39ff88, #00cc55, #39ff88) border-box',
      animation: 'bp-spin 2s linear infinite',
      opacity: 0.8,
    }} />

    {/* ── GLOW BLOOMS behind the rings ── */}
    <div style={{
      position: 'absolute', inset: -14, borderRadius: '50%',
      boxShadow: isF?'0 0 18px 4px rgba(255,102,0,0.15), 0 0 32px 8px rgba(255,34,34,0.1), 0 0 48px 12px rgba(255,187,51,0.06)':'0 0 18px 4px rgba(57,255,136,0.28), 0 0 32px 8px rgba(140,40,255,0.18), 0 0 48px 12px rgba(255,80,0,0.1)',
      pointerEvents: 'none',
    }} />

    {/* Logo */}
    <img
      src={BRAINS_LOGO}
      alt="BRAINS"
      style={{
        position: 'relative', zIndex: 2,
        width: size, height: size,
        borderRadius: '50%', objectFit: 'cover',
        border: isF?'2px solid rgba(255,102,0,0.5)':'2px solid rgba(57,255,136,0.35)',
        boxShadow: isF?'0 0 20px rgba(255,102,0,0.3), 0 0 40px rgba(255,34,34,0.15)':'0 0 20px rgba(57,255,136,0.3), 0 0 40px rgba(140,40,255,0.2)',
      }}
      onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
    />
    {/* Ember particles orbiting the logo */}
    {[
      { top: '8%',  left: '82%', color: isF?'#ff4400':'#ff7700', dur: 1.1, delay: 0    },
      { top: '75%', left: '88%', color: isF?'#ffbb33':'#ffcc00', dur: 1.4, delay: 0.2  },
      { top: '85%', left: '18%', color: isF?'#ff6600':'#39ff88', dur: 1.0, delay: 0.5  },
      { top: '15%', left: '12%', color: isF?'#ff2222':'#ffaa00', dur: 1.6, delay: 0.35 },
      { top: '50%', left: '92%', color: isF?'#ffdd44':'#ff3300', dur: 1.3, delay: 0.7  },
      { top: '30%', left: '5%',  color: isF?'#ff6600':'#aa44ff', dur: 1.2, delay: 0.15 },
      { top: '65%', left: '10%', color: isF?'#ff4400':'#cc66ff', dur: 1.5, delay: 0.55 },
    ].map((e, i) => (
      <div key={i} style={{
        position: 'absolute',
        width: 4, height: 4, borderRadius: '50%',
        background: e.color,
        boxShadow: `0 0 8px ${e.color}`,
        top: e.top, left: e.left,
        zIndex: 3,
        animation: `bp-ember ${e.dur}s ease-in-out ${e.delay}s infinite alternate`,
      }} />
    ))}
  </div>
);

/** Decorative horizontal rule with center flame */
const FlameRule: FC<{ width?: number | string; isF?: boolean }> = ({ width = '100%', isF = false }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, width, margin: '10px auto 0' }}>
    <div style={{
      flex: 1, height: 1,
      background: isF?'linear-gradient(90deg,transparent,rgba(255,34,34,0.4),rgba(255,102,0,0.3))':'linear-gradient(90deg,transparent,rgba(255,80,0,0.7),rgba(255,140,0,0.4))',
    }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 4, height: 4, borderRadius: '50%', background: isF?'#ff6600':'#39ff88', boxShadow: isF?'0 0 8px #ff6600':'0 0 8px #39ff88', animation: isF?'bp-node-glow 2s ease infinite':'bp-green-pulse 2s ease infinite' }} />
      <span style={{ fontSize: 18, filter: 'drop-shadow(0 0 8px #ff6600) drop-shadow(0 0 16px rgba(255,80,0,.5))' }}>🔥</span>
      <div style={{ width: 4, height: 4, borderRadius: '50%', background: isF?'#ff6600':'#39ff88', boxShadow: isF?'0 0 8px #ff6600':'0 0 8px #39ff88', animation: isF?'bp-node-glow 2s ease 1s infinite':'bp-green-pulse 2s ease 1s infinite' }} />
    </div>
    <div style={{
      flex: 1, height: 1,
      background: isF?'linear-gradient(90deg,rgba(255,102,0,0.3),rgba(255,34,34,0.4),transparent)':'linear-gradient(90deg,rgba(255,140,0,0.4),rgba(255,80,0,0.7),transparent)',
    }} />
  </div>
);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const short = (addr: string) => addr ? `${addr.slice(0,4)}…${addr.slice(-4)}` : '—';
const fmtN = (n: number, d: number) => n >= 1_000_000 ? `${(n/1e6).toFixed(d)}M` : n >= 1000 ? `${(n/1000).toFixed(d)}K` : n.toFixed(d);

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
interface BurnPortalProps {
  isMobile: boolean;
  themeName?: 'vegas' | 'fire';
}

export const BurnPortal: FC<BurnPortalProps> = ({ isMobile, themeName: themeNameProp }) => {
  // Direct localStorage sync — bypasses module-level state entirely
  const [themeName, setThemeName] = React.useState<'vegas'|'fire'>(() => {
    try { const s = localStorage.getItem('brains_theme'); if (s === 'vegas' || s === 'fire') return s; } catch {} return 'vegas';
  });
  React.useEffect(() => {
    const id = setInterval(() => {
      try {
        const s = localStorage.getItem('brains_theme') as 'vegas'|'fire';
        if (s === 'vegas' || s === 'fire') setThemeName(prev => prev === s ? prev : s);
      } catch {}
    }, 500);
    return () => clearInterval(id);
  }, []);
  const isF = (themeNameProp ?? themeName) === 'fire';
  const logoSize = isMobile ? 96 : 148;



  // Responsive ring sizes
  const ring1Size = isMobile ? 198 : 308;
  const ring2Size = isMobile ? 156 : 244;
  const ring3Size = isMobile ? 120 : 188;

  // Spread of the ambient glow behind everything
  const glowSize  = isMobile ? 280 : 460;

  // Sparks radiate from center
  const sparks = isF ? [
    { angle: 20,  dist: isMobile ? 100 : 160, delay: 0,    color: '#ff4400' },
    { angle: 80,  dist: isMobile ? 80 : 128, delay: 0.4,  color: '#ff6600' },
    { angle: 145, dist: isMobile ? 95 : 152, delay: 0.8,  color: '#ff2222' },
    { angle: 210, dist: isMobile ? 82 : 132, delay: 0.2,  color: '#ffbb33' },
    { angle: 270, dist: isMobile ? 96 : 156, delay: 0.6,  color: '#ff6600' },
    { angle: 330, dist: isMobile ? 78 : 124, delay: 1.0,  color: '#ffdd44' },
  ] : [
    { angle: 20,  dist: isMobile ? 100 : 160, delay: 0,    color: '#ff7700' },
    { angle: 80,  dist: isMobile ? 80 : 128, delay: 0.4,  color: '#aa44ff' },
    { angle: 145, dist: isMobile ? 95 : 152, delay: 0.8,  color: '#ff4400' },
    { angle: 210, dist: isMobile ? 82 : 132, delay: 0.2,  color: '#39ff88' },
    { angle: 270, dist: isMobile ? 96 : 156, delay: 0.6,  color: '#cc55ff' },
    { angle: 330, dist: isMobile ? 78 : 124, delay: 1.0,  color: '#ffdd00' },
  ];

  return (
    <div key={`bp-hero-${themeName}`} data-theme={themeName} style={{
      position: 'relative',
      textAlign: 'center',
      marginBottom: isMobile ? 28 : 52,
      paddingTop: isMobile ? 10 : 20,
      animation: 'bp-fade-up 0.6s ease both',
    }}>

      {/* ── AMBIENT BACKGROUND GLOW ── */}
      {/* Green outer halo */}
      <div style={{
        position: 'absolute',
        top: '50%', left: '50%',
        width: glowSize * 0.7, height: glowSize * 0.5,
        transform: 'translate(-50%,-60%)',
        borderRadius: '50%',
        background: isF?'radial-gradient(ellipse,rgba(255,102,0,0.1) 0%,rgba(255,60,0,0.04) 50%,transparent 75%)':'radial-gradient(ellipse,rgba(57,255,136,0.18) 0%,rgba(0,180,80,0.08) 50%,transparent 75%)',
        animation: 'bp-portal-pulse 5s ease-in-out 2s infinite',
        pointerEvents: 'none',
        filter: 'blur(18px)',
      }} />
      {/* Purple outer halo */}
      <div style={{
        position: 'absolute',
        top: '50%', left: '50%',
        width: glowSize * 1.2, height: glowSize * 0.85,
        transform: 'translate(-50%,-58%)',
        borderRadius: '50%',
        background: isF?'radial-gradient(ellipse,rgba(255,34,34,0.12) 0%,rgba(200,20,0,0.05) 50%,transparent 75%)':'radial-gradient(ellipse,rgba(140,40,255,0.25) 0%,rgba(100,20,200,0.12) 50%,transparent 75%)',
        animation: 'bp-portal-pulse 6s ease-in-out 1s infinite',
        pointerEvents: 'none',
        filter: 'blur(14px)',
      }} />
      {/* Fire core glow */}
      <div style={{
        position: 'absolute',
        top: '50%', left: '50%',
        width: glowSize, height: glowSize * 0.7,
        transform: 'translate(-50%,-60%)',
        borderRadius: '50%',
        background: isF?'radial-gradient(ellipse,rgba(255,80,0,0.15) 0%,rgba(255,40,0,0.06) 45%,transparent 70%)':'radial-gradient(ellipse,rgba(255,80,0,0.28) 0%,rgba(255,40,0,0.12) 45%,transparent 70%)',
        animation: 'bp-portal-pulse 4s ease-in-out infinite',
        pointerEvents: 'none',
        filter: 'blur(8px)',
      }} />





      {/* ── CENTER LOGO + all rings/sparks centered on it ── */}
      <div key={`portal-${isF?'f':'v'}`} style={{
        position: 'relative',
        display: 'inline-block',
        marginBottom: isMobile ? 20 : 30,
        zIndex: 2,
      }}>
        <PortalLogo
          size={logoSize}
          isF={isF}
          rings={isF?[
            { size: ring1Size, borderColor: 'rgba(255,34,34,0.25)',  glowColor: 'rgba(255,34,34,0.08)',   spinDuration: 14,  nodeCount: 8, nodeColor: '#ff4400' },
            { size: ring2Size, borderColor: 'rgba(255,102,0,0.45)', glowColor: 'rgba(255,102,0,0.15)',   spinDuration: 9,   reverse: true, nodeCount: 6, nodeColor: '#ff6600' },
            { size: ring3Size, borderColor: 'rgba(255,140,0,0.5)',  glowColor: 'rgba(255,140,0,0.12)',   spinDuration: 5,   nodeCount: 4, nodeColor: '#ffbb33' },
            { size: isMobile ? 86 : 136, borderColor: 'rgba(255,187,51,0.55)', glowColor: 'rgba(255,187,51,0.18)', spinDuration: 3.5, reverse: true, nodeCount: 3, nodeColor: '#ffdd44' },
          ]:[
            { size: ring1Size, borderColor: 'rgba(140,70,255,0.55)',  glowColor: 'rgba(57,255,136,0.22)',  spinDuration: 14,  nodeCount: 8, nodeColor: '#cc66ff' },
            { size: ring2Size, borderColor: 'rgba(255,140,0,0.75)',  glowColor: 'rgba(255,120,0,0.35)',   spinDuration: 9,   reverse: true, nodeCount: 6, nodeColor: '#ffcc55' },
            { size: ring3Size, borderColor: 'rgba(255,160,0,0.65)',  glowColor: 'rgba(255,140,0,0.3)',    spinDuration: 5,   nodeCount: 4, nodeColor: '#ffdd66' },
            { size: isMobile ? 86 : 136, borderColor: 'rgba(57,255,136,0.85)', glowColor: 'rgba(57,255,136,0.45)', spinDuration: 3.5, reverse: true, nodeCount: 3, nodeColor: '#39ff88' },
          ]}
          sparks={sparks}
        />
      </div>

      {/* ── TITLE BLOCK ── */}
      <div style={{ position: 'relative', zIndex: 2 }}>
        {/* Eyebrow label */}
        <div style={{
          fontFamily: 'Orbitron, monospace',
          fontSize: isMobile ? 11 : 14,
          letterSpacing: isMobile ? 4 : 7,
          color: isF?'#ff9944':'#cc88ff',
          textShadow: isF?'0 0 8px rgba(200,112,64,0.4), 0 0 18px rgba(200,80,48,0.2)':'0 0 12px rgba(180,80,255,0.9), 0 0 28px rgba(140,50,255,0.5)',
          textTransform: 'uppercase',
          marginBottom: isMobile ? 8 : 12,
          opacity: 1,
          fontWeight: 700,
        }}>
          X1 BRAINS · 🧪 LAB WORK
        </div>

        {/* Main heading */}
        <div style={{ filter: isF?'drop-shadow(0 0 16px rgba(200,112,64,0.5)) drop-shadow(0 0 30px rgba(200,56,56,0.2))':'drop-shadow(0 0 22px rgba(255,120,0,0.95)) drop-shadow(0 0 44px rgba(180,50,255,0.55))', animation: 'bp-title-flicker 8s ease-in-out infinite' }}>
          <h1 key={isF?'f':'v'} style={{
            fontFamily: 'Orbitron, monospace',
            fontSize: isMobile ? 28 : 46,
            fontWeight: 900,
            letterSpacing: isMobile ? 5 : 10,
            margin: '0 0 4px',
            textTransform: 'uppercase',
            lineHeight: 1.1,
            background: isF?'linear-gradient(135deg,#c85030 0%,#c87040 22%,#d4a050 44%,#e0d8d0 60%,#d4b860 78%,#c87040 100%)':'linear-gradient(135deg,#c85500 0%,#c060c0 22%,#c88030 44%,#5ec99a 66%,#c8a030 82%,#c04800 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            
          }}>
            INCINERATOR PROTOCOL
          </h1>
        </div>

        {/* Sub-label beneath heading */}
        <div style={{
          fontFamily: 'Orbitron, monospace',
          fontSize: isMobile ? 10 : 12,
          letterSpacing: isMobile ? 4 : 6,
          color: isF?'#a89cb0':'#ff9933',
          textShadow: isF?'0 0 10px rgba(255,140,0,0.3)':'0 0 10px rgba(255,140,0,0.8), 0 0 22px rgba(255,100,0,0.4)',
          textTransform: 'uppercase',
          marginBottom: 4,
          fontWeight: 600,
        }}>
          ALL · TIME · ON · CHAIN
        </div>

        {/* Flame decorative rule */}
        <FlameRule width={isMobile ? '85%' : '60%'} isF={isF} />

        {/* Heat wave accent line below title */}
        <div style={{
          height: 1,
          width: isMobile ? '70%' : '50%',
          margin: '10px auto 0',
          background: 'linear-gradient(90deg,transparent,rgba(255,80,0,0.8),rgba(255,160,0,1.0),rgba(255,80,0,0.8),transparent)',
          backgroundSize: '200% 100%',
          animation: 'bp-heat-wave 5s ease infinite',
        }} />

      </div>

    </div>

  );
};

export default BurnPortal;

// ─── BURN TRANSACTIONS PANEL ─────────────────────────────────────────────────
// Separate component for the global burn transactions list
// Usage: <BurnTransactions entries={entries} isMobile={isMobile} />
// ─────────────────────────────────────────────────────────────────────────────
import { BurnerEntry, fetchLeaderboard } from './BurnLeaderboard';
import { Connection } from '@solana/web3.js';

const short2 = (addr: string) => addr ? `${addr.slice(0,4)}…${addr.slice(-4)}` : '—';
const fmtN2 = (n: number, d: number) => n >= 1_000_000 ? `${(n/1e6).toFixed(d)}M` : n >= 1000 ? `${(n/1000).toFixed(d)}K` : n.toFixed(d);

interface BurnTxProps {
  entries?: BurnerEntry[];
  isMobile: boolean;
  loading?: boolean;
  connection?: Connection;
}

export const BurnTransactions: FC<BurnTxProps> = ({ entries: externalEntries, isMobile, loading: externalLoading = false, connection }) => {
  // Self-fetch when no entries provided (e.g. wallet not connected)
  const [selfEntries, setSelfEntries] = useState<BurnerEntry[]>([]);
  const [selfLoading, setSelfLoading] = useState(false);
  const fetchedRef = useRef(false);

  const hasExternal = externalEntries && externalEntries.length > 0;

  useEffect(() => {
    // If parent already provided entries, no need to self-fetch
    if (hasExternal) return;
    // Already fetched successfully
    if (fetchedRef.current && selfEntries.length > 0) return;
    if (!connection) return;

    // Prevent duplicate concurrent fetches
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    setSelfLoading(true);
    const ctrl = new AbortController();
    fetchLeaderboard(connection, ctrl.signal, (partial) => {
      setSelfEntries(prev => partial.length > prev.length ? partial : prev);
    }).then(final => {
      if (final && final.length > 0) setSelfEntries(final);
    }).catch((err) => {
      // Allow retry on error
      if (!ctrl.signal.aborted) fetchedRef.current = false;
    }).finally(() => setSelfLoading(false));
    return () => { ctrl.abort(); fetchedRef.current = false; };
  }, [connection, hasExternal]);

  const entries = hasExternal ? externalEntries! : selfEntries;
  const loading = externalLoading || selfLoading;
  const allTxs = useMemo(() =>
    entries.flatMap(e => (e.events ?? []).map(ev => ({ ...ev, wallet: e.address })))
      .sort((a, b) => b.blockTime - a.blockTime),
    [entries]
  );

  const [txFilter, setTxFilter] = useState('');
  const [txView, setTxView]     = useState<'all'|'wallet'>('all');
  const [txPage, setTxPage]     = useState(0);
  const PER_PAGE = 20;

  const { displayed, totalCount } = useMemo(() => {
    if (txView === 'wallet') {
      const wMap = new Map<string, { wallet:string; total:number; txs:number; lastTime:number }>();
      for (const tx of allTxs) {
        const w = wMap.get(tx.wallet);
        if (w) { w.total += tx.amount; w.txs++; if (tx.blockTime > w.lastTime) w.lastTime = tx.blockTime; }
        else wMap.set(tx.wallet, { wallet:tx.wallet, total:tx.amount, txs:1, lastTime:tx.blockTime });
      }
      let wallets = [...wMap.values()].sort((a,b) => b.total - a.total);
      if (txFilter) wallets = wallets.filter(w => w.wallet.toLowerCase().includes(txFilter.toLowerCase()));
      return { displayed: wallets.slice(txPage*PER_PAGE, (txPage+1)*PER_PAGE), totalCount: wallets.length };
    } else {
      let txs = allTxs;
      if (txFilter) txs = txs.filter(tx => tx.sig.toLowerCase().includes(txFilter.toLowerCase()) || tx.wallet.toLowerCase().includes(txFilter.toLowerCase()));
      return { displayed: txs.slice(txPage*PER_PAGE, (txPage+1)*PER_PAGE), totalCount: txs.length };
    }
  }, [allTxs, txFilter, txView, txPage]);

  return (
    <div style={{
      position:'relative', overflow:'hidden', borderRadius:14,
      background:'linear-gradient(160deg,#08060f,#0a0818,#06040e)',
      border:'1px solid rgba(140,60,255,.12)',
      boxShadow:'0 4px 40px rgba(0,0,0,.4), 0 0 60px rgba(255,140,0,.02)',
    }}>
      <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(100,60,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.02) 1px,transparent 1px)', backgroundSize:'24px 24px', pointerEvents:'none' }} />

      {/* Header */}
      <div style={{ position:'relative', zIndex:2, display:'flex', alignItems:'center', justifyContent:'space-between', padding:isMobile?'14px 14px':'16px 22px', background:'linear-gradient(90deg,rgba(255,140,0,.04),rgba(238,85,255,.02),rgba(140,60,255,.02),transparent)', borderBottom:'1px solid rgba(255,140,0,.08)', flexWrap:'wrap', gap:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 10px', background:'linear-gradient(135deg,rgba(255,140,0,.08),rgba(255,80,0,.04))', border:'1px solid rgba(255,140,0,.2)', borderRadius:16 }}>
            <div style={{ width:5, height:5, borderRadius:'50%', background:'#ff9933', boxShadow:'0 0 8px #ff9933', animation:'bp-green-pulse 1.6s ease infinite' }} />
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#ff9933', letterSpacing:2 }}>LIVE</span>
          </div>
          <div style={{ width:1, height:14, background:'rgba(255,140,0,.15)' }} />
          <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?11:13, fontWeight:700, letterSpacing:3, background:'linear-gradient(90deg,#ff9933,#ee55ff,#aa44ff)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text' }}>
            BURN TRANSACTIONS
          </span>
          <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#39ff88', background:'rgba(57,255,136,.06)', border:'1px solid rgba(57,255,136,.12)', padding:'2px 8px', borderRadius:10 }}>
            {allTxs.length}
          </span>
        </div>
        <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#8ebbcc', letterSpacing:2 }}>ALL WALLETS · ON-CHAIN</span>
      </div>

      {/* Filter bar */}
      <div style={{ position:'relative', zIndex:2, padding:isMobile?'10px 14px':'12px 22px', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', borderBottom:'1px solid rgba(140,60,255,.05)' }}>
        <input
          type="text"
          placeholder={txView==='wallet'?'Filter by wallet address…':'Filter by sig or wallet…'}
          value={txFilter}
          onChange={e => { setTxFilter(e.target.value); setTxPage(0); }}
          style={{ flex:1, minWidth:140, maxWidth:280, padding:'7px 14px', fontFamily:'Orbitron, monospace', fontSize:9, letterSpacing:1, background:'rgba(10,5,20,.6)', border:'1px solid rgba(140,60,255,.15)', borderRadius:8, color:'#c8dce8', outline:'none' }}
        />
        {(['all','wallet'] as const).map(key => (
          <button key={key} onClick={() => { setTxView(key); setTxFilter(''); setTxPage(0); }} style={{
            background: txView===key ? 'rgba(57,255,136,.12)' : 'rgba(140,60,255,.04)',
            border: `1px solid ${txView===key ? 'rgba(57,255,136,.3)' : 'rgba(140,60,255,.1)'}`,
            color: txView===key ? '#39ff88' : '#8ebbcc',
            padding:'5px 14px', fontFamily:'Orbitron, monospace', fontSize:8, letterSpacing:1,
            borderRadius:6, cursor:'pointer', transition:'all 0.15s',
          }}>{key==='all'?'🔥 ALL TXS':'🔗 BY WALLET'}</button>
        ))}
        <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#556677', marginLeft:'auto' }}>
          {Math.min(totalCount, (txPage+1)*PER_PAGE)}/{totalCount}
        </span>
      </div>

      {/* Column headers */}
      {allTxs.length > 0 && (
        <div style={{
          display:'grid',
          gridTemplateColumns: txView==='wallet'
            ? (isMobile?'1fr 90px 50px':'36px 1fr 140px 100px 60px')
            : (isMobile?'1fr 80px 70px':'36px 1fr 130px 100px 120px'),
          gap:8, padding:'8px 14px 6px', borderBottom:'1px solid rgba(120,60,255,.06)',
        }}>
          {(txView==='wallet'
            ? (isMobile?['WALLET','BURNED','TXS']:['#','WALLET ADDRESS','TOTAL BURNED','LB PTS','TXS'])
            : (isMobile?['TX HASH','AMOUNT','TIME']:['#','TX SIGNATURE','BURN AMOUNT','BURNER','DATE / TIME'])
          ).map(h => (
            <div key={h} style={{ fontFamily:'Orbitron, monospace', fontSize:7, color:'#8ebbcc', letterSpacing:2 }}>{h}</div>
          ))}
        </div>
      )}

      {/* Rows */}
      <div style={{ position:'relative', zIndex:1, padding:'4px 0' }}>
        {loading && allTxs.length === 0 && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:12, padding:'30px 20px' }}>
            <div style={{ width:18, height:18, border:'2px solid rgba(255,140,0,.2)', borderTop:'2px solid #ff9933', borderRadius:'50%', animation:'bp-spin .7s linear infinite' }} />
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:'#ff9933', letterSpacing:2 }}>SCANNING CHAIN…</span>
          </div>
        )}

        {!loading && allTxs.length === 0 && connection && selfEntries.length === 0 && !hasExternal && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:12, padding:'30px 20px' }}>
            <div style={{ width:18, height:18, border:'2px solid rgba(255,140,0,.2)', borderTop:'2px solid #ff9933', borderRadius:'50%', animation:'bp-spin .7s linear infinite' }} />
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:'#ff9933', letterSpacing:2 }}>LOADING BURN DATA…</span>
          </div>
        )}

        {!loading && allTxs.length === 0 && !connection && (
          <div style={{ textAlign:'center', padding:'40px 20px' }}>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:10, color:'#556677', letterSpacing:2 }}>NO BURN DATA AVAILABLE</span>
          </div>
        )}

        {displayed.map((item: any, i: number) => {
          if (txView === 'wallet') {
            const w = item as { wallet:string; total:number; txs:number; lastTime:number };
            return (
              <div key={w.wallet} style={{
                display:'grid',
                gridTemplateColumns:isMobile?'1fr 90px 50px':'36px 1fr 140px 100px 60px',
                gap:8, padding:'7px 14px',
                background:i%2===0?'rgba(140,60,255,.015)':'transparent',
                alignItems:'center', transition:'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background='rgba(140,60,255,.04)')}
              onMouseLeave={e => (e.currentTarget.style.background=i%2===0?'rgba(140,60,255,.015)':'transparent')}
              >
                {!isMobile && <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#445566', textAlign:'center' }}>{txPage*PER_PAGE+i+1}</span>}
                <div style={{ display:'flex', alignItems:'center', gap:5, minWidth:0 }}>
                  <span style={{ fontFamily:'monospace', fontSize:isMobile?9:11, color:'#c8dce8', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{isMobile ? short2(w.wallet) : `${w.wallet.slice(0,6)}…${w.wallet.slice(-6)}`}</span>
                  <button onClick={() => navigator.clipboard.writeText(w.wallet)} style={{ background:'none', border:'none', color:'#8ebbcc', cursor:'pointer', fontSize:10, padding:'0 2px', flexShrink:0, opacity:.7 }} title="Copy address">📋</button>
                  <a href={`https://explorer.mainnet.x1.xyz/address/${w.wallet}`} target="_blank" rel="noopener noreferrer" style={{ color:'#aa44ff', fontSize:10, textDecoration:'none', flexShrink:0, opacity:.7 }} title="Explorer">🔗</a>
                </div>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?9:11, color:'#ff9933', fontWeight:700, textShadow:'0 0 6px rgba(255,140,0,.2)' }}>🔥 {fmtN2(w.total,1)}</span>
                {!isMobile && <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#39ff88' }}>{fmtN2(Math.floor(w.total*1.888),0)} PTS</span>}
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#8ebbcc' }}>{w.txs}</span>
              </div>
            );
          } else {
            const tx = item as { amount:number; blockTime:number; sig:string; wallet:string };
            return (
              <div key={`${tx.sig}-${i}`} style={{
                display:'grid',
                gridTemplateColumns:isMobile?'1fr 80px 70px':'36px 1fr 130px 100px 120px',
                gap:8, padding:'7px 14px',
                background:i%2===0?'rgba(140,60,255,.015)':'transparent',
                alignItems:'center', transition:'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background='rgba(140,60,255,.04)')}
              onMouseLeave={e => (e.currentTarget.style.background=i%2===0?'rgba(140,60,255,.015)':'transparent')}
              >
                {!isMobile && <span style={{ fontFamily:'Orbitron, monospace', fontSize:9, color:'#445566', textAlign:'center' }}>{txPage*PER_PAGE+i+1}</span>}
                <div style={{ display:'flex', alignItems:'center', gap:5, minWidth:0 }}>
                  <span style={{ fontFamily:'monospace', fontSize:isMobile?8:10, color:'#aa88cc', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{tx.sig.slice(0,isMobile?6:10)}…{tx.sig.slice(-(isMobile?4:6))}</span>
                  <button onClick={() => navigator.clipboard.writeText(tx.sig)} style={{ background:'none', border:'none', color:'#8ebbcc', cursor:'pointer', fontSize:10, padding:'0 2px', flexShrink:0, opacity:.7 }} title="Copy sig">📋</button>
                  <a href={`https://explorer.mainnet.x1.xyz/tx/${tx.sig}`} target="_blank" rel="noopener noreferrer" style={{ color:'#aa44ff', fontSize:10, textDecoration:'none', flexShrink:0, opacity:.7 }} title="Explorer">🔗</a>
                </div>
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:isMobile?9:11, color:'#ff9933', fontWeight:700 }}>🔥 {fmtN2(tx.amount,2)}</span>
                {!isMobile && (
                  <div style={{ display:'flex', alignItems:'center', gap:4, minWidth:0 }}>
                    <span style={{ fontFamily:'monospace', fontSize:9, color:'#c8dce8' }}>{short2(tx.wallet)}</span>
                    <button onClick={() => navigator.clipboard.writeText(tx.wallet)} style={{ background:'none', border:'none', color:'#8ebbcc', cursor:'pointer', fontSize:9, padding:0, flexShrink:0, opacity:.6 }} title="Copy wallet">📋</button>
                  </div>
                )}
                <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#8ebbcc' }}>
                  {new Date(tx.blockTime*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'})} {new Date(tx.blockTime*1000).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}
                </span>
              </div>
            );
          }
        })}
      </div>

      {/* Pagination */}
      {(() => {
        const pages = Math.ceil(totalCount / PER_PAGE);
        if (pages <= 1) return null;
        return (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'12px 14px', borderTop:'1px solid rgba(140,60,255,.06)' }}>
            <button onClick={() => setTxPage(Math.max(0, txPage-1))} disabled={txPage===0} style={{
              background:'rgba(140,60,255,.06)', border:'1px solid rgba(140,60,255,.12)',
              color:txPage===0?'#334455':'#cc88ff', padding:'5px 14px',
              fontFamily:'Orbitron, monospace', fontSize:8, borderRadius:6,
              cursor:txPage===0?'default':'pointer', transition:'all .15s',
            }}>‹ PREV</button>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:8, color:'#8ebbcc', letterSpacing:1 }}>
              PAGE {txPage+1} / {pages}
            </span>
            <button onClick={() => setTxPage(Math.min(pages-1, txPage+1))} disabled={txPage>=pages-1} style={{
              background:'rgba(140,60,255,.06)', border:'1px solid rgba(140,60,255,.12)',
              color:txPage>=pages-1?'#334455':'#cc88ff', padding:'5px 14px',
              fontFamily:'Orbitron, monospace', fontSize:8, borderRadius:6,
              cursor:txPage>=pages-1?'default':'pointer', transition:'all .15s',
            }}>NEXT ›</button>
          </div>
        );
      })()}
    </div>
  );
};