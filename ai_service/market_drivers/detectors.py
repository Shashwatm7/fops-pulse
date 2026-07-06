import pandas as pd
import numpy as np
import uuid
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
import datetime
from .schema import UserConfig

def detect_price_drivers(price_data: list, config: UserConfig) -> list:
    if not price_data:
        return []
    
    df = pd.DataFrame(price_data)
    if "commodity" not in df.columns or "price" not in df.columns or "region" not in df.columns:
        return []

    # Filter to tracked scope
    df = df[df["commodity"].isin(config.tracked_commodities) & df["region"].isin(config.tracked_regions)].copy()
    if df.empty:
        return []

    df['date'] = pd.to_datetime(df.get('date', pd.Timestamp.now()))
    df = df.sort_values(by="date")

    drivers = []
    threshold = config.thresholds.price_z_score

    # Calculate rolling z-score per commodity per region
    for (comm, reg), group in df.groupby(["commodity", "region"]):
        if len(group) < 3:
            continue
        
        mean = group["price"].mean()
        std = group["price"].std()
        if std == 0:
            continue
            
        last_row = group.iloc[-1]
        z_score = (last_row["price"] - mean) / std

        if abs(z_score) >= threshold:
            direction = "positive" if z_score > 0 else "negative"
            magnitude = "high" if abs(z_score) > threshold + 1 else "medium"
            conf = min(1.0, float(abs(z_score) / (threshold * 2)))

            drivers.append({
                "driver_id": str(uuid.uuid4()),
                "title": f"{comm} Price Spike" if direction == "positive" else f"{comm} Price Drop",
                "category": "price",
                "region": reg,
                "commodity_scope": [comm],
                "direction": direction,
                "magnitude": magnitude,
                "time_horizon": "transient",
                "confidence": round(conf, 2),
                "supporting_signals": [f"price_row_id:{last_row.get('id', 'latest')}"],
                "rationale": f"Z-score of {z_score:.2f} exceeds threshold {threshold}. Latest price: {last_row['price']}.",
                "user_id": config.user_id,
                "domain": config.domain
            })
    return drivers

def detect_weather_drivers(weather_events: list, config: UserConfig) -> list:
    if not weather_events or not config.weather_rules:
        return []

    drivers = []
    for evt in weather_events:
        evt_type = evt.get("event_type", "").lower()
        region = evt.get("region", "Global")
        if region not in config.tracked_regions:
            continue

        affected_commodities = evt.get("affected_commodities", [])
        matched_comms = [c for c in affected_commodities if c in config.tracked_commodities]
        if not matched_comms:
            continue

        for rule in config.weather_rules:
            if rule.condition.lower() in evt_type or evt_type in rule.condition.lower():
                drivers.append({
                    "driver_id": str(uuid.uuid4()),
                    "title": f"{rule.condition.title()} Warning",
                    "category": rule.category,
                    "region": region,
                    "commodity_scope": matched_comms,
                    "direction": rule.direction,
                    "magnitude": rule.magnitude,
                    "time_horizon": "transient", # Defaulting to transient for weather
                    "confidence": 0.85, # Rule match confidence
                    "supporting_signals": [f"weather_event_id:{evt.get('id', 'unknown')}"],
                    "rationale": f"Matched weather rule '{rule.condition}' for event '{evt_type}'.",
                    "user_id": config.user_id,
                    "domain": config.domain
                })
                break
    return drivers

def score_news_alert(news_row: dict, match_result: dict, user_config: UserConfig) -> dict:
    reasons = []
    
    # 1. Template similarity strength (weight 0.35)
    similarity_score = match_result.get("similarity_score", 0.0)
    score1 = similarity_score * 0.35
    reasons.append(f"Template similarity ({similarity_score:.2f}) * 0.35 = {score1:.3f}")
    
    # 2. Category severity weight (weight 0.25)
    category = match_result.get("category", "supply")
    cat_weight = user_config.alert_config.category_weights.get(category, 0.5)
    score2 = cat_weight * 0.25
    reasons.append(f"Category weight ({category}: {cat_weight}) * 0.25 = {score2:.3f}")
    
    # 3. Keyword severity match (weight up to 0.25)
    text = (news_row.get("text", "")).lower()
    high_terms = ["ban", "closure", "blockade", "shortage", "suspended", "crisis"]
    med_terms = ["delay", "concern", "disruption", "tension"]
    
    kw_score_val = 0.0
    if any(t in text for t in high_terms):
        kw_score_val = 1.0
        reasons.append("Keyword severity (high) = 0.250")
    elif any(t in text for t in med_terms):
        kw_score_val = 0.5
        reasons.append("Keyword severity (medium) = 0.125")
    else:
        reasons.append("Keyword severity (none) = 0.000")
    score3 = kw_score_val * 0.25
    
    # 4. Recency decay (weight 0.10)
    news_date_raw = news_row.get("date")
    news_date = None
    if news_date_raw:
        try:
            news_date = pd.to_datetime(news_date_raw, utc=True).to_pydatetime()
        except Exception:
            pass
    if not news_date:
        news_date = datetime.datetime.now(datetime.timezone.utc)
    
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    days_old = (now_utc - news_date).days
    decay_factor = max(0.0, 1.0 - (max(0, days_old) / 7.0))
    score4 = decay_factor * 0.10
    reasons.append(f"Recency decay ({max(0, days_old)} days old, factor {decay_factor:.2f}) * 0.10 = {score4:.3f}")
    
    # 5. Critical commodity hit (weight 0.05)
    commodity_scope = match_result.get("commodity_scope", [])
    critical_comms = user_config.alert_config.critical_commodities
    hit = any(c in critical_comms for c in commodity_scope)
    score5 = 0.05 if hit else 0.0
    reasons.append(f"Critical commodity hit ({hit}) * 0.05 = {score5:.3f}")
    
    total_score = score1 + score2 + score3 + score4 + score5
    
    thresholds = user_config.alert_config.alert_thresholds
    if total_score >= thresholds.high:
        alert_level = "high_alert"
    elif total_score >= thresholds.medium:
        alert_level = "medium_alert"
    else:
        alert_level = "low_alert"
        
    return {
        "news_id": news_row.get("id", "unknown"),
        "alert_level": alert_level,
        "alert_score": round(total_score, 3),
        "reasons": reasons
    }

def detect_news_drivers(news_data: list, config: UserConfig) -> tuple[list, list]:
    if not news_data or not config.driver_templates:
        return [], []
        
    drivers = []
    data_gaps = []
    threshold = config.thresholds.news_similarity
    
    # Filter by region
    valid_news = [n for n in news_data if n.get("region") in config.tracked_regions]
    if not valid_news:
        return [], []

    texts = [n.get("text", "") for n in valid_news]
    templates = list(config.driver_templates.items())
    template_texts = [v for k, v in templates]

    vectorizer = TfidfVectorizer(stop_words='english')
    try:
        all_texts = texts + template_texts
        tfidf_matrix = vectorizer.fit_transform(all_texts)
        
        doc_vectors = tfidf_matrix[:len(texts)]
        template_vectors = tfidf_matrix[len(texts):]
        
        sim_matrix = cosine_similarity(doc_vectors, template_vectors)
    except ValueError:
        return [], []

    for i, news_item in enumerate(valid_news):
        best_sim = 0
        best_idx = -1
        for j in range(len(templates)):
            if sim_matrix[i, j] > best_sim:
                best_sim = sim_matrix[i, j]
                best_idx = j
                
        if best_sim >= threshold:
            key, val = templates[best_idx]
            
            # Build match result for alert scoring
            match_result = {
                "driver_key": key,
                "similarity_score": float(best_sim),
                "category": "supply", # Fallback category, can be refined based on template metadata
                "commodity_scope": config.tracked_commodities, # Broad application for now
            }
            
            alert_dict = score_news_alert(news_item, match_result, config)
            
            # Simple assumption: generic news driver mapping
            drivers.append({
                "driver_id": str(uuid.uuid4()),
                "title": f"Thematic Shift: {key.replace('_', ' ').title()}",
                "category": "supply", # Fallback category, can be refined based on template metadata
                "region": news_item.get("region"),
                "commodity_scope": config.tracked_commodities, # Broad application for now
                "direction": "neutral", 
                "magnitude": "medium",
                "time_horizon": "structural",
                "confidence": round(float(best_sim), 2),
                "supporting_signals": [f"news_id:{news_item.get('id', 'unknown')}"],
                "rationale": f"Cosine similarity of {best_sim:.2f} matched template '{key}' ('{val}').",
                "user_id": config.user_id,
                "domain": config.domain,
                "alert_level": alert_dict["alert_level"],
                "alert_score": alert_dict["alert_score"],
                "alert_reasons": alert_dict["reasons"]
            })
        else:
            data_gaps.append(news_item)
            
    return drivers, data_gaps
