// tests/page-composer.test.js
// Pure tests for the page composer: no server, no DB. `app` is a stub shaped
// like Express 5's router (verified against 5.2.1: app.router.stack, each layer
// exposing route.path / route.methods / route.stack[].handle, and a mounted
// router appearing as {name:'router', handle:{stack}, matchers:[fn]}).
import test from 'node:test';
import assert from 'node:assert/strict';
import { composePage, PAGES, SECTION_ROUTES } from '../services/page-composer/index.js';

/** Build a stub Express app exposing the given routes at the top level. */
function stubApp(routes) {
    return {
        router: {
            stack: routes.map(r => ({
                name: 'handle',
                route: {
                    path: r.path,
                    methods: { get: true },
                    // middleware chain; last entry is the business handler
                    stack: (r.before || []).concat([r.handle]).map(handle => ({ handle })),
                },
            })),
        },
    };
}

/** Every route a page needs, all answering with `body`. */
function appForPage(page, overrides = {}) {
    return stubApp(PAGES[page].map(name => ({
        path: SECTION_ROUTES[name],
        before: overrides[name]?.before,
        handle: overrides[name]?.handle || ((req, res) => res.json({ ok: true })),
    })));
}

const okHandler = (body) => (req, res) => res.json(body);
const req = () => Object.create({ session: { userId: 1 }, user: {}, userProfile: {} });

test('composePage returns one section per configured entry', async () => {
    const out = await composePage({ app: appForPage('dashboard'), page: 'dashboard', req: req() });
    assert.equal(out.page, 'dashboard');
    assert.deepEqual(Object.keys(out.sections).sort(), [...PAGES.dashboard].sort());
    assert.ok(out.generatedAt);
});

test('every configured page composes end to end', async () => {
    for (const page of Object.keys(PAGES)) {
        const out = await composePage({ app: appForPage(page), page, req: req() });
        assert.equal(Object.keys(out.sections).length, PAGES[page].length, `${page} section count`);
        for (const name of PAGES[page]) {
            assert.equal(out.sections[name].status, 'ok', `${page}.${name} should be ok`);
        }
    }
});

test('every section name in PAGES has a route mapped', () => {
    for (const [page, sections] of Object.entries(PAGES)) {
        for (const name of sections) {
            assert.ok(SECTION_ROUTES[name], `${page} references unmapped section '${name}'`);
        }
    }
});

test('unknown page throws a 404-tagged error listing known pages', async () => {
    await assert.rejects(
        () => composePage({ app: stubApp([]), page: 'nope', req: req() }),
        (err) => err.statusCode === 404 && err.knownPages.includes('dashboard'),
    );
});

test('?sections= narrows the page but can never extend it', async () => {
    const out = await composePage({
        app: appForPage('dashboard'), page: 'dashboard', req: req(),
        sections: ['commodities', 'dbStats', 'not_a_section'],
    });
    // Only the legitimate one survives; `dbStats` is a real route but belongs
    // to another page, so it is dropped rather than dispatched.
    assert.deepEqual(Object.keys(out.sections), ['commodities']);
});

test('a throwing section is isolated and the rest of the page still resolves', async () => {
    const app = appForPage('dashboard', {
        news: { handle: () => { throw new Error('news exploded'); } },
    });
    const out = await composePage({ app, page: 'dashboard', req: req() });
    assert.equal(out.sections.news.status, 'error');
    assert.equal(out.sections.news.error.code, 'SECTION_THREW');
    assert.match(out.sections.news.error.message, /news exploded/);
    assert.equal(out.sections.commodities.status, 'ok');
    // Every section is accounted for even when one blows up.
    assert.equal(Object.keys(out.sections).length, PAGES.dashboard.length);
});

test('a 4xx/5xx from a section becomes a typed error, not data', async () => {
    const app = appForPage('dashboard', {
        forex: { handle: (rq, rs) => rs.status(503).json({ error: 'OPEN_EXCHANGE_APP_ID is missing' }) },
    });
    const out = await composePage({ app, page: 'dashboard', req: req() });
    assert.equal(out.sections.forex.status, 'error');
    assert.equal(out.sections.forex.error.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(out.sections.forex.error.httpStatus, 503);
    assert.equal(out.sections.forex.data, null);
});

test('SECURITY: requireAdmin still runs and denies a non-admin', async () => {
    // The composer skips only the middleware it is told has already run
    // (requireAuth). An admin guard on the route must execute and must win.
    const requireAuth = (rq, rs, next) => next();
    const requireAdmin = (rq, rs, next) =>
        (rq.user?.is_admin ? next() : rs.status(403).json({ error: 'Admin access required' }));

    const app = stubApp(PAGES.admin.map(name => ({
        path: SECTION_ROUTES[name],
        before: [requireAuth, requireAdmin],
        handle: okHandler({ secret: 'admin only' }),
    })));

    const nonAdmin = Object.create({ session: { userId: 1 }, user: { is_admin: false } });
    const denied = await composePage({
        app, page: 'admin', req: nonAdmin, skipMiddleware: [requireAuth],
    });
    for (const name of PAGES.admin) {
        assert.equal(denied.sections[name].status, 'error', `${name} must be denied`);
        assert.equal(denied.sections[name].error.code, 'FORBIDDEN');
        assert.equal(denied.sections[name].error.httpStatus, 403);
        assert.equal(denied.sections[name].data, null, 'the handler body must not leak');
    }

    const admin = Object.create({ session: { userId: 1 }, user: { is_admin: true } });
    const allowed = await composePage({
        app, page: 'admin', req: admin, skipMiddleware: [requireAuth],
    });
    for (const name of PAGES.admin) {
        assert.equal(allowed.sections[name].status, 'ok');
        assert.deepEqual(allowed.sections[name].data, { secret: 'admin only' });
    }
});

test('SECURITY: skipMiddleware skips only the exact function given', async () => {
    const requireAuth = (rq, rs, next) => next();
    const somethingElse = (rq, rs) => rs.status(418).json({ error: 'still ran' });
    const app = stubApp([{
        path: SECTION_ROUTES.commodities,
        before: [requireAuth, somethingElse],
        handle: okHandler({ leaked: true }),
    }]);
    const out = await composePage({
        app, page: 'dashboard', req: req(),
        sections: ['commodities'], skipMiddleware: [requireAuth],
    });
    assert.equal(out.sections.commodities.error.httpStatus, 418);
    assert.equal(out.sections.commodities.data, null);
});

test('an async handler behind sync middleware is not truncated', async () => {
    // Regression: a middleware that calls next() and then resolves must not
    // settle the section while the real handler is still pending.
    const requireAuth = (rq, rs, next) => next();
    const passthrough = (rq, rs, next) => next();
    const app = stubApp([{
        path: SECTION_ROUTES.commodities,
        before: [requireAuth, passthrough],
        handle: async (rq, rs) => {
            await new Promise(r => setTimeout(r, 10));
            rs.json({ slow: true });
        },
    }]);
    const out = await composePage({
        app, page: 'dashboard', req: req(),
        sections: ['commodities'], skipMiddleware: [requireAuth],
    });
    assert.equal(out.sections.commodities.status, 'ok');
    assert.deepEqual(out.sections.commodities.data, { slow: true });
});

test('routes on a mounted router are found through the mount path', async () => {
    // Shaped like app.use('/api/auth', authRouter) in Express 5.
    const app = {
        router: {
            stack: [{
                name: 'router',
                matchers: [(p) => (p.startsWith('/api/auth') ? { path: '/api/auth', params: {} } : false)],
                handle: {
                    stack: [
                        { name: 'handle', route: { path: '/me', methods: { get: true }, stack: [{ handle: okHandler({ id: 7 }) }] } },
                        { name: 'handle', route: { path: '/templates', methods: { get: true }, stack: [{ handle: okHandler({ templates: [] }) }] } },
                    ],
                },
            }],
        },
    };
    const out = await composePage({ app, page: 'settings', req: req() });
    assert.equal(out.sections.me.status, 'ok');
    assert.deepEqual(out.sections.me.data, { id: 7 });
    assert.equal(out.sections.templates.status, 'ok');
});

test('a missing route is an error rather than a silent omission', async () => {
    const app = stubApp([{ path: '/api/commodities', handle: okHandler({ ok: true }) }]);
    const out = await composePage({ app, page: 'dashboard', req: req() });
    assert.equal(out.sections.commodities.status, 'ok');
    assert.equal(out.sections.news.status, 'error');
    assert.match(out.sections.news.error.message, /not registered/);
});

test('sections do not inherit each other query params', async () => {
    const seen = {};
    const app = stubApp(PAGES.dashboard.map(name => ({
        path: SECTION_ROUTES[name],
        handle: (rq, rs) => { seen[name] = { url: rq.url, query: rq.query }; rs.json({ ok: true }); },
    })));
    await composePage({ app, page: 'dashboard', req: req() });
    for (const name of PAGES.dashboard) {
        assert.equal(seen[name].url, SECTION_ROUTES[name], `${name} dispatched at its own path`);
        assert.deepEqual(seen[name].query, {}, `${name} should start with an empty query`);
    }
});

test('sectionQuery reaches only its own section', async () => {
    const seen = {};
    const app = stubApp(PAGES['pipeline-analytics'].map(name => ({
        path: SECTION_ROUTES[name],
        handle: (rq, rs) => { seen[name] = rq.query; rs.json({ ok: true }); },
    })));
    await composePage({
        app, page: 'pipeline-analytics', req: req(),
        sectionQuery: { pipelineAudit: { limit: '50' } },
    });
    assert.deepEqual(seen.pipelineAudit, { limit: '50' });
    assert.deepEqual(seen.scanStatus, {});
    assert.deepEqual(seen.discoveryClusters, {});
});
