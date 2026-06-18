-- Layer 4 Storage Architecture — Initial Schema
-- PostgreSQL 18 + pgvector

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- ══════════════════════════════════════════════════════════════
-- PILLAR 4: S&OP Database (Postgres) — Core Operational Tables
-- ══════════════════════════════════════════════════════════════

-- Users table (migrated from SQLite)
CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    company_name TEXT DEFAULT '',
    is_admin    BOOLEAN DEFAULT FALSE,
    is_onboarded BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- User profiles (migrated from SQLite, JSON → JSONB)
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    commodities     JSONB NOT NULL DEFAULT '[]',
    regions         JSONB NOT NULL DEFAULT '[]',
    focus_region    TEXT DEFAULT 'Middle East',
    focus_countries JSONB DEFAULT '["UAE","Saudi Arabia","Qatar","Kuwait","Bahrain","Oman","Egypt","Jordan"]',
    focus_product   TEXT DEFAULT 'Frozen Goods',
    news_keywords   JSONB DEFAULT '["frozen food","cold chain","frozen goods"]',
    news_country_codes TEXT DEFAULT 'ae,sa,eg,qa,kw',
    currencies      JSONB DEFAULT '[]',
    template_name   TEXT DEFAULT 'custom',
    custom_regions  JSONB DEFAULT '[]',
    price_alerts    JSONB DEFAULT '[]'
);

-- Session store for connect-pg-simple
CREATE TABLE IF NOT EXISTS session (
    sid     VARCHAR NOT NULL COLLATE "default",
    sess    JSON NOT NULL,
    expire  TIMESTAMP(6) NOT NULL,
    PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);

-- S&OP Plans (NEW — operational plans with actuals tracking)
CREATE TABLE IF NOT EXISTS sop_plans (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    commodity    TEXT NOT NULL,
    region       TEXT NOT NULL,
    plan_type    TEXT DEFAULT 'procurement',  -- procurement, logistics, inventory
    target_value NUMERIC,
    actual_value NUMERIC,
    variance     NUMERIC GENERATED ALWAYS AS (actual_value - target_value) STORED,
    notes        TEXT DEFAULT '',
    period_start DATE NOT NULL,
    period_end   DATE NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sop_plans_user ON sop_plans (user_id);
CREATE INDEX IF NOT EXISTS idx_sop_plans_commodity ON sop_plans (commodity);

-- ══════════════════════════════════════════════════════════════
-- PILLAR 2: Structured Event DB (TimescaleDB substitute)
-- Using BRIN indexes for time-series performance
-- ══════════════════════════════════════════════════════════════

-- Price ticks — every 5-second snapshot of commodity prices
CREATE TABLE IF NOT EXISTS price_ticks (
    id          BIGSERIAL PRIMARY KEY,
    symbol      TEXT NOT NULL,
    price       NUMERIC NOT NULL,
    change_pct  NUMERIC DEFAULT 0,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_ticks_time ON price_ticks USING BRIN (recorded_at);
CREATE INDEX IF NOT EXISTS idx_price_ticks_symbol ON price_ticks (symbol);

-- Weather snapshots — periodic weather readings per region
CREATE TABLE IF NOT EXISTS weather_snapshots (
    id          BIGSERIAL PRIMARY KEY,
    region_name TEXT NOT NULL,
    lat         NUMERIC,
    lon         NUMERIC,
    temp_c      NUMERIC,
    precip_mm   NUMERIC DEFAULT 0,
    humidity    NUMERIC,
    wind_kph    NUMERIC,
    condition   TEXT,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_weather_time ON weather_snapshots USING BRIN (recorded_at);
CREATE INDEX IF NOT EXISTS idx_weather_region ON weather_snapshots (region_name);

-- ══════════════════════════════════════════════════════════════
-- PILLAR 3: Vector Database (Pinecone substitute)
-- Using pgvector for embedding similarity search
-- ══════════════════════════════════════════════════════════════

-- News embeddings — articles + vector for semantic search
CREATE TABLE IF NOT EXISTS news_embeddings (
    id           BIGSERIAL PRIMARY KEY,
    article_url  TEXT UNIQUE,
    title        TEXT NOT NULL,
    summary      TEXT,
    source       TEXT,
    published_at TIMESTAMPTZ,
    embedding    vector(768),  -- Gemini text-embedding-004 outputs 768 dimensions
    region       TEXT,
    commodity    TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_news_embedding ON news_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
CREATE INDEX IF NOT EXISTS idx_news_time ON news_embeddings USING BRIN (created_at);
