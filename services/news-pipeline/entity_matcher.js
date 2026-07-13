// ── Rule-based entity extraction + master-data matching ──────────────
// Deterministic, no LLM. Given article text and a customer's master data,
// finds every mention of a known entity and LINKS it to its canonical master
// record — so "chicken"/"poultry"/"broiler" all resolve to the one commodity
// master entry, "Dubai"/"Jebel Ali"/"Emirati" to the UAE region, etc.
//
// This replaces naive substring matching (which matched "india" inside
// "indiana" and knew no synonyms) with word-boundary, alias-aware matching
// against real reference data:
//   • commodities  — customer's tracked list, enriched with COMMODITY_PROFILES synonyms
//   • regions      — REGION_ALIASES canonical groups
//   • chokepoints  — maritime chokepoints (canonical names)
//   • ports/routes/supplier_countries — the customer master-data lists
//
// Output is a set of typed, canonical-linked entities usable for display,
// alert reasons, and grounding.
import { COMMODITY_PROFILES, REGION_ALIASES, WORLD_COUNTRIES } from './config/profiles.js';

// The full set of regions/countries the filter offers and the matcher can
// tag: rich REGION_ALIASES canonicals + every WORLD_COUNTRIES name not already
// keyed there. Deduped by canonical, sorted for display.
export const REGION_CATALOG = (() => {
    const canon = new Set(Object.keys(REGION_ALIASES).filter(k => k !== 'Global'));
    for (const c of WORLD_COUNTRIES) if (![...canon].some(k => k.toLowerCase() === c.toLowerCase())) canon.add(c);
    return [...canon].sort();
})();

// Canonical maritime chokepoints and the surface forms that name them. Kept
// here (not imported from alert-relevance) so this module owns its master data.
const CHOKEPOINTS = {
    'Strait of Hormuz': ['strait of hormuz', 'hormuz'],
    'Bab el-Mandeb': ['bab el-mandeb', 'bab-el-mandeb', 'bab al-mandab'],
    'Red Sea': ['red sea'],
    'Suez Canal': ['suez canal', 'suez'],
    'Panama Canal': ['panama canal'],
    'Strait of Malacca': ['strait of malacca', 'malacca'],
    'Black Sea': ['black sea'],
    'Cape of Good Hope': ['cape of good hope', 'the cape'],
};

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word / whole-phrase, case-insensitive. Prevents "india"⊂"indiana",
// "corn"⊂"popcorn", "gas"⊂"Vegas".
function hasTerm(text, term) {
    if (!term || term.length < 2) return false;
    return new RegExp(`\\b${escapeRegex(term.toLowerCase())}\\b`, 'i').test(text);
}

// Build the master-entry list [{ type, canonical, code?, aliases[] }] from the
// customer profile + shared reference data. Commodity entries are enriched
// with COMMODITY_PROFILES synonyms whenever the customer's term appears in a
// profile's primary/related terms (so "chicken" pulls in poultry/broiler/…).
export function buildMasterEntries(customer = {}) {
    const entries = [];

    // Commodities — customer list is the canonical set; enrich aliases.
    for (const raw of customer.commodities || []) {
        const name = String(raw).replace(/_/g, ' ').toLowerCase();
        const aliases = new Set([name]);
        for (const [, prof] of Object.entries(COMMODITY_PROFILES)) {
            const terms = [...(prof.primaryTerms || []), ...(prof.relatedTerms || [])].map(t => t.toLowerCase());
            if (terms.includes(name)) terms.forEach(t => aliases.add(t));
        }
        entries.push({ type: 'commodity', canonical: name, aliases: [...aliases] });
    }

    // Regions — REGION_ALIASES canonical groups (rich aliases), plus every
    // WORLD_COUNTRIES name not already keyed (so any country can be tagged and
    // filtered). A mention of any alias resolves to its canonical region.
    const keyed = new Set();
    for (const [canonical, aliases] of Object.entries(REGION_ALIASES)) {
        if (canonical === 'Global') continue;
        entries.push({ type: 'region', canonical, aliases: aliases.map(a => a.toLowerCase()) });
        keyed.add(canonical.toLowerCase());
    }
    for (const c of WORLD_COUNTRIES) {
        if (keyed.has(c.toLowerCase())) continue;
        entries.push({ type: 'region', canonical: c, aliases: [c.toLowerCase()] });
        keyed.add(c.toLowerCase());
    }

    // Chokepoints.
    for (const [canonical, aliases] of Object.entries(CHOKEPOINTS)) {
        entries.push({ type: 'chokepoint', canonical, aliases });
    }

    // Ports / routes / supplier countries — customer master data, matched as-is.
    for (const p of customer.key_ports || []) entries.push({ type: 'port', canonical: p, aliases: [String(p).toLowerCase()] });
    for (const r of customer.key_routes || []) entries.push({ type: 'route', canonical: r, aliases: [String(r).toLowerCase()] });
    for (const s of customer.supplier_countries || []) entries.push({ type: 'supplier_country', canonical: s, aliases: [String(s).toLowerCase()] });

    return entries;
}

/**
 * Extract + master-data-match. Returns entities grouped by type, each a
 * canonical name with the surface form that matched (deduped by canonical).
 * @param {string} text  article title + body
 * @param {object} customer  customer_profiles row (master data)
 * @returns {{commodities,regions,chokepoints,ports,routes,supplier_countries: Array<{canonical,matched}>}}
 */
export function matchEntities(text, customer = {}) {
    const hay = String(text || '').toLowerCase();
    const entries = buildMasterEntries(customer);
    const out = { commodity: [], region: [], chokepoint: [], port: [], route: [], supplier_country: [] };
    const seen = new Set(); // `${type}:${canonical}` — one hit per canonical

    for (const e of entries) {
        const key = `${e.type}:${e.canonical}`;
        if (seen.has(key)) continue;
        const matched = e.aliases.find(a => hasTerm(hay, a));
        if (matched) {
            seen.add(key);
            (out[e.type] || (out[e.type] = [])).push({ canonical: e.canonical, matched });
        }
    }

    // Plural keys for readability at call sites.
    return {
        commodities: out.commodity,
        regions: out.region,
        chokepoints: out.chokepoint,
        ports: out.port,
        routes: out.route,
        supplier_countries: out.supplier_country,
    };
}

// Flatten to a compact chip list for UI/alert display: [{type,label}].
export function entitiesToChips(matched) {
    const chips = [];
    const push = (arr, type) => (arr || []).forEach(e => chips.push({ type, label: e.canonical }));
    push(matched.chokepoints, 'chokepoint');
    push(matched.regions, 'region');
    push(matched.commodities, 'commodity');
    push(matched.ports, 'port');
    push(matched.routes, 'route');
    push(matched.supplier_countries, 'supplier');
    return chips;
}
