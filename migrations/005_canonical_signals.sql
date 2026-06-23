-- Phase 3: Canonical Signal Layer Schema

CREATE TABLE IF NOT EXISTS market_signals (
    signal_id TEXT PRIMARY KEY,
    date DATE NOT NULL,
    source_type TEXT NOT NULL,
    category TEXT NOT NULL,
    sku TEXT,
    region TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    impact_side TEXT NOT NULL,
    impact_direction TEXT NOT NULL,
    severity NUMERIC NOT NULL,
    confidence NUMERIC NOT NULL,
    horizon_days INTEGER NOT NULL,
    evidence_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for the forecasting engine to quickly pull active signals by date and category
CREATE INDEX IF NOT EXISTS idx_market_signals_lookup ON market_signals(date, category, region);
