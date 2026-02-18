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
}> = ({ icon, title, description, route, color, accentColor, delay = 0, locked = false, isNew = false, badge }) => {
  const navigate = useNavigate();
  const { connected } = useWallet();

  const canNavigate = !locked || connected;

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
        opacity: locked && !connected ? 0.7 : 1,
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
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent, ${color}, transparent)`, opacity: 0.6 }} />

      {/* Ambient glow */}
      <div style={{ position: 'absolute', top: -40, right: -40, width: 120, height: 120, borderRadius: '50%', background: `radial-gradient(circle, ${color}12 0%, transparent 70%)`, pointerEvents: 'none' }} />

      {/* NEW badge */}
      {isNew && (
        <div style={{
          position: 'absolute', top: 14, right: 14,
          background: `linear-gradient(135deg, ${color}, ${color}bb)`,
          color: '#0a0e14', fontFamily: 'Orbitron, monospace',
          fontSize: 8, fontWeight: 900, letterSpacing: 2,
          padding: '3px 10px', borderRadius: 6,
        }}>NEW</div>
      )}

      {/* Icon */}
      <div style={{ fontSize: 40, marginBottom: 18, display: 'block', filter: `drop-shadow(0 0 12px ${color}60)` }}>
        {icon}
      </div>

      {/* Title */}
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, letterSpacing: 3, color: accentColor, marginBottom: 10, textTransform: 'uppercase' }}>
        {title}
      </div>

      {/* Description */}
      <p style={{ fontSize: 13, color: '#7a9ab8', lineHeight: 1.7, marginBottom: 16 }}>
        {description}
      </p>

      {/* Optional info badge */}
      {badge && (
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
        {locked && !connected ? (
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

          <p style={{ fontFamily: 'Sora, sans-serif', fontSize: 16, color: '#7a9ab8', lineHeight: 1.7, maxWidth: 500, margin: '0 auto 36px' }}>
            The premier X1 blockchain hub — track your portfolio, mint the exclusive Lab Work NFT collection, and navigate the X1 ecosystem.
          </p>

          {/* Stat pills */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 36 }}>
            <StatPill label="MAINNET"  value="X1"        color="#00c98d" />
            <StatPill label="NFTS"     value="88"         color="#ff8c00" />
            <StatPill label="TOKENS"   value="SPL + T22"  color="#00d4ff" />
            <StatPill label="MINT"     value="0.88 XNT"   color="#bf5af2" />
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
          <FeatureCard
            icon="💼"
            title="Portfolio"
            description="Track your XNT balance, SPL tokens, and Token-2022 assets in real time. Full on-chain metadata from X1 RPC — Metaplex and Token-2022 extensions."
            route="/portfolio"
            color="#00d4ff"
            accentColor="#00d4ff"
            delay={0.1}
            locked={true}
          />
          <FeatureCard
            icon="🧠"
            title="Lab Work"
            description="Explore the 88 unique X1 Brains NFT collection. View rarity rankings, neural power stats, trait attributes, and full metadata for each Brain."
            route="/lab-work"
            color="#ff8c00"
            accentColor="#ffb700"
            delay={0.2}
            locked={true}
          />
          <FeatureCard
            icon="🔬"
            title="Mint NFT"
            description="Mint your exclusive X1 Brains Lab Work NFT. Only 88 will ever exist across 5 rarity tiers — from Common to Legendary. Each Brain is unique."
            route="/mint"
            color="#bf5af2"
            accentColor="#bf5af2"
            delay={0.3}
            locked={false}
            isNew={true}
            badge="88 TOTAL · 0.88 XNT"
          />
        </div>

        {/* ── RARITY PREVIEW STRIP ── */}
        <div style={{
          background: 'linear-gradient(135deg, #0d1520, #0a1018)',
          border: '1px solid rgba(191,90,242,0.2)', borderRadius: 14,
          padding: '18px 24px', marginBottom: 20,
          animation: 'fadeUp 0.5s ease 0.35s both',
          cursor: 'pointer',
        }}
          onClick={() => window.location.assign('/mint')}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(191,90,242,0.5)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(191,90,242,0.2)'; }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#bf5af2', letterSpacing: 3, textTransform: 'uppercase', fontWeight: 700 }}>🔬 Collection Rarity</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {[
                { label: 'LEGENDARY', color: '#ff4444', count: 4  },
                { label: 'EPIC',      color: '#bf5af2', count: 12 },
                { label: 'RARE',      color: '#00d4ff', count: 24 },
                { label: 'UNCOMMON',  color: '#00c98d', count: 28 },
                { label: 'COMMON',    color: '#ff8c00', count: 20 },
              ].map(tier => (
                <div key={tier.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: tier.color, boxShadow: `0 0 6px ${tier.color}` }} />
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: tier.color, letterSpacing: 1 }}>{tier.count}</span>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#4a6070', letterSpacing: 1 }}>{tier.label}</span>
                </div>
              ))}
            </div>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#bf5af2', letterSpacing: 1 }}>MINT NOW →</span>
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
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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
