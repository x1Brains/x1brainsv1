import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import V2NFTImage from './V2NFTImage';
import { executeList, executeBuy, executeCancel, eliteProofAccounts } from '../lib/marketIx';
import { fmtNum, shortAddr } from '../utils/v2format';
import { SALE_FEE_NUMERATOR, SALE_FEE_DENOMINATOR } from '../constants';

export type MarketAction = 'buy' | 'list' | 'cancel' | 'updatePrice';

export type MarketTarget = {
  action:       MarketAction;
  mint:         string;
  name:         string;
  image?:       string;
  metaUri?:     string;
  seller?:      string;        // required for buy + updatePrice (= self)
  priceLamports?: number;      // present for buy + cancel + updatePrice
};

type Props = {
  target: MarketTarget | null;
  onClose:   () => void;
  onDone:    () => void;
};

// V2 brand orange across all primary actions. Cancel uses the muted red so the
// destructive "you're removing your listing" path still reads as destructive at
// a glance.
const ACCENT: Record<MarketAction, { color: string; bg: string; verb: string; cta: string; glyph: string }> = {
  buy:         { color: '#f29030', bg: 'rgba(242,144,48,0.06)', verb: 'Buy',          cta: 'CONFIRM BUY',    glyph: '◆' },
  list:        { color: '#f29030', bg: 'rgba(242,144,48,0.06)', verb: 'List',         cta: 'CONFIRM LIST',   glyph: '⌬' },
  cancel:      { color: '#ff4466', bg: 'rgba(255,68,102,0.06)', verb: 'Cancel',       cta: 'CONFIRM CANCEL', glyph: '✕' },
  updatePrice: { color: '#f29030', bg: 'rgba(242,144,48,0.06)', verb: 'Update price', cta: 'UPDATE PRICE',   glyph: '✏' },
};

export default function V2MarketModal({ target, onClose, onDone }: Props) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction } = useWallet();

  const [priceInput, setPriceInput] = useState('');
  const [status, setStatus]   = useState('');
  const [pending, setPending] = useState(false);
  const [sig, setSig]         = useState('');
  // set once a transaction has confirmed: the panel then stays up and shows
  // the explorer link until the person dismisses it themselves
  const [done, setDone]       = useState(false);

  // ─── Brains Elite ──────────────────────────────────────────────────────
  // The program waives the sale and unlist fees for Elite holders (live on
  // mainnet since slot 93340899). The modal has to ASK the chain the same
  // question the program does, otherwise it quotes a fee that will never be
  // charged — which is exactly what it did on day one.
  // null = still checking, so we never flash the wrong number.
  const [isElite, setIsElite] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    if (!publicKey) { setIsElite(false); return; }
    setIsElite(null);
    (async () => {
      try {
        const proof = await eliteProofAccounts(connection, publicKey);
        if (alive) setIsElite(proof.length === 2);
      } catch { if (alive) setIsElite(false); }   // unsure -> quote the fee
    })();
    return () => { alive = false; };
  }, [publicKey, connection, target?.mint]);

  // Reset on target change
  useEffect(() => {
    setPriceInput('');
    setStatus('');
    setPending(false);
    setSig('');
  }, [target?.mint, target?.action]);

  // Esc closes when idle
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [pending, onClose]);

  if (!target) return null;
  const A = ACCENT[target.action];

  const priceXnt   = target.priceLamports != null ? target.priceLamports / 1e9 : 0;
  const wantsPriceInput = target.action === 'list' || target.action === 'updatePrice';
  const listXnt    = parseFloat(priceInput);
  const listValid  = !isNaN(listXnt) && listXnt > 0
    // For updatePrice, require a different value — otherwise the cancel+list
    // round-trip is just wasted gas.
    && (target.action !== 'updatePrice' || Math.abs(listXnt - priceXnt) > 1e-9);
  const feeLamports = (lp: number) => Math.floor(lp * SALE_FEE_NUMERATOR / SALE_FEE_DENOMINATOR);
  const CANCEL_FEE_PCT = 0.888;   // matches CANCEL_FEE_NUMERATOR in the program

  const feeWaived  = isElite === true;
  const sellerCutXnt = wantsPriceInput && listValid
    ? (feeWaived ? listXnt : listXnt - feeLamports(listXnt * 1e9) / 1e9)
    : 0;

  const run = async () => {
    if (!publicKey) return;
    setPending(true);
    setStatus('');
    setSig('');
    try {
      let res;
      if (target.action === 'list') {
        if (!listValid) throw new Error('Enter a valid XNT price');
        res = await executeList({
          connection, publicKey, sendTransaction, signTransaction,
          nftMint: target.mint, priceXnt: listXnt,
          onStatus: setStatus,
        });
      } else if (target.action === 'buy') {
        if (!target.seller || target.priceLamports == null) throw new Error('Listing data missing');
        res = await executeBuy({
          connection, publicKey, sendTransaction, signTransaction,
          nftMint: target.mint, seller: target.seller, priceLamports: target.priceLamports,
          onStatus: setStatus,
        });
      } else if (target.action === 'updatePrice') {
        // Marketplace program has no in-place price update — emulate it by
        // running cancel → list at the new price as two sequential signatures.
        if (target.priceLamports == null) throw new Error('Current listing missing');
        if (!listValid) throw new Error('Enter a new XNT price (different from the current one)');
        setStatus('Step 1/2 · Delisting current price…');
        await executeCancel({
          connection, publicKey, sendTransaction, signTransaction,
          nftMint: target.mint, priceLamports: target.priceLamports,
          onStatus: (m) => setStatus(`Step 1/2 · ${m}`),
        });
        setStatus('Step 2/2 · Relisting at new price…');
        res = await executeList({
          connection, publicKey, sendTransaction, signTransaction,
          nftMint: target.mint, priceXnt: listXnt,
          onStatus: (m) => setStatus(`Step 2/2 · ${m}`),
        });
      } else {
        if (target.priceLamports == null) throw new Error('Listing data missing');
        res = await executeCancel({
          connection, publicKey, sendTransaction, signTransaction,
          nftMint: target.mint, priceLamports: target.priceLamports,
          onStatus: setStatus,
        });
      }
      setSig(res!.sig);
      setStatus(`✅ ${A.verb} confirmed`);
      // ⛔ Do NOT auto-close. This panel holds the only link to the transaction,
      // and a timer used to pull it away after 1.8s before it could be clicked.
      // Refresh the data behind the modal instead and let the person close it.
      setDone(true);
      onDone();
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0, 140) ?? 'Transaction failed'}`);
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
          width: '100%', maxWidth: 440,
          maxHeight: '92dvh', overflowY: 'auto',
          background: 'linear-gradient(155deg,#0c1520,#080c0f)',
          border: `1px solid ${A.color}55`,
          borderRadius: 16, padding: '24px 22px',
          boxShadow: `0 0 60px ${A.color}1a, 0 32px 80px rgba(0,0,0,.9)`,
          position: 'relative',
        }}
      >
        <div style={{
          position: 'absolute', top: 0, left: '10%', right: '10%', height: 1,
          background: `linear-gradient(90deg,transparent,${A.color},transparent)`,
        }} />

        <button
          onClick={onClose}
          disabled={pending}
          style={{
            position: 'absolute', top: 10, right: 10,
            width: 28, height: 28, borderRadius: '50%',
            border: `1px solid ${A.color}40`, background: 'rgba(8,12,15,.9)',
            cursor: pending ? 'not-allowed' : 'pointer',
            color: A.color, fontSize: 16,
          }}
        >×</button>

        <div style={{ marginBottom: 18 }}>
          <div style={{
            fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900,
            color: '#fff', marginBottom: 4, letterSpacing: 1,
          }}>
            {A.glyph} {target.action === 'updatePrice' ? 'EDIT LISTING PRICE' : `${A.verb.toUpperCase()} NFT`}
          </div>
          <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#8aaac8' }}>
            {target.action === 'buy'         && 'Confirm the purchase. NFT will land in your wallet.'}
            {target.action === 'list'        && 'Set a price in XNT. Cancelable any time.'}
            {target.action === 'cancel'      && 'Return the NFT to your wallet. 0.888% cancel fee applies.'}
            {target.action === 'updatePrice' && 'Marketplace has no in-place update — this delists then relists at the new price (two signatures).'}
          </div>
        </div>

        <div style={{
          display: 'flex', gap: 12, alignItems: 'center',
          marginBottom: 18, padding: '10px 12px',
          background: 'rgba(255,255,255,.03)',
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
              fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#6a7a94',
              letterSpacing: 1,
            }}>
              {shortAddr(target.mint, 5, 5)}
            </div>
          </div>
        </div>

        {target.action === 'updatePrice' && target.priceLamports != null && (
          <div style={{
            marginBottom: 14, padding: '10px 14px',
            background: 'rgba(242,144,48,0.06)', borderRadius: 9,
            border: '1px solid rgba(242,144,48,0.25)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#9abacf', letterSpacing: 1.5 }}>
              CURRENT PRICE
            </span>
            <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 13, fontWeight: 800, color: '#f29030' }}>
              {fmtNum(priceXnt, 4)} XNT
            </span>
          </div>
        )}

        {/* Brains Elite — say WHY the fee is gone, on every fee-bearing action.
            ⛔ The perk is re-checked on chain at the moment of each action, so
            the wording promises nothing about later: it states what is true
            right now, while they hold one. */}
        {feeWaived && target.action !== 'buy' && (
          <div style={{
            marginBottom: 14, padding: '10px 12px',
            background: 'rgba(0,201,141,0.07)',
            border: '1px solid rgba(0,201,141,0.35)',
            borderRadius: 9,
          }}>
            <div style={{
              fontFamily: 'Orbitron,monospace', fontSize: 9, letterSpacing: 1.2,
              color: '#00c98d', fontWeight: 700, marginBottom: 3,
            }}>
              ✓ BRAINS ELITE — FEES WAIVED
            </div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10.5, color: '#9abacf', lineHeight: 1.45 }}>
              {target.action === 'cancel'
                ? 'You unlist for free. Normally 0.888%.'
                : 'What it sells for is what you get. Normally 1.888%.'}
              {' '}Checked on chain each time — keep an Elite in your wallet.
            </div>
          </div>
        )}

        {wantsPriceInput && (
          <div style={{ marginBottom: 14 }}>
            <div style={{
              fontFamily: 'Orbitron,monospace', fontSize: 9,
              color: '#9abacf', letterSpacing: 1.5, marginBottom: 8,
            }}>
              {target.action === 'updatePrice' ? 'NEW PRICE' : 'LISTING PRICE'}
            </div>
            <div style={{ position: 'relative' }}>
              <input
                type="number" min="0" step="0.0001"
                value={priceInput}
                onChange={e => setPriceInput(e.target.value)}
                placeholder="0.0000"
                autoFocus
                disabled={pending}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '12px 52px 12px 16px',
                  background: 'rgba(0,0,0,.4)',
                  border: `1px solid ${A.color}40`,
                  borderRadius: 9, outline: 'none',
                  color: A.color,
                  fontFamily: 'Orbitron,monospace',
                  fontSize: 16, fontWeight: 700,
                  caretColor: A.color,
                }}
              />
              <span style={{
                position: 'absolute', right: 14, top: '50%',
                transform: 'translateY(-50%)',
                fontFamily: 'Orbitron,monospace', fontSize: 9,
                color: '#9abacf', pointerEvents: 'none',
              }}>XNT</span>
            </div>
            {listValid && (
              <div style={{
                marginTop: 10, padding: '10px 12px',
                background: A.bg, borderRadius: 8,
                border: `1px solid ${A.color}25`,
                display: 'flex', justifyContent: 'space-between',
                fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#9abacf',
              }}>
                <span>
                  {isElite === null
                    ? 'YOU RECEIVE (checking Brains Elite…)'
                    : feeWaived
                      ? 'YOU RECEIVE (no fee)'
                      : `YOU RECEIVE (after ${SALE_FEE_NUMERATOR / 1000}% fee)`}
                </span>
                <span style={{ color: feeWaived ? '#00c98d' : A.color, fontWeight: 700 }}>
                  {fmtNum(sellerCutXnt, 4)} XNT
                </span>
              </div>
            )}
          </div>
        )}

        {(target.action === 'buy' || target.action === 'cancel') && target.priceLamports != null && (
          <div style={{
            marginBottom: 14, padding: '12px 14px',
            background: A.bg, borderRadius: 9,
            border: `1px solid ${A.color}25`,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{
              fontFamily: 'Orbitron,monospace', fontSize: 9,
              color: '#9abacf', letterSpacing: 1.5,
            }}>
              {target.action === 'buy' ? 'PRICE' : 'LISTED AT'}
              {target.action === 'cancel' && isElite === false && (
                <span style={{ color: '#9abacf', fontWeight: 400 }}>
                  {'  ·  '}{CANCEL_FEE_PCT}% UNLIST FEE
                </span>
              )}
            </span>
            <span style={{
              fontFamily: 'Orbitron,monospace', fontSize: 14, fontWeight: 900,
              color: A.color,
            }}>
              {fmtNum(priceXnt, 4)} XNT
            </span>
          </div>
        )}

        {status && (
          <div style={{
            margin: '8px 0 14px', padding: '8px 12px',
            background: 'rgba(255,255,255,.04)',
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 8,
            fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#cfdfee',
          }}>
            {status}
            {sig && (
              <div style={{ marginTop: 8 }}>
                <a
                  href={`https://explorer.mainnet.x1.xyz/tx/${sig}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{
                    display: 'inline-block',
                    padding: done ? '7px 12px' : 0,
                    background: done ? `${A.color}1a` : 'transparent',
                    border: done ? `1px solid ${A.color}66` : 'none',
                    borderRadius: 7,
                    color: A.color,
                    fontFamily: 'Orbitron,monospace',
                    fontSize: done ? 9 : 10,
                    fontWeight: done ? 700 : 400,
                    letterSpacing: done ? 1.2 : 0,
                    textDecoration: 'none',
                  }}
                >
                  VIEW TRANSACTION ↗
                </a>
                {done && (
                  <div style={{
                    marginTop: 7, fontFamily: 'Sora,sans-serif', fontSize: 10,
                    color: '#7f93a6', wordBreak: 'break-all', lineHeight: 1.5,
                  }}>
                    {sig}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Once the transaction has confirmed there is nothing left to run, so
            the footer becomes a single CLOSE. The panel stays up until it is
            pressed (or the backdrop is clicked) so the explorer link above can
            actually be used. */}
        {done ? (
          <button
            type="button"
            onClick={onClose}
            style={{
              width: '100%', padding: '11px 0',
              background: `linear-gradient(135deg, ${A.color}33, ${A.color}11)`,
              border: `1px solid ${A.color}80`,
              borderRadius: 8, cursor: 'pointer',
              fontFamily: 'Orbitron,monospace',
              fontSize: 9, fontWeight: 700, color: A.color, letterSpacing: 1.5,
            }}
          >
            CLOSE
          </button>
        ) : (
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            style={{
              flex: 1, padding: '11px 0',
              background: 'rgba(255,255,255,.04)',
              border: '1px solid rgba(255,255,255,.1)',
              borderRadius: 8,
              cursor: pending ? 'not-allowed' : 'pointer',
              fontFamily: 'Orbitron,monospace',
              fontSize: 9, fontWeight: 700, color: '#9abacf',
              letterSpacing: 1.5,
            }}
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={run}
            disabled={pending || (wantsPriceInput && !listValid) || !publicKey}
            style={{
              flex: 2, padding: '11px 0',
              background: pending
                ? 'rgba(255,255,255,.04)'
                : `linear-gradient(135deg, ${A.color}33, ${A.color}11)`,
              border: `1px solid ${A.color}80`,
              borderRadius: 8,
              cursor: pending ? 'not-allowed' : 'pointer',
              fontFamily: 'Orbitron,monospace',
              fontSize: 9, fontWeight: 700, color: A.color,
              letterSpacing: 1.5,
              opacity: pending ? 0.6 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            {pending && (
              <span style={{
                width: 12, height: 12, borderRadius: '50%',
                border: `2px solid ${A.color}33`,
                borderTop: `2px solid ${A.color}`,
                animation: 'spin 0.8s linear infinite',
              }} />
            )}
            {pending ? 'WORKING…' : A.cta}
          </button>
        </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
