# 2. Functional Requirements

## 2.1 User Stories

| ID | As a… | I want… | So that… |
|---|---|---|---|
| US-01 | Planner | to sign up, onboard with a template (commodities, regions, focus product/region) | the platform is personalized from day one |
| US-02 | Planner | live prices for *my* tracked commodities vs previous close | I spot moves without a terminal |
| US-03 | Planner | severity-ranked alerts for news touching my supply chain | I act on disruptions early |
| US-04 | Planner | a news feed filtered by stream/category/region/publish-date | I can research a topic quickly |
| US-05 | Procurement | AI recommendations on 90-day and 365-day horizons | I time purchases and hedges |
| US-06 | Planner | an AI deep-dive on any alert ("what does this mean for me?") | I get context without reading 10 articles |
| US-07 | Planner | live weather for locations I choose | I anticipate crop/logistics impact |
| US-08 | Planner | GCC port activity vs baseline | I get early warning of throughput disruption |
| US-09 | Planner | FX spot rates for currencies I select | I track import cost exposure |
| US-10 | Admin | to tune relevance parameters (threshold, γ, seeds) at runtime | precision improves without redeploys |
| US-11 | Admin | to manage users (roles, deletion) | access stays controlled |
| US-12 | Analyst | pipeline audit logs (accept/reject + reason per article) | filtering is explainable and debuggable |

## 2.2 Features (as built)

| Feature | Detail |
|---|---|
| Auth & onboarding | Email/password (bcrypt), session cookie (24 h), onboarding wizard with industry templates |
| Command Center | Price Ticker (vs prev close), Port Congestion (GCC), FX Spot Rates, Live Weather, Market Indicators |
| Alerts | Sources: PROFILE_NEWS, GEO, PRICE. Severity CRITICAL/HIGH/MEDIUM/LOW; display quota (max 1 CRITICAL, 2 HIGH, 1 MEDIUM); Ack; AI summary; "Last time this happened" precedent |
| News feed | Two streams (risk / commodity) + transparency bucket; filters: search, stream, category, region, publish-date (≤24h/7d/30d); entity chips |
| Freshness rules | News alerts suppressed if article published > 24 h ago; alert rows auto-expire 24 h after creation; profile change hides pre-change alerts (`settings_changed_at`) |
| AI Planner | Exactly 4 recommendations: 2 × 90-day, 2 × 365-day (Groq Llama 3.3 70B) |
| Deep-dive | Per-alert analysis, 300–450 words, 3–5 bullets (Groq) |
| Market indicators | 3 drivers with direction/strength/evidence (Gemini 2.5 Flash), 1 h cache keyed by profile + active alerts |
| Market Report | Static GCC industry study (demand index, consumption, food-security, M&A, sector economics) |
| Settings | Commodities, news regions (free-text), keywords, blocklist, focus product/region |
| Admin panel | User role management; runtime tuning: semantic threshold, Rocchio γ, extra seeds, noise seeds; expanded-query preview per user |
| Pipeline Analytics | Per-article accept/reject audit with stage + reason; manual "Run scanner now" with persisted result |
| Email notifications | New CRITICAL/HIGH alerts emailed (nodemailer), gated per user |

## 2.3 Acceptance Criteria (representative)

> **✅ AC — Profile news alert**
> **Given** a user tracks WHEAT and region "Middle East"
> **When** the scanner ingests an article published ≤ 24 h ago that passes stages 1–8 with priority ≥ Medium
> **Then** one alert row is inserted (unique on `user_id + dedup_key`), severity mapped from priority, visible in Alerts tab and Morning Brief, and emailed if severity ≥ HIGH.

> **✅ AC — No-fallback AI**
> **Given** all Groq pool keys are rate-limited
> **When** the planner is requested
> **Then** the API returns an error (5xx with message) and the UI shows the error state. No cached, degraded, or canned recommendations are shown.

> **✅ AC — Publish-date filter**
> **Given** the News tab date filter = "Published ≤ 24h"
> **Then** only articles with a parseable `published_at` within 24 h are listed; articles lacking a publish date are excluded.

> **✅ AC — Price change basis**
> All three surfaces (Price Ticker, SSE live cards, price-anomaly alerts) report change vs **previous close** — one consistent number.

## 2.4 Assumptions

1. Free-tier external sources remain available (Google News RSS, Yahoo Finance unofficial API, WeatherAPI, Open Exchange Rates, IMF PortWatch, Open-Meteo, World Bank).
2. One Render web service instance; in-memory caches are acceptable if backed by DB persistence for critical state (alerts, scan results, audit logs).
3. English-language news is sufficient for the current market.
4. Users belong to at most one customer profile (e.g., Aramtec) whose keywords/regions/seeds graft onto their profile.

## 2.5 Constraints

| Constraint | Consequence |
|---|---|
| Render free tier (spin-down, no cron) | Boot-time `setInterval` scheduling; cold start 30–60 s; scan results persisted to DB (mig. 025) |
| Groq/Gemini free-tier rate limits | Per-key circuit breaker + key-pool rotation; task→key pinning |
| PortWatch weekly refresh (~1 wk lag) | Port panel labeled "weekly, ~1wk lag"; not real-time congestion |
| No dwell-time data exists in PortWatch | Port metric is throughput anomaly (calls vs 28-day baseline), not queue length |
| Yahoo unofficial API | Chart fallback lane + roll-guards for futures contract rolls |
