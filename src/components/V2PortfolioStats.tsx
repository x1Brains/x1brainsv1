// Hero net-worth + ring-gauge tile combo — mirrors V2MarketplaceStats so
// portfolio + marketplace share the same top-of-page visual grammar.
//
// Hero shows net worth with 24h delta + meta strip. Right side has 6
// neutral gray ring tiles with orange conic fills (positions, LB pts, etc.).

import { FC } from 'react';
import { fmtUSD, fmtNum, shortAddr } from '../utils/v2format';

const ACCENT  = '#f29030';
const TEXT    = 'var(--text-primary)';
const MUTED   = 'var(--text-muted)';
const DIM     = 'var(--text-faint)';
const GREEN   = 'var(--neon-green, #00c98d)';
const RED     = 'var(--neon-red, #ff4444)';

const mono = {
  fontFamily: 'Orbitron, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2-pf-stats-styles')) return;
  const s = document.createElement('style');
  s.id = 'v2-pf-stats-styles';
  s.textContent = `
    .v2pf-grid {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 1.6fr;
      gap: 14px;
    }
    @media (max-width: 720px) {
      .v2pf-grid { grid-template-columns: 1fr; }
    }
    .v2pf-rings {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    @media (max-width: 540px) {
      .v2pf-rings { grid-template-columns: repeat(2, 1fr); }
    }
    .v2pf-ring {
      --size: 44px;
      width: var(--size); height: var(--size);
      border-radius: 50%;
      background: conic-gradient(
        ${ACCENT} calc(var(--p, 0) * 1%),
        rgba(138, 154, 184, .12) 0
      );
      display: grid;
      place-items: center;
      flex-shrink: 0;
      transition: background 1s cubic-bezier(.16,1,.3,1);
    }
    .v2pf-ring::before {
      content: '';
      width: calc(var(--size) - 6px);
      height: calc(var(--size) - 6px);
      background: #0c121c;
      border-radius: 50%;
      grid-column: 1; grid-row: 1;
    }
    .v2pf-ring .pct {
      grid-column: 1; grid-row: 1;
      z-index: 1;
      font-family: 'Orbitron', monospace;
      font-variant-numeric: tabular-nums;
      font-size: 9px;
      font-weight: 800;
      color: ${ACCENT};
      letter-spacing: 0.5px;
    }
  `;
  document.head.appendChild(s);
}

type RingTileProps = {
  label: string;
  value: string | number;
  pct?:  number;
  ringText?: string;
};

const RingTile: FC<RingTileProps> = ({ label, value, pct, ringText }) => {
  const clamped = Math.max(0, Math.min(100, pct ?? 0));
  const inside = ringText ?? (pct != null ? `${Math.round(clamped)}%` : '◆');
  return (
    <div style={{
      background: 'rgba(138, 154, 184, 0.04)',
      border: '1px solid rgba(138, 154, 184, 0.12)',
      borderRadius: 9,
      padding: '12px 12px',
      display: 'grid',
      gridTemplateColumns: 'auto 1fr',
      gap: 12,
      alignItems: 'center',
      minWidth: 0,
    }}>
      <div className="v2pf-ring" style={{ ['--p' as any]: clamped }}>
        <span className="pct">{inside}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          ...mono,
          fontSize: 8,
          letterSpacing: 1.8,
          fontWeight: 700,
          color: DIM,
          marginBottom: 3,
          textTransform: 'uppercase',
        }}>{label}</div>
        <div style={{
          ...mono,
          fontSize: 15,
          fontWeight: 800,
          color: TEXT,
          letterSpacing: 0.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{value}</div>
      </div>
    </div>
  );
};

type Props = {
  wallet?:       string;
  netWorth:      number;
  deltaUsd?:     number;   // 24h delta (or vs last snapshot)
  deltaPct?:     number;
  xntBalance:    number;
  xntPrice:      number;
  splCount:      number;
  t22Count:      number;
  lpCount:       number;
  otherCount:    number;
  nftCount?:     number;
  positions:     number;
  connected:     boolean;
};

export default function PortfolioStats(props: Props) {
  if (typeof document !== 'undefined') injectStyles();

  const {
    wallet, netWorth, deltaUsd, deltaPct,
    xntBalance, xntPrice,
    splCount, t22Count, lpCount, otherCount, nftCount = 0, positions,
    connected,
  } = props;

  const pctOf = (n: number, denom: number) =>
    denom > 0 ? Math.max(0, Math.min(100, (n / denom) * 100)) : 0;

  // Ring fills — share-of-positions where it makes sense.
  const splPct   = pctOf(splCount, positions);
  const t22Pct   = pctOf(t22Count, positions);
  const lpPct    = pctOf(lpCount, positions);
  const otherPct = pctOf(otherCount, positions);
  const nftPct   = pctOf(nftCount,   positions);
  // Positions: visual fill capped at 20 holdings
  const posPct   = Math.min(100, positions * 5);
  // 24h delta — magnitude based, capped at 25%
  const dPct     = deltaPct != null ? Math.min(100, Math.abs(deltaPct) * 4) : 0;

  const up = (deltaUsd ?? 0) >= 0;
  const deltaColor = up ? GREEN : RED;
  const deltaArrow = up ? '▲' : '▼';

  return (
    <div className="info-card">
      <div className="v2pf-grid">
        {/* ── HERO ── */}
        <div style={{
          position: 'relative',
          background: 'linear-gradient(155deg, rgba(242,144,48,.12), rgba(242,144,48,.02))',
          border: '1px solid rgba(242,144,48,0.3)',
          borderRadius: 12,
          padding: '20px 22px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 16,
        }}>
          <div>
            <div style={{
              ...mono,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 3,
              color: ACCENT,
              marginBottom: 8,
            }}>
              NET WORTH
            </div>
            <div style={{
              ...mono,
              fontSize: 44,
              fontWeight: 900,
              lineHeight: 1,
              color: ACCENT,
              letterSpacing: 1,
            }}>
              {connected && netWorth > 0 ? fmtUSD(netWorth) : '$——'}
            </div>
            {connected && deltaUsd != null && deltaPct != null && (
              <div style={{
                ...mono,
                marginTop: 6,
                fontSize: 12,
                fontWeight: 800,
                color: deltaColor,
                letterSpacing: 0.5,
              }}>
                {deltaArrow} {fmtUSD(Math.abs(deltaUsd))} ({deltaPct.toFixed(2)}%)
                <span style={{ color: MUTED, fontWeight: 500, marginLeft: 6 }}>vs last snap</span>
              </div>
            )}
            <div style={{
              ...mono,
              fontSize: 10,
              color: MUTED,
              letterSpacing: 1.2,
              marginTop: 8,
            }}>
              {connected && wallet ? shortAddr(wallet, 6, 6) : 'Wallet not connected'}
              {connected && <> · <span style={{ color: TEXT, fontWeight: 700 }}>{positions}</span> positions</>}
            </div>
          </div>

          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            ...mono,
            fontSize: 9,
            color: MUTED,
            letterSpacing: 1.5,
          }}>
            <span>XNT <b style={{ color: ACCENT, fontWeight: 700 }}>{fmtNum(xntBalance, 4)}</b></span>
            <span>XNT USD <b style={{ color: TEXT, fontWeight: 700 }}>{xntPrice > 0 ? fmtUSD(xntBalance * xntPrice) : '—'}</b></span>
          </div>
        </div>

        {/* ── RING TILES (2 rows × 3 cols) ── */}
        <div className="v2pf-rings">
          <RingTile label="SPL Tokens"  value={splCount}    pct={splPct} />
          <RingTile label="Token-2022"  value={t22Count}    pct={t22Pct} />
          <RingTile label="LP Tokens"   value={lpCount}     pct={lpPct} />
          <RingTile label="NFTs"        value={nftCount}    pct={nftPct} />
          <RingTile label="Other"       value={otherCount}  pct={otherPct} />
          <RingTile label="Positions"   value={positions}   pct={posPct} ringText="POS" />
          <RingTile
            label="24H Delta"
            value={connected && deltaPct != null ? `${deltaArrow} ${Math.abs(deltaPct).toFixed(2)}%` : '—'}
            pct={dPct}
            ringText="Δ"
          />
        </div>
      </div>
    </div>
  );
}
