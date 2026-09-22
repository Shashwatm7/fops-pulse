-- Persist "Request AI Deep Dive" output.
--
-- Until now a deep dive was generated, streamed to the browser and thrown
-- away. Clicking Regenerate — or reloading the page — burned another ~3000
-- output tokens to produce near-identical text, and nothing on the server
-- could answer "what did we tell this user last Tuesday". Feedback rows in
-- ai_feedback referenced deep dives that no longer existed anywhere.
--
-- Grain: one row per generated deep dive (user x timeframe x generation).
-- Not deduped — regenerations are intentionally kept as separate rows so the
-- feedback history stays attributable to the exact text the user rated.
CREATE TABLE IF NOT EXISTS ai_deep_dives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    timeframe VARCHAR(16) NOT NULL DEFAULT '90D',
    deterministic_action TEXT,
    deep_dive TEXT NOT NULL,
    model VARCHAR(80),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Supports "latest deep dive for this user", the only read pattern.
CREATE INDEX IF NOT EXISTS idx_deep_dives_user_recent
    ON ai_deep_dives (user_id, created_at DESC);

-- Ties a rating to the exact deep dive text it was given for. Nullable:
-- RECOMMENDATION feedback has no deep dive, and rows predating this column
-- keep NULL rather than being guessed at.
ALTER TABLE ai_feedback ADD COLUMN IF NOT EXISTS deep_dive_id UUID
    REFERENCES ai_deep_dives(id) ON DELETE SET NULL;
