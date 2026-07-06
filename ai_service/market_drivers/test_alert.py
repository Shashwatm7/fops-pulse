import datetime
from ai_service.market_drivers.schema import UserConfig, AlertConfig
from ai_service.market_drivers.detectors import score_news_alert

def test_score_news_alert():
    # 1. Setup mock config
    alert_config = AlertConfig(
        category_weights={"geopolitical": 1.0, "supply": 0.8},
        critical_commodities=["wheat", "corn"]
    )
    user_config = UserConfig(
        user_id="user_1",
        domain="food",
        tracked_regions=["Global"],
        tracked_commodities=["wheat", "corn", "soy"],
        driver_templates={"export_ban": "Country bans exports"},
        weather_rules=[],
        alert_config=alert_config
    )
    
    # 2. Setup mock inputs
    now = datetime.datetime.now(datetime.timezone.utc)
    
    # High Alert Mock
    news_high = {
        "id": "news_001",
        "text": "Major export ban leads to severe wheat shortage globally.",
        "date": now.isoformat()
    }
    match_high = {
        "similarity_score": 0.9,
        "category": "geopolitical",
        "commodity_scope": ["wheat"]
    }
    
    # Medium Alert Mock
    news_med = {
        "id": "news_002",
        "text": "There is a slight delay in soy shipments.",
        "date": (now - datetime.timedelta(days=3)).isoformat()
    }
    match_med = {
        "similarity_score": 0.5,
        "category": "supply",
        "commodity_scope": ["soy"]
    }
    
    # Low Alert Mock
    news_low = {
        "id": "news_003",
        "text": "Market update: prices remain stable.",
        "date": (now - datetime.timedelta(days=10)).isoformat() # Fully decayed
    }
    match_low = {
        "similarity_score": 0.2,
        "category": "demand", # Unconfigured category defaults to 0.5
        "commodity_scope": ["rice"]
    }
    
    # 3. Execute
    res_high = score_news_alert(news_high, match_high, user_config)
    res_med = score_news_alert(news_med, match_med, user_config)
    res_low = score_news_alert(news_low, match_low, user_config)
    
    print("--- HIGH ALERT MOCK ---")
    print(res_high)
    print("\n--- MEDIUM ALERT MOCK ---")
    print(res_med)
    print("\n--- LOW ALERT MOCK ---")
    print(res_low)
    
    # Assertions
    assert res_high["alert_level"] == "high_alert", f"Expected high, got {res_high['alert_level']}"
    assert res_med["alert_level"] == "medium_alert", f"Expected medium, got {res_med['alert_level']}"
    assert res_low["alert_level"] == "low_alert", f"Expected low, got {res_low['alert_level']}"
    print("\nAll tests passed successfully.")

if __name__ == "__main__":
    test_score_news_alert()
