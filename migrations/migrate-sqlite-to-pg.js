// migrations/migrate-sqlite-to-pg.js
// One-time migration: reads users and profiles from SQLite, inserts into PostgreSQL.
// Run: node migrations/migrate-sqlite-to-pg.js

import Database from 'better-sqlite3';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sqliteDb = new Database(join(__dirname, '..', 'fops_pulse.db'));
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/fops_pulse',
});

async function migrate() {
  console.log('🔄 Starting SQLite → PostgreSQL migration...\n');

  // 1. Migrate users
  const users = sqliteDb.prepare('SELECT * FROM users').all();
  console.log(`Found ${users.length} users in SQLite.`);

  for (const u of users) {
    try {
      await pool.query(
        `INSERT INTO users (id, username, email, password_hash, company_name, is_admin, is_onboarded, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.username, u.email, u.password_hash, u.company_name || '', !!u.is_admin, !!u.is_onboarded, u.created_at]
      );
      console.log(`  ✅ User "${u.username}" (id=${u.id}) migrated.`);
    } catch (err) {
      console.error(`  ❌ User "${u.username}" failed:`, err.message);
    }
  }

  // Reset the serial sequence to avoid ID conflicts
  if (users.length > 0) {
    const maxId = Math.max(...users.map(u => u.id));
    await pool.query(`SELECT setval('users_id_seq', $1, true)`, [maxId]);
    console.log(`  → Sequence reset to ${maxId}\n`);
  }

  // 2. Migrate profiles
  const profiles = sqliteDb.prepare('SELECT * FROM user_profiles').all();
  console.log(`Found ${profiles.length} profiles in SQLite.`);

  for (const p of profiles) {
    try {
      // Parse JSON columns from SQLite (they're stored as text)
      const commodities = p.commodities || '[]';
      const regions = p.regions || '[]';
      const focus_countries = p.focus_countries || '[]';
      const news_keywords = p.news_keywords || '[]';
      const currencies = p.currencies || '[]';
      const custom_regions = p.custom_regions || '[]';
      const price_alerts = p.price_alerts || '[]';

      await pool.query(
        `INSERT INTO user_profiles (user_id, commodities, regions, focus_region, focus_countries, focus_product, news_keywords, news_country_codes, currencies, template_name, custom_regions, price_alerts)
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, $6, $7::jsonb, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb)
         ON CONFLICT (user_id) DO NOTHING`,
        [p.user_id, commodities, regions, p.focus_region || 'Middle East', focus_countries, p.focus_product || 'Frozen Goods', news_keywords, p.news_country_codes || '', currencies, p.template_name || 'custom', custom_regions, price_alerts]
      );
      console.log(`  ✅ Profile for user_id=${p.user_id} migrated.`);
    } catch (err) {
      console.error(`  ❌ Profile for user_id=${p.user_id} failed:`, err.message);
    }
  }

  console.log('\n✅ Migration complete!');

  // Verify
  const { rows: pgUsers } = await pool.query('SELECT count(*) as count FROM users');
  const { rows: pgProfiles } = await pool.query('SELECT count(*) as count FROM user_profiles');
  console.log(`PostgreSQL now has: ${pgUsers[0].count} users, ${pgProfiles[0].count} profiles.`);

  sqliteDb.close();
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
