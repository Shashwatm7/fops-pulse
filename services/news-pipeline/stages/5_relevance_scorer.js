import { maskPhrases } from './3_rule_engine.js';

// Supply-chain DISRUPTOR lexicon, tiered by how hard the event hits flows.
// SEVERE = a physical/geopolitical shock that stops or diverts goods now
// (this is what a procurement desk must see first). MODERATE = friction that
// raises cost or delays but rarely halts. Matched as whole words/phrases.
export const SEVERE_DISRUPTORS = [
    'attack', 'attacks', 'attacked', 'strike', 'strikes', 'blockade', 'blockaded',
    'war', 'conflict', 'missile', 'drone', 'seized', 'seize', 'sabotage', 'hijack',
    'hijacked', 'embargo', 'explosion', 'blast', 'shutdown', 'shut down', 'closure',
    'closed', 'halt', 'halted', 'suspended', 'force majeure', 'invasion', 'airstrike',
    'bombing', 'militant', 'houthi', 'escalation', 'escalate', 'blast', 'shelling',
];
export const MODERATE_DISRUPTORS = [
    'disruption', 'disrupt', 'disrupted', 'delay', 'delays', 'delayed', 'reroute',
    'rerouting', 'rerouted', 'diverted', 'congestion', 'shortage', 'ban', 'banned',
    'sanction', 'sanctions', 'tariff', 'tariffs', 'export ban', 'import ban',
    'protest', 'unrest', 'strike action', 'backlog', 'chokepoint',
];

/**
 * Disruption-severity score (0-40), title-weighted. Additive on top of the
 * commodity/business/region signal so genuine supply-chain shocks (attacks,
 * blockades, port closures) outrank routine commodity chatter. Returns the
 * numeric boost plus whether a SEVERE term was present (drives the
 * commodity-less cap relaxation below).
 */
export function disruptionSeverity(title, body, hasTerm) {
    let boost = 0;
    let severe = false;
    for (const term of SEVERE_DISRUPTORS) {
        if (hasTerm(title, term)) { boost += 20; severe = true; }
        else if (hasTerm(body, term)) { boost += 8; severe = true; }
    }
    for (const term of MODERATE_DISRUPTORS) {
        if (hasTerm(title, term)) boost += 8;
        else if (hasTerm(body, term)) boost += 3;
    }
    return { boost: Math.min(40, boost), severe };
}

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

    // 4. Disruption severity (Max 40) — attacks, blockades, port closures,
    // sanctions etc. A supply-chain shock is the highest-value signal for a
    // procurement desk, so it is scored explicitly rather than left to
    // incidental business-term overlap.
    const { boost: disruptionScore, severe: hasSevereDisruptor } = disruptionSeverity(title, body, hasExactTerm);
    score += disruptionScore;

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
    //
    // EXCEPTION: a SEVERE disruptor (attack/blockade/war) hitting one of the
    // user's tracked regions is materially different from a generic think-
    // piece — it can halt delivered supply regardless of which commodity is
    // named. Those are allowed to reach Critical (raised cap 90); everything
    // else commodity-less stays capped at 55.
    if (commodityScore === 0) {
        const cap = (hasSevereDisruptor && regionScore > 0) ? 90 : 55;
        score = Math.min(score, cap);
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
            regionScore,
            disruptionScore,
        }
    };
}
