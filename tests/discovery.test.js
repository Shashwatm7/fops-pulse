import test from 'node:test';
import assert from 'node:assert/strict';
import { kmeansCosine, topTermsPerCluster, discoverTemplateCandidates } from '../services/news-pipeline/discovery.js';

// Fake embedder: deterministic normalized vector keyed by which topic words
// appear in the title. Same topic → nearby vectors, so k-means must separate
// the topics without ever loading the real MiniLM model.
const TOPICS = [
    ['tariff', 'steel', 'import', 'duty'],
    ['flood', 'rice', 'thailand', 'crop'],
    ['freight', 'container', 'shipping', 'rate'],
];
function fakeEmbed(title) {
    const t = String(title).toLowerCase();
    const v = new Float64Array(8);
    TOPICS.forEach((words, ti) => {
        const hits = words.filter(w => t.includes(w)).length;
        v[ti] = hits;
        v[ti + 3] = hits * 0.5;
    });
    v[7] = 0.1; // shared component so no vector is all-zero
    let norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return Promise.resolve(v.map(x => x / norm));
}

function normalized(arr) {
    const n = Math.sqrt(arr.reduce((s, x) => s + x * x, 0)) || 1;
    return arr.map(x => x / n);
}

test('kmeansCosine separates two obvious groups deterministically', () => {
    const a = normalized([1, 0, 0]);
    const b = normalized([0.9, 0.1, 0]);
    const c = normalized([0, 0, 1]);
    const d = normalized([0, 0.1, 0.9]);
    const { assignments, k } = kmeansCosine([a, b, c, d], 2, { seed: 7 });
    assert.equal(k, 2);
    assert.equal(assignments[0], assignments[1], 'a and b cluster together');
    assert.equal(assignments[2], assignments[3], 'c and d cluster together');
    assert.notEqual(assignments[0], assignments[2], 'the two groups differ');
    // Same seed → identical result
    const rerun = kmeansCosine([a, b, c, d], 2, { seed: 7 });
    assert.deepEqual(rerun.assignments, assignments);
});

test('kmeansCosine handles k > n and empty input', () => {
    assert.deepEqual(kmeansCosine([], 5).assignments, []);
    const solo = kmeansCosine([normalized([1, 1])], 5);
    assert.equal(solo.k, 1);
    assert.deepEqual(solo.assignments, [0]);
});

test('topTermsPerCluster surfaces distinctive terms, drops stopwords', () => {
    const titles = [
        'Steel tariff raises import duty concerns',
        'New steel tariff hits import market',
        'Thailand flood damages rice crop yield',
        'Rice crop losses mount after Thailand flood',
    ];
    const assignments = [0, 0, 1, 1];
    const terms = topTermsPerCluster(titles, assignments, 2, 5);
    assert.ok(terms[0].some(t => t.includes('tariff') || t.includes('steel')), 'cluster 0 labeled by tariff/steel');
    assert.ok(terms[1].some(t => t.includes('rice') || t.includes('flood')), 'cluster 1 labeled by rice/flood');
    assert.ok(!terms[0].includes('the') && !terms[0].includes('after'), 'no stopwords');
});

test('discoverTemplateCandidates returns note below minVolume', async () => {
    const rows = [{ title: 'A single rejected headline about freight rates' }];
    const out = await discoverTemplateCandidates(rows, { embedFn: fakeEmbed, minVolume: 20 });
    assert.deepEqual(out.clusters, []);
    assert.equal(out.totalUnmatched, 1);
    assert.match(out.note, /need at least 20/);
});

test('discoverTemplateCandidates clusters mixed topics into reviewable summaries', async () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
        rows.push({ title: `Steel tariff and import duty update number ${i} shakes markets`, rejection_reason: 'Score too low (32)' });
        rows.push({ title: `Thailand flood threatens rice crop supply report ${i} today`, rejection_reason: 'No region match' });
        rows.push({ title: `Container shipping freight rate surge continues week ${i} globally`, rejection_reason: 'Score too low (25)' });
    }
    const out = await discoverTemplateCandidates(rows, { k: 3, minVolume: 20, embedFn: fakeEmbed, seed: 42 });
    assert.equal(out.totalUnmatched, 30);
    assert.equal(out.clusters.length, 3);
    // Largest-first ordering and full coverage
    const total = out.clusters.reduce((s, c) => s + c.count, 0);
    assert.equal(total, 30);
    assert.ok(out.clusters[0].count >= out.clusters[2].count, 'sorted largest-first');
    // Each cluster is topically pure: its top terms match exactly one topic
    for (const cluster of out.clusters) {
        assert.ok(cluster.topTerms.length > 0);
        assert.ok(cluster.sampleTitles.length > 0 && cluster.sampleTitles.length <= 3);
        assert.ok(Object.keys(cluster.rejectionReasons).length > 0);
        const text = cluster.topTerms.join(' ');
        const matchingTopics = TOPICS.filter(words => words.some(w => text.includes(w)));
        assert.equal(matchingTopics.length, 1, `cluster terms "${text}" map to exactly one topic`);
    }
    // Numeric noise stripped from rejection reason keys
    const reasons = out.clusters.flatMap(c => Object.keys(c.rejectionReasons));
    assert.ok(reasons.every(r => !/\d/.test(r)), 'rejection reason keys have scores stripped');
});
