import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { ALL_REGIONS } from '../../onboarding-templates.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Fetch one region's daily weather (past 3 days + 7-day forecast) from
// Open-Meteo and upsert into raw_weather keyed on (date, region).
async function ingestRegion(region) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${region.lat}&longitude=${region.lon}&daily=temperature_2m_max,temperature_2m_min,rain_sum,relative_humidity_2m_max&past_days=3&timezone=auto`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo API Error: ${response.statusText}`);

    const data = await response.json();
    if (!data.daily) throw new Error('No daily weather data returned');

    let inserted = 0;
    for (let i = 0; i < data.daily.time.length; i++) {
        const date = data.daily.time[i];
        const maxTemp = data.daily.temperature_2m_max[i];
        const minTemp = data.daily.temperature_2m_min[i];
        const rain = data.daily.rain_sum[i];
        const humidity = data.daily.relative_humidity_2m_max[i] || null; // Could be missing in some regions

        const rawJson = JSON.stringify({
            time: date,
            temperature_2m_max: maxTemp,
            temperature_2m_min: minTemp,
            rain_sum: rain,
            relative_humidity_2m_max: humidity,
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
        const values = [date, region.name, maxTemp, minTemp, rain, humidity, rawJson];
        const res = await pool.query(insertQuery, values);
        if (res.rowCount > 0) inserted++;
    }
    return inserted;
}

// Ingest every region in the catalog (Open-Meteo is keyless, so no gating).
// Pass an explicit region list to override the catalog (e.g. profile regions).
export async function ingestWeather(regions = ALL_REGIONS) {
    console.log(`[INGESTION] Starting Open-Meteo weather fetch for ${regions.length} regions...`);

    let totalInserted = 0;
    for (const region of regions) {
        if (region?.lat == null || region?.lon == null) {
            console.warn(`[INGESTION] Skipping ${region?.name || 'unknown'} — missing lat/lon`);
            continue;
        }
        try {
            const n = await ingestRegion(region);
            totalInserted += n;
            console.log(`[INGESTION]   ${region.name}: ${n} day-records`);
        } catch (error) {
            // One region failing must not abort the rest.
            console.error(`[INGESTION]   ${region.name} failed:`, error.message);
        }
        // Be polite to the free API.
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`[INGESTION] Weather fetch complete. Inserted/Updated ${totalInserted} records across ${regions.length} regions.`);
    return totalInserted;
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
    ingestWeather().then(() => pool.end());
}
