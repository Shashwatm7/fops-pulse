import fetch from 'node-fetch';

export async function getDynamicContext(focusProduct, focusRegion, callGroq) {
    console.log(`[ROUTER] Determining dynamic context for ${focusProduct} in ${focusRegion}...`);
    
    const routingDecision = {
        regions: [{ name: "Global", lat: 0, lon: 0, reason: "Deterministic fallback; LLM routing disabled" }],
        news_keywords: [focusProduct, "supply chain", "shortage"]
    };

    // Fetch specific weather for those regions
    let regionalWeather = [];
    for (const region of routingDecision.regions) {
        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${region.lat}&longitude=${region.lon}&daily=temperature_2m_max,temperature_2m_min,rain_sum&past_days=1&forecast_days=3&timezone=auto`;
            const wRes = await fetch(url);
            if (wRes.ok) {
                const wData = await wRes.json();
                regionalWeather.push({
                    region: region.name,
                    reason: region.reason,
                    forecast: wData.daily
                });
            }
        } catch (e) {
            console.error(`[ROUTER] Failed to fetch weather for ${region.name}`);
        }
    }

    // 3. Return the bundled dynamic context
    return {
        routing_metadata: routingDecision,
        dynamic_weather: regionalWeather,
        dynamic_news_keywords: routingDecision.news_keywords
    };
}
