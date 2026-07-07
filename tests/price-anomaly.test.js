import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePriceSeries, describeAnomaly, anomalyRelevanceScore } from '../services/price-anomaly.js';

// Calm series: ~0.5% alternating daily moves around $100 with a slight drift
const calm = Array.from({ length: 100 }, (_, i) => 100 + (i % 2 === 0 ? 0.5 : -0.5) + i * 0.01);
const last = calm.at(-1);

test('normal day produces no findings', () => {
    assert.deepEqual(analyzePriceSeries(calm, last * 1.004, last * 1.001, last), []);
});

test('too-short history produces no findings', () => {
    assert.deepEqual(analyzePriceSeries(calm.slice(0, 10), 200), []);
});

test('genuine crisis with same-contract prevClose fires CRITICAL sigma move', () => {
    const findings = analyzePriceSeries(calm, last * 1.04, last * 1.01, last);
    const sigma = findings.find(f => f.type === 'sigma-move-up');
    assert.ok(sigma, 'expected sigma-move-up');
    assert.equal(sigma.severity, 'CRITICAL');
});

test('genuine crisis on fallback path (gap + intraday run) still fires', () => {
    const findings = analyzePriceSeries(calm, last * 1.04, last * 1.015, null);
    assert.ok(findings.some(f => f.type === 'sigma-move-up'));
});

test('contract roll with same-contract prevClose produces no sigma move', () => {
    // Continuous series shows +16% (roll gap) but the contract itself moved +0.7%
    const findings = analyzePriceSeries(calm, last * 1.16, null, (last * 1.16) / 1.007);
    assert.ok(!findings.some(f => f.type.startsWith('sigma-move')), 'roll must not fire a sigma move');
});

test('unverifiable overnight jump (no prevClose, no open) is suppressed', () => {
    // The July 2026 incident: OATS "+16.85%" during Globex with no session refs
    assert.deepEqual(analyzePriceSeries(calm, last * 1.168, null, null), []);
});

test('roll signature: moderate gap with dead session is suppressed (fallback path)', () => {
    const findings = analyzePriceSeries(calm, last * 1.033, last * 1.035, null);
    assert.ok(!findings.some(f => f.type.startsWith('sigma-move')));
});

test('materiality floor: sub-1.5% move never fires regardless of sigma', () => {
    // Illiquid contract: near-zero MAD would produce a huge z on a 0.6% move
    const flat = Array.from({ length: 100 }, (_, i) => 100 + (i % 10 === 0 ? 0.05 : 0));
    assert.deepEqual(analyzePriceSeries(flat, 100.6, 100.55, 100.0), []);
});

test('volatility regime shift detected', () => {
    const violent = [...calm.slice(0, 93), 101, 105, 99, 106, 98, 107, 100];
    const findings = analyzePriceSeries(violent, 100.2, 100.1, 100);
    assert.ok(findings.some(f => f.type === 'vol-regime'));
});

test('describeAnomaly renders planner-friendly text without statistics jargon', () => {
    const [finding] = analyzePriceSeries(calm, last * 1.04, last * 1.01, last);
    const d = describeAnomaly(finding, 'WHEAT', 6.32, 'USD/bushel');
    assert.match(d.title, /WHEAT/);
    assert.match(d.reason, /typical daily move/);
    assert.ok(!d.title.includes('σ') && !d.reason.includes('σ'), 'no sigma symbol in user-facing text');
    assert.ok(!/anomal/i.test(d.title), 'title avoids "anomaly" jargon');
});

test('relevance score increases with z-score magnitude', () => {
    const small = anomalyRelevanceScore({ type: 'sigma-move-up', zScore: 2.6 });
    const big = anomalyRelevanceScore({ type: 'sigma-move-up', zScore: 6 });
    assert.ok(big > small);
    assert.ok(big <= 100);
});
