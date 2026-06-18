// logistics-engine.js
// Simulates live maritime and logistics data based on deterministic variables

export function simulateLogistics({ energy, alerts, weatherExtended }) {
    // 1. Reefer Freight Rates (Base $4,200 per 40ft FEU for Middle East inbound)
    let reeferBaseRate = 4200;
    
    // Oil impact
    const brentPrice = energy?.brent?.current?.value || 75;
    if (brentPrice > 70) {
        // Add $25 surcharge for every dollar above $70
        reeferBaseRate += (brentPrice - 70) * 25;
    }

    // Geopolitical Impact
    let redSeaDisruption = false;
    const allAlertsText = (alerts || []).map(a => `${a.title} ${a.reason}`).join(' ').toLowerCase();
    if (allAlertsText.includes('hormuz') || allAlertsText.includes('red sea') || allAlertsText.includes('houthis') || allAlertsText.includes('suez')) {
        redSeaDisruption = true;
        reeferBaseRate += 1800; // Massive war-risk insurance and rerouting premium
    }

    // 2. Port Congestion
    const ports = [
        { name: 'Jebel Ali (UAE)', baseWaitDays: 1.5 },
        { name: 'KAPS (Saudi Arabia)', baseWaitDays: 2.0 },
        { name: 'Salalah (Oman)', baseWaitDays: 1.2 }
    ];

    const activeCongestion = ports.map(port => {
        let waitDays = port.baseWaitDays;
        let status = 'NORMAL';
        let reason = 'Standard operations';

        // Weather disruption (simulate based on general regional weather alerts)
        const hasSevereWeather = (weatherExtended || []).some(w => w.analytics?.alert === 'FLOOD_RISK' || w.analytics?.alert === 'HEAT_STRESS');
        if (hasSevereWeather) {
            waitDays += 1.5;
            status = 'CONGESTED';
            reason = 'Weather delays slowing yard operations';
        }

        // Geopolitical disruption
        if (redSeaDisruption) {
            waitDays += 3.5;
            status = 'CRITICAL';
            reason = 'Vessel rerouting causing sudden TEU bunching and yard density spikes';
        }

        return {
            port: port.name,
            turnaroundDays: parseFloat(waitDays.toFixed(1)),
            status,
            reason
        };
    });

    // 3. Air Freight Rates (Base $3.50/kg)
    let airFreightBase = 3.50;
    // Jet fuel is highly correlated to Brent Crude
    if (brentPrice > 75) {
        airFreightBase += (brentPrice - 75) * 0.05;
    }
    // Red Sea disruption drives ocean volume to air
    if (redSeaDisruption) {
        airFreightBase *= 1.35; // 35% surge pricing
    }

    // 4. Geopolitical Risk Index (Scale 1-10)
    let geoRiskScore = 3.0; // Base regional tension
    if (redSeaDisruption) geoRiskScore += 4.5;
    const severeAlerts = (alerts || []).filter(a => a.severity === 'CRITICAL' || a.severity === 'HIGH').length;
    geoRiskScore += (severeAlerts * 0.5);
    geoRiskScore = Math.min(geoRiskScore, 10.0);

    return {
        freightRates: {
            reeferIndexFEU: parseFloat(reeferBaseRate.toFixed(0)),
            bunkerSurchargeImpact: brentPrice > 80 ? 'HIGH' : 'NORMAL',
            trend: redSeaDisruption ? 'SPIKING' : 'STABLE'
        },
        portCongestion: activeCongestion,
        airFreightRates: {
            ratePerKg: parseFloat(airFreightBase.toFixed(2)),
            trend: redSeaDisruption ? 'SURGING' : 'STABLE'
        },
        geopoliticalRiskIndex: parseFloat(geoRiskScore.toFixed(1))
    };
}
