// src/pages/RewardsSeason.tsx — PUBLIC Weekly Burn Challenge + Lab Work Dashboard
import React, { FC, useEffect, useState, useRef, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { useNavigate } from 'react-router-dom';
import { BRAINS_MINT, BRAINS_LOGO } from '../constants';
import { TopBar, PageBackground, Footer } from '../components/UI';
import { fetchLeaderboard, getCachedLeaderboard } from '../components/BurnLeaderboard';
import type { BurnerEntry } from '../components/BurnLeaderboard';

// ─── PODIUM PROFILE IMAGES ──────────────────────────────────────────────────
import podium1st from '../assets/images1st.jpg';
import podium2nd from '../assets/images2nd.jpg';
import podium3rd from '../assets/images3rd.png';

const PODIUM_IMAGES: Record<number, { src: string; scale: number }> = {
  1: { src: podium1st, scale: 1.35 },
  2: { src: podium2nd, scale: 1.3 },
  3: { src: podium3rd, scale: 1.0 },
};

(function(){if(typeof document==='undefined')return;if(document.getElementById('rw-s'))return;
const s=document.createElement('style');s.id='rw-s';s.textContent=`
@keyframes rw-fade{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes rw-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes rw-glow{0%,100%{box-shadow:0 0 10px rgba(140,60,255,.2)}50%{box-shadow:0 0 25px rgba(140,60,255,.45)}}
@keyframes rw-scan{0%{left:-38%}100%{left:120%}}
@keyframes rw-cd{0%,100%{text-shadow:0 0 8px rgba(255,140,0,.3)}50%{text-shadow:0 0 18px rgba(255,140,0,.6)}}
@keyframes rw-shimmer{0%{transform:translateX(-120%)}100%{transform:translateX(500%)}}
@keyframes rw-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes rw-bar-fill{from{width:0%}}
@keyframes rw-gold-glow{0%,100%{box-shadow:0 0 10px rgba(255,215,0,.3)}50%{box-shadow:0 0 30px rgba(255,215,0,.6)}}
@keyframes rw-purple-glow{0%,100%{box-shadow:0 0 8px rgba(140,60,255,.3)}50%{box-shadow:0 0 18px rgba(140,60,255,.5)}}
@keyframes rw-green-pulse{0%,100%{opacity:.5;box-shadow:0 0 6px #39ff88}50%{opacity:1;box-shadow:0 0 14px #39ff88}}
@keyframes rw-row-in{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
@keyframes rw-lb-glow{0%,100%{box-shadow:0 0 15px rgba(0,204,255,.2),inset 0 0 30px rgba(0,204,255,.03)}50%{box-shadow:0 0 35px rgba(0,204,255,.4),inset 0 0 50px rgba(0,204,255,.06)}}
@keyframes rw-lb-shine{0%{background-position:200% center}100%{background-position:-200% center}}
@keyframes rw-lb-float{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-6px) scale(1.02)}}
@keyframes rw-lb-count{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1)}}
@keyframes rw-lb-border{0%,100%{border-color:rgba(0,204,255,.2)}50%{border-color:rgba(0,204,255,.5)}}
@keyframes rw-tab-glow{0%,100%{box-shadow:0 0 20px rgba(140,60,255,.15)}50%{box-shadow:0 0 40px rgba(140,60,255,.3)}}
@keyframes rw-dash-pulse{0%,100%{opacity:.7}50%{opacity:1}}
@keyframes rw-blue-neon{0%,100%{box-shadow:0 0 8px rgba(0,204,255,.15),0 0 20px rgba(0,204,255,.08),inset 0 0 20px rgba(0,204,255,.03);border-color:rgba(0,204,255,.2)}50%{box-shadow:0 0 16px rgba(0,204,255,.35),0 0 40px rgba(0,204,255,.15),inset 0 0 30px rgba(0,204,255,.05);border-color:rgba(0,204,255,.45)}}
`;document.head.appendChild(s);})();

const ADMIN_WALLET='2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC';
const TIER_AMPS=[0,1.50,3.50,5.50,8.88];
const TK:Record<string,{c:string;logo:string}>={BRAINS:{c:'#ff9933',logo:BRAINS_LOGO},XNM:{c:'#39ff88',logo:'https://explorer.xenblocks.io/tokens/xnm.png'},XUNI:{c:'#00e5ff',logo:'https://explorer.xenblocks.io/tokens/xuni.png'},XBLK:{c:'#b388ff',logo:'https://explorer.xenblocks.io/tokens/xblk.png'},XNT:{c:'#00ccff',logo:''}};
const EXPLORER='https://explorer.mainnet.x1.xyz/tx/';

interface PrizeItem{token:string;amount:number;nftMint?:string;nftName?:string;nftImage?:string;isNFT?:boolean;}
interface Challenge{id:string;title:string;description:string;tier:1|2|3|4;type:string;target:number;icon:string;}
interface Winner{address:string;prizes:PrizeItem[];ampPct:number;weeklyPts:number;place:number;weeklyBurned?:number;}
interface SendReceipt{place:number;wallet:string;items:PrizeItem[];txSig:string;timestamp:string;}
interface WConfig{weekId:string;startDate:string;endDate:string;challenges:Challenge[];prizes:[PrizeItem[],PrizeItem[],PrizeItem[]];status:string;winners?:Winner[];sendReceipts?:SendReceipt[];}
interface Ann{id:string;date:string;title:string;message:string;type:string;}
interface ChallengeLog{weekId:string;startDate:string;endDate:string;stoppedAt:string;challenges:Challenge[];winners?:Winner[];prizes:[PrizeItem[],PrizeItem[],PrizeItem[]];sendReceipts?:SendReceipt[];}

function loadJ(k:string,f:any):any{try{const v=localStorage.getItem(k);if(!v)return f;return JSON.parse(v)??f;}catch{return f;}}
import { usePrice } from '../components/TokenComponents';

const short=(a:string)=>a.length>10?`${a.slice(0,4)}…${a.slice(-4)}`:a;
const fmtN=(n:number,d=2)=>n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtPts=(n:number)=>n>=1_000_000?`${(n/1e6).toFixed(2)}M`:n>=1_000?`${(n/1000).toFixed(1)}K`:n.toLocaleString();

const TIER_CFG:Record<number,{label:string;color:string;bg:string;border:string;glow:string}>={
  1:{label:'TIER 1',color:'#39ff88',bg:'rgba(57,255,136,.04)',border:'rgba(57,255,136,.2)',glow:'rgba(57,255,136,.15)'},
  2:{label:'TIER 2',color:'#ffcc55',bg:'rgba(255,204,85,.04)',border:'rgba(255,204,85,.2)',glow:'rgba(255,204,85,.15)'},
  3:{label:'TIER 3',color:'#ff5500',bg:'rgba(255,85,0,.04)',border:'rgba(255,85,0,.2)',glow:'rgba(255,85,0,.15)'},
  4:{label:'TIER 4',color:'#cc00ff',bg:'rgba(204,0,255,.04)',border:'rgba(204,0,255,.2)',glow:'rgba(204,0,255,.15)'},
};

const challengeTargetLabel=(type:string,target:number)=>{
  if(type==='burn_amount')return `Burn ${fmtN(target,0)}+ BRAINS total`;
  if(type==='burn_txcount')return `Complete ${target} burn transactions`;
  if(type==='burn_exact')return `Burn exactly ${fmtN(target,0)} BRAINS in one tx`;
  if(type==='burn_streak')return `Burn on ${target} different days this week`;
  return `Target: ${target}`;
};

function useCountdown(end:string,active:boolean){const[l,setL]=useState('');useEffect(()=>{if(!end||!active){setL('—');return;}const u=()=>{const d=new Date(end).getTime()-Date.now();if(d<=0){setL("TIME'S UP");return;}setL(`${Math.floor(d/864e5)}d ${Math.floor((d%864e5)/36e5)}h ${Math.floor((d%36e5)/6e4)}m ${Math.floor((d%6e4)/1e3)}s`);};u();const id=setInterval(u,1000);return()=>clearInterval(id);},[end,active]);return l;}

const TkLogo:FC<{t:string;s?:number}>=({t,s=14})=>{const m=TK[t];if(!m||!m.logo)return <span style={{fontSize:s*.7}}>{t==='XNT'?'💎':'🪙'}</span>;return <img src={m.logo} alt="" style={{width:s,height:s,borderRadius:'50%',objectFit:'cover',border:`1px solid ${m.c}44`,background:'#111820'}} />;};
const BrainsLogo:FC<{size?:number}>=({size=14})=>(<img src={BRAINS_LOGO} alt="" style={{width:size,height:size,borderRadius:'50%',objectFit:'cover',border:'1px solid rgba(255,140,0,.35)',background:'#111820',flexShrink:0}} />);
const ScanLine:FC=()=>(<div style={{position:'absolute',top:0,left:0,width:'38%',height:'100%',background:'linear-gradient(90deg,transparent,rgba(140,60,255,.04),transparent)',animation:'rw-scan 8s linear infinite',pointerEvents:'none'}} />);
const GridBg:FC=()=>(<div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(rgba(100,60,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.025) 1px,transparent 1px)',backgroundSize:'24px 24px',pointerEvents:'none'}} />);
const pan=(g?:string):React.CSSProperties=>({position:'relative',overflow:'hidden',background:'linear-gradient(160deg,#04060f 0%,#07050e 50%,#050a12 100%)',border:`1px solid ${g||'rgba(120,60,255,.15)'}`,borderTop:`2px solid ${g||'rgba(140,60,255,.35)'}`,borderRadius:16,marginBottom:20});

const ReceiptCard:FC<{receipt:SendReceipt;brainsPrice:number|null;xntPrice:number|null;isMobile:boolean}>=({receipt,brainsPrice,xntPrice,isMobile})=>{
  const cl=receipt.place===0?'#ffd700':receipt.place===1?'#cc88ff':'#39ff88';
  const medal=['🥇','🥈','🥉'][receipt.place];
  const placeLabel=['1ST','2ND','3RD'][receipt.place];
  let usdTotal=0;
  for(const it of receipt.items){
    if(it.isNFT) continue;
    if(it.token==='BRAINS'&&brainsPrice) usdTotal+=it.amount*brainsPrice;
    else if(it.token==='XNT'&&xntPrice) usdTotal+=it.amount*xntPrice;
  }
  return(
    <div style={{padding:'12px 14px',background:`${cl}06`,border:`1px solid ${cl}20`,borderRadius:10,marginBottom:8}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8,flexWrap:'wrap',gap:6}}>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <span style={{fontSize:18}}>{medal}</span>
          <span style={{fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:cl,letterSpacing:2}}>{placeLabel} PLACE</span>
        </div>
        <span style={{fontFamily:'monospace',fontSize:10,color:'#b0c4cc'}}>{short(receipt.wallet)}</span>
      </div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:8}}>
        {receipt.items.map((p,j)=>p.isNFT?(
          <span key={j} style={{display:'flex',alignItems:'center',gap:3,fontFamily:'Orbitron,monospace',fontSize:9,color:'#ee99ff',padding:'3px 8px',background:'rgba(238,85,255,.06)',border:'1px solid rgba(255,215,0,.15)',borderRadius:5}}>{p.nftImage?<img src={p.nftImage} alt="" style={{width:14,height:14,borderRadius:3}}/>:<span>🖼️</span>} {p.nftName||'NFT'}</span>
        ):(
          <span key={j} style={{display:'flex',alignItems:'center',gap:3,fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:TK[p.token]?.c||'#fff',padding:'3px 8px',background:`${TK[p.token]?.c||'#fff'}08`,border:`1px solid ${TK[p.token]?.c||'#fff'}20`,borderRadius:5}}><TkLogo t={p.token} s={12} />{fmtN(p.amount,2)} {p.token}</span>
        ))}
      </div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:6}}>
        {usdTotal>0&&<span style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#39ff88',textShadow:'0 0 8px rgba(57,255,136,.3)'}}>≈ ${usdTotal>=1000?`${(usdTotal/1000).toFixed(2)}K`:usdTotal.toFixed(2)} USD</span>}
        <a href={`${EXPLORER}${receipt.txSig}`} target="_blank" rel="noopener noreferrer" style={{display:'inline-flex',alignItems:'center',gap:4,fontFamily:'Orbitron,monospace',fontSize:8,color:'#aa77ff',textDecoration:'none',padding:'4px 10px',background:'rgba(140,60,255,.08)',border:'1px solid rgba(140,60,255,.25)',borderRadius:5,letterSpacing:1}}>↗ VERIFY ON EXPLORER</a>
        <span style={{fontFamily:'Sora,sans-serif',fontSize:8,color:'#7a8a9a'}}>{new Date(receipt.timestamp).toLocaleString()}</span>
      </div>
    </div>
  );
};

const LbRow:FC<{entry:BurnerEntry;rank:number;isYou:boolean;isMobile:boolean;delay:number;totalAmp?:number}>=({entry,rank,isYou,isMobile,delay,totalAmp=0})=>{
  const basePts=entry.points;const ampBonus=totalAmp>0?Math.floor(basePts*(totalAmp/100)):0;const finalPts=basePts+ampBonus;
  return(
  <div style={{display:'grid',gridTemplateColumns:isMobile?'30px 1fr 70px 70px':'42px 1fr 120px 80px 120px',alignItems:'center',gap:8,padding:'12px 14px',background:isYou?'linear-gradient(135deg,rgba(255,140,0,.06),rgba(255,140,0,.03))':rank%2===0?'#05040c':'#040308',border:`1px solid ${isYou?'rgba(255,140,0,.3)':'rgba(140,60,255,.08)'}`,borderLeft:`3px solid ${isYou?'#ff9933':'rgba(140,60,255,.2)'}`,borderRadius:8,animation:`rw-row-in 0.3s ease ${delay}s both`}}>
    <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?11:12,fontWeight:700,color:isYou?'#ff9933':rank<=3?['#ffd700','#cc88ff','#39ff88'][rank-1]:'#99aacc',textAlign:'center'}}>{rank}</div>
    <div><div style={{display:'flex',alignItems:'center',gap:6}}>
      <span style={{fontFamily:'monospace',fontSize:isMobile?10:13,color:isYou?'#ffbb77':'#b0c4cc'}}>{short(entry.address)}</span>
      {isYou&&<span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?7:8,color:'#ff9933',background:'rgba(255,140,0,.1)',border:'1px solid rgba(255,140,0,.3)',borderRadius:4,padding:'2px 6px',fontWeight:700}}>YOU</span>}
    </div></div>
    <div style={{textAlign:'right'}}><div style={{display:'flex',alignItems:'center',justifyContent:'flex-end',gap:3}}>
      <BrainsLogo size={isMobile?10:12} />
      <span style={{fontFamily:'Sora,sans-serif',fontSize:isMobile?10:12,color:'#ff9933',textShadow:'0 0 8px rgba(255,140,0,.3)'}}>🔥 {fmtN(entry.burned,1)}</span>
    </div></div>
    {!isMobile&&<div style={{textAlign:'right'}}>
      {ampBonus>0?<><div style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,color:'#39ff88',textShadow:'0 0 8px rgba(57,255,136,.35)'}}>+{fmtPts(ampBonus)}</div><div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#55cc88'}}>⚡ +{totalAmp.toFixed(1)}%</div></>:<div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#6a7a8a'}}>—</div>}
    </div>}
    <div style={{textAlign:'right'}}>
      <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?12:14,fontWeight:700,color:'#39ff88',textShadow:'0 0 8px rgba(57,255,136,.4)'}}>{fmtPts(finalPts)}</div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'flex-end',gap:3}}>
        <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?7:8,color:'#55cc88'}}>PTS</span>
        {isMobile&&ampBonus>0&&<span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88',background:'rgba(57,255,136,.1)',borderRadius:3,padding:'0 4px'}}>⚡+{fmtPts(ampBonus)}</span>}
      </div>
    </div>
  </div>);
};

const POD_CFG=[
  {border:'#ffd700',glow:'rw-gold-glow',label:'#ffd700',rank:'1ST'},
  {border:'#cc88ff',glow:'rw-purple-glow',label:'#cc88ff',rank:'2ND'},
  {border:'#39ff88',glow:'rw-green-pulse',label:'#39ff88',rank:'3RD'},
];

const LS_LW_SUBMISSIONS = 'brains_labwork_submissions';
const LS_LW_REWARDS = 'brains_labwork_rewards';
let _rewardsLwCache: Map<string, number> | null = null;
const LW_CATEGORIES = [
  { k: 'social', l: '📱 Social Media Post', c: '#00ccff', desc: 'Tweet, X post, repost, or thread about BRAINS' },
  { k: 'content', l: '📝 Content / Article', c: '#ff9933', desc: 'Blog post, Medium article, or write-up' },
  { k: 'video', l: '🎬 Video / Reel', c: '#ff4466', desc: 'YouTube video, TikTok, Instagram reel' },
  { k: 'community', l: '🤝 Community Support', c: '#39ff88', desc: 'Helping in Discord, Telegram, onboarding' },
  { k: 'promo', l: '📣 Raid / Promotion', c: '#cc88ff', desc: 'Coordinated raid, space, or campaign' },
  { k: 'other', l: '⚡ Other', c: '#ffcc55', desc: 'Any other contribution' },
];

interface LWSubmission { id: string; address: string; category: string; links: string[]; description: string; date: string; status: 'pending' | 'approved' | 'rejected'; }

function readLwLeaderboard(): { address: string; pts: number; count: number }[] {
  // Try Supabase cache first (set by BurnLeaderboard)
  try {
    const sbMap = _rewardsLwCache;
    if (sbMap && sbMap.size > 0) {
      return [...sbMap.entries()].map(([address, pts]) => ({ address, pts, count: 1 })).sort((a, b) => b.pts - a.pts);
    }
  } catch {}
  // Fallback to localStorage
  try {
    const raw = localStorage.getItem(LS_LW_REWARDS);
    if (!raw) return [];
    const rewards = JSON.parse(raw);
    if (!Array.isArray(rewards)) return [];
    const map = new Map<string, { pts: number; count: number }>();
    for (const r of rewards) {
      if (!r.address || !r.lbPoints) continue;
      const prev = map.get(r.address) || { pts: 0, count: 0 };
      map.set(r.address, { pts: prev.pts + r.lbPoints, count: prev.count + 1 });
    }
    return [...map.entries()].map(([address, d]) => ({ address, ...d })).sort((a, b) => b.pts - a.pts);
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════
// LAB WORK SECTION (full content when tab is active)
// ═══════════════════════════════════════════════════════════════════════════
const LabWorkSection: FC<{ isMobile: boolean }> = ({ isMobile }) => {
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ address: '', category: 'social', links: [''], description: '' });
  const [submissions, setSubmissions] = useState<LWSubmission[]>(() => loadJ(LS_LW_SUBMISSIONS, []) as LWSubmission[]);
  const [msg, setMsg] = useState('');
  const wallet = useWallet();

  useEffect(() => { if (wallet.publicKey && !form.address) setForm(p => ({ ...p, address: wallet.publicKey!.toBase58() })); }, [wallet.publicKey]);

  const addLink = () => setForm(p => ({ ...p, links: [...p.links, ''] }));
  const removeLink = (i: number) => setForm(p => ({ ...p, links: p.links.filter((_, idx) => idx !== i) }));
  const updateLink = (i: number, val: string) => setForm(p => ({ ...p, links: p.links.map((l, idx) => idx === i ? val : l) }));

  const submit = () => {
    if (!form.address.trim()) { setMsg('⚠️ Enter your wallet address'); setTimeout(() => setMsg(''), 3000); return; }
    const cleanLinks = form.links.map(l => l.trim()).filter(Boolean);
    if (cleanLinks.length === 0 && !form.description.trim()) { setMsg('⚠️ Add at least one link or description'); setTimeout(() => setMsg(''), 3000); return; }
    const entry: LWSubmission = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), address: form.address.trim(), category: form.category, links: cleanLinks, description: form.description.trim(), date: new Date().toISOString(), status: 'pending' };
    const updated = [entry, ...submissions];
    setSubmissions(updated);
    try { localStorage.setItem(LS_LW_SUBMISSIONS, JSON.stringify(updated)); } catch {}
    setForm(p => ({ ...p, links: [''], description: '' }));
    setMsg('✅ Submitted! Admin will review and award LB Points.');
    setTimeout(() => setMsg(''), 4000);
  };

  const mySubmissions = form.address ? submissions.filter(s => s.address === form.address) : [];
  const cat = LW_CATEGORIES.find(c => c.k === form.category);
  const showLog = (() => { try { return localStorage.getItem('brains_labwork_visible') !== 'false'; } catch { return true; } })();
  const lb = readLwLeaderboard();
  const totalPtsAwarded = lb.reduce((s, e) => s + e.pts, 0);
  const IS: React.CSSProperties = { width: '100%', padding: '10px 14px', background: '#06080e', border: '1px solid rgba(0,204,255,.2)', borderRadius: 8, fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#e0e8f0', outline: 'none', boxSizing: 'border-box' };

  return (
    <div style={{ animation: 'rw-fade 0.5s ease both' }}>
      {/* HOW IT WORKS */}
      <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 16, background: 'linear-gradient(160deg,#020815,#06091a,#040612)', border: '1px solid rgba(0,204,255,.15)', padding: isMobile ? '24px 16px' : '32px 28px', marginBottom: 20 }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(0,204,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(0,204,255,.02) 1px,transparent 1px)', backgroundSize: '28px 28px', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', top: '-30%', left: '10%', width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle,rgba(0,204,255,.06),transparent 70%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, color: '#00ccff', letterSpacing: 3, marginBottom: 14, textAlign: 'center' }}>HOW IT WORKS</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { icon: '📣', title: 'PROMOTE', desc: 'Post about BRAINS on Twitter, TikTok, YouTube, or any platform', c: '#00ccff' },
              { icon: '📨', title: 'SUBMIT', desc: 'Submit your links below for review by the team', c: '#ff9933' },
              { icon: '🏆', title: 'EARN LB PTS', desc: 'Get LB Points added to your global leaderboard ranking', c: '#39ff88' },
            ].map((s, i) => (
              <div key={i} style={{ padding: '18px 16px', borderRadius: 12, textAlign: 'center', background: `linear-gradient(160deg,${s.c}06,${s.c}02)`, border: `1px solid ${s.c}20`, animation: `rw-fade 0.4s ease ${0.1 + i * 0.08}s both` }}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>{s.icon}</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: s.c, letterSpacing: 2, marginBottom: 4 }}>{s.title}</div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#8a9aaa', lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#7899aa', lineHeight: 1.7, textAlign: 'center', maxWidth: 600, margin: '0 auto' }}>
            Promote <span style={{ color: '#ff9933', fontWeight: 700 }}>BRAINS</span> on social media, create content, and support the community. Earn bonus <span style={{ color: '#00ccff', fontWeight: 700 }}>Lab Work Points</span> added directly to your <span style={{ color: '#39ff88', fontWeight: 700 }}>global leaderboard score</span>.
          </div>
        </div>
      </div>

      {/* LB POINTS LEADERBOARD */}
      {lb.length > 0 && (
        <div style={{ marginBottom: 20, borderRadius: 16, overflow: 'hidden', background: 'linear-gradient(160deg,#030610,#050814)', border: '1px solid rgba(0,204,255,.12)', animation: 'rw-fade 0.4s ease 0.15s both' }}>
          <div style={{ padding: isMobile ? '14px 14px' : '16px 24px', background: 'linear-gradient(90deg,rgba(0,204,255,.06),rgba(57,255,136,.03),rgba(0,204,255,.06))', borderBottom: '1px solid rgba(0,204,255,.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>🏆</span>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight: 800, color: '#00ccff', letterSpacing: 2 }}>LAB WORK LEADERBOARD</span>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#00ccff', padding: '3px 10px', background: 'rgba(0,204,255,.06)', border: '1px solid rgba(0,204,255,.15)', borderRadius: 20 }}>{fmtPts(totalPtsAwarded)} LB PTS</span>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#39ff88', padding: '3px 10px', background: 'rgba(57,255,136,.06)', border: '1px solid rgba(57,255,136,.15)', borderRadius: 20 }}>{lb.length} CONTRIBUTOR{lb.length !== 1 ? 'S' : ''}</span>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '36px 1fr auto' : '40px 1fr auto auto', gap: 8, padding: '8px 16px', borderBottom: '1px solid rgba(0,204,255,.06)' }}>
            {(isMobile ? ['#', 'WALLET', 'LB PTS'] : ['#', 'WALLET', 'REWARDS', 'LB PTS']).map(h => <div key={h} style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#7a8a9a', letterSpacing: 2 }}>{h}</div>)}
          </div>
          {lb.slice(0, 15).map((e, i) => {
            const isTop3 = i < 3; const rc = ['#ffd700', '#c0c0c0', '#cd7f32'][i] || '#7a8a9a'; const medals = ['🥇', '🥈', '🥉'];
            return (
              <div key={e.address} style={{ display: 'grid', gridTemplateColumns: isMobile ? '36px 1fr auto' : '40px 1fr auto auto', gap: 8, padding: '10px 16px', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,.02)', background: isTop3 ? `${rc}06` : i % 2 === 0 ? 'rgba(0,0,0,.1)' : 'transparent', animation: `rw-row-in 0.3s ease ${i * 0.04}s both` }}>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isTop3 ? 14 : 10, fontWeight: isTop3 ? 900 : 600, color: isTop3 ? rc : '#7a8a9a', textAlign: 'center' }}>{isTop3 ? medals[i] : i + 1}</div>
                <div style={{ fontFamily: 'monospace', fontSize: isMobile ? 10 : 12, color: isTop3 ? rc : '#aabbcc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{short(e.address)}</div>
                {!isMobile && <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#7a8a9a', textAlign: 'right' }}>{e.count}×</div>}
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isTop3 ? (isMobile ? 13 : 15) : (isMobile ? 11 : 12), fontWeight: 700, textAlign: 'right', color: isTop3 ? '#00ccff' : '#39ff88', textShadow: isTop3 ? '0 0 10px rgba(0,204,255,.3)' : 'none' }}>{fmtPts(e.pts)}</div>
              </div>
            );
          })}
          <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(0,204,255,.06)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#7a8a9a' }}>WALLETS: <span style={{ color: '#00ccff' }}>{lb.length}</span></span>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#7a8a9a' }}>TOTAL: <span style={{ color: '#39ff88' }}>{fmtPts(totalPtsAwarded)} LB PTS</span></span>
          </div>
        </div>
      )}

      {/* SUBMIT YOUR CONTRIBUTION */}
      <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(0,204,255,.15)', animation: 'rw-lb-border 3s ease infinite' }}>
        <button onClick={() => setFormOpen(!formOpen)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isMobile ? '16px 18px' : '18px 28px', cursor: 'pointer', background: 'linear-gradient(160deg,rgba(0,204,255,.06),rgba(4,6,15,.95),rgba(57,255,136,.03))', border: 'none', borderBottom: formOpen ? '1px solid rgba(0,204,255,.1)' : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22, animation: 'rw-lb-float 3s ease infinite' }}>📨</span>
            <div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 12 : 14, fontWeight: 800, color: '#00ccff', letterSpacing: 2, textAlign: 'left' }}>SUBMIT YOUR CONTRIBUTION</div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#77aacc', marginTop: 2, textAlign: 'left' }}>Share your promo work and earn bonus LB Points on the leaderboard</div>
            </div>
          </div>
          <div style={{ width: 28, height: 28, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,204,255,.08)', border: '1px solid rgba(0,204,255,.2)' }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, color: '#00ccff', transform: formOpen ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform .3s', display: 'block' }}>▼</span>
          </div>
        </button>
        {formOpen && (
          <div style={{ background: 'linear-gradient(160deg,#04060f,#060812)', padding: isMobile ? 18 : 28, position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(0,204,255,.012) 1px,transparent 1px),linear-gradient(90deg,rgba(0,204,255,.012) 1px,transparent 1px)', backgroundSize: '24px 24px', pointerEvents: 'none' }} />
            <div style={{ position: 'relative', zIndex: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#00ccff', letterSpacing: 2, marginBottom: 6, display: 'block' }}>YOUR WALLET ADDRESS</label>
                  <input style={IS} placeholder="Paste your wallet address..." value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} />
                  {wallet.publicKey && <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 8, color: '#39ff88', marginTop: 3 }}>✓ Auto-filled from connected wallet</div>}
                </div>
                <div>
                  <label style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#00ccff', letterSpacing: 2, marginBottom: 6, display: 'block' }}>LINKS TO CONTRIBUTIONS</label>
                  {form.links.map((link, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                      <input style={{ ...IS, fontFamily: 'Sora,sans-serif' }} placeholder={i === 0 ? 'https://x.com/... or any URL' : 'Another link...'} value={link} onChange={e => updateLink(i, e.target.value)} />
                      {form.links.length > 1 && <button onClick={() => removeLink(i)} style={{ padding: '0 10px', background: 'rgba(255,68,102,.08)', border: '1px solid rgba(255,68,102,.2)', borderRadius: 6, color: '#ff4466', fontFamily: 'Orbitron,monospace', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}>✕</button>}
                    </div>
                  ))}
                  <button onClick={addLink} style={{ padding: '5px 12px', background: 'rgba(0,204,255,.06)', border: '1px solid rgba(0,204,255,.15)', borderRadius: 6, color: '#00ccff', fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1, cursor: 'pointer' }}>+ ADD ANOTHER LINK</button>
                </div>
                <div>
                  <label style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#00ccff', letterSpacing: 2, marginBottom: 6, display: 'block' }}>CATEGORY</label>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {LW_CATEGORIES.map(c => (
                      <button key={c.k} onClick={() => setForm(p => ({ ...p, category: c.k }))} style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer', transition: 'all .2s', background: form.category === c.k ? c.c + '18' : 'rgba(255,255,255,.02)', border: `1px solid ${form.category === c.k ? c.c + '50' : 'rgba(255,255,255,.06)'}`, color: form.category === c.k ? c.c : '#7a8a9a', fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1 }}>{c.l}</button>
                    ))}
                  </div>
                  {cat && <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#7a8a9a', marginTop: 4 }}>{cat.desc}</div>}
                </div>
                <div>
                  <label style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#00ccff', letterSpacing: 2, marginBottom: 6, display: 'block' }}>DESCRIPTION (OPTIONAL)</label>
                  <textarea style={{ ...IS, minHeight: 60, resize: 'vertical' as const }} placeholder="Brief description of your contribution..." value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button onClick={submit} style={{ padding: '12px 28px', borderRadius: 10, cursor: 'pointer', fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, letterSpacing: 2, border: '1px solid rgba(0,204,255,.4)', background: 'linear-gradient(135deg,rgba(0,204,255,.18),rgba(57,255,136,.08))', color: '#00ccff', boxShadow: '0 0 20px rgba(0,204,255,.1)' }}>🧪 SUBMIT FOR REVIEW</button>
                {msg && <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: msg.startsWith('✅') ? '#39ff88' : '#ff9933', animation: 'rw-fade 0.3s ease both' }}>{msg}</span>}
              </div>
              {showLog && mySubmissions.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#8a9aaa', letterSpacing: 2, marginBottom: 8 }}>📋 YOUR SUBMISSIONS ({mySubmissions.length})</div>
                  <div style={{ maxHeight: 200, overflowY: 'auto', borderRadius: 8, border: '1px solid rgba(0,204,255,.06)' }}>
                    {mySubmissions.map(s => {
                      const sc = LW_CATEGORIES.find(c => c.k === s.category);
                      const statusColors: Record<string, string> = { pending: '#ffcc55', approved: '#39ff88', rejected: '#ff4466' };
                      const statusLabels: Record<string, string> = { pending: '⏳ PENDING', approved: '✅ APPROVED', rejected: '❌ REJECTED' };
                      return (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,.02)', background: 'rgba(0,0,0,.1)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: sc?.c || '#8a9aaa', padding: '2px 6px', background: (sc?.c || '#8a9aaa') + '12', border: `1px solid ${(sc?.c || '#8a9aaa')}30`, borderRadius: 4 }}>{sc?.l || s.category}</span>
                              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: statusColors[s.status], padding: '2px 6px', background: statusColors[s.status] + '12', border: `1px solid ${statusColors[s.status]}30`, borderRadius: 4 }}>{statusLabels[s.status]}</span>
                            </div>
                            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#7a8a9a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {(s.links?.length ? s.links.join(', ') : (s as any).link) || s.description || 'No details'} · {new Date(s.date).toLocaleDateString()}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
type ActiveTab = 'challenge' | 'labwork';

const RewardsSeason:FC=()=>{
  const navigate=useNavigate();const wallet=useWallet();const{connection}=useConnection();
  const wa=wallet.publicKey?.toBase58()||'';
  const[isMobile,setIsMobile]=useState(window.innerWidth<768);
  useEffect(()=>{const h=()=>setIsMobile(window.innerWidth<768);window.addEventListener('resize',h);return()=>window.removeEventListener('resize',h);},[]);
  const[activeTab,setActiveTab]=useState<ActiveTab>('challenge');

  const dp:[PrizeItem[],PrizeItem[],PrizeItem[]]= [[{token:'BRAINS',amount:5000}],[{token:'BRAINS',amount:2500}],[{token:'BRAINS',amount:1000}]];
  const[w,setW]=useState(()=>{const d=loadJ('brains_weekly_config',null);if(d&&d.weekId){if(!d.prizes||!Array.isArray(d.prizes)||d.prizes.length<3)d.prizes=dp;return d as WConfig;}
    return{weekId:'week-001',startDate:'',endDate:'',challenges:[],prizes:dp,status:'upcoming'} as WConfig;});
  const[anns,setAnns]=useState(()=>loadJ('brains_announcements',[]) as Ann[]);
  const[logs,setLogs]=useState(()=>loadJ('brains_challenge_log',[]) as ChallengeLog[]);

  // Load from Supabase on mount — overwrite localStorage defaults
  useEffect(()=>{
    (async()=>{
      try{
        const sb=await import('../lib/supabase');
        const[wc,cl,an,lwMap]=await Promise.all([sb.getCachedWeeklyConfig(),sb.getCachedChallengeLogs(),sb.getCachedAnnouncements(),sb.getCachedLabWorkMap()]);
        if(wc&&wc.weekId){if(!wc.prizes||!Array.isArray(wc.prizes)||wc.prizes.length<3)wc.prizes=dp;setW(wc as WConfig);}
        if(cl.length>0)setLogs(cl as ChallengeLog[]);
        if(an.length>0)setAnns(an as Ann[]);
        if(lwMap&&lwMap.size>0)_rewardsLwCache=lwMap;
      }catch(e){console.warn('[Rewards] Supabase load failed',e);}
    })();
  },[]);

  // Refresh from Supabase every 15s
  useEffect(()=>{const id=setInterval(async()=>{
    try{
      const sb=await import('../lib/supabase');
      sb.invalidateWeeklyConfigCache();sb.invalidateChallengeLogsCache();sb.invalidateAnnouncementsCache();
      const[wc,cl,an]=await Promise.all([sb.getWeeklyConfig(),sb.getChallengeLogs(),sb.getAnnouncements()]);
      if(wc&&wc.weekId)setW((prev:any)=>JSON.stringify(prev)!==JSON.stringify(wc)?wc as WConfig:prev);
      if(cl.length>0)setLogs((prev:any)=>JSON.stringify(prev)!==JSON.stringify(cl)?cl as ChallengeLog[]:prev);
      if(an.length>0)setAnns((prev:any)=>JSON.stringify(prev)!==JSON.stringify(an)?an as Ann[]:prev);
    }catch{
      const fresh=loadJ('brains_weekly_config',null);if(fresh&&JSON.stringify(fresh)!==JSON.stringify(w))setW(fresh);
    }
  },15000);return()=>clearInterval(id);},[]);

  const isActive=w.status==='active';const isPaused=w.status==='paused';const isLive=isActive||isPaused;
  const countdown=useCountdown(w.endDate,isLive);
  const timeUp=isLive&&w.endDate&&new Date(w.endDate).getTime()<=Date.now();
  const isAdmin=wa===ADMIN_WALLET;
  const totalAmp=w.challenges.reduce((s:number,c:any)=>s+TIER_AMPS[c.tier],0);
  const brainsPrice=(usePrice(BRAINS_MINT) ?? null) as number|null;
  const xntPrice=(usePrice('So11111111111111111111111111111111111111112') ?? null) as number|null;

  // Helper to get USD for a prize item
  const prizeItemUsd=(p:PrizeItem):number=>{
    if(p.isNFT) return 0;
    if(p.token==='BRAINS'&&brainsPrice) return p.amount*brainsPrice;
    if(p.token==='XNT'&&xntPrice) return p.amount*xntPrice;
    return 0;
  };
  const lastLog=logs.length>0?logs[0]:null;
  const lwLb=readLwLeaderboard();
  const lwTotalPts=lwLb.reduce((s,e)=>s+e.pts,0);

  const[lbEntries,setLbEntries]=useState<BurnerEntry[]>([]);
  const[lbLoading,setLbLoading]=useState(false);
  const[lbProgress,setLbProgress]=useState('');
  const[lbFetchedAt,setLbFetchedAt]=useState<Date|null>(null);
  const abortRef=useRef<AbortController|null>(null);
  const mountedRef=useRef(true);

  const loadLb=useCallback(async()=>{
    if(!connection||!isLive)return;abortRef.current?.abort();const ctrl=new AbortController();abortRef.current=ctrl;
    const startTs=w.startDate?Math.floor(new Date(w.startDate).getTime()/1000):0;
    const endTs=w.endDate?Math.floor(new Date(w.endDate).getTime()/1000):Infinity;

    const filterWeek=(full:BurnerEntry[])=>{
      return full.map(e=>{
        const weekEvents=(e.events||[]).filter(ev=>ev.blockTime>=startTs&&ev.blockTime<=endTs);
        if(weekEvents.length===0)return null;
        const burned=weekEvents.reduce((s,ev)=>s+ev.amount,0);
        return{address:e.address,burned,txCount:weekEvents.length,points:Math.floor(burned*1.888),events:weekEvents};
      }).filter((e):e is BurnerEntry=>e!==null&&e.points>0).sort((a,b)=>b.points-a.points);
    };

    // Try cache first for instant display
    const cached=getCachedLeaderboard();
    if(cached&&cached.length>0){
      const weekEntries=filterWeek(cached);
      setLbEntries(weekEntries);setLbFetchedAt(new Date());
    }

    // Then do full fetch in background for fresh data
    setLbLoading(true);setLbProgress('Scanning chain…');
    try{
      const full=await fetchLeaderboard(connection,ctrl.signal,(_,progress)=>{if(!mountedRef.current||ctrl.signal.aborted)return;setLbProgress(progress);});
      if(!mountedRef.current||ctrl.signal.aborted)return;
      const weekEntries=filterWeek(full);
      setLbEntries(weekEntries);setLbFetchedAt(new Date());
    }catch{}setLbLoading(false);
  },[connection,isLive,w.startDate,w.endDate]);

  useEffect(()=>{mountedRef.current=true;if(isLive)loadLb();return()=>{mountedRef.current=false;abortRef.current?.abort();};},[loadLb,isLive]);
  useEffect(()=>{if(!isLive)return;const id=setInterval(loadLb,30000);return()=>clearInterval(id);},[isLive,loadLb]);
  const myRank=wa?lbEntries.findIndex(e=>e.address===wa)+1||null:null;

  // Tab button component
  const TabBtn:FC<{tab:ActiveTab;icon:string;label:string;sublabel:string;color:string;stat?:string;statColor?:string;pulse?:boolean;desc?:string;features?:{icon:string;text:string}[];glowWhenInactive?:boolean}>=
    ({tab,icon,label,sublabel,color,stat,statColor,pulse,desc,features,glowWhenInactive})=>{
    const active=activeTab===tab;
    return(
      <button onClick={()=>setActiveTab(tab)} style={{
        flex:1,position:'relative',overflow:'hidden',cursor:'pointer',
        padding:isMobile?'20px 14px':'28px 24px',
        background:active?`linear-gradient(160deg,${color}12,${color}06)`:'linear-gradient(160deg,#06080f,#08091a)',
        border:`1px solid ${active?color+'55':'rgba(100,120,160,.12)'}`,
        borderTop:`3px solid ${active?color:'rgba(100,120,160,.08)'}`,
        borderRadius:16,textAlign:'left',
        transition:'all 0.35s cubic-bezier(.4,0,.2,1)',
        boxShadow:active?`0 0 30px ${color}15, inset 0 0 40px ${color}04`:'none',
        animation:(!active&&glowWhenInactive)?'rw-blue-neon 3s ease infinite':'none',
      }}>
        <div style={{position:'absolute',inset:0,backgroundImage:`linear-gradient(${color}05 1px,transparent 1px),linear-gradient(90deg,${color}05 1px,transparent 1px)`,backgroundSize:'20px 20px',pointerEvents:'none',opacity:active?1:.3}} />
        {active&&<div style={{position:'absolute',top:'-50%',right:'-20%',width:200,height:200,borderRadius:'50%',background:`radial-gradient(circle,${color}10,transparent 70%)`,pointerEvents:'none'}} />}
        <div style={{position:'relative',zIndex:1}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6}}>
            <span style={{fontSize:isMobile?28:36,filter:active?`drop-shadow(0 0 12px ${color}66)`:'grayscale(50%)',transition:'filter .3s'}}>{icon}</span>
            <div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?13:17,fontWeight:900,letterSpacing:isMobile?2:3,color:active?color:'#7a8a9a',transition:'color .3s'}}>{label}</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:isMobile?9:10,color:active?'#8899aa':'#6a7a8a',marginTop:1,transition:'color .3s'}}>{sublabel}</div>
            </div>
          </div>
          {/* Description */}
          {desc&&<div style={{fontFamily:'Sora,sans-serif',fontSize:isMobile?9:11,color:active?'#6a7a8a':'#7a8a9a',lineHeight:1.6,marginBottom:8,transition:'color .3s',maxWidth:400}}>{desc}</div>}
          {/* Feature highlights */}
          {features&&features.length>0&&!isMobile&&(
            <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
              {features.map((f,i)=>(
                <span key={i} style={{fontFamily:'Orbitron,monospace',fontSize:7,letterSpacing:1,color:active?color+'cc':'#6a7a8a',padding:'3px 8px',background:active?`${color}08`:'rgba(255,255,255,.01)',border:`1px solid ${active?`${color}20`:'rgba(255,255,255,.03)'}`,borderRadius:4,transition:'all .3s'}}>{f.icon} {f.text}</span>
              ))}
            </div>
          )}
          {stat&&<div style={{display:'inline-flex',alignItems:'center',gap:6,padding:'5px 12px',borderRadius:8,background:active?`${statColor||color}12`:'rgba(255,255,255,.02)',border:`1px solid ${active?`${statColor||color}30`:'rgba(255,255,255,.04)'}`,transition:'all .3s'}}>
            {pulse&&<div style={{width:6,height:6,borderRadius:'50%',background:statColor||color,boxShadow:`0 0 8px ${statColor||color}`,animation:'rw-dash-pulse 2s ease infinite'}} />}
            <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:9,fontWeight:700,color:active?statColor||color:'#7a8a9a',letterSpacing:1.5}}>{stat}</span>
          </div>}
        </div>
        <div style={{position:'absolute',bottom:0,left:'10%',right:'10%',height:2,borderRadius:1,background:active?`linear-gradient(90deg,transparent,${color},transparent)`:'transparent',transition:'background .3s'}} />
      </button>
    );
  };

  return(
    <div style={{minHeight:'100vh',background:'#080c10',padding:isMobile?'70px 10px 40px':'90px 24px 40px',position:'relative',overflow:'hidden'}}>
      <TopBar /><PageBackground />
      <div style={{maxWidth:1100,margin:'0 auto'}}>

        {/* HERO HEADER */}
        <div style={{textAlign:'center',marginBottom:28,animation:'rw-fade 0.5s ease both'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:12,marginBottom:10}}>
            <div style={{height:1,width:80,background:'linear-gradient(90deg,transparent,rgba(140,60,255,.5))'}} />
            <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#9977cc',letterSpacing:4,fontWeight:700}}>X1 BRAINS · COMMUNITY HUB</span>
            <div style={{height:1,width:80,background:'linear-gradient(90deg,rgba(140,60,255,.5),transparent)'}} />
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:isMobile?6:10,margin:'0 0 8px'}}>
            <h1 style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?18:28,fontWeight:900,letterSpacing:isMobile?2:5,margin:0,background:'linear-gradient(90deg,#00ccff,#aa44ff,#ee55ff)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',filter:'drop-shadow(0 0 12px rgba(140,60,255,.25))'}}>LAB WORK</h1>
            <span style={{fontSize:isMobile?18:28,lineHeight:1}}>🧪</span>
            <h1 style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?18:28,fontWeight:900,letterSpacing:isMobile?2:5,margin:0,background:'linear-gradient(90deg,#ee55ff,#ff9933,#ff6600)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',filter:'drop-shadow(0 0 12px rgba(255,140,0,.25))'}}>BURN, RANK, ASCEND</h1>
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:16,flexWrap:'wrap'}}>
            <span style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#7889aa'}}>Burn BRAINS · Complete challenges · Earn Lab Work Points · Win prizes</span>
            {brainsPrice&&<span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#ff9933',textShadow:'0 0 6px rgba(255,140,0,.3)',padding:'3px 10px',background:'rgba(255,140,0,.06)',border:'1px solid rgba(255,140,0,.15)',borderRadius:20}}><TkLogo t="BRAINS" s={10} /> ${brainsPrice.toFixed(6)}</span>}
          </div>
          {isAdmin&&<button onClick={()=>navigate('/x9b7r41ns/ctrl')} style={{marginTop:14,padding:'8px 22px',background:'linear-gradient(135deg,rgba(255,0,68,.15),rgba(140,60,255,.15))',border:'1px solid rgba(255,0,68,.4)',borderRadius:10,color:'#ff4466',fontFamily:'Orbitron,monospace',fontSize:9,fontWeight:700,letterSpacing:3,cursor:'pointer',animation:'rw-glow 3s ease infinite'}}>🔐 ADMIN PANEL</button>}
          {isAdmin&&timeUp&&<div style={{marginTop:10,padding:'10px 20px',background:'rgba(255,68,102,.08)',border:'1px solid rgba(255,68,102,.3)',borderRadius:10,display:'inline-flex',alignItems:'center',gap:8}}>
            <span style={{fontSize:14}}>⚠️</span>
            <span style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#ff4466',fontWeight:700,letterSpacing:2}}>WEEK CHALLENGE ENDED — STOP IN ADMIN TO FINALIZE</span>
          </div>}
        </div>

        {/* QUICK STATS DASHBOARD */}
        <div style={{...pan('rgba(140,60,255,.15)'),padding:0,animation:'rw-fade 0.4s ease 0.08s both'}}>
          <GridBg /><ScanLine />
          <div style={{position:'relative',zIndex:1,display:'grid',gridTemplateColumns:isMobile?'repeat(2,1fr)':`repeat(${isLive?4:3},1fr)`}}>
            {(()=>{
              const stats:{l:string;v:string;c:string}[]=[];
              stats.push({l:'CHALLENGE',v:timeUp?'🔴 ENDED':isActive?'🟢 LIVE':isPaused?'🟡 PAUSED':'⚪ NONE',c:timeUp?'#ff4466':isActive?'#39ff88':isPaused?'#ffcc55':'#8a9aaa'});
              if(isLive){
                stats.push({l:'TIME LEFT',v:timeUp?'ENDED':countdown,c:timeUp?'#ff4466':'#ff9933'});
                stats.push({l:'WEEK',v:w.weekId.replace('week-','#'),c:'#cc88ff'});
                stats.push({l:'MAX AMP',v:`+${totalAmp.toFixed(2)}%`,c:'#cc00ff'});
              }else{
                stats.push({l:'BURN RATE',v:'1 = 1.888 LB PTS',c:'#ff9933'});
                if(lwTotalPts>0){
                  stats.push({l:'LAB WORK PTS',v:fmtPts(lwTotalPts),c:'#00ccff'});
                }else{
                  stats.push({l:'MAX AMP STACK',v:'+19.38%',c:'#cc00ff'});
                }
              }
              return stats.map((s,i)=>(
                <div key={i} style={{padding:isMobile?'14px 10px':'18px 16px',textAlign:'center',borderRight:(!isMobile&&i<stats.length-1)?'1px solid rgba(120,60,255,.06)':'none',borderBottom:(isMobile&&i<2)?'1px solid rgba(120,60,255,.06)':'none'}}>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:s.c+'99',letterSpacing:2,marginBottom:5}}>{s.l}</div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?13:17,fontWeight:900,letterSpacing:1,background:`linear-gradient(135deg,${s.c},${s.c}cc)`,WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',filter:`drop-shadow(0 0 10px ${s.c}55)`,animation:s.l==='TIME LEFT'&&isLive?'rw-cd 2s ease infinite':undefined}}>{s.v}</div>
                </div>));
            })()}
          </div>
        </div>

        {/* SECTION TABS */}
        <div style={{display:'flex',gap:isMobile?10:16,marginBottom:24,animation:'rw-fade 0.4s ease 0.15s both'}}>
          <TabBtn tab="challenge" icon="🔥" label="BURN CHALLENGE" sublabel="Weekly challenges, prizes & leaderboard" color="#cc88ff"
            desc="Burn BRAINS tokens to earn LB Points. Complete weekly tier challenges for AMP bonuses. Top 3 burners win prizes automatically."
            features={[{icon:'🏆',text:'PRIZE VAULT'},{icon:'⚡',text:'AMP BONUSES'},{icon:'📊',text:'LIVE RANKINGS'},{icon:'🎯',text:'TIER CHALLENGES'}]}
            stat={isLive?`${w.weekId.replace('week-','WEEK #')} · ${w.challenges.length} CHALLENGES`:'NO ACTIVE CHALLENGE'} statColor={isLive?'#cc88ff':'#7a8a9a'} pulse={isLive} />
          <TabBtn tab="labwork" icon="🧪" label="LAB WORK" sublabel="Promote BRAINS & earn bonus LB Points" color="#00ccff"
            desc="Create content, run raids, post on social media, and support the community. Submit your work for review and earn LB Points added to your global score."
            features={[{icon:'📱',text:'SOCIAL POSTS'},{icon:'📝',text:'CONTENT'},{icon:'🎬',text:'VIDEOS'},{icon:'📣',text:'RAIDS'}]}
            stat={lwTotalPts>0?`${fmtPts(lwTotalPts)} LB PTS · ${lwLb.length} CONTRIBUTORS`:'SUBMIT WORK TO EARN'} statColor="#00ccff" glowWhenInactive />
        </div>

        {/* NEWS / ANNOUNCEMENTS */}
        {anns.length>0&&(
          <div style={{marginBottom:20,animation:'rw-fade 0.4s ease 0.2s both'}}>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
              <div style={{height:1,flex:1,background:'linear-gradient(90deg,transparent,rgba(140,60,255,.4))'}}/>
              <div style={{display:'flex',alignItems:'center',gap:6}}>
                <div style={{width:5,height:5,borderRadius:'50%',background:'#cc88ff',boxShadow:'0 0 8px #cc88ff',animation:'rw-pulse 2s ease infinite'}}/>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:9,letterSpacing:4,color:'#cc88ff'}}>📢 LATEST NEWS</span>
                <div style={{width:5,height:5,borderRadius:'50%',background:'#cc88ff',boxShadow:'0 0 8px #cc88ff',animation:'rw-pulse 2s ease 0.5s infinite'}}/>
              </div>
              <div style={{height:1,flex:1,background:'linear-gradient(90deg,rgba(140,60,255,.4),transparent)'}}/>
            </div>
            {anns.slice(0,3).map((a:any,ai:number)=>{
              const tc:Record<string,{c:string;icon:string;bg:string}>={info:{c:'#cc88ff',icon:'📋',bg:'rgba(140,60,255,.06)'},reward:{c:'#ffd700',icon:'🏆',bg:'rgba(255,215,0,.04)'},challenge:{c:'#39ff88',icon:'⚡',bg:'rgba(57,255,136,.04)'},milestone:{c:'#ff5500',icon:'🔥',bg:'rgba(255,85,0,.04)'}};
              const cfg=tc[a.type]||tc.info;
              return(
                <div key={a.id} style={{position:'relative',overflow:'hidden',marginBottom:10,background:cfg.bg,border:`1px solid ${cfg.c}20`,borderLeft:`3px solid ${cfg.c}`,borderRadius:12,animation:`rw-fade 0.3s ease ${0.1*ai}s both`}}>
                  <div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(rgba(100,60,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.02) 1px,transparent 1px)',backgroundSize:'20px 20px',pointerEvents:'none'}}/>
                  <div style={{position:'relative',zIndex:1,padding:'14px 18px'}}>
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
                      <span style={{fontSize:16}}>{cfg.icon}</span>
                      <span style={{fontFamily:'Orbitron,monospace',fontSize:8,fontWeight:700,color:cfg.c,letterSpacing:2,textTransform:'uppercase'}}>{a.type}</span>
                      <span style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#7a8a9a'}}>{new Date(a.date).toLocaleDateString()}</span>
                    </div>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:700,color:'#fff',letterSpacing:0.5,marginBottom:3}}>{a.title}</div>
                    {a.message&&<div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#8899aa',lineHeight:1.5}}>{a.message}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════ */}
        {/* TAB: BURN CHALLENGE */}
        {/* ════════════════════════════════════════════════════════════════ */}
        {activeTab==='challenge'&&(<div style={{animation:'rw-fade 0.35s ease both'}}>
          {isLive&&(<>
            {/* PRIZE VAULT */}
            {(()=>{
              // Calculate totals for the vault display
              const allItems:PrizeItem[]=[...(w.prizes[0]||[]),...(w.prizes[1]||[]),...(w.prizes[2]||[])];
              const tokenTotals=new Map<string,number>();
              const nftList:PrizeItem[]=[];
              for(const p of allItems){if(p.isNFT){nftList.push(p);}else{tokenTotals.set(p.token,(tokenTotals.get(p.token)||0)+p.amount);}}
              let totalUsd=0;
              for(const p of allItems){totalUsd+=prizeItemUsd(p);}
              const placeColors=['#ffd700','#cc88ff','#39ff88'];
              const placeLabels=['🥇 1ST','🥈 2ND','🥉 3RD'];
              return(
            <div style={{...pan('rgba(255,215,0,.12)'),padding:0,position:'relative',overflow:'hidden'}}>
              <GridBg />
              <div style={{position:'absolute',top:0,left:0,width:'38%',height:'100%',background:'linear-gradient(90deg,transparent,rgba(255,215,0,.03),transparent)',animation:'rw-scan 6s linear infinite',pointerEvents:'none'}}/>
              <div style={{position:'relative',zIndex:1,padding:isMobile?'20px 14px':'28px 32px'}}>

                {/* Vault header */}
                <div style={{textAlign:'center',marginBottom:20}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,marginBottom:6}}>
                    <div style={{height:1,flex:1,maxWidth:100,background:'linear-gradient(90deg,transparent,rgba(255,215,0,.5))'}}/>
                    <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#d4a050',letterSpacing:4,fontWeight:700}}>WEEKLY PRIZE VAULT</span>
                    <div style={{height:1,flex:1,maxWidth:100,background:'linear-gradient(90deg,rgba(255,215,0,.5),transparent)'}}/>
                  </div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#99aabb',marginTop:4}}>Top 3 burners by weekly LB Points win automatically when the challenge ends</div>
                </div>

                {/* Big vault total */}
                <div style={{textAlign:'center',padding:isMobile?'20px 12px':'28px 24px',background:'linear-gradient(160deg,rgba(255,215,0,.04),rgba(255,140,0,.02))',border:'1px solid rgba(255,215,0,.18)',borderRadius:14,marginBottom:16,position:'relative',overflow:'hidden'}}>
                  <div style={{position:'absolute',inset:0,background:'linear-gradient(90deg,transparent,rgba(255,215,0,.03),transparent)',backgroundSize:'200% 100%',animation:'rw-shimmer 4s ease infinite',pointerEvents:'none'}}/>
                  <div style={{position:'relative',zIndex:1}}>
                    <div style={{fontSize:isMobile?28:36,marginBottom:8,animation:'rw-float 3s ease infinite'}}>🏆</div>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#aa9966',letterSpacing:3,marginBottom:8}}>TOTAL PRIZE POOL</div>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:isMobile?12:20,flexWrap:'wrap',marginBottom:8}}>
                      {[...tokenTotals.entries()].map(([token,amount])=>(
                        <div key={token} style={{display:'flex',alignItems:'center',gap:6}}>
                          <TkLogo t={token} s={isMobile?18:22} />
                          <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?24:34,fontWeight:900,background:`linear-gradient(135deg,${TK[token]?.c||'#ffd700'},${TK[token]?.c||'#ffd700'}cc)`,WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',filter:`drop-shadow(0 0 12px ${TK[token]?.c||'#ffd700'}55)`}}>{fmtN(amount,0)}</span>
                          <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?10:12,color:'#8899aa',fontWeight:700}}>{token}</span>
                        </div>
                      ))}
                      {nftList.map((nft,i)=>(
                        <div key={i} style={{display:'flex',alignItems:'center',gap:5}}>
                          {nft.nftImage?<img src={nft.nftImage} alt="" style={{width:isMobile?22:28,height:isMobile?22:28,borderRadius:6,border:'1px solid rgba(255,215,0,.3)'}}/>:<span style={{fontSize:isMobile?20:26}}>🖼️</span>}
                          <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?12:14,fontWeight:700,color:'#ee99ff'}}>{nft.nftName||'NFT'}</span>
                        </div>
                      ))}
                    </div>
                    {totalUsd>0&&<div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?12:14,color:'#00c98d',textShadow:'0 0 10px rgba(0,201,141,.3)'}}>≈ ${totalUsd>=1000?`${(totalUsd/1000).toFixed(2)}K`:totalUsd.toFixed(2)} USD</div>}
                  </div>
                </div>

                {/* Per-place breakdown — compact horizontal rows */}
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {[0,1,2].map((place,idx)=>{
                    const items=w.prizes[place]||[];
                    const cl=placeColors[place];
                    let placeUsd=0;for(const p of items){placeUsd+=prizeItemUsd(p);}
                    return(
                      <div key={place} style={{display:'flex',alignItems:'center',gap:isMobile?8:14,padding:isMobile?'10px 12px':'12px 18px',background:`${cl}06`,border:`1px solid ${cl}18`,borderLeft:`3px solid ${cl}`,borderRadius:10,animation:`rw-row-in 0.3s ease ${idx*0.08}s both`}}>
                        {/* Place badge */}
                        <div style={{display:'flex',alignItems:'center',gap:6,minWidth:isMobile?60:80}}>
                          <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?10:12,fontWeight:900,color:cl,letterSpacing:2}}>{placeLabels[place]}</span>
                        </div>
                        {/* Prize items */}
                        <div style={{flex:1,display:'flex',alignItems:'center',gap:isMobile?6:10,flexWrap:'wrap'}}>
                          {items.length>0?items.map((p:PrizeItem,j:number)=>p.isNFT?(
                            <div key={j} style={{display:'flex',alignItems:'center',gap:4}}>
                              {p.nftImage?<img src={p.nftImage} alt="" style={{width:16,height:16,borderRadius:3}}/>:<span style={{fontSize:12}}>🖼️</span>}
                              <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?9:10,fontWeight:700,color:'#ee99ff'}}>{p.nftName||'NFT'}</span>
                            </div>
                          ):(
                            <div key={j} style={{display:'flex',alignItems:'center',gap:4}}>
                              <TkLogo t={p.token} s={12}/>
                              <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?12:14,fontWeight:700,color:TK[p.token]?.c||'#fff'}}>{fmtN(p.amount,0)}</span>
                              <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#99aabb'}}>{p.token}</span>
                            </div>
                          )):(<span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#7a8a9a'}}>TBD</span>)}
                        </div>
                        {/* USD value */}
                        {placeUsd>0&&<span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:9,color:'#00c98d',whiteSpace:'nowrap'}}>≈ ${placeUsd>=1000?`${(placeUsd/1000).toFixed(2)}K`:placeUsd.toFixed(2)}</span>}
                      </div>
                    );
                  })}
                </div>

              </div>
            </div>);})()}

            {/* CHALLENGES */}
            <div style={{marginBottom:20}}>
              <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
                <div style={{height:1,flex:1,background:'linear-gradient(90deg,rgba(57,255,136,.3),transparent)'}} />
                <span style={{fontFamily:'Orbitron,monospace',fontSize:9,letterSpacing:4,color:'#39ff88'}}>⚡ ACTIVE CHALLENGES ({w.challenges.length})</span>
                <div style={{height:1,flex:1,background:'linear-gradient(90deg,transparent,rgba(57,255,136,.3))'}} />
              </div>
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'repeat(auto-fit,minmax(300px,1fr))',gap:12}}>
                {w.challenges.map((ch:any,i:number)=>{const tc=TIER_CFG[ch.tier as 1|2|3|4];return(
                  <div key={ch.id} style={{...pan(tc.border),padding:0,borderLeft:`4px solid ${tc.color}`}}>
                    <GridBg /><div style={{position:'relative',zIndex:1,padding:'16px 18px'}}>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                        <div style={{display:'flex',alignItems:'center',gap:8}}>
                          <span style={{fontSize:24,animation:'rw-float 3s ease infinite',animationDelay:`${i*0.2}s`}}>{ch.icon}</span>
                          <div><div style={{fontFamily:'Orbitron,monospace',fontSize:13,fontWeight:800,color:'#fff',letterSpacing:1}}>{ch.title||'UNTITLED'}</div>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:7,padding:'2px 8px',borderRadius:4,background:tc.bg,border:`1px solid ${tc.border}`,color:tc.color,letterSpacing:2}}>{tc.label}</span></div>
                        </div>
                        <div style={{textAlign:'right'}}><div style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:900,background:`linear-gradient(135deg,${tc.color},${tc.color}cc)`,WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',filter:`drop-shadow(0 0 10px ${tc.glow})`}}>+{TIER_AMPS[ch.tier].toFixed(2)}%</div><div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#8a9aaa'}}>AMPLIFIER</div></div>
                      </div>
                      <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#99aabb',lineHeight:1.5,marginBottom:8}}>{ch.description}</div>
                      <div style={{padding:'6px 12px',background:'rgba(140,60,255,.04)',border:'1px solid rgba(140,60,255,.1)',borderRadius:6,fontFamily:'Orbitron,monospace',fontSize:9,color:'#cc88ff',display:'inline-block'}}>🎯 {challengeTargetLabel(ch.type,ch.target)}</div>
                    </div></div>);})}
              </div>
            </div>

            {/* LIVE WEEK LEADERBOARD */}
            <div style={{...pan('rgba(57,255,136,.12)'),padding:0}}>
              <GridBg /><ScanLine /><div style={{position:'relative',zIndex:1,padding:isMobile?'16px 12px':'20px 24px'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16,flexWrap:'wrap',gap:8}}>
                  <div style={{display:'flex',alignItems:'center',gap:5,flexWrap:'wrap'}}>
                    <div style={{display:'flex',alignItems:'center',gap:5}}><div style={{width:6,height:6,borderRadius:'50%',background:'#39ff88',animation:'rw-green-pulse 1.6s ease infinite'}} /><span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#39ff88',letterSpacing:2}}>LIVE</span></div>
                    <span style={{fontFamily:'Orbitron,monospace',fontSize:13,fontWeight:800,color:'#39ff88',letterSpacing:2}}>WEEK LEADERBOARD</span>
                    {lbEntries.length>0&&<span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#cc88ff',background:'rgba(140,50,255,.1)',border:'1px solid rgba(140,50,255,.25)',padding:'2px 8px',borderRadius:4}}>{lbEntries.length} WALLETS</span>}
                    {w.startDate&&<span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#8a9aaa',padding:'2px 8px',background:'rgba(140,60,255,.04)',border:'1px solid rgba(140,60,255,.1)',borderRadius:4}}>{new Date(w.startDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})} → {w.endDate?new Date(w.endDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'—'}</span>}
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    {lbFetchedAt&&<span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#aabbcc'}}>↻ {lbFetchedAt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}
                    <button onClick={loadLb} disabled={lbLoading} style={{background:'rgba(57,255,136,.06)',border:'1px solid rgba(57,255,136,.2)',color:'#39ff88',padding:'4px 12px',fontFamily:'Orbitron,monospace',fontSize:8,borderRadius:6,cursor:lbLoading?'not-allowed':'pointer',opacity:lbLoading?.5:1}}>↺ REFRESH</button>
                  </div>
                </div>
                {lbLoading&&lbEntries.length===0&&(<div style={{display:'flex',alignItems:'center',gap:10,padding:14,background:'rgba(140,60,255,.04)',borderRadius:8,marginBottom:12}}><div style={{width:18,height:18,border:'2px solid rgba(140,60,255,.2)',borderTop:'2px solid #aa44ff',borderRadius:'50%',animation:'rw-pulse .7s linear infinite'}} /><span style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#aabbcc'}}>{lbProgress}</span></div>)}
                {lbEntries.length>0&&(<>
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'30px 1fr 70px 70px':'42px 1fr 120px 80px 120px',gap:8,padding:'4px 14px 8px',borderBottom:'1px solid rgba(120,60,255,.1)',marginBottom:6}}>
                    {(isMobile?['#','WALLET','BURNED','LB PTS']:['#','WALLET','BRAINS BURNED','⚡ AMP','LB PTS']).map(h=><div key={h} style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?7:8,color:'#aabbcc',letterSpacing:2}}>{h}</div>)}
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:4}}>
                    {lbEntries.slice(0,10).map((e,i)=>(<LbRow key={e.address} entry={e} rank={i+1} isYou={e.address===wa} isMobile={isMobile} delay={0.03*i} totalAmp={totalAmp} />))}
                  </div>
                  {myRank&&myRank>10&&(<><div style={{textAlign:'center',padding:'8px',fontFamily:'Orbitron,monospace',fontSize:9,color:'#7a8a9a',letterSpacing:3}}>· · · · ·</div><LbRow entry={lbEntries[myRank-1]} rank={myRank} isYou isMobile={isMobile} delay={0} totalAmp={totalAmp} /></>)}
                </>)}
                {!lbLoading&&lbEntries.length===0&&(<div style={{textAlign:'center',padding:'30px 20px'}}><div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#39ff88',letterSpacing:2,marginBottom:8}}>{isPaused?'⏸ CHALLENGE PAUSED':'SCANNING CHAIN FOR BURNS...'}</div><div style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#8a9aaa'}}>Leaderboard updates from on-chain burn data</div></div>)}
                {lbEntries.length>0&&(<div style={{textAlign:'center',marginTop:12,fontFamily:'Sora,sans-serif',fontSize:10,color:'#7a8a9a',lineHeight:1.5}}>Only burns made during the active challenge period count toward weekly LB Points.{w.startDate&&<span style={{color:'#8a9aaa'}}> Burns before {new Date(w.startDate).toLocaleDateString()} are not included.</span>}</div>)}
              </div>
            </div>

            {/* AMPLIFIER STACK — bottom reference */}
            <div style={{...pan('rgba(140,60,255,.1)'),padding:0}}>
              <GridBg /><div style={{position:'relative',zIndex:1,padding:'14px 18px'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                  <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#cc88ff',letterSpacing:2}}>📐 AMPLIFIER STACK</span>
                  <span style={{fontFamily:'Orbitron,monospace',fontSize:16,fontWeight:900,background:'linear-gradient(135deg,#ff9933,#ffcc55)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',backgroundClip:'text',filter:'drop-shadow(0 0 10px rgba(255,140,0,.4))'}}>+{totalAmp.toFixed(2)}%</span>
                </div>
                <div style={{height:6,background:'rgba(140,60,255,.08)',borderRadius:3,overflow:'hidden',position:'relative'}}><div style={{height:'100%',width:`${Math.min(totalAmp/7.25*100,100)}%`,background:'linear-gradient(90deg,#39ff88,#ffcc55,#ff5500,#cc00ff)',borderRadius:3,animation:'rw-bar-fill 1s ease both'}} /></div>
                <div style={{display:'flex',gap:6,marginTop:8,flexWrap:'wrap'}}>
                  {[1,2,3,4].map(t=><span key={t} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:TIER_CFG[t].color,padding:'2px 8px',background:TIER_CFG[t].bg,border:`1px solid ${TIER_CFG[t].border}`,borderRadius:4}}>T{t}: +{TIER_AMPS[t].toFixed(2)}%</span>)}
                </div>
                <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#8a9aaa',marginTop:8,lineHeight:1.5}}>
                  Each BRAINS burned = <span style={{color:'#ff9933'}}>1.888 weekly LB Points</span>. Complete tier challenges to stack amplifier bonuses. Formula: <span style={{color:'#fff'}}>Final Points = (Burns × 1.888) × (1 + Σ amplifiers)</span>. <span style={{color:'#39ff88',textShadow:'0 0 6px rgba(57,255,136,.2)'}}> Top 3 burners by LB Points win automatically</span> when the challenge ends.
                </div>
                <div style={{marginTop:8,padding:'8px 12px',background:'rgba(57,255,136,.04)',border:'1px solid rgba(57,255,136,.12)',borderRadius:8}}>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88',letterSpacing:2,marginBottom:4}}>⚡ GLOBAL LEDGER BOOST</div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#8899aa',lineHeight:1.6}}>
                    The extra amplifier LB Points you earn during the weekly challenge are <span style={{color:'#39ff88',fontWeight:700}}>added to your global 🧪 Lab Work score</span> in the Incinerator Protocol — helping you climb tiers faster! Amplifiers <span style={{color:'#ff9933',fontWeight:700}}>do not stack across weeks</span> — only your highest single-week amp bonus counts toward your global score.
                  </div>
                </div>
              </div>
            </div>
          </>)}

          {/* INACTIVE STATE */}
          {!isLive&&(
            <div style={{...pan('rgba(120,60,255,.1)'),padding:0}}>
              <GridBg /><ScanLine />
              <div style={{position:'relative',zIndex:1,padding:isMobile?'20px 14px':'30px 28px'}}>
                {lastLog&&lastLog.winners&&lastLog.winners.length>0?(
                  <div>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?13:16,color:'#ffd700',letterSpacing:3,marginBottom:6,textAlign:'center'}}>🏆 LAST CHALLENGE WINNERS</div>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?10:11,color:'#8a9aaa',letterSpacing:2,marginBottom:16,textAlign:'center'}}>{lastLog.weekId} · Ended {new Date(lastLog.stoppedAt).toLocaleDateString()}</div>
                    <div style={{display:'flex',gap:isMobile?8:12,alignItems:'flex-end',marginBottom:20}}>
                      {[lastLog.winners.find((w:any)=>w.place===1),lastLog.winners.find((w:any)=>w.place===0),lastLog.winners.find((w:any)=>w.place===2)].filter(Boolean).map((wn:any)=>{
                        const rank=wn.place+1;const cfg=POD_CFG[wn.place];const isTop=wn.place===0;const imgSize=isMobile?(isTop?80:60):(isTop?100:80);
                        return(
                          <div key={wn.place} style={{flex:1,position:'relative',overflow:'hidden',background:'linear-gradient(160deg,#06040e,#08060f)',border:`1px solid ${cfg.border}${isTop?'88':'55'}`,borderTop:`3px solid ${cfg.border}`,borderRadius:12,padding:isMobile?'12px 8px':'16px 14px',minHeight:isTop?(isMobile?240:280):(isMobile?200:240),display:'flex',flexDirection:'column',alignItems:'center'}}>
                            <GridBg />
                            <div style={{textAlign:'center',marginBottom:6,position:'relative',zIndex:2}}>
                              <div style={{fontSize:isTop?28:20,filter:`drop-shadow(0 0 10px ${cfg.border}88)`}}>{rank===1?'👑':rank===2?'🥈':'🥉'}</div>
                              <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:10,fontWeight:700,color:cfg.label,letterSpacing:3,marginTop:3}}>{cfg.rank}</div>
                            </div>
                            <div style={{position:'relative',zIndex:2,marginBottom:8}}>
                              <div style={{position:'absolute',inset:-3,borderRadius:'50%',border:`2px solid ${cfg.border}44`,boxShadow:`0 0 16px ${cfg.border}33`,animation:`${cfg.glow} 2.5s ease infinite`,pointerEvents:'none'}}/>
                              <div style={{width:imgSize,height:imgSize,borderRadius:'50%',overflow:'hidden',border:`3px solid ${cfg.border}`,background:'#0a0a14'}}><img src={PODIUM_IMAGES[rank].src} alt="" style={{width:'100%',height:'100%',objectFit:'cover',objectPosition:'center top',transform:`scale(${PODIUM_IMAGES[rank].scale})`}} onError={e=>{(e.target as HTMLImageElement).style.display='none';}}/></div>
                            </div>
                            <div style={{fontFamily:'monospace',fontSize:isMobile?11:13,color:cfg.label,marginBottom:3,position:'relative',zIndex:2}}>{short(wn.address)}</div>
                            <button onClick={()=>navigator.clipboard.writeText(wn.address)} style={{marginBottom:6,background:`${cfg.border}10`,border:`1px solid ${cfg.border}30`,color:cfg.label,padding:'4px 10px',fontFamily:'Orbitron,monospace',fontSize:isMobile?7:8,borderRadius:5,cursor:'pointer',letterSpacing:1,position:'relative',zIndex:2}}>📋 COPY</button>
                            <div style={{display:'flex',flexDirection:'column',gap:5,width:'100%',marginTop:'auto',position:'relative',zIndex:2}}>
                              <div style={{display:'flex',justifyContent:'space-between',padding:'6px 10px',background:'rgba(255,140,0,.06)',borderRadius:6}}><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:10,color:'#ff9933'}}>🔥 BURNED</span><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?11:13,fontWeight:700,color:'#ff9933'}}>{fmtN(wn.weeklyBurned||0,1)}</span></div>
                              {wn.weeklyBurned&&<div style={{display:'flex',justifyContent:'space-between',padding:'5px 10px',background:'rgba(140,60,255,.04)',borderRadius:6}}><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?7:8,color:'#aa88cc'}}>BASE (1.888×{fmtN(wn.weeklyBurned||0,0)})</span><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?10:11,color:'#aa88cc'}}>{fmtPts(Math.floor((wn.weeklyBurned||0)*1.888))}</span></div>}
                              {wn.ampPct>0&&<div style={{display:'flex',justifyContent:'space-between',padding:'5px 10px',background:'rgba(57,255,136,.04)',borderRadius:6}}><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?7:8,color:'#39ff88'}}>⚡ AMP +{(wn.ampPct||0).toFixed(2)}%</span><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?10:11,fontWeight:700,color:'#39ff88'}}>+{fmtPts(Math.max(0,(wn.weeklyPts||0)-Math.floor((wn.weeklyBurned||0)*1.888)))}</span></div>}
                              <div style={{display:'flex',justifyContent:'space-between',padding:'6px 10px',background:`${cfg.border}0a`,borderRadius:6,border:`1px solid ${cfg.border}18`}}><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?9:10,color:cfg.label,fontWeight:700}}>◆ FINAL PTS</span><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?13:15,fontWeight:900,color:cfg.label}}>{fmtPts(wn.weeklyPts||0)}</span></div>
                              {(wn.prizes||[]).length>0&&<div style={{display:'flex',gap:4,flexWrap:'wrap',justifyContent:'center',marginTop:2}}>{(wn.prizes||[]).map((p:PrizeItem,j:number)=>(<span key={j} style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:9,color:p.isNFT?'#ffd700':TK[p.token]?.c||'#fff',padding:'2px 7px',background:'rgba(255,255,255,.04)',borderRadius:4}}>{p.isNFT?`🖼️ ${p.nftName||'NFT'}`:`${fmtN(p.amount,0)} ${p.token}`}</span>))}</div>}
                              {(()=>{const receipts=lastLog?.sendReceipts||[];const paid=receipts.find((rx:SendReceipt)=>rx.place===wn.place);return paid?<div style={{textAlign:'center',padding:'5px 8px',background:'rgba(57,255,136,.08)',border:'1px solid rgba(57,255,136,.2)',borderRadius:6}}><span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?9:10,color:'#39ff88',fontWeight:700}}>✅ PRIZE PAID</span></div>:null;})()}
                            </div>
                          </div>);
                      })}
                    </div>
                    {lastLog.sendReceipts&&lastLog.sendReceipts.length>0&&(<div style={{marginTop:8}}><div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?10:11,color:'#39ff88',letterSpacing:3,marginBottom:10,textAlign:'center'}}>✅ PRIZES SENT — VERIFIED ON CHAIN</div>{lastLog.sendReceipts.map((r:SendReceipt,i:number)=>(<ReceiptCard key={i} receipt={r} brainsPrice={brainsPrice} xntPrice={xntPrice} isMobile={isMobile} />))}</div>)}
                    <div style={{textAlign:'center',marginTop:16,fontFamily:'Sora,sans-serif',fontSize:11,color:'#7a8a9a'}}>Next challenge coming soon. Check back for new challenges!</div>
                  </div>
                ):(
                  <div style={{textAlign:'center',padding:'40px 20px'}}>
                    <div style={{fontSize:40,marginBottom:12,opacity:0.2}}>🔥</div>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:14,color:'#cc88ff',letterSpacing:3,marginBottom:8}}>NO ACTIVE CHALLENGE</div>
                    <div style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#7a8a9a',maxWidth:400,margin:'0 auto',lineHeight:1.6}}>There's no weekly burn challenge running right now. When the admin starts a new challenge, you'll see the challenges, prizes, and leaderboard here.</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* CHALLENGE HISTORY */}
          {logs.length>0&&(
            <div style={{...pan('rgba(140,60,255,.08)'),padding:0}}>
              <GridBg /><div style={{position:'relative',zIndex:1,padding:isMobile?'16px 12px':'20px 24px'}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#cc88ff',letterSpacing:3,marginBottom:14}}>📜 PAST CHALLENGES</div>
                {logs.slice(0,5).map((lg:ChallengeLog,i:number)=>{
                  let totalUsd=0;if(lg.sendReceipts){for(const r of lg.sendReceipts)for(const it of r.items){if(!it.isNFT){if(it.token==='BRAINS'&&brainsPrice)totalUsd+=it.amount*brainsPrice;if(it.token==='XNT'&&xntPrice)totalUsd+=it.amount*xntPrice;}}}
                  return(
                  <div key={i} style={{padding:'14px 16px',background:'rgba(0,0,0,.15)',border:'1px solid rgba(120,60,255,.06)',borderRadius:10,marginBottom:10}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6,flexWrap:'wrap',gap:6}}>
                      <span style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,color:'#fff',letterSpacing:2}}>{lg.weekId}</span>
                      <span style={{fontFamily:'Sora,sans-serif',fontSize:8,color:'#8a9aaa'}}>{lg.startDate?new Date(lg.startDate).toLocaleDateString():''} → {lg.stoppedAt?new Date(lg.stoppedAt).toLocaleDateString():''}</span>
                    </div>
                    <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:6}}>
                      {(lg.challenges||[]).map((c:any,j:number)=>{const tc=TIER_CFG[c.tier as 1|2|3|4];return <span key={j} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:tc?.color,padding:'2px 6px',background:tc?.bg,border:`1px solid ${tc?.border}`,borderRadius:3}}>{c.icon} {c.title}</span>;})}
                    </div>
                    {lg.winners&&lg.winners.length>0&&(<div style={{display:'flex',gap:isMobile?6:10,flexWrap:'wrap',marginBottom:8}}>
                      {[...lg.winners].sort((a:any,b:any)=>a.place-b.place).map((wn:any,j:number)=>{
                        const cl=wn.place===0?'#ffd700':wn.place===1?'#cc88ff':'#39ff88';const medal=['🥇','🥈','🥉'][wn.place];const placeL=['1ST','2ND','3RD'][wn.place];
                        return(<div key={j} style={{flex:1,minWidth:isMobile?'100%':180,padding:'10px 12px',background:`${cl}06`,border:`1px solid ${cl}18`,borderLeft:`3px solid ${cl}`,borderRadius:8}}>
                          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}><span style={{fontSize:16}}>{medal}</span><span style={{fontFamily:'Orbitron,monospace',fontSize:8,fontWeight:700,color:cl,letterSpacing:2}}>{placeL}</span><span style={{fontFamily:'monospace',fontSize:10,color:'#b0c4cc',marginLeft:'auto'}}>{short(wn.address)}</span></div>
                          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#8a9aaa'}}>WEEKLY LB PTS</span><span style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:900,color:cl}}>{fmtPts(wn.weeklyPts||0)}</span></div>
                          {wn.ampPct>0&&<div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#8a9aaa'}}>AMPLIFIER</span><span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#ff9933'}}>+{wn.ampPct.toFixed(2)}%</span></div>}
                          {(wn.prizes||[]).length>0&&<div style={{display:'flex',gap:4,flexWrap:'wrap',marginTop:4}}>{(wn.prizes||[]).map((p:PrizeItem,pi:number)=>(<span key={pi} style={{fontFamily:'Orbitron,monospace',fontSize:8,color:p.isNFT?'#ffd700':TK[p.token]?.c||'#fff',padding:'2px 6px',background:'rgba(255,255,255,.04)',border:`1px solid ${p.isNFT?'rgba(255,215,0,.15)':(TK[p.token]?.c||'#fff')+'15'}`,borderRadius:4}}>{p.isNFT?`🖼️ ${p.nftName||'NFT'}`:`${fmtN(p.amount,1)} ${p.token}`}</span>))}</div>}
                        </div>);})}
                    </div>)}
                    {lg.sendReceipts&&lg.sendReceipts.length>0&&(<div style={{marginTop:6,padding:'8px 10px',background:'rgba(57,255,136,.03)',border:'1px solid rgba(57,255,136,.08)',borderRadius:8}}>
                      <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88',letterSpacing:2,marginBottom:6}}>✅ PRIZES DISTRIBUTED</div>
                      {lg.sendReceipts.map((r:SendReceipt,ri:number)=>{const cl=r.place===0?'#ffd700':r.place===1?'#cc88ff':'#39ff88';return(
                        <div key={ri} style={{display:'flex',alignItems:'center',gap:6,marginBottom:4,flexWrap:'wrap'}}>
                          <span style={{fontSize:12}}>{['🥇','🥈','🥉'][r.place]}</span><span style={{fontFamily:'monospace',fontSize:9,color:'#b0c4cc'}}>{short(r.wallet)}</span><span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:cl}}>→</span>
                          {r.items.map((it,ii)=>(<span key={ii} style={{fontFamily:'Orbitron,monospace',fontSize:8,color:it.isNFT?'#ffd700':TK[it.token]?.c||'#fff'}}>{it.isNFT?`🖼️${it.nftName||'NFT'}`:`${fmtN(it.amount,1)} ${it.token}`}</span>))}
                          <a href={`${EXPLORER}${r.txSig}`} target="_blank" rel="noopener noreferrer" style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#aa77ff',textDecoration:'none',padding:'1px 6px',background:'rgba(140,60,255,.06)',border:'1px solid rgba(140,60,255,.15)',borderRadius:3}}>↗ TX</a>
                        </div>);})}
                      {totalUsd>0&&<div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#00c98d',marginTop:4}}>💰 Total: ≈ ${totalUsd.toFixed(2)} USD (at current BRAINS price)</div>}
                    </div>)}
                  </div>);})}
              </div>
            </div>
          )}
        </div>)}

        {/* TAB: LAB WORK */}
        {activeTab==='labwork'&&(<LabWorkSection isMobile={isMobile} />)}

      </div><Footer />
    </div>
  );
};

export default RewardsSeason;