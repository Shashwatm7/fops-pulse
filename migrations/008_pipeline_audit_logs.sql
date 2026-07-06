CREATE TABLE IF NOT EXISTS pipeline_audit_logs (
    id SERIAL PRIMARY KEY,
    article_title TEXT NOT NULL,
    article_url TEXT,
    source TEXT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage_dropped NUMERIC,
    rejection_reason TEXT,
    relevance_score NUMERIC,
    is_accepted BOOLEAN DEFAULT FALSE,
    extracted_features JSONB,
    scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_user_scanned ON pipeline_audit_logs(user_id, scanned_at DESC);
