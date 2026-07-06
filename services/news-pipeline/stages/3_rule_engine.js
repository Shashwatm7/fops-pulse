/**
 * Stage 3: Rule Engine
 * Hard rejections for articles that don't meet minimum basic criteria.
 * Very fast boolean checks to save compute down the line.
 */
export function applyRuleEngine(normArticle, profile) {
    const text = normArticle.fullTextNorm;
    const matchData = {
        commodityMatches: [],
        businessMatches: [],
        regionMatches: []
    };

    // Helper to check for exact word match to avoid substring false positives (e.g., 'trademark' matching 'trade')
    const hasExactTerm = (fullText, term) => {
        // Escape special regex chars just in case, though mostly they are words
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(fullText);
    };

    // 1. Must NOT have excluded contexts
    const excludedMatch = profile.excludedContexts.find(term => hasExactTerm(text, term));
    if (excludedMatch) {
        return { passed: false, reason: `Matched excluded context: ${excludedMatch}`, matchData };
    }

    // 2. Business terms
    const businessMatch = profile.businessTerms.filter(term => hasExactTerm(text, term));
    matchData.businessMatches = businessMatch;

    // 3. Commodity terms (Primary OR Related)
    const commodityMatch = [...profile.primaryTerms, ...profile.relatedTerms].filter(term => hasExactTerm(text, term));
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
    matchData.businessMatches = businessMatch;

    return { passed: true, reason: 'Passed basic rules', matchData };
}
