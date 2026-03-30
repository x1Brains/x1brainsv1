// src/pages/MintLabWork.tsx
// ─────────────────────────────────────────────────────────────────────────────
// MINT LAB WORK — inline component rendered inside LabWork.tsx
// Reads tier rates dynamically from on-chain GlobalState
// Xenblocks assets are Token-2022 (XNM, XUNI, XBLK)
// ─────────────────────────────────────────────────────────────────────────────

import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey, LAMPORTS_PER_SOL,
  TransactionInstruction, SystemProgram,
  TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import { BRAINS_MINT as BRAINS_MINT_STR, PLATFORM_WALLET_STRING } from '../constants';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const PROGRAM_DEPLOYED = true;
const MINT_PROGRAM_ID  = '3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN';
const TREASURY_WALLET  = PLATFORM_WALLET_STRING;
const BRAINS_MINT_PK   = new PublicKey(BRAINS_MINT_STR);

// All Xenblocks tokens are Token-2022
const XNM_MINT_PK  = new PublicKey('XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m');
const XUNI_MINT_PK = new PublicKey('XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm');
const XBLK_MINT_PK = new PublicKey('XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T');
const TOKEN_2022   = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Anchor discriminators — sha256("global:<name>")[0..8], verified on-chain
const DISC_MINT_LB:       number[] = [225, 191,  66,  41, 247, 180, 201,  81];
const DISC_COMBO_MINT_LB: number[] = [ 20, 150, 179,  60,  25,  59, 105, 123];

// ─── TOKENOMICS ──────────────────────────────────────────────────────────────

const TOTAL_SUPPLY = 100_000;
const TIER_SIZE    = 25_000;
const MIN_COMBO_BONUS = 13; // min bundle: 1000 XNM + 500 XUNI + 1 XBLK

// XNT buffer: covers ATA creation rent + tx fee
const XNT_RENT_BUFFER = 0.005;

// Default tier display — overridden by on-chain data once loaded
// Colors per tier — static, purely visual
const TIER_COLORS = [
  { color: '#00d4ff', rgb: '0,212,255'   },
  { color: '#bf5af2', rgb: '191,90,242'  },
  { color: '#00c98d', rgb: '0,201,141'   },
  { color: '#ff8c00', rgb: '255,140,0'   },
];
const TIER_LABELS = ['TIER I', 'TIER II', 'TIER III', 'TIER IV'];

// ─── GlobalState layout ───────────────────────────────────────────────────────
// offset 0:   8  discriminator
// offset 8:   32 admin
// offset 40:  32 treasury
// offset 72:  32 lb_mint
// offset 104: 8  total_minted (u64)
// offset 112: 1  paused (bool)
// offset 113: 1  bump (u8)
// offset 114: 64 tier_rates [(u64,u64);4]  — 4 × (8+8) = 64 bytes
// offset 178: 8  _reserved

// Read u64 little-endian from Uint8Array — works in browser (no Node Buffer needed)
function readU64LE(data: Uint8Array, offset: number): number {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]) << BigInt(i * 8);
  }
  return Number(value);
}

// Reads only total_minted and paused — tier rates are hardcoded in the program
function parseGlobalState(data: Uint8Array): { totalMinted: number; paused: boolean } {
  return { totalMinted: readU64LE(data, 104), paused: data[112] === 1 };
}

function fmt(n: number, dec = 0) {
  return n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function useIsMobile() {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

function encodeU64LE(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

// ─── TIER BAR ────────────────────────────────────────────────────────────────

const TierBar: FC<{
  tierIdx: number; minted: number; isCurrent: boolean; isMobile: boolean;
  brains: number; xntLamports: number;
}> = ({ tierIdx, minted, isCurrent, isMobile, brains, xntLamports }) => {
  const { color, rgb } = TIER_COLORS[tierIdx];
  const label      = TIER_LABELS[tierIdx];
  const tierStart  = tierIdx * TIER_SIZE;
  const tierMinted = Math.max(0, Math.min(minted - tierStart, TIER_SIZE));
  const pct        = (tierMinted / TIER_SIZE) * 100;
  const filled     = tierMinted >= TIER_SIZE;
  const xntDisplay = (xntLamports / LAMPORTS_PER_SOL).toFixed(2);

  return (
    <div style={{
      padding: isMobile ? '12px 14px' : '14px 18px',
      background: isCurrent ? `linear-gradient(135deg,rgba(${rgb},.08),rgba(255,255,255,.02))` : 'rgba(255,255,255,.02)',
      border: `1px solid ${isCurrent ? color + '44' : 'rgba(255,255,255,.06)'}`,
      borderRadius: 12, position: 'relative', overflow: 'hidden',
    }}>
      {isCurrent && <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
        background:`linear-gradient(90deg,transparent,${color},transparent)` }} />}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900,
            color: isCurrent ? color : filled ? '#6a8aaa' : '#4a6a8a' }}>{label}</div>
          {isCurrent && <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color,
            background:`rgba(${rgb},.12)`, border:`1px solid ${color}44`,
            borderRadius:4, padding:'1px 6px', animation:'lw-pulse 2s ease infinite' }}>● ACTIVE</div>}
          {filled && <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#6a8aaa',
            background:'rgba(255,255,255,.05)', border:'1px solid rgba(255,255,255,.1)',
            borderRadius:4, padding:'1px 6px' }}>✓ FILLED</div>}
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700,
            color: isCurrent ? color : '#6a8aaa' }}>
            {brains} BRAINS<span style={{ color:'#4a6a8a', fontSize:7, marginLeft:4 }}>/ LB</span>
          </div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#4a6a8a', marginTop:1 }}>
            + {xntDisplay} XNT fee / LB
          </div>
        </div>
      </div>
      <div style={{ height:6, background:'rgba(255,255,255,.06)', borderRadius:3, overflow:'hidden' }}>
        <div style={{
          height:'100%', borderRadius:3, width:`${pct}%`,
          background: filled ? 'rgba(106,122,138,.4)' : `linear-gradient(90deg,${color}88,${color})`,
          transition:'width 1s ease', boxShadow: isCurrent ? `0 0 8px ${color}66` : 'none',
        }} />
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', marginTop:5 }}>
        <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#6a8aaa' }}>
          {fmt(tierMinted)} / {fmt(TIER_SIZE)} LB minted
        </div>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color: isCurrent ? color : '#4a6a8a' }}>
          {pct.toFixed(1)}%
        </div>
      </div>
    </div>
  );
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

interface MintReceipt {
  sig: string; lbOut: number; brainsCost: number; xntCost: number;
  xnmAmt: number; xuniAmt: number; xblkAmt: number; isCombo: boolean;
}

const MintLabWork: FC = () => {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const isMobile = useIsMobile();

  // On-chain state
  const [mintedTotal,  setMintedTotal]  = useState(0);
  const [paused,       setPaused]       = useState(false);

  // Burn stats — fetched from on-chain token supply
  const [brainsBurned, setBrainsBurned] = useState<number | null>(null);
  const [xnmBurned,    setXnmBurned]    = useState<number | null>(null);
  const [xuniBurned,   setXuniBurned]   = useState<number | null>(null);
  const [xblkBurned,   setXblkBurned]   = useState<number | null>(null);

  // Tier rates hardcoded — match program constants exactly
  const tierRates = [
    { brains: 8,  xntLamports: 500_000_000  },
    { brains: 18, xntLamports: 750_000_000  },
    { brains: 26, xntLamports: 1_000_000_000 },
    { brains: 33, xntLamports: 1_500_000_000 },
  ];

  // Balances
  const [brainsBalance, setBrainsBalance] = useState<number | null>(null);
  const [xntBalance,    setXntBalance]    = useState<number | null>(null);
  const [xnmBalance,    setXnmBalance]    = useState<number | null>(null);
  const [xuniBalance,   setXuniBalance]   = useState<number | null>(null);
  const [xblkBalance,   setXblkBalance]   = useState<number | null>(null);

  // Mint form
  const [amount,       setAmount]       = useState(1);
  const [useAmplifier, setUseAmplifier] = useState(false);
  const [xnmAmount,    setXnmAmount]    = useState(0);
  const [xuniAmount,   setXuniAmount]   = useState(0);
  const [xblkAmount,   setXblkAmount]   = useState(0);
  const [activeTab,    setActiveTab]    = useState<'mint' | 'tiers' | 'info' | 'amplifier'>('mint');
  const [status,       setStatus]       = useState('');
  const [mintReceipt,  setMintReceipt]  = useState<MintReceipt | null>(null);
  const [pending,      setPending]      = useState(false);

  // ── Derived ──────────────────────────────────────────────────────
  const tierIdx       = Math.min(Math.floor(mintedTotal / TIER_SIZE), 3);
  const currentTier   = tierRates[tierIdx] ?? tierRates[0];
  const { color: c, rgb } = TIER_COLORS[tierIdx];
  const tierMinted    = Math.max(0, mintedTotal - tierIdx * TIER_SIZE);
  const tierRemaining = TIER_SIZE - tierMinted;
  const totalPct      = (mintedTotal / TOTAL_SUPPLY) * 100;

  const brainsCost    = amount * currentTier.brains;

  // Compute bonus LB first so xntCost can use lbOut (total LB, not just base)
  const xnmLb  = useAmplifier ? Math.floor(xnmAmount  / 1_000)  : 0;
  const xuniLb = useAmplifier ? Math.floor(xuniAmount / 500) * 4 : 0;
  const xblkLb = useAmplifier ? xblkAmount * 8                   : 0;
  const lbOut  = amount + xnmLb + xuniLb + xblkLb;

  // XNT fee charged on ALL LB minted (including xenblocks bonus) — not just base LB
  const xntCost = parseFloat(((lbOut * currentTier.xntLamports) / LAMPORTS_PER_SOL).toFixed(4));

  const canAfford = !paused
    && brainsBalance !== null && brainsBalance >= brainsCost
    && xntBalance    !== null && xntBalance    >= xntCost + XNT_RENT_BUFFER
    && (!useAmplifier || ((xnmAmount > 0 || xuniAmount > 0 || xblkAmount > 0) && (
      (xnmAmount  === 0 || (xnmBalance  !== null && xnmBalance  >= xnmAmount)) &&
      (xuniAmount === 0 || (xuniBalance !== null && xuniBalance >= xuniAmount)) &&
      (xblkAmount === 0 || (xblkBalance !== null && xblkBalance >= xblkAmount))
    )));

  // ── Fetch GlobalState ────────────────────────────────────────────
  const fetchGlobalState = useCallback(async () => {
    try {
      const programId  = new PublicKey(MINT_PROGRAM_ID);
      const treasuryPk = new PublicKey(TREASURY_WALLET);
      const TOKEN2022  = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

      const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('lb_state')], programId);
      const info = await connection.getAccountInfo(statePda);
      if (!info) return;
      const parsed = parseGlobalState(info.data as Uint8Array);
      setMintedTotal(parsed.totalMinted);
      setPaused(parsed.paused);

      // Fetch treasury xenblocks ATA balances — these = 50% of total burned
      // so totalBurned = treasury balance (the other 50% is gone forever)
      const fetchTreasuryBal = async (mint: PublicKey, setter: (n: number) => void) => {
        try {
          const ata = getAssociatedTokenAddressSync(mint, treasuryPk, false, TOKEN_2022_PROGRAM_ID);
          const acc = await connection.getParsedAccountInfo(ata);
          const bal = (acc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
          setter(bal);
        } catch { setter(0); }
      };
      fetchTreasuryBal(XNM_MINT_PK,  setXnmBurned);
      fetchTreasuryBal(XUNI_MINT_PK, setXuniBurned);
      fetchTreasuryBal(XBLK_MINT_PK, setXblkBurned);

      // BRAINS burned = total LB minted * brains_per_lb (Tier 1 = 8, but we use total_minted * avg)
      // Simpler: read from BRAINS mint supply change isn't easy, so just show total LB * 8 as min
      // Actually we can compute: brains burned = sum across tiers
      // For now show based on total_minted and current tier
      const lb = parsed.totalMinted;
      const t1 = Math.min(lb, 25000);
      const t2 = Math.min(Math.max(lb - 25000, 0), 25000);
      const t3 = Math.min(Math.max(lb - 50000, 0), 25000);
      const t4 = Math.max(lb - 75000, 0);
      setBrainsBurned(t1*8 + t2*18 + t3*26 + t4*33);
    } catch {}
  }, [connection]);

  useEffect(() => {
    if (PROGRAM_DEPLOYED) fetchGlobalState();
  }, [fetchGlobalState]);

  // Fetch burn stats — derives burned amounts from token supply changes
  // BRAINS burned = initial supply - current supply (all burns go through this program)
  // Xenblocks burned = tracked via treasury ATA balances (50% burn, 50% treasury)
  const fetchBurnStats = useCallback(async () => {
    try {
      const [brainsMint, xnmMint, xuniMint, xblkMint] = await Promise.allSettled([
        connection.getParsedAccountInfo(BRAINS_MINT_PK),
        connection.getParsedAccountInfo(XNM_MINT_PK),
        connection.getParsedAccountInfo(XUNI_MINT_PK),
        connection.getParsedAccountInfo(XBLK_MINT_PK),
      ]);

      // BRAINS burned = mintedTotal * avg_brains_per_lb
      // Simpler: read it from total_minted * current tier brains — but that changes per tier
      // Best: derive from LB minted × weighted avg — instead just show total BRAINS burned
      // We compute it as: minted LB × brains cost (from tiers)
      // For now read treasury XNT balance as proxy + show LB minted as primary stat
      // Actual BRAINS burned: since each LB costs 8-33 BRAINS, derive from supply diff
      // BRAINS: read current supply from mint — burned = original_supply - current_supply
      // Since we don't store original supply, use parsed supply change approach
      if (brainsMint.status === 'fulfilled') {
        const info = (brainsMint.value?.value?.data as any)?.parsed?.info;
        if (info?.supply && info?.decimals !== undefined) {
          // We can't know original supply without a snapshot
          // Best proxy: sum from GlobalState total_minted * weighted avg brains/LB
          // Leave brainsBurned as null — it's set from mintedTotal in the main component
        }
      }

      // 50/50 split: treasury holds exactly what was burned.
      // So burned amount = treasury ATA balance for each asset.
      const treasuryPk = new PublicKey(TREASURY_WALLET);
      const TOKEN_2022_PK = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
      const getAta = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, treasuryPk, false, TOKEN_2022_PK);

      const [xnmAta, xuniAta, xblkAta] = await Promise.allSettled([
        connection.getParsedAccountInfo(getAta(XNM_MINT_PK)),
        connection.getParsedAccountInfo(getAta(XUNI_MINT_PK)),
        connection.getParsedAccountInfo(getAta(XBLK_MINT_PK)),
      ]);

      if (xnmAta.status === 'fulfilled') {
        const bal = (xnmAta.value?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount;
        if (bal !== null && bal !== undefined) setXnmBurned(bal);
      }
      if (xuniAta.status === 'fulfilled') {
        const bal = (xuniAta.value?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount;
        if (bal !== null && bal !== undefined) setXuniBurned(bal);
      }
      if (xblkAta.status === 'fulfilled') {
        const bal = (xblkAta.value?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount;
        if (bal !== null && bal !== undefined) setXblkBurned(bal);
      }
    } catch {}
  }, [connection]);

  useEffect(() => {
    fetchBurnStats();
  }, [fetchBurnStats]);

  // ── Fetch balances ───────────────────────────────────────────────
  const fetchBalances = useCallback(async () => {
    if (!publicKey) {
      setBrainsBalance(null); setXntBalance(null);
      setXnmBalance(null); setXuniBalance(null); setXblkBalance(null);
      return;
    }

    // Try both token programs — Xenblocks are Token-2022 but try both to be safe
    const fetchToken = async (mint: PublicKey, setter: (n: number) => void) => {
      for (const prog of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
        try {
          const ata = getAssociatedTokenAddressSync(mint, publicKey, false, prog);
          const acc = await connection.getParsedAccountInfo(ata);
          const bal = (acc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount;
          if (bal !== null && bal !== undefined && bal >= 0) { setter(bal); return; }
        } catch {}
      }
      setter(0);
    };

    // BRAINS — Token-2022
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(BRAINS_MINT_PK, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const acc = await connection.getParsedAccountInfo(ata);
        setBrainsBalance((acc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
      } catch { setBrainsBalance(0); }
    })();

    // XNT native
    (async () => {
      try {
        const bal = await connection.getBalance(publicKey);
        setXntBalance(bal / LAMPORTS_PER_SOL);
      } catch { setXntBalance(0); }
    })();

    fetchToken(XNM_MINT_PK,  setXnmBalance);
    fetchToken(XUNI_MINT_PK, setXuniBalance);
    fetchToken(XBLK_MINT_PK, setXblkBalance);
  }, [publicKey, connection]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  // ── Mint handler ─────────────────────────────────────────────────
  const handleMint = useCallback(async () => {
    if (!publicKey || !sendTransaction) return;
    if (!canAfford) { setStatus('❌ Insufficient balance.'); return; }
    if (paused) { setStatus('❌ Minting is currently paused.'); return; }

    setMintReceipt(null);
    setPending(true);
    setStatus('Preparing mint…');

    try {
      const programId  = new PublicKey(MINT_PROGRAM_ID);
      const treasuryPk = new PublicKey(TREASURY_WALLET);

      const [statePda]    = PublicKey.findProgramAddressSync([Buffer.from('lb_state')],    programId);
      const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from('lb_mint_auth')], programId);
      const [lbMintPda]   = PublicKey.findProgramAddressSync([Buffer.from('lb_mint')],      programId);

      const buyerBrainsAta = getAssociatedTokenAddressSync(BRAINS_MINT_PK, publicKey,  false, TOKEN_2022);
      const buyerLbAta     = getAssociatedTokenAddressSync(lbMintPda,      publicKey,  false, TOKEN_2022);
      const treasuryLbAta  = getAssociatedTokenAddressSync(lbMintPda,      treasuryPk, false, TOKEN_2022);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      // Collect all instructions
      const ixs: TransactionInstruction[] = [];

      // Compute budget — ensures enough CU for Token-2022 transfer fee CPIs
      ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

      // Create buyer LB ATA if needed
      try { await getAccount(connection, buyerLbAta, 'confirmed', TOKEN_2022); }
      catch { ixs.push(createAssociatedTokenAccountInstruction(publicKey, buyerLbAta, publicKey, lbMintPda, TOKEN_2022)); }

      // Create treasury LB ATA if needed
      try { await getAccount(connection, treasuryLbAta, 'confirmed', TOKEN_2022); }
      catch { ixs.push(createAssociatedTokenAccountInstruction(publicKey, treasuryLbAta, treasuryPk, lbMintPda, TOKEN_2022)); }

      if (!useAmplifier) {
        // ── mint_lb ──────────────────────────────────────────────────
        const data = Buffer.concat([
          Buffer.from(DISC_MINT_LB),
          encodeU64LE(brainsCost),
        ]);
        ixs.push(new TransactionInstruction({
          programId,
          keys: [
            { pubkey: publicKey,               isSigner: true,  isWritable: true  }, // 0  buyer
            { pubkey: statePda,                isSigner: false, isWritable: true  }, // 1  state
            { pubkey: lbMintPda,               isSigner: false, isWritable: true  }, // 2  lb_mint
            { pubkey: mintAuthPda,             isSigner: false, isWritable: false }, // 3  lb_mint_authority
            { pubkey: buyerLbAta,              isSigner: false, isWritable: true  }, // 4  buyer_lb_ata
            { pubkey: BRAINS_MINT_PK,          isSigner: false, isWritable: true  }, // 5  brains_mint
            { pubkey: buyerBrainsAta,          isSigner: false, isWritable: true  }, // 6  buyer_brains_ata
            { pubkey: treasuryPk,              isSigner: false, isWritable: true  }, // 7  treasury
            { pubkey: treasuryLbAta,           isSigner: false, isWritable: true  }, // 8  treasury_lb_ata
            { pubkey: TOKEN_2022,              isSigner: false, isWritable: false }, // 9  token_2022_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 10 system_program
          ],
          data,
        }));

      } else {
        // ── combo_mint_lb ─────────────────────────────────────────────
        const buyerXnmAta     = getAssociatedTokenAddressSync(XNM_MINT_PK,  publicKey,  false, TOKEN_2022);
        const buyerXuniAta    = getAssociatedTokenAddressSync(XUNI_MINT_PK, publicKey,  false, TOKEN_2022);
        const buyerXblkAta    = getAssociatedTokenAddressSync(XBLK_MINT_PK, publicKey,  false, TOKEN_2022);
        const treasuryXnmAta  = getAssociatedTokenAddressSync(XNM_MINT_PK,  treasuryPk, false, TOKEN_2022);
        const treasuryXuniAta = getAssociatedTokenAddressSync(XUNI_MINT_PK, treasuryPk, false, TOKEN_2022);
        const treasuryXblkAta = getAssociatedTokenAddressSync(XBLK_MINT_PK, treasuryPk, false, TOKEN_2022);

        // Create treasury Xenblocks ATAs if needed
        for (const [mint, ata, owner] of [
          [XNM_MINT_PK,  treasuryXnmAta,  treasuryPk],
          [XUNI_MINT_PK, treasuryXuniAta, treasuryPk],
          [XBLK_MINT_PK, treasuryXblkAta, treasuryPk],
        ] as [PublicKey, PublicKey, PublicKey][]) {
          try { await getAccount(connection, ata, 'confirmed', TOKEN_2022); }
          catch { ixs.push(createAssociatedTokenAccountInstruction(publicKey, ata, owner, mint, TOKEN_2022)); }
        }

        const data = Buffer.concat([
          Buffer.from(DISC_COMBO_MINT_LB),
          encodeU64LE(brainsCost),
          encodeU64LE(xnmAmount),
          encodeU64LE(xuniAmount),
          encodeU64LE(xblkAmount),
        ]);

        ixs.push(new TransactionInstruction({
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

      // Build versioned transaction (v0) — better compatibility with Backpack mobile
      const message = new TransactionMessage({
        payerKey:    publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const vtx = new VersionedTransaction(message);

      setStatus('Awaiting wallet approval…');
      // sendTransaction with skipPreflight bypasses Backpack mobile's internal
      // Token-2022 simulation which incorrectly rejects transfer fee CPIs (0xbc4).
      const sig = await sendTransaction(vtx, connection, {
        skipPreflight: true,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });

      setStatus('Confirming…');
      for (let i = 0; i < 40; i++) {
        if (i) await new Promise(r => setTimeout(r, 1500));
        const s = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (s?.value?.err) throw new Error('On-chain error: ' + JSON.stringify(s.value.err));
        const conf = s?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') break;
      }

      setStatus('✅');
      setMintReceipt({
        sig, lbOut, brainsCost, xntCost,
        xnmAmt: useAmplifier ? xnmAmount : 0,
        xuniAmt: useAmplifier ? xuniAmount : 0,
        xblkAmt: useAmplifier ? xblkAmount : 0,
        isCombo: useAmplifier,
      });

      // Refresh everything after 2s for chain to settle
      setTimeout(() => {
        fetchBalances();
        fetchGlobalState();
        fetchBurnStats();
      }, 2000);

    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0, 120) ?? 'Transaction failed'}`);
    } finally { setPending(false); }
  }, [publicKey, sendTransaction, canAfford, paused, amount, brainsCost, xntCost,
      useAmplifier, xnmAmount, xuniAmount, xblkAmount, lbOut, fetchGlobalState, fetchBalances, fetchBurnStats, connection]);

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────

  const xntDisplay = (currentTier.xntLamports / LAMPORTS_PER_SOL).toFixed(2);

  return (
    <>
      <style>{`
        @keyframes lw-pulse   { 0%,100%{opacity:.7} 50%{opacity:1} }
        @keyframes lw-spin    { to{transform:rotate(360deg)} }
      `}</style>

      {/* Paused banner */}
      {paused && (
        <div style={{ marginBottom:16, padding:'12px 18px', borderRadius:10,
          background:'rgba(255,50,50,.1)', border:'1px solid rgba(255,50,50,.4)',
          fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:900, color:'#ff6666',
          textAlign:'center', letterSpacing:1 }}>
          ⏸ MINTING IS PAUSED — Check back soon
        </div>
      )}

      {/* Section tabs */}
      <div style={{ display:'flex', gap:4, marginBottom: isMobile ? 16 : 22,
        background:'rgba(255,255,255,.03)', borderRadius:12, padding:4,
        border:'1px solid rgba(255,255,255,.06)' }}>
        {([
          { id:'mint',      label: isMobile ? '🔥 MINT'  : '🔥 MINT LB',      sub:'burn BRAINS → get LB' },
          { id:'tiers',     label: isMobile ? '📊 TIERS' : '📊 TIER PRICING', sub:'costs & progress'     },
          { id:'amplifier', label: isMobile ? '⚡ AMP'   : '⚡ AMPLIFIER',     sub:'xenblocks bonus'       },
          { id:'info',      label: isMobile ? '📖 INFO'  : '📖 TOKENOMICS',   sub:'how it works'         },
        ] as { id: typeof activeTab; label: string; sub: string }[]).map(t => (
          <button key={t.id} type="button" onClick={() => setActiveTab(t.id)}
            style={{
              flex:1, padding: isMobile ? '8px 4px' : '10px 8px',
              background: activeTab === t.id ? 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.08))' : 'transparent',
              border: activeTab === t.id ? '1px solid rgba(0,212,255,.35)' : '1px solid transparent',
              borderRadius:9, cursor:'pointer', transition:'all .15s',
              fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700,
              color: activeTab === t.id ? '#00d4ff' : '#4a6a8a',
              display:'flex', flexDirection:'column', alignItems:'center', gap:2,
            }}>
            <span>{t.label}</span>
            <span style={{ fontSize:6, color: activeTab === t.id ? 'rgba(0,212,255,.5)' : '#3a5a7a', letterSpacing:1, fontWeight:400 }}>{t.sub}</span>
          </button>
        ))}
      </div>

      {/* ══ MINT TAB ══ */}
      {activeTab === 'mint' && (
        <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 340px', gap: isMobile ? 14 : 20, animation:'fadeUp .3s ease both' }}>

          <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 12 : 14 }}>

            {/* Stats strip */}
            <div style={{ display:'flex', gap:0, background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.07)', borderRadius:10, overflow:'hidden' }}>
              {[
                { label:'LB MINTED',   value: fmt(mintedTotal),                col:'#00c98d' },
                { label:'REMAINING',   value: fmt(TOTAL_SUPPLY - mintedTotal), col:'#bf5af2' },
                { label:'ACTIVE TIER', value: TIER_LABELS[tierIdx],            col: c        },
                { label:'CAP',         value:'100,000',                        col:'#00d4ff' },
              ].map(({ label, value, col }, i, arr) => (
                <React.Fragment key={label}>
                  <div style={{ flex:1, textAlign:'center', padding: isMobile ? '8px 4px' : '10px 8px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 14, fontWeight:900, color:col, lineHeight:1, marginBottom:2 }}>{value}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 5 : 6, color:'#9abacf', letterSpacing:1 }}>{label}</div>
                  </div>
                  {i < arr.length - 1 && <div style={{ width:1, alignSelf:'stretch', background:'rgba(255,255,255,.08)' }} />}
                </React.Fragment>
              ))}
            </div>

            {/* Burn stats strip */}
            <div style={{ display:'flex', gap:0, background:'rgba(255,50,50,.04)', border:'1px solid rgba(255,100,100,.1)', borderRadius:10, overflow:'hidden' }}>
              {[
                { label:'BRAINS BURNED', value: mintedTotal > 0 ? '~' + fmt(Math.round(mintedTotal * 8)) + '+' : '—', col:'#ff6a6a' },
                { label:'XNM BURNED',    value: xnmBurned  !== null ? fmt(xnmBurned)  : '—', col:'#7a9ab8' },
                { label:'XUNI BURNED',   value: xuniBurned !== null ? fmt(xuniBurned) : '—', col:'#7a9ab8' },
                { label:'XBLK BURNED',   value: xblkBurned !== null ? xblkBurned.toFixed(1) : '—', col:'#7a9ab8' },
              ].map(({ label, value, col }, i, arr) => (
                <React.Fragment key={label}>
                  <div style={{ flex:1, textAlign:'center', padding: isMobile ? '6px 4px' : '8px 6px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900, color:col, lineHeight:1, marginBottom:2 }}>{value}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 5 : 6, color:'#6a8aaa', letterSpacing:1 }}>🔥 {label}</div>
                  </div>
                  {i < arr.length - 1 && <div style={{ width:1, alignSelf:'stretch', background:'rgba(255,255,255,.06)' }} />}
                </React.Fragment>
              ))}
            </div>

            {/* Active tier card */}
            <div style={{ background:`linear-gradient(135deg,rgba(${rgb},.08),rgba(255,255,255,.02))`, border:`1px solid ${c}44`, borderRadius:16, padding: isMobile ? '16px' : '20px 22px', position:'relative', overflow:'hidden' }}>
              <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1, background:`linear-gradient(90deg,transparent,${c},transparent)` }} />
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf', letterSpacing:2, marginBottom:4 }}>ACTIVE TIER</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 18 : 22, fontWeight:900, color:c }}>{TIER_LABELS[tierIdx]}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 22 : 28, fontWeight:900, color:c }}>{currentTier.brains}</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf' }}>BRAINS / LB</div>
                </div>
              </div>
              <div style={{ marginBottom:6 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                  <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf' }}>{fmt(tierMinted)} / {fmt(TIER_SIZE)} minted this tier</span>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:c }}>{fmt(tierRemaining)} left</span>
                </div>
                <div style={{ height:8, background:'rgba(255,255,255,.06)', borderRadius:4, overflow:'hidden' }}>
                  <div style={{ height:'100%', borderRadius:4, width:`${(tierMinted / TIER_SIZE) * 100}%`, background:`linear-gradient(90deg,${c}88,${c})`, boxShadow:`0 0 10px ${c}66`, transition:'width 1s ease' }} />
                </div>
              </div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#6a8aaa' }}>+ {xntDisplay} XNT fee per LB minted (base + bonus)</div>
            </div>

            {/* Amount selector */}
            <div style={{ background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.08)', borderRadius:14, padding: isMobile ? '16px' : '20px 22px' }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf', letterSpacing:2, marginBottom:12 }}>AMOUNT TO MINT</div>
              <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
                {[1, 5, 10, 25, 50, 100].map(v => (
                  <button key={v} type="button" onClick={() => setAmount(Math.min(v, tierRemaining))}
                    style={{ padding: isMobile ? '6px 10px' : '7px 14px', borderRadius:8, cursor:'pointer', transition:'all .12s',
                      fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700,
                      background: amount === v ? `rgba(${rgb},.18)` : 'rgba(255,255,255,.04)',
                      border:`1px solid ${amount === v ? c + '66' : 'rgba(255,255,255,.08)'}`,
                      color: amount === v ? c : '#4a6a8a' }}>{v}</button>
                ))}
                <input type="number" min={1} max={tierRemaining} value={amount}
                  onChange={e => setAmount(Math.max(1, Math.min(tierRemaining, parseInt(e.target.value) || 1)))}
                  style={{ width: isMobile ? 60 : 72, padding:'7px 10px', textAlign:'center',
                    background:'rgba(255,255,255,.04)', border:`1px solid rgba(${rgb},.3)`, borderRadius:8, outline:'none',
                    fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#e0f0ff', caretColor:c }} />
              </div>

              {/* Cost breakdown */}
              <div style={{ background:'rgba(0,0,0,.2)', borderRadius:10, border:'1px solid rgba(255,255,255,.06)', overflow:'hidden', marginBottom:14 }}>
                {[
                  { label:'LB YOU RECEIVE',  value:`${fmt(lbOut)} LB`,          color:c         },
                  { label:'BRAINS TO BURN',  value:`${fmt(brainsCost)} BRAINS`, color:'#ff6a6a' },
                  { label:'XNT PLATFORM FEE',value:`${xntCost} XNT`,            color:'#ffaa00' },
                  ...(useAmplifier && xnmAmount  > 0 ? [{ label:'XNM',  value:`${fmt(xnmAmount)} → +${xnmLb} LB`,  color:'#7a9ab8' }] : []),
                  ...(useAmplifier && xuniAmount > 0 ? [{ label:'XUNI', value:`${fmt(xuniAmount)} → +${xuniLb} LB`, color:'#7a9ab8' }] : []),
                  ...(useAmplifier && xblkAmount > 0 ? [{ label:'XBLK', value:`${xblkAmount} → +${xblkLb} LB`,      color:'#7a9ab8' }] : []),
                ].map(({ label, value, color }, i, arr) => (
                  <div key={label} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'9px 14px',
                    borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf' }}>{label}</span>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 12, fontWeight:900, color }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* Amplifier toggle */}
              <div style={{ background: useAmplifier ? 'linear-gradient(135deg,rgba(255,170,0,.08),rgba(191,90,242,.05))' : 'rgba(255,255,255,.02)',
                border:`1px solid ${useAmplifier ? 'rgba(255,170,0,.35)' : 'rgba(255,255,255,.08)'}`,
                borderRadius:12, padding: isMobile ? '12px 14px' : '14px 16px', transition:'all .2s' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: useAmplifier ? 14 : 0 }}>
                  <div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900,
                      color: useAmplifier ? '#ffaa00' : '#4a6a8a', letterSpacing:1 }}>⚡ XENBLOCKS AMPLIFIER</div>
                    <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color: useAmplifier ? '#8aaac0' : '#3a5a7a', marginTop:2 }}>
                      {useAmplifier ? `+${xnmLb + xuniLb + xblkLb} bonus LB · 50% burned, 50% → treasury` : 'burn XNM, XUNI, XBLK for bonus LB'}
                    </div>
                  </div>
                  <button type="button" onClick={() => setUseAmplifier(p => !p)}
                    style={{ position:'relative', width:48, height:26, borderRadius:13, border:'none', cursor:'pointer', outline:'none', flexShrink:0,
                      background: useAmplifier ? 'linear-gradient(135deg,#ffaa00,#ff6600)' : 'rgba(255,255,255,.1)',
                      boxShadow: useAmplifier ? '0 0 12px rgba(255,170,0,.4)' : 'none', transition:'all .25s' }}>
                    <span style={{ position:'absolute', top:3, left: useAmplifier ? 25 : 3, width:20, height:20, borderRadius:'50%', background:'#fff',
                      boxShadow: useAmplifier ? '0 0 6px rgba(255,170,0,.6)' : '0 1px 3px rgba(0,0,0,.3)', transition:'left .25s',
                      display:'flex', alignItems:'center', justifyContent:'center', fontSize:10 }}>{useAmplifier ? '⚡' : '○'}</span>
                  </button>
                </div>

                {useAmplifier && (
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {[
                      { label:'XNM',  step:1_000, val:xnmAmount,  set:setXnmAmount,  bal:xnmBalance,  lb:xnmLb,  color:'#00d4ff', rgb:'0,212,255',   hint:'multiples of 1,000 or 0', presets:[0, 1_000, 2_000, 5_000, 10_000] },
                      { label:'XUNI', step:500,   val:xuniAmount, set:setXuniAmount, bal:xuniBalance, lb:xuniLb, color:'#bf5af2', rgb:'191,90,242', hint:'multiples of 500 or 0',   presets:[0, 500, 1_000, 2_000, 5_000] },
                      { label:'XBLK', step:1,     val:xblkAmount, set:setXblkAmount, bal:xblkBalance, lb:xblkLb, color:'#00c98d', rgb:'0,201,141', hint:'whole numbers or 0',  presets:[0, 1, 2, 3, 5, 10] },
                    ].map(({ label, step, val, set, bal, lb, color, rgb: r, hint, presets }) => {
                      const enough = bal !== null && bal >= val;
                      return (
                        <div key={label} style={{ background:`rgba(${r},.06)`,
                          border:`1px solid ${enough ? `rgba(${r},.25)` : val > 0 && bal !== null ? 'rgba(255,50,50,.3)' : `rgba(${r},.15)`}`,
                          borderRadius:10, padding:'10px 12px' }}>
                          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:900, color }}>{label}</span>
                              <span style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#6a8aaa' }}>{hint}</span>
                              {lb > 0 && <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                                color:'#00c98d', background:'rgba(0,201,141,.1)', border:'1px solid rgba(0,201,141,.2)', borderRadius:4, padding:'1px 6px' }}>+{lb} LB</span>}
                            </div>
                            {publicKey && (
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color: enough ? color : bal === null ? '#6a8aaa' : '#ff6666' }}>
                                {bal === null ? '…' : `${fmt(bal)} bal`}
                              </span>
                            )}
                          </div>
                          <div style={{ display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
                            {presets.map(v => (
                              <button key={v} type="button" onClick={() => set(v)}
                                style={{ padding:'4px 8px', borderRadius:6, cursor:'pointer',
                                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700,
                                  background: val === v ? `rgba(${r},.2)` : 'rgba(255,255,255,.04)',
                                  border:`1px solid ${val === v ? color + '55' : 'rgba(255,255,255,.08)'}`,
                                  color: val === v ? color : '#4a6a8a', transition:'all .1s' }}>{fmt(v)}</button>
                            ))}
                            <input type="number" min={step} step={step} value={val}
                              onChange={e => { const v = parseInt(e.target.value); if (isNaN(v) || v === 0) { set(0); return; } set(Math.max(step, Math.round(v / step) * step)); }}
                              style={{ width: isMobile ? 64 : 76, padding:'4px 8px', textAlign:'center',
                                background:'rgba(255,255,255,.04)', border:`1px solid rgba(${r},.3)`, borderRadius:6, outline:'none',
                                fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#e0f0ff', caretColor:color }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Balances */}
            {publicKey && (
              <div style={{ display:'flex', gap:8 }}>
                {[
                  { label:'BRAINS', val: brainsBalance, need: brainsCost,                   color:'#bf5af2', suffix:'BRAINS' },
                  { label:'XNT',    val: xntBalance,    need: xntCost + XNT_RENT_BUFFER,     color:'#00c98d', suffix:'XNT'    },
                ].map(({ label, val, need, color, suffix }) => {
                  const enough = val !== null && val >= need;
                  return (
                    <div key={label} style={{ flex:1, padding:'10px 12px', borderRadius:10, textAlign:'center',
                      background: enough ? 'rgba(255,255,255,.03)' : 'rgba(255,50,50,.05)',
                      border:`1px solid ${enough ? color + '22' : 'rgba(255,50,50,.2)'}` }}>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 15, fontWeight:900,
                        color: enough ? color : '#ff6666', marginBottom:2 }}>
                        {val === null ? '…' : suffix === 'XNT' ? val.toFixed(3) : fmt(val)}
                      </div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#6a8aaa', letterSpacing:1.5 }}>{suffix} BALANCE</div>
                      {!enough && val !== null && (
                        <div style={{ fontFamily:'Sora,sans-serif', fontSize:8, color:'#ff6666', marginTop:2 }}>
                          need {suffix === 'XNT' ? need.toFixed(3) : fmt(need)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Mint Receipt */}
            {mintReceipt && (
              <div style={{
                borderRadius: 14, overflow: 'hidden',
                border: '1px solid rgba(0,201,141,.35)',
                background: 'linear-gradient(135deg,rgba(0,201,141,.08),rgba(0,150,100,.04))',
                marginBottom: 8,
              }}>
                {/* Header */}
                <div style={{
                  padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  borderBottom: '1px solid rgba(0,201,141,.15)',
                  background: 'rgba(0,201,141,.06)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>✅</span>
                    <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 900, color: '#00c98d', letterSpacing: 2 }}>
                      MINT CONFIRMED
                    </span>
                  </div>
                  <a href={`https://explorer.mainnet.x1.xyz/tx/${mintReceipt.sig}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{
                      fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700,
                      color: '#00d4ff', letterSpacing: 1.5, textDecoration: 'none',
                      padding: '4px 10px', borderRadius: 6,
                      border: '1px solid rgba(0,212,255,.3)',
                      background: 'rgba(0,212,255,.08)',
                      display: 'flex', alignItems: 'center', gap: 5,
                    }}>
                    VIEW TX ↗
                  </a>
                </div>

                {/* LB Received — hero number */}
                <div style={{ padding: '14px 16px 10px', textAlign: 'center', borderBottom: '1px solid rgba(0,201,141,.1)' }}>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#5a8a7a', letterSpacing: 2, marginBottom: 4 }}>
                    LAB WORK TOKENS RECEIVED
                  </div>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 32, fontWeight: 900, color: '#00c98d', letterSpacing: 2, lineHeight: 1,
                    textShadow: '0 0 20px rgba(0,201,141,.5)' }}>
                    +{fmt(mintReceipt.lbOut)} <span style={{ fontSize: 16, color: '#00a070' }}>LB</span>
                  </div>
                </div>

                {/* Burn breakdown */}
                <div style={{ padding: '10px 16px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, color: '#4a6a5a', letterSpacing: 2, marginBottom: 2 }}>
                    BURNED / PAID
                  </div>

                  {/* BRAINS burned */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12 }}>🔥</span>
                      <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#9abacf' }}>BRAINS Burned</span>
                    </div>
                    <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700, color: '#ff6644' }}>
                      -{fmt(mintReceipt.brainsCost)}
                    </span>
                  </div>

                  {/* XNT fee */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12 }}>💎</span>
                      <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#9abacf' }}>XNT Platform Fee</span>
                    </div>
                    <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700, color: '#00d4ff' }}>
                      -{mintReceipt.xntCost.toFixed(4)} XNT
                    </span>
                  </div>

                  {/* Xenblocks assets if combo */}
                  {mintReceipt.isCombo && (
                    <>
                      {mintReceipt.xnmAmt > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12 }}>⚡</span>
                            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#9abacf' }}>XNM (50% burned)</span>
                          </div>
                          <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700, color: '#ffaa33' }}>
                            -{fmt(mintReceipt.xnmAmt)} <span style={{ fontSize: 9, color: '#aa7722' }}>+{fmt(Math.floor(mintReceipt.xnmAmt / 1000))} LB</span>
                          </span>
                        </div>
                      )}
                      {mintReceipt.xuniAmt > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12 }}>🔮</span>
                            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#9abacf' }}>XUNI (50% burned)</span>
                          </div>
                          <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700, color: '#bf5af2' }}>
                            -{fmt(mintReceipt.xuniAmt)} <span style={{ fontSize: 9, color: '#8833cc' }}>+{fmt(Math.floor(mintReceipt.xuniAmt / 500) * 4)} LB</span>
                          </span>
                        </div>
                      )}
                      {mintReceipt.xblkAmt > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12 }}>🧱</span>
                            <span style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#9abacf' }}>XBLK (50% burned)</span>
                          </div>
                          <span style={{ fontFamily: 'Orbitron,monospace', fontSize: 12, fontWeight: 700, color: '#00c98d' }}>
                            -{fmt(mintReceipt.xblkAmt)} <span style={{ fontSize: 9, color: '#008855' }}>+{fmt(mintReceipt.xblkAmt * 8)} LB</span>
                          </span>
                        </div>
                      )}
                    </>
                  )}

                  {/* TX sig */}
                  <div style={{ marginTop: 6, padding: '7px 10px', borderRadius: 7,
                    background: 'rgba(0,0,0,.25)', border: '1px solid rgba(255,255,255,.06)' }}>
                    <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: '#4a6070', letterSpacing: 1.5, marginBottom: 3 }}>TX SIGNATURE</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 9, color: '#5a8090', wordBreak: 'break-all', lineHeight: 1.5 }}>
                      {mintReceipt.sig}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Status (loading / error) */}
            {status && status !== '✅' && (
              <div style={{ padding:'10px 14px', borderRadius:10,
                background: status.startsWith('❌') ? 'rgba(255,50,50,.08)' : 'rgba(191,90,242,.08)',
                border:`1px solid ${status.startsWith('❌') ? 'rgba(255,50,50,.25)' : 'rgba(191,90,242,.3)'}`,
                fontFamily:'Sora,sans-serif', fontSize:11,
                color: status.startsWith('❌') ? '#ff6666' : '#bf5af2' }}>
                {status}
              </div>
            )}

            {/* Mint button */}
            {!publicKey ? (
              <div style={{ padding:'16px', textAlign:'center', borderRadius:12,
                background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.08)',
                fontFamily:'Orbitron,monospace', fontSize:11, color:'#4a6a8a' }}>
                🔌 CONNECT WALLET TO MINT
              </div>
            ) : (
              <button type="button" onClick={handleMint} disabled={pending || !canAfford || paused}
                style={{ width:'100%', padding: isMobile ? '14px 0' : '16px 0',
                  background: canAfford ? `linear-gradient(135deg,rgba(${rgb},.25),rgba(${rgb},.1))` : 'rgba(255,255,255,.04)',
                  border:`1px solid ${canAfford ? c + '66' : 'rgba(255,255,255,.1)'}`, borderRadius:12,
                  cursor:(pending || !canAfford || paused) ? 'not-allowed' : 'pointer',
                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900,
                  color: canAfford ? c : '#4a6a8a', opacity: pending ? .7 : 1,
                  display:'flex', alignItems:'center', justifyContent:'center', gap:10,
                  boxShadow: canAfford ? `0 0 20px rgba(${rgb},.2)` : 'none', transition:'all .2s' }}>
                {pending
                  ? <><div style={{ width:14, height:14, borderRadius:'50%', border:`2px solid rgba(${rgb},.2)`, borderTop:`2px solid ${c}`, animation:'lw-spin .8s linear infinite' }} />MINTING…</>
                  : useAmplifier
                  ? `⚡ COMBO MINT ${fmt(lbOut)} LB — ${fmt(brainsCost)} BRAINS + ${xntCost} XNT`
                  : `🔥 MINT ${fmt(lbOut)} LB — ${fmt(brainsCost)} BRAINS + ${xntCost} XNT`
                }
              </button>
            )}
          </div>

          {/* Right — global progress */}
          <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 12 : 14 }}>
            <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)', borderRadius:16, padding: isMobile ? '16px' : '20px 22px' }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf', letterSpacing:2, marginBottom:12 }}>GLOBAL MINT PROGRESS</div>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 20 : 26, fontWeight:900, color:c }}>{fmt(mintedTotal)}</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#4a6a8a', alignSelf:'flex-end', marginBottom:3 }}>/ 100,000 LB</span>
              </div>
              <div style={{ height:12, background:'rgba(255,255,255,.06)', borderRadius:6, overflow:'hidden', display:'flex', marginBottom:8 }}>
                {TIER_COLORS.map((t, i) => {
                  const tStart  = i * TIER_SIZE;
                  const tMinted = Math.max(0, Math.min(mintedTotal - tStart, TIER_SIZE));
                  const segW    = (tMinted / TOTAL_SUPPLY) * 100;
                  if (segW === 0) return null;
                  return <div key={i} style={{ width:`${segW}%`, height:'100%',
                    background:`linear-gradient(90deg,${t.color}88,${t.color})`,
                    boxShadow: i === tierIdx ? `0 0 8px ${t.color}88` : 'none' }} />;
                })}
              </div>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#6a8aaa' }}>{totalPct.toFixed(2)}% minted</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf' }}>{fmt(TOTAL_SUPPLY - mintedTotal)} remaining</span>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginTop:12 }}>
                {TIER_COLORS.map((t, i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:6, opacity: i < tierIdx ? .4 : 1 }}>
                    <div style={{ width:8, height:8, borderRadius:2, background:t.color, flexShrink:0 }} />
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color: i === tierIdx ? t.color : '#6a8aaa' }}>
                      {TIER_LABELS[i]} · {tierRates[i]?.brains ?? '?'}B / {((tierRates[i]?.xntLamports ?? 0) / LAMPORTS_PER_SOL).toFixed(2)} XNT
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Amplifier teaser */}
            <div style={{ background:'linear-gradient(135deg,rgba(255,170,0,.06),rgba(191,90,242,.04))', border:'1px dashed rgba(255,170,0,.25)', borderRadius:14, padding: isMobile ? '14px' : '18px 20px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900, color:'#ffaa00', letterSpacing:1 }}>⚡ XENBLOCKS AMPLIFIER</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00c98d', background:'rgba(0,201,141,.1)', border:'1px solid rgba(0,201,141,.25)', borderRadius:4, padding:'2px 7px' }}>LIVE</div>
              </div>
              <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 9 : 10, color:'#8aaac0', lineHeight:1.6, marginBottom:10 }}>
                Add Xenblocks assets for bonus LB. Min bundle: <span style={{ color:'#ffaa00', fontWeight:700 }}>+{MIN_COMBO_BONUS} LB</span>. 50% burned, 50% → treasury.
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {[
                  { t:'XNM',  a:'1,000', bal: xnmBalance,  need: 1000 },
                  { t:'XUNI', a:'500',   bal: xuniBalance,  need: 500  },
                  { t:'XBLK', a:'1',     bal: xblkBalance,  need: 1    },
                ].map(({ a, t, bal, need }) => {
                  const enough = bal !== null && bal >= need;
                  return (
                    <div key={t} style={{ fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                      color: enough ? '#ffaa00' : bal === null ? '#6a8aaa' : '#ff6666',
                      background: enough ? 'rgba(255,170,0,.08)' : 'rgba(255,255,255,.04)',
                      border:`1px solid ${enough ? 'rgba(255,170,0,.25)' : 'rgba(255,255,255,.08)'}`,
                      borderRadius:6, padding:'4px 10px' }}>
                      {a} {t}{publicKey && bal !== null ? ` · ${fmt(bal)}` : ''}
                    </div>
                  );
                })}
              </div>
              <button type="button" onClick={() => setActiveTab('amplifier')}
                style={{ marginTop:10, padding:'6px 14px', borderRadius:8, cursor:'pointer',
                  fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                  color:'#ffaa00', background:'rgba(255,170,0,.08)', border:'1px solid rgba(255,170,0,.2)' }}>
                LEARN MORE ↗
              </button>
            </div>

            {/* Fee notice */}
            <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'rgba(191,90,242,.04)', border:'1px solid rgba(191,90,242,.12)', borderRadius:10, opacity:.7 }}>
              <span style={{ fontSize:14 }}>💎</span>
              <div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, color:'#8a5aaa', letterSpacing:.5 }}>XNT FEES → PROTOCOL TREASURY · BRAINS BURNED FOREVER</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#5a3a7a', marginTop:2 }}>
                  {TREASURY_WALLET.slice(0,12)}…{TREASURY_WALLET.slice(-6)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ TIERS TAB ══ */}
      {activeTab === 'tiers' && (
        <div style={{ animation:'fadeUp .3s ease both' }}>
          <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 10 : 12, marginBottom:20 }}>
            {TIER_COLORS.map((_, i) => (
              <TierBar key={i} tierIdx={i} minted={mintedTotal} isCurrent={i === tierIdx} isMobile={isMobile}
                brains={tierRates[i]?.brains ?? 0} xntLamports={tierRates[i]?.xntLamports ?? 0} />
            ))}
          </div>
          <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)', borderRadius:16, overflow:'hidden' }}>
            <div style={{ padding: isMobile ? '14px 16px' : '16px 22px', borderBottom:'1px solid rgba(255,255,255,.06)',
              fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:900, color:'#fff', letterSpacing:1 }}>FULL MINT CYCLE</div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontFamily:'Orbitron,monospace' }}>
                <thead>
                  <tr style={{ background:'rgba(255,255,255,.03)' }}>
                    {['TIER','LB RANGE','BRAINS/LB','XNT/LB','TOTAL BRAINS','TOTAL XNT'].map(h => (
                      <th key={h} style={{ padding: isMobile ? '8px 10px' : '10px 16px', textAlign:'left',
                        fontSize: isMobile ? 6 : 7, color:'#9abacf', letterSpacing:1.5, fontWeight:700,
                        borderBottom:'1px solid rgba(255,255,255,.06)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TIER_COLORS.map((t, i) => {
                    const br  = tierRates[i]?.brains ?? 0;
                    const xnt = (tierRates[i]?.xntLamports ?? 0) / LAMPORTS_PER_SOL;
                    return (
                      <tr key={i} style={{ background: i === tierIdx ? `rgba(${t.rgb},.05)` : 'transparent',
                        borderBottom: i < 3 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                        <td style={{ padding: isMobile ? '8px 10px' : '10px 16px', fontSize: isMobile ? 9 : 10, fontWeight:900, color:t.color }}>{TIER_LABELS[i]}</td>
                        <td style={{ padding: isMobile ? '8px 10px' : '10px 16px', fontSize:8, color:'#9abacf' }}>{fmt(i*TIER_SIZE+1)}–{fmt((i+1)*TIER_SIZE)}</td>
                        <td style={{ padding: isMobile ? '8px 10px' : '10px 16px', fontSize: isMobile ? 10 : 11, fontWeight:700, color:'#ff6a6a' }}>{br}</td>
                        <td style={{ padding: isMobile ? '8px 10px' : '10px 16px', fontSize: isMobile ? 10 : 11, fontWeight:700, color:'#ffaa00' }}>{xnt.toFixed(2)}</td>
                        <td style={{ padding: isMobile ? '8px 10px' : '10px 16px', fontSize:9, color:'#c0d0e0' }}>{fmt(br * TIER_SIZE)}</td>
                        <td style={{ padding: isMobile ? '8px 10px' : '10px 16px', fontSize:9, color:'#c0d0e0' }}>{fmt(xnt * TIER_SIZE, 0)} XNT</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══ AMPLIFIER TAB ══ */}
      {activeTab === 'amplifier' && (
        <div style={{ animation:'fadeUp .3s ease both' }}>
          <div style={{ background:'linear-gradient(135deg,rgba(255,170,0,.08),rgba(191,90,242,.05))', border:'1px solid rgba(255,170,0,.3)', borderRadius:16, padding: isMobile ? '20px 16px' : '28px 28px', marginBottom: isMobile ? 14 : 18, position:'relative', overflow:'hidden' }}>
            <div style={{ position:'absolute', top:0, left:0, right:0, height:2, background:'linear-gradient(90deg,transparent,#ffaa00,rgba(191,90,242,.8),transparent)' }} />
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
              <span style={{ fontSize: isMobile ? 22 : 28 }}>⚡</span>
              <div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 16, fontWeight:900, color:'#ffaa00', letterSpacing:1.5 }}>XENBLOCKS AMPLIFIER</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf', marginTop:2 }}>for the deepest believers in the X1 ecosystem</div>
              </div>
              <div style={{ marginLeft:'auto', fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, color:'#00c98d', background:'rgba(0,201,141,.1)', border:'1px solid rgba(0,201,141,.3)', borderRadius:6, padding:'4px 12px' }}>LIVE</div>
            </div>
            <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#9abacf', lineHeight:1.7, marginBottom:16 }}>
              A standard mint burns BRAINS and receives LB at the current tier rate. A combo mint burns BRAINS <em>plus</em> Xenblocks assets and receives bonus LB on top — dramatically more Lab Work for the same BRAINS cost. Bonus scales with how much you put in. Minimum bundle gives <span style={{ color:'#ffaa00', fontWeight:700 }}>+{MIN_COMBO_BONUS} LB</span>.
            </div>
          </div>

          {/* Bundle cards */}
          <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)', borderRadius:14, padding: isMobile ? '16px' : '20px 22px', marginBottom: isMobile ? 14 : 18 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:900, color:'#fff', letterSpacing:1.5, marginBottom:14 }}>MINIMUM XENBLOCKS BUNDLE</div>
            <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: isMobile ? 8 : 12 }}>
              {[
                { asset:'XNM',  amount:'1,000', burned:'500 burned',  treasury:'500 → Treasury', lb:'+1 LB',  color:'#00d4ff', rgb:'0,212,255',   bal: xnmBalance,  need: 1000 },
                { asset:'XUNI', amount:'500',   burned:'250 burned',  treasury:'250 → Treasury', lb:'+4 LB',  color:'#bf5af2', rgb:'191,90,242', bal: xuniBalance, need: 500  },
                { asset:'XBLK', amount:'1',     burned:'0.5 burned',  treasury:'0.5 → Treasury', lb:'+8 LB',  color:'#00c98d', rgb:'0,201,141', bal: xblkBalance, need: 1    },
              ].map(({ asset, amount: a, burned, treasury, lb, color, rgb: r, bal, need }) => {
                const enough = bal !== null && bal >= need;
                return (
                  <div key={asset} style={{ background:`rgba(${r},.06)`, border:`1px solid ${enough ? `rgba(${r},.3)` : bal === null ? `rgba(${r},.2)` : 'rgba(255,50,50,.3)'}`, borderRadius:12, padding: isMobile ? '14px' : '16px 18px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 18, fontWeight:900, color, marginBottom:2 }}>{a}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:700, color, marginBottom:2 }}>{asset}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#00c98d', marginBottom:8 }}>{lb}</div>
                    {publicKey && (
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color: enough ? color : bal === null ? '#6a8aaa' : '#ff6666',
                        marginBottom:8, background: enough ? `rgba(${r},.08)` : 'rgba(255,50,50,.06)',
                        border:`1px solid ${enough ? `rgba(${r},.2)` : 'rgba(255,50,50,.2)'}`, borderRadius:5, padding:'3px 8px', display:'inline-block' }}>
                        {bal === null ? 'loading…' : `${fmt(bal)} in wallet`}{!enough && bal !== null && ` · need ${fmt(need)}`}
                      </div>
                    )}
                    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ fontSize:10 }}>🔥</span>
                        <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#ff6a6a' }}>{burned}</span>
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <span style={{ fontSize:10 }}>🏦</span>
                        <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#00c98d' }}>{treasury}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Rates table */}
          <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)', borderRadius:14, overflow:'hidden' }}>
            <div style={{ padding: isMobile ? '14px 16px' : '16px 22px', borderBottom:'1px solid rgba(255,255,255,.06)', fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:900, color:'#fff', letterSpacing:1 }}>XENBLOCKS LB RATES</div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontFamily:'Orbitron,monospace' }}>
                <thead>
                  <tr style={{ background:'rgba(255,255,255,.03)' }}>
                    {['ASSET','AMOUNT','LB EARNED','50% BURNED','50% → TREASURY'].map(h => (
                      <th key={h} style={{ padding: isMobile ? '8px 10px' : '10px 16px', textAlign:'left', fontSize: isMobile ? 6 : 7, color:'#9abacf', letterSpacing:1.5, fontWeight:700, borderBottom:'1px solid rgba(255,255,255,.06)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { asset:'XNM',       amount:'1,000', lb:'+1 LB',  burn:'500 XNM',  trs:'500 XNM',  color:'#00d4ff' },
                    { asset:'XUNI',      amount:'500',   lb:'+4 LB',  burn:'250 XUNI', trs:'250 XUNI', color:'#bf5af2' },
                    { asset:'XBLK',      amount:'1',     lb:'+8 LB',  burn:'0.5 XBLK', trs:'0.5 XBLK', color:'#00c98d' },
                    { asset:'MIN BUNDLE',amount:'all 3', lb:'+13 LB', burn:'50% each', trs:'50% each', color:'#ffaa00' },
                  ].map(({ asset, amount: a, lb, burn, trs, color }, i, arr) => (
                    <tr key={asset} style={{ borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none', background: i === arr.length - 1 ? 'rgba(255,170,0,.03)' : 'transparent' }}>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px', fontSize: isMobile ? 10 : 11, fontWeight:900, color }}>{asset}</td>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px', fontSize: isMobile ? 9 : 10, color:'#c0d0e0' }}>{a}</td>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#00c98d' }}>{lb}</td>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px', fontSize: isMobile ? 9 : 10, color:'#ff6a6a' }}>{burn}</td>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px', fontSize: isMobile ? 9 : 10, color:'#00c98d' }}>{trs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══ INFO TAB ══ */}
      {activeTab === 'info' && (
        <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 12 : 16, animation:'fadeUp .3s ease both' }}>
          {[
            { icon:'🔥', title:'THE CORE MECHANISM', color:'#ff6a6a', rgb:'255,106,106',
              body:'To mint LB, you burn BRAINS. Every Lab Work token represents BRAINS that no longer exist. The relationship is permanent and one-directional — BRAINS go in, they never come back, LB comes out.' },
            { icon:'📈', title:'4 PROGRESSIVE TIERS', color:'#00d4ff', rgb:'0,212,255',
              body:'100,000 LB is divided into 4 tranches of 25,000 LB each. Each tier has a higher BRAINS burn rate and XNT fee. Once a tier fills, it closes forever. Early believers pay less. Late arrivals pay more.' },
            { icon:'💎', title:'FIXED SUPPLY — HARD CAP', color:'#00c98d', rgb:'0,201,141',
              body:'Total supply: 100,000 LB. Hard cap enforced on-chain. Every LB in existence was paid for with BRAINS burned permanently and irreversibly.' },
            { icon:'💰', title:'XNT — THE PLATFORM FEE', color:'#ffaa00', rgb:'255,170,0',
              body:'Every LB minted pays an XNT fee to the protocol treasury. Fees are deployed for AMM liquidity seeding, staking infrastructure, farming programs, and ecosystem development. The XNT fee per LB can be adjusted by the admin if XNT price changes significantly.' },
            { icon:'⚡', title:'XENBLOCKS AMPLIFIER', color:'#bf5af2', rgb:'191,90,242',
              body:'Combo mints let you add XNM, XUNI, and XBLK alongside BRAINS to earn bonus LB at no extra XNT cost. 50% of each Xenblocks asset is burned forever, 50% goes to the protocol treasury. Bonus LB scales with the amount you put in.' },
            { icon:'🛡️', title:'ADMIN PAUSE', color:'#8a5aff', rgb:'138,90,255',
              body:'The program includes an admin pause mechanism. If an exploit is detected, minting can be halted immediately to protect user funds.' },
          ].map(({ icon, title, color, rgb: r, body }) => (
            <div key={title} style={{ background:`linear-gradient(135deg,rgba(${r},.06),rgba(255,255,255,.02))`,
              border:`1px solid rgba(${r},.18)`, borderRadius:14,
              padding: isMobile ? '14px 14px 14px 20px' : '18px 22px 18px 26px', position:'relative', overflow:'hidden' }}>
              <div style={{ position:'absolute', top:0, left:0, width:3, bottom:0, background:`linear-gradient(180deg,${color},${color}44)`, borderRadius:'14px 0 0 14px' }} />
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                <span style={{ fontSize:15 }}>{icon}</span>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 11, fontWeight:900, color, letterSpacing:1 }}>{title}</div>
              </div>
              <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 12, color:'#9abacf', lineHeight:1.7 }}>{body}</div>
            </div>
          ))}
          <div style={{ background:'linear-gradient(135deg,rgba(0,212,255,.04),rgba(191,90,242,.04))', border:'1px solid rgba(255,255,255,.1)', borderRadius:14, padding: isMobile ? '16px' : '22px 26px' }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900, color:'#9abacf', letterSpacing:2, marginBottom:12 }}>THE NARRATIVE</div>
            <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#8aaac0', lineHeight:1.8, fontStyle:'italic' }}>
              "Lab Work is not issued. It is not distributed. It is not allocated. It is earned through destruction. Every LB holder burned real BRAINS — gone forever — for the right to hold it. The supply is fixed at 100,000. The cost rises with every tier. Lab Work lives because BRAINS died. That's the whole story."
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default MintLabWork;
