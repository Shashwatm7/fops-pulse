// Planner recommendation engine — ported from the old Python FastAPI
// microservice (ai_service/planner.py). This module is PURE: it does the
// regex extraction, news ranking, and prompt/context construction, then
// hands the finished (systemPrompt, contextBundle) pair back to the caller.
// The actual LLM call is done by server.js's callGroq() (Groq 70B → Gemini →
// Groq 8B failover), so we no longer maintain a second HTTP client / key
// rotation / failover chain here.

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Commodity codes are stored as UPPER_SNAKE (e.g. LIVE_CATTLE, ORANGE_JUICE).
// News text uses spaces ("live cattle"), so normalize underscores to spaces
// or these never match. Also splits on "/" and "," and lowercases.
function normalizeTerms(values) {
    const terms = [];
    for (const value of values || []) {
        if (!value) continue;
        for (const part of String(value).replace(/\//g, ',').split(',')) {
            const term = part.trim().toLowerCase().replace(/_/g, ' ');
            if (term && !terms.includes(term)) terms.push(term);
        }
    }
    return terms;
}

// Word-boundary match so "rice" does not match inside "prices" and "corn"
// does not match inside "popcorn". escapeRegExp handles multi-word phrases
// like "live cattle" and any regex-special characters.
function matchesAny(text, terms) {
    return (terms || []).filter(term => term && new RegExp(`\\b${escapeRegExp(term)}\\b`).test(text));
}

function extractValues(text) {
    const patterns = [
        /\$\s?\d+(?:\.\d+)?(?:\s?(?:billion|million|bn|mn|k))?/gi,
        /\b\d+(?:\.\d+)?\s?%/gi,
        /\b\d+(?:\.\d+)?\s?(?:days?|weeks?|months?|years?|tonnes?|tons?|barrels?|bpd|mt|kg|km|miles?)\b/gi,
        /\b(?:Q[1-4]|20\d{2}|19\d{2})\b/gi,
    ];
    const values = [];
    for (const pattern of patterns) {
        const matches = text.match(pattern) || [];
        for (const m of matches) values.push(m);
    }
    // Dedup preserving order, trim, cap 5
    const seen = new Set();
    const out = [];
    for (const v of values) {
        const t = v.trim();
        if (t && !seen.has(t)) { seen.add(t); out.push(t); }
    }
    return out.slice(0, 5);
}

const SIGNAL_TERMS = [
    'shortage', 'surplus', 'delay', 'disruption', 'strike', 'shutdown', 'closure',
    'port', 'freight', 'shipping', 'export', 'import', 'tariff', 'sanction',
    'inventory', 'stockpile', 'production', 'harvest', 'yield', 'weather',
    'drought', 'flood', 'heat', 'demand', 'price', 'forecast', 'capacity',
    'processing', 'logistics', 'supply chain', 'procurement',
];

function extractSupplySignals(text) {
    return matchesAny(text, SIGNAL_TERMS).slice(0, 6);
}

function extractTopNewsIntelligence(news, focusProduct, userCommodities, focusRegion, userRegions, limit = 5) {
    const commodityTerms = normalizeTerms([focusProduct, ...(userCommodities || [])]);
    const regionTerms = normalizeTerms([focusRegion, ...(userRegions || [])]);
    const extracted = [];

    for (const article of news || []) {
        const title = String(article.title || '').trim();
        const description = String(article.description || article.summary || '').trim();
        const source = String(article.source || 'Unknown').trim();
        const publishedAt = String(article.publishedAt || '').trim();
        const fullText = `${title}. ${description}`.toLowerCase();

        const matchedCommodities = matchesAny(fullText, commodityTerms);
        const matchedRegions = matchesAny(fullText, regionTerms);
        const supplySignals = extractSupplySignals(fullText);
        const values = extractValues(`${title}. ${description}`);

        const hasCommodityOrRegion = matchedCommodities.length > 0 || matchedRegions.length > 0;
        if (!hasCommodityOrRegion || supplySignals.length === 0) continue;

        const relevanceScore = (matchedCommodities.length * 4) + (matchedRegions.length * 2) + supplySignals.length + values.length;
        if (relevanceScore === 0) continue;

        const usefulSnippet = (description || title).replace(/\s+/g, ' ').trim().slice(0, 280);
        extracted.push({
            score: relevanceScore,
            source,
            publishedAt,
            title: title.slice(0, 180),
            usefulInfo: usefulSnippet,
            matchedCommodities: matchedCommodities.slice(0, 4),
            matchedRegions: matchedRegions.slice(0, 4),
            supplySignals,
            values,
        });
    }

    extracted.sort((a, b) => b.score - a.score);
    return extracted.slice(0, limit);
}

// Pipeline-accepted articles (9-stage profile scanner) with NLP summaries and
// entities — the highest-confidence news signal available to the planner.
function formatAcceptedNewsInsights(insights) {
    if (!insights || insights.length === 0) return 'None available from the latest scans.';
    const lines = [];
    insights.forEach((item, idx) => {
        const entities = item.entities || {};
        const entityBits = [];
        if (entities.places && entities.places.length) entityBits.push('Places: ' + entities.places.slice(0, 4).join(', '));
        if (entities.organizations && entities.organizations.length) entityBits.push('Orgs: ' + entities.organizations.slice(0, 4).join(', '));
        if (entities.values && entities.values.length) entityBits.push('Figures: ' + entities.values.slice(0, 4).join(', '));
        lines.push(
            `${idx + 1}. [${item.severity ?? '?'}, relevance ${item.relevanceScore ?? '?'}/100] ${item.title || ''}\n` +
            `   Source: ${item.newsSource || 'Unknown'}\n` +
            `   NLP summary: ${item.summary || 'n/a'}\n` +
            `   ${entityBits.length ? entityBits.join(' | ') : 'No entities extracted'}`
        );
    });
    return lines.join('\n');
}

// The user's live exposure-scored risk alerts — the strongest distilled
// signal the platform produces. Feeding them to the LLM anchors the
// recommendations in what the system already verified matters.
function formatActiveAlerts(alerts) {
    if (!alerts || alerts.length === 0) return 'None currently active.';
    return alerts.slice(0, 8)
        .map(a => `- [${a.severity ?? '?'}] ${a.title || ''} — ${String(a.reason || '').slice(0, 170)}`)
        .join('\n');
}

function formatNewsIntelligence(extractedArticles) {
    if (!extractedArticles || extractedArticles.length === 0) return 'No locally extracted relevant news facts available.';
    const lines = [];
    extractedArticles.forEach((item, idx) => {
        lines.push(
            `${idx + 1}. Source: ${item.source} | Title: ${item.title}\n` +
            `   Useful extracted info: ${item.usefulInfo}\n` +
            `   Matched commodities: ${item.matchedCommodities.join(', ') || 'none'} | ` +
            `Matched regions: ${item.matchedRegions.join(', ') || 'none'}\n` +
            `   Supply signals: ${item.supplySignals.join(', ') || 'none'} | ` +
            `Numbers/dates: ${item.values.join(', ') || 'none'}`
        );
    });
    return lines.join('\n');
}

// Builds the (systemPrompt, contextBundle) pair for the planner LLM call.
// Returned separately so the caller runs the LLM with its own client/failover.
export function buildPlannerPrompt(payload) {
    const prices = payload.prices || {};
    const news = payload.news || [];
    const weatherExtended = payload.weatherExtended || [];

    const userProfile = payload.userProfile || {};
    const focusProduct = userProfile.focus_product || 'Commodities';
    const focusRegion = userProfile.focus_region || 'Global';
    const userCommodities = userProfile.commodities || [];
    const userRegions = payload.userRegions || [];

    const feedbackContext = payload.feedbackContext || '';
    const logisticsData = payload.logisticsData || {};

    const shortWeather = weatherExtended
        .map(w => `${w.name}: ${w.analytics?.alert ?? w.alert ?? 'NORMAL'}`)
        .join(' | ');
    const topNewsIntelligence = extractTopNewsIntelligence(news, focusProduct, userCommodities, focusRegion, userRegions);
    const topNewsIntelligenceBlock = formatNewsIntelligence(topNewsIntelligence);
    const acceptedInsightsBlock = formatAcceptedNewsInsights(payload.acceptedNewsInsights || []);
    const activeAlertsBlock = formatActiveAlerts(payload.activeAlerts || []);

    let shortPrices;
    if (Array.isArray(prices)) {
        shortPrices = prices.map(p => `${p.symbol || ''}: $${p.price ?? ''}`).join(', ');
    } else {
        shortPrices = String(prices);
    }

    const portCongestion = (logisticsData.portCongestion || [])
        .map(p => `${p.port} (${p.status})`)
        .join(', ');

    const contextBundle = `=== USER PROFILE ===
Focus Product: ${focusProduct}
Focus Region: ${focusRegion}
Tracked Commodities: ${userCommodities.join(', ')}
Tracked Regions: ${userRegions.join(', ')}

=== WEATHER & LOGISTICS ===
Dynamic Weather Data: ${shortWeather}
Port Congestion: ${portCongestion}

=== REAL-TIME DATA ===
Live Commodity Prices: ${shortPrices}

=== ACTIVE RISK ALERTS (already exposure-scored against this user's supply chain) ===
${activeAlertsBlock}

=== MARKET INTELLIGENCE ===
TIER 1 — Pipeline-Verified News Insights (each passed a 9-stage relevance
pipeline matched to this user's supply chain; NLP summaries and entities
are machine-extracted from the full article text):
${acceptedInsightsBlock}

TIER 2 — Locally Extracted Useful Info From Top Relevant News (lighter
keyword extraction from raw headlines/descriptions):
${topNewsIntelligenceBlock}
${feedbackContext}`.trim();

    const trackedCommodityScope = [focusProduct, ...userCommodities].join(', ');
    const regionScope = [focusRegion, ...userRegions].join(', ');

    const systemPrompt = `You are the senior procurement strategist for a food manufacturer. You write recommendations an S&OP planner will act on this week — not commentary.

Generate EXACTLY 4 recommendations: 2 with timeframe "90D" (tactical: hedging, forward cover, supplier moves, order timing) and 2 with "365D" (structural: sourcing geography, contract strategy, capacity).

SCOPE (MANDATORY):
- Only these commodities: ${trackedCommodityScope}. Never mention any commodity outside this list.
- Only these regions: ${regionScope}.

QUALITY BAR — a recommendation is INVALID unless it does ALL THREE:
1. CITES a specific fact from the data below — an exact price, % move, named news event with its source, weather alert, or active risk alert. Quote the number or name in the action text.
2. NAMES a concrete action with scale or trigger: verb + object + how much / by when / at what level. Good: "Book 60-day forward cover on corn while it trades near $4.55, before the +7% move reaches feed contracts." Bad: "Consider hedging corn exposure."
3. Explains WHY NOW — what in TODAY's data makes this urgent rather than evergreen good practice.

BANNED PHRASES (their presence = failed output): "diversify your portfolio", "monitor the situation", "monitor closely", "stay informed", "consider exploring", "increase market share", "enhance resilience", "mitigate risks" unless the specific risk and mechanism are named in the same sentence.

"businessImpact" must state the MECHANISM and DIRECTION, e.g. "Caps Q4 feed cost before the corn rally flows through to compound feed pricing", never "improves margins" or "reduces risk".

PRIORITIZE evidence in this order: ACTIVE RISK ALERTS (already verified relevant) > TIER 1 verified news > live prices/weather > TIER 2 news.

NO FABRICATED NUMBERS: only state a specific % or $ figure if it is EITHER copied directly from the data above, OR a straightforward arithmetic derivation you show (e.g. data says corn +7%, so "a 7% move on your feed-corn spend"). If you cannot derive a number from the data, use qualitative language ("a material share of", "meaningfully reduces") instead of inventing a precise-sounding figure like "5%" or "$50K" that isn't actually computable from what's given.

SOURCE DISCIPLINE: only attribute a claim to a named source if that source's headline/content in the data ACTUALLY supports that specific claim. Do not pair a claim with whichever source name is nearby if it doesn't genuinely support it. If you're not confident a cited source supports the claim, state the claim without naming a source rather than guessing — a wrong attribution is worse than no attribution.

MATERIALITY CHECK: before using a regional weather/alert signal to justify a GLOBAL price call, ask whether that region is actually a major global producer of that commodity (e.g. wheat: Russia/Ukraine/US/EU/India; corn: US/Brazil/Argentina; cocoa: Ivory Coast/Ghana; coffee: Brazil/Vietnam; crude: OPEC/Gulf/Russia/US). If the alert region is NOT a major producer for that commodity (e.g. a heat alert in a small growing region like Jordan Valley or a single GCC locale), do NOT claim it moves the global/futures price — instead frame the impact as LOCAL: your own regional sourcing, logistics, or delivered cost, not the world price.

CROSS-CHECK CONSISTENCY: before finalizing, verify no two of your 4 recommendations describe the same region or commodity contradictorily (e.g. calling a region "at risk" in one recommendation and "a stable, safe alternative" in another). If a region is genuinely both stressed now and a viable target once conditions ease, say so explicitly in both places rather than letting the two cards silently disagree.

Return a JSON object: {"recommendations": [...]} with exactly 4 objects, each with keys:
- "timeframe": exactly "90D" or "365D"
- "action": the recommendation (2-3 sentences max, citing the data)
- "businessImpact": one sentence, mechanism + direction`;

    return { systemPrompt, contextBundle };
}
