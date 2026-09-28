-- Generalise the demo profile from Aramtec HORECA to chilled/frozen food
-- manufacturing, and fix the seed set that was driving false positives.
--
-- Two separate problems, both visible in Pipeline Analytics on 2026-09-28.
--
-- 1. The ml_seeds were ENTITY-anchored, not concept-anchored. MiniLM matches
--    on the most salient token, which in these seeds was a proper noun, so
--    each false positive traced to one seed by country or brand name:
--      "Netherlands Job Outlook"        0.445 <- "Netherlands dairy exports delayed..."
--      "Dubai hotel occupancy 66%"      0.701 <- "Dubai hotel occupancy reaches record high..."
--      "High rates split Brazil economy" 0.411 <- "Chicken prices rise 15% in Brazil..."
--      "Russia-Ukraine ... Textiles"    0.471 <- "Sunflower oil shortage as Ukraine conflict..."
--    None of those articles is about food supply. They matched on Netherlands,
--    Dubai, Brazil and Ukraine respectively. Meanwhile "Iran's strikes on GCC
--    states could widen war" — squarely relevant to a Gulf food importer —
--    scored 0.293 and was rejected, because it shares no proper noun with any
--    seed.
--
--    The seeds below describe the MECHANISM (a disruption and its effect on
--    supply, cost or availability) and name no countries. Geography is stage
--    4's job; making the seeds carry it too is what coupled "relevant" to
--    "mentions a country we buy from".
--
--    Measured on the 19 headlines from that screenshot plus controls, at the
--    0.30 gate: old seeds 7 false-accepts / 1 miss, new seeds 1 / 1. The three
--    geopolitical seeds at the end exist because real escalation headlines
--    carry no food or shipping vocabulary at all — without them the Iran
--    headline still scored 0.215; with them, 0.489.
--
-- 2. Every multi-word blocked_topic was inert. Stage 3 matched them as literal
--    adjacent phrases, so "tourism leisure" required those two words side by
--    side — which no headline writes. Tourism was explicitly blocked and still
--    got through. Fixed in 3_rule_engine.js (hasBlockedTopic); the entries are
--    rewritten here to match how the words actually appear in print.
--
-- Scope per Sunath (2026-09-28): keep the engine relatable to any food
-- manufacturer we demo to, "Chilled/Frozen Food Manufacturers" rather than
-- Aramtec's food service distribution. Hotel and tourism demand signals are
-- HORECA-specific and are removed with the rest of the Aramtec tilt. A profile
-- that genuinely wants them back can re-add them per customer row.

UPDATE customer_profiles SET
    company = 'Chilled & Frozen Food Manufacturing (demo profile)',
    industry = 'chilled_frozen_food_manufacturing',
    ml_seeds = '[
      "Cold chain failure in transit spoils a chilled consignment, forcing product write-offs",
      "Frozen and cold storage capacity runs short at an import hub, delaying container offloading",
      "Poultry supply tightens after an avian influenza outbreak halts exports from a producing country",
      "Beef and lamb prices climb as reduced slaughter volumes tighten carcass availability",
      "Wheat and flour costs rise after an exporting country restricts grain shipments",
      "Edible oil prices surge as palm and sunflower oil exports are restricted",
      "Dairy commodity prices firm as milk powder and butter output falls in key producing regions",
      "Seafood raw material costs rise after fishing quota cuts reduce landings",
      "Packaging material costs increase as resin, carton and film supply tightens",
      "Shipping lines reroute vessels away from a maritime chokepoint, adding transit days and freight cost",
      "Port congestion extends container dwell times, delaying raw material arrivals at food plants",
      "Container freight rates spike on a major trade lane, raising landed cost of imported ingredients",
      "A food safety recall forces a processor to withdraw product and halt a production line",
      "New import tariffs or food regulations raise the cost of bringing ingredients into the market",
      "Currency depreciation raises the local cost of imported food commodities",
      "Energy and utility cost increases raise operating costs for refrigerated manufacturing and cold storage",
      "Drought or flooding damages a crop, threatening harvest volumes and forward supply",
      "Labour shortage or industrial action at a plant or port disrupts production and dispatch",
      "A supplier plant closure or capacity loss forces manufacturers to find alternative sourcing",
      "Missile strikes and military escalation between states raise the risk of a wider regional war",
      "Attacks on vessels and threats to close a strait disrupt trade through the region",
      "Sanctions, blockade or border closure cut off a trade route used for food imports"
    ]'::jsonb,
    -- Rewritten so each entry matches text as written. "tourism leisure" and
    -- "real estate residential" never fired; "leisure travel" and "residential
    -- real estate" do, and under hasBlockedTopic word order no longer matters.
    blocked_topics = '[
      "sports", "celebrity", "entertainment", "fashion",
      "residential real estate", "property developer",
      "tourism", "leisure travel", "hotel occupancy",
      "video game", "movie review", "music album", "box office"
    ]'::jsonb,
    -- HORECA customer segments are what made tourism look in-scope. A
    -- manufacturer sells to retail and distribution, not to hotel guests.
    customer_segments = '["retail", "wholesale distribution", "food service", "export"]'::jsonb
WHERE id = 'aramtec_001';
