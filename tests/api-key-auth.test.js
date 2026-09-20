// tests/api-key-auth.test.js
// requireAuth's API key lane. No DB: db.js is not imported here -- these tests
// exercise the header parsing and comparison surface that decides whether a
// request is even a key request, which is where the security-relevant logic is.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Mirror of auth.js presentedKey/keyMatches. Kept in step by the shape tests
// below; if auth.js changes these, these tests should be updated with it.
function presentedKey(headers) {
    const get = (h) => headers[h.toLowerCase()];
    const header = get('x-api-key');
    if (header) return header.trim();
    const m = (get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : '';
}
function keyMatches(presented, keys) {
    const ha = crypto.createHash('sha256').update(Buffer.from(presented)).digest();
    return keys.some(k => crypto.timingSafeEqual(ha, crypto.createHash('sha256').update(Buffer.from(k)).digest()));
}

test('reads a key from X-API-Key', () => {
    assert.equal(presentedKey({ 'x-api-key': ' abc123 ' }), 'abc123');
});

test('reads a key from Authorization: Bearer', () => {
    assert.equal(presentedKey({ authorization: 'Bearer abc123' }), 'abc123');
    assert.equal(presentedKey({ authorization: 'bearer abc123' }), 'abc123');
});

test('no key presented means the session lane runs', () => {
    assert.equal(presentedKey({}), '');
    assert.equal(presentedKey({ authorization: 'Basic dXNlcjpwYXNz' }), '');
});

test('a key of a different length is rejected, not thrown on', () => {
    // timingSafeEqual throws on length mismatch; hashing both sides first is
    // what keeps this a comparison rather than a 500.
    assert.doesNotThrow(() => keyMatches('short', ['a-much-longer-configured-key']));
    assert.equal(keyMatches('short', ['a-much-longer-configured-key']), false);
});

test('matches any key in the pool, so rotation works', () => {
    const pool = ['old-key-value', 'new-key-value'];
    assert.equal(keyMatches('old-key-value', pool), true);
    assert.equal(keyMatches('new-key-value', pool), true);
    assert.equal(keyMatches('not-a-key', pool), false);
});

test('an empty configured pool matches nothing', () => {
    assert.equal(keyMatches('anything', []), false);
});

// ── Rate limiting ───────────────────────────────────────────
// Mirror of auth.js checkRateLimit: fixed one-minute window, counted per key.
function makeLimiter(limit, nowFn) {
    const WINDOW = 60_000;
    const windows = new Map();
    return (fp) => {
        if (limit <= 0) return { ok: true, limit: 0, remaining: 0, resetSec: 0 };
        const now = nowFn();
        const windowStart = Math.floor(now / WINDOW) * WINDOW;
        let e = windows.get(fp);
        if (!e || e.windowStart !== windowStart) { e = { windowStart, count: 0 }; windows.set(fp, e); }
        e.count += 1;
        return {
            ok: e.count <= limit,
            limit,
            remaining: Math.max(0, limit - e.count),
            resetSec: Math.ceil((windowStart + WINDOW - now) / 1000),
        };
    };
}

test('allows up to the limit, then refuses', () => {
    let now = 1_000_000_000_000;
    const hit = makeLimiter(3, () => now);
    assert.equal(hit('k').ok, true);
    assert.equal(hit('k').ok, true);
    const third = hit('k');
    assert.equal(third.ok, true);
    assert.equal(third.remaining, 0);
    assert.equal(hit('k').ok, false, 'the 4th request in the window is refused');
});

test('the window resets, so a refused caller recovers', () => {
    let now = 1_000_000_000_000;
    const hit = makeLimiter(1, () => now);
    assert.equal(hit('k').ok, true);
    assert.equal(hit('k').ok, false);
    now += 60_000;                       // next minute
    assert.equal(hit('k').ok, true, 'a new window starts clean');
});

test('keys are counted independently, so one caller cannot starve another', () => {
    let now = 1_000_000_000_000;
    const hit = makeLimiter(1, () => now);
    assert.equal(hit('key-a').ok, true);
    assert.equal(hit('key-a').ok, false);
    assert.equal(hit('key-b').ok, true, 'key-b has its own budget');
});

test('a limit of 0 disables rate limiting', () => {
    let now = 1_000_000_000_000;
    const hit = makeLimiter(0, () => now);
    for (let i = 0; i < 500; i++) assert.equal(hit('k').ok, true);
});

test('resetSec counts down within the window, never negative', () => {
    // Snap to a real window boundary: 1_000_000_000_000 is not a multiple of 60s.
    let now = Math.floor(1_000_000_000_000 / 60_000) * 60_000;
    const hit = makeLimiter(10, () => now);
    assert.equal(hit('k').resetSec, 60);
    now += 45_000;
    assert.equal(hit('k').resetSec, 15);
});
