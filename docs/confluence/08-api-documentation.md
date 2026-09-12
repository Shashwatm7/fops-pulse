# 8. API Documentation

**Base:** same origin as the dashboard (Express serves both). **Auth:** session cookie (`credentials: 'include'`); login via `/api/auth/login`. `requireAuth` guards all routes below unless noted; `requireAdmin` additionally checks `is_admin`. **Errors:** JSON `{ "error": "message" }` with 4xx/5xx; AI routes return 5xx on generation failure (no fallback payloads).

## 8.1 Auth

| Method + URL | Body | Response |
|---|---|---|
| POST `/api/auth/register` | `{username, email, password, company_name?}` | `{user}` — bcrypt(10) hash stored |
| POST `/api/auth/login` | `{email, password}` | `{user, profile}` + sets session cookie (24 h) |
| POST `/api/auth/logout` | — | `{success}` |
| GET `/api/auth/me` | — | `{user, profile}` or `{user:null}` |
| PUT `/api/auth/profile` | profile fields (commodities, regions, keywords, focus_*) | `{profile}`; sets `settings_changed_at` on material change |
| GET `/api/auth/templates` | — | onboarding templates + `ALL_COMMODITIES` |
| PUT `/api/auth/admin/users/:id/role` 🔒admin | `{is_admin}` | `{success}` |

## 8.2 Market Data

| Method + URL | Params | Response (shape) |
|---|---|---|
| GET `/api/commodities` | — | `{prices:[{symbol, price, unit, currency, producers, regions}]}` |
| GET `/api/history` | `symbol`, `range=1D\|7D\|1M\|1Y` | `{data:[{time, price, open, high, low, volume}]}` — 1D is time-bounded to last 24 h of trading |
| GET `/api/price-history/:symbol` | `days` | `{history}` from `price_ticks` |
| GET `/api/energy` | — | Brent + NatGas |
| POST `/api/track` | `{symbol}` | adds symbol to profile + global tracker |
| GET `/api/search` | `q` | Yahoo symbol search |
| GET `/api/live-feed` (SSE) | — | 5-s price ticks filtered to the user's commodities |

**Example** — `GET /api/history?symbol=WHEAT&range=1D`
```json
{ "success": true, "symbol": "WHEAT", "range": "1D",
  "data": [ { "time": "2026-07-16T13:15:00.000Z", "price": 5.4325, "open": 5.44, "high": 5.45, "low": 5.42, "volume": 1250 } ] }
```

## 8.3 Weather / Ports / FX (Command Center)

| Method + URL | Body/Params | Notes |
|---|---|---|
| GET `/api/weather` | — | Live WeatherAPI for `weather_regions`; writes `weather_snapshots` |
| GET `/api/weather-extended` | — | 30-d history + 7-d forecast + analytics for news regions |
| GET `/api/regions/search` | `q` | WeatherAPI location type-ahead |
| POST `/api/weather-regions/add` / `remove` | `{name, country?, lat?, lon?}` / `{name}` | Manages `weather_regions` only |
| GET `/api/ports` | — | Tracked ports + throughput anomaly (recent 7d vs 28-d baseline; status bands; lazy first-ingest) |
| GET `/api/ports/search` | `q` | Static 50-port GCC catalog |
| POST `/api/ports/add` / `remove` | `{portid}` | Validates GCC portid |
| GET `/api/forex` | — | Selected currencies only: `{rates:{AED:{rate, name}}, base:"USD", lastUpdate}`; **503 if `OPEN_EXCHANGE_APP_ID` missing** |
| GET `/api/forex/search` | `q` | 173-currency OXR catalog (keyless), minus already-tracked |
| POST `/api/forex/add` / `remove` | `{code}` | 3-letter code validated against catalog |

## 8.4 News & Alerts

| Method + URL | Params | Notes |
|---|---|---|
| GET `/api/news` | — | Raw profile-query feed `{articles:[{title,url,publishedAt,description,source,via}]}` |
| GET `/api/news/categorized` | — | `{items:[{title,url,source,score,scannedAt,publishedAt,category*,stream,priority,entities,regions}], regionCatalog}` |
| GET `/api/alerts` | — | Active alerts after sort + severity quota |
| POST `/api/analyze` | market payload | Deterministic analysis + alerts view (`detectedAt`) + market indicators (`drivers`, `driversError`) |
| POST `/api/trigger-scan` | — | Fire-and-forget scan; returns `{started, running}` |
| GET `/api/scan-status` | — | `{running, stats, finishedAt}`; falls back to DB-persisted `last_scan_result` after restarts; `known:false` if never scanned |
| GET `/api/pipeline-audit` | — | Per-article audit rows |
| GET `/api/morning-brief` | — | `{priceMovers (vs prevClose), alertCounts, newAlerts, acceptedNews}` |
| POST `/api/feedback` | `{featureName, context, aiResponse, isHelpful, userNotes}` | 👍/👎 store |
| GET `/api/geo-alerts` | — | Recent geopolitical alerts |

## 8.5 AI Endpoints

| Method + URL | Body | Behavior |
|---|---|---|
| POST `/api/analyze-planner` | `{prices, energy, news, weather, forex, weatherExtended, keywords, forceRefresh?}` | Groq 70B, task=planner. Returns exactly 4 recommendations (2×90D + 2×365D). 5xx on failure. |
| POST `/api/analyze-deep-dive` | `{alert}` | Groq 70B, 300–450 words, 3–5 bullets. 503 on parse failure/short output. |
| POST `/api/weather/ai-forecast` | `{region}` | Deterministic yield text (no LLM) |

**Planner response example (truncated):**
```json
{ "success": true, "recommendations": [
  { "horizon": "90D", "action": "Forward-buy 60% of Q4 wheat requirement",
    "rationale": "Black Sea export friction + 12% price rally...", "confidence": "Medium" } ] }
```
**Failure example:** `500 { "error": "Groq llama-3.3-70b-versatile generation failed: rate limit..." }`

## 8.6 Admin 🔒

| Method + URL | Body | Notes |
|---|---|---|
| GET/POST `/api/admin/tuning` | `{semanticThreshold?, rocchioGamma?, extraSeeds?, noiseSeeds?, ...}` | Runtime-only (resets on restart); unchanged values ignored; lists sanitized (≤24 items, ≤300 chars) |
| GET `/api/admin/tuning/seeds-preview/:userId` | — | `{profileSeeds, extraSeeds, effectiveSeeds, effectiveThreshold, noiseSeeds, rocchioGamma}` |
| GET `/api/auth/admin/users` | — | User list for the panel |

## 8.7 Error Code Summary

| Code | Meaning here |
|---|---|
| 400 | Missing/invalid parameter (symbol, portid, currency code, region name) |
| 401 | No/expired session |
| 403 | Not admin |
| 404 | Unknown entity (currency, weather location) |
| 503 | Dependency not configured (missing OXR/Weather key) or AI generation degraded (deep-dive parse failure, all Groq keys rate-limited) |
| 500 | Upstream/API failure with `error` message |
