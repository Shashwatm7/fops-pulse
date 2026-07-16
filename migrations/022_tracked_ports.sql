-- Port Congestion (GCC) — Command Center panel.
-- Two pieces, mirroring the weather-strip pattern (migration 021 + weather_snapshots):
--   1. user_profiles.tracked_ports: the user's live-managed list of ports.
--   2. port_activity_snapshots: cached daily IMF PortWatch activity per port.
-- The metric is port-call / trade-volume THROUGHPUT (from satellite AIS port
-- counts), NOT queue/dwell time — PortWatch does not publish dwell. The UI
-- surfaces a throughput anomaly (recent vs trailing baseline) as a disruption
-- proxy. Idempotent: safe to re-run on every boot.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS tracked_ports JSONB DEFAULT '[]'::jsonb;

-- Grain: one row per portid per date (daily PortWatch observation).
CREATE TABLE IF NOT EXISTS port_activity_snapshots (
    id            SERIAL PRIMARY KEY,
    portid        TEXT NOT NULL,
    portname      TEXT,
    country       TEXT,
    iso3          TEXT,
    activity_date DATE NOT NULL,
    portcalls           INTEGER,
    portcalls_container INTEGER,
    import_tons         BIGINT,
    export_tons         BIGINT,
    fetched_at    TIMESTAMPTZ DEFAULT now(),
    UNIQUE (portid, activity_date)
);

CREATE INDEX IF NOT EXISTS idx_port_activity_portid_date
    ON port_activity_snapshots (portid, activity_date DESC);
