/**
 * Stage 4: Region Matcher
 * Determines if the article relates to the user's selected regions.
 *
 * Region is a HARD gate only for articles with no tracked-commodity match
 * (macro/business stories must be about the user's geography to matter).
 * Articles about a commodity the user actually tracks pass WITHOUT a region
 * mention — commodity markets are global, and "Lean hog futures drop on weak
 * Chinese demand" is relevant to a lean-hogs user everywhere. The scorer
 * (stage 5) penalizes the missing region instead, so geo-matched news still
 * outranks it.
 */
export function matchRegion(normArticle, profile, matchData = null) {
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

    if (regionMatches.length === 0) {
        // Soft pass: tracked-commodity news is relevant regardless of geography.
        const hasCommodityMatch = matchData && Array.isArray(matchData.commodityMatches) && matchData.commodityMatches.length > 0;
        if (hasCommodityMatch) {
            return { passed: true, regionMatches: [], softPass: true };
        }
        // Hard gate for macro/no-commodity articles: wrong geography = noise.
        return { passed: false, reason: "No region match" };
    }

    return { passed: true, regionMatches };
}
