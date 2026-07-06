-- Phase 1: Baseline Engine Schema

-- Table to hold clean historical sales and cost data
CREATE TABLE IF NOT EXISTS sales_history (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    region TEXT NOT NULL,
    category TEXT NOT NULL,
    sku TEXT NOT NULL,
    units_sold NUMERIC NOT NULL,
    revenue NUMERIC NOT NULL,
    unit_price NUMERIC NOT NULL,
    procurement_cost NUMERIC,
    transport_cost NUMERIC,
    margin NUMERIC,
    promo_flag BOOLEAN DEFAULT false,
    stockout_flag BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for fast retrieval by the forecasting scripts and dashboard
CREATE INDEX IF NOT EXISTS idx_sales_history_lookup ON sales_history(region, category, sku, date);
