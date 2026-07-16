// ── db.js — Layer 4 Storage Architecture (PostgreSQL + pgvector) ──
import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
if (fs.existsSync('/etc/secrets/.env')) { dotenv.config({ path: '/etc/secrets/.env' }); } else { dotenv.config(); }

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5433/fops_pulse',
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// Test the connection on startup
pool.query('SELECT NOW()').then(() => {
  console.log('✅ PostgreSQL connected (Layer 4 Storage Architecture)');
}).catch(err => {
  console.error('❌ PostgreSQL connection failed:', err.message);
});

// ═══════════════════════════════════════════════════════════════
// PILLAR 4: S&OP / Core Operational Functions
// ═══════════════════════════════════════════════════════════════

export async function createUser({ username, email, password_hash, company_name = '', is_admin = 0 }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      `INSERT INTO users (username, email, password_hash, company_name, is_admin)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [username, email, password_hash, company_name, is_admin ? true : false]
    );
    const userId = userResult.rows[0].id;
    await client.query(
      `INSERT INTO user_profiles (user_id) VALUES ($1)`,
      [userId]
    );
    await client.query('COMMIT');
    return userId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  return rows[0] || undefined;
}

export async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || undefined;
}

export async function findUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return rows[0] || undefined;
}

export async function getUserProfile(userId) {
  const { rows } = await pool.query('SELECT * FROM user_profiles WHERE user_id = $1', [userId]);
  if (rows.length === 0) return null;
  const raw = rows[0];
  // PostgreSQL JSONB is automatically parsed by the pg driver, no manual JSON.parse needed
  return raw;
}

export async function updateUserProfile(userId, profile) {
  return pool.query(
    `UPDATE user_profiles SET
      commodities = $1,
      regions = $2,
      focus_region = $3,
      focus_countries = $4,
      focus_product = $5,
      news_keywords = $6,
      news_country_codes = $7,
      currencies = $8,
      template_name = $9,
      custom_regions = $10,
      price_alerts = $11,
      custom_blocklist = $12,
      custom_dictionary = $13,
      -- Preserve existing weather_regions when the caller doesn't supply them
      -- (Settings save, onboarding), so those flows never wipe the list.
      weather_regions = COALESCE($14::jsonb, weather_regions)
    WHERE user_id = $15`,
    [
      JSON.stringify(profile.commodities || []),
      JSON.stringify(profile.regions || []),
      profile.focus_region || 'Global',
      JSON.stringify(profile.focus_countries || []),
      profile.focus_product || 'Food Commodities',
      JSON.stringify(profile.news_keywords || []),
      profile.news_country_codes || '',
      JSON.stringify(profile.currencies || []),
      profile.template_name || 'custom',
      JSON.stringify(profile.custom_regions || []),
      JSON.stringify(profile.price_alerts || []),
      JSON.stringify(profile.custom_blocklist || []),
      JSON.stringify(profile.custom_dictionary || []),
      profile.weather_regions === undefined ? null : JSON.stringify(profile.weather_regions),
      userId,
    ]
  );
}

// Set ONLY the weather_regions list — used by the dedicated add/remove
// endpoints so managing weather regions never touches any other profile field.
export async function setWeatherRegions(userId, weatherRegions) {
  return pool.query(
    'UPDATE user_profiles SET weather_regions = $1 WHERE user_id = $2',
    [JSON.stringify(weatherRegions || []), userId]
  );
}

// Set ONLY the tracked_ports list — used by the dedicated port add/remove
// endpoints (Command Center port-congestion strip), mirroring setWeatherRegions.
export async function setTrackedPorts(userId, trackedPorts) {
  return pool.query(
    'UPDATE user_profiles SET tracked_ports = $1 WHERE user_id = $2',
    [JSON.stringify(trackedPorts || []), userId]
  );
}

// Persist the last profile-scan result (survives server restarts, unlike the
// in-memory global.scanState). Read back by /api/scan-status as a fallback.
export async function setLastScanResult(userId, stats) {
  return pool.query(
    'UPDATE user_profiles SET last_scan_result = $1, last_scan_at = NOW() WHERE user_id = $2',
    [JSON.stringify(stats || {}), userId]
  );
}

// Set ONLY the tracked_currencies list — used by the FX add/remove endpoints
// (Command Center FX Spot Rates strip), mirroring setTrackedPorts.
export async function setTrackedCurrencies(userId, codes) {
  return pool.query(
    'UPDATE user_profiles SET tracked_currencies = $1 WHERE user_id = $2',
    [JSON.stringify(codes || []), userId]
  );
}

export async function setOnboarded(userId) {
  return pool.query('UPDATE users SET is_onboarded = TRUE WHERE id = $1', [userId]);
}

export async function getAllUserPriceAlerts() {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.username, p.price_alerts
     FROM users u
     JOIN user_profiles p ON u.id = p.user_id
     WHERE p.price_alerts IS NOT NULL AND p.price_alerts::text != '[]'`
  );
  return rows;
}

export async function getAllUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.company_name, u.is_admin, u.is_onboarded, u.created_at,
            p.template_name, p.focus_region, p.focus_product
     FROM users u LEFT JOIN user_profiles p ON u.id = p.user_id
     ORDER BY u.created_at DESC`
  );
  return rows;
}

export async function deleteUser(userId) {
  return pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

export async function updateUserAdmin(userId, isAdmin) {
  return pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [isAdmin ? true : false, userId]);
}

export async function getUserCount() {
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM users');
  return parseInt(rows[0].count, 10);
}

// ═══════════════════════════════════════════════════════════════
// PILLAR 2: Structured Event DB (Time-Series)
// ═══════════════════════════════════════════════════════════════

export async function insertPriceTick(symbol, price, changePct = 0) {
  return pool.query(
    'INSERT INTO price_ticks (symbol, price, change_pct) VALUES ($1, $2, $3)',
    [symbol, price, changePct]
  );
}

export async function insertPriceTicksBatch(ticks) {
  if (!ticks || ticks.length === 0) return;
  const values = [];
  const params = [];
  ticks.forEach((t, i) => {
    const offset = i * 3;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
    params.push(t.symbol, t.price, t.changePct || 0);
  });
  return pool.query(
    `INSERT INTO price_ticks (symbol, price, change_pct) VALUES ${values.join(', ')}`,
    params
  );
}

export async function getPriceHistory(symbol, fromDate, toDate, limit = 1000) {
  const { rows } = await pool.query(
    `SELECT symbol, price, change_pct, recorded_at
     FROM price_ticks
     WHERE symbol = $1 AND recorded_at BETWEEN $2 AND $3
     ORDER BY recorded_at DESC
     LIMIT $4`,
    [symbol, fromDate, toDate, limit]
  );
  return rows;
}

export async function insertWeatherSnapshot(regionName, lat, lon, tempC, precipMm, humidity, windKph, condition) {
  return pool.query(
    `INSERT INTO weather_snapshots (region_name, lat, lon, temp_c, precip_mm, humidity, wind_kph, condition)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [regionName, lat, lon, tempC, precipMm, humidity, windKph, condition]
  );
}

export async function getWeatherHistory(regionName, fromDate, toDate, limit = 500) {
  const { rows } = await pool.query(
    `SELECT region_name, temp_c, precip_mm, humidity, wind_kph, condition, recorded_at
     FROM weather_snapshots
     WHERE region_name = $1 AND recorded_at BETWEEN $2 AND $3
     ORDER BY recorded_at DESC
     LIMIT $4`,
    [regionName, fromDate, toDate, limit]
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════
// PILLAR 3: Vector Database (Pinecone substitute via pgvector)
// ═══════════════════════════════════════════════════════════════

export async function insertNewsEmbedding(article, embedding) {
  return pool.query(
    `INSERT INTO news_embeddings (article_url, title, summary, source, published_at, embedding, region, commodity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (article_url) DO NOTHING`,
    [
      article.url,
      article.title,
      article.summary || article.description || '',
      article.source || '',
      article.publishedAt || new Date(),
      embedding ? `[${embedding.join(',')}]` : null,
      article.region || null,
      article.commodity || null,
    ]
  );
}

export async function getUnprocessedNews(limit = 5) {
  const { rows } = await pool.query(
    `SELECT id, article_url, title, summary, source, published_at
     FROM news_embeddings
     WHERE embedding IS NULL
     ORDER BY published_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function updateNewsEmbedding(articleUrl, embedding, region, commodity) {
  return pool.query(
    `UPDATE news_embeddings 
     SET embedding = $1::vector, region = $2, commodity = $3
     WHERE article_url = $4`,
    [
      `[${embedding.join(',')}]`, 
      region, 
      commodity, 
      articleUrl
    ]
  );
}

export async function searchSimilarNews(embedding, limit = 10) {
  if (!embedding) return [];
  const { rows } = await pool.query(
    `SELECT id, title, summary, source, article_url, published_at, region, commodity,
            1 - (embedding <=> $1::vector) AS similarity
     FROM news_embeddings
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [`[${embedding.join(',')}]`, limit]
  );
  return rows;
}

export async function getRecentNewsEmbeddings(limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, title, summary, source, article_url, published_at, region, commodity, created_at
     FROM news_embeddings
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════
// PILLAR 5: STORAGE ARCHITECTURE STATS (For Admin Dashboard)
// ═══════════════════════════════════════════════════════════════

export async function getDatabaseStats() {
  const client = await pool.connect();
  try {
    const usersCount = await client.query('SELECT COUNT(*) FROM users');
    const sessionsCount = await client.query('SELECT COUNT(*) FROM session');
    const priceAlertsCount = await client.query("SELECT COALESCE(SUM(jsonb_array_length(price_alerts)), 0) as count FROM user_profiles WHERE price_alerts IS NOT NULL AND price_alerts::text != 'null'");
    
    const embeddingsCount = await client.query('SELECT COUNT(*) FROM news_embeddings');
    
    const priceTicksCount = await client.query('SELECT COUNT(*) FROM price_ticks');
    const weatherSnapshotsCount = await client.query('SELECT COUNT(*) FROM weather_snapshots');

    return {
      core: {
        users: parseInt(usersCount.rows[0].count),
        sessions: parseInt(sessionsCount.rows[0].count),
        alerts: parseInt(priceAlertsCount.rows[0].count)
      },
      vector: {
        embeddings: parseInt(embeddingsCount.rows[0].count)
      },
      timeSeries: {
        price_ticks: parseInt(priceTicksCount.rows[0].count),
        weather_snapshots: parseInt(weatherSnapshotsCount.rows[0].count)
      }
    };
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════════
// PILLAR 4 (continued): S&OP Plans
// ═══════════════════════════════════════════════════════════════

export async function createSopPlan(userId, plan) {
  const { rows } = await pool.query(
    `INSERT INTO sop_plans (user_id, commodity, region, plan_type, target_value, actual_value, notes, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, plan.commodity, plan.region, plan.plan_type || 'procurement',
     plan.target_value, plan.actual_value || null, plan.notes || '', plan.period_start, plan.period_end]
  );
  return rows[0];
}

export async function getSopPlans(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM sop_plans WHERE user_id = $1 ORDER BY period_start DESC',
    [userId]
  );
  return rows;
}

export async function updateSopPlan(planId, updates) {
  return pool.query(
    `UPDATE sop_plans SET actual_value = $1, notes = $2, updated_at = NOW() WHERE id = $3`,
    [updates.actual_value, updates.notes || '', planId]
  );
}

// ═══════════════════════════════════════════════════════════════
// PILLAR 5: Human-in-the-Loop AI Feedback
// ═══════════════════════════════════════════════════════════════

export async function insertAiFeedback(userId, featureName, context, aiResponse, isHelpful, userNotes) {
  const { rows } = await pool.query(
    `INSERT INTO ai_feedback (user_id, feature_name, context, ai_response, is_helpful, user_notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, featureName, JSON.stringify(context), aiResponse, isHelpful, userNotes || '']
  );
  return rows[0].id;
}

export async function getRecentAiFeedback(userId, featureName = null, limit = 5) {
  let query = 'SELECT * FROM ai_feedback WHERE user_id = $1';
  const params = [userId];
  
  if (featureName) {
    query += ' AND feature_name = $2';
    params.push(featureName);
  }
  
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows } = await pool.query(query, params);
  return rows;
}
// ═══════════════════════════════════════════════════════════════
// PILLAR 6: Pipeline Analytics
// ═══════════════════════════════════════════════════════════════

export async function insertPipelineAuditLog(userId, article, stageDropped, rejectionReason, score, isAccepted) {
  // Parse the article's publish date (RSS pubDate string / ISO) to a real
  // timestamp; NULL when absent or unparseable so it never breaks the insert.
  let publishedAt = null;
  if (article.publishedAt) {
    const d = new Date(article.publishedAt);
    if (!isNaN(d.getTime())) publishedAt = d;
  }
  const sql =
    `INSERT INTO pipeline_audit_logs (user_id, article_title, article_url, source, stage_dropped, rejection_reason, relevance_score, is_accepted, extracted_features, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`;
  const params = [
    userId,
    article.title || 'Unknown Title',
    article.url || '',
    article.source || '',
    stageDropped,
    rejectionReason,
    score != null ? score : null,
    isAccepted,
    article.extracted_features ? JSON.stringify(article.extracted_features) : null,
    publishedAt
  ];
  try {
    const { rows } = await pool.query(sql, params);
    return rows[0]?.id ?? null; // id enables the labeling system to link to this row
  } catch (err) {
    // 42703 = undefined column. Older deployments are missing
    // extracted_features (migration ordering bug) — self-heal and retry
    // so audit logging never silently dies on schema drift.
    if (err.code === '42703') {
      try {
        await pool.query('ALTER TABLE pipeline_audit_logs ADD COLUMN IF NOT EXISTS extracted_features JSONB');
        await pool.query('ALTER TABLE pipeline_audit_logs ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ');
        const { rows } = await pool.query(sql, params);
        console.log('[DB] Self-healed missing column(s) on pipeline_audit_logs.');
        return rows[0]?.id ?? null;
      } catch (retryErr) {
        console.error('[DB] Failed to insert pipeline audit log after self-heal:', retryErr.message);
        return null;
      }
    }
    console.error('[DB] Failed to insert pipeline audit log:', err.message);
    return null;
  }
}

// Discovery queue: recent REJECTED articles worth clustering for new-seed
// candidates. Deliberate blocklist kills ("Matched excluded context") are
// excluded — those are working as intended, not coverage gaps. Distinct on
// title so the same wire story syndicated 12 times counts once.
export async function getRejectedArticlesForDiscovery(userId, days = 7, limit = 400) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (article_title)
            article_title AS title, source, rejection_reason, stage_dropped, scanned_at
     FROM pipeline_audit_logs
     WHERE user_id = $1
       AND is_accepted = FALSE
       AND rejection_reason IS NOT NULL
       AND rejection_reason NOT ILIKE 'Matched excluded context%'
       AND rejection_reason NOT ILIKE 'Duplicate%'
       AND scanned_at > NOW() - ($2 || ' days')::interval
     ORDER BY article_title, scanned_at DESC
     LIMIT $3`,
    [userId, String(days), limit]
  );
  return rows;
}

// Recent ACCEPTED articles (distinct title) for the categorized news feed.
// Gated on settings_changed_at like the alerts/insights views so a profile
// change doesn't leave stale articles on screen.
export async function getRecentAcceptedArticles(userId, hours = 48, limit = 40) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (article_title)
            article_title AS title, article_url AS url, source, relevance_score, scanned_at, published_at
     FROM pipeline_audit_logs
     WHERE user_id = $1
       AND is_accepted = TRUE
       AND scanned_at > NOW() - ($2 || ' hours')::interval
       AND scanned_at >= COALESCE(
         (SELECT settings_changed_at FROM user_profiles WHERE user_id = $1),
         '1970-01-01'::timestamptz)
     ORDER BY article_title, scanned_at DESC
     LIMIT $3`,
    [userId, String(hours), limit]
  );
  return rows;
}

export async function getPipelineAuditLogs(userId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM pipeline_audit_logs 
     WHERE user_id = $1 
     ORDER BY scanned_at DESC 
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════
// PILLAR 7: Unified Alert Store (event × exposure)
// ═══════════════════════════════════════════════════════════════

export async function insertAlert(userId, alert) {
  // Returns true only when a NEW alert row was created — the unique
  // (user_id, dedup_key) index makes re-scans of the same event a no-op,
  // replacing the old file-based dedup that reset on every restart.
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO alerts (user_id, source, category, severity, title, reason, url, relevance_score, payload, dedup_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, dedup_key) DO NOTHING`,
      [
        userId,
        alert.source,
        alert.category || null,
        alert.severity,
        alert.title,
        alert.reason || null,
        alert.url || null,
        alert.relevanceScore != null ? alert.relevanceScore : null,
        alert.payload ? JSON.stringify(alert.payload) : null,
        alert.dedupKey
      ]
    );
    return rowCount > 0;
  } catch (err) {
    console.error('[DB] Failed to insert alert:', err.message);
    return false;
  }
}

export async function getActiveAlerts(userId, limit = 30) {
  // Lazy lifecycle: alerts expire 24h after creation (hidden from view, row
  // kept as ML training data). An alert is a "now" signal — a day-old one is
  // history, not an alert.
  await pool.query(
    `UPDATE alerts SET status = 'expired' WHERE status = 'active' AND created_at < NOW() - INTERVAL '24 hours'`
  ).catch(() => {});
  // Gate on settings_changed_at: after a material profile change, alerts from
  // the old profile are hidden (not deleted). COALESCE → NULL means show all.
  const { rows } = await pool.query(
    `SELECT id, source, category, severity, title, reason, url, relevance_score, payload, created_at
     FROM alerts
     WHERE user_id = $1 AND status = 'active'
       AND created_at >= COALESCE(
         (SELECT settings_changed_at FROM user_profiles WHERE user_id = $1),
         '1970-01-01'::timestamptz)
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  // Article-freshness filter: hide an alert whose underlying article was
  // PUBLISHED more than 24h ago, even if the alert row itself is younger. The
  // publish date is carried in payload.publishedAt (news alerts). Alerts with
  // no publish date (e.g. price alerts, or pre-freshness-gate rows) are kept —
  // the created_at 24h expiry above already bounds them.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  return rows.filter(r => {
    let pubMs = null;
    try {
      const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
      if (p.publishedAt) { const d = new Date(p.publishedAt); if (!isNaN(d.getTime())) pubMs = d.getTime(); }
    } catch { /* keep on unparseable payload */ }
    return pubMs == null || (now - pubMs) <= DAY_MS;
  });
}

export async function getRecentAlertsBySource(userId, source, hours = 72, limit = 8) {
  // Any status: acknowledging an alert should not remove its intelligence
  // from AI planner context — only age does.
  const { rows } = await pool.query(
    `SELECT id, title, reason, url, severity, relevance_score, payload, created_at
     FROM alerts
     WHERE user_id = $1 AND source = $2 AND created_at > NOW() - ($3 || ' hours')::interval
     ORDER BY relevance_score DESC NULLS LAST, created_at DESC
     LIMIT $4`,
    [userId, source, String(hours), limit]
  );
  return rows;
}

export async function getAlertsSince(userId, hours = 24, limit = 20) {
  // Active only: the Morning Brief must be a strict subset of the Alerts
  // tab, or the two panels show conflicting lists.
  const { rows } = await pool.query(
    `SELECT id, source, category, severity, title, reason, url, status, created_at
     FROM alerts
     WHERE user_id = $1 AND status = 'active' AND created_at > NOW() - ($2 || ' hours')::interval
     ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, created_at DESC
     LIMIT $3`,
    [userId, String(hours), limit]
  );
  return rows;
}

export async function getAcceptedArticlesSince(userId, hours = 24, limit = 5) {
  const { rows } = await pool.query(
    `SELECT article_title, article_url, source, relevance_score, scanned_at
     FROM pipeline_audit_logs
     WHERE user_id = $1 AND is_accepted = TRUE AND scanned_at > NOW() - ($2 || ' hours')::interval
     ORDER BY relevance_score DESC NULLS LAST, scanned_at DESC
     LIMIT $3`,
    [userId, String(hours), limit]
  );
  return rows;
}

export async function acknowledgeAlert(userId, alertId) {
  const { rowCount } = await pool.query(
    `UPDATE alerts SET status = 'acknowledged' WHERE id = $1 AND user_id = $2 AND status = 'active'`,
    [alertId, userId]
  );
  return rowCount > 0;
}

// ═══════════════════════════════════════════════════════════════
// PILLAR 9: Customer (company) profiles
// ═══════════════════════════════════════════════════════════════

export async function listCustomerProfiles() {
  const { rows } = await pool.query('SELECT id, company, industry, region FROM customer_profiles ORDER BY company');
  return rows;
}

export async function setUserCustomer(userId, customerId) {
  // customerId may be null to detach. Validated by the FK constraint on
  // user_profiles.customer_id -> customer_profiles.id.
  await pool.query('UPDATE user_profiles SET customer_id = $1 WHERE user_id = $2', [customerId, userId]);
}

// Append one term to a customer's ml_seeds or signal_keywords (the discovery
// promote flow). Field is whitelisted — never interpolate user input into the
// column position. Case-insensitive dedupe so promoting twice is a no-op.
export async function appendCustomerTerm(customerId, field, value) {
  if (!['ml_seeds', 'signal_keywords'].includes(field)) {
    throw new Error(`appendCustomerTerm: illegal field ${field}`);
  }
  const { rows } = await pool.query(`SELECT ${field} AS arr FROM customer_profiles WHERE id = $1`, [customerId]);
  if (!rows[0]) return { added: false, reason: 'customer not found' };
  const arr = Array.isArray(rows[0].arr) ? rows[0].arr : [];
  const exists = arr.some(x => String(x).toLowerCase() === String(value).toLowerCase());
  if (exists) return { added: false, reason: 'already present', total: arr.length };
  arr.push(value);
  await pool.query(`UPDATE customer_profiles SET ${field} = $2::jsonb WHERE id = $1`, [customerId, JSON.stringify(arr)]);
  return { added: true, total: arr.length };
}

export async function getCustomerProfile(customerId) {
  if (!customerId) return null;
  const { rows } = await pool.query('SELECT * FROM customer_profiles WHERE id = $1', [customerId]);
  return rows[0] || null;
}

// The customer profile linked to a given user (via user_profiles.customer_id),
// or null if the user isn't attached to a customer.
export async function getCustomerProfileForUser(userId) {
  const { rows } = await pool.query(
    `SELECT cp.* FROM customer_profiles cp
     JOIN user_profiles up ON up.customer_id = cp.id
     WHERE up.user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// Recent labeled insights for THIS user, straight from storage — no
// dependency on the live (rotating) news feed happening to still contain
// the same articles. This is what the dashboard's Intelligence panel shows.
export async function getRecentInsights(userId, limit = 15) {
  const { rows } = await pool.query(
    `SELECT ai.id, ai.severity, ai.category, ai.urgency, ai.summary, ai.action_note,
            ai.action_required, ai.insight_json, ai.created_at,
            pal.article_title, pal.article_url, pal.source
     FROM article_insights ai
     JOIN pipeline_audit_logs pal ON ai.audit_log_id = pal.id
     WHERE ai.user_id = $1
       AND ai.created_at >= COALESCE(
         (SELECT settings_changed_at FROM user_profiles WHERE user_id = $1),
         '1970-01-01'::timestamptz)
     ORDER BY ai.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// Stamp the cutoff used by getActiveAlerts/getRecentInsights so pre-change
// alerts and labels drop out of view immediately (kept in the DB for
// training/history). Called from PUT /profile only on a material change.
export async function touchSettingsChanged(userId) {
  await pool.query('UPDATE user_profiles SET settings_changed_at = NOW() WHERE user_id = $1', [userId]);
}

// On-demand click-to-summarize cache, keyed by article URL so repeat
// clicks (by this user or any other) are a free DB read instead of a
// second Groq call.
export async function getArticleSummaryCache(articleUrl) {
  if (!articleUrl) return null;
  const { rows } = await pool.query(
    'SELECT * FROM article_summary_cache WHERE article_url = $1',
    [articleUrl]
  );
  return rows[0] || null;
}

export async function saveArticleSummaryCache(articleUrl, articleTitle, { summary, impact, action_note, entities, key_figures, model }) {
  const { rows } = await pool.query(
    `INSERT INTO article_summary_cache (article_url, article_title, summary, impact, action_note, entities_json, key_figures_json, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (article_url) DO UPDATE SET
       summary = EXCLUDED.summary, impact = EXCLUDED.impact, action_note = EXCLUDED.action_note,
       entities_json = EXCLUDED.entities_json, key_figures_json = EXCLUDED.key_figures_json, model = EXCLUDED.model
     RETURNING *`,
    [articleUrl, articleTitle, summary, impact, action_note || null, JSON.stringify(entities || {}), JSON.stringify(key_figures || []), model]
  );
  return rows[0];
}

// Look up stored labeling insights for a set of displayed articles, matched to
// pipeline_audit_logs by URL or (fallback) normalized title. Returns a map so
// the frontend can show hover insights on news the scanner already labeled.
export async function getInsightsForArticles(userId, articles) {
  const urls = [...new Set(articles.map(a => a.url).filter(Boolean))];
  const titles = [...new Set(articles.map(a => (a.title || '').trim().toLowerCase()).filter(Boolean))];
  if (urls.length === 0 && titles.length === 0) return {};

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (pal.article_url, lower(pal.article_title))
            pal.article_url, pal.article_title,
            ai.severity, ai.urgency, ai.category, ai.summary, ai.insight_json
     FROM article_insights ai
     JOIN pipeline_audit_logs pal ON ai.audit_log_id = pal.id
     WHERE ai.user_id = $1
       AND (pal.article_url = ANY($2) OR lower(pal.article_title) = ANY($3))
     ORDER BY pal.article_url, lower(pal.article_title), ai.created_at DESC`,
    [userId, urls, titles]
  );

  const byUrl = {}, byTitle = {};
  for (const r of rows) {
    const insight = {
      severity: r.severity, urgency: r.urgency, category: r.category,
      headline: r.summary, detail: r.insight_json || null,
    };
    if (r.article_url) byUrl[r.article_url] = insight;
    if (r.article_title) byTitle[r.article_title.trim().toLowerCase()] = insight;
  }
  return { byUrl, byTitle };
}

// Export the pool for session store
export { pool };
export default pool;
