# 3. Non-Functional Requirements

| Category | Requirement (as built) | Notes / gaps |
|---|---|---|
| **Performance** | Dashboard bundle < 350 kB gz per chunk; heavy chart modal lazy-loaded with stale-chunk self-heal. API reads served from Postgres or in-memory caches; LLM endpoints are the slow path (2–20 s) and are async on the client. | Scan is background (fire-and-forget + poll) because full scans exceed gateway timeout. |
| **Scalability** | Single-instance Node process; per-user pipeline scan is O(articles × stages); embeddings computed locally (MiniLM, 384-dim) with seed-vector caching. | Multi-instance would break in-memory state (`global.scanState`, breakers, caches) — needs Redis/DB before horizontal scale. |
| **Availability** | Render free tier: spins down when idle; cold start 30–60 s. Alerts, audit logs, scan results, embeddings all DB-persisted so restarts lose nothing durable. | Paid instance removes spin-down. |
| **Reliability** | Idempotent migrations run on every boot (`node migrate.js && node server.js`); per-source failure isolation (one RSS feed/port/key failing never aborts the batch); Groq per-key circuit breaker with pool rotation; Yahoo chart-endpoint fallback; lazy self-heal for missing DB columns (42703 retry). | |
| **Security** | bcrypt (cost 10); httpOnly session cookie, `secure` in production, SameSite=Lax; role-gated admin routes; secrets via env / Render secret files. | See page 12 — SESSION_SECRET fallback constant must be overridden in prod. |
| **Monitoring** | Structured console logs per subsystem tag (`[USER-SCANNER]`, `[GROQ]`, `[TOKENS]`, `[TICK PRICES]`, `[SEMANTIC]`, `[DB]`); token usage counters; rate-limit headers tracked in `global.apiRateLimits`; Render log stream. | No external APM/metrics store yet (page 14). |
| **Logging** | Every article's accept/reject decision persisted to `pipeline_audit_logs` (stage, reason, score, publish date) — full explainability of filtering. | |
| **Maintainability** | Modular services (`services/ingestion/*`, `services/news-pipeline/stages/*`, `services/planner`, `services/labeling`); runtime tuning store avoids redeploys for relevance parameters; migrations append-only. | `server.js` is large (~4k lines) — candidate for route-module extraction. |
| **Data freshness** | Prices: 15-min server tick, 5-s SSE broadcast, 60-s client poll on Command Center. Weather: live per request. FX: live per request (hourly upstream). Ports: weekly (source cadence). News: scan interval (env `USER_SCAN_INTERVAL_MS`) + manual trigger. News alerts: article publish ≤ 24 h. | |
| **Cost** | All data sources and LLM keys on free tiers; embeddings local (no API cost); summary = titles-only ingestion to cap input tokens. | Groq key pool spreads free-tier budgets. |
