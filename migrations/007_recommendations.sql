-- Phase 5: Recommendation Engine Schema

CREATE TABLE IF NOT EXISTS recommendations (
    rec_id TEXT PRIMARY KEY,
    generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    category TEXT NOT NULL,
    sku TEXT NOT NULL,
    region TEXT NOT NULL,
    horizon_days INTEGER NOT NULL,
    scenario_type TEXT NOT NULL,
    priority TEXT NOT NULL,
    predicted_demand_impact_pct NUMERIC,
    predicted_cost_impact_pct NUMERIC,
    confidence NUMERIC,
    actions_json JSONB,
    drivers_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_recommendations_lookup ON recommendations(category, sku, region, generated_at DESC);
