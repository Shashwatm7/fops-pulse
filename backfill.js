import { pool } from './db.js';
import { ALL_REGIONS } from './onboarding-templates.js';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

async function backfill() {
    const apiKey = process.env.WEATHER_API_KEY;
    if (!apiKey) throw new Error('Missing WeatherAPI key in .env');

    console.log(`Starting backfill for ${ALL_REGIONS.length} regions...`);

    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 30);
    
    const dtStr = startDate.toISOString().split('T')[0];
    const endDtStr = endDate.toISOString().split('T')[0];

    for (const r of ALL_REGIONS) {
        console.log(`Fetching 30d history for ${r.name}...`);
        try {
            const histRes = await axios.get('http://api.weatherapi.com/v1/history.json', {
                params: { key: apiKey, q: `${r.lat},${r.lon}`, dt: dtStr, end_dt: endDtStr }
            });
            const days = histRes.data?.forecast?.forecastday || [];

            console.log(` - Got ${days.length} days of data. Inserting...`);
            
            for (const d of days) {
                const tempC = d.day.maxtemp_c;
                const precipMm = d.day.totalprecip_mm;
                const humidity = d.day.avghumidity;
                const windKph = d.day.maxwind_kph;
                const condition = d.day.condition?.text || 'Historical';
                await pool.query(
                    `INSERT INTO weather_snapshots (region_name, lat, lon, temp_c, precip_mm, humidity, wind_kph, condition, recorded_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [r.name, r.lat, r.lon, tempC, precipMm, humidity, windKph, condition, `${d.date} 12:00:00`]
                );
            }
        } catch (err) {
            console.error(`Failed to fetch/insert for ${r.name}:`, err.response?.data?.error?.message || err.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('Backfill complete!');
    process.exit(0);
}

backfill();
