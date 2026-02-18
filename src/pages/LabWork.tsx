import React, { FC, useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { BRAINS_LOGO, RARITY_TIERS, NFT_TOTAL_SUPPLY, NFT_COLLECTION_NAME } from '../constants';
import { getRarityTier } from '../utils';
import {
  TopBar, PageBackground, Spinner, StatsBar,
  SectionHeader, PipelineBar, Footer, AddressBar,
} from '../components/UI';
import {
  NFTCard, NFTListRow, NFTModal, RarityDistribution,
  NFTData,
} from '../components/NFTComponents';

// ─────────────────────────────────────────────
// MOCK NFT GENERATOR — replace with live RPC scan
// Wire to connection.getParsedTokenAccountsByOwner
// + Metaplex PDA lookup (same pattern as Portfolio.tsx)
// ─────────────────────────────────────────────
function generateMockNFTs(): NFTData[] {
  const brainTypes  = ['Quantum', 'Neural', 'Cyber', 'Bio', 'Plasma', 'Dark', 'Void', 'Solar', 'Lunar', 'Storm'];
  const backgrounds = ['Deep Space', 'Neon Grid', 'Void Abyss', 'Circuit Board', 'Nebula', 'Glitch Field', 'Hologram', 'Fractal Rift'];
  const auras       = ['Orange Flame', 'Cyan Surge', 'Purple Haze', 'Gold Rush', 'None', 'Red Storm', 'Emerald Arc'];
  const implants    = ['Quantum Core', 'Neural Link', 'Data Spike', 'Memory Chip', 'None', 'Void Lens', 'Plasma Injector'];
  const powers      = ['Mind Control', 'Data Mining', 'Blockchain Sight', 'Temporal Shift', 'Energy Surge', 'Null Field', 'Omega Pulse', 'Synapse Boost'];
  const mouths      = ['Wired Jaw', 'Circuit Smile', 'Void Mouth', 'Plasma Grin', 'None', 'Data Stream'];

  const nfts: NFTData[] = [];
  for (let i = 1; i <= NFT_TOTAL_SUPPLY; i++) {
    const rarityScore = Math.floor(Math.random() * 100);
    const tier = getRarityTier(rarityScore);
    const brainType = brainTypes[i % brainTypes.length];
    const bg        = backgrounds[i % backgrounds.length];
    const aura      = auras[i % auras.length];
    const implant   = implants[i % implants.length];
    const power     = powers[i % powers.length];
    const mouth     = mouths[i % mouths.length];

    const attrRarities = {
      'Brain Type': Math.floor(60 + Math.random() * 38),
      'Background': Math.floor(50 + Math.random() * 45),
      'Aura':       aura    === 'None' ? Math.floor(15 + Math.random() * 20) : Math.floor(55 + Math.random() * 40),
      'Implant':    implant === 'None' ? Math.floor(10 + Math.random() * 15) : Math.floor(60 + Math.random() * 35),
      'Power':      Math.floor(70 + Math.random() * 28),
      'Mouth':      mouth   === 'None' ? Math.floor(8  + Math.random() * 12) : Math.floor(45 + Math.random() * 50),
    };

    nfts.push({
      id: i,
      mint: `X1BRAIN${String(i).padStart(4, '0')}MINT${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: `X1 Brain #${i}`,
      description: `A unique ${brainType} intelligence node from the X1 Brains Lab Work. Only ${NFT_TOTAL_SUPPLY} exist across the X1 blockchain — each a distinct neural consciousness encoded in silicon and starlight.`,
      image: BRAINS_LOGO,
      attributes: [
        { trait_type: 'Brain Type', value: brainType, rarity: attrRarities['Brain Type'] },
        { trait_type: 'Background', value: bg,         rarity: attrRarities['Background'] },
        { trait_type: 'Aura',       value: aura,       rarity: attrRarities['Aura']       },
        { trait_type: 'Implant',    value: implant,    rarity: attrRarities['Implant']    },
        { trait_type: 'Power',      value: power,      rarity: attrRarities['Power']      },
        { trait_type: 'Mouth',      value: mouth,      rarity: attrRarities['Mouth']      },
      ],
      powerStats: {
        Intelligence: Math.floor(40 + Math.random() * 60),
        Computation:  Math.floor(30 + Math.random() * 70),
        Network:      Math.floor(20 + Math.random() * 80),
        Stealth:      Math.floor(10 + Math.random() * 90),
        Energy:       Math.floor(50 + Math.random() * 50),
      },
      rarityScore,
      rarityTier: tier,
      rank: i,
      collection: NFT_COLLECTION_NAME,
      supply: NFT_TOTAL_SUPPLY,
    });
  }

  nfts.sort((a, b) => b.rarityScore - a.rarityScore);
  nfts.forEach((nft, idx) => { nft.rank = idx + 1; });
  return nfts;
}

// ─────────────────────────────────────────────
// FILTER BAR
// ─────────────────────────────────────────────
const FilterBar: FC<{
  filter: string;
  setFilter: (f: string) => void;
  sort: string;
  setSort: (s: string) => void;
  total: number;
  filtered: number;
}> = ({ filter, setFilter, sort, setSort, total, filtered }) => {
  const tiers = ['ALL', 'LEGENDARY', 'EPIC', 'RARE', 'UNCOMMON', 'COMMON'];
  const sortOptions = [
    { value: 'rank',  label: 'Rank'  },
    { value: 'score', label: 'Score' },
    { value: 'id',    label: 'ID #'  },
  ];

  return (
    <div style={{ background: 'linear-gradient(135deg, #0d1520, #0a1018)', border: '1px solid #1e3050', borderRadius: 10, padding: '14px 18px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
        {tiers.map(t => {
          const tierData = t !== 'ALL' ? (RARITY_TIERS as any)[t] : null;
          const active = filter === t;
          return (
            <button key={t} onClick={() => setFilter(t)}
              style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, fontWeight: 700, letterSpacing: 1.5, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', border: active ? `1px solid ${tierData?.color ?? '#ff8c00'}` : '1px solid #1e3050', color: active ? (tierData?.color ?? '#ff8c00') : '#5c7a90', background: active ? (tierData?.bg ?? 'rgba(255,140,0,0.1)') : 'transparent', transition: 'all 0.15s' }}
            >{t}</button>
          );
        })}
      </div>
      <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#5c7a90', letterSpacing: 2, flexShrink: 0 }}>
        <span style={{ color: '#ff8c00' }}>{filtered}</span> / {total}
      </div>
      <select value={sort} onChange={e => setSort(e.target.value)}
        style={{ background: '#0d1520', border: '1px solid #1e3050', color: '#8aa0b8', padding: '5px 10px', borderRadius: 6, fontFamily: 'Orbitron, monospace', fontSize: 8, letterSpacing: 1, cursor: 'pointer', outline: 'none' }}
      >
        {sortOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
};

// ─────────────────────────────────────────────
// EMPTY STATE
// ─────────────────────────────────────────────
const EmptyState: FC<{ walletConnected: boolean }> = ({ walletConnected }) => (
  <div style={{ textAlign: 'center', padding: '60px 20px', animation: 'fadeUp 0.5s ease both' }}>
    <div style={{ fontSize: 64, marginBottom: 20, animation: 'float 3s ease infinite' }}>🧠</div>
    <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 14, color: '#5c7a90', letterSpacing: 3, marginBottom: 12, textTransform: 'uppercase' }}>
      {walletConnected ? 'No Lab Work NFTs Detected' : 'Wallet Not Connected'}
    </div>
    <p style={{ fontSize: 12, color: '#4a6070', maxWidth: 360, margin: '0 auto', lineHeight: 1.7 }}>
      {walletConnected
        ? "Your wallet doesn't hold any X1 Brains Lab Work NFTs. Mint one at x1brains.xyz to join the collective."
        : 'Connect your Phantom or Backpack wallet to scan for X1 Brains Lab Work NFTs.'}
    </p>
  </div>
);

// ─────────────────────────────────────────────
// LAB WORK PAGE
// ─────────────────────────────────────────────
const LabWork: FC = () => {
  const { publicKey } = useWallet();

  const [nfts, setNfts] = useState<NFTData[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Scanning X1 chain for NFTs...');
  const [selectedNFT, setSelectedNFT] = useState<NFTData | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [sort, setSort] = useState('rank');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (publicKey) loadNFTs();
  }, [publicKey?.toBase58()]);

  const loadNFTs = async () => {
    setLoading(true);
    setLoadingLabel('Scanning X1 mainnet for NFTs…');
    await new Promise(r => setTimeout(r, 600));
    setLoadingLabel('Fetching token metadata…');
    await new Promise(r => setTimeout(r, 500));
    setLoadingLabel('Resolving rarity data…');
    await new Promise(r => setTimeout(r, 400));
    const all = generateMockNFTs();
    setNfts(showAll ? all : all.slice(0, 3));
    setLoading(false);
  };

  const filteredNFTs = nfts.filter(n => {
    if (filter === 'ALL') return true;
    return Object.keys(RARITY_TIERS).find(k => (RARITY_TIERS as any)[k] === n.rarityTier) === filter;
  }).sort((a, b) => {
    if (sort === 'rank')  return a.rank - b.rank;
    if (sort === 'score') return b.rarityScore - a.rarityScore;
    if (sort === 'id')    return a.id - b.id;
    return 0;
  });

  const legendaryCount = nfts.filter(n => n.rarityTier === RARITY_TIERS.LEGENDARY).length;
  const epicCount      = nfts.filter(n => n.rarityTier === RARITY_TIERS.EPIC).length;
  const rareCount      = nfts.filter(n => n.rarityTier === RARITY_TIERS.RARE).length;

  return (
    <div style={{ minHeight: '100vh', background: '#080c0f', padding: '80px 16px 40px', position: 'relative', overflow: 'hidden' }}>
      <TopBar />
      <PageBackground />
      {/* Extra purple glow for NFT page */}
      <div style={{ position: 'fixed', top: '40%', left: '50%', transform: 'translate(-50%,-50%)', width: 800, height: 800, borderRadius: '50%', background: 'radial-gradient(circle, rgba(191,90,242,0.02) 0%, transparent 60%)', pointerEvents: 'none', zIndex: 0 }} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1020, margin: '0 auto' }}>

        {/* Page header */}
        <div style={{ textAlign: 'center', marginBottom: 36, animation: 'fadeUp 0.5s ease both' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', inset: -8, borderRadius: '50%', background: 'conic-gradient(from 0deg, #ff8c00, #ffb700, #bf5af2, #00d4ff, #ff8c00)', animation: 'spin 6s linear infinite', opacity: 0.5 }} />
              <img src={BRAINS_LOGO} alt="X1 Brains"
                style={{ position: 'relative', zIndex: 1, width: 100, height: 100, borderRadius: '50%', objectFit: 'cover', border: '3px solid #0a0e14' }}
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          </div>
          <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#5c7a90', letterSpacing: 5, marginBottom: 10, textTransform: 'uppercase' }}>
            X1 BRAINS
          </div>
          <h1 style={{ fontFamily: 'Orbitron, monospace', fontSize: 36, fontWeight: 900, letterSpacing: 6, background: 'linear-gradient(135deg, #ff8c00 0%, #ffb700 35%, #bf5af2 65%, #00d4ff 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text', margin: '0 0 10px', textTransform: 'uppercase' }}>
            LAB WORK
          </h1>
          <p style={{ fontFamily: 'Orbitron, monospace', fontSize: 9, letterSpacing: 4, color: '#6a8ea8', textTransform: 'uppercase' }}>
            88 UNIQUE NFTs · X1 BLOCKCHAIN · NEURAL COLLECTIVE
          </p>
        </div>

        {/* Wallet address + demo toggle */}
        {publicKey && (
          <div style={{ background: 'linear-gradient(135deg, #0d1520, #111820)', border: '1px solid #1e3050', borderRadius: 10, padding: '12px 18px', marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, animation: 'fadeUp 0.4s ease 0.15s both' }}>
            <div>
              <div style={{ fontFamily: 'Orbitron, monospace', fontSize: 8, color: '#6a8ea8', letterSpacing: 3, marginBottom: 5, textTransform: 'uppercase' }}>Scanning Operator</div>
              <div style={{ fontFamily: 'Sora, monospace', fontSize: 11, color: '#00d4ff', wordBreak: 'break-all' }}>{publicKey.toBase58()}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* Demo toggle — remove once live RPC scan is wired */}
              <button onClick={() => { setShowAll(v => !v); }}
                style={{ fontFamily: 'Orbitron, monospace', fontSize: 7, color: showAll ? '#00d4ff' : '#ff8c00', background: showAll ? 'rgba(0,212,255,0.08)' : 'rgba(255,140,0,0.08)', border: `1px solid ${showAll ? 'rgba(0,212,255,0.3)' : 'rgba(255,140,0,0.3)'}`, borderRadius: 5, padding: '4px 8px', cursor: 'pointer', letterSpacing: 1.5, transition: 'all 0.2s' }}
                title="Demo: toggle between wallet view and full collection"
              >{showAll ? '📦 MY NFTs' : '🌐 FULL COLLECTION'}</button>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00c98d', flexShrink: 0, animation: 'pulse-orange 2s ease infinite' }} />
            </div>
          </div>
        )}

        {/* Content */}
        {!publicKey ? (
          <EmptyState walletConnected={false} />
        ) : loading ? (
          <Spinner label={loadingLabel} />
        ) : nfts.length === 0 ? (
          <EmptyState walletConnected={true} />
        ) : (
          <>
            <StatsBar items={[
              { label: 'NFTs Held',   value: nfts.length,      color: '#ff8c00' },
              { label: 'Legendary',   value: legendaryCount,    color: '#ff4444' },
              { label: 'Epic',        value: epicCount,          color: '#bf5af2' },
              { label: 'Rare',        value: rareCount,          color: '#00d4ff' },
              { label: 'Collection',  value: `${NFT_TOTAL_SUPPLY}`, color: '#ffb700' },
            ]} />

            {nfts.length > 1 && <RarityDistribution nfts={nfts} />}

            {/* Section header + view toggle */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <SectionHeader label={showAll ? 'Full Collection' : 'Your NFTs'} count={filteredNFTs.length} color="#ff8c00" icon="🧠" />
              <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
                {(['grid', 'list'] as const).map(v => (
                  <button key={v} onClick={() => setView(v)}
                    style={{ background: view === v ? 'rgba(255,140,0,0.15)' : 'transparent', border: `1px solid ${view === v ? 'rgba(255,140,0,0.4)' : '#1e3050'}`, color: view === v ? '#ff8c00' : '#5c7a90', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12, transition: 'all 0.15s' }}
                  >{v === 'grid' ? '⊞' : '☰'}</button>
                ))}
              </div>
            </div>

            <FilterBar filter={filter} setFilter={setFilter} sort={sort} setSort={setSort} total={nfts.length} filtered={filteredNFTs.length} />

            {/* Grid view */}
            {view === 'grid' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                {filteredNFTs.map((nft, i) => (
                  <NFTCard key={nft.id} nft={nft} onClick={setSelectedNFT} delay={Math.min(i * 0.04, 0.6)} />
                ))}
              </div>
            )}

            {/* List view */}
            {view === 'list' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filteredNFTs.map((nft, i) => (
                  <NFTListRow key={nft.id} nft={nft} onClick={setSelectedNFT} delay={i * 0.03} />
                ))}
              </div>
            )}

            {filteredNFTs.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 20px', fontFamily: 'Orbitron, monospace', fontSize: 10, color: '#4a6070', letterSpacing: 2 }}>
                NO NFTs MATCH FILTER
              </div>
            )}

            <button onClick={loadNFTs}
              style={{ width: '100%', marginTop: 32, padding: '14px 0', background: 'linear-gradient(135deg, #ff8c00, #ffb700)', border: 'none', borderRadius: 10, fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, letterSpacing: 2, color: '#0a0e14', cursor: 'pointer', textTransform: 'uppercase', transition: 'all 0.2s' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 24px rgba(255,140,0,0.4)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none'; }}
            >⟳ &nbsp;Rescan X1 Chain for NFTs</button>

            <PipelineBar text="NFT SCANNER: METAPLEX PDA → TOKEN-2022 EXT → IPFS METADATA → RARITY ENGINE" />
          </>
        )}

        <Footer />
      </div>

      {selectedNFT && <NFTModal nft={selectedNFT} onClose={() => setSelectedNFT(null)} />}
    </div>
  );
};

export default LabWork;
