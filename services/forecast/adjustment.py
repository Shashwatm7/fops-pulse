import os
import json
import psycopg2
import pandas as pd
from psycopg2.extras import execute_values
from dotenv import load_dotenv

load_dotenv()
DB_URL = os.getenv("DATABASE_URL", "postgresql://localhost:5433/fops_pulse")

# Load weights config
CONFIG_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'config', 'category_weights.json')
with open(CONFIG_PATH, 'r') as f:
    WEIGHTS = json.load(f)

def get_db_connection():
    return psycopg2.connect(DB_URL)

def calculate_adjusted_forecasts():
    print("[FORECAST] Starting Event-Aware Forecast Adjustment...")
    conn = get_db_connection()
    
    # 1. Fetch latest baseline forecasts
    baseline_query = """
        SELECT region, category, sku, forecast_date, horizon_days, baseline_demand, baseline_unit_cost
        FROM baseline_forecasts
        WHERE forecast_date >= CURRENT_DATE
    """
    baseline_df = pd.read_sql(baseline_query, conn)
    
    if baseline_df.empty:
        print("[FORECAST] No future baseline forecasts found.")
        conn.close()
        return

    # 2. Fetch active canonical signals (for simplicity, we assume signals from the last 7 days are active)
    signals_query = """
        SELECT category, region, signal_type, impact_side, impact_direction, severity
        FROM market_signals
        WHERE created_at >= NOW() - INTERVAL '7 days'
    """
    signals_df = pd.read_sql(signals_query, conn)

    outputs = []
    
    for _, row in baseline_df.iterrows():
        cat = row['category']
        region = row['region']
        
        # Initialize scores
        demand_score = 0.0
        cost_score = 0.0
        supply_score = 0.0
        
        cat_weights = WEIGHTS.get(cat, {})
        d_weights = cat_weights.get("demand_weights", {})
        c_weights = cat_weights.get("cost_weights", {})
        s_weights = cat_weights.get("supply_weights", {})
        
        # Filter signals for this category and region
        active_sigs = signals_df[(signals_df['category'] == cat) & ((signals_df['region'] == region) | (signals_df['region'] == 'Global'))]
        
        for _, sig in active_sigs.iterrows():
            sig_type = sig['signal_type']
            severity = float(sig['severity'])
            direction_mult = 1 if sig['impact_direction'] == 'positive' else -1
            
            if sig['impact_side'] == 'demand':
                w = d_weights.get(sig_type, 0.0)
                demand_score += (severity * w * direction_mult)
            elif sig['impact_side'] == 'cost':
                w = c_weights.get(sig_type, 0.0)
                cost_score += (severity * w * direction_mult)
            elif sig['impact_side'] == 'supply':
                # For supply, positive direction means supply increases. We track supply risk, so negative direction = higher risk score
                w = s_weights.get(sig_type, 0.0)
                supply_score += (severity * w * (-direction_mult))
        
        # Bound scores to prevent absurd adjustments (-50% to +50% max)
        demand_score = max(-0.5, min(0.5, demand_score))
        cost_score = max(-0.5, min(0.5, cost_score))
        supply_score = max(0.0, min(1.0, supply_score)) # Risk is 0 to 1
        
        base_demand = float(row['baseline_demand'])
        base_cost = float(row['baseline_unit_cost']) if pd.notna(row['baseline_unit_cost']) else 0.0
        
        adj_demand = base_demand * (1.0 + demand_score)
        adj_cost = base_cost * (1.0 + cost_score)
        
        outputs.append((
            row['forecast_date'].isoformat(),
            cat,
            row['sku'],
            region,
            int(row['horizon_days']),
            round(base_demand, 2),
            round(adj_demand, 2),
            round(base_cost, 2),
            round(adj_cost, 2),
            round(demand_score, 4),
            round(cost_score, 4),
            round(supply_score, 4)
        ))
        
    # Insert adjusted forecasts
    cursor = conn.cursor()
    cursor.execute("TRUNCATE TABLE forecast_outputs;") # Clear old outputs for MVP
    
    insert_query = """
        INSERT INTO forecast_outputs (
            forecast_date, category, sku, region, horizon_days,
            baseline_demand, adjusted_demand, baseline_cost, adjusted_cost,
            demand_score, cost_score, supply_score
        ) VALUES %s
    """
    
    execute_values(cursor, insert_query, outputs)
    conn.commit()
    
    print(f"[FORECAST] Forecast Adjustment complete. Generated {len(outputs)} adjusted forecast records.")
    
    cursor.close()
    conn.close()

if __name__ == "__main__":
    calculate_adjusted_forecasts()
