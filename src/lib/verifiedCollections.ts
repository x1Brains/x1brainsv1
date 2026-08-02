// Verified X1 NFT collections registry.
// Imported from Solaris Prime's public indexer (https://solarisprime.xyz/api/indexer/collections)
// — the authoritative list of allowed/verified X1 collections.
// Each collection can be identified by:
//   - mint address (exact match — catches collection-root NFTs)
//   - metaUri host substring
//   - NFT name prefix (catches individual NFTs like "X1Cat #01002")

export type VerifiedCollection = {
  id: string;
  name: string;
  hosts: string[];
  namePrefixes: string[];
  mints?: string[];        // collection root / master mint(s)
  color: string;
  /** Collection portrait, when the source registry supplies one. */
  image?: string;
  /** True when this entry came from the live Solaris sync rather than the
   *  hardcoded list below — used only for diagnostics/labelling. */
  dynamic?: boolean;
};

// Per-collection palette — accent color used for verified badges.
const C_ORANGE = '#f29030';
const C_CYAN   = '#00d4ff';
const C_PURPLE = '#bf5af2';
const C_GREEN  = '#00c98d';
const C_RED    = '#ff4444';
const C_YELLOW = '#ffb700';
const C_PINK   = '#ec4899';

export const VERIFIED_COLLECTIONS: VerifiedCollection[] = [
  // ─── X1 Native (legacy / OG) ───────────────────────────────────────────
  {
    id: 'x1punks', name: 'X1 Punks',
    hosts: ['raw.githubusercontent.com/Execute007/x1punks-images', 'x1punks.xyz'],
    namePrefixes: ['x1 punk', 'x1punk'],
    mints: ['G3XMBwczzpoy4iJkBz6Diw9WYo3GqASKzoUW1oHfUD5y'],
    color: C_PURPLE,
  },
  {
    id: 'x1cats', name: 'X1 Cats',
    hosts: ['api.x1app.fyi/v0/cats'],
    namePrefixes: ['x1cat', 'x1 cat'],
    mints: ['CatSy7eT97eyvpSymXDvt14LGyC2PBJm5kxw72FvyeoR'],
    color: C_ORANGE,
  },
  {
    id: 'x1pups', name: 'X1 Pups',
    hosts: ['x1pups.vercel.app'],
    namePrefixes: ['x1pup', 'x1 pup', 'pup_'],
    mints: ['grXpCJGHZEYXwPTasxRV8mpPrxy5XKzD8mBHHoJ2Li2'],
    color: C_CYAN,
  },
  {
    id: 'x1ns', name: 'X1NS Domains',
    hosts: [],
    namePrefixes: ['.x1', 'x1ns'],
    mints: ['64MaYJLnZfwq4wQ6Xy6jeJcMudNPuouR9R9mZARpVkTk'],
    color: C_CYAN,
  },
  {
    id: 'x1og', name: 'X1OG Collection',
    hosts: ['ivory-acceptable-roadrunner-771.mypinata.cloud'],
    namePrefixes: ['x1og'],
    mints: ['2SQcyy46JhEQx2jqC9M29p65p1gyjoUYUb8rUMj4A4dc'],
    color: C_YELLOW,
  },
  {
    id: 'x1eggs', name: 'X1 Eggs',
    hosts: [],
    namePrefixes: ['x1 egg', 'x1egg'],
    mints: ['H9LqmfpW2PuKDwEXggQ1gjhhH7b3LUqgqxitVfkDWSEb'],
    color: C_GREEN,
  },
  {
    id: 'x1memes', name: 'X1 Memes',
    hosts: ['solarisprime.xyz/ipfs/bafkreihgzn23tm424ulp24kpkf25ccfv4vou6dvgwz57j7sepe3qd5mm2e'],
    namePrefixes: ['x1 meme', 'x1meme'],
    mints: ['4YZmm8n4fUmJUChnv4w2J8xe8fYRK1PbrmF1bjddy9Za'],
    color: C_PINK,
  },
  {
    id: 'x1comm', name: 'X1 Community',
    hosts: ['solarisprime.xyz/ipfs/bafkreibuff7flvo5zwrdw7wmn5kwxn2aoacxnz2gjfja2tnu3akr6qh2wu'],
    namePrefixes: ['x1 community', 'x1comm'],
    mints: ['Be3wkFaz6UgZEWd1PCyg9cy8wyE7siKhs11VnZwXv4zE'],
    color: C_CYAN,
  },
  {
    id: 'x1gnomies', name: 'X1 Gnomie Homies',
    hosts: ['gateway.pinata.cloud/ipfs/QmdFav9AwNgzKzQygivhb5tX3T6uZz6SuvpbkMSzfSEebA'],
    namePrefixes: ['gnomie', 'ghomie'],
    mints: ['4KYeU8MHfBjwsiiDf2H9PKqeewrdeRjrB6jw166ihfU8'],
    color: C_GREEN,
  },

  // ─── Brains Ecosystem ─────────────────────────────────────────────────
  {
    id: 'brains_elites', name: 'Brains Elites',
    hosts: ['pub-001d9ad5c23d4cd18a5ee009975a5002.r2.dev'],
    namePrefixes: ['brains elites', 'brains elite'],
    mints: [
      'C81ej1KJsDnjtEzjKYZShWRySpet3bVekj1kS7Cbq39Z',
      'GVFrCyN6JXoHX2zDyXQTvw3HK6is3Um7aDVhTdQwyNLL',
    ],
    color: C_YELLOW,
  },
  {
    id: 'lab_work', name: 'LabWork',
    hosts: ['moltlab.vercel.app'],
    namePrefixes: ['lab work', 'labwork'],
    color: C_GREEN,
  },

  // ─── X1 Community Collections (from Solaris) ──────────────────────────
  {
    id: 'beetle', name: 'Beetle',
    hosts: ['solarisprime.xyz/ipfs/QmaiieuWcR6HQhdN99wDPaY1P42hx4A6abLMofuVomBPwK'],
    namePrefixes: ['beetle'],
    mints: ['5LA7LEWqVW1N8vgFNAxG44Er397spsRFnJgNgJpttqWq'],
    color: C_PURPLE,
  },
  {
    id: 'capy_warriors', name: 'Capy Warriors',
    hosts: ['gateway.lighthouse.storage/ipfs/QmRL9ZbbJwrQArftwGKWcDbU6PSTGWyo7GrWjBfxPRbTAY'],
    namePrefixes: ['capy warrior', 'capy'],
    mints: ['EEpfRYWRqP6X8ExCJsoNDPpqB6cyb71FDw18sNcfgxTH'],
    color: C_ORANGE,
  },
  {
    id: 'degen_skulls', name: 'Degen Skulls Bridge',
    hosts: ['gateway.pinata.cloud/ipfs/bafkreihivmbqutyvb5pc26pudh3cyv57zj47puihsta2pdyipqwdo7cegi'],
    namePrefixes: ['degen skull', 'dskull'],
    mints: ['AmUJeLgVL2F24myov5pjPQHZZ2iLi6pgyzKZWZS8yrus'],
    color: C_RED,
  },
  {
    id: 'lizards', name: 'Lizards',
    hosts: ['gateway.pinata.cloud/ipfs/QmfLAkn9Udcbsf7k1zZnkyNANoFodYQdDfp2sTnKD6h7XK'],
    namePrefixes: ['lizard', 'lzrd'],
    mints: ['Dr6K6vjKneVFbKofertRGabcTL93XWFywMcsXwppRG6w'],
    color: C_GREEN,
  },
  {
    id: 'moltlings', name: 'Moltlings',
    hosts: ['moltlab.vercel.app'],
    namePrefixes: ['moltling', 'molt'],
    mints: ['6Cm3GK1m3E2iMizNHNcGYsm8WNKekzWebc8AJK6sdrab'],
    color: C_GREEN,
  },
  {
    id: 'neurogenesis', name: 'Neurogenesis',
    hosts: ['solarisprime.xyz/ipfs/bafkreihbeya6ys7opvjzbhyduwc4a2rrmydnec7g3dxrsw3ltwavtvtwzq'],
    namePrefixes: ['neurogenesis', 'neuro'],
    mints: ['HSSCEBMh2uQcWPRXHpKCZqSLjwskEBRqgXNdH6tjPmRs'],
    color: C_PURPLE,
  },
  {
    id: 'pepe_coins', name: 'Pepe Coins',
    hosts: ['permagate.io'],
    namePrefixes: ['pepe', 'pepecoin'],
    mints: ['DxruoXVfmkwtuhk2ibsDJjMaoTprJHaPG9tVEXwahXQD'],
    color: C_GREEN,
  },
  {
    id: 'planets', name: 'Planets',
    hosts: ['gateway.pinata.cloud/ipfs/QmcY2Rjfmi65SPZHNPRffMsyGeUnMFk2MuZPfuXmnfVnoy'],
    namePrefixes: ['planet'],
    mints: ['CNZBLV2BUrWGNsZotRxUkS5kFAH2mzCYaUQpGyRUv1RN'],
    color: C_CYAN,
  },
  {
    id: 'platinum', name: 'Platinum',
    hosts: ['gateway.pinata.cloud/ipfs/QmPAPt4TV2evjekLkhkCuVYvod1ad2yekbeKXLSTh9XhbP'],
    namePrefixes: ['platinum', 'platnft'],
    mints: ['BWxbrYGk3ZxZS3DH2oK6qm779JiNLmxrzBREP4YE7rRJ'],
    color: C_YELLOW,
  },
  {
    id: 'platinum_relic', name: 'Platinum Relic',
    hosts: [],
    namePrefixes: ['platinum relic', 'platart'],
    mints: ['66V9NAUbwJiAqRJbx5VMQ57wqksZdnXH3ZNPSs8aJfdU'],
    color: C_YELLOW,
  },
  {
    id: 'rise_phoenix', name: 'RISE Phoenix',
    hosts: ['gateway.lighthouse.storage/ipfs/QmYmbswNT54jgpXTvMFgzS6XK9tr7S5L2CpphHQLinweeV'],
    namePrefixes: ['rise phoenix', 'rise'],
    mints: ['7m8h2Rf5w4UzPqS9EVMVkHwaKhhfvrJiwoc8Qvapkxoh'],
    color: C_RED,
  },
  {
    id: 'red_dragon', name: 'Red Dragon',
    hosts: ['gateway.pinata.cloud/ipfs/QmSkReAiePkbSETRMAsfaVZnd6d9AsdyYU6pYGh2pn9HVc'],
    namePrefixes: ['red dragon', 'rdrgn'],
    mints: ['FnB3m34hFR3pWxEbj2NVeFfzSHVD4ANGZyNBSMQJYrKr'],
    color: C_RED,
  },
  {
    id: 'scarabeo', name: 'Scarabeo',
    hosts: ['gateway.pinata.cloud/ipfs/QmZUmrsQMEpaXGVDPNTJEEAmoaeVNGCsZ3Cg9zqnMr2sEz'],
    namePrefixes: ['scarabeo', 'scrb'],
    mints: ['EbrKyfLZBDgzAcdoCPPuL8pRcY6Jc4jPBXnhGM3yurpL'],
    color: C_CYAN,
  },
  {
    id: 'absolutely_feral', name: 'Absolutely Feral',
    hosts: [],
    namePrefixes: ['absolutely feral', 'feral'],
    color: C_RED,
  },
];

// ═══════════════════════════════════════════════════════════════════════
//  DYNAMIC REGISTRY — auto-synced from the Solaris indexer at runtime.
// ═══════════════════════════════════════════════════════════════════════
// The hardcoded list above is a *snapshot*, so every collection that launched
// after it was written (FEDS, PotatoVamp, …) fell through `identifyCollection`
// as null → hidden behind the VERIFIED browse filter and absent from the
// collection rail, until someone hand-edited this file.
//
// `registerDynamicCollections()` folds the live Solaris allowlist in on top,
// so a brand-new collection becomes visible the moment Solaris indexes it.
// Rules:
//   • The hardcoded entries always WIN — their `id` (e.g. `brains_elites`)
//     and accent colour are load-bearing elsewhere in the UI, so a Solaris
//     row whose name/symbol/mint matches a static entry is *aliased* onto it
//     rather than creating a rival bucket.
//   • Solaris ships several duplicate rows per collection (same name, extra
//     collection_keys, `allowed:false`). Every key is registered for lookup,
//     but only the allowed/verified row supplies the name + portrait.

export type DynamicCollectionInput = {
  key: string;
  name?: string;
  symbol?: string;
  image?: string;
  verified?: boolean;
  allowed?: boolean;
};

const dynamicByKey    = new Map<string, VerifiedCollection>();
const dynamicByName   = new Map<string, VerifiedCollection>();
const dynamicBySymbol = new Map<string, VerifiedCollection>();
/** Collection portrait keyed by Solaris collection_key AND by our bucket id. */
const imageByKey      = new Map<string, string>();

/** Bumped on every successful sync so React memos can depend on it. */
let dynamicRevision = 0;
export function getDynamicRevision(): number { return dynamicRevision; }

const PALETTE = [C_ORANGE, C_CYAN, C_PURPLE, C_GREEN, C_RED, C_YELLOW, C_PINK];
/** Stable per-collection accent — same key always gets the same colour. */
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** Collection portraits arrive as bare `ipfs://` / `ar://` URIs (X1Cats is
 *  `ipfs://QmTvuas…`). Those are dead in an <img src>, so resolve to an HTTP
 *  gateway here — at the registry boundary — rather than at each call site. */
function gatewayUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  return u
    .replace(/^ipfs:\/\//, 'https://nftstorage.link/ipfs/')
    .replace(/^ar:\/\//,   'https://arweave.net/');
}

/** Find the hardcoded entry a Solaris row corresponds to, if any. */
function staticMatchFor(c: DynamicCollectionInput): VerifiedCollection | null {
  const n = norm(c.name);
  const s = norm(c.symbol);
  for (const v of VERIFIED_COLLECTIONS) {
    if (v.mints?.includes(c.key)) return v;
    if (n && norm(v.name) === n) return v;
    if (n && v.namePrefixes.some(p => n.startsWith(p))) return v;
    if (s && v.namePrefixes.some(p => s.startsWith(p))) return v;
  }
  return null;
}

/**
 * Merge the live Solaris collection list into the registry. Idempotent —
 * safe to call on every load. Only collections Solaris marks `badge_verified`
 * or `allowed` are trusted; the rest stay uncategorized.
 */
export function registerDynamicCollections(cols: DynamicCollectionInput[]): void {
  const before = dynamicRevision;
  const bump = () => { if (dynamicRevision === before) dynamicRevision++; };

  // ── Group duplicate rows ────────────────────────────────────────────
  // Solaris publishes several rows per collection — same name + symbol,
  // different collection_key, most with `allowed:false` (FEDS has 3, Brains
  // Elites has 4). They must collapse into ONE bucket, otherwise the same
  // collection splits in the rail depending on which key a given NFT reports.
  // Named rows group by name; unnamed rows can only stand alone.
  const groups = new Map<string, DynamicCollectionInput[]>();
  for (const c of cols) {
    if (!c.key) continue;
    if (c.verified !== true && c.allowed !== true) continue;  // untrusted
    const g = norm(c.name) || `key:${c.key}`;
    const arr = groups.get(g);
    if (arr) arr.push(c); else groups.set(g, [c]);
  }

  // Best row wins the bucket's identity: allowed beats badge-only, and a row
  // carrying a portrait beats one without. Key sort breaks ties so the chosen
  // id stays stable across syncs.
  const score = (c: DynamicCollectionInput) =>
    (c.allowed === true ? 4 : 0) + (c.verified === true ? 2 : 0) + (c.image ? 1 : 0);

  for (const rows of groups.values()) {
    const canonical = [...rows].sort((a, b) => score(b) - score(a) || a.key.localeCompare(b.key))[0];
    // Portrait MUST come from the canonical (allowed) row first. Taking the
    // first row that merely *had* an image picked Brains Elites' dead
    // `allowed:false` row (…r2.dev/test/images/collection.jpg → 404) over the
    // live one, which blanked the featured-collection hero.
    const image = gatewayUrl(canonical.image ?? rows.find(r => r.image)?.image);
    const label = rows.map(r => r.name?.trim()).find(Boolean) ?? '';

    // A hardcoded entry always owns the bucket when it matches — its `id` and
    // accent colour are referenced elsewhere in the UI (`brains_elites`).
    const stat = staticMatchFor(canonical);
    let target: VerifiedCollection;
    if (stat) {
      target = stat;
      if (image && !stat.image) { stat.image = image; bump(); }
    } else {
      const id = `sol:${canonical.key}`;
      const existing = dynamicByKey.get(canonical.key);
      target = (existing && existing.id === id) ? existing : {
        id, name: label, hosts: [], namePrefixes: [], mints: [],
        color: colorFor(canonical.key), image, dynamic: true,
      };
      if (label && target.name !== label) { target.name = label; bump(); }
      if (image && target.image !== image) { target.image = image; bump(); }
    }

    for (const r of rows) {
      if (dynamicByKey.get(r.key) !== target) { dynamicByKey.set(r.key, target); bump(); }
      if (!target.mints?.includes(r.key)) (target.mints ??= []).push(r.key);
      // Portrait is reachable by any of the group's keys and by the bucket id.
      if (image) {
        if (imageByKey.get(r.key) !== image) { imageByKey.set(r.key, image); bump(); }
      }
      // Name/symbol lookups rescue NFTs whose collection_key we never fetched —
      // e.g. rows painted straight from the Supabase metadata cache, which
      // stores `collection` + `symbol` but no key. Registered for aliased
      // static buckets too, so "Pepe Coins" resolves by name alone.
      const s = norm(r.symbol);
      if (s && dynamicBySymbol.get(s) !== target) { dynamicBySymbol.set(s, target); bump(); }
    }
    if (image && imageByKey.get(target.id) !== image) { imageByKey.set(target.id, image); bump(); }

    const n = norm(label);
    if (n && dynamicByName.get(n) !== target) { dynamicByName.set(n, target); bump(); }
    // Also index under the hardcoded label when it differs from Solaris's
    // ("X1 Punks" vs "X1 Punk"), so either spelling resolves.
    const sn = norm(target.name);
    if (sn && sn !== n && !dynamicByName.has(sn)) { dynamicByName.set(sn, target); bump(); }
  }
}

/** Portrait for a bucket id or a raw Solaris collection_key. */
export function collectionImageFor(idOrKey: string | undefined): string | undefined {
  if (!idOrKey) return undefined;
  return imageByKey.get(idOrKey);
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).host.toLowerCase(); }
  catch { return url.toLowerCase(); }
}

/** Identify the verified collection for an NFT, or null if uncategorized. */
export function identifyCollection(opts: {
  metaUri?: string;
  name?: string;
  mint?: string;
  /** Solaris `collection_key` — the strongest signal when we have it. */
  collectionKey?: string;
  /** Collection name reported by the indexer / metadata JSON. */
  collectionName?: string;
  symbol?: string;
}): VerifiedCollection | null {
  const host = hostOf(opts.metaUri);
  const url  = (opts.metaUri ?? '').toLowerCase();
  const name = norm(opts.name);
  const mint = opts.mint;

  // 1) Hardcoded registry first — keeps ids + colours stable for the buckets
  //    the rest of the UI hardcodes (hero banner keys off `brains_elites`).
  for (const c of VERIFIED_COLLECTIONS) {
    if (mint && c.mints?.includes(mint)) return c;
    if (host && c.hosts.some(h => host.includes(h) || url.includes(h.toLowerCase()))) return c;
    if (name && c.namePrefixes.some(p => name.startsWith(p))) return c;
  }

  // 2) Live Solaris registry — collection_key is authoritative.
  if (opts.collectionKey) {
    const byKey = dynamicByKey.get(opts.collectionKey);
    if (byKey) return byKey;
  }
  // 3) Fall back to the collection name / symbol reported alongside the NFT.
  //    This is what rescues NFTs painted from the Supabase metadata cache,
  //    which stores `collection` + `symbol` but no collection_key.
  const cn = norm(opts.collectionName);
  if (cn) {
    const byName = dynamicByName.get(cn);
    if (byName) return byName;
  }
  const sym = norm(opts.symbol);
  if (sym) {
    const bySym = dynamicBySymbol.get(sym);
    if (bySym) return bySym;
  }
  // 4) NFT name starts with a known collection name ("FEDS #745" → "FEDS").
  if (name) {
    for (const [n, entry] of dynamicByName) {
      if (n && name.startsWith(n)) return entry;
    }
  }
  return null;
}

export function isVerified(opts: Parameters<typeof identifyCollection>[0]): boolean {
  return identifyCollection(opts) !== null;
}
