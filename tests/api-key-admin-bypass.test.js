// tests/api-key-admin-bypass.test.js
//
// requireAdmin must refuse a request whose authority traces back to a shared
// API key, including one that arrives carrying only the session cookie that
// an earlier key request minted.
//
// The bypass this guards was verified against the deployed app: a request with
// X-API-Key comes back with a 24h connect.sid, and that cookie alone then
// authenticates. On the cookie-only request req.isApiKey is never set, so a
// check on that flag alone stops applying after one hop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAdmin } from '../auth.js';

function run(req) {
    const res = {
        statusCode: null, body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
    };
    let nextCalled = false;
    requireAdmin(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

const ADMIN = { is_admin: true };

test('the key-bearing request itself is refused', () => {
    const { res, nextCalled } = run({ isApiKey: true, user: ADMIN, session: {} });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not an API key/);
});

test('a later request carrying only the minted cookie is also refused', () => {
    // No req.isApiKey — this is the cookie-only follow-up. The marker stored on
    // the session is the only thing distinguishing it from a human login.
    const { res, nextCalled } = run({ user: ADMIN, session: { userId: 7, isApiKey: true } });
    assert.equal(nextCalled, false, 'key-derived cookie reached an admin route');
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /not an API key/);
});

test('a genuine admin session still passes', () => {
    const { res, nextCalled } = run({ user: ADMIN, session: { userId: 7 } });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
});

test('a non-admin session is refused on the is_admin check, not the key check', () => {
    const { res, nextCalled } = run({ user: { is_admin: false }, session: { userId: 8 } });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /Admin access required/);
});

test('a missing session does not throw', () => {
    // requireAuth can reject before a session exists; requireAdmin must not
    // blow up on the optional chain if it is ever reached first.
    const { res, nextCalled } = run({ user: ADMIN });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
});
