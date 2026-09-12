# 15. Risks

| # | Risk | Category | Likelihood | Impact | Mitigation (in place) | Residual action |
|---|---|---|---|---|---|---|
| R1 | Free-tier LLM rate limits block AI features | Technical | High | Medium | Key pool + task pinning + per-key breaker + rotation; no-fallback keeps failures honest | Add keys; paid tier for production |
| R2 | Yahoo Finance unofficial API changes/blocks | Data | Medium | High | Chart-endpoint fallback lane; roll-guards; honest nulls | Licensed feed before commercial scale |
| R3 | Google News RSS rate-limits server IP | Data | Medium | Medium | Query cap (20/scan), scan gating by last-scan age; curated-feed lane | Rotate feeds; commercial news API |
| R4 | **AI hallucination** in planner/deep-dive/drivers | AI | Medium | High | Grounding: titles-only curated context; JSON-mode; temp 0.1; deterministic layer picks inputs; drivers exclude price alerts; summary cache versioning busts known-bad outputs (mig. 019); 👍/👎 feedback | Add claim-vs-source eval on golden set |
| R5 | Relevance filter too strict/loose (silent) | AI/Data | Medium | Medium | Full audit trail per article; admin tuning without redeploy; semantic rescue lane; fail-open gate | Golden-set regression eval per tuning change |
| R6 | PortWatch misread as real-time congestion | Data | Medium | Medium | UI labeled "weekly, ~1wk lag"; metric named throughput-anomaly; docs state **no dwell data exists** | Small-baseline guard for low-traffic ports (backlog) |
| R7 | Forecast/recommendation uncertainty taken as fact | Business | Medium | High | Confidence field on recs; horizons bounded (90/365D); precedent panel shows historical dispersion | Add explicit uncertainty ranges (page 16) |
| R8 | Render free tier availability (spin-down, restarts) | Technical | High | Low–Med | All critical state DB-persisted (alerts, audit, scan results); cold-start documented | Paid instance for production |
| R9 | Single-instance in-memory state blocks scaling | Technical | Low (now) | High (later) | Documented; DB-backed where critical | Redis/DB for breakers, caches, scanState before scale-out |
| R10 | SESSION_SECRET fallback constant | Security | Low | High | Env override supported; flagged in docs | Enforce: refuse to boot in prod without env secret |
| R11 | External API schema drift (WeatherAPI, OXR, PortWatch) | Data | Medium | Medium | Defensive parsing, per-item isolation, explicit 503s | Contract checks in smoke tests |
| R12 | No inbound rate limiting / brute-force protection | Security | Medium | Medium | Session auth, bcrypt | Add login throttling + per-IP limits |
| R13 | Alert fatigue if quotas mistuned | Product | Low | Medium | Hard display quota (1C/2H/1M); 24 h freshness both ways | Feedback-driven quota tuning |
| R14 | Key-person/knowledge risk | Org | Medium | Medium | This documentation space; audit-log explainability | Keep docs versioned with code (`docs/confluence/`) |
