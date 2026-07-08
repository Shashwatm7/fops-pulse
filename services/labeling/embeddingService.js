// Local sentence embeddings via ONNX MiniLM (@xenova/transformers).
// No API calls, no cost. Model loads once and is reused across all calls.
import { labelingConfig } from '../../config/labeling.js';

let embedderPromise = null;

// Lazy singleton: the ~25MB model downloads/loads on first use only, so an
// unused labeling feature never pays the startup cost.
function getEmbedder() {
    if (!embedderPromise) {
        embedderPromise = (async () => {
            const { pipeline } = await import('@xenova/transformers');
            const t0 = Date.now();
            const model = await pipeline('feature-extraction', labelingConfig.embeddingModel);
            console.log(`[EMBEDDING] Loaded ${labelingConfig.embeddingModel} in ${Date.now() - t0}ms`);
            return model;
        })().catch(err => {
            embedderPromise = null; // allow retry on a later call
            throw err;
        });
    }
    return embedderPromise;
}

/**
 * Embed text into a 384-dim vector.
 * @param {string} text  title + body[:500] concatenation
 * @returns {Promise<Float32Array>} 384-dim normalized embedding
 */
export async function embed(text) {
    const model = await getEmbedder();
    const t0 = Date.now();
    const out = await model(text || '', { pooling: 'mean', normalize: true });
    const ms = Date.now() - t0;
    if (ms > 200) console.log(`[EMBEDDING] Slow embed: ${ms}ms for ${(text || '').length} chars`);
    return out.data; // Float32Array(384)
}

/** pgvector wants a literal like '[0.1,0.2,...]'. */
export function toPgVector(embedding) {
    return `[${Array.from(embedding).join(',')}]`;
}
