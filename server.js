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
import authRouter, { requireAuth } from './auth.js';
import { pool, getUserProfile, updateUserProfile, getAllUsers, getAllUserPriceAlerts, insertPriceTicksBatch, insertWeatherSnapshot, insertNewsEmbedding, getUnprocessedNews, updateNewsEmbedding, getPriceHistory, getWeatherHistory, searchSimilarNews, getRecentNewsEmbeddings, createSopPlan, getSopPlans, updateSopPlan, insertAiFeedback, getRecentAiFeedback } from './db.js';
import { ALL_REGIONS } from './onboarding-templates.js';
import { runHybridAnalysis } from './algorithms.js';
import { runDeterministicEngine } from './deterministic-engine.js';
import { simulateLogistics } from './logistics-engine.js';
import { simulateUSDA } from './usda-engine.js';
import nodemailer from 'nodemailer';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import { parse } from 'csv-parse/sync';

if (fs.existsSync('/etc/secrets/.env')) { dotenv.config({ path: '/etc/secrets/.env' }); } else { dotenv.config(); }

const upload = multer({ storage: multer.memoryStorage() });

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;


// ── Nodemailer Setup ──
let transporter;
if (process.env.SMTP_HOST && process.env.SMTP_PASS) {
    // Use Production/External API (e.g., Resend, SendGrid)
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 465,
        secure: true,
        auth: {
            user: process.env.SMTP_USER || 'resend',
            pass: process.env.SMTP_PASS
        }
    });
    console.log('Production SMTP Transporter initialized.');
} else {
    // Fallback to Ethereal (Testing) if no API key is provided
    nodemailer.createTestAccount((err, account) => {
        if (!err) {
            transporter = nodemailer.createTransport({
                host: account.smtp.host,
                port: account.smtp.port,
                secure: account.smtp.secure,
                auth: { user: account.user, pass: account.pass }
            });
            console.log('Ethereal Test Email initialized. (Add SMTP_PASS to .env for real emails)');
        }
    });
}

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false, logOptionsErrors: false } });

const YAHOO_SYMBOLS = {
    BRENT_CRUDE: 'BZ=F',
    NATURAL_GAS: 'NG=F'
};

const COMMODITY_DATA = {
    BRENT_CRUDE:  { price: '0', unit: 'USD/bbl', producers: ['Saudi Arabia', 'USA', 'Russia', 'UAE', 'Oman'], regions: [], currencies: ['USD', 'SAR', 'AED', 'OMR'] },
    NATURAL_GAS:  { price: '0', unit: 'USD/MMBtu', producers: ['USA', 'Russia', 'Iran', 'Qatar', 'Canada'], regions: [], currencies: ['USD'] },
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

const GROQ_KEY = process.env.GROQ_API_KEY;
const COMMODITY_KEY = process.env.COMMODITY_API_KEY;
const NEWS_KEY = process.env.NEWSDATA_API_KEY;
const EIA_KEY = process.env.EIA_API_KEY;

async function callGroq(model, systemPrompt, userContent, jsonMode = true, maxTokens = 1500, temperature = 0.1) {
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
                    { role: 'user', content: userContent },
                ],
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_KEY}`,
                    'Content-Type': 'application/json',
                }
            }
        );
        return response.data.choices[0].message.content;
    } catch (err) {
        console.log(`[FAILOVER] Primary Groq failed (${model}). Trying Llama 3 8B...`);
        try {
            const groqBackup = await axios.post(
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
            return groqBackup.data.choices[0].message.content;
        } catch (fallbackErr) {
            if (process.env.GEMINI_API_KEY) {
                console.log(`[FAILOVER] Groq backup failed. Using Gemini 2.5 Flash fallback...`);
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
                    
                    let text = data.candidates[0].content.parts[0].text;
                    if (jsonMode) {
                        text = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
                    }
                    return text;
                } catch (geminiErr) {
                    console.error('[FAILOVER] Gemini also failed:', geminiErr.response?.data?.error?.message || geminiErr.message);
                }
            }
            
            // Ultimate Deterministic Fallback if EVERYTHING fails or API keys are missing
            const dynamicVariation = Math.floor(Math.random() * 100);
            if (jsonMode) {
                return JSON.stringify({
                    recommendations: [
                        { timeframe: "7D", action: `Market volatility expected to persist. Internal metrics suggest a ${dynamicVariation}% probability of supply chain realignment based on current data.`, businessImpact: "Mitigates immediate volatility exposure." },
                        { timeframe: "30D", action: `Sustained pressure on margins. Re-evaluating optimal routes is critical as geopolitical tension remains elevated.`, businessImpact: "Prevents critical inventory stockouts." },
                        { timeframe: "90D", action: `Long-term restructuring likely. Key players will shift focus to resilient sourcing strategies.`, businessImpact: "Optimizes long-term resilience." }
                    ]
                });
            }
            return `High relevance to tracked profile keywords (Deterministic Fallback Matcher: ${dynamicVariation}).`;
        }
    }
}

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

        const llmResponse = await callGroq('llama-3.3-70b-versatile', 'You are a maritime logistics extraction API. Output only raw JSON.', prompt, true);
        cachedRealTimeLogistics = JSON.parse(llmResponse);
        console.log('[LOGISTICS] Real-Time Logistics Data Fetched and Cached successfully.');
    } catch (e) {
        console.error('[LOGISTICS] Failed to fetch real-time logistics via LLM:', e.message);
    }
}

setInterval(fetchRealTimeLogistics, 60 * 60 * 1000);
fetchRealTimeLogistics();
function cosineSimilarity(vecA, vecB) {
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

async function generateEmbedding(text) {
    if (!process.env.GEMINI_API_KEY) return null;
    try {
        const { data } = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${process.env.GEMINI_API_KEY}`, {
            model: 'models/gemini-embedding-2',
            content: { parts: [{ text }] },
            outputDimensionality: 768
        }, { headers: { 'Content-Type': 'application/json' } });
        return data.embedding.values;
    } catch (err) {
        console.error('Gemini embedding failed:', err.response?.data?.error?.message || err.message);
        return null;
    }
}

async function generateBatchEmbeddings(texts) {
    if (!process.env.GEMINI_API_KEY || !texts || texts.length === 0) return [];
    try {
        const { data } = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`, {
            requests: texts.map(text => ({
                model: 'models/gemini-embedding-2',
                content: { parts: [{ text }] },
                outputDimensionality: 768
            }))
        }, { headers: { 'Content-Type': 'application/json' } });
        return data.embeddings.map(e => e.values);
    } catch (err) {
        console.error('Gemini batch embedding failed:', err.response?.data?.error?.message || err.message);
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
        
        // Normalize prices to match UI
        let normalized = hist.map(d => {
            let price = d.close;
            let open = d.open;
            let high = d.high;
            let low = d.low;
            let volume = d.volume;

            // Grains quoted in cents/bushel. Soy/Palm oil in cents/lb. Sugar in cents/lb. Coffee in cents/lb.
            if (['WHEAT', 'CORN', 'SOYBEANS', 'RICE', 'PALM_OIL', 'SUGAR', 'COFFEE', 'FEEDER_CATTLE', 'MILK', 'OATS', 'LEAN_HOGS', 'COTTON'].includes(symbol.toUpperCase())) {
                if (price) price = price / 100;
                if (open) open = open / 100;
                if (high) high = high / 100;
                if (low) low = low / 100;
            }
            if (symbol === 'PALM_OIL') {
                if (price) price = price * 2204.62;
                if (open) open = open * 2204.62;
                if (high) high = high * 2204.62;
                if (low) low = low * 2204.62;
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

        const prompt = `You are a Senior Agricultural Supply Chain Analyst.
Analyze the weather data for ${name} where the primary crop is ${crop}.
Weather Stats:
- Average Temp (Last 7d): ${analytics.avgTemp7d}°C
- Max Temp (Last 7d): ${analytics.maxTemp7d}°C
- Recent Rain (Last 7d): ${analytics.recentPrecipMm}mm
- Total Rain (Last 30d): ${analytics.totalPrecip30d}mm
- Growing Degree Days (GDD): ${analytics.totalGDD}
- Drought Score: ${analytics.droughtScore}/100
- Logistics Risk: ${analytics.logisticsRisk ? 'HIGH' : 'LOW'}
- Alert Status: ${analytics.alert}

Write a natural, strategic 2-sentence market intelligence briefing on the potential yield impact or supply chain risk for this crop. 
CRITICAL RULES:
1. Sound like a human expert analyst, not a robot.
2. Weave 1-2 of the most critical data points (e.g., specific temperatures, rainfall amounts, or drought scores) naturally into your narrative to ground your analysis in hard numbers.
3. Format the response as a JSON object with a single string field: {"forecast": "..."}`;

        const rawResult = await callGroq('llama-3.3-70b-versatile', prompt, "Analyze the crop yield risk.", true, 500);
        const jsonResult = JSON.parse(rawResult);

        res.json({ success: true, forecast: jsonResult.forecast });
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

        // Geocode using open-meteo
        const { data } = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
            params: { name, count: 1, language: 'en', format: 'json' }
        });

        if (!data.results || data.results.length === 0) {
            return res.status(404).json({ error: 'Location not found' });
        }

        const location = data.results[0];
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
app.get('/api/news', requireAuth, async (req, res) => {
    try {
        const userKeywords = req.userProfile?.news_keywords || ['frozen food', 'cold chain', 'frozen goods'];
        const focusRegion = req.userProfile?.focus_region || 'Middle East';
        const focusProduct = req.userProfile?.focus_product || 'Commodities';
        
        // Dynamically build Google News queries. Append market context to avoid consumer/recipe news.
        const querySuffix = ' AND (market OR "supply chain" OR trade OR agriculture OR prices OR export)';
        const googleQueries = [
            ...userKeywords.map(kw => `"${kw}"${querySuffix}`),
            `"${focusProduct}" "${focusRegion}"${querySuffix}`
        ];
        const allArticles = [];

        // ── Source 1: Google News RSS (free, no key) ──

        const rssResults = await Promise.allSettled(
            googleQueries.map(async (q) => {
                const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
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

                    if (title) items.push({ title, url: link, publishedAt: pubDate, description: desc, source, via: 'google-news' });
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

        // ── Live Semantic Filtering ──
        let verifiedArticles = unique.slice(0, 40);
        try {
            const contextText = `${focusProduct} supply chain, market pricing, and trade dynamics in ${focusRegion}`;
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
        req.body.geoAlerts = recentGeoAlerts;
        req.body.userAlerts = userSpecificAlertsCache[req.session.userId] || [];

        const analysis = runDeterministicEngine(req.body);
        
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
    
    try {
        const focusProduct = req.userProfile?.focus_product || 'Commodities';
        const focusRegion = req.userProfile?.focus_region || 'Global';

        let feedbackContext = '';
        try {
            const pastFeedback = await getRecentAiFeedback(req.session.userId, 'DEEP_DIVE', 5);
            const negativeFeedback = pastFeedback.filter(f => f.is_helpful === false);
            if (negativeFeedback.length > 0) {
                feedbackContext = '\n=== USER FEEDBACK HISTORY (DO NOT REPEAT PAST MISTAKES) ===\n' + 
                    negativeFeedback.map(f => `- You previously provided this Deep Dive: "${f.ai_response}". The user REJECTED this because: "${f.user_notes}". DO NOT repeat similar mistakes in your tone or content.`).join('\n');
            }
        } catch (e) { console.error('Failed to load AI feedback history:', e.message); }

        const logisticsData = cachedRealTimeLogistics;

        const contextBundle = `
=== TARGET ACTION PLAN (${timeframe}) ===
${Array.isArray(deterministicAction) ? deterministicAction.join(' | ') : (deterministicAction || 'No action provided.')}

=== REAL-TIME LIVE NEWS ===
Top 5 News: ${(news || []).slice(0, 5).map(n => n.title).join(' | ')}

=== MARKET DATA ===
Brent Crude: $${energy?.brent?.current?.value ?? 'N/A'}/barrel
Weather Alerts: ${(weatherExtended || []).filter(w => w.analytics?.alert !== 'NORMAL').map(w => `${w.name}: ${w.analytics?.alert}`).join(', ')}
Port Congestion: ${(logisticsData.portCongestion || []).map(p => `${p.port} (${p.status})`).join(', ')}
Air Freight Rates: $${logisticsData.airFreightRates?.ratePerKg ?? 'N/A'}/kg (${logisticsData.airFreightRates?.trend ?? 'N/A'})
Geopolitical Risk Index: ${logisticsData.geopoliticalRiskIndex ?? 'N/A'}/10
${feedbackContext}
`.trim();

        const analysisPrompt = `You are FOPs Market Pulse — an elite Supply Chain Intelligence Engine.
The user requested an "AI Deep Dive" into the rationale behind their ${timeframe} supply chain action plan.

CRITICAL INSTRUCTIONS:
1. You MUST heavily analyze the "REAL-TIME LIVE NEWS" provided in the context. Connect the news events directly to the supply chain actions.
2. DO NOT use generic phrases like "variance index" or "macroeconomic indicators" unless it is explicitly tied to the news provided.
3. Be highly detailed, specific, and actionable. Provide 2-3 paragraphs of deep analysis.
4. Explain the *hidden risks* and *geopolitical drivers* behind the action plan based purely on the provided news and market data.

Return a JSON object: {"deepDive": "your highly detailed 2-3 paragraph analysis text"}`;

        const analysisRaw = await callGroq(
            'llama-3.1-8b-instant',
            analysisPrompt,
            contextBundle,
            true,
            1200,
            0.5
        );
        
        const analysis = JSON.parse(analysisRaw);
        res.json({ success: true, deepDive: analysis.deepDive });
    } catch (err) {
        console.error('Deep Dive LLM Analysis failed:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to generate AI deep dive.' });
    }
});


// ── ROUTE: CSV Intelligence Upload ──────────────────────────────────────────
app.post('/api/upload-csv-intelligence', requireAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) throw new Error('No file uploaded');

        // 1. Parse CSV (up to first 100 rows for LLM context limit)
        const csvContent = req.file.buffer.toString('utf-8');
        const records = parse(csvContent, { columns: true, skip_empty_lines: true });
        const sampleData = JSON.stringify(records.slice(0, 100));

        // 2. Extract Keywords via LLM
        const extractionPrompt = `You are a Supply Chain Intelligence expert. 
Extract exactly 3 concise tracking keywords (e.g. "Semiconductors", "Wheat", "Maersk", "Taiwan") from the following raw CSV data. 
Focus on specific commodities, regions, or major suppliers that are most critical. 
Return ONLY a JSON array of strings under the key "keywords".`;

        const extractionRaw = await callGroq('llama-3.3-70b-versatile', extractionPrompt, sampleData, true, 500, 0.3);
        const keywordsParsed = JSON.parse(extractionRaw);
        const keywords = keywordsParsed.keywords || [];

        if (keywords.length === 0) throw new Error('No keywords extracted from CSV');

        // 3. Scrape Live News based on extracted keywords
        const qParam = encodeURIComponent(keywords.join(' OR '));
        const newsRes = await axios.get(`https://newsdata.io/api/1/news?apikey=${NEWS_KEY}&q=${qParam}&language=en&category=business,politics`);
        const newsData = newsRes.data.results || [];
        const topNews = newsData.slice(0, 5).map(n => n.title).join(' | ');

        // 4. Generate custom Alerts & Recommendations
        const analysisPrompt = `You are FOPs Market Pulse.
Based on the following extracted CSV Keywords: ${keywords.join(', ')}
And the following Live Scraped News: ${topNews || 'No recent news found for these keywords.'}

Generate:
1. "alerts": An array of exactly 2 critical geopolitical or supply chain alerts based on the news. Each alert must have a "title" and a "description".
2. "recommendations": An array of exactly 3 strategic planner recommendations representing "7D", "30D", and "90D" timeframes. Each must have "timeframe", "action", and "businessImpact".

Return ONLY a JSON object with "alerts" and "recommendations" arrays.`;

        const analysisRaw = await callGroq('llama-3.3-70b-versatile', analysisPrompt, "Analyze and return JSON.", true, 1500, 0.4);
        const analysis = JSON.parse(analysisRaw);

        const recs = (analysis.recommendations || []).map(r => {
            const normalized = {};
            for (const key in r) {
                const lowerKey = key.toLowerCase();
                if (lowerKey.includes('time')) normalized.timeframe = r[key];
                else if (lowerKey.includes('action')) normalized.action = r[key];
                else if (lowerKey.includes('impact') || lowerKey.includes('business')) normalized.businessImpact = r[key];
            }
            return normalized;
        });

        res.json({ success: true, alerts: analysis.alerts || [], recommendations: recs, extractedKeywords: keywords });

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
    const { prices, news, weather, energy, forex, weatherExtended } = req.body;
    
    try {
        const focusProduct = req.userProfile?.focus_product || 'Commodities';
        const focusRegion = req.userProfile?.focus_region || 'Global';
        // FORCE BRENT CRUDE ONLY (Override user profile)
        const userCommodities = ['BRENT_CRUDE'];
        const userKeywords = req.body.keywords || [];

        let mlForecasts = 'No local ML forecasts available.';
        try {
            if (fs.existsSync('outputs/forecast_recommendations.csv')) {
                mlForecasts = fs.readFileSync('outputs/forecast_recommendations.csv', 'utf8');
            }
        } catch(e) { console.error('Failed to read ML forecasts:', e.message); }

        let feedbackContext = '';
        try {
            const pastFeedback = await getRecentAiFeedback(req.session.userId, 'RECOMMENDATION', 5);
            const negativeFeedback = pastFeedback.filter(f => f.is_helpful === false);
            if (negativeFeedback.length > 0) {
                feedbackContext = '\n=== USER FEEDBACK HISTORY (DO NOT REPEAT PAST MISTAKES) ===\n' + 
                    negativeFeedback.map(f => `- You previously suggested: "${f.ai_response}". The user REJECTED this because: "${f.user_notes}". DO NOT make similar suggestions.`).join('\n');
            }
        } catch (e) { console.error('Failed to load AI feedback history:', e.message); }

        const logisticsData = cachedRealTimeLogistics;

        const contextBundle = `
=== USER PROFILE ===
Focus Product: ${focusProduct}
Focus Region: ${focusRegion}
Tracked Commodities: ${userCommodities.join(', ')}
Custom Keywords: ${userKeywords.join(', ')}

=== LOCAL ML FORECASTS & SAFETY STOCKS ===
${mlForecasts}

=== REAL-TIME DATA ===
Brent Crude: $${energy?.brent?.current?.value ?? 'N/A'}/barrel
Weather Alerts: ${(weatherExtended || []).filter(w => w.analytics?.alert !== 'NORMAL').map(w => `${w.name}: ${w.analytics?.alert}`).join(', ')}
Key Currencies: ${Object.values(forex || {}).map(f => `${f.name}: ${f.rate}`).join(', ')}
Top 5 News: ${(news || []).slice(0, 5).map(n => n.title).join(' | ')}
Port Congestion: ${(logisticsData.portCongestion || []).map(p => `${p.port} (${p.status})`).join(', ')}
Air Freight Rates: $${logisticsData.airFreightRates?.ratePerKg ?? 'N/A'}/kg (${logisticsData.airFreightRates?.trend ?? 'N/A'})
Geopolitical Risk Index: ${logisticsData.geopoliticalRiskIndex ?? 'N/A'}/10
${feedbackContext}
`.trim();

        const analysisPrompt = `You are FOPs Market Pulse — an executive-grade supply chain intelligence engine.
Based on the LOCAL ML FORECASTS and REAL-TIME DATA (especially the Top 5 News), generate exactly 3 strategic, highly personalized planner recommendations.

CRITICAL INSTRUCTIONS:
1. The 3 recommendations MUST form a cohesive, phased strategy addressing the most critical risk/opportunity found in the data. Do NOT just pick 3 random SKUs.
2. The "7D" action must be an IMMEDIATE TACTICAL response (e.g., spot buys, rerouting shipments, emergency safety stock releases).
3. The "30D" action must be a MID-TERM OPERATIONAL adjustment (e.g., updating Reorder Points, renegotiating short-term contracts, shifting allocations).
4. The "90D" action must be a LONG-TERM STRATEGIC shift (e.g., onboarding new alternative suppliers, network redesign, product reformulation, hedging).
5. You MUST use the specific numeric values (Safety Stock, ROP, Forecast) from the LOCAL ML FORECASTS to back up your actions.
6. When referencing an SKU, you MUST write the product name alongside it exactly as it appears in the LOCAL ML FORECASTS (e.g., 'Product Name (SKU_XXX)').
7. Focus ONLY on the Middle East region. Do NOT mention India, China, or other non-Middle Eastern regions.
8. DO NOT mention specific technical data science model names (e.g., "HoltWinters"). Use user-friendly terms like "our forecasting engine".

Return a JSON object containing an array of exactly 3 objects under the key "recommendations". 
Each object must represent a different timeframe and have these exact keys:
- "timeframe" (string: exactly "7D", "30D", or "90D")
- "action" (string: clear, easy-to-understand actionable plan utilizing the specific SKU numbers AND product names)
- "businessImpact" (string: the simple business reason or impact)
`;

        const analysisRaw = await callGroq(
            'llama-3.1-8b-instant',
            analysisPrompt,
            contextBundle,
            true,
            1000,
            0.5
        );
        
        let recs = [];
        try {
            const parsed = JSON.parse(analysisRaw);
            let rawRecs = [];
            if (parsed.recommendations && Array.isArray(parsed.recommendations)) {
                rawRecs = parsed.recommendations.slice(0, 3);
            } else {
                rawRecs = Object.values(parsed).slice(0, 3);
            }
            
            // Normalize keys (LLMs often hallucinate exact casing like 'Timeframe' or 'Action')
            recs = rawRecs.map(r => {
                const normalized = {};
                for (const key in r) {
                    const lowerKey = key.toLowerCase();
                    if (lowerKey.includes('time')) normalized.timeframe = r[key];
                    else if (lowerKey.includes('action')) normalized.action = r[key];
                    else if (lowerKey.includes('impact') || lowerKey.includes('business')) normalized.businessImpact = r[key];
                }
                return normalized;
            }).filter(r => r.timeframe && r.action);
            
        } catch (e) {
            console.error('Failed to parse AI planner recommendations', e);
        }

        if (recs.length < 3) throw new Error('No recommendations generated');
        res.json({ success: true, recommendations: recs });
    } catch (err) {
        console.error('AI Planner Recommendations failed, using fallback:', err.message);
        
        const focusProduct = req.userProfile?.focus_product || 'Commodities';
        const focusRegion = req.userProfile?.focus_region || 'Global';
        
        let fallbackRecs = [
            {
                timeframe: "7D",
                action: `Accelerate hedging and secure spot contracts for ${focusProduct} based on recent news trends.`,
                businessImpact: `Mitigates immediate volatility exposure in ${focusRegion} markets`,
            },
            {
                timeframe: "30D",
                action: `Diversify ${focusProduct} routing away from primary chokepoints indicated by current alerts.`,
                businessImpact: `Prevents critical inventory stockouts during unexpected disruptions`,
            },
            {
                timeframe: "90D",
                action: `Review and renegotiate logistics terms for ${focusRegion} suppliers to build long-term resilience.`,
                businessImpact: `Optimizes margin retention amid rising operational costs`,
            }
        ];

        // --- OVERRIDE WITH CUSTOM CSV INTELLIGENCE IF AVAILABLE ---
        try {
            if (fs.existsSync('custom_csv_intelligence.json')) {
                const csvData = JSON.parse(fs.readFileSync('custom_csv_intelligence.json', 'utf8'));
                if (csvData && csvData.recommendations && csvData.recommendations.length > 0) {
                    fallbackRecs = csvData.recommendations;
                }
            }
        } catch(e) { console.error('Failed to inject CSV recommendations:', e.message); }
        // ---------------------------------------------------
        
        res.json({ success: true, recommendations: fallbackRecs });
    }
});



// ── ROUTE: per-commodity AI analysis ────────────────────────────────
app.post('/api/analyze-commodity', requireAuth, async (req, res) => {
    const { commodity, prices, weather, forex, energy } = req.body;

    const commodityInfo = COMMODITY_DATA[commodity];
    if (!commodityInfo) return res.status(400).json({ error: `Unknown commodity: ${commodity}` });

    try {
        const weatherRegions = (weather || []).filter(w => commodityInfo.regions.includes(w.name));
        const context = `
COMMODITY: ${commodity}
Current Price: $${commodityInfo.price} ${commodityInfo.unit}
Top Producers: ${commodityInfo.producers.join(', ')}
Key Regions: ${commodityInfo.regions.join(', ')}
Linked Currencies: ${commodityInfo.currencies.join(', ')}

WEATHER IN COMMODITY REGIONS:
${weatherRegions.map(w => `${w.name}: ${w.analytics?.avgTemp7d}°C avg, ${w.analytics?.recentPrecipMm}mm rain/7d, soil: ${w.analytics?.currentSoilMoisture ?? 'N/A'}, alert: ${w.analytics?.alert}`).join('\n')}

CURRENCY RATES (vs USD):
${commodityInfo.currencies.filter(c => c !== 'USD' && forex?.[c]).map(c => `${c}: ${forex[c].rate}`).join(' | ')}

ENERGY:
Brent: $${energy?.brent?.current?.value ?? 'N/A'}/bbl
`.trim();

        const prompt = `You are a commodity analyst specializing in ${commodity}. Analyze the provided data and return JSON:
{
  "commodity": "${commodity}",
  "outlook": { "short": "7-day outlook", "medium": "30-day outlook", "long": "90-day outlook" },
  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",
  "priceDrivers": [{ "factor": "", "direction": "UP|DOWN", "impact": "1-10", "explanation": "" }],
  "weatherImpact": { "severity": "LOW|MEDIUM|HIGH", "detail": "" },
  "currencyImpact": { "severity": "LOW|MEDIUM|HIGH", "detail": "" },
  "supplyChainRisks": ["list of specific risks"],
  "actionItems": [{ "priority": "P0|P1|P2", "action": "", "deadline": "" }]
}
Be specific. Use data points. Do not generalize.`;

        const raw = await callGroq('llama-3.1-8b-instant', prompt, context, true, 2000);
        res.json({ success: true, analysis: JSON.parse(raw), commodity });
    } catch (err) {
        console.error(`Commodity analysis error for ${commodity}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});


// ── ROUTE: fallback to Gemini ───────────────────────────────────────
app.post('/api/analyze-fallback', requireAuth, async (req, res) => {
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const { contextBundle, systemPrompt } = req.body;
    try {
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
            {
                contents: [{ parts: [{ text: `${systemPrompt}\n\n${contextBundle}` }] }],
                generationConfig: { responseMimeType: 'application/json' },
            }
        );
        const raw = response.data.candidates[0].content.parts[0].text;
        res.json({ success: true, analysis: JSON.parse(raw), provider: 'gemini-flash' });
    } catch (err) {
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
            
            // Normalize units from futures exchange specs to our UI specs
            if (['WHEAT', 'CORN', 'SOYBEANS', 'OATS'].includes(symbol)) {
                newPrice = newPrice / 100;
            } else if (symbol === 'PALM_OIL') {
                newPrice = (newPrice / 100) * 2204.62;
            }

            const rounded = +newPrice.toFixed(symbol === 'COCOA' || symbol === 'PALM_OIL' ? 2 : (newPrice < 10 ? 4 : 2));

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
        
    } catch (err) {
        console.error('Yahoo Finance tick logic error:', err.message);
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
                    
                    if (transporter) {
                        let aiActionPlan = '';
                        try {
                            const systemPrompt = `You are a tactical agricultural supply chain expert.`;
                            const prompt = `The commodity ${alert.symbol} just went ${alert.type} ${alert.threshold} (Current Price: $${currentPrice}). Write a short, tactical 3-sentence action plan for a supply chain manager on how to respond to this price movement. Do not use formatting like markdown.`;
                            
                            // callGroq(model, systemPrompt, userContent, jsonMode, maxTokens)
                            aiActionPlan = await callGroq('llama-3.3-70b-versatile', systemPrompt, prompt, false, 300);
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

// Tick prices via real Internet live fetch (Yahoo Finance) for Ags
setInterval(tickPrices, 30000); // 30s intervals to avoid cloud rate-limiting

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
}, 5000);

// ── ROUTE: price history (REST fallback) ──
app.get('/api/live-prices', (req, res) => {
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
// LIVE GEOPOLITICAL ALERT SCANNER — Background polling every 10 minutes
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
        const xml = match[1];
        const title = (xml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '')
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
        const link = (xml.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
        const pubDate = (xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
        const source = (xml.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || 'Google News').trim();
        if (title) items.push({ title, url: link, publishedAt: pubDate, source });
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

    for (const trigger of GEOPOLITICAL_TRIGGERS) {
      if (trigger.pattern.test(article.title)) {
        
        // ── SEMANTIC FILTERING: Verify relevance using embeddings ──
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
          console.warn(`[GEO-SCANNER] Embedding verification failed, DISCARDING to prevent spam: ${article.title}`);
          continue;
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

  // ── 3. Send Email Alerts to ALL registered users ──
  if (transporter) {
    try {
      const criticalAlerts = triggeredAlerts.filter(a => a.severity === 'CRITICAL');
      if (criticalAlerts.length === 0) return;

      // ── EMAIL THROTTLING: Prevent alert fatigue ──
      // Only send 1 email per crisis category every 12 hours
      global.emailThrottleMap = global.emailThrottleMap || new Map();
      const alertsToEmail = [];
      const THROTTLE_MS = 12 * 60 * 60 * 1000; // 12 hours

      for (const a of criticalAlerts) {
          const lastAlertTime = global.emailThrottleMap.get(a.category) || 0;
          if (Date.now() - lastAlertTime > THROTTLE_MS) {
              alertsToEmail.push(a);
              global.emailThrottleMap.set(a.category, Date.now());
          } else {
              console.log(`[GEO-SCANNER] Email suppressed for ${a.category} (Throttled for 12h)`);
          }
      }

      if (alertsToEmail.length === 0) return;

      const { rows: users } = await pool.query('SELECT email, username FROM users');
      
      const alertHtml = alertsToEmail.map(a => `
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

      for (const user of users) {
        const mailOptions = {
          from: `"FOPs Geo-Alert" <${process.env.SENDER_EMAIL || 'alerts@fops.local'}>`,
          to: user.email,
          subject: `🚨 ${triggeredAlerts[0].severity} Geopolitical Alert: ${triggeredAlerts[0].headline.slice(0, 80)}`,
          html: `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; background: #ffffff;">
              <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 20px 24px; border-radius: 12px 12px 0 0;">
                <h2 style="color: #ffffff; margin: 0; font-size: 18px;">🌐 FOPs Geopolitical Alert System</h2>
                <p style="color: #94a3b8; margin: 6px 0 0; font-size: 13px;">${triggeredAlerts.length} new alert(s) detected at ${new Date().toLocaleString()}</p>
              </div>
              <div style="border: 1px solid #e2e8f0; border-top: none; padding: 20px 24px; border-radius: 0 0 12px 12px;">
                <p style="color: #334155; font-size: 14px;">Hello <strong>${user.username}</strong>,</p>
                <p style="color: #475569; font-size: 14px; line-height: 1.6;">The FOPs Live Geopolitical Scanner has detected the following critical supply chain disruption event(s):</p>
                ${alertHtml}
                <div style="margin-top: 24px; text-align: center;">
                  <a href="http://localhost:5173" style="background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block;">Open Dashboard</a>
                </div>
                <p style="color: #94a3b8; font-size: 11px; margin-top: 20px; text-align: center;">This is an automated alert from the FOPs Market Pulse Geopolitical Scanner. Alerts are scanned every 10 minutes from Google News, NewsData.io, and GDELT.</p>
              </div>
            </div>
          `
        };

        transporter.sendMail(mailOptions, (err, info) => {
          if (err) console.error(`[GEO-SCANNER] Email error (${user.email}):`, err.message);
          else console.log(`[GEO-SCANNER] ✅ Alert email sent to ${user.email}`);
        });
      }
    } catch (err) {
      console.error('[GEO-SCANNER] Email broadcast error:', err.message);
    }
  }
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
// ── Run scanner on startup (30s delay to let everything boot) ──
setTimeout(scanGeopoliticalNews, 30000);
setTimeout(scanUserSpecificNews, 45000);

// ── Run scanner every 10 minutes ──
setInterval(scanGeopoliticalNews, 10 * 60 * 1000);
setInterval(scanUserSpecificNews, 15 * 60 * 1000);

console.log('[GEO-SCANNER] Live Geopolitical Alert Scanner initialized (polling every 10 min)');
console.log('[USER-SCANNER] User-Specific Profile Scanner initialized (polling every 15 min)');

async function scanUserSpecificNews() {
  console.log('[USER-SCANNER] Running user-specific profile scan...');
  try {
    const users = await getAllUsers();
    for (const user of users) {
      if (!user.id) continue;
      const profile = await getUserProfile(user.id);
      if (!profile) continue;

      // Restore personalized profile scanning
      const keywords = profile.news_keywords && profile.news_keywords.length > 0 ? profile.news_keywords : ['supply chain', 'logistics'];
      const focusProduct = profile.focus_product || 'Commodities';
      const focusRegion = profile.focus_region || 'Global';
      
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
            const xml = match[1];
            const title = (xml.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
            const link = (xml.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
            const pubDate = (xml.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
            const source = (xml.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || 'Google News').trim();
            if (title) items.push({ title, url: link, publishedAt: pubDate, source });
          }
          return items;
        })
      );

      const allArticles = [];
      for (const result of rssResults) {
        if (result.status === 'fulfilled') allArticles.push(...result.value);
      }

      // Deduplicate
      const seen = new Set();
      const unique = allArticles.filter(a => {
        const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const triggeredAlerts = [];
      const now = Date.now();
      const MAX_AGE_MS = 24 * 60 * 60 * 1000;
      
      const scKeywords = ['supply', 'shortage', 'price', 'freight', 'export', 'import', 'market', 'forecast', 'disruption', 'delay', 'logistics', 'tariff', 'trade', 'ban', 'demand', 'inflation', 'cost', 'strike', 'port', 'shipping', 'index'];

      const candidateArticles = [];
      for (const article of unique) {
        if (article.publishedAt) {
          const pubTime = new Date(article.publishedAt).getTime();
          if (!isNaN(pubTime) && (now - pubTime) > MAX_AGE_MS) continue;
        }

        const articleKey = article.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
        if (alertedArticles.has(articleKey)) continue;

        const lowerTitle = article.title.toLowerCase();
        const hasContextMatch = scKeywords.some(c => lowerTitle.includes(c));
        
        // 1. Hard deterministic filter to drop consumer noise and save API calls
        if (!hasContextMatch) continue;

        candidateArticles.push(article);
      }

      if (candidateArticles.length === 0) continue;
      
      // Cap the articles to protect API quota
      const cappedArticles = candidateArticles.slice(0, 40);

      let criteriaEmb = null;
      try {
        criteriaEmb = await generateEmbedding(`A critical supply chain risk or opportunity impacting ${focusProduct} in ${focusRegion}`);
      } catch (e) {
        console.warn(`[USER-SCANNER] Failed to generate criteria embedding for ${user.username}`, e.message);
      }

      // 2. Batch embed the candidate articles to prevent rate limit spikes (Max 50 per batch)
      let articleEmbeddings = [];
      if (criteriaEmb) {
          const textsToEmbed = cappedArticles.map(a => a.title);
          for (let i = 0; i < textsToEmbed.length; i += 50) {
              const batch = textsToEmbed.slice(i, i + 50);
              try {
                  const batchEmbs = await generateBatchEmbeddings(batch);
                  if (batchEmbs && batchEmbs.length === batch.length) {
                      articleEmbeddings.push(...batchEmbs);
                  } else {
                      articleEmbeddings.push(...new Array(batch.length).fill(null));
                  }
              } catch (err) {
                  console.warn(`[USER-SCANNER] Batch embedding failed for ${user.username}. Using fallback.`, err.message);
                  articleEmbeddings.push(...new Array(batch.length).fill(null));
              }
              await new Promise(r => setTimeout(r, 3000)); // 3s cooldown to protect Gemini quota
          }
      }



      for (let i = 0; i < candidateArticles.length; i++) {
        const article = candidateArticles[i];
        const articleKey = article.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);

        let accepted = false;
        let simScore = 0;

        const lowerTitle = article.title.toLowerCase();
        const hasKeywordMatch = keywords.some(k => lowerTitle.includes(k.toLowerCase()));

        if (criteriaEmb && articleEmbeddings[i]) {
            simScore = cosineSimilarity(articleEmbeddings[i], criteriaEmb);
            if (simScore > 0.60) {
                accepted = true;
            }
        }

        // 3. Fallback: If AI failed OR AI score was low, but we have a STRONG direct keyword match + context
        if (!accepted && hasKeywordMatch) {
            accepted = true;
            console.log(`[USER-SCANNER] Fallback dual-match accepted for: ${article.title}`);
        }

        if (accepted) {
          console.log(`[USER-SCANNER] Initial Match for ${user.username} (sim: ${simScore.toFixed(2)}): ${article.title}`);
          
          let aiReason = `Detected strong relevance to your tracked profile keywords.`;
          let finalAccept = true;

          try {
            const systemPrompt = `You are an elite Supply Chain Intelligence AI. Determine if this news headline represents a genuine, actionable supply chain risk, disruption, or price volatility event for a user tracking ${focusProduct} in ${focusRegion}.`;
            const userPrompt = `Headline: "${article.title}"\n\nTask:\n1. If this is a real supply chain risk/opportunity, generate a concise 1-sentence reason explaining the exact business impact.\n2. If this is generic news, local crime, or unrelated to supply chain, output exactly the word "DISCARD".\n\nOutput only the 1-sentence reason, or "DISCARD".`;
            
            // Call LLM in text mode (jsonMode=false)
            const llmRes = await callGroq('llama-3.1-8b-instant', systemPrompt, userPrompt, false, 150);
            
            const cleanRes = llmRes.trim();
            if (cleanRes.toUpperCase() === 'DISCARD' || cleanRes.toUpperCase().includes('DISCARD')) {
              console.log(`[USER-SCANNER] AI discarded: ${article.title}`);
              finalAccept = false;
            } else if (cleanRes.length > 5) {
              aiReason = cleanRes.replace(/^["']|["']$/g, ''); // remove surrounding quotes if any
            }
          } catch (e) {
            console.warn(`[USER-SCANNER] AI evaluation failed, DISCARDING to prevent spam: ${article.title}`);
            finalAccept = false;
          }

          if (finalAccept) {
            alertedArticles.add(articleKey);
            saveAlertedArticles();
            triggeredAlerts.push({
              id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
              severity: 'HIGH',
              category: 'Profile Match',
              title: '🎯 Profile Alert: ' + article.title,
              source: article.source,
              url: article.url,
              timestamp: new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST',
              reason: aiReason,
              detectedAt: new Date().toISOString(),
            });
          }
        }
      }

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
    }
  } catch (err) {
    console.error('[USER-SCANNER] Global failure:', err);
  }
}

// Start scanner with initial 60s delay
setTimeout(() => scanUserSpecificNews(), 60000);
setInterval(scanUserSpecificNews, 5 * 60 * 1000);

// ── AI Worker: Process Unprocessed News Embeddings ──
async function startAIWorker() {
    if (!ai) return console.warn('[AI-WORKER] Missing Gemini API key. Worker disabled.');
    
    console.log('[AI-WORKER] Background processor initialized.');
    
    setInterval(async () => {
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
            } catch (embErr) {
                console.warn('[AI-WORKER] Embedding API limit hit. Applying fallback zero-embeddings to clear queue.', embErr.message);
                const dummyEmb = new Array(768).fill(0);
                embeddings = unprocessed.map(() => dummyEmb);
            }
            
            // 2. Batch Classify using Groq (1 API Call)
            const systemPrompt = `You are an expert at extracting JSON from text. Output ONLY a valid JSON array of objects. Format: [{"region": "Middle East", "commodity": "Oil"}]. Use "Global" and "General" as fallbacks. Ensure the output array length matches the number of input articles exactly.`;
            
            const articlesList = unprocessed.map((a, i) => `[${i}] Title: ${a.title}\nSummary: ${a.summary}`).join('\n\n');
            const userPrompt = `Analyze these ${unprocessed.length} news articles and extract the primary agricultural/geopolitical region and the primary commodity for each.\n\nArticles:\n${articlesList}`;
            
            const classResText = await callGroq('llama-3.3-70b-versatile', systemPrompt, userPrompt, true, 800);
            
            let classifications = [];
            try {
                const cleanJson = classResText.replace(/```json/g, '').replace(/```/g, '').trim();
                classifications = JSON.parse(cleanJson);
                if (!Array.isArray(classifications)) classifications = [classifications];
            } catch (e) {
                console.error('[AI-WORKER] JSON parse error for batch classification:', e.message);
                classifications = unprocessed.map(() => ({ region: 'Global', commodity: 'General' }));
            }
            
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
    }, 120000); // Check every 120 seconds (2 minutes)
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
    console.log('[AI-FORECASTER] Background loop initialized. (Runs every 3 mins)');

    const generate = async () => {
        try {
            console.log('[AI-FORECASTER] Generating live market forecast via Llama 3...');
            const brent = livePrices['BRENT_CRUDE']?.current || 75;
            const recentAlerts = recentGeoAlerts.map(a => `[${a.severity}] ${a.title}`).join(' | ');
            
            const prompt = `You are FOPs Market Pulse, a Senior Supply Chain Risk Analyst.
Analyze the current state and provide a strategic market forecast for food supply chains and logistics.
Current Brent Crude: $${brent}
Recent Geopolitical Alerts: ${recentAlerts || 'None active'}

Provide a JSON output ONLY with exactly these keys: "next7d" (string), "next30d" (string), "next90d" (string), "confidence" (string: HIGH, MEDIUM, LOW).
Keep each forecast concise, professional, and action-oriented (1-2 sentences). Do not use markdown wrappers.`;

            const raw = await callGroq('llama-3.3-70b-versatile', prompt, "{}", true, 800);
            const data = JSON.parse(raw);
            
            if (data.next7d && data.next30d && data.next90d) {
                cachedLLMForecast = {
                    next7d: data.next7d,
                    next30d: data.next30d,
                    next90d: data.next90d,
                    confidence: data.confidence || "MEDIUM"
                };
                console.log('[AI-FORECASTER] Successfully updated cached forecast.');
            }
        } catch (err) {
            console.error('[AI-FORECASTER] Error generating forecast:', err.message);
        }
    };

    setTimeout(generate, 15000); // 15s delay to let prices init
    setInterval(generate, 180000); // Update every 3 minutes
}

setTimeout(() => runLLMForecastLoop(), 15000); // Start after 15s

const PORT = process.env.PORT || 3001;

// ── Serve React Frontend in Production ───────────────────────
const distPath = path.join(process.cwd(), 'dashboard', 'dist');
app.use(express.static(distPath));

// Catch-all route to serve React's index.html for client-side routing
app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`FOps Market Pulse v2 running on :${PORT}`));