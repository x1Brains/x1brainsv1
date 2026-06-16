import { FC, Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import V2Charts from './pages/V2Charts';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import { RPC_ENDPOINT } from './constants';
import { injectGlobalCSS } from './utils/globalStyles';
import { usePageView } from './hooks/usePageView';
import './App.css';

import V2Layout from './components/V2Layout';

// v2 pages — home eager (always paints), others lazy (insulate from module-load throws)
import V2Home from './pages/V2Home';
import V2Placeholder from './pages/V2Placeholder';
import V2Swap from './pages/V2Swap';

const V2LabWork     = lazy(() => import('./pages/V2LabWork'));
const V2LpPools     = lazy(() => import('./pages/V2LpPools'));
const V2LpPairing   = lazy(() => import('./pages/V2LpPairing'));
const V2Portfolio   = lazy(() => import('./pages/V2Portfolio'));
const V2Incinerator = lazy(() => import('./pages/V2Incinerator'));
const V2MintLabWork = lazy(() => import('./pages/V2MintLabWork'));
const V2BurnHistory = lazy(() => import('./pages/V2BurnHistory'));
const V2Admin       = lazy(() => import('./pages/V2Admin'));

const LoadingScreen: FC = () => (
  <div style={{
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#080c0f', color: '#f29030',
    fontFamily: 'Orbitron, monospace', fontSize: 12, letterSpacing: 3, textTransform: 'uppercase',
  }}>
    Loading…
  </div>
);

const AppInner: FC = () => {
  usePageView();
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        {/* ── All public routes wrapped in v2 persistent layout ── */}
        <Route element={<V2Layout />}>
          <Route path="/"                    element={<V2Home />} />
          <Route path="/swap"                element={<V2Swap />} />
          <Route path="/labwork"             element={<V2LabWork />} />
          <Route path="/mint-labwork"        element={<V2MintLabWork />} />
          <Route path="/labworkdefi"         element={<V2LpPairing />} />
          <Route path="/lpfarms"             element={<V2LpPools />} />
          <Route path="/charts"              element={<V2Charts />} />
          <Route path="/portfolio"           element={<V2Portfolio />} />
          <Route path="/incinerator-engine"  element={<V2Incinerator />} />
          <Route path="/cyberdyne"           element={<V2Placeholder />} />
          <Route path="/burn-history"        element={<V2BurnHistory />} />
          <Route path="/admin"               element={<V2Admin />} />
          {/* Old v1 brains_pairing pools page deprecated — redirect to the LP Pairing
              Pools & Charts page (BRAINS + LB, swap/deposit/withdraw). */}
          <Route path="/pairing-pools"       element={<Navigate to="/charts" replace />} />
          <Route path="/home"                element={<V2Placeholder />} />
        </Route>

        {/* Back-compat: old obfuscated v1 + intermediate admin URLs all land at /admin now. */}
        <Route path="/x9b7r41ns/analytics" element={<Navigate to="/admin" replace />} />
        <Route path="/x9b7r41ns/bot"       element={<Navigate to="/admin" replace />} />
        <Route path="/admin/analytics"     element={<Navigate to="/admin" replace />} />
        <Route path="/admin/bot"           element={<Navigate to="/admin" replace />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
};

const App: FC = () => {
  useEffect(() => { injectGlobalCSS(); }, []);
  const wallets: any[] = [];
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <AppInner />
          </BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

export default App;
