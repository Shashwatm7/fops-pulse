// Central config for on-demand article summaries and local embeddings. All
// values from env; no hardcoded keys. Import this everywhere instead of
// reading process.env ad hoc. (Scan-time labeling config was removed with
// the labeling pipeline — ingestion is fully rule-based.)

export const labelingConfig = {
    provider: process.env.LLM_PROVIDER || 'groq',   // 'groq' | 'anthropic'
    groqApiKey: process.env.GROQ_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

    models: {
        groq: process.env.LABELING_GROQ_MODEL || 'llama-3.1-8b-instant',
        anthropic: process.env.LABELING_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    },

    // MiniLM: local, 384-dim, no API cost.
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    embeddingDims: 384,
};
