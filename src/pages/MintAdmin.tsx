// src/pages/MintAdmin.tsx
// ─────────────────────────────────────────────────────────────────────────────
// LB MINT ADMIN PANEL — protected route at /x9b7r41ns/mint-ctrl
// Only accessible by the admin wallet (CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2)
// All on-chain calls use raw instructions — no IDL required
// ─────────────────────────────────────────────────────────────────────────────

import React, { FC, useState, useEffect, useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import {
  PublicKey, Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TopBar, PageBackground, Footer } from '../components/UI';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const MINT_PROGRAM_ID = '3B6oAfmL7aGVAbBdu7zW3jqEVWK6o1nwFiufuSuFV6tN';
const ADMIN_WALLET    = 'CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2';
const TREASURY_WALLET = 'CAeTTU2zk2EjWLKVeg4zxYhHu7gba1oRN8NHEDjpK9XF';
const TOKEN_2022      = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Anchor discriminators — sha256("global:<name>")[0..8]
const DISC: Record<string, number[]> = {
  pause:              [211, 22,  221, 251, 74,  121, 193, 47],
  unpause:            [169, 144, 4,   38,  10,  141, 188, 255],
  update_admin:       [161, 176, 40,  213, 60,  184, 179, 228],
  update_tier_rates:  [23,  73,  90,  131, 70,  147, 182, 204],
  update_metadata_uri:[27,  40,  178, 7,   93,  135, 196, 102],
  collect_fees:       [164, 152, 207, 99,  30,  186, 19,  182],
};

// GlobalState layout offsets
// 0:   8  disc
// 8:   32 admin
// 40:  32 treasury
// 72:  32 lb_mint
// 104: 8  total_minted
// 112: 1  paused
// 113: 1  bump
// 114: 64 tier_rates [(u64,u64);4]
// 178: 8  _reserved

function encodeU64LE(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(Math.round(n)));
  return buf;
}

function encodeString(s: string): Buffer {
  const b = Buffer.from(s, 'utf-8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

function encodePubkey(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface GlobalStateData {
  admin:        string;
  treasury:     string;
  lbMint:       string;
  totalMinted:  number;
  paused:       boolean;
  bump:         number;
  tierRates:    { brains: number; xntLamports: number }[];
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function readU64LE(data: Uint8Array, offset: number): number {
  let value = 0n;
  for (let i = 0; i < 8; i++) { value |= BigInt(data[offset + i]) << BigInt(i * 8); }
  return Number(value);
}

function parseGlobalState(data: Uint8Array): GlobalStateData {
  const adminPk    = new PublicKey(data.slice(8,  40));
  const treasuryPk = new PublicKey(data.slice(40, 72));
  const lbMintPk   = new PublicKey(data.slice(72, 104));
  const totalRaw   = readU64LE(data, 104);
  const paused     = data[112] === 1;
  const bump       = data[113];
  const tierRates: { brains: number; xntLamports: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const off = 114 + i * 16;
    tierRates.push({ brains: readU64LE(data, off), xntLamports: readU64LE(data, off + 8) });
  }
  return {
    admin:       adminPk.toBase58(),
    treasury:    treasuryPk.toBase58(),
    lbMint:      lbMintPk.toBase58(),
    totalMinted: totalRaw / 100,
    paused, bump, tierRates,
  };
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

const MintAdmin: FC = () => {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  const [state,       setState]       = useState<GlobalStateData | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [status,      setStatus]      = useState('');
  const [pending,     setPending]     = useState(false);

  // Form states
  const [newAdmin,    setNewAdmin]    = useState('');
  const [newUri,      setNewUri]      = useState('');
  const [tierEdits,   setTierEdits]   = useState<{ brains: string; xnt: string }[]>([
    { brains: '8',  xnt: '0.50' },
    { brains: '18', xnt: '0.75' },
    { brains: '26', xnt: '1.00' },
    { brains: '33', xnt: '1.50' },
  ]);

  // Derived PDAs
  const programId   = new PublicKey(MINT_PROGRAM_ID);
  const [statePda]  = PublicKey.findProgramAddressSync([Buffer.from('lb_state')],    programId);
  const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from('lb_mint_auth')], programId);
  const [lbMintPda] = PublicKey.findProgramAddressSync([Buffer.from('lb_mint')],      programId);

  const isAdmin = publicKey?.toBase58() === ADMIN_WALLET;

  // ── Fetch GlobalState ──────────────────────────────────────────────
  const fetchState = useCallback(async () => {
    setLoading(true);
    try {
      const info = await connection.getAccountInfo(statePda);
      if (!info) { setStatus('❌ GlobalState not found — program may not be initialized.'); return; }
      const parsed = parseGlobalState(info.data as Uint8Array);
      setState(parsed);
      // Sync tier edit form with on-chain values
      setTierEdits(parsed.tierRates.map(r => ({
        brains: r.brains.toString(),
        xnt:    (r.xntLamports / LAMPORTS_PER_SOL).toFixed(4),
      })));
    } catch (e: any) {
      setStatus(`❌ Failed to fetch state: ${e.message}`);
    } finally { setLoading(false); }
  }, [connection, statePda]);

  useEffect(() => { fetchState(); }, [fetchState]);

  // ── Generic send helper ────────────────────────────────────────────
  const sendTx = useCallback(async (
    label: string,
    keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
    data: Buffer,
  ) => {
    if (!publicKey || !signTransaction) return;
    if (!isAdmin) { setStatus('❌ Not the admin wallet.'); return; }
    setPending(true);
    setStatus(`Sending: ${label}…`);
    try {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash });
      tx.add(new TransactionInstruction({ programId, keys, data }));
      const signed = await signTransaction(tx);
      const sig    = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setStatus(`⏳ Confirming ${label}…`);
      for (let i = 0; i < 40; i++) {
        if (i) await new Promise(r => setTimeout(r, 1500));
        const s = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
        if (s?.value?.err) throw new Error('On-chain error: ' + JSON.stringify(s.value.err));
        if (s?.value?.confirmationStatus === 'confirmed' || s?.value?.confirmationStatus === 'finalized') break;
      }
      setStatus(`✅ ${label} confirmed! <a href="https://explorer.mainnet.x1.xyz/tx/${sig}" target="_blank" rel="noopener" style="color:#00d4ff">View Tx ↗</a>`);
      setTimeout(() => fetchState(), 2000);
    } catch (e: any) {
      setStatus(`❌ ${label} failed: ${e.message?.slice(0, 150)}`);
    } finally { setPending(false); }
  }, [publicKey, signTransaction, isAdmin, connection, programId, fetchState]);

  // AdminOnly account keys — used by most instructions
  const adminKeys = (extraKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = []) => [
    { pubkey: publicKey!,              isSigner: true,  isWritable: true  }, // admin
    { pubkey: statePda,                isSigner: false, isWritable: true  }, // state
    { pubkey: lbMintPda,               isSigner: false, isWritable: true  }, // lb_mint
    { pubkey: mintAuthPda,             isSigner: false, isWritable: false }, // lb_mint_authority
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ...extraKeys,
  ];

  // ── Actions ───────────────────────────────────────────────────────

  const handlePause = () => sendTx('Pause Minting',
    adminKeys(),
    Buffer.from(DISC.pause),
  );

  const handleUnpause = () => sendTx('Unpause Minting',
    adminKeys(),
    Buffer.from(DISC.unpause),
  );

  const handleUpdateAdmin = () => {
    if (!newAdmin.trim()) { setStatus('❌ Enter a new admin wallet address.'); return; }
    let newPk: PublicKey;
    try { newPk = new PublicKey(newAdmin.trim()); } catch { setStatus('❌ Invalid wallet address.'); return; }
    const data = Buffer.concat([Buffer.from(DISC.update_admin), encodePubkey(newPk)]);
    sendTx('Transfer Admin', adminKeys(), data);
  };

  const handleUpdateUri = () => {
    if (!newUri.trim()) { setStatus('❌ Enter a metadata URI.'); return; }
    if (newUri.length > 200) { setStatus('❌ URI too long (max 200 chars).'); return; }
    const data = Buffer.concat([Buffer.from(DISC.update_metadata_uri), encodeString(newUri.trim())]);
    sendTx('Update Metadata URI',
      adminKeys([{ pubkey: TOKEN_2022, isSigner: false, isWritable: false }]),
      data,
    );
  };

  const handleUpdateTierRates = () => {
    const rates: { brains: number; xnt: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const brains = parseInt(tierEdits[i].brains);
      const xnt    = parseFloat(tierEdits[i].xnt);
      if (!brains || brains <= 0) { setStatus(`❌ Tier ${i+1}: BRAINS rate must be > 0.`); return; }
      if (isNaN(xnt) || xnt < 0 || xnt > 10) { setStatus(`❌ Tier ${i+1}: XNT fee must be 0–10.`); return; }
      rates.push({ brains, xnt });
    }
    // Encode [(u64, u64); 4]
    const encoded = rates.map(r => Buffer.concat([
      encodeU64LE(r.brains),
      encodeU64LE(Math.round(r.xnt * LAMPORTS_PER_SOL)),
    ]));
    const data = Buffer.concat([Buffer.from(DISC.update_tier_rates), ...encoded]);
    sendTx('Update Tier Rates', adminKeys(), data);
  };

  const handleCollectFees = () => {
    if (!state) return;
    const treasuryLbAta = getAssociatedTokenAddressSync(
      lbMintPda, new PublicKey(TREASURY_WALLET), false, TOKEN_2022_PROGRAM_ID,
    );
    sendTx('Collect Transfer Fees',
      [
        { pubkey: statePda,                isSigner: false, isWritable: false },
        { pubkey: lbMintPda,               isSigner: false, isWritable: true  },
        { pubkey: mintAuthPda,             isSigner: false, isWritable: false },
        { pubkey: treasuryLbAta,           isSigner: false, isWritable: true  },
        { pubkey: TOKEN_2022,              isSigner: false, isWritable: false },
      ],
      Buffer.from(DISC.collect_fees),
    );
  };

  // ── Styles ────────────────────────────────────────────────────────

  const card = (extra?: React.CSSProperties): React.CSSProperties => ({
    background: 'linear-gradient(135deg,rgba(10,14,22,.96),rgba(6,8,14,.96))',
    border: '1px solid rgba(255,140,0,.15)',
    borderRadius: 16, padding: '24px 28px',
    marginBottom: 20,
    ...extra,
  });

  const sectionTitle = (text: string, color = '#ff8c00') => (
    <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:900, color, letterSpacing:2, marginBottom:6 }}>{text}</div>
  );

  const desc = (text: string) => (
    <div style={{ fontFamily:'Sora,sans-serif', fontSize:12, color:'#7a9ab8', lineHeight:1.6, marginBottom:16 }}>{text}</div>
  );

  const input = (value: string, onChange: (v: string) => void, placeholder: string, mono = false): React.CSSProperties => ({});

  const btn = (color = '#ff8c00', disabled = false): React.CSSProperties => ({
    padding: '10px 22px', borderRadius: 10, border: `1px solid ${color}66`,
    background: disabled ? 'rgba(255,255,255,.04)' : `linear-gradient(135deg,rgba(${color === '#ff8c00' ? '255,140,0' : color === '#ff4444' ? '255,68,68' : '0,201,141'},.2),transparent)`,
    fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 900, letterSpacing: 1,
    color: disabled ? '#4a6a8a' : color, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? .6 : 1, transition: 'all .2s',
  });

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', borderRadius: 10,
    background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,140,0,.25)',
    fontFamily: 'Sora,sans-serif', fontSize: 13, color: '#e0f0ff',
    outline: 'none', caretColor: '#ff8c00',
  };

  const monoInputStyle: React.CSSProperties = {
    ...inputStyle,
    fontFamily: 'Orbitron,monospace', fontSize: 11,
  };

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(180deg,#060810 0%,#0a0e18 100%)' }}>
      <TopBar />
      <PageBackground />

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '40px 20px 80px' }}>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontFamily:'Orbitron,monospace', fontSize: 22, fontWeight:900,
            color:'#ff8c00', letterSpacing:2, marginBottom:6 }}>🔧 LB MINT ADMIN</div>
          <div style={{ fontFamily:'Sora,sans-serif', fontSize:13, color:'#5a7a9a' }}>
            Program: <span style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#8a9ab8' }}>{MINT_PROGRAM_ID}</span>
          </div>
        </div>

        {/* Not admin warning */}
        {publicKey && !isAdmin && (
          <div style={{ padding:'16px 20px', borderRadius:12, marginBottom:24,
            background:'rgba(255,50,50,.08)', border:'1px solid rgba(255,50,50,.3)',
            fontFamily:'Orbitron,monospace', fontSize:11, color:'#ff6666' }}>
            ⛔ CONNECTED WALLET IS NOT THE ADMIN — Read-only view
          </div>
        )}

        {!publicKey && (
          <div style={{ padding:'16px 20px', borderRadius:12, marginBottom:24,
            background:'rgba(255,140,0,.06)', border:'1px solid rgba(255,140,0,.2)',
            fontFamily:'Orbitron,monospace', fontSize:11, color:'#ff8c00' }}>
            🔌 Connect the admin wallet to use controls
          </div>
        )}

        {/* Status */}
        {status && (
          <div style={{ padding:'12px 16px', borderRadius:10, marginBottom:20,
            background: status.startsWith('✅') ? 'rgba(0,201,141,.08)' : status.startsWith('⏳') ? 'rgba(255,140,0,.08)' : 'rgba(255,50,50,.08)',
            border:`1px solid ${status.startsWith('✅') ? 'rgba(0,201,141,.3)' : status.startsWith('⏳') ? 'rgba(255,140,0,.3)' : 'rgba(255,50,50,.25)'}`,
            fontFamily:'Sora,sans-serif', fontSize:12,
            color: status.startsWith('✅') ? '#00c98d' : status.startsWith('⏳') ? '#ff8c00' : '#ff6666' }}
            dangerouslySetInnerHTML={{ __html: status }} />
        )}

        {/* ── LIVE STATE ── */}
        <div style={card()}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
            {sectionTitle('📊 LIVE PROGRAM STATE')}
            <button type="button" onClick={fetchState} disabled={loading}
              style={{ ...btn('#ff8c00', loading), padding:'6px 14px', fontSize:8 }}>
              {loading ? '…' : '↻ REFRESH'}
            </button>
          </div>

          {state ? (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {[
                { label:'Admin Wallet',   value: state.admin.slice(0,8) + '…' + state.admin.slice(-6),    color:'#ff8c00' },
                { label:'Treasury',       value: state.treasury.slice(0,8) + '…' + state.treasury.slice(-6), color:'#ffaa00' },
                { label:'LB Minted',      value: `${state.totalMinted.toFixed(2)} / 100,000 LB`,           color:'#00c98d' },
                { label:'Status',         value: state.paused ? '⏸ PAUSED' : '✅ ACTIVE',                  color: state.paused ? '#ff6666' : '#00c98d' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ padding:'12px 16px', borderRadius:10, background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.07)' }}>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#5a7a9a', letterSpacing:1.5, marginBottom:4 }}>{label}</div>
                  <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color }}>{value}</div>
                </div>
              ))}

              {/* Tier rates live display */}
              <div style={{ gridColumn:'1 / -1', padding:'14px 16px', borderRadius:10, background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.07)' }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#5a7a9a', letterSpacing:1.5, marginBottom:10 }}>CURRENT TIER RATES (ON-CHAIN)</div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
                  {state.tierRates.map((r, i) => (
                    <div key={i} style={{ textAlign:'center' }}>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:['#00d4ff','#bf5af2','#00c98d','#ff8c00'][i], marginBottom:3 }}>TIER {i+1}</div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:11, fontWeight:700, color:'#ff6a6a' }}>{r.brains} B/LB</div>
                      <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, color:'#ffaa00' }}>{(r.xntLamports / LAMPORTS_PER_SOL).toFixed(4)} XNT</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ fontFamily:'Sora,sans-serif', fontSize:13, color:'#5a7a9a' }}>
              {loading ? 'Loading…' : 'No state loaded'}
            </div>
          )}
        </div>

        {/* ── PAUSE / UNPAUSE ── */}
        <div style={card()}>
          {sectionTitle('⏸ EMERGENCY CONTROLS')}
          {desc('Stop or restart minting immediately. Use PAUSE if you detect suspicious activity or a bug — no one can mint while paused. Use UNPAUSE to restore normal operation. This does not affect existing LB balances.')}
          <div style={{ display:'flex', gap:12 }}>
            <button type="button" onClick={handlePause}
              disabled={pending || !isAdmin || state?.paused === true}
              style={btn('#ff4444', pending || !isAdmin || state?.paused === true)}>
              ⏸ PAUSE MINTING
            </button>
            <button type="button" onClick={handleUnpause}
              disabled={pending || !isAdmin || state?.paused === false}
              style={btn('#00c98d', pending || !isAdmin || state?.paused === false)}>
              ▶ UNPAUSE MINTING
            </button>
          </div>
          {state?.paused && (
            <div style={{ marginTop:12, padding:'8px 14px', borderRadius:8, background:'rgba(255,68,68,.08)', border:'1px solid rgba(255,68,68,.2)',
              fontFamily:'Orbitron,monospace', fontSize:9, color:'#ff6666' }}>
              ⚠️ MINTING IS CURRENTLY PAUSED
            </div>
          )}
        </div>

        {/* ── TIER RATES ── */}
        <div style={card()}>
          {sectionTitle('💰 UPDATE MINT PRICING')}
          {desc('Adjust how many BRAINS and how much XNT each LB costs per tier. Use this when XNT gets expensive or cheap — lower the XNT fee if it becomes a barrier for minters. BRAINS rate changes affect mint economics. All changes take effect immediately after the transaction confirms.')}

          <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:14, marginBottom:18 }}>
            {tierEdits.map((t, i) => (
              <div key={i} style={{ padding:'16px', borderRadius:12, background:'rgba(255,255,255,.03)',
                border:`1px solid ${['rgba(0,212,255,.15)','rgba(191,90,242,.15)','rgba(0,201,141,.15)','rgba(255,140,0,.15)'][i]}` }}>
                <div style={{ fontFamily:'Orbitron,monospace', fontSize:10, fontWeight:900,
                  color:['#00d4ff','#bf5af2','#00c98d','#ff8c00'][i], marginBottom:12 }}>
                  TIER {i+1} — {['1–25,000','25,001–50,000','50,001–75,000','75,001–100,000'][i]} LB
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  <div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#5a7a9a', letterSpacing:1.5, marginBottom:4 }}>
                      BRAINS PER LB — how many BRAINS to burn for 1 LB
                    </div>
                    <input
                      type="number" min={1} step={1} value={t.brains}
                      onChange={e => {
                        const n = [...tierEdits];
                        n[i] = { ...n[i], brains: e.target.value };
                        setTierEdits(n);
                      }}
                      style={monoInputStyle}
                    />
                  </div>
                  <div>
                    <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#5a7a9a', letterSpacing:1.5, marginBottom:4 }}>
                      XNT FEE PER LB — platform fee in XNT (e.g. 0.50 = half an XNT)
                    </div>
                    <input
                      type="number" min={0} max={10} step={0.01} value={t.xnt}
                      onChange={e => {
                        const n = [...tierEdits];
                        n[i] = { ...n[i], xnt: e.target.value };
                        setTierEdits(n);
                      }}
                      style={monoInputStyle}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Preview */}
          <div style={{ padding:'12px 16px', borderRadius:10, background:'rgba(255,140,0,.04)', border:'1px solid rgba(255,140,0,.1)', marginBottom:16 }}>
            <div style={{ fontFamily:'Orbitron,monospace', fontSize:7, color:'#5a7a9a', letterSpacing:1.5, marginBottom:8 }}>PREVIEW — WHAT WILL BE SAVED ON-CHAIN</div>
            <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
              {tierEdits.map((t, i) => (
                <div key={i} style={{ fontFamily:'Orbitron,monospace', fontSize:9 }}>
                  <span style={{ color:['#00d4ff','#bf5af2','#00c98d','#ff8c00'][i] }}>T{i+1}:</span>
                  <span style={{ color:'#ff6a6a', marginLeft:4 }}>{t.brains} B</span>
                  <span style={{ color:'#5a7a9a', margin:'0 4px' }}>+</span>
                  <span style={{ color:'#ffaa00' }}>{t.xnt} XNT</span>
                </div>
              ))}
            </div>
          </div>

          <button type="button" onClick={handleUpdateTierRates}
            disabled={pending || !isAdmin}
            style={btn('#ff8c00', pending || !isAdmin)}>
            💾 SAVE TIER RATES ON-CHAIN
          </button>
        </div>

        {/* ── METADATA URI ── */}
        <div style={card()}>
          {sectionTitle('🔗 UPDATE TOKEN METADATA URI')}
          {desc('Change the Arweave/IPFS link that points to the LB token metadata JSON (name, symbol, logo, description). Use this if the current link breaks or you re-upload the metadata. The JSON at the new URL must be valid — explorers and wallets fetch it to show the token logo and name.')}
          <input
            type="text"
            value={newUri}
            onChange={e => setNewUri(e.target.value)}
            placeholder="https://arweave.net/<TX_ID>"
            style={{ ...inputStyle, marginBottom:14 }}
          />
          <div style={{ fontFamily:'Sora,sans-serif', fontSize:11, color:'#5a7a9a', marginBottom:14 }}>
            Current URI: <span style={{ color:'#8aaac0', fontFamily:'Orbitron,monospace', fontSize:9 }}>
              {state ? 'https://arweave.net/gKd6Z_lgNccfnvX_rgOLRRIvecppjC8FsC0a1Xel2NE' : '…'}
            </span>
          </div>
          <button type="button" onClick={handleUpdateUri}
            disabled={pending || !isAdmin || !newUri.trim()}
            style={btn('#ff8c00', pending || !isAdmin || !newUri.trim())}>
            🔗 UPDATE METADATA URI
          </button>
        </div>

        {/* ── TRANSFER ADMIN ── */}
        <div style={card({ border:'1px solid rgba(255,68,68,.2)' })}>
          {sectionTitle('👤 TRANSFER ADMIN AUTHORITY', '#ff4444')}
          {desc('Transfer admin control to a different wallet. This is IRREVERSIBLE — once confirmed, the current wallet loses all admin access. Double-check the new address before signing. This does NOT affect the program upgrade authority.')}
          <input
            type="text"
            value={newAdmin}
            onChange={e => setNewAdmin(e.target.value)}
            placeholder="New admin wallet address (base58)"
            style={{ ...monoInputStyle, marginBottom:14 }}
          />
          {newAdmin && (
            <div style={{ padding:'10px 14px', borderRadius:8, background:'rgba(255,68,68,.06)', border:'1px solid rgba(255,68,68,.2)',
              fontFamily:'Sora,sans-serif', fontSize:12, color:'#ff8888', marginBottom:14 }}>
              ⚠️ You are about to transfer admin to: <strong style={{ fontFamily:'Orbitron,monospace', fontSize:10 }}>{newAdmin}</strong>
              <br />After confirming, your current wallet will have no admin access.
            </div>
          )}
          <button type="button" onClick={handleUpdateAdmin}
            disabled={pending || !isAdmin || !newAdmin.trim()}
            style={btn('#ff4444', pending || !isAdmin || !newAdmin.trim())}>
            ⚠️ TRANSFER ADMIN — IRREVERSIBLE
          </button>
        </div>

        {/* ── COLLECT FEES ── */}
        <div style={card()}>
          {sectionTitle('💎 COLLECT TRANSFER FEES')}
          {desc('LB tokens have a 0.04% transfer fee on every transaction. These fees accumulate in the mint account. Click this button to sweep all withheld fees into the treasury LB ATA. This is permissionless — anyone can call it — but it\'s here for convenience. Run this periodically.')}
          <div style={{ padding:'10px 14px', borderRadius:8, background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.07)',
            fontFamily:'Orbitron,monospace', fontSize:9, color:'#8aaac0', marginBottom:14 }}>
            Transfer fee: 4 bps (0.04%) · Treasury LB ATA: {TREASURY_WALLET.slice(0,8)}…{TREASURY_WALLET.slice(-6)}
          </div>
          <button type="button" onClick={handleCollectFees}
            disabled={pending || !isAdmin}
            style={btn('#00c98d', pending || !isAdmin)}>
            💎 SWEEP FEES TO TREASURY
          </button>
        </div>

        {/* ── PROGRAM INFO ── */}
        <div style={card()}>
          {sectionTitle('ℹ️ PROGRAM ADDRESSES')}
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {[
              { label:'Program ID',          value: MINT_PROGRAM_ID },
              { label:'GlobalState PDA',      value: statePda.toBase58() },
              { label:'Mint Authority PDA',   value: mintAuthPda.toBase58() },
              { label:'LB Mint PDA',          value: lbMintPda.toBase58() },
              { label:'Admin Wallet',         value: ADMIN_WALLET },
              { label:'Treasury Wallet',      value: TREASURY_WALLET },
            ].map(({ label, value }) => (
              <div key={label} style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                padding:'9px 14px', borderRadius:8, background:'rgba(255,255,255,.03)', border:'1px solid rgba(255,255,255,.06)' }}>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:8, color:'#5a7a9a', letterSpacing:1 }}>{label}</span>
                <span style={{ fontFamily:'Orbitron,monospace', fontSize:9, color:'#8aaac0',
                  cursor:'pointer', userSelect:'all' }}
                  onClick={() => navigator.clipboard.writeText(value)}
                  title="Click to copy">
                  {value.slice(0,8)}…{value.slice(-6)} 📋
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>
      <Footer />
    </div>
  );
};

export default MintAdmin;
