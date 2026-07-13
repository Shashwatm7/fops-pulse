// Deterministic news categorization — no LLM. Assigns each accepted article
// a single category by scanning its text against ordered keyword sets. Order
// matters: the FIRST matching category wins, and SUPPLY DISRUPTION is checked
// first so a supply-chain shock is always labeled as such even when it also
// mentions prices or a region (a procurement desk cares about the disruption,
// not that the article happens to quote a futures number).

import { SEVERE_DISRUPTORS } from './stages/5_relevance_scorer.js';

// Physical-flow friction terms for the disruption category. Deliberately a
// curated subset — NOT the full stage-5 MODERATE_DISRUPTORS, which includes
// policy words (tariff, sanction, ban, quota) that belong in the more
// specific trade_policy category, not physical supply disruption.
const PHYSICAL_FRICTION = [
    'disruption', 'disrupt', 'disrupted', 'delay', 'delays', 'delayed',
    'reroute', 'rerouting', 'rerouted', 'diverted', 'congestion', 'shortage',
    'backlog', 'chokepoint', 'protest', 'unrest',
];

// Ordered highest-signal → lowest. Each entry: { key, label, emoji, terms }.
// `terms` are matched as whole words/phrases, case-insensitive.
export const CATEGORIES = [
    {
        key: 'supply_disruption',
        label: 'Supply Chain Disruption',
        emoji: '🚨',
        terms: [...SEVERE_DISRUPTORS, ...PHYSICAL_FRICTION],
    },
    {
        key: 'geopolitical',
        label: 'Geopolitical',
        emoji: '🌍',
        terms: ['war', 'conflict', 'military', 'troops', 'coup', 'election', 'tension', 'tensions', 'diplomatic', 'nuclear', 'regime', 'ceasefire', 'iran', 'israel', 'russia', 'ukraine'],
    },
    {
        key: 'trade_policy',
        label: 'Trade Policy',
        emoji: '📋',
        terms: ['tariff', 'tariffs', 'export ban', 'import ban', 'quota', 'quotas', 'trade deal', 'trade war', 'wto', 'duty', 'duties', 'subsidy', 'subsidies', 'customs', 'levy'],
    },
    {
        key: 'weather_crop',
        label: 'Weather & Crop',
        emoji: '🌦️',
        terms: ['drought', 'flood', 'flooding', 'frost', 'freeze', 'monsoon', 'harvest', 'yield', 'yields', 'heatwave', 'heat wave', 'crop', 'crops', 'planting', 'rainfall', 'el nino', 'la nina', 'cyclone', 'hurricane', 'typhoon'],
    },
    {
        key: 'food_safety',
        label: 'Food Safety',
        emoji: '🧪',
        terms: ['recall', 'recalled', 'contamination', 'contaminated', 'outbreak', 'avian flu', 'bird flu', 'swine', 'disease', 'e.coli', 'e. coli', 'salmonella', 'listeria', 'pathogen'],
    },
    {
        key: 'energy',
        label: 'Energy',
        emoji: '⚡',
        terms: ['crude', 'brent', 'wti', 'opec', 'diesel', 'fuel', 'natural gas', 'lng', 'power grid', 'electricity', 'refinery', 'pipeline'],
    },
    {
        key: 'logistics',
        label: 'Logistics & Freight',
        emoji: '🚢',
        terms: ['freight', 'shipping', 'container', 'vessel', 'warehouse', 'cold chain', 'reefer', 'cargo', 'logistics', 'trucking', 'rail', 'canal'],
    },
    {
        key: 'price_move',
        label: 'Price Move',
        emoji: '📊',
        terms: ['price', 'prices', 'surge', 'surged', 'plunge', 'plunged', 'rally', 'rallied', 'futures', 'rate', 'rates', 'inflation', 'cost', 'costs'],
    },
];

const FALLBACK = { key: 'general', label: 'General', emoji: '📰' };

const hasTerm = (text, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
};

/**
 * Categorize one article. Returns { key, label, emoji, isDisruption }.
 * @param {string} title
 * @param {string} [description]
 */
export function categorizeArticle(title, description = '') {
    const text = `${title || ''} ${description || ''}`;
    for (const cat of CATEGORIES) {
        if (cat.terms.some(t => hasTerm(text, t))) {
            return { key: cat.key, label: cat.label, emoji: cat.emoji, isDisruption: cat.key === 'supply_disruption' };
        }
    }
    return { ...FALLBACK, isDisruption: false };
}
