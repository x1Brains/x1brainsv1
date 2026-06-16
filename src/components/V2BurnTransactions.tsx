import { FC, useEffect, useMemo, useState } from 'react';
import type { BurnerEntry } from './BurnLeaderboard';
import { fmtNum, fmtUSD, shortAddr } from '../utils/v2format';

const ACCENT = '#f29030';
const MUTED  = '#5c7a90';
const DIM    = '#3a4a5a';
const TEXT   = '#cdd8e2';
const LINE   = 'rgba(242,144,48,0.13)';

type FlatBurn = {
  sig: string;
  wallet: string;
  amount: number;
  block_time: number;
};

function flatten(entries: BurnerEntry[]): FlatBurn[] {
  const out: FlatBurn[] = [];
  for (const e of entries) {
    for (const ev of e.events ?? []) {
      out.push({ sig: ev.sig, wallet: e.address, amount: ev.amount, block_time: ev.blockTime });
    }
  }
  return out.sort((a, b) => b.block_time - a.block_time);
}

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60)     return `${diff}s ago`;
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2-tx-styles-min')) return;
  const s = document.createElement('style');
  s.id = 'v2-tx-styles-min';
  s.textContent = `
    .v2tx-mono {
      font-family: 'Orbitron', monospace;
      font-variant-numeric: tabular-nums lining-nums;
    }
    .v2tx-row {
      display: grid;
      grid-template-columns: 1.4fr 1fr 80px 70px;
      gap: 12px;
      align-items: center;
      padding: 10px 12px;
      background: rgba(242, 144, 48, 0.04);
      border: 1px solid rgba(242, 144, 48, 0.13);
      border-radius: 7px;
      transition: border-color .15s;
    }
    .v2tx-row:hover { border-color: rgba(242, 144, 48, 0.33); }
    @media (max-width: 640px) {
      .v2tx-row {
        grid-template-columns: 1fr 80px;
        gap: 8px;
      }
      .v2tx-row .v2tx-usd,
      .v2tx-row .v2tx-time { display: none; }
    }
  `;
  document.head.appendChild(s);
}

const TxRow: FC<{ tx: FlatBurn; price: number; symbol: string }> = ({ tx, price, symbol }) => (
  <div className="v2tx-row">
    <div style={{ minWidth: 0 }}>
      <a
        href={`https://explorer.mainnet.x1.xyz/address/${tx.wallet}`}
        target="_blank" rel="noopener noreferrer"
        className="v2tx-mono"
        style={{
          display: 'block',
          fontSize: 10, fontWeight: 600, color: TEXT, letterSpacing: 0.5,
          textDecoration: 'none',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
        title={tx.wallet}
      >{shortAddr(tx.wallet, 5, 5)}</a>
      <a
        href={`https://explorer.mainnet.x1.xyz/tx/${tx.sig}`}
        target="_blank" rel="noopener noreferrer"
        className="v2tx-mono"
        style={{
          display: 'block',
          fontSize: 8, color: MUTED, letterSpacing: 1,
          marginTop: 2, textDecoration: 'none',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
        title={tx.sig}
      >{shortAddr(tx.sig, 4, 4)} ↗</a>
    </div>
    <div className="v2tx-mono" style={{
      fontSize: 12, fontWeight: 600, color: ACCENT, letterSpacing: 0.5,
    }}>
      {fmtNum(tx.amount, 0)} {symbol}
    </div>
    <div className="v2tx-mono v2tx-usd" style={{
      textAlign: 'right',
      fontSize: 10, color: TEXT, letterSpacing: 0.5,
    }}>
      {price > 0 ? fmtUSD(tx.amount * price) : '—'}
    </div>
    <div className="v2tx-mono v2tx-time" style={{
      textAlign: 'right',
      fontSize: 9, color: MUTED, letterSpacing: 0.5,
    }}>
      {timeAgo(tx.block_time)}
    </div>
  </div>
);

type Filter = 'all' | 'whale' | 'recent';
type Props = {
  entries: BurnerEntry[];
  price: number;
  scanning: boolean;
  /** Symbol shown on each row. Defaults to BRAINS. */
  symbol?: string;
};

export default function V2BurnTransactions({ entries, price, scanning, symbol = 'BRAINS' }: Props) {
  useEffect(() => { injectStyles(); }, []);

  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(20);

  const all = useMemo(() => flatten(entries), [entries]);
  const filtered = useMemo(() => {
    if (filter === 'whale')  return all.filter(t => t.amount >= 10_000);
    if (filter === 'recent') return all.filter(t => Date.now() / 1000 - t.block_time < 86_400);
    return all;
  }, [all, filter]);

  const visible = filtered.slice(0, limit);

  const last24h = useMemo(() => {
    const cutoff = Date.now() / 1000 - 86_400;
    return all.filter(t => t.block_time >= cutoff);
  }, [all]);
  const last24hAmt = last24h.reduce((s, t) => s + t.amount, 0);
  const lastBurn = all[0];

  return (
    <div className="info-card">
      {/* Head */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: 10,
        marginBottom: 14,
      }}>
        <div className="title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>Recent Burns</span>
          <span className="v2tx-mono" style={{
            fontSize: 8, color: scanning ? ACCENT : MUTED, letterSpacing: 1.5, fontWeight: 700,
          }}>
            {scanning ? 'STREAMING' : 'LIVE'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {([
            { id: 'all',    label: 'ALL' },
            { id: 'recent', label: '24H' },
            { id: 'whale',  label: 'WHALES' },
          ] as Array<{ id: Filter; label: string }>).map(f => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className="v2tx-mono"
              style={{
                padding: '4px 10px', borderRadius: 5,
                background: filter === f.id ? 'rgba(242,144,48,0.1)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${filter === f.id ? 'rgba(242,144,48,0.5)' : 'rgba(255,255,255,0.07)'}`,
                color: filter === f.id ? ACCENT : MUTED,
                fontSize: 8, fontWeight: 700, letterSpacing: 1.2,
                cursor: 'pointer',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* 24h strip */}
      <div className="lw-stats" style={{ marginBottom: 14 }}>
        <div className="lw-stat"><div className="label">24H BURNED</div><div className="value">{fmtNum(last24hAmt, 0)}</div></div>
        <div className="lw-stat"><div className="label">24H USD</div><div className="value" style={{ fontSize: 12 }}>{price > 0 ? fmtUSD(last24hAmt * price) : '—'}</div></div>
        <div className="lw-stat"><div className="label">24H TXS</div><div className="value">{last24h.length.toLocaleString()}</div></div>
        <div className="lw-stat"><div className="label">LAST</div><div className="value" style={{ fontSize: 12 }}>{lastBurn ? timeAgo(lastBurn.block_time) : '—'}</div></div>
      </div>

      {/* Tx rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visible.length === 0 ? (
          <div className="lw-placeholder">
            <div className="lw-placeholder-glyph">{scanning ? '⟳' : '◌'}</div>
            <div className="lw-placeholder-sub">
              {scanning ? 'Streaming burn history…' : 'No transactions match'}
            </div>
          </div>
        ) : (
          visible.map(tx => <TxRow key={tx.sig} tx={tx} price={price} symbol={symbol} />)
        )}
      </div>

      {visible.length < filtered.length && (
        <button
          type="button"
          onClick={() => setLimit(l => l + 20)}
          className="v2tx-mono"
          style={{
            marginTop: 10,
            width: '100%', padding: '8px 0',
            background: 'rgba(242, 144, 48, 0.04)',
            border: '1px solid rgba(242, 144, 48, 0.13)',
            borderRadius: 7,
            color: MUTED, fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
            cursor: 'pointer',
          }}
        >
          Load 20 more · {filtered.length - visible.length} remaining
        </button>
      )}
    </div>
  );
}
