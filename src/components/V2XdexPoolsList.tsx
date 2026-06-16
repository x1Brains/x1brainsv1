// V2XdexPoolsList — every xDEX pool containing BRAINS or LB, rendered in the
// same rich card layout as PoolsTab's Lab Work Pools section.
//
// Each card shows:
//   • Pair logos + name + ECOSYSTEM/STD tag + TVL header
//   • Per-token price tiles + liquidity + 24h change
//   • Independent on-chain TWAP chart with date-range labels
//   • LP supply (read straight from the pool state account)
//   • Pool address with copy + explorer link + CREATED BY: XDEX
//   • SWAP / DEPOSIT / WITHDRAW actions — all native:
//       SWAP    → navigates to /swap with the pair pre-selected
//       DEPOSIT → opens PoolsTab's DepositModal in a portal
//       WITHDRAW → opens PoolsTab's WithdrawModal in a portal

import { FC, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { type IndexerSnapshot, type IndexerPool, type IndexerTokenSide } from '../lib/brainsIndexer';
import {
  fetchXdexPoolHistory, getCachedXdexPoolHistory,
  fetchXdexPoolState, getCachedXdexPoolState,
  type PricePoint, type XdexPoolMeta,
} from '../lib/xdexPoolChart';
import { BRAINS_MINT, BRAINS_LOGO, XNT_LOGO } from '../constants';
import { fetchPairingPools, fetchTokenMeta } from '../pages/PairingMarketplace';
import { DepositModal, WithdrawModal, type PoolView } from '../pages/PoolsTab';
import { buildXdexPoolView, fetchWalletLp } from '../lib/xdexPoolView';
import type { V2SwapInitState } from '../pages/V2Swap';

const ACCENT = '#f29030';
const TEXT   = '#e0f0ff';
const MUTED  = '#8a9ab8';
const DIM    = '#5a6a82';
const GOOD   = '#00c98d';
const BAD    = '#ff4466';
const LINE   = 'rgba(242,144,48,0.13)';

const mono = { fontFamily: 'Orbitron, monospace', fontVariantNumeric: 'tabular-nums' as const };

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function fmtUSD(v: number): string {
  if (!v) return '$0';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(2)}K`;
  if (v >= 1)         return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}
function fmtPrice(v: number): string {
  if (!v || !isFinite(v)) return '—';
  if (v >= 1)      return `$${v.toFixed(4)}`;
  if (v >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(8)}`;
}
function fmtPct(v: number): string {
  if (!isFinite(v)) return '—';
  return `${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(2)}%`;
}
function fmtDate(unixSecOrIso: number | string): string {
  let t: Date;
  if (typeof unixSecOrIso === 'number') t = new Date(unixSecOrIso * 1000);
  else t = new Date(unixSecOrIso);
  if (isNaN(t.getTime())) return '—';
  return `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()}`;
}

const WXNT_MINT = 'So11111111111111111111111111111111111111112';
type Pair = { tag: string; quote: string };

// Pairing pools are TOKEN/XNT — "base" is the deposited (non-XNT) token, "quote"
// is XNT. tag = base symbol, which keeps the BRAINS/LB tab filter working
// (BRAINS/LB pools still tag as 'BRAINS'/'LB').
function classify(p: IndexerPool): Pair | null {
  const sym = (s: string) => s || 'OTHER';
  if (p.token1.address === WXNT_MINT) return { tag: sym(p.token2.symbol), quote: 'XNT' };
  if (p.token2.address === WXNT_MINT) return { tag: sym(p.token1.symbol), quote: 'XNT' };
  // Non-XNT pair (uncommon for pairing) — base = token1.
  return { tag: sym(p.token1.symbol), quote: sym(p.token2.symbol) };
}

/** "base" = the non-XNT side; "quote" = XNT (or token2 for a non-XNT pair). */
function sides(p: IndexerPool, _pair: Pair) {
  const baseIsToken1 = p.token1.address !== WXNT_MINT;
  const base  = baseIsToken1 ? p.token1 : p.token2;
  const quote = baseIsToken1 ? p.token2 : p.token1;
  return { base, quote };
}

const EXPLORER_URL = (addr: string) => `https://explorer.mainnet.x1.xyz/address/${addr}`;

type Tab = 'all' | 'brains' | 'lb';

export default function V2XdexPoolsList({ prism }: { prism: IndexerSnapshot | null }) {
  const [tab, setTab] = useState<Tab>('all');

  // Pools created by the LP Pairing marketplace, built straight from its on-chain
  // PoolRecords (these matched pools aren't in xDEX's /pool/list feed). null =
  // still loading; we gate render until it lands. Prices/logos are enriched from
  // prism where xDEX happens to index the token, else resolved via token meta.
  const [built, setBuilt] = useState<Array<{ pool: IndexerPool; pair: Pair }> | null>(null);

  const prismMeta = useMemo(() => {
    const m = new Map<string, { price: number; logo?: string; symbol?: string }>();
    for (const p of prism?.pools ?? []) {
      for (const t of [p.token1, p.token2]) {
        if (t.address && !m.has(t.address)) m.set(t.address, { price: t.price, logo: t.logo, symbol: t.symbol });
      }
    }
    return m;
  }, [prism]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const pps = await fetchPairingPools();
      const mints = [...new Set(pps.flatMap(p => [p.tokenA, p.tokenB]))];
      const meta = new Map<string, { symbol: string; logo?: string }>();
      await Promise.all(mints.map(async (mint) => {
        const pm = prismMeta.get(mint);
        try {
          const tm = await fetchTokenMeta(mint);
          meta.set(mint, { symbol: tm.symbol, logo: tm.logo ?? pm?.logo });
        } catch {
          meta.set(mint, { symbol: pm?.symbol ?? mint.slice(0, 4), logo: pm?.logo });
        }
      }));
      if (!alive) return;
      const side = (mint: string): IndexerTokenSide => {
        const tm = meta.get(mint); const pm = prismMeta.get(mint);
        let logo = tm?.logo ?? pm?.logo;
        if (mint === BRAINS_MINT) logo = BRAINS_LOGO;
        if (mint === WXNT_MINT)   logo = XNT_LOGO;
        return {
          address: mint,
          symbol:  mint === WXNT_MINT ? 'XNT' : (tm?.symbol || 'OTHER'),
          logo,
          price:   pm?.price ?? 0,
        };
      };
      const list = pps.map(pp => {
        const pool: IndexerPool = {
          pool_address: pp.poolAddress, lp_mint: pp.lpMint,
          lp_price: 0, lp_fee_24h: 0, lp_token_holder_count: 0,
          token1: side(pp.tokenA), token2: side(pp.tokenB),
          tvl: pp.usdVal * 2, apr_24h: 0, txns_24h: 0,
          createdAt: new Date(pp.createdAt * 1000).toISOString(),
        };
        return { pool, pair: classify(pool)! };
      });
      list.sort((a, b) => b.pool.tvl - a.pool.tvl);
      setBuilt(list);
    })().catch(() => { if (alive) setBuilt([]); });
    return () => { alive = false; };
  }, [prismMeta]);

  const pools = useMemo(() => {
    if (!built) return [] as Array<{ pool: IndexerPool; pair: Pair }>;
    return built.filter(({ pair }) =>
      tab === 'all' || (tab === 'brains' && pair.tag === 'BRAINS') || (tab === 'lb' && pair.tag === 'LB'));
  }, [built, tab]);

  const totalTvl = pools.reduce((s, p) => s + (p.pool.tvl ?? 0), 0);
  const totalVol = pools.reduce((s, p) => s + (p.pool.token1.volume_usd_24h ?? 0) + (p.pool.token2.volume_usd_24h ?? 0), 0);
  const totalFee = pools.reduce((s, p) => s + (p.pool.lp_fee_24h ?? 0), 0);

  if (built === null) {
    return (
      <div className="lf9-panel">
        <div className="lf9-head"><span className="t">Pools &amp; Charts</span><span className="rule" /></div>
        <div className="lf9-empty">Loading pairing pools…</div>
      </div>
    );
  }

  return (
    <>
      {/* ════════ STATS + FILTER PANEL ════════ */}
      <div className="lf9-panel">
        <div className="lf9-pairhead">
          <div>
            <div className="lf9-pairtitle">Pools &amp; Charts</div>
            <div className="lf9-pairsub">Pools seeded through the LP Pairing marketplace · swap, deposit &amp; withdraw</div>
          </div>
          <div className="lf9-pairactions">
            {(['all', 'brains', 'lb'] as Tab[]).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={tab === t ? 'lf9-stake' : 'lf9-fund'}
              >
                {t === 'all' ? 'ALL' : t === 'brains' ? 'BRAINS' : 'LB'}
              </button>
            ))}
          </div>
        </div>
        <div className="lf9-stat-row">
          <div className="lf9-stat"><div className="l">Pools</div><div className="v">{pools.length}</div><div className="s">live pairs</div></div>
          <div className="lf9-stat"><div className="l">TVL · USD</div><div className="v accent">{fmtUSD(totalTvl)}</div><div className="s">total locked</div></div>
          <div className="lf9-stat"><div className="l">24h Volume</div><div className="v">{fmtUSD(totalVol)}</div><div className="s">across pools</div></div>
          <div className="lf9-stat"><div className="l">24h Fees</div><div className="v">{fmtUSD(totalFee)}</div><div className="s">LP earnings</div></div>
        </div>
      </div>

      {/* ════════ POOLS LIST PANEL ════════ */}
      <div className="lf9-panel">
        <div className="lf9-head"><span className="t">Pairing Pools</span><span className="rule" /></div>
        {pools.length === 0 ? (
          <div className="lf9-empty">No pairing pools yet — they appear here once a listing is matched.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {pools.map(({ pool, pair }) => (
              <PoolCard key={pool.pool_address} pool={pool} pair={pair} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ─── per-pool card ───────────────────────────────────────────── */

const PoolCard: FC<{ pool: IndexerPool; pair: Pair }> = ({ pool, pair }) => {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();
  const navigate = useNavigate();
  const { base, quote } = sides(pool, pair);

  // Independent on-chain TWAP history — one observation account per pool.
  const [points, setPoints] = useState<PricePoint[]>(
    () => getCachedXdexPoolHistory(pool.pool_address, base.address) ?? [],
  );
  // Pool state — drives LP supply display + builds the PoolView the
  // PoolsTab modals consume for native deposit/withdraw.
  const [state, setState] = useState<XdexPoolMeta | null>(
    () => getCachedXdexPoolState(pool.pool_address),
  );
  // Wallet's LP balance (for withdraw). Re-fetched whenever wallet changes.
  const [walletLp, setWalletLp] = useState<bigint>(0n);
  // Native modal currently open for this card (if any).
  const [modal, setModal] = useState<'deposit' | 'withdraw' | null>(null);

  useEffect(() => {
    let alive = true;
    fetchXdexPoolHistory(connection, pool.pool_address, base.address)
      .then(p => { if (alive) setPoints(p); })
      .catch(() => {});
    fetchXdexPoolState(connection, pool.pool_address)
      .then(s => { if (alive && s) setState(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, [connection, pool.pool_address, base.address]);

  // Wallet LP fetch — runs once we have state + connected wallet.
  useEffect(() => {
    if (!publicKey || !state?.lpMint) { setWalletLp(0n); return; }
    let alive = true;
    fetchWalletLp(connection, publicKey, state.lpMint)
      .then(lp => { if (alive) setWalletLp(lp); })
      .catch(() => {});
    return () => { alive = false; };
  }, [connection, publicKey, state?.lpMint]);

  // Build the PoolView the modals expect from xdex state + prism + wallet LP.
  // null until on-chain state has landed.
  const poolView: PoolView | null = useMemo(() => {
    if (!state) return null;
    return buildXdexPoolView({
      poolAddr: pool.pool_address,
      state, prismPool: pool, walletLp,
    });
  }, [state, pool, walletLp]);

  const reloadAfterTx = () => {
    // Bust state cache + re-fetch so the LP supply / wallet LP / vault balances
    // reflect the just-mined tx.
    fetchXdexPoolState(connection, pool.pool_address).then(s => { if (s) setState(s); }).catch(() => {});
    if (publicKey && state?.lpMint) {
      fetchWalletLp(connection, publicKey, state.lpMint).then(setWalletLp).catch(() => {});
    }
  };

  const goSwap = () => {
    const initState: V2SwapInitState = {
      fromMint:     base.address,
      fromSymbol:   base.symbol,
      fromDecimals: state?.dec0 === undefined ? undefined : (state.token0Mint === base.address ? state.dec0 : state.dec1),
      toMint:       quote.address,
      toSymbol:     quote.symbol,
      toDecimals:   state === null ? undefined : (state.token0Mint === quote.address ? state.dec0 : state.dec1),
    };
    navigate('/swap', { state: initState });
  };

  const pct = (() => {
    if (points.length < 2) return null;
    const first = points[0].price, last = points[points.length - 1].price;
    if (first <= 0) return null;
    return ((last - first) / first) * 100;
  })();
  const up = (pct ?? 0) >= 0;
  const lineColor = pct == null ? MUTED : (up ? GOOD : BAD);

  const lastPrice = points.length > 0 ? points[points.length - 1].price : 0;
  const firstTs = points.length > 0 ? points[0].ts : 0;
  const lastTs  = points.length > 0 ? points[points.length - 1].ts : 0;

  const tagColor = pair.tag === 'BRAINS' ? ACCENT : GOOD;
  const tagLabel = pair.tag === 'BRAINS' ? '🧠 ECOSYSTEM' : '🧪 ECOSYSTEM';

  const lpSupplyUi = state
    ? Number(state.lpSupply) / Math.pow(10, state.lpDecimals || 9)
    : null;

  const volUsd = (pool.token1.volume_usd_24h ?? 0) + (pool.token2.volume_usd_24h ?? 0);

  return (
    <div style={{
      background: 'var(--v2-glow), rgba(13,21,32,.55)',
      border: '1px solid rgba(242,144,48,.12)', borderRadius: 16,
      padding: '20px 22px',
      position: 'relative', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      {/* Top accent stripe — orange-only for v2 cohesion. */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: 'linear-gradient(90deg,rgba(242,144,48,.6),transparent)',
      }} />

      {/* ── HEADER ── stacked overlap logos + name + tag + big TVL ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <PairLogoOverlap base={base} quote={quote} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...mono, fontSize: 16, fontWeight: 900, color: '#e6ebf2' }}>
            {base.symbol || '??'} / {quote.symbol || '??'}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{
              ...mono, padding: '2px 7px', borderRadius: 5,
              background: `${tagColor}1a`, border: `1px solid ${tagColor}55`,
              color: tagColor, fontSize: 7, fontWeight: 800, letterSpacing: 1,
            }}>{tagLabel}</span>
            <span style={{
              ...mono, padding: '2px 7px', borderRadius: 5,
              background: 'rgba(242,144,48,.08)', border: '1px solid rgba(242,144,48,.25)',
              color: ACCENT, fontSize: 7, fontWeight: 800, letterSpacing: 1,
            }}>APR {(pool.apr_24h ?? 0).toFixed(2)}%</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div style={{ ...mono, fontSize: 15, fontWeight: 900, color: ACCENT }}>
            {pool.tvl > 0 ? fmtUSD(pool.tvl) : <span style={{ color: DIM }}>—</span>}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: DIM, marginTop: 2 }}>TVL</div>
        </div>
      </div>

      {/* ── PRICE STATS ROW (same 3-up grid as PoolsTab) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {[
          { label: `${base.symbol || 'BASE'} PRICE`,   val: base.price  > 0 ? fmtPrice(base.price)  : '—' },
          { label: `${quote.symbol || 'QUOTE'} PRICE`, val: quote.price > 0 ? fmtPrice(quote.price) : '—' },
          { label: 'LIQUIDITY',                        val: pool.tvl    > 0 ? fmtUSD(pool.tvl)      : '—' },
        ].map(s => (
          <div key={s.label} style={{ background: 'rgba(255,255,255,.02)', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ ...mono, fontSize: 7, color: '#3a4150', letterSpacing: .5, marginBottom: 4 }}>{s.label}</div>
            <div style={{ ...mono, fontSize: 11, fontWeight: 700, color: '#cdd8e2' }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* ── CHART (in its own bordered panel, same as PoolsTab) ── */}
      <div style={{ background: 'rgba(255,255,255,.02)', borderRadius: 8, padding: '10px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ ...mono, fontSize: 8, color: '#3a4150' }}>
            {base.symbol}/{quote.symbol} PRICE
          </div>
          {pct != null && (
            <div style={{ ...mono, fontSize: 9, color: lineColor, fontWeight: 800 }}>
              {fmtPct(pct)}
            </div>
          )}
        </div>
        <MiniChart points={points} color={lineColor} />
        {points.length >= 2 && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            ...mono, fontSize: 8, color: DIM, letterSpacing: 1, marginTop: 6,
          }}>
            <span>{fmtDate(firstTs)}</span>
            <span style={{ color: '#cdd8e2', fontWeight: 700 }}>
              1 {base.symbol} = {lastPrice > 0 ? lastPrice.toFixed(lastPrice < 1 ? 4 : 4) : '—'} {quote.symbol}
            </span>
            <span>Now</span>
          </div>
        )}
      </div>

      {/* ── LP DISTRIBUTION (xDex pools = LP supply only; no creator A/B) ── */}
      <div>
        <div style={{ ...mono, fontSize: 8, color: '#3a4150', letterSpacing: 1, marginBottom: 6 }}>LP DISTRIBUTION</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          <DistTile label="LP SUPPLY" value={lpSupplyUi != null ? fmtLp(lpSupplyUi) : '—'} sub="100%" color={ACCENT} />
          <DistTile label="24H VOL"   value={fmtUSD(volUsd)}            sub="" color={MUTED} />
          <DistTile label="24H FEE"   value={fmtUSD(pool.lp_fee_24h)}   sub="" color={MUTED} />
          <DistTile label="HOLDERS"   value={String(pool.lp_token_holder_count ?? 0)} sub="" color={MUTED} />
        </div>
      </div>

      {/* ── POOL ADDRESS BAR + CREATED BY ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, padding: '8px 12px',
        background: 'rgba(242,144,48,0.04)',
        border: `1px solid ${LINE}`,
        borderRadius: 8,
      }}>
        <div style={{ ...mono, fontSize: 10, color: MUTED, letterSpacing: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Pool: <span style={{ color: '#cdd8e2', fontWeight: 700 }}>{shortAddr(pool.pool_address)}</span>
          {pool.createdAt && (
            <span style={{ color: DIM, marginLeft: 8 }}>· {fmtDate(pool.createdAt)}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <CopyChip text={pool.pool_address} />
          <a href={EXPLORER_URL(pool.pool_address)} target="_blank" rel="noopener noreferrer"
            style={chipStyle(ACCENT)} title="Open in explorer">🔍 EXPLORER</a>
        </div>
      </div>

      <div style={{ ...mono, fontSize: 8, color: DIM, letterSpacing: 1.5, marginTop: -6 }}>
        CREATED BY: <span style={{ color: ACCENT, fontWeight: 800 }}>XDEX</span>
      </div>

      {/* ── ACTIONS — all native, no external links ── */}
      <div style={{ display: 'flex', gap: 8 }}>
        <ActionButton color={ACCENT} onClick={goSwap}>⚡ SWAP</ActionButton>
        <ActionButton
          color={ACCENT}
          disabled={!publicKey || !poolView}
          title={!publicKey ? 'Connect wallet to deposit' : !poolView ? 'Loading pool state…' : ''}
          onClick={() => setModal('deposit')}
        >➕ DEPOSIT</ActionButton>
        <ActionButton
          color={BAD}
          disabled={!publicKey || !poolView || walletLp === 0n}
          title={!publicKey ? 'Connect wallet to withdraw' : walletLp === 0n ? 'No LP balance in this pool' : ''}
          onClick={() => setModal('withdraw')}
        >➖ WITHDRAW</ActionButton>
      </div>

      {/* Native deposit/withdraw modals — same components PoolsTab uses, fed
          a PoolView synthesized from xdex state + prism + wallet LP. */}
      {modal === 'deposit' && poolView && publicKey && (
        <DepositModal
          pool={poolView}
          isMobile={typeof window !== 'undefined' && window.innerWidth < 640}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); reloadAfterTx(); }}
        />
      )}
      {modal === 'withdraw' && poolView && publicKey && (
        <WithdrawModal
          pool={poolView}
          isMobile={typeof window !== 'undefined' && window.innerWidth < 640}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); reloadAfterTx(); }}
        />
      )}
    </div>
  );
};

function fmtLp(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const DistTile: FC<{ label: string; value: string; sub?: string; color: string }> = ({ label, value, sub, color }) => (
  <div style={{
    padding: '8px 10px',
    background: 'rgba(255,255,255,.02)',
    borderRadius: 8,
  }}>
    <div style={{ ...mono, fontSize: 7, color: '#3a4150', letterSpacing: .5, marginBottom: 4 }}>
      {label}
    </div>
    <div style={{ ...mono, fontSize: 11, fontWeight: 700, color: '#cdd8e2' }}>
      {value}
    </div>
    {sub && (
      <div style={{ ...mono, fontSize: 8, color, marginTop: 2, fontWeight: 700 }}>
        {sub}
      </div>
    )}
  </div>
);

/* ─── sub-components ──────────────────────────────────────────── */

// Same stacked-overlap pattern PoolsTab uses: a 38px primary chip with a
// 22px secondary chip in the bottom-right corner.
const PairLogoOverlap: FC<{ base: { logo?: string; symbol: string; address: string }; quote: { logo?: string; symbol: string; address: string } }> = ({ base, quote }) => (
  <div style={{ position: 'relative', width: 50, height: 50, flexShrink: 0 }}>
    <LogoChip src={base.address === BRAINS_MINT ? BRAINS_LOGO : base.logo}   fallback={base.symbol?.[0] ?? '?'}  size={38} style={{ top: 0,    left: 0, zIndex: 1 }} />
    <LogoChip src={quote.address === BRAINS_MINT ? BRAINS_LOGO : quote.logo} fallback={quote.symbol?.[0] ?? '?'} size={22} style={{ bottom: -2, right: -2, zIndex: 2, position: 'absolute' }} />
  </div>
);

const LogoChip: FC<{ src?: string; fallback: string; size: number; style: React.CSSProperties }> = ({ src, fallback, size, style }) => (
  <div style={{
    position: 'absolute', width: size, height: size, borderRadius: '50%',
    overflow: 'hidden', background: '#0a0e14',
    border: `1px solid ${ACCENT}55`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    ...mono, fontSize: Math.round(size * 0.4), color: ACCENT, fontWeight: 800,
    ...style,
  }}>
    {src ? <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : fallback}
  </div>
);

const Stat: FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <div style={{
    padding: '7px 9px',
    background: 'rgba(242,144,48,0.03)',
    border: `1px solid ${LINE}`,
    borderRadius: 6,
  }}>
    <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1.3, fontWeight: 700 }}>
      {label}
    </div>
    <div style={{ ...mono, fontSize: 11, color, fontWeight: 800, marginTop: 3 }}>
      {value}
    </div>
  </div>
);

const MiniChart: FC<{ points: PricePoint[]; color: string }> = ({ points, color }) => {
  if (points.length < 2) {
    return (
      <div style={{
        height: 60, borderRadius: 5,
        background: 'rgba(255,255,255,.02)',
        border: '1px solid rgba(255,255,255,.04)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        ...mono, fontSize: 9, color: DIM, letterSpacing: 1.5,
      }}>
        {points.length === 0 ? '⟳ LOADING CHART' : '— NOT ENOUGH TRADES —'}
      </div>
    );
  }
  const W = 400, H = 60, PAD = 4;
  const prices = points.map(p => p.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const range = maxP - minP || maxP * 0.01 || 1;
  const toX = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const toY = (p: number) => H - PAD - ((p - minP) / range) * (H - PAD * 2);
  const path = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p.price).toFixed(1)}`,
  ).join(' ');
  const area = `${path} L ${toX(points.length - 1).toFixed(1)} ${H} L ${PAD} ${H} Z`;
  const gradId = `xdpc-${Math.abs(Array.from(color).reduce((s, c) => s + c.charCodeAt(0), 0))}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 60, display: 'block' }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
};

const CopyChip: FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
      title="Copy pool address"
      style={chipStyle(copied ? GOOD : ACCENT)}
    >
      {copied ? '✓' : '⎘'}
    </button>
  );
};

const chipStyle = (color: string): React.CSSProperties => ({
  ...mono,
  padding: '4px 9px', borderRadius: 5,
  background: `${color}14`, border: `1px solid ${color}55`,
  color, fontSize: 10, fontWeight: 700,
  textDecoration: 'none', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
});

const ActionButton: FC<{
  color: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}> = ({ color, onClick, disabled, title, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    style={{
      ...mono,
      flex: 1, padding: '10px 0', textAlign: 'center' as const,
      background: disabled ? 'rgba(255,255,255,.03)' : `${color}14`,
      border: `1px solid ${disabled ? 'rgba(255,255,255,.08)' : `${color}66`}`,
      borderRadius: 6,
      color: disabled ? '#5a6a82' : color,
      fontSize: 9, fontWeight: 800, letterSpacing: 1.3,
      cursor: disabled ? 'not-allowed' : 'pointer',
      whiteSpace: 'nowrap' as const,
      transition: 'background .15s, border-color .15s',
      opacity: disabled ? 0.65 : 1,
    }}
  >
    {children}
  </button>
);
