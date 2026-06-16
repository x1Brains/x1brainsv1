// Twin reactor cores — each channel uses a holographic concentric-rings HUD
// (variant 03 from the picker, embedded in variant 01's layout).
//
// Animation:
//   • Outer dashed ring slowly rotates
//   • Filled arc (conic burn %) has a soft pulse on its drop-shadow
//   • Center disc fade-shifts the warm gradient
//
// Same prop shape V2Incinerator already passes in.

import { FC, useEffect, useRef, useState } from 'react';
import { fmtUSD } from '../utils/v2format';

const BRAINS_INITIAL = 8_880_000;
const LB_INITIAL     = 100_000;

const ACCENT = '#ff8c00';
const TEXT   = 'var(--text-primary)';
const MUTED  = 'var(--text-muted)';
const DIM    = 'var(--text-faint)';

const mono = {
  fontFamily: 'Orbitron, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2-bd-styles')) return;
  const s = document.createElement('style');
  s.id = 'v2-bd-styles';
  s.textContent = `
    @keyframes v2bd-spin-slow {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    @keyframes v2bd-spin-rev {
      from { transform: rotate(360deg); }
      to   { transform: rotate(0deg); }
    }
    @keyframes v2bd-arc-pulse {
      0%, 100% { filter: drop-shadow(0 0 6px ${ACCENT}66); }
      50%      { filter: drop-shadow(0 0 18px ${ACCENT}cc); }
    }
    @keyframes v2bd-core-drift {
      0%, 100% { background-position: 0% 50%; }
      50%      { background-position: 100% 50%; }
    }
    @keyframes v2bd-tick {
      0%, 100% { opacity: 1; }
      50%      { opacity: .35; }
    }
    .v2bd-mono {
      font-family: 'Orbitron', monospace;
      font-variant-numeric: tabular-nums lining-nums;
    }
    .v2bd-channel {
      position: relative;
      background: linear-gradient(155deg, rgba(255,140,0,.06), rgba(255,140,0,.01));
      border: 1px solid rgba(255,140,0,0.22);
      border-radius: 12px;
      padding: 13px 12px 12px;
      overflow: hidden;
    }
    .v2bd-channel::before {
      content: '';
      position: absolute; top: 0; left: 12%; right: 12%; height: 1px;
      background: linear-gradient(90deg, transparent, ${ACCENT}, transparent);
    }
    .v2bd-channels {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    @media (max-width: 720px) {
      .v2bd-channels { grid-template-columns: 1fr; }
    }

    /* ── Holographic concentric-rings HUD ── */
    .v2bd-hud {
      position: relative;
      width: 165px;
      height: 165px;
      margin: 0 auto 10px;
    }
    @media (max-width: 540px) {
      .v2bd-hud { width: 135px; height: 135px; }
    }
    .v2bd-ring {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 1px solid rgba(255,140,0,.18);
    }
    .v2bd-ring.r2 {
      inset: 11px;
      border-color: rgba(255,140,0,.3);
    }
    .v2bd-ring.r3 {
      inset: 21px;
      border-color: rgba(255,140,0,.42);
      border-style: dashed;
      animation: v2bd-spin-slow 80s linear infinite;
    }
    .v2bd-ring.r4 {
      inset: 5px;
      border: 1px dashed rgba(255,140,0,.15);
      animation: v2bd-spin-rev 120s linear infinite;
    }
    /* Tick marks layer — sits between r2 and r3 */
    .v2bd-ticks {
      position: absolute;
      inset: 16px;
      border-radius: 50%;
      background:
        repeating-conic-gradient(
          from 0deg,
          rgba(255,140,0,.32) 0deg,
          rgba(255,140,0,.32) 0.6deg,
          transparent 0.6deg,
          transparent 30deg
        );
      -webkit-mask: radial-gradient(circle, transparent 78%, black 79%, black 100%);
              mask: radial-gradient(circle, transparent 78%, black 79%, black 100%);
      animation: v2bd-tick 4s ease-in-out infinite;
    }
    /* Filled arc — shows the burn % */
    .v2bd-arc {
      position: absolute;
      inset: 5px;
      border-radius: 50%;
      background: conic-gradient(
        ${ACCENT} 0%,
        ${ACCENT} calc(var(--p, 0) * 1%),
        transparent calc(var(--p, 0) * 1%),
        transparent 100%
      );
      -webkit-mask: radial-gradient(circle, transparent 52%, black 53%, black 58%, transparent 59%);
              mask: radial-gradient(circle, transparent 52%, black 53%, black 58%, transparent 59%);
      animation: v2bd-arc-pulse 3s ease-in-out infinite;
      transition: background 1.2s cubic-bezier(.16,1,.3,1);
    }
    /* Center disc */
    .v2bd-core {
      position: absolute;
      inset: 38px;
      border-radius: 50%;
      background:
        radial-gradient(circle at 30% 30%, rgba(255,140,0,.18), transparent 60%),
        linear-gradient(135deg, rgba(255,140,0,.14), rgba(0,0,0,.42));
      background-size: 200% 200%;
      animation: v2bd-core-drift 8s ease-in-out infinite;
      border: 1px solid rgba(255,140,0,.5);
      box-shadow:
        0 0 24px rgba(255,140,0,.18),
        inset 0 0 18px rgba(255,140,0,.12);
      display: grid;
      place-items: center;
      text-align: center;
    }
    @media (max-width: 540px) {
      .v2bd-core { inset: 27px; }
    }
    .v2bd-core .label {
      font-family: 'Orbitron', monospace;
      font-size: 6px;
      letter-spacing: 2px;
      color: ${MUTED};
      font-weight: 700;
      margin-bottom: 2px;
    }
    .v2bd-core .pct {
      font-family: 'Orbitron', monospace;
      font-variant-numeric: tabular-nums lining-nums;
      font-size: 16px;
      font-weight: 900;
      color: ${ACCENT};
      letter-spacing: 0.5px;
      line-height: 1;
    }
    @media (max-width: 540px) {
      .v2bd-core .pct { font-size: 14px; }
    }
    .v2bd-core .big {
      font-family: 'Orbitron', monospace;
      font-variant-numeric: tabular-nums lining-nums;
      font-size: 10px;
      font-weight: 700;
      color: ${TEXT};
      letter-spacing: 0.5px;
      margin-top: 4px;
    }
    @media (max-width: 540px) {
      .v2bd-core .big { font-size: 8px; }
    }
    /* 4 cardinal tick blips for sci-fi flavor */
    .v2bd-blip {
      position: absolute;
      width: 3px; height: 3px;
      background: ${ACCENT};
      border-radius: 50%;
      box-shadow: 0 0 6px ${ACCENT};
      animation: v2bd-tick 1.8s ease-in-out infinite;
    }
    .v2bd-blip.n { top: 2px; left: 50%; transform: translateX(-50%); }
    .v2bd-blip.s { bottom: 2px; left: 50%; transform: translateX(-50%); animation-delay: 0.45s; }
    .v2bd-blip.e { top: 50%; right: 2px; transform: translateY(-50%); animation-delay: 0.9s; }
    .v2bd-blip.w { top: 50%; left: 2px; transform: translateY(-50%); animation-delay: 1.35s; }
  `;
  document.head.appendChild(s);
}

// Smooth animated counter — no flash, no glow
const Counter: FC<{ value: number | null; decimals?: number; duration?: number }> = ({
  value, decimals = 0, duration = 800,
}) => {
  const [display, setDisplay] = useState(value ?? 0);
  const prev = useRef(value ?? 0);
  const raf  = useRef<number>(0);
  useEffect(() => {
    if (value == null) return;
    const from = prev.current, to = value;
    if (from === to) return;
    let start: number | null = null;
    cancelAnimationFrame(raf.current);
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * e;
      setDisplay(decimals > 0 ? parseFloat(v.toFixed(decimals)) : Math.floor(v));
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, decimals, duration]);
  if (value == null) return <>—</>;
  return <>{display.toLocaleString(undefined, { maximumFractionDigits: decimals })}</>;
};

type ChannelProps = {
  symbol: string;
  burned: number | null;
  supply: number | null;
  initial: number;
  price: number;
  scanMsg?: string;
};

const Channel: FC<ChannelProps> = ({ symbol, burned, supply, initial, price, scanMsg }) => {
  const live = burned != null && supply != null;
  const burnPct = live ? Math.min(100, (burned / initial) * 100) : 0;
  const usd = burned != null ? burned * price : 0;
  const supplyLeft = supply != null ? supply : initial;

  // Compact display values that look right inside a tight ring core
  const fmtBig = (n: number | null): string => {
    if (n == null) return '——';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  };

  return (
    <div className="v2bd-channel">
      {/* Status row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
        <span className="v2bd-mono" style={{
          fontSize: 8, fontWeight: 800, color: TEXT, letterSpacing: 2,
        }}>
          {symbol}
        </span>
        <span className="v2bd-mono" style={{
          fontSize: 6, color: live ? ACCENT : MUTED, letterSpacing: 1.2, fontWeight: 700,
        }}>
          {live ? '● LIVE' : '○ —'}
        </span>
      </div>

      {/* Holographic concentric rings HUD */}
      <div className="v2bd-hud">
        <div className="v2bd-ring" />
        <div className="v2bd-ring r2" />
        <div className="v2bd-ring r3" />
        <div className="v2bd-ring r4" />
        <div className="v2bd-ticks" />
        <div className="v2bd-arc" style={{ ['--p' as any]: burnPct }} />
        <div className="v2bd-blip n" />
        <div className="v2bd-blip e" />
        <div className="v2bd-blip s" />
        <div className="v2bd-blip w" />
        <div className="v2bd-core">
          <div>
            <div className="label">{symbol} BURNED</div>
            <div className="pct">{live ? `${burnPct.toFixed(2)}%` : '—'}</div>
            <div className="big">{fmtBig(burned)}</div>
          </div>
        </div>
      </div>

      {/* Meta strip under the HUD */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 5,
        marginTop: 3,
      }}>
        <div style={{
          padding: '6px 8px',
          background: 'rgba(138,154,184,.04)',
          border: '1px solid rgba(138,154,184,.12)',
          borderRadius: 7,
          textAlign: 'center',
        }}>
          <div style={{ ...mono, fontSize: 5.5, color: DIM, letterSpacing: 1.2, fontWeight: 700, marginBottom: 2 }}>USD</div>
          <div style={{ ...mono, fontSize: 8.5, color: TEXT, fontWeight: 800 }}>
            {price > 0 && burned ? fmtUSD(usd) : '—'}
          </div>
        </div>
        <div style={{
          padding: '6px 8px',
          background: 'rgba(138,154,184,.04)',
          border: '1px solid rgba(138,154,184,.12)',
          borderRadius: 7,
          textAlign: 'center',
        }}>
          <div style={{ ...mono, fontSize: 5.5, color: DIM, letterSpacing: 1.2, fontWeight: 700, marginBottom: 2 }}>SUPPLY</div>
          <div style={{ ...mono, fontSize: 8.5, color: TEXT, fontWeight: 800 }}>
            <Counter value={supplyLeft} />
          </div>
        </div>
        <div style={{
          padding: '6px 8px',
          background: 'rgba(138,154,184,.04)',
          border: '1px solid rgba(138,154,184,.12)',
          borderRadius: 7,
          textAlign: 'center',
        }}>
          <div style={{ ...mono, fontSize: 5.5, color: DIM, letterSpacing: 1.2, fontWeight: 700, marginBottom: 2 }}>INITIAL</div>
          <div style={{ ...mono, fontSize: 8.5, color: TEXT, fontWeight: 800 }}>
            {initial.toLocaleString()}
          </div>
        </div>
      </div>

      {scanMsg && (
        <div className="v2bd-mono" style={{
          marginTop: 8, padding: '5px 8px',
          fontSize: 6, color: MUTED, letterSpacing: 1,
          background: 'rgba(138,154,184,.04)',
          border: '1px solid rgba(138,154,184,.12)',
          borderRadius: 5,
          textAlign: 'center',
        }}>
          {scanMsg}
        </div>
      )}
    </div>
  );
};

type Props = {
  brainsBurned: number | null;
  brainsSupply: number | null;
  brainsPrice: number;
  lbBurned: number | null;
  lbSupply: number | null;
  lbPrice: number;
  lbScanMsg?: string;
};

export default function V2BurnDashboard(props: Props) {
  useEffect(() => { injectStyles(); }, []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ts = new Date(now).toISOString().slice(11, 19);

  return (
    <div className="info-card">
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <div className="title" style={{ margin: 0 }}>Burn Dashboard · Twin Reactors</div>
        <span className="v2bd-mono" style={{
          fontSize: 9, color: MUTED, letterSpacing: 1.5,
        }}>
          X1 MAINNET · {ts} UTC
        </span>
      </div>
      <div className="v2bd-channels">
        <Channel
          symbol="BRAINS"
          burned={props.brainsBurned}
          supply={props.brainsSupply}
          initial={BRAINS_INITIAL}
          price={props.brainsPrice}
        />
        <Channel
          symbol="LB"
          burned={props.lbBurned}
          supply={props.lbSupply}
          initial={LB_INITIAL}
          price={props.lbPrice}
          scanMsg={props.lbScanMsg}
        />
      </div>
    </div>
  );
}
