import { test } from 'node:test';
import assert from 'node:assert/strict';

// entra.js reads ENTRA_ALLOWED_TENANT_IDS once at module load, so each case
// needs a fresh module instance. A unique query string defeats the ESM cache.
let n = 0;
async function loadEntra(allowlist) {
    if (allowlist === undefined) delete process.env.ENTRA_ALLOWED_TENANT_IDS;
    else process.env.ENTRA_ALLOWED_TENANT_IDS = allowlist;
    return import(`../entra.js?case=${++n}`);
}

const TENANT_A = '6c7e6a4e-f398-4d0a-b31a-125970a93d51';
const TENANT_B = '0970e5ef-2f6d-485e-a375-ae65387a0fd3';

// ── The security gate ────────────────────────────────────────
// A multitenant app on the /organizations authority gets a VALID token for any
// Microsoft work account in any tenant. The allowlist is the only thing that
// makes authentication mean "is our customer", so its failure mode matters more
// than its success case.

test('unset allowlist fails CLOSED — a forgotten env var must not admit everyone', async () => {
    const { isTenantAllowed, allowlistConfigured } = await loadEntra(undefined);
    assert.equal(allowlistConfigured(), false);
    assert.equal(isTenantAllowed(TENANT_A), false, 'no tenant is allowed when unconfigured');
    assert.equal(isTenantAllowed(TENANT_B), false);
});

test('empty-string allowlist also fails closed', async () => {
    const { isTenantAllowed } = await loadEntra('');
    assert.equal(isTenantAllowed(TENANT_A), false);
});

test('only listed tenants are admitted', async () => {
    const { isTenantAllowed, allowlistConfigured } = await loadEntra(TENANT_A);
    assert.equal(allowlistConfigured(), true);
    assert.equal(isTenantAllowed(TENANT_A), true);
    assert.equal(isTenantAllowed(TENANT_B), false, 'an unlisted tenant with a valid token is still rejected');
});

test('multiple tenants parse, with whitespace tolerated', async () => {
    const { isTenantAllowed } = await loadEntra(`  ${TENANT_A} , ${TENANT_B}  `);
    assert.equal(isTenantAllowed(TENANT_A), true);
    assert.equal(isTenantAllowed(TENANT_B), true);
    assert.equal(isTenantAllowed('11111111-2222-3333-4444-555555555555'), false);
});

test('tenant matching is case-insensitive — Entra returns GUIDs in mixed case', async () => {
    const { isTenantAllowed } = await loadEntra(TENANT_A.toUpperCase());
    assert.equal(isTenantAllowed(TENANT_A.toLowerCase()), true);
    assert.equal(isTenantAllowed(TENANT_A.toUpperCase()), true);
});

test('missing or malformed tid is rejected', async () => {
    const { isTenantAllowed } = await loadEntra(TENANT_A);
    for (const bad of [null, undefined, '', 0, false]) {
        assert.equal(isTenantAllowed(bad), false, `rejects ${JSON.stringify(bad)}`);
    }
});

// ── Identity extraction ──────────────────────────────────────

test('extractIdentity reads oid/tid/email/name from id token claims', async () => {
    const { extractIdentity } = await loadEntra(TENANT_A);
    const id = extractIdentity({
        idTokenClaims: {
            oid: 'user-object-id', tid: TENANT_A,
            preferred_username: 'planner@aramtec.com', name: 'A Planner',
        },
    });
    assert.deepEqual(id, {
        oid: 'user-object-id', tid: TENANT_A,
        email: 'planner@aramtec.com', name: 'A Planner',
    });
});

test('extractIdentity falls back sub->oid and upn/email->email', async () => {
    const { extractIdentity } = await loadEntra(TENANT_A);
    const id = extractIdentity({ idTokenClaims: { sub: 'subject-id', tid: TENANT_A, upn: 'x@y.com' } });
    assert.equal(id.oid, 'subject-id');
    assert.equal(id.email, 'x@y.com');
    assert.equal(id.name, 'x@y.com', 'name falls back to email when absent');
});

test('extractIdentity throws when oid or tid is absent — never invents an identity', async () => {
    const { extractIdentity } = await loadEntra(TENANT_A);
    assert.throws(() => extractIdentity({ idTokenClaims: { tid: TENANT_A } }), /missing required oid\/tid/);
    assert.throws(() => extractIdentity({ idTokenClaims: { oid: 'o' } }), /missing required oid\/tid/);
    assert.throws(() => extractIdentity({}), /missing required oid\/tid/);
    assert.throws(() => extractIdentity(null), /missing required oid\/tid/);
});

// ── Feature gating ───────────────────────────────────────────

test('ENTRA_ENABLED requires all three credentials', async () => {
    const saved = { id: process.env.ENTRA_CLIENT_ID, sec: process.env.ENTRA_CLIENT_SECRET, uri: process.env.ENTRA_REDIRECT_URI };
    try {
        delete process.env.ENTRA_CLIENT_ID; delete process.env.ENTRA_CLIENT_SECRET; delete process.env.ENTRA_REDIRECT_URI;
        assert.equal((await loadEntra(TENANT_A)).ENTRA_ENABLED, false, 'off with no credentials');

        process.env.ENTRA_CLIENT_ID = 'id-only';
        assert.equal((await loadEntra(TENANT_A)).ENTRA_ENABLED, false, 'off with a partial config');

        process.env.ENTRA_CLIENT_SECRET = 's';
        process.env.ENTRA_REDIRECT_URI = 'https://example.test/cb';
        assert.equal((await loadEntra(TENANT_A)).ENTRA_ENABLED, true, 'on only when complete');
    } finally {
        if (saved.id === undefined) delete process.env.ENTRA_CLIENT_ID; else process.env.ENTRA_CLIENT_ID = saved.id;
        if (saved.sec === undefined) delete process.env.ENTRA_CLIENT_SECRET; else process.env.ENTRA_CLIENT_SECRET = saved.sec;
        if (saved.uri === undefined) delete process.env.ENTRA_REDIRECT_URI; else process.env.ENTRA_REDIRECT_URI = saved.uri;
    }
});

test('getMsalClient refuses to build an unconfigured client', async () => {
    const saved = process.env.ENTRA_CLIENT_ID;
    try {
        delete process.env.ENTRA_CLIENT_ID;
        const { getMsalClient } = await loadEntra(TENANT_A);
        assert.throws(() => getMsalClient(), /not configured/);
    } finally {
        if (saved === undefined) delete process.env.ENTRA_CLIENT_ID; else process.env.ENTRA_CLIENT_ID = saved;
    }
});

// ── Authority selection: workforce multitenant vs External ID (CIAM) ──
// The same code serves both tenant types; only the authority differs. But the
// tenant check means different things, and conflating them would be a silent
// authorization hole.

test('defaults to the multitenant workforce authority, not /common', async () => {
    delete process.env.ENTRA_AUTHORITY;
    const { getAuthority, IS_EXTERNAL_ID } = await loadEntra(TENANT_A);
    assert.equal(getAuthority(), 'https://login.microsoftonline.com/organizations');
    assert.ok(!getAuthority().endsWith('/common'), 'never /common — that admits personal Microsoft accounts');
    assert.equal(IS_EXTERNAL_ID, false);
});

test('an External ID authority is detected', async () => {
    process.env.ENTRA_AUTHORITY = 'https://drizzlafops.ciamlogin.com/0970e5ef-2f6d-485e-a375-ae65387a0fd3/v2.0';
    try {
        const { IS_EXTERNAL_ID } = await loadEntra(TENANT_A);
        assert.equal(IS_EXTERNAL_ID, true);
    } finally { delete process.env.ENTRA_AUTHORITY; }
});

test('under External ID the tid check is not treated as an authorization gate', async () => {
    process.env.ENTRA_AUTHORITY = 'https://drizzlafops.ciamlogin.com/tenant/v2.0';
    try {
        // Every External ID user sits in OUR tenant, so tid is constant and
        // proves nothing. It must not masquerade as a boundary.
        const { isTenantAllowed } = await loadEntra('');
        assert.equal(isTenantAllowed('any-tenant'), true, 'tid is not the gate under CIAM');
    } finally { delete process.env.ENTRA_AUTHORITY; }
});

test('workforce mode still fails closed after External ID cases have run', async () => {
    delete process.env.ENTRA_AUTHORITY;
    const { isTenantAllowed } = await loadEntra('');
    assert.equal(isTenantAllowed(TENANT_A), false, 'no allowlist leakage between modes');
});
