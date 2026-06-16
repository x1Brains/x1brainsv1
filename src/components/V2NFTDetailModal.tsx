// V2 NFT detail modal — replaces the v1 LBComponents.NFTDetailModal.
//
// Uses V2NFTImage for image loading (Solaris cache + proxy fallback chain)
// so images that work on the marketplace grid will also work here.
// Aesthetic matches v2: orange accent, gray/neutral chrome, no purple,
// thin orange hairline, gradient top accent.

import { FC, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import V2NFTImage from './V2NFTImage';
import type { NFTData } from './LBComponents';
import { fetchNFTMeta } from './LBComponents';
import { fetchSolarisNft } from '../lib/solarisIndexer';
import { upsertNftMetadata } from '../lib/supabase';

const ACCENT = '#f29030';
const TEXT   = 'var(--text-primary)';
const MUTED  = 'var(--text-muted)';
const DIM    = 'var(--text-faint)';
const LINE   = 'rgba(242,144,48,0.13)';
const GRAY_BG = 'rgba(138,154,184,0.04)';
const GRAY_BD = 'rgba(138,154,184,0.12)';

const mono = {
  fontFamily: 'Orbitron, monospace',
  fontVariantNumeric: 'tabular-nums' as const,
};

function rarityColor(r: string): string {
  const l = r.toLowerCase();
  if (l.includes('legendary')) return '#ffd700';
  if (l.includes('epic'))      return '#ffaa00';
  if (l.includes('rare'))      return '#f29030';
  if (l.includes('uncommon'))  return '#ffba66';
  return '#cdd8e2';
}

type Props = {
  nft: NFTData;
  isMobile: boolean;
  onClose: () => void;
  /** Connected wallet owns this NFT and it has no active listing.        */
  onListThis?: (nft: NFTData) => void;
  /** Connected wallet does NOT own this NFT and there's an active listing. */
  onBuyThis?:  (nft: NFTData) => void;
  /** Connected wallet owns this AND it has an active listing.            */
  onEditPrice?:(nft: NFTData) => void;
  onDelist?:   (nft: NFTData) => void;
  onBoost?:    (nft: NFTData) => void;
};

const V2NFTDetailModal: FC<Props> = ({
  nft, isMobile, onClose,
  onListThis, onBuyThis, onEditPrice, onDelist, onBoost,
}) => {
  const [copied, setCopied] = useState(false);
  const imgUri = nft.image || nft.metaUri || nft.logoUri;

  // Grid listings often arrive without attributes — fetch them on open so the
  // trait grid + rarity pill populate. Source priority, mirroring v1's modal:
  //   1. the NFT's own metaUri JSON (authoritative per-edition attributes, e.g.
  //      Brains Elites' 11 traits: Art Type, Tier, Edition, Citizenship, …)
  //   2. the Solaris indexer's traits (for NFTs whose metaUri is unreachable)
  const [fetchedAttrs, setFetchedAttrs] = useState<{ trait_type: string; value: string }[] | null>(null);
  const [fetchedSite,  setFetchedSite]  = useState<string | null>(null);
  useEffect(() => {
    const haveAttrs = !!(nft.attributes && nft.attributes.length > 0);
    const haveSite  = !!nft.externalUrl;
    if (haveAttrs && haveSite) { setFetchedAttrs(null); setFetchedSite(null); return; }
    let alive = true;
    const norm = (a: any[]) => a
      .map((x: any) => ({
        trait_type: String(x?.trait_type ?? x?.traitType ?? '').trim(),
        value:      String(x?.value ?? x?.trait_value ?? '').trim(),
      }))
      .filter((x: { trait_type: string; value: string }) => x.trait_type && x.value);

    // Fire BOTH sources in PARALLEL (was sequential — fetchNFTMeta's 3s timeout
    // blocked Solaris). The metaUri JSON is authoritative; Solaris is the fast,
    // pre-indexed fallback. We take whichever yields traits first.
    const metaSrc = nft.metaUri || nft.logoUri;
    const metaP = metaSrc
      ? fetchNFTMeta(metaSrc).then((j: any) => j ? {
          attrs: Array.isArray(j.attributes) ? norm(j.attributes) : [],
          site:  (j.external_url ?? j.external_link ?? null) as string | null,
        } : null).catch(() => null)
      : Promise.resolve(null);
    const solP = fetchSolarisNft(nft.mint).then(s => s?.attributes ?? []).catch(() => []);

    // SITE link comes only from the metaUri JSON — set it whenever that lands.
    if (!haveSite) metaP.then(m => { if (alive && m?.site) setFetchedSite(m.site); });

    if (!haveAttrs) (async () => {
      // Resolve with the FIRST source that has traits; empty sources never settle
      // the race, and a final all-settled branch yields null if neither has any.
      const never = new Promise<never>(() => {});
      const winner = await Promise.race([
        metaP.then(m => (m?.attrs?.length ? m.attrs : never)),
        solP.then(a => (a.length ? a : never)),
        Promise.all([metaP, solP]).then(([m, a]) => (m?.attrs?.length ? m!.attrs : (a.length ? a : null))),
      ]).catch(() => null);
      if (alive && winner && winner.length) {
        setFetchedAttrs(winner);
        // Write-through to the shared indexer so the grid + other visitors get
        // these traits instantly next time (no re-fetch).
        upsertNftMetadata([{
          mint: nft.mint, name: nft.name, symbol: nft.symbol,
          image: nft.image, description: nft.description,
          externalUrl: nft.externalUrl, collection: nft.collection,
          attributes: winner,
        }]).catch(() => {});
      }
    })();
    return () => { alive = false; };
  }, [nft.mint, nft.metaUri, nft.logoUri, nft.attributes, nft.externalUrl]);

  const effectiveAttrs = (nft.attributes && nft.attributes.length > 0) ? nft.attributes : (fetchedAttrs ?? []);
  const siteUrl = nft.externalUrl || fetchedSite || '';
  // Rarity = first trait whose name is a rarity synonym (rarity / tier / grade),
  // so collections that label it "Tier" (Brains Elites) still get the ★ ribbon.
  const RARITY_KEYS = ['rarity', 'tier', 'grade'];
  const rarity = effectiveAttrs.find(a => RARITY_KEYS.includes((a.trait_type ?? '').toLowerCase().trim()))?.value ?? '';

  // Lock body scroll + esc-to-close
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
      window.removeEventListener('keydown', fn);
    };
  }, [onClose]);

  const copyMint = () => {
    navigator.clipboard.writeText(nft.mint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Attribute pills ──────────────────────────────────────────
  const attrs = effectiveAttrs.filter(a => a?.trait_type && a?.value != null);

  // ── Shared button styles ─────────────────────────────────────
  const btnPrimary: React.CSSProperties = {
    ...mono,
    flex: 1, padding: '10px 0', textAlign: 'center',
    background: ACCENT, color: '#0a0e14',
    border: 'none', borderRadius: 6,
    cursor: 'pointer', textDecoration: 'none',
    fontSize: 10, fontWeight: 800, letterSpacing: 1.5,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  const btnGhost: React.CSSProperties = {
    ...mono,
    flex: 1, padding: '10px 0', textAlign: 'center',
    background: 'rgba(242,144,48,0.06)', color: ACCENT,
    border: `1px solid ${ACCENT}55`,
    borderRadius: 6, cursor: 'pointer', textDecoration: 'none',
    fontSize: 10, fontWeight: 800, letterSpacing: 1.5,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,.88)',
        backdropFilter: 'blur(14px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: isMobile ? '0 10px' : 20,
        animation: 'v2nm-fade .18s ease both',
      }}
    >
      <style>{`
        @keyframes v2nm-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes v2nm-slide {
          from { opacity: 0; transform: translateY(20px) scale(.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .v2nm-info::-webkit-scrollbar { width: 0; height: 0; }
        .v2nm-info { scrollbar-width: none; }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: isMobile ? '96%' : 720,
          maxHeight: isMobile ? 'calc(100dvh - 90px)' : '90vh',
          background: 'linear-gradient(155deg, #0c121c, #06090d)',
          border: `1px solid ${ACCENT}55`,
          borderRadius: 16,
          boxShadow: `0 0 60px ${ACCENT}1a, 0 32px 80px rgba(0,0,0,.9)`,
          animation: 'v2nm-slide .22s cubic-bezier(.22,1,.36,1) both',
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          // Stack on phones: full-width image on top, scrollable info below.
          flexDirection: isMobile ? 'column' : 'row',
        }}
      >
        {/* Top accent line */}
        <div style={{
          position: 'absolute', top: 0, left: '10%', right: '10%', height: 1, zIndex: 3,
          background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`,
          pointerEvents: 'none',
        }} />

        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          style={{
            position: 'absolute', top: 10, right: 10, zIndex: 20,
            width: 30, height: 30, borderRadius: '50%',
            border: `1px solid ${ACCENT}55`,
            background: 'rgba(8,12,15,.9)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, color: ACCENT,
          }}
        >×</button>

        {/* ── Image panel (left on desktop · top on mobile) ── */}
        <div style={{
          position: 'relative',
          width: isMobile ? '100%' : 300,
          height: isMobile ? 240 : 'auto',
          flexShrink: 0,
          background: 'linear-gradient(155deg, #060a0e, #0a0e14)',
          borderRadius: isMobile ? '15px 15px 0 0' : '15px 0 0 15px',
          overflow: 'hidden',
          minHeight: isMobile ? 240 : 440,
        }}>
          <V2NFTImage src={imgUri} name={nft.name} />
          {/* NFT pill */}
          <div style={{
            ...mono,
            position: 'absolute', top: 10, left: 10,
            background: 'rgba(0,0,0,.78)',
            border: `1px solid ${ACCENT}55`,
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 8, color: ACCENT, fontWeight: 800, letterSpacing: 1.5,
          }}>NFT</div>
        </div>

        {/* ── Info panel (right) ── */}
        <div
          className="v2nm-info"
          style={{
            flex: 1, minWidth: 0, minHeight: 0,
            overflowY: 'auto',
            padding: isMobile ? '12px 14px 14px' : '24px 26px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: isMobile ? 8 : 14,
          }}
        >
          {/* Name + collection + pills */}
          <div style={{ paddingRight: 36 }}>
            <div style={{
              ...mono,
              fontSize: isMobile ? 13 : 20, fontWeight: 900, color: TEXT,
              letterSpacing: 0.5, lineHeight: 1.2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {nft.name || 'Unnamed NFT'}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              {nft.collection && (
                <span style={{
                  fontFamily: 'Sora, sans-serif',
                  fontSize: isMobile ? 9 : 11, color: MUTED,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: 200,
                }}>{nft.collection}</span>
              )}
              {nft.symbol && (
                <span style={{
                  ...mono,
                  fontSize: 7, color: ACCENT,
                  background: `${ACCENT}10`, border: `1px solid ${ACCENT}40`,
                  padding: '2px 7px', borderRadius: 3, letterSpacing: 1,
                }}>{nft.symbol}</span>
              )}
              <span style={{
                ...mono,
                fontSize: 7, color: DIM,
                background: GRAY_BG, border: `1px solid ${GRAY_BD}`,
                padding: '2px 7px', borderRadius: 3, letterSpacing: 1,
              }}>{nft.isToken2022 ? 'TOKEN-2022' : 'SPL'}</span>
            </div>
          </div>

          {/* Description */}
          {nft.description && (
            <div style={{
              fontFamily: 'Sora, sans-serif',
              fontSize: 11, color: MUTED,
              lineHeight: 1.6,
            }}>
              {nft.description.length > 240
                ? nft.description.slice(0, 240) + '…'
                : nft.description}
            </div>
          )}

          {/* Traits — inline label:value pills (v1 layout, v2 colors). Wraps,
              so the same render works on desktop and mobile. */}
          {attrs.length > 0 && (
            <div>
              <div style={{
                ...mono,
                fontSize: 8, color: DIM, letterSpacing: 2,
                marginBottom: 8, fontWeight: 700,
              }}>
                TRAITS — {attrs.length}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {attrs.map((a, i) => {
                  const tt = (a.trait_type ?? '').toLowerCase().trim();
                  const isRarity = RARITY_KEYS.some(k => tt.includes(k));
                  const rc = rarityColor(String(a.value));
                  return (
                    <span key={i} style={{
                      display: 'inline-flex', alignItems: 'baseline', gap: 5,
                      maxWidth: '100%',
                      background: isRarity ? `${rc}14` : GRAY_BG,
                      border: `1px solid ${isRarity ? `${rc}55` : GRAY_BD}`,
                      borderRadius: 7, padding: '5px 9px',
                    }}>
                      <span style={{
                        ...mono,
                        fontSize: 8, color: DIM, letterSpacing: 0.3,
                        textTransform: 'uppercase', flexShrink: 0,
                      }}>{a.trait_type}</span>
                      <span style={{
                        ...mono,
                        fontSize: 10.5, color: isRarity ? rc : TEXT, fontWeight: 800,
                        letterSpacing: 0.2,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{String(a.value)}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Mint row */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: GRAY_BG,
            border: `1px solid ${GRAY_BD}`,
            borderRadius: 7,
            padding: '8px 10px',
          }}>
            <span style={{
              ...mono,
              fontSize: 7, color: DIM, letterSpacing: 1.5,
              fontWeight: 700, flexShrink: 0,
            }}>MINT</span>
            <code style={{
              flex: 1, fontFamily: 'monospace', fontSize: isMobile ? 8 : 10, color: TEXT,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {isMobile
                ? `${nft.mint.slice(0, 6)}…${nft.mint.slice(-5)}`
                : `${nft.mint.slice(0, 16)}…${nft.mint.slice(-10)}`}
            </code>
            <button
              type="button"
              onClick={copyMint}
              style={{
                ...mono,
                flexShrink: 0, padding: '4px 10px', borderRadius: 4,
                cursor: 'pointer', border: 'none',
                background: copied ? 'rgba(0,201,141,.18)' : 'rgba(242,144,48,.1)',
                color: copied ? 'var(--neon-green, #00c98d)' : ACCENT,
                fontSize: 8, fontWeight: 800, letterSpacing: 1,
              }}
            >{copied ? '✓ COPIED' : 'COPY'}</button>
          </div>

          {/* Spec strip */}
          {!isMobile && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 6,
            }}>
              {[
                { l: 'CHAIN', v: 'X1 SVM' },
                { l: 'STD',   v: nft.isToken2022 ? 'T-2022' : 'SPL' },
                { l: 'DEC',   v: String(nft.decimals) },
                { l: 'BAL',   v: String(nft.balance) },
              ].map(({ l, v }) => (
                <div key={l} style={{
                  background: GRAY_BG,
                  border: `1px solid ${GRAY_BD}`,
                  borderRadius: 6,
                  padding: '6px 8px', textAlign: 'center',
                }}>
                  <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1.2, marginBottom: 2 }}>{l}</div>
                  <div style={{ ...mono, fontSize: 11, fontWeight: 700, color: TEXT }}>{v}</div>
                </div>
              ))}
            </div>
          )}

          {/* CTA row */}
          <div style={{
            display: 'flex', gap: 8,
            marginTop: 'auto', paddingTop: 4,
          }}>
            <a
              href={`https://explorer.mainnet.x1.xyz/address/${nft.mint}`}
              target="_blank" rel="noopener noreferrer"
              style={btnGhost}
            >EXPLORER ↗</a>
            {siteUrl && (
              <a
                href={siteUrl}
                target="_blank" rel="noopener noreferrer"
                style={btnGhost}
              >SITE ↗</a>
            )}
            {/* Context-aware action(s). Render the buttons appropriate to the
                NFT's current state — never offer LIST when it's already listed,
                never offer BUY when it's mine, etc. */}
            {onBuyThis && (
              <button
                type="button"
                onClick={() => { onClose(); onBuyThis(nft); }}
                style={btnPrimary}
              >BUY</button>
            )}
            {onListThis && (
              <button
                type="button"
                onClick={() => { onClose(); onListThis(nft); }}
                style={btnPrimary}
              >LIST FOR SALE</button>
            )}
            {onBoost && (
              <button
                type="button"
                onClick={() => { onClose(); onBoost(nft); }}
                style={{ ...btnGhost, color: '#bf5af2', borderColor: 'rgba(191,90,242,0.35)' }}
              >⚡ BOOST</button>
            )}
            {onEditPrice && (
              <button
                type="button"
                onClick={() => { onClose(); onEditPrice(nft); }}
                style={{ ...btnGhost, color: '#00d4ff', borderColor: 'rgba(0,212,255,0.35)' }}
              >✏ EDIT PRICE</button>
            )}
            {onDelist && (
              <button
                type="button"
                onClick={() => { onClose(); onDelist(nft); }}
                style={{ ...btnGhost, color: '#ff4466', borderColor: 'rgba(255,68,102,0.35)' }}
              >✕ DELIST</button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default V2NFTDetailModal;
