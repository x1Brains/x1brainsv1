import { useEffect, useMemo, useState, type CSSProperties, type FC } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  fetchFarms, fetchPositions, fetchTotalStakers, computeApr, LOCK_TIERS,
  type FarmOnChain, type PositionOnChain, type LockId,
} from './LpFarms';
import V2FarmModal, { type FarmAction } from '../components/V2FarmModal';
import { fmtUSD, fmtNum, pow10 } from '../utils/v2format';
import { XNT_LOGO } from '../constants';
import V2PageHeader from '../components/V2PageHeader';

function fmtDuration(secs: number): string {
  if (secs <= 0) return 'now';
  const days = Math.floor(secs / 86_400);
  const hrs  = Math.floor((secs % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hrs}h`;
  const mins = Math.floor((secs % 3_600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

// Single round token image with a colored letter fallback when no logo is found.
const TokenImg: FC<{ src?: string; symbol: string; size: number }> = ({ src, symbol, size }) => {
  const [failed, setFailed] = useState(false);
  const COLORS = ['#f29030', '#ffb700', '#00d4ff', '#00c98d', '#bf5af2'];
  const ci = (symbol?.charCodeAt(0) ?? 65) % COLORS.length;
  const style: CSSProperties = {
    width: size, height: size, borderRadius: '50%',
    border: '1.5px solid #0d141c', objectFit: 'cover', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: src && !failed ? '#0d141c' : `linear-gradient(135deg,${COLORS[ci]},${COLORS[(ci + 2) % COLORS.length]})`,
    fontFamily: 'Orbitron,monospace', fontSize: size * 0.42, fontWeight: 900, color: '#0a0e14',
  };
  if (src && !failed) {
    return <img src={src} alt={symbol} style={style} onError={() => setFailed(true)} />;
  }
  return <div style={style}>{symbol?.slice(0, 1) || '?'}</div>;
};

// Overlapping pair of token logos (e.g. BRAINS + XNT). `a` sits on top of `b`.
const PairLogo: FC<{ aSrc?: string; aSym: string; bSrc?: string; bSym: string; size?: number }> =
  ({ aSrc, aSym, bSrc, bSym, size = 26 }) => (
    <div style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      <div style={{ position: 'relative', zIndex: 2 }}><TokenImg src={aSrc} symbol={aSym} size={size} /></div>
      <div style={{ position: 'relative', zIndex: 1, marginLeft: -size * 0.34 }}><TokenImg src={bSrc} symbol={bSym} size={size} /></div>
    </div>
  );

type ModalState = {
  farm: FarmOnChain;
  action: FarmAction;
  position?: PositionOnChain | null;
};

export default function V2LpPools() {
  const { connection } = useConnection();
  const { connected, publicKey } = useWallet();
  const [farms, setFarms] = useState<FarmOnChain[]>([]);
  const [positions, setPositions] = useState<Record<string, PositionOnChain[]>>({});
  const [loading, setLoading] = useState(true);
  const [posLoading, setPosLoading] = useState(false);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<ModalState | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [aprTier, setAprTier] = useState<LockId>('locked365'); // drives the APR column
  const [uniqueStakers, setUniqueStakers] = useState(0);
  const [totalPositions, setTotalPositions] = useState(0);

  // Farms
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const timeout = new Promise<FarmOnChain[]>((_, rej) =>
      setTimeout(() => rej(new Error('Timed out fetching farms (15s)')), 15_000),
    );
    Promise.race([fetchFarms(connection), timeout])
      .then(fs => { if (alive) { setFarms(fs); setErr(''); } })
      .catch(e => {
        console.error('[V2LpPools] fetchFarms failed:', e);
        if (alive) setErr(e?.message ?? 'Failed to load farms');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [connection, reloadTick]);

  // Network-wide staker counts (independent of wallet) — for the stats panel.
  useEffect(() => {
    let alive = true;
    fetchTotalStakers(connection)
      .then(r => { if (alive) { setUniqueStakers(r.uniqueStakers); setTotalPositions(r.totalPositions); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [connection, reloadTick]);

  // Positions — only after farms load and wallet is connected
  useEffect(() => {
    if (!publicKey || farms.length === 0) { setPositions({}); return; }
    let alive = true;
    setPosLoading(true);
    (async () => {
      const acc: Record<string, PositionOnChain[]> = {};
      for (const f of farms) {
        try {
          const ps = await fetchPositions(connection, publicKey, f);
          if (!alive) return;
          if (ps.length) acc[f.pubkey] = ps;
        } catch (e) {
          console.error('[V2LpPools] fetchPositions failed for', f.pubkey, e);
        }
      }
      if (alive) { setPositions(acc); setPosLoading(false); }
    })();
    return () => { alive = false; };
  }, [connection, publicKey, farms, reloadTick]);

  const totalTvl = farms.reduce((s, f) =>
    s + (Number(f.totalStaked) / pow10(f.lpDecimals)) * f.lpPriceUsd, 0);
  const totalVault = farms.reduce((s, f) =>
    s + (Number(f.vaultBalance) / pow10(f.rewardDecimals)) * f.rewardPriceUsd, 0);
  const activeCount = farms.filter(f => !f.paused && !f.closed).length;

  // Flattened position rows for the "Your Positions" panel.
  const myPositions = useMemo(() => {
    const out: { farm: FarmOnChain; position: PositionOnChain }[] = [];
    for (const f of farms) {
      const ps = positions[f.pubkey];
      if (!ps) continue;
      for (const p of ps) out.push({ farm: f, position: p });
    }
    return out;
  }, [farms, positions]);

  const myTotalStakedUsd = myPositions.reduce((s, { farm, position }) =>
    s + (Number(position.amount) / pow10(farm.lpDecimals)) * farm.lpPriceUsd, 0);
  const myTotalEarnedUsd = myPositions.reduce((s, { farm, position }) =>
    s + (Number(position.earnedNow) / pow10(farm.rewardDecimals)) * farm.rewardPriceUsd, 0);
  const claimable = myPositions.filter(({ position }) => position.earnedNow > 0n);

  const selectedTier = LOCK_TIERS.find(t => t.id === aprTier) ?? LOCK_TIERS[2];
  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="content content-wide v2-glass">
      <div className="lw-stack">

        <V2PageHeader title="LP FARMS" subtitle="LIQUIDITY MINING · X1 MAINNET" />

        {/* ════════ STATS PANEL ════════ */}
        <div className="lf9-panel">
          <div className="lf9-stat-row">
            <div className="lf9-stat">
              <div className="l">Total Value Locked</div>
              <div className="v">{loading ? '…' : (totalTvl > 0 ? fmtUSD(totalTvl) : '—')}</div>
              <div className="s">across {activeCount} active farm{activeCount === 1 ? '' : 's'}</div>
            </div>
            <div className="lf9-stat">
              <div className="l">Unique Stakers</div>
              <div className="v">{uniqueStakers > 0 ? uniqueStakers : '—'}</div>
              <div className="s">wallets participating</div>
            </div>
            <div className="lf9-stat">
              <div className="l">Total Stakes</div>
              <div className="v">{totalPositions > 0 ? totalPositions : '—'}</div>
              <div className="s">open positions</div>
            </div>
            <div className="lf9-stat">
              <div className="l">Reward Vaults</div>
              <div className="v accent">{loading ? '…' : (totalVault > 0 ? fmtUSD(totalVault) : '—')}</div>
              <div className="s">rewards locked</div>
            </div>
            <div className="lf9-stat">
              <div className="l">Active Farms</div>
              <div className="v">{loading ? '…' : activeCount}</div>
              <div className="s">{farms.length} detected</div>
            </div>
          </div>
          <div className="lf9-emissions">
            <span className="dot" />
            <span>{loading ? 'Scanning program accounts…' : 'Live on-chain'} · {farms.length} farm{farms.length === 1 ? '' : 's'} detected · refreshes on action</span>
          </div>
        </div>

        {/* ════════ LOCK TIERS PANEL ════════ */}
        <div className="lf9-panel">
          <div className="lf9-head"><span className="t">Lock Tiers</span><span className="rule" /></div>
          <div className="lf9-tiers">
            {LOCK_TIERS.map(t => (
              <button key={t.id} type="button"
                className={`lf9-tier${aprTier === t.id ? ' active' : ''}`}
                onClick={() => setAprTier(t.id)}>
                {t.label}<span className="mult">{t.multDisplay}</span>
              </button>
            ))}
            <span className="lf9-tiers-note">APR column reflects the selected lock</span>
          </div>
        </div>

        {/* ════════ FARMS PANEL ════════ */}
        <div className="lf9-panel">
          <div className="lf9-head"><span className="t">Farms</span><span className="rule" /></div>
          {loading ? (
            <div className="lf9-skel-wrap">{[0, 1, 2].map(i => <div key={i} className="lf9-skel" />)}</div>
          ) : err ? (
            <div className="lf9-empty">Failed to load — {err}</div>
          ) : farms.length === 0 ? (
            <div className="lf9-empty">No farms yet. Once farms exist on-chain, they'll appear here.</div>
          ) : (
            <div className="lf9-table">
              <div className="lf9-thead">
                <div>Pair</div>
                <div>TVL</div>
                <div className="lf9-col-staked">Total Staked</div>
                <div>APR · {selectedTier.label}</div>
                <div className="right">Action</div>
              </div>
              {farms.map(farm => {
                const tvlUsd   = (Number(farm.totalStaked) / pow10(farm.lpDecimals)) * farm.lpPriceUsd;
                const stakedUi = Number(farm.totalStaked) / pow10(farm.lpDecimals);
                const aprSel   = computeApr(farm, selectedTier.multBps);
                const aprMin   = computeApr(farm, 20_000);
                const aprMax   = computeApr(farm, 80_000);
                const mine     = positions[farm.pubkey]?.length ?? 0;
                const accent   = farm.rewardSymbol === 'BRAINS' ? '#f29030' : '#00c98d';
                return (
                  <div className="lf9-row" key={farm.pubkey}>
                    <div className="lf9-pair">
                      <PairLogo
                        aSrc={farm.otherTokenLogo} aSym={farm.otherTokenSymbol ?? farm.rewardSymbol}
                        bSrc={XNT_LOGO} bSym="XNT" size={28}
                      />
                      <div className="lf9-pair-txt">
                        <div className="name">
                          {farm.lpSymbol} <span style={{ color: accent }}>→</span> {farm.rewardSymbol}
                          {mine > 0 && <span className="lf9-mine">★ {mine}</span>}
                        </div>
                        <div className="sub">Stake {farm.lpSymbol}, earn {farm.rewardSymbol}{farm.paused ? ' · paused' : ''}</div>
                      </div>
                    </div>
                    <div className="lf9-col">{tvlUsd > 0 ? fmtUSD(tvlUsd) : '—'}</div>
                    <div className="lf9-col lf9-col-staked">{fmtNum(stakedUi, stakedUi >= 1000 ? 0 : 2)} LP</div>
                    <div>
                      <div className="lf9-apr" style={{ color: accent }}>
                        {aprSel > 0 ? `${aprSel.toFixed(0)}%` : '—'}
                        <span className="range">{aprMin.toFixed(0)}% → {aprMax.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div className="lf9-actions">
                      <button className="lf9-stake" disabled={!connected || farm.paused || farm.closed}
                        onClick={() => setModal({ farm, action: 'stake' })}
                        title={!connected ? 'Connect wallet' : farm.paused ? 'Farm paused' : farm.closed ? 'Farm closed' : 'Stake LP'}>
                        Stake
                      </button>
                      <button className="lf9-fund" disabled={!connected || farm.closed}
                        onClick={() => setModal({ farm, action: 'donate' })}
                        title={!connected ? 'Connect wallet' : farm.closed ? 'Farm closed' : 'Donate rewards to this farm'}>
                        Fund
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ════════ CLAIM + YOUR POSITIONS (wallet connected) ════════ */}
        {connected && (
          <div className="lf9-lower">
            <div className="lf9-panel">
              <div className="lf9-claim-label">Total Earned</div>
              <div className="lf9-claim-amt">{myTotalEarnedUsd > 0 ? fmtUSD(myTotalEarnedUsd) : '$0.00'}</div>
              <div className="lf9-claim-sub">
                {myPositions.length} position{myPositions.length === 1 ? '' : 's'} · {fmtUSD(myTotalStakedUsd)} staked
              </div>
              {myPositions.length > 0 && (() => {
                const ready = claimable
                  .filter(c => c.position.canClaim)
                  .sort((a, b) => Number(b.position.earnedNow) - Number(a.position.earnedNow));
                const anyGrace = ready.length === 0 && myPositions.some(({ position }) => now < position.graceEndTs);
                const top = ready[0];
                return (
                  <button
                    className="lf9-claim-primary"
                    disabled={ready.length === 0}
                    title={anyGrace ? 'Rewards become claimable once the 3-day grace period ends' : undefined}
                    onClick={() => top && setModal({ farm: top.farm, action: 'claim', position: top.position })}
                  >
                    {ready.length === 0
                      ? (anyGrace ? 'Claim · after grace' : 'Nothing to claim')
                      : ready.length === 1 ? 'Claim' : `Claim · ${ready.length} ready`}
                  </button>
                );
              })()}
              {claimable.length > 0 ? (
                <div className="lf9-claim-list">
                  {claimable.map(({ farm, position }) => {
                    const earnedUi = Number(position.earnedNow) / pow10(farm.rewardDecimals);
                    const inGrace  = now < position.graceEndTs;
                    return (
                      <div className="lf9-claim-item" key={position.pubkey}>
                        <span className="who">{farm.lpSymbol}/{farm.rewardSymbol}</span>
                        <span className="amt">{fmtNum(earnedUi, 3)} {farm.rewardSymbol}</span>
                        <button className="lf9-claim-btn" disabled={!position.canClaim}
                          title={inGrace ? 'Rewards become claimable once the 3-day grace period ends'
                               : !position.canClaim && position.nextClaimInSec > 0 ? `Claim available in ${fmtDuration(position.nextClaimInSec)}`
                               : undefined}
                          onClick={() => setModal({ farm, action: 'claim', position })}>
                          {position.canClaim ? 'Claim' : inGrace ? 'Grace' : 'Locked'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="lf9-claim-none">
                  {posLoading && myPositions.length === 0
                    ? 'Scanning your positions…'
                    : myPositions.length > 0 ? 'Rewards accruing — nothing claimable yet.' : 'No active stakes.'}
                </div>
              )}
            </div>

            <div className="lf9-panel">
              <div className="lf9-head"><span className="t">Your Positions</span><span className="rule" /></div>
              {posLoading && myPositions.length === 0 ? (
                <div className="lf9-empty">Scanning your positions…</div>
              ) : myPositions.length === 0 ? (
                <div className="lf9-empty">No active stakes — stake LP above to start earning.</div>
              ) : (
                <div className="lf9-postable">
                  <div className="lf9-pthead">
                    <div>Position</div><div>Lock</div><div>Earned</div><div className="right">Status</div>
                  </div>
                  {myPositions.map(({ farm, position }) => {
                    const tier      = LOCK_TIERS.find(t => t.id === position.lockType) ?? LOCK_TIERS[0];
                    const matured   = now >= position.unlockTs;
                    const amtUi     = Number(position.amount) / pow10(farm.lpDecimals);
                    const amtUsd    = amtUi * farm.lpPriceUsd;
                    const earnedUi  = Number(position.earnedNow) / pow10(farm.rewardDecimals);
                    const inGrace   = now < position.graceEndTs;
                    const stakedStr = new Date(position.startTs * 1000)
                      .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                    return (
                      <div className="lf9-prow" key={position.pubkey}>
                        <div className="lf9-ppair">
                          <PairLogo
                            aSrc={farm.otherTokenLogo} aSym={farm.otherTokenSymbol ?? farm.rewardSymbol}
                            bSrc={XNT_LOGO} bSym="XNT" size={24}
                          />
                          <div className="lf9-pair-txt">
                            <div className="name">{farm.lpSymbol}/{farm.rewardSymbol}</div>
                            <div className="sub">{fmtNum(amtUi, 2)} LP{amtUsd > 0 ? ` · ${fmtUSD(amtUsd)}` : ''}</div>
                            <div className="sub2">Staked {stakedStr} · #{position.nonce}</div>
                          </div>
                        </div>
                        <div className="lf9-plock">
                          {tier.label.replace(' DAYS', 'd')}
                          <span className="mb" style={{ color: tier.color, borderColor: `${tier.color}55`, background: `${tier.color}14` }}>{tier.multDisplay}</span>
                        </div>
                        <div className="lf9-pearned" style={{ color: '#00c98d' }}>
                          {fmtNum(earnedUi, 3)}<span className="tk">{farm.rewardSymbol}</span>
                        </div>
                        <div className="lf9-pact">
                          <div className="unlock">{matured ? 'unlocked' : fmtDuration(position.unlockTs - now)}</div>
                          <div className="btns">
                            <button className="lf9-pbtn claim" disabled={!position.canClaim}
                              title={inGrace ? 'Rewards become claimable once the 3-day grace period ends'
                                   : !position.canClaim && position.nextClaimInSec > 0 ? `Claim available in ${fmtDuration(position.nextClaimInSec)}`
                                   : undefined}
                              onClick={() => setModal({ farm, action: 'claim', position })}>Claim</button>
                            <button className="lf9-pbtn unstake"
                              onClick={() => setModal({ farm, action: 'unstake', position })}>{matured ? 'Unstake' : 'Exit'}</button>
                          </div>
                        </div>
                        {inGrace && (
                          <div className="lf9-pgrace">
                            ✓ Grace period — unstake penalty-free, full LP back ({fmtDuration(position.graceEndTs - now)} left)
                            <span className="note"> · rewards forfeited if you exit · claim unlocks after grace</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {modal && (
        <V2FarmModal
          farm={modal.farm}
          action={modal.action}
          position={modal.position}
          onClose={() => setModal(null)}
          onDone={() => setReloadTick(t => t + 1)}
        />
      )}
    </div>
  );
}
