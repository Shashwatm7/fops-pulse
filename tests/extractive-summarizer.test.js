import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences, summarizeExtractive } from '../services/labeling/extractiveSummarizer.js';

// Fake embedder: vector keyed by topic-word hits so similarity is
// predictable without loading the real MiniLM model. Sentences about the
// same topic land near each other; off-topic sentences land far away.
const TOPIC_WORDS = [
    ['wheat', 'export', 'grain', 'harvest'],
    ['shipping', 'freight', 'vessel', 'port'],
    ['weather', 'drought', 'rain', 'heatwave'],
];
function fakeEmbed(sentence) {
    const t = String(sentence).toLowerCase();
    const v = new Float64Array(4);
    TOPIC_WORDS.forEach((words, i) => { v[i] = words.filter(w => t.includes(w)).length; });
    v[3] = 0.05; // shared floor so nothing is a zero vector
    return Promise.resolve(v);
}

test('splitSentences protects abbreviations and decimals', () => {
    const s = splitSentences('The U.S. wheat crop fell 4.2% this year. Exports to the E.U. rose. Dr. Smith disagreed strongly with that.');
    assert.equal(s.length, 3);
    assert.match(s[0], /U\.S\. wheat crop fell 4\.2% this year\.$/);
    assert.match(s[2], /^Dr\. Smith/);
});

test('splitSentences handles empty and unpunctuated input', () => {
    assert.deepEqual(splitSentences(''), []);
    assert.deepEqual(splitSentences('   '), []);
    const s = splitSentences('a headline fragment with no terminal punctuation');
    assert.equal(s.length, 1);
});

test('short article passes through whole (no embedding needed)', async () => {
    const text = 'Wheat exports from the Black Sea region fell sharply this week overall. Grain traders reported vessel delays at three major ports.';
    let embeds = 0;
    const out = await summarizeExtractive(text, { maxSentences: 3, embedFn: (s) => { embeds++; return fakeEmbed(s); } });
    assert.equal(out.sentences.length, 2);
    assert.equal(embeds, 0, 'no embeddings spent when text is already short');
});

test('returns null when no usable sentences', async () => {
    assert.equal(await summarizeExtractive('Short. Tiny. No.', { embedFn: fakeEmbed }), null);
    assert.equal(await summarizeExtractive('', { embedFn: fakeEmbed }), null);
});

test('picks central sentences, in original order, without duplicates', async () => {
    const text = [
        'Wheat export volumes from the region collapsed after the harvest failed across key grain districts.', // wheat topic
        'Grain shipments and wheat export contracts were cancelled as harvest estimates fell further today.', // wheat (redundant with #1)
        'Meanwhile a celebrity chef opened a completely unrelated restaurant downtown to great local fanfare.', // off-topic
        'Freight rates spiked as vessel queues lengthened outside the main export port facilities this week.', // shipping topic
        'The wheat and grain harvest shortfall pushed export prices to their highest level in two years.',    // wheat
    ].join(' ');
    const out = await summarizeExtractive(text, { title: 'Wheat exports collapse after failed harvest', maxSentences: 3, embedFn: fakeEmbed });
    assert.equal(out.sentences.length, 3);
    // Original order preserved
    const idx = out.sentences.map(s => text.indexOf(s));
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'sentences in document order');
    // The off-topic sentence must not be picked
    assert.ok(!out.summary.includes('celebrity chef'), 'off-topic sentence excluded');
    // No duplicate picks
    assert.equal(new Set(out.sentences).size, 3);
});

test('MMR avoids picking three near-identical sentences', async () => {
    const text = [
        'Wheat export grain harvest volumes fell sharply across the entire region during this marketing year.',
        'Wheat export grain harvest totals dropped steeply across the whole region in the current marketing year.',
        'Wheat export grain harvest output declined heavily across the region throughout this marketing season.',
        'Freight rates for shipping vessels rose at the port as export logistics tightened considerably this month.',
    ].join(' ');
    const out = await summarizeExtractive(text, { maxSentences: 2, embedFn: fakeEmbed, lambda: 0.6 });
    assert.equal(out.sentences.length, 2);
    // With three near-identical wheat sentences, the second pick should be the
    // distinct shipping sentence, not another wheat clone.
    assert.ok(out.summary.includes('Freight rates'), `expected diversity pick, got: ${out.summary}`);
});
