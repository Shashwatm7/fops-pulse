import Parser from 'rss-parser';
import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const parser = new Parser();

// Only target MVP categories for Phase 2
const QUERIES = [
    "global dairy supply chain",
    "milk production weather",
    "poultry feed cost",
    "avian flu poultry",
    "uae food logistics"
];

export async function ingestGoogleNews() {
    console.log('[INGESTION] Starting Google News RSS fetch...');
    let totalInserted = 0;

    for (const query of QUERIES) {
        try {
            const encodedQuery = encodeURIComponent(query);
            const feedUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;
            
            const feed = await parser.parseURL(feedUrl);
            
            for (const item of feed.items) {
                // Generate a stable ID based on the URL
                const articleId = crypto.createHash('md5').update(item.link || item.title).digest('hex');
                
                const publishedAt = new Date(item.pubDate || new Date());
                
                const rawJson = JSON.stringify(item);
                
                const insertQuery = `
                    INSERT INTO raw_news_articles (article_id, source, title, description, content, published_at, raw_json)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (article_id) DO NOTHING
                `;
                
                const values = [
                    articleId,
                    'Google News',
                    item.title || 'Untitled',
                    item.contentSnippet || item.content || '',
                    item.content || '',
                    publishedAt,
                    rawJson
                ];
                
                const res = await pool.query(insertQuery, values);
                if (res.rowCount > 0) totalInserted++;
            }
        } catch (error) {
            console.error(`[INGESTION] Error fetching news for query "${query}":`, error.message);
        }
    }
    
    console.log(`[INGESTION] News fetch complete. Inserted ${totalInserted} new articles.`);
    return totalInserted;
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
    ingestGoogleNews().then(() => pool.end());
}
