import { useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { BRAINS_MINT } from '../constants';
import { fetchPrice } from '../lib/prices';
import { fmtNum } from '../utils/v2format';

const LB_MINT  = 'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6';
const XNT_MINT = 'So11111111111111111111111111111111111111112';

type Token = {
  symbol: 'BRAINS' | 'XNT' | 'LB';
  icon: string;
  iconClass: string;
  mint: string;
};

const TOKENS: Token[] = [
  { symbol: 'BRAINS', icon: 'B', iconClass: 'brains', mint: BRAINS_MINT },
  { symbol: 'XNT',    icon: 'X', iconClass: 'xnt',    mint: XNT_MINT    },
  { symbol: 'LB',     icon: 'L', iconClass: 'lb',     mint: LB_MINT     },
];

async function fetchBalance(connection: any, owner: PublicKey, mint: string): Promise<number> {
  if (mint === XNT_MINT) {
    const lamports = await connection.getBalance(owner);
    return lamports / 1e9;
  }
  const mintPk = new PublicKey(mint);
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = getAssociatedTokenAddressSync(mintPk, owner, true, program);
      const info = await connection.getParsedAccountInfo(ata);
      const amt = (info.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof amt === 'number') return amt;
    } catch { /* keep trying */ }
  }
  return 0;
}

export default function SwapCard() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();

  const [fromIdx, setFromIdx] = useState(0); // BRAINS
  const [toIdx, setToIdx]     = useState(1); // XNT
  const [amount, setAmount]   = useState('10');

  const from = TOKENS[fromIdx];
  const to   = TOKENS[toIdx];

  const [fromBal, setFromBal] = useState<number | null>(null);
  const [toBal, setToBal]     = useState<number | null>(null);
  const [fromPrice, setFromPrice] = useState(0);
  const [toPrice, setToPrice]     = useState(0);

  // Load balances when wallet or token changes
  useEffect(() => {
    if (!publicKey) {
      setFromBal(null);
      setToBal(null);
      return;
    }
    let alive = true;
    (async () => {
      const [a, b] = await Promise.all([
        fetchBalance(connection, publicKey, from.mint),
        fetchBalance(connection, publicKey, to.mint),
      ]);
      if (!alive) return;
      setFromBal(a);
      setToBal(b);
    })();
    return () => { alive = false; };
  }, [publicKey, connection, from.mint, to.mint]);

  // Load prices when tokens change
  useEffect(() => {
    let alive = true;
    Promise.all([fetchPrice(from.mint), fetchPrice(to.mint)]).then(([a, b]) => {
      if (!alive) return;
      setFromPrice(a);
      setToPrice(b);
    });
    return () => { alive = false; };
  }, [from.mint, to.mint]);

  const rate = useMemo(() => (toPrice > 0 ? fromPrice / toPrice : 0), [fromPrice, toPrice]);
  const expectedOut = useMemo(() => {
    const a = parseFloat(amount);
    if (!isFinite(a) || a <= 0) return 0;
    return a * rate;
  }, [amount, rate]);

  const min = expectedOut * 0.99;

  const flip = () => {
    setFromIdx(toIdx);
    setToIdx(fromIdx);
  };

  const setMax = () => {
    if (fromBal != null) setAmount(String(fromBal));
  };

  const canSwap = connected && parseFloat(amount) > 0 && fromBal != null && parseFloat(amount) <= fromBal && rate > 0;

  return (
    <div className="card">
      <div className="card-title">Swap Tokens</div>

      <div className="swap-input">
        <div className="top-row">
          <span className="label">You Pay</span>
          <span className="balance">
            Balance:{' '}
            <span onClick={setMax} role="button">
              {fromBal == null ? '—' : fmtNum(fromBal, 4)}
            </span>
          </span>
        </div>
        <div className="input-row">
          <input
            type="text"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <div className="token-select">
            <span className={`token-icon ${from.iconClass}`}>{from.icon}</span>
            <span className="symbol">{from.symbol}</span>
            <span className="arrow">▾</span>
          </div>
        </div>
      </div>

      <div className="swap-divider">
        <button type="button" onClick={flip} title="Flip">⇣</button>
      </div>

      <div className="swap-input">
        <div className="top-row">
          <span className="label">You Receive</span>
          <span className="balance">
            Balance: <span>{toBal == null ? '—' : fmtNum(toBal, 4)}</span>
          </span>
        </div>
        <div className="input-row">
          <input type="text" placeholder="0.0" value={expectedOut > 0 ? expectedOut.toFixed(6) : ''} readOnly />
          <div className="token-select">
            <span className={`token-icon ${to.iconClass}`}>{to.icon}</span>
            <span className="symbol">{to.symbol}</span>
            <span className="arrow">▾</span>
          </div>
        </div>
      </div>

      <div className="swap-info">
        <div className="swap-info-row">
          <span>Exchange Rate</span>
          <span className="val">
            {rate > 0 ? `1 ${from.symbol} ≈ ${rate < 0.01 ? rate.toFixed(6) : rate.toFixed(4)} ${to.symbol}` : '—'}
          </span>
        </div>
        <div className="swap-info-row">
          <span>Estimated Out</span>
          <span className="val">{expectedOut > 0 ? `${expectedOut.toFixed(6)} ${to.symbol}` : '—'}</span>
        </div>
        <div className="swap-info-row">
          <span>Minimum Received (1%)</span>
          <span className="val">{min > 0 ? `${min.toFixed(6)} ${to.symbol}` : '—'}</span>
        </div>
        <div className="swap-info-row">
          <span>Slippage Tolerance</span>
          <span className="val">1.0%</span>
        </div>
      </div>

      {/* Real anchor — opens in a new tab without popup-blocker drama. */}
      <a
        className={`btn btn-primary${!connected || parseFloat(amount) <= 0 ? ' disabled' : ''}`}
        href={connected && parseFloat(amount) > 0
          ? `https://app.xdex.xyz/swap?input=${from.mint}&output=${to.mint}&amount=${amount}`
          : undefined}
        target="_blank"
        rel="noopener noreferrer"
        aria-disabled={!connected || parseFloat(amount) <= 0}
        onClick={(e) => {
          if (!connected || parseFloat(amount) <= 0) { e.preventDefault(); return; }
        }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          textDecoration: 'none', textAlign: 'center',
          opacity: (!connected || parseFloat(amount) <= 0) ? 0.5 : 1,
          cursor: (!connected || parseFloat(amount) <= 0) ? 'not-allowed' : 'pointer',
        }}
        title="Opens xDEX with this pair preselected"
      >
        {connected ? 'SWAP ON xDEX ↗' : 'CONNECT WALLET'}
      </a>
    </div>
  );
}
