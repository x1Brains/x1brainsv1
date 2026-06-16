// Hero focus + ring-gauge tile combo — variants 5 + 7 from the picker.
// Big LISTINGS headline drives attention; the six secondary stats sit in
// 2x3 ring tiles where the conic ring shows a meaningful share-of-listings %.

import { FC } from 'react';

const ACCENT = '#f29030';
const TEXT   = 'var(--text-primary)';
const MUTED  = 'var(--text-muted)';
const DIM    = 'var(--text-faint)';

const mono = {
  fontFamily: 'Orbitron, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2-mp-stats-styles')) return;
  const s = document.createElement('style');
  s.id = 'v2-mp-stats-styles';
  s.textContent = `
    .v2mp-grid {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 1.6fr;
      gap: 14px;
    }
    @media (max-width: 720px) {
      .v2mp-grid { grid-template-columns: 1fr; }
    }
    .v2mp-rings {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    @media (max-width: 540px) {
      .v2mp-rings { grid-template-columns: repeat(2, 1fr); }
    }
    .v2mp-ring {
      --size: 32px;
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
    .v2mp-ring::before {
      content: '';
      width: calc(var(--size) - 6px);
      height: calc(var(--size) - 6px);
      background: #0c121c;
      border-radius: 50%;
      grid-column: 1; grid-row: 1;
    }
    .v2mp-ring .pct {
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
  /** 0..100 — drives the ring fill */
  pct?:  number;
  /** Override what's shown inside the ring */
  ringText?: string;
  /** When set, the tile becomes a button that toggles a marketplace view. */
  onClick?: () => void;
  active?: boolean;
  hint?:   string;
};

const RingTile: FC<RingTileProps> = ({ label, value, pct, ringText, onClick, active, hint }) => {
  const clamped = Math.max(0, Math.min(100, pct ?? 0));
  const inside = ringText ?? (pct != null ? `${Math.round(clamped)}%` : '◆');
  const interactive = !!onClick;
  return (
    <div
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      title={hint}
      style={{
        background: active ? 'rgba(242,144,48,0.10)' : 'rgba(138, 154, 184, 0.04)',
        border: `1px solid ${active ? 'rgba(242,144,48,0.55)' : 'rgba(138, 154, 184, 0.12)'}`,
        borderRadius: 7,
        padding: '6px 10px',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 8,
        alignItems: 'center',
        minWidth: 0,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background .15s, border-color .15s, transform .12s',
        userSelect: interactive ? 'none' : 'auto',
        outline: 'none',
      }}
      onMouseEnter={interactive ? (e) => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)'; } : undefined}
      onMouseLeave={interactive ? (e) => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)'; } : undefined}
    >
      <div className="v2mp-ring" style={{ ['--p' as any]: clamped }}>
        <span className="pct">{inside}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{
          ...mono,
          fontSize: 7,
          letterSpacing: 1.5,
          fontWeight: 700,
          color: active ? ACCENT : DIM,
          marginBottom: 3,
          textTransform: 'uppercase',
        }}>{label}</div>
        <div style={{
          ...mono,
          fontSize: 12,
          fontWeight: 800,
          color: active ? ACCENT : TEXT,
          letterSpacing: 0.3,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{value}</div>
      </div>
    </div>
  );
};

type Props = {
  listings:    number;
  floorXnt:    number;        // 0 = no floor
  verified:    number;
  uncat:       number;
  yours:       number;
  yoursLabel?: string;        // override for not-connected state
  volumeXnt:   number;        // cumulative XNT volume through marketplace program
  sales?:      number;        // cumulative buy_nft count
  total:       number;
  collections: number;
  /** Connected wallet — gates the My Listings toggle so it never fires when
   *  there's no seller identity to filter by. */
  connected?:  boolean;
  /** When provided, the "Yours" ring tile becomes a toggle that switches the
   *  marketplace grid into a my-listings-only view. */
  onToggleMine?: () => void;
  mineActive?:   boolean;
  /** Optional nav shortcuts — wire any ring tile to a callback so the dashboard
   *  also acts as a tab launcher. (Overview tab was removed; these replace it.) */
  onGoBrowseVerified?: () => void;
  onGoBrowseUncat?:    () => void;
  onGoBrowseFloor?:    () => void;
  onGoActivity?:       () => void;
  onGoBrowse?:         () => void;
};

function fmtCompact(n: number, decimals = 1): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(decimals)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(decimals)}K`;
  return n.toFixed(decimals);
}

export default function MarketplaceStats(props: Props) {
  const {
    listings, floorXnt, verified, uncat, yours, yoursLabel,
    volumeXnt, sales, total, collections,
    connected, onToggleMine, mineActive,
    onGoBrowseVerified, onGoBrowseUncat, onGoBrowseFloor, onGoActivity, onGoBrowse,
  } = props;

  // Inject one-time CSS for ring + grid
  if (typeof document !== 'undefined') injectStyles();

  // Ring fills — each is a share-of-listings %, except VOLUME (decorative)
  // and FLOOR (ratio of current floor to a 100-XNT visual scale, capped).
  const pctOf = (n: number, denom: number) =>
    denom > 0 ? Math.max(0, Math.min(100, (n / denom) * 100)) : 0;

  const verifiedPct = pctOf(verified, listings);
  const uncatPct    = pctOf(uncat, listings);
  const yoursPct    = pctOf(yours, listings);
  const totalPct    = pctOf(listings, total);
  // Volume tile uses a log-style gauge for variety (caps at 1M XNT).
  const volumePct   = volumeXnt > 0 ? Math.min(100, Math.log10(volumeXnt + 1) * 16) : 0;
  // Collections tile fills based on listed-collections count (assumes <=10 is "rich")
  const colPct      = Math.min(100, collections * 16);
  // Floor — ring shows position on a 0..100 XNT visual scale (capped)
  const floorPct    = Math.min(100, (floorXnt / 100) * 100);

  return (
    <div className="info-card">
      {/* Section title — distinguishes this whole-marketplace dashboard from the
          featured Brains Elites collection banner above it. */}
      <div style={{ ...mono, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: 1.5, color: TEXT }}>
          LB <span style={{ color: ACCENT }}>MARKETPLACE</span>
        </span>
        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 2, color: MUTED }}>LIVE · ALL COLLECTIONS</span>
      </div>
      <div className="v2mp-grid">
        {/* ── HERO ── */}
        <div style={{
          position: 'relative',
          background: 'linear-gradient(155deg, rgba(242,144,48,.12), rgba(242,144,48,.02))',
          border: '1px solid rgba(242,144,48,0.3)',
          borderRadius: 10,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 10,
        }}>
          <div>
            <div style={{
              ...mono,
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: 2.5,
              color: ACCENT,
              marginBottom: 4,
            }}>
              ACTIVE LISTINGS
            </div>
            <div style={{
              ...mono,
              fontSize: 36,
              fontWeight: 900,
              lineHeight: 1,
              color: ACCENT,
              letterSpacing: 1,
            }}>
              {listings.toLocaleString()}
            </div>
            <div style={{
              ...mono,
              fontSize: 9,
              color: MUTED,
              letterSpacing: 1.2,
              marginTop: 4,
            }}>
              floor <span style={{ color: TEXT, fontWeight: 700 }}>
                {floorXnt > 0 ? `${floorXnt.toFixed(2)} XNT` : '—'}
              </span> · <span style={{ color: TEXT, fontWeight: 700 }}>{collections}</span> coll
            </div>
          </div>

          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            ...mono,
            fontSize: 8,
            color: MUTED,
            letterSpacing: 1.3,
          }}>
            <span>VER <b style={{ color: TEXT, fontWeight: 700 }}>{verified}</b></span>
            <span>UNC <b style={{ color: TEXT, fontWeight: 700 }}>{uncat}</b></span>
            <span>YOURS <b style={{ color: ACCENT, fontWeight: 700 }}>{yoursLabel ?? yours}</b></span>
            <span>VOL <b style={{ color: TEXT, fontWeight: 700 }}>{fmtCompact(volumeXnt)}</b></span>
            {sales != null && sales > 0 && (
              <span>SALES <b style={{ color: TEXT, fontWeight: 700 }}>{sales}</b></span>
            )}
          </div>
        </div>

        {/* ── RING TILES (2 rows × 3 cols) ── */}
        <div className="v2mp-rings">
          <RingTile
            label="Verified"
            value={verified}
            pct={verifiedPct}
            onClick={onGoBrowseVerified}
            hint={onGoBrowseVerified ? 'Browse verified collections.' : undefined}
          />
          <RingTile
            label="Uncat"
            value={uncat}
            pct={uncatPct}
            onClick={onGoBrowseUncat}
            hint={onGoBrowseUncat ? 'Browse uncategorized listings.' : undefined}
          />
          <RingTile
            label={mineActive ? '✓ My Listings (active)' : 'My Listings'}
            value={yoursLabel ?? yours}
            pct={yoursPct}
            onClick={connected && onToggleMine ? onToggleMine : undefined}
            active={mineActive}
            hint={connected
              ? (mineActive ? 'Click to return to the full marketplace.' : 'Click to view only your listings.')
              : 'Connect a wallet to see your listings.'}
          />
          <RingTile
            label="Floor"
            value={floorXnt > 0 ? `${floorXnt.toFixed(2)} XNT` : '—'}
            pct={floorPct}
            ringText="FLR"
            onClick={onGoBrowseFloor}
            hint={onGoBrowseFloor ? 'Browse, sorted by lowest price.' : undefined}
          />
          <RingTile
            label={sales != null && sales > 0 ? `Volume · ${sales} sales` : 'Volume'}
            value={`${fmtCompact(volumeXnt)} XNT`}
            pct={volumePct}
            ringText="VOL"
            onClick={onGoActivity}
            hint={onGoActivity ? 'Open the activity feed.' : undefined}
          />
          <RingTile
            label="Collections"
            value={collections}
            pct={colPct}
            onClick={onGoBrowse}
            hint={onGoBrowse ? 'Browse all collections.' : undefined}
          />
        </div>
      </div>
    </div>
  );
}
