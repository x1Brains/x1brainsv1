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
    proxy: {
      '/api/xdex-price': {
        target: 'https://api.xdex.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/xdex-price/, ''),
      },
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
    },
  },
});