// X1B chat widget — a floating, draggable, resizable chat panel for talking to
// XT0 (the free tier). Wired live to the shared x1city cf-worker at
// api.x1.city/chat via src/lib/xt0Client.ts (Ed25519 wallet-sig auth, SSE
// stream). Geometry (position + size) and the conversation persist to
// localStorage, so closing (X) keeps everything and reopening from the sidebar
// X1B button restores the same spot, size, and history.

import {
  createContext, useContext, useState, useEffect, useRef, useCallback,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  getChatAuth, streamXt0Chat, getDailyCount, bumpDailyCount,
  XT0_DAILY_CAP, X1B_PREMIUM_URL, type ApiMessage,
} from '../lib/xt0Client';

type Role = 'user' | 'x1b' | 'sys';
interface Msg { id: number; role: Role; text: string; }

// Render XT0 text with clickable links: markdown [label](url) and bare http(s)
// URLs become real anchors (new tab). Everything else stays plain text. Keeps
// the widget dependency-free — no markdown library.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s)]+)/g;
function renderRich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, i = 0;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const href  = m[2] ?? m[3];
    const label = m[1] ?? m[3];
    out.push(
      <a key={`lk${i++}`} href={href} target="_blank" rel="noopener noreferrer"
         style={{ color: '#f29030', textDecoration: 'underline', wordBreak: 'break-word' }}>
        {label}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
interface Geom { x: number; y: number; w: number; h: number; }

const STORE_KEY = 'x1b_chat_v1';
const MIN_W = 300;
const MIN_H = 360;

function defaultGeom(): Geom {
  const vw = typeof window !== 'undefined' ? window.innerWidth  : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  // Clamp to the viewport so the widget never opens off-screen on phones.
  const w = Math.min(380, vw - 24);
  const h = Math.min(540, vh - 120);
  const margin = vw < 600 ? 12 : 28;
  const x = Math.max(12, vw - w - margin);
  return { x, y: vw < 600 ? 70 : 84, w, h };
}

function loadState(): { geom: Geom; messages: Msg[] } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p?.geom && Array.isArray(p.messages)) {
        return { geom: { ...defaultGeom(), ...p.geom }, messages: p.messages };
      }
    }
  } catch { /* ignore */ }
  return { geom: defaultGeom(), messages: [] };
}

// ── Context: lets the sidebar (or anything) open/toggle the widget ──────────
interface ChatCtx { open: () => void; toggle: () => void; isOpen: boolean; }
const Ctx = createContext<ChatCtx>({ open: () => {}, toggle: () => {}, isOpen: false });
export const useX1BChat = () => useContext(Ctx);

export function X1BChatProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const toggle = useCallback(() => setIsOpen((o) => !o), []);
  return (
    <Ctx.Provider value={{ open, toggle, isOpen }}>
      {children}
      <X1BChatWidget isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </Ctx.Provider>
  );
}

// ── Widget ──────────────────────────────────────────────────────────────────
function X1BChatWidget({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const initial = useRef(loadState());
  const [geom, setGeom] = useState<Geom>(initial.current.geom);
  const [messages, setMessages] = useState<Msg[]>(initial.current.messages);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(initial.current.messages.reduce((m, x) => Math.max(m, x.id), 0) + 1);

  const { publicKey, signMessage, connected } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [usedToday, setUsedToday] = useState(0);
  const [capped, setCapped] = useState(false);

  // Sync the daily counter whenever the wallet changes or the panel opens.
  useEffect(() => {
    if (!wallet) { setUsedToday(0); setCapped(false); return; }
    const n = getDailyCount(wallet);
    setUsedToday(n);
    setCapped(n >= XT0_DAILY_CAP);
  }, [wallet, isOpen]);

  const pushSys = useCallback(
    (text: string) => setMessages((m) => [...m, { id: nextId.current++, role: 'sys', text }]),
    [],
  );

  // Persist geometry + conversation on every change.
  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ geom, messages })); } catch { /* ignore */ }
  }, [geom, messages]);

  // Keep scrolled to the latest message.
  useEffect(() => {
    if (isOpen && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, thinking, isOpen]);

  // ── Drag (via header) — stable window listeners so removal works ──
  const dragOff = useRef<{ dx: number; dy: number } | null>(null);
  const onDragMove = useCallback((e: MouseEvent) => {
    if (!dragOff.current) return;
    const { dx, dy } = dragOff.current;
    setGeom((g) => {
      const x = Math.min(window.innerWidth - 90, Math.max(-(g.w - 90), e.clientX - dx));
      const y = Math.min(window.innerHeight - 40, Math.max(0, e.clientY - dy));
      return { ...g, x, y };
    });
  }, []);
  const onDragUp = useCallback(() => {
    dragOff.current = null;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragUp);
  }, [onDragMove]);
  const onDragDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // don't drag from buttons
    dragOff.current = { dx: e.clientX - geom.x, dy: e.clientY - geom.y };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragUp);
    e.preventDefault();
  };

  // ── Resize (via corner handle) ──
  const resizeStart = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null);
  const onResizeMove = useCallback((e: MouseEvent) => {
    const r = resizeStart.current;
    if (!r) return;
    setGeom((g) => ({
      ...g,
      w: Math.max(MIN_W, r.sw + (e.clientX - r.sx)),
      h: Math.max(MIN_H, r.sh + (e.clientY - r.sy)),
    }));
  }, []);
  const onResizeUp = useCallback(() => {
    resizeStart.current = null;
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', onResizeUp);
  }, [onResizeMove]);
  const onResizeDown = (e: React.MouseEvent) => {
    resizeStart.current = { sx: e.clientX, sy: e.clientY, sw: geom.w, sh: geom.h };
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', onResizeUp);
    e.preventDefault();
    e.stopPropagation();
  };

  const send = async () => {
    const text = input.trim();
    if (!text || thinking) return;

    if (!connected || !wallet || !signMessage) {
      pushSys('Connect your X1 wallet to chat with XT0 — you’ll sign one message to verify it’s you.');
      return;
    }
    if (getDailyCount(wallet) >= XT0_DAILY_CAP) { setCapped(true); return; }
    if (text.length > 4000) { pushSys('Message too long — split it up (4000 char max).'); return; }

    const userMsg: Msg = { id: nextId.current++, role: 'user', text };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setThinking(true);

    // One-time wallet signature (cached in sessionStorage, re-signed every ~5h).
    let auth;
    try {
      auth = await getChatAuth(wallet, signMessage);
    } catch {
      setThinking(false);
      pushSys('Signature declined — XT0 needs a one-time wallet signature to verify you.');
      return;
    }

    // Send the last few real turns (keep the free-tier prompt window small).
    const history: ApiMessage[] = [...messages, userMsg]
      .filter((x) => x.role === 'user' || x.role === 'x1b')
      .slice(-12)
      .map((x) => ({ role: x.role === 'x1b' ? 'assistant' : 'user', content: x.text }));

    const replyId = nextId.current++;
    const appendReply = (t: string) =>
      setMessages((m) => (m.some((x) => x.id === replyId)
        ? m.map((x) => (x.id === replyId ? { ...x, text: x.text + t } : x))
        : [...m, { id: replyId, role: 'x1b', text: t }]));

    // Only a fully-streamed reply counts against the free daily quota — a
    // declined signature, expired session, rate-cap, or network error must not.
    await streamXt0Chat(auth, history, {
      onDelta: (t) => { setThinking(false); appendReply(t); },
      onDone: () => {
        setThinking(false);
        const n = bumpDailyCount(wallet);
        setUsedToday(n);
        if (n >= XT0_DAILY_CAP) setCapped(true);
      },
      onError: (status, body) => {
        setThinking(false);
        if (status === 429) { setCapped(true); return; } // server-side cap (50/day)
        if (status === 401) {
          try { sessionStorage.removeItem(`xt0_auth_${wallet}`); } catch { /* ignore */ }
          pushSys('Session expired — send again to re-sign.');
          return;
        }
        if (status === 0) {
          pushSys('Couldn’t reach XT0 — check your connection and try again.');
          return;
        }
        pushSys(`XT0 error (${status}) — ${body?.slice(0, 160) || 'try again.'}`);
      },
    });
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="x1b-chat" style={{ left: geom.x, top: geom.y, width: geom.w, height: geom.h }}>
      <div className="x1b-chat-head" onMouseDown={onDragDown}>
        <div className="x1b-chat-id">
          <span className="x1b-orb" />
          <div>
            <div className="x1b-name">X1B <span className="x1b-tier">XT0 · FREE</span></div>
            <div className="x1b-status">
              {wallet
                ? `${Math.max(0, XT0_DAILY_CAP - usedToday)} / ${XT0_DAILY_CAP} free today`
                : 'connect wallet'}
            </div>
          </div>
        </div>
        <div className="x1b-chat-actions">
          <button type="button" className="x1b-mini" title="Clear conversation"
            onClick={() => { setMessages([]); nextId.current = 1; }}>⌫</button>
          <button type="button" className="x1b-mini close" title="Close (keeps chat)"
            onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="x1b-chat-body" ref={bodyRef}>
        {messages.length === 0 && !thinking && (
          <div className="x1b-empty">
            <div className="x1b-empty-glyph">⌬</div>
            <div>Hi, I’m XT0 — ask me about X1.City, X1Brains, prices, or how things work.</div>
            <div className="x1b-empty-note">
              {wallet ? `Free tier · ${XT0_DAILY_CAP} messages / day` : 'Connect your X1 wallet to start.'}
            </div>
          </div>
        )}
        {messages.map((m) => (
          m.role === 'sys'
            ? <div key={m.id} className="x1b-sys">{m.text}</div>
            : (
              <div key={m.id} className={`x1b-msg ${m.role}`}>
                {m.role === 'x1b' && <span className="x1b-msg-tag">XT0</span>}
                <div className="x1b-bubble">{m.role === 'x1b' ? renderRich(m.text) : m.text}</div>
              </div>
            )
        ))}
        {thinking && (
          <div className="x1b-msg x1b">
            <span className="x1b-msg-tag">XT0</span>
            <div className="x1b-bubble x1b-typing"><span /><span /><span /></div>
          </div>
        )}
      </div>

      {capped ? (
        <div className="x1b-capped">
          <div className="x1b-capped-title">Daily free limit reached</div>
          <div className="x1b-capped-sub">
            You’ve used your {XT0_DAILY_CAP} free XT0 messages today. The premium X1B
            terminal has no daily cap — it runs on credits you top up by burning LB or BRAINS.
          </div>
          <a className="x1b-capped-btn" href={X1B_PREMIUM_URL} target="_blank" rel="noopener noreferrer">
            Open X1B Premium →
          </a>
        </div>
      ) : (
        <div className="x1b-chat-input">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder={wallet ? 'Message XT0…' : 'Connect wallet to chat…'}
          />
          <button type="button" onClick={send} disabled={!input.trim() || thinking}>➤</button>
        </div>
      )}

      <div className="x1b-resize" onMouseDown={onResizeDown} title="Drag to resize" />
    </div>,
    document.body,
  );
}

