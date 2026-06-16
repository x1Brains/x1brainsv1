// V2 Mint wrapper — visually striking hero + pulsing orb backdrop.
// V2MintInner stays intact; this wrapper just gives the page its look.
// (Burn lives on the Incinerator page — no mode toggle here.)

import { useEffect } from 'react';
import V2MintInner from './V2MintInner';

function injectMintStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2-mint-hero-styles')) return;
  const s = document.createElement('style');
  s.id = 'v2-mint-hero-styles';
  s.textContent = `
    /* ════════ Hero shell — V3 Glassmorphism ════════ */
    .v2mh {
      position: relative;
      background: var(--v2-glow), rgba(12, 18, 28, .6);
      backdrop-filter: blur(14px) saturate(1.2);
      -webkit-backdrop-filter: blur(14px) saturate(1.2);
      border: 1px solid rgba(242, 144, 48, .12);
      border-radius: 18px;
      padding: 22px 26px;
      overflow: hidden;
      margin-bottom: 14px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, .32);
    }
    .v2mh::before {
      /* Prismatic gradient hairline along the top — matches marketplace info-card */
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(242,144,48,.6), transparent);
      opacity: .8;
    }
    @keyframes v2mh-sweep {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .v2mh-orb {
      position: absolute; pointer-events: none;
      width: 280px; height: 280px; border-radius: 50%;
      filter: blur(40px); opacity: .35;
      animation: v2mh-orb 8s ease-in-out infinite;
    }
    .v2mh-orb.mint { right: -80px; top: -80px; background: radial-gradient(circle, #f29030 0%, transparent 70%); }
    .v2mh-orb.burn { right: -80px; top: -80px; background: radial-gradient(circle, #00c98d 0%, transparent 70%); }
    @keyframes v2mh-orb {
      0%,100% { transform: translate(0,0) scale(1); }
      50%     { transform: translate(-10px, 10px) scale(1.08); }
    }

    .v2mh-row {
      position: relative; z-index: 2;
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 20px; flex-wrap: wrap;
    }
    .v2mh-meta {
      font-family: 'Orbitron', monospace; font-size: 8px;
      letter-spacing: 3px; color: rgba(255,255,255,.55);
      margin-bottom: 6px;
    }
    .v2mh-title {
      font-family: 'Orbitron', monospace; font-size: 28px;
      font-weight: 900; letter-spacing: 1px; color: #fff;
      line-height: 1.05;
    }
    .v2mh-title .accent { color: #f29030; }
    .v2mh-title.burn .accent { color: #00c98d; }
    .v2mh-sub {
      font-family: 'Sora', sans-serif; font-size: 12px;
      color: rgba(255,255,255,.6); margin-top: 6px;
      max-width: 460px; line-height: 1.5;
    }

    /* ════════ Mode pill ════════ */
    /* Mode pill — frosted blur wrapper, V3 gradient on active */
    .v2mh-pill {
      position: relative; z-index: 2;
      display: inline-flex; align-items: stretch; gap: 6px;
      background: rgba(0, 0, 0, .30);
      backdrop-filter: blur(8px) saturate(1.2);
      -webkit-backdrop-filter: blur(8px) saturate(1.2);
      border: 1px solid rgba(255, 255, 255, .06);
      border-radius: 14px;
      padding: 5px;
    }
    .v2mh-pill button {
      font-family: 'Orbitron', monospace; font-size: 10px; font-weight: 800;
      letter-spacing: 2px; padding: 12px 22px;
      background: transparent; border: none; cursor: pointer;
      color: rgba(205, 216, 226, .65); border-radius: 10px;
      transition: background .18s, color .18s, box-shadow .18s;
      display: inline-flex; align-items: center; gap: 7px;
    }
    .v2mh-pill button:hover:not(.on) { color: rgba(230, 235, 242, .9); }
    .v2mh-pill button.on.mint {
      background: linear-gradient(135deg, #f29030, #ffb340);
      color: #0a0e14;
      box-shadow: 0 6px 22px rgba(242, 144, 48, .35);
    }
    .v2mh-pill button.on.burn {
      background: linear-gradient(135deg, #00c98d, #00e0a0);
      color: #0a0e14;
      box-shadow: 0 6px 22px rgba(0, 201, 141, .35);
    }

    /* ════════ Tiny stat tiles below hero ════════ */
    .v2mh-stats {
      position: relative; z-index: 2;
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
      margin-top: 18px;
    }
    @media (max-width: 720px) { .v2mh-stats { grid-template-columns: repeat(2, 1fr); } }
    .v2mh-stat {
      background: rgba(255, 255, 255, .04);
      border: 1px solid rgba(255, 255, 255, .07);
      border-radius: 12px;
      padding: 10px 12px;
      text-align: left;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .v2mh-stat-l {
      font-family: 'Orbitron', monospace; font-size: 7px;
      letter-spacing: 1.5px; color: rgba(255,255,255,.5);
    }
    .v2mh-stat-v {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 14px; font-weight: 800; margin-top: 2px;
    }
    .v2mh-stat-v.orange { color: #f29030; }
    .v2mh-stat-v.green  { color: #00c98d; }
    .v2mh-stat-v.white  { color: #fff; }
  `;
  document.head.appendChild(s);
}

export default function V2MintLabWork() {
  useEffect(() => { injectMintStyles(); }, []);

  return (
    <div className="content content-wide v2-glass">
      <div className="lw-stack">
        {/* ════════ HERO ════════ */}
        <div className="v2mh">
          <div className="v2mh-orb mint" />
          <div className="v2mh-row">
            <div>
              <div className="v2mh-meta">⌬ LABWORK · LB MINT</div>
              <div className="v2mh-title">
                Mint <span className="accent">LabWork</span> from BRAINS
              </div>
              <div className="v2mh-sub">
                Mint LabWork using BRAINS, XNT, or Xenblocks Ecosystem Assets (XNM · XUNI · XBLK). Each mint scores LB points by tier.
              </div>
            </div>
          </div>
        </div>

        {/* ════════ MINT BODY ════════ */}
        <div className="lf9-panel"><V2MintInner /></div>
      </div>
    </div>
  );
}
