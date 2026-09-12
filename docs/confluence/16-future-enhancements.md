# 16. Future Enhancements

Ordered by the platform's stated priority: (1) feasibility & data availability, (2) measurable waste/service impact, (3) elegance.

## 16.1 Near Term (weeks)

| Item | Rationale | Notes |
|---|---|---|
| ERP/MES/WMS integration (read) | Recommendations against *actual* inventory/orders is the core product thesis | Start with CSV/API ingest of stock + open POs; map to commodity exposure |
| Golden-set relevance eval | Make threshold/γ changes regression-safe | Label ~200 articles per profile; CI job replays pipeline |
| DB-persisted tuning | Admin tuning currently resets on restart | Move `tuning` store to a table; keep live-read semantics |
| Small-baseline guard on port panel | Kill misleading % on low-traffic ports (< 2 calls/day baseline) | "Low traffic" neutral band |
| Inbound rate limiting + login throttling | Security gap | `express-rate-limit` on auth + AI routes |
| CI gate | Prevent broken pushes to prod | Workflow from page 13 |

## 16.2 Mid Term (quarters)

| Item | Detail |
|---|---|
| **Better forecasting models** | Per-commodity statistical baselines (seasonal naive → SARIMAX/LightGBM) on `price_ticks` + `raw_market_data`; publish with uncertainty ranges; planner consumes forecast + interval, not just spot |
| **Explainable AI** | Every planner rec links its cited alerts/headlines inline (the data chain already exists — surface it in UI); driver evidence chips → source articles |
| **Multi-region support** | Beyond GCC: region packs (sources, catalogs, port lists per geography); PortWatch already global; news queries per region pack |
| **Real-time streaming** | Upgrade poll-based scans to streaming ingest (webhooks/SSE from commercial news API); SSE already exists client-side for prices |
| Waste-reduction module | Tie disruption alerts to shelf-life/stock at risk (needs ERP data) — the FOps core value metric |
| Multi-tenant hardening | Customer-level isolation, per-tenant tuning, SSO |

## 16.3 Long Term

| Item | Detail |
|---|---|
| **Agentic AI** | Scheduled agent runs: monitor → investigate (fetch full articles, cross-check prices/FX) → draft action (PO timing, hedge note) → human approve. Requires audited tool-use layer; the no-fallback + audit-log culture is the right substrate |
| **Scenario simulation** | "What if Hormuz closes / wheat +20% / AED re-pegs": propagate shocks through exposure model to cost & service KPIs; precedent engine provides historical priors |
| Demand-side S&OP loop | Combine market intelligence with customer demand signals for full S&OP (per the FOps product vision) |
| Mobile / notification channels | Push/WhatsApp/Teams for CRITICAL alerts |

## 16.4 Explicit Non-Goals (for now)

- Automated trade execution or autonomous purchasing (human-in-the-loop is a product principle).
- Real-time dwell/queue port data (no free source exists; PortWatch has no dwell field — revisit only with a paid AIS provider).
