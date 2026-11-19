// Read an X1MAPS map, its parcels and the inscriptions inside them — straight
// from the X1 chain. No x1inscriptions.io, no Arweave, no IPFS.
//
// A PARCEL IS ONE BLOCK OF A MAP. A map is packed into squares by the art rule;
// parcel n is square n-1. A parcel can hold an inscription, and on mainnet every
// parcel that exists holds one (37 of 37 on 2026-11-18: 30 webp, 5 mp4, 1 png,
// 1 m4a). So drawing a map as flat coloured blocks, or a parcel as a dot on a
// dimmed map, hides the thing being sold every single time.
//
// Offsets below are the program's, same as packages/x1-inscriptions-reader:
//   ["map", u64 height]            total length @16, sealed @56, bytes from 58
//   ["parcel", u64 height, u32 n]  creator @20..52, filled @52, content u64 @53
//   ["ins", u64 n]                 contentType @96 (len @160), size @161,
//                                  sealed @169, encoding @178 (bit0 gzip,
//                                  bit7 pieces), small bodies from 212
//   ["part", u64 n, u32 k]         10,200 bytes each from offset 23
import { Connection, PublicKey } from '@solana/web3.js';
import { INS_PROGRAM } from './x1inscriptions';

const enc = new TextEncoder();
const u64 = (n: number | bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };

export const mapPda    = (height: number) => PublicKey.findProgramAddressSync([enc.encode('map'), u64(height)], INS_PROGRAM)[0];
export const parcelPda = (height: number, n: number) => PublicKey.findProgramAddressSync([enc.encode('parcel'), u64(height), u32(n)], INS_PROGRAM)[0];
export const insPda    = (n: number) => PublicKey.findProgramAddressSync([enc.encode('ins'), u64(n)], INS_PROGRAM)[0];
export const partPda   = (n: number, k: number) => PublicKey.findProgramAddressSync([enc.encode('part'), u64(n), u32(k)], INS_PROGRAM)[0];

const bytesOf = (data: any): Uint8Array | null => {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data) && typeof data[0] === 'string') return Uint8Array.from(atob(data[0]), c => c.charCodeAt(0));
  if (typeof data === 'string') return Uint8Array.from(atob(data), c => c.charCodeAt(0));
  try { return Uint8Array.from(data); } catch { return null; }
};

/** The map's square bytes once baked on chain, else null. One byte per square:
 *  low nibble = size, bit 4 = token(gray)/XNT(blue), top 3 bits = shade. */
export async function readMapBytes(conn: any, height: number): Promise<Uint8Array | null> {
  try {
    const info = await conn.getAccountInfo(mapPda(height));
    const d = bytesOf(info?.data);
    if (!d || d.length < 58) return null;
    if (d[56] !== 1) return null;                       // not sealed: nothing baked yet
    const len = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(16, true);
    if (!len || 58 + len > d.length) return null;
    return d.slice(58, 58 + len);
  } catch { return null; }
}

export interface ParcelInfo { n: number; filled: boolean; content: number | null }

/** Every parcel of a map that has been created, by block number. */
export async function readParcels(conn: any, height: number, squareCount: number): Promise<Map<number, ParcelInfo>> {
  const out = new Map<number, ParcelInfo>();
  const ns = Array.from({ length: squareCount }, (_, i) => i + 1);
  const CHUNK = 100;
  for (let i = 0; i < ns.length; i += CHUNK) {
    const slice = ns.slice(i, i + CHUNK);
    let infos: any[];
    try { infos = await conn.getMultipleAccountsInfo(slice.map(n => parcelPda(height, n)), { encoding: 'base64' }); }
    catch { continue; }
    infos.forEach((info, k) => {
      const d = bytesOf(info?.data);
      if (!d || d.length < 61) return;
      const filled = d[52] === 1;
      const content = filled ? Number(new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(53, true)) : null;
      out.set(slice[k], { n: slice[k], filled, content });
    });
  }
  return out;
}

export interface Inscription { contentType: string; size: number; sealed: boolean; bytes: Uint8Array | null }

/** One inscription's content type and bytes (pieces joined, gzip undone).
 *  ⛔ Reading a large one costs a `["part"]` account per 10,200 bytes — a 2.8 MB
 *  audio inscription is ~274 accounts. Fine on a detail view, far too heavy for
 *  a grid, so callers pass `maxBytes` to skip anything they can't afford. */
export async function readInscription(conn: any, n: number, maxBytes = Infinity): Promise<Inscription | null> {
  let head: Uint8Array | null;
  try { head = bytesOf((await conn.getAccountInfo(insPda(n)))?.data); } catch { return null; }
  if (!head || head.length < 212) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const ctLen = head[160];
  const contentType = new TextDecoder().decode(head.slice(96, 96 + ctLen)).split(';')[0].trim();
  const size = v.getUint32(161, true);
  const sealed = head[169] === 1;
  const encoding = head[178];
  const base: Inscription = { contentType, size, sealed, bytes: null };
  if (!sealed || size > maxBytes) return base;

  let raw: Uint8Array;
  if (encoding & 0x80) {                                 // split across ["part"] accounts
    const PIECE = 10_200;
    const count = Math.ceil(size / PIECE);
    const parts: Uint8Array[] = [];
    const CHUNK = 100;
    for (let i = 0; i < count; i += CHUNK) {
      const keys = Array.from({ length: Math.min(CHUNK, count - i) }, (_, k) => partPda(n, i + k));
      let infos: any[];
      try { infos = await conn.getMultipleAccountsInfo(keys, { encoding: 'base64' }); } catch { return base; }
      for (const info of infos) {
        const d = bytesOf(info?.data);
        if (!d || d.length <= 23) return base;           // a hole: refuse rather than return zero-filled art
        parts.push(d.slice(23));
      }
    }
    const joined = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0; for (const p of parts) { joined.set(p, o); o += p.length; }
    raw = joined.slice(0, (encoding & 1) ? joined.length : size);
  } else {
    raw = head.slice(212, 212 + ((encoding & 1) ? head.length - 212 : size));
  }

  if (encoding & 1) {                                     // gzip
    try {
      const ds = new DecompressionStream('gzip');
      const buf = await new Response(new Blob([raw as any]).stream().pipeThrough(ds)).arrayBuffer();
      raw = new Uint8Array(buf);
    } catch { return base; }
  }
  return { ...base, bytes: raw.slice(0, size) };
}

export interface Rect { x: number; y: number; s: number }
export interface MapLayout { W: number; rects: Rect[] }

/** The art rule's normative layout — a straight port of x1maps-web src/lib/bitmap.ts
 *  `pack()`. Parcel n is rects[n-1]. Keep in step with that file: if the two
 *  disagree, content gets drawn into the wrong block. */
export function layoutMap(bytes: Uint8Array): MapLayout {
  const txs = Uint8Array.from(bytes, x => x & 15);
  let area = 0;
  for (const t of txs) area += t * t;
  const W = Math.max(1, Math.ceil(Math.sqrt(area)));
  let H = W + 16, occ = new Uint8Array(W * H), ff = new Int32Array(H), minRow = 0, k = 0;
  const sq = new Int32Array(txs.length * 3);
  for (const r of txs) {
    let placed = false;
    for (let y = minRow; !placed; y++) {
      if (y + r > H) { const o = new Uint8Array(W * H * 2); o.set(occ); occ = o; const f = new Int32Array(H * 2); f.set(ff); ff = f; H *= 2; }
      let x = ff[y];
      while (x + r <= W) {
        let hit = -1;
        for (let yy = y; yy < y + r && hit < 0; yy++) { const b = yy * W; for (let xx = x + r - 1; xx >= x; xx--) if (occ[b + xx]) { hit = xx; break; } }
        if (hit < 0) {
          for (let yy = y; yy < y + r; yy++) occ.fill(1, yy * W + x, yy * W + x + r);
          sq[k++] = x; sq[k++] = y; sq[k++] = r;
          placed = true;
          break;
        }
        x = hit + 1;
      }
      if (!placed) ff[y] = W;
      while (ff[minRow] >= W) minRow++;
    }
  }
  const rects: Rect[] = [];
  for (let i = 0; i < sq.length; i += 3) rects.push({ x: sq[i], y: sq[i + 1], s: sq[i + 2] });
  return { W, rects };
}

/** `…/api/nft/parcel/<height>/<n>.json` → the block it is. */
export function parcelOfUri(uri: string): { height: number; n: number } | null {
  const m = /\/parcel\/(\d+)\/(\d+)\.json$/.exec(uri || '');
  return m ? { height: Number(m[1]), n: Number(m[2]) } : null;
}
/** `…/api/nft/block/<height>.json` → the map it is. */
export function mapOfUri(uri: string): number | null {
  const m = /\/block\/(\d+)\.json$/.exec(uri || '');
  return m ? Number(m[1]) : null;
}

/** The inscription a parcel holds, served with its real content type.
 *  This is the same thing x1inscriptions.io puts in the parcel's
 *  `animation_url` — the content, not the spotlight picture of the block. */
export const contentUrl = (insNumber: number) => `https://www.x1inscriptions.io/api/ins/${insNumber}`;

/** For a listed parcel: the URL of whatever is inscribed in it, or null when the
 *  block is empty. ⛔ Every parcel on mainnet is filled (37 of 37), so the null
 *  branch is the rare one, not the common one. */
export async function parcelContentUrl(conn: any, uri: string): Promise<string | null> {
  const p = parcelOfUri(uri);
  if (!p) return null;
  try {
    const info = await conn.getAccountInfo(parcelPda(p.height, p.n));
    const d = bytesOf(info?.data);
    if (!d || d.length < 61 || d[52] !== 1) return null;
    const n = Number(new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(53, true));
    return contentUrl(n);
  } catch { return null; }
}
