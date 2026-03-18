// src/hooks/usePageView.ts
// ─────────────────────────────────────────────────────────────────────────────
// Unified analytics tracker — page views + custom events
// Tracks: route changes, tab clicks, wallet connect/disconnect,
//         burn tx views, button clicks
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

// Don't track admin pages
const EXCLUDED_PATHS = ['/x9b7r41ns/ctrl', '/x9b7r41ns/analytics'];

// ─── DEVICE / BROWSER / OS DETECTION ─────────────────────────────────────────
function getDeviceType(): string {
  const ua = navigator.userAgent;
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

function getBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox'))                    return 'Firefox';
  if (ua.includes('Edg/'))                       return 'Edge';
  if (ua.includes('Chrome'))                     return 'Chrome';
  if (ua.includes('Safari'))                     return 'Safari';
  if (ua.includes('Opera') || ua.includes('OPR')) return 'Opera';
  return 'Other';
}

function getOS(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Win'))                        return 'Windows';
  if (ua.includes('Mac'))                        return 'macOS';
  if (ua.includes('Linux'))                      return 'Linux';
  if (ua.includes('Android'))                    return 'Android';
  if (ua.includes('iPhone') || ua.includes('iPad')) return 'iOS';
  return 'Other';
}

// ─── SESSION ID ───────────────────────────────────────────────────────────────
export function getSessionId(): string {
  try {
    let sid = sessionStorage.getItem('x1b_sid');
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('x1b_sid', sid);
    }
    return sid;
  } catch {
    return 'unknown';
  }
}

// ─── GEO CACHE — fetch once per session ──────────────────────────────────────
let _geoCache: { country: string; city: string; region: string } | null = null;

async function getGeo() {
  if (_geoCache) return _geoCache;
  try {
    const r = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const g = await r.json();
      _geoCache = {
        country: g.country_name ?? 'Unknown',
        city:    g.city         ?? 'Unknown',
        region:  g.region       ?? 'Unknown',
      };
      return _geoCache;
    }
  } catch {}
  return { country: 'Unknown', city: 'Unknown', region: 'Unknown' };
}

// ─── GLOBAL EVENT LOGGER — callable from anywhere in the app ─────────────────
// Usage: logEvent('tab_click', 'navigation', 'WINNERS tab', '/burn-history')
//        logEvent('wallet_connect', 'wallet', walletAddress, '/')
//        logEvent('burn_tx_view', 'interaction', txSig, '/burn-history')
export async function logEvent(
  eventType: string,
  category:  string,
  label:     string,
  path?:     string,
  value?:    string,
): Promise<void> {
  try {
    const { insertSiteEvent } = await import('../lib/supabase');
    await insertSiteEvent({
      session_id: getSessionId(),
      event_type: eventType,
      category,
      label,
      value,
      path:      path ?? window.location.pathname,
      fired_at:  new Date().toISOString(),
    });
  } catch {}
}

// ─── WALLET EVENT TRACKER ────────────────────────────────────────────────────
// Call these from anywhere wallet connect/disconnect happens
export function trackWalletConnect(walletAddress: string) {
  logEvent('wallet_connect', 'wallet', walletAddress.slice(0, 8) + '…' + walletAddress.slice(-6));
}

export function trackWalletDisconnect() {
  logEvent('wallet_disconnect', 'wallet', 'disconnected');
}

// ─── TAB CLICK TRACKER ───────────────────────────────────────────────────────
// Call this when a user clicks a tab inside a page
// e.g. onClick={() => { setTab('winners'); trackTabClick('WINNERS', '/burn-history'); }}
export function trackTabClick(tabName: string, path?: string) {
  logEvent('tab_click', 'navigation', tabName, path);
}

// ─── BUTTON CLICK TRACKER ────────────────────────────────────────────────────
// Generic button tracker for important CTAs
export function trackButtonClick(label: string, path?: string) {
  logEvent('button_click', 'interaction', label, path);
}

// ─── AUTO DOM CLICK LISTENER ─────────────────────────────────────────────────
// Automatically captures clicks on elements with data-track="label" attribute
// Add data-track="Burn BRAINS" to any button/link you want tracked without code changes
function useAutoTrack(path: string) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest('[data-track]') as HTMLElement | null;
      if (!el) return;
      const label = el.getAttribute('data-track') ?? 'unknown';
      logEvent('button_click', 'auto', label, path);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [path]);
}

// ─── MAIN HOOK ────────────────────────────────────────────────────────────────
export function usePageView() {
  const location  = useLocation();
  const lastPath  = useRef<string>('');
  const path      = location.pathname;

  // Auto DOM click tracking
  useAutoTrack(path);

  // Page view tracking
  useEffect(() => {
    if (EXCLUDED_PATHS.some(p => path.startsWith(p))) return;
    if (path === lastPath.current) return;
    lastPath.current = path;

    (async () => {
      try {
        const geo = await getGeo();
        const { upsertPageView } = await import('../lib/supabase');
        await upsertPageView({
          path,
          referrer:   document.referrer ? (() => { try { return new URL(document.referrer).hostname; } catch { return document.referrer; } })() : 'direct',
          country:    geo.country,
          city:       geo.city,
          region:     geo.region,
          device:     getDeviceType(),
          browser:    getBrowser(),
          os:         getOS(),
          session_id: getSessionId(),
          visited_at: new Date().toISOString(),
        });
      } catch {}
    })();
  }, [path]);
}