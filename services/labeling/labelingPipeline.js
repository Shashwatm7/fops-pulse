// Orchestrates: embed (local) -> label (LLM) -> store (Postgres).
// Fully guarded: a labeling failure never throws into the caller (the news
// scanner), since labeling is additive intelligence, not core alerting.
import pLimit from 'p-limit';
import { embed } from './embeddingService.js';
import { label } from './labelingService.js';
import { saveLabels } from './labelStorageService.js';
import { labelingConfig as cfg } from '../../config/labeling.js';

function buildSnippet(article) {
    const title = article.title || '';
    const body = article.description || article.content || '';
    return `${title}. ${String(body).slice(0, 500)}`.trim();
}

/**
 * Label one accepted article.
 * @param {object} article  the accepted article (has title/description/url)
 * @param {object} ctx      { auditLogId, userId }
 */
export async function processArticle(article, ctx) {
    if (!cfg.enabled) return null;
    const snippet = buildSnippet(article);

    // Embedding is best-effort — if the local model fails, we still label.
    let embedding = null;
    try {
        embedding = await embed(snippet);
    } catch (err) {
        console.error('[LABELING] embed failed (continuing without vector):', err.message);
    }

    const labelOut = await label(snippet);

    const saved = await saveLabels(
        { auditLogId: ctx.auditLogId, userId: ctx.userId, snippet, title: article.title },
        embedding,
        labelOut
    );

    return {
        training: labelOut.result?.training || null,
        insights: labelOut.result?.insights || null,
        needsReview: saved?.needsReview,
    };
}

/**
 * Label a batch of accepted articles concurrently within the rate limit.
 * @param {Array<{article: object, ctx: object}>} items
 */
export async function processBatch(items) {
    if (!cfg.enabled) return { total: 0, labeled: 0, failed: 0, queued_for_review: 0, results: [] };

    const limit = pLimit(cfg.rateLimitPerMin);
    const settled = await Promise.allSettled(
        items.map(({ article, ctx }) => limit(() => processArticle(article, ctx)))
    );

    let labeled = 0, failed = 0, queued = 0;
    const results = [];
    for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) {
            labeled++;
            if (s.value.needsReview) queued++;
            results.push(s.value);
        } else {
            failed++;
        }
    }
    const summary = { total: items.length, labeled, failed, queued_for_review: queued };
    console.log('[LABELING] batch summary:', JSON.stringify(summary));
    return { ...summary, results };
}
