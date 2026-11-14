// X1 Inscriptions program data the portfolio needs (owner 10-24):
//  · which Token-2022 mints are X1-20 tokens bridged out of X1 Inscriptions (→ an "X1-20 INSCRIPTION" badge)
//  · X1-20 balances still held AS inscriptions (BRC-20 style, inside the program — no token account, so the token
//    scan never sees them)
// Layouts VERIFIED against the deployed mainnet program on 2026-11-14
// (x1-bitmaps/program/programs/program_v0/src/lib.rs, MAX_TICK = 10):
//   Token   { tick [u8;10] @8, tick_len u8 @18, … }
//   Balance { tick [u8;10] @8, owner @18, available u64 @50, locked u64 @58,
//             mints u32 @66, bump @70 }  -> 71 bytes, confirmed on chain.
// ⛔ MAX_TICK moved 5 -> 10, so every field after `tick` shifted. Reading the
// old offsets against mainnet returns garbage: owner decodes to 11111XmL8mXK…
// and available to 839609634484865537. Re-verify these if MAX_TICK ever moves
// again — and it must not, now that real tokens exist.
// Token also carries `home: Option<u64>`, which writes ONE byte when None and
// shifts everything after it; nothing here reads past tick_len, so it is safe.
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// Mainnet. Verified live 2026-11-14: executable, 2,219 program accounts.
// (The old value EXB36Zz… is the TESTNET id and has no account on mainnet at
//  all, so every query silently returned zero rows and the panel never showed.)
export const INS_PROGRAM = new PublicKey('X1insUpfkQqtsuUJvwA8A3kbnixk3qtuexex1NDJWvN');
export const INS_SITE = 'https://www.x1inscriptions.io';
const DISC_TOKEN = bs58.encode(Uint8Array.from([131, 254, 39, 144, 4, 179, 134, 127]));
const DISC_BALANCE = bs58.encode(Uint8Array.from([127, 71, 25, 157, 105, 157, 241, 182]));
const enc = new TextEncoder();
export const x120MintOf = (tick: string) => PublicKey.findProgramAddressSync([enc.encode('mint'), enc.encode(tick)], INS_PROGRAM)[0].toBase58();
const raw = (d: any): Uint8Array => (d instanceof Uint8Array ? d : Uint8Array.from(atob(d[0]), c => c.charCodeAt(0)));

let ticksP: Promise<string[]> | null = null;
/** every X1-20 ticker deployed on X1 Inscriptions (cached for the page's life) */
export function x120Ticks(connection: any): Promise<string[]> {
  return (ticksP ??= connection.getProgramAccounts(INS_PROGRAM, { encoding: 'base64', dataSlice: { offset: 8, length: 11 },
    filters: [{ memcmp: { offset: 0, bytes: DISC_TOKEN } }] })
    .then((rows: any[]) => rows.map(r => { const b = raw(r.account.data); return new TextDecoder().decode(b.subarray(0, b[10])) }))
    .catch(() => { ticksP = null; return [] }));
}

/** mint address → ticker, for every X1-20 token's Token-2022 bridge mint (exists whether or not it's bridged yet) */
export async function x120Mints(connection: any): Promise<Map<string, string>> {
  return new Map((await x120Ticks(connection)).map(t => [x120MintOf(t), t]));
}

export interface X120Balance { tick: string; available: number; locked: number; mints: number }
/** the wallet's X1-20 balances held as inscriptions inside the program */
export async function x120Balances(connection: any, owner: PublicKey): Promise<X120Balance[]> {
  const rows = await connection.getProgramAccounts(INS_PROGRAM, { encoding: 'base64', filters: [
    { memcmp: { offset: 0, bytes: DISC_BALANCE } }, { memcmp: { offset: 18, bytes: owner.toBase58() } }] });
  return rows.map((r: any) => {
    const b = raw(r.account.data), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tick = new TextDecoder().decode(b.subarray(8, 18)).replace(/\0+$/, '');
    return { tick, available: Number(dv.getBigUint64(50, true)), locked: Number(dv.getBigUint64(58, true)), mints: dv.getUint32(66, true) };
  }).filter((x: X120Balance) => x.available + x.locked > 0).sort((a: X120Balance, b: X120Balance) => b.available - a.available);
}
