-- Article labeling system: LLM-generated training labels + insights, with a
-- human-review queue. Anchored to pipeline_audit_logs (the existing record of
-- every scanned article) rather than a new articles table. pgvector is already
-- enabled (migration 001). MiniLM embeddings are 384-dim.

-- Training data: one row per labeled article, embedding + LLM label.
-- category allowed values (commodity supply-chain domain, not enforced by a
-- CHECK so the taxonomy can evolve without a migration):
--   export_ban, trade_policy, drought_weather, livestock_disease,
--   chokepoint_disruption, energy_shock, harvest_yield, price_move,
--   labor_disruption, other
CREATE TABLE IF NOT EXISTS training_data (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_log_id  INTEGER REFERENCES pipeline_audit_logs(id) ON DELETE CASCADE,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text_snippet  TEXT,
    embedding     vector(384),
    relevant      SMALLINT,
    category      VARCHAR(50),
    priority      VARCHAR(10),
    confidence    FLOAT,
    source        VARCHAR(20) DEFAULT 'llm_auto',   -- llm_auto | human_reviewed
    human_label   SMALLINT DEFAULT NULL,
    needs_review  BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_training_needs_review ON training_data(needs_review) WHERE needs_review = TRUE;
CREATE INDEX IF NOT EXISTS idx_training_audit ON training_data(audit_log_id);
CREATE INDEX IF NOT EXISTS idx_training_source ON training_data(source);

CREATE TABLE IF NOT EXISTS article_insights (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_log_id    INTEGER REFERENCES pipeline_audit_logs(id) ON DELETE CASCADE,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    summary         TEXT,
    sentiment       VARCHAR(10),   -- positive | negative | neutral
    threat_level    VARCHAR(10),   -- high | medium | low | none
    opportunity     VARCHAR(10),   -- high | medium | low | none
    action_required BOOLEAN,
    action_note     TEXT,
    category        VARCHAR(50),
    priority        VARCHAR(10),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_insights_audit ON article_insights(audit_log_id);

CREATE TABLE IF NOT EXISTS insight_entities (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_id   UUID REFERENCES article_insights(id) ON DELETE CASCADE,
    entity_type  VARCHAR(20),   -- commodity | region | organization | policy
    name         VARCHAR(255),
    role         VARCHAR(50),   -- e.g. producer | importer | exporter | disruptor | affected
    detail       VARCHAR(255),  -- free-form context (title/company/action equivalent)
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entities_insight ON insight_entities(insight_id);

CREATE TABLE IF NOT EXISTS review_queue (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_log_id INTEGER REFERENCES pipeline_audit_logs(id) ON DELETE CASCADE,
    training_id  UUID REFERENCES training_data(id) ON DELETE CASCADE,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title        TEXT,
    snippet      TEXT,
    llm_label    JSONB,
    human_label  JSONB DEFAULT NULL,
    reviewed     BOOLEAN DEFAULT FALSE,
    reviewed_by  VARCHAR(100),
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_review_pending ON review_queue(reviewed, created_at);
