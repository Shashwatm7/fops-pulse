-- Durable record of when each background job last ran.
--
-- The scanners are scheduled with setInterval, which is process-local: every
-- container restart (revision deploy, platform move, crash) resets the timer to
-- zero. At the old 30-minute cadence that cost at most one skipped window. At a
-- 3-hour cadence a deploy can push the next scan a full 3 hours out, and a
-- couple of deploys in a day mean the geo scanner never fires at all.
--
-- The user scanner already had a due-check, but it read MAX(scanned_at) FROM
-- pipeline_audit_logs — a side-effect table, not a schedule. That breaks in two
-- ways: the geo scanner writes nothing there at all, and once 027's dedupe
-- index is in place a scan whose verdicts are all unchanged inserts no rows, so
-- the timestamp stops advancing and the job re-runs on every check forever.
--
-- One row per job, stamped unconditionally whether the run found anything.
CREATE TABLE IF NOT EXISTS job_runs (
    job_name     VARCHAR(64) PRIMARY KEY,
    last_run_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_status  VARCHAR(16),
    last_detail  TEXT
);

-- Seed the user scanner from the audit log it used to gate on, so upgrading
-- does not look like "never run" and trigger an immediate scan on the first
-- boot after deploy. The geo scanner has no such history and is left absent,
-- which reads as due — correct, since nothing durable says it ever ran.
INSERT INTO job_runs (job_name, last_run_at, last_status, last_detail)
SELECT 'user-scanner', MAX(scanned_at), 'ok', 'backfilled from pipeline_audit_logs'
FROM pipeline_audit_logs
WHERE scanned_at IS NOT NULL
-- An aggregate over no rows still returns one row, of NULLs, which would violate
-- the NOT NULL on last_run_at. HAVING suppresses that row entirely.
HAVING MAX(scanned_at) IS NOT NULL
ON CONFLICT (job_name) DO NOTHING;
