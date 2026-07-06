-- Unified persistent alert store. All alert sources (geo scanner, profile
-- news scanner, price thresholds) write per-user rows here instead of
-- in-memory caches, so alerts survive restarts/spin-downs and duplicate
-- suppression no longer depends on the container filesystem.
CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,                    -- GEO | PROFILE_NEWS | PRICE
    category TEXT,
    severity TEXT NOT NULL,                  -- CRITICAL | HIGH | MEDIUM | LOW
    title TEXT NOT NULL,
    reason TEXT,
    url TEXT,
    relevance_score NUMERIC,                 -- event x exposure score (0-100)
    payload JSONB,
    dedup_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',   -- active | acknowledged | expired
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_user_dedup ON alerts(user_id, dedup_key);
CREATE INDEX IF NOT EXISTS idx_alerts_user_status ON alerts(user_id, status, created_at DESC);
