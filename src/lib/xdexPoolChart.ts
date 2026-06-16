// Self-contained on-chain price history reader for any xDEX pool.
//
// Reads two accounts:
//   1. The pool's state account (decimals + observation key)
//   2. The pool's observation PDA (100 TWAP samples)
//
// Returns a PricePoint[] suitable for sparkline rendering. No API calls, no
// rate limits — every chart is genuinely independent from every other.
//
// This is the same TWAP read PoolsTab uses for its per-pool MiniChart, lifted
// out so V2XdexPoolsList (and any future surface) can render charts for
// arbitrary xDEX pools without dragging in PoolsTab's whole PoolView pipeline.

import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

const XDEX_PROGRAM = new PublicKey('sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN');

export interface PricePoint { ts: number; price: number; }

export interface XdexPoolMeta {
  obsKey:      string;
  token0Mint:  string;
  token1Mint:  string;
  token0Vault: string;
  token1Vault: string;
  lpMint:      string;
  dec0:        number;
  dec1:        number;
  lpDecimals:  number;
  lpSupply:    bigint;
  /** Live vault0 balance (raw u64). 0 if not loaded. */
  vault0:      bigint;
  /** Live vault1 balance (raw u64). 0 if not loaded. */
  vault1:      bigint;
}

type PoolMeta = XdexPoolMeta;

// 60s cache so re-renders don't refetch the same pool's chart.
const _cache = new Map<string, { points: PricePoint[]; ts: number }>();
const _inflight = new Map<string, Promise<PricePoint[]>>();
const CACHE_TTL_MS = 60_000;

function readPubkey(d: Uint8Array, o: number): string {
  return new PublicKey(d.slice(o, o + 32)).toBase58();
}
function readU64(d: Uint8Array, o: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset + o, 8);
  return v.getBigUint64(0, true);
}

function parsePoolMeta(data: Uint8Array | null): PoolMeta | null {
  if (!data) return null;
  try {
    const D = 8;
    return {
      token0Vault: readPubkey(data, D + 64),
      token1Vault: readPubkey(data, D + 96),
      lpMint:      readPubkey(data, D + 128),
      token0Mint:  readPubkey(data, D + 160),
      token1Mint:  readPubkey(data, D + 192),
      obsKey:      readPubkey(data, D + 288),
      lpDecimals:  data[D + 322],
      dec0:        data[D + 323],
      dec1:        data[D + 324],
      lpSupply:    readU64(data, D + 325),
      vault0:      0n,
      vault1:      0n,
    };
  } catch { return null; }
}

/** Lightweight pool state read: state + vault balances. Cached 60s. */
const _stateCache = new Map<string, { meta: XdexPoolMeta; ts: number }>();
const _stateInflight = new Map<string, Promise<XdexPoolMeta | null>>();

export async function fetchXdexPoolState(
  connection: Connection,
  poolAddr: string,
): Promise<XdexPoolMeta | null> {
  const c = _stateCache.get(poolAddr);
  if (c && Date.now() - c.ts < CACHE_TTL_MS) return c.meta;
  const flight = _stateInflight.get(poolAddr);
  if (flight) return flight;

  const job = (async (): Promise<XdexPoolMeta | null> => {
    try {
      const poolPk = new PublicKey(poolAddr);
      const poolInfo = await connection.getAccountInfo(poolPk, 'confirmed').catch(() => null);
      const meta = parsePoolMeta(poolInfo ? new Uint8Array(poolInfo.data) : null);
      if (!meta) return null;
      const [v0Info, v1Info] = await Promise.all([
        connection.getAccountInfo(new PublicKey(meta.token0Vault), 'confirmed').catch(() => null),
        connection.getAccountInfo(new PublicKey(meta.token1Vault), 'confirmed').catch(() => null),
      ]);
      if (v0Info) {
        const b = new Uint8Array(v0Info.data);
        if (b.length >= 72) meta.vault0 = readU64(b, 64);
      }
      if (v1Info) {
        const b = new Uint8Array(v1Info.data);
        if (b.length >= 72) meta.vault1 = readU64(b, 64);
      }
      _stateCache.set(poolAddr, { meta, ts: Date.now() });
      return meta;
    } catch {
      return null;
    } finally {
      _stateInflight.delete(poolAddr);
    }
  })();
  _stateInflight.set(poolAddr, job);
  return job;
}

export function getCachedXdexPoolState(poolAddr: string): XdexPoolMeta | null {
  const c = _stateCache.get(poolAddr);
  return c ? c.meta : null;
}

/** Optional reverse: returns whether token1 is the "base" we want to chart. */
export function pickQuoteForChart(meta: PoolMeta, preferredBase: string): boolean {
  // If preferredBase matches token0, we want token1 / token0 ratio (default).
  // If it matches token1, invert (so the chart shows preferredBase price in the other unit).
  return meta.token1Mint === preferredBase;
}

/**
 * Fetch the 24h TWAP price history for a single xDEX pool.
 *
 * @param connection  Solana connection (from useConnection)
 * @param poolAddr    xDEX pool state account address
 * @param preferredBase  Optional — token mint we want priced. If set, the
 *                       chart will show <preferredBase>/<other> instead of
 *                       the default token1/token0 ratio.
 */
export async function fetchXdexPoolHistory(
  connection: Connection,
  poolAddr: string,
  preferredBase?: string,
): Promise<PricePoint[]> {
  const cacheKey = `${poolAddr}|${preferredBase ?? ''}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.points;
  const flight = _inflight.get(cacheKey);
  if (flight) return flight;

  const job = (async (): Promise<PricePoint[]> => {
    try {
      const poolPk = new PublicKey(poolAddr);

      // 1. Pool account — gives us observation key + decimals
      const poolInfo = await connection.getAccountInfo(poolPk, 'confirmed').catch(() => null);
      const meta = parsePoolMeta(poolInfo ? new Uint8Array(poolInfo.data) : null);
      if (!meta) return [];

      // 2. Observation account + both vaults (for current spot tail)
      const [obsInfo, v0Info, v1Info] = await Promise.all([
        connection.getAccountInfo(new PublicKey(meta.obsKey),      'confirmed').catch(() => null),
        connection.getAccountInfo(new PublicKey(meta.token0Vault), 'confirmed').catch(() => null),
        connection.getAccountInfo(new PublicKey(meta.token1Vault), 'confirmed').catch(() => null),
      ]);
      if (!obsInfo) return [];

      const d = new Uint8Array(obsInfo.data);
      // Layout: 8-byte disc + 1 init + 2 index + 32 pool_id, then 100 × 40-byte slots:
      //   ts(u64) | cum_token0_price_x32(u128) | cum_token1_price_x32(u128)
      const obsStart = 8 + 1 + 2 + 32;
      const points: PricePoint[] = [];
      let prevCum0 = 0n, prevCum1 = 0n, prevTs = 0n;
      const dec0 = meta.dec0;
      const dec1 = meta.dec1;
      for (let i = 0; i < 100; i++) {
        const off = obsStart + i * 40;
        if (off + 40 > d.length) break;
        const ts = readU64(d, off);
        if (ts === 0n) continue;
        const cum0 = BigInt('0x' + Buffer.from(d.slice(off + 8,  off + 24)).reverse().toString('hex'));
        const cum1 = BigInt('0x' + Buffer.from(d.slice(off + 24, off + 40)).reverse().toString('hex'));
        if (prevTs > 0n && cum0 > prevCum0 && cum1 > prevCum1) {
          const d0 = Number(cum0 - prevCum0);
          const d1 = Number(cum1 - prevCum1);
          // Default: token1 per token0, decimal-adjusted.
          let price = (d1 / d0) * Math.pow(10, dec0 - dec1);
          if (preferredBase && pickQuoteForChart(meta, preferredBase)) {
            // Invert so chart is preferredBase priced in the other token.
            price = price > 0 ? 1 / price : 0;
          }
          if (price > 0 && isFinite(price)) points.push({ ts: Number(ts), price });
        }
        prevCum0 = cum0; prevCum1 = cum1; prevTs = ts;
      }

      // Append current spot from vault ratio so the chart's last point is "now"
      const vault0Bytes = v0Info ? new Uint8Array(v0Info.data) : null;
      const vault1Bytes = v1Info ? new Uint8Array(v1Info.data) : null;
      if (vault0Bytes && vault1Bytes && vault0Bytes.length >= 72 && vault1Bytes.length >= 72) {
        // SPL Token / Token-2022 account layout puts the u64 amount at offset 64.
        const v0Raw = readU64(vault0Bytes, 64);
        const v1Raw = readU64(vault1Bytes, 64);
        const v0Ui = Number(v0Raw) / Math.pow(10, dec0);
        const v1Ui = Number(v1Raw) / Math.pow(10, dec1);
        if (v0Ui > 0 && v1Ui > 0) {
          let spot = v1Ui / v0Ui;
          if (preferredBase && pickQuoteForChart(meta, preferredBase)) {
            spot = spot > 0 ? 1 / spot : 0;
          }
          if (spot > 0 && isFinite(spot)) {
            points.push({ ts: Math.floor(Date.now() / 1000), price: spot });
          }
        }
      }

      _cache.set(cacheKey, { points, ts: Date.now() });
      return points;
    } catch {
      return cached?.points ?? [];
    } finally {
      _inflight.delete(cacheKey);
    }
  })();

  _inflight.set(cacheKey, job);
  return job;
}

/** Sync cache peek for instant first paint when re-rendering. */
export function getCachedXdexPoolHistory(poolAddr: string, preferredBase?: string): PricePoint[] | null {
  const cacheKey = `${poolAddr}|${preferredBase ?? ''}`;
  const c = _cache.get(cacheKey);
  if (!c) return null;
  if (Date.now() - c.ts > CACHE_TTL_MS * 5) return null; // hard cutoff = 5 min
  return c.points;
}
