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
};

// Per-collection palette — accent color used for verified badges.
const C_ORANGE = '#ff8c00';
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
    id: 'lab_work', name: 'Lab Work',
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
}): VerifiedCollection | null {
  const host = hostOf(opts.metaUri);
  const url  = (opts.metaUri ?? '').toLowerCase();
  const name = (opts.name ?? '').toLowerCase();
  const mint = opts.mint;

  for (const c of VERIFIED_COLLECTIONS) {
    if (mint && c.mints?.includes(mint)) return c;
    if (host && c.hosts.some(h => host.includes(h) || url.includes(h.toLowerCase()))) return c;
    if (name && c.namePrefixes.some(p => name.startsWith(p))) return c;
  }
  return null;
}

export function isVerified(opts: { metaUri?: string; name?: string; mint?: string }): boolean {
  return identifyCollection(opts) !== null;
}
