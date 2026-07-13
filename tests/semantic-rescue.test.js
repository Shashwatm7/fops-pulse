import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NewsPipeline } from '../services/news-pipeline/pipeline.js';

// The rescue lane's contract: a keyword-rejected article is saved iff its
// seed similarity is unmistakably high; blocklist kills are never saved;
// embedding failures leave the original rejection standing (fail closed).
// similarityFn is injected so CI never loads the embedding model.

const USER = {
    user_id: 42,
    commodities: ['WHEAT', 'CORN'],
    regions: ['UAE Sweihan'],
    focus_product: 'Frozen Goods',
    focus_region: 'Middle East',
    news_keywords: [],
    custom_blocklist: ['recipe'],
    ml_seeds: ['Houthi attacks force shipping lines to reroute via Cape of Good Hope'],
};

// No tracked keyword anywhere in this text → dies at stage 3 without rescue.
const HORMUZ_ARTICLE = {
    title: 'Iran ready to escalate over Hormuz, officials warn',
    description: 'Tehran signals it could close the strait to tanker traffic within days.',
    content: '',
    url: 'https://t.test/hormuz',
    publishedAt: new Date().toUTCString(),
    source: 'test',
};

const makePipeline = (similarityFn, rescueThreshold = 0.5) =>
    new NewsPipeline({ similarityFn, rescueThreshold });

test('high-similarity keyword-rejected article is rescued with derived score', async () => {
    const p = makePipeline(async () => 0.68);
    const res = await p.processArticle(HORMUZ_ARTICLE, USER, new Set());
    assert.equal(res.accepted, true);
    assert.equal(res.score, 68, 'score = similarity × 100');
    assert.equal(res.article.priority, 'Medium', '68 buckets to Medium');
    assert.equal(res.article.breakdown.semanticRescue, true);
    assert.match(res.reason, /Semantic rescue/);
    assert.match(res.article.llmReason, /by meaning/);
});

test('rescue score floors at Medium — a rescue must be alertable', async () => {
    // Realistic similarity (calibration: relevant rescues sit ~0.40-0.55).
    // Raw ×100 would be Low priority = accepted but never alerted, which
    // defeats the point of rescuing.
    const p = makePipeline(async () => 0.42, 0.4);
    const res = await p.processArticle(HORMUZ_ARTICLE, USER, new Set());
    assert.equal(res.accepted, true);
    assert.equal(res.score, 60, 'floored to the Medium bucket');
    assert.equal(res.article.priority, 'Medium');
});

test('below-threshold similarity leaves the keyword rejection standing', async () => {
    const p = makePipeline(async () => 0.42);
    const res = await p.processArticle(HORMUZ_ARTICLE, USER, new Set());
    assert.equal(res.accepted, false);
    assert.equal(res.stage, 3);
});

test('rescue score is capped below Critical', async () => {
    const p = makePipeline(async () => 0.99);
    const res = await p.processArticle(HORMUZ_ARTICLE, USER, new Set());
    assert.equal(res.accepted, true);
    assert.equal(res.score, 84, 'semantic-only match cannot reach the Critical bucket (>=85)');
    assert.equal(res.article.priority, 'High');
});

test('blocklist kills are never rescued, even at similarity 0.99', async () => {
    let called = 0;
    const p = makePipeline(async () => { called++; return 0.99; });
    const blocked = { ...HORMUZ_ARTICLE, url: 'https://t.test/blocked', title: 'Hormuz crisis recipe for wheat market chaos' };
    const res = await p.processArticle(blocked, USER, new Set());
    assert.equal(res.accepted, false);
    assert.match(res.reason, /excluded context/i);
    assert.equal(called, 0, 'similarity must not even be consulted for blocklist kills');
});

test('embedding failure fails closed: rejection stands', async () => {
    const p = makePipeline(async () => { throw new Error('model unavailable'); });
    const res = await p.processArticle(HORMUZ_ARTICLE, USER, new Set());
    assert.equal(res.accepted, false);
    assert.equal(res.stage, 3);
});

test('semantic off disables the rescue lane entirely', async () => {
    let called = 0;
    const p = new NewsPipeline({ semantic: 'off', similarityFn: async () => { called++; return 0.99; } });
    const res = await p.processArticle(HORMUZ_ARTICLE, USER, new Set());
    assert.equal(res.accepted, false);
    assert.equal(called, 0);
});

test('null similarity (profile without seeds) declines rescue', async () => {
    const p = makePipeline(async () => null);
    const res = await p.processArticle(HORMUZ_ARTICLE, { ...USER, ml_seeds: [] }, new Set());
    assert.equal(res.accepted, false);
});

test('failed rescue is memoized: second scan skips recompute', async () => {
    let called = 0;
    const p = makePipeline(async () => { called++; return 0.42; });
    await p.processArticle(HORMUZ_ARTICLE, USER, new Set());
    const again = await p.processArticle(HORMUZ_ARTICLE, USER, new Set());
    assert.equal(again.memoized, true);
    assert.equal(called, 1, 'similarity embedded once, not per scan');
});
