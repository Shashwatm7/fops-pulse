import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORICAL_EVENTS, matchPrecedents, computeAftermath, summarizePrecedent } from '../services/precedent-engine.js';

test('library entries are well-formed', () => {
    for (const e of HISTORICAL_EVENTS) {
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.date), `${e.id} has ISO date`);
        assert.ok(e.commodities.length > 0, `${e.id} names commodities`);
        assert.ok(e.keywords.length >= 3, `${e.id} has keywords`);
        assert.ok(e.category, `${e.id} has category`);
    }
});

test('rice export ban matches the 2023 India precedent first', () => {
    const m = matchPrecedents({
        text: 'India announces rice export ban amid domestic shortage',
        category: 'Trade Policy',
    });
    assert.ok(m.length > 0);
    assert.equal(m[0].event.id, 'india-rice-ban-2023');
});

test('Red Sea attack matches the Houthi precedent', () => {
    const m = matchPrecedents({
        text: 'Houthi missile attack forces Red Sea shipping suspension',
        category: 'Maritime Security',
    });
    assert.ok(m.length > 0);
    assert.equal(m[0].event.id, 'red-sea-attacks-2023');
});

test('unrelated text matches nothing', () => {
    const m = matchPrecedents({ text: 'Local bakery wins sourdough award', category: null });
    assert.equal(m.length, 0);
});

test('commodity named in text is enough to reach threshold with keywords', () => {
    const m = matchPrecedents({
        text: 'Severe frost damages coffee crop in Brazil, arabica supply at risk',
        category: 'Agricultural Crisis',
    });
    assert.ok(m.length > 0);
    assert.equal(m[0].event.id, 'brazil-coffee-frost-2021');
});

test('computeAftermath measures the move from the event date', () => {
    // 120 daily bars: flat at 100 before the event, then a ramp to 130 by day 30, easing to 120 by day 90
    const bars = [];
    const t0 = new Date('2023-01-01');
    for (let d = -10; d <= 100; d++) {
        const date = new Date(t0.getTime() + d * 86400e3);
        let close = 100;
        if (d > 0 && d <= 30) close = 100 + d;               // ramp to 130
        else if (d > 30) close = 130 - (d - 30) * (10 / 60); // ease to ~120
        bars.push({ date, close });
    }
    const a = computeAftermath(bars, '2023-01-01');
    assert.ok(a, 'aftermath computed');
    assert.ok(Math.abs(a.pct30 - 30) <= 1.5, `pct30 ~ +30, got ${a.pct30}`);
    assert.ok(a.extremePct >= 29, `extreme captures the peak, got ${a.extremePct}`);
    assert.ok(a.daysToExtreme >= 28 && a.daysToExtreme <= 32, `peak near day 30, got ${a.daysToExtreme}`);
});

test('computeAftermath returns null on insufficient data', () => {
    assert.equal(computeAftermath([], '2023-01-01'), null);
    assert.equal(computeAftermath([{ date: '2023-01-01', close: 5 }], '2023-01-01'), null);
});

test('computeAftermath captures a slide as the dominant excursion', () => {
    const bars = [];
    const t0 = new Date('2023-01-01');
    for (let d = -10; d <= 100; d++) {
        bars.push({ date: new Date(t0.getTime() + d * 86400e3), close: d <= 0 ? 100 : Math.max(70, 100 - d) });
    }
    const a = computeAftermath(bars, '2023-01-01');
    assert.ok(a.extremePct <= -25, `dominant move is the drop, got ${a.extremePct}`);
});

test('summarizePrecedent renders a planner-readable line', () => {
    const past = HISTORICAL_EVENTS.find(e => e.id === 'india-rice-ban-2023');
    const s = summarizePrecedent(past, 'RICE', { pct7: 5.2, pct30: 12.1, pct90: 2.3, extremePct: 18.4, daysToExtreme: 42, basePrice: 13.2, baseDate: '2023-07-20' });
    assert.match(s, /India bans non-basmati rice/);
    assert.match(s, /\+12\.1% in 1 month/);
    assert.match(s, /day 42/);
    assert.ok(!s.includes('σ'));
});
