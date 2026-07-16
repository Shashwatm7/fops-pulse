-- Persist each user's last profile-scan result so it survives server restarts.
-- Scan stats were kept only in memory (global.scanState); on Render's free tier
-- the instance recycles when idle (and on every redeploy), wiping in-flight
-- state — the status poll then saw no stats and reported "Scan finished with no
-- stats recorded" even though the scan had completed and written alerts/news.
-- Idempotent.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_scan_result JSONB;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ;
