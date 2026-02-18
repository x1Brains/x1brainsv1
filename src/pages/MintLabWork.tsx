import React, { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAINS_LOGO } from '../constants';
import { TopBar, PageBackground, Footer } from '../components/UI';

// ─────────────────────────────────────────────
// MINT LAB WORK — UNDER DEVELOPMENT
// ─────────────────────────────────────────────
const RARITY_TIERS = [
  { label: 'LEGENDARY', count: 4,  color: '#ffd700', emoji: '👑' },
  { label: 'EPIC',      count: 12, color: '#bf5af2', emoji: '⚡' },
  { label: 'RARE',      count: 20, color: '#00d4ff', emoji: '💎' },
  { label: 'UNCOMMON',  count: 24, color: '#00ff88', emoji: '🔥' },
  { label: 'COMMON',    count: 28, color: '#8aa0b8', emoji: '🧠' },
];

const MintLabWork: FC = () => {
  const navigate = useNavigate();

  return (
    <div style={{ minHeight: '100vh', background: '#080c0f', padding: '80px 16px 40px', position: 'relative', overflow: 'hidden' }}>
      <TopBar />
      <PageBackground />

      {/* Ambient glow */}
      <div style={{ position: 'fixed', top: '40%', left: '50%', transform: 'translate(-50%,-50%)', width: 900, height: 900, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,140,0,0.04) 0%, transparent 60%)', pointerEvents: 'none', zIndex: 0 }} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 700, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 160px)', textAlign: 'center' }}>

        {/* Spinning logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 36, animation: 'fadeUp 0.5s ease both' }}>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', inset: -8, borderRadius: '50%', background: 'conic-gradient(from 0deg,#ff8c00,#ffb700,#bf5af2,#ff8c00)', animation: 'spin 4s linear infinite', opacity: 0.6 }} />
            <div style={{ position: 'absolute', inset: -16, borderRadius: '50%', background: 'conic-gradient(from 180deg,#00d4ff,#bf5af2,transparent,#00d4ff)', animation: 'spin 8s linear infinite reverse', opacity: 0.25 }} />
            <div style={{ position: 'absolute', inset: -22, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,140,0,0.14) 0%, transparent 70%)', animation: 'pulse-orange 3s ease infinite' }} />
            <img
              src={BRAINS_LOGO}
              alt="X1 Brains"
              style={{ position: 'relative', zIndex: 1, width: 120, height: 120, borderRadius: '50%', objectFit: 'cover', border: '4px solid #0a0e14', filter: 'grayscale(20%)' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        </div>

        {/* Eyebrow */}
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5c7a90', letterSpacing: 6, marginBottom: 16, textTransform: 'uppercase', animation: 'fadeUp 0.5s ease 0.1s both' }}>
          X1 BRAINS · NFT MINT
        </div>

        {/* Title */}
        <h1 style={{
          fontFamily: 'Orbitron, monospace', fontSize: 42, fontWeight: 900, letterSpacing: 6,
          background: 'linear-gradient(135deg, #ff8c00 0%, #ffb700 40%, #bf5af2 70%, #00d4ff 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          margin: '0 0 12px', textTransform: 'uppercase', lineHeight: 1.1,
          animation: 'fadeUp 0.5s ease 0.15s both',
        }}>
          MINT X1 Brains "LAB WORK" NFTs
        </h1>

        {/* Under development badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 10,
          background: 'rgba(255,140,0,0.07)', border: '1px solid rgba(255,140,0,0.25)',
          borderRadius: 30, padding: '10px 24px', marginBottom: 28,
          animation: 'fadeUp 0.5s ease 0.2s both',
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff8c00', boxShadow: '0 0 10px #ff8c00', animation: 'pulse-orange 2s ease infinite' }} />
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#ff8c00', letterSpacing: 3, fontWeight: 700 }}>
            UNDER DEVELOPMENT
          </span>
        </div>

        {/* Description */}
        <p style={{
          fontFamily: 'Sora, sans-serif', fontSize: 14, color: '#6a8ea8', lineHeight: 1.8,
          maxWidth: 480, margin: '0 auto 40px',
          animation: 'fadeUp 0.5s ease 0.25s both',
        }}>
          The X1 Brains mint is being prepared. The smart contract will be audited and the dual-token payment system is will be finalized. Only 88 Lab Work NFTs will ever exist.
        </p>

        {/* Info tiles */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 36, animation: 'fadeUp 0.5s ease 0.3s both' }}>
          {[
            { label: 'TOTAL SUPPLY', value: '88',         color: '#ff8c00' },
            { label: 'XNT PRICE',    value: '??? XNT',   color: '#ffb700' },
            { label: 'BRAINS PRICE', value: '??? BRAINS', color: '#bf5af2' },
            { label: 'BLOCKCHAIN',   value: 'X1',          color: '#00d4ff' },
          ].map(item => (
            <div key={item.label} style={{
              background: 'linear-gradient(135deg, #0d1520, #0a1018)',
              border: `1px solid ${item.color}25`,
              borderRadius: 12, padding: '14px 20px', minWidth: 110,
            }}>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 15, fontWeight: 900, color: item.color, marginBottom: 6, letterSpacing: 1 }}>{item.value}</div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#4a6070', letterSpacing: 2 }}>{item.label}</div>
            </div>
          ))}
        </div>

        {/* Rarity preview strip */}
        <div style={{
          width: '100%', maxWidth: 480,
          background: 'linear-gradient(135deg, #0d1520, #0a1018)',
          border: '1px solid #1e3050', borderRadius: 14,
          padding: '18px 22px', marginBottom: 40,
          animation: 'fadeUp 0.5s ease 0.35s both',
        }}>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 3, marginBottom: 14, textTransform: 'uppercase' }}>
            ✨ Rarity Distribution
          </div>
          {/* Bar */}
          <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', display: 'flex', marginBottom: 14, border: '1px solid rgba(255,255,255,.05)' }}>
            {RARITY_TIERS.map(tier => (
              <div key={tier.label} style={{ width: `${(tier.count / 88) * 100}%`, background: tier.color }} />
            ))}
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {RARITY_TIERS.map(tier => (
              <div key={tier.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: tier.color, boxShadow: `0 0 6px ${tier.color}` }} />
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: tier.color, letterSpacing: 1 }}>{tier.count}</span>
                <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#4a6070', letterSpacing: 1 }}>{tier.emoji} {tier.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Dual-token notice */}
        <div style={{
          width: '100%', maxWidth: 480,
          display: 'flex', gap: 10, alignItems: 'flex-start',
          padding: '14px 18px',
          background: 'rgba(0,212,255,0.04)', border: '1px solid rgba(0,212,255,0.12)',
          borderRadius: 12, marginBottom: 40,
          animation: 'fadeUp 0.5s ease 0.4s both',
        }}>
          <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>ℹ️</span>
          <span style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#4a6070', lineHeight: 1.7, textAlign: 'left' }}>
            Minting will require both <span style={{ color: '#ff8c00' }}>XNT</span> and <span style={{ color: '#bf5af2' }}>BRAINS</span> tokens, processed in a single transaction on the X1 blockchain.
          </span>
        </div>

        {/* Back button */}
        <button
          onClick={() => navigate('/')}
          style={{
            fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700, letterSpacing: 3,
            color: '#ff8c00', background: 'rgba(255,140,0,0.08)', border: '1px solid rgba(255,140,0,0.3)',
            borderRadius: 10, padding: '13px 32px', cursor: 'pointer', textTransform: 'uppercase',
            transition: 'all 0.2s', animation: 'fadeUp 0.5s ease 0.45s both',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.background = 'rgba(255,140,0,0.15)';
            el.style.borderColor = 'rgba(255,140,0,0.6)';
            el.style.transform = 'translateY(-2px)';
            el.style.boxShadow = '0 6px 24px rgba(255,140,0,0.2)';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.background = 'rgba(255,140,0,0.08)';
            el.style.borderColor = 'rgba(255,140,0,0.3)';
            el.style.transform = 'translateY(0)';
            el.style.boxShadow = 'none';
          }}
        >
          ← BACK TO HOME
        </button>

        <Footer />
      </div>
    </div>
  );
};

export default MintLabWork;