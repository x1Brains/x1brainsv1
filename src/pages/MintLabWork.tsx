// src/pages/MintLabWork.tsx
// ─────────────────────────────────────────────────────────────────────────────
// MINT LAB WORK — inline component rendered inside LabWork.tsx
// Burns BRAINS + pays XNT fee to mint LB tokens
// 4 progressive tiers · 100,000 LB hard cap
// Xenblocks Amplifier: combo_mint_lb — burns XNM/XUNI/XBLK for bonus LB
// ─────────────────────────────────────────────────────────────────────────────

import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey, LAMPORTS_PER_SOL, Transaction, SystemProgram,
  TransactionInstruction,
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

// Xenblocks assets — standard SPL Token
const XNM_MINT_PK  = new PublicKey('XNMbEwZFFBKQhqyW3taa8cAUp1xBUHfyzRFJQvZET4m');
const XUNI_MINT_PK = new PublicKey('XUNigZPoe8f657NkRf7KF8tqj9ekouT4SoECsD6G2Bm');
const XBLK_MINT_PK = new PublicKey('XBLKLmxhADMVX3DsdwymvHyYbBYfKa5eKhtpiQ2kj7T');

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Anchor discriminators — sha256("global:<name>")[0..8]
// Pre-computed to avoid crypto import in browser
const DISC_MINT_LB:       number[] = [225, 191,  66,  41, 247, 180, 201,  81];
const DISC_COMBO_MINT_LB: number[] = [ 20, 150, 179,  60,  25,  59, 105, 123];

// ─── TOKENOMICS ──────────────────────────────────────────────────────────────

const TOTAL_SUPPLY = 100_000;
const TIER_SIZE    = 25_000;

// Minimum Xenblocks bundle bonus (1000 XNM + 500 XUNI + 1 XBLK)
// xnm: 1000/1000=1 LB, xuni: (500/500)*4=4 LB, xblk: 1*8=8 LB → total +13 LB
const MIN_COMBO_BONUS = 13;

// Extra XNT buffer for ATA creation rent + tx fees
// Covers: 2x ATA creation (~0.002 each) + tx fee (~0.000005)
const XNT_RENT_BUFFER = 0.005;

const TIERS = [
  { tier: 1, label: 'TIER I',   range: [1,       25_000] as [number,number], brains: 8,  xnt: 0.50, color: '#00d4ff', rgb: '0,212,255'   },
  { tier: 2, label: 'TIER II',  range: [25_001,  50_000] as [number,number], brains: 18, xnt: 0.75, color: '#bf5af2', rgb: '191,90,242'  },
  { tier: 3, label: 'TIER III', range: [50_001,  75_000] as [number,number], brains: 26, xnt: 1.00, color: '#00c98d', rgb: '0,201,141'   },
  { tier: 4, label: 'TIER IV',  range: [75_001, 100_000] as [number,number], brains: 33, xnt: 1.50, color: '#ff8c00', rgb: '255,140,0'   },
] as const;

type Tier = typeof TIERS[number];

function getTierForMinted(minted: number): Tier {
  for (const t of TIERS) if (minted < t.range[1]) return t;
  return TIERS[3];
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

// ─── LE u64 encoder ──────────────────────────────────────────────────────────

function encodeU64LE(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

// ─── TIER BAR ────────────────────────────────────────────────────────────────

const TierBar: FC<{ tier: Tier; minted: number; isCurrent: boolean; isMobile: boolean }> = ({
  tier, minted, isCurrent, isMobile,
}) => {
  const tierStart  = (tier.tier - 1) * TIER_SIZE;
  const tierMinted = Math.max(0, Math.min(minted - tierStart, TIER_SIZE));
  const pct        = (tierMinted / TIER_SIZE) * 100;
  const filled     = tierMinted >= TIER_SIZE;

  return (
    <div style={{
      padding: isMobile ? '12px 14px' : '14px 18px',
      background: isCurrent
        ? `linear-gradient(135deg,rgba(${tier.rgb},.08),rgba(255,255,255,.02))`
        : 'rgba(255,255,255,.02)',
      border: `1px solid ${isCurrent ? tier.color + '44' : 'rgba(255,255,255,.06)'}`,
      borderRadius: 12, position: 'relative', overflow: 'hidden',
    }}>
      {isCurrent && (
        <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
          background:`linear-gradient(90deg,transparent,${tier.color},transparent)` }} />
      )}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900,
            color: isCurrent ? tier.color : filled ? '#6a8aaa' : '#4a6a8a' }}>{tier.label}</div>
          {isCurrent && (
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:tier.color,
              background:`rgba(${tier.rgb},.12)`, border:`1px solid ${tier.color}44`,
              borderRadius:4, padding:'1px 6px', animation:'lw-pulse 2s ease infinite' }}>● ACTIVE</div>
          )}
          {filled && (
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#6a8aaa',
              background:'rgba(255,255,255,.05)', border:'1px solid rgba(255,255,255,.1)',
              borderRadius:4, padding:'1px 6px' }}>✓ FILLED</div>
          )}
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700,
            color: isCurrent ? tier.color : '#6a8aaa' }}>
            {tier.brains} BRAINS<span style={{ color:'#4a6a8a', fontSize:7, marginLeft:4 }}>/ LB</span>
          </div>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#4a6a8a', marginTop:1 }}>
            + {tier.xnt} XNT fee / LB
          </div>
        </div>
      </div>
      <div style={{ height:6, background:'rgba(255,255,255,.06)', borderRadius:3, overflow:'hidden' }}>
        <div style={{
          height:'100%', borderRadius:3, width:`${pct}%`,
          background: filled ? 'rgba(106,122,138,.4)' : `linear-gradient(90deg,${tier.color}88,${tier.color})`,
          transition:'width 1s ease',
          boxShadow: isCurrent ? `0 0 8px ${tier.color}66` : 'none',
        }} />
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', marginTop:5 }}>
        <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#6a8aaa' }}>
          {fmt(tierMinted)} / {fmt(TIER_SIZE)} LB minted
        </div>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9,
          color: isCurrent ? tier.color : '#4a6a8a' }}>{pct.toFixed(1)}%</div>
      </div>
    </div>
  );
};

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

const MintLabWork: FC = () => {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const isMobile = useIsMobile();

  const [mintedTotal,    setMintedTotal]    = useState(0);
  const [brainsBalance,  setBrainsBalance]  = useState<number | null>(null);
  const [xntBalance,     setXntBalance]     = useState<number | null>(null);
  const [xnmBalance,     setXnmBalance]     = useState<number | null>(null);
  const [xuniBalance,    setXuniBalance]    = useState<number | null>(null);
  const [xblkBalance,    setXblkBalance]    = useState<number | null>(null);
  const [amount,         setAmount]         = useState(1);
  const [useAmplifier,   setUseAmplifier]   = useState(false);
  const [xnmAmount,      setXnmAmount]      = useState(1_000);
  const [xuniAmount,     setXuniAmount]     = useState(500);
  const [xblkAmount,     setXblkAmount]     = useState(1);
  const [activeTab,      setActiveTab]      = useState<'mint' | 'tiers' | 'info' | 'amplifier'>('mint');
  const [status,         setStatus]         = useState('');
  const [pending,        setPending]        = useState(false);

  // ── Derived ──────────────────────────────────────────────────────
  const currentTier   = useMemo(() => getTierForMinted(mintedTotal), [mintedTotal]);
  const tierIndex     = currentTier.tier - 1;
  const tierMinted    = Math.max(0, mintedTotal - tierIndex * TIER_SIZE);
  const tierRemaining = TIER_SIZE - tierMinted;
  const totalPct      = (mintedTotal / TOTAL_SUPPLY) * 100;

  const brainsCost = amount * currentTier.brains;
  const xntCost    = parseFloat((amount * currentTier.xnt).toFixed(4));

  const xnmCost  = useAmplifier ? xnmAmount  : 0;
  const xuniCost = useAmplifier ? xuniAmount : 0;
  const xblkCost = useAmplifier ? xblkAmount : 0;

  // LB from Xenblocks (mirrors program math exactly)
  const xnmLb  = useAmplifier ? Math.floor(xnmAmount  / 1_000)      : 0;
  const xuniLb = useAmplifier ? Math.floor(xuniAmount / 500) * 4     : 0;
  const xblkLb = useAmplifier ? xblkAmount * 8                       : 0;
  const lbOut  = amount + xnmLb + xuniLb + xblkLb;

  // FIX: include XNT_RENT_BUFFER in canAfford to cover ATA creation + tx fees
  const canAfford = brainsBalance !== null && brainsBalance >= brainsCost
    && xntBalance !== null && xntBalance >= xntCost + XNT_RENT_BUFFER
    && (!useAmplifier || (
      xnmBalance  !== null && xnmBalance  >= xnmCost &&
      xuniBalance !== null && xuniBalance >= xuniCost &&
      xblkBalance !== null && xblkBalance >= xblkCost
    ));

  // ── Fetch balances ───────────────────────────────────────────────
  useEffect(() => {
    if (!publicKey) {
      setBrainsBalance(null); setXntBalance(null);
      setXnmBalance(null); setXuniBalance(null); setXblkBalance(null);
      return;
    }

    const fetchSpl = async (mint: PublicKey, setter: (n: number) => void) => {
      try {
        const ata = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);
        const acc = await connection.getParsedAccountInfo(ata);
        setter((acc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
      } catch { setter(0); }
    };

    // BRAINS — Token-2022
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(BRAINS_MINT_PK, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const acc = await connection.getParsedAccountInfo(ata);
        setBrainsBalance((acc?.value?.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
      } catch { setBrainsBalance(0); }
    })();

    // XNT — native balance
    (async () => {
      try {
        const bal = await connection.getBalance(publicKey);
        setXntBalance(bal / LAMPORTS_PER_SOL);
      } catch { setXntBalance(0); }
    })();

    // Xenblocks — standard SPL
    fetchSpl(XNM_MINT_PK,  setXnmBalance);
    fetchSpl(XUNI_MINT_PK, setXuniBalance);
    fetchSpl(XBLK_MINT_PK, setXblkBalance);

  }, [publicKey?.toBase58()]);

  // ── Read mintedTotal from on-chain GlobalState ───────────────────
  useEffect(() => {
    if (!PROGRAM_DEPLOYED) return;
    (async () => {
      try {
        const programId = new PublicKey(MINT_PROGRAM_ID);
        const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('lb_state')], programId);
        const info = await connection.getAccountInfo(statePda);
        if (!info) return;
        // GlobalState: 8 disc + 32 admin + 32 treasury + 32 lb_mint = 104 → total_minted u64
        const totalMintedRaw = info.data.readBigUInt64LE(104);
        setMintedTotal(Number(totalMintedRaw) / 100); // decimals=2
      } catch {}
    })();
  }, []);

  // ── Refresh GlobalState after mint ──────────────────────────────
  const refreshMintedTotal = useCallback(async () => {
    try {
      const programId = new PublicKey(MINT_PROGRAM_ID);
      const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('lb_state')], programId);
      const info = await connection.getAccountInfo(statePda);
      if (!info) return;
      const raw = info.data.readBigUInt64LE(104);
      setMintedTotal(Number(raw) / 100);
    } catch {}
  }, [connection]);

  // ── Mint handler ─────────────────────────────────────────────────
  const handleMint = useCallback(async () => {
    if (!PROGRAM_DEPLOYED) {
      setStatus('⏳ Program not yet deployed. Check back soon.');
      return;
    }
    if (!publicKey || !signTransaction) return;
    if (!canAfford) { setStatus('❌ Insufficient balance.'); return; }

    setPending(true);
    setStatus('Preparing mint…');

    try {
      const programId  = new PublicKey(MINT_PROGRAM_ID);
      const treasuryPk = new PublicKey(TREASURY_WALLET);

      // Derive PDAs
      const [statePda]    = PublicKey.findProgramAddressSync([Buffer.from('lb_state')],    programId);
      const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from('lb_mint_auth')], programId);
      const [lbMintPda]   = PublicKey.findProgramAddressSync([Buffer.from('lb_mint')],      programId);

      // ATAs
      const buyerBrainsAta = getAssociatedTokenAddressSync(BRAINS_MINT_PK, publicKey,  false, TOKEN_2022);
      const buyerLbAta     = getAssociatedTokenAddressSync(lbMintPda,      publicKey,  false, TOKEN_2022);
      const treasuryLbAta  = getAssociatedTokenAddressSync(lbMintPda,      treasuryPk, false, TOKEN_2022);

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });

      // Create buyer LB ATA if needed
      try {
        await getAccount(connection, buyerLbAta, 'confirmed', TOKEN_2022);
      } catch {
        tx.add(createAssociatedTokenAccountInstruction(
          publicKey, buyerLbAta, publicKey, lbMintPda, TOKEN_2022,
        ));
      }

      // Create treasury LB ATA if needed
      try {
        await getAccount(connection, treasuryLbAta, 'confirmed', TOKEN_2022);
      } catch {
        tx.add(createAssociatedTokenAccountInstruction(
          publicKey, treasuryLbAta, treasuryPk, lbMintPda, TOKEN_2022,
        ));
      }

      if (!useAmplifier) {
        // ── mint_lb ──────────────────────────────────────────────
        // NOTE: Do NOT add a SystemProgram.transfer for XNT here.
        // The program's mint_lb() handles the XNT fee internally.
        // Adding one here would double-charge the buyer.
        const data = Buffer.concat([
          Buffer.from(DISC_MINT_LB),
          encodeU64LE(brainsCost), // whole BRAINS units (program converts to raw)
        ]);

        // Account order must match MintLb<'info> struct exactly:
        // 0 buyer, 1 state, 2 lb_mint, 3 lb_mint_authority,
        // 4 buyer_lb_ata, 5 brains_mint, 6 buyer_brains_ata,
        // 7 treasury, 8 treasury_lb_ata, 9 token_2022_program, 10 system_program
        tx.add(new TransactionInstruction({
          programId,
          keys: [
            { pubkey: publicKey,               isSigner: true,  isWritable: true  }, // 0 buyer
            { pubkey: statePda,                isSigner: false, isWritable: true  }, // 1 state
            { pubkey: lbMintPda,               isSigner: false, isWritable: true  }, // 2 lb_mint
            { pubkey: mintAuthPda,             isSigner: false, isWritable: false }, // 3 lb_mint_authority
            { pubkey: buyerLbAta,              isSigner: false, isWritable: true  }, // 4 buyer_lb_ata
            { pubkey: BRAINS_MINT_PK,          isSigner: false, isWritable: true  }, // 5 brains_mint
            { pubkey: buyerBrainsAta,          isSigner: false, isWritable: true  }, // 6 buyer_brains_ata
            { pubkey: treasuryPk,              isSigner: false, isWritable: true  }, // 7 treasury
            { pubkey: treasuryLbAta,           isSigner: false, isWritable: true  }, // 8 treasury_lb_ata
            { pubkey: TOKEN_2022,              isSigner: false, isWritable: false }, // 9 token_2022_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 10 system_program
          ],
          data,
        }));

      } else {
        // ── combo_mint_lb ─────────────────────────────────────────
        // Xenblocks ATAs — standard SPL
        const buyerXnmAta      = getAssociatedTokenAddressSync(XNM_MINT_PK,  publicKey,  false, TOKEN_PROGRAM_ID);
        const buyerXuniAta     = getAssociatedTokenAddressSync(XUNI_MINT_PK, publicKey,  false, TOKEN_PROGRAM_ID);
        const buyerXblkAta     = getAssociatedTokenAddressSync(XBLK_MINT_PK, publicKey,  false, TOKEN_PROGRAM_ID);
        const treasuryXnmAta   = getAssociatedTokenAddressSync(XNM_MINT_PK,  treasuryPk, false, TOKEN_PROGRAM_ID);
        const treasuryXuniAta  = getAssociatedTokenAddressSync(XUNI_MINT_PK, treasuryPk, false, TOKEN_PROGRAM_ID);
        const treasuryXblkAta  = getAssociatedTokenAddressSync(XBLK_MINT_PK, treasuryPk, false, TOKEN_PROGRAM_ID);

        // Create treasury Xenblocks ATAs if needed (treasury receives 50% of each)
        for (const [mint, ata, owner] of [
          [XNM_MINT_PK,  treasuryXnmAta,  treasuryPk],
          [XUNI_MINT_PK, treasuryXuniAta, treasuryPk],
          [XBLK_MINT_PK, treasuryXblkAta, treasuryPk],
        ] as [PublicKey, PublicKey, PublicKey][]) {
          try {
            await getAccount(connection, ata, 'confirmed', TOKEN_PROGRAM_ID);
          } catch {
            tx.add(createAssociatedTokenAccountInstruction(
              publicKey, ata, owner, mint, TOKEN_PROGRAM_ID,
            ));
          }
        }

        // combo_mint_lb args: brains_amount, xnm_amount, xuni_amount, xblk_amount (all u64 LE)
        const data = Buffer.concat([
          Buffer.from(DISC_COMBO_MINT_LB),
          encodeU64LE(brainsCost),   // whole BRAINS
          encodeU64LE(xnmAmount),    // whole XNM (multiple of 1000)
          encodeU64LE(xuniAmount),   // whole XUNI (multiple of 500)
          encodeU64LE(xblkAmount),   // whole XBLK
        ]);

        // Account order must match ComboMintLb<'info> struct exactly:
        // 0  buyer
        // 1  state
        // 2  lb_mint
        // 3  lb_mint_authority
        // 4  buyer_lb_ata
        // 5  brains_mint
        // 6  buyer_brains_ata
        // 7  xnm_mint
        // 8  buyer_xnm_ata
        // 9  treasury_xnm_ata
        // 10 xuni_mint
        // 11 buyer_xuni_ata
        // 12 treasury_xuni_ata
        // 13 xblk_mint
        // 14 buyer_xblk_ata
        // 15 treasury_xblk_ata
        // 16 treasury
        // 17 treasury_lb_ata
        // 18 token_program
        // 19 token_2022_program
        // 20 system_program
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
            { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false }, // 18 token_program
            { pubkey: TOKEN_2022,              isSigner: false, isWritable: false }, // 19 token_2022_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 20 system_program
          ],
          data,
        }));
      }

      setStatus('Awaiting wallet approval…');
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
      });

      setStatus('Confirming…');
      for (let i = 0; i < 40; i++) {
        if (i) await new Promise(r => setTimeout(r, 1500));
        const s = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (s?.value?.err) throw new Error('On-chain error: ' + JSON.stringify(s.value.err));
        const conf = s?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') break;
      }

      setStatus(`✅ Minted ${fmt(lbOut)} LB! <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#00d4ff;text-decoration:underline">View Tx ↗</a>`);

      // Refresh balances
      setBrainsBalance(null);
      setXntBalance(null);
      if (useAmplifier) { setXnmBalance(null); setXuniBalance(null); setXblkBalance(null); }
      // Re-fetch GlobalState from chain (source of truth)
      setTimeout(() => refreshMintedTotal(), 2000);

    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0, 120) ?? 'Transaction failed'}`);
    } finally { setPending(false); }
  }, [publicKey, signTransaction, canAfford, amount, brainsCost, xntCost,
      useAmplifier, xnmAmount, xuniAmount, xblkAmount, lbOut, refreshMintedTotal]);

  // ── Styles ───────────────────────────────────────────────────────
  const c   = currentTier.color;
  const rgb = currentTier.rgb;

  return (
    <>
      <style>{`
        @keyframes lw-pulse   { 0%,100%{opacity:.7} 50%{opacity:1} }
        @keyframes lw-shimmer { 0%{background-position:-200% center} 100%{background-position:200% center} }
        @keyframes lw-coming  { 0%,100%{opacity:.6} 50%{opacity:1} }
        @keyframes lw-spin    { to{transform:rotate(360deg)} }
      `}</style>

      {/* ── Section tabs ───────────────────────────────────────── */}
      <div style={{
        display:'flex', gap:4, marginBottom: isMobile ? 16 : 22,
        background:'rgba(255,255,255,.03)', borderRadius:12, padding:4,
        border:'1px solid rgba(255,255,255,.06)',
      }}>
        {([
          { id:'mint',      label: isMobile ? '🔥 MINT'  : '🔥 MINT LB',       sub:'burn BRAINS → get LB' },
          { id:'tiers',     label: isMobile ? '📊 TIERS' : '📊 TIER PRICING',  sub:'costs & progress'     },
          { id:'amplifier', label: isMobile ? '⚡ AMP'   : '⚡ AMPLIFIER',      sub:'xenblocks bonus'       },
          { id:'info',      label: isMobile ? '📖 INFO'  : '📖 TOKENOMICS',    sub:'how it works'         },
        ] as { id: typeof activeTab; label: string; sub: string }[]).map(t => (
          <button key={t.id} type="button" onClick={() => setActiveTab(t.id)}
            style={{
              flex:1, padding: isMobile ? '8px 4px' : '10px 8px',
              background: activeTab === t.id
                ? 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.08))'
                : 'transparent',
              border: activeTab === t.id ? '1px solid rgba(0,212,255,.35)' : '1px solid transparent',
              borderRadius:9, cursor:'pointer', transition:'all .15s',
              fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700,
              color: activeTab === t.id ? '#00d4ff' : '#4a6a8a',
              display:'flex', flexDirection:'column', alignItems:'center', gap:2,
            }}>
            <span>{t.label}</span>
            <span style={{ fontSize:6, color: activeTab === t.id ? 'rgba(0,212,255,.5)' : '#3a5a7a',
              letterSpacing:1, fontWeight:400 }}>{t.sub}</span>
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════
          MINT TAB
      ══════════════════════════════════════════════════════════ */}
      {activeTab === 'mint' && (
        <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 340px',
          gap: isMobile ? 14 : 20, animation:'fadeUp .3s ease both' }}>

          {/* Left — form */}
          <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 12 : 14 }}>

            {/* Mini stats strip */}
            <div style={{
              display:'flex', gap:0,
              background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.07)',
              borderRadius:10, overflow:'hidden',
            }}>
              {[
                { label:'TOTAL SUPPLY', value:'100,000',                        color:'#00d4ff' },
                { label:'LB MINTED',    value: fmt(mintedTotal),                color:'#00c98d' },
                { label:'REMAINING',    value: fmt(TOTAL_SUPPLY - mintedTotal), color:'#bf5af2' },
                { label:'ACTIVE TIER',  value:`TIER ${currentTier.tier}`,       color: c        },
              ].map(({ label, value, color }, i, arr) => (
                <React.Fragment key={label}>
                  <div style={{ flex:1, textAlign:'center', padding: isMobile ? '8px 4px' : '10px 8px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 14,
                      fontWeight:900, color, lineHeight:1, marginBottom:2 }}>{value}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 5 : 6,
                      color:'#9abacf', letterSpacing:1 }}>{label}</div>
                  </div>
                  {i < arr.length - 1 && (
                    <div style={{ width:1, alignSelf:'stretch', background:'rgba(255,255,255,.08)' }} />
                  )}
                </React.Fragment>
              ))}
            </div>

            {/* Active tier card */}
            <div style={{
              background:`linear-gradient(135deg,rgba(${rgb},.08),rgba(255,255,255,.02))`,
              border:`1px solid ${c}44`, borderRadius:16,
              padding: isMobile ? '16px' : '20px 22px', position:'relative', overflow:'hidden',
            }}>
              <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1,
                background:`linear-gradient(90deg,transparent,${c},transparent)` }} />
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf',
                    letterSpacing:2, marginBottom:4 }}>ACTIVE TIER</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 18 : 22,
                    fontWeight:900, color:c }}>{currentTier.label}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 22 : 28,
                    fontWeight:900, color:c }}>{currentTier.brains}</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf' }}>BRAINS / LB</div>
                </div>
              </div>
              <div style={{ marginBottom:6 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                  <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf' }}>
                    {fmt(tierMinted)} / {fmt(TIER_SIZE)} minted this tier
                  </span>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:c }}>
                    {fmt(tierRemaining)} left
                  </span>
                </div>
                <div style={{ height:8, background:'rgba(255,255,255,.06)', borderRadius:4, overflow:'hidden' }}>
                  <div style={{
                    height:'100%', borderRadius:4,
                    width:`${(tierMinted / TIER_SIZE) * 100}%`,
                    background:`linear-gradient(90deg,${c}88,${c})`,
                    boxShadow:`0 0 10px ${c}66`, transition:'width 1s ease',
                  }} />
                </div>
              </div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#6a8aaa' }}>
                + {currentTier.xnt} XNT platform fee per LB
              </div>
            </div>

            {/* Amount selector */}
            <div style={{
              background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.08)',
              borderRadius:14, padding: isMobile ? '16px' : '20px 22px',
            }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf',
                letterSpacing:2, marginBottom:12 }}>AMOUNT TO MINT</div>
              <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
                {[1, 5, 10, 25, 50, 100].map(v => (
                  <button key={v} type="button" onClick={() => setAmount(Math.min(v, tierRemaining))}
                    style={{
                      padding: isMobile ? '6px 10px' : '7px 14px', borderRadius:8,
                      cursor:'pointer', transition:'all .12s',
                      fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700,
                      background: amount === v ? `rgba(${rgb},.18)` : 'rgba(255,255,255,.04)',
                      border:`1px solid ${amount === v ? c + '66' : 'rgba(255,255,255,.08)'}`,
                      color: amount === v ? c : '#4a6a8a',
                    }}>{v}</button>
                ))}
                <input type="number" min={1} max={tierRemaining} value={amount}
                  onChange={e => setAmount(Math.max(1, Math.min(tierRemaining, parseInt(e.target.value) || 1)))}
                  style={{
                    width: isMobile ? 60 : 72, padding:'7px 10px', textAlign:'center',
                    background:'rgba(255,255,255,.04)', border:`1px solid rgba(${rgb},.3)`,
                    borderRadius:8, outline:'none',
                    fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700,
                    color:'#e0f0ff', caretColor:c,
                  }} />
              </div>

              {/* Cost breakdown */}
              <div style={{ background:'rgba(0,0,0,.2)', borderRadius:10,
                border:'1px solid rgba(255,255,255,.06)', overflow:'hidden', marginBottom:14 }}>
                {[
                  { label:'LB YOU RECEIVE',   value:`${fmt(lbOut)} LB`,          color:c          },
                  { label:'BRAINS TO BURN',    value:`${fmt(brainsCost)} BRAINS`, color:'#ff6a6a'  },
                  { label:'XNT PLATFORM FEE',  value:`${xntCost} XNT`,            color:'#ffaa00'  },
                  ...(useAmplifier && xnmAmount  > 0 ? [{ label:'XNM',  value:`${fmt(xnmAmount)} → +${xnmLb} LB`,  color:'#00d4ff' }] : []),
                  ...(useAmplifier && xuniAmount > 0 ? [{ label:'XUNI', value:`${fmt(xuniAmount)} → +${xuniLb} LB`, color:'#bf5af2' }] : []),
                  ...(useAmplifier && xblkAmount > 0 ? [{ label:'XBLK', value:`${xblkAmount} → +${xblkLb} LB`,      color:'#00c98d' }] : []),
                ].map(({ label, value, color }, i, arr) => (
                  <div key={label} style={{
                    display:'flex', justifyContent:'space-between', alignItems:'center',
                    padding:'9px 14px',
                    borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none',
                  }}>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf' }}>{label}</span>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 12,
                      fontWeight:900, color }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* ── Xenblocks Amplifier toggle ── */}
              <div style={{
                background: useAmplifier
                  ? 'linear-gradient(135deg,rgba(255,170,0,.08),rgba(191,90,242,.05))'
                  : 'rgba(255,255,255,.02)',
                border: `1px solid ${useAmplifier ? 'rgba(255,170,0,.35)' : 'rgba(255,255,255,.08)'}`,
                borderRadius:12, padding: isMobile ? '12px 14px' : '14px 16px', transition:'all .2s',
              }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                  marginBottom: useAmplifier ? 14 : 0 }}>
                  <div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10,
                      fontWeight:900, color: useAmplifier ? '#ffaa00' : '#4a6a8a', letterSpacing:1 }}>
                      ⚡ XENBLOCKS AMPLIFIER
                    </div>
                    <div style={{ fontFamily:'Sora,sans-serif', fontSize:9,
                      color: useAmplifier ? '#8aaac0' : '#3a5a7a', marginTop:2 }}>
                      {useAmplifier
                        ? `+${xnmLb + xuniLb + xblkLb} bonus LB · 50% burned, 50% → treasury`
                        : 'burn XNM, XUNI, XBLK for bonus LB'}
                    </div>
                  </div>
                  <button type="button" onClick={() => setUseAmplifier(p => !p)}
                    style={{
                      position:'relative', width:48, height:26, borderRadius:13,
                      border:'none', cursor:'pointer', outline:'none', flexShrink:0,
                      background: useAmplifier
                        ? 'linear-gradient(135deg,#ffaa00,#ff6600)'
                        : 'rgba(255,255,255,.1)',
                      boxShadow: useAmplifier ? '0 0 12px rgba(255,170,0,.4)' : 'none',
                      transition:'all .25s',
                    }}>
                    <span style={{
                      position:'absolute', top:3, left: useAmplifier ? 25 : 3,
                      width:20, height:20, borderRadius:'50%', background:'#fff',
                      boxShadow: useAmplifier ? '0 0 6px rgba(255,170,0,.6)' : '0 1px 3px rgba(0,0,0,.3)',
                      transition:'left .25s', display:'flex', alignItems:'center',
                      justifyContent:'center', fontSize:10,
                    }}>{useAmplifier ? '⚡' : '○'}</span>
                  </button>
                </div>

                {useAmplifier && (
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {[
                      { label:'XNM',  step:1_000, val:xnmAmount,  set:setXnmAmount,  bal:xnmBalance,  lb:xnmLb,  color:'#00d4ff', rgb:'0,212,255',   hint:'multiples of 1,000' },
                      { label:'XUNI', step:500,   val:xuniAmount, set:setXuniAmount, bal:xuniBalance, lb:xuniLb, color:'#bf5af2', rgb:'191,90,242', hint:'multiples of 500'   },
                      { label:'XBLK', step:1,     val:xblkAmount, set:setXblkAmount, bal:xblkBalance, lb:xblkLb, color:'#00c98d', rgb:'0,201,141', hint:'whole numbers'       },
                    ].map(({ label, step, val, set, bal, lb, color, rgb: r, hint }) => {
                      const enough = bal !== null && bal >= val;
                      return (
                        <div key={label} style={{
                          background:`rgba(${r},.06)`,
                          border:`1px solid ${enough ? `rgba(${r},.25)` : val > 0 && bal !== null ? 'rgba(255,50,50,.3)' : `rgba(${r},.15)`}`,
                          borderRadius:10, padding:'10px 12px',
                        }}>
                          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
                            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:900, color }}>{label}</span>
                              <span style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#6a8aaa' }}>{hint}</span>
                              {lb > 0 && <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                                color:'#00c98d', background:'rgba(0,201,141,.1)', border:'1px solid rgba(0,201,141,.2)',
                                borderRadius:4, padding:'1px 6px' }}>+{lb} LB</span>}
                            </div>
                            {publicKey && (
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8,
                                color: enough ? color : bal === null ? '#6a8aaa' : '#ff6666' }}>
                                {bal === null ? '…' : `${fmt(bal)} bal`}
                              </span>
                            )}
                          </div>
                          <div style={{ display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
                            {(label === 'XBLK'
                              ? [1, 2, 3, 5, 10]
                              : label === 'XUNI'
                              ? [500, 1_000, 2_000, 5_000]
                              : [1_000, 2_000, 5_000, 10_000]
                            ).map(v => (
                              <button key={v} type="button" onClick={() => set(v)}
                                style={{
                                  padding:'4px 8px', borderRadius:6, cursor:'pointer',
                                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700,
                                  background: val === v ? `rgba(${r},.2)` : 'rgba(255,255,255,.04)',
                                  border:`1px solid ${val === v ? color + '55' : 'rgba(255,255,255,.08)'}`,
                                  color: val === v ? color : '#4a6a8a', transition:'all .1s',
                                }}>{fmt(v)}</button>
                            ))}
                            <input type="number" min={step} step={step} value={val}
                              onChange={e => {
                                const v = parseInt(e.target.value) || step;
                                set(Math.max(step, Math.round(v / step) * step));
                              }}
                              style={{
                                width: isMobile ? 64 : 76, padding:'4px 8px', textAlign:'center',
                                background:'rgba(255,255,255,.04)', border:`1px solid rgba(${r},.3)`,
                                borderRadius:6, outline:'none',
                                fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700,
                                color:'#e0f0ff', caretColor:color,
                              }} />
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
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <div style={{ display:'flex', gap:8 }}>
                  {[
                    { label:'BRAINS', val: brainsBalance, need: brainsCost,                    color:'#bf5af2', suffix:'BRAINS' },
                    { label:'XNT',    val: xntBalance,    need: xntCost + XNT_RENT_BUFFER,      color:'#00c98d', suffix:'XNT'    },
                  ].map(({ label, val, need, color, suffix }) => {
                    const enough = val !== null && val >= need;
                    return (
                      <div key={label} style={{
                        flex:1, padding:'10px 12px', borderRadius:10, textAlign:'center',
                        background: enough ? 'rgba(255,255,255,.03)' : 'rgba(255,50,50,.05)',
                        border:`1px solid ${enough ? color + '22' : 'rgba(255,50,50,.2)'}`,
                      }}>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 15,
                          fontWeight:900, color: enough ? color : '#ff6666', marginBottom:2 }}>
                          {val === null ? '…' : suffix === 'XNT' ? val.toFixed(3) : fmt(val)}
                        </div>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:7,
                          color:'#6a8aaa', letterSpacing:1.5 }}>{suffix} BALANCE</div>
                        {!enough && val !== null && (
                          <div style={{ fontFamily:'Sora,sans-serif', fontSize:8, color:'#ff6666', marginTop:2 }}>
                            need {suffix === 'XNT' ? need.toFixed(3) : fmt(need)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Status */}
            {status && (
              <div style={{
                padding:'10px 14px', borderRadius:10,
                background: status.startsWith('✅') ? 'rgba(0,201,141,.08)'
                  : status.startsWith('⏳') ? 'rgba(191,90,242,.08)' : 'rgba(255,50,50,.08)',
                border:`1px solid ${status.startsWith('✅') ? 'rgba(0,201,141,.3)'
                  : status.startsWith('⏳') ? 'rgba(191,90,242,.3)' : 'rgba(255,50,50,.25)'}`,
                fontFamily:'Sora,sans-serif', fontSize:11,
                color: status.startsWith('✅') ? '#00c98d'
                  : status.startsWith('⏳') ? '#bf5af2' : '#ff6666',
              }} dangerouslySetInnerHTML={{ __html: status }} />
            )}

            {/* Mint button */}
            {!publicKey ? (
              <div style={{ padding:'16px', textAlign:'center', borderRadius:12,
                background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.08)',
                fontFamily:'Orbitron,monospace', fontSize:11, color:'#4a6a8a' }}>
                🔌 CONNECT WALLET TO MINT
              </div>
            ) : (
              <button type="button" onClick={handleMint} disabled={pending || !canAfford}
                style={{
                  width:'100%', padding: isMobile ? '14px 0' : '16px 0',
                  background: canAfford
                    ? `linear-gradient(135deg,rgba(${rgb},.25),rgba(${rgb},.1))`
                    : 'rgba(255,255,255,.04)',
                  border:`1px solid ${canAfford ? c + '66' : 'rgba(255,255,255,.1)'}`,
                  borderRadius:12, cursor:(pending || !canAfford) ? 'not-allowed' : 'pointer',
                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900,
                  color: canAfford ? c : '#4a6a8a', opacity: pending ? .7 : 1,
                  display:'flex', alignItems:'center', justifyContent:'center', gap:10,
                  boxShadow: canAfford ? `0 0 20px rgba(${rgb},.2)` : 'none', transition:'all .2s',
                }}>
                {pending
                  ? <><div style={{ width:14, height:14, borderRadius:'50%',
                      border:`2px solid rgba(${rgb},.2)`, borderTop:`2px solid ${c}`,
                      animation:'lw-spin .8s linear infinite' }} />MINTING…</>
                  : useAmplifier
                  ? `⚡ COMBO MINT ${fmt(lbOut)} LB — ${fmt(brainsCost)} BRAINS + ${xntCost} XNT`
                  : `🔥 MINT ${fmt(lbOut)} LB — ${fmt(brainsCost)} BRAINS + ${xntCost} XNT`
                }
              </button>
            )}
          </div>

          {/* Right — global progress */}
          <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 12 : 14 }}>

            <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)',
              borderRadius:16, padding: isMobile ? '16px' : '20px 22px' }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf',
                letterSpacing:2, marginBottom:12 }}>GLOBAL MINT PROGRESS</div>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 20 : 26,
                  fontWeight:900, color:c }}>{fmt(mintedTotal)}</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#4a6a8a',
                  alignSelf:'flex-end', marginBottom:3 }}>/ 100,000 LB</span>
              </div>
              <div style={{ height:12, background:'rgba(255,255,255,.06)', borderRadius:6,
                overflow:'hidden', display:'flex', marginBottom:8 }}>
                {TIERS.map(t => {
                  const tStart  = (t.tier - 1) * TIER_SIZE;
                  const tMinted = Math.max(0, Math.min(mintedTotal - tStart, TIER_SIZE));
                  const segW    = (tMinted / TOTAL_SUPPLY) * 100;
                  if (segW === 0) return null;
                  return (
                    <div key={t.tier} style={{
                      width:`${segW}%`, height:'100%',
                      background:`linear-gradient(90deg,${t.color}88,${t.color})`,
                      boxShadow: t.tier === currentTier.tier ? `0 0 8px ${t.color}88` : 'none',
                    }} />
                  );
                })}
              </div>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#6a8aaa' }}>
                  {totalPct.toFixed(2)}% minted
                </span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf' }}>
                  {fmt(TOTAL_SUPPLY - mintedTotal)} remaining
                </span>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginTop:12 }}>
                {TIERS.map(t => (
                  <div key={t.tier} style={{ display:'flex', alignItems:'center', gap:6,
                    opacity: t.tier < currentTier.tier ? .4 : 1 }}>
                    <div style={{ width:8, height:8, borderRadius:2, background:t.color, flexShrink:0 }} />
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7,
                      color: t.tier === currentTier.tier ? t.color : '#6a8aaa' }}>
                      {t.label} · {t.brains}B / {t.xnt} XNT
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Amplifier teaser */}
            <div style={{
              background:'linear-gradient(135deg,rgba(255,170,0,.06),rgba(191,90,242,.04))',
              border:'1px dashed rgba(255,170,0,.25)', borderRadius:14,
              padding: isMobile ? '14px' : '18px 20px',
            }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10,
                  fontWeight:900, color:'#ffaa00', letterSpacing:1 }}>⚡ XENBLOCKS AMPLIFIER</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00c98d',
                  background:'rgba(0,201,141,.1)', border:'1px solid rgba(0,201,141,.25)',
                  borderRadius:4, padding:'2px 7px' }}>LIVE</div>
              </div>
              <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 9 : 10,
                color:'#8aaac0', lineHeight:1.6, marginBottom:10 }}>
                Add Xenblocks assets to your mint for bonus LB.
                Minimum bundle gives <span style={{ color:'#ffaa00', fontWeight:700 }}>+{MIN_COMBO_BONUS} LB</span>.
                50% of each asset burned forever, 50% → treasury.
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {[
                  { t:'XNM',  a:'1,000', bal: xnmBalance,  need: 1000 },
                  { t:'XUNI', a:'500',   bal: xuniBalance,  need: 500  },
                  { t:'XBLK', a:'1',     bal: xblkBalance,  need: 1    },
                ].map(({ a, t, bal, need }) => {
                  const enough = bal !== null && bal >= need;
                  return (
                    <div key={t} style={{
                      fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                      color: enough ? '#ffaa00' : bal === null ? '#6a8aaa' : '#ff6666',
                      background: enough ? 'rgba(255,170,0,.08)' : 'rgba(255,255,255,.04)',
                      border:`1px solid ${enough ? 'rgba(255,170,0,.25)' : 'rgba(255,255,255,.08)'}`,
                      borderRadius:6, padding:'4px 10px',
                    }}>
                      {a} {t}{publicKey && bal !== null ? ` · ${fmt(bal)}` : ''}
                    </div>
                  );
                })}
              </div>
              <button type="button" onClick={() => setActiveTab('amplifier')}
                style={{ marginTop:10, padding:'6px 14px', borderRadius:8, cursor:'pointer',
                  fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                  color:'#ffaa00', background:'rgba(255,170,0,.08)',
                  border:'1px solid rgba(255,170,0,.2)' }}>
                LEARN MORE ↗
              </button>
            </div>

            {/* Fee notice */}
            <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
              background:'rgba(191,90,242,.04)', border:'1px solid rgba(191,90,242,.12)',
              borderRadius:10, opacity:.7 }}>
              <span style={{ fontSize:14 }}>💎</span>
              <div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8,
                  color:'#8a5aaa', letterSpacing:.5 }}>
                  XNT FEES → PROTOCOL TREASURY · BRAINS BURNED FOREVER
                </div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#5a3a7a', marginTop:2 }}>
                  {TREASURY_WALLET.slice(0,12)}…{TREASURY_WALLET.slice(-6)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          TIERS TAB
      ══════════════════════════════════════════════════════════ */}
      {activeTab === 'tiers' && (
        <div style={{ animation:'fadeUp .3s ease both' }}>
          <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 10 : 12, marginBottom:20 }}>
            {TIERS.map(t => (
              <TierBar key={t.tier} tier={t} minted={mintedTotal}
                isCurrent={t.tier === currentTier.tier} isMobile={isMobile} />
            ))}
          </div>
          <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)',
            borderRadius:16, overflow:'hidden' }}>
            <div style={{ padding: isMobile ? '14px 16px' : '16px 22px',
              borderBottom:'1px solid rgba(255,255,255,.06)',
              fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:900, color:'#fff', letterSpacing:1 }}>
              FULL MINT CYCLE SUMMARY
            </div>
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
                  {TIERS.map((t, i) => (
                    <tr key={t.tier} style={{
                      background: t.tier === currentTier.tier ? `rgba(${t.rgb},.05)` : 'transparent',
                      borderBottom: i < TIERS.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none',
                    }}>
                      <td style={{ padding: isMobile ? '8px 10px' : '10px 16px',
                        fontSize: isMobile ? 9 : 10, fontWeight:900, color:t.color }}>{t.label}</td>
                      <td style={{ padding: isMobile ? '8px 10px' : '10px 16px',
                        fontSize:8, color:'#9abacf' }}>{fmt(t.range[0])}–{fmt(t.range[1])}</td>
                      <td style={{ padding: isMobile ? '8px 10px' : '10px 16px',
                        fontSize: isMobile ? 10 : 11, fontWeight:700, color:'#ff6a6a' }}>{t.brains}</td>
                      <td style={{ padding: isMobile ? '8px 10px' : '10px 16px',
                        fontSize: isMobile ? 10 : 11, fontWeight:700, color:'#ffaa00' }}>{t.xnt}</td>
                      <td style={{ padding: isMobile ? '8px 10px' : '10px 16px',
                        fontSize:9, color:'#c0d0e0' }}>{fmt(t.brains * TIER_SIZE)}</td>
                      <td style={{ padding: isMobile ? '8px 10px' : '10px 16px',
                        fontSize:9, color:'#c0d0e0' }}>{fmt(t.xnt * TIER_SIZE, 0)} XNT</td>
                    </tr>
                  ))}
                  <tr style={{ background:'rgba(255,255,255,.04)', borderTop:'1px solid rgba(255,255,255,.1)' }}>
                    <td colSpan={4} style={{ padding: isMobile ? '10px 10px' : '12px 16px',
                      fontSize: isMobile ? 9 : 10, fontWeight:900, color:'#fff' }}>TOTAL</td>
                    <td style={{ padding: isMobile ? '10px 10px' : '12px 16px',
                      fontSize: isMobile ? 10 : 12, fontWeight:900, color:'#ff6a6a' }}>2,125,000</td>
                    <td style={{ padding: isMobile ? '10px 10px' : '12px 16px',
                      fontSize: isMobile ? 10 : 12, fontWeight:900, color:'#ffaa00' }}>93,750 XNT</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          AMPLIFIER TAB
      ══════════════════════════════════════════════════════════ */}
      {activeTab === 'amplifier' && (
        <div style={{ animation:'fadeUp .3s ease both' }}>
          <div style={{
            background:'linear-gradient(135deg,rgba(255,170,0,.08),rgba(191,90,242,.05))',
            border:'1px solid rgba(255,170,0,.3)', borderRadius:16,
            padding: isMobile ? '20px 16px' : '28px 28px', marginBottom: isMobile ? 14 : 18,
            position:'relative', overflow:'hidden',
          }}>
            <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
              background:'linear-gradient(90deg,transparent,#ffaa00,rgba(191,90,242,.8),transparent)' }} />
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
              <span style={{ fontSize: isMobile ? 22 : 28 }}>⚡</span>
              <div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 16,
                  fontWeight:900, color:'#ffaa00', letterSpacing:1.5 }}>XENBLOCKS AMPLIFIER</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf', marginTop:2 }}>
                  for the deepest believers in the X1 ecosystem
                </div>
              </div>
              <div style={{ marginLeft:'auto', fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9,
                color:'#00c98d', background:'rgba(0,201,141,.1)', border:'1px solid rgba(0,201,141,.3)',
                borderRadius:6, padding:'4px 12px' }}>
                LIVE
              </div>
            </div>
            <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13,
              color:'#9abacf', lineHeight:1.7, marginBottom:16 }}>
              A standard mint burns BRAINS and receives LB based on the tier rate. A combo mint burns BRAINS
              <em> plus</em> Xenblocks assets and receives bonus LB on top — dramatically more Lab Work for
              the same BRAINS cost. The minimum bundle gives
              <span style={{ color:'#ffaa00', fontWeight:700 }}> +{MIN_COMBO_BONUS} LB</span>, and
              the bonus scales with how much you put in.
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8,
              background:'rgba(255,170,0,.06)', border:'1px solid rgba(255,170,0,.15)',
              borderRadius:10, padding:'12px 16px' }}>
              <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 18 : 24,
                fontWeight:900, color:'#ffaa00' }}>+{MIN_COMBO_BONUS} LB</span>
              <span style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 12,
                color:'#9abacf' }}>minimum bonus per combo mint (scales with amount)</span>
            </div>
          </div>

          {/* Bundle required */}
          <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)',
            borderRadius:14, padding: isMobile ? '16px' : '20px 22px', marginBottom: isMobile ? 14 : 18 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:900,
              color:'#fff', letterSpacing:1.5, marginBottom:14 }}>MINIMUM XENBLOCKS BUNDLE</div>
            <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: isMobile ? 8 : 12 }}>
              {[
                { asset:'XNM',  amount:'1,000', burned:'500 burned',   treasury:'500 → Treasury', lb:'+1 LB',  color:'#00d4ff', rgb:'0,212,255',   bal: xnmBalance,  need: 1000 },
                { asset:'XUNI', amount:'500',   burned:'250 burned',   treasury:'250 → Treasury', lb:'+4 LB',  color:'#bf5af2', rgb:'191,90,242', bal: xuniBalance, need: 500  },
                { asset:'XBLK', amount:'1',     burned:'0.5 burned',   treasury:'0.5 → Treasury', lb:'+8 LB',  color:'#00c98d', rgb:'0,201,141', bal: xblkBalance, need: 1    },
              ].map(({ asset, amount: a, burned, treasury, lb, color, rgb: r, bal, need }) => {
                const enough = bal !== null && bal >= need;
                return (
                  <div key={asset} style={{
                    background:`rgba(${r},.06)`,
                    border:`1px solid ${enough ? `rgba(${r},.3)` : bal === null ? `rgba(${r},.2)` : 'rgba(255,50,50,.3)'}`,
                    borderRadius:12, padding: isMobile ? '14px' : '16px 18px',
                  }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 18,
                      fontWeight:900, color, marginBottom:2 }}>{a}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12,
                      fontWeight:700, color, marginBottom:2 }}>{asset}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700,
                      color:'#00c98d', marginBottom:8 }}>{lb}</div>
                    {publicKey && (
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:8,
                        color: enough ? color : bal === null ? '#6a8aaa' : '#ff6666',
                        marginBottom:8, background: enough ? `rgba(${r},.08)` : 'rgba(255,50,50,.06)',
                        border:`1px solid ${enough ? `rgba(${r},.2)` : 'rgba(255,50,50,.2)'}`,
                        borderRadius:5, padding:'3px 8px', display:'inline-block',
                      }}>
                        {bal === null ? 'loading…' : `${fmt(bal)} in wallet`}
                        {!enough && bal !== null && ` · need ${fmt(need)}`}
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

          {/* What happens to assets */}
          <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)',
            borderRadius:14, padding: isMobile ? '16px' : '20px 22px', marginBottom: isMobile ? 14 : 18 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:900,
              color:'#fff', letterSpacing:1.5, marginBottom:12 }}>WHAT HAPPENS TO XENBLOCKS ASSETS</div>
            <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: isMobile ? 10 : 14 }}>
              {[
                { icon:'🔥', title:'50% BURNED FOREVER', color:'#ff6a6a', rgb:'255,106,106',
                  body:'Half of every XNM, XUNI, and XBLK that enters the protocol is permanently destroyed on-chain. Gone from the supply forever. Every combo minter reduces Xenblocks circulating supply.' },
                { icon:'🏦', title:'50% TO PROTOCOL TREASURY', color:'#00c98d', rgb:'0,201,141',
                  body:'The other half goes to the protocol treasury wallet — the same wallet that receives XNT fees. Deployed for AMM liquidity pool seeding, staking rewards, and farming programs.' },
              ].map(({ icon, title, color, rgb: r, body }) => (
                <div key={title} style={{
                  background:`rgba(${r},.05)`, border:`1px solid rgba(${r},.18)`,
                  borderRadius:12, padding: isMobile ? '14px' : '16px 18px',
                }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                    <span style={{ fontSize:16 }}>{icon}</span>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9,
                      fontWeight:900, color, letterSpacing:1 }}>{title}</div>
                  </div>
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 11,
                    color:'#9abacf', lineHeight:1.7 }}>{body}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Rates table */}
          <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.07)',
            borderRadius:14, overflow:'hidden' }}>
            <div style={{ padding: isMobile ? '14px 16px' : '16px 22px',
              borderBottom:'1px solid rgba(255,255,255,.06)',
              fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:900, color:'#fff', letterSpacing:1 }}>
              XENBLOCKS LB RATES
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontFamily:'Orbitron,monospace' }}>
                <thead>
                  <tr style={{ background:'rgba(255,255,255,.03)' }}>
                    {['ASSET','AMOUNT','LB EARNED','50% BURNED','50% → TREASURY'].map(h => (
                      <th key={h} style={{ padding: isMobile ? '8px 10px' : '10px 16px', textAlign:'left',
                        fontSize: isMobile ? 6 : 7, color:'#9abacf', letterSpacing:1.5, fontWeight:700,
                        borderBottom:'1px solid rgba(255,255,255,.06)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { asset:'XNM',  amount:'1,000', lb:'+1 LB',  burn:'500 XNM',   trs:'500 XNM',  color:'#00d4ff' },
                    { asset:'XUNI', amount:'500',   lb:'+4 LB',  burn:'250 XUNI',  trs:'250 XUNI', color:'#bf5af2' },
                    { asset:'XBLK', amount:'1',     lb:'+8 LB',  burn:'0.5 XBLK',  trs:'0.5 XBLK', color:'#00c98d' },
                    { asset:'MIN BUNDLE', amount:'all 3', lb:'+13 LB', burn:'50% each', trs:'50% each', color:'#ffaa00' },
                  ].map(({ asset, amount: a, lb, burn, trs, color }, i, arr) => (
                    <tr key={asset} style={{ borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,.04)' : 'none',
                      background: i === arr.length - 1 ? 'rgba(255,170,0,.03)' : 'transparent' }}>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px',
                        fontSize: isMobile ? 10 : 11, fontWeight:900, color }}>{asset}</td>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px',
                        fontSize: isMobile ? 9 : 10, color:'#c0d0e0' }}>{a}</td>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px',
                        fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#00c98d' }}>{lb}</td>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px',
                        fontSize: isMobile ? 9 : 10, color:'#ff6a6a' }}>{burn}</td>
                      <td style={{ padding: isMobile ? '9px 10px' : '11px 16px',
                        fontSize: isMobile ? 9 : 10, color:'#00c98d' }}>{trs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          INFO / TOKENOMICS TAB
      ══════════════════════════════════════════════════════════ */}
      {activeTab === 'info' && (
        <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 12 : 16,
          animation:'fadeUp .3s ease both' }}>
          {[
            { icon:'🔥', title:'THE CORE MECHANISM', color:'#ff6a6a', rgb:'255,106,106',
              body:'To mint LB, you burn BRAINS. Every Lab Work token represents BRAINS that no longer exist. The relationship is permanent and one-directional — BRAINS go in, they never come back, LB comes out.' },
            { icon:'📈', title:'4 PROGRESSIVE TIERS', color:'#00d4ff', rgb:'0,212,255',
              body:'100,000 LB is divided into 4 tranches of 25,000 LB each. Each tier has a higher BRAINS burn rate and XNT fee. Once a tier fills, it closes forever. Early believers pay less. Late arrivals pay more.' },
            { icon:'💎', title:'FIXED SUPPLY — HARD CAP', color:'#00c98d', rgb:'0,201,141',
              body:'Total supply: 100,000 LB. Hard cap. Immutable on-chain. Every LB in existence was paid for with BRAINS burned permanently and irreversibly.' },
            { icon:'💰', title:'XNT — THE PLATFORM FEE', color:'#ffaa00', rgb:'255,170,0',
              body:'Every LB minted pays an XNT fee to the protocol treasury. Not burned — deployed for AMM liquidity seeding, staking infrastructure, farming programs, and ecosystem development. 93,750 XNT total across all tiers.' },
            { icon:'⚡', title:'XENBLOCKS AMPLIFIER', color:'#bf5af2', rgb:'191,90,242',
              body:'Combo mints let you add XNM, XUNI, and XBLK alongside your BRAINS to earn bonus LB at no extra XNT cost. 50% of each Xenblocks asset is burned forever, 50% goes to the protocol treasury. Bonus LB scales with the amount you put in.' },
            { icon:'🛡️', title:'ADMIN PAUSE — EXPLOIT PROTECTION', color:'#8a5aff', rgb:'138,90,255',
              body:'The program includes an admin pause mechanism. If an exploit is detected mid-launch, minting can be halted immediately to protect user funds.' },
          ].map(({ icon, title, color, rgb: r, body }) => (
            <div key={title} style={{
              background:`linear-gradient(135deg,rgba(${r},.06),rgba(255,255,255,.02))`,
              border:`1px solid rgba(${r},.18)`, borderRadius:14,
              padding: isMobile ? '14px 14px 14px 20px' : '18px 22px 18px 26px',
              position:'relative', overflow:'hidden',
            }}>
              <div style={{ position:'absolute', top:0, left:0, width:3, bottom:0,
                background:`linear-gradient(180deg,${color},${color}44)`,
                borderRadius:'14px 0 0 14px' }} />
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                <span style={{ fontSize:15 }}>{icon}</span>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 11,
                  fontWeight:900, color, letterSpacing:1 }}>{title}</div>
              </div>
              <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 12,
                color:'#9abacf', lineHeight:1.7 }}>{body}</div>
            </div>
          ))}

          <div style={{
            background:'linear-gradient(135deg,rgba(0,212,255,.04),rgba(191,90,242,.04))',
            border:'1px solid rgba(255,255,255,.1)', borderRadius:14,
            padding: isMobile ? '16px' : '22px 26px',
          }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10,
              fontWeight:900, color:'#9abacf', letterSpacing:2, marginBottom:12 }}>THE NARRATIVE</div>
            <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13,
              color:'#8aaac0', lineHeight:1.8, fontStyle:'italic' }}>
              "Lab Work is not issued. It is not distributed. It is not allocated. It is earned through destruction.
              Every LB holder burned real BRAINS — gone forever — for the right to hold it. The supply is fixed at
              100,000. The cost rises with every tier. By the time the last LB is minted, over 2 million BRAINS
              will have ceased to exist, and the protocol will hold nearly 94,000 XNT ready to build the infrastructure
              that makes Lab Work worth holding. Lab Work lives because BRAINS died. That's the whole story."
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default MintLabWork;
