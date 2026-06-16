import { FC, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import type { BurnerEntry } from './BurnLeaderboard';
import { fmtNum, fmtUSD, shortAddr } from '../utils/v2format';

const ACCENT = '#f29030';
const MUTED  = '#5c7a90';
const DIM    = '#3a4a5a';
const TEXT   = '#cdd8e2';
const LINE   = 'rgba(242,144,48,0.13)';

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2-lb-styles-min')) return;
  const s = document.createElement('style');
  s.id = 'v2-lb-styles-min';
  s.textContent = `
    .v2lb-mono {
      font-family: 'Orbitron', monospace;
      font-variant-numeric: tabular-nums lining-nums;
    }
    .v2lb-row {
      display: grid;
      grid-template-columns: 36px 1fr 120px 50px;
      gap: 12px;
      align-items: center;
      padding: 10px 12px;
      background: rgba(242, 144, 48, 0.04);
      border: 1px solid rgba(242, 144, 48, 0.13);
      border-radius: 7px;
      transition: border-color .15s;
    }
    .v2lb-row:hover { border-color: rgba(242, 144, 48, 0.33); }
    .v2lb-row.you {
      border-color: rgba(242, 144, 48, 0.55);
      box-shadow: inset 0 0 0 1px rgba(242, 144, 48, 0.2);
    }
    @media (max-width: 640px) {
      .v2lb-row {
        grid-template-columns: 32px 1fr 100px;
        gap: 8px;
      }
      .v2lb-row .v2lb-txs { display: none; }
    }
  `;
  document.head.appendChild(s);
}

const Row: FC<{
  rank: number;
  entry: BurnerEntry;
  price: number;
  isYou: boolean;
}> = ({ rank, entry, price, isYou }) => {
  return (
    <div className={`v2lb-row${isYou ? ' you' : ''}`}>
      <span className="v2lb-mono" style={{
        fontSize: 11, fontWeight: 600,
        color: rank <= 3 ? ACCENT : MUTED,
        letterSpacing: 0.5,
      }}>#{rank}</span>
      <div style={{ minWidth: 0 }}>
        <div className="v2lb-mono" style={{
          fontSize: 11, fontWeight: 600, color: TEXT, letterSpacing: 0.5,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={entry.address}>
          {shortAddr(entry.address, 5, 5)}
          {isYou && (
            <span className="v2lb-mono" style={{
              marginLeft: 8, padding: '1px 5px', borderRadius: 2,
              fontSize: 7, color: ACCENT, letterSpacing: 1,
              border: `1px solid ${ACCENT}40`,
            }}>YOU</span>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="v2lb-mono" style={{
          fontSize: 12, fontWeight: 600, color: ACCENT, letterSpacing: 0.5,
        }}>
          {fmtNum(entry.burned, 0)}
        </div>
        <div className="v2lb-mono" style={{
          fontSize: 8, color: MUTED, letterSpacing: 1, marginTop: 1,
        }}>
          {price > 0 ? fmtUSD(entry.burned * price) : '—'}
        </div>
      </div>
      <div className="v2lb-mono v2lb-txs" style={{
        textAlign: 'right',
        fontSize: 10, color: MUTED, letterSpacing: 0.5,
      }}>
        {entry.txCount}×
      </div>
    </div>
  );
};

type SortMode = 'burned' | 'txs';
type Props = {
  entries: BurnerEntry[];
  price: number;
  scanning: boolean;
  /** Canonical total burned (e.g. supply-diff). Falls back to summing entries. */
  totalBurnedOverride?: number;
};

export default function V2BurnLeaderboard({ entries, price, scanning, totalBurnedOverride }: Props) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  useEffect(() => { injectStyles(); }, []);

  const [sortMode, setSortMode] = useState<SortMode>('burned');

  const sorted = useMemo(() => {
    const arr = [...entries];
    if (sortMode === 'burned') arr.sort((a, b) => b.burned - a.burned);
    else                       arr.sort((a, b) => b.txCount - a.txCount);
    return arr;
  }, [entries, sortMode]);

  const scannedBurned = entries.reduce((s, e) => s + e.burned, 0);
  // Prefer the canonical supply-diff value when provided so this matches
  // the dashboard at the top (otherwise the leaderboard would show only
  // what's been chain-scanned so far, which drifts < actual).
  const totalBurned   = totalBurnedOverride ?? scannedBurned;
  const uniqueBurners = entries.length;
  const totalTxs      = entries.reduce((s, e) => s + e.txCount, 0);
  const myEntry       = me ? entries.find(e => e.address === me) : null;
  const myRank        = me ? sorted.findIndex(e => e.address === me) + 1 : 0;

  // Top 10 only — no expand
  const visible = sorted.slice(0, 10);

  return (
    <div className="info-card">
      {/* Head */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: 10,
        marginBottom: 14,
      }}>
        <div className="title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>Burn Leaderboard</span>
          <span className="v2lb-mono" style={{
            fontSize: 8, color: scanning ? ACCENT : MUTED, letterSpacing: 1.5, fontWeight: 700,
          }}>
            {scanning ? 'SCANNING' : 'LIVE'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['burned', 'txs'] as SortMode[]).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setSortMode(m)}
              className="v2lb-mono"
              style={{
                padding: '4px 10px', borderRadius: 5,
                background: sortMode === m ? 'rgba(242,144,48,0.1)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${sortMode === m ? 'rgba(242,144,48,0.5)' : 'rgba(255,255,255,0.07)'}`,
                color: sortMode === m ? ACCENT : MUTED,
                fontSize: 8, fontWeight: 700, letterSpacing: 1.2,
                cursor: 'pointer',
              }}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Stats strip */}
      <div className="lw-stats" style={{ marginBottom: 14 }}>
        <div className="lw-stat"><div className="label">BURNED</div><div className="value">{fmtNum(totalBurned, 0)}</div></div>
        <div className="lw-stat"><div className="label">USD</div><div className="value" style={{ fontSize: 12 }}>{price > 0 ? fmtUSD(totalBurned * price) : '—'}</div></div>
        <div className="lw-stat"><div className="label">WALLETS</div><div className="value">{uniqueBurners.toLocaleString()}</div></div>
        <div className="lw-stat"><div className="label">TXS</div><div className="value">{totalTxs.toLocaleString()}</div></div>
      </div>

      {/* My position pin — show when wallet's rank is below the visible top 10 */}
      {myEntry && myRank > 10 && (
        <div style={{ marginBottom: 8 }}>
          <Row rank={myRank} entry={myEntry} price={price} isYou />
        </div>
      )}

      {/* Rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.length === 0 ? (
          <div className="lw-placeholder">
            <div className="lw-placeholder-glyph">{scanning ? '⟳' : '◌'}</div>
            <div className="lw-placeholder-sub">
              {scanning ? 'Scanning chain for burn history…' : 'No burns detected'}
            </div>
          </div>
        ) : (
          visible.map((e, i) => (
            <Row key={e.address} rank={i + 1} entry={e} price={price} isYou={e.address === me} />
          ))
        )}
      </div>

    </div>
  );
}
