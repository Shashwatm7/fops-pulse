-- Carry the article's PUBLISH date into the pipeline audit log so the
-- categorized news feed can filter by date of publishing, and so alert
-- freshness can be judged on when the story was published (not just when the
-- scan ran). Existing rows stay NULL until re-scanned. Idempotent.
ALTER TABLE pipeline_audit_logs ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_audit_published_at ON pipeline_audit_logs (user_id, published_at DESC);
