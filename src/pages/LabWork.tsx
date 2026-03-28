import React, { FC, useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createBurnCheckedInstruction,
  getMint,
} from '@solana/spl-token';
import { TopBar, PageBackground, Footer } from '../components/UI';
import { walletBurnStats } from '../components/BurnedBrainsBar';
import { PLATFORM_WALLET_STRING, BRAINS_MINT as BRAINS_MINT_STR } from '../constants';
import { supabase, getLabWorkPtsForWallet, triggerLabWorkRefresh } from '../lib/supabase';
import type { NFTData, Listing, TradeLog, PageMode, MarketTab } from '../components/LBComponents';
import {
  useIsMobile, getMarketplaceProgramId,
  getSalePda, getVaultPda,
  lamportsToXnt, calcFee, calcCancelFee, calcSellerCut, xntToLamports,
  saveTrade, sendTx, discriminatorAsync,
  enrichNFT, enrichNFTFromMint, fetchWalletNFTs, groupByCollection,
  fetchAllListings, batchEnrichListings, enrichListing, fetchAgentIDByWallet,
  DISC_LIST_NFT, DISC_BUY_NFT, DISC_CANCEL, DISC_UPDATE_PRICE, DISC_SALE_B58,
  METADATA_PROGRAM_ID, PLATFORM_WALLET, MARKETPLACE_DEPLOYED,
  lwPdaCache,
  NFTImage, StatusBox,
  NFTDetailModal, NFTCard, CollectionSection,
  UpdatePriceModal, ListingCard, ConfirmModal,
  SellPanel, ListModal,
} from '../components/LBComponents';

// ═════════════════════════════════════════════════════════════════
//  BOOST FEATURE — SPARK / GODSLAYER / INCINERATOR
// ═════════════════════════════════════════════════════════════════

const BRAINS_DECIMALS = 9;
const BRAINS_MINT_PK  = new PublicKey(BRAINS_MINT_STR);

const BOOST_TIERS = [
  { id: 'spark',       label: '⚡ SPARK',       brains: 1_000,  days: 1,  color: '#00d4ff', desc: '24 hours spotlight' },
  { id: 'godslayer',   label: '⚔️ GODSLAYER',   brains: 2_500,  days: 3,  color: '#bf5af2', desc: '3 days of dominance' },
  { id: 'incinerator', label: '🔥 INCINERATOR', brains: 5_000,  days: 7,  color: '#ff6a00', desc: '7 days, maximum burn' },
] as const;
type BoostTierId = typeof BOOST_TIERS[number]['id'];

interface BoostRecord {
  id:             string;
  listing_pda:    string;
  nft_mint:       string;
  seller:         string;
  tier:           BoostTierId;
  brains:         number;
  labwork_points: number;
  tx_sig:         string;
  expires_at:     string; // ISO
  nftData?:       NFTData;
}

async function loadActiveBoosts(): Promise<BoostRecord[]> {
  if (!supabase) return [];
  try {
    const { data } = await supabase
      .from('labwork_boosts')
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('tier', { ascending: false })   // incinerator > godslayer > spark
      .order('created_at', { ascending: true })
      .limit(3);
    return (data ?? []) as BoostRecord[];
  } catch { return []; }
}

async function saveBoost(b: Omit<BoostRecord, 'id' | 'nftData'>): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('labwork_boosts').upsert(b, { onConflict: 'listing_pda' });
  } catch {}
}

// Save labwork points earned from burning BRAINS for a boost
async function saveLabworkPoints(p: {
  wallet: string; brains_burned: number; points: number;
  source: string; tier: string; tx_sig: string;
}): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('labwork_points').upsert({
      wallet:        p.wallet,
      brains_burned: p.brains_burned,
      points:        p.points,
      source:        p.source,
      tier:          p.tier,
      tx_sig:        p.tx_sig,
      earned_at:     new Date().toISOString(),
    }, { onConflict: 'tx_sig' });
  } catch {}
}

// ─── BoostModal ───────────────────────────────────────────────────
const BoostModal: FC<{
  listing:         Listing;
  isMobile:        boolean;
  connection:      any;
  publicKey:       PublicKey;
  sendTransaction: any;
  signTransaction: ((tx: Transaction) => Promise<Transaction>) | null | undefined;
  onClose:         () => void;
  onBoosted:       () => void;
}> = ({ listing, isMobile, connection, publicKey, sendTransaction, signTransaction, onClose, onBoosted }) => {
  const [tier,      setTier]    = useState<BoostTierId>('spark');
  const [status,    setStatus]  = useState('');
  const [pending,   setPending] = useState(false);
  const [balance,   setBalance] = useState<number | null>(null);
  const [slotsUsed, setSlotsUsed] = useState<number | null>(null); // null = checking
  const nft = listing.nftData;
  const imgUri = nft?.image || nft?.metaUri;

  // Fetch BRAINS balance + active slot count simultaneously
  useEffect(() => {
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(BRAINS_MINT_PK, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const acc = await connection.getParsedAccountInfo(ata);
        const bal = acc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        setBalance(bal);
      } catch { setBalance(0); }
    })();
    // Check how many of the 3 featured slots are currently occupied
    (async () => {
      try {
        const active = await loadActiveBoosts();
        setSlotsUsed(active.length);
      } catch { setSlotsUsed(0); }
    })();
  }, []);

  const selectedTier = BOOST_TIERS.find(t => t.id === tier)!;
  const canAfford    = balance !== null && balance >= selectedTier.brains;
  const slotsAvail   = slotsUsed !== null && slotsUsed < 3;
  const slotsLoading = slotsUsed === null;

  const handleBoost = async () => {
    if (!canAfford || !signTransaction) return;
    if (!slotsAvail) {
      setStatus('❌ All 3 featured slots are currently occupied. Wait for an active boost to expire before boosting.');
      return;
    }
    setPending(true); setStatus('Preparing burn…');
    try {
      // 100% burned — fully deflationary, same mechanism as Portfolio.tsx burnBrainsTokens
      // BRAINS is Token-2022 — must use TOKEN_2022_PROGRAM_ID throughout
      const mintInfo = await getMint(connection, BRAINS_MINT_PK, 'confirmed', TOKEN_2022_PROGRAM_ID);
      const decimals = mintInfo.decimals;
      const burnRaw  = BigInt(Math.floor(selectedTier.brains * 10 ** decimals));
      const fromAta  = getAssociatedTokenAddressSync(BRAINS_MINT_PK, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const burnIx = createBurnCheckedInstruction(
        fromAta, BRAINS_MINT_PK, publicKey, burnRaw, decimals, [], TOKEN_2022_PROGRAM_ID
      );
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash }).add(burnIx);

      setStatus('Awaiting wallet approval…');
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed',
      });

      setStatus('Confirming burn…');
      for (let i = 0; i < 30; i++) {
        if (i) await new Promise(r => setTimeout(r, 500));
        const s = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (s?.value?.err) throw new Error('On-chain error: ' + JSON.stringify(s.value.err));
        const conf = s?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') break;
      }

      // 1.888 labwork points per BRAINS burned
      const labworkPoints = Math.round(selectedTier.brains * 1.888 * 100) / 100;
      const expiresAt     = new Date(Date.now() + selectedTier.days * 86_400_000).toISOString();

      await Promise.all([
        saveBoost({
          listing_pda:    listing.listingPda,
          nft_mint:       listing.nftMint,
          seller:         publicKey.toBase58(),
          tier,
          brains:         selectedTier.brains,
          labwork_points: labworkPoints,
          tx_sig:         sig,
          expires_at:     expiresAt,
        }),
        saveLabworkPoints({
          wallet:        publicKey.toBase58(),
          brains_burned: selectedTier.brains,
          points:        labworkPoints,
          source:        'boost',
          tier,
          tx_sig:        sig,
        }),
      ]);

      // Bust the labwork cache + signal BurnedBrainsBar to re-fetch
      // so Portfolio, IncineratorEngine and the bar all show updated points immediately
      triggerLabWorkRefresh();

      // Save to activity log so it shows in the Activity tab
      saveTrade({
        sig,
        type:      'boost',
        nftMint:   listing.nftMint,
        seller:    publicKey.toBase58(),
        timestamp: Math.floor(Date.now() / 1000),
        brains:    selectedTier.brains,
      });

      setStatus(`✅ Active! 🔥 ${selectedTier.brains.toLocaleString()} BRAINS burned · +${labworkPoints.toLocaleString()} labwork pts · ${selectedTier.days}d featured · <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#bf5af2;text-decoration:underline">View Tx ↗</a>`);
      // Re-fetch our own labwork pts display
      getLabWorkPtsForWallet(publicKey.toBase58()).then(pts => { if (pts > 0) console.debug('[LabWork] fresh labwork pts after boost:', pts); }).catch(() => {});
      setTimeout(() => { onBoosted(); onClose(); }, 4000);
    } catch (e: any) {
      setStatus(`❌ ${e?.message?.slice(0, 100) ?? 'Failed'}`);
    } finally { setPending(false); }
  };

  useEffect(() => {
    let sy = 0;
    try { sy = window.scrollY; document.body.style.position = 'fixed'; document.body.style.top = `-${sy}px`; document.body.style.overflow = 'hidden'; } catch {}
    return () => { try { document.body.style.position = ''; document.body.style.top = ''; document.body.style.overflow = ''; window.scrollTo(0, sy); } catch {} };
  }, []);

  return createPortal(
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,.9)',
      backdropFilter:'blur(14px)', display:'flex', alignItems:'center', justifyContent:'center', padding: isMobile ? 0 : 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width:'100%', maxWidth: isMobile ? '100%' : 480,
        background:'linear-gradient(155deg,#0c1520,#080c0f)',
        border:'1px solid rgba(191,90,242,.4)', borderRadius: isMobile ? '20px 20px 0 0' : 20,
        padding: isMobile ? '24px 18px 32px' : '28px 28px',
        marginTop: isMobile ? 'auto' : 0,
        animation:'labSlideUp 0.24s cubic-bezier(.22,1,.36,1) both',
        position:'relative',
      }}>
        {/* Header */}
        <button onClick={onClose} style={{ position:'absolute', top:14, right:14, width:30, height:30,
          borderRadius:'50%', border:'1px solid rgba(191,90,242,.3)', background:'rgba(8,12,15,.9)',
          cursor:'pointer', color:'#bf5af2', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 15, fontWeight:900, color:'#fff', marginBottom:4 }}>
          🔥 BURN TO BOOST
        </div>
        <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#4a6a8a', marginBottom:20 }}>
          {slotsLoading
              ? 'Checking available slots…'
              : slotsAvail
                ? `Burn BRAINS · earn 1.888 pts/BRAINS · ${3 - slotsUsed!} slot${3 - slotsUsed! !== 1 ? 's' : ''} available`
                : '⚠️ All 3 featured slots are full — wait for an active boost to expire'
            }
        </div>

        {/* NFT preview */}
        <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:20,
          background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.07)', borderRadius:10, padding:'10px 12px' }}>
          <div style={{ width:48, height:48, borderRadius:8, overflow:'hidden', flexShrink:0, background:'#060b12', position:'relative' }}>
            <NFTImage metaUri={imgUri} name={nft?.name ?? ''} />
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color:'#e0f0ff',
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft?.name ?? listing.nftMint.slice(0,12)+'…'}</div>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#4a6a8a', marginTop:2 }}>
              {lamportsToXnt(listing.price)} XNT listed price
            </div>
          </div>
          {balance !== null && (
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#bf5af2' }}>{balance.toLocaleString()}</div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#4a6a8a' }}>BRAINS</div>
            </div>
          )}
        </div>

        {/* Tier selection */}
        <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:20 }}>
          {BOOST_TIERS.map(t => {
            const active = tier === t.id;
            const afford = balance !== null && balance >= t.brains;
            const pts    = Math.round(t.brains * 1.888);
            const rgba   = t.color === '#00d4ff' ? '0,212,255' : t.color === '#bf5af2' ? '191,90,242' : '255,106,0';
            return (
              <button key={t.id} type="button" onClick={() => afford && setTier(t.id)}
                style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px',
                  background: active ? `rgba(${rgba},.12)` : 'rgba(255,255,255,.03)',
                  border: `1px solid ${active ? t.color + '66' : 'rgba(255,255,255,.08)'}`,
                  borderRadius:10, cursor: afford ? 'pointer' : 'not-allowed', opacity: afford ? 1 : 0.4,
                  transition:'all .15s', textAlign:'left', width:'100%' }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 11, fontWeight:900,
                    color: active ? t.color : '#c0d0e0', marginBottom:3 }}>{t.label}</div>
                  <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                    <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#6a8aaa' }}>{t.desc}</span>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700,
                      color:'#00c98d', background:'rgba(0,201,141,.1)', border:'1px solid rgba(0,201,141,.2)',
                      borderRadius:4, padding:'1px 6px' }}>+{pts.toLocaleString()} pts</span>
                  </div>
                </div>
                <div style={{ textAlign:'right', flexShrink:0 }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 12 : 14, fontWeight:900,
                    color: active ? t.color : '#9abacf' }}>{t.brains.toLocaleString()}</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#ff4a4a' }}>🔥 100% BURNED</div>
                </div>
                {active && <div style={{ width:8, height:8, borderRadius:'50%', background: t.color, flexShrink:0 }} />}
              </button>
            );
          })}
        </div>

        <StatusBox msg={status} />

        <button type="button" onClick={handleBoost} disabled={pending || !canAfford || !slotsAvail || slotsLoading}
          style={{ width:'100%', padding:'13px 0',
            background: (canAfford && slotsAvail) ? `linear-gradient(135deg,rgba(191,90,242,.22),rgba(191,90,242,.1))` : 'rgba(255,255,255,.04)',
            border: `1px solid ${(canAfford && slotsAvail) ? 'rgba(191,90,242,.5)' : !slotsAvail && !slotsLoading ? 'rgba(255,100,100,.3)' : 'rgba(255,255,255,.1)'}`,
            borderRadius:10, cursor: (pending || !canAfford || !slotsAvail || slotsLoading) ? 'not-allowed' : 'pointer',
            fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700,
            color: !slotsAvail && !slotsLoading ? '#ff6666' : canAfford ? '#bf5af2' : '#4a6a8a',
            opacity: pending ? 0.7 : 1,
            display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
          {pending
            ? <><div style={{ width:14, height:14, borderRadius:'50%', border:'2px solid rgba(191,90,242,.2)', borderTop:'2px solid #bf5af2', animation:'spin 0.8s linear infinite' }} />BURNING…</>
            : slotsLoading
              ? 'CHECKING SLOTS…'
              : !slotsAvail
                ? `NO SLOTS AVAILABLE · ${3} / 3 OCCUPIED`
                : !canAfford
                  ? `NEED ${selectedTier.brains.toLocaleString()} BRAINS`
                  : `🔥 BURN ${selectedTier.brains.toLocaleString()} BRAINS · BOOST ${selectedTier.days}D`}
        </button>
      </div>
    </div>,
    document.body
  );
};

// ═════════════════════════════════════════════════════════════════
//  MAIN PAGE COMPONENT
// ═════════════════════════════════════════════════════════════════
const LabWork: FC = () => {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { connection }                 = useConnection();
  const isMobile                       = useIsMobile();

  // Page state
  const [pageMode, setPageMode]     = useState<PageMode>('market');
  const [marketTab, setMarketTab]   = useState<MarketTab>('overview');
  const [showListModal, setShowListModal] = useState(false);

  // Gallery state
  const [nfts, setNfts]             = useState<NFTData[]>([]);
  const [loading, setLoading]       = useState(false);
  const [enriching, setEnriching]   = useState(false);
  const [error, setError]           = useState('');
  const [selected, setSelected]     = useState<NFTData | null>(null);
  const [searchQ, setSearchQ]       = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [loadLabel, setLoadLabel]   = useState('');

  // Debounce search — only filter after 150ms of no typing
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchQ), 150);
    return () => clearTimeout(t);
  }, [searchQ]);
  const [prelistNft, setPrelistNft] = useState<NFTData | null>(null);

  // Marketplace state
  const [listings, setListings]               = useState<Listing[]>([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [listingsPage, setListingsPage]       = useState(48);
  const [browseCollection, setBrowseCollection] = useState<string | null>(null); // null = all
  const [confirmTarget, setConfirmTarget]     = useState<{ listing: Listing; mode: 'buy' | 'delist' } | null>(null);
  const [txStatus, setTxStatus]               = useState('');
  const [txPending, setTxPending]             = useState(false);
  const [tradeLogs, setTradeLogs]             = useState<TradeLog[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);

  // Boost state
  const [boosts,       setBoosts]       = useState<BoostRecord[]>([]);
  const [boostTarget,  setBoostTarget]  = useState<Listing | null>(null);

  // Wallet stats for MY NFTs panel
  const [brainsBalance,  setBrainsBalance]  = useState<number | null>(null);
  const [brainsBurned,   setBrainsBurned]   = useState<number | null>(null);
  const [labworkPtsTotal, setLabworkPtsTotal] = useState<number | null>(null);

  // ── Load wallet NFTs ──────────────────────────────────────────
  useEffect(() => {
    if (!publicKey) { setNfts([]); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(''); setLoadLabel('Scanning wallet…');
      try {
        const raw = await fetchWalletNFTs(connection, publicKey);
        if (cancelled) return;
        setNfts(raw); setLoading(false);
        if (raw.length === 0) return;
        setEnriching(true); setLoadLabel('Loading metadata…');
        const enriched = await Promise.all(raw.map(async n => {
          const base = await enrichNFT(n);
          // MoltLab NFTs: their /api/nft/<mint> returns 404 — use AgentID verify by wallet instead
          if (base.metaUri?.includes('moltlab.vercel.app') && publicKey) {
            const agent = await fetchAgentIDByWallet(publicKey.toBase58());
            if (agent) return {
              ...base,
              image:       agent.photoUrl    ?? base.image,
              description: agent.description ?? base.description,
              collection:  'MOLT',
              externalUrl: agent.moltbook
                ? `https://moltbook.com/u/${agent.moltbook}`
                : base.externalUrl,
            };
          }
          return base;
        }));
        if (!cancelled) { setNfts(enriched); setEnriching(false); setLoadLabel(''); }
      } catch (e: any) {
        if (!cancelled) { setError(e?.message ?? 'Failed to load NFTs'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey?.toBase58()]);

  // ── Wallet stats (BRAINS balance, burned, labwork pts) ────────
  useEffect(() => {
    if (!publicKey) {
      setBrainsBalance(null); setBrainsBurned(null); setLabworkPtsTotal(null);
      return;
    }
    const addr = publicKey.toBase58();
    let dead = false;

    // 1. BRAINS balance — Token-2022
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(BRAINS_MINT_PK, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const acc = await connection.getParsedAccountInfo(ata);
        const bal = acc?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (!dead) setBrainsBalance(bal);
      } catch { if (!dead) setBrainsBalance(0); }
    })();

    // 2. Total BRAINS burned — read from walletBurnStats.walletBurned which is
    //    populated by BurnedBrainsBar (on-chain scan of all burn txs, all time).
    //    Poll briefly since BurnedBrainsBar may still be loading when this runs.
    (async () => {
      // Give BurnedBrainsBar up to 4s to populate the global stat
      for (let i = 0; i < 8; i++) {
        const burned = walletBurnStats.walletBurned;
        if (burned > 0) { if (!dead) setBrainsBurned(burned); return; }
        await new Promise(r => setTimeout(r, 500));
      }
      // Fallback: read directly from labwork_points if BurnedBrainsBar hasn't loaded
      try {
        if (!supabase) { if (!dead) setBrainsBurned(0); return; }
        const { data } = await supabase
          .from('labwork_points')
          .select('brains_burned')
          .eq('wallet', addr);
        const total = (data ?? []).reduce((s: number, r: any) => s + (r.brains_burned ?? 0), 0);
        if (!dead) setBrainsBurned(total);
      } catch { if (!dead) setBrainsBurned(walletBurnStats.walletBurned || 0); }
    })();

    // 3. Total labwork points — both labwork_rewards + labwork_points
    (async () => {
      try {
        const pts = await getLabWorkPtsForWallet(addr);
        if (!dead) setLabworkPtsTotal(pts);
      } catch { if (!dead) setLabworkPtsTotal(0); }
    })();

    return () => { dead = true; };
  }, [publicKey?.toBase58()]);

  // Keep brainsBurned + labworkPtsTotal in sync as BurnedBrainsBar/signal update
  useEffect(() => {
    if (!publicKey) return;
    let lastSignal = labWorkSignal.version;
    const interval = setInterval(async () => {
      // Sync burned BRAINS from BurnedBrainsBar global stat
      const burned = walletBurnStats.walletBurned;
      if (burned > 0) setBrainsBurned(burned);
      // Re-fetch labwork pts if signal fired (boost burn completed)
      if (labWorkSignal.version !== lastSignal) {
        lastSignal = labWorkSignal.version;
        try {
          const pts = await getLabWorkPtsForWallet(publicKey.toBase58());
          setLabworkPtsTotal(pts);
        } catch {}
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [publicKey?.toBase58()]);

  const loadListings = useCallback(async () => {
    setLoadingListings(true);
    const [raw, activeBoosts] = await Promise.all([
      fetchAllListings(connection),
      loadActiveBoosts(),
    ]);
    setBoosts(activeBoosts);
    // Render bare listings immediately — grid appears with price/seller data
    setListings(raw);
    setListingsPage(48);
    setLoadingListings(false);
    if (raw.length === 0) return;
    // Batch-fetch all Metaplex PDAs in one RPC call per 100 listings
    // then progressively enrich image/attributes in background
    const withMeta = await batchEnrichListings(connection, raw);
    setListings([...withMeta]);
    // Now fetch off-chain metadata (images/attributes) in batches of 6
    const BATCH = 6;
    let current = [...withMeta];
    for (let i = 0; i < withMeta.length; i += BATCH) {
      const chunk = withMeta.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        chunk.map(async l => {
          if (!l.nftData?.metaUri || l.nftData?.image) return l;
          const enriched = await enrichNFT(l.nftData);
          return { ...l, nftData: enriched };
        })
      );
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') current[i + idx] = r.value;
      });
      setListings([...current]);
    }
  }, [connection]);

  const loadActivity = useCallback(async () => {
    setLoadingActivity(true);
    try {
      // ── Step 1: Supabase first — render immediately if we have data ──
      let supaLogs: TradeLog[] = [];
      try {
        if (supabase) {
          const { data } = await supabase
            .from('labwork_trades')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(50);
          if (data && data.length > 0) {
            supaLogs = data.map((r: any) => ({
              sig: r.sig, type: r.type, nftMint: r.nft_mint,
              price: r.price, seller: r.seller, buyer: r.buyer,
              timestamp: r.timestamp,
            }));
            // Render Supabase logs immediately — don't wait for chain or enrichment
            setTradeLogs(supaLogs);
            setLoadingActivity(false);
          }
        }
      } catch { /* supabase not available */ }

      // ── Step 2: Chain fetch — only if Supabase had no data ──
      // If Supabase returned results we already have good data; skip the slow chain walk.
      let chainLogs: TradeLog[] = [];
      if (supaLogs.length === 0) {
        try {
          const progId     = getMarketplaceProgramId();
          const sigs       = await connection.getSignaturesForAddress(progId, { limit: 25 });
          const validSigs  = sigs.filter((s: any) => !s.err).slice(0, 12);
          const listDisc = DISC_LIST_NFT;
          const buyDisc  = DISC_BUY_NFT;
          const delistDisc = DISC_CANCEL;

          // Fetch all transactions in parallel (not sequential)
          const txResults = await Promise.allSettled(
            validSigs.map((s: any) => connection.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }))
          );

          txResults.forEach((result, idx) => {
            if (result.status !== 'fulfilled' || !result.value) return;
            const tx  = result.value;
            const sig = validSigs[idx].signature;
            const ts  = tx.blockTime ?? 0;
            const msg = tx.transaction?.message;
            const accountKeys: string[] = (msg?.accountKeys ?? msg?.staticAccountKeys ?? [])
              .map((k: any) => k?.toBase58?.() ?? k?.toString?.() ?? k);
            const ixs = msg?.instructions ?? [];

            for (const ix of ixs as any[]) {
              const progKey = accountKeys[ix.programIdIndex ?? -1] ?? '';
              if (progKey !== progId.toBase58()) continue;

              let dataHex = '';
              if (ix.data) {
                try { dataHex = Buffer.from(ix.data, 'base58' as any).toString('hex'); }
                catch { try { dataHex = Buffer.from(ix.data, 'base64').toString('hex'); } catch {} }
              }

              const disc8 = dataHex.slice(0, 16);
              let type: TradeLog['type'] | null = null;
              if (disc8 === listDisc)   type = 'list';
              if (disc8 === buyDisc)    type = 'buy';
              if (disc8 === delistDisc) type = 'delist';
              if (!type) continue;

              const ixAccs = (ix.accounts ?? []).map((i: number) => accountKeys[i] ?? '');
              const mint   = ixAccs[1] ?? '';
              const seller = type === 'buy' ? (ixAccs[5] ?? '') : (ixAccs[0] ?? '');
              const buyer  = type === 'buy' ? (ixAccs[0] ?? '') : undefined;
              let price: number | undefined;
              if (type !== 'delist' && dataHex.length >= 32) {
                try { price = Number(Buffer.from(dataHex.slice(16, 32), 'hex').readBigUInt64LE(0)); } catch {}
              }
              chainLogs.push({ sig, type, nftMint: mint, price, seller, buyer, timestamp: ts });
            }
          });
        } catch { /* chain fetch failed — supabase is fallback */ }
      }

      // ── Step 3: Merge + deduplicate ──
      const supaSet = new Set(supaLogs.map(l => l.sig));
      const merged  = [...supaLogs, ...chainLogs.filter(l => !supaSet.has(l.sig))]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);

      if (merged.length === 0) { setLoadingActivity(false); return; }

      // ── Step 4: Enrich metadata — only top 10, concurrency-capped ──
      // Use cached data first, only fetch what's missing
      const toEnrich = merged.slice(0, 10).filter(l => !l.nftData && l.nftMint);
      const CONCURRENCY = 3;
      const enrichedMap = new Map<string, NFTData>();
      for (let i = 0; i < toEnrich.length; i += CONCURRENCY) {
        const chunk = toEnrich.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map(log => enrichNFTFromMint(connection, log.nftMint))
        );
        results.forEach((r, idx) => {
          if (r.status === 'fulfilled') enrichedMap.set(chunk[idx].sig, r.value);
        });
      }

      const final = merged.map(log =>
        enrichedMap.has(log.sig) ? { ...log, nftData: enrichedMap.get(log.sig) } : log
      );
      setTradeLogs(final);
    } catch (e) { console.error('loadActivity error:', e); }
    setLoadingActivity(false);
  }, [connection]);

  useEffect(() => { loadListings(); }, []);
  useEffect(() => { loadActivity(); }, []);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' as any }); }, []);
  useEffect(() => { if (pageMode === 'gallery' && nfts.length === 0 && publicKey) { /* NFTs load via wallet useEffect */ } }, [pageMode]);
  useEffect(() => { if (marketTab === 'activity') loadActivity(); }, [marketTab]);

  // ── Gallery select ────────────────────────────────────────────
  const handleSelect = useCallback(async (nft: NFTData) => {
    setSelected(nft);
    const fresh = await enrichNFT(nft);
    setSelected(fresh);
  }, []);

  // ── "List this" shortcut from gallery modal ───────────────────
  const handleListFromGallery = (nft: NFTData) => {
    setPrelistNft(nft); setShowListModal(true);
  };

  // Stable callbacks for ListingCard — using listing PDA as identifier
  // so React.memo on ListingCard actually prevents re-renders
  const handleBuy    = useCallback((listing: Listing) => { setConfirmTarget({ listing, mode:'buy' });    setTxStatus(''); }, []);
  const handleDelist = useCallback((listing: Listing) => { setConfirmTarget({ listing, mode:'delist' }); setTxStatus(''); }, []);
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null);
  const handleInspectListing = useCallback((listing: Listing) => { setSelectedListing(listing); }, []);
  const [updatePriceListing, setUpdatePriceListing] = useState<Listing | null>(null);
  const handleUpdatePrice = useCallback((listing: Listing) => { setUpdatePriceListing(listing); }, []);

  // ── BUY transaction ───────────────────────────────────────────
  const executeBuy = async () => {
    if (!publicKey || !confirmTarget) return;
    const { listing } = confirmTarget;
    setTxPending(true); setTxStatus('Preparing…');
    try {
      const nftMint    = new PublicKey(listing.nftMint);
      const sellerPk   = new PublicKey(listing.seller);
      const [salePda]  = getSalePda(nftMint, sellerPk);
      const [vaultPda] = getVaultPda(nftMint, sellerPk);
      const buyerAta   = getAssociatedTokenAddressSync(nftMint, publicKey);

      const disc = Buffer.from(DISC_BUY_NFT, 'hex');
      const preIxs: any[] = [];
      if (!(await connection.getAccountInfo(buyerAta)))
        preIxs.push(createAssociatedTokenAccountInstruction(publicKey, buyerAta, publicKey, nftMint));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,               isSigner:true,  isWritable:true  }, // 0 buyer
          { pubkey: nftMint,                 isSigner:false, isWritable:false }, // 1 nft_mint
          { pubkey: buyerAta,                isSigner:false, isWritable:true  }, // 2 buyer_nft_account
          { pubkey: vaultPda,                isSigner:false, isWritable:true  }, // 3 vault_nft_account
          { pubkey: salePda,                 isSigner:false, isWritable:true  }, // 4 sale
          { pubkey: sellerPk,                isSigner:false, isWritable:true  }, // 5 seller_wallet
          { pubkey: PLATFORM_WALLET!,        isSigner:false, isWritable:true  }, // 6 platform_wallet
          { pubkey: TOKEN_PROGRAM_ID,        isSigner:false, isWritable:false }, // 7 token_program
          { pubkey: SystemProgram.programId, isSigner:false, isWritable:false }, // 8 system_program
        ],
        data: disc,
      };
      const tx = new Transaction().add(...preIxs, ix as any);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      setTxStatus('Awaiting wallet approval…');
      const sig = await sendTx(tx, connection, sendTransaction, signTransaction);
      setTxStatus(`Confirming… tx: ${sig.slice(0,20)}…`);
      let confirmed = false;
      for (let i = 0; i < 40; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const conf = status?.value?.confirmationStatus;
        const err  = status?.value?.err;
        if (err) throw new Error('On-chain error: ' + JSON.stringify(err));
        if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
      }
      if (!confirmed) throw new Error(`Timed out. Check tx: ${sig}`);
      setTxStatus(`✅ NFT purchased! <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#00d4ff;text-decoration:underline">View Tx ↗</a>`);
      saveTrade({ sig, type:'buy', nftMint: listing.nftMint, price: listing.price, seller: listing.seller, buyer: publicKey.toBase58(), timestamp: Math.floor(Date.now()/1000) });
      setTimeout(() => { setConfirmTarget(null); setTxStatus(''); loadListings(); }, 2500);
    } catch (e: any) {
      setTxStatus(`❌ ${e?.message?.slice(0,120) ?? 'Transaction failed'}`);
    } finally { setTxPending(false); }
  };

  // ── DELIST transaction ────────────────────────────────────────
  const executeDelist = async () => {
    if (!publicKey || !confirmTarget) return;
    const { listing } = confirmTarget;
    setTxPending(true); setTxStatus('Preparing…');
    try {
      const nftMint    = new PublicKey(listing.nftMint);
      const [salePda]  = getSalePda(nftMint, publicKey);
      const [vaultPda] = getVaultPda(nftMint, publicKey);
      const sellerAta  = getAssociatedTokenAddressSync(nftMint, publicKey);

      const disc = Buffer.from(DISC_CANCEL, 'hex');
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const ix = {
        programId: getMarketplaceProgramId(),
        keys: [
          { pubkey: publicKey,               isSigner:true,  isWritable:true  }, // 0 seller
          { pubkey: nftMint,                 isSigner:false, isWritable:false }, // 1 nft_mint
          { pubkey: sellerAta,               isSigner:false, isWritable:true  }, // 2 seller_nft_account
          { pubkey: vaultPda,                isSigner:false, isWritable:true  }, // 3 vault_nft_account
          { pubkey: salePda,                 isSigner:false, isWritable:true  }, // 4 sale
          { pubkey: PLATFORM_WALLET!,        isSigner:false, isWritable:true  }, // 5 platform_wallet
          { pubkey: TOKEN_PROGRAM_ID,        isSigner:false, isWritable:false }, // 6 token_program
          { pubkey: SystemProgram.programId, isSigner:false, isWritable:false }, // 7 system_program
        ],
        data: disc,
      };
      const tx = new Transaction().add(ix as any);
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      setTxStatus('Awaiting wallet approval…');
      const sig = await sendTx(tx, connection, sendTransaction, signTransaction, false);
      setTxStatus(`Confirming… tx: ${sig.slice(0,20)}…`);
      let confirmed = false;
      for (let i = 0; i < 40; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1500));
        const status = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        const conf = status?.value?.confirmationStatus;
        const err  = status?.value?.err;
        if (err) throw new Error('On-chain error: ' + JSON.stringify(err));
        if (conf === 'confirmed' || conf === 'finalized') { confirmed = true; break; }
      }
      if (!confirmed) throw new Error(`Timed out. Check tx: ${sig}`);
      setTxStatus(`✅ Delisted! <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#00d4ff;text-decoration:underline">View Tx ↗</a>`);
      saveTrade({ sig, type:'delist', nftMint: listing.nftMint, price: listing.price, seller: publicKey.toBase58(), timestamp: Math.floor(Date.now()/1000) });
      setTimeout(() => { setConfirmTarget(null); setTxStatus(''); loadListings(); }, 2000);
    } catch (e: any) {
      setTxStatus(`❌ ${e?.message?.slice(0,120) ?? 'Transaction failed'}`);
    } finally { setTxPending(false); }
  };

  // ── Derived ───────────────────────────────────────────────────
  const filtered    = useMemo(() => searchDebounced
    ? nfts.filter(n => n.name.toLowerCase().includes(searchDebounced.toLowerCase()) || n.symbol.toLowerCase().includes(searchDebounced.toLowerCase()) || (n.collection ?? '').toLowerCase().includes(searchDebounced.toLowerCase()))
    : nfts, [nfts, searchDebounced]);
  const groups      = useMemo(() => groupByCollection(filtered), [filtered]);
  const myListings  = useMemo(() => listings.filter(l => l.seller === publicKey?.toBase58()), [listings, publicKey]);
  // Unique collections in marketplace listings — visible without wallet connection
  const listingCollections = useMemo(() => {
    const s = new Set<string>();
    listings.forEach(l => s.add(l.nftData?.collection || l.nftData?.symbol || 'Unknown'));
    return s.size;
  }, [listings]);

  // ─────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:'100vh', background:'#080c0f',
      padding: isMobile ? '70px 10px 40px' : '90px 24px 60px', position:'relative', overflow:'hidden' }}>
      <TopBar />
      <PageBackground />
      <div style={{ position:'fixed', top:'20%', left:'10%', width:600, height:600, borderRadius:'50%',
        background:'radial-gradient(circle,rgba(0,212,255,0.04) 0%,transparent 60%)', pointerEvents:'none', zIndex:0 }} />
      <div style={{ position:'fixed', top:'60%', right:'5%', width:500, height:500, borderRadius:'50%',
        background:'radial-gradient(circle,rgba(191,90,242,0.05) 0%,transparent 60%)', pointerEvents:'none', zIndex:0 }} />

      <style>{`
        @keyframes fadeUp     { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin       { to{transform:rotate(360deg)} }
        @keyframes labGlow    { 0%,100%{opacity:.4} 50%{opacity:1} }
        @keyframes pulse-cyan { 0%,100%{box-shadow:0 0 6px #00d4ff} 50%{box-shadow:0 0 18px #00d4ff} }
        @keyframes marketplace-pulse {
          0%,100% { box-shadow:0 0 6px rgba(0,255,128,.12); border-color:rgba(0,255,128,.2); }
          50%      { box-shadow:0 0 16px rgba(0,255,128,.35), 0 0 32px rgba(0,255,128,.1); border-color:rgba(0,255,128,.5); }
        }
        @keyframes hdr-shimmer {
          0%   { background-position: -200% center; }
          100% { background-position:  200% center; }
        }
        @keyframes hdr-scan {
          0%   { transform:translateY(-100%) scaleX(.6); opacity:0; }
          10%  { opacity:1; }
          90%  { opacity:1; }
          100% { transform:translateY(600%) scaleX(1); opacity:0; }
        }
        @keyframes hdr-orb {
          0%,100% { transform:scale(1)   opacity:.5; }
          50%     { transform:scale(1.15) opacity:.8; }
        }
        @keyframes hdr-float {
          0%,100% { transform:translateY(0px); }
          50%     { transform:translateY(-6px); }
        }
        @keyframes hdr-counter {
          from { opacity:0; transform:translateY(8px) scale(.85); }
          to   { opacity:1; transform:translateY(0)   scale(1); }
        }
        @keyframes hdr-badge-pulse {
          0%,100% { opacity:.7; }
          50%     { opacity:1; box-shadow:0 0 14px currentColor; }
        }
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
        input[type=number]  { -moz-appearance:textfield; }
        input::placeholder  { color:#4a6a8a; }
      `}</style>

      <div style={{ position:'relative', zIndex:1, maxWidth:1100, margin:'0 auto' }}>

        {/* ── PAGE HEADER ───────────────────────────────────────── */}
        <div style={{ textAlign:'center', marginBottom: isMobile ? 28 : 48, position:'relative',
          minHeight: isMobile ? 200 : 280, display:'flex', flexDirection:'column',
          alignItems:'center', justifyContent:'center' }}>

          {/* Background glow orbs — behind everything */}
          <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
            width: isMobile ? 320 : 600, height: isMobile ? 180 : 280, borderRadius:'50%',
            background:'radial-gradient(ellipse,rgba(0,212,255,.07) 0%,rgba(191,90,242,.04) 40%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 4s ease-in-out infinite', zIndex:0 }} />
          <div style={{ position:'absolute', top:'30%', left:'20%',
            width: isMobile ? 80 : 160, height: isMobile ? 80 : 160, borderRadius:'50%',
            background:'radial-gradient(circle,rgba(0,212,255,.06) 0%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 3.2s ease-in-out infinite 0.5s', zIndex:0 }} />
          <div style={{ position:'absolute', top:'30%', right:'20%',
            width: isMobile ? 80 : 160, height: isMobile ? 80 : 160, borderRadius:'50%',
            background:'radial-gradient(circle,rgba(191,90,242,.06) 0%,transparent 70%)',
            pointerEvents:'none', animation:'hdr-orb 3.8s ease-in-out infinite 1s', zIndex:0 }} />

          {/* All content above orbs */}
          <div style={{ position:'relative', zIndex:1, width:'100%' }}>

          {/* Main title */}
          <div style={{ position:'relative', display:'inline-block', animation:'fadeUp 0.5s ease 0.05s both' }}>
            {/* Subtle glow line below title */}
            <div style={{ position:'absolute', bottom:-6, left:'15%', right:'15%', height:1,
              background:'linear-gradient(90deg,transparent,rgba(0,212,255,.2),rgba(191,90,242,.15),transparent)',
              pointerEvents:'none', animation:'hdr-shimmer 5s ease-in-out infinite' }} />
            <h1 style={{ fontFamily:'Orbitron,monospace',
              fontSize: isMobile ? 26 : 48, fontWeight:900,
              letterSpacing: isMobile ? 2 : 4, margin:'0 0 4px', lineHeight:1.05,
              textTransform:'uppercase', position:'relative' }}>
              <span style={{
                background:'linear-gradient(90deg,#00d4ff,#bf5af2,#00c98d,#00d4ff)',
                backgroundSize:'200% auto',
                WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text',
                animation:'hdr-shimmer 3s linear infinite', display:'inline',
              }}>X1 LAB WORK</span>
              <span style={{ WebkitTextFillColor:'initial', backgroundClip:'initial', background:'none',
                marginLeft: isMobile ? 8 : 12, fontSize: isMobile ? 22 : 40,
                display:'inline-block', animation:'hdr-float 2.5s ease-in-out infinite',
                verticalAlign:'middle' }}>🧪</span>
              <span style={{
                background:'linear-gradient(90deg,#00c98d,#00d4ff,#bf5af2,#00c98d)',
                backgroundSize:'200% auto',
                WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text',
                animation:'hdr-shimmer 3s linear infinite 0.5s',
                display:'inline', marginLeft: isMobile ? 8 : 12,
              }}>NFTs</span>
            </h1>
          </div>

          {/* Eyebrow — sits below title, muted */}
          <div style={{ marginTop: isMobile ? 8 : 10, marginBottom: isMobile ? 4 : 6,
            animation:'fadeUp 0.5s ease 0.12s both' }}>
            <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 8,
              color:'#9abace', letterSpacing: isMobile ? 2 : 3 }}>
              X1 BLOCKCHAIN · NFT SCANNER & MARKETPLACE
            </span>
          </div>

          {/* Subtitle */}
          <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 13, color:'#8aaac0',
            marginBottom: isMobile ? 20 : 28, marginTop: isMobile ? 6 : 8,
            letterSpacing:.5, animation:'fadeUp 0.5s ease 0.15s both' }}>
            Scan &nbsp;·&nbsp; Inspect &nbsp;·&nbsp;
            <span style={{ color:'#00c98d' }}>List</span> &nbsp;·&nbsp;
            <span style={{ color:'#00d4ff' }}>Buy</span> &nbsp;·&nbsp;
            <span style={{ color:'#bf5af2' }}>Sell</span>
            {!isMobile && <span style={{ color:'#9abacf' }}> — powered by X1 blockchain & native XNT</span>}
          </div>

          {/* Stats — always visible, no wallet required */}
          <div style={{ display:'inline-flex', justifyContent:'center', alignItems:'center',
              animation:'fadeUp 0.5s ease 0.22s both',
              background:'rgba(255,255,255,.025)', border:'1px solid rgba(255,255,255,.07)',
              borderRadius:50, padding: isMobile ? '8px 16px' : '10px 24px',
              backdropFilter:'blur(8px)', flexWrap:'wrap', gap:0 }}>
              {[
                { label:'LISTED',      color:'#00c98d', value: listings.length },
                { label:'MY NFTs',     color:'#00d4ff', value: nfts.length     },
                { label:'COLLECTIONS', color:'#bf5af2', value: listingCollections },
                { label:'CHAIN',       color:'#ff8c00', value: 'X1'            },
              ].map(({ label, color, value }, i, arr) => (
                <React.Fragment key={label}>
                  <div style={{ textAlign:'center', padding: isMobile ? '2px 12px' : '2px 20px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 18 : 24,
                      fontWeight:900, color, lineHeight:1, marginBottom:2 }}>{value}</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7,
                      color:'#9abacf', letterSpacing:1.5 }}>{label}</div>
                  </div>
                  {i < arr.length - 1 && (
                    <div style={{ width:1, height: isMobile ? 26 : 34,
                      background:'rgba(255,255,255,.08)', flexShrink:0 }} />
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>{/* end zIndex:1 content wrapper */}
        </div>{/* end PAGE HEADER */}

        {/* ── MODE SWITCHER ─────────────────────────────────────── */}
        <div style={{ display:'flex', gap:6, marginBottom: isMobile ? 20 : 30, background:'rgba(255,255,255,.03)',
          borderRadius:14, padding:4, border:'1px solid rgba(255,255,255,.06)', animation:'fadeUp 0.4s ease 0.12s both' }}>
          {([
            { id:'market',  label:'🛒 MARKETPLACE', sub: listings.length > 0 ? `${listings.length} listed` : 'list & buy NFTs' },
            { id:'gallery', label:'🧪 MY NFTs',     sub: nfts.length > 0 ? `${nfts.length} found` : 'view your collection' },
          ] as { id:PageMode; label:string; sub:string }[]).map(m => (
            <button key={m.id} onClick={() => setPageMode(m.id)} style={{ flex:1, padding: isMobile ? '10px 6px' : '13px 10px',
              background: pageMode===m.id ? 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.08))' : 'transparent',
              border: pageMode===m.id ? '1px solid rgba(0,212,255,.35)' : '1px solid transparent',
              borderRadius:11, cursor:'pointer', transition:'all 0.18s', textAlign:'center' }}>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900,
                color: pageMode===m.id ? '#00d4ff' : '#4a6a8a', marginBottom:2 }}>{m.label}</div>
              <div style={{ fontFamily:'Orbitron,monospace', fontSize:7,
                color: pageMode===m.id ? 'rgba(0,212,255,.55)' : '#3a5a7a', letterSpacing:1 }}>{m.sub}</div>
            </button>
          ))}
        </div>

        {/* ════════════════════════════════════════════════════════
            GALLERY MODE
        ════════════════════════════════════════════════════════ */}
        {pageMode === 'gallery' && (
          <>
            {!publicKey && (
              <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '100px 40px', animation:'fadeUp 0.5s ease 0.1s both' }}>
                <div style={{ fontSize:64, marginBottom:24 }}>🧪</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 20, fontWeight:900, color:'#9abacf', marginBottom:12, letterSpacing:2 }}>WALLET NOT CONNECTED</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#9abace', maxWidth:340, margin:'0 auto' }}>Connect your wallet to scan for NFTs on X1</div>
              </div>
            )}
            {loading && (
              <div style={{ textAlign:'center', padding:'80px 20px', animation:'fadeUp 0.4s ease both' }}>
                <div style={{ fontSize:48, marginBottom:20, animation:'spin 2s linear infinite', display:'inline-block' }}>🧪</div>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, color:'#00d4ff', letterSpacing:2, marginBottom:8 }}>SCANNING NFTs…</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abacf' }}>{loadLabel}</div>
              </div>
            )}
            {error && (
              <div style={{ textAlign:'center', padding:'40px 20px', background:'rgba(255,50,50,.06)', border:'1px solid rgba(255,50,50,.2)', borderRadius:14, marginBottom:24 }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#ff4444', marginBottom:6 }}>SCAN ERROR</div>
                <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#aa5555' }}>{error}</div>
              </div>
            )}
            {!loading && publicKey && nfts.length === 0 && !error && (
              <div style={{ animation:'fadeUp 0.5s ease both' }}>
                {/* Stats even when no NFTs */}
                <div style={{ display:'flex', gap: isMobile ? 8 : 12, marginBottom: isMobile ? 20 : 28 }}>
                  {[
                    { label:'BRAINS BALANCE', value: brainsBalance === null ? '…' : brainsBalance.toLocaleString(undefined, { maximumFractionDigits:0 }), color:'#bf5af2', icon:'🧠' },
                    { label:'BRAINS BURNED',  value: brainsBurned  === null ? '…' : brainsBurned.toLocaleString(undefined,  { maximumFractionDigits:0 }), color:'#ff6a00', icon:'🔥' },
                    { label:'LABWORK PTS',    value: labworkPtsTotal === null ? '…' : Math.round(labworkPtsTotal).toLocaleString(), color:'#00d4ff', icon:'🧪' },
                  ].map(({ label, value, color, icon }) => (
                    <div key={label} style={{ flex:1, background:'rgba(255,255,255,.03)',
                      border:`1px solid ${color}22`, borderRadius:10,
                      padding: isMobile ? '10px 10px' : '12px 16px', textAlign:'center' }}>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 18,
                        fontWeight:900, color, marginBottom:3 }}>{icon} {value}</div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7,
                        color:'#4a6a8a', letterSpacing:1.5 }}>{label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ textAlign:'center', padding: isMobile ? '40px 20px' : '60px 40px' }}>
                  <div style={{ fontSize:56, marginBottom:20 }}>🔬</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 13 : 18, fontWeight:900, color:'#9abacf', marginBottom:10, letterSpacing:2 }}>NO NFTs DETECTED</div>
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 13, color:'#9abace', maxWidth:360, margin:'0 auto' }}>No NFTs found. NFTs are tokens with 0 decimals and balance of 1.</div>
                </div>
              </div>
            )}
            {!loading && nfts.length > 0 && (
              <>
                {/* ── Wallet stats strip ── */}
                {publicKey && (
                  <div style={{ display:'flex', gap: isMobile ? 8 : 12, marginBottom: isMobile ? 16 : 20,
                    animation:'fadeUp 0.4s ease 0.1s both' }}>
                    {[
                      {
                        label: 'BRAINS BALANCE',
                        value: brainsBalance === null ? '…' : brainsBalance.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                        color: '#bf5af2', icon: '🧠',
                      },
                      {
                        label: 'BRAINS BURNED',
                        value: brainsBurned === null ? '…' : brainsBurned.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                        color: '#ff6a00', icon: '🔥',
                      },
                      {
                        label: 'LABWORK PTS',
                        value: labworkPtsTotal === null ? '…' : Math.round(labworkPtsTotal).toLocaleString(),
                        color: '#00d4ff', icon: '🧪',
                      },
                    ].map(({ label, value, color, icon }) => (
                      <div key={label} style={{ flex:1, background:'rgba(255,255,255,.03)',
                        border:`1px solid ${color}22`, borderRadius:10,
                        padding: isMobile ? '10px 10px' : '12px 16px', textAlign:'center' }}>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 18,
                          fontWeight:900, color, marginBottom:3, letterSpacing:.5 }}>
                          {icon} {value}
                        </div>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7,
                          color:'#4a6a8a', letterSpacing:1.5 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Search bar ── */}
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20, animation:'fadeUp 0.4s ease 0.15s both' }}>
                  <div style={{ flex:1, position:'relative' }}>
                    <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', pointerEvents:'none' }}>🔍</span>
                    <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder="Search by name, symbol or collection…"
                      style={{ width:'100%', boxSizing:'border-box', padding: isMobile ? '9px 12px 9px 34px' : '10px 14px 10px 36px', background:'rgba(255,255,255,.04)',
                        border:'1px solid rgba(0,212,255,.2)', borderRadius:10, outline:'none',
                        fontFamily:'Sora,sans-serif', fontSize: isMobile ? 11 : 12, color:'#c0d0e0', caretColor:'#00d4ff' }} />
                  </div>
                  {enriching && (
                    <div style={{ display:'flex', alignItems:'center', gap:6, background:'rgba(0,212,255,.06)', border:'1px solid rgba(0,212,255,.2)', borderRadius:8, padding:'6px 12px', flexShrink:0 }}>
                      <div style={{ width:7, height:7, borderRadius:'50%', background:'#00d4ff', animation:'pulse-cyan 1.5s ease infinite' }} />
                      <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#00d4ff', letterSpacing:1 }}>{isMobile ? 'LOADING…' : 'LOADING METADATA…'}</span>
                    </div>
                  )}
                </div>

                {filtered.length === 0
                  ? <div style={{ textAlign:'center', padding:'40px 0', fontFamily:'Orbitron,monospace', fontSize:11, color:'#9abacf' }}>NO RESULTS FOR "{searchQ}"</div>
                  : Array.from(groups.entries()).map(([colName, colNfts], idx) => (
                    <CollectionSection key={colName} collectionName={colName} nfts={colNfts}
                      isMobile={isMobile} colIndex={idx} onSelect={handleSelect} />
                  ))
                }
              </>
            )}
          </>
        )}

        {/* ════════════════════════════════════════════════════════
            MARKETPLACE MODE
        ════════════════════════════════════════════════════════ */}
        {pageMode === 'market' && (
          <>
            {/* Not deployed banner */}
            {!MARKETPLACE_DEPLOYED && (
              <div style={{ padding:'16px 20px', marginBottom:20, background:'rgba(255,153,0,.08)', border:'1px solid rgba(255,153,0,.3)', borderRadius:12, fontFamily:'Sora,sans-serif', fontSize:12, color:'#ffaa44', display:'flex', alignItems:'center', gap:10 }}>
                <span style={{ fontSize:20 }}>🚧</span>
                <div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, marginBottom:2 }}>MARKETPLACE NOT DEPLOYED</div>
                  <div style={{ fontSize:10, color:'#aa7733' }}>Set MARKETPLACE_PROGRAM_ID_STRING in constants/index.ts to enable trading.</div>
                </div>
              </div>
            )}

            {/* ── Market tabs ── */}
            <div style={{ display:'flex', gap:4, marginBottom: isMobile ? 18 : 24, background:'rgba(255,255,255,.03)',
              borderRadius:12, padding:4, border:'1px solid rgba(255,255,255,.06)', animation:'fadeUp 0.3s ease 0.05s both' }}>
              {([
                { id:'overview',   label: isMobile ? '📊 HOME' : '📊 OVERVIEW',              badge: null             },
                { id:'browse',     label: isMobile ? '🟢 BUY'  : '🟢 MARKETPLACE LISTINGS',  badge: listings.length  },
                { id:'mylistings', label: isMobile ? '📋 MINE' : '📋 MINE',                  badge: myListings.length },
                { id:'sell',       label: isMobile ? '🏷️ SELL' : '🏷️ SELL',                 badge: null             },
                { id:'activity',   label: isMobile ? '⚡ LOG'  : '⚡ ACTIVITY',              badge: null             },
              ] as { id:MarketTab; label:string; badge:number|null }[]).map(t => {
                const isBrowse = t.id === 'browse';
                const isActive = marketTab === t.id;
                return (
                <button key={t.id} type="button" onClick={() => {
                  setMarketTab(t.id);
                  if (t.id === 'sell' && prelistNft) setShowListModal(true);
                }} style={{ flex: isBrowse ? 1.6 : 1,
                  padding: isMobile ? '9px 4px' : '10px 8px',
                  background: isActive && isBrowse
                    ? 'linear-gradient(135deg,rgba(0,255,128,.18),rgba(0,200,100,.08))'
                    : isActive
                    ? 'linear-gradient(135deg,rgba(0,212,255,.15),rgba(191,90,242,.08))'
                    : isBrowse
                    ? 'linear-gradient(135deg,rgba(0,255,128,.06),rgba(0,200,100,.02))'
                    : 'transparent',
                  border: isActive && isBrowse
                    ? '1px solid rgba(0,255,128,.7)'
                    : isActive
                    ? '1px solid rgba(0,212,255,.35)'
                    : isBrowse
                    ? '1px solid rgba(0,255,128,.25)'
                    : '1px solid transparent',
                  borderRadius:9, cursor:'pointer', transition:'all 0.15s',
                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? (isBrowse ? 8 : 9) : (isBrowse ? 9 : 9), fontWeight:700,
                  color: isActive && isBrowse ? '#00ff80' : isActive ? '#00d4ff' : isBrowse ? '#00cc66' : '#4a6a8a',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:4,
                  boxShadow: isBrowse ? (isActive ? '0 0 18px rgba(0,255,128,.25), inset 0 0 12px rgba(0,255,128,.06)' : '0 0 8px rgba(0,255,128,.1)') : 'none',
                  animation: isBrowse && !isActive ? 'marketplace-pulse 2s ease-in-out infinite' : 'none',
                }}>
                  {t.label}
                  {t.badge !== null && t.badge > 0 && (
                    <span style={{
                      background: isBrowse ? 'rgba(0,255,128,.25)' : 'rgba(0,212,255,.2)',
                      border: isBrowse ? '1px solid rgba(0,255,128,.4)' : '1px solid rgba(0,212,255,.3)',
                      borderRadius:10, padding:'0 5px', fontSize:7,
                      color: isBrowse ? '#00ff80' : '#00d4ff'
                    }}>{t.badge}</span>
                  )}
                </button>
                );
              })}
            </div>

            {/* ══════════════════════════════════════
                OVERVIEW TAB
            ══════════════════════════════════════ */}
            {marketTab === 'overview' && (() => {
              const sales        = tradeLogs.filter(l => l.type === 'buy' && l.price);
              const totalVolXnt  = sales.reduce((s, l) => s + (l.price ?? 0), 0) / 1e9;
              const biggestSale  = sales.reduce((best, l) => (!best || (l.price ?? 0) > (best.price ?? 0)) ? l : best, null as TradeLog | null);
              const floorListing = listings.length > 0 ? listings.reduce((a, b) => a.price < b.price ? a : b) : null;

              // Build collection map — used for Top Collections AND Browse preview
              const colMap = new Map<string, { count: number; floor: number; items: Listing[]; volume: number; displayName: string }>();
              listings.forEach(l => {
                // Use collection name first, then symbol — normalize to uppercase for dedup
                const rawName = l.nftData?.collection || l.nftData?.symbol || 'Unknown';
                const key = rawName.trim().toUpperCase();
                if (!colMap.has(key)) colMap.set(key, { count:0, floor:Infinity, items:[], volume:0, displayName: rawName });
                const e = colMap.get(key)!;
                // Prefer longer/more descriptive display name
                if (rawName.length > e.displayName.length) e.displayName = rawName;
                e.count++; e.floor = Math.min(e.floor, l.price); e.items.push(l);
              });
              // Add volume from sales
              sales.forEach(s => {
                const rawNftCol = s.nftData?.collection || s.nftData?.symbol;
                if (rawNftCol) {
                  const key = rawNftCol.trim().toUpperCase();
                  if (colMap.has(key)) colMap.get(key)!.volume += s.price ?? 0;
                }
              });
              const topCollections = Array.from(colMap.entries())
                .sort((a,b) => b[1].count - a[1].count).slice(0, 6)
                .map(([, data]) => [data.displayName, data] as [string, typeof data]);

              return (
                <div style={{ animation:'fadeUp 0.3s ease both' }}>

                  {/* ── Hero stats ── */}
                  <div style={{ display:'flex', alignItems:'center', gap:0,
                    background:'rgba(255,255,255,.03)', borderRadius:12, overflow:'hidden',
                    border:'1px solid rgba(255,255,255,.07)', marginBottom: isMobile ? 20 : 28,
                    flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                    {[
                      { label:'TOTAL LISTINGS', value: listings.length.toString(),      unit:'',    color:'#00d4ff', sub:'active on-chain' },
                      { label:'TOTAL VOLUME',   value: totalVolXnt.toFixed(2),          unit:'XNT', color:'#00c98d', sub:'all time' },
                      { label:'FLOOR PRICE',    value: floorListing ? lamportsToXnt(floorListing.price) : '—', unit: floorListing ? 'XNT' : '', color:'#bf5af2', sub:'lowest listing' },
                      { label:'TOTAL SALES',    value: sales.length.toString(),         unit:'',    color:'#ffaa00', sub:'completed buys' },
                    ].map(({ label, value, unit, color, sub }, i, arr) => (
                      <div key={label} style={{
                        flex: isMobile ? '1 1 50%' : 1,
                        padding: isMobile ? '14px 16px' : '18px 22px',
                        borderRight: i < arr.length - 1 ? '1px solid rgba(255,255,255,.07)' : 'none',
                        borderBottom: isMobile && i < 2 ? '1px solid rgba(255,255,255,.07)' : 'none',
                        display:'flex', flexDirection:'column', gap:4,
                      }}>
                        <div style={{ display:'flex', alignItems:'baseline', gap:5, lineHeight:1 }}>
                          <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 18 : 22, fontWeight:900, color }}>{value}</span>
                          {unit && <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, color, opacity:.7 }}>{unit}</span>}
                        </div>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7, color:'#9abacf', letterSpacing:1.5 }}>{label}</div>
                        <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 8 : 9, color:'#6a8aaa' }}>{sub}</div>
                      </div>
                    ))}
                  </div>

                  {/* ── Main content: top collections (left) + biggest sale / CTAs (right) ── */}
                  <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 320px', gap: isMobile ? 16 : 20, marginBottom: isMobile ? 20 : 28 }}>

                    {/* TOP COLLECTIONS — bigger, more info per row */}
                    <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(0,212,255,.12)', borderRadius:16,
                      padding: isMobile ? '16px 14px' : '22px 24px', position:'relative', overflow:'hidden' }}>
                      <div style={{ position:'absolute', top:0, left:0, right:0, height:2,
                        background:'linear-gradient(90deg,#00d4ff,#bf5af2,#00c98d)' }} />
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: isMobile ? 14 : 18 }}>
                        <div>
                          <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:'#fff', letterSpacing:1.5 }}>TOP COLLECTIONS</div>
                          <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:3 }}>by active listings</div>
                        </div>
                        <button type="button" onClick={() => setMarketTab('browse')}
                          style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#00d4ff', background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.2)', borderRadius:7, padding:'6px 14px', cursor:'pointer', fontWeight:700 }}>
                          VIEW ALL ↗
                        </button>
                      </div>

                      {listings.length === 0 ? (
                        <div style={{ textAlign:'center', padding:'40px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abace' }}>
                          {loadingListings ? 'LOADING…' : 'NO LISTINGS YET'}
                        </div>
                      ) : (
                        <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 10 : 12 }}>
                          {/* Top 3 — full detail rows */}
                          {topCollections.slice(0, 3).map(([colName, data], idx) => {
                            const colors = ['#00d4ff','#bf5af2','#00c98d','#ffaa00','#ff6644','#4488ff'];
                            const col    = colors[idx % colors.length];
                            const sample = data.items[0];
                            const img    = sample?.nftData?.image || sample?.nftData?.metaUri;
                            return (
                              <div key={colName}
                                onClick={() => { setBrowseCollection(colName); setMarketTab('browse'); }}
                                style={{ display:'flex', alignItems:'center', gap: isMobile ? 10 : 14, padding: isMobile ? '10px 12px' : '13px 16px',
                                  background:'rgba(255,255,255,.025)', borderRadius:12, cursor:'pointer',
                                  border:`1px solid rgba(255,255,255,.05)`, transition:'all 0.15s' }}
                                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background=`rgba(255,255,255,.05)`; (e.currentTarget as HTMLDivElement).style.borderColor=`${col}33`; (e.currentTarget as HTMLDivElement).style.transform='translateX(3px)'; }}
                                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background='rgba(255,255,255,.025)'; (e.currentTarget as HTMLDivElement).style.borderColor='rgba(255,255,255,.05)'; (e.currentTarget as HTMLDivElement).style.transform=''; }}>
                                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 12 : 14, fontWeight:900, color:col, width:24, textAlign:'center', flexShrink:0 }}>#{idx+1}</div>
                                <div style={{ width: isMobile ? 44 : 52, height: isMobile ? 44 : 52, borderRadius:10, overflow:'hidden', flexShrink:0,
                                  background:'rgba(0,0,0,.3)', position:'relative', border:`1px solid ${col}22` }}>
                                  {img
                                    ? <img src={img} alt={colName} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                                    : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>🖼️</div>
                                  }
                                </div>
                                <div style={{ flex:1, minWidth:0 }}>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 11, fontWeight:700, color:'#e0f0ff',
                                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:4 }}>{colName}</div>
                                  <div style={{ display:'flex', gap: isMobile ? 8 : 12, flexWrap:'wrap' }}>
                                    <span style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf' }}>{data.count} listing{data.count!==1?'s':''}</span>
                                    {data.volume > 0 && <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#00c98d' }}>VOL {(data.volume/1e9).toFixed(2)} XNT</span>}
                                  </div>
                                </div>
                                <div style={{ textAlign:'right', flexShrink:0 }}>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:col }}>{lamportsToXnt(data.floor)}</div>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginTop:2 }}>XNT FLOOR</div>
                                </div>
                              </div>
                            );
                          })}

                          {/* Bottom 3 — compact 3-column mini cards */}
                          {topCollections.length > 3 && (
                            <>
                              <div style={{ height:1, background:'linear-gradient(90deg,rgba(255,255,255,.08),transparent)', margin:'2px 0' }} />
                              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap: isMobile ? 7 : 10 }}>
                                {topCollections.slice(3, 6).map(([colName, data], i) => {
                                  const idx = i + 3;
                                  const colors = ['#00d4ff','#bf5af2','#00c98d','#ffaa00','#ff6644','#4488ff'];
                                  const col    = colors[idx % colors.length];
                                  const img    = data.items[0]?.nftData?.image || data.items[0]?.nftData?.metaUri;
                                  return (
                                    <div key={colName}
                                      onClick={() => { setBrowseCollection(colName); setMarketTab('browse'); }}
                                      style={{ background:'rgba(255,255,255,.02)', border:`1px solid rgba(255,255,255,.05)`,
                                        borderRadius:10, padding: isMobile ? '8px 9px' : '10px 12px', cursor:'pointer', transition:'all 0.15s' }}
                                      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background=`rgba(255,255,255,.05)`; (e.currentTarget as HTMLDivElement).style.borderColor=`${col}44`; }}
                                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background='rgba(255,255,255,.02)'; (e.currentTarget as HTMLDivElement).style.borderColor='rgba(255,255,255,.05)'; }}>
                                      <div style={{ display:'flex', alignItems:'center', gap:7, marginBottom:6 }}>
                                        <div style={{ width:28, height:28, borderRadius:6, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative', border:`1px solid ${col}22` }}>
                                          {img
                                            ? <img src={img} alt={colName} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                                            : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12 }}>🖼️</div>
                                          }
                                        </div>
                                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:900, color:col }}>#{idx+1}</div>
                                      </div>
                                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700, color:'#c0d0e0',
                                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:4 }}>{colName}</div>
                                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900, color:col, marginBottom:2 }}>{lamportsToXnt(data.floor)}</div>
                                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf' }}>{data.count} listed · FLOOR XNT</div>
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Right column: Biggest Sale + Quick CTAs */}
                    <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 12 : 14 }}>

                      {/* Biggest Sale */}
                      <div style={{ background:'linear-gradient(135deg,rgba(255,170,0,.08),rgba(191,90,242,.05))', border:'1px solid rgba(255,170,0,.2)', borderRadius:16, padding: isMobile ? '16px 14px' : '20px 20px', flex:1 }}>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:900, color:'#ffaa00', letterSpacing:1.5, marginBottom:12 }}>🏆 BIGGEST SALE</div>
                        {biggestSale ? (
                          <>
                            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
                              <div style={{ width:56, height:56, borderRadius:12, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative', border:'2px solid rgba(255,170,0,.25)' }}>
                                {biggestSale.nftData?.image
                                  ? <img src={biggestSale.nftData.image} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                                  : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22 }}>🖼️</div>
                                }
                              </div>
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#fff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{biggestSale.nftData?.name ?? biggestSale.nftMint.slice(0,10)+'…'}</div>
                                <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:3 }}>{new Date(biggestSale.timestamp*1000).toLocaleDateString()}</div>
                                {biggestSale.buyer && <div style={{ fontFamily:'monospace', fontSize:8, color:'#9abacf', marginTop:2 }}>BUYER: {biggestSale.buyer.slice(0,8)}…</div>}
                              </div>
                            </div>
                            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 22 : 28, fontWeight:900, color:'#ffaa00' }}>
                              {lamportsToXnt(biggestSale.price!)}
                              <span style={{ fontSize:11, color:'#7a6a3a', fontWeight:400, marginLeft:6 }}>XNT</span>
                            </div>
                          </>
                        ) : (
                          <div style={{ textAlign:'center', padding:'24px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf' }}>
                            {loadingActivity ? 'LOADING…' : 'NO SALES YET'}
                          </div>
                        )}
                      </div>

                      {/* Quick CTAs */}
                      <div style={{ display:'flex', flexDirection: isMobile ? 'row' : 'column', gap:8 }}>
                        <button type="button" onClick={() => setMarketTab('browse')}
                          style={{ flex:1, padding: isMobile ? '12px 8px' : '14px 16px',
                            background:'linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.06))',
                            border:'1px solid rgba(0,212,255,.4)', borderRadius:12, cursor:'pointer',
                            fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#00d4ff',
                            display:'flex', alignItems:'center', justifyContent:'center', gap:6, transition:'all 0.18s' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background='linear-gradient(135deg,rgba(0,212,255,.28),rgba(0,212,255,.12))'; (e.currentTarget as HTMLButtonElement).style.transform='translateY(-2px)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background='linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.06))'; (e.currentTarget as HTMLButtonElement).style.transform=''; }}>
                          🛒 BROWSE LISTINGS
                        </button>
                        <button type="button" onClick={() => setMarketTab('sell')}
                          style={{ flex:1, padding: isMobile ? '12px 8px' : '14px 16px',
                            background:'linear-gradient(135deg,rgba(0,201,141,.15),rgba(0,201,141,.05))',
                            border:'1px solid rgba(0,201,141,.35)', borderRadius:12, cursor:'pointer',
                            fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#00c98d',
                            display:'flex', alignItems:'center', justifyContent:'center', gap:6, transition:'all 0.18s' }}
                          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background='linear-gradient(135deg,rgba(0,201,141,.25),rgba(0,201,141,.1))'; (e.currentTarget as HTMLButtonElement).style.transform='translateY(-2px)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background='linear-gradient(135deg,rgba(0,201,141,.15),rgba(0,201,141,.05))'; (e.currentTarget as HTMLButtonElement).style.transform=''; }}>
                          🏷️ LIST AN NFT
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* ── Featured / Boosted Listings ── */}
                  {boosts.length > 0 && (() => {
                    // Match boost records to enriched listing data
                    const boostedListings = boosts
                      .map(b => listings.find(l => l.listingPda === b.listing_pda))
                      .filter(Boolean) as Listing[];
                    const tierOrder: Record<BoostTierId, number> = { incinerator:0, godslayer:1, spark:2 };
                    const sorted = [...boostedListings].sort((a, b) => {
                      const ba = boosts.find(x => x.listing_pda === a.listingPda)!;
                      const bb = boosts.find(x => x.listing_pda === b.listingPda)!;
                      return (tierOrder[ba.tier] ?? 9) - (tierOrder[bb.tier] ?? 9);
                    });
                    const slots = [sorted[0], sorted[1], sorted[2]];
                    return (
                      <div style={{ marginBottom: isMobile ? 20 : 28, animation:'fadeUp 0.4s ease both' }}>
                        {/* Section header */}
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                          <div>
                            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900,
                              color:'#fff', letterSpacing:1.5, display:'flex', alignItems:'center', gap:8 }}>
                              <span style={{ fontSize: isMobile ? 13 : 15 }}>⚡</span> FEATURED LISTINGS
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                                background:'rgba(191,90,242,.12)', border:'1px solid rgba(191,90,242,.25)',
                                padding:'2px 7px', borderRadius:4 }}>PAID BOOST</span>
                            </div>
                            <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:3 }}>3 featured slots · ranked by tier</div>
                          </div>
                          <button type="button" onClick={() => { setPageMode('market'); setMarketTab('mylistings'); }}
                            style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#bf5af2',
                              background:'rgba(191,90,242,.08)', border:'1px solid rgba(191,90,242,.2)',
                              borderRadius:7, padding:'5px 12px', cursor:'pointer', fontWeight:700 }}>
                            BOOST YOURS ↗
                          </button>
                        </div>

                        {/* 3-slot grid */}
                        <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(3,1fr)', gap: isMobile ? 8 : 14 }}>
                          {[0,1,2].map(i => {
                            const l   = slots[i];
                            const b   = l ? boosts.find(x => x.listing_pda === l.listingPda) : null;
                            const tier = BOOST_TIERS.find(t => t.id === b?.tier);
                            const nft = l?.nftData;
                            const imgUri = nft?.image || nft?.metaUri;
                            const expiresMs = b ? new Date(b.expires_at).getTime() - Date.now() : 0;
                            const daysLeft  = Math.ceil(expiresMs / 86_400_000);
                            const hoursLeft = Math.ceil(expiresMs / 3_600_000);
                            const timeLabel = daysLeft >= 1 ? `${daysLeft}d` : `${hoursLeft}h`;

                            if (!l) return (
                              <div key={i} style={{ border:'1px dashed rgba(191,90,242,.2)', borderRadius:12,
                                padding: isMobile ? '16px 10px' : '24px 16px',
                                display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8,
                                minHeight: isMobile ? 120 : 160 }}>
                                <div style={{ width:28, height:28, borderRadius:'50%', border:'1.5px dashed rgba(191,90,242,.35)',
                                  display:'flex', alignItems:'center', justifyContent:'center',
                                  fontFamily:'Orbitron,monospace', fontSize:16, color:'rgba(191,90,242,.4)' }}>+</div>
                                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7, color:'rgba(191,90,242,.4)',
                                  textAlign:'center', letterSpacing:.5 }}>SLOT {i+1}<br/>AVAILABLE</div>
                                <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7, color:'rgba(191,90,242,.3)' }}>
                                  from 1,000 BRAINS
                                </div>
                              </div>
                            );

                            return (
                              <div key={i}
                                onClick={() => { setPageMode('market'); setMarketTab('browse'); }}
                                style={{ background:'linear-gradient(145deg,rgba(191,90,242,.08),rgba(0,212,255,.04))',
                                  border:`1px solid ${tier?.color ?? '#bf5af2'}33`, borderRadius:12, overflow:'hidden',
                                  cursor:'pointer', transition:'transform .15s, box-shadow .18s',
                                  position:'relative' }}
                                onMouseEnter={e => { const el = e.currentTarget as HTMLDivElement; el.style.transform='translateY(-3px)'; el.style.boxShadow=`0 8px 24px ${tier?.color ?? '#bf5af2'}22`; }}
                                onMouseLeave={e => { const el = e.currentTarget as HTMLDivElement; el.style.transform=''; el.style.boxShadow=''; }}>
                                {/* Tier accent line */}
                                <div style={{ height:2, background:`linear-gradient(90deg,transparent,${tier?.color ?? '#bf5af2'},transparent)` }} />
                                {/* Image */}
                                <div style={{ position:'relative', width:'100%', paddingBottom:'100%', background:'#060b12' }}>
                                  <NFTImage metaUri={imgUri} name={nft?.name ?? ''} />
                                  {/* Tier badge */}
                                  <div style={{ position:'absolute', top:5, left:5, background:'rgba(0,0,0,.85)',
                                    border:`1px solid ${tier?.color ?? '#bf5af2'}55`, borderRadius:4,
                                    padding:'1px 6px', fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7,
                                    color: tier?.color ?? '#bf5af2', fontWeight:700 }}>
                                    {tier?.id === 'incinerator' ? '🔥' : tier?.id === 'godslayer' ? '⚔️' : '⚡'}
                                    {!isMobile && ` ${tier?.id.toUpperCase()}`}
                                  </div>
                                  {/* Time left */}
                                  <div style={{ position:'absolute', bottom:5, right:5, background:'rgba(0,0,0,.82)',
                                    border:'1px solid rgba(255,170,0,.3)', borderRadius:4, padding:'1px 6px',
                                    fontFamily:'Orbitron,monospace', fontSize: isMobile ? 6 : 7, color:'#ffaa00' }}>
                                    {timeLabel} left
                                  </div>
                                </div>
                                {/* Info */}
                                <div style={{ padding: isMobile ? '6px 7px 8px' : '8px 10px 10px' }}>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700,
                                    color:'#c0d0e0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:3 }}>
                                    {nft?.name ?? l.nftMint.slice(0,8)+'…'}
                                  </div>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900, color:'#00d4ff' }}>
                                    {lamportsToXnt(l.price)}<span style={{ fontSize:7, color:'#3a5a7a', marginLeft:3 }}>XNT</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* ── Recent Activity ── */}
                  <div style={{ background:'rgba(255,255,255,.02)', border:'1px solid rgba(255,255,255,.06)', borderRadius:16, padding: isMobile ? '16px 14px' : '22px 24px' }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                      <div>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900, color:'#fff', letterSpacing:1 }}>⚡ RECENT ACTIVITY</div>
                        <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:2 }}>latest trades on-chain</div>
                      </div>
                      <button type="button" onClick={() => setMarketTab('activity')} style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#bf5af2', background:'rgba(191,90,242,.08)', border:'1px solid rgba(191,90,242,.2)', borderRadius:7, padding:'5px 12px', cursor:'pointer' }}>VIEW ALL ↗</button>
                    </div>
                    {loadingActivity ? (
                      <div style={{ textAlign:'center', padding:'20px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf' }}>LOADING…</div>
                    ) : tradeLogs.length === 0 ? (
                      <div style={{ textAlign:'center', padding:'20px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abace' }}>NO ACTIVITY YET</div>
                    ) : (
                      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                        {tradeLogs.slice(0, 5).map((log, i) => {
                          const tc = log.type==='buy'?'#00c98d':log.type==='list'?'#00d4ff':log.type==='boost'?'#bf5af2':'#ff9944';
                          const tl = log.type==='buy'?'⚡ SOLD':log.type==='list'?'🏷️ LISTED':log.type==='boost'?'🔥 BOOSTED':'↩ DELISTED';
                          return (
                            <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px',
                              background:'rgba(255,255,255,.02)', borderRadius:8, border:'1px solid rgba(255,255,255,.04)' }}>
                              <div style={{ width:34, height:34, borderRadius:7, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative' }}>
                                {log.nftData?.image
                                  ? <img src={log.nftData.image} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                                  : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14 }}>🖼️</div>
                                }
                              </div>
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:tc,
                                background:`${tc}18`, border:`1px solid ${tc}44`, padding:'2px 7px', borderRadius:4, flexShrink:0 }}>{tl}</span>
                              <span style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 9 : 10, color:'#c0d0e0', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                {log.nftData?.name ?? log.nftMint.slice(0,12)+'…'}
                              </span>
                              {log.type==='boost' && (log as any).brains ? <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#bf5af2', flexShrink:0 }}>🔥 {((log as any).brains as number).toLocaleString()} BRAINS</span> : log.price ? <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700, color:'#00d4ff', flexShrink:0 }}>{lamportsToXnt(log.price)} XNT</span> : null}
                              <a href={`https://explorer.mainnet.x1.xyz/tx/${log.sig}`} target="_blank" rel="noopener"
                                style={{ color:'#9abacf', fontSize:9, textDecoration:'none', flexShrink:0, padding:'3px 7px',
                                  border:'1px solid rgba(255,255,255,.06)', borderRadius:5, fontFamily:'monospace' }}>TX↗</a>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                </div>
              );

            })()}

            {/* ══════════════════════════════════════
                BROWSE TAB — collection picker + filtered grid
            ══════════════════════════════════════ */}
            {marketTab === 'browse' && (() => {
              // Build collection list for picker — normalize key to deduplicate same collection appearing under different name/symbol
              const colMap2 = new Map<string, { count: number; floor: number; items: Listing[]; displayName: string }>();
              listings.forEach(l => {
                const rawName = l.nftData?.collection || l.nftData?.symbol || 'Unknown';
                const key = rawName.trim().toUpperCase();
                if (!colMap2.has(key)) colMap2.set(key, { count:0, floor:Infinity, items:[], displayName: rawName });
                const e = colMap2.get(key)!;
                if (rawName.length > e.displayName.length) e.displayName = rawName;
                e.count++; e.floor = Math.min(e.floor, l.price); e.items.push(l);
              });
              const collections2 = Array.from(colMap2.entries())
                .sort((a,b) => b[1].count - a[1].count)
                .map(([, data]) => [data.displayName, data] as [string, typeof data]);
              const filteredListings = browseCollection
                ? listings.filter(l => {
                    const rawName = l.nftData?.collection || l.nftData?.symbol || 'Unknown';
                    return rawName.trim().toUpperCase() === browseCollection.trim().toUpperCase();
                  })
                : listings;
              const visible  = filteredListings.slice(0, listingsPage);
              const hasMore  = filteredListings.length > listingsPage;

              return (
                <div style={{ animation:'fadeUp 0.3s ease both' }}>

                  {loadingListings && (
                    <div style={{ textAlign:'center', padding:'60px 0' }}>
                      <div style={{ width:30, height:30, borderRadius:'50%', border:'3px solid rgba(0,212,255,.2)', borderTop:'3px solid #00d4ff', animation:'spin 0.8s linear infinite', margin:'0 auto 14px' }} />
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', letterSpacing:2 }}>LOADING LISTINGS…</div>
                    </div>
                  )}

                  {!loadingListings && listings.length === 0 && (
                    <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '90px 40px' }}>
                      <div style={{ fontSize:52, marginBottom:18 }}>🏪</div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 12 : 16, fontWeight:900, color:'#9abacf', marginBottom:10, letterSpacing:2 }}>NO LISTINGS YET</div>
                      <button type="button" onClick={() => setMarketTab('sell')} style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, letterSpacing:2, color:'#00d4ff', background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.3)', borderRadius:10, padding:'12px 28px', cursor:'pointer' }}>🏷️ LIST YOUR FIRST NFT</button>
                    </div>
                  )}

                  {!loadingListings && listings.length > 0 && (
                    <>
                      {/* ── Collection picker ── */}
                      <div style={{ marginBottom: isMobile ? 16 : 20 }}>
                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#9abacf', letterSpacing:2, marginBottom:10 }}>FILTER BY COLLECTION</div>
                        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                          {/* ALL button */}
                          <button type="button" onClick={() => { setBrowseCollection(null); setListingsPage(48); }}
                            style={{ padding: isMobile ? '7px 14px' : '8px 18px', borderRadius:20, cursor:'pointer', transition:'all .15s',
                              fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700, letterSpacing:0.5,
                              background: !browseCollection ? 'linear-gradient(135deg,rgba(0,212,255,.2),rgba(0,212,255,.08))' : 'rgba(255,255,255,.04)',
                              border: !browseCollection ? '1px solid rgba(0,212,255,.5)' : '1px solid rgba(255,255,255,.1)',
                              color: !browseCollection ? '#00d4ff' : '#4a6a8a',
                              boxShadow: !browseCollection ? '0 0 12px rgba(0,212,255,.15)' : 'none' }}>
                            ALL <span style={{ fontSize:8, opacity:.7 }}>({listings.length})</span>
                          </button>
                          {collections2.map(([colName, data], idx) => {
                            const colColors = ['#00d4ff','#bf5af2','#00c98d','#ffaa00','#ff6644','#4488ff'];
                            const col = colColors[idx % colColors.length];
                            const active = browseCollection === colName;
                            return (
                              <button key={colName} type="button"
                                onClick={() => { setBrowseCollection(colName); setListingsPage(48); }}
                                style={{ padding: isMobile ? '7px 14px' : '8px 18px', borderRadius:20, cursor:'pointer', transition:'all .15s',
                                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 8 : 9, fontWeight:700, letterSpacing:0.5,
                                  background: active ? `rgba(${col==='#00d4ff'?'0,212,255':col==='#bf5af2'?'191,90,242':col==='#00c98d'?'0,201,141':col==='#ffaa00'?'255,170,0':col==='#ff6644'?'255,102,68':'68,136,255'},.18)` : 'rgba(255,255,255,.04)',
                                  border: active ? `1px solid ${col}88` : '1px solid rgba(255,255,255,.1)',
                                  color: active ? col : '#4a6a8a',
                                  boxShadow: active ? `0 0 12px ${col}22` : 'none' }}>
                                {colName} <span style={{ fontSize:8, opacity:.7 }}>({data.count})</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* ── Active filter header ── */}
                      {browseCollection && (
                        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16, padding:'10px 14px',
                          background:'rgba(0,212,255,.05)', border:'1px solid rgba(0,212,255,.15)', borderRadius:10 }}>
                          <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:700, color:'#00d4ff' }}>{browseCollection}</span>
                          <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf' }}>{filteredListings.length} listing{filteredListings.length!==1?'s':''}</span>
                          {colMap2.has(browseCollection) && <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#bf5af2' }}>Floor: {lamportsToXnt(colMap2.get(browseCollection)!.floor)} XNT</span>}
                          <button type="button" onClick={() => { setBrowseCollection(null); setListingsPage(48); }}
                            style={{ marginLeft:'auto', fontFamily:'Orbitron,monospace', fontSize:8, color:'#ff6666', background:'rgba(255,50,50,.08)', border:'1px solid rgba(255,50,50,.2)', borderRadius:6, padding:'3px 10px', cursor:'pointer' }}>
                            ✕ CLEAR
                          </button>
                        </div>
                      )}

                      {/* ── Listings grid ── */}
                      {filteredListings.length === 0 ? (
                        <div style={{ textAlign:'center', padding:'40px 0', fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf' }}>NO LISTINGS IN THIS COLLECTION</div>
                      ) : (
                        <>
                          <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: isMobile ? 10 : 14 }}>
                            {visible.map(l => <ListingCard key={l.listingPda} listing={l} isMobile={isMobile}
                              isOwner={l.seller === publicKey?.toBase58()}
                              onBuy={() => handleBuy(l)}
                              onDelist={() => handleDelist(l)}
                              onInspect={() => handleInspectListing(l)}
                              onUpdatePrice={() => handleUpdatePrice(l)} />)}
                          </div>
                          {hasMore && (
                            <div style={{ textAlign:'center', marginTop:20 }}>
                              <button type="button" onClick={() => setListingsPage(p => p + 48)}
                                style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#00d4ff',
                                  background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.25)',
                                  borderRadius:10, padding:'10px 28px', cursor:'pointer', letterSpacing:1 }}>
                                LOAD MORE ({filteredListings.length - listingsPage} remaining)
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* MY LISTINGS */}
            {marketTab === 'mylistings' && (
              <div style={{ animation:'fadeUp 0.3s ease both' }}>
                {!publicKey && <div style={{ textAlign:'center', padding:'60px 20px' }}><div style={{ fontSize:48, marginBottom:16 }}>🔒</div><div style={{ fontFamily:'Orbitron,monospace', fontSize:13, color:'#9abacf', letterSpacing:2 }}>CONNECT WALLET</div></div>}
                {publicKey && myListings.length === 0 && (
                  <div style={{ textAlign:'center', padding: isMobile ? '60px 20px' : '80px 40px' }}>
                    <div style={{ fontSize:44, marginBottom:16 }}>📋</div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 14, fontWeight:900, color:'#9abacf', marginBottom:10, letterSpacing:2 }}>NO ACTIVE LISTINGS</div>
                    <button type="button" onClick={() => setMarketTab('sell')} style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, letterSpacing:1.5, color:'#00d4ff', background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.3)', borderRadius:10, padding:'11px 24px', cursor:'pointer', marginTop:8 }}>🏷️ LIST AN NFT</button>
                  </div>
                )}
                {publicKey && myListings.length > 0 && (
                  <div style={{ display:'flex', flexDirection:'column', gap: isMobile ? 10 : 12 }}>
                    {myListings.map(l => {
                      const boost     = boosts.find(b => b.listing_pda === l.listingPda);
                      const tier      = BOOST_TIERS.find(t => t.id === boost?.tier);
                      const expiresMs = boost ? new Date(boost.expires_at).getTime() - Date.now() : 0;
                      const daysLeft  = Math.ceil(expiresMs / 86_400_000);
                      const hoursLeft = Math.ceil(expiresMs / 3_600_000);
                      const timeLabel = daysLeft >= 1 ? `${daysLeft}d` : `${hoursLeft}h`;
                      const nft = l.nftData;
                      const imgUri = nft?.image || nft?.metaUri;
                      return (
                        <div key={l.listingPda} style={{
                          display:'flex', alignItems:'center', gap: isMobile ? 10 : 14,
                          background: boost
                            ? `linear-gradient(135deg,rgba(${tier?.color === '#ff6a00' ? '255,106,0' : tier?.color === '#bf5af2' ? '191,90,242' : '0,212,255'},.08),rgba(255,255,255,.02))`
                            : 'rgba(255,255,255,.03)',
                          border: `1px solid ${boost ? (tier?.color ?? '#bf5af2') + '44' : 'rgba(255,255,255,.08)'}`,
                          borderRadius:12, padding: isMobile ? '10px 12px' : '12px 16px',
                          transition:'border-color .15s',
                        }}>
                          {/* Thumbnail */}
                          <div style={{ width: isMobile ? 44 : 54, height: isMobile ? 44 : 54, flexShrink:0,
                            borderRadius:8, overflow:'hidden', background:'#060b12', position:'relative' }}>
                            <NFTImage metaUri={imgUri} name={nft?.name ?? ''} />
                          </div>
                          {/* Info */}
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 9 : 10, fontWeight:700,
                              color:'#e0f0ff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:3 }}>
                              {nft?.name ?? l.nftMint.slice(0,12)+'…'}
                            </div>
                            <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:'#00d4ff' }}>
                                {lamportsToXnt(l.price)}<span style={{ fontSize:7, color:'#3a5a7a', marginLeft:3 }}>XNT</span>
                              </span>
                              {boost && tier && (
                                <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, fontWeight:700,
                                  color: tier.color, background:`rgba(${tier.color === '#ff6a00' ? '255,106,0' : tier.color === '#bf5af2' ? '191,90,242' : '0,212,255'},.12)`,
                                  border:`1px solid ${tier.color}44`, borderRadius:4, padding:'1px 6px' }}>
                                  {tier.id === 'incinerator' ? '🔥' : tier.id === 'godslayer' ? '⚔️' : '⚡'} {tier.id.toUpperCase()} · {timeLabel} left
                                </span>
                              )}
                            </div>
                          </div>
                          {/* Actions */}
                          <div style={{ display:'flex', gap: isMobile ? 6 : 8, flexShrink:0 }}>
                            {!boost && (
                              <button type="button" onClick={() => setBoostTarget(l)}
                                style={{ padding: isMobile ? '6px 8px' : '7px 14px', borderRadius:8, cursor:'pointer',
                                  fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700,
                                  background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.3)', color:'#bf5af2' }}>
                                {isMobile ? '⚡' : '⚡ BOOST'}
                              </button>
                            )}
                            <button type="button" onClick={() => handleUpdatePrice(l)}
                              style={{ padding: isMobile ? '6px 8px' : '7px 12px', borderRadius:8, cursor:'pointer',
                                fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700,
                                background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.25)', color:'#00d4ff' }}>
                              {isMobile ? '✏️' : '✏️ PRICE'}
                            </button>
                            <button type="button" onClick={() => handleDelist(l)}
                              style={{ padding: isMobile ? '6px 8px' : '7px 12px', borderRadius:8, cursor:'pointer',
                                fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700,
                                background:'rgba(255,50,50,.08)', border:'1px solid rgba(255,50,50,.25)', color:'#ff6666' }}>
                              {isMobile ? '✕' : '✕ DELIST'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ══════════════════════════════════════
                SELL TAB — collection-grouped, clean layout
            ══════════════════════════════════════ */}
            {marketTab === 'sell' && (() => {
              if (!publicKey) return (
                <div style={{ textAlign:'center', padding:'64px 24px', animation:'fadeUp 0.3s ease both' }}>
                  <div style={{ fontSize:48, marginBottom:16 }}>🔌</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:13, color:'#8aaac8', letterSpacing:1.5, marginBottom:8 }}>CONNECT WALLET</div>
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#9abacf' }}>Connect your wallet to see your NFTs and list them for sale</div>
                </div>
              );
              if (loading) return (
                <div style={{ textAlign:'center', padding:'64px 24px', animation:'fadeUp 0.3s ease both' }}>
                  <div style={{ width:28, height:28, borderRadius:'50%', border:'3px solid rgba(0,212,255,.2)', borderTop:'3px solid #00d4ff', animation:'spin 0.8s linear infinite', margin:'0 auto 14px' }} />
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#9abacf', letterSpacing:2 }}>SCANNING WALLET…</div>
                </div>
              );
              if (nfts.length === 0) return (
                <div style={{ textAlign:'center', padding:'64px 24px', animation:'fadeUp 0.3s ease both' }}>
                  <div style={{ fontSize:48, marginBottom:16 }}>🪹</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:12, color:'#8aaac8', letterSpacing:1 }}>NO NFTs FOUND IN WALLET</div>
                  <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf', marginTop:8 }}>NFTs are tokens with 0 decimals and a balance of 1</div>
                </div>
              );

              // Group wallet NFTs by collection for organised sell layout
              const sellColMap = new Map<string, NFTData[]>();
              nfts.forEach(n => {
                const col = n.collection || n.symbol || n.mint.slice(0,4).toUpperCase();
                if (!sellColMap.has(col)) sellColMap.set(col, []);
                sellColMap.get(col)!.push(n);
              });
              const sellCols = Array.from(sellColMap.entries());

              return (
                <div style={{ animation:'fadeUp 0.3s ease both' }}>
                  {/* Header */}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: isMobile ? 16 : 22,
                    padding: isMobile ? '12px 14px' : '16px 20px',
                    background:'linear-gradient(135deg,rgba(0,201,141,.06),rgba(0,201,141,.02))',
                    border:'1px solid rgba(0,201,141,.2)', borderRadius:14 }}>
                    <div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 11 : 13, fontWeight:900, color:'#00c98d', letterSpacing:1 }}>🏷️ LIST AN NFT FOR SALE</div>
                      <div style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abacf', marginTop:3 }}>
                        {nfts.length} NFT{nfts.length!==1?'s':''} in wallet across {sellCols.length} collection{sellCols.length!==1?'s':''}
                      </div>
                    </div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 16 : 22, fontWeight:900, color:'#00c98d' }}>{nfts.length}</div>
                  </div>

                  {/* Collections with NFT grids */}
                  {sellCols.map(([colName, colNfts], colIdx) => {
                    const colColors = ['#00c98d','#00d4ff','#bf5af2','#ffaa00','#ff6644','#4488ff'];
                    const col = colColors[colIdx % colColors.length];
                    return (
                      <div key={colName} style={{ marginBottom: isMobile ? 24 : 32 }}>
                        {/* Collection header */}
                        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
                          <div style={{ width:3, height:28, borderRadius:2, background:col, flexShrink:0 }} />
                          <div style={{ flex:1 }}>
                            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 10 : 12, fontWeight:900, color:'#fff', letterSpacing:1 }}>{colName}</div>
                            <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#9abacf', marginTop:2 }}>{colNfts.length} NFT{colNfts.length!==1?'s':''} · click to list</div>
                          </div>
                          <div style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:col, background:`${col}18`, border:`1px solid ${col}33`, borderRadius:20, padding:'3px 10px' }}>{colNfts.length}</div>
                        </div>
                        <div style={{ height:1, background:`linear-gradient(90deg,${col}66,${col}22,transparent)`, marginBottom:14 }} />

                        {/* NFT grid */}
                        <div style={{ display:'grid', gridTemplateColumns: isMobile ? 'repeat(3,1fr)' : 'repeat(5,1fr)', gap: isMobile ? 8 : 12 }}>
                          {colNfts.map(nft => {
                            const alreadyListed = myListings.some(l => l.nftMint === nft.mint);
                            return (
                              <button key={nft.mint} type="button"
                                onClick={() => { if (!alreadyListed) { setPrelistNft(nft); setShowListModal(true); } }}
                                disabled={alreadyListed}
                                style={{ background: alreadyListed ? 'rgba(255,255,255,.02)' : 'rgba(255,255,255,.03)',
                                  border: alreadyListed ? '1px solid rgba(255,255,255,.06)' : `1px solid ${col}22`,
                                  borderRadius:12, padding:0, cursor: alreadyListed ? 'default' : 'pointer',
                                  overflow:'hidden', transition:'all 0.18s', textAlign:'left', opacity: alreadyListed ? 0.6 : 1 }}
                                onMouseEnter={e => { if (!alreadyListed) { (e.currentTarget as HTMLButtonElement).style.border=`1px solid ${col}66`; (e.currentTarget as HTMLButtonElement).style.transform='translateY(-3px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow=`0 8px 24px ${col}18`; } }}
                                onMouseLeave={e => { if (!alreadyListed) { (e.currentTarget as HTMLButtonElement).style.border=`1px solid ${col}22`; (e.currentTarget as HTMLButtonElement).style.transform=''; (e.currentTarget as HTMLButtonElement).style.boxShadow=''; } }}>
                                <div style={{ position:'relative', paddingBottom:'100%', background:'rgba(0,0,0,.3)' }}>
                                  {nft.image
                                    ? <img src={nft.image} alt={nft.name} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', imageRendering:'pixelated' }} />
                                    : <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>🖼️</div>}
                                  {alreadyListed
                                    ? <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,.6)' }}>
                                        <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#ffaa00', background:'rgba(255,170,0,.15)', border:'1px solid rgba(255,170,0,.4)', borderRadius:6, padding:'4px 8px' }}>LISTED</div>
                                      </div>
                                    : <div style={{ position:'absolute', top:5, right:5, background:`${col}dd`, borderRadius:5, padding:'2px 7px', fontFamily:'Orbitron,monospace', fontSize:6, color:'#000', fontWeight:900 }}>LIST</div>
                                  }
                                </div>
                                <div style={{ padding: isMobile ? '5px 6px 7px' : '7px 8px 9px' }}>
                                  <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, fontWeight:700, color: alreadyListed ? '#4a6a8a' : '#c0d0e0',
                                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}


                        {/* ACTIVITY */}
            {marketTab === 'activity' && (
              <div style={{ animation:'fadeUp 0.3s ease both' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
                  <span style={{ fontFamily:'Orbitron,monospace', fontSize:11, color:'#8aaac8', letterSpacing:1 }}>RECENT TRADES</span>
                  <button type="button" onClick={loadActivity} disabled={loadingActivity} style={{ background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.2)', borderRadius:8, padding:'5px 12px', fontSize:9, color:'#00d4ff', cursor:'pointer', fontFamily:'Orbitron,monospace' }}>
                    {loadingActivity ? '⟳ LOADING…' : '↺ REFRESH'}
                  </button>
                </div>
                {loadingActivity ? (
                  <div style={{ textAlign:'center', padding:40, color:'#8aaac8', fontSize:11 }}>Loading activity…</div>
                ) : tradeLogs.length === 0 ? (
                  <div style={{ textAlign:'center', padding:40, color:'#8aaac8', fontSize:11 }}>No activity found</div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    {tradeLogs.map((log, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.06)', borderRadius:10, overflow:'hidden' }}>
                        <div style={{ width:44, height:44, borderRadius:8, overflow:'hidden', flexShrink:0, background:'rgba(0,0,0,.3)', position:'relative' }}>
                          {log.nftData?.image
                            ? <img src={log.nftData.image} alt={log.nftData?.name ?? ''} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', imageRendering:'pixelated', display:'block' }} onError={e => { (e.target as HTMLImageElement).style.display='none'; }} />
                            : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>🖼️</div>
                          }
                        </div>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                            <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700,
                              color: log.type==='buy'?'#00c98d':log.type==='list'?'#00d4ff':log.type==='boost'?'#bf5af2':'#ff9944',
                              background: log.type==='buy'?'rgba(0,201,141,.1)':log.type==='list'?'rgba(0,212,255,.1)':log.type==='boost'?'rgba(191,90,242,.1)':'rgba(255,153,68,.1)',
                              border: `1px solid ${log.type==='buy'?'rgba(0,201,141,.3)':log.type==='list'?'rgba(0,212,255,.3)':log.type==='boost'?'rgba(191,90,242,.3)':'rgba(255,153,68,.3)'}`,
                              padding:'2px 7px', borderRadius:4 }}>
                              {log.type==='buy'?'⚡ SOLD':log.type==='list'?'🏷️ LISTED':log.type==='boost'?'🔥 BOOSTED':'↩ DELISTED'}
                            </span>
                            <span style={{ fontSize:10, color:'#e0f0ff', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {log.nftData?.name ?? log.nftMint.slice(0,12)+'…'}
                            </span>
                          </div>
                          <div style={{ fontSize:9, color:'#8aaac8' }}>
                            {log.type==='boost' && (log as any).brains ? <span style={{ color:'#bf5af2', marginRight:8 }}>🔥 {((log as any).brains as number).toLocaleString()} BRAINS</span> : log.price ? <span style={{ color:'#00d4ff', marginRight:8 }}>{lamportsToXnt(log.price)} XNT</span> : null}
                            <span>{new Date(log.timestamp * 1000).toLocaleString()}</span>
                          </div>
                        </div>
                        <a href={`https://explorer.mainnet.x1.xyz/tx/${log.sig}`} target="_blank" rel="noopener"
                          style={{ color:'#9abacf', fontSize:10, textDecoration:'none', flexShrink:0, padding:'4px 8px', border:'1px solid rgba(255,255,255,.06)', borderRadius:6, fontFamily:'monospace' }}
                          title={log.sig}>TX ↗</a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}


                {/* ── Platform fee notice — bottom of page ── */}
        <div style={{ display:'flex', alignItems:'center', gap:10, margin: isMobile ? '28px 0 8px' : '40px 0 8px', padding:'10px 14px',
          background:'rgba(191,90,242,.04)', border:'1px solid rgba(191,90,242,.12)', borderRadius:10, opacity:0.7 }}>
          <span style={{ fontSize:14 }}>💎</span>
          <div>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 7 : 8, color:'#8a5aaa', letterSpacing:0.5 }}>
              1.888% PLATFORM FEE ON ALL SALES · CANCEL FEE 0.888%
            </div>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:6, color:'#5a3a7a', marginTop:2 }}>
              HARDCODED ON-CHAIN → {PLATFORM_WALLET_STRING.slice(0,12)}…{PLATFORM_WALLET_STRING.slice(-6)} · IMMUTABLE PROGRAM
            </div>
          </div>
        </div>

        <Footer />
      </div>

      {/* Gallery detail modal */}
      {selected && <NFTDetailModal nft={selected} isMobile={isMobile} onClose={() => setSelected(null)} onListThis={handleListFromGallery} />}

      {/* Listing inspect modal — shows NFT metadata + buy/delist from marketplace */}
      {selectedListing && (() => {
        const l   = selectedListing;
        const nft = l.nftData ?? { mint: l.nftMint, name: l.nftMint.slice(0,8)+'…', symbol:'', balance:1, decimals:0, isToken2022:false };
        const isOwner = l.seller === publicKey?.toBase58();
        return createPortal(
          <div onClick={() => setSelectedListing(null)}
            style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,.88)',
              backdropFilter:'blur(14px)', display:'flex', alignItems:'center', justifyContent:'center',
              padding: isMobile ? 12 : 20, animation:'labFadeIn 0.18s ease both' }}>
            <div onClick={e => e.stopPropagation()} style={{ width:'100%', maxWidth: isMobile ? '96%' : 580,
              background:'linear-gradient(155deg,#0c1520,#080c0f)', border:'1px solid rgba(0,212,255,.4)',
              borderRadius:20, boxShadow:'0 0 60px rgba(0,212,255,.12), 0 32px 80px rgba(0,0,0,.9)',
              animation:'labSlideUp 0.22s cubic-bezier(.22,1,.36,1) both', position:'relative', overflow:'hidden' }}>
              {/* Top accent line */}
              <div style={{ position:'absolute', top:0, left:'10%', right:'10%', height:1,
                background:'linear-gradient(90deg,transparent,rgba(0,212,255,.8),rgba(191,90,242,.6),transparent)' }} />
              {/* Close */}
              <button onClick={() => setSelectedListing(null)}
                style={{ position:'absolute', top:12, right:12, zIndex:10, width:32, height:32,
                  borderRadius:'50%', border:'1px solid rgba(0,212,255,.35)', background:'rgba(8,12,15,.9)',
                  cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, color:'#00d4ff' }}>×</button>

              <div style={{ display: isMobile ? 'flex' : 'flex', flexDirection: isMobile ? 'column' : 'row' }}>
                {/* Image */}
                <div style={{ position:'relative', width: isMobile ? '100%' : 240, flexShrink:0,
                  paddingBottom: isMobile ? '60%' : undefined, height: isMobile ? undefined : 340,
                  background:'linear-gradient(135deg,#050a0f,#0a0f18)',
                  borderRadius: isMobile ? '19px 19px 0 0' : '19px 0 0 19px', overflow:'hidden' }}>
                  <NFTImage metaUri={nft.image || nft.metaUri} name={nft.name} contain />
                  {/* Price badge */}
                  <div style={{ position:'absolute', bottom:12, left:12, background:'rgba(0,0,0,.85)',
                    backdropFilter:'blur(8px)', border:'1px solid rgba(0,212,255,.4)', borderRadius:8,
                    padding:'6px 12px' }}>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 18, fontWeight:900, color:'#00d4ff' }}>
                      {lamportsToXnt(l.price)} <span style={{ fontSize:9, color:'#9abacf' }}>XNT</span>
                    </div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginTop:2 }}>
                      SELLER GETS {lamportsToXnt(calcSellerCut(l.price))} XNT
                    </div>
                  </div>
                  {isOwner && <div style={{ position:'absolute', top:12, left:12, background:'rgba(255,140,0,.9)',
                    borderRadius:5, padding:'2px 8px', fontFamily:'Orbitron,monospace', fontSize:7, color:'#000', fontWeight:700 }}>YOURS</div>}
                </div>

                {/* Info panel */}
                <div style={{ flex:1, padding: isMobile ? '14px 16px 18px' : '20px 22px',
                  display:'flex', flexDirection:'column', gap:10, minWidth:0, overflowY:'auto', maxHeight: isMobile ? undefined : '85vh' }}>
                  {/* Name + symbol */}
                  <div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize: isMobile ? 14 : 16, fontWeight:900, color:'#fff',
                      marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nft.name}</div>
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                      {nft.collection && <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#9abace' }}>{nft.collection}</span>}
                      {nft.symbol && <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#00d4ff',
                        background:'rgba(0,212,255,.1)', border:'1px solid rgba(0,212,255,.25)', padding:'2px 7px', borderRadius:3 }}>{nft.symbol}</span>}
                      <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#bf5af2',
                        background:'rgba(191,90,242,.1)', border:'1px solid rgba(191,90,242,.25)', padding:'2px 7px', borderRadius:3 }}>
                        {nft.isToken2022 ? 'TOKEN-2022' : 'SPL'}
                      </span>
                    </div>
                  </div>

                  {/* Description */}
                  {nft.description && (
                    <div style={{ fontFamily:'Sora,sans-serif', fontSize: isMobile ? 10 : 11, color:'#9abace', lineHeight:1.6 }}>
                      {nft.description.length > 140 ? nft.description.slice(0,140)+'…' : nft.description}
                    </div>
                  )}

                  {/* Attributes */}
                  {nft.attributes && nft.attributes.length > 0 && (
                    <div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#9abacf', letterSpacing:1.5, marginBottom:6 }}>
                        TRAITS — {nft.attributes.length}
                      </div>
                      <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
                        {nft.attributes.map((a, i) => {
                          const isR = a.trait_type?.toLowerCase() === 'rarity';
                          const col = isR ? rarityColor(a.value) : '#bf5af2';
                          return (
                            <div key={i} style={{ background:'rgba(191,90,242,.05)', border:`1px solid ${isR ? col+'44' : 'rgba(191,90,242,.15)'}`,
                              borderRadius:5, padding:'3px 8px' }}>
                              <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', marginRight:4 }}>{a.trait_type}:</span>
                              <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, fontWeight:600, color: isR ? col : '#b8cce0' }}>{a.value}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Seller */}
                  <div style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(0,0,0,.3)',
                    borderRadius:8, border:'1px solid rgba(255,255,255,.06)', padding:'7px 10px' }}>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', flexShrink:0 }}>SELLER</span>
                    <code style={{ flex:1, fontFamily:'monospace', fontSize:9, color:'#8aaac4',
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {l.seller.slice(0,14)}…{l.seller.slice(-10)}
                    </code>
                  </div>

                  {/* Mint */}
                  <div style={{ display:'flex', alignItems:'center', gap:8, background:'rgba(0,0,0,.3)',
                    borderRadius:8, border:'1px solid rgba(255,255,255,.06)', padding:'7px 10px' }}>
                    <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf', flexShrink:0 }}>MINT</span>
                    <code style={{ flex:1, fontFamily:'monospace', fontSize:9, color:'#8aaac4',
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {l.nftMint.slice(0,14)}…{l.nftMint.slice(-10)}
                    </code>
                  </div>

                  {/* Fee breakdown */}
                  <div style={{ background:'rgba(0,212,255,.04)', borderRadius:8, border:'1px solid rgba(0,212,255,.12)', overflow:'hidden' }}>
                    {[
                      { l:'YOU PAY',              v:`${lamportsToXnt(l.price)} XNT`,           c:'#00d4ff' },
                      { l:'SELLER RECEIVES (98.112%)', v:`${lamportsToXnt(calcSellerCut(l.price))} XNT`, c:'#00c98d' },
                      { l:'PLATFORM FEE (1.888%)',     v:`${lamportsToXnt(calcFee(l.price))} XNT`,       c:'#bf5af2' },
                    ].map(({l:label, v, c}, i, arr) => (
                      <div key={label} style={{ display:'flex', justifyContent:'space-between', padding:'7px 12px',
                        borderBottom: i < arr.length-1 ? '1px solid rgba(255,255,255,.04)' : 'none' }}>
                        <span style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#9abacf' }}>{label}</span>
                        <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:c }}>{v}</span>
                      </div>
                    ))}
                  </div>

                  {/* Action buttons */}
                  <div style={{ display:'flex', gap:8, marginTop:'auto' }}>
                    <a href={`https://explorer.mainnet.x1.xyz/address/${l.nftMint}`} target="_blank" rel="noopener noreferrer"
                      style={{ flex:1, padding:'10px 0', textAlign:'center',
                        background:'linear-gradient(135deg,rgba(0,212,255,.12),rgba(0,212,255,.05))',
                        border:'1px solid rgba(0,212,255,.3)', borderRadius:9, fontFamily:'Orbitron,monospace',
                        fontSize:8, fontWeight:700, color:'#00d4ff', textDecoration:'none',
                        display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>🔍 EXPLORER ↗</a>
                    {isOwner
                      ? <>
                          <button type="button" onClick={() => { setSelectedListing(null); handleUpdatePrice(l); }}
                            style={{ flex:1, padding:'10px 0', background:'linear-gradient(135deg,rgba(0,212,255,.15),rgba(0,212,255,.06))',
                              border:'1px solid rgba(0,212,255,.35)', borderRadius:9, cursor:'pointer',
                              fontFamily:'Orbitron,monospace', fontSize:8, fontWeight:700, color:'#00d4ff',
                              display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}>✏️ EDIT PRICE</button>
                          <button type="button" onClick={() => { setSelectedListing(null); handleDelist(l); }}
                            style={{ flex:1, padding:'10px 0', background:'linear-gradient(135deg,rgba(255,50,50,.18),rgba(255,50,50,.08))',
                              border:'1px solid rgba(255,50,50,.4)', borderRadius:9, cursor:'pointer',
                              fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#ff6666',
                              display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>✕ DELIST</button>
                        </>
                      : <button type="button" onClick={() => { setSelectedListing(null); handleBuy(l); }}
                          style={{ flex:2, padding:'10px 0',
                            background:'linear-gradient(135deg,rgba(0,212,255,.22),rgba(0,212,255,.1))',
                            border:'1px solid rgba(0,212,255,.5)', borderRadius:9, cursor:'pointer',
                            fontFamily:'Orbitron,monospace', fontSize:9, fontWeight:700, color:'#00d4ff',
                            display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>⚡ BUY NOW</button>
                    }
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* List NFT modal popup */}
      {showListModal && prelistNft && publicKey && (
        <ListModal
          nft={prelistNft}
          connection={connection}
          publicKey={publicKey}
          sendTransaction={sendTransaction}
          signTransaction={signTransaction}
          onClose={() => { setShowListModal(false); setPrelistNft(null); }}
          onListed={() => { setShowListModal(false); setPrelistNft(null); loadListings(); }}
        />
      )}

      {/* Marketplace confirm modal */}
      {confirmTarget && <ConfirmModal listing={confirmTarget.listing} mode={confirmTarget.mode} isMobile={isMobile}
        onConfirm={confirmTarget.mode === 'buy' ? executeBuy : executeDelist}
        onCancel={() => { setConfirmTarget(null); setTxStatus(''); setTxPending(false); }}
        status={txStatus} pending={txPending} />}

      {updatePriceListing && publicKey && (
        <UpdatePriceModal
          listing={updatePriceListing}
          isMobile={isMobile}
          connection={connection}
          publicKey={publicKey}
          sendTransaction={sendTransaction}
          signTransaction={signTransaction}
          onClose={() => setUpdatePriceListing(null)}
          onUpdated={() => { setUpdatePriceListing(null); loadListings(); }}
        />
      )}

      {/* Boost modal */}
      {boostTarget && publicKey && (
        <BoostModal
          listing={boostTarget}
          isMobile={isMobile}
          connection={connection}
          publicKey={publicKey}
          sendTransaction={sendTransaction}
          signTransaction={signTransaction}
          onClose={() => setBoostTarget(null)}
          onBoosted={() => { setBoostTarget(null); loadListings(); }}
        />
      )}
    </div>
  );
};

export default LabWork;