import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const key = process.env.GEMINI_API_KEY;

async function testModel(modelName) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${key}`;
        const { data } = await axios.post(url, {
            model: `models/${modelName}`,
            content: { parts: [{ text: "Hello world" }] }
        });
        console.log(`✅ ${modelName} succeeded! Dimensions: ${data.embedding.values.length}`);
    } catch (err) {
        console.log(`❌ ${modelName} failed:`, err.response?.data?.error?.message || err.message);
    }
}

async function run() {
    await testModel('text-embedding-004');
    await testModel('embedding-001');
}

run();
