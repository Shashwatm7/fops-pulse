import React, { useState, useEffect } from 'react';

export default function AdminPage({ onBack }) {
  const [activeTab, setActiveTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tuning, setTuning] = useState(null);   // runtime tuning values
  const [tuningMeta, setTuningMeta] = useState(null); // bounds/labels per field
  const [tuningStatus, setTuningStatus] = useState('');
  const [previewUserId, setPreviewUserId] = useState('');
  const [seedPreview, setSeedPreview] = useState(null); // expanded-query preview
  const [previewLoading, setPreviewLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      if (activeTab === 'users') {
        const res = await fetch('/api/auth/admin/users', { credentials: 'include' });
        const data = await res.json();
        if (res.ok) setUsers(data.users);
        else setError(data.error || 'Failed to fetch users');
      } else if (activeTab === 'storage') {
        const res = await fetch('/api/auth/admin/db-stats', { credentials: 'include' });
        const data = await res.json();
        if (res.ok) setStats(data.layers);
        else setError(data.error || 'Failed to fetch storage stats');
      } else if (activeTab === 'tuning') {
        const res = await fetch('/api/admin/tuning', { credentials: 'include' });
        const data = await res.json();
        if (res.ok) { setTuning(data.values); setTuningMeta(data.meta); }
        else setError(data.error || 'Failed to fetch tuning');
        // Users list feeds the expanded-query preview picker.
        try {
          const ur = await fetch('/api/auth/admin/users', { credentials: 'include' });
          const ud = await ur.json();
          if (ur.ok) setUsers(ud.users);
        } catch { /* preview picker just stays empty */ }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this user?')) return;
    try {
      await fetch(`/api/auth/admin/users/${id}`, { method: 'DELETE', credentials: 'include' });
      fetchData();
    } catch (err) { console.error(err); }
  };

  const handleToggleAdmin = async (id, currentStatus) => {
    try {
      // Role changes live at /users/:id/role — the old bare /users/:id URL
      // matched no route, so the button silently no-opped.
      const res = await fetch(`/api/auth/admin/users/${id}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ is_admin: !currentStatus })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || `Role change failed (HTTP ${res.status})`);
      }
      fetchData();
    } catch (err) { console.error(err); alert(err.message); }
  };

  const loadSeedPreview = async (userId) => {
    setPreviewUserId(userId);
    setSeedPreview(null);
    if (!userId) return;
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/admin/tuning/seeds-preview/${userId}`, { credentials: 'include' });
      const data = await res.json();
      setSeedPreview(res.ok ? data : { error: data.error || 'Preview failed' });
    } catch (err) {
      setSeedPreview({ error: err.message });
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSaveTuning = async () => {
    setTuningStatus('Saving...');
    try {
      const res = await fetch('/api/admin/tuning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(tuning),
      });
      const data = await res.json();
      if (res.ok) {
        setTuning(data.values);
        setTuningStatus('Applied — takes effect on the next scan/analyze.');
        if (previewUserId) loadSeedPreview(previewUserId); // reflect new seeds/threshold
      }
      else setTuningStatus(data.error || 'Save failed');
    } catch (err) { setTuningStatus(err.message); }
  };

  return (
    <div style={styles.container}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={styles.title}>🛡️ Admin Dashboard</h2>
        <button onClick={onBack} style={styles.btnSecondary}>Back to Pulse</button>
      </div>

      <div style={styles.tabs}>
        <button 
          style={activeTab === 'users' ? styles.tabActive : styles.tab} 
          onClick={() => setActiveTab('users')}
        >👥 User Management</button>
        <button
          style={activeTab === 'storage' ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab('storage')}
        >🗄️ Storage Architecture</button>
        <button
          style={activeTab === 'tuning' ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab('tuning')}
        >🎛️ Fine-tuning</button>
      </div>

      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading {activeTab}...</div>}
      {error && <div style={{ color: 'var(--danger)' }}>Error: {error}</div>}

      {!loading && !error && activeTab === 'users' && (
        <div style={styles.card}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.thRow}>
                <th style={styles.th}>ID</th><th style={styles.th}>Username</th><th style={styles.th}>Email</th>
                <th style={styles.th}>Company</th><th style={styles.th}>Template / Focus</th><th style={styles.th}>Role</th><th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={styles.tr}>
                  <td style={styles.td}>{u.id}</td>
                  <td style={styles.td}><strong>{u.username}</strong></td>
                  <td style={styles.td}>{u.email}</td>
                  <td style={styles.td}>{u.company_name || '—'}</td>
                  <td style={styles.td}>
                    <span style={styles.badge}>{u.template_name || 'None'}</span>
                    {u.focus_product && <div style={{fontSize:'12px', color:'var(--text-dim)', marginTop:'4px'}}>{u.focus_product} / {u.focus_region}</div>}
                  </td>
                  <td style={styles.td}>
                    {u.is_admin ? <span style={{...styles.badge, background: 'rgba(139, 92, 246, 0.2)', color: '#c4b5fd', borderColor: 'rgba(139, 92, 246, 0.5)'}}>Admin</span> : <span style={styles.badge}>User</span>}
                  </td>
                  <td style={styles.td}>
                    <div style={{display:'flex', gap:'10px'}}>
                      <button style={styles.actionBtn} onClick={() => handleToggleAdmin(u.id, u.is_admin)}>
                        {u.is_admin ? 'Revoke' : 'Make Admin'}
                      </button>
                      <button style={{...styles.actionBtn, color: 'var(--danger)', borderColor: 'var(--danger)'}} onClick={() => handleDelete(u.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td colSpan="7" style={{...styles.td, textAlign:'center'}}>No users found.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && activeTab === 'storage' && stats && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginTop: '20px' }}>
          
          {/* Layer 1 */}
          <div style={{ ...styles.card, padding: '24px', borderTop: '3px solid #3b82f6' }}>
            <div style={styles.layerTitle}>Layer 1: Core State</div>
            <div style={styles.layerDesc}>PostgreSQL — Primary relational store for user states, config, and alerts.</div>
            <div style={styles.statGrid}>
              <div style={styles.statBox}><div style={styles.statVal}>{stats.core.users}</div><div style={styles.statLabel}>Users</div></div>
              <div style={styles.statBox}><div style={styles.statVal}>{stats.core.sessions}</div><div style={styles.statLabel}>Active Sessions</div></div>
              <div style={styles.statBox}><div style={styles.statVal}>{stats.core.alerts}</div><div style={styles.statLabel}>Price Alerts</div></div>
            </div>
          </div>

          {/* Layer 2 */}
          <div style={{ ...styles.card, padding: '24px', borderTop: '3px solid #8b5cf6' }}>
            <div style={styles.layerTitle}>Layer 2: Semantic AI</div>
            <div style={styles.layerDesc}>pgvector — Mathematical 768-dimensional embeddings for Gemini-powered news similarity.</div>
            <div style={styles.statGrid}>
              <div style={styles.statBox}><div style={{...styles.statVal, color: '#c4b5fd'}}>{stats.vector.embeddings}</div><div style={styles.statLabel}>AI Embeddings</div></div>
            </div>
          </div>

          {/* Layer 3 */}
          <div style={{ ...styles.card, padding: '24px', borderTop: '3px solid #10b981' }}>
            <div style={styles.layerTitle}>Layer 3: Time-Series Engine</div>
            <div style={styles.layerDesc}>PostgreSQL BRIN Indexed — High-speed ingest for every market tick and weather snapshot.</div>
            <div style={styles.statGrid}>
              <div style={styles.statBox}><div style={{...styles.statVal, color: '#6ee7b7'}}>{stats.timeSeries.price_ticks.toLocaleString()}</div><div style={styles.statLabel}>Price Ticks</div></div>
              <div style={styles.statBox}><div style={{...styles.statVal, color: '#6ee7b7'}}>{stats.timeSeries.weather_snapshots.toLocaleString()}</div><div style={styles.statLabel}>Weather Snapshots</div></div>
            </div>
          </div>

          {/* Layer 4 */}
          <div style={{ ...styles.card, padding: '24px', borderTop: '3px solid #f59e0b' }}>
            <div style={styles.layerTitle}>Layer 4: Cold Storage</div>
            <div style={styles.layerDesc}>Local Filesystem — Permanent daily JSON archives of all raw API responses.</div>
            <div style={styles.statGrid}>
              <div style={styles.statBox}><div style={{...styles.statVal, color: '#fcd34d'}}>{stats.coldStorage.prices?.files || 0}</div><div style={styles.statLabel}>Price Archive Files</div></div>
              <div style={styles.statBox}><div style={{...styles.statVal, color: '#fcd34d'}}>{stats.coldStorage.weather?.files || 0}</div><div style={styles.statLabel}>Weather Archives</div></div>
              <div style={styles.statBox}><div style={{...styles.statVal, color: '#fcd34d'}}>{stats.coldStorage.news?.files || 0}</div><div style={styles.statLabel}>News Archives</div></div>
            </div>
          </div>

        </div>
      )}

      {!loading && !error && activeTab === 'tuning' && tuning && tuningMeta && (
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ ...styles.card, padding: '24px', maxWidth: '640px', flex: '1 1 480px' }}>
          <div style={styles.layerTitle}>Pipeline & LLM parameters</div>
          <div style={styles.layerDesc}>
            Runtime only — changes apply on the next scan/analyze and reset to defaults on restart.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', marginTop: '18px' }}>
            {Object.keys(tuningMeta).map(key => {
              const m = tuningMeta[key];
              if (m.type === 'list') {
                const items = Array.isArray(tuning[key]) ? tuning[key] : [];
                return (
                  <div key={key}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                      <label style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>{m.label}</label>
                      <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-dim)' }}>{items.length}/{m.maxItems}</span>
                    </div>
                    {m.note && <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>{m.note}</div>}
                    <textarea
                      value={items.join('\n')}
                      onChange={e => { setTuning({ ...tuning, [key]: e.target.value.split('\n') }); setTuningStatus(''); }}
                      rows={Math.min(8, Math.max(3, items.length + 1))}
                      placeholder="One seed sentence per line"
                      style={{ width: '100%', background: 'rgba(0,0,0,0.25)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '8px 10px', fontSize: '12px', fontFamily: 'var(--font-mono, monospace)', lineHeight: 1.5, resize: 'vertical' }}
                    />
                  </div>
                );
              }
              return (
                <div key={key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                    <label style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>{m.label}</label>
                    <span style={{ fontSize: '13px', fontFamily: 'var(--font-mono, monospace)', color: 'var(--accent-cyan, #67e8f9)' }}>
                      {Number(tuning[key]).toFixed(2)}
                      <span style={{ color: 'var(--text-dim)', marginLeft: '8px', fontSize: '11px' }}>default {Number(m.default).toFixed(2)}</span>
                    </span>
                  </div>
                  {m.note && <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '6px' }}>{m.note}</div>}
                  <input
                    type="range" min={m.min} max={m.max} step={m.step}
                    value={tuning[key]}
                    onChange={e => { setTuning({ ...tuning, [key]: Number(e.target.value) }); setTuningStatus(''); }}
                    style={{ width: '100%' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-dim)' }}>
                    <span>{m.min}</span><span>{m.max}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginTop: '22px' }}>
            <button style={styles.actionBtn} onClick={handleSaveTuning}>Apply</button>
            <button style={styles.actionBtn} onClick={() => {
              const reset = {}; Object.keys(tuningMeta).forEach(k => {
                const d = tuningMeta[k].default;
                reset[k] = Array.isArray(d) ? [...d] : d;
              });
              setTuning(reset); setTuningStatus('Reset to defaults (not yet applied — click Apply).');
            }}>Reset to defaults</button>
            {tuningStatus && <span style={{ fontSize: '12px', color: 'var(--accent-emerald, #10b981)' }}>{tuningStatus}</span>}
          </div>
        </div>

        {/* Expanded-query preview: exactly what the semantic gate compares against for a user */}
        <div style={{ ...styles.card, padding: '24px', maxWidth: '520px', flex: '1 1 380px' }}>
          <div style={styles.layerTitle}>Expanded query preview</div>
          <div style={styles.layerDesc}>
            The exact positive seed set + threshold the stage-6 semantic gate uses for a user
            (customer seeds merged, auto-seeds per commodity, plus your global extra seeds).
          </div>
          <select
            value={previewUserId}
            onChange={e => loadSeedPreview(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.25)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '8px 10px', fontSize: '13px', marginBottom: '14px' }}
          >
            <option value="">Select a user…</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.username} — {u.email}</option>)}
          </select>
          {previewLoading && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Building expanded query…</div>}
          {seedPreview?.error && <div style={{ color: 'var(--danger)', fontSize: '13px' }}>Error: {seedPreview.error}</div>}
          {seedPreview && !seedPreview.error && (
            <div style={{ fontSize: '12px' }}>
              <div style={{ marginBottom: '10px', fontFamily: 'var(--font-mono, monospace)', color: 'var(--accent-cyan, #67e8f9)' }}>
                gate threshold {Number(seedPreview.effectiveThreshold).toFixed(2)} · Rocchio γ {Number(seedPreview.rocchioGamma).toFixed(2)}
                {seedPreview.customerId && <span style={{ color: 'var(--text-dim)' }}> · customer: {seedPreview.customerId}</span>}
              </div>
              <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', margin: '10px 0 6px' }}>
                Positive seeds ({seedPreview.effectiveSeeds.length})
              </div>
              {seedPreview.effectiveSeeds.map((s, i) => (
                <div key={i} style={{ padding: '6px 8px', marginBottom: '4px', background: i >= seedPreview.profileSeeds.length ? 'rgba(139,92,246,0.08)' : 'rgba(0,0,0,0.2)', borderLeft: `2px solid ${i >= seedPreview.profileSeeds.length ? '#8b5cf6' : 'var(--border-color)'}`, borderRadius: '0 4px 4px 0', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                  {s}{i >= seedPreview.profileSeeds.length && <span style={{ color: '#c4b5fd', marginLeft: '6px', fontSize: '10px' }}>(global extra)</span>}
                </div>
              ))}
              <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', margin: '12px 0 6px' }}>
                Noise seeds ({seedPreview.noiseSeeds.length}) — penalized via Rocchio
              </div>
              {seedPreview.noiseSeeds.map((s, i) => (
                <div key={i} style={{ padding: '6px 8px', marginBottom: '4px', background: 'rgba(251,113,133,0.05)', borderLeft: '2px solid rgba(251,113,133,0.4)', borderRadius: '0 4px 4px 0', color: 'var(--text-dim)', lineHeight: 1.4 }}>{s}</div>
              ))}
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  container: { padding: '40px', maxWidth: '1200px', margin: '0 auto', color: 'var(--text-primary)' },
  title: { fontSize: '28px', margin: 0 },
  card: { background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-color)', borderRadius: '12px', overflow: 'hidden' },
  tabs: { display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' },
  tab: { background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', padding: '10px 15px', borderRadius: '6px', transition: '0.2s' },
  tabActive: { background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.3)', color: '#60a5fa', fontSize: '16px', cursor: 'pointer', padding: '10px 15px', borderRadius: '6px' },
  table: { width: '100%', borderCollapse: 'collapse', textAlign: 'left' },
  thRow: { borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)' },
  th: { padding: '16px', fontSize: '13px', textTransform: 'uppercase', color: 'var(--text-secondary)', letterSpacing: '0.05em' },
  tr: { borderBottom: '1px solid rgba(255,255,255,0.05)' },
  td: { padding: '16px', fontSize: '14px', verticalAlign: 'middle' },
  badge: { display: 'inline-block', padding: '4px 10px', background: 'rgba(16,185,129,0.1)', color: 'var(--accent)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold' },
  btnSecondary: { padding: '10px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer' },
  actionBtn: { padding: '6px 12px', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', fontSize: '12px' },
  layerTitle: { fontSize: '20px', fontWeight: 'bold', marginBottom: '6px' },
  layerDesc: { fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' },
  statGrid: { display: 'flex', gap: '20px', flexWrap: 'wrap' },
  statBox: { background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', minWidth: '120px', border: '1px solid rgba(255,255,255,0.05)' },
  statVal: { fontSize: '32px', fontWeight: 'bold', color: '#60a5fa', marginBottom: '4px', fontFamily: 'var(--font-mono)' },
  statLabel: { fontSize: '12px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }
};
