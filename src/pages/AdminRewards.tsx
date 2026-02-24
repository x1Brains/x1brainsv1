// src/pages/AdminRewards.tsx — ADMIN Weekly Challenge Manager
import React, { FC, useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getAccount, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BRAINS_MINT, BRAINS_LOGO, XDEX_API, METADATA_PROGRAM_ID_STRING, XNT_INFO } from '../constants';
import { fetchOffChainLogo, resolveUri } from '../utils';
import { TopBar, PageBackground, Footer } from '../components/UI';
import { fetchLeaderboard } from '../components/BurnLeaderboard';
import type { BurnerEntry } from '../components/BurnLeaderboard';

// ─── PODIUM PROFILE IMAGES (same as BurnLeaderboard) ────────────────────────
import podium1st from '../assets/images1st.jpg';
import podium2nd from '../assets/images2nd.jpg';
import podium3rd from '../assets/images3rd.png';

const PODIUM_IMAGES: Record<number, { src: string; scale: number }> = {
  1: { src: podium1st, scale: 1.35 },
  2: { src: podium2nd, scale: 1.3 },
  3: { src: podium3rd, scale: 1.0 },
};

const MPX_PID=new PublicKey(METADATA_PROGRAM_ID_STRING);
interface WTk{mint:string;name:string;symbol:string;balance:number;decimals:number;logoUri?:string;is2022:boolean;}
interface WNFT{mint:string;name:string;image?:string;metaUri?:string;}

function useAdminWallet(conn:any,pk:PublicKey|null){
  const[tks,setTks]=useState<WTk[]>([]);const[nfts,setNfts]=useState<WNFT[]>([]);const[ld,setLd]=useState(false);const[xnt,setXnt]=useState(0);
  useEffect(()=>{if(!pk||!conn)return;let dead=false;(async()=>{setLd(true);try{
    // ── XNT native ──
    const lam=await conn.getBalance(pk).catch(()=>0);if(!dead)setXnt(lam/1e9);

    // ── XDex registry (fast, has logos for known tokens) ──
    const xdex=new Map<string,{name:string;symbol:string;logo?:string;decimals:number}>();
    try{const r=await fetch(`${XDEX_API}/api/xendex/mint/list?network=mainnet`,{signal:AbortSignal.timeout(8000)});
      if(r.ok){const d=await r.json();const arr=Array.isArray(d)?d:(d?.data??d?.tokens??d?.list??[]);
        arr.forEach((t:any)=>{const a=t.token_address??t.address??t.mint;if(!a)return;
          xdex.set(a,{name:(t.name??'').replace(/\0/g,'').trim(),symbol:(t.symbol??'').replace(/\0/g,'').trim(),
            logo:t.logo??t.logoURI??t.logoUrl??t.image??t.icon,decimals:t.decimals??9});});}}catch{}

    // ── SPL + Token-2022 accounts ──
    const[sR,tR]=await Promise.allSettled([
      conn.getParsedTokenAccountsByOwner(pk,{programId:TOKEN_PROGRAM_ID}),
      conn.getParsedTokenAccountsByOwner(pk,{programId:TOKEN_2022_PROGRAM_ID})]);
    const splAccs=(sR.status==='fulfilled'?sR.value.value:[]).map((a:any)=>({...a,is2022:false}));
    const t22Accs=(tR.status==='fulfilled'?tR.value.value:[]).map((a:any)=>({...a,is2022:true}));
    const all=[...splAccs,...t22Accs];
    const allMints=Array.from(new Set(all.map((a:any)=>a.account.data.parsed.info.mint as string)));

    // ── Batch Metaplex PDA fetch (names + symbols + URI) ──
    const mpxCache=new Map<string,{name:string;symbol:string;uri:string}>();
    for(let i=0;i<allMints.length;i+=100){
      const chunk=allMints.slice(i,i+100);
      const pdaMap=chunk.map(m=>{const[p]=PublicKey.findProgramAddressSync([new TextEncoder().encode('metadata'),MPX_PID.toBytes(),new PublicKey(m).toBytes()],MPX_PID);return{mint:m,pda:p};});
      try{const accts=await conn.getMultipleAccountsInfo(pdaMap.map((x:any)=>x.pda),{encoding:'base64'});
        accts.forEach((acct:any,idx:number)=>{if(!acct?.data)return;const{mint}=pdaMap[idx];
          try{let raw:Uint8Array;const d=acct.data;
            if(d instanceof Uint8Array)raw=d;else if(Array.isArray(d)&&typeof d[0]==='string')raw=Uint8Array.from(atob(d[0]),ch=>ch.charCodeAt(0));else if(typeof d==='string')raw=Uint8Array.from(atob(d),ch=>ch.charCodeAt(0));else return;
            if(raw.length<69)return;const v=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);let o=65;
            const nL=v.getUint32(o,true);o+=4;if(!nL||nL>200||o+nL>raw.length)return;
            const nm=new TextDecoder().decode(raw.slice(o,o+nL)).replace(/\0/g,'').trim();o+=nL;
            const sL=v.getUint32(o,true);o+=4;if(sL>50||o+sL>raw.length)return;
            const sy=new TextDecoder().decode(raw.slice(o,o+sL)).replace(/\0/g,'').trim();o+=sL;
            const uL=v.getUint32(o,true);o+=4;if(uL>500||o+uL>raw.length)return;
            const uri=new TextDecoder().decode(raw.slice(o,o+uL)).replace(/\0/g,'').trim();
            if((nm&&!/^[\x20-\x7E\u00A0-\uFFFF]{1,60}$/.test(nm)))return; // skip binary garbage
            if(nm||sy)mpxCache.set(mint,{name:nm,symbol:sy,uri});
          }catch{}});
      }catch{}}

    // ── Token-2022 extension metadata (tokenMetadata extension) ──
    // This catches tokens that store name/symbol/uri in their mint account extensions
    const t22ext=new Map<string,{name:string;symbol:string;uri:string}>();
    const t22MintAddrs=Array.from(new Set(t22Accs.map((a:any)=>a.account.data.parsed.info.mint as string)));
    if(t22MintAddrs.length>0){
      // Batch fetch mint account infos
      const mintPubkeys=t22MintAddrs.map(m=>new PublicKey(m));
      for(let i=0;i<mintPubkeys.length;i+=100){
        const chunk=mintPubkeys.slice(i,i+100);const chunkMints=t22MintAddrs.slice(i,i+100);
        try{const infos=await conn.getMultipleAccountsInfo(chunk);
          await Promise.allSettled(infos.map(async(info:any,idx:number)=>{
            if(!info)return;const mint=chunkMints[idx];
            // Try getParsedAccountInfo for extension data
            try{const parsed=await conn.getParsedAccountInfo(new PublicKey(mint));
              const exts=parsed?.value?.data?.parsed?.info?.extensions;if(!Array.isArray(exts))return;
              const tmExt=exts.find((e:any)=>e?.extension==='tokenMetadata');if(!tmExt?.state)return;
              const nm=(tmExt.state.name??'').replace(/\0/g,'').trim();
              const sy=(tmExt.state.symbol??'').replace(/\0/g,'').trim();
              const uri=(tmExt.state.uri??'').replace(/\0/g,'').trim();
              if(nm||sy)t22ext.set(mint,{name:nm,symbol:sy,uri});
            }catch{}
          }));
        }catch{}}
    }

    // ── Resolve logos in parallel ──
    const logoCache=new Map<string,string>();
    const toFetch:Array<{mint:string;uri:string}>=[];
    // Collect URIs for tokens not covered by xdex (which already has logos)
    for(const m of allMints){
      if(xdex.has(m))continue; // xdex already has logo
      const src=t22ext.get(m)??mpxCache.get(m);
      if(src?.uri)toFetch.push({mint:m,uri:src.uri});
    }
    // Fetch up to 40 logos in parallel
    await Promise.allSettled(toFetch.slice(0,40).map(async({mint,uri})=>{
      try{const logo=await fetchOffChainLogo(uri);if(logo)logoCache.set(mint,logo);}catch{}}));

    // ── Build token + NFT lists ──
    const ts:WTk[]=[];const ns:WNFT[]=[];
    for(const acc of all){
      const info=acc.account.data.parsed.info;const mint=info.mint as string;
      const rawAmt=info.tokenAmount.uiAmount;
      const bal=rawAmt!==null&&rawAmt!==undefined?rawAmt:(info.tokenAmount.uiAmountString?parseFloat(info.tokenAmount.uiAmountString):0);
      const dec=info.tokenAmount.decimals;

      let nm='Unknown',sy='???',logo:string|undefined;

      // Resolution priority (matches Portfolio.tsx exactly):
      // 1. BRAINS hardcoded
      if(mint===BRAINS_MINT){nm='Brains';sy='BRAINS';logo=BRAINS_LOGO;}
      // 2. Token-2022 extension metadata (highest priority for T-2022 tokens)
      else if(t22ext.has(mint)){const e=t22ext.get(mint)!;nm=e.name||'Unknown';sy=e.symbol||'???';logo=logoCache.get(mint);}
      // 3. Metaplex PDA (covers most SPL tokens)
      else if(mpxCache.has(mint)){const m2=mpxCache.get(mint)!;nm=m2.name||'Unknown';sy=m2.symbol||'???';logo=logoCache.get(mint);}
      // 4. XDex registry (fallback, good for known tokens)
      else if(xdex.has(mint)){const x=xdex.get(mint)!;nm=x.name||'Unknown';sy=x.symbol||'???';logo=resolveUri(x.logo??'')??undefined;}
      // 5. Address fallback
      else{nm=`${mint.slice(0,6)}...${mint.slice(-4)}`;sy=mint.slice(0,4).toUpperCase();}

      // Override with xdex logo if we have one and on-chain didn't resolve
      if(!logo&&xdex.has(mint)){const xl=resolveUri(xdex.get(mint)!.logo??'');if(xl)logo=xl;}

      // NFT detection: decimals=0 + balance=1 (standard Solana NFT fingerprint)
      if(dec===0&&bal===1){
        let img=logo||logoCache.get(mint);
        const metaUri=(mpxCache.get(mint)??t22ext.get(mint))?.uri;
        if(!img&&metaUri){
          try{
            // Resolve gateway URLs
            let resolved=metaUri;
            if(resolved.startsWith('ipfs://'))resolved='https://nftstorage.link/ipfs/'+resolved.slice(7);
            else if(resolved.startsWith('ar://'))resolved='https://arweave.net/'+resolved.slice(5);
            // Use proxy to avoid CORS
            const proxyUrl=resolved.startsWith('http')?`/api/nft-meta/${resolved.replace(/^https?:\/\//,'')}`:resolved;
            const r3=await fetch(proxyUrl,{signal:AbortSignal.timeout(8000)});
            if(r3.ok){
              const ct=r3.headers.get('content-type')??'';
              if(ct.startsWith('image/')){img=resolved;}
              else{
                const j=await r3.json();
                let rawImg=j?.image||j?.image_url||j?.imageUrl||j?.properties?.image||j?.properties?.files?.[0]?.uri||j?.properties?.files?.[0]||'';
                if(typeof rawImg==='object'&&rawImg?.uri)rawImg=rawImg.uri;
                if(rawImg){
                  if(rawImg.startsWith('ipfs://'))rawImg='https://nftstorage.link/ipfs/'+rawImg.slice(7);
                  else if(rawImg.startsWith('ar://'))rawImg='https://arweave.net/'+rawImg.slice(5);
                  img=rawImg;
                }
              }
            }
          }catch(e2){console.warn('[AdminWallet] NFT image fetch failed for',mint.slice(0,8),e2);}
        }
        ns.push({mint,name:nm,image:img,metaUri});
      } else if(bal>0){
        ts.push({mint,name:nm,symbol:sy,balance:bal,decimals:dec,logoUri:logo,is2022:acc.is2022});
      }
    }
    ts.sort((a,b)=>b.balance-a.balance);ns.sort((a,b)=>a.name.localeCompare(b.name));
    if(!dead){setTks(ts);setNfts(ns);}
  }catch(e){console.error('[AdminWallet]',e);}finally{if(!dead)setLd(false);}})();return()=>{dead=true;};},[conn,pk?.toBase58()]);
  return{tokens:tks,nfts,loading:ld,xntBal:xnt};
}

(function(){if(typeof document==='undefined')return;if(document.getElementById('adm-s'))return;
const s=document.createElement('style');s.id='adm-s';s.textContent=`
@keyframes adm-fade{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes adm-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes adm-glow{0%,100%{box-shadow:0 0 10px rgba(140,60,255,.2)}50%{box-shadow:0 0 20px rgba(140,60,255,.45)}}
@keyframes adm-scan{0%{left:-38%}100%{left:120%}}
@keyframes adm-reveal{0%{opacity:0;transform:scale(.5) translateY(20px)}60%{transform:scale(1.08) translateY(-4px)}100%{opacity:1;transform:scale(1) translateY(0)}}
@keyframes adm-gold-glow{0%,100%{box-shadow:0 0 10px rgba(255,215,0,.3),0 0 30px rgba(255,215,0,.1)}50%{box-shadow:0 0 25px rgba(255,215,0,.5),0 0 50px rgba(255,215,0,.2)}}
@keyframes adm-purple-glow{0%,100%{box-shadow:0 0 8px rgba(140,60,255,.3)}50%{box-shadow:0 0 18px rgba(140,60,255,.5)}}
@keyframes adm-green-pulse{0%,100%{opacity:.5;box-shadow:0 0 6px #39ff88}50%{opacity:1;box-shadow:0 0 14px #39ff88}}
@keyframes adm-spin{to{transform:rotate(360deg)}}
select option{background:#0f1820;color:#e0e0e0;}
input:focus,select:focus,textarea:focus{border-color:rgba(140,60,255,.5)!important;box-shadow:0 0 12px rgba(140,60,255,.15);}
input::placeholder,textarea::placeholder{color:#3a5a6a;}
`;document.head.appendChild(s);})();

const ADMIN_WALLET='2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC';
const TIER_AMPS=[0,1.50,3.50,5.50,8.88];
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TK:Record<string,{c:string;logo:string;mint?:string}>={BRAINS:{c:'#ff9933',logo:BRAINS_LOGO,mint:BRAINS_MINT},XNM:{c:'#39ff88',logo:'https://explorer.xenblocks.io/tokens/xnm.png'},XUNI:{c:'#00e5ff',logo:'https://explorer.xenblocks.io/tokens/xuni.png'},XBLK:{c:'#b388ff',logo:'https://explorer.xenblocks.io/tokens/xblk.png'},XNT:{c:'#00ccff',logo:''}};
const LS_W='brains_weekly_config',LS_A='brains_announcements',LS_L='brains_challenge_log',LS_LW='brains_labwork_rewards';

function loadJ(k:string,f:any):any{try{const v=localStorage.getItem(k);if(!v)return f;return JSON.parse(v)??f;}catch{try{localStorage.removeItem(k);}catch{}return f;}}
function saveJ(k:string,v:any){
  try{localStorage.setItem(k,JSON.stringify(v));}catch{}
  // Async dual-write to Supabase (fire-and-forget)
  _syncToSupabase(k,v);
}

async function _syncToSupabase(k:string,v:any){
  try{
    const sb=await import('../lib/supabase');
    if(k===LS_W){
      await sb.saveWeeklyConfig(v);
      sb.invalidateWeeklyConfigCache();
    }else if(k===LS_L){
      // Full replace: delete all, re-insert
      // Only do this for explicit saves (stop, reset, etc.)
      // Individual log adds are handled separately
    }else if(k===LS_A){
      // Announcements handled individually via add/remove
    }else if(k===LS_LW){
      // Lab work handled individually via add/remove
    }
  }catch(e){console.warn('[SB sync]',k,e);}
}

interface PrizeItem{token:string;amount:number;nftMint?:string;nftName?:string;nftImage?:string;isNFT?:boolean;}
interface Challenge{id:string;title:string;description:string;tier:1|2|3|4;type:string;target:number;icon:string;}
interface Winner{address:string;prizes:PrizeItem[];ampPct:number;weeklyPts:number;weeklyBurned?:number;place:number;}
interface WConfig{weekId:string;startDate:string;endDate:string;challenges:Challenge[];prizes:[PrizeItem[],PrizeItem[],PrizeItem[]];status:string;winners?:Winner[];sendReceipts?:SendReceipt[];}
interface SendReceipt{place:number;wallet:string;items:PrizeItem[];txSig:string;timestamp:string;}
interface ChallengeLog{weekId:string;startDate:string;endDate:string;stoppedAt:string;challenges:Challenge[];winners?:Winner[];prizes:[PrizeItem[],PrizeItem[],PrizeItem[]];sendReceipts?:SendReceipt[];}

const short=(a:string)=>a.length>10?`${a.slice(0,4)}…${a.slice(-4)}`:a;
const fmtN=(n:number,d=2)=>n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtPts=(n:number)=>n>=1_000_000?`${(n/1e6).toFixed(2)}M`:n>=1_000?`${(n/1000).toFixed(1)}K`:n.toLocaleString();

// ─── BRAINS PRICE (simple inline fetcher) ────────────────────────────────────
let _admPriceCache:number|null=null;let _admPriceP:Promise<number|null>|null=null;
function fetchAdmBrainsPrice():Promise<number|null>{
  if(_admPriceCache!==null)return Promise.resolve(_admPriceCache);
  if(!_admPriceP)_admPriceP=(async()=>{try{
    const r=await fetch(`/api/xdex-price/api/token-price/prices?network=X1%20Mainnet&token_addresses=${BRAINS_MINT}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    if(!r.ok)return null;const d=await r.json();let p:number|null=null;
    if(d?.success&&Array.isArray(d?.data)){const it=d.data.find((i:any)=>i?.token_address===BRAINS_MINT);if(it?.price!=null&&Number(it.price)>0)p=Number(it.price);}
    else if(typeof d?.[BRAINS_MINT]==='number')p=d[BRAINS_MINT]>0?d[BRAINS_MINT]:null;
    if(p)_admPriceCache=p;return p;
  }catch{return null;}})();
  return _admPriceP;
}
function useAdmBrainsPrice():number|null{
  const[p,setP]=useState<number|null>(_admPriceCache);
  useEffect(()=>{fetchAdmBrainsPrice().then(v=>{if(v!==null)setP(v);});},[]);
  return p;
}

const TIER_C:Record<number,{l:string;c:string;bg:string;bd:string}>={1:{l:'Tier 1 — +1.50% Amplifier',c:'#39ff88',bg:'rgba(57,255,136,.04)',bd:'rgba(57,255,136,.2)'},2:{l:'Tier 2 — +3.50% Amplifier',c:'#ffcc55',bg:'rgba(255,204,85,.04)',bd:'rgba(255,204,85,.2)'},3:{l:'Tier 3 — +5.50% Amplifier',c:'#ff5500',bg:'rgba(255,85,0,.04)',bd:'rgba(255,85,0,.2)'},4:{l:'Tier 4 — +8.88% Amplifier',c:'#cc00ff',bg:'rgba(204,0,255,.04)',bd:'rgba(204,0,255,.2)'}};

const pan=(g?:string):React.CSSProperties=>({position:'relative',overflow:'hidden',background:'linear-gradient(160deg,#04060f,#07050e,#050a12)',border:`1px solid ${g||'rgba(120,60,255,.15)'}`,borderTop:`2px solid ${g||'rgba(140,60,255,.35)'}`,borderRadius:16,padding:20,marginBottom:20});
const GridBg:FC=()=>(<div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(rgba(100,60,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.025) 1px,transparent 1px)',backgroundSize:'24px 24px',pointerEvents:'none'}} />);
const L:React.CSSProperties={fontFamily:'Orbitron,monospace',fontSize:8,color:'#cc88ff',letterSpacing:2,marginBottom:6,display:'block'};
const I:React.CSSProperties={width:'100%',padding:'10px 14px',background:'#04030a',border:'1px solid rgba(140,60,255,.2)',borderRadius:8,fontFamily:'Sora,sans-serif',fontSize:12,color:'#e0e8f0',outline:'none',boxSizing:'border-box' as const};
const Sel:React.CSSProperties={...I,cursor:'pointer'};
const Btn:React.CSSProperties={padding:'10px 20px',background:'linear-gradient(135deg,rgba(140,60,255,.25),rgba(57,255,136,.1))',border:'1px solid rgba(140,60,255,.4)',borderRadius:10,color:'#cc88ff',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,letterSpacing:2,cursor:'pointer'};
const BtnD:React.CSSProperties={...Btn,background:'linear-gradient(135deg,rgba(255,0,68,.15),rgba(255,85,0,.08))',border:'1px solid rgba(255,0,68,.35)',color:'#ff4466'};
const Tl:FC<{i:string;t:string;c?:string}>=({i,t,c='#fff'})=>(<div style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:800,color:c,letterSpacing:2,marginBottom:16,display:'flex',alignItems:'center',gap:8}}><span style={{fontSize:18}}>{i}</span>{t}</div>);
const TkLogo:FC<{t:string;s?:number}>=({t,s=14})=>{const m=TK[t];if(!m||!m.logo)return <span style={{fontSize:s*.7}}>{t==='XNT'?'💎':'🪙'}</span>;return <img src={m.logo} alt="" style={{width:s,height:s,borderRadius:'50%',objectFit:'cover',border:`1px solid ${m.c}44`,background:'#111820'}} />;};

const DateP:FC<{label:string;value:string;color:string;onChange:(v:string)=>void}>=({label,value,color,onChange})=>{
  const d=value?new Date(value):null;const up=(fn:(x:Date)=>void)=>{const x=d?new Date(d):new Date();fn(x);onChange(x.toISOString());};
  return(<div><label style={L}>{label}</label>
    <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
      <select style={{...Sel,width:70,padding:'8px 4px',fontSize:11}} value={d?d.getMonth():''} onChange={e=>up(x=>x.setMonth(Number(e.target.value)))}><option value="">Mon</option>{MONTHS.map((m,i)=><option key={i} value={i}>{m}</option>)}</select>
      <select style={{...Sel,width:55,padding:'8px 4px',fontSize:11}} value={d?d.getDate():''} onChange={e=>up(x=>x.setDate(Number(e.target.value)))}><option value="">Day</option>{Array.from({length:31},(_,i)=><option key={i} value={i+1}>{i+1}</option>)}</select>
      <select style={{...Sel,width:70,padding:'8px 4px',fontSize:11}} value={d?d.getFullYear():''} onChange={e=>up(x=>x.setFullYear(Number(e.target.value)))}><option value="">Year</option>{[2025,2026,2027,2028,2029,2030].map(y=><option key={y} value={y}>{y}</option>)}</select>
      <select style={{...Sel,width:70,padding:'8px 4px',fontSize:11}} value={d?d.getHours():''} onChange={e=>up(x=>x.setHours(Number(e.target.value)))}><option value="">Hr</option>{Array.from({length:24},(_,i)=><option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>)}</select>
    </div>
    {d&&<div style={{fontFamily:'Orbitron,monospace',fontSize:9,color,marginTop:5}}>📅 {d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'})} @ {d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</div>}
    <div style={{display:'flex',gap:6,marginTop:5}}>{[7,14,30].map(n=><button key={n} onClick={()=>{const s=value?new Date(value):new Date();onChange(new Date(s.getTime()+n*864e5).toISOString());}} style={{padding:'3px 8px',background:'rgba(140,60,255,.08)',border:'1px solid rgba(140,60,255,.15)',borderRadius:4,color:'#cc88ff',fontFamily:'Orbitron,monospace',fontSize:7,cursor:'pointer'}}>+{n}D</button>)}</div>
  </div>);
};

// Lazy NFT thumbnail — resolves image from metaUri via proxy if direct image missing
const NFTThumb:FC<{nft:WNFT;size?:string}>=({nft,size='100%'})=>{
  const[src,setSrc]=useState(nft.image||null);
  const[tried,setTried]=useState(!!nft.image);
  useEffect(()=>{
    if(src||tried||!nft.metaUri)return;setTried(true);
    let c=false;
    (async()=>{
      let resolved=nft.metaUri!;
      if(resolved.startsWith('ipfs://'))resolved='https://nftstorage.link/ipfs/'+resolved.slice(7);
      else if(resolved.startsWith('ar://'))resolved='https://arweave.net/'+resolved.slice(5);
      const proxyUrl=resolved.startsWith('http')?`/api/nft-meta/${resolved.replace(/^https?:\/\//,'')}`:resolved;
      try{
        const r=await fetch(proxyUrl,{signal:AbortSignal.timeout(8000)});
        if(!r.ok)return;const ct=r.headers.get('content-type')??'';
        if(ct.startsWith('image/')){if(!c)setSrc(resolved);return;}
        const j=await r.json();let raw=j?.image||j?.image_url||j?.imageUrl||j?.properties?.image||j?.properties?.files?.[0]?.uri||j?.properties?.files?.[0]||'';
        if(typeof raw==='object'&&raw?.uri)raw=raw.uri;
        if(raw){if(raw.startsWith('ipfs://'))raw='https://nftstorage.link/ipfs/'+raw.slice(7);else if(raw.startsWith('ar://'))raw='https://arweave.net/'+raw.slice(5);if(!c)setSrc(raw);}
      }catch{}
    })();
    return()=>{c=true;};
  },[nft.metaUri,src,tried]);
  if(src)return <img src={src} alt={nft.name} style={{width:size,aspectRatio:'1',borderRadius:6,objectFit:'cover',marginBottom:4}} onError={()=>setSrc(null)}/>;
  return <div style={{width:size,aspectRatio:'1',background:'rgba(255,215,0,.06)',borderRadius:6,display:'flex',alignItems:'center',justifyContent:'center',fontSize:24,marginBottom:4}}>🖼️</div>;
};

const PrizeEd:FC<{items:PrizeItem[];onChange:(v:PrizeItem[])=>void;wTks:WTk[];wNfts:WNFT[];xntBal:number}>=({items,onChange,wTks,wNfts,xntBal})=>{
  const[showNfts,setShowNfts]=useState(false);
  const[adding,setAdding]=useState<{symbol:string;name:string;balance:number;logoUri?:string}|null>(null);
  const[addAmt,setAddAmt]=useState('');
  const amtRef=useRef<HTMLInputElement>(null);

  const confirmAdd=()=>{if(!adding)return;const v=parseFloat(addAmt);if(v>0){onChange([...items,{token:adding.symbol,amount:v}]);setAdding(null);setAddAmt('');}};

  return(<div>
    {/* Current prize items */}
    {items.map((p,i)=>(<div key={i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:6,padding:'8px 12px',background:'rgba(0,0,0,.2)',borderRadius:8,flexWrap:'wrap'}}>
      {p.isNFT?(<>{p.nftImage?<img src={p.nftImage} alt="" style={{width:32,height:32,borderRadius:6,objectFit:'cover',border:'1px solid rgba(255,215,0,.3)'}}/>:<span style={{fontSize:20}}>🖼️</span>}<div style={{flex:1}}><div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#ffd700'}}>{p.nftName||'NFT'}</div><div style={{fontFamily:'monospace',fontSize:8,color:'#556677'}}>{p.nftMint?short(p.nftMint):''}</div></div></>):
      (<><TkLogo t={p.token} s={18}/><div style={{flex:1}}><div style={{fontFamily:'Orbitron,monospace',fontSize:12,color:'#fff'}}>{fmtN(p.amount,2)} <span style={{fontSize:9,color:'#8899aa'}}>{p.token}</span></div><div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#556677'}}>{wTks.find(t=>t.symbol===p.token)?.name||p.token}</div></div></>)}
      <button onClick={()=>onChange(items.filter((_,j)=>j!==i))} style={{background:'none',border:'none',color:'#ff4466',fontSize:14,cursor:'pointer'}}>✕</button>
    </div>))}

    {/* Inline amount input panel */}
    {adding&&(<div style={{padding:'12px 14px',background:'rgba(140,60,255,.06)',border:'1px solid rgba(140,60,255,.25)',borderRadius:10,marginBottom:8,animation:'adm-fade 0.2s ease both'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
        {adding.logoUri?<img src={adding.logoUri} alt="" style={{width:22,height:22,borderRadius:'50%'}}/>:<span style={{fontSize:16}}>🪙</span>}
        <div><div style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,color:'#fff'}}>{adding.symbol}</div><div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#667788'}}>{adding.name}</div></div>
        <div style={{marginLeft:'auto',fontFamily:'Orbitron,monospace',fontSize:9,color:'#cc88ff'}}>Balance: {fmtN(adding.balance,2)}</div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <input ref={amtRef} autoFocus type="number" step="0.01" min="0" value={addAmt} onChange={e=>setAddAmt(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')confirmAdd();if(e.key==='Escape'){setAdding(null);setAddAmt('');}}}
          placeholder={`Amount of ${adding.symbol} to award...`}
          style={{...I,flex:1,padding:'8px 12px',fontSize:13,background:'#04030a',border:'1px solid rgba(140,60,255,.3)'}} />
        <button onClick={()=>{setAddAmt(String(adding.balance));}} style={{padding:'6px 10px',background:'rgba(140,60,255,.08)',border:'1px solid rgba(140,60,255,.2)',borderRadius:6,color:'#cc88ff',fontFamily:'Orbitron,monospace',fontSize:7,cursor:'pointer'}}>MAX</button>
        <button onClick={confirmAdd} style={{padding:'6px 14px',background:'rgba(57,255,136,.1)',border:'1px solid rgba(57,255,136,.3)',borderRadius:6,color:'#39ff88',fontFamily:'Orbitron,monospace',fontSize:9,fontWeight:700,cursor:'pointer'}}>ADD</button>
        <button onClick={()=>{setAdding(null);setAddAmt('');}} style={{padding:'6px 10px',background:'rgba(255,0,68,.06)',border:'1px solid rgba(255,0,68,.2)',borderRadius:6,color:'#ff4466',fontFamily:'Orbitron,monospace',fontSize:8,cursor:'pointer'}}>✕</button>
      </div>
    </div>)}

    {/* Token buttons from wallet */}
    {!adding&&<div style={{marginTop:8}}><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#cc88ff',letterSpacing:2}}>ADD TOKEN FROM YOUR WALLET (click to add)</span>
      <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:6}}>
        <button onClick={()=>{setAdding({symbol:'XNT',name:'X1 Native Token',balance:xntBal,logoUri:XNT_INFO?.logoUri});setAddAmt('');}}
          style={{display:'flex',alignItems:'center',gap:4,padding:'6px 10px',background:'rgba(0,204,255,.04)',border:'1px solid rgba(0,204,255,.15)',borderRadius:6,cursor:'pointer',color:'#00ccff',fontFamily:'Sora,sans-serif',fontSize:9}}>
          {XNT_INFO?.logoUri?<img src={XNT_INFO.logoUri} alt="" style={{width:14,height:14,borderRadius:'50%'}}/>:<span>💎</span>} <b>XNT</b> <span style={{fontSize:8,color:'#556677'}}>{fmtN(xntBal,2)}</span>
        </button>
        {wTks.map(tk=>(<button key={tk.mint} onClick={()=>{setAdding({symbol:tk.symbol,name:tk.name,balance:tk.balance,logoUri:tk.logoUri});setAddAmt('');}}
          style={{display:'flex',alignItems:'center',gap:4,padding:'6px 10px',background:'rgba(140,60,255,.04)',border:'1px solid rgba(140,60,255,.12)',borderRadius:6,cursor:'pointer',color:'#e0e8f0',fontFamily:'Sora,sans-serif',fontSize:9}}>
          {tk.logoUri?<img src={tk.logoUri} alt="" style={{width:14,height:14,borderRadius:'50%'}}/>:<span>🪙</span>} <b style={{fontFamily:'Orbitron,monospace',fontSize:8}}>{tk.symbol}</b> <span style={{fontSize:8,color:'#556677'}}>{fmtN(tk.balance,2)}</span>
        </button>))}
      </div>
    </div>}

    {/* NFT picker */}
    <div style={{marginTop:10}}>
      <button onClick={()=>setShowNfts(!showNfts)} style={{padding:'6px 14px',background:'rgba(255,215,0,.06)',border:'1px solid rgba(255,215,0,.15)',borderRadius:6,color:'#ffd700',fontFamily:'Orbitron,monospace',fontSize:8,cursor:'pointer'}}>🖼️ {showNfts?'HIDE':'PICK'} NFT FROM WALLET ({wNfts.length} found)</button>
      {showNfts&&<div style={{marginTop:8,display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(80px,1fr))',gap:8}}>
        {wNfts.length===0&&<div style={{gridColumn:'1/-1',fontSize:11,color:'#556677',padding:10}}>No NFTs found in wallet.</div>}
        {wNfts.map(nf=>{const added=items.some(p2=>p2.isNFT&&p2.nftMint===nf.mint);return(<button key={nf.mint} disabled={added} onClick={()=>{onChange([...items,{token:'NFT',amount:1,isNFT:true,nftMint:nf.mint,nftName:nf.name,nftImage:nf.image}]);setShowNfts(false);}}
          style={{padding:6,borderRadius:8,background:added?'rgba(57,255,136,.08)':'rgba(255,215,0,.04)',border:`1px solid ${added?'rgba(57,255,136,.3)':'rgba(255,215,0,.15)'}`,cursor:added?'not-allowed':'pointer',textAlign:'center' as const,opacity:added?0.5:1}}>
          <NFTThumb nft={nf} />
          <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:added?'#39ff88':'#ffd700',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{added?'✓ ADDED':nf.name||short(nf.mint)}</div>
        </button>);})}
      </div>}
    </div>
  </div>);
};

// ─── PODIUM CONFIG (matches BurnLeaderboard) ────────────────────────────────
const POD_CFG=[
  {border:'#ffd700',glow:'adm-gold-glow',label:'#ffd700',rank:'1ST',bg:'rgba(255,215,0,.06)'},
  {border:'#cc88ff',glow:'adm-purple-glow',label:'#cc88ff',rank:'2ND',bg:'rgba(140,60,255,.05)'},
  {border:'#39ff88',glow:'adm-green-pulse',label:'#39ff88',rank:'3RD',bg:'rgba(57,255,136,.05)'},
];

// ─── PODIUM POPUP (click a card → full detail overlay) ──────────────────────
const AdmPodiumPopup:FC<{wn:any;rank:number;onClose:()=>void}>=({wn,rank,onClose})=>{
  const cfg=POD_CFG[rank-1];const imgSize=rank===1?90:76;
  const[copied,setCopied]=useState(false);
  const copyAddr=()=>{navigator.clipboard.writeText(wn.address).catch(()=>{});setCopied(true);setTimeout(()=>setCopied(false),2000);};
  useEffect(()=>{const p=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=p;};},[]);
  return(
    <div onClick={onClose} style={{position:'fixed',top:0,left:0,right:0,bottom:0,zIndex:10000,background:'rgba(4,6,14,.88)',backdropFilter:'blur(10px)',display:'flex',alignItems:'center',justifyContent:'center',padding:20,overflowY:'auto'}}>
      <div onClick={e=>e.stopPropagation()} style={{position:'relative',width:'100%',maxWidth:400,background:'linear-gradient(160deg,#0a0818,#0c0a1e,#080e1a)',border:`1px solid ${cfg.border}44`,borderTop:`3px solid ${cfg.border}`,borderRadius:16,padding:'28px 22px 22px',overflow:'hidden',margin:'auto',boxShadow:`0 0 60px ${cfg.border}15, 0 4px 30px rgba(0,0,0,.5)`}}>
        <div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(rgba(100,60,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.03) 1px,transparent 1px)',backgroundSize:'24px 24px',pointerEvents:'none'}}/>
        <button onClick={onClose} style={{position:'absolute',top:12,right:12,width:30,height:30,borderRadius:'50%',background:'rgba(255,255,255,.06)',border:'1px solid rgba(255,255,255,.12)',color:'#8899aa',fontSize:14,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2}}>✕</button>
        <div style={{position:'relative',zIndex:1,textAlign:'center',marginBottom:18}}>
          <div style={{fontSize:28,filter:`drop-shadow(0 0 10px ${cfg.border}88)`,marginBottom:4}}>{rank===1?'👑':rank===2?'🥈':'🥉'}</div>
          <div style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,color:cfg.label,letterSpacing:3,marginBottom:12}}>{cfg.rank} PLACE</div>
          <div style={{display:'flex',justifyContent:'center',marginBottom:14}}>
            <div style={{position:'relative'}}>
              <div style={{position:'absolute',inset:-4,borderRadius:'50%',border:`2px solid ${cfg.border}44`,boxShadow:`0 0 16px ${cfg.border}33, 0 0 32px ${cfg.border}15`,animation:`${cfg.glow} 2.5s ease infinite`,pointerEvents:'none'}}/>
              <div style={{width:imgSize,height:imgSize,borderRadius:'50%',overflow:'hidden',border:`3px solid ${cfg.border}`,boxShadow:`0 0 20px ${cfg.border}44, inset 0 0 15px rgba(0,0,0,.4)`,background:'#0a0a14'}}>
                <img src={PODIUM_IMAGES[rank].src} alt={`Rank ${rank}`} style={{width:'100%',height:'100%',objectFit:'cover',objectPosition:'center top',display:'block',transform:`scale(${PODIUM_IMAGES[rank].scale})`}} onError={e=>{(e.target as HTMLImageElement).style.display='none';}}/>
              </div>
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8,flexWrap:'wrap'}}>
            <span style={{fontFamily:'monospace',fontSize:11,color:'#b0c4cc',wordBreak:'break-all'}}>{wn.address}</span>
            <button onClick={copyAddr} style={{background:copied?'rgba(0,201,141,.15)':'rgba(140,60,255,.12)',border:`1px solid ${copied?'rgba(0,201,141,.4)':'rgba(140,60,255,.35)'}`,color:copied?'#00c98d':'#cc88ff',padding:'3px 10px',borderRadius:5,cursor:'pointer',fontFamily:'Orbitron,monospace',fontSize:8,fontWeight:700,letterSpacing:1}}>{copied?'✓ COPIED':'⎘ COPY'}</button>
          </div>
        </div>
        <div style={{position:'relative',zIndex:1,display:'flex',flexDirection:'column',gap:8}}>
          <div style={{padding:'12px 14px',background:'rgba(255,140,0,.06)',border:'1px solid rgba(255,140,0,.15)',borderRadius:10}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#ff9933',letterSpacing:2,marginBottom:6}}>🔥 WEEKLY LB PTS</div>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:22,fontWeight:900,color:'#ff9933',textShadow:'0 0 14px rgba(255,140,0,.3)'}}>{fmtN(wn.weeklyPts||0,0)} <span style={{fontSize:10,color:'#cc7722'}}>PTS</span></div>
          </div>
          {wn.ampPct>0&&<div style={{padding:'12px 14px',background:'rgba(57,255,136,.05)',border:'1px solid rgba(57,255,136,.15)',borderRadius:10}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#39ff88',letterSpacing:2,marginBottom:6}}>⚡ AMPLIFIER BONUS</div>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:22,fontWeight:900,color:'#39ff88'}}>+{wn.ampPct.toFixed(2)}%</div>
          </div>}
          {(wn.prizes||[]).length>0&&<div style={{padding:'12px 14px',background:'rgba(255,215,0,.04)',border:'1px solid rgba(255,215,0,.12)',borderRadius:10}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#ffd700',letterSpacing:2,marginBottom:8}}>🏆 PRIZES</div>
            {(wn.prizes||[]).map((p:PrizeItem,j:number)=>(<div key={j} style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}>
              {p.isNFT?<span style={{fontSize:14}}>🖼️</span>:<TkLogo t={p.token} s={14}/>}
              <span style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:700,color:p.isNFT?'#ffd700':TK[p.token]?.c||'#fff'}}>{p.isNFT?p.nftName||'NFT':`${fmtN(p.amount,2)} ${p.token}`}</span>
            </div>))}
          </div>}
        </div>
      </div>
    </div>
  );
};

// ─── WINNERS TAB — Podium + LIVE week leaderboard ────────────────────────────
const WinnersTab:FC<{w:WConfig;logs:ChallengeLog[];isMobile:boolean;connection:any;onDeleteLog?:(idx:number)=>void}>=({w,logs,isMobile,connection,onDeleteLog})=>{
  const brainsPrice=useAdmBrainsPrice();
  const winners=w.winners||logs[0]?.winners||[];
  const sorted=[...winners].sort((a:any,b:any)=>a.place-b.place);
  const hasWinners=sorted.length>0;
  const top3=sorted.slice(0,3);
  const[popup,setPopup]=useState<{wn:any;rank:number}|null>(null);
  const receipts=w.sendReceipts||logs[0]?.sendReceipts||[];
  const isPaid=(place:number)=>receipts.some(r=>r.place===place);
  const allPaid=top3.every((_:any,i:number)=>isPaid(i));
  const weekId=w.weekId||logs[0]?.weekId||'—';
  const totalAmpVal=w.challenges?.reduce((s:number,c:any)=>s+(TIER_AMPS[c.tier]||0),0)||0;
  const fmtUsd=(v:number)=>v>=1e6?`$${(v/1e6).toFixed(2)}M`:v>=1e3?`$${(v/1e3).toFixed(1)}K`:v>=1?`$${v.toFixed(2)}`:v>=0.001?`$${v.toFixed(4)}`:`$${v.toFixed(6)}`;

  // Detect time-up state
  const timeUp=w.status==='active'&&w.endDate&&new Date(w.endDate).getTime()<=Date.now();

  // ─── LIVE WEEK LEADERBOARD (date-filtered) ──────────────────────────────
  const isLive=w.status==='active'||w.status==='paused';
  const[lbEntries,setLbEntries]=useState<BurnerEntry[]>([]);
  const[lbLoading,setLbLoading]=useState(false);
  const[lbProgress,setLbProgress]=useState('');
  const[lbFetchedAt,setLbFetchedAt]=useState<Date|null>(null);
  const lbAbortRef=useRef<AbortController|null>(null);
  const lbMountRef=useRef(true);

  const loadLb=React.useCallback(async()=>{
    if(!connection||(!isLive&&!timeUp))return;
    lbAbortRef.current?.abort();
    const ctrl=new AbortController();
    lbAbortRef.current=ctrl;
    setLbLoading(true);setLbProgress('Scanning chain…');
    try{
      const full=await fetchLeaderboard(connection,ctrl.signal,(_,progress)=>{
        if(!lbMountRef.current||ctrl.signal.aborted)return;
        setLbProgress(progress);
      });
      if(!lbMountRef.current||ctrl.signal.aborted)return;
      const startTs=w.startDate?Math.floor(new Date(w.startDate).getTime()/1000):0;
      const endTs=w.endDate?Math.floor(new Date(w.endDate).getTime()/1000):Infinity;
      const weekEntries=full.map(e=>{
        const ev=(e.events||[]).filter(ev=>ev.blockTime>=startTs&&ev.blockTime<=endTs);
        if(!ev.length)return null;
        const burned=ev.reduce((s,x)=>s+x.amount,0);
        return{address:e.address,burned,txCount:ev.length,points:Math.floor(burned*1.888),events:ev} as BurnerEntry;
      }).filter((e):e is BurnerEntry=>e!==null&&e.points>0).sort((a,b)=>b.points-a.points);
      setLbEntries(weekEntries);setLbFetchedAt(new Date());
    }catch{}
    setLbLoading(false);
  },[connection,isLive,timeUp,w.startDate,w.endDate]);

  useEffect(()=>{lbMountRef.current=true;if(isLive||timeUp)loadLb();return()=>{lbMountRef.current=false;lbAbortRef.current?.abort();};},[loadLb,isLive,timeUp]);
  useEffect(()=>{if(!isLive)return;const id=setInterval(loadLb,30000);return()=>clearInterval(id);},[isLive,loadLb]);

  // Derive projected winners from leaderboard when time is up but no declared winners
  const projectedWinners:Winner[]=(!hasWinners&&(timeUp||w.status==='ended')&&lbEntries.length>0)?
    lbEntries.slice(0,3).map((e,i)=>({
      address:e.address,
      place:i,
      weeklyPts:Math.floor(e.points*(1+totalAmpVal/100)),
      weeklyBurned:e.burned,
      ampPct:totalAmpVal,
      prizes:w.prizes[i]||[],
    } as Winner)):[];
  const displayWinners=hasWinners?sorted:projectedWinners;
  const displayTop3=displayWinners.slice(0,3);
  const isProjected=!hasWinners&&projectedWinners.length>0;

  if(displayWinners.length===0&&!lbLoading)return(
    <div style={{textAlign:'center',padding:'40px 20px'}}>
      <div style={{fontSize:48,marginBottom:12}}>🏆</div>
      {timeUp?(
        <>
          <div style={{fontFamily:'Orbitron,monospace',fontSize:14,color:'#ff4466',letterSpacing:3,marginBottom:8}}>⚠️ CHALLENGE TIME ENDED</div>
          <div style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#8a9aaa',marginBottom:16}}>
            Loading leaderboard to determine winners...
          </div>
          <button onClick={loadLb} style={{padding:'10px 24px',background:'rgba(255,68,102,.1)',border:'1px solid rgba(255,68,102,.4)',borderRadius:10,color:'#ff4466',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,letterSpacing:2,cursor:'pointer'}}>↻ FETCH LEADERBOARD</button>
        </>
      ):(
        <>
          <div style={{fontFamily:'Orbitron,monospace',fontSize:14,color:'#ffd700',letterSpacing:3,marginBottom:8}}>NO WINNERS YET</div>
          <div style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#8a9aaa'}}>
            {w.status==='active'?'Challenge is live — winners will be determined when it ends.':
             w.status==='paused'?'Challenge is paused. Resume or stop to determine winners.':
             'Start a challenge to begin tracking burns and LB Points.'}
          </div>
        </>
      )}
    </div>
  );

  if(displayWinners.length===0&&lbLoading)return(
    <div style={{textAlign:'center',padding:'40px 20px'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,marginBottom:12}}>
        <div style={{width:18,height:18,border:'2px solid rgba(255,215,0,.2)',borderTop:'2px solid #ffd700',borderRadius:'50%',animation:'rw-pulse .7s linear infinite'}} />
        <span style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#aabbcc'}}>{lbProgress||'Scanning chain for winners...'}</span>
      </div>
    </div>
  );

  // Podium order: 2nd | 1st | 3rd (aligned to bottom)
  const podiumOrder=[displayTop3.find((s:any)=>s.place===1),displayTop3.find((s:any)=>s.place===0),displayTop3.find((s:any)=>s.place===2)].filter(Boolean);

  return(<>
    {/* ── PROJECTED BANNER ── */}
    {isProjected&&(
      <div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 16px',background:'rgba(255,140,0,.08)',border:'1px solid rgba(255,140,0,.3)',borderLeft:'4px solid #ff9933',borderRadius:10,marginBottom:14}}>
        <span style={{fontSize:18}}>⚠️</span>
        <div>
          <div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#ff9933',fontWeight:700,letterSpacing:2}}>CHALLENGE ENDED — PROJECTED WINNERS</div>
          <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#8a9aaa',marginTop:2}}>These winners are based on the current leaderboard. Go to <span style={{color:'#ff4466',fontWeight:700}}>CONTROL</span> tab → <span style={{color:'#ff4466',fontWeight:700}}>STOP & DECLARE WINNERS</span> to finalize and enable prize sending.</div>
        </div>
      </div>
    )}
    {/* ── WEEK INFO HEADER ── */}
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 16px',background:'rgba(140,60,255,.04)',border:'1px solid rgba(140,60,255,.1)',borderRadius:10,marginBottom:14,flexWrap:'wrap',gap:8}}>
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <span style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:900,color:'#fff',letterSpacing:2}}>{weekId}</span>
        {w.startDate&&<span style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#8899aa'}}>
          {new Date(w.startDate).toLocaleDateString('en-US',{month:'short',day:'numeric'})} → {w.endDate?new Date(w.endDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'—'}
        </span>}
      </div>
      <div style={{display:'flex',gap:6}}>
        {allPaid?
          <div style={{padding:'4px 12px',background:'rgba(57,255,136,.08)',border:'1px solid rgba(57,255,136,.25)',borderRadius:6,fontFamily:'Orbitron,monospace',fontSize:9,color:'#39ff88',letterSpacing:2}}>✅ ALL PRIZES SENT</div>:
          <div style={{padding:'4px 12px',background:'rgba(255,140,0,.08)',border:'1px solid rgba(255,140,0,.25)',borderRadius:6,fontFamily:'Orbitron,monospace',fontSize:9,color:'#ff9933',letterSpacing:2}}>⚠️ PRIZES PENDING</div>
        }
        {totalAmpVal>0&&<span style={{padding:'4px 10px',background:'rgba(57,255,136,.04)',border:'1px solid rgba(57,255,136,.1)',borderRadius:6,fontFamily:'Orbitron,monospace',fontSize:8,color:'#39ff88'}}>AMP +{totalAmpVal.toFixed(2)}%</span>}
      </div>
    </div>

    <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#b0c4cc',letterSpacing:3,marginBottom:10,textAlign:'center'}}>◆ PODIUM · CHALLENGE WINNERS</div>
    <div style={{display:'flex',gap:isMobile?8:12,alignItems:'flex-end',marginBottom:20}}>
      {podiumOrder.map((wn:any,pIdx:number)=>{
        if(!wn)return null;
        const rank=wn.place+1;
        const cfg=POD_CFG[wn.place];
        const isTop=wn.place===0;
        const imgSize=isMobile?(isTop?100:80):(isTop?130:105);
        const paid=isPaid(wn.place);
        const burnedUsd=brainsPrice&&wn.weeklyBurned?wn.weeklyBurned*brainsPrice:null;
        return(
          <div key={wn.place} onClick={()=>setPopup({wn,rank})}
            style={{flex:1,position:'relative',overflow:'hidden',cursor:'pointer',
              background:'linear-gradient(160deg,#06040e,#08060f)',
              border:`1px solid ${cfg.border}${isTop?'88':'55'}`,borderTop:`3px solid ${cfg.border}`,borderRadius:12,
              padding:isMobile?'14px 10px 12px':'20px 16px 14px',
              animation:`adm-fade 0.4s ease ${pIdx*0.1}s both`,
              minHeight:isTop?(isMobile?360:420):(isMobile?320:380),
              display:'flex',flexDirection:'column',alignItems:'center',
            }}>
            <div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(rgba(100,60,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.03) 1px,transparent 1px)',backgroundSize:'24px 24px',pointerEvents:'none'}}/>
            {isTop&&<div style={{position:'absolute',inset:0,background:'linear-gradient(90deg,transparent,rgba(255,215,0,.03),transparent)',backgroundSize:'200% 100%',pointerEvents:'none'}}/>}

            {/* PAID / UNPAID badge */}
            <div style={{position:'absolute',top:8,right:8,zIndex:3,padding:'3px 8px',borderRadius:4,fontFamily:'Orbitron,monospace',fontSize:7,letterSpacing:1,
              background:paid?'rgba(57,255,136,.1)':'rgba(255,140,0,.1)',
              border:`1px solid ${paid?'rgba(57,255,136,.3)':'rgba(255,140,0,.3)'}`,
              color:paid?'#39ff88':'#ff9933'}}>
              {paid?'✅ PAID':'⏳ UNPAID'}
            </div>

            {/* Crown + rank label */}
            <div style={{textAlign:'center',marginBottom:isMobile?6:10,position:'relative',zIndex:2}}>
              <div style={{fontSize:isTop?36:28,lineHeight:1,filter:`drop-shadow(0 0 10px ${cfg.border}88)`}}>
                {rank===1?'👑':rank===2?'🥈':'🥉'}
              </div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?11:14,fontWeight:700,color:cfg.label,letterSpacing:3,marginTop:4}}>{cfg.rank}</div>
            </div>

            {/* Profile image */}
            <div style={{position:'relative',zIndex:2,marginBottom:isMobile?10:14}}>
              <div style={{position:'absolute',inset:-4,borderRadius:'50%',border:`2px solid ${cfg.border}44`,boxShadow:`0 0 20px ${cfg.border}33`,animation:`${cfg.glow} 2.5s ease infinite`,pointerEvents:'none'}}/>
              <div style={{width:imgSize,height:imgSize,borderRadius:'50%',overflow:'hidden',border:`3px solid ${cfg.border}`,boxShadow:`0 0 20px ${cfg.border}44`,background:'#0a0a14'}}>
                <img src={PODIUM_IMAGES[rank].src} alt={`Rank ${rank}`} loading="eager"
                  style={{width:'100%',height:'100%',objectFit:'cover',objectPosition:'center top',display:'block',transform:`scale(${PODIUM_IMAGES[rank].scale})`}}
                  onError={e=>{(e.target as HTMLImageElement).style.display='none';}}/>
              </div>
            </div>

            {/* Address */}
            <div style={{textAlign:'center',marginBottom:isMobile?6:10,position:'relative',zIndex:2}}>
              <div style={{fontFamily:'monospace',fontSize:isMobile?12:14,color:cfg.label,letterSpacing:0.5,fontWeight:700}}>{short(wn.address)}</div>
            </div>

            {/* Stats */}
            <div style={{display:'flex',flexDirection:'column',gap:5,width:'100%',marginTop:'auto',position:'relative',zIndex:2}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:'rgba(255,140,0,.06)',borderRadius:8,border:'1px solid rgba(255,140,0,.1)'}}>
                <span style={{display:'flex',alignItems:'center',gap:4,fontFamily:'Orbitron,monospace',fontSize:isMobile?8:10,color:'#ff9933'}}>
                  <img src={BRAINS_LOGO} alt="" style={{width:12,height:12,borderRadius:'50%'}}/> 🔥 BURNED
                </span>
                <div style={{textAlign:'right'}}>
                  <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?13:16,fontWeight:900,color:'#ff9933'}}>{fmtN(wn.weeklyBurned||0,1)}</span>
                  {burnedUsd!=null&&<div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:10,color:'#ffd700',fontWeight:700}}>≈ {fmtUsd(burnedUsd)}</div>}
                </div>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:`${cfg.border}0a`,borderRadius:8,border:`1px solid ${cfg.border}15`}}>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:10,color:cfg.label}}>◆ LB PTS</span>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?14:18,fontWeight:900,color:cfg.label}}>{fmtN(wn.weeklyPts||0,0)}</span>
              </div>
              {wn.ampPct>0&&<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 12px',background:'rgba(57,255,136,.04)',borderRadius:8,border:'1px solid rgba(57,255,136,.1)'}}>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:9,color:'#39ff88'}}>⚡ AMPLIFIER</span>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?11:13,fontWeight:700,color:'#39ff88'}}>+{wn.ampPct.toFixed(2)}%</span>
              </div>}
              {(wn.prizes||[]).length>0&&<div style={{display:'flex',justifyContent:'center',gap:5,flexWrap:'wrap',marginTop:3}}>
                {(wn.prizes||[]).map((p:PrizeItem,j:number)=>(<div key={j} style={{display:'flex',alignItems:'center',gap:4,padding:'3px 8px',background:'rgba(255,215,0,.05)',borderRadius:5,border:'1px solid rgba(255,215,0,.12)'}}>
                  {p.isNFT?<span style={{fontSize:10}}>🖼️</span>:<TkLogo t={p.token} s={11}/>}
                  <span style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?9:10,color:p.isNFT?'#ffd700':TK[p.token]?.c||'#fff',fontWeight:700}}>{p.isNFT?'NFT':`${fmtN(p.amount,0)} ${p.token}`}</span>
                </div>))}
              </div>}
            </div>
            <div style={{textAlign:'center',marginTop:8,fontFamily:'Orbitron,monospace',fontSize:7,color:'#556677',letterSpacing:2,position:'relative',zIndex:2}}>TAP FOR DETAILS</div>
          </div>
        );
      })}
    </div>

    {/* Popup */}
    {popup&&createPortal(<AdmPodiumPopup wn={popup.wn} rank={popup.rank} onClose={()=>setPopup(null)}/>,document.body)}

    {/* ═══ PRIZE SEND HISTORY LOG ═══ */}
    {(receipts.length>0||logs.some(l=>(l.sendReceipts||[]).length>0))&&(
      <div style={{marginTop:20,padding:isMobile?'14px 12px':'18px 20px',background:'linear-gradient(160deg,#04060f,#07050e)',border:'1px solid rgba(255,215,0,.12)',borderTop:'2px solid rgba(255,215,0,.25)',borderRadius:14}}>
        <div style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:800,color:'#ffd700',letterSpacing:2,marginBottom:14,display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:16}}>📜</span> PRIZE SEND HISTORY
        </div>
        {/* Current week receipts */}
        {receipts.length>0&&<>
          <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#cc88ff',letterSpacing:2,marginBottom:8}}>CURRENT: {weekId}</div>
          {receipts.map((r:SendReceipt,i:number)=>{
            const cl=r.place===0?'#ffd700':r.place===1?'#cc88ff':'#39ff88';
            const medal=['🥇','🥈','🥉'][r.place];
            const plabel=['1ST','2ND','3RD'][r.place];
            const totalTokenUsd=brainsPrice?r.items.filter(it=>!it.isNFT&&it.token==='BRAINS').reduce((s,it)=>s+it.amount*brainsPrice,0):0;
            return(
              <div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',marginBottom:6,background:`${cl}06`,borderLeft:`3px solid ${cl}`,borderRadius:8,border:`1px solid ${cl}18`,flexWrap:'wrap'}}>
                <span style={{fontSize:16}}>{medal}</span>
                <div style={{flex:1,minWidth:120}}>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,color:cl}}>{plabel} PLACE</div>
                  <div style={{fontFamily:'monospace',fontSize:10,color:'#aabbcc'}}>{short(r.wallet)}</div>
                </div>
                <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                  {r.items.map((it,j)=>(
                    <span key={j} style={{fontFamily:'Orbitron,monospace',fontSize:9,color:it.isNFT?'#ffd700':TK[it.token]?.c||'#fff',padding:'2px 6px',background:'rgba(0,0,0,.2)',borderRadius:4}}>
                      {it.isNFT?'🖼️ NFT':`${fmtN(it.amount,0)} ${it.token}`}
                    </span>
                  ))}
                </div>
                {totalTokenUsd>0&&<span style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#ffd700',fontWeight:700}}>≈ {fmtUsd(totalTokenUsd)}</span>}
                <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2}}>
                  <span style={{fontFamily:'Sora,sans-serif',fontSize:8,color:'#667788'}}>{new Date(r.timestamp).toLocaleString()}</span>
                  {r.txSig&&<a href={`https://explorer.mainnet.x1.xyz/tx/${r.txSig}`} target="_blank" rel="noopener noreferrer" style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#aa77ff',textDecoration:'none',padding:'1px 6px',background:'rgba(140,60,255,.08)',border:'1px solid rgba(140,60,255,.15)',borderRadius:3}}>↗ TX</a>}
                </div>
              </div>
            );
          })}
        </>}
        {/* Historical receipts from past weeks */}
        {logs.filter(l=>(l.sendReceipts||[]).length>0).map((lg,li)=>(
          <div key={li} style={{marginTop:receipts.length>0||li>0?12:0}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
              <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#8899aa',letterSpacing:2}}>{lg.weekId}</span>
              <span style={{fontFamily:'Sora,sans-serif',fontSize:8,color:'#556677'}}>
                {lg.startDate?new Date(lg.startDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'—'} → {lg.endDate?new Date(lg.endDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'—'}
              </span>
              <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88',padding:'2px 6px',background:'rgba(57,255,136,.06)',borderRadius:3}}>AMP +{(lg.challenges||[]).reduce((s:number,c:any)=>s+(TIER_AMPS[c.tier]||0),0).toFixed(2)}%</span>
            </div>
            {(lg.sendReceipts||[]).map((r:SendReceipt,ri:number)=>{
              const cl=r.place===0?'#ffd700':r.place===1?'#cc88ff':'#39ff88';
              return(
                <div key={ri} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 12px',marginBottom:3,background:`${cl}04`,borderLeft:`2px solid ${cl}`,borderRadius:6,fontSize:9,flexWrap:'wrap'}}>
                  <span>{['🥇','🥈','🥉'][r.place]}</span>
                  <span style={{fontFamily:'monospace',fontSize:9,color:'#aabbcc'}}>{short(r.wallet)}</span>
                  {r.items.map((it,j)=><span key={j} style={{fontFamily:'Orbitron,monospace',fontSize:8,color:it.isNFT?'#ffd700':TK[it.token]?.c||'#fff'}}>{it.isNFT?'NFT':`${fmtN(it.amount,0)} ${it.token}`}</span>)}
                  <span style={{fontFamily:'Sora,sans-serif',fontSize:7,color:'#556677',marginLeft:'auto'}}>{new Date(r.timestamp).toLocaleDateString()}</span>
                  {r.txSig&&<a href={`https://explorer.mainnet.x1.xyz/tx/${r.txSig}`} target="_blank" rel="noopener noreferrer" style={{fontFamily:'Orbitron,monospace',fontSize:6,color:'#aa77ff',textDecoration:'none'}}>TX ↗</a>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    )}

    {/* ═══ LIVE WEEK LEADERBOARD ═══ */}
    {isLive&&(
      <div style={{marginTop:20,padding:isMobile?'14px 12px':'18px 20px',background:'linear-gradient(160deg,#04060f,#07050e,#050a12)',border:'1px solid rgba(57,255,136,.12)',borderTop:'2px solid rgba(57,255,136,.3)',borderRadius:14,position:'relative',overflow:'hidden'}}>
        <div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(rgba(100,60,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(100,60,255,.025) 1px,transparent 1px)',backgroundSize:'24px 24px',pointerEvents:'none'}}/>
        <div style={{position:'relative',zIndex:1}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:8}}>
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <div style={{display:'flex',alignItems:'center',gap:5}}><div style={{width:6,height:6,borderRadius:'50%',background:'#39ff88',animation:'adm-pulse 1.6s ease infinite'}}/><span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#39ff88',letterSpacing:2}}>LIVE</span></div>
              <span style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:800,color:'#39ff88',letterSpacing:2}}>WEEK LEADERBOARD</span>
              {lbEntries.length>0&&<span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#cc88ff',background:'rgba(140,50,255,.1)',border:'1px solid rgba(140,50,255,.25)',padding:'2px 8px',borderRadius:4}}>{lbEntries.length} PARTICIPANTS</span>}
            </div>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              {lbFetchedAt&&<span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#aabbcc'}}>↻ {lbFetchedAt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}
              <button onClick={loadLb} disabled={lbLoading} style={{background:'rgba(57,255,136,.06)',border:'1px solid rgba(57,255,136,.2)',color:'#39ff88',padding:'4px 12px',fontFamily:'Orbitron,monospace',fontSize:8,borderRadius:6,cursor:lbLoading?'not-allowed':'pointer',opacity:lbLoading?.5:1}}>↺ REFRESH</button>
            </div>
          </div>
          {lbLoading&&lbEntries.length===0&&(
            <div style={{display:'flex',alignItems:'center',gap:10,padding:14,background:'rgba(140,60,255,.04)',borderRadius:8,marginBottom:12}}>
              <div style={{width:18,height:18,border:'2px solid rgba(140,60,255,.2)',borderTop:'2px solid #aa44ff',borderRadius:'50%',animation:'adm-pulse .7s linear infinite'}}/>
              <span style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#aabbcc'}}>{lbProgress}</span>
            </div>
          )}
          {lbEntries.length>0&&(<>
            <div style={{display:'grid',gridTemplateColumns:isMobile?'30px 1fr 80px 60px':'36px 1fr 130px 100px 50px',gap:8,padding:'4px 14px 8px',borderBottom:'1px solid rgba(120,60,255,.1)',marginBottom:6}}>
              {(isMobile?['#','WALLET','BURNED','LB PTS']:['#','WALLET','BRAINS BURNED','LB PTS','TXS']).map(h=><div key={h} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#aabbcc',letterSpacing:2}}>{h}</div>)}
            </div>
            <div style={{display:'flex',flexDirection:'column',gap:4}}>
              {lbEntries.map((e,i)=>{
                const isTop3=i<3;const rankC=isTop3?['#ffd700','#cc88ff','#39ff88'][i]:'#99aacc';
                return(
                  <div key={e.address} style={{display:'grid',gridTemplateColumns:isMobile?'30px 1fr 80px 60px':'36px 1fr 130px 100px 50px',alignItems:'center',gap:8,padding:'8px 14px',background:isTop3?`${rankC}06`:i%2===0?'#05040c':'#040308',border:`1px solid ${isTop3?`${rankC}22`:'rgba(140,60,255,.06)'}`,borderLeft:`3px solid ${isTop3?rankC:'rgba(140,60,255,.15)'}`,borderRadius:8}}>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:isTop3?900:700,color:rankC,textAlign:'center'}}>{isTop3?['🥇','🥈','🥉'][i]:i+1}</div>
                    <div><div style={{fontFamily:'monospace',fontSize:isMobile?10:12,color:isTop3?rankC:'#aabbcc'}}>{short(e.address)}</div></div>
                    <div style={{textAlign:'right'}}><span style={{fontFamily:'Sora,sans-serif',fontSize:isMobile?9:11,color:'#ff9933'}}>🔥 {fmtN(e.burned,1)}</span></div>
                    <div style={{textAlign:'right'}}><div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?11:13,fontWeight:700,color:isTop3?'#55ffaa':'#39ff88'}}>{fmtPts(e.points)}</div></div>
                    {!isMobile&&<div style={{textAlign:'right'}}><div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#b0c4cc'}}>{e.txCount}</div></div>}
                  </div>
                );
              })}
            </div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:12,padding:'8px 14px',background:'rgba(140,60,255,.03)',border:'1px solid rgba(140,60,255,.08)',borderRadius:8,flexWrap:'wrap',gap:6}}>
              <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#667788'}}>PARTICIPANTS: <span style={{color:'#cc88ff'}}>{lbEntries.length}</span></span>
              <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#667788'}}>BURNED: <span style={{color:'#ff9933'}}>{fmtN(lbEntries.reduce((s,e)=>s+e.burned,0),1)}</span></span>
              <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#667788'}}>TOP: <span style={{color:'#39ff88'}}>{lbEntries.length>0?fmtPts(lbEntries[0].points):'—'}</span></span>
            </div>
          </>)}
          {!lbLoading&&lbEntries.length===0&&(
            <div style={{textAlign:'center',padding:'20px'}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#39ff88',letterSpacing:2,marginBottom:6}}>NO BURNS YET</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#667788'}}>Waiting for burns during the challenge window.</div>
            </div>
          )}
        </div>
      </div>
    )}

    {/* ═══ HISTORICAL WINNERS LOG ═══ */}
    {logs.filter(l=>(l.winners||[]).length>0).length>0&&(
      <div style={{marginTop:24}}>
        <div style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:800,color:'#cc88ff',letterSpacing:2,marginBottom:14,display:'flex',alignItems:'center',gap:8}}>
          <span style={{fontSize:16}}>📚</span> CHALLENGE WINNERS HISTORY
        </div>
        {logs.map((lg,li)=>{
          const lgWinners=(lg.winners||[]).sort((a:any,b:any)=>a.place-b.place);
          if(lgWinners.length===0)return null;
          const lgAmp=(lg.challenges||[]).reduce((s:number,c:any)=>s+(TIER_AMPS[c.tier]||0),0);
          const lgReceipts=lg.sendReceipts||[];
          const lgAllPaid=lgWinners.slice(0,3).every((_:any,i:number)=>lgReceipts.some(r=>r.place===i));
          return(
            <div key={li} style={{marginBottom:14,background:'linear-gradient(160deg,#06040e,#08060f)',border:'1px solid rgba(140,60,255,.1)',borderRadius:12,overflow:'hidden',position:'relative'}}>
              {/* Header bar */}
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 14px',borderBottom:'1px solid rgba(140,60,255,.06)',background:'rgba(140,60,255,.03)',flexWrap:'wrap',gap:6}}>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                  <span style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:900,color:'#fff',letterSpacing:2}}>{lg.weekId}</span>
                  <span style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#8899aa'}}>
                    {lg.startDate?new Date(lg.startDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'—'} → {lg.endDate?new Date(lg.endDate).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'—'}
                  </span>
                  {lgAmp>0&&<span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88',padding:'2px 6px',background:'rgba(57,255,136,.06)',border:'1px solid rgba(57,255,136,.12)',borderRadius:3}}>AMP +{lgAmp.toFixed(2)}%</span>}
                  {lgAllPaid?
                    <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88',padding:'2px 6px',background:'rgba(57,255,136,.06)',borderRadius:3}}>✅ PAID</span>:
                    <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#ff9933',padding:'2px 6px',background:'rgba(255,153,51,.06)',borderRadius:3}}>⚠️ UNPAID</span>
                  }
                </div>
                <div style={{display:'flex',gap:4}}>
                  {lg.stoppedAt&&<span style={{fontFamily:'Sora,sans-serif',fontSize:8,color:'#556677'}}>Ended {new Date(lg.stoppedAt).toLocaleDateString()}</span>}
                  {onDeleteLog&&<button onClick={()=>onDeleteLog(li)} style={{padding:'3px 8px',background:'rgba(255,68,102,.08)',border:'1px solid rgba(255,68,102,.2)',borderRadius:4,color:'#ff4466',fontFamily:'Orbitron,monospace',fontSize:7,cursor:'pointer'}}>🗑</button>}
                </div>
              </div>
              {/* Challenges info */}
              {(lg.challenges||[]).length>0&&(
                <div style={{display:'flex',gap:4,flexWrap:'wrap',padding:'8px 14px',borderBottom:'1px solid rgba(140,60,255,.04)'}}>
                  {(lg.challenges||[]).map((c:any,ci:number)=>{const tc=TIER_C[c.tier as 1|2|3|4];return(
                    <span key={ci} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:tc?.c||'#fff',padding:'3px 8px',background:tc?.bg||'rgba(255,255,255,.03)',border:`1px solid ${tc?.bd||'rgba(255,255,255,.1)'}`,borderRadius:4}}>{c.icon||'⚡'} {c.title||'Untitled'} — T{c.tier}</span>
                  );})}
                </div>
              )}
              {/* Winners row */}
              <div style={{padding:'10px 14px'}}>
                {lgWinners.slice(0,3).map((wn:any,wi:number)=>{
                  const cl=wn.place===0?'#ffd700':wn.place===1?'#cc88ff':'#39ff88';
                  const medal=['🥇','🥈','🥉'][wn.place];
                  const plbl=['1ST','2ND','3RD'][wn.place];
                  const paid=lgReceipts.some((r:SendReceipt)=>r.place===wn.place);
                  return(
                    <div key={wi} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 0',borderBottom:wi<2?'1px solid rgba(255,255,255,.02)':'none'}}>
                      <span style={{fontSize:16}}>{medal}</span>
                      <div style={{flex:1}}>
                        <div style={{fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:cl,letterSpacing:1}}>{plbl} PLACE</div>
                        <div style={{fontFamily:'monospace',fontSize:10,color:'#aabbcc'}}>{short(wn.address)}</div>
                      </div>
                      <div style={{textAlign:'right'}}>
                        <div style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,color:'#ff9933'}}>🔥 {fmtN(wn.weeklyBurned||0,1)}</div>
                        <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:cl}}>{fmtPts(wn.weeklyPts||0)} LB</div>
                      </div>
                      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2}}>
                        {(wn.prizes||[]).map((p:PrizeItem,pi:number)=>(
                          <span key={pi} style={{fontFamily:'Orbitron,monospace',fontSize:8,color:p.isNFT?'#ffd700':TK[p.token]?.c||'#fff'}}>{p.isNFT?'🖼️ NFT':`${fmtN(p.amount,0)} ${p.token}`}</span>
                        ))}
                        <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:paid?'#39ff88':'#ff9933'}}>{paid?'✅ PAID':'⏳ UNPAID'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    )}
  </>);
};

// ═════════════════════════════════════════════════════════════════════════════
const AdminRewards:FC=()=>{
  // ── EMERGENCY RESET — visit /x9b7r41ns/ctrl?reset=1 to clear stuck state ──
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    if(params.get('reset')==='1'){
      try{localStorage.removeItem(LS_W);localStorage.removeItem(LS_L);localStorage.removeItem(LS_A);}catch{}
      window.location.href=window.location.pathname; // reload without ?reset
    }
  },[]);
  const navigate=useNavigate();const{connection}=useConnection();const wallet=useWallet();const{setVisible}=useWalletModal();
  const wa=wallet.publicKey?.toBase58()||'';const isAdmin=wa===ADMIN_WALLET;
  const[isMobile,setIsMobile]=useState(window.innerWidth<768);
  useEffect(()=>{const h=()=>setIsMobile(window.innerWidth<768);window.addEventListener('resize',h);return()=>window.removeEventListener('resize',h);},[]);
  const[tab,setTab]=useState('weekly');const[saved,setSaved]=useState('');const show=(m:string)=>{setSaved(m);setTimeout(()=>setSaved(''),2500);};
  const[sectionOk,setSectionOk]=useState<{week:boolean;challenges:boolean;prizes:boolean}>(()=>{
    const d=loadJ(LS_W,null);
    return{week:!!d?.sectionConfirmed?.week,challenges:!!d?.sectionConfirmed?.challenges,prizes:!!d?.sectionConfirmed?.prizes};
  });

  const ep:[PrizeItem[],PrizeItem[],PrizeItem[]]=[[{token:'BRAINS',amount:5000}],[{token:'BRAINS',amount:2500}],[{token:'BRAINS',amount:1000}]];
  const[w,setW]=useState(()=>{const d=loadJ(LS_W,null);if(d&&d.weekId){if(!d.prizes||!Array.isArray(d.prizes)||d.prizes.length<3)d.prizes=ep;return d as WConfig;}return{weekId:'week-001',startDate:'',endDate:'',challenges:[],prizes:ep,status:'upcoming'} as WConfig;});
  const[anns,setAnns]=useState(()=>loadJ(LS_A,[]) as any[]);const[newA,setNewA]=useState({title:'',message:'',type:'info'});
  const[logs,setLogs]=useState(()=>loadJ(LS_L,[]) as ChallengeLog[]);

  // ── SUPABASE LOAD ON MOUNT — overwrites localStorage state with DB data ──
  const[sbReady,setSbReady]=useState(false);
  useEffect(()=>{
    (async()=>{
      try{
        const sb=await import('../lib/supabase');
        // Weekly Config
        const wc=await sb.getWeeklyConfig();
        if(wc&&wc.weekId){
          if(!wc.prizes||!Array.isArray(wc.prizes)||wc.prizes.length<3)wc.prizes=ep;
          setW(wc as WConfig);
          setSectionOk({week:!!wc.sectionConfirmed?.week,challenges:!!wc.sectionConfirmed?.challenges,prizes:!!wc.sectionConfirmed?.prizes});
        }
        // Challenge Logs
        const cl=await sb.getChallengeLogs();
        if(cl.length>0)setLogs(cl as ChallengeLog[]);
        // Announcements
        const an=await sb.getAnnouncements();
        if(an.length>0)setAnns(an);
        // Lab Work Rewards
        const lw=await sb.getAllLabWorkRewards();
        if(lw.length>0){
          const mapped:LWReward[]=lw.map(r=>({id:r.id,address:r.address,lbPoints:r.lb_points,reason:r.reason,category:r.category||'other',date:r.created_at}));
          setLwRewards(mapped);
        }
        // Submissions
        const subs=await sb.getSubmissions();
        if(subs.length>0){
          try{localStorage.setItem('brains_labwork_submissions',JSON.stringify(subs.map(s=>({id:s.id,address:s.address,category:s.category,links:s.links,description:s.description,status:s.status,date:s.created_at}))));}catch{}
        }
        setSbReady(true);
      }catch(e){console.warn('[Admin] Supabase load failed, using localStorage',e);setSbReady(true);}
    })();
  },[]);
  const[sendForms,setSendForms]=useState<{wallet:string;items:PrizeItem[]}[]>([{wallet:'',items:[]},{wallet:'',items:[]},{wallet:'',items:[]}]);
  const[sending,setSending]=useState(false);
  const[sendLog,setSendLog]=useState<string[]>([]);
  const[stopConfirm,setStopConfirm]=useState<{entries:BurnerEntry[];winners:Winner[]}|null>(null);
  const[stopLoading,setStopLoading]=useState(false);
  const[showSendWinners,setShowSendWinners]=useState(true);

  // ── LAB WORK REWARDS (manual LB Points for social media / promo contributions) ──
  interface LWReward { id:string; address:string; lbPoints:number; reason:string; category:string; date:string; }
  const[lwRewards,setLwRewards]=useState<LWReward[]>(()=>loadJ(LS_LW,[]) as LWReward[]);
  const[lwForm,setLwForm]=useState({address:'',lbPoints:'',reason:'',category:'social'});
  const lwCategories=[{k:'social',l:'📱 Social Media Post',c:'#00ccff'},{k:'content',l:'📝 Content / Article',c:'#ff9933'},{k:'video',l:'🎬 Video / Reel',c:'#ff4466'},{k:'community',l:'🤝 Community Support',c:'#39ff88'},{k:'promo',l:'📣 Raid / Promotion',c:'#cc88ff'},{k:'other',l:'⚡ Other',c:'#ffcc55'}];

  const addLwReward=async()=>{
    if(!lwForm.address.trim()){show('⚠️ Enter wallet address');return;}
    const pts=parseFloat(lwForm.lbPoints);if(!pts||pts<=0){show('⚠️ Enter valid LB Points');return;}
    if(!window.confirm(`🧪 Award ${fmtPts(pts)} LB Points to ${lwForm.address.slice(0,8)}...?\n\nThis will be added to their leaderboard score.`))return;
    if(!window.confirm('⚠️ Are you sure you want to proceed?'))return;
    const entry:LWReward={id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),address:lwForm.address.trim(),lbPoints:pts,reason:lwForm.reason.trim()||'Lab Work Contribution',category:lwForm.category,date:new Date().toISOString()};

    // Write to Supabase
    try{
      const{awardLabWorkPoints,invalidateLabWorkCache}=await import('../lib/supabase');
      const res=await awardLabWorkPoints(entry.address,pts,entry.reason);
      if(!res.success){show(`⚠️ Supabase error: ${res.error}`);return;}
      invalidateLabWorkCache();
    }catch(e:any){show(`⚠️ Supabase failed: ${e.message}. Saving to localStorage only.`);}

    // Also save to localStorage as backup
    const updated=[entry,...lwRewards];setLwRewards(updated);saveJ(LS_LW,updated);
    setLwForm(p=>({...p,address:'',lbPoints:'',reason:''}));
    show(`✅ +${fmtPts(pts)} LB Points → ${short(entry.address)}`);
  };
  const removeLwReward=async(id:string)=>{if(!window.confirm('Remove this LB reward entry?'))return;if(!window.confirm('⚠️ Are you sure you want to proceed?'))return;
    // Delete from Supabase
    try{const{deleteLabWorkReward,invalidateLabWorkCache}=await import('../lib/supabase');await deleteLabWorkReward(id);invalidateLabWorkCache();}catch{}
    const u=lwRewards.filter(e=>e.id!==id);setLwRewards(u);saveJ(LS_LW,u);show('Removed');
  };
  const clearAllLwRewards=async()=>{if(!window.confirm(`🗑 Delete ALL ${lwRewards.length} Lab Work rewards?\n\nThis will remove all manually awarded LB Points.`))return;if(!window.confirm('⚠️ Are you sure you want to proceed? This cannot be undone.'))return;
    // Clear Supabase
    try{const{clearAllLabWorkRewards,invalidateLabWorkCache}=await import('../lib/supabase');await clearAllLabWorkRewards();invalidateLabWorkCache();}catch{}
    setLwRewards([]);saveJ(LS_LW,[]);show('All Lab Work rewards cleared');
  };
  // Aggregate by wallet
  const lwByWallet=lwRewards.reduce((m,e)=>{const prev=m.get(e.address)||{pts:0,count:0};m.set(e.address,{pts:prev.pts+e.lbPoints,count:prev.count+1});return m;},new Map<string,{pts:number;count:number}>());
  const lwTotalPts=lwRewards.reduce((s,e)=>s+e.lbPoints,0);
  const lwWalletsSorted=[...lwByWallet.entries()].sort((a,b)=>b[1].pts-a[1].pts);
  const[lwVisible,setLwVisible]=useState(()=>{try{return localStorage.getItem('brains_labwork_visible')!=='false';}catch{return true;}});
  const toggleLwVisibility=()=>{const next=!lwVisible;setLwVisible(next);try{localStorage.setItem('brains_labwork_visible',String(next));}catch{};show(next?'🧪 Submission log is now VISIBLE on the public page':'🧪 Submission log is now HIDDEN from the public page');};
  // Pending LB submissions count (for tab badge)
  const lwPendingCount=(()=>{try{const subs=JSON.parse(localStorage.getItem('brains_labwork_submissions')||'[]');return Array.isArray(subs)?subs.filter((s:any)=>s.status==='pending').length:0;}catch{return 0;}})();

  // ── REAL TOKEN TRANSFER — BATCHED per recipient ──
  const sendPrizesForPlace=async(form:{wallet:string;items:PrizeItem[]},placeLabel:string)=>{
    if(!form.wallet.trim()||form.items.length===0)return;
    if(!wallet.publicKey||!wallet.signTransaction)throw new Error('Wallet not connected');
    let recipient:PublicKey;
    try{recipient=new PublicKey(form.wallet.trim());}catch{throw new Error(`Invalid wallet address for ${placeLabel}`);}

    // Build ONE transaction with ALL transfers
    const tx=new Transaction();
    const itemDescs:string[]=[];

    for(const item of form.items){
      try{
        if(item.isNFT){
          const mintPk=new PublicKey(item.nftMint!);
          // Detect program ID from mint account owner
          let progId=TOKEN_PROGRAM_ID;
          try{const ai=await connection.getAccountInfo(mintPk);if(ai?.owner.equals(TOKEN_2022_PROGRAM_ID))progId=TOKEN_2022_PROGRAM_ID;}catch{}
          const sAta=getAssociatedTokenAddressSync(mintPk,wallet.publicKey,false,progId,ASSOCIATED_TOKEN_PROGRAM_ID);
          const rAta=getAssociatedTokenAddressSync(mintPk,recipient,false,progId,ASSOCIATED_TOKEN_PROGRAM_ID);
          try{await getAccount(connection,rAta,undefined,progId);}catch{
            tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey,rAta,recipient,mintPk,progId,ASSOCIATED_TOKEN_PROGRAM_ID));
          }
          tx.add(createTransferCheckedInstruction(sAta,mintPk,rAta,wallet.publicKey,1,0,undefined,progId));
          itemDescs.push(`NFT "${item.nftName||short(item.nftMint!)}"`);
          setSendLog(l=>[...l,`  📦 Added NFT "${item.nftName}" to batch`]);

        } else if(item.token==='XNT'){
          const lamports=Math.floor(item.amount*LAMPORTS_PER_SOL);
          tx.add(SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:recipient,lamports}));
          itemDescs.push(`${item.amount} XNT`);
          setSendLog(l=>[...l,`  📦 Added ${item.amount} XNT to batch`]);

        } else {
          const tkData=wTks.find(t=>t.symbol===item.token);
          if(!tkData){setSendLog(l=>[...l,`  ⚠️ Token ${item.token} not found in wallet, skipping`]);continue;}
          const mintPk=new PublicKey(tkData.mint);
          const progId=tkData.is2022?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
          const sAta=getAssociatedTokenAddressSync(mintPk,wallet.publicKey,false,progId,ASSOCIATED_TOKEN_PROGRAM_ID);
          const rAta=getAssociatedTokenAddressSync(mintPk,recipient,false,progId,ASSOCIATED_TOKEN_PROGRAM_ID);
          const rawAmount=BigInt(Math.floor(item.amount*Math.pow(10,tkData.decimals)));
          try{await getAccount(connection,rAta,undefined,progId);}catch{
            tx.add(createAssociatedTokenAccountInstruction(wallet.publicKey,rAta,recipient,mintPk,progId,ASSOCIATED_TOKEN_PROGRAM_ID));
          }
          tx.add(createTransferCheckedInstruction(sAta,mintPk,rAta,wallet.publicKey,rawAmount,tkData.decimals,undefined,progId));
          itemDescs.push(`${item.amount} ${item.token}`);
          setSendLog(l=>[...l,`  📦 Added ${item.amount} ${item.token} to batch`]);
        }
      }catch(e:any){
        setSendLog(l=>[...l,`  ⚠️ Failed to add ${item.isNFT?'NFT':item.token}: ${e?.message||'error'}`]);
      }
    }

    if(tx.instructions.length===0){
      setSendLog(l=>[...l,`⚠️ ${placeLabel}: No valid transfers to send`]);return;
    }

    // Send the single batched transaction
    setSendLog(l=>[...l,`🔐 ${placeLabel}: Requesting wallet approval for ${tx.instructions.length} instructions (${itemDescs.join(' + ')})...`]);
    tx.feePayer=wallet.publicKey;
    tx.recentBlockhash=(await connection.getLatestBlockhash('confirmed')).blockhash;
    const signed=await wallet.signTransaction(tx);
    const sig=await connection.sendRawTransaction(signed.serialize(),{skipPreflight:false,preflightCommitment:'confirmed'});
    setSendLog(l=>[...l,`📡 ${placeLabel}: Sent! TX: ${sig}... waiting for confirmation...`]);

    // Wait with longer timeout
    try{
      await connection.confirmTransaction(sig,'confirmed');
      setSendLog(l=>[...l,`✅ ${placeLabel}: CONFIRMED! Sent ${itemDescs.join(' + ')} → ${short(form.wallet)}`]);
    }catch{
      setSendLog(l=>[...l,`⏳ ${placeLabel}: TX submitted (${sig}...) — check explorer if not confirmed yet`]);
    }
    // Save receipt to w.sendReceipts
    const placeNum=placeLabel.includes('1st')?0:placeLabel.includes('2nd')?1:2;
    const receipt:SendReceipt={place:placeNum,wallet:form.wallet,items:form.items,txSig:sig,timestamp:new Date().toISOString()};
    setW((x:any)=>{const r=[...(x.sendReceipts||[]),receipt];const u={...x,sendReceipts:r};saveJ(LS_W,u);return u;});
  };

  const sendAllPrizes=async()=>{
    if(sending)return;
    const activeForms=sendForms.filter((f:any)=>f.wallet.trim()&&f.items.length>0);
    if(activeForms.length===0){show('⚠️ No prizes to send');return;}
    const summary=activeForms.map((f:any,i:number)=>`${['🥇 1st','🥈 2nd','🥉 3rd'][sendForms.indexOf(f)]}: ${f.items.length} prize(s) → ${f.wallet.slice(0,8)}...`).join('\n');
    if(!window.confirm(`🚀 Send all prizes?\n\n${summary}\n\nThis will execute on-chain transactions.`))return;
    if(!window.confirm('⚠️ Are you sure you want to proceed? Transactions cannot be reversed.'))return;
    setSending(true);setSendLog([]);
    const labels=['🥇 1st Place','🥈 2nd Place','🥉 3rd Place'];
    for(let i=0;i<3;i++){
      if(!sendForms[i].wallet.trim()||sendForms[i].items.length===0){
        if(sendForms[i].wallet.trim()||sendForms[i].items.length>0)setSendLog(l=>[...l,`⚠️ ${labels[i]}: Missing wallet or prizes, skipping`]);
        continue;
      }
      try{
        setSendLog(l=>[...l,`⏳ ${labels[i]}: Sending ${sendForms[i].items.length} prizes...`]);
        await sendPrizesForPlace(sendForms[i],labels[i]);
      }catch(e:any){setSendLog(l=>[...l,`❌ ${labels[i]}: ${e?.message||'Failed'}`]);}
    }
    setSendLog(l=>[...l,'🏁 Done!']);setSending(false);
  };

  // Fetch all wallet tokens + NFTs
  const{tokens:wTks,nfts:wNfts,loading:wLd,xntBal}=useAdminWallet(connection,wallet.publicKey||null);

  // ── AUTO-END: When endDate passes and challenge is active, auto-pick winners ──
  // (Must be before early returns to maintain hook ordering)
  const autoEndTriggered=useRef(false);
  useEffect(()=>{
    if(!isAdmin||w.status!=='active'||!w.endDate||autoEndTriggered.current||!connection)return;
    const endMs=new Date(w.endDate).getTime();
    const now=Date.now();
    const doAutoEnd=()=>{
      if(autoEndTriggered.current)return;
      autoEndTriggered.current=true;
      // Fetch leaderboard, compute winners, save everything
      (async()=>{
        try{
          const ctrl=new AbortController();
          const{fetchLeaderboard:fl}=await import('../components/BurnLeaderboard');
          const full=await fl(connection,ctrl.signal,()=>{});
          const startTs=w.startDate?Math.floor(new Date(w.startDate).getTime()/1000):0;
          const endTs=w.endDate?Math.floor(new Date(w.endDate).getTime()/1000):Infinity;
          const weekEntries=full.map((e:any)=>{
            const ev=(e.events||[]).filter((ev:any)=>ev.blockTime>=startTs&&ev.blockTime<=endTs);
            if(!ev.length)return null;
            const burned=ev.reduce((s:number,x:any)=>s+x.amount,0);
            return{address:e.address,burned,txCount:ev.length,points:Math.floor(burned*1.888),events:ev};
          }).filter((e:any)=>e!==null&&e.points>0).sort((a:any,b:any)=>b.points-a.points);

          // Compute winners from top 3
          const top3=weekEntries.slice(0,3);
          const totalAmpVal=w.challenges.reduce((s:number,c:any)=>s+(TIER_AMPS[c.tier]||0),0);
          const autoWinners:Winner[]=top3.map((e:any,i:number)=>({
            address:e.address,
            place:i,
            weeklyPts:Math.floor(e.points*(1+totalAmpVal/100)),
            weeklyBurned:e.burned,
            ampPct:totalAmpVal,
            prizes:w.prizes[i]||[],
          } as Winner));

          // Save winners + log + ended status
          const log:ChallengeLog={weekId:w.weekId,startDate:w.startDate,endDate:w.endDate,stoppedAt:new Date().toISOString(),challenges:w.challenges,winners:autoWinners,prizes:w.prizes,sendReceipts:w.sendReceipts};
          const updatedLogs=[log,...logs];
          saveJ(LS_L,updatedLogs);
          setLogs(updatedLogs);
          try{const sb=await import('../lib/supabase');await sb.addChallengeLog(log);sb.invalidateChallengeLogsCache();}catch{}

          const ended={...w,status:'ended',winners:autoWinners};
          saveJ(LS_W,{...ended,sectionConfirmed:{week:true,challenges:true,prizes:true}});
          setW(ended);
          show('🏆 Timer expired — Winners auto-declared! Check WINNERS tab.');
          setTab('winners');
        }catch{
          // Fallback: just set status ended so it doesn't keep retrying
          setW((x:any)=>({...x,status:'ended'}));
          saveJ(LS_W,{...w,status:'ended'});
          show('⚠️ Challenge ended — could not auto-pick winners. Use STOP & DECLARE manually.');
        }
      })();
    };
    if(now>=endMs){doAutoEnd();return;}
    const ms=endMs-now;
    if(ms>2147483647)return;
    const timer=setTimeout(doAutoEnd,ms);
    return()=>clearTimeout(timer);
  },[w.status,w.endDate,isAdmin,connection]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(w.status==='upcoming')autoEndTriggered.current=false;},[w.status]);

  if(!w.prizes||!Array.isArray(w.prizes)||w.prizes.length<3)w.prizes=ep;

  if(!wa)return(<div style={{minHeight:'100vh',background:'#080c10',padding:isMobile?'70px 12px 40px':'90px 24px 40px',position:'relative',overflow:'hidden'}}><TopBar /><PageBackground /><div style={{maxWidth:600,margin:'80px auto',textAlign:'center',padding:20}}><div style={{fontSize:48,marginBottom:16}}>🔐</div><div style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:700,color:'#ff4466',letterSpacing:3}}>ADMIN ACCESS REQUIRED</div><button onClick={()=>setVisible(true)} style={{...Btn,marginTop:16}}>CONNECT WALLET</button></div><Footer /></div>);
  if(!isAdmin)return(<div style={{minHeight:'100vh',background:'#080c10',padding:isMobile?'70px 12px 40px':'90px 24px 40px',position:'relative',overflow:'hidden'}}><TopBar /><PageBackground /><div style={{maxWidth:600,margin:'80px auto',textAlign:'center',padding:20}}><div style={{fontSize:48,marginBottom:16}}>⛔</div><div style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:700,color:'#ff4466',letterSpacing:3}}>ACCESS DENIED</div></div><Footer /></div>);

  const sv=()=>{const data={...w,sectionConfirmed:sectionOk};saveJ(LS_W,data);show('Saved');};
  const confirmSection=(s:'week'|'challenges'|'prizes')=>{
    const next={...sectionOk,[s]:true};
    setSectionOk(next);
    saveJ(LS_W,{...w,sectionConfirmed:next});
    show(`✅ ${s.charAt(0).toUpperCase()+s.slice(1)} confirmed`);
  };
  const unlockSection=(s:'week'|'challenges'|'prizes')=>{
    if(w.status==='active'){show('⚠️ Pause the challenge first to edit');return;}
    const next={...sectionOk,[s]:false};
    setSectionOk(next);
    saveJ(LS_W,{...w,sectionConfirmed:next});
  };
  const allConfirmed=sectionOk.week&&sectionOk.challenges&&sectionOk.prizes;
  const canStart=():{ok:boolean;err:string}=>{
    if(!w.startDate||!w.endDate)return{ok:false,err:'Set start and end dates first'};
    if(new Date(w.endDate)<=new Date(w.startDate))return{ok:false,err:'End date must be after start date'};
    if(!w.challenges||w.challenges.length===0)return{ok:false,err:'Add at least 1 challenge'};
    for(const ch of w.challenges){if(!ch.title.trim())return{ok:false,err:`Challenge "${ch.id}" needs a title`};if(!ch.target||ch.target<=0)return{ok:false,err:`Challenge "${ch.title||ch.id}" needs a target > 0`};}
    const hasAnyPrize=w.prizes.some((p:PrizeItem[])=>p&&p.length>0);
    if(!hasAnyPrize)return{ok:false,err:'Set prizes for at least 1st place'};
    return{ok:true,err:''};
  };
  const startC=()=>{const v=canStart();if(!v.ok){show('❌ '+v.err);return;}setW((x:any)=>({...x,status:'active'}));saveJ(LS_W,{...w,status:'active'});show('🟢 LIVE');};
  const pauseC=()=>{setW((x:any)=>({...x,status:'paused'}));saveJ(LS_W,{...w,status:'paused'});show('PAUSED');};
  // ─── STOP & DECLARE WINNERS ──────────────────────────────────────────────

  const prepareStop=async()=>{
    if(!connection){show('❌ No connection');return;}
    setStopLoading(true);
    try{
      const ctrl=new AbortController();
      const full=await fetchLeaderboard(connection,ctrl.signal,()=>{});
      const startTs=w.startDate?Math.floor(new Date(w.startDate).getTime()/1000):0;
      const endTs=w.endDate?Math.floor(new Date(w.endDate).getTime()/1000):Infinity;
      const weekEntries=full.map(e=>{
        const ev=(e.events||[]).filter(ev=>ev.blockTime>=startTs&&ev.blockTime<=endTs);
        if(!ev.length)return null;
        const burned=ev.reduce((s,x)=>s+x.amount,0);
        return{address:e.address,burned,txCount:ev.length,points:Math.floor(burned*1.888),events:ev} as BurnerEntry;
      }).filter((e):e is BurnerEntry=>e!==null&&e.points>0).sort((a,b)=>b.points-a.points);

      const top3=weekEntries.slice(0,3);
      const totalAmpVal=w.challenges.reduce((s:number,c:any)=>s+TIER_AMPS[c.tier],0);
      const winners:Winner[]=top3.map((e,i)=>({
        address:e.address,
        place:i, // 0=1st, 1=2nd, 2=3rd
        weeklyPts:Math.floor(e.points*(1+totalAmpVal/100)),
        weeklyBurned:e.burned,
        ampPct:totalAmpVal,
        prizes:w.prizes[i]||[],
      } as Winner));
      setStopConfirm({entries:weekEntries,winners});
    }catch(err:any){
      show('❌ Failed to fetch leaderboard: '+(err?.message||''));
    }
    setStopLoading(false);
  };

  const confirmStop=async()=>{
    try{
      if(!stopConfirm)return;
      const log:ChallengeLog={weekId:w.weekId,startDate:w.startDate,endDate:w.endDate,stoppedAt:new Date().toISOString(),challenges:w.challenges,winners:stopConfirm.winners,prizes:w.prizes,sendReceipts:w.sendReceipts};
      const ul=[log,...logs];
      saveJ(LS_L,ul);
      setLogs(ul);
      try{const sb=await import('../lib/supabase');await sb.addChallengeLog(log);sb.invalidateChallengeLogsCache();}catch{}
      // Keep same weekId — don't auto-advance until prizes are sent
      const ended={...w,status:'ended',winners:stopConfirm.winners};
      saveJ(LS_W,{...ended,sectionConfirmed:sectionOk});
      setW(ended);
      setStopConfirm(null);
      show('🏆 Challenge ended — Winners declared! Go to SEND tab to send prizes.');
      setTab('winners');
    }catch(err:any){
      show('❌ Error: '+(err?.message||'Unknown'));
      setStopConfirm(null);
    }
  };

  const cancelStop=()=>setStopConfirm(null);

  // Legacy simple stop (no winners) — data stays intact, just status → ended
  const stopW=async()=>{if(!window.confirm(`⏹ Stop ${w.weekId} without declaring winners?\n\nThis will end the challenge and archive it. No winners will be picked.`))return;if(!window.confirm('⚠️ Are you sure you want to proceed? This action cannot be undone.'))return;const log:ChallengeLog={weekId:w.weekId,startDate:w.startDate,endDate:w.endDate,stoppedAt:new Date().toISOString(),challenges:w.challenges,winners:w.winners,prizes:w.prizes,sendReceipts:w.sendReceipts};const ul=[log,...logs];setLogs(ul);saveJ(LS_L,ul);
    try{const sb=await import('../lib/supabase');await sb.addChallengeLog(log);sb.invalidateChallengeLogsCache();}catch{}
    const ended={...w,status:'ended'};saveJ(LS_W,{...ended,sectionConfirmed:sectionOk});setW(ended);show('⏹ Stopped & logged — Go to SEND tab');setTab('send');};
  const resetW=()=>{if(w.status==='active'||w.status==='paused'){show('⚠️ Stop the challenge before resetting');return;}if(!window.confirm(`🔄 Reset ${w.weekId}?\n\nThis will clear all challenges, dates, and prizes.`))return;if(!window.confirm('⚠️ Are you sure you want to proceed? This action cannot be undone.'))return;const r={weekId:w.weekId,startDate:'',endDate:'',challenges:[],prizes:ep,status:'upcoming'} as WConfig;setW(r);saveJ(LS_W,r);setSectionOk({week:false,challenges:false,prizes:false});show('🔄 Reset complete');};
  const addCh=()=>{if(w.challenges.length>=4)return;setW((x:any)=>({...x,challenges:[...x.challenges,{id:'ch-'+Date.now(),title:'',description:'',tier:1,type:'burn_amount',target:100,icon:'🔥'}]}));};
  const uCh=(id:string,u:any)=>setW((x:any)=>({...x,challenges:x.challenges.map((c:any)=>c.id===id?{...c,...u}:c)}));
  const rCh=(id:string)=>setW((x:any)=>({...x,challenges:x.challenges.filter((c:any)=>c.id!==id)}));
  const uPz=(p:number,items:PrizeItem[])=>setW((x:any)=>{const pz=[...x.prizes];pz[p]=items;return{...x,prizes:pz};});

  const addAnn=async()=>{if(!newA.title.trim())return;const entry={id:'a-'+Date.now(),date:new Date().toISOString(),...newA};const u=[entry,...anns];setAnns(u);saveJ(LS_A,u);setNewA({title:'',message:'',type:'info'});
    try{const sb=await import('../lib/supabase');await sb.addAnnouncement(newA);sb.invalidateAnnouncementsCache();}catch{}
    show('Published');};
  const rAnn=async(id:string)=>{const u=anns.filter((a:any)=>a.id!==id);setAnns(u);saveJ(LS_A,u);
    try{const sb=await import('../lib/supabase');await sb.deleteAnnouncement(id);sb.invalidateAnnouncementsCache();}catch{}};
  const clearLogs=()=>{setLogs([]);saveJ(LS_L,[]);show('All logs deleted');};
  const totalAmp=w.challenges.reduce((s:number,c:any)=>s+TIER_AMPS[c.tier],0);
  const timeUp=w.status==='active'&&w.endDate&&new Date(w.endDate).getTime()<=Date.now();
  const isEnded=w.status==='ended'||w.status==='upcoming';
  const isActive=w.status==='active';
  const isPaused=w.status==='paused';
  const isLocked=isActive; // When active, everything is locked — must pause to edit

  const tabs=[{k:'weekly',l:'⚡ WEEK',c:'#39ff88'},{k:'prizes',l:'🏆 PRIZES',c:'#ffd700'},{k:'winners',l:'🏅 WINNERS',c:'#ff9933'},{k:'control',l:'🎮 CONTROL',c:'#ff4466'},{k:'send',l:'💸 SEND',c:'#ff9933'},{k:'labwork',l:'🧪 LAB WORK',c:'#00ccff'},{k:'announce',l:'📢 NEWS',c:'#ffcc55'},{k:'logs',l:'📜 LOGS',c:'#cc88ff'},{k:'database',l:'🗄️ DATABASE',c:'#bf5af2'}];

  return(
    <div style={{minHeight:'100vh',background:'#080c10',padding:isMobile?'70px 10px 40px':'90px 24px 40px',position:'relative',overflow:'hidden'}}>
      <TopBar /><PageBackground />
      <div style={{maxWidth:920,margin:'0 auto'}}>
        <div style={{textAlign:'center',marginBottom:24,animation:'adm-fade 0.4s ease both'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:8}}><span style={{fontSize:22}}>🔐</span><span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#ff4466',letterSpacing:3,fontWeight:700}}>ADMIN</span></div>
          <h1 style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?18:24,fontWeight:900,color:'#fff',letterSpacing:3,margin:'4px 0'}}>CHALLENGE MANAGER</h1>
          <button onClick={()=>navigate('/rewards')} style={{marginTop:6,padding:'5px 14px',background:'rgba(255,215,0,.06)',border:'1px solid rgba(255,215,0,.2)',borderRadius:6,color:'#ffd700',fontFamily:'Orbitron,monospace',fontSize:8,letterSpacing:2,cursor:'pointer'}}>👁 PUBLIC PAGE</button>
        </div>
        {saved&&<div style={{position:'fixed',top:80,left:'50%',transform:'translateX(-50%)',zIndex:9999,padding:'10px 24px',background:'rgba(57,255,136,.12)',border:'1px solid rgba(57,255,136,.35)',borderRadius:10,fontFamily:'Orbitron,monospace',fontSize:10,color:'#39ff88',letterSpacing:2,animation:'adm-fade 0.3s ease both'}}>✓ {saved}</div>}

        {/* Pending LB submissions alert */}
        {lwPendingCount>0&&tab!=='labwork'&&(
          <div onClick={()=>setTab('labwork')} style={{cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 16px',marginBottom:12,background:'rgba(0,204,255,.06)',border:'1px solid rgba(0,204,255,.2)',borderRadius:10,animation:'adm-pulse 2s ease infinite'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontSize:16}}>🧪</span>
              <div>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:'#00ccff',letterSpacing:2}}>{lwPendingCount} PENDING LAB WORK SUBMISSION{lwPendingCount>1?'S':''}</div>
                <div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#5588aa'}}>Community members submitted contributions for review. Tap to review.</div>
              </div>
            </div>
            <span style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:900,color:'#00ccff',background:'rgba(0,204,255,.12)',width:28,height:28,borderRadius:14,display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 0 12px rgba(0,204,255,.4)'}}>{lwPendingCount}</span>
          </div>
        )}
        <div style={{display:'flex',gap:5,marginBottom:20,flexWrap:'wrap',justifyContent:'center'}}>{tabs.map(t=><button key={t.k} onClick={()=>setTab(t.k)} style={{position:'relative',padding:'7px 12px',borderRadius:8,background:tab===t.k?t.c+'12':'rgba(255,255,255,.015)',border:`1px solid ${tab===t.k?t.c+'40':'rgba(255,255,255,.04)'}`,color:tab===t.k?t.c:'#556677',fontFamily:'Orbitron,monospace',fontSize:8,fontWeight:700,letterSpacing:2,cursor:'pointer'}}>
          {t.l}
          {t.k==='weekly'&&isActive&&<span style={{position:'absolute',top:-3,right:-3,width:8,height:8,borderRadius:'50%',background:'#39ff88',boxShadow:'0 0 8px #39ff88',animation:'adm-pulse 2s ease infinite'}}/>}
          {t.k==='weekly'&&isPaused&&<span style={{position:'absolute',top:-3,right:-3,width:8,height:8,borderRadius:'50%',background:'#ffcc55',boxShadow:'0 0 8px #ffcc55',animation:'adm-pulse 2s ease infinite'}}/>}
          {t.k==='labwork'&&lwPendingCount>0&&<span style={{position:'absolute',top:-6,right:-6,minWidth:16,height:16,borderRadius:8,background:'#ff4466',color:'#fff',fontFamily:'Orbitron,monospace',fontSize:8,fontWeight:900,display:'flex',alignItems:'center',justifyContent:'center',padding:'0 4px',boxShadow:'0 0 8px rgba(255,68,102,.6)',animation:'adm-pulse 1.5s ease infinite'}}>{lwPendingCount}</span>}
        </button>)}</div>
        {wLd&&<div style={{textAlign:'center',padding:'8px',marginBottom:12,background:'rgba(140,60,255,.06)',border:'1px solid rgba(140,60,255,.12)',borderRadius:8,fontFamily:'Orbitron,monospace',fontSize:9,color:'#cc88ff'}}>⏳ Loading wallet tokens & NFTs...</div>}

        {/* WEEKLY — 3 PROGRESSIVE SECTIONS WITH CONFIRMATIONS */}
        {tab==='weekly'&&(<>
          {/* LIVE LOCK BANNER */}
          {isActive&&<div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 18px',background:'linear-gradient(135deg,rgba(57,255,136,.06),rgba(255,68,102,.04))',border:'1px solid rgba(57,255,136,.3)',borderLeft:'4px solid #39ff88',borderRadius:12,marginBottom:16}}>
            <div style={{width:12,height:12,borderRadius:'50%',background:'#39ff88',boxShadow:'0 0 12px #39ff88',animation:'adm-pulse 2s ease infinite',flexShrink:0}}/>
            <div style={{flex:1}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:900,color:'#39ff88',letterSpacing:2}}>🔒 CHALLENGE IS LIVE — ALL SECTIONS LOCKED</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#8899aa',marginTop:3,lineHeight:1.5}}>
                <span style={{color:'#ff9933',fontWeight:600}}>{w.weekId}</span> is currently active. To make changes, go to <span style={{color:'#ffcc55',fontWeight:600}}>CONTROL</span> tab and <span style={{color:'#ffcc55',fontWeight:600}}>PAUSE</span> the challenge first.
              </div>
            </div>
          </div>}
          {isPaused&&<div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 18px',background:'linear-gradient(135deg,rgba(255,204,85,.06),rgba(255,140,0,.04))',border:'1px solid rgba(255,204,85,.3)',borderLeft:'4px solid #ffcc55',borderRadius:12,marginBottom:16}}>
            <div style={{width:12,height:12,borderRadius:'50%',background:'#ffcc55',boxShadow:'0 0 12px #ffcc55',animation:'adm-pulse 2s ease infinite',flexShrink:0}}/>
            <div style={{flex:1}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:900,color:'#ffcc55',letterSpacing:2}}>⏸ CHALLENGE PAUSED — EDITING ENABLED</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#8899aa',marginTop:3,lineHeight:1.5}}>
                You can now edit sections. Re-confirm each section when done, then go to <span style={{color:'#39ff88',fontWeight:600}}>CONTROL</span> to resume.
              </div>
            </div>
          </div>}
          {/* ── SECTION PROGRESS BAR ── */}
          <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:16,padding:'10px 16px',background:'rgba(0,0,0,.15)',borderRadius:10,border:'1px solid rgba(140,60,255,.1)'}}>
            {(['week','challenges','prizes'] as const).map((s,i)=>{
              const labels=['📅 WEEK','⚡ CHALLENGES','🏆 PRIZES'];
              const ok=sectionOk[s];
              return(<React.Fragment key={s}>
                {i>0&&<div style={{flex:1,height:2,background:sectionOk[(['week','challenges','prizes'] as const)[i-1]]?'rgba(57,255,136,.4)':'rgba(140,60,255,.1)',borderRadius:1,transition:'background .3s'}}/>}
                <div style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',background:ok?'rgba(57,255,136,.08)':'rgba(140,60,255,.04)',border:`1px solid ${ok?'rgba(57,255,136,.25)':'rgba(140,60,255,.1)'}`,borderRadius:6}}>
                  <div style={{width:8,height:8,borderRadius:'50%',background:ok?'#39ff88':'rgba(140,60,255,.3)',boxShadow:ok?'0 0 8px #39ff88':'none',transition:'all .3s'}}/>
                  <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:ok?'#39ff88':'#8899aa',letterSpacing:1}}>{labels[i]}</span>
                  {ok&&<span style={{fontSize:8}}>✓</span>}
                </div>
              </React.Fragment>);
            })}
          </div>

          {/* ═══ SECTION 1: WEEK CONFIGURATION ═══ */}
          <div style={{...pan(sectionOk.week?'rgba(57,255,136,.15)':'rgba(120,60,255,.15)'),opacity:1}}>
            <GridBg /><div style={{position:'relative',zIndex:1}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
              <Tl i="📅" t="WEEK CONFIGURATION" c={sectionOk.week?'#39ff88':'#cc88ff'} />
              {sectionOk.week&&<div style={{display:'flex',alignItems:'center',gap:6,padding:'5px 12px',background:isLocked?'rgba(255,68,102,.06)':'rgba(57,255,136,.08)',border:`1px solid ${isLocked?'rgba(255,68,102,.2)':'rgba(57,255,136,.25)'}`,borderRadius:8}}>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:isLocked?'#ff4466':'#39ff88',letterSpacing:2}}>{isLocked?'🔒 LOCKED (LIVE)':'✓ CONFIRMED'}</span>
                {!isLocked&&<button onClick={()=>unlockSection('week')} style={{background:'none',border:'none',color:'#ff9933',fontFamily:'Orbitron,monospace',fontSize:7,cursor:'pointer',textDecoration:'underline'}}>EDIT</button>}
              </div>}
            </div>
            {(sectionOk.week||isLocked)?(
              <div style={{padding:'12px 16px',background:isLocked?'rgba(57,255,136,.02)':'rgba(57,255,136,.03)',borderRadius:10,border:`1px solid ${isLocked?'rgba(57,255,136,.05)':'rgba(57,255,136,.08)'}`}}>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:12}}>
                  <div><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#8899aa'}}>WEEK ID</span><div style={{fontFamily:'Orbitron,monospace',fontSize:12,color:'#fff',marginTop:2}}>{w.weekId}</div></div>
                  <div><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#8899aa'}}>STATUS</span><div style={{display:'flex',alignItems:'center',gap:6,marginTop:2}}><div style={{width:8,height:8,borderRadius:'50%',background:isActive?'#39ff88':isPaused?'#ffcc55':'#cc88ff',boxShadow:`0 0 6px ${isActive?'#39ff88':isPaused?'#ffcc55':'#cc88ff'}`}}/><span style={{fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:900,color:isActive?'#39ff88':isPaused?'#ffcc55':'#cc88ff'}}>{w.status.toUpperCase()}</span></div></div>
                  <div><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#8899aa'}}>START</span><div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#39ff88',marginTop:2}}>{w.startDate?new Date(w.startDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'}</div></div>
                  <div><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#8899aa'}}>END</span><div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#ff9933',marginTop:2}}>{w.endDate?new Date(w.endDate).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'}</div></div>
                </div>
              </div>
            ):(<>
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr 1fr',gap:14}}>
                <div><label style={L}>WEEK ID</label><input style={I} value={w.weekId} onChange={e=>setW((x:any)=>({...x,weekId:e.target.value}))} placeholder="week-001" /></div>
                <div><label style={L}>STATUS</label><select style={Sel} value={w.status} onChange={e=>setW((x:any)=>({...x,status:e.target.value}))}><option value="upcoming">Upcoming (not started)</option><option value="active">Active (live)</option><option value="paused">Paused (frozen)</option><option value="ended">Ended</option></select></div>
                <div style={{display:'flex',alignItems:'center',gap:8}}><div style={{width:10,height:10,borderRadius:'50%',background:w.status==='active'?'#39ff88':w.status==='paused'?'#ffcc55':'#cc88ff',boxShadow:`0 0 8px ${w.status==='active'?'#39ff88':w.status==='paused'?'#ffcc55':'#cc88ff'}`,animation:'adm-pulse 2s ease infinite'}}/><span style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:900,color:w.status==='active'?'#39ff88':w.status==='paused'?'#ffcc55':'#cc88ff'}}>{w.status.toUpperCase()}</span></div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:14,marginTop:14}}>
                <DateP label="CHALLENGE START DATE" value={w.startDate} color="#39ff88" onChange={v=>setW((x:any)=>({...x,startDate:v}))} />
                <DateP label="CHALLENGE END DATE" value={w.endDate} color="#ff9933" onChange={v=>setW((x:any)=>({...x,endDate:v}))} />
              </div>
              <div style={{display:'flex',gap:10,marginTop:14}}>
                <button onClick={()=>{sv();}} style={Btn}>💾 SAVE</button>
                <button onClick={()=>{
                  if(!w.weekId.trim()){show('❌ Set a Week ID');return;}
                  if(!w.startDate||!w.endDate){show('❌ Set both start and end dates');return;}
                  if(new Date(w.endDate)<=new Date(w.startDate)){show('❌ End date must be after start');return;}
                  sv();confirmSection('week');
                }} style={{...Btn,background:'linear-gradient(135deg,rgba(57,255,136,.15),rgba(57,255,136,.08))',border:'1px solid rgba(57,255,136,.35)',color:'#39ff88'}}>✓ CONFIRM WEEK CONFIG</button>
              </div>
            </>)}
          </div></div>

          {/* ═══ SECTION 2: CHALLENGES ═══ */}
          <div style={{...pan(sectionOk.challenges?'rgba(57,255,136,.15)':'rgba(120,60,255,.15)'),opacity:sectionOk.week?1:0.5,pointerEvents:sectionOk.week?'auto':'none'}}>
            <GridBg /><div style={{position:'relative',zIndex:1}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
              <Tl i="⚡" t={`CHALLENGES (${w.challenges.length}/4)`} c={sectionOk.challenges?'#39ff88':'#ff9933'} />
              <div style={{display:'flex',gap:8}}>
                {sectionOk.challenges&&<div style={{display:'flex',alignItems:'center',gap:6,padding:'5px 12px',background:isLocked?'rgba(255,68,102,.06)':'rgba(57,255,136,.08)',border:`1px solid ${isLocked?'rgba(255,68,102,.2)':'rgba(57,255,136,.25)'}`,borderRadius:8}}>
                  <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:isLocked?'#ff4466':'#39ff88',letterSpacing:2}}>{isLocked?'🔒 LOCKED (LIVE)':'✓ CONFIRMED'}</span>
                  {!isLocked&&<button onClick={()=>unlockSection('challenges')} style={{background:'none',border:'none',color:'#ff9933',fontFamily:'Orbitron,monospace',fontSize:7,cursor:'pointer',textDecoration:'underline'}}>EDIT</button>}
                </div>}
                {!sectionOk.challenges&&w.challenges.length<4&&<button onClick={addCh} style={Btn}>+ ADD CHALLENGE</button>}
              </div>
            </div>
            {!sectionOk.week&&<div style={{textAlign:'center',padding:20,color:'#556677',fontFamily:'Sora,sans-serif',fontSize:12}}>⬆ Confirm Week Configuration first</div>}
            {sectionOk.week&&(sectionOk.challenges||isLocked)?(
              <div style={{padding:'12px 16px',background:'rgba(57,255,136,.03)',borderRadius:10,border:'1px solid rgba(57,255,136,.08)'}}>
                {w.challenges.map((ch:any,i:number)=>{const tc=TIER_C[ch.tier as 1|2|3|4];return(
                  <div key={ch.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',marginBottom:4,background:`${tc.c}06`,borderLeft:`3px solid ${tc.c}`,borderRadius:6}}>
                    <span style={{fontSize:14}}>{ch.icon}</span>
                    <div style={{flex:1}}><div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#fff'}}>{ch.title||'Untitled'}</div><div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#8899aa'}}>{tc.l} · +{TIER_AMPS[ch.tier].toFixed(2)}%</div></div>
                    <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:tc.c}}>TARGET: {ch.target}</span>
                  </div>);})}
                <div style={{marginTop:8,fontFamily:'Orbitron,monospace',fontSize:9,color:'#ff9933'}}>TOTAL MAX AMPLIFIER: +{totalAmp.toFixed(2)}%</div>
              </div>
            ):sectionOk.week&&(<>
              {w.challenges.length===0&&<div style={{textAlign:'center',padding:20,color:'#556677',fontFamily:'Sora,sans-serif',fontSize:12}}>No challenges created yet. Add up to 4 challenges for this week.</div>}
              {w.challenges.map((ch:any,i:number)=>{const tc=TIER_C[ch.tier as 1|2|3|4];return(
                <div key={ch.id} style={{background:'rgba(0,0,0,.15)',border:`1px solid ${tc.bd}`,borderLeft:`4px solid ${tc.c}`,borderRadius:10,padding:14,marginBottom:10}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}><span style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#fff'}}>CHALLENGE {i+1} <span style={{color:tc.c,fontSize:9}}>({tc.l})</span></span><button onClick={()=>rCh(ch.id)} style={{...BtnD,padding:'3px 8px',fontSize:8}}>DELETE</button></div>
                  <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:10}}>
                    <div><label style={L}>CHALLENGE NAME</label><input style={I} value={ch.title} onChange={e=>uCh(ch.id,{title:e.target.value})} placeholder='e.g. "FIRST FLAME"' /></div>
                    <div><label style={L}>EMOJI ICON</label><input style={I} value={ch.icon} onChange={e=>uCh(ch.id,{icon:e.target.value})} placeholder="🔥" /></div>
                    <div style={{gridColumn:isMobile?undefined:'1/-1'}}><label style={L}>WHAT DO USERS NEED TO DO?</label><textarea style={{...I,minHeight:50,resize:'vertical'}} value={ch.description} onChange={e=>uCh(ch.id,{description:e.target.value})} placeholder='Describe the challenge in plain English...' /></div>
                    <div><label style={L}>DIFFICULTY TIER</label><select style={Sel} value={ch.tier} onChange={e=>uCh(ch.id,{tier:Number(e.target.value)})}>{[1,2,3,4].map(t=><option key={t} value={t}>{TIER_C[t].l}</option>)}</select></div>
                    <div><label style={L}>HOW IS IT MEASURED?</label><select style={Sel} value={ch.type} onChange={e=>uCh(ch.id,{type:e.target.value})}>
                      <option value="burn_amount">Total burned (burn at least X BRAINS)</option>
                      <option value="burn_txcount">Number of burns (do X separate burns)</option>
                      <option value="burn_exact">Exact amount (burn exactly X in one tx)</option>
                      <option value="burn_streak">Daily streak (burn on X different days)</option>
                    </select></div>
                    <div><label style={L}>{ch.type==='burn_amount'?'BRAINS TO BURN (minimum total)':ch.type==='burn_txcount'?'NUMBER OF BURN TRANSACTIONS':ch.type==='burn_exact'?'EXACT BRAINS AMOUNT (per tx)':ch.type==='burn_streak'?'NUMBER OF DAYS':'TARGET VALUE'}</label><input style={I} type="number" value={ch.target} onChange={e=>uCh(ch.id,{target:Number(e.target.value)})} placeholder={ch.type==='burn_amount'?'e.g. 5000':ch.type==='burn_txcount'?'e.g. 10':'e.g. 100'} /></div>
                    <div style={{gridColumn:isMobile?undefined:'1/-1',padding:'6px 12px',background:'rgba(140,60,255,.04)',border:'1px solid rgba(140,60,255,.1)',borderRadius:6}}>
                      <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#cc88ff'}}>🎯 CHALLENGE PREVIEW: </span>
                      <span style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#99aabb'}}>
                        {ch.type==='burn_amount'?`Burn at least ${fmtN(ch.target,0)} BRAINS tokens total`:
                         ch.type==='burn_txcount'?`Complete ${ch.target} separate burn transactions`:
                         ch.type==='burn_exact'?`Burn exactly ${fmtN(ch.target,0)} BRAINS in a single transaction`:
                         ch.type==='burn_streak'?`Burn BRAINS on ${ch.target} different days this week`:
                         `Target: ${ch.target}`}
                      </span>
                      <span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:tc.c,marginLeft:8}}>→ +{TIER_AMPS[ch.tier].toFixed(2)}% amplifier</span>
                    </div>
                  </div>
                </div>);})}
              {w.challenges.length>0&&<div style={{padding:'8px 12px',background:'rgba(140,60,255,.04)',borderRadius:8,marginBottom:10}}><span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#cc88ff'}}>TOTAL MAX AMPLIFIER: </span><span style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:900,color:'#ff9933'}}>+{totalAmp.toFixed(2)}%</span></div>}
              <div style={{display:'flex',gap:10}}>
                <button onClick={sv} style={Btn}>💾 SAVE</button>
                <button onClick={()=>{
                  if(w.challenges.length===0){show('❌ Add at least 1 challenge');return;}
                  for(const ch of w.challenges){if(!ch.title.trim()){show('❌ Challenge needs a title');return;}if(!ch.target||ch.target<=0){show('❌ Challenge needs a target > 0');return;}}
                  sv();confirmSection('challenges');
                }} style={{...Btn,background:'linear-gradient(135deg,rgba(57,255,136,.15),rgba(57,255,136,.08))',border:'1px solid rgba(57,255,136,.35)',color:'#39ff88'}}>✓ CONFIRM CHALLENGES</button>
              </div>
            </>)}
          </div></div>

          {/* ═══ SECTION 3: PRIZES ═══ */}
          <div style={{...pan(sectionOk.prizes?'rgba(57,255,136,.15)':'rgba(255,215,0,.12)'),opacity:(sectionOk.week&&sectionOk.challenges)?1:0.5,pointerEvents:(sectionOk.week&&sectionOk.challenges)?'auto':'none'}}>
            <GridBg /><div style={{position:'relative',zIndex:1}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
              <Tl i="🏆" t="PRIZES" c={sectionOk.prizes?'#39ff88':'#ffd700'} />
              {sectionOk.prizes&&<div style={{display:'flex',alignItems:'center',gap:6,padding:'5px 12px',background:isLocked?'rgba(255,68,102,.06)':'rgba(57,255,136,.08)',border:`1px solid ${isLocked?'rgba(255,68,102,.2)':'rgba(57,255,136,.25)'}`,borderRadius:8}}>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:isLocked?'#ff4466':'#39ff88',letterSpacing:2}}>{isLocked?'🔒 LOCKED (LIVE)':'✓ CONFIRMED'}</span>
                {!isLocked&&<button onClick={()=>unlockSection('prizes')} style={{background:'none',border:'none',color:'#ff9933',fontFamily:'Orbitron,monospace',fontSize:7,cursor:'pointer',textDecoration:'underline'}}>EDIT</button>}
              </div>}
            </div>
            {!(sectionOk.week&&sectionOk.challenges)&&<div style={{textAlign:'center',padding:20,color:'#556677',fontFamily:'Sora,sans-serif',fontSize:12}}>⬆ Confirm Week & Challenges first</div>}
            {sectionOk.week&&sectionOk.challenges&&(sectionOk.prizes||isLocked)?(
              <div style={{padding:'12px 16px',background:'rgba(57,255,136,.03)',borderRadius:10,border:'1px solid rgba(57,255,136,.08)'}}>
                {[0,1,2].map(p=>{const cl=['#ffd700','#cc88ff','#39ff88'][p];const items=w.prizes[p]||[];return(
                  <div key={p} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',marginBottom:4,borderLeft:`3px solid ${cl}`,background:`${cl}06`,borderRadius:6}}>
                    <span style={{fontSize:14}}>{['🥇','🥈','🥉'][p]}</span>
                    <div style={{flex:1,display:'flex',gap:6,flexWrap:'wrap'}}>
                      {items.length===0?<span style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#556677'}}>No prizes set</span>:
                      items.map((pr:PrizeItem,k:number)=>pr.isNFT?
                        <span key={k} style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#ffd700',padding:'2px 6px',background:'rgba(255,215,0,.06)',borderRadius:4}}>🖼️ NFT</span>:
                        <span key={k} style={{fontFamily:'Orbitron,monospace',fontSize:9,color:TK[pr.token]?.c||'#fff',padding:'2px 6px',background:`${TK[pr.token]?.c||'#fff'}08`,borderRadius:4}}>{fmtN(pr.amount,0)} {pr.token}</span>
                      )}
                    </div>
                  </div>);})}
              </div>
            ):(sectionOk.week&&sectionOk.challenges)&&(<>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#8899aa',marginBottom:16}}>Configure what each winner receives. You can add multiple tokens and NFTs per place.</div>
              {isPaused&&<div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 14px',background:'rgba(255,204,85,.04)',border:'1px solid rgba(255,204,85,.15)',borderRadius:8,marginBottom:12}}>
                <span style={{fontSize:12}}>⏸️</span>
                <span style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#ffcc55'}}>Challenge is paused — you can edit prizes. Re-confirm when done and resume from CONTROL tab.</span>
              </div>}
              <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:14,padding:'10px 14px',background:'rgba(140,60,255,.03)',border:'1px solid rgba(140,60,255,.08)',borderRadius:10}}>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#cc88ff',letterSpacing:2}}>YOUR WALLET:</span>
                <span style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#8899aa'}}>{wTks.length} tokens · {wNfts.length} NFTs · {fmtN(xntBal,2)} XNT</span>
              </div>
              {[0,1,2].map(p=>{const cl=['#ffd700','#cc88ff','#39ff88'][p];return(<div key={p} style={{background:`${cl}06`,border:`1px solid ${cl}20`,borderRadius:10,padding:14,marginBottom:10}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,color:cl,letterSpacing:2,marginBottom:8}}>{['🥇 1ST PLACE PRIZES','🥈 2ND PLACE PRIZES','🥉 3RD PLACE PRIZES'][p]}</div>
                <PrizeEd items={w.prizes[p]||[]} onChange={items=>uPz(p,items)} wTks={wTks} wNfts={wNfts} xntBal={xntBal} />
              </div>);})}
              <div style={{display:'flex',gap:10}}>
                <button onClick={sv} style={Btn}>💾 SAVE</button>
                <button onClick={()=>{
                  const hasAny=w.prizes.some((p:PrizeItem[])=>p&&p.length>0);
                  if(!hasAny){show('❌ Set prizes for at least 1st place');return;}
                  sv();confirmSection('prizes');
                }} style={{...Btn,background:'linear-gradient(135deg,rgba(57,255,136,.15),rgba(57,255,136,.08))',border:'1px solid rgba(57,255,136,.35)',color:'#39ff88'}}>✓ CONFIRM PRIZES</button>
              </div>
            </>)}
          </div></div>

          {/* ═══ FINALIZE & LAUNCH ═══ */}
          {!isActive&&!isPaused&&<div style={{...pan(allConfirmed?'rgba(57,255,136,.2)':'rgba(100,100,100,.08)'),opacity:allConfirmed?1:0.4,pointerEvents:allConfirmed?'auto':'none'}}>
            <GridBg /><div style={{position:'relative',zIndex:1,textAlign:'center',padding:'10px 0'}}>
            <div style={{fontSize:28,marginBottom:8}}>🚀</div>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:16,fontWeight:900,color:allConfirmed?'#39ff88':'#556677',letterSpacing:3,marginBottom:8}}>
              {allConfirmed?'ALL SECTIONS CONFIRMED':'COMPLETE ALL SECTIONS ABOVE'}
            </div>
            <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#8899aa',marginBottom:16,maxWidth:500,margin:'0 auto 16px'}}>
              {allConfirmed?`Ready to launch ${w.weekId}. This will save all configuration and the challenge can be started from the Control tab.`:'Fill and confirm all 3 sections: Week Configuration, Challenges, and Prizes.'}
            </div>
            {allConfirmed&&<>
              {/* Summary */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:16,textAlign:'left',padding:'12px 16px',background:'rgba(0,0,0,.15)',borderRadius:10}}>
                <div><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88',letterSpacing:2}}>WEEK</span><div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#fff',marginTop:2}}>{w.weekId}</div></div>
                <div><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#ff9933',letterSpacing:2}}>CHALLENGES</span><div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#fff',marginTop:2}}>{w.challenges.length} challenges</div></div>
                <div><span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#ffd700',letterSpacing:2}}>AMP BONUS</span><div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#fff',marginTop:2}}>+{totalAmp.toFixed(2)}%</div></div>
              </div>
              <button onClick={()=>{
                const data={...w,sectionConfirmed:sectionOk};saveJ(LS_W,data);
                show('✅ Week configuration finalized and saved!');
              }} style={{padding:'14px 30px',background:'linear-gradient(135deg,rgba(57,255,136,.2),rgba(140,60,255,.1))',border:'2px solid rgba(57,255,136,.4)',borderRadius:12,color:'#39ff88',fontFamily:'Orbitron,monospace',fontSize:13,fontWeight:900,letterSpacing:3,cursor:'pointer',boxShadow:'0 0 20px rgba(57,255,136,.1)'}}>
                🚀 FINALIZE & SAVE WEEK
              </button>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#556677',marginTop:10}}>Then go to the Control tab to START the challenge when ready.</div>
            </>}
          </div></div>}
        </>)}

        {/* PRIZES — now part of Week tab */}
        {tab==='prizes'&&<div style={pan('rgba(255,215,0,.12)')}><GridBg /><div style={{position:'relative',zIndex:1}}>
          <Tl i="🏆" t="PRIZE CONFIGURATION" c="#ffd700" />
          <div style={{textAlign:'center',padding:'30px 20px'}}>
            <div style={{fontSize:32,marginBottom:8}}>📋</div>
            <div style={{fontFamily:'Sora,sans-serif',fontSize:12,color:'#8899aa',marginBottom:16}}>
              Prize configuration is now part of the <b style={{color:'#39ff88'}}>WEEK</b> tab as Section 3.<br/>
              Complete all 3 sections (Week → Challenges → Prizes) and confirm each one.
            </div>
            <button onClick={()=>setTab('weekly')} style={{...Btn,color:'#39ff88',background:'linear-gradient(135deg,rgba(57,255,136,.1),rgba(140,60,255,.06))',border:'1px solid rgba(57,255,136,.3)'}}>⚡ GO TO WEEK TAB</button>
          </div>
        </div></div>}

        {/* WINNERS */}
        {tab==='winners'&&<div style={pan('rgba(255,215,0,.12)')}><GridBg /><div style={{position:'relative',zIndex:1}}><Tl i="🏅" t="WINNERS" c="#ffd700" /><WinnersTab w={w} logs={logs} isMobile={isMobile} connection={connection} onDeleteLog={(idx)=>{const u=[...logs];u.splice(idx,1);setLogs(u);saveJ(LS_L,u);show('Log entry deleted');}}/></div></div>}

        {/* CONTROL */}
        {tab==='control'&&<div style={pan('rgba(255,0,68,.1)')}><GridBg /><div style={{position:'relative',zIndex:1}}>
          <Tl i="🎮" t="CHALLENGE CONTROL" c="#ff4466" />

          {/* PAUSE-TO-EDIT INFO */}
          {isActive&&!timeUp&&<div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 16px',background:'rgba(57,255,136,.03)',border:'1px solid rgba(57,255,136,.12)',borderRadius:10,marginBottom:12}}>
            <span style={{fontSize:14}}>ℹ️</span>
            <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#8899aa',lineHeight:1.5}}>
              Week/Challenge/Prize configuration is <span style={{color:'#39ff88',fontWeight:600}}>locked while live</span>. To make edits, <span style={{color:'#ffcc55',fontWeight:600}}>PAUSE</span> the challenge first, make your changes in the <span style={{color:'#39ff88',fontWeight:600}}>WEEK</span> tab, then <span style={{color:'#39ff88',fontWeight:600}}>RESUME</span>.
            </div>
          </div>}

          {/* TIME UP ALERT */}
          {timeUp&&(
            <div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 18px',background:'linear-gradient(135deg,rgba(255,68,102,.1),rgba(255,140,0,.06))',border:'1px solid rgba(255,68,102,.4)',borderLeft:'4px solid #ff4466',borderRadius:10,marginBottom:16,animation:'adm-pulse 3s ease infinite'}}>
              <span style={{fontSize:24}}>⚠️</span>
              <div style={{flex:1}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:12,color:'#ff4466',fontWeight:900,letterSpacing:2}}>WEEK CHALLENGE HAS ENDED</div>
                <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#aabbcc',marginTop:3,lineHeight:1.5}}>The timer for <span style={{color:'#ff9933',fontWeight:700}}>{w.weekId}</span> has expired. Click <span style={{color:'#ffd700',fontWeight:700}}>🏆 STOP & DECLARE WINNERS</span> to finalize results, or <span style={{color:'#ff4466',fontWeight:700}}>⏹️ STOP ONLY</span> to archive without winners.</div>
              </div>
            </div>
          )}

          <div style={{display:'flex',alignItems:'center',gap:10,padding:'14px 16px',background:'rgba(0,0,0,.2)',borderRadius:10,marginBottom:16}}>
            <div style={{width:10,height:10,borderRadius:'50%',background:timeUp?'#ff4466':w.status==='active'?'#39ff88':w.status==='paused'?'#ffcc55':'#cc88ff',animation:'adm-pulse 2s ease infinite'}}/>
            <span style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:900,color:timeUp?'#ff4466':w.status==='active'?'#39ff88':w.status==='paused'?'#ffcc55':'#cc88ff'}}>{timeUp?'ENDED (TIME UP)':w.status.toUpperCase()}</span>
            {timeUp&&<span style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#8a9aaa',marginLeft:4}}>— ended {new Date(w.endDate).toLocaleString()}</span>}
          </div>
          <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr 1fr':'1fr 1fr 1fr 1fr 1fr',gap:10}}>
            <button onClick={startC} disabled={w.status==='active'} style={{padding:14,borderRadius:10,cursor:w.status==='active'?'not-allowed':'pointer',background:'rgba(57,255,136,.06)',border:'1px solid rgba(57,255,136,.25)',opacity:w.status==='active'?0.4:1,textAlign:'center' as const}}><div style={{fontSize:22}}>▶️</div><div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#39ff88',fontWeight:700}}>{w.status==='paused'?'RESUME':'START'}</div></button>
            <button onClick={pauseC} disabled={w.status!=='active'} style={{padding:14,borderRadius:10,cursor:w.status!=='active'?'not-allowed':'pointer',background:'rgba(255,204,85,.06)',border:'1px solid rgba(255,204,85,.25)',opacity:w.status!=='active'?0.4:1,textAlign:'center' as const}}><div style={{fontSize:22}}>⏸️</div><div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#ffcc55',fontWeight:700}}>PAUSE</div><div style={{fontFamily:'Sora,sans-serif',fontSize:7,color:'#667788',marginTop:2}}>Freeze to edit</div></button>
            <button onClick={prepareStop} disabled={stopLoading||w.status==='upcoming'||w.status==='ended'} style={{padding:14,borderRadius:10,cursor:(stopLoading||w.status==='upcoming'||w.status==='ended')?'not-allowed':'pointer',background:'linear-gradient(135deg,rgba(255,215,0,.08),rgba(255,0,68,.06))',border:'1px solid rgba(255,215,0,.35)',opacity:(w.status==='upcoming'||w.status==='ended')?0.4:1,textAlign:'center' as const,position:'relative',overflow:'hidden'}}>
              {stopLoading&&<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,.6)',borderRadius:10,zIndex:2}}><div style={{width:18,height:18,border:'2px solid rgba(255,215,0,.2)',borderTop:'2px solid #ffd700',borderRadius:'50%',animation:'adm-pulse .7s linear infinite'}}/></div>}
              <div style={{fontSize:22}}>🏆</div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#ffd700',fontWeight:700}}>STOP & DECLARE</div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#ffd700',fontWeight:700}}>WINNERS</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:7,color:'#667788',marginTop:2}}>End + pick top 3</div>
            </button>
            <button onClick={stopW} disabled={w.status==='upcoming'||w.status==='ended'} style={{padding:14,borderRadius:10,cursor:(w.status==='upcoming'||w.status==='ended')?'not-allowed':'pointer',background:'rgba(255,0,68,.06)',border:'1px solid rgba(255,0,68,.25)',opacity:(w.status==='upcoming'||w.status==='ended')?0.4:1,textAlign:'center' as const}}><div style={{fontSize:22}}>⏹️</div><div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#ff4466',fontWeight:700}}>STOP ONLY</div><div style={{fontFamily:'Sora,sans-serif',fontSize:7,color:'#667788',marginTop:2}}>Archive, no winners</div></button>
            <button onClick={resetW} disabled={w.status==='active'||w.status==='paused'} style={{padding:14,borderRadius:10,cursor:(w.status==='active'||w.status==='paused')?'not-allowed':'pointer',background:'rgba(255,140,0,.04)',border:'1px solid rgba(255,140,0,.2)',opacity:(w.status==='active'||w.status==='paused')?0.4:1,textAlign:'center' as const}}><div style={{fontSize:22}}>🔄</div><div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#ff9933',fontWeight:700}}>RESET</div><div style={{fontFamily:'Sora,sans-serif',fontSize:7,color:'#667788',marginTop:2}}>{(w.status==='active'||w.status==='paused')?'Stop first':'Clear everything'}</div></button>
          </div>

          {/* ── SCANNING ANIMATION ── */}
          {stopLoading&&!stopConfirm&&(
            <div style={{marginTop:16,padding:'30px 20px',background:'linear-gradient(160deg,#0a0414,#0c0820)',border:'1px solid rgba(255,215,0,.2)',borderRadius:14,position:'relative',overflow:'hidden',textAlign:'center'}}>
              <div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(rgba(255,215,0,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,215,0,.02) 1px,transparent 1px)',backgroundSize:'24px 24px',pointerEvents:'none'}}/>
              <div style={{position:'absolute',top:0,left:0,width:'38%',height:'100%',background:'linear-gradient(90deg,transparent,rgba(255,215,0,.04),transparent)',animation:'rw-scan 3s linear infinite',pointerEvents:'none'}}/>
              <div style={{position:'relative',zIndex:1}}>
                <div style={{display:'flex',justifyContent:'center',marginBottom:16}}>
                  <div style={{position:'relative',width:80,height:80}}>
                    <div style={{position:'absolute',inset:0,borderRadius:'50%',border:'3px solid transparent',borderTopColor:'#ffd700',borderRightColor:'rgba(255,215,0,.3)',animation:'adm-spin 1s linear infinite'}}/>
                    <div style={{position:'absolute',inset:6,borderRadius:'50%',border:'2px solid transparent',borderBottomColor:'#cc88ff',borderLeftColor:'rgba(140,60,255,.3)',animation:'adm-spin 1.5s linear infinite reverse'}}/>
                    <div style={{position:'absolute',inset:14,borderRadius:'50%',border:'2px solid transparent',borderTopColor:'#39ff88',animation:'adm-spin 2s linear infinite'}}/>
                    <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      <span style={{fontSize:24,animation:'adm-pulse 1.5s ease infinite'}}>🔍</span>
                    </div>
                  </div>
                </div>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:900,color:'#ffd700',letterSpacing:3,marginBottom:8,animation:'adm-pulse 2s ease infinite'}}>SCANNING CHAIN DATA</div>
                <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#8899aa',marginBottom:12}}>Analyzing all burn transactions within the challenge window…</div>
                <div style={{display:'flex',justifyContent:'center',gap:4}}>
                  {[0,1,2,3,4].map(i=>(
                    <div key={i} style={{width:8,height:8,borderRadius:'50%',background:'#ffd700',opacity:0.3,animation:`adm-pulse 1.2s ease ${i*0.2}s infinite`}}/>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── STOP CONFIRMATION MODAL ── */}
          {stopConfirm&&(
            <div style={{marginTop:16,padding:isMobile?'16px 12px':'20px 20px',background:'linear-gradient(160deg,#0a0414,#0c0820)',border:'2px solid rgba(255,215,0,.35)',borderRadius:14,position:'relative',overflow:'hidden'}}>
              <div style={{position:'absolute',inset:0,backgroundImage:'linear-gradient(rgba(255,215,0,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,215,0,.02) 1px,transparent 1px)',backgroundSize:'24px 24px',pointerEvents:'none'}}/>
              <div style={{position:'relative',zIndex:1}}>
                <div style={{textAlign:'center',marginBottom:16}}>
                  <div style={{fontSize:32,marginBottom:6}}>🏆</div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:900,color:'#ffd700',letterSpacing:3,marginBottom:4}}>DECLARE WINNERS?</div>
                  <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#8899aa'}}>This will end <b style={{color:'#fff'}}>{w.weekId}</b>, declare the top 3 burners as winners, and archive the challenge.</div>
                </div>

                {/* Top 3 preview */}
                <div style={{display:'flex',gap:isMobile?8:12,marginBottom:16,alignItems:'flex-end'}}>
                  {[stopConfirm.winners.find(w=>w.place===1),stopConfirm.winners.find(w=>w.place===0),stopConfirm.winners.find(w=>w.place===2)].filter(Boolean).map((wn:any)=>{
                    const rank=wn.place+1;
                    const cl=wn.place===0?'#ffd700':wn.place===1?'#cc88ff':'#39ff88';
                    const medal=['👑','🥈','🥉'][wn.place];
                    const plabel=['1ST','2ND','3RD'][wn.place];
                    const isTop=wn.place===0;
                    const imgSize=isMobile?(isTop?80:60):(isTop?100:80);
                    return(
                      <div key={wn.place} style={{flex:1,padding:isMobile?'12px 8px':'16px 14px',background:`${cl}08`,border:`1px solid ${cl}33`,borderTop:`3px solid ${cl}`,borderRadius:12,textAlign:'center',minHeight:isTop?(isMobile?220:260):(isMobile?190:230),display:'flex',flexDirection:'column',alignItems:'center'}}>
                        <div style={{fontSize:isTop?28:20,marginBottom:4,filter:`drop-shadow(0 0 8px ${cl}88)`}}>{medal}</div>
                        <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?8:10,fontWeight:700,color:cl,letterSpacing:3,marginBottom:8}}>{plabel}</div>
                        {/* Profile image */}
                        <div style={{position:'relative',marginBottom:8}}>
                          <div style={{position:'absolute',inset:-3,borderRadius:'50%',border:`2px solid ${cl}44`,boxShadow:`0 0 16px ${cl}33`,pointerEvents:'none'}}/>
                          <div style={{width:imgSize,height:imgSize,borderRadius:'50%',overflow:'hidden',border:`3px solid ${cl}`,background:'#0a0a14'}}>
                            <img src={PODIUM_IMAGES[rank]?.src} alt="" style={{width:'100%',height:'100%',objectFit:'cover',objectPosition:'center top',transform:`scale(${PODIUM_IMAGES[rank]?.scale||1})`}}
                              onError={e=>{(e.target as HTMLImageElement).style.display='none';}}/>
                          </div>
                        </div>
                        <div style={{fontFamily:'monospace',fontSize:isMobile?9:11,color:cl,marginBottom:4}}>{short(wn.address)}</div>
                        <button onClick={()=>{navigator.clipboard.writeText(wn.address)}} style={{marginBottom:6,background:`${cl}10`,border:`1px solid ${cl}30`,color:cl,padding:'3px 10px',fontFamily:'Orbitron,monospace',fontSize:7,borderRadius:4,cursor:'pointer',letterSpacing:1}}>📋 COPY ADDRESS</button>
                        <div style={{width:'100%',marginTop:'auto',display:'flex',flexDirection:'column',gap:4}}>
                          <div style={{display:'flex',justifyContent:'space-between',padding:'4px 8px',background:'rgba(255,140,0,.06)',borderRadius:5}}>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#ff9933'}}>🔥 BURNED</span>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:'#ff9933'}}>{fmtN(wn.weeklyBurned||0,1)}</span>
                          </div>
                          <div style={{display:'flex',justifyContent:'space-between',padding:'4px 8px',background:'rgba(140,60,255,.04)',borderRadius:5}}>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#cc88ff'}}>BEFORE AMP</span>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#cc88ff'}}>{fmtPts(Math.floor((wn.weeklyBurned||0)*1.888))} pts</span>
                          </div>
                          <div style={{display:'flex',justifyContent:'space-between',padding:'4px 8px',background:`${cl}0a`,borderRadius:5}}>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:cl}}>◆ AFTER AMP</span>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:900,color:cl}}>{fmtPts(wn.weeklyPts)}</span>
                          </div>
                          {wn.ampPct>0&&<div style={{display:'flex',justifyContent:'space-between',padding:'3px 8px',background:'rgba(57,255,136,.04)',borderRadius:5}}>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88'}}>⚡ AMP</span>
                            <span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#39ff88'}}>+{wn.ampPct.toFixed(2)}%</span>
                          </div>}
                          {(wn.prizes||[]).length>0&&<div style={{display:'flex',gap:3,flexWrap:'wrap',justifyContent:'center',marginTop:2}}>
                            {wn.prizes.map((p:PrizeItem,j:number)=>(
                              <span key={j} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:p.isNFT?'#ffd700':TK[p.token]?.c||'#fff',padding:'1px 5px',background:'rgba(255,255,255,.04)',borderRadius:3}}>
                                {p.isNFT?`🖼️ ${p.nftName||'NFT'}`:`${fmtN(p.amount,0)} ${p.token}`}
                              </span>
                            ))}
                          </div>}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Full leaderboard preview */}
                {stopConfirm.entries.length>3&&(
                  <div style={{marginBottom:14,padding:'10px 12px',background:'rgba(140,60,255,.03)',border:'1px solid rgba(140,60,255,.08)',borderRadius:8}}>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:2,marginBottom:6}}>ALL {stopConfirm.entries.length} PARTICIPANTS</div>
                    {stopConfirm.entries.slice(3,10).map((e,i)=>(
                      <div key={e.address} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'4px 8px',borderBottom:'1px solid rgba(140,60,255,.04)'}}>
                        <span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#99aacc',width:24}}>{i+4}</span>
                        <span style={{fontFamily:'monospace',fontSize:10,color:'#aabbcc',flex:1}}>{short(e.address)}</span>
                        <span style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#ff9933'}}>🔥 {fmtN(e.burned,1)}</span>
                        <span style={{fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:'#39ff88',marginLeft:12}}>{fmtPts(e.points)}</span>
                      </div>
                    ))}
                    {stopConfirm.entries.length>10&&<div style={{textAlign:'center',fontFamily:'Orbitron,monospace',fontSize:8,color:'#556677',marginTop:4}}>+{stopConfirm.entries.length-10} more…</div>}
                  </div>
                )}

                {/* Summary */}
                <div style={{display:'flex',gap:isMobile?6:10,marginBottom:16,flexWrap:'wrap'}}>
                  <div style={{flex:1,padding:'10px 12px',background:'rgba(57,255,136,.04)',border:'1px solid rgba(57,255,136,.1)',borderRadius:8,textAlign:'center'}}>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:2}}>PARTICIPANTS</div>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:18,fontWeight:900,color:'#39ff88'}}>{stopConfirm.entries.length}</div>
                  </div>
                  <div style={{flex:1,padding:'10px 12px',background:'rgba(255,140,0,.04)',border:'1px solid rgba(255,140,0,.1)',borderRadius:8,textAlign:'center'}}>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:2}}>TOTAL BURNED</div>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:900,color:'#ff9933'}}>{fmtN(stopConfirm.entries.reduce((s,e)=>s+e.burned,0),0)}</div>
                  </div>
                  <div style={{flex:1,padding:'10px 12px',background:'rgba(140,60,255,.04)',border:'1px solid rgba(140,60,255,.1)',borderRadius:8,textAlign:'center'}}>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:2}}>CHALLENGE</div>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:900,color:'#cc88ff'}}>{w.weekId}</div>
                  </div>
                </div>

                {/* Action buttons */}
                <div style={{display:'flex',gap:12,justifyContent:'center'}}>
                  <button onClick={cancelStop} style={{padding:'12px 28px',borderRadius:10,background:'rgba(255,255,255,.04)',border:'1px solid rgba(255,255,255,.12)',color:'#8899aa',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,letterSpacing:2,cursor:'pointer'}}>✕ CANCEL</button>
                  <button onClick={confirmStop} style={{padding:'12px 28px',borderRadius:10,background:'linear-gradient(135deg,rgba(255,215,0,.15),rgba(255,140,0,.1))',border:'2px solid rgba(255,215,0,.5)',color:'#ffd700',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:900,letterSpacing:2,cursor:'pointer',boxShadow:'0 0 20px rgba(255,215,0,.15)'}}>🏆 CONFIRM & END CHALLENGE</button>
                </div>

                <div style={{textAlign:'center',marginTop:10,fontFamily:'Sora,sans-serif',fontSize:9,color:'#556677'}}>
                  This action is permanent. Winners will be archived and a new week will be created automatically.
                </div>
              </div>
            </div>
          )}
          {(()=>{const v=canStart();return !v.ok&&w.status!=='active'?<div style={{marginTop:12,padding:'10px 14px',background:'rgba(255,0,68,.04)',border:'1px solid rgba(255,0,68,.15)',borderRadius:8}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#ff4466',letterSpacing:2,marginBottom:4}}>⚠️ CANNOT START — MISSING:</div>
            <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#ff8899'}}>{v.err}</div>
          </div>:null;})()}
        </div></div>}

        {/* SEND — only after challenge ended */}
        {tab==='send'&&<div style={pan('rgba(255,140,0,.1)')}><GridBg /><div style={{position:'relative',zIndex:1}}>
          <Tl i="💸" t="SEND PRIZES TO WINNERS" c="#ff9933" />
          {w.status==='active'||w.status==='paused'?(
            <div style={{textAlign:'center',padding:'30px 20px'}}>
              <div style={{fontSize:32,marginBottom:8}}>🔒</div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:'#ff9933',letterSpacing:2}}>CHALLENGE STILL ACTIVE</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#667788',marginTop:6}}>Stop the current challenge first before sending prizes.</div>
            </div>
          ):(<>
            {(()=>{
              // Gather winners from current week OR latest log
              const srcWinners=w.winners||logs[0]?.winners||[];
              const srcWeek=w.weekId||logs[0]?.weekId||'—';
              const srcReceipts=w.sendReceipts||logs[0]?.sendReceipts||[];
              const allPaidSrc=srcWinners.length>0&&srcWinners.every((_:any,i:number)=>srcReceipts.some((r:SendReceipt)=>r.place===i));
              if(!srcWinners||srcWinners.length===0)return null;
              return(
                <div style={{marginBottom:16,padding:'14px 16px',background:'rgba(255,215,0,.04)',border:'1px solid rgba(255,215,0,.12)',borderRadius:10}}>
                  {/* Header with collapse toggle and overall paid status */}
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:showSendWinners?10:0}}>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#ffd700',letterSpacing:2}}>🏆 LATEST WINNERS — {srcWeek}</span>
                      {allPaidSrc?
                        <span style={{padding:'3px 8px',background:'rgba(57,255,136,.08)',border:'1px solid rgba(57,255,136,.25)',borderRadius:4,fontFamily:'Orbitron,monospace',fontSize:7,color:'#39ff88'}}>✅ ALL PAID</span>:
                        <span style={{padding:'3px 8px',background:'rgba(255,140,0,.08)',border:'1px solid rgba(255,140,0,.25)',borderRadius:4,fontFamily:'Orbitron,monospace',fontSize:7,color:'#ff9933'}}>⏳ PAYMENT PENDING</span>
                      }
                    </div>
                    <button onClick={()=>setShowSendWinners(!showSendWinners)} style={{background:'rgba(255,215,0,.06)',border:'1px solid rgba(255,215,0,.15)',borderRadius:6,color:'#ffd700',fontFamily:'Orbitron,monospace',fontSize:7,padding:'4px 10px',cursor:'pointer',letterSpacing:1}}>
                      {showSendWinners?'▲ COLLAPSE':'▼ EXPAND'}
                    </button>
                  </div>
                  {showSendWinners&&<>
                    {[...srcWinners].sort((a:any,b:any)=>a.place-b.place).map((wn:any,i:number)=>{
                      const cl=wn.place===0?'#ffd700':wn.place===1?'#cc88ff':'#39ff88';
                      const placeLabel=['1ST','2ND','3RD'][wn.place];
                      const paid=srcReceipts.some((r:SendReceipt)=>r.place===wn.place);
                      const receipt=srcReceipts.find((r:SendReceipt)=>r.place===wn.place);
                      return(
                        <div key={i} style={{display:'flex',alignItems:'center',gap:8,padding:'10px 12px',marginBottom:4,background:`${cl}08`,border:`1px solid ${cl}18`,borderLeft:`3px solid ${cl}`,borderRadius:8,flexWrap:'wrap'}}>
                          <span style={{fontSize:16}}>{['🥇','🥈','🥉'][wn.place]}</span>
                          <div style={{flex:1,minWidth:100}}>
                            <div style={{fontFamily:'monospace',fontSize:12,color:'#e0e8f0',fontWeight:700}}>{short(wn.address)}</div>
                            <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#8899aa',marginTop:2}}>{placeLabel} · {fmtPts(wn.weeklyPts||0)} pts · 🔥 {fmtN(wn.weeklyBurned||0,1)} burned</div>
                          </div>
                          {/* PAID/UNPAID badge */}
                          {paid?
                            <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:2}}>
                              <span style={{padding:'3px 8px',background:'rgba(57,255,136,.1)',border:'1px solid rgba(57,255,136,.25)',borderRadius:4,fontFamily:'Orbitron,monospace',fontSize:8,color:'#39ff88',fontWeight:700}}>✅ PAID</span>
                              {receipt&&<span style={{fontFamily:'Sora,sans-serif',fontSize:7,color:'#667788'}}>{new Date(receipt.timestamp).toLocaleDateString()}</span>}
                              {receipt?.txSig&&<a href={`https://explorer.mainnet.x1.xyz/tx/${receipt.txSig}`} target="_blank" rel="noopener noreferrer" style={{fontFamily:'Orbitron,monospace',fontSize:6,color:'#aa77ff',textDecoration:'none'}}>TX ↗</a>}
                            </div>:
                            <span style={{padding:'3px 8px',background:'rgba(255,140,0,.1)',border:'1px solid rgba(255,140,0,.25)',borderRadius:4,fontFamily:'Orbitron,monospace',fontSize:8,color:'#ff9933',fontWeight:700}}>⏳ UNPAID</span>
                          }
                          <button onClick={()=>{navigator.clipboard.writeText(wn.address);show('📋 Copied!')}} style={{background:`${cl}10`,border:`1px solid ${cl}30`,color:cl,padding:'4px 10px',fontFamily:'Orbitron,monospace',fontSize:7,borderRadius:4,cursor:'pointer'}}>📋 COPY</button>
                          {!paid&&<button onClick={()=>{const f=[...sendForms];f[wn.place]={...f[wn.place],wallet:wn.address};setSendForms(f);show(`✅ Auto-filled ${placeLabel}`)}} style={{background:'rgba(57,255,136,.08)',border:'1px solid rgba(57,255,136,.2)',color:'#39ff88',padding:'4px 10px',fontFamily:'Orbitron,monospace',fontSize:7,borderRadius:4,cursor:'pointer'}}>⬇ FILL</button>}
                        </div>);
                    })}
                    {!allPaidSrc&&<button onClick={()=>{const ws=[...srcWinners].sort((a:any,b:any)=>a.place-b.place);const f=sendForms.map((sf,i)=>ws[i]?{...sf,wallet:ws[i].address}:sf);setSendForms(f);show('✅ All winners auto-filled!')}} style={{marginTop:8,padding:'6px 16px',background:'rgba(57,255,136,.06)',border:'1px solid rgba(57,255,136,.2)',color:'#39ff88',fontFamily:'Orbitron,monospace',fontSize:8,borderRadius:6,cursor:'pointer',letterSpacing:2}}>⬇ AUTO-FILL ALL WINNERS</button>}
                  </>}
                </div>
              );
            })()}
            {[0,1,2].map(i=>{const cl=['#ffd700','#cc88ff','#39ff88'][i];return(
              <div key={i} style={{background:`${cl}04`,border:`1px solid ${cl}15`,borderRadius:10,padding:14,marginBottom:12}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:cl,letterSpacing:2,marginBottom:10}}>{['🥇 1ST PLACE WINNER','🥈 2ND PLACE WINNER','🥉 3RD PLACE WINNER'][i]}</div>
                <label style={L}>RECIPIENT WALLET ADDRESS</label>
                <input style={I} value={sendForms[i].wallet} onChange={e=>{const f=[...sendForms];f[i]={...f[i],wallet:e.target.value};setSendForms(f);}} placeholder="Paste the winner's wallet address..." />
                <div style={{marginTop:8}}><label style={L}>WHAT TO SEND (click tokens from wallet)</label><PrizeEd items={sendForms[i].items} onChange={items=>{const f=[...sendForms];f[i]={...f[i],items};setSendForms(f);}} wTks={wTks} wNfts={wNfts} xntBal={xntBal} /></div>
              </div>);})}
            <button onClick={sendAllPrizes} disabled={sending} style={{...Btn,background:sending?'rgba(100,100,100,.15)':'linear-gradient(135deg,rgba(255,140,0,.2),rgba(255,85,0,.1))',border:`1px solid ${sending?'rgba(100,100,100,.2)':'rgba(255,140,0,.4)'}`,color:sending?'#667788':'#ff9933',fontSize:12,padding:'12px 24px',cursor:sending?'not-allowed':'pointer'}}>{sending?'⏳ SENDING...':'🚀 SEND ALL PRIZES'}</button>
            {sendLog.length>0&&<div style={{marginTop:12,padding:'12px 14px',background:'rgba(0,0,0,.2)',border:'1px solid rgba(140,60,255,.1)',borderRadius:10,maxHeight:300,overflowY:'auto'}}>
              {sendLog.map((l,i)=>{
                // Extract TX hash and make it a link
                const txMatch=l.match(/TX: ([A-Za-z0-9]{20,})\.\.\./)||l.match(/\(([A-Za-z0-9]{16,})\.\.\.\)/);
                const sigMatch=l.match(/→ ([A-Za-z0-9]{8,})\.\.\./);
                return <div key={i} style={{fontFamily:'monospace',fontSize:11,color:l.startsWith('✅')?'#39ff88':l.startsWith('❌')?'#ff4466':l.startsWith('⚠️')?'#ffcc55':'#cc88ff',marginBottom:4}}>
                  {l}
                  {(txMatch||sigMatch)&&<a href={`https://explorer.mainnet.x1.xyz/tx/${txMatch?txMatch[1]:sigMatch![1]}`} target="_blank" rel="noopener noreferrer" style={{marginLeft:8,color:'#aa77ff',fontSize:9,fontFamily:'Orbitron,monospace',textDecoration:'none',padding:'1px 6px',background:'rgba(140,60,255,.08)',border:'1px solid rgba(140,60,255,.2)',borderRadius:4}}>↗ VIEW TX</a>}
                </div>;
              })}
            </div>}

            {/* ── START NEW WEEK CHALLENGE ── */}
            {(sendLog.some(l=>l.includes('Done!'))||((w.sendReceipts||[]).length>0))&&(
              <div style={{marginTop:24,padding:'20px',background:'linear-gradient(160deg,rgba(57,255,136,.04),rgba(140,60,255,.03))',border:'2px solid rgba(57,255,136,.2)',borderRadius:14,textAlign:'center'}}>
                <div style={{fontSize:32,marginBottom:8}}>🔄</div>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:14,fontWeight:900,color:'#39ff88',letterSpacing:3,marginBottom:6}}>START NEW WEEK CHALLENGE</div>
                <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#8899aa',marginBottom:16}}>
                  Prizes have been sent. You can now set up the next week's challenge.<br/>
                  The current week's data is saved in the Logs tab for history.
                </div>

                <div style={{textAlign:'left',marginBottom:16}}>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#ffd700',letterSpacing:2,marginBottom:8}}>🏆 PRE-SELECT PRIZES FOR NEXT WEEK (optional — you can change these later)</div>
                  <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
                    <button onClick={()=>{
                      // Carry over same prizes to next week
                      const n=parseInt(w.weekId.replace('week-',''))+1;
                      const r={weekId:'week-'+String(n).padStart(3,'0'),startDate:'',endDate:'',challenges:[],prizes:w.prizes,status:'upcoming',sendReceipts:[]} as any;
                      saveJ(LS_W,{...r,sectionConfirmed:{week:false,challenges:false,prizes:false}});
                      setW(r);setSectionOk({week:false,challenges:false,prizes:false});
                      setSendForms([{wallet:'',items:[]},{wallet:'',items:[]},{wallet:'',items:[]}]);
                      setSendLog([]);
                      setTab('weekly');
                      show('🔄 New week started — same prizes carried over');
                    }} style={{...Btn,background:'linear-gradient(135deg,rgba(255,215,0,.12),rgba(255,140,0,.08))',border:'1px solid rgba(255,215,0,.3)',color:'#ffd700'}}>
                      🏆 KEEP SAME PRIZES
                    </button>
                    <button onClick={()=>{
                      const n=parseInt(w.weekId.replace('week-',''))+1;
                      const r={weekId:'week-'+String(n).padStart(3,'0'),startDate:'',endDate:'',challenges:[],prizes:ep,status:'upcoming',sendReceipts:[]} as any;
                      saveJ(LS_W,{...r,sectionConfirmed:{week:false,challenges:false,prizes:false}});
                      setW(r);setSectionOk({week:false,challenges:false,prizes:false});
                      setSendForms([{wallet:'',items:[]},{wallet:'',items:[]},{wallet:'',items:[]}]);
                      setSendLog([]);
                      setTab('weekly');
                      show('🔄 New week started — default prizes');
                    }} style={{...Btn,background:'linear-gradient(135deg,rgba(57,255,136,.1),rgba(57,255,136,.06))',border:'1px solid rgba(57,255,136,.3)',color:'#39ff88'}}>
                      🔄 FRESH START (default prizes)
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>)}
        </div></div>}

        {/* ANNOUNCE */}
        {tab==='announce'&&<div style={pan('rgba(255,204,85,.1)')}><GridBg /><div style={{position:'relative',zIndex:1}}>
          <Tl i="📢" t="ANNOUNCEMENTS" c="#ffcc55" />
          <div style={{background:'rgba(0,0,0,.15)',borderRadius:10,padding:14,marginBottom:16}}>
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 120px',gap:10}}>
              <div><label style={L}>TITLE</label><input style={I} value={newA.title} onChange={e=>setNewA(a=>({...a,title:e.target.value}))} /></div>
              <div><label style={L}>TYPE</label><select style={Sel} value={newA.type} onChange={e=>setNewA(a=>({...a,type:e.target.value}))}><option value="info">Info</option><option value="reward">Reward</option><option value="challenge">Challenge</option><option value="milestone">Milestone</option></select></div>
              <div style={{gridColumn:isMobile?undefined:'1/-1'}}><label style={L}>MESSAGE</label><textarea style={{...I,minHeight:50,resize:'vertical'}} value={newA.message} onChange={e=>setNewA(a=>({...a,message:e.target.value}))} /></div>
            </div><button onClick={addAnn} style={{...Btn,marginTop:10}}>📤 PUBLISH</button>
          </div>
          {anns.map((a:any)=><div key={a.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 14px',background:'rgba(0,0,0,.1)',borderRadius:8,marginBottom:5}}><div><div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#fff'}}>{a.title}</div><div style={{fontSize:9,color:'#667788'}}>{a.type} · {new Date(a.date).toLocaleDateString()}</div></div><button onClick={()=>rAnn(a.id)} style={{...BtnD,padding:'3px 8px',fontSize:8}}>🗑</button></div>)}
        </div></div>}

        {/* LAB WORK — Manual LB Points rewards for social media / promo contributions */}
        {tab==='labwork'&&<div style={pan('rgba(0,204,255,.1)')}><GridBg /><div style={{position:'relative',zIndex:1}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
            <Tl i="🧪" t="LAB WORK REWARDS" c="#00ccff" />
            <div style={{display:'flex',gap:6,alignItems:'center'}}>
              {lwRewards.length>0&&<button onClick={clearAllLwRewards} style={{...BtnD,fontSize:8,padding:'6px 12px'}}>🗑 CLEAR ALL</button>}
            </div>
          </div>

          {/* ── PENDING SUBMISSIONS FROM PUBLIC PAGE (TOP PRIORITY) ── */}
          {(()=>{
            const subs:any[]=loadJ('brains_labwork_submissions',[]);
            const pending=subs.filter((s:any)=>s.status==='pending');
            if(pending.length===0&&subs.length===0) return null;
            const cats=[{k:'social',l:'📱 Social',c:'#00ccff'},{k:'content',l:'📝 Content',c:'#ff9933'},{k:'video',l:'🎬 Video',c:'#ff4466'},{k:'community',l:'🤝 Community',c:'#39ff88'},{k:'promo',l:'📣 Promo',c:'#cc88ff'},{k:'other',l:'⚡ Other',c:'#ffcc55'}];
            const approveSubmission=(id:string,pts:string)=>{
              const p=parseFloat(pts);if(!p||p<=0){show('⚠️ Enter LB Points to award');return;}
              const allSubs:any[]=loadJ('brains_labwork_submissions',[]);
              const sub=allSubs.find((s:any)=>s.id===id);
              if(!sub){show('⚠️ Submission not found');return;}
              if(!window.confirm(`✅ Approve & award ${fmtPts(p)} LB Points to ${short(sub.address)}?\n\nThis adds to their leaderboard score.`))return;
              if(!window.confirm('⚠️ Are you sure you want to proceed?'))return;
              sub.status='approved';
              saveJ('brains_labwork_submissions',allSubs);
              const entry={id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),address:sub.address,lbPoints:p,reason:`${cats.find(c=>c.k===sub.category)?.l||sub.category}: ${(sub.links?.join(', ')||sub.link||sub.description||'Lab Work')}`.slice(0,120),category:sub.category,date:new Date().toISOString()};
              const updated=[entry,...lwRewards];setLwRewards(updated);saveJ(LS_LW,updated);
              show(`✅ Approved! +${fmtPts(p)} LB Points → ${short(sub.address)}`);
            };
            const rejectSubmission=(id:string)=>{
              const allSubs:any[]=loadJ('brains_labwork_submissions',[]);
              const sub=allSubs.find((s:any)=>s.id===id);
              if(sub)sub.status='rejected';
              saveJ('brains_labwork_submissions',allSubs);
              show('Rejected');
            };
            const clearSubs=()=>{saveJ('brains_labwork_submissions',[]);show('All submissions cleared');};
            return(
              <div style={{marginBottom:20,padding:16,background:pending.length>0?'rgba(255,153,51,.04)':'rgba(0,0,0,.1)',border:`1px solid ${pending.length>0?'rgba(255,153,51,.2)':'rgba(0,204,255,.08)'}`,borderRadius:12}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                    {pending.length>0&&<span style={{display:'inline-flex',alignItems:'center',justifyContent:'center',minWidth:22,height:22,borderRadius:11,background:'#ff4466',color:'#fff',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:900,boxShadow:'0 0 10px rgba(255,68,102,.5)',animation:'adm-pulse 1.5s ease infinite'}}>{pending.length}</span>}
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:11,color:pending.length>0?'#ff9933':'#667788',letterSpacing:2,fontWeight:700}}>📥 COMMUNITY SUBMISSIONS ({pending.length} pending / {subs.length} total)</div>
                  </div>
                  {subs.length>0&&<button onClick={clearSubs} style={{...BtnD,fontSize:7,padding:'4px 10px'}}>🗑 CLEAR ALL</button>}
                </div>
                {pending.length===0?<div style={{textAlign:'center',padding:14,color:'#556677',fontFamily:'Sora,sans-serif',fontSize:11}}>No pending submissions. Users can submit from the public Rewards page.</div>:
                <div style={{maxHeight:500,overflowY:'auto',borderRadius:10,border:'1px solid rgba(255,153,51,.08)'}}>
                  {pending.map((s:any)=>{
                    const sc=cats.find(c=>c.k===s.category);
                    return(
                      <div key={s.id} style={{padding:'12px 14px',borderBottom:'1px solid rgba(255,255,255,.03)',background:'rgba(0,0,0,.1)'}}>
                        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6,flexWrap:'wrap'}}>
                          <span style={{fontFamily:'monospace',fontSize:10,color:'#ccd4dc'}}>{short(s.address)}</span>
                          <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:sc?.c||'#667788',padding:'2px 6px',background:(sc?.c||'#667788')+'12',border:`1px solid ${(sc?.c||'#667788')}30`,borderRadius:4}}>{sc?.l||s.category}</span>
                          <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#ffcc55',padding:'2px 6px',background:'rgba(255,204,85,.08)',border:'1px solid rgba(255,204,85,.2)',borderRadius:4}}>⏳ PENDING</span>
                          <span style={{fontFamily:'Sora,sans-serif',fontSize:8,color:'#556677'}}>{new Date(s.date).toLocaleDateString()}</span>
                        </div>
                        {(s.links?.length?s.links:s.link?[s.link]:[]).map((lnk:string,li:number)=>(
                          <div key={li} style={{marginBottom:2}}><a href={lnk} target="_blank" rel="noopener noreferrer" style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#00ccff',textDecoration:'none',wordBreak:'break-all'}}>🔗 {lnk}</a></div>
                        ))}
                        {s.description&&<div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#8899aa',marginBottom:6}}>{s.description}</div>}
                        <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
                          <input id={`lw-pts-${s.id}`} type="number" placeholder="LB Points" style={{width:100,padding:'6px 10px',background:'#06080e',border:'1px solid rgba(57,255,136,.2)',borderRadius:6,fontFamily:'Orbitron,monospace',fontSize:10,color:'#39ff88',outline:'none'}}/>
                          <button onClick={()=>{const el=document.getElementById(`lw-pts-${s.id}`) as HTMLInputElement;approveSubmission(s.id,el?.value||'');}} style={{...Btn,padding:'6px 14px',fontSize:8,background:'linear-gradient(135deg,rgba(57,255,136,.15),rgba(0,204,255,.08))',border:'1px solid rgba(57,255,136,.35)',color:'#39ff88'}}>✅ APPROVE & AWARD</button>
                          <button onClick={()=>rejectSubmission(s.id)} style={{...BtnD,padding:'6px 14px',fontSize:8}}>❌ REJECT</button>
                        </div>
                      </div>
                    );
                  })}
                </div>}
              </div>
            );
          })()}
          {/* Visibility toggle — controls submission LOG on public page (form is always visible) */}
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 14px',background:lwVisible?'rgba(57,255,136,.04)':'rgba(255,68,102,.04)',border:`1px solid ${lwVisible?'rgba(57,255,136,.15)':'rgba(255,68,102,.15)'}`,borderRadius:10,marginBottom:16,transition:'all .3s'}}>
            <div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:lwVisible?'#39ff88':'#ff4466',letterSpacing:2,fontWeight:700}}>{lwVisible?'👁 SUBMISSION LOG: VISIBLE':'🚫 SUBMISSION LOG: HIDDEN'}</div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#667788',marginTop:2}}>{lwVisible?'Users can see their submission history on the Rewards page. Form is always visible.':'Submission history is hidden from users. The submission form is still visible.'}</div>
            </div>
            <button onClick={toggleLwVisibility} style={{padding:'8px 16px',borderRadius:8,cursor:'pointer',fontFamily:'Orbitron,monospace',fontSize:8,fontWeight:700,letterSpacing:1,border:`1px solid ${lwVisible?'rgba(255,68,102,.3)':'rgba(57,255,136,.3)'}`,background:lwVisible?'rgba(255,68,102,.1)':'rgba(57,255,136,.1)',color:lwVisible?'#ff4466':'#39ff88',transition:'all .3s'}}>{lwVisible?'HIDE LOG':'SHOW LOG'}</button>
          </div>
          <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#8899aa',marginBottom:20,lineHeight:1.6}}>
            Award bonus <span style={{color:'#00ccff',fontWeight:700}}>Lab Work Points (LB Points)</span> to community members for social media promotion, content creation, raids, and other contributions. These points are added directly to their global leaderboard score.
          </div>

          {/* Stats bar */}
          <div style={{display:'grid',gridTemplateColumns:isMobile?'repeat(2,1fr)':'repeat(3,1fr)',gap:10,marginBottom:20}}>
            <div style={{background:'rgba(0,204,255,.04)',border:'1px solid rgba(0,204,255,.15)',borderRadius:10,padding:'12px 14px',textAlign:'center'}}>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:24,fontWeight:700,color:'#00ccff',textShadow:'0 0 12px rgba(0,204,255,.3)'}}>{fmtPts(lwTotalPts)}</div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:2}}>TOTAL LB PTS AWARDED</div>
            </div>
            <div style={{background:'rgba(57,255,136,.04)',border:'1px solid rgba(57,255,136,.15)',borderRadius:10,padding:'12px 14px',textAlign:'center'}}>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:24,fontWeight:700,color:'#39ff88',textShadow:'0 0 12px rgba(57,255,136,.3)'}}>{lwByWallet.size}</div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:2}}>UNIQUE WALLETS</div>
            </div>
            <div style={{background:'rgba(255,153,51,.04)',border:'1px solid rgba(255,153,51,.15)',borderRadius:10,padding:'12px 14px',textAlign:'center',gridColumn:isMobile?'1/-1':undefined}}>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:24,fontWeight:700,color:'#ff9933',textShadow:'0 0 12px rgba(255,153,51,.3)'}}>{lwRewards.length}</div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:2}}>TOTAL REWARDS</div>
            </div>
          </div>

          {/* Add reward form */}
          <div style={{background:'rgba(0,0,0,.2)',border:'1px solid rgba(0,204,255,.12)',borderRadius:12,padding:16,marginBottom:20}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#00ccff',letterSpacing:2,marginBottom:12}}>➕ AWARD LB POINTS</div>
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:10}}>
              <div><label style={L}>WALLET ADDRESS</label><input style={I} placeholder="Paste wallet address..." value={lwForm.address} onChange={e=>setLwForm(p=>({...p,address:e.target.value}))}/></div>
              <div><label style={L}>LB POINTS</label><input style={I} type="number" placeholder="e.g. 500" value={lwForm.lbPoints} onChange={e=>setLwForm(p=>({...p,lbPoints:e.target.value}))}/></div>
              <div><label style={L}>CATEGORY</label>
                <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                  {lwCategories.map(cat=>(
                    <button key={cat.k} onClick={()=>setLwForm(p=>({...p,category:cat.k}))} style={{padding:'5px 10px',borderRadius:6,background:lwForm.category===cat.k?cat.c+'18':'rgba(255,255,255,.02)',border:`1px solid ${lwForm.category===cat.k?cat.c+'50':'rgba(255,255,255,.06)'}`,color:lwForm.category===cat.k?cat.c:'#556677',fontFamily:'Orbitron,monospace',fontSize:7,letterSpacing:1,cursor:'pointer',transition:'all .2s'}}>{cat.l}</button>
                  ))}
                </div>
              </div>
              <div><label style={L}>REASON (OPTIONAL)</label><input style={I} placeholder="e.g. Twitter thread about BRAINS..." value={lwForm.reason} onChange={e=>setLwForm(p=>({...p,reason:e.target.value}))}/></div>
            </div>
            <button onClick={addLwReward} style={{...Btn,marginTop:12,background:'linear-gradient(135deg,rgba(0,204,255,.2),rgba(57,255,136,.1))',border:'1px solid rgba(0,204,255,.4)',color:'#00ccff'}}>🧪 AWARD LB POINTS</button>
          </div>

          {/* Leaderboard by wallet */}
          {lwWalletsSorted.length>0&&<>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#00ccff',letterSpacing:2,marginBottom:10}}>🏆 LB POINTS LEADERBOARD (MANUAL REWARDS)</div>
            <div style={{background:'rgba(0,0,0,.15)',border:'1px solid rgba(0,204,255,.08)',borderRadius:10,overflow:'hidden',marginBottom:20}}>
              <div style={{display:'grid',gridTemplateColumns:isMobile?'40px 1fr auto':'40px 1fr auto auto',gap:8,padding:'8px 12px',borderBottom:'1px solid rgba(0,204,255,.06)'}}>
                {(isMobile?['#','WALLET','LB PTS']:['#','WALLET','REWARDS','LB PTS']).map(h=><div key={h} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:2}}>{h}</div>)}
              </div>
              {lwWalletsSorted.slice(0,20).map(([addr,data],i)=>{
                const isTop3=i<3;const rc=['#ffd700','#c0c0c0','#cd7f32'][i]||'#667788';
                return(
                  <div key={addr} style={{display:'grid',gridTemplateColumns:isMobile?'40px 1fr auto':'40px 1fr auto auto',gap:8,padding:'8px 12px',borderBottom:'1px solid rgba(255,255,255,.02)',background:isTop3?`${rc}06`:'transparent'}}>
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,color:isTop3?rc:'#556677'}}>#{i+1}</div>
                    <div style={{fontFamily:'monospace',fontSize:10,color:'#ccd4dc',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{short(addr)}</div>
                    {!isMobile&&<div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#667788',textAlign:'right'}}>{data.count}×</div>}
                    <div style={{fontFamily:'Orbitron,monospace',fontSize:isMobile?11:12,fontWeight:700,color:isTop3?'#00ccff':'#39ff88',textAlign:'right'}}>{fmtPts(data.pts)}</div>
                  </div>
                );
              })}
            </div>
          </>}

          {/* Recent rewards log */}
          <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:'#8899aa',letterSpacing:2,marginBottom:10}}>📋 REWARD HISTORY ({lwRewards.length})</div>
          {lwRewards.length===0?<div style={{textAlign:'center',padding:30,color:'#556677',fontFamily:'Sora,sans-serif'}}>No Lab Work rewards yet. Award LB Points above.</div>:
          <div style={{maxHeight:400,overflowY:'auto',borderRadius:10,border:'1px solid rgba(0,204,255,.06)'}}>
            {lwRewards.map(r=>{
              const cat=lwCategories.find(c=>c.k===r.category);
              return(
                <div key={r.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',borderBottom:'1px solid rgba(255,255,255,.02)',background:'rgba(0,0,0,.1)'}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                      <span style={{fontFamily:'monospace',fontSize:10,color:'#ccd4dc'}}>{short(r.address)}</span>
                      <span style={{fontFamily:'Orbitron,monospace',fontSize:7,color:cat?.c||'#667788',padding:'2px 6px',background:(cat?.c||'#667788')+'12',border:`1px solid ${(cat?.c||'#667788')}30`,borderRadius:4}}>{cat?.l||r.category}</span>
                    </div>
                    <div style={{fontFamily:'Sora,sans-serif',fontSize:9,color:'#667788',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{r.reason} · {new Date(r.date).toLocaleDateString()}</div>
                  </div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:13,fontWeight:700,color:'#00ccff',flexShrink:0,textShadow:'0 0 8px rgba(0,204,255,.3)'}}>+{fmtPts(r.lbPoints)}</div>
                  <button onClick={()=>removeLwReward(r.id)} style={{...BtnD,padding:'4px 8px',fontSize:7,flexShrink:0}}>🗑</button>
                </div>
              );
            })}
          </div>}
        </div></div>}

        {/* LOGS */}
        {tab==='logs'&&<div style={pan('rgba(140,60,255,.1)')}><GridBg /><div style={{position:'relative',zIndex:1}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
            <Tl i="📜" t="CHALLENGE LOG" c="#cc88ff" />
            {logs.length>0&&<button onClick={clearLogs} style={{...BtnD,fontSize:8,padding:'6px 12px'}}>🗑 DELETE ALL LOGS</button>}
          </div>
          {logs.length===0?<div style={{textAlign:'center',padding:30,color:'#556677',fontFamily:'Sora,sans-serif'}}>No logged challenges yet. Challenges are logged when you stop them.</div>:
          logs.map((lg:ChallengeLog,i:number)=>(
            <div key={i} style={{background:'rgba(0,0,0,.15)',border:'1px solid rgba(120,60,255,.06)',borderRadius:10,padding:14,marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:12,fontWeight:700,color:'#fff',letterSpacing:2}}>{lg.weekId}</span>
                <span style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#ff4466',padding:'3px 8px',background:'rgba(255,0,68,.06)',border:'1px solid rgba(255,0,68,.15)',borderRadius:4}}>STOPPED</span>
              </div>
              <div style={{fontFamily:'Sora,sans-serif',fontSize:10,color:'#667788',marginBottom:6}}>
                Started: {lg.startDate?new Date(lg.startDate).toLocaleString():'N/A'}<br/>
                Stopped: {lg.stoppedAt?new Date(lg.stoppedAt).toLocaleString():'N/A'}
              </div>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#cc88ff',marginBottom:6}}>CHALLENGES ({(lg.challenges||[]).length})</div>
              <div style={{display:'flex',gap:5,flexWrap:'wrap',marginBottom:6}}>
                {(lg.challenges||[]).map((c:any,j:number)=>{const tc=TIER_C[c.tier as 1|2|3|4];return <span key={j} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:tc?.c,padding:'3px 8px',background:tc?.bg,border:`1px solid ${tc?.bd}`,borderRadius:4}}>{c.icon} {c.title||'Untitled'} ({tc?.l})</span>;})}
              </div>
              {lg.winners&&lg.winners.length>0&&<><div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#ffd700',marginBottom:4}}>WINNERS</div><div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {[...(lg.winners||[])].sort((a:any,b:any)=>a.place-b.place).map((wn:any,j:number)=>{const cl=wn.place===0?'#ffd700':wn.place===1?'#cc88ff':'#39ff88';return <span key={j} style={{fontFamily:'monospace',fontSize:9,color:cl}}>{['🥇','🥈','🥉'][wn.place]} {short(wn.address)}</span>;})}
              </div></>}
              <div style={{marginTop:6,fontFamily:'Orbitron,monospace',fontSize:8,color:'#667788'}}>PRIZES</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {[0,1,2].map(p=>{const items=lg.prizes?.[p]||[];if(!items.length)return null;return <div key={p} style={{display:'flex',alignItems:'center',gap:3}}><span style={{fontSize:10}}>{['🥇','🥈','🥉'][p]}</span>{items.map((pr:PrizeItem,k:number)=>pr.isNFT?<span key={k} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#ffd700'}}>NFT</span>:<span key={k} style={{fontFamily:'Orbitron,monospace',fontSize:7,color:TK[pr.token]?.c||'#fff'}}>{fmtN(pr.amount,0)} {pr.token}</span>)}</div>;})}
              </div>
            </div>))}
        </div></div>}

        {/* ── DATABASE TAB ── */}
        {tab==='database'&&<div style={pan('rgba(191,90,242,.1)')}><GridBg /><div style={{position:'relative',zIndex:1,padding:4}}>
          <Tl i="🗄️" t="SUPABASE DATABASE" c="#bf5af2" />

          {/* Connection Status */}
          <div style={{marginBottom:20,padding:'16px 18px',background:'rgba(0,0,0,.2)',border:'1px solid rgba(191,90,242,.15)',borderRadius:12}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#bf5af2',letterSpacing:2,marginBottom:12}}>📡 CONNECTION STATUS</div>
            <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 1fr',gap:10}}>
              <div style={{padding:'10px 14px',background:'rgba(57,255,136,.04)',border:'1px solid rgba(57,255,136,.12)',borderRadius:8}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#667788',marginBottom:4}}>SUPABASE URL</div>
                <div style={{fontFamily:'monospace',fontSize:10,color:import.meta.env.VITE_SUPABASE_URL?'#39ff88':'#ff4466',wordBreak:'break-all'}}>
                  {import.meta.env.VITE_SUPABASE_URL?'✅ Connected':'❌ Not configured'}
                </div>
              </div>
              <div style={{padding:'10px 14px',background:'rgba(57,255,136,.04)',border:'1px solid rgba(57,255,136,.12)',borderRadius:8}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:8,color:'#667788',marginBottom:4}}>SERVICE KEY</div>
                <div style={{fontFamily:'monospace',fontSize:10,color:import.meta.env.VITE_SUPABASE_SERVICE_KEY?'#39ff88':'#ff4466'}}>
                  {import.meta.env.VITE_SUPABASE_SERVICE_KEY?'✅ Admin write access':'❌ Read-only mode'}
                </div>
              </div>
            </div>
            <div style={{marginTop:10,padding:'10px 14px',background:sbReady?'rgba(57,255,136,.04)':'rgba(255,200,0,.04)',border:`1px solid ${sbReady?'rgba(57,255,136,.12)':'rgba(255,200,0,.12)'}`,borderRadius:8}}>
              <div style={{fontFamily:'Orbitron,monospace',fontSize:10,color:sbReady?'#39ff88':'#ffcc55'}}>
                {sbReady?'✅ Supabase data loaded successfully':'⏳ Loading from Supabase...'}
              </div>
            </div>
          </div>

          {/* Current Data Counts */}
          <div style={{marginBottom:20,padding:'16px 18px',background:'rgba(0,0,0,.2)',border:'1px solid rgba(191,90,242,.15)',borderRadius:12}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#bf5af2',letterSpacing:2,marginBottom:12}}>📊 CURRENT DATA (IN MEMORY)</div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[
                {l:'LAB WORK REWARDS',v:lwRewards.length,c:'#00ccff'},
                {l:'CHALLENGE LOGS',v:logs.length,c:'#cc88ff'},
                {l:'ANNOUNCEMENTS',v:anns.length,c:'#ffcc55'},
              ].map(s=>(
                <div key={s.l} style={{textAlign:'center',padding:'12px 8px',background:`${s.c}06`,border:`1px solid ${s.c}15`,borderRadius:8}}>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:22,fontWeight:900,color:s.c}}>{s.v}</div>
                  <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:1,marginTop:4}}>{s.l}</div>
                </div>
              ))}
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginTop:8}}>
              <div style={{textAlign:'center',padding:'12px 8px',background:'rgba(255,68,102,.06)',border:'1px solid rgba(255,68,102,.15)',borderRadius:8}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:22,fontWeight:900,color:'#ff4466'}}>{w.status==='active'?'LIVE':w.status?.toUpperCase()||'—'}</div>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:1,marginTop:4}}>CHALLENGE STATUS</div>
              </div>
              <div style={{textAlign:'center',padding:'12px 8px',background:'rgba(255,153,51,.06)',border:'1px solid rgba(255,153,51,.15)',borderRadius:8}}>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:22,fontWeight:900,color:'#ff9933'}}>{w.weekId||'—'}</div>
                <div style={{fontFamily:'Orbitron,monospace',fontSize:7,color:'#667788',letterSpacing:1,marginTop:4}}>CURRENT WEEK</div>
              </div>
            </div>
          </div>

          {/* Migration */}
          <div style={{marginBottom:20,padding:'16px 18px',background:'rgba(0,0,0,.2)',border:'1px solid rgba(191,90,242,.15)',borderRadius:12}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#bf5af2',letterSpacing:2,marginBottom:8}}>📤 MIGRATE localStorage → SUPABASE</div>
            <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#7a8a9a',lineHeight:1.6,marginBottom:14}}>
              Push all data from your browser's localStorage into the Supabase database. This includes lab work rewards, weekly config, challenge logs, announcements, and submissions. Safe to run multiple times — but may create duplicates if data already exists in Supabase.
            </div>
            <button onClick={async()=>{
              if(!window.confirm('📤 Migrate ALL localStorage data to Supabase?\n\nThis will push:\n• Lab Work Rewards\n• Weekly Config\n• Challenge Logs\n• Announcements\n• Submissions\n\nExisting Supabase data will NOT be deleted.'))return;
              if(!window.confirm('⚠️ Are you sure you want to proceed?'))return;
              show('⏳ Migrating...');
              try{
                const sb=await import('../lib/supabase');
                const r=await sb.migrateAllToSupabase();
                const summary=[
                  `Lab Work: ${r.labwork}`,
                  `Config: ${r.config?'✓':'—'}`,
                  `Logs: ${r.logs}`,
                  `Announcements: ${r.announcements}`,
                  `Submissions: ${r.submissions}`,
                  r.errors.length>0?`Errors: ${r.errors.length}`:'',
                ].filter(Boolean).join(' · ');
                show(`✅ Migration complete — ${summary}`);
              }catch(e:any){show(`❌ Migration failed: ${e.message}`);}
            }} style={{padding:'12px 20px',borderRadius:10,background:'linear-gradient(135deg,rgba(191,90,242,.15),rgba(140,60,255,.1))',border:'1px solid rgba(191,90,242,.4)',color:'#bf5af2',fontFamily:'Orbitron,monospace',fontSize:11,fontWeight:700,letterSpacing:2,cursor:'pointer',width:'100%'}}>
              📤 MIGRATE ALL TO SUPABASE
            </button>
          </div>

          {/* Verify Supabase Data */}
          <div style={{padding:'16px 18px',background:'rgba(0,0,0,.2)',border:'1px solid rgba(191,90,242,.15)',borderRadius:12}}>
            <div style={{fontFamily:'Orbitron,monospace',fontSize:9,color:'#bf5af2',letterSpacing:2,marginBottom:8}}>🔍 VERIFY SUPABASE DATA</div>
            <div style={{fontFamily:'Sora,sans-serif',fontSize:11,color:'#7a8a9a',lineHeight:1.6,marginBottom:14}}>
              Fetch fresh data from Supabase to verify what's stored in the database. This will show you the actual row counts from each table.
            </div>
            <button onClick={async()=>{
              show('⏳ Checking Supabase...');
              try{
                const sb=await import('../lib/supabase');
                const[lw,wc,cl,an,subs]=await Promise.all([
                  sb.getAllLabWorkRewards(),sb.getWeeklyConfig(),sb.getChallengeLogs(),sb.getAnnouncements(),sb.getSubmissions(),
                ]);
                show(`✅ Supabase: ${lw.length} rewards · ${wc?'Config ✓':'No config'} · ${cl.length} logs · ${an.length} news · ${subs.length} submissions`);
              }catch(e:any){show(`❌ Supabase check failed: ${e.message}`);}
            }} style={{padding:'10px 16px',borderRadius:8,background:'rgba(0,204,255,.06)',border:'1px solid rgba(0,204,255,.3)',color:'#00ccff',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,letterSpacing:2,cursor:'pointer',width:'100%',marginBottom:10}}>
              🔍 CHECK SUPABASE TABLES
            </button>
            <button onClick={async()=>{
              show('⏳ Refreshing from Supabase...');
              try{
                const sb=await import('../lib/supabase');
                sb.invalidateLabWorkCache();sb.invalidateWeeklyConfigCache();sb.invalidateChallengeLogsCache();sb.invalidateAnnouncementsCache();
                const[wc,cl,an,lw]=await Promise.all([sb.getWeeklyConfig(),sb.getChallengeLogs(),sb.getAnnouncements(),sb.getAllLabWorkRewards()]);
                if(wc&&wc.weekId)setW(wc as WConfig);
                if(cl.length>0)setLogs(cl as ChallengeLog[]);
                if(an.length>0)setAnns(an);
                if(lw.length>0){const mapped:LWReward[]=lw.map(r=>({id:r.id,address:r.address,lbPoints:r.lb_points,reason:r.reason,category:r.category||'other',date:r.created_at}));setLwRewards(mapped);}
                show('✅ All data refreshed from Supabase');
              }catch(e:any){show(`❌ Refresh failed: ${e.message}`);}
            }} style={{padding:'10px 16px',borderRadius:8,background:'rgba(57,255,136,.06)',border:'1px solid rgba(57,255,136,.3)',color:'#39ff88',fontFamily:'Orbitron,monospace',fontSize:10,fontWeight:700,letterSpacing:2,cursor:'pointer',width:'100%'}}>
              🔄 FORCE REFRESH FROM SUPABASE
            </button>
          </div>

        </div></div>}

      </div><Footer />
    </div>
  );
};

export default AdminRewards;