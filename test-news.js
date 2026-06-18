import axios from 'axios';
import { pool } from './db.js';

async function testNews() {
    // 1. Get a valid user ID
    const { rows } = await pool.query('SELECT id FROM users LIMIT 1');
    if (rows.length === 0) return console.log("No users found");
    const userId = rows[0].id;
    console.log("Using User ID:", userId);

    // 2. Insert a fake session directly into the DB so we can pass auth
    const sessionCookie = 's%3Afake-session-123.fake-signature';
    const sid = 'fake-session-123';
    
    await pool.query(
        `INSERT INTO session (sid, sess, expire) VALUES ($1, $2, NOW() + INTERVAL '1 hour')
         ON CONFLICT (sid) DO UPDATE SET sess = $2, expire = NOW() + INTERVAL '1 hour'`,
        [sid, JSON.stringify({ cookie: {}, userId })]
    );
    console.log("Fake session injected.");

    // 3. Make request
    try {
        console.log("Hitting /api/news to trigger embeddings...");
        const res = await axios.get('http://localhost:3001/api/news', {
            headers: { Cookie: `connect.sid=${encodeURIComponent(sessionCookie)}` }
        });
        console.log(`Success! Fetched ${res.data.articles.length} articles.`);
        
        // Give the async embedding block 10 seconds to finish
        console.log("Waiting 10s for async embeddings to finish saving...");
        await new Promise(r => setTimeout(r, 10000));
        
        const countRes = await pool.query('SELECT COUNT(*) FROM news_embeddings;');
        console.log(`Embeddings in DB: ${countRes.rows[0].count}`);
    } catch (err) {
        console.error("News API Failed:", err.response?.data || err.message);
    }
    
    await pool.end();
}
testNews();
