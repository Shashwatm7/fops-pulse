# 9. Recommendation Engine

Two cooperating layers: a **deterministic alert-relevance layer** (rules, scoring, quotas — fully explainable) and the **LLM planner** (structured recommendations grounded in the deterministic layer's outputs).

## 9.1 Rule Matching & Business Logic (deterministic)

| Step | Logic | Module |
|---|---|---|
| Exposure scoring | Event × user exposure: commodity match, region match, keyword strength → `relevance_score` 0–100 | `services/alert-relevance.js` (`scoreAlertExposure`) |
| Severity mapping | From pipeline priority (`severityFromPriority`) or score bands (`severityFromScore`) → CRITICAL/HIGH/MEDIUM/LOW | same |
| Alert quota | Display shape: **max 1 CRITICAL, 2 HIGH, 1 MEDIUM, LOW dropped** — keeps alerts scarce and trusted; identical on Alerts tab, `/api/alerts`, Morning Brief | `applyAlertQuota` |
| Freshness | Publish ≤ 24 h to create; `created_at` ≤ 24 h to display; `settings_changed_at` gate after profile changes | `getActiveAlerts` |
| Dedup | `dedup_key = profile:<normalized-title>`; DB unique index is the source of truth | insert-first pattern |
| Price rules | Anomaly detector: z-score ≥ 2.5 **and** move ≥ 1.5% (materiality floor); 90-day range breaks; vol-regime shift; futures roll-guards suppress fake moves | `services/price-anomaly.js` |
| Precedents | Event normalized → matched to historical analogs → aftermath computed ("last time this happened") | `services/precedent-engine.js` |

### Severity / priority scoring

```
pipeline score (0–100) ─→ priority: ≥ threshold bands → Critical / High / Medium / Low / Ignored
priority ─→ alert severity (Critical→CRITICAL …)
price anomaly ─→ severity: |z| ≥ 3.5 → CRITICAL, ≥ 2.5 → HIGH; range-break → HIGH/MEDIUM
```

Prioritization within a severity: newest `created_at` first; ties broken by `relevance_score`.

## 9.2 LLM Planner (recommendation generation)

- **Input bundle (titles-only by design** — caps input tokens): active alerts (post-quota), accepted news headlines, live prices, energy, FX, weather analytics, profile keywords.
- **Prompt contract** (`services/planner/plannerService.js`): senior procurement strategist persona; **exactly 4 recommendations — 2 × 90-day, 2 × 365-day**; each with action, rationale tied to cited signals, confidence; JSON-mode output; temperature 0.1.
- **Model/routing:** Groq `llama-3.3-70b-versatile`, task=planner (key 0, pool rotation on 429), max_tokens 3000.
- **Grounding rule:** rationale must reference the supplied signals (alerts/headlines/prices) — the deterministic layer decides *what the model is allowed to see*, which is the primary hallucination control.
- **Failure:** error surfaced to UI; no fallback content.

## 9.3 Market Indicators (drivers)

- Gemini 2.5 Flash; input = active non-PRICE alerts (top 5) + short prices/weather/news lists; output = 3 drivers `{factor, direction UP|DOWN|FLAT, strength 1–10, explanation, evidence[]}`.
- PRICE alerts are excluded as inputs (a price move is an *effect*, not a driver).
- 1-hour cache keyed by profile + active-alert titles — a new alert invalidates immediately.
- On failure: `drivers: []` + `driversError` rendered as a banner.

## 9.4 Explainability Chain

Every recommendation is traceable end-to-end:

```
recommendation → cited alert/headline → alerts row (reason, relevance_score, payload.semanticSimilarity)
             → pipeline_audit_logs row (stage, rejection/acceptance reason, published_at)
             → raw article URL
```
