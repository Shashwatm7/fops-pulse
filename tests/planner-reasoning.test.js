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
const NARRATIVE_KEYS = ['businessImpact', 'reasoning'];
const normalise = (recs) => recs.map((r) => {
    const filled = { ...r };
    for (const key of NARRATIVE_KEYS) {
        if (typeof filled[key] === 'string' && filled[key].trim()) continue;
        filled[key] = '';
    }
    return filled;
});

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
    // Anchored on the declaration rather than the log text, which is phrasing
    // and moves whenever the message is reworded.
    const normIdx = server.indexOf("const NARRATIVE_KEYS = ['businessImpact', 'reasoning']");
    const cacheIdx = server.indexOf('global.aiPlannerCache[cacheKey] = { data: recommendations');
    assert.ok(normIdx > -1, 'normalisation block found');
    assert.ok(cacheIdx > -1, 'cache write found');
    assert.ok(normIdx < cacheIdx, 'normalisation must run before the cache write');
});

// ── businessImpact gets the same guarantee ──────────────────
// It is rendered conditionally too (App.jsx:1604), so it fails the same way.

test('a missing businessImpact is filled in, not dropped', () => {
    const out = normalise([{ timeframe: '90D', action: 'a', reasoning: 'r' }]);
    assert.equal(out[0].businessImpact, '');
    assert.ok('businessImpact' in out[0]);
});

test('both narrative fields can be missing at once', () => {
    const out = normalise([{ timeframe: '365D', action: 'a' }]);
    assert.equal(out[0].businessImpact, '');
    assert.equal(out[0].reasoning, '');
    assert.equal(out[0].action, 'a', 'other fields are untouched');
    assert.equal(out[0].timeframe, '365D');
});

test('real values for both survive normalisation', () => {
    const rec = { timeframe: '90D', businessImpact: 'Caps Q4 cost.', reasoning: 'COPPER above range.' };
    const out = normalise([rec]);
    assert.equal(out[0].businessImpact, 'Caps Q4 cost.');
    assert.equal(out[0].reasoning, 'COPPER above range.');
});

test('whitespace-only businessImpact is treated as missing', () => {
    const out = normalise([{ timeframe: '90D', businessImpact: '  \n ' }]);
    assert.equal(out[0].businessImpact, '');
});

test('the route normalises both keys', () => {
    assert.match(server, /NARRATIVE_KEYS\s*=\s*\['businessImpact',\s*'reasoning'\]/);
});
