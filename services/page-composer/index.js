// services/page-composer/index.js
//
// Page-level API composition ("BFF"): one request returns everything a
// dashboard page needs, instead of the client firing 8 parallel fetches.
//
// WHY IN-PROCESS DISPATCH RATHER THAN HTTP FAN-OUT
// A composer that called its own endpoints over HTTP would re-run the whole
// middleware stack per section — including express-session, whose store is
// Postgres (connect-pg-simple). That is one SELECT per section, which is
// precisely the cost this endpoint exists to remove. So sections are resolved
// by invoking the route's final handler directly, reusing the already-loaded
// req.session and req.userProfile from the outer request.
//
// WHY NOT EXTRACTED RESOLVER FUNCTIONS (yet)
// The eight dashboard handlers are 15-144 lines each and read module-scope
// state in server.js (livePrices, priceHistory, COMMODITY_DATA, tuning...).
// Lifting them into standalone resolvers means threading all of that state
// through, which is a much larger and riskier diff than this. Dispatching the
// existing handlers keeps ONE copy of every handler's logic — the alternative
// short-cut, duplicating it here, would guarantee the two drift apart. The
// trade-off accepted instead is a dependency on Express's router internals
// (app.router.stack), guarded by assertRouteShape() below.
//
// Verified against Express 5.2.1: app.router exists (app._router does not),
// and each route layer exposes route.path + route.stack[].handle.

/**
 * Which sections make up each page. Server-side only — a client may narrow
 * this list via ?sections= but can never add to it, so this doubles as the
 * authorization boundary for what the composer is willing to dispatch.
 */
export const PAGES = {
    dashboard: [
        'commodities',
        'energy',
        'news',
        'weather',
        'weatherExtended',
        'forex',
        'sop',
        'mlForecasts',
    ],
};

/**
 * section name -> the GET route whose handler produces it.
 * Every path here MUST be a route protected by exactly [requireAuth, handler].
 * See assertRouteShape().
 */
export const SECTION_ROUTES = {
    commodities:     '/api/commodities',
    energy:          '/api/energy',
    news:            '/api/news',
    weather:         '/api/weather',
    weatherExtended: '/api/weather-extended',
    forex:           '/api/forex',
    sop:             '/api/sop',
    mlForecasts:     '/api/ml-forecasts',
};

function findRoute(app, path) {
    const stack = (app.router || app._router)?.stack || [];
    for (const layer of stack) {
        if (layer.route?.path === path && layer.route.methods?.get) return layer.route;
    }
    return null;
}

/**
 * SECURITY GUARD. The composer deliberately skips a route's middleware and
 * calls only its final handler, because the outer /api/pages route has already
 * run requireAuth. That is safe ONLY while the inner route's sole middleware
 * IS requireAuth. A route guarded by [requireAuth, requireAdmin, handler]
 * would have its admin check silently bypassed, turning this endpoint into
 * privilege escalation.
 *
 * So: refuse anything whose chain is not exactly two handlers. Adding an
 * admin-only section therefore fails loudly here rather than leaking.
 */
function assertRouteShape(route, path) {
    if (route.stack.length !== 2) {
        throw new Error(
            `page-composer refuses ${path}: expected exactly [requireAuth, handler] ` +
            `but found ${route.stack.length} handlers. A route with extra middleware ` +
            `(e.g. requireAdmin) must not be dispatched this way — its guard would be skipped.`
        );
    }
}

/**
 * Run a route's final handler against a synthetic res that captures the JSON
 * body instead of writing to the socket.
 */
function invokeHandler(route, req) {
    const handler = route.stack[route.stack.length - 1].handle;

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (statusCode, body) => {
            if (settled) return;          // handlers may call res.json() then return
            settled = true;
            resolve({ statusCode, body });
        };

        const res = {
            statusCode: 200,
            headersSent: false,
            set() { return res; },
            setHeader() { return res; },
            type() { return res; },
            status(code) { res.statusCode = code; return res; },
            json(body) { finish(res.statusCode, body); return res; },
            send(body) { finish(res.statusCode, body); return res; },
            end() { finish(res.statusCode, null); return res; },
        };

        // A handler that throws synchronously, or rejects, becomes a section
        // error rather than taking down the whole page.
        try {
            Promise.resolve(handler(req, res)).then(() => {
                // Handler returned without responding — treat as empty, not a hang.
                finish(res.statusCode, null);
            }, reject);
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Build the per-section request. Inherits session/userProfile from the real
 * request via the prototype chain, but gets its own query/params so one
 * section cannot see another's parameters.
 */
function sectionRequest(req, path) {
    const sub = Object.create(req);

    // Express defines `path` and `query` as GETTERS on the request prototype
    // (both derived from `url`), so plain assignment throws
    // "Cannot set property path of #<IncomingMessage> which has only a getter".
    // defineProperty installs own value properties that shadow them instead.
    // `path` is intentionally not overridden — Express derives it from `url`,
    // which we do set, so it stays correct on its own.
    const own = {
        url: path,
        originalUrl: path,
        baseUrl: '',
        method: 'GET',
        query: {},
        params: {},
        body: {},
    };
    for (const [key, value] of Object.entries(own)) {
        Object.defineProperty(sub, key, {
            value, writable: true, enumerable: true, configurable: true,
        });
    }
    return sub;
}

/**
 * Compose one page.
 *
 * Always resolves. A failing section becomes {status:'error'} inside the
 * envelope and the rest of the page still renders — this reproduces the
 * client's existing per-fetch .catch() behaviour (App.jsx:1072) server-side.
 * Returning a 500 for the whole page would turn today's degraded-but-usable
 * dashboard into a blank one.
 *
 * @returns {{page:string, generatedAt:string, sections:Object}}
 */
export async function composePage({ app, page, req, sections: requested }) {
    const known = PAGES[page];
    if (!known) {
        const err = new Error(`unknown page '${page}'`);
        err.statusCode = 404;
        err.knownPages = Object.keys(PAGES);
        throw err;
    }

    // ?sections= may only narrow the page's own list, never extend it.
    const wanted = requested?.length
        ? known.filter(s => requested.includes(s))
        : known;

    const settled = await Promise.allSettled(wanted.map(async (name) => {
        const path = SECTION_ROUTES[name];
        const startedAt = Date.now();
        try {
            if (!path) throw new Error(`no route mapped for section '${name}'`);
            const route = findRoute(app, path);
            if (!route) throw new Error(`route ${path} is not registered`);
            assertRouteShape(route, path);

            const { statusCode, body } = await invokeHandler(route, sectionRequest(req, path));
            const ms = Date.now() - startedAt;

            // Handlers signal upstream trouble with a 4xx/5xx of their own
            // (e.g. /api/forex returns 503 when OPEN_EXCHANGE_APP_ID is unset).
            // Surface that as a typed section error instead of passing an error
            // body off as data.
            if (statusCode >= 400) {
                return {
                    name, ms, status: 'error', data: null,
                    error: {
                        code: statusCode === 503 ? 'UPSTREAM_UNAVAILABLE' : 'SECTION_FAILED',
                        httpStatus: statusCode,
                        message: body?.error || body?.message || `section returned ${statusCode}`,
                    },
                };
            }
            return { name, ms, status: 'ok', data: body };
        } catch (err) {
            return {
                name,
                ms: Date.now() - startedAt,
                status: 'error',
                data: null,
                error: { code: 'SECTION_THREW', message: err.message },
            };
        }
    }));

    const out = {};
    for (const r of settled) {
        // allSettled + the inner try/catch means rejection here is not expected,
        // but a section must never be silently missing from the envelope.
        if (r.status === 'fulfilled') {
            const { name, ...rest } = r.value;
            out[name] = rest;
        }
    }

    return { page, generatedAt: new Date().toISOString(), sections: out };
}
