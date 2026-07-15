import React, { useState, useEffect } from 'react';
import TagInput from './TagInput.jsx';

export default function SettingsPage({ user, profile, onSave, onCancel }) {
  const [commodities, setCommodities] = useState(profile?.commodities || []);
  const [regions, setRegions] = useState(profile?.regions || []);
  const [focusRegion, setFocusRegion] = useState(profile?.focus_region || 'Global');
  const [focusProduct, setFocusProduct] = useState(profile?.focus_product || 'Commodities');
  const [newsKeywords, setNewsKeywords] = useState(profile?.news_keywords || []);
  const [blocklist, setBlocklist] = useState(profile?.custom_blocklist || []);
  const [customRegions, setCustomRegions] = useState(profile?.custom_regions || []);
  const [customRegionName, setCustomRegionName] = useState('');
  const [customRegionCrop, setCustomRegionCrop] = useState('');
  
  const [priceAlerts, setPriceAlerts] = useState(profile?.price_alerts || []);
  const [alertSymbol, setAlertSymbol] = useState('BRENT_CRUDE');
  const [alertType, setAlertType] = useState('above');
  const [alertThreshold, setAlertThreshold] = useState('');
  
  const [allCommodities, setAllCommodities] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState(profile?.customer_id || '');
  const [saving, setSaving] = useState(false);
  const [addingRegion, setAddingRegion] = useState(false);

  const commodityLabel = (key) =>
    allCommodities.find(c => c.key === key)?.label
    || String(key).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, m => m.toUpperCase());

  // Add immediately on selection — a separate "Add" step after picking from
  // the dropdown was repeatedly missed, so the commodity silently never
  // entered the tracked list.
  const addCommodity = (key) => {
    if (key && !commodities.includes(key)) setCommodities([...commodities, key]);
  };
  useEffect(() => {
    fetch('/api/auth/templates')
      .then(res => res.json())
      .then(data => {
        setAllCommodities(data.commodities);
        setCustomers(data.customers || []);
      });
  }, []);

  const handleAddCustomRegion = async () => {
    if (!customRegionName) return;
    setAddingRegion(true);
    try {
      const res = await fetch('/api/regions/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: customRegionName, crop: customRegionCrop })
      });
      const data = await res.json();
      if (data.success) {
        setCustomRegions(data.custom_regions);
        setCustomRegionName('');
        setCustomRegionCrop('');
      } else {
        alert(data.error || 'Failed to add region');
      }
    } catch(e) {
      console.error(e);
      alert('Network error');
    }
    setAddingRegion(false);
  };

  const handleAddAlert = () => {
    if (!alertThreshold || isNaN(alertThreshold)) return;
    setPriceAlerts([...priceAlerts, { symbol: alertSymbol, type: alertType, threshold: Number(alertThreshold), active: true }]);
    setAlertThreshold('');
  };

  const handleRemoveAlert = (idx) => {
    setPriceAlerts(priceAlerts.filter((_, i) => i !== idx));
  };

  const handleToggleAlert = (idx) => {
    const newAlerts = [...priceAlerts];
    newAlerts[idx].active = !newAlerts[idx].active;
    setPriceAlerts(newAlerts);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        commodities,
        regions,
        focus_region: focusRegion,
        focus_product: focusProduct,
        news_keywords: newsKeywords,
        custom_blocklist: blocklist,
        template_name: 'custom',
        custom_regions: customRegions,
        price_alerts: priceAlerts,
        customer_id: customerId || null,
      };

      const res = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        onSave(data.profile, data.rescan);
      }
    } catch(e) {
      console.error(e);
    }
    setSaving(false);
  };

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Account Settings</h2>
      <div className="intel-card" style={styles.card}>
        {customers.length > 0 && (
          <>
            <div className="section-label">Company Profile</div>
            <select className="form-select" style={{ width: '100%', marginBottom: '8px' }} value={customerId} onChange={e => setCustomerId(e.target.value)}>
              <option value="">None (independent profile)</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.company} — {c.region}</option>)}
            </select>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '24px' }}>
              Linking a company profile enriches your news scan and AI labeling with that company's ports, routes, commodities, and supplier countries. Save to apply.
            </div>
          </>
        )}
        <div className="section-label" style={styles.sectionTitle}>Tracked Commodities
          {commodities.length > 0 && <span style={styles.count}> · {commodities.length}</span>}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '12px' }}>
          All commodities have live futures price feeds.
        </div>
        <div style={styles.chipRow}>
          {commodities.length === 0 && <span style={styles.empty}>None selected yet.</span>}
          {commodities.map(key => (
            <span key={key} className="chip">
              {commodityLabel(key)}
              <button className="chip-remove" title="Remove" onClick={() => setCommodities(commodities.filter(x => x !== key))}>✕</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <select className="form-select" style={{ minWidth: '220px' }} value="" onChange={e => addCommodity(e.target.value)}>
            <option value="">+ Add commodity…</option>
            {allCommodities.filter(c => !commodities.includes(c.key)).map(c => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className="section-label" style={styles.sectionTitle}>Tracked Regions</div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 10px', maxWidth: '60ch', lineHeight: 1.5 }}>
          Used for <strong>news filtering</strong> — which regions' supply-chain news you see. These are geographic
          tags, not weather stations. For live temperature &amp; rainfall, add real locations in the
          Command Center's weather panel.
        </p>
        <div style={styles.chipRow}>
          {regions.length === 0 && customRegions.length === 0 && <span style={styles.empty}>None selected yet.</span>}
          {regions.map(name => (
            <span key={name} className="chip">
              {name}
              <button className="chip-remove" title="Remove" onClick={() => setRegions(regions.filter(x => x !== name))}>✕</button>
            </span>
          ))}
          {customRegions.map((r, i) => (
            <span key={`custom-${i}`} className="chip" title="Custom region">
              ★ {r.name}
              <button className="chip-remove" title="Remove" onClick={() => setCustomRegions(customRegions.filter((_, j) => j !== i))}>✕</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input list="region-suggestions" className="form-input" style={{ flex: 2 }} value={customRegionName} onChange={e=>setCustomRegionName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomRegion(); } }} placeholder="Add a region — any city, country, or area (e.g. Middle East, Punjab, Rotterdam)" />
          <datalist id="region-suggestions">
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
          <input className="form-input" style={{ flex: 1 }} value={customRegionCrop} onChange={e=>setCustomRegionCrop(e.target.value)} placeholder="Crop (optional)" />
          <button className="btn-secondary" onClick={handleAddCustomRegion} disabled={addingRegion}>{addingRegion ? 'Adding…' : 'Add Custom'}</button>
        </div>

        <div className="section-label" style={styles.sectionTitle}>Market Focus</div>
        <div style={{display:'flex', gap:'15px', marginBottom:'15px'}}>
          <div style={{ flex: 1 }}>
            <label className="form-label">Focus Region</label>
            <input className="form-input" style={{ width: '100%' }} value={focusRegion} onChange={e=>setFocusRegion(e.target.value)} placeholder="e.g. Middle East" />
          </div>
          <div style={{ flex: 1 }}>
            <label className="form-label">Focus Product</label>
            <input className="form-input" style={{ width: '100%' }} value={focusProduct} onChange={e=>setFocusProduct(e.target.value)} placeholder="e.g. Frozen Goods" />
          </div>
        </div>

        <div className="section-label" style={styles.sectionTitle}>News Pipeline Configuration</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <label className="form-label">Extra Tracked Keywords
              {newsKeywords.length > 0 && <span style={{ opacity: 0.6, textTransform: 'none', letterSpacing: 0 }}> · {newsKeywords.length}</span>}
            </label>
            <TagInput value={newsKeywords} onChange={setNewsKeywords} placeholder="Type a keyword, press Enter…" />
            <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--text-dim)' }}>Each keyword becomes an extra news search query for your pipeline.</div>
          </div>
          <div>
            <label className="form-label">Blocklisted Sources/Keywords
              {blocklist.length > 0 && <span style={{ opacity: 0.6, textTransform: 'none', letterSpacing: 0 }}> · {blocklist.length}</span>}
            </label>
            <TagInput value={blocklist} onChange={setBlocklist} placeholder="Type a term to block, press Enter…" tone="danger" />
            <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--text-dim)' }}>Articles containing these terms are rejected at the rules stage.</div>
          </div>
        </div>

        <div style={styles.btnRow}>
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-accent" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: { padding: '40px', maxWidth: '900px', margin: '0 auto', color: 'var(--text-primary)' },
  title: { fontSize: '24px', marginBottom: '20px' },
  card: { padding: '30px' },
  sectionTitle: { marginTop: '28px' },
  chipRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px', alignItems: 'center' },
  count: { opacity: 0.6, textTransform: 'none', letterSpacing: 0 },
  empty: { fontSize: '13px', color: 'var(--text-dim)' },
  btnRow: { display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '32px', paddingTop: '20px', borderTop: '1px solid var(--border-subtle)' }
};
