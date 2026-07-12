// ── Extractive summarization via MiniLM embeddings ───────────────────
// No LLM, no API: picks the article's own most-representative sentences.
// Method: embed every sentence (local MiniLM), score each by cosine
// similarity to the document centroid (blended with the title embedding —
// news headlines are a strong topic prior), add a small lead bonus
// (inverted-pyramid: journalists front-load the key facts), then select
// with MMR so the picked sentences don't all restate the same fact.
// Selected sentences are returned in their original document order so the
// summary reads coherently. Runs ONLY for articles already promoted to
// alerts (caller-enforced) — a handful of embeds per scan, not per article.

import { embed } from './embeddingService.js';

// Guards against splitting on abbreviations and initials the regex below
// would otherwise treat as sentence ends ("U.S. wheat" is one sentence).
const ABBREV = /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Corp|Co|No|Fig|Gen|Col|U\.S|U\.K|U\.N|E\.U|a\.m|p\.m)\.$/i;

/**
 * Split article text into sentences. Pragmatic, not perfect: protects
 * common abbreviations and decimal numbers, which is what actually breaks
 * naive splitters on financial news ("prices rose 4.2% to $6.55 a bushel.").
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];
    const parts = cleaned.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g) || [cleaned];
    const sentences = [];
    for (const part of parts) {
        // No whitespace before this fragment means the previous "." wasn't a
        // sentence end — it was mid-token ("U." + "S.", "4." + "2%").
        const gluedToPrev = !/^\s/.test(part);
        const trimmed = part.trim();
        if (!trimmed) continue;
        const prev = sentences[sentences.length - 1];
        if (prev && gluedToPrev && sentences.length > 0 && parts[0] !== part) {
            sentences[sentences.length - 1] = prev + trimmed;
        } else if (prev && (ABBREV.test(prev) || /\b[A-Z]\.$/.test(prev))) {
            // Abbreviation/initial at the boundary: continue the sentence.
            sentences[sentences.length - 1] = `${prev} ${trimmed}`;
        } else {
            sentences.push(trimmed);
        }
    }
    return sentences;
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom ? dot / denom : 0;
}

function centroidOf(vectors) {
    const dim = vectors[0].length;
    const c = new Float64Array(dim);
    for (const v of vectors) for (let i = 0; i < dim; i++) c[i] += v[i];
    for (let i = 0; i < dim; i++) c[i] /= vectors.length;
    return c;
}

// Sentences worth considering: long enough to carry a fact, short enough to
// be a sentence rather than a mangled paragraph, and actually prose.
function isCandidate(s) {
    return s.length >= 40 && s.length <= 500 && /[a-z]/i.test(s) && !/^(copyright|©|all rights reserved|subscribe|sign up|read more|advertisement)/i.test(s);
}

/**
 * Extractive summary: the K most important, mutually non-redundant
 * sentences of the text, in original order.
 *
 * @param {string} text  full article text (plain, already HTML-stripped)
 * @param {object} opts
 * @param {string}   [opts.title]         article title — blended into relevance as a topic prior
 * @param {number}   [opts.maxSentences]  summary length in sentences (default 3)
 * @param {number}   [opts.maxCandidates] cap on sentences embedded, cost bound (default 40)
 * @param {Function} [opts.embedFn]       injectable for tests (defaults to shared MiniLM embed)
 * @param {number}   [opts.lambda]        MMR relevance/diversity tradeoff (default 0.72)
 * @returns {Promise<{summary: string, sentences: string[]}|null>} null when text has no usable sentences
 */
export async function summarizeExtractive(text, {
    title = '',
    maxSentences = 3,
    maxCandidates = 40,
    embedFn = embed,
    lambda = 0.72,
} = {}) {
    const candidates = splitSentences(text).filter(isCandidate).slice(0, maxCandidates);
    if (candidates.length === 0) return null;
    if (candidates.length <= maxSentences) {
        return { summary: candidates.join(' '), sentences: candidates };
    }

    const vectors = [];
    for (const s of candidates) vectors.push(await embedFn(s));
    const centroid = centroidOf(vectors);
    const titleVec = title ? await embedFn(title) : null;

    // Relevance: how central the sentence is to the document, nudged toward
    // the headline topic and toward the lead (news front-loads what matters).
    const n = candidates.length;
    const relevance = vectors.map((v, i) => {
        let r = cosine(v, centroid);
        if (titleVec) r = 0.85 * r + 0.15 * cosine(v, titleVec);
        return r + 0.04 * (1 - i / n);
    });

    // MMR: greedily pick the sentence maximizing relevance minus its worst
    // redundancy against what's already picked.
    const picked = [];
    const remaining = new Set(candidates.map((_, i) => i));
    while (picked.length < maxSentences && remaining.size > 0) {
        let bestIdx = -1, bestScore = -Infinity;
        for (const i of remaining) {
            let maxSim = 0;
            for (const p of picked) maxSim = Math.max(maxSim, cosine(vectors[i], vectors[p]));
            const score = lambda * relevance[i] - (1 - lambda) * maxSim;
            if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
        picked.push(bestIdx);
        remaining.delete(bestIdx);
    }

    picked.sort((a, b) => a - b); // restore document order for readability
    const sentences = picked.map(i => candidates[i]);
    return { summary: sentences.join(' '), sentences };
}
