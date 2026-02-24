import React, { FC, useState, useEffect, useRef, useMemo } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import {
  BRAINS_MINT, XNT_WRAPPED, XDEX_API,
  BRAINS_LOGO, XNT_INFO, METADATA_PROGRAM_ID_STRING,
} from '../constants';
import { fetchOffChainLogo, resolveUri } from '../utils';
import burnBrainImg from '../assets/images1st.jpg';

// CORS-resilient wrapper — retries via proxy on localhost if direct fetch fails
const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
async function fetchLogoSafe(uri: string): Promise<string | undefined> {
  try {
    const result = await fetchOffChainLogo(uri);
    if (result) return result;
  } catch { /* direct fetch failed */ }
  if (isLocalhost && uri) {
    try {
      const proxied = `https://corsproxy.io/?${encodeURIComponent(uri)}`;
      const res = await fetch(proxied, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return undefined;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('image')) return proxied;
      const json = await res.json();
      const img = json?.image || json?.icon || json?.logo || json?.logoURI;
      return img ? resolveUri(img) : undefined;
    } catch { /* proxy also failed */ }
  }
  return undefined;
}
import {
  TopBar, PageBackground, Spinner,
  SectionHeader, PipelineBar, Footer, AddressBar, SideNav,
} from '../components/UI';
import { TokenCard, TokenData, XenBlocksPanel, WalletTokenSnapshot, useTokenPrices } from '../components/TokenComponents';
import { NFTGrid } from '../components/NFTComponents';
import { BurnedBrainsBar, injectBurnStyles, walletBurnStats } from '../components/BurnedBrainsBar';

// ─────────────────────────────────────────────
// MOBILE HOOK — matches BurnedBrainsBar breakpoint (640px)
// ─────────────────────────────────────────────
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 640 : false
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

// ─────────────────────────────────────────────
// NAME OVERRIDES
// ─────────────────────────────────────────────
const TOKEN_NAME_OVERRIDES: Record<string, { name: string; symbol: string }> = {
  [XNT_WRAPPED]: { name: 'Wrapped XNT', symbol: 'XNT' },
};

interface XDexMintInfo { token_address: string; name: string; symbol: string; decimals: number; logo?: string; }
interface ResolvedMeta { name: string; symbol: string; logoUri?: string; metaUri?: string; metaSource: TokenData['metaSource']; }

const METADATA_PROGRAM_ID = new PublicKey(METADATA_PROGRAM_ID_STRING);
const HARDCODED_LP_MINTS  = new Set(['FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3']);

injectBurnStyles();

// ─────────────────────────────────────────────
// XENBLOCKS MINER STATUS
// ─────────────────────────────────────────────
interface MinerStatus {
  isMiner: boolean; blocks: number; rank: number | null;
  isActive: boolean; loading: boolean;
}

function truncMatch(trunc: string, full: string): boolean {
  if (!trunc.includes('..')) return full.toLowerCase() === trunc.toLowerCase();
  const [pre, suf] = trunc.split('..');
  return full.toLowerCase().startsWith(pre.toLowerCase()) &&
         full.toLowerCase().endsWith(suf.toLowerCase());
}

function extractMiners(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.miners))      return o.miners;
    if (Array.isArray(o.data))        return o.data;
    if (Array.isArray(o.leaderboard)) return o.leaderboard;
    if (Array.isArray(o.results))     return o.results;
  }
  return [];
}

async function checkMinerStatus(
  walletAddress: string, evmAddress?: string,
): Promise<Omit<MinerStatus, 'loading'>> {
  try {
    let evmTarget: string | null = evmAddress || null;
    if (!evmTarget) {
      const regRes = await fetch('https://xenblocks.io/reg-ledger/', {
        headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(8000),
      });
      if (!regRes.ok) return { isMiner: false, blocks: 0, rank: null, isActive: false };
      const html  = await regRes.text();
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const rows  = html.match(rowRe) ?? [];
      for (const row of rows) {
        const cells: string[] = [];
        let m: RegExpExecArray | null;
        cellRe.lastIndex = 0;
        while ((m = cellRe.exec(row)) !== null)
          cells.push(m[1].replace(/<[^>]+>/g, '').trim());
        if (cells.length < 2 || !cells[0].startsWith('0x')) continue;
        const svmTrunc    = cells[1];
        const svmIsSolana = !svmTrunc.startsWith('0x');
        const hit = svmIsSolana
          ? (svmTrunc.includes('..')
              ? walletAddress.startsWith(svmTrunc.split('..')[0]) && walletAddress.endsWith(svmTrunc.split('..')[1])
              : walletAddress === svmTrunc)
          : truncMatch(svmTrunc, walletAddress);
        if (hit) { evmTarget = cells[0]; break; }
      }
    }
    if (!evmTarget) return { isMiner: false, blocks: 0, rank: null, isActive: false };
    const isTruncated = evmTarget.includes('..');
    for (let page = 0; page < 100; page++) {
      const offset = page * 100;
      const res = await fetch(`https://xenblocks.io/v1/leaderboard?limit=100&offset=${offset}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) break;
      const raw    = await res.json();
      const miners = extractMiners(raw);
      if (!miners.length) break;
      for (let i = 0; i < miners.length; i++) {
        const miner   = miners[i];
        const account = miner.account ?? '';
        const match   = isTruncated ? truncMatch(evmTarget, account) : account.toLowerCase() === evmTarget.toLowerCase();
        if (match) {
          const blocks    = Number(miner.blocks ?? miner.total_blocks ?? miner.block_count ?? 0);
          const rank      = miner.rank ?? (offset + i + 1);
          const lastBlock = miner.last_block ?? miner.last_active ?? miner.updated_at ?? null;
          const isActive  = lastBlock ? Date.now() - new Date(lastBlock).getTime() < 86_400_000 : false;
          return { isMiner: true, blocks, rank, isActive };
        }
      }
      if (miners.length < 100) break;
    }
    return { isMiner: false, blocks: 0, rank: null, isActive: false };
  } catch { return { isMiner: false, blocks: 0, rank: null, isActive: false }; }
}

// ─────────────────────────────────────────────
// BRAINS BURN
// ─────────────────────────────────────────────
async function burnBrainsTokens(connection: any, wallet: any, amount: number): Promise<string> {
  if (!wallet?.publicKey || !wallet?.signTransaction) throw new Error('Invalid wallet object');
  if (!connection || typeof connection.getLatestBlockhash !== 'function') throw new Error('Invalid connection object');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid burn amount');

  const BRAINS_MINT_PUBKEY = new PublicKey(BRAINS_MINT);
  const tokenAccount = getAssociatedTokenAddressSync(BRAINS_MINT_PUBKEY, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const mintInfo = await getMint(connection, BRAINS_MINT_PUBKEY, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const decimals = mintInfo.decimals;
  if (decimals < 0 || decimals > 18) throw new Error('Invalid token decimals');
  const rawAmount = BigInt(Math.floor(amount * 10 ** decimals));
  if (rawAmount <= 0n) throw new Error('Calculated raw amount is invalid');
  const burnIx = createBurnCheckedInstruction(tokenAccount, BRAINS_MINT_PUBKEY, wallet.publicKey, rawAmount, decimals, [], TOKEN_2022_PROGRAM_ID);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(burnIx);
  const signedTx = await wallet.signTransaction(tx);
  if (!signedTx.signature) throw new Error('Transaction signing failed');
  const signature = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' });

  // Fast polling — X1 confirms in <1s, confirmTransaction can hang 30s+
  for (let i = 0; i < 20; i++) {
    try {
      const resp = await connection.getSignatureStatuses([signature]);
      const s = resp?.value?.[0];
      if (s) {
        if (s.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return signature;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  // TX was broadcast successfully — return signature even if RPC is slow to confirm
  return signature;
}

// ─────────────────────────────────────────────
// LP DETECTION
// ─────────────────────────────────────────────
async function fetchAllXDexLPMints(): Promise<Set<string>> {
  const mints = new Set<string>(HARDCODED_LP_MINTS);
  try {
    const res = await fetch(`${XDEX_API}/api/xendex/pool/list?network=mainnet`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return mints;
    const data  = await res.json();
    const pools: any[] = Array.isArray(data) ? data : (data?.data ?? data?.pools ?? data?.list ?? data?.result ?? []);
    pools.forEach((p: any) => {
      const lp = p.lp_mint ?? p.lpMint ?? p.lp_token ?? p.lpToken ?? p.lp_address ?? p.lpAddress ?? p.mint ?? p.token_mint;
      if (lp) mints.add(lp);
    });
  } catch { }
  return mints;
}

async function fetchWalletPoolTokens(wallet: string): Promise<Set<string>> {
  const mints = new Set<string>();
  try {
    const res = await fetch(`${XDEX_API}/api/xendex/wallet/tokens/pool?network=mainnet&wallet=${wallet}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return mints;
    const data   = await res.json();
    const tokens: any[] = Array.isArray(data) ? data : (data?.data ?? data?.tokens ?? data?.list ?? data?.result ?? []);
    tokens.forEach((t: any) => { const m = t.mint ?? t.token_address ?? t.address ?? t.lpMint ?? t.lp_mint ?? t.tokenAddress; if (m) mints.add(m); });
  } catch { }
  return mints;
}

function checkIsLP(mint: string, global: Set<string>, wallet: Set<string>): boolean {
  return global.has(mint) || wallet.has(mint) || HARDCODED_LP_MINTS.has(mint);
}

// ─────────────────────────────────────────────
// XDEX REGISTRY
// ─────────────────────────────────────────────
async function fetchXDexMintRegistry(): Promise<Map<string, XDexMintInfo>> {
  const registry = new Map<string, XDexMintInfo>();
  try {
    const res = await fetch(`${XDEX_API}/api/xendex/mint/list?network=mainnet`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return registry;
    const data   = await res.json();
    const tokens: any[] = Array.isArray(data) ? data : (data?.data ?? data?.tokens ?? data?.list ?? data?.result ?? []);
    tokens.forEach((t: any) => {
      const addr = t.token_address ?? t.address ?? t.mint ?? t.mintAddress ?? t.tokenAddress;
      if (!addr) return;
      const override = TOKEN_NAME_OVERRIDES[addr];
      registry.set(addr, {
        token_address: addr,
        name:     override?.name   ?? (t.name   ?? t.tokenName   ?? 'Unknown').toString().replace(/\0/g, '').trim(),
        symbol:   override?.symbol ?? (t.symbol ?? t.tokenSymbol ?? addr.slice(0, 4).toUpperCase()).toString().replace(/\0/g, '').trim(),
        decimals: t.decimals ?? 9,
        logo:     t.logo ?? t.logoURI ?? t.logoUrl ?? t.image ?? t.icon,
      });
    });
  } catch { }
  return registry;
}

// ─────────────────────────────────────────────
// METADATA RESOLUTION
// ─────────────────────────────────────────────
async function tryToken2022Extension(connection: any, mint: string): Promise<ResolvedMeta | null> {
  try {
    const info   = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed = info?.value?.data?.parsed;
    if (!parsed) return null;
    const ext = (parsed?.info?.extensions ?? []).find((e: any) => e?.extension === 'tokenMetadata');
    if (!ext?.state) return null;
    const name   = (ext.state.name   ?? '').replace(/\0/g, '').trim();
    const symbol = (ext.state.symbol ?? '').replace(/\0/g, '').trim();
    const uri    = (ext.state.uri    ?? '').replace(/\0/g, '').trim();
    if (!name && !symbol) return null;
    const logoUri = uri ? await fetchLogoSafe(uri) : undefined;
    return { name: name || symbol || 'Unknown', symbol: symbol || name.slice(0, 6).toUpperCase() || '???', logoUri, metaUri: uri || undefined, metaSource: 'token2022ext' };
  } catch { return null; }
}

async function tryMetaplexPDA(connection: any, mint: string): Promise<ResolvedMeta | null> {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), new PublicKey(mint).toBytes()],
      METADATA_PROGRAM_ID,
    );
    const acct = await connection.getAccountInfo(pda);
    if (!acct?.data) return null;
    let raw: Uint8Array;
    if (acct.data instanceof Uint8Array) raw = acct.data;
    else if (typeof acct.data === 'string') raw = Uint8Array.from(atob(acct.data), c => c.charCodeAt(0));
    else raw = new Uint8Array(acct.data);
    if (raw.length < 69) return null;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let o = 65;
    const nL = view.getUint32(o, true); o += 4;
    if (!nL || nL > 200 || o + nL > raw.length) return null;
    const name = new TextDecoder().decode(raw.slice(o, o + nL)).replace(/\0/g, '').trim(); o += nL;
    const sL   = view.getUint32(o, true); o += 4;
    if (sL > 50 || o + sL > raw.length) return null;
    const symbol = new TextDecoder().decode(raw.slice(o, o + sL)).replace(/\0/g, '').trim(); o += sL;
    const uL     = view.getUint32(o, true); o += 4;
    if (uL > 500 || o + uL > raw.length) return null;
    const uri = new TextDecoder().decode(raw.slice(o, o + uL)).replace(/\0/g, '').trim();
    if (!name && !symbol) return null;
    if (name && !/^[\x20-\x7E\u00A0-\uFFFF]{1,60}$/.test(name)) return null;
    const logoUri = uri ? await fetchLogoSafe(uri) : undefined;
    return { name: name || 'Unknown', symbol: symbol || '???', logoUri, metaUri: uri || undefined, metaSource: 'metaplex' };
  } catch { return null; }
}

function tryXdexRegistry(registry: Map<string, XDexMintInfo>, mint: string): ResolvedMeta | null {
  const e = registry.get(mint);
  if (!e) return null;
  return { name: e.name, symbol: e.symbol, logoUri: resolveUri(e.logo ?? '') ?? undefined, metaSource: 'xdex' };
}

async function batchFetchMetaplexPDAs(connection: any, mints: string[]): Promise<Map<string, { name: string; symbol: string; uri: string }>> {
  const result = new Map<string, { name: string; symbol: string; uri: string }>();
  if (!mints.length) return result;
  try {
    const pdaMap = mints.map(mint => {
      const [pda] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), new PublicKey(mint).toBytes()],
        METADATA_PROGRAM_ID,
      );
      return { mint, pda };
    });
    for (let i = 0; i < pdaMap.length; i += 100) {
      const chunk = pdaMap.slice(i, i + 100);
      let accounts: any[] = [];
      try { accounts = await connection.getMultipleAccountsInfo(chunk.map((x: any) => x.pda), { encoding: 'base64' }); } catch { continue; }
      accounts.forEach((acct: any, idx: number) => {
        if (!acct?.data) return;
        const { mint } = chunk[idx];
        try {
          let raw: Uint8Array;
          const d = acct.data;
          if (d instanceof Uint8Array) raw = d;
          else if (Array.isArray(d) && typeof d[0] === 'string') raw = Uint8Array.from(atob(d[0]), c => c.charCodeAt(0));
          else if (typeof d === 'string') raw = Uint8Array.from(atob(d), c => c.charCodeAt(0));
          else return;
          if (raw.length < 69) return;
          const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          let o = 65;
          const nL = view.getUint32(o, true); o += 4;
          if (!nL || nL > 200 || o + nL > raw.length) return;
          const name = new TextDecoder().decode(raw.slice(o, o + nL)).replace(/\0/g, '').trim(); o += nL;
          const sL   = view.getUint32(o, true); o += 4;
          if (sL > 50 || o + sL > raw.length) return;
          const symbol = new TextDecoder().decode(raw.slice(o, o + sL)).replace(/\0/g, '').trim(); o += sL;
          const uL     = view.getUint32(o, true); o += 4;
          if (uL > 500 || o + uL > raw.length) return;
          const uri = new TextDecoder().decode(raw.slice(o, o + uL)).replace(/\0/g, '').trim();
          if (!name && !symbol) return;
          if (name && !/^[\x20-\x7E\u00A0-\uFFFF]{1,60}$/.test(name)) return;
          result.set(mint, { name, symbol, uri });
        } catch { }
      });
    }
  } catch { }
  return result;
}

async function resolveTokenMeta(
  connection: any, mint: string, xdexRegistry: Map<string, XDexMintInfo>,
  metaplexCache?: Map<string, { name: string; symbol: string; uri: string }>,
  logoCache?: Map<string, string | undefined>,
): Promise<ResolvedMeta> {
  const override = TOKEN_NAME_OVERRIDES[mint];
  const t2022 = await tryToken2022Extension(connection, mint);
  if (t2022) return override ? { ...t2022, ...override } : t2022;
  if (metaplexCache?.has(mint)) {
    const m       = metaplexCache.get(mint)!;
    let logoUri   = logoCache?.get(mint);
    if (logoUri === undefined && m.uri) {
      const fetched = await fetchLogoSafe(m.uri);
      // If fetchLogoSafe succeeds it returns the image URL directly.
      // If it fails/returns undefined, fall back to the raw metadata URI so
      // NFTImage can fetch the JSON itself and extract the image field.
      logoUri = fetched ?? m.uri;
      logoCache?.set(mint, logoUri);
    }
    const base: ResolvedMeta = { name: m.name || 'Unknown', symbol: m.symbol || '???', logoUri, metaUri: m.uri || undefined, metaSource: 'metaplex' };
    return override ? { ...base, ...override } : base;
  }
  const xdex = tryXdexRegistry(xdexRegistry, mint);
  if (xdex) return override ? { ...xdex, ...override } : xdex;
  if (mint === BRAINS_MINT) return { name: 'Brains', symbol: 'BRAINS', logoUri: BRAINS_LOGO, metaSource: 'xdex' };
  if (override) return { name: override.name, symbol: override.symbol, logoUri: XNT_INFO.logoUri, metaSource: 'xdex' };
  const mplex = await tryMetaplexPDA(connection, mint);
  if (mplex) return mplex;
  return { name: `${mint.slice(0, 6)}…${mint.slice(-4)}`, symbol: mint.slice(0, 5).toUpperCase(), logoUri: undefined, metaSource: 'fallback' };
}

// ─────────────────────────────────────────────
// TOGGLE ROW
// ─────────────────────────────────────────────
interface ToggleRowProps {
  icon: string; label: string; count: number; countLabel: string;
  active: boolean; color: string; colorRgb: string;
  noneLabel?: string; onToggle: () => void; isLast?: boolean;
}

const ToggleRow: FC<ToggleRowProps> = ({ icon, label, count, countLabel, active, color, colorRgb, noneLabel, onToggle, isLast }) => (
  <div style={{
    background: active && count > 0 ? `linear-gradient(135deg,rgba(${colorRgb},.07),rgba(${colorRgb},.02))` : '#0d1520',
    border: '1px solid #1e3050',
    borderTop: `1px solid ${active && count > 0 ? `rgba(${colorRgb},.28)` : '#1e3050'}`,
    borderRadius: isLast ? '0 0 14px 14px' : '0',
    padding: '11px 14px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    flexWrap: 'wrap', transition: 'all 0.25s',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: 15, flexShrink: 0 }}>{icon}</span>
      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, letterSpacing: 1.5,
        color: count > 0 ? (active ? color : '#8aa0b8') : '#4a6070', transition: 'color 0.25s', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {count > 0
        ? <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color, fontWeight: 700,
            background: `rgba(${colorRgb},.10)`, border: `1px solid rgba(${colorRgb},.30)`,
            padding: '2px 7px', borderRadius: 5, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {count} {countLabel}
          </span>
        : <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#4a6070', letterSpacing: 1, whiteSpace: 'nowrap' }}>
            {noneLabel ?? 'NONE'}
          </span>
      }
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, letterSpacing: 1.5,
        color: active && count > 0 ? color : '#3a5070', transition: 'color 0.25s' }}>
        {active && count > 0 ? 'ON' : 'OFF'}
      </span>
      <button onClick={onToggle} disabled={count === 0}
        style={{ position: 'relative', width: 46, height: 26, borderRadius: 13, border: 'none',
          cursor: count === 0 ? 'not-allowed' : 'pointer', outline: 'none', flexShrink: 0,
          opacity: count === 0 ? 0.3 : 1, transition: 'all 0.25s',
          background: active && count > 0 ? `linear-gradient(135deg,${color},${color}cc)` : 'rgba(255,255,255,.1)',
          boxShadow: active && count > 0 ? `0 0 10px rgba(${colorRgb},.4)` : 'none' }}>
        <span style={{ position: 'absolute', top: 3, left: active && count > 0 ? 23 : 3,
          width: 20, height: 20, borderRadius: '50%', background: '#fff',
          transition: 'left 0.25s', boxShadow: '0 1px 4px rgba(0,0,0,.4)' }} />
      </button>
    </div>
  </div>
);

// ─────────────────────────────────────────────
// PORTFOLIO STATS BAR
// ─────────────────────────────────────────────
const PortfolioStatsBar: FC<{
  totalTokens: number; splCount: number; t22Count: number; lpCount: number;
  xntBalance: number | null; minerStatus: MinerStatus;
  showSPL: boolean; onToggleSPL: () => void;
  showT22: boolean; onToggleT22: () => void;
  showLP:  boolean; onToggleLP:  () => void;
  showNFT: boolean; onToggleNFT: () => void;
  nftCount: number;
  totalUSD: number | null;
  burnKey: number; isMobile: boolean;
}> = ({ totalTokens, splCount, t22Count, lpCount, xntBalance, minerStatus, showSPL, onToggleSPL, showT22, onToggleT22, showLP, onToggleLP, showNFT, onToggleNFT, nftCount, totalUSD, burnKey, isMobile }) => (
  <div style={{ marginBottom: 32 }}>

    {/* Stats grid — 2×2 on mobile, 4-col on desktop */}
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
      background: '#0d1520', borderRadius: '14px 14px 0 0',
      border: '1px solid #1e3050', borderBottom: 'none', overflow: 'hidden',
    }}>
      {([
        { label: 'Total Tokens', value: String(totalTokens), color: '#ff8c00', glow: false },
        { label: 'SPL Tokens',   value: String(splCount),    color: '#ff8c00', glow: false },
        { label: 'Token-2022',   value: String(t22Count),    color: '#ffb700', glow: false },
        { label: 'XNT Balance',  value: xntBalance !== null
            ? xntBalance.toLocaleString(undefined, { maximumFractionDigits: 3 })
            : '—',                                           color: '#00d4ff', glow: true },
      ] as const).map((item, i) => (
        <div key={i} style={{
          padding: isMobile ? '14px 10px' : '18px 16px', textAlign: 'center', position: 'relative',
          background: item.glow ? 'rgba(0,212,255,.04)' : 'transparent',
          borderRight: isMobile
            ? (i % 2 === 0 ? '1px solid #1e3050' : 'none')
            : (i < 3 ? '1px solid #1e3050' : 'none'),
          borderBottom: isMobile && i < 2 ? '1px solid #1e3050' : 'none',
        }}>
          {item.glow && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg,transparent,rgba(0,212,255,.6),transparent)' }} />}
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 16 : 20, fontWeight: 700, color: item.color, marginBottom: 4,
            ...(item.glow ? { textShadow: '0 0 14px rgba(0,212,255,.55)' } : {}) }}>
            {item.value}
          </div>
          <div style={{ fontSize: isMobile ? 7 : 9, color: '#5a7a94', letterSpacing: isMobile ? 1 : 2, textTransform: 'uppercase', fontFamily: 'Orbitron, monospace' }}>
            {item.label}
          </div>
        </div>
      ))}
    </div>

    {/* Portfolio Total USD Value — styled banner row */}
    <div style={{
      background: 'linear-gradient(135deg,rgba(0,201,141,.12),rgba(0,201,141,.04))',
      border: '1px solid rgba(0,201,141,.28)',
      borderTop: 'none',
      padding: isMobile ? '12px 16px' : '16px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'relative', overflow: 'hidden',
      boxShadow: '0 4px 20px rgba(0,201,141,.08)',
    }}>
      {/* Animated top glow line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: 'linear-gradient(90deg,transparent,rgba(0,201,141,.7),transparent)' }} />
      {/* Left: label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Yellow orb — styled like the green connected-wallet orb but yellow */}
        <div style={{ position: 'relative', flexShrink: 0, width: isMobile ? 32 : 40, height: isMobile ? 32 : 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* Outer ring pulse */}
          <div style={{
            position: 'absolute', inset: -5, borderRadius: '50%',
            border: '1.5px solid rgba(255,210,0,.25)',
            animation: 'yellow-orb-ring 2.2s ease-in-out infinite',
          }} />
          {/* Inner glow fill */}
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,210,0,.18) 0%, rgba(255,170,0,.08) 55%, transparent 80%)',
            animation: 'yellow-orb-glow 2.2s ease-in-out infinite',
          }} />
          {/* Core dot */}
          <div style={{
            width: isMobile ? 13 : 16, height: isMobile ? 13 : 16, borderRadius: '50%',
            background: 'radial-gradient(circle, #ffe066 0%, #ffb700 60%, #cc8800 100%)',
            boxShadow: '0 0 6px rgba(255,200,0,.7), 0 0 14px rgba(255,180,0,.35)',
            animation: 'yellow-orb-core 2.2s ease-in-out infinite',
            position: 'relative', zIndex: 1,
          }} />
        </div>
        <div>
          <div style={{
            fontFamily: 'Orbitron, monospace',
            fontSize: isMobile ? 11 : 14,
            fontWeight: 700, color: '#d4f0e0',
            letterSpacing: isMobile ? 1 : 2,
            textTransform: 'uppercase',
            marginBottom: 3,
            textShadow: '0 0 10px rgba(0,255,153,.2)',
          }}>
            Total Portfolio Value
          </div>
          <div style={{ fontFamily: 'Sora, sans-serif', fontSize: isMobile ? 10 : 11, color: '#4a8a68', letterSpacing: 0.5 }}>
            All tokens combined
          </div>
        </div>
      </div>
      <style>{`
        @keyframes yellow-orb-ring {
          0%,100% { transform: scale(1);    opacity: .3; }
          50%      { transform: scale(1.12); opacity: .55; }
        }
        @keyframes yellow-orb-glow {
          0%,100% { opacity: .35; }
          50%      { opacity: .65; }
        }
        @keyframes yellow-orb-core {
          0%,100% { box-shadow: 0 0 4px rgba(255,200,0,.5), 0 0 8px rgba(255,180,0,.2); }
          50%      { box-shadow: 0 0 6px rgba(255,220,0,.7), 0 0 12px rgba(255,200,0,.35); }
        }
      `}</style>
      {/* Right: value */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        {totalUSD !== null && totalUSD > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <span style={{
                fontFamily: 'Orbitron, monospace',
                fontSize: isMobile ? 20 : 28,
                fontWeight: 700,
                color: '#00ff99',
                letterSpacing: 1,
                animation: 'usd-matrix-flicker 7s ease-in-out infinite',
              }}>
                {totalUSD >= 1_000_000
                  ? `$${(totalUSD / 1_000_000).toFixed(2)}M`
                  : totalUSD >= 1_000
                  ? `$${(totalUSD / 1_000).toFixed(2)}K`
                  : `$${totalUSD.toFixed(2)}`}
              </span>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#3a7055', letterSpacing: 1 }}>USD</span>
            </div>
            <style>{`
              @keyframes usd-matrix-flicker {
                0%   { color:#00ff99; text-shadow:0 0 6px #00ff99, 0 0 14px rgba(0,255,153,.4); }
                15%  { color:#00cc77; text-shadow:0 0 3px #00cc77, 0 0 8px rgba(0,204,119,.25); }
                16%  { color:#00ff99; text-shadow:0 0 6px #00ff99, 0 0 14px rgba(0,255,153,.4); }
                50%  { color:#39ff8f; text-shadow:0 0 8px #39ff8f, 0 0 18px rgba(57,255,143,.45); }
                85%  { color:#00ee88; text-shadow:0 0 4px #00ee88, 0 0 10px rgba(0,238,136,.3); }
                86%  { color:#00ff99; text-shadow:0 0 6px #00ff99, 0 0 14px rgba(0,255,153,.4); }
                100% { color:#00ff99; text-shadow:0 0 6px #00ff99, 0 0 14px rgba(0,255,153,.4); }
              }
            `}</style>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {[0, 0.2, 0.4].map((delay, i) => (
                <div key={i} style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: '#00c98d',
                  boxShadow: '0 0 6px rgba(0,201,141,.8)',
                  animation: `portfolio-dot-pulse 1.1s ease ${delay}s infinite`,
                }} />
              ))}
            </div>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#2a6a50', letterSpacing: 1.5 }}>LOADING</span>
          </div>
        )}
        <style>{`
          @keyframes portfolio-dot-pulse {
            0%,100%{ opacity:.15; transform:scale(.7); box-shadow:0 0 3px rgba(0,201,141,.3); }
            50%    { opacity:1;   transform:scale(1.1); box-shadow:0 0 10px rgba(0,201,141,.9); }
          }
        `}</style>
      </div>
    </div>

    {/* BurnedBrainsBar — handles its own mobile layout internally */}
    <BurnedBrainsBar key={burnKey} />

    {/* XenBlocks Miner Status */}
    <div style={{
      background: minerStatus.isMiner ? 'linear-gradient(135deg,rgba(191,90,242,.08),rgba(191,90,242,.02))' : 'rgba(191,90,242,.02)',
      border: '1px solid #1e3050',
      borderTop: minerStatus.isMiner ? '1px solid rgba(191,90,242,.28)' : '1px solid #1e3050',
      padding: '11px 14px',
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 15, flexShrink: 0 }}>⛏️</span>
      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, letterSpacing: 1.5,
        color: minerStatus.isMiner ? '#bf5af2' : '#8a9ab8' }}>
        XENBLOCKS
      </span>
      {minerStatus.loading ? (
        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#7a9ab8', letterSpacing: 1 }}>CHECKING...</span>
      ) : minerStatus.isMiner ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6,
            background: 'rgba(0,255,136,.1)', border: '1px solid rgba(0,255,136,.3)',
            borderRadius: 6, padding: '3px 10px' }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 8px rgba(0,255,136,.8)', animation: 'pulse-green 2s ease infinite' }} />
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00ff88', fontWeight: 700 }}>DETECTED</span>
          </div>
          {minerStatus.rank && (
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#ffb700' }}>#{minerStatus.rank.toLocaleString()}</span>
          )}
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#7a9ab8' }}>
            {minerStatus.blocks.toLocaleString()} BLK
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6,
          background: 'rgba(138,154,184,.08)', border: '1px solid rgba(138,154,184,.2)',
          borderRadius: 6, padding: '3px 10px' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#6a7a8a' }} />
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#8a9ab8' }}>NOT DETECTED</span>
        </div>
      )}
    </div>

    {/* Section toggles */}
    <ToggleRow icon="🪙" label="SPL Tokens"   count={splCount}  countLabel="TOKENS" active={showSPL}  color="#ff8c00" colorRgb="255,140,0"   onToggle={onToggleSPL} />
    <ToggleRow icon="⚡" label="Token-2022"   count={t22Count}  countLabel="TOKENS" active={showT22}  color="#ffb700" colorRgb="255,183,0"   onToggle={onToggleT22} />
    <ToggleRow icon="🖼️" label="NFTs"         count={nftCount}  countLabel="FOUND"  active={showNFT}  color="#bf5af2" colorRgb="191,90,242"  noneLabel="NONE FOUND"    onToggle={onToggleNFT} />
    <ToggleRow icon="💧" label="LP Tokens"    count={lpCount}   countLabel="FOUND"  active={showLP}   color="#00c98d" colorRgb="0,201,141"   noneLabel="NONE DETECTED" onToggle={onToggleLP}  isLast />
  </div>
);


// ─────────────────────────────────────────────
// PORTFOLIO PAGE
// ─────────────────────────────────────────────
// ─── BURN CELEBRATION POPUP ──────────────────────────────────────────────────
function injectBurnCelebrationStyles() {
  if (typeof document === 'undefined') return;
  if (document.head.querySelector('style[data-burn-celebrate]')) return;
  const s = document.createElement('style');
  s.setAttribute('data-burn-celebrate', '1');
  s.textContent = `
    @keyframes bc-in{0%{opacity:0;transform:scale(.5) rotate(-10deg)}60%{opacity:1;transform:scale(1.08) rotate(2deg)}100%{opacity:1;transform:scale(1) rotate(0)}}
    @keyframes bc-out{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.7) translateY(-30px)}}
    @keyframes bc-flame{0%{transform:translateY(0) scaleX(1);opacity:.8}50%{transform:translateY(-20px) scaleX(1.2);opacity:1}100%{transform:translateY(-50px) scaleX(.6);opacity:0}}
    @keyframes bc-ember{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(var(--ex,30px),var(--ey,-80px)) scale(0);opacity:0}}
    @keyframes bc-float{0%{transform:translateY(0) rotate(0)}50%{transform:translateY(-8px) rotate(3deg)}100%{transform:translateY(0) rotate(0)}}
    @keyframes bc-ring{0%{transform:scale(.5);opacity:.8}100%{transform:scale(2.5);opacity:0}}
    @keyframes bc-img{0%{filter:brightness(1) saturate(1)}25%{filter:brightness(1.3) saturate(1.5) sepia(.3)}50%{filter:brightness(1.6) saturate(2) sepia(.5) hue-rotate(-10deg)}75%{filter:brightness(1.2) saturate(1.3) sepia(.2)}100%{filter:brightness(1) saturate(1)}}
    @keyframes bc-glow{0%,100%{text-shadow:0 0 10px rgba(255,140,0,.5),0 0 30px rgba(255,60,0,.3)}50%{text-shadow:0 0 20px rgba(255,140,0,.8),0 0 50px rgba(255,60,0,.5),0 0 80px rgba(255,30,0,.3)}}
    @keyframes bc-spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
    @keyframes bc-burn{0%,100%{box-shadow:0 0 40px rgba(255,60,0,.5),0 0 80px rgba(255,30,0,.3),inset 0 0 30px rgba(255,80,0,.4)}50%{box-shadow:0 0 70px rgba(255,60,0,.8),0 0 120px rgba(255,30,0,.5),inset 0 0 50px rgba(255,80,0,.6)}}
    @keyframes bc-bloom{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:.6;transform:scale(1.05)}}
    @keyframes bc-shimmer{0%{background-position:250% center}50%{background-position:-50% center}100%{background-position:250% center}}
  `;
  document.head.appendChild(s);
}
injectBurnCelebrationStyles();

// Simple tier lookup for celebration display
const BURN_TIERS = [
  { name: 'UNRANKED', min: 0, icon: '○', neon: '#a0bbcc' }, { name: 'SPARK', min: 1, icon: '✦', neon: '#bbddff' },
  { name: 'FLAME', min: 25000, icon: '🕯️', neon: '#ffdd77' }, { name: 'INFERNO', min: 50000, icon: '🔥', neon: '#ffaa44' },
  { name: 'OVERWRITE', min: 100000, icon: '⚙️', neon: '#ff8811' }, { name: 'ANNIHILATE', min: 200000, icon: '💥', neon: '#ff6622' },
  { name: 'TERMINATE', min: 350000, icon: '⚡', neon: '#ff4411' }, { name: 'DISINTEGRATE', min: 500000, icon: '☢️', neon: '#ff2277' },
  { name: 'GODSLAYER', min: 700000, icon: '⚔️', neon: '#dd22ff' }, { name: 'APOCALYPSE', min: 850000, icon: '💀', neon: '#ff1155' },
  { name: 'INCINERATOR', min: 1000000, icon: '☠️', neon: '#fffaee' },
];
function getBurnTier(p: number) { for (let i = BURN_TIERS.length - 1; i >= 0; i--) if (p >= BURN_TIERS[i].min) return BURN_TIERS[i]; return BURN_TIERS[0]; }

const BurnCelebrationPortfolio: FC<{ amount: string; newPts: number; totalPts: number; labWorkPts: number; tierName: string; tierIcon: string; onClose: () => void }> = ({ amount, newPts, totalPts, labWorkPts, tierName, tierIcon, onClose }) => {
  const [phase, setPhase] = useState<'in' | 'out'>('in');
  const mob = typeof window !== 'undefined' && window.innerWidth < 640;
  useEffect(() => {
    const timer = setTimeout(() => { setPhase('out'); setTimeout(onClose, 600); }, 5500);
    return () => clearTimeout(timer);
  }, [onClose]);
  useEffect(() => { document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = ''; }; }, []);

  const fP = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const imgSz = mob ? 100 : 140;

  const embers = useMemo(() => Array.from({ length: mob ? 8 : 10 }, (_, i) => ({
    id: i, ex: (Math.random() - 0.5) * 200, ey: -(Math.random() * 120 + 40),
    size: Math.random() * 6 + 3, delay: Math.random() * 1.5, dur: Math.random() * 1.2 + 0.8,
    color: ['#ff4400', '#ff8800', '#ffcc00', '#ff6600', '#ffaa33'][Math.floor(Math.random() * 5)],
  })), []);

  return (
    <div onClick={() => { setPhase('out'); setTimeout(onClose, 600); }} style={{
      position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,.85)',
      backdropFilter: 'blur(12px)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
      animation: phase === 'in' ? 'bc-in 0.5s cubic-bezier(.34,1.56,.64,1) both' : 'bc-out 0.5s ease both', cursor: 'pointer',
    }}>
      <div style={{ position: 'absolute', width: 120, height: 120, borderRadius: '50%',
        border: '2px solid rgba(255,140,0,.3)', animation: 'bc-ring 1.5s ease infinite', pointerEvents: 'none' }} />
      {embers.map(e => (
        <div key={e.id} style={{ position: 'absolute', width: e.size, height: e.size, borderRadius: '50%',
          background: e.color, boxShadow: `0 0 ${e.size * 2}px ${e.color}`,
          animation: `bc-ember ${e.dur}s ease ${e.delay}s infinite`,
          ['--ex' as any]: `${e.ex}px`, ['--ey' as any]: `${e.ey}px`, pointerEvents: 'none' }} />
      ))}
      <div style={{ position: 'absolute', width: mob ? 180 : 280, height: mob ? 180 : 280, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(255,80,0,.25) 0%, rgba(255,140,0,.1) 40%, transparent 70%)',
        animation: 'bc-bloom 2s ease infinite', pointerEvents: 'none' }} />
      <div style={{ position: 'relative', width: imgSz, height: imgSz, borderRadius: '50%', overflow: 'visible',
        animation: 'bc-float 2s ease infinite', marginBottom: mob ? 16 : 24 }}>
        <div style={{ position: 'absolute', inset: mob ? -8 : -12, borderRadius: '50%',
          background: 'conic-gradient(from 0deg, #ff2200, #ff8800, #ffcc00, #ff6600, #ff2200)',
          animation: 'bc-spin 3s linear infinite', filter: 'blur(8px)', opacity: 0.7 }} />
        <div style={{ position: 'absolute', inset: mob ? -4 : -6, borderRadius: '50%',
          border: `${mob ? 2 : 3}px solid rgba(255,140,0,.6)`, animation: 'bc-burn 1.5s ease infinite' }} />
        <img src={burnBrainImg} alt="BURN" style={{
          width: imgSz, height: imgSz, borderRadius: '50%', objectFit: 'cover', objectPosition: 'center top',
          position: 'relative', zIndex: 2, display: 'block', transform: 'scale(1.3)',
          animation: 'bc-img 2s ease infinite', border: `${mob ? 2 : 3}px solid rgba(255,100,0,.5)` }} />
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} style={{ position: 'absolute', bottom: '60%', left: `${15 + i * 17}%`,
            width: 12 + i * 2, height: 30 + i * 5,
            background: `linear-gradient(to top, rgba(255,${60 + i * 30},0,.7), rgba(255,${120 + i * 20},0,.3), transparent)`,
            borderRadius: '50% 50% 30% 30%', animation: `bc-flame ${0.6 + i * 0.15}s ease ${i * 0.1}s infinite`,
            filter: 'blur(2px)', zIndex: 3, pointerEvents: 'none' }} />
        ))}
      </div>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 20 : 28, fontWeight: 900, letterSpacing: mob ? 2 : 4,
        background: 'linear-gradient(135deg, #ff4400, #ff8800, #ffcc00, #ffffff, #ffcc00, #ff8800)',
        backgroundSize: '200% 100%', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        animation: 'bc-glow 2s ease infinite, bc-shimmer 3s ease infinite', marginBottom: 6 }}>
        INCINERATED
      </div>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 14 : 18, fontWeight: 700, color: '#ffcc44',
        letterSpacing: mob ? 2 : 3, marginBottom: mob ? 12 : 16, textShadow: '0 0 12px rgba(255,140,0,.5)' }}>
        🔥 {amount} BRAINS 🔥
      </div>

      {/* LB Points earned panel */}
      <div style={{ display: 'flex', gap: mob ? 8 : 12, flexWrap: 'wrap', justifyContent: 'center', marginBottom: mob ? 8 : 10 }}>
        <div style={{ background: 'rgba(255,140,0,.08)', border: '1px solid rgba(255,140,0,.25)', borderRadius: mob ? 8 : 10, padding: mob ? '8px 14px' : '10px 18px', textAlign: 'center', minWidth: mob ? 100 : 120 }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 6 : 7, color: '#ff9955', letterSpacing: 2, marginBottom: 3 }}>◆ LB POINTS EARNED</div>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 16 : 20, fontWeight: 900, color: '#ffcc44', textShadow: '0 0 8px rgba(255,204,68,.3)' }}>+{fP(newPts)}</div>
        </div>
        <div style={{ background: 'rgba(140,60,255,.06)', border: '1px solid rgba(140,60,255,.2)', borderRadius: mob ? 8 : 10, padding: mob ? '8px 14px' : '10px 18px', textAlign: 'center', minWidth: mob ? 100 : 120 }}>
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
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: mob ? 7 : 9, color: '#ffaa44', background: 'rgba(255,170,68,.08)', border: '1px solid rgba(255,170,68,.2)', borderRadius: 6, padding: mob ? '3px 8px' : '4px 10px' }}>
          {tierIcon} {tierName}
        </div>
      </div>

      <div style={{ fontFamily: 'Sora, sans-serif', fontSize: mob ? 9 : 11, color: '#ff9955', letterSpacing: 2, opacity: 0.7, marginTop: 6 }}>
        TAP TO DISMISS
      </div>
    </div>
  );
};

const Portfolio: FC = () => {
  const { publicKey, signTransaction } = useWallet();
  const { connection }                 = useConnection();
  const isMobile                       = useIsMobile();

  const [xntBalance, setXntBalance]           = useState<number | null>(null);
  const [brainsToken, setBrainsToken]         = useState<TokenData | null>(null);
  const [splTokens, setSplTokens]             = useState<TokenData[]>([]);
  const [token2022s, setToken2022s]           = useState<TokenData[]>([]);
  const [lpTokens, setLpTokens]               = useState<TokenData[]>([]);
  const [nftTokens, setNftTokens]             = useState<TokenData[]>([]);
  const [loading, setLoading]                 = useState(false);
  const [loadingLabel, setLoadingLabel]       = useState('Scanning X1 chain...');
  const [copiedAddress, setCopiedAddress]     = useState<string | null>(null);
  const [hideZeroBalance, setHideZeroBalance] = useState(true);
  const [showSPL, setShowSPL]                 = useState(true);
  const [showT22, setShowT22]                 = useState(true);
  const [showLP, setShowLP]                   = useState(false);
  const [showNFT, setShowNFT]                 = useState(true);
  const [activeSection, setActiveSection]     = useState('top');
  const [xdexRegistry, setXdexRegistry]       = useState<Map<string, XDexMintInfo>>(new Map());
  const [globalLPMints, setGlobalLPMints]     = useState<Set<string>>(new Set(HARDCODED_LP_MINTS));
  const [registryLoaded, setRegistryLoaded]   = useState(false);
  const [minerStatus, setMinerStatus]         = useState<MinerStatus>({ isMiner: false, blocks: 0, rank: null, isActive: false, loading: false });
  const [userEvmAddress, setUserEvmAddress]   = useState('');
  const [burnAmount, setBurnAmount]           = useState('');
  const [burning, setBurning]                 = useState(false);
  const [burnError, setBurnError]             = useState<string | null>(null);
  const [burnSuccess, setBurnSuccess]         = useState<string | null>(null);
  const [burnTxSig, setBurnTxSig]             = useState<string | null>(null);
  const [burnKey, setBurnKey]                 = useState(0);
  const [showCelebration, setShowCelebration] = useState<{amount:string;newPts:number;totalPts:number;labWorkPts:number;tierName:string;tierIcon:string}|null>(null);

  const burnRef      = useRef<HTMLDivElement>(null);
  const splRef       = useRef<HTMLDivElement>(null);
  const t22Ref       = useRef<HTMLDivElement>(null);
  const lpRef        = useRef<HTMLDivElement>(null);
  const nftRef       = useRef<HTMLDivElement>(null);
  const xenBlocksRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadXdexData(); }, []);
  useEffect(() => { if (publicKey && registryLoaded) loadTokens(); else if (!publicKey) reset(); }, [publicKey?.toBase58(), registryLoaded]);
  useEffect(() => { if (publicKey) checkMinerStatusAuto(); }, [publicKey?.toBase58(), userEvmAddress]);

  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.pageYOffset;
      if (scrollY < 100) { setActiveSection('top'); return; }
      const sections = [
        { id: 'xenblocks', ref: xenBlocksRef }, { id: 'lp', ref: lpRef },
        { id: 'nft', ref: nftRef }, { id: 't22', ref: t22Ref }, { id: 'spl', ref: splRef }, { id: 'burn', ref: burnRef },
      ];
      for (const s of sections) {
        if (s.ref.current) {
          const rect = s.ref.current.getBoundingClientRect();
          if (rect.top <= 200 && rect.bottom >= 200) { setActiveSection(s.id); break; }
        }
      }
    };
    window.addEventListener('scroll', handleScroll);
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const reset = () => {
    setXntBalance(null); setBrainsToken(null); setSplTokens([]); setToken2022s([]); setLpTokens([]); setNftTokens([]);
    setMinerStatus({ isMiner: false, blocks: 0, rank: null, isActive: false, loading: false });
    setUserEvmAddress('');
  };

  const loadXdexData = async () => {
    const [mR, lR] = await Promise.allSettled([fetchXDexMintRegistry(), fetchAllXDexLPMints()]);
    if (mR.status === 'fulfilled') setXdexRegistry(mR.value);
    if (lR.status === 'fulfilled') setGlobalLPMints(lR.value);
    setRegistryLoaded(true);
  };

  const checkMinerStatusAuto = async () => {
    if (!publicKey) return;
    setMinerStatus(prev => ({ ...prev, loading: true }));
    try {
      const result = await checkMinerStatus(publicKey.toBase58(), userEvmAddress || undefined);
      setMinerStatus({ ...result, loading: false });
    } catch { setMinerStatus({ isMiner: false, blocks: 0, rank: null, isActive: false, loading: false }); }
  };

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddress(addr);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const handleNavigate = (section: string) => {
    if (section === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); setActiveSection('top'); return; }
    const refs: Record<string, React.RefObject<HTMLDivElement>> = { spl: splRef, t22: t22Ref, lp: lpRef, nft: nftRef, xenblocks: xenBlocksRef, burn: burnRef };
    const target = refs[section];
    if (target?.current) {
      window.scrollTo({ top: target.current.getBoundingClientRect().top + window.pageYOffset - 100, behavior: 'smooth' });
      setActiveSection(section);
    }
  };

  const loadTokens = async () => {
    if (!publicKey) return;
    setLoading(true);
    console.warn("🔥 LOAD TOKENS RUNNING v" + Date.now());
    try {
      setLoadingLabel('Loading wallet data...');
      const [lamR, wlpR, splR] = await Promise.allSettled([
        connection.getBalance(publicKey),
        fetchWalletPoolTokens(publicKey.toBase58()),
        connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
      ]);
      if (lamR.status === 'fulfilled') setXntBalance(lamR.value / 1e9);
      const walletLP: Set<string> = wlpR.status === 'fulfilled' ? wlpR.value : new Set();
      const splAccs: any[]        = splR.status === 'fulfilled'  ? splR.value.value : [];
      let t22Accs: any[] = [];
      try {
        setLoadingLabel('Loading Token-2022 accounts...');
        t22Accs = (await connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID })).value;
      } catch { }
      const allAccounts = [
        ...splAccs.map((a: any) => ({ ...a, is2022: false })),
        ...t22Accs.map((a: any) => ({ ...a, is2022: true })),
      ];
      const nonZero  = allAccounts.filter(acc => {
        const ta = acc.account.data.parsed.info.tokenAmount;
        const amt = ta.uiAmount ?? (ta.uiAmountString ? parseFloat(ta.uiAmountString) : 0);
        return amt > 0;
      });
      // Include BOTH spl and token-2022 mints in metaplex batch — NFTs can be either
      const allNonZeroMints = Array.from(new Set(nonZero.map((a: any) => a.account.data.parsed.info.mint as string)));
      const splMints = allNonZeroMints; // keep splMints name for compat
      setLoadingLabel(`Resolving metadata for ${allAccounts.length} tokens...`);
      const metaplexCache = await batchFetchMetaplexPDAs(connection, allNonZeroMints);
      const logoCache     = new Map<string, string | undefined>();
      const spl: TokenData[] = [], t2022: TokenData[] = [], lp: TokenData[] = [];
      let brains: TokenData | null = null;
      console.log('[Portfolio] Total accounts to process:', allAccounts.length);
      const results = await Promise.allSettled(allAccounts.map(async acc => {
        const info    = acc.account.data.parsed.info;
        // NFTs with decimals=0 sometimes return uiAmount=null — use uiAmountString fallback
        const rawAmount = info.tokenAmount.uiAmount;
        const balance = rawAmount !== null && rawAmount !== undefined
          ? rawAmount
          : (info.tokenAmount.uiAmountString ? parseFloat(info.tokenAmount.uiAmountString) : 0);
        console.log('[Portfolio] raw account:', info.mint?.slice(0,8), '| uiAmount:', info.tokenAmount.uiAmount, '| uiAmountString:', info.tokenAmount.uiAmountString, '| balance:', balance, '| decimals:', info.tokenAmount.decimals);
        if (balance < 0) return null;
        const mint = info.mint as string;
        const isLP = checkIsLP(mint, globalLPMints, walletLP);
        const meta = await resolveTokenMeta(connection, mint, xdexRegistry, metaplexCache, logoCache);
        return { mint, balance, decimals: info.tokenAmount.decimals, isToken2022: acc.is2022, isLP, name: meta.name, symbol: meta.symbol, logoUri: meta.logoUri, metaUri: meta.metaUri, metaSource: meta.metaSource };
      }));
      const nfts: TokenData[] = [];
      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const t  = r.value;
        const td: TokenData = { mint: t.mint, balance: t.balance, decimals: t.decimals, isToken2022: t.isToken2022, name: t.name, symbol: t.symbol, logoUri: t.logoUri, metaUri: (t as any).metaUri, metaSource: t.metaSource };
        // Detect NFTs early — before any metaSource filtering
        // decimals=0 + balance=1 is the canonical NFT fingerprint on Solana
        if (!t.isLP && t.mint !== BRAINS_MINT && t.decimals === 0 && t.balance === 1) {
          console.log('[Portfolio] NFT detected:', t.mint, '| name:', t.name, '| src:', t.metaSource, '| logoUri:', t.logoUri);
          // If no metaUri yet, fetch Metaplex PDA directly to get the raw metadata URI
          if (!td.metaUri && !td.logoUri) {
            try {
              const [pda] = PublicKey.findProgramAddressSync(
                [new TextEncoder().encode('metadata'), METADATA_PROGRAM_ID.toBytes(), new PublicKey(t.mint).toBytes()],
                METADATA_PROGRAM_ID,
              );
              const acctInfo = await connection.getAccountInfo(pda, { encoding: 'base64' });
              if (acctInfo?.data) {
                const raw = typeof acctInfo.data === 'string'
                  ? Uint8Array.from(atob(acctInfo.data), c => c.charCodeAt(0))
                  : Array.isArray(acctInfo.data)
                    ? Uint8Array.from(atob(acctInfo.data[0]), c => c.charCodeAt(0))
                    : new Uint8Array(acctInfo.data);
                if (raw.length >= 69) {
                  const view = new DataView(raw.buffer, raw.byteOffset);
                  let o = 65;
                  // name
                  const nL = view.getUint32(o, true); o += 4;
                  if (nL > 0 && nL <= 200 && o + nL <= raw.length) o += nL; else throw new Error('bad nL');
                  // symbol
                  const sL = view.getUint32(o, true); o += 4;
                  if (sL <= 50 && o + sL <= raw.length) o += sL; else throw new Error('bad sL');
                  // uri
                  const uL = view.getUint32(o, true); o += 4;
                  if (uL > 0 && uL <= 500 && o + uL <= raw.length) {
                    const uri = new TextDecoder().decode(raw.slice(o, o + uL)).split('\x00').join('').trim();
                    console.log('[Portfolio] NFT PDA URI for', t.mint.slice(0,8), ':', uri);
                    if (uri.startsWith('http') || uri.startsWith('ipfs://') || uri.startsWith('ar://')) {
                      td.metaUri = uri;
                    }
                  }
                }
              }
            } catch(e) { console.warn('[Portfolio] NFT PDA fetch failed:', e); }
          }
          nfts.push(td);
        } else if (t.isLP)                      lp.push(td);
        else if (t.mint === BRAINS_MINT)         brains = td;
        else if (t.isToken2022)                  t2022.push(td);
        else                                     spl.push(td);
      }
      spl.sort((a, b) => b.balance - a.balance);
      t2022.sort((a, b) => b.balance - a.balance);
      lp.sort((a, b) => b.balance - a.balance);
      nfts.sort((a, b) => a.name.localeCompare(b.name));
      setBrainsToken(brains); setSplTokens(spl); setToken2022s(t2022); setLpTokens(lp); setNftTokens(nfts);
    } catch (err) { console.error('[Portfolio]', err); }
    finally { setLoading(false); }
  };

  const handleBurnTokens = async () => {
    if (!publicKey || !connection) { setBurnError('Wallet not connected'); return; }
    if (!signTransaction) { setBurnError('Wallet does not support signing transactions'); return; }
    const amount = parseFloat(burnAmount);
    if (isNaN(amount) || amount <= 0) { setBurnError('Please enter a valid amount'); return; }
    if (!brainsToken || amount > brainsToken.balance) { setBurnError(`Insufficient balance. You have ${brainsToken?.balance || 0} BRAINS`); return; }
    setBurning(true); setBurnError(null); setBurnSuccess(null); setBurnTxSig(null);
    try {
      const earnedPts = amount * 1.888;
      // Read real totals from BurnedBrainsBar's global stats (same on-chain scan + Supabase data)
      const currentTotal = walletBurnStats.totalLbPts;
      const currentLabWork = walletBurnStats.labWorkPts;
      const projectedTotal = currentTotal + earnedPts;
      const projTier = getBurnTier(projectedTotal);
      const signature = await burnBrainsTokens(connection, { publicKey, signTransaction }, amount);
      setBurnTxSig(signature);
      setBurnSuccess(`Successfully burned ${amount.toLocaleString()} BRAINS`);
      setShowCelebration({ amount: amount.toLocaleString(), newPts: earnedPts, totalPts: projectedTotal, labWorkPts: currentLabWork, tierName: projTier.name, tierIcon: projTier.icon });
      setBurnKey(k => k + 1);
      setBurnAmount('');
      setTimeout(() => loadTokens(), 2000);
    } catch (err: any) { setBurnError(err.message || 'Failed to burn tokens'); }
    finally { setBurning(false); }
  };

  const t22Count    = token2022s.length + (brainsToken ? 1 : 0);
  const totalTokens = 1 + splTokens.length + t22Count + lpTokens.length + nftTokens.length;

  // USD price lookup — collect all mints for batch price fetching
  const allMints = useMemo(() => {
    const mints: string[] = [XNT_WRAPPED];
    if (brainsToken) mints.push(brainsToken.mint);
    for (const t of splTokens) mints.push(t.mint);
    for (const t of token2022s) mints.push(t.mint);
    return mints;
  }, [brainsToken, splTokens, token2022s]);
  const tokenPrices = useTokenPrices(allMints);

  // Compute total portfolio USD — uses live tokenPrices which auto-refreshes every 30s
  const totalUSD: number | null = useMemo(() => {
    if (tokenPrices.size === 0) return null;
    let total = 0;
    let hasAny = false;
    const allTokens = [
      ...(xntBalance !== null ? [{ mint: XNT_WRAPPED, balance: xntBalance }] : []),
      ...splTokens.map(t => ({ mint: t.mint, balance: t.balance })),
      ...token2022s.map(t => ({ mint: t.mint, balance: t.balance })),
      ...(brainsToken ? [{ mint: brainsToken.mint, balance: brainsToken.balance }] : []),
    ];
    for (const t of allTokens) {
      const p = tokenPrices.get(t.mint);
      if (p && p > 0) { total += p * t.balance; hasAny = true; }
    }
    return hasAny ? total : null;
  }, [tokenPrices, xntBalance, splTokens, token2022s, brainsToken]);

  const xenBlocksWalletTokens: WalletTokenSnapshot[] = [
    ...(xntBalance !== null ? [{ mint: 'native-xnt', symbol: 'XNT', name: 'X1 Native Token', balance: xntBalance, logoUri: XNT_INFO.logoUri } as WalletTokenSnapshot] : []),
    ...splTokens.map(t => ({ mint: t.mint, symbol: t.symbol, name: t.name, balance: t.balance, logoUri: t.logoUri } as WalletTokenSnapshot)),
    ...token2022s.map(t => ({ mint: t.mint, symbol: t.symbol, name: t.name, balance: t.balance, logoUri: t.logoUri } as WalletTokenSnapshot)),
    ...(brainsToken ? [{ mint: brainsToken.mint, symbol: brainsToken.symbol, name: brainsToken.name, balance: brainsToken.balance, logoUri: brainsToken.logoUri } as WalletTokenSnapshot] : []),
  ];

  // ─────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: '#080c0f', padding: isMobile ? '70px 12px 40px' : '90px 24px 40px', position: 'relative', overflow: 'hidden' }}>
      <TopBar />
      <PageBackground />

      {/* SideNav — desktop only */}
      {!isMobile && publicKey && !loading && (
        <SideNav
          activeSection={activeSection} onNavigate={handleNavigate}
          showSPL={showSPL} showT22={showT22} showLP={showLP}
          splCount={splTokens.length} t22Count={t22Count} lpCount={lpTokens.length}
          hasBrains={!!brainsToken}
        />
      )}

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 820, margin: '0 auto' }}>

        {/* Connected header */}
        {publicKey && (
          <div style={{ textAlign: 'center', marginBottom: isMobile ? 20 : 40, animation: 'fadeUp 0.5s ease both' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: isMobile ? 12 : 22 }}>
              <div style={{ position: 'relative', width: isMobile ? 80 : 140, height: isMobile ? 80 : 140 }}>
                <div style={{ position: 'absolute', inset: -7, borderRadius: '50%', background: 'conic-gradient(from 0deg,#ff8c00,#ffb700,#00d4ff,#ff8c00)', animation: 'spin 4s linear infinite', opacity: 0.65 }} />
                <img src={BRAINS_LOGO} alt="BRAINS"
                  style={{ position: 'relative', zIndex: 1, width: isMobile ? 80 : 140, height: isMobile ? 80 : 140, borderRadius: '50%', objectFit: 'cover', border: '4px solid #0a0e14' }}
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              </div>
            </div>
            <h1 style={{ fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 24 : 42, fontWeight: 900, letterSpacing: isMobile ? 4 : 7,
              background: 'linear-gradient(135deg,#ff8c00 0%,#ffb700 40%,#00d4ff 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              margin: '0 0 8px', textTransform: 'uppercase' }}>
              X1 BRAINS
            </h1>
            <p style={{ fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 8 : 12, letterSpacing: isMobile ? 2 : 5, color: '#7a9ab8', textTransform: 'uppercase' }}>
              X1 Blockchain · Portfolio Tracker
            </p>
          </div>
        )}

        {publicKey && <AddressBar address={publicKey.toBase58()} />}

        {publicKey && (
          <>
            {loading ? <Spinner label={loadingLabel} /> : (
              <div style={{ animation: 'fadeUp 0.4s ease both' }}>

                <PortfolioStatsBar
                  totalTokens={totalTokens} splCount={splTokens.length}
                  t22Count={t22Count} lpCount={lpTokens.length}
                  xntBalance={xntBalance} minerStatus={minerStatus}
                  showSPL={showSPL} onToggleSPL={() => setShowSPL(v => !v)}
                  showT22={showT22} onToggleT22={() => setShowT22(v => !v)}
                  showLP={showLP}   onToggleLP={() => setShowLP(v => !v)}
                  showNFT={showNFT} onToggleNFT={() => setShowNFT(v => !v)}
                  nftCount={nftTokens.length}
                  totalUSD={totalUSD}
                  burnKey={burnKey} isMobile={isMobile}
                />

                {/* 1. Native XNT */}
                <SectionHeader label="Native Token" color="#00d4ff" />
                <TokenCard
                  token={{ mint: XNT_WRAPPED, name: 'X1 Native Token', symbol: 'XNT', balance: xntBalance ?? 0,
                    decimals: 9, isToken2022: false, metaSource: undefined, logoUri: XNT_INFO.logoUri }}
                  highlight="native" copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.05} usdPrice={tokenPrices.get(XNT_WRAPPED) ?? null}
                />

                {/* 2. BRAINS + burn */}
                {brainsToken && (
                  <div ref={burnRef}>
                    <SectionHeader label="BRAINS Token" color="#ff8c00" />
                    <TokenCard token={brainsToken} highlight="brains" copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.1} usdPrice={tokenPrices.get(brainsToken.mint) ?? null} />

                    <div style={{
                      background: 'linear-gradient(135deg,rgba(255,30,30,.12),rgba(200,0,0,.08),rgba(255,30,30,.04))',
                      border: '2px solid rgba(255,30,30,.4)', borderRadius: 16,
                      padding: isMobile ? '16px 14px' : '24px 28px',
                      marginTop: 16, marginBottom: 24,
                      position: 'relative', overflow: 'hidden',
                    }}>
                      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3,
                        background: 'linear-gradient(90deg,transparent,rgba(255,30,30,.8),transparent)',
                        animation: 'pulse-red 2s ease infinite' }} />

                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                          background: 'linear-gradient(135deg,rgba(255,30,30,.2),rgba(200,0,0,.3))',
                          border: '2px solid rgba(255,30,30,.6)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>
                          🔥
                        </div>
                        <div>
                          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 11 : 13, color: '#fff', letterSpacing: 2, textTransform: 'uppercase', fontWeight: 900 }}>
                            Burn BRAINS Tokens
                          </div>
                          <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#c0c0c0', marginTop: 2 }}>
                            Permanently destroy · Reduce supply
                          </div>
                        </div>
                      </div>

                      <div style={{ background: 'rgba(255,30,30,.08)', border: '1px solid rgba(255,30,30,.25)',
                        borderLeft: '4px solid #ff1a1a', borderRadius: 8, padding: '10px 14px',
                        marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <span style={{ fontSize: 14, flexShrink: 0 }}>⚠️</span>
                        <span style={{ fontFamily: 'Sora, sans-serif', fontSize: isMobile ? 10 : 11, color: '#e0e0e0', lineHeight: 1.5 }}>
                          <strong style={{ color: '#fff' }}>Warning:</strong> This action is irreversible. Burned tokens cannot be recovered.
                        </span>
                      </div>

                      {/* Amount input — stacked on mobile */}
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#aaa', letterSpacing: 2, marginBottom: 8 }}>AMOUNT TO BURN</div>
                        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 10 }}>
                          <div style={{ flex: 1, position: 'relative' }}>
                            <input type="number" value={burnAmount} onChange={e => setBurnAmount(e.target.value)}
                              placeholder="0.00" disabled={burning}
                              style={{ width: '100%', padding: '13px 70px 13px 16px',
                                background: 'rgba(0,0,0,.6)', border: '2px solid rgba(255,30,30,.4)',
                                borderRadius: 10, fontFamily: 'Orbitron, monospace', fontSize: 16,
                                fontWeight: 700, color: '#fff', outline: 'none', boxSizing: 'border-box' }}
                              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(255,30,30,.8)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(255,30,30,.15)'; }}
                              onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(255,30,30,.4)'; e.currentTarget.style.boxShadow = 'none'; }}
                            />
                            <div style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                              fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#aaa', fontWeight: 700 }}>
                              BRAINS
                            </div>
                          </div>
                          <button onClick={() => setBurnAmount(brainsToken.balance.toString())} disabled={burning}
                            style={{ padding: isMobile ? '12px 0' : '0 20px',
                              background: 'linear-gradient(135deg,rgba(255,30,30,.25),rgba(200,0,0,.25))',
                              border: '2px solid rgba(255,30,30,.4)', borderRadius: 10,
                              fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 900,
                              color: '#fff', cursor: burning ? 'not-allowed' : 'pointer', letterSpacing: 2 }}>
                            MAX
                          </button>
                        </div>
                        <div style={{ marginTop: 8 }}>
                          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#8aa0b8' }}>
                            Available: <span style={{ color: '#fff', fontWeight: 600 }}>{brainsToken.balance.toLocaleString()}</span> BRAINS
                          </span>
                        </div>
                      </div>

                      <button onClick={handleBurnTokens} disabled={burning || !burnAmount}
                        style={{ width: '100%', padding: '14px 0',
                          background: burning || !burnAmount ? 'linear-gradient(135deg,rgba(255,30,30,.3),rgba(150,0,0,.3))' : 'linear-gradient(135deg,#ff1a1a,#cc0000,#990000)',
                          border: '2px solid', borderColor: burning || !burnAmount ? 'rgba(255,30,30,.4)' : 'rgba(255,30,30,.8)',
                          borderRadius: 12, fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 900,
                          letterSpacing: 2, color: '#fff', cursor: burning || !burnAmount ? 'not-allowed' : 'pointer',
                          opacity: burning || !burnAmount ? 0.5 : 1, textTransform: 'uppercase' }}>
                        {burning ? '🔥 BURNING...' : '🔥 EXECUTE BURN'}
                      </button>

                      {burnError && (
                        <div style={{ marginTop: 14, padding: '12px 14px', background: 'rgba(255,50,50,.15)',
                          border: '2px solid rgba(255,50,50,.4)', borderLeft: '4px solid #ff3333',
                          borderRadius: 8, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                          <span style={{ fontSize: 16, flexShrink: 0 }}>❌</span>
                          <div>
                            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#fff', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>BURN FAILED</div>
                            <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#ddd', lineHeight: 1.4 }}>{burnError}</div>
                          </div>
                        </div>
                      )}

                      {burnSuccess && burnTxSig && (
                        <div style={{ marginTop: 14, background: 'linear-gradient(135deg,rgba(0,255,136,.10),rgba(0,180,90,.07))',
                          border: '2px solid rgba(0,255,136,.35)', borderLeft: '4px solid #00ff88', borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ padding: '12px 16px 8px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                            <span style={{ fontSize: 16, flexShrink: 0 }}>✅</span>
                            <div>
                              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00ff88', fontWeight: 700, letterSpacing: 1 }}>BURN CONFIRMED</div>
                              <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#c8e8d0', marginTop: 3 }}>{burnSuccess}</div>
                            </div>
                          </div>
                          <div style={{ padding: '8px 16px', background: 'rgba(0,0,0,.25)', borderTop: '1px solid rgba(0,255,136,.15)' }}>
                            <code style={{ fontFamily: 'monospace', fontSize: 9, color: '#7ad4a8', wordBreak: 'break-all', lineHeight: 1.5 }}>{burnTxSig}</code>
                          </div>
                          <div style={{ padding: '10px 16px 14px' }}>
                            <a href={`https://explorer.mainnet.x1.xyz/tx/${burnTxSig}`} target="_blank" rel="noopener noreferrer"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px',
                                background: 'linear-gradient(135deg,rgba(0,255,136,.18),rgba(0,180,90,.15))',
                                border: '1px solid rgba(0,255,136,.45)', borderRadius: 8, textDecoration: 'none',
                                fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 700, color: '#00ff88' }}>
                              🔍 View on X1 Explorer ↗
                            </a>
                          </div>
                        </div>
                      )}
                      <style>{`@keyframes pulse-red { 0%,100%{opacity:.6} 50%{opacity:1} }`}</style>
                    </div>
                  </div>
                )}

                {/* ── Global Hide Zero Balance Toggle ── */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 10, gap: 10 }}>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#6a8ea8', letterSpacing: 1.5 }}>HIDE ZERO BALANCE</span>
                  <button onClick={() => setHideZeroBalance(v => !v)}
                    style={{ position: 'relative', width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', outline: 'none', flexShrink: 0, transition: 'all 0.25s',
                      background: hideZeroBalance ? 'linear-gradient(135deg,#ff8c00,#ffb700)' : 'rgba(255,255,255,.1)',
                      boxShadow: hideZeroBalance ? '0 0 10px rgba(255,140,0,.4)' : 'none' }}>
                    <span style={{ position: 'absolute', top: 2, left: hideZeroBalance ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.25s', boxShadow: '0 1px 4px rgba(0,0,0,.4)' }} />
                  </button>
                </div>

                {/* 3. SPL Tokens */}
                {showSPL && (() => {
                  const visible = splTokens.filter(t => t.metaSource !== 'fallback' && (!hideZeroBalance || t.balance > 0));
                  const hidden  = splTokens.filter(t => t.metaSource !== 'fallback' && t.balance <= 0).length;
                  return visible.length > 0 ? (
                    <div ref={splRef}>
                      <SectionHeader label="SPL Tokens" count={visible.length} color="#ff8c00" hiddenCount={hideZeroBalance ? hidden : 0} />
                      {visible.map((t, i) => <TokenCard key={t.mint} token={t} copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.04 * i} usdPrice={tokenPrices.get(t.mint) ?? null} />)}
                    </div>
                  ) : null;
                })()}

                {/* 4. Token-2022 */}
                {showT22 && (() => {
                  const visible = token2022s.filter(t => !hideZeroBalance || t.balance > 0);
                  const hidden  = token2022s.filter(t => t.balance <= 0).length;
                  return (brainsToken || token2022s.length > 0) ? (
                    <div ref={t22Ref}>
                      <SectionHeader label="Token-2022 Extensions" count={(brainsToken ? 1 : 0) + visible.length} color="#ffb700" hiddenCount={hideZeroBalance ? hidden : 0} />
                      {brainsToken && <TokenCard token={brainsToken} highlight="brains" copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.05} usdPrice={tokenPrices.get(brainsToken.mint) ?? null} />}
                      {visible.map((t, i) => <TokenCard key={t.mint} token={t} copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.04 * (i + 1)} usdPrice={tokenPrices.get(t.mint) ?? null} />)}
                    </div>
                  ) : null;
                })()}

                {/* 5. LP Tokens */}
                {showLP && (() => {
                  const visible = lpTokens.filter(t => !hideZeroBalance || t.balance > 0);
                  const hidden = lpTokens.filter(t => t.balance <= 0).length;
                  return visible.length > 0 ? (
                  <div ref={lpRef}>
                    <SectionHeader label="LP Tokens" count={visible.length} color="#00c98d" hiddenCount={hideZeroBalance ? hidden : 0} />
                    {visible.map((t, i) => <TokenCard key={t.mint} token={t} copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.04 * i} isLP={true} usdPrice={tokenPrices.get(t.mint) ?? null} />)}
                  </div>
                  ) : null;
                })()}

                {/* 5b. NFT Section */}
                {showNFT && nftTokens.length > 0 && (
                  <div ref={nftRef}>
                    <SectionHeader label="NFT Collection" count={nftTokens.length} color="#bf5af2" />
                    <NFTGrid
                      nfts={nftTokens}
                      isMobile={isMobile}
                      copiedAddress={copiedAddress}
                      onCopy={copyAddress}
                    />
                  </div>
                )}

                {/* XenBlocks */}
                {publicKey && connection && (
                  <div ref={xenBlocksRef}>
                    <SectionHeader label="XenBlocks Mining" color="#bf5af2" />
                    <div style={{ background: 'linear-gradient(135deg,rgba(191,90,242,.06),rgba(191,90,242,.02))',
                      border: '1px solid rgba(191,90,242,.2)', borderRadius: 14,
                      padding: isMobile ? '14px 12px' : '20px 24px', marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <span style={{ fontSize: 13 }}>🔗</span>
                        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#bf5af2', letterSpacing: 1.5, textTransform: 'uppercase' }}>
                          Manual EVM Lookup
                        </span>
                      </div>
                      <p style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#7a9ab8', lineHeight: 1.6, marginBottom: 12 }}>
                        Enter your EVM mining address (0x...) to fetch your XenBlocks stats.
                      </p>
                      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 10 }}>
                        <input type="text" value={userEvmAddress} onChange={e => setUserEvmAddress(e.target.value)}
                          placeholder="0x1234...abcd"
                          style={{ flex: 1, padding: '11px 14px', background: 'rgba(0,0,0,.4)',
                            border: '1px solid rgba(191,90,242,.3)', borderRadius: 8,
                            fontFamily: 'monospace', fontSize: 12, color: '#bf5af2', outline: 'none' }}
                          onFocus={e => { e.currentTarget.style.borderColor = 'rgba(191,90,242,.6)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(191,90,242,.1)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(191,90,242,.3)'; e.currentTarget.style.boxShadow = 'none'; }}
                        />
                        <button onClick={checkMinerStatusAuto} disabled={minerStatus.loading}
                          style={{ padding: isMobile ? '12px 0' : '11px 22px',
                            background: minerStatus.loading ? 'rgba(191,90,242,.3)' : 'linear-gradient(135deg,#bf5af2,#9f4ad2)',
                            border: 'none', borderRadius: 8, fontFamily: 'Orbitron, monospace', fontSize: 10,
                            fontWeight: 700, letterSpacing: 1.5, color: '#fff',
                            cursor: minerStatus.loading ? 'not-allowed' : 'pointer',
                            opacity: minerStatus.loading ? 0.6 : 1, textTransform: 'uppercase' }}>
                          {minerStatus.loading ? '⟳ Checking...' : '🔍 Lookup'}
                        </button>
                      </div>
                      {userEvmAddress && (
                        <div style={{ marginTop: 10, padding: '7px 12px', background: 'rgba(191,90,242,.08)',
                          border: '1px solid rgba(191,90,242,.2)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11 }}>ℹ️</span>
                          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#bf5af2', wordBreak: 'break-all' }}>
                            EVM: <code style={{ color: '#00d4ff' }}>{userEvmAddress}</code>
                          </span>
                        </div>
                      )}
                      {minerStatus.isMiner && (
                        <div style={{ marginTop: 10, padding: '7px 12px', background: 'rgba(0,255,136,.08)',
                          border: '1px solid rgba(0,255,136,.2)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11 }}>✅</span>
                          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#00ff88' }}>Miner detected!</span>
                        </div>
                      )}
                    </div>
                    <XenBlocksPanel
                      walletAddress={publicKey.toBase58()} connection={connection}
                      evmAddress={userEvmAddress || undefined} walletTokens={xenBlocksWalletTokens}
                    />
                  </div>
                )}

                {/* Refresh */}
                <button onClick={loadTokens}
                  style={{ width: '100%', marginTop: 32, padding: '14px 0',
                    background: 'linear-gradient(135deg,#ff8c00,#ffb700)', border: 'none', borderRadius: 12,
                    fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 700, letterSpacing: 2,
                    color: '#0a0e14', cursor: 'pointer', textTransform: 'uppercase', transition: 'all 0.2s' }}
                  onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'translateY(-2px)'; b.style.boxShadow = '0 8px 28px rgba(255,140,0,.45)'; }}
                  onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'translateY(0)'; b.style.boxShadow = 'none'; }}>
                  ⟳ &nbsp;Refresh Balances
                </button>

                <PipelineBar text="METADATA: T-2022 EXT → METAPLEX PDA → XDEX REGISTRY" />
              </div>
            )}
          </>
        )}

        {/* Not connected */}
        {!publicKey && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 140px)', animation: 'fadeUp 0.6s ease both', padding: '0 8px' }}>
            <div style={{ position: 'relative', marginBottom: isMobile ? 28 : 48 }}>
              <div style={{ position: 'absolute', inset: -50, borderRadius: '50%', background: 'radial-gradient(circle,rgba(255,140,0,.2) 0%,transparent 70%)', animation: 'pulse-orange 3s ease infinite' }} />
              <div style={{ position: 'relative', width: isMobile ? 120 : 180, height: isMobile ? 120 : 180 }}>
                <div style={{ position: 'absolute', inset: -7, borderRadius: '50%', background: 'conic-gradient(from 0deg,#ff8c00,#ffb700,#00d4ff,#ff8c00)', animation: 'spin 6s linear infinite', opacity: 0.65 }} />
                <img src={BRAINS_LOGO} alt="X1 Brains"
                  style={{ position: 'relative', zIndex: 1, width: isMobile ? 120 : 180, height: isMobile ? 120 : 180, borderRadius: '50%', objectFit: 'cover', border: '4px solid #0a0e14' }}
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              </div>
            </div>
            <h1 style={{ fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 32 : 56, fontWeight: 900, letterSpacing: isMobile ? 4 : 9,
              background: 'linear-gradient(135deg,#ff8c00 0%,#ffb700 45%,#00d4ff 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              margin: '0 0 12px', textTransform: 'uppercase', textAlign: 'center' }}>
              X1 BRAINS
            </h1>
            <p style={{ fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 8 : 13, letterSpacing: isMobile ? 2 : 6, color: '#7a9ab8', textTransform: 'uppercase', marginBottom: 36, textAlign: 'center' }}>
              X1 Blockchain · Portfolio Tracker
            </p>
            <div style={{ width: 200, height: 1, background: 'linear-gradient(to right,transparent,#ff8c0080,transparent)', marginBottom: 32 }} />
            <p style={{ fontFamily: 'Sora, sans-serif', fontSize: isMobile ? 13 : 16, color: '#7a9ab8', marginBottom: 24, textAlign: 'center' }}>
              Connect your wallet to view your X1 portfolio
            </p>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: isMobile ? 9 : 12, color: '#7a9ab8', padding: '12px 20px', letterSpacing: 2, border: '1px solid #1e3050', borderRadius: 12, background: 'rgba(255,140,0,.04)', textAlign: 'center' }}>
              USE CONNECT BUTTON ↗
            </div>
          </div>
        )}

        <Footer />
      </div>
      {showCelebration && <BurnCelebrationPortfolio amount={showCelebration.amount} newPts={showCelebration.newPts} totalPts={showCelebration.totalPts} labWorkPts={showCelebration.labWorkPts} tierName={showCelebration.tierName} tierIcon={showCelebration.tierIcon} onClose={() => setShowCelebration(null)} />}
    </div>
  );
};

export default Portfolio;

if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse-green {
      0%,100%{ opacity:1; box-shadow:0 0 12px rgba(0,255,136,.8),0 0 24px rgba(0,255,136,.4); }
      50%    { opacity:.7; box-shadow:0 0 20px rgba(0,255,136,1),0 0 40px rgba(0,255,136,.6); }
    }
  `;
  if (!document.head.querySelector('style[data-portfolio-animations]')) {
    style.setAttribute('data-portfolio-animations', 'true');
    document.head.appendChild(style);
  }
}