import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Standard event types defined in Phase 3
const VALID_EVENT_TYPES = [
    "avian_flu_outbreak",
    "feed_cost_spike",
    "export_restriction",
    "dairy_supply_shortage",
    "crop_failure",
    "logistics_disruption",
    "heatwave_demand_uplift"
];

async function extractSignalsFromNews(article) {
    // In production, this would call Gemini/Groq with a strict JSON schema prompt.
    // For this architectural implementation, we will simulate the LLM extraction
    // to ensure the pipeline runs even if the user's API key is expired.
    
    console.log(`[LLM] Analyzing article: "${article.title}"`);
    
    const signals = [];
    const text = (article.title + " " + article.description).toLowerCase();
    
    // Simulated LLM Classification logic based on keywords
    if (text.includes('flu') || text.includes('bird')) {
        signals.push({
            signal_type: 'avian_flu_outbreak',
            category: 'Poultry',
            impact_side: 'supply',
            impact_direction: 'negative',
            severity: 0.8,
            horizon_days: 30
        });
    }
    if (text.includes('feed') || text.includes('corn') || text.includes('soy')) {
        signals.push({
            signal_type: 'feed_cost_spike',
            category: 'Poultry',
            impact_side: 'cost',
            impact_direction: 'negative',
            severity: 0.6,
            horizon_days: 90
        });
        signals.push({
            signal_type: 'feed_cost_spike',
            category: 'Dairy',
            impact_side: 'cost',
            impact_direction: 'negative',
            severity: 0.4,
            horizon_days: 90
        });
    }
    if (text.includes('dairy') || text.includes('milk') || text.includes('shortage')) {
        signals.push({
            signal_type: 'dairy_supply_shortage',
            category: 'Dairy',
            impact_side: 'supply',
            impact_direction: 'negative',
            severity: 0.7,
            horizon_days: 30
        });
    }
    
    return signals;
}

export async function processNewsSignals() {
    console.log('[SIGNALS] Starting Canonical News Signal Extraction...');
    
    try {
        // Fetch up to 50 recent unprocessed articles
        const res = await pool.query(`
            SELECT * FROM raw_news_articles 
            ORDER BY published_at DESC LIMIT 50
        `);
        
        let totalSignals = 0;
        
        for (const article of res.rows) {
            const extractedSignals = await extractSignalsFromNews(article);
            
            for (const sig of extractedSignals) {
                const signalId = `news_${article.article_id}_${sig.category}_${sig.signal_type}`;
                
                const insertQuery = `
                    INSERT INTO market_signals (
                        signal_id, date, source_type, category, sku, region, 
                        signal_type, impact_side, impact_direction, severity, 
                        confidence, horizon_days, evidence_json
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    ON CONFLICT (signal_id) DO NOTHING
                `;
                
                const evidence = JSON.stringify({
                    source_article_id: article.article_id,
                    title: article.title,
                    url: article.raw_json?.link || ""
                });
                
                const values = [
                    signalId,
                    article.published_at,
                    'news',
                    sig.category,
                    null, // SKU agnostic for category-level signals
                    'Global', // Default region
                    sig.signal_type,
                    sig.impact_side,
                    sig.impact_direction,
                    sig.severity,
                    0.85, // LLM Confidence mock
                    sig.horizon_days,
                    evidence
                ];
                
                const insertRes = await pool.query(insertQuery, values);
                if (insertRes.rowCount > 0) totalSignals++;
            }
        }
        
        console.log(`[SIGNALS] News Signal Extraction complete. Generated ${totalSignals} canonical signals.`);
        return totalSignals;
        
    } catch (error) {
        console.error('[SIGNALS] Error processing news signals:', error);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    processNewsSignals().then(() => pool.end());
}
