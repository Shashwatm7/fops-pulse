import os
import datetime
import json
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

load_dotenv()
DB_URL = os.getenv("DATABASE_URL", "postgresql://localhost:5433/fops_pulse")

def get_db_connection():
    return psycopg2.connect(DB_URL)

def generate_weather_signals():
    print("[SIGNALS] Starting Canonical Weather Anomaly Extraction...")
    conn = get_db_connection()
    
    # Fetch recent weather data
    query = """
        SELECT date, region, max_temp, rain, humidity
        FROM raw_weather
        ORDER BY date DESC
        LIMIT 30
    """
    df = pd.read_sql(query, conn)
    
    if df.empty:
        print("[SIGNALS] No weather data found.")
        conn.close()
        return

    signals = []
    
    for _, row in df.iterrows():
        date = row['date']
        region = row['region']
        max_temp = row['max_temp']
        rain = row['rain']
        
        # Simple rule-based anomaly detection for MVP
        
        # Rule 1: Heatwave in UAE -> Increases Dairy (Milk) Demand & Stress
        if max_temp and max_temp > 40.0:
            signal_id = f"weather_{date}_{region}_heatwave"
            evidence = {"max_temp": float(max_temp), "threshold": 40.0}
            
            signals.append((
                signal_id,
                date.isoformat(),
                'weather',
                'Dairy',
                None, # SKU agnostic
                region,
                'heatwave_demand_uplift',
                'demand',
                'positive', # Demand increases
                0.7, # Severity
                0.9, # Confidence
                7,   # Horizon days
                json.dumps(evidence)
            ))
            
        # Rule 2: Heavy Rain -> Logistics Disruption
        if rain and rain > 10.0:
            signal_id = f"weather_{date}_{region}_rain"
            evidence = {"rain_mm": float(rain), "threshold": 10.0}
            
            # Affects both Dairy and Poultry logistics
            for category in ['Dairy', 'Poultry']:
                signals.append((
                    f"{signal_id}_{category}",
                    date.isoformat(),
                    'weather',
                    category,
                    None,
                    region,
                    'logistics_disruption',
                    'supply',
                    'negative',
                    0.5,
                    0.8,
                    7,
                    json.dumps(evidence)
                ))

    if not signals:
        print("[SIGNALS] No weather anomalies detected.")
        conn.close()
        return
        
    cursor = conn.cursor()
    insert_query = """
        INSERT INTO market_signals (
            signal_id, date, source_type, category, sku, region, 
            signal_type, impact_side, impact_direction, severity, 
            confidence, horizon_days, evidence_json
        ) VALUES %s
        ON CONFLICT (signal_id) DO NOTHING
    """
    
    execute_values(cursor, insert_query, signals)
    conn.commit()
    
    print(f"[SIGNALS] Weather Anomaly Extraction complete. Generated {len(signals)} canonical signals.")
    
    cursor.close()
    conn.close()

if __name__ == "__main__":
    generate_weather_signals()
