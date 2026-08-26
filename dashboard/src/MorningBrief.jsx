import React from 'react';

/* "What changed since yesterday" — the two-column brief at the top of the
   Command Center, laid out exactly as the FOps Dashboards mockup draws it:
   NEW ALERTS on the left, PRICE TICKER on the right, inside one card.
   Every value is real fetched data: alerts from Postgres, prices from live
   Yahoo ticks (current vs prev close). Clicking a commodity opens its chart. */

const SEV_DOT = { CRITICAL: '#dc2626', HIGH: '#d97706', MEDIUM: '#2f5bf6', LOW: '#9aa2af' };

function Skeleton() {
  return (
    <div className="fp-card">
      <div className="fp-brief">
        {['NEW ALERTS', 'PRICE TICKER'].map((t, i) => (
          <div key={t} className={i === 0 ? 'fp-brief-l' : 'fp-brief-r'}>
            <div className="fp-brief-head"><b>{t}</b></div>
            {[0, 1, 2].map(j => (
              <div key={j} className="skeleton skeleton-line" style={{ width: `${80 - j * 15}%`, marginBottom: '11px' }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MorningBrief({ brief, error, username, onViewAlerts, onSelectCommodity }) {
  // A failed fetch must not sit on the skeleton forever — an indefinite
  // spinner reads as "still loading", not "this is broken".
  if (!brief && error) {
    return <div className="fp-card"><div className="fp-err" style={{ marginBottom: 0 }}>⚠ {error}</div></div>;
  }
  if (!brief) return <Skeleton />;

  // Show exactly the alerts the Alerts tab shows — the backend already applied
  // the severity scarcity quota (1 CRITICAL / 2 HIGH / 1 MEDIUM, no LOW) and
  // sorted severity-then-recency, so render as-is. The two views must not diverge.
  const alerts = brief.newAlerts || [];
  const movers = brief.priceMovers || [];
  const fmt = (p) => (p >= 100 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toFixed(4));

  return (
    <div className="fp-card">
      {error && (
        // Brief is showing, but the background refresh is failing: say so
        // rather than letting stale figures look current.
        <div className="fp-warn">⚠ {error} — showing the last successful update.</div>
      )}
      <div className="fp-brief">
        <div className="fp-brief-l">
          <div className="fp-brief-head"><b>NEW ALERTS</b><span>last 24h</span></div>
          {alerts.length === 0 ? (
            <div style={{ fontSize: '14px', color: 'var(--fp-mute)', marginBottom: '18px' }}>
              No new alerts in the last 24h.
            </div>
          ) : alerts.map((a, i) => (
            <div key={a.id ?? i} className="fp-brief-row" style={i === alerts.length - 1 ? { marginBottom: '18px' } : undefined}>
              <span className="fp-dot" style={{ background: SEV_DOT[a.severity] || '#9aa2af' }} />
              {a.url
                ? <a href={a.url} target="_blank" rel="noreferrer" title={a.title}>{a.title}</a>
                : <span title={a.title} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</span>}
            </div>
          ))}
          {onViewAlerts && (
            <button className="fp-viewall" onClick={onViewAlerts}>View all alerts →</button>
          )}
        </div>

        <div className="fp-brief-r">
          <div className="fp-brief-head"><b>PRICE TICKER</b><span>vs prev close</span></div>
          {movers.length === 0 ? (
            <div style={{ fontSize: '14px', color: 'var(--fp-mute)', paddingTop: '7px' }}>
              No live price data for your tracked commodities right now.
            </div>
          ) : movers.map(m => {
            const noPrev = m.changePct == null;
            const up = m.changePct > 0, flat = m.changePct === 0;
            const col = noPrev || flat ? '#9aa2af' : up ? '#16a34a' : '#dc2626';
            return (
              <div
                key={m.symbol}
                className="fp-tick"
                onClick={() => onSelectCommodity && onSelectCommodity(m)}
                title={`Open ${m.label.toLowerCase()} chart`}
              >
                <span className="fp-tick-name">{m.label.toLowerCase()}</span>
                {m.unit && <span className="fp-tick-unit">{m.unit}</span>}
                <span className="fp-tick-val">{fmt(m.price)}</span>
                <span
                  className="fp-tick-chg"
                  style={{ color: col }}
                  title={noPrev ? 'Previous close unavailable (possible contract roll) — change not shown rather than guessed' : undefined}
                >
                  {noPrev ? '—' : flat ? '0.00%' : `${up ? '▲' : '▼'} ${up ? '+' : '−'}${Math.abs(m.changePct).toFixed(2)}%`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
