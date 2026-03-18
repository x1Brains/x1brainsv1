// src/components/SendPanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Inline send drawer — expands below any TokenCard
// Features: single send, batch (multi-wallet airdrop), address book,
//           fee estimator, send history with tx links
// ─────────────────────────────────────────────────────────────────────────────
import React, { FC, useState, useEffect, useCallback, useRef } from 'react';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type { TokenData } from './TokenComponents';

// ─── STYLE INJECTION ─────────────────────────────────────────────────────────
(function () {
  if (typeof document === 'undefined') return;
  if (document.getElementById('send-panel-styles')) return;
  const s = document.createElement('style');
  s.id = 'send-panel-styles';
  s.textContent = `
    @keyframes sp-slide-down {
      from { opacity:0; transform:translateY(-8px); max-height:0; }
      to   { opacity:1; transform:translateY(0);    max-height:800px; }
    }
    @keyframes sp-fade { from{opacity:0} to{opacity:1} }
    @keyframes sp-spin  { to{transform:rotate(360deg)} }
    .sp-input {
      width:100%; padding:10px 14px;
      background:rgba(0,0,0,.4); border:1px solid rgba(255,140,0,.2);
      border-radius:8px; font-family:'Sora',sans-serif; font-size:13px;
      color:#e0e8f0; outline:none; box-sizing:border-box; transition:border-color .2s;
    }
    .sp-input:focus { border-color:rgba(255,140,0,.5); box-shadow:0 0 0 3px rgba(255,140,0,.08); }
    .sp-input::placeholder { color:#3a5060; }
    .sp-btn {
      padding:10px 18px; border:none; border-radius:8px; cursor:pointer;
      font-family:'Orbitron',monospace; font-size:10px; font-weight:700;
      letter-spacing:1.5px; transition:all .2s; text-transform:uppercase;
    }
  `;
  document.head.appendChild(s);
})();

// ─── TYPES ────────────────────────────────────────────────────────────────────
export interface SavedAddress {
  id:        string;
  wallet:    string;
  nickname:  string;
  created_at:string;
}

export interface SendRecord {
  id:         string;
  from_wallet:string;
  to_wallet:  string;
  mint:       string;
  symbol:     string;
  amount:     number;
  tx_sig:     string;
  sent_at:    string;
}

interface BatchRow { to: string; amount: string; nickname?: string; }

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const short = (a: string) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : '';
const EXPLORER = 'https://explorer.mainnet.x1.xyz/tx/';

function isValidPublicKey(addr: string): boolean {
  try { new PublicKey(addr.trim()); return true; } catch { return false; }
}

// ─── FEE ESTIMATOR ────────────────────────────────────────────────────────────
async function estimateFee(
  connection: any,
  wallet: PublicKey,
  recipientCount: number,
): Promise<number> {
  try {
    // ~5000 lamports base + 2000 per ATA creation estimate
    const baseFee = 5000;
    const ataFee  = 2039280; // ~0.002 SOL per new ATA (rent-exempt min)
    // We can't know ahead of time which ATAs exist, so show base + worst-case
    return (baseFee * recipientCount + ataFee * recipientCount) / LAMPORTS_PER_SOL;
  } catch {
    return 0.005 * recipientCount;
  }
}

// ─── SEND FUNCTION ────────────────────────────────────────────────────────────
async function sendTokens(
  connection: any,
  wallet: any,
  token: TokenData,
  recipients: { address: string; amount: number }[],
  onStatus: (msg: string) => void,
): Promise<string[]> {
  if (!wallet.publicKey || !wallet.signAllTransactions)
    throw new Error('Wallet not connected or does not support signAllTransactions');

  const isNative = token.mint === 'native-xnt';
  const progId   = token.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintPk   = isNative ? null : new PublicKey(token.mint);
  const sigs: string[] = [];

  // Build one tx per recipient (keeps things simple & reliable on X1)
  const txs: { tx: Transaction; label: string }[] = [];

  for (const r of recipients) {
    const recipientPk = new PublicKey(r.address.trim());
    const tx = new Transaction();

    if (isNative) {
      // Native XNT transfer
      tx.add(SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey:   recipientPk,
        lamports:   Math.floor(r.amount * LAMPORTS_PER_SOL),
      }));
    } else {
      const rawAmt = BigInt(Math.floor(r.amount * Math.pow(10, token.decimals)));
      const sAta   = getAssociatedTokenAddressSync(mintPk!, wallet.publicKey, false, progId);
      const rAta   = getAssociatedTokenAddressSync(mintPk!, recipientPk, false, progId);

      // Create recipient ATA if needed
      try { await getAccount(connection, rAta, 'confirmed', progId); }
      catch {
        tx.add(createAssociatedTokenAccountInstruction(
          wallet.publicKey, rAta, recipientPk, mintPk!, progId,
        ));
      }

      tx.add(createTransferCheckedInstruction(
        sAta, mintPk!, rAta, wallet.publicKey,
        rawAmt, token.decimals, [], progId,
      ));
    }

    txs.push({ tx, label: `${r.amount} ${token.symbol} → ${short(r.address)}` });
  }

  // Sign all at once — single wallet approval for batch
  onStatus(`🔐 Requesting approval for ${txs.length} transaction${txs.length > 1 ? 's' : ''}…`);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  txs.forEach(({ tx }) => {
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = blockhash;
  });

  const signed = await wallet.signAllTransactions(txs.map(t => t.tx));

  for (let i = 0; i < signed.length; i++) {
    onStatus(`📡 Sending ${txs[i].label}…`);
    const sig = await connection.sendRawTransaction(signed[i].serialize(), {
      skipPreflight: false, preflightCommitment: 'confirmed',
    });
    // Poll for confirmation
    for (let p = 0; p < 30; p++) {
      try {
        const resp = await connection.getSignatureStatuses([sig]);
        const s = resp?.value?.[0];
        if (s?.err) throw new Error(`TX failed: ${JSON.stringify(s.err)}`);
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') break;
      } catch (e: any) { if (e.message?.startsWith('TX failed')) throw e; }
      await new Promise(r => setTimeout(r, 500));
    }
    sigs.push(sig);
    onStatus(`✅ Confirmed: ${txs[i].label}`);
  }

  return sigs;
}

// ─── ADDRESS BOOK DROPDOWN ────────────────────────────────────────────────────
const AddressBookPicker: FC<{
  savedAddresses: SavedAddress[];
  onSelect: (addr: string, nick: string) => void;
  onDelete: (id: string) => void;
}> = ({ savedAddresses, onSelect, onDelete }) => {
  if (savedAddresses.length === 0) return (
    <div style={{ padding:'8px 12px', fontFamily:'Sora,sans-serif', fontSize:11, color:'#4a6070' }}>
      No saved addresses yet
    </div>
  );
  return (
    <div style={{ maxHeight:200, overflowY:'auto' }}>
      {savedAddresses.map(a => (
        <div key={a.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px',
          borderBottom:'1px solid rgba(255,255,255,.04)', cursor:'pointer', transition:'background .15s' }}
          onMouseEnter={e => (e.currentTarget.style.background='rgba(255,140,0,.06)')}
          onMouseLeave={e => (e.currentTarget.style.background='transparent')}
        >
          <div style={{ flex:1, minWidth:0 }} onClick={() => onSelect(a.wallet, a.nickname)}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#ff8c00', fontWeight:700 }}>{a.nickname}</div>
            <div style={{ fontFamily:'monospace', fontSize:10, color:'#5a7a90' }}>{short(a.wallet)}</div>
          </div>
          <button onClick={e => { e.stopPropagation(); onDelete(a.id); }}
            style={{ background:'none', border:'none', color:'#ff4466', fontSize:14, cursor:'pointer', padding:'0 4px', opacity:.6 }}
            title="Remove">×</button>
        </div>
      ))}
    </div>
  );
};

// ─── SEND HISTORY ROW ────────────────────────────────────────────────────────
export const SendHistoryRow: FC<{ record: SendRecord; isMobile: boolean }> = ({ record, isMobile }) => (
  <div style={{ display:'grid', gridTemplateColumns: isMobile ? '1fr 80px' : '1fr 120px 100px 120px',
    gap:8, padding:'9px 14px', borderBottom:'1px solid rgba(255,255,255,.04)',
    alignItems:'center', transition:'background .15s' }}
    onMouseEnter={e => (e.currentTarget.style.background='rgba(255,140,0,.03)')}
    onMouseLeave={e => (e.currentTarget.style.background='transparent')}
  >
    <div>
      <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
        <span style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color:'#ff8c00' }}>
          {record.amount.toLocaleString(undefined,{maximumFractionDigits:4})} {record.symbol}
        </span>
        <span style={{ fontFamily:'Sora,sans-serif', fontSize:10, color:'#5a7a90' }}>→</span>
        <span style={{ fontFamily:'monospace', fontSize:10, color:'#8aabb8' }}>{short(record.to_wallet)}</span>
      </div>
      {isMobile && (
        <div style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#3a5060', marginTop:3 }}>
          {new Date(record.sent_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
        </div>
      )}
    </div>
    {!isMobile && (
      <>
        <span style={{ fontFamily:'monospace', fontSize:10, color:'#5a7a90' }}>{short(record.to_wallet)}</span>
        <span style={{ fontFamily:'Sora,sans-serif', fontSize:9, color:'#3a5060' }}>
          {new Date(record.sent_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}
        </span>
      </>
    )}
    <a href={`${EXPLORER}${record.tx_sig}`} target="_blank" rel="noopener noreferrer"
      style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#00d4ff', textDecoration:'none',
        padding:'3px 8px', background:'rgba(0,212,255,.06)', border:'1px solid rgba(0,212,255,.2)',
        borderRadius:5, whiteSpace:'nowrap', textAlign:'center' }}>
      TX ↗
    </a>
  </div>
);

// ─── MAIN SEND PANEL ─────────────────────────────────────────────────────────
interface SendPanelProps {
  token:          TokenData;
  wallet:         any;
  connection:     any;
  isMobile:       boolean;
  savedAddresses: SavedAddress[];
  onSaveAddress:  (wallet: string, nickname: string) => void;
  onDeleteAddress:(id: string) => void;
  onSendComplete: (records: SendRecord[]) => void;
  onClose:        () => void;
}

export const SendPanel: FC<SendPanelProps> = ({
  token, wallet, connection, isMobile,
  savedAddresses, onSaveAddress, onDeleteAddress, onSendComplete, onClose,
}) => {
  const [mode,       setMode]       = useState<'single'|'batch'>('single');
  // Single send
  const [toAddr,     setToAddr]     = useState('');
  const [amount,     setAmount]     = useState('');
  const [nickname,   setNickname]   = useState('');
  const [saveAddr,   setSaveAddr]   = useState(false);
  const [showBook,   setShowBook]   = useState(false);
  // Batch
  const [rows,       setRows]       = useState<BatchRow[]>([{ to:'', amount:'' },{ to:'', amount:'' }]);
  // Shared
  const [status,     setStatus]     = useState('');
  const [sending,    setSending]    = useState(false);
  const [feeEst,     setFeeEst]     = useState<number|null>(null);
  const [error,      setError]      = useState('');
  const bookRef = useRef<HTMLDivElement>(null);

  // Close address book on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (bookRef.current && !bookRef.current.contains(e.target as Node)) setShowBook(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // Fee estimate whenever recipients change
  useEffect(() => {
    if (!wallet?.publicKey || !connection) return;
    const count = mode === 'single' ? 1 : rows.filter(r => r.to.trim() && r.amount.trim()).length;
    if (count === 0) { setFeeEst(null); return; }
    estimateFee(connection, wallet.publicKey, count).then(setFeeEst).catch(() => setFeeEst(null));
  }, [mode, toAddr, rows, wallet, connection]);

  const handleSend = useCallback(async () => {
    setError(''); setStatus('');
    if (!wallet?.publicKey) { setError('Wallet not connected'); return; }
    if (!wallet?.signAllTransactions) { setError('Wallet does not support batch signing — try Phantom or Backpack'); return; }
    const recipients = mode === 'single'
      ? [{ address: toAddr.trim(), amount: parseFloat(amount) }]
      : rows.filter(r => r.to.trim() && r.amount.trim()).map(r => ({ address: r.to.trim(), amount: parseFloat(r.amount) }));

    // Validate
    for (const r of recipients) {
      if (!isValidPublicKey(r.address)) { setError(`Invalid address: ${short(r.address) || r.address}`); return; }
      if (!r.amount || isNaN(r.amount) || r.amount <= 0) { setError('Amount must be greater than 0'); return; }
      if (r.amount > token.balance) { setError(`Amount exceeds balance (${token.balance.toLocaleString()} ${token.symbol})`); return; }
    }
    if (recipients.length === 0) { setError('Add at least one recipient'); return; }

    setSending(true);
    try {
      const sigs = await sendTokens(connection, wallet, token, recipients, setStatus);

      // Save address if requested
      if (mode === 'single' && saveAddr && toAddr.trim()) {
        onSaveAddress(toAddr.trim(), nickname || short(toAddr.trim()));
      }

      // Build records for history
      const now = new Date().toISOString();
      const records: SendRecord[] = recipients.map((r, i) => ({
        id:          crypto.randomUUID(),
        from_wallet: wallet.publicKey.toBase58(),
        to_wallet:   r.address,
        mint:        token.mint,
        symbol:      token.symbol,
        amount:      r.amount,
        tx_sig:      sigs[i],
        sent_at:     now,
      }));

      onSendComplete(records);
      setStatus(`✅ Done! Sent ${recipients.length} transaction${recipients.length>1?'s':''}.`);
      setToAddr(''); setAmount(''); setRows([{to:'',amount:''},{to:'',amount:''}]);
    } catch (e: any) {
      setError(e.message ?? 'Send failed');
      setStatus('');
    } finally {
      setSending(false);
    }
  }, [mode, toAddr, amount, rows, token, wallet, connection, saveAddr, nickname, onSaveAddress, onSendComplete]);

  const accent = '#ff8c00';

  return (
    <div style={{
      animation: 'sp-slide-down .25s ease both',
      background: 'linear-gradient(135deg,rgba(255,140,0,.04),rgba(0,0,0,.3))',
      border: '1px solid rgba(255,140,0,.2)',
      borderTop: '2px solid rgba(255,140,0,.4)',
      borderRadius: '0 0 14px 14px',
      padding: isMobile ? '16px 14px' : '20px 22px',
      marginTop: -2,
    }}>

      {/* ── HEADER ── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:16 }}>📤</span>
          <span style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color:accent, letterSpacing:2 }}>
            SEND {token.symbol}
          </span>
          <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#5a7a90' }}>
            BAL: {token.balance.toLocaleString(undefined,{maximumFractionDigits:4})}
          </span>
        </div>
        <button type="button" onClick={onClose} style={{ background:'none', border:'none', color:'#5a7a90', fontSize:18, cursor:'pointer', padding:'0 4px', lineHeight:1 }}>×</button>
      </div>

      {/* ── MODE TOGGLE ── */}
      <div style={{ display:'flex', gap:6, marginBottom:16 }}>
        {(['single','batch'] as const).map(m => (
          <button type="button" key={m} onClick={() => setMode(m)} className="sp-btn" style={{
            background: mode===m ? `rgba(255,140,0,.15)` : 'rgba(255,255,255,.04)',
            border: `1px solid ${mode===m ? 'rgba(255,140,0,.5)' : 'rgba(255,255,255,.1)'}`,
            color: mode===m ? accent : '#5a7a90',
            padding:'7px 16px',
          }}>
            {m === 'single' ? '👤 Single' : '👥 Batch Send'}
          </button>
        ))}
      </div>

      {/* ── SINGLE SEND ── */}
      {mode === 'single' && (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>

          {/* Recipient input + address book */}
          <div style={{ position:'relative' }} ref={bookRef}>
            <div style={{ display:'flex', gap:8 }}>
              <input
                className="sp-input"
                placeholder="Recipient wallet address…"
                value={toAddr}
                onChange={e => setToAddr(e.target.value)}
                style={{ flex:1 }}
              />
              <button type="button" onClick={() => setShowBook(v => !v)} title="Address book"
                style={{ background: showBook ? 'rgba(255,140,0,.15)' : 'rgba(255,255,255,.06)',
                  border:`1px solid ${showBook ? 'rgba(255,140,0,.4)' : 'rgba(255,255,255,.1)'}`,
                  borderRadius:8, padding:'0 12px', cursor:'pointer', fontSize:16, flexShrink:0 }}>
                📒
              </button>
            </div>
            {showBook && (
              <div style={{ position:'absolute', top:'calc(100% + 4px)', left:0, right:0, zIndex:50,
                background:'#0d1520', border:'1px solid rgba(255,140,0,.25)', borderRadius:10,
                overflow:'hidden', boxShadow:'0 8px 32px rgba(0,0,0,.5)' }}>
                <AddressBookPicker
                  savedAddresses={savedAddresses}
                  onSelect={(addr, nick) => { setToAddr(addr); setNickname(nick); setShowBook(false); }}
                  onDelete={onDeleteAddress}
                />
              </div>
            )}
          </div>

          {/* Amount row */}
          <div style={{ display:'flex', gap:8 }}>
            <input
              className="sp-input"
              type="number" min="0" step="any"
              placeholder={`Amount of ${token.symbol}…`}
              value={amount}
              onChange={e => setAmount(e.target.value)}
              style={{ flex:1 }}
            />
            <button type="button" onClick={() => setAmount(String(token.balance))} className="sp-btn"
              style={{ background:'rgba(0,212,255,.08)', border:'1px solid rgba(0,212,255,.2)', color:'#00d4ff', padding:'0 14px', flexShrink:0 }}>
              MAX
            </button>
          </div>

          {/* Save address option */}
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', userSelect:'none' }}>
            <input type="checkbox" checked={saveAddr} onChange={e => setSaveAddr(e.target.checked)}
              style={{ accentColor: accent, width:14, height:14 }} />
            <span style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#7a9ab8' }}>Save this address</span>
          </label>
          {saveAddr && (
            <input className="sp-input" placeholder="Nickname (e.g. My other wallet)…"
              value={nickname} onChange={e => setNickname(e.target.value)} />
          )}
        </div>
      )}

      {/* ── BATCH SEND ── */}
      {mode === 'batch' && (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#5a7a90', marginBottom:4 }}>
            Add multiple recipients — all signed in one approval.
          </div>
          {rows.map((row, i) => (
            <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr auto auto', gap:8, alignItems:'center' }}>
              <input className="sp-input" placeholder={`Wallet ${i+1}…`}
                value={row.to} onChange={e => { const r=[...rows]; r[i]={...r[i],to:e.target.value}; setRows(r); }} />
              <input className="sp-input" type="number" min="0" step="any"
                placeholder="Amount" value={row.amount}
                onChange={e => { const r=[...rows]; r[i]={...r[i],amount:e.target.value}; setRows(r); }}
                style={{ width:isMobile?80:100 }} />
              {rows.length > 1 && (
                <button type="button" onClick={() => setRows(rows.filter((_,j)=>j!==i))}
                  style={{ background:'none', border:'none', color:'#ff4466', fontSize:16, cursor:'pointer', padding:'0 4px' }}>×</button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setRows([...rows,{to:'',amount:''}])} className="sp-btn"
            style={{ background:'rgba(0,201,141,.08)', border:'1px solid rgba(0,201,141,.25)', color:'#00c98d',
              padding:'8px 0', width:'100%', marginTop:4 }}>
            + ADD RECIPIENT
          </button>
        </div>
      )}

      {/* ── FEE ESTIMATE ── */}
      {feeEst !== null && (
        <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:12, padding:'8px 12px',
          background:'rgba(0,212,255,.04)', border:'1px solid rgba(0,212,255,.12)', borderRadius:8 }}>
          <span style={{ fontSize:12 }}>⛽</span>
          <span style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#5a9ab8' }}>
            Est. network fee: <span style={{ color:'#00d4ff', fontWeight:600 }}>~{feeEst.toFixed(5)} XNT</span>
            <span style={{ color:'#3a5060', fontSize:10 }}> (includes ATA creation if needed)</span>
          </span>
        </div>
      )}

      {/* ── STATUS / ERROR ── */}
      {error && (
        <div style={{ marginTop:10, padding:'10px 14px', background:'rgba(255,68,102,.08)',
          border:'1px solid rgba(255,68,102,.25)', borderRadius:8,
          fontFamily:'Sora,sans-serif', fontSize:12, color:'#ff8899' }}>
          ⚠️ {error}
        </div>
      )}
      {status && (
        <div style={{ marginTop:10, padding:'10px 14px', background:'rgba(0,201,141,.06)',
          border:'1px solid rgba(0,201,141,.2)', borderRadius:8,
          fontFamily:'Sora,sans-serif', fontSize:12, color:'#00c98d' }}>
          {status}
        </div>
      )}

      {/* ── SEND BUTTON ── */}
      <button
        type="button"
        onClick={handleSend}
        disabled={sending}
        className="sp-btn"
        style={{
          marginTop:14, width:'100%', padding:'13px 0',
          background: sending ? 'rgba(255,140,0,.3)' : 'linear-gradient(135deg,#ff8c00,#ffb700)',
          color: '#0a0e14', fontSize:12, opacity: sending ? 0.7 : 1,
          cursor: sending ? 'not-allowed' : 'pointer',
          boxShadow: sending ? 'none' : '0 4px 20px rgba(255,140,0,.3)',
        }}
      >
        {sending
          ? <span style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
              <span style={{ width:14, height:14, border:'2px solid rgba(0,0,0,.3)', borderTop:'2px solid #0a0e14',
                borderRadius:'50%', animation:'sp-spin .7s linear infinite', display:'inline-block' }} />
              SENDING…
            </span>
          : `SEND ${token.symbol}`
        }
      </button>

    </div>
  );
};