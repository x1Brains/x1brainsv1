import './polyfills';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

// StrictMode intentionally omitted: React 19 double-mount races the
// wallet-adapter handshake (Backpack approves but state never reconciles).
createRoot(document.getElementById('root')!).render(<App />);
