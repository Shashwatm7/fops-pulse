/**
 * Stage 4: Region Matcher
 * Determines if the article relates to the user's selected regions.
 */
export function matchRegion(normArticle, profile) {
    const text = normArticle.fullTextNorm;
    const regionMatches = [];

    // Word-boundary match so a region alias like "india" does not match
    // inside "indiana"/"indianapolis". Mirrors the helper used in stages 3 & 5.
    const hasExactTerm = (fullText, term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(fullText);
    };

    // If profile has no specific regions or just "Global", pass automatically
    if (profile.regionAliases.length === 0 || profile.regionAliases.includes("global")) {
        return { passed: true, regionMatches: ['Global'] };
    }

    for (const region of profile.regionAliases) {
        if (hasExactTerm(text, region)) {
            regionMatches.push(region);
        }
    }

    // Strict Filtering: Must match at least one region alias
    if (regionMatches.length === 0) {
        return { passed: false, reason: "No region match" };
    }
    
    return { passed: true, regionMatches };
}
