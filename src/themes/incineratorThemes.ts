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
  // Deep dark charcoal — very dark, near-black
  pageBg:'linear-gradient(180deg,#050506 0%,#070708 40%,#050506 100%)',
  glow1:'radial-gradient(circle,rgba(255,34,34,.015) 0%,transparent 70%)',
  glow2:'radial-gradient(circle,rgba(255,102,0,.01) 0%,transparent 70%)',
  cardBg:'linear-gradient(135deg,rgba(7,7,9,.97),rgba(5,5,7,.97))',
  cardBorder:'rgba(255,34,34,.05)',
  cardGlow:'linear-gradient(90deg,transparent,rgba(255,34,34,.15),rgba(255,102,0,.08),transparent)',
  // True Red primary, Fire Orange secondary, Bright Gold accent
  primary:'#ff6600', primaryRgb:'255,102,0',
  secondary:'#ffbb33', secondaryRgb:'255,187,51',
  accent:'#ff2222', accentRgb:'255,34,34',
  // Brighter text — near-white
  textMuted:'#a89cb0', textDim:'#6a5e78',
  gradText:'linear-gradient(90deg,#ff2222,#ff6600,#ffbb33,#ffffff,#ffdd44)',
  // Reactor — subtle fire tones, lower opacity for darker feel
  ring1:'rgba(255,34,34,.10)', ring2:'rgba(255,102,0,.08)', ring3:'rgba(255,187,51,.07)',
  node1:'radial-gradient(circle,#ff4444,#ff2222)', node1G:'0 0 5px rgba(255,34,34,.6),0 0 12px rgba(255,34,34,.2)',
  node2:'radial-gradient(circle,#ff8833,#ff6600)', node2G:'0 0 4px rgba(255,102,0,.6),0 0 10px rgba(255,102,0,.18)',
  node3:'radial-gradient(circle,#ffcc44,#ffbb33)', node3G:'0 0 4px rgba(255,187,51,.6),0 0 10px rgba(255,187,51,.2)',
  coreBg:'radial-gradient(circle,rgba(255,34,34,.06) 0%,rgba(255,102,0,.025) 60%,transparent 100%)',
  coreBurn:'radial-gradient(circle,rgba(255,34,34,.28) 0%,rgba(200,0,0,.12) 60%,transparent 100%)',
  conic:'conic-gradient(from 0deg,#ff2222,#ff6600,#ffbb33,#ffdd44,#ff6600,#ff2222)',
  innerBg:'radial-gradient(circle,#080809 0%,#060607 100%)',
  // Buttons
  btnBg:'linear-gradient(135deg,#ff4400,#cc2200,#991100)', btnBorder:'rgba(255,34,34,.6)',
  btnOff:'linear-gradient(135deg,rgba(255,34,34,.15),rgba(150,30,0,.15))',
  inputBorder:'rgba(255,34,34,.2)', inputFocus:'rgba(255,34,34,.5)',
  warnBg:'rgba(255,34,34,.05)', warnBorder:'rgba(255,34,34,.15)', warnAccent:'#ff2222', warnText:'#ff6600',
  okColor:'#ffbb33', okRgb:'255,187,51', errColor:'#ff2222', errRgb:'255,34,34',
  statBorder:'rgba(255,34,34,.08)',
  qBg:'rgba(255,255,255,.03)', qBorder:'1px solid rgba(255,34,34,.12)', qColor:'#ff6600',
};

export const THEMES: Record<ThemeName, IncTheme> = { vegas: VEGAS, fire: FIRE };

export function loadTheme(): ThemeName {
  try { const s = localStorage.getItem('brains_theme') as ThemeName; if (s === 'vegas' || s === 'fire') return s; } catch {} return 'vegas';
}

// ═══════════════════════════════════════════════
// Module-level theme sync — all hooks share state
// ═══════════════════════════════════════════════
const _listeners = new Set<(t: ThemeName) => void>();
let _currentTheme: ThemeName = loadTheme();

function _setTheme(n: ThemeName) {
  _currentTheme = n;
  try { localStorage.setItem('brains_theme', n); } catch {}
  _listeners.forEach(fn => fn(n));
}

export function useIncTheme(): [IncTheme, ThemeName, () => void] {
  const [name, setName] = useState<ThemeName>(() => _currentTheme);
  React.useEffect(() => {
    // Sync on mount in case another component changed it
    if (_currentTheme !== name) setName(_currentTheme);
    const handler = (n: ThemeName) => setName(n);
    _listeners.add(handler);
    return () => { _listeners.delete(handler); };
  }, []);
  const toggle = useCallback(() => {
    const n = _currentTheme === 'vegas' ? 'fire' : 'vegas';
    _setTheme(n);
  }, []);
  return [THEMES[name] || VEGAS, name, toggle];
}

// ═══════════════════════════════════════════════
// THEME TOGGLE COMPONENT — used on every page
// ═══════════════════════════════════════════════
export const ThemeToggle: FC<{ themeName: ThemeName; onToggle: () => void; t: IncTheme; isMobile: boolean }> = ({ themeName, onToggle, t, isMobile }) => {
  const isF = themeName === 'fire';
  const sw = isMobile ? 32 : 34;
  const sh = isMobile ? 16 : 17;
  const kb = isMobile ? 12 : 13;
  return React.createElement('div', {
    style: {
      display:'inline-flex', alignItems:'center', gap:isMobile?6:8,
      background:'rgba(0,0,0,.3)', backdropFilter:'blur(8px)',
      border: isF ? '1px solid rgba(255,102,0,.12)' : '1px solid rgba(180,140,255,.1)',
      borderRadius:20, padding:isMobile?'4px 8px':'4px 10px',
      marginBottom:10, transition:'border-color .3s',
    }
  },
    React.createElement('span',{style:{fontSize:isMobile?8:9,opacity:!isF?1:.35,transition:'opacity .3s',cursor:'default'}},'🎰'),
    React.createElement('button',{onClick:onToggle,'aria-label':'Toggle theme',style:{
      position:'relative',width:sw,height:sh,borderRadius:sh/2,border:'none',cursor:'pointer',outline:'none',flexShrink:0,
      background:isF?'rgba(255,68,0,.12)':'rgba(160,120,255,.12)',
      transition:'background .3s',overflow:'hidden',
    }as React.CSSProperties},
      React.createElement('span',{style:{
        position:'absolute',top:(sh-kb)/2,left:isF?sw-kb-(sh-kb)/2:(sh-kb)/2,
        width:kb,height:kb,borderRadius:'50%',
        background:isF?'#ff5500':'#bb77ee',
        boxShadow:isF?'0 0 5px rgba(255,85,0,.6)':'0 0 5px rgba(187,119,238,.6)',
        transition:'left .25s cubic-bezier(.4,0,.2,1),background .25s,box-shadow .25s',
      }})
    ),
    React.createElement('span',{style:{fontSize:isMobile?8:9,opacity:isF?1:.35,transition:'opacity .3s',cursor:'default'}},'🔥'),
    React.createElement('span',{style:{
      fontFamily:'Orbitron,monospace',fontSize:isMobile?6:7,fontWeight:700,letterSpacing:1,
      color:isF?'#ff6600':'#bb88ee',marginLeft:isMobile?2:4,transition:'color .3s',
    }},isF?'FIRE':'VEGAS')
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