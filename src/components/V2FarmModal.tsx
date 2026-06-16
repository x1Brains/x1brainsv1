import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  LOCK_TIERS, getTokenProgram, computeApr, pow10,
  type LockId, type FarmOnChain, type PositionOnChain,
} from '../pages/LpFarms';
import {
  executeStake, executeDonate, executeUnstake, executeClaim,
} from '../lib/farmIx';
import { fmtNum, fmtUSD } from '../utils/v2format';

export type FarmAction = 'stake' | 'donate' | 'claim' | 'unstake';

type Props = {
  farm: FarmOnChain | null;
  action: FarmAction;
  /** Required for claim + unstake. Ignored for stake + donate. */
  position?: PositionOnChain | null;
  onClose: () => void;
  onDone: () => void;
};

// V2 brand orange for primary actions. Unstake stays red since it's the
// destructive "pull funds out" path.
const ACCENT: Record<FarmAction, { color: string; verb: string; cta: string; glyph: string }> = {
  stake:   { color: '#f29030', verb: 'Stake LP',  cta: 'CONFIRM STAKE',   glyph: '⚡' },
  donate:  { color: '#f29030', verb: 'Donate',    cta: 'CONFIRM DONATE',  glyph: '💧' },
  claim:   { color: '#f29030', verb: 'Claim',     cta: 'CONFIRM CLAIM',   glyph: '💰' },
  unstake: { color: '#ff4466', verb: 'Unstake',   cta: 'CONFIRM UNSTAKE', glyph: '✕' },
};

export default function V2FarmModal({ farm, action, position, onClose, onDone }: Props) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();

  const needsAmount = action === 'stake' || action === 'donate';
  const needsPosition = action === 'claim' || action === 'unstake';

  const [amount, setAmount]   = useState('');
  const [lockId, setLockId]   = useState<LockId>('locked90');
  const [bal, setBal]         = useState(0);
  const [status, setStatus]   = useState('');
  const [pending, setPending] = useState(false);
  const [sig, setSig]         = useState('');

  useEffect(() => {
    setAmount('');
    setStatus('');
    setSig('');
    setPending(false);
  }, [farm?.pubkey, action, position?.pubkey]);

  // Fetch balance of relevant token (LP for stake, reward for donate). Not
  // needed for claim/unstake — those don't take an amount input.
  useEffect(() => {
    if (!needsAmount || !farm || !publicKey) { setBal(0); return; }
    let alive = true;
    (async () => {
      try {
        const mint = action === 'stake' ? farm.lpMint : farm.rewardMint;
        const mintPk = new PublicKey(mint);
        const prog   = await getTokenProgram(mintPk, connection);
        const ata    = getAssociatedTokenAddressSync(mintPk, publicKey, false, prog);
        const info   = await connection.getParsedAccountInfo(ata).catch(() => null);
        if (!alive) return;
        setBal(Number((info?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0));
      } catch { if (alive) setBal(0); }
    })();
    return () => { alive = false; };
  }, [farm?.pubkey, action, publicKey, connection, needsAmount]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [pending, onClose]);

  if (!farm) return null;
  if (needsPosition && !position) return null;
  const A = ACCENT[action];
  const amt = parseFloat(amount) || 0;
  const tier = LOCK_TIERS.find(t => t.id === lockId)!;
  const apr  = action === 'stake' ? computeApr(farm, tier.multBps) : 0;

  const valid = needsAmount ? (amt > 0 && amt <= bal) : true;

  const run = async () => {
    if (!publicKey || !signTransaction) return;
    if (needsAmount && !valid) {
      setStatus('❌ Enter a valid amount within your balance');
      return;
    }
    setPending(true);
    setStatus('');
    setSig('');
    try {
      let res;
      if (action === 'stake') {
        res = await executeStake({
          connection, publicKey, signTransaction,
          farm, amountUi: amt, lockId,
          onStatus: setStatus,
        });
      } else if (action === 'donate') {
        res = await executeDonate({
          connection, publicKey, signTransaction,
          farm, amountUi: amt,
          onStatus: setStatus,
        });
      } else if (action === 'claim') {
        res = await executeClaim({
          connection, publicKey, signTransaction,
          farm, position: position!,
          onStatus: setStatus,
        });
      } else {
        res = await executeUnstake({
          connection, publicKey, signTransaction,
          farm, position: position!,
          onStatus: setStatus,
        });
      }
      setSig(res.sig);
      setStatus(`✅ ${A.verb} confirmed`);
      setTimeout(() => { onDone(); onClose(); }, 1800);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0, 140) ?? 'Transaction failed'}`);
    } finally { setPending(false); }
  };

  const tokenSymbol = action === 'stake' ? farm.lpSymbol : farm.rewardSymbol;
  const tokenPriceUsd = action === 'stake' ? farm.lpPriceUsd : farm.rewardPriceUsd;
  const amtUsd = amt * tokenPriceUsd;

  return createPortal(
    <div
      onClick={() => { if (!pending) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(12px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, animation: 'fadeUp 0.18s ease both',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480,
          background: 'linear-gradient(155deg,#0c1520,#080c0f)',
          border: `1px solid ${A.color}55`,
          borderRadius: 16, padding: '24px 22px',
          boxShadow: `0 0 60px ${A.color}1a, 0 32px 80px rgba(0,0,0,.9)`,
          position: 'relative',
        }}
      >
        <div style={{
          position: 'absolute', top: 0, left: '10%', right: '10%', height: 1,
          background: `linear-gradient(90deg,transparent,${A.color},transparent)`,
        }} />

        <button
          onClick={onClose}
          disabled={pending}
          style={{
            position: 'absolute', top: 10, right: 10,
            width: 28, height: 28, borderRadius: '50%',
            border: `1px solid ${A.color}40`, background: 'rgba(8,12,15,.9)',
            cursor: pending ? 'not-allowed' : 'pointer',
            color: A.color, fontSize: 16,
          }}
        >×</button>

        <div style={{ marginBottom: 18 }}>
          <div style={{
            fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900,
            color: '#fff', marginBottom: 4, letterSpacing: 1,
          }}>
            {A.glyph} {A.verb.toUpperCase()} · {farm.lpSymbol} → {farm.rewardSymbol}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#8aaac8' }}>
            {action === 'stake'   && 'Lock LP tokens to earn rewards. Multiplier grows with lock length.'}
            {action === 'donate'  && 'Extend reward runway for current stakers. Non-withdrawable.'}
            {action === 'claim'   && 'Sweep pending rewards to your wallet. 24h cooldown between claims.'}
            {action === 'unstake' && 'Close this position. Matured = full LP + rewards back; early = LP penalty + rewards forfeited.'}
          </div>
        </div>

        {/* Position summary (claim + unstake) */}
        {needsPosition && position && (() => {
          const stakedUi = Number(position.amount) / pow10(farm.lpDecimals);
          const earnedUi = Number(position.earnedNow) / pow10(farm.rewardDecimals);
          const now = Math.floor(Date.now() / 1000);
          const isMatured = now >= position.unlockTs;
          const inGrace = now < position.graceEndTs;
          const tierLbl = LOCK_TIERS.find(t => t.id === position.lockType)?.label ?? position.lockType;
          const earnedUsd = earnedUi * farm.rewardPriceUsd;
          const stakedUsd = stakedUi * farm.lpPriceUsd;
          const stakedStr = new Date(position.startTs * 1000)
            .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          const penaltyUi = action === 'unstake' && !isMatured && !inGrace
            ? Number(position.penaltyAmount) / pow10(farm.lpDecimals)
            : 0;
          return (
            <div style={{
              background: `${A.color}10`,
              border: `1px solid ${A.color}33`,
              borderRadius: 10,
              padding: '12px 14px',
              marginBottom: 14,
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 12,
            }}>
              <div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, letterSpacing: 1.5, color: '#9abacf' }}>POSITION</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: '#e0f0ff', marginTop: 2 }}>
                  #{position.nonce} · {tierLbl}
                </div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#9abacf', marginTop: 2 }}>
                  {fmtNum(stakedUi, 4)} {farm.lpSymbol}{stakedUsd > 0 ? ` · ${fmtUSD(stakedUsd)}` : ''}
                </div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#5c7a90', marginTop: 2 }}>
                  Staked {stakedStr}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, letterSpacing: 1.5, color: '#9abacf' }}>EARNED</div>
                <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: '#00c98d', marginTop: 2 }}>
                  {fmtNum(earnedUi, 4)} {farm.rewardSymbol}
                </div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#9abacf', marginTop: 2 }}>
                  {farm.rewardPriceUsd > 0 ? fmtUSD(earnedUsd) : '—'}
                </div>
              </div>
              {action === 'unstake' && inGrace && (
                <div style={{ gridColumn: '1 / -1', paddingTop: 8, borderTop: '1px dashed rgba(255,255,255,.08)' }}>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#00c98d', letterSpacing: 1 }}>
                    ✓ Grace period · no penalty · full {farm.lpSymbol} LP returned
                    <span style={{ color: '#5c7a90' }}> · pending rewards forfeited</span>
                  </div>
                </div>
              )}
              {action === 'unstake' && !isMatured && !inGrace && (
                <div style={{ gridColumn: '1 / -1', paddingTop: 8, borderTop: '1px dashed rgba(255,255,255,.08)' }}>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#ff6666', letterSpacing: 1 }}>
                    ⚠ Early exit · ~{fmtNum(penaltyUi, 4)} {farm.lpSymbol} LP penalty · all pending rewards forfeited
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Amount input (stake + donate only) */}
        {needsAmount && (
          <>
            <div style={{
              fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 1.5,
              color: '#9abacf', marginBottom: 8,
            }}>
              AMOUNT TO {action === 'stake' ? 'STAKE' : 'DONATE'}
            </div>
            <div style={{
              background: 'rgba(0,0,0,.4)',
              border: `1px solid ${A.color}40`,
              borderRadius: 9, padding: '12px 14px', marginBottom: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  value={amount} onChange={e => setAmount(e.target.value)}
                  type="number" min="0" step="0.0001" placeholder="0.0000" autoFocus disabled={pending}
                  style={{
                    flex: 1, background: 'transparent', border: 'none', outline: 'none',
                    color: A.color, fontFamily: 'Orbitron,monospace',
                    fontSize: 22, fontWeight: 900, caretColor: A.color,
                  }}
                />
                <button
                  type="button"
                  onClick={() => setAmount(bal.toFixed(6))}
                  disabled={pending || bal <= 0}
                  style={{
                    background: `${A.color}1a`, border: `1px solid ${A.color}50`,
                    borderRadius: 7, padding: '5px 12px', cursor: 'pointer',
                    fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, color: A.color,
                  }}
                >MAX</button>
              </div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#8aaac8', marginTop: 6 }}>
                Balance: {fmtNum(bal, 4)} {tokenSymbol}
                {amt > 0 && tokenPriceUsd > 0 && <> · ≈ {fmtUSD(amtUsd)}</>}
              </div>
            </div>
          </>
        )}

        {/* Lock tier picker (stake only) */}
        {action === 'stake' && (
          <>
            <div style={{
              fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 1.5,
              color: '#9abacf', marginBottom: 8,
            }}>
              LOCK DURATION
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
              {LOCK_TIERS.map(t => (
                <button
                  key={t.id} type="button"
                  onClick={() => setLockId(t.id)}
                  disabled={pending}
                  style={{
                    padding: '11px 6px', borderRadius: 9, cursor: 'pointer', textAlign: 'center',
                    background: lockId === t.id ? `${t.color}18` : 'rgba(255,255,255,.03)',
                    border: `1px solid ${lockId === t.id ? `${t.color}66` : 'rgba(255,255,255,.08)'}`,
                  }}
                >
                  <div style={{
                    fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 900,
                    color: lockId === t.id ? t.color : '#8aa0b8',
                  }}>{t.label}</div>
                  <div style={{
                    fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 900,
                    color: lockId === t.id ? t.color : '#4a6a8a', marginTop: 3,
                  }}>{t.multDisplay}</div>
                </button>
              ))}
            </div>
            {amt > 0 && apr > 0 && (
              <div style={{
                marginBottom: 14, padding: '10px 14px', borderRadius: 9,
                background: `${A.color}10`, border: `1px solid ${A.color}25`,
                display: 'flex', justifyContent: 'space-between',
                fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#9abacf',
              }}>
                <span>EST APR ({tier.label})</span>
                <span style={{ color: A.color, fontWeight: 700 }}>{apr.toFixed(1)}%</span>
              </div>
            )}
          </>
        )}

        {status && (
          <div style={{
            margin: '8px 0 14px', padding: '8px 12px',
            background: 'rgba(255,255,255,.04)',
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 8,
            fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#cfdfee',
          }}>
            {status}
            {sig && (
              <div style={{ marginTop: 4 }}>
                <a
                  href={`https://explorer.mainnet.x1.xyz/tx/${sig}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: A.color, fontSize: 10 }}
                >View tx ↗</a>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            style={{
              flex: 1, padding: '11px 0',
              background: 'rgba(255,255,255,.04)',
              border: '1px solid rgba(255,255,255,.1)',
              borderRadius: 8,
              cursor: pending ? 'not-allowed' : 'pointer',
              fontFamily: 'Orbitron,monospace',
              fontSize: 9, fontWeight: 700, color: '#9abacf', letterSpacing: 1.5,
            }}
          >CANCEL</button>
          <button
            type="button"
            onClick={run}
            disabled={pending || !valid || !publicKey || !signTransaction}
            style={{
              flex: 2, padding: '11px 0',
              background: pending
                ? 'rgba(255,255,255,.04)'
                : `linear-gradient(135deg, ${A.color}33, ${A.color}11)`,
              border: `1px solid ${A.color}80`,
              borderRadius: 8,
              cursor: pending ? 'not-allowed' : 'pointer',
              fontFamily: 'Orbitron,monospace',
              fontSize: 9, fontWeight: 700, color: A.color, letterSpacing: 1.5,
              opacity: pending ? 0.6 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {pending && (
              <span style={{
                width: 12, height: 12, borderRadius: '50%',
                border: `2px solid ${A.color}33`,
                borderTop: `2px solid ${A.color}`,
                animation: 'spin 0.8s linear infinite',
              }} />
            )}
            {pending ? 'WORKING…' : A.cta}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
