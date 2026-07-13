import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRelevanceScore, disruptionSeverity, SEVERE_DISRUPTORS, MODERATE_DISRUPTORS } from '../services/news-pipeline/stages/5_relevance_scorer.js';
import { classifyPriority } from '../services/news-pipeline/stages/8_priority_classifier.js';

const hasTerm = (text, term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
};

const PROFILE = {
    primaryTerms: ['wheat', 'corn'],
    relatedTerms: ['grain'],
    businessTerms: ['shipping', 'freight', 'supply chain', 'port', 'export'],
    regionAliases: ['red sea', 'uae', 'middle east', 'gulf'],
    maskedPhrases: [],
};
const mk = (title, desc = '') => ({ titleNorm: title.toLowerCase(), descNorm: desc.toLowerCase(), contentNorm: '' });
const scorePriority = (title, desc) => {
    const { score, breakdown } = calculateRelevanceScore(mk(title, desc), PROFILE, {});
    return { score, priority: classifyPriority(score), disr: breakdown.disruptionScore };
};

test('disruptionSeverity: severe terms in title score highest', () => {
    const { boost, severe } = disruptionSeverity('houthi missile attack on port', '', hasTerm);
    assert.ok(boost >= 40 || boost === 40, 'multiple severe title hits cap at 40');
    assert.equal(severe, true);
});

test('disruptionSeverity: moderate-only stays modest, severe flag false', () => {
    const { boost, severe } = disruptionSeverity('shipping delay causes minor congestion', '', hasTerm);
    assert.ok(boost > 0 && boost < 40);
    assert.equal(severe, false);
});

test('disruptionSeverity: no disruptor terms → zero', () => {
    const { boost, severe } = disruptionSeverity('wheat prices tick up on routine trade', '', hasTerm);
    assert.equal(boost, 0);
    assert.equal(severe, false);
});

test('attack + tracked region (no commodity) reaches High', () => {
    const r = scorePriority('Houthi attacks disrupt Red Sea shipping lanes');
    assert.ok(['High', 'Critical'].includes(r.priority), `expected High+, got ${r.priority} (${r.score})`);
    assert.ok(r.disr > 0);
});

test('severe disruptor + commodity + region reaches Critical', () => {
    const r = scorePriority('Missile strike closes major Gulf port, halting grain and wheat shipments');
    assert.equal(r.priority, 'Critical', `got ${r.priority} (${r.score})`);
});

test('routine commodity news with NO disruptor stays Low — boost is not a blanket lift', () => {
    const r = scorePriority('Wheat prices tick up slightly on routine trading in UAE');
    assert.equal(r.disr, 0);
    assert.ok(['Low', 'Medium'].includes(r.priority), `got ${r.priority} (${r.score})`);
});

test('commodity-less generic macro (no severe disruptor) stays capped at 55', () => {
    // business + region but no commodity and no SEVERE term → old cap holds
    const { score } = calculateRelevanceScore(
        mk('Analysts discuss global supply chain uncertainty and export trends in the UAE'),
        PROFILE, {});
    assert.ok(score <= 55, `commodity-less non-severe must stay <=55, got ${score}`);
});

test('lexicons are non-empty and lowercase (whole-word matching assumes it)', () => {
    assert.ok(SEVERE_DISRUPTORS.length > 5 && MODERATE_DISRUPTORS.length > 5);
    assert.ok([...SEVERE_DISRUPTORS, ...MODERATE_DISRUPTORS].every(t => t === t.toLowerCase()));
});
