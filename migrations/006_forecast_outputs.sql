-- Phase 4: Event-Aware Forecast Adjustment Schema

CREATE TABLE IF NOT EXISTS forecast_outputs (
    id SERIAL PRIMARY KEY,
    forecast_date DATE NOT NULL,
    category TEXT NOT NULL,
    sku TEXT NOT NULL,
    region TEXT NOT NULL,
    horizon_days INTEGER NOT NULL,
    baseline_demand NUMERIC NOT NULL,
    adjusted_demand NUMERIC NOT NULL,
    baseline_cost NUMERIC NOT NULL,
    adjusted_cost NUMERIC NOT NULL,
    demand_score NUMERIC DEFAULT 0,
    cost_score NUMERIC DEFAULT 0,
    supply_score NUMERIC DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for the dashboard/recommendation engine
CREATE INDEX IF NOT EXISTS idx_forecast_outputs_lookup ON forecast_outputs(region, category, sku, forecast_date, horizon_days);
