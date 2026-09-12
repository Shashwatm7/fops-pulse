# 12. Security

## 12.1 Authentication

- Email + password; **bcryptjs, cost 10**; hashes only (`users.password_hash`).
- Session-based auth: `express-session` + `connect-pg-simple` (sessions in Postgres, survive restarts).
- Cookie: `httpOnly`, `SameSite=Lax`, `maxAge` 24 h, `secure` when `NODE_ENV=production` or on Render.

> **🔴 Action required** — `SESSION_SECRET` falls back to a constant in code when unset. It **must** be set as an env var in production; rotate if the repo was ever shared while the fallback was live.

## 12.2 Authorization

| Level | Mechanism |
|---|---|
| Authenticated user | `requireAuth` middleware on all `/api/*` data routes; SSE feed included |
| Admin | `requireAdmin` (checks `users.is_admin`) on tuning, user-role, seeds-preview routes |
| Data isolation | All per-user reads/writes keyed by `req.session.userId` / `req.user.id`; user-linked tables `ON DELETE CASCADE` |

Role grant paths: Admin panel (PUT `/users/:id/role`) or `scripts/make-admin.mjs` (explicit DB URL required — deliberately does not read `.env`).

## 12.3 Secrets Management

- All provider keys via env vars / Render secret files (`/etc/secrets/.env`). None in the frontend bundle — every external call is server-side.
- Groq keys held in a pool string; **breaker map is keyed by key string in memory and never logged**.
- `.env` is gitignored; `make-admin.mjs` requires the URL explicitly so operators always know which DB they're touching.

## 12.4 Rate Limiting

| Direction | Status |
|---|---|
| Outbound (providers) | Per-key circuit breakers honoring provider cooldowns; key-pool rotation; Gemini embedding cooldown; batch pacing on Yahoo |
| Inbound (our API) | **None yet** — no per-IP/per-user request limiting. Login brute-force throttling recommended (see page 16 backlog). |

## 12.5 Input Handling

- Parameterized SQL everywhere (`pg` placeholders) — no string-built queries.
- Region/port/currency inputs validated against catalogs or sanitized (length caps, list caps in tuning).
- React escapes rendered content by default; no `dangerouslySetInnerHTML` in the dashboard code.
- RSS content is parsed to plain fields; article HTML never rendered raw.

## 12.6 Logging & Privacy

- Logs contain user IDs and article titles, never passwords or API keys.
- PII stored: email, username, company name. No financial or personal-sensitive data.
- User deletion cascades all owned rows (profiles, alerts, audit logs, feedback).
- Alert emails go only to the account's own address.

## 12.7 Transport

- TLS terminated by Render (HTTPS externally).
- Outbound: HTTPS to all providers **except** WeatherAPI calls currently using `http://api.weatherapi.com` — flip to `https://` (backlog).
