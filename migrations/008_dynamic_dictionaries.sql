-- IF NOT EXISTS is required: migrations re-run on every deploy, and the
-- non-idempotent version of this file threw "column already exists" on
-- every boot, aborting the migration loop before later files could run.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS custom_blocklist JSONB DEFAULT '[]'::jsonb;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS custom_dictionary JSONB DEFAULT '[]'::jsonb;
