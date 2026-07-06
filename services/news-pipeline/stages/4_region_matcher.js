/**
 * Stage 4: Region Matcher
 * Determines if the article relates to the user's selected regions.
 */
export function matchRegion(normArticle, profile) {
    const text = normArticle.fullTextNorm;
    const regionMatches = [];

    // If profile has no specific regions or just "Global", pass automatically
    if (profile.regionAliases.length === 0 || profile.regionAliases.includes("global")) {
        return { passed: true, regionMatches: ['Global'] };
    }

    for (const region of profile.regionAliases) {
        // Use word boundaries for accurate matching if possible, or simple includes
        if (text.includes(region)) {
            regionMatches.push(region);
        }
    }

    // Strict Filtering: Must match at least one region alias
    if (regionMatches.length === 0) {
        return { passed: false, reason: "No region match" };
    }
    
    return { passed: true, regionMatches };
}
