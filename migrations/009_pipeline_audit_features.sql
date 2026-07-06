-- The pipeline audit INSERT (db.js insertPipelineAuditLog) writes an
-- extracted_features column, but the original 008 table definition never
-- created it. On existing deployments the table already exists, so
-- CREATE TABLE IF NOT EXISTS in 008 cannot add the column — every insert
-- failed silently and the Pipeline Analytics page stayed empty.
-- This migration backfills the column on existing databases.
ALTER TABLE pipeline_audit_logs ADD COLUMN IF NOT EXISTS extracted_features JSONB;
