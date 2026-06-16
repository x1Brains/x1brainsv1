import { useEffect, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { BRAINS_MINT } from '../constants';
import { executeBurnToken } from '../lib/burnIx';
import { fetchPrice } from '../lib/prices';
import { fmtNum, fmtUSD } from '../utils/v2format';

const LB_MINT = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';

const ACCENT = '#ff8c00';
const MUTED  = '#5c7a90';
const TEXT   = '#cdd8e2';
const LINE   = 'rgba(255,140,0,0.13)';

type Token = {
  symbol: 'BRAINS' | 'LB';
  mint:   string;
  desc:   string;
};

const TOKENS: Token[] = [
  {
    symbol: 'BRAINS', mint: BRAINS_MINT,
    desc: 'Permanently removes BRAINS from circulation. Counted in the burn leaderboard.',
  },
  {
    symbol: 'LB', mint: LB_MINT,
    desc: 'Burns LB tokens from your wallet. Reduces supply; not tracked for rewards.',
  },
];

async function fetchBalance(connection: any, owner: PublicKey, mint: string): Promise<number> {
  const mintPk = new PublicKey(mint);
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata  = getAssociatedTokenAddressSync(mintPk, owner, true, program);
      const info = await connection.getParsedAccountInfo(ata);
      const amt  = (info.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof amt === 'number') return amt;
    } catch {}
  }
  return 0;
}

export default function V2BurnPanel() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  const [tokenIdx, setTokenIdx] = useState(0);
  const [amount, setAmount]     = useState('');
  const [bal, setBal]           = useState(0);
  const [price, setPrice]       = useState(0);
  const [status, setStatus]     = useState('');
  const [pending, setPending]   = useState(false);
  const [sig, setSig]           = useState('');

  const tok = TOKENS[tokenIdx];

  useEffect(() => {
    if (!publicKey) { setBal(0); return; }
    let alive = true;
    (async () => {
      const [b, p] = await Promise.all([
        fetchBalance(connection, publicKey, tok.mint),
        fetchPrice(tok.mint).catch(() => 0),
      ]);
      if (!alive) return;
      setBal(b);
      setPrice(p);
    })();
    return () => { alive = false; };
  }, [publicKey, connection, tok.mint, sig]);

  const amt = parseFloat(amount) || 0;
  const usd = amt * price;
  const valid = amt > 0 && amt <= bal;

  const run = async () => {
    if (!publicKey || !signTransaction) return;
    if (!valid) { setStatus('Enter a valid amount within your balance'); return; }
    setPending(true); setStatus(''); setSig('');
    try {
      const res = await executeBurnToken({
        connection, publicKey, signTransaction,
        mint: tok.mint, amountUi: amt,
        onStatus: setStatus,
      });
      setSig(res.sig);
      setStatus(`Burned ${fmtNum(amt, amt < 1 ? 4 : 2)} ${tok.symbol}`);
      setAmount('');
    } catch (e: any) {
      setStatus(e?.message?.slice(0, 140) ?? 'Burn failed');
    } finally { setPending(false); }
  };

  const mono = { fontFamily: 'Orbitron, monospace', fontVariantNumeric: 'tabular-nums' as const };

  return (
    <div>
      {/* Token tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 16, border: `1px solid ${LINE}`, borderRadius: 6, overflow: 'hidden' }}>
        {TOKENS.map((t, i) => (
          <button
            key={t.symbol}
            type="button"
            onClick={() => { setTokenIdx(i); setAmount(''); }}
            disabled={pending}
            style={{
              ...mono,
              flex: 1, padding: '10px 0',
              background: tokenIdx === i ? 'rgba(255,140,0,0.08)' : 'transparent',
              border: 'none',
              borderRight: i === 0 ? `1px solid ${LINE}` : 'none',
              cursor: pending ? 'not-allowed' : 'pointer',
              fontSize: 10, fontWeight: 700,
              color: tokenIdx === i ? ACCENT : MUTED,
              letterSpacing: 1.5,
            }}
          >
            BURN {t.symbol}
          </button>
        ))}
      </div>

      <div style={{
        ...mono, fontFamily: 'Sora, sans-serif',
        fontSize: 11, color: MUTED, marginBottom: 14, lineHeight: 1.55,
      }}>
        {tok.desc}
      </div>

      <div style={{ ...mono, fontSize: 8, color: MUTED, letterSpacing: 1.5, marginBottom: 6 }}>
        AMOUNT
      </div>
      <div style={{
        background: 'rgba(0,0,0,0.25)',
        border: `1px solid ${LINE}`,
        borderRadius: 6, padding: '10px 12px', marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value)}
            type="number" min="0" step="0.0001" placeholder="0.0000"
            disabled={pending || !connected}
            style={{
              ...mono,
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: TEXT, fontSize: 20, fontWeight: 600,
              caretColor: ACCENT,
            }}
          />
          <button
            type="button"
            onClick={() => setAmount(bal.toFixed(6))}
            disabled={pending || bal <= 0 || !connected}
            style={{
              ...mono,
              background: 'transparent',
              border: `1px solid ${LINE}`,
              borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
              fontSize: 8, fontWeight: 700, color: ACCENT, letterSpacing: 1,
            }}
          >MAX</button>
        </div>
        <div style={{
          ...mono, fontFamily: 'Sora, sans-serif',
          fontSize: 10, color: MUTED, marginTop: 6,
        }}>
          Balance: <span style={{ color: TEXT }}>{fmtNum(bal, 4)} {tok.symbol}</span>
          {amt > 0 && price > 0 && <> · ≈ <span style={{ color: TEXT }}>{fmtUSD(usd)}</span></>}
        </div>
      </div>

      {status && (
        <div style={{
          ...mono, fontFamily: 'Sora, sans-serif',
          marginBottom: 12, padding: '8px 12px',
          background: 'rgba(255,255,255,0.02)',
          border: `1px solid ${LINE}`,
          borderRadius: 5,
          fontSize: 11, color: TEXT,
        }}>
          {status}
          {sig && (
            <div style={{ marginTop: 4 }}>
              <a
                href={`https://explorer.mainnet.x1.xyz/tx/${sig}`}
                target="_blank" rel="noopener noreferrer"
                style={{ color: ACCENT, fontSize: 10, textDecoration: 'none' }}
              >View tx ↗</a>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={run}
        disabled={pending || !valid || !connected}
        style={{
          ...mono,
          width: '100%', padding: '11px 0',
          background: pending || !valid ? 'transparent' : 'rgba(255,140,0,0.08)',
          border: `1px solid ${pending || !valid ? 'rgba(255,140,0,0.18)' : ACCENT}`,
          borderRadius: 6,
          cursor: pending || !valid ? 'not-allowed' : 'pointer',
          fontSize: 10, fontWeight: 700,
          color: pending || !valid ? MUTED : ACCENT,
          letterSpacing: 2,
        }}
      >
        {!connected ? 'CONNECT WALLET' : pending ? 'BURNING…' : 'CONFIRM BURN'}
      </button>
    </div>
  );
}
