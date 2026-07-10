import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundKeyFigures } from '../services/labeling/labelingService.js';

// The anti-hallucination contract: a key_figure may only surface if every
// number in it literally appears in the text the model was shown.

const SOURCE = `U.S. milk production hit a record 19.1 billion pounds in May 2026,
up 2.3% year over year. Class III milk futures fell to $16.40 per hundredweight.
Cheese inventories rose 4% to 1.5 billion pounds.`;

test('figures whose numbers appear in the source are kept', () => {
    const out = groundKeyFigures(
        ['19.1 billion pounds', '+2.3% YoY', '$16.40 per cwt', '1.5 billion pounds'],
        SOURCE
    );
    assert.equal(out.length, 4);
});

test('invented figures are dropped', () => {
    const out = groundKeyFigures(
        ['down 37% since March', '$122 million loss', '19.1 billion pounds'],
        SOURCE
    );
    assert.deepEqual(out, ['19.1 billion pounds']);
});

test('a figure is dropped if ANY of its numbers is not in the source', () => {
    // "19.1" is real but "2019" is invented — mixed claims must die too.
    const out = groundKeyFigures(['19.1 billion pounds since 2019'], SOURCE);
    assert.deepEqual(out, []);
});

test('numberless strings are not figures', () => {
    const out = groundKeyFigures(['record production', 'strong demand'], SOURCE);
    assert.deepEqual(out, []);
});

test('empty/invalid input yields empty array', () => {
    assert.deepEqual(groundKeyFigures(null, SOURCE), []);
    assert.deepEqual(groundKeyFigures(undefined, SOURCE), []);
    assert.deepEqual(groundKeyFigures([], SOURCE), []);
    assert.deepEqual(groundKeyFigures(['5%'], ''), []);
});
