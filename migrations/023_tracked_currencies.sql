-- User-managed FX watchlist for the Command Center "FX Spot Rates" panel.
-- A list of currency codes (e.g. ["AED","EUR"]) the user wants to see, mirroring
-- the tracked_ports / weather_regions pattern. Default is a small GCC + major-
-- supplier set so the panel is useful but not overflowing on first load.
-- Idempotent: safe to re-run on every boot.
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS tracked_currencies JSONB DEFAULT '["AED","SAR","EUR","INR","BRL","CNY"]'::jsonb;
