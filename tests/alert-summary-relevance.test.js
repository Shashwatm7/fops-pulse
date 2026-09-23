// tests/alert-summary-relevance.test.js
//
// Guards the check that stops a page's related-news sidebar being summarised
// as though it were the article. Exercises the shipped function directly.
//
// The fixtures below are real: the headlines are alert rows 236656/236701/
// 236718/236720, and the hit counts are what fetchArticleText actually
// returned for each on 2026-09-23. The Hormuz one is the regression — its
// fetch failed with "Parse Error: Header overflow" and returned 2951
// characters of Yahoo Finance sidebar, which the first version of this check
// accepted because the headline contained the word "Stocks".
import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyMatchesHeadline, headlineTerms } from '../services/alert-summary-relevance.js';

const HORMUZ_TITLE =
    '🚨 Maritime Chokepoint: Iran “Offered” to Reopen the Strait of Hormuz. ' +
    'These Stocks Could Be the Biggest Winners - Yahoo Finance';

// Abridged from the 2951 characters actually returned for that URL.
const YAHOO_SIDEBAR =
    '1.   News • 1 hour ago Brent crude oil prices hovered around $96 as analysts ' +
    "warn Trump diesel export ban would 'tighten global supply'\n" +
    '2.   News • 2 hours ago US stocks edged lower as investors eyed the upcoming ' +
    'Trump-Xi meeting\n' +
    '4.   News • 20 hours ago President Trump said Tuesday that he would support ' +
    'banning exports of diesel fuel amid Republicans calls ahead of midterms.\n' +
    "5.   News • 22 hours ago Richmond Fed's Barkin says supply shocks aren't " +
    'proving short-lived, leaves door open to further cuts.';

test('rejects a sidebar that only matches a generic headline word', () => {
    // "stocks" appears — on a finance site it inevitably does. None of
    // hormuz / strait / reopen / offered do.
    assert.equal(bodyMatchesHeadline(HORMUZ_TITLE, YAHOO_SIDEBAR), false);
});

test('the publisher suffix is not treated as subject vocabulary', () => {
    // Without stripping " - Yahoo Finance", "yahoo" and "finance" would match
    // almost any page on that domain and wave the sidebar through.
    const terms = headlineTerms(HORMUZ_TITLE);
    assert.ok(!terms.includes('yahoo'), 'publisher name leaked into terms');
    assert.ok(!terms.includes('finance'), 'publisher name leaked into terms');
    assert.ok(terms.includes('hormuz'), 'real subject term was dropped');
});

test('accepts a genuine body that restates its headline', () => {
    const title = '🚨 Maritime Chokepoint: Shipping traffic via Strait of Hormuz stays below average';
    const body = 'Shipping traffic through the Strait of Hormuz stayed below the '
        + 'seasonal average this week, with transits down on the month.';
    assert.equal(bodyMatchesHeadline(title, body), true);
});

test('the emoji and the category prefix are stripped from the headline', () => {
    const terms = headlineTerms('🎯 Profile Alert: South Korea to Cut Middle East Crude Oil Dependence');
    assert.ok(!terms.includes('profile'), 'category prefix leaked into terms');
    assert.deepEqual(terms, ['south', 'korea', 'middle', 'crude', 'dependence']);
});

test('a terse headline keeps the single-hit bar', () => {
    // Only one distinctive term survives the 5-char filter, so demanding two
    // would reject it no matter what the body said.
    const title = 'WHEAT above threshold';
    assert.deepEqual(headlineTerms(title), ['wheat', 'above', 'threshold']);
    // Three terms -> needs two hits.
    assert.equal(bodyMatchesHeadline(title, 'wheat climbed above the trigger'), true);

    const terse = 'Hormuz closed';
    assert.deepEqual(headlineTerms(terse), ['hormuz', 'closed']);
    assert.equal(bodyMatchesHeadline(terse, 'traffic through hormuz halted'), true);
});

test('a headline with no distinctive terms does not block the body', () => {
    // Nothing to test against — the check must not become a silent reject.
    assert.equal(bodyMatchesHeadline('🎯 Profile Alert:', 'any text at all'), true);
    assert.equal(bodyMatchesHeadline('', 'any text at all'), true);
});

test('empty or missing body is rejected when the headline is specific', () => {
    assert.equal(bodyMatchesHeadline(HORMUZ_TITLE, ''), false);
    assert.equal(bodyMatchesHeadline(HORMUZ_TITLE, null), false);
});
