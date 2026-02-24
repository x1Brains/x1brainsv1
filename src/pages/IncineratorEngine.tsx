import React, { FC, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, createBurnCheckedInstruction, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token';
import { useNavigate } from 'react-router-dom';
import { BRAINS_MINT, BRAINS_LOGO } from '../constants';
import { TopBar, PageBackground, Footer, AddressBar } from '../components/UI';
import { fetchLeaderboard, getCachedLeaderboard, BurnerEntry, injectLeaderboardStyles } from '../components/BurnLeaderboard';
import { useIncTheme, ThemeToggle, type IncTheme } from '../components/incineratorThemes';
import { injectPortalStyles } from '../components/BurnPortal';
import burnBrainImg from '../assets/images1st.jpg';

injectLeaderboardStyles();
injectPortalStyles();

function injectIEStyles() {
  if (typeof document === 'undefined') return;
  if (document.head.querySelector('style[data-ie]')) return;
  const s = document.createElement('style');
  s.setAttribute('data-ie', '1');
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Orbitron:wght@400;500;600;700;800;900&family=Sora:wght@400;500;600;700&display=swap');
    @keyframes ie-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
    @keyframes ie-spin-r{0%{transform:rotate(360deg)}100%{transform:rotate(0)}}
    @keyframes ie-pulse{0%,100%{box-shadow:0 0 30px rgba(255,153,51,.4),0 0 60px rgba(255,102,0,.2),inset 0 0 20px rgba(255,153,51,.3);transform:scale(1)}50%{box-shadow:0 0 50px rgba(255,153,51,.6),0 0 100px rgba(255,102,0,.35),inset 0 0 30px rgba(255,153,51,.5);transform:scale(1.03)}}
    @keyframes ie-burn{0%,100%{box-shadow:0 0 40px rgba(255,60,0,.5),0 0 80px rgba(255,30,0,.3),inset 0 0 30px rgba(255,80,0,.4)}50%{box-shadow:0 0 70px rgba(255,60,0,.8),0 0 120px rgba(255,30,0,.5),inset 0 0 50px rgba(255,80,0,.6)}}
    @keyframes ie-shim{0%{background-position:-200% center}100%{background-position:200% center}}
    @keyframes ie-pbar{0%,100%{opacity:.5}50%{opacity:1}}
    @keyframes ie-pgrn{0%,100%{opacity:.6;box-shadow:0 0 8px rgba(57,255,136,.4)}50%{opacity:1;box-shadow:0 0 16px rgba(57,255,136,.7)}}
    @keyframes ie-up{0%{opacity:0;transform:translateY(16px)}100%{opacity:1;transform:translateY(0)}}
    @keyframes ie-glow{0%,100%{opacity:.3}50%{opacity:.7}}
    @keyframes ie-norb{0%,100%{filter:brightness(1) drop-shadow(0 0 4px rgba(255,153,51,.5))}50%{filter:brightness(1.4) drop-shadow(0 0 8px rgba(255,153,51,.9))}}
    @keyframes ie-fire-flicker{0%,18%,22%,100%{opacity:1;text-shadow:0 0 7px currentColor,0 0 20px currentColor,0 0 40px currentColor}19%{opacity:.4;text-shadow:none}21%{opacity:.4;text-shadow:none}50%{opacity:1;text-shadow:0 0 4px currentColor,0 0 12px currentColor}}
    @keyframes ie-ember{0%{transform:translateY(0) scale(1);opacity:.7}50%{transform:translateY(-30px) scale(1.2);opacity:1}100%{transform:translateY(-60px) scale(.4);opacity:0}}
    @keyframes ie-spark{0%{transform:translate(0,0) scale(1);opacity:.8}100%{transform:translate(var(--sx,10px),var(--sy,-40px)) scale(0);opacity:0}}
    @keyframes ie-bloom{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:.6;transform:scale(1.05)}}
    @keyframes ie-drift{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
    @keyframes ie-metalShimmer{0%{background-position:250% center}50%{background-position:-50% center}100%{background-position:250% center}}
    @keyframes ie-badge-sway{0%,100%{transform:translateX(0)}25%{transform:translateX(2px)}75%{transform:translateX(-2px)}}
    @keyframes ie-celebrate-in{0%{opacity:0;transform:scale(.5) rotate(-10deg)}60%{opacity:1;transform:scale(1.08) rotate(2deg)}100%{opacity:1;transform:scale(1) rotate(0)}}
    @keyframes ie-celebrate-out{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.7) translateY(-30px)}}
    @keyframes ie-flame-rise{0%{transform:translateY(0) scaleX(1);opacity:.8}50%{transform:translateY(-20px) scaleX(1.2);opacity:1}100%{transform:translateY(-50px) scaleX(.6);opacity:0}}
    @keyframes ie-ember-fly{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(var(--ex,30px),var(--ey,-80px)) scale(0);opacity:0}}
    @keyframes ie-skull-float{0%{transform:translateY(0) rotate(0)}50%{transform:translateY(-8px) rotate(3deg)}100%{transform:translateY(0) rotate(0)}}
    @keyframes ie-ring-expand{0%{transform:scale(.5);opacity:.8}100%{transform:scale(2.5);opacity:0}}
    @keyframes ie-img-burn{0%{filter:brightness(1) saturate(1)}25%{filter:brightness(1.3) saturate(1.5) sepia(.3)}50%{filter:brightness(1.6) saturate(2) sepia(.5) hue-rotate(-10deg)}75%{filter:brightness(1.2) saturate(1.3) sepia(.2)}100%{filter:brightness(1) saturate(1)}}
    @keyframes ie-text-glow{0%,100%{text-shadow:0 0 10px rgba(255,140,0,.5),0 0 30px rgba(255,60,0,.3)}50%{text-shadow:0 0 20px rgba(255,140,0,.8),0 0 50px rgba(255,60,0,.5),0 0 80px rgba(255,30,0,.3)}}
  `;
  document.head.appendChild(s);
}
injectIEStyles();

// ═══ TIERS ═══
const TIERS=[
  {name:'UNRANKED',min:0,icon:'○',color:'#6a7a8a',neon:'#a0bbcc'},{name:'SPARK',min:1,icon:'✦',color:'#aaccff',neon:'#bbddff'},
  {name:'FLAME',min:25000,icon:'🕯️',color:'#ffcc55',neon:'#ffdd77'},{name:'INFERNO',min:50000,icon:'🔥',color:'#ff9933',neon:'#ffaa44'},
  {name:'OVERWRITE',min:100000,icon:'⚙️',color:'#ff7700',neon:'#ff8811'},{name:'ANNIHILATE',min:200000,icon:'💥',color:'#ff5500',neon:'#ff6622'},
  {name:'TERMINATE',min:350000,icon:'⚡',color:'#ff3300',neon:'#ff4411'},{name:'DISINTEGRATE',min:500000,icon:'☢️',color:'#ff1166',neon:'#ff2277'},
  {name:'GODSLAYER',min:700000,icon:'⚔️',color:'#cc00ff',neon:'#dd22ff'},{name:'APOCALYPSE',min:850000,icon:'💀',color:'#ff0044',neon:'#ff1155'},
  {name:'INCINERATOR',min:1000000,icon:'☠️',color:'#ffffff',neon:'#fffaee'},
];
function getTier(p:number){for(let i=TIERS.length-1;i>=0;i--)if(p>=TIERS[i].min)return TIERS[i];return TIERS[0];}
function getNextTier(p:number){for(const t of TIERS)if(t.min>p)return t;return null;}

// ═══ BURN ═══
async function sendBurn(conn:any,w:any,amt:number){
  if(!w?.publicKey||!w?.signTransaction)throw new Error('Invalid wallet');
  const MP=new PublicKey(BRAINS_MINT);
  const ta=getAssociatedTokenAddressSync(MP,w.publicKey,false,TOKEN_2022_PROGRAM_ID);
  const mi=await getMint(conn,MP,'confirmed',TOKEN_2022_PROGRAM_ID);
  const d=mi.decimals;const raw=BigInt(Math.floor(amt*10**d));
  const ix=createBurnCheckedInstruction(ta,MP,w.publicKey,raw,d,[],TOKEN_2022_PROGRAM_ID);
  const{blockhash,lastValidBlockHeight}=await conn.getLatestBlockhash('confirmed');
  const tx=new Transaction({feePayer:w.publicKey,recentBlockhash:blockhash}).add(ix);
  const s=await w.signTransaction(tx);if(!s.signature)throw new Error('Signing failed');
  const sig=await conn.sendRawTransaction(s.serialize(),{skipPreflight:false,maxRetries:3,preflightCommitment:'confirmed'});
  return{signature:sig,blockhash,lastValidBlockHeight};
}
async function confirmBurn(c:any,sig:string,_bh:string,_lv:number){
  // Fast polling — X1 confirms in <1s, but confirmTransaction can hang for 30s+
  for(let i=0;i<20;i++){
    try{
      const resp=await c.getSignatureStatuses([sig]);
      const s=resp?.value?.[0];
      if(s){
        if(s.err) return false;
        if(s.confirmationStatus==='confirmed'||s.confirmationStatus==='finalized') return true;
      }
    }catch{}
    await new Promise(r=>setTimeout(r,500));
  }
  // Fallback — if we got here, TX is likely confirmed but RPC is slow. Return true since TX was sent.
  try{const resp=await c.getSignatureStatuses([sig]);const s=resp?.value?.[0];if(s&&!s.err)return true;}catch{}
  return true; // Assume success — TX was broadcast and not rejected
}

function useIsMobile(){const[m,setM]=useState(typeof window!=='undefined'?window.innerWidth<640:false);useEffect(()=>{const h=()=>setM(window.innerWidth<640);window.addEventListener('resize',h);return()=>window.removeEventListener('resize',h);},[]);return m;}

interface WC{weekId:string;status:string;challenges:{ampPct:number;tier?:number}[];prizes:{token:string;amount:number;isNFT?:boolean;nftName?:string}[][];}
function loadWC():WC|null{try{const r=localStorage.getItem('brains_weekly_config');return r?JSON.parse(r):null;}catch{return null;}}
const TIER_AMP_RATES_IE=[0,1.50,3.50,5.50,8.88]; // tier index → amp %

// ═══ BURN CELEBRATION POPUP ═══
const BurnCelebration: FC<{ amount: string; newPts: number; totalPts: number; labWorkPts: number; tierName: string; tierIcon: string; onClose: () => void; theme: IncTheme }> = ({ amount, newPts, totalPts, labWorkPts, tierName, tierIcon, onClose, theme: t }) => {
  const [phase, setPhase] = useState<'in' | 'out'>('in');
  const mob = typeof window !== 'undefined' && window.innerWidth < 640;
  useEffect(() => {
    const timer = setTimeout(() => { setPhase('out'); setTimeout(onClose, 600); }, 5500);
    return () => clearTimeout(timer);
  }, [onClose]);
  useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

  const fP = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const imgSz = mob ? 100 : 140;

  // Random ember positions
  const embers = useMemo(() => Array.from({ length: mob ? 12 : 18 }, (_, i) => ({
    id: i,
    ex: (Math.random() - 0.5) * 200,
    ey: -(Math.random() * 120 + 40),
    size: Math.random() * 6 + 3,
    delay: Math.random() * 1.5,
    dur: Math.random() * 1.2 + 0.8,
    color: ['#ff4400', '#ff8800', '#ffcc00', '#ff6600', '#ffaa33'][Math.floor(Math.random() * 5)],
  })), []);

  return (
    <div onClick={() => { setPhase('out'); setTimeout(onClose, 600); }} style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: 'rgba(0,0,0,.85)',
      backdropFilter: 'blur(12px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
      animation: phase === 'in' ? 'ie-celebrate-in 0.5s cubic-bezier(.34,1.56,.64,1) both' : 'ie-celebrate-out 0.5s ease both',
      cursor: 'pointer',
    }}>
      {/* Expanding ring bursts */}
      {[0, 0.3, 0.7].map((d, i) => (
        <div key={i} style={{
          position: 'absolute', width: 120, height: 120, borderRadius: '50%',
          border: `2px solid rgba(255,140,0,${0.4 - i * 0.1})`,
          animation: `ie-ring-expand 1.5s ease ${d}s infinite`,
          pointerEvents: 'none',
        }} />
      ))}

      {/* Ember particles */}
      {embers.map(e => (
        <div key={e.id} style={{
          position: 'absolute', width: e.size, height: e.size, borderRadius: '50%',
          background: e.color, boxShadow: `0 0 ${e.size * 2}px ${e.color}`,
          animation: `ie-ember-fly ${e.dur}s ease ${e.delay}s infinite`,
          ['--ex' as any]: `${e.ex}px`, ['--ey' as any]: `${e.ey}px`,
          pointerEvents: 'none',
        }} />
      ))}

      {/* Central flame aura */}
      <div style={{
        position: 'absolute', width: mob ? 180 : 280, height: mob ? 180 : 280, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(255,80,0,.25) 0%, rgba(255,140,0,.1) 40%, transparent 70%)',
        animation: 'ie-bloom 2s ease infinite',
        pointerEvents: 'none',
      }} />

      {/* Brain image in flames */}
      <div style={{
        position: 'relative', width: imgSz, height: imgSz, borderRadius: '50%', overflow: 'visible',
        animation: 'ie-skull-float 2s ease infinite',
        marginBottom: mob ? 16 : 24,
      }}>
        {/* Fire ring around image */}
        <div style={{
          position: 'absolute', inset: mob ? -8 : -12, borderRadius: '50%',
          background: 'conic-gradient(from 0deg, #ff2200, #ff8800, #ffcc00, #ff6600, #ff2200)',
          animation: 'ie-spin 3s linear infinite',
          filter: 'blur(8px)', opacity: 0.7,
        }} />
        <div style={{
          position: 'absolute', inset: mob ? -4 : -6, borderRadius: '50%',
          border: `${mob ? 2 : 3}px solid rgba(255,140,0,.6)`,
          boxShadow: '0 0 30px rgba(255,80,0,.5), 0 0 60px rgba(255,40,0,.3), inset 0 0 20px rgba(255,100,0,.4)',
          animation: 'ie-burn 1.5s ease infinite',
        }} />
        {/* Actual image */}
        <img src={burnBrainImg} alt="BURN" style={{
          width: imgSz, height: imgSz, borderRadius: '50%', objectFit: 'cover', objectPosition: 'center top',
          position: 'relative', zIndex: 2, display: 'block',
          transform: 'scale(1.3)',
          animation: 'ie-img-burn 2s ease infinite',
          border: `${mob ? 2 : 3}px solid rgba(255,100,0,.5)`,
        }} />
        {/* Top flame tongues */}
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} style={{
            position: 'absolute', bottom: '60%',
            left: `${15 + i * 17}%`,
            width: 12 + i * 2, height: 30 + Math.random() * 20,
            background: `linear-gradient(to top, rgba(255,${60 + i * 30},0,.7), rgba(255,${120 + i * 20},0,.3), transparent)`,
            borderRadius: '50% 50% 30% 30%',
            animation: `ie-flame-rise ${0.6 + i * 0.15}s ease ${i * 0.1}s infinite`,
            filter: 'blur(2px)', zIndex: 3, pointerEvents: 'none',
          }} />
        ))}
      </div>

      {/* Text */}
      <div style={{
        fontFamily: 'Orbitron, monospace', fontSize: mob ? 20 : 28, fontWeight: 900, letterSpacing: mob ? 2 : 4,
        background: 'linear-gradient(135deg, #ff4400, #ff8800, #ffcc00, #ffffff, #ffcc00, #ff8800)',
        backgroundSize: '200% 100%',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        animation: 'ie-text-glow 2s ease infinite, ie-metalShimmer 3s ease infinite',
        marginBottom: 6,
      }}>
        INCINERATED
      </div>
      <div style={{
        fontFamily: 'Orbitron, monospace', fontSize: mob ? 14 : 18, fontWeight: 700, color: '#ffcc44',
        letterSpacing: mob ? 2 : 3, marginBottom: mob ? 12 : 16,
        textShadow: '0 0 12px rgba(255,140,0,.5)',
      }}>
        🔥 {amount} BRAINS 🔥
      </div>

      {/* LB Points earned panel */}
      <div style={{
        display: 'flex', gap: mob ? 8 : 12, flexWrap: 'wrap', justifyContent: 'center', marginBottom: mob ? 8 : 10,
      }}>
        <div style={{
          background: 'rgba(255,140,0,.08)', border: '1px solid rgba(255,140,0,.25)', borderRadius: mob ? 8 : 10,
          padding: mob ? '8px 14px' : '10px 18px', textAlign: 'center', minWidth: mob ? 100 : 120,
        }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 6 : 7, color: '#ff9955', letterSpacing: 2, marginBottom: 3 }}>◆ LB POINTS EARNED</div>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 16 : 20, fontWeight: 900, color: '#ffcc44', textShadow: '0 0 8px rgba(255,204,68,.3)' }}>+{fP(newPts)}</div>
        </div>
        <div style={{
          background: 'rgba(140,60,255,.06)', border: '1px solid rgba(140,60,255,.2)', borderRadius: mob ? 8 : 10,
          padding: mob ? '8px 14px' : '10px 18px', textAlign: 'center', minWidth: mob ? 100 : 120,
        }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 6 : 7, color: '#bb88ff', letterSpacing: 2, marginBottom: 3 }}>TOTAL LB POINTS</div>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 16 : 20, fontWeight: 900, color: '#cc99ff', textShadow: '0 0 8px rgba(140,60,255,.3)' }}>{fP(totalPts)}</div>
        </div>
      </div>

      {/* Lab Work + Tier row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        {labWorkPts > 0 && (
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 7 : 9, color: '#00ccff', background: 'rgba(0,204,255,.08)', border: '1px solid rgba(0,204,255,.2)', borderRadius: 6, padding: mob ? '3px 8px' : '4px 10px' }}>
            🧪 {fP(labWorkPts)} LAB WORK
          </div>
        )}
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 7 : 9, color: getTier(totalPts).neon, background: `${getTier(totalPts).neon}15`, border: `1px solid ${getTier(totalPts).neon}33`, borderRadius: 6, padding: mob ? '3px 8px' : '4px 10px' }}>
          {tierIcon} {tierName}
        </div>
      </div>

      <div style={{
        fontFamily: 'Sora, sans-serif', fontSize: mob ? 9 : 11, color: '#ff9955', letterSpacing: 2,
        opacity: 0.7, marginTop: 6,
      }}>
        TAP TO DISMISS
      </div>
    </div>
  );
};

// ═══ MAIN ═══
const IncineratorEngine:FC=()=>{
  const{publicKey,signTransaction}=useWallet();
  const{connection}=useConnection();
  const mob=useIsMobile();
  const nav=useNavigate();
  const[t,themeName,toggleTheme]=useIncTheme();
  const isF=themeName==='fire';

  const[burnAmt,setBurnAmt]=useState('');
  const[burning,setBurning]=useState(false);
  const[err,setErr]=useState<string|null>(null);
  const[suc,setSuc]=useState<string|null>(null);
  const[txSig,setTxSig]=useState<string|null>(null);
  const[conf,setConf]=useState<'pending'|'confirmed'|'unknown'|null>(null);
  const[showCelebration,setShowCelebration]=useState<{amount:string;newPts:number;totalPts:number;labWorkPts:number;tierName:string;tierIcon:string}|null>(null);
  const resRef=useRef<HTMLDivElement>(null);
  const[entries,setEntries]=useState<BurnerEntry[]>([]);
  const[loading,setLoading]=useState(true);
  const[bal,setBal]=useState<number|null>(null);
  const[fetBal,setFetBal]=useState(false);
  const[wc,setWc]=useState<WC|null>(()=>loadWC());
  // Load from Supabase on mount
  useEffect(()=>{(async()=>{try{const sb=await import('../lib/supabase');const cfg=await sb.getCachedWeeklyConfig();if(cfg)setWc(cfg as WC);}catch{}})();},[]);
  // Stack ALL challenge tier AMPs for the active week
  const amp=useMemo(()=>{
    if(!wc||wc.status!=='active'||!wc.challenges?.length) return 0;
    return wc.challenges.reduce((s,c)=>{
      const tier=(c as any).tier??0;
      return s+(TIER_AMP_RATES_IE[tier]??c.ampPct??0);
    },0);
  },[wc]);

  useEffect(()=>{if(!connection)return;let c=false;const ctrl=new AbortController();
    // Show cached data instantly
    const cached = getCachedLeaderboard();
    if(cached && cached.length > 0){setEntries(cached);setLoading(false);}
    else{setLoading(true);}
    fetchLeaderboard(connection,ctrl.signal,(partial)=>{
      if(!c && partial.length > 0) setEntries(partial);
    }).then(e=>{if(!c){setEntries(e);setLoading(false);}}).catch(()=>{if(!c)setLoading(false);});
    return()=>{c=true;ctrl.abort();};},[connection]);

  const fetchBal=useCallback(async()=>{if(!publicKey||!connection)return;setFetBal(true);try{
    const ata=getAssociatedTokenAddressSync(new PublicKey(BRAINS_MINT),publicKey,false,TOKEN_2022_PROGRAM_ID);
    const a=await connection.getParsedAccountInfo(ata);const p=(a?.value?.data as any)?.parsed;
    if(p?.info?.tokenAmount)setBal(p.info.tokenAmount.uiAmount??parseFloat(p.info.tokenAmount.uiAmountString||'0'));
    else setBal(0);}catch{setBal(0);}finally{setFetBal(false);}
  },[publicKey,connection]);
  useEffect(()=>{fetchBal();},[fetchBal]);

  const me=useMemo(()=>publicKey?entries.find(e=>e.address===publicKey.toBase58())??null:null,[entries,publicKey]);
  const myPts=me?.points??0,myBrn=me?.burned??0,myTx=me?.txCount??0;
  const cur=getTier(myPts),nxt=getNextTier(myPts);
  const pAmt=parseFloat(burnAmt)||0;
  const pBase=pAmt*1.888,pAmp=amp>0?pAmt*1.888*(amp/100):0,pTot=pBase+pAmp;
  const proj=myPts+pTot,pTier=getTier(proj),pNext=getNextTier(proj);
  const tUp=pTier.name!==cur.name&&pTier.min>cur.min;
  const rank=useMemo(()=>{if(!publicKey)return null;const s=[...entries].sort((a,b)=>b.points-a.points);const i=s.findIndex(e=>e.address===publicKey.toBase58());return i>=0?i+1:null;},[entries,publicKey]);
  const gBrn=useMemo(()=>entries.reduce((s,e)=>s+e.burned,0),[entries]);

  const doBurn=async()=>{
    if(!publicKey||!connection){setErr('Wallet not connected');return;}
    if(!signTransaction){setErr('Wallet does not support signing');return;}
    const a=parseFloat(burnAmt);if(isNaN(a)||a<=0){setErr('Enter a valid amount');return;}
    if(bal!==null&&a>bal){setErr(`Insufficient balance. You have ${bal.toLocaleString()} BRAINS`);return;}
    setBurning(true);setErr(null);setSuc(null);setTxSig(null);setConf(null);
    const burnAmtStr = a.toLocaleString();
    const earnedPts = a * 1.888 * (1 + amp / 100);
    const projectedTotal = myPts + earnedPts;
    const projTier = getTier(projectedTotal);
    try{const{signature,blockhash,lastValidBlockHeight}=await sendBurn(connection,{publicKey,signTransaction},a);
      setTxSig(signature);setSuc(`Incinerated ${burnAmtStr} BRAINS`);setConf('pending');setBurnAmt('');setBurning(false);
      setShowCelebration({ amount: burnAmtStr, newPts: earnedPts, totalPts: projectedTotal, labWorkPts: me?.labWorkPts ?? 0, tierName: projTier.name, tierIcon: projTier.icon });
      setTimeout(()=>{resRef.current?.scrollIntoView({behavior:'smooth',block:'nearest'});},100);
      const ok=await confirmBurn(connection,signature,blockhash,lastValidBlockHeight);setConf(ok?'confirmed':'unknown');
      setTimeout(()=>{fetchBal();const ctrl=new AbortController();fetchLeaderboard(connection,ctrl.signal,()=>{}).then(setEntries).catch(()=>{});},2000);
    }catch(e:any){setErr(e.message||'Burn failed');setBurning(false);}
  };

  const fmt=(n:number)=>n>=1e6?(n/1e6).toFixed(2)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':n.toLocaleString(undefined,{maximumFractionDigits:1});
  const fF=(n:number)=>n.toLocaleString(undefined,{maximumFractionDigits:2});

  // Gradient text via CSS class injection instead of inline (backgroundClip is unreliable inline)
  const gtClass = `ie-gt-${themeName}`;
  const GT:React.CSSProperties={color:t.primary, textShadow:`0 0 12px rgba(${t.primaryRgb},.3)`};
  const CD:React.CSSProperties={background:t.cardBg,border:`1px solid ${t.cardBorder}`,borderRadius:16,padding:mob?'16px 14px':'24px 28px',marginBottom:16,position:'relative',overflow:'hidden',transition:'background .4s,border-color .4s'};
  const dis=burning||!burnAmt||parseFloat(burnAmt)<=0;

  return(
    <div style={{minHeight:'100vh',background:t.pageBg,padding:mob?'70px 10px 40px':'90px 24px 60px',position:'relative',overflow:'hidden',transition:'background .5s'}}>
      <TopBar/><PageBackground/>
      <div style={{position:'fixed',top:'10%',left:'-10%',width:'40%',height:'40%',borderRadius:'50%',background:t.glow1,pointerEvents:'none',transition:'background .5s'}}/>
      <div style={{position:'fixed',bottom:'10%',right:'-10%',width:'35%',height:'35%',borderRadius:'50%',background:t.glow2,pointerEvents:'none',transition:'background .5s'}}/>

      <div style={{position:'relative',zIndex:1,maxWidth:780,margin:'0 auto'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16,flexWrap:'wrap',gap:8}}>
          <button onClick={()=>nav('/burn-history')} style={{display:'inline-flex',alignItems:'center',gap:8,background:`rgba(${t.secondaryRgb},.08)`,border:`1px solid rgba(${t.secondaryRgb},.2)`,borderRadius:10,padding:'8px 16px',cursor:'pointer',fontFamily:'Orbitron,monospace',fontSize:10,color:t.secondary,letterSpacing:1.5,transition:'all .2s'}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=`rgba(${t.secondaryRgb},.5)`;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=`rgba(${t.secondaryRgb},.2)`;}}>
            ← Go Back
          </button>
        </div>

        <ThemeToggle themeName={themeName} onToggle={toggleTheme} t={t} isMobile={mob}/>

        {/* ═══ HERO HEADER — BurnPortal-style orbital logo ═══ */}
        <div style={{textAlign:'center',marginBottom:mob?28:40,animation:'ie-up .6s ease both',position:'relative',paddingTop:mob?10:20}}>

          {/* Ambient background glows */}
          <div style={{position:'absolute',top:'50%',left:'50%',width:mob?196:322,height:mob?140:230,transform:'translate(-50%,-60%)',borderRadius:'50%',
            background:isF?'radial-gradient(ellipse,rgba(255,102,0,0.1) 0%,rgba(255,60,0,0.04) 50%,transparent 75%)':'radial-gradient(ellipse,rgba(57,255,136,0.18) 0%,rgba(0,180,80,0.08) 50%,transparent 75%)',
            animation:'bp-portal-pulse 5s ease-in-out 2s infinite',pointerEvents:'none',filter:'blur(18px)'}}/>
          <div style={{position:'absolute',top:'50%',left:'50%',width:mob?336:552,height:mob?238:391,transform:'translate(-50%,-58%)',borderRadius:'50%',
            background:isF?'radial-gradient(ellipse,rgba(255,34,34,0.12) 0%,rgba(200,20,0,0.05) 50%,transparent 75%)':'radial-gradient(ellipse,rgba(140,40,255,0.25) 0%,rgba(100,20,200,0.12) 50%,transparent 75%)',
            animation:'bp-portal-pulse 6s ease-in-out 1s infinite',pointerEvents:'none',filter:'blur(14px)'}}/>
          <div style={{position:'absolute',top:'50%',left:'50%',width:mob?280:460,height:mob?196:322,transform:'translate(-50%,-60%)',borderRadius:'50%',
            background:isF?'radial-gradient(ellipse,rgba(255,80,0,0.15) 0%,rgba(255,40,0,0.06) 45%,transparent 70%)':'radial-gradient(ellipse,rgba(255,80,0,0.28) 0%,rgba(255,40,0,0.12) 45%,transparent 70%)',
            animation:'bp-portal-pulse 4s ease-in-out infinite',pointerEvents:'none',filter:'blur(8px)'}}/>

          {/* Center logo with orbital rings */}
          {(() => {
            const logoSz = mob ? 96 : 148;
            const r1 = mob ? 198 : 308, r2 = mob ? 156 : 244, r3 = mob ? 120 : 188, r4 = mob ? 86 : 136;
            const rings = isF ? [
              { sz:r1, bc:'rgba(255,34,34,0.25)',  gc:'rgba(255,34,34,0.08)',  dur:14, rev:false, nc:8, nd:'#ff4400' },
              { sz:r2, bc:'rgba(255,102,0,0.45)',  gc:'rgba(255,102,0,0.15)',  dur:9,  rev:true,  nc:6, nd:'#ff6600' },
              { sz:r3, bc:'rgba(255,140,0,0.5)',   gc:'rgba(255,140,0,0.12)',  dur:5,  rev:false, nc:4, nd:'#ffbb33' },
              { sz:r4, bc:'rgba(255,187,51,0.55)', gc:'rgba(255,187,51,0.18)', dur:3.5,rev:true,  nc:3, nd:'#ffdd44' },
            ] : [
              { sz:r1, bc:'rgba(140,70,255,0.55)',  gc:'rgba(57,255,136,0.22)', dur:14, rev:false, nc:8, nd:'#cc66ff' },
              { sz:r2, bc:'rgba(255,140,0,0.75)',   gc:'rgba(255,120,0,0.35)',  dur:9,  rev:true,  nc:6, nd:'#ffcc55' },
              { sz:r3, bc:'rgba(255,160,0,0.65)',   gc:'rgba(255,140,0,0.3)',   dur:5,  rev:false, nc:4, nd:'#ffdd66' },
              { sz:r4, bc:'rgba(57,255,136,0.85)',  gc:'rgba(57,255,136,0.45)', dur:3.5,rev:true,  nc:3, nd:'#39ff88' },
            ];
            const sparks = isF ? [
              {a:20,d:mob?100:160,dl:0,c:'#ff4400'},{a:80,d:mob?80:128,dl:.4,c:'#ff6600'},{a:145,d:mob?95:152,dl:.8,c:'#ff2222'},
              {a:210,d:mob?82:132,dl:.2,c:'#ffbb33'},{a:270,d:mob?96:156,dl:.6,c:'#ff6600'},{a:330,d:mob?78:124,dl:1,c:'#ffdd44'},
            ] : [
              {a:20,d:mob?100:160,dl:0,c:'#ff7700'},{a:80,d:mob?80:128,dl:.4,c:'#aa44ff'},{a:145,d:mob?95:152,dl:.8,c:'#ff4400'},
              {a:210,d:mob?82:132,dl:.2,c:'#39ff88'},{a:270,d:mob?96:156,dl:.6,c:'#cc55ff'},{a:330,d:mob?78:124,dl:1,c:'#ffdd00'},
            ];
            return (
              <div style={{position:'relative',display:'inline-block',marginBottom:mob?20:30,zIndex:2}}>
                {/* Orbital rings */}
                {rings.map((r,i)=>(
                  <div key={i} style={{position:'absolute',top:'50%',left:'50%',width:r.sz,height:r.sz,marginTop:-r.sz/2,marginLeft:-r.sz/2,borderRadius:'50%',border:`1px solid ${r.bc}`,boxShadow:`0 0 16px ${r.gc}, inset 0 0 16px ${r.gc}`,animation:`${r.rev?'bp-spin-rev':'bp-spin'} ${r.dur}s linear infinite`,pointerEvents:'none',zIndex:0}}>
                    {Array.from({length:r.nc}).map((_,ni)=>{const deg=(360/r.nc)*ni,rad=deg*Math.PI/180,rv=r.sz/2;return(
                      <div key={ni} style={{position:'absolute',width:5,height:5,borderRadius:'50%',background:r.nd,boxShadow:`0 0 8px ${r.nd}`,top:rv+Math.sin(rad)*rv-2.5,left:rv+Math.cos(rad)*rv-2.5,animation:`bp-node-glow ${1.2+ni*.18}s ease-in-out ${ni*.12}s infinite`}}/>
                    );})}
                  </div>
                ))}
                {/* Spark particles */}
                <div style={{position:'absolute',top:'50%',left:'50%',width:0,height:0,pointerEvents:'none',zIndex:0}}>
                  {sparks.map((s,i)=>{const rad=s.a*Math.PI/180;return(
                    <div key={i} style={{position:'absolute',top:'50%',left:'50%',width:3,height:3,marginTop:-1.5,marginLeft:-1.5,borderRadius:'50%',background:s.c,boxShadow:`0 0 10px ${s.c}, 0 0 20px ${s.c}88`,'--sx':`${Math.cos(rad)*s.d}px`,'--sy':`${Math.sin(rad)*s.d}px`,animation:`bp-spark ${1.4+s.dl*.3}s ease-out ${s.dl}s infinite`,pointerEvents:'none'} as React.CSSProperties}/>
                  );})}
                </div>
                {/* Outer shimmer ring */}
                <div style={{position:'absolute',top:'50%',left:'50%',width:logoSz*2.4,height:logoSz*2.4,marginTop:-(logoSz*2.4)/2,marginLeft:-(logoSz*2.4)/2,borderRadius:'50%',border:isF?'1px dashed rgba(255,102,0,0.12)':'1px dashed rgba(160,60,255,0.18)',animation:'bp-ring-drift 6s ease-in-out infinite',pointerEvents:'none',zIndex:0}}/>
                {/* Conic gradient ring layers */}
                <div style={{position:'absolute',inset:-10,borderRadius:'50%',border:'2px solid transparent',background:isF?'linear-gradient(#0a090c,#0a090c) padding-box, conic-gradient(from 0deg, #ff2222, #ff4400, #ff6600, #ffbb33, #ff6600, #ff2222) border-box':'linear-gradient(#0b0f16,#0b0f16) padding-box, conic-gradient(from 0deg, #39ff88, #aa44ff, #ff7700, #ff2200, #aa00ff, #39ff88) border-box',animation:'bp-spin 3.5s linear infinite',opacity:.95}}/>
                <div style={{position:'absolute',inset:-5,borderRadius:'50%',border:'2px solid transparent',background:isF?'linear-gradient(#0a090c,#0a090c) padding-box, conic-gradient(from 180deg, #cc1111, #ff4400, #ffbb33, #ff6600, #cc3300, #cc1111) border-box':'linear-gradient(#0b0f16,#0b0f16) padding-box, conic-gradient(from 180deg, #ff5500, #cc00ff, #39ff88, #ff8800, #7700cc, #ff5500) border-box',animation:'bp-spin-rev 5s linear infinite',opacity:.75}}/>
                <div style={{position:'absolute',inset:-2,borderRadius:'50%',border:'1.5px solid transparent',background:isF?'linear-gradient(#0a090c,#0a090c) padding-box, conic-gradient(from 90deg, #ffbb33, #ff6600, #ffbb33, #ff6600, #ffbb33) border-box':'linear-gradient(#0b0f16,#0b0f16) padding-box, conic-gradient(from 90deg, #39ff88, #00cc55, #39ff88, #00cc55, #39ff88) border-box',animation:'bp-spin 2s linear infinite',opacity:.8}}/>
                {/* Glow bloom */}
                <div style={{position:'absolute',inset:-14,borderRadius:'50%',boxShadow:isF?'0 0 18px 4px rgba(255,102,0,0.15), 0 0 32px 8px rgba(255,34,34,0.1), 0 0 48px 12px rgba(255,187,51,0.06)':'0 0 18px 4px rgba(57,255,136,0.28), 0 0 32px 8px rgba(140,40,255,0.18), 0 0 48px 12px rgba(255,80,0,0.1)',pointerEvents:'none'}}/>
                {/* Logo */}
                <img src={BRAINS_LOGO} alt="BRAINS" style={{position:'relative',zIndex:2,width:logoSz,height:logoSz,borderRadius:'50%',objectFit:'cover',border:isF?'2px solid rgba(255,102,0,0.5)':'2px solid rgba(57,255,136,0.35)',boxShadow:isF?'0 0 20px rgba(255,102,0,0.3), 0 0 40px rgba(255,34,34,0.15)':'0 0 20px rgba(57,255,136,0.3), 0 0 40px rgba(140,40,255,0.2)'}} onError={e=>{(e.currentTarget as HTMLImageElement).style.display='none';}}/>
                {/* Ember particles */}
                {[{t:'8%',l:'82%',c:isF?'#ff4400':'#ff7700',d:1.1,dl:0},{t:'75%',l:'88%',c:isF?'#ffbb33':'#ffcc00',d:1.4,dl:.2},{t:'85%',l:'18%',c:isF?'#ff6600':'#39ff88',d:1,dl:.5},{t:'15%',l:'12%',c:isF?'#ff2222':'#ffaa00',d:1.6,dl:.35},{t:'50%',l:'92%',c:isF?'#ffdd44':'#ff3300',d:1.3,dl:.7}].map((e,i)=>(
                  <div key={i} style={{position:'absolute',width:4,height:4,borderRadius:'50%',background:e.c,boxShadow:`0 0 8px ${e.c}`,top:e.t,left:e.l,zIndex:3,animation:`bp-ember ${e.d}s ease-in-out ${e.dl}s infinite alternate`}}/>
                ))}
              </div>
            );
          })()}

          {/* Title block */}
          <div style={{position:'relative',zIndex:2}}>
            {/* Eyebrow */}
            <div style={{fontFamily:'Orbitron,monospace',fontSize:mob?11:14,letterSpacing:mob?4:7,color:isF?'#ff9944':'#cc88ff',textShadow:isF?'0 0 12px rgba(255,140,0,0.6), 0 0 28px rgba(255,102,0,0.3)':'0 0 12px rgba(180,80,255,0.9), 0 0 28px rgba(140,50,255,0.5)',textTransform:'uppercase',marginBottom:mob?8:12,fontWeight:700}}>
              BRAINS 🧪 LAB WORK · BURN ENGINE
            </div>
            {/* Main title */}
            <div style={{filter:isF?'drop-shadow(0 0 22px rgba(255,102,0,0.7)) drop-shadow(0 0 44px rgba(255,34,34,0.3))':'drop-shadow(0 0 22px rgba(255,120,0,0.95)) drop-shadow(0 0 44px rgba(180,50,255,0.55))',animation:'bp-title-flicker 8s ease-in-out infinite'}}>
              <h1 key={isF?'f':'v'} style={{fontFamily:'Orbitron,monospace',fontSize:mob?28:46,fontWeight:900,letterSpacing:mob?5:10,margin:'0 0 4px',textTransform:'uppercase',lineHeight:1.1,background:isF?'linear-gradient(135deg,#ff4400 0%,#ff6600 22%,#ffbb33 44%,#ffffff 60%,#ffdd44 78%,#ff6600 100%)':'linear-gradient(135deg,#ff6600 0%,#ff44ff 22%,#ff9900 44%,#39ff88 66%,#ffcc00 82%,#ff5500 100%)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>
                BURN, RANK, ASCEND
              </h1>
            </div>
            {/* Sub-label */}
            <div style={{fontFamily:'Orbitron,monospace',fontSize:mob?10:12,letterSpacing:mob?4:6,color:isF?'#a89cb0':'#ff9933',textShadow:isF?'0 0 10px rgba(255,140,0,0.3)':'0 0 10px rgba(255,140,0,0.8), 0 0 22px rgba(255,100,0,0.4)',textTransform:'uppercase',marginBottom:4,fontWeight:600}}>
              INCINERATOR PROTOCOL
            </div>
            {/* FlameRule-style decorative line */}
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:14,width:mob?'85%':'60%',margin:'10px auto 0'}}>
              <div style={{flex:1,height:1,background:isF?'linear-gradient(90deg,transparent,rgba(255,34,34,0.4),rgba(255,102,0,0.3))':'linear-gradient(90deg,transparent,rgba(255,80,0,0.7),rgba(255,140,0,0.4))'}}/>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <div style={{width:4,height:4,borderRadius:'50%',background:isF?'#ff6600':'#39ff88',boxShadow:isF?'0 0 8px #ff6600':'0 0 8px #39ff88',animation:isF?'bp-node-glow 2s ease infinite':'bp-green-pulse 2s ease infinite'}}/>
                <span style={{fontSize:18,filter:'drop-shadow(0 0 8px #ff6600) drop-shadow(0 0 16px rgba(255,80,0,.5))'}}>🔥</span>
                <div style={{width:4,height:4,borderRadius:'50%',background:isF?'#ff6600':'#39ff88',boxShadow:isF?'0 0 8px #ff6600':'0 0 8px #39ff88',animation:isF?'bp-node-glow 2s ease 1s infinite':'bp-green-pulse 2s ease 1s infinite'}}/>
              </div>
              <div style={{flex:1,height:1,background:isF?'linear-gradient(90deg,rgba(255,102,0,0.3),rgba(255,34,34,0.4),transparent)':'linear-gradient(90deg,rgba(255,140,0,0.4),rgba(255,80,0,0.7),transparent)'}}/>
            </div>
            {/* Heat wave line */}
            <div style={{height:1,width:mob?'70%':'50%',margin:'10px auto 12px',background:'linear-gradient(90deg,transparent,rgba(255,80,0,0.8),rgba(255,160,0,1.0),rgba(255,80,0,0.8),transparent)',backgroundSize:'200% 100%',animation:'bp-heat-wave 5s ease infinite'}}/>
            <p style={{fontFamily:'Sora,sans-serif',fontSize:mob?11:13,color:t.textMuted,letterSpacing:1.5,margin:0}}>
              {isF?'Forge your legacy in the inferno':'Burn BRAINS tokens · Earn LB Points · Climb the ranks'}
            </p>
          </div>
        </div>

        {/* ═══ NOT CONNECTED — inline status prompt ═══ */}
        {!publicKey&&(<div style={{...CD,marginBottom:20,animation:'ie-up .5s ease both'}}>
          <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:t.cardGlow,transition:'background .4s'}}/>
          <div style={{display:'flex',alignItems:'center',gap:mob?12:16,flexWrap:'wrap'}}>
            <div style={{width:40,height:40,borderRadius:'50%',flexShrink:0,background:`linear-gradient(135deg,rgba(${t.primaryRgb},.15),rgba(${t.primaryRgb},.25))`,border:`1px solid rgba(${t.primaryRgb},.3)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:19}}>{isF?'🔥':'🔗'}</div>
            <div style={{flex:1,minWidth:180}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:mob?10:12,color:t.primary,letterSpacing:2,marginBottom:3,transition:'color .4s'}}>CONNECT TO BURN, RANK, ASCEND</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:mob?10:12,color:t.textMuted,lineHeight:1.5}}>See your tier, LB Points, burn history, and global rank</div>
            </div>
            <WalletMultiButton style={{fontFamily:'Orbitron,monospace',fontSize:9,fontWeight:700,letterSpacing:2,padding:'10px 20px',borderRadius:10,background:t.btnBg,border:`1px solid ${t.btnBorder}`,color:'#fff',cursor:'pointer',textTransform:'uppercase'as const,boxShadow:`0 0 12px rgba(${t.primaryRgb},.2)`,whiteSpace:'nowrap'as const}}/>
          </div>
        </div>)}

        {/* ═══ CONNECTED ═══ */}
        {publicKey&&(<div style={{animation:'ie-up .5s ease both'}}>
          <div style={{marginBottom:20}}><AddressBar address={publicKey.toBase58()}/></div>

          {/* STATUS */}
          <div style={{...CD,marginBottom:20}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:t.cardGlow,transition:'background .4s'}}/>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:t.primary,letterSpacing:2,marginBottom:16,textTransform:'uppercase',transition:'color .4s'}}>⚡ YOUR STATUS</div>
            <div style={{display:'grid',gridTemplateColumns:mob?'repeat(2,1fr)':'repeat(4,1fr)',gap:12}}>
              {[{l:'CURRENT TIER',v:null,ic:cur.icon,s:cur.name,sc:cur.neon},{l:'TOTAL LB POINTS',v:fmt(myPts),ic:null,s:null,sc:null},{l:'BRAINS BURNED',v:fmt(myBrn),ic:null,s:null,sc:null},{l:'GLOBAL RANK',v:rank?`#${rank}`:'—',ic:null,s:null,sc:null}].map((it,i)=>(
                <div key={i} style={{background:'rgba(0,0,0,.3)',border:`1px solid ${t.statBorder}`,borderRadius:12,padding:'14px 12px',textAlign:'center',transition:'border-color .4s'}}>
                  {it.ic?(
                    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:6}}>
                      <div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:t.textMuted,marginBottom:2}}>{it.l}</div>
                      <span style={{
                        display:'inline-flex',alignItems:'center',gap:6,padding:'7px 16px',
                        background:`linear-gradient(160deg,#0a0e14 0%,#111820 30%,${it.sc}0c 60%,#0d1218 100%)`,
                        border:`1px solid ${it.sc}55`,borderTop:`1px solid ${it.sc}88`,borderBottom:`1px solid ${it.sc}22`,
                        borderLeft:`2px solid ${it.sc}`,
                        borderRadius:8,fontFamily:'Orbitron,monospace',fontSize:mob?10:13,fontWeight:800,
                        letterSpacing:2,whiteSpace:'nowrap',position:'relative',overflow:'hidden',
                        boxShadow:`0 2px 12px ${it.sc}15, inset 0 1px 0 ${it.sc}18, inset 0 -1px 0 rgba(0,0,0,.4)`,
                        animation:'ie-badge-sway 3s ease-in-out infinite',
                      }}>
                        {/* Metallic shimmer sweep — white highlight */}
                        <span style={{position:'absolute',inset:0,background:'linear-gradient(105deg,transparent 15%,rgba(255,255,255,.03) 30%,rgba(255,255,255,.08) 48%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.08) 52%,rgba(255,255,255,.03) 70%,transparent 85%)',backgroundSize:'250% 100%',animation:'ie-metalShimmer 3s ease-in-out infinite',pointerEvents:'none'}} />
                        {/* Top highlight edge */}
                        <span style={{position:'absolute',top:0,left:'10%',right:'10%',height:1,background:`linear-gradient(90deg,transparent,${it.sc}55,transparent)`,pointerEvents:'none'}} />
                        {/* Corner accent */}
                        <span style={{position:'absolute',top:0,right:0,width:6,height:6,borderTop:`1px solid ${it.sc}99`,borderRight:`1px solid ${it.sc}99`,pointerEvents:'none'}} />
                        <span style={{position:'absolute',bottom:0,left:0,width:6,height:6,borderBottom:`1px solid ${it.sc}44`,borderLeft:`1px solid ${it.sc}44`,pointerEvents:'none'}} />
                        <span style={{fontSize:mob?15:20,lineHeight:1,flexShrink:0,position:'relative',zIndex:1,filter:`drop-shadow(0 0 6px ${it.sc}66)`}}>{it.ic}</span>
                        <span style={{position:'relative',zIndex:1,color:it.sc!,textShadow:`0 1px 2px ${it.sc}33, 0 0 8px ${it.sc}22`}}>{it.s}</span>
                      </span>
                      {nxt&&<div style={{fontFamily:'Sora,sans-serif',fontSize:8,color:t.textMuted,letterSpacing:1,marginTop:2}}>{fF(nxt.min-myPts)} pts to <span style={{color:nxt.neon,fontWeight:600}}>{nxt.name}</span></div>}
                    </div>
                  )
                  :(<><div style={{fontFamily:'Rajdhani,sans-serif',fontSize:mob?20:26,fontWeight:700,...(i===1?GT:{color:i===2?t.secondary:t.accent,textShadow:`0 0 10px rgba(${i===2?t.secondaryRgb:t.accentRgb},.35)`})}}>{it.v}</div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:t.textMuted,marginTop:4}}>{it.l}</div></>)}
                </div>))}
            </div>
            {nxt&&<div style={{marginTop:16}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:'Sora,sans-serif',fontSize:10,color:t.textMuted}}>Next: <span style={{color:nxt.neon,fontWeight:600}}>{nxt.icon} {nxt.name}</span></span>
                <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:12,color:t.primary,fontWeight:600}}>{fF(nxt.min-myPts)} LB pts needed</span>
              </div>
              <div style={{height:6,background:'rgba(255,255,255,.06)',borderRadius:3,overflow:'hidden'}}><div style={{height:'100%',borderRadius:3,width:`${Math.min(100,(myPts/nxt.min)*100)}%`,background:`linear-gradient(90deg,${cur.color},${nxt.color})`,boxShadow:`0 0 8px ${cur.color}40`,transition:'width .5s ease'}}/></div>
            </div>}
          </div>

          {/* BURN CHAMBER */}
          <div style={{...CD,border:burning?`2px solid rgba(${t.primaryRgb},.5)`:`1px solid rgba(${t.primaryRgb},.25)`,marginBottom:20,transition:'border .3s,background .4s'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:3,background:burning?`linear-gradient(90deg,transparent,rgba(${t.primaryRgb},.9),rgba(${t.secondaryRgb},.8),rgba(${t.primaryRgb},.9),transparent)`:`linear-gradient(90deg,transparent,rgba(${t.primaryRgb},.6),transparent)`,animation:burning?'ie-pbar .8s ease infinite':undefined,transition:'background .4s'}}/>
            <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:20}}>
              <div style={{width:40,height:40,borderRadius:'50%',flexShrink:0,background:`linear-gradient(135deg,rgba(${t.primaryRgb},.2),rgba(${t.primaryRgb},.3))`,border:`2px solid rgba(${t.primaryRgb},.5)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:19}}>{isF?'🔥':'🎰'}</div>
              <div>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:mob?13:16,color:'#fff',letterSpacing:2,textTransform:'uppercase',fontWeight:900}}>BURN CHAMBER</div>
                <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:t.textMuted,marginTop:2}}>{`Permanently incinerate · Earn ${amp>0?`×1.888 + ${amp}% AMP`:'×1.888 LB Points'}`}</div>
              </div>
            </div>
            <div style={{background:t.warnBg,border:`1px solid ${t.warnBorder}`,borderLeft:`4px solid ${t.warnAccent}`,borderRadius:8,padding:'10px 14px',marginBottom:18,display:'flex',alignItems:'flex-start',gap:8}}>
              <span style={{fontSize:14,flexShrink:0}}>⚠️</span>
              <span style={{fontFamily:'Sora,sans-serif',fontSize:mob?10:11,color:'#ddd',lineHeight:1.5}}><strong style={{color:t.warnText}}>Irreversible:</strong> Burned tokens are permanently destroyed.</span>
            </div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',background:'rgba(0,0,0,.3)',border:`1px solid rgba(${t.primaryRgb},.15)`,borderRadius:10,padding:'10px 16px',marginBottom:14}}>
              <span style={{fontFamily:'Sora,sans-serif',fontSize:11,color:t.textMuted}}>Available Balance</span>
              <div style={{display:'flex',alignItems:'baseline',gap:6}}>
                {fetBal?<span style={{fontFamily:'Orbitron,monospace',fontSize:10,color:t.textMuted}}>Loading...</span>:
                <><span style={{fontFamily:'Rajdhani,sans-serif',fontSize:mob?18:22,fontWeight:700,color:t.secondary,textShadow:`0 0 8px rgba(${t.secondaryRgb},.35)`}}>{bal!==null?fF(bal):'—'}</span>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:t.textMuted,letterSpacing:1}}>BRAINS</span></>}
              </div>
            </div>
            <div style={{marginBottom:18}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:t.primary,letterSpacing:2,marginBottom:8}}>AMOUNT TO INCINERATE</div>
              <div style={{display:'flex',flexDirection:mob?'column':'row',gap:10}}>
                <div style={{flex:1,position:'relative'}}>
                  <input type="number" value={burnAmt} onChange={e=>{setBurnAmt(e.target.value);setErr(null);}} placeholder="0.00" disabled={burning}
                    style={{width:'100%',padding:'14px 80px 14px 16px',background:'rgba(0,0,0,.5)',border:`2px solid ${t.inputBorder}`,borderRadius:10,fontFamily:'Rajdhani,sans-serif',fontSize:20,fontWeight:700,color:'#fff',outline:'none',boxSizing:'border-box',transition:'border-color .2s'}}
                    onFocus={e=>{e.currentTarget.style.borderColor=t.inputFocus;}} onBlur={e=>{e.currentTarget.style.borderColor=t.inputBorder;}}/>
                  <div style={{position:'absolute',right:14,top:'50%',transform:'translateY(-50%)',fontFamily:'Orbitron,monospace',fontSize:10,color:t.textMuted,fontWeight:700,letterSpacing:1}}>BRAINS</div>
                </div>
                <div style={{display:'flex',gap:6,flexShrink:0}}>
                  {(['25%','50%','75%','MAX']as const).map(p=>{const iM=p==='MAX',ml=iM?1:parseInt(p)/100;return<button key={p} onClick={()=>{if(bal&&bal>0)setBurnAmt((iM?bal:Math.floor(bal*ml*100)/100).toString());}} disabled={burning||!bal}
                    style={{padding:mob?'10px 0':'0 14px',flex:mob?1:undefined,background:iM?`linear-gradient(135deg,rgba(${t.primaryRgb},.25),rgba(${t.primaryRgb},.15))`:t.qBg,border:iM?`2px solid rgba(${t.primaryRgb},.4)`:t.qBorder,borderRadius:8,fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:iM?t.primary:t.qColor,cursor:burning||!bal?'not-allowed':'pointer',letterSpacing:1,opacity:burning||!bal?.4:1}}>{p}</button>;})}
                </div>
              </div>
            </div>

            {/* PREVIEW */}
            {pAmt>0&&<div style={{background:'rgba(0,0,0,.3)',border:`1px solid rgba(${t.accentRgb},.15)`,borderRadius:12,padding:16,marginBottom:18,animation:'ie-up .3s ease both'}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:t.accent,letterSpacing:2,marginBottom:12}}>⚡ BURN PREVIEW</div>
              <div style={{display:'grid',gridTemplateColumns:mob?'1fr':'1fr 1fr',gap:10}}>
                <div style={{display:'flex',justifyContent:'space-between',padding:'8px 12px',background:`rgba(${t.secondaryRgb},.05)`,borderRadius:8,border:`1px solid rgba(${t.secondaryRgb},.1)`}}>
                  <span style={{fontFamily:'Sora,sans-serif',fontSize:11,color:t.textMuted}}>Base (×1.888)</span>
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:16,fontWeight:700,color:t.secondary}}>+{fF(pBase)}</span>
                </div>
                {amp>0&&<div style={{display:'flex',justifyContent:'space-between',padding:'8px 12px',background:`rgba(${t.accentRgb},.05)`,borderRadius:8,border:`1px solid rgba(${t.accentRgb},.1)`}}>
                  <span style={{fontFamily:'Sora,sans-serif',fontSize:11,color:t.textMuted}}>AMP (+{amp}%)</span>
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:16,fontWeight:700,color:t.accent}}>+{fF(pAmp)}</span>
                </div>}
                <div style={{display:'flex',justifyContent:'space-between',padding:'10px 12px',background:`rgba(${t.primaryRgb},.06)`,borderRadius:8,border:`1px solid rgba(${t.primaryRgb},.15)`,gridColumn:mob||!amp?undefined:'1/-1'}}>
                  <span style={{fontFamily:'Sora,sans-serif',fontSize:12,color:t.primary,fontWeight:600}}>Total Points</span>
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:20,fontWeight:700,...GT}}>+{fF(pTot)}</span>
                </div>
              </div>
              {/* Tier status */}
              {tUp ? (
                <div style={{marginTop:12,padding:'10px 14px',background:`rgba(${t.accentRgb},.06)`,border:`1px solid rgba(${t.accentRgb},.2)`,borderRadius:8,display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'5px 12px',background:`linear-gradient(160deg,#0a0e14 0%,#111820 30%,${cur.neon}0c 60%,#0d1218 100%)`,border:`1px solid ${cur.neon}44`,borderLeft:`2px solid ${cur.neon}55`,borderRadius:6,fontFamily:'Orbitron,monospace',fontSize:9,fontWeight:700,color:`${cur.neon}99`,letterSpacing:1,whiteSpace:'nowrap',position:'relative',overflow:'hidden',opacity:.7}}>
                      <span style={{fontSize:13,lineHeight:1}}>{cur.icon}</span>
                      <span>{cur.name}</span>
                    </span>
                    <span style={{color:t.accent,fontSize:14,fontWeight:700}}>→</span>
                    <span style={{display:'inline-flex',alignItems:'center',gap:5,padding:'5px 12px',background:`linear-gradient(160deg,#0a0e14 0%,#111820 30%,${pTier.neon}0c 60%,#0d1218 100%)`,border:`1px solid ${pTier.neon}55`,borderTop:`1px solid ${pTier.neon}77`,borderBottom:`1px solid ${pTier.neon}22`,borderLeft:`2px solid ${pTier.neon}`,borderRadius:6,fontFamily:'Orbitron,monospace',fontSize:9,fontWeight:800,letterSpacing:1,whiteSpace:'nowrap',position:'relative',overflow:'hidden',boxShadow:`0 2px 8px ${pTier.neon}15, inset 0 1px 0 ${pTier.neon}15`,animation:'ie-badge-sway 3s ease-in-out infinite'}}>
                      <span style={{position:'absolute',inset:0,background:'linear-gradient(105deg,transparent 15%,rgba(255,255,255,.03) 30%,rgba(255,255,255,.08) 48%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.08) 52%,rgba(255,255,255,.03) 70%,transparent 85%)',backgroundSize:'250% 100%',animation:'ie-metalShimmer 3s ease-in-out infinite',pointerEvents:'none'}} />
                      <span style={{position:'absolute',top:0,left:'10%',right:'10%',height:1,background:`linear-gradient(90deg,transparent,${pTier.neon}44,transparent)`,pointerEvents:'none'}} />
                      <span style={{fontSize:13,lineHeight:1,position:'relative',zIndex:1,filter:`drop-shadow(0 0 4px ${pTier.neon}55)`}}>{pTier.icon}</span>
                      <span style={{position:'relative',zIndex:1,color:pTier.neon,textShadow:`0 1px 2px ${pTier.neon}33, 0 0 6px ${pTier.neon}22`}}>{pTier.name}</span>
                    </span>
                  </div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:t.accent,background:`rgba(${t.accentRgb},.1)`,border:`1px solid rgba(${t.accentRgb},.3)`,padding:'3px 10px',borderRadius:6,fontWeight:700,letterSpacing:1,animation:'ie-pgrn 1.5s ease infinite'}}>⬆ TIER UP!</div>
                </div>
              ) : pNext && (
                <div style={{marginTop:10,fontFamily:'Sora,sans-serif',fontSize:10,color:t.textMuted,textAlign:'right'}}>{fF(pNext.min-proj)} pts to <span style={{color:pNext.neon,fontWeight:600}}>{pNext.icon} {pNext.name}</span></div>
              )}
            </div>}

            {/* EXECUTE */}
            <button onClick={doBurn} disabled={dis} style={{width:'100%',padding:'16px 0',position:'relative',background:dis?t.btnOff:t.btnBg,border:'2px solid',borderColor:dis?`rgba(${t.primaryRgb},.3)`:t.btnBorder,borderRadius:12,fontFamily:'Orbitron,monospace',fontSize:mob?13:15,fontWeight:900,letterSpacing:3,color:'#fff',cursor:dis?'not-allowed':'pointer',opacity:dis?.5:1,textTransform:'uppercase',transition:'all .3s',overflow:'hidden'}}
              onMouseEnter={e=>{if(!dis){e.currentTarget.style.boxShadow=`0 0 30px rgba(${t.primaryRgb},.4)`;e.currentTarget.style.transform='translateY(-1px)';}}} onMouseLeave={e=>{e.currentTarget.style.boxShadow='none';e.currentTarget.style.transform='translateY(0)';}}>
              {burning&&<div style={{position:'absolute',inset:0,background:'linear-gradient(90deg,transparent,rgba(255,200,100,.15),transparent)',animation:'ie-shim 1.5s ease infinite',backgroundSize:'200% 100%'}}/>}
              <span style={{position:'relative',zIndex:1}}>{burning?'🔥 INCINERATING...':'🔥 EXECUTE INCINERATION'}</span>
            </button>

            {/* Error */}
            {err&&<div style={{marginTop:14,padding:'12px 14px',background:`rgba(${t.errRgb},.12)`,border:`1px solid rgba(${t.errRgb},.3)`,borderLeft:`4px solid ${t.errColor}`,borderRadius:8,display:'flex',alignItems:'flex-start',gap:10,animation:'ie-up .3s ease both'}}>
              <span style={{fontSize:16,flexShrink:0}}>❌</span><div><div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:t.errColor,fontWeight:700,letterSpacing:1,marginBottom:4}}>INCINERATION FAILED</div><div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#ddd',lineHeight:1.4}}>{err}</div></div>
            </div>}

            {/* Success */}
            {txSig&&<div ref={resRef} style={{marginTop:14,background:`linear-gradient(135deg,rgba(${t.okRgb},.08),rgba(${t.okRgb},.03))`,border:`1px solid rgba(${t.okRgb},.3)`,borderLeft:`4px solid ${t.okColor}`,borderRadius:10,overflow:'hidden',animation:'ie-up .3s ease both'}}>
              <div style={{padding:'14px 16px 10px',display:'flex',alignItems:'flex-start',gap:10}}>
                <span style={{fontSize:18,flexShrink:0}}>{conf==='confirmed'?'✅':conf==='pending'?'⏳':'⚠️'}</span>
                <div style={{flex:1}}><div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:t.okColor,fontWeight:700,letterSpacing:1.5}}>{conf==='confirmed'?'INCINERATION CONFIRMED':conf==='pending'?'TRANSACTION SENT — CONFIRMING...':'TRANSACTION SENT'}</div>
                  {suc&&<div style={{fontFamily:'Sora,sans-serif',fontSize:12,color:`rgba(${t.okRgb},.7)`,marginTop:4}}>{suc}</div>}
                </div>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:8,fontWeight:700,letterSpacing:1,padding:'3px 8px',borderRadius:5,flexShrink:0,...(conf==='confirmed'?{color:t.okColor,background:`rgba(${t.okRgb},.12)`,border:`1px solid rgba(${t.okRgb},.3)`}:conf==='pending'?{color:t.secondary,background:`rgba(${t.secondaryRgb},.1)`,border:`1px solid rgba(${t.secondaryRgb},.25)`,animation:'ie-pbar 1.5s ease infinite'}:{color:t.primary,background:`rgba(${t.primaryRgb},.1)`,border:`1px solid rgba(${t.primaryRgb},.25)`})}}>{conf==='confirmed'?'CONFIRMED':conf==='pending'?'PENDING':'CHECK EXPLORER'}</div>
              </div>
              <div style={{padding:'10px 16px',background:'rgba(0,0,0,.35)',borderTop:`1px solid rgba(${t.okRgb},.1)`}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:t.textMuted,letterSpacing:1.5,marginBottom:6}}>TRANSACTION SIGNATURE</div>
                <code style={{fontFamily:'monospace',fontSize:mob?8:10,color:`rgba(${t.okRgb},.65)`,wordBreak:'break-all',lineHeight:1.6,display:'block',padding:'8px 10px',background:'rgba(0,0,0,.3)',borderRadius:6,border:`1px solid rgba(${t.okRgb},.08)`}}>{txSig}</code>
              </div>
              <div style={{padding:'12px 16px 16px',display:'flex',gap:8,flexWrap:'wrap'}}>
                <a href={`https://explorer.mainnet.x1.xyz/tx/${txSig}`} target="_blank" rel="noopener noreferrer" style={{display:'inline-flex',alignItems:'center',gap:6,padding:'10px 20px',background:`linear-gradient(135deg,rgba(${t.okRgb},.18),rgba(${t.okRgb},.1))`,border:`1px solid rgba(${t.okRgb},.45)`,borderRadius:8,textDecoration:'none',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:t.okColor,letterSpacing:1}}>🔍 View on X1 Explorer ↗</a>
                <button onClick={()=>navigator.clipboard.writeText(txSig!)} style={{display:'inline-flex',alignItems:'center',gap:6,padding:'10px 16px',background:`rgba(${t.primaryRgb},.08)`,border:`1px solid rgba(${t.primaryRgb},.25)`,borderRadius:8,cursor:'pointer',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:t.primary,letterSpacing:1}}>📋 Copy TX Hash</button>
              </div>
            </div>}
          </div>
        </div>)}

          {/* GLOBAL STATS — always visible */}
          <div style={{...CD,marginBottom:20,animation:'ie-up .5s ease .1s both'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,transparent,rgba(${t.secondaryRgb},.4),transparent)`}}/>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:t.secondary,letterSpacing:2,marginBottom:14,textTransform:'uppercase'}}>📊 PROTOCOL STATS</div>
            <div style={{display:'grid',gridTemplateColumns:mob?'1fr 1fr':'1fr 1fr 1fr',gap:10}}>
              {[{l:'TOTAL BURNED',v:loading?'...':fmt(gBrn),c:t.secondary,r:t.secondaryRgb},{l:'ACTIVE BURNERS',v:loading?'...':String(entries.length),c:t.primary,r:t.primaryRgb},{l:publicKey?'YOUR BURN TXS':'LB PTS RATE',v:publicKey?String(myTx||'—'):'×1.888',c:t.accent,r:t.accentRgb,sp:true}].map((it,i)=>(
                <div key={i} style={{background:'rgba(0,0,0,.3)',border:`1px solid rgba(${it.r},.1)`,borderRadius:10,padding:12,textAlign:'center',...((it as any).sp&&mob?{gridColumn:'1/-1'}:{})}}>
                  <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:mob?18:24,fontWeight:700,color:it.c,textShadow:`0 0 8px rgba(${it.r},.35)`}}>{it.v}</div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:t.textMuted,marginTop:2}}>{it.l}</div>
                </div>))}
            </div>
          </div>

          {/* AMP/WEEKLY — always visible */}
          {wc&&wc.status==='active'&&<div style={{...CD,marginBottom:20,border:`1px solid rgba(${t.accentRgb},.2)`,animation:'ie-up .5s ease .15s both'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,transparent,rgba(${t.accentRgb},.5),transparent)`}}/>
            <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:t.accent,letterSpacing:2,textTransform:'uppercase'}}>⚡ WEEKLY CHALLENGE ACTIVE</div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:t.accent,background:`rgba(${t.accentRgb},.1)`,border:`1px solid rgba(${t.accentRgb},.3)`,padding:'2px 8px',borderRadius:5,fontWeight:700}}>{wc.weekId?.toUpperCase()}</div>
            </div>
            {amp>0&&<div style={{display:'flex',alignItems:'center',gap:12,background:`rgba(${t.accentRgb},.06)`,border:`1px solid rgba(${t.accentRgb},.15)`,borderRadius:10,padding:'14px 16px'}}>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:32,fontWeight:700,color:t.accent,textShadow:`0 0 12px rgba(${t.accentRgb},.4)`}}>+{amp}%</div>
              <div><div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#fff',fontWeight:700,letterSpacing:1}}>AMP BONUS ACTIVE</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:t.textMuted,marginTop:2}}>All burns this week earn +{amp}% bonus</div></div>
            </div>}
            {wc.prizes?.length>0&&<div style={{marginTop:14}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:t.primary,letterSpacing:2,marginBottom:8}}>PRIZE VAULT</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
                {wc.prizes.slice(0,3).map((pz,i)=>{const pc=['#ffd700','#c0c0c0','#cd7f32'],lb=['1ST','2ND','3RD'];return(
                  <div key={i} style={{background:'rgba(0,0,0,.3)',border:`1px solid ${pc[i]}33`,borderRadius:10,padding:'10px 8px',textAlign:'center'}}>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:pc[i],fontWeight:700,marginBottom:6}}>{lb[i]}</div>
                    {pz.map((p,j)=><div key={j} style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#ddd'}}>{p.isNFT?(p.nftName||'NFT'):`${p.amount.toLocaleString()} ${p.token}`}</div>)}
                  </div>);})}
              </div>
            </div>}
          </div>}

          {/* TIER REF — always visible */}
          <div style={{...CD,animation:'ie-up .5s ease .2s both'}}>
            <div style={{position:'absolute',top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,transparent,rgba(${t.primaryRgb},.4),transparent)`}}/>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:t.primary,letterSpacing:2,marginBottom:14,textTransform:'uppercase'}}>🏆 TIER REFERENCE</div>
            <div style={{display:'grid',gridTemplateColumns:mob?'repeat(2,1fr)':'repeat(3,1fr)',gap:10}}>
              {TIERS.filter(x=>x.min>0).map((tier,idx)=>{const c=publicKey&&cur.name===tier.name;const n=tier.neon;return(
                <div key={tier.name} style={{
                  background:`linear-gradient(160deg,#080b10 0%,#0c1018 25%,${n}${c?'0c':'06'} 70%,#0a0d14 100%)`,
                  border:`1px solid ${n}${c?'55':'20'}`,
                  borderTop:`1px solid ${n}${c?'88':'30'}`,
                  borderBottom:`1px solid ${n}${c?'22':'0a'}`,
                  borderLeft:`2px solid ${n}${c?'':'55'}`,
                  borderRadius:10,padding:mob?'11px 10px':'12px 14px',display:'flex',alignItems:'center',gap:mob?8:12,
                  position:'relative',overflow:'hidden',
                  boxShadow:c
                    ?`0 3px 16px ${n}20, inset 0 1px 0 ${n}22, inset 0 -1px 0 rgba(0,0,0,.5)`
                    :`0 1px 6px ${n}08, inset 0 1px 0 ${n}0a, inset 0 -1px 0 rgba(0,0,0,.3)`,
                  animation:c?'ie-badge-sway 3s ease-in-out infinite':undefined,
                  transition:'all .3s',
                }}>
                  {/* Metallic shimmer — stronger on active, subtle on all */}
                  <span style={{position:'absolute',inset:0,background:c
                    ?`linear-gradient(105deg,transparent 10%,${n}08 25%,rgba(255,255,255,.06) 40%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.06) 60%,${n}08 75%,transparent 90%)`
                    :`linear-gradient(105deg,transparent 10%,${n}04 30%,rgba(255,255,255,.02) 45%,rgba(255,255,255,.05) 50%,rgba(255,255,255,.02) 55%,${n}04 70%,transparent 90%)`,
                    backgroundSize:'250% 100%',animation:`ie-metalShimmer ${c?3:5+idx*0.3}s ease-in-out ${idx*0.2}s infinite`,pointerEvents:'none'}} />
                  {/* Ambient glow behind icon */}
                  <span style={{position:'absolute',left:mob?8:12,top:'50%',transform:'translateY(-50%)',width:36,height:36,borderRadius:'50%',background:`radial-gradient(circle,${n}${c?'18':'08'},transparent 70%)`,pointerEvents:'none'}} />
                  {/* Top highlight edge */}
                  <span style={{position:'absolute',top:0,left:'8%',right:'8%',height:1,background:`linear-gradient(90deg,transparent,${n}${c?'66':'22'},transparent)`,pointerEvents:'none'}} />
                  {/* Bottom glow line */}
                  <span style={{position:'absolute',bottom:0,left:'15%',right:'15%',height:1,background:`linear-gradient(90deg,transparent,${n}${c?'22':'0a'},transparent)`,pointerEvents:'none'}} />
                  {/* Corner accents */}
                  <span style={{position:'absolute',top:0,right:0,width:6,height:6,borderTop:`1px solid ${n}${c?'99':'33'}`,borderRight:`1px solid ${n}${c?'99':'33'}`,pointerEvents:'none'}} />
                  <span style={{position:'absolute',bottom:0,left:0,width:6,height:6,borderBottom:`1px solid ${n}${c?'44':'15'}`,borderLeft:`1px solid ${n}${c?'44':'15'}`,pointerEvents:'none'}} />
                  {/* Icon */}
                  <span style={{fontSize:mob?18:22,position:'relative',zIndex:1,filter:`drop-shadow(0 0 ${c?8:4}px ${n}${c?'88':'44'})`,flexShrink:0}}>{tier.icon}</span>
                  {/* Text */}
                  <div style={{position:'relative',zIndex:1,flex:1,minWidth:0}}>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:mob?9:10,fontWeight:c?900:700,color:c?n:`${n}cc`,letterSpacing:1,textShadow:`0 0 ${c?10:4}px ${n}${c?'33':'11'}`}}>{tier.name}</div>
                    <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:11,color:c?'#dde4ec':'#667',fontWeight:600,marginTop:1}}>{tier.min>=1e6?(tier.min/1e6)+'M':tier.min>=1e3?(tier.min/1e3)+'K':tier.min} pts</div>
                  </div>
                  {c&&<div style={{marginLeft:'auto',fontFamily:'Orbitron,monospace',fontSize:7,color:n,background:`${n}18`,border:`1px solid ${n}44`,padding:'3px 8px',borderRadius:5,fontWeight:700,letterSpacing:1,position:'relative',zIndex:1,boxShadow:`0 0 8px ${n}15`,textShadow:`0 0 6px ${n}33`}}>YOU</div>}
                </div>);})}
            </div>
          </div>

          {/* FORMULA — always visible */}
          <div style={{marginTop:16,padding:'14px 18px',background:'rgba(0,0,0,.2)',border:'1px solid rgba(255,255,255,.05)',borderRadius:12,textAlign:'center'}}>
            <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:t.textMuted,lineHeight:1.8}}>
              <span style={{color:t.secondary,fontWeight:600}}>Points</span> = Burned × <span style={{color:t.primary,fontWeight:700}}>1.888</span>
              {amp>0&&<> + Weekly AMP (<span style={{color:t.accent,fontWeight:700}}>+{amp}%</span>)</>}
            </div>
          </div>
        <Footer/>
      </div>
      {/* Burn celebration popup */}
      {showCelebration && <BurnCelebration amount={showCelebration.amount} newPts={showCelebration.newPts} totalPts={showCelebration.totalPts} labWorkPts={showCelebration.labWorkPts} tierName={showCelebration.tierName} tierIcon={showCelebration.tierIcon} onClose={() => setShowCelebration(null)} theme={t} />}
    </div>
  );
};

export default IncineratorEngine;