import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function generateRecommendations() {
    console.log('[REC-ENGINE] Starting Recommendation Engine...');
    
    try {
        // 1. Fetch latest forecast outputs
        const forecastRes = await pool.query(`
            SELECT * FROM forecast_outputs
            WHERE forecast_date >= CURRENT_DATE
        `);
        
        // 2. Fetch active signals to link as drivers
        const signalRes = await pool.query(`
            SELECT * FROM market_signals
            WHERE created_at >= NOW() - INTERVAL '7 days'
        `);
        const activeSignals = signalRes.rows;
        
        let totalRecs = 0;
        
        for (const row of forecastRes.rows) {
            const cat = row.category;
            const demandScore = parseFloat(row.demand_score);
            const costScore = parseFloat(row.cost_score);
            const supplyScore = parseFloat(row.supply_score);
            
            let scenarioType = "Stable";
            let priority = "Low";
            const actions = [];
            
            // Find relevant drivers
            const drivers = activeSignals
                .filter(s => s.category === cat || s.region === 'Global' || s.region === row.region)
                .map(s => `${s.signal_type} (Severity: ${s.severity})`);
                
            // Business Logic Rules
            if (demandScore > 0.05 && costScore > 0.03) {
                scenarioType = "Demand Up + Cost Pressure";
                priority = "High";
                actions.push(`Increase ${row.sku} procurement by ${Math.round(demandScore * 100)}% to cover predicted demand surge.`);
                actions.push(`Lock in short-term supplier volume immediately to offset +${Math.round(costScore * 100)}% forecasted cost inflation.`);
            } 
            else if (supplyScore > 0.15) {
                scenarioType = "Supply Disruption Risk";
                priority = "High";
                actions.push(`Monitor ${row.sku} supply chain exposure due to elevated risk signals.`);
                actions.push(`Consider sourcing from alternative regions to mitigate disruption risk.`);
            }
            else if (demandScore > 0.05) {
                scenarioType = "Demand Surge";
                priority = "Medium";
                actions.push(`Increase ${row.sku} buffer stock by ${Math.round(demandScore * 100)}%.`);
            }
            else if (costScore > 0.03) {
                scenarioType = "Cost Inflation Risk";
                priority = "Medium";
                actions.push(`Evaluate short-term hedging for ${row.sku} input costs.`);
            }
            else if (demandScore < -0.05) {
                scenarioType = "Demand Drop Risk";
                priority = "Medium";
                actions.push(`Reduce ${row.sku} intake by ${Math.abs(Math.round(demandScore * 100))}% to prevent overstocking.`);
            }
            
            if (scenarioType !== "Stable") {
                const recId = crypto.randomUUID();
                
                const insertQuery = `
                    INSERT INTO recommendations (
                        rec_id, category, sku, region, horizon_days, scenario_type, 
                        priority, predicted_demand_impact_pct, predicted_cost_impact_pct, 
                        confidence, actions_json, drivers_json
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `;
                
                const values = [
                    recId,
                    cat,
                    row.sku,
                    row.region,
                    row.horizon_days,
                    scenarioType,
                    priority,
                    Math.round(demandScore * 100 * 10) / 10, // 1 decimal place
                    Math.round(costScore * 100 * 10) / 10,
                    0.85, // Rule engine confidence
                    JSON.stringify(actions),
                    JSON.stringify(drivers.slice(0, 5)) // Top 5 drivers
                ];
                
                const res = await pool.query(insertQuery, values);
                if (res.rowCount > 0) totalRecs++;
            }
        }
        
        console.log(`[REC-ENGINE] Recommendation Engine complete. Generated ${totalRecs} actions.`);
        return totalRecs;
        
    } catch (error) {
        console.error('[REC-ENGINE] Error generating recommendations:', error);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    generateRecommendations().then(() => pool.end());
}
