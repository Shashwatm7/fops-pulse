import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

async function testBatch() {
    const texts = ["Apple pie recipe", "Strait of Hormuz blocked by military", "New restaurant opening in Dubai"];
    try {
        const { data } = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`, {
            requests: texts.map(text => ({
                model: 'models/gemini-embedding-2',
                content: { parts: [{ text }] },
                outputDimensionality: 768
            }))
        }, { headers: { 'Content-Type': 'application/json' } });
        console.log("Success! Got embeddings:", data.embeddings?.length);
    } catch (err) {
        console.error("Failed:", err.response?.data || err.message);
    }
}
testBatch();
