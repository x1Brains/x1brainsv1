import React, { FC, useState, useEffect } from 'react';
import { RARITY_TIERS, NFT_TOTAL_SUPPLY } from '../constants';
import { RarityTier } from '../utils';

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────
export interface NFTAttribute {
  trait_type: string;
  value: string;
  rarity: number;
}

export interface NFTData {
  id: number;
  mint: string;
  name: string;
  description: string;
  image: string;
  attributes: NFTAttribute[];
  powerStats: Record<string, number>;
  rarityScore: number;
  rarityTier: RarityTier;
  rank: number;
  collection: string;
  supply: number;
}

// ─────────────────────────────────────────────
// RARITY BADGE
// ─────────────────────────────────────────────
export const RarityBadge: FC<{ tier: RarityTier; size?: 'xs' | 'sm' | 'md' | 'lg' }> = ({ tier, size = 'sm' }) => {
  const sizes = {
    xs: { fontSize: 7,  padding: '1px 5px',  letterSpacing: 1   },
    sm: { fontSize: 8,  padding: '2px 7px',  letterSpacing: 1.2 },
    md: { fontSize: 10, padding: '4px 10px', letterSpacing: 1.5 },
    lg: { fontSize: 13, padding: '6px 14px', letterSpacing: 2   },
  };
  const s = sizes[size];
  return (
    <span style={{
      fontFamily: 'Orbitron, monospace', fontWeight: 700,
      color: tier.color, background: tier.bg,
      border: `1px solid ${tier.border}`,
      borderRadius: 4, fontSize: s.fontSize,
      padding: s.padding, letterSpacing: s.letterSpacing,
      textTransform: 'uppercase', flexShrink: 0,
    }}>{tier.label}</span>
  );
};

// ─────────────────────────────────────────────
// POWER STAT BAR
// ─────────────────────────────────────────────
export const StatBar: FC<{ label: string; value: number; color?: string; delay?: number }> = ({
  label, value, color = '#ff8c00', delay = 0,
}) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#6a8ea8', letterSpacing: 1.5, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color, fontWeight: 700 }}>{value}</span>
    </div>
    <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${value}%`,
        background: `linear-gradient(90deg, ${color}80, ${color})`,
        borderRadius: 2, boxShadow: `0 0 8px ${color}60`,
        transition: `width 0.8s ease ${delay}s`,
      }} />
    </div>
  </div>
);

// ─────────────────────────────────────────────
// ATTRIBUTE CHIP
// ─────────────────────────────────────────────
export const AttributeChip: FC<NFTAttribute & { delay?: number }> = ({ trait_type, value, rarity, delay = 0 }) => {
  const rarityColor =
    rarity >= 80 ? '#ff4444' :
    rarity >= 60 ? '#bf5af2' :
    rarity >= 45 ? '#00d4ff' :
    rarity >= 25 ? '#00c98d' : '#ff8c00';

  return (
    <div style={{
      background: 'linear-gradient(135deg, #0d1520, #111820)',
      border: '1px solid rgba(255,140,0,0.15)',
      borderRadius: 8, padding: '10px 12px',
      animation: `fadeUp 0.3s ease ${delay}s both`,
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: rarityColor, borderRadius: '3px 0 0 3px' }} />
      <div style={{ paddingLeft: 8 }}>
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#5c7a90', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>{trait_type}</div>
        <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 13, color: '#d4e0ec', fontWeight: 600, marginBottom: 5 }}>{value}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ flex: 1, height: 2, background: 'rgba(255,255,255,0.05)', borderRadius: 1, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${rarity}%`, background: rarityColor, borderRadius: 1, boxShadow: `0 0 6px ${rarityColor}80` }} />
          </div>
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: rarityColor, fontWeight: 700 }}>{rarity}%</span>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// RARITY DISTRIBUTION BAR
// ─────────────────────────────────────────────
export const RarityDistribution: FC<{ nfts: NFTData[] }> = ({ nfts }) => {
  const counts: Record<string, number> = {};
  Object.keys(RARITY_TIERS).forEach(k => { counts[k] = 0; });
  nfts.forEach(n => {
    const key = Object.keys(RARITY_TIERS).find(k => (RARITY_TIERS as any)[k] === n.rarityTier);
    if (key) counts[key]++;
  });

  return (
    <div style={{ background: '#0d1520', border: '1px solid #1e3050', borderRadius: 10, padding: '16px 20px', marginBottom: 24 }}>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 3, marginBottom: 14, textTransform: 'uppercase' }}>
        Collection Rarity Distribution
      </div>
      <div style={{ display: 'flex', gap: 1, height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 12 }}>
        {Object.entries(RARITY_TIERS).reverse().map(([key, tier]) => {
          const pct = nfts.length ? (counts[key] / nfts.length) * 100 : 0;
          return (
            <div key={key} style={{ height: '100%', width: `${pct}%`, background: tier.color, boxShadow: `0 0 8px ${tier.glow}60` }}
              title={`${tier.label}: ${counts[key]}`} />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {Object.entries(RARITY_TIERS).map(([key, tier]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: tier.color }} />
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: tier.color, letterSpacing: 1 }}>
              {tier.label} ({counts[key]})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// NFT GRID CARD
// ─────────────────────────────────────────────
export const NFTCard: FC<{
  nft: NFTData;
  onClick: (nft: NFTData) => void;
  delay?: number;
}> = ({ nft, onClick, delay = 0 }) => {
  const tier = nft.rarityTier;
  const [imgError, setImgError] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="nft-card"
      onClick={() => onClick(nft)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        background: hovered ? `linear-gradient(135deg, ${tier.bg}, rgba(8,12,15,0.8))` : 'linear-gradient(135deg, #0d1520, #080c0f)',
        border: `1px solid ${hovered ? tier.border : '#1a2840'}`,
        borderRadius: 12, overflow: 'hidden', cursor: 'pointer',
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        transform: hovered ? 'translateY(-4px) scale(1.01)' : 'translateY(0) scale(1)',
        boxShadow: hovered ? `0 12px 40px rgba(0,0,0,0.6), 0 0 20px ${tier.glow}25` : 'none',
        animation: `fadeUp 0.4s ease ${delay}s both`,
      }}
    >
      <div className="nft-card-shimmer" />

      {/* Top accent line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: hovered ? `linear-gradient(90deg, transparent, ${tier.color}, transparent)` : `linear-gradient(90deg, transparent, ${tier.color}40, transparent)`, transition: 'all 0.3s', zIndex: 2 }} />

      {/* Rank — top left */}
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 4, background: 'rgba(8,12,15,0.88)', border: `1px solid ${tier.border}`, borderRadius: 6, padding: '3px 8px', backdropFilter: 'blur(8px)' }}>
        <span style={{ fontSize: 8, color: tier.color, fontFamily: 'Orbitron, monospace' }}>#{String(nft.rank).padStart(2, '0')}</span>
      </div>

      {/* Rarity — top right */}
      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 4 }}>
        <RarityBadge tier={tier} size="xs" />
      </div>

      {/* Image */}
      <div style={{ aspectRatio: '1', position: 'relative', background: `linear-gradient(135deg, ${tier.bg}, rgba(8,12,15,0.6))`, overflow: 'hidden' }}>
        {!imgError ? (
          <img src={nft.image} alt={nft.name} onError={() => setImgError(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transition: 'transform 0.4s ease', transform: hovered ? 'scale(1.05)' : 'scale(1)' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48, color: tier.color }}>🧠</div>
        )}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '40%', background: 'linear-gradient(transparent, rgba(8,12,15,0.85))' }} />
      </div>

      {/* Footer */}
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color: hovered ? tier.color : '#c8d8e8', marginBottom: 6, transition: 'color 0.2s', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {nft.name}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#ffb700', letterSpacing: 1 }}>SCORE {nft.rarityScore}</span>
          <span style={{ color: '#1e3050', fontSize: 8 }}>|</span>
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#5c7a90', letterSpacing: 1 }}>{nft.attributes.length} TRAITS</span>
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// NFT LIST ROW
// ─────────────────────────────────────────────
export const NFTListRow: FC<{
  nft: NFTData;
  onClick: (nft: NFTData) => void;
  delay?: number;
}> = ({ nft, onClick, delay = 0 }) => {
  const tier = nft.rarityTier;
  const [imgError, setImgError] = useState(false);

  return (
    <div
      onClick={() => onClick(nft)}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        background: 'linear-gradient(135deg, #0d1520, #080c0f)',
        border: '1px solid #1a2840', borderRadius: 10,
        padding: '10px 16px', cursor: 'pointer',
        transition: 'all 0.2s',
        animation: `fadeUp 0.3s ease ${Math.min(delay, 0.5)}s both`,
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = tier.border;
        el.style.background = `linear-gradient(135deg, ${tier.bg}, #080c0f)`;
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = '#1a2840';
        el.style.background = 'linear-gradient(135deg, #0d1520, #080c0f)';
      }}
    >
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#4a6070', width: 28, flexShrink: 0 }}>
        #{nft.rank}
      </div>
      <div style={{ width: 44, height: 44, borderRadius: 8, overflow: 'hidden', flexShrink: 0, border: `1px solid ${tier.border}` }}>
        {!imgError ? (
          <img src={nft.image} alt={nft.name} onError={() => setImgError(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, background: '#0d1520' }}>🧠</div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color: '#c8d8e8', marginBottom: 3 }}>{nft.name}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <RarityBadge tier={tier} size="xs" />
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#5c7a90' }}>SCORE {nft.rarityScore}</span>
        </div>
      </div>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#4a6070', flexShrink: 0 }}>VIEW →</div>
    </div>
  );
};

// ─────────────────────────────────────────────
// NFT DETAIL MODAL
// ─────────────────────────────────────────────
export const NFTModal: FC<{ nft: NFTData; onClose: () => void }> = ({ nft, onClose }) => {
  const tier = nft.rarityTier;
  const [imgError, setImgError] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyMint = () => {
    navigator.clipboard.writeText(nft.mint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const STAT_COLORS: Record<string, string> = {
    Intelligence: '#ff8c00', Computation: '#00d4ff',
    Network: '#00c98d', Stealth: '#bf5af2', Energy: '#ffb700',
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(4,7,11,0.92)', backdropFilter: 'blur(16px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, animation: 'fadeIn 0.2s ease both' }}
    >
      <div className="modal-scroll" style={{
        background: 'linear-gradient(145deg, #0d1520 0%, #080c0f 60%, #0a1218 100%)',
        border: `1px solid ${tier.border}`, borderRadius: 16,
        width: '100%', maxWidth: 860, maxHeight: '92vh', overflowY: 'auto',
        boxShadow: `0 0 0 1px ${tier.border}, 0 40px 80px rgba(0,0,0,0.8), 0 0 60px ${tier.glow}20`,
        animation: 'modal-in 0.3s ease both', position: 'relative',
      }}>
        {/* Scanline */}
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', borderRadius: 16, zIndex: 0 }}>
          <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: `linear-gradient(90deg, transparent, ${tier.color}40, transparent)`, animation: 'scanline 4s linear infinite' }} />
        </div>

        {/* Close */}
        <button onClick={onClose}
          style={{ position: 'absolute', top: 16, right: 16, zIndex: 10, background: 'rgba(255,255,255,0.06)', border: '1px solid #1e3050', borderRadius: 8, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#8aa0b8', fontSize: 14, transition: 'all 0.2s' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,140,0,0.1)'; (e.currentTarget as HTMLButtonElement).style.color = '#ff8c00'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; (e.currentTarget as HTMLButtonElement).style.color = '#8aa0b8'; }}
        >✕</button>

        {/* Content grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 360px) 1fr', gap: 0, position: 'relative', zIndex: 1 }}>

          {/* LEFT — image panel */}
          <div style={{ padding: 28, borderRight: `1px solid ${tier.border}`, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: `2px solid ${tier.border}`, boxShadow: `0 0 30px ${tier.glow}30`, aspectRatio: '1' }}>
              {!imgError ? (
                <img src={nft.image} alt={nft.name} onError={() => setImgError(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
              ) : (
                <div style={{ width: '100%', aspectRatio: '1', background: `linear-gradient(135deg, ${tier.bg}, rgba(8,12,15,0.9))`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 64 }}>🧠</div>
              )}
              {/* Rank/score overlay */}
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(8,12,15,0.9))', padding: '20px 14px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 2, marginBottom: 2 }}>RANK</div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 22, fontWeight: 900, color: tier.color, textShadow: `0 0 20px ${tier.glow}`, animation: 'rank-glow 2s ease infinite' }}>#{nft.rank}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 2, marginBottom: 2 }}>SCORE</div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 18, fontWeight: 700, color: '#ffb700' }}>{nft.rarityScore}</div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <RarityBadge tier={tier} size="md" />
            </div>

            {/* Collection info */}
            <div style={{ background: 'rgba(255,140,0,0.04)', border: '1px solid rgba(255,140,0,0.12)', borderRadius: 8, padding: '12px 14px' }}>
              {[
                { label: 'COLLECTION', value: 'LAB WORK',  color: '#ff8c00' },
                { label: 'SUPPLY',     value: `${NFT_TOTAL_SUPPLY} UNIQUE`, color: '#00d4ff' },
                { label: 'CHAIN',      value: 'X1 MAINNET', color: '#00c98d' },
              ].map((row, i) => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: i < 2 ? 8 : 0 }}>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 2 }}>{row.label}</span>
                  <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: row.color, letterSpacing: 1 }}>{row.value}</span>
                </div>
              ))}
            </div>

            {/* Mint address */}
            <div style={{ background: '#0d1520', border: '1px solid #1e3050', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#5c7a90', letterSpacing: 2, marginBottom: 6 }}>MINT ADDRESS</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontFamily: 'Sora, monospace', fontSize: 9, color: '#5c7a90', flex: 1 }}>
                  {nft.mint.slice(0, 12)}…{nft.mint.slice(-6)}
                </span>
                <button onClick={copyMint}
                  style={{ background: copied ? 'rgba(0,201,141,0.2)' : 'rgba(255,140,0,0.15)', border: `1px solid ${copied ? 'rgba(0,201,141,0.4)' : 'rgba(255,140,0,0.3)'}`, color: copied ? '#00c98d' : '#ff8c00', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 9, fontFamily: 'Orbitron, monospace', transition: 'all 0.2s', flexShrink: 0 }}
                >{copied ? '✓ COPIED' : 'COPY'}</button>
              </div>
            </div>
          </div>

          {/* RIGHT — details panel */}
          <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 3, marginBottom: 8 }}>X1 BRAINS LAB WORK</div>
              <h2 style={{ fontFamily: 'Orbitron, monospace', fontSize: 26, fontWeight: 900, background: `linear-gradient(135deg, ${tier.color}, #ffb700)`, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', margin: '0 0 10px' }}>
                {nft.name}
              </h2>
              <p style={{ fontSize: 12, color: '#8aa0b8', lineHeight: 1.7 }}>{nft.description}</p>
            </div>

            <div style={{ height: 1, background: `linear-gradient(to right, ${tier.border}, transparent)` }} />

            {/* Power stats */}
            <div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#ff8c00', letterSpacing: 3, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                ⚡ NEURAL POWER STATS
                <div style={{ flex: 1, height: 1, background: 'linear-gradient(to right, rgba(255,140,0,0.3), transparent)' }} />
              </div>
              {Object.entries(nft.powerStats).map(([stat, val], i) => (
                <StatBar key={stat} label={stat} value={val as number} color={STAT_COLORS[stat] || '#ff8c00'} delay={i * 0.08} />
              ))}
            </div>

            <div style={{ height: 1, background: 'linear-gradient(to right, rgba(255,255,255,0.05), transparent)' }} />

            {/* Attributes */}
            <div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#00d4ff', letterSpacing: 3, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                🔬 ATTRIBUTES &amp; RARITY
                <div style={{ flex: 1, height: 1, background: 'linear-gradient(to right, rgba(0,212,255,0.3), transparent)' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {nft.attributes.map((attr, i) => (
                  <AttributeChip key={attr.trait_type} {...attr} delay={i * 0.05} />
                ))}
              </div>
            </div>

            {/* Rarity summary */}
            <div style={{ background: `linear-gradient(135deg, rgba(255,140,0,0.05), rgba(0,212,255,0.03))`, border: `1px solid ${tier.border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {[
                { label: 'RARITY RANK',  value: `#${nft.rank} / ${NFT_TOTAL_SUPPLY}`, color: tier.color },
                { label: 'RARITY SCORE', value: nft.rarityScore,                        color: '#ffb700' },
                { label: 'TIER',         value: tier.label,                              color: tier.color },
              ].map(item => (
                <div key={item.label} style={{ textAlign: 'center', flex: 1, minWidth: 80 }}>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 700, color: item.color, textShadow: `0 0 15px ${item.color}60`, marginBottom: 4 }}>{item.value}</div>
                  <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: '#5c7a90', letterSpacing: 2, textTransform: 'uppercase' }}>{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
