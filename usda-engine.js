// usda-engine.js
// Simulates live USDA Crop Condition Ratings by crossing historical baseline expectations
// with real-time Open-Meteo drought and heat stress calculations.

export function simulateUSDA(weatherExtended) {
    const ratings = {
        corn: { goodExcellent: 68, poorVeryPoor: 8, trend: 'STABLE' },
        wheat: { goodExcellent: 55, poorVeryPoor: 15, trend: 'STABLE' },
        soybeans: { goodExcellent: 65, poorVeryPoor: 10, trend: 'STABLE' }
    };

    if (!weatherExtended || weatherExtended.length === 0) {
        return { timestamp: new Date().toISOString(), source: "Deterministic Simulation (Open-Meteo Linked)", ratings };
    }

    // Evaluate US Corn Belt for Corn & Soybeans
    const usCornBelt = weatherExtended.find(w => w.name.includes('US Corn Belt'));
    if (usCornBelt && usCornBelt.analytics) {
        const droughtScore = usCornBelt.analytics.droughtScore || 0;
        if (droughtScore > 60) {
            ratings.corn.goodExcellent -= 12;
            ratings.corn.poorVeryPoor += 8;
            ratings.corn.trend = 'DOWNGRADED';

            ratings.soybeans.goodExcellent -= 10;
            ratings.soybeans.poorVeryPoor += 7;
            ratings.soybeans.trend = 'DOWNGRADED';
        } else if (usCornBelt.analytics.recentPrecipMm > 40) {
            ratings.corn.goodExcellent += 4;
            ratings.corn.trend = 'IMPROVING';
        }
    }

    // Evaluate Global Wheat (using Ukraine, Canada Prairies, Australia as proxies)
    const wheatRegions = weatherExtended.filter(w => w.crop === 'Wheat');
    let totalDroughtScore = 0;
    wheatRegions.forEach(w => {
        totalDroughtScore += (w.analytics?.droughtScore || 0);
    });
    
    if (wheatRegions.length > 0) {
        const avgDrought = totalDroughtScore / wheatRegions.length;
        if (avgDrought > 50) {
            ratings.wheat.goodExcellent -= 15;
            ratings.wheat.poorVeryPoor += 10;
            ratings.wheat.trend = 'DOWNGRADED';
        } else if (avgDrought < 20) {
            ratings.wheat.goodExcellent += 5;
            ratings.wheat.trend = 'IMPROVING';
        }
    }

    return {
        timestamp: new Date().toISOString(),
        source: "Deterministic Simulation (Open-Meteo Linked)",
        ratings
    };
}
