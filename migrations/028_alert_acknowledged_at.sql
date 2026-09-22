-- Acking an alert freed its quota slot immediately, so the next alert of that
-- severity was promoted on the very next read and the list stayed four items
-- deep. The action looked like it had done nothing.
--
-- Backfill is now held off for a cooldown window, which needs to know WHEN an
-- alert was acknowledged — status alone cannot say.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP WITH TIME ZONE;

-- Rows acknowledged before this column existed get their created_at, which is
-- always older than any cooldown window and so never suppresses a backfill.
-- Leaving them NULL would be read as "acknowledged just now" by a naive query.
UPDATE alerts SET acknowledged_at = created_at
 WHERE status = 'acknowledged' AND acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_alerts_ack_window
    ON alerts (user_id, acknowledged_at)
 WHERE status = 'acknowledged';
