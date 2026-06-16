// Compact side-panel portfolio shown on the Swap page.
//
// Uses the same data path as V2Portfolio (token-account scan + shared logo
// cache + xDEX-priced rows) so balances and logos always match. The
// BrainsIndexer pre-warm fires on mount so logos are usually hot before the
// first paint.

import { FC, useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  BRAINS_MINT, BRAINS_LOGO, XNT_LOGO, LB_MINT,
} from '../constants';
import {
  getCachedTokenLogo, setCachedTokenLogo, fetchTokenLogo, primeFromIndexer,
} from '../lib/tokenLogos';
import { fetchAllPrices, fetchPrice } from '../lib/prices';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

const XNT_MINT = 'So11111111111111111111111111111111111111112';

type Program = 'spl' | 't22';
type Row = {
  mint:     string;
  symbol:   string;
  balance:  number;
  price:    number;
  usd:      number;
  logo?:    string;
  color:    string;
  program:  Program;
  decimals: number;
};

// NFT-shaped tokens (decimals=0 + small integer balance) are intentionally
// excluded from the swap-page side panel — the citizen's NFT view lives in
// the full /portfolio page.
function isNftLike(r: { decimals: number; balance: number }): boolean {
  return r.decimals === 0 && r.balance > 0 && r.balance < 1_000_000;
}

const KNOWN: Record<string, { symbol: string; logo?: string; color: string }> = {
  [XNT_MINT]:    { symbol: 'XNT',    logo: XNT_LOGO,    color: '#ff8c00' },
  [BRAINS_MINT]: { symbol: 'BRAINS', logo: BRAINS_LOGO, color: '#ff8c00' },
  [LB_MINT]:     { symbol: 'LB',                          color: '#bf5af2' },
};

function shortMint(m: string) {
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

function fmt(n: number, dp = 4): string {
  if (!isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(2)     + 'K';
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}
function usd(n: number): string {
  if (!isFinite(n) || n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

type RawEntry = { mint: string; balance: number; program: Program; decimals: number };

async function fetchBalances(connection: any, owner: PublicKey): Promise<RawEntry[]> {
  const [spl, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  const raw: RawEntry[] = [];
  for (const acc of spl.value ?? []) {
    const info = acc.account.data.parsed?.info;
    if (info?.mint && info?.tokenAmount?.uiAmount > 0) {
      raw.push({
        mint: info.mint,
        balance: info.tokenAmount.uiAmount,
        program: 'spl',
        decimals: info.tokenAmount.decimals ?? 0,
      });
    }
  }
  for (const acc of t22.value ?? []) {
    const info = acc.account.data.parsed?.info;
    if (info?.mint && info?.tokenAmount?.uiAmount > 0) {
      raw.push({
        mint: info.mint,
        balance: info.tokenAmount.uiAmount,
        program: 't22',
        decimals: info.tokenAmount.decimals ?? 0,
      });
    }
  }
  return raw.filter(r => !isNftLike(r));
}

const Avatar: FC<{ row: Row }> = ({ row }) => {
  const [failed, setFailed] = useState(false);
  if (row.logo && !failed) {
    return (
      <span style={{
        width: 26, height: 26, borderRadius: 8, flex: 'none',
        background: `#06090d url(${row.logo}) center/115% no-repeat`,
        border: `1px solid ${row.color}55`,
      }}>
        <img
          src={row.logo} alt="" onError={() => setFailed(true)}
          style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }}
        />
      </span>
    );
  }
  return (
    <span style={{
      width: 26, height: 26, borderRadius: 8, flex: 'none',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: `${row.color}1a`, border: `1px solid ${row.color}55`,
      color: row.color, fontFamily: 'Orbitron, monospace',
      fontSize: 10, fontWeight: 800, letterSpacing: 0.5,
    }}>{(row.symbol[0] ?? '?').toUpperCase()}</span>
  );
};

export default function Portfolio() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  // Warm the BrainsIndexer cache on mount so logo lookups are hot when the
  // wallet scan returns rows.
  useEffect(() => { primeFromIndexer(); }, []);

  useEffect(() => {
    if (!publicKey) { setRows([]); return; }
    let alive = true;
    setLoading(true);

    (async () => {
      try {
        const [lamports, raw] = await Promise.all([
          connection.getBalance(publicKey),
          fetchBalances(connection, publicKey),
        ]);
        if (!alive) return;

        // Seed prices from the bulk endpoint (BRAINS / LB / XNT) — the rest
        // backfill below.
        let priceMap: Record<string, number> = {};
        try {
          const base = await fetchAllPrices();
          priceMap = { [XNT_MINT]: base.XNT, [BRAINS_MINT]: base.BRAINS, [LB_MINT]: base.LB };
        } catch {}

        const xntRow: Row = {
          mint: XNT_MINT, symbol: 'XNT', balance: lamports / 1e9, program: 'spl',
          price: priceMap[XNT_MINT] ?? 0,
          usd: (lamports / 1e9) * (priceMap[XNT_MINT] ?? 0),
          logo: XNT_LOGO, color: '#ff8c00', decimals: 9,
        };

        const built: Row[] = [xntRow, ...raw.map(r => {
          const known = KNOWN[r.mint];
          const cachedLogo = known?.logo ?? getCachedTokenLogo(r.mint) ?? undefined;
          const price = priceMap[r.mint] ?? 0;
          return {
            mint: r.mint,
            symbol: known?.symbol ?? shortMint(r.mint),
            balance: r.balance,
            price,
            usd: r.balance * price,
            logo: cachedLogo,
            color: known?.color ?? '#8aa0b8',
            program: r.program,
            decimals: r.decimals,
          };
        })];

        // Sort by USD desc — XNT/BRAINS/LB float to top automatically.
        built.sort((a, b) => b.usd - a.usd);
        setRows(built);
        setLoading(false);

        // ── Background enrichment: logos + prices for any unknown mint ──
        const repaint = () => {
          if (!alive) return;
          setRows(prev => [...prev]
            .map(r => {
              const logo = r.logo ?? getCachedTokenLogo(r.mint) ?? undefined;
              const p    = r.price > 0 ? r.price : (priceMap[r.mint] ?? 0);
              return { ...r, logo, price: p, usd: r.balance * (p || 0) };
            })
            .sort((a, b) => b.usd - a.usd),
          );
        };

        // Logos
        for (const r of raw) {
          if (KNOWN[r.mint]?.logo) continue;
          if (getCachedTokenLogo(r.mint)) continue;
          fetchTokenLogo(r.mint, connection).then(logo => {
            if (!alive || !logo) return;
            setCachedTokenLogo(r.mint, logo);
            repaint();
          }).catch(() => {});
        }

        // Prices for unknown mints — cap at 10 so we don't spam the API.
        const unknown = raw.filter(r => !priceMap[r.mint] && !KNOWN[r.mint]).slice(0, 10);
        for (const r of unknown) {
          fetchPrice(r.mint).then(p => {
            if (!alive || p <= 0) return;
            priceMap = { ...priceMap, [r.mint]: p };
            repaint();
          }).catch(() => {});
        }
      } catch {
        if (alive) { setLoading(false); }
      }
    })();

    return () => { alive = false; };
  }, [publicKey, connection]);

  const netWorth = rows.reduce((s, r) => s + r.usd, 0);

  return (
    <div className="info-card" style={{ overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="title" style={{ margin: 0 }}>Portfolio</div>
        {loading && (
          <span style={{
            fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#ff8c00',
            letterSpacing: 1.5, fontWeight: 700,
          }}>SCANNING</span>
        )}
      </div>

      {!connected ? (
        <div style={{
          padding: '14px 12px', textAlign: 'center',
          background: 'rgba(255,140,0,0.04)', border: '1px solid rgba(255,140,0,0.18)',
          borderRadius: 7,
        }}>
          <div style={{
            fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#8a9ab8', marginBottom: 8,
          }}>Connect a wallet to view balances + logos.</div>
          <button
            type="button" onClick={() => setVisible(true)}
            style={{
              fontFamily: 'Orbitron, monospace', fontSize: 9, fontWeight: 700,
              letterSpacing: 1.8, color: '#ff8c00',
              padding: '6px 16px', borderRadius: 6, cursor: 'pointer',
              background: 'rgba(255,140,0,0.1)', border: '1px solid rgba(255,140,0,0.55)',
            }}
          >CONNECT</button>
        </div>
      ) : rows.length === 0 && !loading ? (
        <div style={{
          padding: '14px 12px', textAlign: 'center',
          fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#5a6a82',
        }}>No balances found.</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {rows.slice(0, 6).map(r => (
              <div key={r.mint + r.program} className="portfolio-item">
                <div className="left" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <Avatar row={r} />
                  <span style={{
                    fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700,
                    color: r.color, letterSpacing: 0.5,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={r.symbol === shortMint(r.mint) ? r.mint : r.symbol}>{r.symbol}</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{
                    fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color: '#cdd8e2',
                    fontVariantNumeric: 'tabular-nums',
                  }}>{fmt(r.balance)}</div>
                  <div style={{
                    fontFamily: 'Orbitron, monospace', fontSize: 9, color: '#5c7a90',
                    fontVariantNumeric: 'tabular-nums',
                  }}>{usd(r.usd)}</div>
                </div>
              </div>
            ))}
          </div>
          {rows.length > 6 && (
            <div style={{
              fontFamily: 'Orbitron, monospace', fontSize: 8,
              color: '#5a6a82', letterSpacing: 1.5, marginTop: 6, textAlign: 'right',
            }}>+{rows.length - 6} more</div>
          )}
          <div className="total-row">
            <span className="label">Net Worth</span>
            <span className="value">{usd(netWorth)}</span>
          </div>
        </>
      )}
    </div>
  );
}
