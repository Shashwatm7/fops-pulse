// ── Template-candidate discovery from rejected articles ──────────────
// At scale, the pipeline's rejection pool ("unmatched") silently accumulates
// real driver categories nobody wrote a seed/keyword for yet. Instead of an
// analyst reading thousands of rejected headlines, this module clusters them
// (k-means over the same local MiniLM embeddings stage 6 already uses) and
// labels each cluster with its most distinctive terms (c-TF-IDF), so a human
// reviews ~8 cluster summaries and promotes real patterns into the customer's
// ml_seeds / signal_keywords. Deterministic, no LLM, no new dependencies.
//
// Division of labor mirrors the pipeline's own philosophy: clustering only
// SURFACES candidates — a human makes the labeling decision.

import { embed } from '../labeling/embeddingService.js';

// Deterministic PRNG (mulberry32) so clustering is reproducible and testable.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

// MiniLM vectors are L2-normalized, so dot product IS cosine similarity and
// squared euclidean distance is 2-2cos — argmax-cosine and argmin-distance
// pick the same centroid. We work in cosine throughout.
function meanVector(vectors, dim) {
    const m = new Float64Array(dim);
    for (const v of vectors) for (let i = 0; i < dim; i++) m[i] += v[i];
    let norm = 0;
    for (let i = 0; i < dim; i++) { m[i] /= vectors.length; norm += m[i] * m[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) m[i] /= norm;
    return m;
}

/**
 * Seeded k-means++ over normalized embeddings, cosine similarity.
 * @param {Array<Float32Array|number[]>} vectors normalized embeddings
 * @param {number} k cluster count (clamped to vectors.length)
 * @param {{seed?: number, maxIter?: number}} opts
 * @returns {{assignments: number[], centroids: Float64Array[], k: number}}
 */
export function kmeansCosine(vectors, k, { seed = 42, maxIter = 25 } = {}) {
    const n = vectors.length;
    if (n === 0) return { assignments: [], centroids: [], k: 0 };
    k = Math.min(k, n);
    const dim = vectors[0].length;
    const rand = mulberry32(seed);

    // k-means++ init: first centroid random, then weight by squared distance
    // (1 - cos, since vectors are normalized) to the nearest chosen centroid.
    const centroids = [vectors[Math.floor(rand() * n)].slice()];
    while (centroids.length < k) {
        const weights = vectors.map(v => {
            let best = -1;
            for (const c of centroids) best = Math.max(best, dot(v, c));
            const d = Math.max(0, 1 - best);
            return d * d;
        });
        const total = weights.reduce((a, b) => a + b, 0);
        if (total === 0) { centroids.push(vectors[Math.floor(rand() * n)].slice()); continue; }
        let pick = rand() * total;
        let idx = 0;
        while (pick > weights[idx] && idx < n - 1) { pick -= weights[idx]; idx++; }
        centroids.push(vectors[idx].slice());
    }

    let assignments = new Array(n).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
            let bestC = 0, bestSim = -Infinity;
            for (let c = 0; c < k; c++) {
                const sim = dot(vectors[i], centroids[c]);
                if (sim > bestSim) { bestSim = sim; bestC = c; }
            }
            if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
        }
        for (let c = 0; c < k; c++) {
            const members = [];
            for (let i = 0; i < n; i++) if (assignments[i] === c) members.push(vectors[i]);
            if (members.length > 0) centroids[c] = meanVector(members, dim);
        }
        if (!changed) break;
    }
    return { assignments, centroids, k };
}

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
    'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'over', 'says', 'say', 'said',
    'that', 'the', 'their', 'this', 'to', 'was', 'were', 'will', 'with', 'after', 'amid',
    'up', 'down', 'new', 'more', 'than', 'how', 'why', 'what', 'who', 'not', 'no', 'you',
    'your', 'we', 'our', 'they', 'them', 'his', 'her', 'he', 'she', 'us', 'about', 'could',
    'would', 'should', 'may', 'might', 'been', 'being', 'also', 'just', 'out', 'off',
]);

function tokenize(text) {
    const words = String(text || '').toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
    const grams = [...words];
    for (let i = 0; i < words.length - 1; i++) grams.push(`${words[i]} ${words[i + 1]}`);
    return grams;
}

/**
 * c-TF-IDF: score each term by (frequency within the cluster) × log(total
 * clusters-with-term inverse). Distinctive cluster labels, no vectorizer lib.
 * @param {string[]} titles all titles
 * @param {number[]} assignments cluster index per title
 * @param {number} k cluster count
 * @param {number} topN terms per cluster
 * @returns {string[][]} topN terms per cluster
 */
export function topTermsPerCluster(titles, assignments, k, topN = 8) {
    const clusterTf = Array.from({ length: k }, () => new Map());
    const df = new Map(); // in how many clusters a term appears
    for (let i = 0; i < titles.length; i++) {
        const c = assignments[i];
        for (const term of tokenize(titles[i])) {
            clusterTf[c].set(term, (clusterTf[c].get(term) || 0) + 1);
        }
    }
    for (const tf of clusterTf) {
        for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    }
    return clusterTf.map(tf => {
        const scored = [...tf.entries()].map(([term, freq]) => ({
            term,
            score: freq * Math.log(1 + k / (df.get(term) || 1)),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topN).map(s => s.term);
    });
}

/**
 * Cluster rejected articles into reviewable template-candidate summaries.
 * @param {Array<{title: string, source?: string, rejection_reason?: string}>} rows
 * @param {{k?: number, minVolume?: number, embedFn?: Function, seed?: number}} opts
 *        embedFn injectable for tests (defaults to the shared MiniLM embed).
 * @returns {Promise<{clusters: Array, totalUnmatched: number, note?: string}>}
 *          clusters sorted largest-first: {count, topTerms, sampleTitles,
 *          rejectionReasons} per cluster.
 */
export async function discoverTemplateCandidates(rows, { k = 8, minVolume = 20, embedFn = embed, seed = 42 } = {}) {
    const items = (rows || []).filter(r => r && r.title && r.title.length > 15);
    if (items.length < minVolume) {
        return {
            clusters: [],
            totalUnmatched: items.length,
            note: `Only ${items.length} distinct rejected articles — need at least ${minVolume} for meaningful clusters.`,
        };
    }

    const vectors = [];
    for (const item of items) vectors.push(await embedFn(item.title));

    const effectiveK = Math.min(k, Math.floor(items.length / 3)) || 1;
    const { assignments } = kmeansCosine(vectors, effectiveK, { seed });
    const titles = items.map(i => i.title);
    const terms = topTermsPerCluster(titles, assignments, effectiveK);

    const clusters = [];
    for (let c = 0; c < effectiveK; c++) {
        const members = items.filter((_, i) => assignments[i] === c);
        if (members.length === 0) continue;
        const reasonCounts = {};
        for (const m of members) {
            const key = String(m.rejection_reason || 'unknown').replace(/\(.*\)|\d+(\.\d+)?/g, '').trim();
            reasonCounts[key] = (reasonCounts[key] || 0) + 1;
        }
        clusters.push({
            count: members.length,
            topTerms: terms[c],
            sampleTitles: members.slice(0, 3).map(m => m.title.slice(0, 120)),
            rejectionReasons: reasonCounts,
        });
    }
    clusters.sort((a, b) => b.count - a.count);
    return { clusters, totalUnmatched: items.length };
}
