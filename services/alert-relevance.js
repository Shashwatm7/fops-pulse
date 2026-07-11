// ── Event × Exposure alert relevance scoring ────────────────────────
// An event is not an alert. It becomes an alert for a specific user when
// that user's tracked commodities/regions are exposed to it. Scoring is
// fully deterministic — no LLM cost, runs on every scanned event.
//
// Score = commodity exposure (0-40) + region exposure (0-30)
//       + event class weight (0-20) + recency (0-10)
//
// Severity is derived from the score, so the same world event can be
// CRITICAL for a GCC frozen-foods planner and invisible to a US metals
// desk. Systemic events (chokepoints, export bans) pass without a direct
// profile match because they move freight costs for everyone; everything
// else requires real exposure.

const CATEGORY_WEIGHTS = {
    'Trade Policy': 20,
    'Maritime Chokepoint': 18,
    'Maritime Security': 18,
    'Armed Conflict': 16,
    'Livestock Pandemic': 16,
    'Agricultural Crisis': 15,
    'Energy Supply': 12,
    'Energy Infrastructure': 12,
    'Labor Disruption': 12,
    'Natural Disaster': 10,
    'Political Instability': 8,
};

// Events at or above this class weight affect global freight/trade broadly
// enough to alert even without a direct commodity/region match.
const SYSTEMIC_CLASS_WEIGHT = 18;

// Chokepoints mapped to the region focuses they most affect. A Red Sea
// disruption is a supply event for GCC importers even when the article
// never names their country.
const CHOKEPOINT_EXPOSURE = [
    { pattern: /(strait\s+of\s+hormuz|bab.el.mandeb|red\s+sea|suez)/i, regions: ['middle east', 'gcc', 'gulf', 'saudi', 'uae', 'qatar', 'kuwait', 'bahrain', 'oman', 'egypt', 'jordan'] },
    { pattern: /(panama\s+canal)/i, regions: ['america', 'usa', 'latin', 'brazil', 'argentina'] },
    { pattern: /(strait\s+of\s+malacca|south\s+china\s+sea)/i, regions: ['asia', 'china', 'india', 'japan', 'korea', 'vietnam', 'indonesia'] },
    { pattern: /(black\s+sea)/i, regions: ['europe', 'middle east', 'ukraine', 'russia', 'turkey', 'egypt'] },
];

// Category → commodity classes it implicates, for events that do not name
// a commodity (a bird-flu outbreak matters iff the user tracks protein).
const CATEGORY_COMMODITY_HINTS = {
    'Livestock Pandemic': ['live cattle', 'feeder cattle', 'lean hogs', 'class iii milk', 'milk'],
    'Agricultural Crisis': ['wheat', 'corn', 'soybeans', 'rice', 'oats', 'sugar', 'coffee', 'cocoa', 'frozen orange juice', 'orange juice'],
    'Energy Supply': ['brent crude oil', 'brent crude', 'natural gas'],
    'Energy Infrastructure': ['brent crude oil', 'brent crude', 'natural gas'],
};

export function normalizeTerm(value) {
    return String(value || '').toLowerCase().replace(/_/g, ' ').trim();
}

function matchAny(text, terms) {
    const found = [];
    for (const term of terms) {
        if (!term) continue;
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) found.push(term);
    }
    return found;
}

/**
 * Score a single event against a single user profile.
 * @param {{text: string, category?: string, publishedAt?: string|Date}} event
 * @param {object} profile user_profiles row
 * @returns {{score: number, matchedCommodities: string[], matchedRegions: string[], breakdown: object}}
 *          score is 0 when the event is not relevant enough to alert this user.
 */
export function scoreAlertExposure(event, profile) {
    const text = String(event.text || '');
    const commodityTerms = [...new Set((profile.commodities || []).map(normalizeTerm))];
    const regionTerms = [...new Set([
        ...(profile.regions || []),
        profile.focus_region,
        ...((profile.custom_regions || []).map(r => (typeof r === 'string' ? r : r?.name))),
        ...(profile.focus_countries || []),
    ].filter(Boolean).map(normalizeTerm))];

    // 1) Commodity exposure (0-40)
    const matchedCommodities = matchAny(text, commodityTerms);
    let commodityScore = matchedCommodities.length
        ? Math.min(40, 25 + (matchedCommodities.length - 1) * 5)
        : 0;
    if (!commodityScore && CATEGORY_COMMODITY_HINTS[event.category]) {
        const implicated = CATEGORY_COMMODITY_HINTS[event.category].filter(h => commodityTerms.includes(h));
        if (implicated.length > 0) commodityScore = 18;
    }

    // 2) Region exposure (0-30)
    const matchedRegions = matchAny(text, regionTerms);
    let regionScore = matchedRegions.length
        ? Math.min(30, 18 + (matchedRegions.length - 1) * 4)
        : 0;
    for (const chokepoint of CHOKEPOINT_EXPOSURE) {
        if (!chokepoint.pattern.test(text)) continue;
        const exposed = regionTerms.some(rt => chokepoint.regions.some(cr => rt.includes(cr) || cr.includes(rt)));
        if (exposed) regionScore = Math.max(regionScore, 24);
    }

    // 3) Event class weight (0-20)
    const classScore = CATEGORY_WEIGHTS[event.category] ?? 10;

    // 4) Recency (0-10)
    let recencyScore = 2;
    const publishedMs = new Date(event.publishedAt || 0).getTime();
    if (!Number.isNaN(publishedMs) && publishedMs > 0) {
        const ageHours = (Date.now() - publishedMs) / 3.6e6;
        recencyScore = ageHours <= 6 ? 10 : ageHours <= 24 ? 6 : 2;
    }

    // Non-systemic events require actual profile exposure.
    const systemic = classScore >= SYSTEMIC_CLASS_WEIGHT;
    if (!systemic && commodityScore + regionScore === 0) {
        return { score: 0, matchedCommodities, matchedRegions, breakdown: { commodityScore, regionScore, classScore, recencyScore, filtered: 'no profile exposure' } };
    }

    return {
        score: commodityScore + regionScore + classScore + recencyScore,
        matchedCommodities,
        matchedRegions,
        breakdown: { commodityScore, regionScore, classScore, recencyScore },
    };
}

/** Map an exposure score to alert severity; null = below alert threshold. */
export function severityFromScore(score) {
    if (score >= 70) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return null;
}

/** Map the news-pipeline priority buckets to alert severities. */
export function severityFromPriority(priority) {
    const map = { Critical: 'CRITICAL', High: 'HIGH', Medium: 'MEDIUM', Low: 'LOW' };
    return map[priority] || 'MEDIUM';
}

// Scarcity quota: an "alert" should be rare and worth acting on, not every
// qualifying article. At most 1 CRITICAL, 2 HIGH, 1 MEDIUM are ever shown —
// LOW never surfaces. Applied across ALL alerts combined (news + price
// anomaly), so the user sees at most 4 alerts total at any time.
export const ALERT_QUOTA = { CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 0 };

/**
 * Select the alerts to actually show, enforcing ALERT_QUOTA per severity.
 * Input should be pre-sorted by importance/recency (freshest or highest-
 * relevance first) — for each severity we keep the first `quota[severity]`
 * and drop the rest. Anything with a severity not in the quota (or over its
 * cap, incl. all LOW) is dropped. Pure/deterministic for testability.
 * @param {Array<{severity:string}>} alerts
 * @returns {Array} the kept alerts, in the same relative order as the input
 */
export function applyAlertQuota(alerts, quota = ALERT_QUOTA) {
    const counts = {};
    const out = [];
    for (const a of alerts || []) {
        const sev = a?.severity;
        const cap = quota[sev] ?? 0;
        const used = counts[sev] || 0;
        if (used < cap) {
            counts[sev] = used + 1;
            out.push(a);
        }
    }
    return out;
}
