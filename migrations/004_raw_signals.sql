-- Phase 2: Raw Signal Ingestion Schema

CREATE TABLE IF NOT EXISTS raw_news_articles (
    article_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT,
    published_at TIMESTAMP WITH TIME ZONE NOT NULL,
    raw_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_weather (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    region TEXT NOT NULL,
    max_temp NUMERIC,
    min_temp NUMERIC,
    rain NUMERIC,
    humidity NUMERIC,
    raw_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_weather_date_region ON raw_weather(date, region);

CREATE TABLE IF NOT EXISTS raw_market_data (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    source TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    category TEXT,
    region TEXT,
    value NUMERIC NOT NULL,
    raw_json JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_market_data_lookup ON raw_market_data(date, source, metric_name, category, region);
