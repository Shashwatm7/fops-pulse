// services/page-composer/aggregate.js
//
// Flat aggregate of every Market Pulse dashboard endpoint, shaped to match the
// reference payload supplied by the FOps API team:
//
//   { success: true, data: { templates: {...}, userProfile: {...}, ... } }
//
// Each value is the EXACT body the existing endpoint returns, verbatim. There
// is no per-section status/ms/error wrapper -- that is what /api/pages/:page
// does, and this endpoint deliberately does not, because the consumer wants to
// read data.commodities.prices without unwrapping first.
//
// Every existing endpoint is left exactly as it is. This composes them; it
// does not replace them, and nothing routes through it unless asked.
//
// TWO PHASES, BECAUSE THREE SECTIONS DEPEND ON THE OTHERS
// The browser does this in two waves today: fetch the data endpoints, then POST
// that data back to the analysis endpoints. /api/analyze and
// /api/analyze-planner take {prices, energy, news, weather, forex,
// weatherExtended, keywords} as their request body, and /api/insights/by-articles
// takes {articles}. So phase 1 resolves the independent sections in parallel,
// and phase 2 builds each dependent body from phase 1's results. Running them
// all at once would post empty bodies and get empty analyses back.

import { findRoute, runHandlerChain, sectionRequest } from './index.js';

/**
 * A section that failed. Shaped like the app's own error bodies ({success:
 * false, error}) so a consumer reading data.news.articles sees a consistent
 * envelope whether or not the section worked, and never mistakes an error for
 * data.
 */
const sectionError = (message, httpStatus) => ({
    success: false,
    error: message,
    ...(httpStatus ? { httpStatus } : {}),
});

/**
 * Body for /api/analyze and /api/analyze-planner, built from phase 1 exactly
 * as App.jsx:866 and :1131 build it client-side.
 */
function analysisBody(data, req) {
    return {
        prices: data.commodities?.prices || [],
        energy: data.energy || {},
        news: data.news?.articles || [],
        weather: data.weather?.regions || [],
        forex: data.forex?.rates || null,
        weatherExtended: data.weather_extended?.regions || [],
        keywords: req.userProfile?.news_keywords || [],
    };
}

/**
 * The aggregate definition. Key order here is the key order in the response.
 *
 * phase 1 = independent, all dispatched in parallel.
 * phase 2 = needs phase 1's output, so it waits.
 */
export const MARKET_PULSE_SECTIONS = {
    templates:          { path: '/api/auth/templates',        phase: 1 },
    userProfile:        { path: '/api/auth/me',               phase: 1 },
    commodities:        { path: '/api/commodities',           phase: 1 },
    energy:             { path: '/api/energy',                phase: 1 },
    news:               { path: '/api/news',                  phase: 1 },
    weather:            { path: '/api/weather',               phase: 1 },
    forex:              { path: '/api/forex',                 phase: 1 },
    weather_extended:   { path: '/api/weather-extended',      phase: 1 },
    sop:                { path: '/api/sop',                   phase: 1 },
    'ml-forecasts':     { path: '/api/ml-forecasts',          phase: 1 },
    ports:              { path: '/api/ports',                 phase: 1 },
    categorized:        { path: '/api/news/categorized',      phase: 1 },
    'morning-brief':    { path: '/api/morning-brief',         phase: 1 },

    // LLM-backed, and the slow part of the payload: these call Groq. They are
    // in the default set because the reference payload includes them, but
    // ?sections= exists precisely so a caller that only wants market data can
    // leave them out and get the response in well under a second.
    'analyze-planner':  { path: '/api/analyze-planner',       phase: 2, method: 'post', body: analysisBody },
    analyze:            { path: '/api/analyze',               phase: 2, method: 'post', body: analysisBody },
    'by-articles':      {
        path: '/api/insights/by-articles', phase: 2, method: 'post',
        // The handler caps at 60 itself; slicing here keeps the request body
        // from carrying hundreds of articles it will discard.
        body: (data) => ({ articles: (data.news?.articles || []).slice(0, 60) }),
    },
};

export const MARKET_PULSE_KEYS = Object.keys(MARKET_PULSE_SECTIONS);

/** Resolve one section to its verbatim response body, or an error body. */
async function resolveSection(app, name, spec, req, skip, data) {
    const method = spec.method || 'get';
    try {
        const route = findRoute(app, spec.path, method);
        if (!route) return sectionError(`route ${spec.path} is not registered`);

        const body = typeof spec.body === 'function' ? spec.body(data, req) : undefined;
        const sub = sectionRequest(req, spec.path, {}, { method, body });
        const { statusCode, body: out } = await runHandlerChain(route, sub, skip);

        // A handler that answered 4xx/5xx returned an error body, not data.
        // Pass its own message through rather than inventing one.
        if (statusCode >= 400) {
            return sectionError(out?.error || out?.message || `section returned ${statusCode}`, statusCode);
        }
        return out;
    } catch (err) {
        // One broken section must never empty the other fifteen.
        return sectionError(err.message);
    }
}

/**
 * Compose the flat Market Pulse aggregate.
 *
 * @param {object}     opts
 * @param {object}     opts.app              the Express app
 * @param {object}     opts.req              the authenticated outer request
 * @param {string[]}   [opts.sections]       narrow the set (never extends it)
 * @param {Function[]} [opts.skipMiddleware] middleware already run (requireAuth)
 * @returns {{success: true, data: Object}}
 */
export async function composeMarketPulse({ app, req, sections: requested, skipMiddleware }) {
    const skip = new Set(skipMiddleware || []);

    // A caller may narrow the set but never add to it: an arbitrary name here
    // must not become a dispatch to an arbitrary route.
    const wanted = requested?.length
        ? MARKET_PULSE_KEYS.filter(k => requested.includes(k))
        : MARKET_PULSE_KEYS;

    const data = {};

    const runPhase = async (phase) => {
        const names = wanted.filter(n => (MARKET_PULSE_SECTIONS[n].phase || 1) === phase);
        const results = await Promise.all(names.map(n =>
            resolveSection(app, n, MARKET_PULSE_SECTIONS[n], req, skip, data)));
        names.forEach((n, i) => { data[n] = results[i]; });
    };

    await runPhase(1);
    await runPhase(2);

    // Emit in declaration order regardless of which phase filled each key, so
    // the response shape is stable for a consumer diffing it.
    const ordered = {};
    for (const k of wanted) ordered[k] = data[k];

    return { success: true, data: ordered };
}
