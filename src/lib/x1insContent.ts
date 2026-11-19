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
  let H = W + 16, occ = new Uint8Array(W * H), ff = new Int32Array(H);
  let minRow = 0, k = 0, maxY = 0;
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
          if (y + r > maxY) maxY = y + r;
          // advance each occupied row's free front past what we just filled
          for (let yy = y; yy < y + r; yy++) if (ff[yy] === x) { let z = x + r; const b = yy * W; while (z < W && occ[b + z]) z++; ff[yy] = z; }
          placed = true; break;
        }
        x = hit + 1;
      }
    }
    // then pull minRow up past any row that is now full
    for (;;) { const b = minRow * W; let x = ff[minRow]; while (x < W && occ[b + x]) x++; ff[minRow] = x; if (x >= W) minRow++; else break; }
  }
  const rects: Rect[] = [];
  for (let i = 0; i < k; i += 3) rects.push({ x: sq[i], y: sq[i + 1], s: sq[i + 2] });
  // ⛔ W is max(W, maxY), NOT W. `raster` divides by this to get the grid step,
  // so getting it wrong misplaces and misscales every square.
  return { W: Math.max(W, maxY), rects };
}

/** Content type of several inscriptions at once — one batched read, so a map
 *  full of parcels costs a single RPC call rather than one per block. */
export async function readInscriptionTypes(conn: any, numbers: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const CHUNK = 100;
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const slice = numbers.slice(i, i + CHUNK);
    let infos: any[];
    try { infos = await conn.getMultipleAccountsInfo(slice.map(insPda), { encoding: 'base64' }); }
    catch { continue; }
    infos.forEach((info, k) => {
      const d = bytesOf(info?.data);
      if (!d || d.length < 161) return;
      const ct = new TextDecoder().decode(d.slice(96, 96 + d[160])).split(';')[0].trim();
      if (ct) out.set(slice[k], ct);
    });
  }
  return out;
}

/** The canonical map raster, ported from x1maps-web src/lib/bitmap.ts `raster()`.
 *  ⛔ KEEP IN STEP WITH THAT FILE. My first attempt at this left out the
 *  centring shift and used the wrong pad and shade factors, which puts every
 *  square — and so every piece of content drawn into one — in the wrong place. */
export function rasterMap(bytes: Uint8Array, S: number): ImageData | null {
  const lay = layoutMap(bytes);
  if (!lay.rects.length) return null;
  const px = new Uint8ClampedArray(S * S * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  const frame = Math.round(S * 0.02), inner = S - 2 * frame, g = inner / lay.W;
  const BLUE: [number, number, number] = [0x00, 0x88, 0xff];
  const GRAY: [number, number, number] = [0x8a, 0x8a, 0x92];
  const shaded = (c: [number, number, number], dark: number): [number, number, number] => {
    const f = 1 - 0.095 * Math.min(4, dark); return [c[0] * f, c[1] * f, c[2] * f];
  };
  // centre the drawing both ways — maps sit in the middle, not stuck to the left/top
  let usedW = 0, usedH = 0;
  for (const r of lay.rects) { usedW = Math.max(usedW, r.x + r.s); usedH = Math.max(usedH, r.y + r.s); }
  const shift = (lay.W - usedW) / 2, shiftY = (lay.W - usedH) / 2;
  const pad = g >= 4 ? g / 4 : 0;
  lay.rects.forEach((r, k) => {
    const c = shaded((bytes[k] >> 4) & 1 ? GRAY : BLUE, bytes[k] >> 5);
    const L = frame + Math.round((r.x + shift) * g + pad), T = frame + Math.round((r.y + shiftY) * g + pad);
    let R = frame + Math.round((r.x + shift + r.s) * g - pad), B = frame + Math.round((r.y + shiftY + r.s) * g - pad);
    if (!pad && R - L >= 3) { R--; B--; }
    // tiny squares draw as an even dot grid: thousands of touching 1-2px squares
    // read as one smear, and a gap each made stripes
    if (!pad && R - L <= 2) {
      for (let y = T; y < Math.min(B, S); y++) { if ((y - frame) & 1) continue; for (let x = L; x < Math.min(R, S); x++) { if ((x - frame) & 1) continue; const o = (y * S + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; } }
      return;
    }
    const ring = R - L >= 8 ? 1 : 0;   // one crisp darker inner edge
    for (let y = T; y < Math.min(B, S); y++) for (let x = L, o = (y * S + L) * 4; x < Math.min(R, S); x++, o += 4) {
      const d = Math.min(x - L, R - 1 - x, y - T, B - 1 - y), f = d >= ring ? 1 : 0.7;
      px[o] = c[0] * f; px[o + 1] = c[1] * f; px[o + 2] = c[2] * f;
    }
  });
  return new ImageData(px, S, S);
}

/** Where each square sits in the 1000-unit box the overlay uses — the same
 *  geometry `rasterMap` draws, so a thumbnail lands exactly on its square at
 *  any display size. frame 20 + g 960/W, matching bitmap.ts's 2% frame. */
export function overlayBoxes(bytes: Uint8Array): { n: number; x: number; y: number; r: number }[] {
  const lay = layoutMap(bytes);
  let usedW = 0, usedH = 0;
  for (const r of lay.rects) { usedW = Math.max(usedW, r.x + r.s); usedH = Math.max(usedH, r.y + r.s); }
  const frame = 20, g = 960 / lay.W, ox = (lay.W - usedW) / 2, oy = (lay.W - usedH) / 2;
  return lay.rects.map((r, i) => ({ n: i + 1, x: frame + (r.x + ox) * g, y: frame + (r.y + oy) * g, r: r.s * g }));
}
