-- pipeline_audit_logs is append-only, and the scanner re-evaluates articles on
-- every run. With no dedupe key, an article whose verdict never changed was
-- re-logged once per user per scan: 118,058 rows collapsed to 25,681 distinct
-- verdicts, so 78% of the table was the same decision repeated.
--
-- The key is the VERDICT, not (user, article): ~4,200 articles legitimately
-- changed verdict between scans as thresholds were tuned, and those rows are
-- the evidence the table exists to provide. A rescan reaching the same verdict
-- is now rejected by the index; one reaching a different verdict still writes.
--
-- NULLS NOT DISTINCT is required, not cosmetic: stage_dropped is NULL on every
-- accepted row and rejection_reason is NULL wherever a stage did not set one.
-- Under default NULLS DISTINCT semantics each of those counts as unique and the
-- index would prevent nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_dedupe
    ON pipeline_audit_logs (user_id, article_url, stage_dropped,
                            rejection_reason, is_accepted, relevance_score)
    NULLS NOT DISTINCT;
