import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const GROQ_KEY = process.env.GROQ_API_KEY;

async function testGroq(model) {
    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model,
                messages: [{ role: 'user', content: 'Say hello in JSON { "greeting": "hello" }' }],
                response_format: { type: 'json_object' }
            },
            { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } }
        );
        console.log(`✅ ${model} works!`);
    } catch (e) {
        console.log(`❌ ${model} failed: ${e.response?.status || e.message}`);
    }
}

async function run() {
    await testGroq('llama-3.1-8b-instant');
    await testGroq('llama-3.1-70b-versatile');
    await testGroq('mixtral-8x7b-32768');
    await testGroq('gemma2-9b-it');
}
run();
