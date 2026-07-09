-- When a user materially changes their profile (region/commodity/focus),
-- alerts and labeled insights generated against the OLD profile should stop
-- showing — without deleting them (they remain ML training data and history).
-- This timestamp is the cutoff: display queries only return rows created at
-- or after it. NULL means "never changed" → show everything (existing users
-- are unaffected until their first material change).
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS settings_changed_at TIMESTAMPTZ;
