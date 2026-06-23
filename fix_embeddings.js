import { pool } from './db.js';

async function fix() {
    try {
        const res = await pool.query(`DELETE FROM news_embeddings WHERE embedding::text LIKE '[0,%'`);
        console.log(`Deleted ${res.rowCount} fake zero embeddings.`);
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
fix();
