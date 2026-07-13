import { COMMODITY_PROFILES, REGION_ALIASES, FALLBACK_PROFILE, GLOBAL_EXCLUDED_CONTEXTS, MASKED_PHRASES } from '../config/profiles.js';

/**
 * Stage 2: Dynamic Watchlist Profile Builder
 * Dynamically builds a search profile based on the user's selected commodities and regions.
 */

// UPPER_SNAKE catalog codes (LIVE_CATTLE, ORANGE_JUICE) must become natural
// language ("live cattle") before they can ever match news text. This was
// the single biggest recall bug: "orange_juice" as a regex can never match.
function codeToPhrase(key) {
    return String(key).trim().toLowerCase().replace(/_/g, ' ');
}

/**
 * Expands a user region string to its canonical region group. Handles
 * micro-regions like "Saudi Arabia Al-Hasa" / "UAE Sweihan" that will never
 * appear verbatim in news text: if any known region key or alias occurs
 * INSIDE the user's region string, that whole alias group applies.
 * Exported for reuse by the fetch-query builder in server.js.
 */
export function expandRegionAliases(regionStr) {
    const found = new Set();
    const lower = String(regionStr).toLowerCase();
    for (const [key, aliases] of Object.entries(REGION_ALIASES)) {
        const names = [key, ...aliases];
        if (names.some(n => lower.includes(n.toLowerCase()))) {
            aliases.forEach(a => found.add(a.toLowerCase()));
        }
    }
    return Array.from(found);
}

/** Canonical country/region name for a (possibly micro-) region string —
 *  used to build sane news search queries ("Saudi Arabia" not "Saudi Arabia
 *  Al-Hasa"). Prefers the most specific match: a key name found inside the
 *  string beats an umbrella group that merely lists it as an alias. */
export function canonicalRegionName(regionStr) {
    const lower = String(regionStr).toLowerCase();
    let best = null; // { key, len }
    for (const [key, aliases] of Object.entries(REGION_ALIASES)) {
        // Key-name containment (most specific signal), longest key wins.
        if (lower.includes(key.toLowerCase())) {
            if (!best || key.length > best.len) best = { key, len: key.length };
        }
    }
    if (best) return best.key;
    for (const [key, aliases] of Object.entries(REGION_ALIASES)) {
        if (aliases.some(n => lower.includes(n.toLowerCase()))) return key;
    }
    return regionStr;
}

/**
 * Auto-generates semantic seed examples from the profile itself when no
 * customer ml_seeds exist, so the stage-6 semantic filter protects ALL users
 * (previously it was inert for anyone without a customer profile). One seed
 * PER COMMODITY — a single combined bag dilutes minority commodities (a
 * 15-commodity food-heavy profile drowned its gold/silver signal, wrongly
 * failing genuine bullion-market articles). Seeds are keyword-bag "ideal
 * article" sketches — MiniLM handles these fine, and the threshold is
 * calibrated leniently so this only removes clear noise.
 */
function generateDefaultSeeds(commoditySeedGroups, userProfile) {
    const seeds = commoditySeedGroups.map(g => `${g} prices supply demand export import shortage`);
    const focusBits = [userProfile.focus_product, userProfile.focus_region].filter(Boolean).join(' ');
    seeds.push(`${focusBits} food supply chain disruption logistics port shipping freight delays`.trim());
    if (Array.isArray(userProfile.news_keywords) && userProfile.news_keywords.length > 0) {
        seeds.push(`${userProfile.news_keywords.join(' ')} disruption prices supply`);
    }
    return seeds.filter(s => s.length > 20);
}

export function buildWatchlistProfile(userProfile) {
    const profile = {
        userId: userProfile.user_id,
        primaryTerms: new Set(),
        relatedTerms: new Set(),
        regionAliases: new Set(),
        businessTerms: new Set(),
        excludedContexts: new Set(),
    };

    // 1. Process Commodities
    const commodities = Array.isArray(userProfile.commodities) ? userProfile.commodities : [];
    const focusProduct = userProfile.focus_product;

    const commodityKeys = [...commodities];
    if (focusProduct && typeof focusProduct === 'string') {
        commodityKeys.push(focusProduct);
        profile.primaryTerms.add(focusProduct.toLowerCase()); // Always add focus product explicitly
    }

    let foundCommodity = false;
    const commoditySeedGroups = [];
    for (let key of commodityKeys) {
        // Lookup order: catalog code (WHEAT, LIVE_CATTLE) → legacy display
        // name ("Brent Crude") → primary-term scan ("wheat" typed manually).
        const phrase = codeToPhrase(key);
        const commProfile = COMMODITY_PROFILES[key]
            || Object.entries(COMMODITY_PROFILES).find(([k]) => k.toLowerCase() === phrase)?.[1]
            || Object.values(COMMODITY_PROFILES).find(p => p.primaryTerms.includes(phrase));

        if (commProfile) {
            foundCommodity = true;
            commProfile.primaryTerms.forEach(t => profile.primaryTerms.add(t.toLowerCase()));
            commProfile.relatedTerms.forEach(t => profile.relatedTerms.add(t.toLowerCase()));
            commProfile.businessTerms.forEach(t => profile.businessTerms.add(t.toLowerCase()));
            commProfile.excludedContexts.forEach(t => profile.excludedContexts.add(t.toLowerCase()));
            commoditySeedGroups.push([...commProfile.primaryTerms, ...commProfile.relatedTerms].join(' ').toLowerCase());
        } else {
            // Unknown/custom commodity: add the natural-language phrase, never
            // the raw code (underscores can never match news text).
            profile.primaryTerms.add(phrase);
            commoditySeedGroups.push(phrase);
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

    // 2. Process Regions (regions + focus_region + focus_countries + custom)
    const regions = Array.isArray(userProfile.regions) ? userProfile.regions : [];
    const focusCountries = Array.isArray(userProfile.focus_countries) ? userProfile.focus_countries : [];
    const focusRegion = userProfile.focus_region;
    // Regions the user explicitly ADDED on the fly — the "Add Custom region"
    // field and the focus region. These signal deliberate intent, so they are
    // PRIORITY regions: news matching them gets a scoring bonus (stage 5) and
    // therefore ranks/alerts higher than generic tracked-region news. (Custom
    // regions were previously not matched at all — this also fixes that.)
    const customRegions = (Array.isArray(userProfile.custom_regions) ? userProfile.custom_regions : [])
        .map(r => (typeof r === 'string' ? r : r?.name)).filter(Boolean);
    profile.priorityRegionAliases = new Set();

    const regionKeys = [...regions, ...focusCountries, ...customRegions];
    if (focusRegion && typeof focusRegion === 'string') {
        regionKeys.push(focusRegion);
    }

    for (const region of regionKeys) {
        profile.regionAliases.add(String(region).toLowerCase());
        // Micro-region-aware expansion: "Saudi Arabia Al-Hasa" → full Saudi
        // alias group; "UAE Sweihan" → UAE group; exact names work as before.
        expandRegionAliases(region).forEach(a => profile.regionAliases.add(a));
    }

    // Priority set: custom-added regions + focus region/countries (never the
    // whole template list).
    const priorityKeys = [...customRegions, ...focusCountries];
    if (focusRegion && typeof focusRegion === 'string' && focusRegion.toLowerCase() !== 'global') {
        priorityKeys.push(focusRegion);
    }
    for (const region of priorityKeys) {
        profile.priorityRegionAliases.add(String(region).toLowerCase());
        expandRegionAliases(region).forEach(a => profile.priorityRegionAliases.add(a));
    }

    // 3. Apply blocklists: global noise topics + the user's custom blocklist
    GLOBAL_EXCLUDED_CONTEXTS.forEach(t => profile.excludedContexts.add(t.toLowerCase()));
    if (userProfile.custom_blocklist && Array.isArray(userProfile.custom_blocklist)) {
        userProfile.custom_blocklist.forEach(word => profile.excludedContexts.add(word.toLowerCase()));
    }

    const hasCustomerSeeds = Array.isArray(userProfile.ml_seeds) && userProfile.ml_seeds.length > 0;
    const built = {
        userId: profile.userId,
        primaryTerms: Array.from(profile.primaryTerms),
        relatedTerms: Array.from(profile.relatedTerms),
        regionAliases: Array.from(profile.regionAliases),
        priorityRegionAliases: Array.from(profile.priorityRegionAliases),
        businessTerms: Array.from(profile.businessTerms),
        excludedContexts: Array.from(profile.excludedContexts),
        // Metaphor phrases hidden from commodity matching (see rule engine).
        maskedPhrases: MASKED_PHRASES,
        // Auto-seeds get a slightly laxer threshold than curated customer
        // seeds — they are keyword sketches, not real example articles.
        semanticThreshold: hasCustomerSeeds ? 0.30 : 0.25,
    };
    // Customer ml_seeds if configured; otherwise auto-generated from the
    // profile so semantic filtering protects every user.
    //
    // MERGE, don't replace: customer seeds cover the customer's core domain
    // (Aramtec's are 100% food-service), so a user-tracked commodity OUTSIDE
    // that domain (copper, gold) had no seed at all — every metals article
    // scored ~0.2 against food seeds and died at stage 6. Auto-seeds for
    // commodities the customer set never mentions restore that coverage.
    if (hasCustomerSeeds) {
        const customerText = userProfile.ml_seeds.join(' ').toLowerCase();
        // A commodity is "covered" if any of its primary words appear in the
        // customer seed text; only uncovered commodities contribute a seed.
        const uncovered = commoditySeedGroups
            .filter(g => !g.split(' ').some(w => w.length > 3 && customerText.includes(w)))
            .map(g => `${g} prices supply demand export import shortage`);
        built.mlSeeds = [...userProfile.ml_seeds, ...uncovered];
    } else {
        built.mlSeeds = generateDefaultSeeds(commoditySeedGroups, userProfile);
    }
    return built;
}
