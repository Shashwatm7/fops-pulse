// LLM article labeling. Provider-agnostic via LLM_PROVIDER (groq | anthropic),
// swappable with one env var and no code change. Uses axios directly so no
// vendor SDK dependency is required.
import axios from 'axios';
import { labelingConfig as cfg } from '../../config/labeling.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

const SYSTEM_PROMPT =
    'You are a supply chain intelligence analyst for a food-service distributor. You label news articles for ML training and generate insights for demand/supply planners and a supply chain director — readers who already know the industry and need the specific fact from THIS article, not a generic restatement of the headline. Return ONLY valid JSON. No explanation, no markdown, no backticks.';

// Build a compact customer-context block so labels are grounded in the
// distributor's actual ports/routes/products/suppliers (DB-driven, not
// hardcoded). Falls back to generic when no customer is attached.
function customerBlock(customer) {
    if (!customer) return 'Distributor profile: general food-service importer in the GCC.';
    const j = (v) => (Array.isArray(v) ? v.join(', ') : (v || ''));
    return `Distributor: ${customer.company} (${customer.region})
  Key ports: ${j(customer.key_ports)}
  Key routes: ${j(customer.key_routes)}
  Commodities: ${j(customer.commodities)}
  Supplier countries: ${j(customer.supplier_countries)}
  Customers: ${j(customer.customer_segments)}`;
}

function userPrompt(snippet, customer) {
    return `Label this article for the distributor below.

${customerBlock(customer)}

Article: ${snippet}

Return EXACTLY this JSON shape:
{
  "training": {
    "relevant": 0 or 1,
    "category": one of [${cfg.categories.join(', ')}],
    "severity": "critical" | "high" | "medium" | "low",
    "confidence": 0.0 to 1.0
  },
  "insights": {
    "headline": "one line, plain english, specific to this distributor — must include a fact from the article body, not just the article's own headline reworded",
    "what": "2-3 sentences pulling the concrete facts from the article: numbers, dates, named companies/officials/vessels/ports, volumes, percentages. If the article genuinely has none of these, say so plainly instead of restating the headline in different words.",
    "where": "geography affected — specific country/port/route, not just 'the region'",
    "when": "is this happening now or forecast — with the actual date/timeframe if stated",
    "duration": "how long this likely lasts, grounded in what the article says (e.g. contract length, season, distance/speed if a shipping delay) — not a generic guess",
    "commodities_affected": [ONLY commodities the article explicitly names or that are unmistakably and directly affected. NOT the whole list. A broad macro story is not grounds to list everything — leave empty if nothing specific is named],
    "routes_affected": [ONLY routes the article explicitly names or directly implicates — empty if none named],
    "ports_affected": [ONLY ports the article explicitly names or directly implicates — empty if none named],
    "supplier_countries": [ONLY supplier countries the article explicitly names — empty if none named],
    "key_dates": ["specific dates or timeframes stated in the article, each with what happens then, e.g. 'Aug 1: tariff takes effect'"],
    "key_figures": ["specific numbers stated in the article — prices, percentages, volumes — each with its meaning, e.g. 'wheat -4.2% this week'"],
    "urgency": "immediate" | "this_week" | "monitor" | "informational",
    "action_required": true or false,
    "action_note": "one concrete, specific action tied to what this article actually says (e.g. 'Confirm alternate poultry supplier for the 3-week Brazil export halt'), or null. Never generic advice like 'monitor the situation' or 'stay informed'."
  }
}

Rules: "relevant" is 1 only if the article genuinely affects this distributor's supply, demand, price, trade, weather, or logistics. Marketing, sports, lifestyle are 0. severity reflects business impact to THIS distributor. confidence reflects your certainty. For commodities_affected/routes_affected/ports_affected/supplier_countries: list an item ONLY if the article explicitly names it or unambiguously and directly implicates it. A general macro story (food inflation, regional tension, currency moves) is NOT grounds to list every item in the profile — when nothing specific is named, return an empty array. Listing the entire profile list is wrong. key_dates and key_figures must only contain values explicitly stated in the article — use empty arrays if none, never invent numbers or dates. Do not use generic filler ("could impact the market", "monitor the situation", "remains to be seen") anywhere in the output — every sentence must carry a specific fact from this article.`;
}

// Cheap, zero-LLM-cost entity extraction: regex-match the customer's own
// profile lists against the article text. Feeding these into the summary
// prompt (instead of asking Groq to find them) keeps the prompt short and
// the extraction free.
export function extractLocalEntities(text, customer) {
    const hay = (text || '').toLowerCase();
    const matchAll = (list) => (Array.isArray(list) ? list : [])
        .filter(term => term && hay.includes(String(term).toLowerCase()));
    return {
        commodities: matchAll(customer?.commodities),
        ports: matchAll(customer?.key_ports),
        routes: matchAll(customer?.key_routes),
        supplier_countries: matchAll(customer?.supplier_countries),
    };
}

const BANNED_PHRASES = [
    'could impact the market', 'may affect prices', 'monitor the situation',
    'keep an eye on', 'stay informed', 'could have implications',
    'it is important to', 'in the coming days/weeks', 'remains to be seen',
];

// Bump when the prompt/output shape changes so the URL cache regenerates
// instead of serving summaries written by an older, thinner prompt.
export const SUMMARY_VERSION = 'v2';

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

Ground every field strictly in the supplied article text and entity list; never invent numbers, dates, or affected entities. Banned phrases (and close paraphrases): ${BANNED_PHRASES.join('; ')}.`;

function summaryPrompt(article, entities, customer, bodyText) {
    const j = (v) => (v && v.length ? v.join(', ') : 'none detected');
    // Prefer real stripped article body; fall back to the RSS snippet.
    const content = (bodyText && bodyText.length > 120)
        ? bodyText
        : (article.description || '').slice(0, 800) || '(no body text could be retrieved — summarize only what the title implies and state that figures are unavailable)';
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

/**
 * On-demand click-to-summarize for a single article. Distinct from label()
 * above: no training/category output, meant to be cached by caller
 * (article_summary_cache) rather than run at scan time. Pass bodyText (the
 * locally-stripped article body from fetchArticleText) so the model has real
 * content to work with instead of the thin RSS snippet.
 * @returns {Promise<{summary: string, impact: string, action_note: string|null, key_figures: string[]}>}
 */
export async function summarizeArticle(article, entities, customer = null, bodyText = null) {
    const client = makeClient();
    const raw = await client(SUMMARY_SYSTEM_PROMPT, summaryPrompt(article, entities, customer, bodyText), 700);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.key_figures)) parsed.key_figures = [];
    return parsed;
}

function validate(obj) {
    const t = obj?.training, i = obj?.insights;
    if (!t || !i) return false;
    if (t.relevant !== 0 && t.relevant !== 1) return false;
    if (typeof t.category !== 'string') return false;
    if (!cfg.severities.includes(t.severity)) return false;
    if (typeof t.confidence !== 'number') return false;
    if (typeof i.headline !== 'string') return false;
    return true;
}

// Defensive clamp against "macro dump": when a broad story makes the model
// list most/all of the profile's commodities/ports/routes, that's noise, not
// signal. If an affected-list covers >=70% of the corresponding profile list
// (and that list is non-trivial), blank it — the article named nothing
// specific. Also drops any hallucinated item not in the profile.
function clampAffected(insights, customer) {
    if (!insights || !customer) return insights;
    const rules = [
        ['commodities_affected', customer.commodities],
        ['routes_affected', customer.key_routes],
        ['ports_affected', customer.key_ports],
        ['supplier_countries', customer.supplier_countries],
    ];
    for (const [field, profileList] of rules) {
        const got = Array.isArray(insights[field]) ? insights[field] : null;
        const profile = Array.isArray(profileList) ? profileList : [];
        if (!got || profile.length === 0) continue;
        const lower = new Set(profile.map(x => String(x).toLowerCase()));
        const inProfile = got.filter(x => lower.has(String(x).toLowerCase()));
        insights[field] = (profile.length >= 4 && inProfile.length >= Math.ceil(profile.length * 0.7))
            ? [] // covers most of the catalog → macro dump, not specific
            : inProfile;
    }
    return insights;
}

/**
 * Label one article snippet.
 * @returns {Promise<{result: object|null, needsReview: boolean, error?: string}>}
 */
export async function label(snippet, customer = null) {
    const client = makeClient();
    await sleep(100); // gentle spacing to avoid burst rejections

    const attempt = async (strict) => {
        const user = strict
            ? userPrompt(snippet, customer) + '\n\nCRITICAL: your previous reply was not valid JSON. Return ONLY the raw JSON object, nothing else.'
            : userPrompt(snippet, customer);
        // 1000: key_dates/key_figures arrays plus the now-longer "what" field
        // need headroom beyond the original 700 or the JSON truncates mid-field.
        const raw = await client(SYSTEM_PROMPT, user, 1000);
        const parsed = JSON.parse(raw);
        if (parsed?.insights) parsed.insights = clampAffected(parsed.insights, customer);
        return parsed;
    };

    for (let tries = 0; tries < 2; tries++) {
        try {
            const parsed = await attempt(tries === 1);
            if (validate(parsed)) return { result: parsed, needsReview: false };
            // parsed but missing fields → force review, don't trust it
            return { result: parsed, needsReview: true, error: 'Incomplete label structure' };
        } catch (err) {
            const status = err.response?.status;
            if (status === 429) {
                console.warn('[LABELING] 429 rate limit — waiting 60s then retrying once');
                await sleep(60000);
                try {
                    const parsed = await attempt(false);
                    if (validate(parsed)) return { result: parsed, needsReview: false };
                    return { result: parsed, needsReview: true, error: 'Incomplete after 429 retry' };
                } catch (e2) {
                    return { result: null, needsReview: true, error: `429 retry failed: ${e2.message}` };
                }
            }
            if (tries === 1) {
                return { result: null, needsReview: true, error: `Parse/label failed: ${err.message}` };
            }
            // else loop once more (the strict retry)
        }
    }
    return { result: null, needsReview: true, error: 'Exhausted retries' };
}
