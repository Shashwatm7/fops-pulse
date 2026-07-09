import React, { useState } from 'react';

// 7-day rollup panel. Every value is real: alerts + accepted articles from
// Postgres, and week-over-week price change computed from stored ticks
// (first vs last real recorded price in the window) — no simulated proxies.
export default function WeeklyDigest({ digest }) {
  const [open, setOpen] = useState(false);
  if (!digest) return null;

  const counts = digest.alertCounts || {};
  const movers = digest.priceMovers || [];
  const articles = digest.notableArticles || [];
  const total = digest.totalAlerts || 0;

  const sevColor = { CRITICAL: '#fb7185', HIGH: '#fbbf24', MEDIUM: '#38bdf8', LOW: '#a1a1aa' };
  const colTitle = { fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '10px', paddingBottom: '8px', borderBottom: '1px solid var(--border-subtle)' };
  const emptyStyle = { fontSize: '13px', color: 'var(--text-dim)' };
  const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '8px', fontSize: '13px', lineHeight: 1.4 };
  const fmtPrice = (p) => (p >= 100 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toFixed(4));

  const since = new Date(digest.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="mb-xl">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div className="section-label" style={{ margin: 0 }}>Weekly Digest <span style={{ letterSpacing: 0, textTransform: 'none', color: 'var(--text-dim)', fontWeight: 400, fontSize: '12px' }}>· since {since}</span></div>
        <button
          onClick={() => setOpen(o => !o)}
          style={{ background: 'none', border: '1px solid var(--border-subtle)', color: '#67e8f9', padding: '4px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
        >{open ? 'Hide' : 'Show'} 7-day summary</button>
      </div>

      {open && (
        <div className="intel-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '28px', alignItems: 'start', marginTop: '10px' }}>

          <div style={{ minWidth: 0 }}>
            <div style={colTitle}>
              Alerts This Week{total > 0 && (
                <span style={{ marginLeft: '8px' }}>
                  {Object.entries(counts).filter(([, n]) => n > 0).map(([sev, n]) => (
                    <span key={sev} style={{ color: sevColor[sev], marginRight: '6px', letterSpacing: 0 }}>{n} {sev.toLowerCase()}</span>
                  ))}
                </span>
              )}
            </div>
            {total === 0 ? <div style={emptyStyle}>No alerts in the last 7 days.</div> : (
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{total} alert{total === 1 ? '' : 's'} triggered across your tracked commodities and regions.</div>
            )}
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={colTitle}>Price Moves <span style={{ letterSpacing: 0, textTransform: 'none', color: 'var(--text-dim)', fontWeight: 400 }}>· 7-day</span></div>
            {movers.length === 0 ? (
              <div style={emptyStyle}>Not enough recorded price history this week yet.</div>
            ) : movers.map(m => {
              const up = m.changePct > 0, flat = m.changePct === 0;
              const col = flat ? 'var(--text-dim)' : up ? '#34d399' : '#fb7185';
              return (
                <div key={m.symbol} style={rowStyle}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', textTransform: 'capitalize' }} title={m.label}>{m.label.toLowerCase()}</span>
                  <span style={{ flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: '8px', fontFamily: 'var(--font-mono)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{fmtPrice(m.lastPrice)}</span>
                    <span style={{ color: col, fontWeight: 600, minWidth: '58px', textAlign: 'right' }}>
                      {flat ? '0.00%' : `${up ? '▲' : '▼'} ${Math.abs(m.changePct).toFixed(2)}%`}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ minWidth: 0 }}>
            <div style={colTitle}>Notable Stories</div>
            {articles.length === 0 ? <div style={emptyStyle}>No accepted articles in the last 7 days.</div> : articles.map((n, i) => (
              <div key={i} style={{ marginBottom: '7px', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={n.title}>
                <a href={n.url} target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}>{n.title}</a>
                {n.source && <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}> · {n.source}</span>}
              </div>
            ))}
          </div>

        </div>
      )}
    </div>
  );
}
