import { IPFS_GATEWAYS, RARITY_TIERS } from '../constants';

export function extractIpfsCid(uri: string): string | null {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.slice(7).split('?')[0].split('/')[0];
  const ipfsPath = uri.match(/\/ipfs\/([a-zA-Z0-9]{44,})/);
  if (ipfsPath) return ipfsPath[1].split('?')[0];
  return null;
}

export function resolveUri(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const cid = extractIpfsCid(s);
  if (cid) return `${IPFS_GATEWAYS[0]}${cid}`;
  if (s.startsWith('ar://')) return `https://arweave.net/${s.slice(5)}`;
  if (s.startsWith('/')) return `https://api.xdex.xyz${s}`;
  return s;
}

export async function fetchOffChainLogo(uri: string): Promise<string | undefined> {
  const urls: string[] = [];
  const cid = extractIpfsCid(uri);
  if (cid) { IPFS_GATEWAYS.forEach(gw => urls.push(`${gw}${cid}`)); }
  else if (uri.startsWith('ar://')) { urls.push(`https://arweave.net/${uri.slice(5)}`); }
  else if (uri.startsWith('http')) { urls.push(uri); }
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const json = await r.json();
      const raw: string = json?.image || json?.logoURI || json?.logo || json?.icon || '';
      if (!raw) continue;
      const logoCid = extractIpfsCid(raw);
      if (logoCid) return `${IPFS_GATEWAYS[0]}${logoCid}`;
      if (raw.startsWith('ar://')) return `https://arweave.net/${raw.slice(5)}`;
      if (raw.startsWith('http')) return raw;
      return raw;
    } catch { continue; }
  }
  return undefined;
}

export async function fetchWithTimeout(url: string, ms = 5000): Promise<any> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(id); }
}

export type RarityTier = typeof RARITY_TIERS[keyof typeof RARITY_TIERS];

export function getRarityTier(score: number): RarityTier {
  if (score >= RARITY_TIERS.LEGENDARY.minScore) return RARITY_TIERS.LEGENDARY;
  if (score >= RARITY_TIERS.EPIC.minScore)      return RARITY_TIERS.EPIC;
  if (score >= RARITY_TIERS.RARE.minScore)      return RARITY_TIERS.RARE;
  if (score >= RARITY_TIERS.UNCOMMON.minScore)  return RARITY_TIERS.UNCOMMON;
  return RARITY_TIERS.COMMON;
}

export function shortAddress(address: string, start = 6, end = 4): string {
  return `${address.slice(0, start)}…${address.slice(-end)}`;
}
