import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { fetchAllPrices, type TokenSymbol } from '../lib/prices';
import { fetch24hChanges } from '../lib/priceChange';
import { ADMIN_WALLETS, roleFor } from '../lib/admin';
import { XNT_LOGO, BRAINS_LOGO, BRAINS_MINT } from '../constants';
import { getCachedTokenLogo } from '../lib/tokenLogos';

const LB_MINT_ADDR = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
function logoFor(sym: string): string | undefined {
  if (sym === 'XNT') return XNT_LOGO;
  if (sym === 'BRAINS') return BRAINS_LOGO;
  if (sym === 'LB') return getCachedTokenLogo(LB_MINT_ADDR) ?? undefined;
  return undefined;
}

type Tick = { symbol: TokenSymbol; price: number; pct: number | null };

const PAGE_META: Record<string, { title: string; badge: string }> = {
  '/':                   { title: 'X1 BRAINS',   badge: 'LAB · NFTS · DEFI' },
  '/swap':               { title: 'SWAP',        badge: 'xDEX PROTOCOL' },
  '/labwork':            { title: 'LAB WORK',    badge: 'NFT MARKETPLACE' },
  '/mint-labwork':       { title: 'MINT LABWORK', badge: 'CREATE · BURN' },
  '/labworkdefi':        { title: 'LP PAIRING',  badge: 'PAIRING MARKET' },
  '/lpfarms':            { title: 'LP FARMS',    badge: 'STAKING' },
  '/charts':             { title: 'CHARTS',      badge: 'MARKET DATA' },
  '/portfolio':          { title: 'PORTFOLIO',   badge: 'YOUR ASSETS' },
  '/cyberdyne':          { title: 'CYBERDYNE',   badge: 'UNLIMITED' },
  '/incinerator-engine': { title: 'INCINERATOR', badge: 'BURN ENGINE' },
  '/burn-history':       { title: 'BURN LOG',    badge: 'HISTORY' },
  '/admin':              { title: 'ADMIN',       badge: 'CONSOLE' },
  '/home':               { title: 'HOME',        badge: 'X1 BRAINS' },
};

function fmtPrice(p: number): string {
  if (!p) return '—';
  if (p >= 1) return '$' + p.toFixed(2);
  if (p >= 0.01) return '$' + p.toFixed(4);
  return '$' + p.toFixed(6);
}

export default function Header() {
  const { pathname } = useLocation();
  const { publicKey } = useWallet();
  const meta = PAGE_META[pathname] ?? {
    title: pathname.replace(/^\//, '').toUpperCase() || 'X1 BRAINS',
    badge: 'X1 BRAINS',
  };

  const pk = publicKey?.toBase58() ?? '';
  const isAdmin = !!pk && ADMIN_WALLETS.has(pk);
  const adminRole = roleFor(pk);
  const onAdminPage = pathname === '/admin';

  const [ticks, setTicks] = useState<Tick[]>([
    { symbol: 'XNT',    price: 0, pct: null },
    { symbol: 'BRAINS', price: 0, pct: null },
    { symbol: 'LB',     price: 0, pct: null },
  ]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      // Prices + real 24h change derived from on-chain chart history — the SAME
      // source the landing ecosystem strip uses, so both pillars always agree.
      const [all, changes] = await Promise.all([
        fetchAllPrices(),
        fetch24hChanges(BRAINS_MINT).catch(() => ({ XNT: null, BRAINS: null, LB: null })),
      ]);
      if (!alive) return;
      const next: Tick[] = (['XNT', 'BRAINS', 'LB'] as TokenSymbol[]).map(sym => ({
        symbol: sym,
        price: all[sym] || 0,
        pct: changes[sym],
      }));
      setTicks(next);
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <header className="header">
      <div className="header-left">
        <h2>{meta.title}</h2>
        <span className="badge">{meta.badge}</span>
      </div>
      <div className="header-right">
        {isAdmin && (() => {
          const c = adminRole === 'council' ? '#bf5af2' : '#f29030';
          return (
            <Link
              to="/admin"
              aria-label="Open admin console"
              title={`Admin Console · ${adminRole === 'council' ? 'COUNCIL' : 'V1 ADMIN'}`}
              className="header-admin-btn"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, marginRight: 10,
                borderRadius: 6,
                textDecoration: 'none',
                background: onAdminPage ? `${c}1f` : 'transparent',
                border: `1px solid ${onAdminPage ? `${c}80` : `${c}33`}`,
                color: c,
                fontSize: 13, lineHeight: 1,
                transition: 'background .15s, border-color .15s',
              }}
            >
              <span aria-hidden="true">⚙</span>
            </Link>
          );
        })()}
        <div className="price-ticker">
          {ticks.map((t, i) => {
            const hasPct = t.pct != null;
            const up = (t.pct ?? 0) >= 0;
            const dir: 'up' | 'down' | 'flat' = !hasPct
              ? 'flat'
              : Math.abs(t.pct!) < 0.01 ? 'flat' : (up ? 'up' : 'down');
            const color = dir === 'up' ? '#00c98d' : dir === 'down' ? '#ff4466' : '#5c7a90';
            const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';
            const label = hasPct
              ? `${dir === 'down' ? '−' : '+'}${Math.abs(t.pct!).toFixed(2)}%`
              : '—';
            return (
              <span key={t.symbol} style={{ display: 'contents' }}>
                <div className="ticker-item" title={hasPct ? `24h change vs anchor sample` : 'Building 24h anchor…'}>
                  {(() => {
                    const logo = logoFor(t.symbol);
                    return logo
                      ? <img src={logo} alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          style={{ width: 13, height: 13, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                      : null;
                  })()}
                  <span className="label">{t.symbol}</span>
                  <span className="value">{fmtPrice(t.price)}</span>
                  <span
                    className={`change ${dir}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                      padding: '1px 5px', borderRadius: 4,
                      background: `${color}14`,
                      border: `1px solid ${color}55`,
                      color, fontFamily: 'Orbitron, monospace',
                      fontSize: 8, fontWeight: 800, letterSpacing: 0.4,
                    }}
                  >
                    <span aria-hidden="true">{arrow}</span>
                    {label}
                  </span>
                </div>
                {i < ticks.length - 1 && <span className="ticker-pip" />}
              </span>
            );
          })}
        </div>
      </div>
    </header>
  );
}
