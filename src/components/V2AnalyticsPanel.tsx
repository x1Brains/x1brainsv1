// V2AnalyticsPanel — visitor analytics rendered inline in the v2 admin console.
// Same data sources as the old /admin/analytics page (page_views + site_events
// from Supabase) but presented as compact info-cards that fit alongside the
// rest of the admin sections.

import { useEffect, useMemo, useState } from 'react';
import { getAllPageViews, getAllSiteEvents } from '../lib/supabase';

const ACCENT = '#f29030';
const MUTED  = '#5c7a90';
const DIM    = '#3a4a5a';
const TEXT   = '#cdd8e2';
const LINE   = 'rgba(242,144,48,0.13)';
const GOOD   = '#00c98d';
const COOL   = '#00d4ff';
const PURPLE = '#bf5af2';

const mono = { fontFamily: 'Orbitron, monospace', fontVariantNumeric: 'tabular-nums' as const };

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function fmtN(n: number): string {
  if (n >= 1_000_000) return `${(n/1e6).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n/1000).toFixed(1)}K`;
  return n.toLocaleString();
}

type Range = '7d' | '30d' | '90d' | 'all';

const PAGE_LABELS: Record<string, string> = {
  '/':                        'Home',
  '/portfolio':               'Portfolio',
  '/burn-history':            'Burn History',
  '/labwork':                 'LabWork',
  '/mint-labwork':            'Mint LabWork',
  '/lpfarms':                 'LP Farms',
  '/labworkdefi':             'LP Pairing',
  '/incinerator-engine':      'Incinerator',
  '/cyberdyne':               'Cyberdyne',
  '/charts':                  'Charts',
  '/swap':                    'Swap',
  '/admin':                   'Admin',
  // x1city.io routes
  '/citizenship':             'Citizenship',
  '/citizenship/mint':        'Genesis Mint',
  '/citizenship/credentials': 'Credentials',
  '/council':                 'Council',
  '/whitepaper':              'Whitepaper',
  '/agent':                   'AI Terminal',
};

type Site = 'all' | 'x1brains' | 'x1city';
const SITE_LABELS: Record<Exclude<Site, 'all'>, string> = { x1brains: 'x1brains.io', x1city: 'x1city.io' };
// Rows written before the `site` column existed (and all x1brains.io inserts,
// which omit it) default to 'x1brains' in the DB; guard here too for safety.
const siteOf = (r: any): Exclude<Site, 'all'> => (r?.site === 'x1city' ? 'x1city' : 'x1brains');

export default function V2AnalyticsPanel() {
  const [range,   setRange]   = useState<Range>('30d');
  const [site,    setSite]    = useState<Site>('all');
  const [views,   setViews]   = useState<any[]>([]);
  const [events,  setEvents]  = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr('');
    (async () => {
      try {
        const [v, e] = await Promise.all([
          getAllPageViews(),
          getAllSiteEvents().catch(() => []),
        ]);
        if (!alive) return;
        setViews(v); setEvents(e);
      } catch (ex: any) {
        if (alive) setErr(ex?.message ?? 'Failed to load analytics');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const cutoff = useMemo(() => {
    if (range === 'all') return 0;
    const d = range === '7d' ? 7 : range === '30d' ? 30 : 90;
    return Date.now() - d * 86_400_000;
  }, [range]);

  // Time-filtered, ALL sites (drives the always-visible by-site split).
  const tViews  = useMemo(() => cutoff > 0 ? views.filter(v => new Date(v.visited_at).getTime() >= cutoff) : views, [views, cutoff]);
  const tEvents = useMemo(() => cutoff > 0 ? events.filter(e => new Date(e.fired_at).getTime() >= cutoff) : events, [events, cutoff]);

  // Then narrowed to the selected site (drives every breakdown below).
  const fViews  = useMemo(() => site === 'all' ? tViews  : tViews .filter(v => siteOf(v) === site), [tViews,  site]);
  const fEvents = useMemo(() => site === 'all' ? tEvents : tEvents.filter(e => siteOf(e) === site), [tEvents, site]);

  const siteSplit = useMemo(() => {
    let x1brains = 0, x1city = 0;
    for (const v of tViews) (siteOf(v) === 'x1city' ? x1city++ : x1brains++);
    return { x1brains, x1city };
  }, [tViews]);

  const stats = useMemo(() => {
    const totalViews = fViews.length;
    const sessions   = new Set(fViews.map(v => v.session_id));

    const sessDepth = new Map<string, number>();
    for (const v of fViews) sessDepth.set(v.session_id, (sessDepth.get(v.session_id) ?? 0) + 1);
    const avgDepth = sessDepth.size > 0 ? [...sessDepth.values()].reduce((a, b) => a + b, 0) / sessDepth.size : 0;

    const pageMap = new Map<string, number>();
    for (const v of fViews) pageMap.set(v.path, (pageMap.get(v.path) ?? 0) + 1);
    const topPages = [...pageMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    const countryMap = new Map<string, number>();
    for (const v of fViews) if (v.country && v.country !== 'Unknown') countryMap.set(v.country, (countryMap.get(v.country) ?? 0) + 1);
    const topCountries = [...countryMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    const deviceMap = new Map<string, number>();
    const browserMap = new Map<string, number>();
    for (const v of fViews) {
      if (v.device)  deviceMap .set(v.device,  (deviceMap .get(v.device)  ?? 0) + 1);
      if (v.browser) browserMap.set(v.browser, (browserMap.get(v.browser) ?? 0) + 1);
    }

    const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 60;
    const dailyMap = new Map<string, number>();
    for (const v of fViews) dailyMap.set(v.visited_at.slice(0, 10), (dailyMap.get(v.visited_at.slice(0, 10)) ?? 0) + 1);
    const daily: { label: string; count: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      daily.push({ label: d.slice(5), count: dailyMap.get(d) ?? 0 });
    }
    const dailyMax = Math.max(...daily.map(d => d.count), 1);

    // Peak hour-of-day
    const hourMap = new Map<number, number>();
    for (const v of fViews) {
      const h = new Date(v.visited_at).getHours();
      hourMap.set(h, (hourMap.get(h) ?? 0) + 1);
    }
    const peakHour = [...hourMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

    // Events
    const evtTypeMap = new Map<string, number>();
    for (const e of fEvents) evtTypeMap.set(e.event_type, (evtTypeMap.get(e.event_type) ?? 0) + 1);
    const topEvents = [...evtTypeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    const walletConnects = fEvents.filter(e => e.event_type === 'wallet_connect').length;

    return {
      totalViews, uniqueVisitors: sessions.size, avgDepth,
      topPages, topCountries, deviceMap, browserMap,
      daily, dailyMax, peakHour,
      totalEvents: fEvents.length, topEvents, walletConnects,
    };
  }, [fViews, fEvents, range]);

  return (
    <div className="info-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div className="title" style={{ margin: 0 }}>Visitor Analytics</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['7d', '30d', '90d', 'all'] as const).map(r => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              style={{
                ...mono, padding: '4px 10px', borderRadius: 5,
                background: range === r ? `${ACCENT}1a` : 'rgba(255,255,255,.02)',
                border: `1px solid ${range === r ? `${ACCENT}80` : 'rgba(255,255,255,.07)'}`,
                color: range === r ? ACCENT : MUTED,
                fontSize: 8, fontWeight: 700, letterSpacing: 1.2, cursor: 'pointer',
              }}
            >
              {r === 'all' ? 'ALL' : r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Site segment — separate x1city.io from x1brains.io */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {(['all', 'x1brains', 'x1city'] as const).map(s => (
          <button
            key={s}
            type="button"
            onClick={() => setSite(s)}
            style={{
              ...mono, padding: '5px 12px', borderRadius: 5,
              background: site === s ? `${COOL}1a` : 'rgba(255,255,255,.02)',
              border: `1px solid ${site === s ? `${COOL}80` : 'rgba(255,255,255,.07)'}`,
              color: site === s ? COOL : MUTED,
              fontSize: 8, fontWeight: 700, letterSpacing: 1.2, cursor: 'pointer',
            }}
          >
            {s === 'all' ? 'ALL SITES' : SITE_LABELS[s].toUpperCase()}
          </button>
        ))}
      </div>

      {loading && (
        <div className="lw-placeholder">
          <div className="lw-placeholder-glyph">⟳</div>
          <div className="lw-placeholder-sub">Loading analytics…</div>
        </div>
      )}

      {!loading && err && (
        <div className="lw-placeholder">
          <div className="lw-placeholder-glyph">⚠</div>
          <div className="lw-placeholder-sub">{err}</div>
        </div>
      )}

      {!loading && !err && (
        <>
          {/* By-site split — always shows both; click a card to filter the panel */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <div onClick={() => setSite('x1brains')} style={{ cursor: 'pointer', padding: '10px 14px', borderRadius: 7, background: 'rgba(242,144,48,0.05)', border: `1px solid ${site === 'x1city' ? 'rgba(255,255,255,.07)' : LINE}` }}>
              <div style={{ ...mono, fontSize: 8, color: DIM, letterSpacing: 1.5, fontWeight: 700 }}>X1BRAINS.IO</div>
              <div style={{ ...mono, fontSize: 20, color: ACCENT, fontWeight: 800, marginTop: 4 }}>{fmtN(siteSplit.x1brains)}</div>
              <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 9, color: MUTED }}>views · this range</div>
            </div>
            <div onClick={() => setSite('x1city')} style={{ cursor: 'pointer', padding: '10px 14px', borderRadius: 7, background: 'rgba(0,212,255,0.05)', border: `1px solid ${site === 'x1brains' ? 'rgba(255,255,255,.07)' : `${COOL}40`}` }}>
              <div style={{ ...mono, fontSize: 8, color: DIM, letterSpacing: 1.5, fontWeight: 700 }}>X1CITY.IO</div>
              <div style={{ ...mono, fontSize: 20, color: COOL, fontWeight: 800, marginTop: 4 }}>{fmtN(siteSplit.x1city)}</div>
              <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 9, color: MUTED }}>views · this range</div>
            </div>
          </div>

          <div className="lw-stats">
            <div className="lw-stat"><div className="label">VIEWS</div><div className="value">{fmtN(stats.totalViews)}</div></div>
            <div className="lw-stat"><div className="label">UNIQUE</div><div className="value">{fmtN(stats.uniqueVisitors)}</div></div>
            <div className="lw-stat"><div className="label">AVG DEPTH</div><div className="value">{stats.avgDepth.toFixed(1)}</div></div>
            <div className="lw-stat"><div className="label">PEAK HR</div><div className="value">{String(stats.peakHour).padStart(2, '0')}:00</div></div>
            <div className="lw-stat"><div className="label">EVENTS</div><div className="value">{fmtN(stats.totalEvents)}</div></div>
            <div className="lw-stat"><div className="label">WALLET CONNECTS</div><div className="value">{fmtN(stats.walletConnects)}</div></div>
          </div>

          {/* Daily trend sparkline */}
          <div style={{ marginTop: 16, padding: '12px 14px', background: 'rgba(242,144,48,0.03)', border: `1px solid ${LINE}`, borderRadius: 7 }}>
            <div style={{ ...mono, fontSize: 8, color: DIM, letterSpacing: 1.5, fontWeight: 700, marginBottom: 8 }}>
              DAILY VIEWS · {stats.daily.length}d
            </div>
            <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 60 }}>
              {stats.daily.map((d, i) => {
                const h = Math.max(2, (d.count / stats.dailyMax) * 56);
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-end' }} title={`${d.label} · ${d.count}`}>
                    <div style={{
                      height: h, background: `linear-gradient(180deg, ${ACCENT}, ${ACCENT}60)`,
                      borderRadius: 2, transition: 'height .3s',
                    }} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Two-column body */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 12 }}>
            <BreakdownList title="TOP PAGES"      items={stats.topPages.map(([k, v]) => [PAGE_LABELS[k] ?? k, v])} color={ACCENT}  total={stats.totalViews} />
            <BreakdownList title="TOP COUNTRIES"  items={stats.topCountries}                                          color={GOOD}    total={stats.totalViews} />
            <BreakdownList title="TOP EVENTS"     items={stats.topEvents}                                              color={COOL}    total={stats.totalEvents} />
            <BreakdownList title="DEVICES"        items={[...stats.deviceMap.entries()].sort((a, b) => b[1] - a[1])}  color={PURPLE}  total={stats.totalViews} />
          </div>
        </>
      )}
    </div>
  );
}

function BreakdownList({
  title, items, color, total,
}: { title: string; items: [string, number][]; color: string; total: number }) {
  return (
    <div style={{ padding: '10px 12px', background: 'rgba(0,0,0,0.18)', border: `1px solid ${LINE}`, borderRadius: 7 }}>
      <div style={{ ...mono, fontSize: 8, color: DIM, letterSpacing: 1.5, fontWeight: 700, marginBottom: 8 }}>
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ ...mono, fontSize: 9, color: DIM, padding: '8px 0' }}>—</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {items.map(([k, v]) => {
            const pct = total > 0 ? (v / total) * 100 : 0;
            return (
              <div key={k} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...mono, fontFamily: 'Sora, sans-serif', fontSize: 10, color: TEXT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {k}
                  </div>
                  <div style={{ height: 3, background: 'rgba(255,255,255,.04)', borderRadius: 2, overflow: 'hidden', marginTop: 3 }}>
                    <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: color, borderRadius: 2 }} />
                  </div>
                </div>
                <div style={{ ...mono, fontSize: 10, color, fontWeight: 700, letterSpacing: 0.5 }}>
                  {fmtN(v)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
