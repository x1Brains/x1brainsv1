import { PublicKey } from '@solana/web3.js';

/** Metaplex Core. x1 Inscriptions assets — inscriptions, maps, districts,
 *  parcels, editions — all live here, not in SPL. */
export const CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

export interface CoreAsset {
  /** the asset address (used as `nftMint` everywhere downstream) */
  address:    string;
  owner:      string;
  name:       string;
  uri:        string;
  /** the collection, when the update authority is one */
  collection?: string;
  /** advertised royalty, read off the asset's own plugin registry */
  royaltyBps?:     number;
  royaltyCreator?: string;
  /** true when a plugin makes this asset untransferable, so it can't be listed */
  frozen:     boolean;
}

/**
 * Parse a Core AssetV1 account.
 *
 * Layout verified byte-for-byte against 23 live mainnet x1maps (2026-11-18) —
 * the same layout `core_royalty` parses in the program, deliberately kept in
 * step with it.
 *
 * ⛔ The Royalties plugin data begins with a plugin-discriminator byte. Skip it
 * and basis_points reads one byte early and yields 62464 instead of 500.
 */
export function parseCoreAsset(address: string, data: Uint8Array): CoreAsset | null {
  try {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    // a burned asset is a single zero byte
    if (d.length < 34 || d[0] !== 1) return null;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const str = (o: number): [string, number] => {
      const n = dv.getUint32(o, true);
      if (n > 4096 || o + 4 + n > d.length) throw new Error('bad string');
      return [new TextDecoder().decode(d.slice(o + 4, o + 4 + n)), o + 4 + n];
    };

    const owner = new PublicKey(d.slice(1, 33)).toBase58();
    let o = 33;
    const uaKind = d[o]; o += 1;
    let collection: string | undefined;
    if (uaKind === 2 || uaKind === 3) {
      if (uaKind === 2) collection = new PublicKey(d.slice(o, o + 32)).toBase58();
      o += 32;
    }
    let name: string, uri: string;
    [name, o] = str(o);
    [uri,  o] = str(o);
    if (d[o] === 1) o += 9; else o += 1;          // Option<seq>

    const asset: CoreAsset = { address, owner, name, uri, collection, frozen: false };

    // PluginHeaderV1 (key 3) -> PluginRegistryV1 (key 4)
    if (d[o] !== 3) return asset;                 // no plugins at all
    const reg = Number(dv.getBigUint64(o + 1, true));
    if (reg + 5 > d.length || d[reg] !== 4) return asset;
    let r = reg + 1;
    const n = dv.getUint32(r, true); r += 4;
    if (n > 32) return asset;

    for (let i = 0; i < n; i++) {
      const ptype = d[r]; r += 1;
      const auth  = d[r]; r += 1;
      if (auth === 3) r += 32;
      const off = Number(dv.getBigUint64(r, true)); r += 8;
      if (off >= d.length) continue;

      if (ptype === 0) {                          // Royalties
        let p = off;
        if (d[p] !== 0) continue;                 // plugin discriminator
        p += 1;
        const bps = dv.getUint16(p, true); p += 2;
        const nc  = dv.getUint32(p, true); p += 4;
        if (bps > 0 && bps <= 10_000 && nc >= 1 && nc <= 8 && p + 32 <= d.length) {
          asset.royaltyBps     = bps;
          asset.royaltyCreator = new PublicKey(d.slice(p, p + 32)).toBase58();
        }
      }
      // FreezeDelegate (1) / PermanentFreezeDelegate (5) both carry `frozen: bool`.
      // ⛔ A frozen asset can never be escrowed: release masters, soulbound items
      // and inscriptions that have not been sealed yet. Flag it so the UI can say
      // so instead of letting the wallet throw.
      if ((ptype === 1 || ptype === 5) && d[off] === 1) asset.frozen = true;
    }
    return asset;
  } catch {
    return null;
  }
}

/** Every live Core asset in a wallet. Core has no token accounts, so this is a
 *  `getProgramAccounts` scan filtered on the owner field at offset 1. */
export async function fetchCoreAssets(connection: any, owner: PublicKey): Promise<CoreAsset[]> {
  try {
    const accs = await connection.getProgramAccounts(CORE_PROGRAM_ID, {
      filters: [{ memcmp: { offset: 1, bytes: owner.toBase58() } }],
    });
    const out: CoreAsset[] = [];
    for (const a of accs) {
      const addr = (a.pubkey?.toBase58?.() ?? String(a.pubkey));
      const raw  = a.account?.data;
      const d = raw instanceof Uint8Array ? raw
              : Array.isArray(raw) && typeof raw[0] === 'string'
                ? Uint8Array.from(atob(raw[0]), c => c.charCodeAt(0))
                : typeof raw === 'string' ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
                : null;
      if (!d) continue;
      const parsed = parseCoreAsset(addr, d);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}
