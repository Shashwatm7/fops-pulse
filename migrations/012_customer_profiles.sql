-- Customer (company) profiles — a DB-driven layer above per-user profiles so
-- onboarding a new distributor is a single INSERT. Kept SEPARATE from the
-- existing user_profiles table (which is keyed by users.id and drives auth);
-- a user is linked to a customer via user_profiles.customer_id.
CREATE TABLE IF NOT EXISTS customer_profiles (
    id                TEXT PRIMARY KEY,
    company           TEXT NOT NULL,
    industry          TEXT,
    region            TEXT,
    key_ports         JSONB DEFAULT '[]',
    key_routes        JSONB DEFAULT '[]',
    commodities       JSONB DEFAULT '[]',   -- food-service products (news terms, NOT price symbols)
    supplier_countries JSONB DEFAULT '[]',
    customer_segments JSONB DEFAULT '[]',
    signal_keywords   JSONB DEFAULT '[]',   -- union of logistics/commodity/geopolitical/demand/risk terms
    ml_seeds          JSONB DEFAULT '[]',   -- positive examples for the semantic filter
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Link users to a customer. Nullable so the pre-existing per-user model still
-- works for anyone not attached to a customer.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS customer_id TEXT REFERENCES customer_profiles(id) ON DELETE SET NULL;

-- Seed Aramtec. ON CONFLICT DO NOTHING keeps this idempotent across the
-- migrate-on-every-boot model; edit via UPDATE later, not by re-running.
INSERT INTO customer_profiles (id, company, industry, region, key_ports, key_routes, commodities, supplier_countries, customer_segments, signal_keywords, ml_seeds)
VALUES (
  'aramtec_001',
  'Aramtec Food Service',
  'food_service_distribution',
  'UAE / GCC / Middle East',
  '["Jebel Ali","Port Said","Port of Salalah","Port of Dammam","Suez Canal"]',
  '["Europe to UAE","South America to UAE","Southeast Asia to UAE","Red Sea route","Cape of Good Hope route"]',
  '["chicken","beef","seafood","lamb","wheat","flour","rice","cheese","butter","milk powder","sunflower oil","palm oil","frozen vegetables","packaged foods"]',
  '["Brazil","Netherlands","France","Spain","Australia","India","Thailand","USA","Ukraine","Poland","New Zealand"]',
  '["hotels","restaurants","catering companies","hospital food service","airline catering"]',
  '["suez canal","red sea","jebel ali","port congestion","shipping delay","container shortage","freight rate","vessel delay","port strike","rerouting","cape of good hope","supply disruption","cold chain","chicken price","beef price","seafood","poultry","wheat price","flour shortage","rice supply","dairy prices","cheese shortage","butter prices","sunflower oil","palm oil","edible oil","food inflation","commodity prices","crop yield","harvest shortage","drought impact","middle east","uae","gcc","sanctions","trade war","tariffs","houthi","strait of hormuz","iran","ukraine wheat","russia grain","export ban","food security","trade route","ramadan","eid","hotel occupancy","restaurant demand","food service","catering demand","tourism uae","recall","contamination","food safety","supplier bankruptcy","factory fire","flood","drought","hurricane","earthquake","currency devaluation","usd rate"]',
  '["Suez Canal congestion causing 12-day delays on Europe to UAE routes","Jebel Ali port reports container backlog due to Red Sea rerouting","Chicken prices rise 15% in Brazil after avian flu outbreak","Ukraine wheat export halt raises flour prices across Middle East","Houthi attacks force shipping lines to reroute via Cape of Good Hope","UAE food inflation hits 8% driven by imported food price surge","Port Said congestion affecting cold chain imports to GCC","Sunflower oil shortage as Ukraine conflict disrupts exports","Dubai hotel occupancy reaches record high ahead of Ramadan season","Freight rates on Asia-Europe route surge 40% on container shortage","Brazil beef exports disrupted by truckers strike","Netherlands dairy exports delayed due to port worker strike","UAE government increases food security stockpile reserves","Thailand floods damage rice crop threatening GCC supply","Cold storage capacity at Jebel Ali running at 95% utilization","Ramadan demand spike expected — food distributors advised to stock early","Saudi Arabia bans poultry imports from Poland over bird flu","Indian onion export ban affects UAE food service supply chain","Maersk reroutes 30 vessels away from Red Sea to Cape route","GCC food import costs rise as USD strengthens against EUR and BRL"]'
)
ON CONFLICT (id) DO NOTHING;

-- One-customer phase: adopt existing profiles that aren't linked yet. Only
-- ever fills NULLs, so once a user is assigned it is never overwritten. When a
-- second customer is added, assign new users explicitly instead.
UPDATE user_profiles SET customer_id = 'aramtec_001' WHERE customer_id IS NULL;
