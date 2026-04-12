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
  usdVal:     number;
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

async function fetchTokenMeta(mint: string): Promise<TokenMeta> {
  if (_metaCache.has(mint)) return _metaCache.get(mint)!;
  const t22 = await fetchToken2022Meta(mint);
  if (t22) { _metaCache.set(mint, t22); return t22; }
  const mpx = await fetchMetaplexMeta(mint);
  if (mpx) { _metaCache.set(mint, mpx); return mpx; }
  const xdex = await fetchXdexMeta(mint);
  if (xdex) { _metaCache.set(mint, xdex); return xdex; }
  const fallback: TokenMeta = { symbol: mint.slice(0,4).toUpperCase(), name: mint.slice(0,8), decimals: 9 };
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
      usdVal:     Number(readU64(d, D + 250)),
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
}> = ({ pool, isMobile, publicKey, connection, signTransaction, onRefresh }) => {
  const [modal, setModal] = useState<'withdraw' | 'deposit' | 'swap' | null>(null);
  const [chartData, setChartData] = useState<PricePoint[]>([]);
  const [chartLoaded, setChartLoaded] = useState(false);

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
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#4a6a8a', marginTop: 2 }}>
              {pool.seeded ? 'SEEDED POOL' : 'LAB WORK POOL'} · {burnPct}% BURN
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 13 : 15, fontWeight: 900, color: '#00d4ff' }}>
              {fmtUSD(pool.tvlUsd)}
            </div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#4a6a8a', marginTop: 2 }}>TVL</div>
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
          {[
            { label: pool.sym0 + ' PRICE', val: pool.price0 > 0 ? fmtUSD(pool.price0) : '—' },
            { label: pool.sym1 + ' PRICE', val: pool.price1 > 0 ? fmtUSD(pool.price1) : '—' },
            { label: 'LIQUIDITY',           val: pool.tvlUsd > 0 ? fmtUSD(pool.tvlUsd) : '—' },
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
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[
              { label: 'BURNED',    val: pool.lpBurned,   color: '#ff4444' },
              { label: 'TREASURY',  val: pool.lpTreasury, color: '#ff8c00' },
              { label: 'CREATOR A', val: pool.lpUserA,    color: '#00d4ff' },
              { label: 'CREATOR B', val: pool.lpUserB,    color: '#bf5af2' },
            ].map(r => (
              <div key={r.label} style={{ minWidth: 60 }}>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#3a5a6a', marginBottom: 2 }}>{r.label}</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
                  color: r.val > 0n ? r.color : '#2a3a4a' }}>
                  {r.val > 0n ? fmtNum(Number(r.val) / Math.pow(10, lpDecimals), 2) : '—'}
                </div>
              </div>
            ))}
          </div>
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
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#3a5a6a' }}>
            Pool: <a href={`https://explorer.x1.xyz/address/${pool.poolAddr}`} target="_blank" rel="noreferrer"
              style={{ color: '#4a6a8a', textDecoration: 'none' }}>{truncAddr(pool.poolAddr)}</a>
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

        {/* Action buttons */}
        {publicKey ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setModal('swap')} style={{
              flex: 1, minWidth: 80, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
              background: 'linear-gradient(135deg,rgba(191,90,242,.15),rgba(191,90,242,.05))',
              border: '1px solid rgba(191,90,242,.35)',
              fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 900, color: '#bf5af2',
            }}>⚡ SWAP</button>
            <button onClick={() => setModal('deposit')} style={{
              flex: 1, minWidth: 80, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
              background: 'linear-gradient(135deg,rgba(0,201,141,.15),rgba(0,201,141,.05))',
              border: '1px solid rgba(0,201,141,.35)',
              fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 900, color: '#00c98d',
            }}>➕ DEPOSIT</button>
            {/* Only show WITHDRAW if wallet actually owns LP tokens */}
            {hasLp && pool.walletLp > 0n && (
              <button onClick={() => setModal('withdraw')} style={{
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
          onClose={() => setModal(null)} onDone={onRefresh} />
      )}
      {modal === 'deposit' && publicKey && pool.state && (
        <DepositModal pool={pool} isMobile={isMobile} publicKey={publicKey}
          connection={connection} signTransaction={signTransaction}
          onClose={() => setModal(null)} onDone={onRefresh} />
      )}
      {modal === 'swap' && publicKey && pool.state && (
        <SwapModal pool={pool} isMobile={isMobile} publicKey={publicKey}
          connection={connection} signTransaction={signTransaction}
          onClose={() => setModal(null)} onDone={onRefresh} />
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
  const [filter, setFilter]   = useState<'all' | 'mine'>('all');

  const loadPools = useCallback(async () => {
    setLoading(true);
    try {
      const records = await fetchPoolRecords();
      const realPools = records.filter(r => !r.seeded);

      // Load all pool states, vault balances, metadata, LP balances in parallel
      const views = await Promise.all(realPools.map(async (rec): Promise<PoolView> => {
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
          const sym0  = t0IsA ? metaA.symbol : metaB.symbol;
          const sym1  = t0IsA ? metaB.symbol : metaA.symbol;
          const logo0 = t0IsA ? metaA.logo   : metaB.logo;
          const logo1 = t0IsA ? metaB.logo   : metaA.logo;

          const [v0, v1, walletLp] = await Promise.all([
            fetchVaultBalance(state.token0Vault),
            fetchVaultBalance(state.token1Vault),
            publicKey ? fetchWalletLpBalance(rec.lpMint, publicKey.toBase58()) : Promise.resolve(0n),
          ]);

          // If pool state gives dec=0 (layout mismatch), read from mint account directly
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

          // Get real USD price for token0 using the correct XDEX prices endpoint
          let price0 = 0, price1 = 0, tvlUsd = 0;
          try {
            const p0res = await fetch(
              `/api/xdex-price/api/token-price/prices?network=X1%20Mainnet&token_addresses=${state.token0Mint}`,
              { signal: AbortSignal.timeout(5000) }
            );
            const p0j = await p0res.json();
            // Parse response — handle array or object format
            if (p0j?.success === true && Array.isArray(p0j?.data)) {
              const item = p0j.data.find((i: any) => i?.token_address === state.token0Mint);
              if (item?.price) price0 = Number(item.price);
            } else if (p0j?.success && p0j?.data?.price) {
              price0 = Number(p0j.data.price);
            }
            if (price0 > 0 && v0Ui > 0 && v1Ui > 0) {
              price1 = price0 * (v0Ui / v1Ui);
              tvlUsd = price0 * v0Ui + price1 * v1Ui;
            }
          } catch {}

          // Fallback to stored usdVal if API fails
          if (tvlUsd === 0) {
            tvlUsd = rec.usdVal / 1_000_000;
            price0 = v0Ui > 0 ? (tvlUsd / 2) / v0Ui : 0;
            price1 = v1Ui > 0 ? (tvlUsd / 2) / v1Ui : 0;
          }

          // LP price = TVL / LP supply
          const supply  = Number(state.lpSupply);
          const lpPrice = supply > 0 && tvlUsd > 0
            ? tvlUsd / (supply / Math.pow(10, state.lpDecimals))
            : 0;

          return {
            ...base,
            state, vault0Bal: v0, vault1Bal: v1,
            sym0, sym1, logo0, logo1,
            tvlUsd, price0, price1, lpPrice,
            walletLp, lpDecimals: state.lpDecimals,
            dec0, dec1,
            loading: false,
          };
        } catch {
          return { ...base, loading: false };
        }
      }));

      setPools(views);
    } catch (e) {
      console.error('Failed to load pools:', e);
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => { loadPools(); }, [loadPools]);

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

  const filtered = filter === 'mine' && publicKey
    ? pools.filter(p => p.creatorA === publicKey.toBase58() || p.creatorB === publicKey.toBase58() || p.walletLp > 0n)
    : pools;

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
            {pools.length} pool{pools.length !== 1 ? 's' : ''} · swap, deposit & withdraw directly
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Filter tabs */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,.04)',
            border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, padding: 3 }}>
            {(['all', 'mine'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 900,
                background: filter === f ? 'rgba(0,212,255,.15)' : 'transparent',
                border: `1px solid ${filter === f ? 'rgba(0,212,255,.3)' : 'transparent'}`,
                color: filter === f ? '#00d4ff' : '#4a6a8a',
              }}>{f === 'all' ? 'ALL POOLS' : 'MY POOLS'}</button>
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
            {filter === 'mine' ? 'NO POOLS FOUND' : 'NO POOLS YET'}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#4a6a8a' }}>
            {filter === 'mine'
              ? 'You have no LP positions or created pools.'
              : 'Pools appear here once a listing is matched.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filtered.map(pool => (
            <PoolCard key={pool.pda} pool={pool} isMobile={isMobile}
              publicKey={publicKey} connection={connection} signTransaction={signTransaction}
              onRefresh={loadPools} />
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
