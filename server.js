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
import authRouter, { requireAuth } from './auth.js';
import { NewsPipeline } from './services/news-pipeline/pipeline.js';
import { fetchAndExtractArticle } from './services/news-pipeline/utils/nlp_extractor.js';
import { pool, getUserProfile, updateUserProfile, getAllUsers, getAllUserPriceAlerts, insertPriceTicksBatch, insertWeatherSnapshot, insertNewsEmbedding, getUnprocessedNews, updateNewsEmbedding, getPriceHistory, getWeatherHistory, searchSimilarNews, getRecentNewsEmbeddings, createSopPlan, getSopPlans, updateSopPlan, insertAiFeedback, getRecentAiFeedback, findUserById, insertPipelineAuditLog, getPipelineAuditLogs, insertAlert, getActiveAlerts, acknowledgeAlert, getRecentAlertsBySource, getAlertsSince, getAcceptedArticlesSince } from './db.js';
import { scoreAlertExposure, severityFromScore, severityFromPriority } from './services/alert-relevance.js';
import { analyzePriceSeries, describeAnomaly, anomalyRelevanceScore } from './services/price-anomaly.js';
import { matchPrecedents, computeAftermath, summarizePrecedent, buildMatcherPrompt, parseMatcherResponse, normalizeEventText } from './services/precedent-engine.js';
import { findAnalogs, summarizeAnalogs } from './services/price-analogs.js';
import { ALL_REGIONS, ALL_COMMODITIES } from './onboarding-templates.js';
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

// Derived from ALL_COMMODITIES — the onboarding list and the price fetcher
// share one source of truth, so users can only select commodities with a
// real Yahoo Finance futures feed. No proxies.
const YAHOO_SYMBOLS = Object.fromEntries(
    ALL_COMMODITIES.filter(c => c.yahooSymbol).map(c => [c.key, c.yahooSymbol])
);
const COMMODITY_UNITS = Object.fromEntries(
    ALL_COMMODITIES.map(c => [c.key, c.unit])
);

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

// NOTE: never add endpoints that echo process.env values — a debug route
// here once returned the raw GROQ_API_KEY unauthenticated.
app.get('/api/debug-python', requireAuth, async (req, res) => {
    try {
        const aiBaseUrl = process.env.AI_SERVICE_URL ? process.env.AI_SERVICE_URL.replace(/\/$/, '') : 'http://127.0.0.1:8000';
        const pythonHealth = await axios.get(`${aiBaseUrl}/health`, { timeout: 5000 });
        res.json({ python_service: 'RUNNING', health: { status: pythonHealth.data?.status, service: pythonHealth.data?.service } });
    } catch (err) {
        res.json({ python_service: 'DOWN', error: err.message });
    }
});

app.get('/api/token-usage', requireAuth, (req, res) => {
    res.json(tokenUsage);
});

app.get('/api/rate-limits', requireAuth, (req, res) => {
    res.json(global.apiRateLimits || { remaining: 'N/A', reset: 'N/A' });
});

const GROQ_KEY = process.env.GROQ_API_KEY;
const COMMODITY_KEY = process.env.COMMODITY_API_KEY;
const NEWS_KEY = process.env.NEWSDATA_API_KEY;
const EIA_KEY = process.env.EIA_API_KEY;

const envInt = (name, fallback) => {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

const envMs = (name, fallback) => envInt(name, fallback);

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
const MAX_USER_SCANNER_ALERTS = envInt('MAX_USER_SCANNER_ALERTS', 15);

// ── Token Usage Tracking ─────────────────────────────────────
let tokenUsage = { groqInput: 0, groqOutput: 0, geminiInput: 0, geminiOutput: 0, totalCalls: 0, since: new Date().toISOString() };



export async function callGeminiFlash(systemPrompt, userContent, jsonMode = true, maxTokens = 1500, temperature = 0.1) {
    if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");
    
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
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
                        ...jsonConfig
                    }
                }
            );
            
            const gemUsage = data.usageMetadata;
            if (gemUsage) { tokenUsage.geminiInput += gemUsage.promptTokenCount || 0; tokenUsage.geminiOutput += gemUsage.candidatesTokenCount || 0; tokenUsage.totalCalls++; }
            
            let text = data.candidates[0].content.parts[0].text;
            if (jsonMode) {
                text = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
            }
            return text;
        } catch (err) {
            console.error('[GEMINI] API Error:', err.response?.data?.error?.message || err.message);
            throw err;
        }
    }
}

export async function callGroq(model, systemPrompt, userContent, jsonMode = true, maxTokens = 1500, temperature = 0.1, allowDeterministicFallback = true) {
    // INTERCEPT DISABLED: Let Groq handle its own models to prevent Gemini rate limits crashing the drivers.
    if (model === 'llama-3.3-70b-versatile' && false) {
        const hash = crypto.createHash('sha256').update(systemPrompt + userContent).digest('hex');
        if (!global.llmCache) global.llmCache = {};
        
        const cached = global.llmCache[hash];
        if (cached && (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000)) {
            console.log(`[GEMINI CACHE HIT] Returned cached response for article.`);
            return cached.data;
        }

        console.log(`[GEMINI API CALL] Routing scanner evaluation to Gemini 2.5 Flash...`);
        const result = await callGeminiFlash(systemPrompt, userContent, jsonMode, maxTokens, temperature);
        global.llmCache[hash] = { data: result, timestamp: Date.now() };
        return result;
    }

    if (global.aiCircuitBreaker && Date.now() < global.aiCircuitBreaker) {
        console.warn(`[CIRCUIT-BREAKER] Groq API blocked. Falling back to Gemini 2.5 Flash for model ${model}`);
        if (process.env.GEMINI_API_KEY) {
            return await callGeminiFlash(systemPrompt, userContent, jsonMode, maxTokens, temperature);
        }
        throw new Error('Circuit Breaker active and no Gemini API Key available');
    }

    try {
        if (!GROQ_KEY) throw new Error('Missing GROQ_API_KEY');
        const finalUserContent = jsonMode ? userContent + "\n\nOutput ONLY valid JSON." : userContent;
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
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_KEY}`,
                    'Content-Type': 'application/json',
                }
            }
        );
        const usage = response.data.usage;
        if (usage) { tokenUsage.groqInput += usage.prompt_tokens || 0; tokenUsage.groqOutput += usage.completion_tokens || 0; tokenUsage.totalCalls++; }
        
        // Track API limits
        const remaining = response.headers['x-ratelimit-remaining-requests'];
        const reset = response.headers['x-ratelimit-reset-requests'];
        if (remaining !== undefined && reset !== undefined) {
            global.apiRateLimits = { remaining, reset, lastUpdated: Date.now() };
        }

        console.log(`[TOKENS] Groq ${model} | in:${usage?.prompt_tokens || 0} out:${usage?.completion_tokens || 0} | cumulative: ${tokenUsage.groqInput + tokenUsage.groqOutput} total`);
        return response.data.choices[0].message.content;
    } catch (err) {
        if (err.response?.headers) {
            const remaining = err.response.headers['x-ratelimit-remaining-requests'] || err.response.headers['x-ratelimit-remaining-tokens'];
            const reset = err.response.headers['x-ratelimit-reset-requests'] || err.response.headers['x-ratelimit-reset-tokens'];
            if (remaining !== undefined && reset !== undefined) {
                global.apiRateLimits = { remaining, reset, lastUpdated: Date.now() };
            }
        }
        const errMsg = err.response?.data?.error?.message || err.message;
        if (errMsg.includes('Please try again in')) {
            const match = errMsg.match(/Please try again in (.*?)\./);
            if (match) {
                const waitStr = match[1];
                let waitMs = 0;
                const minMatch = waitStr.match(/([\d.]+)m/);
                const secMatch = waitStr.match(/([\d.]+)s/);
                if (minMatch) waitMs += parseFloat(minMatch[1]) * 60000;
                if (secMatch) waitMs += parseFloat(secMatch[1]) * 1000;
                global.apiRateLimits = { remaining: '0', reset: waitStr, lastUpdated: Date.now() };
                global.aiCircuitBreaker = Date.now() + waitMs + 2000;
            }
        }
        console.log(`[FAILOVER] Primary Groq failed (${model}): ${errMsg}. Falling back to Gemini 2.5 Flash.`);
        if (process.env.GEMINI_API_KEY) {
            try {
                return await callGeminiFlash(systemPrompt, userContent, jsonMode, maxTokens, temperature);
            } catch (geminiErr) {
                console.log(`[FAILOVER] Gemini 2.5 Flash also failed. Trying Groq Llama 3.3 70B...`);
            }
        }
        try {
                if (!GROQ_KEY) throw new Error('Missing GROQ_API_KEY');
                const groqBackup2 = await axios.post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    {
                        model: 'llama-3.1-8b-instant',
                        max_tokens: maxTokens,
                        temperature: temperature,
                        ...(jsonMode && { response_format: { type: 'json_object' } }),
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userContent },
                        ],
                    },
                    {
                        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' }
                    }
                );
                const usage = groqBackup2.data.usage;
                if (usage) { tokenUsage.groqInput += usage.prompt_tokens || 0; tokenUsage.groqOutput += usage.completion_tokens || 0; tokenUsage.totalCalls++; }
                console.log(`[TOKENS] Groq llama-3.1-8b-instant | in:${usage?.prompt_tokens || 0} out:${usage?.completion_tokens || 0} | cumulative: ${tokenUsage.groqInput + tokenUsage.groqOutput} total`);
                return groqBackup2.data.choices[0].message.content;
            } catch (fallbackErr2) {
                if (fallbackErr2.response?.headers) {
                    const remaining = fallbackErr2.response.headers['x-ratelimit-remaining-requests'];
                    const reset = fallbackErr2.response.headers['x-ratelimit-reset-requests'];
                    if (remaining !== undefined && reset !== undefined) {
                        global.apiRateLimits = { remaining, reset, lastUpdated: Date.now() };
                    }
                }
                if (process.env.GEMINI_API_KEY) {
                    console.log(`[FAILOVER] Groq Mixtral failed. Using Gemini 2.5 Flash fallback...`);
                    try {
                    const result = await callGeminiFlash(systemPrompt, userContent, jsonMode, maxTokens, temperature);
                    console.log(`[TOKENS] Gemini 2.5 Flash Fallback executed successfully.`);
                    return result;
                } catch (geminiErr) {
                    console.error('[FAILOVER] Gemini also failed:', geminiErr.response?.data?.error?.message || geminiErr.message);
                }
            }

            throw new Error('AI providers unavailable. Check GROQ_API_KEY or GEMINI_API_KEY quota/configuration.');
        }
    }
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
    try {
        console.log('[LOGISTICS] Fetching real-time maritime logistics news...');
        let newsData = [];
        if (process.env.NEWSDATA_API_KEY) {
            const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&q=Jebel%20Ali%20OR%20freight%20rates%20OR%20port%20congestion&language=en`;
            const response = await axios.get(url);
            if (response.data && response.data.results) {
                newsData = response.data.results;
            }
        }
        
        const prompt = `Extract exactly the current real-time maritime metrics from this raw live news feed.
News: ${newsData.slice(0, 10).map(n => n.title + ' - ' + n.description).join(' | ')}

If no explicit numbers exist in the news, estimate the current status based on global sentiment and typical baselines (e.g., Jebel Ali base is 1.5 days). You MUST provide realistic numbers.
Return valid JSON exactly matching this format:
{
  "portCongestion": [
    { "port": "Jebel Ali (Real-Time)", "status": "CONGESTED", "delayDays": 3.5, "reason": "Extracted from news" }
  ],
  "freightRates": { "reeferIndexFEU": 4500, "bunkerSurchargeImpact": "HIGH", "trend": "SPIKING" },
  "airFreightRates": { "ratePerKg": 4.20, "trend": "STABLE" },
  "geopoliticalRiskIndex": 6.5
}`;

        cachedRealTimeLogistics = {
            portCongestion: [{ port: 'Jebel Ali (Real-Time)', status: 'NORMAL', delayDays: 1.5, reason: 'Deterministic baseline; LLM extraction disabled' }],
            freightRates: { reeferIndexFEU: 0, bunkerSurchargeImpact: 'NORMAL', trend: 'BASELINE' },
            airFreightRates: { ratePerKg: 0, trend: 'BASELINE' },
            geopoliticalRiskIndex: newsData.length > 0 ? 5 : 3
        };
        console.log('[LOGISTICS] Deterministic logistics baseline refreshed; LLM extraction disabled.');
    } catch (e) {
        console.error('[LOGISTICS] Failed to fetch real-time logistics via LLM:', e.message);
    }
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

function reserveEmbeddingBudget(count) {
    if (!GEMINI_EMBEDDINGS_ENABLED || !process.env.GEMINI_API_KEY) return false;
    if (Date.now() < embeddingCircuitOpenUntil) return false;

    resetEmbeddingBudgetIfNeeded();
    if (embeddingUsageCount + count > EMBEDDING_DAILY_BUDGET) {
        embeddingCircuitOpenUntil = Date.now() + msUntilNextUtcDay();
        console.warn(`[EMBEDDINGS] Daily embedding budget reached (${embeddingUsageCount}/${EMBEDDING_DAILY_BUDGET}). Skipping Gemini embeddings until tomorrow.`);
        return false;
    }

    embeddingUsageCount += count;
    return true;
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

export async function generateEmbedding(text) {
    const normalizedText = normalizeEmbeddingText(text);
    if (!normalizedText) return null;

    const cached = getCachedEmbedding(normalizedText);
    if (cached) return cached;
    if (!reserveEmbeddingBudget(1)) return null;

    try {
        const { data } = await axios.post(geminiEmbeddingEndpoint('embedContent'), {
            model: geminiEmbeddingModelResource(),
            content: { parts: [{ text: normalizedText }] },
            outputDimensionality: EMBEDDING_OUTPUT_DIMENSIONS
        }, { headers: { 'Content-Type': 'application/json' } });
        const embedding = data.embedding.values;
        setCachedEmbedding(normalizedText, embedding);
        return embedding;
    } catch (err) {
        console.error('Gemini embedding failed:', err.response?.data?.error?.message || err.message);
        pauseEmbeddingsAfterFailure(err);
        return null;
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
    if (!reserveEmbeddingBudget(missing.size)) return [];

    const missingTexts = Array.from(missing.keys());
    try {
        const { data } = await axios.post(geminiEmbeddingEndpoint('batchEmbedContents'), {
            requests: missingTexts.map(text => ({
                model: geminiEmbeddingModelResource(),
                content: { parts: [{ text }] },
                outputDimensionality: EMBEDDING_OUTPUT_DIMENSIONS
            }))
        }, { headers: { 'Content-Type': 'application/json' } });

        const freshEmbeddings = data.embeddings?.map(e => e.values) || [];
        if (freshEmbeddings.length !== missingTexts.length) {
            throw new Error(`Gemini returned ${freshEmbeddings.length} embeddings for ${missingTexts.length} texts`);
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
        console.error('Gemini batch embedding failed:', err.response?.data?.error?.message || err.message);
        pauseEmbeddingsAfterFailure(err);
        return [];
    }
}

// ── ROUTE: commodity prices (reads from live Yahoo-fed engine) ──────
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

        // Normalize to USD using the chart's own currency: "USX" means the
        // contract quotes in US cents. This keeps history consistent with
        // the live tick normalization in tickPrices.
        const centsQuoted = chart.meta?.currency === 'USX';
        let normalized = hist.map(d => {
            let price = d.close;
            let open = d.open;
            let high = d.high;
            let low = d.low;
            let volume = d.volume;

            if (centsQuoted) {
                if (price) price = price / 100;
                if (open) open = open / 100;
                if (high) high = high / 100;
                if (low) low = low / 100;
            }
            return {
                time: d.date.toISOString(),
                price: price ? parseFloat(price.toFixed(2)) : 0,
                open: open ? parseFloat(open.toFixed(2)) : null,
                high: high ? parseFloat(high.toFixed(2)) : null,
                low: low ? parseFloat(low.toFixed(2)) : null,
                volume: volume || 0
            };
        }).filter(d => d.price > 0).sort((a, b) => new Date(a.time) - new Date(b.time));

        // If 1D, we fetched 3 days to bypass weekends. Now slice down to just the last ~1 day of points.
        // 1 day at 15m intervals = 96 points max.
        if (range === '1D') {
            normalized = normalized.slice(-96);
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


// ── ROUTE: forex (FREE — open.er-api.com, no key) ───────────────────
app.get('/api/forex', requireAuth, async (req, res) => {
    try {
        const { data } = await axios.get('https://open.er-api.com/v6/latest/USD');
        const relevant = {};
        const currencies = {
            // ── Middle East (import-side) ──
            AED: { name: 'UAE Dirham', commodities: ['Frozen Food', 'Meat', 'Poultry', 'Seafood'] },
            SAR: { name: 'Saudi Riyal', commodities: ['Frozen Food', 'Wheat', 'Rice', 'Meat'] },
            QAR: { name: 'Qatari Riyal', commodities: ['Frozen Food', 'Meat', 'Dairy'] },
            KWD: { name: 'Kuwaiti Dinar', commodities: ['Frozen Food', 'Meat', 'Poultry'] },
            BHD: { name: 'Bahraini Dinar', commodities: ['Frozen Food', 'Seafood'] },
            OMR: { name: 'Omani Rial', commodities: ['Frozen Food', 'Seafood', 'Meat'] },
            EGP: { name: 'Egyptian Pound', commodities: ['Wheat', 'Corn', 'Frozen Food'] },
            JOD: { name: 'Jordanian Dinar', commodities: ['Frozen Food', 'Wheat', 'Meat'] },
            // ── Export-side (food suppliers to ME) ──
            BRL: { name: 'Brazilian Real', commodities: ['Soybeans', 'Coffee', 'Sugar', 'Corn', 'Poultry'] },
            INR: { name: 'Indian Rupee', commodities: ['Rice', 'Wheat', 'Sugar', 'Milk'] },
            EUR: { name: 'Euro', commodities: ['Wheat', 'Milk', 'Sugar', 'Frozen Vegetables'] },
            CNY: { name: 'Chinese Yuan', commodities: ['Soybeans', 'Rice', 'Corn', 'Seafood'] },
            IDR: { name: 'Indonesian Rupiah', commodities: ['Palm Oil', 'Rice', 'Coffee'] },
            THB: { name: 'Thai Baht', commodities: ['Rice', 'Sugar', 'Frozen Seafood'] },
            AUD: { name: 'Australian Dollar', commodities: ['Wheat', 'Cattle', 'Frozen Meat'] },
            ARS: { name: 'Argentine Peso', commodities: ['Soybeans', 'Corn', 'Wheat', 'Frozen Beef'] },
            MYR: { name: 'Malaysian Ringgit', commodities: ['Palm Oil'] },
        };
        for (const [code, meta] of Object.entries(currencies)) {
            if (data.rates[code]) {
                relevant[code] = { rate: data.rates[code], ...meta };
            }
        }
        res.json({ success: true, base: 'USD', lastUpdate: data.time_last_update_utc, rates: relevant });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── ROUTE: extended weather (profile-aware regions, 30d history) ─
app.get('/api/weather-extended', requireAuth, async (req, res) => {
    const userRegions = req.userProfile?.regions || [];
    const customRegions = req.userProfile?.custom_regions || [];
    const standardRegions = userRegions.length > 0
        ? ALL_REGIONS.filter(r => userRegions.includes(r.name))
        : ALL_REGIONS;
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
        console.error('AI Forecast error:', err.message);
        console.log('Falling back to deterministic crop yield forecast.');
        
        let fallbackText = `Current metrics indicate a stable environment for ${crop} yields.`;
        if (analytics.alert === 'SEVERE_DROUGHT' || analytics.droughtScore > 80) {
            fallbackText = `Severe drought conditions (${analytics.droughtScore}/100) are critically threatening ${crop} yields. Expect significant volume reduction and logistical constraints.`;
        } else if (analytics.alert === 'DROUGHT_RISK' || analytics.droughtScore > 50) {
            fallbackText = `Elevated drought risk detected due to low precipitation (${analytics.totalPrecip30d}mm/30d). ${crop} yields may face moderate pressure if dry patterns persist.`;
        } else if (analytics.alert === 'HEAT_STRESS') {
            fallbackText = `Extreme temperatures reaching ${analytics.maxTemp7d}°C are placing severe heat stress on ${crop} development. Potential for reduced harvest quality.`;
        } else if (analytics.alert === 'FLOOD_RISK') {
            fallbackText = `Excessive recent rainfall (${analytics.recentPrecipMm}mm/7d) poses a high flood risk to ${crop} fields. Localized washouts and logistical delays are probable.`;
        } else if (analytics.logisticsRisk) {
            fallbackText = `While crop development is stable, high winds or low visibility present significant logistical risks for transporting ${crop} from the region.`;
        }

        res.json({ success: true, forecast: `[DETERMINISTIC FALLBACK] ${fallbackText}` });
    }
});

// ── ROUTE: simple weather (backward compatible, profile-aware) ───────
app.get('/api/weather', requireAuth, async (req, res) => {
    const userRegions = req.userProfile?.regions || [];
    const customRegions = req.userProfile?.custom_regions || [];
    const standardRegions = (userRegions.length > 0
        ? ALL_REGIONS.filter(r => userRegions.includes(r.name))
        : ALL_REGIONS
    ).map(r => ({ name: r.name, lat: r.lat, lon: r.lon, crop: r.crop }));
    const regions = [...standardRegions, ...customRegions];
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
            const maxTemp = temps.length ? Math.max(...temps) : 0;
            const result = {
                ...r,
                avgTempC: temps.length ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : 'N/A',
                totalPrecipMm: totalRain.toFixed(1),
                alert: totalRain < 5 ? 'DROUGHT_RISK' : maxTemp > 38 ? 'HEAT_STRESS' : 'NORMAL',
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
        if (!name) return res.status(400).json({ error: 'Region name is required' });

        // Geocode using open-meteo (handle comma separated like 'Punjab, India')
        const queryName = name.split(',')[0].trim();
        const { data } = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
            params: { name: queryName, count: 10, language: 'en', format: 'json' }
        });

        if (!data.results || data.results.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }

        let location = data.results[0];
        const parts = name.split(',').map(s => s.trim().toLowerCase());
        if (parts.length > 1) {
            const countryQuery = parts[1];
            const exact = data.results.find(r => r.country?.toLowerCase().includes(countryQuery));
            if (exact) location = exact;
        }
        const newRegion = {
            name: location.name,
            country: location.country,
            lat: location.latitude,
            lon: location.longitude,
            crop: crop || 'Mixed Agriculture'
        };

        const currentProfile = req.userProfile;
        const customRegions = currentProfile.custom_regions || [];
        
        // Check if already exists to prevent duplicates
        if (!customRegions.find(r => r.name === newRegion.name && r.country === newRegion.country)) {
            customRegions.push(newRegion);
            // Save to DB
            await updateUserProfile(req.user.id, { ...currentProfile, custom_regions: customRegions });
        }

        res.json({ success: true, region: newRegion, custom_regions: customRegions });
    } catch (err) {
        console.error('Add region error:', err.message);
        res.status(500).json({ error: 'Failed to add region' });
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

app.post('/api/trigger-scan', requireAuth, async (req, res) => {
    try {
        // Run the scan specifically for this user and wait for it to finish
        // so that the frontend's refresh actually sees the new logs.
        if (global.triggerUserScan) {
            await global.triggerUserScan(req.session.userId);
        } else {
            scanUserSpecificNews(); // fallback if global not registered yet
        }
        res.json({ success: true, message: 'Scanner triggered successfully' });
    } catch (err) {
        console.error('Failed to trigger scanner:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

app.get('/api/news', requireAuth, async (req, res) => {
    try {
        const userKeywords = req.userProfile?.news_keywords || ['frozen food', 'cold chain', 'frozen goods'];
        const trackedCommodities = req.userProfile?.commodities || [];
        const focusRegion = req.userProfile?.focus_region || 'Middle East';
        const focusProduct = req.userProfile?.focus_product || 'Commodities';
        
        // Dynamically build Google News queries. Append market context to avoid consumer/recipe news.
        const querySuffix = ' AND (market OR "supply chain" OR trade OR agriculture OR prices OR export)';
        const googleQueries = [
            ...userKeywords.map(kw => `"${kw}"${querySuffix}`),
            ...trackedCommodities.map(c => `"${c.replace(/_/g, ' ')}"${querySuffix}`),
            `"${focusProduct}" "${focusRegion}"${querySuffix}`
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

        // ── Source 2: NewsData.io (backup, with Middle East country codes) ──
        if (NEWS_KEY) {
            try {
                let newsDataQuery = userKeywords.map(kw => `"${kw}"`).join(' OR ');
                if (newsDataQuery.length > 100) {
                    // NewsData free tier limits query to 100 chars. Fallback to just the main product keyword
                    newsDataQuery = `"${focusProduct}"`.substring(0, 100);
                }

                const { data } = await axios.get('https://newsdata.io/api/1/news', {
                    params: {
                        apikey: NEWS_KEY,
                        q: newsDataQuery,
                        country: req.userProfile?.news_country_codes || 'ae,sa,eg,qa,kw',
                        language: 'en',
                        size: 10,
                    },
                    timeout: 8000,
                });
                const newsDataArticles = (data.results || []).map(a => ({
                    title: a.title,
                    description: a.description?.slice(0, 250),
                    source: a.source_id,
                    publishedAt: a.pubDate,
                    url: a.link,
                    via: 'newsdata-io',
                }));
                allArticles.push(...newsDataArticles);
            } catch (err) {
                console.log('NewsData.io backup error:', err.response?.data || err.message);
            }
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

        console.log(`News: fetched ${allArticles.length} articles, ${unique.length} unique (Google News + NewsData.io)`);
        
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
                if (batchEmbeddings && batchEmbeddings.length === textsToEmbed.length) {
                    const contextEmb = batchEmbeddings[0];
                    verifiedArticles = verifiedArticles.filter((a, i) => {
                        const sim = cosineSimilarity(contextEmb, batchEmbeddings[i + 1]);
                        return sim >= 0.55;
                    });
                    console.log(`[SEMANTIC-FILTER] Kept ${verifiedArticles.length} relevant articles out of ${textsToEmbed.length - 1}`);
                }
            } catch (err) {
                console.error('[SEMANTIC-FILTER] Error:', err.message);
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
            req.body.userAlerts = dbAlerts.map(a => ({
                id: a.id,
                severity: a.severity,
                category: a.category,
                title: a.title,
                reason: a.reason,
                url: a.url,
                detectedAt: a.created_at,
            }));
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
                // deterministic engine — the strongest signal we have, and
                // previously never reached this prompt at all.
                const shortAlerts = (req.body.userAlerts || []).slice(0, 5)
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
- Prioritize active alerts as evidence over raw news/prices — they are pre-verified as relevant.
- Every driver's "explanation" and "evidence" MUST reference a specific number, alert, headline, or weather flag from the DATA above. Never write a generic driver with no citation.
- "strength" (1-10) must reflect actual magnitude in the data (e.g. a +7% price move or CRITICAL alert = 8-10; a NORMAL weather flag or routine headline = 1-3), not a default middle value.
- Do NOT invent commodities, regions, or events not present in the data. If the data is thin, pick the 3 most concrete items available rather than padding with generic macro commentary.
- BANNED as filler: "market volatility", "global uncertainty", "supply chain disruptions" used without naming the specific disruption.

Return ONLY a JSON object: {"drivers": [...]} with exactly 3 objects, each:
"factor": string, e.g. "WEATHER: Drought in Brazil" or "PRICE: Corn +7.1% today"
"direction": "UP" | "DOWN" | "NEUTRAL"
"strength": number 1-10, reflecting actual magnitude above
"explanation": string, 1 sentence, must cite the specific data point
"evidence": array of 1-2 strings quoting the exact alert/headline/number used`;

                // 70B for reasoning quality — same fix applied to the planner
                // and deep-dive. Falls back to 8B/Gemini on rate limits via
                // callGroq's existing failover chain.
                const driverRes = await callGroq('llama-3.3-70b-versatile', driversPrompt, "You are a precise JSON data API. You must return a fully complete JSON object.", true, 1000, 0.3, false);
                const driverParsed = JSON.parse(driverRes);

                if (driverParsed && driverParsed.drivers && Array.isArray(driverParsed.drivers) && driverParsed.drivers.length > 0) {
                    analysis.drivers = driverParsed.drivers;
                    global.marketDriversCache[mdCacheKey] = { data: driverParsed.drivers, timestamp: mdNow };
                } else {
                    throw new Error("LLM returned empty or invalid drivers format");
                }
            } catch (e) {
                console.error('Failed to generate Market Drivers via LLM:', e.message);
                analysis.drivers = [{
                    factor: 'SYSTEM: AI Generation Failed',
                    direction: 'NEUTRAL',
                    strength: 1,
                    explanation: `Market driver generation encountered an error: ${e.message}`,
                    evidence: ['Please refresh the page to try again.']
                }];
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


        // Pipeline-verified insights only (token-efficient): NLP summaries of
        // articles that passed the 9-stage profile scanner, from the alerts
        // store. Falls back to 3 raw headlines only when no insights exist.
        let newsBlock = '';
        try {
            const insightRows = await getRecentAlertsBySource(req.session.userId, 'PROFILE_NEWS', 72, 5);
            newsBlock = insightRows.map((r, i) => {
                const title = (r.title || '').replace(/^🎯 Profile Alert:\s*/, '');
                const summary = String(r.payload?.description || '').replace(/^NLP Summary:\s*/, '').slice(0, 220);
                const ent = r.payload?.entities || {};
                const facts = [...(ent.places || []).slice(0, 3), ...(ent.values || []).slice(0, 3)].join(', ');
                return `${i + 1}. [${r.severity} ${r.relevance_score ?? '?'}/100] ${title}${summary ? ` — ${summary}` : ''}${facts ? ` (Key facts: ${facts})` : ''}`;
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
Targeted Regions: ${[...(req.userProfile?.regions || []), focusRegion].join(', ')}

=== PIPELINE-VERIFIED NEWS INSIGHTS ===
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
1. You MUST ground the analysis in the "PIPELINE-VERIFIED NEWS INSIGHTS" (each passed a relevance pipeline for this user's supply chain — cite their specific events and figures) and the "REGIONAL WEATHER" conditions. Do NOT hallucinate news or weather.
2. DO NOT use generic filler phrases like "variance index" or "macroeconomic indicators".
3. Provide a highly structured, concise, and deeply informative analysis (around 100-150 words). Dive into the nuances and strategic implications of the data. Format the output as plain text with line breaks (\\n). Use dashes (-) for bullet points. DO NOT output any HTML tags.
4. SYNTHESIZE the data into actionable insights. Tell the user WHY the data matters at a strategic executive level.
5. Explain the *hidden risks* and *geopolitical drivers* behind the action plan based purely on the provided news and market data.
6. Provide 2 to 3 specific, highly actionable strategic bullet points directly relating to the selected commodity.
7. QUALITY BAR: every bullet must cite a specific number, date, source, or named event from the data sections above. BANNED: "monitor the situation", "stay informed", "diversify", "enhance resilience", and "mitigate risks" without naming the risk and mechanism in the same sentence. If the data is thin, write fewer, sharper bullets — never pad.
8. ADD NEW INFORMATION, don't restate: the user already saw the action plan above. Do not just rephrase it back to them. Every bullet must surface something the action plan did NOT already say — a second-order effect, a hidden risk, a precedent, or a driver behind the action, not a summary of the action itself.
9. NO FABRICATED NUMBERS: state a % or $ figure only if it is copied from the data or a shown arithmetic derivation from a number in the data. Otherwise use qualitative language instead of inventing a precise-sounding figure.
10. SOURCE DISCIPLINE: only name a source if that source's actual content supports the specific claim you're attaching to it. If unsure, state the claim without a source rather than guessing.
11. MATERIALITY CHECK: before treating a regional weather/alert signal as a driver of the GLOBAL/futures price, confirm that region is actually a major global producer of that commodity. If it is a minor growing region for this commodity, frame the impact as LOCAL sourcing/logistics risk, not a global price mover.

Return a JSON object: {"deepDive": "your concise, structured, and informative plain text analysis"}`;

        // 70B for reasoning quality; callGroq's failover chain (Gemini, then
        // 8B) protects against free-tier rate limits.
        const analysisRaw = await callGroq(
            'llama-3.3-70b-versatile',
            analysisPrompt,
            contextBundle,
            true,
            1000,
            0.5,
            false
        );
        
        let deepDive = '';
        try {
            console.log('AI Deep Dive Raw Output:', analysisRaw);
            const analysis = JSON.parse(analysisRaw);
            deepDive = typeof analysis.deepDive === 'string' ? analysis.deepDive.trim() : String(analysis.deepDive || '');
            if (deepDive.length < 50) throw new Error('Response too short or hallucinated number');
        } catch (parseErr) {
            console.warn('Deep Dive JSON parse failed or was too short. Retrying with plain text for Ollama...');
            const fallbackPrompt = `Write a highly detailed, structured, and informative plain text analysis of the commodity market based on the data provided. Use dashes for bullet points. Return ONLY the text, NO JSON. Do not include any intro like "Here is the analysis".`;
            deepDive = await callGeminiFlash(fallbackPrompt, contextBundle, false, 1500, 0.5);
        }

        if (!deepDive) {
            deepDive = `[DETERMINISTIC FALLBACK] Our AI engine analyzed the latest market indicators, but was unable to format the highly detailed deep-dive response due to local model constraints. However, based on the ${commodity} metrics provided, we recommend monitoring the current support/resistance levels closely as geopolitical and weather factors continue to exert pressure.`;
        }

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
            const rows = await getRecentAlertsBySource(req.session.userId, 'PROFILE_NEWS', 72, 8);
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
            const alertRows = await getActiveAlerts(req.session.userId, 8);
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
                    negativeFeedback.map(f => `- You previously suggested: "${f.ai_response}". The user REJECTED this because: "${f.user_notes}". DO NOT make similar suggestions.`).join('\n');
            }
        } catch (e) { console.error('Failed to load AI feedback history:', e.message); }

        console.log('[AI PLANNER] Proxying request to Python FastAPI Microservice...');
        const aiBaseUrl = process.env.AI_SERVICE_URL ? process.env.AI_SERVICE_URL.replace(/\/$/, '') : 'http://127.0.0.1:8000';
        
        // Pass API keys from Node env to Python (Docker env sharing can be unreliable)
        payload._groq_api_key = process.env.GROQ_API_KEY;
        payload._gemini_api_key = process.env.GEMINI_API_KEY;
        
        const pythonRes = await axios.post(`${aiBaseUrl}/api/analyze-planner`, payload, { timeout: 45000 });
        
        if (pythonRes.data.success) {
            global.aiPlannerCache[cacheKey] = { data: pythonRes.data.recommendations, timestamp: Date.now() };
            return res.json({ success: true, recommendations: pythonRes.data.recommendations });
        } else {
            throw new Error(pythonRes.data.error || 'Python microservice returned an error');
        }

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


// ── ROUTE: fallback to Gemini ───────────────────────────────────────
app.post('/api/analyze-fallback', requireAuth, async (req, res) => {
    res.status(403).json({
        success: false,
        error: 'Gemini fallback is disabled. API tokens are reserved for planner recommendations and deep dives only.'
    });
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
        
        // Fetch in small chunks, fallback to individual if a chunk fails (e.g. due to schema validation on one symbol)
        for (let i = 0; i < querySymbols.length; i += 5) {
            const chunk = querySymbols.slice(i, i + 5);
            try {
                const res = await yahooFinance.quote(chunk);
                quotes.push(...res);
            } catch (e) {
                // Fallback to individual
                for (const sym of chunk) {
                    try {
                        const r = await yahooFinance.quote(sym);
                        quotes.push(r);
                    } catch (e2) {}
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
            
            let newPrice = q.regularMarketPrice;

            // Normalize to USD: Yahoo quotes many futures in US cents
            // (currency "USX") — grains per bushel, softs/livestock per lb.
            // Driven by the quote's own currency field, not a symbol list.
            const usxCents = q.currency === 'USX';
            if (usxCents) {
                newPrice = newPrice / 100;
            }

            // Same-contract session refs for the anomaly detector — the
            // quote's own previousClose/open cannot span a contract roll,
            // unlike the continuous chart series.
            state.prevClose = q.regularMarketPreviousClose > 0 ? (usxCents ? q.regularMarketPreviousClose / 100 : q.regularMarketPreviousClose) : null;
            state.dayOpen = q.regularMarketOpen > 0 ? (usxCents ? q.regularMarketOpen / 100 : q.regularMarketOpen) : null;

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
            state.change = +(rounded - state.open).toFixed(4);
            state.changePct = state.open > 0 ? +((state.change / state.open) * 100).toFixed(3) : 0;
            state.high = Math.max(state.high, rounded);
            state.low = Math.min(state.low, rounded);

            if (!priceHistory[symbol]) priceHistory[symbol] = [];
            const lastH = priceHistory[symbol][priceHistory[symbol].length - 1];
            if (!lastH || lastH.price !== rounded || Math.random() > 0.8) {
                priceHistory[symbol].push({ time: now, price: rounded });
                if (priceHistory[symbol].length > 200) priceHistory[symbol].shift();
            }
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
        const cents = chart.meta?.currency === 'USX';
        const norm = v => (v == null ? null : (cents ? v / 100 : v));
        const todayUtc = new Date().toISOString().slice(0, 10);
        const closes = [];
        let todayOpen = null;
        for (const q of chart.quotes || []) {
            if (!q.date) continue;
            if (q.date.toISOString().slice(0, 10) === todayUtc) {
                todayOpen = norm(q.open); // today's session open feeds the contract-roll guard
            } else if (q.close != null) {
                closes.push(norm(q.close)); // completed days only
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
// 15-minute cadence: ~5 batched Yahoo requests per tick (21 symbols in
// chunks of 5) — trivial volume, and it makes user price-threshold alerts
// actually fire near the crossing instead of up to 24h late.
setInterval(tickPrices, 15 * 60 * 1000);

// Reset open/high/low every hour
setInterval(() => {
    for (const state of Object.values(livePrices)) {
        state.open = state.current;
        state.high = state.current;
        state.low = state.current;
        state.change = 0;
        state.changePct = 0;
    }
}, 3600000);

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
app.get('/api/live-prices', requireAuth, (req, res) => {
    const result = {};
    const userCommodities = req.userProfile?.commodities || [];
    for (const [symbol, state] of Object.entries(livePrices)) {
        if (userCommodities.length === 0 || userCommodities.includes(symbol)) {
            result[symbol] = { ...state, history: priceHistory[symbol] || [] };
        }
    }
    res.json({ success: true, prices: result, timestamp: Date.now() });
});


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

// Track already-alerted articles to avoid duplicates
let alertedArticles = new Set();
const ALERTED_FILE = path.join(process.cwd(), 'alerted_articles.json');
try {
    if (fs.existsSync(ALERTED_FILE)) {
        alertedArticles = new Set(JSON.parse(fs.readFileSync(ALERTED_FILE, 'utf8')));
    }
} catch (e) { console.error('Failed to load alerted articles from disk', e.message); }

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
            console.warn(`[GEO-SCANNER] Embedding verification failed, accepting deterministic match: ${article.title}`);
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
        await insertPipelineAuditLog(userId, article, stageDropped, rejectionReason, score, isAccepted);
    },
    llmFn: async (messages, expectJson) => {
      return { relevant: false, reason: 'LLM review disabled; API tokens reserved for planner recommendations and deep dives only.' };
    },
    scoreThreshold: 75,
    llmThresholdLow: 25,
    llmThresholdHigh: 85
  });
  return userScannerPipeline;
}

async function scanSingleUser(user, pipeline) {
  try {
    if (!user.id) return;
    const profile = await getUserProfile(user.id);
    if (!profile) return;

    // 1. Fetch News
    let customKeywords = profile.news_keywords && profile.news_keywords.length > 0 ? profile.news_keywords : [];
    const regionTarget = profile.focus_region ? ` ${profile.focus_region}` : '';

    // Apply region target to custom keywords
    customKeywords = customKeywords.map(k => `${k}${regionTarget}`);

    // Gather selected commodities and regions
    const targets = [...(profile.commodities || []), profile.focus_product].filter(Boolean);
    const regions = [...(profile.regions || []), profile.focus_region].filter(Boolean);

    // Keys are UPPER_SNAKE (e.g. LIVE_CATTLE) — use spaces in search queries
    const commQueries = [...new Set(targets)].map(c => `${String(c).replace(/_/g, ' ')} supply chain OR logistics`);
    const regQueries = [...new Set(regions)].map(r => `${r} supply chain OR logistics`);

    // Combine all sources into a single search pool
    const combinedPool = [...new Set([...customKeywords, ...commQueries, ...regQueries])];
    
    // Shuffle array and take top 20 to ensure fair distribution across commodities/regions
    let keywords = combinedPool.sort(() => 0.5 - Math.random()).slice(0, 20);

    if (keywords.length === 0) {
        keywords = ['supply chain', 'logistics'];
    }
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

    console.log(`[USER-SCANNER] Fetched ${allArticles.length} raw articles from RSS for user ${user.id}`);

    const triggeredAlerts = [];
    
    // 2. Process through Pipeline
    for (const rawArticle of allArticles) {
      if (triggeredAlerts.length >= MAX_USER_SCANNER_ALERTS) break;

      const result = await pipeline.processArticle(rawArticle, profile, alertedArticles);

      if (result.accepted) {
        const a = result.article;
        
        // Extract insights locally to save LLM tokens
        const extractedData = await fetchAndExtractArticle(a.url);
        let nlpDescription = a.description;
        let entities = null;
        
        if (extractedData) {
            nlpDescription = `NLP Summary: ${extractedData.summary}`;
            entities = extractedData.entities;
        }

        // Save the alert globally so we don't alert again
        const titleKey = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
        alertedArticles.add(titleKey);

        const alertReason = a.llmReason || `Score: ${a.relevanceScore}. Commodity Match: ${a.breakdown.commodityScore > 0 ? 'Yes' : 'No'}. Region Match: ${a.matchedRegions.join(', ')}`;

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

        // Persist to the unified alert store (survives restarts; deduped by DB)
        await insertAlert(user.id, {
          source: 'PROFILE_NEWS',
          category: 'Profile Match',
          severity: severityFromPriority(a.priority),
          title: '🎯 Profile Alert: ' + a.title.slice(0, 160),
          reason: alertReason,
          url: a.url,
          relevanceScore: a.relevanceScore,
          payload: { source: a.source, entities, description: nlpDescription },
          dedupKey: `profile:${titleKey}`,
        });

      }
    }

    // Save the Set to disk so both accepted and rejected duplicate keys are persisted
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
  } catch (err) {
    console.error(`[USER-SCANNER] Failure for user ${user.id}:`, err);
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
        if (user) {
            console.log(`[USER-SCANNER] Manual scan triggered for user ${userId}`);
            const pipeline = await initScannerPipeline();
            await scanSingleUser(user, pipeline);
        }
    } catch (err) {
        console.error('Trigger scan error:', err);
    }
};

global.clearUserAlertsCache = (userId) => {
    if (userId) {
        delete userSpecificAlertsCache[userId];
    } else {
        Object.keys(userSpecificAlertsCache).forEach(k => delete userSpecificAlertsCache[k]);
    }
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
app.get('/api/geo-alerts', requireAuth, (req, res) => {
  res.json({ success: true, alerts: recentGeoAlerts });
});

// ── Morning Brief: "what changed since yesterday", real data only ──
// Alerts + accepted articles from Postgres; price moves computed from the
// live Yahoo quote vs its own same-contract previous close. No proxies —
// commodities without a real prevClose are omitted rather than estimated.
app.get('/api/morning-brief', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const [newAlerts, acceptedNews] = await Promise.all([
            getAlertsSince(userId, 24, 20),
            getAcceptedArticlesSince(userId, 24, 5),
        ]);

        const alertCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
        for (const a of newAlerts) {
            if (alertCounts[a.severity] != null) alertCounts[a.severity]++;
        }

        const tracked = req.userProfile?.commodities || [];
        const priceMovers = tracked
            .map(symbol => {
                const state = livePrices[symbol];
                if (!state || !(state.current > 0) || !(state.prevClose > 0)) return null;
                const changePct = ((state.current - state.prevClose) / state.prevClose) * 100;
                return {
                    symbol,
                    label: symbol.replace(/_/g, ' '),
                    price: state.current,
                    prevClose: state.prevClose,
                    changePct: +changePct.toFixed(2),
                    unit: COMMODITY_UNITS[symbol] || 'USD',
                };
            })
            .filter(Boolean)
            .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

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
        const cents = chart.meta?.currency === 'USX';
        const bars = (chart.quotes || [])
            .filter(q => q.close != null && q.date)
            .map(q => ({ date: q.date, close: cents ? q.close / 100 : q.close }));
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
        const cents = chart.meta?.currency === 'USX';
        const bars = (chart.quotes || [])
            .filter(q => q.close != null && q.date)
            .map(q => ({ date: q.date, close: cents ? q.close / 100 : q.close }));
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
        const raw = await callGroq('llama-3.1-8b-instant', system, user, false, 16, 0, false);
        const matched = parseMatcherResponse(raw);
        llmMatchCache.set(key, matched ? matched.id : null);
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

// ── Unified persistent alerts (event × exposure store) ──
app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    const alerts = await getActiveAlerts(req.session.userId);
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
                if (!embeddings || embeddings.length !== unprocessed.length) {
                    throw new Error('Batch embedding generation failed or returned mismatched count');
                }
                
                // Anti-zero embedding failsafe
                for (let emb of embeddings) {
                    if (emb && emb.every(v => v === 0)) {
                        throw new Error('Gemini returned an invalid zero-filled embedding');
                    }
                }
            } catch (embErr) {
                console.warn('[AI-WORKER] Embedding unavailable. Leaving articles queued for the next budget window.', embErr.message);
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
app.get('/api/forecast/:category', async (req, res) => {
    try {
        const cat = req.params.category;
        const result = await pool.query(
            `SELECT * FROM forecast_outputs WHERE category = $1 ORDER BY forecast_date DESC, horizon_days ASC LIMIT 10`,
            [cat]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Forecast fetch error:', err.message);
        res.status(500).json({ error: 'Failed to fetch forecast outputs' });
    }
});

app.get('/api/recommendations/:category', async (req, res) => {
    try {
        const cat = req.params.category;
        const result = await pool.query(
            `SELECT * FROM recommendations WHERE category = $1 ORDER BY generated_at DESC LIMIT 10`,
            [cat]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Recommendations fetch error:', err.message);
        res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
});

const PORT = process.env.PORT || 3001;

// ── Serve React Frontend in Production ───────────────────────
const distPath = path.join(process.cwd(), 'dashboard', 'dist');
app.use(express.static(distPath));

// Catch-all route to serve React's index.html for client-side routing
app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`FOps Market Pulse v2 running on :${PORT}`));
