// ═════════════════════════════════════════════════════════════════════════════
// NFA CONSENT MODAL (v2) — one-time legal gate, v2-styled & compact
// ═════════════════════════════════════════════════════════════════════════════
// Blocks the page on first visit, caches acceptance in localStorage, and logs
// every acceptance to Supabase (`nfa_acceptances`: version, page, wallet,
// user_agent). Bump NFA_VERSION / the storage key to re-prompt everyone.

import { FC, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { supabase } from '../lib/supabase';
import { BRAINS_LOGO } from '../constants';

const NFA_STORAGE_KEY = 'x1brainsv2.nfa.accepted.v2';
const NFA_VERSION = '2.0';

const ORANGE = '#ff8c00';
const AMBER  = '#ffb700';

interface NfaRecord { version: string; anon: boolean; wallets: string[]; }

function readRecord(): NfaRecord {
  try {
    const raw = localStorage.getItem(NFA_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as NfaRecord;
      if (p?.version === NFA_VERSION && Array.isArray(p.wallets)) {
        return { version: p.version, anon: !!p.anon, wallets: p.wallets };
      }
    }
  } catch {}
  return { version: NFA_VERSION, anon: false, wallets: [] };
}

// Per-wallet gate: every connected wallet must accept once (so each wallet is
// tracked in Supabase). With NO wallet connected, a one-time browser
// acceptance (`anon`) lets people read the landing without connecting.
function isAcceptedFor(rec: NfaRecord, wallet: string | null): boolean {
  return wallet ? rec.wallets.includes(wallet) : rec.anon;
}

const V2NfaConsent: FC = () => {
  const { publicKey } = useWallet();
  const walletKey = publicKey?.toBase58() ?? null;
  const [record, setRecord] = useState<NfaRecord>(readRecord);
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const location = useLocation();

  const accepted = isAcceptedFor(record, walletKey);

  // Fresh checkbox each time the gate re-opens for a new wallet.
  useEffect(() => { if (!accepted) setAgreed(false); }, [walletKey, accepted]);

  // Lock background scroll while the gate is open.
  useEffect(() => {
    if (accepted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [accepted]);

  if (accepted) return null;

  const handleAccept = async () => {
    if (!agreed || submitting) return;
    setSubmitting(true);
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 1024) : '';
    const wallet = walletKey;
    const path = (location?.pathname || '/').toLowerCase();
    const page = path === '/' || path === '' ? 'home' : path.replace(/^\/+/, '').split('/')[0].slice(0, 64);
    // One Supabase row per accepting wallet.
    if (supabase) {
      try { await supabase.from('nfa_acceptances').insert({ version: NFA_VERSION, page, wallet, user_agent: ua }); }
      catch { /* best-effort */ }
    }
    const next: NfaRecord = {
      version: NFA_VERSION,
      anon: true, // any acceptance covers no-wallet browsing + disconnect
      wallets: wallet && !record.wallets.includes(wallet) ? [...record.wallets, wallet] : record.wallets,
    };
    try { localStorage.setItem(NFA_STORAGE_KEY, JSON.stringify(next)); } catch {}
    setRecord(next);
    setSubmitting(false);
  };

  // Condensed legal points — the essence, one line each.
  const points: string[] = [
    'Experimental, unaudited DeFi on X1. Smart-contract bugs can cause partial or total loss of funds.',
    'Crypto is volatile — you can lose 100% of anything you stake, pair, list, or trade.',
    'Nothing here is investment, financial, legal, or tax advice. Provided "AS IS" — always DYOR.',
    'No guarantees of uptime, security, or yield. No refunds or insurance for any loss.',
    'You alone secure your wallet, keys & seed phrase. We never take custody of your assets.',
    'Using this site must be legal where you are — you confirm that it is.',
  ];

  return (
    <div
      role="dialog" aria-modal="true" aria-labelledby="nfa-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(4,7,12,.9)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 14, animation: 'v2nfaFade .26s ease both',
      }}
    >
      <style>{`
        @keyframes v2nfaFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes v2nfaSlide { from { opacity: 0; transform: translateY(14px) scale(.975) } to { opacity: 1; transform: translateY(0) scale(1) } }
        .v2nfa-card::-webkit-scrollbar { width: 3px }
        .v2nfa-card::-webkit-scrollbar-thumb { background: rgba(255,140,0,.3); border-radius: 2px }
      `}</style>

      <div
        className="v2nfa-card"
        style={{
          position: 'relative', width: '100%', maxWidth: 460,
          maxHeight: '90dvh', overflow: 'hidden auto', borderRadius: 14,
          border: '1px solid rgba(255,140,0,.28)',
          background: `
            radial-gradient(120% 70% at 0% 0%, rgba(255,140,0,.045), transparent 46%),
            radial-gradient(120% 70% at 100% 0%, rgba(255,183,0,.03), transparent 46%),
            linear-gradient(160deg, #0c121c, #070b11)`,
          // Keep the gradient inside the border so it can't bleed past the
          // rounded corners; overflow-hidden(x) clips the top accent bar too.
          backgroundClip: 'padding-box',
          boxShadow: '0 0 30px rgba(255,140,0,.05), 0 24px 60px rgba(0,0,0,.7)',
          padding: '20px 20px 16px',
          animation: 'v2nfaSlide .3s cubic-bezier(.22,1,.36,1) both',
        }}
      >
        {/* top accent bar */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2.5, borderRadius: '14px 14px 0 0', background: `linear-gradient(90deg, ${ORANGE}, ${AMBER})`, pointerEvents: 'none' }} />

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 13 }}>
          <div style={{
            width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
            border: `1px solid ${ORANGE}66`, boxShadow: '0 0 6px rgba(255,140,0,.14)', background: '#0a0e15',
          }}>
            <img src={BRAINS_LOGO} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <h2 id="nfa-title" style={{
            margin: 0, fontFamily: 'Orbitron, monospace', fontSize: 16, fontWeight: 900, letterSpacing: 1,
            textTransform: 'uppercase',
            background: `linear-gradient(110deg, ${ORANGE} 40%, ${AMBER})`,
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          }}>Not Financial Advice</h2>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 1.5, color: '#5c7a90' }}>X1 BRAINS · v{NFA_VERSION}</span>
        </div>

        {/* Condensed points */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {points.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontFamily: 'Sora, sans-serif', fontSize: 11, lineHeight: 1.4, color: '#b8c8d4' }}>
              <span style={{ color: i % 2 ? AMBER : ORANGE, fontFamily: 'Orbitron, monospace', fontSize: 10, lineHeight: 1.5, flexShrink: 0 }}>▸</span>
              <span>{t}</span>
            </div>
          ))}
        </div>

        {/* Security & audits — teal accent so it reads as the reassurance, still NFA */}
        <div style={{
          marginTop: 13, padding: '9px 11px', borderRadius: 9,
          background: 'rgba(0,207,198,.06)', border: '1px solid rgba(0,207,198,.2)',
          fontFamily: 'Sora, sans-serif', fontSize: 10, lineHeight: 1.5, color: '#aedbd7',
        }}>
          <span style={{ color: '#00cfc6', fontWeight: 700, letterSpacing: 1 }}>◆ AUDITED · </span>
          Multiple internal &amp; AI-assisted security + exploit reviews of the on-chain programs and this app found
          <strong style={{ color: '#eafffd' }}> no backdoors, hidden mints, drains, or rug vectors</strong> (checked math · PDA authorities · hard caps · pause guards).
          <span style={{ color: '#7ea7a3' }}> Not a 3rd-party audit, no guarantee — DYOR.</span>
        </div>

        {/* Checkbox */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 13, cursor: 'pointer', fontFamily: 'Sora, sans-serif', fontSize: 11, lineHeight: 1.4, color: '#cdd9e3', userSelect: 'none' }}>
          <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}
            style={{ width: 16, height: 16, marginTop: 1, flexShrink: 0, cursor: 'pointer', accentColor: ORANGE }} />
          <span>I have read and accept the above. I use this site at my own risk and waive any claim against X1 Brains for losses.</span>
        </label>

        {/* Action */}
        <button
          type="button" onClick={handleAccept} disabled={!agreed || submitting}
          style={{
            display: 'block', width: '100%', marginTop: 14, padding: '12px 20px', borderRadius: 9,
            fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 900, letterSpacing: 1.5, textTransform: 'uppercase',
            color: agreed ? '#06090d' : '#5c7a90',
            background: agreed ? `linear-gradient(110deg, ${ORANGE}, ${AMBER})` : 'rgba(255,255,255,.04)',
            border: agreed ? 'none' : '1px solid rgba(255,255,255,.08)',
            cursor: agreed && !submitting ? 'pointer' : 'not-allowed',
            opacity: submitting ? 0.7 : 1,
            boxShadow: agreed ? '0 0 14px rgba(255,140,0,.2)' : 'none',
            transition: 'all .15s',
          }}
        >
          {submitting ? 'Recording…' : agreed ? '✓ I Accept · Enter' : 'Check the box to continue'}
        </button>

        <div style={{ marginTop: 9, textAlign: 'center', fontFamily: 'Orbitron, monospace', fontSize: 7, letterSpacing: 1.2, color: 'rgba(255,255,255,.26)' }}>
          Acceptance logged · timestamp + version + wallet
        </div>
      </div>
    </div>
  );
};

export default V2NfaConsent;
