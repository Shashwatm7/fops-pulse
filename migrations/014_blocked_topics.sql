-- Customer-specific blocked topics (Part 4 of the Aramtec spec), separate
-- from the generic per-product auto-blocklist already in user_profiles.
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS blocked_topics JSONB DEFAULT '[]';

UPDATE customer_profiles SET blocked_topics = '["sports","celebrity","entertainment","fashion","real estate residential","tourism leisure","video game","movie review","music album"]'::jsonb
WHERE id = 'aramtec_001' AND (blocked_topics IS NULL OR blocked_topics = '[]'::jsonb);
