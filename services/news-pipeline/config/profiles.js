// ── Shared term groups ─────────────────────────────────────────────────
// Business terms are grouped by supply-chain domain so every commodity gets a
// full context vocabulary instead of the old per-profile copy-paste subsets.
const CORE_BUSINESS = ["price", "prices", "production", "trade", "imports", "exports", "export", "import", "logistics", "supply chain", "shortage", "demand", "cost", "costs", "tariff", "regulation", "freight", "shipment", "shipping", "inventory", "stockpile", "supply", "futures", "market"];
const AGRI_BUSINESS = [...CORE_BUSINESS, "yield", "drought", "harvest", "crop", "weather", "subsidy", "fertilizer", "planting", "acreage", "flood"];
const LIVESTOCK_BUSINESS = [...CORE_BUSINESS, "feed cost", "feed costs", "feed", "farm", "disease", "outbreak", "slaughter", "herd", "vaccination", "culling"];
const DAIRY_BUSINESS = [...CORE_BUSINESS, "farm", "feed", "processing", "factory", "inflation", "yield"];
const METALS_BUSINESS = [...CORE_BUSINESS, "mining", "mine", "smelter", "refining", "reserves", "ore"];
const ENERGY_BUSINESS = [...CORE_BUSINESS, "reserves", "pipeline", "drilling", "rig", "sanctions", "geopolitics", "opec"];

const FOOD_EXCLUDED = ["recipes", "recipe", "cooking tips", "diet", "health advice", "nutrition advice", "restaurant review", "gardening tips", "home garden", "baking", "menu", "cafe", "bistro"];

// ── Global noise exclusions ────────────────────────────────────────────
// Applied to EVERY profile: topics that are never supply-chain intelligence
// regardless of which commodity words they happen to contain (the "Cold
// Storage - Box Office Mojo" class of false positive). Multi-word phrases
// preferred so we never exclude a legitimate business article.
export const GLOBAL_EXCLUDED_CONTEXTS = [
  "box office", "movie review", "film review", "film festival", "showtimes",
  "celebrity", "horoscope", "lottery", "video game", "esports", "sitcom",
  "movie trailer", "album review", "funeral", "obituary", "match highlights",
  "box-office",
];

// ── Metaphor masks ─────────────────────────────────────────────────────
// Phrases where a commodity word appears in a non-commodity sense. These are
// MASKED (hidden from commodity matching) rather than hard-excluded, so a
// genuine gold-market article that also says "gold rush" is not rejected —
// it just can't match on that phrase alone.
export const MASKED_PHRASES = [
  "gold rush", "gold sponsor", "gold medal", "gold medals", "gold standard",
  "silver lining", "silver bullet", "silver screen", "silver medal",
  "platinum album", "platinum record", "platinum jubilee", "platinum sponsor",
  "went platinum", "goes platinum", "certified platinum", "platinum edition",
  "corn maze", "candy corn",
  "sugar daddy", "sugar rush", "sugar coat", "sugar-free",
  "rice university", "condoleezza rice", "susan rice",
  "cocoa beach", "hot cocoa",
  "milk mustache",
  "orange county", "agent orange", "clockwork orange",
  "cold storage since", // "body in cold storage since February" (news idiom for morgues)
];

// ── Commodity profiles keyed by catalog CODE ───────────────────────────
// Keys match onboarding-templates.js ALL_COMMODITIES keys (UPPER_SNAKE), so
// the profile builder can look up directly by what user_profiles.commodities
// actually stores. Legacy display-name keys kept below for backward compat.
export const COMMODITY_PROFILES = {
  WHEAT: { primaryTerms: ["wheat", "durum"], relatedTerms: ["grain", "grains", "flour", "milling"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  CORN: { primaryTerms: ["corn", "maize"], relatedTerms: ["grain", "grains", "feed corn", "ethanol"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  SOYBEANS: { primaryTerms: ["soybean", "soybeans", "soy"], relatedTerms: ["soymeal", "soy oil", "oilseed", "oilseeds", "crush"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  RICE: { primaryTerms: ["rice", "basmati", "paddy"], relatedTerms: ["grain", "grains"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  OATS: { primaryTerms: ["oats", "oat"], relatedTerms: ["grain", "grains", "feed grain"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  SUGAR: { primaryTerms: ["sugar", "sugarcane", "sugar cane"], relatedTerms: ["sweetener", "ethanol"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  COFFEE: { primaryTerms: ["coffee", "arabica", "robusta"], relatedTerms: ["coffee bean", "coffee beans", "roaster", "plantation"], businessTerms: AGRI_BUSINESS, excludedContexts: [...FOOD_EXCLUDED, "coffee shop", "barista", "latte"] },
  COCOA: { primaryTerms: ["cocoa", "cacao"], relatedTerms: ["chocolate"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  FEEDER_CATTLE: { primaryTerms: ["feeder cattle", "cattle"], relatedTerms: ["beef", "livestock", "calf", "calves", "ranch", "herd"], businessTerms: LIVESTOCK_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  LIVE_CATTLE: { primaryTerms: ["live cattle", "cattle"], relatedTerms: ["beef", "livestock", "slaughter", "herd", "ranch"], businessTerms: LIVESTOCK_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  LEAN_HOGS: { primaryTerms: ["lean hogs", "lean hog", "hogs", "pork"], relatedTerms: ["swine", "pig", "pigs", "hog"], businessTerms: LIVESTOCK_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  MILK: { primaryTerms: ["milk", "dairy"], relatedTerms: ["cheese", "butter", "cream", "whey", "milk powder", "skim", "cattle", "cow", "dairy farm"], businessTerms: DAIRY_BUSINESS, excludedContexts: [...FOOD_EXCLUDED, "pets", "puppy", "kitten"] },
  POULTRY: { primaryTerms: ["poultry", "chicken"], relatedTerms: ["broiler", "broilers", "hen", "egg", "eggs", "avian flu", "bird flu", "hatchery", "flock"], businessTerms: LIVESTOCK_BUSINESS, excludedContexts: [...FOOD_EXCLUDED, "fast food", "kfc", "fried chicken", "pet"] },
  ORANGE_JUICE: { primaryTerms: ["orange juice", "fcoj"], relatedTerms: ["citrus", "oranges", "orange crop", "citrus greening", "grove"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  COPPER: { primaryTerms: ["copper"], relatedTerms: ["smelter", "ore", "cathode"], businessTerms: METALS_BUSINESS, excludedContexts: [] },
  ALUMINUM: { primaryTerms: ["aluminum", "aluminium"], relatedTerms: ["smelter", "bauxite", "alumina"], businessTerms: METALS_BUSINESS, excludedContexts: [] },
  GOLD: { primaryTerms: ["gold"], relatedTerms: ["bullion", "troy ounce", "gold mining"], businessTerms: METALS_BUSINESS, excludedContexts: [] },
  SILVER: { primaryTerms: ["silver"], relatedTerms: ["bullion"], businessTerms: METALS_BUSINESS, excludedContexts: [] },
  PLATINUM: { primaryTerms: ["platinum"], relatedTerms: ["pgm", "palladium"], businessTerms: METALS_BUSINESS, excludedContexts: [] },
  LUMBER: { primaryTerms: ["lumber", "timber"], relatedTerms: ["sawmill", "wood products"], businessTerms: METALS_BUSINESS, excludedContexts: [] },
  BRENT_CRUDE: { primaryTerms: ["brent crude", "crude oil", "brent"], relatedTerms: ["oil prices", "oil supply", "oil exports", "petroleum", "opec", "barrel", "refinery", "diesel", "gasoline"], businessTerms: ENERGY_BUSINESS, excludedContexts: ["essential oils", "cooking oil", "hair oil", "skin care", "massage"] },
  NATURAL_GAS: { primaryTerms: ["natural gas", "lng"], relatedTerms: ["liquefied natural gas", "pipeline", "gas prices"], businessTerms: ENERGY_BUSINESS, excludedContexts: ["gas station"] },

  // ── Legacy display-name keys (old template/user data may still send these) ──
  "Dairy": { primaryTerms: ["dairy", "milk"], relatedTerms: ["cheese", "butter", "cream", "whey", "milk powder", "cattle", "cow", "livestock", "dairy farm"], businessTerms: DAIRY_BUSINESS, excludedContexts: [...FOOD_EXCLUDED, "pets", "puppy", "kitten"] },
  "Grains & Agriculture": { primaryTerms: ["grain", "grains", "agriculture", "wheat", "corn", "soybeans", "rice", "oats"], relatedTerms: ["crop", "harvest", "seed", "maize", "cotton"], businessTerms: AGRI_BUSINESS, excludedContexts: FOOD_EXCLUDED },
  "Brent Crude": { primaryTerms: ["brent crude", "crude oil", "brent"], relatedTerms: ["oil prices", "petroleum", "opec", "barrel", "refinery", "diesel", "gasoline"], businessTerms: ENERGY_BUSINESS, excludedContexts: ["essential oils", "cooking oil", "hair oil", "skin care", "massage"] },
  "Natural Gas": { primaryTerms: ["natural gas", "lng"], relatedTerms: ["liquefied natural gas", "pipeline"], businessTerms: ENERGY_BUSINESS, excludedContexts: ["gas station"] },
  "Coffee": { primaryTerms: ["coffee", "arabica", "robusta"], relatedTerms: ["coffee bean", "roaster", "plantation"], businessTerms: AGRI_BUSINESS, excludedContexts: [...FOOD_EXCLUDED, "coffee shop", "barista"] },
  "Chicken": { primaryTerms: ["chicken", "poultry"], relatedTerms: ["broiler", "hen", "egg", "meat", "flock", "avian flu", "bird flu"], businessTerms: LIVESTOCK_BUSINESS, excludedContexts: [...FOOD_EXCLUDED, "fast food", "kfc", "fried chicken", "pet"] },
};

// ── Region aliases ─────────────────────────────────────────────────────
// Notes on removed aliases (each caused verified mis-matches):
//  - bare "gulf" matched "Gulf of Mexico"/"Gulf Coast" (US articles passing
//    the region gate for GCC users) → replaced with qualified forms.
//  - bare "asia" made ANY Asia-mention pass for India/China users.
//  - bare "us" (lowercased) matched the English pronoun "us" in every text.
//  - bare "america" matched inside "south america" mentions.
export const REGION_ALIASES = {
  "Middle East": ["Middle East", "MENA", "GCC", "Arabian Gulf", "Persian Gulf", "Gulf states", "Saudi Arabia", "UAE", "United Arab Emirates", "Dubai", "Abu Dhabi", "Jebel Ali", "Qatar", "Doha", "Oman", "Muscat", "Bahrain", "Manama", "Kuwait", "Egypt", "Cairo", "Suez", "Jordan", "Israel", "Lebanon", "Iraq", "Iran", "Syria", "Red Sea", "Hormuz", "Bab el-Mandeb"],
  "Saudi Arabia": ["Saudi Arabia", "Saudi", "KSA", "Riyadh", "Jeddah", "Dammam", "NEOM"],
  "UAE": ["UAE", "United Arab Emirates", "Dubai", "Abu Dhabi", "Sharjah", "Jebel Ali", "Emirati"],
  "Egypt": ["Egypt", "Egyptian", "Cairo", "Alexandria", "Port Said", "Suez", "Nile Delta"],
  "Qatar": ["Qatar", "Doha"],
  "Kuwait": ["Kuwait"],
  "Oman": ["Oman", "Muscat", "Salalah", "Sohar"],
  "Bahrain": ["Bahrain", "Manama"],
  "Jordan": ["Jordan", "Amman", "Aqaba", "Jordan Valley"],
  "Global": ["Global", "World", "International", "Worldwide"],
  "USA": ["USA", "U.S.", "United States", "US Midwest"],
  "China": ["China", "Chinese", "Beijing", "Shanghai"],
  "India": ["India", "New Delhi", "Mumbai", "Maharashtra", "Punjab", "Gujarat"],
  "Brazil": ["Brazil", "Brazilian", "Sao Paulo", "Santos", "South America", "Latin America"],
  "Argentina": ["Argentina", "Buenos Aires", "Rosario", "South America", "Latin America"],
  "Australia": ["Australia", "Oceania"],
  "New Zealand": ["New Zealand", "Auckland"],
  "Ukraine": ["Ukraine", "Odesa", "Odessa", "Black Sea", "Eastern Europe"],
  "Russia": ["Russia", "Moscow", "Black Sea"],
  "Canada": ["Canada", "Saskatchewan"],
  "Europe": ["Europe", "European Union", "EU", "Eurozone"],
  "Vietnam": ["Vietnam", "Hanoi", "Ho Chi Minh", "Mekong"],
  "Thailand": ["Thailand", "Bangkok"],
  "Turkey": ["Turkiye", "Ankara", "Istanbul"],
};

// Fallback profile if commodity is unknown
export const FALLBACK_PROFILE = {
    primaryTerms: [],
    relatedTerms: [],
    businessTerms: ["price", "production", "trade", "imports", "exports", "logistics", "supply chain", "shortage", "demand", "cost", "tariff", "regulation", "freight"],
    excludedContexts: ["recipes", "cooking", "diet", "health advice", "restaurants", "entertainment", "sports", "celebrity"]
};
