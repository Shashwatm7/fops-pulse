import { useState, useCallback, useEffect, useRef } from 'react';

const API_BASE = '/api';

/* ═══════════════════════════════════════════════════════
   FOPs Market Pulse — Login / Sign Up Page
   Premium dark-themed authentication gateway
   ═══════════════════════════════════════════════════════ */

// ── Inline keyframes injected once ──
const STYLE_ID = '__fops-login-styles';
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const sheet = document.createElement('style');
  sheet.id = STYLE_ID;
  sheet.textContent = `
    @keyframes fopsLoginFadeIn {
      from { opacity: 0; transform: translateY(24px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes fopsLoginShake {
      0%, 100% { transform: translateX(0); }
      10%, 50%, 90% { transform: translateX(-6px); }
      30%, 70% { transform: translateX(6px); }
    }
    @keyframes fopsLoginPulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 6px #10b981, 0 0 12px rgba(16,185,129,0.4); }
      50%      { opacity: 0.45; box-shadow: 0 0 16px #10b981, 0 0 30px rgba(16,185,129,0.25); }
    }
    @keyframes fopsLoginSpin {
      to { transform: rotate(360deg); }
    }
    @keyframes fopsLoginGlow {
      0%   { background-position: 0% 50%; }
      50%  { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    @keyframes fopsFieldFadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes fopsParticleFloat {
      0%   { transform: translateY(0) translateX(0); opacity: 0; }
      10%  { opacity: 1; }
      90%  { opacity: 1; }
      100% { transform: translateY(-100vh) translateX(30px); opacity: 0; }
    }
    @keyframes fopsOrbDrift {
      0%   { transform: translate(0, 0) scale(1); }
      33%  { transform: translate(40px, -60px) scale(1.1); }
      66%  { transform: translate(-30px, 30px) scale(0.95); }
      100% { transform: translate(0, 0) scale(1); }
    }
    @keyframes fopsRingExpand {
      0%   { transform: scale(1); opacity: 0.5; }
      100% { transform: scale(3); opacity: 0; }
    }
  `;
  document.head.appendChild(sheet);
}

// ── Floating particle component ──
function Particles() {
  const count = 20;
  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            bottom: '-10px',
            left: `${(i / count) * 100}%`,
            width: `${Math.random() * 3 + 1}px`,
            height: `${Math.random() * 3 + 1}px`,
            borderRadius: '50%',
            background: i % 3 === 0
              ? 'rgba(16, 185, 129, 0.4)'
              : i % 3 === 1
                ? 'rgba(6, 182, 212, 0.3)'
                : 'rgba(139, 92, 246, 0.3)',
            animation: `fopsParticleFloat ${Math.random() * 15 + 10}s linear ${Math.random() * 10}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

// ── Input field component ──
function InputField({ label, type = 'text', value, onChange, placeholder, delay = 0, icon }) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        animation: `fopsFieldFadeIn 400ms ${delay}ms both cubic-bezier(0.16, 1, 0.3, 1)`,
      }}
    >
      <label
        style={{
          fontSize: '12px',
          fontWeight: 500,
          color: focused ? '#10b981' : '#94a3b8',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          transition: 'color 200ms ease',
        }}
      >
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        {icon && (
          <span
            style={{
              position: 'absolute',
              left: '14px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: focused ? '#10b981' : '#475569',
              transition: 'color 200ms ease',
              fontSize: '15px',
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {icon}
          </span>
        )}
        <input
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            width: '100%',
            padding: icon ? '12px 16px 12px 42px' : '12px 16px',
            background: focused ? 'rgba(15, 23, 42, 0.9)' : 'rgba(15, 23, 42, 0.6)',
            border: `1px solid ${focused ? 'rgba(16, 185, 129, 0.5)' : 'rgba(71, 85, 105, 0.4)'}`,
            borderRadius: '10px',
            color: '#e2e8f0',
            fontSize: '14px',
            fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
            outline: 'none',
            transition: 'all 250ms cubic-bezier(0.16, 1, 0.3, 1)',
            boxShadow: focused
              ? '0 0 0 3px rgba(16, 185, 129, 0.1), 0 0 20px rgba(16, 185, 129, 0.05)'
              : '0 2px 8px rgba(0, 0, 0, 0.15)',
          }}
        />
      </div>
    </div>
  );
}

// ── SVG Icons ──
const Icons = {
  mail: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M22 7l-10 7L2 7" />
    </svg>
  ),
  lock: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  ),
  user: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 10-16 0" />
    </svg>
  ),
  building: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M9 22v-4h6v4" />
      <path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" />
    </svg>
  ),
};


// ═══════════════════════════════════════════════════════
//  Main LoginPage Component
// ═══════════════════════════════════════════════════════

export default function LoginPage({ onLogin }) {
  const [mode, setMode] = useState('login');  // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [company, setCompany] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [mounted, setMounted] = useState(false);
  const cardRef = useRef(null);

  useEffect(() => {
    injectStyles();
    // Trigger mount animation
    requestAnimationFrame(() => setMounted(true));
    return () => {
      const el = document.getElementById(STYLE_ID);
      if (el) el.remove();
    };
  }, []);

  const triggerShake = useCallback(() => {
    setShaking(true);
    setTimeout(() => setShaking(false), 600);
  }, []);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const endpoint = mode === 'login' ? '/auth/login' : '/auth/signup';
    const body = mode === 'login'
      ? { email, password }
      : { username, email, password, company_name: company };

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        const msg = data.error || data.message || 'Authentication failed';
        setError(msg);
        triggerShake();
        setLoading(false);
        return;
      }

      // Success — call parent callback
      if (onLogin) {
        onLogin({ user: data.user, profile: data.profile || data.user });
      }
    } catch (err) {
      setError('Network error — could not reach server');
      triggerShake();
    } finally {
      setLoading(false);
    }
  }, [mode, email, password, username, company, onLogin, triggerShake]);

  const switchMode = useCallback(() => {
    setMode(prev => (prev === 'login' ? 'signup' : 'login'));
    setError('');
  }, []);

  const isSignup = mode === 'signup';

  // ── Styles ──
  const styles = {
    wrapper: {
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(145deg, #0a0e17 0%, #111827 50%, #0d1321 100%)',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      overflow: 'hidden',
      zIndex: 10000,
    },

    // Ambient orbs
    orb1: {
      position: 'absolute',
      width: '500px',
      height: '500px',
      borderRadius: '50%',
      background: 'radial-gradient(circle, rgba(16, 185, 129, 0.08) 0%, transparent 70%)',
      top: '-10%',
      right: '-5%',
      animation: 'fopsOrbDrift 18s ease-in-out infinite',
      pointerEvents: 'none',
    },
    orb2: {
      position: 'absolute',
      width: '400px',
      height: '400px',
      borderRadius: '50%',
      background: 'radial-gradient(circle, rgba(6, 182, 212, 0.06) 0%, transparent 70%)',
      bottom: '-10%',
      left: '-5%',
      animation: 'fopsOrbDrift 22s ease-in-out 3s infinite reverse',
      pointerEvents: 'none',
    },
    orb3: {
      position: 'absolute',
      width: '300px',
      height: '300px',
      borderRadius: '50%',
      background: 'radial-gradient(circle, rgba(139, 92, 246, 0.05) 0%, transparent 70%)',
      top: '50%',
      left: '10%',
      animation: 'fopsOrbDrift 15s ease-in-out 6s infinite',
      pointerEvents: 'none',
    },

    card: {
      position: 'relative',
      zIndex: 1,
      width: '100%',
      maxWidth: '420px',
      padding: '40px 36px 36px',
      background: 'rgba(15, 23, 42, 0.75)',
      backdropFilter: 'blur(24px) saturate(150%)',
      WebkitBackdropFilter: 'blur(24px) saturate(150%)',
      border: '1px solid rgba(71, 85, 105, 0.3)',
      borderRadius: '20px',
      boxShadow: `
        0 0 0 1px rgba(148, 163, 184, 0.05),
        0 8px 40px rgba(0, 0, 0, 0.5),
        0 0 80px rgba(16, 185, 129, 0.04)
      `,
      animation: mounted
        ? `fopsLoginFadeIn 700ms cubic-bezier(0.16, 1, 0.3, 1) both${shaking ? ', fopsLoginShake 0.5s ease' : ''}`
        : 'none',
      opacity: mounted ? 1 : 0,
      transition: 'box-shadow 400ms ease',
    },

    // Gradient border glow on top
    cardGlow: {
      position: 'absolute',
      top: '-1px',
      left: '20%',
      right: '20%',
      height: '2px',
      borderRadius: '2px',
      background: 'linear-gradient(90deg, transparent, #10b981, #06b6d4, #8b5cf6, transparent)',
      backgroundSize: '200% 100%',
      animation: 'fopsLoginGlow 4s ease infinite',
    },

    logo: {
      textAlign: 'center',
      marginBottom: '32px',
    },
    logoTitle: {
      fontSize: '24px',
      fontWeight: 700,
      color: '#f1f5f9',
      letterSpacing: '-0.02em',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
    },
    logoDot: {
      display: 'inline-block',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: '#10b981',
      animation: 'fopsLoginPulse 2s ease-in-out infinite',
      flexShrink: 0,
    },
    logoRing: {
      position: 'absolute',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      border: '1px solid #10b981',
      animation: 'fopsRingExpand 2s ease-out infinite',
    },
    logoSubtitle: {
      fontSize: '13px',
      color: '#64748b',
      marginTop: '6px',
      letterSpacing: '0.04em',
    },

    // Mode toggle
    toggleWrap: {
      display: 'flex',
      background: 'rgba(15, 23, 42, 0.7)',
      borderRadius: '12px',
      padding: '4px',
      marginBottom: '28px',
      border: '1px solid rgba(71, 85, 105, 0.25)',
      position: 'relative',
    },
    toggleBtn: (active) => ({
      flex: 1,
      padding: '10px 0',
      textAlign: 'center',
      fontSize: '13px',
      fontWeight: 600,
      color: active ? '#f1f5f9' : '#64748b',
      background: active ? 'rgba(16, 185, 129, 0.12)' : 'transparent',
      border: active ? '1px solid rgba(16, 185, 129, 0.25)' : '1px solid transparent',
      borderRadius: '9px',
      cursor: 'pointer',
      transition: 'all 300ms cubic-bezier(0.16, 1, 0.3, 1)',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      letterSpacing: '0.02em',
      position: 'relative',
      zIndex: 1,
    }),

    form: {
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
    },

    submitBtn: {
      position: 'relative',
      width: '100%',
      padding: '13px 24px',
      background: loading
        ? 'rgba(16, 185, 129, 0.2)'
        : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
      border: 'none',
      borderRadius: '12px',
      color: '#fff',
      fontSize: '14px',
      fontWeight: 600,
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      cursor: loading ? 'not-allowed' : 'pointer',
      transition: 'all 300ms cubic-bezier(0.16, 1, 0.3, 1)',
      boxShadow: loading
        ? 'none'
        : '0 4px 16px rgba(16, 185, 129, 0.3), 0 0 40px rgba(16, 185, 129, 0.1)',
      letterSpacing: '0.03em',
      overflow: 'hidden',
      marginTop: '6px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '10px',
    },
    submitBtnHoverOverlay: {
      position: 'absolute',
      inset: 0,
      borderRadius: '12px',
      background: 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, transparent 100%)',
      opacity: 0,
      transition: 'opacity 300ms ease',
      pointerEvents: 'none',
    },

    spinner: {
      width: '18px',
      height: '18px',
      border: '2px solid rgba(255,255,255,0.3)',
      borderTopColor: '#fff',
      borderRadius: '50%',
      animation: 'fopsLoginSpin 0.7s linear infinite',
    },

    errorBox: {
      background: 'rgba(239, 68, 68, 0.1)',
      border: '1px solid rgba(239, 68, 68, 0.3)',
      borderRadius: '10px',
      padding: '10px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      animation: 'fopsFieldFadeIn 300ms cubic-bezier(0.16, 1, 0.3, 1)',
    },
    errorDot: {
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: '#ef4444',
      flexShrink: 0,
    },
    errorText: {
      fontSize: '13px',
      color: '#fca5a5',
      lineHeight: 1.4,
    },

    footer: {
      textAlign: 'center',
      marginTop: '24px',
      fontSize: '13px',
      color: '#64748b',
    },
    footerLink: {
      color: '#10b981',
      cursor: 'pointer',
      fontWeight: 500,
      border: 'none',
      background: 'none',
      fontSize: '13px',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      textDecoration: 'none',
      transition: 'color 200ms ease',
      padding: 0,
    },

    // Decorative grid
    grid: {
      position: 'absolute',
      inset: 0,
      backgroundImage: `
        linear-gradient(rgba(71, 85, 105, 0.06) 1px, transparent 1px),
        linear-gradient(90deg, rgba(71, 85, 105, 0.06) 1px, transparent 1px)
      `,
      backgroundSize: '40px 40px',
      pointerEvents: 'none',
      zIndex: 0,
    },

    // Version badge
    version: {
      position: 'absolute',
      bottom: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      fontSize: '11px',
      color: '#334155',
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    },
  };

  return (
    <div style={styles.wrapper}>
      {/* Background layers */}
      <div style={styles.grid} />
      <Particles />
      <div style={styles.orb1} />
      <div style={styles.orb2} />
      <div style={styles.orb3} />

      {/* Main card */}
      <div
        ref={cardRef}
        style={styles.card}
        onMouseEnter={(e) => {
          e.currentTarget.style.boxShadow = `
            0 0 0 1px rgba(148, 163, 184, 0.08),
            0 12px 48px rgba(0, 0, 0, 0.6),
            0 0 100px rgba(16, 185, 129, 0.08)
          `;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = `
            0 0 0 1px rgba(148, 163, 184, 0.05),
            0 8px 40px rgba(0, 0, 0, 0.5),
            0 0 80px rgba(16, 185, 129, 0.04)
          `;
        }}
      >
        {/* Top gradient glow */}
        <div style={styles.cardGlow} />

        {/* Brand */}
        <div style={styles.logo}>
          <div style={styles.logoTitle}>
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={styles.logoDot} />
              <span style={styles.logoRing} />
            </span>
            FOPs Market Pulse
          </div>
          <div style={styles.logoSubtitle}>Supply Chain Intelligence Platform</div>
        </div>

        {/* Mode toggle */}
        <div style={styles.toggleWrap}>
          <button
            type="button"
            style={styles.toggleBtn(!isSignup)}
            onClick={() => { setMode('login'); setError(''); }}
          >
            Sign In
          </button>
          <button
            type="button"
            style={styles.toggleBtn(isSignup)}
            onClick={() => { setMode('signup'); setError(''); }}
          >
            Create Account
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={styles.form}>
          {/* Sign-up-only fields */}
          {isSignup && (
            <InputField
              key="username"
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Choose a username"
              delay={0}
              icon={Icons.user}
            />
          )}

          <InputField
            key="email"
            label="Email Address"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            delay={isSignup ? 60 : 0}
            icon={Icons.mail}
          />

          <InputField
            key="password"
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            delay={isSignup ? 120 : 60}
            icon={Icons.lock}
          />

          {isSignup && (
            <InputField
              key="company"
              label="Company Name"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Your organization"
              delay={180}
              icon={Icons.building}
            />
          )}

          {/* Error message */}
          {error && (
            <div style={styles.errorBox}>
              <span style={styles.errorDot} />
              <span style={styles.errorText}>{error}</span>
            </div>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={loading}
            style={styles.submitBtn}
            onMouseEnter={(e) => {
              if (!loading) {
                e.currentTarget.style.transform = 'translateY(-1px)';
                e.currentTarget.style.boxShadow =
                  '0 6px 24px rgba(16, 185, 129, 0.4), 0 0 60px rgba(16, 185, 129, 0.15)';
                const overlay = e.currentTarget.querySelector('[data-hover-overlay]');
                if (overlay) overlay.style.opacity = '1';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = loading
                ? 'none'
                : '0 4px 16px rgba(16, 185, 129, 0.3), 0 0 40px rgba(16, 185, 129, 0.1)';
              const overlay = e.currentTarget.querySelector('[data-hover-overlay]');
              if (overlay) overlay.style.opacity = '0';
            }}
          >
            <span data-hover-overlay style={styles.submitBtnHoverOverlay} />
            {loading && <span style={styles.spinner} />}
            {loading
              ? (isSignup ? 'Creating Account…' : 'Signing In…')
              : (isSignup ? 'Create Account' : 'Sign In')
            }
          </button>
        </form>

        {/* Footer toggle */}
        <div style={styles.footer}>
          {isSignup ? 'Already have an account? ' : "Don't have an account? "}
          <button
            type="button"
            style={styles.footerLink}
            onClick={switchMode}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#34d399'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#10b981'; }}
          >
            {isSignup ? 'Sign In' : 'Create one'}
          </button>
        </div>
      </div>

      {/* Version watermark */}
      <div style={styles.version}>v1.0 · secure</div>
    </div>
  );
}
