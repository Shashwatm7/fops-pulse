import fetch from 'node-fetch';

export async function getDynamicContext(focusProduct, focusRegion, callGroq) {
    console.log(`[ROUTER] Determining dynamic context for ${focusProduct} in ${focusRegion}...`);
    
    // 1. LLM decides the dynamic regions and keywords
    const routingPrompt = `You are a supply chain intelligence router. 
The user is tracking the commodity: "${focusProduct}" with a focus on importing to: "${focusRegion}".

Determine the TOP 2 global supply/export regions that most heavily impact the global price and supply of "${focusProduct}".
Also, provide 3 specific news search keywords to track supply chain disruptions for this commodity.

Return ONLY a valid JSON object with the following structure:
{
  "regions": [
    {
      "name": "Region Name (e.g. US Midwest, New Zealand)",
      "lat": 12.34,
      "lon": 56.78,
      "reason": "Why this region is critical for this commodity"
    }
  ],
  "news_keywords": ["keyword1", "keyword2", "keyword3"]
}
`;

    let routingDecision;
    try {
        const rawDecision = await callGroq('llama-3-8b-8192', routingPrompt, "Respond only with valid JSON.", true, 500, 0.1, true);
        routingDecision = JSON.parse(rawDecision);
    } catch (e) {
        console.error('[ROUTER] Failed to route via LLM. Using fallback.', e.message);
        // Fallback
        routingDecision = {
            regions: [{ name: "Global", lat: 0, lon: 0, reason: "Fallback" }],
            news_keywords: [focusProduct, "supply chain", "shortage"]
        };
    }

    if (!routingDecision || !routingDecision.regions) {
        routingDecision = {
            regions: [{ name: "Global", lat: 0, lon: 0, reason: "Fallback" }],
            news_keywords: [focusProduct, "supply chain", "shortage"]
        };
    }

    // 2. Fetch specific weather for those regions
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
