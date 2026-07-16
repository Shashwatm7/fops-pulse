import React from 'react';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function BriefSkeleton() {
  return (
    <div className="mb-xl brief-enter">
      <div className="section-label">Morning Brief</div>
      <div className="intel-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '28px' }}>
        {[0, 1].map(i => (
          <div key={i}>
            <div className="skeleton skeleton-line w-40" style={{ marginBottom: '16px' }} />
            <div className="skeleton skeleton-line w-80" />
            <div className="skeleton skeleton-line w-60" />
            <div className="skeleton skeleton-line w-80" />
          </div>
        ))}
      </div>
    </div>
  );
}

// "What changed since yesterday" — triage panel at the top of the dashboard.
// Every value is real fetched data: alerts from Postgres, prices from live
// Yahoo ticks (current vs prev close). Clicking a commodity opens its chart.
export default function MorningBrief({ brief, username, onViewAlerts, onSelectCommodity }) {
  if (!brief) return <BriefSkeleton />;

  // Show exactly the alerts the Alerts tab shows — the backend already
  // applied the severity scarcity quota (1 CRITICAL / 2 HIGH / 1 MEDIUM, no
  // LOW) and sorted severity-then-recency, so render as-is. No separate
  // news/price re-composition here: the two views must not diverge.
  const allAlerts = brief.newAlerts || [];
  const alerts = allAlerts;
  const counts = brief.alertCounts || {};
  const totalAlerts = allAlerts.length;
  const priceMovers = brief.priceMovers || [];

  const fmtPrice = (p) => (p >= 100 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toFixed(4));

  const sevColor = { CRITICAL: '#fb7185', HIGH: '#fbbf24', MEDIUM: '#38bdf8', LOW: '#a1a1aa' };
  const colStyle = { minWidth: 0, display: 'flex', flexDirection: 'column' };
  const colTitle = { fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '10px', paddingBottom: '8px', borderBottom: '1px solid var(--border-subtle)' };
  const emptyStyle = { fontSize: '13px', color: 'var(--text-dim)' };
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '8px', fontSize: '13px', lineHeight: 1.4 };

  return (
    <div className="mb-xl brief-enter">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '8px' }}>
        <div className="section-label" style={{ marginBottom: '6px' }}>
          Morning Brief
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
          since {new Date(brief.since).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div style={{ fontSize: '15px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
        {greeting()}{username ? `, ${username}` : ''} — here's what changed in your supply chain.
      </div>
      <div className="intel-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '28px', alignItems: 'start' }}>

        <div className="section-enter" style={{ ...colStyle, animationDelay: '0.08s' }}>
          <div style={colTitle}>
            New Alerts{totalAlerts > 0 && (
              <span style={{ marginLeft: '8px' }}>
                {Object.entries(counts).filter(([, n]) => n > 0).map(([sev, n]) => (
                  <span key={sev} style={{ color: sevColor[sev], marginRight: '6px', letterSpacing: 0 }}>{n} {sev.toLowerCase()}</span>
                ))}
              </span>
            )}
          </div>
          {alerts.length === 0 ? <div style={emptyStyle}>No new alerts in the last 24h.</div> : alerts.map(a => (
            <div key={a.id} style={{ ...rowStyle, justifyContent: 'flex-start' }}>
              <span style={{ color: sevColor[a.severity] || 'var(--text-secondary)', fontSize: '10px', fontWeight: 700, flexShrink: 0 }}>●</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }} title={a.title}>
                {a.url ? <a href={a.url} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{a.title}</a> : a.title}
              </span>
            </div>
          ))}
          {onViewAlerts && (
            <button
              onClick={onViewAlerts}
              style={{ marginTop: '8px', alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#67e8f9', fontSize: '12px', fontWeight: 600 }}
            >
              {totalAlerts > alerts.length ? `View all ${totalAlerts} alerts` : 'View all alerts'} →
            </button>
          )}
        </div>

        <div className="section-enter" style={{ ...colStyle, animationDelay: '0.16s' }}>
          <div style={colTitle}>Price Ticker <span style={{ letterSpacing: 0, textTransform: 'none', color: 'var(--text-dim)', fontWeight: 400 }}>· vs prev close · click for chart</span></div>
          {priceMovers.length === 0 ? (
            <div style={emptyStyle}>No live price data for your tracked commodities right now.</div>
          ) : priceMovers.map(m => {
            const noPrev = m.changePct == null;
            const up = m.changePct > 0, flat = m.changePct === 0;
            const col = noPrev || flat ? 'var(--text-dim)' : up ? '#34d399' : '#fb7185';
            return (
              <div
                key={m.symbol}
                onClick={() => onSelectCommodity && onSelectCommodity(m)}
                title={`Open ${m.label.toLowerCase()} chart`}
                style={{ ...rowStyle, cursor: 'pointer', padding: '4px 8px', margin: '0 -8px 4px', borderRadius: '6px' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                  <span style={{ color: 'var(--text-dim)', marginRight: '6px' }}>📈</span>{m.label.toLowerCase()}
                </span>
                <span style={{ flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: '8px', fontFamily: 'var(--font-mono)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {fmtPrice(m.price)}
                    {m.unit && <span style={{ color: 'var(--text-dim)', fontSize: '11px', marginLeft: '4px' }}>{m.unit}</span>}
                  </span>
                  <span style={{ color: col, fontWeight: 600, minWidth: '58px', textAlign: 'right' }} title={noPrev ? 'Previous close unavailable (possible contract roll) — change not shown rather than guessed' : undefined}>
                    {noPrev ? '—' : flat ? '0.00%' : `${up ? '▲' : '▼'} ${Math.abs(m.changePct).toFixed(2)}%`}
                  </span>
                </span>
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}
