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

// ─── Xenblocks amplifier (combo_mint_lb) ─────────────────────────────────
// Discriminator read from the LIVE on-chain IDL of lb_mint
// 3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN, not from a local build.
const DISC_COMBO_MINT_LB: number[] = [20, 150, 179, 60, 25, 59, 105, 123];
// Rates are hardcoded in the program and cannot be changed without a redeploy
// (lb_mint/src/lib.rs: XNM_PER_LB, XUNI_STEP, XUNI_LB_PER_STEP, XBLK_LB_PER_TOKEN).
const XNM_PER_LB        = 1_000;   // 1,000 XNM -> 1 LB   (must be a multiple)
const XUNI_STEP         = 500;     //   500 XUNI -> 4 LB   (must be a multiple)
const XUNI_LB_PER_STEP  = 4;
const XBLK_LB_PER_TOKEN = 8;       //     1 XBLK -> 8 LB
// ⛔ The program burns HALF of each Xenblocks amount and sends the other half
// to the treasury (split_xenblocks). The UI must say so — it is not all burned.

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

  // Xenblocks amplifier
  const [useAmplifier, setUseAmplifier] = useState(false);
  const [xnmAmount,  setXnmAmount]  = useState(0);
  const [xuniAmount, setXuniAmount] = useState(0);
  const [xblkAmount, setXblkAmount] = useState(0);

  const [status, setStatus]   = useState('');
  const [pending, setPending] = useState(false);
  const [lastSig, setLastSig] = useState('');

  const tierIdx     = Math.min(Math.floor(mintedTotal / TIER_SIZE), 3);
  const currentTier = TIERS[tierIdx];
  const brainsCost  = amount * currentTier.brains;

  // Bonus LB from Xenblocks, mirroring calc_lb_from_* in the program exactly.
  const xnmLb   = useAmplifier ? Math.floor(xnmAmount / XNM_PER_LB) : 0;
  const xuniLb  = useAmplifier ? Math.floor(xuniAmount / XUNI_STEP) * XUNI_LB_PER_STEP : 0;
  const xblkLb  = useAmplifier ? xblkAmount * XBLK_LB_PER_TOKEN : 0;
  const bonusLb = xnmLb + xuniLb + xblkLb;
  const lbOut   = amount + bonusLb;

  // ⛔ XNT is charged per TOTAL LB minted, bonus included —
  // `xnt_total = xnt_lamports_per_lb * total_lb` in combo_mint_lb. Charging
  // only for the base amount would under-quote and the tx would fail.
  const xntCost     = parseFloat(((lbOut * currentTier.xntLamports) / LAMPORTS_PER_SOL).toFixed(4));
  const tierProgress = ((mintedTotal % TIER_SIZE) / TIER_SIZE) * 100;
  const tierMintedInSlot = mintedTotal % TIER_SIZE;
  const tierRemainingInSlot = TIER_SIZE - tierMintedInSlot;

  const totalCostUsd = brainsCost * brainsPrice + xntCost * xntPrice;

  // The program requires each Xenblocks amount to be an exact multiple, and at
  // least one of the three to be non-zero when combo_mint_lb is used.
  const xnmValid  = xnmAmount  % XNM_PER_LB === 0;
  const xuniValid = xuniAmount % XUNI_STEP  === 0;
  const amplifierValid = !useAmplifier || (
    (xnmAmount > 0 || xuniAmount > 0 || xblkAmount > 0)
    && xnmValid && xuniValid
    && (xnmAmount  === 0 || (xnmBalance  != null && xnmBalance  >= xnmAmount))
    && (xuniAmount === 0 || (xuniBalance != null && xuniBalance >= xuniAmount))
    && (xblkAmount === 0 || (xblkBalance != null && xblkBalance >= xblkAmount))
  );
  const supplyOk = mintedTotal + lbOut <= TOTAL_LB_SUPPLY;

  const canAfford =
    !paused
    && brainsBalance != null && brainsBalance >= brainsCost
    && xntBalance    != null && xntBalance    >= xntCost + XNT_RENT_BUFFER
    && amplifierValid
    && supplyOk;

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

      if (!useAmplifier) {
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
      } else {
        // ── combo_mint_lb ────────────────────────────────────────────────
        // ⛔ All three Xenblocks mints are Token-2022, and the ACCOUNT ORDER
        // below must match the ComboMintLb struct exactly (20 accounts). Both
        // were read off the live on-chain IDL, not a local build.
        const buyerXnmAta     = getAssociatedTokenAddressSync(XNM_MINT_PK,  publicKey,  false, TOKEN_2022);
        const buyerXuniAta    = getAssociatedTokenAddressSync(XUNI_MINT_PK, publicKey,  false, TOKEN_2022);
        const buyerXblkAta    = getAssociatedTokenAddressSync(XBLK_MINT_PK, publicKey,  false, TOKEN_2022);
        const treasuryXnmAta  = getAssociatedTokenAddressSync(XNM_MINT_PK,  treasuryPk, false, TOKEN_2022);
        const treasuryXuniAta = getAssociatedTokenAddressSync(XUNI_MINT_PK, treasuryPk, false, TOKEN_2022);
        const treasuryXblkAta = getAssociatedTokenAddressSync(XBLK_MINT_PK, treasuryPk, false, TOKEN_2022);

        // Every one of the six must exist — the program transfers the treasury
        // half into them, so a missing treasury ATA fails the whole mint.
        for (const [mint, ata, owner] of [
          [XNM_MINT_PK,  buyerXnmAta,     publicKey ],
          [XUNI_MINT_PK, buyerXuniAta,    publicKey ],
          [XBLK_MINT_PK, buyerXblkAta,    publicKey ],
          [XNM_MINT_PK,  treasuryXnmAta,  treasuryPk],
          [XUNI_MINT_PK, treasuryXuniAta, treasuryPk],
          [XBLK_MINT_PK, treasuryXblkAta, treasuryPk],
        ] as [PublicKey, PublicKey, PublicKey][]) {
          try { await getAccount(connection, ata, 'confirmed', TOKEN_2022); }
          catch { tx.add(createAssociatedTokenAccountInstruction(publicKey, ata, owner, mint, TOKEN_2022)); }
        }

        // args: brains, xnm, xuni, xblk — all u64 LE in WHOLE units; the
        // program multiplies by each mint's decimals itself.
        const data = Buffer.concat([
          Buffer.from(DISC_COMBO_MINT_LB),
          encodeU64LE(brainsCost),
          encodeU64LE(xnmAmount),
          encodeU64LE(xuniAmount),
          encodeU64LE(xblkAmount),
        ]);

        tx.add(new TransactionInstruction({
          programId,
          keys: [
            { pubkey: publicKey,               isSigner: true,  isWritable: true  }, // 0  buyer
            { pubkey: statePda,                isSigner: false, isWritable: true  }, // 1  state
            { pubkey: lbMintPda,               isSigner: false, isWritable: true  }, // 2  lb_mint
            { pubkey: mintAuthPda,             isSigner: false, isWritable: false }, // 3  lb_mint_authority
            { pubkey: buyerLbAta,              isSigner: false, isWritable: true  }, // 4  buyer_lb_ata
            { pubkey: BRAINS_MINT_PK,          isSigner: false, isWritable: true  }, // 5  brains_mint
            { pubkey: buyerBrainsAta,          isSigner: false, isWritable: true  }, // 6  buyer_brains_ata
            { pubkey: XNM_MINT_PK,             isSigner: false, isWritable: true  }, // 7  xnm_mint
            { pubkey: buyerXnmAta,             isSigner: false, isWritable: true  }, // 8  buyer_xnm_ata
            { pubkey: treasuryXnmAta,          isSigner: false, isWritable: true  }, // 9  treasury_xnm_ata
            { pubkey: XUNI_MINT_PK,            isSigner: false, isWritable: true  }, // 10 xuni_mint
            { pubkey: buyerXuniAta,            isSigner: false, isWritable: true  }, // 11 buyer_xuni_ata
            { pubkey: treasuryXuniAta,         isSigner: false, isWritable: true  }, // 12 treasury_xuni_ata
            { pubkey: XBLK_MINT_PK,            isSigner: false, isWritable: true  }, // 13 xblk_mint
            { pubkey: buyerXblkAta,            isSigner: false, isWritable: true  }, // 14 buyer_xblk_ata
            { pubkey: treasuryXblkAta,         isSigner: false, isWritable: true  }, // 15 treasury_xblk_ata
            { pubkey: treasuryPk,              isSigner: false, isWritable: true  }, // 16 treasury
            { pubkey: treasuryLbAta,           isSigner: false, isWritable: true  }, // 17 treasury_lb_ata
            { pubkey: TOKEN_2022,              isSigner: false, isWritable: false }, // 18 token_2022_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 19 system_program
          ],
          data,
        }));
      }

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
      setStatus(`✓ Minted ${lbOut} LB${bonusLb > 0 ? ` (${amount} base + ${bonusLb} bonus)` : ''}`);
      setBrainsBal(b => (b ?? 0) - brainsCost);
      setXntBal(x => (x ?? 0) - xntCost);
      setMintedTotal(m => m + lbOut);
      if (useAmplifier) {
        setXnmBalance(v  => (v ?? 0) - xnmAmount);
        setXuniBalance(v => (v ?? 0) - xuniAmount);
        setXblkBalance(v => (v ?? 0) - xblkAmount);
      }
    } catch (e: any) {
      console.error('mint failed', e);
      setStatus(`✗ ${e?.message ?? 'Mint failed'}`);
    } finally {
      setPending(false);
    }
  }, [publicKey, signTransaction, connection, amount, brainsCost, xntCost, canAfford, paused,
      useAmplifier, xnmAmount, xuniAmount, xblkAmount, lbOut, bonusLb]);

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

          {/* ── Xenblocks amplifier ───────────────────────────────────── */}
          <div style={{
            marginBottom: 14, padding: '12px 14px', borderRadius: 10,
            background: useAmplifier ? 'rgba(0,201,141,0.05)' : 'rgba(255,255,255,0.02)',
            border: `1px solid ${useAmplifier ? 'rgba(0,201,141,0.32)' : 'rgba(255,255,255,0.07)'}`,
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useAmplifier}
                onChange={e => setUseAmplifier(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: '#00c98d', cursor: 'pointer' }}
              />
              <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 9.5, letterSpacing: 1.4,
                             color: useAmplifier ? '#00c98d' : '#9abacf', fontWeight: 700 }}>
                BURN XENBLOCKS FOR BONUS LB
              </span>
            </label>

            {!useAmplifier && (
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10.5, color: '#7a9ab8', marginTop: 6, lineHeight: 1.5 }}>
                Add XNM, XUNI or XBLK to the same mint and get extra LB on top.
                1,000 XNM = 1 LB · 500 XUNI = 4 LB · 1 XBLK = 8 LB.
              </div>
            )}

            {useAmplifier && (
              <div style={{ marginTop: 12 }}>
                {([
                  ['XNM',  xnmAmount,  setXnmAmount,  xnmBalance,  XNM_PER_LB, `${XNM_PER_LB.toLocaleString()} = 1 LB`,  xnmLb,  xnmValid],
                  ['XUNI', xuniAmount, setXuniAmount, xuniBalance, XUNI_STEP,  `${XUNI_STEP} = ${XUNI_LB_PER_STEP} LB`,  xuniLb, xuniValid],
                  ['XBLK', xblkAmount, setXblkAmount, xblkBalance, 1,          `1 = ${XBLK_LB_PER_TOKEN} LB`,            xblkLb, true],
                ] as [string, number, (n: number) => void, number | null, number, string, number, boolean][])
                  .map(([label, val, setVal, bal, step, rate, lb, valid]) => {
                    const short = bal != null && val > bal;
                    return (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <div style={{ width: 52, fontFamily: 'Orbitron,monospace', fontSize: 9,
                                      color: '#cfdfee', letterSpacing: 1 }}>{label}</div>
                        <input
                          type="number" min={0} step={step} value={val}
                          onChange={e => setVal(Math.max(0, parseInt(e.target.value) || 0))}
                          style={{
                            flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '7px 9px',
                            background: 'rgba(6,9,13,0.75)',
                            border: `1px solid ${short || !valid ? 'rgba(255,68,102,0.5)' : 'rgba(255,255,255,0.1)'}`,
                            borderRadius: 7, color: '#e8f2fb',
                            fontFamily: 'Orbitron,monospace', fontSize: 11,
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setVal(bal == null ? 0 : Math.floor(bal / step) * step)}
                          style={{
                            padding: '6px 9px', borderRadius: 6, cursor: 'pointer',
                            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
                            color: '#9abacf', fontFamily: 'Orbitron,monospace', fontSize: 8, letterSpacing: 1,
                          }}
                        >MAX</button>
                        <div style={{ width: 118, textAlign: 'right', fontFamily: 'Orbitron,monospace', fontSize: 8.5,
                                      color: lb > 0 ? '#00c98d' : '#6a7a94' }}>
                          {lb > 0 ? `+${lb} LB` : rate}
                        </div>
                      </div>
                    );
                  })}

                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#7a9ab8',
                              marginTop: 8, lineHeight: 1.5, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                  Half of every Xenblocks amount is burned, half goes to the treasury.
                  XNM must be a multiple of {XNM_PER_LB.toLocaleString()} and XUNI a multiple of {XUNI_STEP}.
                  {' '}Bonus LB is charged XNT at the current tier rate.
                </div>

                {useAmplifier && !amplifierValid && (
                  <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10.5, color: '#ff8899', marginTop: 7 }}>
                    {xnmAmount === 0 && xuniAmount === 0 && xblkAmount === 0
                      ? 'Enter at least one Xenblocks amount, or switch the amplifier off.'
                      : !xnmValid  ? `XNM must be a multiple of ${XNM_PER_LB.toLocaleString()}.`
                      : !xuniValid ? `XUNI must be a multiple of ${XUNI_STEP}.`
                      : 'Not enough Xenblocks in your wallet for that amount.'}
                  </div>
                )}
              </div>
            )}
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
                <div className="mint-cost-headline-val accent-orange">{lbOut} LB</div>
                {bonusLb > 0 && (
                  <div className="mint-cost-headline-usd" style={{ color: '#00c98d' }}>
                    {amount} base + {bonusLb} bonus
                  </div>
                )}
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
                               `MINT ${lbOut} LB`}
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
