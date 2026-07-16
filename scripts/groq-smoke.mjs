// Smoke test for every Groq key in the pool (GROQ_API_KEY, comma-separated).
// Makes one tiny completion per key and reports PASS/FAIL + the task each key
// is pinned to + the account's remaining request budget.
//
// NOT in the CI suite (live API, burns a little quota). Run manually:
//     node scripts/groq-smoke.mjs
// Exit 0 = all keys OK, 1 = one or more failed, 2 = no keys.
import dotenv from 'dotenv';
dotenv.config();

const KEYS = (process.env.GROQ_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
// Must mirror server.js GROQ_TASK_KEY so the report matches production routing.
const TASK_BY_INDEX = ['planner', 'deep-dive', 'summary', 'drivers', 'precedent'];

if (KEYS.length === 0) {
  console.error('GROQ_API_KEY not set — nothing to test.');
  process.exit(2);
}

console.log(`Groq key pool: ${KEYS.length} key(s)\n`);
let failures = 0;

for (let i = 0; i < KEYS.length; i++) {
  const key = KEYS[i];
  const masked = key.slice(0, 6) + '…' + key.slice(-4);
  const task = TASK_BY_INDEX[i] || `(unused idx ${i})`;
  process.stdout.write(`- key[${i}] ${masked}  →  ${task.padEnd(10)} ... `);
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 5,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply with the word OK.' }],
      }),
    });
    const remaining = r.headers.get('x-ratelimit-remaining-requests');
    if (r.status !== 200) {
      const body = await r.text().catch(() => '');
      failures++;
      console.log(`FAIL (HTTP ${r.status}) ${body.slice(0, 120)}`);
      continue;
    }
    const d = await r.json();
    const reply = (d.choices?.[0]?.message?.content || '').trim();
    console.log(`PASS (${Date.now() - t0}ms, "${reply}", ${remaining ?? '?'} req left today)`);
  } catch (e) {
    failures++;
    console.log(`FAIL — ${e.message}`);
  }
}

// Flag duplicate keys (a common mistake — pasting the same key twice gains nothing).
const uniq = new Set(KEYS);
if (uniq.size < KEYS.length) {
  console.log(`\nWARNING: ${KEYS.length - uniq.size} duplicate key(s) — duplicates share one account's budget, so they add no capacity.`);
}

console.log(failures ? `\n${failures} key(s) FAILED` : '\nAll keys OK');
process.exit(failures ? 1 : 0);
