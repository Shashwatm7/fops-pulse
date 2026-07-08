// Persists labeling output across training_data, article_insights,
// insight_entities, and review_queue. Every decision is logged.
import { pool } from '../../db.js';
import { toPgVector } from './embeddingService.js';
import { labelingConfig as cfg } from '../../config/labeling.js';

/**
 * @param {object} ctx { auditLogId, userId, snippet, title }
 * @param {Float32Array|null} embedding  384-dim, or null if embedding failed
 * @param {object} labelOut  { result, needsReview, error } from labelingService
 */
export async function saveLabels(ctx, embedding, labelOut) {
    const { auditLogId, userId, snippet, title } = ctx;
    const llm = labelOut.result;

    // A failed/invalid label still gets recorded (never skip logging a drop),
    // flagged for review with confidence 0.
    const training = llm?.training || {};
    const confidence = typeof training.confidence === 'number' ? training.confidence : 0.0;
    const relevant = training.relevant === 1 ? 1 : 0;
    const needsReview = labelOut.needsReview
        || confidence < cfg.confidenceThreshold
        || relevant === 0; // always review the drops — cheapest way to catch false negatives

    const vec = embedding ? toPgVector(embedding) : null;

    let trainingId = null;
    try {
        const { rows } = await pool.query(
            `INSERT INTO training_data
               (audit_log_id, user_id, text_snippet, embedding, relevant, category, priority, confidence, source, needs_review)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'llm_auto',$9)
             RETURNING id`,
            [auditLogId, userId, snippet, vec, relevant,
             training.category || null, training.priority || null, confidence, needsReview]
        );
        trainingId = rows[0].id;
    } catch (err) {
        console.error('[LABELING] training_data insert failed:', err.message);
        return { ok: false, error: err.message };
    }

    // Insights + entities only for relevant articles with a usable label.
    if (relevant === 1 && llm?.insights) {
        const ins = llm.insights;
        try {
            const { rows } = await pool.query(
                `INSERT INTO article_insights
                   (audit_log_id, user_id, summary, sentiment, threat_level, opportunity, action_required, action_note, category, priority)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 RETURNING id`,
                [auditLogId, userId, ins.summary || null, ins.sentiment || null,
                 ins.threat_level || null, ins.opportunity || null,
                 ins.action_required === true, ins.action_note || null,
                 training.category || null, training.priority || null]
            );
            const insightId = rows[0].id;

            const ent = ins.entities || {};
            const rowsToInsert = [
                ...(ent.commodities || []).map(e => ['commodity', e.name, e.role]),
                ...(ent.regions || []).map(e => ['region', e.name, e.role]),
                ...(ent.organizations || []).map(e => ['organization', e.name, e.role]),
            ];
            for (const [type, name, role] of rowsToInsert) {
                if (!name) continue;
                await pool.query(
                    `INSERT INTO insight_entities (insight_id, entity_type, name, role) VALUES ($1,$2,$3,$4)`,
                    [insightId, type, String(name).slice(0, 255), role || null]
                );
            }
        } catch (err) {
            console.error('[LABELING] insights insert failed:', err.message);
        }
    }

    if (needsReview && trainingId) {
        try {
            await pool.query(
                `INSERT INTO review_queue (audit_log_id, training_id, user_id, title, snippet, llm_label, reviewed)
                 VALUES ($1,$2,$3,$4,$5,$6,FALSE)`,
                [auditLogId, trainingId, userId, title || null,
                 String(snippet || '').slice(0, 300), llm ? JSON.stringify(llm) : null]
            );
        } catch (err) {
            console.error('[LABELING] review_queue insert failed:', err.message);
        }
    }

    console.log(`[LABELING] audit=${auditLogId} relevant=${relevant} category=${training.category || '-'} priority=${training.priority || '-'} conf=${confidence.toFixed(2)} review=${needsReview}`);
    return { ok: true, trainingId, relevant, needsReview };
}
