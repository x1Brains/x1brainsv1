// src/themes/incineratorThemes.ts
// ═══════════════════════════════════════════════════════════════════════
// Shared theme system for Incinerator Protocol pages
// Used by: IncineratorEngine.tsx, BurnLeaderboard.tsx, BurnHistory.tsx
// ═══════════════════════════════════════════════════════════════════════

import React, { FC, useCallback, useState } from 'react';

export type ThemeName = 'vegas' | 'fire';

export interface IncTheme {
  name: ThemeName; label: string; icon: string;
  // page
  pageBg: string; glow1: string; glow2: string;
  // cards
  cardBg: string; cardBorder: string; cardGlow: string;
  // palette
  primary: string; primaryRgb: string;
  secondary: string; secondaryRgb: string;
  accent: string; accentRgb: string;
  // text
  textMuted: string; textDim: string;
  // gradient text
  gradText: string;
  // reactor
  ring1: string; ring2: string; ring3: string;
  node1: string; node1G: string; node2: string; node2G: string; node3: string; node3G: string;
  coreBg: string; coreBurn: string; conic: string; innerBg: string;
  // buttons
  btnBg: string; btnBorder: string; btnOff: string;
  inputBorder: string; inputFocus: string;
  // alerts
  warnBg: string; warnBorder: string; warnAccent: string; warnText: string;
  okColor: string; okRgb: string; errColor: string; errRgb: string;
  // misc
  statBorder: string; qBg: string; qBorder: string; qColor: string;
}

// ═══════════════════════════════════════════════
// VEGAS — Original BurnLeaderboard palette
// Purple #cc88ff / Orange #ff9933 / Green #39ff88
// ═══════════════════════════════════════════════
export const VEGAS: IncTheme = {
  name:'vegas', label:'VEGAS', icon:'🎰',
  pageBg:'linear-gradient(180deg,#04060e 0%,#0c0618 40%,#080412 100%)',
  glow1:'radial-gradient(circle,rgba(204,136,255,.06) 0%,transparent 70%)',
  glow2:'radial-gradient(circle,rgba(57,255,136,.04) 0%,transparent 70%)',
  cardBg:'linear-gradient(135deg,rgba(12,6,24,.95),rgba(4,6,14,.95))',
  cardBorder:'rgba(204,136,255,.15)',
  cardGlow:'linear-gradient(90deg,transparent,rgba(204,136,255,.5),transparent)',
  primary:'#cc88ff', primaryRgb:'204,136,255',
  secondary:'#ff9933', secondaryRgb:'255,153,51',
  accent:'#39ff88', accentRgb:'57,255,136',
  textMuted:'#8ebbcc', textDim:'#5a7a8a',
  gradText:'linear-gradient(90deg,#ff9933,#ee55ff,#39ff88)',
  ring1:'rgba(255,153,51,.18)', ring2:'rgba(204,136,255,.15)', ring3:'rgba(57,255,136,.12)',
  node1:'radial-gradient(circle,#ffbb55,#ff9933)', node1G:'0 0 8px rgba(255,153,51,.9),0 0 20px rgba(255,102,0,.3)',
  node2:'radial-gradient(circle,#dd99ff,#cc88ff)', node2G:'0 0 6px rgba(204,136,255,.9),0 0 16px rgba(170,68,255,.3)',
  node3:'radial-gradient(circle,#66ffaa,#39ff88)', node3G:'0 0 6px rgba(57,255,136,.9),0 0 14px rgba(57,255,136,.3)',
  coreBg:'radial-gradient(circle,rgba(204,136,255,.15) 0%,rgba(255,153,51,.08) 60%,transparent 100%)',
  coreBurn:'radial-gradient(circle,rgba(255,80,0,.35) 0%,rgba(255,40,0,.15) 60%,transparent 100%)',
  conic:'conic-gradient(from 0deg,#ff9933,#ee55ff,#39ff88,#ff9933)',
  innerBg:'radial-gradient(circle,#0e0a1a 0%,#08060e 100%)',
  btnBg:'linear-gradient(135deg,#cc88ff,#aa44ff,#8822cc)', btnBorder:'rgba(204,136,255,.7)',
  btnOff:'linear-gradient(135deg,rgba(204,136,255,.2),rgba(100,40,180,.2))',
  inputBorder:'rgba(204,136,255,.3)', inputFocus:'rgba(204,136,255,.7)',
  warnBg:'rgba(255,153,51,.08)', warnBorder:'rgba(255,153,51,.25)', warnAccent:'#ff9933', warnText:'#ff9933',
  okColor:'#39ff88', okRgb:'57,255,136', errColor:'#ff4444', errRgb:'255,68,68',
  statBorder:'rgba(204,136,255,.12)',
  qBg:'rgba(255,255,255,.04)', qBorder:'1px solid rgba(204,136,255,.15)', qColor:'#cc88ff',
};

// ═══════════════════════════════════════════════
// FIRE — Inferno / molten / ember palette
// Deep reds, fire oranges, molten yellows
// ═══════════════════════════════════════════════
export const FIRE: IncTheme = {
  name:'fire', label:'FIRE', icon:'🔥',
  // Dark navy/charcoal base — same darkness as BurnPortal, NOT brown
  pageBg:'linear-gradient(180deg,#060608 0%,#0a0810 40%,#08060c 100%)',
  glow1:'radial-gradient(circle,rgba(255,80,0,.06) 0%,transparent 70%)',
  glow2:'radial-gradient(circle,rgba(255,140,0,.04) 0%,transparent 70%)',
  cardBg:'linear-gradient(135deg,rgba(10,8,16,.95),rgba(6,4,10,.95))',
  cardBorder:'rgba(255,100,20,.15)',
  cardGlow:'linear-gradient(90deg,transparent,rgba(255,100,20,.5),rgba(255,140,0,.3),transparent)',
  // Fire Orange primary, Gold secondary, Red accent
  primary:'#ff6600', primaryRgb:'255,102,0',
  secondary:'#ffaa00', secondaryRgb:'255,170,0',
  accent:'#ff3300', accentRgb:'255,51,0',
  // Muted text stays cool/neutral, not warm
  textMuted:'#9aabb8', textDim:'#5a6a7a',
  gradText:'linear-gradient(90deg,#ff3300,#ff6600,#ffaa00)',
  // Reactor — fire tones on dark
  ring1:'rgba(255,102,0,.2)', ring2:'rgba(255,170,0,.16)', ring3:'rgba(255,51,0,.14)',
  node1:'radial-gradient(circle,#ff8833,#ff6600)', node1G:'0 0 8px rgba(255,102,0,.9),0 0 20px rgba(255,60,0,.4)',
  node2:'radial-gradient(circle,#ffcc33,#ffaa00)', node2G:'0 0 6px rgba(255,170,0,.9),0 0 16px rgba(255,130,0,.3)',
  node3:'radial-gradient(circle,#ff5533,#ff3300)', node3G:'0 0 6px rgba(255,51,0,.9),0 0 14px rgba(200,0,0,.4)',
  coreBg:'radial-gradient(circle,rgba(255,102,0,.15) 0%,rgba(255,51,0,.06) 60%,transparent 100%)',
  coreBurn:'radial-gradient(circle,rgba(255,51,0,.4) 0%,rgba(200,0,0,.18) 60%,transparent 100%)',
  conic:'conic-gradient(from 0deg,#ff3300,#ff6600,#ffaa00,#ff6600,#ff3300)',
  innerBg:'radial-gradient(circle,#0c0a14 0%,#08060c 100%)',
  // Buttons
  btnBg:'linear-gradient(135deg,#ff5500,#cc2200,#991100)', btnBorder:'rgba(255,85,0,.7)',
  btnOff:'linear-gradient(135deg,rgba(255,85,0,.2),rgba(150,30,0,.2))',
  inputBorder:'rgba(255,102,0,.25)', inputFocus:'rgba(255,102,0,.6)',
  warnBg:'rgba(255,51,0,.06)', warnBorder:'rgba(255,51,0,.2)', warnAccent:'#ff3300', warnText:'#ff6600',
  okColor:'#ffaa00', okRgb:'255,170,0', errColor:'#ff2222', errRgb:'255,34,34',
  statBorder:'rgba(255,102,0,.1)',
  qBg:'rgba(255,255,255,.04)', qBorder:'1px solid rgba(255,170,0,.15)', qColor:'#ffaa00',
};

export const THEMES: Record<ThemeName, IncTheme> = { vegas: VEGAS, fire: FIRE };

export function loadTheme(): ThemeName {
  try { const s = localStorage.getItem('brains_theme') as ThemeName; if (s === 'vegas' || s === 'fire') return s; } catch {} return 'vegas';
}
export function saveTheme(n: ThemeName) { try { localStorage.setItem('brains_theme', n); } catch {} }

// ═══════════════════════════════════════════════
// useTheme hook — share across all pages
// ═══════════════════════════════════════════════
export function useIncTheme(): [IncTheme, ThemeName, () => void] {
  const [name, setName] = useState<ThemeName>(loadTheme);
  const toggle = useCallback(() => {
    setName(p => { const n = p === 'vegas' ? 'fire' : 'vegas'; saveTheme(n); return n; });
  }, []);
  return [THEMES[name] || VEGAS, name, toggle];
}

// ═══════════════════════════════════════════════
// THEME TOGGLE COMPONENT — used on every page
// ═══════════════════════════════════════════════
export const ThemeToggle: FC<{ themeName: ThemeName; onToggle: () => void; t: IncTheme; isMobile: boolean }> = ({ themeName, onToggle, t, isMobile }) => {
  const isF = themeName === 'fire';
  return React.createElement('div', {
    style: {
      display:'flex', alignItems:'center', gap: isMobile ? 8 : 12,
      background: t.cardBg, border: `1px solid ${t.cardBorder}`,
      borderRadius: 14, padding: isMobile ? '8px 10px' : '10px 16px',
      marginBottom: 16, transition: 'all .4s',
    }
  },
    // Vegas label
    React.createElement('div', {
      style: { fontFamily:'Orbitron,monospace', fontSize: isMobile?9:10, fontWeight:700, letterSpacing:1.5,
        color: !isF ? '#cc88ff' : t.textDim, transition:'color .3s', display:'flex', alignItems:'center', gap:4 }
    }, '🎰', !isMobile && React.createElement('span', null, 'VEGAS')),

    // Toggle switch
    React.createElement('button', {
      onClick: onToggle,
      style: {
        position:'relative', width:56, height:28, borderRadius:14, border:'none', cursor:'pointer', outline:'none', flexShrink:0,
        background: isF ? 'linear-gradient(135deg,#ff4400,#ff6600)' : 'linear-gradient(135deg,#cc88ff,#aa44ff)',
        boxShadow: isF ? '0 0 16px rgba(255,68,0,.5)' : '0 0 16px rgba(204,136,255,.5)',
        transition: 'all .3s', overflow:'hidden',
      }
    },
      // Knob
      React.createElement('span', {
        style: {
          position:'absolute', top:3, left: isF ? 31 : 3,
          width:22, height:22, borderRadius:'50%', background:'#fff',
          boxShadow: isF ? '0 0 8px rgba(255,68,0,.6)' : '0 0 8px rgba(204,136,255,.6)',
          transition: 'left .3s,box-shadow .3s',
          display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, zIndex:1,
        }
      }, isF ? '🔥' : '🎰')
    ),

    // Fire label
    React.createElement('div', {
      style: { fontFamily:'Orbitron,monospace', fontSize: isMobile?9:10, fontWeight:700, letterSpacing:1.5,
        color: isF ? '#ff6600' : t.textDim, transition:'color .3s', display:'flex', alignItems:'center', gap:4 }
    }, '🔥', !isMobile && React.createElement('span', null, 'FIRE')),

    // Badge
    React.createElement('div', {
      style: {
        marginLeft:'auto', fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, letterSpacing:1.5,
        padding:'3px 10px', borderRadius:6, transition:'all .3s',
        color: isF ? '#ff6600' : '#cc88ff',
        background: isF ? 'rgba(255,102,0,.1)' : 'rgba(204,136,255,.1)',
        border: `1px solid ${isF ? 'rgba(255,102,0,.25)' : 'rgba(204,136,255,.25)'}`,
      }
    }, isF ? '🔥 FIRE EDITION' : '🎰 VEGAS MODE')
  );
};

// ═══════════════════════════════════════════════
// CSS VARIABLE INJECTOR for BurnLeaderboard
// Injects CSS custom properties that override hardcoded colors
// Call this whenever theme changes — applies via .burn-theme-fire class
// ═══════════════════════════════════════════════
export function injectThemeOverrides() {
  if (typeof document === 'undefined') return;
  const id = 'brains-theme-overrides';
  if (document.getElementById(id)) return;
  const s = document.createElement('style');
  s.id = id;
  s.textContent = `
    /* ═══ FIRE THEME OVERRIDES ═══ */
    /* Applied when .burn-theme-fire is on the page wrapper */

    .burn-theme-fire {
      /* Page background */
      background: linear-gradient(180deg,#0a0604 0%,#120804 40%,#0e0602 100%) !important;
    }

    /* Override purple (#cc88ff) → fire orange (#ff6600) */
    .burn-theme-fire [style*="color: rgb(204, 136, 255)"],
    .burn-theme-fire [style*="color:#cc88ff"] {
      color: #ff6600 !important;
    }

    /* Override neon green (#39ff88) → molten yellow (#ffbb00) for success/accent */
    /* Note: We keep green for USD values — only change structural accents */

    /* Override card backgrounds */
    .burn-theme-fire .lb-card-override {
      background: linear-gradient(135deg,rgba(24,10,4,.95),rgba(14,6,2,.95)) !important;
      border-color: rgba(255,100,20,.18) !important;
    }

    /* Override gradient text */
    .burn-theme-fire .lb-grad-text {
      background: linear-gradient(90deg,#ff2200,#ff6600,#ffcc00) !important;
    }
  `;
  document.head.appendChild(s);
}