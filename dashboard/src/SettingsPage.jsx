import React, { useState, useEffect } from 'react';

export default function SettingsPage({ user, profile, onSave, onCancel }) {
  const [commodities, setCommodities] = useState(profile?.commodities || []);
  const [regions, setRegions] = useState(profile?.regions || []);
  const [focusRegion, setFocusRegion] = useState(profile?.focus_region || 'Global');
  const [focusProduct, setFocusProduct] = useState(profile?.focus_product || 'Commodities');
  const [newsKeywords, setNewsKeywords] = useState((profile?.news_keywords || []).join(', '));
  const [customRegions, setCustomRegions] = useState(profile?.custom_regions || []);
  const [customRegionName, setCustomRegionName] = useState('');
  const [customRegionCrop, setCustomRegionCrop] = useState('');
  
  const [priceAlerts, setPriceAlerts] = useState(profile?.price_alerts || []);
  const [alertSymbol, setAlertSymbol] = useState('BRENT_CRUDE');
  const [alertType, setAlertType] = useState('above');
  const [alertThreshold, setAlertThreshold] = useState('');
  
  const [allCommodities, setAllCommodities] = useState([]);
  const [allRegions, setAllRegions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [addingRegion, setAddingRegion] = useState(false);

  useEffect(() => {
    fetch('/api/auth/templates')
      .then(res => res.json())
      .then(data => {
        setAllCommodities(data.commodities);
        setAllRegions(data.regions);
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
        news_keywords: newsKeywords.split(',').map(k => k.trim()).filter(Boolean),
        template_name: 'custom',
        custom_regions: customRegions,
        price_alerts: priceAlerts
      };

      const res = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        onSave(data.profile);
      }
    } catch(e) {
      console.error(e);
    }
    setSaving(false);
  };

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Account Settings</h2>
      <div style={styles.card}>
        <h3 style={styles.sectionTitle}>Tracked Commodities</h3>
        <div style={styles.grid}>
          {allCommodities.map(c => (
            <label key={c.key} style={{...styles.checkbox, ...(commodities.includes(c.key) ? styles.checkboxActive : {})}}>
              <input type="checkbox" style={{display:'none'}} checked={commodities.includes(c.key)}
                onChange={(e) => {
                  if (e.target.checked) setCommodities([...commodities, c.key]);
                  else setCommodities(commodities.filter(x => x !== c.key));
                }}
              />
              {c.label}
            </label>
          ))}
        </div>

        <h3 style={styles.sectionTitle}>Agricultural Regions</h3>
        <div style={styles.grid}>
          {allRegions.map(r => (
            <label key={r.name} style={{...styles.checkbox, ...(regions.includes(r.name) ? styles.checkboxActive : {})}}>
              <input type="checkbox" style={{display:'none'}} checked={regions.includes(r.name)}
                onChange={(e) => {
                  if (e.target.checked) setRegions([...regions, r.name]);
                  else setRegions(regions.filter(x => x !== r.name));
                }}
              />
              {r.name}
            </label>
          ))}
          {customRegions.map((r, i) => (
            <label key={`custom-${i}`} style={{...styles.checkbox, ...styles.checkboxActive, opacity: 0.8}}>
              ★ {r.name}
            </label>
          ))}
        </div>
        <div style={{display:'flex', gap:'10px', marginTop: '10px'}}>
          <input list="region-suggestions" style={styles.input} value={customRegionName} onChange={e=>setCustomRegionName(e.target.value)} placeholder="New City/Region Name (e.g. Omaha, NE)" />
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
          <input style={styles.input} value={customRegionCrop} onChange={e=>setCustomRegionCrop(e.target.value)} placeholder="Crop (Optional)" />
          <button style={styles.btnSecondary} onClick={handleAddCustomRegion} disabled={addingRegion}>{addingRegion ? 'Adding...' : 'Add Region'}</button>
        </div>
        <h3 style={styles.sectionTitle}>Market Focus</h3>
        <div style={{display:'flex', gap:'15px', marginBottom:'15px'}}>
          <input style={styles.input} value={focusRegion} onChange={e=>setFocusRegion(e.target.value)} placeholder="Focus Region" />
          <input style={styles.input} value={focusProduct} onChange={e=>setFocusProduct(e.target.value)} placeholder="Focus Product" />
        </div>
        

        <div style={styles.btnRow}>
          <button style={styles.btnSecondary} onClick={onCancel}>Cancel</button>
          <button style={styles.btnPrimary} onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: { padding: '40px', maxWidth: '900px', margin: '0 auto', color: 'var(--text-primary)' },
  title: { fontSize: '24px', marginBottom: '20px' },
  card: { background: 'rgba(15,23,42,0.6)', border: '1px solid var(--border-color)', borderRadius: '12px', padding: '30px' },
  sectionTitle: { fontSize: '18px', marginBottom: '15px', color: 'var(--accent)', marginTop: '20px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' },
  checkbox: { padding: '10px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer', textAlign: 'center', fontSize: '14px' },
  checkboxActive: { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'rgba(16,185,129,0.1)' },
  input: { width: '100%', padding: '12px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'white' },
  btnRow: { display: 'flex', justifyContent: 'flex-end', gap: '15px', marginTop: '30px' },
  btnPrimary: { padding: '10px 20px', background: 'var(--accent)', color: '#000', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer' },
  btnSecondary: { padding: '10px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', cursor: 'pointer' }
};
