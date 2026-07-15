// Smoke test for the live Gemini API endpoints this app depends on.
//
// Deliberately NOT in tests/*.test.js (the CI suite): it hits the real API, so
// it needs a valid GEMINI_API_KEY, consumes quota, and would make CI flaky /
// fail offline. Run it manually or as a pre-deploy check:
//
//     node scripts/gemini-smoke.mjs
//
// Exit code 0 = all endpoints OK, 1 = one or more failed, 2 = no key.
import dotenv from 'dotenv';
dotenv.config();

const KEY = process.env.GEMINI_API_KEY;
const CHAT_MODEL = process.env.LABELING_GEMINI_MODEL || 'gemini-2.5-flash';
const EMB_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
const embResource = EMB_MODEL.startsWith('models/') ? EMB_MODEL : `models/${EMB_MODEL}`;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

if (!KEY) {
  console.error('GEMINI_API_KEY not set — cannot run smoke test.');
  process.exit(2);
}

let failures = 0;
async function check(name, fn) {
  process.stdout.write(`- ${name} ... `);
  const t0 = Date.now();
  try {
    await fn();
    console.log(`PASS (${Date.now() - t0}ms)`);
  } catch (e) {
    failures++;
    console.log(`FAIL — ${e.message}`);
  }
}
async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status !== 200) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${txt.slice(0, 160)}`);
  }
  return r.json();
}
function must(cond, msg) { if (!cond) throw new Error(msg); }

console.log(`Gemini smoke test — chat: ${CHAT_MODEL}, embeddings: ${embResource}\n`);

// 1. generateContent, JSON mode — market drivers + article summaries path.
await check(`generateContent (JSON)      [${CHAT_MODEL}]`, async () => {
  const d = await post(`${BASE}/models/${CHAT_MODEL}:generateContent?key=${KEY}`, {
    systemInstruction: { parts: [{ text: 'Return ONLY valid JSON.' }] },
    contents: [{ parts: [{ text: 'Return {"ok":true}' }] }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 50, thinkingConfig: { thinkingBudget: 0 } },
  });
  const text = d?.candidates?.[0]?.content?.parts?.[0]?.text;
  must(text, 'no text in response');
  JSON.parse(text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim());
});

// 2. generateContent, plain text, tiny maxTokens — precedent classifier path.
await check(`generateContent (text)      [${CHAT_MODEL}]`, async () => {
  const d = await post(`${BASE}/models/${CHAT_MODEL}:generateContent?key=${KEY}`, {
    contents: [{ parts: [{ text: 'Reply with the single word: YES' }] }],
    generationConfig: { maxOutputTokens: 16, thinkingConfig: { thinkingBudget: 0 } },
  });
  must(d?.candidates?.[0]?.content?.parts?.[0]?.text, 'no text in response');
});

// 3. embedContent — single embedding path.
await check(`embedContent (single)       [${embResource}]`, async () => {
  const d = await post(`${BASE}/${embResource}:embedContent?key=${KEY}`, {
    model: embResource, content: { parts: [{ text: 'wheat price rally in the Black Sea' }] },
  });
  must(Array.isArray(d?.embedding?.values) && d.embedding.values.length > 0, 'no embedding values returned');
});

// 4. batchEmbedContents — batch embedding path.
await check(`batchEmbedContents (batch)  [${embResource}]`, async () => {
  const d = await post(`${BASE}/${embResource}:batchEmbedContents?key=${KEY}`, {
    requests: [
      { model: embResource, content: { parts: [{ text: 'corn export ban' }] } },
      { model: embResource, content: { parts: [{ text: 'port congestion at Jebel Ali' }] } },
    ],
  });
  must(Array.isArray(d?.embeddings) && d.embeddings.length === 2, `expected 2 embeddings, got ${d?.embeddings?.length}`);
});

console.log(failures ? `\n${failures} Gemini endpoint(s) FAILED` : '\nAll Gemini endpoints OK');
process.exit(failures ? 1 : 0);
