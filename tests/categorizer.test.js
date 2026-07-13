import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeArticle, CATEGORIES, streamOf } from '../services/news-pipeline/categorizer.js';

test('supply disruption wins over price/other signals (checked first)', () => {
    // Mentions both a blockade (disruption) and prices — disruption must win.
    const c = categorizeArticle('Red Sea blockade sends wheat prices surging');
    assert.equal(c.key, 'supply_disruption');
    assert.equal(c.isDisruption, true);
});

test('attack headline → supply disruption', () => {
    assert.equal(categorizeArticle('Drone attack halts Gulf port operations').key, 'supply_disruption');
});

test('trade policy classified when no disruptor present', () => {
    assert.equal(categorizeArticle('India announces new tariff schedule on edible oil imports').key, 'trade_policy');
});

test('weather/crop classified', () => {
    assert.equal(categorizeArticle('Drought slashes Brazil corn yield forecast').key, 'weather_crop');
});

test('food safety classified', () => {
    assert.equal(categorizeArticle('Poultry recall widens after salmonella outbreak').key, 'food_safety');
});

test('pure price move (no disruptor) → price_move, not disruption', () => {
    const c = categorizeArticle('Wheat futures rally on strong export demand');
    assert.equal(c.key, 'price_move');
    assert.equal(c.isDisruption, false);
});

test('unmatched headline falls back to general', () => {
    const c = categorizeArticle('Company announces new sustainability partnership');
    assert.equal(c.key, 'general');
    assert.equal(c.isDisruption, false);
});

test('every category has key/label/emoji/terms and supply_disruption is first', () => {
    assert.equal(CATEGORIES[0].key, 'supply_disruption');
    for (const c of CATEGORIES) {
        assert.ok(c.key && c.label && c.emoji && Array.isArray(c.terms) && c.terms.length > 0);
    }
});

test('categories split into risk vs commodity streams (never mixed)', () => {
    // Risk stream
    assert.equal(streamOf('supply_disruption'), 'risk');
    assert.equal(streamOf('geopolitical'), 'risk');
    assert.equal(streamOf('trade_policy'), 'risk');
    assert.equal(streamOf('logistics'), 'risk');
    // Commodity stream
    assert.equal(streamOf('weather_crop'), 'commodity');
    assert.equal(streamOf('price_move'), 'commodity');
    assert.equal(streamOf('energy'), 'commodity');
    assert.equal(streamOf('food_safety'), 'commodity');
    assert.equal(streamOf('general'), 'commodity');
    // categorizeArticle surfaces the stream
    assert.equal(categorizeArticle('Missile attack halts Gulf port').stream, 'risk');
    assert.equal(categorizeArticle('Wheat futures rally on demand').stream, 'commodity');
});
