ALTER TABLE user_profiles ADD COLUMN custom_blocklist JSONB DEFAULT '[]'::jsonb;
ALTER TABLE user_profiles ADD COLUMN custom_dictionary JSONB DEFAULT '[]'::jsonb;
