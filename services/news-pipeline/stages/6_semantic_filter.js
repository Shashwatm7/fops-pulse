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

// Rocchio classifier: score = maxCosine(article, positive seeds)
//                              - GAMMA * cosine(article, negative centroid).
// The POSITIVE side stays per-seed (max), not a single averaged centroid, so
// multi-commodity profiles don't dilute minority commodities. The NEGATIVE
// prototype is a centroid of the known false-positive classes (recipes,
// restaurant reviews, box-office, sports, ...) — this is what Rocchio adds:
// it pushes down food-adjacent NOISE that slipped past keyword matching.
// GAMMA is small (non-relevant feedback is noisier than relevant); tunable.
const GAMMA = Number(process.env.ROCCHIO_GAMMA) || 0.5;

// Natural-sentence noise seeds (sentences embed better than keyword bags),
// covering the false-positive topics the pipeline has actually seen.
const NOISE_SEEDS = [
    'A recipe with cooking tips and ingredients for a home-cooked meal.',
    'A restaurant review, cafe menu, and dining recommendations.',
    'Celebrity gossip, horoscopes, lottery numbers and box-office movie reviews.',
    'Sports match highlights, video game and esports coverage.',
    'Diet, nutrition and personal health and wellness advice.',
    'Gardening and home vegetable garden tips.',
];

let noiseCentroid = null; // lazy, embedded once per process
async function getNoiseCentroid() {
    if (noiseCentroid !== null) return noiseCentroid;
    const vecs = [];
    for (const s of NOISE_SEEDS) {
        try { vecs.push(await embed(s)); } catch { /* skip */ }
    }
    if (vecs.length === 0) { noiseCentroid = false; return false; } // false = unavailable
    // Mean-pool, then L2-normalize so cosine() (a plain dot product) stays valid.
    const dim = vecs[0].length;
    const mean = new Float32Array(dim);
    for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i];
    let norm = 0;
    for (let i = 0; i < dim; i++) { mean[i] /= vecs.length; norm += mean[i] * mean[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) mean[i] /= norm;
    noiseCentroid = mean;
    return mean;
}

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
        const seeds = profile.mlSeeds || [];
        if (!Array.isArray(seeds) || seeds.length === 0) return { passed: true, similarity: null };
        const seedVecs = await getSeedVectors(seeds);
        if (seedVecs.length === 0) return { passed: true, similarity: null };

        // Embed the article ONCE; reuse for both the positive (seed) and
        // negative (noise) comparisons.
        const text = `${article.title || ''}. ${article.descNorm || article.description || ''}`.slice(0, 500);
        const v = await embed(text);
        const maxPos = Math.max(...seedVecs.map(sv => cosine(v, sv)));

        const neg = await getNoiseCentroid();
        const negSim = neg ? cosine(v, neg) : 0;

        // Rocchio decision score: reward closeness to the query seeds, penalize
        // closeness to the noise prototype. `similarity` still reports raw
        // maxPos (the interpretable relevance recorded on the article); the
        // gate decides on the Rocchio-adjusted score.
        const rocchio = maxPos - GAMMA * negSim;
        const threshold = profile.semanticThreshold || DEFAULT_THRESHOLD;

        if (rocchio < threshold) {
            // 3 decimals so a 0.295 doesn't render as "0.30 < 0.3" (looks buggy).
            return {
                passed: false,
                similarity: +maxPos.toFixed(3),
                rocchio: +rocchio.toFixed(3),
                reason: `Rocchio ${rocchio.toFixed(3)} (sim ${maxPos.toFixed(3)} - ${GAMMA}*noise ${negSim.toFixed(3)}) < threshold ${threshold}`,
            };
        }
        return { passed: true, similarity: +maxPos.toFixed(3), rocchio: +rocchio.toFixed(3) };
    } catch (err) {
        // Fail open: an embedding failure must not silently drop articles.
        console.error('[SEMANTIC] filter error (passing through):', err.message);
        return { passed: true, similarity: null };
    }
}
