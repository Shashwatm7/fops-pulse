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

    // Commodity supply-chain taxonomy (adapted from the generic B2B-SaaS spec).
    categories: [
        'export_ban', 'trade_policy', 'drought_weather', 'livestock_disease',
        'chokepoint_disruption', 'energy_shock', 'harvest_yield', 'price_move',
        'labor_disruption', 'other',
    ],
};
