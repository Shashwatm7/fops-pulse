// ── Precedent Engine ─────────────────────────────────────────────────
// "Last time this happened": match a live alert/event against a curated
// library of documented commodity supply-chain events, then report what
// prices ACTUALLY did afterward — computed live from Yahoo's historical
// daily bars at request time, never hardcoded. The library entries are
// only factual metadata (what happened, when, which commodities); every
// number shown to the user comes from real price history.
//
// Matching is deterministic (keywords + commodities + category) — zero
// LLM tokens. Aftermath windows are cached in-process: a 2023 price path
// never changes.

export const HISTORICAL_EVENTS = [
    {
        id: 'russia-wheat-ban-2010', date: '2010-08-05',
        title: 'Russia bans wheat exports after record drought',
        category: 'Trade Policy', commodities: ['WHEAT'], regions: ['russia', 'black sea'],
        keywords: ['wheat', 'export ban', 'russia', 'drought', 'grain'],
    },
    {
        id: 'arab-spring-egypt-2011', date: '2011-01-25',
        title: 'Arab Spring reaches Egypt — world\'s top wheat importer destabilized',
        category: 'Political Instability', commodities: ['WHEAT'], regions: ['egypt', 'middle east'],
        keywords: ['egypt', 'protest', 'unrest', 'wheat', 'import'],
    },
    {
        id: 'us-drought-2012', date: '2012-06-20',
        title: 'US Midwest drought devastates corn and soybean belt',
        category: 'Agricultural Crisis', commodities: ['CORN', 'SOYBEANS', 'WHEAT'], regions: ['usa', 'midwest'],
        keywords: ['drought', 'corn', 'soybean', 'crop failure', 'yield', 'heat'],
    },
    {
        id: 'crimea-annexation-2014', date: '2014-02-27',
        title: 'Russia moves on Crimea — Black Sea grain trade at risk',
        category: 'Armed Conflict', commodities: ['WHEAT', 'CORN'], regions: ['ukraine', 'russia', 'black sea'],
        keywords: ['crimea', 'ukraine', 'russia', 'invasion', 'black sea', 'grain'],
    },
    {
        id: 'us-china-tariffs-2018', date: '2018-07-06',
        title: 'US–China trade war: China tariffs hit US soybeans',
        category: 'Trade Policy', commodities: ['SOYBEANS', 'CORN'], regions: ['china', 'usa'],
        keywords: ['tariff', 'trade war', 'china', 'soybean', 'retaliation'],
    },
    {
        id: 'iran-deal-exit-2018', date: '2018-05-08',
        title: 'US exits Iran nuclear deal, reimposes oil sanctions',
        category: 'Trade Policy', commodities: ['BRENT_CRUDE'], regions: ['iran', 'middle east', 'gulf'],
        keywords: ['iran', 'sanction', 'oil', 'nuclear deal', 'crude'],
    },
    {
        id: 'swine-fever-china-2019', date: '2019-04-01',
        title: 'African swine fever culls half of China\'s hog herd',
        category: 'Livestock Pandemic', commodities: ['LEAN_HOGS', 'SOYBEANS'], regions: ['china', 'asia'],
        keywords: ['swine fever', 'hog', 'pig', 'cull', 'livestock disease', 'pork'],
    },
    {
        id: 'abqaiq-attack-2019', date: '2019-09-14',
        title: 'Drone attack knocks out half of Saudi Aramco\'s Abqaiq output',
        category: 'Energy Infrastructure', commodities: ['BRENT_CRUDE'], regions: ['saudi', 'middle east', 'gulf'],
        keywords: ['drone', 'attack', 'refinery', 'saudi', 'aramco', 'oil facility'],
    },
    {
        id: 'covid-pandemic-2020', date: '2020-03-11',
        title: 'WHO declares COVID-19 pandemic — global demand shock',
        category: 'Natural Disaster', commodities: ['BRENT_CRUDE', 'CORN', 'SUGAR'], regions: ['global'],
        keywords: ['pandemic', 'lockdown', 'covid', 'demand collapse', 'virus outbreak'],
    },
    {
        id: 'texas-freeze-2021', date: '2021-02-13',
        title: 'Texas deep freeze cripples US gas production',
        category: 'Natural Disaster', commodities: ['NATURAL_GAS'], regions: ['usa', 'texas'],
        keywords: ['freeze', 'winter storm', 'natural gas', 'power outage', 'cold'],
    },
    {
        id: 'suez-blockage-2021', date: '2021-03-23',
        title: 'Ever Given blocks the Suez Canal for six days',
        category: 'Maritime Chokepoint', commodities: ['BRENT_CRUDE'], regions: ['suez', 'egypt', 'middle east'],
        keywords: ['suez', 'canal', 'blocked', 'container ship', 'ever given', 'stuck'],
    },
    {
        id: 'brazil-coffee-frost-2021', date: '2021-07-20',
        title: 'Worst Brazil frost in decades hits coffee belt',
        category: 'Agricultural Crisis', commodities: ['COFFEE'], regions: ['brazil'],
        keywords: ['frost', 'coffee', 'brazil', 'arabica', 'crop damage', 'freeze'],
    },
    {
        id: 'energy-crunch-2021', date: '2021-09-15',
        title: 'Global energy crunch: gas prices spiral into winter',
        category: 'Energy Supply', commodities: ['NATURAL_GAS', 'BRENT_CRUDE'], regions: ['europe', 'global'],
        keywords: ['energy crisis', 'gas shortage', 'power', 'lng', 'winter supply'],
    },
    {
        id: 'ukraine-invasion-2022', date: '2022-02-24',
        title: 'Russia invades Ukraine — Black Sea exports halt',
        category: 'Armed Conflict', commodities: ['WHEAT', 'CORN', 'NATURAL_GAS', 'BRENT_CRUDE', 'SOYBEANS'], regions: ['ukraine', 'russia', 'black sea', 'europe'],
        keywords: ['invasion', 'ukraine', 'russia', 'war', 'black sea', 'grain', 'export halt'],
    },
    {
        id: 'india-wheat-ban-2022', date: '2022-05-13',
        title: 'India bans wheat exports amid heatwave crop losses',
        category: 'Trade Policy', commodities: ['WHEAT'], regions: ['india', 'asia'],
        keywords: ['india', 'wheat', 'export ban', 'heatwave', 'food security'],
    },
    {
        id: 'grain-deal-collapse-2023', date: '2023-07-17',
        title: 'Russia exits the Black Sea Grain Initiative',
        category: 'Trade Policy', commodities: ['WHEAT', 'CORN'], regions: ['ukraine', 'russia', 'black sea'],
        keywords: ['grain deal', 'black sea', 'corridor', 'russia', 'wheat', 'collapse'],
    },
    {
        id: 'india-rice-ban-2023', date: '2023-07-20',
        title: 'India bans non-basmati rice exports',
        category: 'Trade Policy', commodities: ['RICE'], regions: ['india', 'asia'],
        keywords: ['india', 'rice', 'export ban', 'non-basmati', 'food inflation'],
    },
    {
        id: 'panama-drought-2023', date: '2023-08-01',
        title: 'Panama Canal drought forces deep transit restrictions',
        category: 'Maritime Chokepoint', commodities: ['CORN', 'SOYBEANS'], regions: ['panama', 'americas'],
        keywords: ['panama canal', 'drought', 'transit', 'draft restriction', 'shipping delay'],
    },
    {
        id: 'red-sea-attacks-2023', date: '2023-11-19',
        title: 'Houthi attacks begin on Red Sea shipping',
        category: 'Maritime Security', commodities: ['BRENT_CRUDE'], regions: ['red sea', 'middle east', 'suez', 'yemen'],
        keywords: ['houthi', 'red sea', 'attack', 'shipping', 'missile', 'vessel', 'reroute'],
    },
    {
        id: 'cocoa-crisis-2024', date: '2024-02-01',
        title: 'West African harvest collapse ignites cocoa crisis',
        category: 'Agricultural Crisis', commodities: ['COCOA'], regions: ['ivory coast', 'ghana', 'west africa'],
        keywords: ['cocoa', 'harvest', 'ivory coast', 'ghana', 'pod disease', 'shortage', 'chocolate'],
    },
    {
        id: 'hurricane-milton-oj-2024', date: '2024-10-07',
        title: 'Hurricane Milton bears down on Florida citrus groves',
        category: 'Natural Disaster', commodities: ['ORANGE_JUICE'], regions: ['florida', 'usa'],
        keywords: ['hurricane', 'florida', 'citrus', 'orange', 'groves', 'storm'],
    },
];

const COMMODITY_NAME_TERMS = {
    WHEAT: ['wheat'], CORN: ['corn', 'maize'], SOYBEANS: ['soybean', 'soybeans', 'soy'],
    RICE: ['rice'], OATS: ['oats'], SUGAR: ['sugar'], COFFEE: ['coffee', 'arabica', 'robusta'],
    COCOA: ['cocoa'], FEEDER_CATTLE: ['feeder cattle', 'cattle'], LEAN_HOGS: ['hogs', 'pork', 'pig'],
    LIVE_CATTLE: ['live cattle', 'cattle', 'beef'], MILK: ['milk', 'dairy'],
    ORANGE_JUICE: ['orange juice', 'orange', 'citrus'], COPPER: ['copper'], ALUMINUM: ['aluminum', 'aluminium'],
    GOLD: ['gold'], SILVER: ['silver'], PLATINUM: ['platinum'], LUMBER: ['lumber', 'timber'],
    BRENT_CRUDE: ['brent', 'crude', 'oil'], NATURAL_GAS: ['natural gas', 'lng', 'gas'],
};

function hasTerm(text, term) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * Match a live event against the historical library. Deterministic scoring:
 * commodity overlap 40 + keyword hits (12 each, cap 36) + category 20 + region 10.
 * @param {{text: string, category?: string, commodities?: string[]}} event
 * @returns {Array<{event: object, score: number}>} top matches, best first
 */
export function matchPrecedents(event, limit = 2, minScore = 45) {
    const text = String(event.text || '').toLowerCase();
    const eventCommodities = new Set(event.commodities || []);

    // Also detect commodities named in the text itself
    for (const [key, terms] of Object.entries(COMMODITY_NAME_TERMS)) {
        if (terms.some(t => hasTerm(text, t))) eventCommodities.add(key);
    }

    const scored = [];
    for (const past of HISTORICAL_EVENTS) {
        let score = 0;
        if (past.commodities.some(c => eventCommodities.has(c))) score += 40;
        const keywordHits = past.keywords.filter(k => hasTerm(text, k)).length;
        score += Math.min(36, keywordHits * 12);
        if (event.category && past.category === event.category) score += 20;
        if (past.regions.some(r => hasTerm(text, r))) score += 10;
        if (score >= minScore) scored.push({ event: past, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

/**
 * What prices did after the event — pure math over real daily bars.
 * @param {Array<{date: Date|string, close: number}>} bars ascending daily bars
 *        spanning ~[event-10d, event+100d]
 * @param {string} eventDate 'YYYY-MM-DD'
 * @returns {object|null} {basePrice, baseDate, pct7, pct30, pct90, peakPct, daysToPeak}
 */
export function computeAftermath(bars, eventDate) {
    const clean = (bars || [])
        .filter(b => b && b.close > 0 && b.date)
        .map(b => ({ date: new Date(b.date), close: b.close }))
        .sort((a, b) => a.date - b.date);
    if (clean.length < 20) return null;

    const t0 = new Date(eventDate).getTime();
    const baseIdx = clean.findIndex(b => b.date.getTime() >= t0);
    if (baseIdx < 0) return null;
    const base = clean[baseIdx];
    const after = clean.slice(baseIdx);
    if (after.length < 5) return null;

    const pctAt = (days) => {
        const target = t0 + days * 86400e3;
        let best = null;
        for (const b of after) {
            if (b.date.getTime() <= target) best = b;
            else break;
        }
        if (!best || best === base) return null;
        return +(((best.close - base.close) / base.close) * 100).toFixed(1);
    };

    let peak = base, trough = base;
    for (const b of after) {
        if (b.date.getTime() > t0 + 90 * 86400e3) break;
        if (b.close > peak.close) peak = b;
        if (b.close < trough.close) trough = b;
    }
    const peakPct = +(((peak.close - base.close) / base.close) * 100).toFixed(1);
    const troughPct = +(((trough.close - base.close) / base.close) * 100).toFixed(1);
    // The dominant excursion is the story: a crisis can be a spike OR a slide
    const dominantIsPeak = Math.abs(peakPct) >= Math.abs(troughPct);
    const extreme = dominantIsPeak ? peak : trough;
    const extremePct = dominantIsPeak ? peakPct : troughPct;

    return {
        basePrice: +base.close.toFixed(4),
        baseDate: base.date.toISOString().slice(0, 10),
        pct7: pctAt(7),
        pct30: pctAt(30),
        pct90: pctAt(90),
        extremePct,
        daysToExtreme: Math.round((extreme.date.getTime() - t0) / 86400e3),
    };
}

/** One planner-readable sentence summarizing a precedent's aftermath. */
export function summarizePrecedent(past, symbol, aftermath) {
    const label = symbol.replace(/_/g, ' ');
    const dateStr = new Date(past.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (!aftermath) return `${dateStr} — ${past.title}. Price history for ${label} is unavailable for this window.`;
    const dir = (v) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v}%`);
    const extremeLine = aftermath.extremePct != null
        ? ` Biggest move: ${dir(aftermath.extremePct)} around day ${aftermath.daysToExtreme}.`
        : '';
    return `${dateStr} — ${past.title}. ${label} moved ${dir(aftermath.pct7)} in 1 week, ${dir(aftermath.pct30)} in 1 month, ${dir(aftermath.pct90)} in 3 months.${extremeLine}`;
}
