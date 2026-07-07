import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreAlertExposure, severityFromScore, severityFromPriority } from '../services/alert-relevance.js';

const gccFrozen = {
    commodities: ['MILK', 'LIVE_CATTLE', 'ORANGE_JUICE', 'WHEAT', 'CORN', 'RICE', 'SOYBEANS', 'SUGAR', 'BRENT_CRUDE'],
    regions: ['Saudi Arabia Al-Hasa', 'UAE Sweihan', 'Egypt Nile Delta'],
    focus_region: 'Middle East',
    focus_countries: ['UAE', 'Saudi Arabia', 'Qatar'],
};

const usMetals = {
    commodities: ['COPPER', 'ALUMINUM', 'GOLD', 'SILVER'],
    regions: [],
    focus_region: 'Global',
    focus_countries: ['China', 'USA', 'Chile'],
};

const recent = new Date(Date.now() - 2 * 3600e3);

test('Red Sea chokepoint alerts a GCC-focused profile', () => {
    const r = scoreAlertExposure(
        { text: 'Houthi missile attack forces Red Sea shipping suspension', category: 'Maritime Security', publishedAt: recent },
        gccFrozen
    );
    assert.ok(severityFromScore(r.score), 'expected an alert');
    assert.ok(r.score >= 50, `expected >= HIGH, got ${r.score}`);
});

test('Red Sea chokepoint does NOT alert a metals-only profile', () => {
    const r = scoreAlertExposure(
        { text: 'Houthi missile attack forces Red Sea shipping suspension', category: 'Maritime Security', publishedAt: recent },
        usMetals
    );
    assert.equal(severityFromScore(r.score), null);
});

test('commodity keys match with word boundaries (LIVE_CATTLE -> "live cattle")', () => {
    const r = scoreAlertExposure(
        { text: 'Live cattle futures surge on tight beef supply', category: 'Agricultural Crisis', publishedAt: recent },
        gccFrozen
    );
    assert.ok(r.matchedCommodities.includes('live cattle'));
});

test('substring false positives are rejected ("rice" inside "prices")', () => {
    const r = scoreAlertExposure(
        { text: 'Copper prices dip on demand worries', category: 'Political Instability', publishedAt: recent },
        gccFrozen
    );
    assert.ok(!r.matchedCommodities.includes('rice'));
});

test('non-systemic event with zero profile exposure is filtered', () => {
    const r = scoreAlertExposure(
        { text: 'Chile copper mine strike enters second week', category: 'Labor Disruption', publishedAt: recent },
        gccFrozen
    );
    assert.equal(r.score, 0);
});

test('livestock pandemic implicates protein trackers without naming a commodity', () => {
    const r = scoreAlertExposure(
        { text: 'Bird flu outbreak triggers mass culling across poultry farms', category: 'Livestock Pandemic', publishedAt: recent },
        gccFrozen
    );
    assert.ok(severityFromScore(r.score), 'dairy/cattle tracker should be alerted');
    const rMetals = scoreAlertExposure(
        { text: 'Bird flu outbreak triggers mass culling across poultry farms', category: 'Livestock Pandemic', publishedAt: recent },
        usMetals
    );
    assert.equal(rMetals.score, 0);
});

test('severityFromScore boundaries', () => {
    assert.equal(severityFromScore(70), 'CRITICAL');
    assert.equal(severityFromScore(50), 'HIGH');
    assert.equal(severityFromScore(30), 'MEDIUM');
    assert.equal(severityFromScore(29), null);
});

test('severityFromPriority maps pipeline buckets', () => {
    assert.equal(severityFromPriority('Critical'), 'CRITICAL');
    assert.equal(severityFromPriority('Low'), 'LOW');
    assert.equal(severityFromPriority('Unknown'), 'MEDIUM');
});
