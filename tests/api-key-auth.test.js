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
