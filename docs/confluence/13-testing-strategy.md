# 13. Testing Strategy

## 13.1 Current State (honest)

| Layer | Exists today | Detail |
|---|---|---|
| AI endpoint smoke tests | ✅ | `scripts/ai-endpoints-smoke.mjs` (`npm run smoke:endpoints`): mints a session, hits planner / deep-dive / drivers, asserts real content and **absence of any fallback markers** ("DETERMINISTIC FALLBACK", "AI Generation Failed", …). `SMOKE_BASE` targets any environment. |
| Groq key smoke | ✅ | `scripts/groq-smoke.mjs` — validates pool keys |
| Syntax gate | ✅ (manual) | `node --check server.js db.js services/...` before push |
| Build gate | ✅ (manual) | `npm run build` (Vite) must pass |
| Ad-hoc verification harness | ✅ | Direct-module scripts against local Postgres (e.g. insertAlert round-trip, migration application, PortWatch ingest, anomaly math vs raw source data) |
| Unit / integration suites | ❌ | No Jest/Vitest suite yet |
| Load tests | ❌ | Not yet |

## 13.2 Target Test Pyramid

| Level | Scope | Priority candidates |
|---|---|---|
| Unit | Pure logic, no I/O | `price-anomaly.js` (σ/z/roll-guards — highest value), `alert-relevance.js` (quota, severity), stage-6 gate math (threshold precedence, γ=0 vs γ>0), `trackedRegionNames`, publish-date freshness gate, `groqRetryMs` parsing |
| Integration (DB) | Against throwaway Postgres schema | insert-first alert dedup (unique index), audit-log self-heal (42703), `getActiveAlerts` gating (24 h + settings_changed_at + publish date), JSONB setters don't clobber siblings |
| API | supertest against Express app | Auth flows, 401/403 gates, ports/forex add-remove validation, scan-status fallback (memory → DB → known:false) |
| AI evaluation | Prompt-contract checks | Planner: exactly 4 recs, 2×90D + 2×365D, JSON schema; deep-dive length bounds; drivers: 3 items with valid direction/strength; **golden-set relevance eval**: labeled articles vs pipeline accept/reject to regression-test threshold/γ changes |
| Load | k6/artillery | SSE fan-out, `/api/news/categorized` under audit-log growth, concurrent scans |
| Acceptance | Scripted user journeys | Onboard → track commodity → scan → alert visible → deep-dive → planner |

## 13.3 Principles Already in Force

1. **Verify against the real source** — e.g., PortWatch anomaly math was validated by re-querying the FeatureServer and comparing to displayed values; chart 1D fix validated against live Yahoo bars.
2. **No-fallback is a testable contract** — smoke test fails if any canned-text marker appears.
3. **Bug fix ⇒ regression check** — each fixed defect (stale chunks, price-basis mismatch, fingerprint memo, 1D window) has a documented reproduction that belongs in the future suite.
4. **Migrations must be re-runnable** — every migration is executed on every boot; new migrations are tested by running `migrate.js` twice locally.

## 13.4 Recommended CI Gate (next step)

```yaml
# .github/workflows/ci.yml (proposed)
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    services: { postgres: { image: postgres:16, env: { POSTGRES_PASSWORD: test } } }
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && node --check server.js db.js migrate.js
      - run: node migrate.js && node migrate.js   # idempotency: run twice
      - run: cd dashboard && npm ci && npm run build
      # unit tests once added: npx vitest run
```
