import { useEffect, useMemo, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { BRAINS_MINT, LB_MINT } from '../constants';
import { fetchPrice, getCachedPrice } from '../lib/prices';
import {
  fetchLeaderboard, getCachedLeaderboard, type BurnerEntry,
} from '../components/BurnLeaderboard';
import {
  fetchBurnsFromChain, getCachedChainBurns, type ChainBurnSummary,
} from '../lib/chainBurns';
import V2BurnDashboard from '../components/V2BurnDashboard';
import V2BurnLeaderboard from '../components/V2BurnLeaderboard';
import V2BurnTransactions from '../components/V2BurnTransactions';
import V2BurnPanel from '../components/V2BurnPanel';
import V2PageHeader from '../components/V2PageHeader';

const BRAINS_INITIAL = 8_880_000;

const ACCENT = '#f29030';
const MUTED  = '#5c7a90';

const mono = { fontFamily: 'Orbitron, monospace', fontVariantNumeric: 'tabular-nums' as const };

// Lightweight localStorage cache for the on-chain supply RPCs. The values
// barely move between page loads (BRAINS supply only changes on a burn),
// so a 10-min TTL paint is fine and turns first-render into instant.
const SUPPLY_CACHE_KEY = 'v2_inc_supply_v1';
const SUPPLY_TTL_MS = 10 * 60_000;

function readCachedSupply(): { brainsSupply: number | null; lbSupply: number | null; brainsBurned: number | null } {
  try {
    const raw = localStorage.getItem(SUPPLY_CACHE_KEY);
    if (!raw) return { brainsSupply: null, lbSupply: null, brainsBurned: null };
    const obj = JSON.parse(raw) as { bs?: number; ls?: number; ts: number };
    if (Date.now() - obj.ts > SUPPLY_TTL_MS) return { brainsSupply: null, lbSupply: null, brainsBurned: null };
    const brainsSupply = typeof obj.bs === 'number' ? obj.bs : null;
    const lbSupply     = typeof obj.ls === 'number' ? obj.ls : null;
    const brainsBurned = brainsSupply != null ? Math.max(0, BRAINS_INITIAL - brainsSupply) : null;
    return { brainsSupply, lbSupply, brainsBurned };
  } catch {
    return { brainsSupply: null, lbSupply: null, brainsBurned: null };
  }
}

function persistSupply(brainsSupply: number | null, lbSupply: number | null) {
  try {
    localStorage.setItem(SUPPLY_CACHE_KEY, JSON.stringify({
      bs: brainsSupply ?? undefined,
      ls: lbSupply ?? undefined,
      ts: Date.now(),
    }));
  } catch {}
}

// Convert a generic chain-burn summary into the BurnerEntry shape the v2
// leaderboard + transactions panels already speak. Keeps both BRAINS and LB
// flowing through the same UI components.
function summaryToEntries(s: ChainBurnSummary | null): BurnerEntry[] {
  if (!s) return [];
  const out: BurnerEntry[] = [];
  s.totals.forEach((v, address) => {
    out.push({
      address,
      points: 0,
      burned: v.burned,
      txCount: v.txCount,
      events: v.events.map(e => ({ amount: e.amount, blockTime: e.block_time, sig: e.sig })),
    });
  });
  return out;
}

type TokenTab = 'BRAINS' | 'LB';

export default function V2Incinerator() {
  const { connection } = useConnection();

  // BRAINS — Supabase-backed scan (richer events)
  const [brainsEntries, setBrainsEntries] = useState<BurnerEntry[]>(() => getCachedLeaderboard() ?? []);
  const [brainsScanning, setBrainsScanning] = useState(false);

  // Seed every numeric state from cache on mount so the dashboard paints in
  // the same beat as the v2 landing pools/TVL data. Background fetches still
  // run and overwrite with fresh values; we just don't make the user wait
  // for them before showing *anything*.
  const cachedSupply = readCachedSupply();
  const [brainsBurned, setBrainsBurned] = useState<number | null>(cachedSupply.brainsBurned);
  const [brainsSupply, setBrainsSupply] = useState<number | null>(cachedSupply.brainsSupply);
  const [brainsPrice,  setBrainsPrice]  = useState<number>(() => getCachedPrice(BRAINS_MINT));
  const [lbSummary, setLbSummary]   = useState<ChainBurnSummary | null>(() => getCachedChainBurns(LB_MINT) ?? null);
  const [lbSupply,  setLbSupply]    = useState<number | null>(cachedSupply.lbSupply);
  const [lbPrice,   setLbPrice]     = useState<number>(() => getCachedPrice(LB_MINT));
  const [lbScanning, setLbScanning] = useState(false);

  const [tab, setTab] = useState<TokenTab>('BRAINS');

  // ── Supply + prices — fresh fetch on mount, results overwrite the cache
  // we seeded above so the next page-open paints from the latest snapshot.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [bs, ls, bp, lp] = await Promise.all([
          connection.getTokenSupply(new PublicKey(BRAINS_MINT)).catch(() => null),
          connection.getTokenSupply(new PublicKey(LB_MINT)).catch(() => null),
          fetchPrice(BRAINS_MINT).catch(() => 0),
          fetchPrice(LB_MINT).catch(() => 0),
        ]);
        if (!alive) return;
        const bSupply = bs?.value?.uiAmount ?? null;
        const lSupply = ls?.value?.uiAmount ?? null;
        setBrainsSupply(bSupply);
        setLbSupply(lSupply);
        if (bSupply != null) setBrainsBurned(Math.max(0, BRAINS_INITIAL - bSupply));
        if (bp > 0) setBrainsPrice(bp);
        if (lp > 0) setLbPrice(lp);
        persistSupply(bSupply, lSupply);
      } catch {}
    })();
    return () => { alive = false; };
  }, [connection]);

  // ── BRAINS leaderboard scan ──
  useEffect(() => {
    const ctrl = new AbortController();
    setBrainsScanning(true);
    (async () => {
      try {
        const final = await fetchLeaderboard(connection, ctrl.signal, (next) => {
          if (ctrl.signal.aborted) return;
          setBrainsEntries(next);
        });
        if (!ctrl.signal.aborted) setBrainsEntries(final);
      } catch {} finally {
        setBrainsScanning(false);
      }
    })();
    return () => { ctrl.abort(); };
  }, [connection]);

  // ── LB chain scan ──
  // Always run. fetchBurnsFromChain is *incremental* internally — it seeds
  // from the same cache useState() above used for the first paint, then only
  // fetches signatures newer than the cached set. So there's no "full rescan"
  // cost on repeat mounts, but skipping the call entirely (as I did briefly)
  // breaks any case where the cache was empty or partial.
  // Suppress the scanning spinner if we already have a populated cache, so
  // the UI doesn't flicker from "loaded" → "scanning" → "loaded".
  useEffect(() => {
    const ctrl = new AbortController();
    const cached = getCachedChainBurns(LB_MINT);
    const hasHotCache = !!cached && cached.events.length > 0;
    if (!hasHotCache) setLbScanning(true);
    (async () => {
      try {
        const final = await fetchBurnsFromChain(connection, LB_MINT, ctrl.signal, (summary) => {
          if (ctrl.signal.aborted) return;
          setLbSummary(summary);
        });
        if (!ctrl.signal.aborted) setLbSummary(final);
      } catch {} finally {
        setLbScanning(false);
      }
    })();
    return () => { ctrl.abort(); };
  }, [connection]);

  // Active feed for the currently selected tab
  const lbEntries = useMemo(() => summaryToEntries(lbSummary), [lbSummary]);
  const activeEntries = tab === 'BRAINS' ? brainsEntries : lbEntries;
  const activePrice   = tab === 'BRAINS' ? brainsPrice    : lbPrice;
  const activeScanning = tab === 'BRAINS' ? brainsScanning : lbScanning;
  const activeBurnedTotal =
    tab === 'BRAINS'
      ? (brainsBurned ?? undefined)
      : (lbSummary?.totalBurned ?? undefined);

  return (
    <div className="content content-wide v2-glass v2-inc">
      <div className="lw-stack">
        <V2PageHeader title="INCINERATOR" subtitle="BURN ENGINE · X1 MAINNET" />
        {/* Twin-reactor dashboard always shows both tokens */}
        <V2BurnDashboard
          brainsBurned={brainsBurned}
          brainsSupply={brainsSupply}
          brainsPrice={brainsPrice}
          lbBurned={lbSummary?.totalBurned ?? null}
          lbSupply={lbSupply}
          lbPrice={lbPrice}
          lbScanMsg={lbScanning ? 'Scanning LB burn history…' : undefined}
        />

        {/* Two-up: burn portal | token tab selector */}
        <div className="info-card">
          <div className="title">Burn Portal</div>
          <V2BurnPanel />
        </div>

        {/* Tabbed stats for the chosen token */}
        <div className="info-card" style={{ paddingBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div className="title" style={{ margin: 0 }}>Burn Statistics</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['BRAINS', 'LB'] as TokenTab[]).map(t => (
                <button
                  key={t} type="button" onClick={() => setTab(t)}
                  style={{
                    ...mono,
                    padding: '8px 16px', borderRadius: 999,
                    background: tab === t
                      ? 'linear-gradient(135deg, #f29030, #ffb340)'
                      : 'rgba(255,255,255,.04)',
                    border: `1px solid ${tab === t ? 'transparent' : 'rgba(255,255,255,.08)'}`,
                    color: tab === t ? '#0a0e14' : MUTED,
                    fontSize: 9, fontWeight: 800, letterSpacing: 1.8,
                    boxShadow: tab === t ? '0 6px 18px rgba(242,144,48,.35)' : 'none',
                    transition: 'background .15s, color .15s, box-shadow .15s',
                    cursor: 'pointer',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        <V2BurnLeaderboard
          key={`lb-${tab}`}
          entries={activeEntries}
          price={activePrice}
          scanning={activeScanning}
          totalBurnedOverride={activeBurnedTotal}
        />
        <V2BurnTransactions
          key={`tx-${tab}`}
          entries={activeEntries}
          price={activePrice}
          scanning={activeScanning}
          symbol={tab}
        />
      </div>
    </div>
  );
}
