import json
from market_drivers.pipeline import run_pipeline
from market_drivers.schema import PipelineInput

def test_run():
    mock_payload = {
        "config": {
            "user_id": "test_user_1",
            "domain": "frozen_food",
            "tracked_regions": ["Global", "North America", "Middle East"],
            "tracked_commodities": ["Chicken", "Beef"],
            "driver_templates": {
                "bird_flu_outbreak": "Avian influenza outbreak triggers mass culling of poultry, restricting supply.",
                "port_strike": "Port workers go on strike, halting container shipments and disrupting logistics.",
                "drought_stress": "Severe drought conditions negatively impact crop yields."
            },
            "weather_rules": [
                {
                    "condition": "hurricane",
                    "category": "weather",
                    "direction": "negative",
                    "magnitude": "high"
                }
            ],
            "thresholds": {
                "price_z_score": 1.5,
                "news_similarity": 0.1,
                "high_risk_negative_driver_count": 2
            }
        },
        "prices": [
            {"id": "p1", "commodity": "Chicken", "region": "North America", "price": 1.5, "date": "2026-07-01"},
            {"id": "p2", "commodity": "Chicken", "region": "North America", "price": 1.55, "date": "2026-07-02"},
            {"id": "p3", "commodity": "Chicken", "region": "North America", "price": 1.52, "date": "2026-07-03"},
            {"id": "p4", "commodity": "Chicken", "region": "North America", "price": 1.51, "date": "2026-07-04"},
            {"id": "p5", "commodity": "Chicken", "region": "North America", "price": 1.54, "date": "2026-07-05"},
            {"id": "p6", "commodity": "Chicken", "region": "North America", "price": 1.53, "date": "2026-07-06"},
            {"id": "p7", "commodity": "Chicken", "region": "North America", "price": 3.5, "date": "2026-07-07"} # Anomaly
        ],
        "weather": [
            {"id": "w1", "event_type": "Hurricane Beryl", "region": "North America", "affected_commodities": ["Chicken", "Beef"]}
        ],
        "news": [
            {"id": "n1", "region": "Middle East", "text": "A massive avian influenza outbreak in the region has caused massive culling of poultry flocks today."},
            {"id": "n2", "region": "Global", "text": "New smartphone models announced with AI chips."} # Should be data gap
        ]
    }

    pipeline_input = PipelineInput(**mock_payload)
    result = run_pipeline(pipeline_input)
    
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    test_run()
