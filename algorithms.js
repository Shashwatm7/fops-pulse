import * as ss from 'simple-statistics';
import Sentiment from 'sentiment';
import { EMA, RSI } from 'technicalindicators';

const sentimentAnalyzer = new Sentiment();

/**
 * Calculates mathematical projections, sentiment scores, and scenario probabilities
 * @param {Array} prices - Array of historical price objects { timestamp, value }
 * @param {Array} news - Array of news articles { title, description }
 * @param {Array} weather - Array of daily precipitation values [num, num, ...]
 * @returns {Object} Algorithmic constraints for the LLM
 */
export function runHybridAnalysis(prices = [], news = [], weather = []) {
  // 1. Time-Series Mathematical Forecasting
  let forecast7d = 0;
  let forecast30d = 0;
  let forecast90d = 0;
  let volatility = 0;
  let currentPrice = 0;

  if (prices.length > 5) {
    // Sort chronologically just in case
    const sortedPrices = [...prices].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const values = sortedPrices.map(p => Number(p.value));
    currentPrice = values[values.length - 1];

    // Prepare data for Linear Regression: [x, y] where x is day index
    const dataPoints = values.map((val, idx) => [idx, val]);
    const regression = ss.linearRegression(dataPoints);
    const line = ss.linearRegressionLine(regression);

    // Predict future prices
    const lastIndex = values.length - 1;
    const pred7 = line(lastIndex + 7);
    const pred30 = line(lastIndex + 30);
    const pred90 = line(lastIndex + 90);

    // Calculate percentage change from current price
    if (currentPrice > 0) {
      forecast7d = ((pred7 - currentPrice) / currentPrice) * 100;
      forecast30d = ((pred30 - currentPrice) / currentPrice) * 100;
      forecast90d = ((pred90 - currentPrice) / currentPrice) * 100;
    }

    // Calculate Volatility (Standard Deviation of daily returns)
    const returns = [];
    for (let i = 1; i < values.length; i++) {
      const returnPct = (values[i] - values[i - 1]) / (values[i - 1] || 1);
      returns.push(returnPct);
    }
    if (returns.length > 1) {
      const stdDev = ss.standardDeviation(returns);
      volatility = isNaN(stdDev) ? 0 : stdDev * 100; // as percentage
    } else {
      volatility = 0;
    }

    // Advanced Momentum Indicators (RSI & EMA)
    if (values.length > 14) {
      const rsiOutput = RSI.calculate({ values: values, period: 14 });
      const currentRsi = rsiOutput.length > 0 ? rsiOutput[rsiOutput.length - 1] : 50;
      
      // Momentum Curve: If RSI is heavily overbought (>70) but linear regression projects up, 
      // we mathematically dampen the projection because a correction is due.
      if (currentRsi > 70 && forecast30d > 0) {
        forecast30d = forecast30d * (1 - ((currentRsi - 70) / 100)); // Dampen up to 30%
      } else if (currentRsi < 30 && forecast30d < 0) {
        forecast30d = forecast30d * (1 - ((30 - currentRsi) / 100)); // Dampen downside
      }
    }
  }

  // 2. NLP Sentiment Analysis
  let totalSentiment = 0;
  let validNewsCount = 0;
  
  // Custom supply chain dictionary
  const customLexicon = {
    'drought': -4, 'strike': -3, 'blockade': -5, 'shortage': -4, 'ban': -4,
    'surplus': 3, 'bumper': 4, 'yields': 2, 'crisis': -5, 'war': -5,
    'storm': -3, 'flood': -4, 'disruption': -3, 'tension': -2, 'escalation': -4
  };

  if (news && news.length > 0) {
    news.forEach(article => {
      const text = `${article.title || ''} ${article.description || ''}`;
      if (text.trim()) {
        const result = sentimentAnalyzer.analyze(text, { extras: customLexicon });
        // Result score is an integer. Normalize loosely between -1 and 1
        // Usually, a score of +/- 5 is quite strong for a sentence.
        const normalized = Math.max(-1, Math.min(1, result.comparative * 2)); 
        totalSentiment += normalized;
        validNewsCount++;
      }
    });
  }
  const avgSentiment = validNewsCount > 0 ? (totalSentiment / validNewsCount) : 0;

  // 3. Weather Analytics
  let totalRain = 0;
  let droughtRisk = false;
  if (weather && weather.length > 0) {
    totalRain = weather.reduce((sum, val) => sum + (Number(val) || 0), 0);
    if (totalRain < 15) { // Arbitrary drought threshold for 30 days
      droughtRisk = true;
    }
  }

  // 4. Rule-Based Scenario Engine (Compounding Risk Matrix)
  let baseRisk = 10; // Baseline risk
  let stressTriggers = [];

  // Volatility Multiplier
  let volMult = 1.0;
  if (volatility > 2.0) {
    volMult = 1.5;
    stressTriggers.push(`High historical price volatility (${volatility.toFixed(1)}% daily std dev)`);
  }

  // Sentiment Multiplier
  let sentMult = 1.0;
  if (avgSentiment < -0.2) {
    sentMult = 1.8;
    stressTriggers.push(`Severe macro/supply chain sentiment (Score: ${avgSentiment.toFixed(2)})`);
  } else if (avgSentiment < 0) {
    sentMult = 1.2;
  }

  // Weather Multiplier
  let weatherMult = 1.0;
  if (droughtRisk) {
    weatherMult = 2.0;
    stressTriggers.push(`Severe precipitation deficit (Only ${totalRain.toFixed(1)}mm over 30 days)`);
  }

  // Trend Multiplier
  let trendMult = 1.0;
  if (Math.abs(forecast30d) > 8) {
    trendMult = 1.3;
    stressTriggers.push(`Aggressive 30-day algorithmic trend (${forecast30d > 0 ? '+' : ''}${forecast30d.toFixed(1)}%)`);
  }

  // Compounding Matrix Calculation
  let stressProbability = baseRisk * volMult * sentMult * weatherMult * trendMult;

  // Cap probabilities between 5% and 95%
  stressProbability = Math.min(95, Math.max(5, Math.round(stressProbability)));
  const baseProbability = 100 - stressProbability;

  return {
    forecasts: {
      next7d_percent: forecast7d.toFixed(2),
      next30d_percent: forecast30d.toFixed(2),
      next90d_percent: forecast90d.toFixed(2),
      volatility_percent: volatility.toFixed(2)
    },
    sentiment: {
      score: avgSentiment.toFixed(2),
      interpretation: avgSentiment > 0.2 ? 'POSITIVE' : avgSentiment < -0.2 ? 'NEGATIVE' : 'NEUTRAL'
    },
    weather: {
      total_rain_30d: totalRain.toFixed(1),
      drought_risk: droughtRisk
    },
    scenarios: {
      base_probability: baseProbability,
      stress_probability: stressProbability,
      stress_triggers: stressTriggers.length > 0 ? stressTriggers : ['Unforeseen systemic macro shocks']
    }
  };
}
