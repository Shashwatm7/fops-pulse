from .schema import PipelineInput, MarketDriver
from .detectors import detect_price_drivers, detect_weather_drivers, detect_news_drivers

def run_pipeline(input_data: PipelineInput) -> dict:
    config = input_data.config
    
    price_drivers = detect_price_drivers(input_data.prices, config)
    weather_drivers = detect_weather_drivers(input_data.weather, config)
    news_drivers, data_gaps = detect_news_drivers(input_data.news, config)
    
    all_drivers = price_drivers + weather_drivers + news_drivers
    
    # Dedup by (category, region, commodity_scope overlap)
    # Keep highest confidence
    dedup_map = {}
    for drv in all_drivers:
        # Create a deterministic key for deduplication based on overlap
        # Since commodity_scope is a list, sort it for a stable tuple key
        comm_key = tuple(sorted(drv["commodity_scope"]))
        key = (drv["category"], drv["region"], comm_key)
        
        if key not in dedup_map or drv["confidence"] > dedup_map[key]["confidence"]:
            dedup_map[key] = drv

    final_drivers = list(dedup_map.values())
    
    # Rank by confidence descending
    final_drivers.sort(key=lambda x: x["confidence"], reverse=True)
    
    # Flag high risk regions
    high_risk_regions = []
    region_negative_counts = {}
    for drv in final_drivers:
        if drv["direction"] == "negative":
            region_negative_counts[drv["region"]] = region_negative_counts.get(drv["region"], 0) + 1
            
    for reg, count in region_negative_counts.items():
        if count >= config.thresholds.high_risk_negative_driver_count:
            high_risk_regions.append(reg)

    return {
        "drivers": final_drivers,
        "high_risk_regions": high_risk_regions,
        "data_gaps": data_gaps
    }
