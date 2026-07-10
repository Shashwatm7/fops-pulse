-- Richer on-demand summaries (v2 prompt): add a column for the extracted
-- key_figures list, and bust the cache once so summaries written by the old
-- thin prompt (snippet-only, no key_figures, 2-3 sentences) regenerate with
-- the new one (stripped article body, 3-5 sentences, key_figures).
ALTER TABLE article_summary_cache ADD COLUMN IF NOT EXISTS key_figures_json JSONB DEFAULT '[]';

-- One-time bust: delete everything cached before the v2 prompt shipped. Fixed
-- cutoff so this is idempotent on every future migration run (nothing before
-- the cutoff survives the first pass). Do not change the cutoff on later deploys.
DELETE FROM article_summary_cache WHERE created_at < '2026-07-10 00:00:00+00'::timestamptz;
