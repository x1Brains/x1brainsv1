// X1 INSCRIPTIONS in the portfolio (owner 10-24: "the first sites to show the inscriptions that we make").
// Reads Metaplex Core NFTs straight from the chain (they have no token accounts, so the token scan never sees them):
//   · X1MAPS land (<height>.x1map) and X1 Inscriptions — the two collections minted by the X1 Inscriptions program
//   · any other Core NFT the wallet holds (x1vault files etc.)
// Names, pictures and links come from each NFT's own metadata (x1inscriptions.io/api/nft/…, open to other sites).
import { type FC, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import V2NFTImage from './V2NFTImage';
import { INS_PROGRAM, INS_SITE } from '../lib/x1inscriptions';

const CORE_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
// ⛔ Imported, not re-declared. This file used to carry its own copy of the
// program id and it was the TESTNET one, so both collection PDAs derived to
// addresses that do not exist on mainnet — every Core NFT fell through to
// "Other Core NFTs" and neither collection ever matched. Verified 2026-11-14:
// the mainnet PDAs below exist and are owned by Metaplex Core.
//   coll_l -> FZL4bTtto88mV6Qqx3uz4o7wcjLrCCKZVVxgX4Y2L6cm
//   coll_i -> 8AoC9xrB7LchjfJmdUBxMcyCLjHjSQP8ZVnjDDQadDUy
// They are PDAs of the program, so they cannot be faked.
const COLL_LAND = PublicKey.findProgramAddressSync([new TextEncoder().encode('coll_l')], INS_PROGRAM)[0].toBase58();
const COLL_INS  = PublicKey.findProgramAddressSync([new TextEncoder().encode('coll_i')], INS_PROGRAM)[0].toBase58();
const SITE = INS_SITE;

type Kind = 'land' | 'ins' | 'core';
interface CoreNft { address: string; name: string; uri: string; collection: string | null; kind: Kind;
  image?: string; link?: string; type?: string; title?: string; desc?: string }

/** Core AssetV1: key u8 (1) · owner 32 · update authority (u8 tag: 0 None, 1 Address+32, 2 Collection+32) · name · uri */
function parseAsset(address: string, data: Uint8Array): CoreNft | null {
  if (data[0] !== 1 || data.length < 40) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 33; const tag = data[o++]; let collection: string | null = null
  if (tag === 1 || tag === 2) { if (tag === 2) collection = new PublicKey(data.subarray(o, o + 32)).toBase58(); o += 32 }
  const str = () => { const n = dv.getUint32(o, true); o += 4; const s = new TextDecoder().decode(data.subarray(o, o + n)); o += n; return s }
  try {
    const name = str(), uri = str()
    const kind: Kind = collection === COLL_LAND ? 'land' : collection === COLL_INS ? 'ins' : 'core'
    return { address, name, uri, collection, kind }
  } catch { return null }
}

const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

/** The card's picture; hovering pops a large preview beside it — the same behaviour (and size) as the portfolio's
 *  NFT thumbnails (NftHoverThumb), in X1 blue. */
function HoverArt({ n }: { n: CoreNft }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pop, setPop] = useState<{ left: number; top: number } | null>(null)
  const open = () => {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect(), W = 280
    const left = r.right + 14 + W < window.innerWidth ? r.right + 14 : Math.max(8, r.left - 14 - W)
    const top = Math.min(Math.max(12, r.top + r.height / 2 - 175), window.innerHeight - 362)
    setPop({ left, top })
  }
  const label = n.kind === 'land' ? 'X1MAPS LAND' : n.kind === 'ins' ? (n.type ?? 'INSCRIPTION').toUpperCase() : 'CORE NFT'
  return (
    <div ref={ref} className="x1i-art" onMouseEnter={open} onMouseLeave={() => setPop(null)} style={{ cursor: 'zoom-in' }}>
      <V2NFTImage src={n.image ?? n.uri} name={n.name} width={160} />
      {pop && createPortal(
        <div style={{ position: 'fixed', left: pop.left, top: pop.top, width: 280, zIndex: 9999, pointerEvents: 'none',
          background: '#0a0f16', border: '1px solid rgba(0,136,255,.5)', borderRadius: 14, padding: 10,
          boxShadow: '0 18px 50px rgba(0,0,0,.7), 0 0 0 1px rgba(0,0,0,.4)', animation: 'pfxPop .14s ease-out' }}>
          <div style={{ position: 'relative', width: '100%', aspectRatio: '1 / 1', borderRadius: 9, overflow: 'hidden', background: '#000', border: '1px solid rgba(0,136,255,.25)' }}>
            <V2NFTImage src={n.image ?? n.uri} name={n.name} width={600} priority />
          </div>
          <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontFamily: 'Orbitron, monospace', fontSize: 11, fontWeight: 700, color: '#e8edf5', letterSpacing: .4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title ?? n.name}</span>
            <span style={{ flexShrink: 0, fontFamily: 'Orbitron, monospace', fontSize: 8.5, fontWeight: 800, letterSpacing: .6, padding: '2px 7px', borderRadius: 5,
              background: 'rgba(0,136,255,.12)', color: '#0088ff', border: '1px solid rgba(0,136,255,.32)' }}>{label}</span>
          </div>
          {n.desc && <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.4, color: '#a9b4c6' }}>{n.desc}</div>}
        </div>,
        document.body,
      )}
    </div>
  )
}

/** one NFT card — top level, so re-renders of the page never remount it (that wiped the hover preview) */
function Card({ n }: { n: CoreNft }) {
  return (
    <a className="x1i-card" href={n.link ?? (n.kind === 'land' ? `${SITE}/block/${n.name.split('.')[0]}` : n.kind === 'ins' ? `${SITE}/i/${n.name.replace(/\D/g, '')}` : undefined)}
      target="_blank" rel="noreferrer noopener" title={n.address}>
      <HoverArt n={n} />
      <div className="x1i-name" title={n.title ?? n.name}>{n.title ?? n.name}</div>
      {n.desc && <div className="x1i-desc">{n.desc}</div>}
      <div className="x1i-sub">{n.kind === 'land' ? 'X1MAPS land' : n.kind === 'ins' ? (n.type ?? 'Inscription') : 'Core NFT'}</div>
    </a>
  )
}
function Group({ label, list, accent }: { label: string; list: CoreNft[]; accent: string }) {
  return list.length ? (
    <div className="pfx-grp">
      <div className="pfx-grp-head"><span className="gtk" style={{ background: accent }} /><h4 style={{ color: accent }}>{label}</h4><span className="gcount num">{list.length}</span></div>
      <div className="x1i-grid">{list.map(n => <Card key={n.address} n={n} />)}</div>
    </div>
  ) : null
}

export const X1InscriptionsPanel: FC<{ owner: PublicKey | null }> = ({ owner }) => {
  const { connection } = useConnection()
  const [items, setItems] = useState<CoreNft[] | null>(null)
  useEffect(() => {
    setItems(null); if (!owner) return
    let off = false
    ;(async () => {
      try {
        // one filtered scan of the Core program: assets (key 1) owned by this wallet
        const rows = await connection.getProgramAccounts(CORE_ID, { encoding: 'base64' as any, filters: [
          { memcmp: { offset: 0, bytes: '2' } },                        // base58 of [1] = AssetV1
          { memcmp: { offset: 1, bytes: owner.toBase58() } }] })
        const list = rows.map(r => parseAsset(r.pubkey.toBase58(), r.account.data instanceof Uint8Array ? r.account.data : b64((r.account.data as any)[0]))).filter(Boolean) as CoreNft[]
        list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind < b.kind ? 1 : -1))
        if (off) return
        setItems(list)
        // details (picture, page link, type) from each NFT's metadata, a few at a time
        const out = [...list]
        for (let i = 0; i < out.length; i += 6) {
          await Promise.all(out.slice(i, i + 6).map(async (n, j) => {
            try {
              const r = await fetch(n.uri, { signal: AbortSignal.timeout(8000) }); if (!r.ok) return
              const m = await r.json()
              // the inscription's own title + description (set when it was inscribed); the generic X1MAPS text is skipped
              out[i + j] = { ...n, image: m.image, link: m.external_url, title: m.name,
                desc: n.kind === 'ins' && m.description && !/inscribed on X1 as inscription #\d+/.test(m.description) ? m.description : undefined,
                type: (m.attributes ?? []).find((a: any) => a.trait_type === 'Type')?.value }
            } catch { /* keep the name; V2NFTImage can still try the uri */ }
          }))
          if (off) return
          setItems([...out])
        }
      } catch { if (!off) setItems([]) }
    })()
    return () => { off = true }
  }, [owner?.toBase58(), connection]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!owner || (items && !items.length)) return null
  const land = items?.filter(n => n.kind === 'land') ?? [], ins = items?.filter(n => n.kind === 'ins') ?? [], core = items?.filter(n => n.kind === 'core') ?? []
  return (
    <div className="pfx-panel" style={{ padding: '18px 18px 14px', marginTop: 16 }}>
      <style>{`
        .x1i-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px;padding:4px 4px 10px}
        .x1i-card{display:grid;gap:4px;padding:8px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(0,136,255,.25);text-decoration:none;color:inherit;min-width:0;transition:border-color .15s}
        .x1i-card:hover{border-color:#0088ff}
        .x1i-art{position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;background:#000;display:grid;place-items:center}
        .x1i-art img{width:100%;height:100%;object-fit:cover}
        .x1i-name{font:700 12px Orbitron,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .x1i-sub{font-size:11px;opacity:.6}
        .x1i-desc{font-size:11px;opacity:.75;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      `}</style>
      <div className="pfx-phead" style={{ padding: '0 4px 16px' }}>
        <h3><span className="tk" style={{ background: '#0088ff' }} />X1 Inscriptions{items ? ` · ${items.length}` : ''}</h3>
        <a className="pfx-sub" href={SITE} target="_blank" rel="noreferrer noopener">x1inscriptions.io ↗</a>
      </div>
      {!items ? <div className="pfx-sub" style={{ padding: '0 4px 10px' }}>Reading inscriptions and land from X1…</div> : <>
        <Group label="X1MAPS Land" list={land} accent="#0088ff" />
        <Group label="Inscriptions" list={ins} accent="#8a8a92" />
        <Group label="Other Core NFTs" list={core} accent="#bf5af2" />
      </>}
    </div>
  )
}

export default X1InscriptionsPanel
