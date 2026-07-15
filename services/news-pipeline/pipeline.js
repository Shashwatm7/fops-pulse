import { normalizeArticle } from './stages/1_normalize.js';
import { buildWatchlistProfile } from './stages/2_profile_builder.js';
import { applyRuleEngine } from './stages/3_rule_engine.js';
import { matchRegion } from './stages/4_region_matcher.js';
import { calculateRelevanceScore } from './stages/5_relevance_scorer.js';
import { applySemanticFilter, semanticSimilarity } from './stages/6_semantic_filter.js';
import { classifyPriority } from './stages/8_priority_classifier.js';
import { tuning } from '../tuning.js';

export class NewsPipeline {
    constructor(config) {
        this.llmFn = config.llmFn || null;
        this.auditLogFn = config.auditLogFn || null;
        this.scoreThreshold = config.scoreThreshold || 60;
        this.llmThresholdLow = config.llmThresholdLow || 40;
        this.llmThresholdHigh = config.llmThresholdHigh || 60;
        // 'off' lets tests exercise the deterministic stages without pulling
        // the local embedding model into CI.
        this.semanticEnabled = config.semantic !== 'off';
        // Semantic rescue lane: a keyword-rejected article (stages 3-5) gets
        // one similarity check against the customer's seeds, and is rescued
        // if unmistakably on-topic. 0.40 calibrated against real audit data
        // (Jul 2026): a genuinely-relevant rejected article ("ships reroute
        // around the Cape") scored 0.421 while the noise ceiling (restaurant
        // openings, local fires, sports) was 0.265. Above the stage-6 gate
        // (0.30) because rescue bypasses every keyword check. Injectable for
        // tests; env-tunable via SEMANTIC_RESCUE_THRESHOLD.
        this.rescueThreshold = config.rescueThreshold; // undefined -> read live tuning at rescue
        this.similarityFn = config.similarityFn || semanticSimilarity;
        // Rejection memo: userArticleKey → profile fingerprint of the profile
        // version that rejected it. Prevents re-LOGGING the same rejection on
        // every scan (RSS re-fetches the same articles all day) while still
        // RE-EVALUATING an article the moment the profile changes. This
        // replaces the old behavior of permanently poisoning the dedup set
        // with rejected articles — the single biggest false-negative source:
        // an article wrongly rejected once could never be reconsidered, even
        // after settings changes or pipeline fixes.
        this.rejectionMemo = new Map();
        this.rejectionMemoMax = config.rejectionMemoMax || 5000;
    }

    /**
     * Processes a single article against a user profile.
     * `userAlertedSet` contains keys of articles the user was actually
     * ALERTED about (accepted + inserted); this pipeline never mutates it —
     * ownership lives with the caller, which adds keys only after a
     * successful alert insert.
     */
    async processArticle(rawArticle, userProfile, userAlertedSet) {
        const profileId = userProfile.user_id || userProfile.id || userProfile.userId;
        const titleKey = rawArticle.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
        const userArticleKey = `user:${profileId}:${titleKey}`;
        const fingerprint = userProfile._fingerprint || 'static';

        const doReturn = async (res, { log = true } = {}) => {
            if (this.auditLogFn && log) {
                const uid = userProfile.user_id || userProfile.id || userProfile.userId;
                const stageToLog = res.accepted ? null : res.stage;
                // auditLogFn returns the inserted audit-log row id so the
                // labeling system can link training data to it.
                res.auditLogId = await this.auditLogFn(uid, rawArticle, stageToLog, res.reason || null, res.score ?? null, res.accepted);
            }
            return res;
        };

        // Already alerted for this exact article (this profile) — a real
        // duplicate. Not audit-logged: it was logged when it was accepted.
        if (userAlertedSet.has(userArticleKey) || userAlertedSet.has(titleKey)) {
            return { accepted: false, reason: 'Already alerted', stage: 9, score: 0, duplicate: true };
        }

        // Previously rejected under the SAME profile version — same input,
        // same deterministic pipeline, same outcome. Skip recompute and skip
        // the duplicate audit row. A changed profile falls through and gets
        // a fresh evaluation.
        if (this.rejectionMemo.get(userArticleKey) === fingerprint) {
            return { accepted: false, reason: 'Previously rejected (unchanged profile)', stage: 9, score: 0, memoized: true };
        }

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

        const memoizeRejection = () => {
            if (this.rejectionMemo.size >= this.rejectionMemoMax) {
                // FIFO trim: drop the oldest ~10% so a hot scanner never
                // grows memory unbounded.
                const drop = Math.ceil(this.rejectionMemoMax / 10);
                let i = 0;
                for (const k of this.rejectionMemo.keys()) {
                    this.rejectionMemo.delete(k);
                    if (++i >= drop) break;
                }
            }
            this.rejectionMemo.set(userArticleKey, fingerprint);
        };

        // Stage 1
        const article = normalizeArticle(rawArticle);

        // Stage 2
        const profile = buildWatchlistProfile(userProfile);

        // Semantic rescue: keyword gates (3-5) only see literal terms, so an
        // article phrased without any tracked keyword ("Iran ready to
        // escalate over Hormuz") dies even when it embeds on top of a seed
        // ("Houthi attacks force shipping lines to reroute…"). Before letting
        // a keyword rejection stand, check seed similarity once; rescue only
        // near-certain matches. Fails CLOSED — if embedding errors, the
        // original keyword rejection stands. Returns an accepted result or
        // null (rescue declined).
        const attemptRescue = async (rejectedStage) => {
            if (!this.semanticEnabled) return null;
            let sim = null;
            try {
                sim = await this.similarityFn(article, profile);
            } catch (err) {
                console.error('[USER-SCANNER] Rescue similarity failed (rejection stands):', err.message);
                return null;
            }
            const rescueThreshold = this.rescueThreshold ?? tuning.rescueThreshold;
            if (sim == null || sim < rescueThreshold) return null;

            // Similarity-derived score, floored at 60 (Medium): a rescue is a
            // judgment that this article matters despite no keyword — an
            // accepted-but-Low result would never alert, making the rescue
            // pointless. Real similarities cluster in 0.40-0.55 (calibration
            // above), so without the floor nearly every rescue would be Low.
            // Capped at 84 — a semantic-only match never mints Critical;
            // that stays keyword-verified.
            const rescueScore = Math.min(84, Math.max(60, Math.round(sim * 100)));
            const priority = classifyPriority(rescueScore, null);
            if (priority === 'Ignored') return null;

            const simStr = sim.toFixed(3);
            console.log(`[USER-SCANNER] Rescued (semantic ${simStr} ≥ ${rescueThreshold}, was stage ${rejectedStage}): ${article.title}`);
            return await doReturn({
                accepted: true,
                score: rescueScore,
                reason: `Semantic rescue: similarity ${simStr} to profile seeds (keyword stage ${rejectedStage} had rejected)`,
                article: {
                    ...rawArticle,
                    priority,
                    relevanceScore: rescueScore,
                    breakdown: { commodityScore: 0, businessScore: 0, regionScore: 0, semanticRescue: true, similarity: +simStr },
                    matchedRegions: [],
                    titleKey,
                    llmReason: `Matches your supply-chain profile by meaning (similarity ${simStr}) despite no tracked keyword in the text`,
                },
                stage: 9,
            });
        };

        // Prevetted = from a curated supply-chain-risk feed (Google Alerts).
        // Google already vetted topical relevance better than our keyword rule
        // engine can for this class of broad risk news, so these skip the
        // commodity/region/semantic gates below — but NEVER the blocklist.
        const prevetted = rawArticle.prevetted === true;

        // Stage 3
        const ruleCheck = applyRuleEngine(article, profile);
        if (!ruleCheck.passed) {
            // Blocklist kills are deliberate user configuration — applied even
            // to prevetted feeds.
            const isBlocklistKill = String(ruleCheck.reason || '').startsWith('Matched excluded context');
            if (isBlocklistKill) {
                console.log(`[USER-SCANNER] Rejected (Stage 3 - Blocklist): ${article.title} - ${ruleCheck.reason}`);
                memoizeRejection();
                return await doReturn({ accepted: false, reason: ruleCheck.reason, stage: 3 });
            }
            // Prevetted articles bypass the keyword commodity gate entirely.
            if (!prevetted) {
                const rescued = await attemptRescue(3);
                if (rescued) return rescued;
                console.log(`[USER-SCANNER] Rejected (Stage 3 - Rules): ${article.title} - ${ruleCheck.reason}`);
                memoizeRejection();
                return await doReturn({ accepted: false, reason: ruleCheck.reason, stage: 3 });
            }
        }

        // Stage 4 — region is a hard gate only for commodity-less articles;
        // tracked-commodity news soft-passes and is penalized by the scorer.
        // Prevetted risk news bypasses the region gate (broad-web risk stories
        // often don't name the user's exact region).
        const regionCheck = matchRegion(article, profile, ruleCheck.matchData);
        if (!regionCheck.passed && !prevetted) {
            const rescued = await attemptRescue(4);
            if (rescued) return rescued;
            console.log(`[USER-SCANNER] Rejected (Stage 4 - Region): ${article.title} - ${regionCheck.reason}`);
            memoizeRejection();
            return await doReturn({ accepted: false, reason: regionCheck.reason, stage: 4 });
        }

        // Stage 5
        let { score, breakdown } = calculateRelevanceScore(article, profile, ruleCheck.matchData);

        // Prevetted relevance floor: Google's curation is itself a strong
        // relevance signal. A curated supply-risk article enters at Medium
        // minimum (alertable). Region is TAKEN INTO ACCOUNT: the High floor
        // for a severe disruptor is granted only when the article also matches
        // one of the user's regions — a severe shock outside their geography
        // stays at Medium rather than being pinned High. (Region is a soft
        // factor here, not a hard gate: Google already vetted topical
        // relevance and the alert query is itself region-scoped, so we never
        // drop the article — we only decline to elevate it.)
        if (prevetted) {
            const regionOk = regionCheck.passed || (regionCheck.regionMatches || []).length > 0;
            score = Math.max(score, (breakdown.hasSevereDisruptor && regionOk) ? 70 : 60);
        }

        if (score < this.llmThresholdLow) {
            const rescued = await attemptRescue(5);
            if (rescued) return rescued;
            console.log(`[USER-SCANNER] Rejected (Stage 5 - Low Score ${score}): ${article.title}`);
            memoizeRejection();
            return await doReturn({ accepted: false, reason: `Score too low (${score})`, stage: 5, score });
        }

        let llmResult = null;

        // Stage 6: Semantic filter — runs for EVERY candidate, not just
        // borderline scores. Keyword scoring can be gamed by coincidental
        // word overlap; the local-embedding similarity check is the last
        // line of defense against those false positives, and it's free.
        // Prevetted feeds skip it: Google already vetted relevance, and a
        // food-seed similarity check would wrongly drop legit risk news (the
        // same class of miss as the copper/gold seed gap).
        // Cosine similarity of THIS article against the profile's seed vectors
        // (the user-expanded "query"). Computed for every keyword-survivor and
        // carried onto the accepted article as a first-class field, so it's
        // available downstream for ranking/alerting later — independent of the
        // gate. null for prevetted (they skip semantics) or seedless profiles.
        let semanticScore = null;
        if (this.semanticEnabled && !prevetted) {
            const semCheck = await applySemanticFilter(article, profile, score);
            semanticScore = semCheck.similarity;
            if (!semCheck.passed) {
                console.log(`[USER-SCANNER] Rejected (Stage 6 - Semantic ${semCheck.similarity}): ${article.title}`);
                memoizeRejection();
                return await doReturn({ accepted: false, reason: semCheck.reason || 'Failed semantic filter', stage: 6, score });
            }
        }

        // Stage 6.5 (frozen TF-IDF spam classifier) is RETIRED as a gate.
        // The committed model (no training data or trainer in the repo)
        // hard-rejected verifiably relevant articles — e.g. "Cargill Opens
        // New Dairy Feed Plant in India" and "Oat Shortages May Dictate
        // Starter Grain Alternatives" for a Dairy & Livestock / India user —
        // 34 such kills in the audit log. Its junk-filtering job is now done
        // by the global excluded contexts (stage 3) + the always-on semantic
        // filter (stage 6), both of which are inspectable and tunable.

        // Stage 7 LLM is disabled (tokens reserved for planner/deep-dive).
        // Leaving llmResult null so Stage 8 classifies priority purely
        // from the score.

        // Stage 8
        const priority = classifyPriority(score, llmResult);
        if (priority === 'Ignored') {
            console.log(`[USER-SCANNER] Rejected (Stage 8 - Ignored Priority): ${article.title}`);
            memoizeRejection();
            return await doReturn({ accepted: false, reason: 'Priority Ignored', stage: 8, score });
        }

        console.log(`[USER-SCANNER] Accepted! Score: ${score}, Priority: ${priority}. Title: ${article.title}`);

        return await doReturn({
            accepted: true,
            // Score included so accepted audit rows stop logging null.
            score,
            article: {
                ...rawArticle,
                priority,
                relevanceScore: score,
                breakdown,
                // Cosine similarity to the profile seeds (0-1), recorded on
                // every keyword-filtered article for downstream ranking/alerts.
                semanticSimilarity: semanticScore,
                // regionMatches is absent when a prevetted article bypassed a
                // failed region gate — default to [] so downstream .length is safe.
                matchedRegions: regionCheck.regionMatches || [],
                prevetted,
                titleKey,
                llmReason: llmResult ? llmResult.reason : null
            },
            stage: 9
        });
    }
}
