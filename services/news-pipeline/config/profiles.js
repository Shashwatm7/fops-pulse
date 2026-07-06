export const COMMODITY_PROFILES = {
  "Dairy": {
    primaryTerms: ["dairy", "milk"],
    relatedTerms: ["cheese", "butter", "cream", "whey", "milk powder", "cattle", "cow", "livestock", "dairy farm"],
    businessTerms: ["price", "production", "trade", "imports", "exports", "factory", "logistics", "government", "inflation", "supply chain", "shortage", "demand", "cost", "tariff", "regulation", "yield", "freight", "transport"],
    excludedContexts: ["pets", "recipes", "restaurants", "health advice", "entertainment", "sports", "puppy", "kitten", "milk mustache", "celebrity", "diet", "nutrition advice", "cafe", "bistro", "menu"]
  },
  "Grains & Agriculture": {
    primaryTerms: ["grain", "agriculture"],
    relatedTerms: ["wheat", "corn", "soybeans", "rice", "oats", "cotton", "crop", "harvest", "seed"],
    businessTerms: ["yield", "export", "import", "drought", "weather", "trade", "price", "production", "logistics", "supply chain", "tariff", "subsidy", "fertilizer", "freight", "shipment"],
    excludedContexts: ["recipes", "cooking", "diet", "health advice", "restaurants", "gardening tips", "home garden", "baking"]
  },
  "Brent Crude": {
    primaryTerms: ["brent crude", "oil"],
    relatedTerms: ["crude", "petroleum", "gasoline", "diesel", "refinery", "barrel", "opec", "energy"],
    businessTerms: ["price", "production", "reserves", "export", "import", "logistics", "supply chain", "freight", "pipeline", "drilling", "rig", "inventory", "sanctions", "geopolitics"],
    excludedContexts: ["essential oils", "cooking oil", "hair oil", "skin care", "diet", "health", "massage"]
  },
  "Natural Gas": {
    primaryTerms: ["natural gas", "gas"],
    relatedTerms: ["lng", "liquefied natural gas", "pipeline", "energy"],
    businessTerms: ["price", "production", "export", "import", "supply chain", "freight", "storage", "reserves", "drilling", "sanctions", "geopolitics"],
    excludedContexts: ["gas station", "car", "vehicle", "cooking", "health"]
  },
  "Coffee": {
    primaryTerms: ["coffee"],
    relatedTerms: ["arabica", "robusta", "coffee bean", "roaster", "plantation"],
    businessTerms: ["yield", "export", "import", "drought", "weather", "trade", "price", "production", "logistics", "supply chain", "tariff", "freight", "shipment"],
    excludedContexts: ["recipes", "cafe", "coffee shop", "barista", "diet", "health", "lifestyle", "review", "mug"]
  },
  "Chicken": {
    primaryTerms: ["chicken", "poultry"],
    relatedTerms: ["broiler", "hen", "egg", "meat", "flock"],
    businessTerms: ["avian flu", "bird flu", "price", "production", "trade", "imports", "exports", "logistics", "supply chain", "feed cost", "farm", "freight"],
    excludedContexts: ["recipes", "cooking", "diet", "health", "restaurants", "fast food", "kfc", "fried chicken", "pet"]
  }
};

export const REGION_ALIASES = {
  "Middle East": ["Middle East", "MENA", "Gulf", "GCC", "Saudi Arabia", "UAE", "Qatar", "Oman", "Bahrain", "Kuwait", "Egypt", "Jordan", "Israel", "Lebanon", "Iraq", "Iran", "Syria"],
  "Global": ["Global", "World", "International"],
  "USA": ["USA", "US", "United States", "America", "North America"],
  "China": ["China", "PRC", "Beijing", "Shanghai", "Asia"],
  "India": ["India", "New Delhi", "Mumbai", "Asia"],
  "Brazil": ["Brazil", "South America", "LatAm", "Latin America"],
  "Argentina": ["Argentina", "South America", "LatAm", "Latin America"],
  "Australia": ["Australia", "Oceania"],
  "Ukraine": ["Ukraine", "Eastern Europe", "Black Sea"],
  "Canada": ["Canada", "North America"]
};

// Fallback profile if commodity is unknown
export const FALLBACK_PROFILE = {
    primaryTerms: [],
    relatedTerms: [],
    businessTerms: ["price", "production", "trade", "imports", "exports", "logistics", "supply chain", "shortage", "demand", "cost", "tariff", "regulation", "freight"],
    excludedContexts: ["recipes", "cooking", "diet", "health advice", "restaurants", "entertainment", "sports", "celebrity"]
};
