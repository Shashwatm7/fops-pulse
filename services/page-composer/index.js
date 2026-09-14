// services/page-composer/index.js
//
// Page-level API composition ("BFF"): one request returns everything a
// dashboard page needs, instead of the client firing N parallel fetches.
//
// WHY IN-PROCESS DISPATCH RATHER THAN HTTP FAN-OUT
// A composer that called its own endpoints over HTTP would re-run the whole
// middleware stack per section — including express-session, whose store is
// Postgres (connect-pg-simple). That is one SELECT per section, which is
// precisely the cost this endpoint exists to remove. So sections are resolved
// by invoking the route's own handler chain directly, reusing the
// already-loaded req.session, req.user and req.userProfile.
//
// WHY NOT EXTRACTED RESOLVER FUNCTIONS (yet)
// The handlers are 15-144 lines each and read module-scope state in server.js
// (livePrices, priceHistory, COMMODITY_DATA, tuning...). Lifting them into
// standalone resolvers means threading all of that through, a much larger and
// riskier diff. Dispatching the existing handlers keeps ONE copy of every
// handler's logic; duplicating it here would guarantee the two drift apart.
// The trade-off is a dependency on Express's router internals, verified
// against Express 5.2.1: app.router exists (app._router does not), each route
// layer exposes route.path + route.stack[].handle, a mounted router appears as
// a layer with name === 'router', and its mount path is recoverable from
// layer.matchers[0](path).

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
    'pipeline-analytics': [
        'scanStatus',
        'pipelineAudit',
        'discoveryClusters',
    ],
    // Every section here is behind requireAdmin. That guard still runs (see
    // runHandlerChain), so a non-admin gets three 403 sections rather than
    // data — the page composes, it just composes into refusals.
    admin: [
        'tuning',
        'dbStats',
        'users',
    ],
    settings: [
        'me',
        'templates',
    ],
};

/**
 * section name -> the GET route whose handler produces it.
 */
export const SECTION_ROUTES = {
    // dashboard
    commodities:       '/api/commodities',
    energy:            '/api/energy',
    news:              '/api/news',
    weather:           '/api/weather',
    weatherExtended:   '/api/weather-extended',
    forex:             '/api/forex',
    sop:               '/api/sop',
    mlForecasts:       '/api/ml-forecasts',
    // pipeline-analytics
    scanStatus:        '/api/scan-status',
    pipelineAudit:     '/api/pipeline-audit',
    discoveryClusters: '/api/discovery-clusters',
    // admin
    tuning:            '/api/admin/tuning',
    dbStats:           '/api/auth/admin/db-stats',
    users:             '/api/auth/admin/users',
    // settings
    me:                '/api/auth/me',
    templates:         '/api/auth/templates',
};

const ERROR_CODES = {
    401: 'UNAUTHENTICATED',
    403: 'FORBIDDEN',
    404: 'SECTION_NOT_FOUND',
    503: 'UPSTREAM_UNAVAILABLE',
};

/**
 * Find a GET route by full path, descending into mounted routers.
 *
 * app.use('/api/auth', authRouter) puts the auth routes one level down, and
 * the layer does NOT carry its mount path as a plain string — layer.path is
 * only populated during a real match. layer.matchers[0](fullPath) returns
 * {path: '/api/auth'} for a path under the mount and false otherwise, which
 * gives both the test and the prefix to strip.
 */
export function findRoute(app, path, method = 'get') {
    const want = method.toLowerCase();
    const walk = (stack, remaining) => {
        for (const layer of stack) {
            if (layer.route) {
                if (layer.route.path === remaining && layer.route.methods?.[want]) return layer.route;
                continue;
            }
            if (layer.name === 'router' && layer.handle?.stack) {
                let matched = false;
                try {
                    matched = layer.matchers?.[0]?.(remaining) || false;
                } catch {
                    matched = false;
                }
                if (!matched) continue;
                const rest = remaining.slice(matched.path.length) || '/';
                const found = walk(layer.handle.stack, rest);
                if (found) return found;
            }
        }
        return null;
    };
    return walk((app.router || app._router)?.stack || [], path);
}

/**
 * Run a route's full handler chain against a synthetic res that captures the
 * JSON body instead of writing to the socket.
 *
 * SECURITY: every middleware on the route runs, with one exception — `skip`
 * holds requireAuth, which the outer /api/pages route has already run (and
 * which would otherwise re-query the user once per section, the cost this
 * endpoint exists to avoid). Everything else, requireAdmin included, executes
 * normally. A middleware that short-circuits with res.status(403).json(...)
 * settles the section with that 403, so a guard denying access produces a
 * denial in the envelope rather than leaking the handler's body.
 *
 * An earlier version skipped ALL middleware and refused any route with more
 * than two handlers. That was safe but could not express an admin page at all;
 * running the chain is both safer and more general.
 */
export function runHandlerChain(route, req, skip) {
    const handlers = route.stack.map(layer => layer.handle);
    if (handlers.length === 0) throw new Error('route has no handlers');

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

        let i = 0;
        const next = (err) => {
            if (err) return reject(err instanceof Error ? err : new Error(String(err)));
            if (settled) return;

            const handler = handlers[i++];
            if (!handler) return finish(res.statusCode, null);
            if (skip.has(handler)) return next();

            // Only the LAST handler may settle the section by returning: a
            // middleware typically calls next() and then resolves while the
            // handler downstream is still pending, so finishing on a
            // middleware's resolution would truncate the section to null.
            const isLast = i === handlers.length;
            try {
                Promise.resolve(handler(req, res, next)).then(
                    () => { if (isLast) finish(res.statusCode, null); },
                    reject,
                );
            } catch (err2) {
                reject(err2);
            }
        };
        next();
    });
}

/**
 * Build the per-section request. Inherits session/user/userProfile from the
 * real request via the prototype chain, but gets its own query/params so one
 * section cannot see another's parameters.
 */
export function sectionRequest(req, path, query, opts = {}) {
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
        method: (opts.method || 'GET').toUpperCase(),
        query: query || {},
        params: {},
        body: opts.body || {},
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
 * @param {object}     opts
 * @param {object}     opts.app              the Express app
 * @param {string}     opts.page             key of PAGES
 * @param {object}     opts.req              the authenticated outer request
 * @param {string[]}   [opts.sections]       narrow the page (never extends it)
 * @param {object}     [opts.sectionQuery]   per-section query params,
 *                                           e.g. {pipelineAudit: {limit: '50'}}
 * @param {Function[]} [opts.skipMiddleware] middleware already run on the
 *                                           outer request (requireAuth)
 * @returns {{page:string, generatedAt:string, sections:Object}}
 */
export async function composePage({ app, page, req, sections: requested, sectionQuery, skipMiddleware }) {
    const known = PAGES[page];
    if (!known) {
        const err = new Error(`unknown page '${page}'`);
        err.statusCode = 404;
        err.knownPages = Object.keys(PAGES);
        throw err;
    }

    const skip = new Set(skipMiddleware || []);

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

            const sub = sectionRequest(req, path, sectionQuery?.[name]);
            const { statusCode, body } = await runHandlerChain(route, sub, skip);
            const ms = Date.now() - startedAt;

            // Handlers and guards signal trouble with a status of their own
            // (403 from requireAdmin, 503 from /api/forex when the key is
            // unset). Surface that as a typed section error instead of passing
            // an error body off as data.
            if (statusCode >= 400) {
                return {
                    name, ms, status: 'error', data: null,
                    error: {
                        code: ERROR_CODES[statusCode] || 'SECTION_FAILED',
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
