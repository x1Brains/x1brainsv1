import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { Link, useLocation } from 'react-router-dom';
import { BRAINS_LOGO } from '../constants';
import { ADMIN_WALLETS } from '../lib/admin';
import { useX1BChat } from './X1BChat';

// TEXT-ONLY MENU — no icon glyphs, deliberately.
// The nav used to carry decorative glyphs with a U+FE0E variation selector
// appended to force monochrome rendering. iOS and Android ignore FE0E for
// several of them (☄ U+2604 on Incinerator, ⬢ U+2B22, ↗ U+2197, ⚙ U+2699),
// so they still painted as colour emoji on phones — the comet in particular
// read as a fire emoji next to the burn page. FE0E is not a guarantee on any
// platform, so the glyphs are gone rather than re-patched. Labels only.
type SubItem = { label: string; to: string };
type InternalItem = { label: string; to: string; children?: SubItem[] };
type ExternalItem = { label: string; href: string };
type ActionItem = { label: string; action: 'x1bChat' };
type NavItem = InternalItem | ExternalItem | ActionItem;

type NavSection = { title: string; items: NavItem[] };

const sections: NavSection[] = [
  {
    title: 'Explore LabWork',
    items: [
      { label: 'NFT Marketplace', to: '/labwork' },
      { label: 'LP Farms',        to: '/lpfarms' },
      { label: 'LP Pairing',      to: '/labworkdefi', children: [
        { label: 'Pools & Charts', to: '/charts' },
      ] },
      { label: 'Mint LabWork',    to: '/mint-labwork' },
    ],
  },
  {
    title: 'Brains',
    items: [
      { label: 'Portfolio',   to: '/portfolio' },
      { label: 'Swap',        to: '/swap' },
      { label: 'Incinerator', to: '/incinerator-engine' },
      { label: 'X1City',      href: 'https://x1city.io/' },
      { label: 'X1B',         action: 'x1bChat' },
    ],
  },
];

const ADMIN_SECTION: NavSection = {
  title: 'Console',
  items: [
    { label: 'Admin', to: '/admin' },
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
                    {item.label}
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
                    {item.label}
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
                    {item.label}
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
          className={`wallet-info${connected ? '' : ' wallet-cta'}`}
          onClick={onWalletClick}
          style={{ cursor: 'pointer', userSelect: 'none' }}
          title={connected ? 'Click to disconnect' : 'Click to connect wallet'}
        >
          {/* The disconnected look is driven entirely by `.wallet-cta` in CSS.
              This used to carry an inline grey/no-glow override, which won over
              the stylesheet and left the dot dead while the button pulsed. */}
          <span className="wallet-dot" />
          <span className="wallet-addr">
            {publicKey ? shortAddr(publicKey.toBase58()) : 'CONNECT WALLET'}
          </span>
        </div>
      </div>
    </aside>
  );
}
