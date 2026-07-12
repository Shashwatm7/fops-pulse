// deterministic-engine.js
// FOps Market Pulse — Algorithmic Intelligence Engine
// Replaces / supplements Groq LLM for 7D/30D/90D forecast generation.
// Inputs mirror /api/analyze body: { prices, news, weather, energy, forex, weatherExtended, livePricesSnapshot }
// Returns same JSON schema as LLM analysis.

// ── COMMODITY → frozen food relevance map ──────────────────────────
const FROZEN_FOOD_RELEVANCE = {
  WHEAT:         { weight: 0.7, role: 'bakery/breads in frozen meals',        horizon: 'medium' },
  CORN:          { weight: 0.8, role: 'poultry feed → frozen chicken costs',   horizon: 'medium' },
  SOYBEANS:      { weight: 0.75, role: 'poultry/aquaculture feed',             horizon: 'medium' },
  RICE:          { weight: 0.6, role: 'frozen rice dishes, GCC staple',        horizon: 'short'  },
  SUGAR:         { weight: 0.4, role: 'frozen desserts/confectionery',         horizon: 'long'   },
  COFFEE:        { weight: 0.2, role: 'frozen coffee beverages',               horizon: 'long'   },
  COCOA:         { weight: 0.2, role: 'frozen chocolate products',             horizon: 'long'   },
  PALM_OIL:      { weight: 0.85, role: 'frying/processing frozen foods',       horizon: 'short'  },
  MILK:          { weight: 0.9, role: 'frozen dairy, ice cream, ready meals',  horizon: 'short'  },
  FEEDER_CATTLE: { weight: 0.95, role: 'frozen beef — core GCC import',        horizon: 'short'  },
  LEAN_HOGS:     { weight: 0.3, role: 'processed frozen meats (non-halal)',    horizon: 'medium' },
  BRENT_CRUDE:   { weight: 0.95, role: 'refrigeration energy + freight cost',  horizon: 'short'  },
  NATURAL_GAS:   { weight: 0.6, role: 'cold storage energy (esp. Egypt/Jordan)', horizon: 'medium' },
  ALUMINUM:      { weight: 0.3, role: 'frozen food packaging',                 horizon: 'long'   },
};

// ── CURRENCY sensitivity for ME importers ─────────────────────────
// Negative = depreciation raises import cost (bad for importers)
const CURRENCY_SENSITIVITY = {
  EGP: { direction: 'import-cost', threshold: 0.02, severity: 'HIGH',   note: 'EGP floating — depreciation hits Egypt food imports hard' },
  BRL: { direction: 'export-cost', threshold: 0.03, severity: 'MEDIUM', note: 'BRL weakening lowers Brazil export prices (good for ME buyers)' },
  AUD: { direction: 'export-cost', threshold: 0.02, severity: 'MEDIUM', note: 'AUD moves affect Australian beef/wheat pricing to GCC' },
  INR: { direction: 'export-cost', threshold: 0.015, severity: 'LOW',   note: 'INR affects Indian rice/wheat export competitiveness' },
  ARS: { direction: 'export-cost', threshold: 0.05, severity: 'LOW',    note: 'ARS hyper-volatile; Argentine exporters price in USD anyway' },
};

// ── Weather region → commodity impact map ─────────────────────────
const WEATHER_COMMODITY_MAP = {
  'US Corn Belt':      ['CORN', 'SOYBEANS', 'WHEAT'],
  'Ukraine':           ['WHEAT', 'CORN', 'SOYBEANS'],
  'Brazil Cerrado':    ['SOYBEANS', 'CORN', 'COFFEE', 'SUGAR'],
  'India Punjab':      ['WHEAT', 'RICE', 'MILK'],
  'Ivory Coast':       ['COCOA'],
  'Indonesia':         ['PALM_OIL'],
  'Argentina Pampas':  ['SOYBEANS', 'WHEAT', 'CORN'],
  'Thailand Central':  ['RICE', 'SUGAR'],
  'Colombia':          ['COFFEE'],
  'Ghana':             ['COCOA'],
  'Australia East':    ['WHEAT', 'FEEDER_CATTLE'],
  'Canada Prairies':   ['WHEAT', 'OATS'],
};

// ── NEWS keyword scoring ───────────────────────────────────────────
const NEWS_KEYWORDS = {
  HIGH_IMPACT: [
    'export ban', 'export restriction', 'port closure', 'shipping disruption',
    'food shortage', 'supply chain', 'cold chain', 'refrigerat', 'frozen food',
    'drought', 'flood', 'crop failure', 'harvest loss', 'disease outbreak',
    'bird flu', 'avian influenza', 'foot and mouth', 'african swine'
  ],
  MEDIUM_IMPACT: [
    'tariff', 'import duty', 'halal certification', 'food safety',
    'inspection', 'quarantine', 'logistics', 'freight rate', 'container',
    'warehouse', 'storage capacity', 'price increase', 'price hike',
    'supply shortage', 'GCC', 'UAE', 'Saudi', 'middle east food',
    'inflation', 'cost of living',
  ],
  LOW_IMPACT: [
    'market update', 'trade deal', 'agreement', 'cooperation',
    'investment', 'expansion', 'new facility', 'technology',
  ],
};

// ── Signal scoring engine ──────────────────────────────────────────
function scoreSignals({ prices, news, weather, energy, forex, weatherExtended, livePricesSnapshot, logistics, usda, geoAlerts, userAlerts }) {
  const signals = {
    energy:    { score: 0, drivers: [], horizon: null },
    commodity: { score: 0, drivers: [], horizon: null },
    weather:   { score: 0, drivers: [], horizon: null, affectedCommodities: [] },
    currency:  { score: 0, drivers: [], horizon: null },
    news:      { score: 0, drivers: [], horizon: null },
    logistics: { score: 0, drivers: [] },
    geoAlerts: geoAlerts || [],
    userAlerts: userAlerts || [],
  };

  // ── 1. ENERGY SIGNALS ────────────────────────────────────────────
  const brent = parseFloat(energy?.brent?.current?.value) || 0;
  const gas   = parseFloat(energy?.naturalGas?.current?.value) || 0;

  if (brent > 100) {
    signals.energy.score += 8;
    signals.energy.drivers.push({ label: 'Brent >$100', severity: 'HIGH', impact: 'UP', detail: `Brent at $${brent.toFixed(1)}/bbl — refrigerated freight cost elevated, cold storage energy surcharge likely in 7-14 days` });
    signals.energy.horizon = 'short';
  } else if (brent > 90) {
    signals.energy.score += 5;
    signals.energy.drivers.push({ label: 'Brent $90-100', severity: 'MEDIUM', impact: 'UP', detail: `Brent at $${brent.toFixed(1)}/bbl — moderate freight premium building; spot rates 3-7% above Q-avg` });
    signals.energy.horizon = 'short';
  } else if (brent > 75) {
    signals.energy.score += 2;
    signals.energy.drivers.push({ label: 'Brent $75-90', severity: 'LOW', impact: 'NEUTRAL', detail: `Brent at $${brent.toFixed(1)}/bbl — within normal trading range; freight costs stable` });
    signals.energy.horizon = 'medium';
  } else if (brent < 60) {
    signals.energy.score -= 2;
    signals.energy.drivers.push({ label: 'Brent <$60', severity: 'LOW', impact: 'DOWN', detail: `Brent at $${brent.toFixed(1)}/bbl — low energy costs benefit cold chain operators; margin relief` });
    signals.energy.horizon = 'medium';
  }

  if (gas > 4) {
    signals.energy.score += 4;
    signals.energy.drivers.push({ label: 'Gas elevated', severity: 'MEDIUM', impact: 'UP', detail: `Natural gas at $${gas.toFixed(2)}/MMBtu — cold storage costs rising, especially Egypt/Jordan non-pegged markets` });
  } else if (gas > 3) {
    signals.energy.score += 2;
    signals.energy.drivers.push({ label: 'Gas moderate', severity: 'LOW', impact: 'NEUTRAL', detail: `Natural gas at $${gas.toFixed(2)}/MMBtu — normal range` });
  }

  // ── 2. COMMODITY PRICE SIGNALS ───────────────────────────────────
  const liveSnap = livePricesSnapshot || {};
  const volatileCount = { HIGH: 0, MEDIUM: 0, DOWN: 0 };

  for (const p of (prices || [])) {
    const sym = p.symbol;
    const rel = FROZEN_FOOD_RELEVANCE[sym];
    if (!rel) continue;

    const live = liveSnap[sym];
    const changePct = live?.changePct ?? 0;
    const absChange = Math.abs(changePct);
    const weightedScore = rel.weight * absChange;

    if (absChange >= 5) {
      const dir = changePct > 0 ? 'UP' : 'DOWN';
      const severity = absChange >= 8 ? 'HIGH' : 'MEDIUM';
      signals.commodity.score += weightedScore * 1.5;
      signals.commodity.drivers.push({
        label: `${sym} ${changePct > 0 ? '▲' : '▼'}${absChange.toFixed(1)}%`,
        severity,
        impact: dir,
        detail: `${sym} moved ${changePct.toFixed(2)}% — ${rel.role} costs ${dir === 'UP' ? 'rising' : 'falling'}. Weight on frozen food basket: ${(rel.weight * 100).toFixed(0)}%`,
        commodity: sym,
        horizon: rel.horizon,
      });
      if (dir === 'UP') volatileCount.HIGH++;
      else volatileCount.DOWN++;
    } else if (absChange >= 1.5) {
      signals.commodity.score += weightedScore * 0.5;
      signals.commodity.drivers.push({
        label: `${sym} ${changePct > 0 ? '▲' : '▼'}${absChange.toFixed(1)}%`,
        severity: 'LOW',
        impact: changePct > 0 ? 'UP' : 'DOWN',
        detail: `${sym} mild movement — monitor for continuation`,
        commodity: sym,
        horizon: rel.horizon,
      });
      volatileCount.MEDIUM++;
    }
  }

  if (signals.commodity.drivers.length === 0) {
    signals.commodity.drivers.push({ label: 'Commodities stable', severity: 'LOW', impact: 'NEUTRAL', detail: 'No significant commodity price moves detected in current session' });
  }

  // ── 3. WEATHER SIGNALS ───────────────────────────────────────────
  const extWeather = weatherExtended || weather || [];
  const weatherByRegion = {};

  for (const w of extWeather) {
    const alert = w.analytics?.alert || w.alert || 'NORMAL';
    const riskScore = w.analytics?.riskScore || 0;
    const affectedComms = WEATHER_COMMODITY_MAP[w.name] || [];
    weatherByRegion[w.name] = { alert, riskScore, affectedComms, region: w };

    if (alert === 'DROUGHT_RISK' || alert === 'SEVERE_DROUGHT') {
      const sev = alert === 'SEVERE_DROUGHT' ? 10 : 6;
      signals.weather.score += sev;
      signals.weather.affectedCommodities.push(...affectedComms);
      const precip = w.analytics?.recentPrecipMm ?? w.totalPrecipMm ?? 'N/A';
      const affectedText = affectedComms.length > 0 ? `Risk to ${affectedComms.join(', ')} — yield loss typically 10-25% if drought persists.` : `Extended dry conditions detected.`;
      signals.weather.drivers.push({
        label: `${alert.replace('_', ' ')} — ${w.name}`,
        severity: alert === 'SEVERE_DROUGHT' ? 'CRITICAL' : 'HIGH',
        impact: 'UP',
        detail: `${w.name}: ${precip}mm/7d precipitation. ${affectedText}`,
        region: w.name,
        commodities: affectedComms,
        horizon: 'medium',
      });
    } else if (alert === 'HEAT_STRESS') {
      signals.weather.score += 5;
      signals.weather.affectedCommodities.push(...affectedComms);
      const temp = w.analytics?.maxTemp7d ?? w.avgTempC ?? 'N/A';
      const affectedText = affectedComms.length > 0 ? `${affectedComms.join(', ')} under heat stress — yields and transport may be impacted.` : `Extreme heat detected. Local operations and cold chain may face increased load.`;
      signals.weather.drivers.push({
        label: `HEAT STRESS — ${w.name}`,
        severity: 'HIGH',
        impact: 'UP',
        detail: `${w.name}: ${temp}°C peak. ${affectedText}`,
        region: w.name,
        commodities: affectedComms,
        horizon: 'short',
      });
    } else if (alert === 'FLOOD_RISK') {
      signals.weather.score += 5;
      signals.weather.affectedCommodities.push(...affectedComms);
      const precip = w.analytics?.recentPrecipMm ?? w.totalPrecipMm ?? 'N/A';
      const affectedText = affectedComms.length > 0 ? `harvest disruption and logistics damage risk for ${affectedComms.join(', ')}.` : `heavy rainfall and potential local flooding.`;
      signals.weather.drivers.push({
        label: `FLOOD RISK — ${w.name}`,
        severity: 'HIGH',
        impact: 'UP',
        detail: `${w.name}: ${precip}mm/7d — ${affectedText}`,
        region: w.name,
        commodities: affectedComms,
        horizon: 'short',
      });
    }
  }

  if (signals.weather.drivers.length === 0) {
    signals.weather.drivers.push({ label: 'Weather — Normal', severity: 'LOW', impact: 'NEUTRAL', detail: 'No significant weather stress detected in key agricultural regions' });
  }
  signals.weather.affectedCommodities = [...new Set(signals.weather.affectedCommodities)];

  // ── 4. CURRENCY / FOREX SIGNALS ──────────────────────────────────
  if (forex) {
    // EGP: floating, high sensitivity
    const egp = forex['EGP'];
    if (egp?.rate > 50) {
      signals.currency.score += 7;
      signals.currency.drivers.push({ label: 'EGP weakness', severity: 'HIGH', impact: 'UP', detail: `EGP/USD: ${egp.rate.toFixed(2)} — Egyptian importers face severe USD cost inflation. Frozen food landed cost up ~${((egp.rate / 45 - 1) * 100).toFixed(0)}% vs 2023 baseline` });
    } else if (egp?.rate > 40) {
      signals.currency.score += 4;
      signals.currency.drivers.push({ label: 'EGP moderately weak', severity: 'MEDIUM', impact: 'UP', detail: `EGP/USD: ${egp.rate.toFixed(2)} — Egyptian importers under pressure; monitor for further devaluation triggers` });
    }

    // BRL: weaker BRL = cheaper Brazilian exports to ME
    const brl = forex['BRL'];
    if (brl?.rate > 5.5) {
      signals.currency.score += 2;
      signals.currency.drivers.push({ label: 'BRL weak — Brazil export discount', severity: 'LOW', impact: 'DOWN', detail: `BRL/USD: ${brl.rate.toFixed(2)} — Brazilian beef, poultry, soy cheaper in USD terms. ME buyers benefit` });
    }

    // AUD: affects Australian beef to GCC
    const aud = forex['AUD'];
    if (aud?.rate < 0.62) {
      signals.currency.score += 2;
      signals.currency.drivers.push({ label: 'AUD weak — AU export discount', severity: 'LOW', impact: 'DOWN', detail: `AUD/USD: ${aud.rate.toFixed(4)} — Australian frozen beef/wheat cheaper for GCC buyers` });
    } else if (aud?.rate > 0.70) {
      signals.currency.score += 1;
      signals.currency.drivers.push({ label: 'AUD strong — AU export premium', severity: 'LOW', impact: 'UP', detail: `AUD/USD: ${aud.rate.toFixed(4)} — Australian origin cost slightly elevated` });
    }
  }

  if (signals.currency.drivers.length === 0) {
    signals.currency.drivers.push({ label: 'FX stable', severity: 'LOW', impact: 'NEUTRAL', detail: 'GCC currencies pegged to USD. No significant ME import cost impact from FX moves' });
  }

  // ── 5. NEWS SENTIMENT SIGNALS ────────────────────────────────────
  let newsHighCount = 0, newsMedCount = 0;
  const triggeredNews = [];

  for (const article of (news || [])) {
    const text = ((article.title || '') + ' ' + (article.description || '')).toLowerCase();
    let articleScore = 0;
    const matchedKeywords = [];

    for (const kw of NEWS_KEYWORDS.HIGH_IMPACT) {
      if (text.includes(kw)) { articleScore += 3; matchedKeywords.push(kw); }
    }
    for (const kw of NEWS_KEYWORDS.MEDIUM_IMPACT) {
      if (text.includes(kw)) { articleScore += 1; matchedKeywords.push(kw); }
    }
    for (const kw of NEWS_KEYWORDS.LOW_IMPACT) {
      if (text.includes(kw)) { articleScore += 0.3; }
    }

    if (articleScore >= 3) {
      newsHighCount++;
      signals.news.score += 3;
      triggeredNews.push({ title: article.title, keywords: matchedKeywords.slice(0, 3), score: articleScore, url: article.url });
    } else if (articleScore >= 1) {
      newsMedCount++;
      signals.news.score += 1;
    }
  }

  if (triggeredNews.length > 0) {
    signals.news.triggeredNews = triggeredNews;
    signals.news.drivers.push({
      label: `${newsHighCount} high-impact news signals`,
      severity: newsHighCount >= 3 ? 'HIGH' : 'MEDIUM',
      impact: 'UP',
      detail: `Top signals: ${triggeredNews.slice(0, 2).map(n => `"${n.title.slice(0, 60)}..." [${n.keywords.join(', ')}]`).join(' | ')}`,
    });
  } else {
    signals.news.triggeredNews = [];
    signals.news.drivers.push({ label: 'News — Quiet', severity: 'LOW', impact: 'NEUTRAL', detail: 'No high-impact supply chain disruption signals in recent news' });
  }

  // ── 6. LOGISTICS & USDA SIGNALS ──────────────────────────────────
  if (logistics) {
    if (logistics.freightRates?.trend === 'SPIKING') {
      signals.logistics.score += 6;
      signals.logistics.drivers.push({ label: 'Reefer Rates Spiking', severity: 'HIGH', impact: 'UP', detail: `Freight spot rate estimated at $${logistics.freightRates.reeferIndexFEU}/FEU. High bunker/geopolitical surcharges active.` });
    }
    const congestedPorts = (logistics.portCongestion || []).filter(p => p.status === 'CRITICAL' || p.status === 'CONGESTED');
    if (congestedPorts.length > 0) {
      signals.logistics.score += congestedPorts.length * 2;
      signals.logistics.drivers.push({ label: `Port Congestion: ${congestedPorts[0].port}`, severity: congestedPorts[0].status === 'CRITICAL' ? 'HIGH' : 'MEDIUM', impact: 'UP', detail: `${congestedPorts[0].port} wait time up to ${congestedPorts[0].turnaroundDays} days (${congestedPorts[0].reason}).` });
    }
  }

  if (usda) {
    for (const [crop, data] of Object.entries(usda.ratings)) {
      if (data.trend === 'DOWNGRADED') {
        signals.weather.score += 3;
        signals.weather.drivers.push({ label: `USDA Sim: ${crop.toUpperCase()} Downgrade`, severity: 'MEDIUM', impact: 'UP', detail: `Simulated USDA crop rating for ${crop} dropped to ${data.goodExcellent}% Good/Excellent due to prevailing drought conditions.` });
      }
    }
  }

  // ── TOTAL COMPOSITE SCORE ────────────────────────────────────────
  const totalScore = (
    signals.energy.score * 0.20 +
    signals.commodity.score * 0.25 +
    signals.weather.score * 0.20 +
    signals.currency.score * 0.15 +
    signals.news.score * 0.10 +
    signals.logistics.score * 0.10
  );

  return { signals, totalScore, volatileCount };
}

// ── MARKET STATE from composite score ─────────────────────────────
function deriveMarketState(totalScore) {
  if (totalScore >= 12) return 'CRISIS';
  if (totalScore >= 7)  return 'DISRUPTED';
  if (totalScore >= 3)  return 'VOLATILE';
  return 'STABLE';
}

// ── CONFIDENCE from signal consistency ────────────────────────────
function deriveConfidence(signals, totalScore) {
  // More signals firing in the same direction = higher confidence
  const allDrivers = [
    ...signals.energy.drivers,
    ...signals.commodity.drivers,
    ...signals.weather.drivers,
    ...signals.currency.drivers,
    ...signals.news.drivers,
  ];
  const upCount   = allDrivers.filter(d => d.impact === 'UP').length;
  const downCount = allDrivers.filter(d => d.impact === 'DOWN').length;
  const neutralCount = allDrivers.filter(d => d.impact === 'NEUTRAL').length;
  const total = allDrivers.length;

  const dominance = Math.max(upCount, downCount, neutralCount) / Math.max(total, 1);
  const base = 40 + (dominance * 35) + Math.min(totalScore * 1.5, 15);
  return Math.min(Math.round(base), 92); // Cap at 92 — never claim 100% algorithmic certainty
}

// ── FORECAST ENGINE: 7D / 30D / 90D ──────────────────────────────
function buildForecast(signals, marketState, totalScore, { prices, energy, weatherExtended, weather, forex }) {
  const brent = parseFloat(energy?.brent?.current?.value) || 82;
  const affectedComms = signals.weather.affectedCommodities;
  const highAlerts = signals.weather.drivers.filter(d => d.severity === 'HIGH' || d.severity === 'CRITICAL');
  const energyHigh = signals.energy.score >= 5;
  const commodityVolatile = signals.commodity.score >= 5;
  const egpWeak = signals.currency.drivers.some(d => d.label.includes('EGP'));
  const newsHigh = signals.news.score >= 6;

  // ── Price pressure index for frozen food basket (composite) ──
  const liveSnap = {};
  for (const p of (prices || [])) liveSnap[p.symbol] = p;

  // FEEDER_CATTLE + MILK + PALM_OIL + BRENT → cold chain basket
  const basketMoves = ['FEEDER_CATTLE', 'MILK', 'PALM_OIL', 'BRENT_CRUDE', 'CORN', 'SOYBEANS']
    .map(s => {
      const p = liveSnap[s];
      return p ? parseFloat(p.changePct || 0) : 0;
    })
    .filter(v => !isNaN(v));
  const avgBasketMove = basketMoves.length
    ? basketMoves.reduce((a, b) => a + b, 0) / basketMoves.length
    : 0;

  // ── MARKET FORECAST (AI-Generated via Llama 3) ──────────────────────────
  const llmForecast = signals.llmForecast || {
    next7d: "Pending AI generation...",
    next30d: "Pending AI generation...",
    next90d: "Pending AI generation...",
    confidence: "PENDING"
  };

  return {
    next7d: llmForecast.next7d,
    next30d: llmForecast.next30d,
    next90d: llmForecast.next90d,
    confidence: llmForecast.confidence,
  };
}

// ── DRIVERS array (LLM-compatible format) ─────────────────────────
function buildDrivers(signals) {
  const drivers = [];

  const allRaw = [
    ...signals.energy.drivers.map(d => ({ ...d, category: 'Energy' })),
    ...signals.commodity.drivers.map(d => ({ ...d, category: 'Commodity' })),
    ...signals.weather.drivers.map(d => ({ ...d, category: 'Weather' })),
    ...signals.currency.drivers.map(d => ({ ...d, category: 'Currency' })),
    ...signals.news.drivers.map(d => ({ ...d, category: 'News' })),
    ...signals.logistics.drivers.map(d => ({ ...d, category: 'Logistics' })),
  ].filter(d => d.impact !== 'NEUTRAL' || d.severity !== 'LOW')
   .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  for (const d of allRaw.slice(0, 6)) {
    drivers.push({
      factor: `${d.category}: ${d.label}`,
      direction: d.impact || 'NEUTRAL',
      strength: severityRank(d.severity) * 2.5,
      explanation: d.detail || '',
      evidence: [d.label],
    });
  }

  return drivers.length > 0 ? drivers : [{
    factor: 'Market: All signals nominal',
    direction: 'NEUTRAL',
    strength: 1,
    explanation: 'No significant drivers detected. Market operating within normal parameters.',
    evidence: ['No anomalies'],
  }];
}

// ── CAUSE-EFFECT CHAINS ───────────────────────────────────────────
function buildCauseEffectChains(signals, { energy, forex }) {
  const chains = [];
  const brent = parseFloat(energy?.brent?.current?.value) || 82;
  const egp = forex?.['EGP'];

  // Chain 1: Energy → freight → landed cost
  if (signals.energy.score >= 3) {
    chains.push({
      chain: [
        `Brent Crude at $${brent.toFixed(1)}/bbl — ${brent > 90 ? 'above key $90 threshold' : 'elevated vs prior quarter'}`,
        `Reefer (refrigerated container) freight rates rising — carriers imposing fuel surcharges`,
        `CIF landed cost for frozen goods to GCC ports increases 3-8%`,
        `End-market frozen food retail prices at risk of $0.10-0.30/kg upward adjustment within 30-45 days`,
      ],
    });
  }

  // Chain 2: Weather drought → yield → price
  const droughtDrivers = signals.weather.drivers.filter(d => d.label?.includes('DROUGHT') || d.label?.includes('HEAT'));
  if (droughtDrivers.length > 0) {
    const dd = droughtDrivers[0];
    const comms = (dd.commodities || []).slice(0, 2).join(' and ');
    chains.push({
      chain: [
        `${dd.label} in ${dd.region || 'key growing region'} — precipitation deficit and/or extreme temperatures`,
        `Crop stress triggers yield reduction estimates for ${comms || 'affected commodities'}`,
        `Export volumes from origin country contract; spot market tightens`,
        `Middle East importers face higher procurement costs and longer lead times for affected categories`,
      ],
    });
  }

  // Chain 3: EGP devaluation → demand compression
  if (egp?.rate > 45) {
    chains.push({
      chain: [
        `Egyptian Pound at ${egp.rate.toFixed(1)} vs USD — persistent devaluation pressure`,
        `Egyptian importers' USD purchasing power reduced; food import bill in EGP terms inflates`,
        `Cairo buyers downgrade to lower-cost origins and delay discretionary frozen food orders`,
        `Reduced Egyptian demand creates short-term inventory overhang in Brazilian/EU export markets, mild price relief for GCC buyers`,
      ],
    });
  }

  // Chain 4: Feed cost → poultry/aquaculture
  const cornMove = signals.commodity.drivers.find(d => d.commodity === 'CORN');
  const soyMove  = signals.commodity.drivers.find(d => d.commodity === 'SOYBEANS');
  if ((cornMove?.impact === 'UP' || soyMove?.impact === 'UP')) {
    chains.push({
      chain: [
        `Corn/Soy prices rising — key inputs for broiler and shrimp/fish feed`,
        `Integrators face margin squeeze at $0.08-0.15/kg feed cost increase per kg protein produced`,
        `Frozen chicken and frozen seafood ex-works prices adjust upward in 4-6 week processing cycle`,
        `GCC retailers and HORECA operators see cost escalation in frozen poultry/seafood categories`,
      ],
    });
  }

  // Fallback chain
  if (chains.length === 0) {
    chains.push({
      chain: [
        'Current market inputs within normal volatility bands',
        'Supply chain functioning at baseline efficiency',
        'No significant cost escalation signals detected',
        'Maintain standard procurement schedule; monitor weekly for regime change',
      ],
    });
  }

  return chains.slice(0, 3);
}

// ── ALERTS ────────────────────────────────────────────────────────
function buildAlerts(signals, weatherExtended, livePricesSnapshot) {
  const alerts = [];

  // NOTE: transient keyword-triggered news is intentionally NOT injected
  // here. The Alerts tab must show exactly the persistent alerts store —
  // unpersisted extras made it disagree with the Morning Brief and could
  // never be acknowledged.

  // Live User-Specific Alerts (persistent event×exposure store)
  if (signals.userAlerts && signals.userAlerts.length > 0) {
    for (const a of signals.userAlerts) {
      alerts.push({
        id: a.id, // DB id — enables acknowledge from the UI
        category: a.category || null,
        severity: a.severity || 'CRITICAL',
        title: a.title || `🎯 Profile Alert: Match Detected`,
        reason: a.reason || a.headline || 'Match Detected',
        timestamp: a.timestamp || new Date(a.detectedAt || Date.now()).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST',
        url: a.url,
        regions: ['User Tracked Regions'],
        extractSummary: a.extractSummary || null, // MiniLM key sentences, precomputed at alert time
      });
    }
  }

  // Live Geopolitical News Alerts
  if (signals.geoAlerts && signals.geoAlerts.length > 0) {
    for (const a of signals.geoAlerts) {
      alerts.push({
        severity: a.severity || 'HIGH',
        title: `🚨 Geo-Alert: ${a.category || 'Supply Chain'}`,
        reason: a.headline,
        timestamp: new Date(a.detectedAt || Date.now()).toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST',
        url: a.url,
        regions: ['Global'],
      });
    }
  }

  // Ensure unique alerts by title to avoid spam
  const uniqueAlertsMap = new Map();
  for (const a of alerts) {
      uniqueAlertsMap.set(a.title, a);
  }

  return Array.from(uniqueAlertsMap.values()).slice(0, 20);
}

// ── SCENARIO ENGINE ────────────────────────────────────────────────
function buildScenarioEngine(signals, totalScore, { energy, weatherExtended }) {
  const brent = parseFloat(energy?.brent?.current?.value) || 82;
  const droughtActive = signals.weather.score >= 5;
  const energyHigh = signals.energy.score >= 5;
  const newsHigh = signals.news.score >= 6;

  // Base probability: inverse of total stress score
  const baseProbability = Math.max(30, Math.min(70, 70 - (totalScore * 2)));
  const stressProbability = 100 - baseProbability;

  const baseOutcome = (() => {
    if (totalScore <= 2) return `Market remains stable. Commodity prices stay within ±3% of current levels. Cold chain costs hold steady. GCC frozen food importers operate on normal lead times. Recommend maintaining standard inventory positions.`;
    if (totalScore <= 6) return `Brent stabilizes near $${brent.toFixed(0)}/bbl. ${droughtActive ? 'Weather-affected crops partially offset by global stock drawdown. ' : ''}Frozen food landed costs increase 2-4%. ME importers absorb through margin adjustment rather than volume cuts.`;
    return `Current stress signals partially resolve within 4-6 weeks. Energy costs moderate. Commodity prices stabilize. Supply chain operates at elevated cost but no disruption. Procurement teams implement 15-20% safety stock increase as buffer.`;
  })();

  const stressOutcome = (() => {
    const triggers = [];
    if (brent > 85) triggers.push(`Brent surpasses $${(brent + 15).toFixed(0)}/bbl`);
    if (droughtActive) triggers.push('drought conditions persist 45+ days in ' + (signals.weather.affectedCommodities.slice(0, 2).join('/') || 'key regions'));
    if (newsHigh) triggers.push('shipping lane disruption materializes');
    if (triggers.length === 0) triggers.push('black swan geopolitical event triggers supply disruption');

    return `Stress trigger: ${triggers[0]}. ${droughtActive ? `${signals.weather.affectedCommodities.slice(0, 2).join(' and ')} prices spike 10-20%. ` : ''}${energyHigh ? 'Freight surcharges reach 12-18% on reefer bookings. ' : ''}GCC frozen food prices rise 8-15% at retail. Egypt experiences localized shortages in lower-income market segments. Emergency procurement at spot prices required.`;
  })();

  const baseWatchSignals = [
    `Brent Crude weekly close vs $${(brent + 5).toFixed(0)} trigger`,
    'Port congestion reports: Jebel Ali, King Abdulaziz, Shuwaikh',
    droughtActive ? `Precipitation recovery in ${signals.weather.affectedCommodities.slice(0, 2).join('/')} growing regions` : 'Weekly crop condition reports (USDA/FAO)',
  ].filter(Boolean);

  const stressWatchSignals = [
    `Brent Crude daily close above $${(brent + 12).toFixed(0)}/bbl`,
    signals.weather.affectedCommodities.length > 0 ? `USDA/FAO emergency crop assessment for ${signals.weather.affectedCommodities.slice(0, 2).join(', ')}` : 'FAO Food Price Index monthly release',
    'Local distribution bottleneck and regional freight delay reports',
    'EGP official rate and CBE policy announcements',
  ];

  return [
    {
      name: 'BASE',
      probability: baseProbability,
      outcome: baseOutcome,
      watchSignals: baseWatchSignals,
    },
    {
      name: 'STRESS',
      probability: stressProbability,
      outcome: stressOutcome,
      watchSignals: stressWatchSignals,
    },
  ];
}




// ── COUNTERFACTUALS ────────────────────────────────────────────────
function buildCounterfactuals(signals, { energy, forex }) {
  const brent = parseFloat(energy?.brent?.current?.value) || 82;
  const counterfactuals = [];

  if (signals.energy.score >= 3) {
    counterfactuals.push({
      question: `What if Brent Crude dropped to $65/bbl from current $${brent.toFixed(0)}/bbl?`,
      answer: `Reefer freight rates would decline 8-12%, reducing frozen food CIF landed cost by ~3-5%. Cold storage operators would see 10-15% energy cost relief. GCC importers would gain margin headroom but may not pass savings to retail for 30-60 days due to existing contract lock-ins.`,
    });
  }

  if (signals.weather.score >= 4) {
    const region = signals.weather.drivers[0]?.region || 'key growing region';
    const comms = signals.weather.affectedCommodities.slice(0, 2).join(' and ');
    counterfactuals.push({
      question: `What if weather conditions normalized in ${region} within 2 weeks?`,
      answer: `If precipitation recovers rapidly, the current weather risk premium in ${comms || 'affected commodities'} would unwind over 3-4 weeks. However, any crop damage already incurred from the stress period would still flow through harvest yield data in Q3. Price recovery would be partial and lagged — not immediate.`,
    });
  }

  counterfactuals.push({
    question: 'What if a major regional port congestion event occurred lasting 2-4 weeks?',
    answer: `Local food imports rely on smooth logistics infrastructure. A 2-4 week disruption at key regional ports would trigger immediate 15-25% price spikes in frozen staples due to container shortages and demurrage fees. Strategic reserves would be partially activated. Alternative inland routing would add 5-8 days transit time and elevate end-to-end transport costs by $200-400 per TEU.`,
  });

  return counterfactuals.slice(0, 3);
}

// ── SUMMARY ────────────────────────────────────────────────────────
function buildSummary(signals, marketState, confidence, totalScore) {
  const topDriver = [
    ...signals.energy.drivers,
    ...signals.commodity.drivers,
    ...signals.weather.drivers,
    ...signals.currency.drivers,
  ].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];

  const stateLabel = {
    STABLE:    'Market conditions stable — standard procurement posture',
    VOLATILE:  'Elevated volatility — active monitoring required',
    DISRUPTED: 'Supply disruption signals active — tactical response needed',
    CRISIS:    'CRISIS: Multiple high-severity signals — emergency protocols',
  }[marketState];

  let headline = stateLabel;
  if (topDriver && topDriver.severity !== 'LOW') {
    const label = topDriver.label || '';
    if (label.length < 40) headline = `${label}: ${marketState === 'STABLE' ? 'Monitor' : 'Act Now'}`;
  }

  const whyNow = (() => {
    const reasons = [];
    if (signals.energy.score >= 5) reasons.push('energy costs above freight trigger threshold');
    if (signals.weather.score >= 5) reasons.push(`${signals.weather.affectedCommodities.slice(0, 2).join('/')} weather risk activated`);
    if (signals.commodity.score >= 5) reasons.push('commodity basket showing unusual price movement');
    if (signals.currency.score >= 5) reasons.push('EGP devaluation compressing Egypt import capacity');
    if (signals.news.score >= 6) reasons.push('high-impact news signals flagged in supply chain media');
    if (reasons.length === 0) return 'Routine monitoring cycle. No anomalies detected vs prior session.';
    return `Deterministic engine flagged: ${reasons.join('; ')}.`;
  })();

  return {
    headline: headline.slice(0, 60),
    market_state: marketState,
    confidence,
    why_now: whyNow,
  };
}

// ── MISSING DATA ───────────────────────────────────────────────────
function buildMissingData(signals) {
  const missing = [];

  if (signals.weather.score === 0) missing.push('Soil moisture satellite data for key growing regions (ESA CCI or SMAP)');
  if (signals.currency.score < 2) missing.push('Live EGP black market rate vs official CBE rate');
  if (signals.news.score < 2) missing.push('Arabic-language news sources for GCC-specific food import signals');

  return missing.slice(0, 5);
}

// ── MAIN EXPORT ────────────────────────────────────────────────────
/**
 * runDeterministicEngine(inputData)
 * @param {Object} inputData - Same body as POST /api/analyze
 *   { prices, news, weather, energy, forex, weatherExtended, livePricesSnapshot }
 * @returns {Object} Full analysis JSON matching LLM schema
 */
function runDeterministicEngine(inputData) {
  const { prices, news, weather, energy, forex, weatherExtended, livePricesSnapshot, logistics, usda, geoAlerts, userAlerts } = inputData;

  // Score all signals
  const { signals, totalScore, volatileCount } = scoreSignals({
    prices, news, weather, energy, forex,
    weatherExtended: weatherExtended || [],
    livePricesSnapshot: livePricesSnapshot || {},
    logistics,
    usda,
    geoAlerts,
    userAlerts
  });

  const marketState = deriveMarketState(totalScore);
  const confidence  = deriveConfidence(signals, totalScore);

  return {
    summary:               buildSummary(signals, marketState, confidence, totalScore),
    drivers:               buildDrivers(signals),
    causeEffectChains:     buildCauseEffectChains(signals, { energy, forex }),
    alerts:                buildAlerts(signals, weatherExtended || [], livePricesSnapshot || {}),
    forecast:              buildForecast(signals, marketState, totalScore, { prices, energy, weatherExtended, weather, forex }),
    scenarioEngine:        buildScenarioEngine(signals, totalScore, { energy, weatherExtended }),
    counterfactuals:       buildCounterfactuals(signals, { energy, forex }),
    missingData:           buildMissingData(signals),
    // Engine metadata (optional, not in LLM schema but useful for debugging)
    _engineMeta: {
      provider: 'deterministic-v1',
      totalScore: +totalScore.toFixed(2),
      signalScores: {
        energy: signals.energy.score,
        commodity: signals.commodity.score,
        weather: signals.weather.score,
        currency: signals.currency.score,
        news: signals.news.score,
      },
    },
  };
}

// ── HELPERS ────────────────────────────────────────────────────────
function severityRank(s) {
  return { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }[s] || 0;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { runDeterministicEngine };
export default runDeterministicEngine;
