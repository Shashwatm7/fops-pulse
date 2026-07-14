-- Dedicated, user-managed list of weather regions for the Command Center live
-- weather strip. Kept SEPARATE from user_profiles.regions (which drives the
-- region-aware news pipeline) so weather and news are managed independently.
-- Idempotent: safe to re-run on every boot.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS weather_regions JSONB DEFAULT '[]'::jsonb;
