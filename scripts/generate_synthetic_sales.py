import datetime
import random
import psycopg2
from psycopg2.extras import execute_values
import os
from dotenv import load_dotenv

load_dotenv()

# Configuration
DB_URL = os.getenv("DATABASE_URL", "postgresql://localhost:5433/fops_pulse")
REGION = "UAE"
DAYS_OF_HISTORY = 730  # 2 years
END_DATE = datetime.date.today()
START_DATE = END_DATE - datetime.timedelta(days=DAYS_OF_HISTORY)

SKU_CONFIGS = [
    {
        "category": "Dairy",
        "sku": "Milk",
        "base_price": 1.50,
        "base_cost": 1.05,
        "base_volume": 12000,
        "vol_volatility": 0.05,
        "weekend_boost": 1.15,
        "seasonal_month_peak": [6, 7, 8], # Summer peak
    },
    {
        "category": "Dairy",
        "sku": "Yogurt",
        "base_price": 2.20,
        "base_cost": 1.45,
        "base_volume": 8500,
        "vol_volatility": 0.08,
        "weekend_boost": 1.25,
        "seasonal_month_peak": [6, 7, 8],
    },
    {
        "category": "Poultry",
        "sku": "Chicken Breast",
        "base_price": 5.50,
        "base_cost": 3.80,
        "base_volume": 15000,
        "vol_volatility": 0.10,
        "weekend_boost": 1.40,
        "seasonal_month_peak": [11, 12, 1], # Winter/Holiday peak
    }
]

def generate_data():
    records = []
    
    for sku in SKU_CONFIGS:
        for i in range(DAYS_OF_HISTORY + 1):
            current_date = START_DATE + datetime.timedelta(days=i)
            
            # Base variations
            vol = sku["base_volume"] * random.uniform(1 - sku["vol_volatility"], 1 + sku["vol_volatility"])
            price = sku["base_price"] * random.uniform(0.98, 1.02)
            cost = sku["base_cost"] * random.uniform(0.95, 1.05)
            
            # Weekend effect (Friday/Saturday in UAE)
            if current_date.weekday() in [4, 5]:
                vol *= sku["weekend_boost"]
                
            # Seasonality
            if current_date.month in sku["seasonal_month_peak"]:
                vol *= 1.20
                cost *= 1.05 # Costs often rise in peak demand
                
            # Random promo flag
            promo_flag = random.random() < 0.05
            if promo_flag:
                vol *= 1.50
                price *= 0.85
                
            # Random stockout flag
            stockout_flag = False
            if random.random() < 0.02:
                stockout_flag = True
                vol *= 0.30 # Only part of the day was stocked out
                
            units_sold = int(vol)
            revenue = round(units_sold * price, 2)
            unit_price = round(price, 2)
            procurement_cost = round(cost, 2)
            transport_cost = round(cost * 0.15, 2)
            margin = round(unit_price - procurement_cost - transport_cost, 2)
            
            records.append((
                current_date.isoformat(),
                REGION,
                sku["category"],
                sku["sku"],
                units_sold,
                revenue,
                unit_price,
                procurement_cost,
                transport_cost,
                margin,
                promo_flag,
                stockout_flag
            ))
            
    return records

def insert_data(records):
    print(f"Connecting to {DB_URL}")
    conn = psycopg2.connect(DB_URL)
    cursor = conn.cursor()
    
    print("Clearing existing sales_history...")
    cursor.execute("TRUNCATE TABLE sales_history;")
    
    insert_query = """
    INSERT INTO sales_history (
        date, region, category, sku, units_sold, revenue, unit_price,
        procurement_cost, transport_cost, margin, promo_flag, stockout_flag
    ) VALUES %s
    """
    
    print(f"Inserting {len(records)} records...")
    execute_values(cursor, insert_query, records)
    
    conn.commit()
    cursor.close()
    conn.close()
    print("Successfully inserted synthetic sales data.")

if __name__ == "__main__":
    data = generate_data()
    insert_data(data)
