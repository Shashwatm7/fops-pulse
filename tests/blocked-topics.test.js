// tests/blocked-topics.test.js
//
// Every multi-word entry in a profile's blocked_topics used to be inert.
// Stage 3 matched them as literal adjacent phrases, so a profile blocking
// "tourism leisure" needed those two words side by side — which no headline
// writes. Measured on the live aramtec_001 profile (2026-09-28): tourism was
// explicitly blocked and "Dubai hotel occupancy climbs to 66% in August as
// tourism picks up" passed the blocklist anyway, then was accepted downstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRuleEngine, hasBlockedTopic } from '../services/news-pipeline/stages/3_rule_engine.js';

test('a multi-word topic matches when its words are reordered', () => {
    // The exact failure: profile said "real estate residential", print says
    // "residential real estate".
    assert.equal(hasBlockedTopic('dubai residential real estate prices hit a record', 'real estate residential'), true);
});

test('a multi-word topic matches when its words are separated', () => {
    assert.equal(hasBlockedTopic('leisure and business travel demand recovered', 'leisure travel'), true);
});

test('the verbatim phrase still matches', () => {
    assert.equal(hasBlockedTopic('a glowing movie review ran today', 'movie review'), true);
});

test('a multi-word topic does not match on one word alone', () => {
    // "hotel occupancy" must not fire on an article that merely says hotel.
    assert.equal(hasBlockedTopic('hotel chain signs beef supply contract', 'hotel occupancy'), false);
});

test('single-word topics are unchanged', () => {
    assert.equal(hasBlockedTopic('manchester united sign striker', 'sports'), false);
    assert.equal(hasBlockedTopic('the new sports season begins', 'sports'), true);
});

test('short connective words cannot carry a match alone', () => {
    // "of"/"in" are dropped, so the topic still needs its meaningful words.
    assert.equal(hasBlockedTopic('the price of wheat in europe rose', 'box office'), false);
});

test('the tourism article that reached production is now blocked', () => {
    const profile = {
        excludedContexts: ['sports', 'tourism', 'hotel occupancy'],
        businessTerms: ['prices', 'demand'],
        primaryTerms: ['chicken', 'beef'],
        relatedTerms: [], maskedPhrases: [],
    };
    const text = 'dubai hotel occupancy climbs to 66% in august as tourism picks up. hotel demand and room prices rose.';
    const r = applyRuleEngine({ fullTextNorm: text }, profile);
    assert.equal(r.passed, false);
    assert.match(r.reason, /Matched excluded context/);
});

test('a genuine supply article is not blocked by a topic that shares a word', () => {
    // Guard against the all-words rule over-blocking: this names a hotel
    // customer but is a cold-chain story, and "hotel occupancy" needs both.
    const profile = {
        excludedContexts: ['tourism', 'hotel occupancy', 'residential real estate'],
        businessTerms: ['prices', 'supply'],
        primaryTerms: ['chicken'],
        relatedTerms: [], maskedPhrases: [],
    };
    const text = 'cold chain failure spoils chicken supply to a hotel group, prices rise';
    const r = applyRuleEngine({ fullTextNorm: text }, profile);
    assert.equal(r.passed, true, 'over-blocked a real supply article');
});

test('a commodity phrase containing a culinary word survives the blocklist', () => {
    // "Palm oil export levy raised, lifting cooking oil costs" was rejected on
    // the bare "cooking" entry in the fallback profile — an edible-oils price
    // story killed by the recipe filter.
    const profile = {
        excludedContexts: ['recipes', 'cooking', 'diet'],
        businessTerms: ['costs', 'prices'], primaryTerms: ['palm oil'],
        relatedTerms: [], maskedPhrases: [],
    };
    const r = applyRuleEngine(
        { fullTextNorm: 'palm oil export levy raised, lifting cooking oil costs' }, profile);
    assert.equal(r.passed, true, 'edible-oils article blocked by the culinary filter');
});

test('a genuine culinary article is still blocked', () => {
    const profile = {
        excludedContexts: ['recipes', 'cooking', 'diet'],
        businessTerms: ['costs'], primaryTerms: ['palm oil'],
        relatedTerms: [], maskedPhrases: [],
    };
    const r = applyRuleEngine(
        { fullTextNorm: 'cooking tips: five ways to use palm oil at home' }, profile);
    assert.equal(r.passed, false);
});
