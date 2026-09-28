/**
 * Stage 3: Rule Engine
 * Hard rejections for articles that don't meet minimum basic criteria.
 * Very fast boolean checks to save compute down the line.
 */

// Helper to check for exact word match to avoid substring false positives (e.g., 'trademark' matching 'trade')
const hasExactTerm = (fullText, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(fullText);
};

/**
 * Masks metaphor phrases so commodity words inside them can't produce false
 * matches: "SpaceX supply chain gold rush" must not count as a GOLD mention,
 * but a real bullion article that ALSO says "gold rush" still matches on its
 * other "gold" occurrences. Masking (not hard-excluding) keeps that recall.
 */
export function maskPhrases(text, phrases) {
    if (!phrases || phrases.length === 0) return text;
    let masked = text;
    for (const p of phrases) {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        masked = masked.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' § ');
    }
    return masked;
}

// Idiomatic phrases that contain a culinary blocklist word but are NOT about
// cooking — "a recipe for rising flour prices", "cooking up a trade deal".
// These are masked BEFORE the excluded-context check so the idiom can't trip
// the blocklist and kill a genuine commodity/supply article. A real culinary
// piece ("chicken recipe", "how to cook") still trips it — the standalone
// word survives masking.
const CULINARY_IDIOMS = ['recipe for', 'recipes for', 'cooking up', 'cook up', 'cooking the books', 'cooking with gas'];

// Commodity phrases that happen to CONTAIN a culinary blocklist word. The
// fallback profile blocks the bare word "cooking", which killed "Palm oil
// export levy raised, lifting cooking oil costs" — an edible-oils price story,
// and about as on-topic as news gets for a food manufacturer. Masking the
// phrase (rather than removing "cooking" from the blocklist) keeps a genuine
// "cooking tips" piece rejected while letting the commodity sense through.
const COMMODITY_CULINARY_PHRASES = [
    'cooking oil', 'cooking oils', 'cooking fat', 'cooking fats',
    'baking flour', 'baking fats',
];

export function maskIdioms(text) {
    let t = text;
    for (const p of [...CULINARY_IDIOMS, ...COMMODITY_CULINARY_PHRASES]) {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' § ');
    }
    return t;
}

/**
 * Blocked topics are topic LABELS, not quotations. Matching them as literal
 * adjacent phrases made every multi-word entry dead on arrival: a profile
 * blocking "tourism leisure" needs those two words side by side, which no
 * real headline writes, so "Dubai hotel occupancy climbs as tourism picks up"
 * passed a blocklist that explicitly named tourism. Same for "real estate
 * residential" against "residential real estate" — right words, wrong order.
 *
 * So: the verbatim phrase still matches, and failing that, a multi-word topic
 * matches when every one of its words appears somewhere in the article. That
 * makes word order irrelevant without loosening single-word topics at all.
 * Words of 1-2 characters are ignored so a stray "of"/"in" cannot carry a
 * match on its own.
 */
export function hasBlockedTopic(fullText, topic) {
    if (hasExactTerm(fullText, topic)) return true;
    const words = String(topic).split(/\s+/).filter(w => w.length > 2);
    if (words.length < 2) return false; // single-word topic already tested above
    return words.every(w => hasExactTerm(fullText, w));
}

export function applyRuleEngine(normArticle, profile) {
    const text = normArticle.fullTextNorm;
    const matchData = {
        commodityMatches: [],
        businessMatches: [],
        regionMatches: []
    };

    // 1. Must NOT have excluded contexts. Idioms are masked first so
    // "a recipe for rising prices" doesn't trip the culinary blocklist.
    const exclusionText = maskIdioms(text);
    const excludedMatch = profile.excludedContexts.find(term => hasBlockedTopic(exclusionText, term));
    if (excludedMatch) {
        return { passed: false, reason: `Matched excluded context: ${excludedMatch}`, matchData };
    }

    // 2. Business terms
    const businessMatch = profile.businessTerms.filter(term => hasExactTerm(text, term));
    matchData.businessMatches = businessMatch;

    // 3. Commodity terms (Primary OR Related) — matched against the
    // metaphor-masked text so "gold rush"/"corn maze" don't count as
    // commodity mentions.
    const commodityText = maskPhrases(text, profile.maskedPhrases);
    const commodityMatch = [...profile.primaryTerms, ...profile.relatedTerms].filter(term => hasExactTerm(commodityText, term));
    matchData.commodityMatches = commodityMatch;

    if (commodityMatch.length === 0 && profile.primaryTerms.length > 0) {
        // Relaxed rule: If it lacks a specific commodity but has MULTIPLE strong macro/business terms, allow it
        if (businessMatch.length < 2) {
            return { passed: false, reason: 'No commodity terms found and insufficient business relevance', matchData };
        }
    } else if (businessMatch.length === 0 && profile.businessTerms.length > 0) {
        // If it HAS a commodity match, but NO business terms, we will STILL let it pass to the Scorer (Stage 5)!
        // Because the scorer will penalize it, but it might still be relevant if it has strong commodity matching.
        // We only reject here if it has NO commodity AND NO business terms.
        if (commodityMatch.length === 0) {
            return { passed: false, reason: 'No business/economic terms found', matchData };
        }
    }

    return { passed: true, reason: 'Passed basic rules', matchData };
}
