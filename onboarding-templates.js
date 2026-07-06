// ── Onboarding Templates ────────────────────────────────────
// Predefined configurations for fast customer onboarding.
// Each template pre-selects commodities, regions, news keywords, and currencies.

export const ALL_COMMODITIES = [
  { key: 'WHEAT', label: 'Wheat', category: 'Grains', unit: 'USD/bushel' },
  { key: 'CORN', label: 'Corn', category: 'Grains', unit: 'USD/bushel' },
  { key: 'SOYBEANS', label: 'Soybeans', category: 'Grains', unit: 'USD/bushel' },
  { key: 'RICE', label: 'Rice', category: 'Grains', unit: 'USD/cwt' },
  { key: 'OATS', label: 'Oats', category: 'Grains', unit: 'USD/bushel' },
  { key: 'COTTON', label: 'Cotton', category: 'Grains', unit: 'USD/lb' },
  { key: 'SUGAR', label: 'Sugar', category: 'Soft Commodities', unit: 'USD/lb' },
  { key: 'COFFEE', label: 'Coffee', category: 'Soft Commodities', unit: 'USD/lb' },
  { key: 'COCOA', label: 'Cocoa', category: 'Soft Commodities', unit: 'USD/ton' },
  { key: 'FEEDER_CATTLE', label: 'Feeder Cattle', category: 'Livestock', unit: 'USD/lb' },
  { key: 'LEAN_HOGS', label: 'Lean Hogs', category: 'Livestock', unit: 'USD/lb' },
  { key: 'LIVE_CATTLE', label: 'Live Cattle', category: 'Livestock', unit: 'USD/lb' },
  { key: 'POULTRY', label: 'Poultry (Broilers)', category: 'Livestock', unit: 'USD/lb' },
  { key: 'MILK', label: 'Class III Milk', category: 'Dairy', unit: 'USD/cwt' },
  { key: 'ORANGE_JUICE', label: 'Frozen Orange Juice', category: 'Soft Commodities', unit: 'USD/lb' },
  { key: 'COPPER', label: 'Copper', category: 'Metals', unit: 'USD/lb' },
  { key: 'ALUMINUM', label: 'Aluminum', category: 'Metals', unit: 'USD/ton' },
  { key: 'GOLD', label: 'Gold', category: 'Metals', unit: 'USD/oz' },
  { key: 'SILVER', label: 'Silver', category: 'Metals', unit: 'USD/oz' },
  { key: 'PLATINUM', label: 'Platinum', category: 'Metals', unit: 'USD/oz' },
  { key: 'LUMBER', label: 'Lumber', category: 'Metals', unit: 'USD/1000bf' },
  { key: 'BRENT_CRUDE', label: 'Brent Crude Oil', category: 'Energy', unit: 'USD/barrel' },
  { key: 'NATURAL_GAS', label: 'Natural Gas', category: 'Energy', unit: 'USD/MMBtu' },
];

export const ALL_REGIONS = [
  { name: 'Saudi Arabia Al-Hasa', lat: 25.3, lon: 49.5, crop: 'Dates/Wheat', country: 'KSA' },
  { name: 'UAE Sweihan', lat: 24.3, lon: 55.3, crop: 'Greenhouse/Poultry', country: 'UAE' },
  { name: 'Egypt Nile Delta', lat: 30.8, lon: 31.2, crop: 'Wheat/Corn', country: 'EGY' },
  { name: 'Jordan Valley', lat: 32.0, lon: 35.5, crop: 'Fruits/Vegetables', country: 'JOR' },
  { name: 'Oman Al Batinah', lat: 23.8, lon: 57.0, crop: 'Dates/Produce', country: 'OMN' },
  { name: 'Qatar Al Khor', lat: 25.6, lon: 51.5, crop: 'Poultry/Dairy', country: 'QAT' },
  { name: 'Kuwait Wafra', lat: 28.5, lon: 48.0, crop: 'Produce/Livestock', country: 'KWT' },
  { name: 'Bahrain', lat: 26.0, lon: 50.5, crop: 'Seafood/Produce', country: 'BHR' },
];

export const TEMPLATES = {
  frozen_foods_me: {
    id: 'frozen_foods_me',
    name: 'Frozen Foods – Middle East',
    description: 'Full frozen food supply chain intelligence for the GCC and MENA region.',
    icon: '🧊',
    commodities: ['MILK', 'LIVE_CATTLE', 'POULTRY', 'ORANGE_JUICE', 'WHEAT', 'CORN', 'RICE', 'SOYBEANS', 'SUGAR', 'BRENT_CRUDE'],
    regions: ['Saudi Arabia Al-Hasa', 'UAE Sweihan', 'Egypt Nile Delta', 'Jordan Valley', 'Oman Al Batinah', 'Qatar Al Khor', 'Kuwait Wafra', 'Bahrain'],
    focus_region: 'Middle East',
    focus_countries: ['UAE', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman', 'Egypt', 'Jordan'],
    focus_product: 'Frozen Goods',
    news_keywords: ['frozen food', 'cold chain', 'frozen goods', 'halal food', 'cold storage', 'refrigerated logistics'],
    news_country_codes: 'ae,sa,eg,qa,kw',
    currencies: ['AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'EGP', 'JOD', 'BRL', 'INR', 'EUR', 'THB', 'AUD'],
  },

  grains_global: {
    id: 'grains_global',
    name: 'Grains & Agriculture – Global',
    description: 'Track global grain markets, crop yields, and agricultural trade flows.',
    icon: '🌾',
    commodities: ['WHEAT', 'CORN', 'SOYBEANS', 'RICE', 'OATS', 'COTTON'],
    regions: ['Egypt Nile Delta', 'Saudi Arabia Al-Hasa', 'Jordan Valley'],
    focus_region: 'Global',
    focus_countries: ['USA', 'China', 'India', 'Brazil', 'Argentina', 'Australia', 'Ukraine', 'Canada'],
    focus_product: 'Grains & Agriculture',
    news_keywords: ['grain export', 'crop yield', 'harvest', 'agriculture', 'wheat trade', 'corn export', 'soybean'],
    news_country_codes: 'us,cn,in,br,ar,au,ua,ca',
    currencies: ['USD', 'CNY', 'INR', 'BRL', 'ARS', 'AUD', 'EUR', 'UAH'],
  },

  dairy_livestock: {
    id: 'dairy_livestock',
    name: 'Dairy & Livestock',
    description: 'Monitor dairy, cattle, and livestock markets with feed cost tracking.',
    icon: '🥛',
    commodities: ['FEEDER_CATTLE', 'LEAN_HOGS', 'CORN', 'SOYBEANS', 'OATS', 'WHEAT'],
    regions: ['Saudi Arabia Al-Hasa', 'UAE Sweihan', 'Qatar Al Khor', 'Kuwait Wafra'],
    focus_region: 'Global',
    focus_countries: ['USA', 'Brazil', 'Australia', 'Argentina', 'New Zealand', 'EU'],
    focus_product: 'Dairy & Livestock',
    news_keywords: ['dairy', 'livestock', 'cattle', 'meat', 'feed prices', 'poultry', 'milk production'],
    news_country_codes: 'us,br,au,ar,nz',
    currencies: ['USD', 'BRL', 'AUD', 'ARS', 'NZD', 'EUR'],
  },

  metals_mining: {
    id: 'metals_mining',
    name: 'Metals & Mining',
    description: 'Industrial and precious metals pricing and supply chain intelligence.',
    icon: '⛏️',
    commodities: ['COPPER', 'ALUMINUM', 'GOLD', 'SILVER', 'PLATINUM', 'LUMBER'],
    regions: [],
    focus_region: 'Global',
    focus_countries: ['China', 'USA', 'Australia', 'Chile', 'Peru', 'South Africa', 'Russia'],
    focus_product: 'Metals & Mining',
    news_keywords: ['metal prices', 'mining', 'industrial metals', 'copper demand', 'gold market', 'aluminum'],
    news_country_codes: 'cn,us,au,cl,pe,za',
    currencies: ['USD', 'CNY', 'AUD', 'ZAR', 'CLP', 'PEN'],
  },

  energy: {
    id: 'energy',
    name: 'Energy & Petrochemicals',
    description: 'Crude oil, natural gas, and energy market monitoring.',
    icon: '⚡',
    commodities: ['BRENT_CRUDE', 'NATURAL_GAS', 'COPPER', 'ALUMINUM'],
    regions: [],
    focus_region: 'Global',
    focus_countries: ['USA', 'Saudi Arabia', 'Russia', 'China', 'UAE', 'Norway', 'Canada'],
    focus_product: 'Energy',
    news_keywords: ['crude oil', 'OPEC', 'natural gas', 'energy', 'refinery', 'petrochemical', 'pipeline'],
    news_country_codes: 'us,sa,ru,cn,ae,no,ca',
    currencies: ['USD', 'SAR', 'RUB', 'CNY', 'AED', 'NOK', 'CAD'],
  },

  coffee_cocoa: {
    id: 'coffee_cocoa',
    name: 'Coffee & Cocoa',
    description: 'Specialty crop tracking for coffee and cocoa supply chains.',
    icon: '☕',
    commodities: ['COFFEE', 'COCOA', 'SUGAR'],
    regions: ['Saudi Arabia Al-Hasa', 'Oman Al Batinah'],
    focus_region: 'Global',
    focus_countries: ['Brazil', 'Colombia', 'Vietnam', 'Ivory Coast', 'Ghana', 'Indonesia', 'Ethiopia'],
    focus_product: 'Coffee & Cocoa',
    news_keywords: ['coffee', 'cocoa', 'plantation', 'bean', 'robusta', 'arabica', 'chocolate'],
    news_country_codes: 'br,co,vn,ci,gh,id,et',
    currencies: ['USD', 'BRL', 'COP', 'XOF', 'GHS', 'IDR', 'VND'],
  },
};

export function getTemplateById(id) {
  return TEMPLATES[id] || null;
}

export function getAllTemplates() {
  return Object.values(TEMPLATES).map(t => ({
    id: t.id, name: t.name, description: t.description, icon: t.icon,
    commodityCount: t.commodities.length, regionCount: t.regions.length,
  }));
}
