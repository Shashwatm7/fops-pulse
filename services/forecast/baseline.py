import os
import datetime
import pandas as pd
import numpy as np
import lightgbm as lgb
import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

load_dotenv()
DB_URL = os.getenv("DATABASE_URL", "postgresql://localhost:5433/fops_pulse")

def get_db_connection():
    return psycopg2.connect(DB_URL)

def load_sales_data():
    print("Loading historical sales data...")
    conn = get_db_connection()
    query = """
        SELECT date, region, category, sku, units_sold, procurement_cost
        FROM sales_history
        ORDER BY date ASC
    """
    df = pd.read_sql(query, conn)
    conn.close()
    
    df['date'] = pd.to_datetime(df['date'])
    return df

def extract_features(df):
    df['day_of_week'] = df['date'].dt.dayofweek
    df['week_of_year'] = df['date'].dt.isocalendar().week.astype(int)
    df['month'] = df['date'].dt.month
    df['is_weekend'] = df['day_of_week'].isin([4, 5]).astype(int) # UAE weekend
    
    # Lag features
    df['lag_7'] = df.groupby(['region', 'category', 'sku'])['units_sold'].shift(7)
    df['lag_14'] = df.groupby(['region', 'category', 'sku'])['units_sold'].shift(14)
    df['rolling_7'] = df.groupby(['region', 'category', 'sku'])['units_sold'].transform(lambda x: x.shift(1).rolling(7).mean())
    df['rolling_30'] = df.groupby(['region', 'category', 'sku'])['units_sold'].transform(lambda x: x.shift(1).rolling(30).mean())
    
    # Drop NAs resulting from lags
    return df.dropna()

def train_and_predict(df, horizon_days):
    print(f"Generating baseline forecast for {horizon_days} days...")
    
    # We will train separate models per SKU for simplicity in Phase 1
    skus = df[['region', 'category', 'sku']].drop_duplicates()
    predictions = []
    
    for _, row in skus.iterrows():
        region, category, sku = row['region'], row['category'], row['sku']
        sku_df = df[(df['region'] == region) & (df['category'] == category) & (df['sku'] == sku)].copy()
        sku_df = extract_features(sku_df)
        
        if len(sku_df) < 60:
            print(f"Not enough data for {sku}. Skipping.")
            continue
            
        # Target is shifted to predict horizon_days into the future
        sku_df['target_units'] = sku_df['units_sold'].shift(-horizon_days)
        sku_df['target_cost'] = sku_df['procurement_cost'].shift(-horizon_days)
        
        train_df = sku_df.dropna()
        
        features = ['day_of_week', 'week_of_year', 'month', 'is_weekend', 'lag_7', 'lag_14', 'rolling_7', 'rolling_30']
        
        X = train_df[features]
        y_demand = train_df['target_units']
        y_cost = train_df['target_cost']
        
        # Train Demand Model
        model_demand = lgb.LGBMRegressor(n_estimators=100, learning_rate=0.05, random_state=42, verbose=-1)
        model_demand.fit(X, y_demand)
        
        # Train Cost Model
        model_cost = lgb.LGBMRegressor(n_estimators=100, learning_rate=0.05, random_state=42, verbose=-1)
        model_cost.fit(X, y_cost)
        
        # Predict for the latest known date + horizon
        latest_record = sku_df.iloc[[-1]][features]
        pred_demand = model_demand.predict(latest_record)[0]
        pred_cost = model_cost.predict(latest_record)[0]
        
        forecast_date = sku_df['date'].max() + datetime.timedelta(days=horizon_days)
        
        predictions.append((
            forecast_date.date().isoformat(),
            region,
            category,
            sku,
            horizon_days,
            round(float(pred_demand), 2),
            round(float(pred_cost), 2),
            "lgbm_baseline_v1"
        ))
        
    return predictions

def insert_forecasts(predictions):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    insert_query = """
    INSERT INTO baseline_forecasts (
        forecast_date, region, category, sku, horizon_days,
        baseline_demand, baseline_unit_cost, model_version
    ) VALUES %s
    """
    
    print(f"Inserting {len(predictions)} forecast records...")
    execute_values(cursor, insert_query, predictions)
    
    conn.commit()
    cursor.close()
    conn.close()

if __name__ == "__main__":
    df = load_sales_data()
    all_preds = []
    
    for horizon in [7, 30, 90]:
        preds = train_and_predict(df, horizon)
        all_preds.extend(preds)
        
    insert_forecasts(all_preds)
    print("Baseline forecasting complete.")
