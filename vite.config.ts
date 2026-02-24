import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
  optimizeDeps: {
    include: ['buffer'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  server: {
    headers: {
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        [
          "connect-src 'self'",
          "http://jack-nucbox-m6-ultra.tail515dc.ts.net:8773",
          "https://rpc.mainnet.x1.xyz",
          "https://api.xdex.xyz",
          "https://app.xdex.xyz",
          "https://gateway.pinata.cloud",
          "https://ipfs.io",
          "https://cloudflare-ipfs.com",
          "https://dweb.link",
          "https://nftstorage.link",
          "https://raw.githubusercontent.com",
          "https://mint.xdex.xyz",
          "https://xbchrxxfnzhsbpncfiar.supabase.co",
        ].join(' '),
        "img-src 'self' data: blob: https: http:",
        "worker-src 'self' blob:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
      ].join('; '),
    },
    proxy: {
      // ── xDex price proxy ─────────────────────────────────────────────────
      '/api/xdex-price': {
        target: 'https://api.xdex.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/xdex-price/, ''),
      },
      // ── NFT metadata proxy ───────────────────────────────────────────────
      '/api/nft-meta': {
        target: 'https://x1punks.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nft-meta\/[^/]+/, ''),
        router: (req) => {
          const stripped = (req.url ?? '').replace(/^\/api\/nft-meta\//, '');
          const host = stripped.split('/')[0];
          return 'https://' + host;
        },
      },
      // ── Imperial API — CORS enabled, direct fetch. No proxy needed. ──────
      // Keeping this as a fallback in case CORS is ever restricted.
      '/imperial': {
        target: 'http://jack-nucbox-m6-ultra.tail515dc.ts.net:8773',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/imperial/, '/api'),
      },
    },
  },
});
