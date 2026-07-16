// Smoke test for the AI-generation endpoints (planner recommendations,
// deep-dive, market drivers). Mints a session directly in the PgStore for an
// existing user (no password), then calls each endpoint and checks:
//   1. it responds and is authenticated,
//   2. on success it returns real generated content,
//   3. NO fallback/canned text ever appears (the whole point — a failure must
//      surface as an error, never a degraded stand-in response).
//
// Run against a locally-running instance that shares this DB:
//     SMOKE_BASE=http://localhost:3001 node scripts/ai-endpoints-smoke.mjs
// Default base is http://localhost:3001. Exit 0 = all PASS, 1 = a failure.
import 'dotenv/config';
import pg from 'pg';
import crypto from 'crypto';
import signature from 'cookie-signature';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';
const SECRET = process.env.SESSION_SECRET || 'fops-market-pulse-secret-2026';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5433/fops_pulse' });

// Any output that means "we degraded instead of erroring" — must never appear.
const FALLBACK_MARKERS = [
  'DETERMINISTIC FALLBACK',
  'SYSTEM: AI Generation Failed',
  'unable to format',
  'AI is disabled',
];

function hasFallbackText(obj) {
  const blob = JSON.stringify(obj || {});
  return FALLBACK_MARKERS.filter(m => blob.includes(m));
}

async function mintCookie() {
  const { rows } = await pool.query(
    "SELECT id, email FROM users WHERE is_onboarded = true ORDER BY (email ILIKE 'shashwat%') DESC, id ASC LIMIT 1"
  );
  if (!rows.length) throw new Error('No onboarded user to test as.');
  const user = rows[0];
  const sid = crypto.randomBytes(24).toString('hex');
  await pool.query(
    'INSERT INTO session (sid, sess, expire) VALUES ($1,$2,$3)',
    [sid, { cookie: { originalMaxAge: 86400000, httpOnly: true, path: '/', sameSite: 'lax' }, userId: user.id }, new Date(Date.now() + 3600e3)]
  );
  const cookie = 'connect.sid=' + encodeURIComponent('s:' + signature.sign(sid, SECRET));
  return { cookie, sid, user };
}

let failures = 0;
function report(name, { ok, detail }) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
}

async function post(path, body, cookie) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  let j; try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, j, ms: Date.now() - t0 };
}

console.log(`AI endpoint smoke test → ${BASE}\n`);
const { cookie, sid, user } = await mintCookie();
console.log(`Session minted for ${user.email} (id ${user.id})\n`);

try {
  // 1) Planner recommendations
  {
    const { status, j, ms } = await post('/api/analyze-planner', { forceRefresh: true }, cookie);
    const markers = hasFallbackText(j);
    const ok = status === 200 && j.success === true && Array.isArray(j.recommendations) && j.recommendations.length > 0 && markers.length === 0;
    report('planner       ', {
      ok,
      detail: ok
        ? `${ms}ms, ${j.recommendations.length} recs, no fallback text`
        : `HTTP ${status}, success=${j.success}, recs=${j.recommendations?.length ?? '-'}, error="${String(j.error || '').slice(0, 80)}"${markers.length ? `, FALLBACK TEXT: ${markers.join(',')}` : ''}`,
    });
  }

  // 2) Deep-dive
  {
    const { status, j, ms } = await post('/api/analyze-deep-dive', {
      timeframe: '90D',
      deterministicAction: 'Secure 60-day forward cover on corn.',
      prices: [], news: [], weatherExtended: [],
    }, cookie);
    const markers = hasFallbackText(j);
    const ok = status === 200 && j.success === true && typeof j.deepDive === 'string' && j.deepDive.length > 50 && markers.length === 0;
    report('deep-dive     ', {
      ok,
      detail: ok
        ? `${ms}ms, ${j.deepDive.length} chars, no fallback text`
        : `HTTP ${status}, success=${j.success}, error="${String(j.error || '').slice(0, 80)}"${markers.length ? `, FALLBACK TEXT: ${markers.join(',')}` : ''}`,
    });
  }

  // 3) Market drivers (generated inside /api/analyze)
  {
    const { status, j, ms } = await post('/api/analyze', {}, cookie);
    const a = j.analysis || {};
    const markers = hasFallbackText(j);
    // PASS if drivers generated OR a clean driversError is surfaced — as long
    // as no legacy fallback/fake-driver text leaks through.
    const cleanError = !!a.driversError && (!a.drivers || a.drivers.length === 0);
    const generated = Array.isArray(a.drivers) && a.drivers.length > 0;
    const ok = status === 200 && (generated || cleanError) && markers.length === 0;
    report('market-drivers', {
      ok,
      detail: ok
        ? `${ms}ms, ${generated ? `${a.drivers.length} drivers` : `clean error: "${String(a.driversError).slice(0, 60)}"`}, no fallback text`
        : `HTTP ${status}, drivers=${a.drivers?.length ?? '-'}, driversError="${String(a.driversError || '').slice(0, 60)}"${markers.length ? `, FALLBACK TEXT: ${markers.join(',')}` : ''}`,
    });
  }
} finally {
  await pool.query('DELETE FROM session WHERE sid=$1', [sid]);
  await pool.end();
}

console.log(failures ? `\n${failures} endpoint(s) FAILED` : '\nAll AI endpoints OK');
process.exit(failures ? 1 : 0);
