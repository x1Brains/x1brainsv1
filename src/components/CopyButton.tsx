// ─────────────────────────────────────────────────────────────────────────────
// One copy-to-clipboard button, used wherever an address is shown truncated.
//
// The app had five separate inline `navigator.clipboard.writeText(...)` buttons
// with no shared behaviour and no feedback. This one gives a consistent tick,
// stops the click from reaching a clickable parent row, and falls back to a
// hidden textarea + execCommand when the Clipboard API is unavailable — which
// it IS on insecure origins (http://<LAN-IP>), the same secure-context rule
// that hides window.crypto.subtle. Without the fallback, copy would silently
// do nothing whenever the app is opened over the LAN.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';

type Props = {
  /** The full value to place on the clipboard. */
  value: string;
  /** Tooltip, e.g. "Copy token address". */
  title?: string;
  /** Icon size in px. */
  size?: number;
  /** Override colour; defaults to inheriting the surrounding text colour. */
  color?: string;
  className?: string;
};

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function CopyButton({ value, title = 'Copy', size = 11, color, className }: Props) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  if (!value) return null;

  const onClick = async (e: React.MouseEvent) => {
    // Rows are often clickable (open a panel, select a token) — copying must
    // not also trigger that.
    e.preventDefault();
    e.stopPropagation();
    const ok = await writeClipboard(value);
    setState(ok ? 'ok' : 'fail');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1400);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title={state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : title}
      aria-label={title}
      className={className}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        marginLeft: 5,
        cursor: 'pointer',
        lineHeight: 1,
        fontSize: size,
        color: state === 'ok' ? '#00c98d' : state === 'fail' ? '#ff4466' : (color ?? 'inherit'),
        opacity: state === 'idle' ? 0.55 : 1,
        transition: 'opacity .15s, color .15s',
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = state === 'idle' ? '0.55' : '1'; }}
    >
      {state === 'ok' ? '✓' : state === 'fail' ? '✕' : '⧉'}
    </button>
  );
}
