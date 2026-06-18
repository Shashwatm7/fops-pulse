import os
import warnings
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.stattools import adfuller
from sklearn.ensemble import RandomForestRegressor, HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_percentage_error

warnings.filterwarnings("ignore")

# ── Config ────────────────────────────────────────────────────────────────────
DATA_PATH   = "V3_final_supply_chain_dataset 1 1.csv"
OUT_DIR     = "outputs"
SERVICE_LVL = 0.95          # 95% service level → Z = 1.645
Z           = 1.645
HORIZONS    = [7, 30, 90]   # forecast days

os.makedirs(OUT_DIR, exist_ok=True)
plt.rcParams.update({"figure.dpi": 130, "font.size": 10, "axes.spines.top": False,
                     "axes.spines.right": False, "axes.grid": True,
                     "grid.alpha": 0.25, "grid.linestyle": "--"})

print("=" * 60)
print("1. LOADING & CLEANING DATA")
print("=" * 60)

df = pd.read_csv(DATA_PATH)
df["date"] = pd.to_datetime(df["date"])
df = df.dropna(subset=["product_id"])          
df = df.sort_values(["product_id", "date"]).reset_index(drop=True)

df["year"]        = df["date"].dt.year
df["month"]       = df["date"].dt.month
df["dow"]         = df["date"].dt.dayofweek    
df["week"]        = df["date"].dt.isocalendar().week.astype(int)
df["is_weekend"]  = (df["dow"] >= 5).astype(int)
df["quarter"]     = df["date"].dt.quarter

if "sales_forecast" in df.columns and "actual_sales" in df.columns:
    df["forecast_error"] = df["sales_forecast"] - df["actual_sales"]
    df["abs_pct_err"] = np.where(
        df["actual_sales"] > 0,
        np.abs(df["forecast_error"]) / df["actual_sales"],
        np.nan
    )

skus = sorted(df["product_id"].dropna().unique())

print("\n" + "=" * 60)
print("3. PER-SKU ANALYSIS")
print("=" * 60)

sku_stats = []
for sku in skus:
    s = df[df["product_id"] == sku].sort_values("date").copy()
    avg_d  = s["demand"].mean()
    std_d  = s["demand"].std()
    avg_lt = s["actual_lead_time"].mean()
    std_lt = s["actual_lead_time"].std()
    cv     = std_d / avg_d

    safety_stock = Z * np.sqrt(avg_lt * std_d**2 + avg_d**2 * std_lt**2)
    rop          = avg_d * avg_lt + safety_stock

    l7  = s["demand"].tail(7).mean()
    l30 = s["demand"].tail(30).mean()
    l90 = s["demand"].tail(90).mean()

    adf_stat, adf_p, *_ = adfuller(s["demand"].dropna())

    row = {
        "SKU"              : sku,
        "Shelf life (d)"   : s["shelf_life_days"].iloc[0] if "shelf_life_days" in s.columns else 0,
        "Avg demand"       : round(avg_d, 1),
        "Std demand"       : round(std_d, 1),
        "CV"               : round(cv, 3),
        "Avg LT (d)"       : round(avg_lt, 3),
        "Std LT (d)"       : round(std_lt, 3),
        "Safety stock"     : round(safety_stock),
        "ROP"              : round(rop),
        "Stockout rate %"  : round(s["stockout_flag"].mean() * 100, 2) if "stockout_flag" in s.columns else 0,
    }
    sku_stats.append(row)

print("\n" + "=" * 60)
print("5. FORECASTING MODELS")
print("=" * 60)

TRAIN_CUTOFF = pd.Timestamp("2025-09-30")

forecast_results = []
model_metrics    = []

for sku in skus:
    s = df[df["product_id"] == sku].sort_values("date").copy()
    s_full = s.set_index("date")["demand"].asfreq("D").ffill()

    train = s_full[s_full.index <= TRAIN_CUTOFF]
    test  = s_full[s_full.index >  TRAIN_CUTOFF]

    if len(train) == 0 or len(test) == 0:
        continue

    def ewma_forecast(series, n_ahead, alpha=0.3):
        dow_factors = series.groupby(series.index.dayofweek).mean()
        dow_factors = dow_factors / dow_factors.mean()
        ewma = series.ewm(alpha=alpha, adjust=False).mean().iloc[-1]
        last_date = series.index[-1]
        preds = []
        for i in range(1, n_ahead + 1):
            d = (last_date + pd.Timedelta(days=i)).dayofweek
            preds.append(ewma * dow_factors.get(d, 1.0))
        return np.array(preds)

    ewma_test_pred = ewma_forecast(train, len(test))
    ewma_mape = mean_absolute_percentage_error(test.values, ewma_test_pred[:len(test)]) * 100

    try:
        hw_model = ExponentialSmoothing(
            train, trend="add", seasonal="add", seasonal_periods=7,
            initialization_method="estimated", damped_trend=True
        ).fit(optimized=True, use_brute=False)
        hw_test_pred = hw_model.forecast(len(test)).values
        hw_mape = mean_absolute_percentage_error(test.values, hw_test_pred) * 100
        hw_ok = True
    except Exception as e:
        hw_mape = 999; hw_ok = False

    def make_features(series, lag_days=28):
        df_feat = pd.DataFrame({"demand": series})
        df_feat["dow"]      = df_feat.index.dayofweek
        df_feat["month"]    = df_feat.index.month
        df_feat["week"]     = df_feat.index.isocalendar().week.astype(int)
        df_feat["is_we"]    = (df_feat["dow"] >= 5).astype(int)
        for lag in [1, 2, 3, 4, 5, 6, 7, 14, 21, 28]:
            df_feat[f"lag_{lag}"] = df_feat["demand"].shift(lag)
        for w in [3, 7, 14, 30]:
            df_feat[f"roll_mean_{w}"] = df_feat["demand"].shift(1).rolling(w).mean()
        for w in [7, 14, 30]:
            df_feat[f"roll_std_{w}"]  = df_feat["demand"].shift(1).rolling(w).std()
            df_feat[f"roll_min_{w}"]  = df_feat["demand"].shift(1).rolling(w).min()
            df_feat[f"roll_max_{w}"]  = df_feat["demand"].shift(1).rolling(w).max()
        df_feat["ewma_7"] = df_feat["demand"].shift(1).ewm(span=7, adjust=False).mean()
        df_feat["ewma_30"] = df_feat["demand"].shift(1).ewm(span=30, adjust=False).mean()
        return df_feat.dropna()

    full_feat = make_features(s_full)
    if len(full_feat) == 0:
        continue

    X = full_feat.drop("demand", axis=1)
    y = full_feat["demand"]

    train_mask = full_feat.index <= TRAIN_CUTOFF
    X_tr, y_tr = X[train_mask], y[train_mask]
    X_te, y_te = X[~train_mask], y[~train_mask]

    rf_mape = 999
    gb_mape = 999
    if len(X_tr) > 0 and len(X_te) > 0:
        rf = RandomForestRegressor(n_estimators=300, max_depth=12, min_samples_leaf=3, n_jobs=-1, random_state=42)
        rf.fit(X_tr, y_tr)
        rf_test_pred = rf.predict(X_te)
        rf_mape = mean_absolute_percentage_error(y_te.values, rf_test_pred) * 100

        gb = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_depth=8, random_state=42)
        gb.fit(X_tr, y_tr)
        gb_test_pred = gb.predict(X_te)
        gb_mape = mean_absolute_percentage_error(y_te.values, gb_test_pred) * 100

    mapes = {"EWMA": ewma_mape, "HoltWinters": hw_mape, "RandomForest": rf_mape, "GradientBoosting": gb_mape}
    best_model = min(mapes, key=mapes.get)

    model_metrics.append({
        "SKU": sku, "EWMA_MAPE": round(ewma_mape, 2),
        "HW_MAPE": round(hw_mape, 2), "RF_MAPE": round(rf_mape, 2),
        "GB_MAPE": round(gb_mape, 2), "Best": best_model
    })

    for horizon in HORIZONS:
        ewma_fc = ewma_forecast(s_full, horizon)

        if hw_ok:
            try:
                hw_full = ExponentialSmoothing(
                    s_full, trend="add", seasonal="add", seasonal_periods=7,
                    initialization_method="estimated", damped_trend=True
                ).fit(optimized=True, use_brute=False)
                hw_fc = hw_full.forecast(horizon).values
            except:
                hw_fc = ewma_fc.copy()
        else:
            hw_fc = ewma_fc.copy()

        rf_fc = []
        if rf_mape < 999:
            last_known = s_full.copy()
            for step in range(horizon):
                feat = make_features(last_known)
                if len(feat) == 0:
                    rf_fc.append(last_known.iloc[-1])
                    continue
                pred = rf.predict(feat.drop("demand", axis=1).iloc[[-1]])[0]
                pred = max(pred, 0)
                rf_fc.append(pred)
                new_date = last_known.index[-1] + pd.Timedelta(days=1)
                last_known = pd.concat([last_known, pd.Series([pred], index=[new_date])])
            rf_fc = np.array(rf_fc)
        else:
            rf_fc = ewma_fc.copy()

        gb_fc = []
        if gb_mape < 999:
            last_known = s_full.copy()
            for step in range(horizon):
                feat = make_features(last_known)
                if len(feat) == 0:
                    gb_fc.append(last_known.iloc[-1])
                    continue
                pred = gb.predict(feat.drop("demand", axis=1).iloc[[-1]])[0]
                pred = max(pred, 0)
                gb_fc.append(pred)
                new_date = last_known.index[-1] + pd.Timedelta(days=1)
                last_known = pd.concat([last_known, pd.Series([pred], index=[new_date])])
            gb_fc = np.array(gb_fc)
        else:
            gb_fc = ewma_fc.copy()

        best_fc = {"EWMA": ewma_fc, "HoltWinters": hw_fc, "RandomForest": rf_fc, "GradientBoosting": gb_fc}[best_model]

        sku_row = [r for r in sku_stats if r["SKU"] == sku][0]
        ss       = sku_row["Safety stock"]
        rop      = sku_row["ROP"]
        total_fc = best_fc.sum()

        p_name = df[df["product_id"] == sku]["product_name"].iloc[0] if "product_name" in df.columns else "Unknown Product"
        
        forecast_results.append({
            "SKU"            : sku,
            "ProductName"    : p_name,
            "Horizon"        : horizon,
            "BestModel"      : best_model,
            "ForecastTotal"  : round(total_fc),
            "ForecastAvg"    : round(best_fc.mean(), 1),
            "SafetyStock"    : ss,
            "ROP"            : rop,
            "RecOrderQty"    : round(total_fc + ss)
        })

fc_df = pd.DataFrame(forecast_results)
fc_df.to_csv(f"{OUT_DIR}/forecast_recommendations.csv", index=False)
print(f"  [saved] forecast_recommendations.csv")
