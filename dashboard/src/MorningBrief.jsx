import React from 'react';

// "What changed since yesterday" — triage panel at the top of the dashboard.
// Every value is real fetched data: alerts + accepted articles from Postgres,
// price moves from live Yahoo quotes vs same-contract previous close,
// weather flags from the live WeatherAPI feed already loaded by the app.
export default function MorningBrief({ brief, weatherExt }) {
  if (!brief) return null;

  const movers = (brief.priceMovers || []).filter(m => Math.abs(m.changePct) >= 0.01).slice(0, 5);
  const alerts = (brief.newAlerts || []).slice(0, 4);
  const counts = brief.alertCounts || {};
  const totalAlerts = (brief.newAlerts || []).length;
  const news = brief.acceptedNews || [];
  const flaggedRegions = (weatherExt || []).filter(w => {
    const alert = w.analytics?.alert || w.alert;
    return alert && alert !== 'NORMAL';
  });

  const sevColor = { CRITICAL: '#fb7185', HIGH: '#fbbf24', MEDIUM: '#38bdf8', LOW: '#a1a1aa' };
  const fmtPrice = (p) => `$${p.toFixed(p < 10 ? 4 : 2)}`;
  const colStyle = { minWidth: 0 };
  const colTitle = { fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '10px' };
  const emptyStyle = { fontSize: '13px', color: 'var(--text-dim)' };
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', marginBottom: '7px', fontSize: '13px' };

  return (
    <div className="mb-xl">
      <div className="section-label">
        Morning Brief — since {new Date(brief.since).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className="intel-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '24px' }}>

        <div style={colStyle}>
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
        </div>

        <div style={colStyle}>
          <div style={colTitle}>Price Movers <span style={{ letterSpacing: 0, textTransform: 'none', opacity: 0.7 }}>(vs prev close)</span></div>
          {movers.length === 0 ? <div style={emptyStyle}>No meaningful moves in your tracked commodities.</div> : movers.map(m => (
            <div key={m.symbol} style={rowStyle}>
              <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
              <span style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                {fmtPrice(m.price)}{' '}
                <span style={{ color: m.changePct >= 0 ? '#34d399' : '#fb7185' }}>
                  {m.changePct >= 0 ? '+' : ''}{m.changePct}%
                </span>
              </span>
            </div>
          ))}
        </div>

        <div style={colStyle}>
          <div style={colTitle}>Weather Watch</div>
          {flaggedRegions.length === 0 ? <div style={emptyStyle}>All tracked regions normal.</div> : flaggedRegions.map((w, i) => (
            <div key={i} style={rowStyle}>
              <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
              <span style={{ color: '#fbbf24', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>{w.analytics?.alert || w.alert}</span>
            </div>
          ))}
        </div>

        <div style={colStyle}>
          <div style={colTitle}>Fresh Intelligence</div>
          {news.length === 0 ? <div style={emptyStyle}>No newly accepted articles in the last 24h.</div> : news.map((n, i) => (
            <div key={i} style={{ marginBottom: '7px', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n.title}>
              <a href={n.url} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>
                {n.title}
              </a>
              {n.source && <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}> · {n.source}</span>}
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
