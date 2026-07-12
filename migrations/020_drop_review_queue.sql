-- Remove the dead labeling review-queue plumbing. Scan-time LLM labeling was
-- disabled (ingestion is fully rule-based), so nothing ever wrote to these
-- tables and no UI read them: review_queue and training_data were empty
-- everywhere, and insight_entities never had a writer at all. The endpoints
-- and DB functions are removed in the same commit. article_insights is KEPT —
-- the planner still reads it (TIER 1 news intelligence).
-- Order matters: review_queue references training_data.
DROP TABLE IF EXISTS review_queue;
DROP TABLE IF EXISTS training_data;
DROP TABLE IF EXISTS insight_entities;
