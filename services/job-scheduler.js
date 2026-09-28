// Durable cadence for background jobs.
//
// setInterval is process-local: a container restart resets every timer to zero.
// At the old 30-minute scan cadence that cost at most one skipped window. At
// three hours it is the difference between eight scans a day and none, because
// a couple of revision deploys can keep pushing the next fire time out.
//
// So the timer only decides how often we *ask*. Whether we *run* is decided by
// a timestamp in the job_runs table, which survives restarts.
//
// Dependencies are injected rather than imported so this can be tested without
// a database. server.js passes the db.js implementations.

/**
 * @param {string} jobName      key in job_runs
 * @param {number} intervalMs   minimum gap between runs
 * @param {() => Promise<any>} fn  the job
 * @param {object} deps
 * @param {(name: string) => Promise<number>} deps.getJobRunAgeMs  ms since last run, Infinity if never
 * @param {(name: string, status: string, detail: string|null) => Promise<any>} deps.recordJobRun
 * @param {Console} [deps.logger]
 * @returns {Promise<'ran'|'failed'|'skipped'>}
 */
export async function runJobIfDue(jobName, intervalMs, fn, deps) {
    const { getJobRunAgeMs, recordJobRun, logger = console } = deps;
    const label = jobName.toUpperCase();

    let ageMs = Infinity;
    try {
        ageMs = await getJobRunAgeMs(jobName);
    } catch (e) {
        // Fail open. A scan that runs twice costs duplicate work the article
        // dedupe absorbs; a scan that never runs leaves the alert board stale,
        // which is the failure the user actually notices.
        logger.error(`[${label}] Due-check failed, proceeding with run:`, e.message);
    }

    if (ageMs < intervalMs) {
        logger.log(`[${label}] Not due — last run ${Math.round(ageMs / 60000)} min ago (every ${Math.round(intervalMs / 60000)} min).`);
        return 'skipped';
    }

    // Stamp BEFORE running, not after. These scans take minutes while the check
    // fires hourly; stamping afterwards would let the next check start a second
    // scan while the first is still in flight.
    try {
        await recordJobRun(jobName, 'running', null);
    } catch (e) {
        logger.error(`[${label}] Could not record run start:`, e.message);
    }

    try {
        await fn();
        await recordJobRun(jobName, 'ok', null).catch(() => {});
        return 'ran';
    } catch (e) {
        // The timestamp stands even on failure, so a persistently broken
        // scanner retries on its normal cadence rather than every hour.
        logger.error(`[${label}] Run failed:`, e.message);
        await recordJobRun(jobName, 'failed', e.message).catch(() => {});
        return 'failed';
    }
}
