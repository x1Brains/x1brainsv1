import { useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { BRAINS_MINT } from '../constants';
import { fetchPrice } from '../lib/prices';
import {
  fetchLeaderboard, getCachedLeaderboard,
  type BurnerEntry,
} from '../components/BurnLeaderboard';
import { fmtNum, fmtUSD, shortAddr } from '../utils/v2format';

type FlatBurn = { sig: string; wallet: string; amount: number; block_time: number };

function flattenEvents(entries: BurnerEntry[]): FlatBurn[] {
  const all: FlatBurn[] = [];
  for (const e of entries) {
    for (const ev of e.events ?? []) {
      all.push({ sig: ev.sig, wallet: e.address, amount: ev.amount, block_time: ev.blockTime });
    }
  }
  return all.sort((a, b) => b.block_time - a.block_time);
}

const INITIAL_SUPPLY = 8_880_000;
const EXPLORER_BASE  = 'https://explorer.mainnet.x1.xyz/tx/';

// Tier ladder mirrors v1 BurnLeaderboard
const TIERS = [
  { min: 1_000_000, label: 'INCINERATOR',  icon: '☠️', color: '#fffaee', flavor: 'Universal collapse — the final burn' },
  { min:   850_000, label: 'APOCALYPSE',   icon: '💀', color: '#ff1155', flavor: 'Approaching terminal entropy' },
  { min:   700_000, label: 'GODSLAYER',    icon: '⚔️', color: '#dd22ff', flavor: 'Event horizon crossed' },
  { min:   500_000, label: 'DISINTEGRATE', icon: '☢️', color: '#ff2277', flavor: 'Stellar annihilation event' },
  { min:   350_000, label: 'TERMINATE',    icon: '⚡',  color: '#ff4411', flavor: 'Reaching critical mass' },
  { min:   200_000, label: 'ANNIHILATE',   icon: '💥', color: '#ff6622', flavor: 'Industrial-grade incineration' },
  { min:   100_000, label: 'OVERWRITE',    icon: '⚙️', color: '#ff8811', flavor: 'Ceremonial destruction' },
  { min:    50_000, label: 'INFERNO',      icon: '🔥', color: '#ffaa44', flavor: 'Controlled immolation begins' },
  { min:    25_000, label: 'FLAME',        icon: '🕯️', color: '#ffdd77', flavor: 'The ember takes hold' },
  { min:         1, label: 'SPARK',        icon: '✦',  color: '#bbddff', flavor: 'First spark extinguished' },
  { min:         0, label: 'UNRANKED',     icon: '○',  color: '#8899aa', flavor: 'Burn your brains off' },
];

function getTier(amount: number) {
  return TIERS.find(t => amount >= t.min) ?? TIERS[TIERS.length - 1];
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 60)    return `${diff}s`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export default function V2BurnHistory() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [entries, setEntries]     = useState<BurnerEntry[]>([]);
  const [supply, setSupply]       = useState<number | null>(null);
  const [brainsPrice, setBrainsPrice] = useState(0);
  const [loadingAll, setLoadingAll]   = useState(true);
  const [scanMsg, setScanMsg] = useState('');
  const [err, setErr] = useState('');

  // Supply + price (cheap)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [supplyInfo, price] = await Promise.all([
          connection.getTokenSupply(new PublicKey(BRAINS_MINT)).catch(() => null),
          fetchPrice(BRAINS_MINT).catch(() => 0),
        ]);
        if (!alive) return;
        setSupply(supplyInfo?.value?.uiAmount ?? null);
        setBrainsPrice(price);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'Failed to load supply');
      }
    })();
    return () => { alive = false; };
  }, [connection]);

  // Network-wide chain scan (with cache + streaming)
  useEffect(() => {
    const ctrl = new AbortController();

    const cached = getCachedLeaderboard();
    if (cached && cached.length > 0) {
      setEntries(cached);
      setLoadingAll(false);
    }

    (async () => {
      try {
        await fetchLeaderboard(connection, ctrl.signal, (next, progress) => {
          if (ctrl.signal.aborted) return;
          setEntries(next);
          setScanMsg(progress);
          setLoadingAll(false);
        });
        setScanMsg('');
      } catch (e: any) {
        if (!ctrl.signal.aborted) setErr(e?.message ?? 'Chain scan failed');
      } finally { setLoadingAll(false); }
    })();

    return () => { ctrl.abort(); };
  }, [connection]);

  const myWallet = publicKey?.toBase58();
  const mySigs = useMemo(() => {
    if (!myWallet) return [] as FlatBurn[];
    return flattenEvents(entries.filter(e => e.address === myWallet));
  }, [entries, myWallet]);
  const allSigs = useMemo(() => flattenEvents(entries), [entries]);
  const loadingMine = loadingAll && mySigs.length === 0;

  const myTotal = useMemo(() => mySigs.reduce((s, r) => s + (r.amount ?? 0), 0), [mySigs]);
  const supplyBurned = supply != null ? Math.max(0, INITIAL_SUPPLY - supply) : null;
  const burnedPct = supplyBurned != null ? (supplyBurned / INITIAL_SUPPLY) * 100 : null;

  const myTier = getTier(myTotal);
  const next   = myTotal > 0 ? TIERS.find(t => t.min > myTotal) : TIERS[TIERS.length - 2];
  const toNext = next ? next.min - myTotal : 0;
  const tierProgress = next && myTier.min < next.min
    ? Math.min(100, ((myTotal - myTier.min) / (next.min - myTier.min)) * 100)
    : 100;

  return (
    <div className="content content-wide">
      <div className="lw-stack">
        {/* Network overview */}
        <div className="info-card">
          <div className="title">Burn History · Network</div>
          <div className="lw-stats">
            <div className="lw-stat">
              <div className="label">SUPPLY BURNED</div>
              <div className="value">{supplyBurned != null ? fmtNum(supplyBurned, 0) : '…'}</div>
            </div>
            <div className="lw-stat">
              <div className="label">% OF SUPPLY</div>
              <div className="value">{burnedPct != null ? `${burnedPct.toFixed(2)}%` : '…'}</div>
            </div>
            <div className="lw-stat">
              <div className="label">USD VALUE</div>
              <div className="value">{supplyBurned != null && brainsPrice ? fmtUSD(supplyBurned * brainsPrice) : '—'}</div>
            </div>
            <div className="lw-stat">
              <div className="label">EVENTS INDEXED</div>
              <div className="value">{loadingAll && allSigs.length === 0 ? '…' : allSigs.length || '—'}</div>
            </div>
          </div>
          {scanMsg && (
            <div style={{
              marginTop: 10, padding: '8px 12px',
              fontFamily: 'Orbitron,monospace', fontSize: 9,
              color: '#8aaac8', letterSpacing: 1,
              background: 'rgba(242,144,48,.05)',
              border: '1px solid rgba(242,144,48,.15)',
              borderRadius: 7,
            }}>
              ⟳ {scanMsg}
            </div>
          )}
        </div>

        {/* My burns / wallet section */}
        <div className="card">
          <div className="card-title">Your Burns</div>
          {!connected ? (
            <div className="lw-placeholder" style={{ padding: '24px 16px' }}>
              <div className="lw-placeholder-glyph">☄</div>
              <div className="lw-placeholder-title">Connect a wallet</div>
              <div className="lw-placeholder-sub">See your personal burn ledger, tier, and progress to the next rank.</div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ marginTop: 14, maxWidth: 240, alignSelf: 'center' }}
                onClick={() => setVisible(true)}
              >
                CONNECT WALLET
              </button>
            </div>
          ) : loadingMine ? (
            <div className="lw-placeholder" style={{ padding: '24px 16px' }}>
              <div className="lw-placeholder-glyph">⟳</div>
              <div className="lw-placeholder-sub">Loading your burns…</div>
            </div>
          ) : (
            <>
              {/* Tier card */}
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center',
                padding: '14px 16px', marginBottom: 12,
                background: `${myTier.color}08`,
                border: `1px solid ${myTier.color}30`,
                borderRadius: 10,
              }}>
                <div style={{
                  width: 60, height: 60, borderRadius: '50%',
                  background: `${myTier.color}18`,
                  border: `1px solid ${myTier.color}45`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 28,
                }}>{myTier.icon}</div>

                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{
                    fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#9abacf',
                    letterSpacing: 1.5, marginBottom: 4,
                  }}>CURRENT TIER</div>
                  <div style={{
                    fontFamily: 'Orbitron,monospace', fontSize: 18, fontWeight: 900,
                    color: myTier.color, letterSpacing: 1,
                  }}>{myTier.label}</div>
                  <div style={{
                    fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#8aaac8', marginTop: 2,
                  }}>{myTier.flavor}</div>
                </div>

                <div style={{ minWidth: 160, textAlign: 'right' }}>
                  <div style={{
                    fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#9abacf',
                    letterSpacing: 1.5, marginBottom: 4,
                  }}>BURNED</div>
                  <div style={{
                    fontFamily: 'Orbitron,monospace', fontSize: 20, fontWeight: 900,
                    color: myTier.color,
                  }}>{fmtNum(myTotal, 0)}</div>
                  <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#8aaac8' }}>
                    {brainsPrice > 0 ? fmtUSD(myTotal * brainsPrice) : '—'}
                  </div>
                </div>
              </div>

              {/* Progress to next tier */}
              {next && next.label !== myTier.label && (
                <div style={{
                  padding: '10px 14px', marginBottom: 14,
                  background: 'rgba(255,255,255,.03)',
                  border: '1px solid rgba(255,255,255,.06)',
                  borderRadius: 9,
                }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                    fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#9abacf', marginBottom: 6,
                  }}>
                    <span>NEXT · {next.label}</span>
                    <span style={{ color: next.color, fontWeight: 700 }}>
                      {fmtNum(toNext, 0)} BRAINS TO GO
                    </span>
                  </div>
                  <div style={{
                    height: 6, borderRadius: 3, overflow: 'hidden',
                    background: 'rgba(0,0,0,.45)',
                  }}>
                    <div style={{
                      width: `${tierProgress}%`, height: '100%',
                      background: `linear-gradient(90deg, ${myTier.color}, ${next.color})`,
                      transition: 'width .25s ease',
                    }} />
                  </div>
                </div>
              )}

              <div className="lw-stats">
                <div className="lw-stat"><div className="label">YOUR TXS</div><div className="value">{mySigs.length}</div></div>
                <div className="lw-stat"><div className="label">LAST BURN</div><div className="value">{mySigs[0] ? timeAgo(mySigs[0].block_time) + ' ago' : '—'}</div></div>
                <div className="lw-stat"><div className="label">FIRST BURN</div><div className="value">{mySigs.length > 0 ? timeAgo(mySigs[mySigs.length - 1].block_time) + ' ago' : '—'}</div></div>
                <div className="lw-stat"><div className="label">USD VALUE</div><div className="value">{brainsPrice > 0 ? fmtUSD(myTotal * brainsPrice) : '—'}</div></div>
              </div>

              {/* Per-tx list */}
              {mySigs.length === 0 ? (
                <div className="lw-placeholder" style={{ padding: '24px 16px' }}>
                  <div className="lw-placeholder-glyph">◌</div>
                  <div className="lw-placeholder-sub">No burns recorded for {shortAddr(publicKey!.toBase58(), 5, 5)}.</div>
                </div>
              ) : (
                <div style={{ marginTop: 12 }}>
                  {mySigs.slice(0, 50).map(ev => (
                    <div className="burn-tx-row" key={ev.sig}>
                      <div className="burn-tx-wallet">{shortAddr(ev.wallet, 5, 5)}</div>
                      <div className="burn-tx-amount">{fmtNum(ev.amount, 0)} BRAINS</div>
                      <div className="burn-tx-usd">{brainsPrice > 0 ? fmtUSD(ev.amount * brainsPrice) : '—'}</div>
                      <a
                        className="burn-tx-sig"
                        href={`${EXPLORER_BASE}${ev.sig}`}
                        target="_blank" rel="noopener noreferrer"
                        title={ev.sig}
                      >{shortAddr(ev.sig, 4, 4)} ↗</a>
                      <div className="burn-tx-time">{timeAgo(ev.block_time)}</div>
                    </div>
                  ))}
                  {mySigs.length > 50 && (
                    <div style={{
                      fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#6a7a94',
                      textAlign: 'center', padding: '10px 0', letterSpacing: 1.5,
                    }}>
                      SHOWING TOP 50 · {mySigs.length} TOTAL
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Network feed */}
        <div className="card">
          <div className="card-title">Recent Network Burns</div>
          {loadingAll && (
            <div className="lw-placeholder" style={{ padding: '24px 16px' }}>
              <div className="lw-placeholder-sub">Loading network burn feed…</div>
            </div>
          )}
          {!loadingAll && err && (
            <div className="lw-placeholder" style={{ padding: '24px 16px' }}>
              <div className="lw-placeholder-glyph">⚠</div>
              <div className="lw-placeholder-sub">{err}</div>
            </div>
          )}
          {!loadingAll && !err && allSigs.length === 0 && (
            <div className="lw-placeholder" style={{ padding: '24px 16px' }}>
              <div className="lw-placeholder-glyph">◌</div>
              <div className="lw-placeholder-sub">No burns indexed yet.</div>
            </div>
          )}
          {!loadingAll && !err && allSigs.slice(0, 30).map(ev => (
            <div className="burn-tx-row" key={ev.sig}>
              <div className="burn-tx-wallet" title={ev.wallet}>{shortAddr(ev.wallet, 5, 5)}</div>
              <div className="burn-tx-amount">{fmtNum(ev.amount, 0)} BRAINS</div>
              <div className="burn-tx-usd">{brainsPrice > 0 ? fmtUSD(ev.amount * brainsPrice) : '—'}</div>
              <a
                className="burn-tx-sig"
                href={`${EXPLORER_BASE}${ev.sig}`}
                target="_blank" rel="noopener noreferrer"
                title={ev.sig}
              >{shortAddr(ev.sig, 4, 4)} ↗</a>
              <div className="burn-tx-time">{timeAgo(ev.block_time)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
