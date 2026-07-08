import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

if (fs.existsSync('/etc/secrets/.env')) { dotenv.config({ path: '/etc/secrets/.env' }); } else { dotenv.config(); }

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runMigrations() {
  console.log('Running database migrations...');
  const client = await pool.connect();
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
      'migrations/015_article_summary_cache.sql'
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
