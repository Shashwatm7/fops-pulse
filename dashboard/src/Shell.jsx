import React, { useState, useEffect, useRef } from 'react';

/* Sidebar + topbar chrome, ported from the FOps Dashboards mockup.
   Structure and metrics are the design's; the data is ours. */

const I = (p) => ({ width: 19, height: 19, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
  strokeLinejoin: 'round', ...p });

const NAV_ICONS = {
  dashboard: <svg {...I()}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
  cycles: <svg {...I()}><path d="M4 4v16h16" /><path d="M7 14l3-4 3 3 4-6" /></svg>,
  suppliers: <svg {...I()}><path d="M3 7h11v9H3z" /><path d="M14 10h4l3 3v3h-7z" /><circle cx="7" cy="18" r="1.7" /><circle cx="17" cy="18" r="1.7" /></svg>,
  reports: <svg {...I()}><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /><path d="M12 12v5" /><path d="M9.5 14.5L12 17l2.5-2.5" /></svg>,
  pulse: <svg {...I()}><path d="M3 12h4l2-7 4 14 2-7h6" /></svg>,
  settings: <svg {...I()}><circle cx="12" cy="12" r="3" /><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /></svg>,
  help: <svg {...I()}><circle cx="12" cy="12" r="9" /><path d="M9.6 9.2a2.4 2.4 0 1 1 3.2 2.3c-.8.3-1.3.9-1.3 1.7" /><circle cx="12" cy="16.6" r=".7" fill="currentColor" stroke="none" /></svg>,
};

function initials(name = '') {
  const p = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (!p.length) return '?';
  return ((p[0][0] || '') + (p[1]?.[0] || '')).toUpperCase();
}

export default function Shell({
  user, onOpenSettings, onOpenAdmin, onOpenAnalytics, onLogout,
  search, onSearch, lastRefresh, loading, onRefresh, alertCount, children,
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);

  // #root is styled as a centred, padded column for the login page. The shell
  // is full-bleed, so opt out of that for as long as it is mounted.
  useEffect(() => {
    const root = document.getElementById('root');
    root?.classList.add('fops-shell');
    return () => root?.classList.remove('fops-shell');
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const nav = [
    { k: 'dashboard', label: 'Dashboard' },
    { k: 'cycles', label: 'Forecast Cycles' },
    { k: 'suppliers', label: 'Suppliers' },
    { k: 'reports', label: 'Reports & Export' },
    { k: 'pulse', label: 'Market Pulse', on: true },
  ];

  return (
    <div className="fp-app">
      <aside className="fp-aside">
        <div className="fp-brand">
          <div className="fp-brand-mark">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M6.6 4.4H16.4V7.9H10.3V11.1H15.4V14.6H10.3V20.2H6.6Z" fill="#F69B29" />
              <path d="M17.3 3C19.3 2.3 21.1 2.9 21.5 5.1C19.5 5.9 17.7 5.3 17.3 3Z" fill="#7DC242" />
              <path d="M17.9 4.5L20.9 3" stroke="#4e8f27" strokeWidth=".8" strokeLinecap="round" />
            </svg>
          </div>
          <div className="fp-brand-text">
            <div className="fp-brand-name">FOps</div>
            <div className="fp-brand-sub">DEMAND PLANNING</div>
          </div>
        </div>

        <nav className="fp-nav">
          {nav.map(n => (
            <button
              key={n.k}
              className={`fp-nav-item${n.on ? ' on' : ''}`}
              /* Market Pulse is the only module this deployment ships; the rest
                 are in the design but not built, so they must not look clickable
                 into a dead end. */
              title={n.on ? undefined : 'Not available in this deployment'}
              disabled={!n.on}
              style={n.on ? undefined : { opacity: .45, cursor: 'not-allowed' }}
            >
              {NAV_ICONS[n.k]}<span>{n.label}</span>
            </button>
          ))}
        </nav>

        <div className="fp-nav-foot">
          <button className="fp-nav-item" onClick={onOpenSettings}>
            {NAV_ICONS.settings}<span>Settings</span>
          </button>
          <button className="fp-nav-item" onClick={onOpenAnalytics}>
            {NAV_ICONS.help}<span>Pipeline Analytics</span>
          </button>
        </div>

        <div className="fp-user-wrap" ref={menuRef}>
          {menu && (
            <div className="fp-usermenu">
              {user?.is_admin && <button onClick={() => { setMenu(false); onOpenAdmin(); }}>Admin</button>}
              <button onClick={() => { setMenu(false); onOpenSettings(); }}>Settings</button>
              <button className="danger" onClick={onLogout}>Log out</button>
            </div>
          )}
          <button className="fp-user" onClick={() => setMenu(m => !m)}>
            <div className="fp-avatar">{initials(user?.username)}</div>
            <div className="fp-user-meta">
              <div className="fp-user-name">{user?.username}</div>
              <div className="fp-user-role">{user?.is_admin ? 'Administrator' : 'Demand Planner'}</div>
            </div>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9aa2af" strokeWidth="1.8" strokeLinecap="round" style={{ flex: '0 0 auto' }}>
              <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
            </svg>
          </button>
        </div>
      </aside>

      <div className="fp-main">
        <header className="fp-topbar">
          <div className="fp-search">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9aa2af" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3-3" />
            </svg>
            <input
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search alerts, commodities, headlines…"
            />
          </div>
          <div className="fp-spacer" />
          <div className="fp-live">
            <span className="fp-live-top"><span className="fp-live-dot" />Live market feed</span>
            <span className="fp-live-sub">{lastRefresh ? `updated ${lastRefresh}` : 'awaiting first sync'}</span>
          </div>
          <button className="fp-iconbtn" onClick={onRefresh} disabled={loading} title="Sync now">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={loading ? 'spin' : ''}>
              <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" />
            </svg>
          </button>
          <button className="fp-iconbtn" title={`${alertCount} open alerts`}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" /><path d="M10 20a2 2 0 0 0 4 0" />
            </svg>
            {alertCount > 0 && <span className="fp-badge-dot" />}
          </button>
        </header>

        <div className="fp-scroll">{children}</div>
      </div>
    </div>
  );
}
