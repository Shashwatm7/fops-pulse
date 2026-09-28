// tests/job-scheduler.test.js
//
// The alert scanners run every 3 hours. setInterval alone cannot deliver that:
// it is process-local, so each container restart resets the timer, and at a
// 3-hour cadence a couple of deploys in a day can mean a scanner never fires.
// These cover the durable gate that actually enforces the cadence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runJobIfDue } from '../services/job-scheduler.js';

const HOURS_3 = 3 * 60 * 60 * 1000;
const quiet = { log() {}, error() {} };

function harness({ age, ageThrows = false, recordThrows = false } = {}) {
    const runs = [];
    const calls = [];
    return {
        runs, calls,
        deps: {
            logger: quiet,
            getJobRunAgeMs: async () => {
                if (ageThrows) throw new Error('db down');
                return age;
            },
            recordJobRun: async (name, status, detail) => {
                if (recordThrows) throw new Error('write failed');
                runs.push({ name, status, detail });
            },
        },
        fn: async () => { calls.push(Date.now()); },
    };
}

test('a job whose last run is within the interval does not run', async () => {
    const h = harness({ age: 90 * 60 * 1000 }); // 90 min ago
    const outcome = await runJobIfDue('user-scanner', HOURS_3, h.fn, h.deps);
    assert.equal(outcome, 'skipped');
    assert.equal(h.calls.length, 0);
    assert.equal(h.runs.length, 0, 'a skipped check must not touch the timestamp');
});

test('a job past its interval runs', async () => {
    const h = harness({ age: 3 * 60 * 60 * 1000 + 1 });
    assert.equal(await runJobIfDue('user-scanner', HOURS_3, h.fn, h.deps), 'ran');
    assert.equal(h.calls.length, 1);
});

test('a job that has never run is due', async () => {
    // getJobRunAgeMs returns Infinity for a missing row. This is the state of
    // the geo scanner on the first boot after this change ships — it had no
    // durable record at all, so it must scan rather than wait 3 hours.
    const h = harness({ age: Infinity });
    assert.equal(await runJobIfDue('geo-scanner', HOURS_3, h.fn, h.deps), 'ran');
    assert.equal(h.calls.length, 1);
});

test('the timestamp is stamped before the job body, not after', async () => {
    // A scan takes minutes while the check fires hourly. If the stamp only
    // landed on completion, the next check would start a duplicate scan while
    // the first was still in flight.
    const h = harness({ age: Infinity });
    let stampedAtStart = null;
    const slow = async () => { stampedAtStart = h.runs.map(r => r.status); };
    await runJobIfDue('user-scanner', HOURS_3, slow, h.deps);
    assert.deepEqual(stampedAtStart, ['running'], 'job body ran before any stamp');
    assert.deepEqual(h.runs.map(r => r.status), ['running', 'ok']);
});

test('a failing job still records a run, so it retries on cadence not hourly', async () => {
    const h = harness({ age: Infinity });
    const boom = async () => { throw new Error('rss timeout'); };
    assert.equal(await runJobIfDue('geo-scanner', HOURS_3, boom, h.deps), 'failed');
    const last = h.runs[h.runs.length - 1];
    assert.equal(last.status, 'failed');
    assert.equal(last.detail, 'rss timeout');
});

test('an unreadable due-check fails open and runs', async () => {
    // Stale alerts are the failure users see; a duplicate scan is absorbed by
    // article dedupe.
    const h = harness({ ageThrows: true });
    assert.equal(await runJobIfDue('user-scanner', HOURS_3, h.fn, h.deps), 'ran');
    assert.equal(h.calls.length, 1);
});

test('an unwritable timestamp does not block the job', async () => {
    const h = harness({ age: Infinity, recordThrows: true });
    assert.equal(await runJobIfDue('user-scanner', HOURS_3, h.fn, h.deps), 'ran');
    assert.equal(h.calls.length, 1);
});

test('exactly at the interval boundary the job runs', async () => {
    // Guards against a strict > that would make each cycle drift a check later.
    const h = harness({ age: HOURS_3 });
    assert.equal(await runJobIfDue('user-scanner', HOURS_3, h.fn, h.deps), 'ran');
});
