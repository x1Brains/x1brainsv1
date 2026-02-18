import React, { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAINS_LOGO } from '../constants';
import { TopBar, PageBackground, Footer } from '../components/UI';

// ─────────────────────────────────────────────
// LAB WORK — UNDER DEVELOPMENT
// ─────────────────────────────────────────────
const LabWork: FC = () => {
  const navigate = useNavigate();

  return (
    <div style={{ minHeight: '100vh', background: '#080c0f', padding: '80px 16px 40px', position: 'relative', overflow: 'hidden' }}>
      <TopBar />
      <PageBackground />

      {/* Purple ambient glow */}
      <div style={{ position: 'fixed', top: '40%', left: '50%', transform: 'translate(-50%,-50%)', width: 800, height: 800, borderRadius: '50%', background: 'radial-gradient(circle, rgba(191,90,242,0.04) 0%, transparent 60%)', pointerEvents: 'none', zIndex: 0 }} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 700, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 160px)', textAlign: 'center' }}>

        {/* Spinning logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 36, animation: 'fadeUp 0.5s ease both' }}>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', inset: -10, borderRadius: '50%', background: 'conic-gradient(from 0deg, #ff8c00, #ffb700, #bf5af2, #00d4ff, #ff8c00)', animation: 'spin 8s linear infinite', opacity: 0.4 }} />
            <div style={{ position: 'absolute', inset: -20, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,140,0,0.12) 0%, transparent 70%)', animation: 'pulse-orange 3s ease infinite' }} />
            <img
              src={BRAINS_LOGO}
              alt="X1 Brains"
              style={{ position: 'relative', zIndex: 1, width: 120, height: 120, borderRadius: '50%', objectFit: 'cover', border: '3px solid #0a0e14', filter: 'grayscale(30%)' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        </div>

        {/* Eyebrow */}
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5c7a90', letterSpacing: 6, marginBottom: 16, textTransform: 'uppercase', animation: 'fadeUp 0.5s ease 0.1s both' }}>
          X1 BRAINS · NFT COLLECTION
        </div>

        {/* Title */}
        <h1 style={{
          fontFamily: 'Orbitron, monospace', fontSize: 42, fontWeight: 900, letterSpacing: 6,
          background: 'linear-gradient(135deg, #ff8c00 0%, #ffb700 40%, #bf5af2 70%, #00d4ff 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          margin: '0 0 12px', textTransform: 'uppercase', lineHeight: 1.1,
          animation: 'fadeUp 0.5s ease 0.15s both',
        }}>
          LAB WORK
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
          The X1 Brains Lab Work NFT Marketplace is being forged. 88 unique neural intelligence nodes are being develpoved to be revealed on the X1 blockchain.
        </p>

        {/* Info tiles */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 44, animation: 'fadeUp 0.5s ease 0.3s both' }}>
          {[
            { label: 'TOTAL SUPPLY', value: '88',        color: '#ff8c00' },
            { label: 'BLOCKCHAIN',   value: 'X1',         color: '#00d4ff' },
            { label: 'MINT PRICE',   value: '0.88 XNT',   color: '#bf5af2' },
            { label: 'RARITY TIERS', value: '5',          color: '#00c98d' },
          ].map(item => (
            <div key={item.label} style={{
              background: 'linear-gradient(135deg, #0d1520, #0a1018)',
              border: `1px solid ${item.color}25`,
              borderRadius: 12, padding: '14px 20px', minWidth: 100,
            }}>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 18, fontWeight: 900, color: item.color, marginBottom: 6, letterSpacing: 2 }}>{item.value}</div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#4a6070', letterSpacing: 2 }}>{item.label}</div>
            </div>
          ))}
        </div>

        {/* Back button */}
        <button
          onClick={() => navigate('/')}
          style={{
            fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700, letterSpacing: 3,
            color: '#ff8c00', background: 'rgba(255,140,0,0.08)', border: '1px solid rgba(255,140,0,0.3)',
            borderRadius: 10, padding: '13px 32px', cursor: 'pointer', textTransform: 'uppercase',
            transition: 'all 0.2s', animation: 'fadeUp 0.5s ease 0.35s both',
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

export default LabWork;