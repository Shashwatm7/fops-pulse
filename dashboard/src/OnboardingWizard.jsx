import React, { useState, useEffect } from 'react';
import { Settings, Rocket } from 'lucide-react';

export default function OnboardingWizard({ user, onComplete }) {
  const [step, setStep] = useState(1);
  const [templates, setTemplates] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [allCommodities, setAllCommodities] = useState([]);
  const [allRegions, setAllRegions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Profile State
  const [selectedTemplate, setSelectedTemplate] = useState('custom');
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [commodities, setCommodities] = useState([]);
  const [regions, setRegions] = useState([]);
  const [focusRegion, setFocusRegion] = useState('');
  const [focusProduct, setFocusProduct] = useState('');
  const [newsKeywords, setNewsKeywords] = useState('');

  useEffect(() => {
    fetch('/api/auth/templates')
      .then(res => res.json())
      .then(data => {
        setTemplates(data.templates);
        setCustomers(data.customers || []);
        setAllCommodities(data.commodities);
        setAllRegions(data.regions);
        setLoading(false);
      });
  }, []);

  const handleCustomerSelect = (customerId) => {
    setSelectedCustomer(customerId);
    setSelectedTemplate('custom'); // customer preset bypasses generic templates
    setStep(4); // straight to review — the backend derives the full profile
  };

  const handleTemplateSelect = async (templateId) => {
    setSelectedCustomer(null);
    setSelectedTemplate(templateId);

    // Fetch full template to pre-fill
    // (For this implementation, we just post the template_id later, but we want to show it in UI)
    if (templateId !== 'custom') {
      const tmpl = templates.find(t => t.id === templateId);
      // Pre-fill is handled automatically by backend if we pass template_id, 
      // but let's visually update it if we had the full data.
      // Since GET /api/auth/templates returns simplified data, we'll just skip to step 2 
      // and let the backend apply the template fully on save. 
      // However, to make the UI interactive, let's just go to step 4 Review directly for templates,
      // or Step 2 for custom.
      if (templateId === 'custom') {
        setStep(2);
      } else {
        // For preset template, skip directly to review
        setStep(4);
      }
    } else {
      setStep(2);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = selectedCustomer
        ? { customer_id: selectedCustomer }
        : selectedTemplate !== 'custom'
        ? { template_id: selectedTemplate }
        : {
            template_id: 'custom',
            commodities,
            regions,
            focus_region: focusRegion || 'Global',
            focus_product: focusProduct || 'Commodities',
            news_keywords: newsKeywords.split(',').map(k => k.trim()).filter(Boolean)
          };

      const res = await fetch('/api/auth/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        onComplete(data.profile);
      }
    } catch (e) {
      console.error(e);
    }
    setSaving(false);
  };

  if (loading) return <div style={{color:'#1a1d24', padding:'40px', textAlign:'center'}}>Loading Onboarding...</div>;

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h2 style={styles.title}>Welcome to FOPs Market Pulse, {user?.username}</h2>
        <p style={styles.subtitle}>Let's tailor your intelligence dashboard.</p>

        {/* Steps Indicator */}
        <div style={styles.stepContainer}>
          {[1,2,3,4].map(s => (
            <div key={s} style={{...styles.stepDot, ...(step >= s ? styles.stepDotActive : {})}}>
              {s}
            </div>
          ))}
        </div>

        {/* Step 1: Template */}
        {step === 1 && (
          <div>
            {customers.length > 0 && (
              <>
                <h3 style={styles.stepTitle}>Your Company</h3>
                <div style={styles.grid}>
                  {customers.map(c => (
                    <div key={c.id} style={{ ...styles.templateCard, borderColor: 'var(--accent, #16a34a)' }} onClick={() => handleCustomerSelect(c.id)}>
                      <div style={styles.templateIcon}>🏢</div>
                      <div style={styles.templateName}>{c.company}</div>
                      <div style={styles.templateDesc}>{c.region}{c.industry ? ` · ${c.industry.replace(/_/g, ' ')}` : ''}</div>
                    </div>
                  ))}
                </div>
                <p style={{ color: 'var(--text-dim)', fontSize: '13px', margin: '16px 0 30px' }}>Or pick a generic template instead:</p>
              </>
            )}
            <h3 style={styles.stepTitle}>Choose a Configuration Template</h3>
            <div style={styles.grid}>
              {templates.map(t => (
                <div key={t.id} style={styles.templateCard} onClick={() => handleTemplateSelect(t.id)}>
                  <div style={styles.templateIcon}>{t.icon}</div>
                  <div style={styles.templateName}>{t.name}</div>
                  <div style={styles.templateDesc}>{t.description}</div>
                </div>
              ))}
              <div style={styles.templateCard} onClick={() => handleTemplateSelect('custom')}>
                <div style={styles.templateIcon}><Settings size={32} color="var(--text-muted)" /></div>
                <div style={styles.templateName}>Custom Setup</div>
                <div style={styles.templateDesc}>Select individual commodities and regions.</div>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Custom Commodities */}
        {step === 2 && (
          <div>
            <h3 style={styles.stepTitle}>Select Commodities to Track</h3>
            <div style={styles.commodityGrid}>
              {allCommodities.map(c => (
                <label key={c.key} style={{...styles.checkboxCard, ...(commodities.includes(c.key) ? styles.checkboxCardActive : {})}}>
                  <input type="checkbox" checked={commodities.includes(c.key)} 
                    onChange={(e) => {
                      if (e.target.checked) setCommodities([...commodities, c.key]);
                      else setCommodities(commodities.filter(x => x !== c.key));
                    }} 
                    style={{display:'none'}}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
            <div style={styles.btnRow}>
              <button onClick={() => setStep(1)} style={styles.btnSecondary}>Back</button>
              <button onClick={() => setStep(3)} style={styles.btnPrimary}>Next</button>
            </div>
          </div>
        )}

        {/* Step 3: Custom Regions & Focus */}
        {step === 3 && (
          <div>
            <h3 style={styles.stepTitle}>Select Agricultural Regions & Focus</h3>
            <div style={styles.commodityGrid}>
              {allRegions.map(r => (
                <label key={r.name} style={{...styles.checkboxCard, ...(regions.includes(r.name) ? styles.checkboxCardActive : {})}}>
                  <input type="checkbox" checked={regions.includes(r.name)} 
                    onChange={(e) => {
                      if (e.target.checked) setRegions([...regions, r.name]);
                      else setRegions(regions.filter(x => x !== r.name));
                    }} 
                    style={{display:'none'}}
                  />
                  <span>{r.name}</span>
                </label>
              ))}
            </div>
            
            <div style={{marginTop:'20px'}}>
              <input style={styles.input} placeholder="Focus Region (e.g. Middle East)" value={focusRegion} onChange={e=>setFocusRegion(e.target.value)} />
              <input style={styles.input} placeholder="Focus Product (e.g. Frozen Goods)" value={focusProduct} onChange={e=>setFocusProduct(e.target.value)} />
              <input style={styles.input} placeholder="News Keywords (comma separated)" value={newsKeywords} onChange={e=>setNewsKeywords(e.target.value)} />
            </div>

            <div style={styles.btnRow}>
              <button onClick={() => setStep(2)} style={styles.btnSecondary}>Back</button>
              <button onClick={() => setStep(4)} style={styles.btnPrimary}>Review</button>
            </div>
          </div>
        )}

        {/* Step 4: Review */}
        {step === 4 && (
          <div>
            <h3 style={styles.stepTitle}>Ready to Launch</h3>
            <div style={styles.reviewBox}>
              <p><strong>Configuration:</strong> {selectedCustomer ? customers.find(c => c.id === selectedCustomer)?.company : selectedTemplate === 'custom' ? 'Custom Setup' : templates.find(t=>t.id===selectedTemplate)?.name}</p>
              {selectedCustomer && (
                <p style={{ color: 'var(--text-dim)' }}>Your dashboard will be pre-configured with this company's ports, routes, commodities, and supplier countries.</p>
              )}
              {!selectedCustomer && selectedTemplate === 'custom' && (
                <>
                  <p><strong>Commodities:</strong> {commodities.length} selected</p>
                  <p><strong>Regions:</strong> {regions.length} selected</p>
                  <p><strong>Focus:</strong> {focusProduct} in {focusRegion}</p>
                </>
              )}
              <p style={{marginTop:'15px', color:'var(--text-dim)'}}>Your dashboard will be instantly configured to track only these assets. You can change these settings anytime from the Settings menu.</p>
            </div>

            <div style={styles.btnRow}>
              <button onClick={() => setStep(selectedCustomer ? 1 : selectedTemplate==='custom' ? 3 : 1)} style={styles.btnSecondary}>Back</button>
              <button onClick={handleSave} style={{...styles.btnPrimary, display: 'flex', alignItems: 'center', gap: '8px'}} disabled={saving}>
                {saving ? 'Configuring...' : <>Launch Dashboard <Rocket size={16} /></>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    // NOT alignItems:'center'. A centred flex item taller than its container
    // overflows equally top and bottom, and the top overflow cannot be
    // scrolled to — the wizard's later steps are tall enough to hit this on a
    // laptop. flex-start plus margin:'auto' on the card centres it when it
    // fits and keeps the top edge reachable when it does not.
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '32px 16px',
    // Was a dark radial gradient (#111827 -> #0a0e17) while --text-primary is
    // #1a1d24, so the title, step headings and body text rendered near-black
    // on near-black: 1.14:1, against the 4.5:1 AA floor. The app's theme is
    // light; this screen never got migrated with it.
    background: 'var(--bg-deep)',
    color: 'var(--text-primary)',
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: '800px',
    margin: 'auto',
    background: 'var(--bg-card)',
    borderRadius: '16px',
    padding: '40px',
    border: '1px solid var(--border-color)',
    boxShadow: '0 25px 50px -12px rgba(20,24,40,0.10)',
  },
  title: { margin: '0 0 10px 0', fontSize: '28px', fontWeight: '600' },
  subtitle: { margin: '0 0 30px 0', color: 'var(--text-secondary)' },
  stepContainer: { display: 'flex', gap: '15px', marginBottom: '40px', justifyContent: 'center' },
  // --text-dim on --border-subtle was 2.03:1 — the step number was barely
  // visible on the dot it sits in. --text-secondary is 4.5:1 on the same fill.
  stepDot: { width: '32px', height: '32px', borderRadius: '50%', background: 'var(--border-subtle)', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:'bold', color:'var(--text-secondary)', transition:'all 0.3s' },
  // --accent is the navy brand colour, so the active dot needs light text.
  stepDotActive: { background: 'var(--accent)', color: '#ffffff', boxShadow: '0 0 15px var(--accent-glow)' },
  stepTitle: { fontSize: '20px', marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '20px' },
  templateCard: { padding: '20px', background: 'var(--bg-card)', borderRadius: '12px', border: '1px solid var(--border-color)', cursor: 'pointer', transition: 'all 0.2s' },
  templateIcon: { fontSize: '32px', marginBottom: '10px' },
  templateName: { fontSize: '16px', fontWeight: '600', marginBottom: '5px' },
  templateDesc: { fontSize: '13px', color: 'var(--text-dim)', lineHeight: '1.4' },
  commodityGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px' },
  checkboxCard: { padding: '12px 15px', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border-subtle)', cursor: 'pointer', fontSize: '14px', transition: 'all 0.2s', display: 'block', textAlign: 'center' },
  // The selected tint was emerald while --accent is navy, so a selected
  // commodity showed navy text on a green wash. Tint from the accent instead.
  checkboxCardActive: { border: '1px solid var(--accent)', background: 'var(--nav-active-bg)', color: 'var(--accent)' },
  input: { width: '100%', padding: '12px 15px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', marginBottom: '15px', fontSize: '15px' },
  btnRow: { display: 'flex', justifyContent: 'space-between', marginTop: '30px' },
  // background and color were both #1a1d24 — the same value — so "Next" and
  // "Complete Setup" rendered as an unlabelled dark rectangle. Matches
  // .btn-primary in index.css: dark fill, page-coloured text.
  btnPrimary: { padding: '12px 24px', background: 'var(--text-primary)', color: 'var(--bg-deep)', border: 'none', borderRadius: '8px', fontWeight: '600', cursor: 'pointer' },
  btnSecondary: { padding: '12px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', fontWeight: '600', cursor: 'pointer' },
  reviewBox: { padding: '20px', background: 'var(--bg-card)', borderRadius: '12px', border: '1px solid var(--border-color)' }
};
