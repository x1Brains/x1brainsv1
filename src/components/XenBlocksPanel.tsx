import React, { FC, useState, useEffect, useCallback, useRef } from 'react';
import { Connection } from '@solana/web3.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  leaderboard: 'https://xenblocks.io/v1/leaderboard',
  pageSize:  100,
  maxPages:  100,
  cacheTtl:  120,
  netPollMs: 30_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// HASHRATE NORMALISATION
//
// XenBlocks has a FIXED global hashrate of ~10M H/s.
// The leaderboard API stores hashRate in KH/s, so a value of 1.21 = 1,210 H/s.
// Heuristic: raw < 500 → treat as KH/s (×1000); raw ≥ 500 → already H/s.
// ─────────────────────────────────────────────────────────────────────────────
function normaliseHashRate(raw: number): number {
  if (!raw || raw <= 0) return 0;
  return raw < 500 ? raw * 1000 : raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK STATS
// ─────────────────────────────────────────────────────────────────────────────
interface NetworkStats {
  difficulty:      number | null;
  memoryKiB:       number | null;
  totalBlocks:     number | null;
  networkHashRate: number | null;
  source:          'api' | 'derived' | 'none';
  fetchedAt:       number;
}

async function fetchNetworkStats(): Promise<NetworkStats> {
  const base: NetworkStats = {
    difficulty: null, memoryKiB: null, totalBlocks: null,
    networkHashRate: null, source: 'none', fetchedAt: Date.now(),
  };
  try {
    const r = await fetch(
      CFG.leaderboard + '?limit=100&offset=0',
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return base;
    const d = await r.json();
    if (!d || typeof d !== 'object') return base;
    const o = d as Record<string, unknown>;

    const n = (keys: string[]): number | null => {
      for (const k of keys) {
        const v = o[k];
        if (typeof v === 'number' && v > 0) return v;
        if (typeof v === 'string') { const p = Number(v); if (!isNaN(p) && p > 0) return p; }
      }
      return null;
    };

    const totalBlocks = n(['totalBlocks','total_blocks','block_count','blockCount','total','count']);
    const difficulty  = n(['difficulty','current_difficulty','argon2_memory_cost','memory_cost','memoryCost','memory_kib']);

    const minersArr = Array.isArray(o.miners) ? o.miners as Array<Record<string,unknown>> : [];
    const rawSum = minersArr.reduce((sum, m) => {
      const hr = typeof m.hashRate  === 'number' ? m.hashRate
               : typeof m.hashrate  === 'number' ? m.hashrate
               : typeof m.hash_rate === 'number' ? m.hash_rate : 0;
      return sum + normaliseHashRate(hr);
    }, 0);
    const networkHashRate = rawSum > 0 ? rawSum : null;

    const hasAny = [totalBlocks, difficulty, networkHashRate].some(v => v !== null);
    return {
      totalBlocks, difficulty, memoryKiB: difficulty, networkHashRate,
      source: hasAny ? 'derived' : 'none', fetchedAt: Date.now(),
    };
  } catch {
    return base;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_XUNI_MINTS = new Set<string>([]);
const KNOWN_XBLK_MINTS = new Set<string>([]);
const XUNI_COLOR   = '#00d4ff';
const XBLK_COLOR   = '#ffd700';
const XNM_COLOR    = '#ffb700';
const BLOCKS_COLOR = '#bf5af2';

// ─────────────────────────────────────────────────────────────────────────────
// INTERFACES
// ─────────────────────────────────────────────────────────────────────────────
interface MinerRecord {
  account: string; blocks: number;
  xnm?: number; xuni_count?: number; xuni_blocks?: number; xuni?: number;
  super_blocks?: number; super_block_count?: number; superblocks?: number; xblk?: number;
  rank?: number; hashRate?: number; hashrate?: number; hash_rate?: number;
  solAddress?: string; sol_address?: string;
  last_block?: string; last_active?: string; updated_at?: string;
  [key: string]: unknown;
}
interface MinerStats {
  evmAddress: string; svmAddress: string; solAddress: string | null;
  blocks: number; xnm: number; xuni: number; xblk: number;
  hashRate: number;
  rank: number | null; lastBlock: string | null; isActive: boolean;
  rawRecord: MinerRecord;
}
export interface WalletTokenSnapshot {
  mint: string; symbol: string; name: string; balance: number; logoUri?: string;
}
interface DebugEntry {
  ts: string; level: 'info'|'warn'|'error'|'success'; msg: string; data?: unknown;
}
export interface XenBlocksPanelProps {
  walletAddress: string; connection: Connection; evmAddress?: string; walletTokens?: WalletTokenSnapshot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────────────────
const _cache = new Map<string, { data: MinerStats; ts: number }>();
function getCached(k: string): MinerStats | null {
  const c = _cache.get(k);
  return (!c || Date.now() - c.ts > CFG.cacheTtl * 1000) ? null : c.data;
}
function setCache(k: string, d: MinerStats) { _cache.set(k, { data: d, ts: Date.now() }); }

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG LOGGER
// ─────────────────────────────────────────────────────────────────────────────
class DebugLogger {
  private entries: DebugEntry[] = [];
  private cb?: (e: DebugEntry[]) => void;
  setCallback(cb: (e: DebugEntry[]) => void) { this.cb = cb; }
  private push(level: DebugEntry['level'], msg: string, data?: unknown) {
    const ts = new Date().toISOString().slice(11, 23);
    const e: DebugEntry = { ts, level, msg, data };
    this.entries.push(e);
    const col = level==='error'?'#ff5050':level==='warn'?'#ffb700':level==='success'?'#00ff88':'#00d4ff';
    console.log(`%c[XenBlocks ${ts}] ${msg}`, `color:${col}`, data ?? '');
    this.cb?.([...this.entries]);
  }
  info   (m: string, d?: unknown) { this.push('info',    m, d); }
  warn   (m: string, d?: unknown) { this.push('warn',    m, d); }
  error  (m: string, d?: unknown) { this.push('error',   m, d); }
  success(m: string, d?: unknown) { this.push('success', m, d); }
  clear  ()                       { this.entries = []; this.cb?.([]); }
}
let logger = new DebugLogger();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function truncMatch(trunc: string, full: string): boolean {
  if (!trunc.includes('..')) return full.toLowerCase() === trunc.toLowerCase();
  const [pre, suf] = trunc.split('..');
  return full.toLowerCase().startsWith(pre.toLowerCase()) && full.toLowerCase().endsWith(suf.toLowerCase());
}
function extractMiners(raw: unknown): MinerRecord[] {
  if (Array.isArray(raw)) return raw as MinerRecord[];
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string,unknown>;
    for (const k of ['miners','data','leaderboard','results'])
      if (Array.isArray(o[k])) return o[k] as MinerRecord[];
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// EVM RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────
async function resolveEvmFromSvm(svmWallet: string, signal: AbortSignal): Promise<string | null> {
  logger.info('Fetching reg-ledger…', { svmWallet });
  try {
    const res = await fetch('https://xenblocks.io/reg-ledger/', { signal, headers: { Accept: 'text/html' } });
    if (!res.ok) { logger.warn(`reg-ledger HTTP ${res.status}`); return null; }
    const rows = (await res.text()).match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) ?? [];
    for (const row of rows) {
      const cells: string[] = [];
      let m: RegExpExecArray | null;
      const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      while ((m = re.exec(row)) !== null) cells.push(m[1].replace(/<[^>]+>/g,'').trim());
      if (cells.length < 2 || !cells[0].startsWith('0x')) continue;
      const [evmTrunc, svmTrunc] = cells;
      const svmIsSolana = !svmTrunc.startsWith('0x');
      const hit = svmIsSolana
        ? (svmTrunc.includes('..')
            ? svmWallet.startsWith(svmTrunc.split('..')[0]) && svmWallet.endsWith(svmTrunc.split('..')[1])
            : svmWallet === svmTrunc)
        : truncMatch(svmTrunc, svmWallet);
      if (hit) { logger.success('Found EVM in reg-ledger', { evmTrunc }); return evmTrunc; }
    }
    logger.warn('SVM not found in reg-ledger'); return null;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    logger.error('reg-ledger failed', String(err)); return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEADERBOARD SEARCH
// ─────────────────────────────────────────────────────────────────────────────
async function findMinerInLeaderboard(addr: string, signal: AbortSignal): Promise<{ miner: MinerRecord; rank: number } | null> {
  const isTrunc = addr.includes('..');
  const isFull  = /^0x[a-fA-F0-9]{40}$/i.test(addr);
  logger.info('Searching leaderboard…', { addr, mode: isTrunc?'truncated':isFull?'exact':'unknown' });
  for (let page = 0; page < CFG.maxPages; page++) {
    if (signal.aborted) throw new DOMException('Aborted','AbortError');
    const offset = page * CFG.pageSize;
    try {
      const res = await fetch(`${CFG.leaderboard}?limit=${CFG.pageSize}&offset=${offset}`, { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) { if (page === 0) throw new Error(`HTTP ${res.status}`); break; }
      const miners = extractMiners(await res.json());
      if (!miners.length) break;
      for (let i = 0; i < miners.length; i++) {
        const miner = miners[i], acct = miner.account ?? '';
        const match = isTrunc ? truncMatch(addr, acct) : acct.toLowerCase() === addr.toLowerCase();
        if (match) {
          const rank = miner.rank ?? (offset + i + 1);
          logger.success('Found miner', { acct, rank });
          return { miner, rank };
        }
      }
      if (miners.length < CFG.pageSize) break;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Page ${page+1} failed`, msg);
      if (page === 0) throw new Error(`Leaderboard API failed: ${msg}`);
      break;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN DATA FETCH
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMinerStats(svmWallet: string, providedEvm: string | undefined, signal: AbortSignal): Promise<MinerStats | null> {
  logger.clear();
  logger.info('════ START ════', { svmWallet, providedEvm });
  let evmTarget = providedEvm ?? null;
  if (!evmTarget) {
    evmTarget = await resolveEvmFromSvm(svmWallet, signal);
    if (!evmTarget) { logger.warn('No EVM address resolved'); return null; }
  }
  const result = await findMinerInLeaderboard(evmTarget, signal);
  if (!result) { logger.warn('Miner not found', { evmTarget }); return null; }
  const { miner, rank } = result;

  const blocks = Number(miner.blocks ?? 0);
  const xnm    = Number(miner.xnm ?? 0) / 1e18;
  const xuni   = Number(miner.xuni_count ?? miner.xuni_blocks ?? miner.xuni ?? 0) / 1e18;
  const xblk   = Number(miner.super_blocks ?? miner.super_block_count ?? miner.superblocks ?? miner.xblk ?? 0) / 1e18;

  const rawHr    = Number(miner.hashRate ?? miner.hashrate ?? miner.hash_rate ?? 0);
  const hashRate = normaliseHashRate(rawHr);
  logger.info('HashRate', { rawFromApi: rawHr, normalisedHs: hashRate, interpretation: rawHr < 500 ? 'was KH/s → ×1000' : 'was H/s → unchanged' });

  const solAddress = String(miner.solAddress ?? miner.sol_address ?? '').trim() || null;

  function parseTs(v: unknown): number | null {
    if (v == null || v === '') return null;
    if (typeof v === 'number') { if (v <= 0) return null; return v < 1e12 ? v*1000 : v; }
    if (typeof v === 'string') {
      const t = v.trim(); if (!t) return null;
      if (/^\d+$/.test(t)) { const n = Number(t); return n < 1e12 ? n*1000 : n; }
      const d = new Date(t).getTime(); return isNaN(d) ? null : d;
    }
    return null;
  }

  const lastMs    = parseTs(miner.last_block ?? miner.last_active ?? miner.updated_at ?? miner.lastBlock ?? null);
  const lastBlock = lastMs ? new Date(lastMs).toISOString() : '';
  const isActive  = lastMs ? Date.now() - lastMs < 86_400_000 : false;

  const stats: MinerStats = {
    evmAddress: miner.account, svmAddress: svmWallet, solAddress,
    blocks, xnm, xuni, xblk, hashRate, rank,
    lastBlock: lastBlock || null, isActive, rawRecord: miner,
  };
  logger.success('════ DONE ════', { blocks, xnm, xuni, xblk, hashRate, rank, isActive });
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING
// ─────────────────────────────────────────────────────────────────────────────
function fmtTokens(n: number) { return n===0?'0.00':n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtCount(n: number)  { return n===0?'0':n.toLocaleString(); }

function fmtHashRate(hs: number): { value: string; unit: string } {
  if (!hs || hs <= 0) return { value: '—', unit: '' };
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (hs >= 1_000_000) return { value: fmt(hs/1_000_000), unit: 'MH/s' };
  if (hs >= 1_000)     return { value: fmt(hs/1_000),     unit: 'KH/s' };
  return { value: fmt(hs), unit: 'H/s' };
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const C = { purple:'#bf5af2', cyan:'#00d4ff', green:'#00ff88', orange:'#ff8c00', gold:'#ffb700', red:'#ff5050', dark:'#0d1520' };
const mono: React.CSSProperties = { fontFamily:'Orbitron, monospace' };
const sans: React.CSSProperties = { fontFamily:'Sora, sans-serif' };
function hexToRgb(h: string) { return `${parseInt(h.slice(1,3),16)},${parseInt(h.slice(3,5),16)},${parseInt(h.slice(5,7),16)}`; }

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG PANEL
// ─────────────────────────────────────────────────────────────────────────────
const DebugPanel: FC<{ entries: DebugEntry[]; onClear: () => void }> = ({ entries, onClear }) => {
  const col = (l: DebugEntry['level']) => ({ error:C.red, warn:C.gold, success:C.green, info:C.cyan })[l];
  return (
    <div style={{ border:`1px solid rgba(0,212,255,.2)`, borderRadius:10, overflow:'hidden', marginTop:10 }}>
      <div style={{ padding:'10px 16px', background:'rgba(0,212,255,.06)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span style={{ ...mono, fontSize:10, color:C.cyan, letterSpacing:2 }}>🐛 DEBUG LOG ({entries.length})</span>
        <button onClick={onClear} style={{ ...mono, fontSize:9, color:'#666', background:'none', border:'1px solid #333', borderRadius:4, padding:'2px 8px', cursor:'pointer' }}>Clear</button>
      </div>
      <div style={{ background:'rgba(0,0,0,.5)', maxHeight:380, overflowY:'auto' }}>
        {entries.length===0 && <div style={{ ...sans, fontSize:11, color:'#555', padding:'16px 20px' }}>No entries.</div>}
        {entries.map((e,i) => (
          <div key={i} style={{ padding:'5px 16px', borderBottom:'1px solid rgba(255,255,255,.025)', display:'flex', gap:10 }}>
            <span style={{ ...mono, fontSize:9, color:'#3a3a3a', flexShrink:0, paddingTop:2 }}>{e.ts}</span>
            <span style={{ ...mono, fontSize:9, color:col(e.level), flexShrink:0, width:58, paddingTop:2 }}>[{e.level.toUpperCase()}]</span>
            <div style={{ flex:1, minWidth:0 }}>
              <span style={{ ...sans, fontSize:11, color:'#ccc' }}>{e.msg}</span>
              {e.data!==undefined && <pre style={{ margin:'3px 0 0', fontSize:10, color:'#666', whiteSpace:'pre-wrap', wordBreak:'break-all', fontFamily:'monospace' }}>{JSON.stringify(e.data,null,2)}</pre>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN BADGE
// ─────────────────────────────────────────────────────────────────────────────
const TokenBadge: FC<{ symbol:string; name:string; balance:number; color:string; logoUri?:string; tooltip?:string }> = ({ symbol, name, balance, color, logoUri, tooltip }) => (
  <div title={tooltip} style={{ display:'flex', alignItems:'center', gap:6, background:`rgba(${hexToRgb(color)},.10)`, border:`1px solid rgba(${hexToRgb(color)},.30)`, borderRadius:8, padding:'5px 10px' }}>
    {logoUri
      ? <img src={logoUri} alt={symbol} width={16} height={16} style={{ borderRadius:'50%', flexShrink:0 }} onError={e=>{(e.currentTarget as HTMLImageElement).style.display='none';}} />
      : <div style={{ width:16, height:16, borderRadius:'50%', flexShrink:0, background:`radial-gradient(circle at 35% 35%,${color},${color}88)`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:7, color:'#000', fontWeight:900 }}>{symbol.slice(0,1)}</div>
    }
    <div>
      <div style={{ ...mono, fontSize:9, color:'#7a9ab8', letterSpacing:1 }}>{name}</div>
      <div style={{ ...mono, fontSize:12, fontWeight:700, color, lineHeight:1.1 }}>
        {balance.toLocaleString(undefined,{maximumFractionDigits:4})}
        <span style={{ fontSize:8, marginLeft:3, opacity:0.7 }}>{symbol}</span>
      </div>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// STAT CARD
// ─────────────────────────────────────────────────────────────────────────────
const StatCard: FC<{ icon:string; value:string; unit?:string; label:string; sublabel:string; color:string }> = ({ icon, value, unit, label, sublabel, color }) => (
  <div style={{ background:C.dark, padding:'20px 14px 16px', textAlign:'center', display:'flex', flexDirection:'column', alignItems:'center', gap:3, position:'relative', overflow:'hidden' }}>
    <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:2, background:`linear-gradient(90deg,transparent,${color},transparent)` }} />
    <div style={{ fontSize:16, marginBottom:2, opacity:0.85 }}>{icon}</div>
    <div style={{ display:'flex', alignItems:'baseline', gap:4, justifyContent:'center', flexWrap:'wrap' }}>
      <span style={{ ...mono, fontSize:22, fontWeight:800, color, lineHeight:1, letterSpacing:-0.5 }}>{value}</span>
      {unit && <span style={{ ...mono, fontSize:9, fontWeight:700, color:color+'aa', letterSpacing:1, textTransform:'uppercase' }}>{unit}</span>}
    </div>
    <div style={{ ...mono, fontSize:9, color:'#7a9ab8', letterSpacing:2, textTransform:'uppercase', marginTop:2 }}>{label}</div>
    <div style={{ ...sans, fontSize:10, color:'#4a6070', lineHeight:1.3, marginTop:1 }}>{sublabel}</div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// WALLET TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const WalletTokensSection: FC<{ walletTokens:WalletTokenSnapshot[]; xuni:number; xblk:number }> = ({ walletTokens }) => {
  const xnt  = walletTokens.find(t => t.mint==='native-xnt' || t.symbol.toUpperCase()==='XNT');
  const xnm  = walletTokens.find(t => t.symbol.toUpperCase()==='XNM' && t.mint!=='native-xnt');
  const xuni = walletTokens.find(t => t.symbol.toUpperCase()==='XUNI' || KNOWN_XUNI_MINTS.has(t.mint));
  const xblk = walletTokens.find(t => ['XBLK','X.BLK','SUPERBLOCK'].includes(t.symbol.toUpperCase()) || KNOWN_XBLK_MINTS.has(t.mint));
  if (!xnt && !xnm && !xuni && !xblk) return null;
  return (
    <div style={{ padding:'14px 22px', background:'rgba(0,212,255,.03)', borderTop:'1px solid rgba(0,212,255,.1)' }}>
      <div style={{ ...mono, fontSize:9, color:'#00ff88', letterSpacing:2, textTransform:'uppercase', marginBottom:10 }}>Your Wallet Balance</div>
      <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
        {xnt  && <TokenBadge symbol={xnt.symbol}  name={xnt.name}  balance={xnt.balance}  color="#00d4ff"  logoUri={xnt.logoUri}  />}
        {xnm  && <TokenBadge symbol={xnm.symbol}  name={xnm.name}  balance={xnm.balance}  color={XNM_COLOR} logoUri={xnm.logoUri}  />}
        {xuni && <TokenBadge symbol={xuni.symbol} name={xuni.name} balance={xuni.balance} color={XUNI_COLOR} logoUri={xuni.logoUri} />}
        {xblk && <TokenBadge symbol={xblk.symbol} name={xblk.name} balance={xblk.balance} color={XBLK_COLOR} logoUri={xblk.logoUri} />}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK STATS BAR PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
const PulsingDot: FC<{ color:string; active?:boolean }> = ({ color, active=true }) => (
  <div style={{ width:8, height:8, borderRadius:'50%', flexShrink:0, background:active?color:'#333', boxShadow:active?`0 0 8px ${color}99,0 0 16px ${color}44`:'none', animation:active?'pulse-net 2s ease infinite':'none' }} />
);
const Shimmer: FC = () => (
  <div style={{ width:64, height:20, borderRadius:4, display:'inline-block', background:'linear-gradient(90deg,rgba(255,255,255,.04) 0%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.04) 100%)', backgroundSize:'200% 100%', animation:'shimmer 1.4s ease infinite' }} />
);
const Cell: FC<{
  label: string; value: string|null; sub?: string;
  color: string; icon: string; pulse?: boolean;
  firstLoad?: boolean; noBorder?: boolean;
}> = ({ label, value, sub, color, icon, pulse, firstLoad, noBorder }) => (
  <div style={{ flex:'1 1 0', minWidth:0, padding:'18px 20px', display:'flex', flexDirection:'column', gap:4, borderRight:noBorder?'none':'1px solid rgba(255,255,255,.05)', position:'relative', overflow:'hidden' }}>
    <div style={{ position:'absolute', top:0, left:0, width:'55%', height:2, background:`linear-gradient(90deg,${color},transparent)` }} />
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
      <span style={{ fontSize:13 }}>{icon}</span>
      {pulse && <PulsingDot color={color} />}
      <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#5a7a94', letterSpacing:2, textTransform:'uppercase' }}>{label}</span>
    </div>
    <div style={{ fontFamily:'Orbitron,monospace', fontSize:20, fontWeight:800, color, lineHeight:1, letterSpacing:-0.5, minHeight:24, display:'flex', alignItems:'center' }}>
      {value===null ? (firstLoad ? <Shimmer/> : '—') : value}
    </div>
    {sub && <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#4a6070', lineHeight:1.3, marginTop:1 }}>{sub}</div>}
  </div>
);
const UpdatedAgo: FC<{ fetchedAt:number }> = ({ fetchedAt }) => {
  const [,tick] = useState(0);
  useEffect(()=>{ const t=setInterval(()=>tick(n=>n+1),1000); return ()=>clearInterval(t); },[]);
  const s = Math.round((Date.now()-fetchedAt)/1000);
  return s<60 ? <>{s}s ago</> : <>{Math.floor(s/60)}m {s%60}s ago</>;
};

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK STATS BAR
//
// Row 1 — 3 network stats (even thirds):
//   📦 Total Blocks  |  🧮 Difficulty  |  🌐 Net Hashrate
//
// Row 2 — 3 miner stats (even thirds):
//   💻 Your Hash Rate  |  🏆 Your Rank  |  📊 Network Share
// ─────────────────────────────────────────────────────────────────────────────
const NetworkStatsBar: FC<{
  ns: NetworkStats|null; loading: boolean;
  minerHashHs: number; minerRank: number|null; isMiner: boolean;
}> = ({ ns, loading, minerHashHs, minerRank, isMiner }) => {
  const { value:hrVal, unit:hrUnit } = fmtHashRate(minerHashHs);
  const firstLoad = ns===null && loading;
  const isLive    = ns!==null && ns.source!=='none';

  const totalDisplay = (() => {
    if (ns?.totalBlocks==null) return null;
    return ns.totalBlocks>=1_000_000 ? (ns.totalBlocks/1_000_000).toFixed(2)+'M' : ns.totalBlocks.toLocaleString();
  })();
  const diffDisplay = (() => {
    const d = ns?.difficulty ?? ns?.memoryKiB ?? null;
    if (d===null) return null;
    return d>=1024 ? (d/1024).toFixed(1)+' MB' : d.toLocaleString()+' KiB';
  })();
  const netHrDisplay = (() => {
    if (!ns?.networkHashRate) return null;
    const { value, unit } = fmtHashRate(ns.networkHashRate);
    return `${value} ${unit}`;
  })();
  const netShareDisplay = (() => {
    if (!isMiner || !minerHashHs || !ns?.networkHashRate) return null;
    const pct = (minerHashHs / ns.networkHashRate) * 100;
    return pct < 0.01 ? '<0.01%' : pct.toFixed(3)+'%';
  })();

  return (
    <div style={{ borderTop:'1px solid rgba(0,212,255,.15)', background:'linear-gradient(180deg,rgba(0,212,255,.04) 0%,rgba(0,0,0,.3) 100%)' }}>

      {/* Header */}
      <div style={{ padding:'10px 22px 6px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <PulsingDot color="#00d4ff" active={isLive} />
          <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#00d4ff', letterSpacing:2.5, textTransform:'uppercase' }}>
            Network · Live
          </span>
        </div>
        <span style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#3a5060' }}>
          {firstLoad ? 'fetching…' : ns && ns.source!=='none'
            ? <>leaderboard · updated <UpdatedAgo fetchedAt={ns.fetchedAt} /></>
            : 'unavailable'}
        </span>
      </div>

      {/* Row 1 — 3 network stats, even thirds */}
      <div style={{ display:'flex', borderTop:'1px solid rgba(255,255,255,.04)' }}>
        <Cell icon="📦" label="Total Blocks" value={totalDisplay} sub="all-time network"   color="#00ff88" firstLoad={firstLoad} pulse={isLive} />
        <Cell icon="🧮" label="Difficulty"   value={diffDisplay}  sub="Argon2 memory cost" color="#ff8c00" firstLoad={firstLoad} />
        <Cell icon="🌐" label="Net Hashrate" value={netHrDisplay} sub="~10M H/s fixed cap" color="#bf5af2" firstLoad={firstLoad} noBorder />
      </div>

      <div style={{ height:1, background:'linear-gradient(90deg,transparent,rgba(191,90,242,.18),transparent)', margin:'0 22px' }} />

      {/* Row 2 — 3 miner stats, even thirds */}
      <div style={{ display:'flex', borderTop:'1px solid rgba(255,255,255,.04)' }}>
        <Cell
          icon="💻" label="Your Hash Rate"
          value={isMiner ? (hrVal||null) : '—'}
          sub={isMiner ? (hrUnit||'hashes / second') : 'not mining yet'}
          color="#00d4ff"
        />
        <Cell
          icon="🏆" label="Your Rank"
          value={isMiner ? (minerRank ? `#${minerRank.toLocaleString()}` : null) : '—'}
          sub={isMiner ? 'leaderboard position' : 'not on leaderboard'}
          color="#ff8c00"
        />
        <Cell
          icon="📊" label="Network Share"
          value={isMiner ? netShareDisplay : '—'}
          sub={isMiner ? 'your H/s ÷ net H/s' : 'start mining to earn'}
          color="#bf5af2" firstLoad={firstLoad} noBorder
        />
      </div>

      <style>{`
        @keyframes pulse-net{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(1.3)}}
        @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
        @keyframes spin{to{transform:rotate(360deg)}}
      `}</style>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export const XenBlocksPanel: FC<XenBlocksPanelProps> = ({ walletAddress, evmAddress, walletTokens=[] }) => {
  const [stats,       setStats]       = useState<MinerStats|null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string|null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [netStats,    setNetStats]    = useState<NetworkStats|null>(null);
  const [netLoading,  setNetLoading]  = useState(true);
  const [debugLog,    setDebugLog]    = useState<DebugEntry[]>([]);
  const [showDebug,   setShowDebug]   = useState(false);
  const ctrl = useRef<AbortController|null>(null);

  useEffect(()=>{ logger.setCallback(setDebugLog); return ()=>logger.setCallback(()=>{}); },[]);

  const loadData = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController(); ctrl.current = c;
    setLoading(true); setError(null);
    logger = new DebugLogger(); logger.setCallback(setDebugLog);
    const key = `${walletAddress}:${evmAddress??''}`;
    const cached = getCached(key);
    if (cached) { logger.info('Cache hit'); setStats(cached); setLoading(false); return; }
    try {
      const data = await fetchMinerStats(walletAddress, evmAddress, c.signal);
      if (c.signal.aborted) return;
      if (data) setCache(key, data);
      setStats(data);
    } catch (e: unknown) {
      if (c.signal.aborted) return;
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logger.error('loadData failed', msg); setError(msg);
    } finally {
      if (!c.signal.aborted) setLoading(false);
      if (ctrl.current===c) ctrl.current=null;
    }
  }, [walletAddress, evmAddress]);

  useEffect(()=>{ loadData(); return ()=>{ ctrl.current?.abort(); }; },[loadData]);
  useEffect(()=>{
    if (!autoRefresh) return;
    const t = setInterval(loadData, 60_000);
    return ()=>clearInterval(t);
  },[autoRefresh, loadData]);

  // Network polling — always fires, no dependency on miner state
  useEffect(()=>{
    let dead = false;
    const run = async () => {
      if (dead) return;
      setNetLoading(true);
      try {
        const fresh = await fetchNetworkStats();
        if (!dead) setNetStats(prev => !prev ? fresh : {
          difficulty:      fresh.difficulty      ?? prev.difficulty,
          memoryKiB:       fresh.memoryKiB       ?? prev.memoryKiB,
          totalBlocks:     fresh.totalBlocks     ?? prev.totalBlocks,
          networkHashRate: fresh.networkHashRate ?? prev.networkHashRate,
          source:    fresh.source!=='none' ? fresh.source : prev.source,
          fetchedAt: fresh.fetchedAt,
        });
      } catch {/**/} finally { if (!dead) setNetLoading(false); }
    };
    run();
    const t = setInterval(run, CFG.netPollMs);
    return ()=>{ dead=true; clearInterval(t); };
  },[]);

  const BtnDebug   = () => (
    <button onClick={()=>setShowDebug(d=>!d)} style={{ padding:'5px 12px', borderRadius:6, cursor:'pointer', border:`1px solid rgba(0,212,255,${showDebug?.5:.25})`, background:`rgba(0,212,255,${showDebug?.15:.05})`, ...mono, fontSize:9, color:C.cyan, letterSpacing:1 }}>
      🐛 {showDebug?'Hide':'Show'} Debug
    </button>
  );
  const BtnRefresh = () => (
    <button onClick={loadData} style={{ padding:'5px 12px', borderRadius:7, cursor:'pointer', background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.3)', ...mono, fontSize:10, color:C.purple, letterSpacing:1, textTransform:'uppercase' }}>
      ⟳ Refresh
    </button>
  );
  const NetBar = () => (
    <NetworkStatsBar
      ns={netStats} loading={netLoading}
      minerHashHs={stats?.hashRate ?? 0}
      minerRank={stats?.rank ?? null}
      isMiner={stats !== null}
    />
  );
  const Footer = () => (
    <div style={{ padding:'10px 22px', background:'rgba(0,0,0,.25)', borderTop:'1px solid rgba(191,90,242,.08)', display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
      <div style={{ width:5, height:5, borderRadius:'50%', background:C.purple }} />
      <span style={{ ...mono, fontSize:9, color:'#7a9ab8', letterSpacing:2, textTransform:'uppercase' }}>XenBlocks · Leaderboard API</span>
    </div>
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ marginBottom:24 }}>
      <div style={{ background:'linear-gradient(135deg,rgba(191,90,242,.06),rgba(191,90,242,.02))', border:'1px solid rgba(191,90,242,.2)', borderRadius:14, overflow:'hidden' }}>
        <div style={{ padding:40, textAlign:'center' }}>
          <div style={{ width:40, height:40, margin:'0 auto 16px', border:`3px solid rgba(191,90,242,.2)`, borderTop:`3px solid ${C.purple}`, borderRadius:'50%', animation:'spin 1s linear infinite' }} />
          <div style={{ ...mono, fontSize:11, color:C.purple, letterSpacing:2 }}>Scanning XenBlocks Leaderboard…</div>
        </div>
        <NetBar />
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // ── Error ──────────────────────────────────────────────────────────────────
  if (error) return (
    <div style={{ marginBottom:24 }}>
      <div style={{ background:'linear-gradient(135deg,rgba(255,50,50,.05),rgba(255,50,50,.02))', border:'1px solid rgba(255,50,50,.2)', borderRadius:14, overflow:'hidden' }}>
        <div style={{ padding:32, textAlign:'center' }}>
          <div style={{ fontSize:32, marginBottom:12 }}>⚠️</div>
          <div style={{ ...mono, fontSize:11, color:C.red, marginBottom:16, lineHeight:1.6, whiteSpace:'pre-wrap' }}>{error}</div>
          <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}><BtnRefresh /><BtnDebug /></div>
        </div>
        <NetBar />
      </div>
      {showDebug && <DebugPanel entries={debugLog} onClear={()=>logger.clear()} />}
    </div>
  );

  // ── Not a miner ────────────────────────────────────────────────────────────
  if (!stats) return (
    <div style={{ marginBottom:24 }}>
      <div style={{ background:'linear-gradient(135deg,rgba(191,90,242,.05),rgba(191,90,242,.02))', border:'1px solid rgba(191,90,242,.2)', borderRadius:14, overflow:'hidden' }}>
        <div style={{ padding:40, textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:16, opacity:.5 }}>⛏️</div>
          <div style={{ ...mono, fontSize:14, color:C.purple, letterSpacing:3, marginBottom:8, textTransform:'uppercase' }}>Not Mining Yet</div>
          <div style={{ ...sans, fontSize:12, color:'#7a9ab8', lineHeight:1.7, marginBottom:20 }}>
            Your wallet isn't on the leaderboard.<br />Network stats below update every 30 seconds.
          </div>
          <div style={{ display:'flex', gap:10, justifyContent:'center', flexWrap:'wrap' }}><BtnRefresh /><BtnDebug /></div>
        </div>
        {walletTokens.length > 0 && <WalletTokensSection walletTokens={walletTokens} xuni={0} xblk={0} />}
        <NetBar />
        <Footer />
      </div>
      {showDebug && <DebugPanel entries={debugLog} onClear={()=>logger.clear()} />}
    </div>
  );

  // ── Full miner view ────────────────────────────────────────────────────────
  const dispBlocks = stats.blocks > 0 ? fmtCount(stats.blocks) : '—';
  const dispXnm    = stats.xnm    > 0 ? fmtTokens(stats.xnm)  : '—';
  const dispXuni   = stats.xuni   > 0 ? fmtTokens(stats.xuni) : '0.00';
  const dispXblk   = stats.xblk   > 0 ? fmtTokens(stats.xblk) : '0.00';

  return (
    <div style={{ marginBottom:24 }}>
      <div style={{ background:'linear-gradient(135deg,rgba(191,90,242,.08),rgba(191,90,242,.02))', border:'1px solid rgba(191,90,242,.25)', borderRadius:14, overflow:'hidden' }}>

        {/* Header */}
        <div style={{ background:'rgba(191,90,242,.08)', borderBottom:'1px solid rgba(191,90,242,.2)', padding:'13px 20px', display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <div style={{ width:10, height:10, borderRadius:'50%', background:stats.isActive?C.green:'#555', boxShadow:stats.isActive?'0 0 10px rgba(0,255,136,.6)':'none' }} />
            <span style={{ ...mono, fontSize:11, color:stats.isActive?C.green:'#7a9ab8', letterSpacing:2, textTransform:'uppercase' }}>
              {stats.isActive ? 'Active Miner' : 'Inactive'}
            </span>
            {stats.rank && stats.rank<=100 && (
              <span style={{ padding:'3px 8px', background:'rgba(255,183,0,.15)', border:'1px solid rgba(255,183,0,.3)', borderRadius:5, ...mono, fontSize:9, color:C.gold }}>🏆 Top 100</span>
            )}
            {stats.rank && <span style={{ ...mono, fontSize:10, color:C.orange }}>Rank #{stats.rank.toLocaleString()}</span>}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            <BtnDebug />
            <span style={{ ...mono, fontSize:9, color:'#7a9ab8' }}>AUTO</span>
            <button onClick={()=>setAutoRefresh(a=>!a)} style={{ position:'relative', width:40, height:20, borderRadius:10, border:'none', cursor:'pointer', background:autoRefresh?`linear-gradient(135deg,${C.purple},#9f4ad2)`:'rgba(255,255,255,.1)', transition:'all .25s' }}>
              <span style={{ position:'absolute', top:2, left:autoRefresh?20:2, width:16, height:16, borderRadius:'50%', background:'#fff', transition:'left .25s' }} />
            </button>
            <BtnRefresh />
          </div>
        </div>

        {/* Miner stats grid */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:1, background:'rgba(191,90,242,.1)' }}>
          <StatCard icon="⛏️" value={dispBlocks} label="Total Blocks" sublabel="Regular XEN11"            color={BLOCKS_COLOR} />
          <StatCard icon="🪙" value={dispXnm}    label="XNM Earned"   sublabel="Xenium tokens"            color={XNM_COLOR}   unit={stats.xnm  > 0 ? 'XNM'  : undefined} />
          <StatCard icon="⏱️" value={dispXuni}   label="XUNI Blocks"  sublabel="Time-window collectibles" color={XUNI_COLOR}  unit={stats.xuni > 0 ? 'XUNI' : undefined} />
          <StatCard icon="💎" value={dispXblk}   label="SuperBlocks"  sublabel="X.BLK · ~1000× rare"     color={XBLK_COLOR}  unit={stats.xblk > 0 ? 'XBLK' : undefined} />
        </div>

        {/* Token legend */}
        <div style={{ padding:'12px 22px', background:'rgba(0,0,0,.15)', borderTop:'1px solid rgba(191,90,242,.1)', display:'flex', gap:24, flexWrap:'wrap' }}>
          {([
            { color:XNM_COLOR,  sym:'XNM · Xenium',     desc:'1 block = 10 XNM (yr 1, halving annually)' },
            { color:XUNI_COLOR, sym:'XUNI · Time Block', desc:'Mined XX:55–XX:05 only · collectible'      },
            { color:XBLK_COLOR, sym:'XBLK · SuperBlock', desc:'≥50 capitals in hash · ~1,000× rarer'      },
          ] as const).map(({ color, sym, desc }) => (
            <div key={sym} style={{ display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ width:8, height:8, borderRadius:'50%', background:color, flexShrink:0 }} />
              <div>
                <div style={{ ...mono, fontSize:8, color:'#5a7a94', letterSpacing:1.5, textTransform:'uppercase' }}>{sym}</div>
                <div style={{ ...sans, fontSize:10, color:'#7a9ab8' }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>

        {walletTokens.length > 0 && <WalletTokensSection walletTokens={walletTokens} xuni={stats.xuni} xblk={stats.xblk} />}

        <NetBar />

        {/* Addresses */}
        <div style={{ padding:'11px 22px', background:'rgba(255,183,0,.04)', borderTop:'1px solid rgba(255,183,0,.1)' }}>
          <div style={{ ...mono, fontSize:9, color:'#5a7a94', letterSpacing:2, textTransform:'uppercase', marginBottom:3 }}>EVM Miner Address</div>
          <div style={{ fontFamily:'monospace', fontSize:10, color:'#7a9ab8', wordBreak:'break-all' }}>{stats.evmAddress}</div>
        </div>
        <div style={{ padding:'11px 22px', background:'rgba(0,0,0,.12)', borderTop:'1px solid rgba(191,90,242,.08)' }}>
          <div style={{ ...mono, fontSize:9, color:'#5a7a94', letterSpacing:2, textTransform:'uppercase', marginBottom:3 }}>Connected SVM Wallet</div>
          <div style={{ fontFamily:'monospace', fontSize:10, color:'#7a9ab8', wordBreak:'break-all' }}>{stats.svmAddress}</div>
        </div>

        {/* Raw record */}
        <details style={{ borderTop:'1px solid rgba(191,90,242,.08)' }}>
          <summary style={{ padding:'11px 22px', cursor:'pointer', ...mono, fontSize:9, color:'#5a7a94', letterSpacing:2, textTransform:'uppercase', background:'rgba(0,0,0,.15)', listStyle:'none', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span>Raw API Record</span><span style={{ color:C.purple }}>▼</span>
          </summary>
          <pre style={{ margin:0, padding:'12px 22px', background:'rgba(0,0,0,.4)', fontSize:10, color:'#7a9ab8', fontFamily:'monospace', overflowX:'auto', maxHeight:200, overflowY:'auto' }}>
            {JSON.stringify(stats.rawRecord, null, 2)}
          </pre>
        </details>

        <Footer />
      </div>
      {showDebug && <DebugPanel entries={debugLog} onClear={()=>logger.clear()} />}
    </div>
  );
};