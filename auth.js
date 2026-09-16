import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import {
  createUser, findUserByEmail, findUserById, findUserByUsername,
  getUserProfile, updateUserProfile, setOnboarded,
  getAllUsers, deleteUser, updateUserAdmin, getUserCount,
  listCustomerProfiles, setUserCustomer, getCustomerProfile, touchSettingsChanged,
  findUserByEntraIdentity, linkEntraIdentity, createSsoUser,
} from './db.js';
import { ENTRA_ENABLED, LOGIN_SCOPES, getMsalClient, extractIdentity, isBootstrapAdmin, authorizeIdentity, allowlistConfigured, emailDomainsConfigured, IS_EXTERNAL_ID } from './entra.js';
import { getTemplateById, getAllTemplates, SELECTABLE_COMMODITIES, ALL_REGIONS, TEMPLATES } from './onboarding-templates.js';

const router = Router();

// Hide email/password sign-in entirely and make Microsoft SSO the only way in.
// Guarded on ENTRA_ENABLED: if SSO is not actually configured this is ignored,
// because honouring it then would lock every user out of the application with
// no way back in.
const PASSWORD_LOGIN_ENABLED = !(process.env.DISABLE_PASSWORD_LOGIN === 'true' && ENTRA_ENABLED);
if (!PASSWORD_LOGIN_ENABLED) {
  console.log('[AUTH] Password login disabled — Microsoft SSO only.');
} else if (process.env.DISABLE_PASSWORD_LOGIN === 'true') {
  console.warn('[AUTH] DISABLE_PASSWORD_LOGIN=true ignored: Entra SSO is not configured, so disabling passwords would lock everyone out.');
}


// ── API keys: machine access without a browser session ──────
// A session cookie is sameSite:lax, so a browser will NOT attach it to a
// cross-origin XHR — a frontend on localhost:3000 or another service calling
// this API gets 401 no matter who is logged in. An API key travels in a
// header, so it works from any origin, any tool, with no login step.
//
// API_KEYS is a comma-separated list, so a key can be rotated by adding the
// new one, moving consumers over, then dropping the old.
// API_KEY_USER_EMAIL names the existing user a key acts as: handlers read
// req.userProfile (tracked commodities, regions, keywords) and would return
// nothing useful without one.
const API_KEYS = (process.env.API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const API_KEY_USER_EMAIL = (process.env.API_KEY_USER_EMAIL || '').trim();

if (API_KEYS.length && !API_KEY_USER_EMAIL) {
  console.warn('[AUTH] API_KEYS set but API_KEY_USER_EMAIL is not — key auth is inert until it names a user.');
} else if (API_KEYS.length) {
  console.log(`[AUTH] API key auth enabled: ${API_KEYS.length} key(s), acting as ${API_KEY_USER_EMAIL}`);
}

/** Constant-time compare that does not leak length through early return. */
function keyMatches(presented) {
  const a = Buffer.from(presented);
  return API_KEYS.some((k) => {
    const b = Buffer.from(k);
    // timingSafeEqual throws on length mismatch, so hash both to a fixed width
    // first: this compares in constant time regardless of key length.
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
  });
}

/** Read a key from X-API-Key or Authorization: Bearer <key>. */
function presentedKey(req) {
  const header = req.get('x-api-key');
  if (header) return header.trim();
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
// ── Middleware: require authentication ──────────────────────
export async function requireAuth(req, res, next) {
  // ── API key lane (machine / cross-origin callers) ──────────
  // Checked BEFORE the session so a key works with no cookie at all. A key is
  // only consulted when one is actually presented, so browser sessions are
  // unaffected.
  const key = presentedKey(req);
  if (key) {
    if (!API_KEYS.length) {
      return res.status(401).json({ error: 'API key auth is not configured on this server' });
    }
    if (!keyMatches(key)) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    const user = API_KEY_USER_EMAIL ? await findUserByEmail(API_KEY_USER_EMAIL) : null;
    if (!user) {
      return res.status(503).json({ error: 'API key is valid but API_KEY_USER_EMAIL names no existing user' });
    }
    req.user = user;
    req.userProfile = await getUserProfile(user.id);
    // Marks the request as key-authenticated. requireAdmin refuses these: a
    // shared static key must not reach user management or tuning, even when the
    // user it acts as happens to be an admin.
    req.isApiKey = true;
    // Handlers that read req.session.userId (insights, audit) need it present;
    // the session itself is never persisted for a key request.
    if (!req.session) req.session = {};
    req.session.userId = user.id;
    return next();
  }

  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  // Attach user and profile to request for downstream routes
  const user = await findUserById(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: 'User not found' });
  }
  req.user = user;
  req.userProfile = await getUserProfile(user.id);
  next();
}

// ── Middleware: require admin role ───────────────────────────
export function requireAdmin(req, res, next) {
  // A shared static key must never reach user management or tuning, even when
  // the user it acts as is an admin: the key has no individual accountability.
  if (req.isApiKey) {
    return res.status(403).json({ error: 'Admin routes require an interactive session, not an API key' });
  }
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── POST /api/auth/signup ───────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    if (!PASSWORD_LOGIN_ENABLED) {
      return res.status(403).json({ error: 'Account creation is disabled. Use Sign in with Microsoft.' });
    }
    const { username, email, password, company_name } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    // Check for existing user
    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (await findUserByUsername(username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    // First user becomes admin automatically
    const userCount = await getUserCount();
    const is_admin = userCount === 0 ? 1 : 0;

    const userId = await createUser({ username, email, password_hash, company_name: company_name || '', is_admin });

    req.session.userId = userId;
    const user = await findUserById(userId);

    res.json({
      success: true,
      user: { id: user.id, username: user.username, email: user.email, company_name: user.company_name, is_admin: user.is_admin, is_onboarded: user.is_onboarded },
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// ── POST /api/auth/login ────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    // Enforced here, not just hidden in the UI — a hidden form is not a
    // disabled endpoint.
    if (!PASSWORD_LOGIN_ENABLED) {
      return res.status(403).json({ error: 'Password sign-in is disabled. Use Sign in with Microsoft.' });
    }
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // SSO-provisioned accounts have no password. Without this guard,
    // bcrypt.compare(password, null) throws a 500 instead of a clean 401, and
    // the error leaks which accounts are SSO-only.
    if (!user.password_hash) {
      return res.status(401).json({ error: 'This account uses Microsoft sign-in' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.userId = user.id;
    const profile = await getUserProfile(user.id);

    res.json({
      success: true,
      user: { id: user.id, username: user.username, email: user.email, company_name: user.company_name, is_admin: user.is_admin, is_onboarded: user.is_onboarded },
      profile,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/logout ───────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── GET /api/auth/me ────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  const profile = await getUserProfile(req.user.id);
  res.json({
    user: { id: req.user.id, username: req.user.username, email: req.user.email, company_name: req.user.company_name, is_admin: req.user.is_admin, is_onboarded: req.user.is_onboarded },
    profile,
  });
});

// ── POST /api/auth/onboard ──────────────────────────────────
router.post('/onboard', requireAuth, async (req, res) => {
  try {
    const { template_id, customer_id, commodities, regions, focus_region, focus_countries, focus_product, news_keywords, news_country_codes, currencies } = req.body;

    let profileData;
    let customer = null;
    if (customer_id) {
      customer = await getCustomerProfile(customer_id);
      if (!customer) return res.status(400).json({ error: 'Unknown customer profile' });
    }

    if (customer) {
      // Customer preset (e.g. Aramtec): derive an immediately-relevant
      // profile from the customer's own data rather than a generic template,
      // so the news feed matches this customer's supply chain from minute one
      // instead of waiting for the first scan to enrich it.
      profileData = {
        commodities: commodities || [],
        regions: regions || [...(customer.key_ports || []), ...(customer.supplier_countries || [])],
        focus_region: focus_region || customer.region || 'Middle East',
        focus_countries: focus_countries || (customer.supplier_countries || []),
        focus_product: focus_product || customer.industry || 'Food Service',
        news_keywords: news_keywords || [...new Set([...(customer.commodities || []), ...(customer.signal_keywords || [])])],
        news_country_codes: news_country_codes || 'ae,sa,eg,qa,kw',
        currencies: currencies || [],
        template_name: `customer:${customer.id}`,
      };
    } else if (template_id && TEMPLATES[template_id]) {
      // Use template as base, allow overrides
      const tmpl = TEMPLATES[template_id];
      profileData = {
        commodities: commodities || tmpl.commodities,
        regions: regions || tmpl.regions,
        focus_region: focus_region || tmpl.focus_region,
        focus_countries: focus_countries || tmpl.focus_countries,
        focus_product: focus_product || tmpl.focus_product,
        news_keywords: news_keywords || tmpl.news_keywords,
        news_country_codes: news_country_codes || tmpl.news_country_codes,
        currencies: currencies || tmpl.currencies,
        template_name: template_id,
      };
    } else {
      // Fully custom
      profileData = {
        commodities: commodities || [],
        regions: regions || [],
        focus_region: focus_region || 'Global',
        focus_countries: focus_countries || [],
        focus_product: focus_product || 'Food Commodities',
        news_keywords: news_keywords || [],
        news_country_codes: news_country_codes || '',
        currencies: currencies || [],
        template_name: 'custom',
      };
    }

    await updateUserProfile(req.user.id, profileData);
    if (customer_id) await setUserCustomer(req.user.id, customer_id);
    await setOnboarded(req.user.id);

    const updatedProfile = await getUserProfile(req.user.id);
    res.json({ success: true, profile: updatedProfile });
  } catch (err) {
    console.error('Onboard error:', err);
    res.status(500).json({ error: 'Onboarding failed' });
  }
});

// ── PUT /api/auth/profile ───────────────────────────────────
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { commodities, regions, focus_region, focus_countries, focus_product, news_keywords, news_country_codes, currencies, template_name, custom_regions, price_alerts, custom_blocklist: req_blocklist, customer_id } = req.body;
    const current = await getUserProfile(req.user.id);

    if (customer_id !== undefined) {
      if (customer_id) {
        const c = await getCustomerProfile(customer_id);
        if (!c) return res.status(400).json({ error: 'Unknown customer profile' });
      }
      await setUserCustomer(req.user.id, customer_id || null); // '' or null detaches
    }

    // Automatically generate smart news keywords based on the focus product
    const product = focus_product ?? current.focus_product ?? 'Commodities';
    const prodLower = product.toLowerCase();
    let autoKeywords = [];
    
    if (prodLower.includes('crude') || prodLower.includes('oil') || prodLower.includes('brent')) {
        autoKeywords = ['brent crude', 'oil prices', 'energy markets', 'maritime freight costs', 'port congestion'];
    } else if (prodLower.includes('frozen') || prodLower.includes('cold')) {
        autoKeywords = ['cold chain logistics', 'frozen goods', 'reefer freight rates', 'food supply chain', 'port buffer'];
    } else if (prodLower.includes('poultry') || prodLower.includes('chicken')) {
        autoKeywords = ['poultry supply', 'avian flu', 'chicken prices', 'livestock logistics'];
    } else if (prodLower.includes('dairy') || prodLower.includes('milk')) {
        autoKeywords = ['dairy supply chain', 'milk prices', 'cattle feed', 'livestock logistics'];
    } else {
        autoKeywords = [product, `${product} logistics`, `${product} supply chain`, 'freight costs', 'port buffer'];
    }
    
    // If the user explicitly provides keywords, use them (allowing them to fix/override). Otherwise merge auto with current.
    let finalKeywords;
    if (news_keywords !== undefined) {
        finalKeywords = news_keywords;
    } else {
        const manualKeywords = current.news_keywords || [];
        finalKeywords = [...new Set([...autoKeywords, ...manualKeywords])];
    }

    let custom_dictionary = current.custom_dictionary || [];
    let custom_blocklist;
    if (req_blocklist !== undefined) {
        custom_blocklist = req_blocklist;
    } else {
        custom_blocklist = current.custom_blocklist || [];
        // Generate static lists if the product changed or lists are empty. LLM generation is disabled
        if (product !== current.focus_product || custom_blocklist.length === 0 || custom_dictionary.length === 0) {
           custom_blocklist = [
             'recipe', 'cooking', 'diet', 'health tip', 'nutrition advice', 'weight loss',
             'celebrity', 'movie', 'tv show', 'award', 'cannes', 'oreo', 'birthday',
             'celebration', 'holiday', 'festival', 'baby shower', 'breastfeeding',
             'lactose intolerant', 'therapy', 'dunkin', 'dairy queen', 'starbucks',
             'mcdonald', 'burger king', 'baskin robbins', 'ben & jerry', 'haagen-dazs',
             'cold stone', 'kitten', 'puppy', 'pet food', 'rescue animal'
           ];
           custom_dictionary = [
             'production', 'export', 'import', 'tariff', 'shortage', 'processing',
             'wholesale', 'procurement', 'futures', 'tonnage', 'inventory', 'shipment',
             'supplier', 'logistics', 'freight', 'port', 'harvest', 'yield', 'capacity',
             'demand', 'supply', 'price', 'contract', 'warehouse', 'coldchain'
           ];
           console.log(`[AUTH] Applied static blocklist & dictionary for ${product}`);
        }
    }

    await updateUserProfile(req.user.id, {
      commodities: commodities || current.commodities,
      regions: regions || current.regions,
      focus_region: focus_region ?? current.focus_region,
      focus_countries: focus_countries || current.focus_countries,
      focus_product: product,
      news_keywords: finalKeywords,
      news_country_codes: news_country_codes ?? current.news_country_codes,
      currencies: currencies || current.currencies,
      template_name: template_name || current.template_name,
      custom_regions: custom_regions || current.custom_regions || [],
      price_alerts: price_alerts || current.price_alerts || [],
      custom_blocklist,
      custom_dictionary
    });

    const updatedProfile = await getUserProfile(req.user.id);

    // Did the user materially change WHAT they track (not just currency or a
    // keyword tweak)? Only then do we hide old alerts/labels and rescan —
    // a currency-only save shouldn't wipe the alert feed.
    const norm = (v) => JSON.stringify(Array.isArray(v) ? [...v].sort() : (v ?? null));
    const materialChange =
        norm(current.commodities) !== norm(updatedProfile.commodities) ||
        norm(current.regions) !== norm(updatedProfile.regions) ||
        norm(current.focus_region) !== norm(updatedProfile.focus_region) ||
        norm(current.focus_product) !== norm(updatedProfile.focus_product) ||
        norm(current.customer_id) !== norm(updatedProfile.customer_id);

    let rescan = false;
    if (materialChange) {
        // Stamp the cutoff: old alerts + labeled insights drop out of view
        // immediately (kept in the DB), then a fresh scan repopulates.
        await touchSettingsChanged(req.user.id);
        if (global.clearUserAlertsCache) global.clearUserAlertsCache(req.user.id);
        // Tracked scan so the frontend can poll /api/scan-status and refetch
        // once the new-profile results land.
        if (global.startUserScanTracked) { global.startUserScanTracked(req.user.id); rescan = true; }
        else if (global.triggerUserScan) { global.triggerUserScan(req.user.id); rescan = true; }
    }

    res.json({ success: true, profile: updatedProfile, rescan });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Profile update failed' });
  }
});

// ── Microsoft Entra ID SSO ──────────────────────────────────
// GET  /api/auth/entra/login    -> redirect the browser to Microsoft
// GET  /api/auth/entra/callback -> exchange the code, provision, set session
//
// Sessions are unchanged: this only changes HOW req.session.userId is
// established, so requireAuth and every downstream route keep working as-is.

router.get('/entra/status', (req, res) => {
  // Surface whether an access gate is actually armed, so a misconfiguration is
  // visible before someone discovers it by being locked out (or let in).
  const gateArmed = IS_EXTERNAL_ID ? emailDomainsConfigured() : allowlistConfigured();
  res.json({
    enabled: ENTRA_ENABLED,
    passwordLoginEnabled: PASSWORD_LOGIN_ENABLED,
    mode: IS_EXTERNAL_ID ? 'external-id' : 'workforce-multitenant',
    accessGateConfigured: gateArmed,
    tenantAllowlistConfigured: allowlistConfigured(),
    emailDomainAllowlistConfigured: emailDomainsConfigured(),
  });
});

router.get('/entra/login', async (req, res) => {
  if (!ENTRA_ENABLED) {
    return res.status(503).json({ error: 'Microsoft sign-in is not configured on this server' });
  }
  try {
    // CSRF defence: a random state we store server-side in the session and
    // require back on the callback. Without it, an attacker can feed the user a
    // crafted callback URL and log them into an account of the attacker's choice.
    const state = crypto.randomUUID();
    req.session.entraState = state;

    const url = await getMsalClient().getAuthCodeUrl({
      scopes: LOGIN_SCOPES,
      redirectUri: process.env.ENTRA_REDIRECT_URI,
      state,
      prompt: 'select_account',
    });
    res.redirect(url);
  } catch (err) {
    console.error('[ENTRA] failed to build auth URL:', err.message);
    res.status(500).json({ error: 'Could not start Microsoft sign-in' });
  }
});

router.get('/entra/callback', async (req, res) => {
  const failRedirect = (reason) => {
    console.warn(`[ENTRA] sign-in rejected: ${reason}`);
    res.redirect(`/?authError=${encodeURIComponent(reason)}`);
  };

  if (!ENTRA_ENABLED) return failRedirect('Microsoft sign-in is not configured');

  try {
    if (req.query.error) {
      return failRedirect(String(req.query.error_description || req.query.error).slice(0, 200));
    }
    const expectedState = req.session.entraState;
    delete req.session.entraState;
    if (!req.query.state || req.query.state !== expectedState) {
      return failRedirect('State mismatch — please start sign-in again');
    }
    if (!req.query.code) return failRedirect('No authorization code returned');

    const result = await getMsalClient().acquireTokenByCode({
      code: String(req.query.code),
      scopes: LOGIN_SCOPES,
      redirectUri: process.env.ENTRA_REDIRECT_URI,
    });

    const { oid, tid, email, name, emailVerified } = extractIdentity(result);

    // THE gate. A valid token proves "a real Microsoft sign-in happened", NOT
    // "this person is our customer". Under External ID anyone who completes
    // sign-up gets one; under multitenant workforce any work account on earth
    // does. authorizeIdentity() applies whichever boundary actually holds for
    // the configured mode, and fails closed when nothing is configured.
    const decision = authorizeIdentity({ tid, email, emailVerified });
    if (!decision.ok) {
      // Log the specifics an operator needs to onboard someone, since a bare
      // "access denied" makes "we can't sign in" undiagnosable. Tenant ids and
      // email domains are not secrets.
      const fix = IS_EXTERNAL_ID ? 'ENTRA_ALLOWED_EMAIL_DOMAINS' : 'ENTRA_ALLOWED_TENANT_IDS';
      console.warn(`[ENTRA] rejected sign-in (${decision.reason}): ${decision.detail}. tenant=${tid} user=${email || 'unknown'}. To authorize, update ${fix}.`);
      return failRedirect(
        decision.reason === 'misconfigured'
          ? `Server misconfigured: ${decision.detail}`
          : 'Your account is not authorized for FOps Pulse'
      );
    }

    let user = await findUserByEntraIdentity(tid, oid);

    // Adopt a pre-existing local account with the same email so the user keeps
    // their profile, alerts and history rather than starting empty.
    if (!user && email) {
      const existing = await findUserByEmail(email);
      if (existing) {
        user = await linkEntraIdentity(existing.id, tid, oid);
        console.log(`[ENTRA] linked Microsoft identity to existing account ${existing.id}`);
      }
    }

    if (!user) {
      const base = (email ? email.split('@')[0] : name).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'user';
      let username = base;
      // usernames are UNIQUE; de-collide rather than 500 on the insert.
      for (let n = 1; await findUserByUsername(username); n++) username = `${base}${n}`;
      const asAdmin = isBootstrapAdmin(email);
      user = await createSsoUser({
        username,
        email: email || `${username}@${tid}.entra`,
        entra_tid: tid,
        entra_oid: oid,
        is_admin: asAdmin,
      });
      console.log(`[ENTRA] provisioned new user ${user.id} (${username}) from tenant ${tid}${asAdmin ? ' AS ADMIN (ENTRA_ADMIN_EMAILS)' : ''}`);
    }

    req.session.userId = user.id;
    // The SPA reads /api/auth/me on load, so land on the app root.
    res.redirect('/');
  } catch (err) {
    console.error('[ENTRA] callback failed:', err.message);
    failRedirect('Microsoft sign-in failed');
  }
});

// ── GET /api/auth/templates ─────────────────────────────────
router.get('/templates', async (req, res) => {
  let customers = [];
  try { customers = await listCustomerProfiles(); } catch (e) { console.error('listCustomerProfiles failed:', e.message); }
  res.json({ templates: getAllTemplates(), commodities: SELECTABLE_COMMODITIES, regions: ALL_REGIONS, customers });
});

// ── ADMIN: GET /api/auth/admin/db-stats ─────────────────────
router.get('/admin/db-stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getDatabaseStats } = await import('./db.js');
    const { getArchiveStats } = await import('./data-archive.js');
    
    const dbStats = await getDatabaseStats();
    const archiveStats = getArchiveStats();
    
    res.json({
      success: true,
      layers: {
        ...dbStats,
        coldStorage: archiveStats
      }
    });
  } catch (err) {
    console.error('Failed to get db stats:', err);
    res.status(500).json({ error: 'Failed to fetch database statistics' });
  }
});

// ── ADMIN: GET /api/auth/admin/users ────────────────────────
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const users = await getAllUsers();
  res.json({ users });
});

// ── ADMIN: POST /api/auth/admin/create-user ─────────────────
router.post('/admin/create-user', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, email, password, company_name, is_admin, template_id } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (await findUserByEmail(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (await findUserByUsername(username)) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const userId = await createUser({ username, email, password_hash, company_name: company_name || '', is_admin: is_admin ? 1 : 0 });

    // If a template was specified, apply it immediately and mark as onboarded
    if (template_id && TEMPLATES[template_id]) {
      const tmpl = TEMPLATES[template_id];
      await updateUserProfile(userId, {
        commodities: tmpl.commodities,
        regions: tmpl.regions,
        focus_region: tmpl.focus_region,
        focus_countries: tmpl.focus_countries,
        focus_product: tmpl.focus_product,
        news_keywords: tmpl.news_keywords,
        news_country_codes: tmpl.news_country_codes,
        currencies: tmpl.currencies,
        template_name: template_id,
      });
      await setOnboarded(userId);
    }

    res.json({ success: true, userId });
  } catch (err) {
    console.error('Admin create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── ADMIN: DELETE /api/auth/admin/users/:id ──────────────────
router.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  await deleteUser(targetId);
  res.json({ success: true });
});

// ── ADMIN: PUT /api/auth/admin/users/:id/profile ────────────
router.put('/admin/users/:id/profile', requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const target = await findUserById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const { commodities, regions, focus_region, focus_countries, focus_product, news_keywords, news_country_codes, currencies, template_name } = req.body;
    const current = await getUserProfile(targetId);

    await updateUserProfile(targetId, {
      commodities: commodities || current.commodities,
      regions: regions || current.regions,
      focus_region: focus_region ?? current.focus_region,
      focus_countries: focus_countries || current.focus_countries,
      focus_product: focus_product ?? current.focus_product,
      news_keywords: news_keywords || current.news_keywords,
      news_country_codes: news_country_codes ?? current.news_country_codes,
      currencies: currencies || current.currencies,
      template_name: template_name || current.template_name,
    });

    if (!target.is_onboarded) await setOnboarded(targetId);

    res.json({ success: true, profile: await getUserProfile(targetId) });
  } catch (err) {
    console.error('Admin profile update error:', err);
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});

// ── ADMIN: PUT /api/auth/admin/users/:id/role ───────────────
router.put('/admin/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }
  const { is_admin } = req.body;
  await updateUserAdmin(targetId, is_admin);
  res.json({ success: true });
});

export default router;
