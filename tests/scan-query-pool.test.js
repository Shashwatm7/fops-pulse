// tests/scan-query-pool.test.js
//
// A tracked commodity must actually reach the search. Before reserved slots,
// the scanner shuffled all four query sources together and took 20 — and with
// 63 keywords and 16 regions against 2 commodities, the commodities usually
// lost. Observed on dev 2026-09-28: a profile tracking Wheat and Corn ran 20
// queries containing neither word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectScanQueries } from '../services/scan-query-pool.js';

// A fixed sequence stands in for Math.random so a "did the commodity survive
// the shuffle" test cannot pass or fail by luck.
const seeded = (seed) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};

const keywords = (n) => Array.from({ length: n }, (_, i) => `keyword-${i} UAE`);
const REAL_SHAPE = {
    commodityQueries: [
        'WHEAT supply chain OR logistics UAE',
        'WHEAT AND (price OR futures)',
        'CORN supply chain OR logistics UAE',
        'CORN AND (price OR futures)',
    ],
    otherQueries: keywords(63).concat(Array.from({ length: 16 }, (_, i) => `region-${i} supply chain`)),
};

test('the exact dev case: 2 commodities against 79 other queries all survive', () => {
    const picked = selectScanQueries(REAL_SHAPE, 20, seeded(7));
    const wheat = picked.filter((q) => q.startsWith('WHEAT'));
    const corn = picked.filter((q) => q.startsWith('CORN'));
    assert.equal(wheat.length, 2, 'wheat queries dropped');
    assert.equal(corn.length, 2, 'corn queries dropped');
    assert.equal(picked.length, 20);
});

test('commodity queries survive regardless of the shuffle', () => {
    // The old behaviour failed this across seeds; reserving slots must not.
    for (let seed = 1; seed <= 50; seed++) {
        const picked = selectScanQueries(REAL_SHAPE, 20, seeded(seed));
        const commodityCount = picked.filter((q) => /^(WHEAT|CORN)/.test(q)).length;
        assert.equal(commodityCount, 4, `seed ${seed} dropped commodity queries`);
    }
});

test('keywords still get most of the budget', () => {
    // Reserving slots must not turn the scan into a commodity-only search:
    // breaking supply-chain news often names no commodity at all.
    const picked = selectScanQueries(REAL_SHAPE, 20, seeded(3));
    const other = picked.filter((q) => !/^(WHEAT|CORN)/.test(q));
    assert.equal(other.length, 16);
});

test('many commodities cannot crowd out every keyword', () => {
    const many = Array.from({ length: 26 }, (_, i) => `COMMODITY_${i} supply chain`);
    const picked = selectScanQueries({ commodityQueries: many, otherQueries: keywords(40) }, 20, seeded(5));
    const commodityCount = picked.filter((q) => q.startsWith('COMMODITY_')).length;
    assert.equal(commodityCount, 10, 'commodity queries exceeded half the budget');
    assert.equal(picked.length, 20);
});

test('a profile with no commodities is unaffected', () => {
    const picked = selectScanQueries({ commodityQueries: [], otherQueries: keywords(40) }, 20, seeded(9));
    assert.equal(picked.length, 20);
    assert.equal(new Set(picked).size, 20, 'duplicates returned');
});

test('a small pool is not padded and never duplicates', () => {
    const picked = selectScanQueries(
        { commodityQueries: ['WHEAT supply chain'], otherQueries: ['port strike'] }, 20, seeded(2));
    assert.deepEqual([...picked].sort(), ['WHEAT supply chain', 'port strike']);
});

test('the budget is filled from the other source when one runs short', () => {
    // 3 commodities cap at 10 reserved but only 3 exist; the rest must come
    // from keywords rather than the scan simply running fewer feeds.
    const picked = selectScanQueries(
        { commodityQueries: ['A supply', 'B supply', 'C supply'], otherQueries: keywords(30) }, 20, seeded(4));
    assert.equal(picked.length, 20);
    assert.equal(picked.filter((q) => /^[ABC] supply$/.test(q)).length, 3);
});

test('a query appearing in both sources is not returned twice', () => {
    const dup = 'WHEAT supply chain';
    const picked = selectScanQueries(
        { commodityQueries: [dup], otherQueries: [dup, 'port strike'] }, 20, seeded(6));
    assert.equal(picked.filter((q) => q === dup).length, 1);
});

test('a zero budget returns nothing rather than throwing', () => {
    assert.deepEqual(selectScanQueries(REAL_SHAPE, 0, seeded(1)), []);
});
