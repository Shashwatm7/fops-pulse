-- Persist the "AI Summary" click on an alert.
--
-- The existing on-demand summariser (/api/article-summary) is article-centric:
-- it is keyed by article URL and caches into article_summary_cache. That covers
-- news alerts, but an alert is not always an article. PRICE alerts and profile
-- alerts routinely carry no url, so the button could not be offered for them at
-- all, and there was nowhere to record a summary that belongs to the ALERT
-- rather than to a link.
--
-- Grain: one row per alert. A regenerate replaces the row rather than appending
-- a second one -- unlike ai_deep_dives, where each generation is kept because
-- feedback is attributed to the exact text rated. Here the alert itself is the
-- stable subject and the newest summary is the only one worth serving.
CREATE TABLE IF NOT EXISTS alert_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    impact TEXT,
    action_note TEXT,
    key_figures_json JSONB DEFAULT '[]',
    entities_json JSONB DEFAULT '{}',
    -- Which source the summary was built from: ARTICLE (the alert's url was
    -- fetched) or ALERT (no url; summarised from the alert's own fields).
    -- Worth recording because the two have materially different quality.
    basis VARCHAR(16) NOT NULL DEFAULT 'ARTICLE',
    model VARCHAR(80),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One summary per alert; the write path upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_summaries_alert
    ON alert_summaries (alert_id);

-- Serves "the summaries this user has generated", newest first.
CREATE INDEX IF NOT EXISTS idx_alert_summaries_user_recent
    ON alert_summaries (user_id, created_at DESC);
