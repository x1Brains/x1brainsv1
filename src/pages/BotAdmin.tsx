// src/pages/BotAdmin.tsx
// Route: /x9b7r41ns/bot   (matches the obfuscated admin URL pattern)
// X1 Brains Telegram Bot — Admin Console
//
// Uses your existing adminFetch() pattern from src/lib/supabase.ts:
//   - Frontend → /api/admin (Vercel) → Supabase + Telegram
//   - Telegram token NEVER hits the browser bundle
//   - Admin wallet check happens in /api/admin proxy (server-side)
//
// Before using:
//   1. Run SUPABASE_SCHEMA.sql in your Supabase SQL Editor
//   2. Add bot actions to your /api/admin proxy (see api_bot-actions.ts)
//   3. Append helpers to src/lib/supabase.ts (see supabase_bot_additions.ts)
//   4. Set SUPABASE_SERVICE_KEY env var in Vercel project settings

import React, { FC, useState, useEffect, useCallback, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { TopBar, PageBackground, Footer } from '../components/UI';
import {
  setAdminWallet,
  botGetSettings, botSaveSettings,
  botGetConnection, botSaveTelegramToken, botSaveChat,
  botTestTelegram, botDetectChats, botDetectVaults, botSendTestMessage,
  botUploadBanner, botGetBannerUrl,
  type BotSettings, type BotConnection, type BotChat,
} from '../lib/supabase';

const ADMIN_WALLET = '2nVaSvCqrsdskcbtn47uquNDL7Q69To1k45FpYBvWnuC';

type EventKey = 'buys' | 'burns' | 'lp' | 'stake' | 'unstake' | 'claim';

const EVENT_DEFS: { key: EventKey; icon: string; label: string; desc: string }[] = [
  { key: 'buys',    icon: '🟢', label: 'BUYS',     desc: 'XDEX swap into the token' },
  { key: 'burns',   icon: '🔥', label: 'BURNS',    desc: 'Token-2022 burn or → incinerator' },
  { key: 'lp',      icon: '💧', label: 'LP PAIRS', desc: 'New LP created via pairing program' },
  { key: 'stake',   icon: '🌾', label: 'STAKES',   desc: 'LP locked into farm (30/90/365 d)' },
  { key: 'unstake', icon: '📤', label: 'UNSTAKES', desc: 'LP withdrawn from farm' },
  { key: 'claim',   icon: '💰', label: 'CLAIMS',   desc: 'Farm rewards harvested' },
];

const BotAdmin: FC = () => {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const isAdminWallet = publicKey?.toBase58() === ADMIN_WALLET;

  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [connection, setConnection] = useState<BotConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const flash = (type: 'ok' | 'err' | 'info', text: string) => {
    setStatusMsg({ type, text });
    setTimeout(() => setStatusMsg(null), type === 'err' ? 8000 : 4000);
  };

  // Wire wallet pubkey into adminFetch's header on every change
  useEffect(() => {
    if (publicKey && isAdminWallet) {
      setAdminWallet(publicKey.toBase58());
    } else {
      setAdminWallet('');
    }
  }, [publicKey, isAdminWallet]);

  const loadAll = useCallback(async () => {
    setBusy(true);
    flash('info', '🔑 Loading config…');
    try {
      const [s, c] = await Promise.all([botGetSettings(), botGetConnection()]);
      if (s) setSettings(s);
      if (c) setConnection(c);
      flash('ok', '✅ Loaded');
    } catch (e: any) {
      flash('err', `❌ ${e?.message || 'load failed'}`);
    } finally { setBusy(false); }
  }, []);

  const refreshConnection = async () => {
    const c = await botGetConnection();
    if (c) setConnection(c);
  };

  const saveSettings = async (updates: Partial<BotSettings>) => {
    setBusy(true);
    try {
      const r = await botSaveSettings(updates);
      if (!r.success) throw new Error(r.error || 'save failed');
      setSettings(s => s ? { ...s, ...updates } as BotSettings : s);
      flash('ok', '✅ Saved');
    } catch (e: any) {
      flash('err', `❌ ${e?.message || 'save failed'}`);
    } finally { setBusy(false); }
  };

  const saveTelegramToken = async (token: string) => {
    setBusy(true); flash('info', '🔍 Verifying token…');
    try {
      const r = await botSaveTelegramToken(token);
      if (!r.success) throw new Error(r.error || 'verify failed');
      flash('ok', `✅ Connected as @${r.data?.bot?.username || 'bot'}`);
      await refreshConnection();
    } catch (e: any) { flash('err', `❌ ${e?.message}`); }
    finally { setBusy(false); }
  };

  const saveChatId = async (chat_id: string, chat_title: string) => {
    setBusy(true);
    try {
      const r = await botSaveChat(chat_id, chat_title);
      if (!r.success) throw new Error(r.error || 'save failed');
      flash('ok', `✅ Chat set: ${chat_title || chat_id}`);
      await refreshConnection();
    } catch (e: any) { flash('err', `❌ ${e?.message}`); }
    finally { setBusy(false); }
  };

  const detectChats = async (): Promise<BotChat[]> => {
    setBusy(true); flash('info', '🔍 Looking for chats…');
    try {
      const list = await botDetectChats();
      if (list.length === 0) flash('info', 'ℹ️ No groups yet — add bot to group as admin, send a message there, then click Detect again');
      else flash('ok', `✅ Found ${list.length} chat(s)`);
      return list;
    } catch (e: any) { flash('err', `❌ ${e?.message}`); return []; }
    finally { setBusy(false); }
  };

  const detectVaults = async (token: 'BRAINS' | 'LB') => {
    setBusy(true); flash('info', `🔍 Reading on-chain ${token} pool data…`);
    try {
      const r = await botDetectVaults(token);
      if (!r.success) throw new Error(r.error || 'detection failed');
      flash('ok', `✅ ${token} vaults detected`);
      await refreshConnection();
    } catch (e: any) { flash('err', `❌ ${e?.message}`); }
    finally { setBusy(false); }
  };

  const testTelegram = async () => {
    setBusy(true); flash('info', '📨 Sending test…');
    try {
      const r = await botTestTelegram();
      if (!r.success) throw new Error(r.error || 'send failed');
      flash('ok', r.data?.sent ? '✅ Test message sent' : 'ℹ️ Token works, no chat selected');
    } catch (e: any) { flash('err', `❌ ${e?.message}`); }
    finally { setBusy(false); }
  };

  const uploadBanner = async (token: 'BRAINS' | 'LB', file: File) => {
    if (file.size > 5 * 1024 * 1024) { flash('err', '❌ Image too large (max 5MB)'); return; }
    setBusy(true); flash('info', `📤 Uploading ${token} banner…`);
    try {
      const r = await botUploadBanner(token, file);
      if (!r.success) throw new Error(r.error || 'upload failed');
      flash('ok', `✅ ${token} banner updated`);
    } catch (e: any) { flash('err', `❌ ${e?.message}`); }
    finally { setBusy(false); }
  };

  const sendTest = async (token: 'BRAINS' | 'LB') => {
    setBusy(true); flash('info', `📨 Sending test for ${token}…`);
    try {
      const r = await botSendTestMessage(token);
      if (!r.success) throw new Error(r.error || 'send failed');
      flash('ok', `✅ Sent`);
    } catch (e: any) { flash('err', `❌ ${e?.message}`); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (connected && isAdminWallet && !settings) loadAll();
  }, [connected, isAdminWallet, settings, loadAll]);

  // ─────────────────────────────────────────────────────────────────────────
  // GATES
  // ─────────────────────────────────────────────────────────────────────────
  if (!connected) {
    return (
      <div style={{ minHeight: '100vh', background: '#080c10',
        padding: '90px 24px 40px', position: 'relative', overflow: 'hidden' }}>
        <TopBar />
        <PageBackground />
        <GateScreen icon="🔒" color="#ff8c00" title="ADMIN ACCESS REQUIRED"
          subtitle="Connect the X1 Brains admin wallet to manage the @x1brains buy bot.">
          <div style={{ marginTop: 24 }}>
            <button onClick={() => setVisible(true)}
              style={{ padding: '12px 32px', background: 'linear-gradient(135deg,#ff8c00,#ffb700)',
                border: 'none', borderRadius: 10, color: '#04060f',
                fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 800,
                letterSpacing: 2, cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(255,140,0,0.3)' }}>
              CONNECT WALLET
            </button>
          </div>
          <div style={{ marginTop: 28, fontFamily: 'monospace', fontSize: 9,
            color: '#5c7a90', letterSpacing: 1, opacity: 0.7 }}>
            ADMIN: {ADMIN_WALLET.slice(0, 10)}…{ADMIN_WALLET.slice(-8)}
          </div>
        </GateScreen>
        <Footer />
      </div>
    );
  }

  if (!isAdminWallet) {
    return (
      <div style={{ minHeight: '100vh', background: '#080c10',
        padding: '90px 24px 40px', position: 'relative', overflow: 'hidden' }}>
        <TopBar />
        <PageBackground />
        <GateScreen icon="⛔" color="#ff4466" title="UNAUTHORIZED WALLET"
          subtitle="Connected wallet does not match admin wallet.">
          <div style={{ marginTop: 18, padding: '14px 18px',
            background: 'rgba(255,68,102,0.06)', border: '1px solid rgba(255,68,102,0.25)',
            borderRadius: 10, fontFamily: 'monospace', fontSize: 10, color: '#9abacf' }}>
            <div style={{ marginBottom: 6 }}><span style={{ color: '#ff4466' }}>✗ Connected:</span>{' '}
              {publicKey?.toBase58().slice(0, 10)}…{publicKey?.toBase58().slice(-8)}</div>
            <div><span style={{ color: '#39ff88' }}>✓ Required:</span>{' '}
              {ADMIN_WALLET.slice(0, 10)}…{ADMIN_WALLET.slice(-8)}</div>
          </div>
        </GateScreen>
        <Footer />
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN UI
  // ─────────────────────────────────────────────────────────────────────────
  const enabledCount = settings ? EVENT_DEFS.reduce((acc, e) =>
    acc + (settings[`brains_${e.key}` as keyof BotSettings] ? 1 : 0)
        + (settings[`lb_${e.key}` as keyof BotSettings] ? 1 : 0), 0) : 0;

  return (
    <div style={{ minHeight: '100vh', background: '#080c10',
      padding: '90px 24px 40px', position: 'relative', overflow: 'hidden' }}>
      <TopBar />
      <PageBackground />
      <div style={{ maxWidth: 1100, margin: '0 auto 80px', padding: '0 16px',
        position: 'relative', zIndex: 1 }}>

        {/* HERO */}
        <div style={{ position: 'relative', marginBottom: 28, padding: '24px 28px',
          background: 'linear-gradient(160deg,#040810,#0a0612,#08040e)',
          border: '1px solid rgba(255,140,0,0.2)',
          borderTop: '2px solid rgba(255,140,0,0.45)',
          borderRadius: 18, overflow: 'hidden' }}>
          <GridOverlay color="rgba(255,140,0,0.04)" />
          <div style={{ position: 'absolute', top: -80, right: -80, width: 240, height: 240,
            borderRadius: '50%', background: 'radial-gradient(circle,rgba(255,140,0,0.18) 0%,transparent 70%)',
            pointerEvents: 'none' }} />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 44, filter: 'drop-shadow(0 0 16px rgba(255,140,0,0.6))' }}>🤖</div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8, fontWeight: 700,
                letterSpacing: 4, color: '#ff8c0099', marginBottom: 4 }}>
                X1 BRAINS · TELEGRAM CONSOLE
              </div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 26, fontWeight: 900,
                letterSpacing: 4, color: '#fff', textShadow: '0 0 20px rgba(255,140,0,0.4)' }}>
                BOT ADMIN
              </div>
              <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 12, color: '#7a9ab8',
                marginTop: 6, lineHeight: 1.5 }}>
                Configure event filters, banner imagery, and posting thresholds for the
                @x1brains buy bot.
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
              <StatusPill label="CONNECTION"
                value={connection?.complete ? 'CONFIGURED' : (connection ? 'NEEDS SETUP' : '…')}
                color={connection?.complete ? '#39ff88' : (connection ? '#ffb700' : '#7a9ab8')}
                pulsing={connection ? !connection.complete : false} />
              <StatusPill label="EVENTS ENABLED"
                value={settings ? `${enabledCount}/12` : '—'} color="#00d4ff" />
              <StatusPill label="ADMIN WALLET" value="VERIFIED" color="#bf5af2" pulsing />
            </div>
          </div>
        </div>

        {/* TOAST */}
        {statusMsg && (
          <div style={{ position: 'sticky', top: 16, zIndex: 50, marginBottom: 16,
            padding: '12px 18px', borderRadius: 10,
            background: statusMsg.type === 'err' ? 'rgba(255,68,102,0.08)' :
                       statusMsg.type === 'ok'  ? 'rgba(57,255,136,0.08)' :
                                                  'rgba(0,212,255,0.06)',
            border: `1px solid ${statusMsg.type === 'err' ? 'rgba(255,68,102,0.4)' :
                                  statusMsg.type === 'ok'  ? 'rgba(57,255,136,0.4)' :
                                                              'rgba(0,212,255,0.3)'}`,
            color: statusMsg.type === 'err' ? '#ff8899' :
                   statusMsg.type === 'ok'  ? '#39ff88' : '#9bdfff',
            fontFamily: 'Sora,sans-serif', fontSize: 12, fontWeight: 500,
            backdropFilter: 'blur(12px)', animation: 'admToast 0.25s ease both' }}>
            {statusMsg.text}
          </div>
        )}

        {/* CONNECTION */}
        {connection && (
          <ConnectionPanel
            connection={connection} busy={busy}
            onSaveTelegramToken={saveTelegramToken}
            onSaveChatId={saveChatId}
            onDetectChats={detectChats}
            onDetectVaults={detectVaults}
            onTestTelegram={testTelegram} />
        )}

        {/* TOKEN PANELS */}
        {settings && (
          <div style={{ display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(440px,1fr))',
            gap: 20, marginBottom: 24 }}>
            <TokenPanel token="BRAINS" icon="🧠" colorMain="#ff8c00" colorAccent="#ffb700"
              colorRgba="255,140,0" settings={settings} busy={busy}
              onToggle={(key, val) => saveSettings({ [`brains_${key}`]: val } as any)}
              onBannerUpload={(f) => uploadBanner('BRAINS', f)}
              onSendTest={() => sendTest('BRAINS')} />
            <TokenPanel token="LB" icon="🧪" colorMain="#00c98d" colorAccent="#39ff88"
              colorRgba="0,201,141" settings={settings} busy={busy}
              onToggle={(key, val) => saveSettings({ [`lb_${key}`]: val } as any)}
              onBannerUpload={(f) => uploadBanner('LB', f)}
              onSendTest={() => sendTest('LB')} />
          </div>
        )}

        {/* THRESHOLDS */}
        {settings && <ThresholdsPanel settings={settings} busy={busy} onSave={saveSettings} />}

        {/* INFO */}
        <div style={{ marginTop: 30, padding: '18px 22px',
          background: 'rgba(140,60,255,0.04)', border: '1px solid rgba(140,60,255,0.15)',
          borderRadius: 12, fontFamily: 'Sora,sans-serif', fontSize: 11,
          color: '#9abacf', lineHeight: 1.7 }}>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#cc88ff',
            letterSpacing: 2, marginBottom: 8 }}>ⓘ HOW IT WORKS</div>
          Token + chat config are stored in Supabase, never in your repo or browser bundle.
          The bot loop runs on Fly.io and pulls config on each poll. Your existing
          <code style={ic}> /api/admin</code> proxy gates all writes via wallet check.
        </div>
      </div>

      <style>{`
        @keyframes admToast { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes admPulse { 0%,100% { opacity: 1; box-shadow: 0 0 0 0 currentColor; } 50% { opacity: 0.85; box-shadow: 0 0 0 4px transparent; } }
        @keyframes admFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <Footer />
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// SUBCOMPONENTS
// ═════════════════════════════════════════════════════════════════════════════
const GateScreen: FC<{ icon: string; color: string; title: string; subtitle: string; children?: React.ReactNode }> =
  ({ icon, color, title, subtitle, children }) => (
  <div style={{ maxWidth: 520, margin: '120px auto', padding: '40px 32px',
    background: 'linear-gradient(160deg,#040810,#0a0612,#08040e)',
    border: `1px solid ${color}33`, borderTop: `2px solid ${color}66`,
    borderRadius: 18, textAlign: 'center', position: 'relative', overflow: 'hidden',
    boxShadow: `0 0 40px ${color}11` }}>
    <GridOverlay color={`${color}08`} />
    <div style={{ position: 'absolute', top: -50, right: -50, width: 160, height: 160,
      borderRadius: '50%', background: `radial-gradient(circle,${color}22,transparent 70%)`,
      pointerEvents: 'none' }} />
    <div style={{ position: 'relative' }}>
      <div style={{ fontSize: 64, marginBottom: 16, filter: `drop-shadow(0 0 20px ${color}99)` }}>{icon}</div>
      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18, fontWeight: 900,
        letterSpacing: 4, color, marginBottom: 12 }}>{title}</div>
      <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 13, color: '#7a9ab8',
        lineHeight: 1.6, maxWidth: 360, margin: '0 auto' }}>{subtitle}</div>
      {children}
    </div>
  </div>
);

const GridOverlay: FC<{ color: string }> = ({ color }) => (
  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
    backgroundImage: `linear-gradient(${color} 1px, transparent 1px),
                      linear-gradient(90deg, ${color} 1px, transparent 1px)`,
    backgroundSize: '24px 24px', opacity: 0.6 }} />
);

const StatusPill: FC<{ label: string; value: string; color: string; pulsing?: boolean }> =
  ({ label, value, color, pulsing }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 14px', background: `${color}10`, border: `1px solid ${color}30`,
    borderRadius: 8 }}>
    <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, color,
      animation: pulsing ? 'admPulse 2s ease infinite' : 'none' }} />
    <div style={{ flex: 1 }}>
      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 7, color: `${color}aa`,
        letterSpacing: 2, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 800,
        color, letterSpacing: 1.5 }}>{value}</div>
    </div>
  </div>
);

// ─── ConnectionPanel ─────────────────────────────────────────────────────────
const ConnectionPanel: FC<{
  connection: BotConnection; busy: boolean;
  onSaveTelegramToken: (t: string) => Promise<void>;
  onSaveChatId: (id: string, title: string) => Promise<void>;
  onDetectChats: () => Promise<BotChat[]>;
  onDetectVaults: (t: 'BRAINS' | 'LB') => Promise<void>;
  onTestTelegram: () => Promise<void>;
}> = ({ connection, busy, onSaveTelegramToken, onSaveChatId, onDetectChats, onDetectVaults, onTestTelegram }) => {
  const [tokenDraft, setTokenDraft] = useState('');
  const [editingToken, setEditingToken] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [chats, setChats] = useState<BotChat[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);

  const hasToken = !!connection.telegram_token_masked;
  const hasChat = !!connection.chat_id;
  const brainsVaults = !!connection.vaults.BRAINS.vault_token;
  const lbVaults = !!connection.vaults.LB.vault_token;

  const handleDetectChats = async () => {
    const list = await onDetectChats();
    setChats(list);
    setChatsLoaded(true);
  };

  const isComplete = connection.complete;
  const baseColor = isComplete ? '#39ff88' : '#ffb700';
  const baseRgba = isComplete ? '57,255,136' : '255,183,0';

  return (
    <div style={{ position: 'relative', overflow: 'hidden', marginBottom: 24,
      background: 'linear-gradient(160deg,#040810,#0a0612,#08040e)',
      border: `1px solid rgba(${baseRgba},0.18)`,
      borderTop: `2px solid rgba(${baseRgba},0.5)`,
      borderRadius: 16, padding: '22px 24px',
      boxShadow: `0 0 30px rgba(${baseRgba},0.05)`,
      animation: 'admFadeUp 0.4s ease both' }}>
      <GridOverlay color={`rgba(${baseRgba},0.04)`} />
      <div style={{ position: 'absolute', top: -50, right: -50, width: 180, height: 180,
        borderRadius: '50%',
        background: `radial-gradient(circle,rgba(${baseRgba},0.10),transparent 70%)`,
        pointerEvents: 'none' }} />

      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <div style={{ fontSize: 28, filter: `drop-shadow(0 0 12px ${baseColor}99)` }}>
            {isComplete ? '🔌' : '⚠️'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 16, fontWeight: 900,
              letterSpacing: 3, color: baseColor }}>CONNECTION</div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#7a9ab8' }}>
              {isComplete
                ? 'All systems wired — bot is broadcasting to your group.'
                : 'Set up Telegram + pool vaults to start broadcasting events.'}
            </div>
          </div>
          {isComplete && (
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: '#39ff88',
              background: 'rgba(57,255,136,0.1)', border: '1px solid rgba(57,255,136,0.3)',
              padding: '5px 10px', borderRadius: 6, letterSpacing: 1.5, fontWeight: 800 }}>
              ✓ READY
            </div>
          )}
        </div>

        <div style={{ height: 1, margin: '14px 0 16px',
          background: `linear-gradient(90deg,transparent,${baseColor}40,transparent)` }} />

        {/* Step 1 */}
        <ConnStep number={1} title="TELEGRAM BOT TOKEN" done={hasToken}
          help={<div style={{ fontSize: 11, color: '#7a9ab8', lineHeight: 1.6 }}>
            Open <a href="https://t.me/BotFather" target="_blank" rel="noopener"
              style={{ color: '#00d4ff', textDecoration: 'none' }}>@BotFather</a> →
            send <code style={cdc}>/newbot</code> → follow prompts → paste the token below.
            <br/><b>Important:</b> The token is sent encrypted to Supabase and never stored
            in your code or browser.
          </div>}>
          {hasToken && !editingToken && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, padding: '10px 14px',
                background: 'rgba(57,255,136,0.06)',
                border: '1px solid rgba(57,255,136,0.2)',
                borderRadius: 8, fontFamily: 'monospace', fontSize: 12, color: '#9abacf' }}>
                {connection.telegram_token_masked}
              </div>
              <button onClick={() => { setEditingToken(true); setTokenDraft(''); }} disabled={busy}
                style={btnGhost('#ffb700', '255,183,0', busy)}>✏️ CHANGE</button>
            </div>
          )}
          {(!hasToken || editingToken) && (
            <div style={{ display: 'flex', gap: 8, marginTop: hasToken ? 8 : 0 }}>
              <input type={showToken ? 'text' : 'password'} value={tokenDraft}
                onChange={e => setTokenDraft(e.target.value)}
                placeholder="123456789:AAH8jK9_xxxxxxxxx_yyyyyyyy"
                disabled={busy} autoComplete="off"
                style={{ flex: 1, padding: '10px 14px', background: '#04030a',
                  border: '1px solid rgba(255,183,0,0.3)', borderRadius: 8,
                  fontFamily: 'monospace', fontSize: 12, color: '#fff', outline: 'none' }} />
              <button onClick={() => setShowToken(s => !s)} disabled={busy}
                style={{ ...btnGhost('#7a9ab8', '122,154,184', busy), padding: '9px 14px' }}>
                {showToken ? '🙈 HIDE' : '👁 SHOW'}
              </button>
              {hasToken && (
                <button onClick={() => { setEditingToken(false); setTokenDraft(''); }} disabled={busy}
                  style={{ ...btnGhost('#7a9ab8', '122,154,184', busy), padding: '9px 14px' }}>
                  ✕ CANCEL
                </button>
              )}
              <button onClick={async () => {
                const t = tokenDraft.trim(); if (!t) return;
                await onSaveTelegramToken(t);
                setTokenDraft(''); setEditingToken(false);
              }} disabled={busy || !tokenDraft.trim()}
                style={btn('#ffb700', '255,183,0', busy || !tokenDraft.trim())}>
                💾 SAVE & VERIFY
              </button>
            </div>
          )}
        </ConnStep>

        {/* Step 2 */}
        <ConnStep number={2} title="TELEGRAM GROUP / CHANNEL" done={hasChat}
          help={<div style={{ fontSize: 11, color: '#7a9ab8', lineHeight: 1.6 }}>
            Add your bot to your group as <b>admin</b>, send any message in the group,
            then click <b>Detect</b> to list every chat your bot is in.
          </div>}>
          {hasChat ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, padding: '10px 14px',
                background: 'rgba(57,255,136,0.06)',
                border: '1px solid rgba(57,255,136,0.2)',
                borderRadius: 8, fontFamily: 'Sora,sans-serif', fontSize: 12 }}>
                <div style={{ color: '#d4e0ec', fontWeight: 600 }}>
                  {connection.chat_title || '(no title)'}
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 10,
                  color: '#7a9ab8', marginTop: 2 }}>
                  ID: {connection.chat_id}
                </div>
              </div>
              <button onClick={onTestTelegram} disabled={busy}
                style={btn('#00d4ff', '0,212,255', busy)}>📨 TEST POST</button>
              <button onClick={handleDetectChats} disabled={busy}
                style={btnGhost('#ffb700', '255,183,0', busy)}>🔍 RE-DETECT</button>
            </div>
          ) : (
            <div>
              {!chatsLoaded && (
                <button onClick={handleDetectChats} disabled={busy || !hasToken}
                  style={btn('#ffb700', '255,183,0', busy || !hasToken)}>
                  🔍 DETECT AVAILABLE GROUPS
                </button>
              )}
              {chatsLoaded && chats.length === 0 && (
                <div style={{ padding: '14px 16px', borderRadius: 8,
                  background: 'rgba(255,68,102,0.06)',
                  border: '1px solid rgba(255,68,102,0.2)',
                  fontSize: 11, color: '#ff8899', lineHeight: 1.6 }}>
                  No chats found. Add bot as admin, send a message in the group, then:
                  <div style={{ marginTop: 8 }}>
                    <button onClick={handleDetectChats} disabled={busy}
                      style={btnGhost('#ffb700', '255,183,0', busy)}>
                      🔄 TRY AGAIN
                    </button>
                  </div>
                </div>
              )}
              {chatsLoaded && chats.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {chats.map(chat => (
                    <div key={String(chat.id)}
                      onClick={() => !busy && onSaveChatId(String(chat.id), chat.title)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 14px', borderRadius: 8,
                        cursor: busy ? 'wait' : 'pointer',
                        background: 'rgba(255,183,0,0.04)',
                        border: '1px solid rgba(255,183,0,0.18)',
                        transition: 'all 0.15s' }}
                      onMouseEnter={e => { if (!busy) e.currentTarget.style.background = 'rgba(255,183,0,0.1)'; }}
                      onMouseLeave={e => { if (!busy) e.currentTarget.style.background = 'rgba(255,183,0,0.04)'; }}>
                      <div style={{ fontSize: 18 }}>{chat.type === 'channel' ? '📢' : '👥'}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11,
                          fontWeight: 700, color: '#d4e0ec', letterSpacing: 1 }}>
                          {chat.title}
                          {chat.username && <span style={{ color: '#00d4ff', marginLeft: 8 }}>
                            @{chat.username}
                          </span>}
                        </div>
                        <div style={{ fontFamily: 'monospace', fontSize: 10,
                          color: '#7a9ab8', marginTop: 2 }}>
                          {chat.type} · {chat.id}
                        </div>
                      </div>
                      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9,
                        color: '#ffb700', letterSpacing: 1.5, fontWeight: 700 }}>SELECT →</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </ConnStep>

        {/* Step 3 */}
        <ConnStep number={3} title="POOL VAULTS" done={brainsVaults && lbVaults}
          help={<div style={{ fontSize: 11, color: '#7a9ab8', lineHeight: 1.6 }}>
            Click <b>Auto-detect</b> for each pool — we'll read the vault accounts
            straight from on-chain XDEX pool data.
          </div>}>
          <div style={{ display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 12 }}>
            <VaultRow token="BRAINS" emoji="🧠" color="#ff8c00" colorRgba="255,140,0"
              vaults={connection.vaults.BRAINS}
              poolAddr={connection.mints.BRAINS?.pool}
              onDetect={() => onDetectVaults('BRAINS')} busy={busy} />
            <VaultRow token="LB" emoji="🧪" color="#00c98d" colorRgba="0,201,141"
              vaults={connection.vaults.LB}
              poolAddr={connection.mints.LB?.pool}
              onDetect={() => onDetectVaults('LB')} busy={busy} />
          </div>
        </ConnStep>
      </div>
    </div>
  );
};

const ConnStep: FC<{ number: number; title: string; done: boolean;
  help?: React.ReactNode; children: React.ReactNode }> =
  ({ number, title, done, help, children }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
      <div style={{ width: 22, height: 22, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 900,
        background: done ? '#39ff88' : 'rgba(255,183,0,0.2)',
        color: done ? '#0a0e14' : '#ffb700',
        border: `1px solid ${done ? '#39ff88' : 'rgba(255,183,0,0.4)'}`,
        boxShadow: done ? '0 0 10px rgba(57,255,136,0.4)' : 'none' }}>
        {done ? '✓' : number}
      </div>
      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 800,
        letterSpacing: 2, color: done ? '#39ff88' : '#d4e0ec' }}>{title}</div>
    </div>
    {help && <div style={{ marginLeft: 32, marginBottom: 10 }}>{help}</div>}
    <div style={{ marginLeft: 32 }}>{children}</div>
  </div>
);

const VaultRow: FC<{ token: string; emoji: string; color: string; colorRgba: string;
  vaults: { vault_token: string; vault_quote: string };
  poolAddr?: string; onDetect: () => void; busy: boolean; }> =
  ({ token, emoji, color, colorRgba, vaults, poolAddr, onDetect, busy }) => {
  const set = !!vaults.vault_token;
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10,
      background: set ? `rgba(${colorRgba},0.05)` : 'rgba(255,255,255,0.02)',
      border: `1px solid ${set ? `rgba(${colorRgba},0.25)` : 'rgba(255,255,255,0.06)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 16 }}>{emoji}</span>
        <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 11, fontWeight: 700,
          color, letterSpacing: 1.5 }}>${token}/XNT POOL</div>
        <div style={{ marginLeft: 'auto', fontFamily: 'Orbitron,monospace', fontSize: 8,
          letterSpacing: 1.5, color: set ? '#39ff88' : '#7a9ab8' }}>
          {set ? '✓ DETECTED' : 'NOT SET'}
        </div>
      </div>
      {poolAddr && (
        <div style={{ fontFamily: 'monospace', fontSize: 9, color: '#5c7a90', marginBottom: 8 }}>
          Pool: {poolAddr.slice(0, 8)}…{poolAddr.slice(-6)}
        </div>
      )}
      {set && (
        <div style={{ fontFamily: 'monospace', fontSize: 9, color: '#9abacf',
          background: 'rgba(0,0,0,0.25)', padding: '8px 10px',
          borderRadius: 6, marginBottom: 8 }}>
          <div>token vault: {vaults.vault_token.slice(0, 10)}…{vaults.vault_token.slice(-6)}</div>
          <div>quote vault: {vaults.vault_quote.slice(0, 10)}…{vaults.vault_quote.slice(-6)}</div>
        </div>
      )}
      <button onClick={onDetect} disabled={busy}
        style={set ? btnGhost(color, colorRgba, busy) : btn(color, colorRgba, busy)}>
        🔍 {set ? 'RE-DETECT' : 'AUTO-DETECT VAULTS'}
      </button>
    </div>
  );
};

// ─── TokenPanel ──────────────────────────────────────────────────────────────
const TokenPanel: FC<{
  token: 'BRAINS' | 'LB'; icon: string; colorMain: string; colorAccent: string;
  colorRgba: string; settings: BotSettings; busy: boolean;
  onToggle: (key: EventKey, val: boolean) => void;
  onBannerUpload: (f: File) => void; onSendTest: () => void;
}> = ({ token, icon, colorMain, colorAccent, colorRgba, settings, busy, onToggle, onBannerUpload, onSendTest }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const lc = token.toLowerCase() as 'brains' | 'lb';
  const enabledCount = EVENT_DEFS.filter(e => settings[`${lc}_${e.key}` as keyof BotSettings]).length;
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    botGetBannerUrl(token).then(u => { if (!cancelled) setBannerUrl(u); });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div style={{ position: 'relative', overflow: 'hidden',
      background: 'linear-gradient(160deg,#040810,#0a0612,#08040e)',
      border: `1px solid rgba(${colorRgba},0.18)`,
      borderTop: `2px solid rgba(${colorRgba},0.5)`,
      borderRadius: 16, padding: '22px 24px',
      boxShadow: `0 0 30px rgba(${colorRgba},0.05)`,
      animation: 'admFadeUp 0.4s ease both' }}>
      <GridOverlay color={`rgba(${colorRgba},0.04)`} />
      <div style={{ position: 'absolute', top: -50, right: -50, width: 180, height: 180,
        borderRadius: '50%',
        background: `radial-gradient(circle,rgba(${colorRgba},0.12),transparent 70%)`,
        pointerEvents: 'none' }} />
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <div style={{ fontSize: 30, filter: `drop-shadow(0 0 12px ${colorMain}99)` }}>{icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 18,
              fontWeight: 900, letterSpacing: 3, color: colorMain }}>${token}</div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: '#7a9ab8' }}>
              {token === 'BRAINS' ? 'X1 Brains · Token-2022' : 'Lab Work · SPL Token'}
            </div>
          </div>
          <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9, color: colorAccent,
            background: `rgba(${colorRgba},0.1)`, border: `1px solid rgba(${colorRgba},0.3)`,
            padding: '5px 10px', borderRadius: 6, letterSpacing: 1.5, fontWeight: 800 }}>
            {enabledCount}/6 ACTIVE
          </div>
        </div>
        <div style={{ height: 1, margin: '14px 0 16px',
          background: `linear-gradient(90deg,transparent,${colorMain}40,transparent)` }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {EVENT_DEFS.map(evt => {
            const key = `${lc}_${evt.key}` as keyof BotSettings;
            const enabled = settings[key] as boolean;
            return (
              <ToggleRow key={evt.key} icon={evt.icon} label={evt.label} desc={evt.desc}
                enabled={enabled} color={colorMain} colorRgba={colorRgba} disabled={busy}
                onToggle={() => onToggle(evt.key, !enabled)} />
            );
          })}
        </div>
        <div style={{ marginTop: 18, padding: '14px 16px',
          background: `rgba(${colorRgba},0.04)`,
          border: `1px solid rgba(${colorRgba},0.15)`, borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 9,
                color: colorAccent, letterSpacing: 2, marginBottom: 3, fontWeight: 700 }}>
                BANNER IMAGE
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#7a9ab8' }}>
                {bannerUrl ? 'uploaded' : 'no banner uploaded'}
              </div>
            </div>
            <div style={{ width: 48, height: 48, borderRadius: 8,
              background: `${colorMain}10`, border: `1px solid rgba(${colorRgba},0.2)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflow: 'hidden' }}>
              {bannerUrl
                ? <img src={bannerUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <span style={{ fontSize: 18, opacity: 0.4 }}>📷</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) onBannerUpload(f);
                if (fileRef.current) fileRef.current.value = '';
              }} />
            <button onClick={() => fileRef.current?.click()} disabled={busy}
              style={btn(colorMain, colorRgba, busy)}>📤 UPLOAD NEW</button>
            <button onClick={onSendTest} disabled={busy}
              style={btnGhost(colorMain, colorRgba, busy)}>📨 TEST POST</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const ToggleRow: FC<{ icon: string; label: string; desc: string; enabled: boolean;
  color: string; colorRgba: string; disabled?: boolean; onToggle: () => void; }> =
  ({ icon, label, desc, enabled, color, colorRgba, disabled, onToggle }) => (
  <div onClick={() => !disabled && onToggle()}
    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
      background: enabled ? `rgba(${colorRgba},0.08)` : 'rgba(255,255,255,0.02)',
      border: `1px solid ${enabled ? `rgba(${colorRgba},0.3)` : 'rgba(255,255,255,0.06)'}`,
      borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1, transition: 'all 0.15s ease' }}
    onMouseEnter={e => { if (!disabled) e.currentTarget.style.background =
      enabled ? `rgba(${colorRgba},0.13)` : 'rgba(255,255,255,0.04)'; }}
    onMouseLeave={e => { if (!disabled) e.currentTarget.style.background =
      enabled ? `rgba(${colorRgba},0.08)` : 'rgba(255,255,255,0.02)'; }}>
    <div style={{ fontSize: 16, opacity: enabled ? 1 : 0.4,
      filter: enabled ? `drop-shadow(0 0 6px ${color}60)` : 'grayscale(60%)' }}>
      {icon}
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 10, fontWeight: 700,
        letterSpacing: 1.5, color: enabled ? color : '#7a9ab8' }}>{label}</div>
      <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9, color: '#5c7a90',
        marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' }}>{desc}</div>
    </div>
    <div style={{ width: 36, height: 20, borderRadius: 12, position: 'relative',
      flexShrink: 0, background: enabled ? color : 'rgba(255,255,255,0.1)',
      border: `1px solid ${enabled ? color : 'rgba(255,255,255,0.15)'}`,
      transition: 'all 0.2s ease',
      boxShadow: enabled ? `0 0 12px ${color}66` : 'none' }}>
      <div style={{ position: 'absolute', top: 1, left: enabled ? 17 : 1,
        width: 16, height: 16, borderRadius: '50%',
        background: enabled ? '#0a0e14' : '#9abacf',
        transition: 'left 0.2s cubic-bezier(0.34,1.56,0.64,1)' }} />
    </div>
  </div>
);

const ThresholdsPanel: FC<{ settings: BotSettings; busy: boolean;
  onSave: (u: Partial<BotSettings>) => void; }> = ({ settings, busy, onSave }) => {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft = (key: keyof BotSettings, val: string) => setDrafts(d => ({ ...d, [key]: val }));
  const commit = (key: keyof BotSettings) => {
    const raw = drafts[key]; if (raw === undefined) return;
    const n = parseFloat(raw);
    if (!isNaN(n) && n !== settings[key]) onSave({ [key]: n } as any);
    setDrafts(d => { const { [key]: _, ...rest } = d; return rest; });
  };
  const fields: { key: keyof BotSettings; label: string; icon: string; unit: string; rgba: string; color: string; desc: string }[] = [
    { key: 'min_buy_usd',     label: 'MIN BUY THRESHOLD',     icon: '💵', unit: 'USD',    rgba: '0,212,255',   color: '#00d4ff', desc: 'Buys below this are ignored' },
    { key: 'min_burn_tokens', label: 'MIN BURN AMOUNT',       icon: '🔥', unit: 'TOKENS', rgba: '255,68,34',   color: '#ff4422', desc: 'Burns below this are ignored' },
    { key: 'min_lp_usd',      label: 'MIN LP VALUE',          icon: '💧', unit: 'USD',    rgba: '0,201,141',   color: '#00c98d', desc: 'LP creations below this are ignored' },
    { key: 'min_stake_lp',    label: 'MIN STAKE SIZE',        icon: '🌾', unit: 'LP',     rgba: '255,183,0',   color: '#ffb700', desc: 'Stakes below this are ignored' },
    { key: 'min_claim_usd',   label: 'MIN CLAIM VALUE',       icon: '💰', unit: 'USD',    rgba: '255,215,0',   color: '#ffd700', desc: 'Reward claims below this are ignored' },
    { key: 'tier_big_usd',    label: 'BIG BUY 🚀 TIER',       icon: '🚀', unit: 'USD',    rgba: '191,90,242',  color: '#bf5af2', desc: 'Buys ≥ this size get the BIG vibe' },
    { key: 'tier_whale_usd',  label: 'WHALE BUY 🐋 TIER',     icon: '🐋', unit: 'USD',    rgba: '255,140,0',   color: '#ff8c00', desc: 'Buys ≥ this size get whale alerts' },
  ];
  return (
    <div style={{ position: 'relative', overflow: 'hidden',
      background: 'linear-gradient(160deg,#040810,#0a0612,#08040e)',
      border: '1px solid rgba(140,60,255,0.18)',
      borderTop: '2px solid rgba(140,60,255,0.5)',
      borderRadius: 16, padding: '22px 24px',
      animation: 'admFadeUp 0.4s ease 0.1s both' }}>
      <GridOverlay color="rgba(140,60,255,0.04)" />
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 26, filter: 'drop-shadow(0 0 12px #cc88ff99)' }}>⚙️</div>
          <div>
            <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 16,
              fontWeight: 900, letterSpacing: 3, color: '#cc88ff' }}>THRESHOLDS</div>
            <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 11, color: '#7a9ab8' }}>
              Filter out small actions and tune the buy-tier hype levels.
            </div>
          </div>
        </div>
        <div style={{ height: 1,
          background: 'linear-gradient(90deg,transparent,#cc88ff40,transparent)',
          margin: '16px 0 14px' }} />
        <div style={{ display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 14 }}>
          {fields.map(f => {
            const draftVal = drafts[f.key as string];
            const value = draftVal !== undefined ? draftVal : String(settings[f.key]);
            const dirty = draftVal !== undefined && parseFloat(draftVal) !== settings[f.key];
            return (
              <div key={f.key as string} style={{
                background: `rgba(${f.rgba},0.05)`, border: `1px solid ${f.color}25`,
                borderRadius: 10, padding: '12px 14px', transition: 'all 0.15s' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 14 }}>{f.icon}</span>
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8,
                    fontWeight: 700, letterSpacing: 1.5, color: f.color }}>{f.label}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="number" value={value}
                    onChange={e => setDraft(f.key, e.target.value)}
                    onBlur={() => commit(f.key)}
                    onKeyDown={e => { if (e.key === 'Enter') commit(f.key); }}
                    disabled={busy}
                    style={{ flex: 1, padding: '8px 12px', background: '#04030a',
                      border: `1px solid ${dirty ? f.color : `${f.color}33`}`,
                      borderRadius: 6, fontFamily: 'monospace', fontSize: 13,
                      color: '#fff', outline: 'none' }} />
                  <div style={{ fontFamily: 'Orbitron,monospace', fontSize: 8,
                    color: '#7a9ab8', letterSpacing: 1.5, width: 50, textAlign: 'right' }}>
                    {f.unit}
                  </div>
                </div>
                <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 9,
                  color: '#5c7a90', marginTop: 6 }}>{f.desc}</div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 14, fontFamily: 'Orbitron,monospace', fontSize: 8,
          color: '#5c7a90', letterSpacing: 2, textAlign: 'center' }}>
          ↳ CLICK OUT OR PRESS ENTER TO SAVE
        </div>
      </div>
    </div>
  );
};

// ─── Style helpers ───────────────────────────────────────────────────────────
const ic: React.CSSProperties = { background: 'rgba(140,60,255,0.1)',
  border: '1px solid rgba(140,60,255,0.2)', borderRadius: 4, padding: '1px 6px',
  fontFamily: 'monospace', fontSize: 10, color: '#cc88ff' };

const cdc: React.CSSProperties = { background: 'rgba(0,212,255,0.1)',
  border: '1px solid rgba(0,212,255,0.2)', borderRadius: 4, padding: '1px 6px',
  fontFamily: 'monospace', fontSize: 11, color: '#9bdfff' };

const btn = (color: string, rgba: string, disabled?: boolean): React.CSSProperties => ({
  flex: 1, padding: '9px 14px',
  background: `linear-gradient(135deg,rgba(${rgba},0.25),rgba(${rgba},0.08))`,
  border: `1px solid rgba(${rgba},0.4)`, borderRadius: 8, color,
  fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 800, letterSpacing: 1.5,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  transition: 'all 0.15s',
});

const btnGhost = (color: string, rgba: string, disabled?: boolean): React.CSSProperties => ({
  flex: 1, padding: '9px 14px',
  background: `rgba(${rgba},0.04)`, border: `1px solid rgba(${rgba},0.18)`,
  borderRadius: 8, color: `${color}cc`,
  fontFamily: 'Orbitron,monospace', fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
});

export default BotAdmin;
