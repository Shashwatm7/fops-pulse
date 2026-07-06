import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, BarChart, Bar, LineChart, Line, ComposedChart, ReferenceLine
} from 'recharts';
import { 
  Activity, BarChart2, Globe2, Zap, Target, PlaySquare, 
  Settings, Shield, RefreshCw, LogOut, Search, Sparkles, Plus,
  LayoutDashboard, ClipboardList, ThumbsUp, ThumbsDown, Bell
} from 'lucide-react';
import './App.css';
import LoginPage from './LoginPage.jsx';
import OnboardingWizard from './OnboardingWizard.jsx';
import SettingsPage from './SettingsPage.jsx';
import PipelineAnalyticsPage from './PipelineAnalyticsPage.jsx';
import AdminPage from './AdminPage.jsx';

const CustomTooltip = ({ active, payload, label, symbol }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const isLive = data.open === undefined; // If open is undefined, it's a live tick (no OHLC)
    return (
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', padding: '10px 14px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', minWidth: '180px' }}>
        <div style={{ color: '#94a3b8', fontSize: '11px', marginBottom: '8px', borderBottom: '1px solid #334155', paddingBottom: '4px' }}>
          Date: <span style={{ color: '#fff', float: 'right' }}>{new Date(label).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        <div style={{ fontSize: '13px', fontWeight: '600', display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span style={{ color: '#94a3b8' }}>Close:</span> <span style={{ color: '#fff' }}>{data.price}</span>
        </div>
        {!isLive && (
          <>
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span style={{ color: '#94a3b8' }}>Open:</span> <span style={{ color: '#e2e8f0' }}>{data.open}</span>
            </div>
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span style={{ color: '#94a3b8' }}>High:</span> <span style={{ color: '#e2e8f0' }}>{data.high}</span>
            </div>
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
              <span style={{ color: '#94a3b8' }}>Low:</span> <span style={{ color: '#e2e8f0' }}>{data.low}</span>
            </div>
            <div style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between', marginTop: '6px', paddingTop: '4px', borderTop: '1px solid #334155' }}>
              <span style={{ color: '#94a3b8' }}>Volume:</span> <span style={{ color: '#93c5fd' }}>{data.volume ? data.volume.toLocaleString() : 0}</span>
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
    const interval = setInterval(fetchLimits, 15000);
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
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(30, 41, 59, 0.7)', padding: '6px 12px', borderRadius: '16px', border: '1px solid #334155', fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <Zap size={14} color={isLow ? '#ef4444' : '#3b82f6'} style={{ flexShrink: 0 }} />
      <span style={{ color: '#94a3b8' }}>API Calls Left:</span>
      <strong style={{ color: isLow ? '#ef4444' : 'white' }}>{limits.remaining}</strong>
      <span style={{ color: '#334155', margin: '0 4px' }}>|</span>
      <span style={{ color: '#94a3b8' }}>Refresh in:</span>
      <strong style={{ color: '#10b981', fontVariantNumeric: 'tabular-nums', minWidth: '40px' }}>{formatTime(countdown)}</strong>
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
  const color = isUp ? '#10b981' : '#f43f5e';

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
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3}/>
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="tempMax" stroke="#f59e0b" fillOpacity={1} fill={`url(#colorTemp-${regionName.replace(/\\s+/g, '')})`} isAnimationActive={false} />
          <YAxis domain={['auto', 'auto']} hide />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

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
    return <div style={{ fontSize: '11px', color: 'var(--accent-emerald)', marginTop: '8px' }}>✓ Thank you for your feedback!</div>;
  }

  return (
    <div style={{ marginTop: '12px', padding: '8px', background: 'rgba(255,255,255,0.02)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
        <span>Was this AI response helpful?</span>
        <button onClick={() => handleRate(true)} style={{ background: isHelpful === true ? 'var(--accent-emerald)' : 'transparent', color: isHelpful === true ? '#000' : 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <ThumbsUp size={12} /> Yes
        </button>
        <button onClick={() => handleRate(false)} style={{ background: isHelpful === false ? 'var(--accent-rose)' : 'transparent', color: isHelpful === false ? '#fff' : 'var(--text-secondary)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <ThumbsDown size={12} /> No
        </button>
      </div>
      
      {status === 'rating' && (
        <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
          <input 
            type="text" 
            placeholder="Optional: Why did you choose this?" 
            value={notes} 
            onChange={e => setNotes(e.target.value)}
            style={{ flex: 1, padding: '6px', fontSize: '11px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', color: '#fff' }}
          />
          <button onClick={handleSubmit} style={{ background: 'var(--accent-violet)', color: '#fff', border: 'none', padding: '0 12px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer' }}>
            Submit
          </button>
        </div>
      )}
    </div>
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
  const [searchQuery, setSearchQuery] = useState('');
  const [showTrackModal, setShowTrackModal] = useState(false);
  const [trackSearch, setTrackSearch] = useState('');
  const [trackResults, setTrackResults] = useState([]);
  const [isTracking, setIsTracking] = useState(false);
  const [prices, setPrices] = useState([]);
  const [energy, setEnergy] = useState(null);
  const [news, setNews] = useState([]);
  const [newsFilter, setNewsFilter] = useState('');
  const [pipelineKeywords, setPipelineKeywords] = useState('');
  const [pipelineBlocklist, setPipelineBlocklist] = useState('');
  const [weather, setWeather] = useState([]);
  const [weatherExt, setWeatherExt] = useState([]);
  const [forex, setForex] = useState(null);
  const [analysis, setAnalysis] = useState(null);
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
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvKeywords, setCsvKeywords] = useState([]);
  const [mlForecasts, setMlForecasts] = useState([]);
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
      setPipelineKeywords((profile.news_keywords || []).join(', '));
      setPipelineBlocklist((profile.custom_blocklist || []).join(', '));
    }
  }, [profile]);

  const handleSavePipelineConfig = async () => {
    const news_keywords = pipelineKeywords.split(',').map(k => k.trim()).filter(Boolean);
    const custom_blocklist = pipelineBlocklist.split(',').map(k => k.trim()).filter(Boolean);
    await updateProfileField({ news_keywords, custom_blocklist });
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
      if (data.success) {
        setDeepDiveText(prev => ({...prev, [id]: data.deepDive}));
      }
    } catch (err) {
      console.error(err);
      setDeepDiveText(prev => ({...prev, [id]: err.message || 'AI Deep-Dive failed.'}));
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
    { id: 'pulse', label: 'Command Center', icon: <Activity size={14} /> },
    { id: 'alerts', label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          Alerts
          {highCriticalAlertsCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--accent-rose)', color: 'white', padding: '2px 6px', borderRadius: '10px', fontSize: '10px', fontWeight: 'bold' }}>
              <Bell size={10} />
              {highCriticalAlertsCount}
            </div>
          )}
        </div>
      ), icon: <Zap size={14} /> },
    { id: 'actions', label: 'Recommendations', icon: <PlaySquare size={14} /> }
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

  // ── Data refresh ──
  const refresh = useCallback(async () => {
    if (!user || !user.is_onboarded) return;
    setLoading(true);
    try {
      const fetchOpts = { credentials: 'include' };
      const [priceRes, energyRes, newsRes, weatherRes, forexRes, weatherExtRes, sopRes, mlForecastRes] = await Promise.all([
        fetch(`${API_BASE}/commodities`, fetchOpts).then(r => r.json()).catch(() => ({ prices: [] })),
        fetch(`${API_BASE}/energy`, fetchOpts).then(r => r.json()).catch(() => ({})),
        fetch(`${API_BASE}/news`, fetchOpts).then(r => r.json()).catch(() => ({ articles: [] })),
        fetch(`${API_BASE}/weather`, fetchOpts).then(r => r.json()).catch(() => ({ regions: [] })),
        fetch(`${API_BASE}/forex`, fetchOpts).then(r => r.json()).catch(() => null),
        fetch(`${API_BASE}/weather-extended`, fetchOpts).then(r => r.json()).catch(() => ({ regions: [] })),
        fetch(`${API_BASE}/sop`, fetchOpts).then(r => r.json()).catch(() => ({ plans: [] })),
        fetch(`${API_BASE}/ml-forecasts`, fetchOpts).then(r => r.json()).catch(() => ({ forecasts: [] })),
      ]);

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
      }).then(r => r.json()).catch(() => ({}));

      if (analysisRes.analysis) setAnalysis(analysisRes.analysis);
      if (analysisRes.previousAnalysis) setPreviousAnalysis(analysisRes.previousAnalysis);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Refresh error:', err);
    } finally {
      setLoading(false);
    }
  }, [user]);

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
  const getConfidenceColor = (c) => c >= 70 ? 'var(--accent-emerald)' : c >= 40 ? 'var(--accent-amber)' : 'var(--accent-rose)';
  const getStrengthColor = (s) => s >= 7 ? 'var(--accent-rose)' : s >= 4 ? 'var(--accent-amber)' : 'var(--accent-emerald)';
  const getRiskColor = (score) => score >= 7 ? 'risk-critical' : score >= 5 ? 'risk-high' : score >= 3 ? 'risk-medium' : 'risk-low';
  const getSoilColor = (val) => val > 0.3 ? 'var(--accent-emerald)' : val > 0.15 ? 'var(--accent-amber)' : 'var(--accent-rose)';

  const summary = analysis?.summary;
  const drivers = analysis?.drivers || [];
  const chains = analysis?.causeEffectChains || [];
  const alerts = (analysis?.alerts || []).sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99));

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

  // ── Forex ticker chips (rendered twice for seamless marquee) ──
  const forexChips = forex ? Object.entries(forex).map(([code, data]) => (
    <div key={code} className="forex-chip">
      <span className="forex-code">{code}</span>
      <span className="forex-rate">{typeof data.rate === 'number' ? data.rate.toFixed(2) : data.rate}</span>
      <span className="forex-commodities">{data.commodities?.join(', ')}</span>
    </div>
  )) : null;

  if (authLoading) return <div style={{padding:'40px', color:'white'}}>Loading Authentication...</div>;
  if (!user) return <LoginPage onLogin={({ user: u, profile: p }) => { setUser(u); setProfile(p); }} />;
  if (!user.is_onboarded) return <OnboardingWizard user={user} onComplete={(p) => { setProfile(p); setUser({...user, is_onboarded: true}); }} />;
  if (showPipelineAnalytics) return <PipelineAnalyticsPage onBack={() => setShowPipelineAnalytics(false)} />;
  if (showSettings) return <SettingsPage user={user} profile={profile} onSave={(p) => { setProfile(p); setShowSettings(false); refresh(); }} onCancel={() => setShowSettings(false)} />;
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
  const renderRecCard = (r, i) => (
    <div key={r.timeframe + '-' + i} className={`intel-card rec-card stagger-${i + 1}`} onMouseMove={handleTilt} onMouseLeave={handleTiltReset}>
      <div className="rec-action" style={{ marginTop: '0px' }}>
        {Array.isArray(r.action) ? (
          <ul style={{ paddingLeft: '20px', margin: '5px 0' }}>
            {(r.action || []).map((act, actIdx) => <li key={actIdx} style={{ marginBottom: '4px' }}>{act}</li>)}
          </ul>
        ) : (
          r.action
        )}
      </div>
      <div className="rec-impact" style={{ marginBottom: '12px' }}>{r.businessImpact}</div>
      
      <AiFeedbackWidget featureName="RECOMMENDATION" context={r} aiResponse={Array.isArray(r.action) ? r.action.join(' ') : r.action} />
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px' }}>
        {deepDiveText[i] ? (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5, background: 'rgba(139, 92, 246, 0.05)', padding: '10px', borderRadius: '6px', borderLeft: '2px solid var(--accent-violet)', whiteSpace: 'pre-wrap' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <strong style={{ color: '#fff' }}>✨ AI Deep-Dive Analysis:</strong>
              <button 
                onClick={() => handleDeepDive(r, i)}
                disabled={deepDiveLoading[i]}
                style={{ background: 'rgba(139, 92, 246, 0.2)', color: '#c4b5fd', border: '1px solid rgba(139, 92, 246, 0.5)', padding: '4px 8px', borderRadius: '4px', fontSize: '10px', cursor: deepDiveLoading[i] ? 'wait' : 'pointer', opacity: deepDiveLoading[i] ? 0.5 : 1, transition: 'all 0.2s ease' }}
                onMouseOver={(e) => { if (!deepDiveLoading[i]) e.currentTarget.style.background = 'rgba(139, 92, 246, 0.4)'; }}
                onMouseOut={(e) => { if (!deepDiveLoading[i]) e.currentTarget.style.background = 'rgba(139, 92, 246, 0.2)'; }}
              >
                {deepDiveLoading[i] ? 'Generating...' : 'Regenerate ✨'}
              </button>
            </div>
            {deepDiveText[i]}
            <div style={{ marginTop: '8px' }}>
              <AiFeedbackWidget featureName="DEEP_DIVE" context={r} aiResponse={deepDiveText[i]} />
            </div>
          </div>
        ) : (
          <button 
            className="action-btn" 
            onClick={() => handleDeepDive(r, i)}
            disabled={deepDiveLoading[i]}
            style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', padding: '12px', fontSize: '12px', borderRadius: '6px', background: 'rgba(139, 92, 246, 0.1)', color: '#c4b5fd', border: '1px solid rgba(139, 92, 246, 0.2)', cursor: deepDiveLoading[i] ? 'wait' : 'pointer', transition: 'all 0.2s ease', opacity: deepDiveLoading[i] ? 0.7 : 1 }}
          >
            {deepDiveLoading[i] ? (
              <><span style={{ animation: 'spin 1s linear infinite' }}>⏳</span> Generating Analysis...</>
            ) : (
              <>✨ Request AI Deep-Dive</>
            )}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div>
      {/* ══════════ HEADER ══════════ */}
      <header className={`pulse-header market-${summary?.market_state || 'STABLE'}`}>
        <div className="pulse-logo">
          <div>
            <h1>⬡ FOPs Market Pulse</h1>
            <div className="subtitle">{profile?.focus_product || 'Commodities'} Supply Chain Intelligence — {profile?.focus_region || 'Global'}</div>
          </div>
        </div>
        
        <div style={{display:'flex', alignItems:'center', gap:'12px'}}>
          {/* <ApiLimitTracker /> */}
          <div style={{color:'var(--text-secondary)', fontSize:'13px', marginRight: '8px', marginLeft: '12px'}}>
            Welcome, <strong style={{color:'white'}}>{user.username}</strong>
          </div>
          {user.is_admin ? (
            <button className="btn-secondary" onClick={() => setShowAdmin(true)}>
              <Shield size={14} /> Admin
            </button>
          ) : null}
          <button className="btn-secondary" onClick={() => setShowPipelineAnalytics(true)}>
            📊 Pipeline Analytics
          </button>
          <button className="btn-secondary" onClick={() => setShowSettings(true)}>
            <Settings size={14} /> Settings
          </button>
          <button className="btn-secondary" onClick={handleLogout} style={{color:'var(--danger)', borderColor: 'rgba(239, 68, 68, 0.3)'}}>
            <LogOut size={14} /> Logout
          </button>
        </div>
        <div className="header-controls">
          <div className="live-indicator">
            <span className="live-dot" />
            <span className="live-ring" />
            LIVE
          </div>
          {summary && <span className={`market-state-badge ${summary.market_state}`}>{summary.market_state}</span>}
          {summary && (
            <div className="confidence-gauge">
              <div className="confidence-bar">
                <div className="confidence-fill" style={{ width: `${summary.confidence}%`, background: getConfidenceColor(summary.confidence) }} />
              </div>
              <span>{summary.confidence}%</span>
            </div>
          )}
          <span className="time-ago">{formatTimeAgo(secondsAgo)}</span>
          <button
            className="btn-primary"
            onClick={() => setShowTrackModal(true)}
            style={{ background: 'var(--accent-emerald)', color: '#000' }}
          >
            <Plus size={14} /> Track New
          </button>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '10px', color: 'var(--text-muted)' }} />
            <input 
              type="text" 
              placeholder="Search items..." 
              value={searchQuery} 
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: '200px', paddingLeft: '32px' }}
            />
          </div>
          <button
            className="btn-primary"
            onClick={(e) => { handleRipple(e); refresh(); }}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} /> {loading ? 'Analyzing...' : 'Sync'}
          </button>
        </div>
      </header>

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

      {/* ══════════ SUMMARY BANNER REMOVED ══════════ */}

      {/* ══════════ FOREX TICKER REMOVED ══════════ */}

      {/* ══════════ TABS ══════════ */}
      <nav className="tab-navigation" ref={tabNavRef}>
        <div className="tab-indicator" style={{ left: indicatorStyle.left, width: indicatorStyle.width }} />
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            ref={el => { tabBtnsRef.current[t.id] = el; }}
            className={`tab-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => switchTab(t.id)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </nav>

      {/* ═══════════ COMMAND CENTER ═══════════ */}
      {tab === 'pulse' && (
        <div className={`tab-content enter-${tabDirection}`} key="pulse">

          {drivers.length > 0 && (
            <div className="mb-xl">
              <div className="section-label">Market Drivers</div>
              <div className="grid-auto">
                {(drivers || []).map((d, i) => (
                  <div key={i} className={`intel-card stagger-${i + 1}`} onMouseMove={handleTilt} onMouseLeave={handleTiltReset}>
                    <div className="driver-card">
                      <div className={`driver-direction ${d.direction}`}>
                        {d.direction === 'UP' ? '↑' : d.direction === 'DOWN' ? '↓' : '→'}
                      </div>
                      <div className="driver-info">
                        <div className="factor">{d.factor}</div>
                        <div className="explanation">{d.explanation}</div>
                        <div className="strength-bar">
                          <div className="strength-fill" style={{ width: `${d.strength * 10}%`, background: getStrengthColor(d.strength) }} />
                        </div>
                        {d.evidence?.length > 0 && (
                          <div className="evidence-tags">{d.evidence.map((e, j) => <span key={j} className="evidence-tag">{e}</span>)}</div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mb-xl">
            <div className="section-label">Tracked Commodities</div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
              {(profile?.commodities || []).map((c, i) => {
                const label = allCommodities.find(x => x.key === c)?.label || c;
                return (
                  <div key={`c-${i}`} style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(16,185,129,0.1)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '6px 12px', borderRadius: '20px', fontSize: '13px' }}>
                    {label}
                    <button style={{ background: 'none', border: 'none', color: 'inherit', marginLeft: '6px', cursor: 'pointer', padding: 0 }} onClick={() => handleRemoveCommodity(c)}>✕</button>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <select style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '6px' }} value={quickCommodity} onChange={e => setQuickCommodity(e.target.value)}>
                <option value="">Add Commodity...</option>
                {allCommodities.filter(c => !(profile?.commodities || []).includes(c.key)).map(c => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
              <button style={{ background: 'var(--accent)', color: 'black', border: 'none', padding: '0 15px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }} onClick={handleAddQuickCommodity}>Add</button>
            </div>
          </div>

          <div className="mb-xl">
            <div className="section-label">Tracked Regions</div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
              {(profile?.regions || []).map((r, i) => (
                <div key={`r-${i}`} style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(16,185,129,0.1)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '6px 12px', borderRadius: '20px', fontSize: '13px' }}>
                  {r}
                  <button style={{ background: 'none', border: 'none', color: 'inherit', marginLeft: '6px', cursor: 'pointer', padding: 0 }} onClick={() => handleRemoveRegion(r, false)}>✕</button>
                </div>
              ))}
              {(profile?.custom_regions || []).map((r, i) => (
                <div key={`cr-${i}`} style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(16,185,129,0.1)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '6px 12px', borderRadius: '20px', fontSize: '13px' }}>
                  ★ {r.name}
                  <button style={{ background: 'none', border: 'none', color: 'inherit', marginLeft: '6px', cursor: 'pointer', padding: 0 }} onClick={() => handleRemoveRegion(r.name, true)}>✕</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input list="quick-region-suggestions" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', color: 'white', padding: '8px', borderRadius: '6px', width: '250px' }} value={quickRegionName} onChange={e => setQuickRegionName(e.target.value)} placeholder="New City/Region Name (e.g. Omaha, NE)" />
              <datalist id="quick-region-suggestions">
                <option value="Omaha, NE" />
                <option value="Des Moines, IA" />
                <option value="Fresno, CA" />
                <option value="Mato Grosso, Brazil" />
                <option value="Rosario, Argentina" />
                <option value="Perth, Australia" />
                <option value="Saskatchewan, Canada" />
                <option value="Kyiv, Ukraine" />
                <option value="Krasnodar, Russia" />
                <option value="Shandong, China" />
                <option value="Punjab, India" />
                <option value="Paris Basin, France" />
              </datalist>
              <button style={{ background: 'var(--accent)', color: 'black', border: 'none', padding: '0 15px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }} onClick={handleAddQuickRegion} disabled={quickAdding}>{quickAdding ? '...' : 'Add'}</button>
            </div>
          </div>

          <div className="mb-xl">
            <div className="section-label">News Pipeline Configuration</div>
            <div className="intel-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>Extra Tracked Keywords (Comma Separated)</label>
                <input 
                  type="text" 
                  value={pipelineKeywords}
                  onChange={e => setPipelineKeywords(e.target.value)}
                  placeholder="e.g. frozen food, port congestion..."
                  style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', padding: '8px 12px', borderRadius: '6px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>Blocklisted Sources/Keywords (Comma Separated)</label>
                <input 
                  type="text" 
                  value={pipelineBlocklist}
                  onChange={e => setPipelineBlocklist(e.target.value)}
                  placeholder="e.g. recipe, movie, celebrity, health tip..."
                  style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', padding: '8px 12px', borderRadius: '6px' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button 
                  onClick={handleSavePipelineConfig}
                  style={{ background: 'var(--accent-emerald)', color: '#000', border: 'none', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                >
                  Save & Re-scan
                </button>
              </div>
            </div>
          </div>

          {chains.length > 0 && (
            <div className="mb-xl">
              <div className="section-label">Cause → Effect Chains</div>
              {(chains || []).map((c, i) => (
                <div key={i} className="intel-card mb-sm" style={{ animationDelay: `${i * 0.1}s` }}>
                  <div className="chain-container animate">
                    {(c.chain || []).map((node, j) => (
                      <Fragment key={j}>
                        {j > 0 && <div className="chain-arrow">→</div>}
                        <div className="chain-node">{node}</div>
                      </Fragment>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}



        </div>
      )}



      {/* ═══════════ ALERTS ═══════════ */}
      {tab === 'alerts' && (
        <div className={`tab-content enter-${tabDirection}`} key="alerts">
          <div className="section-label">Risk Alerts ({alerts.length})</div>
          {alerts.length === 0 ? (
            <div className="intel-card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No active alerts</div>
          ) : (alerts || []).map((a, i) => (
            <div key={i} className={`alert-card ${a.severity}`} style={{ animationDelay: `${i * 0.08}s` }} onMouseMove={handleTilt} onMouseLeave={handleTiltReset}>
              <div className="alert-header">
                <div className="alert-title">
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                      {a.title} ↗
                    </a>
                  ) : (
                    a.title
                  )}
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <span className="alert-severity-badge" style={{ background: `var(--sev-${(a.severity || 'CRITICAL').toLowerCase()}-bg)`, color: `var(--sev-${(a.severity || 'CRITICAL').toLowerCase()}-text)` }}>{a.severity || 'CRITICAL'}</span>
                  {a.id && (
                    <button
                      onClick={() => acknowledgeAlert(a.id)}
                      title="Acknowledge — removes this alert from your active list"
                      style={{ background: 'transparent', border: '1px solid var(--text-muted)', color: 'var(--text-muted)', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }}
                    >✓ Ack</button>
                  )}
                </span>
              </div>
              {a.timestamp && <div style={{ fontSize: '10px', color: 'var(--accent-orange)', marginBottom: '8px', fontFamily: 'var(--font-mono)' }}>🕒 {a.timestamp}</div>}
              <div className="alert-reason">{a.reason || a.description}</div>
              {a.url && (
                <div style={{ marginTop: '8px' }}>
                  <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-cyan)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    Read Full Article <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  </a>
                </div>
              )}
              {a.entities && (
                <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {a.entities.organizations?.map((org, idx) => <span key={`org-${idx}`} style={{ fontSize: '10px', background: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa', padding: '2px 6px', borderRadius: '4px' }}>🏢 {org}</span>)}
                  {a.entities.places?.map((place, idx) => <span key={`place-${idx}`} style={{ fontSize: '10px', background: 'rgba(16, 185, 129, 0.2)', color: '#34d399', padding: '2px 6px', borderRadius: '4px' }}>📍 {place}</span>)}
                  {a.entities.values?.map((val, idx) => <span key={`val-${idx}`} style={{ fontSize: '10px', background: 'rgba(245, 158, 11, 0.2)', color: '#fbbf24', padding: '2px 6px', borderRadius: '4px' }}>💲 {val}</span>)}
                </div>
              )}
              {a.regions?.length > 0 && <div className="alert-regions">{(a.regions || []).map((r, j) => <span key={j} className="region-tag">{r}</span>)}</div>}
            </div>
          ))}

          <div className="mt-lg">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div className="section-label" style={{ margin: 0 }}>News Feed — {profile?.focus_product || 'Commodities'} / {profile?.focus_region || 'Global'}</div>
              <input 
                type="text" 
                placeholder="Filter news by keyword or source..." 
                value={newsFilter} 
                onChange={(e) => setNewsFilter(e.target.value)}
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', padding: '6px 12px', borderRadius: '6px', width: '300px', fontSize: '13px' }}
              />
            </div>
            {(() => {
              const filteredNews = (news || []).filter(a => {
                if (!newsFilter.trim()) return true;
                const q = newsFilter.toLowerCase();
                return (a.title?.toLowerCase().includes(q)) || 
                       (a.description?.toLowerCase().includes(q)) || 
                       (a.source?.toLowerCase().includes(q));
              });
              
              if (filteredNews.length === 0) {
                 return <div className="intel-card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>No news articles match your filter.</div>;
              }

              return filteredNews.map((a, i) => (
                <div key={i} className="intel-card mb-sm" style={{ animationDelay: `${i * 0.05}s` }} onMouseMove={handleTilt} onMouseLeave={handleTiltReset}>
                  <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: '13px', fontWeight: 500, color: 'var(--accent-cyan)', textDecoration: 'none' }}>{a.title}</a>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
                    {a.source} · {a.publishedAt} {a.via && <span style={{ color: 'var(--accent-violet)' }}>via {a.via}</span>}
                  </div>
                  {a.description && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.5 }}>{a.description}</div>}
                  {a.entities && (
                    <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {a.entities.organizations?.map((org, idx) => <span key={`org-${idx}`} style={{ fontSize: '10px', background: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa', padding: '2px 6px', borderRadius: '4px' }}>🏢 {org}</span>)}
                      {a.entities.places?.map((place, idx) => <span key={`place-${idx}`} style={{ fontSize: '10px', background: 'rgba(16, 185, 129, 0.2)', color: '#34d399', padding: '2px 6px', borderRadius: '4px' }}>📍 {place}</span>)}
                      {a.entities.values?.map((val, idx) => <span key={`val-${idx}`} style={{ fontSize: '10px', background: 'rgba(245, 158, 11, 0.2)', color: '#fbbf24', padding: '2px 6px', borderRadius: '4px' }}>💲 {val}</span>)}
                    </div>
                  )}
                </div>
              ));
            })()}
          </div>
        </div>
      )}



      {/* ═══════════ ACTIONS ═══════════ */}
      {tab === 'actions' && (
        <div className={`tab-content enter-${tabDirection}`} key="actions">
          


          {aiRecsLoading ? (
            <div className="section-label" style={{ color: 'var(--accent-emerald)', animation: 'pulse 1.5s infinite' }}>
              ✨ Generating personalized AI recommendations...
            </div>
          ) : aiRecommendationsError ? (
            <div className="intel-card" style={{ borderLeft: '3px solid var(--accent-amber)', color: 'var(--text-secondary)', marginBottom: '18px' }}>
              <strong style={{ color: '#fff', display: 'block', marginBottom: '6px' }}>AI recommendations unavailable</strong>
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
                <div className="mb-xl">
                  <div className="section-label">Planner Recommendations</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                    <div>
                      <h4 style={{ color: 'var(--text-secondary)', marginBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>Short Term (90 Days)</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {st.map((r, i) => renderRecCard(r, 'st-' + i))}
                        {st.length === 0 && (
                          <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic', fontSize: '12px' }}>No short-term recommendations available.</div>
                        )}
                      </div>
                    </div>
                    <div>
                      <h4 style={{ color: 'var(--text-secondary)', marginBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>Long Term (365 Days)</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {lt.map((r, i) => renderRecCard(r, 'lt-' + i))}
                        {lt.length === 0 && (
                          <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic', fontSize: '12px' }}>No long-term recommendations available.</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()
          )}

          {counterfactuals.length > 0 && (
            <div className="mb-xl">
              <div className="section-label">Counterfactual Analysis</div>
              <div className="grid-auto">{(counterfactuals || []).map((cf, i) => (<div key={i} className={`intel-card cf-card stagger-${i + 1}`} onMouseMove={handleTilt} onMouseLeave={handleTiltReset}><div className="cf-question">{cf.question}</div><div className="cf-answer">{cf.answer}</div></div>))}</div>
            </div>
          )}
          {missingData.length > 0 && (
            <div className="missing-data-strip mb-xl"><div className="label">⊘ Data Gaps</div><div className="missing-data-list">{(missingData || []).map((m, i) => <span key={i} className="missing-item">{m}</span>)}</div></div>
          )}
          <div className="section-label">Raw JSON</div>
          <button className="refresh-btn mb-md" onClick={() => setShowJson(!showJson)}>{showJson ? 'Hide' : 'Show'} Analysis JSON</button>
          {showJson && analysis && <div className="json-viewer">{JSON.stringify(analysis, null, 2)}</div>}
        </div>
      )}
      {/* ═══════════ S&OP PLANS ═══════════ */}
      {tab === 'sop' && (
        <div className={`tab-content enter-${tabDirection}`} key="sop">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
            <div className="section-label" style={{ margin: 0 }}>Sales & Operations Plans</div>
            <button className="btn-primary" onClick={() => setShowSopModal(true)} style={{ background: 'var(--accent-cyan)', color: '#000' }}>
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
                  
                  <div className="confidence-bar" style={{ marginBottom: '16px', background: 'rgba(255,255,255,0.05)' }}>
                    <div className="confidence-fill" style={{ width: `${progress}%`, background: progress >= 100 ? 'var(--accent-emerald)' : 'var(--accent-cyan)' }} />
                  </div>

                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '12px', display: 'flex', gap: '8px' }}>
                    <input 
                      type="number" 
                      placeholder="Actual" 
                      defaultValue={plan.actual_value}
                      id={`actual-${plan.id}`}
                      style={{ width: '80px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '4px', padding: '4px 8px', fontSize: '12px' }}
                    />
                    <button 
                      onClick={() => handleUpdateSopActual(plan.id, document.getElementById(`actual-${plan.id}`).value, plan.notes)}
                      style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', flex: 1 }}
                    >
                      Update
                    </button>
                  </div>
                </div>
              );
            })}
            {sopPlans.length === 0 && (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', gridColumn: '1 / -1' }}>
                No S&OP Plans tracked yet. Click "New Plan" to create one.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════ SOP MODAL ═══════════ */}
      {showSopModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', width: '500px', maxWidth: '90vw', padding: '24px', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', color: '#fff' }}>Create S&OP Target</h3>
              <button onClick={() => setShowSopModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>✕</button>
            </div>
            <form onSubmit={handleCreateSop}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Commodity</label>
                  <input required type="text" value={newSop.commodity} onChange={e => setNewSop({...newSop, commodity: e.target.value})} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '10px 12px', borderRadius: '6px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Region</label>
                  <input required type="text" value={newSop.region} onChange={e => setNewSop({...newSop, region: e.target.value})} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '10px 12px', borderRadius: '6px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Target Value (Vol/Amount)</label>
                  <input required type="number" value={newSop.target_value} onChange={e => setNewSop({...newSop, target_value: e.target.value})} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '10px 12px', borderRadius: '6px' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Plan Type</label>
                  <select value={newSop.plan_type} onChange={e => setNewSop({...newSop, plan_type: e.target.value})} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '10px 12px', borderRadius: '6px', appearance: 'none' }}>
                    <option value="procurement">Procurement</option>
                    <option value="inventory">Inventory Target</option>
                    <option value="production">Production Yield</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Period Start</label>
                  <input required type="date" value={newSop.period_start} onChange={e => setNewSop({...newSop, period_start: e.target.value})} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '10px 12px', borderRadius: '6px', colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>Period End</label>
                  <input required type="date" value={newSop.period_end} onChange={e => setNewSop({...newSop, period_end: e.target.value})} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '10px 12px', borderRadius: '6px', colorScheme: 'dark' }} />
                </div>
              </div>
              <button type="submit" style={{ width: '100%', background: 'var(--accent-cyan)', color: '#000', border: 'none', padding: '12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', marginTop: '8px' }}>
                Save Plan
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ═══════════ TRACK MODAL ═══════════ */}
      {showTrackModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', width: '500px', maxWidth: '90vw', padding: '24px', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '18px', color: '#fff' }}>Track New Commodity</h3>
              <button onClick={() => setShowTrackModal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '20px' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
              <input 
                type="text" 
                placeholder="Search Yahoo Finance (e.g. FBMPM.L, Lithium, ZC=F)..." 
                value={trackSearch}
                onChange={e => setTrackSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchTrack()}
                style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '10px 12px', borderRadius: '6px' }}
              />
              <button onClick={searchTrack} disabled={isTracking} style={{ background: 'var(--accent-cyan)', color: '#000', border: 'none', padding: '0 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>
                {isTracking ? '...' : 'Search'}
              </button>
            </div>
            
            <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
              {trackResults.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div>
                    <div style={{ fontWeight: 'bold', color: '#fff' }}>{r.symbol}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{r.shortname || r.longname} ({r.exchange})</div>
                  </div>
                  <button onClick={() => trackCommodity(r)} style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
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

    </div>
  );
}
