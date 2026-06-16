// V2Home — landing layout
//   Top:       full-width price ticker marquee (variant 11)
//   Main:      NFT carousel (left) + sidebar (right)
//     Sidebar top:    BURN REACTORS · BRAINS + LB twin concentric-ring HUDs (variant 01)
//     Sidebar bottom: X1.MAINNET MONITOR · live slot + epoch + tps + height (variant 06)
//
// TODO (admin panel): expose council-only (CnyGhzMuv5snBGxvShxsJMDnvHcXKwRtVVUpzGX3QAuG)
// curation for the carousel feed + boost promo copy.

import { useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import { Link } from 'react-router-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, type Connection } from '@solana/web3.js';
import { fetchAllListings, batchEnrichListings, enrichListing } from '../components/LBComponents';
import type { Listing } from '../components/LBComponents';
import { identifyCollection } from '../lib/verifiedCollections';
import V2NFTImage from '../components/V2NFTImage';
import { fetchSolarisNft, preloadSolarisListings } from '../lib/solarisIndexer';
import { fetchAllPricesFresh, getCachedAllPrices } from '../lib/prices';
import { BRAINS_MINT, BRAINS_LOGO, XNT_LOGO } from '../constants';
import { fetchBurnsFromChain, getCachedChainBurns } from '../lib/chainBurns';
import { setCachedTokenLogo } from '../lib/tokenLogos';
import type { ChainBurnSummary } from '../lib/chainBurns';
import { fmtNum, fmtUSD } from '../utils/v2format';
import {
  fetchIndexerSnapshot, getCachedIndexerSnapshot,
  fetchChartHistory, pctChange24h,
  type IndexerSnapshot, type IndexerPool, type OhlcvBar,
} from '../lib/brainsIndexer';
import { fetchMarketStats, getCachedMarketStats } from '../lib/marketStats';
import { fetchFarms, fetchTotalStakers } from './LpFarms';
import { fetch24hChanges } from '../lib/priceChange';
import { loadActiveBoosts, BOOST_SLOTS, type BoostTierId } from '../components/V2BoostModal';
import { getSpotlightImages, type SpotlightImage } from '../lib/supabase';

// A carousel slide is either a paid boosted listing or an admin promo image.
type Slide =
  | { kind: 'boost'; listing: Listing }
  | { kind: 'image'; img: SpotlightImage }
  | { kind: 'promo' };

// Hardcoded default spotlight image so the carousel is never empty (e.g. before
// any admin image is uploaded). Falls away the moment real spotlight images
// exist. Swap the picture by replacing public/brains-elites-banner.jpg.
const DEFAULT_SPOTLIGHT: SpotlightImage = {
  id: 'default-brains-elites',
  image_url: '/brains-elites-banner.jpg?v=3',
  link_url: 'https://x1city.io/citizenship/mint',
  caption: null,
  sort_order: 0,
  active: true,
};

const LB_MINT              = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
const CAROUSEL_INTERVAL_MS = 4_000;
const BRAINS_INITIAL       = 8_880_000;
const LB_INITIAL           = 100_000;
const ACCENT               = '#f29030';
const NET_POLL_MS          = 30_000;

function fmtPriceUsd(p: number): string {
  if (!isFinite(p) || p <= 0) return '—';
  if (p >= 1)    return '$' + p.toFixed(2);
  if (p >= 0.01) return '$' + p.toFixed(4);
  return '$' + p.toFixed(6);
}

/** Pretty label per boost tier for the top-left chip on the showcase. */
function tierBadge(tier: BoostTierId | undefined): string {
  switch (tier) {
    case 'incinerator': return '🔥 INCINERATOR · LIVE';
    case 'godslayer':   return '⚔️ GODSLAYER · LIVE';
    case 'spark':       return '⚡ SPARK · LIVE';
    default:            return 'LIVE · BOOSTED';
  }
}

export default function V2Home() {
  const { connection } = useConnection();

  // ════════ Styles injected once ════════
  useEffect(() => { injectStyles(); }, []);

  // ════════ Carousel feed — BOOSTED listings only ════════
  // Pulls from the labwork_boosts Supabase table (active rows = expires_at >
  // now, capped at 3). Tier order: incinerator → godslayer → spark. If no
  // citizen has boosted anything, the carousel renders an empty state so
  // there's a clear visual "be the first to boost" call-to-action — we do
  // NOT fall back to the cheap-floor list, because boosts are paid placement.
  const [feed, setFeed] = useState<Listing[]>([]);
  // Per-listing boost tier (for the gold/purple/orange edge on the showcase).
  const [boostTierByPda, setBoostTierByPda] = useState<Map<string, BoostTierId>>(new Map());
  const [boostsLoaded, setBoostsLoaded] = useState(false);
  const [spotImages, setSpotImages] = useState<SpotlightImage[]>([]);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        preloadSolarisListings().catch(() => {});
        // Parallel: chain listings + active boosts table from Supabase.
        const [raw, boosts] = await Promise.all([
          fetchAllListings(connection),
          loadActiveBoosts().catch(() => []),
        ]);
        if (!alive) return;
        setBoostsLoaded(true);

        // Build the tier map keyed by listing_pda so the showcase frame can
        // pick a color per slide later. Same order Supabase returned
        // (incinerator → godslayer → spark, then created_at ascending).
        const tierByPda = new Map<string, BoostTierId>();
        for (const b of boosts) tierByPda.set(b.listing_pda, b.tier);
        setBoostTierByPda(tierByPda);

        // Filter the on-chain listings to only the boosted ones, in the
        // exact tier order Supabase returned. Skip any boost whose listing
        // has been delisted/sold (no matching active listing row).
        const byPda = new Map(raw.filter(l => l.active).map(l => [l.listingPda, l] as const));
        const top: Listing[] = [];
        const orphaned: string[] = [];
        for (const b of boosts) {
          const l = byPda.get(b.listing_pda);
          if (l) top.push(l);
          else orphaned.push(b.listing_pda);
        }
        // DevTools visibility for diagnosing "I boosted but it's not showing".
        // Most common cause when boosts > 0 but top == 0: the listing was
        // cancelled or sold, OR the fetchAllListings cache is stale and
        // doesn't yet contain the recently-listed NFT.
        if (boosts.length > 0) {
          console.info('[carousel] boosts loaded:', boosts.length, 'matched:', top.length,
            'orphaned (no active listing for these PDAs):', orphaned);
        }

        // PAINT FIRST — show the carousel with mint-fallback names immediately
        // so the banner isn't stuck on "Loading…" while batchEnrichListings +
        // Solaris run.
        setFeed(top);

        // Solaris pass — gives us pre-resolved image URLs for X1 native NFTs.
        // Race in parallel; each result updates feed individually.
        Promise.all(top.map(async (l) => {
          const sol = await fetchSolarisNft(l.nftMint).catch(() => null);
          if (!sol?.image || !alive) return;
          setFeed(prev => {
            const next = [...prev];
            const j = next.findIndex(p => p.listingPda === l.listingPda);
            if (j < 0) return prev;
            const base = next[j].nftData ?? {
              mint: l.nftMint, name: l.nftMint.slice(0, 6) + '…',
              symbol: sol.symbol ?? '', balance: 1, decimals: 0, isToken2022: false,
            };
            next[j] = {
              ...next[j],
              nftData: {
                ...base,
                name: sol.name ?? base.name,
                symbol: sol.symbol ?? base.symbol,
                image: sol.image,
                collection: sol.collectionName ?? base.collection,
              },
            };
            return next;
          });
        })).catch(() => {});

        // Metaplex PDA pass — backfills name/symbol/metaUri for anything
        // Solaris missed. Then per-item enrichListing resolves the actual
        // image URL via the metaUri JSON (so V2NFTImage gets a direct image
        // src instead of having to do the slow proxy fetch itself).
        batchEnrichListings(connection, top).then(async (enriched) => {
          if (!alive) return;
          setFeed(prev => {
            const next = [...prev];
            enriched.forEach(e => {
              const j = next.findIndex(p => p.listingPda === e.listingPda);
              if (j < 0) return;
              const existingImg = next[j].nftData?.image;
              next[j] = {
                ...next[j],
                nftData: existingImg
                  ? { ...e.nftData!, image: existingImg }
                  : e.nftData ?? next[j].nftData,
              };
            });
            return next;
          });

          // Per-item image resolution — staggered. Skip any item that already
          // has an image from Solaris.
          enriched.forEach((l, i) => {
            setTimeout(async () => {
              if (!alive) return;
              const cur = (await new Promise<Listing | undefined>(r => {
                setFeed(prev => {
                  r(prev.find(p => p.listingPda === l.listingPda));
                  return prev;
                });
              }));
              if (cur?.nftData?.image) return; // Solaris already won
              const heavy = await enrichListing(connection, l).catch(() => null);
              if (!alive || !heavy?.nftData?.image) return;
              setFeed(prev => {
                const next = [...prev];
                const j = next.findIndex(p => p.listingPda === l.listingPda);
                if (j < 0) return prev;
                next[j] = { ...next[j], nftData: heavy.nftData };
                return next;
              });
            }, 120 * i);
          });
        }).catch(() => {});
      } catch {}
    })();
    return () => { alive = false; };
  }, [connection]);

  // Admin-curated spotlight images for the carousel.
  useEffect(() => {
    let alive = true;
    getSpotlightImages().then(imgs => { if (alive) setSpotImages(imgs); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Unified carousel: interleave boosted listings with admin promo images so
  // the showcase always has something to display.
  const slides: Slide[] = (() => {
    const out: Slide[] = [];
    // Admin-uploaded images, or the hardcoded default when none exist yet.
    const imgs = spotImages.length > 0 ? spotImages : [DEFAULT_SPOTLIGHT];
    const n = Math.max(feed.length, imgs.length);
    for (let i = 0; i < n; i++) {
      if (i < feed.length) out.push({ kind: 'boost', listing: feed[i] });
      if (i < imgs.length) out.push({ kind: 'image', img: imgs[i] });
    }
    // Boost promo always rides along as its own page.
    out.push({ kind: 'promo' });
    return out;
  })();

  useEffect(() => {
    if (paused || slides.length < 2) return;
    const id = setInterval(() => setIdx(i => (i + 1) % slides.length), CAROUSEL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [paused, slides.length]);

  useEffect(() => {
    if (idx >= slides.length && slides.length > 0) setIdx(0);
  }, [slides.length, idx]);

  // Pre-warm neighbor slide images
  useEffect(() => {
    if (slides.length < 2) return;
    const added: HTMLLinkElement[] = [];
    const neighbors = [(idx + 1) % slides.length, (idx - 1 + slides.length) % slides.length];
    for (const i of neighbors) {
      const s = slides[i];
      const u = s?.kind === 'boost' ? s.listing.nftData?.image : s?.kind === 'image' ? s.img.image_url : undefined;
      if (!u || !u.startsWith('http')) continue;
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = 'image';
      const stripped = u.replace(/^https?:\/\//, '');
      link.href = `https://images.weserv.nl/?url=${encodeURIComponent(stripped)}&w=1200&q=82&output=webp`;
      document.head.appendChild(link);
      added.push(link);
    }
    return () => { added.forEach(l => l.remove()); };
  }, [idx, slides.length]);

  const current = slides[idx];
  const featuredListing = current?.kind === 'boost' ? current.listing : undefined;
  const featuredName  = featuredListing?.nftData?.name ?? (featuredListing ? `#${featuredListing.nftMint.slice(0, 6)}` : '—');
  const featuredPrice = featuredListing ? featuredListing.price / 1e9 : 0;
  const featuredImg   = current?.kind === 'image'
    ? current.img.image_url
    : featuredListing?.nftData?.image ?? featuredListing?.nftData?.metaUri;

  const goPrev = () => setIdx(i => (i - 1 + slides.length) % slides.length);
  const goNext = () => setIdx(i => (i + 1) % slides.length);

  // ════════ Prices (ticker marquee) ════════
  // Seed from cache for an instant paint; the loader immediately overwrites
  // with a LIVE fetch so we never sit on the 24h stale-while-revalidate value.
  const [prices, setPrices]       = useState<{ BRAINS: number; LB: number; XNT: number }>(() => getCachedAllPrices());
  const [prevPrices, setPrevPrices] = useState<{ BRAINS: number; LB: number; XNT: number }>({ BRAINS: 0, LB: 0, XNT: 0 });
  // Last live snapshot — kept in a ref so prevPrices isn't pinned to the stale
  // initial render closure (which left the 24h change permanently showing "—").
  const lastPricesRef = useRef<{ BRAINS: number; LB: number; XNT: number }>({ BRAINS: 0, LB: 0, XNT: 0 });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const fresh = await fetchAllPricesFresh();
        if (!alive) return;
        setPrevPrices(lastPricesRef.current);
        lastPricesRef.current = fresh;
        setPrices(fresh);
      } catch {}
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ════════ Burn data — twin reactor sidebar ════════
  // Seed from localStorage on mount so the reactor cards paint instantly on
  // repeat visits, the same way TopPools / prism / portfolio do. Without this
  // the cards would say "—" until the first RPC came back.
  const [brainsBurned, setBrainsBurned] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('v2_brains_burned_v1');
      if (!raw) return null;
      const { v, ts } = JSON.parse(raw) as { v: number; ts: number };
      // Trust cache for 10min — newer than that and the next fetch will overwrite anyway.
      if (Date.now() - ts < 10 * 60_000) return v;
    } catch {}
    return null;
  });
  const [lbSummary, setLbSummary] = useState<ChainBurnSummary | null>(() => getCachedChainBurns(LB_MINT) ?? null);
  const [lbSupply, setLbSupply]   = useState<number | null>(null); // for the combined-MC ticker stat

  // ════════ X1Prism ecosystem snapshot (60s poll, 5min LS fallback) ════════
  const [prism, setPrism] = useState<IndexerSnapshot | null>(() => getCachedIndexerSnapshot());
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchIndexerSnapshot().then(s => {
        if (!alive || !s) return;
        setPrism(s);
        // Sync every token logo Prism knows about into the shared cache
        // so V2Portfolio + V2LpPairing get them for free.
        for (const p of s.pools) {
          if (p.token1.address && p.token1.logo) setCachedTokenLogo(p.token1.address, p.token1.logo);
          if (p.token2.address && p.token2.logo) setCachedTokenLogo(p.token2.address, p.token2.logo);
        }
      }).catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // ════════ Real 24h price change (from chart history) ════════
  // The xdex price endpoint carries no change field, so derive it: each token's
  // 24h change vs XNT, combined with XNT's 24h change vs USD → token/USD change.
  const [changes, setChanges] = useState<{ XNT: number | null; BRAINS: number | null; LB: number | null }>({ XNT: null, BRAINS: null, LB: null });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = await fetch24hChanges(BRAINS_MINT);
        if (alive) setChanges(c);
      } catch {}
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [prism]);

  useEffect(() => {
    let alive = true;

    // BRAINS supply — single getTokenSupply RPC, fast. Fire immediately so
    // the BURN REACTORS card lands at the same time as the pools/TVL data.
    (async () => {
      try {
        const bs = await connection.getTokenSupply(new PublicKey(BRAINS_MINT)).catch(() => null);
        if (!alive) return;
        const sup = bs?.value?.uiAmount ?? null;
        if (sup != null) {
          const burned = Math.max(0, BRAINS_INITIAL - sup);
          setBrainsBurned(burned);
          try {
            localStorage.setItem('v2_brains_burned_v1', JSON.stringify({ v: burned, ts: Date.now() }));
          } catch {}
        }
      } catch {}
    })();

    // LB supply — one getTokenSupply RPC, feeds the combined market-cap ticker stat.
    connection.getTokenSupply(new PublicKey(LB_MINT))
      .then(ls => { if (alive) setLbSupply(ls?.value?.uiAmount ?? null); })
      .catch(() => {});

    // LB chain scan — always fire. The fetcher is *incremental*: it seeds
    // from cache (the same one our useState used for first paint) and only
    // fetches new sigs since. Skipping when cache exists broke any case where
    // the cache was empty or partial — citizen would see no LB data at all.
    const ctrl = new AbortController();
    fetchBurnsFromChain(connection, LB_MINT, ctrl.signal, (s) => {
      if (!ctrl.signal.aborted) setLbSummary(s);
    }).then(final => { if (!ctrl.signal.aborted) setLbSummary(final); })
      .catch(() => {});

    return () => { alive = false; ctrl.abort(); };
  }, [connection]);

  // ════════ Network monitor data ════════
  const [slot, setSlot]               = useState<number | null>(null);
  const [tps, setTps]                 = useState<number | null>(null);
  const [blockHeight, setBlockHeight] = useState<number | null>(null);
  const [epoch, setEpoch]             = useState<{ epoch: number; slotIndex: number; slotsInEpoch: number } | null>(null);
  const [lastPing, setLastPing]       = useState<number>(0);

  useEffect(() => {
    let alive = true;
    let cycle = 1; // start at 1 so first tick is light (just slot)
    const load = async () => {
      try {
        const heavy = cycle % 6 === 0; // every ~3 min
        cycle++;
        const tasks: Promise<any>[] = [connection.getSlot().catch(() => null)];
        if (heavy) {
          tasks.push(
            connection.getRecentPerformanceSamples(1).catch(() => []),
            connection.getBlockHeight().catch(() => null),
            connection.getEpochInfo().catch(() => null),
          );
        }
        const out = await Promise.all(tasks);
        if (!alive) return;
        const s = out[0] as number | null;
        // Slot only ever moves forward. X1's RPC is load-balanced across nodes at
        // slightly different heights, so consecutive getSlot() calls can return an
        // AHEAD node then a LAGGING one — which made the readout flicker
        // forward/back every poll. Clamp to the max seen so it never regresses.
        if (s != null) setSlot(prev => (prev == null ? s : Math.max(prev, s)));
        if (heavy) {
          const perf   = out[1] as Array<{ samplePeriodSecs: number; numTransactions: number }>;
          const height = out[2] as number | null;
          const ep     = out[3] as { epoch: number; slotIndex: number; slotsInEpoch: number } | null;
          const sample = perf?.[0];
          if (sample && sample.samplePeriodSecs > 0) setTps(sample.numTransactions / sample.samplePeriodSecs);
          // Block height is monotonic too — same anti-flicker clamp as slot.
          if (height != null) setBlockHeight(prev => (prev == null ? height : Math.max(prev, height)));
          if (ep) setEpoch({ epoch: ep.epoch, slotIndex: ep.slotIndex, slotsInEpoch: ep.slotsInEpoch });
        }
        setLastPing(Date.now());
      } catch {}
    };

    // Fire one heavy cold-start immediately so the X1.MAINNET MONITOR lands
    // at the same time as the pools/TVL data. (Used to be 4s deferred — that
    // was the visible "loads slow compared to pools" gap.)
    cycle = 0;
    load();
    const id = setInterval(load, NET_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [connection]);

  // ════════ UTC clock ════════
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const utc = new Date(now).toISOString().slice(11, 19);
  const networkOnline = lastPing > 0 && (Date.now() - lastPing) < 12_000;

  const tokens = [
    { sym: 'XNT' as const,    p: prices.XNT,    change: changes.XNT,    logo: XNT_LOGO },
    { sym: 'BRAINS' as const, p: prices.BRAINS, change: changes.BRAINS, logo: BRAINS_LOGO },
    { sym: 'LB' as const,     p: prices.LB,     change: changes.LB,     logo: findLogoFromPrism(prism, LB_MINT_ADDR) },
  ];

  // X1 Brains aggregate stats for the ticker: combined BRAINS+LB market cap and
  // the BRAINS+LB DEX liquidity (same figures as the X1 Brains Stats card hero).
  const brainsSupplyNow = brainsBurned != null ? Math.max(0, BRAINS_INITIAL - brainsBurned) : null;
  const brainsMc = brainsSupplyNow != null && prices.BRAINS > 0 ? brainsSupplyNow * prices.BRAINS : null;
  const lbMc     = lbSupply != null && prices.LB > 0 ? lbSupply * prices.LB : null;
  const combinedMc = brainsMc != null || lbMc != null ? (brainsMc ?? 0) + (lbMc ?? 0) : null;
  const blTvl = prism ? prism.pools.filter(isBrainsOrLbPool).reduce((s, p) => s + p.tvl, 0) : null;

  return (
    <div className="content content-wide f8" style={{ display: 'block' }}>
      {/* ════════ TICKER MARQUEE (full width) ════════ */}
      <TickerMarquee
        tokens={tokens}
        network={prism ? { tvl: prism.totals.tvl, vol24: prism.totals.volume_24h_usd } : null}
        brains={{ mc: combinedMc, tvl: blTvl }}
      />

      {/* ════════ FEATURED SPOTLIGHT (full width, above carousel) ════════ */}
      <FeaturedSpotlight connection={connection} />

      {/* ════════ MAIN GRID: banner + sidebar ════════ */}
      <div className="l-grid">
        {/* LEFT — NFT carousel */}
        <div
          className="l-banner"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          <div className="l-thumb">
            {featuredImg ? (
              <V2NFTImage src={featuredImg} name={featuredName} priority width={1200}
                fit={current?.kind === 'image' ? 'contain' : 'cover'} />
            ) : null}
          </div>
          <div className="l-veil" />
          {/* Boost-promo slide — always rides along as its own carousel page. */}
          {current?.kind === 'promo' && (
            <div className="l-overlay" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
              <div className="l-meta" style={{ maxWidth: 460 }}>
                <div className="l-tag" style={{ color: ACCENT }}>SPOTLIGHT OPEN</div>
                <div className="l-nm" style={{ fontSize: 22 }}>Claim the showcase</div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 13, color: '#9abacf', marginTop: 8, lineHeight: 1.5 }}>
                  Burn BRAINS on a listing to take the top-of-landing slot. {BOOST_SLOTS} slots, tier order: incinerator → godslayer → spark.
                </div>
                <div className="l-cta" style={{ justifyContent: 'center', marginTop: 14 }}>
                  <Link to="/labwork" className="l-cta-p">BROWSE & BOOST</Link>
                </div>
              </div>
            </div>
          )}
          {/* Boosted-listing slide */}
          {current?.kind === 'boost' && (
            <div className="l-overlay">
              <div className="l-top">
                <span className="l-live">{tierBadge(boostTierByPda.get(current.listing.listingPda))}</span>
                <span className="l-clk">{utc} UTC</span>
              </div>
              <div className="l-meta">
                <div className="l-tag">BOOSTED LISTING</div>
                <div className="l-nm">{featuredName}</div>
                <div className="l-pr">
                  {featuredPrice > 0 ? `${featuredPrice.toFixed(2)} XNT` : '—'}
                </div>
                <div className="l-cta">
                  <Link to="/labwork" className="l-cta-p">BROWSE MARKETPLACE</Link>
                  <Link to="/labwork" className="l-cta-s">VIEW DETAILS</Link>
                </div>
              </div>
            </div>
          )}
          {/* Admin promo-image slide */}
          {current?.kind === 'image' && (current.img.caption || current.img.link_url) && (
            <div className="l-overlay">
              <div className="l-top">
                <span className="l-live" style={{ color: ACCENT }}>SPOTLIGHT</span>
                <span className="l-clk">{utc} UTC</span>
              </div>
              <div className="l-meta">
                {current.img.caption && <div className="l-nm">{current.img.caption}</div>}
                {current.img.link_url && (
                  <div className="l-cta">
                    <a href={current.img.link_url} target="_blank" rel="noopener noreferrer" className="l-cta-p">VIEW ↗</a>
                  </div>
                )}
              </div>
            </div>
          )}
          {slides.length > 1 && (
            <>
              <button type="button" onClick={goPrev} className="l-arrow l-arrow-l" aria-label="Previous">‹</button>
              <button type="button" onClick={goNext} className="l-arrow l-arrow-r" aria-label="Next">›</button>
              <div className="l-dots">
                {slides.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`l-dot${i === idx ? ' on' : ''}`}
                    onClick={() => setIdx(i)}
                    aria-label={`Slide ${i + 1}`}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* RIGHT — reactors (top) + XNT chart (bottom), filling carousel height */}
        <div className="l-side">
          <BurnReactors
            brainsBurned={brainsBurned}
            lbBurned={lbSummary?.totalBurned ?? null}
            brainsPrice={prices.BRAINS}
            lbPrice={prices.LB}
            xntPrice={prices.XNT}
            chips={tokens}
            utc={utc}
          />
          <XntPriceCard prism={prism} />
        </div>
      </div>


      {/* ════════ UNIFIED OVERVIEW — MC/TVL · stats · pools (one panel) ════════ */}
      <BrainsStatsRow prism={prism} prices={prices} />

      {/* ════════ NETWORK MONITOR (full width) ════════ */}
      <NetworkMonitor
        slot={slot}
        tps={tps}
        blockHeight={blockHeight}
        epoch={epoch}
        online={networkOnline}
      />

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Ticker marquee (variant 11 top strip)
// ─────────────────────────────────────────────────────────────────
type TickItem =
  | { kind: 'token'; sym: 'XNT' | 'BRAINS' | 'LB'; p: number; change: number | null; logo?: string }
  | { kind: 'net'; tvl: number; vol24: number }
  | { kind: 'brains'; mc: number | null; tvl: number | null };

const TickerMarquee: FC<{
  tokens: Array<{ sym: 'XNT' | 'BRAINS' | 'LB'; p: number; change: number | null; logo?: string }>;
  network?: { tvl: number; vol24: number } | null;
  brains?: { mc: number | null; tvl: number | null } | null;
}> = ({ tokens, network, brains }) => {
  const fmtK = (n: number | null): string =>
    n == null         ? '—'
    : n >= 1_000_000  ? '$' + (n / 1_000_000).toFixed(2) + 'M'
    : n >= 1_000      ? '$' + (n / 1_000).toFixed(1) + 'K'
    :                   '$' + n.toFixed(0);
  // Build the base item list once (X1 Network + X1 Brains lead the loop),
  // then duplicate for the seamless marquee scroll.
  const items: TickItem[] = [
    ...(network ? [{ kind: 'net' as const, tvl: network.tvl, vol24: network.vol24 }] : []),
    ...(brains && (brains.mc != null || brains.tvl != null)
      ? [{ kind: 'brains' as const, mc: brains.mc, tvl: brains.tvl }] : []),
    ...tokens.map(t => ({ kind: 'token' as const, ...t })),
  ];
  const segs = [...items, ...items];
  return (
    <div className="l-ticker">
      <div className="l-ticker-strip">
        {segs.map((it, i) => it.kind === 'net' ? (
          <span key={i} className="l-ticker-seg">
            <span style={{ display: 'inline-flex', width: 16, height: 16, borderRadius: '50%', marginRight: 6, background: 'rgba(0,207,198,.15)', color: '#00cfc6', fontSize: 9, fontWeight: 800, alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle' }}>◆</span>
            <span className="l-ticker-nm net">X1 NETWORK</span>
            <span className="l-ticker-sk">TVL</span><span className="l-ticker-pr">{fmtK(it.tvl)}</span>
            <span className="l-ticker-sk">24H VOL</span><span className="l-ticker-pr">{fmtK(it.vol24)}</span>
            <span className="l-ticker-sep">│</span>
          </span>
        ) : it.kind === 'brains' ? (
          <span key={i} className="l-ticker-seg">
            <span style={{ display: 'inline-flex', width: 16, height: 16, borderRadius: '50%', marginRight: 6, background: 'rgba(242,144,48,.15)', color: '#f29030', fontSize: 9, fontWeight: 800, alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle' }}>◆</span>
            <span className="l-ticker-nm">X1 BRAINS</span>
            <span className="l-ticker-sk">MCAP</span><span className="l-ticker-pr">{fmtK(it.mc)}</span>
            <span className="l-ticker-sk">DEX LIQ</span><span className="l-ticker-pr">{fmtK(it.tvl)}</span>
            <span className="l-ticker-sep">│</span>
          </span>
        ) : (
          <span key={i} className="l-ticker-seg">
            {it.logo
              ? <img src={it.logo} alt="" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  style={{ width: 16, height: 16, borderRadius: '50%', objectFit: 'cover', marginRight: 6, verticalAlign: 'middle', flexShrink: 0 }} />
              : <span style={{ display: 'inline-flex', width: 16, height: 16, borderRadius: '50%', marginRight: 6, background: 'rgba(242,144,48,.15)', color: '#f29030', fontSize: 8, fontWeight: 800, alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle' }}>{it.sym[0]}</span>}
            <span className="l-ticker-nm">{it.sym}</span>
            <span className="l-ticker-pr">{fmtPriceUsd(it.p)}</span>
            <span className={`l-ticker-ch ${(it.change ?? 0) >= 0 ? 'up' : 'dn'}`}>
              {it.change == null ? '—' : `${(it.change ?? 0) >= 0 ? '▲' : '▼'} ${Math.abs(it.change).toFixed(2)}%`}
            </span>
            <span className="l-ticker-sep">│</span>
          </span>
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Burn Reactors — radial segmented tick gauge + sweeping needle (A02)
// ─────────────────────────────────────────────────────────────────
const GAUGE_SWEEP = 270;
// 48 ticks around a 270° arc; ticks below the fill fraction are "on".
function gaugeTicks(pctFrac: number) {
  const CX = 69, CY = 69, N = 48, START = -225, RO = 58, RI = 46;
  const onCount = Math.round(N * Math.max(0, Math.min(1, pctFrac)));
  const out: { x1: string; y1: string; x2: string; y2: string; on: boolean }[] = [];
  for (let i = 0; i < N; i++) {
    const a = (START + GAUGE_SWEEP * (i / (N - 1))) * Math.PI / 180;
    out.push({
      x1: (CX + RI * Math.cos(a)).toFixed(2), y1: (CY + RI * Math.sin(a)).toFixed(2),
      x2: (CX + RO * Math.cos(a)).toFixed(2), y2: (CY + RO * Math.sin(a)).toFixed(2),
      on: i < onCount,
    });
  }
  return out;
}
const BurnReactors: FC<{
  brainsBurned: number | null;
  lbBurned:     number | null;
  brainsPrice:  number;
  lbPrice:      number;
  xntPrice:     number;
  chips:        Array<{ sym: string; p: number; change: number | null; logo?: string }>;
  utc:          string;
}> = ({ brainsBurned, lbBurned, brainsPrice, lbPrice }) => {
  const bPct = brainsBurned != null ? Math.min(100, (brainsBurned / BRAINS_INITIAL) * 100) : 0;
  const lPct = lbBurned     != null ? Math.min(100, (lbBurned     / LB_INITIAL)     * 100) : 0;
  const fmtBig = (n: number | null): string => {
    if (n == null) return '——';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  };

  // Radial tick dial with a sweeping needle (A02 design), tinted per token.
  const renderGauge = (pctFrac: number, accent: string, glow: string) => {
    const ticks = gaugeTicks(pctFrac);
    const V = GAUGE_SWEEP * Math.max(0, Math.min(1, pctFrac)) - 135;  // needle rest angle
    return (
      <svg viewBox="0 0 138 138">
        <circle cx="69" cy="69" r="52" fill="none" stroke="#101722" strokeWidth="15" opacity="0.5" />
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.on ? accent : '#26303e'} strokeWidth={t.on ? 3.2 : 2} strokeLinecap="round"
            style={t.on ? { filter: `drop-shadow(0 0 3px ${glow})` } : undefined} />
        ))}
        <g>
          <line x1="69" y1="69" x2="69" y2="29" stroke={accent} strokeWidth="2.4" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 4px ${glow})` }} />
          <circle cx="69" cy="69" r="3.4" fill={accent} style={{ filter: `drop-shadow(0 0 5px ${glow})` }} />
          <animateTransform attributeName="transform" attributeType="XML" type="rotate" dur="5.5s" repeatCount="indefinite"
            keyTimes="0;0.55;0.68;0.8;1"
            values={`-135 69 69;${V.toFixed(2)} 69 69;${(V + 7).toFixed(2)} 69 69;${V.toFixed(2)} 69 69;${V.toFixed(2)} 69 69`}
            calcMode="spline" keySplines="0.6 0 0.25 1;0.4 0 0.6 1;0.4 0 0.6 1;0 0 1 1" />
        </g>
      </svg>
    );
  };

  const cell = (sym: string, color: string, glow: string, pct: number, burned: number | null, usd: number) => (
    <div className="f8rxcell">
      <div className="f8rxgauge">
        {renderGauge(pct / 100, color, glow)}
        <div className="f8rxgtxt"><div className="big f8num">{fmtBig(burned)}</div></div>
      </div>
      <div className="f8rxsym" style={{ color }}>{sym} · {burned != null ? `${(pct > 0 && pct < 0.1 ? pct.toFixed(2) : pct.toFixed(1))}%` : '—'}</div>
      <div className="f8rxusd f8num">{usd > 0 ? fmtUSD(usd) : '—'}</div>
    </div>
  );
  return (
    <div className="f8panel f8rx">
      <div className="f8hd"><h3>Burn Reactors</h3>
        <span className="f8rxtag"><span className="dot" />SUPPLY INCINERATED</span></div>
      <div className="f8rxgrid">
        {cell('BRAINS', '#f29030', 'rgba(242,144,48,.55)', bPct, brainsBurned, (brainsBurned ?? 0) * brainsPrice)}
        {cell('LB', '#aeb9c7', 'rgba(174,185,199,.5)', lPct, lbBurned, (lbBurned ?? 0) * lbPrice)}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// X1.MAINNET MONITOR (variant 06)
// ─────────────────────────────────────────────────────────────────
const NetworkMonitor: FC<{
  slot:        number | null;
  tps:         number | null;
  blockHeight: number | null;
  epoch:       { epoch: number; slotIndex: number; slotsInEpoch: number } | null;
  online:      boolean;
}> = ({ slot, tps, blockHeight, epoch, online }) => {
  const epochPct = epoch && epoch.slotsInEpoch > 0
    ? (epoch.slotIndex / epoch.slotsInEpoch) * 100
    : 0;
  return (
    <div className="f8panel" style={{ marginTop: 14 }}>
      <div className="f8hd"><h3>Network Monitor</h3><span className="meta">X1 · MAINNET</span></div>
      <div className="f8nbody">
        <div className="f8obar">
          <span className="pulse" style={{ background: online ? '#00c98d' : '#ff4466', boxShadow: `0 0 10px ${online ? '#00c98d' : '#ff4466'}` }} />
          <span className="lbl">X1 MAINNET · {online ? 'ONLINE' : 'OFFLINE'}</span>
          <span className="net" style={{ color: online ? '#00c98d' : '#ff4466' }}>RPC · {online ? 'FAST' : 'SLOW'}</span>
        </div>
        <div className="f8ngrid">
          <div className="nc"><div className="k">Slot</div><div className="v">{slot != null ? slot.toLocaleString() : '——'}</div></div>
          <div className="nc"><div className="k">TPS</div><div className="v">{tps != null ? fmtNum(tps, 0) : '——'}</div></div>
          <div className="nc"><div className="k">Block</div><div className="v">{blockHeight != null ? blockHeight.toLocaleString() : '——'}</div></div>
          <div className="nc"><div className="k">Epoch</div><div className="v">{epoch ? `${epoch.epoch} · ${epochPct.toFixed(0)}%` : '——'}</div></div>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Featured Spotlight (variant 11, compact)
// ─────────────────────────────────────────────────────────────────
// Locked genesis supply — the Brains Elites mint program is capped at 444.
const BRAINS_ELITE_SUPPLY = 444;

const FeaturedSpotlight: FC<{ connection: Connection }> = ({ connection }) => {
  // Live floor + active-listing count, derived from the marketplace program's
  // on-chain listings filtered to the Brains Elites collection. No hardcoded
  // numbers — floor/listed come straight from chain; supply is the locked 444.
  const [stats, setStats] = useState<{ floor: number | null; listed: number | null }>(() => {
    try {
      const raw = localStorage.getItem('v2_brains_elite_stats_v1');
      if (raw) { const c = JSON.parse(raw); return { floor: c.floor ?? null, listed: c.listed ?? null }; }
    } catch {}
    return { floor: null, listed: null };
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await fetchAllListings(connection);
        // Enrich so each listing carries name + metaUri — identifyCollection
        // matches Brains Elites by R2 host / name prefix, not just root mint.
        const listings = await batchEnrichListings(connection, raw.filter(l => l.active));
        if (!alive) return;
        let floor = Infinity;
        let listed = 0;
        for (const l of listings) {
          if (!l.nftMint || !l.active) continue;
          const vc = identifyCollection({
            metaUri: l.nftData?.metaUri,
            name: l.nftData?.name,
            mint: l.nftMint,
          });
          if (vc?.id !== 'brains_elites') continue;
          listed++;
          if (l.price > 0) floor = Math.min(floor, l.price / 1e9);
        }
        const next = { floor: floor === Infinity ? null : floor, listed };
        setStats(next);
        try { localStorage.setItem('v2_brains_elite_stats_v1', JSON.stringify(next)); } catch {}
      } catch {}
    })();
    return () => { alive = false; };
  }, [connection]);

  return (
    <div className="l-spot">
      <div className="l-spot-info">
        <span className="l-spot-tag">FEATURED</span>
        <span className="l-spot-title">BRAINS ELITE</span>
        <span className="l-spot-desc">Council-issued · sequential rarity · locked supply</span>
        <div className="l-spot-stats">
          <div><span className="l-spot-l">FLOOR</span><span className="l-spot-v">{stats.floor != null ? `${stats.floor.toFixed(2)} XNT` : '—'}</span></div>
          <div><span className="l-spot-l">LISTED</span><span className="l-spot-v">{stats.listed != null ? stats.listed : '—'}</span></div>
          <div><span className="l-spot-l">SUPPLY</span><span className="l-spot-v">{BRAINS_ELITE_SUPPLY}</span></div>
        </div>
      </div>
      <Link to="/labwork" className="l-spot-cta">EXPLORE →</Link>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// Inject all styles + animations once at mount
// ─────────────────────────────────────────────────────────────────
// A pool counts as "X1Brains" if either side is BRAINS or LB — match on mint
// address (robust) with a symbol fallback. Shared by Top Pools + the stats card.
function isBrainsOrLbPool(p: IndexerPool): boolean {
  return p.token1.address === BRAINS_MINT || p.token2.address === BRAINS_MINT ||
         p.token1.address === LB_MINT     || p.token2.address === LB_MINT     ||
         p.token1.symbol === 'BRAINS' || p.token2.symbol === 'BRAINS' ||
         p.token1.symbol === 'LB'     || p.token2.symbol === 'LB';
}

// ─────────────────────────────────────────────────────────────────
// Top pools row — every BRAINS or LB pool, highest TVL first
// ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────
// XNT price card — OHLCV mini-chart + 24h % delta
// ─────────────────────────────────────────────────────────────────
const WXNT = 'So11111111111111111111111111111111111111112';

// Find the actual on-chain USDC mint (X1's USDC.X) by scanning prism pools
// for an XNT/USDC pair. The old hardcoded constant was the Solana mainnet
// USDC mint (Es9…NYB) — wrong chain entirely, so chart/history always
// returned empty and the card sat at "— loading chart —" forever.
function deriveUsdcMintFromPrism(prism: IndexerSnapshot | null): string | null {
  if (!prism) return null;
  for (const p of prism.pools) {
    const a = p.token1, b = p.token2;
    const isAXnt  = a.address === WXNT;
    const isBXnt  = b.address === WXNT;
    const isAUsdc = /^USDC(\.X)?$/i.test(a.symbol);
    const isBUsdc = /^USDC(\.X)?$/i.test(b.symbol);
    if (isAXnt && isBUsdc) return b.address;
    if (isBXnt && isAUsdc) return a.address;
  }
  return null;
}

const LB_MINT_ADDR = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';

// Pull a token's logo from any Prism pool that contains it.
function findLogoFromPrism(prism: IndexerSnapshot | null, mint: string): string | undefined {
  if (!prism) return undefined;
  for (const p of prism.pools) {
    if (p.token1.address === mint && p.token1.logo) return p.token1.logo;
    if (p.token2.address === mint && p.token2.logo) return p.token2.logo;
  }
  return undefined;
}

const XntPriceCard: FC<{ prism: IndexerSnapshot | null }> = ({ prism }) => {
  const [bars, setBars] = useState<OhlcvBar[]>([]);
  const usdcMint = deriveUsdcMintFromPrism(prism);

  useEffect(() => {
    if (!usdcMint) return; // wait for prism to load — no chart possible without the right pair
    let alive = true;
    fetchChartHistory(WXNT, usdcMint, 24).then(b => { if (alive) setBars(b); }).catch(() => {});
    const id = setInterval(() => {
      fetchChartHistory(WXNT, usdcMint, 24).then(b => { if (alive) setBars(b); }).catch(() => {});
    }, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [usdcMint]);
  const pct  = pctChange24h(bars);
  const last = bars.length > 0 ? bars[bars.length - 1].c : 0;
  if (bars.length < 2) {
    return (
      <div className="f8panel">
        <div className="f8hd"><h3>XNT / USD</h3><span className="meta">24H</span></div>
        <div className="f8cbody" style={{ color: '#566173', fontFamily: 'Sora', fontSize: 12, padding: '40px 18px', textAlign: 'center' }}>— loading chart —</div>
      </div>
    );
  }
  // Build SVG path (stretched via preserveAspectRatio:none in CSS)
  const W = 520, H = 150, PAD = 8;
  const minP = Math.min(...bars.map(b => b.c));
  const maxP = Math.max(...bars.map(b => b.c));
  const range = maxP - minP || maxP * 0.01 || 1;
  const toX = (i: number) => PAD + (W - 2 * PAD) * (i / (bars.length - 1));
  const toY = (v: number) => H - PAD - (H - 2 * PAD) * ((v - minP) / range);
  const P = bars.map((b, i) => [toX(i), toY(b.c)] as [number, number]);
  // Catmull-Rom → cubic bezier smoothing (A01-ember design)
  const smooth = (p: [number, number][]) => {
    if (p.length < 2) return '';
    let d = `M${p[0][0].toFixed(2)} ${p[0][1].toFixed(2)} `;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p[i + 1];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} `;
    }
    return d.trim();
  };
  const line = smooth(P);
  const area = `${line} L${P[P.length - 1][0].toFixed(2)} ${H - PAD} L${P[0][0].toFixed(2)} ${H - PAD} Z`;
  const lastP = P[P.length - 1];
  const up = (pct ?? 0) >= 0;
  return (
    <div className="f8panel">
      <div className="f8hd"><h3>XNT / USD</h3><span className="meta">24H</span></div>
      <div className="f8cbody">
        <div className="f8ctop">
          <span className="price">${last >= 1 ? last.toFixed(2) : last.toFixed(4)}</span>
          {pct != null && (
            <span className={`f8chip ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%</span>
          )}
        </div>
        <svg className="f8csvg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="f8area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ff7a1a" stopOpacity="0.40" />
              <stop offset="0.55" stopColor="#ff7a1a" stopOpacity="0.12" />
              <stop offset="1" stopColor="#ff7a1a" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="f8cstroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#ffb347" /><stop offset="1" stopColor="#ff7a1a" />
            </linearGradient>
            <filter id="f8glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3.2" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <path d={area} fill="url(#f8area)" />
          <path d={line} fill="none" stroke="url(#f8cstroke)" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" filter="url(#f8glow)" />
          <circle cx={lastP[0].toFixed(2)} cy={lastP[1].toFixed(2)} r="7" fill="#ff7a1a" opacity="0.22" />
          <circle cx={lastP[0].toFixed(2)} cy={lastP[1].toFixed(2)} r="3.8" fill="#ffb347" stroke="#0c1118" strokeWidth="2" />
        </svg>
        <div className="f8cx"><span>24h ago</span><span>now</span></div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// X1 Brains stats — MC (BRAINS + LB), DEX liquidity, NFT marketplace
// flow + listings, LP-farm staked / reward vaults / stakers.
// (Replaces the old Top Movers card.) Fetches its own on-chain data;
// takes prism + live prices as props.
// ─────────────────────────────────────────────────────────────────
const BrainsStatsRow: FC<{
  prism: IndexerSnapshot | null;
  prices: { BRAINS: number; LB: number; XNT: number };
}> = ({ prism, prices }) => {
  const { connection } = useConnection();
  const [brainsSupply, setBrainsSupply] = useState<number | null>(null);
  const [lbSupply,     setLbSupply]     = useState<number | null>(null);
  const [mkt,      setMkt]      = useState(() => getCachedMarketStats());
  const [listings, setListings] = useState<number | null>(null);
  const [farmUsd,  setFarmUsd]  = useState<{ staked: number; vaults: number } | null>(null);
  const [stakers,  setStakers]  = useState<{ uniqueStakers: number; totalPositions: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    Promise.all([
      connection.getTokenSupply(new PublicKey(BRAINS_MINT)).catch(() => null),
      connection.getTokenSupply(new PublicKey(LB_MINT)).catch(() => null),
    ]).then(([bs, ls]) => {
      if (!alive) return;
      setBrainsSupply(bs?.value?.uiAmount ?? null);
      setLbSupply(ls?.value?.uiAmount ?? null);
    });
    fetchMarketStats(connection, ctrl.signal).then(s => { if (alive) setMkt(s); }).catch(() => {});
    fetchAllListings(connection).then(ls => { if (alive) setListings(ls.length); }).catch(() => {});
    fetchFarms(connection).then(farms => {
      if (!alive) return;
      const staked = farms.reduce((s, f) => s + (Number(f.totalStaked)  / 10 ** f.lpDecimals)     * f.lpPriceUsd,     0);
      const vaults = farms.reduce((s, f) => s + (Number(f.vaultBalance) / 10 ** f.rewardDecimals) * f.rewardPriceUsd, 0);
      setFarmUsd({ staked, vaults });
    }).catch(() => {});
    fetchTotalStakers(connection).then(r => { if (alive) setStakers(r); }).catch(() => {});
    return () => { alive = false; ctrl.abort(); };
  }, [connection]);

  const usd = (n: number | null): string => {
    if (n == null) return '—';
    if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K';
    return '$' + n.toFixed(0);
  };
  const num = (n: number): string => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toFixed(0);
  };

  const brainsMc   = brainsSupply != null && prices.BRAINS > 0 ? brainsSupply * prices.BRAINS : null;
  const lbMc       = lbSupply     != null && prices.LB     > 0 ? lbSupply     * prices.LB     : null;
  const combinedMc = brainsMc != null || lbMc != null ? (brainsMc ?? 0) + (lbMc ?? 0) : null;
  const blTvl      = prism ? prism.pools.filter(isBrainsOrLbPool).reduce((s, p) => s + p.tvl, 0) : null;
  const mktXnt     = mkt?.volumeXnt ?? null;

  // Pools (merged in from the old Top Pools card) — BRAINS/LB pools, TVL desc.
  const fmtCompact = (n: number): string => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toFixed(0);
  };
  const pools = prism
    ? [...prism.pools].filter(p => p.tvl > 0 && isBrainsOrLbPool(p)).sort((a, b) => b.tvl - a.tvl)
    : [];

  // LP-Farms-style stat card: label · big value · descriptive subtitle.
  const stat = (l: string, v: string, s: string, mod?: 'accent' | 'teal') => (
    <div className="lf9-stat">
      <div className="l">{l}</div>
      <div className={`v${mod === 'accent' ? ' accent' : ''}`} style={mod === 'teal' ? { color: '#00cfc6' } : undefined}>{v}</div>
      <div className="s">{s}</div>
    </div>
  );

  return (
    <div className="f8panel ov">
      <div className="f8hd"><h3>X1 Brains · Overview</h3><span className="meta">MARKET · NFT · FARMS · POOLS</span></div>

      {/* stats — LP-Farms-style cards, grouped + labeled by category */}
      <div className="ov-lf9">
        <div className="lf9-head"><span className="ovh-ic">◇</span><span className="t">Market</span><span className="rule" /></div>
        <div className="lf9-stat-row">
          {stat('BRAINS MC', usd(brainsMc), 'circulating × price')}
          {stat('LB MC', usd(lbMc), 'circulating × price')}
          {stat('Combined Market Cap', usd(combinedMc), 'BRAINS + LB market cap', 'accent')}
          {stat('DEX Liquidity · TVL', usd(blTvl), 'BRAINS + LB pools', 'teal')}
        </div>

        <div className="lf9-head" style={{ marginTop: 20 }}><span className="ovh-ic">◆</span><span className="t">NFT Marketplace</span><span className="rule" /></div>
        <div className="lf9-stat-row">
          {stat('XNT Flow', mktXnt == null ? '—' : (mktXnt > 0 && mktXnt < 1 ? mktXnt.toFixed(3) : num(mktXnt)) + ' XNT', 'NFT sales volume · all-time')}
          {stat('Listings', listings == null ? '—' : String(listings), 'active NFT listings')}
        </div>

        <div className="lf9-head" style={{ marginTop: 20 }}><span className="ovh-ic">⟠</span><span className="t">LP Farms</span><span className="rule" /></div>
        <div className="lf9-stat-row">
          {stat('Staked', usd(farmUsd?.staked ?? null), 'LP value locked')}
          {stat('Reward Vaults', usd(farmUsd?.vaults ?? null), 'rewards locked')}
          {stat('Stakers', stakers ? String(stakers.uniqueStakers) : '—', 'wallets participating')}
          {stat('Positions', stakers ? String(stakers.totalPositions) : '—', 'open positions')}
        </div>

        <div className="lf9-emissions"><span className="dot" /><span>Live on-chain · X1 Brains ecosystem · refreshes on load</span></div>
      </div>

      {/* pools — column table, keeps the 2 pair logos next to the name */}
      {pools.length > 0 && (
        <div className="ov-pools">
          <div className="bstat-sl teal-sl">Top Pools · by TVL</div>
          <div className="ovp-head"><span>Pair</span><span>24h Vol</span><span>TVL</span><span>Fee</span></div>
          {pools.map(p => {
            const swapState = {
              fromMint: p.token1.address, fromSymbol: p.token1.symbol,
              toMint:   p.token2.address, toSymbol:   p.token2.symbol,
            };
            return (
              <Link key={p.pool_address} to="/swap" state={swapState} className="ovp-row" style={{ textDecoration: 'none' }}>
                <div className="ovp-pair">
                  <div className="f8tlogo pair">
                    {[p.token1, p.token2].map((s, si) => {
                      const src = s.address === BRAINS_MINT ? BRAINS_LOGO : s.logo;
                      return src
                        ? <img key={si} src={src} alt="" />
                        : <span key={si} className="ph">{s.symbol[0]}</span>;
                    })}
                  </div>
                  <b>{p.token1.symbol}/{p.token2.symbol}</b>
                </div>
                <span className="num">${fmtCompact(p.token1.volume_usd_24h ?? 0)}</span>
                <span className="num">${fmtCompact(p.tvl)}</span>
                <span className="ovp-fee">{p.apr_24h.toFixed(0)}%</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
};


function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('v2-home-styles-v18')) return;
  const s = document.createElement('style');
  s.id = 'v2-home-styles-v18';
  s.textContent = `
    /* ===== #08 flank-reactors module visuals (scoped under .f8) ===== */
    .f8 .f8panel{position:relative;background:var(--v2-glow),linear-gradient(180deg,#0c1118,#0f1620);border:1px solid #1a2433;border-radius:14px;overflow:hidden}
    .f8 .f8panel::before{content:'';position:absolute;left:0;top:16px;bottom:16px;width:2px;background:linear-gradient(180deg,transparent,#f29030,transparent);box-shadow:0 0 10px rgba(242,144,48,.4);z-index:1}
    .f8 .f8hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 11px;border-bottom:1px solid #141d29}
    .f8 .f8hd h3{font-family:'Orbitron',sans-serif;font-size:10.5px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:#e8edf5;margin:0}
    .f8 .f8hd .meta{font-size:10px;letter-spacing:1px;color:#566173;text-transform:uppercase;font-family:'Sora'}
    .f8 .f8num{font-family:'Sora';font-variant-numeric:tabular-nums}
    .f8 .f8chip{display:inline-flex;align-items:center;gap:4px;font-family:'Sora';font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:6px}
    .f8 .f8chip.up{background:rgba(0,201,141,.12);color:#00c98d;border:1px solid rgba(0,201,141,.25)}
    .f8 .f8chip.down{background:rgba(255,68,102,.12);color:#ff4466;border:1px solid rgba(255,68,102,.25)}
    .f8 .f8wing{flex:1;display:flex;flex-direction:column;padding:14px 16px 16px}
    .f8 .f8whd{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
    .f8 .f8whd h4{font-family:'Orbitron';font-size:10.5px;font-weight:600;letter-spacing:1.6px;color:#e8edf5;margin:0}
    .f8 .f8whd .pct{font-family:'Sora';font-size:11px;font-weight:600}
    .f8 .f8gauge{flex:1;display:flex;align-items:center;justify-content:center;position:relative;min-height:138px}
    .f8 .f8gauge svg{width:138px;height:138px}
    .f8 .f8gtxt{position:absolute;text-align:center}
    .f8 .f8gtxt .big{font-family:'Sora';font-size:20px;font-weight:700;line-height:1;color:#e8edf5}
    .f8 .f8gtxt .usd{font-family:'Sora';font-size:11px;color:#8a9ab8;margin-top:3px}
    .f8 .f8gtxt .lbl{font-family:'Orbitron';font-size:8px;letter-spacing:2px;color:#566173;margin-top:5px}
    .f8 .f8wfoot{font-family:'Sora';font-size:9px;letter-spacing:.5px;color:#566173;text-align:center;margin-top:6px;text-transform:uppercase}
    .f8 .f8tbl{padding:6px 0 8px}
    .f8 .f8trow{display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid #141d29;box-shadow:inset 3px 0 0 rgba(0,207,198,.5);transition:background .15s,box-shadow .15s}
    .f8 .f8trow:last-child{border-bottom:none}
    .f8 .f8trow:hover{background:#0c1320;box-shadow:inset 3px 0 0 #00cfc6}
    .f8 .f8tlogo{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;font-family:'Orbitron';font-weight:700;font-size:10px;color:#8a9ab8;flex-shrink:0;overflow:hidden;background:transparent}
    .f8 .f8tlogo img{width:100%;height:100%;object-fit:cover}
    /* Pool pair — both token logos side by side (slightly overlapped) */
    .f8 .f8tlogo.pair{width:auto;border-radius:0;display:flex;align-items:center;overflow:visible}
    .f8 .f8tlogo.pair img,.f8 .f8tlogo.pair .ph{width:32px;height:32px;border-radius:50%;object-fit:cover;border:2px solid #0c1118;background:#0c1118;flex-shrink:0}
    .f8 .f8tlogo.pair > :nth-child(2){margin-left:-11px}
    .f8 .f8tlogo.pair .ph{display:grid;place-items:center;font-family:'Orbitron';font-weight:700;font-size:11px;color:#8a9ab8}
    .f8 .f8tname{font-family:'Sora';font-size:12px;font-weight:600;color:#e8edf5}
    .f8 .f8tsub{font-family:'Sora';font-size:10px;color:#566173;margin-top:2px;letter-spacing:.4px}
    .f8 .f8tsp{flex:1}
    .f8 .f8tcol{text-align:right;min-width:78px}
    .f8 .f8tcol .a{font-family:'Sora';font-size:12.5px;font-weight:600;color:#e8edf5}
    .f8 .f8tcol .b{font-family:'Orbitron';font-size:8px;letter-spacing:1.4px;color:#566173;text-transform:uppercase;margin-top:3px}
    .f8 .f8apr{font-family:'Sora';font-size:11px;font-weight:700;color:#00c98d;padding:4px 9px;border-radius:7px;background:rgba(0,201,141,.1);border:1px solid rgba(0,201,141,.22)}
    /* ── X1 Brains stats panel ── */
    .f8 .bstat{padding:12px 16px 14px;display:flex;flex-direction:column;gap:11px}
    .f8 .bstat-hero{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .f8 .bstat-hcell{position:relative;padding:12px 13px;border-radius:12px;overflow:hidden;background:linear-gradient(160deg,rgba(242,144,48,.10),rgba(242,144,48,.015));border:1px solid rgba(242,144,48,.22)}
    .f8 .bstat-hcell::after{content:'';position:absolute;right:-30%;top:-60%;width:90%;height:160%;background:radial-gradient(closest-side,rgba(242,144,48,.16),transparent);pointer-events:none}
    .f8 .bstat-hcell.teal{background:linear-gradient(160deg,rgba(0,207,198,.10),rgba(0,207,198,.015));border-color:rgba(0,207,198,.22)}
    .f8 .bstat-hcell.teal::after{background:radial-gradient(closest-side,rgba(0,207,198,.16),transparent)}
    .f8 .bstat-hv{position:relative;z-index:1;font-family:'Sora';font-size:21px;font-weight:800;letter-spacing:.2px;line-height:1;color:#f29030}
    .f8 .bstat-hcell.teal .bstat-hv{color:#00cfc6}
    .f8 .bstat-hk{position:relative;z-index:1;font-family:'Orbitron';font-size:8px;font-weight:600;letter-spacing:1.6px;color:#8a9ab8;text-transform:uppercase;margin-top:7px}
    .f8 .bstat-sl{display:flex;align-items:center;gap:7px;font-family:'Orbitron';font-size:8.5px;font-weight:600;letter-spacing:2px;color:#566173;text-transform:uppercase;margin-bottom:8px}
    .f8 .bstat-sl::before{content:'';width:5px;height:5px;background:#f29030;box-shadow:0 0 7px rgba(242,144,48,.7);transform:rotate(45deg);flex-shrink:0}
    .f8 .bstat-sl::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#1a2433,transparent)}
    /* ── unified overview panel (split bar + grouped strips + pool table w/ logos) ── */
    .f8 .f8panel.ov{margin-top:14px}
    .f8 .ov-lf9{padding:16px 18px 14px}
    .f8 .ov-lf9 .lf9-head{margin-bottom:13px}
    .f8 .ov-lf9 .ovh-ic{font-size:12px;color:#f29030;margin-right:9px;line-height:1;filter:drop-shadow(0 0 5px rgba(242,144,48,.45))}
    .f8 .ov-lf9 .lf9-stat-row{row-gap:16px}
    .f8 .ov-lf9 .lf9-stat .v{font-size:18px}
    .f8 .ov-lf9 .lf9-stat .l{margin-bottom:6px}
    .f8 .ov-lf9 .lf9-stat .s{margin-top:4px}
    .f8 .ov-lf9 .lf9-emissions{margin-top:14px;padding-top:12px}
    .f8 .ov-hero{display:flex;margin:14px 16px 0;border:1px solid #1d2838;border-radius:12px;overflow:hidden}
    .f8 .ov-hero > div{flex:1;padding:13px 16px}
    .f8 .ov-hero .o{background:linear-gradient(135deg,rgba(242,144,48,.12),rgba(242,144,48,.02));border-right:1px solid #1d2838}
    .f8 .ov-hero .teal{background:linear-gradient(135deg,rgba(0,207,198,.12),rgba(0,207,198,.02))}
    .f8 .ov-hero .teal .bstat-hv{color:#00cfc6}
    .f8 .ov-stats{padding:14px 16px 4px}
    .f8 .ov-grp{margin-bottom:11px}
    .f8 .ov-strip{display:flex;border:1px solid #16202e;border-radius:10px;overflow:hidden;background:#0a0f17;box-shadow:inset 3px 0 0 rgba(242,144,48,.5)}
    .f8 .ov-cell{flex:1;min-width:0;padding:10px 13px;border-right:1px solid #141d29}
    .f8 .ov-cell:last-child{border-right:none}
    .f8 .ov-cell .cv{font-family:'Orbitron';font-weight:700;font-size:15px;color:#e8edf5;line-height:1}
    .f8 .ov-cell .ck{font-family:'Sora';font-size:9px;letter-spacing:1px;color:#7c8aa0;text-transform:uppercase;margin-top:6px}
    .f8 .bstat-sl.teal-sl::before{background:#00cfc6;box-shadow:0 0 7px rgba(0,207,198,.7)}
    .f8 .ov-pools{padding:6px 16px 14px}
    .f8 .ovp-head,.f8 .ovp-row{display:grid;grid-template-columns:1fr 96px 96px 54px;align-items:center;gap:8px}
    .f8 .ovp-head{padding:2px 12px 8px;border-bottom:1px solid #1a2433}
    .f8 .ovp-head span{font-family:'Orbitron';font-size:8px;letter-spacing:1.2px;color:#566173;text-transform:uppercase;text-align:right}
    .f8 .ovp-head span:first-child{text-align:left}
    .f8 .ovp-row{padding:9px 12px;border-bottom:1px solid #131c25;transition:background .15s}
    .f8 .ovp-row:last-child{border-bottom:none}
    .f8 .ovp-row:hover{background:#0c1320}
    .f8 .ovp-pair{display:flex;align-items:center;gap:10px;min-width:0}
    .f8 .ovp-pair b{font-family:'Sora';font-weight:700;font-size:13px;color:#e8edf5;white-space:nowrap}
    .f8 .ovp-row .num{text-align:right;font-family:'Sora';font-size:12.5px;font-weight:600;color:#e8edf5}
    .f8 .ovp-fee{text-align:right;font-family:'Sora';font-size:11px;font-weight:700;color:#00c98d}
    .f8 .bstat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .f8 .bstat-cell{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:10px 13px;border-radius:10px;background:#0a0f17;border:1px solid #16202e;box-shadow:inset 3px 0 0 rgba(242,144,48,.55);transition:background .15s,box-shadow .15s}
    .f8 .bstat-cell:hover{background:#0e1622;box-shadow:inset 3px 0 0 #f29030,0 4px 14px rgba(242,144,48,.12)}
    .f8 .bstat-cell .ck{font-family:'Sora';font-size:10.5px;letter-spacing:.3px;color:#7c8aa0;white-space:nowrap}
    .f8 .bstat-cell .cv{font-family:'Sora';font-size:13px;font-weight:700;color:#e8edf5;text-align:right}
    .f8 .f8cbody{padding:16px 18px 18px}
    .f8 .f8ctop{display:flex;align-items:baseline;gap:12px;margin-bottom:10px}
    .f8 .f8ctop .price{font-family:'Sora';font-size:18px;font-weight:700;color:#e8edf5}
    .f8 .f8csvg{width:100%;height:150px;display:block}
    .f8 .f8cx{display:flex;justify-content:space-between;font-family:'Sora';font-size:9px;color:#566173;margin-top:6px}
    .f8 .f8nbody{padding:4px 0 2px}
    .f8 .f8obar{display:flex;align-items:center;gap:9px;padding:9px 16px;border-bottom:1px solid #141d29}
    .f8 .f8obar .pulse{width:8px;height:8px;border-radius:50%;background:#00c98d;box-shadow:0 0 9px #00c98d;animation:f8pulse 1.6s infinite}
    @keyframes f8pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .f8 .f8obar .lbl{font-family:'Orbitron';font-size:9.5px;font-weight:600;letter-spacing:1.4px;color:#e8edf5}
    .f8 .f8obar .net{margin-left:auto;font-family:'Sora';font-size:9px;color:#00c98d;letter-spacing:1px}
    .f8 .f8ngrid{display:grid;grid-template-columns:repeat(4,1fr)}
    .f8 .f8ngrid .nc{padding:9px 12px;border-right:1px solid #141d29}
    .f8 .f8ngrid .nc:last-child{border-right:none}
    .f8 .f8ngrid .nc .k{font-family:'Orbitron';font-size:7.5px;letter-spacing:1.3px;color:#566173;text-transform:uppercase}
    .f8 .f8ngrid .nc .v{font-family:'Sora';font-size:12px;font-weight:700;margin-top:4px;color:#e6edf6;font-variant-numeric:tabular-nums}
    .f8 .l-side{gap:14px}
    /* compact twin-reactor panel (both side by side) */
    .f8 .f8rxgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:12px 12px 14px}
    .f8 .f8rxcell{display:flex;flex-direction:column;align-items:center;text-align:center}
    .f8 .f8rxgauge{position:relative;width:100%;display:flex;align-items:center;justify-content:center}
    .f8 .f8rxgauge svg{width:106px;height:106px}
    .f8 .f8rxgtxt{position:absolute;text-align:center}
    .f8 .f8rxgtxt .big{font-size:13.5px;font-weight:700;color:#e8edf5}
    .f8 .f8rxsym{font-family:'Orbitron';font-size:9px;font-weight:600;letter-spacing:1px;margin-top:5px}
    .f8 .f8rxusd{font-size:12.5px;font-weight:600;color:#00c98d;margin-top:3px;letter-spacing:.2px}
    .f8 .f8rxtag{display:inline-flex;align-items:center;gap:6px;font-family:'Orbitron';font-size:8.5px;font-weight:600;letter-spacing:1.4px;color:#566173;text-transform:uppercase}
    .f8 .f8rxtag .dot{width:6px;height:6px;border-radius:50%;background:#f29030;box-shadow:0 0 7px rgba(242,144,48,.7);animation:f8pulse 1.6s infinite}
    /* right column = reactors (auto) + chart (fills) = carousel height */
    .f8 .l-side > .f8panel:last-child{flex:1;display:flex;flex-direction:column;min-height:0}
    .f8 .l-side > .f8panel:last-child .f8cbody{flex:1;display:flex;flex-direction:column;min-height:0}
    .f8 .l-side > .f8panel:last-child .f8csvg{flex:1;height:auto;min-height:90px}
    @keyframes lh-spin-slow   { from { transform: rotate(0); } to { transform: rotate(360deg); } }
    @keyframes lh-spin-rev    { from { transform: rotate(360deg); } to { transform: rotate(0); } }
    @keyframes lh-arc-pulse   { 0%,100% { filter: drop-shadow(0 0 4px ${ACCENT}88); } 50% { filter: drop-shadow(0 0 14px ${ACCENT}cc); } }
    @keyframes lh-pulse-glow  { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
    @keyframes lh-blink       { 0%,49% { opacity: 1; } 50%,100% { opacity: .25; } }
    @keyframes lh-tick-blip   { 0%,100% { opacity: 1; box-shadow: 0 0 5px currentColor; } 50% { opacity: .35; box-shadow: 0 0 2px currentColor; } }
    @keyframes lh-ticker      { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
    @keyframes lh-scan-v      { 0% { transform: translateY(-100%); } 100% { transform: translateY(2000%); } }
    @keyframes lh-fade        { from { opacity: 0; } to { opacity: 1; } }

    /* ════════ TICKER ════════ */
    .l-ticker {
      position: relative;
      background: rgba(0,207,198,.035);
      border: 1px solid rgba(0,207,198,.16);
      border-radius: 8px;
      padding: 9px 0;
      margin-bottom: 14px;
      overflow: hidden;
    }
    .l-ticker::before, .l-ticker::after {
      content: '';
      position: absolute; top: 0; bottom: 0; width: 40px;
      pointer-events: none; z-index: 2;
    }
    .l-ticker::before { left: 0; background: linear-gradient(90deg, var(--bg, #080c0f), transparent); }
    .l-ticker::after  { right: 0; background: linear-gradient(-90deg, var(--bg, #080c0f), transparent); }
    .l-ticker-strip {
      display: flex; gap: 36px;
      white-space: nowrap;
      width: max-content;
      animation: lh-ticker 32s linear infinite;
      font-family: 'Orbitron', monospace;
    }
    .l-ticker-seg { display: inline-flex; align-items: center; gap: 8px; }
    .l-ticker-nm  { font-size: 11px; color: ${ACCENT}; font-weight: 800; letter-spacing: 1.5px; }
    .l-ticker-nm.net { color: #00cfc6; }
    .l-ticker-sk  { font-size: 8.5px; color: #566173; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; margin-left: 2px; }
    .l-ticker-pr  { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--text-primary); font-weight: 700; }
    .l-ticker-ch  { font-size: 9px; font-weight: 700; }
    .l-ticker-ch.up { color: var(--neon-green, #00c98d); }
    .l-ticker-ch.dn { color: var(--neon-red, #ff4444); }
    .l-ticker-sep { color: var(--text-faint, #3a4a5a); margin-left: 4px; }

    /* ════════ MAIN GRID ════════ */
    .l-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 14px;
    }
    @media (max-width: 920px) { .l-grid { grid-template-columns: 1fr; } }
    /* two-up rows for the module pairs below the hero (#08 layout) */
    .l-two {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      align-items: stretch;   /* both panels take the taller height */
      margin-top: 14px;
    }
    /* Make each panel a flex column so its body fills the stretched height —
       the shorter card extends cleanly instead of leaving a dead gap. */
    .f8 .l-two > .f8panel { display: flex; flex-direction: column; }
    .f8 .l-two > .f8panel > .f8tbl,
    .f8 .l-two > .f8panel > .bstat { flex: 1 1 auto; }
    @media (max-width: 920px) { .l-two { grid-template-columns: 1fr; } }

    /* ════════ BANNER (carousel) ════════ */
    .l-banner {
      position: relative;
      aspect-ratio: 16 / 11;
      border: 1px solid ${ACCENT}55;
      border-radius: 14px; overflow: hidden;
      background: #06090d;
    }
    .l-thumb {
      position: absolute; inset: 0;
      background: linear-gradient(155deg, rgba(242,144,48,.1), rgba(0,0,0,.4));
      animation: lh-fade .5s ease both;
    }
    .l-veil {
      position: absolute; inset: 0;
      background: linear-gradient(180deg, transparent 35%, rgba(0,0,0,.9));
    }
    .l-overlay {
      position: relative; height: 100%;
      display: flex; flex-direction: column; justify-content: space-between;
      padding: 22px; z-index: 2;
    }
    .l-top { display: flex; justify-content: space-between; align-items: center; }
    .l-live {
      font-family: 'Orbitron', monospace; font-size: 8px; letter-spacing: 2px;
      color: var(--neon-green, #00c98d); font-weight: 700;
      background: rgba(0,0,0,.6); padding: 4px 10px; border-radius: 4px;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .l-live::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%;
      background: var(--neon-green, #00c98d); box-shadow: 0 0 6px var(--neon-green, #00c98d);
      animation: lh-pulse-glow 1.5s ease infinite;
    }
    .l-clk {
      font-family: 'Orbitron', monospace; font-size: 9px; letter-spacing: 1.5px;
      color: rgba(255,255,255,.55);
      background: rgba(0,0,0,.5); padding: 4px 10px; border-radius: 4px;
    }
    .l-meta { color: #fff; animation: lh-fade .4s ease both; }
    .l-tag {
      font-family: 'Orbitron', monospace; font-size: 9px;
      letter-spacing: 3px; color: ${ACCENT}; font-weight: 700;
      margin-bottom: 8px;
    }
    .l-nm {
      font-family: 'Orbitron', monospace; font-size: 30px;
      font-weight: 900; color: #fff; letter-spacing: 1px;
    }
    .l-pr {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 20px; font-weight: 800; color: ${ACCENT}; margin-top: 4px;
    }
    .l-cta { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    .l-cta a {
      padding: 10px 18px;
      font-family: 'Orbitron', monospace; font-size: 10px;
      font-weight: 800; letter-spacing: 1.5px;
      border-radius: 6px; text-decoration: none;
    }
    .l-cta-p { background: ${ACCENT}; color: #0a0e14; }
    .l-cta-s { background: rgba(255,255,255,.08); color: #fff; border: 1px solid rgba(255,255,255,.22); }
    .l-arrow {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 40px; height: 40px; border-radius: 50%;
      background: rgba(0,0,0,.65); backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,.18);
      color: #fff; font-family: 'Orbitron', monospace;
      font-size: 22px; font-weight: 900;
      cursor: pointer; z-index: 5;
      display: grid; place-items: center; line-height: 1;
      opacity: 0.65; transition: opacity .15s, background .15s, transform .15s;
    }
    .l-arrow:hover {
      opacity: 1; background: ${ACCENT}; color: #0a0e14;
      transform: translateY(-50%) scale(1.08);
    }
    .l-arrow-l { left: 12px; }
    .l-arrow-r { right: 12px; }
    .l-dots {
      position: absolute; bottom: 14px; right: 18px;
      display: flex; gap: 6px; z-index: 4;
    }
    .l-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: rgba(255,255,255,.25);
      border: none; cursor: pointer; padding: 0;
      transition: background .2s, transform .2s;
    }
    .l-dot.on {
      background: ${ACCENT}; transform: scale(1.3);
      box-shadow: 0 0 8px ${ACCENT};
    }

    /* ════════ SIDEBAR LAYOUT ════════ */
    .l-side {
      display: flex; flex-direction: column; gap: 8px;
    }

    /* ════════ SHARED CARD STYLES (portfolio info-card pattern) ════════ */
    .l-card-reactors, .l-card-mon {
      position: relative;
      background: rgba(255, 255, 255, 0.015);
      border: 1px solid rgba(242, 144, 48, 0.13);
      border-radius: 16px;
      padding: 14px;
      overflow: hidden;
      transition: border-color 0.2s;
    }
    .l-card-reactors:hover, .l-card-mon:hover {
      border-color: rgba(242, 144, 48, 0.33);
    }
    .l-card-reactors::before, .l-card-mon::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(242, 144, 48, 0.4), transparent);
    }
    .l-card-head, .l-mon-hd {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 6px;
    }
    .l-card-title {
      font-family: 'Orbitron', monospace; font-size: 9px; font-weight: 700;
      letter-spacing: 2.5px; color: ${ACCENT};
    }
    .l-card-sub {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 8px; color: var(--text-muted); letter-spacing: 1.5px;
    }

    /* ════════ BURN REACTORS CARD ════════ */
    .l-reactors {
      display: grid; grid-template-columns: 1fr; gap: 10px;
    }
    .l-reactor {
      position: relative; padding: 8px 8px 10px;
      background: rgba(138,154,184,.04);
      border: 1px solid rgba(242,144,48,.22);
      border-radius: 8px;
      text-align: center;
    }
    .l-hud {
      position: relative; width: 84px; height: 84px;
      margin: 0 auto 4px;
    }
    .l-ring {
      position: absolute; inset: 0; border-radius: 50%;
      border: 1px solid rgba(242,144,48,.22);
    }
    .l-ring.r2 { inset: 5px; border-color: rgba(242,144,48,.35); }
    .l-ring.r3 {
      inset: 10px; border-style: dashed;
      border-color: rgba(242,144,48,.5);
      animation: lh-spin-slow 70s linear infinite;
    }
    .l-arc {
      position: absolute; inset: 3px; border-radius: 50%;
      background: conic-gradient(${ACCENT} 0%, ${ACCENT} calc(var(--p, 0) * 1%), transparent calc(var(--p, 0) * 1%));
      -webkit-mask: radial-gradient(circle, transparent 55%, black 56%, black 59%, transparent 60%);
              mask: radial-gradient(circle, transparent 55%, black 56%, black 59%, transparent 60%);
      animation: lh-arc-pulse 3s ease infinite;
      transition: background 1s cubic-bezier(.16,1,.3,1);
    }
    .l-core {
      position: absolute; inset: 18px; border-radius: 50%;
      background:
        radial-gradient(circle at 30% 30%, rgba(242,144,48,.2), transparent 60%),
        linear-gradient(135deg, rgba(242,144,48,.14), rgba(0,0,0,.42));
      border: 1px solid rgba(242,144,48,.5);
      box-shadow: 0 0 10px rgba(242,144,48,.2);
      display: grid; place-items: center;
    }
    .l-core-pct {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 11px; font-weight: 900; color: ${ACCENT};
      letter-spacing: 0.3px;
    }
    .l-blip {
      position: absolute; width: 4px; height: 4px; border-radius: 50%;
      background: ${ACCENT}; box-shadow: 0 0 5px ${ACCENT};
      color: ${ACCENT};
      animation: lh-tick-blip 1.6s ease infinite;
    }
    .l-blip.n { top: 1px; left: 50%; transform: translateX(-50%); }
    .l-blip.e { top: 50%; right: 1px; transform: translateY(-50%); animation-delay: .4s; }
    .l-blip.s { bottom: 1px; left: 50%; transform: translateX(-50%); animation-delay: .8s; }
    .l-blip.w { top: 50%; left: 1px; transform: translateY(-50%); animation-delay: 1.2s; }
    .l-reactor-sym {
      font-family: 'Orbitron', monospace; font-size: 9px;
      font-weight: 800; color: var(--text-primary); letter-spacing: 2px;
    }
    .l-reactor-big {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 13px; font-weight: 800; color: ${ACCENT}; margin-top: 2px;
    }
    .l-reactor-sub {
      font-family: 'Orbitron', monospace; font-size: 8px;
      color: var(--text-muted); letter-spacing: 1.5px; margin-top: 1px;
    }
    .l-reactor-toks {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px;
      margin-top: 7px;
    }
    .l-tkc {
      background: rgba(138,154,184,.04);
      border: 1px solid rgba(138,154,184,.12);
      border-radius: 6px; padding: 5px 7px;
    }
    .l-tkc-l {
      font-family: 'Orbitron', monospace; font-size: 7px;
      color: var(--text-faint); letter-spacing: 1.5px;
    }
    .l-tkc-v {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 10px; color: var(--text-primary); font-weight: 800; margin-top: 1px;
    }
    .l-tkc-d {
      font-family: 'Orbitron', monospace; font-size: 7px; margin-top: 1px;
    }
    .l-tkc-d.up { color: var(--neon-green, #00c98d); }
    .l-tkc-d.dn { color: var(--neon-red, #ff4444); }

    /* ════════ NETWORK MONITOR ════════ */
    .l-mon-status {
      font-family: 'Orbitron', monospace; font-size: 8px;
      letter-spacing: 1.5px; font-weight: 700;
      display: flex; align-items: center; gap: 6px;
    }
    .l-mon-status::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%;
      animation: lh-pulse-glow 1.2s ease infinite;
    }
    .l-mon-status.on  { color: var(--neon-green, #00c98d); }
    .l-mon-status.on::before  { background: var(--neon-green, #00c98d); box-shadow: 0 0 6px var(--neon-green, #00c98d); }
    .l-mon-status.off { color: var(--neon-red, #ff4444); }
    .l-mon-status.off::before { background: var(--neon-red, #ff4444); box-shadow: 0 0 6px var(--neon-red, #ff4444); }
    .l-mon-slot {
      position: relative; text-align: center;
      padding: 10px 8px;
      margin-bottom: 6px;
      background:
        repeating-linear-gradient(0deg, transparent 0, transparent 2px, rgba(0,201,141,.03) 2px, rgba(0,201,141,.03) 3px),
        radial-gradient(circle at center, rgba(0,201,141,.06), transparent 60%);
      border: 1px solid rgba(138,154,184,.12); border-radius: 8px;
      overflow: hidden;
    }
    .l-mon-slot::before {
      content: ''; position: absolute; left: 0; right: 0;
      height: 2px; background: linear-gradient(90deg, transparent, var(--neon-green, #00c98d), transparent);
      animation: lh-scan-v 3s linear infinite;
    }
    .l-mon-slot-l {
      font-family: 'Orbitron', monospace; font-size: 8px;
      color: var(--neon-green, #00c98d); letter-spacing: 2.5px; font-weight: 700;
    }
    .l-mon-slot-v {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 20px; font-weight: 900; color: var(--text-primary);
      letter-spacing: 1px; margin-top: 2px;
    }
    .l-mon-slot-sub {
      font-family: 'Orbitron', monospace; font-size: 8px;
      color: var(--text-muted); letter-spacing: 1.5px; margin-top: 2px;
    }
    .l-mon-stats {
      display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px;
    }
    .l-mon-stat {
      background: rgba(138,154,184,.04);
      border: 1px solid rgba(138,154,184,.12);
      border-radius: 6px; padding: 5px; text-align: center;
    }
    .l-mon-stat-l {
      font-family: 'Orbitron', monospace; font-size: 7px;
      color: var(--text-faint); letter-spacing: 1.5px;
    }
    .l-mon-stat-v {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 11px; color: ${ACCENT}; font-weight: 800; margin-top: 2px;
    }

    /* ════════ Standalone rows ════════ */
    .l-spot { margin-bottom: 10px; }

    /* ──── 11 · FEATURED SPOTLIGHT (ultra-compact, dark) ──── */
    .l-spot {
      position: relative;
      background:
        radial-gradient(circle at 82% 50%, rgba(0,207,198,.07), transparent 55%),
        linear-gradient(110deg, #06090d 0%, #0a0e14 50%, #06090d 100%);
      border: 1px solid rgba(0,207,198,.16);
      border-radius: 10px;
      padding: 6px 12px;
      display: flex; align-items: center; justify-content: space-between;
      gap: 14px; overflow: hidden;
    }
    .l-spot::before {
      /* sweeping shimmer — fires every 6s */
      content: ''; position: absolute; top: 0; bottom: 0; width: 35%;
      background: linear-gradient(100deg,
        transparent 0%,
        rgba(0,207,198,.04) 40%,
        rgba(0,207,198,.12) 50%,
        rgba(0,207,198,.04) 60%,
        transparent 100%);
      transform: translateX(-150%);
      animation: lh-spot-shimmer 6s ease-in-out infinite;
      pointer-events: none; z-index: 1;
    }
    .l-spot::after {
      content: ''; position: absolute; inset: 0;
      background: repeating-linear-gradient(45deg, transparent 0 14px, rgba(255,255,255,.012) 14px 15px);
      pointer-events: none;
    }
    @keyframes lh-spot-shimmer {
      0%   { transform: translateX(-150%); }
      55%  { transform: translateX(450%); }
      100% { transform: translateX(450%); }
    }
    @keyframes lh-spot-pulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(0,207,198,0); }
      50%     { box-shadow: 0 0 12px 0 rgba(0,207,198,.12); }
    }
    .l-spot { animation: lh-spot-pulse 5s ease-in-out infinite; }
    .l-spot-info {
      position: relative; z-index: 2; min-width: 0; flex: 1;
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    }
    .l-spot-tag {
      font-family: 'Orbitron', monospace; font-size: 7px; font-weight: 800;
      letter-spacing: 2px; color: ${ACCENT};
    }
    .l-spot-title {
      font-family: 'Orbitron', monospace; font-size: 13px; font-weight: 900;
      letter-spacing: 1px; color: #fff; line-height: 1;
    }
    .l-spot-desc {
      font-size: 9px; color: rgba(255,255,255,.7);
      max-width: 280px; line-height: 1.3;
      overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap;
    }
    .l-spot-stats {
      display: flex; gap: 14px;
    }
    .l-spot-stats > div { display: flex; align-items: baseline; gap: 5px; }
    .l-spot-l {
      font-family: 'Orbitron', monospace; font-size: 7px;
      color: rgba(255,255,255,.5); letter-spacing: 1.5px;
    }
    .l-spot-v {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 10px; color: ${ACCENT}; font-weight: 800;
    }
    .l-spot-cta {
      position: relative; z-index: 2;
      background: ${ACCENT}; color: var(--bg, #080c0f);
      padding: 5px 12px; border-radius: 4px;
      font-family: 'Orbitron', monospace; font-size: 8px;
      font-weight: 800; letter-spacing: 1.5px;
      text-decoration: none; white-space: nowrap;
      transition: transform .15s, box-shadow .15s;
    }
    .l-spot-cta:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(242,144,48,.4);
    }


    /* ════════ ECOSYSTEM STRIP (xDEX-wide aggregates) ════════ */
    .l-eco {
      position: relative;
      background: linear-gradient(155deg, rgba(242,144,48,.04), rgba(0,201,141,.02));
      border: 1px solid rgba(138,154,184,.14);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 10px;
      overflow: hidden;
    }
    .l-eco::after {
      /* slow scan line for "live data" effect */
      content: ''; position: absolute; top: 0; bottom: 0; width: 80px;
      background: linear-gradient(90deg, transparent, rgba(242,144,48,.05), transparent);
      animation: l-scan 8s linear infinite;
      pointer-events: none;
    }
    @keyframes l-scan {
      0% { transform: translateX(-100px); }
      100% { transform: translateX(calc(100vw + 100px)); }
    }
    .l-eco-hd {
      display: flex; justify-content: space-between; align-items: baseline;
      margin-bottom: 6px;
    }
    .l-eco-tag {
      font-family: 'Orbitron', monospace; font-size: 9px;
      letter-spacing: 2.5px; font-weight: 800;
      color: rgba(255,255,255,.85);
      display: inline-flex; align-items: center; gap: 6px;
    }
    .l-eco-tag::before {
      content: ''; width: 6px; height: 6px; border-radius: 50%;
      background: var(--neon-green, #00c98d); box-shadow: 0 0 6px var(--neon-green, #00c98d);
      animation: lh-pulse-glow 1.5s ease infinite;
    }
    .l-eco-src {
      font-family: 'Orbitron', monospace; font-size: 7px;
      color: var(--text-faint, #5a6a82); letter-spacing: 1.2px;
    }
    .l-eco-row {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;
    }
    @media (max-width: 720px) { .l-eco-row { grid-template-columns: repeat(2, 1fr); } }
    .l-eco-cell {
      background: rgba(138,154,184,.04);
      border: 1px solid rgba(138,154,184,.12);
      border-radius: 7px;
      padding: 8px 10px;
      text-align: center;
    }
    .l-eco-l {
      font-family: 'Orbitron', monospace; font-size: 7px;
      letter-spacing: 1.5px; color: var(--text-faint, #5a6a82);
    }
    .l-eco-v {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 16px; font-weight: 800; color: ${ACCENT}; margin-top: 2px;
    }

    /* ════════ TOP POOLS ROW ════════ */
    .l-pools {
      margin-bottom: 10px;
    }
    .l-pools-hd {
      display: flex; justify-content: space-between; align-items: baseline;
      margin-bottom: 6px;
    }
    .l-pools-tag {
      font-family: 'Orbitron', monospace; font-size: 9px;
      letter-spacing: 2.5px; font-weight: 800; color: rgba(255,255,255,.85);
    }
    .l-pools-more {
      font-family: 'Orbitron', monospace; font-size: 8px;
      letter-spacing: 1.5px; font-weight: 700; color: ${ACCENT};
      text-decoration: none; padding: 3px 8px;
      border: 1px solid rgba(242,144,48,.3); border-radius: 4px;
    }
    .l-pools-more:hover { background: rgba(242,144,48,.08); }
    .l-pools-grid {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
    }
    @media (max-width: 720px) { .l-pools-grid { grid-template-columns: repeat(2, 1fr); } }
    .l-pool-card {
      position: relative;
      display: block; text-decoration: none;
      background: rgba(255,255,255,.015);
      border: 1px solid rgba(138,154,184,.14);
      border-radius: 9px;
      padding: 10px;
      transition: transform .15s, border-color .15s, box-shadow .15s;
    }
    .l-pool-card:hover {
      transform: translateY(-2px);
      border-color: rgba(242,144,48,.4);
      box-shadow: 0 6px 18px rgba(242,144,48,.08);
    }
    .l-pool-card.brains {
      border-color: rgba(242,144,48,.35);
      background: linear-gradient(155deg, rgba(242,144,48,.06), rgba(255,255,255,.01));
    }
    .l-pool-card.brains::before {
      content: '★'; position: absolute; top: 6px; right: 7px;
      font-size: 9px; color: ${ACCENT};
    }
    .l-pool-logos {
      display: flex; align-items: center; height: 22px;
      margin-bottom: 6px;
    }
    .l-pool-logo {
      width: 22px; height: 22px; border-radius: 50%;
      background: #06090d;
      border: 1px solid rgba(242,144,48,.3);
      display: inline-block;
      object-fit: cover;
    }
    .l-pool-logo.offset { margin-left: -8px; }
    .l-pool-logo.placeholder {
      background: rgba(242,144,48,.08);
      display: inline-flex; align-items: center; justify-content: center;
      font-family: 'Orbitron', monospace; font-size: 10px; font-weight: 800;
      color: ${ACCENT};
    }
    .l-pool-pair {
      font-family: 'Orbitron', monospace; font-size: 10px;
      font-weight: 800; color: var(--text-primary); letter-spacing: 1px;
    }
    .l-pool-tvl {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 17px; color: ${ACCENT}; font-weight: 900;
      margin: 3px 0 5px;
    }
    .l-pool-foot {
      display: flex; justify-content: space-between;
      font-family: 'Orbitron', monospace; font-size: 8px;
      color: var(--text-faint, #5a6a82); letter-spacing: 1.2px;
    }
    .l-pool-apr { color: var(--neon-green, #00c98d); }
    .l-pool-vol { color: var(--text-muted, #8a9ab8); }

    /* ════════ XNT PRICE CARD (OHLCV chart) ════════ */
    .l-xnt, .l-xnt-empty {
      background: rgba(255,255,255,.015);
      border: 1px solid rgba(242,144,48,.18);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 10px;
    }
    .l-xnt-empty { display: flex; justify-content: space-between; align-items: center; }
    .l-xnt-empty-msg {
      font-family: 'Orbitron', monospace; font-size: 9px;
      color: var(--text-faint, #5a6a82); letter-spacing: 1.2px;
    }
    .l-xnt-hd {
      display: flex; justify-content: space-between; align-items: baseline;
      margin-bottom: 4px;
    }
    .l-xnt-tag {
      font-family: 'Orbitron', monospace; font-size: 9px;
      letter-spacing: 2.5px; font-weight: 800; color: rgba(255,255,255,.85);
    }
    .l-xnt-meta { display: flex; gap: 10px; align-items: baseline; }
    .l-xnt-price {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 14px; font-weight: 800; color: var(--text-primary);
    }
    .l-xnt-pct {
      font-family: 'Orbitron', monospace; font-size: 9px; font-weight: 700;
      letter-spacing: 1px;
    }

    /* ════════ TOP MOVERS ════════ */
    .l-movers {
      margin-bottom: 10px;
    }
    .l-movers-hd {
      display: flex; justify-content: space-between; align-items: baseline;
      margin-bottom: 6px;
    }
    .l-movers-tag {
      font-family: 'Orbitron', monospace; font-size: 9px;
      letter-spacing: 2.5px; font-weight: 800; color: rgba(255,255,255,.85);
    }
    .l-movers-grid {
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;
    }
    @media (max-width: 920px) { .l-movers-grid { grid-template-columns: repeat(2, 1fr); } }
    .l-mover-card {
      display: grid; grid-template-columns: auto auto 1fr auto;
      align-items: center; gap: 8px;
      background: rgba(255,255,255,.015);
      border: 1px solid rgba(138,154,184,.14);
      border-radius: 8px;
      padding: 8px 10px;
      text-decoration: none;
      transition: transform .15s, border-color .15s, box-shadow .15s;
    }
    .l-mover-card:hover {
      transform: translateY(-2px);
      border-color: rgba(242,144,48,.4);
      box-shadow: 0 6px 18px rgba(242,144,48,.08);
    }
    .l-mover-rank {
      font-family: 'Orbitron', monospace; font-size: 9px; font-weight: 800;
      color: var(--text-faint, #5a6a82); letter-spacing: 1px;
    }
    .l-mover-info { min-width: 0; }
    .l-mover-sym {
      font-family: 'Orbitron', monospace; font-size: 10px;
      color: var(--text-primary); font-weight: 800; letter-spacing: 0.5px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .l-mover-vol {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 11px; color: ${ACCENT}; font-weight: 800; margin-top: 1px;
    }
    .l-mover-heat { text-align: right; }
    .l-mover-heat-l {
      font-family: 'Orbitron', monospace; font-size: 6px;
      color: var(--text-faint, #5a6a82); letter-spacing: 1.2px;
    }
    .l-mover-heat-v {
      font-family: 'Orbitron', monospace; font-variant-numeric: tabular-nums;
      font-size: 11px; font-weight: 800; color: var(--neon-green, #00c98d);
    }

    /* ── mobile: keep the Overview tight + the pools table from overflowing ── */
    @media (max-width: 560px) {
      .f8 .ov-lf9 { padding: 11px 12px 9px; }
      .f8 .ov-pools { padding: 6px 12px 12px; }
      .f8 .ovp-head, .f8 .ovp-row { grid-template-columns: 1fr 56px 64px 38px; gap: 6px; padding-left: 8px; padding-right: 8px; }
      .f8 .ovp-head span, .f8 .ovp-row .num { font-size: 11px; }
      .f8 .ovp-pair b { font-size: 12px; }
      .f8 .ovp-pair .f8tlogo.pair img, .f8 .ovp-pair .f8tlogo.pair .ph { width: 24px; height: 24px; }
      .f8 .ov-lf9 .lf9-stat { min-width: 40%; padding: 0 12px; }
      /* network monitor: 4-up row → 2×2 on phones so long numbers don't crush */
      .f8 .f8ngrid { grid-template-columns: 1fr 1fr; }
      .f8 .f8ngrid .nc:nth-child(2n) { border-right: none; }
      .f8 .f8ngrid .nc:nth-child(-n+2) { border-bottom: 1px solid #141d29; }
      /* boost carousel — the title/price were huge on phones */
      .l-overlay { padding: 13px; }
      .l-nm { font-size: 16px; letter-spacing: .4px; }
      .l-pr { font-size: 12px; }
      .l-tag { font-size: 8px; letter-spacing: 2px; margin-bottom: 5px; }
      .l-cta { gap: 6px; margin-top: 10px; }
      .l-cta a { padding: 7px 11px; font-size: 8.5px; }
      .l-arrow { width: 28px; height: 28px; font-size: 15px; }
      .l-live, .l-clk { font-size: 7px; padding: 3px 7px; }
    }
  `;
  document.head.appendChild(s);
}
