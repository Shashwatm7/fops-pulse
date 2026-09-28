import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

if (fs.existsSync('/etc/secrets/.env')) { dotenv.config({ path: '/etc/secrets/.env' }); } else { dotenv.config(); }

const { Pool } = pg;
// connectionTimeoutMillis is essential here, not a nicety. The container runs
// `node migrate.js && node server.js`, so if this pool never connects, the
// migration step never exits and server.js never starts — the port stays
// unbound and the platform's edge holds requests open returning zero bytes,
// with no error anywhere. pg defaults to waiting forever.
//
// Most common cause: DATABASE_URL pointing at Supabase's DIRECT host
// (db.<ref>.supabase.co), which is IPv6-only. From an IPv4-only network that
// hangs rather than refusing. Use the Session pooler host instead.
const CONNECT_TIMEOUT_MS = Number(process.env.DB_CONNECT_TIMEOUT_MS) || 15000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
});

function describeTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL || '');
    const direct = /^db\..*\.supabase\.co$/i.test(u.hostname);
    return `${u.hostname}:${u.port || 5432}${direct ? ' (Supabase DIRECT host — IPv6 only)' : ''}`;
  } catch { return '<unparseable DATABASE_URL>'; }
}

async function runMigrations() {
  console.log(`Running database migrations against ${describeTarget()} ...`);
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error(`\n[MIGRATE] FATAL: could not connect to the database within ${CONNECT_TIMEOUT_MS}ms.`);
    console.error(`[MIGRATE] target: ${describeTarget()}`);
    console.error(`[MIGRATE] cause : ${err.message}`);
    if (/^db\..*\.supabase\.co$/i.test((() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch { return ''; } })())) {
      console.error('[MIGRATE] hint  : that host is IPv6-only. Switch DATABASE_URL to the Supabase');
      console.error('[MIGRATE]         Session pooler (aws-0-<region>.pooler.supabase.com:5432,');
      console.error('[MIGRATE]         user postgres.<project-ref>) and add sslmode=no-verify.');
    }
    throw err;
  }
  try {
    const migrationFiles = [
      'migrations/001_init.sql', 
      'migrations/002_add_feedback.sql',
      'migrations/003_baseline_schema.sql',
      'migrations/004_raw_signals.sql',
      'migrations/005_canonical_signals.sql',
      'migrations/006_forecast_outputs.sql',
      'migrations/007_recommendations.sql',
      'migrations/008_dynamic_dictionaries.sql',
      'migrations/008_pipeline_audit_logs.sql',
      'migrations/009_pipeline_audit_features.sql',
      'migrations/010_alerts.sql',
      'migrations/011_article_labeling.sql',
      'migrations/012_customer_profiles.sql',
      'migrations/013_label_tiers.sql',
      'migrations/014_blocked_topics.sql',
      'migrations/015_article_summary_cache.sql',
      'migrations/016_clear_stale_summary_cache.sql',
      'migrations/017_settings_changed_at.sql',
      'migrations/018_summary_key_figures.sql',
      'migrations/019_bust_hallucinated_summaries.sql',
      'migrations/020_drop_review_queue.sql',
      'migrations/021_add_weather_regions.sql',
      'migrations/022_tracked_ports.sql',
      'migrations/023_tracked_currencies.sql',
      'migrations/024_audit_published_at.sql',
      'migrations/025_last_scan_result.sql',
      'migrations/026_entra_sso.sql',
      // 027 shipped in the codebase but was never added here, so the audit
      // dedupe index it creates has never actually run in any environment.
      'migrations/027_audit_dedupe.sql',
      'migrations/028_alert_acknowledged_at.sql',
      'migrations/029_deep_dives.sql',
      'migrations/030_alert_summaries.sql',
      'migrations/031_api_service_user.sql',
      'migrations/032_job_runs.sql',
      'migrations/033_generic_manufacturer_seeds.sql',
    ];
    let failures = 0;
    for (const file of migrationFiles) {
      if (fs.existsSync(file)) {
        console.log(`Executing ${file}...`);
        const sql = fs.readFileSync(file, 'utf8');
        try {
          await client.query(sql);
        } catch (err) {
          // Continue to the next file: one failing migration must not
          // silently block every migration after it.
          failures++;
          console.error(`MIGRATION FAILED (${file}):`, err.message);
        }
      }
    }
    if (failures > 0) {
      console.error(`Migrations finished with ${failures} failure(s) — see errors above.`);
    } else {
      console.log('Migrations completed successfully!');
    }
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    client.release();
    pool.end();
  }
}

runMigrations();
