CREATE TABLE IF NOT EXISTS ai_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    feature_name VARCHAR(50) NOT NULL,
    context JSONB,
    ai_response TEXT NOT NULL,
    is_helpful BOOLEAN NOT NULL,
    user_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
