import React, { FC, useState, useEffect, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { TopBar, PageBackground, Footer } from '../components/UI';
import { BRAINS_LOGO } from '../constants';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const NFT_TOTAL         = 88;
const PRICE_XNT         = 0.08;   // per NFT in XNT (native)
const PRICE_BRAINS      = 0.08;   // per NFT in BRAINS token
const COLLECTION_NAME   = 'Brains Lab Work';
const COLLECTION_SYMBOL = 'LABWORK';
const MINT_PROGRAM_ID   = 'YOUR_PROGRAM_ID_HERE';

// Brains token mint address (Token-2022)
const BRAINS_MINT_ADDRESS = 'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN';

const RARITY_TIERS = [
  { label: 'LEGENDARY', count: 4,  pct: '4.5%',  color: '#ffd700', glow: 'rgba(255,215,0,.5)',   emoji: '👑' },
  { label: 'EPIC',      count: 12, pct: '13.6%', color: '#bf5af2', glow: 'rgba(191,90,242,.5)',  emoji: '⚡' },
  { label: 'RARE',      count: 24, pct: '27.3%', color: '#00d4ff', glow: 'rgba(0,212,255,.5)',   emoji: '💎' },
  { label: 'UNCOMMON',  count: 28, pct: '31.8%', color: '#00ff88', glow: 'rgba(0,255,136,.5)',   emoji: '🔥' },
  { label: 'COMMON',    count: 20, pct: '22.7%', color: '#8aa0b8', glow: 'rgba(138,160,184,.4)', emoji: '🧠' },
];

const PREVIEW_NFTS = [
  { id: 1,  rarity: 'LEGENDARY', color: '#ffd700', bg: 'linear-gradient(160deg,#2a1f00 0%,#1a1000 100%)', border: 'rgba(255,215,0,.6)' },
  { id: 7,  rarity: 'EPIC',      color: '#bf5af2', bg: 'linear-gradient(160deg,#1a0a2e 0%,#0e0618 100%)', border: 'rgba(191,90,242,.6)' },
  { id: 23, rarity: 'RARE',      color: '#00d4ff', bg: 'linear-gradient(160deg,#001a2e 0%,#000e1a 100%)', border: 'rgba(0,212,255,.6)'  },
  { id: 42, rarity: 'UNCOMMON',  color: '#00ff88', bg: 'linear-gradient(160deg,#002214 0%,#00110a 100%)', border: 'rgba(0,255,136,.6)'  },
  { id: 55, rarity: 'COMMON',    color: '#8aa0b8', bg: 'linear-gradient(160deg,#0a1520 0%,#060e18 100%)', border: 'rgba(138,160,184,.5)' },
  { id: 88, rarity: 'LEGENDARY', color: '#ffd700', bg: 'linear-gradient(160deg,#2a1f00 0%,#1a1000 100%)', border: 'rgba(255,215,0,.6)'  },
];

// ─────────────────────────────────────────────
// WALLET BALANCE HOOK
// Mirrors Portfolio.tsx pattern exactly:
//  - getBalance()                            → native XNT lamports ÷ 1e9
//  - getParsedTokenAccountsByOwner (SPL)     → scan for BRAINS if somehow SPL
//  - getParsedTokenAccountsByOwner (T-2022)  → BRAINS lives here
// ─────────────────────────────────────────────
interface WalletBalances {
  xnt: number | null;
  brains: number | null;
  loading: boolean;
  error: string | null;
}

function useWalletBalances(): [WalletBalances, () => void] {
  const { publicKey }    = useWallet();
  const { connection }   = useConnection();
  const [state, setState] = useState<WalletBalances>({
    xnt: null, brains: null, loading: false, error: null,
  });

  const fetchBalances = useCallback(async () => {
    if (!publicKey || !connection) {
      setState({ xnt: null, brains: null, loading: false, error: null });
      return;
    }

    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      // 1. Native XNT balance — same as Portfolio: getBalance() / 1e9
      const [lamportsResult, splResult, t22Result] = await Promise.allSettled([
        connection.getBalance(publicKey),
        connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);

      const xnt = lamportsResult.status === 'fulfilled'
        ? lamportsResult.value / 1e9
        : null;

      // 2. Scan all token accounts (SPL + T-2022) for BRAINS mint
      //    Portfolio does the same: allAccounts = [...splAccs, ...t22Accs]
      const splAccs: any[] = splResult.status === 'fulfilled'  ? splResult.value.value : [];
      const t22Accs: any[] = t22Result.status === 'fulfilled'  ? t22Result.value.value : [];
      const allAccounts    = [...splAccs, ...t22Accs];

      let brains: number | null = null;
      for (const acc of allAccounts) {
        const info = acc?.account?.data?.parsed?.info;
        if (!info) continue;
        if (info.mint === BRAINS_MINT_ADDRESS) {
          brains = info.tokenAmount?.uiAmount ?? 0;
          break;
        }
      }

      setState({ xnt, brains, loading: false, error: null });
    } catch (err: any) {
      setState(prev => ({ ...prev, loading: false, error: err?.message ?? 'Failed to fetch balances' }));
    }
  }, [publicKey?.toBase58(), connection]);

  // Auto-fetch when wallet connects / changes
  useEffect(() => {
    if (publicKey) {
      fetchBalances();
    } else {
      setState({ xnt: null, brains: null, loading: false, error: null });
    }
  }, [publicKey?.toBase58()]);

  return [state, fetchBalances];
}

// ─────────────────────────────────────────────
// COUNTDOWN TIMER
// ─────────────────────────────────────────────
const MINT_DATE = new Date('2025-03-01T18:00:00Z');

function useCountdown(target: Date) {
  const [remaining, setRemaining] = useState({ d: 0, h: 0, m: 0, s: 0, live: false });
  useEffect(() => {
    const tick = () => {
      const diff = target.getTime() - Date.now();
      if (diff <= 0) { setRemaining({ d: 0, h: 0, m: 0, s: 0, live: true }); return; }
      setRemaining({
        d: Math.floor(diff / 86400000),
        h: Math.floor((diff % 86400000) / 3600000),
        m: Math.floor((diff % 3600000) / 60000),
        s: Math.floor((diff % 60000) / 1000),
        live: false,
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);
  return remaining;
}

// ─────────────────────────────────────────────
// PREVIEW CARD
// ─────────────────────────────────────────────
const PreviewCard: FC<{ nft: typeof PREVIEW_NFTS[0]; delay: number }> = ({ nft, delay }) => {
  const tier = RARITY_TIERS.find(t => t.label === nft.rarity)!;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative', borderRadius: 16, overflow: 'hidden',
        border: `1px solid ${nft.border}`,
        boxShadow: hovered ? `0 16px 48px ${nft.border}, 0 0 0 1px ${nft.color}44` : `0 0 24px ${nft.border}`,
        transform: hovered ? 'translateY(-6px) scale(1.02)' : 'translateY(0) scale(1)',
        transition: 'transform 0.35s ease, box-shadow 0.35s ease',
        cursor: 'pointer', animation: `fadeUp 0.6s ease ${delay}s both`,
        aspectRatio: '3/4', background: nft.bg,
      }}
    >
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(ellipse at 50% 30%, ${nft.color}30 0%, transparent 65%),
          radial-gradient(ellipse at 80% 80%, ${nft.color}15 0%, transparent 50%), ${nft.bg}`,
      }} />
      <div style={{
        position: 'absolute', left: 0, right: 0, height: 3,
        background: `linear-gradient(90deg, transparent 0%, ${nft.color}cc 50%, transparent 100%)`,
        animation: 'scanline 3s linear infinite', zIndex: 2,
      }} />
      <div style={{
        position: 'absolute', inset: 0, zIndex: 1,
        backgroundImage: `linear-gradient(${nft.color}08 1px, transparent 1px),
          linear-gradient(90deg, ${nft.color}08 1px, transparent 1px)`,
        backgroundSize: '20px 20px',
      }} />
      <div style={{
        position: 'absolute', inset: 0, zIndex: 3,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12%',
      }}>
        <img src={BRAINS_LOGO} alt="" style={{
          width: '100%', height: '100%', objectFit: 'contain',
          filter: `drop-shadow(0 0 20px ${nft.color}) drop-shadow(0 0 40px ${nft.color}66)`,
          opacity: hovered ? 1 : 0.88, transition: 'opacity 0.3s, filter 0.3s',
        }} />
      </div>
      <div style={{
        position: 'absolute', top: 10, left: 10, zIndex: 5,
        fontFamily: 'Orbitron, monospace', fontSize: 9, color: nft.color,
        background: `${nft.color}18`, border: `1px solid ${nft.border}`,
        padding: '3px 9px', borderRadius: 5, letterSpacing: 1, backdropFilter: 'blur(6px)',
      }}>#{nft.id}</div>
      <div style={{
        position: 'absolute', top: 10, right: 10, zIndex: 5,
        fontFamily: 'Orbitron, monospace', fontSize: 8, color: nft.color,
        background: `${nft.color}18`, border: `1px solid ${nft.border}`,
        padding: '3px 9px', borderRadius: 5, letterSpacing: 1, backdropFilter: 'blur(6px)',
      }}>{tier.emoji} {nft.rarity}</div>
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 5,
        background: `linear-gradient(to top, ${nft.bg.match(/#[0-9a-f]{6}/gi)?.[1] ?? '#000'}ee 0%, transparent 100%)`,
        padding: '24px 14px 12px', backdropFilter: 'blur(2px)',
      }}>
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: 1, marginBottom: 2 }}>
          Brains #{nft.id}
        </div>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#5a7a94' }}>{COLLECTION_NAME}</div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// COUNTDOWN BLOCK
// ─────────────────────────────────────────────
const CountdownBlock: FC<{ label: string; value: number }> = ({ label, value }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    background: 'rgba(255,140,0,.06)', border: '1px solid rgba(255,140,0,.2)',
    borderRadius: 12, padding: '16px 22px', minWidth: 68,
  }}>
    <span style={{
      fontFamily: 'Orbitron, monospace', fontSize: 34, fontWeight: 900, color: '#ff8c00',
      textShadow: '0 0 20px rgba(255,140,0,.6)', lineHeight: 1,
    }}>{String(value).padStart(2, '0')}</span>
    <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5a7a94', letterSpacing: 3 }}>{label}</span>
  </div>
);

// ─────────────────────────────────────────────
// WALLET BALANCE DISPLAY WIDGET
// Shows live XNT + BRAINS balances with sufficiency check
// ─────────────────────────────────────────────
interface BalanceWidgetProps {
  xnt: number | null;
  brains: number | null;
  loading: boolean;
  qty: number;
  onRefresh: () => void;
}

const BalanceWidget: FC<BalanceWidgetProps> = ({ xnt, brains, loading, qty, onRefresh }) => {
  const xntNeeded    = PRICE_XNT * qty;
  const brainsNeeded = PRICE_BRAINS * qty;
  const xntOk    = xnt    !== null && xnt    >= xntNeeded;
  const brainsOk = brains !== null && brains >= brainsNeeded;
  const bothOk   = xntOk && brainsOk;

  const fmtBal = (v: number | null) => {
    if (v === null) return '—';
    if (v === 0) return '0';
    if (v < 0.001) return '< 0.001';
    return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  };

  return (
    <div style={{
      background: 'rgba(0,0,0,.25)',
      border: `1px solid ${bothOk ? 'rgba(0,255,136,.2)' : 'rgba(255,50,80,.18)'}`,
      borderRadius: 14, overflow: 'hidden', marginBottom: 20,
    }}>
      {/* Header row */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px',
        background: bothOk ? 'rgba(0,255,136,.05)' : 'rgba(255,50,80,.05)',
        borderBottom: `1px solid ${bothOk ? 'rgba(0,255,136,.12)' : 'rgba(255,50,80,.12)'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: loading ? '#ffb700' : bothOk ? '#00ff88' : '#ff4455',
            boxShadow: loading ? '0 0 8px rgba(255,183,0,.8)' : bothOk ? '0 0 8px rgba(0,255,136,.8)' : '0 0 8px rgba(255,68,85,.8)',
            animation: loading ? 'pulse-orange 1s ease infinite' : bothOk ? 'pulse-green 2s ease infinite' : 'none',
          }} />
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, letterSpacing: 2,
            color: loading ? '#ffb700' : bothOk ? '#00ff88' : '#ff4455' }}>
            {loading ? 'SCANNING WALLET...' : bothOk ? 'SUFFICIENT BALANCE' : 'INSUFFICIENT BALANCE'}
          </span>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh balances"
          style={{
            background: 'none', border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
            color: '#4a6070', fontSize: 13, padding: '2px 4px', lineHeight: 1,
            opacity: loading ? 0.4 : 1, transition: 'color 0.2s',
          }}
          onMouseEnter={e => { if (!loading) (e.currentTarget as HTMLButtonElement).style.color = '#00d4ff'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#4a6070'; }}>
          ⟳
        </button>
      </div>

      {/* XNT row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
        borderBottom: '1px solid rgba(255,255,255,.04)',
      }}>
        {/* Token icon */}
        <div style={{
          width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
          background: 'rgba(255,140,0,.12)', border: '1px solid rgba(255,140,0,.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
        }}>⚡</div>

        {/* Label + balance */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 900,
              color: loading ? '#5a7a94' : xntOk ? '#ff8c00' : '#ff4455',
              textShadow: xntOk && !loading ? '0 0 12px rgba(255,140,0,.5)' : 'none',
              transition: 'color 0.4s',
            }}>
              {loading ? '···' : fmtBal(xnt)}
            </span>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5a7a94', letterSpacing: 1 }}>XNT</span>
          </div>
          <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#3a5070', marginTop: 1 }}>
            X1 Native Token &nbsp;·&nbsp; need <span style={{ color: '#ff8c00' }}>{xntNeeded.toFixed(2)}</span>
          </div>
        </div>

        {/* Status badge */}
        <div style={{
          fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 1,
          padding: '3px 9px', borderRadius: 5,
          background: loading ? 'rgba(90,122,148,.1)' : xntOk ? 'rgba(0,255,136,.1)' : 'rgba(255,68,85,.1)',
          border: `1px solid ${loading ? 'rgba(90,122,148,.2)' : xntOk ? 'rgba(0,255,136,.25)' : 'rgba(255,68,85,.25)'}`,
          color: loading ? '#5a7a94' : xntOk ? '#00ff88' : '#ff4455',
          flexShrink: 0,
        }}>
          {loading ? '···' : xntOk ? '✓ OK' : '✗ LOW'}
        </div>
      </div>

      {/* BRAINS row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px' }}>
        <div style={{
          width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
          background: 'rgba(191,90,242,.12)', border: '1px solid rgba(191,90,242,.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
        }}>🧠</div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 900,
              color: loading ? '#5a7a94' : brainsOk ? '#bf5af2' : '#ff4455',
              textShadow: brainsOk && !loading ? '0 0 12px rgba(191,90,242,.5)' : 'none',
              transition: 'color 0.4s',
            }}>
              {loading ? '···' : fmtBal(brains)}
            </span>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5a7a94', letterSpacing: 1 }}>BRAINS</span>
          </div>
          <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#3a5070', marginTop: 1 }}>
            Brains Token (T-2022) &nbsp;·&nbsp; need <span style={{ color: '#bf5af2' }}>{brainsNeeded.toFixed(2)}</span>
          </div>
        </div>

        <div style={{
          fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 1,
          padding: '3px 9px', borderRadius: 5,
          background: loading ? 'rgba(90,122,148,.1)' : brainsOk ? 'rgba(0,255,136,.1)' : 'rgba(255,68,85,.1)',
          border: `1px solid ${loading ? 'rgba(90,122,148,.2)' : brainsOk ? 'rgba(0,255,136,.25)' : 'rgba(255,68,85,.25)'}`,
          color: loading ? '#5a7a94' : brainsOk ? '#00ff88' : '#ff4455',
          flexShrink: 0,
        }}>
          {loading ? '···' : brainsOk ? '✓ OK' : '✗ LOW'}
        </div>
      </div>

      {/* Warning if one or both insufficient */}
      {!loading && !bothOk && (xnt !== null || brains !== null) && (
        <div style={{
          padding: '10px 16px',
          background: 'rgba(255,50,80,.06)',
          borderTop: '1px solid rgba(255,50,80,.12)',
          display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: 12, flexShrink: 0 }}>⚠️</span>
          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#cc3344', lineHeight: 1.5 }}>
            {!xntOk && !brainsOk
              ? `You need ${xntNeeded.toFixed(2)} XNT and ${brainsNeeded.toFixed(2)} BRAINS to mint ${qty} NFT${qty > 1 ? 's' : ''}.`
              : !xntOk
              ? `Not enough XNT — you need ${xntNeeded.toFixed(2)} but have ${fmtBal(xnt)}.`
              : `Not enough BRAINS — you need ${brainsNeeded.toFixed(2)} but have ${fmtBal(brains)}.`}
          </span>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// TOKEN PRICE ROW
// ─────────────────────────────────────────────
const TokenPriceRow: FC<{
  icon: string; label: string; amount: number; qty: number;
  color: string; symbol: string;
}> = ({ icon, label, amount, qty, color, symbol }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px',
    background: `${color}08`, border: `1px solid ${color}25`, borderRadius: 12, marginBottom: 10,
  }}>
    <div style={{
      width: 36, height: 36, borderRadius: '50%',
      background: `${color}18`, border: `1px solid ${color}40`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 18, flexShrink: 0,
    }}>{icon}</div>
    <div style={{ flex: 1 }}>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5a7a94', letterSpacing: 2, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#8aa0b8' }}>
        {amount} {symbol} <span style={{ color: '#3a5070' }}>per NFT</span>
      </div>
    </div>
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 18, fontWeight: 900, color, textShadow: `0 0 14px ${color}88` }}>
        {(amount * qty).toFixed(2)}
      </div>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5070', letterSpacing: 1 }}>{symbol} TOTAL</div>
    </div>
  </div>
);

// ─────────────────────────────────────────────
// MINT SECTION
// ─────────────────────────────────────────────
const MintSection: FC<{
  minted: number;
  total: number;
  walletBalances: WalletBalances;
  onRefreshBalances: () => void;
}> = ({ minted, total, walletBalances, onRefreshBalances }) => {
  const { publicKey } = useWallet();
  const [qty, setQty]         = useState(1);
  const [minting, setMinting] = useState(false);
  const [txSig, setTxSig]     = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const pct    = Math.round((minted / total) * 100);
  const isLive = MINT_PROGRAM_ID !== 'YOUR_PROGRAM_ID_HERE';

  const xntNeeded    = PRICE_XNT    * qty;
  const brainsNeeded = PRICE_BRAINS * qty;
  const hasEnoughXnt    = walletBalances.xnt    !== null && walletBalances.xnt    >= xntNeeded;
  const hasEnoughBrains = walletBalances.brains !== null && walletBalances.brains >= brainsNeeded;
  const hasEnoughBoth   = hasEnoughXnt && hasEnoughBrains;

  const canMint = !!publicKey && !minting && hasEnoughBoth;

  const handleMint = async () => {
    if (!publicKey)    { setError('Connect your wallet first'); return; }
    if (!hasEnoughXnt) { setError(`Insufficient XNT — need ${xntNeeded.toFixed(2)}, have ${(walletBalances.xnt ?? 0).toFixed(4)}`); return; }
    if (!hasEnoughBrains) { setError(`Insufficient BRAINS — need ${brainsNeeded.toFixed(2)}, have ${(walletBalances.brains ?? 0).toFixed(4)}`); return; }
    if (!isLive)       { setError('Mint program not yet deployed. Update MINT_PROGRAM_ID.'); return; }

    setMinting(true); setError(null); setTxSig(null);
    try {
      // TODO: Wire dual-token payment:
      // 1. Transfer (qty * PRICE_XNT) XNT lamports to treasury
      // 2. Transfer (qty * PRICE_BRAINS) BRAINS tokens (T-2022) to treasury
      // 3. Call mint instruction on MINT_PROGRAM_ID
      throw new Error('Deploy your program and wire dual-token logic — see TODO in MintLabWork.tsx');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setMinting(false);
    }
  };

  return (
    <div style={{
      background: 'linear-gradient(160deg, rgba(12,18,28,0.95) 0%, rgba(8,12,18,0.98) 100%)',
      border: '1px solid rgba(255,140,0,.22)', borderRadius: 24,
      padding: '28px 28px 24px', width: '100%', maxWidth: 460,
      boxShadow: '0 0 60px rgba(255,140,0,.06)',
    }}>

      {/* Header badges */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#5a7a94', letterSpacing: 3, marginBottom: 10 }}>
          🧠 MINT YOUR NFT
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(255,140,0,.1)', border: '1px solid rgba(255,140,0,.3)', borderRadius: 8, padding: '5px 12px' }}>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#ff8c00', letterSpacing: 2 }}>DUAL TOKEN GATE</span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(0,212,255,.08)', border: '1px solid rgba(0,212,255,.2)', borderRadius: 8, padding: '5px 12px' }}>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00d4ff', letterSpacing: 1 }}>{COLLECTION_SYMBOL}</span>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5a7a94', letterSpacing: 2 }}>MINTED</span>
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#ff8c00' }}>
            {minted} / {total} · {pct}%
          </span>
        </div>
        <div style={{ height: 6, background: 'rgba(255,140,0,.1)', borderRadius: 3, overflow: 'hidden', border: '1px solid rgba(255,140,0,.15)' }}>
          <div style={{
            height: '100%', width: `${pct}%`,
            background: 'linear-gradient(90deg,#ff8c00,#ffb700)',
            borderRadius: 3, transition: 'width 0.8s ease',
            boxShadow: '0 0 10px rgba(255,140,0,.5)',
          }} />
        </div>
        <div style={{ textAlign: 'right', marginTop: 5, fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#3a5070' }}>
          {total - minted} remaining
        </div>
      </div>

      {/* Quantity */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5a7a94', letterSpacing: 2, marginBottom: 10 }}>QUANTITY</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[1, 2, 3, 5].map(n => (
            <button key={n} onClick={() => setQty(n)} style={{
              flex: 1, padding: '11px 0',
              background: qty === n ? 'linear-gradient(135deg,#ff8c00,#ffb700)' : 'rgba(255,140,0,.06)',
              border: `1px solid ${qty === n ? '#ff8c00' : 'rgba(255,140,0,.15)'}`,
              borderRadius: 10, fontFamily: 'Orbitron, monospace', fontSize: 14, fontWeight: 700,
              color: qty === n ? '#0a0e14' : '#ff8c00',
              cursor: 'pointer', transition: 'all 0.2s',
              boxShadow: qty === n ? '0 0 18px rgba(255,140,0,.35)' : 'none',
            }}>{n}</button>
          ))}
        </div>
      </div>

      {/* ── WALLET BALANCE WIDGET ── */}
      {publicKey && (
        <BalanceWidget
          xnt={walletBalances.xnt}
          brains={walletBalances.brains}
          loading={walletBalances.loading}
          qty={qty}
          onRefresh={onRefreshBalances}
        />
      )}

      {/* Cost breakdown */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5a7a94', letterSpacing: 2, marginBottom: 12 }}>
          PAYMENT REQUIRED · BOTH TOKENS
        </div>
        <TokenPriceRow icon="⚡" label="X1 NATIVE TOKEN" symbol="XNT"    amount={PRICE_XNT}    qty={qty} color="#ff8c00" />
        <TokenPriceRow icon="🧠" label="BRAINS TOKEN"    symbol="BRAINS" amount={PRICE_BRAINS} qty={qty} color="#bf5af2" />

        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '11px 16px', background: 'rgba(255,255,255,.02)',
          border: '1px solid rgba(255,255,255,.06)', borderRadius: 10, marginTop: 4,
        }}>
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#4a6070', letterSpacing: 2 }}>
            MINTING {qty} NFT{qty > 1 ? 's' : ''}
          </span>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#ff8c00' }}>
              {(PRICE_XNT * qty).toFixed(2)} XNT
            </div>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#bf5af2' }}>
              + {(PRICE_BRAINS * qty).toFixed(2)} BRAINS
            </div>
          </div>
        </div>
      </div>

      {/* Info note */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px',
        background: 'rgba(0,212,255,.04)', border: '1px solid rgba(0,212,255,.1)',
        borderRadius: 10, marginBottom: 18,
      }}>
        <span style={{ fontSize: 12, flexShrink: 0, marginTop: 1 }}>ℹ️</span>
        <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#4a6070', lineHeight: 1.6 }}>
          Both <span style={{ color: '#ff8c00' }}>XNT</span> and <span style={{ color: '#bf5af2' }}>BRAINS</span> tokens
          are required. Both payments are processed in a single transaction.
        </span>
      </div>

      {/* Mint button */}
      <button
        onClick={handleMint}
        disabled={!canMint && !!publicKey}
        style={{
          width: '100%', padding: '18px 0',
          background: !publicKey || walletBalances.loading
            ? 'rgba(255,140,0,.1)'
            : canMint
            ? 'linear-gradient(135deg,#ff8c00 0%,#ffb700 50%,#ff8c00 100%)'
            : 'rgba(255,50,80,.12)',
          backgroundSize: '200% 100%',
          border: `2px solid ${!publicKey || walletBalances.loading ? 'rgba(255,140,0,.18)' : canMint ? '#ff8c00' : 'rgba(255,50,80,.3)'}`,
          borderRadius: 14, fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 900,
          letterSpacing: 3,
          color: !publicKey || walletBalances.loading
            ? 'rgba(255,140,0,.3)'
            : canMint ? '#0a0e14' : 'rgba(255,50,80,.6)',
          cursor: canMint ? 'pointer' : 'not-allowed',
          transition: 'all 0.3s', textTransform: 'uppercase',
          boxShadow: canMint ? '0 0 32px rgba(255,140,0,.35), inset 0 0 20px rgba(255,183,0,.15)' : 'none',
          animation: canMint ? 'shimmer 2.5s linear infinite' : 'none',
          position: 'relative', overflow: 'hidden',
        }}
        onMouseEnter={e => { if (canMint) { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'translateY(-2px)'; b.style.boxShadow = '0 10px 40px rgba(255,140,0,.5)'; } }}
        onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'translateY(0)'; b.style.boxShadow = canMint ? '0 0 32px rgba(255,140,0,.35)' : 'none'; }}>
        {!publicKey
          ? '🔒 CONNECT WALLET TO MINT'
          : walletBalances.loading
          ? '⟳ CHECKING BALANCES...'
          : minting
          ? '⟳ PROCESSING...'
          : !hasEnoughBoth
          ? '⚠ INSUFFICIENT BALANCE'
          : `🧠 MINT ${qty} NFT${qty > 1 ? 's' : ''}`}
      </button>

      {/* Status notices */}
      {!isLive && (
        <div style={{ marginTop: 14, padding: '10px 14px', background: 'rgba(255,183,0,.07)', border: '1px solid rgba(255,183,0,.2)', borderRadius: 10, display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 12, flexShrink: 0 }}>⚠️</span>
          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 10, color: '#ffb700', lineHeight: 1.5 }}>
            Deploy your Rust program and update <code style={{ color: '#ff8c00' }}>MINT_PROGRAM_ID</code> to activate minting.
          </span>
        </div>
      )}
      {error && (
        <div style={{ marginTop: 14, padding: '12px 14px', background: 'rgba(255,50,50,.1)', border: '1px solid rgba(255,50,50,.25)', borderRadius: 10, display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 12, flexShrink: 0 }}>❌</span>
          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#ff6666', lineHeight: 1.5 }}>{error}</span>
        </div>
      )}
      {txSig && (
        <div style={{ marginTop: 14, padding: '12px 14px', background: 'rgba(0,255,136,.07)', border: '1px solid rgba(0,255,136,.22)', borderRadius: 10 }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00ff88', letterSpacing: 1, marginBottom: 4 }}>✅ MINT SUCCESSFUL</div>
          <a href={`https://explorer.mainnet.x1.xyz/tx/${txSig}`} target="_blank" rel="noopener noreferrer"
            style={{ fontFamily: 'monospace', fontSize: 10, color: '#00d4ff', wordBreak: 'break-all' }}>
            {txSig}
          </a>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// RUST GUIDE
// ─────────────────────────────────────────────
const RustGuide: FC = () => {
  const [open, setOpen] = useState(false);
  const steps = [
    {
      step: '01', title: 'Install Anchor Framework', color: '#ff8c00',
      code: `# Install Rust + Solana CLI + Anchor\ncurl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\nsh -c "$(curl -sSfL https://release.solana.com/v1.18.0/install)"\ncargo install --git https://github.com/coral-xyz/anchor anchor-cli`,
    },
    {
      step: '02', title: 'Initialize NFT Mint Program', color: '#ffb700',
      code: `anchor init brains-lab-work --template=nft\ncd brains-lab-work\n# Set collection_size = 88, symbol = "LABWORK"`,
    },
    {
      step: '03', title: 'Configure Dual-Token Payment (lib.rs)', color: '#00d4ff',
      code: `pub fn mint_nft(ctx: Context<MintNFT>, index: u64) -> Result<()> {\n  // Transfer 0.08 XNT from user to treasury\n  transfer_xnt(&ctx, 80_000_000)?;\n  // Transfer 0.08 BRAINS tokens (T-2022) from user to treasury\n  // BRAINS: EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN\n  transfer_brains_token(&ctx, 80_000_000)?;\n  mint_to_user(&ctx, index)?;\n  Ok(())\n}`,
    },
    {
      step: '04', title: 'Deploy to X1 Devnet First', color: '#bf5af2',
      code: `solana config set --url https://rpc.devnet.x1.xyz\nanchor build && anchor deploy\n# Update MINT_PROGRAM_ID in MintLabWork.tsx`,
    },
    {
      step: '05', title: 'Upload Metadata to IPFS', color: '#00ff88',
      code: `npm install -g nft.storage-cli\n# { "name": "Brains Lab Work #1", "symbol": "LABWORK",\n#   "image": "ipfs://YOUR_CID/1.png", "attributes": [...] }\nnft-storage upload ./metadata/`,
    },
    {
      step: '06', title: 'Switch to Mainnet & Go Live', color: '#ffd700',
      code: `solana config set --url https://rpc.mainnet.x1.xyz\nanchor deploy --provider.cluster mainnet\n# Update MINT_PROGRAM_ID → mint page is live!`,
    },
  ];

  return (
    <div style={{ marginTop: 48 }}>
      <button onClick={() => setOpen(v => !v)} style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%',
        background: open ? 'rgba(0,212,255,.07)' : 'rgba(0,212,255,.03)',
        border: '1px solid rgba(0,212,255,.2)', borderRadius: open ? '14px 14px 0 0' : 14,
        padding: '18px 24px', cursor: 'pointer', transition: 'all 0.3s',
      }}>
        <span style={{ fontSize: 16 }}>📋</span>
        <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color: '#00d4ff', letterSpacing: 2 }}>
          RUST DEPLOYMENT GUIDE
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00d4ff', opacity: 0.5 }}>
          {open ? '▲ COLLAPSE' : '▼ EXPAND'}
        </span>
      </button>
      {open && (
        <div style={{ background: 'rgba(0,8,18,.7)', border: '1px solid rgba(0,212,255,.15)', borderTop: 'none', borderRadius: '0 0 14px 14px', padding: '24px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {steps.map(s => (
              <div key={s.step} style={{ background: 'rgba(0,0,0,.4)', border: `1px solid ${s.color}25`, borderLeft: `3px solid ${s.color}`, borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${s.color}18` }}>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, color: s.color, opacity: 0.8 }}>{s.step}</span>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#fff', letterSpacing: 1 }}>{s.title}</span>
                </div>
                <pre style={{ margin: 0, padding: '14px', fontFamily: '"Fira Code", monospace', fontSize: 11, color: '#a8c8b8', lineHeight: 1.6, overflowX: 'auto', background: 'transparent' }}>{s.code}</pre>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 18, padding: '14px 18px', background: 'rgba(191,90,242,.07)', border: '1px solid rgba(191,90,242,.2)', borderRadius: 10 }}>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#bf5af2', letterSpacing: 2, marginBottom: 8 }}>📚 RESOURCES</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {[
                { label: 'Anchor Docs', url: 'https://www.anchor-lang.com/docs' },
                { label: 'Metaplex Docs', url: 'https://developers.metaplex.com' },
                { label: 'X1 Docs', url: 'https://docs.x1.xyz' },
                { label: 'NFT.Storage', url: 'https://nft.storage' },
              ].map(link => (
                <a key={link.label} href={link.url} target="_blank" rel="noopener noreferrer"
                  style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00d4ff', background: 'rgba(0,212,255,.07)', border: '1px solid rgba(0,212,255,.2)', padding: '5px 12px', borderRadius: 6, textDecoration: 'none', letterSpacing: 1, transition: 'background 0.2s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(0,212,255,.16)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(0,212,255,.07)'; }}>
                  {link.label} ↗
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────
const MintLabWork: FC = () => {
  const countdown   = useCountdown(MINT_DATE);
  const mintedCount = 0;

  // Live wallet balance detection — mirrors Portfolio.tsx pattern
  const [walletBalances, refreshBalances] = useWalletBalances();

  return (
    <div style={{ minHeight: '100vh', background: '#080c0f', padding: '90px 24px 60px', position: 'relative', overflow: 'hidden' }}>
      <TopBar />
      <PageBackground />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1100, margin: '0 auto' }}>

        {/* ── HERO ── */}
        <div style={{ textAlign: 'center', marginBottom: 56, animation: 'fadeUp 0.6s ease both' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
            <div style={{ position: 'relative', width: 110, height: 110 }}>
              <div style={{ position: 'absolute', inset: -8, borderRadius: '50%', background: 'conic-gradient(from 0deg,#ff8c00,#ffb700,#bf5af2,#ff8c00)', animation: 'spin 4s linear infinite', opacity: 0.7 }} />
              <div style={{ position: 'absolute', inset: -14, borderRadius: '50%', background: 'conic-gradient(from 180deg,#00d4ff,#bf5af2,transparent,#00d4ff)', animation: 'spin 8s linear infinite reverse', opacity: 0.3 }} />
              <img src={BRAINS_LOGO} alt="Brains" style={{ position: 'relative', zIndex: 1, width: 110, height: 110, borderRadius: '50%', objectFit: 'cover', border: '4px solid #0a0e14' }} />
            </div>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 14, background: 'rgba(255,140,0,.08)', border: '1px solid rgba(255,140,0,.25)', borderRadius: 20, padding: '5px 16px' }}>
            <span style={{ fontSize: 11 }}>🧠</span>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#ff8c00', letterSpacing: 3 }}>EXCLUSIVE 88 NFT COLLECTION · X1 BLOCKCHAIN</span>
          </div>
          <h1 style={{
            fontFamily: 'Orbitron, monospace', fontSize: 'clamp(28px, 5.5vw, 56px)',
            fontWeight: 900, letterSpacing: 6, textTransform: 'uppercase',
            background: 'linear-gradient(135deg,#ff8c00 0%,#ffb700 40%,#bf5af2 70%,#00d4ff 100%)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            margin: '0 0 12px', lineHeight: 1.1,
          }}>Brains Lab Work</h1>
          <p style={{ fontFamily: 'Sora, sans-serif', fontSize: 15, color: '#7a9ab8', maxWidth: 520, margin: '0 auto 28px', lineHeight: 1.7 }}>
            88 hand-curated NFTs on the X1 blockchain. Requires both <span style={{ color: '#ff8c00' }}>XNT</span> and <span style={{ color: '#bf5af2' }}>BRAINS</span> tokens to mint.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            {[
              { label: 'TOTAL SUPPLY', value: '88',                    color: '#ff8c00' },
              { label: 'BLOCKCHAIN',   value: 'X1',                    color: '#00d4ff' },
              { label: 'SYMBOL',       value: COLLECTION_SYMBOL,       color: '#bf5af2' },
              { label: 'XNT PRICE',    value: `${PRICE_XNT} XNT`,      color: '#ffb700' },
              { label: 'BRAINS PRICE', value: `${PRICE_BRAINS} BRAINS`, color: '#bf5af2' },
            ].map(s => (
              <div key={s.label} style={{ background: 'rgba(255,255,255,.03)', border: '1px solid #1e3050', borderRadius: 10, padding: '10px 18px', textAlign: 'center' }}>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, color: s.color, textShadow: `0 0 12px ${s.color}66`, marginBottom: 3 }}>{s.value}</div>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#4a6070', letterSpacing: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── COUNTDOWN ── */}
        {!countdown.live && (
          <div style={{ textAlign: 'center', marginBottom: 52, animation: 'fadeUp 0.6s ease 0.1s both' }}>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#5a7a94', letterSpacing: 4, marginBottom: 18, textTransform: 'uppercase' }}>⏰ Mint Goes Live In</div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
              <CountdownBlock label="DAYS"    value={countdown.d} />
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 32, color: '#ff8c00', alignSelf: 'center', opacity: 0.4 }}>:</div>
              <CountdownBlock label="HOURS"   value={countdown.h} />
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 32, color: '#ff8c00', alignSelf: 'center', opacity: 0.4 }}>:</div>
              <CountdownBlock label="MINUTES" value={countdown.m} />
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 32, color: '#ff8c00', alignSelf: 'center', opacity: 0.4 }}>:</div>
              <CountdownBlock label="SECONDS" value={countdown.s} />
            </div>
          </div>
        )}
        {countdown.live && (
          <div style={{ textAlign: 'center', marginBottom: 44 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, background: 'linear-gradient(135deg,rgba(0,255,136,.1),rgba(0,200,100,.06))', border: '2px solid rgba(0,255,136,.35)', borderRadius: 12, padding: '12px 26px' }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 12px rgba(0,255,136,.8)', animation: 'pulse-green 1.5s ease infinite' }} />
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 13, fontWeight: 900, color: '#00ff88', letterSpacing: 3 }}>MINT IS LIVE</span>
            </div>
          </div>
        )}

        {/* ── MAIN GRID ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 40, marginBottom: 64, alignItems: 'start' }} className="mint-layout">

          {/* Preview grid */}
          <div style={{ animation: 'fadeUp 0.6s ease 0.15s both' }}>
            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#5a7a94', letterSpacing: 3, marginBottom: 18, textTransform: 'uppercase' }}>
              🖼️ Preview Collection
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              {PREVIEW_NFTS.map((nft, i) => <PreviewCard key={nft.id} nft={nft} delay={0.08 * i} />)}
            </div>
          </div>

          {/* Mint panel */}
          <div style={{ animation: 'fadeUp 0.6s ease 0.2s both', flexShrink: 0 }}>
            <MintSection
              minted={mintedCount}
              total={NFT_TOTAL}
              walletBalances={walletBalances}
              onRefreshBalances={refreshBalances}
            />
          </div>
        </div>

        {/* ── RARITY DISTRIBUTION ── */}
        <div style={{ marginBottom: 56, animation: 'fadeUp 0.6s ease 0.25s both' }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#5a7a94', letterSpacing: 3, marginBottom: 18, textTransform: 'uppercase' }}>✨ Rarity Distribution</div>
          <div style={{ height: 8, borderRadius: 4, overflow: 'hidden', display: 'flex', marginBottom: 18, border: '1px solid rgba(255,255,255,.05)' }}>
            {RARITY_TIERS.map(tier => (
              <div key={tier.label} style={{ width: `${(tier.count / NFT_TOTAL) * 100}%`, background: tier.color, boxShadow: `0 0 8px ${tier.glow}`, transition: 'width 1s ease' }} />
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {RARITY_TIERS.map(tier => (
              <div key={tier.label} style={{ background: `${tier.color}0a`, border: `1px solid ${tier.color}28`, borderLeft: `3px solid ${tier.color}`, borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16 }}>{tier.emoji}</span>
                <div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: tier.color, letterSpacing: 2, marginBottom: 2 }}>{tier.label}</div>
                  <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 12, fontWeight: 700, color: '#fff' }}>
                    {tier.count} <span style={{ fontSize: 10, color: '#5a7a94', fontWeight: 400 }}>/ {tier.pct}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── RUST GUIDE ── */}
        <RustGuide />
        <Footer />
      </div>

      <style>{`
        @media (max-width: 768px) {
          .mint-layout { grid-template-columns: 1fr !important; }
        }
        @keyframes pulse-green {
          0%,100% { opacity:1; box-shadow:0 0 12px rgba(0,255,136,.8); }
          50%      { opacity:.7; box-shadow:0 0 22px rgba(0,255,136,1); }
        }
        @keyframes pulse-orange {
          0%,100% { opacity:1; }
          50%      { opacity:.5; }
        }
        @keyframes scanline {
          0%   { top: -4px; }
          100% { top: 100%; }
        }
      `}</style>
    </div>
  );
};

export default MintLabWork;