import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  fetchOnChainListings, fetchTokenMeta, CreateListingModal, MatchModal, DelistModal,
  type ListingOnChain,
} from './PairingMarketplace';
import { fmtUSD, fmtNum, shortAddr } from '../utils/v2format';
import V2PageHeader from '../components/V2PageHeader';

type ModalState =
  | { kind: 'create' }
  | { kind: 'match';  listing: ListingOnChain }
  | { kind: 'delist'; listing: ListingOnChain }
  | null;

function useIsMobile() {
  const [m, setM] = useState(typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 640);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

function timeAgo(ts: number): string {
  if (!ts || ts <= 0) return '—';
  // Accept both seconds and ms transparently — ts > 1e12 means it's ms.
  const tsSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - tsSec));
  if (diff < 60)    return `${diff}s`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export default function V2LpPairing() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  const isMobile = useIsMobile();

  const [listings, setListings] = useState<ListingOnChain[]>([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState('');
  const [modal, setModal]       = useState<ModalState>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchOnChainListings()
      .then(ls => {
        if (!alive) return;
        const open = ls.filter(l => l.status === 'open').sort((a, b) => b.usdValUi - a.usdValUi);
        setListings(open);
        setErr('');

        // Backfill any missing logos in the background
        const needLogos = open.filter(l => !l.tokenALogo).map(l => l.tokenAMint);
        for (const mint of needLogos) {
          fetchTokenMeta(mint).then(meta => {
            if (!alive || !meta.logo) return;
            setListings(prev => prev.map(p =>
              p.tokenAMint === mint && !p.tokenALogo
                ? { ...p, tokenALogo: meta.logo, tokenASymbol: meta.symbol || p.tokenASymbol }
                : p,
            ));
          }).catch(() => {});
        }
      })
      .catch(e => { if (alive) setErr(e?.message ?? 'Failed to load listings'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reloadTick]);

  const myWallet = publicKey?.toBase58();
  const totalTvl  = listings.reduce((s, l) => s + l.usdValUi, 0);
  const totalXnt  = listings.reduce((s, l) => s + (l.xntVal / 1e9), 0);
  const ecoCount  = listings.filter(l => l.isEcosystem).length;
  const stdCount  = listings.length - ecoCount;
  const burnAvg   = listings.length > 0
    ? listings.reduce((s, l) => s + l.burnBps, 0) / listings.length / 100
    : 0;
  const oldest = listings.length > 0 ? Math.min(...listings.map(l => l.createdAt)) : 0;

  const reload = () => setReloadTick(t => t + 1);

  return (
    <div className="content content-wide v2-glass">
      <div className="lw-stack">

        <V2PageHeader title="LP PAIRING" subtitle="PAIR & EARN · X1 MAINNET" />

        {/* ════════ STATS PANEL ════════ */}
        <div className="lf9-panel">
          <div className="lf9-pairhead">
            <div>
              <div className="lf9-pairtitle">LP Pairing Market</div>
              <div className="lf9-pairsub">Deposit any token to pair with XNT · seed an xDEX pool</div>
            </div>
            <div className="lf9-pairactions">
              <Link to="/charts" className="lf9-fund">View Pools →</Link>
              <button type="button" className="lf9-stake" disabled={!connected} onClick={() => setModal({ kind: 'create' })}>
                {connected ? '+ New Listing' : 'Connect Wallet'}
              </button>
            </div>
          </div>
          <div className="lf9-stat-row">
            <div className="lf9-stat"><div className="l">Open Listings</div><div className="v">{loading ? '…' : listings.length}</div><div className="s">live pairings</div></div>
            <div className="lf9-stat"><div className="l">TVL · USD</div><div className="v accent">{loading ? '…' : fmtUSD(totalTvl)}</div><div className="s">total deposited</div></div>
            <div className="lf9-stat"><div className="l">TVL · XNT</div><div className="v">{loading ? '…' : fmtNum(totalXnt, 1)}</div><div className="s">paired side</div></div>
            <div className="lf9-stat"><div className="l">Ecosystem</div><div className="v">{loading ? '…' : ecoCount}</div><div className="s">ECO tokens</div></div>
            <div className="lf9-stat"><div className="l">Standard</div><div className="v">{loading ? '…' : stdCount}</div><div className="s">STD tokens</div></div>
            <div className="lf9-stat"><div className="l">Avg Burn</div><div className="v">{loading ? '…' : `${burnAvg.toFixed(1)}%`}</div><div className="s">across listings</div></div>
          </div>
          <div className="lf9-emissions">
            <span className="dot" />
            <span>{loading ? 'Loading listings…' : 'Live on-chain'} · fee <strong>1.888%</strong> · oldest {oldest > 0 ? timeAgo(oldest) : '—'} · refreshes on action</span>
          </div>
        </div>

        {/* ════════ OPEN LISTINGS PANEL ════════ */}
        <div className="lf9-panel">
          <div className="lf9-head"><span className="t">Open Listings</span><span className="rule" /></div>
          {loading ? (
            <div className="lf9-skel-wrap">{[0, 1, 2].map(i => <div key={i} className="lf9-skel" />)}</div>
          ) : err ? (
            <div className="lf9-empty">Failed to load — {err}</div>
          ) : listings.length === 0 ? (
            <div className="lf9-empty">No open listings right now — create one to seed a pool.</div>
          ) : (
            <div className="lf9-table lf9-pairtable">
              <div className="lf9-thead">
                <div>Pair</div>
                <div>Deposited</div>
                <div>Value</div>
                <div>Burn</div>
                <div>Share of TVL</div>
                <div className="right">Action</div>
              </div>
              {listings.map(l => {
                const isMine = myWallet === l.creator;
                const sharePct = totalTvl > 0 ? (l.usdValUi / totalTvl) * 100 : 0;
                return (
                  <div className="lf9-row" key={l.id}>
                    <div className="lf9-pair">
                      {l.tokenALogo
                        ? <img className="lf9-plogo" src={l.tokenALogo} alt="" />
                        : <div className="lf9-plogo-fb">{(l.tokenASymbol || '?')[0]}</div>}
                      <div className="lf9-pair-txt">
                        <div className="name">
                          {l.tokenASymbol || shortAddr(l.tokenAMint, 4, 4)} <span style={{ color: '#6a8aaa', fontWeight: 500 }}>/ XNT</span>
                          <span className={l.isEcosystem ? 'lf9-badge-eco' : 'lf9-badge-std'}>{l.isEcosystem ? 'ECO' : 'STD'}</span>
                          {isMine && <span className="lf9-badge-mine">YOURS</span>}
                        </div>
                        <div className="sub">{shortAddr(l.tokenAMint, 5, 5)} · age {timeAgo(l.createdAt)}</div>
                      </div>
                    </div>
                    <div className="lf9-col">{fmtNum(l.amountUi, 2)}</div>
                    <div className="lf9-col" style={{ color: '#ff8c00', fontFamily: 'Orbitron, monospace', fontWeight: 700 }}>{fmtUSD(l.usdValUi)}</div>
                    <div className="lf9-col">{l.burnBps / 100}%</div>
                    <div>
                      <div className="lf9-apr" style={{ color: '#ff8c00', fontSize: 12 }}>{totalTvl > 0 ? `${sharePct.toFixed(1)}%` : '—'}</div>
                      <div className="lf9-sharebar">
                        <div style={{
                          width: `${Math.min(100, sharePct)}%`,
                          background: l.isEcosystem
                            ? 'linear-gradient(90deg, rgba(0,201,141,.9), rgba(0,201,141,.4))'
                            : 'linear-gradient(90deg, #ff8c00, rgba(255,140,0,.5))',
                        }} />
                      </div>
                    </div>
                    <div className="lf9-actions">
                      <button
                        type="button"
                        className={isMine ? 'lf9-fund' : 'lf9-stake'}
                        disabled={!connected || !signTransaction}
                        onClick={() => setModal(isMine ? { kind: 'delist', listing: l } : { kind: 'match', listing: l })}
                        title={isMine ? 'Delist your pairing' : 'Match with XNT to seed the pool'}
                      >
                        {isMine ? 'Delist' : 'Match'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ════════ HOW IT WORKS PANEL ════════ */}
        <div className="lf9-panel">
          <div className="lf9-head"><span className="t">How it works</span><span className="rule" /></div>
          <div className="lf9-pairsteps">
            <div><span className="n">1.</span> List a token — deposit + set USD value + burn %.</div>
            <div><span className="n">2.</span> Anyone matches with XNT to seed the pool.</div>
            <div><span className="n">3.</span> LP minted, split per config · 1.888% fee.</div>
          </div>
        </div>
      </div>

      {modal?.kind === 'create' && (
        <CreateListingModal
          isMobile={isMobile}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          onClose={() => setModal(null)}
          onCreated={reload}
        />
      )}
      {modal?.kind === 'match' && publicKey && (
        <MatchModal
          listing={modal.listing}
          isMobile={isMobile}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          livePrice={null}
          onClose={() => setModal(null)}
          onMatched={reload}
        />
      )}
      {modal?.kind === 'delist' && publicKey && (
        <DelistModal
          listing={modal.listing}
          isMobile={isMobile}
          publicKey={publicKey}
          connection={connection}
          signTransaction={signTransaction}
          onClose={() => setModal(null)}
          onDelisted={reload}
        />
      )}
    </div>
  );
}
