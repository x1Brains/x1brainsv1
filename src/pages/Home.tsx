import React, { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { BRAINS_LOGO, NAV_LINKS } from '../constants';
import { TopBar, PageBackground, Footer } from '../components/UI';

// ─────────────────────────────────────────────
// FEATURE CARD
// ─────────────────────────────────────────────
const FeatureCard: FC<{
  icon: string;
  title: string;
  description: string;
  route: string;
  color: string;
  accentColor: string;
  delay?: number;
  locked?: boolean;
  isNew?: boolean;
  badge?: string;
  comingSoon?: boolean;
}> = ({ icon, title, description, route, color, accentColor, delay = 0, locked = false, isNew = false, badge, comingSoon = false }) => {
  const navigate = useNavigate();
  const { connected } = useWallet();

  const canNavigate = !comingSoon && (!locked || connected);

  return (
    <div
      onClick={() => canNavigate && navigate(route)}
      style={{
        position: 'relative',
        background: 'linear-gradient(135deg, #0d1520, #0a1018)',
        border: `1px solid ${color}30`,
        borderRadius: 16,
        padding: '28px 24px',
        cursor: canNavigate ? 'pointer' : 'not-allowed',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        animation: `fadeUp 0.5s ease ${delay}s both`,
        overflow: 'hidden',
        opacity: comingSoon ? 0.55 : (locked && !connected ? 0.7 : 1),
      }}
      onMouseEnter={e => {
        if (!canNavigate) return;
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = color;
        el.style.transform = 'translateY(-6px)';
        el.style.boxShadow = `0 16px 50px rgba(0,0,0,0.5), 0 0 30px ${color}20`;
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = `${color}30`;
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = 'none';
      }}
    >
      {/* Top accent line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent, ${color}, transparent)`, opacity: comingSoon ? 0.2 : 0.6 }} />

      {/* Ambient glow */}
      <div style={{ position: 'absolute', top: -40, right: -40, width: 120, height: 120, borderRadius: '50%', background: `radial-gradient(circle, ${color}12 0%, transparent 70%)`, pointerEvents: 'none' }} />

      {/* COMING SOON badge — takes priority over NEW */}
      {comingSoon ? (
        <div style={{
          position: 'absolute', top: 14, right: 14,
          background: 'rgba(92,122,144,0.15)',
          border: '1px solid rgba(92,122,144,0.3)',
          color: '#5c7a90', fontFamily: 'Orbitron, monospace',
          fontSize: 7, fontWeight: 900, letterSpacing: 2,
          padding: '3px 10px', borderRadius: 6,
        }}>SOON</div>
      ) : isNew && (
        <div style={{
          position: 'absolute', top: 14, right: 14,
          background: `linear-gradient(135deg, ${color}, ${color}bb)`,
          color: '#0a0e14', fontFamily: 'Orbitron, monospace',
          fontSize: 8, fontWeight: 900, letterSpacing: 2,
          padding: '3px 10px', borderRadius: 6,
        }}>NEW</div>
      )}

      {/* Icon */}
      <div style={{ fontSize: 40, marginBottom: 18, display: 'block', filter: comingSoon ? 'grayscale(80%)' : `drop-shadow(0 0 12px ${color}60)` }}>
        {icon}
      </div>

      {/* Title */}
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, letterSpacing: 3, color: comingSoon ? '#4a6070' : accentColor, marginBottom: 10, textTransform: 'uppercase' }}>
        {title}
      </div>

      {/* Description */}
      <p style={{ fontSize: 13, color: comingSoon ? '#3a5060' : '#7a9ab8', lineHeight: 1.7, marginBottom: 16 }}>
        {description}
      </p>

      {/* Optional info badge */}
      {badge && !comingSoon && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: `${color}10`, border: `1px solid ${color}30`,
          borderRadius: 8, padding: '5px 12px', marginBottom: 16,
        }}>
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color, letterSpacing: 1.5, fontWeight: 700 }}>{badge}</span>
        </div>
      )}

      {/* CTA */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {comingSoon ? (
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#3a5060', letterSpacing: 2 }}>🔧 UNDER DEVELOPMENT</span>
        ) : locked && !connected ? (
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#4a6070', letterSpacing: 2 }}>🔒 CONNECT WALLET TO ACCESS</span>
        ) : (
          <>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color, letterSpacing: 2, fontWeight: 700 }}>ENTER</span>
            <span style={{ color, fontSize: 12 }}>→</span>
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// STAT PILL — top of landing
// ─────────────────────────────────────────────
const StatPill: FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <div style={{
    background: 'rgba(13,21,32,0.8)',
    border: `1px solid ${color}30`,
    borderRadius: 30, padding: '8px 18px',
    display: 'flex', alignItems: 'center', gap: 10,
  }}>
    <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}` }} />
    <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color, fontWeight: 700, letterSpacing: 1 }}>{value}</span>
    <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#5c7a90', letterSpacing: 2 }}>{label}</span>
  </div>
);

// ─────────────────────────────────────────────
// HOME PAGE
// ─────────────────────────────────────────────
const Home: FC = () => {
  const { connected } = useWallet();
  const navigate = useNavigate();

  return (
    <div style={{ minHeight: '100vh', background: '#080c0f', padding: '80px 16px 40px', position: 'relative', overflow: 'hidden' }}>
      <TopBar />
      <PageBackground />

      {/* Extra purple blob for home page */}
      <div style={{ position: 'fixed', top: '40%', left: '50%', transform: 'translate(-50%,-50%)', width: 800, height: 800, borderRadius: '50%', background: 'radial-gradient(circle, rgba(191,90,242,0.03) 0%, transparent 60%)', pointerEvents: 'none', zIndex: 0 }} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 900, margin: '0 auto' }}>

        {/* ── HERO ── */}
        <div style={{ textAlign: 'center', marginBottom: 60, animation: 'fadeUp 0.6s ease both' }}>

          {/* Spinning logo */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28 }}>
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', inset: -10, borderRadius: '50%', background: 'conic-gradient(from 0deg, #ff8c00, #ffb700, #bf5af2, #00d4ff, #ff8c00)', animation: 'spin 8s linear infinite', opacity: 0.45 }} />
              <div style={{ position: 'absolute', inset: -20, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,140,0,0.15) 0%, transparent 70%)', animation: 'pulse-orange 3s ease infinite' }} />
              <img src={BRAINS_LOGO} alt="X1 Brains"
                style={{ position: 'relative', zIndex: 1, width: 140, height: 140, borderRadius: '50%', objectFit: 'cover', border: '4px solid #0a0e14' }}
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          </div>

          {/* Eyebrow */}
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5c7a90', letterSpacing: 6, marginBottom: 14, textTransform: 'uppercase' }}>
            X1 BLOCKCHAIN · NEURAL ECOSYSTEM
          </div>

          {/* Main title */}
          <h1 style={{
            fontFamily: 'Orbitron, monospace', fontSize: 56, fontWeight: 900, letterSpacing: 8,
            background: 'linear-gradient(135deg, #ff8c00 0%, #ffb700 35%, #bf5af2 65%, #00d4ff 100%)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            margin: '0 0 16px', textTransform: 'uppercase', lineHeight: 1.1,
          }}>X1 BRAINS</h1>

          <p style={{ fontFamily: 'Sora, sans-serif', fontSize: 16, color: '#7a9ab8', lineHeight: 1.7, maxWidth: 600, margin: '0 auto 36px' }}>
            The exclusive X1 blockchain hub — track your portfolio, see your NFT's, watch your XenBlocks stats and Miner information, burn Brains to earn and ascend while getting the Vaults prizes each week. Promote on any social media platform to earn Lab Work points and use Amplifiers to even earn more 🧪 LB points.
          </p>

          {/* Stat pills */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 36 }}>
            <StatPill label="MAINNET"  value="X1"        color="#00c98d" />
            <StatPill label="SOON"     value="88 NFT's"  color="#ff8c00" />
            <StatPill label="TOKENS"   value="SPL + T22"  color="#00d4ff" />
            <StatPill label="MINT"     value="NFT's"      color="#bf5af2" />
          </div>

          {/* Divider */}
          <div style={{ width: 280, height: 1, background: 'linear-gradient(to right, transparent, #ff8c0060, transparent)', margin: '0 auto 36px' }} />

          {/* Wallet connect — only show if not connected */}
          {!connected && (
            <div style={{ display: 'inline-block', position: 'relative' }}>
              <div style={{ position: 'absolute', inset: -3, borderRadius: 12, background: 'linear-gradient(135deg, #ff8c00, #ffb700, #00d4ff)', opacity: 0.5, filter: 'blur(10px)' }} />
              <div style={{ position: 'relative', zIndex: 1 }}>
                <WalletMultiButton />
              </div>
            </div>
          )}

          {connected && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#00c98d', animation: 'pulse-orange 2s ease infinite' }} />
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00c98d', letterSpacing: 2 }}>WALLET CONNECTED · SELECT A DESTINATION</span>
            </div>
          )}
        </div>

        {/* ── FEATURE CARDS ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20, marginBottom: 48 }}>

          {/* ── PORTFOLIO — Custom card with feature badges ── */}
          <div
            style={{
              position: 'relative',
              background: 'linear-gradient(135deg, #0d1520, #0a1018)',
              border: '1px solid #00d4ff30',
              borderRadius: 16,
              padding: '28px 24px',
              cursor: 'pointer',
              animation: 'fadeUp 0.5s ease 0.1s both',
              overflow: 'hidden',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onClick={() => navigate('/portfolio')}
            onMouseEnter={e => { const el = e.currentTarget; el.style.borderColor = '#00d4ff'; el.style.transform = 'translateY(-6px)'; el.style.boxShadow = '0 16px 50px rgba(0,0,0,0.5), 0 0 30px #00d4ff20'; }}
            onMouseLeave={e => { const el = e.currentTarget; el.style.borderColor = '#00d4ff30'; el.style.transform = 'translateY(0)'; el.style.boxShadow = 'none'; }}
          >
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, #00d4ff, transparent)', opacity: 0.6 }} />
            <div style={{ position: 'absolute', top: -40, right: -40, width: 120, height: 120, borderRadius: '50%', background: 'radial-gradient(circle, #00d4ff12 0%, transparent 70%)', pointerEvents: 'none' }} />

            <div style={{ fontSize: 40, marginBottom: 18, display: 'block', filter: 'drop-shadow(0 0 12px #00d4ff60)' }}>💼</div>

            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, letterSpacing: 3, color: '#00d4ff', marginBottom: 6, textTransform: 'uppercase' }}>
              PORTFOLIO
            </div>

            <p style={{ fontSize: 13, color: '#7a9ab8', lineHeight: 1.7, marginBottom: 16 }}>
              Track your XNT balance, SPL tokens, and Token-2022 assets in real time. Full on-chain metadata from X1 RPC — Metaplex and Token-2022 extensions.
            </p>

            {/* Feature badges */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                { text: '💰 XNT', color: '#00c98d' },
                { text: '🪙 SPL', color: '#ff8c00' },
                { text: '⚡ T22', color: '#ffb700' },
                { text: '💧 LP', color: '#00c98d' },
                { text: '⛏️ XENBLOCKS', color: '#bf5af2' },
                { text: '🔥 BURNS', color: '#ff4422' },
              ].map(tag => (
                <span key={tag.text} style={{
                  fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 700, letterSpacing: 1,
                  color: tag.color, background: `${tag.color}10`, border: `1px solid ${tag.color}20`,
                  borderRadius: 5, padding: '3px 8px',
                }}>{tag.text}</span>
              ))}
            </div>

            {connected ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00d4ff', letterSpacing: 2, fontWeight: 700 }}>ENTER</span>
                <span style={{ color: '#00d4ff', fontSize: 12 }}>→</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00d4ff', letterSpacing: 2, fontWeight: 700 }}>ENTER</span>
                  <span style={{ color: '#00d4ff', fontSize: 12 }}>→</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 10 }}>👁</span>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#5c7a90', letterSpacing: 1.5 }}>WATCH ANY WALLET — NO LOGIN NEEDED</span>
                </div>
              </div>
            )}
          </div>

          {/* ── LAB WORK 🧪 — Split card: NFT Marketplace + LP Pairing ── */}
          <div
            style={{
              position: 'relative',
              background: 'linear-gradient(135deg, #0d1520, #0a1018)',
              border: '1px solid #ffb70030',
              borderRadius: 16,
              padding: '28px 24px',
              cursor: 'default',
              animation: 'fadeUp 0.5s ease 0.3s both',
              overflow: 'hidden',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, #ffb700, transparent)', opacity: 0.6 }} />
            <div style={{ position: 'absolute', top: -40, right: -40, width: 120, height: 120, borderRadius: '50%', background: 'radial-gradient(circle, #ffb70012 0%, transparent 70%)', pointerEvents: 'none' }} />

            <div style={{ fontSize: 40, marginBottom: 12, display: 'block', filter: 'drop-shadow(0 0 12px #ffb70060)' }}>🧪</div>

            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, letterSpacing: 3, color: '#ffb700', marginBottom: 6, textTransform: 'uppercase' }}>
              LAB WORK
            </div>

            <p style={{ fontSize: 13, color: '#7a9ab8', lineHeight: 1.7, marginBottom: 18 }}>
              The full X1 Brains Lab Work suite — NFT marketplace and DeFi LP pairing platform on X1 blockchain.
            </p>

            {/* NFT Marketplace sub-button */}
            <button
              onClick={e => { e.stopPropagation(); navigate('/labwork'); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                background: 'rgba(255,183,0,0.06)', border: '1px solid rgba(255,183,0,0.18)',
                borderRadius: 10, padding: '12px 14px', cursor: 'pointer',
                transition: 'all 0.2s', textAlign: 'left', marginBottom: 10,
                position: 'relative', overflow: 'hidden',
              }}
              onMouseEnter={e => { const el = e.currentTarget; el.style.background = 'rgba(255,183,0,0.14)'; el.style.borderColor = 'rgba(255,183,0,0.45)'; el.style.transform = 'translateX(3px)'; }}
              onMouseLeave={e => { const el = e.currentTarget; el.style.background = 'rgba(255,183,0,0.06)'; el.style.borderColor = 'rgba(255,183,0,0.18)'; el.style.transform = 'translateX(0)'; }}
            >
              <span style={{ fontSize: 22, flexShrink: 0 }}>🧠</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: '#ffb700' }}>LB NFT MARKETPLACE</span>
                  <span style={{
                    fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 900, letterSpacing: 1,
                    color: '#0a0e14', background: '#ffb700', borderRadius: 4, padding: '1px 6px',
                  }}>NFT</span>
                </div>
                <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 9, color: '#5c7a90' }}>Scan · List · Buy · Mint LB tokens</div>
              </div>
              <span style={{ color: '#ffb700', fontSize: 11, opacity: 0.7 }}>→</span>
            </button>

            {/* LP Pairing sub-button */}
            <button
              onClick={e => { e.stopPropagation(); navigate('/labworkdefi'); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                background: 'rgba(0,201,141,0.06)', border: '1px solid rgba(0,201,141,0.18)',
                borderRadius: 10, padding: '12px 14px', cursor: 'pointer',
                transition: 'all 0.2s', textAlign: 'left',
                position: 'relative', overflow: 'hidden',
              }}
              onMouseEnter={e => { const el = e.currentTarget; el.style.background = 'rgba(0,201,141,0.14)'; el.style.borderColor = 'rgba(0,201,141,0.45)'; el.style.transform = 'translateX(3px)'; }}
              onMouseLeave={e => { const el = e.currentTarget; el.style.background = 'rgba(0,201,141,0.06)'; el.style.borderColor = 'rgba(0,201,141,0.18)'; el.style.transform = 'translateX(0)'; }}
            >
              <span style={{ fontSize: 22, flexShrink: 0 }}>⚡</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: '#00c98d' }}>LB LP PAIRING</span>
                  <span style={{
                    fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 900, letterSpacing: 1,
                    color: '#0a0e14', background: '#00c98d', borderRadius: 4, padding: '1px 6px',
                  }}>DEFI</span>
                  <span style={{
                    fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 900, letterSpacing: 1,
                    color: '#00c98d', background: 'rgba(0,201,141,0.15)', border: '1px solid rgba(0,201,141,0.4)', borderRadius: 4, padding: '1px 6px',
                  }}>NEW</span>
                </div>
                <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 9, color: '#5c7a90' }}>Swap · LP Pairing · Charts · Deposit · Withdraw</div>
              </div>
              <span style={{ color: '#00c98d', fontSize: 11, opacity: 0.7 }}>→</span>
            </button>
          </div>

          {/* ── CYBERDYNE UNLIMITED ── */}
          <div
            style={{
              position: 'relative',
              background: 'linear-gradient(135deg, #0d1520, #0a1018)',
              border: '1px solid #39ff8830',
              borderRadius: 16,
              padding: '28px 24px',
              cursor: 'pointer',
              animation: 'fadeUp 0.5s ease 0.2s both',
              overflow: 'hidden',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onClick={() => navigate('/cyberdyne')}
            onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#39ff88'; el.style.transform = 'translateY(-6px)'; el.style.boxShadow = '0 16px 50px rgba(0,0,0,0.5), 0 0 30px #39ff8820'; }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#39ff8830'; el.style.transform = 'translateY(0)'; el.style.boxShadow = 'none'; }}
          >
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, #39ff88, transparent)', opacity: 0.6 }} />
            <div style={{ position: 'absolute', top: -40, right: -40, width: 120, height: 120, borderRadius: '50%', background: 'radial-gradient(circle, #39ff8812 0%, transparent 70%)', pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 60, background: 'linear-gradient(180deg, transparent, rgba(57,255,136,0.03))', pointerEvents: 'none' }} />

            <div style={{ fontSize: 40, marginBottom: 18, display: 'block', filter: 'drop-shadow(0 0 12px #39ff8860)' }}>⚔️</div>

            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, letterSpacing: 3, color: '#39ff88', marginBottom: 6, textTransform: 'uppercase' }}>
              CYBERDYNE UNLIMITED
            </div>

            <p style={{ fontSize: 13, color: '#7a9ab8', lineHeight: 1.7, marginBottom: 16 }}>
              The Imperial Citizen Registry — look up X1 citizens by username or wallet, explore tier rankings, contribution history, verified wallets, and climb the live Cyberdyne leaderboard.
            </p>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                { text: '🔍 LOOKUP',      color: '#39ff88' },
                { text: '🏅 TIERS',       color: '#ffb700' },
                { text: '🏆 LEADERBOARD', color: '#bf5af2' },
                { text: '📊 ANALYTICS',   color: '#00d4ff' },
              ].map(tag => (
                <span key={tag.text} style={{
                  fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 700, letterSpacing: 1,
                  color: tag.color, background: `${tag.color}10`, border: `1px solid ${tag.color}20`,
                  borderRadius: 5, padding: '3px 8px',
                }}>{tag.text}</span>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#39ff88', letterSpacing: 2, fontWeight: 700 }}>ENTER</span>
              <span style={{ color: '#39ff88', fontSize: 12 }}>→</span>
            </div>
          </div>

          {/* ── INCINERATOR — Burn engine card ── */}
          <div
            style={{
              position: 'relative',
              background: 'linear-gradient(135deg, #0d1520, #0a1018)',
              border: '1px solid #ff8c0030',
              borderRadius: 16,
              padding: '28px 24px',
              cursor: 'pointer',
              animation: 'fadeUp 0.5s ease 0.4s both',
              overflow: 'hidden',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onClick={() => navigate('/burn-history')}
            onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#ff8c00'; el.style.transform = 'translateY(-6px)'; el.style.boxShadow = '0 16px 50px rgba(0,0,0,0.5), 0 0 30px #ff8c0020'; }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#ff8c0030'; el.style.transform = 'translateY(0)'; el.style.boxShadow = 'none'; }}
          >
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, #ff8c00, transparent)', opacity: 0.6 }} />
            <div style={{ position: 'absolute', top: -40, right: -40, width: 120, height: 120, borderRadius: '50%', background: 'radial-gradient(circle, #ff8c0012 0%, transparent 70%)', pointerEvents: 'none' }} />

            <div style={{ fontSize: 40, marginBottom: 18, display: 'block', filter: 'drop-shadow(0 0 12px #ff8c0060)' }}>🔥</div>

            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, letterSpacing: 3, color: '#ff8c00', marginBottom: 6, textTransform: 'uppercase' }}>
              INCINERATOR
            </div>

            <p style={{ fontSize: 13, color: '#7a9ab8', lineHeight: 1.7, marginBottom: 16 }}>
              Burn BRAINS tokens, earn LB Points, stack AMP bonuses, and compete for prizes on the X1 blockchain.
            </p>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                { text: '🔥 BURN', color: '#ff4422' },
                { text: '⚡ AMP', color: '#ffb700' },
                { text: '🏆 RANKS', color: '#ff8c00' },
                { text: '🎯 PRIZES', color: '#bf5af2' },
              ].map(tag => (
                <span key={tag.text} style={{
                  fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 700, letterSpacing: 1,
                  color: tag.color, background: `${tag.color}10`, border: `1px solid ${tag.color}20`,
                  borderRadius: 5, padding: '3px 8px',
                }}>{tag.text}</span>
              ))}
            </div>

            {/* BURN EARN ASCEND sub-link */}
            <button
              onClick={e => { e.stopPropagation(); navigate('/incinerator-engine'); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                background: 'rgba(255,183,0,0.06)', border: '1px solid rgba(255,183,0,0.15)',
                borderRadius: 8, padding: '8px 10px', cursor: 'pointer',
                transition: 'all 0.2s', textAlign: 'left', marginBottom: 12,
              }}
              onMouseEnter={e => { const el = e.currentTarget; el.style.background = 'rgba(255,183,0,0.14)'; el.style.borderColor = 'rgba(255,183,0,0.4)'; }}
              onMouseLeave={e => { const el = e.currentTarget; el.style.background = 'rgba(255,183,0,0.06)'; el.style.borderColor = 'rgba(255,183,0,0.15)'; }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>⚡</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, fontWeight: 700, letterSpacing: 1.5, color: '#ffb700' }}>BURN, EARN & ASCEND</div>
                <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 9, color: '#5c7a90', marginTop: 2 }}>Main Burn Engine · Incinerator Protocol</div>
              </div>
              <span style={{ color: '#ffb700', fontSize: 11, opacity: 0.6 }}>→</span>
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#ff8c00', letterSpacing: 2, fontWeight: 700 }}>ENTER</span>
              <span style={{ color: '#ff8c00', fontSize: 12 }}>→</span>
            </div>
          </div>

          {/* ── REWARDS COMMUNITY HUB ── */}
          <div
            style={{
              position: 'relative',
              background: 'linear-gradient(135deg, #0d1520, #0a1018)',
              border: '1px solid #bf5af230',
              borderRadius: 16,
              padding: '28px 24px',
              cursor: 'pointer',
              animation: 'fadeUp 0.5s ease 0.4s both',
              overflow: 'hidden',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            onClick={() => navigate('/rewards')}
            onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#bf5af2'; el.style.transform = 'translateY(-6px)'; el.style.boxShadow = '0 16px 50px rgba(0,0,0,0.5), 0 0 30px #bf5af220'; }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.borderColor = '#bf5af230'; el.style.transform = 'translateY(0)'; el.style.boxShadow = 'none'; }}
          >
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, #bf5af2, transparent)', opacity: 0.6 }} />
            <div style={{ position: 'absolute', top: -40, right: -40, width: 120, height: 120, borderRadius: '50%', background: 'radial-gradient(circle, #bf5af212 0%, transparent 70%)', pointerEvents: 'none' }} />

            <div style={{ fontSize: 40, marginBottom: 18, display: 'block', filter: 'drop-shadow(0 0 12px #bf5af260)' }}>🏆</div>

            <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, letterSpacing: 3, color: '#bf5af2', marginBottom: 6, textTransform: 'uppercase' }}>
              REWARDS HUB
            </div>

            <p style={{ fontSize: 13, color: '#7a9ab8', lineHeight: 1.7, marginBottom: 16 }}>
              Weekly burn challenges with prize vaults, Lab Work submissions for bonus LB Points, live leaderboards, and AMP stacking rewards.
            </p>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                { text: '🏆 PRIZES', color: '#bf5af2' },
                { text: '🔥 CHALLENGES', color: '#ff8c00' },
                { text: '🧪 LAB WORK', color: '#00c98d' },
              ].map(tag => (
                <span key={tag.text} style={{
                  fontFamily: 'Orbitron, monospace', fontSize: 7, fontWeight: 700, letterSpacing: 1,
                  color: tag.color, background: `${tag.color}10`, border: `1px solid ${tag.color}20`,
                  borderRadius: 5, padding: '3px 8px',
                }}>{tag.text}</span>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#bf5af2', letterSpacing: 2, fontWeight: 700 }}>ENTER</span>
              <span style={{ color: '#bf5af2', fontSize: 12 }}>→</span>
            </div>
          </div>


        </div>

        {/* ── RARITY PREVIEW STRIP — COMING SOON ── */}
        <div style={{
          background: 'linear-gradient(135deg, #0d1520, #0a1018)',
          border: '1px solid rgba(92,122,144,0.15)',
          borderRadius: 14, padding: '18px 24px', marginBottom: 20,
          animation: 'fadeUp 0.5s ease 0.35s both',
          opacity: 0.5,
          cursor: 'not-allowed',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 3, textTransform: 'uppercase', fontWeight: 700 }}>🔬 Collection Rarity</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {[
                { label: 'LEGENDARY', count: 4  },
                { label: 'EPIC',      count: 12 },
                { label: 'RARE',      count: 20 },
                { label: 'UNCOMMON',  count: 24 },
                { label: 'COMMON',    count: 28 },
              ].map(tier => (
                <div key={tier.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#3a5060' }} />
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#3a5060', letterSpacing: 1 }}>{tier.count}</span>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#2a4050', letterSpacing: 1 }}>{tier.label}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#4a6070' }} />
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#4a6070', letterSpacing: 2 }}>COMING SOON</span>
            </div>
          </div>
        </div>

        {/* ── ECOSYSTEM LINKS ── */}
        <div style={{
          background: 'linear-gradient(135deg, #0d1520, #0a1018)',
          border: '1px solid #1e3050', borderRadius: 14,
          padding: '20px 24px',
          animation: 'fadeUp 0.5s ease 0.4s both',
        }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 3, marginBottom: 16, textTransform: 'uppercase' }}>
            X1 Ecosystem
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            {NAV_LINKS.map(link => (
              <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer"
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: 'rgba(255,140,0,0.04)', border: '1px solid rgba(255,140,0,0.1)', borderRadius: 8, textDecoration: 'none', transition: 'all 0.2s' }}
                onMouseEnter={e => { const el = e.currentTarget as HTMLAnchorElement; el.style.borderColor = 'rgba(255,140,0,0.4)'; el.style.background = 'rgba(255,140,0,0.08)'; }}
                onMouseLeave={e => { const el = e.currentTarget as HTMLAnchorElement; el.style.borderColor = 'rgba(255,140,0,0.1)'; el.style.background = 'rgba(255,140,0,0.04)'; }}
              >
                <span style={{ fontSize: 12 }}>{link.icon}</span>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#8aa0b8', letterSpacing: 1.5, fontWeight: 700, textTransform: 'uppercase' }}>{link.label}</span>
                <span style={{ fontSize: 8, color: '#4a6070' }}>↗</span>
              </a>
            ))}
          </div>
        </div>

        <Footer />
      </div>
    </div>
  );
};

export default Home;