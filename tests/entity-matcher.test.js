import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEntities, buildMasterEntries, entitiesToChips } from '../services/news-pipeline/entity_matcher.js';

// Aramtec-like master data.
const CUSTOMER = {
    commodities: ['chicken', 'wheat', 'sunflower oil'],
    key_ports: ['Jebel Ali', 'Port Said'],
    key_routes: ['Europe to UAE'],
    supplier_countries: ['Brazil', 'Ukraine'],
};

test('commodity master entry pulls in synonyms (chicken → poultry group)', () => {
    const entries = buildMasterEntries(CUSTOMER);
    const chicken = entries.find(e => e.type === 'commodity' && e.canonical === 'chicken');
    assert.ok(chicken.aliases.includes('poultry'), 'chicken enriched with poultry synonym');
    assert.ok(chicken.aliases.includes('broiler'), 'and broiler');
});

test('matches synonym and links to canonical customer commodity', () => {
    const m = matchEntities('Broiler flocks culled after avian flu outbreak', CUSTOMER);
    assert.equal(m.commodities.length, 1);
    assert.equal(m.commodities[0].canonical, 'chicken', 'broiler resolves to the chicken master entry');
    assert.equal(m.commodities[0].matched, 'broiler');
});

test('region aliases resolve to canonical region (Dubai → UAE)', () => {
    const m = matchEntities('Congestion worsens at Dubai terminals', CUSTOMER);
    assert.ok(m.regions.some(r => r.canonical === 'UAE'), 'Dubai → UAE');
});

test('chokepoints are matched as canonical names', () => {
    const m = matchEntities('Ships avoid the Red Sea and reroute past Hormuz', CUSTOMER);
    const names = m.chokepoints.map(c => c.canonical);
    assert.ok(names.includes('Red Sea'));
    assert.ok(names.includes('Strait of Hormuz'));
});

test('ports and supplier countries match from master data', () => {
    const m = matchEntities('Jebel Ali backlog delays Brazil poultry imports', CUSTOMER);
    assert.ok(m.ports.some(p => p.canonical === 'Jebel Ali'));
    assert.ok(m.supplier_countries.some(s => s.canonical === 'Brazil'));
    assert.ok(m.commodities.some(c => c.canonical === 'chicken'), 'poultry → chicken');
});

test('word-boundary matching: no substring false positives', () => {
    // "wheat" must not match inside "wheatgrass juice"? (wheatgrass is one word)
    assert.equal(matchEntities('Trendy wheatgrass smoothies boom', CUSTOMER).commodities.length, 0);
    // A region alias must not match inside a larger word.
    const noIndiana = matchEntities('A factory opened in Indiana today', { commodities: [] });
    assert.ok(!noIndiana.regions.some(r => r.canonical === 'India'), 'Indiana !→ India');
});

test('deduped by canonical — one entry even if multiple aliases hit', () => {
    const m = matchEntities('Chicken and poultry and broiler prices all rose', CUSTOMER);
    assert.equal(m.commodities.filter(c => c.canonical === 'chicken').length, 1);
});

test('entitiesToChips flattens with types, chokepoints/regions first', () => {
    const m = matchEntities('Red Sea disruption hits Jebel Ali wheat imports from Ukraine', CUSTOMER);
    const chips = entitiesToChips(m);
    assert.ok(chips.length >= 3);
    assert.equal(chips[0].type, 'chokepoint', 'chokepoint leads');
    assert.ok(chips.every(c => c.type && c.label));
});

test('empty / no-customer input is safe', () => {
    assert.deepEqual(matchEntities('anything', {}).commodities, []);
    assert.deepEqual(entitiesToChips(matchEntities('', {})), []);
});
