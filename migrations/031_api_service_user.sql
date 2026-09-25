-- Provision the API-key service identity.
--
-- requireAuth's key lane resolves API_KEY_USER_EMAIL to a real users row and
-- refuses with 503 "API key is valid but API_KEY_USER_EMAIL names no existing
-- user" when it cannot. That row was created by hand on the original
-- environment and never anywhere else, so every new environment authenticates
-- the key correctly and then fails — which is exactly what happened on dev:
-- valid key, working APIM route, 503 on every call, and no way to fix it
-- without database or container access to that estate.
--
-- Seeding it here makes the service identity part of the schema rather than a
-- manual step, so it exists wherever migrations run.
--
-- The email is the documented default for API_KEY_USER_EMAIL. An environment
-- that overrides that variable to something else still needs its own row.

-- password_hash is deliberately NOT a bcrypt hash. bcryptjs compare() returns
-- false for a malformed hash rather than throwing (verified), so no password
-- can ever match and this account cannot be used through the interactive login
-- form — it is reachable only via an API key. NOT NULL forces a value here, so
-- a sentinel is used rather than leaving it empty.
--
-- is_admin is pinned FALSE. Signup would have made this account an admin
-- automatically in an empty database (first user wins), which is precisely the
-- hazard that made provisioning it by hand risky.
INSERT INTO users (username, email, password_hash, company_name, is_admin, is_onboarded)
SELECT 'fops-api-service',
       'fops-api-service@drizzla.com',
       '!no-interactive-login',
       'Drizzla',
       FALSE,
       TRUE
WHERE NOT EXISTS (
    SELECT 1 FROM users
    WHERE LOWER(email) = LOWER('fops-api-service@drizzla.com')
       OR username = 'fops-api-service'
);

-- Profile derived from the Aramtec customer row seeded in 012, rather than a
-- copy of its keyword list pasted here. Same source, so the service identity
-- returns the same shape of data as a human account linked to that customer,
-- and it stays correct if that row is later edited.
INSERT INTO user_profiles (user_id, customer_id, focus_region, focus_product,
                           regions, news_keywords, template_name)
SELECT u.id,
       c.id,
       c.region,
       c.industry,
       COALESCE(c.key_ports, '[]'::jsonb) || COALESCE(c.supplier_countries, '[]'::jsonb),
       COALESCE(c.signal_keywords, '[]'::jsonb),
       'customer:' || c.id
FROM users u
JOIN customer_profiles c ON c.id = 'aramtec_001'
WHERE LOWER(u.email) = LOWER('fops-api-service@drizzla.com')
ON CONFLICT (user_id) DO NOTHING;

-- Fallback: if that customer row is absent, the join above inserts nothing and
-- the account would have no profile at all. getUserProfile returns null then,
-- and handlers reading req.userProfile.commodities would throw. Table defaults
-- are thin but valid.
INSERT INTO user_profiles (user_id)
SELECT u.id FROM users u
WHERE LOWER(u.email) = LOWER('fops-api-service@drizzla.com')
ON CONFLICT (user_id) DO NOTHING;
