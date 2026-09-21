// tests/planner-reasoning.test.js
// The REASONING field on planner recommendations.
//
// The UI renders that block conditionally ({r.reasoning && ...} at
// App.jsx:1610), so a card without the key silently loses the section. The
// prompt now asks for it and the route normalises it, and these tests pin both
// halves of that contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const planner = fs.readFileSync('services/planner/plannerService.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

test('the prompt asks the model for a reasoning key', () => {
    assert.match(planner, /"reasoning":/, 'reasoning must be a required key in the prompt');
});

test('the prompt distinguishes reasoning from businessImpact', () => {
    // These two were being conflated. businessImpact is the consequence of
    // acting; reasoning is the evidence the call rests on.
    assert.match(planner, /EVIDENCE the recommendation rests on/i);
    assert.match(planner, /CONSEQUENCE of acting/i);
});

test('every one of the four required keys is still requested', () => {
    for (const key of ['timeframe', 'action', 'businessImpact', 'reasoning']) {
        assert.match(planner, new RegExp(`"${key}":`), `${key} missing from the prompt contract`);
    }
});

// Mirror of the normalisation in server.js so the behaviour is asserted, not
// just the presence of the code.
const normalise = (recs) => recs.map(r =>
    (typeof r?.reasoning === 'string' && r.reasoning.trim()) ? r : { ...r, reasoning: '' });

test('a missing reasoning key is filled in, not dropped', () => {
    const out = normalise([{ timeframe: '90D', action: 'a', businessImpact: 'b' }]);
    assert.equal(out[0].reasoning, '', 'the key exists so the client can rely on it');
    assert.ok('reasoning' in out[0]);
});

test('a real reasoning value is left untouched', () => {
    const out = normalise([{ timeframe: '90D', reasoning: 'COPPER above its 90-day range.' }]);
    assert.equal(out[0].reasoning, 'COPPER above its 90-day range.');
});

test('a whitespace-only reasoning is treated as missing', () => {
    // '   ' is truthy, so a naive check would pass it through and render an
    // empty REASONING block with a heading and no text.
    const out = normalise([{ timeframe: '90D', reasoning: '   ' }]);
    assert.equal(out[0].reasoning, '');
});

test('the route normalises before caching, not after', () => {
    // Caching the raw model output would pin a reasoning-less generation in
    // place for 2h, which is exactly how this became intermittent.
    const normIdx = server.indexOf('Recommendation missing "reasoning"');
    const cacheIdx = server.indexOf('global.aiPlannerCache[cacheKey] = { data: recommendations');
    assert.ok(normIdx > -1 && cacheIdx > -1, 'both code paths found');
    assert.ok(normIdx < cacheIdx, 'normalisation must run before the cache write');
});
