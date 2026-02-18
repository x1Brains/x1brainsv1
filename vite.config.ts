import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ─────────────────────────────────────────────────────────────────────────────
// CORS PROXY for NFT metadata + images in local dev
//
// NFT servers like x1punks.xyz don't set CORS headers.
// Requests are routed through Vite's server-side proxy:
//
//   Browser:  GET /cors-proxy/x1punks.xyz/api/metadata/123
//   Vite:     GET https://x1punks.xyz/api/metadata/123  (no CORS restriction)
//
// LabWork.tsx builds these URLs automatically when on localhost.
// In production, requests go direct — no proxy needed.
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      '/cors-proxy': {
        // Dummy target — overridden per-request in configure()
        target: 'https://x1punks.xyz',
        changeOrigin: true,
        secure: false,

        rewrite: (path) => {
          // /cors-proxy/x1punks.xyz/api/metadata/123
          // → /api/metadata/123
          const parts = path.replace(/^\/cors-proxy\//, '').split('/');
          return '/' + parts.slice(1).join('/');
        },

        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Parse host out of the URL: /cors-proxy/x1punks.xyz/path
            const m = (req.url ?? '').match(/^\/cors-proxy\/([^/?#]+)(.*)/);
            if (!m) return;
            const host = m[1];  // e.g. "x1punks.xyz"
            const rest = m[2] || '/';

            proxyReq.setHeader('host', host);
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');

            // Redirect the underlying socket destination
            const o = (proxyReq as any)._options;
            if (o) {
              o.hostname = host;
              o.host     = host;
              o.path     = rest;
              o.protocol = 'https:';
              o.port     = 443;
            }
          });

          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['access-control-allow-origin']  = '*';
            proxyRes.headers['access-control-allow-methods'] = 'GET, HEAD, OPTIONS';
            proxyRes.headers['access-control-allow-headers'] = '*';
            delete proxyRes.headers['x-frame-options'];
            delete proxyRes.headers['content-security-policy'];
          });

          proxy.on('error', (_err, req) => {
            console.error('[cors-proxy] failed:', req.url);
          });
        },
      },
    },
  },
});