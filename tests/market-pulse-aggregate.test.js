// tests/market-pulse-aggregate.test.js
// Shape tests for the flat Market Pulse aggregate. No server, no DB: `app` is
// a stub shaped like Express 5's router.
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeMarketPulse, MARKET_PULSE_SECTIONS, MARKET_PULSE_KEYS } from '../services/page-composer/aggregate.js';

function stubApp(overrides = {}) {
    return {
        router: {
            stack: Object.entries(MARKET_PULSE_SECTIONS).map(([name, spec]) => ({
                name: 'handle',
                route: {
                    path: spec.path,
                    methods: { [(spec.method || 'get')]: true },
                    stack: [{ handle: overrides[name] || ((rq, rs) => rs.json({ success: true, name })) }],
                },
            })),
        },
    };
}

const req = () => Object.create({
    session: { userId: 1 }, user: {}, userProfile: { news_keywords: ['cheese'] },
});

test('returns {success, data} with every section as a flat verbatim body', async () => {
    const out = await composeMarketPulse({ app: stubApp(), req: req() });
    assert.equal(out.success, true);
    assert.deepEqual(Object.keys(out.data), MARKET_PULSE_KEYS);
    // Verbatim: the endpoint's own body, not wrapped in {status, ms, data}.
    assert.deepEqual(out.data.commodities, { success: true, name: 'commodities' });
    assert.equal(out.data.commodities.data, undefined);
});

test('the reference payload keys are all present, in order', async () => {
    // The shape the FOps API team supplied. These must keep their names and
    // their order: consumers diff this payload.
    const reference = ['templates', 'userProfile', 'commodities', 'energy', 'news',
        'weather', 'forex', 'weather_extended', 'sop', 'ml-forecasts', 'ports',
        'categorized', 'morning-brief', 'analyze-planner', 'analyze', 'by-articles'];
    assert.deepEqual(MARKET_PULSE_KEYS.slice(0, reference.length), reference);
});

test('marketIndicators is an addition on the end, not a reshuffle', async () => {
    // Appended deliberately: the UI has a "Market Indicators" panel whose data
    // was only reachable at analyze.analysis.drivers. Adding a key is
    // backward-compatible; renaming or reordering the reference keys is not.
    assert.deepEqual(MARKET_PULSE_KEYS.slice(16), ['marketIndicators']);
});

test('phase 2 sections receive a body built from phase 1 results', async () => {
    const seen = {};
    const out = await composeMarketPulse({
        app: stubApp({
            commodities: (rq, rs) => rs.json({ success: true, prices: [{ symbol: 'CHEESE' }] }),
            news: (rq, rs) => rs.json({ success: true, articles: [{ title: 'a' }, { title: 'b' }] }),
            analyze: (rq, rs) => { seen.analyze = rq.body; rs.json({ success: true }); },
            'by-articles': (rq, rs) => { seen.byArticles = rq.body; rs.json({ success: true }); },
        }),
        req: req(),
    });
    assert.equal(out.success, true);
    assert.deepEqual(seen.analyze.prices, [{ symbol: 'CHEESE' }]);
    assert.deepEqual(seen.analyze.news, [{ title: 'a' }, { title: 'b' }]);
    assert.deepEqual(seen.analyze.keywords, ['cheese']);
    assert.equal(seen.byArticles.articles.length, 2);
});

test('POST sections are dispatched with method POST', async () => {
    const methods = {};
    await composeMarketPulse({
        app: stubApp({
            analyze: (rq, rs) => { methods.analyze = rq.method; rs.json({ success: true }); },
            commodities: (rq, rs) => { methods.commodities = rq.method; rs.json({ success: true }); },
        }),
        req: req(),
    });
    assert.equal(methods.analyze, 'POST');
    assert.equal(methods.commodities, 'GET');
});

test('a failing section becomes an error body, the rest still resolve', async () => {
    const out = await composeMarketPulse({
        app: stubApp({
            news: () => { throw new Error('news exploded'); },
            forex: (rq, rs) => rs.status(503).json({ error: 'OPEN_EXCHANGE_APP_ID is missing' }),
        }),
        req: req(),
    });
    assert.equal(out.data.news.success, false);
    assert.match(out.data.news.error, /news exploded/);
    assert.equal(out.data.forex.success, false);
    assert.equal(out.data.forex.httpStatus, 503);
    assert.equal(out.data.commodities.success, true);
    assert.equal(Object.keys(out.data).length, MARKET_PULSE_KEYS.length);
});

test('?sections= narrows but can never extend', async () => {
    const out = await composeMarketPulse({
        app: stubApp(), req: req(),
        sections: ['commodities', 'news', '/api/admin/tuning', 'invented'],
    });
    assert.deepEqual(Object.keys(out.data), ['commodities', 'news']);
});

test('a missing route is reported rather than silently omitted', async () => {
    const app = { router: { stack: [] } };
    const out = await composeMarketPulse({ app, req: req(), sections: ['commodities'] });
    assert.equal(out.data.commodities.success, false);
    assert.match(out.data.commodities.error, /not registered/);
});

test('a phase-2 section alone still resolves its phase-1 inputs', async () => {
    // Asking for analyze-planner on its own must not post an empty body: the
    // market data it summarises has to be fetched first, even though it is not
    // part of the response.
    let planner = null;
    const out = await composeMarketPulse({
        app: stubApp({
            commodities: (rq, rs) => rs.json({ success: true, prices: [{ symbol: 'CHEESE' }] }),
            news: (rq, rs) => rs.json({ success: true, articles: [{ title: 'a' }] }),
            'analyze-planner': (rq, rs) => { planner = rq.body; rs.json({ success: true, recommendations: [1] }); },
        }),
        req: req(),
        sections: ['analyze-planner'],
    });
    assert.deepEqual(Object.keys(out.data), ['analyze-planner'], 'only the asked-for section is emitted');
    assert.deepEqual(planner.prices, [{ symbol: 'CHEESE' }], 'but it received real phase-1 input');
    assert.deepEqual(planner.news, [{ title: 'a' }]);
});

test('a phase-1-only request does not fetch anything extra', async () => {
    const seen = [];
    await composeMarketPulse({
        app: stubApp(Object.fromEntries(MARKET_PULSE_KEYS.map(n =>
            [n, (rq, rs) => { seen.push(n); rs.json({ success: true }); }]))),
        req: req(),
        sections: ['commodities', 'forex'],
    });
    assert.deepEqual(seen.sort(), ['commodities', 'forex'], 'no speculative fetches');
});

test('marketIndicators is promoted to a top-level section', async () => {
    const out = await composeMarketPulse({
        app: stubApp({
            analyze: (rq, rs) => rs.json({
                success: true,
                analysis: { summary: 's', drivers: [{ factor: 'LOGISTICS: Hormuz' }, { factor: 'ENERGY: Crude' }] },
            }),
        }),
        req: req(),
    });
    assert.equal(out.data.marketIndicators.success, true);
    assert.equal(out.data.marketIndicators.drivers.length, 2);
    // It is derived from analyze, not a separate fetch, so analyze is intact.
    assert.equal(out.data.analyze.analysis.drivers.length, 2);
});

test('marketIndicators alone still runs the analyze chain beneath it', async () => {
    let plannerCalled = false;
    const out = await composeMarketPulse({
        app: stubApp({
            analyze: (rq, rs) => rs.json({ success: true, analysis: { drivers: [{ factor: 'X' }] } }),
            'analyze-planner': (rq, rs) => { plannerCalled = true; rs.json({ success: true }); },
        }),
        req: req(),
        sections: ['marketIndicators'],
    });
    assert.deepEqual(Object.keys(out.data), ['marketIndicators']);
    assert.equal(out.data.marketIndicators.drivers.length, 1);
    // analyze-planner is a sibling LLM call, not a dependency — asking for
    // market indicators must not pay for it.
    assert.equal(plannerCalled, false, 'the planner must not be called');
});

test('marketIndicators surfaces driversError rather than an empty list', async () => {
    const out = await composeMarketPulse({
        app: stubApp({
            analyze: (rq, rs) => rs.json({
                success: true,
                analysis: { drivers: [], driversError: 'Market drivers unavailable: status code 401' },
            }),
        }),
        req: req(),
        sections: ['marketIndicators'],
    });
    assert.equal(out.data.marketIndicators.success, false);
    assert.match(out.data.marketIndicators.error, /401/);
});

test('marketIndicators reports a failed analyze instead of pretending', async () => {
    const out = await composeMarketPulse({
        app: stubApp({ analyze: () => { throw new Error('analyze exploded'); } }),
        req: req(),
        sections: ['marketIndicators'],
    });
    assert.equal(out.data.marketIndicators.success, false);
    assert.match(out.data.marketIndicators.error, /analyze exploded/);
});
