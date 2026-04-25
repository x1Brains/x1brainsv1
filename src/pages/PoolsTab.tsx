// src/pages/PoolsTab.tsx
// X1 Brains Lab Work — LP Pools Tab
// Shows all pools created by the brains_pairing program.
// Allows deposit, withdraw, and swap directly via XDEX CP-Swap CPI.
// Used as a tab inside PairingMarketplace.tsx

import React, { FC, useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey, Transaction, TransactionInstruction,
  SystemProgram, Connection,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

// ─── Constants ────────────────────────────────────────────────────────────────
const RPC             = 'https://rpc.mainnet.x1.xyz';
const PROGRAM_ID      = 'DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM';
const XDEX_PROGRAM    = 'sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN';
const XDEX_LP_AUTH    = '9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU';
const XDEX_MEMO       = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const XDEX_BASE       = '/api/xdex-price/api';
const WXNT_MINT       = 'So11111111111111111111111111111111111111112';

// XDEX Anchor discriminators (sha256("global:<name>")[0..8])
async function disc(name: string): Promise<Buffer> {
  const h = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${name}`));
  return Buffer.from(new Uint8Array(h).slice(0, 8));
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface PoolRecord {
  pda:        string;
  poolAddr:   string;  // XDEX pool state address
  lpMint:     string;
  tokenAMint: string;
  tokenBMint: string;
  burnBps:    number;
  lpBurned:   bigint;
  lpTreasury: bigint;
  lpUserA:    bigint;
  lpUserB:    bigint;
  creatorA:   string;
  creatorB:   string;
  createdAt:  number;
  seeded:     boolean;
}

interface PoolState {
  ammConfig:    string;
  token0Vault:  string;
  token1Vault:  string;
  lpMint:       string;
  token0Mint:   string;
  token1Mint:   string;
  token0Prog:   string;
  token1Prog:   string;
  obsKey:       string;
  authBump:     number;
  status:       number;
  lpDecimals:   number;
  dec0:         number;
  dec1:         number;
  lpSupply:     bigint;
}

interface PoolView extends PoolRecord {
  state?:       PoolState;
  vault0Bal:    bigint;
  vault1Bal:    bigint;
  sym0:         string;
  sym1:         string;
  logo0?:       string;
  logo1?:       string;
  tvlUsd:       number;
  price0:       number;
  price1:       number;
  lpPrice:      number;
  walletLp:     bigint;
  lpDecimals:   number;
  dec0:         number;  // resolved decimals for token0
  dec1:         number;  // resolved decimals for token1
  loading:      boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function b58(buf: Uint8Array): string {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let res = '';
  while (n > 0n) { const r = n % 58n; res = ALPHA[Number(r)] + res; n = n / 58n; }
  return '1'.repeat(buf.findIndex(b => b !== 0) === -1 ? 0 : buf.findIndex(b => b !== 0) > 0 ? 0 : 0) + res;
}

function readPubkey(d: Uint8Array, o: number): string {
  return new PublicKey(d.slice(o, o + 32)).toBase58();
}
function readU64(d: Uint8Array, o: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset + o, 8);
  return v.getBigUint64(0, true);
}
function readU16(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset + o, 2).getUint16(0, true);
}

function fmtNum(v: number, dec = 2): string {
  if (!v) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(dec)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(dec)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: dec });
}
function fmtUSD(v: number): string {
  if (!v) return '$0.00';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(2)}K`;
  if (v >= 1)         return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}
function truncAddr(a: string): string { return `${a.slice(0, 4)}…${a.slice(-4)}`; }

// ─── Copy-to-clipboard button ─────────────────────────────────────────────────
const CopyButton: FC<{ text: string; size?: number }> = ({ text, size = 11 }) => {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button onClick={handleCopy} title={copied ? 'Copied!' : 'Copy address'} style={{
      background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px',
      color: copied ? '#00c98d' : '#3a5a6a', fontSize: size,
      lineHeight: 1, borderRadius: 4, flexShrink: 0,
      transition: 'color .15s',
    }}>
      {copied ? '✓' : '⎘'}
    </button>
  );
};
function useIsMobile(): boolean {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

// ─── RPC helpers ──────────────────────────────────────────────────────────────
async function rpcCall(method: string, params: any[]): Promise<any> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function getTokenProgram(mint: PublicKey, connection: Connection): Promise<PublicKey> {
  try {
    const info = await connection.getAccountInfo(mint);
    if (info?.owner?.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  } catch {}
  return TOKEN_PROGRAM_ID;
}

// ─── Token metadata — 3-layer system (same as PairingMarketplace) ─────────────
interface TokenMeta { symbol: string; name: string; logo?: string; decimals: number; }
const _metaCache = new Map<string, TokenMeta>();

async function fetchToken2022Meta(mint: string): Promise<TokenMeta | null> {
  try {
    const conn = new Connection(RPC, 'confirmed');
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const parsed = (info?.value?.data as any)?.parsed?.info;
    if (!parsed) return null;
    const decimals = parsed.decimals ?? 9;
    const extensions = parsed.extensions as any[] | undefined;
    if (!extensions) return null;
    const metaExt = extensions.find((e: any) => e.extension === 'tokenMetadata');
    if (!metaExt?.state) return null;
    const { name, symbol, uri } = metaExt.state;
    if (!symbol && !name) return null;
    let logo: string | undefined;
    if (uri) {
      try { const j = await (await fetch(uri, { signal: AbortSignal.timeout(5000) })).json(); logo = j?.image || j?.logo; } catch {}
    }
    return { symbol: symbol || mint.slice(0,6), name: name || mint.slice(0,6), logo, decimals };
  } catch { return null; }
}

async function fetchMetaplexMeta(mint: string): Promise<TokenMeta | null> {
  try {
    const META = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), META.toBuffer(), new PublicKey(mint).toBuffer()], META
    );
    const conn = new Connection(RPC, 'confirmed');
    const info = await conn.getParsedAccountInfo(pda);
    if (!info?.value) return null;
    const data = info.value.data as Buffer;
    if (!Buffer.isBuffer(data) || data.length < 1) return null;
    let offset = 1 + 32 + 32;
    const nameLen = data.readUInt32LE(offset); offset += 4;
    const name = data.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g,'').trim(); offset += nameLen;
    const symLen = data.readUInt32LE(offset); offset += 4;
    const symbol = data.slice(offset, offset + symLen).toString('utf8').replace(/\0/g,'').trim(); offset += symLen;
    const uriLen = data.readUInt32LE(offset); offset += 4;
    const uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g,'').trim();
    if (!symbol && !name) return null;
    let logo: string | undefined;
    if (uri) {
      try { const j = await (await fetch(uri, { signal: AbortSignal.timeout(5000) })).json(); logo = j?.image || j?.logo; } catch {}
    }
    const mintInfo = await conn.getParsedAccountInfo(new PublicKey(mint));
    const decimals = (mintInfo?.value?.data as any)?.parsed?.info?.decimals ?? 9;
    return { symbol: symbol || mint.slice(0,6), name: name || mint.slice(0,6), logo, decimals };
  } catch { return null; }
}

async function fetchXdexMeta(mint: string): Promise<TokenMeta | null> {
  try {
    const r = await fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${mint}`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    if (j.success && j.data) return { symbol: j.data.symbol || mint.slice(0,6), name: j.data.name || mint.slice(0,6), logo: j.data.logo || j.data.logoUri, decimals: j.data.decimals ?? 9 };
  } catch {}
  return null;
}

// ─── Hardcoded symbol/decimal overrides — always win over on-chain fetch ───────
// Logo is still fetched from Token-2022 metadata URI in the background.
const KNOWN_META: Record<string, { symbol: string; name: string; decimals: number }> = {
  'So11111111111111111111111111111111111111112':     { symbol: 'XNT',    name: 'X1 Native Token',  decimals: 9 },
  'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN': { symbol: 'BRAINS', name: 'X1 Brains',        decimals: 9 },
  'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6': { symbol: 'LB',     name: 'Lab Work',         decimals: 2 },
  'XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m':  { symbol: 'XNM',    name: 'Xenblocks Mining',  decimals: 9 },
  'XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm':  { symbol: 'XUNI',   name: 'Xenblocks Uni',     decimals: 9 },
  'XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T':  { symbol: 'XBLK',   name: 'Xenblocks',         decimals: 9 },
};

async function fetchTokenMeta(mint: string): Promise<TokenMeta> {
  // Return from cache if we already have a logo — fully resolved
  const cached = _metaCache.get(mint);
  if (cached?.logo) return cached;

  const known = KNOWN_META[mint];

  // For known tokens: seed cache with correct symbol immediately, then fetch logo
  if (known && !cached) {
    _metaCache.set(mint, { ...known }); // no logo yet — will be filled below
  }

  // Always attempt full metadata fetch to get the logo
  const t22 = await fetchToken2022Meta(mint);
  if (t22) {
    // Merge: keep known symbol/decimals if available, use fetched logo
    const merged: TokenMeta = known
      ? { ...known, logo: t22.logo }
      : t22;
    _metaCache.set(mint, merged);
    return merged;
  }
  const mpx = await fetchMetaplexMeta(mint);
  if (mpx) {
    const merged: TokenMeta = known ? { ...known, logo: mpx.logo } : mpx;
    _metaCache.set(mint, merged);
    return merged;
  }
  const xdex = await fetchXdexMeta(mint);
  if (xdex) {
    const merged: TokenMeta = known ? { ...known, logo: xdex.logo } : xdex;
    _metaCache.set(mint, merged);
    return merged;
  }

  // Fallback — use known if available, otherwise truncate address
  const fallback: TokenMeta = known
    ? { ...known }
    : { symbol: mint.slice(0,4).toUpperCase(), name: mint.slice(0,8), decimals: 9 };
  _metaCache.set(mint, fallback);
  return fallback;
}

// ─── On-chain data fetchers ───────────────────────────────────────────────────
async function fetchPoolRecords(): Promise<PoolRecord[]> {
  const res = await rpcCall('getProgramAccounts', [PROGRAM_ID, {
    encoding: 'base64',
    filters: [{ dataSize: 282 }],
  }]);
  return (res || []).map((a: any) => {
    const d = new Uint8Array(Buffer.from(a.account.data[0], 'base64'));
    const D = 8;
    return {
      pda:        a.pubkey,
      poolAddr:   readPubkey(d, D),
      lpMint:     readPubkey(d, D + 32),
      tokenAMint: readPubkey(d, D + 64),
      tokenBMint: readPubkey(d, D + 96),
      burnBps:    readU16(d, D + 152),
      lpBurned:   readU64(d, D + 154),
      lpTreasury: readU64(d, D + 162),
      lpUserA:    readU64(d, D + 170),
      lpUserB:    readU64(d, D + 178),
      creatorA:   readPubkey(d, D + 186),
      creatorB:   readPubkey(d, D + 218),
      // Note: bytes 250..258 used to hold a `usd_val` field. Either the on-chain
      // program no longer populates it, or its layout shifted — reading it back
      // now produces garbage. Removed from this parser to avoid misuse.
      // TVL is now computed exclusively from XDEX vault reserves × token prices.
      createdAt:  Number(readU64(d, D + 258)),  // i64 but safe as number for timestamps
      seeded:     d[D + 266] === 1,
    };
  });
}

async function fetchXdexPoolState(poolAddr: string): Promise<PoolState | null> {
  try {
    const res = await rpcCall('getAccountInfo', [poolAddr, { encoding: 'base64' }]);
    if (!res?.value) return null;
    const d = new Uint8Array(Buffer.from(res.value.data[0], 'base64'));
    const D = 8;
    return {
      ammConfig:   readPubkey(d, D),
      token0Vault: readPubkey(d, D + 64),
      token1Vault: readPubkey(d, D + 96),
      lpMint:      readPubkey(d, D + 128),
      token0Mint:  readPubkey(d, D + 160),
      token1Mint:  readPubkey(d, D + 192),
      token0Prog:  readPubkey(d, D + 224),
      token1Prog:  readPubkey(d, D + 256),
      obsKey:      readPubkey(d, D + 288),
      authBump:    d[D + 328],
      status:      d[D + 329],
      lpDecimals:  d[D + 330],
      dec0:        d[D + 331],
      dec1:        d[D + 332],
      lpSupply:    readU64(d, D + 333),
    };
  } catch { return null; }
}

async function fetchVaultBalance(vault: string): Promise<bigint> {
  try {
    const res = await rpcCall('getAccountInfo', [vault, { encoding: 'base64' }]);
    if (!res?.value) return 0n;
    const d = new Uint8Array(Buffer.from(res.value.data[0], 'base64'));
    return readU64(d, 64);
  } catch { return 0n; }
}

async function fetchWalletLpBalance(lpMint: string, wallet: string): Promise<bigint> {
  try {
    const res = await rpcCall('getTokenAccountsByOwner', [
      wallet,
      { mint: lpMint },
      { encoding: 'base64' },
    ]);
    if (!res?.value?.length) return 0n;
    // Sum all accounts for this mint (should only be one)
    let total = 0n;
    for (const acc of res.value) {
      const d = new Uint8Array(Buffer.from(acc.account.data[0], 'base64'));
      total += readU64(d, 64);
    }
    return total;
  } catch { return 0n; }
}

// Constant product AMM quote: given amountIn, reserves, fee in bps
function cpSwapQuote(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 2500n): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const amtInWithFee = amountIn * (1_000_000n - feeBps) / 1_000_000n;
  return amtInWithFee * reserveOut / (reserveIn + amtInWithFee);
}

// ─── Status Box ───────────────────────────────────────────────────────────────
const StatusBox: FC<{ msg: string }> = ({ msg }) => {
  if (!msg) return null;
  const isErr = msg.startsWith('❌');
  const isOk  = msg.startsWith('✅');
  return (
    <div style={{
      margin: '12px 0', padding: '10px 14px', borderRadius: 10, fontSize: 12,
      fontFamily: 'Sora,sans-serif', lineHeight: 1.6, whiteSpace: 'pre-wrap',
      background: isErr ? 'rgba(255,68,68,.08)' : isOk ? 'rgba(0,201,141,.08)' : 'rgba(255,255,255,.04)',
      border: `1px solid ${isErr ? 'rgba(255,68,68,.25)' : isOk ? 'rgba(0,201,141,.25)' : 'rgba(255,255,255,.08)'}`,
      color: isErr ? '#ff8888' : isOk ? '#00c98d' : '#9abacf',
    }}>{msg}</div>
  );
};

// ─── Token Logo ───────────────────────────────────────────────────────────────
const TokenLogo: FC<{ logo?: string; symbol: string; size?: number }> = ({ logo, symbol, size = 32 }) => (
  <div style={{
    width: size, height: size, borderRadius: '50%', overflow: 'hidden',
    background: 'rgba(0,212,255,.12)', border: '1px solid rgba(0,212,255,.2)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  }}>
    {logo
      ? <img src={logo} alt={symbol} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      : <span style={{ fontSize: size * 0.35, fontWeight: 900, color: '#00d4ff', fontFamily: 'Orbitron,monospace' }}>{symbol.slice(0, 2)}</span>
    }
  </div>
);

// ─── Withdraw Modal ───────────────────────────────────────────────────────────
const WithdrawModal: FC<{
  pool: PoolView;
  isMobile: boolean;
  publicKey: PublicKey;
  connection: Connection;
  signTransaction: any;
  onClose: () => void;
  onDone: () => void;
}> = ({ pool, isMobile, publicKey, connection, signTransaction, onClose, onDone }) => {
  const [pct, setPct]       = useState(100);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [txSig, setTxSig]   = useState('');

  const lpDecimals = pool.lpDecimals || 9;
  const lpUi       = Number(pool.walletLp) / Math.pow(10, lpDecimals);
  const lpToRemove = BigInt(Math.floor(Number(pool.walletLp) * pct / 100));

  // Estimate tokens out
  const supply = pool.state?.lpSupply || 1n;
  const share  = supply > 0n ? lpToRemove * 10_000n / supply : 0n;
  const est0   = pool.vault0Bal * share / 10_000n;
  const est1   = pool.vault1Bal * share / 10_000n;
  const dec0   = pool.dec0 || 9;
  const dec1   = pool.dec1 || 9;

  const handleWithdraw = async () => {
    if (!pool.state || lpToRemove === 0n) return;
    // Safety: prevent withdraw if wallet has no LP
    if (pool.walletLp === 0n) {
      setStatus('❌ You have no LP tokens in this pool.');
      return;
    }
    setPending(true); setStatus('Building withdraw transaction…');
    try {
      const programPk  = new PublicKey(XDEX_PROGRAM);
      const authorityPk = new PublicKey(XDEX_LP_AUTH);
      const poolStatePk = new PublicKey(pool.poolAddr);
      const lpMintPk    = new PublicKey(pool.lpMint);
      const t0Prog      = new PublicKey(pool.state.token0Prog);
      const t1Prog      = new PublicKey(pool.state.token1Prog);
      const mint0Pk     = new PublicKey(pool.state.token0Mint);
      const mint1Pk     = new PublicKey(pool.state.token1Mint);

      const ownerLpAta  = getAssociatedTokenAddressSync(lpMintPk, publicKey, false, TOKEN_PROGRAM_ID);
      const token0Ata   = getAssociatedTokenAddressSync(mint0Pk, publicKey, false, t0Prog);
      const token1Ata   = getAssociatedTokenAddressSync(mint1Pk, publicKey, false, t1Prog);

      // Discriminator for withdraw
      const d = await disc('withdraw');
      const data = Buffer.alloc(8 + 8 + 8 + 8);
      d.copy(data, 0);
      data.writeBigUInt64LE(lpToRemove, 8);
      data.writeBigUInt64LE(0n, 16); // min token0 — 0 slippage check (user sees estimate)
      data.writeBigUInt64LE(0n, 24); // min token1

      const keys = [
        { pubkey: publicKey,                        isSigner: true,  isWritable: false },
        { pubkey: authorityPk,                      isSigner: false, isWritable: false },
        { pubkey: poolStatePk,                      isSigner: false, isWritable: true  },
        { pubkey: ownerLpAta,                       isSigner: false, isWritable: true  },
        { pubkey: token0Ata,                        isSigner: false, isWritable: true  },
        { pubkey: token1Ata,                        isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(pool.state.token0Vault), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(pool.state.token1Vault), isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID,                 isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID,            isSigner: false, isWritable: false },
        { pubkey: mint0Pk,                          isSigner: false, isWritable: false },
        { pubkey: mint1Pk,                          isSigner: false, isWritable: false },
        { pubkey: lpMintPk,                         isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(XDEX_MEMO),         isSigner: false, isWritable: false },
      ];

      const ix = new TransactionInstruction({ programId: programPk, keys, data });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });

      // Create ATAs if needed
      const [i0, i1] = await Promise.all([
        connection.getAccountInfo(token0Ata),
        connection.getAccountInfo(token1Ata),
      ]);
      if (!i0) tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, token0Ata, publicKey, mint0Pk, t0Prog));
      if (!i1) tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, token1Ata, publicKey, mint1Pk, t1Prog));
      tx.add(ix);

      setStatus('Waiting for wallet approval…');
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setStatus('Confirming…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error(JSON.stringify(st.value.err));
        if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') {
          setStatus(`✅ Withdrawn!`);
          setTxSig(sig);
          setTimeout(() => { onDone(); onClose(); }, 3000);
          return;
        }
      }
      throw new Error('Confirmation timeout');
    } catch (e: any) {
      setStatus('❌ ' + (e?.message ?? String(e)).slice(0, 200));
    } finally { setPending(false); }
  };

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.88)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 420,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(0,212,255,.15)', borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '20px 16px 28px' : '24px 26px',
        maxHeight: isMobile ? '88vh' : 'calc(100vh - 32px)', overflowY: 'auto',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, width: 28, height: 28,
          borderRadius: '50%', border: '1px solid rgba(255,255,255,.12)', background: 'rgba(8,12,15,.9)',
          cursor: 'pointer', color: '#6a8aaa', fontSize: 16 }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 16, fontWeight: 900, color: '#fff', marginBottom: 4 }}>
          💧 REMOVE LIQUIDITY
        </div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', marginBottom: 20 }}>
          {pool.sym0} / {pool.sym1} pool
        </div>

        {/* LP balance */}
        <div style={{ background: 'rgba(0,212,255,.04)', border: '1px solid rgba(0,212,255,.12)',
          borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a', letterSpacing: 1, marginBottom: 6 }}>YOUR LP BALANCE</div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18, fontWeight: 900, color: '#00d4ff' }}>
            {lpUi.toFixed(4)} LP
          </div>
        </div>

        {/* Slider */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a' }}>AMOUNT TO REMOVE</span>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900, color: '#00d4ff' }}>{pct}%</span>
          </div>
          <input type="range" min={1} max={100} value={pct} onChange={e => setPct(Number(e.target.value))}
            style={{ width: '100%', accentColor: '#00d4ff', cursor: 'pointer' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {[25, 50, 75, 100].map(p => (
              <button key={p} onClick={() => setPct(p)} style={{
                flex: 1, padding: '6px 0', borderRadius: 8, cursor: 'pointer', fontSize: 10,
                fontFamily: 'Orbitron,monospace', fontWeight: 700,
                background: pct === p ? 'rgba(0,212,255,.15)' : 'rgba(255,255,255,.04)',
                border: `1px solid ${pct === p ? 'rgba(0,212,255,.4)' : 'rgba(255,255,255,.08)'}`,
                color: pct === p ? '#00d4ff' : '#6a8aaa',
              }}>{p}%</button>
            ))}
          </div>
        </div>

        {/* Estimates */}
        <div style={{ background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
          borderRadius: 12, padding: 14, marginBottom: 16 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a', marginBottom: 10 }}>YOU WILL RECEIVE (ESTIMATE)</div>
          {[
            { sym: pool.sym0, amt: Number(est0) / Math.pow(10, dec0) },
            { sym: pool.sym1, amt: Number(est1) / Math.pow(10, dec1) },
          ].map(r => (
            <div key={r.sym} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0',
              borderTop: '1px solid rgba(255,255,255,.04)' }}>
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#9abacf' }}>{r.sym}</span>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700, color: '#e0f0ff' }}>
                {fmtNum(r.amt, 4)}
              </span>
            </div>
          ))}
        </div>

        <StatusBox msg={status} />
        {txSig && (
          <a href={`https://explorer.mainnet.x1.xyz/tx/${txSig}`} target="_blank" rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              width: '100%', padding: '10px 0', borderRadius: 10, marginBottom: 10, textDecoration: 'none',
              background: 'rgba(0,201,141,.08)', border: '1px solid rgba(0,201,141,.25)',
              fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700, color: '#00c98d',
              boxSizing: 'border-box' as const }}>
            🔍 VIEW ON EXPLORER · {txSig.slice(0,8)}…{txSig.slice(-6)}
          </a>
        )}
        <button onClick={handleWithdraw} disabled={pending || lpToRemove === 0n} style={{
          width: '100%', padding: '14px 0', borderRadius: 12,
          cursor: pending ? 'not-allowed' : 'pointer',
          background: pending ? 'rgba(255,255,255,.04)' : 'linear-gradient(135deg,rgba(0,212,255,.2),rgba(0,212,255,.06))',
          border: `1px solid ${pending ? 'rgba(255,255,255,.08)' : 'rgba(0,212,255,.45)'}`,
          fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
          color: pending ? '#4a6a8a' : '#00d4ff',
        }}>
          {pending ? 'PROCESSING…' : `WITHDRAW ${pct}% LP`}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ─── Deposit Modal ─────────────────────────────────────────────────────────────
const DepositModal: FC<{
  pool: PoolView;
  isMobile: boolean;
  publicKey: PublicKey;
  connection: Connection;
  signTransaction: any;
  onClose: () => void;
  onDone: () => void;
}> = ({ pool, isMobile, publicKey, connection, signTransaction, onClose, onDone }) => {
  const [amt0, setAmt0]     = useState('');
  const [amt1, setAmt1]     = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);
  const [txSig, setTxSig]   = useState('');
  const [bal0, setBal0]     = useState(0);
  const [bal1, setBal1]     = useState(0);

  const dec0 = pool.dec0 || 9;
  const dec1 = pool.dec1 || 9;

  // Fetch wallet balances on open
  useEffect(() => {
    if (!pool.state) return;
    const fetchBals = async () => {
      try {
        const t0Prog = new PublicKey(pool.state!.token0Prog);
        const t1Prog = new PublicKey(pool.state!.token1Prog);
        const mint0  = new PublicKey(pool.state!.token0Mint);
        const mint1  = new PublicKey(pool.state!.token1Mint);
        const ata0   = getAssociatedTokenAddressSync(mint0, publicKey, false, t0Prog);
        const ata1   = getAssociatedTokenAddressSync(mint1, publicKey, false, t1Prog);
        const [i0, i1] = await Promise.all([connection.getAccountInfo(ata0), connection.getAccountInfo(ata1)]);
        if (i0) { const d = new Uint8Array(i0.data); setBal0(Number(readU64(d, 64)) / Math.pow(10, dec0)); }
        if (i1) { const d = new Uint8Array(i1.data); setBal1(Number(readU64(d, 64)) / Math.pow(10, dec1)); }
      } catch {}
    };
    fetchBals();
  }, [pool.state, publicKey]);

  const ratio = pool.vault0Bal > 0n && pool.vault1Bal > 0n
    ? Number(pool.vault1Bal) / Math.pow(10, dec1) / (Number(pool.vault0Bal) / Math.pow(10, dec0))
    : 0;

  const handleAmt0Change = (v: string) => {
    setAmt0(v);
    const a = parseFloat(v);
    if (!isNaN(a) && a > 0 && ratio > 0) setAmt1((a * ratio).toFixed(dec1 > 6 ? 6 : dec1));
    else setAmt1('');
  };
  const handleAmt1Change = (v: string) => {
    setAmt1(v);
    const a = parseFloat(v);
    if (!isNaN(a) && a > 0 && ratio > 0) setAmt0((a / ratio).toFixed(dec0 > 6 ? 6 : dec0));
    else setAmt0('');
  };

  const usd0 = parseFloat(amt0 || '0') * pool.price0;
  const usd1 = parseFloat(amt1 || '0') * pool.price1;
  const totalUsd = usd0 + usd1;

  const handleDeposit = async () => {
    if (!pool.state || !amt0 || !amt1) return;
    setPending(true); setStatus('Building deposit transaction…');
    try {
      const p0 = parseFloat(amt0); const p1 = parseFloat(amt1);
      if (isNaN(p0) || isNaN(p1) || p0 <= 0 || p1 <= 0) throw new Error('Invalid amounts');
      if (p0 > bal0) throw new Error(`Insufficient ${pool.sym0} balance`);
      if (p1 > bal1) throw new Error(`Insufficient ${pool.sym1} balance`);
      const raw0 = BigInt(Math.floor(p0 * Math.pow(10, dec0)));
      const raw1 = BigInt(Math.floor(p1 * Math.pow(10, dec1)));

      const supply = pool.state.lpSupply;
      const lpAmt  = supply > 0n ? raw0 * supply / pool.vault0Bal : raw0;

      const programPk   = new PublicKey(XDEX_PROGRAM);
      const authorityPk = new PublicKey(XDEX_LP_AUTH);
      const poolStatePk = new PublicKey(pool.poolAddr);
      const lpMintPk    = new PublicKey(pool.lpMint);
      const t0Prog      = new PublicKey(pool.state.token0Prog);
      const t1Prog      = new PublicKey(pool.state.token1Prog);
      const mint0Pk     = new PublicKey(pool.state.token0Mint);
      const mint1Pk     = new PublicKey(pool.state.token1Mint);

      const ownerLpAta = getAssociatedTokenAddressSync(lpMintPk, publicKey, false, TOKEN_PROGRAM_ID);
      const token0Ata  = getAssociatedTokenAddressSync(mint0Pk, publicKey, false, t0Prog);
      const token1Ata  = getAssociatedTokenAddressSync(mint1Pk, publicKey, false, t1Prog);

      const d = await disc('deposit');
      const data = Buffer.alloc(8 + 8 + 8 + 8);
      d.copy(data, 0);
      data.writeBigUInt64LE(lpAmt, 8);
      data.writeBigUInt64LE(raw0 * 101n / 100n, 16);
      data.writeBigUInt64LE(raw1 * 101n / 100n, 24);

      const keys = [
        { pubkey: publicKey,                             isSigner: true,  isWritable: false },
        { pubkey: authorityPk,                           isSigner: false, isWritable: false },
        { pubkey: poolStatePk,                           isSigner: false, isWritable: true  },
        { pubkey: ownerLpAta,                            isSigner: false, isWritable: true  },
        { pubkey: token0Ata,                             isSigner: false, isWritable: true  },
        { pubkey: token1Ata,                             isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(pool.state.token0Vault), isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(pool.state.token1Vault), isSigner: false, isWritable: true  },
        { pubkey: TOKEN_PROGRAM_ID,                      isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID,                 isSigner: false, isWritable: false },
        { pubkey: mint0Pk,                               isSigner: false, isWritable: false },
        { pubkey: mint1Pk,                               isSigner: false, isWritable: false },
        { pubkey: lpMintPk,                              isSigner: false, isWritable: true  },
      ];

      const ix = new TransactionInstruction({ programId: programPk, keys, data });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      const [lp, i0, i1] = await Promise.all([
        connection.getAccountInfo(ownerLpAta),
        connection.getAccountInfo(token0Ata),
        connection.getAccountInfo(token1Ata),
      ]);
      if (!lp) tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, ownerLpAta, publicKey, lpMintPk, TOKEN_PROGRAM_ID));
      if (!i0) tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, token0Ata, publicKey, mint0Pk, t0Prog));
      if (!i1) tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, token1Ata, publicKey, mint1Pk, t1Prog));
      tx.add(ix);

      setStatus('Waiting for wallet approval…');
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setStatus('Confirming…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error(JSON.stringify(st.value.err));
        if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') {
          setStatus(`✅ Deposited! You received LP tokens.`);
          setTxSig(sig);
          setTimeout(() => { onDone(); onClose(); }, 3000);
          return;
        }
      }
      throw new Error('Confirmation timeout');
    } catch (e: any) {
      setStatus('❌ ' + (e?.message ?? String(e)).slice(0, 200));
    } finally { setPending(false); }
  };

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.88)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 420,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(0,201,141,.15)', borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '20px 16px 28px' : '24px 26px',
        maxHeight: isMobile ? '92vh' : 'calc(100vh - 32px)', overflowY: 'auto',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, width: 28, height: 28,
          borderRadius: '50%', border: '1px solid rgba(255,255,255,.12)', background: 'rgba(8,12,15,.9)',
          cursor: 'pointer', color: '#6a8aaa', fontSize: 16 }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 16, fontWeight: 900, color: '#fff', marginBottom: 4 }}>
          ➕ ADD LIQUIDITY
        </div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', marginBottom: 20 }}>
          {pool.sym0} / {pool.sym1} · proportional deposit
        </div>

        {/* Token 0 input */}
        {[
          { sym: pool.sym0, logo: pool.logo0, val: amt0, set: handleAmt0Change, bal: bal0, usd: usd0, dec: dec0 },
          { sym: pool.sym1, logo: pool.logo1, val: amt1, set: handleAmt1Change, bal: bal1, usd: usd1, dec: dec1 },
        ].map((f, i) => (
          <div key={i} style={{ marginBottom: 12, background: 'rgba(255,255,255,.02)',
            border: '1px solid rgba(0,201,141,.12)', borderRadius: 12, padding: '12px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <TokenLogo logo={f.logo} symbol={f.sym} size={28} />
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 900, color: '#e0f0ff' }}>{f.sym}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>
                  {fmtNum(f.bal, 4)}
                </span>
                <button onClick={() => f.set(f.bal.toFixed(f.dec > 6 ? 6 : f.dec))} style={{
                  padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                  fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
                  background: 'rgba(0,201,141,.15)', border: '1px solid rgba(0,201,141,.3)', color: '#00c98d',
                }}>MAX</button>
              </div>
            </div>
            <div style={{ position: 'relative' }}>
              <input value={f.val} onChange={e => f.set(e.target.value)} placeholder="0.00"
                style={{ width: '100%', padding: '8px 0', border: 'none', background: 'transparent',
                  color: '#e0f0ff', fontFamily: 'Orbitron,monospace', fontSize: 20, fontWeight: 700,
                  outline: 'none', boxSizing: 'border-box' }} />
              {f.usd > 0 && (
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>
                  ≈ {fmtUSD(f.usd)}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Pool ratio */}
        {ratio > 0 && (
          <div style={{ background: 'rgba(255,255,255,.02)', borderRadius: 10, padding: '10px 14px',
            marginBottom: 12, fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Pool ratio</span>
              <span style={{ color: '#9abacf' }}>1 {pool.sym0} = {fmtNum(ratio, 4)} {pool.sym1}</span>
            </div>
            {totalUsd > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span>Total deposit</span>
                <span style={{ color: '#00c98d', fontWeight: 700 }}>{fmtUSD(totalUsd)}</span>
              </div>
            )}
          </div>
        )}

        <StatusBox msg={status} />
        {txSig && (
          <a href={`https://explorer.mainnet.x1.xyz/tx/${txSig}`} target="_blank" rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              width: '100%', padding: '10px 0', borderRadius: 10, marginBottom: 10, textDecoration: 'none',
              background: 'rgba(0,201,141,.08)', border: '1px solid rgba(0,201,141,.25)',
              fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700, color: '#00c98d',
              boxSizing: 'border-box' as const }}>
            🔍 VIEW ON EXPLORER · {txSig.slice(0,8)}…{txSig.slice(-6)}
          </a>
        )}
        <button onClick={handleDeposit} disabled={pending || !amt0 || !amt1} style={{
          width: '100%', padding: '14px 0', borderRadius: 12,
          cursor: pending ? 'not-allowed' : 'pointer',
          background: pending ? 'rgba(255,255,255,.04)' : 'linear-gradient(135deg,rgba(0,201,141,.2),rgba(0,201,141,.06))',
          border: `1px solid ${pending ? 'rgba(255,255,255,.08)' : 'rgba(0,201,141,.45)'}`,
          fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
          color: pending ? '#4a6a8a' : '#00c98d',
        }}>
          {pending ? 'PROCESSING…' : 'ADD LIQUIDITY'}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ─── Observation-based price chart data ──────────────────────────────────────
interface PricePoint { ts: number; price: number; }

async function fetchPriceHistory(pool: PoolView): Promise<PricePoint[]> {
  if (!pool.state) return [];
  try {
    const XDEX = new PublicKey(XDEX_PROGRAM);
    const poolPk = new PublicKey(pool.poolAddr);
    const [obsPk] = PublicKey.findProgramAddressSync([Buffer.from('observation'), poolPk.toBuffer()], XDEX);
    const res = await rpcCall('getAccountInfo', [obsPk.toBase58(), { encoding: 'base64' }]);
    if (!res?.value) return [];
    const d = new Uint8Array(Buffer.from(res.value.data[0], 'base64'));
    const D = 8;
    const obsCount = 100;
    const obsStart = D + 1 + 2 + 32; // skip initialized(1) + index(2) + pool_id(32)
    const points: PricePoint[] = [];
    let prevCum0 = 0n, prevCum1 = 0n, prevTs = 0n;
    const dec0 = pool.state.dec0;
    const dec1 = pool.state.dec1;
    for (let i = 0; i < obsCount; i++) {
      const off = obsStart + i * 40;
      if (off + 40 > d.length) break;
      const ts  = readU64(d, off);
      if (ts === 0n) continue;
      const cum0 = BigInt('0x' + Buffer.from(d.slice(off + 8,  off + 24)).reverse().toString('hex'));
      const cum1 = BigInt('0x' + Buffer.from(d.slice(off + 24, off + 40)).reverse().toString('hex'));
      if (prevTs > 0n && cum0 > prevCum0 && cum1 > prevCum1) {
        const dt   = Number(ts - prevTs);
        const d0   = Number(cum0 - prevCum0);
        const d1   = Number(cum1 - prevCum1);
        // TWAP price: d1/d0 gives token1 per token0, adjust for decimals
        const price = (d1 / d0) * Math.pow(10, dec0 - dec1);
        if (price > 0 && isFinite(price)) points.push({ ts: Number(ts), price });
      }
      prevCum0 = cum0; prevCum1 = cum1; prevTs = ts;
    }
    // Add current price from vault ratio
    const v0Ui = Number(pool.vault0Bal) / Math.pow(10, dec0);
    const v1Ui = Number(pool.vault1Bal) / Math.pow(10, dec1);
    if (v0Ui > 0 && v1Ui > 0) {
      points.push({ ts: Math.floor(Date.now() / 1000), price: v1Ui / v0Ui });
    }
    return points;
  } catch { return []; }
}

// ─── Mini price chart component ───────────────────────────────────────────────
const MiniChart: FC<{ points: PricePoint[]; sym0: string; sym1: string; color: string }> = ({ points, sym0, sym1, color }) => {
  if (points.length < 2) return (
    <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#3a5a6a' }}>
      Not enough data for chart
    </div>
  );
  const W = 400, H = 80, PAD = 8;
  const prices = points.map(p => p.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const range = maxP - minP || maxP * 0.01 || 1; // avoid flat line
  const toX = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const toY = (p: number) => H - PAD - ((p - minP) / range) * (H - PAD * 2);
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p.price).toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${toX(points.length - 1).toFixed(1)} ${H} L ${PAD} ${H} Z`;
  const last = prices[prices.length - 1];
  const first = prices[0];
  const pct = first > 0 ? ((last - first) / first * 100) : 0;
  // Don't show crazy percentage changes — cap display at ±9999%
  const pctDisplay = Math.abs(pct) > 9999 ? null : pct;
  const up = pct >= 0;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#3a5a6a' }}>
          {sym1}/{sym0} PRICE
        </div>
        {pctDisplay !== null && (
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700,
            color: up ? '#00c98d' : '#ff4444' }}>
            {up ? '▲' : '▼'} {Math.abs(pctDisplay).toFixed(2)}%
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80, overflow: 'visible' }}>
        <defs>
          <linearGradient id={`grad-${sym0}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#grad-${sym0})`} />
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* Current price dot */}
        <circle cx={toX(points.length - 1)} cy={toY(last)} r="3" fill={color} />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#3a5a6a', marginTop: 2 }}>
        <span>{new Date(points[0].ts * 1000).toLocaleDateString()}</span>
        <span style={{ color: '#9abacf', fontWeight: 700 }}>
          1 {sym0} = {fmtNum(last, 4)} {sym1}
        </span>
        <span>Now</span>
      </div>
    </div>
  );
};

// ─── Swap Modal ───────────────────────────────────────────────────────────────
const SwapModal: FC<{
  pool: PoolView;
  isMobile: boolean;
  publicKey: PublicKey;
  connection: Connection;
  signTransaction: any;
  onClose: () => void;
  onDone: () => void;
}> = ({ pool, isMobile, publicKey, connection, signTransaction, onClose, onDone }) => {
  const [sellIdx, setSellIdx]   = useState(0);
  const [amtIn, setAmtIn]       = useState('');
  const [status, setStatus]     = useState('');
  const [pending, setPending]   = useState(false);
  const [txSig, setTxSig]       = useState('');
  const [slipBps, setSlipBps]   = useState(50);
  const [bal0, setBal0]         = useState<number>(0);
  const [bal1, setBal1]         = useState<number>(0);

  const dec0    = pool.dec0 || 9;
  const dec1    = pool.dec1 || 9;
  const decIn   = sellIdx === 0 ? dec0 : dec1;
  const decOut  = sellIdx === 0 ? dec1 : dec0;
  const symIn   = sellIdx === 0 ? pool.sym0 : pool.sym1;
  const symOut  = sellIdx === 0 ? pool.sym1 : pool.sym0;
  const resIn   = sellIdx === 0 ? pool.vault0Bal : pool.vault1Bal;
  const resOut  = sellIdx === 0 ? pool.vault1Bal : pool.vault0Bal;
  const priceIn = sellIdx === 0 ? pool.price0 : pool.price1;
  const priceOut = sellIdx === 0 ? pool.price1 : pool.price0;
  const balIn   = sellIdx === 0 ? bal0 : bal1;

  const parsedIn  = parseFloat(amtIn);
  const rawIn     = amtIn && !isNaN(parsedIn) && parsedIn > 0
    ? BigInt(Math.floor(parsedIn * Math.pow(10, decIn)))
    : 0n;
  const rawOut    = cpSwapQuote(rawIn, resIn, resOut);
  const minOut     = rawOut * BigInt(10_000 - slipBps) / 10_000n;
  const outUi      = Number(rawOut) / Math.pow(10, decOut);
  const inUsd      = parseFloat(amtIn || '0') * priceIn;
  const outUsd     = outUi * priceOut;
  const priceImpact = resIn > 0n ? Number(rawIn * 10_000n / (resIn + rawIn)) / 100 : 0;

  // Fetch wallet balances on open
  useEffect(() => {
    if (!pool.state) return;
    const fetchBals = async () => {
      try {
        const t0Prog = new PublicKey(pool.state!.token0Prog);
        const t1Prog = new PublicKey(pool.state!.token1Prog);
        const mint0  = new PublicKey(pool.state!.token0Mint);
        const mint1  = new PublicKey(pool.state!.token1Mint);
        const ata0   = getAssociatedTokenAddressSync(mint0, publicKey, false, t0Prog);
        const ata1   = getAssociatedTokenAddressSync(mint1, publicKey, false, t1Prog);
        const [i0, i1] = await Promise.all([
          connection.getAccountInfo(ata0),
          connection.getAccountInfo(ata1),
        ]);
        if (i0) { const d = new Uint8Array(i0.data); setBal0(Number(readU64(d, 64)) / Math.pow(10, dec0)); }
        if (i1) { const d = new Uint8Array(i1.data); setBal1(Number(readU64(d, 64)) / Math.pow(10, dec1)); }
      } catch {}
    };
    fetchBals();
  }, [pool.state, publicKey, sellIdx]);

  const handleSwap = async () => {
    if (!pool.state || rawIn === 0n) return;
    setPending(true); setStatus('Building swap transaction…');
    try {
      const programPk    = new PublicKey(XDEX_PROGRAM);
      const authorityPk  = new PublicKey(XDEX_LP_AUTH);
      const poolStatePk  = new PublicKey(pool.poolAddr);
      const ammConfigPk  = new PublicKey(pool.state.ammConfig);
      const obsPk        = new PublicKey(pool.state.obsKey);
      const t0Prog = new PublicKey(pool.state.token0Prog);
      const t1Prog = new PublicKey(pool.state.token1Prog);
      const mint0  = new PublicKey(pool.state.token0Mint);
      const mint1  = new PublicKey(pool.state.token1Mint);
      const inputMint   = sellIdx === 0 ? mint0 : mint1;
      const outputMint  = sellIdx === 0 ? mint1 : mint0;
      const inputProg   = sellIdx === 0 ? t0Prog : t1Prog;
      const outputProg  = sellIdx === 0 ? t1Prog : t0Prog;
      const inputVault  = sellIdx === 0 ? pool.state.token0Vault : pool.state.token1Vault;
      const outputVault = sellIdx === 0 ? pool.state.token1Vault : pool.state.token0Vault;
      const inputAta    = getAssociatedTokenAddressSync(inputMint, publicKey, false, inputProg);
      const outputAta   = getAssociatedTokenAddressSync(outputMint, publicKey, false, outputProg);
      const d = await disc('swap_base_input');
      const data = Buffer.alloc(8 + 8 + 8);
      d.copy(data, 0);
      data.writeBigUInt64LE(rawIn, 8);
      data.writeBigUInt64LE(minOut, 16);
      const keys = [
        { pubkey: publicKey,                      isSigner: true,  isWritable: false },
        { pubkey: authorityPk,                    isSigner: false, isWritable: false },
        { pubkey: ammConfigPk,                    isSigner: false, isWritable: false },
        { pubkey: poolStatePk,                    isSigner: false, isWritable: true  },
        { pubkey: inputAta,                       isSigner: false, isWritable: true  },
        { pubkey: outputAta,                      isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(inputVault),      isSigner: false, isWritable: true  },
        { pubkey: new PublicKey(outputVault),     isSigner: false, isWritable: true  },
        { pubkey: inputProg,                      isSigner: false, isWritable: false },
        { pubkey: outputProg,                     isSigner: false, isWritable: false },
        { pubkey: inputMint,                      isSigner: false, isWritable: false },
        { pubkey: outputMint,                     isSigner: false, isWritable: false },
        { pubkey: obsPk,                          isSigner: false, isWritable: true  },
      ];
      const ix = new TransactionInstruction({ programId: programPk, keys, data });
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      const outInfo = await connection.getAccountInfo(outputAta);
      if (!outInfo) tx.add(createAssociatedTokenAccountIdempotentInstruction(publicKey, outputAta, publicKey, outputMint, outputProg));
      tx.add(ix);
      setStatus('Waiting for wallet approval…');
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setStatus('Confirming…');
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (st?.value?.err) throw new Error(JSON.stringify(st.value.err));
        if (st?.value?.confirmationStatus === 'confirmed' || st?.value?.confirmationStatus === 'finalized') {
          setStatus(`✅ Swapped!`);
          setTxSig(sig);
          setTimeout(() => { onDone(); onClose(); }, 3000);
          return;
        }
      }
      throw new Error('Confirmation timeout');
    } catch (e: any) {
      setStatus('❌ ' + (e?.message ?? String(e)).slice(0, 200));
    } finally { setPending(false); }
  };

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,.88)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center', padding: isMobile ? 0 : 16 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 420,
        background: 'linear-gradient(155deg,#0d1622,#080c0f)',
        border: '1px solid rgba(191,90,242,.15)', borderRadius: isMobile ? '20px 20px 0 0' : 16,
        padding: isMobile ? '20px 16px 28px' : '24px 26px',
        maxHeight: isMobile ? '92vh' : 'calc(100vh - 32px)', overflowY: 'auto',
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, width: 28, height: 28,
          borderRadius: '50%', border: '1px solid rgba(255,255,255,.12)', background: 'rgba(8,12,15,.9)',
          cursor: 'pointer', color: '#6a8aaa', fontSize: 16 }}>×</button>

        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 16, fontWeight: 900, color: '#fff', marginBottom: 4 }}>
          ⚡ SWAP
        </div>
        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#6a8aaa', marginBottom: 16 }}>
          {pool.sym0} / {pool.sym1} pool
        </div>

        {/* Direction toggle */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {[0, 1].map(idx => (
            <button key={idx} onClick={() => { setSellIdx(idx); setAmtIn(''); }} style={{
              flex: 1, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
              fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700,
              background: sellIdx === idx ? 'rgba(191,90,242,.15)' : 'rgba(255,255,255,.04)',
              border: `1px solid ${sellIdx === idx ? 'rgba(191,90,242,.4)' : 'rgba(255,255,255,.08)'}`,
              color: sellIdx === idx ? '#bf5af2' : '#6a8aaa',
            }}>
              {idx === 0 ? pool.sym0 : pool.sym1} → {idx === 0 ? pool.sym1 : pool.sym0}
            </button>
          ))}
        </div>

        {/* Input with balance + MAX */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a' }}>{symIn} AMOUNT IN</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#6a8aaa' }}>
                Balance: {fmtNum(balIn, 4)}
              </span>
              <button onClick={() => setAmtIn(balIn.toFixed(decIn > 4 ? 4 : decIn))} style={{
                padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
                background: 'rgba(191,90,242,.15)', border: '1px solid rgba(191,90,242,.3)', color: '#bf5af2',
              }}>MAX</button>
            </div>
          </div>
          <div style={{ position: 'relative' }}>
            <input value={amtIn} onChange={e => setAmtIn(e.target.value)} placeholder="0.00"
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 10,
                border: '1px solid rgba(191,90,242,.2)', background: 'rgba(191,90,242,.04)',
                color: '#e0f0ff', fontFamily: 'Orbitron,monospace', fontSize: 14,
                outline: 'none', boxSizing: 'border-box',
              }} />
            {inUsd > 0 && (
              <div style={{ position: 'absolute', right: 12, bottom: 8,
                fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a' }}>
                ≈ {fmtUSD(inUsd)}
              </div>
            )}
          </div>
        </div>

        {/* Output estimate */}
        {rawIn > 0n && (
          <div style={{ background: 'rgba(255,255,255,.02)', border: '1px solid rgba(255,255,255,.06)',
            borderRadius: 10, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a', marginBottom: 6 }}>YOU RECEIVE (ESTIMATE)</div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 20, fontWeight: 900, color: '#bf5af2' }}>
              {fmtNum(outUi, 4)} {symOut}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#6a8aaa' }}>
                ≈ {fmtUSD(outUsd)}
              </span>
              <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 10,
                color: priceImpact > 5 ? '#ff8888' : priceImpact > 2 ? '#ff8c00' : '#6a8aaa' }}>
                Impact: {priceImpact.toFixed(2)}%{priceImpact > 5 ? ' ⚠️' : ''}
              </span>
            </div>
          </div>
        )}

        {/* Rate */}
        {resIn > 0n && resOut > 0n && (
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a', marginBottom: 12, textAlign: 'center' }}>
            1 {symIn} ≈ {fmtNum(Number(resOut) / Math.pow(10, decOut) / (Number(resIn) / Math.pow(10, decIn)), 4)} {symOut}
          </div>
        )}

        {/* Slippage */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#4a6a8a' }}>SLIPPAGE</span>
          {[10, 50, 100].map(b => (
            <button key={b} onClick={() => setSlipBps(b)} style={{
              padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
              background: slipBps === b ? 'rgba(191,90,242,.15)' : 'rgba(255,255,255,.04)',
              border: `1px solid ${slipBps === b ? 'rgba(191,90,242,.3)' : 'rgba(255,255,255,.08)'}`,
              color: slipBps === b ? '#bf5af2' : '#6a8aaa',
            }}>{b / 100}%</button>
          ))}
        </div>

        <StatusBox msg={status} />
        {txSig && (
          <a href={`https://explorer.mainnet.x1.xyz/tx/${txSig}`} target="_blank" rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              width: '100%', padding: '10px 0', borderRadius: 10, marginBottom: 10, textDecoration: 'none',
              background: 'rgba(191,90,242,.08)', border: '1px solid rgba(191,90,242,.25)',
              fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700, color: '#bf5af2',
              boxSizing: 'border-box' as const }}>
            🔍 VIEW ON EXPLORER · {txSig.slice(0,8)}…{txSig.slice(-6)}
          </a>
        )}
        <button onClick={handleSwap} disabled={pending || rawIn === 0n || parsedIn > balIn} style={{
          width: '100%', padding: '14px 0', borderRadius: 12,
          cursor: (pending || rawIn === 0n) ? 'not-allowed' : 'pointer',
          background: pending ? 'rgba(255,255,255,.04)' : parsedIn > balIn
            ? 'rgba(255,68,68,.1)' : 'linear-gradient(135deg,rgba(191,90,242,.2),rgba(191,90,242,.06))',
          border: `1px solid ${pending ? 'rgba(255,255,255,.08)' : parsedIn > balIn ? 'rgba(255,68,68,.3)' : 'rgba(191,90,242,.45)'}`,
          fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
          color: pending ? '#4a6a8a' : parsedIn > balIn ? '#ff6666' : '#bf5af2',
        }}>
          {pending ? 'SWAPPING…'
            : parsedIn > balIn ? 'INSUFFICIENT BALANCE'
            : `SWAP ${symIn} → ${symOut}`}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ─── Pool Card ─────────────────────────────────────────────────────────────────
const PoolCard: FC<{
  pool: PoolView;
  isMobile: boolean;
  publicKey: PublicKey | null;
  connection: Connection;
  signTransaction: any;
  onRefresh: () => void;
  onModalChange: (open: boolean) => void;
  trendingRank?: number;
}> = ({ pool, isMobile, publicKey, connection, signTransaction, onRefresh, onModalChange, trendingRank }) => {
  const [modal, setModal] = useState<'withdraw' | 'deposit' | 'swap' | null>(null);
  const [chartData, setChartData] = useState<PricePoint[]>([]);
  const [chartLoaded, setChartLoaded] = useState(false);

  // Notify parent whenever a modal opens or closes so it can suppress background refresh
  const openModal = (m: 'withdraw' | 'deposit' | 'swap') => { setModal(m); onModalChange(true); };
  const closeModal = () => { setModal(null); onModalChange(false); };

  useEffect(() => {
    if (!pool.state) return;
    fetchPriceHistory(pool).then(pts => {
      setChartData(pts);
      setChartLoaded(true);
    });
  }, [pool.poolAddr]);

  const lpDecimals = pool.lpDecimals || 9;
  const lpUi       = Number(pool.walletLp) / Math.pow(10, lpDecimals);
  const hasLp      = pool.walletLp > 0n;
  const burnPct    = pool.burnBps / 100;

  return (
    <>
      <div style={{
        background: 'linear-gradient(135deg,rgba(255,255,255,.03),rgba(255,255,255,.01))',
        border: '1px solid rgba(255,255,255,.07)', borderRadius: 16,
        padding: isMobile ? '16px' : '20px 22px',
        position: 'relative', overflow: 'hidden',
        animation: 'fadeUp 0.4s ease both',
      }}>
        {/* Top accent */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: 'linear-gradient(90deg,rgba(0,212,255,.6),rgba(191,90,242,.4),transparent)' }} />

        {/* Pair header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ position: 'relative' }}>
            <TokenLogo logo={pool.logo0} symbol={pool.sym0} size={38} />
            <div style={{ position: 'absolute', bottom: -2, right: -2 }}>
              <TokenLogo logo={pool.logo1} symbol={pool.sym1} size={22} />
            </div>
          </div>
          <div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 14 : 16, fontWeight: 900, color: '#e0f0ff' }}>
              {pool.sym0} / {pool.sym1}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              {pool.seeded ? (
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1,
                  color: '#ff8c00', background: 'rgba(255,140,0,.12)',
                  border: '1px solid rgba(255,140,0,.35)', borderRadius: 5, padding: '2px 7px' }}>
                  🧠 ECOSYSTEM
                </span>
              ) : (
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1,
                  color: '#00c98d', background: 'rgba(0,201,141,.1)',
                  border: '1px solid rgba(0,201,141,.3)', borderRadius: 5, padding: '2px 7px' }}>
                  ⚗️ LAB WORK
                </span>
              )}
              {burnPct > 0 && (
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, letterSpacing: 1,
                  color: '#ff4444', background: 'rgba(255,68,68,.1)',
                  border: '1px solid rgba(255,68,68,.3)', borderRadius: 5, padding: '2px 7px' }}>
                  🔥 {burnPct}% BURN
                </span>
              )}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            {trendingRank && (
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 900,
                color: trendingRank === 1 ? '#ffd700' : trendingRank === 2 ? '#c0c0c0' : trendingRank === 3 ? '#cd7f32' : '#4a6a8a',
                background: trendingRank <= 3 ? 'rgba(255,215,0,.08)' : 'rgba(255,255,255,.04)',
                border: `1px solid ${trendingRank === 1 ? 'rgba(255,215,0,.3)' : trendingRank === 2 ? 'rgba(192,192,192,.3)' : trendingRank === 3 ? 'rgba(205,127,50,.3)' : 'rgba(255,255,255,.08)'}`,
                borderRadius: 6, padding: '2px 8px', marginBottom: 4, display: 'inline-block' }}>
                {trendingRank === 1 ? '🥇' : trendingRank === 2 ? '🥈' : trendingRank === 3 ? '🥉' : `#${trendingRank}`} TRENDING
              </div>
            )}
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 13 : 15, fontWeight: 900, color: '#00d4ff' }}>
              {pool.loading
                ? <span style={{ color: '#4a6a8a' }}>…</span>
                : pool.tvlUsd > 0
                  ? fmtUSD(pool.tvlUsd)
                  : <span style={{ color: '#4a6a8a' }}>—</span>}
            </div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#4a6a8a', marginTop: 2 }}>TVL</div>
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
          {[
            { label: pool.sym0 + ' PRICE', val: pool.loading ? '…' : pool.price0 > 0 ? fmtUSD(pool.price0) : '—' },
            { label: pool.sym1 + ' PRICE', val: pool.loading ? '…' : pool.price1 > 0 ? fmtUSD(pool.price1) : '—' },
            { label: 'LIQUIDITY',           val: pool.loading ? '…' : pool.tvlUsd > 0 ? fmtUSD(pool.tvlUsd) : '—' },
          ].map(s => (
            <div key={s.label} style={{ background: 'rgba(255,255,255,.02)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#3a5a6a', letterSpacing: .5, marginBottom: 4 }}>{s.label}</div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: '#9abacf' }}>{s.val}</div>
            </div>
          ))}
        </div>

        {/* Price chart */}
        {chartLoaded && pool.state && (
          <div style={{ background: 'rgba(255,255,255,.02)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
            <MiniChart
              points={chartData}
              sym0={pool.sym0}
              sym1={pool.sym1}
              color={pool.burnBps > 0 ? '#bf5af2' : '#00d4ff'}
            />
          </div>
        )}

        {/* LP distribution */}
        <div style={{ background: 'rgba(255,255,255,.02)', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#3a5a6a', marginBottom: 8 }}>LP DISTRIBUTION</div>
          {(() => {
            const rows = [
              { label: 'BURNED',    val: pool.lpBurned,   color: '#ff4444' },
              { label: 'TREASURY',  val: pool.lpTreasury, color: '#ff8c00' },
              { label: 'CREATOR A', val: pool.lpUserA,    color: '#00d4ff' },
              { label: 'CREATOR B', val: pool.lpUserB,    color: '#bf5af2' },
            ];
            const totalLp = rows.reduce((s, r) => s + r.val, 0n);
            return (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {rows.map(r => {
                  const ui  = Number(r.val) / Math.pow(10, lpDecimals);
                  const pct = totalLp > 0n ? Number(r.val * 10_000n / totalLp) / 100 : 0;
                  return (
                    <div key={r.label} style={{ minWidth: 64 }}>
                      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#3a5a6a', marginBottom: 2 }}>{r.label}</div>
                      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
                        color: r.val > 0n ? r.color : '#2a3a4a' }}>
                        {r.val > 0n ? fmtNum(ui, 2) : '—'}
                      </div>
                      {r.val > 0n && totalLp > 0n && (
                        <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 8, color: r.color, opacity: 0.6, marginTop: 1 }}>
                          {pct.toFixed(1)}%
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Your LP */}
        {publicKey && hasLp && (
          <div style={{ background: 'rgba(0,212,255,.04)', border: '1px solid rgba(0,212,255,.12)',
            borderRadius: 8, padding: '8px 12px', marginBottom: 14 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#4a6a8a', marginBottom: 2 }}>YOUR LP</div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900, color: '#00d4ff' }}>
              {lpUi.toFixed(4)} LP
            </div>
          </div>
        )}

        {/* Pool address + explorer link */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#3a5a6a', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            Pool: <a href={`https://explorer.x1.xyz/address/${pool.poolAddr}`} target="_blank" rel="noreferrer"
              style={{ color: '#4a6a8a', textDecoration: 'none' }}>{truncAddr(pool.poolAddr)}</a>
            <CopyButton text={pool.poolAddr} size={10} />
            {' · '}
            {new Date(pool.createdAt * 1000).toLocaleDateString()}
          </div>
          <a href={`https://explorer.x1.xyz/address/${pool.poolAddr}`} target="_blank" rel="noreferrer"
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(255,255,255,.08)',
              background: 'rgba(255,255,255,.04)', fontFamily: 'Orbitron,monospace', fontSize: 8,
              color: '#4a6a8a', textDecoration: 'none', cursor: 'pointer' }}>
            🔍 EXPLORER
          </a>
        </div>

        {/* Creator wallets */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
          {pool.seeded ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#3a5a6a' }}>CREATED BY:</span>
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
                color: '#ff8c00', background: 'rgba(255,140,0,.08)',
                border: '1px solid rgba(255,140,0,.2)', borderRadius: 5, padding: '2px 8px' }}>
                XDEX
              </span>
            </div>
          ) : (
            [
              { label: 'CREATOR A', addr: pool.creatorA },
              { label: 'CREATOR B', addr: pool.creatorB },
            ].map(c => (
              <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#3a5a6a' }}>{c.label}:</span>
                <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#4a6a8a' }}>{truncAddr(c.addr)}</span>
                <CopyButton text={c.addr} size={10} />
              </div>
            ))
          )}
        </div>

        {/* Action buttons */}
        {publicKey ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => openModal('swap')} style={{
              flex: 1, minWidth: 80, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
              background: 'linear-gradient(135deg,rgba(191,90,242,.15),rgba(191,90,242,.05))',
              border: '1px solid rgba(191,90,242,.35)',
              fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 900, color: '#bf5af2',
            }}>⚡ SWAP</button>
            <button onClick={() => openModal('deposit')} style={{
              flex: 1, minWidth: 80, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
              background: 'linear-gradient(135deg,rgba(0,201,141,.15),rgba(0,201,141,.05))',
              border: '1px solid rgba(0,201,141,.35)',
              fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 900, color: '#00c98d',
            }}>➕ DEPOSIT</button>
            {/* Only show WITHDRAW if wallet actually owns LP tokens */}
            {hasLp && pool.walletLp > 0n && (
              <button onClick={() => openModal('withdraw')} style={{
                flex: 1, minWidth: 80, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
                background: 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(0,212,255,.05))',
                border: '1px solid rgba(0,212,255,.35)',
                fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 900, color: '#00d4ff',
              }}>💧 WITHDRAW</button>
            )}
          </div>
        ) : (
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#4a6a8a', textAlign: 'center', padding: '8px 0' }}>
            Connect wallet to trade
          </div>
        )}
      </div>

      {modal === 'withdraw' && publicKey && pool.state && (
        <WithdrawModal pool={pool} isMobile={isMobile} publicKey={publicKey}
          connection={connection} signTransaction={signTransaction}
          onClose={closeModal} onDone={() => { closeModal(); onRefresh(); }} />
      )}
      {modal === 'deposit' && publicKey && pool.state && (
        <DepositModal pool={pool} isMobile={isMobile} publicKey={publicKey}
          connection={connection} signTransaction={signTransaction}
          onClose={closeModal} onDone={() => { closeModal(); onRefresh(); }} />
      )}
      {modal === 'swap' && publicKey && pool.state && (
        <SwapModal pool={pool} isMobile={isMobile} publicKey={publicKey}
          connection={connection} signTransaction={signTransaction}
          onClose={closeModal} onDone={() => { closeModal(); onRefresh(); }} />
      )}
    </>
  );
};

// ─── Main PoolsTab Component ──────────────────────────────────────────────────
const PoolsTab: FC = () => {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const isMobile = useIsMobile();

  const [pools, setPools]     = useState<PoolView[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState<'all' | 'ecosystem' | 'trending' | 'mine'>('all');

  // Track whether any PoolCard modal is open — suppress background refresh while true
  const anyModalOpen = React.useRef(false);

  const loadPools = useCallback(async (silent = false) => {
    // Don't wipe the UI with a spinner during background refreshes
    if (!silent) setLoading(true);
    try {
      const records = await fetchPoolRecords();
      const realPools = records; // show all pools including seeded ecosystem pools

      // Initialize pools in loading state so the UI shows skeleton/dashes
      // immediately, then patch each pool in as its data arrives. This avoids
      // a long blank-screen wait and lets the user see progress.
      const initialViews: PoolView[] = realPools.map((rec) => ({
        ...rec,
        vault0Bal: 0n, vault1Bal: 0n,
        sym0: rec.tokenAMint.slice(0, 4).toUpperCase(),
        sym1: rec.tokenBMint.slice(0, 4).toUpperCase(),
        tvlUsd: 0, price0: 0, price1: 0, lpPrice: 0,
        walletLp: 0n, lpDecimals: 9, dec0: 9, dec1: 9, loading: true,
      }));
      setPools(initialViews);

      // Stagger pool fetches: 150ms gap between starting each pool. The X1
      // public RPC throttles at ~10–20 req/sec; firing 10 pools × 5 calls
      // each in parallel produces 429s and cascading retry storms. Staggering
      // keeps us under the limit while still loading all pools in ~1.5s total.
      const STAGGER_MS = 150;

      // Internal helper that does ONE pool's full fetch (state + meta + vaults
      // + prices). Same body as before — just lifted into a named function so
      // we can call it sequentially.
      async function loadOnePool(rec: typeof realPools[number]): Promise<PoolView> {
        const base: PoolView = {
          ...rec,
          vault0Bal: 0n, vault1Bal: 0n,
          sym0: rec.tokenAMint.slice(0, 4).toUpperCase(),
          sym1: rec.tokenBMint.slice(0, 4).toUpperCase(),
          tvlUsd: 0, price0: 0, price1: 0, lpPrice: 0,
          walletLp: 0n, lpDecimals: 9, dec0: 9, dec1: 9, loading: true,
        };
        try {
          const [state, metaA, metaB] = await Promise.all([
            fetchXdexPoolState(rec.poolAddr),
            fetchTokenMeta(rec.tokenAMint),
            fetchTokenMeta(rec.tokenBMint),
          ]);

          if (!state) return { ...base, loading: false };

          // Token ordering: PoolRecord stores our tokenA/B but XDEX sorts them lexicographically
          // state.token0Mint is the lexicographically smaller mint
          const t0IsA = state.token0Mint === rec.tokenAMint;
          // Always prefer KNOWN_META symbol over whatever metadata fetch returned
          const sym0  = KNOWN_META[state.token0Mint]?.symbol ?? (t0IsA ? metaA.symbol : metaB.symbol);
          const sym1  = KNOWN_META[state.token1Mint]?.symbol ?? (t0IsA ? metaB.symbol : metaA.symbol);
          const logo0 = t0IsA ? metaA.logo   : metaB.logo;
          const logo1 = t0IsA ? metaB.logo   : metaA.logo;

          const [v0, v1, walletLp, lpMintInfo] = await Promise.all([
            fetchVaultBalance(state.token0Vault),
            fetchVaultBalance(state.token1Vault),
            publicKey ? fetchWalletLpBalance(rec.lpMint, publicKey.toBase58()) : Promise.resolve(0n),
            // Always read LP decimals from the mint account — pool state byte is unreliable
            rpcCall('getAccountInfo', [rec.lpMint, { encoding: 'base64' }]).catch(() => null),
          ]);

          // LP decimals: read from mint account at offset 44 (reliable for SPL and Token-2022)
          let lpDecimalsResolved = state.lpDecimals || 9;
          if (lpMintInfo?.value) {
            try {
              const lpMintData = new Uint8Array(Buffer.from(lpMintInfo.value.data[0], 'base64'));
              const fromMint = lpMintData[44];
              if (fromMint > 0 && fromMint <= 18) lpDecimalsResolved = fromMint;
            } catch {}
          }

          // Token decimals: read from mint account directly if pool state has zero (layout mismatch)
          let dec0 = state.dec0;
          let dec1 = state.dec1;
          if (dec0 === 0 || dec1 === 0) {
            try {
              const [m0, m1] = await Promise.all([
                rpcCall('getAccountInfo', [state.token0Mint, { encoding: 'base64' }]),
                rpcCall('getAccountInfo', [state.token1Mint, { encoding: 'base64' }]),
              ]);
              if (m0?.value) {
                const d0 = new Uint8Array(Buffer.from(m0.value.data[0], 'base64'));
                dec0 = d0[44]; // decimals at offset 44 in both SPL and Token-2022
              }
              if (m1?.value) {
                const d1 = new Uint8Array(Buffer.from(m1.value.data[0], 'base64'));
                dec1 = d1[44];
              }
            } catch {}
          }

          const v0Ui = Number(v0) / Math.pow(10, dec0);
          const v1Ui = Number(v1) / Math.pow(10, dec1);

          // ── Pricing & TVL ─────────────────────────────────────────────
          //
          // Strategy: a constant-product pool's two sides should have equal
          // dollar value (ignoring the small fee buffer). If we have API prices
          // for BOTH tokens, we compute TVL from each side independently and
          // require them to agree within 5×. If they don't, the pool is
          // imbalanced enough that prices are unreliable — show '—' rather
          // than fake billions.
          //
          // For BRAINS-paired pools where the other token has no API price,
          // we anchor on BRAINS from the API side ONLY: TVL = 2 × (BRAINS
          // reserves × BRAINS price). The other half is implicitly the same
          // by AMM invariant.
          let price0 = 0, price1 = 0, tvlUsd = 0;
          const BRAINS_MINT_LOCAL = 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN';
          try {
            const brainsIsToken1 = state.token1Mint === BRAINS_MINT_LOCAL;
            const brainsIsToken0 = state.token0Mint === BRAINS_MINT_LOCAL;

            if (brainsIsToken0 || brainsIsToken1) {
              const nonBrainsMint = brainsIsToken1 ? state.token0Mint : state.token1Mint;
              const [pNonBrains, pBrains] = await Promise.all([
                fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${nonBrainsMint}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null),
                fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${BRAINS_MINT_LOCAL}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null),
              ]);
              const otherPrice  = pNonBrains?.success && pNonBrains?.data?.price ? Number(pNonBrains.data.price) : 0;
              const brainsPrice = pBrains?.success    && pBrains?.data?.price    ? Number(pBrains.data.price)    : 0;

              const brainsUi = brainsIsToken1 ? v1Ui : v0Ui;
              const otherUi  = brainsIsToken1 ? v0Ui : v1Ui;

              if (brainsPrice > 0 && otherPrice > 0 && brainsUi > 0 && otherUi > 0) {
                // Both API prices available — compute each side's TVL contribution
                // and reject if they disagree by more than 5×. Disagreement means
                // either the pool is broken or one of the API prices is wrong.
                const brainsSide = brainsUi * brainsPrice;
                const otherSide  = otherUi  * otherPrice;
                const ratio = Math.max(brainsSide, otherSide) / Math.min(brainsSide, otherSide);

                if (ratio < 5) {
                  // Pool is balanced — both prices trustworthy
                  if (brainsIsToken1) { price0 = otherPrice; price1 = brainsPrice; }
                  else                { price1 = otherPrice; price0 = brainsPrice; }
                  tvlUsd = brainsSide + otherSide;
                } else {
                  // Pool is imbalanced — anchor on BRAINS side only (more
                  // reliable since BRAINS has its own deeper liquidity).
                  // TVL = 2 × BRAINS side (AMM invariant: both sides equal value).
                  if (brainsIsToken1) { price1 = brainsPrice; price0 = brainsSide / otherUi; }
                  else                { price0 = brainsPrice; price1 = brainsSide / otherUi; }
                  tvlUsd = brainsSide * 2;
                }
              } else if (brainsPrice > 0 && brainsUi > 0) {
                // Only BRAINS price known — anchor on BRAINS side, derive the
                // other token's price from pool ratio (TVL = 2 × BRAINS side).
                if (brainsIsToken1) { price1 = brainsPrice; price0 = (brainsUi * brainsPrice) / otherUi; }
                else                { price0 = brainsPrice; price1 = (brainsUi * brainsPrice) / otherUi; }
                tvlUsd = brainsUi * brainsPrice * 2;
              }
              // else: BRAINS price unavailable — leave tvlUsd at 0
            } else {
              // No BRAINS side — both tokens need API prices. Apply same 5×
              // sanity check between sides.
              const [p0res, p1res] = await Promise.all([
                fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${state.token0Mint}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null),
                fetch(`/api/xdex-price/api/token-price/price?network=X1+Mainnet&token_address=${state.token1Mint}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null),
              ]);
              const p0 = p0res?.success && p0res?.data?.price ? Number(p0res.data.price) : 0;
              const p1 = p1res?.success && p1res?.data?.price ? Number(p1res.data.price) : 0;
              if (p0 > 0 && p1 > 0 && v0Ui > 0 && v1Ui > 0) {
                const side0 = v0Ui * p0;
                const side1 = v1Ui * p1;
                const ratio = Math.max(side0, side1) / Math.min(side0, side1);
                if (ratio < 5) {
                  price0 = p0; price1 = p1;
                  tvlUsd = side0 + side1;
                }
                // else: imbalanced, leave tvlUsd at 0
              }
            }
          } catch {}

          // No fallback for tvlUsd: if the XDEX price API didn't return a price
          // for this pool's tokens, leave tvlUsd at 0 so the UI renders '—'.
          // We previously fell back to `rec.usdVal / 1_000_000` here, but that
          // field's offset in PoolRecord is not reliable — it was reading
          // garbage bytes and producing 1M×-inflated values intermittently.
          // Better to show no number than a misleading one.

          // LP price = TVL / LP supply (use resolved decimals, not raw state field)
          const supply  = Number(state.lpSupply);
          const lpPrice = supply > 0 && tvlUsd > 0
            ? tvlUsd / (supply / Math.pow(10, lpDecimalsResolved))
            : 0;

          return {
            ...base,
            state, vault0Bal: v0, vault1Bal: v1,
            sym0, sym1, logo0, logo1,
            tvlUsd, price0, price1, lpPrice,
            walletLp, lpDecimals: lpDecimalsResolved,
            dec0, dec1,
            loading: false,
          };
        } catch {
          return { ...base, loading: false };
        }
      }

      // Stagger: kick off pool fetches with a 150ms gap between starts, then
      // patch each result into state as it lands. Total wall-clock is roughly
      // (N × 150ms) + slowest-pool-fetch instead of (sum of all fetches).
      const views: PoolView[] = new Array(realPools.length);
      const inFlight: Promise<void>[] = [];
      for (let i = 0; i < realPools.length; i++) {
        const rec = realPools[i];
        const idx = i;
        if (i > 0) await new Promise(r => setTimeout(r, STAGGER_MS));
        inFlight.push(
          loadOnePool(rec).then(view => {
            views[idx] = view;
            setPools(prev => {
              const next = [...prev];
              next[idx] = view;
              return next;
            });
          }),
        );
      }
      await Promise.allSettled(inFlight);

      // Dispatch ecosystem TVL to dashboard — only the 5 known BRAINS ecosystem pools
      const ECOSYSTEM_POOL_ADDRS = new Set([
        '7deZorr98nLdZhpmSdUgu8WY4NAjSpeLDGxHzaTAxrUg',
        '4C4o1Zgzrt996t2BupL65WJvkifZZ3Ncv3oZxe2CxrW4',
        'AhgJp8b2aFu9dgFbZZwSs5QhQXWgvtiY6MFaMzxriApb',
        'HWmgietnQGE3eK11PhaCsZi6E3iFzCK3n8wTDrYoiLoP',
        'DjaYfY2s7BFxs8Se13ZVcHS48UCvZgFFuxaWgPiabYve',
      ]);
      const ecosystemTvl = views
        .filter(v => ECOSYSTEM_POOL_ADDRS.has(v.address))
        .reduce((sum, v) => sum + (v.tvlUsd || 0), 0);
      if (ecosystemTvl > 0) {
        window.dispatchEvent(new CustomEvent('xbrains-tvl', { detail: { totalTvl: ecosystemTvl } }));
      }

      // Background logo refresh — fetchTokenMeta may have returned without a logo on first call
      // (Token-2022 URI fetch can be slow). Re-fetch all mints and patch logos into state.
      const allMints = [...new Set(views.flatMap(v => [v.tokenAMint, v.tokenBMint]))];
      Promise.allSettled(allMints.map(m => fetchTokenMeta(m))).then(() => {
        setPools(prev => prev.map(p => ({
          ...p,
          logo0: _metaCache.get(p.state?.token0Mint ?? p.tokenAMint)?.logo ?? p.logo0,
          logo1: _metaCache.get(p.state?.token1Mint ?? p.tokenBMint)?.logo ?? p.logo1,
        })));
      });
    } catch (e) {
      console.error('Failed to load pools:', e);
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => { loadPools(); }, [loadPools]);

  // Background refresh every 60s — skips silently if any modal is open
  useEffect(() => {
    const interval = setInterval(() => {
      if (!anyModalOpen.current) loadPools(true);
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadPools]);

  // Re-fetch wallet LP balances when publicKey changes (wallet connects after initial load)
  useEffect(() => {
    if (!publicKey || pools.length === 0 || loading) return;
    const refreshLpBalances = async () => {
      const updated = await Promise.all(pools.map(async (pool) => {
        const walletLp = await fetchWalletLpBalance(pool.lpMint, publicKey.toBase58());
        return { ...pool, walletLp };
      }));
      setPools(updated);
    };
    refreshLpBalances();
  }, [publicKey]);

  const filtered = (() => {
    let list = [...pools];
    if (filter === 'ecosystem') return list.filter(p => p.seeded);
    if (filter === 'mine' && publicKey)
      return list.filter(p => p.creatorA === publicKey.toBase58() || p.creatorB === publicKey.toBase58() || p.walletLp > 0n);
    if (filter === 'trending')
      return list.filter(p => p.tvlUsd > 0).sort((a, b) => b.tvlUsd - a.tvlUsd);
    // 'all' — ecosystem pools first, then protocol pools by TVL
    return list.sort((a, b) => {
      if (a.seeded !== b.seeded) return a.seeded ? -1 : 1;
      return b.tvlUsd - a.tvlUsd;
    });
  })();

  return (
    <div style={{ width: '100%' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 11 : 13,
            fontWeight: 900, color: '#fff', letterSpacing: 1.5 }}>
            🏊 LAB WORK POOLS
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a', marginTop: 3 }}>
            {pools.filter(p => !p.seeded).length} protocol pool{pools.filter(p => !p.seeded).length !== 1 ? 's' : ''} · {pools.filter(p => p.seeded).length} ecosystem pool{pools.filter(p => p.seeded).length !== 1 ? 's' : ''} · swap, deposit & withdraw
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Filter tabs */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,.04)',
            border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, padding: 3, flexWrap: 'wrap', gap: 2 }}>
            {([
              { id: 'all',       label: '🌐 ALL',        color: '#00d4ff' },
              { id: 'ecosystem', label: '🧠 ECOSYSTEM',  color: '#ff8c00' },
              { id: 'trending',  label: '🔥 TRENDING',   color: '#ff4444' },
              { id: 'mine',      label: '👤 MINE',       color: '#bf5af2' },
            ] as { id: typeof filter; label: string; color: string }[]).map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)} style={{
                padding: '5px 10px', borderRadius: 8, cursor: 'pointer',
                fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 900,
                background: filter === f.id ? `${f.color}20` : 'transparent',
                border: `1px solid ${filter === f.id ? f.color + '55' : 'transparent'}`,
                color: filter === f.id ? f.color : '#4a6a8a',
                transition: 'all .15s',
              }}>{f.label}</button>
            ))}
          </div>
          {/* Refresh */}
          <button onClick={loadPools} style={{
            padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
            background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
            fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#4a6a8a',
          }}>↻</button>
        </div>
      </div>

      {/* Pool list */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ textAlign: 'center', padding: '20px 0 8px',
            fontFamily: 'Orbitron,monospace', fontSize: 10, color: '#4a6a8a', letterSpacing: 2,
            animation: 'pulse 1.5s ease-in-out infinite' }}>
            ⟳ FETCHING POOL DATA…
          </div>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ height: 220, borderRadius: 16,
              background: 'linear-gradient(90deg,rgba(255,255,255,.03) 25%,rgba(255,255,255,.06) 50%,rgba(255,255,255,.03) 75%)',
              backgroundSize: '400px 100%', animation: `shimmer 1.5s infinite ${i * 0.15}s`,
              border: '1px solid rgba(255,255,255,.05)' }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: isMobile ? '60px 20px' : '80px 40px' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🏊</div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 12 : 16,
            fontWeight: 900, color: '#9abacf', letterSpacing: 2, marginBottom: 8 }}>
            {filter === 'mine' ? 'NO POOLS FOUND'
              : filter === 'ecosystem' ? 'NO ECOSYSTEM POOLS'
              : filter === 'trending' ? 'NO ACTIVE POOLS'
              : 'NO POOLS YET'}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#4a6a8a' }}>
            {filter === 'mine'
              ? 'You have no LP positions or created pools.'
              : filter === 'ecosystem'
              ? 'No ecosystem pools have been seeded yet.'
              : filter === 'trending'
              ? 'No pools with TVL data found.'
              : 'Pools appear here once a listing is matched.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filtered.map((pool, idx) => (
            <PoolCard key={pool.pda} pool={pool} isMobile={isMobile}
              publicKey={publicKey} connection={connection} signTransaction={signTransaction}
              onRefresh={() => loadPools(true)}
              onModalChange={(open) => { anyModalOpen.current = open; }}
              trendingRank={filter === 'trending' ? idx + 1 : undefined} />
          ))}
        </div>
      )}

      <style>{`
        @keyframes shimmer { 0%{background-position:-400px 0} 100%{background-position:400px 0} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
      `}</style>
    </div>
  );
};

export default PoolsTab;
