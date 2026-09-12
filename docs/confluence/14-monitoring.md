# 14. Monitoring & Operations

## 14.1 What Exists Today

| Signal | Where | Tag / Source |
|---|---|---|
| Scan lifecycle | Render logs + DB | `[USER-SCANNER]` fetched/accepted counts; `user_profiles.last_scan_result` + `last_scan_at` (survives restarts); `/api/scan-status` |
| LLM usage & limits | Render logs + in-memory | `[TOKENS]` per-call in/out tokens + cumulative; `[GROQ]` rate-limit + rotation events (`key#N (failover)`); `global.apiRateLimits` from provider headers |
| Pipeline decisions | Postgres | `pipeline_audit_logs` — every accept/reject with stage + reason; surfaced in Pipeline Analytics UI |
| Price engine | Render logs | `[TICK PRICES]` fetch issues, chart-fallback pricing |
| Ingestion health | Render logs | Per-port PortWatch failures, per-feed RSS failures (isolated, non-fatal) |
| Semantic layer | Render logs | `[SEMANTIC]` fail-open events; `[EMBEDDINGS]` Gemini cooldowns |
| DB self-heal | Render logs | `[DB]` 42703 column self-heals, insert failures |
| User feedback | Postgres | `ai_feedback` (👍/👎 per AI feature) |

## 14.2 Failure Recovery & Retry Mechanisms (as built)

| Failure | Recovery |
|---|---|
| Groq 429 | Per-key breaker opens for provider-stated cooldown → **rotate to next pool key (same model)** → only all-keys-limited surfaces an error |
| Gemini quota | Embedding circuit pauses embedding calls for parsed cooldown |
| Yahoo quote path broken | Chart-endpoint fallback lane; roll-guards prevent fake moves; no-prevClose ⇒ honest null % |
| One RSS feed / port / key fails | Loop continues; failure logged; batch result reports ok/fail counts |
| Server restart mid-scan | Scan re-runs on schedule; last result persisted (mig. 025); alerts/audit already durable |
| Stale frontend chunks after deploy | `index.html` no-cache + `lazyWithReload` one-shot reload |
| Missing DB column (schema drift) | Insert retries after `ADD COLUMN IF NOT EXISTS` |
| Embedding failure in gate | Fail-open (article passes) so filtering degrades safe, not silent-drop |

## 14.3 Dashboards

- **In-product:** Pipeline Analytics (accept/reject table, scan trigger + persisted result), Admin tuning panel (live params, seeds preview), token/rate-limit chip (from `global.apiRateLimits`).
- **Render:** service Events (deploys), Logs (live tail), Metrics (CPU/mem/requests).

## 14.4 Gaps & Recommended Additions

| Gap | Recommendation |
|---|---|
| No metrics store / APM | Lightweight: `/metrics` endpoint (Prometheus format) or a free-tier APM; track scan duration, accept rate, LLM latency, breaker-open time |
| No alerting on failures | Uptime ping (e.g. UptimeRobot on `/api/auth/me`) + log-based alert on `Global failure` / `MIGRATION FAILED` |
| Token spend visibility | Persist `tokenUsage` counters to DB daily (currently reset on restart) |
| Acceptance-rate drift | Weekly query on `pipeline_audit_logs`: accept % per user; sudden drops signal source or threshold problems |

## 14.5 Runbook Snippets

| Symptom | First checks |
|---|---|
| "AI Planner Error: circuit-breaker active" | How many keys in `GROQ_API_KEY`? Logs show `key#N` rotation? All-keys-limited ⇒ wait for cooldown or add keys |
| Alerts tab empty | `/api/scan-status`; `settings_changed_at` recently bumped? Publish-date gate (only articles ≤ 24 h alert); check audit logs for rejects |
| No FX panel data | `OPEN_EXCHANGE_APP_ID` set? Route returns 503 with reason |
| Dashboard blank after deploy | Old tab open during deploy — reload; verify `index.html` no-cache header |
| Everything slow / first load fails | Free-tier cold start (30–60 s); warm before demos |
