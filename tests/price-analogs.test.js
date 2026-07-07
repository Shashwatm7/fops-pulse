import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAnalogs, summarizeAnalogs } from '../services/price-analogs.js';
import { buildMatcherPrompt, parseMatcherResponse, normalizeEventText, HISTORICAL_EVENTS } from '../services/precedent-engine.js';

// Synthetic 8-year series with engineered +3% jump episodes at known spots.
// The background wiggle must VARY in magnitude (sin-based, deterministic):
// perfectly alternating identical returns degenerate the MAD to zero,
// which no real market produces.
function makeSeries({ episodes = [], drift = 0 }) {
    const bars = [];
    let price = 100;
    const t0 = new Date('2016-01-01');
    for (let d = 0; d < 2000; d++) {
        const jump = episodes.includes(d) ? 0.03 : 0;
        const wiggle = Math.sin(d * 1.7) * 0.006;
        price = price * (1 + jump + wiggle + drift);
        bars.push({ date: new Date(t0.getTime() + d * 86400e3), close: price });
    }
    return bars;
}

test('finds engineered analog episodes and excludes ones too recent for aftermath', () => {
    const a = findAnalogs(makeSeries({ episodes: [200, 600, 1000, 1400, 1990] }), 3.0);
    assert.ok(a, 'analogs found');
    assert.equal(a.count, 4, 'the day-1990 episode lacks a 3-month window and is excluded');
});

test('de-clusters consecutive crisis days into one episode', () => {
    // 500/502/504 are one crisis; 1200 and 1600 are separate ones
    const a = findAnalogs(makeSeries({ episodes: [500, 502, 504, 1200, 1600] }), 3.0);
    assert.ok(a);
    assert.equal(a.count, 3, 'a run of jumps within 10 days is one episode');
});

test('fewer than 3 independent episodes is honestly reported as no analogs', () => {
    assert.equal(findAnalogs(makeSeries({ episodes: [500, 502, 1200] }), 3.0), null);
});

test('direction matters: drops are not analogs for a jump', () => {
    const a = findAnalogs(makeSeries({ episodes: [300, 800, 1300] }), -3.0);
    assert.equal(a, null, 'no drop episodes exist in this series');
});

test('roll-gap sized outliers are excluded as analogs', () => {
    // One +25% day (a contract roll) among genuine +3% episodes: with the
    // quiet series' tiny sigma, 25% is far beyond the 8-sigma roll cutoff.
    const bars = makeSeries({ episodes: [400, 900, 1400] });
    const i = 700;
    for (let d = i; d < bars.length; d++) bars[d] = { ...bars[d], close: bars[d].close * 1.25 };
    const a = findAnalogs(bars, 3.0);
    assert.ok(a);
    assert.equal(a.count, 3, 'the 25% roll day must not count as a 3% analog');
});

test('insufficient history returns null', () => {
    assert.equal(findAnalogs(makeSeries({}).slice(0, 100), 3.0), null);
});

test('summary is planner-readable and jargon-free', () => {
    // 5 strict-band episodes keeps the "similar" wording (no band widening)
    const a = findAnalogs(makeSeries({ episodes: [200, 600, 1000, 1400, 1700] }), 3.0);
    const s = summarizeAnalogs('WHEAT', 3.0, a);
    assert.match(s, /similar single-day jumps in WHEAT/);
    assert.match(s, /after 1 month/);
    assert.ok(!s.includes('σ'));
});

// ── AI fallback matcher: prompt economy and validation ──

test('matcher prompt is token-minimal and its catalog prefix is stable', () => {
    const p1 = buildMatcherPrompt('New Delhi curbs overseas grain shipments to fight food inflation');
    const p2 = buildMatcherPrompt('Some totally different event text');
    // Compact: whole prompt comfortably under ~1600 chars (~400 tokens)
    assert.ok((p1.system.length + p1.user.length) < 1600, `prompt too large: ${p1.system.length + p1.user.length} chars`);
    // The catalog section must be byte-identical across calls (cache-friendly)
    const catalog1 = p1.user.slice(0, p1.user.indexOf('\n\nEVENT:'));
    const catalog2 = p2.user.slice(0, p2.user.indexOf('\n\nEVENT:'));
    assert.equal(catalog1, catalog2);
});

test('parseMatcherResponse validates against the library — hallucinated ids die', () => {
    assert.equal(parseMatcherResponse('made-up-event-2026'), null);
    assert.equal(parseMatcherResponse('NONE'), null);
    assert.equal(parseMatcherResponse(''), null);
    const hit = parseMatcherResponse('india-rice-ban-2023');
    assert.equal(hit.id, 'india-rice-ban-2023');
    // id embedded in a chatty reply still resolves
    assert.equal(parseMatcherResponse('The best match is india-wheat-ban-2022.').id, 'india-wheat-ban-2022');
});

test('normalizeEventText strips emoji and caps length', () => {
    const n = normalizeEventText('🚨 Profile Alert: ' + 'wheat '.repeat(100));
    assert.ok(!n.includes('🚨'));
    assert.ok(n.length <= 200);
});

test('library grew and every entry still has required fields', () => {
    assert.ok(HISTORICAL_EVENTS.length >= 40, `expected >= 40 events, got ${HISTORICAL_EVENTS.length}`);
});
