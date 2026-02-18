import React, { FC, useState, useEffect, useRef } from 'react';
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
import {
  TopBar, PageBackground, Spinner,
  SectionHeader, PipelineBar, Footer, AddressBar, SideNav,
} from '../components/UI';
import { TokenCard, TokenData, XenBlocksPanel, WalletTokenSnapshot } from '../components/TokenComponents';
import { BurnedBrainsBar, injectBurnStyles } from '../components/BurnedBrainsBar';

// ─────────────────────────────────────────────
// NAME OVERRIDES
// ─────────────────────────────────────────────
const TOKEN_NAME_OVERRIDES: Record<string, { name: string; symbol: string }> = {
  [XNT_WRAPPED]: { name: 'Wrapped XNT', symbol: 'XNT' },
};

interface XDexMintInfo { token_address: string; name: string; symbol: string; decimals: number; logo?: string; }
interface ResolvedMeta { name: string; symbol: string; logoUri?: string; metaSource: TokenData['metaSource']; }

const METADATA_PROGRAM_ID = new PublicKey(METADATA_PROGRAM_ID_STRING);
const HARDCODED_LP_MINTS  = new Set(['FSFjPXo9vAvVsjh6YuuNTjetZ6oZBgfYA6TLcWTYmwq3']);

// Inject burn animation CSS once
injectBurnStyles();

// ─────────────────────────────────────────────
// XENBLOCKS MINER STATUS
// ─────────────────────────────────────────────
interface MinerStatus {
  isMiner: boolean;
  blocks: number;
  rank: number | null;
  isActive: boolean;
  loading: boolean;
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
  walletAddress: string,
  evmAddress?: string,
): Promise<Omit<MinerStatus, 'loading'>> {
  try {
    let evmTarget: string | null = evmAddress || null;

    if (!evmTarget) {
      const regRes = await fetch('https://xenblocks.io/reg-ledger/', {
        headers: { Accept: 'text/html' },
        signal: AbortSignal.timeout(8000),
      });
      if (!regRes.ok) return { isMiner: false, blocks: 0, rank: null, isActive: false };

      const html   = await regRes.text();
      const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const rows   = html.match(rowRe) ?? [];

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
    const maxPages    = 100;
    const pageSize    = 100;

    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const res    = await fetch(
        `https://xenblocks.io/v1/leaderboard?limit=${pageSize}&offset=${offset}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) break;

      const raw    = await res.json();
      const miners = extractMiners(raw);
      if (!miners.length) break;

      for (let i = 0; i < miners.length; i++) {
        const miner   = miners[i];
        const account = miner.account ?? '';
        const match   = isTruncated
          ? truncMatch(evmTarget, account)
          : account.toLowerCase() === evmTarget.toLowerCase();

        if (match) {
          const blocks    = Number(miner.blocks ?? miner.total_blocks ?? miner.block_count ?? 0);
          const rank      = miner.rank ?? (offset + i + 1);
          const lastBlock = miner.last_block ?? miner.last_active ?? miner.updated_at ?? null;
          const isActive  = lastBlock
            ? Date.now() - new Date(lastBlock).getTime() < 86_400_000
            : false;
          return { isMiner: true, blocks, rank, isActive };
        }
      }
      if (miners.length < pageSize) break;
    }

    return { isMiner: false, blocks: 0, rank: null, isActive: false };
  } catch {
    return { isMiner: false, blocks: 0, rank: null, isActive: false };
  }
}

// ─────────────────────────────────────────────
// BRAINS BURN
// ─────────────────────────────────────────────
async function burnBrainsTokens(
  connection: any,
  wallet: any,
  amount: number,
): Promise<string> {
  if (!wallet?.publicKey || !wallet?.signTransaction)
    throw new Error('Invalid wallet object - missing required properties');
  if (!connection || typeof connection.getLatestBlockhash !== 'function')
    throw new Error('Invalid connection object');
  if (!Number.isFinite(amount) || amount <= 0)
    throw new Error('Invalid burn amount - must be positive and finite');

  const BRAINS_MINT_PUBKEY = new PublicKey(BRAINS_MINT);
  const tokenAccount = getAssociatedTokenAddressSync(
    BRAINS_MINT_PUBKEY, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );

  const mintInfo = await getMint(connection, BRAINS_MINT_PUBKEY, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const decimals = mintInfo.decimals;
  if (decimals < 0 || decimals > 18) throw new Error('Invalid token decimals detected');

  const rawAmount = BigInt(Math.floor(amount * 10 ** decimals));
  if (rawAmount <= 0n) throw new Error('Calculated raw amount is invalid');

  const burnIx = createBurnCheckedInstruction(
    tokenAccount, BRAINS_MINT_PUBKEY, wallet.publicKey,
    rawAmount, decimals, [], TOKEN_2022_PROGRAM_ID,
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('finalized');

  const tx       = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(burnIx);
  const signedTx = await wallet.signTransaction(tx);
  if (!signedTx.signature) throw new Error('Transaction signing failed - no signature');

  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
  });

  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight }, 'confirmed',
  );
  if (confirmation.value.err)
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);

  return signature;
}

// ─────────────────────────────────────────────
// LP DETECTION
// ─────────────────────────────────────────────
async function fetchAllXDexLPMints(): Promise<Set<string>> {
  const mints = new Set<string>(HARDCODED_LP_MINTS);
  try {
    const res = await fetch(`${XDEX_API}/api/xendex/pool/list?network=mainnet`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return mints;   // endpoint not live yet — return hardcoded set silently
    const data  = await res.json();
    const pools: any[] = Array.isArray(data)
      ? data
      : (data?.data ?? data?.pools ?? data?.list ?? data?.result ?? []);
    pools.forEach((p: any) => {
      const lp = p.lp_mint ?? p.lpMint ?? p.lp_token ?? p.lpToken
               ?? p.lp_address ?? p.lpAddress ?? p.mint ?? p.token_mint;
      if (lp) mints.add(lp);
    });
  } catch { /* xdex pool/list not yet live — silently use hardcoded LP set */ }
  return mints;
}

async function fetchWalletPoolTokens(wallet: string): Promise<Set<string>> {
  const mints = new Set<string>();
  try {
    const res = await fetch(
      `${XDEX_API}/api/xendex/wallet/tokens/pool?network=mainnet&wallet=${wallet}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return mints;   // endpoint not live yet — return empty set silently
    const data   = await res.json();
    const tokens: any[] = Array.isArray(data)
      ? data
      : (data?.data ?? data?.tokens ?? data?.list ?? data?.result ?? []);
    tokens.forEach((t: any) => {
      const m = t.mint ?? t.token_address ?? t.address ?? t.lpMint ?? t.lp_mint ?? t.tokenAddress;
      if (m) mints.add(m);
    });
  } catch { /* xdex wallet/tokens/pool not yet live — silently return empty */ }
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
    const res = await fetch(`${XDEX_API}/api/xendex/mint/list?network=mainnet`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return registry;  // endpoint not live yet — return empty registry silently
    const data   = await res.json();
    const tokens: any[] = Array.isArray(data)
      ? data
      : (data?.data ?? data?.tokens ?? data?.list ?? data?.result ?? []);
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
  } catch { /* xdex mint/list not yet live — silently return empty registry */ }
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
    const logoUri = uri ? await fetchOffChainLogo(uri) : undefined;
    return { name: name || symbol || 'Unknown', symbol: symbol || name.slice(0, 6).toUpperCase() || '???', logoUri, metaSource: 'token2022ext' };
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
    const logoUri = uri ? await fetchOffChainLogo(uri) : undefined;
    return { name: name || 'Unknown', symbol: symbol || '???', logoUri, metaSource: 'metaplex' };
  } catch { return null; }
}

function tryXdexRegistry(registry: Map<string, XDexMintInfo>, mint: string): ResolvedMeta | null {
  const e = registry.get(mint);
  if (!e) return null;
  return { name: e.name, symbol: e.symbol, logoUri: resolveUri(e.logo ?? '') ?? undefined, metaSource: 'xdex' };
}

async function batchFetchMetaplexPDAs(
  connection: any,
  mints: string[],
): Promise<Map<string, { name: string; symbol: string; uri: string }>> {
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
      try {
        accounts = await connection.getMultipleAccountsInfo(
          chunk.map((x: any) => x.pda), { encoding: 'base64' },
        );
      } catch { continue; }
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
  connection: any,
  mint: string,
  xdexRegistry: Map<string, XDexMintInfo>,
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
      logoUri = await fetchOffChainLogo(m.uri);
      logoCache?.set(mint, logoUri);
    }
    const base: ResolvedMeta = { name: m.name || 'Unknown', symbol: m.symbol || '???', logoUri, metaSource: 'metaplex' };
    return override ? { ...base, ...override } : base;
  }

  const xdex = tryXdexRegistry(xdexRegistry, mint);
  if (xdex) return override ? { ...xdex, ...override } : xdex;

  if (mint === BRAINS_MINT)
    return { name: 'Brains', symbol: 'BRAINS', logoUri: BRAINS_LOGO, metaSource: 'xdex' };
  if (override)
    return { name: override.name, symbol: override.symbol, logoUri: XNT_INFO.logoUri, metaSource: 'xdex' };

  const mplex = await tryMetaplexPDA(connection, mint);
  if (mplex) return mplex;

  return {
    name:     `${mint.slice(0, 6)}…${mint.slice(-4)}`,
    symbol:   mint.slice(0, 5).toUpperCase(),
    logoUri:  undefined,
    metaSource: 'fallback',
  };
}

// ─────────────────────────────────────────────
// STATS + SECTION VISIBILITY TOGGLES
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
    padding: '13px 22px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    transition: 'all 0.25s',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ fontSize: 17 }}>{icon}</span>
      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 700, letterSpacing: 2,
        color: count > 0 ? (active ? color : '#8aa0b8') : '#4a6070', transition: 'color 0.25s' }}>
        {label}
      </span>
      {count > 0
        ? <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color, fontWeight: 700,
            background: `rgba(${colorRgb},.10)`, border: `1px solid rgba(${colorRgb},.30)`,
            padding: '2px 9px', borderRadius: 5, transition: 'all 0.25s' }}>
            {count} {countLabel}
          </span>
        : <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#4a6070', letterSpacing: 1 }}>
            {noneLabel ?? 'NONE'}
          </span>
      }
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, letterSpacing: 2,
        color: active && count > 0 ? color : '#3a5070', transition: 'color 0.25s' }}>
        {active && count > 0 ? 'SHOWING' : 'HIDDEN'}
      </span>
      <button onClick={onToggle} disabled={count === 0}
        style={{ position: 'relative', width: 52, height: 30, borderRadius: 15, border: 'none',
          cursor: count === 0 ? 'not-allowed' : 'pointer', outline: 'none', flexShrink: 0,
          opacity: count === 0 ? 0.3 : 1, transition: 'all 0.25s',
          background: active && count > 0 ? `linear-gradient(135deg,${color},${color}cc)` : 'rgba(255,255,255,.1)',
          boxShadow: active && count > 0 ? `0 0 12px rgba(${colorRgb},.45)` : 'none' }}>
        <span style={{ position: 'absolute', top: 5, left: active && count > 0 ? 27 : 5,
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
  xntBalance: number | null;
  minerStatus: MinerStatus;
  showSPL: boolean; onToggleSPL: () => void;
  showT22: boolean; onToggleT22: () => void;
  showLP:  boolean; onToggleLP:  () => void;
  burnKey: number;
}> = ({
  totalTokens, splCount, t22Count, lpCount, xntBalance,
  minerStatus,
  showSPL, onToggleSPL, showT22, onToggleT22, showLP, onToggleLP,
  burnKey,
}) => (
  <div style={{ marginBottom: 32 }}>

    {/* ── Stats row ── */}
    <div style={{ display: 'flex', gap: 1, background: '#0d1520', borderRadius: '14px 14px 0 0', border: '1px solid #1e3050', borderBottom: 'none', overflow: 'hidden' }}>
      {([
        { label: 'Total Tokens', value: String(totalTokens), color: '#ff8c00', glow: false },
        { label: 'SPL Tokens',   value: String(splCount),    color: '#ff8c00', glow: false },
        { label: 'Token-2022',   value: String(t22Count),    color: '#ffb700', glow: false },
        { label: 'XNT Balance',  value: xntBalance !== null
            ? xntBalance.toLocaleString(undefined, { maximumFractionDigits: 3 })
            : '—',                                           color: '#00d4ff', glow: true  },
      ] as const).map((item, i, arr) => (
        <div key={i} style={{
          flex: 1, padding: '18px 20px', textAlign: 'center',
          borderRight: i < arr.length - 1 ? '1px solid #1e3050' : 'none',
          position: 'relative',
          background: item.glow ? 'rgba(0,212,255,.04)' : 'transparent',
        }}>
          {item.glow && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2,
              background: 'linear-gradient(90deg,transparent,rgba(0,212,255,.6),transparent)' }} />
          )}
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 20, fontWeight: 700,
            color: item.color, marginBottom: 5,
            ...(item.glow ? { textShadow: '0 0 14px rgba(0,212,255,.55),0 0 30px rgba(0,212,255,.2)' } : {}) }}>
            {item.value}
          </div>
          <div style={{ fontSize: 10, color: '#5a7a94', letterSpacing: 2, textTransform: 'uppercase', fontFamily: 'Orbitron, monospace' }}>
            {item.label}
          </div>
        </div>
      ))}
    </div>

    {/* ── 🔥 Burned BRAINS Bar — fetches live on-chain supply ── */}
    <BurnedBrainsBar key={burnKey} />

    {/* ── XenBlocks Miner Status ── */}
    <div style={{
      background: minerStatus.isMiner
        ? 'linear-gradient(135deg,rgba(191,90,242,.08),rgba(191,90,242,.02))'
        : 'rgba(191,90,242,.02)',
      border: '1px solid #1e3050',
      borderTop: minerStatus.isMiner ? '1px solid rgba(191,90,242,.28)' : '1px solid #1e3050',
      padding: '14px 22px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 17 }}>⛏️</span>
        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, fontWeight: 700, letterSpacing: 2,
          color: minerStatus.isMiner ? '#bf5af2' : '#8a9ab8',
          textShadow: minerStatus.isMiner
            ? '0 0 10px rgba(191,90,242,.8),0 0 20px rgba(191,90,242,.5),0 0 30px rgba(191,90,242,.3)'
            : '0 0 5px rgba(138,154,184,.2)',
          filter: minerStatus.isMiner ? 'drop-shadow(0 0 8px rgba(191,90,242,.4))' : 'none' }}>
          XENBLOCKS MINER
        </span>
        {minerStatus.loading ? (
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#7a9ab8', letterSpacing: 1 }}>CHECKING...</span>
        ) : minerStatus.isMiner ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8,
              background: 'rgba(0,255,136,.1)', border: '1px solid rgba(0,255,136,.3)',
              borderRadius: 6, padding: '4px 12px' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00ff88',
                boxShadow: '0 0 12px rgba(0,255,136,.8),0 0 24px rgba(0,255,136,.4)',
                animation: 'pulse-green 2s ease infinite' }} />
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#00ff88', fontWeight: 700, letterSpacing: 1 }}>DETECTED</span>
            </div>
            {minerStatus.isActive && (
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00ff88',
                background: 'rgba(0,255,136,.08)', border: '1px solid rgba(0,255,136,.2)',
                padding: '2px 8px', borderRadius: 4, letterSpacing: 1 }}>ACTIVE</span>
            )}
            {minerStatus.rank && (
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#ffb700', letterSpacing: 1 }}>
                RANK #{minerStatus.rank.toLocaleString()}
              </span>
            )}
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#7a9ab8', letterSpacing: 1 }}>
              {minerStatus.blocks.toLocaleString()} BLOCKS
            </span>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8,
            background: 'linear-gradient(135deg,rgba(138,154,184,.08),rgba(138,154,184,.03))',
            border: '1px solid rgba(138,154,184,.25)', borderRadius: 6, padding: '4px 12px',
            boxShadow: '0 0 8px rgba(138,154,184,.1)' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%',
              background: 'linear-gradient(135deg,#7a8a9a,#6a7a8a)',
              boxShadow: '0 0 6px rgba(122,138,154,.3)' }} />
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#8a9ab8',
              letterSpacing: 1, textShadow: '0 0 4px rgba(138,154,184,.2)' }}>NOT DETECTED</span>
          </div>
        )}
      </div>
    </div>

    {/* ── Section toggles ── */}
    <ToggleRow icon="🪙" label="SPL Tokens"    count={splCount} countLabel="TOKENS" active={showSPL} color="#ff8c00" colorRgb="255,140,0" onToggle={onToggleSPL} />
    <ToggleRow icon="⚡" label="Token-2022 Ext" count={t22Count} countLabel="TOKENS" active={showT22} color="#ffb700" colorRgb="255,183,0" onToggle={onToggleT22} />
    <ToggleRow icon="💧" label="LP Tokens"      count={lpCount}  countLabel="FOUND"  active={showLP}  color="#00c98d" colorRgb="0,201,141" noneLabel="NONE DETECTED" onToggle={onToggleLP} isLast />
  </div>
);

// ─────────────────────────────────────────────
// PORTFOLIO PAGE
// ─────────────────────────────────────────────
const Portfolio: FC = () => {
  const { publicKey, signTransaction } = useWallet();
  const { connection }                 = useConnection();

  // Token state
  const [xntBalance, setXntBalance]         = useState<number | null>(null);
  const [brainsToken, setBrainsToken]       = useState<TokenData | null>(null);
  const [splTokens, setSplTokens]           = useState<TokenData[]>([]);
  const [token2022s, setToken2022s]         = useState<TokenData[]>([]);
  const [lpTokens, setLpTokens]             = useState<TokenData[]>([]);
  const [loading, setLoading]               = useState(false);
  const [loadingLabel, setLoadingLabel]     = useState('Scanning X1 chain...');

  // UI state
  const [copiedAddress, setCopiedAddress]   = useState<string | null>(null);
  const [hideZeroBalance, setHideZeroBalance] = useState(true);
  const [showSPL, setShowSPL]               = useState(true);
  const [showT22, setShowT22]               = useState(true);
  const [showLP, setShowLP]                 = useState(false);
  const [activeSection, setActiveSection]   = useState('top');

  // Registry / LP state
  const [xdexRegistry, setXdexRegistry]     = useState<Map<string, XDexMintInfo>>(new Map());
  const [globalLPMints, setGlobalLPMints]   = useState<Set<string>>(new Set(HARDCODED_LP_MINTS));
  const [registryLoaded, setRegistryLoaded] = useState(false);

  // XenBlocks miner
  const [minerStatus, setMinerStatus]       = useState<MinerStatus>({ isMiner: false, blocks: 0, rank: null, isActive: false, loading: false });
  const [userEvmAddress, setUserEvmAddress] = useState('');

  // Burn state
  const [burnAmount, setBurnAmount]         = useState('');
  const [burning, setBurning]               = useState(false);
  const [burnError, setBurnError]           = useState<string | null>(null);
  const [burnSuccess, setBurnSuccess]       = useState<string | null>(null);
  const [burnTxSig, setBurnTxSig]           = useState<string | null>(null);
  const [burnKey, setBurnKey]               = useState(0);

  // Section refs for scroll-nav
  const burnRef      = useRef<HTMLDivElement>(null);
  const splRef       = useRef<HTMLDivElement>(null);
  const t22Ref       = useRef<HTMLDivElement>(null);
  const lpRef        = useRef<HTMLDivElement>(null);
  const xenBlocksRef = useRef<HTMLDivElement>(null);

  // ─── Lifecycle ───────────────────────────────
  useEffect(() => { loadXdexData(); }, []);

  useEffect(() => {
    if (publicKey && registryLoaded) loadTokens();
    else if (!publicKey) reset();
  }, [publicKey?.toBase58(), registryLoaded]);

  useEffect(() => {
    if (publicKey) checkMinerStatusAuto();
  }, [publicKey?.toBase58(), userEvmAddress]);

  // Scroll-tracking for SideNav highlight
  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.pageYOffset;
      if (scrollY < 100) { setActiveSection('top'); return; }
      const sections = [
        { id: 'xenblocks', ref: xenBlocksRef },
        { id: 'lp',        ref: lpRef        },
        { id: 't22',       ref: t22Ref       },
        { id: 'spl',       ref: splRef       },
        { id: 'burn',      ref: burnRef      },
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

  // ─── Helpers ─────────────────────────────────
  const reset = () => {
    setXntBalance(null); setBrainsToken(null);
    setSplTokens([]); setToken2022s([]); setLpTokens([]);
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
    } catch {
      setMinerStatus({ isMiner: false, blocks: 0, rank: null, isActive: false, loading: false });
    }
  };

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddress(addr);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  const handleNavigate = (section: string) => {
    if (section === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); setActiveSection('top'); return; }
    const refs: Record<string, React.RefObject<HTMLDivElement>> = {
      spl: splRef, t22: t22Ref, lp: lpRef, xenblocks: xenBlocksRef, burn: burnRef,
    };
    const target = refs[section];
    if (target?.current) {
      window.scrollTo({ top: target.current.getBoundingClientRect().top + window.pageYOffset - 100, behavior: 'smooth' });
      setActiveSection(section);
    }
  };

  // ─── Load tokens ─────────────────────────────
  const loadTokens = async () => {
    if (!publicKey) return;
    setLoading(true);
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
        ...t22Accs.map((a: any) => ({ ...a, is2022: true  })),
      ];

      const nonZero  = allAccounts.filter(acc => (acc.account.data.parsed.info.tokenAmount.uiAmount ?? 0) > 0);
      const splMints = Array.from(new Set(
        nonZero.filter((a: any) => !a.is2022).map((a: any) => a.account.data.parsed.info.mint as string),
      ));

      setLoadingLabel(`Resolving metadata for ${allAccounts.length} tokens...`);
      const metaplexCache = await batchFetchMetaplexPDAs(connection, splMints);
      const logoCache     = new Map<string, string | undefined>();

      const spl: TokenData[] = [], t2022: TokenData[] = [], lp: TokenData[] = [];
      let brains: TokenData | null = null;

      const results = await Promise.allSettled(allAccounts.map(async acc => {
        const info    = acc.account.data.parsed.info;
        const balance = info.tokenAmount.uiAmount ?? 0;
        if (balance < 0) return null;
        const mint = info.mint as string;
        const isLP = checkIsLP(mint, globalLPMints, walletLP);
        const meta = await resolveTokenMeta(connection, mint, xdexRegistry, metaplexCache, logoCache);
        return { mint, balance, decimals: info.tokenAmount.decimals, isToken2022: acc.is2022, isLP,
                 name: meta.name, symbol: meta.symbol, logoUri: meta.logoUri, metaSource: meta.metaSource };
      }));

      for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const t  = r.value;
        const td: TokenData = { mint: t.mint, balance: t.balance, decimals: t.decimals,
          isToken2022: t.isToken2022, name: t.name, symbol: t.symbol,
          logoUri: t.logoUri, metaSource: t.metaSource };
        if (t.isLP)                  lp.push(td);
        else if (t.mint === BRAINS_MINT) brains = td;
        else if (t.isToken2022)      t2022.push(td);
        else                         spl.push(td);
      }

      spl.sort((a, b) => b.balance - a.balance);
      t2022.sort((a, b) => b.balance - a.balance);
      lp.sort((a, b) => b.balance - a.balance);

      setBrainsToken(brains); setSplTokens(spl); setToken2022s(t2022); setLpTokens(lp);
    } catch (err) { console.error('[Portfolio]', err); }
    finally { setLoading(false); }
  };

  // ─── Burn handler ─────────────────────────────
  const handleBurnTokens = async () => {
    if (!publicKey || !connection) { setBurnError('Wallet not connected'); return; }
    if (!signTransaction)          { setBurnError('Wallet does not support signing transactions'); return; }

    const amount = parseFloat(burnAmount);
    if (isNaN(amount) || amount <= 0)          { setBurnError('Please enter a valid amount'); return; }
    if (!brainsToken || amount > brainsToken.balance) {
      setBurnError(`Insufficient balance. You have ${brainsToken?.balance || 0} BRAINS`); return;
    }

    setBurning(true); setBurnError(null); setBurnSuccess(null); setBurnTxSig(null);
    try {
      const signature = await burnBrainsTokens(connection, { publicKey, signTransaction }, amount);
      setBurnTxSig(signature);
      setBurnSuccess(`Successfully burned ${amount.toLocaleString()} BRAINS`);
      setBurnKey(k => k + 1);
      setBurnAmount('');
      setTimeout(() => loadTokens(), 2000);
    } catch (err: any) {
      setBurnError(err.message || 'Failed to burn tokens');
    } finally {
      setBurning(false);
    }
  };

  // ─── Derived counts ───────────────────────────
  const t22Count    = token2022s.length + (brainsToken ? 1 : 0);
  const totalTokens = 1 + splTokens.length + t22Count + lpTokens.length;

  // ─── Build walletTokens snapshot for XenBlocksPanel ───────────────────────
  const xenBlocksWalletTokens: WalletTokenSnapshot[] = [
    // Native XNT
    ...(xntBalance !== null ? [{
      mint:    'native-xnt',
      symbol:  'XNT',
      name:    'X1 Native Token',
      balance: xntBalance,
      logoUri: XNT_INFO.logoUri,
    } as WalletTokenSnapshot] : []),
    // All SPL tokens
    ...splTokens.map(t => ({
      mint:    t.mint,
      symbol:  t.symbol,
      name:    t.name,
      balance: t.balance,
      logoUri: t.logoUri,
    } as WalletTokenSnapshot)),
    // All Token-2022 tokens (XUNI, XBLK, XNM, etc. all live here)
    ...token2022s.map(t => ({
      mint:    t.mint,
      symbol:  t.symbol,
      name:    t.name,
      balance: t.balance,
      logoUri: t.logoUri,
    } as WalletTokenSnapshot)),
    // BRAINS token
    ...(brainsToken ? [{
      mint:    brainsToken.mint,
      symbol:  brainsToken.symbol,
      name:    brainsToken.name,
      balance: brainsToken.balance,
      logoUri: brainsToken.logoUri,
    } as WalletTokenSnapshot] : []),
  ];

  // ─────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: '#080c0f', padding: '90px 24px 40px', position: 'relative', overflow: 'hidden' }}>
      <TopBar />
      <PageBackground />

      {publicKey && !loading && (
        <SideNav
          activeSection={activeSection} onNavigate={handleNavigate}
          showSPL={showSPL} showT22={showT22} showLP={showLP}
          splCount={splTokens.length} t22Count={t22Count} lpCount={lpTokens.length}
          hasBrains={!!brainsToken}
        />
      )}

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 820, margin: '0 auto' }}>

        {/* ── Connected header ── */}
        {publicKey && (
          <div style={{ textAlign: 'center', marginBottom: 40, animation: 'fadeUp 0.5s ease both' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
              <div style={{ position: 'relative', width: 140, height: 140 }}>
                <div style={{ position: 'absolute', inset: -7, borderRadius: '50%', background: 'conic-gradient(from 0deg,#ff8c00,#ffb700,#00d4ff,#ff8c00)', animation: 'spin 4s linear infinite', opacity: 0.65 }} />
                <img src={BRAINS_LOGO} alt="BRAINS"
                  style={{ position: 'relative', zIndex: 1, width: 140, height: 140, borderRadius: '50%', objectFit: 'cover', border: '4px solid #0a0e14' }}
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              </div>
            </div>
            <h1 style={{ fontFamily: 'Orbitron, monospace', fontSize: 42, fontWeight: 900, letterSpacing: 7,
              background: 'linear-gradient(135deg,#ff8c00 0%,#ffb700 40%,#00d4ff 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              margin: '0 0 10px', textTransform: 'uppercase' }}>
              X1 BRAINS
            </h1>
            <p style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, letterSpacing: 5, color: '#7a9ab8', textTransform: 'uppercase' }}>
              X1 Blockchain · Portfolio Tracker
            </p>
          </div>
        )}

        {publicKey && <AddressBar address={publicKey.toBase58()} />}

        {publicKey && (
          <>
            {loading ? <Spinner label={loadingLabel} /> : (
              <div style={{ animation: 'fadeUp 0.4s ease both' }}>

                {/* ── Stats bar ── */}
                <PortfolioStatsBar
                  totalTokens={totalTokens} splCount={splTokens.length}
                  t22Count={t22Count}        lpCount={lpTokens.length}
                  xntBalance={xntBalance}
                  minerStatus={minerStatus}
                  showSPL={showSPL} onToggleSPL={() => setShowSPL(v => !v)}
                  showT22={showT22} onToggleT22={() => setShowT22(v => !v)}
                  showLP={showLP}   onToggleLP={() => setShowLP(v => !v)}
                  burnKey={burnKey}
                />

                {/* ── 1. Native XNT ── */}
                <SectionHeader label="Native Token" color="#00d4ff" />
                <TokenCard
                  token={{ mint: XNT_WRAPPED, name: 'X1 Native Token', symbol: 'XNT', balance: xntBalance ?? 0,
                    decimals: 9, isToken2022: false, metaSource: undefined, logoUri: XNT_INFO.logoUri }}
                  highlight="native" copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.05}
                />

                {/* ── 2. BRAINS token + burn panel ── */}
                {brainsToken && (
                  <div ref={burnRef}>
                  <SectionHeader label="BRAINS Token" color="#ff8c00" />
                  <TokenCard token={brainsToken} highlight="brains" copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.1} />

                  {/* Burn section */}
                  <div style={{
                    background: 'linear-gradient(135deg,rgba(255,30,30,.12),rgba(200,0,0,.08),rgba(255,30,30,.04))',
                    border: '2px solid rgba(255,30,30,.4)', borderRadius: 16,
                    padding: '24px 28px', marginTop: 16, marginBottom: 24,
                    boxShadow: '0 0 40px rgba(255,30,30,.15),inset 0 0 60px rgba(255,30,30,.03)',
                    position: 'relative', overflow: 'hidden',
                  }}>
                    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3,
                      background: 'linear-gradient(90deg,transparent,rgba(255,30,30,.8),transparent)',
                      animation: 'pulse-red 2s ease infinite' }} />

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                      <div style={{ width: 42, height: 42, borderRadius: '50%',
                        background: 'linear-gradient(135deg,rgba(255,30,30,.2),rgba(200,0,0,.3))',
                        border: '2px solid rgba(255,30,30,.6)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
                        boxShadow: '0 0 20px rgba(255,30,30,.5),inset 0 0 20px rgba(255,30,30,.2)' }}>
                        🔥
                      </div>
                      <div>
                        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 13, color: '#fff',
                          letterSpacing: 3, textTransform: 'uppercase', fontWeight: 900,
                          textShadow: '0 0 10px rgba(255,255,255,.6),0 0 20px rgba(255,255,255,.2)' }}>
                          Burn BRAINS Tokens
                        </div>
                        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#c0c0c0', letterSpacing: 1, marginTop: 2 }}>
                          Permanently destroy tokens · Reduce supply
                        </div>
                      </div>
                    </div>

                    {/* Warning */}
                    <div style={{ background: 'rgba(255,30,30,.08)', border: '1px solid rgba(255,30,30,.25)',
                      borderLeft: '4px solid #ff1a1a', borderRadius: 8, padding: '12px 16px',
                      marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>⚠️</span>
                      <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#e0e0e0', lineHeight: 1.5 }}>
                        <strong style={{ color: '#fff' }}>Warning:</strong> This action is irreversible. Burned tokens are permanently removed from circulation and cannot be recovered.
                      </span>
                    </div>

                    {/* Amount input */}
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#aaa', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
                        Amount to Burn
                      </div>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
                        <div style={{ flex: 1, position: 'relative' }}>
                          <input type="number" value={burnAmount} onChange={e => setBurnAmount(e.target.value)}
                            placeholder="0.00" disabled={burning}
                            style={{ width: '100%', padding: '14px 18px', background: 'rgba(0,0,0,.6)',
                              border: '2px solid rgba(255,30,30,.4)', borderRadius: 10,
                              fontFamily: 'Orbitron, monospace', fontSize: 18, fontWeight: 700, color: '#fff',
                              outline: 'none', transition: 'all 0.3s' }}
                            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(255,30,30,.8)'; e.currentTarget.style.background = 'rgba(255,30,30,.1)'; e.currentTarget.style.boxShadow = '0 0 0 4px rgba(255,30,30,.15),0 0 30px rgba(255,30,30,.3)'; }}
                            onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(255,30,30,.4)'; e.currentTarget.style.background = 'rgba(0,0,0,.6)'; e.currentTarget.style.boxShadow = 'none'; }}
                          />
                          <div style={{ position: 'absolute', right: 18, top: '50%', transform: 'translateY(-50%)',
                            fontFamily: 'Orbitron, monospace', fontSize: 12, color: '#aaa', fontWeight: 700 }}>
                            BRAINS
                          </div>
                        </div>
                        <button onClick={() => setBurnAmount(brainsToken.balance.toString())} disabled={burning}
                          style={{ padding: '0 20px',
                            background: 'linear-gradient(135deg,rgba(255,30,30,.25),rgba(200,0,0,.25))',
                            border: '2px solid rgba(255,30,30,.4)', borderRadius: 10,
                            fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 900,
                            color: '#fff', cursor: burning ? 'not-allowed' : 'pointer',
                            transition: 'all 0.3s', letterSpacing: 2 }}
                          onMouseEnter={e => { if (!burning) { e.currentTarget.style.background = 'linear-gradient(135deg,rgba(255,30,30,.4),rgba(200,0,0,.4))'; e.currentTarget.style.borderColor = 'rgba(255,30,30,.8)'; e.currentTarget.style.boxShadow = '0 0 20px rgba(255,30,30,.4)'; } }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(135deg,rgba(255,30,30,.25),rgba(200,0,0,.25))'; e.currentTarget.style.borderColor = 'rgba(255,30,30,.4)'; e.currentTarget.style.boxShadow = 'none'; }}>
                          MAX
                        </button>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingLeft: 4 }}>
                        <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#8aa0b8' }}>
                          Available: <span style={{ color: '#fff', fontWeight: 600 }}>{brainsToken.balance.toLocaleString()}</span> BRAINS
                        </span>
                      </div>
                    </div>

                    {/* Burn button */}
                    <button onClick={handleBurnTokens} disabled={burning || !burnAmount}
                      style={{ width: '100%', padding: '16px 0',
                        background: burning || !burnAmount
                          ? 'linear-gradient(135deg,rgba(255,30,30,.3),rgba(150,0,0,.3))'
                          : 'linear-gradient(135deg,#ff1a1a,#cc0000,#990000)',
                        border: '2px solid', borderColor: burning || !burnAmount ? 'rgba(255,30,30,.4)' : 'rgba(255,30,30,.8)',
                        borderRadius: 12, fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 900,
                        letterSpacing: 3, color: '#fff', cursor: burning || !burnAmount ? 'not-allowed' : 'pointer',
                        opacity: burning || !burnAmount ? 0.5 : 1, transition: 'all 0.3s',
                        textTransform: 'uppercase', textShadow: '0 1px 3px rgba(0,0,0,.8)',
                        boxShadow: burning || !burnAmount ? 'none' : '0 0 30px rgba(255,30,30,.4),inset 0 0 20px rgba(255,100,100,.2)',
                        position: 'relative', overflow: 'hidden' }}
                      onMouseEnter={e => { if (!burning && burnAmount) { e.currentTarget.style.boxShadow = '0 8px 30px rgba(255,30,30,.6),0 0 50px rgba(255,30,30,.5),inset 0 0 30px rgba(255,100,100,.3)'; e.currentTarget.style.transform = 'translateY(-2px)'; } }}
                      onMouseLeave={e => { e.currentTarget.style.boxShadow = burning || !burnAmount ? 'none' : '0 0 30px rgba(255,30,30,.4),inset 0 0 20px rgba(255,100,100,.2)'; e.currentTarget.style.transform = 'translateY(0)'; }}>
                      {burning ? '🔥 BURNING TOKENS...' : '🔥 EXECUTE BURN'}
                    </button>

                    {/* Error */}
                    {burnError && (
                      <div style={{ marginTop: 16, padding: '14px 18px', background: 'rgba(255,50,50,.15)',
                        border: '2px solid rgba(255,50,50,.4)', borderLeft: '4px solid #ff3333',
                        borderRadius: 8, display: 'flex', alignItems: 'flex-start', gap: 12,
                        boxShadow: '0 0 20px rgba(255,30,30,.2)' }}>
                        <span style={{ fontSize: 18, flexShrink: 0 }}>❌</span>
                        <div>
                          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#fff', fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>BURN FAILED</div>
                          <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#ddd', lineHeight: 1.4 }}>{burnError}</div>
                        </div>
                      </div>
                    )}

                    {/* Success + Explorer link */}
                    {burnSuccess && burnTxSig && (
                      <div style={{
                        marginTop: 16,
                        background: 'linear-gradient(135deg,rgba(0,255,136,.10),rgba(0,180,90,.07))',
                        border: '2px solid rgba(0,255,136,.35)',
                        borderLeft: '4px solid #00ff88',
                        borderRadius: 10,
                        overflow: 'hidden',
                        boxShadow: '0 0 30px rgba(0,255,136,.15)',
                      }}>
                        <div style={{ padding: '14px 18px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 18, flexShrink: 0 }}>✅</span>
                          <div>
                            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#00ff88', fontWeight: 700, letterSpacing: 1.5 }}>
                              BURN CONFIRMED
                            </div>
                            <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 12, color: '#c8e8d0', marginTop: 3 }}>
                              {burnSuccess} · Permanently removed from supply
                            </div>
                          </div>
                        </div>
                        <div style={{ padding: '10px 18px', background: 'rgba(0,0,0,.25)', borderTop: '1px solid rgba(0,255,136,.15)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#4a8060', letterSpacing: 1.5, flexShrink: 0 }}>TX SIG</span>
                          <code style={{ fontFamily: 'monospace', fontSize: 10, color: '#7ad4a8', flex: 1, wordBreak: 'break-all', lineHeight: 1.4 }}>
                            {burnTxSig}
                          </code>
                        </div>
                        <div style={{ padding: '10px 18px 14px' }}>
                          <a
                            href={`https://explorer.mainnet.x1.xyz/tx/${burnTxSig}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 8,
                              padding: '9px 18px',
                              background: 'linear-gradient(135deg,rgba(0,255,136,.18),rgba(0,180,90,.15))',
                              border: '1px solid rgba(0,255,136,.45)', borderRadius: 8,
                              textDecoration: 'none',
                              fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700,
                              letterSpacing: 1.5, color: '#00ff88', textTransform: 'uppercase',
                              transition: 'all 0.2s', boxShadow: '0 0 14px rgba(0,255,136,.2)',
                            }}
                            onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'linear-gradient(135deg,rgba(0,255,136,.28),rgba(0,200,110,.22))'; (e.currentTarget as HTMLAnchorElement).style.boxShadow = '0 0 24px rgba(0,255,136,.4)'; (e.currentTarget as HTMLAnchorElement).style.transform = 'translateY(-1px)'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'linear-gradient(135deg,rgba(0,255,136,.18),rgba(0,180,90,.15))'; (e.currentTarget as HTMLAnchorElement).style.boxShadow = '0 0 14px rgba(0,255,136,.2)'; (e.currentTarget as HTMLAnchorElement).style.transform = 'translateY(0)'; }}
                          >
                            <span style={{ fontSize: 13 }}>🔍</span>
                            View on X1 Explorer
                            <span style={{ fontSize: 11, opacity: 0.75 }}>↗</span>
                          </a>
                          <span style={{ marginLeft: 14, fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#4a7060' }}>
                            Opens in new tab · Full transaction details &amp; burn confirmation
                          </span>
                        </div>
                      </div>
                    )}

                    <style>{`@keyframes pulse-red { 0%,100%{opacity:.6} 50%{opacity:1} }`}</style>
                  </div>
                  </div>
                )}

                {/* ── 3. SPL Tokens ── */}
                {showSPL && (() => {
                  const visible = splTokens.filter(t => t.metaSource !== 'fallback' && (!hideZeroBalance || t.balance > 0));
                  const hidden  = splTokens.filter(t => t.metaSource !== 'fallback' && t.balance <= 0).length;
                  return visible.length > 0 ? (
                    <div ref={splRef}>
                      <SectionHeader label="SPL Tokens" count={visible.length} color="#ff8c00" hiddenCount={hideZeroBalance ? hidden : 0} />
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: -10, marginBottom: 14, gap: 12 }}>
                        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#6a8ea8', letterSpacing: 2, textTransform: 'uppercase' }}>Hide Zero Balance</span>
                        <button onClick={() => setHideZeroBalance(v => !v)}
                          style={{ position: 'relative', width: 50, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer', outline: 'none', flexShrink: 0, transition: 'all 0.25s',
                            background: hideZeroBalance ? 'linear-gradient(135deg,#ff8c00,#ffb700)' : 'rgba(255,255,255,.1)',
                            boxShadow: hideZeroBalance ? '0 0 10px rgba(255,140,0,.4)' : 'none' }}>
                          <span style={{ position: 'absolute', top: 4, left: hideZeroBalance ? 25 : 4, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.25s', boxShadow: '0 1px 4px rgba(0,0,0,.4)' }} />
                        </button>
                      </div>
                      {visible.map((t, i) => <TokenCard key={t.mint} token={t} copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.04 * i} />)}
                    </div>
                  ) : null;
                })()}

                {/* ── 4. Token-2022 ── */}
                {showT22 && (() => {
                  const visible = token2022s.filter(t => !hideZeroBalance || t.balance > 0);
                  const hidden  = token2022s.filter(t => t.balance <= 0).length;
                  return (brainsToken || token2022s.length > 0) ? (
                    <div ref={t22Ref}>
                      <SectionHeader label="Token-2022 Extensions" count={(brainsToken ? 1 : 0) + visible.length} color="#ffb700" hiddenCount={hideZeroBalance ? hidden : 0} />
                      {brainsToken && <TokenCard token={brainsToken} highlight="brains" copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.05} />}
                      {visible.map((t, i) => <TokenCard key={t.mint} token={t} copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.04 * (i + 1)} />)}
                    </div>
                  ) : null;
                })()}

                {/* ── 5. LP Tokens ── */}
                {showLP && lpTokens.length > 0 && (
                  <div ref={lpRef}>
                    <SectionHeader label="LP Tokens" count={lpTokens.length} color="#00c98d" />
                    {lpTokens.map((t, i) => <TokenCard key={t.mint} token={t} copiedAddress={copiedAddress} onCopy={copyAddress} animDelay={0.04 * i} isLP={true} />)}
                  </div>
                )}

                {/* ── XenBlocks ── */}
                {publicKey && connection && (
                  <div ref={xenBlocksRef}>
                    <SectionHeader label="XenBlocks Mining" color="#bf5af2" />

                    <div style={{ background: 'linear-gradient(135deg,rgba(191,90,242,.06),rgba(191,90,242,.02))',
                      border: '1px solid rgba(191,90,242,.2)', borderRadius: 14, padding: '20px 24px', marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                        <span style={{ fontSize: 16 }}>🔗</span>
                        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, color: '#bf5af2', letterSpacing: 2, textTransform: 'uppercase' }}>
                          Manual EVM Address Lookup
                        </span>
                      </div>
                      <p style={{ fontFamily: 'Sora, sans-serif', fontSize: 12, color: '#7a9ab8', lineHeight: 1.6, marginBottom: 16 }}>
                        If your miner stats aren't showing automatically, enter your EVM mining address below (starts with 0x...) to manually fetch your XenBlocks statistics.
                      </p>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', flexWrap: 'wrap' }}>
                        <input type="text" value={userEvmAddress} onChange={e => setUserEvmAddress(e.target.value)}
                          placeholder="0x1234...abcd (Enter your EVM mining address)"
                          style={{ flex: 1, minWidth: 300, padding: '12px 16px', background: 'rgba(0,0,0,.4)',
                            border: '1px solid rgba(191,90,242,.3)', borderRadius: 8,
                            fontFamily: 'monospace', fontSize: 12, color: '#bf5af2', outline: 'none', transition: 'all 0.2s' }}
                          onFocus={e => { e.currentTarget.style.borderColor = 'rgba(191,90,242,.6)'; e.currentTarget.style.background = 'rgba(191,90,242,.08)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(191,90,242,.1)'; }}
                          onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(191,90,242,.3)'; e.currentTarget.style.background = 'rgba(0,0,0,.4)'; e.currentTarget.style.boxShadow = 'none'; }}
                        />
                        <button onClick={checkMinerStatusAuto} disabled={minerStatus.loading}
                          style={{ padding: '12px 24px',
                            background: minerStatus.loading ? 'rgba(191,90,242,.3)' : 'linear-gradient(135deg,#bf5af2,#9f4ad2)',
                            border: 'none', borderRadius: 8, fontFamily: 'Orbitron, monospace', fontSize: 11,
                            fontWeight: 700, letterSpacing: 1.5, color: '#fff',
                            cursor: minerStatus.loading ? 'not-allowed' : 'pointer',
                            opacity: minerStatus.loading ? 0.6 : 1, transition: 'all 0.2s',
                            flexShrink: 0, textTransform: 'uppercase' }}
                          onMouseEnter={e => { if (!minerStatus.loading) { e.currentTarget.style.boxShadow = '0 6px 20px rgba(191,90,242,.5)'; e.currentTarget.style.transform = 'translateY(-2px)'; } }}
                          onMouseLeave={e => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'translateY(0)'; }}>
                          {minerStatus.loading ? '⟳ Checking...' : '🔍 Lookup Stats'}
                        </button>
                      </div>

                      {userEvmAddress && (
                        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(191,90,242,.08)',
                          border: '1px solid rgba(191,90,242,.2)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12 }}>ℹ️</span>
                          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#bf5af2' }}>
                            Using manual EVM address: <code style={{ fontFamily: 'monospace', color: '#00d4ff' }}>{userEvmAddress}</code>
                          </span>
                        </div>
                      )}

                      {minerStatus.isMiner && (
                        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(0,255,136,.08)',
                          border: '1px solid rgba(0,255,136,.2)', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 12 }}>✅</span>
                          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#00ff88' }}>
                            Miner detected! Stats updated in the status bar above.
                          </span>
                        </div>
                      )}
                    </div>

                    {/* ── XenBlocksPanel with full wallet token snapshot ── */}
                    <XenBlocksPanel
                      walletAddress={publicKey.toBase58()}
                      connection={connection}
                      evmAddress={userEvmAddress || undefined}
                      walletTokens={xenBlocksWalletTokens}
                    />
                  </div>
                )}

                {/* ── Refresh ── */}
                <button onClick={loadTokens}
                  style={{ width: '100%', marginTop: 32, padding: '16px 0',
                    background: 'linear-gradient(135deg,#ff8c00,#ffb700)', border: 'none', borderRadius: 12,
                    fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 700, letterSpacing: 3,
                    color: '#0a0e14', cursor: 'pointer', textTransform: 'uppercase', transition: 'all 0.2s' }}
                  onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'translateY(-2px)'; b.style.boxShadow = '0 8px 28px rgba(255,140,0,.45)'; }}
                  onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'translateY(0)'; b.style.boxShadow = 'none'; }}>
                  ⟳ &nbsp;Refresh Balances
                </button>

                <PipelineBar text="METADATA: T-2022 EXT → METAPLEX PDA (X1 RPC) → XDEX REGISTRY" />
              </div>
            )}
          </>
        )}

        {/* ── Not connected ── */}
        {!publicKey && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 140px)', animation: 'fadeUp 0.6s ease both' }}>
            <div style={{ position: 'relative', marginBottom: 48 }}>
              <div style={{ position: 'absolute', inset: -50, borderRadius: '50%', background: 'radial-gradient(circle,rgba(255,140,0,.2) 0%,transparent 70%)', animation: 'pulse-orange 3s ease infinite' }} />
              <div style={{ position: 'relative', width: 180, height: 180 }}>
                <div style={{ position: 'absolute', inset: -7, borderRadius: '50%', background: 'conic-gradient(from 0deg,#ff8c00,#ffb700,#00d4ff,#ff8c00)', animation: 'spin 6s linear infinite', opacity: 0.65 }} />
                <img src={BRAINS_LOGO} alt="X1 Brains"
                  style={{ position: 'relative', zIndex: 1, width: 180, height: 180, borderRadius: '50%', objectFit: 'cover', border: '4px solid #0a0e14' }}
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              </div>
            </div>
            <h1 style={{ fontFamily: 'Orbitron, monospace', fontSize: 56, fontWeight: 900, letterSpacing: 9,
              background: 'linear-gradient(135deg,#ff8c00 0%,#ffb700 45%,#00d4ff 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              margin: '0 0 16px', textTransform: 'uppercase', textAlign: 'center' }}>
              X1 BRAINS
            </h1>
            <p style={{ fontFamily: 'Orbitron, monospace', fontSize: 13, letterSpacing: 6, color: '#7a9ab8', textTransform: 'uppercase', marginBottom: 56, textAlign: 'center' }}>
              X1 Blockchain · Portfolio Tracker
            </p>
            <div style={{ width: 260, height: 1, background: 'linear-gradient(to right,transparent,#ff8c0080,transparent)', marginBottom: 48 }} />
            <p style={{ fontFamily: 'Sora, sans-serif', fontSize: 16, color: '#7a9ab8', marginBottom: 32, textAlign: 'center', letterSpacing: 0.5 }}>
              Connect your wallet to view your X1 portfolio
            </p>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 12, color: '#7a9ab8', padding: '14px 24px', letterSpacing: 3, border: '1px solid #1e3050', borderRadius: 12, background: 'rgba(255,140,0,.04)' }}>
              USE CONNECT BUTTON ↗
            </div>
          </div>
        )}

        <Footer />
      </div>
    </div>
  );
};

export default Portfolio;

// ── Global animations ──
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse-green {
      0%,100%{ opacity:1; box-shadow:0 0 12px rgba(0,255,136,.8),0 0 24px rgba(0,255,136,.4); }
      50%    { opacity:.7; box-shadow:0 0 20px rgba(0,255,136,1),0 0 40px rgba(0,255,136,.6);  }
    }
  `;
  if (!document.head.querySelector('style[data-portfolio-animations]')) {
    style.setAttribute('data-portfolio-animations', 'true');
    document.head.appendChild(style);
  }
}