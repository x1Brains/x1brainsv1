// V2-styled LB mint flow with tab layout matching v1's MintLabWork:
// MINT · TIERS · AMPLIFIER · INFO. Real mint_lb ix (combo_mint_lb pending).

import { useEffect, useState, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  PublicKey, Transaction, TransactionInstruction, SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import { BRAINS_MINT, PLATFORM_WALLET_STRING } from '../constants';
import { fmtNum, fmtUSD } from '../utils/v2format';
import { fetchPrice } from '../lib/prices';

const MINT_PROGRAM_ID = '3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN';
const TREASURY_WALLET = PLATFORM_WALLET_STRING;
const DISC_MINT_LB: number[] = [225, 191, 66, 41, 247, 180, 201, 81];
const XNT_RENT_BUFFER = 0.005;
const TIER_SIZE = 25_000;
const TOTAL_LB_SUPPLY = 100_000;
const INITIAL_BRAINS_SUPPLY = 8_880_000;
const MIN_COMBO_BONUS = 13;

const BRAINS_MINT_PK = new PublicKey(BRAINS_MINT);
const TOKEN_2022     = TOKEN_2022_PROGRAM_ID;

const XNM_MINT_PK  = new PublicKey('XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m');
const XUNI_MINT_PK = new PublicKey('XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm');
const XBLK_MINT_PK = new PublicKey('XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T');

const TIERS = [
  { label: 'TIER I',   brains: 8,  xntLamports: 1_110_000_000, color: '#00d4ff' },
  { label: 'TIER II',  brains: 18, xntLamports: 2_220_000_000, color: '#bf5af2' },
  { label: 'TIER III', brains: 26, xntLamports: 3_330_000_000, color: '#f29030' },
  { label: 'TIER IV',  brains: 33, xntLamports: 4_440_000_000, color: '#ff4444' },
];

const PRESETS = [1, 5, 10, 25, 50, 100];
type Tab = 'mint' | 'tiers';

function readU64LE(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return Number(view.getBigUint64(0, true));
}

function parseGlobalState(data: Uint8Array): { totalMinted: number; paused: boolean } {
  return { totalMinted: readU64LE(data, 104), paused: data[112] === 1 };
}

function encodeU64LE(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export default function V2MintInner() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  const [tab, setTab] = useState<Tab>('mint');

  const [amount, setAmount]           = useState(1);
  const [mintedTotal, setMintedTotal] = useState(0);
  const [paused, setPaused]           = useState(false);

  // Balances
  const [brainsBalance, setBrainsBal] = useState<number | null>(null);
  const [xntBalance, setXntBal]       = useState<number | null>(null);
  const [xnmBalance, setXnmBalance]   = useState<number | null>(null);
  const [xuniBalance, setXuniBalance] = useState<number | null>(null);
  const [xblkBalance, setXblkBalance] = useState<number | null>(null);

  // Burn stats
  const [brainsBurned, setBrainsBurned] = useState<number | null>(null);
  const [xnmBurned, setXnmBurned]       = useState<number | null>(null);
  const [xuniBurned, setXuniBurned]     = useState<number | null>(null);
  const [xblkBurned, setXblkBurned]     = useState<number | null>(null);

  // Prices
  const [brainsPrice, setBrainsPrice] = useState(0);
  const [xntPrice, setXntPrice]       = useState(0);
  const [xnmPrice, setXnmPrice]       = useState(0);
  const [xuniPrice, setXuniPrice]     = useState(0);
  const [xblkPrice, setXblkPrice]     = useState(0);

  const [status, setStatus]   = useState('');
  const [pending, setPending] = useState(false);
  const [lastSig, setLastSig] = useState('');

  const tierIdx     = Math.min(Math.floor(mintedTotal / TIER_SIZE), 3);
  const currentTier = TIERS[tierIdx];
  const brainsCost  = amount * currentTier.brains;
  const xntCost     = parseFloat(((amount * currentTier.xntLamports) / LAMPORTS_PER_SOL).toFixed(4));
  const tierProgress = ((mintedTotal % TIER_SIZE) / TIER_SIZE) * 100;
  const tierMintedInSlot = mintedTotal % TIER_SIZE;
  const tierRemainingInSlot = TIER_SIZE - tierMintedInSlot;

  const totalCostUsd = brainsCost * brainsPrice + xntCost * xntPrice;

  const canAfford =
    !paused
    && brainsBalance != null && brainsBalance >= brainsCost
    && xntBalance    != null && xntBalance    >= xntCost + XNT_RENT_BUFFER;

  // Load chain state + treasury balances + prices
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const programId  = new PublicKey(MINT_PROGRAM_ID);
        const treasuryPk = new PublicKey(TREASURY_WALLET);
        const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('lb_state')], programId);
        const xnmAta  = getAssociatedTokenAddressSync(XNM_MINT_PK,  treasuryPk, false, TOKEN_2022);
        const xuniAta = getAssociatedTokenAddressSync(XUNI_MINT_PK, treasuryPk, false, TOKEN_2022);
        const xblkAta = getAssociatedTokenAddressSync(XBLK_MINT_PK, treasuryPk, false, TOKEN_2022);

        const [info, supply, xnmAcc, xuniAcc, xblkAcc, bP, xP, nP, uP, kP] = await Promise.all([
          connection.getAccountInfo(statePda),
          connection.getTokenSupply(BRAINS_MINT_PK).catch(() => null),
          connection.getParsedAccountInfo(xnmAta).catch(() => null),
          connection.getParsedAccountInfo(xuniAta).catch(() => null),
          connection.getParsedAccountInfo(xblkAta).catch(() => null),
          fetchPrice(BRAINS_MINT),
          fetchPrice('So11111111111111111111111111111111111111112'),
          fetchPrice(XNM_MINT_PK.toBase58()),
          fetchPrice(XUNI_MINT_PK.toBase58()),
          fetchPrice(XBLK_MINT_PK.toBase58()),
        ]);
        if (!alive) return;

        if (info) {
          const parsed = parseGlobalState(info.data);
          setMintedTotal(parsed.totalMinted);
          setPaused(parsed.paused);
        }
        if (supply?.value?.uiAmount != null) {
          setBrainsBurned(Math.max(0, INITIAL_BRAINS_SUPPLY - supply.value.uiAmount));
        }
        const readBal = (acc: any) => (acc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        setXnmBurned(readBal(xnmAcc));
        setXuniBurned(readBal(xuniAcc));
        setXblkBurned(readBal(xblkAcc));
        setBrainsPrice(bP); setXntPrice(xP);
        setXnmPrice(nP); setXuniPrice(uP); setXblkPrice(kP);
      } catch {}
    })();
    return () => { alive = false; };
  }, [connection]);

  // Wallet balances
  useEffect(() => {
    if (!publicKey) {
      setBrainsBal(null); setXntBal(null);
      setXnmBalance(null); setXuniBalance(null); setXblkBalance(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const get2022 = async (mint: PublicKey) => {
          try {
            const ata = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022);
            const acc = await connection.getParsedAccountInfo(ata);
            return (acc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
          } catch { return 0; }
        };
        const [lamports, brains, xnm, xuni, xblk] = await Promise.all([
          connection.getBalance(publicKey),
          get2022(BRAINS_MINT_PK),
          get2022(XNM_MINT_PK),
          get2022(XUNI_MINT_PK),
          get2022(XBLK_MINT_PK),
        ]);
        if (!alive) return;
        setBrainsBal(brains);
        setXntBal(lamports / 1e9);
        setXnmBalance(xnm);
        setXuniBalance(xuni);
        setXblkBalance(xblk);
      } catch {
        if (!alive) return;
        setBrainsBal(0); setXntBal(0);
      }
    })();
    return () => { alive = false; };
  }, [publicKey, connection]);

  const handleMint = useCallback(async () => {
    if (!publicKey || !signTransaction) return;
    if (!canAfford) { setStatus('Insufficient balance for this mint.'); return; }
    if (paused)     { setStatus('Minting is paused.'); return; }

    setPending(true);
    setLastSig('');
    setStatus('Preparing mint…');

    try {
      const programId  = new PublicKey(MINT_PROGRAM_ID);
      const treasuryPk = new PublicKey(TREASURY_WALLET);

      const [statePda]    = PublicKey.findProgramAddressSync([Buffer.from('lb_state')],      programId);
      const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from('lb_mint_auth')],  programId);
      const [lbMintPda]   = PublicKey.findProgramAddressSync([Buffer.from('lb_mint')],       programId);

      const buyerBrainsAta = getAssociatedTokenAddressSync(BRAINS_MINT_PK, publicKey,  false, TOKEN_2022);
      const buyerLbAta     = getAssociatedTokenAddressSync(lbMintPda,      publicKey,  false, TOKEN_2022);
      const treasuryLbAta  = getAssociatedTokenAddressSync(lbMintPda,      treasuryPk, false, TOKEN_2022);

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });

      try { await getAccount(connection, buyerLbAta, 'confirmed', TOKEN_2022); }
      catch { tx.add(createAssociatedTokenAccountInstruction(publicKey, buyerLbAta, publicKey, lbMintPda, TOKEN_2022)); }

      try { await getAccount(connection, treasuryLbAta, 'confirmed', TOKEN_2022); }
      catch { tx.add(createAssociatedTokenAccountInstruction(publicKey, treasuryLbAta, treasuryPk, lbMintPda, TOKEN_2022)); }

      const data = Buffer.concat([Buffer.from(DISC_MINT_LB), encodeU64LE(brainsCost)]);

      tx.add(new TransactionInstruction({
        programId,
        keys: [
          { pubkey: publicKey,               isSigner: true,  isWritable: true  },
          { pubkey: statePda,                isSigner: false, isWritable: true  },
          { pubkey: lbMintPda,               isSigner: false, isWritable: true  },
          { pubkey: mintAuthPda,             isSigner: false, isWritable: false },
          { pubkey: buyerLbAta,              isSigner: false, isWritable: true  },
          { pubkey: BRAINS_MINT_PK,          isSigner: false, isWritable: true  },
          { pubkey: buyerBrainsAta,          isSigner: false, isWritable: true  },
          { pubkey: treasuryPk,              isSigner: false, isWritable: true  },
          { pubkey: treasuryLbAta,           isSigner: false, isWritable: true  },
          { pubkey: TOKEN_2022,              isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }));

      setStatus('Awaiting wallet approval…');
      const signed = await signTransaction(tx);
      setStatus('Submitting…');
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      setLastSig(sig);
      setStatus('Confirming on-chain…');
      await connection.confirmTransaction(sig, 'confirmed');
      setStatus(`✓ Minted ${amount} LB`);
      setBrainsBal(b => (b ?? 0) - brainsCost);
      setXntBal(x => (x ?? 0) - xntCost);
      setMintedTotal(m => m + amount);
    } catch (e: any) {
      console.error('mint failed', e);
      setStatus(`✗ ${e?.message ?? 'Mint failed'}`);
    } finally {
      setPending(false);
    }
  }, [publicKey, signTransaction, connection, amount, brainsCost, xntCost, canAfford, paused]);

  // ─── HERO STRIP — always shown above tabs ─────────────────────────
  const HeroStrip = (
    <>
    <div className="mint-hero">
      <div className="mint-hero-cell">
        <div className="mint-hero-label">TOTAL LB MINTED</div>
        <div className="mint-hero-val">{fmtNum(mintedTotal, 0)}</div>
        <div className="mint-hero-sub">{fmtNum(TOTAL_LB_SUPPLY, 0)} cap</div>
      </div>
      <div className="mint-hero-cell">
        <div className="mint-hero-label">BRAINS BURNED</div>
        <div className="mint-hero-val accent-red">{brainsBurned == null ? '…' : fmtNum(brainsBurned, 0)}</div>
        {brainsBurned != null && brainsPrice > 0 && (
          <div className="mint-hero-sub mint-hero-usd">{fmtUSD(brainsBurned * brainsPrice)}</div>
        )}
      </div>
      <div className="mint-hero-cell">
        <div className="mint-hero-label">CURRENT TIER</div>
        <div className="mint-hero-val">{currentTier.label}</div>
        <div className="mint-hero-sub">{fmtNum(tierRemainingInSlot, 0)} LB left in slot</div>
      </div>
      <div className="mint-hero-cell">
        <div className="mint-hero-label">STATUS</div>
        <div className="mint-hero-val" style={{ color: paused ? 'var(--neon-red)' : 'var(--neon-green)' }}>
          {!paused && <span className="mint-live-orb" />}{paused ? 'PAUSED' : 'LIVE'}
        </div>
        <div className="mint-hero-sub">mint program</div>
      </div>
    </div>

    <div className="mint-hero mint-hero2">
      <div className="mint-hero-cell">
        <div className="mint-hero-label">XNM BURNED</div>
        <div className="mint-hero-val accent-red">{xnmBurned == null ? '…' : fmtNum(xnmBurned, 0)}</div>
        {xnmBurned != null && xnmPrice > 0 && (
          <div className="mint-hero-sub mint-hero-usd">{fmtUSD(xnmBurned * xnmPrice)}</div>
        )}
      </div>
      <div className="mint-hero-cell">
        <div className="mint-hero-label">XUNI BURNED</div>
        <div className="mint-hero-val accent-red">{xuniBurned == null ? '…' : fmtNum(xuniBurned, 0)}</div>
        {xuniBurned != null && xuniPrice > 0 && (
          <div className="mint-hero-sub mint-hero-usd">{fmtUSD(xuniBurned * xuniPrice)}</div>
        )}
      </div>
      <div className="mint-hero-cell">
        <div className="mint-hero-label">XBLK BURNED</div>
        <div className="mint-hero-val accent-red">{xblkBurned == null ? '…' : fmtNum(xblkBurned, 0)}</div>
        {xblkBurned != null && xblkPrice > 0 && (
          <div className="mint-hero-sub mint-hero-usd">{fmtUSD(xblkBurned * xblkPrice)}</div>
        )}
      </div>
    </div>
    </>
  );

  return (
    <div className="mint-v2">
      {HeroStrip}

      {/* Tabs */}
      <div className="mint-tabs">
        {([
          { id: 'mint',      label: 'MINT',      glyph: '⌬' },
          { id: 'tiers',     label: 'TIERS',     glyph: '◆' },
        ] as { id: Tab; label: string; glyph: string }[]).map(t => (
          <button
            key={t.id}
            type="button"
            className={`mint-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span style={{ marginRight: 6 }}>{t.glyph}</span>{t.label}
          </button>
        ))}
      </div>

      {/* ────────────────── MINT TAB ────────────────── */}
      {tab === 'mint' && (
        <>
          {/* Mini-tier-strip showing current */}
          <div className="mint-tier-strip">
            <div className="mint-tier-line" />
            <div
              className="mint-tier-line-fill"
              style={{ width: `${Math.min((tierIdx + tierProgress / 100) / 3, 1) * 75}%` }}
            />
            {TIERS.map((t, i) => {
              const active = i === tierIdx;
              const past   = i < tierIdx;
              const roman  = t.label.replace('TIER ', '');
              return (
                <div
                  key={t.label}
                  className={`mint-tier${active ? ' active' : ''}${past ? ' past' : ''}`}
                >
                  <div className="mint-tier-node">{past ? '✓' : roman}</div>
                  <div className="mint-tier-label">{t.label}</div>
                  <div className="mint-tier-cost">
                    {t.brains} BRAINS<br/>+{(t.xntLamports / LAMPORTS_PER_SOL).toFixed(2)} XNT
                  </div>
                  <div className="mint-tier-status">
                    {past
                      ? 'COMPLETE'
                      : active
                        ? `${tierProgress.toFixed(0)}% · ${fmtNum(tierMintedInSlot, 0)}`
                        : 'UPCOMING'}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Amount */}
          <div className="mint-amount-row">
            <div className="mint-amount-label">AMOUNT</div>
            <div className="mint-amount">
              <button type="button" onClick={() => setAmount(Math.max(1, amount - 1))}>−</button>
              <input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(Math.max(1, parseInt(e.target.value) || 1))}
              />
              <button type="button" onClick={() => setAmount(amount + 1)}>+</button>
            </div>
            <div className="mint-presets">
              {PRESETS.map(p => (
                <button
                  key={p}
                  type="button"
                  className={`mint-preset${amount === p ? ' active' : ''}`}
                  onClick={() => setAmount(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Cost breakdown */}
          <div className="mint-cost">
            <div className="mint-cost-headline">
              <div>
                <div className="mint-cost-headline-label">YOU PAY</div>
                <div className="mint-cost-headline-val">{brainsCost} BRAINS + {xntCost} XNT</div>
                {totalCostUsd > 0 && <div className="mint-cost-headline-usd">≈ {fmtUSD(totalCostUsd)}</div>}
              </div>
              <div className="mint-cost-arrow">→</div>
              <div style={{ textAlign: 'right' }}>
                <div className="mint-cost-headline-label">YOU RECEIVE</div>
                <div className="mint-cost-headline-val accent-orange">{amount} LB</div>
              </div>
            </div>

            <div className="mint-cost-grid">
              <div className="mint-cost-row">
                <span>BRAINS balance</span>
                <span className={`mint-cost-val ${brainsBalance != null && brainsBalance < brainsCost ? 'short' : 'ok'}`}>
                  {brainsBalance == null ? '—' : fmtNum(brainsBalance, 0)}
                </span>
              </div>
              <div className="mint-cost-row">
                <span>XNT balance</span>
                <span className={`mint-cost-val ${xntBalance != null && xntBalance < (xntCost + XNT_RENT_BUFFER) ? 'short' : 'ok'}`}>
                  {xntBalance == null ? '—' : fmtNum(xntBalance, 4)}
                </span>
              </div>
            </div>
          </div>

          {status && (
            <div className={`mint-status${status.startsWith('✓') ? ' ok' : status.startsWith('✗') ? ' err' : ''}`}>
              {status}
              {lastSig && (
                <> · <a
                  href={`https://explorer.mainnet.x1.xyz/tx/${lastSig}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--neon-cyan)' }}
                >view tx ↗</a></>
              )}
            </div>
          )}

          <button
            type="button"
            className="mint-submit"
            disabled={!connected || pending || !canAfford || paused}
            onClick={handleMint}
          >
            {!connected      ? 'CONNECT WALLET' :
              pending        ? 'PROCESSING…' :
              paused         ? 'MINTING PAUSED' :
              !canAfford     ? 'INSUFFICIENT BALANCE' :
                               `MINT ${amount} LB`}
          </button>
        </>
      )}

      {/* ────────────────── TIERS TAB ────────────────── */}
      {tab === 'tiers' && (
        <div className="mint-tiers-detail">
          <div className="mint-tiers-table">
            <div className="mint-tiers-head">
              <div>TIER</div>
              <div>SLOT</div>
              <div>BRAINS</div>
              <div>XNT</div>
              <div>COST · 1 LB</div>
              <div>STATUS</div>
            </div>
            {TIERS.map((t, i) => {
              const active = i === tierIdx;
              const past   = i < tierIdx;
              const slotStart = i * TIER_SIZE;
              const slotEnd   = slotStart + TIER_SIZE;
              const usdCost   = t.brains * brainsPrice + (t.xntLamports / LAMPORTS_PER_SOL) * xntPrice;
              return (
                <div
                  key={t.label}
                  className={`mint-tiers-row${active ? ' active' : ''}${past ? ' past' : ''}`}
                  style={active ? { borderColor: '#f2903055' } : undefined}
                >
                  <div className="mint-tiers-cell" style={{ color: active ? '#f29030' : past ? 'var(--text-muted)' : 'var(--text-faint)' }}>
                    {t.label} {past && '✓'}
                  </div>
                  <div className="mint-tiers-cell">{fmtNum(slotStart, 0)} – {fmtNum(slotEnd, 0)}</div>
                  <div className="mint-tiers-cell accent-orange">{t.brains}</div>
                  <div className="mint-tiers-cell accent-cyan">{(t.xntLamports / LAMPORTS_PER_SOL).toFixed(2)}</div>
                  <div className="mint-tiers-cell">{usdCost > 0 ? fmtUSD(usdCost) : '—'}</div>
                  <div className="mint-tiers-cell" style={{ fontSize: 9 }}>
                    {active ? <span style={{ color: '#f29030' }}>● ACTIVE</span> :
                      past  ? <span style={{ color: 'var(--neon-green)' }}>✓ DONE</span> :
                              <span style={{ color: 'var(--text-faint)' }}>○ UPCOMING</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mint-tiers-note">
            Each tier is 25,000 LB. Mint cost rises by tier — earlier mints are cheaper. Once a slot is full the program advances and the next tier becomes active automatically.
          </div>
        </div>
      )}
    </div>
  );
}
