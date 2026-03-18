// src/pages/AnalyticsDashboard.tsx
// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS DASHBOARD — Admin-gated visitor analytics for x1brains.io
// Route: /x9b7r41ns/analytics
// ─────────────────────────────────────────────────────────────────────────────
import React, { FC, useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { TopBar, PageBackground, Footer } from '../components/UI';

const ADMIN_WALLET = '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC';

// ─── STYLES ──────────────────────────────────────────────────────────────────
(function () {
  if (typeof document === 'undefined') return;
  if (document.getElementById('an-styles')) return;
  const s = document.createElement('style');
  s.id = 'an-styles';
  s.textContent = `
    @keyframes an-fade    { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
    @keyframes an-bar     { from{width:0%} }
    @keyframes an-spin    { to{transform:rotate(360deg)} }
    @keyframes an-count   { from{opacity:0;transform:scale(.8)} to{opacity:1;transform:scale(1)} }
    @keyframes an-pulse   { 0%,100%{opacity:.5} 50%{opacity:1} }
    .an-in  { animation: an-fade .35s ease both; }
    .an-bar { animation: an-bar .7s cubic-bezier(.4,0,.2,1) both; }
  `;
  document.head.appendChild(s);
})();

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const PAGE_LABELS: Record<string, string> = {
  '/':                   '🏠 Home',
  '/portfolio':          '💼 Portfolio',
  '/burn-history':       '🔥 Burn History',
  '/rewards':            '🏆 Rewards',
  '/cyberdyne':          '⚔️ Cyberdyne',
  '/incinerator-engine': '☠️ Incinerator',
  '/mint':               '🪙 Mint',
  '/lab-work':           '🔬 Lab Work',
};

const EVENT_ICONS: Record<string, string> = {
  tab_click:        '🗂',
  wallet_connect:   '🔗',
  wallet_disconnect:'🔌',
  burn_tx_view:     '🔥',
  button_click:     '👆',
  auto:             '⚡',
};

const DAYS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const HOURS = Array.from({length:24}, (_,i) => String(i).padStart(2,'0'));

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const fmtN = (n: number) =>
  n >= 1_000_000 ? `${(n/1e6).toFixed(1)}M` :
  n >= 1_000     ? `${(n/1000).toFixed(1)}K` :
  n.toLocaleString();

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' +
         d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
};

// ─── REUSABLE COMPONENTS ─────────────────────────────────────────────────────

const Card: FC<{children: React.ReactNode; accent?: string; delay?: number; style?: React.CSSProperties}> = ({
  children, accent = 'rgba(140,60,255,.2)', delay = 0, style = {}
}) => (
  <div className="an-in" style={{
    animationDelay: `${delay}s`,
    position: 'relative', overflow: 'hidden',
    background: 'linear-gradient(145deg, #0d0b16, #09070f)',
    border: `1px solid ${accent}`,
    borderRadius: 16,
    boxShadow: '0 2px 20px rgba(0,0,0,.5)',
    ...style,
  }}>
    <div style={{ position:'absolute', inset:0, backgroundImage:'linear-gradient(rgba(255,255,255,.012) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.012) 1px,transparent 1px)', backgroundSize:'28px 28px', pointerEvents:'none' }} />
    <div style={{ position:'relative', zIndex:1 }}>{children}</div>
  </div>
);

const SectionTitle: FC<{icon:string; title:string; subtitle?:string; color?:string; badge?:string|number}> = ({
  icon, title, subtitle, color='#c4aaff', badge
}) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
      <span style={{ fontSize:18 }}>{icon}</span>
      <span style={{ fontFamily:'Orbitron,monospace', fontSize:13, fontWeight:800, color, letterSpacing:2 }}>{title}</span>
      {badge !== undefined && (
        <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color, background:`${color}15`, border:`1px solid ${color}30`, borderRadius:20, padding:'2px 10px' }}>
          {typeof badge === 'number' ? fmtN(badge) : badge}
        </span>
      )}
    </div>
    {subtitle && <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#6a7a8a', marginTop:5, paddingLeft:28 }}>{subtitle}</div>}
  </div>
);

const StatTile: FC<{icon:string; label:string; value:string|number; sub?:string; color:string; delay?:number}> = ({
  icon, label, value, sub, color, delay=0
}) => (
  <Card accent={`${color}25`} delay={delay} style={{ padding:'20px 22px' }}>
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
      <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#7a8a9a', fontWeight:500 }}>{label}</div>
      <span style={{ fontSize:20, opacity:.3 }}>{icon}</span>
    </div>
    <div style={{ fontFamily:'Orbitron,monospace', fontSize:30, fontWeight:900, color, letterSpacing:1, lineHeight:1, animation:'an-count .4s ease both' }}>
      {typeof value === 'number' ? fmtN(value) : value}
    </div>
    {sub && <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#4a5a6a', marginTop:8 }}>{sub}</div>}
  </Card>
);

const Bar: FC<{label:string; value:number; total:number; color:string; rank?:number}> = ({label,value,total,color,rank}) => {
  const pct = total > 0 ? (value/total)*100 : 0;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
      {rank !== undefined && (
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#3a4a5a', width:18, textAlign:'center', flexShrink:0 }}>{rank}</div>
      )}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:5 }}>
          <span style={{ fontFamily:'Sora,sans-serif', fontSize:12, color:'#c0ccd8', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:1, marginRight:8 }}>{label}</span>
          <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, color, flexShrink:0 }}>
            {fmtN(value)} <span style={{ color:'#3a4a5a', fontSize:9 }}>{pct.toFixed(1)}%</span>
          </span>
        </div>
        <div style={{ height:5, background:'rgba(255,255,255,.05)', borderRadius:3, overflow:'hidden' }}>
          <div className="an-bar" style={{ height:'100%', width:`${pct}%`, background:`linear-gradient(90deg,${color}60,${color})`, borderRadius:3 }} />
        </div>
      </div>
    </div>
  );
};

// ─── SPARKLINE SVG ────────────────────────────────────────────────────────────
const Sparkline: FC<{data:number[]; labels:string[]; color:string; height?:number}> = ({data,labels,color,height=100}) => {
  const max = Math.max(...data, 1);
  const W = 800, H = height;
  if (data.length < 2) return <div style={{height,display:'flex',alignItems:'center',justifyContent:'center',color:'#3a4a5a',fontFamily:'Sora,sans-serif',fontSize:11}}>Not enough data yet</div>;

  const xs = data.map((_,i) => (i/(data.length-1)) * W);
  const ys = data.map(v => H - (v/max)*(H-8) - 4);
  const line = xs.map((x,i) => `${x},${ys[i]}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;

  // Step labels — show every Nth
  const step = data.length <= 7 ? 1 : data.length <= 14 ? 2 : data.length <= 30 ? 5 : 10;
  const labelPoints = labels.map((l,i) => ({l, x:xs[i], show: i%step===0 || i===data.length-1}));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height,display:'block',overflow:'visible'}} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`sg-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={color} stopOpacity=".25" />
            <stop offset="100%" stopColor={color} stopOpacity="0"   />
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#sg-${color.replace('#','')})`} />
        <polyline points={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {/* Dot on last value */}
        <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r="4" fill={color} />
      </svg>
      <div style={{display:'flex',justifyContent:'space-between',marginTop:6,paddingTop:4,borderTop:'1px solid rgba(255,255,255,.04)'}}>
        {labelPoints.filter(p=>p.show).map((p,i)=>(
          <span key={i} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#3a4a5a'}}>{p.l}</span>
        ))}
      </div>
    </div>
  );
};

// ─── HEATMAP ─────────────────────────────────────────────────────────────────
const HeatMap: FC<{data:number[][]; maxVal:number; color:string}> = ({data,maxVal,color}) => (
  <div style={{overflowX:'auto'}}>
    <div style={{display:'grid', gridTemplateColumns:'32px repeat(24,1fr)', gap:3, minWidth:560}}>
      <div/>
      {HOURS.map((h,i)=>(
        <div key={i} style={{fontFamily:'Orbitron,monospace',fontSize:6,color:'#3a4a5a',textAlign:'center',paddingBottom:3}}>
          {Number(h)%6===0 ? h : ''}
        </div>
      ))}
      {DAYS.map((day,di)=>(
        <React.Fragment key={di}>
          <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#5a6a7a',display:'flex',alignItems:'center'}}>{day}</div>
          {Array.from({length:24},(_,hi)=>{
            const val = data[di]?.[hi] ?? 0;
            const pct = maxVal > 0 ? val/maxVal : 0;
            return (
              <div key={hi} title={`${day} ${HOURS[hi]}:00 — ${val} views`} style={{
                height:18, borderRadius:3,
                background: pct > 0 ? color : 'rgba(255,255,255,.03)',
                opacity: pct > 0 ? Math.max(.12, pct) : 1,
                cursor:'default', transition:'opacity .15s',
              }}/>
            );
          })}
        </React.Fragment>
      ))}
    </div>
    <div style={{display:'flex',alignItems:'center',gap:8,marginTop:10}}>
      <span style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#4a5a6a'}}>Less</span>
      <div style={{flex:1,height:4,background:`linear-gradient(90deg,${color}15,${color})`,borderRadius:2}}/>
      <span style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#4a5a6a'}}>More</span>
    </div>
  </div>
);

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
const AnalyticsDashboard: FC = () => {
  const {publicKey}              = useWallet();
  const {setVisible: openWallet} = useWalletModal();
  const navigate                 = useNavigate();
  const isAdmin = publicKey?.toBase58() === ADMIN_WALLET;

  const [views,    setViews]    = useState<any[]>([]);
  const [events,   setEvents]   = useState<any[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string|null>(null);
  const [range,    setRange]    = useState<'7d'|'30d'|'90d'|'all'>('30d');
  const [activeSection, setActiveSection] = useState<'overview'|'pages'|'audience'|'events'|'raw'>('overview');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(()=>{
    const h=()=>setIsMobile(window.innerWidth<768);
    window.addEventListener('resize',h);
    return ()=>window.removeEventListener('resize',h);
  },[]);

  useEffect(()=>{
    if(!isAdmin) return;
    setLoading(true); setError(null);
    (async()=>{
      try{
        const {getAllPageViews, getAllSiteEvents} = await import('../lib/supabase');
        const [v,e] = await Promise.all([getAllPageViews(), getAllSiteEvents().catch(()=>[])]);
        setViews(v); setEvents(e);
      }catch(e:any){ setError(e.message??'Failed to load'); }
      finally{ setLoading(false); }
    })();
  },[isAdmin]);

  // Date filter
  const cutoff = useMemo(()=>{
    if(range==='all') return 0;
    const d = range==='7d'?7:range==='30d'?30:90;
    return Date.now() - d*86_400_000;
  },[range]);

  const fViews  = useMemo(()=> cutoff>0 ? views.filter(v=>new Date(v.visited_at).getTime()>=cutoff) : views, [views,cutoff]);
  const fEvents = useMemo(()=> cutoff>0 ? events.filter(e=>new Date(e.fired_at).getTime()>=cutoff)  : events,[events,cutoff]);

  // ── Derived analytics ────────────────────────────────────────────────────
  const stats = useMemo(()=>{
    const totalViews     = fViews.length;
    const sessions       = new Set(fViews.map(v=>v.session_id));
    const uniqueVisitors = sessions.size;

    const sessDepth = new Map<string,number>();
    for(const v of fViews) sessDepth.set(v.session_id,(sessDepth.get(v.session_id)??0)+1);
    const avgDepth = sessDepth.size>0 ? [...sessDepth.values()].reduce((a,b)=>a+b,0)/sessDepth.size : 0;

    // Pages
    const pageMap = new Map<string,number>();
    for(const v of fViews) pageMap.set(v.path,(pageMap.get(v.path)??0)+1);
    const topPages = [...pageMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);

    // Geo
    const countryMap = new Map<string,number>();
    const cityMap    = new Map<string,number>();
    for(const v of fViews){
      if(v.country&&v.country!=='Unknown') countryMap.set(v.country,(countryMap.get(v.country)??0)+1);
      if(v.city&&v.city!=='Unknown'){
        const k = v.region ? `${v.city}, ${v.region}` : v.city;
        cityMap.set(k,(cityMap.get(k)??0)+1);
      }
    }
    const topCountries = [...countryMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
    const topCities    = [...cityMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8);

    // Device / Browser / OS
    const deviceMap  = new Map<string,number>();
    const browserMap = new Map<string,number>();
    const osMap      = new Map<string,number>();
    for(const v of fViews){
      if(v.device)  deviceMap.set(v.device,(deviceMap.get(v.device)??0)+1);
      if(v.browser) browserMap.set(v.browser,(browserMap.get(v.browser)??0)+1);
      if(v.os)      osMap.set(v.os,(osMap.get(v.os)??0)+1);
    }

    // Referrers
    const refMap = new Map<string,number>();
    for(const v of fViews) if(v.referrer) refMap.set(v.referrer,(refMap.get(v.referrer)??0)+1);
    const topRefs = [...refMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8);

    // Daily data — for sparkline
    const days = range==='7d'?7:range==='30d'?30:90;
    const dailyMap = new Map<string,number>();
    for(const v of fViews) dailyMap.set(v.visited_at.slice(0,10),(dailyMap.get(v.visited_at.slice(0,10))??0)+1);
    const dailyLabels:string[] = [];
    const dailyData:number[]   = [];
    for(let i=days-1;i>=0;i--){
      const d=new Date(Date.now()-i*86_400_000).toISOString().slice(0,10);
      dailyLabels.push(d.slice(5));
      dailyData.push(dailyMap.get(d)??0);
    }

    // Heatmap [day][hour]
    const heatData:number[][] = Array.from({length:7},()=>Array(24).fill(0));
    for(const v of fViews){
      const d=new Date(v.visited_at);
      heatData[d.getDay()][d.getHours()]++;
    }
    const heatMax = Math.max(...heatData.flat(),1);

    // Peak hour
    const hourMap = new Map<number,number>();
    for(const v of fViews) hourMap.set(new Date(v.visited_at).getHours(),(hourMap.get(new Date(v.visited_at).getHours())??0)+1);
    const peakHour = [...hourMap.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]??0;

    // Events breakdown
    const eventTypeMap = new Map<string,number>();
    const eventLabelMap = new Map<string,{count:number;type:string}>();
    for(const e of fEvents){
      eventTypeMap.set(e.event_type,(eventTypeMap.get(e.event_type)??0)+1);
      const key=`${e.event_type}::${e.label}`;
      const cur=eventLabelMap.get(key)??{count:0,type:e.event_type};
      eventLabelMap.set(key,{count:cur.count+1,type:e.event_type});
    }
    const topEventTypes  = [...eventTypeMap.entries()].sort((a,b)=>b[1]-a[1]);
    const topEventLabels = [...eventLabelMap.entries()].sort((a,b)=>b[1].count-a[1].count).slice(0,15);

    // Wallet stats
    const walletConnects    = fEvents.filter(e=>e.event_type==='wallet_connect').length;
    const walletDisconnects = fEvents.filter(e=>e.event_type==='wallet_disconnect').length;

    // Tab clicks breakdown
    const tabClickMap = new Map<string,number>();
    for(const e of fEvents.filter(e=>e.event_type==='tab_click'))
      tabClickMap.set(e.label,(tabClickMap.get(e.label)??0)+1);
    const topTabs = [...tabClickMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);

    return {
      totalViews, uniqueVisitors, avgDepth, topPages, topCountries, topCities,
      deviceMap, browserMap, osMap, topRefs,
      dailyLabels, dailyData, heatData, heatMax, peakHour,
      totalEvents: fEvents.length, topEventTypes, topEventLabels,
      walletConnects, walletDisconnects, topTabs,
    };
  },[fViews, fEvents, range]);

  // ── GATE SCREENS ─────────────────────────────────────────────────────────
  if(!publicKey) return (
    <div style={{minHeight:'100vh',background:'#080610',padding:'90px 24px 40px',position:'relative'}}>
      <TopBar /><PageBackground />
      <div style={{maxWidth:420,margin:'100px auto',textAlign:'center',animation:'an-fade .4s ease both'}}>
        <div style={{fontSize:52,marginBottom:20}}>📊</div>
        <h2 style={{fontFamily:'Orbitron,monospace',fontSize:22,fontWeight:900,color:'#c4aaff',letterSpacing:3,marginBottom:12}}>ANALYTICS</h2>
        <p style={{fontFamily:'Sora,sans-serif',fontSize:14,color:'#6a7a8a',lineHeight:1.7,marginBottom:28}}>Connect your admin wallet to view site analytics.</p>
        <button onClick={()=>openWallet(true)} style={{padding:'12px 32px',background:'linear-gradient(135deg,#cc88ff,#9933ff)',border:'none',borderRadius:12,color:'#fff',fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,letterSpacing:2,cursor:'pointer'}}>
          CONNECT WALLET
        </button>
      </div>
    </div>
  );

  if(!isAdmin) return (
    <div style={{minHeight:'100vh',background:'#080610',padding:'90px 24px 40px',position:'relative'}}>
      <TopBar /><PageBackground />
      <div style={{maxWidth:420,margin:'100px auto',textAlign:'center',animation:'an-fade .4s ease both'}}>
        <div style={{fontSize:52,marginBottom:20}}>🔒</div>
        <h2 style={{fontFamily:'Orbitron,monospace',fontSize:22,fontWeight:900,color:'#ff5577',letterSpacing:3,marginBottom:12}}>ACCESS DENIED</h2>
        <p style={{fontFamily:'Sora,sans-serif',fontSize:14,color:'#6a7a8a',marginBottom:28}}>Admin wallet required.</p>
        <button onClick={()=>navigate('/')} style={{padding:'12px 32px',background:'rgba(255,85,119,.1)',border:'1px solid rgba(255,85,119,.3)',borderRadius:12,color:'#ff5577',fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,letterSpacing:2,cursor:'pointer'}}>← BACK HOME</button>
      </div>
    </div>
  );

  // ── NAV TABS ──────────────────────────────────────────────────────────────
  const sections = [
    {k:'overview', l:'📈 Overview'},
    {k:'pages',    l:'📄 Pages'},
    {k:'audience', l:'🌍 Audience'},
    {k:'events',   l:'⚡ Events'},
    {k:'raw',      l:'📋 Raw Data'},
  ] as const;

  const P = isMobile ? '70px 14px 40px' : '90px 32px 60px';

  return (
    <div style={{minHeight:'100vh', background:'linear-gradient(180deg,#07050e 0%,#090811 100%)', padding:P, position:'relative'}}>
      <TopBar /><PageBackground />

      <div style={{position:'relative',zIndex:1,maxWidth:1080,margin:'0 auto'}}>

        {/* ── HEADER ── */}
        <div className="an-in" style={{marginBottom:32,textAlign:'center'}}>
          <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#4a5a6a',letterSpacing:3,marginBottom:8,textTransform:'uppercase'}}>x1brains.io</div>
          <h1 style={{
            fontFamily:'Orbitron,monospace', fontSize:isMobile?26:38, fontWeight:900,
            letterSpacing:4, margin:'0 0 10px',
            background:'linear-gradient(135deg,#c4aaff 0%,#ff9966 50%,#66ffcc 100%)',
            WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent',
          }}>Site Analytics</h1>
          <p style={{fontFamily:'Sora,sans-serif',fontSize:13,color:'#5a6a7a',maxWidth:480,margin:'0 auto'}}>
            {views.length > 0
              ? `${fmtN(views.length)} page views · ${fmtN(new Set(views.map(v=>v.session_id)).size)} unique visitors · ${events.length > 0 ? `${fmtN(events.length)} tracked events` : 'events loading…'}`
              : 'Loading analytics data…'}
          </p>
        </div>

        {/* ── CONTROLS ── */}
        <div style={{display:'flex',gap:8,justifyContent:'center',marginBottom:28,flexWrap:'wrap'}}>
          {(['7d','30d','90d','all'] as const).map(r=>(
            <button key={r} onClick={()=>setRange(r)} style={{
              padding:'8px 20px', fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700,
              letterSpacing:2, borderRadius:10, cursor:'pointer', transition:'all .2s',
              background: range===r ? 'linear-gradient(135deg,#c4aaff,#8844ee)' : 'rgba(196,170,255,.06)',
              border: `1px solid ${range===r ? 'rgba(196,170,255,.6)' : 'rgba(196,170,255,.15)'}`,
              color: range===r ? '#fff' : '#8877aa',
            }}>
              {r==='all' ? 'ALL TIME' : `LAST ${r.toUpperCase()}`}
            </button>
          ))}
          <button onClick={()=>navigate('/x9b7r41ns/ctrl')} style={{
            padding:'8px 20px', fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700,
            letterSpacing:2, borderRadius:10, cursor:'pointer',
            background:'rgba(57,255,136,.06)', border:'1px solid rgba(57,255,136,.2)', color:'#39ff88',
          }}>← ADMIN</button>
        </div>

        {/* ── SECTION TABS ── */}
        <div style={{display:'flex',gap:4,marginBottom:24,background:'rgba(255,255,255,.03)',borderRadius:14,padding:5,flexWrap:'wrap'}}>
          {sections.map(s=>(
            <button key={s.k} onClick={()=>setActiveSection(s.k)} style={{
              flex:1, minWidth:isMobile?'40%':0,
              padding:'9px 12px', fontFamily:'Sora,sans-serif', fontSize:isMobile?10:11, fontWeight:600,
              borderRadius:10, cursor:'pointer', transition:'all .2s', border:'none',
              background: activeSection===s.k ? 'rgba(196,170,255,.15)' : 'transparent',
              color: activeSection===s.k ? '#c4aaff' : '#5a6a7a',
              borderBottom: activeSection===s.k ? '2px solid #c4aaff' : '2px solid transparent',
            }}>{s.l}</button>
          ))}
        </div>

        {/* ── LOADING / ERROR ── */}
        {loading && (
          <div style={{textAlign:'center',padding:'60px 20px'}}>
            <div style={{width:36,height:36,border:'3px solid rgba(196,170,255,.15)',borderTop:'3px solid #c4aaff',borderRadius:'50%',animation:'an-spin .8s linear infinite',margin:'0 auto 16px'}}/>
            <p style={{fontFamily:'Sora,sans-serif',fontSize:13,color:'#6a7a8a'}}>Loading analytics…</p>
          </div>
        )}
        {error && (
          <div style={{padding:'16px 20px',background:'rgba(255,80,80,.06)',border:'1px solid rgba(255,80,80,.2)',borderRadius:12,marginBottom:20,fontFamily:'Sora,sans-serif',fontSize:13,color:'#ff8888'}}>
            ⚠️ {error}
          </div>
        )}
        {!loading && fViews.length===0 && !error && (
          <div style={{textAlign:'center',padding:'80px 20px'}}>
            <div style={{fontSize:48,marginBottom:16,opacity:.3}}>📊</div>
            <p style={{fontFamily:'Sora,sans-serif',fontSize:14,color:'#4a5a6a',lineHeight:1.7}}>
              No data for this period yet.<br/>Visitors will appear here once the tracking hook is deployed.
            </p>
          </div>
        )}

        {!loading && fViews.length > 0 && (<>

          {/* ════════════════════════════════════════════════
              OVERVIEW TAB
          ════════════════════════════════════════════════ */}
          {activeSection==='overview' && (<>

            {/* KPI tiles */}
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(4,1fr)',gap:14,marginBottom:24}}>
              <StatTile icon="👁️" label="Page Views"      value={stats.totalViews}    color="#c4aaff" delay={0}    sub={`${range==='all'?'all time':`last ${range}`}`} />
              <StatTile icon="👤" label="Unique Visitors"  value={stats.uniqueVisitors} color="#ff9966" delay={.05} sub="by session ID" />
              <StatTile icon="📄" label="Avg Pages/Session" value={stats.avgDepth.toFixed(1)} color="#66ffcc" delay={.1} sub="session depth" />
              <StatTile icon="🕐" label="Peak Hour"        value={`${String(stats.peakHour).padStart(2,'0')}:00`} color="#ffcc55" delay={.15} sub="most active time" />
            </div>

            {/* Daily sparkline */}
            <Card accent="rgba(196,170,255,.2)" delay={.2} style={{padding:'24px 28px',marginBottom:20}}>
              <SectionTitle icon="📈" title="Daily Traffic" subtitle={`Views per day over the last ${range==='all'?'90':range.replace('d',' days')}`} color="#c4aaff" />
              <Sparkline data={stats.dailyData} labels={stats.dailyLabels} color="#c4aaff" height={90} />
              <div style={{display:'flex',gap:28,marginTop:16,flexWrap:'wrap'}}>
                <div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#4a5a6a',marginBottom:3}}>Peak day</div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:900,color:'#c4aaff'}}>{fmtN(Math.max(...stats.dailyData))}</div>
                </div>
                <div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#4a5a6a',marginBottom:3}}>Daily avg</div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:900,color:'#ff9966'}}>
                    {fmtN(Math.round(stats.dailyData.reduce((a,b)=>a+b,0)/Math.max(1,stats.dailyData.filter(v=>v>0).length)))}
                  </div>
                </div>
                <div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#4a5a6a',marginBottom:3}}>Total events</div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:900,color:'#66ffcc'}}>{fmtN(stats.totalEvents)}</div>
                </div>
                <div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#4a5a6a',marginBottom:3}}>Wallet connects</div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:900,color:'#ffcc55'}}>{fmtN(stats.walletConnects)}</div>
                </div>
              </div>
            </Card>

            {/* Heatmap */}
            <Card accent="rgba(102,255,204,.15)" delay={.25} style={{padding:'24px 28px',marginBottom:20}}>
              <SectionTitle icon="🌡️" title="Activity Heatmap" subtitle="Which day and hour gets the most traffic" color="#66ffcc" />
              <HeatMap data={stats.heatData} maxVal={stats.heatMax} color="#66ffcc" />
            </Card>

          </>)}

          {/* ════════════════════════════════════════════════
              PAGES TAB
          ════════════════════════════════════════════════ */}
          {activeSection==='pages' && (<>

            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'2fr 1fr',gap:16,marginBottom:20}}>

              <Card accent="rgba(255,153,102,.2)" style={{padding:'24px 28px'}}>
                <SectionTitle icon="📄" title="Top Pages" subtitle="Most visited pages by view count" color="#ff9966" badge={stats.topPages.length} />
                {stats.topPages.map(([path,count],i)=>(
                  <Bar key={path} label={PAGE_LABELS[path]??path} value={count} total={stats.totalViews} color="#ff9966" rank={i+1} />
                ))}
              </Card>

              <Card accent="rgba(255,204,85,.2)" style={{padding:'24px 28px'}}>
                <SectionTitle icon="🔗" title="Traffic Sources" subtitle="Where visitors come from" color="#ffcc55" />
                {stats.topRefs.length===0
                  ? <p style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#4a5a6a'}}>No referrer data yet</p>
                  : stats.topRefs.map(([ref,count],i)=>(
                      <Bar key={ref} label={ref==='direct'?'🔗 Direct / Bookmark':ref} value={count} total={stats.totalViews} color="#ffcc55" rank={i+1} />
                    ))
                }
              </Card>
            </div>

          </>)}

          {/* ════════════════════════════════════════════════
              AUDIENCE TAB
          ════════════════════════════════════════════════ */}
          {activeSection==='audience' && (<>

            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:16,marginBottom:16}}>
              <Card accent="rgba(102,255,204,.2)" style={{padding:'24px 28px'}}>
                <SectionTitle icon="🌍" title="Countries" color="#66ffcc" badge={stats.topCountries.length} />
                {stats.topCountries.length===0
                  ? <p style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#4a5a6a'}}>No geo data yet</p>
                  : stats.topCountries.map(([c,n],i)=><Bar key={c} label={c} value={n} total={stats.totalViews} color="#66ffcc" rank={i+1}/>)
                }
              </Card>
              <Card accent="rgba(0,204,255,.2)" style={{padding:'24px 28px'}}>
                <SectionTitle icon="🏙️" title="Cities" color="#00ccff" badge={stats.topCities.length} />
                {stats.topCities.length===0
                  ? <p style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#4a5a6a'}}>No city data yet</p>
                  : stats.topCities.map(([c,n],i)=><Bar key={c} label={c} value={n} total={stats.totalViews} color="#00ccff" rank={i+1}/>)
                }
              </Card>
            </div>

            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr 1fr',gap:16,marginBottom:16}}>
              <Card accent="rgba(191,90,242,.2)" style={{padding:'24px 28px'}}>
                <SectionTitle icon="📱" title="Devices" color="#bf5af2" />
                {[...stats.deviceMap.entries()].sort((a,b)=>b[1]-a[1]).map(([d,c])=>(
                  <Bar key={d} label={d==='desktop'?'🖥️ Desktop':d==='mobile'?'📱 Mobile':'📟 Tablet'} value={c} total={stats.totalViews} color="#bf5af2"/>
                ))}
              </Card>
              <Card accent="rgba(255,140,0,.2)" style={{padding:'24px 28px'}}>
                <SectionTitle icon="🌐" title="Browsers" color="#ff8c00" />
                {[...stats.browserMap.entries()].sort((a,b)=>b[1]-a[1]).map(([b,c])=>(
                  <Bar key={b} label={b} value={c} total={stats.totalViews} color="#ff8c00"/>
                ))}
              </Card>
              <Card accent="rgba(57,255,136,.2)" style={{padding:'24px 28px'}}>
                <SectionTitle icon="💻" title="Operating Systems" color="#39ff88" />
                {[...stats.osMap.entries()].sort((a,b)=>b[1]-a[1]).map(([o,c])=>(
                  <Bar key={o} label={o} value={c} total={stats.totalViews} color="#39ff88"/>
                ))}
              </Card>
            </div>

          </>)}

          {/* ════════════════════════════════════════════════
              EVENTS TAB
          ════════════════════════════════════════════════ */}
          {activeSection==='events' && (<>

            {fEvents.length===0
              ? (
                <Card accent="rgba(196,170,255,.15)" style={{padding:'40px 28px',textAlign:'center'}}>
                  <div style={{fontSize:44,marginBottom:16,opacity:.3}}>⚡</div>
                  <p style={{fontFamily:'Sora,sans-serif',fontSize:14,color:'#5a6a7a',lineHeight:1.8,maxWidth:480,margin:'0 auto'}}>
                    No events tracked yet.<br/>
                    Events fire automatically once the updated <code style={{color:'#c4aaff',fontFamily:'monospace',fontSize:12}}>usePageView.ts</code> is deployed.<br/>
                    Tracked: tab clicks, wallet connects, burn tx views, button clicks.
                  </p>
                </Card>
              )
              : (<>
                {/* Event type KPIs */}
                <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'repeat(3,1fr)',gap:12,marginBottom:20}}>
                  <StatTile icon="⚡" label="Total Events"     value={stats.totalEvents}       color="#c4aaff" />
                  <StatTile icon="🔗" label="Wallet Connects"  value={stats.walletConnects}     color="#66ffcc" />
                  <StatTile icon="🗂" label="Tab Clicks"       value={stats.topEventTypes.find(([t])=>t==='tab_click')?.[1]??0}  color="#ff9966" />
                </div>

                <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:16,marginBottom:16}}>

                  <Card accent="rgba(196,170,255,.2)" style={{padding:'24px 28px'}}>
                    <SectionTitle icon="📊" title="Event Types" subtitle="Breakdown by interaction type" color="#c4aaff" />
                    {stats.topEventTypes.map(([type,count])=>(
                      <Bar key={type} label={`${EVENT_ICONS[type]??'•'} ${type.replace(/_/g,' ')}`} value={count} total={stats.totalEvents} color="#c4aaff" />
                    ))}
                  </Card>

                  <Card accent="rgba(255,153,102,.2)" style={{padding:'24px 28px'}}>
                    <SectionTitle icon="🗂" title="Top Tab Clicks" subtitle="Which tabs get clicked most" color="#ff9966" />
                    {stats.topTabs.length===0
                      ? <p style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#4a5a6a'}}>No tab click data yet</p>
                      : stats.topTabs.map(([tab,count],i)=>(
                          <Bar key={tab} label={tab} value={count} total={stats.topEventTypes.find(([t])=>t==='tab_click')?.[1]??1} color="#ff9966" rank={i+1} />
                        ))
                    }
                  </Card>
                </div>

                <Card accent="rgba(102,255,204,.15)" style={{padding:'24px 28px',marginBottom:20}}>
                  <SectionTitle icon="🏆" title="Top Event Labels" subtitle="Most triggered individual interactions" color="#66ffcc" badge={stats.topEventLabels.length} />
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:'0 24px'}}>
                    {stats.topEventLabels.map(([key,{count,type}],i)=>{
                      const label = key.split('::')[1] ?? key;
                      return <Bar key={key} label={`${EVENT_ICONS[type]??'•'} ${label}`} value={count} total={stats.totalEvents} color="#66ffcc" rank={i+1} />;
                    })}
                  </div>
                </Card>

                {/* Recent events */}
                <Card accent="rgba(196,170,255,.15)" style={{padding:'24px 28px'}}>
                  <SectionTitle icon="🕐" title="Recent Events" subtitle="Last 30 tracked interactions" color="#c4aaff" />
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'Sora,sans-serif',fontSize:11}}>
                      <thead>
                        <tr style={{borderBottom:'1px solid rgba(196,170,255,.1)'}}>
                          {['TIME','TYPE','CATEGORY','LABEL','PAGE'].map(h=>(
                            <th key={h} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#c4aaff',letterSpacing:1,padding:'6px 10px',textAlign:'left',fontWeight:700,whiteSpace:'nowrap'}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {fEvents.slice(0,30).map((e,i)=>(
                          <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.03)',background:i%2===0?'rgba(196,170,255,.02)':'transparent'}}>
                            <td style={{padding:'5px 10px',color:'#5a6a7a',whiteSpace:'nowrap',fontSize:10}}>{fmtTime(e.fired_at)}</td>
                            <td style={{padding:'5px 10px',color:'#c4aaff',whiteSpace:'nowrap'}}>{EVENT_ICONS[e.event_type]??'•'} {e.event_type?.replace(/_/g,' ')}</td>
                            <td style={{padding:'5px 10px',color:'#7a8a9a'}}>{e.category}</td>
                            <td style={{padding:'5px 10px',color:'#d0c0e8',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.label}</td>
                            <td style={{padding:'5px 10px',color:'#ff9966',fontSize:10}}>{PAGE_LABELS[e.path]??e.path}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </>)
            }

          </>)}

          {/* ════════════════════════════════════════════════
              RAW DATA TAB
          ════════════════════════════════════════════════ */}
          {activeSection==='raw' && (
            <Card accent="rgba(196,170,255,.15)" style={{padding:'24px 28px'}}>
              <SectionTitle icon="📋" title="Raw Page Views" subtitle={`Showing 50 of ${fmtN(fViews.length)} records`} color="#c4aaff" badge={fViews.length} />
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontFamily:'Sora,sans-serif',fontSize:isMobile?9:11}}>
                  <thead>
                    <tr style={{borderBottom:'1px solid rgba(196,170,255,.1)'}}>
                      {['TIME','PAGE','COUNTRY','CITY','DEVICE','BROWSER','OS','SOURCE'].map(h=>(
                        <th key={h} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#c4aaff',letterSpacing:1,padding:'6px 10px',textAlign:'left',fontWeight:700,whiteSpace:'nowrap'}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fViews.slice(0,50).map((v,i)=>(
                      <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,.03)',background:i%2===0?'rgba(196,170,255,.02)':'transparent'}}>
                        <td style={{padding:'6px 10px',color:'#5a6a7a',whiteSpace:'nowrap',fontSize:10}}>{fmtTime(v.visited_at)}</td>
                        <td style={{padding:'6px 10px',color:'#ff9966',whiteSpace:'nowrap'}}>{PAGE_LABELS[v.path]??v.path}</td>
                        <td style={{padding:'6px 10px',color:'#66ffcc'}}>{v.country??'—'}</td>
                        <td style={{padding:'6px 10px',color:'#c0ccd8'}}>{v.city??'—'}</td>
                        <td style={{padding:'6px 10px',color:'#bf5af2'}}>{v.device??'—'}</td>
                        <td style={{padding:'6px 10px',color:'#ff8c00'}}>{v.browser??'—'}</td>
                        <td style={{padding:'6px 10px',color:'#39ff88'}}>{v.os??'—'}</td>
                        <td style={{padding:'6px 10px',color:'#ffcc55',maxWidth:120,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v.referrer??'direct'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {fViews.length>50 && (
                <p style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#4a5a6a',textAlign:'center',marginTop:14}}>
                  Showing 50 of {fmtN(fViews.length)} — narrow the date range to see specific periods
                </p>
              )}
            </Card>
          )}

        </>)}

        <div style={{marginTop:40}}><Footer /></div>
      </div>
    </div>
  );
};

export default AnalyticsDashboard;