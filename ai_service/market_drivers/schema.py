from pydantic import BaseModel, Field
from typing import List, Dict, Optional, Literal

class Thresholds(BaseModel):
    price_z_score: float = 2.0
    news_similarity: float = 0.15
    high_risk_negative_driver_count: int = 3

class WeatherRule(BaseModel):
    condition: str
    category: str
    direction: Literal["positive", "negative", "neutral"]
    magnitude: Literal["low", "medium", "high"]

class AlertThresholds(BaseModel):
    high: float = 0.65
    medium: float = 0.35

class AlertConfig(BaseModel):
    category_weights: Dict[str, float] = Field(default_factory=lambda: {"geopolitical": 1.0, "regulatory": 1.0, "price": 0.5, "supply": 0.8, "demand": 0.8})
    critical_commodities: List[str] = Field(default_factory=list)
    alert_thresholds: AlertThresholds = Field(default_factory=AlertThresholds)

class UserConfig(BaseModel):
    user_id: str
    domain: str
    tracked_regions: List[str]
    tracked_commodities: List[str]
    driver_templates: Dict[str, str]
    weather_rules: List[WeatherRule]
    thresholds: Thresholds = Field(default_factory=Thresholds)
    alert_config: AlertConfig = Field(default_factory=AlertConfig)

class MarketDriver(BaseModel):
    driver_id: str
    title: str
    category: Literal["supply", "demand", "price", "logistics", "regulatory", "weather", "geopolitical"]
    region: str
    commodity_scope: List[str]
    direction: Literal["positive", "negative", "neutral"]
    magnitude: Literal["low", "medium", "high"]
    time_horizon: Literal["transient", "seasonal", "structural"]
    confidence: float = Field(ge=0.0, le=1.0)
    supporting_signals: List[str]
    rationale: str
    user_id: str
    domain: str
    alert_level: Optional[Literal["high_alert", "medium_alert", "low_alert"]] = None
    alert_score: Optional[float] = None
    alert_reasons: Optional[List[str]] = None

class PipelineInput(BaseModel):
    prices: List[dict]
    weather: List[dict]
    news: List[dict]
    config: UserConfig
