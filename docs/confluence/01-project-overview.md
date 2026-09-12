# 1. Project Overview

## 1.1 Vision

Give every planner in a GCC food-manufacturing supply chain a single, live, **commodity- and region-specific intelligence layer** — so procurement and S&OP decisions are made on today's market reality, not last week's spreadsheet.

## 1.2 Business Problem

> **⚠️ Problem statement**
> Food manufacturers in the GCC import the majority of their inputs (grains, protein, dairy, oils, packaging). The signals that move their cost and supply — commodity prices, FX, port throughput, weather, geopolitics, trade policy — are scattered across dozens of sources. Planners either miss events entirely or find them days late. Generic news alerting (keyword-based) drowns them in irrelevant noise.

Concrete pains:

| Persona | Pain |
|---|---|
| Procurement / buyer | Learns of a price spike or export ban after the market has moved |
| Demand / supply planner | No structured view of supply-disruption risk touching their lanes |
| S&OP manager | Market context assembled manually for every cycle |
| Supply Chain Director | No defensible, auditable "why" behind buy/hedge decisions |

## 1.3 Solution Overview

FOps Pulse is a web platform that:

1. **Ingests** news (Google News RSS + curated feeds), commodity prices (Yahoo Finance), FX spot rates (Open Exchange Rates), live weather (WeatherAPI), port activity (IMF PortWatch), and macro data (World Bank).
2. **Filters news per user profile** through a 9-stage relevance pipeline (keywords → region gate → scoring → local MiniLM semantic filter) so each user sees only what touches *their* commodities and regions.
3. **Raises alerts** (severity-scored, deduplicated, 24-hour freshness) and a categorized news feed.
4. **Generates AI outputs** — market indicators, article deep-dives, and a procurement planner producing 90-day and 365-day recommendations — via Groq (Llama 3.3 70B) and Gemini 2.5 Flash. **No-fallback policy:** if generation fails, the UI shows an error, never canned text.
5. **Displays** everything in a React dashboard: Command Center (prices, ports, FX, weather, indicators), Alerts + News, Market Report (GCC industry study), Recommendations.

## 1.4 Objectives

| # | Objective | Measure |
|---|---|---|
| O1 | Cut time-to-awareness of supply-relevant events | Event published → alert visible < 1 scan interval |
| O2 | High alert precision (signal over noise) | Acceptance rate of pipeline + user feedback (👍/👎) |
| O3 | Decision support, not just news | ≥ 4 actionable planner recommendations per cycle (2×90D, 2×365D) |
| O4 | Near-zero marginal data cost | All external sources on free tiers |

## 1.5 Success Metrics

- **Alert precision:** % of surfaced alerts rated relevant (via `ai_feedback` + Ack behavior).
- **Freshness:** 100% of news alerts based on articles published ≤ 24 h before alerting.
- **Coverage:** every tracked commodity/region produces candidate articles per scan (visible in Pipeline Analytics).
- **Engagement:** planners open Command Center daily; recommendations acknowledged.

## 1.6 Scope

**In scope (current):** GCC food manufacturing; news/price/FX/weather/port intelligence; per-user profiles; AI planner, deep-dive, market indicators; admin tuning panel; email alerting (nodemailer).
**Out of scope (current):** ERP/MES write-back, automated purchasing, demand forecasting from customer order data, mobile app, multi-tenant customer isolation beyond profile grafting.

## 1.7 Stakeholders

| Role | Interest |
|---|---|
| Supply / demand planners | Daily users — alerts, news, prices |
| Procurement teams | Planner recommendations, FX, price anomalies |
| S&OP managers / SC Directors | Market Report, trend context, auditability |
| Business analysts | Pipeline Analytics, tuning, data quality |
| Platform admin | User management, relevance tuning (threshold, seeds, γ) |
