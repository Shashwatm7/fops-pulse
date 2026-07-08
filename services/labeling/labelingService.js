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
    'You are a supply chain intelligence analyst for a food-service distributor. You label news articles for ML training and generate insights for demand/supply planners and a supply chain director. Return ONLY valid JSON. No explanation, no markdown, no backticks.';

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
    "headline": "one line, plain english, specific to this distributor",
    "what": "what happened",
    "where": "geography affected",
    "when": "is this happening now or forecast",
    "duration": "how long this likely lasts",
    "commodities_affected": [only items from the distributor's commodity list],
    "routes_affected": [only items from the distributor's route list],
    "ports_affected": [only items from the distributor's port list],
    "supplier_countries": [affected supplier countries],
    "urgency": "immediate" | "this_week" | "monitor" | "informational",
    "action_required": true or false,
    "action_note": "one sentence: what the team should do, or null"
  }
}

Rules: "relevant" is 1 only if the article genuinely affects this distributor's supply, demand, price, trade, weather, or logistics. Marketing, sports, lifestyle are 0. severity reflects business impact to THIS distributor. confidence reflects your certainty. Only list commodities/routes/ports that appear in the distributor's profile above.`;
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
        const raw = await client(SYSTEM_PROMPT, user, 700);
        return JSON.parse(raw);
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
