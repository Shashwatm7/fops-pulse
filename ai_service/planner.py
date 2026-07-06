import os
import json
import httpx
import asyncio
import re
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

async def call_gemini(system_prompt: str, user_prompt: str, json_mode: bool = True):
    headers = {
        "Content-Type": "application/json"
    }
    
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
    
    payload = {
        "system_instruction": {
            "parts": [{"text": system_prompt}]
        },
        "contents": [
            {"parts": [{"text": user_prompt}]}
        ],
        "generationConfig": {
            "temperature": 0.1
        }
    }
    
    if json_mode:
        payload["generationConfig"]["responseMimeType"] = "application/json"
        
    
    for attempt in range(3):
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, headers=headers, timeout=30.0)
                response.raise_for_status()
                data = response.json()
                content = data["candidates"][0]["content"]["parts"][0]["text"]
                if json_mode:
                    try:
                        clean_content = content.strip()
                        if clean_content.startswith('```json'):
                            clean_content = clean_content[7:]
                        if clean_content.startswith('```'):
                            clean_content = clean_content[3:]
                        if clean_content.endswith('```'):
                            clean_content = clean_content[:-3]
                        return json.loads(clean_content.strip())
                    except Exception as e:
                        print(f"[GEMINI PARSE ERROR] Failed to parse: {content}")
                        raise e
                return content
        except Exception as e:
            print(f"[ERROR] Gemini failed in Python microservice: {e}")
            raise e

async def call_groq(system_prompt: str, user_prompt: str, model="llama-3.1-8b-instant", json_mode: bool = True, max_tokens: int = 1500):
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": 0.1,
        "max_tokens": max_tokens
    }
    
    if json_mode:
        user_prompt = user_prompt + "\n\nOutput ONLY valid JSON."
        payload["messages"][1]["content"] = user_prompt
        payload["response_format"] = {"type": "json_object"}
        
    models_to_try = [model, "mixtral-8x7b-32768", "llama-3.1-8b-instant"]
    
    async with httpx.AsyncClient() as client:
        for m in models_to_try:
            payload["model"] = m
            try:
                response = await client.post("https://api.groq.com/openai/v1/chat/completions", json=payload, headers=headers, timeout=30.0)
                response.raise_for_status()
                data = response.json()
                content = data["choices"][0]["message"]["content"]
                return json.loads(content) if json_mode else content
            except Exception as e:
                print(f"[FAILOVER] Groq model {m} failed in Python microservice: {e}")
                
        print(f"[FAILOVER] All Groq models failed. Falling back to Gemini 2.5 Flash...")
        return await call_gemini(system_prompt, user_prompt, json_mode)

async def get_dynamic_context(focus_product: str, focus_region: str):
    system_prompt = "You are a supply chain routing engine. Output JSON only."
    prompt = f"""
Given a user focusing on '{focus_product}' in '{focus_region}', determine the 3 most critical upstream supply chain regions that impact this product, and 4 specific news search keywords to monitor for disruptions.
Return JSON: {{"routing_metadata": {{"regions": [{{"name": "...", "reason": "..."}}]}}, "dynamic_news_keywords": ["...", "..."]}}
"""
    # Use Llama-3.1-8b-instant for blazing fast intermediate routing
    return await call_groq(system_prompt, prompt, model="llama-3.1-8b-instant", json_mode=True)

def _normalize_terms(values):
    terms = []
    for value in values:
        if not value:
            continue
        for part in str(value).replace("/", ",").split(","):
            term = part.strip().lower()
            if term and term not in terms:
                terms.append(term)
    return terms

def _matches_any(text, terms):
    return [term for term in terms if term and term in text]

def _extract_values(text):
    patterns = [
        r"\$\s?\d+(?:\.\d+)?(?:\s?(?:billion|million|bn|mn|k))?",
        r"\b\d+(?:\.\d+)?\s?%",
        r"\b\d+(?:\.\d+)?\s?(?:days?|weeks?|months?|years?|tonnes?|tons?|barrels?|bpd|mt|kg|km|miles?)\b",
        r"\b(?:Q[1-4]|20\d{2}|19\d{2})\b"
    ]
    values = []
    for pattern in patterns:
        values.extend(re.findall(pattern, text, flags=re.IGNORECASE))
    return list(dict.fromkeys(v.strip() for v in values if v.strip()))[:5]

def _extract_supply_signals(text):
    signal_terms = [
        "shortage", "surplus", "delay", "disruption", "strike", "shutdown", "closure",
        "port", "freight", "shipping", "export", "import", "tariff", "sanction",
        "inventory", "stockpile", "production", "harvest", "yield", "weather",
        "drought", "flood", "heat", "demand", "price", "forecast", "capacity",
        "processing", "logistics", "supply chain", "procurement"
    ]
    return _matches_any(text, signal_terms)[:6]

def extract_top_news_intelligence(news, focus_product, user_commodities, focus_region, user_regions, limit=5):
    commodity_terms = _normalize_terms([focus_product] + user_commodities)
    region_terms = _normalize_terms([focus_region] + user_regions)
    extracted = []

    for article in news or []:
        title = str(article.get("title") or "").strip()
        description = str(article.get("description") or article.get("summary") or "").strip()
        source = str(article.get("source") or "Unknown").strip()
        published_at = str(article.get("publishedAt") or "").strip()
        full_text = f"{title}. {description}".lower()

        matched_commodities = _matches_any(full_text, commodity_terms)
        matched_regions = _matches_any(full_text, region_terms)
        supply_signals = _extract_supply_signals(full_text)
        values = _extract_values(f"{title}. {description}")

        has_commodity_or_region = bool(matched_commodities or matched_regions)
        if not has_commodity_or_region or not supply_signals:
            continue

        relevance_score = (len(matched_commodities) * 4) + (len(matched_regions) * 2) + len(supply_signals) + len(values)
        if relevance_score == 0:
            continue

        useful_snippet = description or title
        useful_snippet = re.sub(r"\s+", " ", useful_snippet).strip()[:280]
        extracted.append({
            "score": relevance_score,
            "source": source,
            "publishedAt": published_at,
            "title": title[:180],
            "usefulInfo": useful_snippet,
            "matchedCommodities": matched_commodities[:4],
            "matchedRegions": matched_regions[:4],
            "supplySignals": supply_signals,
            "values": values
        })

    extracted.sort(key=lambda item: item["score"], reverse=True)
    return extracted[:limit]

def format_news_intelligence(extracted_articles):
    if not extracted_articles:
        return "No locally extracted relevant news facts available."

    lines = []
    for idx, item in enumerate(extracted_articles, start=1):
        lines.append(
            f"{idx}. Source: {item['source']} | Title: {item['title']}\n"
            f"   Useful extracted info: {item['usefulInfo']}\n"
            f"   Matched commodities: {', '.join(item['matchedCommodities']) or 'none'} | "
            f"Matched regions: {', '.join(item['matchedRegions']) or 'none'}\n"
            f"   Supply signals: {', '.join(item['supplySignals']) or 'none'} | "
            f"Numbers/dates: {', '.join(item['values']) or 'none'}"
        )
    return "\n".join(lines)

async def generate_planner_recommendations(payload: dict):
    prices = payload.get("prices", {})
    news = payload.get("news", [])
    weather_extended = payload.get("weatherExtended", [])
    energy = payload.get("energy", {})
    forex = payload.get("forex", {})
    
    user_profile = payload.get("userProfile", {})
    focus_product = user_profile.get("focus_product", "Commodities")
    focus_region = user_profile.get("focus_region", "Global")
    user_commodities = user_profile.get("commodities", [])
    user_regions = payload.get("userRegions", [])
    
    feedback_context = payload.get("feedbackContext", "")
    logistics_data = payload.get("logisticsData", {})
    
    # 1. Get dynamic context FAST using Gemini
    dynamic_context = await get_dynamic_context(focus_product, focus_region)
    
    short_weather = " | ".join([f"{w.get('name')}: {w.get('analytics', {}).get('alert', w.get('alert', 'NORMAL'))}" for w in weather_extended])
    top_news_intelligence = extract_top_news_intelligence(news, focus_product, user_commodities, focus_region, user_regions)
    top_news_intelligence_block = format_news_intelligence(top_news_intelligence)
    
    if isinstance(prices, list):
        short_prices = ", ".join([f"{p.get('symbol', '')}: ${p.get('price', '')}" for p in prices])
    else:
        short_prices = str(prices)
        
    context_bundle = f"""
=== USER PROFILE ===
Focus Product: {focus_product}
Focus Region: {focus_region}
Tracked Commodities: {', '.join(user_commodities)}
Tracked Regions: {', '.join(user_regions)}

=== DYNAMIC CONCEPTUAL CONTEXT (ROUTED FOR {focus_product}) ===
Global Supply Regions Monitored: {', '.join([r.get('name', '') for r in dynamic_context.get('routing_metadata', {}).get('regions', [])])}
Dynamic Weather Data: {short_weather}
Targeted News Keywords: {', '.join(dynamic_context.get('dynamic_news_keywords', []))}

=== REAL-TIME DATA (SECONDARY) ===
Live Commodity Prices: {short_prices}
Port Congestion: {', '.join([f"{p.get('port')} ({p.get('status')})" for p in logistics_data.get('portCongestion', [])])}

=== MARKET INTELLIGENCE ===
Locally Extracted Useful Info From Top Relevant News:
{top_news_intelligence_block}
{feedback_context}
    """.strip()
    
    tracked_commodity_scope = ', '.join([focus_product] + user_commodities)

    analysis_prompt = f"""You are FOPs Market Pulse — an executive-grade supply chain intelligence engine.
Based on the provided data, generate 4 dynamic, natural-sounding, strategic alerts for the user's specific supply chain.

CRITICAL INSTRUCTIONS:
=== FILTERING RULES (MANDATORY) ===
- Treat the user-selected commodities as the only valid scope for analysis.
- Discard: News about any non-selected commodity.
- Never mention or recommend actions based on commodities that the user did not select.
===================================
1. The 4 alerts MUST form a cohesive, phased strategy. Recommendations must be derived from the locally extracted news facts, commodity prices, and weather conditions.
2. DO NOT use robotic phrasing. Speak naturally, like a human supply chain analyst giving a dynamic alert directly to an executive.
3. You MUST provide EXACTLY 2 alerts for the "90D" timeframe and EXACTLY 2 alerts for the "365D" timeframe.
4. The "90D" action must be a SHORT-TERM tactical/operational strategy.
5. The "365D" action must be a LONG-TERM STRATEGIC shift.
6. Focus ONLY on the user's specifically tracked commodities ({tracked_commodity_scope}).
7. Focus ONLY on the user's specifically tracked regions ({', '.join([focus_region] + user_regions)}).
8. You MUST explicitly reference the specific events from "Locally Extracted Useful Info From Top Relevant News" to justify your strategic actions. Do NOT invent news events.

Return a JSON object containing an array of exactly 4 objects under the key "recommendations". 
Each object must have these exact keys:
- "timeframe" (string: exactly "90D" or "365D")
- "action" (string: clear, natural-sounding actionable alert utilizing the specific live API data)
- "businessImpact" (string: the simple business reason or impact)
"""

    # 2. Generate final recommendations using Groq Llama 3.3 70B for high-quality reasoning
    return await call_groq(analysis_prompt, context_bundle, model="llama-3.1-8b-instant")
