// V2BoostModal — burn-BRAINS-to-boost a listing on the labwork carousel.
// Same Supabase contract as v1 (labwork_boosts + labwork_points tables) so the
// existing 3-slot featured carousel keeps working unchanged. V2 aesthetic —
// orange primary, glass card, same modal frame as V2MarketModal / V2FarmModal.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  createBurnCheckedInstruction,
} from '@solana/spl-token';
import V2NFTImage from './V2NFTImage';
import { fmtNum, shortAddr } from '../utils/v2format';
import { supabase } from '../lib/supabase';
import { BRAINS_MINT, LB_MINT } from '../constants';

export type BoostTierId = 'spark' | 'godslayer' | 'incinerator';

// Site-wide cap on simultaneously-active boosts (the featured carousel slots).
// Single source of truth — gates loadActiveBoosts(), the modal's slot check,
// and the V2Home carousel (which renders straight off loadActiveBoosts()).
export const BOOST_SLOTS = 8;

export type BoostCurrency = 'BRAINS' | 'LB';

export const BOOST_TIERS: readonly { id: BoostTierId; label: string; brains: number; lb: number; days: number; desc: string }[] = [
  { id: 'spark',       label: '⚡ SPARK',       brains: 200, lb: 0.05, days: 1, desc: '24 hours spotlight' },
  { id: 'godslayer',   label: '⚔️ GODSLAYER',  brains: 444, lb: 1,    days: 3, desc: '3 days of dominance' },
  { id: 'incinerator', label: '🔥 INCINERATOR', brains: 888, lb: 1.11, days: 7, desc: '7 days, maximum burn' },
] as const;

export interface BoostRecord {
  id?:            string;
  listing_pda:    string;
  nft_mint:       string;
  seller:         string;
  tier:           BoostTierId;
  brains:         number;
  labwork_points: number;
  tx_sig:         string;
  expires_at:     string;
  created_at?:    string;
}

export async function loadActiveBoosts(): Promise<BoostRecord[]> {
  if (!supabase) {
    console.warn('[boosts] supabase client not configured');
    return [];
  }
  try {
    const { data, error } = await supabase
      .from('labwork_boosts')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('tier',       { ascending: false })
      .order('created_at', { ascending: true })
      .limit(BOOST_SLOTS);
    if (error) {
      console.warn('[boosts] loadActiveBoosts failed:', error.message);
      return [];
    }
    return (data ?? []) as BoostRecord[];
  } catch (e) {
    console.warn('[boosts] loadActiveBoosts threw:', e);
    return [];
  }
}

// Both writes now return success/error so the modal can surface failures
// instead of silently celebrating a burn that didn't actually register the
// boost. (Old behavior: catch {} → modal shows "✅ Boost active" even when
// the labwork_boosts insert was rejected by RLS / column mismatch / etc.)
async function saveBoost(b: Omit<BoostRecord, 'id' | 'created_at'>): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase not configured' };
  try {
    const { error } = await supabase.from('labwork_boosts').upsert(b, { onConflict: 'listing_pda' });
    if (error) { console.warn('[boosts] saveBoost rejected:', error); return { ok: false, error: error.message }; }
    return { ok: true };
  } catch (e: any) {
    console.warn('[boosts] saveBoost threw:', e);
    return { ok: false, error: e?.message ?? 'write failed' };
  }
}

async function saveLabworkPoints(p: {
  wallet: string; brains_burned: number; points: number;
  source: string; tier: string; tx_sig: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase not configured' };
  try {
    const { error } = await supabase.from('labwork_points').upsert({
      wallet:        p.wallet,
      brains_burned: p.brains_burned,
      points:        p.points,
      source:        p.source,
      tier:          p.tier,
      tx_sig:        p.tx_sig,
      earned_at:     new Date().toISOString(),
    }, { onConflict: 'tx_sig' });
    if (error) { console.warn('[boosts] saveLabworkPoints rejected:', error); return { ok: false, error: error.message }; }
    return { ok: true };
  } catch (e: any) {
    console.warn('[boosts] saveLabworkPoints threw:', e);
    return { ok: false, error: e?.message ?? 'write failed' };
  }
}

const ACCENT = '#ff8c00';
const TEXT   = '#cdd8e2';
const MUTED  = '#8aaac8';
const DIM    = '#5c7a90';

export type BoostTarget = {
  listingPda:    string;
  nftMint:       string;
  priceLamports: number;
  name:          string;
  image?:        string;
  metaUri?:      string;
};

type Props = {
  target:  BoostTarget | null;
  onClose: () => void;
  onDone:  () => void;
};

export default function V2BoostModal({ target, onClose, onDone }: Props) {
  const { connection } = useConnection();
  const { publicKey, signTransaction } = useWallet();

  const [tier,      setTier]      = useState<BoostTierId>('spark');
  const [cur,       setCur]       = useState<BoostCurrency>('BRAINS');
  const [status,    setStatus]    = useState('');
  const [pending,   setPending]   = useState(false);
  const [sig,       setSig]       = useState('');
  const [balance,   setBalance]   = useState<number | null>(null);   // BRAINS
  const [lbBalance, setLbBalance] = useState<number | null>(null);   // LB
  const [slotsUsed, setSlotsUsed] = useState<number | null>(null);

  // Reset whenever target changes (so reopening a different listing is clean)
  useEffect(() => {
    setTier('spark'); setCur('BRAINS'); setStatus(''); setPending(false); setSig('');
    setBalance(null); setLbBalance(null); setSlotsUsed(null);
  }, [target?.listingPda]);

  // Esc-to-close (idle only)
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [pending, onClose]);

  // Pull BRAINS balance + current slot occupancy as soon as the modal opens.
  useEffect(() => {
    if (!target || !publicKey) return;
    let alive = true;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(BRAINS_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID);
        const acc = await connection.getParsedAccountInfo(ata);
        const bal = (acc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (alive) setBalance(bal);
      } catch { if (alive) setBalance(0); }
      try {
        const lbAta = getAssociatedTokenAddressSync(new PublicKey(LB_MINT), publicKey, false, TOKEN_2022_PROGRAM_ID);
        const lacc  = await connection.getParsedAccountInfo(lbAta);
        const lbal  = (lacc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (alive) setLbBalance(lbal);
      } catch { if (alive) setLbBalance(0); }
      try {
        const active = await loadActiveBoosts();
        if (alive) setSlotsUsed(active.length);
      } catch { if (alive) setSlotsUsed(0); }
    })();
    return () => { alive = false; };
  }, [target?.listingPda, publicKey, connection]);

  if (!target) return null;

  const selected   = BOOST_TIERS.find(t => t.id === tier)!;
  const isLb        = cur === 'LB';
  const amount      = isLb ? selected.lb : selected.brains;
  const curMint     = isLb ? LB_MINT : BRAINS_MINT;
  const bal         = isLb ? lbBalance : balance;
  const amountLabel = isLb ? `${amount} LB` : `${amount.toLocaleString()} BRAINS`;
  const canAfford  = bal !== null && bal >= amount;
  const slotsAvail = slotsUsed !== null && slotsUsed < BOOST_SLOTS;
  const slotsLoading = slotsUsed === null;
  // Points are tier-based (same boost regardless of which token paid for it).
  const labworkPts = Math.round(selected.brains * 1.888 * 100) / 100;
  const priceXnt   = target.priceLamports / 1e9;

  const run = async () => {
    if (!publicKey || !signTransaction || !canAfford) return;
    if (!slotsAvail) {
      setStatus(`❌ All ${BOOST_SLOTS} featured slots are taken. Wait for an active boost to expire.`);
      return;
    }
    // Guard BEFORE burning: the burn is irreversible, but the Supabase write is
    // the only thing that surfaces the boost. If Supabase isn't reachable, refuse
    // to burn — otherwise the citizen destroys BRAINS for nothing.
    if (!supabase) {
      setStatus('⚠️ Boost recording is offline (Supabase not configured). Burning now would destroy your tokens without registering the boost — burn blocked. Contact admin or try again later.');
      return;
    }
    setPending(true); setStatus('Preparing burn…'); setSig('');
    try {
      const mintPk   = new PublicKey(curMint);
      const mintInfo = await getMint(connection, mintPk, 'confirmed', TOKEN_2022_PROGRAM_ID);
      const decimals = mintInfo.decimals;
      const burnRaw  = BigInt(Math.round(amount * 10 ** decimals));
      const fromAta  = getAssociatedTokenAddressSync(mintPk, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const burnIx = createBurnCheckedInstruction(
        fromAta, mintPk, publicKey, burnRaw, decimals, [], TOKEN_2022_PROGRAM_ID,
      );
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(burnIx);

      setStatus('Awaiting wallet approval…');
      const signed = await signTransaction(tx);
      const txSig  = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
      });
      setSig(txSig);

      setStatus('Confirming burn…');
      for (let i = 0; i < 30; i++) {
        if (i) await new Promise(r => setTimeout(r, 500));
        const s = await connection.getSignatureStatus(txSig, { searchTransactionHistory: true });
        if (s?.value?.err) throw new Error('On-chain error: ' + JSON.stringify(s.value.err));
        const conf = s?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') break;
      }

      const expiresAt = new Date(Date.now() + selected.days * 86_400_000).toISOString();

      setStatus('Recording boost in Supabase…');
      const [boostRes, ptsRes] = await Promise.all([
        saveBoost({
          listing_pda:    target.listingPda,
          nft_mint:       target.nftMint,
          seller:         publicKey.toBase58(),
          tier,
          brains:         selected.brains,
          labwork_points: labworkPts,
          tx_sig:         txSig,
          expires_at:     expiresAt,
        }),
        saveLabworkPoints({
          wallet:        publicKey.toBase58(),
          brains_burned: selected.brains,
          points:        labworkPts,
          source:        isLb ? 'boost-lb' : 'boost',
          tier,
          tx_sig:        txSig,
        }),
      ]);

      // Surface DB write failures explicitly — the burn already settled
      // on-chain, but if the boost didn't land in Supabase the landing
      // carousel won't pick it up. We want the citizen to know.
      if (!boostRes.ok) {
        setStatus(`⚠️ Burn confirmed, but boost record FAILED: ${boostRes.error}. ${amountLabel} were burned but the listing won't appear in the spotlight. Contact admin.`);
        return;
      }
      if (!ptsRes.ok) {
        // Points failure is non-fatal for the showcase — show a softer warning.
        setStatus(`✅ Boost active · ${amountLabel} burned · ${selected.days}d featured. (Labwork points record failed: ${ptsRes.error})`);
        setTimeout(() => { onDone(); onClose(); }, 4000);
        return;
      }

      setStatus(`✅ Boost active · ${amountLabel} burned · +${labworkPts.toLocaleString()} labwork pts · ${selected.days}d featured`);
      setTimeout(() => { onDone(); onClose(); }, 2200);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0, 140) ?? 'Boost failed'}`);
    } finally { setPending(false); }
  };

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
          width: '100%', maxWidth: 460,
          maxHeight: '92dvh', overflowY: 'auto',
          background: 'linear-gradient(155deg,#0c1520,#080c0f)',
          border: `1px solid ${ACCENT}55`,
          borderRadius: 16, padding: '24px 22px',
          boxShadow: `0 0 60px ${ACCENT}1a, 0 32px 80px rgba(0,0,0,.9)`,
          position: 'relative',
        }}
      >
        <div style={{
          position: 'absolute', top: 0, left: '10%', right: '10%', height: 1,
          background: `linear-gradient(90deg,transparent,${ACCENT},transparent)`,
        }} />

        <button
          onClick={onClose}
          disabled={pending}
          style={{
            position: 'absolute', top: 10, right: 10,
            width: 28, height: 28, borderRadius: '50%',
            border: `1px solid ${ACCENT}40`, background: 'rgba(8,12,15,.9)',
            cursor: pending ? 'not-allowed' : 'pointer',
            color: ACCENT, fontSize: 16,
          }}
        >×</button>

        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900,
            color: '#fff', marginBottom: 4, letterSpacing: 1,
          }}>
            🔥 BURN TO BOOST
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: MUTED }}>
            {slotsLoading
              ? 'Checking available slots…'
              : slotsAvail
                ? `Burn BRAINS · earn 1.888 pts/BRAINS · ${BOOST_SLOTS - slotsUsed!} slot${BOOST_SLOTS - slotsUsed! !== 1 ? 's' : ''} available`
                : `⚠️ All ${BOOST_SLOTS} featured slots are full — wait for an active boost to expire`}
          </div>
        </div>

        {/* NFT preview */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16,
          padding: '10px 12px', background: 'rgba(255,255,255,.03)',
          borderRadius: 10, border: '1px solid rgba(255,255,255,.06)',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 8, overflow: 'hidden',
            flexShrink: 0, background: 'rgba(0,0,0,.3)', position: 'relative',
          }}>
            <V2NFTImage src={target.image || target.metaUri} name={target.name} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700,
              color: '#e0f0ff', overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', marginBottom: 4,
            }}>
              {target.name}
            </div>
            <div style={{
              fontFamily: 'Orbitron,monospace', fontSize: 9, color: DIM, letterSpacing: 1,
            }}>
              {shortAddr(target.nftMint, 5, 5)} · {fmtNum(priceXnt, 4)} XNT listed
            </div>
          </div>
          {bal !== null && (
            <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: ACCENT }}>
                {isLb ? fmtNum(bal, 2) : fmtNum(bal, 0)}
              </div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: DIM, letterSpacing: 1 }}>
                {cur}
              </div>
            </div>
          )}
        </div>

        {/* Currency toggle — pay with BRAINS or LB */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {(['BRAINS', 'LB'] as BoostCurrency[]).map(c => {
            const on = cur === c;
            const cbal = c === 'LB' ? lbBalance : balance;
            return (
              <button
                key={c} type="button" disabled={pending}
                onClick={() => setCur(c)}
                style={{
                  flex: 1, padding: '7px 0', borderRadius: 8,
                  background: on ? `${ACCENT}1a` : 'rgba(255,255,255,.03)',
                  border: `1px solid ${on ? `${ACCENT}66` : 'rgba(255,255,255,.08)'}`,
                  color: on ? ACCENT : MUTED, cursor: pending ? 'not-allowed' : 'pointer',
                  fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 800, letterSpacing: 1,
                }}
              >
                {c}{cbal !== null ? ` · ${c === 'LB' ? fmtNum(cbal, 2) : fmtNum(cbal, 0)}` : ''}
              </button>
            );
          })}
        </div>

        {/* Tier selector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {BOOST_TIERS.map(t => {
            const active = tier === t.id;
            const afford = bal !== null && bal >= (isLb ? t.lb : t.brains);
            const pts    = Math.round(t.brains * 1.888);
            return (
              <button
                key={t.id} type="button"
                onClick={() => afford && !pending && setTier(t.id)}
                disabled={!afford || pending}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px',
                  background: active ? `${ACCENT}1a` : 'rgba(255,255,255,.03)',
                  border: `1px solid ${active ? `${ACCENT}66` : 'rgba(255,255,255,.08)'}`,
                  borderRadius: 9, cursor: afford ? 'pointer' : 'not-allowed',
                  opacity: afford ? 1 : 0.45,
                  textAlign: 'left' as const, width: '100%',
                }}
              >
                <div style={{
                  fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 800,
                  color: active ? ACCENT : TEXT, letterSpacing: 1, minWidth: 130,
                }}>
                  {t.label}
                </div>
                <div style={{ flex: 1, fontFamily: 'Sora,sans-serif', fontSize: 10, color: MUTED }}>
                  {t.desc}
                </div>
                <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700, color: ACCENT }}>
                    {isLb ? `${t.lb} LB` : `${t.brains.toLocaleString()} BRAINS`}
                  </div>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: DIM, letterSpacing: 1, marginTop: 1 }}>
                    +{pts.toLocaleString()} PTS
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {status && (
          <div style={{
            margin: '4px 0 12px', padding: '8px 12px',
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
                  style={{ color: ACCENT, fontSize: 10 }}
                >
                  View tx ↗
                </a>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button" onClick={onClose} disabled={pending}
            style={{
              flex: 1, padding: '11px 0',
              background: 'rgba(255,255,255,.04)',
              border: '1px solid rgba(255,255,255,.1)',
              borderRadius: 8, cursor: pending ? 'not-allowed' : 'pointer',
              fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
              color: '#9abacf', letterSpacing: 1.5,
            }}
          >
            CANCEL
          </button>
          <button
            type="button" onClick={run}
            disabled={pending || !canAfford || !slotsAvail || !publicKey}
            style={{
              flex: 2, padding: '11px 0',
              background: pending
                ? 'rgba(255,255,255,.04)'
                : `linear-gradient(135deg, ${ACCENT}33, ${ACCENT}11)`,
              border: `1px solid ${ACCENT}80`,
              borderRadius: 8, cursor: pending ? 'not-allowed' : 'pointer',
              fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
              color: ACCENT, letterSpacing: 1.5,
              opacity: pending ? 0.6 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {pending && (
              <span style={{
                width: 12, height: 12, borderRadius: '50%',
                border: `2px solid ${ACCENT}33`,
                borderTop: `2px solid ${ACCENT}`,
                animation: 'spin 0.8s linear infinite',
              }} />
            )}
            {pending ? 'WORKING…' : `BURN ${amountLabel}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
