// On-demand article summarization + local entity extraction. Provider-
// agnostic via LLM_PROVIDER (groq | anthropic), swappable with one env var
// and no code change. Uses axios directly so no vendor SDK dependency is
// required. (Scan-time labeling was removed — ingestion is fully rule-based;
// this module only serves the click-to-summarize feature.)
import axios from 'axios';
import { labelingConfig as cfg } from '../../config/labeling.js';
import { matchEntities } from '../news-pipeline/entity_matcher.js';

// ── Provider factory: same interface, different backend ──
function makeClient() {
    if (cfg.provider === 'anthropic') {
        if (!cfg.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty');
        return async (system, user, maxTokens) => {
            const res = await axios.post('https://api.anthropic.com/v1/messages', {
                model: cfg.models.anthropic,
                max_tokens: maxTokens,
                system,
                messages: [{ role: 'user', content: user }],
            }, {
                headers: {
                    'x-api-key': cfg.anthropicApiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            });
            return res.data.content[0].text;
        };
    }
    // default: groq
    if (!cfg.groqApiKey) throw new Error('GROQ_API_KEY is empty');
    const key = cfg.groqApiKey.split(',')[0].trim(); // first key if comma-rotated
    return async (system, user, maxTokens) => {
        const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: cfg.models.groq,
            max_tokens: maxTokens,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        }, {
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            timeout: 30000,
        });
        return res.data.choices[0].message.content;
    };
}

// Rule-based entity extraction + master-data matching (zero LLM). Delegates
// to the shared matcher: word-boundary, alias-aware ("chicken"→poultry synonym
// group; "Dubai"→UAE region), canonical-linked. Replaces the old naive
// substring match that matched "india" inside "indiana" and knew no synonyms.
// Output keys are the canonical master names (back-compatible with the summary
// prompt, which just lists them). Feeding these to the LLM instead of asking
// it to find them keeps the prompt short and the extraction free + grounded.
export function extractLocalEntities(text, customer) {
    const m = matchEntities(text, customer || {});
    const names = (arr) => arr.map(e => e.canonical);
    return {
        commodities: names(m.commodities),
        ports: names(m.ports),
        routes: names(m.routes),
        supplier_countries: names(m.supplier_countries),
        regions: names(m.regions),
        chokepoints: names(m.chokepoints),
    };
}

const BANNED_PHRASES = [
    'could impact the market', 'may affect prices', 'monitor the situation',
    'keep an eye on', 'stay informed', 'could have implications',
    'it is important to', 'in the coming days/weeks', 'remains to be seen',
];

// Bump when the prompt/output shape changes so the URL cache regenerates
// instead of serving summaries written by an older, thinner prompt.
// v3: anti-hallucination — Google News URLs now resolve to real article
// bodies, the no-body case forbids figures, and key_figures are grounded
// against the actual input before being returned.
// v4: reader-proxy fallback for IP-blocked publishers; no-body summaries are
// no longer cached (bump invalidates v3 rows that cached a transient failure).
export const SUMMARY_VERSION = 'v4';

// Static instructions + output schema live in the SYSTEM prompt: it is
// identical on every call, so Groq's automatic prompt caching can reuse it as
// a cached prefix (the dynamic article goes in the user message). This is the
// token-saving structure — static-before-dynamic.
const SUMMARY_SYSTEM_PROMPT =
    `You are a supply chain intelligence analyst for a food-service distributor in the GCC. You brief demand/supply planners who already know the industry. You are given the stripped body text of ONE news article and must turn it into an actionable, specific brief.

Write for a planner deciding whether this article needs action THIS WEEK. Every sentence must carry a concrete fact from the article — a number, percentage, date, named company/official/port/vessel, volume, or price. Do not restate the headline. Do not add background the article does not contain.

Return ONLY valid JSON (no markdown, no backticks) in EXACTLY this shape:
{
  "summary": "3-5 sentences that a planner could act on without opening the article. Lead with what happened and the hardest numbers/dates/names in the text, then the supply-chain consequence. If the article genuinely contains no figures, say so plainly in one sentence rather than padding.",
  "impact": "1-2 sentences naming the SPECIFIC mechanism for THIS distributor: which commodity/port/route/supplier-country from the provided entity list is affected and how (e.g. 'Red Sea rerouting adds ~10-14 days to Europe-UAE chicken shipments, tightening frozen-poultry cover'). Write 'Limited direct impact' only if genuinely none.",
  "action_note": "1 concrete action tied to this article (e.g. 'Confirm buffer stock covers a 2-week delay on the affected route before the next PO'), or null if no action is warranted. Never generic advice.",
  "key_figures": ["the 2-5 hardest data points from the article verbatim: e.g. '+18% FCOJ futures', 'harvest down to 3.2M tonnes', 'Q3 2026'. Empty array if the article states none — never invent."]
}

Ground every field strictly in the supplied article text and entity list; never invent numbers, dates, or affected entities. CRITICAL: if the article body is marked as unavailable, you MUST NOT state ANY figure, percentage, date, volume, or named detail that is not literally present in the title — key_figures MUST be an empty array, and the summary must say the full article text could not be retrieved. A wrong number in a procurement brief causes real purchasing mistakes; "no data" is always the correct answer over an invented one. Banned phrases (and close paraphrases): ${BANNED_PHRASES.join('; ')}.`;

// Shared between the prompt and the grounding filter so figures are checked
// against exactly the content the model saw.
function summaryContent(article, bodyText) {
    if (bodyText && bodyText.length > 120) return bodyText;
    const snippet = (article.description || '').slice(0, 800);
    if (snippet.trim().length >= 40) return snippet;
    return 'UNAVAILABLE — the full article text could not be retrieved. Only the title above is known. Do not state any figures; key_figures must be [].';
}

function summaryPrompt(article, entities, customer, bodyText) {
    const j = (v) => (v && v.length ? v.join(', ') : 'none detected');
    const content = summaryContent(article, bodyText);
    return `Distributor: ${customer?.company || 'general food-service importer'} (${customer?.region || 'GCC'})

Title: ${article.title}
Source: ${article.source || 'unknown'}

Article body (stripped to text):
"""
${content}
"""

Entities already matched to this distributor's profile (use these; do not re-derive):
Commodities: ${j(entities.commodities)}
Ports: ${j(entities.ports)}
Routes: ${j(entities.routes)}
Supplier countries: ${j(entities.supplier_countries)}`;
}

// Grounding filter: a key_figure survives only if every digit-group in it
// (e.g. "19.1", "2026", "18") literally appears in the text the model was
// given. Small LLMs under a "produce hard figures" instruction will invent
// numbers when the input has none — this makes invented figures impossible
// to surface, regardless of what the model returns. Exported for tests.
export function groundKeyFigures(figures, sourceText) {
    if (!Array.isArray(figures)) return [];
    const src = String(sourceText || '');
    return figures.filter(f => {
        const groups = String(f).match(/\d+(?:\.\d+)?/g);
        if (!groups || groups.length === 0) return false; // a "figure" with no number isn't one
        return groups.every(g => src.includes(g));
    });
}

/**
 * On-demand click-to-summarize for a single article. No training/category
 * output, meant to be cached by caller (article_summary_cache) rather than
 * run at scan time. Pass bodyText (the locally-stripped article body from
 * fetchArticleText) so the model has real content to work with instead of
 * the thin RSS snippet.
 * @returns {Promise<{summary: string, impact: string, action_note: string|null, key_figures: string[]}>}
 */
export async function summarizeArticle(article, entities, customer = null, bodyText = null) {
    const client = makeClient();
    const raw = await client(SUMMARY_SYSTEM_PROMPT, summaryPrompt(article, entities, customer, bodyText), 700);
    const parsed = JSON.parse(raw);
    // Never let an invented number reach the user: figures must literally
    // appear in what the model was shown (title + body/snippet).
    const shown = `${article.title || ''}\n${summaryContent(article, bodyText)}`;
    parsed.key_figures = groundKeyFigures(parsed.key_figures, shown);
    return parsed;
}

