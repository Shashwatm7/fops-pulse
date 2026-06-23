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
      'migrations/007_recommendations.sql'
    ];
    for (const file of migrationFiles) {
      if (fs.existsSync(file)) {
        console.log(`Executing ${file}...`);
        const sql = fs.readFileSync(file, 'utf8');
        await client.query(sql);
      }
    }
    console.log('Migrations completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    client.release();
    pool.end();
  }
}

runMigrations();
