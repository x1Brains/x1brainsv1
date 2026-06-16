import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import {
  useAdmin, COUNCIL_WALLET, V1_ADMIN_WALLET,
} from '../lib/admin';
import {
  getAnnouncements, addAnnouncement, deleteAnnouncement, invalidateAnnouncementsCache,
  adminListSpotlight, uploadSpotlightImage, deleteSpotlightImage, setSpotlightActive,
  type SpotlightImage,
} from '../lib/supabase';
import { shortAddr } from '../utils/v2format';
import V2AnalyticsPanel from '../components/V2AnalyticsPanel';
import V2BotPanel from '../components/V2BotPanel';

const ACCENT = '#f29030';
const MUTED  = '#5c7a90';
const DIM    = '#3a4a5a';
const TEXT   = '#cdd8e2';
const LINE   = 'rgba(242,144,48,0.13)';
const BAD    = '#ff4466';
const COUNCIL_COLOR = '#bf5af2';

const mono = { fontFamily: 'Orbitron, monospace', fontVariantNumeric: 'tabular-nums' as const };

/* ──────────────────────────────────────────────────────────────────────
 * Access gate
 * ────────────────────────────────────────────────────────────────────── */
const Gate: FC<{ pubkey: string; connected: boolean }> = ({ pubkey, connected }) => {
  const { setVisible } = useWalletModal();
  return (
    <div className="content content-wide">
      <div className="info-card" style={{ maxWidth: 560, margin: '60px auto', textAlign: 'center', padding: '36px 28px' }}>
        <div style={{ fontSize: 52, marginBottom: 14, lineHeight: 1 }}>⛔</div>
        <div className="title" style={{ margin: '0 auto 8px', justifyContent: 'center' }}>
          Restricted Sector
        </div>
        <div style={{ ...mono, fontFamily: 'Sora, sans-serif', fontSize: 12, color: MUTED, lineHeight: 1.55, marginBottom: 20 }}>
          The X1 Brains admin console requires one of two recognised wallets.
          Connect the council or the legacy admin key to continue.
        </div>

        <div style={{
          textAlign: 'left',
          background: 'rgba(0,0,0,.25)',
          border: `1px solid ${LINE}`,
          borderRadius: 8,
          padding: '12px 14px',
          marginBottom: 18,
        }}>
          <Row label="COUNCIL"  value={COUNCIL_WALLET}  color={COUNCIL_COLOR} />
          <Row label="V1 ADMIN" value={V1_ADMIN_WALLET} color={ACCENT} />
        </div>

        {connected ? (
          <div style={{
            ...mono, fontSize: 10, padding: '10px 14px',
            background: `${BAD}10`, border: `1px solid ${BAD}40`,
            borderRadius: 7, color: BAD, letterSpacing: 1,
          }}>
            CONNECTED · {shortAddr(pubkey, 5, 5)} · NOT AUTHORISED
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setVisible(true)}
            style={{
              ...mono,
              padding: '10px 22px', background: `${ACCENT}1a`,
              border: `1px solid ${ACCENT}80`, borderRadius: 7,
              color: ACCENT, fontSize: 10, fontWeight: 700, letterSpacing: 2,
              cursor: 'pointer',
            }}
          >
            CONNECT WALLET
          </button>
        )}
      </div>
    </div>
  );
};

const Row: FC<{ label: string; value: string; color: string }> = ({ label, value, color }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px dashed ${LINE}` }}>
    <span style={{ ...mono, fontSize: 8, color: DIM, letterSpacing: 1.5, fontWeight: 700 }}>{label}</span>
    <span style={{ ...mono, fontSize: 10, color, letterSpacing: 0.5, fontWeight: 600 }}>
      {value.slice(0, 6)}…{value.slice(-6)}
    </span>
  </div>
);

/* ──────────────────────────────────────────────────────────────────────
 * Announcements panel — create / pin / delete.
 * ────────────────────────────────────────────────────────────────────── */
const AnnouncementsPanel: FC<{
  items: any[];
  reload: () => Promise<void>;
}> = ({ items, reload }) => {
  const [title, setTitle]     = useState('');
  const [message, setMessage] = useState('');
  const [type, setType]       = useState('info');
  const [busy, setBusy]       = useState(false);
  const [status, setStatus]   = useState('');

  const submit = async () => {
    if (!title.trim() || !message.trim()) { setStatus('Title + message required'); return; }
    setBusy(true); setStatus('');
    try {
      const r = await addAnnouncement({ title: title.trim(), message: message.trim(), type });
      if (!r.success) { setStatus(`❌ ${r.error}`); return; }
      setStatus('✅ Posted');
      setTitle(''); setMessage('');
      invalidateAnnouncementsCache();
      await reload();
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this announcement?')) return;
    setBusy(true); setStatus('');
    try {
      const r = await deleteAnnouncement(id);
      if (!r.success) { setStatus(`❌ ${r.error}`); return; }
      invalidateAnnouncementsCache();
      await reload();
    } finally { setBusy(false); }
  };

  return (
    <div className="info-card">
      <div className="title">Announcements</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8, marginBottom: 8 }}>
        <input
          value={title} onChange={e => setTitle(e.target.value)}
          placeholder="Title"
          disabled={busy}
          style={fieldStyle}
        />
        <select
          value={type} onChange={e => setType(e.target.value)}
          disabled={busy}
          style={{ ...fieldStyle, padding: '8px 10px' }}
        >
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="critical">critical</option>
          <option value="release">release</option>
        </select>
      </div>
      <textarea
        value={message} onChange={e => setMessage(e.target.value)}
        placeholder="Message body"
        disabled={busy} rows={3}
        style={{ ...fieldStyle, marginBottom: 10, resize: 'vertical' }}
      />
      <button type="button" onClick={submit} disabled={busy} style={primaryBtn(busy)}>
        {busy ? 'POSTING…' : 'POST ANNOUNCEMENT'}
      </button>
      {status && <div style={statusStyle}>{status}</div>}

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.length === 0 ? (
          <div className="lw-placeholder">
            <div className="lw-placeholder-glyph">◌</div>
            <div className="lw-placeholder-sub">No announcements yet</div>
          </div>
        ) : items.map(a => (
          <div key={a.id} style={{
            padding: '10px 12px',
            background: 'rgba(242,144,48,0.04)',
            border: `1px solid ${LINE}`,
            borderRadius: 7,
            display: 'flex', gap: 12, alignItems: 'flex-start',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...mono, fontSize: 11, fontWeight: 700, color: TEXT, letterSpacing: 0.5 }}>
                {a.title}
                <span style={{ ...mono, marginLeft: 8, fontSize: 8, color: a.type === 'critical' ? BAD : a.type === 'warn' ? ACCENT : MUTED, letterSpacing: 1 }}>
                  {String(a.type).toUpperCase()}
                </span>
              </div>
              <div style={{ fontFamily: 'Sora, sans-serif', fontSize: 11, color: '#aabacc', marginTop: 4, lineHeight: 1.5, wordBreak: 'break-word' }}>
                {a.message}
              </div>
              <div style={{ ...mono, fontSize: 8, color: DIM, letterSpacing: 1, marginTop: 4 }}>
                {a.date ? new Date(a.date).toISOString().slice(0, 19).replace('T', ' ') : '—'}
              </div>
            </div>
            <button type="button" onClick={() => remove(a.id)} disabled={busy} style={miniBadBtn}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ──────────────────────────────────────────────────────────────────────
 * Spotlight Carousel panel — upload promo images for the landing showcase.
 * ────────────────────────────────────────────────────────────────────── */
function fileToResizedDataUrl(file: File, maxW = 1280, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      URL.revokeObjectURL(url);
      if (!ctx) { reject(new Error('canvas unavailable')); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

const SpotlightPanel: FC = () => {
  const [items, setItems]     = useState<SpotlightImage[]>([]);
  const [preview, setPreview] = useState('');
  const [filename, setFilename] = useState('');
  const [link, setLink]       = useState('');
  const [caption, setCaption] = useState('');
  const [busy, setBusy]       = useState(false);
  const [status, setStatus]   = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => { setItems(await adminListSpotlight()); }, []);
  useEffect(() => { reload(); }, [reload]);

  const onPick = async (f?: File) => {
    if (!f) return;
    setStatus('');
    try { setPreview(await fileToResizedDataUrl(f)); setFilename(f.name); }
    catch { setStatus('Could not read that image'); }
  };

  const submit = async () => {
    if (!preview) { setStatus('Pick an image first'); return; }
    setBusy(true); setStatus('');
    try {
      const r = await uploadSpotlightImage({
        dataUrl: preview, filename: filename || 'image.jpg',
        link: link.trim() || undefined, caption: caption.trim() || undefined,
      });
      if (!r.success) { setStatus(r.error || 'Upload failed'); return; }
      setPreview(''); setFilename(''); setLink(''); setCaption('');
      if (fileRef.current) fileRef.current.value = '';
      await reload();
      setStatus('Uploaded');
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this spotlight image?')) return;
    setBusy(true);
    try { const r = await deleteSpotlightImage(id); if (!r.success) setStatus(r.error || 'Delete failed'); await reload(); }
    finally { setBusy(false); }
  };

  const toggle = async (img: SpotlightImage) => {
    setBusy(true);
    try { await setSpotlightActive(img.id, !img.active); await reload(); }
    finally { setBusy(false); }
  };

  return (
    <div className="info-card">
      <div className="title">Spotlight Carousel</div>
      <div style={{ ...mono, fontFamily: 'Sora, sans-serif', fontSize: 11, color: MUTED, marginBottom: 12 }}>
        Promo images for the landing-page showcase. They interleave with active boosted listings. Optional link + caption per image.
      </div>

      {/* uploader */}
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => onPick(e.target.files?.[0])} />
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'start' }}>
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
          style={{
            aspectRatio: '16/9', borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
            border: `1px dashed ${preview ? ACCENT : LINE}`, background: preview ? '#06090d' : 'rgba(255,255,255,.02)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
          }}>
          {preview
            ? <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ ...mono, fontSize: 9, color: MUTED, letterSpacing: 1 }}>+ IMAGE</span>}
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input value={link} onChange={e => setLink(e.target.value)} placeholder="Link URL (optional) — e.g. https://x1city.io/citizenship/mint"
            disabled={busy} style={fieldStyle} />
          <input value={caption} onChange={e => setCaption(e.target.value)} placeholder="Caption (optional)"
            disabled={busy} style={fieldStyle} />
          <button type="button" onClick={submit} disabled={busy || !preview} style={primaryBtn(busy || !preview)}>
            {busy ? 'WORKING…' : 'UPLOAD TO SPOTLIGHT'}
          </button>
        </div>
      </div>
      {status && <div style={statusStyle}>{status}</div>}

      {/* list */}
      <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {items.length === 0 ? (
          <div className="lw-placeholder" style={{ gridColumn: '1 / -1' }}>
            <div className="lw-placeholder-glyph">◌</div>
            <div className="lw-placeholder-sub">No spotlight images yet</div>
          </div>
        ) : items.map(img => (
          <div key={img.id} style={{
            borderRadius: 8, overflow: 'hidden', border: `1px solid ${LINE}`,
            background: '#06090d', opacity: img.active ? 1 : 0.45, position: 'relative',
          }}>
            <div style={{ aspectRatio: '16/9', overflow: 'hidden' }}>
              <img src={img.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div style={{ padding: '7px 9px' }}>
              {img.caption && <div style={{ fontFamily: 'Sora,sans-serif', fontSize: 10, color: TEXT, marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{img.caption}</div>}
              {img.link_url && <div style={{ ...mono, fontSize: 8, color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>↗ {img.link_url}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                <button type="button" onClick={() => toggle(img)} disabled={busy} style={{
                  ...mono, flex: 1, padding: '5px 0', borderRadius: 5, cursor: 'pointer', fontSize: 8, fontWeight: 700, letterSpacing: 1,
                  background: img.active ? `${ACCENT}14` : 'rgba(255,255,255,.04)',
                  border: `1px solid ${img.active ? ACCENT + '66' : LINE}`, color: img.active ? ACCENT : MUTED,
                }}>{img.active ? 'LIVE' : 'HIDDEN'}</button>
                <button type="button" onClick={() => remove(img.id)} disabled={busy} style={miniBadBtn}>×</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ──────────────────────────────────────────────────────────────────────
 * Top-level page
 * ────────────────────────────────────────────────────────────────────── */
export default function V2Admin() {
  const { isAdmin, role, pubkey, connected } = useAdmin();

  const [announcements, setAnnouncements] = useState<any[]>([]);

  const reloadAnnouncements = useCallback(async () => {
    setAnnouncements(await getAnnouncements());
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    reloadAnnouncements();
  }, [isAdmin, reloadAnnouncements]);

  if (!isAdmin) return <Gate pubkey={pubkey} connected={connected} />;

  const roleLabel = role === 'council' ? 'COUNCIL' : 'V1 ADMIN';
  const roleColor = role === 'council' ? COUNCIL_COLOR : ACCENT;

  return (
    <div className="content content-wide">
      <div className="lw-stack">

        {/* Identity strip */}
        <div className="info-card" style={{ padding: '14px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="title" style={{ margin: 0 }}>Admin Console</div>
              <div style={{ ...mono, fontFamily: 'Sora, sans-serif', fontSize: 11, color: MUTED, marginTop: 2 }}>
                Signed in via Ed25519 wallet signature. All writes proxied through /api/admin.
              </div>
            </div>
            <div style={{
              ...mono,
              padding: '6px 12px',
              background: `${roleColor}14`,
              border: `1px solid ${roleColor}55`,
              borderRadius: 7,
              color: roleColor, fontSize: 10, fontWeight: 700, letterSpacing: 2,
            }}>
              {roleLabel} · {shortAddr(pubkey, 4, 4)}
            </div>
          </div>
        </div>

        {/* Analytics — pinned top */}
        <V2AnalyticsPanel />

        {/* Buy bot */}
        <V2BotPanel />

        {/* Spotlight carousel images */}
        <SpotlightPanel />

        {/* Announcements — pinned bottom */}
        <AnnouncementsPanel items={announcements} reload={reloadAnnouncements} />
      </div>
    </div>
  );
}

// ─── shared inline-style helpers (kept colocated so the file is self-contained) ───
const fieldStyle = {
  ...mono,
  fontFamily: 'Sora, sans-serif' as const,
  padding: '8px 10px',
  background: 'rgba(0,0,0,.3)',
  border: `1px solid ${LINE}`,
  borderRadius: 6,
  color: TEXT,
  fontSize: 12,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box' as const,
};
const primaryBtn = (busy: boolean) => ({
  ...mono,
  padding: '9px 0', width: '100%',
  background: busy ? 'transparent' : `${ACCENT}1a`,
  border: `1px solid ${ACCENT}80`,
  borderRadius: 6,
  color: ACCENT, fontSize: 10, fontWeight: 700, letterSpacing: 2,
  cursor: busy ? 'not-allowed' : 'pointer',
});
const miniBadBtn = {
  ...mono, padding: '5px 10px', borderRadius: 5,
  background: `${BAD}10`, border: `1px solid ${BAD}55`,
  color: BAD, fontSize: 9, fontWeight: 700, letterSpacing: 1, cursor: 'pointer',
};
const statusStyle = {
  ...mono, fontFamily: 'Sora, sans-serif' as const,
  marginTop: 8, padding: '8px 12px',
  background: 'rgba(255,255,255,.02)', border: `1px solid ${LINE}`,
  borderRadius: 5, fontSize: 11, color: TEXT,
};
