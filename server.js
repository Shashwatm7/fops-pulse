// server.js — FOps Market Pulse v2 (Layer 4 Storage Architecture)
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import YahooFinance from 'yahoo-finance2';
import fs from 'fs';
import path from 'path';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import nlp from 'compromise';
import authRouter, { requireAuth, requireAdmin } from './auth.js';
import { tuning, TUNING_META, updateTuning } from './services/tuning.js';
import { NewsPipeline } from './services/news-pipeline/pipeline.js';
import { canonicalRegionName, buildWatchlistProfile } from './services/news-pipeline/stages/2_profile_builder.js';
import { effectiveSeeds, effectiveThreshold } from './services/news-pipeline/stages/6_semantic_filter.js';
import { fetchArticleText } from './services/news-pipeline/utils/nlp_extractor.js';
import { discoverTemplateCandidates } from './services/news-pipeline/discovery.js';
import { categorizeArticle } from './services/news-pipeline/categorizer.js';
import { classifyPriority } from './services/news-pipeline/stages/8_priority_classifier.js';
import { fetchCuratedFeeds } from './services/ingestion/curated_feeds.js';
import { matchEntities, entitiesToChips, REGION_CATALOG } from './services/news-pipeline/entity_matcher.js';
import { pool, getUserProfile, updateUserProfile, getAllUsers, getAllUserPriceAlerts, insertPriceTicksBatch, insertWeatherSnapshot, insertNewsEmbedding, getUnprocessedNews, updateNewsEmbedding, getPriceHistory, getWeatherHistory, searchSimilarNews, getRecentNewsEmbeddings, createSopPlan, getSopPlans, updateSopPlan, insertAiFeedback, getRecentAiFeedback, findUserById, insertPipelineAuditLog, getPipelineAuditLogs, getRejectedArticlesForDiscovery, appendCustomerTerm, insertAlert, getActiveAlerts, acknowledgeAlert, getRecentAlertsBySource, getAlertsSince, getAcceptedArticlesSince, getCustomerProfile, getCustomerProfileForUser, getInsightsForArticles, getRecentInsights, getRecentAcceptedArticles, getArticleSummaryCache, saveArticleSummaryCache, setWeatherRegions, setTrackedPorts, setTrackedCurrencies, setLastScanResult } from './db.js';
import { GCC_PORTS, DEFAULT_TRACKED_PORTIDS, isGccPort, lookupPort, ingestPortActivity, getPortActivity } from './services/ingestion/port_activity.js';
import { scoreAlertExposure, severityFromScore, severityFromPriority, applyAlertQuota } from './services/alert-relevance.js';
import { analyzePriceSeries, describeAnomaly, anomalyRelevanceScore } from './services/price-anomaly.js';
import { matchPrecedents, computeAftermath, summarizePrecedent, buildMatcherPrompt, parseMatcherResponse, normalizeEventText } from './services/precedent-engine.js';
import { findAnalogs, summarizeAnalogs } from './services/price-analogs.js';
import { summarizeArticle, extractLocalEntities, SUMMARY_VERSION } from './services/labeling/labelingService.js';
import { buildPlannerPrompt } from './services/planner/plannerService.js';
import { labelingConfig } from './config/labeling.js';
import { ALL_REGIONS, ALL_COMMODITIES } from './onboarding-templates.js';
import { composePage, PAGES } from './services/page-composer/index.js';
import { composeMarketPulse, MARKET_PULSE_KEYS, REQUESTABLE_KEYS } from './services/page-composer/aggregate.js';
import { runHybridAnalysis } from './algorithms.js';
import { runDeterministicEngine } from './deterministic-engine.js';
import { simulateLogistics } from './logistics-engine.js';
import { simulateUSDA } from './usda-engine.js';
import nodemailer from 'nodemailer';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import crypto from 'crypto';
if (fs.existsSync('/etc/secrets/.env')) { 
    dotenv.config({ path: '/etc/secrets/.env' }); 
} else if (fs.existsSync('/etc/secrets/.env')) { 
    dotenv.config({ path: '/etc/secrets/.env', override: true }); 
} else { 
    dotenv.config({ override: true }); 
}

const upload = multer({ storage: multer.memoryStorage() });

/// ── Nodemailer Setup ──
let transporter = {
    sendMail: (options, callback) => {
        console.log(`[EMAIL DISABLED] Blocked email to: ${options.to} (Subject: ${options.subject})`);
        if (callback) callback(null, { messageId: 'disabled' });
        return Promise.resolve({ messageId: 'disabled' });
    }
};

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false, logOptionsErrors: false } });

// Derived from ALL_COMMODITIES — the price fetcher tracks EVERY commodity with a
// yahooSymbol, including the Metals/Energy ones hidden from onboarding (those are
// filtered only in SELECTABLE_COMMODITIES). Users can only select commodities with
// a real Yahoo Finance futures feed. No proxies.
const YAHOO_SYMBOLS = Object.fromEntries(
    ALL_COMMODITIES.filter(c => c.yahooSymbol).map(c => [c.key, c.yahooSymbol])
);
const COMMODITY_UNITS = Object.fromEntries(
    ALL_COMMODITIES.map(c => [c.key, c.unit])
);

// Yahoo quotes CME/ICE grain, soft, and livestock futures in US cents; we
// display everything in DOLLARS, so these symbols get their raw quote divided
// by 100. Single source of truth = the `centsQuoted` flag in ALL_COMMODITIES.
// toDollars() is applied at every point a raw Yahoo value becomes user-facing
// or stored in livePrices, so the whole app is consistently in dollars.
const CENTS_SYMBOLS = new Set(
    ALL_COMMODITIES.filter(c => c.centsQuoted).map(c => c.key)
);
const toDollars = (symbol, v) =>
    (v != null && Number.isFinite(v) && CENTS_SYMBOLS.has(symbol)) ? v / 100 : v;

const COMMODITY_DATA = {
    BRENT_CRUDE:  { price: '0', unit: 'USD/bbl', producers: ['Saudi Arabia', 'USA', 'Russia', 'UAE', 'Oman'], regions: [], currencies: ['USD', 'SAR', 'AED', 'OMR'] }
};

let lastAnalysis = null;
let lastAnalysisTime = null;

const TRACKED_FILE = path.join(process.cwd(), 'tracked.json');

function loadTracked() {
    if (fs.existsSync(TRACKED_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(TRACKED_FILE, 'utf-8'));
            if (data.symbols) {
                for (const [sym, ticker] of Object.entries(data.symbols)) {
                    YAHOO_SYMBOLS[sym] = ticker;
                }
            }
            if (data.commodities) {
                for (const [sym, cdata] of Object.entries(data.commodities)) {
                    COMMODITY_DATA[sym] = cdata;
                }
            }
        } catch (e) {
            console.error("Error loading tracked.json", e);
        }
    }
}
loadTracked();

function saveTracked(symbol, ticker, cdata) {
    let data = { symbols: {}, commodities: {} };
    if (fs.existsSync(TRACKED_FILE)) {
        try { data = JSON.parse(fs.readFileSync(TRACKED_FILE, 'utf-8')); } catch (e) {}
    }
    data.symbols[symbol] = ticker;
    data.commodities[symbol] = cdata;
    fs.writeFileSync(TRACKED_FILE, JSON.stringify(data, null, 2));
}

const app = express();
app.set('trust proxy', 1); // Trust Render's reverse proxy
app.use(cors({ 
    origin: function(origin, callback) {
        // Allow same-origin (no origin header), localhost dev, and Render domain
        if (!origin || origin.includes('localhost') || origin.includes('onrender.com')) {
            callback(null, true);
        } else {
            callback(null, true); // Allow all for now
        }
    }, 
    credentials: true 
}));
app.use(express.json({ limit: '10mb' }));

// ── Tolerate quote characters pasted into a URL ─────────────
// Copying a quoted curl command out of chat or a terminal regularly leaves a
// trailing " or ' on the URL, which arrives here percent-encoded:
//
//   GET /api/market-pulse/indicators%22   -> 404, "No such API endpoint"
//
// A quote is never a legitimate part of one of our paths, and the resulting
// 404 sends people hunting for a server problem that does not exist. Strip
// them from the PATH only -- the query string is left alone, because a quote
// there can be real (a search term), and only from the ends, so a genuinely
// wrong path still 404s.
app.use((req, _res, next) => {
    const qIdx = req.url.indexOf('?');
    const path = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
    const query = qIdx === -1 ? '' : req.url.slice(qIdx);
    const cleaned = path.replace(/(?:%22|%27|["'])+$/i, '');
    if (cleaned !== path) {
        console.warn(`[URL] Stripped trailing quote from ${path} -> ${cleaned}`);
        req.url = cleaned + query;
    }
    next();
});

// ── Session middleware (PostgreSQL-backed) ──────────────────
const PgStore = pgSession(session);
app.use(session({
    store: new PgStore({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'fops-market-pulse-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' || !!process.env.RENDER }, // 24 hours
}));

// ── Auth routes (no auth required) ──────────────────────────
app.use('/api/auth', authRouter);

// ── Liveness probe (no auth) ────────────────────────────────
// Must sit ABOVE express.static and the SPA catch-all: that catch-all answers
// EVERY unmatched path with 200 + index.html, so a probe pointed anywhere else
// would pass even when this process is broken. Deliberately shallow — no DB
// round-trip — so a transient Postgres blip cannot make Container Apps kill
// and restart an otherwise healthy replica.
app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok: true, service: 'fops-pulse', uptime: process.uptime() });
});

// Readiness DOES touch Postgres. Used for post-deploy verification and as the
// startup probe, NOT as the liveness probe, for the reason above.
app.get('/readyz', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        await pool.query('SELECT 1');
        res.status(200).json({ ok: true, db: 'up' });
    } catch (err) {
        res.status(503).json({ ok: false, db: 'down', error: err.message });
    }
});

// NOTE: never add endpoints that echo process.env values — a debug route
// here once returned the raw GROQ_API_KEY unauthenticated.
app.get('/api/token-usage', requireAuth, (req, res) => {
    res.json(tokenUsage);
});

app.get('/api/rate-limits', requireAuth, (req, res) => {
    res.json(global.apiRateLimits || { remaining: 'N/A', reset: 'N/A' });
});

// ── AI health probe ──────────────────────────────────────────
// Answers "is the AI layer actually working?" — the question token-usage
// cannot answer, because it only counts successes. Returns 503 when a
// provider is hard-down (model decommissioned or key rejected) so an uptime
// check can page on it instead of the failure sitting unnoticed in logs.
app.get('/api/health/ai', requireAuth, (req, res) => {
    const hardDown = [];
    for (const [provider, c] of Object.entries(aiFailures.byProvider)) {
        if (c.modelMissing > 0) hardDown.push(`${provider}: model missing/decommissioned (${c.modelMissing})`);
        if (c.auth > 0) hardDown.push(`${provider}: auth rejected (${c.auth})`);
    }
    const totalFailures = Object.values(aiFailures.byProvider).reduce((n, c) => n + c.total, 0);
    res.status(hardDown.length ? 503 : 200).json({
        success: hardDown.length === 0,
        status: hardDown.length ? 'degraded' : 'ok',
        hardDown,
        configuredModels: {
            groqReasoning: GROQ_MODEL_REASONING,
            groqSummary: labelingConfig.models.groq,
            gemini: 'gemini-2.5-flash',
            geminiEmbedding: EMBEDDING_MODEL,
        },
        groqKeysConfigured: GROQ_KEYS.length,
        successfulCalls: tokenUsage.totalCalls,
        totalFailures,
        failuresByProvider: aiFailures.byProvider,
        recentFailures: aiFailures.recent.slice(0, 10),
        since: aiFailures.since,
    });
});

// ── Admin: ACTIVE model probe ────────────────────────────────
// /api/health/ai is passive — it reports failures that already happened, so a
// freshly-booted instance looks healthy whether the models work or not. This
// endpoint actually CALLS each configured model, which is the only way to
// verify a deploy against the keys Render holds (npm run check:models reads a
// local .env and says nothing about production).
// Costs a few hundred tokens per run; admin-gated and never on a timer.
app.get('/api/admin/check-models', requireAuth, requireAdmin, async (req, res) => {
    const checks = [];
    const probe = async (name, model, fn) => {
        const started = Date.now();
        try {
            const detail = await fn();
            checks.push({ name, model, ok: true, ms: Date.now() - started, detail });
        } catch (err) {
            checks.push({
                name, model, ok: false, ms: Date.now() - started,
                kind: classifyAiError(err),
                error: String(err?.response?.data?.error?.message || err?.message || err).slice(0, 300),
            });
        }
    };

    await probe('groq-reasoning', GROQ_MODEL_REASONING, async () => {
        const raw = await callGroq(GROQ_MODEL_REASONING, 'You are a JSON API. Return ONLY {"ok":true}.', 'Reply with the required JSON.', true, 64, 0, 'planner');
        const parsed = JSON.parse(raw);
        return `json_object honoured (${JSON.stringify(parsed).slice(0, 40)})`;
    });

    await probe('groq-summary', labelingConfig.models.groq, async () => {
        // Exercise the summary model through the same client the feature uses.
        const result = await summarizeArticle(
            { title: 'Health probe: wheat export restriction', description: null, source: 'probe' },
            { commodities: ['Wheat'], ports: [], routes: [], supplier_countries: [], regions: [], chokepoints: [] },
            null,
            'A health-check article body. India restricted wheat exports on 12 May 2026, removing 3.2 million tonnes from global supply, and benchmark futures rose 6.4 percent in response to the announcement.'
        );
        return `summary+impact validated, ${result.key_figures.length} grounded figure(s)`;
    });

    await probe('gemini-chat', 'gemini-2.5-flash', async () => {
        const raw = await callGeminiFlash('You are a JSON API. Return ONLY {"ok":true}.', 'Reply with the required JSON.', true, 64, 0);
        JSON.parse(raw);
        return 'JSON mime honoured';
    });

    await probe('gemini-embedding', EMBEDDING_MODEL, async () => {
        const vec = await generateEmbedding('health probe: wheat export ban');
        if (!Array.isArray(vec)) throw new Error('no vector returned');
        return `${vec.length} dims`;
    });

    const failed = checks.filter(c => !c.ok);
    res.status(failed.length ? 503 : 200).json({
        success: failed.length === 0,
        summary: `${checks.length - failed.length}/${checks.length} model checks passed`,
        checks,
        // Which env the probe actually ran against — the whole point of the
        // endpoint is that this may differ from any local .env.
        groqKeysConfigured: GROQ_KEYS.length,
        embeddingsEnabled: GEMINI_EMBEDDINGS_ENABLED,
        checkedAt: new Date().toISOString(),
    });
});

// ── Admin: runtime tuning (Rocchio γ, thresholds, LLM temp) ──────
// Runtime-only: values apply on the next scan/analyze but reset to env
// defaults on restart. Admin-gated.
app.get('/api/admin/tuning', requireAuth, requireAdmin, (req, res) => {
    res.json({ success: true, values: { ...tuning }, meta: TUNING_META });
});
app.post('/api/admin/tuning', requireAuth, requireAdmin, (req, res) => {
    const applied = updateTuning(req.body || {});
    console.log(`[TUNING] ${req.user.username} updated:`, applied);
    res.json({ success: true, applied, values: { ...tuning } });
});
// Expanded-query preview: the EXACT positive seed set + threshold the stage-6
// semantic gate will use for a given user — customer graft included, same code
// path as the scanner (applyCustomerGraft → buildWatchlistProfile).
app.get('/api/admin/tuning/seeds-preview/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.userId);
        const profile = await getUserProfile(userId);
        if (!profile) return res.status(404).json({ success: false, error: 'No profile for that user' });
        let customerId = null;
        if (profile.customer_id) {
            const customer = await getCustomerProfile(profile.customer_id);
            if (customer) { applyCustomerGraft(profile, customer); customerId = customer.id; }
        }
        const watchlist = buildWatchlistProfile(profile);
        res.json({
            success: true,
            userId,
            customerId,
            profileSeeds: watchlist.mlSeeds,          // per-user expanded query
            extraSeeds: tuning.extraSeeds,            // admin-added global seeds
            effectiveSeeds: effectiveSeeds(watchlist),// what the gate actually compares against
            effectiveThreshold: effectiveThreshold(watchlist),
            noiseSeeds: tuning.noiseSeeds,
            rocchioGamma: tuning.rocchioGamma,
        });
    } catch (err) {
        console.error('[TUNING] seeds preview failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Groq API key POOL: GROQ_API_KEY may hold several comma-separated keys (one
// per Groq account). Dividing tasks across keys spreads load over separate
// rate-limit budgets. Each task is pinned to a key (below), so a task's load
// lands on one account and the same task always uses the same key. With a
// single key, every task shares it (original behavior).
const GROQ_KEYS = (process.env.GROQ_API_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
// Task -> key index. Extend as you add keys; wraps (mod) when you have fewer
// keys than tasks. Keep this in sync with LABELING_GROQ_KEY_INDEX for summaries.
// callGroq tries this task's key FIRST, then rotates through the rest of the
// pool on rate-limit (see callGroq). With N keys the preferred index wraps mod N.
const GROQ_TASK_KEY = { planner: 0, deepdive: 1, summary: 2, drivers: 3, precedent: 4 };

// Groq models, env-overridable. Providers decommission models with little
// notice — when that happens the call 404s and the feature is simply down, so
// these must be swappable without a code change. Verify a candidate with
// `npm run check:models` before switching: it confirms the model exists on the
// configured key AND honours response_format:json_object, which every caller
// here depends on. (llama-3.3-70b-versatile / llama-3.1-8b-instant were the
// previous defaults and are now decommissioned on Groq.)
const GROQ_MODEL_REASONING = process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b';

// ── OpenAI-compatible provider (Azure AI Foundry, OpenAI, or any /v1 host) ──
// Set LLM_PROVIDER=openai to route the planner, deep-dive and analysis through
// OPENAI_BASE_URL instead of Groq. Groq's endpoint is itself OpenAI-compatible
// (api.groq.com/openai/v1/chat/completions), so the request and response shapes
// are identical -- only the host, key and model differ. That is why this is a
// branch inside callGroq rather than a parallel client.
//
// Azure AI Foundry exposes .../openai/v1 specifically as the OpenAI-compatible
// surface: Bearer auth, no api-version query string. A classic Azure OpenAI
// resource (.openai.azure.com/openai/deployments/<d>/chat/completions?api-version=)
// is NOT this shape and will 404 here.
//
// No key pool and no circuit breaker on this path: those exist to rotate
// across three free-tier Groq accounts. One paid endpoint needs neither.
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || '').trim().replace(/\/+$/, '');
const OPENAI_MODEL = (process.env.OPENAI_MODEL || '').trim();
const OPENAI_ENABLED =
    (process.env.LLM_PROVIDER || '').toLowerCase() === 'openai'
    && !!OPENAI_API_KEY && !!OPENAI_BASE_URL && !!OPENAI_MODEL;

if ((process.env.LLM_PROVIDER || '').toLowerCase() === 'openai' && !OPENAI_ENABLED) {
    console.warn('[LLM] LLM_PROVIDER=openai but OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL is incomplete — falling back to Groq.');
} else if (OPENAI_ENABLED) {
    console.log(`[LLM] Provider: openai (${OPENAI_MODEL} @ ${OPENAI_BASE_URL})`);
}
const COMMODITY_KEY = process.env.COMMODITY_API_KEY;
const EIA_KEY = process.env.EIA_API_KEY;

const envInt = (name, fallback) => {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

const envMs = (name, fallback) => envInt(name, fallback);

// Hard ceiling on any single LLM HTTP call. axios defaults to NO timeout, so
// without this a hung provider socket pins an Express request open forever.
const LLM_TIMEOUT_MS = envMs('LLM_TIMEOUT_MS', 45000);

const BACKGROUND_AI_ENABLED = process.env.ENABLE_BACKGROUND_AI === 'true';
const GEO_SCANNER_ENABLED = process.env.ENABLE_GEO_SCANNER === 'true';
const USER_SCANNER_ENABLED = process.env.ENABLE_USER_SCANNER === 'true';
const AI_WORKER_ENABLED = process.env.ENABLE_AI_WORKER === 'true';
const AI_FORECASTER_ENABLED = process.env.ENABLE_AI_FORECASTER === 'true';

const GEMINI_EMBEDDINGS_ENABLED = process.env.ENABLE_GEMINI_EMBEDDINGS !== 'false';
const LIVE_SEMANTIC_FILTER_ENABLED = false;
const GEO_SEMANTIC_FILTER_ENABLED = false;
const USER_SCANNER_EMBEDDINGS_ENABLED = false;
const USER_SCANNER_AI_REVIEW_ENABLED = false;

const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
const EMBEDDING_OUTPUT_DIMENSIONS = envInt('GEMINI_EMBEDDING_DIMENSIONS', 768);
const EMBEDDING_DAILY_BUDGET = envInt('GEMINI_EMBEDDING_DAILY_BUDGET', 200);
const EMBEDDING_COOLDOWN_MS = envMs('GEMINI_EMBEDDING_COOLDOWN_MS', 60 * 60 * 1000);
const EMBEDDING_CACHE_LIMIT = envInt('GEMINI_EMBEDDING_CACHE_LIMIT', 500);

const GEO_SCAN_INTERVAL_MS = envMs('GEO_SCAN_INTERVAL_MS', 30 * 60 * 1000);
const USER_SCAN_INTERVAL_MS = envMs('USER_SCAN_INTERVAL_MS', 30 * 60 * 1000);
const AI_WORKER_INTERVAL_MS = envMs('AI_WORKER_INTERVAL_MS', 2 * 60 * 60 * 1000);
const AI_FORECAST_INTERVAL_MS = envMs('AI_FORECAST_INTERVAL_MS', 2 * 60 * 60 * 1000);

const MAX_NEWS_SEMANTIC_ARTICLES = envInt('MAX_NEWS_SEMANTIC_ARTICLES', 20);
const MAX_USER_SCANNER_CANDIDATES = envInt('MAX_USER_SCANNER_CANDIDATES', 10);
const MAX_USER_SCANNER_ALERTS = envInt('MAX_USER_SCANNER_ALERTS', 4);
// Minimum priority for a news article to become an alert at all. An alert is
// a "you should act" signal — Low-scoring articles (score 40-59) are noise at
// alert altitude, so they are never generated (the display quota drops LOW
// too, but gating here also avoids the wasted article-fetch/NLP + email).
const ALERTABLE_PRIORITIES = new Set(['Critical', 'High', 'Medium']);

// ── Token Usage Tracking ─────────────────────────────────────
let tokenUsage = { groqInput: 0, groqOutput: 0, geminiInput: 0, geminiOutput: 0, openaiInput: 0, openaiOutput: 0, totalCalls: 0, since: new Date().toISOString() };

// ── AI failure tracking ──────────────────────────────────────
// tokenUsage only counts SUCCESSES, so a provider that is 100% failing looks
// identical to one that is simply idle. That blind spot is how three
// decommissioned Groq models stayed broken unnoticed. Every LLM failure is
// classified and counted here, and exposed at GET /api/health/ai.
export const aiFailures = {
    since: new Date().toISOString(),
    byProvider: {},   // provider -> { total, rateLimit, modelMissing, auth, timeout, badOutput, other }
    recent: [],       // last 25 failures, newest first
};

const BLANK_FAILURE_COUNTS = () => ({ total: 0, rateLimit: 0, modelMissing: 0, auth: 0, timeout: 0, badOutput: 0, other: 0 });

// Classify so "rate limited" (expected, self-healing) is never confused with
// "model decommissioned" or "key revoked" (needs a human, right now).
export function classifyAiError(err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error?.message || err?.message || '';
    if (status === 429 || /rate.?limit|quota|too many requests|try again in/i.test(msg)) return 'rateLimit';
    if (status === 404 || /does not exist|do not have access|decommissioned|model_not_found/i.test(msg)) return 'modelMissing';
    if (status === 401 || status === 403 || /invalid api key|api key not valid|unauthorized|permission/i.test(msg)) return 'auth';
    if (/ECONNABORTED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|timeout/i.test(err?.code || msg)) return 'timeout';
    if (/no usable text|non-JSON|not valid JSON|unexpected token|invalid shape|returned no/i.test(msg)) return 'badOutput';
    return 'other';
}

export function recordAiFailure(provider, model, err) {
    const kind = classifyAiError(err);
    const bucket = aiFailures.byProvider[provider] || (aiFailures.byProvider[provider] = BLANK_FAILURE_COUNTS());
    bucket.total++;
    bucket[kind]++;
    aiFailures.recent.unshift({
        at: new Date().toISOString(),
        provider,
        model,
        kind,
        status: err?.response?.status ?? null,
        message: String(err?.response?.data?.error?.message || err?.message || '').slice(0, 200),
    });
    if (aiFailures.recent.length > 25) aiFailures.recent.length = 25;

    // modelMissing and auth are never transient — they mean the feature is
    // hard-down until someone changes config. Make them impossible to miss.
    if (kind === 'modelMissing' || kind === 'auth') {
        console.error(`[AI-HEALTH] ACTION REQUIRED — ${provider}/${model} ${kind}: ${aiFailures.recent[0].message}`);
    }
}



// Transient = worth retrying on the same key: rate limits, provider 5xx, and
// socket-level failures (timeout / reset / DNS). A 400/401/403 is a config or
// prompt error that will fail identically on every attempt.
function isGeminiTransient(err) {
    const status = err.response?.status;
    if (status === 429 || (status >= 500 && status <= 599)) return true;
    if (!err.response && /ECONNABORTED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|timeout/i.test(err.code || err.message || '')) return true;
    return false;
}

export async function callGeminiFlash(systemPrompt, userContent, jsonMode = true, maxTokens = 1500, temperature = 0.1) {
    if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let sysInstruction = systemPrompt;
            let jsonConfig = {};
            if (jsonMode) {
                jsonConfig = { responseMimeType: "application/json" };
                sysInstruction += "\nIMPORTANT: Return ONLY valid JSON matching the schema. No markdown, no backticks.";
            }
            
            const { data } = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                {
                    systemInstruction: { parts: [{ text: sysInstruction }] },
                    contents: [{ parts: [{ text: userContent }] }],
                    generationConfig: {
                        temperature: temperature,
                        maxOutputTokens: maxTokens,
                        // gemini-2.5-flash is a thinking model: without this,
                        // internal reasoning eats maxOutputTokens and small
                        // requests (e.g. the 16-token precedent classifier)
                        // return empty (finishReason MAX_TOKENS). Disable it.
                        thinkingConfig: { thinkingBudget: 0 },
                        ...jsonConfig
                    }
                },
                { timeout: LLM_TIMEOUT_MS }
            );

            const gemUsage = data.usageMetadata;
            if (gemUsage) { tokenUsage.geminiInput += gemUsage.promptTokenCount || 0; tokenUsage.geminiOutput += gemUsage.candidatesTokenCount || 0; tokenUsage.totalCalls++; }

            // Guard the envelope: a safety-blocked or truncated completion comes
            // back with no candidate/parts, and blind indexing turns that into an
            // opaque "cannot read properties of undefined" TypeError.
            const candidate = data.candidates?.[0];
            let text = candidate?.content?.parts?.[0]?.text;
            if (typeof text !== 'string') {
                const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'no candidate returned';
                throw new Error(`Gemini returned no usable text (finishReason: ${reason})`);
            }
            if (jsonMode) {
                text = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
            }
            return text;
        } catch (err) {
            const detail = err.response?.data?.error?.message || err.message;
            const transient = isGeminiTransient(err);
            recordAiFailure('gemini', 'gemini-2.5-flash', err);
            if (!transient || attempt === maxRetries) {
                console.error(`[GEMINI] API Error (attempt ${attempt}/${maxRetries}, ${transient ? 'transient, giving up' : 'permanent'}): ${detail}`);
                throw err;
            }
            // Exponential backoff: 500ms, 1000ms.
            const backoff = 500 * attempt;
            console.warn(`[GEMINI] transient error (attempt ${attempt}/${maxRetries}), retrying in ${backoff}ms: ${detail}`);
            await new Promise(r => setTimeout(r, backoff));
        }
    }
    // Unreachable: the loop either returns or throws on the final attempt.
    throw new Error('Gemini call exhausted all retries');
}

// Is this Groq error a rate-limit / quota error (vs. a real request/model
// error that retrying on another key won't fix)?
function isGroqRateLimit(err) {
    if (err.response?.status === 429) return true;
    const m = err.response?.data?.error?.message || err.message || '';
    return /rate.?limit|quota|too many requests|try again in/i.test(m);
}

// Parse Groq's "Please try again in 1m2.5s" into ms so we can open that key's
// breaker for exactly that long (default 60s when unparseable).
function groqRetryMs(errMsg) {
    const match = (errMsg || '').match(/try again in (.*?)(?:\.|$)/i);
    if (!match) return 60000;
    let ms = 0;
    const min = match[1].match(/([\d.]+)m/);
    const sec = match[1].match(/([\d.]+)s/);
    if (min) ms += parseFloat(min[1]) * 60000;
    if (sec) ms += parseFloat(sec[1]) * 1000;
    return ms > 0 ? ms : 60000;
}

export async function callGroq(model, systemPrompt, userContent, jsonMode = true, maxTokens = 1500, temperature = 0.1, task = null) {
    // Groq-only path (planner recommendations + deep-dive). NO degraded fallback:
    // not Gemini, not a smaller Groq model, not canned text. But we DO rotate
    // across the key pool — same model on every key, just a different account's
    // rate-limit budget. The task's pinned key is tried FIRST (preserves load
    // distribution); if its breaker is open or it 429s, we fail over to the next
    // pool key whose breaker is closed. Only when EVERY key is rate-limited does
    // the error propagate to the route.
    // OpenAI-compatible provider takes precedence when fully configured. Same
    // wire format as Groq, so the caller's prompts, jsonMode and token budget
    // carry over unchanged; only the host, key and model differ. The `model`
    // argument (a Groq model id) is replaced by OPENAI_MODEL -- a deployment
    // name on one host is meaningless on the other.
    if (OPENAI_ENABLED) {
        const finalUser = jsonMode ? userContent + "\n\nOutput ONLY valid JSON." : userContent;
        try {
            const response = await axios.post(
                `${OPENAI_BASE_URL}/chat/completions`,
                {
                    model: OPENAI_MODEL,
                    // gpt-5-class models reject `max_tokens` outright:
                    //   "Unsupported parameter: 'max_tokens' is not supported
                    //    with this model. Use 'max_completion_tokens' instead."
                    // They also fix temperature at 1 and reject any other
                    // value, so it is omitted here rather than sent and
                    // rejected. OPENAI_TEMPERATURE forces it back for an older
                    // deployment that does accept it.
                    max_completion_tokens: maxTokens,
                    ...(process.env.OPENAI_TEMPERATURE !== undefined
                        && { temperature: Number(process.env.OPENAI_TEMPERATURE) }),
                    ...(jsonMode && { response_format: { type: 'json_object' } }),
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: finalUser },
                    ],
                },
                { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: LLM_TIMEOUT_MS }
            );
            const usage = response.data.usage;
            if (usage) {
                tokenUsage.openaiInput += usage.prompt_tokens || 0;
                tokenUsage.openaiOutput += usage.completion_tokens || 0;
                tokenUsage.totalCalls++;
            }
            console.log(`[TOKENS] OpenAI ${OPENAI_MODEL} | in:${usage?.prompt_tokens ?? '?'} out:${usage?.completion_tokens ?? '?'}`);

            // Same envelope guard as the Groq path: a filtered or truncated
            // completion returns no choice, and blind indexing turns that into
            // an opaque TypeError rather than a named provider failure.
            const content = response.data.choices?.[0]?.message?.content;
            if (typeof content !== 'string') {
                const reason = response.data.choices?.[0]?.finish_reason || 'no choice returned';
                throw new Error(`OpenAI ${OPENAI_MODEL} returned no usable content (finish_reason: ${reason})`);
            }
            return content;
        } catch (err) {
            recordAiFailure('openai', OPENAI_MODEL, err);
            // Deliberately NOT falling through to Groq: a silent provider swap
            // hides a broken endpoint and bills the wrong account. Fail loudly.
            throw new Error(`OpenAI call failed: ${err.response?.data?.error?.message || err.message}`);
        }
    }

    if (GROQ_KEYS.length === 0) throw new Error('Missing GROQ_API_KEY');
    if (!global.aiCircuitBreakers) global.aiCircuitBreakers = {};

    const preferredIdx = (GROQ_TASK_KEY[task] ?? 0) % GROQ_KEYS.length;
    const orderedKeys = [GROQ_KEYS[preferredIdx], ...GROQ_KEYS.filter((_, i) => i !== preferredIdx)];
    const now = Date.now();
    const candidates = orderedKeys.filter(k => !(global.aiCircuitBreakers[k] && now < global.aiCircuitBreakers[k]));
    if (candidates.length === 0) {
        throw new Error('Groq circuit-breaker active for all keys (rate limited); retry later.');
    }

    const finalUserContent = jsonMode ? userContent + "\n\nOutput ONLY valid JSON." : userContent;
    let lastErr = null;

    for (let i = 0; i < candidates.length; i++) {
        const KEY = candidates[i];
        try {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model,
                    max_tokens: maxTokens,
                    temperature: temperature,
                    ...(jsonMode && { response_format: { type: 'json_object' } }),
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: finalUserContent },
                    ],
                },
                { headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' }, timeout: LLM_TIMEOUT_MS }
            );
            const usage = response.data.usage;
            if (usage) { tokenUsage.groqInput += usage.prompt_tokens || 0; tokenUsage.groqOutput += usage.completion_tokens || 0; tokenUsage.totalCalls++; }

            const remaining = response.headers['x-ratelimit-remaining-requests'];
            const reset = response.headers['x-ratelimit-reset-requests'];
            if (remaining !== undefined && reset !== undefined) {
                global.apiRateLimits = { remaining, reset, lastUpdated: Date.now() };
            }
            console.log(`[TOKENS] Groq ${model} key#${GROQ_KEYS.indexOf(KEY)}${i > 0 ? ' (failover)' : ''} | in:${usage?.prompt_tokens || 0} out:${usage?.completion_tokens || 0} | cumulative: ${tokenUsage.groqInput + tokenUsage.groqOutput} total`);
            // Guard the envelope: a filtered or truncated completion can come
            // back with no choice, and blind indexing makes that an opaque
            // TypeError instead of a named provider failure.
            const content = response.data.choices?.[0]?.message?.content;
            if (typeof content !== 'string') {
                const reason = response.data.choices?.[0]?.finish_reason || 'no choice returned';
                throw new Error(`Groq ${model} returned no usable content (finish_reason: ${reason})`);
            }
            return content;
        } catch (err) {
            recordAiFailure('groq', model, err);
            if (err.response?.headers) {
                const remaining = err.response.headers['x-ratelimit-remaining-requests'] || err.response.headers['x-ratelimit-remaining-tokens'];
                const reset = err.response.headers['x-ratelimit-reset-requests'] || err.response.headers['x-ratelimit-reset-tokens'];
                if (remaining !== undefined && reset !== undefined) {
                    global.apiRateLimits = { remaining, reset, lastUpdated: Date.now() };
                }
            }
            const errMsg = err.response?.data?.error?.message || err.message;
            if (isGroqRateLimit(err)) {
                // Trip THIS key's breaker for its stated cooldown, then fail over
                // to the next pool key (same model).
                const waitMs = groqRetryMs(errMsg);
                global.aiCircuitBreakers[KEY] = Date.now() + waitMs + 2000;
                global.apiRateLimits = { remaining: '0', reset: `${Math.ceil(waitMs / 1000)}s`, lastUpdated: Date.now() };
                console.warn(`[GROQ] key#${GROQ_KEYS.indexOf(KEY)} rate-limited (${Math.ceil(waitMs / 1000)}s); ${i < candidates.length - 1 ? 'rotating to next key' : 'no keys left'}`);
                lastErr = err;
                continue; // rotate to the next available key
            }
            // Non-rate-limit error (bad request, model error): retrying another
            // key won't help — surface it. No degraded fallback by design.
            console.error(`[GROQ] ${model} generation failed: ${errMsg}`);
            throw new Error(`Groq ${model} generation failed: ${errMsg}`);
        }
    }
    // Every candidate key was rate-limited during this call.
    const msg = lastErr?.response?.data?.error?.message || lastErr?.message || 'all keys rate-limited';
    console.error(`[GROQ] ${model} generation failed after trying ${candidates.length} key(s): ${msg}`);
    throw new Error(`Groq ${model} generation failed: ${msg}`);
}

// ── ROUTE: Token Usage Stats ─────────────────────────────────
export { tokenUsage };

let cachedRealTimeLogistics = {
    portCongestion: [{ port: 'Jebel Ali (Real-Time)', status: 'LOADING...', delayDays: 0, reason: 'Pending fetch' }],
    freightRates: { reeferIndexFEU: 0, bunkerSurchargeImpact: 'NORMAL', trend: 'LOADING...' },
    airFreightRates: { ratePerKg: 0, trend: 'LOADING...' },
    geopoliticalRiskIndex: 0
};

async function fetchRealTimeLogistics() {
    // Deterministic baseline only — LLM extraction from a news feed was
    // already disabled (see the removed prompt), and its only remaining
    // effect was a NewsData.io call whose one output (geopoliticalRiskIndex
    // 5 vs 3) wasn't worth an external API. Fixed baseline instead.
    cachedRealTimeLogistics = {
        portCongestion: [{ port: 'Jebel Ali (Real-Time)', status: 'NORMAL', delayDays: 1.5, reason: 'Deterministic baseline; LLM extraction disabled' }],
        freightRates: { reeferIndexFEU: 0, bunkerSurchargeImpact: 'NORMAL', trend: 'BASELINE' },
        airFreightRates: { ratePerKg: 0, trend: 'BASELINE' },
        geopoliticalRiskIndex: 3
    };
    console.log('[LOGISTICS] Deterministic logistics baseline refreshed.');
}

setInterval(fetchRealTimeLogistics, 6 * 60 * 60 * 1000);
// fetchRealTimeLogistics(); // Disabled on boot
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

const embeddingCache = new Map();
let embeddingUsageDay = null;
let embeddingUsageCount = 0;
let embeddingCircuitOpenUntil = 0;

function normalizeEmbeddingText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function geminiEmbeddingModelResource() {
    return EMBEDDING_MODEL.startsWith('models/') ? EMBEDDING_MODEL : `models/${EMBEDDING_MODEL}`;
}

function geminiEmbeddingEndpoint(method) {
    return `https://generativelanguage.googleapis.com/v1beta/${geminiEmbeddingModelResource()}:${method}?key=${process.env.GEMINI_API_KEY}`;
}

function getCachedEmbedding(text) {
    if (!embeddingCache.has(text)) return null;
    const value = embeddingCache.get(text);
    embeddingCache.delete(text);
    embeddingCache.set(text, value);
    return value;
}

function setCachedEmbedding(text, embedding) {
    if (!embedding || !text) return;
    embeddingCache.set(text, embedding);
    if (embeddingCache.size > EMBEDDING_CACHE_LIMIT) {
        const oldestKey = embeddingCache.keys().next().value;
        embeddingCache.delete(oldestKey);
    }
}

function resetEmbeddingBudgetIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (embeddingUsageDay !== today) {
        embeddingUsageDay = today;
        embeddingUsageCount = 0;
    }
}

function msUntilNextUtcDay() {
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0);
    return next.getTime() - Date.now();
}

// Why no vector could be produced. Exists so callers can tell "there was
// nothing to embed" (a legitimate null) apart from "the provider is
// unavailable" (something a human may need to act on). Previously both
// returned null, which made every embedding outage invisible at the call site.
export class EmbeddingUnavailableError extends Error {
    constructor(reason, detail, cause) {
        super(`Embedding unavailable (${reason})${detail ? `: ${detail}` : ''}`);
        this.name = 'EmbeddingUnavailableError';
        this.reason = reason; // 'disabled' | 'budget' | 'circuit-open' | 'api-error' | 'bad-response'
        this.cause = cause;
    }
}

// Returns { ok: true } or { ok: false, reason } — the three block reasons used
// to collapse into a bare `false`, so the caller could not report which.
function reserveEmbeddingBudget(count) {
    if (!GEMINI_EMBEDDINGS_ENABLED || !process.env.GEMINI_API_KEY) {
        return { ok: false, reason: 'disabled' };
    }
    if (Date.now() < embeddingCircuitOpenUntil) {
        return { ok: false, reason: 'circuit-open' };
    }

    resetEmbeddingBudgetIfNeeded();
    if (embeddingUsageCount + count > EMBEDDING_DAILY_BUDGET) {
        embeddingCircuitOpenUntil = Date.now() + msUntilNextUtcDay();
        console.warn(`[EMBEDDINGS] Daily embedding budget reached (${embeddingUsageCount}/${EMBEDDING_DAILY_BUDGET}). Skipping Gemini embeddings until tomorrow.`);
        return { ok: false, reason: 'budget' };
    }

    embeddingUsageCount += count;
    return { ok: true };
}

function pauseEmbeddingsAfterFailure(err) {
    const status = err.response?.status;
    const message = err.response?.data?.error?.message || err.message || '';
    if (status === 429 || /quota|rate.?limit|exceed/i.test(message)) {
        const retryAfterSeconds = Number.parseInt(err.response?.headers?.['retry-after'], 10);
        const cooldownMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : EMBEDDING_COOLDOWN_MS;
        embeddingCircuitOpenUntil = Date.now() + cooldownMs;
        console.warn(`[EMBEDDINGS] Gemini quota/rate limit hit. Pausing embedding calls for ${Math.ceil(cooldownMs / 60000)} minutes.`);
    }
}

/**
 * @returns {Promise<number[]|null>} the vector, or null ONLY when there was
 *   nothing to embed (empty/blank input).
 * @throws {EmbeddingUnavailableError} when a vector was wanted but could not be
 *   produced — provider error, quota, open circuit, or embeddings disabled.
 *   Callers that want to proceed without the vector must catch this explicitly,
 *   which makes every such fail-open decision visible in the code and the logs.
 */
export async function generateEmbedding(text) {
    const normalizedText = normalizeEmbeddingText(text);
    if (!normalizedText) return null; // the one legitimate null

    const cached = getCachedEmbedding(normalizedText);
    if (cached) return cached;

    const reservation = reserveEmbeddingBudget(1);
    if (!reservation.ok) throw new EmbeddingUnavailableError(reservation.reason);

    try {
        const { data } = await axios.post(geminiEmbeddingEndpoint('embedContent'), {
            model: geminiEmbeddingModelResource(),
            content: { parts: [{ text: normalizedText }] },
            outputDimensionality: EMBEDDING_OUTPUT_DIMENSIONS
        }, { headers: { 'Content-Type': 'application/json' }, timeout: LLM_TIMEOUT_MS });

        // Guard the envelope and the shape: a wrong-length vector silently
        // corrupts inserts into the vector(768) column.
        const embedding = data.embedding?.values;
        if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_OUTPUT_DIMENSIONS) {
            throw new EmbeddingUnavailableError('bad-response', `expected ${EMBEDDING_OUTPUT_DIMENSIONS} dims, got ${Array.isArray(embedding) ? embedding.length : typeof embedding}`);
        }
        setCachedEmbedding(normalizedText, embedding);
        return embedding;
    } catch (err) {
        if (err instanceof EmbeddingUnavailableError) throw err;
        console.error('Gemini embedding failed:', err.response?.data?.error?.message || err.message);
        recordAiFailure('gemini-embedding', EMBEDDING_MODEL, err);
        pauseEmbeddingsAfterFailure(err);
        throw new EmbeddingUnavailableError('api-error', err.response?.data?.error?.message || err.message, err);
    }
}

async function generateBatchEmbeddings(texts) {
    if (!texts || texts.length === 0) return [];

    const normalizedTexts = texts.map(normalizeEmbeddingText);
    const embeddings = new Array(texts.length);
    const missing = new Map();

    normalizedTexts.forEach((text, index) => {
        if (!text) return;
        const cached = getCachedEmbedding(text);
        if (cached) {
            embeddings[index] = cached;
            return;
        }
        if (!missing.has(text)) missing.set(text, []);
        missing.get(text).push(index);
    });

    if (missing.size === 0) return embeddings;
    // Blocked before we could fill the gaps. Throw rather than return a sparse
    // array: every caller requires a COMPLETE set, and a sparse array has the
    // right .length, so a length check waved it through. Whatever the cache did
    // cover rides along on the error for any future partial-tolerant caller.
    const reservation = reserveEmbeddingBudget(missing.size);
    if (!reservation.ok) {
        const err = new EmbeddingUnavailableError(reservation.reason, `${missing.size} of ${texts.length} text(s) uncached`);
        err.partial = embeddings;
        err.cachedCount = embeddings.filter(Boolean).length;
        throw err;
    }

    const missingTexts = Array.from(missing.keys());
    try {
        const { data } = await axios.post(geminiEmbeddingEndpoint('batchEmbedContents'), {
            requests: missingTexts.map(text => ({
                model: geminiEmbeddingModelResource(),
                content: { parts: [{ text }] },
                outputDimensionality: EMBEDDING_OUTPUT_DIMENSIONS
            }))
        }, { headers: { 'Content-Type': 'application/json' }, timeout: LLM_TIMEOUT_MS });

        const freshEmbeddings = data.embeddings?.map(e => e.values) || [];
        if (freshEmbeddings.length !== missingTexts.length) {
            throw new EmbeddingUnavailableError('bad-response', `Gemini returned ${freshEmbeddings.length} embeddings for ${missingTexts.length} texts`);
        }
        const badDims = freshEmbeddings.findIndex(v => !Array.isArray(v) || v.length !== EMBEDDING_OUTPUT_DIMENSIONS);
        if (badDims !== -1) {
            throw new EmbeddingUnavailableError('bad-response', `vector ${badDims} has wrong dimensionality (expected ${EMBEDDING_OUTPUT_DIMENSIONS})`);
        }

        missingTexts.forEach((text, missingIndex) => {
            const embedding = freshEmbeddings[missingIndex];
            setCachedEmbedding(text, embedding);
            for (const originalIndex of missing.get(text)) {
                embeddings[originalIndex] = embedding;
            }
        });

        return embeddings;
    } catch (err) {
        if (err instanceof EmbeddingUnavailableError) throw err;
        console.error('Gemini batch embedding failed:', err.response?.data?.error?.message || err.message);
        recordAiFailure('gemini-embedding', EMBEDDING_MODEL, err);
        pauseEmbeddingsAfterFailure(err);
        throw new EmbeddingUnavailableError('api-error', err.response?.data?.error?.message || err.message, err);
    }
}

// ── ROUTE: commodity prices (reads from live Yahoo-fed engine) ──────

// ── ROUTE: page composition (BFF) ───────────────────────────
// GET /api/pages/:page[?sections=a,b,c]
//
// One request returns every section a dashboard page needs, replacing the
// 8-way Promise.all in App.jsx:1072. Measured on Azure 2026-09-10: the fan-out
// paid ~0.93s wall clock (dominated by /api/news) plus 8 Postgres session
// lookups; this pays one session lookup and the same ~0.93s, since the slowest
// section still gates the response.
//
// Returns 200 whenever the PAGE resolved, even if individual sections failed —
// section status lives in the body. See composePage() for why.
//
// The legacy per-section routes are unchanged and still work; the composer
// dispatches those same handlers, so there is exactly one copy of each.
app.get('/api/pages/:page', requireAuth, async (req, res) => {
    try {
        const requested = (req.query.sections || '')
            .split(',').map(s => s.trim()).filter(Boolean);

        // Per-section params are namespaced: ?pipelineAudit.limit=50 reaches
        // only that section. A flat ?limit=50 is NOT forwarded, because one
        // section's parameters must never silently steer another's handler.
        const sectionQuery = {};
        for (const [key, value] of Object.entries(req.query)) {
            const dot = key.indexOf('.');
            if (dot <= 0) continue;
            const section = key.slice(0, dot);
            const param = key.slice(dot + 1);
            if (!param) continue;
            (sectionQuery[section] ||= {})[param] = value;
        }

        const payload = await composePage({
            app,
            page: req.params.page,
            req,
            sections: requested,
            sectionQuery,
            // requireAuth has already run on THIS request; every other
            // middleware on a section route (requireAdmin) still executes.
            skipMiddleware: [requireAuth],
        });

        // Sections carry their own freshness; prices tick every 15 min, so
        // never let a shared cache serve one user's composed page to another.
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ success: true, ...payload });
    } catch (err) {
        if (err.statusCode === 404) {
            return res.status(404).json({
                success: false,
                error: err.message,
                knownPages: err.knownPages || Object.keys(PAGES),
            });
        }
        console.error('Page composition failed:', err.message);
        res.status(500).json({ success: false, error: 'Page composition failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/market-pulse/full[?sections=a,b,c]
//
// One call returning every dashboard endpoint's body under a flat key, shaped
// to match the FOps API reference payload:
//
//   { success: true, data: { templates: {...}, userProfile: {...},
//                            commodities: {...}, energy: {...}, ... } }
//
// Values are the endpoints' own bodies, verbatim -- no per-section wrapper.
// Every existing endpoint is untouched and still served; this composes them.
//
// ?sections= narrows the set. Worth using: analyze, analyze-planner and
// by-articles are LLM calls and dominate the response time, so a caller that
// only needs market data should ask for the thirteen data sections.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/market-pulse/full', requireAuth, async (req, res) => {
    try {
        const requested = (req.query.sections || '')
            .split(',').map(s => s.trim()).filter(Boolean);

        const unknown = requested.filter(s => !REQUESTABLE_KEYS.includes(s));
        if (unknown.length) {
            return res.status(400).json({
                success: false,
                error: `unknown section(s): ${unknown.join(', ')}`,
                knownSections: MARKET_PULSE_KEYS,
            });
        }

        const payload = await composeMarketPulse({
            app,
            req,
            sections: requested,
            // requireAuth has already run on THIS request; every other
            // middleware on a section route still executes.
            skipMiddleware: [requireAuth],
        });

        // Per-user data with per-section freshness: never let a shared cache
        // hand one user's composed payload to another.
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(payload);
    } catch (err) {
        console.error('Market Pulse aggregation failed:', err.message);
        res.status(500).json({ success: false, error: 'Aggregation failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/market-pulse/indicators
//
// Market data only: prices, energy, FX and port congestion. No LLM call, so it
// returns in well under a second and costs nothing in tokens -- the counterpart
// to /recommendations below.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/market-pulse/indicators', requireAuth, async (req, res) => {
    try {
        const payload = await composeMarketPulse({
            app,
            req,
            sections: ['commodities', 'energy', 'forex', 'ports'],
            skipMiddleware: [requireAuth],
        });
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(payload);
    } catch (err) {
        console.error('Indicators aggregation failed:', err.message);
        res.status(500).json({ success: false, error: 'Aggregation failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/market-pulse/recommendations
//
// AI planner recommendations as a plain GET. /api/analyze-planner is a POST
// that expects the caller to have already fetched prices, energy, news,
// weather and FX and to hand them back in the body -- which is fine for the
// dashboard, which has them, and useless for anyone else. This gathers that
// input server-side and returns just the recommendations.
//
// COSTS TOKENS: this is the LLM path. ~4k tokens per call. Callers that only
// need market data should use /indicators.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/market-pulse/recommendations', requireAuth, async (req, res) => {
    try {
        const payload = await composeMarketPulse({
            app,
            req,
            sections: ['analyze-planner'],
            skipMiddleware: [requireAuth],
        });
        const section = payload.data['analyze-planner'] || {};
        if (section.success === false) {
            return res.status(503).json({
                success: false,
                error: section.error || 'Recommendations unavailable',
            });
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({
            success: true,
            recommendations: section.recommendations || [],
            generatedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Recommendations failed:', err.message);
        res.status(500).json({ success: false, error: 'Recommendations failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/market-pulse/market-indicators
//
// The "Market Indicators" panel: the LLM's read of WHY the market is moving
// (drivers), as opposed to /indicators, which is the raw prices themselves.
// Two different things with confusingly similar names, so both exist:
//
//   /indicators          prices, energy, FX, ports.  No LLM. ~1s.
//   /market-indicators   drivers behind the moves.   LLM.    ~4s.
//
// COSTS TOKENS.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/market-pulse/market-indicators', requireAuth, async (req, res) => {
    try {
        const payload = await composeMarketPulse({
            app,
            req,
            sections: ['marketIndicators'],
            skipMiddleware: [requireAuth],
        });
        const section = payload.data.marketIndicators || {};
        if (section.success === false) {
            return res.status(503).json({
                success: false,
                error: section.error || 'Market indicators unavailable',
            });
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({
            success: true,
            drivers: section.drivers || [],
            generatedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Market indicators failed:', err.message);
        res.status(500).json({ success: false, error: 'Market indicators failed' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/market-pulse/deep-dive[?timeframe=90D|365D&deterministicAction=...]
//
// Backs the "Request AI Deep Dive" button. /api/analyze-deep-dive is a POST
// expecting the caller to have already fetched prices, news, weather, energy
// and FX and to hand them back; this gathers that input server-side.
//
// Deliberately NOT part of /api/market-pulse/full. Deep dive is a user action,
// not page-load data -- /full already makes two LLM calls, and a third on
// every request would push it past 40s for output nobody asked to see. It is
// still addressable there on request: ?sections=deepDive.
//
// COSTS TOKENS, and is the slowest endpoint here.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/market-pulse/deep-dive', requireAuth, async (req, res) => {
    try {
        const payload = await composeMarketPulse({
            app,
            req,
            sections: ['deepDive'],
            skipMiddleware: [requireAuth],
        });
        const section = payload.data.deepDive || {};
        if (section.success === false) {
            return res.status(503).json({
                success: false,
                error: section.error || 'Deep dive unavailable',
            });
        }
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({ success: true, ...section, generatedAt: new Date().toISOString() });
    } catch (err) {
        console.error('Deep dive failed:', err.message);
        res.status(500).json({ success: false, error: 'Deep dive failed' });
    }
});
app.get('/api/commodities', requireAuth, async (req, res) => {
    const prices = Object.entries(COMMODITY_DATA)
        .map(([symbol, data]) => {
            const live = livePrices[symbol];
            const currentPrice = live?.current || 0;
            return {
                symbol,
                price: currentPrice.toFixed(currentPrice >= 1000 ? 2 : (currentPrice < 10 ? 4 : 2)),
                unit: data.unit,
                currency: 'USD',
                producers: data.producers,
                regions: data.regions,
                currencies: data.currencies,
            };
        });
    res.json({ success: true, prices });
});


// ── ROUTE: energy prices (Brent + Natural Gas mapped from Yahoo Finance) ──
app.get('/api/energy', requireAuth, async (req, res) => {
    try {
        const brentCurrent = livePrices['BRENT_CRUDE']?.current || 82.00;
        const brentHistory = (priceHistory['BRENT_CRUDE'] || []).map(h => ({ date: new Date(h.time).toISOString(), value: h.price }));
        
        const gasCurrent = livePrices['NATURAL_GAS']?.current || 3.00;
        const gasHistory = (priceHistory['NATURAL_GAS'] || []).map(h => ({ date: new Date(h.time).toISOString(), value: h.price }));

        res.json({
            success: true,
            brent: {
                current: { value: brentCurrent, period: 'live' },
                history: brentHistory,
            },
            naturalGas: {
                current: { value: gasCurrent, period: 'live' },
                history: gasHistory,
            }
        });
    } catch (err) {
        res.json({
            success: true,
            brent: { current: { value: '82.00', period: 'fallback' }, history: [] },
            naturalGas: { current: { value: '3.00', period: 'fallback' }, history: [] }
        });
    }
});

// ── ROUTE: get specific commodity price history (time-series) ──
app.get('/api/price-history/:symbol', requireAuth, async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const days = parseInt(req.query.days || '1', 10);
        
        const toDate = new Date();
        const fromDate = new Date(toDate.getTime() - (days * 24 * 60 * 60 * 1000));
        
        const history = await getPriceHistory(symbol, fromDate.toISOString(), toDate.toISOString(), 1000);
        
        // Reverse because SQL returns DESC, charts prefer ASC
        res.json({ success: true, history: history.reverse() });
    } catch (err) {
        console.error('Price history error:', err.message);
        res.status(500).json({ error: 'Failed to fetch price history' });
    }
});

// ── ROUTE: history (Yahoo Finance) ───────────────────
app.get('/api/history', requireAuth, async (req, res) => {
    const { symbol, range } = req.query; // symbol e.g., 'WHEAT'
    if (!symbol || !range) return res.status(400).json({ error: 'Missing symbol or range' });
    
    // ── Handle all commodities using Yahoo Finance ──
    const yTicker = YAHOO_SYMBOLS[symbol.toUpperCase()];
    if (!yTicker) return res.status(400).json({ error: 'Invalid symbol' });

    let period1 = new Date();
    let interval = '1d';
    
    if (range === '1D') {
        period1.setDate(period1.getDate() - 3); // Extra buffer for weekends
        interval = '15m'; // 15m is more reliable than 5m on Yahoo
    } else if (range === '7D') {
        period1.setDate(period1.getDate() - 7);
        interval = '1h'; 
    } else if (range === '1M') {
        period1.setMonth(period1.getMonth() - 1);
        interval = '1d';
    } else if (range === '1Y') {
        period1.setFullYear(period1.getFullYear() - 1);
        interval = '1wk';
    }

    try {
        const chart = await yahooFinance.chart(yTicker, { period1, period2: new Date(), interval });
        const hist = chart.quotes || [];

        // Display in dollars: cents-quoted futures (grains, softs, livestock)
        // are divided by 100 so the chart matches the dollar prices shown
        // everywhere else. Dollar-quoted symbols pass through unchanged.
        const sym = symbol.toUpperCase();
        let normalized = hist.map(d => {
            const price = toDollars(sym, d.close);
            const open = toDollars(sym, d.open);
            const high = toDollars(sym, d.high);
            const low = toDollars(sym, d.low);
            const volume = d.volume;

            return {
                time: d.date.toISOString(),
                price: price ? parseFloat(price.toFixed(4)) : 0,
                open: open ? parseFloat(open.toFixed(4)) : null,
                high: high ? parseFloat(high.toFixed(4)) : null,
                low: low ? parseFloat(low.toFixed(4)) : null,
                volume: volume || 0
            };
        }).filter(d => d.price > 0).sort((a, b) => new Date(a.time) - new Date(b.time));

        // If 1D, we fetched 3 days to bypass weekends. Trim to the most recent
        // ~24h of TRADING by time — NOT by a fixed point count. A count-based
        // slice (last 96 bars) assumed ~24h of continuous 15m data, but futures
        // that only trade a few hours a day (grains, softs) have far fewer bars
        // per session, so 96 bars spanned 3-4 calendar days. Bounding by time
        // shows exactly one session's worth regardless of the contract's hours.
        if (range === '1D' && normalized.length) {
            const lastMs = new Date(normalized[normalized.length - 1].time).getTime();
            const cutoff = lastMs - 24 * 60 * 60 * 1000;
            normalized = normalized.filter(d => new Date(d.time).getTime() >= cutoff);
        }

        res.json({ success: true, symbol, range, data: normalized });
    } catch (err) {
        console.error('Yahoo History Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ── ROUTE: Search Yahoo Finance ───────────────────────────
app.get('/api/search', requireAuth, async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ results: [] });
    try {
        const results = await yahooFinance.search(query);
        res.json({ results: results.quotes || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── ROUTE: Track New Commodity ────────────────────────────
app.post('/api/track', requireAuth, async (req, res) => {
    const { symbol, ticker, name } = req.body;
    console.log(`[API TRACK] Received request from user ${req.session.userId} to track: ${symbol} (${ticker})`);
    if (!symbol || !ticker) return res.status(400).json({ error: 'Missing symbol/ticker' });
    
    // 1. Add to global background tracking if not already present
    if (!YAHOO_SYMBOLS[symbol]) {
        const cdata = { 
            price: '0.00', unit: 'USD', 
            producers: ['Global Market'], regions: [], currencies: ['USD'] 
        };
        
        YAHOO_SYMBOLS[symbol] = ticker;
        COMMODITY_DATA[symbol] = cdata;
        saveTracked(symbol, ticker, cdata);
        
        // Initialize in live data
        livePrices[symbol] = {
            base: 0, current: 0, open: 0, high: 0, low: 0, change: 0, changePct: 0, unit: 'USD', volatility: 0.001
        };
        priceHistory[symbol] = [{ time: Date.now(), price: 0 }];
    }

    // 2. Add to user's personal profile dashboard
    const profile = await getUserProfile(req.session.userId);
    if (profile) {
        console.log(`[API TRACK] User ${req.session.userId} current commodities:`, profile.commodities);
        if (!profile.commodities.includes(symbol)) {
            profile.commodities.push(symbol);
            await updateUserProfile(req.session.userId, profile);
            console.log(`[API TRACK] User ${req.session.userId} updated commodities:`, profile.commodities);
        } else {
            console.log(`[API TRACK] User ${req.session.userId} already has ${symbol} in profile`);
        }
    } else {
        console.log(`[API TRACK] Failed to load profile for user ${req.session.userId}`);
    }
    
    res.json({ success: true, symbol });
});


// ── Forex spot rates (Open Exchange Rates) ──────────────────────────
// Source: openexchangerates.org (requires OPEN_EXCHANGE_APP_ID). Free tier is
// USD-base, hourly, and returns ALL currencies in one call. No fallback: if the
// key is missing or the call fails, we error rather than serve stale rates.
// The panel is user-selectable — user_profiles.tracked_currencies holds the
// codes to show. The currency-name catalog (currencies.json) is keyless.

const DEFAULT_CURRENCIES = ['AED', 'SAR', 'EUR', 'INR', 'BRL', 'CNY'];
let _currencyCatalog = null; // { CODE: "Full name", ... }, cached in memory

async function getCurrencyCatalog() {
    if (_currencyCatalog) return _currencyCatalog;
    const { data } = await axios.get('https://openexchangerates.org/api/currencies.json', { timeout: 10000 });
    _currencyCatalog = data || {};
    return _currencyCatalog;
}

const trackedCurrencyCodes = (profile) => {
    const raw = profile?.tracked_currencies;
    return Array.isArray(raw) && raw.length ? raw : DEFAULT_CURRENCIES;
};

// GET /api/forex — spot rates (per USD) for the user's selected currencies only.
// ── FX rate sourcing, primary + fallback ────────────────────
// Open Exchange Rates is preferred (hourly updates on paid tiers) but needs a
// valid OPEN_EXCHANGE_APP_ID. open.er-api.com needs no key at all and carries
// 166 currencies including the full GCC set (AED, SAR, QAR, KWD, BHD, OMR) plus
// the sourcing corridors that matter here (EGP, INR, BRL). Verified 2026-09-10.
//
// The fallback exists because an absent OR INVALID key used to 503 this whole
// route, and the dashboard's per-fetch .catch() swallowed it — so the FX panel
// silently showed nothing with no error anywhere. Degrading to daily rates beats
// showing none.
//
// Trade-off: open.er-api.com updates once daily (~00:02 UTC) versus hourly on
// OXR. Fine for procurement horizons; do not use it for intraday hedging. Its
// terms request attribution for the keyless endpoint — confirm that is
// acceptable before relying on it in a paid product.
async function fetchFxRates() {
    const appId = process.env.OPEN_EXCHANGE_APP_ID;

    if (appId && appId !== 'unset') {
        try {
            const { data } = await axios.get('https://openexchangerates.org/api/latest.json', {
                params: { app_id: appId, base: 'USD' },
                timeout: 15000,
            });
            return {
                source: 'openexchangerates',
                base: data.base || 'USD',
                rates: data.rates || {},
                lastUpdate: data.timestamp ? new Date(data.timestamp * 1000).toUTCString() : null,
            };
        } catch (err) {
            // Log loudly: a configured-but-rejected key is an operator problem
            // that would otherwise hide behind the fallback forever.
            const msg = err.response?.data?.description || err.message;
            console.warn(`[FOREX] Open Exchange Rates rejected the configured key (${msg}); falling back to open.er-api.com`);
        }
    }

    const { data } = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 15000 });
    if (data?.result !== 'success' || !data?.rates) {
        throw new Error(`open.er-api.com returned ${data?.result || 'no result'}`);
    }
    return {
        source: 'open.er-api.com',
        base: data.base_code || 'USD',
        rates: data.rates,
        lastUpdate: data.time_last_update_utc || null,
    };
}

app.get('/api/forex', requireAuth, async (req, res) => {
    try {
        const [fx, catalog] = await Promise.all([
            fetchFxRates(),
            getCurrencyCatalog().catch(() => ({})),
        ]);
        const relevant = {};
        for (const code of trackedCurrencyCodes(req.userProfile)) {
            if (fx.rates?.[code] != null) {
                relevant[code] = { rate: fx.rates[code], name: catalog[code] || code };
            }
        }
        // `source` is returned so the UI and ops can tell which provider served
        // this, rather than guessing why rates look a day old.
        res.json({ success: true, base: fx.base, lastUpdate: fx.lastUpdate, source: fx.source, rates: relevant });
    } catch (err) {
        const msg = err.response?.data?.description || err.message;
        console.error('Forex error (both providers failed):', msg);
        res.status(503).json({ error: `Forex fetch failed: ${msg}` });
    }
});

// GET /api/forex/search?q= — type-ahead over the full currency catalog (by code
// or name), excluding ones already tracked.
app.get('/api/forex/search', requireAuth, async (req, res) => {
    try {
        const q = (req.query.q || '').trim().toLowerCase();
        const catalog = await getCurrencyCatalog();
        const tracked = new Set(trackedCurrencyCodes(req.userProfile));
        const all = Object.entries(catalog).map(([code, name]) => ({ code, name }));
        const matched = (q
            ? all.filter(c => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
            : all
        ).filter(c => !tracked.has(c.code)).slice(0, 12);
        res.json({ success: true, results: matched });
    } catch (err) {
        console.error('Forex search error:', err.message);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});

// POST /api/forex/add — track a currency by code.
app.post('/api/forex/add', requireAuth, async (req, res) => {
    try {
        const code = (req.body?.code || '').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) return res.status(400).json({ error: 'A 3-letter currency code is required' });
        const catalog = await getCurrencyCatalog();
        if (!catalog[code]) return res.status(404).json({ error: `Unknown currency: ${code}` });
        const list = trackedCurrencyCodes(req.userProfile).slice();
        if (list.includes(code)) return res.json({ success: true, tracked_currencies: list, duplicate: true });
        list.push(code);
        await setTrackedCurrencies(req.user.id, list);
        res.json({ success: true, code, tracked_currencies: list });
    } catch (err) {
        console.error('Add currency error:', err.message);
        res.status(500).json({ error: 'Failed to add currency' });
    }
});

// POST /api/forex/remove — untrack a currency by code.
app.post('/api/forex/remove', requireAuth, async (req, res) => {
    try {
        const code = (req.body?.code || '').trim().toUpperCase();
        if (!code) return res.status(400).json({ error: 'code is required' });
        const list = trackedCurrencyCodes(req.userProfile).filter(c => c !== code);
        await setTrackedCurrencies(req.user.id, list);
        res.json({ success: true, tracked_currencies: list });
    } catch (err) {
        console.error('Remove currency error:', err.message);
        res.status(500).json({ error: 'Failed to remove currency' });
    }
});


// ── ROUTE: extended weather (profile-aware regions, 30d history) ─
app.get('/api/weather-extended', requireAuth, async (req, res) => {
    const userRegions = req.userProfile?.regions || [];
    const customRegions = req.userProfile?.custom_regions || [];
    // Only the user's explicitly-tracked regions. Previously an empty profile
    // fell back to the ENTIRE ALL_REGIONS catalog, which surfaced mock/demo
    // GCC regions the user never selected. Empty profile now means an empty
    // weather panel until the user adds real locations.
    const standardRegions = ALL_REGIONS.filter(r => userRegions.includes(r.name));
    const regions = [...standardRegions, ...customRegions];

    try {
        const apiKey = process.env.WEATHER_API_KEY;
        if (!apiKey) throw new Error('Missing WeatherAPI key');

        // Calculate dates for 30 days history
        const today = new Date();
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() - 1);
        const startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 30);
        
        const dtStr = startDate.toISOString().split('T')[0];
        const endDtStr = endDate.toISOString().split('T')[0];

        const results = await Promise.all(regions.map(async (r, idx) => {
            // Stagger requests slightly
            await new Promise(resolve => setTimeout(resolve, idx * 100));
            
            // 1. Fetch 30 days history
            const histRes = await axios.get('http://api.weatherapi.com/v1/history.json', {
                params: { key: apiKey, q: `${r.lat},${r.lon}`, dt: dtStr, end_dt: endDtStr }
            });
            const histDays = histRes.data?.forecast?.forecastday || [];
            
            // 2. Fetch 7 days forecast + alerts
            const fcstRes = await axios.get('http://api.weatherapi.com/v1/forecast.json', {
                params: { key: apiKey, q: `${r.lat},${r.lon}`, days: 7, alerts: 'yes' }
            });
            const fcstDays = fcstRes.data?.forecast?.forecastday || [];
            const alertsData = fcstRes.data?.alerts?.alert || [];

            // Combine history
            const history = histDays.map(d => ({
                date: d.date,
                tempMax: d.day.maxtemp_c, tempMin: d.day.mintemp_c,
                precip: d.day.totalprecip_mm, et0: null, soilMoisture: null
            }));

            // Combine forecast
            const forecastData = fcstDays.map(d => ({
                date: d.date,
                tempMax: d.day.maxtemp_c, tempMin: d.day.mintemp_c,
                precip: d.day.totalprecip_mm, et0: null
            }));

            // Combine precip array for last 30 days
            const precip = history.map(h => h.precip);
            const tempMax = history.map(h => h.tempMax);

            // Compute analytics
            const recentPrecip = precip.slice(-7).reduce((a, b) => a + (b || 0), 0);
            const avgTemps = tempMax.slice(-7).filter(v => v != null);
            const maxTemp7d = avgTemps.length ? Math.max(...avgTemps) : 0;
            const avgTemp7d = avgTemps.length ? +(avgTemps.reduce((a, b) => a + b, 0) / avgTemps.length).toFixed(1) : null;
            const totalPrecip30d = precip.reduce((a, b) => a + (b || 0), 0);
            // Compute GDD (Base 10C)
            let totalGDD = 0;
            history.forEach(h => {
                if (h.tempMax != null && h.tempMin != null) {
                    const avg = (h.tempMax + h.tempMin) / 2;
                    if (avg > 10) totalGDD += (avg - 10);
                }
            });

            // Compute Logistics Risk (Wind > 40kph or Vis < 2km today/tomorrow)
            let logisticsRisk = false;
            if (fcstDays.length > 0) {
                const today = fcstDays[0].day;
                if (today.maxwind_kph > 40 || today.avgvis_km < 2) logisticsRisk = true;
                if (fcstDays.length > 1) {
                    const tmrw = fcstDays[1].day;
                    if (tmrw.maxwind_kph > 40 || tmrw.avgvis_km < 2) logisticsRisk = true;
                }
            }

            // Compute Drought Score (0-100, 100 means 0 rain in 30 days)
            // Simplified: baseline expectation 100mm/month.
            let droughtScore = Math.max(0, 100 - totalPrecip30d);
            if (droughtScore > 100) droughtScore = 100;
            console.log(`Weather Extended for ${r.name}: history_days=${history.length}, totalRain30d=${totalPrecip30d}, precip_array=[${precip.join(',')}]`);

            // Risk assessment
            let alert = 'NORMAL';
            let riskScore = 0;
            if (recentPrecip < 5) { alert = 'DROUGHT_RISK'; riskScore += 3; }
            if (maxTemp7d > 38) { alert = 'HEAT_STRESS'; riskScore += 3; }
            if (recentPrecip > 100) { alert = 'FLOOD_RISK'; riskScore += 2; }

            return {
                ...r,
                history,
                forecast: forecastData,
                alerts: alertsData,
                analytics: {
                    avgTemp7d, maxTemp7d,
                    recentPrecipMm: +recentPrecip.toFixed(1),
                    totalPrecip30d: +totalPrecip30d.toFixed(1),
                    totalGDD: +totalGDD.toFixed(1),
                    logisticsRisk, droughtScore: +droughtScore.toFixed(0),
                    currentSoilMoisture: null, alert,
                    riskScore: Math.min(riskScore, 10),
                }
            };
        }));

        res.json({ success: true, regions: results });
    } catch (err) {
        console.error('Weather extended error:', err.response?.data?.error?.message || err.message);
        res.status(500).json({ error: err.message });
    }
});


// ── ROUTE: AI Yield Forecasting ────────────────────────────────────────
app.post('/api/weather/ai-forecast', requireAuth, async (req, res) => {
    try {
        const { name, crop, analytics } = req.body;
        if (!name || !crop || !analytics) return res.status(400).json({ error: 'Missing required data' });

        let forecast = `Current metrics indicate a stable environment for ${crop} yields.`;
        if (analytics.alert === 'SEVERE_DROUGHT' || analytics.droughtScore > 80) {
            forecast = `Severe drought conditions (${analytics.droughtScore}/100) are critically threatening ${crop} yields. Expect significant volume reduction and logistical constraints.`;
        } else if (analytics.alert === 'DROUGHT_RISK' || analytics.droughtScore > 50) {
            forecast = `Elevated drought risk detected due to low precipitation (${analytics.totalPrecip30d}mm/30d). ${crop} yields may face moderate pressure if dry patterns persist.`;
        } else if (analytics.alert === 'HEAT_STRESS') {
            forecast = `Extreme temperatures reaching ${analytics.maxTemp7d}°C are placing severe heat stress on ${crop} development. Potential for reduced harvest quality.`;
        } else if (analytics.alert === 'FLOOD_RISK') {
            forecast = `Excessive recent rainfall (${analytics.recentPrecipMm}mm/7d) poses a high flood risk to ${crop} fields. Localized washouts and logistical delays are probable.`;
        } else if (analytics.logisticsRisk) {
            forecast = `While crop development is stable, high winds or low visibility present significant logistical risks for transporting ${crop} from the region.`;
        }

        res.json({ success: true, forecast, provider: 'deterministic' });
    } catch (err) {
        // This route is fully deterministic — no LLM, so there is nothing to
        // fall back FROM. The old catch duplicated the same template and
        // returned it as success:true "[DETERMINISTIC FALLBACK]", which would
        // have reported a server error as a valid forecast. It was also broken:
        // `crop`/`analytics` are block-scoped to the try, so referencing them
        // here threw a ReferenceError. A failure now surfaces as a failure.
        console.error('Yield forecast error:', err.message);
        res.status(500).json({ success: false, error: `Yield forecast failed: ${err.message}` });
    }
});

// ── ROUTE: simple weather (backward compatible, profile-aware) ───────
app.get('/api/weather', requireAuth, async (req, res) => {
    // Driven ONLY by the user's dedicated weather_regions list (managed live
    // from the Command Center) — independent of the news pipeline's regions.
    // Empty until the user adds their first region.
    const regions = (req.userProfile?.weather_regions || [])
        .filter(r => r && r.lat != null && r.lon != null);
    if (regions.length === 0) {
        return res.json({ success: true, regions: [] });
    }
    try {
        const apiKey = process.env.WEATHER_API_KEY;
        if (!apiKey) throw new Error('Missing WeatherAPI key');

        const results = await Promise.all(regions.map(async (r, idx) => {
            await new Promise(resolve => setTimeout(resolve, idx * 50));
            const { data } = await axios.get('http://api.weatherapi.com/v1/forecast.json', {
                params: { key: apiKey, q: `${r.lat},${r.lon}`, days: 7 }
            });
            const days = data.forecast?.forecastday || [];
            const temps = days.map(d => d.day.maxtemp_c).filter(v => v != null);
            const precip = days.map(d => d.day.totalprecip_mm);
            const totalRain = precip.reduce((a, b) => a + (b || 0), 0);
            const result = {
                ...r,
                avgTempC: temps.length ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : 'N/A',
                totalPrecipMm: totalRain.toFixed(1),
                // Real-time current conditions straight from WeatherAPI (no
                // aggregation, no proxy) for the live Command Center strip.
                current: data.current ? {
                    tempC: data.current.temp_c,
                    precipMm: data.current.precip_mm,
                    humidity: data.current.humidity,
                    windKph: data.current.wind_kph,
                    condition: data.current.condition?.text || null,
                    isDay: data.current.is_day === 1,
                    lastUpdated: data.current.last_updated || null,
                } : null,
                todayPrecipMm: days[0]?.day?.totalprecip_mm ?? null,
            };
            
            // Insert snapshot into Postgres
            if (data.current) {
                await insertWeatherSnapshot(
                    r.name, 
                    r.lat, 
                    r.lon, 
                    data.current.temp_c, 
                    data.current.precip_mm, 
                    data.current.humidity, 
                    data.current.wind_kph, 
                    data.current.condition?.text || 'Unknown'
                ).catch(err => console.error(`Failed to insert weather for ${r.name}:`, err.message));
            }
            
            return result;
        }));
        res.json({ success: true, regions: results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// ── ROUTE: Geocode and Add Custom Region ──
app.post('/api/regions/add', requireAuth, async (req, res) => {
    try {
        const { name, crop } = req.body;
        const regionName = (name || '').trim();
        if (!regionName) return res.status(400).json({ error: 'Region name is required' });

        // News/focus region: a free-text geographic TAG used for news query
        // building and the scanner's Stage-4 region gate. Deliberately NOT
        // validated against WeatherAPI — news regions and live weather stations
        // are separate systems (live weather uses /api/weather-regions/* and the
        // weather_regions column). This lets a planner track broad geographies
        // like "Middle East" or "Southeast Asia" that WeatherAPI has no single
        // station for.
        const newRegion = { name: regionName, crop: crop || 'Mixed Agriculture' };

        const currentProfile = req.userProfile;
        const customRegions = currentProfile.custom_regions || [];
        const nameOf = (r) => (typeof r === 'string' ? r : r?.name);
        // De-dupe case-insensitively against both string and object entries.
        if (!customRegions.some(r => nameOf(r)?.toLowerCase() === regionName.toLowerCase())) {
            customRegions.push(newRegion);
            await updateUserProfile(req.user.id, { ...currentProfile, custom_regions: customRegions });
        }

        res.json({ success: true, region: newRegion, custom_regions: customRegions });
    } catch (err) {
        console.error('Add region error:', err.message);
        res.status(500).json({ error: 'Failed to add region' });
    }
});

// ── Weather regions: type-ahead search + add/remove ──────────────
// These manage user_profiles.weather_regions ONLY (the Command Center live
// weather strip), independent of the news pipeline's regions.

// GET /api/regions/search?q= — proxy WeatherAPI's own location catalog so the
// UI only ever offers real, covered locations (no proxy). Returns [] for a
// too-short or unmatched query rather than erroring.
app.get('/api/regions/search', requireAuth, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, results: [] });
    try {
        const apiKey = process.env.WEATHER_API_KEY;
        if (!apiKey) return res.status(503).json({ error: 'Weather service not configured' });
        const { data } = await axios.get('http://api.weatherapi.com/v1/search.json', {
            params: { key: apiKey, q },
        });
        const results = (Array.isArray(data) ? data : []).map(r => ({
            name: r.region ? `${r.name}, ${r.region}` : r.name,
            city: r.name,
            region: r.region || '',
            country: r.country,
            lat: r.lat,
            lon: r.lon,
            label: [r.name, r.region, r.country].filter(Boolean).join(', '),
        }));
        res.json({ success: true, results });
    } catch (err) {
        console.error('Region search error:', err.response?.data?.error?.message || err.message);
        res.status(500).json({ success: false, error: 'Search failed' });
    }
});

// POST /api/weather-regions/add — append a region. Body may be a picked search
// result {lat,lon,name,...} or {name:"City, Country"} to resolve server-side.
// Either way we re-resolve against WeatherAPI so nothing but a real covered
// location is ever stored.
app.post('/api/weather-regions/add', requireAuth, async (req, res) => {
    try {
        const apiKey = process.env.WEATHER_API_KEY;
        if (!apiKey) return res.status(503).json({ error: 'Weather service not configured' });
        const body = req.body || {};
        let region;
        if (body.lat != null && body.lon != null && body.name) {
            // A picked search suggestion — it already came from WeatherAPI's
            // catalog, so store it verbatim. Re-resolving by coords would
            // rename it to the nearest covered place (e.g. Rotterdam ->
            // Kralingen) and break remove-by-name.
            region = {
                name: body.name,
                country: body.country || '',
                lat: body.lat,
                lon: body.lon,
                wxLocation: body.name,
            };
        } else {
            // A bare typed name — resolve it against WeatherAPI (no proxy).
            const query = (body.name || '').split(',')[0].trim();
            if (!query) return res.status(400).json({ error: 'A location is required' });
            const { data } = await axios.get('http://api.weatherapi.com/v1/search.json', {
                params: { key: apiKey, q: query },
            });
            if (!Array.isArray(data) || data.length === 0) {
                return res.status(404).json({ error: 'That location is not covered by the weather service.' });
            }
            const loc = data[0];
            region = {
                name: loc.region ? `${loc.name}, ${loc.region}` : loc.name,
                country: loc.country,
                lat: loc.lat,
                lon: loc.lon,
                wxLocation: loc.region ? `${loc.name}, ${loc.region}` : loc.name,
            };
        }
        const list = (req.userProfile?.weather_regions || []).slice();
        if (list.find(r => r.name === region.name && r.country === region.country)) {
            return res.json({ success: true, weather_regions: list, duplicate: true });
        }
        list.push(region);
        await setWeatherRegions(req.user.id, list);
        res.json({ success: true, region, weather_regions: list });
    } catch (err) {
        console.error('Add weather region error:', err.response?.data?.error?.message || err.message);
        res.status(500).json({ error: 'Failed to add weather region' });
    }
});

// POST /api/weather-regions/remove — drop a region by name.
app.post('/api/weather-regions/remove', requireAuth, async (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name) return res.status(400).json({ error: 'Region name is required' });
        const list = (req.userProfile?.weather_regions || []).filter(r => r.name !== name);
        await setWeatherRegions(req.user.id, list);
        res.json({ success: true, weather_regions: list });
    } catch (err) {
        console.error('Remove weather region error:', err.message);
        res.status(500).json({ error: 'Failed to remove weather region' });
    }
});

// ── Port congestion (GCC): tracked-port list + IMF PortWatch activity ────
// Manages user_profiles.tracked_ports (Command Center port-congestion strip),
// mirroring the weather-regions pattern. Metric is a THROUGHPUT ANOMALY from
// PortWatch port-call counts — not true queue/dwell (PortWatch has no dwell).

// A new user's tracked_ports defaults to the major GCC gateways so the strip
// is non-empty on first load. Stored entries are {portid, portname, country}.
function resolveTrackedPorts(profile) {
    const raw = profile?.tracked_ports;
    if (Array.isArray(raw) && raw.length > 0) {
        return raw.map(p => (typeof p === 'string' ? lookupPort(p) : p)).filter(Boolean);
    }
    return DEFAULT_TRACKED_PORTIDS.map(lookupPort).filter(Boolean);
}

// GET /api/ports/search?q= — type-ahead over the static GCC port catalog.
app.get('/api/ports/search', requireAuth, (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 1) return res.json({ success: true, results: GCC_PORTS.slice(0, 12) });
    const results = GCC_PORTS.filter(p =>
        p.portname.toLowerCase().includes(q) || p.country.toLowerCase().includes(q)
    ).slice(0, 12);
    res.json({ success: true, results });
});

// GET /api/ports — each tracked port with its latest activity + throughput anomaly.
app.get('/api/ports', requireAuth, async (req, res) => {
    try {
        const tracked = resolveTrackedPorts(req.userProfile);
        const ports = await Promise.all(tracked.map(async (p) => {
            let a = await getPortActivity(p.portid);
            // Lazily ingest a port that has no snapshots yet (first time it is
            // tracked, before the scheduled refresh has run).
            if (!a.hasData) {
                await ingestPortActivity([p.portid]).catch(() => {});
                a = await getPortActivity(p.portid);
            }
            return a;
        }));
        res.json({ success: true, ports });
    } catch (err) {
        console.error('Ports fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/ports/add — track a GCC port by portid.
app.post('/api/ports/add', requireAuth, async (req, res) => {
    try {
        const portid = (req.body?.portid || '').trim();
        if (!portid || !isGccPort(portid)) {
            return res.status(400).json({ error: 'A valid GCC portid is required' });
        }
        const meta = lookupPort(portid);
        const list = resolveTrackedPorts(req.userProfile).slice();
        if (list.some(p => p.portid === portid)) {
            return res.json({ success: true, tracked_ports: list, duplicate: true });
        }
        list.push({ portid: meta.portid, portname: meta.portname, country: meta.country });
        await setTrackedPorts(req.user.id, list);
        // Warm the cache so the port appears with data on the next fetch.
        ingestPortActivity([portid]).catch(err => console.error('Port warm-ingest failed:', err.message));
        res.json({ success: true, port: meta, tracked_ports: list });
    } catch (err) {
        console.error('Add port error:', err.message);
        res.status(500).json({ error: 'Failed to add port' });
    }
});

// POST /api/ports/remove — untrack a port by portid.
app.post('/api/ports/remove', requireAuth, async (req, res) => {
    try {
        const portid = (req.body?.portid || '').trim();
        if (!portid) return res.status(400).json({ error: 'portid is required' });
        const list = resolveTrackedPorts(req.userProfile).filter(p => p.portid !== portid);
        await setTrackedPorts(req.user.id, list);
        res.json({ success: true, tracked_ports: list });
    } catch (err) {
        console.error('Remove port error:', err.message);
        res.status(500).json({ error: 'Failed to remove port' });
    }
});


// ── ROUTE: supply chain news (profile-aware keywords, filtered by AI) ──
app.get('/api/pipeline-audit', requireAuth, async (req, res) => {
    try {
        const logs = await getPipelineAuditLogs(req.session.userId, 150);
        res.json({ success: true, logs });
    } catch (err) {
        console.error('Failed to fetch pipeline audit logs:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Template-candidate discovery: cluster this user's recently REJECTED
// articles so coverage gaps (real driver categories with no seed/keyword
// yet) surface as ~8 reviewable summaries instead of a thousand headlines.
// Embedding ~400 titles takes seconds, so results are cached 6h per user;
// pass ?refresh=1 to force a recompute after a scan.
app.get('/api/discovery-clusters', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
        const k = Math.min(12, Math.max(2, parseInt(req.query.k, 10) || 8));

        if (!global.discoveryCache) global.discoveryCache = {};
        const cacheKey = `${userId}:${days}:${k}`;
        const cached = global.discoveryCache[cacheKey];
        if (!req.query.refresh && cached && Date.now() - cached.timestamp < 6 * 60 * 60 * 1000) {
            return res.json({ success: true, cached: true, ...cached.data });
        }

        const rows = await getRejectedArticlesForDiscovery(userId, days, 400);
        const result = await discoverTemplateCandidates(rows, { k });
        global.discoveryCache[cacheKey] = { data: result, timestamp: Date.now() };
        res.json({ success: true, cached: false, ...result });
    } catch (err) {
        console.error('[DISCOVERY] Failed to cluster rejected articles:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Promote a discovered pattern into the user's customer profile so the
// pipeline catches that category from the next scan onward. Keywords feed
// stage-3/5 term matching (signal_keywords); seeds feed the stage-6 semantic
// filter (ml_seeds) and should be sentence-shaped, e.g. a sample headline.
app.post('/api/discovery-promote', requireAuth, async (req, res) => {
    try {
        const { kind, value } = req.body || {};
        const clean = String(value || '').trim();
        if (!['keyword', 'seed'].includes(kind) || clean.length < 3 || clean.length > 200) {
            return res.status(400).json({ success: false, error: 'kind must be keyword|seed and value 3-200 chars' });
        }
        const customer = await getCustomerProfileForUser(req.session.userId);
        if (!customer) {
            return res.status(400).json({ success: false, error: 'Your account is not linked to a customer profile.' });
        }
        const field = kind === 'seed' ? 'ml_seeds' : 'signal_keywords';
        const result = await appendCustomerTerm(customer.id, field, kind === 'keyword' ? clean.toLowerCase() : clean);
        res.json({ success: true, ...result, field, customer: customer.company });
    } catch (err) {
        console.error('[DISCOVERY] Promote failed:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.get('/api/scan-status', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    const st = (global.scanState || {})[uid];
    // In-memory state is authoritative while it exists (it carries the live
    // `running` flag). If it's gone — server restarted/recycled since the scan —
    // fall back to the DB-persisted last result so a completed scan doesn't read
    // as "no stats recorded".
    if (st) {
        return res.json({ success: true, running: !!st.running, stats: st.stats || null, finishedAt: st.finishedAt || null });
    }
    try {
        const prof = await getUserProfile(uid);
        if (prof?.last_scan_result) {
            return res.json({ success: true, running: false, stats: prof.last_scan_result, finishedAt: prof.last_scan_at || null, persisted: true });
        }
    } catch (e) {
        console.error('scan-status persisted lookup failed:', e.message);
    }
    // Genuinely no record (never scanned): known:false lets the UI avoid a
    // scary "finished with no stats" message.
    res.json({ success: true, running: false, stats: null, finishedAt: null, known: false });
});

app.post('/api/trigger-scan', requireAuth, async (req, res) => {
    try {
        // Run the scan specifically for this user and wait for it to finish
        // so that the frontend's refresh actually sees the new logs.
        // Fire-and-forget: a full scan (per-article article fetches + optional
        // embedding/LLM labeling) can exceed the platform's HTTP gateway
        // timeout, which returns an HTML error page and breaks the caller's
        // JSON parse. So we start the scan, return immediately, and let the
        // client poll /api/scan-status for the result.
        const uid = req.session.userId;
        global.scanState = global.scanState || {};
        if (global.scanState[uid]?.running) {
            return res.json({ success: true, started: false, running: true });
        }
        if (global.triggerUserScan) {
            global.startUserScanTracked(uid);
        } else {
            scanUserSpecificNews();
            global.scanState[uid] = { running: false, stats: null, startedAt: Date.now(), finishedAt: Date.now() };
        }
        res.json({ success: true, started: true, running: true });
    } catch (err) {
        console.error('Failed to trigger scanner:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Single source of truth for "which regions the user tracks for news".
// Unifies the three region fields the Settings tab manages so the news feed
// (/api/news), the profile scanner (Alerts tab), and the planner/deep-dive
// all filter news by the SAME list. custom_regions entries may be strings or
// {name} objects; focus_region is included as a fallback anchor.
function trackedRegionNames(profile) {
    const custom = (profile?.custom_regions || [])
        .map(r => (typeof r === 'string' ? r : (r?.name || '')))
        .filter(Boolean);
    return [...new Set([
        ...(profile?.regions || []),
        ...custom,
        profile?.focus_region,
    ].filter(Boolean))];
}

app.get('/api/news', requireAuth, async (req, res) => {
    try {
        let userKeywords = req.userProfile?.news_keywords || ['frozen food', 'cold chain', 'frozen goods'];
        const trackedCommodities = req.userProfile?.commodities || [];
        const focusRegion = req.userProfile?.focus_region || 'Middle East';
        const focusProduct = req.userProfile?.focus_product || 'Commodities';

        // If the user belongs to a customer (e.g. Aramtec), search the SAME
        // topics the scanner labels — otherwise the feed (frozen-food defaults)
        // and the labeled set never overlap, so hover insights never appear.
        if (req.userProfile?.customer_id) {
            try {
                const customer = await getCustomerProfile(req.userProfile.customer_id);
                if (customer) {
                    userKeywords = [...new Set([
                        ...(customer.commodities || []),
                        ...(customer.signal_keywords || []),
                    ])];
                }
            } catch (e) { console.error('[NEWS] customer enrich failed:', e.message); }
        }

        // Dynamically build Google News queries. Append market context to avoid consumer/recipe news.
        // Cap to keep RSS fan-out bounded (these run as parallel fetches).
        const querySuffix = ' AND (market OR "supply chain" OR trade OR agriculture OR prices OR export)';
        // Region selection consistent with the Alerts scanner + Settings tab:
        // pin the focus product to EVERY tracked region, not just focus_region.
        const newsRegions = trackedRegionNames(req.userProfile);
        const googleQueries = [
            ...userKeywords.slice(0, 16).map(kw => `"${kw}"${querySuffix}`),
            ...(newsRegions.length ? newsRegions : [focusRegion]).map(r => `"${focusProduct}" "${r}"${querySuffix}`)
        ];
        const allArticles = [];

        // ── Source 1: Google News RSS (free, no key) ──

        const rssResults = await Promise.allSettled(
            googleQueries.map(async (q) => {
                const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en&when=1d`;
                const { data: rssXml } = await axios.get(rssUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FOPsMarketPulse/1.0)' },
                    timeout: 8000,
                });
                // Parse RSS items from XML
                const items = [];
                const itemRegex = /<item>([\s\S]*?)<\/item>/g;
                let match;
                while ((match = itemRegex.exec(rssXml)) !== null) {
                    const xml = match[1];
                    const title = (xml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '')
                        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
                    const link = (xml.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
                    const pubDate = (xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
                    const desc = (xml.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '')
                        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
                        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                        .replace(/<[^>]*>/g, '').trim().slice(0, 250);
                    const source = (xml.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || 'Google News').trim();

                    if (!pubDate) continue;
                    const isOlderThan24h = (Date.now() - new Date(pubDate).getTime()) > (24 * 60 * 60 * 1000);

                    if (title && !isOlderThan24h) {
                        items.push({ title, url: link, publishedAt: pubDate, description: desc, source, via: 'google-news' });
                    }
                }
                return items;
            })
        );

        for (const result of rssResults) {
            if (result.status === 'fulfilled') allArticles.push(...result.value);
        }

        // ── Deduplicate by title similarity ──
        const seen = new Set();
        const unique = allArticles.filter(a => {
            const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // ── Sort by date (newest first) ──
        unique.sort((a, b) => {
            const da = a.publishedAt ? new Date(a.publishedAt) : new Date(0);
            const db = b.publishedAt ? new Date(b.publishedAt) : new Date(0);
            return db - da;
        });

        console.log(`News: fetched ${allArticles.length} articles, ${unique.length} unique (Google News)`);
        
        // ── Persist to PostgreSQL Database for external querying ──
        for (const a of unique) {
            // Background async save (no await to prevent blocking the UI)
            insertNewsEmbedding(a, null).catch(err => console.error("DB Insert Error (News):", err.message));
        }

        // ── Optional Live Semantic Filtering ──
        let verifiedArticles = unique.slice(0, 40);
        if (LIVE_SEMANTIC_FILTER_ENABLED) {
            try {
                const contextText = `${focusProduct} supply chain, market pricing, and trade dynamics in ${focusRegion}`;
                verifiedArticles = verifiedArticles.slice(0, MAX_NEWS_SEMANTIC_ARTICLES);
                const textsToEmbed = [contextText, ...verifiedArticles.map(a => a.title)];

                const batchEmbeddings = await generateBatchEmbeddings(textsToEmbed);
                // Require every vector, not just the right array length — a
                // budget-blocked batch comes back sparse, and a missing vector
                // would score 0 similarity and silently drop a good article.
                const complete = batchEmbeddings
                    && batchEmbeddings.length === textsToEmbed.length
                    && batchEmbeddings.every(e => Array.isArray(e) && e.length > 0);
                if (!complete) {
                    console.warn('[SEMANTIC-FILTER] Incomplete embeddings; skipping filter (passing articles through).');
                } else {
                    const contextEmb = batchEmbeddings[0];
                    verifiedArticles = verifiedArticles.filter((a, i) => {
                        const sim = cosineSimilarity(contextEmb, batchEmbeddings[i + 1]);
                        return sim >= 0.55;
                    });
                    console.log(`[SEMANTIC-FILTER] Kept ${verifiedArticles.length} relevant articles out of ${textsToEmbed.length - 1}`);
                }
            } catch (err) {
                // Deliberate fail-open: an embedding outage must not blank the
                // news feed. verifiedArticles keeps its pre-filter contents.
                const why = err instanceof EmbeddingUnavailableError ? err.reason : 'unexpected-error';
                console.warn(`[SEMANTIC-FILTER] Unavailable (${why}); passing ${verifiedArticles.length} articles through unfiltered: ${err.message}`);
            }
        }

        res.json({
            success: true,
            articles: verifiedArticles.slice(0, 20),
            meta: { total: allArticles.length, unique: unique.length, verified: verifiedArticles.length, focus: `${focusProduct} — ${focusRegion}` }
        });
    } catch (err) {
        console.error('News fetch error:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ── ROUTE: main AI analysis (profile-aware, enriched with forex + extended weather) ─
app.post('/api/analyze', requireAuth, async (req, res) => {
    try {
        // Run Simulators to patch "Data Gaps"
        // Use Real-Time LLM extracted Logistics Data instead of simulateLogistics mockup
        const logisticsData = cachedRealTimeLogistics;
        const usdaData = simulateUSDA(req.body.weatherExtended);
        
        // Attach to payload
        req.body.logistics = logisticsData;
        req.body.usda = usdaData;
        req.body.llmForecast = cachedLLMForecast;
        // Alerts come from the persistent event×exposure store: already
        // per-user, exposure-filtered, deduped, and restart-proof. Geo events
        // are fanned out into the same store, so no separate geoAlerts feed.
        req.body.geoAlerts = [];
        try {
            const dbAlerts = await getActiveAlerts(req.session.userId);
            req.body.userAlerts = dbAlerts.map(a => {
                // The scanner stores the MiniLM extractive summary (key article
                // sentences, no LLM) in payload.description as "NLP Summary: …".
                // Surface it so the alert card can show it without an API call.
                let extractSummary = null;
                try {
                    const p = typeof a.payload === 'string' ? JSON.parse(a.payload) : (a.payload || {});
                    if (typeof p.description === 'string' && p.description.startsWith('NLP Summary: ')) {
                        extractSummary = p.description.slice('NLP Summary: '.length).trim() || null;
                    }
                } catch { /* malformed payload → no extract, alert still shows */ }
                return {
                    id: a.id,
                    source: a.source,
                    severity: a.severity,
                    category: a.category,
                    title: a.title,
                    reason: a.reason,
                    url: a.url,
                    detectedAt: a.created_at,
                    extractSummary,
                };
            });
        } catch (e) {
            // Fallback to the in-memory cache if the DB read fails
            req.body.userAlerts = userSpecificAlertsCache[req.session.userId] || [];
        }

        const analysis = runDeterministicEngine(req.body);
        
        if (!global.marketDriversCache) global.marketDriversCache = {};
        // Alert titles included so a new active alert invalidates the cache
        // immediately instead of waiting up to an hour for stale drivers.
        const mdAlertSignature = (req.body.userAlerts || []).map(a => a.title).join('|');
        const mdCacheKey = `${req.userProfile?.focus_product || 'Commodities'}_${(req.userProfile?.commodities || []).join(',')}_${(req.userProfile?.regions || []).join(',')}_${mdAlertSignature}`;
        const mdNow = Date.now();
        const mdCacheEntry = global.marketDriversCache[mdCacheKey];

        if (mdCacheEntry && (mdNow - mdCacheEntry.timestamp < 60 * 60 * 1000)) {
            // Serve cached market drivers (1 hour cache)
            analysis.drivers = mdCacheEntry.data;
        } else {
            try {
                const shortPrices = (req.body.prices || []).map(p => `${p.symbol}: $${p.price}`).slice(0, 10).join(', ');
                const shortWeather = (req.body.weatherExtended || []).map(w => `${w.name}: ${w.analytics?.alert || w.alert || 'NORMAL'}`).join(', ');
                const shortNews = (req.body.news || []).slice(0, 5).map(n => `- ${n.title} (${n.source || 'unknown source'})`).join('\n');
                // Reuse the same active alerts already fetched above for the
                // deterministic engine — the strongest signal we have. Price-
                // anomaly alerts are EXCLUDED here: a price move is an effect,
                // not a driver, and feeding them in made the LLM fill all 3
                // driver slots with "PRICE: X +N% today" restatements the
                // dashboard already shows elsewhere.
                const shortAlerts = (req.body.userAlerts || []).filter(a => a.source !== 'PRICE').slice(0, 5)
                    .map(a => `- [${a.severity}] ${a.title} — ${String(a.reason || '').slice(0, 140)}`).join('\n') || 'None currently active.';
                const trackedCommodities = (req.userProfile?.commodities || []).join(', ') || 'Commodities';

                const driversPrompt = `You are a commodities risk analyst briefing a food-manufacturing procurement team. Identify the 3 market drivers that actually matter for THEIR tracked commodities right now: ${trackedCommodities}.

DATA:
Active risk alerts (already verified relevant to this user):
${shortAlerts}

Live prices: ${shortPrices || 'N/A'}
Recent news headlines:
${shortNews || 'None'}
Weather flags: ${shortWeather || 'N/A'}

RULES:
- A driver is a real-world CAUSE: weather, logistics, trade policy, conflict, demand shifts, supply disruptions. A price move is an EFFECT, not a driver — NEVER output a driver that is just a price change (no "PRICE: ..." factors). Use the live prices only as supporting evidence for a cause-based driver.
- Prioritize active alerts as evidence over raw news — they are pre-verified as relevant.
- Every driver's "explanation" and "evidence" MUST reference a specific number, alert, headline, or weather flag from the DATA above. Never write a generic driver with no citation.
- "strength" (1-10) must reflect actual magnitude in the data (e.g. a CRITICAL alert or major disruption = 8-10; a NORMAL weather flag or routine headline = 1-3), not a default middle value.
- Do NOT invent commodities, regions, or events not present in the data. If the data is thin, pick the 3 most concrete items available rather than padding with generic macro commentary.
- BANNED as filler: "market volatility", "global uncertainty", "supply chain disruptions" used without naming the specific disruption.

Return ONLY a JSON object: {"drivers": [...]} with exactly 3 objects, each:
"factor": string, e.g. "WEATHER: Drought in Brazil" or "LOGISTICS: Red Sea rerouting delays"
"direction": "UP" | "DOWN" | "NEUTRAL"
"strength": number 1-10, reflecting actual magnitude above
"explanation": string, 1 sentence, must cite the specific data point
"evidence": array of 1-2 strings quoting the exact alert/headline/number used`;

                // Market drivers -> Gemini (everything-else routing; Groq is
                // reserved for the planner and deep-dive).
                // NOTE: there is no cross-model or cross-provider fallback
                // anywhere. callGroq rotates across KEYS on rate-limit only —
                // it never downgrades the model and never switches to Gemini.
                // (A previous comment here claimed otherwise.)
                const driverRes = await callGeminiFlash(driversPrompt, "You are a precise JSON data API. You must return a fully complete JSON object.", true, 2000, tuning.llmTemperature);
                const driverParsed = JSON.parse(driverRes);

                // Backstop the prompt rule in code: a price move is never a
                // driver. Better 2 real drivers than 3 with a price restatement.
                if (driverParsed && Array.isArray(driverParsed.drivers)) {
                    driverParsed.drivers = driverParsed.drivers.filter(d => !/^\s*PRICE\b/i.test(String(d.factor || '')));
                }
                if (driverParsed && driverParsed.drivers && Array.isArray(driverParsed.drivers) && driverParsed.drivers.length > 0) {
                    analysis.drivers = driverParsed.drivers;
                    global.marketDriversCache[mdCacheKey] = { data: driverParsed.drivers, timestamp: mdNow };
                } else {
                    throw new Error("LLM returned empty or invalid drivers format");
                }
            } catch (e) {
                // No fallback: surface the failure as an explicit error the
                // frontend renders, rather than a fake NEUTRAL "driver" card.
                console.error('Failed to generate Market Drivers via LLM:', e.message);
                analysis.drivers = [];
                analysis.driversError = `Market drivers unavailable: ${e.message}`;
            }
        }
        
        // AI scenario generation disabled. API tokens are reserved for planner recommendations and deep dives only.

        // --- INJECT CUSTOM CSV INTELLIGENCE IF AVAILABLE ---
        try {
            if (fs.existsSync('custom_csv_intelligence.json')) {
                const csvData = JSON.parse(fs.readFileSync('custom_csv_intelligence.json', 'utf8'));
                if (csvData && csvData.alerts) {
                    analysis.alerts = [...csvData.alerts, ...(analysis.alerts || [])];
                }
            }
        } catch(e) { console.error('Failed to inject CSV alerts:', e.message); }
        // ---------------------------------------------------

        // Alerts tab and Command Center must agree. Both derive from the same
        // active-alert store, but the Command Center (/api/morning-brief) and
        // /api/alerts apply the scarcity quota while this route historically
        // did not — so the Alerts tab showed the full unquota'd list. Apply
        // the identical sort-then-quota here (1 CRITICAL/2 HIGH/1 MEDIUM, no
        // LOW) so the two views can never diverge.
        if (Array.isArray(analysis.alerts)) {
            analysis.alerts.sort((a, b) =>
                (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
                || new Date(b.detectedAt || b.timestamp || 0) - new Date(a.detectedAt || a.timestamp || 0));
            analysis.alerts = applyAlertQuota(analysis.alerts);
        }

        // Attach raw simulated data to the response for the frontend UI
        analysis.logistics = logisticsData;
        analysis.usda = usdaData;

        const previousAnalysis = lastAnalysis ? { headline: lastAnalysis.summary?.headline, market_state: lastAnalysis.summary?.market_state, timestamp: lastAnalysisTime } : null;
        lastAnalysis = analysis;
        lastAnalysisTime = new Date().toISOString();

        res.json({
            success: true, 
            analysis, 
            previousAnalysis, 
            meta: {
                model: 'deterministic-engine',
            }
        });
    } catch (err) {
        console.error('Deterministic engine error:', err.message);
        res.status(500).json({ error: err.message });
    }
});



// ── ROUTE: AI Deep Dive (On-Demand) ────────────────────────────────
app.post('/api/analyze-deep-dive', requireAuth, async (req, res) => {
    const { timeframe, prices, news, weather, energy, forex, weatherExtended, deterministicAction } = req.body;
    const focusProduct = req.userProfile?.focus_product || 'Commodities';
    const focusRegion = req.userProfile?.focus_region || 'Global';
    const logisticsData = cachedRealTimeLogistics;
    
    try {
        let feedbackContext = '';
        try {
            const pastFeedback = await getRecentAiFeedback(req.session.userId, 'DEEP_DIVE', 5);
            const negativeFeedback = pastFeedback.filter(f => f.is_helpful === false);
            if (negativeFeedback.length > 0) {
                feedbackContext = '\n=== USER FEEDBACK HISTORY (DO NOT REPEAT PAST MISTAKES) ===\n' + 
                    negativeFeedback.map(f => `- You previously provided this Deep Dive: "${f.ai_response}". The user REJECTED this because: "${f.user_notes}". DO NOT repeat similar mistakes in your tone or content.`).join('\n');
            }
        } catch (e) { console.error('Failed to load AI feedback history:', e.message); }


        // Titles-only: the TITLES of the top articles that passed the 9-stage
        // profile scanner (same set shown in the Alerts tab). No NLP summaries
        // or entities are ingested anymore — this is the token-efficient input.
        let newsBlock = '';
        try {
            const insightRows = await getRecentAlertsBySource(req.session.userId, 'PROFILE_NEWS', 72, 5);
            newsBlock = insightRows.map((r, i) => {
                const title = (r.title || '').replace(/^🎯 Profile Alert:\s*/, '');
                return `${i + 1}. [${r.severity} ${r.relevance_score ?? '?'}/100] ${title}`;
            }).join('\n');
        } catch (e) { console.error('Deep-dive insights load failed:', e.message); }
        if (!newsBlock) {
            newsBlock = (news || []).slice(0, 3).map(n => `- ${n.title} (${n.source})`).join('\n') || 'No recent news available.';
        }

        // Weather: compact per-region line; numeric detail only when flagged
        const weatherBlock = (weatherExtended || []).map(w => {
            const a = w.analytics || {};
            const alert = a.alert || w.alert || 'NORMAL';
            const details = [];
            if (a.droughtScore != null && a.droughtScore >= 40) details.push(`drought ${a.droughtScore}/100`);
            if (a.maxTemp7d != null && a.maxTemp7d >= 38) details.push(`max ${a.maxTemp7d}°C/7d`);
            if (a.totalPrecip30d != null && alert !== 'NORMAL') details.push(`${a.totalPrecip30d}mm/30d`);
            return `${w.name}: ${alert}${details.length ? ` (${details.join(', ')})` : ''}`;
        }).join(' | ') || 'No regional weather data.';

        const shortPrices = (prices || []).map(p => `${p.symbol}: $${p.price}`).slice(0, 15).join(', ');
        const contextBundle = `
=== TARGET ACTION PLAN (${timeframe}) ===
${Array.isArray(deterministicAction) ? deterministicAction.join(' | ') : (deterministicAction || 'No action provided.')}

=== USER PROFILE ===
Targeted Commodities: ${req.userProfile?.commodities?.join(', ') || focusProduct}
Targeted Regions: ${trackedRegionNames(req.userProfile).join(', ')}

=== PIPELINE-VERIFIED NEWS HEADLINES (titles only — no body/figures) ===
${newsBlock}

=== REGIONAL WEATHER (tracked growing regions) ===
${weatherBlock}

=== MARKET DATA (SECONDARY) ===
Live Commodity Prices: ${shortPrices || 'N/A'}
Brent Crude: $${energy?.brent?.current?.value ?? 'N/A'}/barrel
Port Congestion: ${(logisticsData.portCongestion || []).map(p => `${p.port} (${p.status})`).join(', ')}
${feedbackContext}
`.trim();

        const analysisPrompt = `You are FOPs Market Pulse — an elite Supply Chain Intelligence Engine.
The user requested an "AI Deep Dive" into the rationale behind their ${timeframe} supply chain action plan.

CRITICAL INSTRUCTIONS:
=== FILTERING RULES (MANDATORY) ===
- Treat the user-selected commodities as the only valid scope for analysis.
- Before any reasoning, filter every API response to retain only records directly related to the selected commodities.
- Discard: News about any non-selected commodity, weather impacts for regions growing non-selected commodities, supply chain events unrelated to selected commodities, price discussions of unrelated commodities, recommendations generated from indirect or irrelevant commodity trends.
- If an article discusses multiple commodities, extract and retain only the portions relevant to the selected commodities. Ignore the rest.
- Do not infer impacts between commodities unless there is a clearly established causal relationship supported by the provided data.
- Never mention or recommend actions based on commodities that the user did not select.
===================================
1. You MUST ground the analysis in the "PIPELINE-VERIFIED NEWS HEADLINES" (each title passed a relevance pipeline for this user's supply chain — reference the specific events named in the headlines) and the "REGIONAL WEATHER" conditions. Only TITLES are provided, no article bodies — cite the event/topic of a headline, but do NOT invent figures or details not present in the title. Do NOT hallucinate news or weather.
2. DO NOT use generic filler phrases like "variance index" or "macroeconomic indicators".
3. Provide a highly structured, deeply informative analysis (around 300-450 words). Dive into the nuances and strategic implications of the data. Format the output as plain text with line breaks (\\n). Use dashes (-) for bullet points. DO NOT output any HTML tags.
4. SYNTHESIZE the data into actionable insights. Tell the user WHY the data matters at a strategic executive level.
5. Explain the *hidden risks* and *geopolitical drivers* behind the action plan based purely on the provided news and market data.
6. Provide 3 to 5 specific, highly actionable strategic bullet points directly relating to the selected commodity.
7. QUALITY BAR: every bullet must cite a specific number, date, source, or named event from the data sections above. BANNED: "monitor the situation", "stay informed", "diversify", "enhance resilience", and "mitigate risks" without naming the risk and mechanism in the same sentence. If the data is thin, write fewer, sharper bullets — never pad.
8. ADD NEW INFORMATION, don't restate: the user already saw the action plan above. Do not just rephrase it back to them. Every bullet must surface something the action plan did NOT already say — a second-order effect, a hidden risk, a precedent, or a driver behind the action, not a summary of the action itself.
9. NO FABRICATED NUMBERS: state a % or $ figure only if it is copied from the data or a shown arithmetic derivation from a number in the data. Otherwise use qualitative language instead of inventing a precise-sounding figure.
10. SOURCE DISCIPLINE: only name a source if that source's actual content supports the specific claim you're attaching to it. If unsure, state the claim without a source rather than guessing.
11. MATERIALITY CHECK: before treating a regional weather/alert signal as a driver of the GLOBAL/futures price, confirm that region is actually a major global producer of that commodity. If it is a minor growing region for this commodity, frame the impact as LOCAL sourcing/logistics risk, not a global price mover.

Return a JSON object: {"deepDive": "your concise, structured, and informative plain text analysis"}`;

        // 70B, no fallback. A parse failure or empty/too-short response throws
        // and is returned to the frontend as an error — no retry, no canned text.
        const analysisRaw = await callGroq(
            GROQ_MODEL_REASONING,
            analysisPrompt,
            contextBundle,
            true,
            3000,
            tuning.llmTemperature,
            'deepdive'
        );

        console.log('AI Deep Dive Raw Output:', analysisRaw);
        const analysis = JSON.parse(analysisRaw);
        const deepDive = typeof analysis.deepDive === 'string' ? analysis.deepDive.trim() : String(analysis.deepDive || '');
        if (deepDive.length < 50) throw new Error('AI Deep-Dive returned an empty or too-short response.');

        res.json({ success: true, deepDive });
    } catch (err) {
        console.error('Deep Dive LLM Analysis failed:', err.response?.data || err.message);
        res.status(503).json({
            success: false,
            error: `AI Deep-Dive Error: ${err.message}`
        });
    }
});


// ── ROUTE: CSV Intelligence Upload ──────────────────────────────────────────
app.post('/api/upload-csv-intelligence', requireAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) throw new Error('No file uploaded');

        res.status(403).json({
            success: false,
            error: 'CSV AI intelligence is disabled. API tokens are reserved for planner recommendations and deep dives only.'
        });

    } catch (err) {
        console.error('CSV Upload Intelligence failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── ROUTE: ML Forecast Analytics Data ────────────────────────────────
app.get('/api/ml-forecasts', requireAuth, (req, res) => {
    try {
        const filePath = path.join(process.cwd(), 'outputs', 'forecast_recommendations.csv');
        if (!fs.existsSync(filePath)) {
            return res.json({ success: true, forecasts: [] });
        }
        
        const csvContent = fs.readFileSync(filePath, 'utf8');
        const records = parse(csvContent, { columns: true, skip_empty_lines: true, cast: true });
        
        res.json({ success: true, forecasts: records });
    } catch (err) {
        console.error('Failed to parse ML forecasts CSV:', err.message);
        res.status(500).json({ error: 'Failed to load forecast data' });
    }
});

// ── ROUTE: AI Planner Recommendations ────────────────────────────────
app.post('/api/analyze-planner', requireAuth, async (req, res) => {
    try {
        const payload = {
            ...req.body,
            userProfile: req.userProfile,
            logisticsData: cachedRealTimeLogistics,
            userRegions: [...(req.userProfile?.regions || []), ((req.userProfile?.custom_regions || []).map(r => typeof r === 'string' ? r : (r.name || ''))).join(', ')].filter(Boolean)
        };

        // Pipeline-accepted news insights: articles that survived the full
        // 9-stage profile scanner, with NLP summaries + entities. These are
        // the highest-quality news signal we have — feed them to the LLM.
        let acceptedNewsInsights = [];
        try {
            // Capped at 5 (was 8): trims planner input tokens while keeping
            // the highest-relevance insights — see formatActiveAlerts below
            // for the matching cap on the other context block.
            const rows = await getRecentAlertsBySource(req.session.userId, 'PROFILE_NEWS', 72, 5);
            acceptedNewsInsights = rows.map(r => ({
                title: (r.title || '').replace(/^🎯 Profile Alert:\s*/, ''),
                summary: String(r.payload?.description || '').replace(/^NLP Summary:\s*/, '').slice(0, 320),
                entities: r.payload?.entities || null,
                newsSource: r.payload?.source || '',
                severity: r.severity,
                relevanceScore: r.relevance_score != null ? Number(r.relevance_score) : null,
                detectedAt: r.created_at,
            }));
        } catch (e) {
            console.error('[AI PLANNER] Failed to load accepted news insights:', e.message);
        }
        payload.acceptedNewsInsights = acceptedNewsInsights;

        // Active exposure-scored alerts: the strongest distilled signal we
        // have — anchor the LLM's recommendations in them.
        let activeAlertsForAI = [];
        try {
            // Capped at 5 (was 8) — same token-trimming rationale, and the
            // new alert scarcity quota (1 critical/2 high/1 medium) means
            // there are rarely more than 4 active alerts anyway.
            const alertRows = await getActiveAlerts(req.session.userId, 5);
            activeAlertsForAI = alertRows.map(a => ({
                severity: a.severity,
                title: String(a.title || '').replace(/^[^A-Za-z0-9]+\s*/, '').slice(0, 140),
                reason: String(a.reason || '').slice(0, 180),
            }));
        } catch (e) {
            console.error('[AI PLANNER] Failed to load active alerts:', e.message);
        }
        payload.activeAlerts = activeAlertsForAI;

        const plannerInputSignature = crypto
            .createHash('sha256')
            .update(JSON.stringify({
                keywords: payload.keywords || [],
                // New accepted articles or alerts must invalidate the 2h cache
                insightTitles: acceptedNewsInsights.map(i => i.title),
                alertTitles: activeAlertsForAI.map(a => a.title)
            }))
            .digest('hex')
            .slice(0, 16);
        const cacheKey = `${payload.userProfile?.focus_product || 'Commodities'}_${payload.userProfile?.focus_region || 'Global'}_${(payload.userProfile?.commodities || []).join(',')}_${payload.userRegions.join(',')}_${plannerInputSignature}`;
        if (!global.aiPlannerCache) global.aiPlannerCache = {};
        
        // Cache for 2 hours to aggressively prevent Groq API rate limits
        const now = Date.now();
        const cacheEntry = global.aiPlannerCache[cacheKey];
        if (!payload.forceRefresh && cacheEntry && (now - cacheEntry.timestamp < 120 * 60 * 1000)) {
            return res.json({ success: true, recommendations: cacheEntry.data });
        }

        try {
            const pastFeedback = await getRecentAiFeedback(req.session.userId, 'RECOMMENDATION', 5);
            const negativeFeedback = pastFeedback.filter(f => f.is_helpful === false);
            if (negativeFeedback.length > 0) {
                payload.feedbackContext = '\n=== USER FEEDBACK HISTORY (DO NOT REPEAT PAST MISTAKES) ===\n' +
                    negativeFeedback.map(f => `- You previously suggested: "${String(f.ai_response || '').slice(0, 160)}". The user REJECTED this because: "${String(f.user_notes || '').slice(0, 160)}". DO NOT make similar suggestions.`).join('\n');
            }
        } catch (e) { console.error('Failed to load AI feedback history:', e.message); }

        console.log('[AI PLANNER] Generating recommendations in-process (Node)...');

        // plannerService builds the (systemPrompt, contextBundle) pair with pure
        // regex/string logic; callGroq() runs it on Groq 70B with NO fallback —
        // a failure propagates to the catch below and returns an error to the UI.
        const { systemPrompt, contextBundle } = buildPlannerPrompt(payload);
        const raw = await callGroq(GROQ_MODEL_REASONING, systemPrompt, contextBundle, true, 3000, tuning.llmTemperature, 'planner');

        let parsed;
        try {
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (parseErr) {
            throw new Error(`Planner LLM returned non-JSON output: ${parseErr.message}`);
        }
        // Shape-check before trusting it. `parsed?.recommendations || []` used to
        // turn a schema-mismatched reply (e.g. {"recs":[...]}, or a null field)
        // into a cached success:true empty list — indistinguishable to the user
        // from "the model had nothing to suggest", and wrong for 120 minutes.
        if (!Array.isArray(parsed?.recommendations)) {
            throw new Error(`Planner LLM returned an unexpected shape (expected {recommendations: []}, got keys: ${Object.keys(parsed || {}).join(', ') || 'none'})`);
        }
        const recommendations = parsed.recommendations;

        // Only cache a non-empty result. Caching an empty one pins a bad
        // generation in place for 2h and suppresses the retry that would fix it.
        if (recommendations.length > 0) {
            global.aiPlannerCache[cacheKey] = { data: recommendations, timestamp: Date.now() };
        }
        return res.json({ success: true, recommendations });

    } catch (err) {
        const errorDetail = err.response?.data?.error || err.message;
        console.error('AI Planner Error:', errorDetail);
        res.status(500).json({ success: false, error: errorDetail || 'AI Planner Engine failed to generate response.' });
    }
});



// ── ROUTE: per-commodity AI analysis ────────────────────────────────
app.post('/api/analyze-commodity', requireAuth, async (req, res) => {
    const { commodity, prices, weather, forex, energy } = req.body;

    const commodityInfo = COMMODITY_DATA[commodity];
    if (!commodityInfo) return res.status(400).json({ error: `Unknown commodity: ${commodity}` });

    try {
        const weatherRegions = (weather || []).filter(w => commodityInfo.regions.includes(w.name));
        res.json({
            success: true,
            commodity,
            provider: 'deterministic',
            analysis: {
                commodity,
                outlook: {
                    short: 'Use planner recommendations or deep dives for AI-backed commodity outlooks.',
                    medium: 'Per-commodity AI analysis is disabled to conserve API tokens.',
                    long: 'Per-commodity AI analysis is disabled to conserve API tokens.'
                },
                riskLevel: weatherRegions.some(w => w.analytics?.alert && w.analytics.alert !== 'NORMAL') ? 'MEDIUM' : 'LOW',
                priceDrivers: [],
                weatherImpact: { severity: 'LOW', detail: 'Deterministic endpoint; AI disabled.' },
                currencyImpact: { severity: 'LOW', detail: 'Deterministic endpoint; AI disabled.' },
                supplyChainRisks: [],
                actionItems: []
            }
        });
    } catch (err) {
        console.error(`Commodity analysis error for ${commodity}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});



// ══════════════════════════════════════════════════════════════════════
// LIVE PRICE ENGINE — SSE stream with realistic micro-movements
// ══════════════════════════════════════════════════════════════════════

// In-memory live price state
const livePrices = {};
const priceHistory = {}; // { symbol: [{ time, price }] }
const MAX_HISTORY = 200; // keep last ~16 minutes at 5s intervals

// Initialize live prices with 0, then immediately fetch real data from Yahoo
async function initLivePrices() {
    // Ensure all hardcoded Yahoo symbols are present in COMMODITY_DATA
    for (const symbol of Object.keys(YAHOO_SYMBOLS)) {
        if (!COMMODITY_DATA[symbol]) {
            COMMODITY_DATA[symbol] = { price: '0', unit: COMMODITY_UNITS[symbol] || 'USD', producers: ['Global Market'], regions: [], currencies: ['USD'] };
        }
    }

    for (const [symbol, data] of Object.entries(COMMODITY_DATA)) {
        livePrices[symbol] = {
            base: 0,
            current: 0,
            open: 0,
            high: 0,
            low: 0,
            change: 0,
            changePct: 0,
            unit: data.unit,
            volatility: getVolatility(symbol),
        };
        priceHistory[symbol] = [];
    }
    // Immediately fetch real prices from Yahoo
    console.log('Fetching initial prices from Yahoo Finance...');
    await tickPrices();
    console.log('Initial Yahoo Finance prices loaded.');
}

// Per-commodity volatility (higher = more movement)
function getVolatility(symbol) {
    const vol = { COCOA: 0.003, COFFEE: 0.0025, FEEDER_CATTLE: 0.001, WHEAT: 0.0015, CORN: 0.0012, SOYBEANS: 0.0014, RICE: 0.0008, SUGAR: 0.002, PALM_OIL: 0.0018, MILK: 0.0006, GOLD: 0.0008, SILVER: 0.0015, COPPER: 0.0012, PLATINUM: 0.001, ALUMINUM: 0.0009, LUMBER: 0.0025, COTTON: 0.0012, OATS: 0.0015, LEAN_HOGS: 0.0018, BRENT_CRUDE: 0.0015, NATURAL_GAS: 0.002 };
    return vol[symbol] || 0.0012;
}

// Tick prices via real Internet live fetch (Yahoo Finance) for Ags
async function tickPrices() {
    const now = Date.now();
    try {
        const querySymbols = Object.values(YAHOO_SYMBOLS);
        let quotes = [];
        
        // Fetch in small chunks, fallback to individual if a chunk fails.
        // validateResult:false — some symbols (e.g. CT=F cotton) fail the
        // library's quote schema; we only need regularMarketPrice/prevClose
        // and guard them ourselves, so don't let validation throw away a
        // perfectly usable quote.
        for (let i = 0; i < querySymbols.length; i += 5) {
            const chunk = querySymbols.slice(i, i + 5);
            try {
                const res = await yahooFinance.quote(chunk, {}, { validateResult: false });
                quotes.push(...res);
            } catch (e) {
                // Chunk died (Yahoo intermittently returns an HTML block page
                // for the batched quote URL) — retry individually, spaced out
                // so the burst doesn't trip the same block.
                for (const sym of chunk) {
                    try {
                        const r = await yahooFinance.quote(sym, {}, { validateResult: false });
                        quotes.push(r);
                    } catch (e2) {}
                    await new Promise(r => setTimeout(r, 250));
                }
            }
        }
            
        for (const [symbol, state] of Object.entries(livePrices)) {
            const yTicker = YAHOO_SYMBOLS[symbol];
            if (!yTicker) continue;
            
            const q = quotes.find(x => x.symbol === yTicker);
            if (!q) {
                console.log(`[TICK PRICES] No quote found for ${symbol} (${yTicker})`);
                continue;
            }
            if (!q.regularMarketPrice) {
                console.log(`[TICK PRICES] No regularMarketPrice for ${symbol} (${yTicker}) - available keys: ${Object.keys(q).join(',')}`);
                continue;
            }
            
            // Display everything in dollars: "USX" (US cents) futures — grains,
            // softs, livestock — are divided by 100 (corn 455 -> $4.55/bu, lean
            // hogs 85.9 -> $0.86/lb). toDollars() is a no-op for symbols Yahoo
            // already quotes in dollars (metals, energy, cwt/ton contracts).
            const newPrice = toDollars(symbol, q.regularMarketPrice);

            // Same-contract session refs for the anomaly detector — the
            // quote's own previousClose/open cannot span a contract roll,
            // unlike the continuous chart series.
            state.prevClose = q.regularMarketPreviousClose > 0 ? toDollars(symbol, q.regularMarketPreviousClose) : null;
            state.dayOpen = q.regularMarketOpen > 0 ? toDollars(symbol, q.regularMarketOpen) : null;

            const rounded = +newPrice.toFixed(newPrice < 10 ? 4 : 2);

            if (!state.initializedFromYahoo) {
                state.base = rounded;
                state.open = rounded;
                state.high = rounded;
                state.low = rounded;
                priceHistory[symbol] = [];
                state.initializedFromYahoo = true;
            }

            state.current = rounded;
            // Report change vs the PREVIOUS CLOSE — the same basis used by the
            // Price Ticker (morning brief) and the anomaly/alerts. Previously
            // this used state.open (the first price seen at server boot), so the
            // live commodity cards showed a different % than the ticker and the
            // alerts for the same commodity. When prevClose is unknown, show no
            // move rather than a fabricated one.
            const ref = state.prevClose > 0 ? state.prevClose : null;
            state.change = ref ? +(rounded - ref).toFixed(4) : 0;
            state.changePct = ref ? +(((rounded - ref) / ref) * 100).toFixed(3) : 0;
            state.high = Math.max(state.high, rounded);
            state.low = Math.min(state.low, rounded);

            if (!priceHistory[symbol]) priceHistory[symbol] = [];
            const lastH = priceHistory[symbol][priceHistory[symbol].length - 1];
            if (!lastH || lastH.price !== rounded || Math.random() > 0.8) {
                priceHistory[symbol].push({ time: now, price: rounded });
                if (priceHistory[symbol].length > 200) priceHistory[symbol].shift();
            }
        }

        // Chart-endpoint fallback for anything still unpriced: the chart API
        // is served from a different, more permissive endpoint than quote, so
        // it usually works when the quote path is blocked or schema-broken.
        // Uses the last two real daily closes (current + prevClose). Runs at
        // most once per 15-min tick for only the missing symbols.
        const unpriced = Object.entries(livePrices)
            .filter(([symbol, s]) => YAHOO_SYMBOLS[symbol] && !(s.current > 0));
        for (const [symbol, state] of unpriced) {
            const yTicker = YAHOO_SYMBOLS[symbol];
            try {
                const period1 = new Date(); period1.setDate(period1.getDate() - 7);
                const chart = await yahooFinance.chart(yTicker, { period1, period2: new Date(), interval: '1d' });
                const bars = (chart.quotes || []).filter(q => q.close != null);
                if (bars.length === 0) continue;
                const last = toDollars(symbol, bars[bars.length - 1].close);
                const prevRaw = bars.length > 1 ? toDollars(symbol, bars[bars.length - 2].close) : null;
                // Continuous-series bars can span a futures contract roll —
                // the documented reason the quote path uses same-contract
                // refs. A big bar-to-bar gap here is indistinguishable from a
                // roll (oats "jumped" +13.8% on a roll day while the actual
                // contract fell), so treat prev as unverifiable rather than
                // report a fake move. Downstream honestly shows no % and the
                // anomaly detector suppresses no-prevClose jumps.
                const gapPct = prevRaw > 0 ? Math.abs((last - prevRaw) / prevRaw) * 100 : null;
                const prev = gapPct != null && gapPct <= 7 ? prevRaw : null;
                const rounded = +last.toFixed(last < 10 ? 4 : 2);
                if (!state.initializedFromYahoo) {
                    state.base = rounded; state.open = rounded; state.high = rounded; state.low = rounded;
                    priceHistory[symbol] = [];
                    state.initializedFromYahoo = true;
                }
                state.current = rounded;
                state.prevClose = prev;
                state.change = prev ? +(rounded - prev).toFixed(4) : 0;
                state.changePct = prev > 0 ? +(((rounded - prev) / prev) * 100).toFixed(3) : 0;
                state.high = Math.max(state.high, rounded);
                state.low = Math.min(state.low, rounded);
                console.log(`[TICK PRICES] ${symbol} priced via chart fallback: ${rounded}`);
            } catch (e) {
                console.log(`[TICK PRICES] chart fallback failed for ${symbol}: ${String(e.message).slice(0, 80)}`);
            }
            await new Promise(r => setTimeout(r, 200));
        }

        // --- PILLAR 2: Archive price ticks to PostgreSQL time-series ---
        try {
            const ticks = Object.entries(livePrices)
                .filter(([_, s]) => s.current > 0)
                .map(([symbol, s]) => ({ symbol, price: s.current, changePct: s.changePct || 0 }));
            if (ticks.length > 0) await insertPriceTicksBatch(ticks);
        } catch (archiveErr) {
            console.error('Price tick archive error:', archiveErr.message);
        }
        
        // --- EMAIL PRICE ALERTS MONITOR ---
        await checkPriceAlerts();

        // --- STATISTICAL PRICE ANOMALY DETECTION ---
        await checkPriceAnomalies();

    } catch (err) {
        console.error('Yahoo Finance tick logic error:', err.message);
    }
}

// ── Statistical price anomalies (event = the price series itself) ──
// Daily closes per symbol from Yahoo chart, cached 24h. Anomalies fan out
// only to users tracking that commodity, into the unified alert store.
const dailyCloseCache = {}; // { symbol: { closes: number[]|null, todayOpen: number|null, fetchedAt } }

async function getDailyCloses(symbol) {
    // Cache is valid within one UTC day: "today's open" and the completed-day
    // boundary both shift at midnight UTC.
    const cached = dailyCloseCache[symbol];
    if (cached && cached.fetchedDate === new Date().toISOString().slice(0, 10)) return cached;

    const yTicker = YAHOO_SYMBOLS[symbol];
    if (!yTicker) return { closes: null, todayOpen: null };
    try {
        const period1 = new Date();
        period1.setDate(period1.getDate() - 140);
        const chart = await yahooFinance.chart(yTicker, { period1, period2: new Date(), interval: '1d' });
        const todayUtc = new Date().toISOString().slice(0, 10);
        const closes = [];
        let todayOpen = null;
        for (const q of chart.quotes || []) {
            if (!q.date) continue;
            // Convert to dollars so these line up with state.current /
            // state.prevClose (also dollars) in analyzePriceSeries.
            if (q.date.toISOString().slice(0, 10) === todayUtc) {
                todayOpen = q.open != null ? toDollars(symbol, q.open) : null; // today's session open feeds the contract-roll guard
            } else if (q.close != null) {
                closes.push(toDollars(symbol, q.close)); // completed days only
            }
        }
        dailyCloseCache[symbol] = { closes, todayOpen, fetchedDate: todayUtc };
        return dailyCloseCache[symbol];
    } catch (e) {
        console.error(`[PRICE-ANOMALY] History fetch failed for ${symbol}:`, e.message);
        dailyCloseCache[symbol] = { closes: null, todayOpen: null, fetchedDate: new Date().toISOString().slice(0, 10) }; // back off until tomorrow
        return dailyCloseCache[symbol];
    }
}

async function checkPriceAnomalies() {
    try {
        // 1. Detect anomalies per symbol (pure math over daily closes)
        const findingsBySymbol = {};
        for (const [symbol, state] of Object.entries(livePrices)) {
            if (!YAHOO_SYMBOLS[symbol] || !(state.current > 0)) continue;
            const { closes, todayOpen } = await getDailyCloses(symbol);
            if (!closes || closes.length === 0) continue;
            // Prefer the quote's own session open; chart-derived open is fallback
            const findings = analyzePriceSeries(closes, state.current, state.dayOpen ?? todayOpen, state.prevClose);
            if (findings.length > 0) findingsBySymbol[symbol] = findings;
        }
        const anomalousSymbols = Object.keys(findingsBySymbol);
        if (anomalousSymbols.length === 0) return;
        console.log(`[PRICE-ANOMALY] Findings: ${anomalousSymbols.map(s => `${s}(${findingsBySymbol[s].map(f => f.type).join(',')})`).join(' ')}`);

        // 2. Fan out to users tracking those commodities
        const dayKey = new Date().toISOString().slice(0, 10);
        const weekKey = `W${Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))}`;
        const users = await getAllUsers();
        for (const user of users) {
            if (!user.id) continue;
            let profile = null;
            try { profile = await getUserProfile(user.id); } catch (e) { continue; }
            if (!profile) continue;
            const tracked = new Set(profile.commodities || []);

            for (const symbol of anomalousSymbols) {
                if (!tracked.has(symbol)) continue;
                const label = symbol.replace(/_/g, ' ');
                const unit = COMMODITY_UNITS[symbol] || 'USD';
                const price = livePrices[symbol].current;

                for (const finding of findingsBySymbol[symbol]) {
                    const { title, reason } = describeAnomaly(finding, label, price, unit);
                    // Sigma moves are daily events; range breaks / vol regimes
                    // persist, so dedup weekly to avoid re-alerting a trend.
                    const bucket = finding.type.startsWith('sigma-move') ? dayKey : weekKey;
                    await insertAlert(user.id, {
                        source: 'PRICE',
                        category: 'Price Anomaly',
                        severity: finding.severity,
                        title,
                        reason,
                        relevanceScore: anomalyRelevanceScore(finding),
                        payload: { symbol, price, ...finding },
                        dedupKey: `anomaly:${symbol}:${finding.type}:${bucket}`,
                    });
                }
            }
        }
    } catch (err) {
        console.error('[PRICE-ANOMALY] Check failed:', err.message);
    }
}

async function checkPriceAlerts() {
    try {
        const users = await getAllUserPriceAlerts();
        for (const user of users) {
            let alertsModified = false;
            for (let alert of user.price_alerts) {
                if (!alert.active) continue;
                
                const currentPrice = livePrices[alert.symbol]?.current;
                if (!currentPrice) continue;

                let triggered = false;
                if (alert.type === 'above' && currentPrice >= alert.threshold) triggered = true;
                if (alert.type === 'below' && currentPrice <= alert.threshold) triggered = true;

                if (triggered) {
                    alert.active = false; // Stop loss behavior, trigger only once
                    alertsModified = true;

                    // Persist to the unified alert store so it shows on the
                    // Alerts tab, not just in email.
                    await insertAlert(user.id, {
                        source: 'PRICE',
                        category: 'Price Threshold',
                        severity: 'HIGH',
                        title: `💰 Price Alert: ${alert.symbol.replace(/_/g, ' ')} went ${alert.type} ${alert.threshold}`,
                        reason: `Current price $${currentPrice.toFixed(2)} crossed your "${alert.type} $${alert.threshold}" threshold.`,
                        relevanceScore: 100,
                        payload: { symbol: alert.symbol, threshold: alert.threshold, type: alert.type, price: currentPrice },
                        dedupKey: `price:${alert.symbol}:${alert.type}:${alert.threshold}:${new Date().toISOString().slice(0, 10)}`,
                    });

                    if (transporter) {
                        let aiActionPlan = '';
                        try {
                            const systemPrompt = `You are a tactical agricultural supply chain expert.`;
                            const prompt = `The commodity ${alert.symbol} just went ${alert.type} ${alert.threshold} (Current Price: $${currentPrice}). Write a short, tactical 3-sentence action plan for a supply chain manager on how to respond to this price movement. Do not use formatting like markdown.`;
                            
                            global.priceAlertCooldowns = global.priceAlertCooldowns || {};
                            const alertKey = `${user.id}-${alert.symbol}`;
                            const lastTrigger = global.priceAlertCooldowns[alertKey] || 0;
                            const isCooldown = (Date.now() - lastTrigger) < 24 * 60 * 60 * 1000;

                            if (!isCooldown) {
                                aiActionPlan = 'AI action plans for price alerts are disabled to conserve API tokens.';
                                global.priceAlertCooldowns[alertKey] = Date.now();
                            } else {
                                aiActionPlan = 'AI Analysis is on cooldown for this commodity to conserve API limits.';
                            }
                        } catch (err) {
                            console.error('Failed to generate AI action plan for alert:', err.message);
                            aiActionPlan = 'AI Analysis unavailable at this moment due to high demand.';
                        }

                        const mailOptions = {
                            from: `"FOps Market Pulse" <${process.env.SENDER_EMAIL || 'alerts@fops.local'}>`,
                            to: user.email,
                            subject: `🚨 Price Alert Triggered: ${alert.symbol} went ${alert.type} ${alert.threshold}`,
                            html: `
                                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                                    <h2 style="color: #0f172a; margin-top: 0;">Hello ${user.username},</h2>
                                    <p style="font-size: 16px; color: #334155;">Your price alert for <strong>${alert.symbol.replace(/_/g, ' ')}</strong> has been triggered.</p>
                                    
                                    <div style="background-color: #f8fafc; padding: 15px; border-left: 4px solid #ef4444; margin: 20px 0;">
                                        <p style="margin: 0 0 10px 0;"><strong>Condition:</strong> Goes ${alert.type} ${alert.threshold}</p>
                                        <p style="margin: 0; font-size: 18px;"><strong>Current Price:</strong> <span style="color: #ef4444;">$${currentPrice.toFixed(2)}</span></p>
                                    </div>

                                    <h3 style="color: #0f172a; margin-top: 25px;">✨ AI Action Plan</h3>
                                    <div style="background-color: #f3e8ff; color: #6b21a8; padding: 15px; border-radius: 6px; font-style: italic;">
                                        "${aiActionPlan.trim()}"
                                    </div>

                                    <p style="margin-top: 25px; color: #64748b; font-size: 14px;">The alert has now been deactivated. Log in to FOps Market Pulse to re-enable it.</p>
                                    
                                    <div style="margin-top: 30px; text-align: center;">
                                        <a href="http://localhost:5173" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View Dashboard</a>
                                    </div>
                                </div>
                            `
                        };
                        
                        transporter.sendMail(mailOptions, (err, info) => {
                            if (err) {
                                console.error(`Error sending email to ${user.email}:`, err);
                            } else {
                                console.log(`[ALERT] Email sent to ${user.email}! Preview URL: %s`, nodemailer.getTestMessageUrl(info));
                            }
                        });
                    }
                }
            }
            
            if (alertsModified) {
                // Fetch full profile and save back
                const profile = await getUserProfile(user.id);
                profile.price_alerts = user.price_alerts;
                await updateUserProfile(user.id, profile);
            }
        }
    } catch (e) {
        console.error('Price Alerts check error:', e);
    }
}

initLivePrices();

// Tick prices via real Internet live fetch (Yahoo Finance).
// Each tick is ~5 batched Yahoo requests (21 symbols in chunks of 5), so the
// request rate is 5 / PRICE_TICK_MS.
//
// Default 15 minutes: trivial volume, and it makes user price-threshold alerts
// fire near the crossing instead of up to 24h late.
//
// PRICE_TICK_MS lowers it, but know what you are buying. Yahoo's quote API is
// undocumented and rate-limits aggressively: at 1s that is ~432,000 requests a
// day from one IP, and the observed failure mode is 429s followed by a block,
// which stops prices entirely rather than speeding them up. Anything under a
// minute is logged as a warning at startup so the cadence is visible in the
// logs when prices do stop.
//
// Note the SSE live-price engine (see LIVE PRICE ENGINE above) already emits
// per-second motion between real fetches, so the UI looks live regardless of
// this value — lowering it changes how often the underlying quote is TRUE, not
// how often the number on screen moves.
const PRICE_TICK_MS = envMs('PRICE_TICK_MS', 15 * 60 * 1000);
if (PRICE_TICK_MS < 60 * 1000) {
    console.warn(`[TICK PRICES] Cadence ${PRICE_TICK_MS}ms — roughly ${(5000 / PRICE_TICK_MS).toFixed(1)} Yahoo req/s. Expect 429s and possible blocking.`);
} else {
    console.log(`[TICK PRICES] Cadence ${PRICE_TICK_MS}ms`);
}
setInterval(tickPrices, PRICE_TICK_MS);

// Reset intraday high/low every hour. change/changePct are NOT zeroed — they
// track vs the previous close (same basis as the ticker and alerts), so we
// recompute them here rather than resetting to a "since reset" baseline.
setInterval(() => {
    for (const state of Object.values(livePrices)) {
        state.open = state.current;
        state.high = state.current;
        state.low = state.current;
        const ref = state.prevClose > 0 ? state.prevClose : null;
        state.change = ref && state.current > 0 ? +(state.current - ref).toFixed(4) : 0;
        state.changePct = ref && state.current > 0 ? +(((state.current - ref) / ref) * 100).toFixed(3) : 0;
    }
}, 3600000);

// ── IMF PortWatch refresh (GCC port activity) ──
// PortWatch updates weekly (Tuesdays). Ingest all GCC ports shortly after boot,
// then weekly. The /api/ports route also lazily ingests any single port that
// still has no snapshot, so the panel works before the first scheduled run.
setTimeout(() => {
    ingestPortActivity()
        .then(r => console.log(`PortWatch boot ingest: ${r.ok} ok, ${r.fail} failed`))
        .catch(err => console.error('PortWatch boot ingest failed:', err.message));
}, 20 * 1000);
setInterval(() => {
    ingestPortActivity().catch(err => console.error('PortWatch weekly ingest failed:', err.message));
}, 7 * 24 * 60 * 60 * 1000);

// SSE clients
const sseClients = new Set();

// ── ROUTE: SSE live price feed ──
app.get('/api/live-feed', requireAuth, (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    // Store user's selected commodities on the response object for the broadcast loop
    res.userCommodities = req.userProfile?.commodities || [];

    // Send initial snapshot with full history
    const snapshot = {};
    for (const [symbol, state] of Object.entries(livePrices)) {
        if (symbol === 'BRENT_CRUDE' || res.userCommodities.length === 0 || res.userCommodities.includes(symbol)) {
            snapshot[symbol] = { ...state, history: priceHistory[symbol] || [] };
        }
    }
    console.log('[SSE SNAPSHOT KEYS]', Object.keys(snapshot));
    res.write(`data: ${JSON.stringify({ type: 'snapshot', prices: snapshot })}\n\n`);

    sseClients.add(res);
    console.log(`SSE client connected (${sseClients.size} total)`);

    req.on('close', () => {
        sseClients.delete(res);
        console.log(`SSE client disconnected (${sseClients.size} total)`);
    });
});

// Broadcast ticks to all SSE clients every 5 seconds
setInterval(() => {
    if (sseClients.size === 0) return;
    
    // Pre-calculate full tick payload
    const fullTick = {};
    for (const [symbol, state] of Object.entries(livePrices)) {
        fullTick[symbol] = {
            price: state.current,
            change: state.change,
            changePct: state.changePct,
            high: state.high,
            low: state.low,
            time: Date.now(),
        };
    }
    
    // Broadcast filtered tick to each client
    for (const client of sseClients) {
        try {
            const clientTick = {};
            const userCommodities = client.userCommodities || [];
            for (const [symbol, data] of Object.entries(fullTick)) {
                clientTick[symbol] = data;
            }
            client.write(`data: ${JSON.stringify({ type: 'tick', prices: clientTick })}\n\n`);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}, 24 * 60 * 60 * 1000); // Reduced to 24 hours

// ── ROUTE: price history (REST fallback) ──


// ═══════════════════════════════════════════════════════════════════════
// LIVE GEOPOLITICAL ALERT SCANNER — Background polling on a configurable interval
// Scans Google News RSS + GDELT for critical supply chain disruption events
// and pushes real-time alerts via SSE + Email
// ═══════════════════════════════════════════════════════════════════════

const GEOPOLITICAL_TRIGGERS = [
  // Chokepoint / Maritime
  { pattern: /strait\s+of\s+hormuz/i, severity: 'CRITICAL', category: 'Maritime Chokepoint', impact: 'Controls 21% of global oil transit. Closure triggers immediate energy and freight cost surge across all commodities.' },
  { pattern: /suez\s+canal/i, severity: 'CRITICAL', category: 'Maritime Chokepoint', impact: 'Handles 12% of global trade. Blockage causes 10-15 day shipping delays and $400K+/day vessel rerouting costs via Cape of Good Hope.' },
  { pattern: /panama\s+canal/i, severity: 'HIGH', category: 'Maritime Chokepoint', impact: 'Key Americas trade artery. Restrictions force Pacific-Atlantic cargo onto longer, costlier routes.' },
  { pattern: /strait\s+of\s+malacca/i, severity: 'CRITICAL', category: 'Maritime Chokepoint', impact: 'Busiest shipping lane on Earth. Disruption impacts 25% of all maritime trade and 80% of East Asian energy imports.' },
  { pattern: /bab.el.mandeb/i, severity: 'CRITICAL', category: 'Maritime Chokepoint', impact: 'Gateway to Suez Canal from the south. Houthi attacks or closure cuts off Red Sea transit entirely.' },
  { pattern: /red\s+sea.{0,30}(attack|missile|houthi|disrupt|block|close|suspend)/i, severity: 'CRITICAL', category: 'Maritime Security', impact: 'Red Sea attacks force container ships to reroute around Africa, adding 10+ days and $1M+ per voyage.' },
  { pattern: /black\s+sea.{0,30}(block|mine|attack|close|grain)/i, severity: 'HIGH', category: 'Maritime Security', impact: 'Black Sea disruption directly impacts Ukrainian/Russian grain and fertilizer exports to global markets.' },

  // Trade Wars / Sanctions
  { pattern: /(sanction|embargo|trade\s+ban|tariff\s+war|trade\s+war).{0,40}(china|russia|iran|india|eu|us|america)/i, severity: 'HIGH', category: 'Trade Policy', impact: 'New sanctions or tariffs cause immediate price volatility and force supply chain re-routing.' },
  { pattern: /(export\s+ban|import\s+ban|food\s+export\s+ban)/i, severity: 'CRITICAL', category: 'Trade Policy', impact: 'Export bans on food commodities create immediate scarcity in importing regions. Historical precedent: India rice ban 2023 caused 30% global price spike.' },

  // Geopolitical Conflicts
  { pattern: /(war|invasion|military\s+strike|bombing|missile\s+attack).{0,40}(ukraine|russia|israel|iran|gaza|lebanon|yemen|taiwan|china)/i, severity: 'CRITICAL', category: 'Armed Conflict', impact: 'Active military conflict directly disrupts regional production, labor, and logistics infrastructure.' },
  { pattern: /(coup|regime\s+change|martial\s+law|state\s+of\s+emergency)/i, severity: 'HIGH', category: 'Political Instability', impact: 'Political instability freezes trade agreements, disrupts port operations, and triggers capital flight.' },

  // Infrastructure / Climate
  { pattern: /(port\s+strike|dock\s+strike|longshoremen|port\s+shutdown|port\s+closure)/i, severity: 'HIGH', category: 'Labor Disruption', impact: 'Port strikes halt container unloading. 1 day of stoppage = 5-7 days of backlog.' },
  { pattern: /(earthquake|tsunami|hurricane|cyclone|typhoon).{0,40}(devastat|destroy|massiv|catastroph|severe|emergency)/i, severity: 'HIGH', category: 'Natural Disaster', impact: 'Major natural disasters destroy local production and infrastructure, creating multi-month supply gaps.' },
  { pattern: /(drought|famine|crop\s+failure|harvest\s+failure)/i, severity: 'HIGH', category: 'Agricultural Crisis', impact: 'Crop failures drive staple commodity prices up 20-50% within weeks of confirmation.' },
  { pattern: /(bird\s+flu|avian\s+influenza|swine\s+fever|foot.and.mouth|livestock\s+disease)/i, severity: 'HIGH', category: 'Livestock Pandemic', impact: 'Livestock disease outbreaks trigger mass culling and immediate protein commodity price spikes.' },

  // Energy
  { pattern: /(opec|oil\s+production).{0,30}(cut|slash|reduce|halt)/i, severity: 'HIGH', category: 'Energy Supply', impact: 'OPEC production cuts raise fuel and freight costs across all commodity supply chains.' },
  { pattern: /(pipeline|refinery).{0,30}(attack|explo|fire|shut|sabotag)/i, severity: 'HIGH', category: 'Energy Infrastructure', impact: 'Pipeline or refinery disruption creates immediate regional energy shortages affecting cold chain logistics.' },
];

// Track already-ALERTED articles to avoid duplicate alerts. This set must
// contain only articles the user was actually alerted about — never rejected
// ones. The old pipeline added every PROCESSED article here (including
// rejections), which permanently killed wrongly-rejected articles: they
// could never be reconsidered even after profile changes or filter fixes.
let alertedArticles = new Set();
const ALERTED_FILE = path.join(process.cwd(), 'alerted_articles.json');
try {
    if (fs.existsSync(ALERTED_FILE)) {
        const raw = JSON.parse(fs.readFileSync(ALERTED_FILE, 'utf8'));
        // De-poison legacy files: drop all per-user keys (they include
        // rejected articles). Genuinely-alerted per-user keys are re-seeded
        // from the alerts table below — the DB is the source of truth.
        alertedArticles = new Set(raw.filter(k => !String(k).startsWith('user:')));
    }
} catch (e) { console.error('Failed to load alerted articles from disk', e.message); }

// Rebuild per-user alerted keys from the DB (dedup_key 'profile:<titleKey>'
// rows carry user_id). Survives restarts AND Render's ephemeral disk, which
// the JSON file never did.
async function seedAlertedArticlesFromDb() {
    try {
        const { rows } = await pool.query(
            `SELECT user_id, dedup_key FROM alerts WHERE source = 'PROFILE_NEWS' AND dedup_key LIKE 'profile:%'`
        );
        for (const r of rows) {
            alertedArticles.add(`user:${r.user_id}:${r.dedup_key.slice('profile:'.length)}`);
        }
        console.log(`[USER-SCANNER] Seeded ${rows.length} alerted-article keys from DB`);
    } catch (e) {
        console.error('[USER-SCANNER] Failed to seed alerted articles from DB:', e.message);
    }
}
seedAlertedArticlesFromDb();

function saveAlertedArticles() {
    try {
        fs.writeFileSync(ALERTED_FILE, JSON.stringify(Array.from(alertedArticles)), 'utf8');
    } catch (e) { console.error('Failed to save alerted articles', e.message); }
}

// Store recent geopolitical alerts for the API
const recentGeoAlerts = [];
const userSpecificAlertsCache = {};

global.clearUserAlertCache = (userId) => {
    userSpecificAlertsCache[userId] = [];
};

async function scanGeopoliticalNews() {
  console.log('[GEO-SCANNER] Running geopolitical scan...');
  
  const scanQueries = [
    'strait of hormuz',
    'suez canal disruption',
    'red sea shipping attack',
    'food export ban',
    'trade war tariff',
    'port strike shutdown',
    'OPEC oil production cut',
    'commodity supply chain crisis',
    'global shipping disruption',
    'agricultural drought famine',
  ];

  const allArticles = [];

  // ── Google News RSS scan ──
  const rssResults = await Promise.allSettled(
    scanQueries.map(async (q) => {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en&when=1d`;
      const { data: rssXml } = await axios.get(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FOPsGeoScanner/1.0)' },
        timeout: 8000,
      });
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(rssXml)) !== null) {
        if (items.length >= 10) break; // clamp to top 10
        const xml = match[1];
        const title = (xml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '')
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
        const link = (xml.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
        const pubDate = (xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
        const source = (xml.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || 'Google News').trim();
        
        if (!pubDate) continue;
        const isOlderThan24h = (Date.now() - new Date(pubDate).getTime()) > (24 * 60 * 60 * 1000);

        if (title && !isOlderThan24h) items.push({ title, url: link, publishedAt: pubDate, source });
      }
      return items;
    })
  );

  for (const result of rssResults) {
    if (result.status === 'fulfilled') allArticles.push(...result.value);
  }

  // ── GDELT Event Monitor (free, no key) ──
  try {
    const gdeltUrl = 'https://api.gdeltproject.org/api/v2/doc/doc?query=supply%20chain%20disruption&mode=artlist&maxrecords=20&format=json';
    const { data: gdeltData } = await axios.get(gdeltUrl, { timeout: 8000 });
    if (gdeltData?.articles) {
      for (const a of gdeltData.articles) {
        allArticles.push({
          title: a.title || '',
          url: a.url || '',
          publishedAt: a.seendate || '',
          source: a.domain || 'GDELT',
        });
      }
    }
  } catch (err) {
    // GDELT is best-effort
  }

  // ── Deduplicate ──
  const seen = new Set();
  const unique = allArticles.filter(a => {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[GEO-SCANNER] Scanned ${unique.length} unique articles. Checking for triggers...`);

  // ── Pattern Match Against Triggers (only articles from last 24 hours) ──
  const triggeredAlerts = [];
  const now = Date.now();
  const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  for (const article of unique) {
    // ── RECENCY FILTER: Skip articles older than 24 hours ──
    if (article.publishedAt) {
      const pubTime = new Date(article.publishedAt).getTime();
      if (!isNaN(pubTime) && (now - pubTime) > MAX_AGE_MS) continue;
    }

    const articleKey = article.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (alertedArticles.has(articleKey)) continue; // Already alerted

    // Skip clearly non-disruption headlines that happen to name a trigger
    // location (e.g. "Suez Canal reports record profits").
    if (/\b(record\s+(profits?|revenue|earnings)|celebrat\w*|anniversary|tourism|documentary|explained|a\s+history\s+of)\b/i.test(article.title)) continue;

    for (const trigger of GEOPOLITICAL_TRIGGERS) {
      if (trigger.pattern.test(article.title)) {
        
        // ── Optional semantic filtering: keep off by default to protect Gemini quota ──
        if (GEO_SEMANTIC_FILTER_ENABLED) {
          try {
            const articleEmb = await generateEmbedding(article.title);
            if (!trigger.embedding) {
              trigger.embedding = await generateEmbedding(`A critical geopolitical supply chain disruption event causing: ${trigger.impact}`);
            }
            if (articleEmb && trigger.embedding) {
              const similarity = cosineSimilarity(articleEmb, trigger.embedding);
              if (similarity < 0.55) {
                console.log(`[GEO-SCANNER] Filtered false positive (sim: ${similarity.toFixed(2)}): ${article.title}`);
                continue; // Not semantically relevant enough, check next trigger
              } else {
                console.log(`[GEO-SCANNER] Accepted (sim: ${similarity.toFixed(2)}): ${article.title}`);
              }
            }
          } catch (e) {
            // Deliberate fail-open: keep the deterministic keyword match rather
            // than dropping a possible disruption alert. This warning was
            // previously unreachable — generateEmbedding swallowed the error and
            // returned null, so the check was skipped in total silence.
            const why = e instanceof EmbeddingUnavailableError ? e.reason : 'unexpected-error';
            console.warn(`[GEO-SCANNER] Embedding verification unavailable (${why}); accepting deterministic match: ${article.title}`);
          }
        }

        alertedArticles.add(articleKey);
        saveAlertedArticles();
        
        const alert = {
          id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          severity: trigger.severity,
          category: trigger.category,
          headline: article.title,
          source: article.source,
          url: article.url,
          publishedAt: article.publishedAt,
          impact: trigger.impact,
          detectedAt: new Date().toISOString(),
        };

        triggeredAlerts.push(alert);
        recentGeoAlerts.unshift(alert);
        break; // One valid trigger per article is enough
      }
    }
  }

  // Keep only last 50 alerts in memory
  if (recentGeoAlerts.length > 50) recentGeoAlerts.length = 50;

  if (triggeredAlerts.length === 0) {
    console.log('[GEO-SCANNER] No new geopolitical triggers detected.');
    return;
  }

  console.log(`[GEO-SCANNER] 🚨 ${triggeredAlerts.length} GEOPOLITICAL ALERT(S) TRIGGERED!`);

  // ── 1. Broadcast to all connected SSE clients ──
  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify({ type: 'geo_alert', alerts: triggeredAlerts })}\n\n`);
    } catch (e) {
      // Client disconnected
    }
  }

  // ── 2. Persist to PostgreSQL ──
  for (const alert of triggeredAlerts) {
    insertNewsEmbedding({
      url: alert.url,
      title: `[GEO-ALERT: ${alert.severity}] ${alert.headline}`,
      description: alert.impact,
      source: `GEO-SCANNER (${alert.category})`,
      publishedAt: alert.publishedAt || new Date(),
      region: alert.category,
      commodity: 'GEOPOLITICAL',
    }, null).catch(() => {});
  }

  // ── 3. Event × Exposure fan-out: score each event against each user's
  // profile, persist only relevant alerts (severity derived from exposure),
  // and email only exposed users on new CRITICAL rows. ──
  try {
    const users = await getAllUsers();
    global.emailThrottleMap = global.emailThrottleMap || new Map();
    const THROTTLE_MS = 12 * 60 * 60 * 1000; // 1 email per user+category / 12h

    for (const user of users) {
      if (!user.id) continue;
      let profile = null;
      try { profile = await getUserProfile(user.id); } catch (e) { continue; }
      if (!profile) continue;

      for (const a of triggeredAlerts) {
        const exposure = scoreAlertExposure(
          { text: a.headline, category: a.category, publishedAt: a.publishedAt },
          profile
        );
        const severity = severityFromScore(exposure.score);
        if (!severity) continue; // event not relevant to this user's supply chain

        const isNew = await insertAlert(user.id, {
          source: 'GEO',
          category: a.category,
          severity,
          title: `🚨 ${a.category}: ${a.headline.slice(0, 140)}`,
          reason: `${a.impact} | Your exposure — commodities: ${exposure.matchedCommodities.join(', ') || 'systemic'}; regions: ${exposure.matchedRegions.join(', ') || 'systemic'}`,
          url: a.url,
          relevanceScore: exposure.score,
          payload: { headline: a.headline, source: a.source, breakdown: exposure.breakdown },
          dedupKey: `geo:${a.headline.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80)}`,
        });

        if (isNew && severity === 'CRITICAL' && transporter && user.email) {
          const throttleKey = `${user.id}:${a.category}`;
          const lastSent = global.emailThrottleMap.get(throttleKey) || 0;
          if (Date.now() - lastSent > THROTTLE_MS) {
            global.emailThrottleMap.set(throttleKey, Date.now());
            sendGeoAlertEmail(user, a, exposure).catch(err =>
              console.error(`[GEO-SCANNER] Email error (${user.email}):`, err.message));
          }
        }
      }
    }
  } catch (err) {
    console.error('[GEO-SCANNER] Exposure fan-out error:', err.message);
  }
}

async function sendGeoAlertEmail(user, a, exposure) {
      const alertHtml = [a].map(a => `
        <div style="background: ${a.severity === 'CRITICAL' ? '#fef2f2' : '#fffbeb'}; border-left: 4px solid ${a.severity === 'CRITICAL' ? '#dc2626' : '#f59e0b'}; padding: 16px; margin: 12px 0; border-radius: 0 8px 8px 0;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="background: ${a.severity === 'CRITICAL' ? '#dc2626' : '#f59e0b'}; color: white; padding: 2px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 1px;">${a.severity}</span>
            <span style="color: #64748b; font-size: 12px;">${a.category}</span>
          </div>
          <div style="font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 8px;">${a.headline}</div>
          <div style="font-size: 13px; color: #475569; line-height: 1.5; margin-bottom: 8px;">${a.impact}</div>
          <div style="font-size: 11px; color: #94a3b8;">Source: ${a.source} · Detected: ${new Date(a.detectedAt).toLocaleString()}</div>
          ${a.url ? `<a href="${a.url}" style="display: inline-block; margin-top: 8px; font-size: 12px; color: #2563eb; text-decoration: none;">Read Full Article →</a>` : ''}
        </div>
      `).join('');

      const exposureLine = [
        exposure?.matchedCommodities?.length ? `Commodities: ${exposure.matchedCommodities.join(', ')}` : '',
        exposure?.matchedRegions?.length ? `Regions: ${exposure.matchedRegions.join(', ')}` : '',
      ].filter(Boolean).join(' · ') || 'Systemic trade/freight impact';

      const mailOptions = {
        from: `"FOPs Geo-Alert" <${process.env.SENDER_EMAIL || 'alerts@fops.local'}>`,
        to: user.email,
        subject: `🚨 CRITICAL Geopolitical Alert: ${a.headline.slice(0, 80)}`,
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; background: #ffffff;">
            <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 20px 24px; border-radius: 12px 12px 0 0;">
              <h2 style="color: #ffffff; margin: 0; font-size: 18px;">🌐 FOPs Geopolitical Alert System</h2>
              <p style="color: #94a3b8; margin: 6px 0 0; font-size: 13px;">Detected at ${new Date().toLocaleString()}</p>
            </div>
            <div style="border: 1px solid #e2e8f0; border-top: none; padding: 20px 24px; border-radius: 0 0 12px 12px;">
              <p style="color: #334155; font-size: 14px;">Hello <strong>${user.username}</strong>,</p>
              <p style="color: #475569; font-size: 14px; line-height: 1.6;">This event affects your tracked supply chain (${exposureLine}):</p>
              ${alertHtml}
              <p style="color: #94a3b8; font-size: 11px; margin-top: 20px; text-align: center;">This is an automated alert from the FOPs Market Pulse Geopolitical Scanner. You received it because the event scored ${exposure?.score ?? '—'}/100 against your tracked commodities and regions.</p>
            </div>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      console.log(`[GEO-SCANNER] ✅ Exposure-matched alert email sent to ${user.email}`);
}

// ── API: S&OP Plans ──
app.get('/api/sop', requireAuth, async (req, res) => {
  try {
    const plans = await getSopPlans(req.session.userId);
    res.json({ success: true, plans });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to fetch S&OP plans' });
  }
});

app.post('/api/sop', requireAuth, async (req, res) => {
  try {
    const plan = await createSopPlan(req.session.userId, req.body);
    res.json({ success: true, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to create S&OP plan' });
  }
});

let userScannerPipeline = null;

async function initScannerPipeline() {
  if (userScannerPipeline) return userScannerPipeline;
    userScannerPipeline = new NewsPipeline({
    auditLogFn: async (userId, article, stageDropped, rejectionReason, score, isAccepted) => {
        // Must RETURN the inserted row id — the pipeline threads it through as
        // result.auditLogId, which the labeling system links training data to.
        return await insertPipelineAuditLog(userId, article, stageDropped, rejectionReason, score, isAccepted);
    },
    llmFn: async (messages, expectJson) => {
      return { relevant: false, reason: 'LLM review disabled; API tokens reserved for planner recommendations and deep dives only.' };
    },
    scoreThreshold: 75,
    llmThresholdLow: 25,
    llmThresholdHigh: 85,
    // rescueThreshold intentionally omitted so the pipeline reads the LIVE
    // runtime tuning value (admin-adjustable) instead of a construction-time
    // constant — this singleton is built once and reused across scans.
  });
  return userScannerPipeline;
}

// Graft a customer profile's news-relevance fields onto a user profile —
// identical logic for the scanner and the admin seeds-preview so what the
// preview shows is exactly what the scanner runs. Mutates `profile`.
function applyCustomerGraft(profile, customer) {
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  profile.news_keywords = uniq([
    ...(profile.news_keywords || []),
    ...(customer.signal_keywords || []),
    ...(customer.commodities || []),
  ]);
  profile.regions = uniq([
    ...(profile.regions || []),
    ...(customer.key_ports || []),
    ...(customer.supplier_countries || []),
    'UAE', 'GCC', 'Middle East', 'Red Sea', 'Suez',
  ]);
  // Seeds drive the real semantic filter (stage 6).
  profile.ml_seeds = customer.ml_seeds || [];
  // Customer-specific blocked topics, unioned with the user's own
  // blocklist (never overwritten — additive only).
  profile.custom_blocklist = uniq([...(profile.custom_blocklist || []), ...(customer.blocked_topics || [])]);
}

async function scanSingleUser(user, pipeline) {
  // Diagnostic stats returned to the caller so "Run Scanner Now" can report
  // exactly what happened instead of a blind "success".
  // labeled/labelErrors/labelingEnabled are always 0/[]/false now — ingestion
  // never calls an LLM. Kept in the shape so the Pipeline Analytics UI (which
  // reads these fields) doesn't need its own change; they just always report
  // "off" going forward.
  const stats = { fetched: 0, accepted: 0, labeled: 0, labelingEnabled: false, labelErrors: [], skippedReason: null, error: null };
  try {
    if (!user.id) { stats.skippedReason = 'no user.id'; return stats; }
    const profile = await getUserProfile(user.id);
    if (!profile) { stats.skippedReason = 'no user_profiles row'; return stats; }

    // If this user belongs to a customer (e.g. Aramtec), enrich the
    // news-relevance fields (keywords + regions) from the customer profile so
    // the scanner targets their ports/routes/suppliers/products. Price-symbol
    // `commodities` are deliberately left untouched (pricing/exposure use them).
    let customerProfile = null;
    if (profile.customer_id) {
      const customer = await getCustomerProfile(profile.customer_id);
      if (customer) {
        customerProfile = customer;
        stats.customer = customer.id;
        applyCustomerGraft(profile, customer);
      }
    }

    // 1. Fetch News
    let customKeywords = profile.news_keywords && profile.news_keywords.length > 0 ? profile.news_keywords : [];
    // 'Global' pins nothing, so generic queries ("grain export") return
    // whatever dominates world news that day. For customer-linked users,
    // fall back to the customer's market so results stay relevant to them.
    let focusRegionTerm = profile.focus_region && profile.focus_region !== 'Global' ? profile.focus_region : '';
    if (!focusRegionTerm && customerProfile) focusRegionTerm = 'Middle East';
    const regionTarget = focusRegionTerm ? ` ${focusRegionTerm}` : '';

    // Apply region target to custom keywords
    customKeywords = customKeywords.map(k => `${k}${regionTarget}`);

    // Gather selected commodities and regions. Regions use the shared
    // trackedRegionNames() set (regions + custom_regions + focus_region) so the
    // scanner queries the SAME geography the news feed and Settings tab use.
    const targets = [...(profile.commodities || []), profile.focus_product].filter(Boolean);
    const regions = trackedRegionNames(profile);

    // Keys are UPPER_SNAKE (e.g. LIVE_CATTLE) — use spaces in search queries,
    // quoting multi-word phrases so Google matches "live cattle" as a phrase,
    // not articles containing "live" and "cattle" anywhere.
    // Commodity queries get the same region pinning as keyword queries:
    // "SOYBEANS supply chain" unpinned returns whichever country dominates
    // that commodity's news cycle, not the user's market.
    const asQueryTerm = (s) => {
        const phrase = String(s).replace(/_/g, ' ').trim();
        return phrase.includes(' ') ? `"${phrase}"` : phrase;
    };
    const commQueries = [...new Set(targets)].map(c => `${asQueryTerm(c)} supply chain OR logistics${regionTarget}`);
    // Market-framed lane: commodity news that is NOT supply-chain-shaped —
    // prices, futures, production, harvest, demand. Without this the pool only
    // ever asked Google for supply-chain articles about each commodity, so the
    // per-commodity "Commodity News" feed stayed thin. Left UNPINNED by region:
    // commodity market/price news is global (wheat futures move on world
    // supply), unlike the region-pinned supply-chain lane above.
    const commMarketQueries = [...new Set(targets)]
        .map(c => `${asQueryTerm(c)} AND (price OR prices OR futures OR production OR harvest OR output OR demand OR yield)`);
    // Micro-regions ("Saudi Arabia Al-Hasa") make useless search terms — query
    // by their canonical country/region instead.
    const regQueries = [...new Set(regions.map(r => canonicalRegionName(r)))].map(r => `${r} supply chain OR logistics`);

    // Combine all sources into a single search pool
    const combinedPool = [...new Set([...customKeywords, ...commQueries, ...commMarketQueries, ...regQueries])];
    
    // Shuffle array and take top 20 to ensure fair distribution across commodities/regions
    let keywords = combinedPool.sort(() => 0.5 - Math.random()).slice(0, 20);

    if (keywords.length === 0) {
        keywords = ['supply chain', 'logistics'];
    }
    stats.queries = keywords; // surfaced via scan-status/debug so query targeting is verifiable
    const rssResults = await Promise.allSettled(
      keywords.map(async (q) => {
        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en&when=1d`;
        const { data: rssXml } = await axios.get(rssUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FOPsUserScanner/1.0)' },
          timeout: 8000,
        });
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(rssXml)) !== null) {
          if (items.length >= 10) break; // clamp to top 10
          const xml = match[1];
          const title = (xml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
          const link = (xml.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
          const pubDate = (xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
          const desc = (xml.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').trim();
          const source = (xml.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || 'Google News').trim();
          
          if (!pubDate) continue;

          if (title) {
              items.push({ title, description: desc, content: '', url: link, publishedAt: pubDate, source });
          }
        }
        return items;
      })
    );

    const allArticles = [];
    for (const result of rssResults) {
      if (result.status === 'fulfilled') allArticles.push(...result.value);
    }

    // Single external RSS feed lane (RSS_FEEDS; no-op if unset). Prevetted:
    // articles skip the commodity/region/semantic keyword gates (the feed's
    // own curation is trusted) but honor the blocklist and enter at a
    // Medium/High floor. The risk-vs-commodity split and region requirement
    // are enforced at output, not here. Commodity news also flows through the
    // dynamic Google News search pipeline above.
    let curatedCount = 0;
    try {
      const curated = await fetchCuratedFeeds();
      curatedCount = curated.length;
      allArticles.push(...curated);
    } catch (e) {
      console.error('[RSS-FEED] lane failed (continuing):', e.message);
    }

    console.log(`[USER-SCANNER] Fetched ${allArticles.length} raw articles for user ${user.id} (${curatedCount} from RSS feeds)`);
    stats.fetched = allArticles.length;
    stats.curatedFetched = curatedCount;

    // Profile fingerprint: lets the pipeline's rejection memo distinguish
    // "same article, same profile" (skip) from "same article, profile
    // changed" (re-evaluate). Covers every field that affects relevance.
    profile._fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      c: profile.commodities || [], r: profile.regions || [],
      fp: profile.focus_product || '', fr: profile.focus_region || '',
      fc: profile.focus_countries || [], k: profile.news_keywords || [],
      b: profile.custom_blocklist || [], s: profile.ml_seeds || [],
      // Custom regions are part of relevance (region gate + scoring bonus +
      // query building). Omitting them meant adding a region in Settings left
      // every past rejection memoized — the new region never produced alerts.
      cr: (profile.custom_regions || []).map(r => (typeof r === 'string' ? r : r?.name || '')),
    })).digest('hex').slice(0, 16);

    // Within-scan dedupe: the same story often comes back from several
    // queries; evaluate each title once.
    const seenThisScan = new Set();
    const uniqueArticles = allArticles.filter(a => {
      const k = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
      if (seenThisScan.has(k)) return false;
      seenThisScan.add(k);
      return true;
    });

    // 2. Evaluate EVERY article, then rank by relevance and alert the top N.
    // The old loop alerted the first N accepted in arrival order, so a
    // Critical article fetched late lost its slot to earlier Low ones.
    const acceptedArticles = [];
    for (const rawArticle of uniqueArticles) {
      const result = await pipeline.processArticle(rawArticle, profile, alertedArticles);
      if (result.accepted) {
        stats.accepted++;
        acceptedArticles.push(result.article);
      }
    }
    // Only Medium+ articles are alert-worthy — Low-scoring ones never become
    // alerts (keeps alerts scarce; the display quota also drops LOW).
    // Freshness gate: a recent scan can surface stories published days ago; we
    // do NOT raise a news alert for an article published more than 24h before
    // now. No/unparseable publish date -> can't verify freshness -> not alerted.
    const ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const isFresh = (a) => {
      const t = a.publishedAt ? new Date(a.publishedAt).getTime() : NaN;
      return Number.isFinite(t) && (nowMs - t) <= ALERT_MAX_AGE_MS;
    };
    const alertable = acceptedArticles.filter(a => ALERTABLE_PRIORITIES.has(a.priority) && isFresh(a));
    alertable.sort((x, y) => y.relevanceScore - x.relevanceScore);
    const toAlert = alertable.slice(0, MAX_USER_SCANNER_ALERTS);

    const triggeredAlerts = [];
    for (const a of toAlert) {
      const titleKey = a.titleKey || a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
      const alertReason = a.llmReason || `Score: ${a.relevanceScore}. Commodity Match: ${a.breakdown.commodityScore > 0 ? 'Yes' : 'No'}. Region Match: ${a.matchedRegions.length ? a.matchedRegions.join(', ') : 'None (tracked-commodity match)'}`;

      // Persist FIRST (the DB unique index is the durable dedup guard); only
      // a genuinely new row triggers the in-app card + email.
      const inserted = await insertAlert(user.id, {
        source: 'PROFILE_NEWS',
        category: 'Profile Match',
        severity: severityFromPriority(a.priority),
        title: '🎯 Profile Alert: ' + a.title.slice(0, 160),
        reason: alertReason,
        url: a.url,
        relevanceScore: a.relevanceScore,
        // Carry the pipeline's embedding score onto the alert (0-1 cosine of the
        // article vs the profile's seed vectors; null for prevetted/seedless).
        // Same signal already recorded on accepted articles — now on alerts too.
        payload: { source: a.source, entities: null, description: a.description, semanticSimilarity: a.semanticSimilarity ?? null, publishedAt: a.publishedAt ?? null },
        dedupKey: `profile:${titleKey}`,
      });
      if (!inserted) continue; // already alerted in a previous scan/restart

      // Mark as alerted ONLY now — accepted-but-capped articles stay
      // eligible to compete again next scan, and rejected articles are
      // never poisoned into this set (they were, historically — that made
      // every wrong rejection permanent).
      alertedArticles.add(`user:${user.id}:${titleKey}`);
      alertedArticles.add(titleKey);

      // Titles-only ingestion: we no longer fetch the full article body,
      // run extractive summarization, or extract entities for alerted
      // articles. The title (persisted above) is the ingested signal. This
      // removes a per-alert body fetch and keeps the downstream LLM context
      // (deep-dive + planner) to titles only. The alert payload keeps the
      // free RSS snippet from the insert above; no NLP summary is written.
      const nlpDescription = a.description;
      const entities = null;

      triggeredAlerts.push({
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        severity: a.priority.toUpperCase(),
        category: 'Profile Match',
        title: '🎯 Profile Alert: ' + a.title,
        source: a.source,
        url: a.url,
        timestamp: new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST',
        reason: alertReason,
        detectedAt: new Date().toISOString(),
        description: nlpDescription,
        entities: entities
      });

      // Ingestion is intentionally 100% LLM-free: stages 1-9 above are
      // regex/arithmetic/local-embedding only, and no Groq call happens
      // here regardless of ENABLE_ARTICLE_LABELING. The only remaining LLM
      // call in the app is the on-demand "AI Summary" click, which is
      // user-triggered and outside the scan/ingestion path entirely.
    }
    stats.alerted = triggeredAlerts.length;

    // Persist the alerted set (accepted keys only — rejections are never
    // written here anymore).
    saveAlertedArticles();

    // 3. Dispatch Alerts
    if (triggeredAlerts.length > 0) {
      userSpecificAlertsCache[user.id] = userSpecificAlertsCache[user.id] || [];
      userSpecificAlertsCache[user.id].unshift(...triggeredAlerts);
      if (userSpecificAlertsCache[user.id].length > 20) userSpecificAlertsCache[user.id].length = 20;

      // Email the user
      if (transporter && user.email) {
        const alertHtml = triggeredAlerts.map(a => `
          <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 16px; margin: 12px 0; border-radius: 0 8px 8px 0;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
              <span style="background: #3b82f6; color: white; padding: 2px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 1px;">PROFILE ALERT</span>
            </div>
            <div style="font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 8px;">${a.title}</div>
            <div style="font-size: 13px; color: #475569; line-height: 1.5; margin-bottom: 8px;">${a.reason}</div>
            <div style="font-size: 11px; color: #94a3b8;">Source: ${a.source} · Detected: ${new Date(a.detectedAt).toLocaleString()}</div>
            ${a.url ? `<a href="${a.url}" style="display: inline-block; margin-top: 8px; font-size: 12px; color: #2563eb; text-decoration: none;">Read Full Article →</a>` : ''}
          </div>
        `).join('');

        try {
          await transporter.sendMail({
            from: `"FOPs Profile Alerts" <${process.env.SENDER_EMAIL || 'alerts@fops.local'}>`,
            to: user.email,
            subject: `🎯 Personalized Alert: ${triggeredAlerts[0].title.slice(0, 80)}`,
            html: `
              <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; background: #ffffff;">
                <h2 style="color: #0f172a; margin: 0; font-size: 18px;">🎯 Personalized Profile Match</h2>
                <p style="color: #475569; font-size: 14px; margin-top: 8px;">We detected news specifically affecting your tracked commodities and regions.</p>
                ${alertHtml}
                <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">FOPs Pulse Intelligence Engine • Automatically generated based on your profile.</p>
              </div>
            `
          });
          console.log(`[USER-SCANNER] ✅ Sent profile alert to ${user.email}`);
        } catch (err) {
          console.error(`[USER-SCANNER] Email error (${user.email}):`, err.message);
        }
      }
    }
    return stats;
  } catch (err) {
    console.error(`[USER-SCANNER] Failure for user ${user.id}:`, err);
    stats.error = err.message;
    return stats;
  } finally {
    // Persist the outcome so a server restart (Render free-tier recycle /
    // redeploy) can't erase the scan result and make the status poll report
    // "no stats recorded". Runs on every return path above.
    if (user?.id) {
      try { await setLastScanResult(user.id, stats); }
      catch (e) { console.error(`[USER-SCANNER] Failed to persist scan result for ${user.id}:`, e.message); }
    }
  }
}

async function scanUserSpecificNews() {
  console.log('[USER-SCANNER] Running user-specific profile scan with new NewsPipeline...');
  try {
    const users = await getAllUsers();
    const pipeline = await initScannerPipeline();

    for (const user of users) {
      await scanSingleUser(user, pipeline);
    }
  } catch (err) {
    console.error('[USER-SCANNER] Global failure:', err);
  }
}

global.triggerUserScan = async (userId) => {
    try {
        const user = await findUserById(userId);
        if (!user) return { error: 'user not found' };
        console.log(`[USER-SCANNER] Manual scan triggered for user ${userId}`);
        const pipeline = await initScannerPipeline();
        return await scanSingleUser(user, pipeline);
    } catch (err) {
        console.error('Trigger scan error:', err);
        return { error: err.message };
    }
};

global.clearUserAlertsCache = (userId) => {
    if (userId) {
        delete userSpecificAlertsCache[userId];
    } else {
        Object.keys(userSpecificAlertsCache).forEach(k => delete userSpecificAlertsCache[k]);
    }
};

// Fire a scan and record it in global.scanState so /api/scan-status can be
// polled. Shared by the trigger-scan route and the settings-save rescan so
// both surface progress the same way. No-ops if a scan is already running.
global.startUserScanTracked = (uid) => {
    global.scanState = global.scanState || {};
    const existing = global.scanState[uid];
    if (existing && existing.running) return false;
    global.scanState[uid] = { running: true, stats: null, startedAt: Date.now(), finishedAt: null };
    global.triggerUserScan(uid)
        .then(stats => { global.scanState[uid] = { running: false, stats, startedAt: global.scanState[uid].startedAt, finishedAt: Date.now() }; })
        .catch(err => { global.scanState[uid] = { running: false, stats: { error: err.message }, startedAt: global.scanState[uid].startedAt, finishedAt: Date.now() }; });
    return true;
};

app.put('/api/sop/:id', requireAuth, async (req, res) => {
  try {
    await updateSopPlan(req.params.id, req.body);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to update S&OP plan' });
  }
});

// ── API: AI Feedback ──
app.post('/api/feedback', requireAuth, async (req, res) => {
  const { featureName, context, aiResponse, isHelpful, userNotes } = req.body;
  try {
    const id = await insertAiFeedback(req.session.userId, featureName, context, aiResponse, isHelpful, userNotes);
    res.json({ success: true, id });
  } catch (err) {
    console.error('Failed to insert AI feedback:', err);
    res.status(500).json({ success: false, error: 'Failed to record feedback' });
  }
});

// ── API: Get recent geopolitical alerts ──

// ── Morning Brief: "what changed since yesterday", real data only ──
// Alerts + accepted articles from Postgres; price moves computed from the
// live Yahoo quote vs its own same-contract previous close. No proxies —
// commodities without a real prevClose are omitted rather than estimated.
app.get('/api/morning-brief', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const [rawAlerts, acceptedNews] = await Promise.all([
            // SAME source as the Alerts tab (/api/analyze) and /api/alerts:
            // getActiveAlerts respects settings_changed_at gating + 24h expiry.
            // getAlertsSince (the old source here) ignored profile-change
            // gating, so the two views drew from different pools.
            getActiveAlerts(userId),
            getAcceptedArticlesSince(userId, 24, 5),
        ]);

        // Identical sort-then-quota as the Alerts tab and /api/alerts so the
        // three views can never disagree: at most 1 CRITICAL, 2 HIGH, 1
        // MEDIUM, no LOW.
        rawAlerts.sort((a, b) =>
            (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9)
            || new Date(b.created_at || 0) - new Date(a.created_at || 0));
        const newAlerts = applyAlertQuota(rawAlerts);

        const alertCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
        for (const a of newAlerts) {
            if (alertCounts[a.severity] != null) alertCounts[a.severity]++;
        }

        const tracked = req.userProfile?.commodities || [];
        const priceMovers = tracked
            .map(symbol => {
                const state = livePrices[symbol];
                if (!state || !(state.current > 0)) return null;
                // prevClose can be legitimately unknown (chart-fallback path
                // refuses cross-contract refs) — list the real price with a
                // null changePct instead of hiding the commodity or faking %.
                const hasPrev = state.prevClose > 0;
                const changePct = hasPrev ? ((state.current - state.prevClose) / state.prevClose) * 100 : null;
                return {
                    symbol,
                    label: symbol.replace(/_/g, ' '),
                    price: state.current,
                    prevClose: hasPrev ? state.prevClose : null,
                    changePct: hasPrev ? +changePct.toFixed(2) : null,
                    unit: COMMODITY_UNITS[symbol] || 'USD',
                };
            })
            .filter(Boolean)
            .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));

        res.json({
            success: true,
            since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            newAlerts,
            alertCounts,
            priceMovers,
            acceptedNews: acceptedNews.map(n => ({
                title: n.article_title,
                url: n.article_url,
                source: n.source,
                relevanceScore: n.relevance_score != null ? Number(n.relevance_score) : null,
                scannedAt: n.scanned_at,
            })),
        });
    } catch (err) {
        console.error('Morning brief error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to build morning brief' });
    }
});

// ── Precedent Engine: "last time this happened" ──
// Matches a live alert against a curated library of documented supply
// events, then computes what prices ACTUALLY did afterward from Yahoo's
// historical daily bars. All numbers are real fetched history; the
// library holds only factual event metadata. Aftermath windows are
// immutable, so they cache permanently per process.
const precedentAftermathCache = {}; // { `${eventId}:${symbol}`: aftermath|null }

async function getPrecedentAftermath(pastEvent, symbol) {
    const cacheKey = `${pastEvent.id}:${symbol}`;
    if (cacheKey in precedentAftermathCache) return precedentAftermathCache[cacheKey];

    const yTicker = YAHOO_SYMBOLS[symbol];
    if (!yTicker) return (precedentAftermathCache[cacheKey] = null);
    try {
        const period1 = new Date(pastEvent.date); period1.setDate(period1.getDate() - 10);
        const period2 = new Date(pastEvent.date); period2.setDate(period2.getDate() + 100);
        const chart = await yahooFinance.chart(yTicker, { period1, period2, interval: '1d' });
        const bars = (chart.quotes || [])
            .filter(q => q.close != null && q.date)
            .map(q => ({ date: q.date, close: toDollars(symbol, q.close) }));
        const aftermath = computeAftermath(bars, pastEvent.date);
        precedentAftermathCache[cacheKey] = aftermath;
        return aftermath;
    } catch (e) {
        console.error(`[PRECEDENT] History fetch failed for ${symbol} @ ${pastEvent.date}:`, e.message);
        return null; // don't cache failures — transient Yahoo errors can retry
    }
}

// Full daily history per symbol (~15y) for statistical analogs.
// One Yahoo call per symbol per UTC day.
const longHistoryCache = {}; // { symbol: { bars, fetchedDate } }
async function getLongHistory(symbol) {
    const today = new Date().toISOString().slice(0, 10);
    const cached = longHistoryCache[symbol];
    if (cached && cached.fetchedDate === today) return cached.bars;
    const yTicker = YAHOO_SYMBOLS[symbol];
    if (!yTicker) return null;
    try {
        const period1 = new Date();
        period1.setFullYear(period1.getFullYear() - 15);
        const chart = await yahooFinance.chart(yTicker, { period1, period2: new Date(), interval: '1d' });
        const bars = (chart.quotes || [])
            .filter(q => q.close != null && q.date)
            .map(q => ({ date: q.date, close: toDollars(symbol, q.close) }));
        longHistoryCache[symbol] = { bars, fetchedDate: today };
        return bars;
    } catch (e) {
        console.error(`[ANALOGS] Long history fetch failed for ${symbol}:`, e.message);
        return null;
    }
}

// Parse "CORN +7.1%" / "LIVE CATTLE -3.2%" out of a price-alert title.
const LABEL_TO_SYMBOL = Object.fromEntries(ALL_COMMODITIES.map(c => [c.key.replace(/_/g, ' '), c.key]));
function parsePriceMove(text) {
    const m = String(text).match(/([A-Za-z][A-Za-z ]{2,}?)\s+([+-]\d+(?:\.\d+)?)%/);
    if (!m) return null;
    const symbol = LABEL_TO_SYMBOL[m[1].trim().toUpperCase()];
    if (!symbol) return null;
    return { symbol, movePct: parseFloat(m[2]) };
}

// ── AI fallback matcher: token-minimal, cached, budgeted ──
// Called ONLY when deterministic matching finds nothing for a news alert.
// ~250 input + ~10 output tokens; identical alerts (which fan out to many
// users) hit the response cache and cost zero.
const llmMatchCache = new Map(); // normalizedText -> eventId | null
let llmMatcherBudget = { date: '', used: 0 };
const LLM_MATCHER_DAILY_CAP = envInt('PRECEDENT_LLM_DAILY_CAP', 100);

async function aiFallbackMatch(text) {
    const key = normalizeEventText(text);
    if (!key) return null;
    if (llmMatchCache.has(key)) {
        const cachedId = llmMatchCache.get(key);
        return cachedId ? parseMatcherResponse(cachedId) : null;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (llmMatcherBudget.date !== today) llmMatcherBudget = { date: today, used: 0 };
    if (llmMatcherBudget.used >= LLM_MATCHER_DAILY_CAP) {
        console.warn('[PRECEDENT] LLM matcher daily cap reached — falling back to no-match.');
        return null;
    }

    try {
        llmMatcherBudget.used++;
        const { system, user } = buildMatcherPrompt(text);
        // Plain text mode (jsonMode adds instruction tokens), 16-token output,
        // temperature 0 for cache-stable classification.
        // Precedent classification -> Gemini (everything-else routing).
        const raw = await callGeminiFlash(system, user, false, 16, 0);
        const matched = parseMatcherResponse(raw);
        // Only cache a CONFIDENT verdict: a real match, or the model explicitly
        // saying "none". An unrecognized reply also parses to null, and caching
        // that pinned a false "no precedent" on this key for the process
        // lifetime — and it was never logged, so it was invisible.
        const saidNone = /\bnone\b/i.test(String(raw || ''));
        if (matched || saidNone) {
            llmMatchCache.set(key, matched ? matched.id : null);
        } else {
            console.warn(`[PRECEDENT] unrecognized matcher reply (not cached): "${String(raw || '').slice(0, 80)}"`);
        }
        return matched;
    } catch (e) {
        console.error('[PRECEDENT] LLM fallback matcher failed:', e.message);
        return null; // not cached — transient errors may recover
    }
}

app.post('/api/precedent', requireAuth, async (req, res) => {
    try {
        const { text, category } = req.body || {};
        if (!text || typeof text !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing event text' });
        }

        const tracked = req.userProfile?.commodities || [];

        // 1) Statistical analogs for price-move alerts: the alert's own
        // commodity history is the dataset — no library required.
        let analogs = null;
        const priceMove = parsePriceMove(text);
        if (priceMove) {
            const bars = await getLongHistory(priceMove.symbol);
            const stats = bars ? findAnalogs(bars, priceMove.movePct) : null;
            if (stats) {
                analogs = {
                    symbol: priceMove.symbol,
                    movePct: priceMove.movePct,
                    ...stats,
                    summary: summarizeAnalogs(priceMove.symbol.replace(/_/g, ' '), priceMove.movePct, stats),
                };
            }
        }

        // 2) Curated-library precedents. Commodities are extracted from the
        // event text by the engine itself — the user's full tracked list
        // must NOT widen the match.
        let matches = matchPrecedents({ text, category });
        let matchedBy = matches.length ? 'deterministic' : null;

        // 3) AI fallback: news-type alerts only (price alerts are already
        // served by analogs), and only when keywords found nothing.
        if (matches.length === 0 && !priceMove) {
            const aiEvent = await aiFallbackMatch(text);
            if (aiEvent) {
                matches = [{ event: aiEvent, score: null }];
                matchedBy = 'ai';
            }
        }

        const precedents = [];
        for (const { event: past, score } of matches) {
            // Prefer a commodity the user actually tracks; fall back to the
            // event's primary commodity.
            const symbol = past.commodities.find(c => tracked.includes(c)) || past.commodities[0];
            const aftermath = await getPrecedentAftermath(past, symbol);
            precedents.push({
                id: past.id,
                date: past.date,
                title: past.title,
                category: past.category,
                symbol,
                matchScore: score,
                matchedBy,
                aftermath,
                summary: summarizePrecedent(past, symbol, aftermath),
            });
        }

        res.json({ success: true, precedents, analogs });
    } catch (err) {
        console.error('Precedent lookup error:', err.message);
        res.status(500).json({ success: false, error: 'Precedent lookup failed' });
    }
});

// One-shot diagnostic: the real state behind "no AI insight / no prices /
// no blocklist". Authenticated, scoped to the current user.
app.get('/api/debug-labeling', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    const out = { userId: uid };
    try {
        const prof = await getUserProfile(uid);
        out.profile = {
            customer_id: prof?.customer_id || null,
            news_keywords_count: (prof?.news_keywords || []).length,
            news_keywords_sample: (prof?.news_keywords || []).slice(0, 8),
            custom_blocklist: prof?.custom_blocklist || [],
            commodities: prof?.commodities || [],
            regions_count: (prof?.regions || []).length,
        };
        // Ingestion-time labeling is permanently removed (see scanSingleUser)
        // — this always reports false now regardless of the env flag.
        out.labelingEnabled = false;

        const ai = await pool.query(
            `SELECT ai.severity, ai.category, pal.article_title, ai.audit_log_id
             FROM article_insights ai JOIN pipeline_audit_logs pal ON ai.audit_log_id = pal.id
             WHERE ai.user_id=$1 ORDER BY ai.created_at DESC LIMIT 5`, [uid]);
        out.article_insights_count = (await pool.query('SELECT COUNT(*)::int n FROM article_insights WHERE user_id=$1', [uid])).rows[0].n;
        out.article_insights_sample = ai.rows;

        // Recent accepted-article titles (what labeling saw) — compare to the
        // news feed to judge title-overlap for hover matching.
        const acc = await pool.query(
            `SELECT article_title FROM pipeline_audit_logs WHERE user_id=$1 AND is_accepted=true ORDER BY scanned_at DESC LIMIT 5`, [uid]);
        out.recent_accepted_titles = acc.rows.map(r => r.article_title);

        // Prices — list every symbol with zero price, and whether it even has
        // a Yahoo ticker mapped, so a gap is diagnosable without guessing.
        const priced = Object.entries(livePrices).filter(([, s]) => s.current > 0);
        const missing = Object.entries(livePrices).filter(([, s]) => !(s.current > 0));
        out.prices = {
            total_symbols: Object.keys(livePrices).length,
            with_live_price: priced.length,
            priced_symbols: priced.map(([k, s]) => `${k}=${s.current}`),
            missing_symbols: missing.map(([k]) => ({ symbol: k, yahooTicker: YAHOO_SYMBOLS[k] || 'NOT MAPPED' })),
        };

        res.json({ success: true, ...out });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message, partial: out });
    }
});

// Recent labeled insights, read straight from storage — always has data
// once any scan has labeled something, unlike hover-matching against the
// live (rotating) news feed.

// Categorized news intelligence — replaces the (now-empty) LLM-labeled feed
// with deterministic categorization of accepted articles. Supply-chain
// disruption is pinned on top; within a tier, higher priority/relevance
// first. No LLM: category from the keyword categorizer, priority from the
// same score→bucket mapping the pipeline uses.
app.get('/api/news/categorized', requireAuth, async (req, res) => {
    try {
        const rows = await getRecentAcceptedArticles(req.session.userId, 48, 40);
        // Master data for rule-based entity matching. Merge the CUSTOMER's
        // commodities (e.g. Aramtec's food-service list) with the USER's own
        // tracked commodities — otherwise a user-tracked commodity outside the
        // customer catalog (oats, corn, gold) is never tagged, and its news
        // silently falls out of the commodity stream.
        const customer = await getCustomerProfileForUser(req.session.userId).catch(() => null);
        const master = {
            commodities: [...new Set([...(customer?.commodities || []), ...((req.userProfile?.commodities) || [])])],
            key_ports: customer?.key_ports || [],
            key_routes: customer?.key_routes || [],
            supplier_countries: customer?.supplier_countries || [],
        };
        const PRIO_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3, Ignored: 4 };
        const items = rows.map(r => {
            const cat = categorizeArticle(r.title);
            const priority = classifyPriority(Number(r.relevance_score) || 0);
            const ent = matchEntities(r.title, master);

            // Stream assignment by TYPE (never mixed). Region is NOT a hard
            // gate here — every article already passed the pipeline's region
            // rules at ingestion, and hard-gating on a title-only region match
            // silently hid accepted articles (esp. Global-focus profiles).
            // Region is instead the filter dropdown + a scoring priority.
            //   • RISK      = risk-factor category OR a chokepoint entity.
            //   • COMMODITY = a commodity entity (business/commodity relevance).
            //   • OTHER     = genuinely neither.
            const hasCommodity = ent.commodities.length > 0;
            const isRiskFactor = cat.stream === 'risk' || ent.chokepoints.length > 0;
            let stream;
            if (isRiskFactor) stream = 'risk';
            else if (hasCommodity) stream = 'commodity';
            else stream = 'other';

            return {
                entities: entitiesToChips(ent),
                title: r.title,
                url: r.url,
                source: r.source,
                score: Number(r.relevance_score) || 0,
                scannedAt: r.scanned_at,
                publishedAt: r.published_at || null,
                category: cat.key,
                categoryLabel: cat.label,
                categoryEmoji: cat.emoji,
                stream,
                isDisruption: cat.isDisruption,
                priority,
                regions: ent.regions.map(e => e.canonical),
                // Canonical (lowercase, space-separated) names of every matched
                // commodity — the UI groups the Commodity News stream by the
                // user's selected commodities using these.
                commodities: ent.commodities.map(e => e.canonical),
            };
        });
        // Disruption first, then by priority, then by score.
        items.sort((a, b) =>
            (b.isDisruption - a.isDisruption)
            || (PRIO_RANK[a.priority] - PRIO_RANK[b.priority])
            || (b.score - a.score));
        // Split into the two clean streams + the transparency bucket.
        const risk = items.filter(i => i.stream === 'risk');
        const commodity = items.filter(i => i.stream === 'commodity');
        const other = items.filter(i => i.stream === 'other');
        // Full country/region catalog so the filter offers every selectable
        // region, not just those present in the current results.
        res.json({ success: true, items, risk, commodity, other, regionCatalog: REGION_CATALOG });
    } catch (err) {
        console.error('Categorized news error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load categorized news' });
    }
});

// Batch insight lookup for the dashboard news feed (hover insights).
app.post('/api/insights/by-articles', requireAuth, async (req, res) => {
    try {
        const articles = Array.isArray(req.body?.articles) ? req.body.articles.slice(0, 60) : [];
        if (articles.length === 0) return res.json({ success: true, byUrl: {}, byTitle: {} });
        const maps = await getInsightsForArticles(req.session.userId, articles);
        res.json({ success: true, ...maps });
    } catch (err) {
        console.error('Insights lookup error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load insights' });
    }
});

// On-demand click-to-summarize for a single article. Cheap by design:
// 1) reuse an existing scanner-pipeline insight if this article was already
//    labeled (free, no LLM call), 2) else reuse a cached prior summary
//    (free), 3) else extract entities locally (regex, free) and send only
//    title+snippet+entities to Groq — no full article body, no re-derivation
//    of entities the LLM would otherwise have to search for.
app.post('/api/article-summary', requireAuth, async (req, res) => {
    try {
        const { url, title, description, source } = req.body || {};
        if (!url || !title) return res.status(400).json({ success: false, error: 'url and title are required' });

        // Note: we deliberately do NOT short-circuit to old article_insights
        // rows here. Those came from the now-removed scan-time labeler and
        // described the relevance score, not the article — serving them made
        // "AI Summary" show generic score-talk. This endpoint always produces
        // (or serves a cached) real article summary instead.
        const versionedModel = `${labelingConfig.models[labelingConfig.provider]}|${SUMMARY_VERSION}`;

        const cached = await getArticleSummaryCache(url);
        // Only trust cache written by the current prompt version.
        if (cached && cached.model === versionedModel) {
            return res.json({
                success: true, source: 'cache',
                insight: {
                    summary: cached.summary, impact: cached.impact, action_note: cached.action_note,
                    key_figures: cached.key_figures_json || [], entities: cached.entities_json,
                },
            });
        }

        if (!labelingConfig.groqApiKey && labelingConfig.provider !== 'anthropic') {
            return res.status(503).json({ success: false, error: 'Summary generation is not configured' });
        }

        const customer = await getCustomerProfileForUser(req.session.userId);

        // Strip the real article body (paragraph text, capped ~3000 chars) so
        // the model summarizes actual content, not the thin RSS snippet. Free
        // and local; falls back to the snippet if the fetch fails (paywall/JS).
        // Google News wrapper URLs are resolved to the real article inside.
        const stripped = await fetchArticleText(url, 3000);
        const bodyText = stripped?.text || null;

        // The client sends whatever the alert card had as "description" — for
        // news alerts that can be Google's RSS link-soup (<a href=...>) or the
        // scanner's score-talk reason ("Score: 70. Commodity Match..."). Neither
        // is article content; feeding them to the model produces summaries of
        // junk. Keep only text that reads like a real snippet.
        const cleanDesc = (() => {
            let d = String(description || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
            if (!d || d.length < 40) return null;
            if (/news\.google\.com/i.test(d)) return null;      // RSS link soup
            if (/^Score:\s*\d+/i.test(d)) return null;          // scanner reason text
            return d;
        })();

        // Entities come from the customer profile match on title+body, enriched
        // with anything the local NLP pass pulled out of the fetched article.
        const entities = extractLocalEntities(`${title} ${bodyText || cleanDesc || ''}`, customer);

        const result = await summarizeArticle({ title, description: cleanDesc, source }, entities, customer, bodyText);

        // Cache ONLY summaries built from a real article body. A fetch failure
        // can be transient (deploy lag, temporary block, proxy hiccup) — caching
        // its "text unavailable" summary would serve that failure forever and
        // block every future retry. No-body summaries stay uncached so the next
        // click re-attempts the fetch.
        if (bodyText) {
            await saveArticleSummaryCache(url, title, {
                summary: result.summary, impact: result.impact, action_note: result.action_note,
                key_figures: result.key_figures, entities, model: versionedModel,
            });
        }
        res.json({ success: true, source: 'generated', insight: { ...result, entities }, bodyAvailable: !!bodyText });
    } catch (err) {
        console.error('Article summary error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to generate summary' });
    }
});

// ── Unified persistent alerts (event × exposure store) ──
const SEV_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    // Active (≤24h) alerts, then the scarcity quota: at most 1 CRITICAL,
    // 2 HIGH, 1 MEDIUM across ALL alerts combined — LOW never shows. Sort by
    // severity then recency so the quota keeps the freshest of each tier and
    // the result reads critical-first.
    const raw = await getActiveAlerts(req.session.userId);
    raw.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || new Date(b.created_at) - new Date(a.created_at));
    const alerts = applyAlertQuota(raw);
    res.json({ success: true, alerts });
  } catch (err) {
    console.error('Failed to fetch alerts:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load alerts' });
  }
});

app.post('/api/alerts/:id/ack', requireAuth, async (req, res) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    if (!Number.isInteger(alertId)) return res.status(400).json({ success: false, error: 'Invalid alert id' });
    const ok = await acknowledgeAlert(req.session.userId, alertId);
    res.json({ success: ok });
  } catch (err) {
    console.error('Failed to acknowledge alert:', err.message);
    res.status(500).json({ success: false, error: 'Failed to acknowledge alert' });
  }
});



function scheduleScannerJobs() {
    if (!BACKGROUND_AI_ENABLED) {
        console.log('[SCANNERS] Background AI jobs disabled by configuration.');
        return;
    }

    if (GEO_SCANNER_ENABLED) {
        setInterval(scanGeopoliticalNews, GEO_SCAN_INTERVAL_MS);
        console.log(`[GEO-SCANNER] Live Geopolitical Alert Scanner initialized (polling every ${Math.round(GEO_SCAN_INTERVAL_MS / 60000)} min)`);
    } else {
        console.log('[GEO-SCANNER] Disabled by configuration.');
    }

    if (USER_SCANNER_ENABLED) {
        // Gate automatic scans on the last scan time recorded in the DB.
        // On free-tier hosting the process restarts constantly, so a naive
        // boot-time scan would run on every cold start (far more often than
        // the configured interval), while a plain setInterval would rarely
        // survive long enough to fire. This gives "at most once per
        // USER_SCAN_INTERVAL_MS, whenever the instance is awake".
        // Manual triggers (/api/trigger-scan) bypass the gate.
        const scanIfDue = async () => {
            try {
                const { rows } = await pool.query(
                    'SELECT EXTRACT(EPOCH FROM (NOW() - MAX(scanned_at))) AS age_s FROM pipeline_audit_logs'
                );
                const ageMs = rows[0]?.age_s != null ? Number(rows[0].age_s) * 1000 : Infinity;
                if (ageMs < USER_SCAN_INTERVAL_MS) {
                    console.log(`[USER-SCANNER] Skipping auto scan — last scan ${Math.round(ageMs / 60000)} min ago (interval ${Math.round(USER_SCAN_INTERVAL_MS / 60000)} min).`);
                    return;
                }
            } catch (e) {
                console.error('[USER-SCANNER] Last-scan check failed, proceeding with scan:', e.message);
            }
            await scanUserSpecificNews();
        };
        setTimeout(scanIfDue, 10000);
        // Re-check while awake, at most hourly — the DB gate enforces the real cadence.
        setInterval(scanIfDue, Math.min(USER_SCAN_INTERVAL_MS, 60 * 60 * 1000));
        console.log(`[USER-SCANNER] Profile scanner initialized (auto scan when last scan is older than ${Math.round(USER_SCAN_INTERVAL_MS / 60000)} min).`);
    } else {
        console.log('[USER-SCANNER] Disabled by configuration.');
    }
}

scheduleScannerJobs();

// ── AI Worker: Process Unprocessed News Embeddings ──
async function startAIWorker() {
    if (!BACKGROUND_AI_ENABLED || !AI_WORKER_ENABLED) {
        return console.log('[AI-WORKER] Disabled by configuration.');
    }
    if (!process.env.GEMINI_API_KEY || !GEMINI_EMBEDDINGS_ENABLED) {
        return console.warn('[AI-WORKER] Missing Gemini API key or embeddings disabled. Worker disabled.');
    }
    
    console.log(`[AI-WORKER] Background processor initialized (polling every ${Math.round(AI_WORKER_INTERVAL_MS / 60000)} min).`);
    
    const processBatch = async () => {
        try {
            const unprocessed = await getUnprocessedNews(10);
            if (!unprocessed || unprocessed.length === 0) return;
            
            console.log(`[AI-WORKER] Processing batch of ${unprocessed.length} new articles...`);
            
            const textsToEmbed = unprocessed.map(a => `Title: ${a.title}\nSummary: ${a.summary}`);
            
            // 1. Batch Generate Embeddings (1 API Call)
            let embeddings = [];
            try {
                embeddings = await generateBatchEmbeddings(textsToEmbed);
                // Check CONTENTS, not just length: the batch helper returns a
                // sparse array (cache hits only) when the budget blocks new
                // calls, and that array still has the full length.
                if (!embeddings || embeddings.length !== unprocessed.length) {
                    throw new Error('Batch embedding generation failed or returned mismatched count');
                }
                const missingAt = embeddings.findIndex(e => !Array.isArray(e) || e.length === 0);
                if (missingAt !== -1) {
                    throw new Error(`Batch embedding incomplete: no vector for item ${missingAt} of ${embeddings.length}`);
                }
                
                // Anti-zero embedding failsafe
                for (let emb of embeddings) {
                    if (emb && emb.every(v => v === 0)) {
                        throw new Error('Gemini returned an invalid zero-filled embedding');
                    }
                }
            } catch (embErr) {
                // Fail-closed here, correctly: articles stay queued rather than
                // being marked processed with no vector.
                const why = embErr instanceof EmbeddingUnavailableError ? embErr.reason : 'unexpected-error';
                console.warn(`[AI-WORKER] Embedding unavailable (${why}). Leaving ${unprocessed.length} article(s) queued for the next window: ${embErr.message}`);
                return;
            }
            
            // 2. Use deterministic classification. API tokens are reserved for planner recommendations and deep dives only.
            const classifications = unprocessed.map(() => ({ region: 'Global', commodity: 'General' }));
            
            // 3. Update Database
            for (let i = 0; i < unprocessed.length; i++) {
                const article = unprocessed[i];
                const embedding = embeddings[i];
                const classification = classifications[i] || { region: 'Global', commodity: 'General' };
                
                const region = classification.region || 'Global';
                const commodity = classification.commodity || 'General';
                
                await updateNewsEmbedding(article.article_url, embedding, region, commodity);
            }
            
            console.log(`[AI-WORKER] Successfully processed batch of ${unprocessed.length} articles.`);
        } catch (err) {
            console.error('[AI-WORKER] Error:', err.message);
        }
    };

    setTimeout(processBatch, Math.min(5 * 60 * 1000, AI_WORKER_INTERVAL_MS));
    setInterval(processBatch, AI_WORKER_INTERVAL_MS);
}

setTimeout(() => startAIWorker(), 90000); // Start after 90s

// ── AI Worker: Live Market Forecaster ──────────────────────────────
let cachedLLMForecast = {
    next7d: "Initializing AI models. Forecasting will be available shortly...",
    next30d: "Initializing AI models. Forecasting will be available shortly...",
    next90d: "Initializing AI models. Forecasting will be available shortly...",
    confidence: "PENDING"
};

async function runLLMForecastLoop() {
    if (!BACKGROUND_AI_ENABLED || !AI_FORECASTER_ENABLED) {
        return console.log('[AI-FORECASTER] Disabled by configuration.');
    }

    console.log(`[AI-FORECASTER] Background loop initialized. (Runs every ${Math.round(AI_FORECAST_INTERVAL_MS / 60000)} mins)`);

    const generate = async () => {
        try {
            console.log('[AI-FORECASTER] Using deterministic forecast; LLM generation disabled.');
            const brent = livePrices['BRENT_CRUDE']?.current || 75;
            const recentAlerts = recentGeoAlerts.map(a => `[${a.severity}] ${a.title}`).join(' | ');

            cachedLLMForecast = {
                next7d: `Brent is tracking near $${brent}; monitor short-term freight and energy pass-through risk.`,
                next30d: recentAlerts ? `Recent alerts remain active: ${recentAlerts.slice(0, 180)}.` : 'No major alert group is active; maintain baseline procurement monitoring.',
                next90d: 'Use planner recommendations or deep dives for AI-backed long-horizon interpretation.',
                confidence: 'LOW'
            };
            console.log('[AI-FORECASTER] Deterministic cached forecast updated.');
        } catch (err) {
            console.error('[AI-FORECASTER] Error generating forecast:', err.message);
        }
    };

    // setTimeout(generate, Math.min(150000, AI_FORECAST_INTERVAL_MS)); // Stagger from other tasks
    setInterval(generate, AI_FORECAST_INTERVAL_MS);
}

// ── Phase 5: Event-Aware Forecasting APIs ──────────────────────────────


const PORT = process.env.PORT || 3001;

// ── Serve React Frontend in Production ───────────────────────
const distPath = path.join(process.cwd(), 'dashboard', 'dist');
app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
        // index.html must always revalidate — it names the current hashed chunk
        // filenames. Caching it makes the browser request dead chunk hashes after
        // a redeploy ("Failed to fetch dynamically imported module"). Hashed assets
        // under /assets/ are content-addressed, so cache them immutably.
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    },
}));

// ── Unmatched /api paths are a 404, not the app shell ───────
// Must sit ABOVE the SPA catch-all below. That catch-all answers EVERY
// unmatched path with 200 + index.html, which is right for client-side routes
// (/dashboard, /settings) but wrong for the API: a typo'd or stale endpoint
// then returns 200 and a page of HTML, so callers see a login screen instead
// of an error and debug an auth problem that does not exist. This has already
// bitten an embedded iframe pointed at /api/market-info.html (the real file is
// at /market-info.html) and a health probe placed below the catch-all.
app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        error: `No such API endpoint: ${req.method} ${req.originalUrl.split('?')[0]}`,
        hint: 'Static files (e.g. market-info.html) are served from the site root, not under /api.',
    });
});

// Catch-all route to serve React's index.html for client-side routing
app.use((req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`FOps Market Pulse v2 running on :${PORT}`));
