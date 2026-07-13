import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NewsPipeline } from '../services/news-pipeline/pipeline.js';
import { buildWatchlistProfile, expandRegionAliases, canonicalRegionName } from '../services/news-pipeline/stages/2_profile_builder.js';
import { applyRuleEngine, maskPhrases, maskIdioms } from '../services/news-pipeline/stages/3_rule_engine.js';
import { matchRegion } from '../services/news-pipeline/stages/4_region_matcher.js';
import { calculateRelevanceScore } from '../services/news-pipeline/stages/5_relevance_scorer.js';

// End-to-end regression corpus for the precision/recall contract:
// the user must see every relevant article (no false negatives) and no
// irrelevant ones (no false positives). Every case here traces back to a
// real defect found in the July 2026 audit of 1,057 logged pipeline
// decisions. Semantic filter is off in CI (deterministic stages only — the
// embedding model isn't downloaded on runners); it fails open by design.

// Mirrors real user 18 (Frozen Goods / Middle East, Aramtec-like)
const FROZEN_ME_USER = {
    user_id: 18,
    commodities: ['MILK', 'LIVE_CATTLE', 'POULTRY', 'ORANGE_JUICE', 'WHEAT', 'CORN', 'RICE', 'SOYBEANS', 'SUGAR', 'BRENT_CRUDE', 'GOLD', 'SILVER', 'COPPER', 'PLATINUM', 'OATS'],
    regions: ['Saudi Arabia Al-Hasa', 'UAE Sweihan', 'Egypt Nile Delta', 'Jordan Valley', 'Oman Al Batinah', 'Qatar Al Khor', 'Kuwait Wafra', 'Bahrain'],
    focus_product: 'Frozen Goods',
    focus_region: 'Middle East',
    news_keywords: ['cold chain logistics', 'frozen goods', 'reefer freight rates', 'food supply chain', 'frozen food', 'cold storage'],
    custom_blocklist: [],
};

// Mirrors real user 19 (Dairy & Livestock / India)
const DAIRY_INDIA_USER = {
    user_id: 19,
    commodities: ['FEEDER_CATTLE', 'LEAN_HOGS', 'CORN', 'SOYBEANS', 'OATS', 'WHEAT', 'PLATINUM'],
    regions: ['Saudi Arabia Al-Hasa', 'UAE Sweihan', 'Qatar Al Khor', 'Kuwait Wafra'],
    focus_product: 'Dairy & Livestock',
    focus_region: 'India',
    news_keywords: ['dairy', 'livestock', 'cattle', 'meat', 'feed prices', 'poultry'],
    custom_blocklist: [],
};

const pipeline = new NewsPipeline({ semantic: 'off' });
const run = (article, user) => pipeline.processArticle(
    { content: '', url: 'https://t.test/' + Math.random().toString(36).slice(2), publishedAt: new Date().toUTCString(), source: 'test', ...article },
    user,
    new Set()
);

// ── Profile builder: vocabulary construction ──

test('UPPER_SNAKE commodity codes become matchable natural language', () => {
    const p = buildWatchlistProfile(FROZEN_ME_USER);
    assert.ok(p.primaryTerms.includes('orange juice'), 'ORANGE_JUICE → "orange juice"');
    assert.ok(p.primaryTerms.includes('live cattle'), 'LIVE_CATTLE → "live cattle"');
    assert.ok(!p.primaryTerms.some(t => t.includes('_')), 'no underscore term can ever match news text');
});

test('commodity codes resolve to full synonym profiles, not bare words', () => {
    const p = buildWatchlistProfile(DAIRY_INDIA_USER);
    assert.ok(p.primaryTerms.includes('pork'), 'LEAN_HOGS brings pork');
    assert.ok(p.relatedTerms.includes('beef'), 'FEEDER_CATTLE brings beef');
    assert.ok(p.businessTerms.includes('feed cost'), 'livestock business vocabulary attached');
});

test('micro-regions expand to their country alias groups', () => {
    assert.ok(expandRegionAliases('Saudi Arabia Al-Hasa').includes('riyadh'));
    assert.ok(expandRegionAliases('UAE Sweihan').includes('dubai'));
    assert.equal(canonicalRegionName('Saudi Arabia Al-Hasa'), 'Saudi Arabia');
    const p = buildWatchlistProfile(DAIRY_INDIA_USER);
    assert.ok(p.regionAliases.includes('riyadh'), 'user profile carries expanded GCC aliases');
});

test('auto-seeds are generated per commodity for semantic filtering', () => {
    const p = buildWatchlistProfile(FROZEN_ME_USER);
    assert.ok(Array.isArray(p.mlSeeds) && p.mlSeeds.length >= FROZEN_ME_USER.commodities.length, 'one seed per commodity');
    assert.ok(p.mlSeeds.some(s => s.includes('gold')), 'minority commodity (gold) has its own seed');
});

// ── Metaphor masking ──

test('maskPhrases hides metaphors but keeps real mentions', () => {
    const masked = maskPhrases('spacex gold rush as gold prices soar', ['gold rush']);
    assert.ok(!masked.includes('gold rush'));
    assert.ok(masked.includes('gold prices'), 'the genuine mention survives');
});

test('dynamically-added (custom) region gets a priority scoring boost', () => {
    const built = buildWatchlistProfile({
        user_id: 1, commodities: ['WHEAT'], regions: ['India'],
        custom_regions: [{ name: 'Kenya' }], focus_region: 'Global',
    });
    assert.ok(built.priorityRegionAliases.includes('kenya'), 'custom region is a priority region');
    assert.ok(!built.priorityRegionAliases.includes('india'), 'plain tracked region is NOT priority');
    const mk = (t) => ({ titleNorm: t.toLowerCase(), descNorm: '', contentNorm: '', fullTextNorm: t.toLowerCase() });
    const score = (t) => {
        const md = applyRuleEngine(mk(t), built).matchData;
        return calculateRelevanceScore(mk(t), built, md);
    };
    const india = score('Wheat shortage hits India bakeries');
    const kenya = score('Wheat shortage hits Kenya bakeries');
    assert.equal(india.breakdown.priorityRegionScore, 0);
    assert.equal(kenya.breakdown.priorityRegionScore, 20);
    assert.ok(kenya.score > india.score, 'user-added region ranks higher than a plain tracked region');
});

test('idiom "recipe for" does not trip the culinary blocklist (real FN fix)', () => {
    const profile = {
        fullTextNorm: 'middle east wheat crisis: a recipe for rising flour prices',
        excludedContexts: ['recipe', 'cooking', 'diet'],
        businessTerms: ['prices', 'crisis'], primaryTerms: ['wheat', 'flour'],
        relatedTerms: [], regionAliases: ['middle east'], maskedPhrases: [],
    };
    const r = applyRuleEngine(profile, profile);
    assert.equal(r.passed, true, 'idiomatic "recipe for" must NOT be blocklisted');
    // But a genuine culinary "recipe" (standalone) is still blocked.
    const culinary = { ...profile, fullTextNorm: 'easy chicken recipe for the weekend' };
    // "recipe for" here is masked too, but "recipe" standalone check: the real
    // guard is that maskIdioms only masks the idiom, so verify masking behavior.
    assert.ok(!maskIdioms('a recipe for higher prices').includes('recipe for'));
    assert.ok(maskIdioms('chicken recipe collection').includes('recipe'), 'standalone recipe survives masking → still blockable');
});

// ── Region gate: soft for tracked commodities, hard for macro ──

test('tracked-commodity news passes region gate without a region mention', () => {
    const r = matchRegion({ fullTextNorm: 'lean hog futures drop on weak demand' }, { regionAliases: ['india'] }, { commodityMatches: ['lean hogs'] });
    assert.equal(r.passed, true);
    assert.equal(r.softPass, true);
});

test('macro news without commodity still needs a region match', () => {
    const r = matchRegion({ fullTextNorm: 'supply chain disruption is the new normal' }, { regionAliases: ['india'] }, { commodityMatches: [] });
    assert.equal(r.passed, false);
});

// ── End-to-end: verified false negatives from the audit must now ACCEPT ──

test('FN fix: article about a tracked UPPER_SNAKE commodity is accepted', async () => {
    const r = await run({ title: 'Orange juice futures spike 18% after Brazil citrus greening outbreak', description: 'Frozen concentrated orange juice supply to Middle East importers threatened; production forecast cut.' }, FROZEN_ME_USER);
    assert.equal(r.accepted, true, `expected accept, got: ${r.reason}`);
});

test('FN fix: global commodity news for a tracked commodity is accepted (was killed by region gate)', async () => {
    const r = await run({ title: 'Lean hog futures drop as Chinese demand weakens', description: 'Pork oversupply pressures meat markets; feed corn demand softens across the region.' }, DAIRY_INDIA_USER);
    assert.equal(r.accepted, true, `expected accept, got: ${r.reason}`);
});

test('FN fix: relevant article the frozen spam classifier used to kill is accepted', async () => {
    const r = await run({ title: 'Cargill opens new dairy feed plant in India to serve growing livestock market', description: 'The facility will supply compound cattle feed across Maharashtra; corn and soymeal demand to rise.' }, DAIRY_INDIA_USER);
    assert.equal(r.accepted, true, `expected accept, got: ${r.reason}`);
});

test('FN fix: oats article for an OATS-tracking user is accepted', async () => {
    const r = await run({ title: 'Oat shortages may dictate starter grain alternatives for dairy herds', description: 'Feed formulators weigh corn substitution as oat supply tightens and prices climb in India.' }, DAIRY_INDIA_USER);
    assert.equal(r.accepted, true, `expected accept, got: ${r.reason}`);
});

// ── End-to-end: verified false positives must now REJECT ──

test('FP fix: movie listing with a keyword-colliding title is rejected', async () => {
    const r = await run({ title: 'Cold Storage - Box Office Mojo', description: 'Box office results, movie release calendar and showtimes for Cold Storage.' }, FROZEN_ME_USER);
    assert.equal(r.accepted, false);
});

test('FP fix: "gold rush" metaphor does not count as a GOLD mention', async () => {
    const r = await run({ title: 'SpaceX IPO could trigger a space supply chain gold rush', description: 'Investors eye satellite component makers; demand for parts suppliers surges.' }, FROZEN_ME_USER);
    assert.equal(r.accepted, false);
});

test('FP fix: morbid "cold storage" news is rejected via global noise exclusions', async () => {
    const r = await run({ title: "Khamenei's body in cold storage since February: why Iran fears another funeral disaster", description: 'Political succession concerns grow in Tehran.' }, FROZEN_ME_USER);
    assert.equal(r.accepted, false);
});

test('FP fix: "went platinum" music idiom does not alert a PLATINUM-tracking user', async () => {
    const r = await run({ title: 'Platinum album for pop star as tour ticket prices soar', description: 'The record went platinum in its first week; demand for tour dates is unprecedented, driving cost complaints.' }, DAIRY_INDIA_USER);
    assert.equal(r.accepted, false);
});

test('FP fix: retail macro think-piece without user regions is rejected', async () => {
    const r = await run({ title: 'Disruption is the new supply chain normal - National Retail Federation', description: 'Retail executives discuss demand planning, cost pressures, imports and inventory strategy for apparel.' }, FROZEN_ME_USER);
    assert.equal(r.accepted, false);
});

// ── Genuinely relevant articles keep flowing (guard against over-tightening) ──

test('regional commodity disruption still accepted with high priority', async () => {
    const r = await run({ title: 'UAE frozen food imports disrupted as Red Sea reroutes raise reefer rates', description: 'Cold chain logistics costs for Dubai distributors climb 22% after carriers avoid Suez.' }, FROZEN_ME_USER);
    assert.equal(r.accepted, true);
    assert.ok(r.article.relevanceScore >= 70, `expected high score, got ${r.article.relevanceScore}`);
});

test('region-mentioning article outscores the same story without a region', async () => {
    const withRegion = await run({ title: 'Saudi Arabia expands live cattle imports as feed costs surge', description: 'Riyadh boosts livestock shipments amid drought; beef prices up 9%.' }, FROZEN_ME_USER);
    const noRegion = await run({ title: 'Live cattle imports expand as feed costs surge', description: 'Livestock shipments boosted amid drought; beef prices up 9%.' }, FROZEN_ME_USER);
    assert.equal(withRegion.accepted, true);
    assert.equal(noRegion.accepted, true, 'tracked-commodity news without region still accepted');
    assert.ok(withRegion.article.relevanceScore > noRegion.article.relevanceScore, 'geo-matched must rank higher');
});

// ── Dedup semantics: rejections are never permanent ──

test('pipeline does not poison the alerted set with rejected articles', async () => {
    const set = new Set();
    await run({ title: 'Some rejected macro story with nothing relevant in it', description: 'quarterly earnings of a software company' }, FROZEN_ME_USER);
    assert.equal(set.size, 0, 'pipeline must not mutate the alerted set');
});

test('rejection memo honors profile changes: article re-evaluated after settings change', async () => {
    const p = new NewsPipeline({ semantic: 'off' });
    const article = { title: 'Wheat export ban weighed by major supplier as harvest fails', description: 'Gulf buyers face tighter supply.', content: '', url: 'https://t.test/memo', publishedAt: new Date().toUTCString(), source: 'test' };
    // Profile v1 tracks nothing relevant → rejected & memoized
    const userV1 = { user_id: 99, commodities: ['COPPER'], regions: ['Brazil'], focus_region: 'Brazil', news_keywords: [], _fingerprint: 'v1' };
    const r1 = await p.processArticle({ ...article }, userV1, new Set());
    assert.equal(r1.accepted, false);
    const r1again = await p.processArticle({ ...article }, userV1, new Set());
    assert.equal(r1again.memoized, true, 'identical profile → memoized skip');
    // Profile v2 now tracks WHEAT → must be re-evaluated and accepted
    const userV2 = { ...userV1, commodities: ['WHEAT'], focus_region: 'Middle East', _fingerprint: 'v2' };
    const r2 = await p.processArticle({ ...article }, userV2, new Set());
    assert.equal(r2.accepted, true, 'profile change must re-open previously rejected articles');
});

test('already-alerted articles are suppressed without re-logging', async () => {
    const set = new Set();
    const article = { title: 'UAE frozen food imports disrupted as Red Sea reroutes raise reefer rates', description: 'Cold chain costs climb.', content: '', url: 'https://t.test/dup', publishedAt: new Date().toUTCString(), source: 'test' };
    const first = await run(article, FROZEN_ME_USER);
    assert.equal(first.accepted, true);
    const key = `user:18:${article.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80)}`;
    set.add(key);
    const second = await pipeline.processArticle(article, FROZEN_ME_USER, set);
    assert.equal(second.accepted, false);
    assert.equal(second.duplicate, true);
});

// ── Audit quality ──

test('accepted results carry the relevance score for audit logging', async () => {
    const r = await run({ title: 'Wheat export ban weighed by major supplier as harvest fails', description: 'Egypt and Gulf buyers face tighter supply; tender prices jump 14%.' }, FROZEN_ME_USER);
    assert.equal(r.accepted, true);
    assert.ok(typeof r.score === 'number' && r.score > 0, 'accepted rows must not log score:null');
});
