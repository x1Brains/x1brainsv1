// V2NewsBotPanel — THE EMOJI news notifier, in the v2 admin console.
//
// The SECOND bot in this stack, and the opposite shape to the buy bot next to
// it. That one watches the chain and broadcasts to ONE group it was configured
// with. This one watches THE EMOJI's desk tables and fans each new story out to
// MANY chats that subscribed themselves — so what an admin configures here is
// not "which chat", it is "which sections go out at all", plus the health of a
// list nobody else can see.
//
// Same /api/admin actions and the same adminFetch() signing pipeline; the panel
// styling deliberately mirrors V2BotPanel so the two read as one console.

import { useCallback, useEffect, useState } from 'react';
import {
  newsGetConnection, newsSaveToken, newsSetEnabled,
  newsGetSettings, newsSaveSettings, newsStats, newsBroadcastTest,
  type NewsConnection, type NewsSettings, type NewsStats,
} from '../lib/supabase';

const ACCENT = '#ffd000';   // THE EMOJI's yellow, so the panel is identifiable at a glance
const MUTED  = '#5c7a90';
const DIM    = '#3a4a5a';
const TEXT   = '#cdd8e2';
const LINE   = 'rgba(255,208,0,0.13)';
const GOOD   = '#00c98d';
const BAD    = '#ff4466';

const mono = { fontFamily: 'Orbitron, monospace', fontVariantNumeric: 'tabular-nums' as const };

const SECTION_DEFS: { key: keyof NewsSettings; icon: string; label: string; note: string }[] = [
  { key: 'announce_articles', icon: '📰', label: 'STORIES',  note: 'desk_articles' },
  { key: 'announce_projects', icon: '🚀', label: 'PROJECTS', note: 'desk_projects' },
  { key: 'announce_builders', icon: '🛠',  label: 'BUILDERS', note: 'desk_builders' },
];

type Status = { type: 'ok' | 'err' | 'info'; text: string } | null;

export default function V2NewsBotPanel() {
  const [conn,     setConn]     = useState<NewsConnection | null>(null);
  const [settings, setSettings] = useState<NewsSettings | null>(null);
  const [stats,    setStats]    = useState<NewsStats | null>(null);
  const [busy,     setBusy]     = useState(false);
  const [status,   setStatus]   = useState<Status>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [testChat,   setTestChat]   = useState('');

  const flash = useCallback((type: 'ok' | 'err' | 'info', text: string) => {
    setStatus({ type, text });
    setTimeout(() => setStatus(null), type === 'err' ? 6000 : 3000);
  }, []);

  const loadAll = useCallback(async () => {
    setBusy(true);
    try {
      const [c, s, st] = await Promise.all([newsGetConnection(), newsGetSettings(), newsStats()]);
      if (c) setConn(c);
      if (s) setSettings(s);
      if (st) setStats(st);
    } catch (e: any) {
      flash('err', e?.message ?? 'load failed');
    } finally { setBusy(false); }
  }, [flash]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const submitToken = async () => {
    if (!tokenInput.trim()) return;
    setBusy(true);
    const r = await newsSaveToken(tokenInput.trim());
    if (!r.success) flash('err', r.error ?? 'token save failed');
    /* ⛔ The field is cleared on success and the value is never echoed back —
       the input is the only place in the browser the token ever exists, and it
       should not survive the save. */
    else { flash('ok', 'Token verified + saved'); setTokenInput(''); await loadAll(); }
    setBusy(false);
  };

  const toggleEnabled = async (v: boolean) => {
    setBusy(true);
    const r = await newsSetEnabled(v);
    if (!r.success) flash('err', r.error ?? 'failed');
    else { flash('ok', v ? 'Notifier live' : 'Notifier paused'); await loadAll(); }
    setBusy(false);
  };

  const toggleSection = async (key: keyof NewsSettings, v: boolean) => {
    setBusy(true);
    const r = await newsSaveSettings({ [key]: v } as Partial<NewsSettings>);
    if (!r.success) flash('err', r.error ?? 'save failed');
    else { setSettings(s => (s ? { ...s, [key]: v } : s)); flash('ok', 'Saved'); }
    setBusy(false);
  };

  const sendTest = async () => {
    if (!testChat.trim()) { flash('err', 'paste a chat id first'); return; }
    setBusy(true);
    const r = await newsBroadcastTest(testChat.trim());
    if (!r.success) flash('err', r.error ?? 'send failed');
    else flash('ok', 'Test sent');
    setBusy(false);
  };

  const tokenOk = !!conn?.has_token;
  const liveOk  = !!conn?.enabled;

  return (
    <div className="info-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div className="title" style={{ margin: 0 }}>
          😂 THE EMOJI — News Notifier
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Pill label="TOKEN" ok={tokenOk} />
          <Pill label="LIVE"  ok={liveOk}  />
        </div>
      </div>

      {status && (
        <div style={{
          ...mono, fontSize: 9, letterSpacing: 1, padding: '6px 10px', borderRadius: 4, marginBottom: 10,
          color: status.type === 'err' ? BAD : status.type === 'ok' ? GOOD : MUTED,
          background: `${status.type === 'err' ? BAD : status.type === 'ok' ? GOOD : MUTED}11`,
        }}>
          {status.text}
        </div>
      )}

      {/* ── 1. the list ───────────────────────────────────────────────────── */}
      {/* ⛔ COUNTS, NEVER ROWS. A subscriber list is the chat ids of everyone
          reading the paper; the panel is shown the SHAPE of the list, and the
          API has no action that returns the list itself. */}
      <Section title="SUBSCRIBERS">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(78px,1fr))', gap: 8 }}>
          <Stat label="ACTIVE"    value={stats?.active} accent={ACCENT} />
          <Stat label="GROUPS"    value={stats?.groups} />
          <Stat label="STORIES"   value={stats?.news} />
          <Stat label="PROJECTS"  value={stats?.projects} />
          <Stat label="BUILDERS"  value={stats?.builders} />
          <Stat label="POSTED"    value={stats?.announced} />
        </div>
        <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1, marginTop: 8 }}>
          ACTIVE = chats that ran /start and have not stopped or blocked. POSTED = rows
          announced so far; it is what stops a story going out twice.
        </div>
      </Section>

      {/* ── 2. the bot's identity ─────────────────────────────────────────── */}
      <Section title="TELEGRAM">
        {tokenOk ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ ...mono, fontSize: 10, color: GOOD }}>
              @{conn?.bot_username || 'unknown'}
            </span>
            <span style={{ ...mono, fontSize: 9, color: DIM }}>{conn?.token_masked}</span>
          </div>
        ) : (
          <div style={{ ...mono, fontSize: 8, color: MUTED, letterSpacing: 1, marginBottom: 8 }}>
            Create a bot with @BotFather, then paste its token. It needs its OWN handle —
            the buy bot's token will be rejected.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <input
            type="password"
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            placeholder={tokenOk ? 'replace token…' : '123456:ABC-DEF…'}
            style={inputStyle}
          />
          <Btn onClick={submitToken} disabled={busy || !tokenInput.trim()}>
            {tokenOk ? 'REPLACE' : 'SAVE & VERIFY'}
          </Btn>
        </div>
      </Section>

      {/* ── 3. the master switch ──────────────────────────────────────────── */}
      <Section title="BROADCAST">
        <Row
          label="NOTIFIER LIVE"
          note={liveOk ? 'the Fly worker is fanning posts out' : 'paused — nothing goes out, subscriptions still work'}
          on={liveOk} busy={busy || !tokenOk} onChange={toggleEnabled}
        />
        {SECTION_DEFS.map(d => (
          <Row
            key={String(d.key)}
            label={`${d.icon}  ${d.label}`}
            note={d.note}
            on={settings ? (settings[d.key] as boolean) !== false : true}
            busy={busy || !settings}
            onChange={v => toggleSection(d.key, v)}
          />
        ))}
        <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1, marginTop: 8 }}>
          These are the desk's switches. Each subscriber has their own on top of these —
          a section off here goes to nobody, whatever they picked.
        </div>
      </Section>

      {/* ── 4. proving the wiring ─────────────────────────────────────────── */}
      <Section title="TEST">
        <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1, marginBottom: 8 }}>
          Message the bot, then paste your own chat id. ⛔ Sends to that ONE chat —
          there is deliberately no way to fire a test at every subscriber.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            value={testChat}
            onChange={e => setTestChat(e.target.value)}
            placeholder="chat id, e.g. 123456789"
            style={inputStyle}
          />
          <Btn onClick={sendTest} disabled={busy || !tokenOk}>SEND TEST</Btn>
          <Btn onClick={loadAll} disabled={busy}>REFRESH</Btn>
        </div>
        {settings?.site_url && (
          <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1, marginTop: 8 }}>
            LINKS POINT AT {settings.site_url} · POLLS EVERY {settings.poll_seconds ?? 90}s
          </div>
        )}
      </Section>
    </div>
  );
}

// ── small pieces, matching V2BotPanel ────────────────────────────────────────
const inputStyle = {
  flex: 1, minWidth: 180, padding: '7px 10px', borderRadius: 4,
  background: 'rgba(255,255,255,0.03)', border: `1px solid ${LINE}`,
  color: TEXT, fontSize: 11, fontFamily: 'Orbitron, monospace',
} as const;

function Btn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled}
      style={{
        ...mono, padding: '7px 12px', borderRadius: 4, fontSize: 8, fontWeight: 700, letterSpacing: 1.4,
        background: disabled ? 'rgba(255,255,255,0.03)' : `${ACCENT}18`,
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.08)' : `${ACCENT}66`}`,
        color: disabled ? DIM : ACCENT, cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

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

function Stat({ label, value, accent }: { label: string; value?: number; accent?: string }) {
  return (
    <div style={{ padding: '8px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.02)', textAlign: 'center' as const }}>
      <div style={{ ...mono, fontSize: 15, fontWeight: 800, color: accent ?? TEXT }}>
        {value ?? '—'}
      </div>
      <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1.3, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function Row({
  label, note, on, busy, onChange,
}: { label: string; note?: string; on: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 10, padding: '6px 0', borderBottom: `1px solid rgba(255,255,255,0.03)`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...mono, fontSize: 9, color: TEXT, letterSpacing: 1.2, fontWeight: 700 }}>{label}</div>
        {note && <div style={{ ...mono, fontSize: 7, color: DIM, letterSpacing: 1, marginTop: 2 }}>{note}</div>}
      </div>
      <Toggle on={on} disabled={busy} onChange={onChange} color={ACCENT} />
    </div>
  );
}

function Toggle({ on, disabled, onChange, color }: { on: boolean; disabled: boolean; onChange: (v: boolean) => void; color: string }) {
  return (
    <button
      type="button" disabled={disabled} onClick={() => onChange(!on)}
      style={{
        width: 44, height: 22, borderRadius: 11, flex: '0 0 auto',
        background: on ? `${color}30` : 'rgba(255,255,255,0.04)',
        border: `1px solid ${on ? `${color}80` : 'rgba(255,255,255,0.1)'}`,
        position: 'relative' as const, cursor: disabled ? 'not-allowed' : 'pointer',
        padding: 0, transition: 'all .15s',
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
