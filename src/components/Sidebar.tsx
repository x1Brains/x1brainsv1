import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Link, useLocation } from 'react-router-dom';
import { BRAINS_LOGO } from '../constants';
import { ADMIN_WALLETS } from '../lib/admin';
import { useX1BChat } from './X1BChat';

type SubItem = { label: string; to: string };
type InternalItem = { icon: string; label: string; to: string; children?: SubItem[] };
type ExternalItem = { icon: string; label: string; href: string };
type ActionItem = { icon: string; label: string; action: 'x1bChat' };
type NavItem = InternalItem | ExternalItem | ActionItem;

type NavSection = { title: string; items: NavItem[] };

const sections: NavSection[] = [
  {
    title: 'Explore LabWork',
    items: [
      { icon: '◆', label: 'NFT Marketplace', to: '/labwork' },
      { icon: '⟠', label: 'LP Farms',        to: '/lpfarms' },
      { icon: '◈', label: 'LP Pairing',      to: '/labworkdefi', children: [
        { label: 'Pools & Charts', to: '/charts' },
      ] },
      { icon: '⌬', label: 'Mint LabWork',    to: '/mint-labwork' },
    ],
  },
  {
    title: 'Brains',
    items: [
      { icon: '⊞', label: 'Portfolio',  to: '/portfolio' },
      { icon: '⟷', label: 'Swap',       to: '/swap' },
      { icon: '☄', label: 'Incinerator', to: '/incinerator-engine' },
      { icon: '⬢', label: 'X1City',     href: 'https://x1city.io/' },
      { icon: '⌬', label: 'X1B',        action: 'x1bChat' },
    ],
  },
];

const ADMIN_SECTION: NavSection = {
  title: 'Console',
  items: [
    { icon: '⚙', label: 'Admin', to: '/admin' },
  ],
};

function isExternal(item: NavItem): item is ExternalItem {
  return 'href' in item;
}

function isAction(item: NavItem): item is ActionItem {
  return 'action' in item;
}

function shortAddr(s: string): string {
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

export default function Sidebar() {
  const { publicKey, disconnect, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const location = useLocation();
  const { open: openX1BChat, isOpen: x1bChatOpen } = useX1BChat();

  const onWalletClick = () => {
    if (connected) disconnect();
    else setVisible(true);
  };

  const isAdmin = !!publicKey && ADMIN_WALLETS.has(publicKey.toBase58());
  const visibleSections = isAdmin ? [...sections, ADMIN_SECTION] : sections;

  return (
    <aside className="sidebar">
      <Link to="/" className="sidebar-brand" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="logo-wrap">
          <div className="glow" />
          <img src={BRAINS_LOGO} alt="X1 Brains" className="logo logo-img" />
        </div>
        <div className="brand-text">
          <div className="brand-title-row">
            <h1>X1 Brains</h1>
            <span className="brand-v2">V2</span>
          </div>
          <div className="sub">LabWork · X1City</div>
        </div>
      </Link>

      <nav className="sidebar-nav">
        {visibleSections.map((section) => (
          <div key={section.title}>
            <div className="nav-section-label">{section.title}</div>
            {section.items.map((item) => {
              if (isExternal(item)) {
                return (
                  <a
                    key={item.label}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="nav-item"
                  >
                    <span className="icon">{item.icon}</span> {item.label}
                    <span className="nav-ext" aria-hidden="true">↗</span>
                  </a>
                );
              }
              if (isAction(item)) {
                return (
                  <button
                    key={item.label}
                    type="button"
                    className={`nav-item${x1bChatOpen ? ' active' : ''}`}
                    onClick={openX1BChat}
                    style={{ width: '100%', textAlign: 'left', fontFamily: 'inherit', background: 'none' }}
                  >
                    <span className="icon">{item.icon}</span> {item.label}
                  </button>
                );
              }
              const isActive = location.pathname === item.to;
              const children = item.children;
              const childActive = children?.some((c) => location.pathname === c.to) ?? false;
              const expanded = isActive || childActive;
              return (
                <div key={item.label}>
                  <Link
                    to={item.to}
                    className={`nav-item${isActive ? ' active' : ''}`}
                  >
                    <span className="icon">{item.icon}</span> {item.label}
                    {children && <span className="nav-caret">{expanded ? '▾' : '▸'}</span>}
                  </Link>
                  {children && expanded && (
                    <div className="nav-subgroup">
                      {children.map((c) => (
                        <Link
                          key={c.to}
                          to={c.to}
                          className={`nav-subitem${location.pathname === c.to ? ' active' : ''}`}
                        >
                          {c.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div
          className="wallet-info"
          onClick={onWalletClick}
          style={{ cursor: 'pointer', userSelect: 'none' }}
          title={connected ? 'Click to disconnect' : 'Click to connect wallet'}
        >
          <span
            className="wallet-dot"
            style={connected ? undefined : { background: '#5c7a90', boxShadow: 'none', animation: 'none' }}
          />
          <span className="wallet-addr">
            {publicKey ? shortAddr(publicKey.toBase58()) : 'CONNECT WALLET'}
          </span>
        </div>
      </div>
    </aside>
  );
}
