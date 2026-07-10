-- v2 summaries could contain hallucinated figures: alert URLs were Google
-- News redirect wrappers (no article text behind them), so the model was
-- summarizing a bare title while being instructed to produce hard numbers.
-- v3 resolves the real article URL, forbids ungrounded figures, and filters
-- key_figures against the actual input. Bust everything cached before v3
-- shipped so no invented facts keep being served. Fixed cutoff = idempotent.
DELETE FROM article_summary_cache WHERE created_at < '2026-07-10 17:00:00+00'::timestamptz;
