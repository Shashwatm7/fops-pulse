/**
 * Stage 6: Semantic Filter (real implementation)
 * For borderline-scored articles, compares the article's meaning against the
 * customer's ML seed examples using local MiniLM embeddings (no API cost).
 * Rejects articles that are semantically far from what the customer cares
 * about — catching keyword-matching false positives the scorer let through.
 *
 * Behavior preserved for profiles WITHOUT seeds: pass through (as the old
 * stub did), so this only tightens filtering where seeds are configured.
 */
import { embed } from '../../labeling/embeddingService.js';

const DEFAULT_THRESHOLD = 0.30; // empirically: relevant >=0.44, noise <=0.14

// Cache seed embeddings keyed by the seed set so we embed them once, not per
// article. Keyed by a cheap join hash of the seeds.
const seedCache = new Map();

function cosine(a, b) {
    // Both vectors are L2-normalized by the embedder, so dot product = cosine.
    let d = 0;
    for (let i = 0; i < a.length; i++) d += a[i] * b[i];
    return d;
}

async function getSeedVectors(seeds) {
    // Cheap FNV-style hash over ALL seed content — the old key
    // (count + first-24-chars) collided across users whose profiles share a
    // first commodity, silently reusing another user's seed vectors.
    let h = 2166136261;
    const joined = seeds.join('|');
    for (let i = 0; i < joined.length; i++) {
        h ^= joined.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const key = seeds.length + ':' + (h >>> 0).toString(36);
    if (seedCache.has(key)) return seedCache.get(key);
    const vecs = [];
    for (const s of seeds) {
        try { vecs.push(await embed(s)); } catch { /* skip unembeddable seed */ }
    }
    seedCache.set(key, vecs);
    return vecs;
}

/**
 * Raw max cosine similarity between an article and the profile's seed set,
 * or null when the profile has no usable seeds. Shared by the stage-6 gate
 * (reject survivors below threshold) and the pipeline's rescue lane (save
 * keyword-rejected articles that are unmistakably on-topic).
 * Throws on embedding failure — each caller decides its own failure policy
 * (the gate fails open, the rescue fails closed).
 */
export async function semanticSimilarity(article, profile) {
    const seeds = profile.mlSeeds || [];
    if (!Array.isArray(seeds) || seeds.length === 0) return null;
    const seedVecs = await getSeedVectors(seeds);
    if (seedVecs.length === 0) return null;
    const text = `${article.title || ''}. ${article.descNorm || article.description || ''}`.slice(0, 500);
    const v = await embed(text);
    return Math.max(...seedVecs.map(sv => cosine(v, sv)));
}

export async function applySemanticFilter(article, profile, score) {
    try {
        const maxSim = await semanticSimilarity(article, profile);
        if (maxSim == null) return { passed: true, similarity: null }; // no seeds → no semantic gating
        const threshold = profile.semanticThreshold || DEFAULT_THRESHOLD;

        if (maxSim < threshold) {
            // 3 decimals in the message: at 2, a 0.295 rounds to "0.30" and the
            // log reads "0.30 < 0.3" — looks like a bug even though the full-
            // precision comparison above was correct.
            return { passed: false, similarity: +maxSim.toFixed(3), reason: `Semantic similarity ${maxSim.toFixed(3)} < threshold ${threshold}` };
        }
        return { passed: true, similarity: +maxSim.toFixed(3) };
    } catch (err) {
        // Fail open: an embedding failure must not silently drop articles.
        console.error('[SEMANTIC] filter error (passing through):', err.message);
        return { passed: true, similarity: null };
    }
}
