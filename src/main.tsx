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

// Remove the pre-mount splash only AFTER the first styled frame. React's passive
// effects (which inject each page's <style>) run after the first paint, so the
// unstyled DOM paints once — but it's hidden behind #boot. We wait two rAFs
// (past that post-effect paint), then fade the splash out to reveal styled UI.
// Hard fallback timeout guarantees removal even if a frame is dropped.
const boot = document.getElementById('boot');
if (boot) {
  const hide = () => {
    if (boot.classList.contains('hide')) return;
    boot.classList.add('hide');
    setTimeout(() => boot.remove(), 300);
  };
  requestAnimationFrame(() => requestAnimationFrame(hide));
  setTimeout(hide, 2000);
}
