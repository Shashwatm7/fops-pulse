-- One-time cache bust: summaries generated before the prompt was tightened
-- for specificity (numbers/dates/named entities, banned generic filler)
-- would otherwise keep serving forever, since the cache never re-generates
-- an existing URL. Cutoff is a fixed timestamp so this is idempotent on
-- every future migration run (nothing before the cutoff remains to delete
-- after the first pass) — do not change the cutoff on subsequent deploys.
DELETE FROM article_summary_cache WHERE created_at < '2026-07-09 00:00:00+00'::timestamptz;
