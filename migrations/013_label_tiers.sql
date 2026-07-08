-- Stage B: severity + gold/silver/bronze tiering + richer insight storage.
ALTER TABLE training_data ADD COLUMN IF NOT EXISTS label_tier VARCHAR(10);  -- gold | silver | bronze
ALTER TABLE training_data ADD COLUMN IF NOT EXISTS severity   VARCHAR(10);  -- critical | high | medium | low

ALTER TABLE article_insights ADD COLUMN IF NOT EXISTS severity     VARCHAR(10);
ALTER TABLE article_insights ADD COLUMN IF NOT EXISTS urgency      VARCHAR(20);
ALTER TABLE article_insights ADD COLUMN IF NOT EXISTS insight_json JSONB;   -- full Aramtec-shaped insight

CREATE INDEX IF NOT EXISTS idx_training_tier ON training_data(label_tier);
