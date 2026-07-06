/**
 * Stage 5: Relevance Scorer
 * Calculates a 0-100 score based on weighted features.
 */
export function calculateRelevanceScore(normArticle, profile, matchData) {
    let score = 0;
    const title = normArticle.titleNorm;
    const body = normArticle.descNorm + " " + normArticle.contentNorm;

    const hasExactTerm = (fullText, term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(fullText);
    };

    // 1. Commodity Match (Max 45)
    profile.primaryTerms.forEach(term => {
        if (hasExactTerm(title, term)) score += 30;
        else if (hasExactTerm(body, term)) score += 15;
    });

    profile.relatedTerms.forEach(term => {
        if (hasExactTerm(title, term)) score += 15;
        else if (hasExactTerm(body, term)) score += 5;
    });

    // Cap commodity score
    let commodityScore = Math.min(45, score);
    score = commodityScore;

    // 2. Business Context (Max 40)
    const matchedCategories = new Set();
    profile.businessTerms.forEach(term => {
        if (hasExactTerm(title, term) || hasExactTerm(body, term)) {
            matchedCategories.add(term);
        }
    });
    const businessScore = Math.min(40, matchedCategories.size * 10);
    score += businessScore;

    // 3. Region Match (Max 25)
    let regionScore = 0;
    profile.regionAliases.forEach(region => {
        if (hasExactTerm(title, region)) regionScore += 25;
        else if (hasExactTerm(body, region)) regionScore += 10;
    });
    // If it's a global profile, give a baseline region score
    if (profile.regionAliases.includes('global') || profile.regionAliases.length === 0) {
        regionScore = 15; 
    }
    score += Math.min(25, regionScore);

    // 4. Negative Weights (Penalties)
    let penalty = 0;
    profile.excludedContexts.forEach(term => {
        if (hasExactTerm(title, term)) penalty += 50;
        else if (hasExactTerm(body, term)) penalty += 20;
    });
    score -= penalty;

    const finalScore = Math.max(0, Math.min(100, score));

    return {
        score: finalScore,
        breakdown: {
            commodityScore,
            businessScore,
            regionScore,
            penalty
        }
    };
}
