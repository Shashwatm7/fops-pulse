import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  createUser, findUserByEmail, findUserById, findUserByUsername,
  getUserProfile, updateUserProfile, setOnboarded,
  getAllUsers, deleteUser, updateUserAdmin, getUserCount,
} from './db.js';
import { getTemplateById, getAllTemplates, ALL_COMMODITIES, ALL_REGIONS, TEMPLATES } from './onboarding-templates.js';

const router = Router();

// ── Middleware: require authentication ──────────────────────
export async function requireAuth(req, res, next) {
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
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── POST /api/auth/signup ───────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
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
    const { template_id, commodities, regions, focus_region, focus_countries, focus_product, news_keywords, news_country_codes, currencies } = req.body;

    let profileData;

    if (template_id && TEMPLATES[template_id]) {
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
    const { commodities, regions, focus_region, focus_countries, focus_product, news_keywords, news_country_codes, currencies, template_name, custom_regions, price_alerts, custom_blocklist: req_blocklist } = req.body;
    const current = await getUserProfile(req.user.id);
    
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

    // Clear old alerts and trigger an immediate scan for the newly updated profile!
    if (global.clearUserAlertsCache) {
        global.clearUserAlertsCache(req.user.id);
    }
    if (global.triggerUserScan) {
        global.triggerUserScan(req.user.id);
    }

    res.json({ success: true, profile: updatedProfile });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Profile update failed' });
  }
});

// ── GET /api/auth/templates ─────────────────────────────────
router.get('/templates', (req, res) => {
  res.json({ templates: getAllTemplates(), commodities: ALL_COMMODITIES, regions: ALL_REGIONS });
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
