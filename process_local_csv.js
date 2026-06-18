import fs from 'fs';
import { parse } from 'csv-parse/sync';
import axios from 'axios';
import dotenv from 'dotenv';
import { execSync } from 'child_process';

dotenv.config();

const GROQ_KEY = process.env.GROQ_API_KEY;
const NEWS_KEY = process.env.NEWSDATA_API_KEY;

async function callGroq(model, systemPrompt, userContent, maxTokens = 2500) {
    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            model,
            max_tokens: maxTokens,
            temperature: 0.3,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
        },
        {
            headers: {
                'Authorization': `Bearer ${GROQ_KEY}`,
                'Content-Type': 'application/json',
            }
        }
    );
    return response.data.choices[0].message.content;
}

async function processCSV() {
    const filename = 'V3_final_supply_chain_dataset 1 1.csv';
    console.log(`[CSV Engine] Processing local file: ${filename}...`);

    if (!fs.existsSync(filename)) {
        console.error(`[CSV Engine] File not found: ${filename}`);
        return;
    }

    try {
        console.log(`[CSV Engine] 🐍 Running Python Forecasting Model (Random Forest / Holt-Winters)...`);
        execSync('python3 forecast_model.py', { stdio: 'inherit' });
        
        let forecastDataStr = "";
        if (fs.existsSync('outputs/forecast_recommendations.csv')) {
            const forecastCsv = fs.readFileSync('outputs/forecast_recommendations.csv', 'utf8');
            const parsedForecast = parse(forecastCsv, { columns: true, skip_empty_lines: true });
            forecastDataStr = JSON.stringify(parsedForecast);
            console.log(`[CSV Engine] 📊 Loaded ${parsedForecast.length} forecast metrics from ML models.`);
        } else {
            console.log(`[CSV Engine] ⚠️ Python outputs not found. Proceeding with raw CSV.`);
        }

        const csvContent = fs.readFileSync(filename, 'utf-8');
        const records = parse(csvContent, { columns: true, skip_empty_lines: true });
        
        console.log(`[CSV Engine] Parsed ${records.length} raw records. Sending top 10 to LLM for target extraction...`);
        const sampleData = JSON.stringify(records.slice(0, 10));

        const extractionPrompt = `You are a Supply Chain Intelligence expert. 
Extract exactly 3 concise tracking keywords (e.g. "Semiconductors", "Wheat", "Maersk", "Taiwan") from the following raw CSV data. 
Focus on specific commodities, regions, or major suppliers that are most critical. 
Return ONLY a JSON object with the key "keywords" mapped to an array of strings.`;

        const extractionRaw = await callGroq('llama-3.1-8b-instant', extractionPrompt, `Data:\n${sampleData}`, 500);
        
        const keywordsParsed = JSON.parse(extractionRaw);
        const keywords = keywordsParsed.keywords || [];

        if (keywords.length === 0) throw new Error('No keywords extracted from CSV');
        console.log(`[CSV Engine] 🎯 Extracted Targets:`, keywords);

        console.log(`[CSV Engine] 🌍 Scraping global live news for targets...`);
        const qParam = encodeURIComponent(keywords.join(' OR '));
        const newsRes = await axios.get(`https://newsdata.io/api/1/news?apikey=${NEWS_KEY}&q=${qParam}&language=en&category=business,politics`);
        const newsData = newsRes.data.results || [];
        const topNews = newsData.slice(0, 5).map(n => n.title).join(' | ');

        console.log(`[CSV Engine] 🧠 Generating Highly Detailed AI Planner Recommendations using ML Forecasts & Scraped News...`);
        const analysisPrompt = `You are FOPs Market Pulse — an elite AI Supply Chain Planner.
Your goal is to generate exceptionally detailed, highly prescriptive 7D, 30D, and 90D recommendations.

You have access to TWO distinct data sources:
1. QUANTITATIVE ML FORECASTS: ${forecastDataStr} (This contains Safety Stock, Reorder Points, and Demand Forecasts across horizons).
2. QUALITATIVE LIVE SCRAPED NEWS: ${topNews || 'No recent news found for these keywords.'}
(Extracted Commodities/Keywords: ${keywords.join(', ')})

Instructions:
You MUST blend the quantitative ML data with the qualitative news events. 
For example, if the 30D forecast says RecOrderQty is 450, but the news indicates an avian flu or port strike, your 30D action should explicitly state to increase the order quantity above 450 to buffer the specific risk mentioned in the news.

Generate:
1. "alerts": An array of exactly 2 critical geopolitical or supply chain alerts based on the news AND the forecast data. Each alert must have a "title" and a "description".
2. "recommendations": An array of exactly 3 strategic planner recommendations representing "7D", "30D", and "90D" timeframes. Each must have "timeframe", "action" (detailed step-by-step), and "businessImpact" (quantified reasoning).

Return ONLY a JSON object with "alerts" and "recommendations" arrays.`;

        const analysisRaw = await callGroq('llama-3.1-8b-instant', analysisPrompt, "Analyze and return JSON.", 2500);
        const analysis = JSON.parse(analysisRaw);

        const recs = (analysis.recommendations || []).map(r => {
            const normalized = {};
            for (const key in r) {
                const lowerKey = key.toLowerCase();
                if (lowerKey.includes('time')) normalized.timeframe = r[key];
                else if (lowerKey.includes('action')) normalized.action = r[key];
                else if (lowerKey.includes('impact') || lowerKey.includes('business')) normalized.businessImpact = r[key];
            }
            return normalized;
        });

        const outputData = {
            success: true,
            extractedKeywords: keywords,
            alerts: analysis.alerts || [],
            recommendations: recs
        };

        fs.writeFileSync('custom_csv_intelligence.json', JSON.stringify(outputData, null, 2));
        console.log(`[CSV Engine] ✅ Intelligence generated and saved to custom_csv_intelligence.json!`);

    } catch (err) {
        console.error('[CSV Engine] Failed:', err.response?.data || err.message);
    }
}

processCSV();
