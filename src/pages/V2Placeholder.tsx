import { useLocation } from 'react-router-dom';

const TITLES: Record<string, { title: string; sub: string; glyph: string }> = {
  '/labworkdefi':        { title: 'LP Pairing',  sub: 'Pair tokens · create XDEX pools',   glyph: '◈' },
  '/lpfarms':            { title: 'LP Farms',    sub: 'Stake LP tokens · earn rewards',    glyph: '⟠' },
  '/charts':             { title: 'Charts',      sub: 'BRAINS / LB / XNT market data',     glyph: '≣' },
  '/portfolio':          { title: 'Portfolio',   sub: 'Holdings, history, snapshots',      glyph: '⊞' },
  '/cyberdyne':          { title: 'Cyberdyne',   sub: 'Unlimited citizens · Imperial API', glyph: '⚔' },
  '/incinerator-engine': { title: 'Incinerator', sub: 'Burn portal · leaderboard',         glyph: '☄' },
  '/burn-history':       { title: 'Burn Log',    sub: 'On-chain burn history',             glyph: '✕' },
  '/home':               { title: 'Home',        sub: 'X1 Brains homepage',                glyph: '⌂' },
};

export default function V2Placeholder() {
  const { pathname } = useLocation();
  const meta = TITLES[pathname] ?? { title: pathname, sub: '', glyph: '◆' };

  return (
    <div className="content content-wide">
      <div className="card">
        <div className="card-title">{meta.title}</div>
        <div className="lw-placeholder">
          <div className="lw-placeholder-glyph">{meta.glyph}</div>
          <div className="lw-placeholder-title">Being rebuilt in v2 style</div>
          <div className="lw-placeholder-sub">
            {meta.sub} — logic exists in v1, getting reskinned in v2 next.
          </div>
        </div>
      </div>
    </div>
  );
}
