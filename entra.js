// Microsoft Entra ID SSO — multi-tenant ("sign in with Microsoft") auth-code
// flow with PKCE. The app is registered ONCE in Drizzla's workforce tenant as
// multitenant; each client's own tenant authenticates its own staff, so nobody
// gets a second set of FOps Pulse credentials.
//
// Registration checklist (Entra admin center, WORKFORCE tenant = drizzla.com):
//   1. App registrations -> New registration
//   2. Supported account types: "Accounts in any organizational directory
//      (Any Microsoft Entra ID tenant - Multitenant)"
//   3. Redirect URI: type "Web", value ENTRA_REDIRECT_URI (below)
//   4. Certificates & secrets -> New client secret -> copy into ENTRA_CLIENT_SECRET
//   5. Note the Application (client) ID -> ENTRA_CLIENT_ID
import { ConfidentialClientApplication } from '@azure/msal-node';

export const ENTRA_ENABLED = Boolean(
    process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET && process.env.ENTRA_REDIRECT_URI
);

// Default: multitenant WORKFORCE app. "organizations" = any Entra work/school
// tenant, but NOT personal Microsoft accounts. Do not use "common" — that
// admits consumer @outlook.com identities into a B2B procurement tool.
//
// Override via ENTRA_AUTHORITY if the app is instead hosted in an Entra
// External ID (CIAM) tenant, e.g.
//   https://<subdomain>.ciamlogin.com/<tenant-id>/v2.0
// The flow, session handling and identity keying are identical either way;
// only the authority and the meaning of the tenant check differ (see
// isTenantAllowed).
const AUTHORITY = process.env.ENTRA_AUTHORITY || 'https://login.microsoftonline.com/organizations';

// True when pointed at an External ID (CIAM) tenant rather than the
// multitenant workforce endpoint.
export const IS_EXTERNAL_ID = /ciamlogin\.com/i.test(AUTHORITY);

export function getAuthority() { return AUTHORITY; }

// Basic sign-in only. openid/profile/email are enough for identity; we do not
// request Graph scopes because we do not read the directory.
export const LOGIN_SCOPES = ['openid', 'profile', 'email'];

// ── Tenant allowlist: the multi-tenant security gate ─────────
// With a multitenant registration and the /organizations authority, ANY
// Microsoft work account in ANY tenant on earth can complete the flow and get
// a valid token. MSAL will not stop that — validating `tid` is the
// application's job. Without this, "authenticated" means nothing.
const ALLOWED_TENANTS = (process.env.ENTRA_ALLOWED_TENANT_IDS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

export function isTenantAllowed(tid) {
    if (!tid) return false;
    // Under External ID every user is provisioned inside OUR tenant, so `tid`
    // is the same for everyone and carries no authorization signal. The gate
    // there has to be per-user, not per-tenant, so we do not pretend this
    // check is meaningful.
    if (IS_EXTERNAL_ID) return true;
    // Multitenant workforce: fail CLOSED on an empty allowlist. An unset env
    // var must not silently mean "let the whole world in".
    if (ALLOWED_TENANTS.length === 0) return false;
    return ALLOWED_TENANTS.includes(String(tid).toLowerCase());
}

export function allowlistConfigured() {
    return ALLOWED_TENANTS.length > 0;
}

let cachedClient = null;
export function getMsalClient() {
    if (!ENTRA_ENABLED) throw new Error('Entra SSO is not configured');
    if (cachedClient) return cachedClient;
    cachedClient = new ConfidentialClientApplication({
        auth: {
            clientId: process.env.ENTRA_CLIENT_ID,
            clientSecret: process.env.ENTRA_CLIENT_SECRET,
            authority: AUTHORITY,
        },
        system: {
            loggerOptions: {
                loggerCallback: (level, message) => console.log(`[ENTRA/MSAL] ${message}`),
                piiLoggingEnabled: false,
                logLevel: 2, // Warning and above
            },
        },
    });
    return cachedClient;
}

/**
 * Pull the identity we trust out of a validated MSAL token response.
 * MSAL has already verified the token signature, issuer and audience; what is
 * left is deciding whether we accept this identity, which is policy, not crypto.
 */
export function extractIdentity(result) {
    const claims = result?.idTokenClaims || {};
    const oid = claims.oid || claims.sub;
    const tid = claims.tid;
    const email = claims.preferred_username || claims.email || claims.upn || null;
    const name = claims.name || email || 'Unknown user';
    if (!oid || !tid) {
        throw new Error('Entra token missing required oid/tid claims');
    }
    return { oid, tid, email, name };
}
