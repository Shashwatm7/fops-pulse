import { normalizeArticle } from './stages/1_normalize.js';
import { buildWatchlistProfile } from './stages/2_profile_builder.js';
import { applyRuleEngine } from './stages/3_rule_engine.js';
import { matchRegion } from './stages/4_region_matcher.js';
import { calculateRelevanceScore } from './stages/5_relevance_scorer.js';
import { applySemanticFilter } from './stages/6_semantic_filter.js';
import { verifyWithLLM } from './stages/7_llm_verifier.js';
import { applyMlClassifier } from './stages/6.5_ml_classifier.js';
import { classifyPriority } from './stages/8_priority_classifier.js';
import { isDuplicate } from './stages/9_deduplication.js';

export class NewsPipeline {
    constructor(config) {
        this.llmFn = config.llmFn || null;
        this.auditLogFn = config.auditLogFn || null;
        this.scoreThreshold = config.scoreThreshold || 60;
        this.llmThresholdLow = config.llmThresholdLow || 40;
        this.llmThresholdHigh = config.llmThresholdHigh || 60;
    }

    /**
     * Processes a single article against a user profile
     */
    async processArticle(rawArticle, userProfile, userAlertedSet) {
        // Stage 0 / 9: Deduplication (Moved up to prevent repeating rejected logs)
        const profileId = userProfile.user_id || userProfile.id || userProfile.userId;
        const titleKey = rawArticle.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
        const userArticleKey = `user:${profileId}:${titleKey}`;
        
        if (userAlertedSet.has(userArticleKey)) {
             return { accepted: false, reason: 'Duplicate article', stage: 9, score: 0 };
        }
        userAlertedSet.add(userArticleKey);

        // ── Extract Features for DB Analytics ──
        if (!rawArticle.extracted_features) {
            const signalTerms = ["shortage", "surplus", "delay", "disruption", "strike", "shutdown", "closure", "port", "freight", "shipping", "export", "import", "tariff", "sanction", "inventory", "stockpile", "production", "harvest", "yield", "weather", "drought", "flood", "heat", "demand", "price", "forecast", "capacity", "processing", "logistics", "supply chain", "procurement"];
            const valuePatterns = [
                /\$\s?\d+(?:\.\d+)?(?:\s?(?:billion|million|bn|mn|k))?/gi,
                /\b\d+(?:\.\d+)?\s?%/g,
                /\b\d+(?:\.\d+)?\s?(?:days?|weeks?|months?|years?|tonnes?|tons?|barrels?|bpd|mt|kg|km|miles?)\b/gi,
                /\b(?:Q[1-4]|20\d{2}|19\d{2})\b/g
            ];
            const fullTextRaw = `${rawArticle.title} ${rawArticle.description || rawArticle.summary || ''}`;
            const fullText = fullTextRaw.toLowerCase();
            const supply_signals = signalTerms.filter(term => fullText.includes(term)).slice(0, 5);
            let values = [];
            for (const p of valuePatterns) {
                const matches = fullTextRaw.match(p);
                if (matches) values.push(...matches);
            }
            values = [...new Set(values.map(v => v.trim()))].slice(0, 10);
            rawArticle.extracted_features = { supply_signals, values };
        }

        const doReturn = async (res) => {
            if (this.auditLogFn) {
                const userId = userProfile.user_id || userProfile.id || userProfile.userId;
                const stageToLog = res.accepted ? null : res.stage;
                await this.auditLogFn(userId, rawArticle, stageToLog, res.reason || null, res.score || null, res.accepted);
            }
            return res;
        };

        // Stage 1
        const article = normalizeArticle(rawArticle);

        // Stage 2
        const profile = buildWatchlistProfile(userProfile);

        // Stage 3
        const ruleCheck = applyRuleEngine(article, profile);
        if (!ruleCheck.passed) {
            console.log(`[USER-SCANNER] Rejected (Stage 3 - Rules): ${article.title} - ${ruleCheck.reason}`);
            return await doReturn({ accepted: false, reason: ruleCheck.reason, stage: 3 });
        }

        // Stage 4
        const regionCheck = matchRegion(article, profile);
        if (!regionCheck.passed) {
            console.log(`[USER-SCANNER] Rejected (Stage 4 - Region): ${article.title} - ${regionCheck.reason}`);
            return await doReturn({ accepted: false, reason: regionCheck.reason, stage: 4 });
        }

        // Stage 5
        const { score, breakdown } = calculateRelevanceScore(article, profile, ruleCheck.matchData);
        
        if (score < this.llmThresholdLow) {
            console.log(`[USER-SCANNER] Rejected (Stage 5 - Low Score ${score}): ${article.title}`);
            return await doReturn({ accepted: false, reason: `Score too low (${score})`, stage: 5, score });
        }

        let llmResult = null;

        // Stages 6 & 7 (Semantic & LLM for borderline)
        if (score >= this.llmThresholdLow && score < this.scoreThreshold) {
            // Stage 6 Semantic
            const semCheck = await applySemanticFilter(article, profile, score);
            if (!semCheck.passed) {
                console.log(`[USER-SCANNER] Rejected (Stage 6 - Semantic): ${article.title}`);
                return await doReturn({ accepted: false, reason: 'Failed semantic filter', stage: 6, score });
            }

            // Stage 6.5 ML TF-IDF Classifier (Spam Filter)
            const mlCheck = await applyMlClassifier(article);
            if (!mlCheck.passed) {
                console.log(`[USER-SCANNER] Rejected (Stage 6.5 - ML Spam Filter): ${article.title}`);
                return await doReturn({ accepted: false, reason: 'Classified as Spam by ML', stage: 6.5, score });
            }

            // Stage 7 LLM (Disabled per user request)
            llmResult = { relevant: true, reason: 'LLM Evaluation Disabled', impact: 'Medium' };
        }

        // Stage 8
        const priority = classifyPriority(score, llmResult);
        if (priority === 'Ignored') {
            console.log(`[USER-SCANNER] Rejected (Stage 8 - Ignored Priority): ${article.title}`);
            return await doReturn({ accepted: false, reason: 'Priority Ignored', stage: 8, score });
        }

        // Stage 9: Deduplication is now handled at the beginning of processArticle

        console.log(`[USER-SCANNER] Accepted! Score: ${score}, Priority: ${priority}. Title: ${article.title}`);

        return await doReturn({
            accepted: true,
            article: {
                ...rawArticle,
                priority,
                relevanceScore: score,
                breakdown,
                matchedRegions: regionCheck.regionMatches,
                llmReason: llmResult ? llmResult.reason : null
            },
            stage: 9
        });
    }
}
