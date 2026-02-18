// Polyfills required by Solana web3.js and wallet-adapter in the browser.
// This file must be imported at the very top of main.tsx (before everything else).
import { Buffer } from 'buffer';

if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
  (window as any).global = window;
  (window as any).process = (window as any).process ?? { env: {}, version: 'v18.0.0', browser: true };
}
