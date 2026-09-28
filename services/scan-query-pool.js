// Choosing which search queries a scan actually runs.
//
// The scanner builds a pool from four sources — the profile's news keywords,
// two commodity lanes (supply-chain and market/price), and the tracked regions
// — then has to cut it to the number of feeds it will fetch.
//
// That cut used to be a plain shuffle-and-slice over the combined pool, which
// made a tracked commodity almost invisible. A profile with 63 keywords, 16
// regions and 2 commodities produces ~83 entries of which only 4 are about the
// commodities; sampling 20 of those leaves roughly a 1-in-1 chance of getting
// a single commodity query, and frequently none at all. Measured on dev
// 2026-09-28: a user selected Wheat and Corn, and the very next scan ran 20
// queries with no wheat or corn among them.
//
// So commodity queries now get reserved slots. Whatever a person explicitly
// ticked is the clearest statement of intent on the profile, and it should
// show up in what the scanner asks for.

/** Deterministic when `rng` is supplied, which is what makes this testable. */
function shuffled(items, rng = Math.random) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * @param {object} sources
 * @param {string[]} sources.commodityQueries  both commodity lanes, already built
 * @param {string[]} sources.otherQueries      keywords + regions
 * @param {number}   limit                     how many queries the scan will run
 * @param {() => number} [rng]
 * @returns {string[]} de-duplicated, at most `limit` long
 */
export function selectScanQueries({ commodityQueries = [], otherQueries = [] }, limit, rng = Math.random) {
    const commodity = [...new Set(commodityQueries)];
    const other = [...new Set(otherQueries)].filter((q) => !commodity.includes(q));

    if (limit <= 0) return [];

    // Half the budget is the ceiling for commodity queries, not a quota: a
    // profile tracking one commodity takes 2 slots, not 10. The cap matters
    // for the opposite case — 13 commodities would otherwise crowd out every
    // keyword, and the keywords are what surface breaking supply-chain news
    // that names no commodity at all ("Hormuz closure", "port strike").
    const reserved = Math.min(commodity.length, Math.ceil(limit / 2));
    const picked = shuffled(commodity, rng).slice(0, reserved);

    const remaining = limit - picked.length;
    if (remaining > 0) picked.push(...shuffled(other, rng).slice(0, remaining));

    // Backfill from whatever is left if one source was too small to fill the
    // budget — running fewer feeds than we could afford helps nobody.
    if (picked.length < limit) {
        const rest = [...commodity, ...other].filter((q) => !picked.includes(q));
        picked.push(...shuffled(rest, rng).slice(0, limit - picked.length));
    }

    return picked;
}
