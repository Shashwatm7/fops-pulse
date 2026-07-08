// Central config for the article labeling system. All values from env; no
// hardcoded keys. Import this everywhere instead of reading process.env ad hoc.

const int = (name, fallback) => {
    const v = Number.parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
};
const float = (name, fallback) => {
    const v = Number.parseFloat(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
};

export const labelingConfig = {
    // Master switch — labeling is OFF unless explicitly enabled, so it never
    // silently consumes Groq quota. Set ENABLE_ARTICLE_LABELING=true to turn on.
    enabled: process.env.ENABLE_ARTICLE_LABELING === 'true',

    provider: process.env.LLM_PROVIDER || 'groq',   // 'groq' | 'anthropic'
    groqApiKey: process.env.GROQ_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

    models: {
        groq: process.env.LABELING_GROQ_MODEL || 'llama-3.1-8b-instant',
        anthropic: process.env.LABELING_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    },

    confidenceThreshold: float('LABEL_CONFIDENCE_THRESHOLD', 0.75),
    rateLimitPerMin: int('GROQ_RATE_LIMIT', 20),

    // MiniLM: local, 384-dim, no API cost.
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    embeddingDims: 384,

    // Food-service supply-chain taxonomy (Aramtec Part 7).
    categories: [
        'port_disruption', 'shipping_route_change', 'cold_chain_risk',
        'protein_price_move', 'grain_price_move', 'dairy_price_move',
        'edible_oil_move', 'middle_east_tension', 'suez_canal_event',
        'sanctions_trade', 'uae_trade_policy', 'supplier_country_risk',
        'food_safety_recall', 'crop_weather_event', 'hospitality_demand',
        'ramadan_eid_signal', 'food_inflation', 'currency_risk', 'other',
    ],
    severities: ['critical', 'high', 'medium', 'low'],
    tierWeights: { gold: 3, silver: 2, bronze: 1 },
};
