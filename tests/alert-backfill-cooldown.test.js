// tests/alert-backfill-cooldown.test.js
// The quota cooldown that stops an acknowledged alert being replaced instantly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAlertQuota, effectiveQuota, ALERT_QUOTA } from '../services/alert-relevance.js';

const pool = (counts) => Object.entries(counts).flatMap(([sev, n]) =>
    Array.from({ length: n }, (_, i) => ({ severity: sev, id: `${sev}-${i}` })));

test('with no recent acks the quota is unchanged', () => {
    assert.deepEqual(effectiveQuota({}), ALERT_QUOTA);
    assert.deepEqual(effectiveQuota({ CRITICAL: 0 }), ALERT_QUOTA);
});

test('a recent ack holds that severity slot empty', () => {
    const q = effectiveQuota({ CRITICAL: 1 });
    assert.equal(q.CRITICAL, 0, 'the CRITICAL slot stays empty');
    assert.equal(q.HIGH, 2, 'other severities are untouched');
    assert.equal(q.MEDIUM, 1);
});

test('the list shrinks on ack instead of backfilling', () => {
    // 38 active alerts in the pool, as in production.
    const alerts = pool({ CRITICAL: 5, HIGH: 20, MEDIUM: 13 });
    assert.equal(applyAlertQuota(alerts).length, 4, 'normally four are shown');
    // User acks the CRITICAL one.
    const after = applyAlertQuota(alerts, effectiveQuota({ CRITICAL: 1 }));
    assert.equal(after.length, 3, 'three remain — no instant replacement');
    assert.ok(!after.some(a => a.severity === 'CRITICAL'));
});

test('acking both HIGH slots empties both', () => {
    const alerts = pool({ CRITICAL: 2, HIGH: 9, MEDIUM: 4 });
    const after = applyAlertQuota(alerts, effectiveQuota({ HIGH: 2 }));
    assert.equal(after.filter(a => a.severity === 'HIGH').length, 0);
    assert.equal(after.length, 2, 'CRITICAL and MEDIUM still show');
});

test('more acks than the cap never produces a negative quota', () => {
    // Acking 5 CRITICALs in the window must not let the deduction go below 0
    // and wrap into showing alerts again.
    const q = effectiveQuota({ CRITICAL: 5 });
    assert.equal(q.CRITICAL, 0);
    const after = applyAlertQuota(pool({ CRITICAL: 3, HIGH: 3 }), q);
    assert.equal(after.filter(a => a.severity === 'CRITICAL').length, 0);
});

test('an unknown severity in the ack counts is ignored', () => {
    // A LOW ack should not corrupt the other caps — LOW has a cap of 0 anyway.
    const q = effectiveQuota({ LOW: 3, NONSENSE: 9 });
    assert.equal(q.CRITICAL, 1);
    assert.equal(q.HIGH, 2);
    assert.equal(q.MEDIUM, 1);
    assert.equal(q.LOW, 0);
});

test('once the window passes, the pool refills', () => {
    // countRecentAcksBySeverity returns {} outside the cooldown, so the base
    // quota applies again and the list returns to four.
    const alerts = pool({ CRITICAL: 5, HIGH: 20, MEDIUM: 13 });
    assert.equal(applyAlertQuota(alerts, effectiveQuota({})).length, 4);
});
