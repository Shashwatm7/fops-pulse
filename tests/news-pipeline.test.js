import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRegion } from '../services/news-pipeline/stages/4_region_matcher.js';
import { classifyPriority } from '../services/news-pipeline/stages/8_priority_classifier.js';

// ── Stage 4: region matcher word-boundary fix ──

test('region matcher does NOT match "india" inside "indiana"', () => {
    const article = { fullTextNorm: 'indiana corn harvest hits record levels this autumn' };
    const profile = { regionAliases: ['india'] };
    const r = matchRegion(article, profile);
    assert.equal(r.passed, false, '"indiana" must not satisfy an "india" region filter');
});

test('region matcher matches a real "india" mention, including possessive', () => {
    const article = { fullTextNorm: "india's wheat export policy shifts again" };
    const profile = { regionAliases: ['india'] };
    const r = matchRegion(article, profile);
    assert.equal(r.passed, true);
    assert.deepEqual(r.regionMatches, ['india']);
});

test('region matcher matches multi-word aliases', () => {
    const article = { fullTextNorm: 'tensions rise across the middle east shipping lanes' };
    const profile = { regionAliases: ['middle east'] };
    assert.equal(matchRegion(article, profile).passed, true);
});

test('region matcher auto-passes Global / empty profiles', () => {
    assert.equal(matchRegion({ fullTextNorm: 'anything' }, { regionAliases: [] }).passed, true);
    assert.equal(matchRegion({ fullTextNorm: 'anything' }, { regionAliases: ['global'] }).passed, true);
});

// ── Stage 8: priority now honestly reflects score (no hardcoded Medium) ──

test('priority ladder maps scores to distinct buckets', () => {
    assert.equal(classifyPriority(90), 'Critical');
    assert.equal(classifyPriority(72), 'High');
    assert.equal(classifyPriority(62), 'Medium');
    assert.equal(classifyPriority(45), 'Low');
    assert.equal(classifyPriority(27), 'Ignored');
});

test('borderline scores 27 and 74 no longer collapse to the same label', () => {
    // Previously both were forced to 'Medium' by a hardcoded llmResult.
    // With llmResult null, the ladder distinguishes them honestly.
    assert.notEqual(classifyPriority(27, null), classifyPriority(74, null));
    assert.equal(classifyPriority(74, null), 'High');
    assert.equal(classifyPriority(27, null), 'Ignored');
});

test('classifyPriority still honors an explicit LLM impact when provided', () => {
    // The extension point remains for if/when LLM verification is re-enabled.
    assert.equal(classifyPriority(20, { impact: 'Critical' }), 'Critical');
});
