import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, BarChart, Bar, LineChart, Line, ComposedChart, ReferenceLine
} from 'recharts';
import {
  Activity, BarChart2, Globe2, Zap, Target, PlaySquare,
  Settings, Shield, RefreshCw, LogOut, Sparkles, Plus,
  LayoutDashboard, ClipboardList, ThumbsUp, ThumbsDown, Bell,
  Droplets, Thermometer, Wind, Ship
} from 'lucide-react';
import './App.css';
import './fops.css';
import Shell from './Shell.jsx';

// Severity palette, taken from the FOps Dashboards mockup's alert cards.
const SEV_COLOR = { CRITICAL: '#dc2626', HIGH: '#dc2626', MEDIUM: '#d97706', LOW: '#2f5bf6' };
const SEV_BG    = { CRITICAL: '#fdecec', HIGH: '#fdecec', MEDIUM: '#fdf4e6', LOW: '#eef3fe' };
import LoginPage from './LoginPage.jsx';
import OnboardingWizard from './OnboardingWizard.jsx';
import SettingsPage from './SettingsPage.jsx';
import PipelineAnalyticsPage from './PipelineAnalyticsPage.jsx';
import AdminPage from './AdminPage.jsx';
import MorningBrief from './MorningBrief.jsx';
// Lazy import that self-heals after a redeploy: if the chunk hash no longer
// exists (stale index.html), reload the page once to pull the fresh index.html
// and its current chunk names, instead of crashing the UI.
function lazyWithReload(factory) {
  const KEY = 'chunk-reload-once';
  return lazy(() => factory()
    .then((mod) => { sessionStorage.removeItem(KEY); return mod; }) // success re-arms the guard
    .catch((err) => {
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, '1');
        window.location.reload();
        return new Promise(() => {}); // hold until the reload takes over
      }
      throw err; // already reloaded once and still failing — surface the real error
    }));
}
const CommodityChartModal = lazyWithReload(() => import('./CommodityChartModal.jsx'));
import TagInput from './TagInput.jsx';

const CustomTooltip = ({ active, payload, label, symbol }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const isLive = data.open === undefined; // If open is undefined, it's a live tick (no OHLC)
    return (
      <div style={{ background: '#1e293b', border: '1px solid #6b7280', borderRadius: '6px', padding: '10px 14px', boxShadow: '0 4px 12px #ffffff', minWidth: '180px' }}>
        <div style={{ color: '#9aa2af', fontSize: '11px', marginBottom: '8px', borderBottom: '1px solid #6b7280', paddingBottom: '4px' }}>
          Date: <span style={{ color: '#1a1d24', float: 'right' }}>{new Date(label).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div style={{ fontSize: '13px', fontWeight: '600', display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span style={{ color: '#9aa2af' }}>Close:</span> <span style={{ color: '#1a1d24' }}>{data.price}</span>
        </div>
        {!isLive && (
          <>
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span style={{ color: '#9aa2af' }}>Open:</span> <span style={{ color: '#1a1d24' }}>{data.open}</span>
            </div>
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span style={{ color: '#9aa2af' }}>High:</span> <span style={{ color: '#1a1d24' }}>{data.high}</span>
            </div>
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span style={{ color: '#9aa2af' }}>Low:</span> <span style={{ color: '#1a1d24' }}>{data.low}</span>
            </div>
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', marginTop: '6px', paddingTop: '4px', borderTop: '1px solid #6b7280' }}>
              <span style={{ color: '#9aa2af' }}>Volume:</span> <span style={{ color: '#93c5fd' }}>{data.volume ? data.volume.toLocaleString() : 0}</span>
            </div>
          </>
        )}
      </div>
    );
  }
  return null;
};

const API_BASE = '/api';
const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function AnimatedValue({ value, prefix = '', suffix = '', decimals = 2, duration = 800 }) {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);
  const rafRef = useRef(null);

  useEffect(() => {
    const start = prevRef.current;
    const end = typeof value === 'number' ? value : parseFloat(value) || 0;
    if (Math.abs(start - end) < 0.001) { setDisplay(end); return; }

    const startTime = performance.now();
    const animate = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = start + (end - start) * eased;
      setDisplay(current);
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
      else prevRef.current = end;
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value, duration]);

  return (
    <span className="price-animated">
      {prefix}{display.toLocaleString(undefined, { minimumFractionDigits: value < 0.01 ? 6 : value < 1 ? 4 : value < 10 ? 3 : decimals, maximumFractionDigits: value < 0.01 ? 6 : value < 1 ? 4 : value < 10 ? 3 : decimals })}{suffix}
    </span>
  );
}

function ApiLimitTracker() {
  const [limits, setLimits] = useState({ remaining: '...', reset: '...' });
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    const fetchLimits = () => {
      fetch(`${API_BASE}/rate-limits`, { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          setLimits(data);
          if (data.reset && data.reset !== 'N/A') {
            let ms = 0;
            const h = data.reset.match(/([\d.]+)h/);
            const m = data.reset.match(/([\d.]+)m/);
            const s = data.reset.match(/([\d.]+)s/);
            if (h) ms += parseFloat(h[1]) * 3600000;
            if (m) ms += parseFloat(m[1]) * 60000;
            if (s) ms += parseFloat(s[1]) * 1000;
            setCountdown(Math.floor(ms / 1000));
          }
        })
        .catch(console.error);
    };
    fetchLimits();
    // The rate-limit chip only changes when an LLM call happens, so a 15s poll
    // was four requests a minute to learn nothing. A hidden tab needs no
    // refresh at all: one dashboard left open on a second monitor was
    // generating most of this app's traffic with nobody looking at it.
    const interval = setInterval(() => {
      if (!document.hidden) fetchLimits();
    }, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const tick = setInterval(() => {
      setCountdown(c => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, [countdown]);

  const formatTime = (secs) => {
    if (secs <= 0) return '00:00';
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const isLow = parseInt(limits.remaining) < 50;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(30, 41, 59, 0.7)', padding: '6px 12px', borderRadius: '16px', border: '1px solid #6b7280', fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <Zap size={14} color={isLow ? '#dc2626' : '#2f5bf6'} style={{ flexShrink: 0 }} />
      <span style={{ color: '#9aa2af' }}>API Calls Left:</span>
      <strong style={{ color: isLow ? '#dc2626' : 'white' }}>{limits.remaining}</strong>
      <span style={{ color: '#6b7280', margin: '0 4px' }}>|</span>
      <span style={{ color: '#9aa2af' }}>Refresh in:</span>
      <strong style={{ color: '#16a34a', fontVariantNumeric: 'tabular-nums', minWidth: '40px' }}>{formatTime(countdown)}</strong>
    </div>
  );
}

// ── Historical Sparkline Components ──
function CommoditySparkline({ symbol }) {
  const [data, setData] = useState([]);
  useEffect(() => {
    fetch(`${API_BASE}/price-history/${symbol}?days=1`, { credentials: 'include' })
      .then(res => res.json())
      .then(d => { if (d.success) setData(d.history); })
      .catch(console.error);
  }, [symbol]);

  if (data.length < 2) return <div style={{ height: 40, width: '100%', opacity: 0.3 }} className="loading-shimmer" />;
  
  const isUp = data[data.length - 1].price >= data[0].price;
  const color = isUp ? '#16a34a' : '#dc2626';

  return (
    <div style={{ width: '100%', minWidth: 0, marginTop: '8px' }}>
      <ResponsiveContainer width="99%" height={40}>
        <LineChart data={data}>
          <Line type="monotone" dataKey="price" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          <YAxis domain={['dataMin', 'dataMax']} hide />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function WeatherSparkline({ regionName }) {
  const [data, setData] = useState([]);
  useEffect(() => {
    fetch(`${API_BASE}/weather-history/${encodeURIComponent(regionName)}?days=3`, { credentials: 'include' })
      .then(res => res.json())
      .then(d => { if (d.success) setData(d.history); })
      .catch(console.error);
  }, [regionName]);

  if (data.length < 2) return null;

  return (
    <div style={{ width: '100%', minWidth: 0, marginTop: '8px', marginBottom: '8px' }}>
      <ResponsiveContainer width="99%" height={40}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id={`colorTemp-${regionName.replace(/\\s+/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#b45309" stopOpacity={0.3}/>
              <stop offset="95%" stopColor="#b45309" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="tempMax" stroke="#b45309" fillOpacity={1} fill={`url(#colorTemp-${regionName.replace(/\\s+/g, '')})`} isAnimationActive={false} />
          <YAxis domain={['auto', 'auto']} hide />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// A dashed "+ search…" row, exactly as the FOps Dashboards mockup draws it.
// Shared by the three managed strips so the add affordance stays identical.
function AddRow({ placeholder, query, onQuery, onFocus, busy, suggestions, onPick, renderItem, keyOf }) {
  const inputRef = useRef(null);
  return (
    <div className="fp-addrow" onClick={() => inputRef.current?.focus()}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#aab1bd" strokeWidth="2" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <input
        ref={inputRef}
        value={query}
        onChange={e => onQuery(e.target.value)}
        onFocus={onFocus}
        placeholder={placeholder}
        disabled={busy}
      />
      {busy && <RefreshCw size={14} style={{ color: 'var(--fp-mute)', animation: 'spin 0.8s linear infinite' }} />}
      {suggestions.length > 0 && (
        <div className="fp-suggest">
          {suggestions.map((s, i) => (
            <div key={keyOf(s, i)} onClick={e => { e.stopPropagation(); onPick(s); }}>{renderItem(s)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// Real-time temp + rainfall strip for the Command Center. User-managed: a
// type-to-search box adds regions (WeatherAPI-backed, no proxy) and each card
// has a remove control. Cards render live WeatherAPI current-conditions; a
// region whose live payload hasn't arrived is still listed (so it can be
// removed) but shown as loading.
function WeatherStrip({ regions, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  const runSearch = (q) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const d = await fetch(`${API_BASE}/regions/search?q=${encodeURIComponent(q.trim())}`, { credentials: 'include' }).then(r => r.json());
        setSuggestions(d.results || []);
      } catch { setSuggestions([]); }
      setSearching(false);
    }, 250);
  };

  const pick = async (loc) => {
    setBusy(true);
    setSuggestions([]);
    setQuery('');
    try { await onAdd?.(loc); } finally { setBusy(false); }
  };

  const list = regions || [];

  return (
    <div className="fp-card">
      <div className="fp-card-head">
        <span className="fp-card-title">LIVE WEATHER &amp; RAINFALL</span>
        <span className="fp-card-note">
          real-time · WeatherAPI{list.length ? ` · ${list.length} region${list.length > 1 ? 's' : ''}` : ''}
        </span>
      </div>

      <AddRow
        placeholder="Add a region — search by city or country…"
        query={query} onQuery={runSearch} busy={busy || searching}
        suggestions={suggestions} onPick={pick}
        keyOf={(s, i) => `${s.lat},${s.lon}-${i}`}
        renderItem={s => s.label}
      />

      {list.length === 0 ? (
        <div className="fp-empty">
          No regions yet. Search above to add live temperature &amp; rainfall tracking for any location.
        </div>
      ) : (
        <div className="fp-grid-4">
          {list.map((r, i) => {
            const c = r.current;
            const today = r.todayPrecipMm;
            const rain = today != null ? `${today} mm` : c ? `${c.precipMm} mm` : null;
            return (
              <div key={r.name || i} className="fp-tile fp-wx">
                <button className="fp-tile-x" title="Remove region" onClick={() => onRemove?.(r.name)}>&times;</button>
                <div style={{ flex: '1 1 0%', minWidth: 0 }}>
                  <div className="fp-wx-city" title={r.name}>{r.name}</div>
                  <div className="fp-wx-cond">
                    {c ? [c.condition, rain].filter(Boolean).join(' · ') : 'Loading conditions…'}
                  </div>
                </div>
                {c && <div className="fp-wx-temp">{Math.round(c.tempC)}&deg;</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Port Congestion (GCC) strip ─────────────────────────────────────
// Mirrors WeatherStrip: a user-managed list of ports with inline add/remove.
// Data is IMF PortWatch daily port-call throughput (weekly, ~1wk lag) — NOT
// true dwell/queue. Each card shows recent calls/day vs a 28-day baseline and a
// status band derived from that anomaly.
const PORT_STATUS_COLOR = {
  'Severely reduced': '#dc2626',
  'Reduced': '#d97706',
  'Normal': '#16a34a',
  'Elevated': '#2f5bf6',
  'Surging': '#00399C',
  'No data': '#9aa2af',
  'Insufficient baseline': '#9aa2af',
};

function PortCongestionStrip({ ports, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  const runSearch = (q) => {
    setQuery(q);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const d = await fetch(`${API_BASE}/ports/search?q=${encodeURIComponent(q.trim())}`, { credentials: 'include' }).then(r => r.json());
        setSuggestions(d.results || []);
      } catch { setSuggestions([]); }
    }, 200);
  };

  const pick = async (p) => {
    setBusy(true);
    setSuggestions([]);
    setQuery('');
    setOpen(false);
    try { await onAdd?.(p); } finally { setBusy(false); }
  };

  const list = ports || [];

  return (
    <div className="fp-card">
      <div className="fp-card-head">
        <span className="fp-card-title">PORT CONGESTION · GCC</span>
        <span className="fp-card-note">
          IMF PortWatch · port calls vs baseline · weekly{list.length ? ` · ${list.length} port${list.length > 1 ? 's' : ''}` : ''}
        </span>
      </div>

      <AddRow
        placeholder="Add a GCC port — search by name or country…"
        query={query} onQuery={runSearch}
        onFocus={() => { setOpen(true); if (!suggestions.length) runSearch(query); }}
        busy={busy}
        suggestions={open ? suggestions : []} onPick={pick}
        keyOf={s => s.portid}
        renderItem={s => <>{s.portname} <span style={{ color: 'var(--fp-mute)', fontSize: '11.5px' }}>· {s.country}</span></>}
      />

      {list.length === 0 ? (
        <div className="fp-empty">
          No ports tracked. Search above to add GCC ports (Jebel Ali, Dammam, Jeddah, Hamad…).
        </div>
      ) : (
        <div className="fp-grid-3">
          {list.map((p, i) => {
            const color = PORT_STATUS_COLOR[p.status] || '#9aa2af';
            const delta = p.callsDeltaPct;
            const deltaStr = delta == null ? '—' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`;
            return (
              <div key={p.portid || i} className="fp-tile">
                <button className="fp-tile-x" title="Remove port" onClick={() => onRemove?.(p.portid)}>&times;</button>
                <div className="fp-port-top">
                  <span className="fp-port-name">{p.portname}</span>
                  {p.hasData && <span className="fp-port-state" style={{ color }}>{p.status}</span>}
                </div>
                <div className="fp-port-country">{p.country}</div>
                {p.hasData ? (
                  <>
                    <div className="fp-port-figs">
                      <span className="fp-port-big">{p.recentCallsPerDay ?? '—'}</span>
                      <span className="fp-port-unit">calls/day</span>
                      <span className="fp-port-delta" style={{ color }}>{deltaStr}</span>
                    </div>
                    <div className="fp-port-base">
                      vs {p.baselineCallsPerDay ?? '—'}/day baseline (28d)
                      {p.importDeltaPct != null && ` · imports ${p.importDeltaPct > 0 ? '+' : '−'}${Math.abs(p.importDeltaPct)}%`}
                    </div>
                  </>
                ) : (
                  <div className="fp-port-base" style={{ marginTop: '12px' }}>No recent PortWatch data.</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── FX Spot Rates strip ─────────────────────────────────────────────
// User-selectable, mirroring the port strip: search the OXR currency catalog
// and add/remove currencies inline. Cards show code, name, and rate per USD
// only (no commodities). Source is Open Exchange Rates via /api/forex.
function ForexStrip({ rates, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  const runSearch = (q) => {
    setQuery(q);
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const d = await fetch(`${API_BASE}/forex/search?q=${encodeURIComponent(q.trim())}`, { credentials: 'include' }).then(r => r.json());
        setSuggestions(d.results || []);
      } catch { setSuggestions([]); }
    }, 200);
  };

  const pick = async (c) => {
    setBusy(true);
    setSuggestions([]);
    setQuery('');
    setOpen(false);
    try { await onAdd?.(c); } finally { setBusy(false); }
  };

  const list = rates ? Object.entries(rates) : [];

  return (
    <div className="fp-card">
      <div className="fp-card-head">
        <span className="fp-card-title">FX SPOT RATES</span>
        <span className="fp-card-note">
          Open Exchange Rates · per USD{list.length ? ` · ${list.length} currenc${list.length > 1 ? 'ies' : 'y'}` : ''}
        </span>
      </div>

      <AddRow
        placeholder="Add a currency — search by code or name…"
        query={query} onQuery={runSearch}
        onFocus={() => { setOpen(true); if (!suggestions.length) runSearch(query); }}
        busy={busy}
        suggestions={open ? suggestions : []} onPick={pick}
        keyOf={s => s.code}
        renderItem={s => <><b>{s.code}</b> <span style={{ color: 'var(--fp-mute)', fontSize: '11.5px' }}>· {s.name}</span></>}
      />

      {list.length === 0 ? (
        <div className="fp-empty">
          No currencies selected. Search above to add rates (AED, EUR, INR…).
        </div>
      ) : (
        <div className="fp-grid-3">
          {list.map(([code, d]) => (
            <div key={code} className="fp-tile fp-fx">
              <button className="fp-tile-x" title="Remove currency" onClick={() => onRemove?.(code)}>&times;</button>
              <div style={{ flex: '1 1 0%' }}>
                <div className="fp-fx-code">{code}</div>
                <div className="fp-fx-name">{d.name}</div>
              </div>
              <div className="fp-fx-rate">
                {typeof d.rate === 'number' ? d.rate.toFixed(d.rate < 5 ? 4 : 2) : d.rate}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Helpful / Not helpful, drawn as the mockup's pair of pill buttons. Rendered
// inside a flex action row, so the optional note breaks onto its own line.
function AiFeedbackWidget({ featureName, context, aiResponse }) {
  const [status, setStatus] = useState('idle'); // idle, rating, submitted, error
  const [isHelpful, setIsHelpful] = useState(null);
  const [notes, setNotes] = useState('');

  const handleRate = (helpful) => {
    setIsHelpful(helpful);
    setStatus('rating');
  };

  const handleSubmit = async () => {
    setStatus('submitted');
    try {
      await fetch(`${API_BASE}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ featureName, context, aiResponse, isHelpful, userNotes: notes })
      });
    } catch (err) {
      console.error('Feedback failed:', err);
      setStatus('error');
    }
  };

  if (status === 'submitted') {
    return <span style={{ fontSize: '13px', color: 'var(--fp-green)', fontWeight: 600 }}>✓ Thanks for the feedback</span>;
  }

  const sel = (v) => isHelpful === v
    ? { borderColor: v ? 'var(--fp-green)' : 'var(--fp-red)', color: v ? 'var(--fp-green)' : 'var(--fp-red)' }
    : undefined;

  return (
    <>
      <button className="fp-btn fp-btn-sm" style={sel(true)} onClick={() => handleRate(true)}>
        <ThumbsUp size={13} /> Helpful
      </button>
      <button className="fp-btn fp-btn-sm" style={sel(false)} onClick={() => handleRate(false)}>
        <ThumbsDown size={13} /> Not helpful
      </button>
      {status === 'rating' && (
        <div style={{ flexBasis: '100%', display: 'flex', gap: '9px', marginTop: '4px' }}>
          <input
            type="text"
            placeholder="Optional — why?"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={{ flex: 1, height: '34px', padding: '0 12px', fontSize: '13px', background: '#fff', border: '1px solid var(--fp-input)', borderRadius: '9px', color: 'var(--fp-ink)', fontFamily: 'inherit', outline: 'none' }}
          />
          <button className="fp-btn fp-btn-sm fp-btn-primary" onClick={handleSubmit}>Submit</button>
        </div>
      )}
      {status === 'error' && (
        <span style={{ fontSize: '13px', color: 'var(--fp-red)' }}>Could not send feedback.</span>
      )}
    </>
  );
}

export default function Dashboard() {
  // ── Auth State ──
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showPipelineAnalytics, setShowPipelineAnalytics] = useState(false);

  const [tab, setTab] = useState('pulse');
  // Topbar search — filters the alert list and the news stream in place.
  const [globalSearch, setGlobalSearch] = useState('');
  const [alertSev, setAlertSev] = useState('All');
  // Alert ids whose precomputed extractive (MiniLM, no-LLM) summary is expanded.
  const [openExtracts, setOpenExtracts] = useState({});
  const [showTrackModal, setShowTrackModal] = useState(false);
  const [trackSearch, setTrackSearch] = useState('');
  const [trackResults, setTrackResults] = useState([]);
  const [isTracking, setIsTracking] = useState(false);
  const [prices, setPrices] = useState([]);
  const [energy, setEnergy] = useState(null);
  const [news, setNews] = useState([]);
  const [newsFilter, setNewsFilter] = useState('');
  const [newsInsights, setNewsInsights] = useState({ byUrl: {}, byTitle: {} });
  const [categorizedNews, setCategorizedNews] = useState([]);
  const [categorizedNewsError, setCategorizedNewsError] = useState('');
  const [regionCatalog, setRegionCatalog] = useState([]);
  const [newsSearch, setNewsSearch] = useState('');
  const [newsStreamFilter, setNewsStreamFilter] = useState('all'); // all | risk | commodity
  const [newsCatFilter, setNewsCatFilter] = useState('all');
  const [newsRegionFilter, setNewsRegionFilter] = useState('all');
  const [newsDateFilter, setNewsDateFilter] = useState('all'); // all | 24h | 7d | 30d — by publish date
  const [articleSummary, setArticleSummary] = useState(null); // { article, loading, data, error }
  const [alertInsights, setAlertInsights] = useState({ byUrl: {}, byTitle: {} });
  const [newsLimit, setNewsLimit] = useState(10);
  const [rescanning, setRescanning] = useState(false);
  const [pipelineKeywords, setPipelineKeywords] = useState([]);
  const [pipelineBlocklist, setPipelineBlocklist] = useState([]);
  const [weather, setWeather] = useState([]);
  const [weatherExt, setWeatherExt] = useState([]);
  const [forex, setForex] = useState(null);

  // Command Center weather strip: user-managed region list (independent of the
  // news pipeline's regions). Add/remove hit dedicated endpoints, then refetch.
  const refetchWeather = useCallback(async () => {
    try {
      const d = await fetch(`${API_BASE}/weather`, { credentials: 'include' }).then(r => r.json());
      setWeather(d.regions || []);
    } catch (e) { console.error('weather refetch failed', e); }
  }, []);
  const addWeatherRegion = useCallback(async (loc) => {
    try {
      const d = await fetch(`${API_BASE}/weather-regions/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ name: loc.name, country: loc.country, lat: loc.lat, lon: loc.lon }),
      }).then(r => r.json());
      if (d.error) { alert(d.error); return; }
      await refetchWeather();
    } catch (e) { console.error('add weather region failed', e); }
  }, [refetchWeather]);
  const removeWeatherRegion = useCallback(async (name) => {
    try {
      await fetch(`${API_BASE}/weather-regions/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ name }),
      });
      await refetchWeather();
    } catch (e) { console.error('remove weather region failed', e); }
  }, [refetchWeather]);
  // Command Center port-congestion strip: user-managed GCC port list (IMF
  // PortWatch). Add/remove hit dedicated endpoints, then refetch.
  const [ports, setPorts] = useState([]);
  const refetchPorts = useCallback(async () => {
    try {
      const d = await fetch(`${API_BASE}/ports`, { credentials: 'include' }).then(r => r.json());
      setPorts(d.ports || []);
    } catch (e) { console.error('ports refetch failed', e); }
  }, []);
  const addPort = useCallback(async (p) => {
    try {
      const d = await fetch(`${API_BASE}/ports/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ portid: p.portid }),
      }).then(r => r.json());
      if (d.error) { alert(d.error); return; }
      await refetchPorts();
    } catch (e) { console.error('add port failed', e); }
  }, [refetchPorts]);
  const removePort = useCallback(async (portid) => {
    try {
      await fetch(`${API_BASE}/ports/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ portid }),
      });
      await refetchPorts();
    } catch (e) { console.error('remove port failed', e); }
  }, [refetchPorts]);

  // Command Center FX strip: user-selected currency list. Add/remove hit
  // dedicated endpoints, then refetch the rates.
  const refetchForex = useCallback(async () => {
    try {
      const d = await fetch(`${API_BASE}/forex`, { credentials: 'include' }).then(r => r.json());
      setForex(d.rates || null);
    } catch (e) { console.error('forex refetch failed', e); }
  }, []);
  const addCurrency = useCallback(async (c) => {
    try {
      const d = await fetch(`${API_BASE}/forex/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ code: c.code }),
      }).then(r => r.json());
      if (d.error) { alert(d.error); return; }
      await refetchForex();
    } catch (e) { console.error('add currency failed', e); }
  }, [refetchForex]);
  const removeCurrency = useCallback(async (code) => {
    try {
      await fetch(`${API_BASE}/forex/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ code }),
      });
      await refetchForex();
    } catch (e) { console.error('remove currency failed', e); }
  }, [refetchForex]);
  // Categorized news feed (Alerts tab). Refetched on tab-open AND on every
  // dashboard refresh, so a scan's new articles show up without a tab switch.
  const refetchCategorizedNews = useCallback(async () => {
    try {
      const d = await fetch(`${API_BASE}/news/categorized`, { credentials: 'include' }).then(r => r.json());
      if (d.success) { setCategorizedNews(d.items || []); setRegionCatalog(d.regionCatalog || []); setCategorizedNewsError(''); }
      else setCategorizedNewsError(d.error || 'Categorized news unavailable.');
    } catch (e) {
      console.error('categorized news refetch failed', e);
      setCategorizedNewsError('Categorized news unavailable.');
    }
  }, []);
  const [analysis, setAnalysis] = useState(null);
  const [analysisStale, setAnalysisStale] = useState(false);
  const [previousAnalysis, setPreviousAnalysis] = useState(null);
  const [aiRecommendations, setAiRecommendations] = useState([]);
  const [aiRecommendationsError, setAiRecommendationsError] = useState('');
  const [aiRecsLoading, setAiRecsLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [showJson, setShowJson] = useState(false);
  const [selectedCommodity, setSelectedCommodity] = useState(null);
  const [commodityAnalysis, setCommodityAnalysis] = useState({});
  const [loadingCommodity, setLoadingCommodity] = useState(null);
  const [aiForecasts, setAiForecasts] = useState({});
  const [loadingForecasts, setLoadingForecasts] = useState({});
  const [deepDiveLoading, setDeepDiveLoading] = useState({});
  const [deepDiveText, setDeepDiveText] = useState({});
  const [deepDiveError, setDeepDiveError] = useState({});
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvKeywords, setCsvKeywords] = useState([]);
  const [mlForecasts, setMlForecasts] = useState([]);
  const [morningBrief, setMorningBrief] = useState(null);
  const [morningBriefError, setMorningBriefError] = useState('');
  const [chartModal, setChartModal] = useState(null); // { symbol, label, unit }
  // ── S&OP State ──
  const [sopPlans, setSopPlans] = useState([]);
  const [showSopModal, setShowSopModal] = useState(false);
  const [newSop, setNewSop] = useState({ commodity: '', region: '', plan_type: 'procurement', target_value: '', period_start: '', period_end: '' });

  // ── Live Feed State ──
  const [livePrices, setLivePrices] = useState({});
  const [liveSelectedSymbol, setLiveSelectedSymbol] = useState('BRENT_CRUDE');
  const [timeframe, setTimeframe] = useState('LIVE');

  const [allCommodities, setAllCommodities] = useState([]);
  const [allRegions, setAllRegions] = useState([]);
  const [quickRegionName, setQuickRegionName] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);
  const [quickCommodity, setQuickCommodity] = useState('');

  useEffect(() => {
    fetch('/api/auth/templates')
      .then(res => res.json())
      .then(data => {
        setAllCommodities(data.commodities || []);
        setAllRegions(data.regions || []);
      })
      .catch(err => console.error("Failed to load templates:", err));
  }, []);

  const updateProfileField = async (updatedFields) => {
    try {
      const payload = {
        commodities: profile.commodities,
        regions: profile.regions,
        focus_region: profile.focus_region,
        focus_product: profile.focus_product,
        news_keywords: profile.news_keywords,
        custom_regions: profile.custom_regions || [],
        ...updatedFields
      };
      const res = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setProfile(data.profile);
        refresh(); // Refresh dashboard data immediately
      }
    } catch(e) {
      console.error(e);
    }
  };

  const handleAddQuickRegion = async () => {
    if (!quickRegionName) return;
    setQuickAdding(true);
    // Check if it's a predefined region
    if (allRegions.find(r => r.name === quickRegionName)) {
      if (!profile.regions.includes(quickRegionName)) {
        await updateProfileField({ regions: [...profile.regions, quickRegionName] });
      }
      setQuickRegionName('');
      setQuickAdding(false);
      return;
    }
    
    // Otherwise add as custom region
    try {
      const res = await fetch('/api/regions/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: quickRegionName, crop: '' })
      });
      const data = await res.json();
      if (data.success) {
        await updateProfileField({ custom_regions: data.custom_regions });
        setQuickRegionName('');
      } else {
        alert(data.error || 'Failed to add region');
      }
    } catch(e) {
      console.error(e);
      console.error(e);
    }
    setQuickAdding(false);
  };

  useEffect(() => {
    if (profile) {
      setPipelineKeywords(profile.news_keywords || []);
      setPipelineBlocklist(profile.custom_blocklist || []);
    }
  }, [profile]);

  const handleSavePipelineConfig = async () => {
    await updateProfileField({ news_keywords: pipelineKeywords, custom_blocklist: pipelineBlocklist });
    refresh();
  };

  const handleAddQuickCommodity = async () => {
    if (!quickCommodity) return;
    if (!profile.commodities.includes(quickCommodity)) {
      await updateProfileField({ commodities: [...profile.commodities, quickCommodity] });
    }
    setQuickCommodity('');
  };

  const handleRemoveCommodity = async (key) => {
    await updateProfileField({ commodities: profile.commodities.filter(c => c !== key) });
  };

  const handleRemoveRegion = async (name, isCustom) => {
    if (isCustom) {
      await updateProfileField({ custom_regions: (profile.custom_regions || []).filter(r => r.name !== name) });
    } else {
      await updateProfileField({ regions: profile.regions.filter(r => r !== name) });
    }
  };

  const regeneratePlanner = () => {
    setAiRecsLoading(true);
    setAiRecommendationsError('');
    setAiRecommendations([]);
    fetch(`${API_BASE}/analyze-planner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ prices, energy, news, weather, forex, weatherExtended: weatherExt, keywords: profile?.news_keywords || [], forceRefresh: true }),
    }).then(async r => {
      const data = await r.json();
      if (!r.ok || !data.success) throw new Error(data.error || 'AI recommendations unavailable.');
      return data;
    }).then(data => {
      if (data.success && data.recommendations) {
        setAiRecommendations(data.recommendations);
      }
    }).catch(err => {
      console.error('Failed to load AI recommendations', err);
      setAiRecommendations([]);
      setAiRecommendationsError(err.message || 'AI recommendations unavailable.');
    }).finally(() => {
      setAiRecsLoading(false);
    });
  };
  
  const handleDeepDive = async (r, id) => {
    setDeepDiveLoading(prev => ({...prev, [id]: true}));
    try {
      const res = await fetch(`${API_BASE}/analyze-deep-dive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          timeframe: r.timeframe, 
          prices, news, weather, energy, forex, weatherExtended: weatherExt, 
          deterministicAction: r.action 
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.deepDive) {
        throw new Error(data.error || 'AI Deep-Dive failed.');
      }
      setDeepDiveText(prev => ({...prev, [id]: data.deepDive}));
      setDeepDiveError(prev => ({ ...prev, [id]: '' }));
    } catch (err) {
      // Keep the error OUT of the content slot. Writing it into deepDiveText
      // rendered a server error inside the "✨ AI Deep-Dive Analysis" card with
      // a thumbs-up/down widget attached to it, as if it were generated output.
      console.error('Deep dive failed', err);
      setDeepDiveError(prev => ({ ...prev, [id]: err.message || 'AI Deep-Dive failed.' }));
    } finally {
      setDeepDiveLoading(prev => ({...prev, [id]: false}));
    }
  };

  const handleCsvUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setCsvLoading(true);
    setAiRecsLoading(true); // Share loading state so UI updates properly

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${API_BASE}/upload-csv-intelligence`, {
        method: 'POST',
        headers: {
          // Do NOT set Content-Type header manually when using FormData, browser does it automatically with correct boundary
        },
        credentials: 'include',
        body: formData
      });
      
      const data = await res.json();
      if (data.success) {
        setCsvKeywords(data.extractedKeywords || []);
        if (data.alerts?.length > 0) {
           setAnalysis(prev => ({ ...prev, alerts: [...(prev?.alerts || []), ...data.alerts] }));
        }
        if (data.recommendations?.length > 0) {
           setAiRecommendations(data.recommendations);
        }
      } else {
        alert('CSV Intelligence failed: ' + data.error);
      }
    } catch (err) {
      console.error(err);
      alert('CSV Intelligence error: ' + err.message);
    } finally {
      setCsvLoading(false);
      setAiRecsLoading(false);
    }
  };

  const [histData, setHistData] = useState([]);
  const [histLoading, setHistLoading] = useState(false);

  // ── New animation state ──
  const [tabDirection, setTabDirection] = useState('right');
  const [secondsAgo, setSecondsAgo] = useState(null);
  const [loadingStep, setLoadingStep] = useState(0);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const prevTabRef = useRef(0);
  const tabBtnsRef = useRef({});
  const tabNavRef = useRef(null);

  const highCriticalAlertsCount = (analysis?.alerts || []).filter(a => a.severity === 'CRITICAL' || a.severity === 'HIGH').length;

  const tabs = [
    { id: 'pulse', label: 'Command Center' },
    { id: 'alerts', label: 'Alerts', count: highCriticalAlertsCount },
    { id: 'marketinfo', label: 'Market Report' },
    { id: 'actions', label: 'Recommendations' },
  ];

  // ── Tab indicator position ──
  useEffect(() => {
    const btn = tabBtnsRef.current[tab];
    if (btn && tabNavRef.current) {
      const navRect = tabNavRef.current.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setIndicatorStyle({
        left: btnRect.left - navRect.left,
        width: btnRect.width,
      });
    }
  }, [tab]);

  // ── Seconds ago counter ──
  useEffect(() => {
    if (!lastRefresh) return;
    setSecondsAgo(0);
    const iv = setInterval(() => setSecondsAgo(s => (s ?? 0) + 1), 1000);
    return () => clearInterval(iv);
  }, [lastRefresh]);

  const formatTimeAgo = (s) => {
    if (s == null) return '—';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  // ── Loading step simulation ──
  useEffect(() => {
    if (!loading) { setLoadingStep(0); return; }
    setLoadingStep(1);
    const iv = setInterval(() => {
      setLoadingStep(s => (s < 4 ? s + 1 : s));
    }, 900);
    return () => clearInterval(iv);
  }, [loading]);

  // ── Tab switch handler ──
  const switchTab = (newTab) => {
    const newIdx = tabs.findIndex(t => t.id === newTab);
    const oldIdx = prevTabRef.current;
    setTabDirection(newIdx >= oldIdx ? 'right' : 'left');
    prevTabRef.current = newIdx;
    setTab(newTab);
  };

  // ── Card tilt handlers ──
  const handleTilt = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    e.currentTarget.style.transform = `perspective(800px) rotateX(${-y * 8}deg) rotateY(${x * 8}deg) translateY(-2px)`;
  };
  const handleTiltReset = (e) => { e.currentTarget.style.transform = ''; };

  // ── Button ripple ──
  const handleRipple = (e) => {
    const btn = e.currentTarget;
    const circle = document.createElement('span');
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    circle.style.width = circle.style.height = `${size}px`;
    circle.style.left = `${e.clientX - rect.left - size / 2}px`;
    circle.style.top = `${e.clientY - rect.top - size / 2}px`;
    circle.className = 'ripple';
    btn.appendChild(circle);
    setTimeout(() => circle.remove(), 600);
  };

  // ── Auth check on mount ──
  useEffect(() => {
    fetch(`${API_BASE}/auth/me`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.user) {
          setUser(data.user);
          setProfile(data.profile);
        }
        setAuthLoading(false);
      })
      .catch(() => setAuthLoading(false));
  }, []);

  const handleLogout = async () => {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    setUser(null);
    setProfile(null);
  };

  // Current tab, readable from refresh() without making it a dependency —
  // taking `tab` directly would rebuild refresh on every tab switch and
  // retrigger the effects that depend on it.
  const activeTabRef = useRef(tab);
  useEffect(() => { activeTabRef.current = tab; }, [tab]);

  // ── Data refresh ──
  const refresh = useCallback(async () => {
    if (!user || !user.is_onboarded) return;
    setLoading(true);
    try {
      const fetchOpts = { credentials: 'include' };

      // ONE request for the whole Command Center instead of eight. The server
      // composes the same eight handlers in-process (/api/pages/dashboard), so
      // the payload is identical but the browser pays one round trip and the
      // server does one session lookup instead of eight.
      //
      // Per-section failures are isolated server-side: a section that throws
      // or returns 4xx/5xx arrives as {status:'error'} and the rest of the page
      // still renders. `sec()` maps that back to the same empty-shape defaults
      // the old per-fetch .catch() handlers used, so a broken section degrades
      // exactly as it did before rather than blanking the dashboard.
      const page = await fetch(`${API_BASE}/pages/dashboard`, fetchOpts)
        .then(r => r.json())
        .catch(() => ({ sections: {} }));
      const sec = (name, fallback) => {
        const s = page?.sections?.[name];
        return s && s.status === 'ok' && s.data ? s.data : fallback;
      };

      const priceRes = sec('commodities', { prices: [] });
      const energyRes = sec('energy', {});
      const newsRes = sec('news', { articles: [] });
      const weatherRes = sec('weather', { regions: [] });
      const forexRes = sec('forex', null);
      const weatherExtRes = sec('weatherExtended', { regions: [] });
      const sopRes = sec('sop', { plans: [] });
      const mlForecastRes = sec('mlForecasts', { forecasts: [] });

      const p = priceRes.prices || [];
      const e = energyRes;
      const n = newsRes.articles || [];
      const w = weatherRes.regions || [];
      const wExt = weatherExtRes.regions || [];
      const fx = forexRes?.rates || null;
      const sops = sopRes.plans || [];
      const mlFore = mlForecastRes?.forecasts || [];

      setPrices(p);
      setEnergy(e);
      setNews(n);
      setWeather(w);
      setWeatherExt(wExt);
      setForex(fx);
      setSopPlans(sops);
      setMlForecasts(mlFore);

      // Port congestion strip: independent, non-blocking (PortWatch fetch can
      // be slow on first ingest, so it must not hold up the Command Center).
      refetchPorts();

      // Categorized news feed: only while the Alerts tab is actually open.
      // Unconditionally it fetched a feed the user could not see on every
      // Command Center refresh, AND double-fetched while the Alerts tab was
      // open, because the tab effect below already loads it on entry. Read
      // through a ref so refresh() does not take `tab` as a dependency and
      // get rebuilt on every tab switch.
      if (activeTabRef.current === 'alerts') refetchCategorizedNews();

      // Morning brief: independent, non-blocking. Errors are surfaced — a
      // silent failure here left the panel stuck on its loading skeleton
      // forever, which reads as "still loading" rather than "broken".
      fetch(`${API_BASE}/morning-brief`, fetchOpts)
        .then(async r => {
          const data = await r.json();
          if (!r.ok || !data.success) throw new Error(data.error || `Morning brief unavailable (HTTP ${r.status})`);
          return data;
        })
        .then(data => { setMorningBrief(data); setMorningBriefError(''); })
        .catch(err => {
          console.error('Morning brief failed', err);
          setMorningBriefError(err.message || 'Morning brief unavailable.');
        });


      setAiRecsLoading(true);
      setAiRecommendationsError('');
      fetch(`${API_BASE}/analyze-planner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ prices: p, energy: e, news: n, weather: w, forex: fx, weatherExtended: wExt, keywords: profile?.news_keywords || [] }),
      }).then(async r => {
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error(data.error || 'AI recommendations unavailable.');
        return data;
      }).then(data => {
        if (data.success && data.recommendations) {
          setAiRecommendations(data.recommendations);
        }
      }).catch(err => {
        console.error('Failed to load AI recommendations', err);
        setAiRecommendations([]);
        setAiRecommendationsError(err.message || 'AI recommendations unavailable.');
      })
        .finally(() => setAiRecsLoading(false));

      const analysisRes = await fetch(`${API_BASE}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ prices: p, energy: e, news: n, weather: w, forex: fx, weatherExtended: wExt }),
      }).then(r => r.json()).catch(err => {
        // Was `.catch(() => ({}))`: a 500 here left the PREVIOUS analysis
        // rendered with no indication it was stale.
        console.error('Analysis fetch failed', err);
        return { __failed: true };
      });

      if (analysisRes.__failed || !analysisRes.analysis) {
        console.error('Analysis unavailable — keeping previous view, flagging staleness.');
        setAnalysisStale(true);
      } else {
        setAnalysisStale(false);
      }
      if (analysisRes.analysis) setAnalysis(analysisRes.analysis);
      if (analysisRes.previousAnalysis) setPreviousAnalysis(analysisRes.previousAnalysis);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Refresh error:', err);
    } finally {
      setLoading(false);
    }
  }, [user, refetchPorts, refetchCategorizedNews]);

  useEffect(() => {
    if (user && user.is_onboarded && !showSettings && !showAdmin) refresh();
  }, [refresh, user, showSettings, showAdmin]);

  useEffect(() => {
    if (timeframe === 'LIVE' || !liveSelectedSymbol) return;
    let active = true;
    const fetchHistory = async () => {
      setHistLoading(true);
      try {
        const res = await fetch(`${API_BASE}/history?symbol=${liveSelectedSymbol}&range=${timeframe}`, { credentials: 'include' });
        const data = await res.json();
        if (active && data.success) {
          setHistData(data.data);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (active) setHistLoading(false);
      }
    };
    fetchHistory();
    return () => { active = false; };
  }, [timeframe, liveSelectedSymbol]);

  // ── Fetch recent labeled insights directly (guaranteed to have data once
  // any scan has run — does not depend on the live news feed still
  // containing the same articles) ──
  useEffect(() => {
    if (tab !== 'alerts' || !user) return;
    refetchCategorizedNews();
  }, [tab, user, refetchCategorizedNews]);

  // Keep the Morning Brief's tracked-commodity prices fresh while the
  // Command Center is open. Server prices re-fetch from Yahoo every 15 min;
  // a 60s poll picks changes up without hammering anything.
  useEffect(() => {
    if (tab !== 'pulse' || !user) return;
    const id = setInterval(() => {
      // A backgrounded tab cannot show a fresher brief, so do not fetch one.
      // The next visible tick picks the change up within 60s.
      if (document.hidden) return;
      fetch(`${API_BASE}/morning-brief`, { credentials: 'include' })
        .then(async r => {
          const d = await r.json();
          if (!r.ok || !d.success) throw new Error(d.error || `HTTP ${r.status}`);
          return d;
        })
        .then(d => { setMorningBrief(d); setMorningBriefError(''); })
        .catch(err => {
          // Keep the last good brief on screen, but mark it stale so the user
          // knows the 60s refresh stopped working.
          console.error('Morning brief poll failed', err);
          setMorningBriefError(`Live refresh failed: ${err.message}`);
        });
    }, 60 * 1000);
    return () => clearInterval(id);
  }, [tab, user]);

  // Match visible alert cards against stored AI labels (dates, figures,
  // action notes) so alerted articles carry the same intelligence as the
  // labeled-articles panel.
  useEffect(() => {
    if (tab !== 'alerts' || !user) return;
    const alertArticles = (analysis?.alerts || [])
      .filter(a => a.url || a.title)
      .map(a => ({ url: a.url, title: a.title }));
    if (alertArticles.length === 0) return;
    fetch(`${API_BASE}/insights/by-articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ articles: alertArticles }),
    })
      .then(r => r.json())
      .then(d => { if (d.success) setAlertInsights({ byUrl: d.byUrl || {}, byTitle: d.byTitle || {} }); })
      .catch(err => console.error('Alert insights fetch failed', err));
  }, [tab, user, analysis?.alerts]);

  const openArticleSummary = (article) => {
    setArticleSummary({ article, loading: true, data: null, error: null });
    fetch(`${API_BASE}/article-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ url: article.url, title: article.title, description: article.description, source: article.source }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success) setArticleSummary({ article, loading: false, data: d.insight, error: null, source: d.source });
        else setArticleSummary({ article, loading: false, data: null, error: d.error || 'Failed to generate summary' });
      })
      .catch(() => setArticleSummary({ article, loading: false, data: null, error: 'Network error' }));
  };

  const refetchInsights = () => {
    fetch(`${API_BASE}/news/categorized`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success) { setCategorizedNews(d.items || []); setRegionCatalog(d.regionCatalog || []); setCategorizedNewsError(''); }
        else setCategorizedNewsError(d.error || 'Categorized news unavailable.');
      })
      .catch(err => {
        console.error('Categorized news refetch failed', err);
        setCategorizedNewsError('Categorized news unavailable.');
      });
  };

  // Save from Settings. On a material change the backend hides old alerts/
  // labels and kicks a fresh scan; we clear the stale view immediately, then
  // poll scan-status and refetch once the new-profile results land.
  const handleProfileSave = (p, rescan) => {
    setProfile(p);
    setShowSettings(false);
    if (rescan) {
      setAnalysis(prev => ({ ...prev, alerts: [] }));
      setCategorizedNews([]);
      setAlertInsights({ byUrl: {}, byTitle: {} });
      setRescanning(true);
    }
    refresh();
    if (!rescan) return;
    const startedAt = Date.now();
    const poll = () => {
      if (Date.now() - startedAt > 8 * 60 * 1000) { setRescanning(false); return; } // safety cap
      fetch(`${API_BASE}/scan-status`, { credentials: 'include' })
        .then(r => r.json())
        .then(d => {
          if (d.success && !d.running) {
            setRescanning(false);
            refresh();
            refetchInsights();
          } else {
            setTimeout(poll, 3000);
          }
        })
        .catch(() => setTimeout(poll, 3000));
    };
    setTimeout(poll, 3000);
  };

  // ── Fetch stored labeling insights for the current news feed (hover cards) ──
  useEffect(() => {
    if (!news || news.length === 0) { setNewsInsights({ byUrl: {}, byTitle: {} }); return; }
    const articles = news.slice(0, 60).map(a => ({ url: a.url, title: a.title }));
    fetch(`${API_BASE}/insights/by-articles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ articles }),
    })
      .then(r => r.json())
      .then(d => { if (d.success) setNewsInsights({ byUrl: d.byUrl || {}, byTitle: d.byTitle || {} }); })
      .catch(err => console.error('News insights fetch failed', err));
  }, [news]);

  // ── SSE Live Price Feed ──
  useEffect(() => {
    if (!user || !user.is_onboarded || showSettings || showAdmin) return;
    const sse = new EventSource(`${API_BASE}/live-feed`, { withCredentials: true });
    sse.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'snapshot') {
          const cleanPrices = { ...data.prices };

          setLivePrices(cleanPrices);
          setLiveSelectedSymbol(prev => {
            if (!cleanPrices[prev]) {
              const keys = Object.keys(cleanPrices);
              if (keys.length === 0) return prev;
              return keys.includes('BRENT_CRUDE') ? 'BRENT_CRUDE' : keys[0];
            }
            return prev;
          });
        } else if (data.type === 'tick') {
          setLivePrices(prev => {
            const next = { ...prev };
            for (const [sym, update] of Object.entries(data.prices)) {
              if (next[sym]) {
                const updatedHist = [...(next[sym].history || []), { time: update.time, price: update.price }];
                if (updatedHist.length > 200) updatedHist.shift();
                next[sym] = { ...next[sym], ...update, current: update.price, history: updatedHist };
              }
            }
            return next;
          });
        }
      } catch (err) { console.error('SSE Error:', err); }
    };
    return () => sse.close();
  }, [user, profile, showSettings, showAdmin]);

  const analyzeCommodity = async (symbol) => {
    if (commodityAnalysis[symbol]) return;
    setLoadingCommodity(symbol);
    try {
      const res = await fetch(`${API_BASE}/analyze-commodity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commodity: symbol, prices, weather: weatherExt, forex, energy }),
      }).then(r => r.json());
      if (res.analysis) setCommodityAnalysis(prev => ({ ...prev, [symbol]: res.analysis }));
    } catch (err) { console.error('Commodity analysis error:', err); }
    finally { setLoadingCommodity(null); }
  };

  const selectCommodity = (symbol) => {
    setSelectedCommodity(selectedCommodity === symbol ? null : symbol);
    if (selectedCommodity !== symbol) analyzeCommodity(symbol);
  };

  const searchTrack = async () => {
    if (!trackSearch) return;
    setIsTracking(true);
    try {
      const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(trackSearch)}`, { credentials: 'include' }).then(r => r.json());
      setTrackResults(res.results || []);
    } catch (e) {
      console.error(e);
    }
    setIsTracking(false);
  };

  const trackCommodity = async (result) => {
    // Generate a safe symbol name from the shortname
    const symbol = (result.shortname || result.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '_').substring(0, 15);
    try {
      await fetch(`${API_BASE}/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ symbol, ticker: result.symbol, name: result.shortname })
      });
      setShowTrackModal(false);
      setTrackSearch('');
      setTrackResults([]);
      // We need to fetch the updated profile to get the newly tracked item
      const authRes = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' }).then(r => r.json());
      if (authRes.user && authRes.profile) {
        setProfile(authRes.profile);
      }
      refresh(); // Reload to get the newly tracked item
    } catch (e) {
      console.error("Failed to track", e);
    }
  };

  // ── Helper functions ──
  const formatPrice = (price, sym) => {
    if (sym === 'COCOA') return price.toFixed(0);
    if (price < 0.01) return price.toFixed(6);
    if (price < 1) return price.toFixed(4);
    if (price < 10) return price.toFixed(3);
    return price.toFixed(2);
  };
  const getStrengthColor = (s) => s >= 7 ? 'var(--accent-rose)' : s >= 4 ? 'var(--accent-amber)' : 'var(--accent-emerald)';
  const getRiskColor = (score) => score >= 7 ? 'risk-critical' : score >= 5 ? 'risk-high' : score >= 3 ? 'risk-medium' : 'risk-low';
  const getSoilColor = (val) => val > 0.3 ? 'var(--accent-emerald)' : val > 0.15 ? 'var(--accent-amber)' : 'var(--accent-rose)';

  const summary = analysis?.summary;
  const drivers = analysis?.drivers || [];
  const driversError = analysis?.driversError;
  const alerts = (analysis?.alerts || []).sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99));

  // Alerts tab filters: the severity pills plus the topbar/inline search box.
  // Both narrow the same list, so what the pill count says and what the list
  // shows can never diverge.
  const visibleAlerts = alerts.filter(a => {
    if (alertSev !== 'All' && (a.severity || 'CRITICAL').toUpperCase() !== alertSev.toUpperCase()) return false;
    const q = globalSearch.trim().toLowerCase();
    if (!q) return true;
    return [a.title, a.reason, a.description, a.source].filter(Boolean)
      .some(v => String(v).toLowerCase().includes(q));
  });

  const [precedents, setPrecedents] = useState({});

  const findPrecedent = async (a, key) => {
    setPrecedents(prev => ({ ...prev, [key]: 'loading' }));
    try {
      const res = await fetch(`${API_BASE}/precedent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text: `${a.title} ${a.reason || ''}`, category: a.category || null }),
      });
      const data = await res.json();
      // A failed lookup must NOT collapse into the same empty shape as a
      // genuine no-match — that rendered "no precedent matched" and told the
      // user the search succeeded and found nothing.
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Precedent lookup failed (HTTP ${res.status})`);
      }
      setPrecedents(prev => ({ ...prev, [key]: { precedents: data.precedents || [], analogs: data.analogs || null } }));
    } catch (err) {
      console.error('Precedent lookup failed:', err);
      setPrecedents(prev => ({ ...prev, [key]: { error: err.message || 'Precedent lookup failed' } }));
    }
  };

  const acknowledgeAlert = async (alertId) => {
    try {
      await fetch(`${API_BASE}/alerts/${alertId}/ack`, { method: 'POST', credentials: 'include' });
      setAnalysis(prev => ({ ...prev, alerts: (prev?.alerts || []).filter(x => x.id !== alertId) }));
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
    }
  };
  const forecast = analysis?.forecast;
  const scenarios = analysis?.simulatedFutures?.scenarios || [];
  const recommendations = aiRecommendations || [];
  const counterfactuals = analysis?.counterfactuals || [];
  const missingData = analysis?.missingData || [];

  if (authLoading) return <div style={{padding:'40px', color:'#1a1d24'}}>Loading Authentication...</div>;
  if (!user) return <LoginPage onLogin={({ user: u, profile: p }) => { setUser(u); setProfile(p); }} />;
  if (!user.is_onboarded) return <OnboardingWizard user={user} onComplete={(p) => { setProfile(p); setUser({...user, is_onboarded: true}); }} />;
  if (showPipelineAnalytics) return <PipelineAnalyticsPage onBack={() => setShowPipelineAnalytics(false)} />;
  if (showSettings) return <SettingsPage user={user} profile={profile} onSave={handleProfileSave} onCancel={() => setShowSettings(false)} />;
  if (showAdmin && user.is_admin) return <AdminPage onBack={() => setShowAdmin(false)} />;

  const handlePredictYield = async (region) => {
    setLoadingForecasts(prev => ({ ...prev, [region.name]: true }));
    try {
      const res = await fetch(`${API_BASE}/weather/ai-forecast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: region.name,
          crop: region.crop,
          analytics: region.analytics
        })
      });
      const data = await res.json();
      if (data.success) {
        setAiForecasts(prev => ({ ...prev, [region.name]: data.forecast }));
      } else {
        setAiForecasts(prev => ({ ...prev, [region.name]: 'AI Forecast failed: ' + data.error }));
      }
    } catch(e) {
      setAiForecasts(prev => ({ ...prev, [region.name]: 'AI Forecast failed to connect.' }));
    }
    setLoadingForecasts(prev => ({ ...prev, [region.name]: false }));
  };

  const handleCreateSop = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/sop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(newSop),
      });
      const data = await res.json();
      if (data.success) {
        setSopPlans(prev => [data.plan, ...prev]);
        setShowSopModal(false);
        setNewSop({ commodity: '', region: '', plan_type: 'procurement', target_value: '', period_start: '', period_end: '' });
      }
    } catch (err) {
      console.error('Failed to create SOP:', err);
    }
  };

  const handleUpdateSopActual = async (id, actualValue, notes) => {
    try {
      const res = await fetch(`${API_BASE}/sop/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ actual_value: actualValue, notes }),
      });
      if (res.ok) {
        setSopPlans(prev => prev.map(p => p.id === id ? { ...p, actual_value: actualValue, notes } : p));
      }
    } catch (err) {
      console.error('Failed to update SOP:', err);
    }
  };
  // Recommendation card, laid out as the FOps Dashboards mockup draws it:
  // title, body, BUSINESS IMPACT well, REASONING well, then the action row.
  const renderRecCard = (r, i) => {
    const actionText = Array.isArray(r.action) ? r.action.join(' ') : r.action;
    return (
      <div key={r.timeframe + '-' + i} className="fp-rec">
        <div className="fp-rec-title">{r.title || (Array.isArray(r.action) ? r.action[0] : r.action)}</div>
        {(r.title || Array.isArray(r.action)) && (
          <div className="fp-rec-body">
            {Array.isArray(r.action)
              ? <ul style={{ margin: 0, paddingLeft: '18px' }}>{r.action.map((a, j) => <li key={j} style={{ marginBottom: '4px' }}>{a}</li>)}</ul>
              : r.action}
          </div>
        )}
        {r.businessImpact && (
          <div className="fp-rec-impact">
            <div className="fp-rec-k">BUSINESS IMPACT</div>
            <div className="fp-rec-v">{r.businessImpact}</div>
          </div>
        )}
        {r.reasoning && (
          <div className="fp-rec-reason">
            <div className="fp-rec-k">REASONING</div>
            <div className="fp-rec-v dim">{r.reasoning}</div>
          </div>
        )}

        <div className="fp-rec-actions">
          <AiFeedbackWidget featureName="RECOMMENDATION" context={r} aiResponse={actionText} />
          <span style={{ flex: '1 1 0%' }} />
          <button
            className="fp-btn fp-btn-sm fp-btn-primary"
            onClick={() => handleDeepDive(r, i)}
            disabled={deepDiveLoading[i]}
            style={deepDiveLoading[i] ? { cursor: 'wait' } : undefined}
          >
            {deepDiveLoading[i] ? 'Generating…' : deepDiveText[i] ? 'Regenerate' : 'Request AI Deep Dive'}
          </button>
        </div>

        {deepDiveError[i] && (
          <div className="fp-err" style={{ marginTop: '12px', marginBottom: 0, display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <span>⚠ {deepDiveError[i]}</span>
            <button
              onClick={() => { setDeepDiveError(prev => ({ ...prev, [i]: '' })); handleDeepDive(r, i); }}
              disabled={deepDiveLoading[i]}
              style={{ background: 'none', border: 'none', color: 'var(--fp-red)', cursor: deepDiveLoading[i] ? 'wait' : 'pointer', fontSize: '13px', textDecoration: 'underline', padding: 0 }}
            >{deepDiveLoading[i] ? 'Retrying…' : 'Retry'}</button>
          </div>
        )}
        {deepDiveText[i] && (
          <div className="fp-rec-deep">
            <div className="fp-rec-k">AI DEEP DIVE</div>
            {deepDiveText[i]}
            <div style={{ marginTop: '10px' }}>
              <AiFeedbackWidget featureName="DEEP_DIVE" context={r} aiResponse={deepDiveText[i]} />
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <Shell
      user={user}
      onOpenSettings={() => setShowSettings(true)}
      onOpenAdmin={() => setShowAdmin(true)}
      onOpenAnalytics={() => setShowPipelineAnalytics(true)}
      onLogout={handleLogout}
      search={globalSearch}
      onSearch={setGlobalSearch}
      lastRefresh={lastRefresh ? formatTimeAgo(secondsAgo) : null}
      loading={loading}
      onRefresh={refresh}
      alertCount={highCriticalAlertsCount}
    >
      {/* ══════════ LOADING ══════════ */}
      {loading && !analysis && (
        <div className="loading-overlay">
          <div className="hex-spinner"><div /><div /></div>
          <div className="loading-text">Initializing Market Intelligence Engine</div>
          <div className="loading-steps">
            <div className={`loading-step ${loadingStep >= 1 ? (loadingStep > 1 ? 'done' : 'active') : ''}`}><span className="loading-step-dot" />Prices</div>
            <div className={`loading-step ${loadingStep >= 2 ? (loadingStep > 2 ? 'done' : 'active') : ''}`}><span className="loading-step-dot" />Weather</div>
            <div className={`loading-step ${loadingStep >= 3 ? (loadingStep > 3 ? 'done' : 'active') : ''}`}><span className="loading-step-dot" />News</div>
            <div className={`loading-step ${loadingStep >= 4 ? (loadingStep > 4 ? 'done' : 'active') : ''}`}><span className="loading-step-dot" />AI Analysis</div>
          </div>
        </div>
      )}

      {/* ══════════ PAGE HEAD + TABS ══════════ */}
      <div className="fp-pagehead">
        <h1>Market Pulse</h1>
        <p>Live commodity, logistics and market intelligence for GCC food operations.</p>
      </div>
      <div className="fp-tabs" ref={tabNavRef}>
        {tabs.map(t => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            ref={el => { tabBtnsRef.current[t.id] = el; }}
            className={`fp-tab${tab === t.id ? ' on' : ''}`}
            onClick={() => switchTab(t.id)}
          >
            {t.label}
            {t.count > 0 && <span className="fp-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* ═══════════ COMMAND CENTER ═══════════ */}
      {tab === 'pulse' && (
        <div className={`fp-stack tab-content enter-${tabDirection}`} key="pulse">

          {analysisStale && (
            <div className="fp-warn" style={{ marginBottom: 0 }}>
              ⚠ The analysis service did not respond on the last refresh. Alerts, drivers and the summary below may be out of date.
            </div>
          )}
          <MorningBrief brief={morningBrief} error={morningBriefError} username={user?.username} onViewAlerts={() => switchTab('alerts')} onSelectCommodity={(m) => setChartModal(m)} />

          <PortCongestionStrip ports={ports} onAdd={addPort} onRemove={removePort} />

          <ForexStrip rates={forex} onAdd={addCurrency} onRemove={removeCurrency} />

          <WeatherStrip regions={weather} onAdd={addWeatherRegion} onRemove={removeWeatherRegion} />

          {(drivers.length > 0 || (driversError && drivers.length === 0)) && (
            <div className="fp-card">
              <div className="fp-sec-label">MARKET INDICATORS</div>
              {driversError && drivers.length === 0 ? (
                <div className="fp-err" style={{ marginBottom: 0 }}>⚠ {driversError}</div>
              ) : (
                <div className="fp-grid-3">
                  {(drivers || []).map((d, i) => {
                    const col = d.direction === 'UP' ? '#dc2626' : d.direction === 'DOWN' ? '#16a34a' : '#9aa2af';
                    const arrow = d.direction === 'UP' ? 'M12 19V5M5 12l7-7 7 7'
                      : d.direction === 'DOWN' ? 'M12 5v14M5 12l7 7 7-7'
                      : 'M5 12h14M14 7l5 5-5 5';
                    return (
                      <div key={i} className="fp-ind">
                        <div className="fp-ind-head">
                          <span className="fp-ind-icon" style={{ border: `1px solid ${col}44` }}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={col} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <path d={arrow} />
                            </svg>
                          </span>
                          {d.category && <span className="fp-ind-kind">{String(d.category).replace(/_/g, ' ')}</span>}
                          <span style={{ flex: '1 1 0%' }} />
                        </div>
                        <div className="fp-ind-title">{d.factor}</div>
                        <div className="fp-ind-body">{d.explanation}</div>
                        <div className="fp-ind-bar">
                          <div style={{ width: `${d.strength * 10}%`, background: getStrengthColor(d.strength) }} />
                        </div>
                        {d.evidence?.length > 0 && (
                          <div className="fp-chips">
                            {d.evidence.map((e, j) => <span key={j} className="fp-chip">{e}</span>)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>
      )}



      {/* ═══════════ ALERTS ═══════════ */}
      {tab === 'alerts' && (
        <div className={`tab-content enter-${tabDirection}`} key="alerts">
          {rescanning && (
            <div className="fp-warn">
              ⟳ Rescanning with your new settings — alerts and labeled articles will refresh automatically when it finishes.
            </div>
          )}
          <div className="fp-filters">
            <div className="fp-filter-search">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#aab1bd" strokeWidth="2">
                <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeLinecap="round" />
              </svg>
              <input value={globalSearch} onChange={e => setGlobalSearch(e.target.value)} placeholder="Search alerts" />
            </div>
            <div className="fp-pills">
              {['All', 'Critical', 'High', 'Medium', 'Low'].map(s => (
                <button
                  key={s}
                  className={`fp-pill${alertSev === s ? ' on' : ''}`}
                  onClick={() => setAlertSev(s)}
                >{s}</button>
              ))}
            </div>
          </div>

          {visibleAlerts.length === 0 ? (
            <div className="fp-card fp-empty">
              {alerts.length === 0 ? 'No active alerts.' : 'No alerts match this filter.'}
            </div>
          ) : (
            <div className="fp-alerts">
          {visibleAlerts.map((a, i) => (
            <div key={i} className="fp-alert" style={{ boxShadow: `3px 0 0 inset ${SEV_COLOR[a.severity] || SEV_COLOR.CRITICAL}` }}>
              <div className="fp-alert-main">
              <div className="fp-alert-top">
                <span className="fp-sev" style={{ color: SEV_COLOR[a.severity] || SEV_COLOR.CRITICAL, background: SEV_BG[a.severity] || SEV_BG.CRITICAL }}>
                  {(a.severity || 'CRITICAL').charAt(0) + (a.severity || 'CRITICAL').slice(1).toLowerCase()}
                </span>
                <span className="fp-alert-title">
                  {a.url
                    ? <a href={a.url} target="_blank" rel="noreferrer">{a.title} ↗</a>
                    : a.title}
                </span>
                {(() => {
                  let p = a.payload; if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
                  const sim = p?.semanticSimilarity;
                  return (sim != null && !isNaN(sim)) ? (
                    <span className="fp-chip" title="Embedding match to your profile (cosine similarity)">
                      ⛭ {Math.round(sim * 100)}%
                    </span>
                  ) : null;
                })()}
              </div>
              {(a.timestamp || a.source) && (
                <div className="fp-alert-meta">{[a.timestamp, a.source].filter(Boolean).join(' · ')}</div>
              )}
              <div className="fp-alert-body">{a.reason || a.description}</div>

              {(() => {
                const ins = alertInsights.byUrl?.[a.url] || alertInsights.byTitle?.[(a.title || '').trim().toLowerCase()];
                if (!ins) return null;
                const d = ins.detail || {};
                return (
                  <div style={{ marginTop: '10px', padding: '10px 12px', background: 'rgba(0,57,156,0.06)', borderLeft: '2px solid rgba(0,57,156,0.5)', borderRadius: '0 6px 6px 0' }}>
                    <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#00399C', marginBottom: '6px' }}>
                      ✨ AI Label{ins.category ? ` · ${ins.category.replace(/_/g, ' ')}` : ''}{ins.severity ? ` · ${ins.severity}` : ''}
                    </div>
                    {ins.headline && <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>{ins.headline}</div>}
                    {d.what && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{d.what}</div>}
                    <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {d.key_dates?.map((kd, j) => <span key={`kd-${j}`} style={{ fontSize: '10px', background: 'rgba(244,114,182,0.15)', color: '#f9a8d4', padding: '2px 6px', borderRadius: '4px' }}>📅 {kd}</span>)}
                      {d.key_figures?.map((kf, j) => <span key={`kf-${j}`} style={{ fontSize: '10px', background: 'rgba(0,57,156,0.15)', color: '#00399C', padding: '2px 6px', borderRadius: '4px' }}>📊 {kf}</span>)}
                      {d.commodities_affected?.map((c, j) => <span key={`c-${j}`} style={{ fontSize: '10px', background: 'rgba(16,185,129,0.15)', color: '#16a34a', padding: '2px 6px', borderRadius: '4px' }}>🌾 {c}</span>)}
                    </div>
                    {d.action_note && <div style={{ marginTop: '6px', fontSize: '12px', color: '#16a34a' }}>→ {d.action_note}</div>}
                  </div>
                );
              })()}

              {a.extractSummary && (
                <button
                  onClick={() => setOpenExtracts(prev => ({ ...prev, [a.id ?? a.title]: !prev[a.id ?? a.title] }))}
                  title="Key sentences extracted from the article itself (local model, no AI generation)"
                  style={{ marginTop: '8px', marginRight: '8px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.35)', color: '#16a34a', padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                >📄 Key Sentences {openExtracts[a.id ?? a.title] ? '▴' : '▾'}</button>
              )}
              {a.url && (
                <button
                  onClick={() => openArticleSummary({ url: a.url, title: (a.title || '').replace(/^🎯 Profile Alert:\s*/, ''), description: a.description || a.reason, source: a.source })}
                  title="Generate a plain-English AI summary of this article"
                  style={{ marginTop: '8px', marginRight: '8px', background: 'rgba(0,57,156,0.1)', border: '1px solid rgba(0,57,156,0.35)', color: '#00399C', padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                >✨ AI Summary</button>
              )}
              {a.extractSummary && openExtracts[a.id ?? a.title] && (
                <div style={{ marginTop: '8px', padding: '10px 12px', background: 'rgba(16,185,129,0.05)', borderLeft: '2px solid rgba(16,185,129,0.5)', borderRadius: '0 6px 6px 0' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#16a34a', marginBottom: '6px' }}>
                    📄 Key sentences from the article — extracted locally, not AI-written
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{a.extractSummary}</div>
                </div>
              )}
              {(() => {
                const pKey = a.id ?? `idx-${i}`;
                const p = precedents[pKey];
                if (p === undefined) {
                  return (
                    <button
                      onClick={() => findPrecedent(a, pKey)}
                      title="What happened to prices the last time an event like this occurred?"
                      style={{ marginTop: '8px', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.3)', color: '#2f5bf6', padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                    >📜 Last time this happened…</button>
                  );
                }
                if (p === 'loading') {
                  return <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-dim)' }}>Searching 15 years of market history…</div>;
                }
                if (p.error) {
                  return (
                    <div style={{ marginTop: '8px', fontSize: '12px', color: '#dc2626' }}>
                      ⚠ Precedent lookup failed — this is not a "no match". {p.error}{' '}
                      <button
                        onClick={() => findPrecedent(a, pKey)}
                        style={{ background: 'none', border: 'none', color: '#2f5bf6', cursor: 'pointer', fontSize: '12px', textDecoration: 'underline', padding: 0 }}
                      >Retry</button>
                    </div>
                  );
                }
                const noResults = (!p.precedents || p.precedents.length === 0) && !p.analogs;
                if (noResults) {
                  return <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-dim)' }}>No documented precedent or statistical analog matched this event.</div>;
                }
                return (
                  <div style={{ marginTop: '10px', padding: '10px 12px', background: 'rgba(6,182,212,0.06)', borderLeft: '2px solid rgba(6,182,212,0.5)', borderRadius: '0 6px 6px 0' }}>
                    {p.analogs && (
                      <div style={{ marginBottom: p.precedents?.length ? '10px' : 0 }}>
                        <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#2f5bf6', marginBottom: '6px' }}>📊 Statistical Analogs</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{p.analogs.summary}</div>
                      </div>
                    )}
                    {p.precedents?.length > 0 && (
                      <div>
                        <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#2f5bf6', marginBottom: '6px' }}>
                          📜 Historical Precedent{p.precedents[0]?.matchedBy === 'ai' && <span style={{ marginLeft: '6px', color: '#00399C', letterSpacing: 0, textTransform: 'none' }}>AI-matched</span>}
                        </div>
                        {p.precedents.map(prec => (
                          <div key={prec.id} style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '4px' }}>
                            {prec.summary}
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '6px' }}>All figures computed from real Yahoo Finance daily history. Past behavior does not guarantee repetition.</div>
                  </div>
                );
              })()}
              {a.url && (
                <div style={{ marginTop: '8px' }}>
                  <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-cyan)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    Read Full Article <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  </a>
                </div>
              )}
              </div>
              {a.id && (
                <div className="fp-alert-side">
                  <button className="fp-btn" title="Acknowledge — removes this alert from your active list"
                    onClick={() => acknowledgeAlert(a.id)}>Acknowledge</button>
                </div>
              )}
            </div>
          ))}
            </div>
          )}

          {categorizedNews.length > 0 && (() => {
            // Filter bar options derived from what's actually present.
            const allCats = [...new Set(categorizedNews.map(n => n.categoryLabel))].sort();
            // Full region/country catalog (every selectable region), not just
            // those in the current results. Falls back to feed regions if the
            // catalog hasn't loaded.
            const feedRegions = [...new Set(categorizedNews.flatMap(n => n.regions || []))];
            const allRegions = (regionCatalog.length ? regionCatalog : feedRegions.sort());
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', margin: '18px 0 4px' }}>
                <span className="section-label" style={{ margin: 0 }}>Filter news</span>
                <input value={newsSearch} onChange={e => setNewsSearch(e.target.value)} placeholder="Search title, source, entity…"
                  style={{ background: '#ffffff', border: '1px solid #ececf1', color: '#1a1d24', padding: '6px 10px', borderRadius: '6px', fontSize: '13px', minWidth: '220px', flex: '1 1 220px' }} />
                <select value={newsStreamFilter} onChange={e => setNewsStreamFilter(e.target.value)} style={{ background: '#ffffff', border: '1px solid #ececf1', color: '#1a1d24', padding: '6px 8px', borderRadius: '6px', fontSize: '12px' }}>
                  <option value="all">Both streams</option>
                  <option value="risk">🚨 Risk only</option>
                  <option value="commodity">📊 Commodity only</option>
                </select>
                <select value={newsCatFilter} onChange={e => setNewsCatFilter(e.target.value)} style={{ background: '#ffffff', border: '1px solid #ececf1', color: '#1a1d24', padding: '6px 8px', borderRadius: '6px', fontSize: '12px' }}>
                  <option value="all">All categories</option>
                  {allCats.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={newsRegionFilter} onChange={e => setNewsRegionFilter(e.target.value)} style={{ background: '#ffffff', border: '1px solid #ececf1', color: '#1a1d24', padding: '6px 8px', borderRadius: '6px', fontSize: '12px' }}>
                  <option value="all">All regions</option>
                  {allRegions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <select value={newsDateFilter} onChange={e => setNewsDateFilter(e.target.value)} title="Filter by publish date" style={{ background: '#ffffff', border: '1px solid #ececf1', color: '#1a1d24', padding: '6px 8px', borderRadius: '6px', fontSize: '12px' }}>
                  <option value="all">Any date</option>
                  <option value="24h">Published ≤ 24h</option>
                  <option value="7d">Published ≤ 7 days</option>
                  <option value="30d">Published ≤ 30 days</option>
                </select>
                {(newsSearch || newsStreamFilter !== 'all' || newsCatFilter !== 'all' || newsRegionFilter !== 'all' || newsDateFilter !== 'all') && (
                  <button onClick={() => { setNewsSearch(''); setNewsStreamFilter('all'); setNewsCatFilter('all'); setNewsRegionFilter('all'); setNewsDateFilter('all'); }} style={{ fontSize: '12px' }}>Clear</button>
                )}
              </div>
            );
          })()}

          {(() => {
            const prioColor = { Critical: '#dc2626', High: '#b45309', Medium: '#2f5bf6', Low: '#9aa2af', Ignored: '#9aa2af' };
            // Apply the filter bar.
            const q = newsSearch.trim().toLowerCase();
            // Publish-date window: when a window is selected, an article with no
            // publish date is excluded (freshness can't be verified). Older rows
            // scanned before publish dates were captured will lack one until re-scanned.
            const dateWindowMs = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }[newsDateFilter] || null;
            const matchesDate = (n) => {
              if (!dateWindowMs) return true;
              const t = n.publishedAt ? new Date(n.publishedAt).getTime() : NaN;
              return Number.isFinite(t) && (Date.now() - t) <= dateWindowMs;
            };
            const matches = (n) =>
              (newsStreamFilter === 'all' || n.stream === newsStreamFilter) &&
              (newsCatFilter === 'all' || n.categoryLabel === newsCatFilter) &&
              (newsRegionFilter === 'all' || (n.regions || []).includes(newsRegionFilter)) &&
              matchesDate(n) &&
              (!q || n.title.toLowerCase().includes(q) || (n.source || '').toLowerCase().includes(q) || (n.entities || []).some(e => e.label.toLowerCase().includes(q)));
            const filtered = categorizedNews.filter(matches);
            const riskItems = filtered.filter(n => n.stream === 'risk');
            const commodityItems = filtered.filter(n => n.stream === 'commodity');
            const otherItems = filtered.filter(n => n.stream === 'other');

            // Per-commodity grouping for the Commodity News stream. Group by the
            // user's SELECTED commodities, canonicalized to the entity matcher's
            // lowercase, space-separated form (WHEAT → "wheat", LIVE_CATTLE →
            // "live cattle") so item.commodities[] can be matched directly. An
            // article touching several tracked commodities appears under each.
            const selectedComm = (profile.commodities || []).map(c => ({
              code: c,
              canon: String(c).replace(/_/g, ' ').toLowerCase(),
              label: String(c).replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()),
            }));
            const commodityGroups = selectedComm
              .map(sc => ({ ...sc, items: commodityItems.filter(n => (n.commodities || []).includes(sc.canon)) }))
              .filter(g => g.items.length > 0);
            // Commodity-stream articles matching none of the selected commodities
            // (e.g. a customer-catalog commodity) — kept visible, not grouped.
            const groupedUrls = new Set(commodityGroups.flatMap(g => g.items.map(i => i.url)));
            const ungroupedCommodity = commodityItems.filter(n => !groupedUrls.has(n.url));

            const card = (n, i) => (
              <div key={n.url || i} className="intel-card mb-sm" style={{ animationDelay: `${i * 0.03}s`, borderLeft: `2px solid ${n.isDisruption ? '#dc2626' : (prioColor[n.priority] || 'rgba(0,57,156,0.55)')}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                  <a href={n.url} target="_blank" rel="noreferrer" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', textDecoration: 'none' }}>
                    {n.title}
                  </a>
                  {n.priority && n.priority !== 'Ignored' && (
                    <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', color: prioColor[n.priority], border: `1px solid ${prioColor[n.priority]}`, borderRadius: '4px', padding: '1px 6px', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {n.priority.toUpperCase()}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '4px',
                    background: n.isDisruption ? 'rgba(251,113,133,0.15)' : 'rgba(0,57,156,0.12)',
                    color: n.isDisruption ? '#dc2626' : '#00399C' }}>
                    {n.categoryEmoji} {n.categoryLabel}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{n.source}</span>
                  {n.publishedAt && (
                    <span title="Published" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                      · {new Date(n.publishedAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                  )}
                </div>
                {n.entities?.length > 0 && (() => {
                  const icon = { commodity: '🌾', region: '📍', chokepoint: '⚓', port: '🚢', route: '🛳️', supplier: '🏭' };
                  return (
                    <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {n.entities.map((e, k) => (
                        <span key={k} title={`${e.type} (master-data match)`} style={{ fontSize: '10px', background: 'rgba(16,185,129,0.12)', color: '#16a34a', padding: '2px 6px', borderRadius: '4px' }}>
                          {icon[e.type] || '•'} {e.label}
                        </span>
                      ))}
                    </div>
                  );
                })()}
              </div>
            );

            const section = (title, subtitle, items, accent) => (
              <div className="mb-xl mt-lg">
                <div className="section-label" style={{ margin: '0 0 4px', color: accent }}>{title} <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {items.length}</span></div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '12px' }}>{subtitle}</div>
                {items.length === 0
                  ? <div className="intel-card" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>No {title.replace(/^[^ ]+ /, '').toLowerCase()} in the last 48h.</div>
                  : items.map(card)}
              </div>
            );

            if (categorizedNews.length === 0) {
              // Distinguish "the feed is empty" from "the request failed" —
              // telling the user to run a scan when the API is down sends them
              // chasing the wrong problem.
              return (
                <div className="intel-card mt-lg" style={{ textAlign: 'center', padding: '24px', color: categorizedNewsError ? '#dc2626' : 'var(--text-muted)', fontSize: '13px' }}>
                  {categorizedNewsError
                    ? `⚠ ${categorizedNewsError} This is a load failure, not an empty feed.`
                    : 'No categorized news yet. Run a scan (Pipeline Analytics → Run Scanner Now) to populate the feed.'}
                </div>
              );
            }
            // Two separate, region-aware streams — never mixed.
            return (
              <>
                {section('🚨 Supply Chain Risk', 'Supply-chain-risk factors (disruption, geopolitical, chokepoints, trade policy) touching your regions.', riskItems, '#dc2626')}
                {/* Commodity News — grouped per selected commodity */}
                <div className="mb-xl mt-lg">
                  <div className="section-label" style={{ margin: '0 0 4px', color: '#2f5bf6' }}>📊 Commodity News <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {commodityItems.length}</span></div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '12px' }}>Market, price and production news grouped by your tracked commodities.</div>
                  {commodityItems.length === 0
                    ? <div className="intel-card" style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>No commodity news in the last 48h.</div>
                    : (
                      <>
                        {commodityGroups.map(g => (
                          <div key={g.code} style={{ marginBottom: '16px' }}>
                            <div style={{ fontSize: '12px', fontWeight: 700, color: '#7dd3fc', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              🌾 {g.label} <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {g.items.length}</span>
                            </div>
                            {g.items.map(card)}
                          </div>
                        ))}
                        {ungroupedCommodity.length > 0 && (
                          <div style={{ marginBottom: '16px' }}>
                            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', margin: '0 0 8px' }}>
                              Other commodities <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>· {ungroupedCommodity.length}</span>
                            </div>
                            {ungroupedCommodity.map(card)}
                          </div>
                        )}
                      </>
                    )}
                </div>
                {otherItems.length > 0 && (
                  <details style={{ marginTop: '8px' }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: '12px' }}>
                      Other accepted articles · {otherItems.length} <span style={{ color: 'var(--text-dim)' }}>(no clear region match — shown for transparency, not mixed into the two streams above)</span>
                    </summary>
                    <div style={{ marginTop: '8px' }}>{otherItems.map(card)}</div>
                  </details>
                )}
              </>
            );
          })()}

          <div className="mt-lg">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div className="section-label" style={{ margin: 0 }}>News Feed — {profile?.focus_product || 'Commodities'} / {profile?.focus_region || 'Global'}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  Show
                  <select value={newsLimit} onChange={e => setNewsLimit(e.target.value === 'all' ? 'all' : Number(e.target.value))} style={{ background: '#ffffff', border: '1px solid #ececf1', color: '#1a1d24', padding: '4px 8px', borderRadius: '6px', fontSize: '12px' }}>
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value="all">All</option>
                  </select>
                </label>
                <input
                  type="text"
                  placeholder="Filter news by keyword or source..."
                  value={newsFilter}
                  onChange={(e) => setNewsFilter(e.target.value)}
                  style={{ background: '#ffffff', border: '1px solid #ececf1', color: '#1a1d24', padding: '6px 12px', borderRadius: '6px', width: '300px', fontSize: '13px' }}
                />
              </div>
            </div>
            {(() => {
              const allFiltered = (news || []).filter(a => {
                if (!newsFilter.trim()) return true;
                const q = newsFilter.toLowerCase();
                return (a.title?.toLowerCase().includes(q)) ||
                       (a.description?.toLowerCase().includes(q)) ||
                       (a.source?.toLowerCase().includes(q));
              });
              const filteredNews = newsLimit === 'all' ? allFiltered : allFiltered.slice(0, newsLimit);
              
              if (filteredNews.length === 0) {
                 return <div className="intel-card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No news articles match your filter.</div>;
              }

              const sevColor = { critical: '#dc2626', high: '#b45309', medium: '#2f5bf6', low: '#9aa2af' };
              return filteredNews.map((a, i) => {
                const insight = newsInsights.byUrl?.[a.url] || newsInsights.byTitle?.[(a.title || '').trim().toLowerCase()];
                const d = insight?.detail || {};
                return (
                <div key={i} className={`intel-card mb-sm${insight ? ' has-insight' : ''}`} style={{ animationDelay: `${i * 0.05}s`, position: 'relative' }} onMouseMove={handleTilt} onMouseLeave={handleTiltReset}>
                  <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: '13px', fontWeight: 500, color: 'var(--accent-cyan)', textDecoration: 'none' }}>{a.title}</a>
                  {insight && (
                    <span style={{ marginLeft: '8px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', color: sevColor[insight.severity] || 'var(--text-muted)', border: `1px solid ${sevColor[insight.severity] || 'var(--text-muted)'}`, borderRadius: '4px', padding: '1px 6px' }}>
                      ✨ AI INSIGHT{insight.severity ? ` · ${insight.severity.toUpperCase()}` : ''}
                    </span>
                  )}
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
                    {a.source} · {a.publishedAt} {a.via && <span style={{ color: 'var(--accent-violet)' }}>via {a.via}</span>}
                  </div>
                  {a.description && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.5 }}>{a.description}</div>}
                  {insight && (
                    <div className="insight-popover">
                      <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#00399C', marginBottom: '6px' }}>
                        ✨ Aramtec Insight{insight.category ? ` · ${insight.category.replace(/_/g, ' ')}` : ''}
                      </div>
                      {insight.headline && <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>{insight.headline}</div>}
                      {d.what && <div style={{ marginBottom: '3px' }}><b style={{ color: 'var(--text-muted)' }}>What:</b> {d.what}</div>}
                      {d.where && <div style={{ marginBottom: '3px' }}><b style={{ color: 'var(--text-muted)' }}>Where:</b> {d.where}</div>}
                      {d.duration && <div style={{ marginBottom: '3px' }}><b style={{ color: 'var(--text-muted)' }}>Duration:</b> {d.duration}</div>}
                      {d.commodities_affected?.length > 0 && <div style={{ marginBottom: '3px' }}><b style={{ color: 'var(--text-muted)' }}>Commodities:</b> {d.commodities_affected.join(', ')}</div>}
                      {d.routes_affected?.length > 0 && <div style={{ marginBottom: '3px' }}><b style={{ color: 'var(--text-muted)' }}>Routes:</b> {d.routes_affected.join(', ')}</div>}
                      {d.ports_affected?.length > 0 && <div style={{ marginBottom: '3px' }}><b style={{ color: 'var(--text-muted)' }}>Ports:</b> {d.ports_affected.join(', ')}</div>}
                      {d.action_note && <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--border-subtle)', color: '#16a34a' }}>→ {d.action_note}</div>}
                      {(insight.urgency) && <div style={{ marginTop: '4px', fontSize: '10px', color: 'var(--text-dim)' }}>Urgency: {insight.urgency}</div>}
                    </div>
                  )}
                </div>
                );
              });
            })()}
          </div>
        </div>
      )}



      {/* ═══════════ MARKET INFO ═══════════ */}
      {tab === 'marketinfo' && (
        <div className={`tab-content enter-${tabDirection}`} key="marketinfo">
          <iframe
            src="/market-info.html"
            title="Market Report"
            style={{ width: '100%', height: 'calc(100vh - 260px)', minHeight: '600px', border: 'none', borderRadius: '12px', background: 'transparent' }}
          />
        </div>
      )}



      {/* ═══════════ ACTIONS ═══════════ */}
      {tab === 'actions' && (
        <div className={`tab-content enter-${tabDirection}`} key="actions">
          


          {aiRecsLoading ? (
            <div className="fp-card fp-empty">Generating personalized AI recommendations…</div>
          ) : aiRecommendationsError ? (
            <div className="fp-err">
              <strong style={{ display: 'block', marginBottom: '4px' }}>AI recommendations unavailable</strong>
              {aiRecommendationsError}
            </div>
          ) : recommendations.length > 0 && (
            (() => {
              const allRecs = recommendations || [];
              let st = allRecs.filter(r => 
                String(r.timeframe).includes('90') || 
                String(r.timeframe).toLowerCase().includes('short')
              );
              let lt = allRecs.filter(r => 
                String(r.timeframe).includes('365') || 
                String(r.timeframe).includes('1Y') ||
                String(r.timeframe).toLowerCase().includes('year') ||
                String(r.timeframe).toLowerCase().includes('long')
              );
              
              // Fallback split if LLM labeled them all the same or forgot labels
              if (st.length === allRecs.length || lt.length === allRecs.length || (st.length === 0 && lt.length === 0)) {
                const half = Math.ceil(allRecs.length / 2);
                st = allRecs.slice(0, half);
                lt = allRecs.slice(half);
              }

              return (
                <>
                  <div className="fp-sec-label">SHORT TERM (90 DAYS)</div>
                  <div className="fp-grid-2" style={{ marginBottom: '26px' }}>
                    {st.map((r, i) => renderRecCard(r, 'st-' + i))}
                    {st.length === 0 && (
                      <div className="fp-card fp-empty">No short-term recommendations available.</div>
                    )}
                  </div>
                  <div className="fp-sec-label">LONG TERM (365 DAYS)</div>
                  <div className="fp-grid-2" style={{ marginBottom: '26px' }}>
                    {lt.map((r, i) => renderRecCard(r, 'lt-' + i))}
                    {lt.length === 0 && (
                      <div className="fp-card fp-empty">No long-term recommendations available.</div>
                    )}
                  </div>
                </>
              );
            })()
          )}

          {/* Data Gaps is deliberately NOT rendered. It listed data sources the
              model wished it had (satellite soil moisture, EGP black-market
              rates, per-terminal port dwell times) — accurate, but it reads to
              a planner as a list of things the product cannot do, sitting
              directly under the analysis they came to read.

              The field is untouched: analysis.missingData still comes back on
              /api/analyze and is still visible in the "Show analysis JSON"
              panel below, so the signal is available to anyone deciding which
              data sources to buy. This hides the card, not the data. */}

          <div style={{ marginTop: '22px' }}>
            <button className="fp-btn" onClick={() => setShowJson(!showJson)}>{showJson ? 'Hide' : 'Show'} analysis JSON</button>
            {showJson && analysis && <div className="json-viewer" style={{ marginTop: '12px' }}>{JSON.stringify(analysis, null, 2)}</div>}
          </div>
        </div>
      )}
      {/* ═══════════ S&OP PLANS ═══════════ */}
      {tab === 'sop' && (
        <div className={`tab-content enter-${tabDirection}`} key="sop">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
            <div className="section-label" style={{ margin: 0 }}>Sales & Operations Plans</div>
            <button className="btn-primary" onClick={() => setShowSopModal(true)} style={{ background: 'var(--accent-cyan)', color: '#1a1d24' }}>
              <Plus size={14} /> New Plan
            </button>
          </div>

          <div className="grid-auto">
            {sopPlans.map((plan, i) => {
              const progress = plan.actual_value && plan.target_value ? Math.min((plan.actual_value / plan.target_value) * 100, 100) : 0;
              return (
                <div key={plan.id} className={`intel-card stagger-${i + 1}`} onMouseMove={handleTilt} onMouseLeave={handleTiltReset}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <div style={{ fontWeight: 'bold', fontSize: '15px' }}>{plan.commodity}</div>
                    <span className="market-state-badge STABLE" style={{ fontSize: '10px' }}>{plan.region}</span>
                  </div>
                  
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                    Period: {new Date(plan.period_start).toLocaleDateString()} - {new Date(plan.period_end).toLocaleDateString()}
                  </div>

                  <div style={{ marginBottom: '8px', fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Progress: {plan.actual_value || 0} / {plan.target_value}</span>
                    <span style={{ fontWeight: 'bold', color: progress >= 100 ? 'var(--accent-emerald)' : 'var(--text-primary)' }}>
                      {progress.toFixed(1)}%
                    </span>
                  </div>
                  
                  <div className="confidence-bar" style={{ marginBottom: '16px', background: '#f7f8fa' }}>
                    <div className="confidence-fill" style={{ width: `${progress}%`, background: progress >= 100 ? 'var(--accent-emerald)' : 'var(--accent-cyan)' }} />
                  </div>

                  <div style={{ borderTop: '1px solid #f7f8fa', paddingTop: '12px', display: 'flex', gap: '8px' }}>
                    <input 
                      type="number" 
                      placeholder="Actual" 
                      defaultValue={plan.actual_value}
                      id={`actual-${plan.id}`}
                      style={{ width: '80px', background: '#ffffff', border: '1px solid #ececf1', color: '#1a1d24', borderRadius: '4px', padding: '4px 8px', fontSize: '12px' }}
                    />
                    <button 
                      onClick={() => handleUpdateSopActual(plan.id, document.getElementById(`actual-${plan.id}`).value, plan.notes)}
                      style={{ background: '#ececf1', color: '#1a1d24', border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', flex: 1 }}
                    >
                      Update
                    </button>
                  </div>
                </div>
              );
            })}
            {sopPlans.length === 0 && (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', background: '#f7f8fa', borderRadius: '12px', gridColumn: '1 / -1' }}>
                No S&OP Plans tracked yet. Click "New Plan" to create one.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ SOP MODAL ═══════════ */}
      {showSopModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#ffffff', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: '#ffffff', border: '1px solid #ececf1', borderRadius: '12px', width: '500px', maxWidth: '90vw', padding: '24px', boxShadow: '0 20px 40px #ffffff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', color: '#1a1d24' }}>Create S&OP Target</h3>
              <button onClick={() => setShowSopModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>✕</button>
            </div>
            <form onSubmit={handleCreateSop}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Commodity</label>
                  <input required type="text" value={newSop.commodity} onChange={e => setNewSop({...newSop, commodity: e.target.value})} style={{ width: '100%', background: '#f7f8fa', border: '1px solid #ececf1', color: '#1a1d24', padding: '10px 12px', borderRadius: '6px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Region</label>
                  <input required type="text" value={newSop.region} onChange={e => setNewSop({...newSop, region: e.target.value})} style={{ width: '100%', background: '#f7f8fa', border: '1px solid #ececf1', color: '#1a1d24', padding: '10px 12px', borderRadius: '6px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Target Value (Vol/Amount)</label>
                  <input required type="number" value={newSop.target_value} onChange={e => setNewSop({...newSop, target_value: e.target.value})} style={{ width: '100%', background: '#f7f8fa', border: '1px solid #ececf1', color: '#1a1d24', padding: '10px 12px', borderRadius: '6px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Plan Type</label>
                  <select value={newSop.plan_type} onChange={e => setNewSop({...newSop, plan_type: e.target.value})} style={{ width: '100%', background: '#f7f8fa', border: '1px solid #ececf1', color: '#1a1d24', padding: '10px 12px', borderRadius: '6px', appearance: 'none' }}>
                    <option value="procurement">Procurement</option>
                    <option value="inventory">Inventory Target</option>
                    <option value="production">Production Yield</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Period Start</label>
                  <input required type="date" value={newSop.period_start} onChange={e => setNewSop({...newSop, period_start: e.target.value})} style={{ width: '100%', background: '#f7f8fa', border: '1px solid #ececf1', color: '#1a1d24', padding: '10px 12px', borderRadius: '6px', colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Period End</label>
                  <input required type="date" value={newSop.period_end} onChange={e => setNewSop({...newSop, period_end: e.target.value})} style={{ width: '100%', background: '#f7f8fa', border: '1px solid #ececf1', color: '#1a1d24', padding: '10px 12px', borderRadius: '6px', colorScheme: 'dark' }} />
                </div>
              </div>
              <button type="submit" style={{ width: '100%', background: 'var(--accent-cyan)', color: '#1a1d24', border: 'none', padding: '12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', marginTop: '8px' }}>
                Save Plan
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ═══════════ TRACK MODAL ═══════════ */}
      {showTrackModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#ffffff', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: '#ffffff', border: '1px solid #ececf1', borderRadius: '12px', width: '500px', maxWidth: '90vw', padding: '24px', boxShadow: '0 20px 40px #ffffff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', color: '#1a1d24' }}>Track New Commodity</h3>
              <button onClick={() => setShowTrackModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input 
                type="text" 
                placeholder="Search Yahoo Finance (e.g. FBMPM.L, Lithium, ZC=F)..." 
                value={trackSearch}
                onChange={e => setTrackSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchTrack()}
                style={{ flex: 1, background: '#f7f8fa', border: '1px solid #ececf1', color: '#1a1d24', padding: '10px 12px', borderRadius: '6px' }}
              />
              <button onClick={searchTrack} disabled={isTracking} style={{ background: 'var(--accent-cyan)', color: '#1a1d24', border: 'none', padding: '0 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>
                {isTracking ? '...' : 'Search'}
              </button>
            </div>
            
            <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
              {trackResults.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', borderBottom: '1px solid #f7f8fa' }}>
                  <div>
                    <div style={{ fontWeight: 'bold', color: '#1a1d24' }}>{r.symbol}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{r.shortname || r.longname} ({r.exchange})</div>
                  </div>
                  <button onClick={() => trackCommodity(r)} style={{ background: '#ececf1', color: '#1a1d24', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
                    + Track
                  </button>
                </div>
              ))}
              {trackResults.length === 0 && !isTracking && trackSearch && (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>No results found</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════ ARTICLE SUMMARY MODAL ═══════════ */}
      {articleSummary && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#ffffff', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }} onClick={() => setArticleSummary(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#ffffff', border: '1px solid #ececf1', borderRadius: '12px', width: '520px', maxWidth: '90vw', maxHeight: '80vh', overflowY: 'auto', padding: '24px', boxShadow: '0 20px 40px #ffffff' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '15px', color: '#1a1d24', lineHeight: 1.4 }}>{articleSummary.article.title}</h3>
              <button onClick={() => setArticleSummary(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px', flexShrink: 0 }}>✕</button>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '16px', fontFamily: 'var(--font-mono)' }}>
              {articleSummary.article.source}
            </div>

            {articleSummary.loading && (
              <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>✨ Generating summary…</div>
            )}

            {articleSummary.error && (
              <div style={{ color: '#dc2626', fontSize: '13px' }}>{articleSummary.error}</div>
            )}

            {!articleSummary.loading && !articleSummary.error && articleSummary.data && (() => {
              const d = articleSummary.data;
              const isLabeled = d.headline !== undefined; // shape from the labeling pipeline vs. on-demand generation
              const detail = d.detail || {};
              return (
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  {d.severity && (
                    <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', color: '#b45309', border: '1px solid #b45309', borderRadius: '4px', padding: '1px 6px', marginBottom: '10px', display: 'inline-block' }}>
                      {d.severity.toUpperCase()}{d.urgency ? ` · ${d.urgency}` : ''}
                    </span>
                  )}
                  <div style={{ marginBottom: '10px' }}>{isLabeled ? (detail.what || d.headline) : d.summary}</div>
                  {!isLabeled && d.key_figures?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '12px' }}>
                      {d.key_figures.map((kf, j) => (
                        <span key={`kf-${j}`} style={{ fontSize: '11px', fontWeight: 600, background: 'rgba(0,57,156,0.15)', color: '#00399C', padding: '2px 7px', borderRadius: '4px' }}>📊 {kf}</span>
                      ))}
                    </div>
                  )}
                  {(isLabeled ? detail.action_note : d.impact) && (
                    <div style={{ marginBottom: '10px', color: '#2f5bf6' }}>
                      <b style={{ color: 'var(--text-muted)' }}>Impact:</b> {isLabeled ? detail.action_note : d.impact}
                    </div>
                  )}
                  {!isLabeled && d.action_note && (
                    <div style={{ marginBottom: '10px', color: '#16a34a' }}>→ {d.action_note}</div>
                  )}
                  {(() => {
                    const ents = isLabeled
                      ? { commodities: detail.commodities_affected, ports: detail.ports_affected, routes: detail.routes_affected }
                      : d.entities || {};
                    const chips = [
                      ...(ents.commodities || []).map(v => ['🌾', v]),
                      ...(ents.ports || []).map(v => ['⚓', v]),
                      ...(ents.routes || []).map(v => ['🚢', v]),
                    ];
                    if (chips.length === 0) return null;
                    return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                        {chips.map(([icon, v], idx) => (
                          <span key={idx} style={{ fontSize: '10px', background: 'rgba(0,57,156,0.15)', color: '#00399C', padding: '2px 6px', borderRadius: '4px' }}>{icon} {v}</span>
                        ))}
                      </div>
                    );
                  })()}
                  <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border-subtle)' }}>
                    <a href={articleSummary.article.url} target="_blank" rel="noreferrer" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-cyan)', textDecoration: 'none' }}>Read Full Article ↗</a>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ═══════════ COMMODITY CHART MODAL ═══════════ */}
      {chartModal && (
        <Suspense fallback={<div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#ffffff', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>Loading chart…</div>}>
        <CommodityChartModal
          symbol={chartModal.symbol}
          label={chartModal.label}
          unit={chartModal.unit}
          onClose={() => setChartModal(null)}
        />
        </Suspense>
      )}

    </Shell>
  );
}
