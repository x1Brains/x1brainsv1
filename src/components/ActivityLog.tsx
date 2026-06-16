// Recent on-chain activity for the connected wallet.
//
// Two data sources merged:
//   1) Supabase burn_events ledger for this wallet (rich BRAINS-burn metadata).
//   2) Last N signatures from `getSignaturesForAddress` — covers swaps,
//      transfers, listings, votes, anything the chain saw.
//
// Each row classifies the tx by inspecting parsed instructions: SPL token
// burn → burn, token transfer → send / receive, otherwise other. Errored
// transactions are kept but tagged so the citizen sees failed attempts.

import { useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { getBurnEventsForWallet } from '../lib/supabase';
import { fmtNum, fmtUSD } from '../utils/v2format';
import { fetchAllPrices } from '../lib/prices';
import { BRAINS_MINT, LB_MINT } from '../constants';

const XNT_MINT_STR = 'So11111111111111111111111111111111111111112';

type Kind = 'burn' | 'send' | 'receive' | 'swap' | 'failed' | 'farm' | 'pairing' | 'market' | 'mint' | 'nft' | 'memo' | 'other';

// X1 ecosystem program IDs → friendly labels. When a tx doesn't move tokens
// (the classifier's primary signal), we fall back to whichever non-utility
// program it touched so the citizen sees "Farm · Stake" instead of "Other".
const KNOWN_PROGRAMS: Record<string, { label: string; kind: Kind }> = {
  'DNSefSAJ41Fm3ijmEug8tkDYJrHDwYGVtFtn8wwvbgJM': { label: 'Pairing',     kind: 'pairing' },
  'sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN': { label: 'DEX',         kind: 'swap'    },
  '9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU': { label: 'DEX LP',      kind: 'swap'    },
  'Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg': { label: 'Farm',        kind: 'farm'    },
  'CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4': { label: 'Marketplace', kind: 'market'  },
  '3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN': { label: 'LB Mint',     kind: 'mint'    },
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s': { label: 'NFT Metadata', kind: 'nft'     },
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr': { label: 'Memo',        kind: 'memo'    },
};

// Programs that show up in nearly every tx as wrappers/glue — ignore for labelling.
const UTILITY_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
]);
type ActivityItem = {
  key:       string;     // dedupe key (signature)
  sig:       string;
  kind:      Kind;
  icon:      string;
  iconClass: string;
  desc:      string;
  amount?:   number;
  symbol?:   string;
  counterAmount?: number;
  counterSymbol?: string;
  usd?:      number;
  fee?:      number;     // xnt
  blockTime: number;
};

function fmtClock(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${m}/${day} ${hh}:${mm}`;
}

function timeAgo(ts: number): string {
  if (!ts) return '—';
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60)    return `${diff}s`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function metaForKind(kind: Kind): { icon: string; iconClass: string } {
  switch (kind) {
    case 'burn':    return { icon: '✕', iconClass: 'burn' };
    case 'send':    return { icon: '↑', iconClass: 'swap' };
    case 'receive': return { icon: '↓', iconClass: 'receive' };
    case 'swap':    return { icon: '⇄', iconClass: 'swap' };
    case 'failed':  return { icon: '!', iconClass: 'burn' };
    case 'farm':    return { icon: '🌾', iconClass: 'swap' };
    case 'pairing': return { icon: '⚭', iconClass: 'swap' };
    case 'market':  return { icon: '◫', iconClass: 'swap' };
    case 'mint':    return { icon: '✨', iconClass: 'swap' };
    case 'nft':     return { icon: '◆', iconClass: 'swap' };
    case 'memo':    return { icon: '✎', iconClass: 'swap' };
    default:        return { icon: '·', iconClass: 'swap' };
  }
}

// Pull the first Anchor-style instruction name out of program logs.
// Anchor emits "Program log: Instruction: <Name>" on every entrypoint call;
// this gives us a free human-readable label without needing IDLs on the client.
function ixNameFromLogs(tx: any): string {
  const logs: string[] = tx?.meta?.logMessages ?? [];
  for (const line of logs) {
    const m = /^Program log: Instruction:\s+(\w+)/.exec(line);
    if (m) return m[1];
  }
  return '';
}

// Find the most informative program touched in this tx — first known X1
// program wins; otherwise first non-utility program; otherwise empty.
function programLabel(tx: any): { label: string; kind: Kind } | null {
  const ixs: any[] = tx?.transaction?.message?.instructions ?? [];
  const ids: string[] = [];
  for (const ix of ixs) {
    const pid = typeof ix?.programId === 'string' ? ix.programId : ix?.programId?.toBase58?.();
    if (pid) ids.push(pid);
  }
  // First pass: prefer known X1 ecosystem programs.
  for (const pid of ids) {
    if (KNOWN_PROGRAMS[pid]) return KNOWN_PROGRAMS[pid];
  }
  // Second pass: anything non-utility — show the program shortid.
  for (const pid of ids) {
    if (!UTILITY_PROGRAMS.has(pid)) {
      return { label: `Program ${pid.slice(0, 4)}…${pid.slice(-4)}`, kind: 'other' };
    }
  }
  return null;
}

// Owner's lamport balance change (post − pre) in XNT, minus fee paid.
// Positive = received native XNT; negative = sent. Returns 0 if the owner
// isn't in the account keys or no movement happened.
function nativeXntDelta(tx: any, owner: string): number {
  const keys: any[] = tx?.transaction?.message?.accountKeys ?? [];
  let idx = -1;
  for (let i = 0; i < keys.length; i++) {
    const k = typeof keys[i] === 'string' ? keys[i] : keys[i]?.pubkey?.toBase58?.() ?? keys[i]?.pubkey;
    if (k === owner) { idx = i; break; }
  }
  if (idx < 0) return 0;
  const pre  = Number(tx?.meta?.preBalances?.[idx]  ?? 0);
  const post = Number(tx?.meta?.postBalances?.[idx] ?? 0);
  const fee  = idx === 0 ? Number(tx?.meta?.fee ?? 0) : 0;
  return (post - pre + fee) / 1e9;
}

type Classified = {
  kind: Kind;
  desc: string;
  amount?: number;
  symbol?: string;
  counterAmount?: number;
  counterSymbol?: string;
  mint?: string;
  counterMint?: string;
  fee?: number;
};

// Classify a parsed transaction by walking top-level + inner instructions.
function classify(tx: any, owner: string): Classified {
  const feeLamports = Number(tx?.meta?.fee ?? 0);
  const feeXnt = feeLamports / 1e9;
  if (tx?.meta?.err) {
    return { kind: 'failed', desc: 'Transaction failed', fee: feeXnt };
  }
  const all: any[] = [
    ...(tx?.transaction?.message?.instructions ?? []),
    ...((tx?.meta?.innerInstructions ?? []).flatMap((g: any) => g.instructions ?? [])),
  ];

  let burnAmt = 0;
  let burnSym = '';
  let burnMint = '';
  let burnIsNft = false;
  let sentAmt = 0;
  let sentSym = '';
  let sentMint = '';
  let recvAmt = 0;
  let recvSym = '';
  let recvMint = '';

  for (const ix of all) {
    const prog = ix?.program;
    if (prog !== 'spl-token' && prog !== 'spl-token-2022') continue;
    const type = ix?.parsed?.type;
    const info = ix?.parsed?.info ?? {};
    const ta = info.tokenAmount ?? {};
    const ui = Number(ta.uiAmount ?? info.amount ?? 0);
    if (type === 'burn' || type === 'burnChecked') {
      burnAmt += ui;
      burnSym = burnSym || symbolHint(info.mint);
      burnMint = burnMint || (info.mint ?? '');
      // decimals 0 + a whole-unit amount ⇒ an NFT (incinerator burn).
      if (Number(ta.decimals ?? -1) === 0 && ui === Math.floor(ui) && ui >= 1) burnIsNft = true;
    } else if (type === 'transfer' || type === 'transferChecked') {
      if (info.authority === owner || info.multisigAuthority === owner) {
        sentAmt += ui;
        sentSym = sentSym || symbolHint(info.mint);
        sentMint = sentMint || (info.mint ?? '');
      } else {
        recvAmt += ui;
        recvSym = recvSym || symbolHint(info.mint);
        recvMint = recvMint || (info.mint ?? '');
      }
    }
  }
  const sawSwap = sentAmt > 0 && recvAmt > 0;

  if (burnAmt > 0) {
    return {
      kind: 'burn',
      desc: burnIsNft
        ? `${fmtNum(burnAmt, 0)} NFT${burnAmt > 1 ? 's' : ''} Burned`
        : `Burned ${fmtNum(burnAmt, burnAmt < 1 ? 4 : 2)} ${burnSym || 'tokens'}`,
      amount: burnAmt, symbol: burnSym, mint: burnMint, fee: feeXnt,
    };
  }
  // XDEX/router swaps often surface only one leg in the instruction walk (e.g.
  // XNT is unwrapped to native, so the receive looks like a plain transfer).
  // Derive BOTH legs from the owner's net token + native balance deltas so a
  // trade reads as a trade instead of "Received 50 XNT".
  const SWAP_PIDS = ['sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN', '9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU'];
  const isSwapTx = all.some(ix => SWAP_PIDS.includes(ix?.programId ?? ''));
  if (isSwapTx) {
    const tokDelta = new Map<string, number>();
    for (const b of (tx?.meta?.postTokenBalances ?? [])) if (b?.owner === owner) tokDelta.set(b.mint, (tokDelta.get(b.mint) ?? 0) + Number(b.uiTokenAmount?.uiAmount ?? 0));
    for (const b of (tx?.meta?.preTokenBalances ?? []))  if (b?.owner === owner) tokDelta.set(b.mint, (tokDelta.get(b.mint) ?? 0) - Number(b.uiTokenAmount?.uiAmount ?? 0));
    const legs: { sym: string; mint: string; delta: number }[] = [];
    for (const [mint, d] of tokDelta) if (Math.abs(d) > 1e-9) legs.push({ sym: symbolHint(mint), mint, delta: d });
    const nat = nativeXntDelta(tx, owner);
    if (Math.abs(nat) > 1e-6) legs.push({ sym: 'XNT', mint: 'So11111111111111111111111111111111111111112', delta: nat });
    const sent = legs.filter(l => l.delta < 0).sort((a, b) => a.delta - b.delta)[0];
    const recv = legs.filter(l => l.delta > 0).sort((a, b) => b.delta - a.delta)[0];
    if (sent && recv) {
      const sa = Math.abs(sent.delta);
      return {
        kind: 'swap',
        desc: `Swapped ${fmtNum(sa, sa < 1 ? 4 : 2)} ${sent.sym} → ${fmtNum(recv.delta, recv.delta < 1 ? 4 : 2)} ${recv.sym}`,
        amount: sa, symbol: sent.sym, mint: sent.mint,
        counterAmount: recv.delta, counterSymbol: recv.sym, counterMint: recv.mint,
        fee: feeXnt,
      };
    }
  }
  if (sawSwap) {
    return {
      kind: 'swap',
      desc: `Swapped ${fmtNum(sentAmt, sentAmt < 1 ? 4 : 2)} ${sentSym} → ${fmtNum(recvAmt, recvAmt < 1 ? 4 : 2)} ${recvSym}`,
      amount: sentAmt, symbol: sentSym, mint: sentMint,
      counterAmount: recvAmt, counterSymbol: recvSym, counterMint: recvMint,
      fee: feeXnt,
    };
  }
  if (sentAmt > 0) {
    return {
      kind: 'send',
      desc: `Sent ${fmtNum(sentAmt, sentAmt < 1 ? 4 : 2)} ${sentSym || 'tokens'}`,
      amount: sentAmt, symbol: sentSym, mint: sentMint, fee: feeXnt,
    };
  }
  if (recvAmt > 0) {
    return {
      kind: 'receive',
      desc: `Received ${fmtNum(recvAmt, recvAmt < 1 ? 4 : 2)} ${recvSym || 'tokens'}`,
      amount: recvAmt, symbol: recvSym, mint: recvMint, fee: feeXnt,
    };
  }

  // ── No SPL-token movement. Try native XNT (System.transfer). ─────────
  const dXnt = nativeXntDelta(tx, owner);
  if (dXnt >  0.000005) {
    return {
      kind: 'receive',
      desc: `Received ${fmtNum(dXnt, dXnt < 1 ? 4 : 2)} XNT`,
      amount: dXnt, symbol: 'XNT', mint: XNT_MINT_STR, fee: feeXnt,
    };
  }
  if (dXnt < -0.000005) {
    return {
      kind: 'send',
      desc: `Sent ${fmtNum(-dXnt, -dXnt < 1 ? 4 : 2)} XNT`,
      amount: -dXnt, symbol: 'XNT', mint: XNT_MINT_STR, fee: feeXnt,
    };
  }

  // ── Still nothing? Tag by program + Anchor ix name from logs. ────────
  const prog = programLabel(tx);
  const ixName = ixNameFromLogs(tx);
  if (prog) {
    return {
      kind: prog.kind,
      desc: ixName ? `${prog.label} · ${ixName}` : prog.label,
      fee: feeXnt,
    };
  }
  return {
    kind: 'other',
    desc: ixName ? `Anchor · ${ixName}` : 'On-chain interaction',
    fee: feeXnt,
  };
}

// Very small symbol hint table — full resolution would need a mint→symbol
// call per row. Keep this to the tokens the citizen sees most.
const KNOWN_SYMBOLS: Record<string, string> = {
  'EpKRiKwbCKZDZE9pgH48HcXqQkBunXUK5axC1EHUBtPN': 'BRAINS',
  'Dj7AY5CXLHtcT5gZ59Kg3nYgx4FUNMR38dZdQcGT3PA6': 'LB',
  'So11111111111111111111111111111111111111112':  'XNT',
};
function symbolHint(mint?: string): string {
  if (!mint) return '';
  return KNOWN_SYMBOLS[mint] ?? `${mint.slice(0, 4)}…`;
}

export default function ActivityLog() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!publicKey) { setItems([]); return; }
    let alive = true;
    setLoading(true); setErr('');
    const owner = publicKey.toBase58();

    (async () => {
      try {
        // ── 1) On-chain signatures + parsed bodies ──
        const sigs = await connection.getSignaturesForAddress(publicKey, { limit: 12 }).catch(() => []);
        const sigStrs = sigs.map(s => s.signature);
        const [parsed, allPrices] = await Promise.all([
          sigStrs.length > 0
            ? connection.getParsedTransactions(sigStrs, {
                maxSupportedTransactionVersion: 0, commitment: 'confirmed',
              }).catch(() => [] as any[])
            : Promise.resolve([] as any[]),
          fetchAllPrices().catch(() => ({ XNT: 0, BRAINS: 0, LB: 0 })),
        ]);
        const priceFor = (mint?: string): number => {
          if (!mint) return 0;
          if (mint === BRAINS_MINT)    return allPrices.BRAINS;
          if (mint === LB_MINT)        return allPrices.LB;
          if (mint === XNT_MINT_STR)   return allPrices.XNT;
          return 0;
        };

        if (!alive) return;

        const fromChain: ActivityItem[] = [];
        for (let i = 0; i < sigStrs.length; i++) {
          const tx  = parsed[i];
          const sig = sigStrs[i];
          const blockTime = tx?.blockTime ?? sigs[i]?.blockTime ?? 0;
          if (!tx) {
            fromChain.push({
              key: sig, sig, kind: 'other',
              ...metaForKind('other'),
              desc: 'On-chain interaction',
              blockTime,
            });
            continue;
          }
          const c = classify(tx, owner);
          // USD valuation — prefer the side we recognise.
          let usd: number | undefined;
          const px = priceFor(c.mint);
          const pxC = priceFor(c.counterMint);
          if (px > 0 && c.amount)             usd = c.amount * px;
          else if (pxC > 0 && c.counterAmount) usd = c.counterAmount * pxC;

          fromChain.push({
            key: sig, sig, kind: c.kind,
            ...metaForKind(c.kind),
            desc: c.desc,
            amount: c.amount, symbol: c.symbol,
            counterAmount: c.counterAmount, counterSymbol: c.counterSymbol,
            usd, fee: c.fee,
            blockTime,
          });
        }

        // ── 2) Supabase burn ledger — overlay so historical rich data wins ──
        try {
          const burns = await getBurnEventsForWallet(owner);
          const map = new Map<string, ActivityItem>();
          fromChain.forEach(it => map.set(it.sig, it));
          for (const b of burns.slice(0, 12)) {
            const usd = allPrices.BRAINS > 0 ? b.amount * allPrices.BRAINS : undefined;
            map.set(b.sig, {
              key: b.sig, sig: b.sig, kind: 'burn',
              ...metaForKind('burn'),
              desc: `Burned ${fmtNum(b.amount, 0)} BRAINS`,
              amount: b.amount, symbol: 'BRAINS', usd,
              blockTime: b.block_time,
            });
          }
          const merged = Array.from(map.values())
            .sort((a, b) => b.blockTime - a.blockTime)
            .slice(0, 6);
          if (alive) setItems(merged);
        } catch {
          if (alive) setItems(fromChain.slice(0, 6));
        }
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'Failed to load activity');
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => { alive = false; };
  }, [publicKey, connection]);

  const empty = useMemo(() => connected && !loading && items.length === 0, [connected, loading, items]);

  return (
    <div className="info-card">
      <div className="title">Activity Log</div>

      {!connected && (
        <div className="lw-placeholder" style={{ padding: '18px 8px' }}>
          <div className="lw-placeholder-sub" style={{ fontSize: 11 }}>
            Connect a wallet to view your recent activity.
          </div>
        </div>
      )}

      {connected && loading && (
        <div className="lw-placeholder" style={{ padding: '14px 8px' }}>
          <div className="lw-placeholder-sub" style={{ fontSize: 11 }}>Scanning chain…</div>
        </div>
      )}

      {connected && !loading && err && (
        <div className="lw-placeholder" style={{ padding: '14px 8px' }}>
          <div className="lw-placeholder-sub" style={{ fontSize: 11, color: '#ff6666' }}>
            {err}
          </div>
        </div>
      )}

      {empty && (
        <div className="lw-placeholder" style={{ padding: '14px 8px' }}>
          <div className="lw-placeholder-sub" style={{ fontSize: 11 }}>
            No recent activity for this wallet.
          </div>
        </div>
      )}

      {connected && !loading && items.map(it => {
        const kindColor =
          it.kind === 'burn'    ? '#ff8c00' :
          it.kind === 'swap'    ? '#00d4ff' :
          it.kind === 'send'    ? '#bf5af2' :
          it.kind === 'receive' ? '#00c98d' :
          it.kind === 'failed'  ? '#ff4466' :
          it.kind === 'farm'    ? '#00c98d' :
          it.kind === 'pairing' ? '#bf5af2' :
          it.kind === 'market'  ? '#ffb700' :
          it.kind === 'mint'    ? '#00d4ff' :
          it.kind === 'nft'     ? '#bf5af2' :
          it.kind === 'memo'    ? '#8899aa' : '#5c7a90';
        return (
          <a
            key={it.key}
            href={`https://explorer.mainnet.x1.xyz/tx/${it.sig}`}
            target="_blank" rel="noopener noreferrer"
            className="activity-item"
            style={{
              textDecoration: 'none', color: 'inherit',
              display: 'grid',
              gridTemplateColumns: '28px 1fr auto',
              gap: 10,
              padding: '8px 10px',
              borderRadius: 6,
              border: `1px solid ${kindColor}22`,
              background: `${kindColor}06`,
              marginBottom: 5,
              transition: 'border-color .15s, background .15s',
              alignItems: 'center',
            }}
            title={`View ${it.sig.slice(0, 12)}… on explorer`}
          >
            <span style={{
              width: 28, height: 28, borderRadius: 6,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: `${kindColor}18`, border: `1px solid ${kindColor}55`,
              color: kindColor, fontSize: 13, fontWeight: 800,
            }}>{it.icon}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontFamily: 'Orbitron, monospace', fontSize: 10, fontWeight: 700,
                color: '#cdd8e2', letterSpacing: 0.4,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{it.desc}</div>
              <div style={{
                fontFamily: 'Orbitron, monospace', fontSize: 8,
                color: '#5c7a90', letterSpacing: 1.2, marginTop: 2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                <span style={{ color: kindColor, fontWeight: 800 }}>{it.kind.toUpperCase()}</span>
                {it.usd != null && it.usd > 0.005 && <> · {fmtUSD(it.usd)}</>}
                {it.fee != null && it.fee > 0 && <> · fee {it.fee.toFixed(6)} XNT</>}
                {' · '}{fmtClock(it.blockTime)}
                {' · '}
                <span style={{ color: '#3a4a5a' }}>{it.sig.slice(0, 6)}…{it.sig.slice(-4)}</span>
              </div>
            </div>
            <span style={{
              fontFamily: 'Orbitron, monospace', fontSize: 9, color: kindColor,
              letterSpacing: 0.8, fontWeight: 700, whiteSpace: 'nowrap',
            }}>{timeAgo(it.blockTime)}</span>
          </a>
        );
      })}
    </div>
  );
}
