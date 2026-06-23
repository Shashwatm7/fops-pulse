import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// UAE coordinates (MVP Region)
const REGION = "UAE";
const LAT = 23.4241;
const LON = 53.8478;

export async function ingestWeather() {
    console.log('[INGESTION] Starting Open-Meteo weather fetch...');
    
    try {
        // Fetch current and past 3 days of historical weather + 7 day forecast
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=temperature_2m_max,temperature_2m_min,rain_sum,relative_humidity_2m_max&past_days=3&timezone=auto`;
        
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Open-Meteo API Error: ${response.statusText}`);
        
        const data = await response.json();
        
        if (!data.daily) throw new Error("No daily weather data returned");
        
        let totalInserted = 0;
        
        for (let i = 0; i < data.daily.time.length; i++) {
            const date = data.daily.time[i];
            const maxTemp = data.daily.temperature_2m_max[i];
            const minTemp = data.daily.temperature_2m_min[i];
            const rain = data.daily.rain_sum[i];
            const humidity = data.daily.relative_humidity_2m_max[i] || null; // Could be missing in some regions
            
            // Raw JSON for this specific day
            const rawJson = JSON.stringify({
                time: date,
                temperature_2m_max: maxTemp,
                temperature_2m_min: minTemp,
                rain_sum: rain,
                relative_humidity_2m_max: humidity
            });
            
            const insertQuery = `
                INSERT INTO raw_weather (date, region, max_temp, min_temp, rain, humidity, raw_json)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (date, region) DO UPDATE SET
                    max_temp = EXCLUDED.max_temp,
                    min_temp = EXCLUDED.min_temp,
                    rain = EXCLUDED.rain,
                    humidity = EXCLUDED.humidity,
                    raw_json = EXCLUDED.raw_json,
                    created_at = NOW()
            `;
            
            const values = [date, REGION, maxTemp, minTemp, rain, humidity, rawJson];
            const res = await pool.query(insertQuery, values);
            if (res.rowCount > 0) totalInserted++;
        }
        
        console.log(`[INGESTION] Weather fetch complete. Inserted/Updated ${totalInserted} records.`);
        return totalInserted;
        
    } catch (error) {
        console.error('[INGESTION] Error fetching weather:', error.message);
        return 0;
    }
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
    ingestWeather().then(() => pool.end());
}
