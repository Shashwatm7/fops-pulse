// tests/url-quote-strip.test.js
// The middleware that tolerates a quote character pasted into a URL.
import test from 'node:test';
import assert from 'node:assert/strict';

// Mirror of the middleware in server.js.
function normalise(url) {
    const qIdx = url.indexOf('?');
    const path = qIdx === -1 ? url : url.slice(0, qIdx);
    const query = qIdx === -1 ? '' : url.slice(qIdx);
    return path.replace(/(?:%22|%27|["'])+$/i, '') + query;
}

test('strips a percent-encoded trailing double quote', () => {
    assert.equal(normalise('/api/market-pulse/indicators%22'), '/api/market-pulse/indicators');
});

test('strips a literal trailing quote, single or double', () => {
    assert.equal(normalise('/api/commodities"'), '/api/commodities');
    assert.equal(normalise("/api/commodities'"), '/api/commodities');
    assert.equal(normalise('/api/commodities%27'), '/api/commodities');
});

test('strips repeats, and is case-insensitive about the escape', () => {
    assert.equal(normalise('/api/forex%22%22'), '/api/forex');
    assert.equal(normalise('/api/forex%22'), '/api/forex');
});

test('leaves the query string alone — a quote there can be real', () => {
    assert.equal(
        normalise('/api/regions/search?q=%22Jebel%20Ali%22'),
        '/api/regions/search?q=%22Jebel%20Ali%22',
    );
});

test('strips from the path even when a query follows', () => {
    assert.equal(
        normalise('/api/market-pulse/full%22?sections=commodities'),
        '/api/market-pulse/full?sections=commodities',
    );
});

test('a clean URL is untouched', () => {
    for (const u of ['/api/commodities', '/api/market-pulse/full?sections=news', '/healthz', '/']) {
        assert.equal(normalise(u), u);
    }
});

test('a genuinely wrong path still does not become a right one', () => {
    // Only quotes are removed — a typo stays a typo and still 404s.
    assert.equal(normalise('/api/market-pulse/indicatorz'), '/api/market-pulse/indicatorz');
    assert.equal(normalise('/api/market-pulse/indicators/%22extra'), '/api/market-pulse/indicators/%22extra');
});
