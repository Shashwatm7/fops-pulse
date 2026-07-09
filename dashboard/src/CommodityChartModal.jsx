import React, { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from 'recharts';

const RANGES = ['1D', '7D', '1M', '1Y'];

function fmtPrice(p) {
  if (p == null) return '—';
  return p >= 100 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(4);
}

function xTickFormatter(iso, range) {
  const d = new Date(iso);
  if (range === '1D') return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (range === '7D') return d.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', hour12: false });
  if (range === '1M') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

function ChartTooltip({ active, payload, range }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const d = new Date(p.time);
  const when = range === '1D' || range === '7D'
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return (
    <div style={{ background: '#0b1120', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '10px 12px', fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
      <div style={{ color: 'var(--text-dim)', marginBottom: '6px' }}>{when}</div>
      <div style={{ color: '#fff', fontWeight: 700, fontSize: '14px', marginBottom: '4px' }}>{fmtPrice(p.price)}</div>
      {p.open != null && (
        <div style={{ color: 'var(--text-muted)', display: 'grid', gridTemplateColumns: 'auto auto', gap: '2px 14px' }}>
          <span>O {fmtPrice(p.open)}</span><span>H {fmtPrice(p.high)}</span>
          <span>L {fmtPrice(p.low)}</span><span>C {fmtPrice(p.price)}</span>
        </div>
      )}
      {p.volume > 0 && <div style={{ color: 'var(--text-dim)', marginTop: '4px' }}>Vol {Intl.NumberFormat().format(p.volume)}</div>}
    </div>
  );
}

// Real market chart for one tracked commodity. All bars come from
// /api/history (Yahoo Finance OHLC, normalized to USD) — nothing simulated.
export default function CommodityChartModal({ symbol, label, unit, onClose }) {
  const [range, setRange] = useState('1D');
  const [data, setData] = useState(null); // null = loading, [] = no data
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setData(null); setError(null);
    fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&range=${range}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (active) { d.success !== false && Array.isArray(d.data) ? setData(d.data) : setError(d.error || 'No data'); } })
      .catch(() => { if (active) setError('Failed to load price history'); });
    return () => { active = false; };
  }, [symbol, range]);

  const stats = useMemo(() => {
    if (!data || data.length < 2) return null;
    const first = data[0].price, last = data[data.length - 1].price;
    const high = Math.max(...data.map(d => d.high ?? d.price));
    const low = Math.min(...data.map(d => (d.low ?? d.price) || Infinity));
    const changePct = ((last - first) / first) * 100;
    return { first, last, high, low, changePct };
  }, [data]);

  const up = stats ? stats.changePct >= 0 : true;
  const lineColor = up ? '#34d399' : '#fb7185';

  const yDomain = useMemo(() => {
    if (!data || data.length === 0) return ['auto', 'auto'];
    const vals = data.map(d => d.price);
    const min = Math.min(...vals), max = Math.max(...vals);
    const pad = (max - min) * 0.08 || max * 0.01;
    return [min - pad, max + pad];
  }, [data]);

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', width: '760px', maxWidth: '94vw', padding: '24px', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '4px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '17px', color: '#fff', textTransform: 'capitalize' }}>{(label || symbol).toLowerCase()}</h3>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
              {symbol} · {unit || 'USD'} · Yahoo Finance
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>✕</button>
        </div>

        {stats && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px', flexWrap: 'wrap', margin: '10px 0 4px', fontFamily: 'var(--font-mono)' }}>
            <span style={{ fontSize: '26px', fontWeight: 700, color: '#fff' }}>{fmtPrice(stats.last)}</span>
            <span style={{ fontSize: '15px', fontWeight: 700, color: lineColor }}>
              {up ? '▲' : '▼'} {Math.abs(stats.changePct).toFixed(2)}% <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: '12px' }}>over {range}</span>
            </span>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>H <span style={{ color: 'var(--text-secondary)' }}>{fmtPrice(stats.high)}</span></span>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>L <span style={{ color: 'var(--text-secondary)' }}>{fmtPrice(stats.low)}</span></span>
          </div>
        )}

        <div style={{ display: 'flex', gap: '6px', margin: '10px 0' }}>
          {RANGES.map(r => (
            <button key={r} onClick={() => setRange(r)}
              style={{
                background: r === range ? 'rgba(103,232,249,0.12)' : 'transparent',
                border: `1px solid ${r === range ? 'rgba(103,232,249,0.45)' : 'var(--border-subtle)'}`,
                color: r === range ? '#67e8f9' : 'var(--text-muted)',
                padding: '4px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
              }}>{r}</button>
          ))}
        </div>

        <div style={{ height: '320px' }}>
          {error ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fb7185', fontSize: '13px' }}>{error}</div>
          ) : data === null ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>Loading market data…</div>
          ) : data.length === 0 ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>No price bars for this range.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="time" tickFormatter={(t) => xTickFormatter(t, range)} tick={{ fill: '#64748b', fontSize: 11 }} minTickGap={40} axisLine={false} tickLine={false} />
                <YAxis domain={yDomain} tickFormatter={fmtPrice} tick={{ fill: '#64748b', fontSize: 11 }} width={62} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip range={range} />} />
                {stats && <ReferenceLine y={stats.first} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" label={{ value: `open ${fmtPrice(stats.first)}`, position: 'insideTopRight', fill: '#64748b', fontSize: 10 }} />}
                <Area type="monotone" dataKey="price" stroke={lineColor} strokeWidth={2} fill="url(#chartFill)" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '8px' }}>
          Real OHLC bars from Yahoo Finance ({range === '1D' ? '15-minute' : range === '7D' ? 'hourly' : range === '1M' ? 'daily' : 'weekly'} interval). Change is measured from the first bar in the selected range.
        </div>
      </div>
    </div>
  );
}

