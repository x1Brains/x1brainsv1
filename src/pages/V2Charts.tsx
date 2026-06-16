// V2 Pools & Charts — v2-native xDex pool browser, styled with the shared
// .lf9-* paneled layout (identical to LP Farms / LP Pairing). Lists every xDEX
// pool containing BRAINS or LB, with per-pool TWAP charts + native SWAP
// (deep-links to /swap) + DEPOSIT / WITHDRAW (PoolsTab modals).

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import V2XdexPoolsList from '../components/V2XdexPoolsList';
import { fetchIndexerSnapshot, getCachedIndexerSnapshot, type IndexerSnapshot } from '../lib/brainsIndexer';
import V2PageHeader from '../components/V2PageHeader';

export default function V2Charts() {
  // Same prism feed V2Home uses. Seed from cache for instant paint, refresh in
  // the background. 60s poll keeps the page warm if the citizen lingers.
  const [prism, setPrism] = useState<IndexerSnapshot | null>(() => getCachedIndexerSnapshot());
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchIndexerSnapshot().then(s => { if (alive && s) setPrism(s); }).catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="content content-wide v2-glass">
      <div className="lw-stack">
        <V2PageHeader title="POOLS & CHARTS" subtitle="XDEX MARKETS · X1 MAINNET" />
        <Link
          to="/labworkdefi"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, alignSelf: 'flex-start',
            fontFamily: 'Orbitron, monospace', fontSize: 10.5, fontWeight: 700, letterSpacing: 1.4,
            textTransform: 'uppercase', color: '#8a9ab8', textDecoration: 'none',
            padding: '7px 13px', borderRadius: 9, border: '1px solid #1a2433',
            background: 'rgba(255,255,255,.02)', transition: 'color .15s, border-color .15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#ff8c00'; e.currentTarget.style.borderColor = 'rgba(255,140,0,.4)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#8a9ab8'; e.currentTarget.style.borderColor = '#1a2433'; }}
        >
          ← LP Pairing
        </Link>
        <V2XdexPoolsList prism={prism} />
      </div>
    </div>
  );
}
