import './polyfills';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { injectGlobalCSS } from './utils/globalStyles';

// Inject global body/font/wallet-adapter CSS SYNCHRONOUSLY, before the first
// render, so the app chrome paints styled. Page-level styles (V2Home etc.) are
// still injected in useEffect (after first paint) — the #boot splash below
// covers that gap. injectGlobalCSS is idempotent (App.tsx also calls it).
injectGlobalCSS();

// StrictMode intentionally omitted: React 19 double-mount races the
// wallet-adapter handshake (Backpack approves but state never reconciles).
createRoot(document.getElementById('root')!).render(<App />);

// Remove the pre-mount splash only once the app signals a fully-styled frame has
// painted ('app-styled', dispatched from V2Layout after the global + page <style>
// injections have run). The old approach hid the splash after a fixed 2-rAF count,
// which on slow mobile fired DURING the unstyled window — exposing raw DOM until
// the useEffect-injected page CSS landed (~1s FOUC). The event makes removal track
// the actual styled paint instead of a frame guess. Hard fallback guarantees the
// splash never sticks if the signal is somehow missed.
const boot = document.getElementById('boot');
if (boot) {
  const hide = () => {
    if (boot.classList.contains('hide')) return;
    boot.classList.add('hide');
    setTimeout(() => boot.remove(), 300);
  };
  window.addEventListener('app-styled', hide, { once: true });
  setTimeout(hide, 3000);
}
