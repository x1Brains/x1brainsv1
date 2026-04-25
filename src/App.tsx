import React, { FC, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import { RPC_ENDPOINT } from './constants';
import { injectGlobalCSS } from './utils/globalStyles';
import Home                from './pages/Home';
import Portfolio           from './pages/Portfolio';
import LabWork             from './pages/LabWork';
import CyberdyneUnlimited  from './pages/CyberdyneUnlimited';
import BurnHistory         from './pages/BurnHistory';
import RewardsSeason       from './pages/RewardsSeason';
import AdminRewards        from './pages/AdminRewards';
import IncineratorEngine   from './pages/IncineratorEngine';
import AnalyticsDashboard  from './pages/AnalyticsDashboard';
import BotAdmin            from './pages/BotAdmin';
import LabWorkDefi         from './pages/LabWorkDefi';
import LpFarms             from './pages/LpFarms';
import { usePageView }     from './hooks/usePageView';

// Inner component so usePageView() can access the router context
const AppInner: FC = () => {
  usePageView(); // fires on every route change — logs to Supabase page_views
  return (
    <Routes>
      <Route path="/"                       element={<Home />} />
      <Route path="/portfolio"              element={<Portfolio />} />
      <Route path="/labwork"                element={<LabWork />} />
      <Route path="/labworkdefi"            element={<LabWorkDefi />} />
      <Route path="/lpfarms"               element={<LpFarms />} />
      <Route path="/cyberdyne"              element={<CyberdyneUnlimited />} />
      <Route path="/burn-history"           element={<BurnHistory />} />
      <Route path="/incinerator-engine"     element={<IncineratorEngine />} />
      <Route path="/rewards"               element={<RewardsSeason />} />
      <Route path="/x9b7r41ns/ctrl"         element={<AdminRewards />} />
      <Route path="/x9b7r41ns/analytics"    element={<AnalyticsDashboard />} />
      <Route path="/x9b7r41ns/bot"          element={<BotAdmin />} />
      <Route path="*"                       element={<Navigate to="/" replace />} />
    </Routes>
  );
};

const App: FC = () => {
  useEffect(() => { injectGlobalCSS(); }, []);
  const wallets: any[] = [];
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect={false}>
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