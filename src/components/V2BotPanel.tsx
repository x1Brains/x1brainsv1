// V2BotPanel — Telegram buy-bot config rendered inline in the v2 admin console.
// Replaces the standalone /admin/bot page. Same /api/admin actions, same
// adminFetch() signing pipeline — just a compact V2-styled UI in info-cards.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  botGetSettings, botSaveSettings,
  botGetConnection, botSaveTelegramToken, botSaveChat,
  botTestTelegram, botDetectChats, botDetectVaults, botSendTestMessage,
  botUploadBanner,
  type BotSettings, type BotConnection, type BotChat,
} from '../lib/supabase';

const ACCENT = '#f29030';
const MUTED  = '#5c7a90';
const DIM    = '#3a4a5a';
const TEXT   = '#cdd8e2';
const LINE   = 'rgba(242,144,48,0.13)';
const GOOD   = '#00c98d';
const BAD    = '#ff4466';
const COOL   = '#00d4ff';

const mono = { fontFamily: 'Orbitron, monospace', fontVariantNumeric: 'tabular-nums' as const };

type EventKey = 'buys' | 'burns' | 'lp' | 'stake' | 'unstake' | 'claim';
const EVENT_DEFS: { key: EventKey; icon: string; label: string }[] = [
  { key: 'buys',    icon: '🟢', label: 'BUYS'     },
  { key: 'burns',   icon: '🔥', label: 'BURNS'    },
  { key: 'lp',      icon: '💧', label: 'LP'       },
  { key: 'stake',   icon: '🌾', label: 'STAKE'    },
  { key: 'unstake', icon: '📤', label: 'UNSTAKE'  },
  { key: 'claim',   icon: '💰', label: 'CLAIM'    },
];

type Status = { type: 'ok' | 'err' | 'info'; text: string } | null;

export default function V2BotPanel() {
  const [settings,   setSettings]   = useState<BotSettings | null>(null);
  const [connection, setConnection] = useState<BotConnection | null>(null);
  const [chats,      setChats]      = useState<BotChat[]>([]);
  const [busy,       setBusy]       = useState(false);
  const [status,     setStatus]     = useState<Status>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [chatInput,  setChatInput]  = useState('');
  const brainsBannerRef = useRef<HTMLInputElement>(null);
  const lbBannerRef     = useRef<HTMLInputElement>(null);

  const flash = useCallback((type: 'ok' | 'err' | 'info', text: string) => {
    setStatus({ type, text });
    setTimeout(() => setStatus(null), type === 'err' ? 6000 : 3000);
  }, []);

  const loadAll = useCallback(async () => {
    setBusy(true);
    try {
      const [s, c] = await Promise.all([botGetSettings(), botGetConnection()]);
      if (s) setSettings(s);
      if (c) setConnection(c);
    } catch (e: any) {
      flash('err', e?.message ?? 'load failed');
    } finally { setBusy(false); }
  }, [flash]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const toggle = async (key: string, val: boolean) => {
    setBusy(true);
    const r = await botSaveSettings({ [key]: val } as any);
    if (!r.success) flash('err', r.error ?? 'save failed');
    else { setSettings(s => s ? { ...s, [key]: val } as BotSettings : s); flash('ok', 'Saved'); }
    setBusy(false);
  };

  const saveThreshold = async (key: string, val: number) => {
    setBusy(true);
    const r = await botSaveSettings({ [key]: val } as any);
    if (!r.success) flash('err', r.error ?? 'save failed');
    else { setSettings(s => s ? { ...s, [key]: val } as BotSettings : s); flash('ok', 'Saved'); }
    setBusy(false);
  };

  const submitToken = async () => {
    if (!tokenInput.trim()) return;
    setBusy(true);
    const r = await botSaveTelegramToken(tokenInput.trim());
    if (!r.success) flash('err', r.error ?? 'token save failed');
    else { flash('ok', 'Token verified + saved'); setTokenInput(''); await loadAll(); }
    setBusy(false);
  };

  const submitChat = async (id: string, title: string) => {
    setBusy(true);
    const r = await botSaveChat(id, title);
    if (!r.success) flash('err', r.error ?? 'chat save failed');
    else { flash('ok', 'Chat saved'); setChatInput(''); await loadAll(); }
    setBusy(false);
  };

  const detectChats = async () => {
    setBusy(true); flash('info', 'Polling Telegram getUpdates…');
    const list = await botDetectChats();
    setChats(list);
    flash(list.length > 0 ? 'ok' : 'info', list.length > 0 ? `Found ${list.length} chats` : 'No chats — add bot to a group + send a message');
    setBusy(false);
  };

  const detectVault = async (sym: 'BRAINS' | 'LB') => {
    setBusy(true); flash('info', `Reading ${sym} pool on-chain…`);
    const r = await botDetectVaults(sym);
    if (!r.success) flash('err', r.error ?? 'detect failed');
    else { flash('ok', `${sym} vaults wired`); await loadAll(); }
    setBusy(false);
  };

  const sendTest = async (sym: 'BRAINS' | 'LB') => {
    setBusy(true);
    const r = await botSendTestMessage(sym);
    if (!r.success) flash('err', r.error ?? 'send failed');
    else flash('ok', `${sym} test posted`);
    setBusy(false);
  };

  const testTelegram = async () => {
    setBusy(true);
    const r = await botTestTelegram();
    if (!r.success) flash('err', r.error ?? 'test failed');
    else flash('ok', 'Telegram link OK');
    setBusy(false);
  };

  const uploadBanner = async (sym: 'BRAINS' | 'LB', file: File) => {
    setBusy(true); flash('info', `Uploading ${sym} banner…`);
    const r = await botUploadBanner(sym, file);
    if (!r.success) flash('err', r.error ?? 'upload failed');
    else flash('ok', `${sym} banner uploaded`);
    setBusy(false);
  };

  const tokenOk  = !!connection?.telegram_token_masked;
  const chatOk   = !!connection?.chat_id;
  const vaultsOk = !!(connection?.vaults?.BRAINS?.vault_token && connection?.vaults?.LB?.vault_token);

  return (
    <div className="info-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div className="title" style={{ margin: 0 }}>Telegram Buy-Bot</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Pill label="TG"     ok={tokenOk}  />
          <Pill label="CHAT"   ok={chatOk}   />
          <Pill label="VAULTS" ok={vaultsOk} />
        </div>
      </div>

      {status && (
        <div style={{
          marginBottom: 10, padding: '8px 12px', borderRadius: 6,
          background: status.type === 'err' ? `${BAD}10` : status.type === 'ok' ? `${GOOD}10` : `${COOL}10`,
          border:     `1px solid ${status.type === 'err' ? `${BAD}40` : status.type === 'ok' ? `${GOOD}40` : `${COOL}40`}`,
          color:      status.type === 'err' ?  BAD       : status.type === 'ok' ?  GOOD       :  COOL,
          ...mono, fontFamily: 'Sora, sans-serif', fontSize: 11,
        }}>
          {status.text}
        </div>
      )}

      {/* ── CONNECTION ───────────────────────────────────────── */}
      <Section title="CONNECTION">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <Field label="TELEGRAM TOKEN">
            {tokenOk ? (
              <div style={{ ...mono, fontSize: 11, color: TEXT }}>
                {connection!.telegram_token_masked}
                <button type="button" onClick={() => setTokenInput(' ')} style={miniBtn(BAD)}>REPLACE</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={tokenInput}
                  onChange={e => setTokenInput(e.target.value)}
                  placeholder="123456:ABC..."
                  disabled={busy}
                  style={inp}
                />
                <button type="button" onClick={submitToken} disabled={busy || !tokenInput.trim()} style={miniBtn(ACCENT)}>SAVE</button>
              </div>
            )}
          </Field>
          <Field label="CHAT">
            {chatOk ? (
              <div style={{ ...mono, fontSize: 11, color: TEXT }}>
                {connection!.chat_title || connection!.chat_id}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="-1001234567890"
                  disabled={busy}
                  style={inp}
                />
                <button type="button" onClick={() => submitChat(chatInput.trim(), '')} disabled={busy || !chatInput.trim()} style={miniBtn(ACCENT)}>SAVE</button>
              </div>
            )}
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={detectChats}      disabled={busy} style={miniBtn(COOL)}>DETECT CHATS</button>
          <button type="button" onClick={() => detectVault('BRAINS')} disabled={busy} style={miniBtn(COOL)}>DETECT BRAINS VAULT</button>
          <button type="button" onClick={() => detectVault('LB')}     disabled={busy} style={miniBtn(COOL)}>DETECT LB VAULT</button>
          <button type="button" onClick={testTelegram}     disabled={busy} style={miniBtn(GOOD)}>TEST TELEGRAM</button>
        </div>

        {chats.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {chats.map(c => (
              <button
                key={String(c.id)}
                type="button"
                onClick={() => submitChat(String(c.id), c.title)}
                disabled={busy}
                style={{ ...mono, padding: '6px 10px', borderRadius: 5,
                  background: 'rgba(0,201,141,0.06)', border: `1px solid ${GOOD}40`,
                  color: TEXT, fontSize: 10, textAlign: 'left' as const, cursor: 'pointer' }}
              >
                <span style={{ color: GOOD, fontWeight: 700 }}>{c.title}</span>
                <span style={{ color: MUTED }}> · {c.type} · {c.id}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      {/* ── EVENT TOGGLES ─────────────────────────────────────── */}
      <Section title="EVENT FILTERS">
        {!settings ? (
          <div className="lw-placeholder">
            <div className="lw-placeholder-glyph">⟳</div>
            <div className="lw-placeholder-sub">Loading settings…</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr', gap: 6, alignItems: 'center' }}>
            <div></div>
            <TokenHeader label="BRAINS" color={ACCENT} />
            <TokenHeader label="LB"     color={GOOD}   />
            {EVENT_DEFS.map(ev => (
              <EventRow
                key={ev.key} ev={ev}
                brainsOn={settings[`brains_${ev.key}` as keyof BotSettings] as boolean}
                lbOn    ={settings[`lb_${ev.key}`     as keyof BotSettings] as boolean}
                busy={busy}
                onBrains={(v) => toggle(`brains_${ev.key}`, v)}
                onLb    ={(v) => toggle(`lb_${ev.key}`,     v)}
              />
            ))}
          </div>
        )}
      </Section>

      {/* ── THRESHOLDS ────────────────────────────────────────── */}
      {settings && (
        <Section title="THRESHOLDS">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <NumField label="MIN BUY USD"     value={settings.min_buy_usd}     onSave={v => saveThreshold('min_buy_usd',     v)} busy={busy} />
            <NumField label="MIN BURN TOKENS" value={settings.min_burn_tokens} onSave={v => saveThreshold('min_burn_tokens', v)} busy={busy} />
            <NumField label="MIN LP USD"      value={settings.min_lp_usd}      onSave={v => saveThreshold('min_lp_usd',      v)} busy={busy} />
            <NumField label="MIN STAKE LP"    value={settings.min_stake_lp}    onSave={v => saveThreshold('min_stake_lp',    v)} busy={busy} />
            <NumField label="MIN CLAIM USD"   value={settings.min_claim_usd}   onSave={v => saveThreshold('min_claim_usd',   v)} busy={busy} />
            <NumField label="TIER BIG USD"    value={settings.tier_big_usd}    onSave={v => saveThreshold('tier_big_usd',    v)} busy={busy} />
            <NumField label="TIER WHALE USD"  value={settings.tier_whale_usd}  onSave={v => saveThreshold('tier_whale_usd',  v)} busy={busy} />
          </div>
        </Section>
      )}

      {/* ── BANNERS + TEST POSTS ─────────────────────────────── */}
      <Section title="BANNERS & TEST POSTS">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          <BannerCard
            sym="BRAINS" color={ACCENT}
            onUpload={f => uploadBanner('BRAINS', f)}
            onSendTest={() => sendTest('BRAINS')}
            inputRef={brainsBannerRef} busy={busy}
          />
          <BannerCard
            sym="LB" color={GOOD}
            onUpload={f => uploadBanner('LB', f)}
            onSendTest={() => sendTest('LB')}
            inputRef={lbBannerRef} busy={busy}
          />
        </div>
      </Section>
    </div>
  );
}

/* ── Subcomponents ───────────────────────────────────────────── */

function Pill({ label, ok }: { label: string; ok: boolean }) {
  const c = ok ? GOOD : BAD;
  return (
    <span style={{
      ...mono, padding: '3px 8px', borderRadius: 4,
      background: `${c}14`, border: `1px solid ${c}55`,
      color: c, fontSize: 8, fontWeight: 700, letterSpacing: 1.2,
    }}>
      {ok ? '✓' : '✕'} {label}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px dashed ${LINE}` }}>
      <div style={{ ...mono, fontSize: 8, color: DIM, letterSpacing: 1.8, fontWeight: 700, marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1.5, fontWeight: 700 }}>{label}</div>
      {children}
    </div>
  );
}

function TokenHeader({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ ...mono, fontSize: 9, color, letterSpacing: 1.5, fontWeight: 800, textAlign: 'center' as const }}>
      {label}
    </div>
  );
}

function EventRow({
  ev, brainsOn, lbOn, busy, onBrains, onLb,
}: {
  ev: { key: EventKey; icon: string; label: string };
  brainsOn: boolean; lbOn: boolean; busy: boolean;
  onBrains: (v: boolean) => void; onLb: (v: boolean) => void;
}) {
  return (
    <>
      <div style={{ ...mono, fontSize: 9, color: TEXT, letterSpacing: 1, fontWeight: 700 }}>
        <span style={{ marginRight: 6 }}>{ev.icon}</span>{ev.label}
      </div>
      <Toggle on={brainsOn} disabled={busy} onChange={onBrains} color={ACCENT} />
      <Toggle on={lbOn}     disabled={busy} onChange={onLb}     color={GOOD}   />
    </>
  );
}

function Toggle({ on, disabled, onChange, color }: { on: boolean; disabled: boolean; onChange: (v: boolean) => void; color: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        width: 44, height: 22, borderRadius: 11,
        background: on ? `${color}30` : 'rgba(255,255,255,0.04)',
        border: `1px solid ${on ? `${color}80` : 'rgba(255,255,255,0.1)'}`,
        position: 'relative' as const, cursor: disabled ? 'not-allowed' : 'pointer',
        margin: '0 auto', display: 'block', padding: 0, transition: 'all .15s',
      }}
    >
      <span style={{
        position: 'absolute' as const, top: 2, left: on ? 22 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: on ? color : 'rgba(255,255,255,0.3)',
        transition: 'left .15s, background .15s',
      }} />
    </button>
  );
}

function NumField({ label, value, onSave, busy }: { label: string; value: number; onSave: (v: number) => void; busy: boolean }) {
  const [v, setV] = useState(String(value ?? 0));
  useEffect(() => { setV(String(value ?? 0)); }, [value]);
  const dirty = Number(v) !== value;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1.5, fontWeight: 700 }}>{label}</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          type="number" value={v} onChange={e => setV(e.target.value)} disabled={busy}
          style={{ ...inp, padding: '6px 8px', fontSize: 11 }}
        />
        {dirty && (
          <button type="button" disabled={busy} onClick={() => { const n = Number(v); if (!isNaN(n)) onSave(n); }} style={miniBtn(ACCENT)}>
            SAVE
          </button>
        )}
      </div>
    </div>
  );
}

function BannerCard({
  sym, color, onUpload, onSendTest, inputRef, busy,
}: {
  sym: string; color: string;
  onUpload: (f: File) => void; onSendTest: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>; busy: boolean;
}) {
  return (
    <div style={{ padding: 10, background: `${color}06`, border: `1px solid ${color}33`, borderRadius: 7 }}>
      <div style={{ ...mono, fontSize: 9, color, letterSpacing: 1.5, fontWeight: 800, marginBottom: 8 }}>
        {sym}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} style={{ ...miniBtn(color), flex: 1 }}>
          UPLOAD BANNER
        </button>
        <button type="button" disabled={busy} onClick={onSendTest} style={{ ...miniBtn(GOOD), flex: 1 }}>
          SEND TEST
        </button>
      </div>
    </div>
  );
}

/* ── styles ─────────────────────────────────────────────────── */
const inp = {
  ...mono,
  fontFamily: 'Sora, sans-serif' as const,
  padding: '7px 9px',
  background: 'rgba(0,0,0,.3)',
  border: `1px solid ${LINE}`,
  borderRadius: 5,
  color: TEXT,
  fontSize: 11,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box' as const,
};
const miniBtn = (color: string) => ({
  ...mono,
  padding: '5px 10px', borderRadius: 5,
  background: `${color}14`, border: `1px solid ${color}55`,
  color, fontSize: 8, fontWeight: 700, letterSpacing: 1.2,
  cursor: 'pointer' as const, whiteSpace: 'nowrap' as const,
});
