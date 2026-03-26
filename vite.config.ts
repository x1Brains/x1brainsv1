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
          // X1 / Solana RPC — both https and wss required for WebSocket subscriptions
          "https://rpc.mainnet.x1.xyz",
          "wss://rpc.mainnet.x1.xyz",
          // xDex
          "https://api.xdex.xyz",
          "https://app.xdex.xyz",
          "https://mint.xdex.xyz",
          // X1Cats API
          "https://api.x1app.fyi",
          // IPFS gateways
          "https://gateway.pinata.cloud",
          "https://ipfs.io",
          "https://cloudflare-ipfs.com",
          "https://dweb.link",
          "https://nftstorage.link",
          // Metadata sources
          "https://raw.githubusercontent.com",
          "https://gist.githubusercontent.com",
          "https://arweave.net",
          "https://*.arweave.net",
          "https://x1punks.xyz",
          "https://apexfaucet.xyz",
          "https://xenblocks.io",
          "https://explorer.xenblocks.io",
          "https://corsproxy.io",
          // Supabase
          "https://xbchrxxfnzhsbpncfiar.supabase.co",
          "wss://xbchrxxfnzhsbpncfiar.supabase.co",
          // Analytics geo
          "https://ipapi.co",
          // Imperial API
          "http://jack-nucbox-m6-ultra.tail515dc.ts.net:8773",
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
      // ── Imperial API ─────────────────────────────────────────────────────
      '/imperial': {
        target: 'http://jack-nucbox-m6-ultra.tail515dc.ts.net:8773',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/imperial/, '/api'),
      },
    },
  },
});