import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function ingestMarketData() {
    console.log('[INGESTION] Starting Market Data fetch (FAO/WB proxies)...');
    let totalInserted = 0;
    
    try {
        // Example: World Bank Global Oil/Energy Price proxy (CMEMSOIL)
        // For a real production app, you'd iterate through many indicators
        const url = `https://api.worldbank.org/v2/country/WLD/indicator/CRUDE_BRENT?format=json&per_page=10`;
        const response = await fetch(url);
        
        if (response.ok) {
            const data = await response.json();
            if (data && data.length > 1 && data[1]) {
                const records = data[1];
                
                for (const record of records) {
                    if (record.value === null) continue;
                    
                    // Convert World Bank Year+Month format to a specific date (first of the month)
                    // Note: WB sometimes returns just Year (e.g., "2024") or YearMonth (e.g., "2024M05")
                    let recordDate;
                    if (record.date.includes("M")) {
                        const [year, month] = record.date.split("M");
                        recordDate = new Date(`${year}-${month}-01`);
                    } else {
                        recordDate = new Date(`${record.date}-01-01`);
                    }
                    
                    const insertQuery = `
                        INSERT INTO raw_market_data (date, source, metric_name, category, region, value, raw_json)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        ON CONFLICT (date, source, metric_name, category, region) DO UPDATE SET
                            value = EXCLUDED.value,
                            raw_json = EXCLUDED.raw_json,
                            created_at = NOW()
                    `;
                    
                    const values = [
                        recordDate.toISOString(),
                        'World Bank',
                        'Brent Crude Oil Price',
                        'Energy/Logistics',
                        'Global',
                        record.value,
                        JSON.stringify(record)
                    ];
                    
                    const res = await pool.query(insertQuery, values);
                    if (res.rowCount > 0) totalInserted++;
                }
            }
        }
    } catch (error) {
        console.error('[INGESTION] Error fetching WB market data:', error.message);
    }
    
    console.log(`[INGESTION] Market Data fetch complete. Inserted/Updated ${totalInserted} records.`);
    return totalInserted;
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
    ingestMarketData().then(() => pool.end());
}
