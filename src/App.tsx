import React, { FC, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import { RPC_ENDPOINT } from './constants';
import { injectGlobalCSS } from './utils/globalStyles';
import Home        from './pages/Home';
import Portfolio   from './pages/Portfolio';
import LabWork     from './pages/LabWork';
import MintLabWork from './pages/MintLabWork';

const App: FC = () => {
  useEffect(() => { injectGlobalCSS(); }, []);
  const wallets: any[] = [];
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route path="/"          element={<Home />} />
              <Route path="/portfolio" element={<Portfolio />} />
              <Route path="/lab-work"  element={<LabWork />} />
              <Route path="/mint"      element={<MintLabWork />} />
              <Route path="*"          element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
export default App;
