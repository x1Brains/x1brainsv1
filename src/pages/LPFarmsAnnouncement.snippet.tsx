{/* ══════════════════════════════════════════════════════════════════════ */}
{/* LP FARMS ANNOUNCEMENT                                                   */}
{/* Paste this block AFTER the 4 stat cards grid and BEFORE the            */}
{/* "── MODE SWITCHER ──" comment in PairingMarketplace.tsx.               */}
{/* Also add the `farm-glow` keyframe to globalStyles.ts (see below).      */}
{/* ══════════════════════════════════════════════════════════════════════ */}
<div
  onClick={() => window.location.href = '/lpfarms'}
  style={{
    position: 'relative',
    marginTop: isMobile ? 24 : 36,
    marginBottom: isMobile ? 24 : 36,
    padding: isMobile ? '22px 18px' : '28px 32px',
    borderRadius: 18,
    background: 'linear-gradient(135deg, rgba(255,140,0,0.12) 0%, rgba(255,183,0,0.06) 40%, rgba(0,212,255,0.08) 100%)',
    border: '2px solid rgba(255,140,0,0.4)',
    cursor: 'pointer',
    overflow: 'hidden',
    transition: 'all 0.25s cubic-bezier(.22,1,.36,1)',
    animation: 'fadeUp 0.5s ease 0.28s both, farm-glow 2.5s ease-in-out infinite',
    boxShadow: '0 0 24px rgba(255,140,0,0.2), inset 0 1px 0 rgba(255,183,0,0.2)',
  }}
  onMouseEnter={e => {
    (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,140,0,0.75)';
    (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-3px) scale(1.01)';
    (e.currentTarget as HTMLDivElement).style.boxShadow = '0 12px 40px rgba(255,140,0,0.35), inset 0 1px 0 rgba(255,183,0,0.3)';
  }}
  onMouseLeave={e => {
    (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,140,0,0.4)';
    (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0) scale(1)';
    (e.currentTarget as HTMLDivElement).style.boxShadow = '0 0 24px rgba(255,140,0,0.2), inset 0 1px 0 rgba(255,183,0,0.2)';
  }}
>
  {/* Glowing orbs */}
  <div style={{ position: 'absolute', top: -60, right: -60, width: 240, height: 240,
    borderRadius: '50%', background: '#ff8c00', opacity: 0.18, filter: 'blur(60px)', pointerEvents: 'none' }} />
  <div style={{ position: 'absolute', bottom: -40, left: '30%', width: 160, height: 160,
    borderRadius: '50%', background: '#00d4ff', opacity: 0.12, filter: 'blur(50px)', pointerEvents: 'none' }} />

  {/* Shimmer accent line on top */}
  <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3,
    background: 'linear-gradient(90deg, transparent 0%, #ff8c00 20%, #ffb700 50%, #ff8c00 80%, transparent 100%)',
    backgroundSize: '200% 100%', animation: 'shimmer 3s linear infinite',
    boxShadow: '0 0 16px rgba(255,140,0,.7)' }} />

  {/* Pulsing NEW badge */}
  <div style={{ position: 'absolute', top: 14, left: 14, padding: '4px 11px', borderRadius: 6,
    background: 'linear-gradient(135deg, #ff8c00, #ff4400)', color: '#0a0e14',
    fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 900, letterSpacing: 2,
    boxShadow: '0 2px 12px rgba(255,140,0,.6)', animation: 'pulse-orange 1.8s ease-in-out infinite',
    zIndex: 2 }}>
    ✦ NEW
  </div>

  <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 14 : 24,
    position: 'relative', zIndex: 1, flexDirection: isMobile ? 'column' : 'row',
    paddingTop: isMobile ? 20 : 8 }}>

    {/* Icon */}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      width: isMobile ? 72 : 96, height: isMobile ? 72 : 96, borderRadius: 20,
      background: 'linear-gradient(135deg, rgba(255,140,0,.25), rgba(255,140,0,.05))',
      border: '2px solid rgba(255,140,0,.5)', fontSize: isMobile ? 42 : 56,
      boxShadow: '0 4px 24px rgba(255,140,0,.3)', animation: 'float 3s ease-in-out infinite' }}>
      🌾
    </div>

    {/* Copy */}
    <div style={{ flex: 1, minWidth: 0, textAlign: isMobile ? 'center' : 'left' }}>
      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 20 : 28,
        fontWeight: 900, letterSpacing: isMobile ? 1.5 : 3, marginBottom: 6,
        background: 'linear-gradient(90deg, #ff8c00, #ffb700, #ff8c00)', backgroundSize: '200% auto',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
        animation: 'shimmer 4s linear infinite' }}>
        LP FARMS ARE LIVE
      </div>
      <div style={{ fontFamily: 'Sora,sans-serif', fontSize: isMobile ? 12 : 14,
        color: '#d4e0ec', lineHeight: 1.5, marginBottom: 10, fontWeight: 500 }}>
        Stake BRAINS/XNT or LB/XNT LP tokens. Lock 30 / 90 / 365 days.
        Earn up to <span style={{ color: '#ff8c00', fontWeight: 900 }}>8× boosted rewards</span>.
      </div>
      <div style={{ display: 'flex', gap: isMobile ? 6 : 10, flexWrap: 'wrap',
        justifyContent: isMobile ? 'center' : 'flex-start' }}>
        {[
          { label: '30 DAYS · 2×',  color: '#00d4ff' },
          { label: '90 DAYS · 4×',  color: '#00c98d' },
          { label: '365 DAYS · 8×', color: '#ff8c00' },
        ].map(chip => (
          <span key={chip.label} style={{ fontFamily: 'Orbitron,monospace', fontSize: 9,
            fontWeight: 900, letterSpacing: 1.5, padding: '5px 11px', borderRadius: 6,
            color: chip.color, background: `${chip.color}15`, border: `1px solid ${chip.color}44` }}>
            {chip.label}
          </span>
        ))}
      </div>
    </div>

    {/* CTA */}
    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: isMobile ? 11 : 13,
      fontWeight: 900, letterSpacing: 2, padding: isMobile ? '12px 22px' : '16px 28px',
      borderRadius: 12, color: '#0a0e14',
      background: 'linear-gradient(135deg, #ff8c00, #ffb700)',
      whiteSpace: 'nowrap', flexShrink: 0,
      boxShadow: '0 4px 20px rgba(255,140,0,.5)', border: '1px solid rgba(255,183,0,.8)' }}>
      STAKE NOW →
    </div>
  </div>
</div>

{/* ══════════════════════════════════════════════════════════════════════ */}
{/* ADD THIS KEYFRAME TO globalStyles.ts (inside GLOBAL_CSS, in the        */}
{/* animations block near @keyframes pulse-orange):                         */}
{/*                                                                         */}
{/* @keyframes farm-glow {                                                  */}
{/*   0%, 100% {                                                            */}
{/*     box-shadow: 0 0 24px rgba(255,140,0,0.2),                          */}
{/*                 inset 0 1px 0 rgba(255,183,0,0.2);                      */}
{/*   }                                                                     */}
{/*   50% {                                                                 */}
{/*     box-shadow: 0 0 40px rgba(255,140,0,0.4),                          */}
{/*                 inset 0 1px 0 rgba(255,183,0,0.3);                      */}
{/*   }                                                                     */}
{/* }                                                                       */}
{/* ══════════════════════════════════════════════════════════════════════ */}
