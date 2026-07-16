// Grant admin to a user by email — works against ANY Postgres, including
// Render's (no psql binary needed; uses the repo's pg package).
//
// Usage (Render): copy "External Database URL" from the Render DB Info page,
// then run from the repo root:
//     DATABASE_URL="<paste External Database URL>" node scripts/make-admin.mjs you@email.com
// Usage (local):
//     DATABASE_URL="postgresql://localhost:5433/fops_pulse" node scripts/make-admin.mjs you@email.com
//
// Deliberately does NOT load .env: the URL must be passed explicitly so you
// always know which database you are pointing at.
import pg from 'pg';

const email = process.argv[2];
const url = process.env.DATABASE_URL;
if (!email || !url) {
    console.error('Usage: DATABASE_URL="<postgres url>" node scripts/make-admin.mjs <email>');
    process.exit(2);
}

// Render (and most hosted Postgres) require TLS on external connections;
// local connections don't speak it.
const isLocal = /localhost|127\.0\.0\.1/.test(url);
const pool = new pg.Pool({ connectionString: url, ssl: isLocal ? undefined : { rejectUnauthorized: false } });

try {
    const { rowCount } = await pool.query(
        'UPDATE users SET is_admin = true WHERE LOWER(email) = LOWER($1)', [email]
    );
    console.log(rowCount ? `OK: ${email} is now an admin.` : `NO CHANGE: no user with email "${email}".`);
    const { rows } = await pool.query('SELECT id, email, is_admin FROM users ORDER BY id');
    console.table(rows);
} finally {
    await pool.end();
}
