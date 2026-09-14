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

test('the reference payload key set is what we emit', async () => {
    // The shape the FOps API team supplied.
    const expected = ['templates', 'userProfile', 'commodities', 'energy', 'news',
        'weather', 'forex', 'weather_extended', 'sop', 'ml-forecasts', 'ports',
        'categorized', 'morning-brief', 'analyze-planner', 'analyze', 'by-articles'];
    assert.deepEqual(MARKET_PULSE_KEYS, expected);
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
