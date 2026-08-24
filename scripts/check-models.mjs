#!/usr/bin/env node
// Verifies every LLM model this app is configured to use actually exists on the
// configured key AND honours the response contract the callers depend on
// (response_format: json_object for Groq, JSON mime type for Gemini).
//
//   npm run check:models
//
// Exits non-zero if any configured model is unusable, so CI or a pre-deploy
// step catches a decommissioned model instead of a user discovering it.
// Both llama-3.3-70b-versatile and llama-3.1-8b-instant were silently
// decommissioned on Groq while still hardcoded here — this script exists so
// that cannot happen unnoticed again.
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const GROQ_KEYS = (process.env.GROQ_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const GROQ_REASONING = process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b';
const GROQ_SUMMARY = process.env.LABELING_GROQ_MODEL || 'openai/gpt-oss-20b';
const GEMINI_CHAT = 'gemini-2.5-flash';
const GEMINI_EMBED = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
const EMBED_DIMS = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS) || 768;

const results = [];
const pass = (what, detail) => results.push({ ok: true, what, detail });
const fail = (what, detail) => results.push({ ok: false, what, detail });

async function checkGroqModel(label, model) {
    if (!GROQ_KEYS.length) return fail(`${label} (${model})`, 'GROQ_API_KEY not set');
    try {
        const t = Date.now();
        const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model,
            max_tokens: 200,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: 'You are a JSON API. Return ONLY {"ok":true,"note":"<short string>"}.' },
                { role: 'user', content: 'Reply with the required JSON object. Output ONLY valid JSON.' },
            ],
        }, { headers: { Authorization: `Bearer ${GROQ_KEYS[0]}` }, timeout: 45000 });

        const content = r.data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') return fail(`${label} (${model})`, 'no content in response envelope');
        JSON.parse(content); // must be parseable — every caller JSON.parses it
        pass(`${label} (${model})`, `${Date.now() - t}ms, json_object honoured`);
    } catch (e) {
        const status = e.response?.status;
        const msg = e.response?.data?.error?.message || e.message;
        const hint = status === 404 ? ' — DECOMMISSIONED or no access; pick another model' : '';
        fail(`${label} (${model})`, `${status || ''} ${msg}${hint}`);
    }
}

async function checkGeminiChat() {
    if (!GEMINI_KEY) return fail(`gemini chat (${GEMINI_CHAT})`, 'GEMINI_API_KEY not set');
    try {
        const t = Date.now();
        const { data } = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT}:generateContent?key=${GEMINI_KEY}`,
            {
                systemInstruction: { parts: [{ text: 'You are a JSON API. Return ONLY {"ok":true}.' }] },
                contents: [{ parts: [{ text: 'Reply with the required JSON.' }] }],
                generationConfig: { temperature: 0, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' },
            },
            { timeout: 45000 }
        );
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string') {
            return fail(`gemini chat (${GEMINI_CHAT})`, `no usable text (finishReason: ${data.candidates?.[0]?.finishReason || 'none'})`);
        }
        JSON.parse(text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim());
        pass(`gemini chat (${GEMINI_CHAT})`, `${Date.now() - t}ms, JSON mime honoured`);
    } catch (e) {
        fail(`gemini chat (${GEMINI_CHAT})`, `${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);
    }
}

async function checkGeminiEmbedding() {
    if (!GEMINI_KEY) return fail(`gemini embed (${GEMINI_EMBED})`, 'GEMINI_API_KEY not set');
    try {
        const t = Date.now();
        const { data } = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED}:embedContent?key=${GEMINI_KEY}`,
            { model: `models/${GEMINI_EMBED}`, content: { parts: [{ text: 'wheat export ban' }] }, outputDimensionality: EMBED_DIMS },
            { timeout: 45000 }
        );
        const vec = data.embedding?.values;
        if (!Array.isArray(vec)) return fail(`gemini embed (${GEMINI_EMBED})`, 'no embedding vector returned');
        // Dimension mismatch silently corrupts pgvector inserts (column is vector(768)).
        if (vec.length !== EMBED_DIMS) return fail(`gemini embed (${GEMINI_EMBED})`, `returned ${vec.length} dims, expected ${EMBED_DIMS}`);
        if (vec.every(v => v === 0)) return fail(`gemini embed (${GEMINI_EMBED})`, 'returned an all-zero vector');
        pass(`gemini embed (${GEMINI_EMBED})`, `${Date.now() - t}ms, ${vec.length} dims`);
    } catch (e) {
        fail(`gemini embed (${GEMINI_EMBED})`, `${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);
    }
}

console.log(`Checking configured LLM models (${GROQ_KEYS.length} Groq key(s), Gemini ${GEMINI_KEY ? 'set' : 'MISSING'})\n`);

await checkGroqModel('groq reasoning', GROQ_REASONING);
await checkGroqModel('groq summary  ', GROQ_SUMMARY);
await checkGeminiChat();
await checkGeminiEmbedding();

for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.what}  ${r.detail}`);

const failed = results.filter(r => !r.ok);
if (failed.length) {
    console.error(`\n${failed.length} of ${results.length} model checks FAILED — those features are down.`);
    if (GROQ_KEYS.length) {
        try {
            const r = await axios.get('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${GROQ_KEYS[0]}` }, timeout: 20000 });
            console.error('\nModels currently available on this Groq key:');
            r.data.data.map(m => m.id).sort().forEach(m => console.error(`  ${m}`));
        } catch { /* listing is a convenience; ignore */ }
    }
    process.exit(1);
}
console.log(`\nAll ${results.length} model checks passed.`);
