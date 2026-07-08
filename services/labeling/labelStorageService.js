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
// Gold/silver/bronze (Part 8). Human review is ground truth (gold); a
// confident, specific LLM label is silver; everything else is bronze and
// must go to review before it can be trusted for training.
export function assignTier(training, source) {
    if (source === 'human_reviewed') return 'gold';
    if (training.relevant === 1 && training.confidence >= cfg.confidenceThreshold && training.category && training.category !== 'other') {
        return 'silver';
    }
    return 'bronze';
}

export async function saveLabels(ctx, embedding, labelOut) {
    const { auditLogId, userId, snippet, title } = ctx;
    const llm = labelOut.result;

    // A failed/invalid label still gets recorded (never skip logging a drop),
    // flagged for review with confidence 0.
    const training = llm?.training || {};
    const confidence = typeof training.confidence === 'number' ? training.confidence : 0.0;
    const relevant = training.relevant === 1 ? 1 : 0;
    const severity = cfg.severities.includes(training.severity) ? training.severity : null;
    const tier = assignTier({ ...training, confidence, relevant }, 'llm_auto');
    // Bronze is never training-grade — it must be reviewed/upgraded first.
    // Also review invalid labels and dropped (irrelevant) articles.
    const needsReview = labelOut.needsReview || tier === 'bronze' || relevant === 0;

    const vec = embedding ? toPgVector(embedding) : null;

    let trainingId = null;
    try {
        const { rows } = await pool.query(
            `INSERT INTO training_data
               (audit_log_id, user_id, text_snippet, embedding, relevant, category, severity, confidence, source, label_tier, needs_review)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'llm_auto',$9,$10)
             RETURNING id`,
            [auditLogId, userId, snippet, vec, relevant,
             training.category || null, severity, confidence, tier, needsReview]
        );
        trainingId = rows[0].id;
    } catch (err) {
        console.error('[LABELING] training_data insert failed:', err.message);
        return { ok: false, error: err.message };
    }

    // Insights only for relevant articles with a usable label. The rich
    // Aramtec-shaped insight is stored whole in insight_json; a few columns
    // are populated for easy querying.
    if (relevant === 1 && llm?.insights) {
        const ins = llm.insights;
        try {
            await pool.query(
                `INSERT INTO article_insights
                   (audit_log_id, user_id, summary, action_required, action_note, category, severity, urgency, insight_json)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [auditLogId, userId, ins.headline || null,
                 ins.action_required === true, ins.action_note || null,
                 training.category || null, severity, ins.urgency || null,
                 JSON.stringify(ins)]
            );
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

    console.log(`[LABELING] audit=${auditLogId} relevant=${relevant} category=${training.category || '-'} severity=${severity || '-'} tier=${tier} conf=${confidence.toFixed(2)} review=${needsReview}`);
    return { ok: true, trainingId, relevant, needsReview, tier, severity };
}
