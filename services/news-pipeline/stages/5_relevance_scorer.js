import { maskPhrases } from './3_rule_engine.js';

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

    // 1. Commodity Match (Max 45) — same metaphor masking as the rule engine,
    // so "went platinum"/"gold rush" phrases can't earn commodity points here
    // after failing to earn them in stage 3.
    const maskedTitle = maskPhrases(title, profile.maskedPhrases);
    const maskedBody = maskPhrases(body, profile.maskedPhrases);
    profile.primaryTerms.forEach(term => {
        if (hasExactTerm(maskedTitle, term)) score += 30;
        else if (hasExactTerm(maskedBody, term)) score += 15;
    });

    profile.relatedTerms.forEach(term => {
        if (hasExactTerm(maskedTitle, term)) score += 15;
        else if (hasExactTerm(maskedBody, term)) score += 5;
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
    const isGlobalProfile = profile.regionAliases.includes('global') || profile.regionAliases.length === 0;
    // If it's a global profile, give a baseline region score
    if (isGlobalProfile) {
        regionScore = 15;
    }
    regionScore = Math.min(25, regionScore);
    score += regionScore;

    // Region-miss penalty: the article got here without mentioning any of the
    // user's regions (stage 4 soft pass for tracked-commodity news). It stays
    // eligible, but geo-matched articles must always outrank it.
    if (!isGlobalProfile && regionScore === 0) {
        score -= 10;
    }

    // Commodity-less cap: a macro article with zero tracked-commodity terms
    // can be context, never a headline alert. Without this cap, generic
    // "supply chain disruption in <region>" think-pieces scored up to 65
    // (business 40 + region 25) and alerted as Medium with no commodity
    // relevance at all — the verified "Khamenei cold storage" FP class.
    if (commodityScore === 0) {
        score = Math.min(score, 55);
    }

    // Note: no excluded-context penalty here. Stage 3 (rule engine) already
    // hard-rejects any article containing an excluded term (checked against
    // fullTextNorm, a superset of title+body), so any article that reaches
    // this scorer is guaranteed to have zero excluded terms — a penalty pass
    // would always compute 0. Removed as dead code.

    const finalScore = Math.max(0, Math.min(100, score));

    return {
        score: finalScore,
        breakdown: {
            commodityScore,
            businessScore,
            regionScore
        }
    };
}
