// Central config for on-demand article summaries and local embeddings. All
// values from env; no hardcoded keys. Import this everywhere instead of
// reading process.env ad hoc. (Scan-time labeling config was removed with
// the labeling pipeline — ingestion is fully rule-based.)

export const labelingConfig = {
    // Default 'groq': summaries run on Groq (its free RPM/TPM/RPD are far more
    // generous than Gemini free tier's 5 RPM). Input is capped in summaryContent
    // so the token cost stays low. Set LLM_PROVIDER=gemini|anthropic to override.
    provider: process.env.LLM_PROVIDER || 'groq',   // 'groq' | 'gemini' | 'anthropic'
    groqApiKey: process.env.GROQ_API_KEY || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',

    models: {
        groq: process.env.LABELING_GROQ_MODEL || 'llama-3.1-8b-instant',
        anthropic: process.env.LABELING_ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        gemini: process.env.LABELING_GEMINI_MODEL || 'gemini-2.5-flash',
    },

    // MiniLM: local, 384-dim, no API cost.
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    embeddingDims: 384,
};
