// src/components/PortfolioChart.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Portfolio History — daily snapshots → line chart + insights
// ─────────────────────────────────────────────────────────────────────────────
import React, { FC, useState, useMemo, useEffect, useRef } from 'react';
import type { PortfolioSnapshot, SnapshotToken } from '../lib/supabase';

// ─── STYLE INJECTION ─────────────────────────────────────────────────────────
(function () {
  if (typeof document === 'undefined') return;
  if (document.getElementById('pc-styles')) return;
  const s = document.createElement('style');
  s.id = 'pc-styles';
  s.textContent = `
    @keyframes pc-fade  { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
    @keyframes pc-bar   { from{width:0%} }
    @keyframes pc-pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
    .pc-in { animation: pc-fade .35s ease both; }
    .pc-bar { animation: pc-bar .6s cubic-bezier(.4,0,.2,1) both; }
    .pc-tooltip {
      position:absolute; pointer-events:none;
      background:rgba(8,12,16,.97); border:1px solid rgba(255,140,0,.3);
      border-radius:8px; padding:8px 12px; white-space:nowrap;
      box-shadow:0 4px 20px rgba(0,0,0,.5);
      transform:translateX(-50%);
      font-family:'Sora',sans-serif; font-size:11px;
      z-index:100; transition:opacity .1s;
    }
  `;
  document.head.appendChild(s);
})();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const fmtUSD = (v: number) =>
  v >= 1_000_000 ? `$${(v/1e6).toFixed(2)}M` :
  v >= 1_000     ? `$${(v/1e3).toFixed(2)}K` :
  `$${v.toFixed(2)}`;

const fmtDate = (iso: string) => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
};

const fmtDateFull = (iso: string) => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
};

const today = () => new Date().toISOString().slice(0, 10);

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

// ─── SVG LINE CHART ───────────────────────────────────────────────────────────
interface ChartPoint { date: string; value: number; }

const LineChart: FC<{
  points:   ChartPoint[];
  color:    string;
  height?:  number;
  isMobile: boolean;
}> = ({ points, color, height = 160, isMobile }) => {
  const svgRef   = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; point: ChartPoint } | null>(null);

  const W = 800;
  const H = height;
  const PAD = { top: 12, right: 16, bottom: 28, left: isMobile ? 4 : 8 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const min = Math.min(...points.map(p => p.value));
  const max = Math.max(...points.map(p => p.value));
  const range = max - min || 1;

  const xs = points.map((_, i) => PAD.left + (i / Math.max(points.length - 1, 1)) * innerW);
  const ys = points.map(p => PAD.top + innerH - ((p.value - min) / range) * innerH);

  const linePath = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x},${ys[i]}`).join(' ');
  const areaPath = `${linePath} L${xs[xs.length-1]},${H - PAD.bottom} L${xs[0]},${H - PAD.bottom} Z`;

  // Y-axis grid lines
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(t => ({
    y: PAD.top + innerH * (1 - t),
    label: fmtUSD(min + range * t),
  }));

  // X-axis labels — show every Nth
  const step = points.length <= 7 ? 1 : points.length <= 14 ? 2 : points.length <= 30 ? 5 : 10;
  const xLabels = points
    .map((p, i) => ({ p, i, x: xs[i] }))
    .filter(({ i }) => i % step === 0 || i === points.length - 1);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    // Find closest point
    let closest = 0;
    let minDist = Infinity;
    xs.forEach((x, i) => {
      const d = Math.abs(x - mx);
      if (d < minDist) { minDist = d; closest = i; }
    });
    setHover({ x: xs[closest], y: ys[closest], point: points[closest] });
  };

  const isUp = points.length >= 2 && points[points.length-1].value >= points[0].value;

  return (
    <div style={{ position:'relative' }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width:'100%', height, display:'block', overflow:'visible' }}
        preserveAspectRatio="none"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`area-grad-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0"    />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {gridLines.map((g, i) => (
          <line key={i} x1={PAD.left} y1={g.y} x2={W - PAD.right} y2={g.y}
            stroke="rgba(255,255,255,.04)" strokeWidth="1" />
        ))}

        {/* Area fill */}
        <path d={areaPath} fill={`url(#area-grad-${color.replace('#','')})`} />

        {/* Line */}
        <path d={linePath} fill="none" stroke={color} strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" />

        {/* Hover dot */}
        {hover && (
          <>
            <line x1={hover.x} y1={PAD.top} x2={hover.x} y2={H - PAD.bottom}
              stroke={`${color}40`} strokeWidth="1" strokeDasharray="4,3" />
            <circle cx={hover.x} cy={hover.y} r="5" fill={color} />
            <circle cx={hover.x} cy={hover.y} r="8" fill={`${color}30`} />
          </>
        )}

        {/* Last point dot */}
        {points.length > 0 && (
          <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r="4" fill={color}
            style={{ filter:`drop-shadow(0 0 4px ${color})` }} />
        )}

        {/* X-axis labels */}
        {xLabels.map(({ p, i, x }) => (
          <text key={i} x={x} y={H - 4} textAnchor="middle"
            style={{ fontFamily:'Orbitron,monospace', fontSize:8, fill:'rgba(255,255,255,.25)' }}>
            {fmtDate(p.date)}
          </text>
        ))}
      </svg>

      {/* Y-axis labels — overlaid */}
      {!isMobile && (
        <div style={{ position:'absolute', top:0, right:0, height:'100%', pointerEvents:'none' }}>
          {gridLines.map((g, i) => (
            <div key={i} style={{
              position:'absolute', right:0,
              top: `${(g.y / H) * 100}%`,
              transform:'translateY(-50%)',
              fontFamily:'Orbitron,monospace', fontSize:7,
              color:'rgba(255,255,255,.2)', letterSpacing:.5,
            }}>{g.label}</div>
          ))}
        </div>
      )}

      {/* Tooltip */}
      {hover && (
        <div className="pc-tooltip" style={{
          left: `${(hover.x / W) * 100}%`,
          top: `${(hover.y / H) * 100 - 18}%`,
        }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:12, fontWeight:700, color }}>
            {fmtUSD(hover.point.value)}
          </div>
          <div style={{ color:'#6a8ea8', fontSize:10, marginTop:2 }}>
            {fmtDateFull(hover.point.date)}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── TOKEN SPARKLINE ─────────────────────────────────────────────────────────
const TokenSparkline: FC<{ points: number[]; color: string; height?: number }> = ({ points, color, height = 32 }) => {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const W = 80, H = height;
  const xs = points.map((_, i) => (i / (points.length - 1)) * W);
  const ys = points.map(p => H - ((p - min) / range) * (H - 4) - 2);
  const line = xs.map((x, i) => `${i===0?'M':'L'}${x},${ys[i]}`).join(' ');
  const isUp = points[points.length-1] >= points[0];
  const c = isUp ? '#00c98d' : '#ff4466';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:80, height, display:'block' }} preserveAspectRatio="none">
      <path d={line} fill="none" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
};

// ─── INSIGHT CARD ─────────────────────────────────────────────────────────────
const InsightCard: FC<{ icon: string; label: string; value: string; sub?: string; color: string; delay?: number }> = ({
  icon, label, value, sub, color, delay = 0,
}) => (
  <div className="pc-in" style={{
    animationDelay: `${delay}s`,
    background: 'linear-gradient(135deg,#0d1520,#0a1018)',
    border: `1px solid ${color}20`,
    borderLeft: `3px solid ${color}`,
    borderRadius: 10, padding: '12px 16px',
  }}>
    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
      <span style={{ fontSize:14 }}>{icon}</span>
      <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#6a8ea8' }}>{label}</span>
    </div>
    <div style={{ fontFamily:'Orbitron,monospace', fontSize:16, fontWeight:900, color, letterSpacing:1 }}>{value}</div>
    {sub && <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#4a6070', marginTop:4 }}>{sub}</div>}
  </div>
);

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
interface PortfolioChartProps {
  snapshots: PortfolioSnapshot[];
  currentUSD: number | null;
  isMobile: boolean;
  loading: boolean;
}

export const PortfolioChart: FC<PortfolioChartProps> = ({ snapshots, currentUSD, isMobile, loading }) => {
  const [range, setRange]     = useState<'7d'|'30d'|'90d'|'all'>('30d');
  const [expanded, setExpanded] = useState(true);

  // Filter by range
  const filtered = useMemo(() => {
    const cutoff = range === 'all' ? '' :
      range === '7d'  ? daysAgo(7)  :
      range === '30d' ? daysAgo(30) : daysAgo(90);
    const base = cutoff ? snapshots.filter(s => s.snapshot_date >= cutoff) : snapshots;
    // Include today's live value if not already snapshotted today
    const todayStr = today();
    const hasToday = base.some(s => s.snapshot_date === todayStr);
    if (!hasToday && currentUSD !== null && currentUSD > 0) {
      return [...base, { wallet:'', snapshot_date: todayStr, total_usd: currentUSD, token_breakdown:[] }];
    }
    return base;
  }, [snapshots, range, currentUSD]);

  const points: ChartPoint[] = filtered.map(s => ({ date: s.snapshot_date, value: s.total_usd }));

  // ── Insights ──────────────────────────────────────────────────────────────
  const insights = useMemo(() => {
    if (points.length < 2) return null;
    const first = points[0].value;
    const last  = points[points.length - 1].value;
    const change     = last - first;
    const changePct  = first > 0 ? (change / first) * 100 : 0;
    const isUp       = change >= 0;
    const peak       = Math.max(...points.map(p => p.value));
    const peakDate   = points.find(p => p.value === peak)?.date ?? '';
    const trough     = Math.min(...points.map(p => p.value));
    const troughDate = points.find(p => p.value === trough)?.date ?? '';

    // "This day last week"
    const weekAgoStr = daysAgo(7);
    const weekAgoSnap = [...snapshots].reverse().find(s => s.snapshot_date <= weekAgoStr);
    const weekAgoUSD = weekAgoSnap?.total_usd ?? null;

    // "This day last month"
    const monthAgoStr = daysAgo(30);
    const monthAgoSnap = [...snapshots].reverse().find(s => s.snapshot_date <= monthAgoStr);
    const monthAgoUSD = monthAgoSnap?.total_usd ?? null;

    return { change, changePct, isUp, peak, peakDate, trough, troughDate, weekAgoUSD, monthAgoUSD };
  }, [points, snapshots]);

  // ── Top tokens by current USD ─────────────────────────────────────────────
  const latestSnap = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const topTokens = useMemo(() => {
    if (!latestSnap?.token_breakdown?.length) return [];
    return [...latestSnap.token_breakdown]
      .filter(t => t.usd > 0)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 6);
  }, [latestSnap]);

  // ── Token sparklines — per token across snapshots ─────────────────────────
  const tokenHistory = useMemo(() => {
    const map = new Map<string, { symbol: string; values: number[] }>();
    for (const s of filtered) {
      for (const t of (s.token_breakdown ?? [])) {
        if (!map.has(t.mint)) map.set(t.mint, { symbol: t.symbol, values: [] });
        map.get(t.mint)!.values.push(t.usd);
      }
    }
    return map;
  }, [filtered]);

  if (loading) return (
    <div style={{ padding:'24px 0', textAlign:'center' }}>
      <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#3a5060', letterSpacing:2 }}>
        LOADING HISTORY…
      </div>
    </div>
  );

  const noData = snapshots.length === 0;
  const color = insights?.isUp ?? true ? '#00c98d' : '#ff4466';

  return (
    <div className="pc-in" style={{
      background: 'linear-gradient(135deg,#0d1520,#0a1018)',
      border: '1px solid rgba(255,255,255,.06)',
      borderRadius: 16, marginBottom: 20, overflow: 'hidden',
    }}>

      {/* ── HEADER ── */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding: isMobile ? '14px 14px' : '16px 22px',
        borderBottom:'1px solid rgba(255,255,255,.04)',
        background:'rgba(255,255,255,.02)',
        flexWrap:'wrap', gap:10,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontFamily:'Orbitron,monospace', fontSize:isMobile?10:12, fontWeight:700,
            color:'#e0e8f0', letterSpacing:2 }}>PORTFOLIO HISTORY</span>
          {snapshots.length > 0 && (
            <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#3a5060',
              background:'rgba(255,255,255,.04)', border:'1px solid rgba(255,255,255,.08)',
              borderRadius:10, padding:'2px 8px' }}>
              {snapshots.length} {snapshots.length === 1 ? 'day' : 'days'}
            </span>
          )}
          {insights && (
            <span style={{
              fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700,
              color: insights.isUp ? '#00c98d' : '#ff4466',
              background: insights.isUp ? 'rgba(0,201,141,.08)' : 'rgba(255,68,102,.08)',
              border: `1px solid ${insights.isUp ? 'rgba(0,201,141,.2)' : 'rgba(255,68,102,.2)'}`,
              borderRadius:10, padding:'2px 8px',
            }}>
              {insights.isUp ? '▲' : '▼'} {Math.abs(insights.changePct).toFixed(1)}%
            </span>
          )}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          {(['7d','30d','90d','all'] as const).map(r => (
            <button key={r} type="button" onClick={() => setRange(r)} style={{
              padding:'4px 10px', fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
              letterSpacing:1, borderRadius:6, cursor:'pointer', transition:'all .15s', border:'none',
              background: range===r ? 'rgba(255,140,0,.15)' : 'transparent',
              color: range===r ? '#ff8c00' : '#3a5060',
              outline: range===r ? '1px solid rgba(255,140,0,.3)' : '1px solid transparent',
            }}>
              {r === 'all' ? 'ALL' : r.toUpperCase()}
            </button>
          ))}
          <button type="button" onClick={() => setExpanded(v => !v)} style={{
            background:'none', border:'none', color:'#3a5060', cursor:'pointer',
            fontFamily:'Orbitron,monospace', fontSize:9, padding:'4px 6px',
          }}>
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: isMobile ? '14px' : '20px 22px' }}>

          {/* ── NO DATA STATE ── */}
          {noData && (
            <div style={{ textAlign:'center', padding:'32px 20px' }}>
              <div style={{ fontSize:32, marginBottom:12, opacity:.3 }}>📈</div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#3a5060',
                letterSpacing:2, marginBottom:8 }}>
                HISTORY STARTS TODAY
              </div>
              <div style={{ fontFamily:'Sora,sans-serif', fontSize:12, color:'#3a5060',
                maxWidth:360, margin:'0 auto', lineHeight:1.7 }}>
                Your first snapshot is being saved right now. Come back tomorrow to
                see your balance over time chart start to fill in.
              </div>
            </div>
          )}

          {/* ── CHART ── */}
          {points.length >= 2 && (
            <div style={{ marginBottom:20 }}>
              {/* Current value header */}
              <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:14, flexWrap:'wrap' }}>
                {currentUSD !== null && (
                  <>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:isMobile?22:28,
                      fontWeight:900, color:'#e0e8f0', letterSpacing:1 }}>
                      {fmtUSD(currentUSD)}
                    </span>
                    {insights && (
                      <span style={{ fontFamily:'Orbitron,monospace', fontSize:11,
                        color: insights.isUp ? '#00c98d' : '#ff4466' }}>
                        {insights.isUp ? '+' : ''}{fmtUSD(insights.change)} ({insights.changePct >= 0 ? '+' : ''}{insights.changePct.toFixed(2)}%)
                      </span>
                    )}
                    <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#4a6070' }}>
                      vs {range === 'all' ? 'all time' : `last ${range}`}
                    </span>
                  </>
                )}
              </div>

              <LineChart points={points} color={color} height={isMobile ? 120 : 160} isMobile={isMobile} />
            </div>
          )}

          {/* Single data point — just show a dot hint */}
          {points.length === 1 && !noData && (
            <div style={{ textAlign:'center', padding:'20px', fontFamily:'Sora,sans-serif',
              fontSize:12, color:'#4a6070' }}>
              1 day recorded — come back tomorrow for your first chart line.
            </div>
          )}

          {/* ── INSIGHT CARDS ── */}
          {insights && (
            <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4,1fr)',
              gap:10, marginBottom: topTokens.length > 0 ? 20 : 0 }}>
              {insights.weekAgoUSD !== null && currentUSD !== null && (
                <InsightCard
                  icon="📅"
                  label="vs Last Week"
                  value={fmtUSD(currentUSD - insights.weekAgoUSD)}
                  sub={`Was ${fmtUSD(insights.weekAgoUSD)}`}
                  color={currentUSD >= insights.weekAgoUSD ? '#00c98d' : '#ff4466'}
                  delay={0}
                />
              )}
              {insights.monthAgoUSD !== null && currentUSD !== null && (
                <InsightCard
                  icon="🗓️"
                  label="vs Last Month"
                  value={fmtUSD(currentUSD - insights.monthAgoUSD)}
                  sub={`Was ${fmtUSD(insights.monthAgoUSD)}`}
                  color={currentUSD >= insights.monthAgoUSD ? '#00c98d' : '#ff4466'}
                  delay={0.05}
                />
              )}
              <InsightCard
                icon="⬆️"
                label="All-Time Peak"
                value={fmtUSD(insights.peak)}
                sub={fmtDateFull(insights.peakDate)}
                color="#ffb700"
                delay={0.1}
              />
              <InsightCard
                icon="⬇️"
                label="All-Time Low"
                value={fmtUSD(insights.trough)}
                sub={fmtDateFull(insights.troughDate)}
                color="#bf5af2"
                delay={0.15}
              />
            </div>
          )}

          {/* ── TOKEN BREAKDOWN ── */}
          {topTokens.length > 0 && (
            <div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#3a5060',
                letterSpacing:2, marginBottom:10 }}>TOP HOLDINGS (LATEST SNAPSHOT)</div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {topTokens.map((t, i) => {
                  const pct = latestSnap!.total_usd > 0 ? (t.usd / latestSnap!.total_usd) * 100 : 0;
                  const hist = tokenHistory.get(t.mint);
                  const colors = ['#ff8c00','#00d4ff','#00c98d','#bf5af2','#ffb700','#ff4466'];
                  const c = colors[i % colors.length];
                  return (
                    <div key={t.mint} style={{ display:'grid',
                      gridTemplateColumns: isMobile ? '80px 1fr 60px' : '90px 1fr 80px 80px',
                      gap:10, alignItems:'center', padding:'8px 12px',
                      background:'rgba(255,255,255,.02)', borderRadius:8,
                      border:'1px solid rgba(255,255,255,.04)' }}>

                      {/* Symbol */}
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:10,
                        fontWeight:700, color:c, overflow:'hidden', textOverflow:'ellipsis',
                        whiteSpace:'nowrap' }}>{t.symbol}</div>

                      {/* Bar */}
                      <div style={{ height:4, background:'rgba(255,255,255,.06)', borderRadius:2, overflow:'hidden' }}>
                        <div className="pc-bar" style={{ height:'100%', width:`${pct}%`,
                          background:`linear-gradient(90deg,${c}60,${c})`, borderRadius:2 }} />
                      </div>

                      {/* USD */}
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#e0e8f0',
                        textAlign:'right', fontWeight:700 }}>{fmtUSD(t.usd)}</div>

                      {/* Sparkline */}
                      {!isMobile && hist && hist.values.length > 1 && (
                        <div style={{ display:'flex', justifyContent:'flex-end' }}>
                          <TokenSparkline points={hist.values} color={c} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
};

// ─── SNAPSHOT HOOK — takes a snapshot silently once per day ──────────────────
export function useDailySnapshot(
  wallet:           string | null,
  totalUSD:         number | null,
  tokens:           SnapshotToken[],
  totalTokenCount:  number = 0,
) {
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTotalRef = useRef<number | null>(null);
  const savedRef     = useRef<number>(0);

  useEffect(() => {
    if (!wallet || totalUSD === null || totalUSD <= 0) return;
    // Wait until we have at least some tokens loaded from the chain
    if (totalTokenCount === 0) return;

    // Don't re-save same value this session
    if (savedRef.current === totalUSD) return;

    // Reset timer every time totalUSD changes (prices still loading)
    if (timerRef.current) clearTimeout(timerRef.current);
    lastTotalRef.current = totalUSD;

    timerRef.current = setTimeout(async () => {
      if (totalUSD !== lastTotalRef.current) return; // still changing
      if (totalTokenCount === 0) return;

      savedRef.current = totalUSD;
      try {
        const { upsertPortfolioSnapshot } = await import('../lib/supabase');
        await upsertPortfolioSnapshot({
          wallet,
          snapshot_date:   today(),
          total_usd:       totalUSD,
          token_breakdown: tokens, // save whatever prices we have at this point
        });
      } catch {}
    }, 8000);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [wallet, totalUSD, tokens.length, totalTokenCount]);
}