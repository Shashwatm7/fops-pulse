import { COMMODITY_PROFILES, REGION_ALIASES, FALLBACK_PROFILE } from '../config/profiles.js';

/**
 * Stage 2: Dynamic Watchlist Profile Builder
 * Dynamically builds a search profile based on the user's selected commodities and regions.
 */
export function buildWatchlistProfile(userProfile) {
    const profile = {
        userId: userProfile.user_id,
        primaryTerms: new Set(),
        relatedTerms: new Set(),
        regionAliases: new Set(),
        businessTerms: new Set(),
        excludedContexts: new Set()
    };

    // 1. Process Commodities
    const commodities = Array.isArray(userProfile.commodities) ? userProfile.commodities : [];
    const focusProduct = userProfile.focus_product;
    
    // Also include the focus product if it's a string
    const commodityKeys = [...commodities];
    if (focusProduct && typeof focusProduct === 'string') {
        commodityKeys.push(focusProduct);
        profile.primaryTerms.add(focusProduct.toLowerCase()); // Always add focus product explicitly
    }

    let foundCommodity = false;
    for (let key of commodityKeys) {
        // Simple mapping from internal names to display names if needed
        let searchKey = key;
        if (key === 'BRENT_CRUDE') searchKey = 'Brent Crude';
        if (key === 'NATURAL_GAS') searchKey = 'Natural Gas';
        
        const commProfile = COMMODITY_PROFILES[searchKey] || Object.values(COMMODITY_PROFILES).find(p => p.primaryTerms.includes(searchKey.toLowerCase()));
        
        if (commProfile) {
            foundCommodity = true;
            commProfile.primaryTerms.forEach(t => profile.primaryTerms.add(t.toLowerCase()));
            commProfile.relatedTerms.forEach(t => profile.relatedTerms.add(t.toLowerCase()));
            commProfile.businessTerms.forEach(t => profile.businessTerms.add(t.toLowerCase()));
            commProfile.excludedContexts.forEach(t => profile.excludedContexts.add(t.toLowerCase()));
        } else {
            // For custom commodities like 'Silver' not in the hardcoded profile
            profile.primaryTerms.add(key.toLowerCase());
        }
    }

    // Apply fallback if no specific commodity matched
    if (!foundCommodity) {
        FALLBACK_PROFILE.businessTerms.forEach(t => profile.businessTerms.add(t.toLowerCase()));
        FALLBACK_PROFILE.excludedContexts.forEach(t => profile.excludedContexts.add(t.toLowerCase()));
    }

    // ALWAYS add custom news keywords as primary terms so they bypass strict commodity filters
    if (userProfile.news_keywords && Array.isArray(userProfile.news_keywords)) {
        userProfile.news_keywords.forEach(k => profile.primaryTerms.add(k.toLowerCase()));
    }

    // 2. Process Regions
    const regions = Array.isArray(userProfile.regions) ? userProfile.regions : [];
    const focusRegion = userProfile.focus_region;
    
    const regionKeys = [...regions];
    if (focusRegion && typeof focusRegion === 'string') {
        regionKeys.push(focusRegion);
    }

    for (const region of regionKeys) {
        profile.regionAliases.add(region.toLowerCase());
        
        // Find aliases
        for (const [key, aliases] of Object.entries(REGION_ALIASES)) {
            if (key.toLowerCase() === region.toLowerCase() || aliases.some(a => a.toLowerCase() === region.toLowerCase())) {
                aliases.forEach(a => profile.regionAliases.add(a.toLowerCase()));
            }
        }
    }

    // 3. Apply custom blocklists
    if (userProfile.custom_blocklist && Array.isArray(userProfile.custom_blocklist)) {
        userProfile.custom_blocklist.forEach(word => profile.excludedContexts.add(word.toLowerCase()));
    }

    // Convert sets to arrays for easier processing later
    return {
        userId: profile.userId,
        primaryTerms: Array.from(profile.primaryTerms),
        relatedTerms: Array.from(profile.relatedTerms),
        regionAliases: Array.from(profile.regionAliases),
        businessTerms: Array.from(profile.businessTerms),
        excludedContexts: Array.from(profile.excludedContexts),
    };
}
