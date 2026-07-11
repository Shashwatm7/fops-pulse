import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAlertQuota, ALERT_QUOTA } from '../services/alert-relevance.js';

const mk = (severity, id) => ({ id, severity });

test('quota caps at 1 CRITICAL, 2 HIGH, 1 MEDIUM and drops LOW', () => {
    const input = [
        mk('CRITICAL', 1), mk('CRITICAL', 2),
        mk('HIGH', 3), mk('HIGH', 4), mk('HIGH', 5),
        mk('MEDIUM', 6), mk('MEDIUM', 7),
        mk('LOW', 8), mk('LOW', 9),
    ];
    const out = applyAlertQuota(input);
    const bySev = out.reduce((m, a) => ((m[a.severity] = (m[a.severity] || 0) + 1), m), {});
    assert.deepEqual(bySev, { CRITICAL: 1, HIGH: 2, MEDIUM: 1 });
    assert.equal(out.length, 4, 'at most 4 alerts total');
    assert.ok(!out.some(a => a.severity === 'LOW'), 'no LOW alerts');
});

test('keeps the FIRST of each severity (input is pre-sorted by importance)', () => {
    const input = [mk('CRITICAL', 'c1'), mk('CRITICAL', 'c2'), mk('HIGH', 'h1'), mk('HIGH', 'h2'), mk('HIGH', 'h3')];
    const out = applyAlertQuota(input);
    assert.deepEqual(out.map(a => a.id), ['c1', 'h1', 'h2']);
});

test('fewer alerts than the quota pass through unchanged', () => {
    const input = [mk('HIGH', 1), mk('MEDIUM', 2)];
    assert.deepEqual(applyAlertQuota(input).map(a => a.id), [1, 2]);
});

test('empty / nullish input yields empty array', () => {
    assert.deepEqual(applyAlertQuota([]), []);
    assert.deepEqual(applyAlertQuota(null), []);
    assert.deepEqual(applyAlertQuota(undefined), []);
});

test('unknown severities are dropped (not in quota)', () => {
    const out = applyAlertQuota([mk('INFO', 1), mk('CRITICAL', 2)]);
    assert.deepEqual(out.map(a => a.id), [2]);
});

test('ALERT_QUOTA is the agreed 1/2/1/0 policy', () => {
    assert.deepEqual(ALERT_QUOTA, { CRITICAL: 1, HIGH: 2, MEDIUM: 1, LOW: 0 });
});
