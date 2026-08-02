import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// DEV-ONLY mirror of the `/api/nft-meta/(.*)` → `https://$1` rewrite in
// vercel.json. Production never reads this file.
//
// This used to be a `server.proxy` entry with a `router` callback meant to pick
// the upstream host out of the path. But `router` is an http-proxy-MIDDLEWARE
// option and Vite's `server.proxy` doesn't implement it — it was silently
// ignored, so every metadata fetch went to the hardcoded
// `target: 'https://x1punks.xyz'`, which answers any path with its SPA
// index.html and a 200. `fetchNFTMeta` then failed on `res.json()` and returned
// null, so NFT images never resolved locally (the Brains Elites banner sat on
// its static fallback instead of rotating through the live listings).
//
// A middleware avoids the problem entirely: the upstream is chosen per request,
// and redirects are followed (arweave.net 302s to a subdomain gateway) so the
// caller gets the final JSON rather than a redirect body.
function nftMetaDevProxy() {
  return {
    name: 'nft-meta-dev-proxy',
    configureServer(server: any) {
      server.middlewares.use('/api/nft-meta', async (req: any, res: any) => {
        const rest = (req.url ?? '').replace(/^\//, '');
        if (!rest) { res.statusCode = 400; res.end('missing upstream'); return; }
        try {
          const upstream = await fetch('https://' + rest, { redirect: 'follow' });
          const body = Buffer.from(await upstream.arrayBuffer());
          res.statusCode = upstream.status;
          res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
          res.setHeader('access-control-allow-origin', '*');
          res.end(body);
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), nftMetaDevProxy()],
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
    esbuildOptions: { target: 'esnext' },
  },
  build: {
    target: 'esnext',
    commonjsOptions: { transformMixedEsModules: true },
  },
  server: {
    proxy: {
      '/api/xdex-price': {
        target: 'https://api.xdex.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/xdex-price/, ''),
      },
      // '/api/nft-meta' is handled by nftMetaDevProxy() above, not here —
      // server.proxy can't pick a target per request.
      '/imperial': {
        target: 'http://jack-nucbox-m6-ultra.tail515dc.ts.net:8773',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/imperial/, '/api'),
      },
      // Solaris Prime indexer — public X1 NFT metadata source
      '/api/solaris': {
        target: 'https://solarisprime.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/solaris/, '/api/indexer'),
      },
    },
  },
});
