-- On-demand click-to-summarize cache. Keyed by article URL so any user
-- clicking the same article again (or a repeat scan) is a free DB hit
-- instead of a second Groq call. Groq has no server-side prompt caching,
-- so this table is the substitute.
CREATE TABLE IF NOT EXISTS article_summary_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_url TEXT NOT NULL UNIQUE,
  article_title TEXT,
  summary TEXT,
  impact TEXT,
  action_note TEXT,
  entities_json JSONB DEFAULT '{}',
  model VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
