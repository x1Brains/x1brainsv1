import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import ErrorBoundary from './ErrorBoundary';
import { X1BChatProvider } from './X1BChat';
import V2NfaConsent from './V2NfaConsent';

export default function V2Layout() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile menu when route changes
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  return (
    <X1BChatProvider>
      <V2NfaConsent />
      <div className="bg-grid" />
      <div className="bg-glow bg-glow-orange" />
      <div className="bg-glow bg-glow-cyan" />
      <div className="bg-glow bg-glow-purple" />
      <div className={`app${mobileOpen ? ' mobile-open' : ''}`}>
        <Sidebar />
        {mobileOpen && (
          <div
            className="mobile-overlay"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        )}
        <div className="main">
          <button
            type="button"
            className="mobile-toggle"
            aria-label="Toggle menu"
            onClick={() => setMobileOpen(v => !v)}
          >
            <span /><span /><span />
          </button>
          <Header />
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
    </X1BChatProvider>
  );
}
