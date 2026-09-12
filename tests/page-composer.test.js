// tests/page-composer.test.js
// Pure tests for the page composer: no server, no DB. `app` is a stub shaped
// like Express 5's router (verified against 5.2.1: app.router.stack, each layer
// exposing route.path / route.methods / route.stack[].handle).
import test from 'node:test';
import assert from 'node:assert/strict';
import { composePage, PAGES, SECTION_ROUTES } from '../services/page-composer/index.js';

/** Build a stub Express app exposing the given routes. */
function stubApp(routes) {
    return {
        router: {
            stack: routes.map(r => ({
                route: {
                    path: r.path,
                    methods: { get: true },
                    // middleware chain; last entry is the business handler
                    stack: (r.middleware || 1) === 1
                        ? [{ handle: () => {} }, { handle: r.handle }]
                        : [...Array(r.middleware - 1)].map(() => ({ handle: () => {} }))
                            .concat([{ handle: r.handle }]),
                },
            })),
        },
    };
}

const okHandler = (body) => (req, res) => res.json(body);
const req = () => Object.create({ session: { userId: 1 }, userProfile: {} });

test('composePage returns one section per configured entry', async () => {
    const app = stubApp(Object.entries(SECTION_ROUTES).map(([, path]) => ({
        path, handle: okHandler({ ok: true }),
    })));
    const out = await composePage({ app, page: 'dashboard', req: req() });
    assert.equal(out.page, 'dashboard');
    assert.deepEqual(Object.keys(out.sections).sort(), [...PAGES.dashboard].sort());
    assert.ok(out.generatedAt);
});

test('unknown page throws a 404-tagged error listing known pages', async () => {
    const app = stubApp([]);
    await assert.rejects(
        () => composePage({ app, page: 'nope', req: req() }),
        (err) => err.statusCode === 404 && err.knownPages.includes('dashboard'),
    );
});

test('?sections= narrows the page but can never extend it', async () => {
    const app = stubApp(Object.entries(SECTION_ROUTES).map(([, path]) => ({
        path, handle: okHandler({ ok: true }),
    })));
    const out = await composePage({
        app, page: 'dashboard', req: req(),
        sections: ['commodities', 'admin_secret', 'not_a_section'],
    });
    // Only the legitimate one survives; the invented names are dropped rather
    // than dispatched, so a client cannot reach a route outside the page.
    assert.deepEqual(Object.keys(out.sections), ['commodities']);
});

test('a throwing section is isolated and the rest of the page still resolves', async () => {
    const app = stubApp(Object.entries(SECTION_ROUTES).map(([name, path]) => ({
        path,
        handle: name === 'news'
            ? () => { throw new Error('news exploded'); }
            : okHandler({ ok: true }),
    })));
    const out = await composePage({ app, page: 'dashboard', req: req() });
    assert.equal(out.sections.news.status, 'error');
    assert.equal(out.sections.news.error.code, 'SECTION_THREW');
    assert.match(out.sections.news.error.message, /news exploded/);
    assert.equal(out.sections.commodities.status, 'ok');
    // Every section is accounted for even when one blows up.
    assert.equal(Object.keys(out.sections).length, PAGES.dashboard.length);
});

test('a 4xx/5xx from a section becomes a typed error, not data', async () => {
    const app = stubApp(Object.entries(SECTION_ROUTES).map(([name, path]) => ({
        path,
        handle: name === 'forex'
            ? (rq, rs) => rs.status(503).json({ error: 'OPEN_EXCHANGE_APP_ID is missing' })
            : okHandler({ ok: true }),
    })));
    const out = await composePage({ app, page: 'dashboard', req: req() });
    assert.equal(out.sections.forex.status, 'error');
    assert.equal(out.sections.forex.error.code, 'UPSTREAM_UNAVAILABLE');
    assert.equal(out.sections.forex.error.httpStatus, 503);
    assert.equal(out.sections.forex.data, null);
});

test('SECURITY: refuses a route carrying extra middleware', async () => {
    // A route guarded by [requireAuth, requireAdmin, handler] must NOT be
    // dispatched: the composer skips middleware, so the admin check would be
    // bypassed. It must fail as a section error, never return the body.
    const app = stubApp(Object.entries(SECTION_ROUTES).map(([name, path]) => ({
        path,
        middleware: name === 'sop' ? 3 : 1,
        handle: okHandler({ secret: 'admin only' }),
    })));
    const out = await composePage({ app, page: 'dashboard', req: req() });
    assert.equal(out.sections.sop.status, 'error');
    assert.equal(out.sections.sop.error.code, 'SECTION_THREW');
    assert.match(out.sections.sop.error.message, /requireAdmin|extra middleware|expected exactly/);
    assert.equal(out.sections.sop.data, null);
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
    const app = stubApp(Object.entries(SECTION_ROUTES).map(([name, path]) => ({
        path,
        handle: (rq, rs) => { seen[name] = { url: rq.url, query: rq.query }; rs.json({ ok: true }); },
    })));
    await composePage({ app, page: 'dashboard', req: req() });
    for (const [name, path] of Object.entries(SECTION_ROUTES)) {
        assert.equal(seen[name].url, path, `${name} should be dispatched at its own path`);
        assert.deepEqual(seen[name].query, {}, `${name} should start with an empty query`);
    }
});
